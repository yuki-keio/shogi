// SPDX-License-Identifier: GPL-3.0-only

// 手筋の判定。1手ぶんを見るだけの純粋関数で、読みは入れない。
//
// 同じ手に複数当たったら、DETECTORS の並び順で最初に当たったものを名前にする。
// 順番が実際に効くのは次の所だけ:
//   田楽刺し vs 十字飛車 … 串刺しが勝つ
//   叩きの歩 vs 垂れ歩   … 進む先に駒がいれば叩き
//   王手飛車 vs 割り打ち・ふんどし … 玉と飛の両取りは、駒が何であれ王手飛車
//   腹金 vs 王手飛車 … 詰ませる金打ちは、飛車に当たっていても腹金（頭金と同じく詰みの形が先）
//   両王手 vs 王手飛車 … 2枚で王手なら、飛車に当たっていても両王手
//   開き王手 vs 王手飛車・両取り … 後ろの駒で王手しながら駒に当てる手は、当てたほうの名前（王手飛車など）
//   開き王手 vs と金作り … 歩を成って後ろの駒の王手を通した手は開き王手

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

/**
 * 腹金。持ち駒の金を相手玉の真横に打って、詰んでいること。
 * 出典はどれも「打つ」形で説明していて、盤上の金を寄せる手を腹金と呼ぶ例が無いので、打つ手だけ
 * （頭金は動かす手も含めている）。成駒は含めない
 */
function haraKin(ctx: Ctx): WazaHit | null {
  if (!ctx.isDrop || ctx.moved.type !== GOLD) return null;
  for (const dx of [-1, 1]) {
    const king = pieceAt(ctx.after, ctx.toX + dx, ctx.toY);
    if (!king || king.owner !== ctx.opponent || king.type !== KING) continue;
    if (!isCheckmate(ctx.opponent, ctx.after, ctx.base.after.capturedPieces)) return null;
    return hit(ctx, "hara_kin", "none", [{ x: ctx.toX + dx, y: ctx.toY }]);
  }
  return null;
}

/** 相手玉と、それに王手をかけている自分の駒のマス。王手でなければ null */
function checkersOf(ctx: Ctx): { king: Square; from: Square[] } | null {
  if (!ctx.base.after.isCheck) return null;
  const king = findKing(ctx.opponent, ctx.after);
  if (!king) return null;
  const from: Square[] = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = ctx.after[y][x];
      if (piece && piece.owner === ctx.player && attacksSquare(ctx.after, x, y, king.x, king.y)) {
        from.push({ x, y });
      }
    }
  }
  return { king, from };
}

/**
 * 両王手。1手で2枚が同時に王手している（動かした駒と、その後ろから通り道が開いた駒）。
 * 合駒も、王手している駒を取るのも効かない。線は2枚それぞれから玉へ引く
 */
function ryoOute(ctx: Ctx): WazaHit | null {
  const check = checkersOf(ctx);
  if (!check || check.from.length < 2) return null;
  const others = check.from.filter((sq) => sq.x !== ctx.toX || sq.y !== ctx.toY);
  return { ...hit(ctx, "ryo_oute", "big", [check.king]), alsoFrom: others };
}

/**
 * 開き王手。動かした駒ではなく、その後ろにいた駒（飛・角・香など）の通り道が開いて王手になった。
 * 札の先頭は動かした駒ではなく王手をかけた駒にして、そこから玉へ線を引く
 */
function akiOute(ctx: Ctx): WazaHit | null {
  const check = checkersOf(ctx);
  if (!check || check.from.length !== 1) return null;
  const [from] = check.from;
  if (from.x === ctx.toX && from.y === ctx.toY) return null;
  return { kind: "tesuji", id: "aki_oute", tier: "mid", player: ctx.player, ply: ctx.base.ply, squares: [from, check.king] };
}

/** 同じ段を dx の向きへ進んで、最初に当たる駒 */
function firstOnRank(board: Board, x: number, y: number, dx: number): Piece | null {
  for (let cx = x + dx; cx >= 0 && cx < 9; cx += dx) {
    if (board[y][cx]) return board[y][cx];
  }
  return null;
}

/**
 * 相手がどの駒で取っても得にならないか。取り合い計算（see）は安い駒から順に取る前提なので、
 * 「馬で取れば後ろの角が通って取り返せるが、竜で取れば取り返せない」という形を見落とす。
 * 取る駒を1枚ずつ試して、取り返しまで数える
 */
function safeFromEveryTaker(board: Board, x: number, y: number, taker: Player): boolean {
  for (let ty = 0; ty < 9; ty++) {
    for (let tx = 0; tx < 9; tx++) {
      const piece = board[ty][tx];
      if (!piece || piece.owner !== taker || !attacksSquare(board, tx, ty, x, y)) continue;
      if (seeCapture(board, tx, ty, x, y) > 0) return false;
    }
  }
  return true;
}

/** 底歩で守る駒（止めた通り道の先にいる駒）。歩の真上の駒は金・銀だけ（金底の歩） */
const SOKOFU_GUARDED = new Set<PieceType>([GOLD, SILVER, KING]);

/**
 * 底歩。自陣のいちばん下の段に歩を打ち、同じ段にいる相手の飛車・竜の横の通り道を止める。
 * 🔴 守るものがあるときだけ：歩の真上に自分の金・銀がいる（金底の歩）か、止めた先に自分の金・銀・玉がいる。
 *    竜の王手を歩で止める合駒も底歩に入る（将棋講座ドットコムの例）。
 * 🔴 打った歩をどの駒でただで取られても出さない（出典でも、支えのない歩は底歩と呼ばない）。
 *    相手の飛車が来る前に打っておく「予防の底歩」は形で見分けられないので出さない
 */
function sokofu(ctx: Ctx): WazaHit | null {
  if (!ctx.isDrop || ctx.moved.type !== PAWN) return null;
  if (ctx.toY !== (ctx.player === SENTE ? 8 : 0)) return null;
  const above = pieceAt(ctx.after, ctx.toX, ctx.toY + ctx.fwd);
  const underGold = above !== null && above.owner === ctx.player && (above.type === GOLD || above.type === SILVER);
  for (const dx of [-1, 1]) {
    const rook = firstOnRank(ctx.after, ctx.toX, ctx.toY, dx);
    if (!rook || rook.owner !== ctx.opponent || (rook.type !== ROOK && rook.type !== PROMOTED_ROOK)) continue;
    const behind = firstOnRank(ctx.after, ctx.toX, ctx.toY, -dx);
    const guardsBehind = behind !== null && behind.owner === ctx.player && SOKOFU_GUARDED.has(behind.type);
    if (!underGold && !guardsBehind) continue;
    if (!safeFromEveryTaker(ctx.after, ctx.toX, ctx.toY, ctx.opponent)) return null;
    return hit(ctx, "sokofu", "small", []);
  }
  return null;
}

/**
 * 桂頭の銀。攻めてきた相手の桂の頭（すぐ前）に銀を置く受けの手筋。桂は前の銀を取れず、
 * 跳ねる先の2マスは銀の斜め後ろが押さえる。打つ手も、盤上の銀を動かす手も含む（出典どおり）。
 * 🔴 持ち主の陣（先手の桂なら七〜九段目）の外にいる桂だけ（跳ねてきた桂も、打ち込まれた桂も）。
 *    陣の中にいる桂の前へ銀を打ち込むのは攻めの手で、この手筋ではない。成桂は金の動きなので含めない
 */
function keitoNoGin(ctx: Ctx): WazaHit | null {
  if (ctx.moved.type !== SILVER) return null;
  const ky = ctx.toY + ctx.fwd;
  const knight = pieceAt(ctx.after, ctx.toX, ky);
  if (!knight || knight.owner !== ctx.opponent || knight.type !== KNIGHT) return null;
  const inOwnCamp = knight.owner === SENTE ? ky >= 6 : ky <= 2;
  if (inOwnCamp) return null;
  if (!survivesOnSquare(ctx.after, ctx.toX, ctx.toY)) return null;
  return hit(ctx, "keito_no_gin", "small", [{ x: ctx.toX, y: ky }]);
}

const DETECTORS: Detector[] = [
  atamaKin,
  haraKin,
  ryoOute,
  outeBisha,
  dengakuZashi,
  jujiBisha,
  wariuchiNoGin,
  fundoshiNoKei,
  akiOute,
  keitoNoGin,
  tatakiNoFu,
  tarefu,
  sokofu,
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
