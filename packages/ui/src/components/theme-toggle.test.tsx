import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./theme-toggle";
import { THEME_STORAGE_KEY } from "../lib/theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "matchMedia",
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

describe("ThemeToggle", () => {
  it("defaults to light and switches to dark on click, persisting the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = await screen.findByRole("button", { name: /switch to dark theme/i });
    await user.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("reads a stored preference on mount", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);

    expect(
      await screen.findByRole("button", { name: /switch to light theme/i }),
    ).toBeInTheDocument();
  });

  it("uses the same storage key as the web app's pre-paint init script", () => {
    expect(THEME_STORAGE_KEY).toBe("corridor-theme");
  });
});
