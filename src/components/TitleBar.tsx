import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { MenuBar, type MenuGroup } from "./MenuBar";

interface TitleBarProps {
  menuGroups: MenuGroup[];
  fileName: string | null;
  onClose?: () => void;
}

function WindowControls({ onClose }: { onClose?: () => void }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    // 初始状态
    win.isMaximized().then(setMaximized).catch(() => {});

    // 监听窗口变化以同步最大化状态
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    win
      .onResized(async () => {
        try {
          const isMax = await win.isMaximized();
          if (!cancelled) setMaximized(isMax);
        } catch {}
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const minimize = () => getCurrentWindow().minimize().catch(() => {});
  const toggleMax = () => getCurrentWindow().toggleMaximize().catch(() => {});
  const closeWindow = () => {
    if (onClose) {
      onClose();
    } else {
      getCurrentWindow().close().catch(() => {});
    }
  };

  return (
    <div className="flex items-center gap-0.5 mr-1">
      <button className="win-btn" onClick={minimize} title="最小化">
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button className="win-btn" onClick={toggleMax} title={maximized ? "还原" : "最大化"}>
        {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={13} strokeWidth={1.5} />}
      </button>
      <button className="win-btn win-btn-close" onClick={closeWindow} title="关闭">
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function TitleBar({ menuGroups, fileName, onClose }: TitleBarProps) {
  const title = fileName ? `${fileName} — 即记 (Jot)` : "即记 (Jot)";
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 点击目标是按钮时不处理
    if (target.closest("button")) return;

    // 双击检测：400ms 内两次 mousedown → 最大化/还原
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      getCurrentWindow().toggleMaximize().catch(() => {});
      return;
    }

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
    }, 400);

    // 单击：启动窗口拖拽
    getCurrentWindow().startDragging().catch(() => {});
  }, []);

  return (
    <div
      className="flex items-center h-11 shrink-0 bg-sidebar select-none"
      onMouseDown={handleMouseDown}
    >
      <MenuBar groups={menuGroups} className="pl-2" />
      <div className="flex-1 self-stretch flex items-center justify-center text-xs text-secondary whitespace-nowrap overflow-hidden text-ellipsis px-4">
        {title}
      </div>
      <WindowControls onClose={onClose} />
    </div>
  );
}
