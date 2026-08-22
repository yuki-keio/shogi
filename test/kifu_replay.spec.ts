// SPDX-License-Identifier: GPL-3.0-only

// 指し手の並びから局面を組み直す処理。棋譜の表示・共有URL・KIF読み込みに加えて、
// 遊びかけの対局の保存（設計書 §12 の新形式 v2）もここに乗る。
// 🔴 千日手のハッシュが shogi.js と同じ並びであること（ずれると再読み込みで判定が変わる）。

import { describe, expect, it } from "vitest";
import { initialPositionHash, replayUsiMoves } from "../src/kifu/replay";
import { GOTE, SENTE } from "../src/worker/shogi_engine";

const GAME = [
  "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e", "8h7g", "4a3b",
  "7i8h", "2b7g+", "8h7g", "3a2b",
];

// 金を上げては戻す。同一局面が4回現れて千日手になる
const REPETITION = [
  "6i6h", "4a4b", "6h6i", "4b4a",
  "6i6h", "4a4b", "6h6i", "4b4a",
  "6i6h", "4a4b", "6h6i", "4b4a",
];

describe("局面の組み直し", () => {
  it("開始局面ぶんを含めて、手数+1 の局面が並ぶ", () => {
    const result = replayUsiMoves(GAME);
    expect(result.ok).toBe(true);
    expect(result.states.length).toBe(GAME.length + 1);
    expect(result.usiMoves).toEqual(GAME);
  });

  it("開始局面は先手番・0手目・王手なし", () => {
    const first = replayUsiMoves([]).states[0];
    expect(first.currentPlayer).toBe(SENTE);
    expect(first.moveCount).toBe(0);
    expect(first.isCheck).toBe(false);
    expect(first.lastMove).toBeNull();
    expect(first.gameOver).toBe(false);
  });

  it("盤・持ち駒・手番・手数・直前の手が入れ替わっていく", () => {
    const result = replayUsiMoves(GAME);
    const afterFirst = result.states[1];
    expect(afterFirst.currentPlayer).toBe(GOTE);
    expect(afterFirst.moveCount).toBe(1);
    expect(afterFirst.lastMove).toEqual({ x: 2, y: 5 }); // ７六
    // 10手目 △７七角成 で先手の角が後手の持ち駒に入る
    expect(result.states[10].capturedPieces[GOTE].KA).toBe(1);
    // 11手目 ▲同銀 で取り返す
    expect(result.states[11].capturedPieces[SENTE].KA).toBe(1);
  });

  it("千日手判定に使うハッシュが局面と同じ数だけ並ぶ", () => {
    const result = replayUsiMoves(GAME);
    expect(result.positionHistory.length).toBe(GAME.length + 1);
    expect(result.checkHistory.length).toBe(GAME.length + 1);
    expect(result.positionHistory[0]).toBe(initialPositionHash());
  });
});

describe("終局の判定", () => {
  it("同一局面が4回現れたら千日手として引き分けになる", () => {
    const result = replayUsiMoves(REPETITION);
    expect(result.ok).toBe(true);
    expect(result.gameOver).toBe(true);
    expect(result.resultReason).toBe("sennichite");
    expect(result.winner).toBe("draw");
    // 終局した手の局面にだけ gameOver が立つ
    expect(result.states[result.states.length - 1].gameOver).toBe(true);
    expect(result.states[result.states.length - 2].gameOver).toBe(false);
  });

  it("同じ手順を何度並べ直しても同じ結果になる（再読み込みで判定が変わらない）", () => {
    const a = replayUsiMoves(REPETITION);
    const b = replayUsiMoves(REPETITION);
    expect(a.positionHistory).toEqual(b.positionHistory);
    expect(a.resultReason).toBe(b.resultReason);
  });
});

describe("🔴 壊れた手順でも例外を投げない", () => {
  it("将棋のルールに合わない手で止まり、何手目かを返す", () => {
    const result = replayUsiMoves(["7g7f", "8c8d", "9i9a"]);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(2);
    expect(result.reason).not.toBeNull();
    // そこまでの局面は使える
    expect(result.states.length).toBe(3);
  });

  it("指し手の形が壊れていても止まるだけ", () => {
    const result = replayUsiMoves(["7g7f", "こんにちは"]);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(result.reason).toBe("bad_move_format");
  });

  it("空の手順でも開始局面だけ返す", () => {
    const result = replayUsiMoves([]);
    expect(result.ok).toBe(true);
    expect(result.states.length).toBe(1);
  });
});

describe("続きから並べる（1手指すたびに全部やり直さないため）", () => {
  it("前回の結果を渡しても、頭から並べ直したのと同じ結果になる", () => {
    const previous = replayUsiMoves(GAME.slice(0, 8));
    const continued = replayUsiMoves(GAME, previous);
    const fromScratch = replayUsiMoves(GAME);
    expect(continued.usiMoves).toEqual(fromScratch.usiMoves);
    expect(continued.positionHistory).toEqual(fromScratch.positionHistory);
    expect(continued.checkHistory).toEqual(fromScratch.checkHistory);
    expect(continued.states.length).toBe(fromScratch.states.length);
    expect(continued.states[continued.states.length - 1]).toEqual(
      fromScratch.states[fromScratch.states.length - 1],
    );
  });

  it("🔴 途中が違う手順のときは使い回さず、頭から並べ直す", () => {
    // 「待った」で戻って別の手を指した場合。使い回すと別の対局が混ざる
    const previous = replayUsiMoves(GAME);
    const branched = GAME.slice(0, 4).concat(["2g2f", "8d8e"]);
    const result = replayUsiMoves(branched, previous);
    expect(result.ok).toBe(true);
    expect(result.usiMoves).toEqual(branched);
    expect(result.positionHistory).toEqual(replayUsiMoves(branched).positionHistory);
  });

  it("短くなった手順でも使い回さない", () => {
    const previous = replayUsiMoves(GAME);
    const shorter = GAME.slice(0, 4);
    const result = replayUsiMoves(shorter, previous);
    expect(result.usiMoves).toEqual(shorter);
    expect(result.states.length).toBe(shorter.length + 1);
  });

  it("千日手の判定も続きから並べたときに変わらない", () => {
    const previous = replayUsiMoves(REPETITION.slice(0, 8));
    const continued = replayUsiMoves(REPETITION, previous);
    expect(continued.gameOver).toBe(true);
    expect(continued.resultReason).toBe("sennichite");
  });
});
