import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-9 w-full rounded border border-border bg-editor px-3 text-[14px] text-foreground placeholder:text-secondary focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] transition-colors",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
