import { useCallback, useMemo, useState } from "react";
import { FileText, Plus, Trash2 } from "lucide-react";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

interface FrontmatterPanelProps {
  doc: string;
  onChange: (newDoc: string) => void;
  onClose: () => void;
}

interface FmEntry {
  key: string;
  value: string;
}

/** 解析文档开头的 YAML frontmatter */
function parseFrontmatter(doc: string): {
  entries: FmEntry[];
  start: number;
  end: number;
} | null {
  const m = doc.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  try {
    const parsed = yamlLoad(m[1]) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const entries: FmEntry[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        entries.push({ key, value: value.join(", ") });
      } else if (value != null) {
        entries.push({ key, value: String(value) });
      } else {
        entries.push({ key, value: "" });
      }
    }
    return { entries, start: 0, end: m[0].length };
  } catch {
    return null;
  }
}

function buildFrontmatter(entries: FmEntry[]): string {
  if (entries.length === 0) return "";
  const obj: Record<string, unknown> = {};
  for (const e of entries) {
    const trimmed = e.value.trim();
    if (!trimmed) {
      obj[e.key] = null;
    } else if (trimmed.includes(",")) {
      // 逗号分隔的值转为数组
      obj[e.key] = trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (/^(true|false)$/i.test(trimmed)) {
      obj[e.key] = trimmed.toLowerCase() === "true";
    } else if (/^\d+$/.test(trimmed)) {
      obj[e.key] = parseInt(trimmed, 10);
    } else {
      obj[e.key] = trimmed;
    }
  }
  return `---\n${yamlDump(obj, { lineWidth: -1 }).trim()}\n---\n`;
}

export function FrontmatterPanel({
  doc,
  onChange,
  onClose,
}: FrontmatterPanelProps) {
  const fm = useMemo(() => parseFrontmatter(doc), [doc]);
  const [entries, setEntries] = useState<FmEntry[]>(fm?.entries ?? []);
  const [isEditing, setIsEditing] = useState(false);

  // 同步外部文档变化（未在编辑时）
  useMemo(() => {
    if (!isEditing) {
      setEntries(fm?.entries ?? []);
    }
  }, [fm, isEditing]);

  const addEntry = useCallback(() => {
    setEntries((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const removeEntry = useCallback((idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateKey = useCallback((idx: number, key: string) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, key } : e)));
  }, []);

  const updateValue = useCallback((idx: number, value: string) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, value } : e)),
    );
  }, []);

  const applyChanges = useCallback(() => {
    const fmBlock = buildFrontmatter(entries);
    if (fm) {
      const before = doc.slice(0, fm.start);
      const after = doc.slice(fm.end);
      onChange(before + fmBlock + after);
    } else {
      onChange(fmBlock + doc);
    }
    setIsEditing(false);
  }, [doc, entries, fm, onChange]);

  const discardChanges = useCallback(() => {
    setEntries(fm?.entries ?? []);
    setIsEditing(false);
  }, [fm]);

  const dirty = useMemo(() => {
    if (!fm) return entries.length > 0;
    return JSON.stringify(entries) !== JSON.stringify(fm.entries);
  }, [entries, fm]);

  const handleBlur = useCallback(
    (idx: number) => {
      setEntries((prev) => {
        const isDirty = prev.some(
          (e) =>
            e.key !== fm?.entries[prev.indexOf(e)]?.key ||
            e.value !== fm?.entries[prev.indexOf(e)]?.value,
        );
        if (isDirty) setIsEditing(true);
        return prev;
      });
    },
    [fm],
  );

  return (
    <div className="flex h-full w-52 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
          <FileText size={13} />
          元数据
        </span>
        <button
          className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-4">
            <p className="text-xs text-secondary/60">
              无 YAML frontmatter
            </p>
            <button
              className="rounded-md border border-border px-3 py-1 text-[11px] text-secondary hover:bg-hover hover:text-foreground flex items-center gap-1"
              onClick={addEntry}
            >
              <Plus size={11} />
              添加字段
            </button>
          </div>
        ) : (
          <>
            {entries.map((entry, i) => (
              <div
                key={i}
                className="group flex items-center gap-1 border-b border-border/30 px-2 py-1.5"
              >
                <input
                  className="min-w-0 flex-[0.4] rounded bg-transparent px-1 py-0.5 text-[12px] font-medium text-secondary placeholder:text-secondary/40 outline-none focus:bg-hover"
                  placeholder="键"
                  value={entry.key}
                  onChange={(e) => updateKey(i, e.target.value)}
                  onFocus={() => setIsEditing(true)}
                  spellCheck={false}
                />
                <input
                  className="min-w-0 flex-[0.6] rounded bg-transparent px-1 py-0.5 text-[12px] text-foreground placeholder:text-secondary/40 outline-none focus:bg-hover"
                  placeholder="值"
                  value={entry.value}
                  onChange={(e) => updateValue(i, e.target.value)}
                  onFocus={() => setIsEditing(true)}
                  spellCheck={false}
                />
                <button
                  className="shrink-0 rounded p-0.5 text-secondary/40 opacity-0 transition-opacity hover:bg-hover hover:text-red-400 group-hover:opacity-100"
                  onClick={() => removeEntry(i)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            <div className="px-2 py-1.5">
              <button
                className="rounded-md border border-border/50 px-2 py-0.5 text-[10px] text-secondary/60 hover:bg-hover hover:text-secondary flex items-center gap-1"
                onClick={addEntry}
              >
                <Plus size={10} />
                添加字段
              </button>
            </div>
          </>
        )}

        {dirty && (
          <div className="sticky bottom-0 flex gap-1.5 border-t border-border bg-sidebar px-2 py-2">
            <button
              className="flex-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
              onClick={applyChanges}
            >
              应用
            </button>
            <button
              className="flex-1 rounded-md border border-border px-2 py-1 text-[11px] text-secondary hover:bg-hover"
              onClick={discardChanges}
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
