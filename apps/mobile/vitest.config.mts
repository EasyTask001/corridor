import { defineConfig } from "vitest/config";

/**
 * Only the pure-TypeScript modules under `src/lib` are unit-tested — anything
 * importing React Native needs Metro, not Vitest, so those modules keep their
 * RN dependencies injected rather than imported. `scripts/*.test.mjs` are
 * release-gate scripts with the same property (plain Node, no RN), so they
 * share this project rather than needing their own.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
