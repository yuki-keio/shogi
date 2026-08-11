// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 不要駒削除。盤上の駒と攻方の持ち駒を1枚ずつ取り除いてみて、
// 同じ手数の詰みが保たれるなら本当に取り除く。
//
// 「盤上のどの駒にも意味がある」状態にするのがねらい。副次的に、
// 余計な駒が消えることで余詰と駒余りも大きく減る。

import { ENGINE } from "./config.ts";
import {
  ATTACKER,
  CAPTURED_ORDER,
  DEFENDER,
  KING,
  clonePosition,
  toSfen,
  validateProblemPosition,
} from "./position.ts";
import type { BasePieceType, Position } from "./position.ts";
import type { UsiEngine } from "./usi_engine.ts";

type Probe = { mateLen: number | null; matingFirstMoves: number };

async function probe(engine: UsiEngine, pos: Position): Promise<Probe> {
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

/**
 * target 手詰であることを保ったまま、取り除ける駒をすべて取り除く。
 * 玉から遠い駒から順に試し、変化がなくなるまで繰り返す。
 */
export async function minimizeProblem(
  engine: UsiEngine,
  input: Position,
  target: number,
  options: {
    /**
     * 削るたびに詰将棋のルール通りの持ち駒に直しながら進める。
     *
     * 実戦から採った局面はこちらを使う。取り除いた駒は玉方の持ち駒に回るので
     * 削れる駒は減るが、狙った手数を保ったまま削れる。
     * これを使わずに削ると、合駒の無い世界の手数（実戦より短い）に寄ってしまう。
     */
    keepRule?: (pos: Position) => Position;
  } = {},
): Promise<Position> {
  const settle = options.keepRule ?? ((pos: Position) => pos);
  let best = settle(clonePosition(input));

  const kingPos = (() => {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const piece = best.board[y][x];
        if (piece && piece.type === KING && piece.owner === DEFENDER) return { x, y };
      }
    }
    return { x: 4, y: 0 };
  })();

  // 初手で詰む手の数。削るたびに「増えていないこと」を条件にする。
  //
  // ここを「ちょうど1つ」に固定してはいけない。実戦から採った局面は初手の詰む手が
  // 8通りといったこともあり、1枚削って一気に1つになることはまずないので、
  // 1枚も削れないまま終わってしまう（実測: 260候補のうち103件がこれで脱落した）。
  // 減る方向にだけ動かせば、多いところからでも段階的に削れる。
  // 探索由来の候補は初手が一意の状態で入ってくるので、従来どおりの挙動になる。
  let mating = (await probe(engine, best)).matingFirstMoves;

  /** 削れるなら削った後の初手の数を返す。削れないなら null。 */
  const keeps = async (candidate: Position): Promise<number | null> => {
    if (validateProblemPosition(candidate)) return null;
    const result = await probe(engine, candidate);
    if (result.mateLen !== target) return null;
    if (result.matingFirstMoves > mating) return null;
    return result.matingFirstMoves;
  };

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;

    // 攻方の持ち駒（余ると駒余りになるので最優先で削る）
    for (const type of CAPTURED_ORDER) {
      while ((best.hands[ATTACKER][type] ?? 0) > 0) {
        const candidate = settle((() => {
          const next = clonePosition(best);
          next.hands[ATTACKER][type]! -= 1;
          return next;
        })());
        const left = await keeps(candidate);
        if (left === null) break;
        best = candidate;
        mating = left;
        changed = true;
      }
    }

    // 盤上の駒。玉から遠い順に試す
    const squares: Array<{ x: number; y: number; d: number }> = [];
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const piece = best.board[y][x];
        if (!piece || piece.type === KING) continue;
        squares.push({ x, y, d: Math.abs(x - kingPos.x) + Math.abs(y - kingPos.y) });
      }
    }
    squares.sort((a, b) => b.d - a.d);

    for (const sq of squares) {
      const piece = best.board[sq.y][sq.x];
      if (!piece || piece.type === KING) continue;
      const candidate = settle((() => {
        const next = clonePosition(best);
        next.board[sq.y][sq.x] = null;
        return next;
      })());
      const left = await keeps(candidate);
      if (left === null) continue;
      best = candidate;
      mating = left;
      changed = true;
    }

    if (!changed) break;
  }

  return best;
}

export type { BasePieceType };
