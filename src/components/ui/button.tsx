import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
}

const variants: Record<string, string> = {
  default:
    "bg-accent text-white hover:opacity-90 shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.06)]",
  ghost: "hover:bg-hover text-foreground",
  outline:
    "border border-border bg-[#f7f7f7] hover:bg-[#e1e1e1] active:bg-[#bcc4d0] dark:bg-white/10 dark:hover:bg-white/15 dark:active:bg-white/20 text-foreground",
};

const sizes: Record<string, string> = {
  default: "h-9 px-4",
  sm: "h-8 px-3 text-xs",
  icon: "h-8 w-8",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded text-[14px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 hover-transition",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
