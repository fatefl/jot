import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute -top-7 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-editor px-1.5 py-0.5 text-xs text-foreground opacity-0 shadow-overlay transition-opacity group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}
