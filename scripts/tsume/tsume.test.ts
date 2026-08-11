// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋まわりのうち、ソルバーを必要としない部分の単体テスト。
//   node --test scripts/tsume/
//
// ソルバーが要る部分（手数・余詰・駒余りの判定）は
// scripts/tsume/selfcheck.ts が在庫全部に対して実行する。

import assert from "node:assert/strict";
import { test } from "node:test";

import { SENTE, isCheckmate } from "../../src/worker/shogi_engine.ts";
import {
  extractCandidates,
  handFromPv,
  replayGame,
  rotateSwapPosition,
  toTsumeCandidate,
  withFullDefenderHand,
} from "./mine.ts";
import {
  applyMoveToPosition,
  attackerHandIsEmpty,
  canonicalKey,
  countDefenderPieces,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  fromSfen,
  mirrorPosition,
  moveFromUsi,
  toSfen,
  usi,
  validateProblemPosition,
} from "./position.ts";
import { lineLabels, moveLabel, squareLabel } from "./render.ts";
import { hasEnoughPieces, problemSignature, scoreProblem } from "./quality.ts";
import { replayMainLine } from "./verify.ts";

// 「4三金打」の1手詰。玉方は5一の玉のみ、攻方は5三の金と持ち駒の金
const ONE_MOVE = "4k4/9/4G4/9/9/9/9/9/9 b G 1";

test("SFEN を読み書きしても元に戻る", () => {
  const cases = [
    ONE_MOVE,
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    "l6nl/5+P1gk/2np1S3/p1p4Pp/3P2Sp1/1PPb2P1P/P5GS1/R8/LN4bKL w RGgsn5p 1",
    "9/9/9/9/9/9/9/9/4k4 b 2R2B4G4S4N4L18P 1",
  ];
  for (const sfen of cases) {
    assert.equal(toSfen(fromSfen(sfen)), sfen, sfen);
  }
});

test("成駒と両者の持ち駒を読み分ける", () => {
  const pos = fromSfen("4k4/9/4+P4/9/9/9/9/9/9 b 2Gg 1");
  assert.equal(pos.board[2][4]?.type, "+FU");
  assert.equal(pos.board[2][4]?.owner, "sente");
  assert.equal(pos.hands.sente.KI, 2);
  assert.equal(pos.hands.gote.KI, 1);
});

test("王手になる手だけを列挙する", () => {
  const moves = enumerateCheckingMoves(fromSfen(ONE_MOVE)).map(usi).sort();
  assert.deepEqual(moves, ["5c4b", "5c5b", "5c6b", "G*4a", "G*4b", "G*5b", "G*6a", "G*6b"]);
});

test("USI 文字列と指し手を相互に変換できる", () => {
  const pos = fromSfen(ONE_MOVE);
  for (const text of ["G*5b", "5c5b", "5c4b"]) {
    assert.equal(usi(moveFromUsi(text, pos)), text);
  }
  const promoting = fromSfen("4k4/9/9/4P4/9/9/9/9/9 b - 1");
  assert.equal(usi(moveFromUsi("5d5c+", promoting)), "5d5c+");
});

test("鏡像は同じ正規形キーになる", () => {
  const pos = fromSfen(ONE_MOVE);
  assert.equal(canonicalKey(pos), canonicalKey(mirrorPosition(pos)));
});

test("詰将棋として成立しない局面を弾く", () => {
  const cases: Array<[string, string]> = [
    ["攻方の玉が盤上にある", "4k4/9/4G4/9/9/9/9/9/4K4 b G 1"],
    ["玉方の玉がない", "9/9/4G4/9/9/9/9/9/9 b G 1"],
    ["初形で王手がかかっている", "4k4/4G4/9/9/9/9/9/9/9 b G 1"],
    ["攻方の手番ではない", "4k4/9/4G4/9/9/9/9/9/9 w G 1"],
    ["二歩", "4k4/9/9/4P4/4P4/9/9/9/9 b G 1"],
    ["行き所のない駒がある", "4kP3/9/4G4/9/9/9/9/9/9 b G 1"],
  ];
  for (const [expected, sfen] of cases) {
    assert.equal(validateProblemPosition(fromSfen(sfen)), expected, sfen);
  }
  assert.equal(validateProblemPosition(fromSfen(ONE_MOVE)), null);
});

test("指し手を適用すると持ち駒と盤面が整合する", () => {
  const pos = fromSfen(ONE_MOVE);
  const after = applyMoveToPosition(pos, moveFromUsi("G*5b", pos));
  assert.equal(after.board[1][4]?.type, "KI");
  assert.equal(after.hands.sente.KI, 0);
  assert.equal(after.turn, "gote");
  assert.ok(attackerHandIsEmpty(after));
  // 玉方に応手がない＝詰み
  assert.equal(enumerateLegalMoves(after).length, 0);
});

test("作意手順を再生して詰みまで到達する", () => {
  const line = [{ accept: ["G*5b"], attack: "G*5b", defend: null }];
  assert.equal(replayMainLine(fromSfen(ONE_MOVE), line), null);
});

test("誤った作意手順は再生で弾かれる", () => {
  const wrong = [{ accept: ["G*4b"], attack: "G*4b", defend: null }];
  assert.match(String(replayMainLine(fromSfen(ONE_MOVE), wrong)), /詰んでいない/);
});

test("棋譜の表記に移動元を添えて一意にする", () => {
  const pos = fromSfen(ONE_MOVE);
  assert.equal(squareLabel(4, 1), "５二");
  assert.equal(moveLabel(pos, moveFromUsi("G*5b", pos)), "５二金打");
  assert.equal(moveLabel(pos, moveFromUsi("5c5b", pos)), "５二金(５三)");
  assert.deepEqual(
    lineLabels(pos, [{ accept: ["G*5b"], attack: "G*5b", defend: null }]),
    ["▲５二金打"],
  );
});

test("同じ地点への応手は「同〜」と書く", () => {
  // 玉が5二の金を取り返す3手詰の形
  const pos = fromSfen("4k4/9/9/9/9/9/9/9/9 b G 1");
  const labels = lineLabels(pos, [{ accept: ["G*5b"], attack: "G*5b", defend: "5a5b" }]);
  assert.deepEqual(labels, ["▲５二金打", "△同玉(５一)"]);
});

test("採点は玉方に守り駒が残っている問題を高く評価する", () => {
  const line = [{ accept: ["G*5b"], attack: "G*5b", defend: null }];
  // 裸玉。正しくても「なぜその駒がそこにあるのか」が説明できない盤になりやすい
  const naked = scoreProblem({ pos: fromSfen(ONE_MOVE), line, moves: 1 });
  // 玉方の銀が逃げ道を塞いでいる、実戦で出てくる形
  const sheltered = scoreProblem({
    pos: fromSfen("3sks3/9/4G4/9/9/9/9/9/9 b G 1"),
    line,
    moves: 1,
  });
  assert.ok(sheltered > naked, `${sheltered} > ${naked}`);
});

test("採点は攻方の駒が少ない問題を高く評価する", () => {
  const line = [{ accept: ["G*5b"], attack: "G*5b", defend: null }];
  // 玉方の守り駒は同じで、攻方の駒数だけが違う
  const tidy = scoreProblem({ pos: fromSfen("4kg3/9/4G4/9/9/9/9/9/9 b G 1"), line, moves: 1 });
  const cluttered = scoreProblem({
    pos: fromSfen("4kg3/9/4G4/9/1P2P4/9/L8/9/9 b G 1"),
    line,
    moves: 1,
  });
  assert.ok(tidy > cluttered, `${tidy} > ${cluttered}`);
});

test("裸玉は在庫に入れない（1〜5手詰）", () => {
  const naked = fromSfen(ONE_MOVE);
  assert.equal(hasEnoughPieces(naked, 1), false);
  assert.equal(hasEnoughPieces(naked, 5), false);
  // 7/9手は探索由来のままなので裸玉を許す
  assert.equal(hasEnoughPieces(fromSfen("4k4/9/4G4/4L4/4N4/9/9/9/9 b G 1"), 9), true);
  assert.equal(hasEnoughPieces(fromSfen("4kg3/9/4G4/9/9/9/9/9/9 b G 1"), 1), true);
});

// --- 実戦採掘（mine.ts） ------------------------------------------------

test("回転して先後を入れ替えると元に戻る", () => {
  const cases = [
    ONE_MOVE,
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    "l6nl/5+P1gk/2np1S3/p1p4Pp/3P2Sp1/1PPb2P1P/P5GS1/R8/LN4bKL w RGgsn5p 1",
    "4k4/9/4+P4/9/9/9/9/9/9 b 2Gg 1",
  ];
  for (const sfen of cases) {
    const twice = rotateSwapPosition(rotateSwapPosition(fromSfen(sfen)));
    assert.equal(toSfen(twice), sfen, sfen);
  }
});

test("回転後の盤・持ち駒・手番が期待どおりになる", () => {
  // 対合テストだけでは筋・段・所有者を揃って取り違えたときに気付けないので、
  // 手で計算した期待値を1つ置いておく。
  assert.equal(
    toSfen(rotateSwapPosition(fromSfen(ONE_MOVE))),
    "9/9/9/9/9/9/4g4/9/4K4 w g 1",
  );
  assert.equal(
    toSfen(rotateSwapPosition(fromSfen("4k4/9/4+P4/9/9/9/9/9/9 b 2Gg 1"))),
    "9/9/9/9/9/9/4+p4/9/4K4 w G2g 1",
  );
});

test("回転しても詰みは詰みのまま", () => {
  // ONE_MOVE の詰み（▲5二金打）が、先後を入れ替えた側でも成立する。
  // 所有者の反転を間違えるとここで落ちる。
  const rotated = rotateSwapPosition(fromSfen(ONE_MOVE));
  const mated = applyMoveToPosition(rotated, moveFromUsi("G*5h", rotated));
  assert.ok(isCheckmate(SENTE, mated.board, mated.hands));
});

test("実戦局面から攻方の玉と玉方の持ち駒を取り除く", () => {
  // ONE_MOVE に攻方の玉と玉方の持ち駒を足しただけの局面
  const withKing = fromSfen("4k4/9/4G4/9/9/9/9/9/K8 b Gp 1");
  assert.equal(toSfen(toTsumeCandidate(withKing)), ONE_MOVE);

  // 詰ませる側が後手のときは回転してから同じ処理をする
  const asGote = rotateSwapPosition(withKing);
  assert.equal(asGote.turn, "gote");
  assert.equal(toSfen(toTsumeCandidate(asGote)), ONE_MOVE);

  assert.equal(validateProblemPosition(toTsumeCandidate(asGote)), null);
});

test("持ち駒は手順で実際に打った分だけに組み直す", () => {
  // 余分な持ち駒は削られる
  const overStocked = fromSfen("4k4/9/4G4/9/9/9/9/9/9 b 2GS 1");
  const trimmed = handFromPv(overStocked, ["G*5b"]);
  assert.ok(trimmed);
  assert.equal(trimmed.hands.sente.KI, 1);
  assert.equal(trimmed.hands.sente.GI, 0);

  // 手順の中で取った駒は持ち駒に数えない（5三飛で金を取り、その金を打つ）
  const capturing = fromSfen("4k4/4g4/4R4/9/9/9/9/9/9 b - 1");
  const fromCapture = handFromPv(capturing, ["5c5b", "5a5b", "G*5c"]);
  assert.ok(fromCapture);
  assert.equal(fromCapture.hands.sente.KI, 0);

  // 取っていない駒を打つなら、その分は初形の持ち駒が要る
  const needsSilver = handFromPv(capturing, ["5c5b", "5a5b", "S*5c"]);
  assert.ok(needsSilver);
  assert.equal(needsSilver.hands.sente.GI, 1);
  assert.equal(needsSilver.hands.sente.KI, 0);

  // 再生できない手順は null
  assert.equal(handFromPv(capturing, ["9i9h"]), null);
});

test("棋譜を再生して各手番後の局面を並べる", () => {
  const states = replayGame(["7g7f", "3c3d", "8h2b+"]);
  assert.equal(states.length, 4);
  assert.equal(
    toSfen(states[0]),
    "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
  );
  // 角交換：2二に成った先手の角が立ち、後手の角が持ち駒に入る
  assert.equal(states[3].board[1][7]?.type, "+KA");
  assert.equal(states[3].board[1][7]?.owner, "sente");
  assert.equal(states[3].hands.sente.KA, 1);
  assert.equal(states[3].turn, "gote");
});

test("終局から奇数手前の、詰ませた側の手番だけを候補にする", () => {
  const states = replayGame(["7g7f", "3c3d", "8h2b+"]);
  // 最終手を指したのは先手なので、先手の手番の局面だけが候補になる
  assert.deepEqual(
    extractCandidates(states, [1, 3, 5]).map((c) => c.offset),
    [1, 3],
  );
  for (const candidate of extractCandidates(states, [1, 3])) {
    assert.equal(candidate.pos.turn, "sente");
  }
  // 偶数手前は詰まされる側の手番なので落とす
  assert.deepEqual(extractCandidates(states, [2]), []);
});

test("ルール通りの持ち駒は、実戦でその人が持っていた駒と一致する", () => {
  // 角交換して、後手が成った角を銀で取り返した局面（先手番）
  const states = replayGame(["7g7f", "3c3d", "8h2b+", "3a2b"]);
  const real = states[4];
  assert.equal(real.turn, "sente");
  assert.equal(real.hands.gote.KA, 1);

  // 玉方の持ち駒をいったん空にしてから、規約どおりに配り直す
  const restored = withFullDefenderHand(toTsumeCandidate(real));
  assert.equal(restored.hands.gote.KA, 1);
  for (const type of ["HI", "KI", "GI", "KE", "KY", "FU"] as const) {
    assert.equal(restored.hands.gote[type], 0, type);
  }
  // 攻方の持ち駒は触らない
  assert.equal(restored.hands.sente.KA, 1);
});

test("盤上と両者の持ち駒を足すと駒が過不足なくそろう", () => {
  const totals: Record<string, number> = { HI: 2, KA: 2, KI: 4, GI: 4, KE: 4, KY: 4, FU: 18 };
  // 攻方の持ち駒がある疎な局面でも、残りは全部玉方に渡る
  const pos = withFullDefenderHand(fromSfen("4k4/9/4G4/9/9/9/9/9/9 b G 1"));
  const counted: Record<string, number> = {};
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece || piece.type === "OU") continue;
      const base = piece.type.replace("+", "");
      counted[base] = (counted[base] ?? 0) + 1;
    }
  }
  for (const type of ["HI", "KA", "KI", "GI", "KE", "KY", "FU"] as const) {
    const sum =
      (counted[type] ?? 0) + (pos.hands.sente[type] ?? 0) + (pos.hands.gote[type] ?? 0);
    assert.equal(sum, totals[type], type);
  }
  // 盤上に金1・攻方の持ち駒に金1なので、玉方は残りの金2枚を持つ
  assert.equal(pos.hands.gote.KI, 2);
  assert.equal(pos.hands.gote.FU, 18);
});

test("玉方の盤上の駒数を数える", () => {
  assert.equal(countDefenderPieces(fromSfen(ONE_MOVE)), 1);
  assert.equal(countDefenderPieces(fromSfen("4k4/4p4/3pGp3/9/9/9/9/9/9 b G 1")), 4);
});

test("持ち味が同じ問題は同じ署名になる", () => {
  const line = [{ accept: ["G*5b"], attack: "G*5b", defend: null }];
  // 玉と金の位置を1筋ずらしただけの亜種
  const a = problemSignature(fromSfen("4k4/9/4G4/9/9/9/9/9/9 b G 1"), line, 1);
  const b = problemSignature(fromSfen("3k5/9/3G5/9/9/9/9/9/9 b G 1"), line, 1);
  assert.equal(a, b);
  const other = problemSignature(fromSfen("4k4/9/4S4/9/9/9/9/9/9 b G 1"), line, 1);
  assert.notEqual(a, other);
});
