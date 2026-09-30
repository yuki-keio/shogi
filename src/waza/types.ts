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
  | "atama_kin"
  | "hara_kin"
  | "sokofu"
  | "aki_oute"
  | "ryo_oute"
  | "keito_no_gin";

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
  | "furibisha_anaguma"
  | "hidari_mino"
  | "gangi";

export type StrategyId =
  | "bogin"
  | "migi_shiken_bisha"
  | "naka_bisha"
  | "shiken_bisha"
  | "sanken_bisha"
  | "mukai_bisha"
  | "kakugawari"
  | "ishida_ryu"
  | "ureshino_ryu";

export type AnyWazaId = WazaId | CastleId | StrategyId;

export type WazaKind = "tesuji" | "castle" | "strategy";

/** 演出の大きさ。頭金・腹金は階級の外（詰みの手なので、盤には出さず対局結果にだけ載る） */
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
  /**
   * 光らせたいマス。手筋は [着手マス, 標的...]、囲いは必須マス、戦法は [飛or銀のマス]。
   * 開き王手は [王手をかけた駒, 玉]。角換わりは空（交換した後は盤に角がいないので、札だけ出す）
   */
  squares: Square[];
  /** 先頭のマスのほかに、標的へ線を引く駒（両王手の2枚目） */
  alsoFrom?: Square[];
};

/** 1手ぶんの判定に要るもの。before は指す前、after は指した後 */
export type MoveContext = {
  before: ReplayState;
  after: ReplayState;
  move: Move;
  ply: number;
};
