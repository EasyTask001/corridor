import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Matches the app's legacy `.panel` chrome: raised surface, hairline border, soft shadow. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border-default bg-surface-raised shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("border-b border-border-default px-5 py-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-sm font-semibold text-fg-primary", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p className={cn("mt-0.5 text-sm leading-relaxed text-fg-secondary", className)} {...props} />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center gap-2 border-t border-border-default px-5 py-4", className)}
      {...props}
    />
  );
}
