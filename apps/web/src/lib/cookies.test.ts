import { describe, expect, it } from "vitest";
import { appCookieOptions } from "./cookies";

describe("appCookieOptions", () => {
  it("is httpOnly, lax, path=/ and secure only in production", () => {
    expect(appCookieOptions({}, "production")).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(appCookieOptions({ maxAge: 60 }, "development")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60,
    });
  });
});
