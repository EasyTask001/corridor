"use client";

import type { ComponentProps } from "react";
import { Root as LabelRoot } from "@radix-ui/react-label";
import { cn } from "../lib/cn";

export type LabelProps = ComponentProps<typeof LabelRoot>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <LabelRoot
      className={cn(
        "mb-1 block text-xs font-medium uppercase tracking-wide text-fg-secondary",
        className,
      )}
      {...props}
    />
  );
}
