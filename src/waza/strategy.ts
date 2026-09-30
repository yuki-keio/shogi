// SPDX-License-Identifier: GPL-3.0-only

// 戦法の判定。飛車を横へ動かした瞬間・飛車先に銀を繰り出した瞬間・石田流の形に飛車を上げた瞬間・
// 嬉野流の出だしで角を引いた瞬間・角換わりの交換が済んだ瞬間だけを見る。

import {
  BISHOP,
  GOTE,
  PAWN,
  PROMOTED_BISHOP,
  PROMOTED_SILVER,
  ROOK,
  SENTE,
  SILVER,
  type BasePieceType,
  type Board,
  type CapturedPieces,
  type Player,
} from "../worker/shogi_engine.ts";
import { WAZA_CONFIG } from "./config.ts";
import type { MoveContext, StrategyId, WazaHit } from "./types.ts";

/** 先手基準の「飛車を振った筋」。後手は x を 8-x に写してから引く */
const ROOK_FILE_TO_ID: Record<number, StrategyId> = {
  1: "mukai_bisha", // 8筋
  2: "sanken_bisha", // 7筋
  3: "shiken_bisha", // 6筋
  4: "naka_bisha", // 5筋
};
/** 先手基準の飛車の最初の筋（2筋）と、右四間飛車の筋（4筋）。どちらも ownFile() と同じ盤の列の番号 */
const ROOK_START_FILE = 7;
const MIGI_SHIKEN_FILE = 5;
/** 嬉野流とみなす角の引き：自分の3手目まで（先手5手目・後手6手目） */
const URESHINO_MAX_PLY = 6;

function ownFile(x: number, player: Player): number {
  return player === SENTE ? x : 8 - x;
}

/** 両者の持ち駒が、右四間飛車と呼べる序盤の範囲（角換わり・歩の突き捨てくらい）に収まっているか。上限に無い駒は1枚でもあればだめ */
function stillOpening(captured: CapturedPieces): boolean {
  const limit = WAZA_CONFIG.migiShikenMaxHand;
  return [SENTE, GOTE].every((side) =>
    Object.entries(captured[side]).every(([type, count]) => count <= (limit[type as BasePieceType] ?? 0)),
  );
}

/** 盤のマスを、先手基準の筋・段（'7六' なら 7, 6）で表す。後手は盤を180度回して見る */
function ownSquare(x: number, y: number, player: Player): { file: number; rank: number } {
  return player === SENTE ? { file: 9 - x, rank: y + 1 } : { file: x + 1, rank: 9 - y };
}

/** 先手基準の筋・段（'7六' なら 7, 6）にいる、player の駒の種類。後手は盤を180度回して見る */
function ownPieceAt(board: Board, file: number, rank: number, player: Player): string | null {
  const x = player === SENTE ? 9 - file : file - 1;
  const y = player === SENTE ? rank - 1 : 9 - rank;
  const piece = board[y][x];
  return piece && piece.owner === player ? piece.type : null;
}

/** 最初の筋（先手2筋・後手8筋）に、成っていない飛車がいるか（浮き飛車・引き飛車も含む） */
function rookOnStartFile(board: Board, player: Player): boolean {
  const x = ownFile(ROOK_START_FILE, player);
  return board.some((row) => row[x]?.owner === player && row[x]?.type === ROOK);
}

/** 飛車の前の歩を突いたか（最初のマス＝先手2七・後手8三に自分の歩がいない）。居飛車で戦うしるし */
function rookPawnPushed(board: Board, player: Player): boolean {
  return ownPieceAt(board, 2, 7, player) !== PAWN;
}

/** 最初の並びで盤にある、角以外の駒の数（片側ぶん） */
const OPENING_PIECES: Record<string, number> = { FU: 9, KY: 2, KE: 2, GI: 2, KI: 2, HI: 1, OU: 1 };

/** 両者とも、盤の駒が「最初の並びから角が抜けただけ」か（成った駒も、取った駒の打ち直しも無い） */
function onlyBishopsTraded(board: Board): boolean {
  const count: Record<Player, Record<string, number>> = { [SENTE]: {}, [GOTE]: {} };
  for (const row of board) {
    for (const piece of row) {
      if (piece) count[piece.owner][piece.type] = (count[piece.owner][piece.type] ?? 0) + 1;
    }
  }
  return [SENTE, GOTE].every((side) =>
    Object.keys(count[side]).length === Object.keys(OPENING_PIECES).length &&
    Object.entries(OPENING_PIECES).every(([type, n]) => count[side][type] === n),
  );
}

function bishopsOnBoard(board: Board): number {
  let count = 0;
  for (const row of board) {
    for (const piece of row) {
      if (piece && (piece.type === BISHOP || piece.type === PROMOTED_BISHOP)) count += 1;
    }
  }
  return count;
}

/**
 * 角換わり。この手で盤から最後の角（馬）がいなくなり、両者が角を1枚ずつ持ち駒にした瞬間。
 * 名前は指した側に付く。相手の側にも同じ手で付けるのは scanWaza（交換は二人でするものなので）。
 * 🔴 角を取った手（仕掛けた側）では出さない。AI同士では、序盤に角で角を取った手の半分は
 *    次の手で取り返されていない（それは交換ではなく、角をただで取っただけ）。
 * 🔴 ほかの駒を取り合っていない・両者の飛車が最初の筋のまま・両者とも飛車の前の歩を突いている、の3つを見る。
 *    3つめが無いと、交換の直後に飛車を振る角交換振り飛車（ダイレクト向かい飛車など）と見分けられない
 */
function kakugawari(ctx: MoveContext): WazaHit | null {
  if (ctx.ply > WAZA_CONFIG.kakugawariMaxPly) return null;
  const { before, after } = ctx;
  // この手で盤の最後の角を取った。盤が「最初の並びから角だけ抜けた形」で両者が角を1枚ずつ持っていれば、
  // 盤に角は無く、持ち駒もほかには無い（駒は全部で40枚）
  if (bishopsOnBoard(before.board) !== 1) return null;
  const hand = after.capturedPieces;
  if (hand[SENTE].KA !== 1 || hand[GOTE].KA !== 1 || !onlyBishopsTraded(after.board)) return null;
  if (!rookOnStartFile(after.board, SENTE) || !rookOnStartFile(after.board, GOTE)) return null;
  if (!rookPawnPushed(after.board, SENTE) || !rookPawnPushed(after.board, GOTE)) return null;
  // 交換した後は盤に角がいないので、光らせるマスは無い（札だけ出す）
  return { kind: "strategy", id: "kakugawari", tier: "small", player: before.currentPlayer, ply: ctx.ply, squares: [] };
}

/** 成っていない飛車の筋（盤全体から探す）。無ければ null */
function rookFile(board: Board, player: Player): number | null {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece && piece.owner === player && piece.type === ROOK) return x;
    }
  }
  return null;
}

export function detectStrategy(ctx: MoveContext): WazaHit | null {
  if (ctx.ply > WAZA_CONFIG.strategyMaxPly) return null;
  const player = ctx.before.currentPlayer;
  const move = ctx.move;
  if (move.type !== "move") return null;

  const moved = ctx.after.board[move.toY][move.toX];
  if (!moved || moved.owner !== player) return null;

  const exchange = kakugawari(ctx);
  if (exchange) return exchange;

  // 石田流：三間飛車の飛車を、2つ伸ばした歩のすぐ後ろへ上げた手（先手なら▲7五歩の形で▲7六飛）。
  // 🔴 同じ筋を縦に動いた手だけ（7五に歩がいるので、上からは来られない）。中盤に横から回ってきた飛車などは拾わない
  if (moved.type === ROOK && move.fromX === move.toX) {
    const to = ownSquare(move.toX, move.toY, player);
    if (to.file !== 7 || to.rank !== 6 || ownPieceAt(ctx.after.board, 7, 5, player) !== PAWN) return null;
    return { kind: "strategy", id: "ishida_ryu", tier: "small", player, ply: ctx.ply, squares: [{ x: move.toX, y: move.toY }] };
  }

  // 嬉野流：自分の最初の3手のうちに、8八の角を7九へ引いた手。6八に銀がいて（＝初手の▲6八銀）、
  // 角の通り道の歩（7七）は突いていない。初手▲6八銀だけだと矢倉の出だしと同じ局面になりうるので、角を引いた瞬間で見る
  if (moved.type === BISHOP) {
    const from = ownSquare(move.fromX, move.fromY, player);
    const to = ownSquare(move.toX, move.toY, player);
    const retreated = ctx.ply <= URESHINO_MAX_PLY && from.file === 8 && from.rank === 8 && to.file === 7 && to.rank === 9;
    if (!retreated) return null;
    if (ownPieceAt(ctx.after.board, 6, 8, player) !== SILVER || ownPieceAt(ctx.after.board, 7, 7, player) !== PAWN) return null;
    return { kind: "strategy", id: "ureshino_ryu", tier: "small", player, ply: ctx.ply, squares: [{ x: move.toX, y: move.toY }] };
  }

  // 飛車を横へ動かした手（振り飛車・右四間飛車）
  if (moved.type === ROOK) {
    if (move.fromX === move.toX) return null;
    // 自陣（先手なら七〜九段目）に振ったときだけ。中盤に飛車を五段目へ寄せただけの手を拾わない
    const inOwnCamp = player === SENTE ? move.toY >= 6 : move.toY <= 2;
    if (!inOwnCamp) return null;
    const file = ownFile(move.toX, player);
    let id: StrategyId | undefined = ROOK_FILE_TO_ID[file];
    // 右四間飛車は居飛車の戦法なので、最初の筋の飛車（一段引いた形も含む）を回したときだけ。
    // 振り飛車から戻した飛車や、駒の取り合いが進んだ中盤に逃がしただけの飛車は拾わない
    if (file === MIGI_SHIKEN_FILE) {
      const fromStart = ownFile(move.fromX, player) === ROOK_START_FILE;
      if (fromStart && stillOpening(ctx.before.capturedPieces)) id = "migi_shiken_bisha";
    }
    if (!id) return null;
    return {
      kind: "strategy",
      id,
      tier: "small",
      player,
      ply: ctx.ply,
      squares: [{ x: move.toX, y: move.toY }],
    };
  }

  // 飛車先に銀を繰り出した手（棒銀）。早繰り銀・腰掛け銀は筋が違うので当たらない。
  // 🔴 飛車が初期の筋（先手2筋・後手8筋）にいることも要る。これが無いと
  //    中飛車の5六銀・四間飛車の6六銀まで「棒銀」になってしまう
  if (moved.type === SILVER) {
    const file = rookFile(ctx.after.board, player);
    if (file === null || file !== move.toX) return null;
    if (ownFile(file, player) !== ROOK_START_FILE) return null;
    const rank = player === SENTE ? move.toY : 8 - move.toY;
    if (!WAZA_CONFIG.boginRanks.includes(rank)) return null;
    return {
      kind: "strategy",
      id: "bogin",
      tier: "small",
      player,
      ply: ctx.ply,
      squares: [{ x: move.toX, y: move.toY }],
    };
  }

  return null;
}

/**
 * その戦法の形がいまも盤上に残っているか。主役の駒で見る。
 * 振り飛車・右四間飛車・石田流は、動かした筋に飛車がいるか（浮き飛車のように同じ筋で前へ出るのは構わない）。
 * 棒銀は、1・2筋の六段目から先に銀がいるか（端へ回った1五銀や成銀も棒銀のうち。
 * 交換で取られたり、引いたりしたら崩れたとみなす）
 */
export function strategyStands(board: Board, hit: WazaHit): boolean {
  const player = hit.player;
  // 角換わりは、飛車が最初の筋にいるあいだ（後から飛車を振ったら崩れたとみなす）
  if (hit.id === "kakugawari") return rookOnStartFile(board, player);
  // 嬉野流は、引いた角が7九にいるあいだ
  if (hit.id === "ureshino_ryu") return ownPieceAt(board, 7, 9, player) === BISHOP;
  const rookX = hit.squares[0]?.x;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (!piece || piece.owner !== player) continue;
      if (hit.id !== "bogin") {
        if (piece.type === ROOK && x === rookX) return true;
        continue;
      }
      if (piece.type !== SILVER && piece.type !== PROMOTED_SILVER) continue;
      const rank = player === SENTE ? y : 8 - y;
      if (ownFile(x, player) >= 7 && rank <= 5) return true;
    }
  }
  return false;
}
