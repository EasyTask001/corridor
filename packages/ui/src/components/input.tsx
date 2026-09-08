import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Shared field chrome for `Input`, `Textarea` and `NativeSelect`. */
export const fieldClassName =
  "w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm text-fg-primary " +
  "placeholder:text-fg-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus-ring/15";

export type InputProps = ComponentProps<"input">;

export function Input({ className, ...props }: InputProps) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}
