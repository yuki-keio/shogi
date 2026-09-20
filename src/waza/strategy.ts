// SPDX-License-Identifier: GPL-3.0-only

// 戦法の判定。飛車を振った瞬間と、飛車先に銀を繰り出した瞬間だけを見る。

import {
  PROMOTED_SILVER,
  ROOK,
  SENTE,
  SILVER,
  type Board,
  type Player,
} from "../worker/shogi_engine.ts";
import { WAZA_CONFIG } from "./config.ts";
import type { MoveContext, StrategyId, WazaHit } from "./types.ts";

/** 先手基準の「飛車を振った筋」。後手は x を 8-x に写してから引く */
const ROOK_FILE_TO_ID: Record<number, StrategyId> = {
  1: "mukai_bisha", // 8筋
  2: "sanken_bisha", // 7筋
  3: "shiken_bisha", // 6筋
  4: "naka_bisha", // 5筋
};

function ownFile(x: number, player: Player): number {
  return player === SENTE ? x : 8 - x;
}

/** 成っていない飛車の筋（盤全体から探す）。無ければ null */
function rookFile(board: Board, player: Player): number | null {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece && piece.owner === player && piece.type === ROOK) return x;
    }
  }
  return null;
}

export function detectStrategy(ctx: MoveContext): WazaHit | null {
  if (ctx.ply > WAZA_CONFIG.strategyMaxPly) return null;
  const player = ctx.before.currentPlayer;
  const move = ctx.move;
  if (move.type !== "move") return null;

  const moved = ctx.after.board[move.toY][move.toX];
  if (!moved || moved.owner !== player) return null;

  // 飛車を振った手
  if (moved.type === ROOK) {
    if (move.fromX === move.toX) return null;
    // 自陣（先手なら七〜九段目）に振ったときだけ。中盤に飛車を五段目へ寄せただけの手を拾わない
    const inOwnCamp = player === SENTE ? move.toY >= 6 : move.toY <= 2;
    if (!inOwnCamp) return null;
    const id = ROOK_FILE_TO_ID[ownFile(move.toX, player)];
    if (!id) return null;
    return {
      kind: "strategy",
      id,
      tier: "small",
      player,
      ply: ctx.ply,
      squares: [{ x: move.toX, y: move.toY }],
    };
  }

  // 飛車先に銀を繰り出した手（棒銀）。早繰り銀・腰掛け銀は筋が違うので当たらない。
  // 🔴 飛車が初期の筋（先手2筋・後手8筋）にいることも要る。これが無いと
  //    中飛車の5六銀・四間飛車の6六銀まで「棒銀」になってしまう
  if (moved.type === SILVER) {
    const file = rookFile(ctx.after.board, player);
    if (file === null || file !== move.toX) return null;
    if (ownFile(file, player) !== 7) return null;
    const rank = player === SENTE ? move.toY : 8 - move.toY;
    if (!WAZA_CONFIG.boginRanks.includes(rank)) return null;
    return {
      kind: "strategy",
      id: "bogin",
      tier: "small",
      player,
      ply: ctx.ply,
      squares: [{ x: move.toX, y: move.toY }],
    };
  }

  return null;
}

/**
 * その戦法の形がいまも盤上に残っているか。主役の駒で見る。
 * 振り飛車は、振った筋に飛車がいるか（浮き飛車のように同じ筋で前へ出るのは構わない）。
 * 棒銀は、1・2筋の六段目から先に銀がいるか（端へ回った1五銀や成銀も棒銀のうち。
 * 交換で取られたり、引いたりしたら崩れたとみなす）
 */
export function strategyStands(board: Board, hit: WazaHit): boolean {
  const player = hit.player;
  const rookX = hit.squares[0]?.x;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (!piece || piece.owner !== player) continue;
      if (hit.id !== "bogin") {
        if (piece.type === ROOK && x === rookX) return true;
        continue;
      }
      if (piece.type !== SILVER && piece.type !== PROMOTED_SILVER) continue;
      const rank = player === SENTE ? y : 8 - y;
      if (ownFile(x, player) >= 7 && rank <= 5) return true;
    }
  }
  return false;
}
