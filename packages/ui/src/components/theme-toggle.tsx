"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "../lib/cn";

const STORAGE_KEY = "corridor-theme";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const resolved =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(resolved);
  }, []);

  if (!theme) return null;

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg-primary",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
