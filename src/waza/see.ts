// SPDX-License-Identifier: GPL-3.0-only

// 取り合い計算（SEE）。誤検出を止める「2つの門」はどちらもこれ1本で書ける。
//
// 門1「指した駒は残るか」… 着手マスの取り合いを数え、相手が取って得なら名前を出さない。
// 門2「目的が成立しているか」… 標的を本当にただで取れるかを、同じ計算で見る。
//
// 香・飛・角の「後ろ抜け」（手前の1枚をどけると後ろの駒が利いてくる）を数えるため、
// 対象マスから8方向に並んだ駒を先に全部拾っておき、駒をどけたらインデックスを進める。
// 盤を複製しないのはこのため。
//
// 既知の近似（読みは入れないという仕様どおり）:
//   - ピンを見ない（動かせないはずの駒で取り返す計算になることがある）
//   - 取り返すときの成りを見ない（指した手そのものの成りは after の駒種で正確）
//   - 合駒・玉の逃げを見ない

import {
  GOTE,
  KING,
  SENTE,
  getOpponent,
  type Board,
  type Piece,
  type Player,
} from "../worker/shogi_engine.ts";
import { knightAttackers, raysAround, reachesAlong, type Ray } from "./attack.ts";
import { WAZA_CONFIG } from "./config.ts";
import { exchangeValue } from "./values.ts";

type Candidate = { piece: Piece; rayIndex: number; knightIndex: number };

type Swap = {
  rays: Ray[];
  /** 各レイの、まだどけていない先頭の位置 */
  front: number[];
  knights: Array<{ piece: Piece; used: boolean }>;
};

function prepare(board: Board, x: number, y: number): Swap {
  const rays = raysAround(board, x, y);
  const knights: Array<{ piece: Piece; used: boolean }> = [];
  for (const owner of [SENTE, GOTE]) {
    for (const square of knightAttackers(board, x, y, owner)) {
      const piece = board[square.y][square.x];
      if (piece) knights.push({ piece, used: false });
    }
  }
  return { rays, front: rays.map(() => 0), knights };
}

// その手番で、いちばん安い攻め手を1つ返す。
// 🔴 「安い」は盤上の価値ではなく exchangeValue（取られたときに動く駒割）で測る。
//    と金は盤上では金より高いが、取られて相手の手に渡るのは歩なので、先に使うべきは
//    と金のほう。BOARD_VALUE で並べると金を先に使い、取り合いの結果を過小評価する。
function leastValuableAttacker(swap: Swap, side: Player): Candidate | null {
  let best: Candidate | null = null;
  let bestValue = Infinity;

  for (let r = 0; r < swap.rays.length; r++) {
    const ray = swap.rays[r];
    const entry = ray.entries[swap.front[r]];
    if (!entry || entry.piece.owner !== side) continue;
    if (!reachesAlong(entry.piece, ray.dx, ray.dy, entry.dist)) continue;
    const value = exchangeValue(entry.piece.type);
    if (value < bestValue) {
      bestValue = value;
      best = { piece: entry.piece, rayIndex: r, knightIndex: -1 };
    }
  }

  for (let k = 0; k < swap.knights.length; k++) {
    const knight = swap.knights[k];
    if (knight.used || knight.piece.owner !== side) continue;
    const value = exchangeValue(knight.piece.type);
    if (value < bestValue) {
      bestValue = value;
      best = { piece: knight.piece, rayIndex: -1, knightIndex: k };
    }
  }

  return best;
}

function useAttacker(swap: Swap, candidate: Candidate): void {
  if (candidate.rayIndex >= 0) swap.front[candidate.rayIndex] += 1;
  else swap.knights[candidate.knightIndex].used = true;
}

function releaseAttacker(swap: Swap, candidate: Candidate): void {
  if (candidate.rayIndex >= 0) swap.front[candidate.rayIndex] -= 1;
  else swap.knights[candidate.knightIndex].used = false;
}

/**
 * (x,y) に立っている駒を sideToMove が取りにいったときの得。
 *
 * 取るか取らないかは選べるので、返り値は必ず 0 以上になる（0 なら「取らないほうがよい」）。
 * 損得の生の値が要るときは seeCapture のほうを使うこと。
 */
export function see(board: Board, x: number, y: number, sideToMove: Player): number {
  const standing = board[y][x];
  if (!standing) return 0;

  const swap = prepare(board, x, y);
  /** i 番目の取りで手に入る駒の値 */
  const prizes: number[] = [];
  let side = sideToMove;
  let onSquare: Piece = standing;

  while (prizes.length < WAZA_CONFIG.maxSwapDepth) {
    const attacker = leastValuableAttacker(swap, side);
    if (!attacker) break;

    useAttacker(swap, attacker);

    // 玉で取れるのは、相手の攻め手が尽きているときだけ
    if (attacker.piece.type === KING && leastValuableAttacker(swap, getOpponent(side))) {
      releaseAttacker(swap, attacker);
      break;
    }

    prizes.push(exchangeValue(onSquare.type));
    onSquare = attacker.piece;
    side = getOpponent(side);
  }

  let value = 0;
  for (let i = prizes.length - 1; i >= 0; i--) {
    value = Math.max(0, prizes[i] - value);
  }
  return value;
}

/** 2マスだけ書き換えた盤を作る（行だけ写すので cloneBoard より軽い） */
export function quietMove(
  board: Board,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Board {
  const next = board.slice();
  next[fromY] = board[fromY].slice();
  if (toY !== fromY) next[toY] = board[toY].slice();
  next[toY][toX] = next[fromY][fromX];
  next[fromY][fromX] = null;
  return next;
}

/** 1マスだけ空にした盤（田楽刺しで「手前が逃げたら」を見るのに使う） */
export function withoutPiece(board: Board, x: number, y: number): Board {
  const next = board.slice();
  next[y] = board[y].slice();
  next[y][x] = null;
  return next;
}

/**
 * (fromX,fromY) の駒で (toX,toY) の駒を取ったときの駒割。
 * 正なら「本当に取れる」＝門2を通る。
 */
export function seeCapture(
  board: Board,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  const attacker = board[fromY][fromX];
  const victim = board[toY][toX];
  if (!attacker || !victim) return 0;
  const after = quietMove(board, fromX, fromY, toX, toY);
  return exchangeValue(victim.type) - see(after, toX, toY, getOpponent(attacker.owner));
}

/** 門1。着手マスの駒が取り合いのすえに残るか（相手が取りに来ても得しないか） */
export function survivesOnSquare(board: Board, x: number, y: number): boolean {
  const piece = board[y][x];
  if (!piece) return false;
  return see(board, x, y, getOpponent(piece.owner)) <= 0;
}
