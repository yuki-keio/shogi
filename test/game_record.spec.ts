// SPDX-License-Identifier: GPL-3.0-only

// だれかと対戦の対局記録（ソフト指し対策）。記録用の D1（RECORDS）に、終局の後の目覚ましで
// 1局1行が入ること、友達対戦は入らないこと、画面側の値が丸められること、届かない値は「-」に
// なること、保存の失敗が勝敗に響かずやり直されること、古い行が消えることを確かめる。

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendPly,
  clampAway,
  deviceKind,
  plyCount,
  saveGameRecord,
  type GameRecord,
} from "../src/worker/game_record";
import { START_RANK } from "../src/worker/rating";
import type { MatchRoom } from "../src/worker/match_room";

const UID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const UID_B = "bbbbbbbb-2222-4222-8222-222222222222";

// 先手 ▲7六歩・後手 △3四歩
const SENTE_76 = { type: "move" as const, fromX: 2, fromY: 6, toX: 2, toY: 5 };
const GOTE_34 = { type: "move" as const, fromX: 6, fromY: 2, toX: 6, toY: 3 };

type RecordRow = {
  room_code: string;
  started_at: number | null;
  ended_at: number;
  sente_uid: string;
  gote_uid: string;
  winner: string | null;
  result_reason: string | null;
  moves: string;
  ply_ms: string;
  ply_away: string;
  ply_away_ms: string;
  sente_device: string | null;
  gote_device: string | null;
  sente_rating_before: number | null;
  sente_rating_after: number | null;
  gote_rating_before: number | null;
  gote_rating_after: number | null;
  sente_rank: number | null;
  gote_rank: number | null;
};

let roomSeq = 0;
function nextCode() {
  roomSeq += 1;
  return `GREC${String(roomSeq).padStart(6, "3")}`;
}

async function setUpRoom(matchType: "matchmaking" | "invite") {
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
    bestRank: matchType === "matchmaking" ? START_RANK : undefined,
    device: matchType === "matchmaking" ? "pc" : undefined,
  });
  if (!created.ok) throw new Error("createRoom failed");
  const joined = await stub.join({
    uid: UID_B,
    displayName: null,
    bestRank: matchType === "matchmaking" ? START_RANK : undefined,
    device: matchType === "matchmaking" ? "mobile" : undefined,
  });
  if (!joined.ok) throw new Error("join failed");
  return { code, stub };
}

async function records(): Promise<RecordRow[]> {
  const { results } = await env.RECORDS.prepare(
    "SELECT * FROM online_game_record ORDER BY id",
  ).all<RecordRow>();
  return results;
}

async function roomColumns(stub: DurableObjectStub<MatchRoom>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ record_state: number; record_attempts: number; ply_ms: string | null }>(
        "SELECT record_state, record_attempts, ply_ms FROM match WHERE id = 1",
      )
      .one(),
  );
}

beforeEach(async () => {
  await env.RECORDS.exec("DELETE FROM online_game_record");
  await env.DB.exec("DELETE FROM rated_game");
  await env.DB.exec("DELETE FROM player_rating");
});

describe("端末の種類", () => {
  it("tells phones, tablets and PCs apart", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const ipadOld = "Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const androidPhone = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    const androidTablet = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
    const chromebook = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
    expect(deviceKind(iphone, true)).toBe("mobile");
    expect(deviceKind(ipadOld, true)).toBe("tablet");
    // iPadOS の Safari は Mac と同じ名乗り方をするので、タッチ端末かで見分ける
    expect(deviceKind(ipadDesktop, true)).toBe("tablet");
    expect(deviceKind(ipadDesktop, false)).toBe("pc");
    expect(deviceKind(androidPhone, true)).toBe("mobile");
    expect(deviceKind(androidTablet, true)).toBe("tablet");
    // タッチ対応のノートや Chromebook は PC のまま
    expect(deviceKind(windows, true)).toBe("pc");
    expect(deviceKind(chromebook, true)).toBe("pc");
    expect(deviceKind(null, false)).toBeNull();
    expect(deviceKind("curl/8.0", false)).toBeNull();
  });
});

describe("画面側から届く値の丸め", () => {
  it("clamps counts and durations and rejects broken values", () => {
    expect(clampAway(2, 4500, 30)).toEqual({ count: 2, ms: 4500 });
    expect(clampAway(500, 9_999_999, 30)).toEqual({ count: 99, ms: 40_000 });
    expect(clampAway(-3, -10, 30)).toEqual({ count: 0, ms: 0 });
    expect(clampAway(1.6, 1200.4, 30)).toEqual({ count: 2, ms: 1200 });
    expect(clampAway(undefined, undefined, 30)).toBeNull();
    expect(clampAway("2", 100, 30)).toBeNull();
    expect(clampAway(Number.NaN, 100, 30)).toBeNull();
  });

  it("keeps one entry per ply, with '-' for unknown values", () => {
    let list: string | null = null;
    expect(plyCount(list)).toBe(0);
    list = appendPly(list, "-");
    list = appendPly(list, "3");
    expect(list).toBe("-,3");
    expect(plyCount(list)).toBe(2);
  });
});

describe("終局すると対局記録が1行入る", () => {
  it("records a 人間どうしの対局 after the end-of-game alarm", async () => {
    const { code, stub } = await setUpRoom("matchmaking");
    const first = await stub.submitMove({
      side: "sente",
      uid: UID_A,
      expectedRevision: 0,
      move: SENTE_76,
      away: 2,
      awayMs: 4500,
    });
    expect(first.ok).toBe(true);
    // 古い画面（値を送らない）からの手
    const second = await stub.submitMove({
      side: "gote",
      uid: UID_B,
      expectedRevision: first.ok ? first.match.revision : -1,
      move: GOTE_34,
    });
    expect(second.ok).toBe(true);
    const resigned = await stub.resign({ side: "sente", uid: UID_A, expectedRevision: null });
    expect(resigned.ok).toBe(true);

    // 結果を配った時点ではまだ入っていない（目覚ましで入れる）
    expect(await records()).toHaveLength(0);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const rows = await records();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.room_code).toBe(code);
    expect(row.sente_uid).toBe(UID_A);
    expect(row.gote_uid).toBe(UID_B);
    expect(row.winner).toBe("gote");
    expect(row.result_reason).toBe("resign");
    expect(row.moves).toBe("7g7f 3c3d");
    expect(row.ply_ms.split(",")).toHaveLength(2);
    expect(row.ply_ms.split(",").every((v) => /^\d+$/.test(v))).toBe(true);
    expect(row.ply_away).toBe("2,-");
    expect(row.ply_away_ms).toBe("4500,-");
    expect(row.sente_device).toBe("pc");
    expect(row.gote_device).toBe("mobile");
    expect(row.sente_rank).toBe(START_RANK);
    expect(row.gote_rank).toBe(START_RANK);
    expect(row.sente_rating_after! - row.sente_rating_before!).toBeLessThan(0);
    expect(row.gote_rating_after! - row.gote_rating_before!).toBeGreaterThan(0);
    expect(row.ended_at).toBeGreaterThan(0);

    // もう一度目覚ましが鳴っても二重には入らない
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(1);
    expect((await roomColumns(stub)).record_state).toBe(1);
  });

  it("clamps what the client reports", async () => {
    const { stub } = await setUpRoom("matchmaking");
    await stub.submitMove({
      side: "sente",
      uid: UID_A,
      expectedRevision: 0,
      move: SENTE_76,
      away: 500,
      awayMs: 9_999_999,
    });
    await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    await runDurableObjectAlarm(stub);
    const [row] = await records();
    expect(row.ply_away).toBe("99");
    expect(row.ply_away_ms).toBe("40000");
  });

  it("leaves 友達対戦 out", async () => {
    const { stub } = await setUpRoom("invite");
    await stub.submitMove({
      side: "sente",
      uid: UID_A,
      expectedRevision: 0,
      move: SENTE_76,
      away: 1,
      awayMs: 1000,
    });
    await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(0);
    expect((await roomColumns(stub)).ply_ms).toBeNull();
  });

  it("skips a game whose per-ply columns started mid-game (deployed during the game)", async () => {
    const { stub } = await setUpRoom("matchmaking");
    await stub.submitMove({ side: "sente", uid: UID_A, expectedRevision: 0, move: SENTE_76 });
    // 配備前に始まった対局は、1手目のぶんの列が無い
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE match SET ply_ms = NULL, ply_away = NULL, ply_away_ms = NULL WHERE id = 1");
    });
    await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(0);
    expect((await roomColumns(stub)).record_state).toBe(1);
  });

  it("waits for the rating before saving (an older alarm can fire mid-finalize)", async () => {
    const { stub } = await setUpRoom("matchmaking");
    await stub.submitMove({ side: "sente", uid: UID_A, expectedRevision: 0, move: SENTE_76 });
    // 終局は書いたが、実力値はまだ書き込まれていない瞬間を作る
    const endedAt = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET game_over = 1, winner = 'sente', result_reason = 'timeout', ended_at = ? WHERE id = 1",
        endedAt,
      );
    });
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(0);
    expect((await roomColumns(stub)).record_state).toBe(0);
    // 実力値が付かないまま待ち時間が過ぎたら、実力値なしで保存する
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE match SET ended_at = ? WHERE id = 1", endedAt - 31_000);
    });
    await runDurableObjectAlarm(stub);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0].sente_rating_after).toBeNull();
    expect(rows[0].result_reason).toBe("timeout");
  });

  it("retries a failed save without touching the result", async () => {
    const { stub } = await setUpRoom("matchmaking");
    await stub.submitMove({ side: "sente", uid: UID_A, expectedRevision: 0, move: SENTE_76 });
    const resigned = await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    // 記録が保存できなくても、勝敗と実力値は普通に配られている
    expect(resigned.ok && resigned.match.winner).toBe("sente");
    expect(resigned.ok && resigned.match.sente_rating_delta).toBeGreaterThan(0);

    await env.RECORDS.exec("ALTER TABLE online_game_record RENAME TO online_game_record_off");
    try {
      await runDurableObjectAlarm(stub);
      expect(await roomColumns(stub)).toMatchObject({ record_state: 0, record_attempts: 1 });
    } finally {
      await env.RECORDS.exec("ALTER TABLE online_game_record_off RENAME TO online_game_record");
    }
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(1);
    expect((await roomColumns(stub)).record_state).toBe(1);
  });

  it("gives up after 3 failed tries", async () => {
    const { stub } = await setUpRoom("matchmaking");
    await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    await env.RECORDS.exec("ALTER TABLE online_game_record RENAME TO online_game_record_off");
    try {
      for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
      expect(await roomColumns(stub)).toMatchObject({ record_state: 1, record_attempts: 3 });
    } finally {
      await env.RECORDS.exec("ALTER TABLE online_game_record_off RENAME TO online_game_record");
    }
    await runDurableObjectAlarm(stub);
    expect(await records()).toHaveLength(0);
  });
});

describe("古い記録の掃除", () => {
  function record(roomCode: string, endedAt: number): GameRecord {
    return {
      roomCode,
      startedAt: endedAt - 60_000,
      endedAt,
      senteUid: UID_A,
      goteUid: UID_B,
      winner: "sente",
      resultReason: "resign",
      moves: ["7g7f"],
      plyMs: "1200",
      plyAway: "0",
      plyAwayMs: "0",
      senteDevice: "pc",
      goteDevice: null,
      senteRatingAfter: 1537,
      senteRatingDelta: 37,
      goteRatingAfter: 1493,
      goteRatingDelta: -7,
      senteRank: START_RANK,
      goteRank: START_RANK,
    };
  }

  it("drops rows older than the keep period on every save", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const never = () => 1;
    // 91日前に保存した行（そのときはまだ新しかった）
    await saveGameRecord(env.RECORDS, record("OLD0000001", now - 91 * day), now - 91 * day, { random: never });
    await saveGameRecord(env.RECORDS, record("NEW0000001", now - 1 * day), now - 1 * day, { random: never });
    expect(await records()).toHaveLength(2);
    // 期間の掃除は毎回走る（行数の上限の掃除は走らせない）
    await saveGameRecord(env.RECORDS, record("NEW0000002", now), now, { random: never });
    expect((await records()).map((r) => r.room_code)).toEqual(["NEW0000001", "NEW0000002"]);
    const [kept] = await records();
    expect(kept.sente_rating_before).toBe(1500);
    expect(kept.gote_rating_before).toBe(1500);
  });

  it("keeps only the newest rows over the cap", async () => {
    const now = Date.now();
    for (let i = 1; i <= 5; i++) {
      await saveGameRecord(env.RECORDS, record(`CAP000000${i}`, now - (10 - i) * 1000), now, { random: () => 1 });
    }
    await saveGameRecord(env.RECORDS, record("CAP0000006", now), now, { random: () => 0, maxRows: 3 });
    expect((await records()).map((r) => r.room_code)).toEqual(["CAP0000004", "CAP0000005", "CAP0000006"]);
  });
});

describe("並ぶときに端末の種類を決めて部屋へ渡す", () => {
  async function queue(uid: string, ua: string, touch: boolean, ip: string) {
    const params = new URLSearchParams({ uid });
    if (touch) params.set("t", "1");
    const res = await SELF.fetch(`https://example.com/api/match/ws?${params}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": ip, "User-Agent": ua },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: Array<{ type: string; room_code?: string; yourSide?: string }> = [];
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data !== "pong") messages.push(JSON.parse(event.data));
    });
    return messages;
  }

  it("stores the device of each seat in the room (never in the payload)", async () => {
    const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const a = await queue(UID_A, ipadDesktop, true, "10.9.0.1");
    const b = await queue(UID_B, iphone, true, "10.9.0.2");
    const start = Date.now();
    while (!(a.some((m) => m.type === "matched") && b.some((m) => m.type === "matched"))) {
      if (Date.now() - start > 2000) throw new Error("no match");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ma = a.find((m) => m.type === "matched")!;
    const stub = env.MATCH_ROOM.getByName(ma.room_code!);
    const devices = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ sente_device: string | null; gote_device: string | null }>(
          "SELECT sente_device, gote_device FROM match WHERE id = 1",
        )
        .one(),
    );
    const mine = ma.yourSide === "sente" ? devices.sente_device : devices.gote_device;
    const theirs = ma.yourSide === "sente" ? devices.gote_device : devices.sente_device;
    expect(mine).toBe("tablet");
    expect(theirs).toBe("mobile");
    // 端末の種類は記録だけに使い、対局の画面へ流すデータには入れない
    const state = await stub.getStateFor({ side: ma.yourSide as "sente" | "gote", uid: UID_A });
    expect(state.ok).toBe(true);
    expect(JSON.stringify(state)).not.toContain("device");
  });
});
