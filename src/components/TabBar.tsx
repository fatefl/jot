import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn, stripMdExtension } from "@/lib/utils";

export interface TabInfo {
  path: string;
  name: string;
  dirty: boolean;
  /** 外部文件（notesDir 之外）：手动保存、不参与 git 同步 */
  external?: boolean;
  /** 只读模式：禁止编辑，适用于许可证 / 隐私政策等打包资源文件 */
  readOnly?: boolean;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeIdx: number;
  onSelect: (idx: number) => void;
  onClose: (idx: number) => void;
  onCloseOthers?: (idx: number) => void;
  onCloseRight?: (idx: number) => void;
}

interface TabMenu {
  idx: number;
  x: number;
  y: number;
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, onCloseOthers, onCloseRight }: TabBarProps) {
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 鼠标滚轮横向滚动标签栏（Shift 非必需，垂直滚轮直接转水平） */
  const handleWheel = (e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    // 如果已经可以自然横向滚动（触控板），不做转换避免冲突
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };

  /** 切换标签时自动滚动到可见区域 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const btn = el.querySelector(
      `[data-tab-index="${activeIdx}"]`,
    ) as HTMLElement | undefined;
    if (!btn) return;
    btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeIdx]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      // mousedown 先于 onClick 触发，点击菜单项时不能先关掉菜单，
      // 否则按钮从 DOM 消失，onClick 永远不触发
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(e); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      className="flex items-end gap-0.5 overflow-x-auto scrollbar-none h-full select-none"
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.path}
          data-tab-index={i}
          className={cn(
            "group flex h-8 max-w-[160px] shrink-0 items-center gap-1 rounded-t-lg border border-b-0 px-2.5 text-[13px] transition-colors",
            i === activeIdx
              ? "border-border bg-editor text-foreground"
              : "border-transparent text-secondary hover:bg-hover hover:text-foreground",
          )}
          onClick={() => onSelect(i)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(i);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ idx: i, x: e.clientX, y: e.clientY });
          }}
          title={tab.name}
        >
          <span className="truncate">
            {stripMdExtension(tab.name)}
          </span>
          {tab.external && (
            <span
              className="shrink-0 rounded bg-hover px-1 text-[10px] leading-tight text-secondary"
              title={`外部文件（手动保存）：${tab.path}`}
            >
              外部
            </span>
          )}
          {tab.dirty && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          )}
          <button
            className={cn(
              "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-hover",
              i === activeIdx ? "group-hover:opacity-100" : "group-hover:opacity-70",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onClose(i);
            }}
          >
            <X size={11} />
          </button>
        </button>
      ))}

      {/* 标签右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[120px] rounded-xl border border-border bg-editor py-1 shadow-md-soft text-[14px] animate-menu-in"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="flex w-full items-center px-4 py-2 hover:bg-hover text-left"
            onClick={() => { onClose(menu.idx); setMenu(null); }}
          >
            关闭
          </button>
          <button
            className="flex w-full items-center px-4 py-2 hover:bg-hover text-left"
            onClick={() => { onCloseOthers?.(menu.idx); setMenu(null); }}
          >
            关闭其他
          </button>
          <button
            className="flex w-full items-center px-4 py-2 hover:bg-hover text-left"
            onClick={() => { onCloseRight?.(menu.idx); setMenu(null); }}
          >
            关闭右侧
          </button>
        </div>
      )}
    </div>
  );
}
