#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 在庫プールから日々の出題（1日1問×難易度の数）を決めて tsume_data/daily/ に書き出す。
//
// 出題済みの局面は registry.json に控えて二度と出さない。
// ページ側が将棋のルールを知らなくて済むよう、盤面の描画に必要な情報と
// 解答テキストもここで作って持たせる。
//
//   node scripts/tsume/plan.ts --days=30

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  LEVELS,
  LEVEL_LABELS,
  LEVEL_MOVES,
  REUSE_AFTER_DAYS,
  REUSE_ALERT_RATIO,
  SOLUTION_DEDUPE_MIN_MOVES,
  STOCK_ALERT_DAYS,
  STOCK_DAYS,
} from "./config.ts";
import type { Level } from "./config.ts";
import {
  addDays,
  dailyPath,
  daysBetween,
  ensureDirs,
  jstDate,
  readPool,
  readRegistry,
  writeRegistry,
} from "./pool.ts";
import type { PoolProblem, Registry } from "./pool.ts";
import {
  ATTACKER,
  DEFENDER,
  CAPTURED_ORDER,
  calculateValidMovesFor,
  fromSfen,
} from "./position.ts";
import { solutionKey } from "./quality.ts";
import { handLabel, lineLabels, pieceLabel } from "./render.ts";

type RenderCell = {
  x: number;
  y: number;
  /** 盤に描く文字（玉方の玉は「王」） */
  label: string;
  owner: "s" | "g";
  promoted: boolean;
  /** 動かせる駒のマスを薄く光らせる。JS が描き直したときと見た目を合わせるため */
  movable: boolean;
};

type DailyProblem = {
  id: string;
  level: Level;
  levelLabel: string;
  moves: number;
  sfen: string;
  line: PoolProblem["line"];
  /** 解答手順の日本語表記（本文に載せる） */
  solution: string[];
  render: {
    cells: RenderCell[];
    hands: {
      attacker: Array<{ type: string; label: string; count: number }>;
      attackerText: string;
      defender: Array<{ type: string; label: string; count: number }>;
      defenderText: string;
    };
  };
};

function buildRender(problem: PoolProblem): DailyProblem["render"] {
  const pos = fromSfen(problem.sfen);
  const cells: RenderCell[] = [];

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece) continue;
      const isKing = piece.type === "OU";
      cells.push({
        x,
        y,
        label: isKing ? (piece.owner === ATTACKER ? "玉" : "王") : pieceLabel(piece.type),
        owner: piece.owner === ATTACKER ? "s" : "g",
        promoted: piece.type.startsWith("+"),
        movable:
          piece.owner === ATTACKER && calculateValidMovesFor(pos, x, y).length > 0,
      });
    }
  }

  // 詰将棋のルール通り、盤上にも攻方の持ち駒にも無い駒は玉方が持っている。
  // 玉方の駒台も描かないと、合駒があることが利用者に伝わらない。
  const handOf = (owner: typeof ATTACKER) =>
    CAPTURED_ORDER.filter((type) => (pos.hands[owner][type] ?? 0) > 0).map((type) => ({
      type,
      label: pieceLabel(type),
      count: pos.hands[owner][type] ?? 0,
    }));

  return {
    cells,
    hands: {
      attacker: handOf(ATTACKER),
      attackerText: handLabel(pos, ATTACKER),
      defender: handOf(DEFENDER),
      defenderText: handLabel(pos, DEFENDER),
    },
  };
}

function toDailyProblem(problem: PoolProblem, level: Level): DailyProblem {
  const pos = fromSfen(problem.sfen);
  return {
    id: problem.id,
    level,
    levelLabel: LEVEL_LABELS[level],
    moves: problem.moves,
    sfen: problem.sfen,
    line: problem.line,
    solution: lineLabels(pos, problem.line),
    render: buildRender(problem),
  };
}

/**
 * 「予定は作れたが在庫が心もとない」ことを知らせる終了コード。
 *
 * 普通の異常終了（1）と区別しているのは、日次ジョブに続きをやらせたいため。
 * ここで止めるとその日のデプロイまで止まり、出題が古いままになってしまう。
 * .github/workflows/tsume-daily.yml がこの値を見て、デプロイのあとにジョブを赤くする。
 */
const ALERT_EXIT_CODE = 3;

/** 最後に出題した日。まだ一度も出していなければ null。 */
function lastUsed(registry: Registry, key: string): string | null {
  return registry.used[key] ?? null;
}

/** いま出題に使えるか。未出題か、再出題できるだけ日がたっていること。 */
function canOffer(registry: Registry, key: string, moves: number, today: string): boolean {
  const used = lastUsed(registry, key);
  if (used === null) return true;
  const wait = REUSE_AFTER_DAYS[moves];
  return wait !== undefined && daysBetween(used, today) >= wait;
}

async function main(): Promise<void> {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = Number(daysArg ? daysArg.slice(7) : STOCK_DAYS);
  ensureDirs();

  const today = jstDate(Date.now());
  const registry = readRegistry();
  const pools = new Map<number, PoolProblem[]>();
  // 途中まで同じ手順の問題は在庫に残っていても1つしか出さない。
  // 良い方（スコアが高い方）を残す。1手詰は解答が1手しかないので対象外。
  const seenOpenings = new Set<string>();
  for (const moves of LEVELS.map((level) => LEVEL_MOVES[level])) {
    const available = readPool(moves)
      .filter((problem) => canOffer(registry, problem.key, moves, today))
      // 未出題を先に使い、再出題は在庫が尽きたときの穴埋めに回す
      .sort((a, b) => {
        const aUsed = lastUsed(registry, a.key) === null ? 0 : 1;
        const bUsed = lastUsed(registry, b.key) === null ? 0 : 1;
        return aUsed !== bUsed ? aUsed - bUsed : b.score - a.score;
      })
      .filter((problem) => {
        if (moves < SOLUTION_DEDUPE_MIN_MOVES) return true;
        const opening = solutionKey(problem.line);
        if (seenOpenings.has(opening)) return false;
        seenOpenings.add(opening);
        return true;
      });
    pools.set(moves, available);
  }

  let written = 0;
  let reused = 0;
  let firstShortage: string | null = null;

  for (let offset = 0; offset < days; offset++) {
    const date = addDays(today, offset);
    if (existsSync(dailyPath(date))) continue;

    const problems: DailyProblem[] = [];
    const taken: Array<{ problem: PoolProblem; moves: number; previous: string | null }> = [];
    for (const level of LEVELS) {
      const moves = LEVEL_MOVES[level];
      const picked = pools.get(moves)?.shift();
      if (!picked) break;
      problems.push(toDailyProblem(picked, level));
      taken.push({ problem: picked, moves, previous: lastUsed(registry, picked.key) });
      registry.used[picked.key] = date;
    }

    if (problems.length < LEVELS.length) {
      // 全難易度そろわない日は作らない。取り出した問題は台帳ごと戻して、
      // 次回に在庫が増えてから改めて使えるようにする。
      // 再出題の問題は前に出した日付を消してしまわないよう、元の値に戻す
      firstShortage = date;
      for (const { problem, moves, previous } of taken) {
        if (previous === null) delete registry.used[problem.key];
        else registry.used[problem.key] = previous;
        pools.get(moves)?.unshift(problem);
      }
      break;
    }

    writeFileSync(
      dailyPath(date),
      JSON.stringify({ date, problems }, null, 1) + "\n",
    );
    written++;
    reused += taken.filter((t) => t.previous !== null).length;
  }

  writeRegistry(registry);

  const ready = countReadyDays(today);
  console.log(`出題予定を ${written} 日分つくりました（用意できている日数: ${ready}日）`);
  if (firstShortage) console.log(`在庫が足りず ${firstShortage} 以降を作れませんでした`);

  // 再出題で穴埋めできてしまうと在庫切れが表に出なくなるので、割合を必ず報告する
  if (reused > 0) {
    const ratio = reused / (written * LEVELS.length);
    console.log(`うち ${reused} 問は以前に出した問題の再出題です（${Math.round(ratio * 100)}%）`);
    if (ratio > REUSE_ALERT_RATIO) {
      console.error(
        `警告: 新しく作った出題の ${Math.round(ratio * 100)}% が再出題です。` +
          `生成が消費に追いついていないので、generate.ts の時間か目標在庫を増やしてください。`,
      );
      process.exitCode = ALERT_EXIT_CODE;
    }
  }

  if (ready < STOCK_ALERT_DAYS) {
    console.error(
      `在庫が ${ready} 日分しかありません（警告ライン ${STOCK_ALERT_DAYS}日）。生成を増やしてください。`,
    );
    process.exitCode = ALERT_EXIT_CODE;
  }
}

function countReadyDays(today: string): number {
  let count = 0;
  while (existsSync(dailyPath(addDays(today, count)))) count++;
  return count;
}

await main();
