// SPDX-License-Identifier: GPL-3.0-only

// 手筋の判定。1手ぶんを見るだけの純粋関数で、読みは入れない。
//
// 同じ手に複数当たったら、DETECTORS の並び順で最初に当たったものを名前にする。
// 順番が実際に効くのは3か所だけ:
//   田楽刺し vs 十字飛車 … 串刺しが勝つ
//   叩きの歩 vs 垂れ歩   … 進む先に駒がいれば叩き
//   王手飛車 vs 割り打ち・ふんどし … 玉と飛の両取りは、駒が何であれ王手飛車

import {
  GOLD,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  PROMOTED_KNIGHT,
  PROMOTED_LANCE,
  PROMOTED_PAWN,
  PROMOTED_ROOK,
  PROMOTED_SILVER,
  ROOK,
  SENTE,
  SILVER,
  baseTypeOf,
  findKing,
  getOpponent,
  isCheckmate,
  type Board,
  type Piece,
  type PieceType,
  type Player,
} from "../worker/shogi_engine.ts";
import { attacksSquare, dirsOf, forwardOf, onBoard } from "./attack.ts";
import { WAZA_CONFIG } from "./config.ts";
import { quietMove, see, seeCapture, survivesOnSquare, withoutPiece } from "./see.ts";
import type { MoveContext, Square, WazaHit, WazaId, WazaTier } from "./types.ts";
import { BOARD_VALUE } from "./values.ts";

type Detector = (ctx: Ctx) => WazaHit | null;

/** 判定のあいだ使い回す値。毎回引き直さないためにまとめておく */
type Ctx = {
  base: MoveContext;
  player: Player;
  opponent: Player;
  after: Board;
  toX: number;
  toY: number;
  moved: Piece;
  /** 前へ進む向き（先手は -1） */
  fwd: number;
  isDrop: boolean;
};

function hit(ctx: Ctx, id: WazaId, tier: WazaTier, squares: Square[]): WazaHit {
  return {
    kind: "tesuji",
    id,
    tier,
    player: ctx.player,
    ply: ctx.base.ply,
    squares: [{ x: ctx.toX, y: ctx.toY }, ...squares],
  };
}

/** 両取りの標的として数えてよい駒か（歩と玉は数えない） */
function isForkTarget(piece: Piece | null, opponent: Player): piece is Piece {
  if (!piece || piece.owner !== opponent) return false;
  if (piece.type === KING) return false;
  return baseTypeOf(piece.type) !== PAWN;
}

function pieceAt(board: Board, x: number, y: number): Piece | null {
  if (!onBoard(x, y)) return null;
  return board[y][x];
}

// ---------------------------------------------------------------------------

/** 頭金。金が相手玉の真正面に来て、詰んでいること。用語としての「頭金」は金を指すので成駒は含めない */
function atamaKin(ctx: Ctx): WazaHit | null {
  if (ctx.moved.type !== GOLD) return null;
  const ky = ctx.toY + ctx.fwd;
  const king = pieceAt(ctx.after, ctx.toX, ky);
  if (!king || king.owner !== ctx.opponent || king.type !== KING) return null;
  if (!isCheckmate(ctx.opponent, ctx.after, ctx.base.after.capturedPieces)) return null;
  return hit(ctx, "atama_kin", "none", [{ x: ctx.toX, y: ky }]);
}

/** 王手飛車。王手をかけながら、動かした駒が相手の飛（龍）にも当たっている */
function outeBisha(ctx: Ctx): WazaHit | null {
  // after.currentPlayer は相手なので、after.isCheck は「相手に王手がかかっている」
  if (!ctx.base.after.isCheck) return null;
  const kingPos = findKing(ctx.opponent, ctx.after);
  if (!kingPos) return null;

  // 動かした駒そのものが王手をかけているときだけ門1を見る。
  // 開き王手は相手が王手の受けを迫られるので、動かした駒はすぐには取られない
  const givesCheckItself = attacksSquare(ctx.after, ctx.toX, ctx.toY, kingPos.x, kingPos.y);
  if (givesCheckItself && !survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = ctx.after[y][x];
      if (!piece || piece.owner !== ctx.opponent) continue;
      if (piece.type !== ROOK && piece.type !== PROMOTED_ROOK) continue;
      if (!attacksSquare(ctx.after, ctx.toX, ctx.toY, x, y)) continue;
      if (seeCapture(ctx.after, ctx.toX, ctx.toY, x, y) <= 0) continue;
      return hit(ctx, "oute_bisha", "big", [kingPos, { x, y }]);
    }
  }
  return null;
}

/** 田楽刺し。同じ直線に相手の駒が2枚並び、手前を取るか、手前が逃げたら奥が取れる */
function dengakuZashi(ctx: Ctx): WazaHit | null {
  // 香だけ。飛や龍も串刺しは作れるが、終盤にいくらでも起きるので大技として扱わない
  if (ctx.moved.type !== LANCE) return null;
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;

  for (const dir of dirsOf(ctx.moved)) {
    if (dir.range < 2) continue;
    let first: { x: number; y: number; piece: Piece } | null = null;
    let second: { x: number; y: number; piece: Piece } | null = null;
    for (let i = 1; i <= dir.range; i++) {
      const cx = ctx.toX + dir.dx * i;
      const cy = ctx.toY + dir.dy * i;
      if (!onBoard(cx, cy)) break;
      const piece = ctx.after[cy][cx];
      if (!piece) continue;
      if (!first) first = { x: cx, y: cy, piece };
      else {
        second = { x: cx, y: cy, piece };
        break;
      }
    }
    if (!first || !second) continue;
    if (first.piece.owner !== ctx.opponent || second.piece.owner !== ctx.opponent) continue;
    // 奥が玉ならピン。ピンのカテゴリは作らない
    if (first.piece.type === KING || second.piece.type === KING) continue;
    // 🔴 手前が歩・香だと串刺しにならない。香は縦にしか刺せないので、この2つは筋から
    // 横に出られず「逃げたら奥を取られる」が起きない（ただの歩を1枚取れるだけになる）。
    // と金・成香は金の動きで横へ逃げられるので、成った駒は除かないこと
    if (first.piece.type === PAWN || first.piece.type === LANCE) continue;
    if (BOARD_VALUE[second.piece.type] < WAZA_CONFIG.minDengakuBackValue) continue;

    if (seeCapture(ctx.after, ctx.toX, ctx.toY, first.x, first.y) > 0) {
      return hit(ctx, "dengaku_zashi", "big", [first, second]);
    }
    // 手前が逃げたら奥が取れるか
    const escaped = withoutPiece(ctx.after, first.x, first.y);
    if (seeCapture(escaped, ctx.toX, ctx.toY, second.x, second.y) > 0) {
      return hit(ctx, "dengaku_zashi", "big", [first, second]);
    }
  }
  return null;
}

/** 十字飛車。飛（龍）が縦に1枚・横に1枚に当たっている */
function jujiBisha(ctx: Ctx): WazaHit | null {
  const type = ctx.moved.type;
  if (type !== ROOK && type !== PROMOTED_ROOK) return null;
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;

  let vertical: Square | null = null;
  let horizontal: Square | null = null;
  let verticalValue = 0;
  let horizontalValue = 0;
  for (const dir of dirsOf(ctx.moved)) {
    if (dir.range < 2) continue;
    for (let i = 1; i <= dir.range; i++) {
      const cx = ctx.toX + dir.dx * i;
      const cy = ctx.toY + dir.dy * i;
      if (!onBoard(cx, cy)) break;
      const piece = ctx.after[cy][cx];
      if (!piece) continue;
      if (isForkTarget(piece, ctx.opponent)) {
        // しきい値は「札に出す2枚」だけで見る。別の向きに当たっている駒で下駄をはかせない
        if (dir.dy !== 0 && !vertical) {
          vertical = { x: cx, y: cy };
          verticalValue = BOARD_VALUE[piece.type];
        }
        if (dir.dx !== 0 && !horizontal) {
          horizontal = { x: cx, y: cy };
          horizontalValue = BOARD_VALUE[piece.type];
        }
      }
      break;
    }
  }
  if (!vertical || !horizontal) return null;
  if (Math.max(verticalValue, horizontalValue) < WAZA_CONFIG.minJujiTargetValue) return null;
  if (Math.min(verticalValue, horizontalValue) < WAZA_CONFIG.minJujiEachValue) return null;
  // 🔴 2枚とも本当に取れること。片方が守られていると、相手は取れるほうを動かすだけで
  // 済み、残ったほうは取っても損（＝両取りになっていない）。ここを「どちらか」にすると
  // ただの金取りが大技の札になる
  const takesBoth =
    seeCapture(ctx.after, ctx.toX, ctx.toY, vertical.x, vertical.y) > 0 &&
    seeCapture(ctx.after, ctx.toX, ctx.toY, horizontal.x, horizontal.y) > 0;
  if (!takesBoth) return null;
  return hit(ctx, "juji_bisha", "big", [vertical, horizontal]);
}

/** 打った駒の左右2マスに当たる形（割り打ちの銀・ふんどしの桂で共通） */
function forkAt(
  ctx: Ctx,
  targetY: number,
  id: WazaId,
): WazaHit | null {
  const left = pieceAt(ctx.after, ctx.toX - 1, targetY);
  const right = pieceAt(ctx.after, ctx.toX + 1, targetY);
  if (!isForkTarget(left, ctx.opponent) || !isForkTarget(right, ctx.opponent)) return null;
  if (
    Math.max(BOARD_VALUE[left.type], BOARD_VALUE[right.type]) <
    WAZA_CONFIG.minForkTargetValue
  ) {
    return null;
  }
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;
  const a = { x: ctx.toX - 1, y: targetY };
  const b = { x: ctx.toX + 1, y: targetY };
  const takesOne =
    seeCapture(ctx.after, ctx.toX, ctx.toY, a.x, a.y) > 0 ||
    seeCapture(ctx.after, ctx.toX, ctx.toY, b.x, b.y) > 0;
  if (!takesOne) return null;
  return hit(ctx, id, "mid", [a, b]);
}

/** 割り打ちの銀。銀を打ち、後ろ斜めの2マスに当たっている */
function wariuchiNoGin(ctx: Ctx): WazaHit | null {
  if (ctx.moved.type !== SILVER) return null;
  if (!ctx.isDrop) return null;
  return forkAt(ctx, ctx.toY - ctx.fwd, "wariuchi_no_gin");
}

/** ふんどしの桂。打ちも跳ねも認める */
function fundoshiNoKei(ctx: Ctx): WazaHit | null {
  if (ctx.moved.type !== KNIGHT) return null;
  return forkAt(ctx, ctx.toY + ctx.fwd * 2, "fundoshi_no_kei");
}

/** 叩きの歩。相手の駒（歩と玉を除く）の前に歩を打つ。取らせる手筋なので門1は見ない */
function tatakiNoFu(ctx: Ctx): WazaHit | null {
  if (!ctx.isDrop || ctx.moved.type !== PAWN) return null;
  const ty = ctx.toY + ctx.fwd;
  const target = pieceAt(ctx.after, ctx.toX, ty);
  if (!target || target.owner !== ctx.opponent) return null;
  // 標的は金・銀だけ。相手の駒すべてを認めると、終盤の歩打ちがほぼ全部これになる
  if (target.type !== GOLD && target.type !== SILVER) return null;
  return hit(ctx, "tataki_no_fu", "small", [{ x: ctx.toX, y: ty }]);
}

/** 垂れ歩。相手側から2〜4段目に歩を打ち、次に成ってと金を作る */
function tarefu(ctx: Ctx): WazaHit | null {
  if (ctx.moved.type !== PAWN) return null;
  if (!ctx.isDrop) return null;

  const rankFromOpponent = ctx.player === SENTE ? ctx.toY + 1 : 9 - ctx.toY;
  if (rankFromOpponent < 2 || rankFromOpponent > 4) return null;

  const py = ctx.toY + ctx.fwd;
  if (!onBoard(ctx.toX, py)) return null;
  if (ctx.after[py][ctx.toX] !== null) return null;
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;

  // 門2: 成るマスに本当に行けるか
  const advanced = quietMove(ctx.after, ctx.toX, ctx.toY, ctx.toX, py);
  advanced[py][ctx.toX] = { type: PROMOTED_PAWN, owner: ctx.player };
  if (see(advanced, ctx.toX, py, ctx.opponent) > 0) return null;

  return hit(ctx, "tarefu", "small", [{ x: ctx.toX, y: py }]);
}

/** と金作り。歩が成った手 */
function tokinZukuri(ctx: Ctx): WazaHit | null {
  const move = ctx.base.move;
  if (move.type !== "move" || !move.promote) return null;
  const before = ctx.base.before.board[move.fromY][move.fromX];
  if (!before || before.type !== PAWN) return null;
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;
  return hit(ctx, "tokin_zukuri", "small", []);
}

const DETECTORS: Detector[] = [
  atamaKin,
  outeBisha,
  dengakuZashi,
  jujiBisha,
  wariuchiNoGin,
  fundoshiNoKei,
  tatakiNoFu,
  tarefu,
  tokinZukuri,
];

export function detectTesuji(base: MoveContext): WazaHit | null {
  const player = base.before.currentPlayer;
  const move = base.move;
  const after = base.after.board;
  const moved = after[move.toY][move.toX];
  if (!moved || moved.owner !== player) return null;

  const ctx: Ctx = {
    base,
    player,
    opponent: getOpponent(player),
    after,
    toX: move.toX,
    toY: move.toY,
    moved,
    fwd: forwardOf(player),
    isDrop: move.type === "drop",
  };

  for (const detector of DETECTORS) {
    const found = detector(ctx);
    if (found) return found;
  }
  return null;
}
