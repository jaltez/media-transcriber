import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Keep tests from reading or writing the user's real probe cache;
    // cache.test.ts re-enables it for its own assertions.
    env: { MEDIA_TRANSCRIBER_NO_CACHE: "1" },
  },
});
