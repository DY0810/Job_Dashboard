import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Phase 0 ships zero tests — the harness must be proven runnable, not faked with a
    // dummy test. Later phases add real suites; this stays true once they do.
    passWithNoTests: true,
  },
});
