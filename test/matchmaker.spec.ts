// SPDX-License-Identifier: GPL-3.0-only

// Matchmaker DO integration tests: rating-window pairing into a playable MatchRoom,
// same-uid dedupe, cancellation, the 60s bot fallback / 10min opt-out timeout,
// the lobby counter, and rate limiting. Timeouts are exercised by rewriting
// queuedAt inside the socket attachments and firing the alarm directly —
// fake timers cannot advance the runtime's alarm scheduler.

import {
  env,
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import type { MatchRoom } from "../src/worker/match_room";
import { blockKey, verifyBotTicket, verifyPlayerToken } from "../src/worker/token";
import { internalFromDisplay, RANKS, rankOf, START_RANK } from "../src/worker/rating";
import {
  allowedRatingGap,
  botFallbackMs,
  choosePair,
  hourBand,
  isBlockedPair,
  isRematchAvoided,
  outcomeOf,
  parseBlockKeys,
  quietHourFactor,
  ratingBand,
  waitBucketFrom,
} from "../src/worker/matchmaker";
import type { MatchPayload } from "../src/worker/protocol";

const UID_1 = "aaaaaaaa-1111-4111-8111-111111111111";
const UID_2 = "bbbbbbbb-2222-4222-8222-222222222222";
const UID_3 = "cccccccc-3333-4333-8333-333333333333";

// Each connection gets its own IP so tests never trip the per-IP rate limit.
let nextQueueIp = 1;
function testIp(): string {
  nextQueueIp += 1;
  return `10.8.${Math.floor(nextQueueIp / 256)}.${nextQueueIp % 256}`;
}

type QueueMsg = {
  type: string;
  playing?: number;
  botAfter?: number | null;
  waitedMs?: number;
  room_code?: string;
  token?: string;
  yourSide?: "sente" | "gote";
  opponentName?: string | null;
  opponentRank?: number | null;
  opponentKey?: string | null;
  ticket?: string | null;
  error?: { code: string; message: string };
};

async function connectQueue(
  uid: string,
  opts: { name?: string; bot?: 0 | 1; hr?: 0 | 1; v?: 2; bl?: string; ip?: string } = {},
) {
  const params = new URLSearchParams({ uid });
  if (opts.name !== undefined) params.set("name", opts.name);
  if (opts.bot !== undefined) params.set("bot", String(opts.bot));
  if (opts.hr !== undefined) params.set("hr", String(opts.hr));
  if (opts.v !== undefined) params.set("v", String(opts.v));
  if (opts.bl !== undefined) params.set("bl", opts.bl);
  const res = await SELF.fetch(`https://example.com/api/match/ws?${params}`, {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": opts.ip ?? testIp() },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: QueueMsg[] = [];
  let closed = false;
  let closeCode: number | null = null;
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string" && event.data !== "pong") {
      messages.push(JSON.parse(event.data) as QueueMsg);
    }
  });
  ws.addEventListener("close", (event) => {
    closed = true;
    closeCode = event.code;
  });
  return {
    ws,
    messages,
    isClosed: () => closed,
    closeCode: () => closeCode,
    find: (type: string) => messages.find((m) => m.type === type),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// Rewrites every queue attachment so its wait time appears to be `waitedMs`.
async function ageQueue(waitedMs: number): Promise<void> {
  const stub = env.MATCHMAKER.getByName("global");
  await runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown>;
      ws.serializeAttachment({ ...att, queuedAt: Date.now() - waitedMs });
    }
  });
}

async function fireAlarm(): Promise<boolean> {
  return runDurableObjectAlarm(env.MATCHMAKER.getByName("global"));
}

async function fetchStats(): Promise<number> {
  const res = await SELF.fetch("https://example.com/api/online-stats");
  expect(res.status).toBe(200);
  const json = (await res.json()) as { playing: number };
  return json.playing;
}

describe("queue entry validation", () => {
  it("rejects a plain GET and an invalid uid", async () => {
    const plain = await SELF.fetch("https://example.com/api/match/ws?uid=" + UID_1);
    expect(plain.status).toBe(400);
    const badUid = await SELF.fetch("https://example.com/api/match/ws?uid=x", {
      headers: { Upgrade: "websocket" },
    });
    expect(badUid.status).toBe(400);
  });

  it("limits queue joins per IP (delivered as a WS error message)", async () => {
    // HTTP 429 は new WebSocket() から見ると接続失敗(1006)にしかならないので、
    // 上限超過は 101 で受けてから {type:"error", code:"rate_limited"} を送って閉じる
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const res = await SELF.fetch(`https://example.com/api/match/ws?uid=${UID_1}`, {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": "203.0.113.9" },
      });
      expect(res.status).toBe(101);
      const ws = res.webSocket!;
      const messages: QueueMsg[] = [];
      ws.accept();
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") messages.push(JSON.parse(event.data) as QueueMsg);
      });
      await waitFor(() => messages.length >= 1);
      if (messages.some((m) => m.type === "error" && m.error?.code === "rate_limited")) {
        limited = true;
      }
      ws.close();
    }
    expect(limited).toBe(true);
  });
});

describe("pairing", () => {
  it("pairs two waiters and wires them into a playable matchmaking room", async () => {
    const a = await connectQueue(UID_1, { name: "alice" });
    await waitFor(() => a.find("queued") !== undefined);
    // The lone waiter counts itself (rooms×2 + waiting = 1).
    expect(a.find("queued")!.playing).toBe(1);

    const b = await connectQueue(UID_2, { name: "bob" });
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);

    const ma = a.find("matched")!;
    const mb = b.find("matched")!;
    expect(ma.room_code).toBe(mb.room_code);
    expect(ma.yourSide).not.toBe(mb.yourSide);
    expect(ma.opponentName).toBe("bob");
    expect(mb.opponentName).toBe("alice");
    // 相手の段級位は成立の時点で配る（実力値の数値は配らない）
    expect(ma.opponentRank).toBe(START_RANK);
    expect(mb.opponentRank).toBe(START_RANK);
    expect(ma.token).not.toBe(mb.token);

    // Tokens are real seat credentials for that room.
    const payload = await verifyPlayerToken(ma.token!, env.TOKEN_SECRET, Date.now());
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ma.room_code);
    expect(payload!.side).toBe(ma.yourSide);

    const stateRes = await SELF.fetch(
      `https://example.com/api/rooms/${ma.room_code}/state`,
      { headers: { Authorization: `Bearer ${ma.token}` } },
    );
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as { match: MatchPayload };
    expect(state.match.match_type).toBe("matchmaking");
    // 対局結果の段位カード用に、両者の段級位が部屋に預けられている
    expect(state.match.sente_rank).toBe(START_RANK);
    expect(state.match.gote_rank).toBe(START_RANK);
    expect(RANKS[state.match.sente_rank!].label).toBe("5級");
    expect(state.match.tc_type).toBe("per_move");
    expect(state.match.tc_seconds).toBe(30);
    expect(state.match.sente_joined).toBe(true);
    expect(state.match.gote_joined).toBe(true);
    expect([state.match.sente_name, state.match.gote_name].sort()).toEqual([
      "alice",
      "bob",
    ]);

    // The server closes both queue sockets after delivering "matched".
    await waitFor(() => a.isClosed() && b.isClosed());
    expect(a.closeCode()).toBe(1000);
  });

  // 段級位・実力値を非表示にする設定（?hr=1）。出さないのは表示だけで、
  // 点数の計算は普通に走る（終局時に MatchRoom が D1 から引き直す）。
  it("keeps a hidden player's rank out of the opponent's view", async () => {
    const a = await connectQueue(UID_1, { name: "alice", hr: 1 });
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2, { name: "bob" });
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);

    const ma = a.find("matched")!;
    const mb = b.find("matched")!;
    // 隠している alice の段級位は bob に届かない。
    // 逆向き（alice に届く bob の段級位）はサーバーでは落とさない
    // ——出さないのはクライアントの createRankBadge() の役目
    expect(mb.opponentRank).toBeNull();
    expect(ma.opponentRank).toBe(START_RANK);

    const stateRes = await SELF.fetch(
      `https://example.com/api/rooms/${mb.room_code}/state`,
      { headers: { Authorization: `Bearer ${mb.token}` } },
    );
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as { match: MatchPayload };
    // 部屋にも預けない（対局中に流れるデータへ入れない）
    const aliceSide = ma.yourSide === "sente" ? "sente_rank" : "gote_rank";
    const bobSide = ma.yourSide === "sente" ? "gote_rank" : "sente_rank";
    expect(state.match[aliceSide]).toBeNull();
    expect(state.match[bobSide]).toBe(START_RANK);
    expect(state.match[ma.yourSide === "sente" ? "sente_rank_visible" : "gote_rank_visible"]).toBe(false);
    expect(state.match[ma.yourSide === "sente" ? "gote_rank_visible" : "sente_rank_visible"]).toBe(true);
  });

  it("supersedes an older socket with the same uid and never self-matches", async () => {
    const first = await connectQueue(UID_1);
    await waitFor(() => first.find("queued") !== undefined);
    const second = await connectQueue(UID_1);
    await waitFor(() => second.find("queued") !== undefined);

    // The old tab's socket is closed; the new one neither matched nor closed.
    await waitFor(() => first.isClosed());
    expect(first.closeCode()).toBe(4000);
    expect(second.find("matched")).toBeUndefined();

    // A real opponent pairs with the surviving socket.
    const other = await connectQueue(UID_2);
    await waitFor(
      () => second.find("matched") !== undefined && other.find("matched") !== undefined,
    );
    expect(second.find("matched")!.room_code).toBe(other.find("matched")!.room_code);
  });

  it("removes a cancelled waiter from the queue", async () => {
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    a.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const b = await connectQueue(UID_2);
    await waitFor(() => b.find("queued") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.find("matched")).toBeUndefined();
    b.ws.close();
  });
});

describe("timeouts (alarm)", () => {
  it("sends {type:'bot'} and closes after 60s when the fallback is on", async () => {
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);

    await ageQueue(61_000);
    expect(await fireAlarm()).toBe(true);

    await waitFor(() => a.find("bot") !== undefined);
    // 券は「60秒待った人」にしか出ない。ここが1人60秒に1枚という上限そのもの
    const ticket = await verifyBotTicket(
      a.find("bot")!.ticket!,
      env.TOKEN_SECRET,
      Date.now(),
    );
    expect(ticket).not.toBeNull();
    expect(ticket!.uid).toBe(UID_1);

    await waitFor(() => a.isClosed());
    expect(a.closeCode()).toBe(1000);
  });

  it("gives a fresh ticket each time, so one cannot be replayed for another game", async () => {
    const first = await connectQueue(UID_1);
    await waitFor(() => first.find("queued") !== undefined);
    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => first.find("bot") !== undefined);

    const second = await connectQueue(UID_2);
    await waitFor(() => second.find("queued") !== undefined);
    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => second.find("bot") !== undefined);

    expect(first.find("bot")!.ticket).not.toBe(second.find("bot")!.ticket);
  });

  it("keeps a fallback-off waiter past 60s but gives up at 10 minutes", async () => {
    const a = await connectQueue(UID_1, { bot: 0 });
    await waitFor(() => a.find("queued") !== undefined);

    await ageQueue(61_000);
    await fireAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.find("bot")).toBeUndefined();
    expect(a.isClosed()).toBe(false);

    await ageQueue(601_000);
    await fireAlarm();
    await waitFor(() => a.find("error") !== undefined);
    expect(a.find("error")!.error!.code).toBe("queue_timeout");
    await waitFor(() => a.isClosed());
  });
});

describe("online-stats", () => {
  it("reports rooms×2 + waiting, and degrades to 0 when idle", async () => {
    expect(await fetchStats()).toBe(0);

    // One pair plays, one waiter remains: 1 room × 2 + 1 = 3.
    const a = await connectQueue(UID_1);
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
    const c = await connectQueue(UID_3, { bot: 0 });
    await waitFor(() => c.find("queued") !== undefined);

    expect(await fetchStats()).toBe(3);

    c.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await fetchStats()).toBe(2);
  });
});

describe("rating window (pure)", () => {
  it("opens at 200 and widens as 200 + 10s + 0.1s² with no upper limit", () => {
    expect(allowedRatingGap(0)).toBe(200);
    expect(allowedRatingGap(10_000)).toBeCloseTo(310);
    expect(allowedRatingGap(30_000)).toBeCloseTo(590);
    expect(allowedRatingGap(60_000)).toBeCloseTo(1160);
    expect(allowedRatingGap(90_000)).toBeCloseTo(1910);
    expect(allowedRatingGap(600_000)).toBeLessThan(Infinity);
    expect(allowedRatingGap(-5_000)).toBe(200);
  });

  it("uses the longer wait, picks the closest rating, and keeps FIFO on ties", () => {
    // 日本時間の昼（倍率1）。1970-01-01 00:01:40 UTC = 9:01 JST
    const now = 100_000;
    // 二段 waited 10s (window 310): 5級 is out of reach, 初段 is in
    const seekers = [
      { queuedAt: now - 10_000, rating: 2150 },
      { queuedAt: now - 3_000, rating: 1500 },
      { queuedAt: now - 1_000, rating: 2075 },
    ];
    expect(choosePair(seekers, now)).toEqual([0, 2]);
    // nobody in reach yet → no pair; the window reaches 650 at about 34s of the longer wait
    expect(choosePair([seekers[0], seekers[1]], now)).toBeNull();
    expect(choosePair([seekers[0], seekers[1]], now + 23_000)).toBeNull();
    expect(choosePair([seekers[0], seekers[1]], now + 24_000)).toEqual([0, 1]);
    // ties go to whoever queued first
    expect(
      choosePair(
        [
          { queuedAt: 0, rating: 1500 },
          { queuedAt: 1, rating: 1600 },
          { queuedAt: 2, rating: 1600 },
        ],
        3,
      ),
    ).toEqual([0, 1]);
  });

  it("treats an unknown rating (D1 down) as compatible with anyone", () => {
    expect(
      choosePair(
        [
          { queuedAt: 0, rating: null },
          { queuedAt: 1, rating: 2900 },
        ],
        2,
      ),
    ).toEqual([0, 1]);
  });
});

describe("pairing by rating", () => {
  async function seedRating(uid: string, display: number): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO player_rating (uid, rating, best_rank, updated_at) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(uid, internalFromDisplay(display), START_RANK, Date.now())
      .run();
  }

  it("holds a 二段 for a closer opponent instead of the 5級 who queued first", async () => {
    await seedRating(UID_1, 2150);
    await seedRating(UID_2, 1500);
    await seedRating(UID_3, 2075);

    const nidan = await connectQueue(UID_1);
    await waitFor(() => nidan.find("queued") !== undefined);
    const gokyu = await connectQueue(UID_2);
    await waitFor(() => gokyu.find("queued") !== undefined);
    // 差650 は並んだ直後の窓（200）に入らない
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(nidan.find("matched")).toBeUndefined();
    expect(gokyu.find("matched")).toBeUndefined();

    // 差75 の初段が来たら、先に並んでいた5級を飛ばして二段と組む
    const shodan = await connectQueue(UID_3);
    await waitFor(
      () => nidan.find("matched") !== undefined && shodan.find("matched") !== undefined,
    );
    expect(nidan.find("matched")!.room_code).toBe(shodan.find("matched")!.room_code);
    expect(gokyu.find("matched")).toBeUndefined();
    // 成立画面の段級位は並んだ時点で引いた値（実力値の数値は配らない）
    expect(shodan.find("matched")!.opponentRank).toBe(rankOf(2150));
    expect(RANKS[shodan.find("matched")!.opponentRank!].label).toBe("二段");
    gokyu.ws.close();
  });

  it("pairs a mismatched couple once the longer waiter's window has widened", async () => {
    await seedRating(UID_1, 2150);
    await seedRating(UID_2, 1500);
    const nidan = await connectQueue(UID_1);
    await waitFor(() => nidan.find("queued") !== undefined);
    const gokyu = await connectQueue(UID_2);
    await waitFor(() => gokyu.find("queued") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nidan.find("matched")).toBeUndefined();

    // 差650。昼でも40秒で窓は760に届く（夜は倍率でもっと広い）
    await ageQueue(40_000);
    expect(await fireAlarm()).toBe(true);
    await waitFor(
      () => nidan.find("matched") !== undefined && gokyu.find("matched") !== undefined,
    );
    expect(nidan.find("matched")!.room_code).toBe(gokyu.find("matched")!.room_code);
  });
});

describe("rematch avoidance (pure)", () => {
  const now = 100_000;
  const seeker = (uid: string, opts: { avoid?: string; bot?: boolean; waited?: number } = {}) => ({
    uid,
    queuedAt: now - (opts.waited ?? 0),
    rating: 1500,
    avoid: opts.avoid ?? null,
    bot: opts.bot ?? true,
  });

  it("skips the pair when either side was just paired with the other", () => {
    const a = seeker(UID_1, { avoid: UID_2, waited: 5_000 });
    const b = seeker(UID_2, { waited: 3_000 });
    expect(isRematchAvoided(a, b, now)).toBe(true);
    expect(isRematchAvoided(b, a, now)).toBe(true);
    expect(choosePair([a, b], now)).toBeNull();
    // 3人目が来れば、長く待っている方がその人と組む
    expect(choosePair([a, b, seeker(UID_3)], now)).toEqual([0, 2]);
  });

  it("does not treat two people without a record as avoiding each other", () => {
    expect(isRematchAvoided({ queuedAt: 0, rating: null }, { queuedAt: 1, rating: null }, 2)).toBe(false);
    expect(isRematchAvoided(seeker(UID_1), seeker(UID_2), now)).toBe(false);
  });

  it("gives way only once someone with the COM fallback off has waited past 60s", () => {
    for (const [botA, waitedA, avoided] of [
      [true, 61_000, true], // COMに切り替わる人は、避けたまま60秒でCOMへ
      [false, 59_000, true],
      [false, 60_000, false], // 行き先の無い人は、60秒を過ぎたら同じ相手とも組む
    ] as const) {
      const a = seeker(UID_1, { avoid: UID_2, bot: botA, waited: waitedA });
      const b = seeker(UID_2, { avoid: UID_1, waited: 1_000 });
      expect(isRematchAvoided(a, b, now)).toBe(avoided);
      expect(isRematchAvoided(b, a, now)).toBe(avoided);
    }
  });
});

describe("rematch avoidance", () => {
  async function playOnce(): Promise<void> {
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
  }

  it("does not pair the two again right away, but pairs each with someone else", async () => {
    await playOnce();

    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => b.find("queued") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.find("matched")).toBeUndefined();
    expect(b.find("matched")).toBeUndefined();

    // 長く待っている方が3人目と組み、もう1人は次の人を待つ
    const c = await connectQueue(UID_3);
    await waitFor(() => a.find("matched") !== undefined && c.find("matched") !== undefined);
    expect(a.find("matched")!.room_code).toBe(c.find("matched")!.room_code);
    expect(b.find("matched")).toBeUndefined();
    b.ws.close();
  });

  it("keeps avoiding from the other side after one of them played someone else", async () => {
    await playOnce();
    // UID_1 が間に UID_3 と指したので、UID_1 の記録は UID_3 を指す。UID_1 を指すのは UID_2 の記録だけ
    const x = await connectQueue(UID_1);
    await waitFor(() => x.find("queued") !== undefined);
    const y = await connectQueue(UID_3);
    await waitFor(() => x.find("matched") !== undefined && y.find("matched") !== undefined);

    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => b.find("queued") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.find("matched")).toBeUndefined();
    expect(b.find("matched")).toBeUndefined();

    // UID_3 は UID_1 とは続けて組まず、UID_2 と組む
    const c = await connectQueue(UID_3);
    await waitFor(() => b.find("matched") !== undefined && c.find("matched") !== undefined);
    expect(b.find("matched")!.room_code).toBe(c.find("matched")!.room_code);
    expect(a.find("matched")).toBeUndefined();
    a.ws.close();
  });

  it("sends both to the COM fallback at 60s instead of pairing them again", async () => {
    await playOnce();
    const a = await connectQueue(UID_1);
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("queued") !== undefined && b.find("queued") !== undefined);

    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined && b.find("bot") !== undefined);
    expect(a.find("matched")).toBeUndefined();
    expect(b.find("matched")).toBeUndefined();
  });

  it("pairs them again after 60s when one has the COM fallback off", async () => {
    await playOnce();
    const a = await connectQueue(UID_1, { bot: 0 });
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("queued") !== undefined && b.find("queued") !== undefined);

    // alarm は先に組んでからCOMへの切り替えを見るので、COMを使う側も相手と組まれる
    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
    expect(a.find("matched")!.room_code).toBe(b.find("matched")!.room_code);
    expect(b.find("bot")).toBeUndefined();
  });

  it("forgets the last opponent an hour after the pairing", async () => {
    await playOnce();
    await runInDurableObject(env.MATCHMAKER.getByName("global"), (_instance, state) => {
      state.storage.sql.exec("UPDATE recent_opponent SET at = at - 3600001");
    });

    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
  });
});

describe("blocking (pure)", () => {
  const now = 100_000;
  const KEY_1 = "1111111111111111";
  const KEY_2 = "2222222222222222";
  const seeker = (uid: string, key: string, opts: { blocked?: string[]; bot?: boolean; waited?: number } = {}) => ({
    uid,
    key,
    blocked: opts.blocked ?? [],
    queuedAt: now - (opts.waited ?? 0),
    rating: 1500,
    bot: opts.bot ?? true,
  });

  it("skips the pair when either side blocked the other, and pairs each with someone else", () => {
    const a = seeker(UID_1, KEY_1, { blocked: [KEY_2], waited: 5_000 });
    const b = seeker(UID_2, KEY_2, { waited: 3_000 });
    expect(isBlockedPair(a, b)).toBe(true);
    expect(isBlockedPair(b, a)).toBe(true);
    expect(choosePair([a, b], now)).toBeNull();
    expect(choosePair([a, b, seeker(UID_3, "3333333333333333")], now)).toEqual([0, 2]);
  });

  it("does not give way to someone with the COM fallback off, however long they wait", () => {
    const a = seeker(UID_1, KEY_1, { blocked: [KEY_2], bot: false, waited: 9 * 60_000 });
    const b = seeker(UID_2, KEY_2, { bot: false, waited: 9 * 60_000 });
    expect(choosePair([a, b], now)).toBeNull();
  });

  it("does not treat people without keys or lists as blocking", () => {
    expect(isBlockedPair({ queuedAt: 0, rating: null }, { queuedAt: 1, rating: null })).toBe(false);
    expect(isBlockedPair(seeker(UID_1, KEY_1), seeker(UID_2, KEY_2))).toBe(false);
  });

  it("keeps only 16-hex keys from the list, once each, up to 50", () => {
    expect(parseBlockKeys(null)).toEqual([]);
    expect(parseBlockKeys("")).toEqual([]);
    expect(parseBlockKeys(`${KEY_1},bad,${KEY_1},${KEY_2.toUpperCase()},${KEY_2},${KEY_2}0`)).toEqual([KEY_1, KEY_2]);
    const many = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(16, "0"));
    expect(parseBlockKeys(many.join(","))).toEqual(many.slice(0, 50));
  });
});

describe("blocking", () => {
  it("tells each side the other's key when they are paired", async () => {
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
    expect(a.find("matched")!.opponentKey).toBe(await blockKey(UID_2, env.TOKEN_SECRET));
    expect(b.find("matched")!.opponentKey).toBe(await blockKey(UID_1, env.TOKEN_SECRET));
  });

  it("does not pair someone with a player they blocked, in either direction", async () => {
    const keyOf2 = await blockKey(UID_2, env.TOKEN_SECRET);
    const a = await connectQueue(UID_1, { bl: keyOf2 });
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2);
    await waitFor(() => b.find("queued") !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.find("matched")).toBeUndefined();
    expect(b.find("matched")).toBeUndefined();

    // ブロックした側もされた側も、3人目とは組める（長く待っている方が先）
    const c = await connectQueue(UID_3);
    await waitFor(() => a.find("matched") !== undefined && c.find("matched") !== undefined);
    expect(a.find("matched")!.room_code).toBe(c.find("matched")!.room_code);
    expect(b.find("matched")).toBeUndefined();
    b.ws.close();
  });

  it("sends both to the COM fallback at 60s instead of pairing them", async () => {
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2, { bl: await blockKey(UID_1, env.TOKEN_SECRET) });
    await waitFor(() => b.find("queued") !== undefined);

    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined && b.find("bot") !== undefined);
    expect(a.find("matched")).toBeUndefined();
    expect(b.find("matched")).toBeUndefined();
  });
});

// ---- 2026-10-18: 時間帯の倍率・段級位ごとのCOMまでの秒数・待った時間の引き継ぎ・並んだ結果の件数 ----

/** 日本時間のその時刻（2026-10-18）。サーバーは UTC で動くので、判定が +9時間で見ているかを確かめる */
function jst(hour: number, minute = 0): number {
  return Date.UTC(2026, 9, 18, hour - 9, minute);
}

async function seedPlayer(uid: string, display: number, bestRank = START_RANK): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO player_rating (uid, rating, best_rank, updated_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(uid, internalFromDisplay(display), bestRank, Date.now())
    .run();
}

async function outcomeCount(result: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(n), 0) AS n FROM queue_outcome WHERE result = ?1",
  )
    .bind(result)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 件数は各処理の最後にまとめて書く。close の通知を受けた処理の後に書かれることもあるので、届くまで少し待つ */
async function waitForCount(result: string, expected: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((await outcomeCount(result)) === expected) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${result}: expected ${expected}, got ${await outcomeCount(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** close の通知がサーバーに届くまで待つ（切れた人の記録が書かれたか） */
async function lostSeekerRows(): Promise<number> {
  return runInDurableObject(env.MATCHMAKER.getByName("global"), (_instance, state) => {
    try {
      return state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM lost_seeker").one().n;
    } catch {
      return 0;
    }
  });
}

describe("quiet hours (pure)", () => {
  it("counts the wait faster late at night, by the hour the wait started in JST", () => {
    for (const [hour, minute, band, factor] of [
      [22, 59, "day", 1],
      [23, 0, "late", 1.3],
      [0, 59, "late", 1.3],
      [1, 0, "edge", 1.6],
      [1, 59, "edge", 1.6],
      [2, 0, "night", 2],
      [5, 59, "night", 2],
      [6, 0, "edge", 1.6],
      [7, 59, "edge", 1.6],
      [8, 0, "day", 1],
      [12, 0, "day", 1],
    ] as const) {
      expect(hourBand(jst(hour, minute)), `${hour}:${minute}`).toBe(band);
      expect(quietHourFactor(jst(hour, minute)), `${hour}:${minute}`).toBe(factor);
    }
  });

  it("widens the window by the larger factor of the two", () => {
    // 差650。昼に20秒（窓440）では組まないが、深夜3時に並んだ人なら40秒ぶん（窓760）で組む
    const day = jst(12);
    expect(choosePair([{ queuedAt: day - 20_000, rating: 2150 }, { queuedAt: day - 1_000, rating: 1500 }], day)).toBeNull();
    const night = jst(3);
    expect(
      choosePair([{ queuedAt: night - 20_000, rating: 2150 }, { queuedAt: night - 1_000, rating: 1500 }], night),
    ).toEqual([0, 1]);
    // 長く待っている人は22時台に並び、来たばかりの人は23時に並んだ: 大きい方（23時台の1.3倍）で数える
    const late = jst(23, 0);
    const longer = { queuedAt: late - 19_000, rating: 2150 }; // 22:59:41。今は 23:00:01 なので20秒待った
    expect(choosePair([longer, { queuedAt: late, rating: 1700 }], late + 1_000)).toEqual([0, 1]); // 差450。20秒×1.3＝26秒で窓528
    expect(choosePair([longer, { queuedAt: late - 10_000, rating: 1700 }], late + 1_000)).toBeNull(); // 2人とも22時台なら20秒で窓440
  });
});

describe("COM fallback timing and outcome keys (pure)", () => {
  it("waits 120s from 初段 for new clients, 60s otherwise, and never with the fallback off", () => {
    const shodan = RANKS.findIndex((r) => r.label === "初段");
    expect(botFallbackMs(true, true, shodan)).toBe(120_000);
    expect(botFallbackMs(true, true, RANKS.length - 1)).toBe(120_000);
    expect(botFallbackMs(true, true, shodan - 1)).toBe(60_000);
    expect(botFallbackMs(true, true, null)).toBe(60_000); // D1 が落ちていて分からない
    expect(botFallbackMs(true, false, shodan)).toBe(60_000); // 古い画面
    expect(botFallbackMs(false, true, shodan)).toBeNull();
  });

  it("buckets the rating band and the wait", () => {
    expect(ratingBand(1999)).toBe("kyu");
    expect(ratingBand(2000)).toBe("dan1");
    expect(ratingBand(2299)).toBe("dan1");
    expect(ratingBand(2300)).toBe("dan3");
    expect(ratingBand(2749)).toBe("dan3");
    expect(ratingBand(2750)).toBe("dan6");
    expect(ratingBand(null)).toBe("unknown");
    for (const [ms, from] of [
      [0, 0],
      [4_999, 0],
      [5_000, 5],
      [119_999, 115],
      [120_000, 120],
      [179_999, 120],
      [599_999, 540],
      [600_000, 600],
      [9_000_000, 600],
      [-1_000, 0],
    ] as const) {
      expect(waitBucketFrom(ms), String(ms)).toBe(from);
    }
    // 日付と時間帯は並び始めた時刻で決める（日をまたいでも並んだ日）
    expect(outcomeOf(jst(23, 50), 2400, jst(23, 50) + 20 * 60_000, "timeout")).toEqual({
      day: "2026-10-18",
      band: "dan3",
      hours: "late",
      waitFrom: 600,
      result: "timeout",
    });
  });
});

describe("COM fallback timing by rank", () => {
  it("switches a 1級 to COM at 60s and tells the client so", async () => {
    await seedPlayer(UID_1, 1950);
    const a = await connectQueue(UID_1, { v: 2 });
    await waitFor(() => a.find("queued") !== undefined);
    expect(a.find("queued")!.botAfter).toBe(60);
    expect(a.find("queued")!.waitedMs).toBe(0);

    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined);
  });

  it("waits 2 minutes for a 初段, even with the rank hidden", async () => {
    await seedPlayer(UID_1, 2050);
    const a = await connectQueue(UID_1, { v: 2, hr: 1 });
    await waitFor(() => a.find("queued") !== undefined);
    expect(a.find("queued")!.botAfter).toBe(120);

    await ageQueue(61_000);
    await fireAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.find("bot")).toBeUndefined();
    expect(a.isClosed()).toBe(false);

    await ageQueue(121_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined);
  });

  it("uses the rank reached before, even after the rating has dropped", async () => {
    await seedPlayer(UID_1, 1850, RANKS.findIndex((r) => r.label === "初段"));
    const a = await connectQueue(UID_1, { v: 2 });
    await waitFor(() => a.find("queued") !== undefined);
    expect(a.find("queued")!.botAfter).toBe(120);
    a.ws.close(4001, "cancel");
  });

  it("keeps 60s for an old client that does not send v=2", async () => {
    await seedPlayer(UID_1, 2400);
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    expect(a.find("queued")!.botAfter).toBe(60);
    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined);
  });

  it("reports no COM for a fallback-off waiter", async () => {
    const a = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => a.find("queued") !== undefined);
    expect(a.find("queued")!.botAfter).toBeNull();
    a.ws.close(4001, "cancel");
  });
});

describe("carrying the wait over", () => {
  it("keeps the start time when the same player requeues within 3 minutes of a drop", async () => {
    const a = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => a.find("queued") !== undefined);
    await ageQueue(50_000);
    a.ws.close(1000, "gone"); // 4001 以外の close は「切れた」
    await waitFor(() => a.isClosed());
    for (let i = 0; i < 50 && (await lostSeekerRows()) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await lostSeekerRows()).toBe(1);

    const again = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => again.find("queued") !== undefined);
    const waited = again.find("queued")!.waitedMs!;
    expect(waited).toBeGreaterThanOrEqual(50_000);
    expect(waited).toBeLessThan(55_000);
    // 前の1回は「並び直した」と数え、切れた記録は消える
    await waitForCount("requeued", 1);
    expect(await lostSeekerRows()).toBe(0);
    again.ws.close(4001, "cancel");
  });

  it("does not keep the wait after a cancel (close 4001)", async () => {
    const a = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => a.find("queued") !== undefined);
    await ageQueue(50_000);
    a.ws.close(4001, "cancel");
    await waitForCount("cancel", 1);
    expect(await lostSeekerRows()).toBe(0);

    const again = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => again.find("queued") !== undefined);
    expect(again.find("queued")!.waitedMs).toBeLessThan(1_000);
    again.ws.close(4001, "cancel");
  });

  it("forgets a drop after 3 minutes and counts it as dropped", async () => {
    const a = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => a.find("queued") !== undefined);
    await ageQueue(50_000);
    a.ws.close(1000, "gone");
    await waitFor(() => a.isClosed());
    for (let i = 0; i < 50 && (await lostSeekerRows()) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await runInDurableObject(env.MATCHMAKER.getByName("global"), (_instance, state) => {
      state.storage.sql.exec("UPDATE lost_seeker SET lost_at = lost_at - 180001");
    });
    // 誰も並んでいなくても、切れた人の期限に alarm が起きて数える
    expect(await fireAlarm()).toBe(true);
    await waitForCount("dropped", 1);
    expect(await lostSeekerRows()).toBe(0);

    const again = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => again.find("queued") !== undefined);
    expect(again.find("queued")!.waitedMs).toBeLessThan(1_000);
    again.ws.close(4001, "cancel");
  });

  it("takes over the start time from a socket of the same player that is still open", async () => {
    const first = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => first.find("queued") !== undefined);
    await ageQueue(30_000);
    const second = await connectQueue(UID_1, { v: 2, bot: 0 });
    await waitFor(() => second.find("queued") !== undefined);
    expect(second.find("queued")!.waitedMs).toBeGreaterThanOrEqual(30_000);
    await waitFor(() => first.isClosed());
    expect(first.closeCode()).toBe(4000);
    await waitForCount("requeued", 1);
    // 置き換えで閉じた古い接続は「切れた人」として覚えない
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await lostSeekerRows()).toBe(0);
    second.ws.close(4001, "cancel");
  });
});

describe("pairing slower than the 30s sweep", () => {
  it("does not seat two players the sweep already sent home", async () => {
    const stub = env.MATCHMAKER.getByName("global");
    let createCalls = 0;
    let joinCalls = 0;
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);

    // Matchmaker から見た部屋の createRoom だけを遅らせる
    type EnvHolder = { env: Env };
    let realEnv: Env | undefined;
    await runInDurableObject(stub, (instance) => {
      const holder = instance as unknown as EnvHolder;
      realEnv = holder.env;
      const rooms = holder.env.MATCH_ROOM;
      const slowRooms = {
        getByName(name: string) {
          const room = rooms.getByName(name);
          return {
            async createRoom(params: Parameters<MatchRoom["createRoom"]>[0]) {
              createCalls++;
              await scheduler.wait(1500);
              return room.createRoom(params);
            },
            async join(params: Parameters<MatchRoom["join"]>[0]) {
              joinCalls++;
              return room.join(params);
            },
          };
        },
      };
      holder.env = new Proxy(holder.env, {
        get: (target, key) => (key === "MATCH_ROOM" ? slowRooms : Reflect.get(target, key)),
      });
    });

    try {
      const pending = connectQueue(UID_2);
      await waitFor(() => createCalls > 0);
      // 部屋づくりの最中に、組んだのが31秒前だったことにして片付けを走らせる
      await runInDurableObject(stub, (_instance, state) => {
        for (const ws of state.getWebSockets()) {
          const att = ws.deserializeAttachment() as Record<string, unknown> | null;
          if (att?.matched) ws.serializeAttachment({ ...att, matchedAt: Date.now() - 31_000 });
        }
      });
      expect(await fireAlarm()).toBe(true);

      const b = await pending;
      await waitFor(() => a.find("error") !== undefined && b.find("error") !== undefined);
      expect(joinCalls).toBe(0);
      expect(a.find("matched")).toBeUndefined();
      expect(b.find("matched")).toBeUndefined();
      expect(await outcomeCount("error")).toBe(2);
    } finally {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as EnvHolder).env = realEnv!;
      });
    }
  });
});

describe("queue outcome counts", () => {
  it("counts both sides of a pairing once", async () => {
    const a = await connectQueue(UID_1, { v: 2 });
    await waitFor(() => a.find("queued") !== undefined);
    const b = await connectQueue(UID_2, { v: 2 });
    await waitFor(() => a.find("matched") !== undefined && b.find("matched") !== undefined);
    await waitFor(() => a.isClosed() && b.isClosed());
    await waitForCount("matched", 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // サーバーが閉じた接続の close で二重に数えない
    expect(await outcomeCount("dropped")).toBe(0);
    expect(await lostSeekerRows()).toBe(0);

    // 相手が閉じ返さない接続（応答しない端末）は CLOSING のまま残る。30秒後の見回りでも「失敗」として数えない
    await runInDurableObject(env.MATCHMAKER.getByName("global"), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...att, matchedAt: Date.now() - 31_000 });
      }
    });
    await fireAlarm();
    expect(await outcomeCount("error")).toBe(0);
    expect(await outcomeCount("matched")).toBe(2);
  });

  it("counts COM fallbacks and 10-minute timeouts with their band and wait bucket", async () => {
    await seedPlayer(UID_1, 2400);
    const a = await connectQueue(UID_1);
    await waitFor(() => a.find("queued") !== undefined);
    await ageQueue(61_000);
    await fireAlarm();
    await waitFor(() => a.find("bot") !== undefined);
    await waitForCount("bot", 1);
    const row = await env.DB.prepare(
      "SELECT day, band, hours, wait_from FROM queue_outcome WHERE result = 'bot'",
    ).first<{ day: string; band: string; hours: string; wait_from: number }>();
    expect(row).toMatchObject({ band: "dan3", wait_from: 60 });
    expect(row!.hours).toBe(hourBand(Date.now() - 61_000));

    const b = await connectQueue(UID_2, { bot: 0 });
    await waitFor(() => b.find("queued") !== undefined);
    await ageQueue(601_000);
    await fireAlarm();
    await waitFor(() => b.find("error") !== undefined);
    await waitForCount("timeout", 1);
    await waitFor(() => a.isClosed() && b.isClosed());
    await new Promise((resolve) => setTimeout(resolve, 100));
    // サーバーが閉じた接続の close で、切れた人として数えない
    expect(await outcomeCount("dropped")).toBe(0);
    expect(await lostSeekerRows()).toBe(0);
  });
});
