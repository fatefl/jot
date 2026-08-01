import { useMemo } from "react";
import { List } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HeadingItem {
  level: number;
  text: string;
  line: number;
}

export interface OutlinePanelProps {
  doc: string;
  /** 当前活动行号（1-based），用于高亮当前位置 */
  activeLine?: number | null;
  onJump: (line: number) => void;
  onClose: () => void;
}

/** 从 Markdown 纯文本中解析标题行 */
function parseHeadings(markdown: string): HeadingItem[] {
  const out: HeadingItem[] = [];
  let lineNum = 0;
  for (const raw of markdown.split("\n")) {
    lineNum++;
    const m = raw.match(/^(#{1,6})\s+(.+)/);
    if (!m) continue;
    const text = m[2].replace(/[#*`~_>\[\]!()\\]+$/, "").trim();
    if (!text) continue;
    out.push({ level: m[1].length, text, line: lineNum });
  }
  return out;
}

/** 计算缩进宽度，H1 无缩进，H2 缩进 1 级，以此类推 */
function indentPx(level: number) {
  return Math.max(0, (level - 1) * 14);
}

export function OutlinePanel({ doc, activeLine, onJump, onClose }: OutlinePanelProps) {
  const headings = useMemo(() => parseHeadings(doc), [doc]);

  if (headings.length === 0) {
    return (
      <div className="flex h-full w-48 shrink-0 flex-col border-l border-border bg-sidebar">
        <div className="flex h-9 items-center justify-between border-b border-border px-3">
          <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
            <List size={13} />
            大纲
          </span>
          <button
            className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-secondary/60">暂无标题</p>
        </div>
      </div>
    );
  }

  // 找到当前活动标题（activeLine 落在哪个标题范围内）
  let activeIdx = -1;
  for (let i = headings.length - 1; i >= 0; i--) {
    if (activeLine != null && headings[i].line <= activeLine) {
      activeIdx = i;
      break;
    }
  }

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
          <List size={13} />
          大纲
        </span>
        <button
          className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {headings.map((h, i) => (
          <button
            key={`${h.line}-${h.text}`}
            className={cn(
              "block w-full truncate text-left text-[12px] leading-6 transition-colors hover:bg-hover",
              i === activeIdx
                ? "text-accent font-medium"
                : "text-secondary",
            )}
            style={{ paddingLeft: 12 + indentPx(h.level), paddingRight: 12 }}
            onClick={() => onJump(h.line)}
            title={h.text}
          >
            {h.text}
          </button>
        ))}
      </div>
    </div>
  );
}
