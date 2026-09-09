import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Shared field chrome for `Input`, `Textarea` and `NativeSelect`. */
export const fieldClassName =
  "min-h-11 w-full rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-base text-fg-primary shadow-sm sm:min-h-10 sm:text-sm " +
  "placeholder:text-fg-secondary/60 hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus-ring/20 " +
  "aria-invalid:border-danger-500 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-secondary disabled:opacity-70";

export type InputProps = ComponentProps<"input">;

export function Input({ className, ...props }: InputProps) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}
