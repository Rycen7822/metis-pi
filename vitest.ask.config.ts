import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@juicesharp/rpiv-test-utils": fileURLToPath(new URL("./test/helpers/ask-user-question/index.ts", import.meta.url)) } },
  test: {
    include: ["src/ask-user-question/**/*.test.ts"],
    setupFiles: ["test/helpers/ask-user-question/setup.ts"],
    maxWorkers: 4,
  },
});
