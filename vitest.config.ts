import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // Phase 0 ships zero tests — the harness must be proven runnable, not faked with a
    // dummy test. Later phases add real suites; this stays true once they do.
    passWithNoTests: true,
    // Claude worktrees live inside the checkout; their copies of the suite are not this tree's.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
