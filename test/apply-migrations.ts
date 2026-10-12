// SPDX-License-Identifier: GPL-3.0-only

import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.RECORDS, env.TEST_RECORDS_MIGRATIONS);
await applyD1Migrations(env.BACKUP, env.TEST_BACKUP_MIGRATIONS);
