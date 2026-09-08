import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        "bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-border-default", className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return <tfoot className={cn("border-t border-border-default", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={className} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-4 py-2 font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-2", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption className={cn("px-4 py-2 text-xs text-fg-secondary", className)} {...props} />;
}
