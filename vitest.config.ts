import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "src/**/__tests__/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/e2e/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/transformers/**",
        "src/lib/helpers/**",
        "src/lib/utils/**",
        "src/inngest/functions/**",
      ],
      exclude: ["**/__tests__/**", "**/index.ts"],
    },
  },
});
