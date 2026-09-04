// SPDX-License-Identifier: GPL-3.0-only

// 駒の価値。ai-worker.js の PIECE_VALUES と同じ数字を使う（リポジトリ内で表を増やさない）。

import {
  BISHOP,
  GOLD,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  PROMOTED_BISHOP,
  PROMOTED_KNIGHT,
  PROMOTED_LANCE,
  PROMOTED_PAWN,
  PROMOTED_ROOK,
  PROMOTED_SILVER,
  ROOK,
  SILVER,
  baseTypeOf,
  type PieceType,
} from "../worker/shogi_engine.ts";

export const INFINITY = 1_000_000;

/** 盤の上に立っているときの価値 */
export const BOARD_VALUE: Record<PieceType, number> = {
  [PAWN]: 100,
  [LANCE]: 400,
  [KNIGHT]: 400,
  [SILVER]: 500,
  [GOLD]: 600,
  [BISHOP]: 800,
  [ROOK]: 900,
  [KING]: INFINITY,
  [PROMOTED_PAWN]: 650,
  [PROMOTED_LANCE]: 650,
  [PROMOTED_KNIGHT]: 650,
  [PROMOTED_SILVER]: 650,
  [PROMOTED_BISHOP]: 1000,
  [PROMOTED_ROOK]: 1100,
};

/**
 * その駒が取られたときに動く駒割の総量。
 *
 * 🔴 盤上の価値だけで数えてはいけない。取った側は盤上からその駒を消すだけでなく、
 *    持ち駒が1枚増える。と金を取って手に入るのは「歩」なので 650 + 100 = 750。
 *    ここを分けないと「銀でと金を取って歩で取り返される」が得と判定される。
 */
export function exchangeValue(type: PieceType): number {
  if (type === KING) return INFINITY;
  return BOARD_VALUE[type] + BOARD_VALUE[baseTypeOf(type)];
}
