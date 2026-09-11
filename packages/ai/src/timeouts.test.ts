import { describe, expect, it, vi } from "vitest";
import { aiTimeoutSignal } from "./timeouts";

describe("aiTimeoutSignal", () => {
  it("uses the default unless the env overrides it", () => {
    vi.useFakeTimers();
    const s = aiTimeoutSignal("embedding", {});
    vi.advanceTimersByTime(19_999);
    expect(s.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(s.aborted).toBe(true);
    const s2 = aiTimeoutSignal("embedding", { CORRIDOR_AI_TIMEOUT_MS_EMBEDDING: "50" });
    vi.advanceTimersByTime(50);
    expect(s2.aborted).toBe(true);
    vi.useRealTimers();
  });
});
