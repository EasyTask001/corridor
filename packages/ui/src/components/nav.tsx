"use client";

import type { ComponentProps, ReactNode } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Styles only — deliberately not an anchor. Callers apply this to whatever
 * link element they render (e.g. `next/link`'s `Link`) so `@corridor/ui`
 * stays framework-agnostic.
 */
export const navItemVariants = cva(
  "flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors lg:min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40",
  {
    variants: {
      active: {
        true: "bg-accent/10 font-medium text-accent",
        false: "text-fg-secondary hover:bg-surface-sunken/60 hover:text-fg-primary",
      },
    },
    defaultVariants: { active: false },
  },
);

export type NavItemVariantProps = VariantProps<typeof navItemVariants>;

export function NavItemContent({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", className)}>
      <Icon className="size-[1.125rem] shrink-0" strokeWidth={1.8} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface NavGroupProps extends ComponentProps<typeof CollapsiblePrimitive.Root> {
  icon: LucideIcon;
  label: ReactNode;
  /** Highlights the group header itself, e.g. when a child route is active. */
  active?: boolean;
}

export function NavGroup({
  icon: Icon,
  label,
  active,
  className,
  children,
  ...props
}: NavGroupProps) {
  return (
    <CollapsiblePrimitive.Root className={cn("space-y-0.5", className)} {...props}>
      <CollapsiblePrimitive.Trigger className={cn(navItemVariants({ active }), "group w-full")}>
        <NavItemContent icon={Icon}>{label}</NavItemContent>
        <ChevronRight
          className="size-3.5 shrink-0 text-fg-secondary transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="mt-1 space-y-0.5 overflow-hidden pl-5">
        {children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
