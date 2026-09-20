// SPDX-License-Identifier: GPL-3.0-only

// 手筋・囲い・戦法の名前を出す機能の入口。
// shogi.js からは KifuCore 経由で scanWaza / summarizeWaza / keptWaza / WAZA_NAMES / WAZA_FIRST_SUB だけを使う。

import { parseUsiMove } from "../kifu/moves.ts";
import type { ReplayResult } from "../kifu/replay.ts";
import { GOTE, SENTE, type Board, type Player } from "../worker/shogi_engine.ts";
import { castleSquares, castleStands, completedCastle } from "./castle.ts";
import { WAZA_CONFIG } from "./config.ts";
import { detectStrategy, strategyStands } from "./strategy.ts";
import { detectTesuji } from "./tesuji.ts";
import type {
  AnyWazaId,
  CastleId,
  MoveContext,
  WazaHit,
  WazaKind,
  WazaTier,
} from "./types.ts";

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
  /** 棋譜バーに出し続ける名前の、手ごとの状態（添字は手数。0 は開始局面） */
  kept: KeptPair[];
};

/**
 * 側ごとに、最後に完成させた囲い・戦法。
 * brokenFor は、形が崩れてから自分が指した手数（崩れていなければ null）
 */
type KeptWaza = { hit: WazaHit; brokenFor: number | null };
type KeptPair = Record<Player, KeptWaza | null>;

const NO_KEPT: KeptPair = { [SENTE]: null, [GOTE]: null };

function shapeStands(board: Board, hit: WazaHit): boolean {
  return hit.kind === "castle"
    ? castleStands(board, hit.player, hit.id as CastleId)
    : strategyStands(board, hit);
}

/** 1手進めたあとの状態。形が残っているかは、その手を指した後の盤で見る */
function nextKept(previous: KeptPair, found: WazaHit | null, board: Board, mover: Player): KeptPair {
  const next = { ...previous };
  for (const player of [SENTE, GOTE] as const) {
    if (found && found.kind !== "tesuji" && found.player === player) {
      next[player] = { hit: found, brokenFor: null };
      continue;
    }
    const kept = previous[player];
    if (!kept) continue;
    if (shapeStands(board, kept.hit)) {
      if (kept.brokenFor !== null) next[player] = { hit: kept.hit, brokenFor: null };
    } else if (kept.brokenFor === null) {
      next[player] = { hit: kept.hit, brokenFor: 0 }; // 崩した手そのものは数えない
    } else if (mover === player && kept.brokenFor < WAZA_CONFIG.keptGraceMoves) {
      next[player] = { hit: kept.hit, brokenFor: kept.brokenFor + 1 };
    }
  }
  return next;
}

/** previous の手順が usiMoves の先頭とそっくり同じところまでは使い回せる */
function reusableCount(previous: WazaScan | undefined, usiMoves: readonly string[]): number {
  if (!previous) return 0;
  // 前回が途中で止まっていたら（局面が足りなかったなど）、止まったところまでしか使えない
  const limit = Math.min(previous.usiMoves.length, usiMoves.length, previous.kept.length - 1);
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
  const scan: WazaScan = { usiMoves: moves, hits: [], byPly: new Map(), kept: [NO_KEPT] };
  if (!replay || !replay.states || replay.states.length === 0) return scan;

  const reusable = reusableCount(previous, moves);
  const seen = new Set<string>();
  if (previous) {
    for (const past of previous.hits) {
      if (past.ply > reusable) break;
      scan.hits.push(past);
      if (past.kind !== "tesuji") seen.add(`${past.player}:${past.id}`);
    }
    scan.kept = previous.kept.slice(0, reusable + 1);
  }

  for (let ply = reusable + 1; ply <= moves.length; ply += 1) {
    const before = replay.states[ply - 1];
    const after = replay.states[ply];
    if (!before || !after) break;
    const move = parseUsiMove(moves[ply - 1]);
    if (!move) break;

    let found = detectWaza({ before, after, move, ply });
    if (found && found.kind !== "tesuji") {
      const key = `${found.player}:${found.id}`;
      if (seen.has(key)) found = null;
      else seen.add(key);
    }
    if (found) scan.hits.push(found);
    scan.kept.push(nextKept(scan.kept[ply - 1], found, after.board, before.currentPlayer));
  }

  for (const found of scan.hits) scan.byPly.set(found.ply, found);
  return scan;
}

/**
 * 棋譜バーに出し続ける名前。owners の側が最後に完成させた囲い・戦法を1つ返す。
 * 形が崩れたあと、自分が keptGraceMoves 手指しても戻らなければ出さない（戻れば、また出す）。
 * 🔴 新しいほうが消えても、古い名前には戻さない。昔の名前が急に出ると「今の手の名前」に読めるため
 */
export function keptWaza(scan: WazaScan, ply: number, owners: readonly Player[]): WazaHit | null {
  const pair = scan.kept[ply];
  if (!pair) return null;
  let latest: KeptWaza | null = null;
  for (const owner of owners) {
    const kept = pair[owner];
    if (kept && (!latest || kept.hit.ply > latest.hit.ply)) latest = kept;
  }
  if (!latest) return null;
  const gone = latest.brokenFor !== null && latest.brokenFor >= WAZA_CONFIG.keptGraceMoves;
  return gone ? null : latest.hit;
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
