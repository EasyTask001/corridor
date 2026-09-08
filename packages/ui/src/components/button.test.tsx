import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";

describe("Button", () => {
  it("applies the accent-filled classes for the primary variant by default", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("bg-accent");
  });

  it("applies bordered neutral classes for the secondary variant", () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("border-border-default");
  });

  it("keeps the signal variant's amber styling", () => {
    render(<Button variant="signal">Flag</Button>);
    expect(screen.getByRole("button", { name: "Flag" }).className).toContain("bg-signal-500");
  });
});
