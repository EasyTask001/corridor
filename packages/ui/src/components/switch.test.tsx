import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./switch";

describe("Switch", () => {
  it("toggles on click", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Enable notifications" />);
    const toggle = screen.getByRole("switch", { name: "Enable notifications" });
    expect(toggle).toHaveAttribute("data-state", "unchecked");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
  });
});
