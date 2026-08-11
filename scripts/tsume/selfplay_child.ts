#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 自己対局の子プロセス。詰みで終わった対局だけを1行1JSONで標準出力に流す。
//
// 別プロセスにしてあるのは、やねうら王 WASM が探索中に Node のメインスレッドを
// 専有するため（selfplay.ts の冒頭を参照）。親に同居させると全ワーカーが道連れで止まる。
//
// 標準出力が詰まったら drain を待つので、親の消費速度に合わせて自然に減速する。
// 親が標準入力を閉じたら終了する。
//
//   使い方:
//     node scripts/tsume/selfplay_child.ts --seed=1 --games=2
//     node scripts/tsume/selfplay_child.ts --seed=1            # 止めるまで作り続ける

import { once } from "node:events";

import { SELFPLAY } from "./config.ts";
import { makeRng } from "./search.ts";
import { SelfPlayEngine } from "./selfplay.ts";
import type { Variant } from "./selfplay.ts";

type Options = {
  seed: number;
  /** 0 なら止められるまで作り続ける */
  games: number;
  maxPly: number;
  variant: Variant | undefined;
  /** 親から起動されたときだけ。標準入力が閉じたら終わる */
  watchStdin: boolean;
};

function parseArgs(argv: string[]): Options {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const variant = get("variant");
  return {
    seed: Number(get("seed") ?? 1),
    games: Number(get("games") ?? 0),
    maxPly: Number(get("max-ply") ?? SELFPLAY.maxPly),
    variant: variant === "sse42" || variant === "nosimd" ? variant : undefined,
    watchStdin: argv.includes("--watch-stdin"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // WASM の待ちはイベントループにハンドルを残さないので、
  // 何も置かないと engine.start() の途中で Node が「やることが無い」と判断して終了する。
  const anchor = setInterval(() => undefined, 1 << 30);

  // 親から起動されたときだけ、標準入力が閉じたら終わるようにする。
  // 単体で動かすと標準入力がすぐ EOF になることがあり、無条件だと即終了してしまう。
  if (options.watchStdin) {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  }

  const engine = new SelfPlayEngine({ maxPly: options.maxPly, variant: options.variant });
  await engine.start();
  process.stderr.write(`selfplay: variant=${engine.variant} seed=${options.seed}\n`);

  const rng = makeRng(options.seed);
  let produced = 0;
  const skipped = new Map<string, number>();

  try {
    for (let i = 0; options.games === 0 || i < options.games; i++) {
      const game = await engine.playGame(rng);
      if (game.end !== "mate") {
        skipped.set(game.end, (skipped.get(game.end) ?? 0) + 1);
        process.stderr.write(`selfplay: skip ${game.end} (${game.plies}手)\n`);
        continue;
      }

      const flushed = process.stdout.write(
        JSON.stringify({ moves: game.moves, winner: game.winner, plies: game.plies }) + "\n",
      );
      if (!flushed) await once(process.stdout, "drain");
      produced++;
    }
  } finally {
    const skips = [...skipped].map(([end, n]) => `${end}=${n}`).join(" ") || "なし";
    process.stderr.write(`selfplay: produced=${produced} skipped(${skips})\n`);
    await engine.dispose().catch(() => undefined);
    clearInterval(anchor);
    if (options.watchStdin) process.stdin.pause();
  }
}

main().catch((err) => {
  process.stderr.write(`selfplay: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
