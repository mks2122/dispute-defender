import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["node_modules/", "web/dist/", "data/", ".playwright-mcp/"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Banned: render text with React (ENGINEERING-PRACTICES §5)." }],
    },
  },
  {
    files: ["server/**/*.js", "scripts/**/*.mjs", "tests/**/*.{js,mjs}", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // ARCHITECTURE §4 layer rules for server code.
    files: ["server/**/*.js"],
    rules: {
      // Only server/log.js writes to the console (so nothing logs secrets or PayPal bodies by accident).
      "no-console": "error",
      "no-restricted-imports": ["error", {
        paths: [
          { name: "node:sqlite", message: "Only server/db.js may use SQLite." },
          { name: "@libsql/client", message: "Only server/mirror.js may talk to Turso." },
          { name: "@libsql/client/web", message: "Only server/mirror.js may talk to Turso." },
          { name: "./db.js", importNames: ["__testDb"], message: "Test-only handle. SQL belongs in server/db.js." },
          { name: "../db.js", importNames: ["__testDb"], message: "Test-only handle. SQL belongs in server/db.js." },
        ],
      }],
    },
  },
  { files: ["server/log.js"], rules: { "no-console": "off" } },
  { files: ["server/db.js", "server/mirror.js"], rules: { "no-restricted-imports": "off" } },
  {
    // Only the integration layer may make network calls.
    files: ["server/**/*.js"],
    ignores: ["server/paypal/**", "server/ai/**"],
    rules: { "no-restricted-globals": ["error", { name: "fetch", message: "Network I/O belongs in the integration layer (server/paypal, server/ai)." }] },
  },
  {
    files: ["web/**/*.{js,jsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]", argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
