import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names: `clsx` for conditionals, `tailwind-merge` so a caller's
 * `className` always beats the component's own variant classes.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
