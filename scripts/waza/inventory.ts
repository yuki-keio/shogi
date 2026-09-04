#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
//
// 手筋・囲い・戦法の棚卸し。実戦の棋譜を通して「何が何回出るか」を数える。
// 判定が正しくても、小技が1局に何度も鳴れば「うるさい」になる。本番に出す前にここで見る。
//
//   使い方:
//     node scripts/tsume/selfplay_child.ts --seed=1 --games=300 > /tmp/games.jsonl
//     node scripts/waza/inventory.ts --in=/tmp/games.jsonl
//     node scripts/waza/inventory.ts --in=/tmp/games.jsonl --samples-out=/tmp/waza.jsonl
//
// 入力は selfplay_child.ts がそのまま吐く JSONL（1行 = {moves, winner, plies}）。

import { createReadStream } from "node:fs";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { replayUsiMoves } from "../../src/kifu/replay.ts";
import { scanWaza } from "../../src/waza/index.ts";
import { WAZA_NAMES } from "../../src/waza/names.ts";
import type { AnyWazaId, WazaKind } from "../../src/waza/types.ts";

type Row = { id: AnyWazaId; kind: WazaKind; count: number; games: number; plies: number[] };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const KIND_ORDER: WazaKind[] = ["tesuji", "castle", "strategy"];
const KIND_LABEL: Record<WazaKind, string> = {
  tesuji: "手筋",
  castle: "囲い",
  strategy: "戦法",
};

async function main(): Promise<void> {
  const input = arg("in");
  if (!input) {
    console.error("--in=<selfplay の JSONL> を指定してください");
    process.exit(1);
  }
  const sampleLimit = Number(arg("samples") ?? 5);
  const samplesOut = arg("samples-out");

  const table = new Map<AnyWazaId, Row>();
  const samples: Array<Record<string, unknown>> = [];
  let games = 0;
  let unreadable = 0;
  let totalPlies = 0;

  const reader = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
  for await (const line of reader) {
    const text = line.trim();
    if (!text) continue;
    let parsed: { moves?: string[] };
    try {
      parsed = JSON.parse(text) as { moves?: string[] };
    } catch {
      unreadable += 1;
      continue;
    }
    const moves = parsed.moves;
    if (!Array.isArray(moves) || moves.length === 0) {
      unreadable += 1;
      continue;
    }

    const replay = replayUsiMoves(moves);
    if (!replay.ok) {
      unreadable += 1;
      continue;
    }
    games += 1;
    totalPlies += moves.length;

    const scan = scanWaza(moves, replay);
    const seenThisGame = new Set<AnyWazaId>();
    for (const found of scan.hits) {
      let row = table.get(found.id);
      if (!row) {
        row = { id: found.id, kind: found.kind, count: 0, games: 0, plies: [] };
        table.set(found.id, row);
      }
      row.count += 1;
      row.plies.push(found.ply);
      if (!seenThisGame.has(found.id)) {
        row.games += 1;
        seenThisGame.add(found.id);
      }
      if (samplesOut && row.plies.length <= sampleLimit) {
        samples.push({
          id: found.id,
          ply: found.ply,
          player: found.player,
          usi: moves[found.ply - 1],
          moves: moves.slice(0, found.ply),
        });
      }
    }
  }

  if (games === 0) {
    console.error("読める対局がありませんでした");
    process.exit(1);
  }

  console.log(`局数 ${games} / 読めなかった ${unreadable} / 平均 ${(totalPlies / games).toFixed(1)}手\n`);
  for (const kind of KIND_ORDER) {
    const rows = [...table.values()].filter((row) => row.kind === kind);
    rows.sort((a, b) => b.count - a.count);
    console.log(`${KIND_LABEL[kind]}            回数    /局    出た局   初出ply中央値`);
    if (rows.length === 0) console.log("  （なし）");
    for (const row of rows) {
      const name = WAZA_NAMES[row.id].name.padEnd(12, "　").slice(0, 8);
      const perGame = (row.count / games).toFixed(2);
      const ratio = `${((row.games / games) * 100).toFixed(0)}%`;
      console.log(
        `  ${name}${String(row.count).padStart(6)}${perGame.padStart(8)}` +
          `${ratio.padStart(9)}${String(median(row.plies)).padStart(12)}`,
      );
    }
    console.log("");
  }

  // 1つも出なかったものは、条件が厳し過ぎるかバグ
  const missing = (Object.keys(WAZA_NAMES) as AnyWazaId[]).filter((id) => !table.has(id));
  if (missing.length > 0) {
    console.log(`0回だったもの: ${missing.map((id) => WAZA_NAMES[id].name).join("・")}`);
  }

  if (samplesOut) {
    writeFileSync(samplesOut, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
    console.log(`\nサンプル局面を ${samplesOut} に書きました（${samples.length}件）`);
  }
}

await main();
