// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// だれかと対戦の待ち時間に出す7手以上の確認（wait_check.ts）。
// 実際の出題（7手詰・1問0.1秒ほど）を写して当てる。判定を直したときに、出すべき問題が消えたり、
// 弾くべき問題が通ったりしていないかを見張る。

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkWaitProblem, needsWaitCheck } from "./wait_check.ts";
import type { WaitTarget } from "./wait_check.ts";

/** 2026-09-23 の t7-0102。1手目は成・不成のどちらでも詰み、玉方がその駒を取って作意と同じ局面に戻る */
const TWIN_CAPTURED: WaitTarget = {
  moves: 7,
  sfen: "1+P7/4gkS2/4ggs+R1/2PB1N3/3P1S3/9/9/9/9 b rbgs3n4l15p 1",
  line: [
    { accept: ["6d5c", "6d5c+"], attack: "6d5c", defend: "4b5c" },
    { accept: ["3b4c+"], attack: "3b4c+", defend: "5b4c" },
    { accept: ["G*5b"], attack: "G*5b", defend: "5c6c" },
    { accept: ["G*7c"], attack: "G*7c", defend: null },
  ],
};

/** 2026-09-20 の t7-0081。1手目の成・不成は玉方が取らないので、成ったあとは作意と別の局面になる */
const TWIN_DIVERGES: WaitTarget = {
  moves: 7,
  sfen: "l1k3gR1/3s5/1B7/p8/9/9/9/9/9 b rb3g3s4n3l17p 1",
  line: [
    { accept: ["2a3a", "2a3a+"], attack: "2a3a", defend: "7a8b" },
    { accept: ["3a8a+"], attack: "3a8a+", defend: "8b9c" },
    { accept: ["8c9b+"], attack: "8c9b+", defend: "9a9b" },
    { accept: ["G*8c", "G*8d"], attack: "G*8c", defend: null },
  ],
};

test("確かめるのは7手以上だけ", () => {
  assert.equal(needsWaitCheck({ moves: 5 }), false);
  assert.equal(needsWaitCheck({ moves: 7 }), true);
  assert.equal(needsWaitCheck({ moves: 13 }), true);
});

test("成・不成のどちらでも詰み、玉方が取って作意に戻る問題は出してよい", () => {
  assert.deepEqual(checkWaitProblem(TWIN_CAPTURED), { ok: true });
});

test("途中で作意と別の局面に進める正解がある問題は出さない", () => {
  const result = checkWaitProblem(TWIN_DIVERGES);
  assert.equal(result.ok, false);
});

test("正解の一覧から詰む手が抜けている問題は出さない（詰み探索で見つける）", () => {
  // 1手目の「成」を一覧から抜くと、その手でも7手以内に詰むのに「その手では詰みません」と出てしまう
  const missing: WaitTarget = {
    ...TWIN_CAPTURED,
    line: [{ ...TWIN_CAPTURED.line[0], accept: ["6d5c"] }, ...TWIN_CAPTURED.line.slice(1)],
  };
  const result = checkWaitProblem(missing);
  assert.equal(result.ok, false);
});

test("最後の一手で詰む手が正解の一覧から抜けている問題は出さない", () => {
  const last = TWIN_CAPTURED.line.length - 1;
  const lacking: WaitTarget = {
    ...TWIN_CAPTURED,
    line: TWIN_CAPTURED.line.map((step, i) => (i === last ? { ...step, accept: [] } : step)),
  };
  assert.equal(checkWaitProblem(lacking).ok, false);
});
