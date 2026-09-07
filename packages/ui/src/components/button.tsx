import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-ink-950 text-white hover:bg-ink-800",
        secondary: "border border-ink-100 bg-white text-ink-950 hover:bg-ink-50",
        signal: "bg-signal-500 text-ink-950 hover:bg-signal-600",
        danger: "bg-danger-500 text-white hover:bg-danger-500/90",
        ghost: "text-ink-500 hover:text-ink-950",
        link: "text-ink-500 underline-offset-2 hover:text-ink-950 hover:underline",
      },
      size: {
        md: "px-4 py-2 text-sm",
        sm: "px-3 py-1 text-xs",
        xs: "px-2 py-1 text-xs",
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
