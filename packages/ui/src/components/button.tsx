import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold shadow-sm transition-colors active:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary:
          "border border-border-default bg-surface-raised text-fg-primary hover:bg-surface-sunken",
        signal: "bg-signal-500 text-ink-950 hover:bg-signal-600",
        danger: "bg-danger-500 text-white hover:bg-danger-500/90",
        ghost: "shadow-none text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary",
        link: "text-fg-secondary underline-offset-2 hover:text-fg-primary hover:underline",
      },
      size: {
        md: "min-h-11 px-4 py-2 text-sm sm:min-h-10",
        sm: "min-h-9 px-3 py-1.5 text-xs",
        xs: "min-h-8 px-2.5 py-1 text-xs",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

/**
 * Deliberately does not default `type`: several call sites are the submit
 * button of a (server action) form and rely on the native default.
 */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
