// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
// YaneuraOu WASM Worker - USI communication bridge
// Uses YaneuraOu engine (https://github.com/yaneurao/YaneuraOu)

let engine = null;
let engineReady = false;
let pendingResolve = null;
let bestMoveResult = null;
let initPromiseResolve = null;
let initError = null;

// Detect WASM SIMD support
async function detectSIMDSupport() {
    try {
        const simdTest = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
            0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
            0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b
        ]);
        await WebAssembly.instantiate(simdTest);
        return true;
    } catch (e) {
        return false;
    }
}

// Initialize YaneuraOu engine
// Cache buster: increment this version when WASM files are updated
const WASM_VERSION = 'v2';

async function initEngine() {
    const hasSIMD = await detectSIMDSupport();
    const variant = hasSIMD ? 'sse42' : 'nosimd';

    const scriptPath = `/yaneuraou/${variant}/yaneuraou.js?${WASM_VERSION}`;
    const basePath = `/yaneuraou/${variant}/`;

    try {
        importScripts(scriptPath);
    } catch (e) {
        throw new Error(`Failed to load YaneuraOu script: ${e.message}`);
    }

    const factoryName = hasSIMD ? 'YaneuraOu_sse42' : 'YaneuraOu_nosimd';
    const factory = self[factoryName];

    if (!factory) {
        const availableFns = Object.keys(self).filter(k => k.includes('YaneuraOu'));
        throw new Error(`YaneuraOu factory function ${factoryName} not found. Available: ${availableFns.join(', ')}`);
    }

    engine = await factory({
        locateFile: function (path) {
            return basePath + path + '?' + WASM_VERSION;
        }
    });

    if (engine.ready) {
        await engine.ready;
    }

    engine.addMessageListener((line) => {
        handleEngineMessage(line);
    });

    return new Promise((resolve, reject) => {
        initPromiseResolve = resolve;

        setTimeout(() => {
            if (!engineReady) {
                reject(new Error('Engine initialization timeout'));
            }
        }, 120000);

        engine.postMessage('usi');
    });
}

// Handle messages from YaneuraOu engine
function handleEngineMessage(line) {
    if (line === 'usiok') {
        engine.postMessage('setoption name Threads value 1');
        engine.postMessage('setoption name USI_Hash value 16');
        engine.postMessage('isready');
    } else if (line === 'readyok') {
        engineReady = true;
        if (initPromiseResolve) {
            initPromiseResolve();
            initPromiseResolve = null;
        }
    } else if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        const moveStr = parts[1];

        if (moveStr && moveStr !== 'resign' && moveStr !== 'win') {
            bestMoveResult = parseUSIMove(moveStr);
        } else {
            bestMoveResult = null;
        }

        if (pendingResolve) {
            pendingResolve(bestMoveResult);
            pendingResolve = null;
            bestMoveResult = null;
        }
    }
}

// Parse USI move string to internal format
function parseUSIMove(usiMove) {
    if (!usiMove || usiMove.length < 4) return null;

    // Drop move (e.g., "G*5b")
    if (usiMove[1] === '*') {
        const pieceChar = usiMove[0];
        const toFile = 9 - parseInt(usiMove[2]);
        const toRank = usiMove.charCodeAt(3) - 'a'.charCodeAt(0);

        const pieceTypeMap = {
            'P': 'FU', 'L': 'KY', 'N': 'KE', 'S': 'GI',
            'G': 'KI', 'B': 'KA', 'R': 'HI'
        };

        return {
            type: 'drop',
            pieceType: pieceTypeMap[pieceChar],
            toX: toFile,
            toY: toRank
        };
    }

    // Normal move (e.g., "7g7f" or "7g7f+")
    const fromFile = 9 - parseInt(usiMove[0]);
    const fromRank = usiMove.charCodeAt(1) - 'a'.charCodeAt(0);
    const toFile = 9 - parseInt(usiMove[2]);
    const toRank = usiMove.charCodeAt(3) - 'a'.charCodeAt(0);
    const promote = usiMove.length > 4 && usiMove[4] === '+';

    return {
        type: 'move',
        fromX: fromFile,
        fromY: fromRank,
        toX: toFile,
        toY: toRank,
        promote: promote
    };
}

// Convert board state to SFEN format
function boardToSFEN(board, capturedPieces, currentPlayer) {
    const pieceToSFEN = {
        'FU': 'P', 'KY': 'L', 'KE': 'N', 'GI': 'S',
        'KI': 'G', 'KA': 'B', 'HI': 'R', 'OU': 'K',
        '+FU': '+P', '+KY': '+L', '+KE': '+N', '+GI': '+S',
        '+KA': '+B', '+HI': '+R'
    };

    let boardStr = '';
    for (let y = 0; y < 9; y++) {
        if (y > 0) boardStr += '/';
        let emptyCount = 0;
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece === null) {
                emptyCount++;
            } else {
                if (emptyCount > 0) {
                    boardStr += emptyCount;
                    emptyCount = 0;
                }
                let sfenPiece = pieceToSFEN[piece.type] || 'K';
                if (piece.owner === 'gote') {
                    sfenPiece = sfenPiece.toLowerCase();
                }
                boardStr += sfenPiece;
            }
        }
        if (emptyCount > 0) {
            boardStr += emptyCount;
        }
    }

    const turnStr = currentPlayer === 'sente' ? 'b' : 'w';

    let handStr = '';
    const handOrder = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'];
    const handPieceToSFEN = {
        'HI': 'R', 'KA': 'B', 'KI': 'G', 'GI': 'S',
        'KE': 'N', 'KY': 'L', 'FU': 'P'
    };

    for (const pieceType of handOrder) {
        const count = capturedPieces['sente']?.[pieceType] || 0;
        if (count > 0) {
            if (count > 1) handStr += count;
            handStr += handPieceToSFEN[pieceType];
        }
    }

    for (const pieceType of handOrder) {
        const count = capturedPieces['gote']?.[pieceType] || 0;
        if (count > 0) {
            if (count > 1) handStr += count;
            handStr += handPieceToSFEN[pieceType].toLowerCase();
        }
    }

    if (handStr === '') handStr = '-';

    return `${boardStr} ${turnStr} ${handStr} 1`;
}

const difficultySettings = {
    'great': { nodes: 10000 },
    'transcendent': { nodes: 100000 },
    'legendary1': { nodes: 300000 },
    'legendary2': { nodes: 600000 },
    'legendary3': { nodes: 1200000 }
};

async function getBestMove(board, capturedPieces, currentPlayer, difficulty, usiMoves = []) {
    if (!engineReady) {
        await initEngine();
    }

    const settings = difficultySettings[difficulty] || difficultySettings['great'];
    const moveList = Array.isArray(usiMoves) ? usiMoves.filter(m => !!m) : [];

    return new Promise((resolve) => {
        pendingResolve = resolve;
        if (moveList.length > 0) {
            engine.postMessage(`position startpos moves ${moveList.join(' ')}`);
        } else {
            const sfen = boardToSFEN(board, capturedPieces, currentPlayer);
            engine.postMessage(`position sfen ${sfen}`);
        }
        engine.postMessage(`go nodes ${settings.nodes}`);
    });
}

// Message handler
self.onmessage = async function (e) {
    const { type, data } = e.data;

    if (type === 'init') {
        try {
            await initEngine();
            self.postMessage({ type: 'ready' });
        } catch (error) {
            initError = error.message;
            self.postMessage({ type: 'error', error: error.message });
        }
    } else if (type === 'getBestMove') {
        const { board, capturedPieces, currentPlayer, aiDifficulty, usiMoves, requestId } = data;
        const thinkingStartTime = performance.now();

        try {
            if (initError) {
                throw new Error('Engine failed to initialize: ' + initError);
            }

            const move = await getBestMove(board, capturedPieces, currentPlayer, aiDifficulty, usiMoves);
            const thinkingTime = performance.now() - thinkingStartTime;

            self.postMessage({
                type: 'bestMove',
                data: {
                    move,
                    thinkingTime,
                    engine: 'yaneuraou',
                    requestId
                }
            });
        } catch (error) {
            self.postMessage({
                type: 'error',
                error: error.message,
                requestId
            });
        }
    }
};
