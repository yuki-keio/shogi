// SPDX-License-Identifier: GPL-3.0-only

// 手筋・囲い・戦法の名前を出す機能の型。
// 判定はすべて「盤面を引数で受け取る純粋関数」で、shogi.js のグローバルは一切見ない。

import type { Move, Player } from "../worker/shogi_engine.ts";
import type { ReplayState } from "../kifu/replay.ts";

/** 手筋。継ぎ歩は入れていない */
export type WazaId =
  | "tarefu"
  | "tataki_no_fu"
  | "tokin_zukuri"
  | "wariuchi_no_gin"
  | "fundoshi_no_kei"
  | "oute_bisha"
  | "juji_bisha"
  | "dengaku_zashi"
  | "atama_kin";

export type CastleId =
  | "gin_kanmuri"
  | "fune_gakoi"
  | "kin_muso"
  | "yagura"
  | "kani_gakoi"
  | "kata_mino"
  | "hon_mino"
  | "taka_mino"
  | "ibisha_anaguma"
  | "furibisha_anaguma";

export type StrategyId =
  | "bogin"
  | "naka_bisha"
  | "shiken_bisha"
  | "sanken_bisha"
  | "mukai_bisha";

export type AnyWazaId = WazaId | CastleId | StrategyId;

export type WazaKind = "tesuji" | "castle" | "strategy";

/** 演出の大きさ。頭金だけは階級の外（盤には出さず対局結果にだけ載る） */
export type WazaTier = "big" | "mid" | "small" | "none";

export type Square = { x: number; y: number };

export type WazaHit = {
  kind: WazaKind;
  id: AnyWazaId;
  tier: WazaTier;
  /** 名づけた側（＝その手を指した側） */
  player: Player;
  /** 1始まりの手数 */
  ply: number;
  /** 光らせたいマス。手筋は [着手マス, 標的...]、囲いは必須マス、戦法は [飛or銀のマス] */
  squares: Square[];
};

/** 1手ぶんの判定に要るもの。before は指す前、after は指した後 */
export type MoveContext = {
  before: ReplayState;
  after: ReplayState;
  move: Move;
  ply: number;
};
