// SPDX-License-Identifier: GPL-3.0-only

import type { MatchRoom } from "../src/worker/match_room";
import type { Matchmaker } from "../src/worker/matchmaker";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    ASSETS: Fetcher;
    MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
    MATCHMAKER: DurableObjectNamespace<Matchmaker>;
    TOKEN_SECRET: string;
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
