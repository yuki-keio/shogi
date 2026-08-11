// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋の詰み探索。ブラウザ（Web Worker）と Node のテストの両方から使う。
//
// 用途はひとつだけ:「玉方が、残りN手では絶対に詰まない逃げ方を選ぶ」。
// 利用者が作意から外れた手を指しても止めずに、手数を使い切るまで指させるために要る。
//
// 設計の要点
//   - 駒の動きは src/worker/shogi_engine.ts の PIECE_MOVEMENTS を唯一の出典にする。
//     出題データを生成・検証しているのと同じ表なので、ブラウザと検証器が食い違わない。
//   - 探索中は盤を複製しない。Int8Array(81) に対して指して戻す（ai-worker.js:565- と同じ考え方）。
//   - 結論が出せなかったときは必ず「わからない」を返す。推測で手を返してはいけない。
//     呼び出し側はそのとき従来どおり「その王手では詰みません」に戻す。

import {
  BISHOP,
  GOLD,
  GOTE,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  PIECE_MOVEMENTS,
  PROMOTED_BISHOP,
  PROMOTED_KNIGHT,
  PROMOTED_LANCE,
  PROMOTED_PAWN,
  PROMOTED_ROOK,
  PROMOTED_SILVER,
  ROOK,
  SENTE,
  SILVER,
  type BasePieceType,
  type Board,
  type CapturedPieces,
  type PieceType,
  type Player,
} from "../worker/shogi_engine.ts";

// --- 駒の符号 ---
// 0 = 空。1〜14 が攻方（先手）、17〜30 が玉方（後手）。owner ビットは 16。
//
// 並び順は「成ると +8 になる」ように決めてある（歩→と、角→馬、飛→竜）。
// 金は成れないので、成れる駒 6 種のうしろに置く。
const FU = 1, KY = 2, KE = 3, GI = 4, KA = 5, HI = 6, KI = 7, OU = 8;
const PFU = 9, PKY = 10, PKE = 11, PGI = 12, PKA = 13, PHI = 14;
const GOTE_BIT = 16;
const KIND_MASK = 15;
/** 持ち駒になりうる駒（歩〜金）の最大番号。 */
const HAND_MAX = KI;

const KIND_BY_TYPE: Record<PieceType, number> = {
  [PAWN]: FU,
  [LANCE]: KY,
  [KNIGHT]: KE,
  [SILVER]: GI,
  [BISHOP]: KA,
  [ROOK]: HI,
  [GOLD]: KI,
  [KING]: OU,
  [PROMOTED_PAWN]: PFU,
  [PROMOTED_LANCE]: PKY,
  [PROMOTED_KNIGHT]: PKE,
  [PROMOTED_SILVER]: PGI,
  [PROMOTED_BISHOP]: PKA,
  [PROMOTED_ROOK]: PHI,
};

const BASE_TYPE_BY_KIND: BasePieceType[] = [];
BASE_TYPE_BY_KIND[FU] = PAWN;
BASE_TYPE_BY_KIND[KY] = LANCE;
BASE_TYPE_BY_KIND[KE] = KNIGHT;
BASE_TYPE_BY_KIND[GI] = SILVER;
BASE_TYPE_BY_KIND[KA] = BISHOP;
BASE_TYPE_BY_KIND[HI] = ROOK;
BASE_TYPE_BY_KIND[KI] = GOLD;

/** USI の持ち駒文字。打った手を文字列にするのに使う。 */
const USI_LETTER_BY_KIND = ["", "P", "L", "N", "S", "B", "R", "G"];

/** 成った駒 → 元の駒。取ったときに持ち駒へ入れる種類。 */
function baseKind(kind: number): number {
  return kind >= PFU ? kind - 8 : kind;
}

/** 成れる駒か。金と玉は成れない。 */
function canPromoteKind(kind: number): boolean {
  return kind <= HI;
}

// --- 駒の動きを平坦な数値配列にしておく ---
// DIRS[owner01][kind] = [dx, dy, range, dx, dy, range, ...]
const DIRS: number[][][] = [[], []];
{
  const owners: Player[] = [SENTE, GOTE];
  for (let o = 0; o < 2; o++) {
    for (let kind = 0; kind <= PHI; kind++) DIRS[o][kind] = [];
    for (const type of Object.keys(KIND_BY_TYPE) as PieceType[]) {
      const kind = KIND_BY_TYPE[type];
      const dirs = PIECE_MOVEMENTS[owners[o]][type] ?? [];
      const flat: number[] = [];
      for (const d of dirs) flat.push(d.dx, d.dy, d.range);
      DIRS[o][kind] = flat;
    }
  }
}

function ownerIndex(code: number): number {
  return code >= GOTE_BIT ? 1 : 0;
}

// --- Zobrist ハッシュ（置換表の鍵） ---
// ai-worker.js:781 の computeZobristHash と同じ考え方だが、指すたびに差分で更新する。
const MAX_HAND_COUNT = 19;
const Z_SQ_A = new Int32Array(81 * 32);
const Z_SQ_B = new Int32Array(81 * 32);
const Z_HAND_A = new Int32Array(2 * 8 * MAX_HAND_COUNT);
const Z_HAND_B = new Int32Array(2 * 8 * MAX_HAND_COUNT);
{
  // 実行ごとに値が変わると置換表の再現性が無くなるので、固定シードの疑似乱数を使う
  let seed = 0x9e3779b9;
  const next = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
  for (let i = 0; i < Z_SQ_A.length; i++) {
    Z_SQ_A[i] = next();
    Z_SQ_B[i] = next();
  }
  for (let i = 0; i < Z_HAND_A.length; i++) {
    Z_HAND_A[i] = next();
    Z_HAND_B[i] = next();
  }
}

// --- 探索中の状態（モジュールに1つだけ持つ） ---
// 探索は同期実行で、途中で他の探索が割り込むことはない。
const sq = new Int8Array(81);
/** hand[owner01][baseKind] */
const hand: Int32Array[] = [new Int32Array(8), new Int32Array(8)];
/** 玉のいるマス。攻方は盤上に玉が無いので -1 */
const kingSq = [-1, -1];
let hashA = 0;
let hashB = 0;

/** 攻方 = 先手固定。詰将棋の出題は必ず先手が攻める。 */
const ATT = 0;
const DEF = 1;

// --- 指し手の表現 ---
// 1つの数値に詰める。 下位から: to(7bit) from(7bit, 打つ手は 127) promote(1bit) dropKind(4bit)
function encodeMove(from: number, to: number, promote: boolean, dropKind: number): number {
  return to | (from << 7) | ((promote ? 1 : 0) << 14) | (dropKind << 15);
}
function moveTo(m: number): number {
  return m & 127;
}
function moveFrom(m: number): number {
  return (m >> 7) & 127;
}
function movePromote(m: number): boolean {
  return ((m >> 14) & 1) === 1;
}
function moveDropKind(m: number): number {
  return (m >> 15) & 15;
}
const NO_FROM = 127;
/** 手そのものは下位19ビット。それより上は並べ替え用の点数に使う。 */
const MOVE_MASK = 0x7ffff;

export function moveToUsi(m: number): string {
  const to = moveTo(m);
  const toFile = 9 - (to % 9);
  const toRank = String.fromCharCode(97 + Math.floor(to / 9));
  const drop = moveDropKind(m);
  if (drop !== 0) return `${USI_LETTER_BY_KIND[drop]}*${toFile}${toRank}`;
  const from = moveFrom(m);
  const fromFile = 9 - (from % 9);
  const fromRank = String.fromCharCode(97 + Math.floor(from / 9));
  return `${fromFile}${fromRank}${toFile}${toRank}${movePromote(m) ? "+" : ""}`;
}

// --- 局面の読み込み ---

export type SolverPosition = {
  /** shogi.js のグローバル board と同じ形: board[y][x] = { type, owner } | null */
  board: Board;
  /** shogi.js のグローバル capturedPieces と同じ形 */
  hands: CapturedPieces;
};

function loadPosition(pos: SolverPosition): void {
  sq.fill(0);
  hand[0].fill(0);
  hand[1].fill(0);
  kingSq[0] = -1;
  kingSq[1] = -1;
  hashA = 0;
  hashB = 0;

  for (let y = 0; y < 9; y++) {
    const row = pos.board[y];
    if (!row) continue;
    for (let x = 0; x < 9; x++) {
      const piece = row[x];
      if (!piece) continue;
      const kind = KIND_BY_TYPE[piece.type];
      if (!kind) continue;
      const o = piece.owner === GOTE ? 1 : 0;
      const code = kind | (o === 1 ? GOTE_BIT : 0);
      const i = y * 9 + x;
      sq[i] = code;
      if (kind === OU) kingSq[o] = i;
      xorSquare(i, code);
    }
  }

  const owners: Player[] = [SENTE, GOTE];
  for (let o = 0; o < 2; o++) {
    const src = pos.hands?.[owners[o]];
    if (!src) continue;
    for (let kind = FU; kind <= HAND_MAX; kind++) {
      const n = src[BASE_TYPE_BY_KIND[kind]] ?? 0;
      hand[o][kind] = n;
      xorHand(o, kind, n);
    }
  }
}

function xorSquare(i: number, code: number): void {
  const idx = i * 32 + (code & 31);
  hashA ^= Z_SQ_A[idx];
  hashB ^= Z_SQ_B[idx];
}

function xorHand(o: number, kind: number, count: number): void {
  if (count <= 0 || count >= MAX_HAND_COUNT) return;
  const idx = (o * 8 + kind) * MAX_HAND_COUNT + count;
  hashA ^= Z_HAND_A[idx];
  hashB ^= Z_HAND_B[idx];
}

// --- 指して戻す ---
// undo に必要な情報は「取った駒の符号」だけ。それ以外は手の数値から復元できる。

function doMove(m: number, o: number): number {
  const to = moveTo(m);
  const dropKind = moveDropKind(m);

  if (dropKind !== 0) {
    const before = hand[o][dropKind];
    xorHand(o, dropKind, before);
    hand[o][dropKind] = before - 1;
    xorHand(o, dropKind, before - 1);
    const code = dropKind | (o === 1 ? GOTE_BIT : 0);
    sq[to] = code;
    xorSquare(to, code);
    return 0;
  }

  const from = moveFrom(m);
  const moved = sq[from];
  const captured = sq[to];

  xorSquare(from, moved);
  sq[from] = 0;

  if (captured !== 0) {
    xorSquare(to, captured);
    const gained = baseKind(captured & KIND_MASK);
    const before = hand[o][gained];
    xorHand(o, gained, before);
    hand[o][gained] = before + 1;
    xorHand(o, gained, before + 1);
  }

  const placed = movePromote(m) ? moved + 8 : moved;
  sq[to] = placed;
  xorSquare(to, placed);

  if ((moved & KIND_MASK) === OU) kingSq[o] = to;
  return captured;
}

function undoMove(m: number, o: number, captured: number): void {
  const to = moveTo(m);
  const dropKind = moveDropKind(m);

  if (dropKind !== 0) {
    const code = dropKind | (o === 1 ? GOTE_BIT : 0);
    xorSquare(to, code);
    sq[to] = 0;
    const before = hand[o][dropKind];
    xorHand(o, dropKind, before);
    hand[o][dropKind] = before + 1;
    xorHand(o, dropKind, before + 1);
    return;
  }

  const from = moveFrom(m);
  const placed = sq[to];
  const moved = movePromote(m) ? placed - 8 : placed;

  xorSquare(to, placed);
  sq[to] = captured;
  if (captured !== 0) {
    xorSquare(to, captured);
    const gained = baseKind(captured & KIND_MASK);
    const before = hand[o][gained];
    xorHand(o, gained, before);
    hand[o][gained] = before - 1;
    xorHand(o, gained, before - 1);
  }

  sq[from] = moved;
  xorSquare(from, moved);

  if ((moved & KIND_MASK) === OU) kingSq[o] = from;
}

// --- 利きの判定 ---
// shogi_engine.ts の isSquareAttackedBy と同じ手順（目標マスから逆に辿る）。
// 盤を全走査しないので、探索の中で何度呼んでも軽い。

function isAttackedBy(o: number, targetX: number, targetY: number): boolean {
  const gote = o === 1;
  const bit = gote ? GOTE_BIT : 0;

  // 1) 桂馬（離れているので個別に見る）
  const knightY = gote ? targetY - 2 : targetY + 2;
  if (knightY >= 0 && knightY < 9) {
    const base = knightY * 9;
    if (targetX - 1 >= 0 && sq[base + targetX - 1] === (KE | bit)) return true;
    if (targetX + 1 < 9 && sq[base + targetX + 1] === (KE | bit)) return true;
  }

  // 2) 周囲8マス（1マスだけ動く利き）
  for (let dy = -1; dy <= 1; dy++) {
    const y = targetY + dy;
    if (y < 0 || y >= 9) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = targetX + dx;
      if (x < 0 || x >= 9) continue;
      const code = sq[y * 9 + x];
      if (code === 0 || ownerIndex(code) !== o) continue;
      const dirs = DIRS[o][code & KIND_MASK];
      const wantDx = -dx;
      const wantDy = -dy;
      for (let k = 0; k < dirs.length; k += 3) {
        if (dirs[k + 2] === 1 && dirs[k] === wantDx && dirs[k + 1] === wantDy) return true;
      }
    }
  }

  // 3) 飛車・竜（縦横）と香車（前方）
  for (let x = targetX + 1; x < 9; x++) {
    const code = sq[targetY * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === HI || kind === PHI) return true;
    }
    break;
  }
  for (let x = targetX - 1; x >= 0; x--) {
    const code = sq[targetY * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === HI || kind === PHI) return true;
    }
    break;
  }
  for (let y = targetY + 1; y < 9; y++) {
    const code = sq[y * 9 + targetX];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === HI || kind === PHI) return true;
      if (!gote && kind === KY) return true;
    }
    break;
  }
  for (let y = targetY - 1; y >= 0; y--) {
    const code = sq[y * 9 + targetX];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === HI || kind === PHI) return true;
      if (gote && kind === KY) return true;
    }
    break;
  }

  // 4) 角・馬（斜め）
  for (let x = targetX + 1, y = targetY + 1; x < 9 && y < 9; x++, y++) {
    const code = sq[y * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === KA || kind === PKA) return true;
    }
    break;
  }
  for (let x = targetX - 1, y = targetY + 1; x >= 0 && y < 9; x--, y++) {
    const code = sq[y * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === KA || kind === PKA) return true;
    }
    break;
  }
  for (let x = targetX + 1, y = targetY - 1; x < 9 && y >= 0; x++, y--) {
    const code = sq[y * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === KA || kind === PKA) return true;
    }
    break;
  }
  for (let x = targetX - 1, y = targetY - 1; x >= 0 && y >= 0; x--, y--) {
    const code = sq[y * 9 + x];
    if (code === 0) continue;
    if (ownerIndex(code) === o) {
      const kind = code & KIND_MASK;
      if (kind === KA || kind === PKA) return true;
    }
    break;
  }

  return false;
}

/** その手番の玉が王手されているか。玉が盤上に無ければ（＝攻方）常に false。 */
function inCheck(o: number): boolean {
  const k = kingSq[o];
  if (k < 0) return false;
  return isAttackedBy(o === 0 ? 1 : 0, k % 9, Math.floor(k / 9));
}

// --- 打てる場所の制限 ---

/** 行き所のない駒。 */
function deadDrop(kind: number, o: number, toY: number): boolean {
  if (kind === FU || kind === KY) return o === 0 ? toY === 0 : toY === 8;
  if (kind === KE) return o === 0 ? toY <= 1 : toY >= 7;
  return false;
}

/** 二歩。 */
function hasPawnInColumn(o: number, x: number): boolean {
  const want = FU | (o === 1 ? GOTE_BIT : 0);
  for (let y = 0; y < 9; y++) {
    if (sq[y * 9 + x] === want) return true;
  }
  return false;
}

/** 動かした先で二度と動けなくなる手は、成らない選択ができない。 */
function mustPromote(kind: number, o: number, toY: number): boolean {
  return deadDrop(kind, o, toY);
}

function inPromotionZone(o: number, y: number): boolean {
  return o === 0 ? y <= 2 : y >= 6;
}

// --- 手の生成 ---

/**
 * 攻方の王手だけを生成する。
 *
 * 詰将棋では攻方は王手を続けるしかないので、王手以外は最初から作らない。
 * 打つ手は「玉に利く位置」から逆算するので、空きマスを全部試す必要がない
 * （歩を持っているだけで81マスぶんの打歩詰判定が走る、という無駄を避けられる）。
 */
function genAttackerChecks(out: number[]): void {
  out.length = 0;
  const kingIdx = kingSq[DEF];
  if (kingIdx < 0) return;
  const kx = kingIdx % 9;
  const ky = Math.floor(kingIdx / 9);

  // 盤上の駒を動かす手
  for (let from = 0; from < 81; from++) {
    const code = sq[from];
    if (code === 0 || ownerIndex(code) !== ATT) continue;
    const kind = code & KIND_MASK;
    const dirs = DIRS[ATT][kind];
    const fromX = from % 9;
    const fromY = Math.floor(from / 9);
    const fromZone = inPromotionZone(ATT, fromY);
    const promotable = canPromoteKind(kind);

    for (let d = 0; d < dirs.length; d += 3) {
      const dx = dirs[d];
      const dy = dirs[d + 1];
      const range = dirs[d + 2];
      let x = fromX;
      let y = fromY;
      for (let step = 0; step < range; step++) {
        x += dx;
        y += dy;
        if (x < 0 || x >= 9 || y < 0 || y >= 9) break;
        const to = y * 9 + x;
        const target = sq[to];
        if (target !== 0 && ownerIndex(target) === ATT) break;

        const canPromoteHere = promotable && (fromZone || inPromotionZone(ATT, y));
        const forced = mustPromote(kind, ATT, y);
        if (!forced) tryAddCheck(out, encodeMove(from, to, false, 0), kx, ky);
        if (canPromoteHere) tryAddCheck(out, encodeMove(from, to, true, 0), kx, ky);

        if (target !== 0) break;
      }
    }
  }

  // 持ち駒を打つ手。玉に利く位置だけを見る
  for (let kind = FU; kind <= HAND_MAX; kind++) {
    if (hand[ATT][kind] === 0) continue;
    const dirs = DIRS[ATT][kind];
    for (let d = 0; d < dirs.length; d += 3) {
      const dx = dirs[d];
      const dy = dirs[d + 1];
      const range = dirs[d + 2];
      let x = kx;
      let y = ky;
      for (let step = 0; step < range; step++) {
        // 玉から見て逆向きに辿ると「そこに打てば玉に利く」マスになる
        x -= dx;
        y -= dy;
        if (x < 0 || x >= 9 || y < 0 || y >= 9) break;
        const to = y * 9 + x;
        if (sq[to] !== 0) break; // 駒があるとその先は遮られる
        if (deadDrop(kind, ATT, y)) continue;
        if (kind === FU) {
          if (hasPawnInColumn(ATT, x)) continue;
          if (isUchifuzumeDrop(to)) continue;
        }
        tryAddCheck(out, encodeMove(NO_FROM, to, false, kind), kx, ky);
      }
    }
  }
}

/** 実際に指してみて、玉方に王手がかかり自玉が王手にならない手だけ採る。 */
function tryAddCheck(out: number[], m: number, kx: number, ky: number): void {
  const captured = doMove(m, ATT);
  const ok = isAttackedBy(ATT, kingSq[DEF] % 9, Math.floor(kingSq[DEF] / 9)) && !inCheck(ATT);
  undoMove(m, ATT, captured);
  if (!ok) return;
  // 玉の近くに打つ・取る・成る手から先に読むと枝刈りが効きやすい
  const to = moveTo(m);
  const near = Math.max(Math.abs((to % 9) - kx), Math.abs(Math.floor(to / 9) - ky)) <= 1 ? 4 : 0;
  const cap = sq[to] !== 0 ? 2 : 0;
  const pro = movePromote(m) ? 1 : 0;
  out.push(m | ((near + cap + pro) << 19));
}

/** 打った歩がそのまま詰みなら打歩詰。玉方に合法手が残るかで見る。 */
function isUchifuzumeDrop(to: number): boolean {
  const m = encodeMove(NO_FROM, to, false, FU);
  const captured = doMove(m, ATT);
  let mate = false;
  if (inCheck(DEF)) mate = !hasAnyDefenderMove();
  undoMove(m, ATT, captured);
  return mate;
}

/**
 * 玉方の合法手を作る。
 *
 * out に null を渡すと「1手でもあるか」だけを見て、最初の1手で打ち切る。
 * 詰み判定はこの形で毎節点呼ばれるので、全部作らずに済ませたい。
 *
 * 王手を受けているとき、打つ手は「1枚の飛び道具による王手」を遮るマスにしか
 * 意味がないので、合駒になる位置だけを試す。両王手や近接王手なら打つ手は無い。
 */
function genDefenderMoves(out: number[] | null): boolean {
  if (out) out.length = 0;

  for (let from = 0; from < 81; from++) {
    const code = sq[from];
    if (code === 0 || ownerIndex(code) !== DEF) continue;
    const kind = code & KIND_MASK;
    const dirs = DIRS[DEF][kind];
    const fromX = from % 9;
    const fromY = Math.floor(from / 9);
    const fromZone = inPromotionZone(DEF, fromY);
    const promotable = canPromoteKind(kind);

    for (let d = 0; d < dirs.length; d += 3) {
      const dx = dirs[d];
      const dy = dirs[d + 1];
      const range = dirs[d + 2];
      let x = fromX;
      let y = fromY;
      for (let step = 0; step < range; step++) {
        x += dx;
        y += dy;
        if (x < 0 || x >= 9 || y < 0 || y >= 9) break;
        const to = y * 9 + x;
        const target = sq[to];
        if (target !== 0 && ownerIndex(target) === DEF) break;

        const canPromoteHere = promotable && (fromZone || inPromotionZone(DEF, y));
        const forced = mustPromote(kind, DEF, y);
        if (!forced && tryAddDefense(out, encodeMove(from, to, false, 0))) return true;
        if (canPromoteHere && tryAddDefense(out, encodeMove(from, to, true, 0))) return true;

        if (target !== 0) break;
      }
    }
  }

  let hasHand = false;
  for (let kind = FU; kind <= HAND_MAX; kind++) {
    if (hand[DEF][kind] > 0) {
      hasHand = true;
      break;
    }
  }
  if (!hasHand) return out ? out.length > 0 : false;

  // 王手されていれば合駒になるマスだけ。そうでなければ空いているマス全部。
  const targets = inCheck(DEF) ? interposeSquares() : emptySquares();
  for (const to of targets) {
    if (sq[to] !== 0) continue; // 駒のあるマスには打てない
    for (let kind = FU; kind <= HAND_MAX; kind++) {
      if (hand[DEF][kind] === 0) continue;
      const y = Math.floor(to / 9);
      if (deadDrop(kind, DEF, y)) continue;
      if (kind === FU && hasPawnInColumn(DEF, to % 9)) continue;
      if (tryAddDefense(out, encodeMove(NO_FROM, to, false, kind))) return true;
    }
  }
  return out ? out.length > 0 : false;
}

function emptySquares(): number[] {
  const list: number[] = [];
  for (let i = 0; i < 81; i++) {
    if (sq[i] === 0) list.push(i);
  }
  return list;
}

/** 合駒できるマス。王手している飛び道具が1枚のときだけ意味がある。 */
function interposeSquares(): number[] {
  const kingIdx = kingSq[DEF];
  if (kingIdx < 0) return [];
  const kx = kingIdx % 9;
  const ky = Math.floor(kingIdx / 9);

  let checkerX = -1;
  let checkerY = -1;
  let count = 0;
  for (let i = 0; i < 81; i++) {
    const code = sq[i];
    if (code === 0 || ownerIndex(code) !== ATT) continue;
    const x = i % 9;
    const y = Math.floor(i / 9);
    if (!attacksSquare(x, y, code, kx, ky)) continue;
    count++;
    if (count > 1) return []; // 両王手は合駒では受からない
    checkerX = x;
    checkerY = y;
  }
  if (count !== 1) return [];

  const adx = Math.abs(kx - checkerX);
  const ady = Math.abs(ky - checkerY);
  if (Math.max(adx, ady) < 2) return []; // 隣接した王手には合駒できない
  // 桂馬の王手は飛び越えてくるので合駒できない。縦横斜めに並んでいるときだけ間に入れる
  if (adx !== 0 && ady !== 0 && adx !== ady) return [];

  const dx = Math.sign(kx - checkerX);
  const dy = Math.sign(ky - checkerY);
  const distance = Math.max(adx, ady);
  const squares: number[] = [];
  for (let step = 1; step < distance; step++) {
    squares.push((checkerY + dy * step) * 9 + (checkerX + dx * step));
  }
  return squares;
}

/** (x,y) の駒が (tx,ty) に利いているか。 */
function attacksSquare(x: number, y: number, code: number, tx: number, ty: number): boolean {
  const o = ownerIndex(code);
  const dirs = DIRS[o][code & KIND_MASK];
  for (let d = 0; d < dirs.length; d += 3) {
    const dx = dirs[d];
    const dy = dirs[d + 1];
    const range = dirs[d + 2];
    let cx = x;
    let cy = y;
    for (let step = 0; step < range; step++) {
      cx += dx;
      cy += dy;
      if (cx < 0 || cx >= 9 || cy < 0 || cy >= 9) break;
      if (cx === tx && cy === ty) return true;
      if (sq[cy * 9 + cx] !== 0) break;
    }
  }
  return false;
}

/** 合法なら記録する。out が null のときは「見つかった」を返して打ち切らせる。 */
function tryAddDefense(out: number[] | null, m: number): boolean {
  const captured = doMove(m, DEF);
  const ok = !inCheck(DEF);
  undoMove(m, DEF, captured);
  if (!ok) return false;
  if (!out) return true;
  out.push(m);
  return false;
}

/** 玉方に合法手が1つでもあるか。詰み判定に使う。 */
function hasAnyDefenderMove(): boolean {
  return genDefenderMoves(null);
}

// --- 置換表 ---
// 攻方手番（OR節点）の結論だけ覚える。
//   mateDepth   : この手数以上あれば詰む、と分かっている最小の手数
//   noMateDepth : この手数以下では詰まない、と分かっている最大の手数

type TtEntry = { h2: number; mateDepth: number; noMateDepth: number; next: TtEntry | null };
let tt = new Map<number, TtEntry>();

function ttFind(): TtEntry | null {
  let e = tt.get(hashA) ?? null;
  while (e) {
    if (e.h2 === hashB) return e;
    e = e.next;
  }
  return null;
}

function ttStore(depth: number, mate: boolean): void {
  let e = ttFind();
  if (!e) {
    e = { h2: hashB, mateDepth: Infinity, noMateDepth: -1, next: tt.get(hashA) ?? null };
    tt.set(hashA, e);
  }
  if (mate) {
    if (depth < e.mateDepth) e.mateDepth = depth;
  } else if (depth > e.noMateDepth) {
    e.noMateDepth = depth;
  }
}

// --- 探索 ---

const MATE = 1;
const NO_MATE = 0;
const UNKNOWN = -1;

let nodeCount = 0;
let nodeLimit = 0;
let deadline = 0;
let aborted = false;

function outOfBudget(): boolean {
  if (aborted) return true;
  if (nodeCount >= nodeLimit) {
    aborted = true;
    return true;
  }
  // 時計を毎回読むと高くつくので 4096 節点ごとに見る
  if ((nodeCount & 4095) === 0 && Date.now() >= deadline) {
    aborted = true;
    return true;
  }
  return false;
}

// 深さごとに手のリストを使い回す。節点ごとに配列を作ると GC が効いてくる。
const moveListPool: number[][] = [];
function listAt(ply: number): number[] {
  let list = moveListPool[ply];
  if (!list) {
    list = [];
    moveListPool[ply] = list;
  }
  list.length = 0;
  return list;
}

/** 攻方手番。depth 手以内に詰ませられるか。 */
function orSearch(depth: number, ply: number): number {
  if (depth < 1) return NO_MATE;
  nodeCount++;
  if (outOfBudget()) return UNKNOWN;

  const entry = ttFind();
  if (entry) {
    if (depth >= entry.mateDepth) return MATE;
    if (depth <= entry.noMateDepth) return NO_MATE;
  }

  const moves = listAt(ply);
  genAttackerChecks(moves);
  if (moves.length === 0) {
    ttStore(depth, false);
    return NO_MATE;
  }
  moves.sort(descending); // 上位ビットに入れた並べ替え用の点数で降順

  let unknown = false;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] & MOVE_MASK;
    const captured = doMove(m, ATT);
    let result: number;
    if (!hasAnyDefenderMove()) {
      result = MATE;
    } else if (depth >= 3) {
      result = andSearch(depth - 1, ply + 1);
    } else {
      result = NO_MATE;
    }
    undoMove(m, ATT, captured);

    if (result === MATE) {
      ttStore(depth, true);
      return MATE;
    }
    if (result === UNKNOWN) unknown = true;
  }

  if (unknown) return UNKNOWN;
  ttStore(depth, false);
  return NO_MATE;
}

function descending(a: number, b: number): number {
  return b - a;
}

/** 玉方手番。攻方が depth 手以内に詰ませられるか（＝玉方に逃げ道が無いか）。 */
function andSearch(depth: number, ply: number): number {
  nodeCount++;
  if (outOfBudget()) return UNKNOWN;

  const moves = listAt(ply);
  genDefenderMoves(moves);
  if (moves.length === 0) return MATE;

  let unknown = false;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const captured = doMove(m, DEF);
    const result = orSearch(depth - 1, ply + 1);
    undoMove(m, DEF, captured);

    if (result === NO_MATE) return NO_MATE; // 1つでも凌げる手があれば詰まない
    if (result === UNKNOWN) unknown = true;
  }
  return unknown ? UNKNOWN : MATE;
}

// --- 公開する関数 ---

export type Budget = {
  /** 探索する節点数の上限 */
  nodes?: number;
  /** 探索に使ってよいミリ秒 */
  timeMs?: number;
};

const DEFAULT_BUDGET: Required<Budget> = { nodes: 3_000_000, timeMs: 1500 };
/** 応手の見栄えを比べるのに使ってよい時間。判定そのものには影響しない。 */
const RANK_TIME_MS = 80;

function beginSearch(budget?: Budget): void {
  nodeCount = 0;
  aborted = false;
  nodeLimit = budget?.nodes ?? DEFAULT_BUDGET.nodes;
  deadline = Date.now() + (budget?.timeMs ?? DEFAULT_BUDGET.timeMs);
  tt = new Map();
}

/**
 * 残り手数に応じた探索予算。ブラウザとテストで同じ値を使うためここに置く。
 *
 * 「正しい手を拒否される」のが最悪の体験なので、結論が出ない（unknown）のは避けたい。
 * 一方で短手数に長い予算を与えても待たされるだけなので、残り手数で切り替える。
 * 玉方が持ち駒を持つようになって合駒の分岐が増えた長手数の問題で実測したところ:
 *   残り9手以下  1.2秒で unknown 0件（最悪 326ms）
 *   残り11手以上 1.2秒で unknown 1件 / 3.0秒なら 0件（最悪 3023ms）
 * shogi.js 側の待ち上限は4秒なので 3.0秒 は収まる。
 */
export const SHORT_BUDGET: Budget = { nodes: 3_000_000, timeMs: 1200 };
export const LONG_BUDGET: Budget = { nodes: 9_000_000, timeMs: 3000 };

export function budgetForRemaining(remaining: number): Budget {
  return remaining >= 10 ? LONG_BUDGET : SHORT_BUDGET;
}

export type MateResult = true | false | null;

/**
 * 攻方手番の局面が depth 手以内に詰むか。
 * null は「予算内に結論が出なかった」。false と混同してはいけない。
 */
export function isMateWithin(pos: SolverPosition, depth: number, budget?: Budget): MateResult {
  beginSearch(budget);
  loadPosition(pos);
  const r = orSearch(depth, 0);
  return r === UNKNOWN ? null : r === MATE;
}

/** 探索が実際に使った節点数。テストで実測するために出す。 */
export function lastSearchNodes(): number {
  return nodeCount;
}

/**
 * 生成した手を USI で返す。テスト専用。
 *
 * この探索は速度のために盤を独自表現に置き換えているので、
 * 出題を検証している scripts/tsume/position.ts の列挙と一致するかを
 * 突き合わせられるようにしておく。ここがずれると判定そのものが信用できない。
 */
export function debugGenerateMoves(pos: SolverPosition): {
  attackerChecks: string[];
  defenderMoves: string[];
} {
  loadPosition(pos);
  const checks: number[] = [];
  genAttackerChecks(checks);
  const defense: number[] = [];
  genDefenderMoves(defense);
  return {
    attackerChecks: checks.map((m) => moveToUsi(m & MOVE_MASK)).sort(),
    defenderMoves: defense.map((m) => moveToUsi(m)).sort(),
  };
}

export type DefenseResult =
  /** この手を指せば残り手数では詰まない、と証明できた */
  | { kind: "escape"; usi: string; attackerHasCheck: boolean }
  /** 玉方に合法手が無い＝すでに詰んでいる */
  | { kind: "mated" }
  /** どう応じても残り手数のうちに詰む（＝利用者の手も正解） */
  | { kind: "allLose"; usi: string; attackerHasCheck: boolean }
  /** 予算内に結論が出なかった。呼び出し側は従来の即警告に戻すこと */
  | { kind: "unknown" };

/**
 * 玉方の応手を選ぶ。
 *
 * remaining は「この応手を含めて、あと何手残っているか」。
 * 応手のあと攻方に remaining-1 手あるので、そこで詰まない手を探す。
 *
 * 候補が複数あるときは、より長く詰まない手（＝粘れる手）を選ぶ。
 * 適当に選ぶと玉方が不自然に見えて、解いている側が納得できない。
 */
export function findDefense(
  pos: SolverPosition,
  remaining: number,
  budget?: Budget,
): DefenseResult {
  beginSearch(budget);
  loadPosition(pos);

  const moves: number[] = [];
  genDefenderMoves(moves);
  if (moves.length === 0) return { kind: "mated" };

  const need = remaining - 1;
  const survivors: number[] = [];
  let unknown = false;

  for (const m of moves) {
    if (need < 1) {
      survivors.push(m);
      continue;
    }
    const captured = doMove(m, DEF);
    const r = orSearch(need, 1);
    undoMove(m, DEF, captured);
    if (r === NO_MATE) survivors.push(m);
    else if (r === UNKNOWN) unknown = true;
  }

  if (survivors.length === 0) {
    if (unknown) return { kind: "unknown" };
    const chosen = pickNatural(moves);
    return {
      kind: "allLose",
      usi: moveToUsi(chosen),
      attackerHasCheck: attackerHasCheckAfter(chosen),
    };
  }

  const chosen = pickToughest(survivors, need);
  return {
    kind: "escape",
    usi: moveToUsi(chosen),
    attackerHasCheck: attackerHasCheckAfter(chosen),
  };
}

/**
 * この応手のあと、攻方に王手が1つでも残るか。
 *
 * 詰将棋は王手を続けるしかないので、王手が尽きたら利用者は何も指せなくなる。
 * その場で「詰みませんでした」と伝えないと、盤の前で手詰まりになってしまう。
 */
function attackerHasCheckAfter(m: number): boolean {
  const captured = doMove(m, DEF);
  const checks: number[] = [];
  genAttackerChecks(checks);
  undoMove(m, DEF, captured);
  return checks.length > 0;
}

/**
 * 凌げる手のうち、いちばん長く粘れるものを選ぶ。
 *
 * どれを選んでも「残り手数では詰まない」ことは証明済みなので、ここは見栄えの問題。
 * 玉方が不自然な手を指すと解いている側が納得できないので2手ぶん先まで比べるが、
 * 応手が遅れる方が体感は悪いので、余力があるときだけにする。
 */
function pickToughest(survivors: number[], need: number): number {
  if (survivors.length === 1) return survivors[0];

  const softNodeLimit = nodeCount + (nodeLimit >> 2);
  const softDeadline = Date.now() + RANK_TIME_MS;

  let best = -1;
  let bestDepth = -1;
  for (const m of survivors) {
    let depth = need;
    if (!aborted && nodeCount < softNodeLimit && Date.now() < softDeadline) {
      const captured = doMove(m, DEF);
      const r = orSearch(need + 2, 1);
      undoMove(m, DEF, captured);
      if (r === NO_MATE) depth = need + 2;
    }
    if (depth > bestDepth || (depth === bestDepth && naturalness(m) > naturalness(best))) {
      best = m;
      bestDepth = depth;
    }
  }
  return best;
}

function pickNatural(moves: number[]): number {
  let best = moves[0];
  for (const m of moves) {
    if (naturalness(m) > naturalness(best)) best = m;
  }
  return best;
}

/** 玉方の手としての自然さ。取る手・玉が逃げる手を、合駒より優先する。 */
function naturalness(m: number): number {
  if (m < 0) return -1;
  const to = moveTo(m);
  if (moveDropKind(m) !== 0) return 0; // 打って合駒
  const capture = sq[to] !== 0 ? 2 : 0;
  const from = moveFrom(m);
  const isKing = (sq[from] & KIND_MASK) === OU;
  return capture + (isKing ? 1 : 0) + 1;
}
