// SPDX-License-Identifier: GPL-3.0-only

// 棋譜の表記（▲７六歩 / △同　銀 / ▲５五銀成 / ▲２三歩打）。設計書 §7
//
// 一覧の表示と KIF の書き出しの両方がここを通る。
// 🔴 同じ種類の駒が同じマスへ行けるときは 右/左/直/上/寄/引 で区別する。
//    合法手生成（src/worker/shogi_engine.ts）を使って「他に行ける同種の自駒があるか」を調べる。
//    KIF は移動元を括弧で書くので、曖昧さ解消は付けない。

import {
  calculateValidMoves,
  isInPromotionZone,
  pieceInfo,
  SENTE,
  type Board,
  type PieceType,
  type Player,
} from "../worker/shogi_engine.ts";
import { parseUsiMove } from "./moves.ts";
import type { Move } from "../worker/shogi_engine.ts";
import { replayUsiMoves, type ReplayResult } from "./replay.ts";

const FILE_KANJI = ["１", "２", "３", "４", "５", "６", "７", "８", "９"];
const RANK_KANJI = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 棋譜で使う駒名（と金は「と」、成銀は「成銀」。盤上の1文字表記とは別） */
export const KIFU_PIECE_NAMES: Record<string, string> = {
  OU: "玉",
  HI: "飛",
  KA: "角",
  KI: "金",
  GI: "銀",
  KE: "桂",
  KY: "香",
  FU: "歩",
  "+HI": "龍",
  "+KA": "馬",
  "+GI": "成銀",
  "+KE": "成桂",
  "+KY": "成香",
  "+FU": "と",
};

export type NotationEntry = {
  /** 1始まりの手数 */
  ply: number;
  player: Player;
  /** 一覧・バーに出す表記（▲７六歩 / △同　銀） */
  text: string;
  /** KIF の指手欄（７六歩(77) / 同　銀(88) / ２三歩打） */
  kif: string;
  usi: string;
};

function squareText(x: number, y: number): string {
  return FILE_KANJI[8 - x] + RANK_KANJI[y];
}

/** KIF の移動元表記（7七 → '77'） */
function kifFromSquare(x: number, y: number): string {
  return `${9 - x}${y + 1}`;
}

/**
 * 同じマスへ行ける同種の自駒が他にあるとき、区別の文字を返す。
 * 先手の視点で、上＝相手側へ進む・寄＝真横・引＝手前へ戻る。
 * 右／左は指す人から見た向き（先手は x が大きいほど右）。
 *
 * 🔴 連盟の表記法は「動作が先、左右はあと」。まず 上／寄／引 で分け、
 *    それでも他の駒と区別が付かないときだけ 左／右／直 を使い、
 *    さらに足りなければ 左上・左引 のように重ねる（設計書 §7）。
 *    例：３八と４九に金があって４九の金が３九へ寄る手は ▲３九金寄（▲３九金左ではない）。
 * 🔴 竜と馬だけは「直」を使わない決まりなので、相手の駒の反対側を 左／右 で名乗る。
 */
function disambiguation(
  board: Board,
  player: Player,
  type: PieceType,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  const rivals: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      if (x === fromX && y === fromY) continue;
      const piece = board[y][x];
      if (!piece || piece.owner !== player || piece.type !== type) continue;
      const moves = calculateValidMoves(x, y, piece, board);
      if (moves.some((m) => m.x === toX && m.y === toY)) rivals.push({ x, y });
    }
  }
  if (rivals.length === 0) return "";

  const forward = (fy: number) => (player === SENTE ? fy - toY : toY - fy);
  const rightward = (fx: number) => (player === SENTE ? fx - toX : toX - fx);
  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

  // まず動作だけで決まるか
  const myV = sign(forward(fromY));
  const vertical = myV > 0 ? "上" : myV < 0 ? "引" : "寄";
  if (rivals.every((r) => sign(forward(r.y)) !== myV)) return vertical;

  // 決まらないので左右へ。到達地点と同じ筋から上がる手は「直」（竜・馬を除く）
  let myH = sign(rightward(fromX));
  if (myH === 0) {
    if (myV > 0 && type !== "+HI" && type !== "+KA") return "直";
    // 竜・馬。他の駒がみな左にいれば自分は「右」、みな右にいれば「左」
    const sides = rivals.map((r) => sign(rightward(r.x)));
    if (sides.every((s) => s < 0)) myH = 1;
    else if (sides.every((s) => s > 0)) myH = -1;
    // 相手も同じ筋、という盤面は作れない（竜・馬は2枚までで、同じ筋の2枚は互いに道を塞ぐ）。念のための保険
    else return vertical;
  }

  const lateral = myH > 0 ? "右" : "左";
  if (rivals.every((r) => sign(rightward(r.x)) !== myH)) return lateral;
  return lateral + vertical;
}

/** 成らずに指したとき「不成」と書く必要があるか（成れる場面で成らなかったとき） */
function needsNoPromoteMark(
  type: PieceType,
  player: Player,
  fromY: number,
  toY: number,
): boolean {
  if (!pieceInfo[type]?.canPromote) return false;
  return isInPromotionZone(player, fromY) || isInPromotionZone(player, toY);
}

/**
 * 1手ぶんの表記を作る。盤とその手番だけあれば決まるので、盤を作ってそのまま試せる。
 * previousTo は直前の手の移動先（同じマスなら「同　」になる）。
 */
export function notateMove(
  board: Board,
  player: Player,
  move: Move,
  previousTo: { x: number; y: number } | null,
): { text: string; kif: string } {
  const mark = player === SENTE ? "▲" : "△";
  const sameSquare =
    previousTo !== null && previousTo.x === move.toX && previousTo.y === move.toY;
  const place = sameSquare ? "同　" : squareText(move.toX, move.toY);

  if (move.type === "drop") {
    const name = KIFU_PIECE_NAMES[move.pieceType] ?? move.pieceType;
    return { text: `${mark}${place}${name}打`, kif: `${place}${name}打` };
  }

  const piece = board[move.fromY][move.fromX];
  const type = (piece?.type ?? "FU") as PieceType;
  const name = KIFU_PIECE_NAMES[type] ?? type;
  const suffix = move.promote
    ? "成"
    : needsNoPromoteMark(type, player, move.fromY, move.toY)
      ? "不成"
      : "";
  const relative = disambiguation(
    board,
    player,
    type,
    move.fromX,
    move.fromY,
    move.toX,
    move.toY,
  );
  return {
    text: `${mark}${place}${name}${relative}${suffix}`,
    kif: `${place}${name}${suffix}(${kifFromSquare(move.fromX, move.fromY)})`,
  };
}

/** previous の表記が今回の手順の頭とそっくり同じなら、その続きだけ作ればよい */
function reusableNotationCount(
  previous: readonly NotationEntry[] | undefined,
  usiMoves: readonly string[],
): number {
  if (!previous || previous.length === 0) return 0;
  if (previous.length > usiMoves.length) return 0;
  return previous.every((entry, i) => entry.usi === usiMoves[i]) ? previous.length : 0;
}

/**
 * 手順ぜんぶの表記を作る。読めない手に当たったら、そこまでを返す。
 * 局面の再生は replay.ts に任せる（同じルールを二度書かない）。
 *
 * previous に前回の結果を渡すと、共通の頭の部分は作り直さずに続きだけ足す。
 * 曖昧さ解消のたびに合法手を数えるので、毎手ぶん作り直すと終盤ほど重くなる。
 */
export function buildNotation(
  usiMoves: readonly string[],
  replay?: ReplayResult,
  previous?: readonly NotationEntry[],
): NotationEntry[] {
  const result = replay ?? replayUsiMoves(usiMoves);
  const reusable = reusableNotationCount(previous, result.usiMoves);
  const entries: NotationEntry[] = reusable > 0 ? previous!.slice(0, reusable) : [];
  let previousTo: { x: number; y: number } | null = null;
  if (reusable > 0) {
    const lastMove = parseUsiMove(result.usiMoves[reusable - 1]);
    if (lastMove) previousTo = { x: lastMove.toX, y: lastMove.toY };
  }

  for (let i = reusable; i < result.usiMoves.length; i++) {
    const usi = result.usiMoves[i];
    const move = parseUsiMove(usi);
    const before = result.states[i];
    if (!move || !before) break;

    const player = before.currentPlayer;
    const { text, kif } = notateMove(before.board, player, move, previousTo);
    entries.push({ ply: i + 1, player, text, kif, usi });
    previousTo = { x: move.toX, y: move.toY };
  }

  return entries;
}

/** 一行バー用。「同　飛」の全角スペースを詰めた短い形 */
export function compactNotation(text: string): string {
  return text.replace("　", "");
}
