"use client";

import type { ComponentProps } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-border-strong p-0.5 shadow-inner transition-colors",
        "data-[state=checked]:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-5 rounded-full bg-surface-raised shadow-sm transition-transform data-[state=checked]:translate-x-5" />
    </SwitchPrimitive.Root>
  );
}
