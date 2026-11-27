import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/ask-user-question/**/*.test.ts"],
    setupFiles: ["test/ask-user-question/support/setup.ts"],
    maxWorkers: 4,
  },
});
