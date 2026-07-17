// SPDX-License-Identifier: GPL-3.0-only

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // gunjin/ has its own test setup; only the worker tests run here.
    include: ["test/**/*.spec.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests must not depend on the real secret (>=16 chars to pass the guard).
          bindings: { TOKEN_SECRET: "test-secret-for-vitest-only" },
          // Static assets are not needed for API tests.
          assets: { directory: "./test/fixtures/assets" },
        },
      },
    },
  },
});
