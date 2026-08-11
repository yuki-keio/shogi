// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 局面と手順の日本語表記。ターミナルでの目視確認と、
// ページに焼き込む解答テキスト（SEO 用の本文）の両方で使う。

import {
  ATTACKER,
  CAPTURED_ORDER,
  DEFENDER,
  applyMoveToPosition,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  usi,
} from "./position.ts";
import type { Move, PieceType, Position } from "./position.ts";
import type { SolutionStep } from "./verify.ts";

const PIECE_KANJI: Record<PieceType, string> = {
  FU: "歩",
  KY: "香",
  KE: "桂",
  GI: "銀",
  KI: "金",
  KA: "角",
  HI: "飛",
  OU: "玉",
  "+FU": "と",
  "+KY": "成香",
  "+KE": "成桂",
  "+GI": "成銀",
  "+KA": "馬",
  "+HI": "竜",
};

const ZEN_NUM = ["１", "２", "３", "４", "５", "６", "７", "８", "９"];
const KAN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 内部座標 (x,y) を「５二」のような表記にする。x=0 が9筋。 */
export function squareLabel(x: number, y: number): string {
  return `${ZEN_NUM[8 - x]}${KAN_NUM[y]}`;
}

export function pieceLabel(type: PieceType): string {
  return PIECE_KANJI[type];
}

/**
 * 1手を棋譜表記にする。同じ地点に複数の駒が動ける場合の区別は
 * 「(移動元の筋段)」を添えて確実に一意にする（KIF の簡易版）。
 */
export function moveLabel(pos: Position, move: Move): string {
  const dest = squareLabel(move.toX, move.toY);
  if (move.type === "drop") {
    return `${dest}${PIECE_KANJI[move.pieceType]}打`;
  }
  const piece = pos.board[move.fromY][move.fromX];
  if (!piece) return `${dest}?`;
  const from = `${ZEN_NUM[8 - move.fromX]}${KAN_NUM[move.fromY]}`;
  const promote = move.promote ? "成" : "";
  return `${dest}${PIECE_KANJI[piece.type]}${promote}(${from})`;
}

/** 作意手順を「▲５二金打 △同玉 ▲…」の形にする。 */
export function lineLabels(pos: Position, line: SolutionStep[]): string[] {
  const out: string[] = [];
  let cur = pos;
  let lastDest: { x: number; y: number } | null = null;

  for (const step of line) {
    const attack = enumerateCheckingMoves(cur).find((m) => usi(m) === step.attack);
    if (!attack) break;
    out.push("▲" + withSame(cur, attack, lastDest));
    lastDest = { x: attack.toX, y: attack.toY };
    cur = applyMoveToPosition(cur, attack);

    if (step.defend === null) break;
    const defend = enumerateLegalMoves(cur).find((m) => usi(m) === step.defend);
    if (!defend) break;
    out.push("△" + withSame(cur, defend, lastDest));
    lastDest = { x: defend.toX, y: defend.toY };
    cur = applyMoveToPosition(cur, defend);
  }
  return out;
}

function withSame(pos: Position, move: Move, lastDest: { x: number; y: number } | null): string {
  if (lastDest && move.toX === lastDest.x && move.toY === lastDest.y && move.type === "move") {
    const piece = pos.board[move.fromY][move.fromX];
    const from = `${ZEN_NUM[8 - move.fromX]}${KAN_NUM[move.fromY]}`;
    return `同${piece ? PIECE_KANJI[piece.type] : "?"}${move.promote ? "成" : ""}(${from})`;
  }
  return moveLabel(pos, move);
}

/** 持ち駒の日本語表記。「金二 銀」のように並べる。 */
export function handLabel(pos: Position, owner: string): string {
  const parts: string[] = [];
  for (const type of CAPTURED_ORDER) {
    const count = pos.hands[owner as never][type] ?? 0;
    if (count <= 0) continue;
    parts.push(PIECE_KANJI[type] + (count > 1 ? KAN_NUM[count - 1] : ""));
  }
  return parts.length > 0 ? parts.join(" ") : "なし";
}

/** ターミナルで目視するための盤面。 */
export function asciiBoard(pos: Position): string {
  const lines: string[] = [];
  lines.push("  ９ ８ ７ ６ ５ ４ ３ ２ １");
  for (let y = 0; y < 9; y++) {
    let row = "|";
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece) {
        row += " ・";
        continue;
      }
      const kanji = PIECE_KANJI[piece.type];
      const glyph = kanji.length > 1 ? kanji[1] : kanji;
      row += (piece.owner === DEFENDER ? "v" : " ") + glyph;
    }
    lines.push(row + `|${KAN_NUM[y]}`);
  }
  lines.push(`攻方(先手)持駒: ${handLabel(pos, ATTACKER)}`);
  lines.push(`玉方(後手)持駒: ${handLabel(pos, DEFENDER)}`);
  return lines.join("\n");
}
