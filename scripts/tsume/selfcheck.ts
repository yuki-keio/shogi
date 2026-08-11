#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 在庫の自己点検。生成時とは独立にもう一度ソルバーへかけ直し、
// 手数・余詰・駒余り・作意手順の再生をすべて確かめる。
//
//   node scripts/tsume/selfcheck.ts              # プール全部
//   node scripts/tsume/selfcheck.ts --show=3     # 合格した問題を3つ盤面つきで表示
//   node scripts/tsume/selfcheck.ts --daily=7    # 直近7日分の出題予定だけ

import { existsSync, readFileSync } from "node:fs";

import { ENGINE, LEVELS, LEVEL_MOVES, YOZUME_STRICT_MAX_MOVES } from "./config.ts";
import { dailyPath, jstDate, addDays, readPool } from "./pool.ts";
import type { PoolProblem } from "./pool.ts";
import { canonicalKey, fromSfen } from "./position.ts";
import { minScoreFor, scoreProblem } from "./quality.ts";
import { asciiBoard, lineLabels } from "./render.ts";
import { resolveEngineBinary } from "./engine_path.ts";
import { UsiEngine } from "./usi_engine.ts";
import { replayMainLine, verifyProblem } from "./verify.ts";

/** 難易度の定義と食い違わないよう LEVEL_MOVES から導く。ここを固定値にすると新しい手数が点検されない */
const LADDER = LEVELS.map((level) => LEVEL_MOVES[level]).sort((a, b) => a - b);

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function collectProblems(): PoolProblem[] {
  const dailyDays = Number(arg("daily", "0"));
  if (dailyDays > 0) {
    const out: PoolProblem[] = [];
    const today = jstDate(Date.now());
    for (let i = 0; i < dailyDays; i++) {
      const path = dailyPath(addDays(today, i));
      if (!existsSync(path)) continue;
      const day = JSON.parse(readFileSync(path, "utf8")) as { problems: PoolProblem[] };
      out.push(...day.problems);
    }
    return out;
  }
  return LADDER.flatMap((moves) => readPool(moves));
}

/**
 * 面白さスコアの分布。minScore の水準を決めるために使う。
 *
 * 在庫に記録されている値をそのまま読む。ここで scoreProblem を呼び直してはいけない。
 * 採用時のスコアには「詰まし方の少なさ」の加点（uniquenessBonus）が入っており、
 * それはソルバーに聞かないと分からないので再現できない。
 * 再計算すると最大1.5点低く出て、下限を決める材料としてずれる。
 */
function reportScores(problems: PoolProblem[]): void {
  const byMoves = new Map<number, number[]>();
  for (const problem of problems) {
    const list = byMoves.get(problem.moves) ?? [];
    list.push(problem.score);
    byMoves.set(problem.moves, list);
  }
  console.log("手数  問題数   最小   中央    最大  現在の下限  下限を満たす数");
  for (const moves of [...byMoves.keys()].sort((a, b) => a - b)) {
    const scores = (byMoves.get(moves) ?? []).sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)];
    const limit = minScoreFor(moves);
    const passing = scores.filter((s) => s >= limit).length;
    console.log(
      `${String(moves).padStart(2)}手  ${String(scores.length).padStart(5)}  ` +
        `${scores[0].toFixed(1).padStart(5)}  ${median.toFixed(1).padStart(5)}  ` +
        `${scores[scores.length - 1].toFixed(1).padStart(5)}  ${limit.toFixed(1).padStart(9)}  ` +
        `${String(passing).padStart(12)}`,
    );
  }
}

async function main(): Promise<void> {
  const show = Number(arg("show", "0"));
  const problems = collectProblems();
  if (problems.length === 0) {
    console.log("点検する問題がありません。");
    return;
  }

  if (process.argv.includes("--scores")) {
    reportScores(problems);
    return;
  }

  const engine = new UsiEngine({ binPath: resolveEngineBinary(), hashMb: ENGINE.hashMb });
  await engine.start();

  let ok = 0;
  const failures: string[] = [];
  const seenKeys = new Map<string, string>();
  let shown = 0;

  for (const problem of problems) {
    const pos = fromSfen(problem.sfen);

    const key = canonicalKey(pos);
    const dup = seenKeys.get(key);
    if (dup) failures.push(`${problem.id}: ${dup} と同一局面`);
    seenKeys.set(key, problem.id);

    const replayError = replayMainLine(pos, problem.line);
    if (replayError) {
      failures.push(`${problem.id}: 手順を再生できない (${replayError})`);
      continue;
    }

    const result = await verifyProblem(engine, pos, problem.moves, {
      ...((problem.moves) > YOZUME_STRICT_MAX_MOVES ? ENGINE.strictLong : ENGINE.strict),
      // 生成時と同じ基準で見る。長手数は余詰を許しているので、ここで落としてはいけない
      yozume: problem.moves <= YOZUME_STRICT_MAX_MOVES ? "strict" : "off",
    });
    if (!result.ok) {
      failures.push(`${problem.id}: ${result.reason}`);
      continue;
    }
    const recorded = problem.line.map((s) => s.attack + "/" + (s.defend ?? "")).join(" ");
    const fresh = result.problem.line.map((s) => s.attack + "/" + (s.defend ?? "")).join(" ");
    if (recorded !== fresh) {
      failures.push(`${problem.id}: 作意手順が一致しない\n    記録: ${recorded}\n    再検証: ${fresh}`);
      continue;
    }
    ok++;

    if (shown < show) {
      shown++;
      console.log(`\n--- ${problem.id} (${problem.moves}手詰 score=${problem.score}) ---`);
      console.log(asciiBoard(pos));
      console.log("解答: " + lineLabels(pos, problem.line).join(" "));
    }
  }

  await engine.dispose();

  console.log(`\n点検: ${ok}/${problems.length} 問が合格`);
  if (failures.length > 0) {
    console.log("不合格:");
    for (const failure of failures) console.log("  " + failure);
    process.exitCode = 1;
  }
}

await main();
