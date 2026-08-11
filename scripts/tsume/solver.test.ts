// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// ブラウザで動かす詰み探索（src/tsume/solver.ts）の検証。
//   node --test scripts/tsume/solver.test.ts
//
// 在庫の問題は KomoringHeights で「ちょうどN手詰・余詰なし・駒余りなし」と
// 確認済みなので、そのまま答え合わせに使える。ここが通れば、ブラウザの判定は
// 出題を検証したエンジンと同じ結論を出すと言える。
//
// 速度もここで実測する。ブラウザで玉方の応手を待たせる時間の上限になるため、
// 遅くなったらテストが落ちるようにしてある。

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  budgetForRemaining,
  debugGenerateMoves,
  findDefense,
  isMateWithin,
  type SolverPosition,
} from "../../src/tsume/solver.ts";
import {
  applyMoveToPosition,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  fromSfen,
  usi,
  type Position,
} from "./position.ts";
import { YOZUME_STRICT_MAX_MOVES } from "./config.ts";
import { POOL_DIR } from "./pool.ts";

type PoolProblem = {
  id: string;
  moves: number;
  sfen: string;
  line: Array<{ accept: string[]; attack: string; defend: string | null }>;
};

function loadPool(): PoolProblem[] {
  const problems: PoolProblem[] = [];
  let files: string[];
  try {
    files = readdirSync(POOL_DIR).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return problems;
  }
  for (const name of files) {
    const text = readFileSync(join(POOL_DIR, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      problems.push(JSON.parse(line) as PoolProblem);
    }
  }
  return problems;
}

const POOL = loadPool();

/** 在庫が無いクローンでもテストを落とさない。生成は CI 側の仕事。 */
const hasPool = POOL.length > 0;

/** 探索に渡す形。position.ts の Position はそのまま使える。 */
function toSolverPosition(pos: Position): SolverPosition {
  return { board: pos.board, hands: pos.hands };
}

/** 作意手順をたどりながら、攻方手番の局面を順に返す。 */
function attackerNodes(problem: PoolProblem): Array<{ pos: Position; remaining: number }> {
  const nodes: Array<{ pos: Position; remaining: number }> = [];
  let pos = fromSfen(problem.sfen);
  let remaining = problem.moves;
  for (const step of problem.line) {
    nodes.push({ pos, remaining });
    pos = applyMoveToPosition(pos, moveOf(pos, step.attack));
    remaining--;
    if (step.defend === null) break;
    pos = applyMoveToPosition(pos, moveOf(pos, step.defend));
    remaining--;
  }
  return nodes;
}

function moveOf(pos: Position, text: string) {
  for (const move of enumerateLegalMoves(pos)) {
    if (usi(move) === text) return move;
  }
  throw new Error(`合法手に無い: ${text}`);
}

test("手の生成が出題の検証と一致する", { skip: !hasPool }, () => {
  let checked = 0;
  for (const problem of POOL) {
    for (const { pos } of attackerNodes(problem)) {
      // 攻方手番: 王手の一覧が一致するか
      const expectedChecks = enumerateCheckingMoves(pos).map(usi).sort();
      const actual = debugGenerateMoves(toSolverPosition(pos));
      assert.deepEqual(
        actual.attackerChecks,
        expectedChecks,
        `${problem.id} の王手生成がずれている`,
      );

      // 玉方手番: 合法手の一覧が一致するか
      for (const check of enumerateCheckingMoves(pos)) {
        const after = applyMoveToPosition(pos, check);
        const expectedDefense = enumerateLegalMoves(after).map(usi).sort();
        const actualDefense = debugGenerateMoves(toSolverPosition(after)).defenderMoves;
        assert.deepEqual(
          actualDefense,
          expectedDefense,
          `${problem.id} ${usi(check)} のあとの玉方の手がずれている`,
        );
        checked++;
      }
    }
  }
  console.log(`  手の生成を照合した局面: ${checked}`);
});

test("在庫の全問がちょうどその手数で詰む", { skip: !hasPool }, () => {
  let slowest = 0;
  let slowestId = "";
  let totalMs = 0;

  for (const problem of POOL) {
    const pos = toSolverPosition(fromSfen(problem.sfen));
    const started = performance.now();

    // 初形からの詰み証明は実行時には通らない経路なので、予算は多めに取る。
    // 玉方が持ち駒を持つと合駒の分岐が増え、長手数は既定の予算では結論が出ない。
    const budget = problem.moves >= 11 ? { nodes: 30_000_000, timeMs: 8000 } : undefined;
    assert.equal(
      isMateWithin(pos, problem.moves, budget),
      true,
      `${problem.id}: ${problem.moves}手で詰むはず`,
    );
    if (problem.moves >= 3) {
      assert.equal(
        isMateWithin(pos, problem.moves - 2, budget),
        false,
        `${problem.id}: ${problem.moves - 2}手では詰まないはず（最短性）`,
      );
    }

    const elapsed = performance.now() - started;
    totalMs += elapsed;
    if (elapsed > slowest) {
      slowest = elapsed;
      slowestId = problem.id;
    }
  }

  console.log(
    `  ${POOL.length}問 / 合計 ${totalMs.toFixed(0)}ms / 最遅 ${slowest.toFixed(0)}ms (${slowestId})`,
  );
  // 初形からの証明は実行時には通らないので、ここは「異常に遅くないこと」だけ見る
  assert.ok(slowest < 9000, `1問あたりが遅すぎる: ${slowestId} で ${slowest.toFixed(0)}ms`);
});

test("作意から外れた王手には必ず逃げ道が見つかる", { skip: !hasPool }, () => {
  let escapes = 0;
  let allLose = 0;
  let slowest = 0;
  let slowestLabel = "";
  const elapsedAll: number[] = [];

  for (const problem of POOL) {
    for (const { pos, remaining } of attackerNodes(problem)) {
      const step = problem.line[problem.moves - remaining >> 1];
      for (const check of enumerateCheckingMoves(pos)) {
        const text = usi(check);
        const after = toSolverPosition(applyMoveToPosition(pos, check));

        const started = performance.now();
        const result = findDefense(after, remaining - 1, budgetForRemaining(remaining - 1));
        const elapsed = performance.now() - started;
        elapsedAll.push(elapsed);
        if (elapsed > slowest) {
          slowest = elapsed;
          slowestLabel = `${problem.id} ${text}`;
        }

        if (step && step.accept.includes(text)) {
          // 作意どおりの手なら、玉方はどう応じても手数内に詰む
          assert.ok(
            result.kind === "allLose" || result.kind === "mated",
            `${problem.id} ${text} は正解手なのに逃げられている (${result.kind})`,
          );
          allLose++;
        } else if (problem.moves <= YOZUME_STRICT_MAX_MOVES) {
          // 短手数は余詰なしを検証済みなので、作意以外の王手には必ず逃げ道がある
          assert.equal(
            result.kind,
            "escape",
            `${problem.id} ${text} で玉方が凌げない (${result.kind})`,
          );
          escapes++;
        } else {
          // 長手数は余詰を許しているので、作意以外の王手でも詰むことがある。
          // どちらでもよいが「結論が出せない」だけは困る。
          // 利用者の正しい手を拒否してしまうのが、この機能でいちばん悪い体験なので。
          assert.notEqual(
            result.kind,
            "unknown",
            `${problem.id} ${text} で結論が出せない（正しい手を拒否してしまう）`,
          );
          if (result.kind === "escape") escapes++;
          else allLose++;
        }
      }
    }
  }

  // 速さは最遅の1件ではなく分布で見る。
  //
  // ブラウザ側の予算は長手数で3秒（solver.ts の LONG_BUDGET）なので、3秒近くで
  // 止まっている1件は「予算が効いている」だけで、遅くなった証拠ではない。
  // 実際、最遅だけを 3.6秒 で見ていた頃は、直前のテストが確保した大きな置換表の
  // 後片付けに巻き込まれて 7秒超になり、同じコードで通ったり落ちたりしていた。
  // そこで、ふだんの速さは 95パーセンタイルで見張り、最遅は「予算そのものが
  // 壊れていないか」の粗い網として緩く見る。
  elapsedAll.sort((a, b) => a - b);
  const p95 = elapsedAll[Math.floor(elapsedAll.length * 0.95)] ?? 0;

  console.log(
    `  逃げ切り ${escapes}件 / 詰み ${allLose}件 / ` +
      `95%点 ${p95.toFixed(0)}ms / 最遅 ${slowest.toFixed(0)}ms (${slowestLabel})`,
  );
  assert.ok(p95 < 1500, `応手選びが遅すぎる: 95%点が ${p95.toFixed(0)}ms`);
  assert.ok(
    slowest < 9000,
    `予算が効いていない疑い: ${slowestLabel} で ${slowest.toFixed(0)}ms`,
  );
});

test("詰んでいる局面では mated を返す", { skip: !hasPool }, () => {
  const problem = POOL.find((p) => p.moves === 1);
  if (!problem) return;
  const pos = fromSfen(problem.sfen);
  const after = applyMoveToPosition(pos, moveOf(pos, problem.line[0].attack));
  assert.equal(findDefense(toSolverPosition(after), 0).kind, "mated");
});

test("予算を絞ると unknown を返す（推測で手を返さない）", { skip: !hasPool }, () => {
  const problem = POOL.filter((p) => p.moves === 9)[0];
  if (!problem) return;
  const pos = fromSfen(problem.sfen);
  const wrong = enumerateCheckingMoves(pos).find((m) => !problem.line[0].accept.includes(usi(m)));
  if (!wrong) return;
  const after = toSolverPosition(applyMoveToPosition(pos, wrong));
  const result = findDefense(after, problem.moves - 1, { nodes: 1, timeMs: 1 });
  assert.ok(
    result.kind === "unknown" || result.kind === "escape",
    `予算切れなら unknown か、確実な escape のどちらかであるべき (${result.kind})`,
  );
});
