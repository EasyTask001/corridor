import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RadioGroup, RadioGroupItem } from "./radio-group";

describe("RadioGroup", () => {
  it("selects one item at a time", async () => {
    const user = userEvent.setup();
    render(
      <RadioGroup defaultValue="a" aria-label="Plan">
        <RadioGroupItem value="a" aria-label="Basic" />
        <RadioGroupItem value="b" aria-label="Pro" />
      </RadioGroup>,
    );

    expect(screen.getByRole("radio", { name: "Basic" })).toHaveAttribute("data-state", "checked");
    await user.click(screen.getByRole("radio", { name: "Pro" }));
    expect(screen.getByRole("radio", { name: "Pro" })).toHaveAttribute("data-state", "checked");
    expect(screen.getByRole("radio", { name: "Basic" })).toHaveAttribute("data-state", "unchecked");
  });
});
