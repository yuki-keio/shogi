// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋ソルバー（KomoringHeights）を子プロセスで動かす USI ラッパ。
//
// 実機で確認したエンジンの挙動（kh-v1.1.0）:
//   - `go mate <ms>` の終端行は `checkmate <PV>` / `checkmate nomate` / `checkmate timeout`
//   - PostSearchLevel=MinLength（既定値）のとき、返る手数は「厳密な最短詰み手数」
//   - MultiPV を大きくすると、**全ての王手** について
//     `info ... score mate <N> ... multipv <k> pv <手...>` を出す。
//     N は「その手から始めたときの厳密な詰み手数」、詰まない手は -9999。
//     → OR節点1つにつきクエリ1回で、王手全部の詰み手数が手に入る。
//   - PvInterval を大きくすると途中経過を出さず、探索完了時の1ブロックだけになる。
//   - USI_Hash の既定値は 4096(MB)。指定しないと確保だけで数秒かかるので必ず設定する。
//   - 攻方の玉が盤上に無い SFEN をそのまま受け付ける。

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RootMove = {
  /** USI 形式の指し手 */
  move: string;
  /** その手から数えた厳密な詰み手数。詰まないときは null */
  mateLen: number | null;
  /** 詰み手順（エンジンが返した PV） */
  pv: string[];
};

export type MateResult =
  | { kind: "mate"; len: number; pv: string[]; rootMoves: RootMove[] }
  | { kind: "nomate"; rootMoves: RootMove[] }
  /** 時間・ノード上限に達して結論が出なかった */
  | { kind: "unknown"; rootMoves: RootMove[] };

export type EngineOptions = {
  binPath: string;
  hashMb?: number;
  threads?: number;
  /** 0 で無制限 */
  nodesLimit?: number;
  /** 王手ごとの詰み手数が欲しいときだけ大きくする */
  multiPv?: number;
};

const NO_MATE_SCORE = -9999;

/** 起動時だけ長めに待つ。ハッシュの確保に時間がかかることがある */
const START_TIMEOUT_MS = 120_000;

export class UsiEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lineHandlers: Array<(line: string) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private currentMultiPv = 1;
  private currentNodesLimit = 0;
  // Node の型ストリップ実行はコンストラクタ引数プロパティを解釈できないため、明示的に持つ
  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const proc = spawn(this.opts.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr.resume();
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      for (const handler of this.lineHandlers) handler(line);
    });

    // 起動は既定より長く待つ。何本ものエンジンが同時にハッシュを確保すると
    // 30秒では間に合わず、ワーカーごと失われる（実測で5本中4本が起動に失敗した）。
    await this.waitFor("usi", (line) => line === "usiok", START_TIMEOUT_MS);

    this.currentMultiPv = this.opts.multiPv ?? 1;
    this.currentNodesLimit = this.opts.nodesLimit ?? 0;
    const options: Array<[string, string | number]> = [
      ["Threads", this.opts.threads ?? 1],
      ["USI_Hash", this.opts.hashMb ?? 256],
      ["PostSearchLevel", "MinLength"],
      ["GenerateAllLegalMoves", "true"],
      // 途中経過を抑えて、探索完了時の 1 ブロックだけを読む
      ["PvInterval", 1000000],
      ["MultiPV", this.currentMultiPv],
      ["NodesLimit", this.currentNodesLimit],
    ];
    for (const [name, value] of options) this.send(`setoption name ${name} value ${value}`);
    await this.waitFor("isready", (line) => line === "readyok", START_TIMEOUT_MS);
  }

  /**
   * 詰みを問い合わせる。
   * withRootMoves=true のときは MultiPV を上げて全王手の手数を集める。
   */
  async solveMate(args: {
    sfen: string;
    moves?: string[];
    timeMs: number;
    withRootMoves?: boolean;
    nodesLimit?: number;
  }): Promise<MateResult> {
    return this.enqueue(async () => {
      await this.start();
      await this.applyRuntimeOptions(args.withRootMoves ?? false, args.nodesLimit);

      const position =
        args.moves && args.moves.length > 0
          ? `position sfen ${args.sfen} moves ${args.moves.join(" ")}`
          : `position sfen ${args.sfen}`;
      this.send(position);

      const blocks: RootMove[][] = [];
      let block: RootMove[] = [];
      let terminal = "";

      await this.collect(
        `go mate ${args.timeMs}`,
        (line) => {
          if (line.startsWith("checkmate")) {
            terminal = line;
            return true;
          }
          const parsed = parseMultiPvLine(line);
          if (parsed) {
            // multipv 番号が巻き戻ったら新しいブロックの始まり
            if (parsed.index <= block.length) {
              if (block.length > 0) blocks.push(block);
              block = [];
            }
            block.push({ move: parsed.move, mateLen: parsed.mateLen, pv: parsed.pv });
          }
          return false;
        },
        args.timeMs * 3 + 10000,
      );
      if (block.length > 0) blocks.push(block);

      const rootMoves = blocks.length > 0 ? blocks[blocks.length - 1] : [];
      const rest = terminal.slice("checkmate".length).trim();
      if (rest === "" || rest === "timeout") return { kind: "unknown", rootMoves };
      if (rest === "nomate") return { kind: "nomate", rootMoves };
      const pv = rest.split(/\s+/);
      return { kind: "mate", len: pv.length, pv, rootMoves };
    });
  }

  /**
   * 置換表を捨てて次の問題に備える。
   * 前の問題の結果が残っていると、同じ問い合わせでも返る手数が変わることがある。
   */
  async newGame(): Promise<void> {
    return this.enqueue(async () => {
      await this.start();
      this.send("usinewgame");
      await this.waitFor("isready", (line) => line === "readyok");
    });
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.lineHandlers = [];
    try {
      proc.stdin.write("quit\n");
    } catch {
      // 既に落ちている場合は無視
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // --- 内部 ---------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // 失敗しても後続を止めない
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyRuntimeOptions(withRootMoves: boolean, nodesLimit?: number): Promise<void> {
    // MultiPV=800 は KomoringHeights の上限。王手が800手を超えることはない。
    const wantMultiPv = withRootMoves ? (this.opts.multiPv ?? 800) : 1;
    const wantNodes = nodesLimit ?? this.opts.nodesLimit ?? 0;
    if (wantMultiPv === this.currentMultiPv && wantNodes === this.currentNodesLimit) return;
    if (wantMultiPv !== this.currentMultiPv) {
      this.send(`setoption name MultiPV value ${wantMultiPv}`);
      this.currentMultiPv = wantMultiPv;
    }
    if (wantNodes !== this.currentNodesLimit) {
      this.send(`setoption name NodesLimit value ${wantNodes}`);
      this.currentNodesLimit = wantNodes;
    }
    await this.waitFor("isready", (line) => line === "readyok");
  }

  private send(command: string): void {
    if (!this.proc) throw new Error("engine is not running");
    this.proc.stdin.write(command + "\n");
  }

  private waitFor(command: string, isDone: (line: string) => boolean, timeoutMs = 30000) {
    return this.collect(command, isDone, timeoutMs);
  }

  /** command を送り、isDone が true を返す行まで待つ。 */
  private collect(
    command: string,
    isDone: (line: string) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const handler = (line: string) => {
        let done = false;
        try {
          done = isDone(line);
        } catch (err) {
          cleanup();
          reject(err);
          return;
        }
        if (done) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        // ハングしたエンジンは次回 start() で作り直す
        void this.kill();
        reject(new Error(`engine timeout while waiting for "${command}"`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.lineHandlers = this.lineHandlers.filter((h) => h !== handler);
      };

      this.lineHandlers.push(handler);
      try {
        this.send(command);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  private async kill(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.lineHandlers = [];
    proc.kill("SIGKILL");
  }
}

/** `info ... score mate N ... multipv K pv M1 M2 ...` を読む。 */
function parseMultiPvLine(
  line: string,
): { index: number; move: string; mateLen: number | null; pv: string[] } | null {
  if (!line.startsWith("info ")) return null;
  const multipv = /\bmultipv (\d+)\b/.exec(line);
  const score = /\bscore mate (-?\d+)\b/.exec(line);
  const pvIndex = line.indexOf(" pv ");
  if (!multipv || !score || pvIndex === -1) return null;

  const pv = line.slice(pvIndex + 4).trim().split(/\s+/);
  if (pv.length === 0 || pv[0] === "") return null;

  const raw = Number(score[1]);
  return {
    index: Number(multipv[1]),
    move: pv[0],
    mateLen: raw === NO_MATE_SCORE || raw < 0 ? null : raw,
    pv,
  };
}
