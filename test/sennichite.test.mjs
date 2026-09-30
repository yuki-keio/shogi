// SPDX-License-Identifier: GPL-3.0-only

// 千日手・連続王手の千日手の判定を、サーバー（src/worker/shogi_engine.ts）と
// ブラウザ（shogi.js の checkSennichite）の両方で同じ手順に通して見張る回帰テスト。
//
// 以前は「4回目になった局面そのもの」が王手かどうかしか見ていなかった。実戦では
// 王手をかける側の手番の局面（王手ではない）が先に4回目を迎えるので、毎手王手でも
// 引き分けになり、逆に王手でない手を挟んだ千日手が反則負けになることがあった。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { applyMove, getBoardHash, isKingInCheck, SENTE, GOTE } from "../src/worker/shogi_engine.ts";

const source = readFileSync(new URL("../shogi.js", import.meta.url), "utf8");

function functions(names) {
  const file = ts.createSourceFile("shogi.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return names.map((name) => {
    const node = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `実装の関数 ${name} が見つかる`);
    return node.getText(file);
  }).join("\n");
}

const emptyHand = () => ({ HI: 0, KA: 0, KI: 0, GI: 0, KE: 0, KY: 0, FU: 0 });

/** 盤の駒だけを置いた局面。実戦と同じく、開始局面も履歴に入れておく */
function startState(pieces, currentPlayer) {
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  for (const [x, y, type, owner] of pieces) board[y][x] = { type, owner };
  const capturedPieces = { [SENTE]: emptyHand(), [GOTE]: emptyHand() };
  const isCheck = isKingInCheck(currentPlayer, board);
  return {
    board, capturedPieces, currentPlayer, moveCount: 0, lastMove: null, isCheck,
    positionHistory: [getBoardHash(board, capturedPieces, currentPlayer)],
    checkHistory: [isCheck],
    turnHistory: [currentPlayer],
    usiMoveHistory: [],
  };
}

/**
 * 同じ手順を繰り返し、サーバーの終局と、ブラウザ側の判定を1手ごとに突き合わせる。
 * ブラウザ側には、サーバーが作った局面を自前のハッシュで積み直して渡す。
 */
function play(state, cycle) {
  const ctx = vm.createContext({ SENTE, GOTE, positionHistory: [], checkHistory: [] });
  vm.runInContext(functions(["getBoardHash", "checkSennichite", "findPerpetualChecker"]), ctx);
  const push = (s) => {
    ctx.board = s.board;
    ctx.capturedPieces = s.capturedPieces;
    ctx.currentPlayer = s.currentPlayer;
    ctx.isCheck = s.isCheck;
    ctx.positionHistory.push(vm.runInContext("getBoardHash(board, capturedPieces, currentPlayer)", ctx));
    ctx.checkHistory.push(s.isCheck);
  };
  push(state);
  for (let ply = 1; ply <= 40; ply++) {
    const result = applyMove(state, cycle[(ply - 1) % cycle.length]);
    state = result.state;
    push(state);
    const client = vm.runInContext("checkSennichite()", ctx);
    assert.equal(client.isSennichite, result.gameOver, `${ply}手目: 千日手の成立がサーバーと一致する`);
    if (result.gameOver) {
      const clientReason = client.isConsecutiveCheck ? "perpetual_check" : "sennichite";
      const clientWinner = client.isConsecutiveCheck
        ? (client.checkingPlayer === SENTE ? GOTE : SENTE)
        : "draw";
      assert.equal(clientReason, result.resultReason, "終局理由がサーバーと一致する");
      assert.equal(clientWinner, result.winner, "勝者がサーバーと一致する");
      return { ply, winner: result.winner, reason: result.resultReason };
    }
  }
  return null;
}

// 先手玉5九・先手飛車・後手玉。飛車は1筋と2筋を行き来して、1一と2一の玉に王手をかける
const R26 = [[7, 5, "HI", SENTE], [8, 0, "OU", GOTE], [4, 8, "OU", SENTE]];
const R16 = [[8, 5, "HI", SENTE], [8, 0, "OU", GOTE], [4, 8, "OU", SENTE]];
const mv = (fromX, fromY, toX, toY) => ({ type: "move", fromX, fromY, toX, toY });

test("毎手王手の千日手は、王手をかける側の手番の局面から始まっても王手側の負け", () => {
  // 実戦でいちばん多い形。最初に4回目を迎えるのは「王手ではない」開始局面
  const end = play(startState(R26, SENTE), [
    mv(7, 5, 8, 5), // ▲1六飛 王手
    mv(8, 0, 7, 0), // △2一玉
    mv(8, 5, 7, 5), // ▲2六飛 王手
    mv(7, 0, 8, 0), // △1一玉
  ]);
  assert.deepEqual(end, { ply: 12, winner: GOTE, reason: "perpetual_check" });
});

test("毎手王手の千日手は、王手された局面から始まっても王手側の負け", () => {
  const end = play(startState(R16, GOTE), [
    mv(8, 0, 7, 0), // △2一玉
    mv(8, 5, 7, 5), // ▲2六飛 王手
    mv(7, 0, 8, 0), // △1一玉
    mv(7, 5, 8, 5), // ▲1六飛 王手
  ]);
  assert.deepEqual(end, { ply: 12, winner: GOTE, reason: "perpetual_check" });
});

test("王手でない手を挟んだ千日手は、繰り返した局面が王手でも通常の千日手（引き分け）", () => {
  const end = play(startState(R16, GOTE), [
    mv(8, 0, 7, 1), // △2二玉
    mv(8, 5, 6, 5), // ▲3六飛 王手ではない
    mv(7, 1, 8, 0), // △1一玉
    mv(6, 5, 8, 5), // ▲1六飛 王手
  ]);
  assert.deepEqual(end, { ply: 12, winner: "draw", reason: "sennichite" });
});
