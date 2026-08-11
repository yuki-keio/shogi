// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 余詰つぶし。玉方の駒を盤に足して、作意以外の詰み筋を塞ぐ。
//
// 詰将棋を作るときの標準的な手法で、実戦から採った候補にこそ効く。
// 実戦局面は余詰の検査を一度も受けていないので、詰まし方が複数あるのが普通で、
// 実測では棄却理由の最大が余詰だった（275局から出た候補で233件）。
//
// 足す駒は玉方の持ち駒から出す。ルール通りの持ち駒（盤上と攻方の持ち駒以外は全部玉方）
// にしてあれば、盤に1枚置くと持ち駒が1枚減るだけなので駒の総数は自動的に合う。
//
// 総当たりはしない。エンジンが MultiPV で返す「詰む初手」の行き先マスを塞げば
// その手だけを潰せるので、余詰の数だけ試せば済む。
//
// 置いた駒で詰みそのものが壊れることもあるので、毎回手数を測り直して確かめる。

import { ENGINE, SELFPLAY } from "./config.ts";
import {
  CAPTURED_ORDER,
  DEFENDER,
  clonePosition,
  moveFromUsi,
  toSfen,
  validateProblemPosition,
} from "./position.ts";
import type { BasePieceType, Position } from "./position.ts";
import type { UsiEngine } from "./usi_engine.ts";

/**
 * 塞ぎに使う駒の優先順。安い駒から試す。
 *
 * 歩や香が1枚あるだけの形は実戦でもよくあるが、
 * 働いていない飛車や角が盤に転がっているのは作り物に見える。
 */
const BLOCKERS: BasePieceType[] = ["FU", "KY", "KE", "GI", "KI", "KA", "HI"];

type Probe = { len: number | null; mating: number };

async function probe(engine: UsiEngine, pos: Position): Promise<Probe> {
  const res = await engine.solveMate({
    sfen: toSfen(pos),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
    withRootMoves: true,
  });
  return {
    len: res.kind === "mate" ? res.len : null,
    mating: res.rootMoves.filter((move) => move.mateLen !== null).length,
  };
}

/** 詰む初手の行き先マス。ここを塞げばその手は消える（取り返されなければ）。 */
async function matingDestinations(
  engine: UsiEngine,
  pos: Position,
): Promise<{ len: number | null; mating: number; squares: Array<{ x: number; y: number }> }> {
  const res = await engine.solveMate({
    sfen: toSfen(pos),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
    withRootMoves: true,
  });
  const mating = res.rootMoves.filter((move) => move.mateLen !== null);
  const squares: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  for (const root of mating) {
    let move;
    try {
      move = moveFromUsi(root.move, pos);
    } catch {
      continue;
    }
    const key = `${move.toX},${move.toY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    squares.push({ x: move.toX, y: move.toY });
  }
  return {
    len: res.kind === "mate" ? res.len : null,
    mating: mating.length,
    squares,
  };
}

/**
 * 詰む初手が1つになるまで、玉方の駒を足して余詰を潰す。
 * 潰しきれなくても、減らせたところまでを返す（そのあとの検証で落ちるだけ）。
 *
 * 渡す局面はルール通りの持ち駒であること（足す駒を玉方の持ち駒から出すため）。
 */
export async function killRivals(
  engine: UsiEngine,
  input: Position,
  target: number,
  maxAdds: number = SELFPLAY.maxDefenderAdds,
): Promise<Position> {
  let best = input;

  for (let added = 0; added < maxAdds; added++) {
    const current = await matingDestinations(engine, best);
    if (current.len !== target) return best;
    if (current.mating <= 1) return best;

    let improved: { pos: Position; mating: number } | null = null;

    for (const square of current.squares) {
      if (best.board[square.y][square.x]) continue;

      for (const type of BLOCKERS) {
        if ((best.hands[DEFENDER][type] ?? 0) <= 0) continue;

        const candidate = clonePosition(best);
        candidate.hands[DEFENDER][type]! -= 1;
        candidate.board[square.y][square.x] = { type, owner: DEFENDER };
        if (validateProblemPosition(candidate) !== null) continue;

        const after = await probe(engine, candidate);
        // 詰みが壊れたり手数が変わったものは使えない
        if (after.len !== target) continue;
        if (after.mating >= current.mating) continue;
        if (improved === null || after.mating < improved.mating) {
          improved = { pos: candidate, mating: after.mating };
        }
        // いちばん安い駒で減らせたら、その升はそれで良い
        break;
      }
      if (improved && improved.mating === 1) break;
    }

    if (!improved) return best;
    best = improved.pos;
    if (improved.mating <= 1) return best;
  }

  return best;
}

export { CAPTURED_ORDER };
