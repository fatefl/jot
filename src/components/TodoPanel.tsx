import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, RefreshCw } from "lucide-react";
import { api, type SearchMatch } from "@/lib/tauri";
import { useEditorStore, enqueueWriteFile } from "@/stores/editorStore";

interface TodoPanelProps {
  notesDir: string | null;
  currentFilePath: string | null;
  onJump: (path: string, line: number) => void;
  onClose: () => void;
}

interface TodoItem {
  path: string;
  name: string;
  line: number;
  text: string;
  checked: boolean;
}

/** 解析 - [ ] 或 - [x] 开头的行 */
export function parseTodoLine(line: string): { checked: boolean; text: string } | null {
  const m = line.match(/^\s*- \[( |x)\]\s+(.*)/i);
  if (!m) return null;
  return {
    checked: m[1].toLowerCase() === "x",
    text: m[2].trim(),
  };
}

/**
 * 翻转指定行的勾选状态。优先按精确行号翻转，行号因编辑漂移时按文本回退搜索。
 * 返回 null 表示未找到可翻转的待办行。
 */
export function flipTodoLine(content: string, line: number, text: string): string | null {
  const lines = content.split("\n");
  const candidates: number[] = [];
  const idx = line - 1;
  if (idx >= 0 && idx < lines.length) candidates.push(idx);
  for (let i = 0; i < lines.length; i++) {
    const p = parseTodoLine(lines[i]);
    if (p && p.text === text && !candidates.includes(i)) candidates.push(i);
  }
  const target = candidates.find((i) => parseTodoLine(lines[i]));
  if (target == null) return null;
  const p = parseTodoLine(lines[target]);
  if (!p) return null;
  lines[target] = lines[target].replace(/\[( |x)\]/i, p.checked ? "[ ]" : "[x]");
  return lines.join("\n");
}

export function TodoPanel({
  notesDir,
  currentFilePath,
  onJump,
  onClose,
}: TodoPanelProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const loadTodos = useCallback(async () => {
    if (!notesDir) return;
    setLoading(true);
    try {
      // search_content 是纯子串匹配（非正则），传 "- [" 即可命中所有 - [ ] / - [x] 行
      const matches = await api.searchContent(notesDir, "- [");
      const items: TodoItem[] = [];
      for (const m of matches) {
        const parsed = parseTodoLine(m.context);
        if (parsed) {
          items.push({
            path: m.path,
            name: m.name,
            line: m.line,
            text: parsed.text,
            checked: parsed.checked,
          });
        }
      }
      setTodos(items);
    } catch {
      // 搜索失败保持现有列表
    } finally {
      setLoading(false);
    }
  }, [notesDir]);

  useEffect(() => {
    loadTodos();
  }, [loadTodos]);

  // 编辑器完成一次保存（dirty true→false）后自动刷新，
  // 让在编辑器里勾选/取消的结果尽快同步到面板
  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      if (prev.dirty && !state.dirty) loadTodos();
    });
  }, [loadTodos]);

  const handleToggle = useCallback(
    async (item: TodoItem) => {
      const setLocal = (checked: boolean) =>
        setTodos((ts) =>
          ts.map((t) =>
            t.path === item.path && t.line === item.line ? { ...t, checked } : t,
          ),
        );
      const { selectedPath, doc } = useEditorStore.getState();
      if (selectedPath === item.path) {
        // 活动文件：翻转内存 doc，交给自动保存落盘（避免直接写盘覆盖未保存的编辑）
        const newDoc = flipTodoLine(doc, item.line, item.text);
        if (newDoc != null && newDoc !== doc) {
          setLocal(!item.checked);
          useEditorStore.setState({ doc: newDoc, dirty: true });
          // 磁盘由自动保存更新，面板在保存完成后经 subscribe 自动刷新
        }
      } else {
        // 非活动文件：读盘 → 翻转 → 写盘（走串行写队列，与自动保存乱序隔离）
        setLocal(!item.checked);
        try {
          const content = await api.readFile(item.path);
          const newContent = flipTodoLine(content, item.line, item.text);
          if (newContent != null && newContent !== content) {
            await enqueueWriteFile(item.path, newContent);
          }
        } catch {
          // 读/写失败回滚乐观更新，避免面板显示与实际不一致
          setLocal(item.checked);
        }
        loadTodos();
      }
    },
    [loadTodos],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, TodoItem[]>();
    for (const t of todos) {
      if (!showDone && t.checked) continue;
      const arr = map.get(t.path) || [];
      arr.push(t);
      map.set(t.path, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [todos, showDone]);

  const pendingCount = useMemo(
    () => todos.filter((t) => !t.checked).length,
    [todos],
  );
  const doneCount = useMemo(
    () => todos.filter((t) => t.checked).length,
    [todos],
  );

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
          <CheckSquare size={13} />
          待办
          {pendingCount > 0 && (
            <span className="ml-0.5 rounded-full bg-accent/12 px-1.5 text-[10px] text-accent">
              {pendingCount}
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
            onClick={loadTodos}
            title="刷新"
            disabled={loading}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
        <label className="flex items-center gap-1 text-[11px] text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
            className="accent-accent"
          />
          显示已完成 ({doneCount})
        </label>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && grouped.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-secondary/60">
            搜索中…
          </p>
        ) : grouped.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-secondary/60">
            暂无待办事项
          </p>
        ) : (
          grouped.map(([path, items]) => (
            <div key={path} className="border-b border-border/30 last:border-b-0">
              <div
                className={`px-3 py-1 text-[11px] font-medium truncate cursor-pointer hover:bg-hover ${
                  path === currentFilePath ? "text-accent" : "text-secondary"
                }`}
                title={path}
              >
                {items[0]?.name ?? path.split("/").pop()}
              </div>
              {items.map((item, i) => (
                <div
                  key={`${item.line}-${i}`}
                  className="flex w-full cursor-pointer items-start gap-2 px-4 py-1 text-left text-xs hover:bg-hover"
                  onClick={() => onJump(item.path, item.line)}
                >
                  <button
                    className={`mt-0.5 shrink-0 rounded border ${
                      item.checked
                        ? "border-accent/40 bg-accent/10"
                        : "border-border"
                    } flex h-3.5 w-3.5 items-center justify-center text-[9px] hover:border-accent`}
                    title={item.checked ? "标记为未完成" : "标记为完成"}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggle(item);
                    }}
                  >
                    {item.checked ? "✓" : ""}
                  </button>
                  <span
                    className={`truncate leading-relaxed ${
                      item.checked
                        ? "text-secondary/50 line-through"
                        : "text-foreground/80"
                    }`}
                  >
                    {item.text || "（空）"}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
