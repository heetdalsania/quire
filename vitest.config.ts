import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The bridge tests drive the real filesystem; parallel temp dirs are fine
    // but watcher-heavy suites are less flaky run serially per file.
    fileParallelism: false,
  },
});
