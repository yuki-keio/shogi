// SPDX-License-Identifier: GPL-3.0-only

import type { MatchRoom } from "./match_room";

export interface Env {
  ASSETS: Fetcher;
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  // Set via `wrangler secret put TOKEN_SECRET` (local: .dev.vars).
  TOKEN_SECRET: string;
}
