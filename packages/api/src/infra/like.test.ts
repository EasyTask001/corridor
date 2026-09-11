import { describe, expect, it } from "vitest";
import { containsPattern, escapeLike } from "./like";

describe("escapeLike / containsPattern", () => {
  it("escapes %, _ and backslash", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(containsPattern("M-1")).toBe("%M-1%");
  });
});
