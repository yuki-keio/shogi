// SPDX-License-Identifier: GPL-3.0-only

// 打ち歩詰めの判定が、双方が歩を持つ終盤の形で爆発しないことを見張る回帰テスト。
// 以前は判定の中から詰み判定を呼び、その中でまた打ち歩詰めを調べていたため、
// 下の局面（歩を打てる筋が3本）で1手に約1秒、4本では30秒以上かかっていた。
// 通信対戦では部屋がCPU上限でリセットされ、詰ませた側が時間切れ負けになっていた。
// 時間を測るので、処理中に時計が進まない Workers のテスト環境ではなく Node で動かす。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { applyMove, createInitialGameState, getBoardHash, SENTE, GOTE } from "../src/worker/shogi_engine.ts";

// 修正前は同じ局面で約1秒（速い Mac）。修正後は1ミリ秒前後
const LIMIT_MS = 300;

const emptyHand = () => ({ HI: 0, KA: 0, KI: 0, GI: 0, KE: 0, KY: 0, FU: 0 });

/**
 * 後手玉は9一。先手が9二に金を打つと頭金で詰む。先手玉は1九にいて、後手が1八に歩を打つと
 * 逃げ場が無い形（打ち歩詰めの形）。双方とも歩を1枚ずつ持ち、歩を打てる筋は9・2・1筋の3本。
 */
function position() {
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  const put = (x, y, type, owner) => { board[y][x] = { type, owner }; };
  put(0, 0, "OU", GOTE);
  put(1, 2, "GI", SENTE);
  put(8, 8, "OU", SENTE);
  put(7, 8, "KY", SENTE);
  put(7, 6, "KI", GOTE);
  for (let x = 1; x <= 6; x++) {
    put(x, 4, "FU", SENTE);
    put(x, 3, "FU", GOTE);
  }
  const hands = { [SENTE]: { ...emptyHand(), KI: 1, FU: 1 }, [GOTE]: { ...emptyHand(), FU: 1 } };
  return { board, hands };
}

test("サーバーの判定: 頭金の王手が一瞬で「詰み」と判定される", () => {
  const { board, hands } = position();
  const state = {
    ...createInitialGameState(),
    board,
    capturedPieces: hands,
    currentPlayer: SENTE,
    moveCount: 80,
    lastMove: null,
    isCheck: false,
    positionHistory: [getBoardHash(board, hands, SENTE)],
    checkHistory: [false],
    turnHistory: [SENTE],
    usiMoveHistory: [],
  };
  const started = performance.now();
  const result = applyMove(state, { type: "drop", pieceType: "KI", toX: 0, toY: 1 });
  const elapsed = performance.now() - started;

  assert.equal(result.gameOver, true);
  assert.equal(result.winner, SENTE);
  assert.equal(result.resultReason, "checkmate");
  assert.ok(elapsed < LIMIT_MS, `1手の処理が ${LIMIT_MS}ms 未満 (${elapsed.toFixed(1)}ms)`);
});

test("AIの計算役: 同じ局面の詰み判定と合法手の生成が一瞬で終わる", () => {
  const ctx = { performance, console, Math, Date, JSON, self: {} };
  vm.createContext(ctx);
  const bridge = `
    globalThis.__api = {
      set board(v){board=v}, set capturedPieces(v){capturedPieces=v},
      recomputeKingPosCache, isCheckmate, getAllLegalMovesFast,
    };
  `;
  const source = readFileSync(fileURLToPath(new URL("../ai-worker.js", import.meta.url)), "utf8");
  vm.runInContext(source + bridge, ctx, { filename: "ai-worker.js" });
  const api = ctx.__api;

  const { board, hands } = position();
  board[1][0] = { type: "KI", owner: SENTE };
  hands[SENTE].KI = 0;
  api.board = board;
  api.capturedPieces = hands;
  api.recomputeKingPosCache();

  const started = performance.now();
  const mated = api.isCheckmate(GOTE);
  const replies = api.getAllLegalMovesFast(GOTE);
  const elapsed = performance.now() - started;

  assert.equal(mated, true);
  assert.equal(replies.length, 0);
  assert.ok(elapsed < LIMIT_MS, `判定が ${LIMIT_MS}ms 未満 (${elapsed.toFixed(1)}ms)`);
});
