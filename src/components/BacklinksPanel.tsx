import { Link } from "lucide-react";
import type { BacklinkInfo } from "@/lib/tauri";

interface BacklinksPanelProps {
  backlinks: BacklinkInfo[];
  onJump: (path: string, line: number) => void;
  onClose: () => void;
}

export function BacklinksPanel({ backlinks, onJump, onClose }: BacklinksPanelProps) {
  return (
    <div className="flex h-full w-52 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
          <Link size={13} />
          反向链接
        </span>
        <button
          className="rounded p-0.5 text-xs text-secondary hover:text-foreground"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {backlinks.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-secondary/60">
            暂无反向链接
          </p>
        ) : (
          backlinks.map((b) => (
            <button
              key={`${b.path}-${b.line}`}
              className="flex w-full flex-col px-3 py-2 text-left hover:bg-hover border-b border-border/50 last:border-b-0"
              onClick={() => onJump(b.path, b.line)}
            >
              <span className="block truncate text-xs font-medium">
                {b.name}
              </span>
              <span className="block truncate text-[11px] text-secondary/70 mt-0.5">
                L{b.line}: {b.context}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
