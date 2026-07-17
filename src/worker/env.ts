// SPDX-License-Identifier: GPL-3.0-only

import type { MatchRoom } from "./match_room";

export interface Env {
  ASSETS: Fetcher;
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  DB: D1Database;
  // Set via `wrangler secret put TOKEN_SECRET` (local: .dev.vars).
  TOKEN_SECRET: string;
  // Set via `wrangler secret put DISCORD_WEBHOOK_URL` (local: .dev.vars).
  // Optional: when unset, feedback is stored in D1 but no notification is sent.
  DISCORD_WEBHOOK_URL?: string;
}
