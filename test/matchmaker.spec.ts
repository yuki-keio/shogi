// SPDX-License-Identifier: GPL-3.0-only

// Matchmaker DO integration tests: FIFO pairing into a playable MatchRoom,
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
import { verifyBotTicket, verifyPlayerToken } from "../src/worker/token";
import { RANKS, START_RANK } from "../src/worker/rating";
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
  room_code?: string;
  token?: string;
  yourSide?: "sente" | "gote";
  opponentName?: string | null;
  opponentRank?: number | null;
  ticket?: string | null;
  error?: { code: string; message: string };
};

async function connectQueue(
  uid: string,
  opts: { name?: string; bot?: 0 | 1; hr?: 0 | 1; ip?: string } = {},
) {
  const params = new URLSearchParams({ uid });
  if (opts.name !== undefined) params.set("name", opts.name);
  if (opts.bot !== undefined) params.set("bot", String(opts.bot));
  if (opts.hr !== undefined) params.set("hr", String(opts.hr));
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

  // 「段級位・実力値を表示しない」設定（?hr=1）。出さないのは表示だけで、
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
