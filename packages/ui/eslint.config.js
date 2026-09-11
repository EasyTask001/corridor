import base from "@corridor/config/eslint/base.js";

export default [
  ...base,
  {
    // vitest.config.ts sits outside `include` (src/**/* and vitest.setup.ts only).
    // typescript-eslint's project service is a singleton created from whichever file is parsed
    // first in the run, so `allowDefaultProject` must be merged into the *same* broad file glob
    // as base.js's own `projectService: true` rule (not scoped narrowly to just the config
    // file) — otherwise the service can get initialized from a regular src file before this
    // override ever applies, permanently locking in an empty allowlist for the rest of the run.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "*.config.mts"],
        },
      },
    },
  },
];
