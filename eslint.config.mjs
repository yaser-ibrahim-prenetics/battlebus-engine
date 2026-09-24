import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // This migration starts with substantial pre-existing `any` usage. Keep
      // it visible in CI without making the baseline undeployable; new code
      // should use explicit boundary types and reduce this warning count.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      // Some legacy integration harnesses load optional clients conditionally.
      "@typescript-eslint/no-require-imports": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
