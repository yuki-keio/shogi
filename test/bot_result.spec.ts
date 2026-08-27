// SPDX-License-Identifier: GPL-3.0-only

// COM戦の結果申告。サーバーは対局を見ていないので、守りは
// 「署名つきの使い捨て券」＋「棋譜をサーバーで並べ直す」の2枚が要。

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import kifu from "./fixtures/bot_win_kifu.json";
import { BOT_DAILY_LIMIT, BOT_RATED_MAX_RANK, RANKS, rankOf } from "../src/worker/rating";
import { loadPlayer } from "../src/worker/rating_store";
import { signBotTicket } from "../src/worker/token";

const UID = "aaaaaaaa-1111-4111-8111-111111111111";
const SECRET = "test-secret-for-vitest-only";

let ipCounter = 0;
function post(body: unknown) {
  ipCounter += 1;
  return SELF.fetch("https://example.com/api/bot-result", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // IPごとのレート制限に引っかからないよう、テストごとに別IPを名乗る
      "CF-Connecting-IP": `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    },
    body: JSON.stringify(body),
  });
}

function ticket(overrides: { uid?: string; exp?: number; jti?: string } = {}) {
  return signBotTicket(
    {
      jti: overrides.jti ?? crypto.randomUUID(),
      uid: overrides.uid ?? UID,
      exp: overrides.exp ?? Date.now() + 60_000,
    },
    SECRET,
  );
}

const WIN_BODY = { side: "gote", result: "win", difficulty: "medium", moves: kifu.usi };

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rated_game");
  await env.DB.exec("DELETE FROM player_rating");
});

describe("引換券", () => {
  it("rejects a missing or malformed ticket", async () => {
    expect((await post({ ...WIN_BODY })).status).toBe(403);
    expect((await post({ ...WIN_BODY, ticket: "not-a-token" })).status).toBe(403);
  });

  it("rejects a ticket signed with another secret", async () => {
    const forged = await signBotTicket(
      { jti: crypto.randomUUID(), uid: UID, exp: Date.now() + 60_000 },
      "some-other-secret-entirely",
    );
    expect((await post({ ...WIN_BODY, ticket: forged })).status).toBe(403);
  });

  it("rejects an expired ticket", async () => {
    const stale = await ticket({ exp: Date.now() - 1 });
    expect((await post({ ...WIN_BODY, ticket: stale })).status).toBe(403);
  });

  it("cannot be spent twice", async () => {
    const jti = crypto.randomUUID();
    const first = await post({ ...WIN_BODY, ticket: await ticket({ jti }) });
    expect(first.status).toBe(200);
    const ratingAfterFirst = (await loadPlayer(env.DB, UID)).rating;

    const second = await post({ ...WIN_BODY, ticket: await ticket({ jti }) });
    expect(second.status).toBe(409);
    expect((await loadPlayer(env.DB, UID)).rating).toBe(ratingAfterFirst);
  });

  it("credits the uid inside the ticket, not one the body asks for", async () => {
    const other = "bbbbbbbb-2222-4222-8222-222222222222";
    await post({ ...WIN_BODY, ticket: await ticket({ uid: other }) });
    expect((await loadPlayer(env.DB, other)).rating).toBeGreaterThan(1000);
    expect((await loadPlayer(env.DB, UID)).rating).toBe(1000);
  });
});

describe("棋譜の検証（勝ちの申告）", () => {
  it("accepts a real checkmate and moves the rating", async () => {
    const res = await post({ ...WIN_BODY, ticket: await ticket() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; outcome: { rated: boolean; ratingDelta: number } };
    expect(json.ok).toBe(true);
    expect(json.outcome.rated).toBe(true);
    expect(json.outcome.ratingDelta).toBeGreaterThan(0);
    expect((await loadPlayer(env.DB, UID)).rating).toBeGreaterThan(1000);
  });

  it("rejects a win claimed from the losing side", async () => {
    const res = await post({ ...WIN_BODY, side: "sente", ticket: await ticket() });
    expect(res.status).toBe(400);
    expect((await loadPlayer(env.DB, UID)).rating).toBe(1000);
  });

  it("rejects a truncated game that never reaches mate", async () => {
    const res = await post({
      ...WIN_BODY,
      moves: kifu.usi.slice(0, -1),
      ticket: await ticket(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an illegal move spliced into the record", async () => {
    const tampered = [...kifu.usi];
    tampered[10] = "9i1a"; // 香車が盤上を飛び越える
    const res = await post({ ...WIN_BODY, moves: tampered, ticket: await ticket() });
    expect(res.status).toBe(400);
  });

  it("rejects a game shorter than the floor", async () => {
    const res = await post({
      ...WIN_BODY,
      moves: ["7g7f", "3c3d"],
      ticket: await ticket(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a claim with no kifu at all", async () => {
    const res = await post({ ...WIN_BODY, moves: undefined, ticket: await ticket() });
    expect(res.status).toBe(400);
  });

  it("takes losses on trust (nothing to gain by lying)", async () => {
    const res = await post({
      side: "gote",
      result: "lose",
      difficulty: "medium",
      ticket: await ticket(),
    });
    expect(res.status).toBe(200);
    expect((await loadPlayer(env.DB, UID)).rating).toBeLessThan(1000);
  });
});

describe("COM戦で実力値が動かない条件", () => {
  it("freezes once the player is 初段 or above", async () => {
    const shodan = rankOf(2000);
    expect(RANKS[shodan].label).toBe("初段");
    expect(shodan).toBeGreaterThan(BOT_RATED_MAX_RANK);
    await env.DB
      .prepare("INSERT INTO player_rating (uid, rating, best_rank, updated_at) VALUES (?1,?2,?3,?4)")
      .bind(UID, 1218, shodan, Date.now())
      .run();

    const res = await post({ ...WIN_BODY, ticket: await ticket() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outcome: { rated: boolean; skipped: string } };
    expect(json.outcome.rated).toBe(false);
    expect(json.outcome.skipped).toBe("frozen");
    expect((await loadPlayer(env.DB, UID)).rating).toBe(1218);
  });

  it("stops counting after the daily cap", async () => {
    const now = Date.now();
    const day = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
    for (let i = 0; i < BOT_DAILY_LIMIT; i++) {
      await env.DB
        .prepare(
          "INSERT INTO rated_game (game_key, played_on, pair_key, created_at) VALUES (?1,?2,?3,?4)",
        )
        .bind(`filler-${i}`, day, `${UID}|COM`, now)
        .run();
    }
    const res = await post({ ...WIN_BODY, ticket: await ticket() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outcome: { rated: boolean; skipped: string } };
    expect(json.outcome.skipped).toBe("daily_limit");
    expect((await loadPlayer(env.DB, UID)).rating).toBe(1000);
  });
});

describe("入口の作法", () => {
  it("only accepts POST", async () => {
    const res = await SELF.fetch("https://example.com/api/bot-result", {
      headers: { "CF-Connecting-IP": "10.9.250.1" },
    });
    expect(res.status).toBe(405);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await SELF.fetch("https://example.com/api/bot-result", {
      method: "POST",
      headers: { "CF-Connecting-IP": "10.9.250.2" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
  });
});
