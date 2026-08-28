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
let engineInitPromise = null;

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

// SIMD判定は1度だけ。prefetch と initEngine が同じ答えを使う。
let variantPromise = null;

function resolveVariant() {
    if (!variantPromise) {
        variantPromise = detectSIMDSupport().then((hasSIMD) => {
            const variant = hasSIMD ? 'sse42' : 'nosimd';
            // 待たない。掃除が終わる前に読み込みが始まっても、消す対象は
            // 「今使う側以外」だけなので取り合いにならない。
            dropUnusedCachedAssets(variant);
            return variant;
        });
    }
    return variantPromise;
}

function assetUrl(variant, file) {
    return `/yaneuraou/${variant}/yaneuraou.${file}?${WASM_VERSION}`;
}

// 以前は Service Worker が sse42 と nosimd を両方先読みしていたので、既存ユーザーの
// キャッシュには一度も読まない 1.4MB が残っている。今使う側だけ残して回収する。
// 古い WASM_VERSION の置き土産もここで一緒に落ちる。
async function dropUnusedCachedAssets(variant) {
    if (typeof caches === 'undefined') return;

    // '/yaneuraou-worker.<hash>.js' は '/yaneuraou/' で始まらないので巻き込まない
    const keepPrefix = `/yaneuraou/${variant}/`;
    const keepSearch = `?${WASM_VERSION}`;

    try {
        for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            for (const request of await cache.keys()) {
                const url = new URL(request.url);
                if (!url.pathname.startsWith('/yaneuraou/')) continue;
                if (url.pathname.startsWith(keepPrefix) && url.search === keepSearch) continue;
                await cache.delete(request);
            }
        }
    } catch (e) {
        // 掃除に失敗しても実害は無い（古い分が残るだけ）
    }
}

// アイドル時に呼ばれる。ダウンロードしてキャッシュに載せるところまでで止める。
// importScripts も instantiate もしないので、72MB のWASMメモリ確保も評価テーブルの
// 初期化も走らない（それは達人級以上が選ばれてから initEngine が行う）。
let prefetchPromise = null;

// プリフェッチの完了を initEngine が待つ上限。
// 落とすのは約1.4MBで、遅い3G（400kbps程度）だと正常でも30秒近くかかる。
// 短くすると「まだ落としている最中なのに見切って、同じ1.4MBをもう一度取りに行く」形になり、
// 一番細い回線の人に一番重い罰を与えることになるので、そこを跨げる長さにしてある
// （shogi.js の AI_WATCHDOG_MS と同じ60秒）。
const PREFETCH_WAIT_MS = 60000;

function prefetchAssets() {
    if (engineReady || engineInitPromise) return Promise.resolve();
    if (prefetchPromise) return prefetchPromise;

    prefetchPromise = (async () => {
        const variant = await resolveVariant();
        await Promise.all(['js', 'wasm'].map(async (file) => {
            const response = await fetch(assetUrl(variant, file), { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`prefetch failed: ${response.status}`);
            // 本文を読み切るまで Service Worker 側のキャッシュ書き込みが終わらない
            await response.arrayBuffer();
        }));
    })().catch((error) => {
        // 取り損ねても initEngine が取り直すので、次の機会のために状態だけ戻す
        prefetchPromise = null;
        throw error;
    });

    return prefetchPromise;
}

async function initEngine() {
    if (engineReady) {
        return;
    }

    if (engineInitPromise) {
        return engineInitPromise;
    }

    engineInitPromise = (async () => {
        const variant = await resolveVariant();

        // アイドル時のプリフェッチがまだ飛んでいるなら、それを待ってから読み込む。
        // 遅い回線で「選んだ瞬間」に起動を始めると、同じ1.4MBを二重に取りに行くため。
        // 失敗していても下でそのまま取り直すので、結果は見ない。
        // 待つのは PREFETCH_WAIT_MS まで。fetch はタイムアウトを持たないので、
        // 上限を切らないと「readyもerrorも返らない無言のハング」になり、
        // このあと指し手を頼んでも手番が止まったままになる。
        if (prefetchPromise) {
            await Promise.race([
                prefetchPromise.catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, PREFETCH_WAIT_MS))
            ]);
        }

        const scriptPath = assetUrl(variant, 'js');
        const basePath = `/yaneuraou/${variant}/`;

        try {
            importScripts(scriptPath);
        } catch (e) {
            throw new Error(`Failed to load YaneuraOu script: ${e.message}`);
        }

        const factoryName = variant === 'sse42' ? 'YaneuraOu_sse42' : 'YaneuraOu_nosimd';
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
            initPromiseResolve = () => {
                engineInitPromise = null;
                resolve();
            };

            setTimeout(() => {
                if (!engineReady) {
                    engineInitPromise = null;
                    reject(new Error('Engine initialization timeout'));
                }
            }, 120000);

            engine.postMessage('usi');
        });
    })();

    try {
        await engineInitPromise;
    } catch (error) {
        engineInitPromise = null;
        throw error;
    }
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
    'master': { nodes: 5000 },
    'great': { nodes: 10000 },
    'transcendent': { nodes: 30000 },
    'legendary1': { nodes: 90000 },
    'legendary2': { nodes: 300000 },
    'legendary3': { nodes: 1000000 }
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

    if (type === 'prefetch') {
        // 失敗しても知らせない。ダウンロードの前倒しでしかなく、
        // 実際に必要になった時点で initEngine が取り直す。
        try {
            await prefetchAssets();
        } catch (error) {
            // ignore
        }
    } else if (type === 'init') {
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
