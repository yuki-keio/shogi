// SPDX-License-Identifier: GPL-3.0-only

// 利きの計算。駒の動きは PIECE_MOVEMENTS（shogi_engine.ts）から組み立てる。
// 将棋のルールをここに書き写さないこと。

import {
  KNIGHT,
  PIECE_MOVEMENTS,
  SENTE,
  type Board,
  type Dir,
  type Piece,
  type Player,
} from "../worker/shogi_engine.ts";
import type { Square } from "./types.ts";

const EMPTY_DIRS: Dir[] = [];

export function dirsOf(piece: Piece): Dir[] {
  return PIECE_MOVEMENTS[piece.owner][piece.type] ?? EMPTY_DIRS;
}

export function onBoard(x: number, y: number): boolean {
  return x >= 0 && x < 9 && y >= 0 && y < 9;
}

/** 前へ進む向き（先手は y が減る） */
export function forwardOf(player: Player): number {
  return player === SENTE ? -1 : 1;
}

/**
 * (fromX,fromY) の駒が (toX,toY) に利いているか。あいだに駒があれば通らない。
 * 「利いている」なので、行き先に自分の駒があっても true（取り返しの計算に要る）。
 */
export function attacksSquare(
  board: Board,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const piece = board[fromY][fromX];
  if (!piece) return false;
  const ddx = toX - fromX;
  const ddy = toY - fromY;
  if (ddx === 0 && ddy === 0) return false;

  for (const dir of dirsOf(piece)) {
    if (dir.range === 1) {
      if (dir.dx === ddx && dir.dy === ddy) return true;
      continue;
    }
    // 走る駒。向きが合っていて、あいだが空いているか
    if (dir.dx === 0 && ddx !== 0) continue;
    if (dir.dy === 0 && ddy !== 0) continue;
    if (dir.dx !== 0 && dir.dy !== 0 && Math.abs(ddx) !== Math.abs(ddy)) continue;
    if (dir.dx !== 0 && Math.sign(ddx) !== dir.dx) continue;
    if (dir.dy !== 0 && Math.sign(ddy) !== dir.dy) continue;
    const dist = Math.max(Math.abs(ddx), Math.abs(ddy));
    if (dist > dir.range) continue;
    let blocked = false;
    for (let i = 1; i < dist; i++) {
      if (board[fromY + dir.dy * i][fromX + dir.dx * i]) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 取り合い計算のための下ごしらえ
// ---------------------------------------------------------------------------

export type RayEntry = { x: number; y: number; piece: Piece; dist: number };

/** 対象マスから外へ伸ばした1本の線。近い順に、途中の駒を全部拾う */
export type Ray = { dx: number; dy: number; entries: RayEntry[] };

export const RAY_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * 対象マスから8方向へ、並んでいる駒を近い順に全部拾う。
 * 手前の駒を1枚どけると次が利いてくる（香の後ろの香、飛の後ろの飛）ので、
 * 取り合いの途中で盤を複製せずにインデックスを進めるだけで済ませたい。
 */
export function raysAround(board: Board, x: number, y: number): Ray[] {
  const rays: Ray[] = [];
  for (const [dx, dy] of RAY_DIRS) {
    const entries: RayEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      const cx = x + dx * i;
      const cy = y + dy * i;
      if (!onBoard(cx, cy)) break;
      const piece = board[cy][cx];
      if (piece) entries.push({ x: cx, y: cy, piece, dist: i });
    }
    rays.push({ dx, dy, entries });
  }
  return rays;
}

/** 距離 dist・向き (dx,dy) の先にある対象マスへ、この駒が届くか */
export function reachesAlong(piece: Piece, dx: number, dy: number, dist: number): boolean {
  for (const dir of dirsOf(piece)) {
    if (dir.dx === -dx && dir.dy === -dy && dir.range >= dist) return true;
  }
  return false;
}

/** 対象マスに利いている桂のマス（最大2つ） */
export function knightAttackers(
  board: Board,
  x: number,
  y: number,
  side: Player,
): Square[] {
  const oy = side === SENTE ? y + 2 : y - 2;
  if (oy < 0 || oy > 8) return [];
  const found: Square[] = [];
  for (const ox of [x - 1, x + 1]) {
    if (ox < 0 || ox > 8) continue;
    const piece = board[oy][ox];
    if (piece && piece.owner === side && piece.type === KNIGHT) found.push({ x: ox, y: oy });
  }
  return found;
}
