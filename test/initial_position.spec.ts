// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { normalizeInitialPosition, type Handicap } from "../src/shared/initial_position";
import { applyMove, createInitialGameState } from "../src/worker/shogi_engine";
import { parseUsiMove } from "../src/kifu/moves";

describe("駒落ちの初期配置", () => {
  const pieceCounts: Array<[Handicap, number]> = [
    ["none", 40], ["lance", 39], ["bishop", 39], ["rook", 39],
    ["rook-lance", 38], ["two", 38], ["four", 36], ["six", 34], ["eight", 32], ["ten", 30],
  ];

  it.each(pieceCounts)("%s は駒数 %i で上手（後手）の駒だけを外し、外した駒は持ち駒に入らない", (handicap, count) => {
    const state = createInitialGameState({ handicap });
    expect(state.board.flat().filter(Boolean)).toHaveLength(count);
    expect(Object.values(state.capturedPieces).flatMap(Object.values).every((n) => n === 0)).toBe(true);
    expect(state.currentPlayer).toBe(handicap === "none" ? "sente" : "gote");
    expect(state.board.flat().filter((p) => p?.owner === "sente")).toHaveLength(20);
  });

  it("香落ちは上手の1一の香（上手から見て左）を外す", () => {
    const state = createInitialGameState({ handicap: "lance" });
    expect(state.board[0][8]).toBeNull();
    expect(state.board[0][0]).toEqual({ type: "KY", owner: "gote" });
  });

  it("6枚落ちは飛・角・両香・両桂だけを外す", () => {
    const state = createInitialGameState({ handicap: "six" });
    expect(state.board[0].map((p) => p?.type ?? null)).toEqual([null, null, "GI", "KI", "OU", "KI", "GI", null, null]);
    expect(state.board[1].every((p) => p === null)).toBe(true);
    expect(state.board[2].every((p) => p?.type === "FU")).toBe(true);
  });

  it("駒落ちは上手が初手を指し、条件を次の局面へ持ち越す", () => {
    const state = createInitialGameState({ handicap: "ten" });
    const next = applyMove(state, parseUsiMove("3c3d")!).state;
    expect(next.initialPosition).toEqual({ handicap: "ten", handicapSide: "gote", firstPlayer: "gote" });
    expect(next.currentPlayer).toBe("sente");
  });

  it("欠落した旧設定や不正値は通常の平手へ正規化する", () => {
    const standard = { handicap: "none", handicapSide: "gote", firstPlayer: "sente" };
    expect(normalizeInitialPosition()).toEqual(standard);
    expect(normalizeInitialPosition(null)).toEqual(standard);
    expect(normalizeInitialPosition({ handicap: "unexpected", handicapSide: "unexpected", firstPlayer: "unexpected" })).toEqual(standard);
  });

  it("決まりと違う形（平手を後手から・先手が駒を減らす）は作らない", () => {
    expect(normalizeInitialPosition({ firstPlayer: "gote" })).toEqual({ handicap: "none", handicapSide: "gote", firstPlayer: "sente" });
    expect(normalizeInitialPosition({ handicap: "rook", handicapSide: "sente", firstPlayer: "sente" }))
      .toEqual({ handicap: "rook", handicapSide: "gote", firstPlayer: "gote" });
  });
});
