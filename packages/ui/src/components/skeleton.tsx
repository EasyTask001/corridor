import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-ink-100", className)} {...props} />;
}
