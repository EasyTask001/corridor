import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const alertVariants = cva("rounded-md border px-4 py-3 text-sm", {
  variants: {
    variant: {
      info: "border-border-default bg-surface-sunken text-fg-primary",
      ok: "border-ok-500/30 bg-ok-500/10 text-status-ok",
      warn: "border-warn-500/30 bg-warn-500/10 text-status-warn",
      danger: "border-danger-500/30 bg-danger-500/10 text-status-danger",
    },
  },
  defaultVariants: { variant: "info" },
});

export type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

export function Alert({ className, variant, ...props }: AlertProps) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-0.5 opacity-90", className)} {...props} />;
}
