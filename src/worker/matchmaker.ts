// SPDX-License-Identifier: GPL-3.0-only

// Matchmaker Durable Object — a single global instance ("global") pairs players
// (longest waiter first, closest rating inside a window that widens as they
// wait) and wires them into a freshly created MatchRoom. The waiting queue IS
// the set of hibernatable WebSockets: each socket carries {uid, name, queuedAt,
// bot, rating, rank, matched} in its attachment, so hibernation/eviction cannot
// lose queue state. SQLite holds only the "rooms recently created" counter
// behind the lobby's approximate 「N人が対局中」 display.

import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "./room";
import { signBotTicket, signPlayerToken } from "./token";
import { ROOM_TTL_MS } from "./match_room";
import type { Env } from "./env";
import type { Player } from "./shogi_engine";
import type { MatchmakerServerMessage } from "./protocol";
import { BOT_TICKET_TTL_MS, displayRating, visibleRank } from "./rating";
import { loadPlayer } from "./rating_store";

// Pairing is retried on every connect and on this tick (the rating window
// widens as people wait, so a pair can form without a new arrival). A 1-second
// tick made no difference in simulation, so 5 seconds stays (spec §4.4).
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

// 実力値の差の許容幅。並んだ直後は 200、1秒ごとに 25 広がり、30秒で無制限になる。
// 本番データ（2026-09-03〜06・6,126局）のシミュレーションでは、全員の平均待ちが
// 3.8秒→7.4秒、初段以上の人が差500以上の相手と当たる割合が 61%→44%（rating-spec §9）。
// 細かい階段にしても結果は同じだったので式にしてある。効くのは「広がる速さ」と
// 「無制限になる秒数」の2つだけ。
const MATCH_WINDOW_BASE = 200;
const MATCH_WINDOW_PER_SEC = 25;
const MATCH_WINDOW_UNLIMITED_MS = 30_000;

export function allowedRatingGap(waitedMs: number): number {
  if (waitedMs >= MATCH_WINDOW_UNLIMITED_MS) return Infinity;
  return MATCH_WINDOW_BASE + (MATCH_WINDOW_PER_SEC * Math.max(0, waitedMs)) / 1000;
}

export type Seeker = {
  queuedAt: number;
  /** 実力値（表示スケール）。D1 が落ちていて分からなければ null */
  rating: number | null;
};

/**
 * 組む2人を選び、添字で返す。`seekers` は queuedAt 昇順（長く待っている人が先頭）。
 * 長く待っている人から順に、その人の窓に入る相手のうち実力値が最も近い人を取る
 * （同じ近さなら先に並んだ方）。誰の窓にも相手が居なければ null。
 * 🔴 窓は**2人のうち長く待っている方**の経過時間で決める。短い方（来たばかりの人）の窓で
 *    判定すると、窓が無制限になった人が来たばかりの人を取れず 60秒でCOMに落ちる
 *    （シミュレーションで初段以上の 7%・三段以上の 13% がCOM行きになった）。
 *    来たばかりの人は今までも先着順で即マッチしていたので、この向きなら誰も損をしない。
 * 実力値が分からない人は差 0 として扱う（誰とでも組める＝先着順に戻る）。
 */
export function choosePair(seekers: readonly Seeker[], now: number): [number, number] | null {
  for (let i = 0; i < seekers.length; i++) {
    const window = allowedRatingGap(now - seekers[i].queuedAt);
    let best = -1;
    let bestGap = Infinity;
    for (let j = i + 1; j < seekers.length; j++) {
      const gap = ratingGap(seekers[i].rating, seekers[j].rating);
      if (gap > window || gap >= bestGap) continue;
      bestGap = gap;
      best = j;
    }
    if (best >= 0) return [i, best];
  }
  return null;
}

function ratingGap(a: number | null | undefined, b: number | null | undefined): number {
  if (typeof a !== "number" || typeof b !== "number") return 0;
  return Math.abs(a - b);
}

type QueueAttachment = {
  uid: string;
  name: string | null;
  queuedAt: number; // epoch ms
  bot: boolean; // false = the client opted out of the COM fallback
  /** 実力値（表示スケール）。組み合わせの判定にだけ使う。D1 が落ちていたら null */
  rating: number | null;
  /** 相手に見せる段級位。段級位を出さない設定の人と、D1 が落ちていたときは null */
  rank: number | null;
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
    const hideRank = request.headers.get("x-mm-hr") === "1";
    const now = Date.now();

    // One seat per uid: a reconnect (reopened tab) keeps the newer socket, so
    // a stale tab can never wedge the queue. Never match a uid with itself.
    for (const ws of this.ctx.getWebSockets(uid)) {
      this.closeQuietly(ws, 4000, "superseded");
    }

    // 実力値は並んだ時点で1回だけ引く（以前は成立時に2人まとめて1文。並ぶ人ごとに1文になるので
    // クエリ本数は倍・成立しなかった人のぶんは純増だが、1日数千文の規模で些少）。
    // 🔴 acceptWebSocket より前に await する。受け付けてから D1 を待つと、その間に
    //    別の接続や alarm の tryMatch がこのソケットを「実力値不明」のまま組んでしまう。
    const { rating, rank } = await this.loadSeeker(uid, hideRank);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [uid]);
    const att: QueueAttachment = { uid, name, queuedAt: now, bot, rating, rank, matched: false };
    server.serializeAttachment(att);

    this.send(server, { type: "queued", playing: this.countPlaying(now) });

    await this.tryMatch(now);
    await this.armAlarm(now);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 並ぶ人の実力値と、相手に見せる段級位。D1 が落ちていても並べる
   * （実力値不明＝誰とでも組める、バッジは出ない）。
   * 段級位を出さない設定の人は、ここで段級位を null にする。この1か所で
   * 「相手の matched に渡さない」と「MatchRoom に預けない」の両方が済む。
   * 🔴 実力値そのものは D1 側で普通に動く（終局時に MatchRoom が改めて引く）
   */
  private async loadSeeker(
    uid: string,
    hideRank: boolean,
  ): Promise<{ rating: number | null; rank: number | null }> {
    try {
      const player = await loadPlayer(this.env.DB, uid);
      return {
        rating: displayRating(player.rating),
        rank: hideRank ? null : visibleRank(player.rating, player.bestRank),
      };
    } catch {
      return { rating: null, rank: null };
    }
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

  // Pair until nobody's window contains a partner. The matched claim is
  // committed to both attachments synchronously BEFORE the first await: the DO
  // input gate opens during the MatchRoom RPCs, so a concurrent connect or
  // alarm must never see these two sockets as available.
  private async tryMatch(now: number): Promise<void> {
    for (;;) {
      const waiting = this.waitingSockets();
      const picked = choosePair(
        waiting.map((w) => w.att),
        now,
      );
      if (!picked) return;
      const a = waiting[picked[0]];
      const b = waiting[picked[1]];
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
      // 段級位は並んだ時点で引いてある（loadSeeker）。対局結果の段位カードが使うので
      // MatchRoom に預ける（再接続しても残る）。`?? null` は配備前に並んだ古い attachment 用
      const rankA = a.att.rank ?? null;
      const rankB = b.att.rank ?? null;

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
          bestRank: rankA,
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
        bestRank: rankB,
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
        opponentRank: rankB,
      });
      this.deliverAndClose(b.ws, {
        type: "matched",
        room_code: roomCode,
        token: tokenB,
        yourSide: sideB,
        opponentName: a.att.name,
        opponentRank: rankA,
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

  /**
   * COM戦の引換券。**60秒待ってCOMに切り替わる瞬間にしか出さない**。
   * キューに並んだ時点で配ると「並んですぐ抜ける」を繰り返して無限に取れてしまうので、
   * 発行の位置そのものが「1人あたり60秒に1枚」という上限になっている。
   * 消費は POST /api/bot-result 側（jti を D1 の主キーとして1回だけ使う）。
   */
  private async issueBotTicket(uid: string, now: number): Promise<string | null> {
    try {
      return await signBotTicket(
        { jti: crypto.randomUUID(), uid, exp: now + BOT_TICKET_TTL_MS },
        this.env.TOKEN_SECRET,
      );
    } catch {
      // 券が出せなくてもCOM戦そのものは始められる（実力値が付かないだけ）
      return null;
    }
  }

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
        this.deliverAndClose(ws, {
          type: "bot",
          ticket: await this.issueBotTicket(att.uid, now),
        });
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
