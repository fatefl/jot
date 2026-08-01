import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  emojiCategories,
  getRecentEmojis,
  addRecentEmoji,
} from "@/lib/emojiData";

interface EmojiPickerProps {
  open: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

/** 虚拟"最近使用"分类的标识 */
const RECENT_ID = "__recent__";

/**
 * 表情选择弹窗
 *
 * 布局：
 * - 顶部分类标签栏（含最近使用）
 * - 中间 emoji 网格
 * - 点击外部关闭，Escape 关闭
 */
export function EmojiPicker({ open, onSelect, onClose }: EmojiPickerProps) {
  const [activeCat, setActiveCat] = useState<string>(RECENT_ID);
  const [gridIndex, setGridIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => getRecentEmojis());
  const gridRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  // 构建完整分类列表（最近使用 + 9 类）
  const allCategories = useCallback(() => {
    const cats: any[] = [];
    if (recent.length > 0) {
      cats.push({
        name: "最近使用",
        icon: "🕐",
        emojis: recent,
        _id: RECENT_ID,
      });
    }
    for (const cat of emojiCategories) {
      cats.push({ ...cat, _id: cat.name });
    }
    return cats;
  }, [recent]);

  const cats = allCategories();
  const currentCat = cats.find((c) => (c as any)._id === activeCat) ?? cats[0];
  // 统一 emoji 列表（最近使用是 string[]，分类是 EmojiItem[]）
  const emojis: string[] = currentCat
    ? (currentCat as any).emojis.map((e: any) => (typeof e === "string" ? e : e.char))
    : [];
  const cols = 10;

  // 重置状态
  useEffect(() => {
    if (open) {
      setRecent(getRecentEmojis());
      setActiveCat(RECENT_ID);
      setGridIndex(0);
    }
  }, [open]);

  // 分类标签栏：滚轮横向滚动
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el || !open) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 触控板横向滑动不拦截
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  // 键盘导航
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setGridIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setGridIndex((i) => Math.min(emojis.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setGridIndex((i) => Math.max(0, i - cols));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setGridIndex((i) => Math.min(emojis.length - 1, i + cols));
        return;
      }
      // 左右切换分类
      if (e.key === "Tab") {
        e.preventDefault();
        const idx = cats.findIndex((c) => (c as any)._id === activeCat);
        const next = e.shiftKey
          ? (idx - 1 + cats.length) % cats.length
          : (idx + 1) % cats.length;
        setActiveCat((cats[next] as any)._id);
        setGridIndex(0);
        return;
      }
      if (e.key === "Enter" && emojis[gridIndex]) {
        e.preventDefault();
        handleSelect(emojis[gridIndex]);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, emojis, gridIndex, activeCat, cats]);

  // 滚动聚焦项
  useEffect(() => {
    const el = gridRef.current?.children[gridIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [gridIndex]);

  const handleSelect = (emoji: string) => {
    addRecentEmoji(emoji);
    onSelect(emoji);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[115] flex items-start justify-center pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[390px] max-h-[440px] overflow-hidden rounded-2xl border border-border bg-editor shadow-lg-soft flex flex-col animate-dialog-in glass-surface"
        style={{ backdropFilter: "blur(24px) saturate(1.3)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 分类标签栏 */}
        <div
          ref={tabBarRef}
          className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-4 py-2 min-h-[44px]"
          style={{ scrollbarWidth: "none" }}
        >
          {cats.map((cat) => {
            const id = (cat as any)._id as string;
            const isActive = id === activeCat;
            const icon = typeof cat.icon === "string" ? cat.icon : "";
            return (
              <button
                key={id}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "text-secondary hover:text-foreground hover:bg-hover",
                )}
                onClick={() => {
                  setActiveCat(id);
                  setGridIndex(0);
                }}
                title={cat.name}
              >
                <span className="text-base leading-none">{icon}</span>
                {id !== RECENT_ID && (
                  <span className="hidden sm:inline">{cat.name}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Emoji 网格 */}
        <div
          ref={gridRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: "4px",
          }}
        >
          {emojis.map((emoji, i) => (
            <button
              key={`${activeCat}-${i}`}
              className={cn(
                "flex items-center justify-center w-full aspect-square rounded text-xl leading-none transition-colors cursor-pointer",
                i === gridIndex
                  ? "bg-accent-soft ring-1 ring-accent/30"
                  : "hover:bg-hover",
              )}
              onClick={() => handleSelect(emoji)}
              onMouseEnter={() => setGridIndex(i)}
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 text-[10px] text-secondary/60">
          <span>←→↑↓ 导航 · Enter 选择 · Tab 切换分类</span>
          <span>{emojis.length} 个</span>
        </div>
      </div>
    </div>
  );
}
