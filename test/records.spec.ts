// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  addGameToSummary,
  addTsumeToSummary,
  emptySummary,
  emptyTsumeSummary,
  modeGroup,
  normalizeGame,
  normalizeTsume,
} from "../src/records/model";
import type { GameInput, GameRecord, TsumeInput } from "../src/records/types";

const trackingStartedAt = Date.UTC(2026, 8, 14);

function input(overrides: Partial<GameInput> = {}): GameInput {
  return {
    id: "game-1",
    startedAt: trackingStartedAt,
    endedAt: trackingStartedAt + 60_000,
    mode: "ai",
    player: "sente",
    winner: "sente",
    reason: "checkmate",
    opponentName: "AI",
    aiLevel: "medium",
    moves: ["7g7f", "3c3d", "2g2f", "8c8d", "2f2e", "8d8e"],
    waza: [],
    source: "played",
    completed: true,
    ...overrides,
  };
}

function record(overrides: Partial<GameInput> = {}): GameRecord {
  return normalizeGame(input(overrides), trackingStartedAt)!;
}

function tsume(overrides: Partial<TsumeInput> = {}): TsumeInput {
  return {
    date: "2026-09-14",
    problemId: "beginner",
    moves: 1,
    firstTry: true,
    clearedAt: trackingStartedAt,
    ...overrides,
  };
}

describe("戦績に残す対局", () => {
  it.each(["shared", "imported", "legacy"] as const)("%s の棋譜は通常対局の戦績に含めない", source => {
    expect(normalizeGame(input({ source, startedAt: trackingStartedAt - 1 }), trackingStartedAt)).toBeNull();
  });

  it("画面を閉じただけの未終了対局は含めない", () => {
    expect(normalizeGame(input({ completed: false }), trackingStartedAt)).toBeNull();
  });

  it("初回の対局中に別タブが記録を開始しても、その境界以降に終了した対局は残す", () => {
    expect(record({ startedAt: trackingStartedAt - 1 })).toMatchObject({
      startedAt: trackingStartedAt - 1,
      endedAt: trackingStartedAt + 60_000,
    });
    expect(record({ startedAt: trackingStartedAt - 1, endedAt: trackingStartedAt }).endedAt).toBe(trackingStartedAt);
  });

  it("記録開始前に終了済みの対局は含めない", () => {
    expect(normalizeGame(input({
      startedAt: trackingStartedAt - 60_000,
      endedAt: trackingStartedAt - 1,
    }), trackingStartedAt)).toBeNull();
  });

  it("終了日時が開始より前の入力は保存失敗として扱う", () => {
    expect(() => record({ endedAt: trackingStartedAt - 1 })).toThrow(TypeError);
  });

  it("技は自分の指し手だけを、手筋・囲い・戦法とも同じ種類は1局1回で残す", () => {
    const game = record({
      waza: [
        { id: "tarefu", player: "sente", ply: 1 },
        { id: "tarefu", player: "sente", ply: 3 },
        { id: "hon_mino", player: "sente", ply: 1 },
        { id: "hon_mino", player: "sente", ply: 5 },
        { id: "bogin", player: "sente", ply: 3 },
        { id: "bogin", player: "sente", ply: 5 },
        { id: "oute_bisha", player: "gote", ply: 6 },
      ],
    });
    expect(game.wazaIds).toEqual(["tarefu", "hon_mino", "bogin"]);
    expect(game).not.toHaveProperty("waza");
    expect(game).not.toHaveProperty("source");
    expect(game).not.toHaveProperty("completed");
  });

  it("後手で遊んだ人の技を残し、待ったで切り落とした手や0手目は含めない", () => {
    const game = record({
      player: "gote",
      waza: [
        { id: "tarefu", player: "sente", ply: 1 },
        { id: "bogin", player: "gote", ply: 6 },
        { id: "oute_bisha", player: "gote", ply: 8 },
        { id: "hon_mino", player: "gote", ply: 0 },
      ],
    });
    expect(game.wazaIds).toEqual(["bogin"]);
  });

  it("将棋盤は両側の技を含めるが、双方が同じ種類を使っても1回", () => {
    const game = record({
      mode: "board",
      waza: [
        { id: "bogin", player: "sente", ply: 5 },
        { id: "bogin", player: "gote", ply: 6 },
        { id: "hon_mino", player: "gote", ply: 4 },
      ],
    });
    expect(game.wazaIds).toEqual(["bogin", "hon_mino"]);
    expect(game.player).toBeNull();
    expect(game.winner).toBe("sente");
  });

  it("友達対戦は相手の段級位・実力値を保存せず、オンライン集計に含める", () => {
    const game = record({ mode: "friend", opponentName: "友達", opponentRank: "二段", opponentRating: 1800 });
    expect(game.opponentName).toBe("友達");
    expect(game).not.toHaveProperty("opponentRank");
    expect(game).not.toHaveProperty("opponentRating");
    expect(game).not.toHaveProperty("aiLevel");
    expect(modeGroup(game.mode)).toBe("online");
  });

  it("だれかと対戦の相手の段級位・実力値は、あるものを保存する", () => {
    expect(record({ mode: "online", opponentRank: "2級", opponentRating: 1450 })).toMatchObject({
      opponentRank: "2級", opponentRating: 1450,
    });
    const missing = record({ mode: "online", opponentRank: null, opponentRating: null });
    expect(missing).not.toHaveProperty("opponentRank");
    expect(missing).not.toHaveProperty("opponentRating");
  });

  it("保存用に渡した棋譜を後から変えても、正規化した記録は変わらない", () => {
    const original = input();
    const saved = normalizeGame(original, trackingStartedAt)!;
    original.moves.pop();
    expect(saved.moves).toHaveLength(6);
  });
});

describe("終局時の小計", () => {
  it("AI・だれか・友達を合算し、将棋盤と引き分けは勝率の分母に入れない", () => {
    const games = [
      record(),
      record({ id: "random", mode: "online", winner: "gote" }),
      record({ id: "friend", mode: "friend", player: "gote", winner: "gote" }),
      record({ id: "draw", winner: null, reason: "sennichite" }),
      record({ id: "board", mode: "board", player: null }),
    ];
    const summary = games.reduce(addGameToSummary, emptySummary());
    expect(summary).toEqual({ games: 5, wins: 2, losses: 1, draws: 1, eligible: 3, waza: {} });
  });

  it("技ごとの小計も同じ勝率ルールで更新し、元の小計は変更しない", () => {
    const before = addGameToSummary(emptySummary(), record({ waza: [{ id: "bogin", player: "sente", ply: 5 }] }));
    const after = addGameToSummary(before, record({
      mode: "board", player: null, waza: [{ id: "bogin", player: "gote", ply: 6 }],
    }));
    expect(after.waza.bogin).toEqual({ games: 2, wins: 1, losses: 0, draws: 0, eligible: 1 });
    expect(before.games).toBe(1);
    expect(before.waza.bogin.games).toBe(1);
  });

  it("同じ技がない対局は技別の使用数を増やさない", () => {
    const summary = addGameToSummary(emptySummary(), record({ waza: [{ id: "bogin", player: "sente", ply: 5 }] }));
    expect(addGameToSummary(summary, record()).waza.bogin.games).toBe(1);
  });
});

describe("詰将棋のクリア", () => {
  it("記録開始後に解いた過去の日付の問題も対象にする", () => {
    expect(normalizeTsume(tsume({ date: "2026-09-01" }), trackingStartedAt)).toMatchObject({ date: "2026-09-01" });
    expect(normalizeTsume(tsume({ clearedAt: trackingStartedAt - 1 }), trackingStartedAt)).toBeNull();
  });

  it("クリア・一発正解・手数別の小計を対局数とは別に残す", () => {
    const original = emptyTsumeSummary();
    const summary = [tsume(), tsume({ moves: 3, firstTry: false }), tsume({ moves: 3 })].reduce(addTsumeToSummary, original);
    expect(summary).toEqual({ cleared: 3, firstTry: 2, byMoves: { "1": 1, "3": 2 } });
    expect(original).toEqual({ cleared: 0, firstTry: 0, byMoves: {} });
    expect(summary).not.toHaveProperty("games");
  });

  it("不正な問題識別子や詰み手数は保存失敗として扱う", () => {
    expect(() => normalizeTsume(tsume({ problemId: "" }), trackingStartedAt)).toThrow(TypeError);
    expect(() => normalizeTsume(tsume({ moves: 2 }), trackingStartedAt)).toThrow(TypeError);
  });
});
