// ESLint v9 flat config for the AgencyBook backend (Express + CommonJS).
// See agency-os/CLAUDE.md and agency-os-backend/CLAUDE.md for project rules.

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "deploy/**",
      "scripts/**",
      "seed_data.js",
      "uploads/**",
      "supabase/**",
      "templates/**",
      "assets/**",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      // We rely on console.* for ops logging in routes/middleware.
      "no-console": "off",

      // Relaxed: surface but don't block CI.
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": "warn",

      // Existing codebase has many pre-existing minor issues — surface as warnings,
      // not errors, so CI lint gate doesn't block on tech debt unrelated to the PR.
      // Tighten back to "error" once the baseline is cleaned up.
      "no-useless-escape": "warn",
      "no-prototype-builtins": "warn",
      "no-async-promise-executor": "warn",
      "no-control-regex": "warn",
      "no-misleading-character-class": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
      "no-irregular-whitespace": "warn",
      "no-case-declarations": "warn",
      "no-inner-declarations": "warn",
      "no-undef": "error", // keep this strict — undefined symbols are real bugs
    },
  },
  {
    // Tests get jest globals.
    files: ["tests/**/*.js", "**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
];
