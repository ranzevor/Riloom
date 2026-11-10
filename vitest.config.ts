import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.browser.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 2,
  },
});
