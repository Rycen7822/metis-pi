import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@juicesharp/rpiv-test-utils": fileURLToPath(new URL("../../test/ask-user-question/support/index.ts", import.meta.url)) } },
  test: {
    include: ["test/ask-user-question/**/*.test.ts"],
    setupFiles: ["test/ask-user-question/support/setup.ts"],
    maxWorkers: 4,
  },
});
