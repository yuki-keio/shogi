// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 自己対局用の USI ラッパ。リポジトリ同梱のやねうら王 WASM を Node で直接動かす。
//
// 実機で確認した挙動:
//   - yaneuraou/{sse42,nosimd}/yaneuraou.js は -s ENVIRONMENT=web,worker,node で
//     ビルドされているので createRequire でそのまま読める。評価関数は WASM に埋め込み済み
//     （EVAL_EMBEDDING=ON, NNUE KP256）なので、評価関数ファイルの用意は要らない。
//   - 826k nps / モジュール初期化 17ms / readyok 58ms
//   - **探索中は Node のメインスレッドを専有する。** 1353ms の探索の間、タイマーが1回も動かない。
//     generate.ts は1プロセスで複数ワーカーと KomoringHeights 子プロセスを回しているので、
//     そこに同居させると全ワーカーと USI のタイムアウトが巻き添えで止まる。
//     必ず selfplay_child.ts で別プロセスに隔離すること。
//   - MinimumThinkingTime の下限が 1000ms なので go btime/wtime は使えない。必ず go nodes。
//   - ResignValue の既定は 99999。合法手が無いときだけ bestmove resign を返すので、
//     これが実質の詰み検出になる（isCheckmate で裏を取っている）。
//   - EnteringKingRule の既定は CSARule27。NoEnteringKing にしないと、
//     詰みに至る前に宣言勝ちで対局が終わってしまう。
//   - USI_OwnBook の既定は true だが BookFile は no_book なので定跡は無い。
//     棋譜の散らし方は openingMultiPv 側で用意する。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GOTE, SENTE, isCheckmate } from "../../src/worker/shogi_engine.ts";
import type { Player } from "../../src/worker/shogi_engine.ts";
import { SELFPLAY } from "./config.ts";
import { initialPosition } from "./mine.ts";
import { applyMoveToPosition, moveFromUsi, toSfen } from "./position.ts";
import type { Position } from "./position.ts";
import type { Rng } from "./rng.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Variant = "sse42" | "nosimd";

export type SelfPlayOptions = {
  variant?: Variant;
  hashMb?: number;
  maxPly?: number;
  openingPlies?: number;
  openingMultiPv?: number;
  nodesChoices?: number[];
};

export type GameEnd = "mate" | "plycap" | "repetition" | "aborted";

export type SelfPlayGame = {
  /** 平手初形からの USI 指し手列 */
  moves: string[];
  /** 詰ませた側。end が "mate" のときだけ意味を持つ */
  winner: Player | null;
  plies: number;
  end: GameEnd;
  /** 手番ごとの思考ノード数（棋譜を再現するための記録） */
  nodes: { sente: number; gote: number };
};

/** WASM モジュールのうち、こちらで使う部分だけ。 */
type WasmModule = {
  addMessageListener(listener: (line: string) => void): void;
  postMessage(command: string): void;
};

const READY_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 120_000;

function pick<T>(rng: Rng, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export class SelfPlayEngine {
  private module: WasmModule | null = null;
  private pending: ((line: string) => void) | null = null;
  private currentMultiPv = 1;
  private usedVariant: Variant | null = null;
  // Node の型ストリップ実行はコンストラクタ引数プロパティを解釈できないため、明示的に持つ
  private readonly opts: SelfPlayOptions;

  constructor(opts: SelfPlayOptions = {}) {
    this.opts = opts;
  }

  get variant(): Variant | null {
    return this.usedVariant;
  }

  async start(): Promise<void> {
    if (this.module) return;

    const require = createRequire(import.meta.url);
    const variants: Variant[] = this.opts.variant ? [this.opts.variant] : ["sse42", "nosimd"];

    let lastError: unknown = null;
    for (const variant of variants) {
      const dir = join(REPO_ROOT, "yaneuraou", variant);
      try {
        const factory = require(join(dir, "yaneuraou.js")) as (
          config: { locateFile: (file: string) => string },
        ) => Promise<WasmModule>;
        const module = await factory({ locateFile: (file) => join(dir, file) });
        module.addMessageListener((line) => {
          this.pending?.(line);
        });
        this.module = module;
        this.usedVariant = variant;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!this.module) {
      throw new Error(`やねうら王 WASM を読み込めない: ${String(lastError)}`);
    }

    await this.waitFor("usi", (line) => line === "usiok", READY_TIMEOUT_MS);

    this.currentMultiPv = 1;
    const options: Array<[string, string | number]> = [
      ["Threads", 1],
      ["USI_Hash", this.opts.hashMb ?? SELFPLAY.hashMb],
      // 合法手が無いときだけ投了させる。評価値による投了は詰みまで指させたいので封じる
      ["ResignValue", 99999],
      // 宣言勝ちで対局が終わると詰み局面が採れない
      ["EnteringKingRule", "NoEnteringKing"],
      ["USI_OwnBook", "false"],
      ["MultiPV", 1],
      // 途中経過を抑えて、探索完了時のブロックだけを読む
      ["PvInterval", 1_000_000],
    ];
    for (const [name, value] of options) this.send(`setoption name ${name} value ${value}`);

    await this.waitFor("isready", (line) => line === "readyok", READY_TIMEOUT_MS);
  }

  /**
   * 1局指して棋譜を返す。詰み以外で終わった対局も end を付けて返すので、
   * 採用するかどうかは呼び出し側が決める。
   */
  async playGame(rng: Rng): Promise<SelfPlayGame> {
    const maxPly = this.opts.maxPly ?? SELFPLAY.maxPly;
    const openingPlies = this.opts.openingPlies ?? SELFPLAY.openingPlies;
    const openingMultiPv = this.opts.openingMultiPv ?? SELFPLAY.openingMultiPv;
    const choices = this.opts.nodesChoices ?? SELFPLAY.nodesChoices;

    // 強さに差を付けて決着を付きやすくする。同じ強さ同士だと棋譜がほぼ同一になる
    const nodes = { sente: pick(rng, choices), gote: pick(rng, choices) };

    this.send("usinewgame");

    let pos: Position = initialPosition();
    const moves: string[] = [];
    const seen = new Map<string, number>();
    seen.set(toSfen(pos, 1), 1);

    const done = (end: GameEnd, winner: Player | null): SelfPlayGame => ({
      moves,
      winner,
      plies: moves.length,
      end,
      nodes,
    });

    while (moves.length < maxPly) {
      const inOpening = moves.length < openingPlies;
      await this.setMultiPv(inOpening ? openingMultiPv : 1);

      const result = await this.search(moves, pos.turn === SENTE ? nodes.sente : nodes.gote);
      const best = result.best;

      if (best === null || best === "resign") {
        // 合法手が無い＝詰み。念のため自前のルール実装で裏を取る
        if (isCheckmate(pos.turn, pos.board, pos.hands)) {
          return done("mate", pos.turn === SENTE ? GOTE : SENTE);
        }
        return done("aborted", null);
      }
      // EnteringKingRule=NoEnteringKing なので本来出ないが、出たら捨てる
      if (best === "win") return done("aborted", null);

      const chosen = this.chooseMove(pos, best, result.candidates, inOpening, rng);
      if (chosen === null) return done("aborted", null);

      pos = applyMoveToPosition(pos, moveFromUsi(chosen, pos));
      moves.push(chosen);

      const key = toSfen(pos, 1);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count >= 4) return done("repetition", null);
    }

    return done("plycap", null);
  }

  async dispose(): Promise<void> {
    if (!this.module) return;
    this.pending = null;
    this.module.postMessage("quit");
    this.module = null;
  }

  // --- 内部 ---------------------------------------------------------------

  /**
   * 序盤だけ MultiPV の候補手からこちらの乱数で選び、棋譜を散らす。
   * エンジンの SkillLevel は時刻由来の乱数なので、--seed の再現性を壊す。使わない。
   */
  private chooseMove(
    pos: Position,
    best: string,
    candidates: string[],
    inOpening: boolean,
    rng: Rng,
  ): string | null {
    const legal = (text: string): boolean => {
      try {
        moveFromUsi(text, pos);
        return true;
      } catch {
        return false;
      }
    };

    if (inOpening && candidates.length > 1) {
      const usable = candidates.filter(legal);
      if (usable.length > 0) return pick(rng, usable);
    }
    return legal(best) ? best : null;
  }

  private async setMultiPv(value: number): Promise<void> {
    if (this.currentMultiPv === value) return;
    this.send(`setoption name MultiPV value ${value}`);
    this.currentMultiPv = value;
  }

  private async search(
    moves: string[],
    nodes: number,
  ): Promise<{ best: string | null; candidates: string[] }> {
    this.send(`position startpos${moves.length > 0 ? ` moves ${moves.join(" ")}` : ""}`);
    const lines = await this.waitFor(
      `go nodes ${nodes}`,
      (line) => line.startsWith("bestmove"),
      SEARCH_TIMEOUT_MS,
    );

    let best: string | null = null;
    // multipv 1 が来るたびに捨てて、最後の1ブロックだけを残す
    const block = new Map<number, string>();
    for (const line of lines) {
      if (line.startsWith("bestmove")) {
        best = line.split(/\s+/)[1] ?? null;
        continue;
      }
      const pvAt = line.indexOf(" pv ");
      if (pvAt < 0) continue;
      const first = line.slice(pvAt + 4).trim().split(/\s+/)[0];
      if (!first) continue;
      const matched = /\bmultipv (\d+)\b/.exec(line);
      const index = matched ? Number(matched[1]) : 1;
      if (index === 1) block.clear();
      block.set(index, first);
    }

    return { best, candidates: [...block.values()] };
  }

  private send(command: string): void {
    if (!this.module) throw new Error("engine not started");
    this.module.postMessage(command);
  }

  /**
   * command を送って terminal 行が来るまでの出力を集める。
   * 受信ハンドラを先に張ってから送ること（送信は同期的にエンジンを走らせる）。
   */
  private waitFor(
    command: string | null,
    terminal: (line: string) => boolean,
    timeoutMs: number,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`engine timeout: ${command ?? "(no command)"}`));
      }, timeoutMs);

      this.pending = (line) => {
        lines.push(line);
        if (!terminal(line)) return;
        clearTimeout(timer);
        this.pending = null;
        resolve(lines);
      };

      if (command !== null) this.send(command);
    });
  }
}
