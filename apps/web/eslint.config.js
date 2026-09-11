import base from "@corridor/config/eslint/base.js";
import nextVitals from "eslint-config-next/core-web-vitals";

export default [
  ...base,
  ...nextVitals,
  {
    // e2e specs live outside tsconfig.json's `include` (excluded alongside node_modules).
    // typescript-eslint's project service is a singleton created from whichever file is parsed
    // first in the run, so `allowDefaultProject` must be merged into the *same* broad file glob
    // as base.js's own `projectService: true` rule (not scoped narrowly to just the e2e specs)
    // — otherwise the service can get initialized from a regular src file before this override
    // ever applies, permanently locking in an empty allowlist for the rest of the run.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // allowDefaultProject globs must not contain `**` (single directory level only);
          // all e2e specs live directly in `e2e/`, so `e2e/*.spec.ts` covers all of them.
          allowDefaultProject: ["e2e/*.spec.ts"],
          // The default cap (8) is smaller than the 11 e2e specs this glob matches.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
      },
    },
  },
  { ignores: [".next/**", "next-env.d.ts"] },
];
