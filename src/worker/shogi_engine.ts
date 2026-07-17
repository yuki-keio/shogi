// SPDX-License-Identifier: GPL-3.0-only

// A small shogi rules engine extracted from the frontend logic (shogi.js),
// used for server-authoritative validation in online matches.

export const SENTE = "sente" as const;
export const GOTE = "gote" as const;
export type Player = typeof SENTE | typeof GOTE;

export const KING = "OU" as const;
export const ROOK = "HI" as const;
export const BISHOP = "KA" as const;
export const GOLD = "KI" as const;
export const SILVER = "GI" as const;
export const KNIGHT = "KE" as const;
export const LANCE = "KY" as const;
export const PAWN = "FU" as const;

export const PROMOTED_ROOK = "+HI" as const;
export const PROMOTED_BISHOP = "+KA" as const;
export const PROMOTED_SILVER = "+GI" as const;
export const PROMOTED_KNIGHT = "+KE" as const;
export const PROMOTED_LANCE = "+KY" as const;
export const PROMOTED_PAWN = "+FU" as const;

export type PieceType =
  | typeof KING
  | typeof ROOK
  | typeof BISHOP
  | typeof GOLD
  | typeof SILVER
  | typeof KNIGHT
  | typeof LANCE
  | typeof PAWN
  | typeof PROMOTED_ROOK
  | typeof PROMOTED_BISHOP
  | typeof PROMOTED_SILVER
  | typeof PROMOTED_KNIGHT
  | typeof PROMOTED_LANCE
  | typeof PROMOTED_PAWN;

export type BasePieceType =
  | typeof ROOK
  | typeof BISHOP
  | typeof GOLD
  | typeof SILVER
  | typeof KNIGHT
  | typeof LANCE
  | typeof PAWN;

export type Piece = { type: PieceType; owner: Player };
export type Board = (Piece | null)[][];

export type Captured = Record<BasePieceType, number>;
export type CapturedPieces = Record<Player, Captured>;

export type GameState = {
  board: Board;
  capturedPieces: CapturedPieces;
  currentPlayer: Player;
  moveCount: number;
  lastMove: { x: number; y: number } | null;
  isCheck: boolean;
  positionHistory: string[];
  checkHistory: boolean[];
  turnHistory: Player[];
  usiMoveHistory: string[];
};

export type Move =
  | {
      type: "move";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      promote?: boolean;
    }
  | {
      type: "drop";
      pieceType: BasePieceType;
      toX: number;
      toY: number;
    };

export type ApplyResult = {
  state: GameState;
  gameOver: boolean;
  winner: "sente" | "gote" | "draw" | null;
  resultReason:
    | "checkmate"
    | "sennichite"
    | "perpetual_check"
    | null;
};

const CAPTURED_ORDER: BasePieceType[] = [
  ROOK,
  BISHOP,
  GOLD,
  SILVER,
  KNIGHT,
  LANCE,
  PAWN,
];

const pieceInfo: Record<
  PieceType,
  { canPromote: boolean; promoted?: PieceType; base?: BasePieceType }
> = {
  [KING]: { canPromote: false },
  [ROOK]: { canPromote: true, promoted: PROMOTED_ROOK },
  [BISHOP]: { canPromote: true, promoted: PROMOTED_BISHOP },
  [GOLD]: { canPromote: false },
  [SILVER]: { canPromote: true, promoted: PROMOTED_SILVER },
  [KNIGHT]: { canPromote: true, promoted: PROMOTED_KNIGHT },
  [LANCE]: { canPromote: true, promoted: PROMOTED_LANCE },
  [PAWN]: { canPromote: true, promoted: PROMOTED_PAWN },
  [PROMOTED_ROOK]: { canPromote: false, base: ROOK },
  [PROMOTED_BISHOP]: { canPromote: false, base: BISHOP },
  [PROMOTED_SILVER]: { canPromote: false, base: SILVER },
  [PROMOTED_KNIGHT]: { canPromote: false, base: KNIGHT },
  [PROMOTED_LANCE]: { canPromote: false, base: LANCE },
  [PROMOTED_PAWN]: { canPromote: false, base: PAWN },
};

type Dir = { dx: number; dy: number; range: number };
type MovementTable = Record<Player, Partial<Record<PieceType, Dir[]>>>;

const PIECE_MOVEMENTS: MovementTable = {
  [SENTE]: {
    [PAWN]: [{ dx: 0, dy: -1, range: 1 }],
    [LANCE]: [{ dx: 0, dy: -1, range: 8 }],
    [KNIGHT]: [
      { dx: -1, dy: -2, range: 1 },
      { dx: 1, dy: -2, range: 1 },
    ],
    [SILVER]: [
      { dx: 0, dy: -1, range: 1 },
      { dx: -1, dy: -1, range: 1 },
      { dx: 1, dy: -1, range: 1 },
      { dx: -1, dy: 1, range: 1 },
      { dx: 1, dy: 1, range: 1 },
    ],
    [GOLD]: [
      { dx: 0, dy: -1, range: 1 },
      { dx: -1, dy: -1, range: 1 },
      { dx: 1, dy: -1, range: 1 },
      { dx: -1, dy: 0, range: 1 },
      { dx: 1, dy: 0, range: 1 },
      { dx: 0, dy: 1, range: 1 },
    ],
    [BISHOP]: [
      { dx: 1, dy: 1, range: 8 },
      { dx: 1, dy: -1, range: 8 },
      { dx: -1, dy: 1, range: 8 },
      { dx: -1, dy: -1, range: 8 },
    ],
    [ROOK]: [
      { dx: 1, dy: 0, range: 8 },
      { dx: -1, dy: 0, range: 8 },
      { dx: 0, dy: 1, range: 8 },
      { dx: 0, dy: -1, range: 8 },
    ],
    [KING]: [
      { dx: 0, dy: -1, range: 1 },
      { dx: -1, dy: -1, range: 1 },
      { dx: 1, dy: -1, range: 1 },
      { dx: -1, dy: 0, range: 1 },
      { dx: 1, dy: 0, range: 1 },
      { dx: 0, dy: 1, range: 1 },
      { dx: -1, dy: 1, range: 1 },
      { dx: 1, dy: 1, range: 1 },
    ],
  },
  [GOTE]: {
    [PAWN]: [{ dx: 0, dy: 1, range: 1 }],
    [LANCE]: [{ dx: 0, dy: 1, range: 8 }],
    [KNIGHT]: [
      { dx: -1, dy: 2, range: 1 },
      { dx: 1, dy: 2, range: 1 },
    ],
    [SILVER]: [
      { dx: 0, dy: 1, range: 1 },
      { dx: -1, dy: 1, range: 1 },
      { dx: 1, dy: 1, range: 1 },
      { dx: -1, dy: -1, range: 1 },
      { dx: 1, dy: -1, range: 1 },
    ],
    [GOLD]: [
      { dx: 0, dy: 1, range: 1 },
      { dx: -1, dy: 1, range: 1 },
      { dx: 1, dy: 1, range: 1 },
      { dx: -1, dy: 0, range: 1 },
      { dx: 1, dy: 0, range: 1 },
      { dx: 0, dy: -1, range: 1 },
    ],
    [BISHOP]: [
      { dx: 1, dy: 1, range: 8 },
      { dx: 1, dy: -1, range: 8 },
      { dx: -1, dy: 1, range: 8 },
      { dx: -1, dy: -1, range: 8 },
    ],
    [ROOK]: [
      { dx: 1, dy: 0, range: 8 },
      { dx: -1, dy: 0, range: 8 },
      { dx: 0, dy: 1, range: 8 },
      { dx: 0, dy: -1, range: 8 },
    ],
    [KING]: [
      { dx: 0, dy: 1, range: 1 },
      { dx: -1, dy: 1, range: 1 },
      { dx: 1, dy: 1, range: 1 },
      { dx: -1, dy: 0, range: 1 },
      { dx: 1, dy: 0, range: 1 },
      { dx: 0, dy: -1, range: 1 },
      { dx: -1, dy: -1, range: 1 },
      { dx: 1, dy: -1, range: 1 },
    ],
  },
};

// Promoted pieces (gold moves)
for (const owner of [SENTE, GOTE] as const) {
  const goldMoves = PIECE_MOVEMENTS[owner][GOLD]!;
  PIECE_MOVEMENTS[owner][PROMOTED_PAWN] = goldMoves;
  PIECE_MOVEMENTS[owner][PROMOTED_LANCE] = goldMoves;
  PIECE_MOVEMENTS[owner][PROMOTED_KNIGHT] = goldMoves;
  PIECE_MOVEMENTS[owner][PROMOTED_SILVER] = goldMoves;

  // Horse = bishop + king(orthogonal)
  PIECE_MOVEMENTS[owner][PROMOTED_BISHOP] = [
    ...(PIECE_MOVEMENTS[owner][BISHOP] as Dir[]),
    { dx: 1, dy: 0, range: 1 },
    { dx: -1, dy: 0, range: 1 },
    { dx: 0, dy: 1, range: 1 },
    { dx: 0, dy: -1, range: 1 },
  ];

  // Dragon = rook + king(diagonal)
  PIECE_MOVEMENTS[owner][PROMOTED_ROOK] = [
    ...(PIECE_MOVEMENTS[owner][ROOK] as Dir[]),
    { dx: 1, dy: 1, range: 1 },
    { dx: 1, dy: -1, range: 1 },
    { dx: -1, dy: 1, range: 1 },
    { dx: -1, dy: -1, range: 1 },
  ];
}

function getOpponent(player: Player): Player {
  return player === SENTE ? GOTE : SENTE;
}

function getPieceMovements(type: PieceType, owner: Player): Dir[] {
  return (PIECE_MOVEMENTS[owner][type] ?? []) as Dir[];
}

function initCaptured(): Captured {
  return {
    [ROOK]: 0,
    [BISHOP]: 0,
    [GOLD]: 0,
    [SILVER]: 0,
    [KNIGHT]: 0,
    [LANCE]: 0,
    [PAWN]: 0,
  };
}

export function createInitialGameState(): GameState {
  const board: Board = Array.from({ length: 9 }, () => Array(9).fill(null));

  const initialSetup: Array<{ x: number; y: number; type: PieceType; owner: Player }> =
    [
      // GOTE (top)
      { x: 0, y: 0, type: LANCE, owner: GOTE },
      { x: 1, y: 0, type: KNIGHT, owner: GOTE },
      { x: 2, y: 0, type: SILVER, owner: GOTE },
      { x: 3, y: 0, type: GOLD, owner: GOTE },
      { x: 4, y: 0, type: KING, owner: GOTE },
      { x: 5, y: 0, type: GOLD, owner: GOTE },
      { x: 6, y: 0, type: SILVER, owner: GOTE },
      { x: 7, y: 0, type: KNIGHT, owner: GOTE },
      { x: 8, y: 0, type: LANCE, owner: GOTE },
      { x: 1, y: 1, type: ROOK, owner: GOTE },
      { x: 7, y: 1, type: BISHOP, owner: GOTE },
      { x: 0, y: 2, type: PAWN, owner: GOTE },
      { x: 1, y: 2, type: PAWN, owner: GOTE },
      { x: 2, y: 2, type: PAWN, owner: GOTE },
      { x: 3, y: 2, type: PAWN, owner: GOTE },
      { x: 4, y: 2, type: PAWN, owner: GOTE },
      { x: 5, y: 2, type: PAWN, owner: GOTE },
      { x: 6, y: 2, type: PAWN, owner: GOTE },
      { x: 7, y: 2, type: PAWN, owner: GOTE },
      { x: 8, y: 2, type: PAWN, owner: GOTE },
      // SENTE (bottom)
      { x: 0, y: 6, type: PAWN, owner: SENTE },
      { x: 1, y: 6, type: PAWN, owner: SENTE },
      { x: 2, y: 6, type: PAWN, owner: SENTE },
      { x: 3, y: 6, type: PAWN, owner: SENTE },
      { x: 4, y: 6, type: PAWN, owner: SENTE },
      { x: 5, y: 6, type: PAWN, owner: SENTE },
      { x: 6, y: 6, type: PAWN, owner: SENTE },
      { x: 7, y: 6, type: PAWN, owner: SENTE },
      { x: 8, y: 6, type: PAWN, owner: SENTE },
      { x: 1, y: 7, type: BISHOP, owner: SENTE },
      { x: 7, y: 7, type: ROOK, owner: SENTE },
      { x: 0, y: 8, type: LANCE, owner: SENTE },
      { x: 1, y: 8, type: KNIGHT, owner: SENTE },
      { x: 2, y: 8, type: SILVER, owner: SENTE },
      { x: 3, y: 8, type: GOLD, owner: SENTE },
      { x: 4, y: 8, type: KING, owner: SENTE },
      { x: 5, y: 8, type: GOLD, owner: SENTE },
      { x: 6, y: 8, type: SILVER, owner: SENTE },
      { x: 7, y: 8, type: KNIGHT, owner: SENTE },
      { x: 8, y: 8, type: LANCE, owner: SENTE },
    ];

  for (const p of initialSetup) {
    board[p.y][p.x] = { type: p.type, owner: p.owner };
  }

  const capturedPieces: CapturedPieces = {
    [SENTE]: initCaptured(),
    [GOTE]: initCaptured(),
  };

  const currentPlayer: Player = SENTE;
  const isCheck = false;
  const hash = getBoardHash(board, capturedPieces, currentPlayer);

  return {
    board,
    capturedPieces,
    currentPlayer,
    moveCount: 0,
    lastMove: null,
    isCheck,
    positionHistory: [hash],
    checkHistory: [isCheck],
    turnHistory: [currentPlayer],
    usiMoveHistory: [],
  };
}

function cloneBoard(boardToClone: Board): Board {
  return boardToClone.map((row) =>
    row.map((piece) => (piece ? { ...piece } : null))
  );
}

function cloneCapturedPieces(captured: CapturedPieces): CapturedPieces {
  return {
    [SENTE]: { ...captured[SENTE] },
    [GOTE]: { ...captured[GOTE] },
  };
}

function assertInBounds(x: number, y: number) {
  if (x < 0 || x >= 9 || y < 0 || y >= 9) {
    throw new Error("out_of_bounds");
  }
}

function baseTypeOf(type: PieceType): BasePieceType {
  const info = pieceInfo[type];
  if (info.base) return info.base;
  // KING can't be captured into hand, but keep this safe.
  return type.replace("+", "") as BasePieceType;
}

function toUsiSquare(x: number, y: number): string {
  const file = 9 - x;
  const rank = String.fromCharCode("a".charCodeAt(0) + y);
  return `${file}${rank}`;
}

export function toUsiMoveString(move: Move): string {
  if (move.type === "drop") {
    const pieceCharMap: Record<BasePieceType, string> = {
      [PAWN]: "P",
      [LANCE]: "L",
      [KNIGHT]: "N",
      [SILVER]: "S",
      [GOLD]: "G",
      [BISHOP]: "B",
      [ROOK]: "R",
    };
    return `${pieceCharMap[move.pieceType]}*${toUsiSquare(move.toX, move.toY)}`;
  }

  const from = toUsiSquare(move.fromX, move.fromY);
  const to = toUsiSquare(move.toX, move.toY);
  const promoteSymbol = move.promote ? "+" : "";
  return `${from}${to}${promoteSymbol}`;
}

function getBoardHash(
  board: Board,
  captured: CapturedPieces,
  player: Player,
): string {
  let hash = "";

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece) {
        hash += `${x}${y}${piece.type}${piece.owner}|`;
      }
    }
  }

  hash += "S:";
  for (const t of CAPTURED_ORDER) {
    const n = captured[SENTE][t];
    if (n > 0) hash += `${t}${n}|`;
  }

  hash += "G:";
  for (const t of CAPTURED_ORDER) {
    const n = captured[GOTE][t];
    if (n > 0) hash += `${t}${n}|`;
  }

  hash += `P:${player}`;
  return hash;
}

function findKing(player: Player, board: Board): { x: number; y: number } | null {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p && p.owner === player && p.type === KING) return { x, y };
    }
  }
  return null;
}

function isSquareAttackedBy(
  attacker: Player,
  targetX: number,
  targetY: number,
  board: Board,
): boolean {
  // 1) Knights (non-adjacent)
  const knightOriginY = attacker === SENTE ? targetY + 2 : targetY - 2;
  if (knightOriginY >= 0 && knightOriginY < 9) {
    const leftX = targetX - 1;
    const rightX = targetX + 1;
    if (leftX >= 0) {
      const p = board[knightOriginY][leftX];
      if (p && p.owner === attacker && p.type === KNIGHT) return true;
    }
    if (rightX < 9) {
      const p = board[knightOriginY][rightX];
      if (p && p.owner === attacker && p.type === KNIGHT) return true;
    }
  }

  // 2) Adjacent 8 squares (range=1 moves)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = targetX + dx;
      const y = targetY + dy;
      if (x < 0 || x >= 9 || y < 0 || y >= 9) continue;

      const piece = board[y][x];
      if (!piece || piece.owner !== attacker) continue;

      const wantDx = targetX - x;
      const wantDy = targetY - y;
      for (const m of getPieceMovements(piece.type, piece.owner)) {
        if (m.range === 1 && m.dx === wantDx && m.dy === wantDy) return true;
      }
    }
  }

  // 3) Rook/Dragon (orthogonal) + Lance (forward)
  // Right
  for (let x = targetX + 1; x < 9; x++) {
    const p = board[targetY][x];
    if (!p) continue;
    if (
      p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)
    ) return true;
    break;
  }
  // Left
  for (let x = targetX - 1; x >= 0; x--) {
    const p = board[targetY][x];
    if (!p) continue;
    if (
      p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)
    ) return true;
    break;
  }
  // Down (y+)
  for (let y = targetY + 1; y < 9; y++) {
    const p = board[y][targetX];
    if (!p) continue;
    if (p.owner === attacker) {
      if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
      if (attacker === SENTE && p.type === LANCE) return true;
    }
    break;
  }
  // Up (y-)
  for (let y = targetY - 1; y >= 0; y--) {
    const p = board[y][targetX];
    if (!p) continue;
    if (p.owner === attacker) {
      if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
      if (attacker === GOTE && p.type === LANCE) return true;
    }
    break;
  }

  // 4) Bishop/Horse (diagonal)
  // Right-down
  for (let x = targetX + 1, y = targetY + 1; x < 9 && y < 9; x++, y++) {
    const p = board[y][x];
    if (!p) continue;
    if (
      p.owner === attacker &&
      (p.type === BISHOP || p.type === PROMOTED_BISHOP)
    ) return true;
    break;
  }
  // Left-down
  for (let x = targetX - 1, y = targetY + 1; x >= 0 && y < 9; x--, y++) {
    const p = board[y][x];
    if (!p) continue;
    if (
      p.owner === attacker &&
      (p.type === BISHOP || p.type === PROMOTED_BISHOP)
    ) return true;
    break;
  }
  // Right-up
  for (let x = targetX + 1, y = targetY - 1; x < 9 && y >= 0; x++, y--) {
    const p = board[y][x];
    if (!p) continue;
    if (
      p.owner === attacker &&
      (p.type === BISHOP || p.type === PROMOTED_BISHOP)
    ) return true;
    break;
  }
  // Left-up
  for (let x = targetX - 1, y = targetY - 1; x >= 0 && y >= 0; x--, y--) {
    const p = board[y][x];
    if (!p) continue;
    if (
      p.owner === attacker &&
      (p.type === BISHOP || p.type === PROMOTED_BISHOP)
    ) return true;
    break;
  }

  return false;
}

function isKingInCheck(player: Player, board: Board): boolean {
  const kingPos = findKing(player, board);
  if (!kingPos) return false;
  return isSquareAttackedBy(getOpponent(player), kingPos.x, kingPos.y, board);
}

function calculatePseudoMoves(
  x: number,
  y: number,
  piece: Piece,
  board: Board,
): Array<{ x: number; y: number }> {
  const moves: Array<{ x: number; y: number }> = [];
  const owner = piece.owner;
  const opponent = getOpponent(owner);
  const directions = getPieceMovements(piece.type, owner);

  for (const dir of directions) {
    let currentX = x;
    let currentY = y;
    for (let i = 0; i < dir.range; i++) {
      currentX += dir.dx;
      currentY += dir.dy;
      if (currentX < 0 || currentX >= 9 || currentY < 0 || currentY >= 9) {
        break;
      }
      const targetPiece = board[currentY][currentX];
      if (targetPiece === null) {
        moves.push({ x: currentX, y: currentY });
      } else if (targetPiece.owner === opponent) {
        moves.push({ x: currentX, y: currentY });
        break;
      } else {
        break;
      }

      if (dir.range === 1) break;
    }
  }

  return moves;
}

function calculateValidMoves(
  x: number,
  y: number,
  piece: Piece,
  board: Board,
): Array<{ x: number; y: number }> {
  const owner = piece.owner;
  const pseudoMoves = calculatePseudoMoves(x, y, piece, board);
  return pseudoMoves.filter((move) => {
    const tempBoard = cloneBoard(board);
    tempBoard[move.y][move.x] = tempBoard[y][x];
    tempBoard[y][x] = null;
    return !isKingInCheck(owner, tempBoard);
  });
}

function isUchifuzume(
  toX: number,
  toY: number,
  player: Player,
  board: Board,
  capturedPieces: CapturedPieces,
): boolean {
  const tempBoard = cloneBoard(board);
  tempBoard[toY][toX] = { type: PAWN, owner: player };

  const opponent = getOpponent(player);
  if (!isKingInCheck(opponent, tempBoard)) return false;

  return isCheckmate(opponent, tempBoard, capturedPieces);
}

function calculateDropLocations(
  pieceType: BasePieceType,
  owner: Player,
  board: Board,
  capturedPieces: CapturedPieces,
): Array<{ x: number; y: number }> {
  const locations: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      if (board[y][x] !== null) continue;

      // No-square rule
      if (
        (pieceType === PAWN || pieceType === LANCE) &&
        (owner === SENTE ? y === 0 : y === 8)
      ) continue;
      if (
        pieceType === KNIGHT && (owner === SENTE ? y <= 1 : y >= 7)
      ) continue;

      // Nifu + Uchifuzume
      if (pieceType === PAWN) {
        let hasPawnInColumn = false;
        for (let checkY = 0; checkY < 9; checkY++) {
          const p = board[checkY][x];
          if (p && p.type === PAWN && p.owner === owner) {
            hasPawnInColumn = true;
            break;
          }
        }
        if (hasPawnInColumn) continue;
        if (isUchifuzume(x, y, owner, board, capturedPieces)) continue;
      }

      const tempBoard = cloneBoard(board);
      tempBoard[y][x] = { type: pieceType, owner };
      if (!isKingInCheck(owner, tempBoard)) locations.push({ x, y });
    }
  }

  return locations;
}

function isCheckmate(
  player: Player,
  board: Board,
  capturedPieces: CapturedPieces,
): boolean {
  if (!isKingInCheck(player, board)) return false;

  // 1) Piece moves
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (!piece || piece.owner !== player) continue;
      const validMoves = calculateValidMoves(x, y, piece, board);
      if (validMoves.length > 0) return false;
    }
  }

  // 2) Drops
  const hand = capturedPieces[player];
  for (const t of CAPTURED_ORDER) {
    if (hand[t] > 0) {
      const drops = calculateDropLocations(t, player, board, capturedPieces);
      if (drops.length > 0) return false;
    }
  }

  return true;
}

function checkSennichite(state: GameState): {
  isSennichite: boolean;
  isConsecutiveCheck?: boolean;
  checkingPlayer?: Player | null;
} {
  const currentHash = getBoardHash(
    state.board,
    state.capturedPieces,
    state.currentPlayer,
  );

  let count = 0;
  let firstOccurrenceIndex = -1;
  for (let i = 0; i < state.positionHistory.length; i++) {
    if (state.positionHistory[i] === currentHash) {
      count++;
      if (firstOccurrenceIndex === -1) firstOccurrenceIndex = i;
    }
  }

  // Keep consistent with frontend implementation.
  if (count >= 3) {
    let isConsecutiveCheck = true;
    let checkingPlayer: Player | null = null;

    for (let i = firstOccurrenceIndex; i < state.positionHistory.length; i++) {
      if (state.positionHistory[i] !== currentHash) continue;

      const wasCheck = state.checkHistory[i];
      if (!wasCheck) {
        isConsecutiveCheck = false;
        break;
      }

      const checkedPlayer = state.turnHistory[i] ?? state.currentPlayer;
      const playerWhoChecked = getOpponent(checkedPlayer);

      if (checkingPlayer === null) {
        checkingPlayer = playerWhoChecked;
      } else if (checkingPlayer !== playerWhoChecked) {
        isConsecutiveCheck = false;
        break;
      }
    }

    if (isConsecutiveCheck && !state.isCheck) {
      isConsecutiveCheck = false;
    }

    return {
      isSennichite: true,
      isConsecutiveCheck,
      checkingPlayer,
    };
  }

  return { isSennichite: false };
}

function isInPromotionZone(player: Player, y: number): boolean {
  return player === SENTE ? y <= 2 : y >= 6;
}

export function applyMove(state: GameState, move: Move): ApplyResult {
  // Defensive copies (avoid mutating DB JSON objects by reference).
  const next: GameState = {
    board: cloneBoard(state.board),
    capturedPieces: cloneCapturedPieces(state.capturedPieces),
    currentPlayer: state.currentPlayer,
    moveCount: state.moveCount,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
    isCheck: state.isCheck,
    positionHistory: [...state.positionHistory],
    checkHistory: [...state.checkHistory],
    turnHistory: [...state.turnHistory],
    usiMoveHistory: [...state.usiMoveHistory],
  };

  const player = next.currentPlayer;
  let usiMove: string;
  let lastX: number;
  let lastY: number;

  if (move.type === "move") {
    assertInBounds(move.fromX, move.fromY);
    assertInBounds(move.toX, move.toY);

    const piece = next.board[move.fromY][move.fromX];
    if (!piece) throw new Error("no_piece");
    if (piece.owner !== player) throw new Error("not_your_piece");

    const legalMoves = calculateValidMoves(
      move.fromX,
      move.fromY,
      piece,
      next.board,
    );
    const ok = legalMoves.some((m) => m.x === move.toX && m.y === move.toY);
    if (!ok) throw new Error("illegal_move");

    const captured = next.board[move.toY][move.toX];
    if (captured && captured.owner === player) throw new Error("self_capture");

    const canPromote = pieceInfo[piece.type]?.canPromote ?? false;
    const mustPromote =
      ((piece.type === PAWN || piece.type === LANCE) &&
        (player === SENTE ? move.toY === 0 : move.toY === 8)) ||
      (piece.type === KNIGHT && (player === SENTE ? move.toY <= 1 : move.toY >= 7));

    const promoAllowed =
      canPromote &&
      (isInPromotionZone(player, move.fromY) || isInPromotionZone(player, move.toY));

    const promote = Boolean(move.promote);
    if (promote) {
      if (!canPromote) throw new Error("cannot_promote");
      if (!promoAllowed) throw new Error("promotion_not_allowed");
    } else {
      if (mustPromote) throw new Error("must_promote");
    }

    const movingPiece: Piece = { ...piece };
    if (promote && pieceInfo[movingPiece.type]?.promoted) {
      movingPiece.type = pieceInfo[movingPiece.type].promoted!;
    }

    next.board[move.toY][move.toX] = movingPiece;
    next.board[move.fromY][move.fromX] = null;

    if (captured) {
      const base = baseTypeOf(captured.type);
      next.capturedPieces[player][base] = (next.capturedPieces[player][base] ?? 0) + 1;
    }

    usiMove = toUsiMoveString({
      type: "move",
      fromX: move.fromX,
      fromY: move.fromY,
      toX: move.toX,
      toY: move.toY,
      promote,
    });
    lastX = move.toX;
    lastY = move.toY;
  } else {
    assertInBounds(move.toX, move.toY);
    const pieceType = move.pieceType;
    if (!CAPTURED_ORDER.includes(pieceType)) throw new Error("bad_piece_type");

    if ((next.capturedPieces[player][pieceType] ?? 0) <= 0) {
      throw new Error("no_captured_piece");
    }
    if (next.board[move.toY][move.toX] !== null) throw new Error("occupied");

    // No-square rule
    if (
      (pieceType === PAWN || pieceType === LANCE) &&
      (player === SENTE ? move.toY === 0 : move.toY === 8)
    ) {
      throw new Error("no_square");
    }
    if (pieceType === KNIGHT && (player === SENTE ? move.toY <= 1 : move.toY >= 7)) {
      throw new Error("no_square");
    }

    // Nifu + Uchifuzume
    if (pieceType === PAWN) {
      let hasPawnInColumn = false;
      for (let y = 0; y < 9; y++) {
        const p = next.board[y][move.toX];
        if (p && p.type === PAWN && p.owner === player) {
          hasPawnInColumn = true;
          break;
        }
      }
      if (hasPawnInColumn) throw new Error("nifu");
      if (isUchifuzume(move.toX, move.toY, player, next.board, next.capturedPieces)) {
        throw new Error("uchifuzume");
      }
    }

    // Simulate the drop to confirm king safety (kept consistent with frontend).
    {
      const tempBoard = cloneBoard(next.board);
      tempBoard[move.toY][move.toX] = { type: pieceType, owner: player };
      if (isKingInCheck(player, tempBoard)) throw new Error("self_check");
    }

    next.capturedPieces[player][pieceType]--;
    next.board[move.toY][move.toX] = { type: pieceType, owner: player };

    usiMove = toUsiMoveString(move);
    lastX = move.toX;
    lastY = move.toY;
  }

  next.moveCount += 1;
  next.lastMove = { x: lastX, y: lastY };
  next.currentPlayer = getOpponent(player);

  next.isCheck = isKingInCheck(next.currentPlayer, next.board);

  let gameOver = false;
  let winner: ApplyResult["winner"] = null;
  let resultReason: ApplyResult["resultReason"] = null;

  if (next.isCheck) {
    const mate = isCheckmate(next.currentPlayer, next.board, next.capturedPieces);
    if (mate) {
      gameOver = true;
      winner = player;
      resultReason = "checkmate";
    }
  }

  // Save current position (like saveCurrentState in the frontend).
  const hash = getBoardHash(next.board, next.capturedPieces, next.currentPlayer);
  next.positionHistory.push(hash);
  next.checkHistory.push(next.isCheck);
  next.turnHistory.push(next.currentPlayer);
  next.usiMoveHistory.push(usiMove);

  // Sennichite (repetition)
  if (!gameOver) {
    const s = checkSennichite(next);
    if (s.isSennichite) {
      gameOver = true;
      if (s.isConsecutiveCheck && s.checkingPlayer) {
        winner = getOpponent(s.checkingPlayer);
        resultReason = "perpetual_check";
      } else {
        winner = "draw";
        resultReason = "sennichite";
      }
    }
  }

  return { state: next, gameOver, winner, resultReason };
}

