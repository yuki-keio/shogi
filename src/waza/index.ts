// SPDX-License-Identifier: GPL-3.0-only

// 手筋・囲い・戦法の名前を出す機能の入口。
// shogi.js からは KifuCore 経由で scanWaza / summarizeWaza / WAZA_NAMES だけを使う。

import { parseUsiMove } from "../kifu/moves.ts";
import type { ReplayResult } from "../kifu/replay.ts";
import type { Player } from "../worker/shogi_engine.ts";
import { castleSquares, completedCastle } from "./castle.ts";
import { detectStrategy } from "./strategy.ts";
import { detectTesuji } from "./tesuji.ts";
import type { AnyWazaId, MoveContext, WazaHit, WazaKind, WazaTier } from "./types.ts";

export { WAZA_NAMES, WAZA_FIRST_SUB } from "./names.ts";
export { matchedCastles } from "./castle.ts";
export { see, seeCapture, survivesOnSquare } from "./see.ts";
export type { WazaHit, MoveContext } from "./types.ts";

/** 1手ぶん。名前は1つだけ返す（手筋 → 囲い → 戦法 の順に見る） */
export function detectWaza(ctx: MoveContext): WazaHit | null {
  const tesuji = detectTesuji(ctx);
  if (tesuji) return tesuji;

  const player = ctx.before.currentPlayer;
  const castle = completedCastle(ctx.before.board, ctx.after.board, player);
  if (castle) {
    return {
      kind: "castle",
      id: castle,
      tier: "mid",
      player,
      ply: ctx.ply,
      squares: castleSquares(ctx.after.board, player, castle),
    };
  }

  return detectStrategy(ctx);
}

export type WazaScan = {
  /** 使い回し判定用。この並びで作った結果であることを示す */
  usiMoves: string[];
  /** ply の昇順。囲い・戦法は1局1プレイヤーにつき1回に潰してある */
  hits: WazaHit[];
  /** 棋譜バー用。巻き戻したときもその手の名前が引ける */
  byPly: Map<number, WazaHit>;
};

/** previous の手順が usiMoves の先頭とそっくり同じところまでは使い回せる */
function reusableCount(previous: WazaScan | undefined, usiMoves: readonly string[]): number {
  if (!previous) return 0;
  const limit = Math.min(previous.usiMoves.length, usiMoves.length);
  let i = 0;
  while (i < limit && previous.usiMoves[i] === usiMoves[i]) i += 1;
  return i;
}

/**
 * 棋譜まるごとを走らせて、手ごとの名前を集める。
 * replay は kifuReplayCached() が持っているものをそのまま渡す（並べ直さない）。
 */
export function scanWaza(
  usiMoves: readonly string[],
  replay: ReplayResult | null | undefined,
  previous?: WazaScan,
): WazaScan {
  const moves = usiMoves.slice();
  const scan: WazaScan = { usiMoves: moves, hits: [], byPly: new Map() };
  if (!replay || !replay.states || replay.states.length === 0) return scan;

  const reusable = reusableCount(previous, moves);
  const seen = new Set<string>();
  if (previous) {
    for (const past of previous.hits) {
      if (past.ply > reusable) break;
      scan.hits.push(past);
      if (past.kind !== "tesuji") seen.add(`${past.player}:${past.id}`);
    }
  }

  for (let ply = reusable + 1; ply <= moves.length; ply += 1) {
    const before = replay.states[ply - 1];
    const after = replay.states[ply];
    if (!before || !after) break;
    const move = parseUsiMove(moves[ply - 1]);
    if (!move) break;

    const found = detectWaza({ before, after, move, ply });
    if (!found) continue;
    if (found.kind !== "tesuji") {
      const key = `${found.player}:${found.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    scan.hits.push(found);
  }

  for (const found of scan.hits) scan.byPly.set(found.ply, found);
  return scan;
}

export type WazaSummaryEntry = {
  id: AnyWazaId;
  kind: WazaKind;
  tier: WazaTier;
  count: number;
  firstPly: number;
};

/**
 * 対局結果のまとめ用。owners に入っている側が出した技だけを数える。
 * 並びは出た順（先に出したものが先）。
 */
export function summarizeWaza(scan: WazaScan, owners: readonly Player[]): WazaSummaryEntry[] {
  const order: AnyWazaId[] = [];
  const table = new Map<AnyWazaId, WazaSummaryEntry>();
  for (const found of scan.hits) {
    if (!owners.includes(found.player)) continue;
    const existing = table.get(found.id);
    if (existing) {
      existing.count += 1;
      continue;
    }
    table.set(found.id, {
      id: found.id,
      kind: found.kind,
      tier: found.tier,
      count: 1,
      firstPly: found.ply,
    });
    order.push(found.id);
  }
  return order.map((id) => table.get(id)!);
}
