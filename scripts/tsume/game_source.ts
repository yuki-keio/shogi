// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 自己対局の子プロセスを束ねて、詰みで終わった棋譜を親に供給する。
//
// 子プロセスに分けているのは、やねうら王 WASM が探索中に Node のメインスレッドを
// 専有するため（selfplay.ts の冒頭を参照）。ここは待つだけなので親の邪魔をしない。
//
// 子が全部倒れたら next() は null を返す。呼び出し側はそれを合図に探索生成へ縮退すること。

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Player } from "../../src/worker/shogi_engine.ts";

const CHILD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "selfplay_child.ts");

/** 子プロセスが1行1件で流してくる棋譜。 */
export type MinedGame = {
  moves: string[];
  winner: Player;
  plies: number;
};

export type GameSourceOptions = {
  procs: number;
  seed: number;
  maxPly?: number;
  /** 1プロセスあたりの先読み上限。これ以上溜まったら子を待たせる */
  queuePerProc?: number;
};

const MAX_RESTARTS = 3;

export class GameSource {
  private readonly opts: GameSourceOptions;
  private children: ChildProcessWithoutNullStreams[] = [];
  private queue: MinedGame[] = [];
  private waiters: Array<(game: MinedGame | null) => void> = [];
  private alive = 0;
  private restarts = 0;
  private produced = 0;
  private stopped = false;

  constructor(opts: GameSourceOptions) {
    this.opts = opts;
  }

  start(): void {
    for (let i = 0; i < this.opts.procs; i++) this.spawnChild(i);
  }

  /** 次の棋譜。子が全滅したら null。 */
  next(): Promise<MinedGame | null> {
    const ready = this.queue.shift();
    if (ready) return Promise.resolve(ready);
    if (this.stopped || this.alive === 0) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stats(): { produced: number; alive: number; queued: number } {
    return { produced: this.produced, alive: this.alive, queued: this.queue.length };
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const child of this.children) {
      // 対局の途中でも用は済んでいるので待たずに畳む。
      // 標準入力を閉じるのは、SIGTERM を取りこぼしたときの保険
      child.stdin.end();
      child.kill("SIGTERM");
    }
    this.children = [];
    this.alive = 0;
    this.flushWaiters();
  }

  // --- 内部 ---------------------------------------------------------------

  private spawnChild(index: number): void {
    if (this.stopped) return;

    // 子ごとに種を変える。同じ種だと全員が同じ棋譜を作ってしまう
    const seed = (this.opts.seed + index * 7919) >>> 0;
    const args = [CHILD_SCRIPT, `--seed=${seed}`, "--watch-stdin"];
    if (this.opts.maxPly) args.push(`--max-ply=${this.opts.maxPly}`);

    const child = spawn(process.execPath, ["--no-warnings", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    this.children.push(child);
    this.alive++;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.trim() === "") return;
      let game: MinedGame;
      try {
        game = JSON.parse(line) as MinedGame;
      } catch {
        return;
      }
      this.produced++;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(game);
        return;
      }
      this.queue.push(game);
      this.throttle(child);
    });

    child.on("exit", () => {
      this.alive--;
      this.children = this.children.filter((c) => c !== child);
      if (this.stopped) {
        this.flushWaiters();
        return;
      }
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        this.spawnChild(index);
        return;
      }
      if (this.alive === 0) this.flushWaiters();
    });
  }

  /**
   * 先読みが溜まりすぎたら読むのを止める。
   * 読むのを止めるとパイプが詰まり、子は書き込みの drain 待ちで自然に減速する。
   * ここで止めないと、親が消費するより速く棋譜が溜まり続ける。
   */
  private throttle(child: ChildProcessWithoutNullStreams): void {
    const limit = this.opts.procs * (this.opts.queuePerProc ?? 4);
    if (this.queue.length < limit) return;

    child.stdout.pause();
    const check = (): void => {
      if (this.stopped) return;
      if (this.queue.length < limit) {
        child.stdout.resume();
        return;
      }
      // タイマーでプロセスを生かし続けないよう unref する
      setTimeout(check, 200).unref();
    };
    setTimeout(check, 200).unref();
  }

  /** 供給が終わったことを待っている呼び出し側に伝える。 */
  private flushWaiters(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(null);
  }
}
