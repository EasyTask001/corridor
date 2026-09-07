import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { fieldClassName } from "./input";

export type TextareaProps = ComponentProps<"textarea">;

export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea className={cn(fieldClassName, className)} {...props} />;
}
