// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋の局面表現。src/worker/shogi_engine.ts のルール実装をそのまま使うことで、
// 生成器とクライアント（shogi.js）のルール解釈が食い違わないようにしている。
//
// 用語:
//   攻方 (attacker) = 常に先手 (SENTE)。盤上に玉を置かない。
//   玉方 (defender) = 常に後手 (GOTE)。玉が必ず1枚だけある。

import {
  BISHOP,
  CAPTURED_ORDER,
  GOLD,
  GOTE,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  ROOK,
  SENTE,
  SILVER,
  baseTypeOf,
  calculateDropLocations,
  calculateValidMoves,
  cloneBoard,
  cloneCapturedPieces,
  findKing,
  isCheckmate,
  isInPromotionZone,
  isKingInCheck,
  isUchifuzume,
  pieceInfo,
  toUsiMoveString,
} from "../../src/worker/shogi_engine.ts";
import type {
  BasePieceType,
  Board,
  CapturedPieces,
  GameState,
  Move,
  Piece,
  PieceType,
  Player,
} from "../../src/worker/shogi_engine.ts";

export const ATTACKER: Player = SENTE;
export const DEFENDER: Player = GOTE;

/** 盤・持ち駒・手番だけを持つ軽量な局面。GameState の履歴類は詰将棋では不要。 */
export type Position = {
  board: Board;
  hands: CapturedPieces;
  turn: Player;
};

// --- SFEN ---------------------------------------------------------------

const SFEN_BY_TYPE: Record<PieceType, string> = {
  FU: "P",
  KY: "L",
  KE: "N",
  GI: "S",
  KI: "G",
  KA: "B",
  HI: "R",
  OU: "K",
  "+FU": "+P",
  "+KY": "+L",
  "+KE": "+N",
  "+GI": "+S",
  "+KA": "+B",
  "+HI": "+R",
};

const TYPE_BY_SFEN: Record<string, PieceType> = Object.fromEntries(
  Object.entries(SFEN_BY_TYPE).map(([type, letter]) => [letter, type as PieceType]),
) as Record<string, PieceType>;

/** 持ち駒の SFEN 表記順（USI の慣例）。 */
const HAND_ORDER: BasePieceType[] = [ROOK, BISHOP, GOLD, SILVER, KNIGHT, LANCE, PAWN];

export function emptyBoard(): Board {
  return Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
}

export function emptyHands(): CapturedPieces {
  const zero = () =>
    Object.fromEntries(CAPTURED_ORDER.map((t) => [t, 0])) as Record<BasePieceType, number>;
  return { [SENTE]: zero(), [GOTE]: zero() } as CapturedPieces;
}

export function clonePosition(pos: Position): Position {
  return {
    board: cloneBoard(pos.board),
    hands: cloneCapturedPieces(pos.hands),
    turn: pos.turn,
  };
}

export function toSfen(pos: Position, moveNumber = 1): string {
  const rows: string[] = [];
  for (let y = 0; y < 9; y++) {
    let row = "";
    let empty = 0;
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      const letter = SFEN_BY_TYPE[piece.type];
      row += piece.owner === SENTE ? letter : letter.toLowerCase();
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }

  let hand = "";
  for (const owner of [SENTE, GOTE] as Player[]) {
    for (const type of HAND_ORDER) {
      const count = pos.hands[owner][type] ?? 0;
      if (count <= 0) continue;
      if (count > 1) hand += String(count);
      const letter = SFEN_BY_TYPE[type];
      hand += owner === SENTE ? letter : letter.toLowerCase();
    }
  }
  if (hand === "") hand = "-";

  return `${rows.join("/")} ${pos.turn === SENTE ? "b" : "w"} ${hand} ${moveNumber}`;
}

export function fromSfen(sfen: string): Position {
  const [boardPart, turnPart, handPart] = sfen.trim().split(/\s+/);
  if (!boardPart || !turnPart || !handPart) throw new Error(`bad sfen: ${sfen}`);

  const board = emptyBoard();
  const rows = boardPart.split("/");
  if (rows.length !== 9) throw new Error(`bad sfen ranks: ${sfen}`);

  rows.forEach((row, y) => {
    let x = 0;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch >= "1" && ch <= "9") {
        x += Number(ch);
        continue;
      }
      let letter = ch;
      if (ch === "+") {
        letter = "+" + row[++i];
      }
      const upper = letter.toUpperCase();
      const type = TYPE_BY_SFEN[upper];
      if (!type) throw new Error(`bad sfen piece: ${letter}`);
      if (x > 8) throw new Error(`sfen rank overflow: ${row}`);
      // 大文字=先手、小文字=後手。'+' 付きは2文字目で判定する。
      const isSente = letter.replace("+", "")[0] === upper.replace("+", "")[0];
      board[y][x] = { type, owner: isSente ? SENTE : GOTE };
      x++;
    }
  });

  const hands = emptyHands();
  if (handPart !== "-") {
    let count = 0;
    for (const ch of handPart) {
      if (ch >= "0" && ch <= "9") {
        count = count * 10 + Number(ch);
        continue;
      }
      const type = TYPE_BY_SFEN[ch.toUpperCase()] as BasePieceType;
      if (!type) throw new Error(`bad sfen hand: ${ch}`);
      const owner = ch === ch.toUpperCase() ? SENTE : GOTE;
      hands[owner][type] = (hands[owner][type] ?? 0) + (count || 1);
      count = 0;
    }
  }

  return { board, hands, turn: turnPart === "b" ? SENTE : GOTE };
}

// --- 指し手 -------------------------------------------------------------

/**
 * 手番側の合法手をすべて列挙する。
 * calculateValidMoves は行き先だけを返すので、成/不成の両方に展開する。
 */
export function enumerateLegalMoves(pos: Position): Move[] {
  const moves: Move[] = [];
  const player = pos.turn;

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece || piece.owner !== player) continue;

      for (const dest of calculateValidMoves(x, y, piece, pos.board)) {
        const canPromote = pieceInfo[piece.type]?.canPromote ?? false;
        const promoAllowed =
          canPromote && (isInPromotionZone(player, y) || isInPromotionZone(player, dest.y));
        const mustPromote =
          ((piece.type === PAWN || piece.type === LANCE) &&
            (player === SENTE ? dest.y === 0 : dest.y === 8)) ||
          (piece.type === KNIGHT && (player === SENTE ? dest.y <= 1 : dest.y >= 7));

        if (!mustPromote) {
          moves.push({ type: "move", fromX: x, fromY: y, toX: dest.x, toY: dest.y });
        }
        if (promoAllowed) {
          moves.push({
            type: "move",
            fromX: x,
            fromY: y,
            toX: dest.x,
            toY: dest.y,
            promote: true,
          });
        }
      }
    }
  }

  for (const type of CAPTURED_ORDER) {
    if ((pos.hands[player][type] ?? 0) <= 0) continue;
    for (const dest of calculateDropLocations(type, player, pos.board, pos.hands)) {
      moves.push({ type: "drop", pieceType: type, toX: dest.x, toY: dest.y });
    }
  }

  return moves;
}

/**
 * 指し手を適用した局面を返す。合法性は enumerateLegalMoves 側で担保する前提の軽量版。
 * applyMove は履歴や千日手判定まで持つので、詰将棋では使わずこちらを使う。
 */
export function applyMoveToPosition(pos: Position, move: Move): Position {
  const next = clonePosition(pos);
  const player = pos.turn;

  if (move.type === "move") {
    const piece = next.board[move.fromY][move.fromX];
    if (!piece) throw new Error("no piece at from-square");
    const captured = next.board[move.toY][move.toX];
    if (captured) {
      const base = baseTypeOf(captured.type);
      next.hands[player][base] = (next.hands[player][base] ?? 0) + 1;
    }
    const moved: Piece = { ...piece };
    if (move.promote) {
      const promoted = pieceInfo[moved.type]?.promoted;
      if (!promoted) throw new Error("cannot promote");
      moved.type = promoted;
    }
    next.board[move.toY][move.toX] = moved;
    next.board[move.fromY][move.fromX] = null;
  } else {
    if ((next.hands[player][move.pieceType] ?? 0) <= 0) throw new Error("no piece in hand");
    next.hands[player][move.pieceType]! -= 1;
    next.board[move.toY][move.toX] = { type: move.pieceType, owner: player };
  }

  next.turn = player === SENTE ? GOTE : SENTE;
  return next;
}

/** 盤上の1枚が動ける先を返す。「動かせる駒」の下地を塗るのに使う。 */
export function calculateValidMovesFor(
  pos: Position,
  x: number,
  y: number,
): Array<{ x: number; y: number }> {
  const piece = pos.board[y][x];
  if (!piece) return [];
  return calculateValidMoves(x, y, piece, pos.board);
}

/** 攻方の手のうち、玉方に王手がかかるものだけを返す。 */
export function enumerateCheckingMoves(pos: Position): Move[] {
  return enumerateLegalMoves(pos).filter((move) => {
    const next = applyMoveToPosition(pos, move);
    return isKingInCheck(DEFENDER, next.board);
  });
}

export function isDefenderMated(pos: Position): boolean {
  return isCheckmate(DEFENDER, pos.board, pos.hands);
}

/**
 * そのマスへの歩打ちが打歩詰になるか。
 * 「打てば詰みなのに反則で指せない」地点があると、良い紛れになる。
 */
export function isUchifuzumeAt(pos: Position, x: number, y: number): boolean {
  if ((pos.hands[ATTACKER][PAWN] ?? 0) <= 0) return false;
  if (pos.board[y][x]) return false;
  if (y === 0) return false; // 行き所のない歩
  for (let checkY = 0; checkY < 9; checkY++) {
    const piece = pos.board[checkY][x];
    if (piece && piece.type === PAWN && piece.owner === ATTACKER) return false; // 二歩
  }
  return isUchifuzume(x, y, ATTACKER, pos.board, pos.hands);
}

export function usi(move: Move): string {
  return toUsiMoveString(move);
}

/** USI 文字列から Move を復元する（エンジンが返す手の照合用）。 */
export function moveFromUsi(text: string, pos: Position): Move {
  const dropMatch = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(text);
  if (dropMatch) {
    const type = TYPE_BY_SFEN[dropMatch[1]] as BasePieceType;
    return {
      type: "drop",
      pieceType: type,
      toX: 9 - Number(dropMatch[2]),
      toY: dropMatch[3].charCodeAt(0) - 97,
    };
  }
  const moveMatch = /^([1-9])([a-i])([1-9])([a-i])(\+?)$/.exec(text);
  if (!moveMatch) throw new Error(`bad usi move: ${text}`);
  const move: Move = {
    type: "move",
    fromX: 9 - Number(moveMatch[1]),
    fromY: moveMatch[2].charCodeAt(0) - 97,
    toX: 9 - Number(moveMatch[3]),
    toY: moveMatch[4].charCodeAt(0) - 97,
  };
  if (moveMatch[5] === "+") move.promote = true;
  // 盤上に駒が無い＝不正な手。呼び出し側のバグを早期に検出する。
  if (!pos.board[move.fromY][move.fromX]) throw new Error(`no piece for usi move: ${text}`);
  return move;
}

// --- 正規化・ハッシュ ---------------------------------------------------

/** 左右反転した局面。重複判定で鏡像を同一視するために使う。 */
export function mirrorPosition(pos: Position): Position {
  const board = emptyBoard();
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      board[y][8 - x] = pos.board[y][x] ? { ...pos.board[y][x]! } : null;
    }
  }
  return { board, hands: cloneCapturedPieces(pos.hands), turn: pos.turn };
}

/** 鏡像を同一視した正規形キー。出題済み台帳の照合に使う。 */
export function canonicalKey(pos: Position): string {
  const a = toSfen(pos, 1);
  const b = toSfen(mirrorPosition(pos), 1);
  return a <= b ? a : b;
}

// --- 局面の妥当性 -------------------------------------------------------

const MAX_COUNT: Record<BasePieceType, number> = {
  [PAWN]: 18,
  [LANCE]: 4,
  [KNIGHT]: 4,
  [SILVER]: 4,
  [GOLD]: 4,
  [BISHOP]: 2,
  [ROOK]: 2,
};

/**
 * 詰将棋の初期局面として成立しているか。
 * ここで弾いておくとソルバー呼び出しを大きく節約できる。
 */
export function validateProblemPosition(pos: Position): string | null {
  if (pos.turn !== ATTACKER) return "攻方の手番ではない";
  if (findKing(ATTACKER, pos.board)) return "攻方の玉が盤上にある";

  const defenderKing = findKing(DEFENDER, pos.board);
  if (!defenderKing) return "玉方の玉がない";

  let kingCount = 0;
  const counts: Record<string, number> = {};
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = pos.board[y][x];
      if (!piece) continue;
      if (piece.type === KING) {
        kingCount++;
        continue;
      }
      const base = baseTypeOf(piece.type);
      counts[base] = (counts[base] ?? 0) + 1;

      // 行き所のない駒
      const lastRank = piece.owner === SENTE ? 0 : 8;
      const secondRank = piece.owner === SENTE ? 1 : 7;
      if ((piece.type === PAWN || piece.type === LANCE) && y === lastRank) {
        return "行き所のない駒がある";
      }
      if (piece.type === KNIGHT && (y === lastRank || y === secondRank)) {
        return "行き所のない駒がある";
      }
    }
  }
  if (kingCount !== 1) return "玉が1枚ではない";

  for (const owner of [SENTE, GOTE] as Player[]) {
    for (const type of CAPTURED_ORDER) {
      counts[type] = (counts[type] ?? 0) + (pos.hands[owner][type] ?? 0);
    }
  }
  for (const type of CAPTURED_ORDER) {
    if ((counts[type] ?? 0) > MAX_COUNT[type]) return `${type} が多すぎる`;
  }

  // 二歩
  for (const owner of [SENTE, GOTE] as Player[]) {
    for (let x = 0; x < 9; x++) {
      let pawns = 0;
      for (let y = 0; y < 9; y++) {
        const piece = pos.board[y][x];
        if (piece && piece.type === PAWN && piece.owner === owner) pawns++;
      }
      if (pawns > 1) return "二歩";
    }
  }

  // 初手が王手でないと詰将棋にならない／初形で王手がかかっているのも不可
  if (isKingInCheck(DEFENDER, pos.board)) return "初形で王手がかかっている";

  return null;
}

/** 攻方の持ち駒が空か（駒余りなしの判定に使う）。 */
export function attackerHandIsEmpty(pos: Position): boolean {
  return CAPTURED_ORDER.every((type) => (pos.hands[ATTACKER][type] ?? 0) === 0);
}

export function countBoardPieces(pos: Position): number {
  let n = 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (pos.board[y][x]) n++;
  return n;
}

/**
 * 玉方の盤上の駒数（玉を含む）。1 なら裸玉。
 * 実戦の詰みは玉方自身の駒が逃げ道を塞いで成立するので、これが実戦形らしさの目安になる。
 */
export function countDefenderPieces(pos: Position): number {
  let n = 0;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      if (pos.board[y][x]?.owner === DEFENDER) n++;
    }
  }
  return n;
}

export { CAPTURED_ORDER, KING, KNIGHT, LANCE, PAWN, isKingInCheck };
export type { BasePieceType, Board, CapturedPieces, GameState, Move, Piece, PieceType, Player };
