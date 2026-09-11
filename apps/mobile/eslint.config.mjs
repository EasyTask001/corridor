import base from "@corridor/config/eslint/base.js";

/**
 * The workspace base config plus the two things a React Native app needs:
 * CommonJS globals for Metro/Babel config files, and React's JSX globals.
 * `eslint-plugin-react-native` is deliberately not installed — its rules are
 * about stylesheet hygiene, which Prettier and review already cover.
 */
export default [
  ...base,
  {
    // Metro and Babel load their config with `require`, so these two files are
    // CommonJS by necessity.
    files: ["*.js", "*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", module: "writable", require: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        crypto: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // vitest.config.mts uses the `.mts` extension, which `**/*.ts` in tsconfig's `include`
    // does not match. typescript-eslint's project service is a singleton created from
    // whichever file is parsed first in the run, so `allowDefaultProject` must be merged into
    // the *same* broad file glob as base.js's own `projectService: true` rule (not scoped
    // narrowly to just the config file) — otherwise the service can get initialized from a
    // regular src file before this override ever applies, permanently locking in an empty
    // allowlist for the rest of the run.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "*.config.mts"],
        },
      },
    },
  },
  { ignores: [".expo/**", "expo-env.d.ts"] },
];
