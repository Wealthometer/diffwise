import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    fileParallelism: false, // integration files share one database
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
