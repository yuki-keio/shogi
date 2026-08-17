// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// ブラウザで動かす詰み探索（src/tsume/solver.ts）の検証。
//   npm test          … 軽い検証だけ（数十秒）
//   npm run test:pool … 在庫の全王手を総当たりする重い検証も含む（8分前後）
//
// test:pool は自動では動かない。在庫（tsume_data/pool/）を補充・入れ替えたら
// 手で回すこと。日次ジョブ（.github/workflows/tsume-daily.yml）は在庫を足すが
// テストは走らせないので、そこは人の仕事として残っている。
//
// 在庫の問題は KomoringHeights で「ちょうどN手詰・余詰なし・駒余りなし」と
// 確認済みなので、そのまま答え合わせに使える。ここが通れば、ブラウザの判定は
// 出題を検証したエンジンと同じ結論を出すと言える。
//
// 速度もここで実測する。ブラウザで玉方の応手を待たせる時間の上限になるため、
// 分布（95%点）が遅くなったらテストが落ちる。最遅の1件はマシンの混み具合で
// 大きく振れるので、判定はせず注意表示だけにしている。

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

/**
 * 在庫の全王手を総当たりする検証（作意から外れた王手には必ず逃げ道が見つかる）は
 * 空いたマシンで8分前後、他の重い処理と並走すると35〜45分かかり、
 * npm test の所要時間のほぼ全部を占めていた（残り全部で30秒）。
 *
 * 中身は「在庫データが正しいか」の検証なので、意味があるのは
 * tsume_data/pool/ を補充・入れ替えたときだけ。ふだんの npm test では飛ばし、
 * npm run test:pool のときだけ走らせる。検証の中身は削っていない。
 */
const runPoolSweep = process.env.TSUME_POOL_SWEEP === "1";

/** 最遅の1件がこれを超えたら注意を促す。判定はしない（下の理由参照）。 */
const SLOWEST_HINT_MS = 9000;

const poolSweepSkip = !hasPool
  ? true
  : runPoolSweep
    ? false
    : "在庫更新時のみ実行（npm run test:pool）";

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
    //
    // 時間ではなく節点数で頭打ちにする（PROOF_BUDGET と同じ理由）。ここは速さでなく
    // 「詰むか」の判定なので、時計で切ると混んでいるマシンで null（結論が出なかった）
    // になって落ちる。実際 timeMs:8000 の頃、load 29.9 で落ちて 4.8 では通った。
    // timeMs を省くと既定の1500msが効いてしまうので、明示的に無効化しておく。
    const budget = problem.moves >= 11
      ? { nodes: 30_000_000, timeMs: 600_000 }
      : { nodes: 3_000_000, timeMs: 600_000 };
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
  // 初形からの証明は実行時には通らない経路なので、遅くても利用者には影響しない。
  // しかも壁時計はマシンの混み具合で数倍に振れる（load 24.7 で 10321ms、
  // 空いていれば 1〜2秒）。判定にすると落ちても直す先が無いので、目安の表示だけ。
  if (slowest >= SLOWEST_HINT_MS) {
    console.warn(
      `  ⚠ 1問あたりの最遅が ${slowest.toFixed(0)}ms（目安 ${SLOWEST_HINT_MS}ms）: ${slowestId}\n` +
        `    マシンが混んでいただけかもしれない。空いた状態でも出るなら探索の劣化を疑う`,
    );
  }
});

/** 判定を取り直すときの予算。時計では切らず、節点数だけで頭打ちにする。 */
const PROOF_BUDGET = { nodes: 20_000_000, timeMs: 600_000 };

test("作意から外れた王手には必ず逃げ道が見つかる", { skip: poolSweepSkip }, () => {
  let escapes = 0;
  let allLose = 0;
  let unreadable = 0;
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
        const played = findDefense(after, remaining - 1, budgetForRemaining(remaining - 1));
        const elapsed = performance.now() - started;
        elapsedAll.push(elapsed);
        if (elapsed > slowest) {
          slowest = elapsed;
          slowestLabel = `${problem.id} ${text}`;
        }

        // partial は「時間内に読み切れなかった」。それが出るかどうかは走らせた機械の
        // 速さと、そのときの混み具合で変わる。判定まで時計に左右させると、
        // 同じコードで通ったり落ちたりするので、時間で切られない予算で取り直す。
        // 速さのほうは上の elapsedAll（実際の予算での実測）で別に見張っている。
        if (played.kind === "partial") unreadable++;
        const result = played.kind === "partial"
          ? findDefense(after, remaining - 1, PROOF_BUDGET)
          : played;

        if (step && step.accept.includes(text)) {
          // 作意どおりの手なら、玉方はどう応じても手数内に詰む
          assert.ok(
            result.kind === "allLose" || result.kind === "mated",
            `${problem.id} ${text} は正解手なのに逃げられている (${result.kind})`,
          );
          allLose++;
        } else if (problem.moves <= YOZUME_STRICT_MAX_MOVES) {
          // 短手数は余詰なしを検証済みなので、作意以外の王手には必ず逃げ道がある。
          // partial（読み切れなかった）で済ませずに、最後まで証明できること
          assert.equal(
            result.kind,
            "escape",
            `${problem.id} ${text} で玉方が凌げない (${result.kind})`,
          );
          escapes++;
        } else {
          // 長手数は余詰を許しているので、作意以外の王手でも詰むことがある。
          // escape でも allLose でもよいが、読み切れずに partial へ落ちるのは困る。
          // 手は返るので利用者は指し続けられるものの、粘りの裏付けが落ちるため。
          assert.ok(
            result.kind === "escape" || result.kind === "allLose",
            `${problem.id} ${text} を読み切れていない (${result.kind})`,
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
    `  逃げ切り ${escapes}件 / 詰み ${allLose}件 / 実予算で読み切れず ${unreadable}件 / ` +
      `95%点 ${p95.toFixed(0)}ms / 最遅 ${slowest.toFixed(0)}ms (${slowestLabel})`,
  );
  assert.ok(p95 < 1500, `応手選びが遅すぎる: 95%点が ${p95.toFixed(0)}ms`);

  // 最遅の1件は判定に使わない。同じコード・同じ在庫で 6386ms と 12079ms に振れた
  // 実績があり（差はマシンの混み具合だけ）、落ちても直す先が無いため。
  // 予算そのものが壊れれば分布ごと動いて上の95%点が捕まえる。ここは目安の表示だけ。
  if (slowest >= SLOWEST_HINT_MS) {
    console.warn(
      `  ⚠ 最遅が ${slowest.toFixed(0)}ms（目安 ${SLOWEST_HINT_MS}ms）: ${slowestLabel}\n` +
        `    マシンが混んでいただけかもしれないが、95%点も上がっているなら予算設定を疑う`,
    );
  }
});

test("詰んでいる局面では mated を返す", { skip: !hasPool }, () => {
  const problem = POOL.find((p) => p.moves === 1);
  if (!problem) return;
  const pos = fromSfen(problem.sfen);
  const after = applyMoveToPosition(pos, moveOf(pos, problem.line[0].attack));
  assert.equal(findDefense(toSolverPosition(after), 0).kind, "mated");
});

/**
 * 遅い端末の代わり。予算をほぼ0にすると、どんなに速い機械でも読み切れなくなる。
 *
 * ここで手が返らないと、ブラウザ側は利用者の正しい王手を突き返すしかなくなる。
 * それがこの機能でいちばん悪い体験なので、証明が間に合わなくても手は必ず返す。
 */
test("予算を使い切っても必ず手を返す", { skip: !hasPool }, () => {
  let partials = 0;
  for (const problem of POOL.filter((p) => p.moves >= 9)) {
    const pos = fromSfen(problem.sfen);
    for (const check of enumerateCheckingMoves(pos)) {
      const after = toSolverPosition(applyMoveToPosition(pos, check));
      const result = findDefense(after, problem.moves - 1, { nodes: 1, timeMs: 1 });
      assert.ok(
        result.kind !== "mated" ? typeof result.usi === "string" && result.usi.length > 0 : true,
        `${problem.id} ${usi(check)} で手が返らない (${result.kind})`,
      );
      if (result.kind === "partial") {
        assert.ok(
          result.provenDepth >= 0 && result.provenDepth < problem.moves - 1,
          `${problem.id} ${usi(check)} の provenDepth がおかしい (${result.provenDepth})`,
        );
        partials++;
      }
    }
  }
  // 予算1節点で読み切れてしまっているなら、この検証は何も見張れていない
  assert.ok(partials > 0, "予算を絞っても partial が出ない（テストが効いていない）");
});
