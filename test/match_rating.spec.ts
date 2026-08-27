// SPDX-License-Identifier: GPL-3.0-only

// 「だれかと対戦」の終局で実力値が動くこと。終局の書き込みは詰み・投了・時間切れ・
// 切断負けの4か所に分かれているが、実力値を動かすのは finalizeGameOver の1か所だけ。
// ここではその1か所が「必ず1回だけ」通ることを確かめる。

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { MatchRoom } from "../src/worker/match_room";
import { RANKS, START_RANK } from "../src/worker/rating";
import { loadPlayer } from "../src/worker/rating_store";

const UID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const UID_B = "bbbbbbbb-2222-4222-8222-222222222222";

let roomSeq = 0;
function nextCode() {
  roomSeq += 1;
  return `RATE${String(roomSeq).padStart(6, "2")}`;
}

async function setUpRoom(
  matchType: "matchmaking" | "invite",
  ranks: { a?: number; b?: number } = {},
) {
  const code = nextCode();
  const stub = env.MATCH_ROOM.getByName(code);
  const created = await stub.createRoom({
    roomCode: code,
    uid: UID_A,
    displayName: null,
    sidePref: "sente",
    tcType: "per_move",
    tcSeconds: 30,
    matchType,
    bestRank: ranks.a ?? START_RANK,
  });
  if (!created.ok) throw new Error("createRoom failed");
  const joined = await stub.join({
    uid: UID_B,
    displayName: null,
    bestRank: ranks.b ?? START_RANK,
  });
  if (!joined.ok) throw new Error("join failed");
  // sidePref "sente" なので A=先手 / B=後手 で固定
  return { code, stub };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rated_game");
  await env.DB.exec("DELETE FROM player_rating");
});

describe("終局で実力値が動く", () => {
  it("moves both players and reports the delta on the payload (投了)", async () => {
    const { stub } = await setUpRoom("matchmaking");
    const result = await stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    expect(result.ok).toBe(true);
    const match = result.ok ? result.match : null;

    // 先手が投了 = 後手の勝ち
    expect(match!.gote_rating_delta).toBe(37);
    expect(match!.sente_rating_delta).toBe(-7); // 負けは抑えが効く（抑えなしなら −22）
    expect(match!.gote_rating).toBe(1537);
    expect(match!.sente_rating).toBe(1493);
    expect((await loadPlayer(env.DB, UID_B)).rating).toBe(1016);
    expect((await loadPlayer(env.DB, UID_A)).rating).toBe(995);
  });

  it("leaves 友達対戦 alone", async () => {
    const { stub } = await setUpRoom("invite");
    const result = await stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    const match = result.ok ? result.match : null;
    expect(match!.sente_rating_delta).toBeNull();
    expect(match!.gote_rating_delta).toBeNull();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM player_rating").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("carries the badge ranks from the moment both players sat down", async () => {
    const shodan = RANKS.findIndex((r) => r.label === "初段");
    const { stub } = await setUpRoom("matchmaking", { a: START_RANK, b: shodan });
    const state = await stub.getStateFor({ side: "sente", uid: UID_A });
    const match = state.ok ? state.match : null;
    expect(match!.sente_rank).toBe(START_RANK);
    expect(match!.gote_rank).toBe(shodan);
  });

  it("announces a promotion only on the game that crossed the line", async () => {
    // 4級の一歩手前まで持ち上げておく
    await env.DB
      .prepare("INSERT INTO player_rating (uid, rating, best_rank, updated_at) VALUES (?1,?2,?3,?4)")
      .bind(UID_B, 1043, START_RANK, Date.now())
      .run();
    const first = await setUpRoom("matchmaking");
    const won = await first.stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    expect((won.ok ? won.match : null)!.gote_promoted).toBe("4級");

    const second = await setUpRoom("matchmaking");
    const again = await second.stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    expect((again.ok ? again.match : null)!.gote_promoted).toBeNull();
  });
});

describe("二重に加算しない", () => {
  it("applies the rating exactly once no matter how often the timeout is re-checked", async () => {
    const { stub } = await setUpRoom("matchmaking");
    // 手番の締切を過去へ倒す。時間切れは alarm と、状態を読みに来た経路の両方が拾う
    await runInDurableObject(stub, async (_instance: MatchRoom, state) => {
      state.storage.sql.exec("UPDATE match SET turn_deadline = ? WHERE id = 1", Date.now() - 1000);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const settled = await stub.getStateFor({ side: "sente", uid: UID_A });
    expect(settled.ok && settled.match.result_reason).toBe("timeout");

    // 手番だった先手が負け、後手が勝つ
    const after = await loadPlayer(env.DB, UID_B);
    expect(after.rating).toBe(1016);
    expect((await loadPlayer(env.DB, UID_A)).rating).toBe(995);
    const games = await env.DB.prepare("SELECT COUNT(*) AS n FROM rated_game").first<{ n: number }>();
    expect(games?.n).toBe(1);

    // アラームをもう一度撃っても、状態を何度読み直しても、1点も動かない
    await runInDurableObject(stub, async (_i: MatchRoom, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    await stub.getStateFor({ side: "sente", uid: UID_A });
    await stub.getStateFor({ side: "gote", uid: UID_B });
    expect((await loadPlayer(env.DB, UID_B)).rating).toBe(after.rating);
    const games2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM rated_game").first<{ n: number }>();
    expect(games2?.n).toBe(1);
  });
});

describe("実力値が付かなくても対局結果は必ず出る", () => {
  it("still ends the game when the rating write fails", async () => {
    const code = nextCode();
    // 同じ game_key を先に埋めておくと、実力値更新のバッチが必ず失敗する
    await env.DB
      .prepare("INSERT INTO rated_game (game_key, played_on, pair_key, created_at) VALUES (?1,?2,?3,?4)")
      .bind(code, "1970-01-01", "x|y", 0)
      .run();

    const stub = env.MATCH_ROOM.getByName(code);
    await stub.createRoom({
      roomCode: code,
      uid: UID_A,
      displayName: null,
      sidePref: "sente",
      tcType: "per_move",
      tcSeconds: 30,
      matchType: "matchmaking",
      bestRank: START_RANK,
    });
    await stub.join({ uid: UID_B, displayName: null, bestRank: START_RANK });

    const result = await stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    expect(result.ok).toBe(true);
    const match = result.ok ? result.match : null;
    expect(match!.game_over).toBe(true);
    expect(match!.winner).toBe("gote");
    expect(match!.result_reason).toBe("resign");
    // 変動は出ないが、勝敗はきちんと届く
    expect(match!.sente_rating_delta).toBeNull();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM player_rating").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
