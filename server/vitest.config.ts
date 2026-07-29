import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        // Integration tests talk to a real Postgres over the network; the default
        // 5s is not enough for a round trip to a hosted database.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // One file at a time. The integration suite writes real rows, and parallel
        // files would race on the same tables.
        fileParallelism: false,
    },
});
