// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 問題の生成。局面をランダムに揺らしながら、ソルバーが返す「厳密な詰み手数」を
// 手がかりに目標手数へ寄せていく局所探索。
//
// 逆算生成の厳密な実装（指し手の巻き戻し）は分岐が多くバグりやすいのに対し、
// ソルバーが1クエリ2ms程度で答えるので「揺らして測る」ほうが速くて確実に作れる。
// 揺らし方だけは逆算に寄せてある（盤上の駒を持ち駒に戻す＝打った手の巻き戻し、
// 攻方の駒を少し後ろへ下げる、など）ので、でたらめな配置にはなりにくい。
//
// 生成物の正しさはすべて verify.ts が保証する。ここは候補を作るだけ。

import { SEARCH } from "./config.ts";
import {
  CAPTURED_ORDER,
  DEFENDER,
  ATTACKER,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  clonePosition,
  countBoardPieces,
  emptyBoard,
  emptyHands,
  isKingInCheck,
  toSfen,
  validateProblemPosition,
} from "./position.ts";
import type { BasePieceType, Piece, PieceType, Position } from "./position.ts";
import type { UsiEngine } from "./usi_engine.ts";
import { ENGINE } from "./config.ts";

// --- 乱数（再現性のためシード固定） -------------------------------------

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(rng: Rng, items: T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

// --- 摂動 ---------------------------------------------------------------

const DROPPABLE: BasePieceType[] = [...CAPTURED_ORDER];
const PROMOTED_OF: Partial<Record<PieceType, PieceType>> = {
  FU: "+FU",
  KY: "+KY",
  KE: "+KE",
  GI: "+GI",
  KA: "+KA",
  HI: "+HI",
};
const UNPROMOTED_OF: Partial<Record<PieceType, PieceType>> = Object.fromEntries(
  Object.entries(PROMOTED_OF).map(([base, promoted]) => [promoted, base]),
) as Partial<Record<PieceType, PieceType>>;

type Square = { x: number; y: number };

function squaresOf(pos: Position, owner: string, includeKing: boolean): Square[] {
  const out: Square[] = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece || piece.owner !== owner) continue;
      if (!includeKing && piece.type === KING) continue;
      out.push({ x, y });
    }
  }
  return out;
}

function emptySquaresNear(pos: Position, center: Square, radius: number): Square[] {
  const out: Square[] = [];
  for (let y = Math.max(0, center.y - radius); y <= Math.min(8, center.y + radius); y++) {
    for (let x = Math.max(0, center.x - radius); x <= Math.min(8, center.x + radius); x++) {
      if (!pos.board[y][x]) out.push({ x, y });
    }
  }
  return out;
}

function findDefenderKing(pos: Position): Square | null {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (piece && piece.type === KING && piece.owner === DEFENDER) return { x, y };
    }
  }
  return null;
}

/** 局面をひとつ揺らす。作れなければ null。 */
function perturb(rng: Rng, pos: Position): Position | null {
  const king = findDefenderKing(pos);
  if (!king) return null;
  const next = clonePosition(pos);

  const kinds = [
    "boardToHand",
    "handToBoard",
    "retreatAttacker",
    "moveDefender",
    "addDefender",
    "removeDefender",
    "addAttackerHand",
    "unpromote",
    "moveKing",
  ] as const;
  const kind = pick(rng, [...kinds]);

  switch (kind) {
    // 打った手の巻き戻し。盤上の攻方の駒を持ち駒に戻す
    case "boardToHand": {
      const candidates = squaresOf(next, ATTACKER, false).filter((sq) => {
        const type = next.board[sq.y][sq.x]!.type;
        return !type.startsWith("+");
      });
      if (candidates.length === 0) return null;
      const sq = pick(rng, candidates);
      const type = next.board[sq.y][sq.x]!.type as BasePieceType;
      next.board[sq.y][sq.x] = null;
      next.hands[ATTACKER][type] = (next.hands[ATTACKER][type] ?? 0) + 1;
      return next;
    }

    // 持ち駒を盤に戻す（探索を戻る方向）
    case "handToBoard": {
      const held = DROPPABLE.filter((t) => (next.hands[ATTACKER][t] ?? 0) > 0);
      if (held.length === 0) return null;
      const type = pick(rng, held);
      const spots = emptySquaresNear(next, king, 3);
      if (spots.length === 0) return null;
      const sq = pick(rng, spots);
      next.hands[ATTACKER][type]! -= 1;
      next.board[sq.y][sq.x] = { type, owner: ATTACKER };
      return next;
    }

    // 攻方の駒を少し引く。玉から離れる向きにだけ動かして、逆算に近い揺らし方にする
    case "retreatAttacker": {
      const candidates = squaresOf(next, ATTACKER, false);
      if (candidates.length === 0) return null;
      const sq = pick(rng, candidates);
      const piece = next.board[sq.y][sq.x]!;
      const distanceToKing = (s: Square) => Math.abs(s.x - king.x) + Math.abs(s.y - king.y);
      const spots = emptySquaresNear(next, sq, 2).filter(
        (dest) => distanceToKing(dest) >= distanceToKing(sq),
      );
      if (spots.length === 0) return null;
      const dest = pick(rng, spots);
      next.board[sq.y][sq.x] = null;
      next.board[dest.y][dest.x] = piece;
      return next;
    }

    case "moveDefender": {
      const candidates = squaresOf(next, DEFENDER, false);
      if (candidates.length === 0) return null;
      const sq = pick(rng, candidates);
      const piece = next.board[sq.y][sq.x]!;
      const spots = emptySquaresNear(next, sq, 1);
      if (spots.length === 0) return null;
      const dest = pick(rng, spots);
      next.board[sq.y][sq.x] = null;
      next.board[dest.y][dest.x] = piece;
      return next;
    }

    case "moveKing": {
      const spots = emptySquaresNear(next, king, 1).filter(
        (s) => s.x !== king.x || s.y !== king.y,
      );
      if (spots.length === 0) return null;
      const dest = pick(rng, spots);
      next.board[king.y][king.x] = null;
      next.board[dest.y][dest.x] = { type: KING, owner: DEFENDER };
      return next;
    }

    case "addDefender": {
      const spots = emptySquaresNear(next, king, 2).filter(
        (s) => s.x !== king.x || s.y !== king.y,
      );
      if (spots.length === 0) return null;
      const sq = pick(rng, spots);
      const type = pick(rng, DROPPABLE);
      next.board[sq.y][sq.x] = { type, owner: DEFENDER };
      return next;
    }

    case "removeDefender": {
      const candidates = squaresOf(next, DEFENDER, false);
      if (candidates.length === 0) return null;
      const sq = pick(rng, candidates);
      next.board[sq.y][sq.x] = null;
      return next;
    }

    case "addAttackerHand": {
      const type = pick(rng, DROPPABLE);
      next.hands[ATTACKER][type] = (next.hands[ATTACKER][type] ?? 0) + 1;
      return next;
    }

    case "unpromote": {
      const candidates = squaresOf(next, ATTACKER, false).filter((sq) => {
        const type = next.board[sq.y][sq.x]!.type;
        return UNPROMOTED_OF[type] || PROMOTED_OF[type];
      });
      if (candidates.length === 0) return null;
      const sq = pick(rng, candidates);
      const piece = next.board[sq.y][sq.x]!;
      const swapped = UNPROMOTED_OF[piece.type] ?? PROMOTED_OF[piece.type];
      if (!swapped) return null;
      next.board[sq.y][sq.x] = { type: swapped, owner: ATTACKER } as Piece;
      return next;
    }
  }
  return null;
}

// --- 評価 ---------------------------------------------------------------

function handSize(pos: Position): number {
  return CAPTURED_ORDER.reduce((sum, t) => sum + (pos.hands[ATTACKER][t] ?? 0), 0);
}

/** 探索で使う軽い足切り。ソルバーを呼ぶ前に落とせるものはここで落とす。 */
function quickReject(pos: Position): string | null {
  if (countBoardPieces(pos) > SEARCH.maxBoardPieces) return "駒が多すぎる";
  if (handSize(pos) > SEARCH.maxAttackerHand) return "持ち駒が多すぎる";
  // 玉方の持ち駒は常になし
  if (CAPTURED_ORDER.some((t) => (pos.hands[DEFENDER][t] ?? 0) > 0)) return "玉方に持ち駒がある";
  return validateProblemPosition(pos);
}

/** ソルバーから得た、その局面の素性。 */
export type Probe = {
  /** 厳密な詰み手数。詰まないときは null */
  mateLen: number | null;
  /** 初手のうち詰む手の数。1 でなければ初手に余詰がある */
  matingFirstMoves: number;
};

export type ScoredPosition = {
  pos: Position;
  probe: Probe;
  cost: number;
};

/**
 * 目標手数からの距離を主、初手の余詰を副、盤上の駒数を従として評価する。
 * 初手の余詰はソルバーが1クエリで数えてくれるので、探索の段階から潰しにいく。
 */
function costOf(probe: Probe, pos: Position, target: number): number {
  if (probe.mateLen === null) return 100;
  return (
    Math.abs(probe.mateLen - target) * 10 +
    Math.max(0, probe.matingFirstMoves - 1) * 3 +
    SEARCH.boardPiecePenalty * countBoardPieces(pos)
  );
}

// --- 種局面 -------------------------------------------------------------

/** 玉方の玉だけを置いた素の盤。端に寄せるほど詰将棋らしい形になりやすい。 */
function randomKingSquare(rng: Rng): Square {
  // 1〜3段目（玉方から見た自陣の奥）に置く。端寄りを厚めに選ぶ。
  const y = Math.floor(rng() * 3);
  const bias = rng();
  const x = bias < 0.45 ? Math.floor(rng() * 3) : bias < 0.9 ? 6 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 3);
  return { x: Math.min(8, x), y };
}

/** ランダムな種局面。攻方の駒を玉の近くに数枚置いただけのもの。 */
export function randomSeed(rng: Rng): Position {
  const pos: Position = { board: emptyBoard(), hands: emptyHands(), turn: ATTACKER };
  const king = randomKingSquare(rng);
  pos.board[king.y][king.x] = { type: KING, owner: DEFENDER };

  const attackerOnBoard = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < attackerOnBoard; i++) {
    const spots = emptySquaresNear(pos, king, 3);
    if (spots.length === 0) break;
    const sq = pick(rng, spots);
    const type = pick(rng, DROPPABLE);
    // 行き所のない駒を作らない
    if ((type === PAWN || type === LANCE) && sq.y === 0) continue;
    if (type === KNIGHT && sq.y <= 1) continue;
    pos.board[sq.y][sq.x] = { type, owner: ATTACKER };
  }

  const handCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < handCount; i++) {
    const type = pick(rng, DROPPABLE);
    pos.hands[ATTACKER][type] = (pos.hands[ATTACKER][type] ?? 0) + 1;
  }

  const defenders = Math.floor(rng() * 3);
  for (let i = 0; i < defenders; i++) {
    const spots = emptySquaresNear(pos, king, 2).filter((s) => s.x !== king.x || s.y !== king.y);
    if (spots.length === 0) break;
    const sq = pick(rng, spots);
    const type = pick(rng, DROPPABLE);
    if ((type === PAWN || type === LANCE) && sq.y === 8) continue;
    if (type === KNIGHT && sq.y >= 7) continue;
    pos.board[sq.y][sq.x] = { type, owner: DEFENDER };
  }

  return pos;
}

// --- 探索本体 -----------------------------------------------------------

export type SearchHit = {
  pos: Position;
  mateLen: number;
  steps: number;
};

/**
 * seed から出発して、ちょうど target 手詰の局面を探す。
 * 見つかるたびに yield する（呼び出し側で verify にかける）。
 */
export async function* searchPositions(
  engine: UsiEngine,
  rng: Rng,
  seed: Position,
  target: number,
  budget: { maxSteps?: number } = {},
): AsyncGenerator<SearchHit> {
  const maxSteps = budget.maxSteps ?? SEARCH.maxSteps;

  if (quickReject(seed)) return;
  const seedProbe = await probeLength(engine, seed);
  let current: ScoredPosition = {
    pos: seed,
    probe: seedProbe,
    cost: costOf(seedProbe, seed, target),
  };

  let sinceImprovement = 0;
  const seen = new Set<string>([toSfen(seed)]);

  for (let step = 0; step < maxSteps; step++) {
    const candidate = perturb(rng, current.pos);
    if (!candidate) continue;
    if (quickReject(candidate)) continue;
    const key = toSfen(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    // 手数だけを見る安いクエリで歩き、目標に当たったときだけ余詰まで調べる
    let probe = await probeLength(engine, candidate);
    if (probe.mateLen === target) {
      probe = await probePosition(engine, candidate);
      if (probe.mateLen === target && probe.matingFirstMoves === 1) {
        yield { pos: candidate, mateLen: probe.mateLen, steps: step };
        current = { pos: candidate, probe, cost: costOf(probe, candidate, target) };
        sinceImprovement = 0;
        continue;
      }
    }

    const cost = costOf(probe, candidate, target);
    const better = cost < current.cost;
    const accept = better || rng() < Math.exp((current.cost - cost) / SEARCH.annealTemperature);
    if (accept) {
      current = { pos: candidate, probe, cost };
      if (better) sinceImprovement = 0;
    }
    if (++sinceImprovement > SEARCH.patience) return;
  }
}

/** 厳密手数だけを取る安いクエリ（MultiPV を使わないぶん半分以下で済む）。 */
export async function probeLength(engine: UsiEngine, pos: Position): Promise<Probe> {
  const res = await engine.solveMate({
    sfen: toSfen(pos),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
  });
  // 初手の本数は測っていないので、余詰なしと仮定した値を入れておく
  return { mateLen: res.kind === "mate" ? res.len : null, matingFirstMoves: 1 };
}

/** 厳密手数と初手の詰む手の数を取る。 */
export async function probePosition(engine: UsiEngine, pos: Position): Promise<Probe> {
  const res = await engine.solveMate({
    sfen: toSfen(pos),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
    withRootMoves: true,
  });
  return {
    mateLen: res.kind === "mate" ? res.len : null,
    matingFirstMoves: res.rootMoves.filter((m) => m.mateLen !== null).length,
  };
}
