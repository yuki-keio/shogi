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
  KNIGHT,
  LANCE,
  PAWN,
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
 * extras は判定には使わないが囲いの一部の金で、いれば光らせる（variants と同じ並び）。
 * 🔴 extras は解説（ウィキペディア・将棋講座サイト）で確かめられた形だけにする。
 *    光るのは「この駒も囲いの一部」と教えることなので、確かめられない駒は光らせない側に倒す
 */
const CASTLE_TABLE: Array<{ id: CastleId; variants: Requirement[][]; extras?: Requirement[][] }> = [
  {
    // 玉2八・銀2七・金3八の3枚（片銀冠）。居飛車型は左右を返した形。
    // 高美濃から組むと4七金・4六歩が残る（寄せて組むと4八金）
    id: "gin_kanmuri",
    variants: [
      [at(2, 8, KING), at(2, 7, SILVER), at(3, 8, GOLD)],
      [at(8, 8, KING), at(8, 7, SILVER), at(7, 8, GOLD)],
    ],
    extras: [
      [at(4, 7, GOLD), at(4, 8, GOLD)],
      [at(6, 7, GOLD), at(6, 8, GOLD)],
    ],
  },
  {
    // 穴熊は金2枚・銀1枚の形が一般的。居飛車の2枚目の金は7八（6八・6九の形は確かめられないので光らせない）
    id: "ibisha_anaguma",
    variants: [[at(9, 9, KING), at(8, 8, SILVER), at(7, 9, GOLD)]],
    extras: [[at(7, 8, GOLD)]],
  },
  {
    // 振り飛車の2枚目の金は3八・4八・4九
    id: "furibisha_anaguma",
    variants: [[at(1, 9, KING), at(2, 8, SILVER), at(3, 9, GOLD)]],
    extras: [[at(3, 8, GOLD), at(4, 8, GOLD), at(4, 9, GOLD)]],
  },
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
    // 左美濃：玉8八・銀7八・金6九。玉を一段上の8七に置く形（天守閣美濃）も左美濃に含める。
    // 7八が銀なので、矢倉（7八は金）・舟囲い（玉7八）・居飛車の銀冠（7八は金）とは重ならない
    id: "hidari_mino",
    variants: [
      [at(8, 8, KING), at(7, 8, SILVER), at(6, 9, GOLD)],
      [at(8, 7, KING), at(7, 8, SILVER), at(6, 9, GOLD)],
    ],
    // 右の金は5八へ寄せ、6七へ上げると高美濃の形になる
    extras: [
      [at(5, 8, GOLD), at(6, 7, GOLD)],
      [at(5, 8, GOLD), at(6, 7, GOLD)],
    ],
  },
  {
    id: "fune_gakoi",
    variants: [[at(7, 8, KING), at(7, 9, SILVER), at(6, 9, GOLD), at(5, 8, GOLD)]],
  },
  {
    // 雁木囲い：玉6九・金7八・金5八・銀6七と、もう1枚の銀が5七（昔からの二枚銀）か4七（ツノ銀雁木）。
    // 🔴 玉6九は外さない。外すと、玉を囲っていない形（5九のまま）や右へ囲った形まで雁木になる。
    // カニ囲い（銀6八）から銀を上げて組むことが多いので、カニ囲いより前に置く
    id: "gangi",
    variants: [
      [at(6, 9, KING), at(7, 8, GOLD), at(5, 8, GOLD), at(6, 7, SILVER), at(5, 7, SILVER)],
      [at(6, 9, KING), at(7, 8, GOLD), at(5, 8, GOLD), at(6, 7, SILVER), at(4, 7, SILVER)],
    ],
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

function standingVariant(board: Board, player: Player, id: CastleId): Requirement[] | null {
  const entry = CASTLE_TABLE.find((candidate) => candidate.id === id);
  return entry?.variants.find((variant) => matchesVariant(board, player, variant)) ?? null;
}

/** その囲いがいまも盤上に残っているか */
export function castleStands(board: Board, player: Player, id: CastleId): boolean {
  return standingVariant(board, player, id) !== null;
}

/** 成立している形の駒と、いればその形の extras の金（先手基準）。崩れていれば null */
function castlePieces(board: Board, player: Player, id: CastleId): Requirement[] | null {
  const entry = CASTLE_TABLE.find((candidate) => candidate.id === id);
  const index = entry ? entry.variants.findIndex((variant) => matchesVariant(board, player, variant)) : -1;
  if (!entry || index < 0) return null;
  const extras = (entry.extras?.[index] ?? []).filter((need) => matchesVariant(board, player, [need]));
  return [...entry.variants[index], ...extras];
}

/** 光らせるマス（先頭は玉）。見つからなければ空 */
export function castleSquares(board: Board, player: Player, id: CastleId): Square[] {
  return (castlePieces(board, player, id) ?? []).map((need) => ({
    x: player === SENTE ? need.x : 8 - need.x,
    y: player === SENTE ? need.y : 8 - need.y,
  }));
}

// 周りの駒として拾う段（先手基準の y）。歩は六・七段目、桂は九段目、香は八・九段目だけ。
// 跳ねた桂は攻めの駒で、打った底歩・上がった香も囲いの形ではない
const AROUND_RANKS: Partial<Record<PieceType, readonly number[]>> = { [PAWN]: [5, 6], [KNIGHT]: [8], [LANCE]: [7, 8] };

/**
 * 囲いの周りにいる自分の歩・桂・香（金・銀・玉より控えめに光らせる）。
 * 端歩を突くかどうかなど歩の位置は人によって違うので、決まったマスではなく、いまいる駒を拾う。
 * 範囲は「光らせる金銀玉（extras の金を含む）のいちばん外側の筋の1筋外から、いちばん内側の筋まで」×「AROUND_RANKS の段」。
 * extras の金も数えるのは、本美濃の5八金の上の5七歩が光るのと、左美濃の5八金・銀冠の4七金の上の歩をそろえるため。
 * 🔴 盤の端までは伸ばさない。玉が中央寄りの舟囲い・カニ囲い・雁木で、玉から遠い９筋の香・歩まで光るため
 */
export function castleAround(board: Board, player: Player, id: CastleId): Square[] {
  const pieces = castlePieces(board, player, id);
  if (!pieces) return [];
  // ここまでは先手基準（x=0 が９筋）。玉の筋で、囲いが盤のどちらの端に寄っているかを見る
  const xs = pieces.map((need) => need.x);
  const toNine = pieces.some((need) => need.type === KING && need.x < 4);
  const from = toNine ? Math.max(Math.min(...xs) - 1, 0) : Math.min(...xs);
  const to = toNine ? Math.max(...xs) : Math.min(Math.max(...xs) + 1, 8);
  const squares: Square[] = [];
  for (let y = 5; y <= 8; y += 1) {
    for (let x = from; x <= to; x += 1) {
      const square = { x: player === SENTE ? x : 8 - x, y: player === SENTE ? y : 8 - y };
      const piece = board[square.y][square.x];
      if (piece && piece.owner === player && AROUND_RANKS[piece.type]?.includes(y)) squares.push(square);
    }
  }
  return squares;
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
