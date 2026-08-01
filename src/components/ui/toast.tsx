import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2 } from "lucide-react";

export interface ToastAction {
  label?: string;
  onClick?: () => void;
  /** 有效期（毫秒），默认 3000 */
  duration?: number;
}

interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
}

/**
 * 弹出 toast，返回 id 供 dismiss 主动关闭（如"导出中"在完成后立即消失）。
 * 返回类型含 void 是为了兼容 `(msg) => void` 形态的 mock/窄类型传入。
 */
export type ToastFn = {
  (message: string, action?: ToastAction): number | void;
  /** 主动关闭指定 id 的 toast（Provider 内必有实现；mock 可省略） */
  dismiss?: (id: number) => void;
};

const noop: ToastFn = Object.assign(
  () => 0,
  { dismiss: () => {} },
);

const ToastContext = createContext<ToastFn>(noop);

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useMemo<ToastFn>(
    () =>
      Object.assign(
        (message: string, action?: ToastAction) => {
          const id = ++idRef.current;
          setToasts((prev) => [...prev, { id, message, action }]);
          setTimeout(() => dismiss(id), action?.duration ?? 3000);
          return id;
        },
        { dismiss },
      ),
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-10 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-editor px-4 py-2.5 text-[14px] shadow-md-soft animate-menu-in glass-surface"
          >
            <CheckCircle2 size={14} className="shrink-0 text-accent" />
            {t.message}
            {t.action && (t.action.label || t.action.onClick) && (
              <button
                className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft"
                onClick={() => {
                  t.action!.onClick?.();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
