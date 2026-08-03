import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileSearch, FileText, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import type { TreeNode } from "@/lib/tauri";

export interface PaletteItem {
  name: string;
  path: string;
  relDir: string;
  /** 内容匹配时的行号 */
  matchLine?: number;
  /** 内容匹配时的上下文 */
  matchContext?: string;
  /** 内容匹配 */
  kind?: "file" | "content";
  /** 统一排序分：文件名 200/180/140/100，内容 ≤90 */
  score: number;
}

interface CommandPaletteProps {
  open: boolean;
  notes: TreeNode[];
  notesDir: string;
  recentPaths: string[];
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}

function collectPaletteItems(nodes: TreeNode[], notesDir: string): PaletteItem[] {
  const out: PaletteItem[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.isDir) {
        walk(n.children);
      } else {
        const rel = n.path.startsWith(notesDir + "/")
          ? n.path.slice(notesDir.length + 1)
          : n.path;
        const i = rel.lastIndexOf("/");
        out.push({
          name: n.name,
          path: n.path,
          relDir: i > 0 ? rel.slice(0, i) : "",
          kind: "file",
          score: 0,
        });
      }
    }
  };
  walk(nodes);
  return out;
}

function fuzzyMatch(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.toLowerCase();
  return items
    .map((item) => {
      const name = item.name.toLowerCase();
      const path = item.path.toLowerCase();
      let score = 0;
      if (name === q) score = 200;
      else if (name.startsWith(q)) score = 180;
      else if (name.includes(q)) score = 140;
      else if (path.includes(q)) score = 100;
      return { ...item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

/** 内容命中分：匹配次数越多、行越靠前越高；上限 90 < 文件名最低分 100 */
function contentScore(matchCount: number, line: number): number {
  return Math.max(0, Math.min(90, 10 * matchCount - Math.floor(line / 10)));
}

/** 在 context 行内按 query 高亮命中片段，返回 React 节点数组（避免 dangerouslySetInnerHTML） */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.toLowerCase();
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    const idx = rest.toLowerCase().indexOf(q);
    if (idx < 0) {
      nodes.push(rest);
      break;
    }
    if (idx > 0) nodes.push(rest.slice(0, idx));
    nodes.push(
      <mark key={key++} className="search-hit">
        {rest.slice(idx, idx + q.length)}
      </mark>,
    );
    rest = rest.slice(idx + q.length);
  }
  return nodes;
}

export function CommandPalette({
  open,
  notes,
  notesDir,
  recentPaths,
  onOpenFile,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const [contentResults, setContentResults] = useState<PaletteItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchIdRef = useRef(0);

  const allItems = useMemo(
    () => collectPaletteItems(notes, notesDir),
    [notes, notesDir],
  );

  // 文件名校验
  const nameResults = useMemo(() => {
    if (!query.trim()) return [] as PaletteItem[];
    return fuzzyMatch(allItems, query);
  }, [query, allItems]);

  // 内容搜索（200ms 防抖）
  useEffect(() => {
    if (!query.trim()) {
      setContentResults([]);
      setSearching(false);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    const t = setTimeout(() => {
      // 防御：searchContent 在个别环境（如 mock 被重置）下可能返回 undefined，
      // 直接 .then 会产生未处理异常；生产环境 invoke 恒返回 Promise，此分支不触发
      const p = api.searchContent(notesDir, query.trim());
      if (!p || typeof p.then !== "function") {
        if (id === searchIdRef.current) setSearching(false);
        return;
      }
      p.then((matches) => {
        if (id !== searchIdRef.current) return;
        // 排除已经通过文件名搜索匹配到的
        const namePaths = new Set(nameResults.map((n) => n.path));
        const items: PaletteItem[] = [];
        for (const m of matches) {
          if (namePaths.has(m.path)) continue;
          items.push({
            name: m.name + ".md",
            path: m.path,
            relDir: "",
            matchLine: m.line,
            matchContext: m.context,
            kind: "content",
            score: contentScore(m.matchCount, m.line),
          });
        }
        setContentResults(items.slice(0, 10));
        setSearching(false);
      }).catch(() => {
        if (id === searchIdRef.current) setSearching(false);
      });
    }, 200);
    return () => { clearTimeout(t); };
  }, [query, notesDir, nameResults]);

  const results = useMemo(() => {
    if (!query.trim()) {
      return recentPaths
        .map((p) => allItems.find((item) => item.path === p))
        .filter(Boolean) as PaletteItem[];
    }
    return [...nameResults, ...contentResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [query, allItems, recentPaths, nameResults, contentResults]);

  // 重置状态
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setContentResults([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // 键盘导航
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const r = results[activeIdx];
        if (r) {
          onOpenFile(r.path, r.matchLine);
          onClose();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, activeIdx, onOpenFile, onClose]);

  // 滚动活动项
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  const showResults = results.length > 0 || !query.trim();

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center pt-[15vh]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[520px] max-h-[60vh] overflow-hidden rounded-2xl border border-border bg-editor shadow-lg-soft flex flex-col animate-dialog-in glass-surface"
        style={{ backdropFilter: "blur(24px) saturate(1.3)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索栏 */}
        <div className="flex items-center gap-2 border-b border-border/60 px-5">
          <Search size={15} className="shrink-0 text-secondary" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent py-3 text-sm text-foreground placeholder:text-secondary focus:outline-none"
            placeholder="搜索文件名或正文内容…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
          />
          {searching && <Loader2 size={14} className="shrink-0 animate-spin text-secondary" />}
          <span className="text-[10px] text-secondary/60">esc 关闭</span>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="overflow-y-auto">
          {!showResults && (
            <p className="px-4 py-8 text-center text-xs text-secondary">无匹配结果</p>
          )}
          {results.map((item, i) => (
            <button
              key={item.path + (item.matchLine ?? "") + item.kind}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                i === activeIdx ? "bg-accent-soft" : "hover:bg-hover",
              )}
              onClick={() => { onOpenFile(item.path, item.matchLine); onClose(); }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              {item.kind === "content" ? (
                <FileSearch size={15} className="shrink-0 text-accent" />
              ) : (
                <FileText size={15} className="shrink-0 text-secondary" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {item.name}
                  {item.matchLine != null && (
                    <span className="ml-1.5 text-[10px] text-accent/70">L{item.matchLine}</span>
                  )}
                </span>
                {item.matchContext ? (
                  <span className="block truncate text-xs text-secondary">
                    {highlight(item.matchContext, query)}
                  </span>
                ) : item.relDir ? (
                  <span className="block truncate text-xs text-secondary">{item.relDir}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
