import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutDashboard } from "lucide-react";
import { NavGroup, navItemVariants } from "./nav";

describe("navItemVariants", () => {
  it("marks the active state distinctly from inactive", () => {
    // Both states legitimately reference `bg-surface-sunken` (inactive gets it
    // only on hover, at reduced opacity), so distinguish on `font-medium`
    // instead of the shared color name.
    expect(navItemVariants({ active: true })).toContain("font-medium");
    expect(navItemVariants({ active: false })).not.toContain("font-medium");
  });
});

describe("NavGroup", () => {
  it("is closed by default and opens on trigger click (uncontrolled)", async () => {
    const user = userEvent.setup();
    render(
      <NavGroup icon={LayoutDashboard} label="Parties">
        <span>Drivers</span>
      </NavGroup>,
    );

    expect(screen.queryByText("Drivers")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Parties/ }));
    expect(await screen.findByText("Drivers")).toBeInTheDocument();
  });

  it("respects a controlled `open` prop and calls onOpenChange on toggle", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <NavGroup icon={LayoutDashboard} label="Settings" open onOpenChange={onOpenChange}>
        <span>Billing</span>
      </NavGroup>,
    );

    expect(screen.getByText("Billing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Settings/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
