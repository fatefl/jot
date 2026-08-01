// 链接悬浮编辑卡片：普通点击 .lp-link 时弹出，
// 提供 打开 / 复制 / 编辑 / 移除 四个操作。
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Copy, ExternalLink, Pen, Trash2 } from "lucide-react";

interface LinkCardProps {
  x: number;
  y: number;
  url: string;
  onOpen: () => void;
  onCopy: () => void;
  /** 确认编辑：新 URL 为空时由调用方按「移除」处理 */
  onEdit: (newUrl: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

const MARGIN = 4;

export function LinkCard({
  x,
  y,
  url,
  onOpen,
  onCopy,
  onEdit,
  onRemove,
  onClose,
}: LinkCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url);
  // 先挂到 DOM 测量真实尺寸，再在 paint 前 clamp 到视口内，不会闪烁
  const [pos, setPos] = useState<React.CSSProperties>({
    left: x,
    top: y,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, x),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );
    const top = Math.min(
      Math.max(MARGIN, y),
      Math.max(MARGIN, window.innerHeight - height - MARGIN),
    );
    setPos({ left, top });
  }, [x, y, editing]);

  // 用 ref 持有 onClose 以避免监听器因重渲染反复拆装（同 ContextMenu 的写法）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      // 点到另一个链接上时不关——编辑器的 mousedown 处理会把卡片换到新链接
      if ((e.target as HTMLElement).closest?.(".lp-link")) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("blur", close);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const confirmEdit = () => {
    onEdit(draft.trim());
  };

  return (
    <div
      ref={ref}
      className="fixed z-[90] flex items-center gap-1 rounded-xl border border-border bg-editor px-2 py-1.5 shadow-md-soft animate-menu-in glass-surface"
      style={pos}
      onMouseDown={(e) => {
        e.stopPropagation();
        // 输入框需要正常获得焦点，其余区域阻止默认行为以免编辑器失焦/光标移动
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="w-64 rounded-lg border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirmEdit();
            } else if (e.key === "Escape") {
              // 取消编辑而非关闭卡片；阻止冒泡到 window 的关闭监听
              e.stopPropagation();
              setDraft(url);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="max-w-64 truncate px-1 text-[13px] text-secondary"
          title={url}
        >
          {url}
        </span>
      )}
      <CardButton title="打开" onClick={onOpen}>
        <ExternalLink size={14} />
      </CardButton>
      <CardButton title="复制" onClick={onCopy}>
        <Copy size={14} />
      </CardButton>
      <CardButton title="编辑" onClick={() => setEditing((v) => !v)}>
        <Pen size={14} />
      </CardButton>
      <CardButton title="移除" danger onClick={onRemove}>
        <Trash2 size={14} />
      </CardButton>
    </div>
  );
}

function CardButton({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      className={`rounded-lg p-1.5 hover:bg-hover hover-transition ${
        danger ? "text-red-500" : "text-foreground"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
