// SPDX-License-Identifier: GPL-3.0-only

// Matchmaker Durable Object — a single global instance ("global") pairs players
// (longest waiter first, closest rating inside a window that widens as they
// wait, skipping the opponent they were just paired with and anyone either side
// has blocked) and wires them into a freshly created MatchRoom. The waiting queue
// IS the set of hibernatable WebSockets: each socket carries {uid, name, queuedAt,
// bot, rating, rank, avoid, key, blocked, matched, …} in its attachment, so
// hibernation/eviction cannot lose queue state. SQLite holds the "rooms recently
// created" counter behind the lobby's approximate 「N人が対局中」 display, each
// player's last opponent for an hour, and, for 3 minutes, when a disconnected
// player started waiting (so a quick requeue keeps its wait). How each wait
// ended is tallied into D1 (queue_outcome).

import { DurableObject } from "cloudflare:workers";
import { generateRoomCode } from "./room";
import { callRoom } from "./room_call";
import { blockKey, signBotTicket, signPlayerToken } from "./token";
import { ROOM_TTL_MS } from "./match_room";
import type { Env } from "./env";
import type { Player } from "./shogi_engine";
import type { MatchmakerServerMessage } from "./protocol";
import { BOT_TICKET_TTL_MS, displayRating, jstDateKey, RANKS, visibleRank } from "./rating";
import { loadPlayer } from "./rating_store";
import { normalizeDevice } from "./game_record";

// Pairing is retried on every connect and on this tick (the rating window
// widens as people wait, so a pair can form without a new arrival). A 1-second
// tick made no difference in simulation, so 5 seconds stays (spec §4.4).
const QUEUE_TICK_MS = 5_000;
// After this, clients with the COM fallback enabled (bot=1) get {type:"bot"}.
// 到達した段級位が初段以上なら2分（2026-10-18〜）。1級以下は「最長60秒」と書けることを優先して60秒のまま。
// 古い画面（v=2 を送らないタブ）は「最長60秒」と数えているので、段級位にかかわらず60秒（spec §4.4-4）
const BOT_FALLBACK_MS = 60_000;
const BOT_FALLBACK_DAN_MS = 120_000;
/** 初段の添字（rating.ts の RANKS）。到達した段級位がこれ以上なら COM まで2分 */
const SHODAN_RANK = RANKS.findIndex((rank) => rank.label === "初段");
// Fallback-off clients (bot=0) keep waiting, but not forever: after 10 minutes
// they are told to try again later so zombie sockets do not pile up.
const NO_BOT_TIMEOUT_MS = 600_000;
// 直前の相手を避けるのをやめる待ち時間（COMを切っている人だけ。isRematchAvoided）。
// COMに切り替わる秒数が段級位で変わっても、ここは60秒のまま（spec §4.4.2）
const REMATCH_GIVE_WAY_MS = 60_000;
// 接続が切れた人の並び始めた時刻を覚えておく時間。この間に並び直したら待った時間を引き継ぐ（spec §4.4-5）
const LOST_SEEKER_TTL_MS = 3 * 60 * 1000;
// ✕で取り消すときに画面が付ける close コード。これ以外の close は「接続が切れた」として扱う
const CANCEL_CLOSE_CODE = 4001;
// 「N人が対局中」 = rooms created in this window × 2 + current waiters. Room
// endings are deliberately not tracked; this is an approximation (spec §4.6).
const ACTIVE_ROOMS_WINDOW_MS = 15 * 60 * 1000;
// A matched socket is closed right after the matched message; one still around
// this much later means the DO restarted mid-pairing. Fail it out.
const MATCHED_STALE_MS = 30_000;
// 直前に組んだ相手の記録の寿命（組んだ時点から数える）。効かせたいのは終局後すぐの並び直しで、
// 同じ相手との連戦は 98% が前局の終わりから20分以内に終わっていた（2026-10 の実測）ので1時間で足りる。
// 翌日まで避ける理由は無い
const RECENT_OPPONENT_TTL_MS = 60 * 60 * 1000;
// 1人が送れるブロック一覧の上限（画面側も50人で古い順に外す。リバーシと同じ数）
const MAX_BLOCKED_KEYS = 50;
const BLOCK_KEY_RE = /^[0-9a-f]{16}$/;

// 実力値の差の許容幅 = 200 + 10×秒 + 0.1×秒²（30秒で590・1分で1160・1分半で1910。上限なし）。
// 秒は2人のうち長く待っている方の待ち秒数で、人の少ない時間帯は quietHourFactor の倍率で速く数える。
// 2026-10-17 までの「1秒に25ずつ・30秒で誰とでも」では、三段以上の46%が差500以上の相手と当たっていた。
// 対局記録5日分（10/12〜17・23,894局）で組み直した試算と、決めた理由は rating-spec §9
const MATCH_WINDOW_BASE = 200;
const MATCH_WINDOW_PER_SEC = 10;
const MATCH_WINDOW_PER_SEC_SQ = 0.1;

export function allowedRatingGap(waitedMs: number): number {
  const sec = Math.max(0, waitedMs) / 1000;
  return MATCH_WINDOW_BASE + MATCH_WINDOW_PER_SEC * sec + MATCH_WINDOW_PER_SEC_SQ * sec * sec;
}

/** 並び始めた時間帯（日本時間）。件数の集計（queue_outcome の hours）にもこの区切りを使う */
export type HourBand = "day" | "late" | "edge" | "night";

/** 🔴 サーバーは UTC で動くので +9時間して見る。23〜0時＝23:00〜0:59、2〜5時＝2:00〜5:59 */
export function hourBand(atMs: number): HourBand {
  const hour = new Date(atMs + 9 * 3600 * 1000).getUTCHours();
  if (hour >= 2 && hour <= 5) return "night";
  if (hour === 1 || hour === 6 || hour === 7) return "edge";
  if (hour === 23 || hour === 0) return "late";
  return "day";
}

// 人の少ない時間帯は、待った秒数を速く数える（他に誰も並んでいないと、近い相手を待っても来ないため）
const HOUR_FACTOR: Record<HourBand, number> = { day: 1, late: 1.3, edge: 1.6, night: 2 };

/** 待った秒数に掛ける倍率。時間帯は並び始めた時刻で決める */
export function quietHourFactor(queuedAt: number): number {
  return HOUR_FACTOR[hourBand(queuedAt)];
}

export type Seeker = {
  queuedAt: number;
  /** 実力値（表示スケール）。D1 が落ちていて分からなければ null */
  rating: number | null;
  uid?: string;
  /** 直前に組んだ相手の uid。記録が無いか1時間を過ぎていれば null */
  avoid?: string | null;
  /** false = COMへの切り替えを切っている */
  bot?: boolean;
  /** 自分のブロック用の符号（blockKey）。作れなかったときと配備前の attachment は無し */
  key?: string | null;
  /** この人がブロックした相手の符号 */
  blocked?: readonly string[];
};

/**
 * 組む2人を選び、添字で返す。`seekers` は queuedAt 昇順（長く待っている人が先頭）。
 * 長く待っている人から順に、その人の窓に入る相手のうち実力値が最も近い人を取る
 * （同じ近さなら先に並んだ方）。直前に組んだ2人（isRematchAvoided）とブロックした2人（isBlockedPair）は飛ばす。
 * 誰の窓にも相手が居なければ null。
 * 🔴 窓は**2人のうち長く待っている方**の経過時間で決める。短い方（来たばかりの人）の窓で
 *    判定すると、窓が広がった人が来たばかりの人を取れずCOMに落ちる
 *    （シミュレーションで初段以上の 7%・三段以上の 13% がCOM行きになった）。
 *    来たばかりの人は今までも先着順で即マッチしていたので、この向きなら誰も損をしない。
 * 時間帯の倍率は2人それぞれの並び始めた時刻で決め、大きい方を掛ける（それぞれの式に長く待っている方の
 * 秒数を入れて広い方を使うのと同じ）。
 * 実力値が分からない人は差 0 として扱う（誰とでも組める＝先着順に戻る）。
 */
export function choosePair(seekers: readonly Seeker[], now: number): [number, number] | null {
  for (let i = 0; i < seekers.length; i++) {
    const waited = now - seekers[i].queuedAt;
    const factor = quietHourFactor(seekers[i].queuedAt);
    let best = -1;
    let bestGap = Infinity;
    for (let j = i + 1; j < seekers.length; j++) {
      if (isRematchAvoided(seekers[i], seekers[j], now) || isBlockedPair(seekers[i], seekers[j])) continue;
      const gap = ratingGap(seekers[i].rating, seekers[j].rating);
      if (gap >= bestGap) continue;
      const window = allowedRatingGap(waited * Math.max(factor, quietHourFactor(seekers[j].queuedAt)));
      if (gap > window) continue;
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

/**
 * 直前に組んだ2人を続けて組まない。どちらか一方の記録で足りる（片方が別の人と指した後でも、
 * もう片方の直前の相手がこの人なら避ける）。終局した2人が同時に「もう一度対戦する」で並び直し、
 * 他に誰も居ないとそのまままた組まれていた（2026-10 の実測で対人戦の 11.5%、深夜0〜4時は 26〜40%）。
 * 他に誰も来なければ、いつもどおり60秒でCOMに切り替わる。
 * ただしCOMへの切り替えを切っている人が、その60秒を過ぎて待っているなら避けない。行き先が無いので、
 * 避け続けると他の人が来るまで（10分の打ち切りまで）待たせることになる。
 */
export function isRematchAvoided(a: Seeker, b: Seeker, now: number): boolean {
  if (waitedPastBotFallback(a, now) || waitedPastBotFallback(b, now)) return false;
  return (a.avoid != null && a.avoid === b.uid) || (b.avoid != null && b.avoid === a.uid);
}

/**
 * どちらか一方が相手をブロックしていれば組まない（ブロックされた側から見ても同じ）。
 * 直前の相手と違って、COMを切っている人が長く待っていても譲らない（行き先が無ければ10分で打ち切り）。
 * 一覧を送らない古い画面の人も、ブロックされた側としては避けられる（符号はサーバーが作るため）
 */
export function isBlockedPair(a: Seeker, b: Seeker): boolean {
  return (a.key != null && b.blocked?.includes(a.key) === true) || (b.key != null && a.blocked?.includes(b.key) === true);
}

/** 画面が送ってきたブロック一覧（カンマ区切り）。16桁の16進だけを残し、重複を除いて50件で切る */
export function parseBlockKeys(raw: string | null): string[] {
  if (!raw) return [];
  const keys = new Set<string>();
  for (const part of raw.split(",", MAX_BLOCKED_KEYS * 2)) {
    if (BLOCK_KEY_RE.test(part)) keys.add(part);
    if (keys.size >= MAX_BLOCKED_KEYS) break;
  }
  return [...keys];
}

function waitedPastBotFallback(s: Seeker, now: number): boolean {
  return s.bot === false && now - s.queuedAt >= REMATCH_GIVE_WAY_MS;
}

/**
 * COMに切り替わるまでの時間（ms）。切り替えない人（bot=0）は null。
 * 到達した段級位が初段以上なら2分、1級以下・分からない人（D1 が落ちていた）・古い画面は60秒。
 */
export function botFallbackMs(bot: boolean, modern: boolean, reachedRank: number | null): number | null {
  if (!bot) return null;
  return modern && reachedRank !== null && reachedRank >= SHODAN_RANK ? BOT_FALLBACK_DAN_MS : BOT_FALLBACK_MS;
}

// ---- 並んだ結果の件数（D1 の queue_outcome。spec §4.9） ------------------------

export type OutcomeResult =
  | "matched" // 組めた
  | "bot" // COMに移った
  | "cancel" // ✕で取り消した（close 4001）
  | "closed" // ページを閉じた（close 1001）。3分たっても並び直さなかった
  | "dropped" // 接続が切れた（それ以外の close）。3分たっても並び直さなかった
  | "requeued" // 3分以内に並び直した・古い接続が置き換えられた（次の1回が通算の秒数で数えられる）
  | "timeout" // 10分で打ち切り
  | "error"; // 組む途中で失敗した（match_failed）

export type Outcome = { day: string; band: string; hours: HourBand; waitFrom: number; result: OutcomeResult };

/** 実力値の帯。rating-spec §9 の試算と同じ4区分（境目は RANKS の初段・三段・六段の下限） */
export function ratingBand(rating: number | null | undefined): string {
  if (typeof rating !== "number") return "unknown";
  if (rating >= 2750) return "dan6";
  if (rating >= 2300) return "dan3";
  if (rating >= 2000) return "dan1";
  return "kyu";
}

/** 待った秒数の区分の下端。2分までは5秒刻み、10分までは1分刻み、600 は10分以上 */
export function waitBucketFrom(waitedMs: number): number {
  const sec = Math.max(0, Math.floor(waitedMs / 1000));
  if (sec >= 600) return 600;
  if (sec >= 120) return Math.floor(sec / 60) * 60;
  return Math.floor(sec / 5) * 5;
}

/** 並んだ1回の結果を、件数の表の1行の鍵にする。日付と時間帯は並び始めた時刻（引き継いだ人は最初の時刻）で決める */
export function outcomeOf(
  queuedAt: number,
  rating: number | null | undefined,
  endedAt: number,
  result: OutcomeResult,
): Outcome {
  return {
    day: jstDateKey(queuedAt),
    band: ratingBand(rating),
    hours: hourBand(queuedAt),
    waitFrom: waitBucketFrom(endedAt - queuedAt),
    result,
  };
}

/** lost_seeker に残した切れ方。読めない値は「切れた」に寄せる */
function lostKind(kind: string): OutcomeResult {
  return kind === "closed" ? "closed" : "dropped";
}

type QueueAttachment = {
  uid: string;
  name: string | null;
  queuedAt: number; // epoch ms。3分以内の並び直しなら前の接続の値を引き継いでいる
  bot: boolean; // false = the client opted out of the COM fallback
  /** COMに切り替わるまでの時間（ms）。切り替えない人は null。配備前の attachment には無い（bot なら60秒として扱う） */
  botAfterMs?: number | null;
  /** 実力値（表示スケール）。組み合わせの判定にだけ使う。D1 が落ちていたら null */
  rating: number | null;
  /** 相手に見せる段級位。段級位を出さない設定の人と、D1 が落ちていたときは null */
  rank: number | null;
  /**
   * 到達した段級位（下がらない方）。段級位を出さない設定の人も本当の値を持つ。
   * COMまでの秒数を決めるのにだけ使い、相手にも MatchRoom にも渡さない。D1 が落ちていたら null
   */
  reachedRank?: number | null;
  /** 直前に組んだ相手の uid（並んだ時点で1回引く）。配備前に並んだ古い attachment には無い */
  avoid?: string | null;
  /** 自分のブロック用の符号（並んだ時点で作る）。組んだ相手に opponentKey として渡す。作れなかったら null */
  key?: string | null;
  /** この人がブロックした相手の符号（画面が並ぶたびに送る）。配備前の attachment には無い */
  blocked?: string[];
  /** 端末の種類（対局記録用。game_record.ts）。Worker が決めて渡す。配備前の attachment には無い */
  device?: string | null;
  matched: boolean; // claimed by a pairing already in flight
  matchedAt?: number;
  /**
   * サーバーがこの1回を終わらせて数えた（COM・打ち切り・置き換え・失敗）。close の通知で二重に数えず、組む相手にもしない。
   * 組まれた1回は matched のほうで見分ける
   */
  ended?: boolean;
};

type Waiting = { ws: WebSocket; att: QueueAttachment };

type LostRow = { queued_at: number; lost_at: number; rating: number | null; kind: string };

const OUTCOME_UPSERT =
  "INSERT INTO queue_outcome (day, band, hours, wait_from, result, n) VALUES (?1, ?2, ?3, ?4, ?5, 1) " +
  "ON CONFLICT (day, band, hours, wait_from, result) DO UPDATE SET n = n + 1";

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
    // 1人1行。組んだ時点で2人ぶん上書きする（at = 組んだ時刻）
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recent_opponent (
        uid TEXT PRIMARY KEY,
        opponent TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);
    // 接続が切れた人の並び始めた時刻（1人1行・3分で数えて消す）。rating と kind は件数の集計用
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS lost_seeker (
        uid TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL,
        lost_at INTEGER NOT NULL,
        rating INTEGER,
        kind TEXT NOT NULL
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
    // v=2 の画面（2026-10-18〜）。付いていない古い画面は「最長60秒」と数えているので、COMまでを60秒のまま扱う
    const modern = request.headers.get("x-mm-v") === "2";
    const device = normalizeDevice(request.headers.get("x-mm-device"));
    const blocked = parseBlockKeys(request.headers.get("x-mm-bl"));
    const now = Date.now();
    const outcomes: Outcome[] = [];

    // One seat per uid: a reconnect (reopened tab) keeps the newer socket, so
    // a stale tab can never wedge the queue. Never match a uid with itself.
    // 古い接続がまだ並んでいれば（電波が途切れて閉じ終わっていないときなど）、並び始めた時刻を引き継ぐ。
    // 置き換えた1回は「並び直した」と数え、切れた人としては覚えない（spec §4.4-5・§4.9）
    let inheritedAt: number | null = null;
    for (const ws of this.ctx.getWebSockets(uid)) {
      const old = ws.deserializeAttachment() as QueueAttachment | null;
      if (old && !old.matched && !old.ended) {
        inheritedAt = Math.min(inheritedAt ?? old.queuedAt, old.queuedAt);
        old.ended = true;
        ws.serializeAttachment(old);
        outcomes.push(outcomeOf(old.queuedAt, old.rating, now, "requeued"));
      }
      this.closeQuietly(ws, 4000, "superseded");
    }
    // 3分以内に切れていた人は、そのときの並び始めた時刻を引き継ぐ。端末からの申告は使わない
    const lostAt = this.takeLostSeeker(uid, now, outcomes);
    if (lostAt !== null) inheritedAt = Math.min(inheritedAt ?? lostAt, lostAt);
    this.sweepLostSeekers(now, outcomes);

    // 実力値は並んだ時点で1回だけ引く（以前は成立時に2人まとめて1文。並ぶ人ごとに1文になるので
    // クエリ本数は倍・成立しなかった人のぶんは純増だが、1日数千文の規模で些少）。
    // 🔴 acceptWebSocket より前に await する。受け付けてから D1 を待つと、その間に
    //    別の接続や alarm の tryMatch がこのソケットを「実力値不明」のまま組んでしまう。
    //    ブロック用の符号も同じ理由で先に作る（後で作ると、その間に組まれた相手のブロックが効かない）。
    const [{ rating, rank, reachedRank }, key] = await Promise.all([
      this.loadSeeker(uid, hideRank),
      blockKey(uid, this.env.TOKEN_SECRET).catch(() => null),
    ]);
    const avoid = this.recentOpponent(uid, now);
    const queuedAt = inheritedAt ?? now;
    const botAfterMs = botFallbackMs(bot, modern, reachedRank);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [uid]);
    const att: QueueAttachment = {
      uid,
      name,
      queuedAt,
      bot,
      botAfterMs,
      rating,
      rank,
      reachedRank,
      avoid,
      key,
      blocked,
      device,
      matched: false,
    };
    server.serializeAttachment(att);

    // COMまでの秒数と、引き継いだ分を含む待った時間を画面に伝える（画面は端末の控えで先に出してから、これで直す）
    this.send(server, {
      type: "queued",
      playing: this.countPlaying(now),
      botAfter: botAfterMs === null ? null : botAfterMs / 1000,
      waitedMs: now - queuedAt,
    });
    this.recordOutcomes(outcomes);

    await this.tryMatch(now);
    await this.armAlarm(now);
    await this.flushOutcomes();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 並ぶ人の実力値と、相手に見せる段級位と、到達した段級位。D1 が落ちていても並べる
   * （実力値不明＝誰とでも組める、バッジは出ない、COMまでは60秒）。
   * 段級位を出さない設定の人は、ここで相手に見せる段級位を null にする。この1か所で
   * 「相手の matched に渡さない」と「MatchRoom に預けない」の両方が済む。
   * 到達した段級位（reachedRank）は隠していても本当の値を返す（COMまでの秒数にだけ使う）。
   * 🔴 実力値そのものは D1 側で普通に動く（終局時に MatchRoom が改めて引く）
   */
  private async loadSeeker(
    uid: string,
    hideRank: boolean,
  ): Promise<{ rating: number | null; rank: number | null; reachedRank: number | null }> {
    try {
      const player = await loadPlayer(this.env.DB, uid);
      const reachedRank = visibleRank(player.rating, player.bestRank);
      return {
        rating: displayRating(player.rating),
        rank: hideRank ? null : reachedRank,
        reachedRank,
      };
    } catch {
      return { rating: null, rank: null, reachedRank: null };
    }
  }

  // ---- 接続が切れた人の並び始めた時刻（spec §4.4-5） ------------------------------

  /** 切れた接続を3分だけ覚える。覚えられなければ、その場で切れたときの結果として数える */
  private rememberLostSeeker(att: QueueAttachment, kind: "closed" | "dropped", now: number): void {
    try {
      this.ensureSchema();
      // 同じ人の行が残っていれば（ふつうは並び直しで消えている）、先に数えてから置き換える
      const outcomes: Outcome[] = [];
      this.takeLostSeeker(att.uid, now, outcomes);
      this.recordOutcomes(outcomes);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO lost_seeker (uid, queued_at, lost_at, rating, kind) VALUES (?, ?, ?, ?, ?)",
        att.uid,
        att.queuedAt,
        now,
        att.rating,
        kind,
      );
    } catch {
      this.recordOutcomes([outcomeOf(att.queuedAt, att.rating, now, kind)]);
    }
  }

  /**
   * 3分以内に切れた同じ人の並び始めた時刻（無ければ null）。行は消し、前の1回を「並び直した」
   * （3分を過ぎていたら切れたときの結果）として outcomes に足す
   */
  private takeLostSeeker(uid: string, now: number, outcomes: Outcome[]): number | null {
    try {
      this.ensureSchema();
      const rows = this.ctx.storage.sql
        .exec<LostRow>("SELECT queued_at, lost_at, rating, kind FROM lost_seeker WHERE uid = ?", uid)
        .toArray();
      if (rows.length === 0) return null;
      this.ctx.storage.sql.exec("DELETE FROM lost_seeker WHERE uid = ?", uid);
      const row = rows[0];
      const fresh = row.lost_at >= now - LOST_SEEKER_TTL_MS;
      outcomes.push(outcomeOf(row.queued_at, row.rating, row.lost_at, fresh ? "requeued" : lostKind(row.kind)));
      return fresh ? row.queued_at : null;
    } catch {
      return null; // 読めなければ引き継がないだけ
    }
  }

  /** 3分たっても並び直さなかった人を、切れたときの結果として数えて消す */
  private sweepLostSeekers(now: number, outcomes: Outcome[]): void {
    try {
      this.ensureSchema();
      const cutoff = now - LOST_SEEKER_TTL_MS;
      const rows = this.ctx.storage.sql
        .exec<LostRow>("SELECT queued_at, lost_at, rating, kind FROM lost_seeker WHERE lost_at < ?", cutoff)
        .toArray();
      if (rows.length === 0) return;
      this.ctx.storage.sql.exec("DELETE FROM lost_seeker WHERE lost_at < ?", cutoff);
      for (const row of rows) outcomes.push(outcomeOf(row.queued_at, row.rating, row.lost_at, lostKind(row.kind)));
    } catch {
      // 次の機会に数える
    }
  }

  /** いちばん早く3分を迎える切れた人の期限。だれも覚えていなければ null */
  private nextLostExpiry(): number | null {
    try {
      this.ensureSchema();
      const row = this.ctx.storage.sql
        .exec<{ at: number | null }>("SELECT MIN(lost_at) AS at FROM lost_seeker")
        .one();
      return typeof row.at === "number" ? row.at + LOST_SEEKER_TTL_MS : null;
    } catch {
      return null;
    }
  }

  // 件数は溜めておき、fetch・alarm・close の各処理の最後に flushOutcomes でまとめて D1 に書く。
  // 🔴 ctx.waitUntil で投げっぱなしにしない。compatibility_date が 2026-10-01 より前だと、処理が終わった時点で
  //    書き込みが打ち切られることがある（テストの workerd で実際に打ち切られた）
  private pendingOutcomes: Outcome[] = [];

  private recordOutcomes(outcomes: Outcome[]): void {
    this.pendingOutcomes.push(...outcomes);
  }

  /** 溜めた件数を書く。失敗しても並ぶこと・組むことは止めない（数えないだけ） */
  private async flushOutcomes(): Promise<void> {
    if (this.pendingOutcomes.length === 0) return;
    const outcomes = this.pendingOutcomes;
    this.pendingOutcomes = [];
    try {
      const db = this.env.DB;
      await db.batch(
        outcomes.map((o) => db.prepare(OUTCOME_UPSERT).bind(o.day, o.band, o.hours, o.waitFrom, o.result)),
      );
    } catch {
      // ignore
    }
  }

  /** 直前に組んだ相手の uid。読めなくても並ぶのは止めない（避けないだけ） */
  private recentOpponent(uid: string, now: number): string | null {
    try {
      this.ensureSchema();
      const rows = this.ctx.storage.sql
        .exec<{ opponent: string }>(
          "SELECT opponent FROM recent_opponent WHERE uid = ? AND at >= ?",
          uid,
          now - RECENT_OPPONENT_TTL_MS,
        )
        .toArray();
      return rows.length > 0 ? rows[0].opponent : null;
    } catch {
      return null;
    }
  }

  /** 組んだ2人それぞれに、相手を直前の相手として残す。古い記録の掃除もここで行う */
  private rememberOpponents(uidA: string, uidB: string, now: number): void {
    try {
      this.ensureSchema();
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM recent_opponent WHERE at < ?", now - RECENT_OPPONENT_TTL_MS);
      sql.exec(
        "INSERT OR REPLACE INTO recent_opponent (uid, opponent, at) VALUES (?, ?, ?), (?, ?, ?)",
        uidA,
        uidB,
        now,
        uidB,
        uidA,
        now,
      );
    } catch {
      // 対局はもう始まっている。次に並んだとき避けないだけ
    }
  }

  // ---- pairing -----------------------------------------------------------

  private waitingSockets(): Waiting[] {
    const byUid = new Map<string, Waiting>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1 /* OPEN — closing sockets linger in the list */) continue;
      const att = ws.deserializeAttachment() as QueueAttachment | null;
      if (!att || att.matched || att.ended) continue;
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
        const result = await callRoom(this.env.MATCH_ROOM, code, "createRoom", (room) =>
          room.createRoom({
            roomCode: code,
            uid: a.att.uid,
            displayName: a.att.name,
            sidePref: "random", // seat assignment stays MatchRoom's job (spec §4.4)
            tcType: "per_move",
            tcSeconds: 30,
            matchType: "matchmaking",
            bestRank: rankA,
            device: a.att.device ?? null,
          }),
        );
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
      // 部屋づくりに手間取っている間に alarm が2人を「組めなかった」で帰していたら、席に着かせない。
      // 着かせると誰も来ない対局の時計が動き、先手が時間切れ負けで実力値が動く（帰した側で集計も済んでいる）
      const ended = (w: Waiting) => (w.ws.deserializeAttachment() as QueueAttachment | null)?.ended === true;
      if (ended(a) || ended(b)) return;
      const joined = await callRoom(this.env.MATCH_ROOM, roomCode, "join", (room) =>
        room.join({
          uid: b.att.uid,
          displayName: b.att.name,
          bestRank: rankB,
          device: b.att.device ?? null,
        }),
      );
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
        opponentKey: b.att.key ?? null,
      });
      this.deliverAndClose(b.ws, {
        type: "matched",
        room_code: roomCode,
        token: tokenB,
        yourSide: sideB,
        opponentName: a.att.name,
        opponentRank: rankA,
        opponentKey: a.att.key ?? null,
      });
      const pairedAt = Date.now();
      this.rememberOpponents(a.att.uid, b.att.uid, pairedAt);
      this.recordOutcomes([
        outcomeOf(a.att.queuedAt, a.att.rating, pairedAt, "matched"),
        outcomeOf(b.att.queuedAt, b.att.rating, pairedAt, "matched"),
      ]);
    } catch (e) {
      // 理由はログにだけ残す（やり直しの10秒の閾値を見直す材料）
      console.warn("match setup failed:", String(e));
      // Pairing infrastructure failed: both go back to the lobby (the client
      // shows "try again" and does NOT auto-requeue — spec §4.4).
      const msg: MatchmakerServerMessage = {
        type: "error",
        error: { code: "match_failed", message: "Failed to set up the match" },
      };
      this.deliverAndClose(a.ws, msg, 1011);
      this.deliverAndClose(b.ws, msg, 1011);
      const failedAt = Date.now();
      this.recordOutcomes([
        outcomeOf(a.att.queuedAt, a.att.rating, failedAt, "error"),
        outcomeOf(b.att.queuedAt, b.att.rating, failedAt, "error"),
      ]);
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

    const outcomes: Outcome[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as QueueAttachment | null;
      if (!att || att.ended) continue;
      if (att.matched) {
        // 組む途中で DO が止まった名残だけを片付ける（その接続は開いたまま）。組めて閉じた接続は、相手が閉じ返さないと
        // CLOSING のまま一覧に残るので、開いているものだけを見る（見ないと、組めた1回を「失敗」としても数えてしまう）
        if (ws.readyState === 1 && now - (att.matchedAt ?? att.queuedAt) > MATCHED_STALE_MS) {
          this.endEntry(ws, att);
          outcomes.push(outcomeOf(att.queuedAt, att.rating, now, "error"));
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
      // 配備前の attachment には botAfterMs が無い。そのときは従来どおり bot なら60秒
      const botAfter = att.botAfterMs !== undefined ? att.botAfterMs : att.bot ? BOT_FALLBACK_MS : null;
      if (botAfter !== null && waited >= botAfter) {
        // 🔴 券を作る await の前に終わった印を付ける（その間に別の接続の tryMatch がこの人を組まないように）
        this.endEntry(ws, att);
        outcomes.push(outcomeOf(att.queuedAt, att.rating, now, "bot"));
        this.deliverAndClose(ws, {
          type: "bot",
          ticket: await this.issueBotTicket(att.uid, now),
        });
      } else if (botAfter === null && waited >= NO_BOT_TIMEOUT_MS) {
        this.endEntry(ws, att);
        outcomes.push(outcomeOf(att.queuedAt, att.rating, now, "timeout"));
        this.deliverAndClose(ws, {
          type: "error",
          error: { code: "queue_timeout", message: "No opponent appeared; try again later" },
        });
      }
    }
    this.sweepLostSeekers(now, outcomes);
    this.recordOutcomes(outcomes);
    await this.flushOutcomes();

    const next = this.nextAlarmAt(now);
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** 並んでいる人がいれば5秒後、いなくても切れた人を覚えていれば、その3分の期限に起きる */
  private nextAlarmAt(now: number): number | null {
    if (this.ctx.getWebSockets().length > 0) return now + QUEUE_TICK_MS;
    return this.nextLostExpiry();
  }

  // Only ever move an existing alarm up, never later: re-arming with +5s on
  // every connect would starve the timeouts under a steady stream of joins.
  private async armAlarm(now: number): Promise<void> {
    const next = this.nextAlarmAt(now);
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** サーバーがこの1回を終わらせる印。close の通知で二重に数えず、組む相手にもしない */
  private endEntry(ws: WebSocket, att: QueueAttachment): void {
    att.ended = true;
    ws.serializeAttachment(att);
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
      if (att && !att.matched && !att.ended) waiting += 1;
    }
    return row.n * 2 + waiting;
  }

  // ---- websocket plumbing -------------------------------------------------

  // Clients never speak on this socket (cancel = close; "ping" is answered by
  // the auto-responder without waking the object). Ignore anything else.
  async webSocketMessage(): Promise<void> {}

  // The queue is the socket set itself, so a close needs no queue bookkeeping.
  // What it does need: tallying how the wait ended, and remembering when a
  // dropped player started waiting so a quick requeue keeps its wait.
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 閉じる手続きを返しておく（2026-04-07 以降の互換日付なら自動で返るので念のため。テストの workerd は古い互換日付で動く）。
    // 1005/1006 は送れない番号なので 1000 で返す
    this.closeQuietly(ws, code === 1000 || code === 1001 || code >= 3000 ? code : 1000, "closed");
    await this.onSocketGone(ws, code);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws, 1006);
  }

  // 同じ接続に error と close の両方が届くことがあるので、一度見たものは飛ばす（眠ると消えるが、2つは続けて届く）
  private readonly goneSockets = new WeakSet<WebSocket>();

  private async onSocketGone(ws: WebSocket, code: number): Promise<void> {
    if (this.goneSockets.has(ws)) return;
    this.goneSockets.add(ws);
    const att = ws.deserializeAttachment() as QueueAttachment | null;
    // 組まれた・COMに移った・打ち切った・置き換えた1回は、サーバーがもう数えている
    if (!att || att.matched || att.ended) return;
    const now = Date.now();
    if (code === CANCEL_CLOSE_CODE) {
      // ✕で取り消した。待った時間は覚えない
      this.recordOutcomes([outcomeOf(att.queuedAt, att.rating, now, "cancel")]);
    } else {
      // 🟡 1001（ページを閉じた）を送らずに切れるブラウザもあるので、closed と dropped の区別は確実ではない
      this.rememberLostSeeker(att, code === 1001 ? "closed" : "dropped", now);
      await this.armAlarm(now);
    }
    await this.flushOutcomes();
  }

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
