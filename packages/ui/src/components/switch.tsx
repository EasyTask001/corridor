"use client";

import type { ComponentProps } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors",
        "data-[state=checked]:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-4 translate-x-0.5 rounded-full bg-surface-raised transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
