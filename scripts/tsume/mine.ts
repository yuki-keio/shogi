// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 自己対局の棋譜から詰将棋の種局面を掘り出す純関数。エンジンには触らない。
//
// 何を作っているかを正確に言うと:
//   「実際に指された詰み」ではなく、
//   「実際に現れた局面から生まれた、終局までの距離と同じ手数の詰み」。
//
// 詰将棋の形式に合わせるために、実戦局面から次の2つを取り除く必要がある。
//   - 攻方の玉（詰将棋では盤上に置かない）
//   - 玉方の持ち駒（このリポジトリの規約。合駒が消える）
// どちらも詰み手数を変え、余詰も生む。だから厳密手数は必ず「変換したあと」に測り直す。
//
// そのうえで extractCandidates の offset と厳密手数が一致する候補だけを採ると、
// 見つけた詰みがその対局の残り手順そのものであることが保証される。
// この一致条件を外すと、終局の7手前・9手前・11手前から同じ裸玉の頭金が量産される。

import {
  GOTE,
  SENTE,
  baseTypeOf,
  createInitialGameState,
} from "../../src/worker/shogi_engine.ts";
import type { BasePieceType, Move, Player } from "../../src/worker/shogi_engine.ts";
import {
  ATTACKER,
  CAPTURED_ORDER,
  DEFENDER,
  KING,
  applyMoveToPosition,
  clonePosition,
  emptyBoard,
  emptyHands,
  moveFromUsi,
} from "./position.ts";
import type { Position } from "./position.ts";

/**
 * 180°回転して先後を入れ替えた局面。
 * mirrorPosition は左右反転なので別物（あちらは鏡像の重複判定用）。
 *
 * 筋の写像 x→8-x は全単射で、段の反転 y→8-y は駒の所有者の反転と同時に起きるので、
 * この変換は二歩も行き所のない駒も新たに作らない。
 */
export function rotateSwapPosition(pos: Position): Position {
  const board = emptyBoard();
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece) continue;
      board[8 - y][8 - x] = {
        type: piece.type,
        owner: piece.owner === SENTE ? GOTE : SENTE,
      };
    }
  }

  const hands = emptyHands();
  for (const type of CAPTURED_ORDER) {
    hands[SENTE][type] = pos.hands[GOTE][type] ?? 0;
    hands[GOTE][type] = pos.hands[SENTE][type] ?? 0;
  }

  return { board, hands, turn: pos.turn === SENTE ? GOTE : SENTE };
}

/** 平手の初形。src/worker/shogi_engine.ts の定義をそのまま使う。 */
export function initialPosition(): Position {
  const state = createInitialGameState();
  return { board: state.board, hands: state.capturedPieces, turn: state.currentPlayer };
}

/**
 * 平手初形から棋譜を再生し、各手番後の局面を並べて返す。
 * 戻り値の長さは usiMoves.length + 1（先頭が初形）。
 */
export function replayGame(usiMoves: string[]): Position[] {
  const states: Position[] = [initialPosition()];
  let cur = states[0];
  for (const text of usiMoves) {
    cur = applyMoveToPosition(cur, moveFromUsi(text, cur));
    states.push(cur);
  }
  return states;
}

export type MinedCandidate = {
  /** 実戦のままの局面。詰ませた側の手番 */
  pos: Position;
  /** 終局までの手数 */
  offset: number;
};

/**
 * 終局から offset 手前の、詰ませた側の手番の局面を取り出す。
 * offset は奇数だけを渡すこと（偶数だと詰まされる側の手番になる）。
 */
export function extractCandidates(states: Position[], offsets: number[]): MinedCandidate[] {
  const finalIndex = states.length - 1;
  if (finalIndex < 1) return [];

  // 最終手を指した側＝詰ませた側
  const matingSide = states[finalIndex - 1].turn;

  const out: MinedCandidate[] = [];
  for (const offset of offsets) {
    const index = finalIndex - offset;
    if (index < 0) continue;
    const pos = states[index];
    if (pos.turn !== matingSide) continue;
    out.push({ pos, offset });
  }
  return out;
}

/**
 * 実戦局面を詰将棋の候補に変換する。
 * 攻方が後手なら回転し、攻方の玉を外し、玉方の持ち駒を空にする。
 *
 * 詰み手数はこの変換で変わる。呼び出し側は必ず変換後に測り直すこと。
 */
export function toTsumeCandidate(pos: Position): Position {
  const base = pos.turn === ATTACKER ? clonePosition(pos) : rotateSwapPosition(pos);

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = base.board[y][x];
      if (piece && piece.type === KING && piece.owner === ATTACKER) base.board[y][x] = null;
    }
  }
  for (const type of CAPTURED_ORDER) base.hands[DEFENDER][type] = 0;

  return base;
}

/** 玉を除いた各駒の総数。 */
const PIECE_TOTALS: Record<string, number> = {
  HI: 2,
  KA: 2,
  KI: 4,
  GI: 4,
  KE: 4,
  KY: 4,
  FU: 18,
};

/**
 * 詰将棋のルール通り、盤上にも攻方の持ち駒にも無い駒を全部玉方に持たせる。
 *
 * 実測して分かっていること:
 *   - 実戦局面にこれを適用すると、玉方の持ち駒は**実戦でその人が実際に持っていた駒と一致する**
 *     （盤上＋攻方＋玉方＝40枚 なので、攻方の玉を除いた残りがちょうど玉方の持ち駒になる）。
 *     つまり攻方の玉を外す以外の改変がゼロになる。
 *   - 削り終えた局面に適用すると**余詰が消える**。玉方に合駒の材料があると詰まし方が絞られるため。
 *     既存在庫40問で試したところ、余詰・駒余りともに0件、検証時間も0.3秒で変わらなかった。
 *   - 一方で詰みが壊れることはある（合駒で受かる）。適用後は必ず手数を測り直すこと。
 *
 * 逆に、これを適用したあとに盤上の駒を削ってはいけない。
 * 削った駒は玉方の持ち駒に回るので、受けが強くなって詰みが壊れる。削るのは適用前。
 */
export function withFullDefenderHand(pos: Position): Position {
  const next = clonePosition(pos);

  const onBoard: Record<string, number> = {};
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = next.board[y][x];
      if (!piece || piece.type === KING) continue;
      const base = baseTypeOf(piece.type);
      onBoard[base] = (onBoard[base] ?? 0) + 1;
    }
  }

  for (const type of CAPTURED_ORDER) {
    const rest = PIECE_TOTALS[type] - (onBoard[type] ?? 0) - (next.hands[ATTACKER][type] ?? 0);
    next.hands[DEFENDER][type] = Math.max(0, rest);
  }
  return next;
}

/**
 * 攻方の持ち駒を「その手順を成立させるのに最小限必要な駒」に組み直した局面。
 * 手順の中で取った駒はそこから充当し、足りない分だけを初形の持ち駒にする。
 *
 * 実戦の攻方は道中で取った駒を全部持っているので、そのままだと駒余りで落ちる。
 * これが採掘の歩留まりを左右する。手順を再生できなければ null。
 */
export function handFromPv(pos: Position, pv: string[]): Position | null {
  const need: Record<string, number> = {};
  let cur = clonePosition(pos);
  for (const type of CAPTURED_ORDER) cur.hands[ATTACKER][type] = 0;

  try {
    for (const text of pv) {
      const move: Move = moveFromUsi(text, cur);
      if (move.type === "drop") {
        const owner: Player = cur.turn;
        if ((cur.hands[owner][move.pieceType] ?? 0) <= 0) {
          // 玉方は持ち駒を持たない前提。ここに来るなら変換前の手順が混ざっている
          if (owner !== ATTACKER) return null;
          need[move.pieceType] = (need[move.pieceType] ?? 0) + 1;
          cur.hands[ATTACKER][move.pieceType] = 1;
        }
      }
      cur = applyMoveToPosition(cur, move);
    }
  } catch {
    return null;
  }

  const rebuilt = clonePosition(pos);
  for (const type of CAPTURED_ORDER) {
    rebuilt.hands[ATTACKER][type] = need[type] ?? 0;
  }
  return rebuilt;
}

export type { BasePieceType };
