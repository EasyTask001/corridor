import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-ink-100 text-ink-500",
        muted: "bg-ink-100 text-ink-300",
        ok: "bg-ok-500/10 text-ok-500",
        warn: "bg-warn-500/10 text-warn-500",
        danger: "bg-danger-500/10 text-danger-500",
        signal: "bg-signal-500/15 text-signal-600",
        solid: "bg-ink-950 text-white",
        outline: "border border-ink-100 text-ink-700",
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
