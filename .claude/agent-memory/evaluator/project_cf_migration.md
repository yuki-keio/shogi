---
name: project-cf-migration
description: The online-match backend is being migrated from Supabase to Cloudflare Workers + Durable Objects; supabase/ stays as the compatibility/rollback reference
metadata:
  type: project
---

The 通信対戦 (online match) backend is being migrated from Supabase (Auth + Edge Functions + Postgres + Realtime + pg_cron) to Cloudflare Workers + a single Durable Object class `MatchRoom` (SQLite + WebSocket Hibernation + Alarm). New code lives in `src/worker/`.

**Why:** management consolidation onto Cloudflare + cost cut (drop Supabase Pro $25/mo → Workers Paid $5/mo) + lower move-sync latency (WS push vs Realtime+15s heartbeat). Plan doc: `/Users/yuki/Downloads/cloudflare-migration-plan.md`.

**How to apply when reviewing:**
- `supabase/functions/**` is the **behavioral source of truth** for compatibility (error codes, revision sync, 60s disconnect / draw-on-both-disconnect, 24h expiry, reconnect-by-uid). It is intentionally kept during the observation/rollback window and scheduled for deletion in a later phase — so the duplicated `shogi_engine.ts` / `disconnect.ts` between `src/worker/` and `supabase/functions/_shared/` is expected, not drift. `src/worker/shogi_engine.ts` was verified byte-identical to the Supabase copy.
- Compatibility contract to preserve: invite URL `?mode=online&room=CODE`, uid is the reconnect credential and must never be sent to clients, playerToken = HMAC-SHA256 signed (not encrypted).
- Tests: `npx vitest run` (vitest + @cloudflare/vitest-pool-workers), suite under `test/`.
