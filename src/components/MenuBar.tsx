import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MenuAction {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  /** 子菜单项：有 children 时 onClick 仅用于展开子菜单（不单独触发） */
  children?: (MenuAction | "separator")[];
}

export interface MenuGroup {
  label: string;
  items: (MenuAction | "separator")[];
}

interface MenuBarProps {
  groups: MenuGroup[];
  className?: string;
}

/** 单个下拉面板组件，支持内含子菜单（hover 展开） */
function Dropdown({ group, onClose }: { group: MenuGroup; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-[95] mt-0.5 min-w-[200px] rounded-xl border border-border bg-editor py-1 shadow-md-soft animate-menu-in glass-surface"
    >
      {group.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 h-px bg-border/40" />
        ) : (
          <MenuItem key={i} item={item} onClose={onClose} />
        ),
      )}
    </div>
  );
}

/** 单个菜单项，若有 children 则在 hover 时展开子菜单 */
function MenuItem({
  item,
  onClose,
}: {
  item: MenuAction;
  onClose: () => void;
}) {
  const [subOpen, setSubOpen] = useState(false);
  const itemRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasChildren = item.children && item.children.length > 0;

  const openSub = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSubOpen(true);
  };
  const closeSubDelayed = () => {
    timerRef.current = setTimeout(() => setSubOpen(false), 150);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <button
        ref={itemRef}
        disabled={item.disabled}
        className={cn(
          "flex w-full items-center gap-6 px-4 py-1.5 text-left text-[13px] hover:bg-hover hover-transition",
          item.danger ? "text-red-500" : "text-foreground",
          item.disabled && "opacity-40",
        )}
        onClick={() => {
          if (item.disabled) return;
          if (!hasChildren) {
            onClose();
            item.onClick();
          } else {
            setSubOpen((v) => !v);
          }
        }}
        onMouseEnter={() => {
          if (!item.disabled && hasChildren) openSub();
        }}
        onMouseLeave={closeSubDelayed}
      >
        <span className="flex-1">{item.label}</span>
        {item.shortcut && (
          <span className="text-xs text-secondary/70">{item.shortcut}</span>
        )}
        {hasChildren && (
          <ChevronRight size={12} className="text-secondary/50" />
        )}
      </button>
      {/* 子菜单：定位相对于外层 relative 容器，确保贴齐按钮右侧 */}
      {hasChildren && subOpen && (
        <div
          className="absolute left-full top-0 z-[96] ml-0.5 min-w-[180px] rounded-xl border border-border bg-editor py-1 shadow-md-soft animate-menu-in glass-surface"
          onMouseEnter={openSub}
          onMouseLeave={closeSubDelayed}
        >
          {item.children!.map((child, j) =>
            child === "separator" ? (
              <div key={j} className="my-1 h-px bg-border/40" />
            ) : (
              <button
                key={j}
                disabled={child.disabled}
                className={cn(
                  "flex w-full items-center gap-6 px-4 py-1.5 text-left text-[13px] hover:bg-hover hover-transition",
                  child.danger ? "text-red-500" : "text-foreground",
                  child.disabled && "opacity-40",
                )}
                onClick={() => {
                  if (!child.disabled) {
                    onClose();
                    child.onClick();
                  }
                }}
              >
                <span className="flex-1">{child.label}</span>
                {child.shortcut && (
                  <span className="text-xs text-secondary/70">{child.shortcut}</span>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function MenuBar({ groups, className }: MenuBarProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 取消延迟关闭：鼠标重新进入菜单栏（含下拉面板，它是 DOM 子节点）时调用
  const cancelCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useEffect(() => cancelCloseTimer, []);

  // keyboard: left/right to switch menu
  useEffect(() => {
    if (openIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setOpenIdx((i) => (i! + 1) % groups.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setOpenIdx((i) => (i! - 1 + groups.length) % groups.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIdx, groups.length]);

  return (
    <div
      ref={barRef}
      className={cn("flex items-center gap-0 select-none", className)}
      onMouseEnter={cancelCloseTimer}
      onMouseLeave={() => {
        // slight delay so moving between menu items doesn't flicker
        cancelCloseTimer();
        closeTimerRef.current = setTimeout(() => setOpenIdx(null), 150);
      }}
    >
      {groups.map((group, i) => (
        <button
          key={group.label}
          ref={(el) => { itemRefs.current[i] = el; }}
          className={cn(
            "relative px-3 py-1 text-[13px] rounded-md transition-colors",
            openIdx === i
              ? "bg-accent-soft text-accent"
              : "text-secondary hover:bg-hover hover:text-foreground",
          )}
          onMouseEnter={() => {
            cancelCloseTimer();
            if (openIdx !== null) setOpenIdx(i);
          }}
          onClick={() => {
            cancelCloseTimer();
            setOpenIdx(openIdx === i ? null : i);
          }}
        >
          {group.label}
          {openIdx === i && <Dropdown group={group} onClose={() => setOpenIdx(null)} />}
        </button>
      ))}
    </div>
  );
}
