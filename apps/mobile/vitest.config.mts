import { defineConfig } from "vitest/config";

/**
 * Only the pure-TypeScript modules under `src/lib` are unit-tested — anything
 * importing React Native needs Metro, not Vitest, so those modules keep their
 * RN dependencies injected rather than imported.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
