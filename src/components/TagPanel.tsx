import { useMemo } from "react";
import { Tags } from "lucide-react";
import type { TagInfo } from "@/lib/tauri";

interface TagPanelProps {
  tags: TagInfo[];
  onSelectTag: (tag: string) => void;
  onClose: () => void;
  activeTag: string | null;
  onClearTag: () => void;
}

/** 按引用次数降序，同次数按名称升序 */
function sortTags(tags: TagInfo[]): TagInfo[] {
  return [...tags].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tag.localeCompare(b.tag);
  });
}

export function TagPanel({
  tags,
  onSelectTag,
  onClose,
  activeTag,
  onClearTag,
}: TagPanelProps) {
  const sorted = useMemo(() => sortTags(tags), [tags]);

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
          <Tags size={13} />
          标签
        </span>
        <button
          className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {activeTag && (
        <div className="flex items-center gap-1 border-b border-border/50 px-3 py-1.5">
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
            #{activeTag}
          </span>
          <button
            className="ml-auto text-[10px] text-secondary hover:text-foreground"
            onClick={onClearTag}
          >
            清除
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-secondary/60">
            暂无标签
          </p>
        ) : (
          sorted.map((t) => (
            <button
              key={t.tag}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${
                activeTag === t.tag ? "bg-accent/8 text-accent font-medium" : "text-secondary"
              }`}
              onClick={() =>
                activeTag === t.tag ? onClearTag() : onSelectTag(t.tag)
              }
            >
              <span className="truncate flex-1">#{t.tag}</span>
              <span
                className={`ml-2 shrink-0 text-[10px] tabular-nums ${
                  activeTag === t.tag ? "text-accent/70" : "text-secondary/50"
                }`}
              >
                {t.count}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
