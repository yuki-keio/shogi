// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 問題の採点。「正しい詰将棋」であることは verify.ts が保証するので、
// ここでは「解いて面白いか」だけを見る。
//
// 自動生成の弱点は、正しいだけで味のない問題がいくらでもできてしまうこと。
// そこで、詰将棋で「うまい」とされる要素を数えて点にし、
// 一定点に届かない問題は在庫に入れない（minScoreFor）。
//
// 数えているもの:
//   捨て駒     取られる場所にわざと打つ・動かす
//   遠打       玉から離れた地点へ飛角香を打つ（近くに打つのが自然に見える局面ほど妙手になる）
//   不成       成れるのに成らない
//   打歩詰     歩を打てば詰みだが打歩詰で反則、という筋が絡んでいる
//   玉の動き   玉が動き回るほど、詰みの形が見えにくい
//   紛れ       初手の王手が多いほど、正解を選ぶのが難しい
//
// 短手数（初級）は逆に、紛れが少なく駒が少ないほど良い問題とする。

import { QUALITY } from "./config.ts";
import {
  ATTACKER,
  CAPTURED_ORDER,
  DEFENDER,
  KING,
  PAWN,
  applyMoveToPosition,
  countBoardPieces,
  countDefenderPieces,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  isUchifuzumeAt,
  usi,
} from "./position.ts";
import type { Move, Position } from "./position.ts";
import type { SolutionStep } from "./verify.ts";

function handSize(pos: Position): number {
  return CAPTURED_ORDER.reduce((sum, t) => sum + (pos.hands[ATTACKER][t] ?? 0), 0);
}

function findMove(moves: Move[], target: string): Move | undefined {
  return moves.find((m) => usi(m) === target);
}

function kingSquare(pos: Position): { x: number; y: number } | null {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (piece && piece.type === KING && piece.owner === DEFENDER) return { x, y };
    }
  }
  return null;
}

/** 盤上の距離。斜めも1歩と数える（玉の歩数に合う） */
function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 遠くから利かせる駒。近くに打っても届くので、離して打つと妙手になりやすい */
const LONG_RANGE = new Set(["HI", "KA", "KY"]);

type LineStats = {
  sacrifices: number;
  distantDrops: number;
  nonPromotions: number;
  kingTravel: number;
  captures: number;
  escapes: number;
};

/** 作意手順を1手ずつ再生して、採点の材料を集める。 */
function walkLine(pos: Position, line: SolutionStep[]): LineStats {
  const stats: LineStats = {
    sacrifices: 0,
    distantDrops: 0,
    nonPromotions: 0,
    kingTravel: 0,
    captures: 0,
    escapes: 0,
  };
  let cur = pos;

  for (const step of line) {
    const checks = enumerateCheckingMoves(cur);
    const attack = findMove(checks, step.attack);
    if (!attack) break;

    const king = kingSquare(cur);
    const landing = { x: attack.toX, y: attack.toY };

    if (attack.type === "drop") {
      if (king && LONG_RANGE.has(attack.pieceType) && distance(landing, king) >= 2) {
        stats.distantDrops++;
      }
    } else if (!attack.promote) {
      // 同じ地点へ成って指す手も王手として指せるなら、あえて成らなかったことになる
      const promotable = checks.some(
        (m) =>
          m.type === "move" &&
          m.promote === true &&
          m.fromX === attack.fromX &&
          m.fromY === attack.fromY &&
          m.toX === attack.toX &&
          m.toY === attack.toY,
      );
      if (promotable) stats.nonPromotions++;
    }

    const afterAttack = applyMoveToPosition(cur, attack);
    const replies = enumerateLegalMoves(afterAttack);
    if (replies.some((m) => m.type === "move" && m.toX === landing.x && m.toY === landing.y)) {
      stats.sacrifices++;
    }

    if (step.defend === null) break;
    const defend = findMove(replies, step.defend);
    if (!defend) break;
    const before = countBoardPieces(afterAttack);
    const kingBefore = kingSquare(afterAttack);
    cur = applyMoveToPosition(afterAttack, defend);
    const kingAfter = kingSquare(cur);
    if (kingBefore && kingAfter) stats.kingTravel += distance(kingBefore, kingAfter);
    if (countBoardPieces(cur) === before) stats.escapes++;
    else stats.captures++;
  }

  return stats;
}

/**
 * 打歩詰の筋が絡んでいるか。
 * 歩を持っていて、打てば詰むのに打歩詰で指せない地点があれば true。
 * その一手が見えると解けそうで解けない、という良い紛れになる。
 */
function involvesUchifuzume(pos: Position): boolean {
  if ((pos.hands[ATTACKER][PAWN] ?? 0) <= 0) return false;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      if (pos.board[y][x]) continue;
      if (isUchifuzumeAt(pos, x, y)) return true;
    }
  }
  return false;
}

export type ScoreInput = {
  pos: Position;
  line: SolutionStep[];
  moves: number;
};

/**
 * 出題順を決めるスコア。高いほど先に出す。
 * 初級は「やさしさ」、中級以上は「面白さ」を見る。
 */
export function scoreProblem({ pos, line, moves }: ScoreInput): number {
  const pieces = countBoardPieces(pos);
  const hand = handSize(pos);
  const decoys = enumerateCheckingMoves(pos).length;
  const stats = walkLine(pos, line);
  let score = 0;

  // 玉方自身の駒が逃げ道を塞いでいるほど実戦で出てくる形に近い。
  // 逆に裸玉は、正しくても「なぜその駒がそこにあるのか」が説明できない盤になりやすい。
  //
  // これを効かせるのは3手以下だけにしてある。5手以上の分岐は「面白さ」を測っており、
  // ここに一律の加点を足すと全体が底上げされて minScore の効きが1点ぶん緩む
  // （実測: 5/7/9手の中央値が約1点上がり、既存在庫が全部下限を超えてしまった）。
  // 5手以上の裸玉は QUALITY.minDefenderPieces 側で弾く。
  const shelter = Math.min(Math.max(0, countDefenderPieces(pos) - 1), 3) * 0.6;

  if (moves <= 3) {
    // やさしさ: 駒が少なく、初手の候補が絞れて、持ち駒も1〜2枚
    // 駒の少なさへの加点は控えめにしてある。強くすると裸玉が実戦形より上に来てしまう
    score += Math.max(0, 8 - pieces) * 0.3;
    score += shelter;
    score += hand >= 1 && hand <= 2 ? 1.5 : 0;
    // 王手の候補が多すぎると初級には向かない
    score += decoys <= 6 ? 1.0 : 0;
    // 初級でも捨て駒が1つあると「おっ」となる
    score += Math.min(stats.sacrifices, 1) * 1.0;
    return round(score);
  }

  // 面白さ: 妙手が入っているか
  score += Math.min(stats.sacrifices, 3) * 1.8;
  score += Math.min(stats.distantDrops, 2) * 2.0;
  score += Math.min(stats.nonPromotions, 2) * 2.5;
  score += involvesUchifuzume(pos) ? 2.0 : 0;
  // 玉が逃げ回るほど詰みの形が見えにくい
  score += Math.min(stats.kingTravel, 8) * 0.4;
  // 初手の紛れ。多すぎても総当たりで解けるので頭打ちにする
  score += Math.min(decoys, 10) * 0.25;
  // 盤面が締まっているほど作品らしい
  score += Math.max(0, QUALITY.fewPiecesBonusAt - pieces) * 0.4;
  // 盤上の駒だけで詰ますか、持ち駒を使い切るか
  score += hand === 0 ? 0.8 : 0;

  return round(score);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 詰まし方が少ないほど良い問題とみなす加点。
 *
 * 長手数では余詰を許しているが、少ないに越したことはない。
 * 出題は得点順なので、ここを入れておけば「詰まし方が1通りだけの問題」から先に出る。
 * 候補が豊富な短手数では実質すべて一意になり、長手数だけが複数を許す形になる。
 */
export function uniquenessBonus(matingFirstMoves: number): number {
  if (matingFirstMoves <= 1) return 1.5;
  if (matingFirstMoves === 2) return 0.8;
  if (matingFirstMoves <= 4) return 0.3;
  return 0;
}

/** この点に届かない問題は在庫に入れない。 */
export function minScoreFor(moves: number): number {
  return QUALITY.minScore[moves] ?? 0;
}

/** 作意手順の JSON がクライアントに焼き込める大きさか。 */
export function lineIsCompact(line: SolutionStep[]): boolean {
  return JSON.stringify(line).length <= QUALITY.maxLineBytes;
}

/**
 * 盤が寂しすぎないか。
 * 盤全体の枚数に加えて、玉方に守り駒が残っているかも見る（裸玉を弾くのはこちら）。
 */
export function hasEnoughPieces(pos: Position, moves: number): boolean {
  if (countBoardPieces(pos) < (QUALITY.minBoardPieces[moves] ?? 3)) return false;
  return countDefenderPieces(pos) >= (QUALITY.minDefenderPieces[moves] ?? 1);
}

/**
 * 「持ち味が同じ問題」をまとめるための署名。
 * 玉の位置を1マスずらしただけの亜種を在庫に並べないために使う。
 */
export function problemSignature(pos: Position, line: SolutionStep[], moves: number): string {
  const board: string[] = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (piece) board.push(`${piece.owner === ATTACKER ? "+" : "-"}${piece.type}`);
    }
  }
  board.sort();
  const hand = CAPTURED_ORDER.filter((t) => (pos.hands[ATTACKER][t] ?? 0) > 0)
    .map((t) => `${t}${pos.hands[ATTACKER][t]}`)
    .join(",");
  const opening = line[0]?.attack.replace(/[1-9][a-i]/g, "").replace(/\+$/, "") || "";
  return `${moves}|${board.join(",")}|${hand}|${opening}`;
}

/**
 * 作意手順のキー。手順の**出だし6割**だけを見る。
 *
 * 自動生成では「途中まで全く同じで、終盤の詰め方だけ違う」問題がいくらでもできる。
 * 解く人から見れば同じ問題を二度解かされるだけなので、片方しか出さない。
 * 9手詰なら最初の6手が同じものを同一とみなす。
 */
export function solutionKey(line: SolutionStep[]): string {
  const plies: string[] = [];
  for (const step of line) {
    plies.push(step.attack);
    if (step.defend) plies.push(step.defend);
  }
  const shared = Math.max(1, Math.ceil(plies.length * 0.6));
  return plies.slice(0, shared).join(" ");
}
