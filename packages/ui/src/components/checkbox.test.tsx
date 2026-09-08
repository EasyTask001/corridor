import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("toggles checked state on click", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Accept terms" />);
    const box = screen.getByRole("checkbox", { name: "Accept terms" });
    expect(box).toHaveAttribute("data-state", "unchecked");

    await user.click(box);
    expect(box).toHaveAttribute("data-state", "checked");
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Locked" disabled />);
    const box = screen.getByRole("checkbox", { name: "Locked" });

    await user.click(box);
    expect(box).toHaveAttribute("data-state", "unchecked");
  });
});
