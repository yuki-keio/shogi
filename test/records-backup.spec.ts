// SPDX-License-Identifier: GPL-3.0-only

// 控えに載せる localStorage の選び方と、「保存データが消えた」の判定（src/records/backup.ts）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocal, collectLocal, detectLostStorage, fitProfile, restorePending, worthBackingUp } from "../src/records/backup";

const UID = "c4eafa94-e894-43f5-8e55-50990c4bee63";
const globals = globalThis as unknown as { localStorage?: Storage; document?: { cookie: string } };
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  globals.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  } as Storage;
  globals.document = { cookie: "" };
});

afterEach(() => {
  delete globals.localStorage;
  delete globals.document;
});

describe("控えに載せる localStorage", () => {
  it("進み具合と設定だけを載せ、番号・遊びかけの対局・この仕組みの印は載せない", () => {
    store.set("shogi_unlocked_levels", '["legendary1"]');
    store.set("shogi_ai_difficulty", "hard");
    store.set("shogi_online_uid", UID);
    store.set("shogi_game_state", "{}");
    store.set("shogi_restore_local", "1");
    store.set("unrelated", "x");
    expect(collectLocal()).toEqual({ shogi_unlocked_levels: '["legendary1"]', shogi_ai_difficulty: "hard" });
  });

  it("書き戻すのも同じ項目だけ（控えに紛れた番号や他の値では上書きしない）", () => {
    store.set("shogi_online_uid", UID);
    applyLocal({ shogi_ai_difficulty: "hard", shogi_online_uid: "other-uid-000", shogi_game_state: "{}", aiPlayerSide: 3 });
    expect(store.get("shogi_ai_difficulty")).toBe("hard");
    expect(store.get("shogi_online_uid")).toBe(UID);
    expect(store.has("shogi_game_state")).toBe(false);
    expect(store.has("aiPlayerSide")).toBe(false);
  });
});

describe("保存データが消えたかの判定", () => {
  it("番号が消えて Cookie にだけ残っていれば、番号を戻して戻す印を付ける", () => {
    globals.document!.cookie = `_ga=1; __Host-shogi_uid=${UID}; other=2`;
    expect(detectLostStorage()).toEqual({ uid: UID, local: true, records: true });
    expect(store.get("shogi_online_uid")).toBe(UID);
    expect(restorePending()).toBe(true);
  });

  it("番号が残っていれば、Cookie があっても何もしない", () => {
    globals.document!.cookie = `__Host-shogi_uid=${UID}`;
    store.set("shogi_online_uid", UID);
    expect(detectLostStorage()).toBeNull();
    expect(restorePending()).toBe(false);
  });

  it("Cookie の値が番号の形でなければ使わない", () => {
    globals.document!.cookie = "__Host-shogi_uid=../../x";
    expect(detectLostStorage()).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe("控えを作るかどうか", () => {
  it("通信対戦を1局以上した人と、3局・3問以上遊んだ人だけ控える", () => {
    expect(worthBackingUp(1, 1)).toBe(true);
    expect(worthBackingUp(0, 2)).toBe(false);
    expect(worthBackingUp(0, 3)).toBe(true);
  });

  it("戦績を数え始める前から遊んでいる人の進み具合も見る", () => {
    store.set("shogi_unlocked_levels", '["legendary1"]');
    expect(worthBackingUp(0, 0)).toBe(true);
    store.delete("shogi_unlocked_levels");
    store.set("shogi_tsume_v1", JSON.stringify({ total: 5, days: {} }));
    expect(worthBackingUp(0, 0)).toBe(true);
    store.set("shogi_tsume_v1", JSON.stringify({ total: 1, days: {} }));
    store.set("shogi_ai_win_count", "2");
    expect(worthBackingUp(0, 0)).toBe(false);
  });
});

describe("控えの大きさ", () => {
  it("上限を超えたら詰将棋の記録を古い方から削り、収まっていれば何もしない", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ date: "2026-09-01", problemId: `p${i}`, moves: 1, firstTry: true, clearedAt: i }));
    const small = { v: 1, local: {}, records: { tsume: rows.slice(0, 3) } };
    expect(fitProfile(small, 10_000).records.tsume).toHaveLength(3);
    const big = fitProfile({ v: 1, local: {}, records: { tsume: [...rows] } }, 10_000);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(10_000);
    expect(big.records.tsume.at(-1)).toEqual(rows.at(-1));
    expect(fitProfile({ v: 1, local: {}, records: null }, 10).records).toBeNull();
  });
});
