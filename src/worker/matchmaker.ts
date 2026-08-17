// SPDX-License-Identifier: GPL-3.0-only

// Matchmaker Durable Object — a single global instance ("global") pairs players
// FIFO and wires them into a freshly created MatchRoom. The waiting queue IS
// the set of hibernatable WebSockets: each socket carries {uid, name, queuedAt,
// bot, matched} in its attachment, so hibernation/eviction cannot lose queue
// state. SQLite holds only the "rooms recently created" counter behind the
// lobby's approximate 「N人が対局中」 display.

import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "./room";
import { signPlayerToken } from "./token";
import { ROOM_TTL_MS } from "./match_room";
import type { Env } from "./env";
import type { Player } from "./shogi_engine";
import type { MatchmakerServerMessage } from "./protocol";

// Pairing happens on connect; the alarm only enforces timeouts, so a coarse
// 5-second tick is enough (spec §4.4).
const QUEUE_TICK_MS = 5_000;
// After this, clients with the COM fallback enabled (bot=1) get {type:"bot"}.
const BOT_FALLBACK_MS = 60_000;
// Fallback-off clients (bot=0) keep waiting, but not forever: after 10 minutes
// they are told to try again later so zombie sockets do not pile up.
const NO_BOT_TIMEOUT_MS = 600_000;
// 「N人が対局中」 = rooms created in this window × 2 + current waiters. Room
// endings are deliberately not tracked; this is an approximation (spec §4.6).
const ACTIVE_ROOMS_WINDOW_MS = 15 * 60 * 1000;
// A matched socket is closed right after the matched message; one still around
// this much later means the DO restarted mid-pairing. Fail it out.
const MATCHED_STALE_MS = 30_000;

type QueueAttachment = {
  uid: string;
  name: string | null;
  queuedAt: number; // epoch ms
  bot: boolean; // false = the client opted out of the COM fallback
  matched: boolean; // claimed by a pairing already in flight
  matchedAt?: number;
};

type Waiting = { ws: WebSocket; att: QueueAttachment };

export class Matchmaker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Same keepalive convention as MatchRoom so the client can reuse its
    // WebSocket plumbing (10s "ping" → uncharged "pong").
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Unlike MatchRoom there is no zero-storage cleanup contract: this object is
  // a permanent singleton, so creating the table on first use is fine.
  private schemaEnsured = false;
  private ensureSchema(): void {
    if (this.schemaEnsured) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_rooms (
        room_code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);
    this.schemaEnsured = true;
  }

  // ---- queue entry (WebSocket upgrade) ----------------------------------

  // The Worker has already validated the uid, applied the rate limit and
  // normalized/filtered the display name; identity arrives via x-mm-* headers
  // (the name percent-encoded to stay header-safe).
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { ok: false, error: { code: "bad_request", message: "Expected WebSocket upgrade" } },
        { status: 400 },
      );
    }
    const uid = request.headers.get("x-mm-uid");
    if (!uid) {
      return Response.json(
        { ok: false, error: { code: "unauthorized", message: "Missing player identity" } },
        { status: 401 },
      );
    }
    const rawName = request.headers.get("x-mm-name");
    let name: string | null = null;
    if (rawName) {
      try {
        name = decodeURIComponent(rawName) || null;
      } catch {
        name = null;
      }
    }
    const bot = request.headers.get("x-mm-bot") !== "0";
    const now = Date.now();

    // One seat per uid: a reconnect (reopened tab) keeps the newer socket, so
    // a stale tab can never wedge the queue. Never match a uid with itself.
    for (const ws of this.ctx.getWebSockets(uid)) {
      this.closeQuietly(ws, 4000, "superseded");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [uid]);
    const att: QueueAttachment = { uid, name, queuedAt: now, bot, matched: false };
    server.serializeAttachment(att);

    this.send(server, { type: "queued", playing: this.countPlaying(now) });

    await this.tryMatch(now);
    await this.armAlarm(now);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- pairing -----------------------------------------------------------

  private waitingSockets(): Waiting[] {
    const byUid = new Map<string, Waiting>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1 /* OPEN — closing sockets linger in the list */) continue;
      const att = ws.deserializeAttachment() as QueueAttachment | null;
      if (!att || att.matched) continue;
      // fetch() already supersedes same-uid sockets, but that close is
      // asynchronous, so a duplicate can still be visible here. Keep the newer.
      const prev = byUid.get(att.uid);
      if (!prev) {
        byUid.set(att.uid, { ws, att });
      } else if (att.queuedAt >= prev.att.queuedAt) {
        this.closeQuietly(prev.ws, 4000, "superseded");
        byUid.set(att.uid, { ws, att });
      } else {
        this.closeQuietly(ws, 4000, "superseded");
      }
    }
    return [...byUid.values()].sort((a, b) => a.att.queuedAt - b.att.queuedAt);
  }

  // Pair FIFO couples until fewer than two waiters remain. The matched claim is
  // committed to both attachments synchronously BEFORE the first await: the DO
  // input gate opens during the MatchRoom RPCs, so a concurrent connect or
  // alarm must never see these two sockets as available.
  private async tryMatch(now: number): Promise<void> {
    for (;;) {
      const waiting = this.waitingSockets();
      if (waiting.length < 2) return;
      const [a, b] = waiting;
      a.att.matched = true;
      a.att.matchedAt = now;
      a.ws.serializeAttachment(a.att);
      b.att.matched = true;
      b.att.matchedAt = now;
      b.ws.serializeAttachment(b.att);
      await this.pairUp(a, b);
    }
  }

  private async pairUp(a: Waiting, b: Waiting): Promise<void> {
    try {
      // Room-code collision retry, same as the Worker's create handler.
      let roomCode: string | null = null;
      let sideA: Player | null = null;
      for (let attempt = 0; attempt < 8 && roomCode === null; attempt++) {
        const code = generateRoomCode(10);
        const result = await this.env.MATCH_ROOM.getByName(code).createRoom({
          roomCode: code,
          uid: a.att.uid,
          displayName: a.att.name,
          sidePref: "random", // seat assignment stays MatchRoom's job (spec §4.4)
          tcType: "per_move",
          tcSeconds: 30,
          matchType: "matchmaking",
        });
        if (result.ok) {
          roomCode = code;
          sideA = result.yourSide;
        } else if (result.error.code !== "room_exists") {
          throw new Error(`createRoom failed: ${result.error.code}`);
        }
      }
      if (roomCode === null || sideA === null) {
        throw new Error("room_code_exhausted");
      }
      const joined = await this.env.MATCH_ROOM.getByName(roomCode).join({
        uid: b.att.uid,
        displayName: b.att.name,
      });
      if (!joined.ok) throw new Error(`join failed: ${joined.error.code}`);
      const sideB: Player = sideA === "sente" ? "gote" : "sente";

      const exp = Date.now() + ROOM_TTL_MS;
      const tokenA = await signPlayerToken(
        { roomCode, side: sideA, uid: a.att.uid, exp },
        this.env.TOKEN_SECRET,
      );
      const tokenB = await signPlayerToken(
        { roomCode, side: sideB, uid: b.att.uid, exp },
        this.env.TOKEN_SECRET,
      );

      this.purgeActiveRooms(Date.now());
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO active_rooms (room_code, created_at) VALUES (?, ?)",
        roomCode,
        Date.now(),
      );

      // Both seats are already filled server-side; if a send fails here, the
      // no-show is settled by MatchRoom's existing 60s disconnect rule, so
      // there is deliberately no recovery path (spec §4.4.1).
      this.deliverAndClose(a.ws, {
        type: "matched",
        room_code: roomCode,
        token: tokenA,
        yourSide: sideA,
        opponentName: b.att.name,
      });
      this.deliverAndClose(b.ws, {
        type: "matched",
        room_code: roomCode,
        token: tokenB,
        yourSide: sideB,
        opponentName: a.att.name,
      });
    } catch {
      // Pairing infrastructure failed: both go back to the lobby (the client
      // shows "try again" and does NOT auto-requeue — spec §4.4).
      const msg: MatchmakerServerMessage = {
        type: "error",
        error: { code: "match_failed", message: "Failed to set up the match" },
      };
      this.deliverAndClose(a.ws, msg, 1011);
      this.deliverAndClose(b.ws, msg, 1011);
    }
  }

  // ---- timeouts (alarm) ---------------------------------------------------

  async alarm(): Promise<void> {
    const now = Date.now();
    // Pair first so nobody falls to the COM fallback while a partner waits.
    await this.tryMatch(now);

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as QueueAttachment | null;
      if (!att) continue;
      if (att.matched) {
        if (now - (att.matchedAt ?? att.queuedAt) > MATCHED_STALE_MS) {
          this.deliverAndClose(
            ws,
            {
              type: "error",
              error: { code: "match_failed", message: "Failed to set up the match" },
            },
            1011,
          );
        }
        continue;
      }
      const waited = now - att.queuedAt;
      if (att.bot && waited >= BOT_FALLBACK_MS) {
        this.deliverAndClose(ws, { type: "bot" });
      } else if (!att.bot && waited >= NO_BOT_TIMEOUT_MS) {
        this.deliverAndClose(ws, {
          type: "error",
          error: { code: "queue_timeout", message: "No opponent appeared; try again later" },
        });
      }
    }

    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(now + QUEUE_TICK_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // Only ever move an existing alarm up, never later: re-arming with +5s on
  // every connect would starve the timeouts under a steady stream of joins.
  private async armAlarm(now: number): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    const current = await this.ctx.storage.getAlarm();
    const next = now + QUEUE_TICK_MS;
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  // ---- 「N人が対局中」 -----------------------------------------------------

  // RPC behind GET /api/online-stats. Purging happens here and in pairUp;
  // countPlaying itself stays read-only so a stats poll never writes storage.
  async getStats(): Promise<{ playing: number }> {
    const now = Date.now();
    this.purgeActiveRooms(now);
    return { playing: this.countPlaying(now) };
  }

  private purgeActiveRooms(now: number): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "DELETE FROM active_rooms WHERE created_at < ?",
      now - ACTIVE_ROOMS_WINDOW_MS,
    );
  }

  private countPlaying(now: number): number {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM active_rooms WHERE created_at >= ?",
        now - ACTIVE_ROOMS_WINDOW_MS,
      )
      .one();
    let waiting = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const att = ws.deserializeAttachment() as QueueAttachment | null;
      if (att && !att.matched) waiting += 1;
    }
    return row.n * 2 + waiting;
  }

  // ---- websocket plumbing -------------------------------------------------

  // Clients never speak on this socket (cancel = close; "ping" is answered by
  // the auto-responder without waking the object). Ignore anything else.
  async webSocketMessage(): Promise<void> {}

  // The queue is the socket set itself, so a close needs no bookkeeping; the
  // alarm deletes itself once the set is empty.
  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  private send(ws: WebSocket, msg: MatchmakerServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore — the socket is dying and needs no cleanup beyond closing
    }
  }

  private deliverAndClose(ws: WebSocket, msg: MatchmakerServerMessage, code = 1000): void {
    this.send(ws, msg);
    this.closeQuietly(ws, code, msg.type);
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
