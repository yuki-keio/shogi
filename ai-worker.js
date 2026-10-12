// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
// AI Worker for Shogi

// --- Constants ---
const SENTE = 'sente';
const GOTE = 'gote';

const KING = 'OU';
const ROOK = 'HI';
const BISHOP = 'KA';
const GOLD = 'KI';
const SILVER = 'GI';
const KNIGHT = 'KE';
const LANCE = 'KY';
const PAWN = 'FU';
const PROMOTED_ROOK = '+HI';
const PROMOTED_BISHOP = '+KA';
const PROMOTED_SILVER = '+GI';
const PROMOTED_KNIGHT = '+KE';
const PROMOTED_LANCE = '+KY';
const PROMOTED_PAWN = '+FU';

const pieceInfo = {
    [KING]: { name: '玉', canPromote: false },
    [ROOK]: { name: '飛', canPromote: true, promoted: PROMOTED_ROOK },
    [BISHOP]: { name: '角', canPromote: true, promoted: PROMOTED_BISHOP },
    [GOLD]: { name: '金', canPromote: false },
    [SILVER]: { name: '銀', canPromote: true, promoted: PROMOTED_SILVER },
    [KNIGHT]: { name: '桂', canPromote: true, promoted: PROMOTED_KNIGHT },
    [LANCE]: { name: '香', canPromote: true, promoted: PROMOTED_LANCE },
    [PAWN]: { name: '歩', canPromote: true, promoted: PROMOTED_PAWN },
    [PROMOTED_ROOK]: { name: '竜', canPromote: false, base: ROOK },
    [PROMOTED_BISHOP]: { name: '馬', canPromote: false, base: BISHOP },
    [PROMOTED_SILVER]: { name: '全', canPromote: false, base: SILVER },
    [PROMOTED_KNIGHT]: { name: '圭', canPromote: false, base: KNIGHT },
    [PROMOTED_LANCE]: { name: '杏', canPromote: false, base: LANCE },
    [PROMOTED_PAWN]: { name: 'と', canPromote: false, base: PAWN }
};

const PIECE_MOVEMENTS = {
    [SENTE]: {
        [PAWN]: [{ dx: 0, dy: -1, range: 1 }],
        [LANCE]: [{ dx: 0, dy: -1, range: 8 }],
        [KNIGHT]: [{ dx: -1, dy: -2, range: 1 }, { dx: 1, dy: -2, range: 1 }],
        [SILVER]: [
            { dx: 0, dy: -1, range: 1 }, { dx: -1, dy: -1, range: 1 }, { dx: 1, dy: -1, range: 1 },
            { dx: -1, dy: 1, range: 1 }, { dx: 1, dy: 1, range: 1 }
        ],
        [GOLD]: [
            { dx: 0, dy: -1, range: 1 }, { dx: -1, dy: -1, range: 1 }, { dx: 1, dy: -1, range: 1 },
            { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: 1, range: 1 }
        ],
        [BISHOP]: [
            { dx: 1, dy: 1, range: 8 }, { dx: 1, dy: -1, range: 8 },
            { dx: -1, dy: 1, range: 8 }, { dx: -1, dy: -1, range: 8 }
        ],
        [ROOK]: [
            { dx: 1, dy: 0, range: 8 }, { dx: -1, dy: 0, range: 8 },
            { dx: 0, dy: 1, range: 8 }, { dx: 0, dy: -1, range: 8 }
        ],
        [KING]: [
            { dx: 0, dy: -1, range: 1 }, { dx: -1, dy: -1, range: 1 }, { dx: 1, dy: -1, range: 1 },
            { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: 1, range: 1 },
            { dx: -1, dy: 1, range: 1 }, { dx: 1, dy: 1, range: 1 }
        ]
    },
    [GOTE]: {
        [PAWN]: [{ dx: 0, dy: 1, range: 1 }],
        [LANCE]: [{ dx: 0, dy: 1, range: 8 }],
        [KNIGHT]: [{ dx: -1, dy: 2, range: 1 }, { dx: 1, dy: 2, range: 1 }],
        [SILVER]: [
            { dx: 0, dy: 1, range: 1 }, { dx: -1, dy: 1, range: 1 }, { dx: 1, dy: 1, range: 1 },
            { dx: -1, dy: -1, range: 1 }, { dx: 1, dy: -1, range: 1 }
        ],
        [GOLD]: [
            { dx: 0, dy: 1, range: 1 }, { dx: -1, dy: 1, range: 1 }, { dx: 1, dy: 1, range: 1 },
            { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: -1, range: 1 }
        ],
        [BISHOP]: [
            { dx: 1, dy: 1, range: 8 }, { dx: 1, dy: -1, range: 8 },
            { dx: -1, dy: 1, range: 8 }, { dx: -1, dy: -1, range: 8 }
        ],
        [ROOK]: [
            { dx: 1, dy: 0, range: 8 }, { dx: -1, dy: 0, range: 8 },
            { dx: 0, dy: 1, range: 8 }, { dx: 0, dy: -1, range: 8 }
        ],
        [KING]: [
            { dx: 0, dy: 1, range: 1 }, { dx: -1, dy: 1, range: 1 }, { dx: 1, dy: 1, range: 1 },
            { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: -1, range: 1 },
            { dx: -1, dy: -1, range: 1 }, { dx: 1, dy: -1, range: 1 }
        ]
    }
};

// 成り駒の動きを追加
[SENTE, GOTE].forEach(owner => {
    const goldMoves = PIECE_MOVEMENTS[owner][GOLD];
    PIECE_MOVEMENTS[owner][PROMOTED_PAWN] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_LANCE] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_KNIGHT] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_SILVER] = goldMoves;

    PIECE_MOVEMENTS[owner][PROMOTED_BISHOP] = [
        ...PIECE_MOVEMENTS[owner][BISHOP],
        { dx: 1, dy: 0, range: 1 }, { dx: -1, dy: 0, range: 1 },
        { dx: 0, dy: 1, range: 1 }, { dx: 0, dy: -1, range: 1 }
    ];

    PIECE_MOVEMENTS[owner][PROMOTED_ROOK] = [
        ...PIECE_MOVEMENTS[owner][ROOK],
        { dx: 1, dy: 1, range: 1 }, { dx: 1, dy: -1, range: 1 },
        { dx: -1, dy: 1, range: 1 }, { dx: -1, dy: -1, range: 1 }
    ];
});

const PIECE_VALUES = {
    [KING]: 10000,
    [ROOK]: 900,
    [BISHOP]: 800,
    [GOLD]: 600,
    [SILVER]: 500,
    [KNIGHT]: 400,
    [LANCE]: 400,
    [PAWN]: 100,
    [PROMOTED_ROOK]: 1100,
    [PROMOTED_BISHOP]: 1000,
    [PROMOTED_SILVER]: 650,
    [PROMOTED_KNIGHT]: 650,
    [PROMOTED_LANCE]: 650,
    [PROMOTED_PAWN]: 650
};

const POSITION_BONUS = {
    [PAWN]: [
        [-5, -5, -5, -5, -5, -5, -5, -5, -5],
        [3, 3, 3, 3, 3, 3, 3, 3, 3],
        [4, 4, 4, 4, 4, 4, 4, 4, 4],
        [3, 3, 3, 3, 3, 3, 3, 3, 3],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [-1, -1, -1, -1, -1, -1, -1, -1, -1],
        [-1, -1, -1, -1, -1, -1, -1, -1, -1],
        [-2, -2, -2, -2, -2, -2, -2, -2, -2],
        [-3, -3, -3, -3, -3, -3, -3, -3, -3]
    ],
    [LANCE]: [
        [-3, -3, -3, -3, -3, -3, -3, -3, -3],
        [-1, -1, -1, -1, -1, -1, -1, -1, -1],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1],
        [2, 2, 2, 2, 2, 2, 2, 2, 2],
        [2, 2, 2, 2, 2, 2, 2, 2, 2],
        [3, 3, 3, 3, 3, 3, 3, 3, 3],
        [4, 4, 4, 4, 4, 4, 4, 4, 4]
    ],
    [KNIGHT]: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [10, 10, 10, 10, 10, 10, 10, 10, 10],
        [5, 6, 6, 6, 6, 6, 6, 6, 5],
        [3, 4, 4, 4, 4, 4, 4, 4, 3],
        [0, 3, 3, 3, 3, 3, 3, 3, 0],
        [-3, 0, 0, 0, 0, 0, 0, 0, -3],
        [-5, -4, -4, -4, -4, -4, -4, -4, -5],
        [-7, -5, -5, -5, -5, -5, -5, -5, -7],
    ],
    [SILVER]: [
        [9, 9, 9, 9, 9, 9, 9, 9, 9],
        [9, 11, 11, 11, 11, 11, 11, 11, 9],
        [9, 11, 11, 11, 11, 11, 11, 11, 9],
        [4, 7, 7, 7, 7, 7, 7, 7, 4],
        [0, 4, 4, 4, 4, 4, 4, 4, 0],
        [-4, 0, 4, 4, 4, 4, 4, 0, -4],
        [-4, 0, 0, 0, 0, 0, 0, 0, -4],
        [-4, 0, 0, 0, 0, 0, 0, 0, -4],
        [-7, -4, -4, -4, -4, -4, -4, -4, -7]
    ],
    [GOLD]: [
        [7, 11, 11, 11, 11, 11, 11, 11, 7],
        [9, 11, 11, 11, 11, 11, 11, 11, 9],
        [7, 7, 7, 7, 7, 7, 7, 7, 7],
        [4, 4, 4, 4, 4, 4, 4, 4, 4],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [2, 4, 4, 4, 4, 4, 4, 4, 2],
        [4, 7, 7, 7, 7, 7, 7, 7, 4],
        [0, 4, 4, 4, 7, 4, 4, 4, 0]
    ],
    [BISHOP]: [
        [1, 4, 4, 4, 4, 4, 4, 4, 1],
        [7, 11, 11, 11, 11, 11, 11, 11, 7],
        [7, 11, 11, 11, 11, 11, 11, 11, 7],
        [4, 7, 7, 7, 7, 7, 7, 7, 4],
        [0, 4, 4, 4, 4, 4, 4, 4, 0],
        [-4, 0, 4, 4, 4, 4, 4, 0, -4],
        [-7, -4, 0, 0, 0, 0, 0, -4, -7],
        [-7, -7, -4, -4, -4, -4, -4, -7, -7],
        [-11, -11, -7, -7, -7, -7, -7, -11, -11]
    ],
    [ROOK]: [
        [4, 6, 6, 6, 6, 6, 6, 6, 4],
        [5, 6, 6, 6, 6, 6, 6, 6, 5],
        [4, 5, 5, 5, 5, 5, 5, 5, 4],
        [1, 2, 2, 2, 2, 2, 2, 2, 1],
        [0, 1, 1, 1, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        [-2, -2, -2, -2, -2, -2, -2, -2, -2],
        [-2, -1, -1, -1, -1, -1, -1, -1, -2],
        [-4, -3, -3, -3, -3, -3, -3, -3, -4]
    ],
    [KING]: [
        [14, 14, 14, 14, 14, 14, 14, 14, 14],
        [4, 4, 4, 4, 4, 4, 4, 4, 4],
        [-2, -2, -2, -2, -2, -2, -2, -2, -2],
        [-4, -5, -5, -5, -5, -5, -5, -5, -4],
        [-8, -7, -7, -7, -7, -7, -7, -7, -8],
        [2, 4, 4, 4, 4, 4, 4, 4, 2],
        [2, 4, 4, 4, 4, 4, 4, 4, 2],
        [8, 11, 9, 8, 9, 8, 8, 10, 6],
        [9, 8, 7, 6, 5, 6, 7, 7, 8]
    ],
    [PROMOTED_PAWN]: null,
    [PROMOTED_LANCE]: null,
    [PROMOTED_KNIGHT]: null,
    [PROMOTED_SILVER]: null,
    [PROMOTED_ROOK]: null,
    [PROMOTED_BISHOP]: null
};

// --- State ---
let board = [];
let capturedPieces = { [SENTE]: {}, [GOTE]: {} };
let currentPlayer = SENTE;
let moveCount = 0;
let kingPosCache = { [SENTE]: null, [GOTE]: null };

// --- Game Logic Functions ---

function getOpponent(player) {
    return player === SENTE ? GOTE : SENTE;
}

function getPieceMovements(type, owner) {
    return PIECE_MOVEMENTS[owner]?.[type] || [];
}

function calculatePseudoMoves(x, y, piece, boardState = board) {
    const moves = [];
    const owner = piece.owner;
    const opponent = owner === SENTE ? GOTE : SENTE;
    const directions = getPieceMovements(piece.type, owner);

    for (const dir of directions) {
        let currentX = x;
        let currentY = y;
        for (let i = 0; i < dir.range; i++) {
            currentX += dir.dx;
            currentY += dir.dy;
            if (currentX < 0 || currentX >= 9 || currentY < 0 || currentY >= 9) break;
            const targetPiece = boardState[currentY][currentX];
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

function recomputeKingPosCache() {
    kingPosCache[SENTE] = null;
    kingPosCache[GOTE] = null;
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.type === KING) {
                kingPosCache[piece.owner] = { x, y };
            }
        }
    }
}

function findKing(player, currentBoard = board) {
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y][x];
            if (piece && piece.type === KING && piece.owner === player) {
                return { x, y };
            }
        }
    }
    return null;
}

function getKingPosCached(player, currentBoard = board) {
    if (currentBoard === board) {
        const cached = kingPosCache[player];
        if (cached) return cached;
        const pos = findKing(player, currentBoard);
        kingPosCache[player] = pos;
        return pos;
    }
    return findKing(player, currentBoard);
}

// maxRange … 何マス先までの利きを見るか。入門・初級は NEAR_RANGE しか見ないので、
// 遠くから狙われていることに気づかない（人らしい間違いをそのまま表す）
function isSquareAttackedBy(attacker, targetX, targetY, currentBoard = board, maxRange = 9) {
    const knightOriginY = attacker === SENTE ? targetY + 2 : targetY - 2;
    if (knightOriginY >= 0 && knightOriginY < 9) {
        const leftX = targetX - 1;
        const rightX = targetX + 1;
        if (leftX >= 0) {
            const p = currentBoard[knightOriginY][leftX];
            if (p && p.owner === attacker && p.type === KNIGHT) return true;
        }
        if (rightX < 9) {
            const p = currentBoard[knightOriginY][rightX];
            if (p && p.owner === attacker && p.type === KNIGHT) return true;
        }
    }

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const x = targetX + dx;
            const y = targetY + dy;
            if (x < 0 || x >= 9 || y < 0 || y >= 9) continue;
            const piece = currentBoard[y][x];
            if (!piece || piece.owner !== attacker) continue;
            const moves = getPieceMovements(piece.type, piece.owner);
            const wantDx = targetX - x;
            const wantDy = targetY - y;
            for (const m of moves) {
                if (m.range === 1 && m.dx === wantDx && m.dy === wantDy) return true;
            }
        }
    }

    for (let x = targetX + 1; x < 9 && x - targetX <= maxRange; x++) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    for (let x = targetX - 1; x >= 0 && targetX - x <= maxRange; x--) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    for (let y = targetY + 1; y < 9 && y - targetY <= maxRange; y++) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === SENTE && p.type === LANCE) return true;
        }
        break;
    }
    for (let y = targetY - 1; y >= 0 && targetY - y <= maxRange; y--) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === GOTE && p.type === LANCE) return true;
        }
        break;
    }

    for (let x = targetX + 1, y = targetY + 1; x < 9 && y < 9 && x - targetX <= maxRange; x++, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX - 1, y = targetY + 1; x >= 0 && y < 9 && targetX - x <= maxRange; x--, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX + 1, y = targetY - 1; x < 9 && y >= 0 && x - targetX <= maxRange; x++, y--) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX - 1, y = targetY - 1; x >= 0 && y >= 0 && targetX - x <= maxRange; x--, y--) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    return false;
}

function isKingInCheck(player, currentBoard = board) {
    const kingPos = getKingPosCached(player, currentBoard);
    if (!kingPos) return false;
    const attacker = player === SENTE ? GOTE : SENTE;
    return isSquareAttackedBy(attacker, kingPos.x, kingPos.y, currentBoard);
}

function cloneBoard(boardToClone) {
    return boardToClone.map(row => row.map(piece => piece ? { ...piece } : null));
}

// 盤上の駒を動かして王手を外せるか（持ち駒は見ない）
function canEscapeByMove(player) {
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const pseudoMoves = calculatePseudoMoves(x, y, piece);
                for (const move of pseudoMoves) {
                    const tempBoard = cloneBoard(board);
                    tempBoard[move.y][move.x] = tempBoard[y][x];
                    tempBoard[y][x] = null;
                    if (!isKingInCheck(player, tempBoard)) return true;
                }
            }
        }
    }
    return false;
}

function isCheckmate(player) {
    if (!isKingInCheck(player)) return false;
    if (canEscapeByMove(player)) return false;
    const playerCaptured = capturedPieces[player];
    for (const pieceType in playerCaptured) {
        if (playerCaptured[pieceType] > 0) {
            for (let y = 0; y < 9; y++) {
                for (let x = 0; x < 9; x++) {
                    if (board[y][x] === null) {
                        if ((pieceType === PAWN || pieceType === LANCE) && (player === SENTE ? y === 0 : y === 8)) continue;
                        if (pieceType === KNIGHT && (player === SENTE ? y <= 1 : y >= 7)) continue;
                        if (pieceType === PAWN) {
                            let hasPawn = false;
                            for (let cy = 0; cy < 9; cy++) {
                                if (board[cy][x] && board[cy][x].type === PAWN && board[cy][x].owner === player) {
                                    hasPawn = true; break;
                                }
                            }
                            if (hasPawn) continue;
                            if (isUchifuzume(x, y, player)) continue;
                        }
                        const tempBoard = cloneBoard(board);
                        tempBoard[y][x] = { type: pieceType, owner: player };
                        if (!isKingInCheck(player, tempBoard)) return false;
                    }
                }
            }
        }
    }
    return true;
}

function isUchifuzume(toX, toY, player) {
    const tempBoard = cloneBoard(board);
    tempBoard[toY][toX] = { type: PAWN, owner: player };
    const opponent = getOpponent(player);
    if (!isKingInCheck(opponent, tempBoard)) return false;
    // 🔴 isCheckmate を呼ばないこと。歩の王手は玉の目の前からなので持ち駒を打って防ぐ手は無く、
    // 盤上の駒で逃げられるかだけ見れば足りる。isCheckmate だと持ち駒の打ち場所ごとにまた打ち歩詰めを
    // 調べ、双方が歩を持つ終盤の形で計算が爆発する（1手に20秒超。AIが指さなくなる）
    const originalBoard = board;
    board = tempBoard;
    recomputeKingPosCache();
    const isOpponentCheckmated = !canEscapeByMove(opponent);
    board = originalBoard;
    recomputeKingPosCache();
    return isOpponentCheckmated;
}

// --- AI Logic Functions ---

function getPositionBonus(pieceType, x, y, owner) {
    let table = POSITION_BONUS[pieceType];
    if (!table) {
        if (pieceType === PROMOTED_PAWN || pieceType === PROMOTED_LANCE ||
            pieceType === PROMOTED_KNIGHT || pieceType === PROMOTED_SILVER) {
            table = POSITION_BONUS[GOLD];
        } else if (pieceType === PROMOTED_ROOK) {
            table = POSITION_BONUS[ROOK];
        } else if (pieceType === PROMOTED_BISHOP) {
            table = POSITION_BONUS[BISHOP];
        }
    }
    if (!table) return 0;
    const evalY = owner === SENTE ? y : 8 - y;
    return table[evalY][x];
}

const HAND_VALUE_MULTIPLIER = 1.11;
const incrementalEval = { enabled: false, aiPlayer: null, score: 0 };

function getEvalSign(owner, aiPlayer) { return owner === aiPlayer ? 1 : -1; }

function getBoardPieceEval(type, x, y, owner, aiPlayer) {
    const value = PIECE_VALUES[type] || 0;
    const positionBonus = getPositionBonus(type, x, y, owner);
    return getEvalSign(owner, aiPlayer) * (value + positionBonus);
}

function getHandPieceEval(pieceType, owner, aiPlayer) {
    const value = PIECE_VALUES[pieceType] || 0;
    return getEvalSign(owner, aiPlayer) * value * HAND_VALUE_MULTIPLIER;
}

function computeStaticEval(aiPlayer) {
    let score = 0;
    const opponent = getOpponent(aiPlayer);
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (!piece) continue;
            score += getBoardPieceEval(piece.type, x, y, piece.owner, aiPlayer);
        }
    }
    for (const pieceType in capturedPieces[aiPlayer]) {
        score += capturedPieces[aiPlayer][pieceType] * (PIECE_VALUES[pieceType] || 0) * HAND_VALUE_MULTIPLIER;
    }
    for (const pieceType in capturedPieces[opponent]) {
        score -= capturedPieces[opponent][pieceType] * (PIECE_VALUES[pieceType] || 0) * HAND_VALUE_MULTIPLIER;
    }
    return score;
}

function startIncrementalEval(aiPlayer) {
    incrementalEval.enabled = true;
    incrementalEval.aiPlayer = aiPlayer;
    incrementalEval.score = computeStaticEval(aiPlayer);
}

function stopIncrementalEval() {
    incrementalEval.enabled = false;
    incrementalEval.aiPlayer = null;
    incrementalEval.score = 0;
}

function applyMoveFast(move, player) {
    const undo = { move, player };
    if (move.type === 'move') {
        const piece = board[move.fromY][move.fromX];
        const target = board[move.toY][move.toX];
        undo.originalPiece = piece;
        undo.captured = target;
        if (incrementalEval.enabled && incrementalEval.aiPlayer && piece) {
            const aiPlayer = incrementalEval.aiPlayer;
            let delta = 0;
            delta -= getBoardPieceEval(piece.type, move.fromX, move.fromY, piece.owner, aiPlayer);
            const promotedForEval = move.promote && pieceInfo[piece.type]?.canPromote;
            const newTypeForEval = promotedForEval ? pieceInfo[piece.type].promoted : piece.type;
            delta += getBoardPieceEval(newTypeForEval, move.toX, move.toY, piece.owner, aiPlayer);
            if (target) {
                delta -= getBoardPieceEval(target.type, move.toX, move.toY, target.owner, aiPlayer);
                let capturedBaseType = target.type;
                if (pieceInfo[capturedBaseType]?.base) capturedBaseType = pieceInfo[capturedBaseType].base;
                if (capturedBaseType !== KING) delta += getHandPieceEval(capturedBaseType, player, aiPlayer);
            }
            undo.evalDelta = delta;
        }
        if (target) {
            let capturedType = target.type;
            if (pieceInfo[capturedType]?.base) capturedType = pieceInfo[capturedType].base;
            // 🔴 玉は持ち駒に入れない。読みの途中では玉を取る手が出ることがあり、
            // 手駒に無いキー（OU）を増やすと `undefined + 1` で NaN になり、
            // 評価値が丸ごと NaN に化けて「点数を一切見ない手」が選ばれる。
            // 玉の点数は盤上の評価（PIECE_VALUES[KING]）が持っているので、足さなくても勝ちは分かる
            if (capturedType !== KING) {
                capturedPieces[player][capturedType]++;
                undo.capturedType = capturedType;
            }
        }
        const promoted = move.promote && pieceInfo[piece.type]?.canPromote;
        const placedPiece = promoted ? { type: pieceInfo[piece.type].promoted, owner: piece.owner } : piece;
        undo.promoted = promoted;
        board[move.fromY][move.fromX] = null;
        board[move.toY][move.toX] = placedPiece;
        if (piece && piece.type === KING) {
            undo.kingPosFrom = kingPosCache[player] ? { ...kingPosCache[player] } : null;
            kingPosCache[player] = { x: move.toX, y: move.toY };
        }
    } else if (move.type === 'drop') {
        if (incrementalEval.enabled && incrementalEval.aiPlayer) {
            const aiPlayer = incrementalEval.aiPlayer;
            const delta = getBoardPieceEval(move.pieceType, move.toX, move.toY, player, aiPlayer) - getHandPieceEval(move.pieceType, player, aiPlayer);
            undo.evalDelta = delta;
        }
        undo.capturedCountBefore = capturedPieces[player][move.pieceType];
        capturedPieces[player][move.pieceType]--;
        board[move.toY][move.toX] = { type: move.pieceType, owner: player };
    }
    if (incrementalEval.enabled && incrementalEval.aiPlayer && typeof undo.evalDelta === 'number') {
        incrementalEval.score += undo.evalDelta;
    }
    return undo;
}

function undoMoveFast(undo) {
    const { move, player } = undo;
    if (move.type === 'move') {
        board[move.fromY][move.fromX] = undo.originalPiece;
        board[move.toY][move.toX] = undo.captured || null;
        if (undo.capturedType) capturedPieces[player][undo.capturedType]--;
        if (undo.originalPiece && undo.originalPiece.type === KING) {
            if (undo.kingPosFrom) kingPosCache[player] = { ...undo.kingPosFrom };
            else kingPosCache[player] = { x: move.fromX, y: move.fromY };
        }
    } else if (move.type === 'drop') {
        board[move.toY][move.toX] = null;
        capturedPieces[player][move.pieceType] = undo.capturedCountBefore;
    }
    if (incrementalEval.enabled && incrementalEval.aiPlayer && typeof undo.evalDelta === 'number') {
        incrementalEval.score -= undo.evalDelta;
    }
}

function isMoveLegalForPlayer(move, player) {
    const undo = applyMoveFast(move, player);
    const inCheck = isKingInCheck(player);
    undoMoveFast(undo);
    return !inCheck;
}

function calculateDropLocationsFast(pieceType, owner) {
    const locations = [];
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            if (board[y][x] !== null) continue;
            if ((pieceType === PAWN || pieceType === LANCE) && (owner === SENTE ? y === 0 : y === 8)) continue;
            if (pieceType === KNIGHT && (owner === SENTE ? y <= 1 : y >= 7)) continue;
            if (pieceType === PAWN) {
                let hasPawn = false;
                for (let cy = 0; cy < 9; cy++) {
                    if (board[cy][x] && board[cy][x].type === PAWN && board[cy][x].owner === owner) {
                        hasPawn = true; break;
                    }
                }
                if (hasPawn) continue;
                if (isUchifuzume(x, y, owner)) continue;
            }
            const undo = applyMoveFast({ type: 'drop', pieceType: pieceType, toX: x, toY: y }, owner);
            const kingInCheck = isKingInCheck(owner);
            undoMoveFast(undo);
            if (!kingInCheck) locations.push({ x, y });
        }
    }
    return locations;
}

function getAllLegalMovesFast(player) {
    const moves = [];
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const candidateMoves = calculatePseudoMoves(x, y, piece);
                for (const move of candidateMoves) {
                    const canPromote = pieceInfo[piece.type]?.canPromote;
                    const isEnteringPromotionZone = (player === SENTE && move.y <= 2) || (player === GOTE && move.y >= 6);
                    const wasInPromotionZone = (player === SENTE && y <= 2) || (player === GOTE && y >= 6);
                    const mustPromote = (piece.type === PAWN || piece.type === LANCE) && (player === SENTE ? move.y === 0 : move.y === 8) || (piece.type === KNIGHT) && (player === SENTE ? move.y <= 1 : move.y >= 7);
                    const baseMove = { type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: false };
                    if (canPromote && (isEnteringPromotionZone || wasInPromotionZone)) {
                        if (mustPromote) {
                            const pm = { ...baseMove, promote: true };
                            if (isMoveLegalForPlayer(pm, player)) moves.push(pm);
                        } else {
                            const pm = { ...baseMove, promote: true };
                            if (isMoveLegalForPlayer(pm, player)) moves.push(pm);
                            if (isMoveLegalForPlayer(baseMove, player)) moves.push(baseMove);
                        }
                    } else {
                        if (isMoveLegalForPlayer(baseMove, player)) moves.push(baseMove);
                    }
                }
            }
        }
    }
    const playerCaptured = capturedPieces[player];
    for (const pieceType in playerCaptured) {
        if (playerCaptured[pieceType] > 0) {
            const dropLocations = calculateDropLocationsFast(pieceType, player);
            for (const loc of dropLocations) {
                moves.push({ type: 'drop', pieceType: pieceType, toX: loc.x, toY: loc.y });
            }
        }
    }
    return moves;
}

// 作戦の手の確かめ（checkPlanSeparately）のあいだだけ、別の表に差し替える
let transpositionTable = new Map();
const MAX_TT_SIZE = 100000;

// --- Zobrist Hashing Implementation ---
// Pre-computed random values for Zobrist hashing
// Uses 32-bit integers for XOR operations (JavaScript bitwise ops are 32-bit)

const PIECE_TYPES_FOR_ZOBRIST = [
    KING, ROOK, BISHOP, GOLD, SILVER, KNIGHT, LANCE, PAWN,
    PROMOTED_ROOK, PROMOTED_BISHOP, PROMOTED_SILVER, PROMOTED_KNIGHT,
    PROMOTED_LANCE, PROMOTED_PAWN
];

const PIECE_TYPE_TO_INDEX = {};
PIECE_TYPES_FOR_ZOBRIST.forEach((type, idx) => {
    PIECE_TYPE_TO_INDEX[type] = idx;
});

// Seeded random number generator for reproducible Zobrist keys
function mulberry32(seed) {
    return function () {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0);
    };
}

const zobristRng = mulberry32(0xDEADBEEF);

// zobristTable[pieceTypeIndex][ownerIndex][y][x] - random value for each piece at each position
// pieceTypeIndex: 0-13 (14 piece types)
// ownerIndex: 0=SENTE, 1=GOTE
// y: 0-8, x: 0-8
const zobristTable = [];
for (let pieceIdx = 0; pieceIdx < 14; pieceIdx++) {
    zobristTable[pieceIdx] = [];
    for (let ownerIdx = 0; ownerIdx < 2; ownerIdx++) {
        zobristTable[pieceIdx][ownerIdx] = [];
        for (let y = 0; y < 9; y++) {
            zobristTable[pieceIdx][ownerIdx][y] = [];
            for (let x = 0; x < 9; x++) {
                zobristTable[pieceIdx][ownerIdx][y][x] = zobristRng();
            }
        }
    }
}

// zobristHand[ownerIndex][pieceTypeIndex][count] - random value for captured pieces
// count: 0-18 (max possible is 18 pawns, but realistically much less)
const HAND_PIECE_TYPES = [ROOK, BISHOP, GOLD, SILVER, KNIGHT, LANCE, PAWN];
const HAND_PIECE_TO_INDEX = {};
HAND_PIECE_TYPES.forEach((type, idx) => {
    HAND_PIECE_TO_INDEX[type] = idx;
});

const zobristHand = [];
for (let ownerIdx = 0; ownerIdx < 2; ownerIdx++) {
    zobristHand[ownerIdx] = [];
    for (let pieceIdx = 0; pieceIdx < 7; pieceIdx++) {
        zobristHand[ownerIdx][pieceIdx] = [];
        for (let count = 0; count <= 18; count++) {
            zobristHand[ownerIdx][pieceIdx][count] = zobristRng();
        }
    }
}

// Random value for current player (XOR when it's GOTE's turn)
const zobristPlayerTurn = zobristRng();

function computeZobristHash(currentBoard, captured, player) {
    let hash = 0;

    // Hash board pieces
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y][x];
            if (piece) {
                const pieceIdx = PIECE_TYPE_TO_INDEX[piece.type];
                const ownerIdx = piece.owner === SENTE ? 0 : 1;
                if (pieceIdx !== undefined) {
                    hash ^= zobristTable[pieceIdx][ownerIdx][y][x];
                }
            }
        }
    }

    // Hash captured pieces (hand)
    for (let ownerIdx = 0; ownerIdx < 2; ownerIdx++) {
        const owner = ownerIdx === 0 ? SENTE : GOTE;
        for (let pieceIdx = 0; pieceIdx < HAND_PIECE_TYPES.length; pieceIdx++) {
            const pieceType = HAND_PIECE_TYPES[pieceIdx];
            const count = captured[owner][pieceType] || 0;
            if (count > 0) {
                hash ^= zobristHand[ownerIdx][pieceIdx][Math.min(count, 18)];
            }
        }
    }

    // Hash current player
    if (player === GOTE) {
        hash ^= zobristPlayerTurn;
    }

    return hash;
}

// experimentParam: 0 = old/baseline, 1 = new/experimental
let currentExperimentParam = 0;

let searchStartTime = 0;
let searchTimeLimit = 0;
let searchAborted = false;
// Nodes visited in the current search. The time limit is checked every 1024 nodes.
// Do NOT key this check on `ply`: ply only ever reaches maxDepth (<= 6), so a check
// like `(ply & 127) === 0` never fires and the time limit is silently ignored.
let searchNodes = 0;
let killerMoves = [];
let historyHeuristic = {};
let previousBestMove = null;

function isSameMove(m1, m2) {
    if (!m1 || !m2) return false;
    if (m1.type !== m2.type) return false;
    if (m1.type === 'move') return m1.fromX === m2.fromX && m1.fromY === m2.fromY && m1.toX === m2.toX && m1.toY === m2.toY && m1.promote === m2.promote;
    return m1.pieceType === m2.pieceType && m1.toX === m2.toX && m1.toY === m2.toY;
}

function getMoveKey(move) {
    if (move.type === 'move') return `m${move.fromX}${move.fromY}${move.toX}${move.toY}${move.promote ? 1 : 0}`;
    return `d${move.pieceType}${move.toX}${move.toY}`;
}

function orderMoves(moves, player, depth, pvMove) {
    const scoredMoves = [];
    for (const move of moves) {
        let score = 0;
        if (pvMove && isSameMove(move, pvMove)) score = 1000000;
        else if (move.type === 'move') {
            const target = board[move.toY][move.toX];
            if (target) {
                const victimValue = PIECE_VALUES[target.type] || 0;
                const aggressorValue = PIECE_VALUES[board[move.fromY][move.fromX]?.type] || 0;
                score = 10000 + victimValue * 10 - aggressorValue;
            }
            if (move.promote) score += 500;
            if (depth < killerMoves.length && killerMoves[depth]) {
                for (const killer of killerMoves[depth]) if (killer && isSameMove(move, killer)) { score += 900; break; }
            }
            const histKey = getMoveKey(move);
            if (historyHeuristic[histKey]) score += Math.min(historyHeuristic[histKey], 800);
        } else score += 50;
        scoredMoves.push({ move, score });
    }
    scoredMoves.sort((a, b) => b.score - a.score);
    return scoredMoves.map(sm => sm.move);
}

/**
 * Evaluate king safety for the given player.
 * Returns a positive score if the player's king is safe, negative if unsafe.
 * Considers:
 * - Number of attacker pieces around the king
 * - Number of friendly pieces defending the king
 * - Open lines (files, ranks, diagonals) toward the king
 */
function evaluateKingSafety(player) {
    const kingPos = getKingPosCached(player);
    if (!kingPos) return 0;

    const opponent = getOpponent(player);
    let safetyScore = 0;

    // Check squares around the king
    const nearbySquares = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = kingPos.x + dx;
            const ny = kingPos.y + dy;
            if (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
                nearbySquares.push({ x: nx, y: ny });
            }
        }
    }


    // Count attacked squares around king (penalty for each attacked square)
    let attackedSquares = 0;
    for (const sq of nearbySquares) {
        if (isSquareAttackedBy(opponent, sq.x, sq.y)) {
            attackedSquares++;
        }
    }
    safetyScore -= attackedSquares * 30;

    // Count friendly defenders around king (bonus for each defender)
    let defenders = 0;
    for (const sq of nearbySquares) {
        const piece = board[sq.y][sq.x];
        if (piece && piece.owner === player && piece.type !== KING) {
            defenders++;
            // Gold and silver are excellent defenders
            if (piece.type === GOLD || piece.type === SILVER ||
                piece.type === PROMOTED_SILVER || piece.type === PROMOTED_PAWN ||
                piece.type === PROMOTED_LANCE || piece.type === PROMOTED_KNIGHT) {
                safetyScore += 20;
            } else {
                safetyScore += 10;
            }
        }
    }

    // Penalty for open lines toward the king (rook/lance attacks)
    // Check vertical line (up and down from king)
    let openUp = 0, openDown = 0;
    for (let y = kingPos.y - 1; y >= 0; y--) {
        const piece = board[y][kingPos.x];
        if (piece) {
            if (piece.owner === opponent && (piece.type === ROOK || piece.type === PROMOTED_ROOK ||
                (piece.type === LANCE && opponent === GOTE))) {
                safetyScore -= 50;
            }
            break;
        }
        openUp++;
    }
    for (let y = kingPos.y + 1; y < 9; y++) {
        const piece = board[y][kingPos.x];
        if (piece) {
            if (piece.owner === opponent && (piece.type === ROOK || piece.type === PROMOTED_ROOK ||
                (piece.type === LANCE && opponent === SENTE))) {
                safetyScore -= 50;
            }
            break;
        }
        openDown++;
    }

    // Check horizontal line (left and right from king)
    let openLeft = 0, openRight = 0;
    for (let x = kingPos.x - 1; x >= 0; x--) {
        const piece = board[kingPos.y][x];
        if (piece) {
            if (piece.owner === opponent && (piece.type === ROOK || piece.type === PROMOTED_ROOK)) {
                safetyScore -= 50;
            }
            break;
        }
        openLeft++;
    }
    for (let x = kingPos.x + 1; x < 9; x++) {
        const piece = board[kingPos.y][x];
        if (piece) {
            if (piece.owner === opponent && (piece.type === ROOK || piece.type === PROMOTED_ROOK)) {
                safetyScore -= 50;
            }
            break;
        }
        openRight++;
    }

    // Penalty for open diagonals (bishop attacks)
    const diagonals = [
        { dx: 1, dy: 1 }, { dx: 1, dy: -1 },
        { dx: -1, dy: 1 }, { dx: -1, dy: -1 }
    ];
    for (const { dx, dy } of diagonals) {
        let x = kingPos.x + dx;
        let y = kingPos.y + dy;
        while (x >= 0 && x < 9 && y >= 0 && y < 9) {
            const piece = board[y][x];
            if (piece) {
                if (piece.owner === opponent && (piece.type === BISHOP || piece.type === PROMOTED_BISHOP)) {
                    safetyScore -= 50;
                }
                break;
            }
            x += dx;
            y += dy;
        }
    }


    return safetyScore;
}

function minmaxEvaluate(aiPlayer) {
    const opponent = getOpponent(aiPlayer);
    const scoreBase = (incrementalEval.enabled && incrementalEval.aiPlayer === aiPlayer) ? incrementalEval.score : computeStaticEval(aiPlayer);
    let score = scoreBase;
    if (isKingInCheck(opponent)) score += 500;
    if (isKingInCheck(aiPlayer)) score -= 500;
    score += (evaluateKingSafety(aiPlayer) - evaluateKingSafety(opponent)) * kingWeight;
    return score;
}

// 駒の取り合いを何手先まで数えるか。人は長い取り合いを数え切れないので、
// 入門・初級・中級はここを 0（＝取り合いを数えない）にして弱さを作っている
const DEFAULT_EXCHANGE_DEPTH = 4;
let exchangeDepth = DEFAULT_EXCHANGE_DEPTH;

// 入門・初級が「ただ取られるか」を確かめるとき、何マス先の利きまで見るか。
// ここを超えた先から利いている飛角香は見えていないことにする
const NEAR_RANGE = 2;
let farCapture = 0, kingWeight = 1, safeMove = 0, safeDrop = 0, dropBlind = 0;

/**
 * 指した先が「近くから」ただで取られる形になるか。
 * 遠くから利いている駒は見えていないことにする（NEAR_RANGE マスまでしか見ない）。
 */
function hangsNear(move, aiPlayer, opponent) {
    const undo = applyMoveFast(move, aiPlayer);
    const bad = isSquareAttackedBy(opponent, move.toX, move.toY, board, NEAR_RANGE)
        && !isSquareAttackedBy(aiPlayer, move.toX, move.toY, board, NEAR_RANGE);
    undoMoveFast(undo);
    return bad;
}

/**
 * 読みに入る前に候補手をふるいにかける。入門・初級だけ効く。
 * 🔴 全部落ちてしまったら元の一覧を返すこと（手が無いと対局が止まる）。
 */
function filterMoves(moves, aiPlayer) {
    if (!farCapture && !safeMove && !safeDrop && !dropBlind) return moves;
    const opponent = getOpponent(aiPlayer);
    const kept = [];
    for (const move of moves) {
        if (move.type === 'move' && board[move.toY][move.toX] && farCapture > 0
            && Math.max(Math.abs(move.toX - move.fromX), Math.abs(move.toY - move.fromY)) >= 3
            && Math.random() < farCapture) continue;
        // 持ち駒はそもそも打つこと自体を思いつかないことがある（使いどころが分からない）
        if (move.type === 'drop' && dropBlind > 0 && Math.random() < dropBlind) continue;
        // ただ取られる形に気づく割合。打つ手は必ず気づく（置いた瞬間に取られる手は指さない）
        const notice = move.type === 'drop' ? safeDrop : safeMove;
        if (notice > 0 && Math.random() < notice && hangsNear(move, aiPlayer, opponent)) continue;
        kept.push(move);
    }
    return kept.length ? kept : moves;
}

function quiescenceSearch(alpha, beta, player, aiPlayer, qDepth) {
    if (searchAborted) return 0;
    const standPat = player === aiPlayer ? minmaxEvaluate(aiPlayer) : -minmaxEvaluate(aiPlayer);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qDepth >= exchangeDepth) return standPat;
    const captures = getCaptureMoves(player);
    if (captures.length === 0) return standPat;
    captures.sort((a, b) => (PIECE_VALUES[board[b.toY][b.toX]?.type] || 0) - (PIECE_VALUES[board[a.toY][a.toX]?.type] || 0));
    const opponent = getOpponent(player);
    for (const move of captures) {
        const capturedValue = PIECE_VALUES[board[move.toY][move.toX]?.type] || 0;
        if (standPat + capturedValue + 200 < alpha) continue;
        if (!isMoveLegalForPlayer(move, player)) continue;
        const undo = applyMoveFast(move, player);
        const score = -quiescenceSearch(-beta, -alpha, opponent, aiPlayer, qDepth + 1);
        undoMoveFast(undo);
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }
    return alpha;
}

function getCaptureMoves(player) {
    const captures = [];
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const candidateMoves = calculatePseudoMoves(x, y, piece);
                for (const move of candidateMoves) {
                    const target = board[move.y][move.x];
                    if (target && target.owner !== player) {
                        const canPromote = pieceInfo[piece.type]?.canPromote;
                        const isEnteringPromotionZone = (player === SENTE && move.y <= 2) || (player === GOTE && move.y >= 6);
                        const wasInPromotionZone = (player === SENTE && y <= 2) || (player === GOTE && y >= 6);
                        const mustPromote = (piece.type === PAWN || piece.type === LANCE) && (player === SENTE ? move.y === 0 : move.y === 8) || (piece.type === KNIGHT) && (player === SENTE ? move.y <= 1 : move.y >= 7);
                        const promote = mustPromote || (canPromote && (isEnteringPromotionZone || wasInPromotionZone));
                        captures.push({ type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: promote });
                    }
                }
            }
        }
    }
    return captures;
}

function negamax(depth, alpha, beta, player, aiPlayer, ply) {
    if ((++searchNodes & 1023) === 0 && performance.now() - searchStartTime > searchTimeLimit) { searchAborted = true; return 0; }
    if (depth <= 0) return quiescenceSearch(alpha, beta, player, aiPlayer, 0);
    const originalAlpha = alpha;
    const boardHash = computeZobristHash(board, capturedPieces, player);
    const ttEntry = transpositionTable.get(boardHash);
    let ttMove = null;
    if (ttEntry && ttEntry.depth >= depth) {
        ttMove = ttEntry.bestMove;
        if (ttEntry.flag === 'exact') return player === aiPlayer ? ttEntry.score : -ttEntry.score;
        else if (ttEntry.flag === 'lowerbound') alpha = Math.max(alpha, player === aiPlayer ? ttEntry.score : -ttEntry.score);
        else if (ttEntry.flag === 'upperbound') beta = Math.min(beta, player === aiPlayer ? ttEntry.score : -ttEntry.score);
        if (alpha >= beta) return player === aiPlayer ? ttEntry.score : -ttEntry.score;
    }
    const moves = getAllLegalMovesFast(player);
    if (moves.length === 0) return -100000 + ply;
    const orderedMoves = orderMoves(moves, player, ply, ttMove);
    let bestScore = -Infinity;
    let bestMove = orderedMoves[0];
    const opponent = getOpponent(player);
    for (let i = 0; i < orderedMoves.length; i++) {
        const move = orderedMoves[i];
        const undo = applyMoveFast(move, player);
        let score;
        if (i === 0) score = -negamax(depth - 1, -beta, -alpha, opponent, aiPlayer, ply + 1);
        else {
            score = -negamax(depth - 1, -alpha - 1, -alpha, opponent, aiPlayer, ply + 1);
            if (score > alpha && score < beta && !searchAborted) score = -negamax(depth - 1, -beta, -alpha, opponent, aiPlayer, ply + 1);
        }
        undoMoveFast(undo);
        if (searchAborted) return 0;
        if (score > bestScore) { bestScore = score; bestMove = move; }
        alpha = Math.max(alpha, score);
        if (alpha >= beta) {
            if (move.type === 'move' && !board[move.toY]?.[move.toX]) {
                if (ply < killerMoves.length) {
                    if (!isSameMove(killerMoves[ply][0], move)) { killerMoves[ply][1] = killerMoves[ply][0]; killerMoves[ply][0] = move; }
                }
            }
            const histKey = getMoveKey(move);
            historyHeuristic[histKey] = (historyHeuristic[histKey] || 0) + depth * depth;
            break;
        }
    }
    let flag = bestScore <= originalAlpha ? 'upperbound' : (bestScore >= beta ? 'lowerbound' : 'exact');
    const scoreToStore = player === aiPlayer ? bestScore : -bestScore;
    transpositionTable.set(boardHash, { depth: depth, score: scoreToStore, flag: flag, bestMove: bestMove });
    return bestScore;
}

// 読んだ結果から手を選ぶときに散らすかどうか。入門・初級・中級だけ true。
// 上級以上は常にいちばん良い手（探索の枝刈りもそのまま効かせる）。
let spreadPicks = false;

// 散らすときにどこまで枝刈りしてよいか（点）。散らし幅より十分広く取ること
const PRUNE_BAND = 400;

function searchRoot(depth, aiPlayer, pvMove) {
    const moves = getAllLegalMovesFast(aiPlayer);
    if (moves.length === 0) return { move: null, score: -100000 };
    const orderedMoves = orderMoves(filterMoves(moves, aiPlayer), aiPlayer, 0, pvMove);
    let bestMove = orderedMoves[0];
    let bestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    const scored = spreadPicks ? [] : null;
    for (const move of orderedMoves) {
        if (performance.now() - searchStartTime > searchTimeLimit) { searchAborted = true; break; }
        const rookShift = planRookSquare && move.type === 'move' && move.fromX === planRookSquare.x && move.fromY === planRookSquare.y
            && move.toY === move.fromY && !board[move.toY][move.toX] && board[move.fromY][move.fromX]?.type === ROOK;
        const undo = applyMoveFast(move, aiPlayer);
        const score = -negamax(depth - 1, -beta, -alpha, getOpponent(aiPlayer), aiPlayer, 1) - (rookShift ? PLAN_ROOK_STAY : 0);
        undoMoveFast(undo);
        if (searchAborted) break;
        if (score > bestScore) { bestScore = score; bestMove = move; }
        if (scored) scored.push({ move, score });
        // 🔴 散らすときは alpha を PRUNE_BAND 点ぶん低く保つ。ここを最善値まで上げると、
        // 負けている手の点数が枝刈りで潰れて同点に見え、散らしが「点数を見ないランダム」に
        // 化ける（実測で中級が壊滅した）。逆に全く上げないと枝刈りが効かず1手3倍遅くなる。
        // 散らし幅（±35点）よりずっと広く取ってあるので、選ばれうる手の点数は正確なまま、
        // 望みのない手だけ刈れる
        alpha = Math.max(alpha, score - (spreadPicks ? PRUNE_BAND : 0));
    }
    if (scored && scored.length > 1) bestMove = pickFromTop(scored);
    return { move: bestMove, score: bestScore };
}

// 読みの深さごとの打ち切り時間（ms）
const SEARCH_TIME_LIMITS = { 1: 500, 2: 700, 3: 1200, 4: 2000, 5: 3000, 6: 5500 };
// 最後の読みで最後まで読み切った深さと、その最善の点（作戦の手の確かめに使う）。読めていなければ深さ0
let lastSearchDepth = 0;
let lastSearchScore = 0;

function getBestMoveWithSearch(maxDepth, aiPlayer) {
    lastSearchDepth = 0;
    const moves = getAllLegalMovesFast(aiPlayer);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    startIncrementalEval(aiPlayer);
    try {
        searchTimeLimit = SEARCH_TIME_LIMITS[maxDepth] || 5500;
        searchStartTime = performance.now();
        searchAborted = false;
        searchNodes = 0;
        killerMoves = Array(maxDepth + 2).fill(null).map(() => [null, null]);
        historyHeuristic = {};
        previousBestMove = null;
        let bestMove = moves[0];
        let bestScore = -Infinity;

        for (let depth = 1; depth <= maxDepth; depth++) {
            const iterationStart = performance.now();
            const result = searchRoot(depth, aiPlayer, previousBestMove);
            if (searchAborted) {
                if (depth === 1 && result.move) bestMove = result.move;
                break;
            }
            if (result.move) {
                bestMove = result.move; bestScore = result.score; previousBestMove = result.move;
                lastSearchDepth = depth; lastSearchScore = bestScore;
            }
            const iterationTime = performance.now() - iterationStart;
            const elapsed = performance.now() - searchStartTime;
            if (searchTimeLimit - elapsed < iterationTime * 2) break;
        }

        return bestMove;
    } finally {
        stopIncrementalEval();
    }
}

// 作戦なしの対局（チュートリアル・駒落ち・指し継ぎ）用。作戦つきの対局は下の PLAN_WEAKNESS を使う。
// 入門・初級・中級の弱さは「読む深さ」と、人がやる間違いを写した4つのつまみで作る。
//   exchange   … 駒の取り合いを何手数えるか。0＝数えない
//   safeMove   … 盤上の駒を動かすとき「ただ取られる形」に気づく割合
//   safeDrop   … 持ち駒を打つとき同じことに気づく割合。1＝打ち捨ては必ず避ける
//   dropBlind  … 持ち駒を打つ手そのものを思いつかない割合（使いどころが分からない）
//   kingWeight … 玉のまわりをどれだけ重く見るか。小さいほど囲わず、寄せられて詰む
//   farCapture … 3マス以上先の駒を取る手を思いつかない割合。1＝確率ではなく必ず見送る。
// 🔴 farCapture を下げないこと。0.8 にすると初級が旧初級に59%＝強化になり、初心者役の
// 実用勝率も14%→3%に落ちる（実測96局）
// 🔴 safeMove を上げると初心者が勝てなくなる。**ここが強さのほぼすべてを決める。**
// 「ただ取られる手は絶対に指さない」設定のまま他のつまみを9通り振っても、
// 初心者役の勝率は0〜3%から動かなかった（引き分けばかりになる）。
// 初心者が勝つ道は「相手がくれた駒を取って数で押し切る」しかないため。
// 🔴 強さは「変更前の同じレベルとの直接対戦」で測る。初心者役の勝率で合わせないこと
// （初級より上は0%で頭打ちになり、強くなったことを検出できない。実際に見落とした）。
// 先後入替えの直接対戦（各128局。同じ設定でも上下10ポイントほどぶれる）:
//   入門  旧初級に10% / 初心者役の実用勝率37%・詰ませた28%（旧初級では19%・7%）
//   初級  旧初級に50%（＝強さは据え置き）/ 初心者役の実用勝率14%
//   中級  旧中級に43%
// 入門の棋譜の質（128局）: 打ち捨て0%（旧初級5%）/ 意味のない香の1マス上げ1% / 繰り返し2%
const WEAKNESS_BY_DIFFICULTY = {
    novice: { exchange: 0, safeMove: 0.1, safeDrop: 1, dropBlind: 0.75, kingWeight: 0.25, farCapture: 1 },
    easy: { exchange: 0, safeMove: 0.6, safeDrop: 1, dropBlind: 0.65, farCapture: 1 },
    // 中級は2手先まで今までどおり読むが、**駒の取り合いを数え切らない**。
    // 「相手の返し手は見えるが、その先の取り合いまでは数え切れない」という人らしい間違い方。
    // 「点数を見ないくじ引き」を外したぶん強くなる分を、ちょうどこれで戻している
    medium: { exchange: 0 },
};

// 手の選び方（入門・初級・中級で共通）。**点数の上位 PICK_TOP_N 手に絞ってから**、
// その中だけで散らす。二重の歯止めになっている:
//   順位で絞る … 静かな局面は手の点数差が小さく（実測で1位と10位が20〜30点差）、
//                点差だけで散らすと中位の手（意味のない香上げなど）まで届いてしまう
//   点差で散らす … 逆に差が開いている局面で「2番目」に飛びつかない
// 実測（初期局面・5手進めた局面の各300回）で、上位8手までなら意味のない香上げは0%のまま
// 8種類に散り、増えるのは飛車を振る手など普通の手だった。
const PICK_TOP_N = 8;

/**
 * { move, score } の一覧から、上位N手を取り出して散らして1手選ぶ。
 * 上級以上は散らさないので、この関数を通さず最善手をそのまま使う。
 */
function pickFromTop(scored) {
    if (scored.length <= 1) return scored.length ? scored[0].move : null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored.length > PICK_TOP_N ? scored.slice(0, PICK_TOP_N) : scored;
    let bestMove = top[0].move;
    let bestPick = -Infinity;
    for (const entry of top) {
        const pick = entry.score + (Math.random() - 0.5) * PICK_JITTER;
        if (pick > bestPick) { bestPick = pick; bestMove = entry.move; }
    }
    return bestMove;
}

// 上位N手の中で点数に足すブレの幅（±PICK_JITTER/2）。入門・初級・中級で共通。
// いちばん良い手に固定せず、点数が近い手なら2番目・3番目も選ぶようにするためのもの。
// 🔴 広げすぎないこと。静かな局面だと手の点数差が小さく（初期局面の後手番で1位=34点・
// 5位=24点・全30手の最下位=−17点）、幅が点数差を超えると評価を上書きしてしまう。
// 初期局面で選ばせた実測（選ばれた手の種類／意味のない香上げの割合）:
//   ±8 → 4種類・0%   ±20 → 7種類・0%   ±28 → 13種類・0%
//   ±35 → 16種類・0%   ±40 → 23種類・0.2%   ±60 → 26種類・0.7%
// ±35 までは散るのが「玉を囲う向き・銀や金を上げる・歩を突く」に収まる。±40から
// 香上げや飛車の端寄りが混ざり始めるので、その手前に置いてある。
// 歩1枚=100点よりは小さいので「気づいた駒は取る」は必ず守られる。
const PICK_JITTER = 70;

/**
 * 弱さのつまみを当てる。null なら上級以上と同じ（取り合いを数え、ふるいも散らしもしない）。
 * 🔴 呼び出し側で個別に設定しないこと。テストや計測が本番と違う挙動になる（実際にそれで測り違えた）
 */
function setWeakness(weakness) {
    spreadPicks = !!weakness;
    exchangeDepth = (weakness && Number.isFinite(weakness.exchange)) ? weakness.exchange : DEFAULT_EXCHANGE_DEPTH;
    safeMove = (weakness && weakness.safeMove) || 0;
    safeDrop = (weakness && weakness.safeDrop) || 0;
    dropBlind = (weakness && weakness.dropBlind) || 0;
    farCapture = (weakness && weakness.farCapture) || 0;
    kingWeight = (weakness && Number.isFinite(weakness.kingWeight)) ? weakness.kingWeight : 1;
}

/** 弱さのつまみを当てて手を選ぶ */
function getBestMoveWithWeakness(maxDepth, aiPlayer, weakness) {
    setWeakness(weakness);
    return getBestMoveWithSearch(maxDepth, aiPlayer);
}

// --- 作戦（戦法） ---
// 対局ごとに戦法を1つ持ち、序盤はその手順で駒を組んで攻める。作戦の手は指す前に読んで確かめ、
// 最善から PLAN_MARGIN 点より損なら指さない（その行を少し休ませ、普段どおりの手を指す）。
// 手順は先手から見た「駒・元のマス・行き先」（USI のマス）。後手は盤を180度回して使う。
// 手順の進み具合は持たず、毎手、盤から判定し直す（待ったで戻されてもずれない）。
// 名前は技図鑑と同じ id。手順は図鑑の定跡と囲いの図に合わせてある（囲いは技の判定の形になる並び）。
// 振り飛車は片美濃まで組んだら仕掛け、残りの駒組みはそのあと（攻めない相手にも自分から攻め出すため）。
// 仕掛けの歩を取られたら取り返す行（飛車・銀・桂）も入れてある（入門・初級は遠くの駒を取る手を思いつかないので）
const STRATEGIES = {
    bogin: 'FU2g2f FU2f2e KI6i7h GI3i3h GI3h2g GI2g2f OU5i6h KI4i5h FU1g1f GI2f1e FU2e2d GI1e2d',
    migi_shiken_bisha: 'FU4g4f HI2h4h FU7g7f GI3i3h GI3h4g OU5i6h OU6h7h KI4i5h FU3g3f KE2i3g FU4f4e KE3g4e',
    shiken_bisha: 'FU7g7f FU6g6f HI2h6h OU5i4h OU4h3h OU3h2h GI3i3h FU6f6e FU6e6d HI6h6d KA8h7g GI7i7h FU1g1f KI6i5h FU4g4f',
    sanken_bisha: 'FU7g7f FU6g6f HI2h7h OU5i4h OU4h3h OU3h2h GI3i3h FU7f7e FU7e7d HI7h7d KA8h7g GI7i6h FU1g1f KI6i5h FU6f6e',
    naka_bisha: 'FU5g5f FU5f5e HI2h5h FU7g7f OU5i4h OU4h3h OU3h2h GI3i3h FU5e5d HI5h5d KA8h7g GI7i6h GI6h5g GI5g4f FU1g1f',
    mukai_bisha: 'FU7g7f FU6g6f KA8h7g HI2h8h OU5i4h OU4h3h OU3h2h GI3i3h FU8g8f FU8f8e FU8e8d HI8h8d GI7i7h FU1g1f KI6i5h',
};
const usiSquare = (sq) => ({ x: 9 - Number(sq[0]), y: 'abcdefghi'.indexOf(sq[1]) });
const sameSquare = (a, b) => a.x === b.x && a.y === b.y;
const PLAN_ROWS = {};
for (const id in STRATEGIES) {
    const rows = STRATEGIES[id].split(' ').map(s => ({ type: s.slice(0, 2), from: usiSquare(s.slice(2, 4)), to: usiSquare(s.slice(4, 6)) }));
    rows.forEach((row, i) => {
        // follows：前の行で動かした駒の続き（玉の2歩目、仕掛けの歩を取り返す飛車・銀・桂など）
        row.follows = rows.slice(0, i).some(r => r.type === row.type && sameSquare(r.to, row.from));
        // next：この行の駒がこのあと進む行（▲4八玉の行なら ▲3八玉・▲2八玉の行）
        row.next = [];
        let at = row.to;
        for (let j = i + 1; j < rows.length; j++) {
            if (rows[j].type === row.type && sameSquare(rows[j].from, at)) { row.next.push(j); at = rows[j].to; }
        }
    });
    PLAN_ROWS[id] = rows;
}
const PLAN_MAX_MOVE = 50;      // 作戦を使うのは moveCount（両者の手数）がこれ未満の間
const PLAN_MARGIN = 50;        // 最善からこの点数以内なら作戦の手を指す（歩1枚=100点）
const PLAN_CHECK_DEPTH = 3;    // 入門〜中級の確かめは、上級と同じ深さで別に読む
const PLAN_REREAD_MIN = 300;   // 作戦の手だけ読み直すときの時間の下限（ms）
const PLAN_REST = 4;           // 見送った行は moveCount+4 まで休ませる（＝AIの次の1手番だけ飛ばす）
const PLAN_MAX_MISSES = 5;     // 連続でこれだけ見送ったら作戦を終える
const PLAN_ILLEGAL_LOOKS = 3;  // 指せない行をこれだけ見たら、その手番は探すのをやめる
// 作戦の間、飛車を作戦の筋から横へ動かす（取らない）手は、読みの点をこれだけ下げる。
// 点の近い静かな手の散らしで飛車が振り直され、作戦の形が崩れて「何をしたいのか分からない」動きになるのを防ぐ。
// 狙われた飛車を逃がす手などは点差がこれより大きいので消えない
const PLAN_ROOK_STAY = 60;
let planRookSquare = null; // 作戦の飛車のいるべきマス（作戦なし・作戦を使う手数を過ぎたら null）

/** 作戦の飛車の筋。飛車を振る戦法はその行き先、居飛車はもとの位置 */
function planRookHome(plan, player) {
    const row = PLAN_ROWS[plan.id]?.find(r => r.type === ROOK);
    const home = row ? row.to : usiSquare('2h');
    return player === SENTE ? home : { x: 8 - home.x, y: 8 - home.y };
}

// 作戦つきの対局（AI対戦の入門〜超級と、だれかと対戦のCOM）の弱さのつまみ。作戦を終えたあとも
// その対局の最後まで使う。作戦なしの対局（チュートリアル・駒落ち・指し継ぎ）は WEAKNESS_BY_DIFFICULTY のまま。
// 合わせ方：入門・初級は初心者役の実用勝率を作戦なしの今の値に合わせる（直接対戦も並べて見る）。
// 中級より上は変更前の同じレベルとの直接対戦で（初心者役は0%で頭打ちになり、強くなっても気づけない）。
// 作戦つきは序盤の形が整うぶん強くなる。実測（2026-10-11。初心者役は各500局、直接対戦は各128局（超級は64局）・先後交互）:
//   入門  作戦なしのつまみのままだと初心者役の実用勝率42〜44%（作戦なし40%）→ safeMove 0.3 で38〜40%
//   初級  作戦なしのつまみのままで15%（作戦なし16%）。変えない
//   中級  そのままだと変更前の中級に65% → 持ち駒を打つ手と遠くの駒を取る手をそれぞれ3割見落とすと51〜61%（256局で57%）
//   上級・超級  つまみ無しのまま、変更前の同じレベルに61%・50%
const PLAN_WEAKNESS = {
    novice: { ...WEAKNESS_BY_DIFFICULTY.novice, safeMove: 0.3 },
    easy: WEAKNESS_BY_DIFFICULTY.easy,
    medium: { exchange: 0, dropBlind: 0.3, farCapture: 0.3 },
};

/** 渡された作戦の状態を写す。{ id, rests: { 行: 休みが終わる手数 }, misses: 連続の見送り, off: 終えた } */
function readPlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    return { id: plan.id, rests: { ...plan.rests }, misses: plan.misses || 0, off: !!plan.off || !PLAN_ROWS[plan.id] };
}

const planUsed = (plan) => ({ ...plan, misses: 0 });
function planSkipped(plan, row) {
    const misses = plan.misses + 1;
    return { ...plan, rests: { ...plan.rests, [row]: moveCount + PLAN_REST }, misses, off: misses >= PLAN_MAX_MISSES };
}

function ownPieceAt(sq, type, player) {
    const piece = board[sq.y][sq.x];
    return !!piece && piece.owner === player && piece.type === type;
}

/** 自陣の、行き先と同じ側（中央の筋より左か右か）に自分の飛車がいるか。玉をそちらへ寄せる行は指さない */
function rookOnKingSide(to, player) {
    const side = Math.sign(to.x - 4);
    if (!side) return false;
    for (let y = player === SENTE ? 5 : 0; y < (player === SENTE ? 9 : 4); y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player && (piece.type === ROOK || piece.type === PROMOTED_ROOK) && Math.sign(x - 4) === side) return true;
        }
    }
    return false;
}

/**
 * 手順の先頭から作戦の手を探す。済んだ行（行き先にその駒がある）・駒が無い行・休み中の行は飛ばし、
 * 指せない行（ふさがっている・王手を受けている等）を PLAN_ILLEGAL_LOOKS 個見たらその手番は諦める。
 * 🔴 先の行が残っている間は、その行き先（飛車・角は通り道も）と、その駒がこのあと進む行の行き先に、後ろの行の駒を入れない。
 *    先の行を休ませている間に後ろの行を進めると、玉の入る場所に銀が先に来るなどして囲いが組めなくなる
 * 🔴 行き先か通り道に自分の駒がいる行は、どくまで待つ（押さえも続ける。普段の手で飛車の振る先に金が入った等）。
 *    押さえを外すと、振っていない飛車のそばへ玉を囲いに行く。玉を自分の飛車のいる側へ寄せる行も指さない（玉飛接近）
 * 返り値は { move, row }。見つからなければ { done }（done＝もう指せる行が残っていないか、作戦を使う手数を過ぎた）
 */
function findPlanStep(plan, player) {
    if (plan.off) return {};
    if (moveCount >= PLAN_MAX_MOVE) return { done: true };
    const rows = PLAN_ROWS[plan.id];
    const at = (sq) => player === SENTE ? sq : { x: 8 - sq.x, y: 8 - sq.y };
    // 行の駒が入るマス（飛車・角は通り道も）。マスは y*9+x
    const squares = (row) => {
        const from = at(row.from), to = at(row.to);
        if (row.type !== ROOK && row.type !== BISHOP) return [to.y * 9 + to.x];
        const list = [];
        for (let x = from.x, y = from.y; x !== to.x || y !== to.y;) {
            x += Math.sign(to.x - x);
            y += Math.sign(to.y - y);
            list.push(y * 9 + x);
        }
        return list;
    };
    const mine = (key) => board[Math.floor(key / 9)][key % 9]?.owner === player;
    const reserved = new Set();
    let pending = false, illegal = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const from = at(row.from), to = at(row.to), toKey = to.y * 9 + to.x;
        if (ownPieceAt(to, row.type, player) || !ownPieceAt(from, row.type, player)) continue;
        pending = true;
        // 続きの行で行き先に自分の駒がいる（仕掛けの歩が取られるのを待っている等）のは、今は指せないだけ。
        // 押さえると、その間ずっと後ろの行（角を上がる等）が止まるので押さえない
        if (row.follows && mine(toKey)) continue;
        const path = squares(row);
        const blocked = reserved.has(toKey);
        for (const k of path) reserved.add(k);
        for (const j of row.next) for (const k of squares(rows[j])) reserved.add(k);
        if (blocked || path.some(mine) || (plan.rests[i] || 0) > moveCount) continue;
        if (row.type === KING && rookOnKingSide(to, player)) continue;
        const move = { type: 'move', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, promote: false };
        if (calculatePseudoMoves(from.x, from.y, board[from.y][from.x]).some(m => m.x === to.x && m.y === to.y)
            && isMoveLegalForPlayer(move, player)) return { move, row: i };
        if (++illegal >= PLAN_ILLEGAL_LOOKS) break;
    }
    return { done: !pending };
}

/**
 * 作戦の手が、直前の読み（lastSearchDepth・lastSearchScore）の最善から PLAN_MARGIN 点以内か。
 * 作戦の手だけを同じ深さ・同じ置換表・同じつまみで幅いっぱいに読み直して比べる。
 * 'ok' / 'bad'、読み切れなければ null（見送りに数えない。遅い端末で黙って作戦が終わらないように）
 */
function judgePlanMove(planMove, best, aiPlayer, timeLimit) {
    if (!best || lastSearchDepth < 1) return null;
    if (isSameMove(planMove, best)) return 'ok';
    startIncrementalEval(aiPlayer);
    try {
        searchStartTime = performance.now();
        searchTimeLimit = timeLimit;
        searchAborted = false;
        searchNodes = 0;
        const undo = applyMoveFast(planMove, aiPlayer);
        const score = -negamax(lastSearchDepth - 1, -Infinity, Infinity, getOpponent(aiPlayer), aiPlayer, 1);
        undoMoveFast(undo);
        if (searchAborted) return null;
        return score >= lastSearchScore - PLAN_MARGIN ? 'ok' : 'bad';
    } finally {
        stopIncrementalEval();
    }
}

/**
 * 入門・初級・中級の確かめ。自分の浅い読みでは仕掛けの歩を「ただ取られる損」と見て却下してしまうので、
 * 上級と同じ読み（深さ3・取り合いを数える・散らしなし）で別に読む。深さ3まで読み切れなければ null。
 * 🔴 確かめ専用の置換表で読む。置換表のキーは読みのつまみを区別しないので、普段の表に書かせると
 *    中級の普段の読みが上級並みの点を引いて強くなる（実測で根の手の点数がすべて上級と一致した）
 */
function checkPlanSeparately(planMove, aiPlayer) {
    const normalTable = transpositionTable;
    transpositionTable = new Map();
    try {
        const started = performance.now();
        const best = getBestMoveWithWeakness(PLAN_CHECK_DEPTH, aiPlayer, null);
        if (lastSearchDepth < PLAN_CHECK_DEPTH) return null;
        const left = SEARCH_TIME_LIMITS[PLAN_CHECK_DEPTH] - (performance.now() - started);
        return judgePlanMove(planMove, best, aiPlayer, Math.max(left, PLAN_REREAD_MIN));
    } finally {
        transpositionTable = normalTable;
    }
}

const SEARCH_DEPTH = { novice: 1, easy: 1, medium: 2, hard: 3, super: 5 };

function loadPosition(data) {
    board = data.board;
    capturedPieces = data.capturedPieces;
    currentPlayer = data.currentPlayer;
    moveCount = data.moveCount;
    recomputeKingPosCache();
}

const toUsiMove = (m) => `${9 - m.fromX}${'abcdefghi'[m.fromY]}${9 - m.toX}${'abcdefghi'[m.toY]}`;

// --- Message Handler ---

self.onmessage = function (e) {
    const { type, data } = e.data;
    if (type === 'getBestMove') {
        const { aiDifficulty, aiPlayer, weakness, experimentParam, requestId } = data;
        loadPosition(data);

        // Set experiment parameter (0 = old/baseline, 1 = new/experimental)
        currentExperimentParam = experimentParam ?? 0;

        const depth = SEARCH_DEPTH[aiDifficulty] || 1;
        let plan = readPlan(data.plan);
        planRookSquare = plan && moveCount < PLAN_MAX_MOVE ? planRookHome(plan, aiPlayer) : null;
        // 弱さのつまみは難易度から決まる。呼び出し側が渡したときだけそちらを使う
        // （だれかと対戦の練習対局が、形勢に合わせて手加減の度合いを動かすため）
        const knobs = weakness || (plan ? PLAN_WEAKNESS : WEAKNESS_BY_DIFFICULTY)[aiDifficulty] || null;

        // Measure thinking time (lightweight - uses performance.now())
        const thinkingStartTime = performance.now();
        if (transpositionTable.size > MAX_TT_SIZE) transpositionTable.clear();

        const step = plan ? findPlanStep(plan, aiPlayer) : {};
        if (step.done) plan = { ...plan, off: true };
        let move = null;
        let verdict = null;
        if (step.move && depth < PLAN_CHECK_DEPTH) {
            verdict = checkPlanSeparately(step.move, aiPlayer);
            if (verdict === 'ok') move = step.move;
        }
        if (!move) {
            const started = performance.now();
            move = getBestMoveWithWeakness(depth, aiPlayer, knobs);
            // 上級・超級は別に読まず、普段の読みの最善の点と、作戦の手だけの読み直しで確かめる
            if (step.move && depth >= PLAN_CHECK_DEPTH) {
                const left = (SEARCH_TIME_LIMITS[depth] || 5500) - (performance.now() - started);
                verdict = judgePlanMove(step.move, move, aiPlayer, Math.max(left, PLAN_REREAD_MIN));
                if (verdict === 'ok') move = step.move;
            }
        }
        if (verdict) plan = verdict === 'ok' ? planUsed(plan) : planSkipped(plan, step.row);

        const thinkingTime = performance.now() - thinkingStartTime;

        self.postMessage({
            type: 'bestMove',
            data: {
                move,
                plan,
                thinkingTime,
                requestId
            }
        });
    } else if (type === 'nextPlanMove') {
        // 達人級以上（やねうら王）で戦法を指定したとき。作戦の手を選ぶだけで、確かめはやねうら王が浅く読んでする。
        // 指したとき・見送ったとき・使わなかったときの次の状態を返し、呼び出し側がどれかを選ぶ
        loadPosition(data);
        let plan = readPlan(data.plan);
        const step = plan ? findPlanStep(plan, data.aiPlayer) : {};
        if (step.done) plan = { ...plan, off: true };
        const row = step.move ? PLAN_ROWS[plan.id][step.row] : null;
        self.postMessage({
            type: 'planMove',
            data: {
                planMove: step.move ? toUsiMove(step.move) : null,
                // 飛車を振る手（その戦法の最初の飛車の行）。やねうら王は確かめで許す差を広げる
                planSwing: !!row && row.type === ROOK && !row.follows,
                ifUsed: step.move ? planUsed(plan) : plan,
                ifSkipped: step.move ? planSkipped(plan, step.row) : plan,
                ifNone: plan,
                requestId: data.requestId
            }
        });
    }
};
