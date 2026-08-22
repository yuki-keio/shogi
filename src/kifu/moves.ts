// SPDX-License-Identifier: GPL-3.0-only

// USI の指し手文字列と、盤の座標／マス番号の相互変換。
// 盤の座標は shogi.js と同じ (x, y)。x=0 が９筋、y=0 が一段目。

import {
  BISHOP,
  GOLD,
  KNIGHT,
  LANCE,
  PAWN,
  ROOK,
  SILVER,
  type BasePieceType,
  type Move,
} from "../worker/shogi_engine.ts";

/** URL に載せるときの駒打ちの並び（歩・香・桂・銀・金・角・飛）。設計書 §6 */
export const DROP_ORDER: BasePieceType[] = [
  PAWN,
  LANCE,
  KNIGHT,
  SILVER,
  GOLD,
  BISHOP,
  ROOK,
];

/** USI の打つ駒の文字（P*5e の P） */
const DROP_CHAR_TO_TYPE: Record<string, BasePieceType> = {
  P: PAWN,
  L: LANCE,
  N: KNIGHT,
  S: SILVER,
  G: GOLD,
  B: BISHOP,
  R: ROOK,
};

const TYPE_TO_DROP_CHAR: Record<string, string> = {
  [PAWN]: "P",
  [LANCE]: "L",
  [KNIGHT]: "N",
  [SILVER]: "S",
  [GOLD]: "G",
  [BISHOP]: "B",
  [ROOK]: "R",
};

export function isBaseDropType(type: string): type is BasePieceType {
  return Object.prototype.hasOwnProperty.call(TYPE_TO_DROP_CHAR, type);
}

/** '7g' → { x: 2, y: 6 }。読めなければ null */
export function usiSquareToXY(square: string): { x: number; y: number } | null {
  if (square.length !== 2) return null;
  const file = square.charCodeAt(0) - 48; // '1'..'9'
  const rank = square.charCodeAt(1) - 96; // 'a'..'i' → 1..9
  if (file < 1 || file > 9 || rank < 1 || rank > 9) return null;
  return { x: 9 - file, y: rank - 1 };
}

/** { x: 2, y: 6 } → '7g' */
export function xyToUsiSquare(x: number, y: number): string {
  return `${9 - x}${String.fromCharCode(97 + y)}`;
}

/** マス番号（0〜80）。設計書 §6 の (rank * 9) + (9 - file) と同じ値 */
export function xyToSquareIndex(x: number, y: number): number {
  return y * 9 + x;
}

export function squareIndexToXY(index: number): { x: number; y: number } {
  return { x: index % 9, y: Math.floor(index / 9) };
}

/**
 * USI の指し手を Move に直す。'7g7f' / '7g7f+' / 'P*5e' に対応。
 * 読めない文字列は null（呼び出し側で「棋譜を読み取れませんでした」に落とす）。
 */
export function parseUsiMove(usi: string): Move | null {
  if (typeof usi !== "string") return null;
  const text = usi.trim();

  if (text.length === 4 && text[1] === "*") {
    const pieceType = DROP_CHAR_TO_TYPE[text[0]];
    const to = usiSquareToXY(text.slice(2));
    if (!pieceType || !to) return null;
    return { type: "drop", pieceType, toX: to.x, toY: to.y };
  }

  if (text.length !== 4 && text.length !== 5) return null;
  const promote = text.length === 5;
  if (promote && text[4] !== "+") return null;
  const from = usiSquareToXY(text.slice(0, 2));
  const to = usiSquareToXY(text.slice(2, 4));
  if (!from || !to) return null;
  return {
    type: "move",
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    promote,
  };
}

/** Move → USI 文字列（shogi_engine の toUsiMoveString と同じ結果） */
export function formatUsiMove(move: Move): string {
  if (move.type === "drop") {
    return `${TYPE_TO_DROP_CHAR[move.pieceType]}*${xyToUsiSquare(move.toX, move.toY)}`;
  }
  return (
    xyToUsiSquare(move.fromX, move.fromY) +
    xyToUsiSquare(move.toX, move.toY) +
    (move.promote ? "+" : "")
  );
}

/** USI の指し手として形が正しいか（中身の合法性は見ない） */
export function isUsiMoveToken(token: string): boolean {
  return parseUsiMove(token) !== null;
}
