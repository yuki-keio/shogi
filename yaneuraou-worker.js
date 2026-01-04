// YaneuraOu WASM Worker - USI communication bridge
// GPL-3.0 License - Uses YaneuraOu engine (https://github.com/yaneurao/YaneuraOu)

let engine = null;
let engineReady = false;
let pendingResolve = null;
let bestMoveResult = null;
let initPromiseResolve = null;
let initError = null;

// Detect WASM SIMD support
async function detectSIMDSupport() {
    try {
        // Test WASM SIMD instruction
        const simdTest = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
            0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
            0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b
        ]);
        await WebAssembly.instantiate(simdTest);
        console.log('[YaneuraOu Worker] SIMD supported');
        return true;
    } catch (e) {
        console.log('[YaneuraOu Worker] SIMD not supported:', e.message);
        return false;
    }
}

// Initialize YaneuraOu engine
async function initEngine() {
    console.log('[YaneuraOu Worker] Starting initialization...');

    // Check if SharedArrayBuffer is available (requires Cross-Origin Isolation)
    if (typeof SharedArrayBuffer === 'undefined') {
        throw new Error('SharedArrayBuffer is not available. Cross-Origin Isolation headers (COOP/COEP) may be missing.');
    }
    console.log('[YaneuraOu Worker] SharedArrayBuffer available');

    const hasSIMD = await detectSIMDSupport();
    const variant = hasSIMD ? 'sse42' : 'nosimd';
    console.log('[YaneuraOu Worker] Using variant:', variant);

    // Import the YaneuraOu module
    // Use absolute path from origin
    const scriptPath = `/yaneuraou/${variant}/yaneuraou.js`;
    const basePath = `/yaneuraou/${variant}/`;
    console.log('[YaneuraOu Worker] Loading script:', scriptPath);
    console.log('[YaneuraOu Worker] Base path for WASM:', basePath);

    try {
        importScripts(scriptPath);
        console.log('[YaneuraOu Worker] Script loaded successfully');
    } catch (e) {
        throw new Error(`Failed to load YaneuraOu script: ${e.message}`);
    }

    // Get the factory function name
    const factoryName = hasSIMD ? 'YaneuraOu_sse42' : 'YaneuraOu_nosimd';
    const factory = self[factoryName];

    if (!factory) {
        // List available globals for debugging
        const availableFns = Object.keys(self).filter(k => k.includes('YaneuraOu'));
        throw new Error(`YaneuraOu factory function ${factoryName} not found. Available: ${availableFns.join(', ')}`);
    }

    console.log('[YaneuraOu Worker] Calling factory function with locateFile...');

    // Pass Module configuration to factory function
    // This tells Emscripten where to find the WASM and worker files
    engine = await factory({
        locateFile: function (path) {
            console.log('[YaneuraOu Worker] locateFile called for:', path);
            return basePath + path;
        },
        // Required for pthread workers to know where the main script is
        mainScriptUrlOrBlob: scriptPath
    });
    console.log('[YaneuraOu Worker] Factory returned engine');

    // Set up message listener for USI responses
    engine.addMessageListener((line) => {
        handleEngineMessage(line);
    });

    // Initialize USI protocol
    return new Promise((resolve, reject) => {
        initPromiseResolve = resolve;

        // Timeout after 30 seconds
        setTimeout(() => {
            if (!engineReady) {
                reject(new Error('Engine initialization timeout'));
            }
        }, 30000);

        console.log('[YaneuraOu Worker] Sending USI command...');
        engine.postMessage('usi');
    });
}

// Handle messages from YaneuraOu engine
function handleEngineMessage(line) {
    console.log('[YaneuraOu]', line);

    if (line === 'usiok') {
        // Engine initialized, configure options
        console.log('[YaneuraOu Worker] Received usiok, configuring options...');
        engine.postMessage('setoption name Threads value 1');
        engine.postMessage('setoption name USI_Hash value 16');
        engine.postMessage('isready');
    } else if (line === 'readyok') {
        console.log('[YaneuraOu Worker] Engine ready!');
        engineReady = true;
        if (initPromiseResolve) {
            initPromiseResolve();
            initPromiseResolve = null;
        }
    } else if (line.startsWith('bestmove')) {
        // Parse bestmove response
        const parts = line.split(' ');
        const moveStr = parts[1];
        console.log('[YaneuraOu Worker] Best move received:', moveStr);

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
// USI format: "7g7f" (normal move) or "G*5b" (drop)
function parseUSIMove(usiMove) {
    if (!usiMove || usiMove.length < 4) return null;

    // Check if it's a drop move (e.g., "G*5b")
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

    // Build board string
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

    // Current player
    const turnStr = currentPlayer === 'sente' ? 'b' : 'w';

    // Build hand string
    let handStr = '';
    const handOrder = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'];
    const handPieceToSFEN = {
        'HI': 'R', 'KA': 'B', 'KI': 'G', 'GI': 'S',
        'KE': 'N', 'KY': 'L', 'FU': 'P'
    };

    // Sente's hand (uppercase)
    for (const pieceType of handOrder) {
        const count = capturedPieces['sente']?.[pieceType] || 0;
        if (count > 0) {
            if (count > 1) handStr += count;
            handStr += handPieceToSFEN[pieceType];
        }
    }

    // Gote's hand (lowercase)
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

// Get best move from YaneuraOu
async function getBestMove(board, capturedPieces, currentPlayer, difficulty) {
    if (!engineReady) {
        console.log('[YaneuraOu Worker] Engine not ready, initializing...');
        await initEngine();
    }

    const sfen = boardToSFEN(board, capturedPieces, currentPlayer);
    console.log('[YaneuraOu Worker] SFEN:', sfen);
    console.log('[YaneuraOu Worker] Difficulty:', difficulty);

    // Configure search parameters based on difficulty
    let searchCommand;
    switch (difficulty) {
        case 'great':
            // 偉人級: moderate strength
            searchCommand = 'go nodes 10000';
            break;
        case 'transcendent':
            // 超越級: strong
            searchCommand = 'go nodes 50000';
            break;
        case 'legendary':
            // 伝説級: very strong
            searchCommand = 'go nodes 200000';
            break;
        default:
            searchCommand = 'go nodes 10000';
    }

    console.log('[YaneuraOu Worker] Search command:', searchCommand);

    return new Promise((resolve) => {
        pendingResolve = resolve;
        engine.postMessage(`position sfen ${sfen}`);
        engine.postMessage(searchCommand);
    });
}

// Message handler
self.onmessage = async function (e) {
    const { type, data } = e.data;
    console.log('[YaneuraOu Worker] Received message:', type);

    if (type === 'init') {
        try {
            await initEngine();
            self.postMessage({ type: 'ready' });
        } catch (error) {
            console.error('[YaneuraOu Worker] Init error:', error);
            initError = error.message;
            self.postMessage({ type: 'error', error: error.message });
        }
    } else if (type === 'getBestMove') {
        const { board, capturedPieces, currentPlayer, aiDifficulty } = data;

        const thinkingStartTime = performance.now();

        try {
            // Check if there was an init error
            if (initError) {
                throw new Error('Engine failed to initialize: ' + initError);
            }

            const move = await getBestMove(board, capturedPieces, currentPlayer, aiDifficulty);
            const thinkingTime = performance.now() - thinkingStartTime;

            console.log('[YaneuraOu Worker] Move found:', move, 'Time:', thinkingTime.toFixed(0), 'ms');

            self.postMessage({
                type: 'bestMove',
                data: {
                    move,
                    thinkingTime,
                    engine: 'yaneuraou'
                }
            });
        } catch (error) {
            console.error('[YaneuraOu Worker] getBestMove error:', error);
            self.postMessage({
                type: 'error',
                error: error.message
            });
        }
    }
};

console.log('[YaneuraOu Worker] Worker script loaded');
