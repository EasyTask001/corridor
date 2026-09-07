import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Shared field chrome for `Input`, `Textarea` and `NativeSelect`. */
export const fieldClassName =
  "w-full rounded-md border border-ink-100 bg-white px-3 py-2 text-sm text-ink-950 " +
  "placeholder:text-ink-300 focus:border-ink-700 focus:outline-none focus:ring-2 focus:ring-ink-700/15";

export type InputProps = ComponentProps<"input">;

export function Input({ className, ...props }: InputProps) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}
