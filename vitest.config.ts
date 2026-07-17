// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      // gunjin/ has its own test setup; only the worker tests run here.
      include: ["test/**/*.spec.ts"],
      // Applies the D1 migrations to the per-test local database.
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Tests must not depend on the real secret (>=16 chars to pass the guard).
            bindings: {
              TOKEN_SECRET: "test-secret-for-vitest-only",
              // Empty = notification skipped; keeps `npm test` from posting to
              // the real Discord channel when .dev.vars has the webhook URL.
              DISCORD_WEBHOOK_URL: "",
              TEST_MIGRATIONS: migrations,
            },
            // Static assets are not needed for API tests.
            assets: { directory: "./test/fixtures/assets" },
          },
        },
      },
    },
  };
});
