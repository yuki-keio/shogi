// SPDX-License-Identifier: GPL-3.0-only

// 囲いの判定。玉の位置と、金銀の必須マスがそろっているかを見るだけ。
//
// 表は先手基準で持ち、後手は (x,y) → (8-x, 8-y) に写す（盤を180度回すのと同じ）。
// 必須マス以外に何があっても構わない（＝必須マスの包含。禁止マスは書かない）。
//
// 「完成した瞬間」は before と after の差分で採る。これで
// 片美濃 → 本美濃 → 高美濃 → 銀冠 の「育つ」関係が自動で解ける
// （5八金が入ったら差分は本美濃だけで、片美濃は再掲されない）。

import {
  GOLD,
  KING,
  SENTE,
  SILVER,
  type Board,
  type PieceType,
  type Player,
} from "../worker/shogi_engine.ts";
import type { CastleId, Square } from "./types.ts";

type Requirement = { x: number; y: number; type: PieceType };

/** '5八' のような表記から盤の座標へ。x=0 が９筋、y=0 が一段目 */
function at(file: number, rank: number, type: PieceType): Requirement {
  return { x: 9 - file, y: rank - 1, type };
}

/**
 * 先手基準の必須マス。1つの囲いに複数の形があるものは variants に並べる。
 * 出典は README ではなく計画書（一般的な定義に合わせてある）。
 */
const CASTLE_TABLE: Array<{ id: CastleId; variants: Requirement[][] }> = [
  {
    // 玉2八・銀2七・金3八の3枚（片銀冠）。居飛車型は左右を返した形
    id: "gin_kanmuri",
    variants: [
      [at(2, 8, KING), at(2, 7, SILVER), at(3, 8, GOLD)],
      [at(8, 8, KING), at(8, 7, SILVER), at(7, 8, GOLD)],
    ],
  },
  { id: "ibisha_anaguma", variants: [[at(9, 9, KING), at(8, 8, SILVER), at(7, 9, GOLD)]] },
  { id: "furibisha_anaguma", variants: [[at(1, 9, KING), at(2, 8, SILVER), at(3, 9, GOLD)]] },
  {
    // 左金が4七へ出た形。2枚目の金は流派で 4九 と 5八 に分かれるので両方許す
    id: "taka_mino",
    variants: [
      [at(2, 8, KING), at(3, 8, SILVER), at(4, 7, GOLD), at(4, 9, GOLD)],
      [at(2, 8, KING), at(3, 8, SILVER), at(4, 7, GOLD), at(5, 8, GOLD)],
    ],
  },
  {
    id: "hon_mino",
    variants: [[at(2, 8, KING), at(3, 8, SILVER), at(4, 9, GOLD), at(5, 8, GOLD)]],
  },
  { id: "kata_mino", variants: [[at(2, 8, KING), at(3, 8, SILVER), at(4, 9, GOLD)]] },
  {
    id: "kin_muso",
    variants: [[at(3, 8, KING), at(4, 8, GOLD), at(5, 8, GOLD), at(2, 8, SILVER)]],
  },
  {
    id: "yagura",
    variants: [[at(8, 8, KING), at(7, 8, GOLD), at(6, 7, GOLD), at(7, 7, SILVER)]],
  },
  {
    id: "fune_gakoi",
    variants: [[at(7, 8, KING), at(7, 9, SILVER), at(6, 9, GOLD), at(5, 8, GOLD)]],
  },
  {
    id: "kani_gakoi",
    variants: [[at(6, 9, KING), at(7, 8, GOLD), at(6, 8, SILVER), at(5, 8, GOLD)]],
  },
];

// 表に並んでいる順がそのまま優先順位（発展形が勝つ）

function matchesVariant(board: Board, player: Player, variant: Requirement[]): boolean {
  for (const need of variant) {
    const x = player === SENTE ? need.x : 8 - need.x;
    const y = player === SENTE ? need.y : 8 - need.y;
    const piece = board[y][x];
    if (!piece || piece.owner !== player || piece.type !== need.type) return false;
  }
  return true;
}

/** その盤面で成立している囲い。優先順位の高い順に並ぶ */
export function matchedCastles(board: Board, player: Player): CastleId[] {
  const found: CastleId[] = [];
  for (const entry of CASTLE_TABLE) {
    for (const variant of entry.variants) {
      if (matchesVariant(board, player, variant)) {
        found.push(entry.id);
        break;
      }
    }
  }
  return found;
}

/** 光らせるマス（成立している形のもの）。見つからなければ空 */
export function castleSquares(board: Board, player: Player, id: CastleId): Square[] {
  const entry = CASTLE_TABLE.find((candidate) => candidate.id === id);
  if (!entry) return [];
  for (const variant of entry.variants) {
    if (!matchesVariant(board, player, variant)) continue;
    return variant.map((need) => ({
      x: player === SENTE ? need.x : 8 - need.x,
      y: player === SENTE ? need.y : 8 - need.y,
    }));
  }
  return [];
}

/** 指す前には無くて、指した後にできた囲い（優先順位がいちばん高いもの1つ） */
export function completedCastle(
  before: Board,
  after: Board,
  player: Player,
): CastleId | null {
  const afterSet = matchedCastles(after, player);
  if (afterSet.length === 0) return null;
  const beforeSet = new Set(matchedCastles(before, player));
  for (const id of afterSet) {
    if (!beforeSet.has(id)) return id;
  }
  return null;
}
