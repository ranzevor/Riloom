import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.browser.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    maxWorkers: 1,
  },
});
