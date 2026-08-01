import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** 子菜单：hover 时向右弹出 */
  children?: MenuEntry[];
}

export type MenuEntry = MenuItem | "separator";

interface ContextMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

// ---- 视口适配 -------------------------------------------------------
// 右键菜单过长时：优先向上翻转（anchor bottom），仍放不下则加 max-height + 滚动。
// 水平方向同理：右侧溢出则向左靠齐。
// 使用 useLayoutEffect 在浏览器 paint 前同步修正，不会闪烁。

const MARGIN = 4;

interface FitResult {
  left: number;
  /** 锚定顶部（默认） */
  top?: number;
  /** 锚定底部（向上翻转） */
  bottom?: number;
  /** 空间仍不足时限制高度 */
  maxHeight?: number;
  overflowY?: "auto";
}

function fitMenu(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
): FitResult {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // ---- 水平 ----
  let left = x;
  if (x + menuW > vw) left = Math.max(MARGIN, vw - menuW - MARGIN);

  // ---- 垂直 ----
  const spaceBelow = vh - y - MARGIN;
  const spaceAbove = y - MARGIN;

  if (menuH <= spaceBelow) {
    // 向下放得下
    return { left, top: y };
  }

  if (menuH <= spaceAbove) {
    // 向上翻转
    return { left, bottom: vh - y };
  }

  // 两边都放不下：选空间更大的一侧，加 max-height + 滚动
  if (spaceBelow >= spaceAbove) {
    return { left, top: Math.max(MARGIN, y), maxHeight: spaceBelow, overflowY: "auto" };
  }
  // 反转后 top 也要兜底
  const top = Math.max(MARGIN, y - spaceAbove);
  const bottom = vh - y;
  return { left, top, bottom, maxHeight: spaceAbove, overflowY: "auto" };
}

// ---- 组件 -----------------------------------------------------------

export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({
    left: x,
    top: y,
    visibility: "hidden",
  });

  // 先挂到 DOM 测量真实尺寸，再在 paint 前修正位置
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const fitted = fitMenu(x, y, width, height);
    setPos({
      left: fitted.left,
      top: fitted.top,
      bottom: fitted.bottom,
      maxHeight: fitted.maxHeight,
      overflowY: fitted.overflowY,
    });
  }, [x, y]);

  // 用 ref 持有 onClose 以避免监听器因父组件重渲染反复拆装。
  // 监听器仅在组件挂载/卸载时各执行一次，杜绝因 useState 调用
  // 造成 setState → 重渲染 → useEffect 重新运行 → setTimeout(0) 间隙
  // 导致此时点击菜单关不掉的竞态问题。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="fixed z-[90] min-w-[180px] rounded-xl border border-border bg-editor py-1 shadow-md-soft animate-menu-in glass-surface"
      style={pos}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === "separator" ? (
          <div key={i} className="my-1 h-px bg-border/40" />
        ) : (
          <MenuItemRow key={i} item={entry} onClose={onClose} />
        ),
      )}
    </div>
  );
}

// ---- 子菜单 ---------------------------------------------------------

interface ParentRect {
  top: number;
  bottom: number;
  right: number;
  left: number;
}

function MenuItemRow({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const [subOpen, setSubOpen] = useState(false);
  const [parentRect, setParentRect] = useState<ParentRect | null>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const hasSub = !!(item.children && item.children.length > 0);

  const openSub = () => {
    if (!hasSub || item.disabled) return;
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    setParentRect({ top: rect.top, bottom: rect.bottom, right: rect.right, left: rect.left });
    setSubOpen(true);
  };

  const onMouseEnter = () => {
    clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(openSub, 180);
  };

  const onMouseLeave = () => {
    clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setSubOpen(false), 250);
  };

  return (
    <>
      <button
        ref={rowRef}
        disabled={item.disabled}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2 text-left text-[14px] hover:bg-hover hover-transition",
          item.danger ? "text-red-500" : "text-foreground",
          item.disabled && "pointer-events-none opacity-40",
        )}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={() => {
          if (hasSub) return;
          onClose();
          item.onClick();
        }}
      >
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        {hasSub && (
          <svg
            className="ml-1 shrink-0 text-secondary"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        )}
      </button>

      {hasSub && subOpen && parentRect && createPortal(
        <SubMenu
          parentRect={parentRect}
          entries={item.children!}
          onClose={onClose}
          onMouseEnter={() => clearTimeout(leaveTimer.current)}
          onMouseLeave={onMouseLeave}
        />,
        document.body,
      )}
    </>
  );
}

function SubMenu({
  parentRect,
  entries,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  parentRect: ParentRect;
  entries: MenuEntry[];
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 先以右侧默认位置渲染（带 hidden），useLayoutEffect 在 paint 前修正
  const [pos, setPos] = useState<React.CSSProperties>({
    left: parentRect.right,
    top: parentRect.top - MARGIN,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // ---- 水平：优先向右弹出，溢出则翻到左侧 ----
    let left = parentRect.right;
    if (left + width > vw - MARGIN) {
      left = Math.max(MARGIN, parentRect.left - width - MARGIN);
    }

    // ---- 垂直：优先向下，放不下则向上，两边都不够则滚动 ----
    const spaceBelow = vh - parentRect.top - MARGIN;
    const spaceAbove = parentRect.bottom - MARGIN;

    const style: React.CSSProperties = { left };

    if (height <= spaceBelow) {
      // 向下放得下：子菜单顶部对齐父行顶部
      style.top = Math.max(MARGIN, parentRect.top - MARGIN);
    } else if (height <= spaceAbove) {
      // 向上翻转：子菜单底部对齐父行底部
      style.bottom = vh - parentRect.bottom;
    } else {
      // 两边都放不下：选空间更大的一侧，加 max-height + 滚动
      if (spaceBelow >= spaceAbove) {
        style.top = Math.max(MARGIN, parentRect.top - MARGIN);
        style.maxHeight = spaceBelow;
      } else {
        style.bottom = vh - parentRect.bottom;
        style.top = Math.max(MARGIN, parentRect.bottom - spaceAbove);
        style.maxHeight = spaceAbove;
      }
      style.overflowY = "auto";
    }

    setPos(style);
  }, [parentRect]);

  return (
    <div
      ref={ref}
      className="fixed z-[91] min-w-[160px] rounded-xl border border-border bg-editor py-1 shadow-md-soft animate-menu-in glass-surface"
      style={pos}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === "separator" ? (
          <div key={i} className="my-1 h-px bg-border/40" />
        ) : (
          <MenuItemRow key={i} item={entry} onClose={onClose} />
        ),
      )}
    </div>
  );
}
