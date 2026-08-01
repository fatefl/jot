import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 420,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onMouseDown={onClose}
    >
      <div
        className="rounded-2xl border border-border bg-editor shadow-lg-soft animate-dialog-in"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button
            className="rounded-lg p-1 text-secondary hover:bg-hover hover:text-foreground hover-transition"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 px-6 py-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
