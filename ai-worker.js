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

const JOSEKI_PATTERNS = {
    kakugawari: [
        { player: SENTE, move: { fromX: 9 - 2, fromY: 7 - 1, toX: 9 - 2, toY: 6 - 1 } },
        { player: GOTE, move: { fromX: 9 - 8, fromY: 3 - 1, toX: 9 - 8, toY: 4 - 1 } },
        { player: SENTE, move: { fromX: 9 - 2, fromY: 6 - 1, toX: 9 - 2, toY: 5 - 1 } },
        { player: GOTE, move: { fromX: 9 - 8, fromY: 4 - 1, toX: 9 - 8, toY: 5 - 1 } },
        { player: SENTE, move: { fromX: 9 - 7, fromY: 7 - 1, toX: 9 - 7, toY: 6 - 1 } },
        { player: GOTE, move: { fromX: 9 - 4, fromY: 1 - 1, toX: 9 - 3, toY: 2 - 1 } },
        { player: SENTE, move: { fromX: 9 - 8, fromY: 8 - 1, toX: 9 - 7, toY: 7 - 1 } },
        { player: GOTE, move: { fromX: 9 - 3, fromY: 3 - 1, toX: 9 - 3, toY: 4 - 1 } },
    ],
    yagura: [
        { player: SENTE, move: { fromX: 9 - 7, fromY: 7 - 1, toX: 9 - 7, toY: 6 - 1 } },
        { player: GOTE, move: { fromX: 9 - 8, fromY: 3 - 1, toX: 9 - 8, toY: 4 - 1 } },
        { player: SENTE, move: { fromX: 9 - 6, fromY: 7 - 1, toX: 9 - 6, toY: 6 - 1 } },
        { player: GOTE, move: { fromX: 9 - 8, fromY: 4 - 1, toX: 9 - 8, toY: 5 - 1 } },
        { player: SENTE, move: { fromX: 9 - 3, fromY: 9 - 1, toX: 9 - 7, toY: 8 - 1 } },
        { player: GOTE, move: { fromX: 9 - 4, fromY: 1 - 1, toX: 9 - 3, toY: 2 - 1 } },
        { player: SENTE, move: { fromX: 9 - 5, fromY: 7 - 1, toX: 9 - 5, toY: 6 - 1 } },
        { player: GOTE, move: { fromX: 9 - 7, fromY: 3 - 1, toX: 9 - 7, toY: 4 - 1 } },
    ],
};

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
let lastMoveDetail = null;
let josekiEnabled = true;
let currentJosekiPattern = null;
let josekiMoveIndex = 0;
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

function isSquareAttackedBy(attacker, targetX, targetY, currentBoard = board) {
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

    for (let x = targetX + 1; x < 9; x++) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    for (let x = targetX - 1; x >= 0; x--) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    for (let y = targetY + 1; y < 9; y++) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === SENTE && p.type === LANCE) return true;
        }
        break;
    }
    for (let y = targetY - 1; y >= 0; y--) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === GOTE && p.type === LANCE) return true;
        }
        break;
    }

    for (let x = targetX + 1, y = targetY + 1; x < 9 && y < 9; x++, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX - 1, y = targetY + 1; x >= 0 && y < 9; x--, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX + 1, y = targetY - 1; x < 9 && y >= 0; x++, y--) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    for (let x = targetX - 1, y = targetY - 1; x >= 0 && y >= 0; x--, y--) {
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

function isCheckmate(player) {
    if (!isKingInCheck(player)) return false;
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const pseudoMoves = calculatePseudoMoves(x, y, piece);
                for (const move of pseudoMoves) {
                    const tempBoard = cloneBoard(board);
                    tempBoard[move.y][move.x] = tempBoard[y][x];
                    tempBoard[y][x] = null;
                    if (!isKingInCheck(player, tempBoard)) return false;
                }
            }
        }
    }
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
    const originalBoard = board;
    board = tempBoard;
    recomputeKingPosCache();
    const isOpponentCheckmated = isCheckmate(opponent);
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
                delta += getHandPieceEval(capturedBaseType, player, aiPlayer);
            }
            undo.evalDelta = delta;
        }
        if (target) {
            let capturedType = target.type;
            if (pieceInfo[capturedType]?.base) capturedType = pieceInfo[capturedType].base;
            capturedPieces[player][capturedType]++;
            undo.capturedType = capturedType;
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
        if (undo.captured) capturedPieces[player][undo.capturedType]--;
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

function getBoardHash(currentBoard, captured, player) {
    let hash = '';
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y][x];
            if (piece) hash += `${x}${y}${piece.type}${piece.owner}|`;
        }
    }
    hash += `S:`;
    for (const type in captured[SENTE]) if (captured[SENTE][type] > 0) hash += `${type}${captured[SENTE][type]}|`;
    hash += `G:`;
    for (const type in captured[GOTE]) if (captured[GOTE][type] > 0) hash += `${type}${captured[GOTE][type]}|`;
    hash += `P:${player}`;
    return hash;
}

const transpositionTable = new Map();
const MAX_TT_SIZE = 100000;

let searchStartTime = 0;
let searchTimeLimit = 0;
let searchAborted = false;
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

function minmaxEvaluate(aiPlayer) {
    const opponent = getOpponent(aiPlayer);
    const scoreBase = (incrementalEval.enabled && incrementalEval.aiPlayer === aiPlayer) ? incrementalEval.score : computeStaticEval(aiPlayer);
    let score = scoreBase;
    if (isKingInCheck(opponent)) score += 500;
    if (isKingInCheck(aiPlayer)) score -= 500;
    return score;
}

function quiescenceSearch(alpha, beta, player, aiPlayer, qDepth) {
    if (searchAborted) return 0;
    const standPat = player === aiPlayer ? minmaxEvaluate(aiPlayer) : -minmaxEvaluate(aiPlayer);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qDepth >= 4) return standPat;
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
    if ((ply & 127) === 0 && performance.now() - searchStartTime > searchTimeLimit) { searchAborted = true; return 0; }
    if (depth <= 0) return quiescenceSearch(alpha, beta, player, aiPlayer, 0);
    const originalAlpha = alpha;
    const boardHash = getBoardHash(board, capturedPieces, player);
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

function searchRoot(depth, aiPlayer, pvMove) {
    const moves = getAllLegalMovesFast(aiPlayer);
    if (moves.length === 0) return { move: null, score: -100000 };
    const orderedMoves = orderMoves(moves, aiPlayer, 0, pvMove);
    let bestMove = orderedMoves[0];
    let bestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    for (const move of orderedMoves) {
        if (performance.now() - searchStartTime > searchTimeLimit) { searchAborted = true; break; }
        const undo = applyMoveFast(move, aiPlayer);
        const score = -negamax(depth - 1, -beta, -alpha, getOpponent(aiPlayer), aiPlayer, 1);
        undoMoveFast(undo);
        if (searchAborted) break;
        if (score > bestScore) { bestScore = score; bestMove = move; }
        alpha = Math.max(alpha, score);
    }
    return { move: bestMove, score: bestScore };
}

function getBestMoveWithSearch(maxDepth, aiPlayer) {
    const moves = getAllLegalMovesFast(aiPlayer);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    startIncrementalEval(aiPlayer);
    try {
        const timeLimits = { 1: 500, 2: 700, 3: 1200, 4: 2000, 5: 3000, 6: 5500 };
        searchTimeLimit = timeLimits[maxDepth] || 5500;
        searchStartTime = performance.now();
        searchAborted = false;
        killerMoves = Array(maxDepth + 2).fill(null).map(() => [null, null]);
        historyHeuristic = {};
        previousBestMove = null;
        let bestMove = moves[0];
        let bestScore = -Infinity;
        for (let depth = 1; depth <= maxDepth; depth++) {
            const iterationStart = performance.now();
            const result = searchRoot(depth, aiPlayer, previousBestMove);
            if (searchAborted) break;
            if (result.move) { bestMove = result.move; bestScore = result.score; previousBestMove = result.move; }
            const iterationTime = performance.now() - iterationStart;
            const elapsed = performance.now() - searchStartTime;
            if (searchTimeLimit - elapsed < iterationTime * 2) break;
        }
        if (maxDepth < 3 && moves.length > 1) {
            const randomFactor = (3 - maxDepth) * 0.3;
            if (Math.random() < randomFactor) {
                const topMoves = orderMoves(moves, aiPlayer, 0, bestMove).slice(0, 5);
                bestMove = topMoves[Math.floor(Math.random() * topMoves.length)];
            }
        }
        return bestMove;
    } finally {
        stopIncrementalEval();
    }
}

function tryApplyJoseki(aiPlayer) {
    if (!josekiEnabled || moveCount > 15) return null;
    if (!currentJosekiPattern) {
        if (aiPlayer === GOTE && moveCount === 1 && lastMoveDetail) {
            const { fromX, fromY, toX, toY } = lastMoveDetail;
            for (const [patternName, pattern] of Object.entries(JOSEKI_PATTERNS)) {
                const firstMove = pattern[0].move;
                if (firstMove.fromX === fromX && firstMove.fromY === fromY && firstMove.toX === toX && firstMove.toY === toY) {
                    currentJosekiPattern = patternName;
                    josekiMoveIndex = 1;
                    break;
                }
            }
            if (!currentJosekiPattern) return null;
        } else if (aiPlayer === SENTE && moveCount === 0) {
            const patternNames = Object.keys(JOSEKI_PATTERNS);
            if (patternNames.length === 0) return null;
            currentJosekiPattern = patternNames[0];
            josekiMoveIndex = 0;
        } else return null;
    }
    const pattern = JOSEKI_PATTERNS[currentJosekiPattern];
    if (!pattern || josekiMoveIndex >= pattern.length) { currentJosekiPattern = null; return null; }
    const josekiMove = pattern[josekiMoveIndex];
    if (josekiMove.player !== currentPlayer) { currentJosekiPattern = null; return null; }
    if (josekiMoveIndex > 0) {
        const previousJosekiMove = pattern[josekiMoveIndex - 1].move;
        if (!lastMoveDetail || lastMoveDetail.fromX !== previousJosekiMove.fromX || lastMoveDetail.fromY !== previousJosekiMove.fromY || lastMoveDetail.toX !== previousJosekiMove.toX || lastMoveDetail.toY !== previousJosekiMove.toY) {
            currentJosekiPattern = null; return null;
        }
    }
    const { fromX, fromY, toX, toY } = josekiMove.move;
    const piece = board[fromY][fromX];
    if (!piece || piece.owner !== currentPlayer) { currentJosekiPattern = null; return null; }
    const targetPiece = board[toY][toX];
    if (targetPiece && targetPiece.owner === currentPlayer) { currentJosekiPattern = null; return null; }
    const mustPromote = (piece.type === PAWN || piece.type === LANCE) && (currentPlayer === SENTE ? toY === 0 : toY === 8) || (piece.type === KNIGHT) && (currentPlayer === SENTE ? toY <= 1 : toY >= 7);
    const promote = mustPromote;
    josekiMoveIndex++;
    return { type: 'move', fromX, fromY, toX, toY, promote };
}

// --- Message Handler ---

self.onmessage = function (e) {
    const { type, data } = e.data;
    if (type === 'getBestMove') {
        const {
            board: b,
            capturedPieces: cp,
            currentPlayer: currP,
            moveCount: mc,
            lastMoveDetail: lmd,
            aiDifficulty,
            aiPlayer,
            josekiEnabled: je,
            currentJosekiPattern: cjp,
            josekiMoveIndex: jmi
        } = data;

        // Update state
        board = b;
        capturedPieces = cp;
        currentPlayer = currP;
        moveCount = mc;
        lastMoveDetail = lmd;
        josekiEnabled = je;
        currentJosekiPattern = cjp;
        josekiMoveIndex = jmi;

        recomputeKingPosCache();

        let depth = 1;
        switch (aiDifficulty) {
            case 'easy': depth = 1; break;
            case 'medium': depth = 2; break;
            case 'hard': depth = 3; break;
            case 'super': depth = 4; break;
            case 'master': depth = 5; break;
            case 'great': depth = 6; break;
            default: depth = 1;
        }

        let move = null;
        if (moveCount <= 15) move = tryApplyJoseki(aiPlayer);
        if (!move) {
            if (transpositionTable.size > MAX_TT_SIZE) transpositionTable.clear();
            move = getBestMoveWithSearch(depth, aiPlayer);
        }

        self.postMessage({
            type: 'bestMove',
            data: {
                move,
                currentJosekiPattern,
                josekiMoveIndex
            }
        });
    }
};
