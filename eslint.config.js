import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // services/edge-functions is Deno code, linted by its own `deno lint` job.
  // The browser-targeted config here would double-lint it and conflict with
  // deno-lint-ignore directives, so it's excluded.
  { ignores: ["dist", "services/edge-functions/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // US-446: jsx-a11y guards that interactive controls expose an accessible
      // name. anchor-has-content fails the build if a link has no discernible
      // text/aria-label; the aria-* rules reject invalid or unsupported ARIA so
      // an aria-label can't silently be dropped. Icon-only buttons must carry an
      // aria-label or sr-only text — enforced here + in tiptap-toolbar.tsx.
      // (The broader jsx-a11y/recommended set surfaces pre-existing violations
      //  owned by sibling A11y stories US-447..454; adopt incrementally.)
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
    },
  }
);
