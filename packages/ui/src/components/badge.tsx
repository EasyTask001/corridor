import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-surface-sunken text-fg-secondary",
        muted: "bg-surface-sunken text-fg-secondary/70",
        ok: "bg-ok-500/10 text-status-ok",
        warn: "bg-warn-500/10 text-status-warn",
        danger: "bg-danger-500/10 text-status-danger",
        signal: "bg-signal-500/15 text-status-signal",
        solid: "bg-fg-primary text-fg-inverted",
        outline: "border border-border-default text-fg-primary",
      },
      /** Small-caps treatment used by status/severity chips. */
      caps: { true: "font-semibold uppercase tracking-wide", false: "" },
    },
    defaultVariants: { variant: "neutral", caps: false },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, caps, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, caps }), className)} {...props} />;
}
