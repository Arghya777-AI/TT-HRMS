import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Binding guardrails (see docs/plan/00-master-plan.md §P2, §P6):
 *  - No business date is ever derived from UTC or browser locale.
 *  - The ONLY place allowed to touch toISOString()/toLocale*()/Intl date
 *    formatting is src/lib/datetime.ts and src/lib/money.ts.
 */
const IST_GUARD_RULES = {
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.property.name='toISOString'] ~ CallExpression[callee.property.name='split'], MemberExpression[property.name='toISOString']",
      message:
        "Do not derive business dates from toISOString() (that is UTC). Use util from src/lib/datetime.ts (istDate / fmtDate).",
    },
    {
      // The header above has always claimed "no business date is ever derived
      // from UTC or browser locale", but nothing here actually stopped
      // `new Date()` — and three call sites had drifted in (CommandCentre,
      // Landing, apply.api). A zero-argument `new Date()` reads the host clock
      // in the host zone; every "now" the app needs must come from
      // src/lib/datetime.ts so the IST intent is explicit at the call site.
      // `new Date(value)` with an argument stays allowed: parsing a stored
      // instant is not deriving a business date.
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message:
        "Do not call `new Date()`. Use nowInstantIso() / nowIstDate() / istToday() from src/lib/datetime.ts so the clock is IST and the intent is explicit.",
    },
  ],
  "no-restricted-properties": [
    "error",
    { object: "Date", property: "toLocaleDateString", message: "Use src/lib/datetime.ts formatters (IST)." },
    { property: "toLocaleDateString", message: "Use src/lib/datetime.ts formatters (IST)." },
    { property: "toLocaleTimeString", message: "Use src/lib/datetime.ts formatters (IST)." },
    { property: "toLocaleString", message: "Use src/lib/datetime.ts (dates) or src/lib/money.ts (currency)." },
  ],
};

export default tseslint.config(
  { ignores: ["dist", "node_modules", "hrms-digitalchemy", "supabase/functions/**/*.js"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      ...IST_GUARD_RULES,
    },
  },
  {
    // The single sanctioned home of locale/UTC date + currency formatting.
    files: ["src/lib/datetime.ts", "src/lib/money.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-properties": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
