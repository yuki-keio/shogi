// SPDX-License-Identifier: GPL-3.0-only

import type { MatchRoom } from "./match_room";
import type { Matchmaker } from "./matchmaker";

export interface Env {
  ASSETS: Fetcher;
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  DB: D1Database;
  // だれかと対戦の対局記録だけを入れる別の D1（game_record.ts）
  RECORDS: D1Database;
  // 記録の控えだけを入れる別の D1（backup.ts）
  BACKUP: D1Database;
  // Set via `wrangler secret put TOKEN_SECRET` (local: .dev.vars).
  TOKEN_SECRET: string;
  // Set via `wrangler secret put DISCORD_WEBHOOK_URL` (local: .dev.vars).
  // Optional: when unset, feedback is stored in D1 but no notification is sent.
  DISCORD_WEBHOOK_URL?: string;
}
