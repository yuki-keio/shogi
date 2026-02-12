// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab

const boardElement = document.getElementById('shogi-board');
const capturedWhiteElement = document.getElementById('captured-white').querySelector('.pieces-container');
const capturedBlackElement = document.getElementById('captured-black').querySelector('.pieces-container');
const currentTurnElement = document.getElementById('current-turn');
const moveCountElement = document.getElementById('move-count');
const messageElement = document.getElementById('message');
const messageArea = document.getElementById('message-area');
const promoteDialog = document.getElementById('promote-dialog');
const promoteYesButton = document.getElementById('promote-yes');
const promoteNoButton = document.getElementById('promote-no');
const resetButton = document.getElementById('reset-button');
const aiThinkingIndicator = document.getElementById('ai-thinking-indicator');

// AI Workerの初期化
let aiWorker = null;
let yaneuraouWorker = null;
let yaneuraouReady = false;

// AI思考リクエストの管理（古い思考結果を無視するため）
let aiRequestId = 0;

function isYaneuraouDifficulty(difficulty) {
    return ['great', 'transcendent', 'legendary1', 'legendary2', 'legendary3'].includes(difficulty);
}

// AI思考中インジケータの表示/非表示
function showAIThinkingIndicator() {
    if (aiThinkingIndicator) {
        aiThinkingIndicator.classList.add('visible');
    }
}

function hideAIThinkingIndicator() {
    if (aiThinkingIndicator) {
        aiThinkingIndicator.classList.remove('visible');
    }
}

if (window.Worker) {
    aiWorker = new Worker('ai-worker.js');
    aiWorker.onmessage = function (e) {
        const { type, data } = e.data;
        if (type === 'bestMove') {
            hideAIThinkingIndicator();

            // リクエストIDをチェックして古い思考結果を無視
            if (data.requestId !== undefined && data.requestId !== aiRequestId) {
                console.log('Ignoring outdated AI response (requestId mismatch)');
                return;
            }

            const { move, currentJosekiPattern: newPattern, josekiMoveIndex: newIndex } = data;
            currentJosekiPattern = newPattern;
            josekiMoveIndex = newIndex;

            if (move) {
                executeAIMove(move);
            } else {
                // 合法手がない場合（詰み）
                gameOver = true;
                const winner = currentPlayer === SENTE ? '後手' : '先手';
                messageElement.textContent = `${winner}の勝ちです`;
                messageArea.style.display = 'block';
                updateHistoryButtons();
                showGameOverDialog(winner, '詰み');
            }
        }
    };

    // YaneuraOu WASM Worker（高レベルAI用）
    try {
        yaneuraouWorker = new Worker('yaneuraou-worker.js');
        yaneuraouWorker.onmessage = function (e) {
            const { type, data, error } = e.data;
            if (type === 'ready') {
                yaneuraouReady = true;
                console.log('YaneuraOu WASM initialized');
            } else if (type === 'bestMove') {
                hideAIThinkingIndicator();

                // リクエストIDをチェックして古い思考結果を無視
                if (data.requestId !== undefined && data.requestId !== aiRequestId) {
                    console.log('Ignoring outdated YaneuraOu response (requestId mismatch)');
                    return;
                }

                const { move } = data;
                if (move) {
                    executeAIMove(move);
                } else {
                    // 合法手がない場合（詰み）
                    gameOver = true;
                    const winner = currentPlayer === SENTE ? '後手' : '先手';
                    messageElement.textContent = `${winner}の勝ちです`;
                    messageArea.style.display = 'block';
                    updateHistoryButtons();
                    showGameOverDialog(winner, '詰み');
                }
            } else if (type === 'error') {
                console.error('YaneuraOu error:', error);
                // フォールバック: 通常のAIワーカーを使用
                if (aiWorker) {
                    aiWorker.postMessage({
                        type: 'getBestMove',
                        data: {
                            board,
                            capturedPieces,
                            currentPlayer,
                            moveCount,
                            lastMoveDetail,
                            aiDifficulty: 'great', // 最高レベルにフォールバック
                            aiPlayer: getAIPlayer(),
                            josekiEnabled,
                            currentJosekiPattern,
                            josekiMoveIndex
                        }
                    });
                }
            }
        };
        yaneuraouWorker.onerror = function (error) {
            console.error('YaneuraOu Worker error:', error.message, error.filename, error.lineno);
            hideAIThinkingIndicator();
            yaneuraouWorker = null; // Disable yaneuraou worker
        };

        // YaneuraOuの事前初期化（バックグラウンドで）
        yaneuraouWorker.postMessage({ type: 'init' });
    } catch (e) {
        console.error('Failed to create YaneuraOu worker:', e);
        yaneuraouWorker = null;
    }
}

// ゲーム終了ダイアログの要素
const gameOverDialog = document.getElementById('game-over-dialog');
const gameResultTitle = document.getElementById('game-result-title');
const gameResultMessage = document.getElementById('game-result-message');
const victoryCelebration = document.getElementById('victory-celebration');
const shareTwitterButton = document.getElementById('share-twitter');
const shareFacebookButton = document.getElementById('share-facebook');
const shareLineButton = document.getElementById('share-line');
const copyLinkButton = document.getElementById('copy-link');
const newGameButton = document.getElementById('new-game-button');
const closeGameOverButton = document.getElementById('close-game-over');

// AI関連の要素
const modeTabs = document.querySelectorAll('.mode-tab');
const aiSettingsElement = document.getElementById('ai-settings');
const difficultySelect = document.getElementById('difficulty');

// 通信対戦関連の要素
const onlineSettingsElement = document.getElementById('online-settings');
const onlineCreateRoomButton = document.getElementById('online-create-room');
const onlineCopyInviteButton = document.getElementById('online-copy-invite');
const onlineInviteUrlElement = document.getElementById('online-invite-url');
const onlineStatusElement = document.getElementById('online-status');

// 設定関連の要素
const pieceDisplayModeRadios = document.querySelectorAll('input[name="piece-display-mode"]');
const playerSideRadios = document.querySelectorAll('input[name="player-side"]');
const settingsIconButton = document.getElementById('settings-icon');
const advancedSettingsSection = document.getElementById('advanced-settings');
const resignButton = document.getElementById('resign-button');


// 定石を適用するかどうかのフラグ
let josekiEnabled = true;
let currentJosekiPattern = null;
let josekiMoveIndex = 0;

const SENTE = 'sente'; // 先手
const GOTE = 'gote'; // 後手

// 玉位置キャッシュ（探索高速化用）
// board を直接置き換える箇所では recomputeKingPosCache() を呼ぶこと。
let kingPosCache = {
    [SENTE]: null,
    [GOTE]: null
};

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

// ゲームモード
let gameMode = 'ai'; // 'ai' | 'pvp' | 'online'
let aiDifficulty = 'medium'; // 'easy', 'medium', 'hard', 'super', 'master', 'great', 'transcendent', 'legendary1', 'legendary2', 'legendary3'
let playerSide = SENTE; // プレイヤーが担当する手番

// 駒の表示モード
let pieceDisplayMode = 'text'; // 'text' or 'image'

// --- 通信対戦 (online) ---
const ONLINE_MODE = 'online';

// Note: These are public client keys (Publishable / Anon). Never put Service Role keys in the frontend.
const ONLINE_SUPABASE_URL = 'https://nwllabwgobdjoxeufcok.supabase.co';
const ONLINE_SUPABASE_KEY = 'sb_publishable_DB1zZqBrfZIV90wCraeHRg_DIxky3Nm';
const ONLINE_HEARTBEAT_INTERVAL_MS = 15000;

const onlineState = {
    roomCode: null,
    match: null,
    userId: null,
    side: null, // 'sente' | 'gote'
    appliedRevision: -1,
    channel: null,
    heartbeatTimer: null,
    // Incremented whenever we leave a room (or otherwise invalidate online async work).
    // Used to ignore stale heartbeat/get-match/realtime updates that can arrive after a room switch.
    roomEpoch: 0,
    submitting: false,
    lastUsiLen: 0,
    lastGameOverRevisionShown: null,
    matchStartShown: false,
    // Optimistic UI: snapshot of board state before an optimistic move, for rollback if server rejects.
    optimisticSnapshot: null,
};

let onlineSupabasePromise = null;

function isOnlineMode() {
    return gameMode === ONLINE_MODE;
}

function setOnlineStatus(text) {
    if (!onlineStatusElement) return;
    onlineStatusElement.textContent = text || '';
}

function getInviteUrl(roomCode) {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', ONLINE_MODE);
    url.searchParams.set('room', roomCode);
    return url.toString();
}

function updateOnlineInviteUI() {
    const wrapper = document.getElementById('online-invite-url-wrapper');
    if (!onlineCreateRoomButton || !onlineCopyInviteButton || !onlineInviteUrlElement || !wrapper) return;

    if (onlineState.roomCode) {
        const inviteUrl = getInviteUrl(onlineState.roomCode);
        onlineInviteUrlElement.value = inviteUrl;
        wrapper.style.display = 'flex';
    } else {
        onlineInviteUrlElement.value = '';
        wrapper.style.display = 'none';
    }
}

async function getOnlineSupabase() {
    if (onlineSupabasePromise) return onlineSupabasePromise;
    onlineSupabasePromise = (async () => {
        const mod = await import('https://esm.sh/@supabase/supabase-js@2');
        const client = mod.createClient(ONLINE_SUPABASE_URL, ONLINE_SUPABASE_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
        return client;
    })().catch(err => {
        onlineSupabasePromise = null;
        throw err;
    });
    return onlineSupabasePromise;
}

async function ensureOnlineAuth() {
    const supabase = await getOnlineSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const sessionUser = sessionData?.session?.user;
    if (sessionUser?.id) {
        onlineState.userId = sessionUser.id;
        return sessionUser;
    }

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    onlineState.userId = data?.user?.id || null;
    return data?.user;
}

async function onlineInvoke(functionName, body) {
    const supabase = await getOnlineSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token || null;
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

    const { data, error } = await supabase.functions.invoke(functionName, { body, headers });
    if (!error) return data;

    // supabase-js v2 FunctionsHttpError stores the Response directly in error.context (not error.context.response).
    const resp = (error?.context instanceof Response) ? error.context
        : (error?.context?.response instanceof Response) ? error.context.response
            : null;

    if (resp) {
        try {
            const json = await resp.clone().json().catch(() => null);
            if (json) return json;
        } catch (_) { /* ignore */ }
    }

    throw error;
}

function stopOnlineRealtime() {
    const ch = onlineState.channel;
    if (!ch) return;
    onlineState.channel = null;
    getOnlineSupabase().then(supabase => {
        try {
            supabase.removeChannel(ch);
        } catch (e) {
            // ignore
        }
    });
}

function stopOnlineHeartbeat() {
    if (onlineState.heartbeatTimer) {
        clearInterval(onlineState.heartbeatTimer);
        onlineState.heartbeatTimer = null;
    }
}

async function onlineSubscribe(roomCode) {
    const supabase = await getOnlineSupabase();
    stopOnlineRealtime();

    const epoch = onlineState.roomEpoch;
    const channel = supabase.channel(`online-match:${roomCode}`);
    channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'online_matches', filter: `room_code=eq.${roomCode}` },
        (payload) => {
            if (!payload?.new) return;
            applyOnlineMatch(payload.new, { source: 'realtime', roomEpoch: epoch, expectedRoomCode: roomCode });
        }
    );

    await new Promise((resolve, reject) => {
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') resolve();
            if (status === 'CHANNEL_ERROR') reject(new Error('realtime_channel_error'));
        });
    });

    // If we left/switched rooms while subscribing, immediately dispose this channel.
    if (onlineState.roomEpoch !== epoch) {
        try {
            supabase.removeChannel(channel);
        } catch (e) {
            // ignore
        }
        return;
    }

    onlineState.channel = channel;
}

async function onlineHeartbeatOnce() {
    const roomCode = onlineState.roomCode;
    const epoch = onlineState.roomEpoch;
    if (!roomCode) return;
    try {
        const res = await onlineInvoke('heartbeat', { roomCode });
        // Ignore stale results if we left/switched rooms while awaiting the request.
        if (onlineState.roomEpoch !== epoch || onlineState.roomCode !== roomCode) return;
        if (res?.ok && res.match) {
            applyOnlineMatch(res.match, { source: 'heartbeat', roomEpoch: epoch, expectedRoomCode: roomCode });
        } else if (res?.ok === false && res?.error?.code === 'not_found') {
            // Room expired/deleted. Stop polling/realtime to avoid repeated 404 load.
            await onlineLeaveRoom({ resignIfActive: false });
            alert('部屋の有効期限が切れました。');
        }
    } catch (e) {
        // Heartbeat errors are non-fatal; user may be temporarily offline.
    }
}

function startOnlineHeartbeat() {
    stopOnlineHeartbeat();
    onlineState.heartbeatTimer = setInterval(() => {
        onlineHeartbeatOnce();
    }, ONLINE_HEARTBEAT_INTERVAL_MS);
    onlineHeartbeatOnce();
}

function setUrlRoom(roomCodeOrNull) {
    const url = new URL(window.location.href);
    if (roomCodeOrNull) {
        url.searchParams.set('room', roomCodeOrNull);
    } else {
        url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
}

function updateOnlineRoleFromMatch(match) {
    if (!match || !onlineState.userId) {
        onlineState.side = null;
        return;
    }
    if (match.sente_uid === onlineState.userId) onlineState.side = SENTE;
    else if (match.gote_uid === onlineState.userId) onlineState.side = GOTE;
    else onlineState.side = null;
}

function playMoveSoundIfNeeded(prevUsiLen, nextUsiLen) {
    if (typeof piecePlacementSound === 'undefined') return;
    if (nextUsiLen > prevUsiLen) {
        piecePlacementSound.currentTime = 0;
        piecePlacementSound.play().catch(() => { });
    }
}

function applyOnlineMatch(match, { source, roomEpoch, expectedRoomCode } = {}) {
    if (!match) return;
    if (!isOnlineMode()) return;

    // Ignore stale async results (e.g. heartbeat/get-match/realtime) that arrive after leaving a room.
    if (typeof roomEpoch === 'number' && roomEpoch !== onlineState.roomEpoch) {
        return;
    }

    // Never allow a different room's update to overwrite the current room state.
    const matchRoom = match.room_code || null;
    const expectedRoom = expectedRoomCode || onlineState.roomCode || null;
    if (expectedRoom && matchRoom && matchRoom !== expectedRoom) {
        return;
    }

    onlineState.match = match;
    if (!onlineState.roomCode && matchRoom) onlineState.roomCode = matchRoom;
    updateOnlineRoleFromMatch(match);

    const nextRevision = typeof match.revision === 'number' ? match.revision : 0;
    const state = match.state || null;

    // If we have a pending optimistic move and a non-submit-move update arrives
    // (e.g. realtime from opponent, heartbeat), we should clear the optimistic state
    // because the authoritative state will overwrite it.
    if (onlineState.optimisticSnapshot && source !== 'submit-move' && state && nextRevision !== onlineState.appliedRevision) {
        onlineState.optimisticSnapshot = null;
    }

    // Update board only when the authoritative revision changes.
    if (state && nextRevision !== onlineState.appliedRevision) {
        const prevUsiLen = onlineState.lastUsiLen || 0;
        const nextUsiLen = Array.isArray(state.usiMoveHistory) ? state.usiMoveHistory.length : 0;

        // If we have an optimistic snapshot and the server confirmed (source === 'submit-move'),
        // the board is already visually up-to-date. Just sync authoritative metadata.
        const wasOptimistic = Boolean(onlineState.optimisticSnapshot) && source === 'submit-move';
        onlineState.optimisticSnapshot = null;

        board = deepCopyBoard(state.board || board);
        capturedPieces = deepCopyCaptured(state.capturedPieces || capturedPieces);
        currentPlayer = state.currentPlayer || currentPlayer;
        moveCount = typeof state.moveCount === 'number' ? state.moveCount : moveCount;
        lastMove = state.lastMove || null;
        isCheck = Boolean(state.isCheck);
        gameOver = Boolean(match.game_over);

        recomputeKingPosCache();

        // Online: side is fixed by match assignment.
        if (onlineState.side === SENTE || onlineState.side === GOTE) {
            playerSide = onlineState.side;
            applyBoardOrientation();
            updatePlayerSideRadios(playerSide);
        }

        selectedPiece = null;
        validMoves = [];

        // Check/turn messages
        if (!gameOver && isCheck) {
            messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
            messageArea.style.display = 'block';
        } else if (!gameOver) {
            messageElement.textContent = '';
            messageArea.style.display = 'none';
        }

        if (!wasOptimistic) {
            // Only re-render if this is NOT a confirmation of our own optimistic move.
            renderBoard();
            renderCapturedPieces();
            updateInfo();
        }
        updateHistoryButtons();

        if (!wasOptimistic) {
            playMoveSoundIfNeeded(prevUsiLen, nextUsiLen);
        }

        onlineState.appliedRevision = nextRevision;
        onlineState.lastUsiLen = nextUsiLen;
    } else {
        // Even if revision didn't change (heartbeat), reflect gameOver state.
        gameOver = Boolean(match.game_over);
    }

    updateOnlineInviteUI();
    updateOnlineUiState();

    // 対戦開始オーバーレイ（両者揃った瞬間に1回だけ表示）
    if (match.gote_uid && onlineState.side && !onlineState.matchStartShown && !match.game_over) {
        onlineState.matchStartShown = true;
        showMatchStartOverlay(onlineState.side);
        // 対局開始音を再生
        if (typeof playerJoinSound !== 'undefined') {
            playerJoinSound.currentTime = 0;
            playerJoinSound.play().catch(() => { });
        }
    }

    if (match.game_over && onlineState.lastGameOverRevisionShown !== nextRevision) {
        onlineState.lastGameOverRevisionShown = nextRevision;
        showOnlineGameOver(match);
    }
}

function mapResultReason(reason) {
    switch (reason) {
        case 'checkmate': return '詰み';
        case 'sennichite': return '千日手';
        case 'perpetual_check': return '連続王手の千日手';
        case 'resign': return '投了';
        case 'disconnect': return '切断';
        default: return '終局';
    }
}

function showOnlineGameOver(match) {
    const winner = match.winner;
    const reason = mapResultReason(match.result_reason);
    if (winner === 'draw') {
        showGameOverDialog('引き分け', reason);
        return;
    }
    if (winner === SENTE) {
        showGameOverDialog('先手', reason);
        return;
    }
    if (winner === GOTE) {
        showGameOverDialog('後手', reason);
        return;
    }
    showGameOverDialog('引き分け', reason);
}

function updateOnlineUiState() {
    if (!onlineSettingsElement || !resignButton) return;

    const matchStarted = Boolean(onlineState.match?.gote_uid);
    const matchActive = matchStarted && !onlineState.match?.game_over;

    // Board cursor – show not-allowed cursor before the match starts in online mode.
    boardElement.classList.toggle('online-waiting', isOnlineMode() && !matchStarted);

    // Settings visibility – hide the entire panel once both players have joined.
    // It stays hidden even after game_over; it reappears when the user leaves the room.
    if (isOnlineMode() && !matchStarted) {
        onlineSettingsElement.style.display = 'block';
    } else {
        onlineSettingsElement.style.display = 'none';
    }

    // Hide create-room button once a room has been created (invite URL is shown instead)
    if (onlineCreateRoomButton) {
        onlineCreateRoomButton.style.display = onlineState.roomCode ? 'none' : '';
    }

    // Resign button only when a game is active (both joined and not ended)
    resignButton.style.display = (isOnlineMode() && matchActive) ? 'inline-block' : 'none';

    // Disable side selection in online mode (side is assigned by room).
    playerSideRadios.forEach(r => { r.disabled = isOnlineMode(); });

    // Reset button is not used in online mode.
    if (resetButton) {
        if (isOnlineMode()) {
            resetButton.style.display = 'none';
        } else {
            resetButton.style.display = '';
            resetButton.textContent = '新規対局';
        }
    }

    // Online status text
    if (isOnlineMode()) {
        const match = onlineState.match;
        if (!onlineState.roomCode) {
            setOnlineStatus('対戦部屋を作成し、特定の相手を招待できます。');
        } else if (match && !match.gote_uid) {
            setOnlineStatus('招待URLをコピーし、相手に共有してください（招待された側が後手になります）');
        } else if (match && onlineState.side && !match.game_over) {
            const mySideJa = onlineState.side === SENTE ? '先手' : '後手';
            const turnJa = (currentPlayer === onlineState.side) ? 'あなたの手番です。' : '相手の手番です。';
            let extra = '';
            if (match.disconnect_side && match.disconnect_deadline) {
                const deadlineMs = Date.parse(match.disconnect_deadline);
                const remainSec = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
                const sideJa = match.disconnect_side === SENTE ? '先手' : '後手';
                const subject = (onlineState.side && match.disconnect_side === onlineState.side) ? 'あなた' : '相手';
                extra = `（${subject}(${sideJa})が切断中: 残り${remainSec}秒）`;
            }
            setOnlineStatus(`${mySideJa}として参加中。${turnJa} ${extra}`.trim());
        }
    }
}

async function onlineCreateRoom() {
    if (onlineState.submitting) return;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;
    try {
        setOnlineStatus('接続中…');
        onlineCreateRoomButton.disabled = true;
        onlineCreateRoomButton.classList.add('connecting');
        await ensureOnlineAuth();
        const res = await onlineInvoke('create-room', { displayName: null });
        if (onlineState.roomEpoch !== epoch) return;
        if (!res?.ok || !res.match) throw new Error('create_room_failed');
        setUrlRoom(res.match.room_code);
        await onlineSubscribe(res.match.room_code);
        if (onlineState.roomEpoch !== epoch) return;
        startOnlineHeartbeat();
        applyOnlineMatch(res.match, { source: 'create', roomEpoch: epoch, expectedRoomCode: res.match.room_code });
    } catch (e) {
        console.error('onlineCreateRoom failed:', e);
        alert('部屋作成に失敗しました。通信状況を確認して再試行してください。');
    } finally {
        onlineState.submitting = false;
        // Button visibility is managed by updateOnlineUiState; re-enable in case of error.
        if (onlineCreateRoomButton) {
            onlineCreateRoomButton.disabled = false;
            onlineCreateRoomButton.classList.remove('connecting');
        }
    }
}

async function onlineJoinRoom(roomCode) {
    if (onlineState.submitting) return;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;
    try {
        setOnlineStatus('接続中…');
        if (onlineCreateRoomButton) {
            onlineCreateRoomButton.disabled = true;
            onlineCreateRoomButton.classList.add('connecting');
        }
        await ensureOnlineAuth();
        const res = await onlineInvoke('join-room', { roomCode, displayName: null });
        if (onlineState.roomEpoch !== epoch) return;
        if (!res?.ok || !res.match) throw new Error('join_room_failed');
        setUrlRoom(res.match.room_code);
        await onlineSubscribe(res.match.room_code);
        if (onlineState.roomEpoch !== epoch) return;
        startOnlineHeartbeat();
        applyOnlineMatch(res.match, { source: 'join', roomEpoch: epoch, expectedRoomCode: res.match.room_code });

        // Ensure we have the latest state (fallback for realtime delays).
        const latest = await onlineInvoke('get-match', { roomCode: res.match.room_code });
        if (onlineState.roomEpoch !== epoch) return;
        if (latest?.ok && latest.match) {
            applyOnlineMatch(latest.match, { source: 'get-match', roomEpoch: epoch, expectedRoomCode: res.match.room_code });
        }
    } catch (e) {
        console.error('onlineJoinRoom failed:', e);
        alert('参加に失敗しました。URLが正しいか確認してください。');
    } finally {
        onlineState.submitting = false;
        // Button visibility is managed by updateOnlineUiState; re-enable in case of error.
        if (onlineCreateRoomButton) {
            onlineCreateRoomButton.disabled = false;
            onlineCreateRoomButton.classList.remove('connecting');
        }
    }
}

/**
 * Apply a move optimistically on the client side for immediate visual feedback.
 * Saves a snapshot of the current board state so we can roll back if the server rejects.
 */
function applyOptimisticMove(move) {
    // Save snapshot for rollback
    onlineState.optimisticSnapshot = {
        board: deepCopyBoard(board),
        capturedPieces: deepCopyCaptured(capturedPieces),
        currentPlayer,
        moveCount,
        lastMove,
        isCheck,
        gameOver,
        lastUsiLen: onlineState.lastUsiLen,
    };

    if (move.type === 'move') {
        const { fromX, fromY, toX, toY, promote } = move;
        const movingPiece = { ...board[fromY][fromX] };
        const captured = board[toY][toX];

        // Apply promotion
        if (promote && pieceInfo[movingPiece.type]?.canPromote) {
            movingPiece.type = pieceInfo[movingPiece.type].promoted;
        }

        // Update board
        board[toY][toX] = movingPiece;
        board[fromY][fromX] = null;

        // Update king cache
        if (movingPiece.type === KING) {
            kingPosCache[movingPiece.owner] = { x: toX, y: toY };
        }

        lastMove = { x: toX, y: toY };

        // Handle capture
        if (captured) {
            let capturedType = captured.type;
            if (pieceInfo[capturedType]?.base) {
                capturedType = pieceInfo[capturedType].base;
            }
            capturedPieces[currentPlayer][capturedType]++;
        }
    } else if (move.type === 'drop') {
        const { pieceType, toX, toY } = move;
        capturedPieces[currentPlayer][pieceType]--;
        board[toY][toX] = { type: pieceType, owner: currentPlayer };
        lastMove = { x: toX, y: toY };
    }

    // Switch turn
    currentPlayer = (currentPlayer === SENTE) ? GOTE : SENTE;
    moveCount++;

    // Check/check message
    isCheck = isKingInCheck(currentPlayer);
    recomputeKingPosCache();

    if (isCheck) {
        messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
        messageArea.style.display = 'block';
    } else {
        messageElement.textContent = '';
        messageArea.style.display = 'none';
    }

    // Play sound
    piecePlacementSound.currentTime = 0;
    piecePlacementSound.play().catch(() => { });

    selectedPiece = null;
    validMoves = [];
    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateOnlineUiState();
}

/**
 * Roll back an optimistic move by restoring the saved snapshot.
 */
function rollbackOptimisticMove() {
    const snap = onlineState.optimisticSnapshot;
    if (!snap) return;
    board = deepCopyBoard(snap.board);
    capturedPieces = deepCopyCaptured(snap.capturedPieces);
    currentPlayer = snap.currentPlayer;
    moveCount = snap.moveCount;
    lastMove = snap.lastMove;
    isCheck = snap.isCheck;
    gameOver = snap.gameOver;
    onlineState.lastUsiLen = snap.lastUsiLen;
    recomputeKingPosCache();
    onlineState.optimisticSnapshot = null;

    selectedPiece = null;
    validMoves = [];

    if (!gameOver && isCheck) {
        messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
        messageArea.style.display = 'block';
    } else if (!gameOver) {
        messageElement.textContent = '';
        messageArea.style.display = 'none';
    }

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateOnlineUiState();
}

async function onlineSubmitMove(move) {
    if (!onlineState.roomCode || !onlineState.match) return;
    if (onlineState.submitting) return;
    const roomCode = onlineState.roomCode;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;

    // --- Optimistic UI: apply move locally before server round-trip ---
    applyOptimisticMove(move);

    try {
        const expectedRevision = onlineState.match.revision || 0;
        const res = await onlineInvoke('submit-move', {
            roomCode,
            expectedRevision,
            move
        });
        // Ignore stale results if we left/switched rooms while awaiting the request.
        if (onlineState.roomEpoch !== epoch || onlineState.roomCode !== roomCode) {
            onlineState.optimisticSnapshot = null;
            return;
        }
        if (res?.ok === false && res?.error?.code === 'not_found') {
            rollbackOptimisticMove();
            await onlineLeaveRoom({ resignIfActive: false });
            alert('部屋の有効期限が切れました。');
            return;
        }
        if (res?.ok && res.match) {
            // Server confirmed – applyOnlineMatch will detect the optimistic snapshot
            // and skip redundant re-rendering.
            applyOnlineMatch(res.match, { source: 'submit-move', roomEpoch: epoch, expectedRoomCode: roomCode });
        } else {
            // Conflict or rejection: rollback and refresh state.
            rollbackOptimisticMove();
            const latest = res?.match || (await onlineInvoke('get-match', { roomCode }))?.match;
            if (latest) applyOnlineMatch(latest, { source: 'refresh', roomEpoch: epoch, expectedRoomCode: roomCode });
        }
    } catch (e) {
        console.error('onlineSubmitMove failed:', e);
        // Rollback optimistic move on network error.
        rollbackOptimisticMove();
        alert('手の送信に失敗しました。通信状況を確認してください。');
        try {
            const latest = await onlineInvoke('get-match', { roomCode });
            if (latest?.ok && latest.match) {
                applyOnlineMatch(latest.match, { source: 'get-match', roomEpoch: epoch, expectedRoomCode: roomCode });
            }
        } catch (e2) {
            // ignore
        }
    } finally {
        onlineState.submitting = false;
    }
}

async function onlineResign() {
    if (!onlineState.roomCode || !onlineState.match) return;
    if (onlineState.submitting) return;
    const roomCode = onlineState.roomCode;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;
    try {
        const expectedRevision = onlineState.match.revision || 0;
        const res = await onlineInvoke('resign', { roomCode, expectedRevision });
        // Ignore stale results if we left/switched rooms while awaiting the request.
        if (onlineState.roomEpoch !== epoch || onlineState.roomCode !== roomCode) return;
        if (res?.ok === false && res?.error?.code === 'not_found') {
            await onlineLeaveRoom({ resignIfActive: false });
            alert('部屋の有効期限が切れました。');
            return;
        }
        if (res?.ok && res.match) {
            applyOnlineMatch(res.match, { source: 'resign', roomEpoch: epoch, expectedRoomCode: roomCode });
        }
    } catch (e) {
        console.error('onlineResign failed:', e);
        alert('投了に失敗しました。通信状況を確認してください。');
    } finally {
        onlineState.submitting = false;
    }
}

async function onlineLeaveRoom({ resignIfActive = false } = {}) {
    // Invalidate any in-flight online async work for the current room.
    onlineState.roomEpoch += 1;
    try {
        if (resignIfActive && onlineState.match?.gote_uid && !onlineState.match?.game_over) {
            await onlineResign();
        }
    } finally {
        stopOnlineHeartbeat();
        stopOnlineRealtime();
        onlineState.submitting = false;
        onlineState.roomCode = null;
        onlineState.match = null;
        onlineState.side = null;
        onlineState.appliedRevision = -1;
        onlineState.lastUsiLen = 0;
        onlineState.lastGameOverRevisionShown = null;
        onlineState.matchStartShown = false;
        onlineState.optimisticSnapshot = null;
        setUrlRoom(null);
        updateOnlineInviteUI();
        updateOnlineUiState();
        hideGameOverDialog();
        clearSelection();
        initializeBoard();
    }
}

// 画像のキャッシュ（画像モードの場合のみロード）
const pieceImageCache = {};

// 駒の種類 (内部表現)
const KING = 'OU';
const ROOK = 'HI';
const BISHOP = 'KA';
const GOLD = 'KI';
const SILVER = 'GI';
const KNIGHT = 'KE';
const LANCE = 'KY';
const PAWN = 'FU';
// 成り駒
const PROMOTED_ROOK = '+HI'; // 龍
const PROMOTED_BISHOP = '+KA'; // 馬
const PROMOTED_SILVER = '+GI'; // 成銀
const PROMOTED_KNIGHT = '+KE'; // 成桂
const PROMOTED_LANCE = '+KY'; // 成香
const PROMOTED_PAWN = '+FU'; // と金

// 駒の表示名
const pieceNames = {
    [KING]: '玉', [ROOK]: '飛', [BISHOP]: '角', [GOLD]: '金', [SILVER]: '銀', [KNIGHT]: '桂', [LANCE]: '香', [PAWN]: '歩',
    [PROMOTED_ROOK]: '竜', [PROMOTED_BISHOP]: '馬', [PROMOTED_SILVER]: '全', [PROMOTED_KNIGHT]: '圭', [PROMOTED_LANCE]: '杏', [PROMOTED_PAWN]: 'と'
};

// 駒の画像ファイル名マッピング
const pieceImageFiles = {
    [KING]: 'ou.jpg', [ROOK]: 'hi.jpg', [BISHOP]: 'kaku.jpg', [GOLD]: 'kin.jpg',
    [SILVER]: 'gin.jpg', [KNIGHT]: 'kei.jpg', [LANCE]: 'kyo.jpg', [PAWN]: 'fu.jpg',
    [PROMOTED_ROOK]: 'ryu.jpg', [PROMOTED_BISHOP]: 'uma.jpg',
    [PROMOTED_SILVER]: 'narigin.jpg', [PROMOTED_KNIGHT]: 'narikei.jpg',
    [PROMOTED_LANCE]: 'narikyo.jpg', [PROMOTED_PAWN]: 'to.jpg'
};

// 駒の基本情報
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

// ゲーム状態
let board = []; // 9x9の盤面, board[y][x] = { type: 'FU', owner: 'sente' } or null
let capturedPieces = {
    [SENTE]: {}, // { 'FU': 1, 'KY': 0, ... }
    [GOTE]: {}
};
let currentPlayer = SENTE;
let moveCount = 0;
let selectedPiece = null; // { x, y, type, owner } or { owner, type } (持ち駒)
let validMoves = []; // 移動可能なマスのリスト [{x, y}]
let isCheck = false; // 現在王手がかかっているか
let checkmate = false; // 現在詰んでいるか
let gameOver = false;
let promoteMoveInfo = null; // 成り選択中の移動情報 { fromX, fromY, toX, toY, piece }
let lastMove = null; // 最後に打った手の位置 { x, y }
let lastMoveDetail = null; // 最後の手の詳細情報 { fromX, fromY, toX, toY }

// 棋譜関連
let moveHistory = []; // 手の履歴を保存 { board, capturedPieces, currentPlayer, lastMove, moveCount, gameOver, isCheck }
let currentHistoryIndex = -1; // 現在の履歴インデックス
let usiMoveHistory = []; // USI形式の棋譜（moves）を保存

// 千日手判定用
let positionHistory = []; // 局面のハッシュを保存
let checkHistory = []; // 各局面で王手だったかを保存

// --- 初期化 ---
function initializeBoard() {
    // AI思考中の場合はキャンセル（リクエストIDを更新して古い結果を無視）
    aiRequestId++;
    hideAIThinkingIndicator();

    applyBoardOrientation();

    board = Array(9).fill(null).map(() => Array(9).fill(null));
    capturedPieces = { [SENTE]: initCaptured(), [GOTE]: initCaptured() };
    currentPlayer = SENTE;
    moveCount = 0;
    selectedPiece = null;
    validMoves = [];
    isCheck = false;
    checkmate = false;
    gameOver = false;
    lastMove = null;
    lastMoveDetail = null;
    moveHistory = [];
    usiMoveHistory = [];
    currentHistoryIndex = -1;
    positionHistory = [];
    checkHistory = [];
    messageElement.textContent = '';
    messageArea.style.display = 'none';

    // 定石の初期化
    josekiMoveIndex = 0;
    currentJosekiPattern = null;

    // 初期配置 (平手)
    const initialSetup = [
        // 後手 (上段)
        { x: 0, y: 0, type: LANCE, owner: GOTE }, { x: 1, y: 0, type: KNIGHT, owner: GOTE }, { x: 2, y: 0, type: SILVER, owner: GOTE }, { x: 3, y: 0, type: GOLD, owner: GOTE }, { x: 4, y: 0, type: KING, owner: GOTE }, { x: 5, y: 0, type: GOLD, owner: GOTE }, { x: 6, y: 0, type: SILVER, owner: GOTE }, { x: 7, y: 0, type: KNIGHT, owner: GOTE }, { x: 8, y: 0, type: LANCE, owner: GOTE },
        { x: 1, y: 1, type: ROOK, owner: GOTE }, { x: 7, y: 1, type: BISHOP, owner: GOTE },
        { x: 0, y: 2, type: PAWN, owner: GOTE }, { x: 1, y: 2, type: PAWN, owner: GOTE }, { x: 2, y: 2, type: PAWN, owner: GOTE }, { x: 3, y: 2, type: PAWN, owner: GOTE }, { x: 4, y: 2, type: PAWN, owner: GOTE }, { x: 5, y: 2, type: PAWN, owner: GOTE }, { x: 6, y: 2, type: PAWN, owner: GOTE }, { x: 7, y: 2, type: PAWN, owner: GOTE }, { x: 8, y: 2, type: PAWN, owner: GOTE },
        // 先手 (下段)
        { x: 0, y: 6, type: PAWN, owner: SENTE }, { x: 1, y: 6, type: PAWN, owner: SENTE }, { x: 2, y: 6, type: PAWN, owner: SENTE }, { x: 3, y: 6, type: PAWN, owner: SENTE }, { x: 4, y: 6, type: PAWN, owner: SENTE }, { x: 5, y: 6, type: PAWN, owner: SENTE }, { x: 6, y: 6, type: PAWN, owner: SENTE }, { x: 7, y: 6, type: PAWN, owner: SENTE }, { x: 8, y: 6, type: PAWN, owner: SENTE },
        { x: 1, y: 7, type: BISHOP, owner: SENTE }, { x: 7, y: 7, type: ROOK, owner: SENTE },
        { x: 0, y: 8, type: LANCE, owner: SENTE }, { x: 1, y: 8, type: KNIGHT, owner: SENTE }, { x: 2, y: 8, type: SILVER, owner: SENTE }, { x: 3, y: 8, type: GOLD, owner: SENTE }, { x: 4, y: 8, type: KING, owner: SENTE }, { x: 5, y: 8, type: GOLD, owner: SENTE }, { x: 6, y: 8, type: SILVER, owner: SENTE }, { x: 7, y: 8, type: KNIGHT, owner: SENTE }, { x: 8, y: 8, type: LANCE, owner: SENTE },
    ];

    initialSetup.forEach(p => {
        board[p.y][p.x] = { type: p.type, owner: p.owner };
    });

    recomputeKingPosCache();

    // 初期状態を履歴に保存
    saveCurrentState();

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();
    scheduleAIMoveIfNeeded();
}

function initCaptured() {
    const pieces = { [ROOK]: 0, [BISHOP]: 0, [GOLD]: 0, [SILVER]: 0, [KNIGHT]: 0, [LANCE]: 0, [PAWN]: 0 };
    return pieces;
}

// --- 棋譜（履歴）管理 ---
function deepCopyBoard(board) {
    return board.map(row => row.map(cell => cell ? { ...cell } : null));
}

function deepCopyCaptured(captured) {
    return {
        [SENTE]: { ...captured[SENTE] },
        [GOTE]: { ...captured[GOTE] }
    };
}

function toUsiSquare(x, y) {
    const file = 9 - x;
    const rank = String.fromCharCode('a'.charCodeAt(0) + y);
    return `${file}${rank}`;
}

function toUsiMoveString(move) {
    if (!move) return null;

    if (move.type === 'drop') {
        const pieceCharMap = {
            FU: 'P',
            KY: 'L',
            KE: 'N',
            GI: 'S',
            KI: 'G',
            KA: 'B',
            HI: 'R'
        };
        const baseType = move.pieceType?.replace('+', '');
        const pieceChar = pieceCharMap[baseType];
        if (!pieceChar) return null;
        return `${pieceChar}*${toUsiSquare(move.toX, move.toY)}`;
    }

    const from = toUsiSquare(move.fromX, move.fromY);
    const to = toUsiSquare(move.toX, move.toY);
    const promoteSymbol = move.promote ? '+' : '';
    return `${from}${to}${promoteSymbol}`;
}

function getActiveUsiMoves() {
    const usableLength = Math.min(usiMoveHistory.length, Math.max(currentHistoryIndex, 0));
    return usiMoveHistory.slice(0, usableLength);
}

// 局面のハッシュ値を生成（千日手判定用）
function getBoardHash(currentBoard, captured, player) {
    let hash = '';

    // 盤面の状態
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y][x];
            if (piece) {
                hash += `${x}${y}${piece.type}${piece.owner}|`;
            }
        }
    }

    // 持ち駒の状態
    hash += `S:`;
    for (const type in captured[SENTE]) {
        if (captured[SENTE][type] > 0) {
            hash += `${type}${captured[SENTE][type]}|`;
        }
    }
    hash += `G:`;
    for (const type in captured[GOTE]) {
        if (captured[GOTE][type] > 0) {
            hash += `${type}${captured[GOTE][type]}|`;
        }
    }

    // 手番
    hash += `P:${player}`;

    return hash;
}

// 千日手判定
function checkSennichite() {
    const currentHash = getBoardHash(board, capturedPieces, currentPlayer);

    // 同一局面の出現回数をカウント
    let count = 0;
    let consecutiveChecks = 0;
    let firstOccurrenceIndex = -1;

    for (let i = 0; i < positionHistory.length; i++) {
        if (positionHistory[i] === currentHash) {
            count++;
            if (firstOccurrenceIndex === -1) {
                firstOccurrenceIndex = i;
            }
        }
    }

    // 同一局面が4回出現したら千日手
    if (count >= 3) { // 現在の局面を含めて4回目
        // 連続王手の千日手かチェック
        // firstOccurrenceIndexから現在までの間、王手をかけた側が一貫しているか
        let isConsecutiveCheck = true;
        let checkingPlayer = null;

        for (let i = firstOccurrenceIndex; i < positionHistory.length; i++) {
            if (positionHistory[i] === currentHash) {
                // この局面での王手状態をチェック
                const wasCheck = checkHistory[i];
                if (wasCheck) {
                    // 王手をかけたプレイヤー（手番の相手）
                    const checkedPlayer = i < moveHistory.length ? moveHistory[i].currentPlayer : currentPlayer;
                    const playerWhoChecked = checkedPlayer === SENTE ? GOTE : SENTE;

                    if (checkingPlayer === null) {
                        checkingPlayer = playerWhoChecked;
                    } else if (checkingPlayer !== playerWhoChecked) {
                        isConsecutiveCheck = false;
                        break;
                    }
                } else {
                    isConsecutiveCheck = false;
                    break;
                }
            }
        }

        // 現在の局面も王手かチェック
        if (isConsecutiveCheck && !isCheck) {
            isConsecutiveCheck = false;
        }

        return {
            isSennichite: true,
            isConsecutiveCheck: isConsecutiveCheck,
            checkingPlayer: checkingPlayer
        };
    }

    return { isSennichite: false };
}

function saveCurrentState(usiMove = null) {
    // 現在のインデックスより後ろの履歴を削除（分岐を防ぐ）
    moveHistory = moveHistory.slice(0, currentHistoryIndex + 1);
    positionHistory = positionHistory.slice(0, currentHistoryIndex + 1);
    checkHistory = checkHistory.slice(0, currentHistoryIndex + 1);
    const trimmedMovesLength = Math.max(currentHistoryIndex, 0);
    usiMoveHistory = usiMoveHistory.slice(0, trimmedMovesLength);

    // 現在の状態を保存
    const state = {
        board: deepCopyBoard(board),
        capturedPieces: deepCopyCaptured(capturedPieces),
        currentPlayer: currentPlayer,
        lastMove: lastMove ? { ...lastMove } : null,
        moveCount: moveCount,
        gameOver: gameOver,
        isCheck: isCheck
    };

    moveHistory.push(state);

    // 局面ハッシュと王手状態を保存
    const hash = getBoardHash(board, capturedPieces, currentPlayer);
    positionHistory.push(hash);
    checkHistory.push(isCheck);

    if (usiMove) {
        usiMoveHistory.push(usiMove);
    }

    currentHistoryIndex = moveHistory.length - 1;
    updateHistoryButtons();

    // localStorageに保存
    saveToLocalStorage();
}

function restoreState(index) {
    if (index < 0 || index >= moveHistory.length) return;

    // AI思考中の場合はキャンセル（リクエストIDを更新して古い結果を無視）
    aiRequestId++;
    hideAIThinkingIndicator();

    const state = moveHistory[index];
    board = deepCopyBoard(state.board);
    capturedPieces = deepCopyCaptured(state.capturedPieces);

    recomputeKingPosCache();
    currentPlayer = state.currentPlayer;
    lastMove = state.lastMove ? { ...state.lastMove } : null;
    moveCount = state.moveCount;
    gameOver = state.gameOver ?? false;
    isCheck = state.isCheck ?? checkHistory[index] ?? false;
    checkmate = false;
    currentHistoryIndex = index;

    // 対局再開時はゲーム終了ダイアログを閉じてメッセージをリセット
    if (!gameOver) {
        hideGameOverDialog();
        if (isCheck) {
            messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
            messageArea.style.display = 'block';
        } else {
            messageElement.textContent = '';
            messageArea.style.display = 'none';
        }
    }

    clearSelection();
    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();

    // localStorageに保存
    saveToLocalStorage();
}

function undoMove() {
    if (currentHistoryIndex > 0) {
        restoreState(currentHistoryIndex - 1);
    }
}

function redoMove() {
    if (currentHistoryIndex < moveHistory.length - 1) {
        restoreState(currentHistoryIndex + 1);
    }
}

function updateHistoryButtons() {
    const undoButton = document.getElementById('undo-button');
    const redoButton = document.getElementById('redo-button');

    if (isOnlineMode()) {
        if (undoButton) undoButton.disabled = true;
        if (redoButton) redoButton.disabled = true;
        return;
    }

    if (undoButton) {
        undoButton.disabled = currentHistoryIndex <= 0;
    }
    if (redoButton) {
        redoButton.disabled = currentHistoryIndex >= moveHistory.length - 1;
    }
}

window.addEventListener('load', function () {
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-KH9HBZ92L4';
    document.head.appendChild(script);

    script.onload = function () {
        window.dataLayer = window.dataLayer || [];
        function gtag() { dataLayer.push(arguments); }
        gtag('js', new Date());
        gtag('config', 'G-KH9HBZ92L4');
    };

    var adsScript = document.createElement('script');
    adsScript.async = true;
    adsScript.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1918692579240633';
    adsScript.crossOrigin = 'anonymous';
    document.head.appendChild(adsScript);

    var topAdDiv = document.getElementById('top-ad');
    if (topAdDiv) {
        topAdDiv.innerHTML = '<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1918692579240633" data-ad-slot="1676714211" data-ad-format="auto" data-full-width-responsive="false"></ins>';
        topAdDiv.classList.remove("adloading");
        (adsbygoogle = window.adsbygoogle || []).push({});
    }
});
// --- 画像の遅延読み込み ---
function preloadPieceImages() {
    if (pieceDisplayMode !== 'image') return;

    for (const [pieceType, fileName] of Object.entries(pieceImageFiles)) {
        if (!pieceImageCache[pieceType]) {
            const img = new Image();
            img.src = `images/koma/${fileName}`;
            pieceImageCache[pieceType] = img;
        }
    }
}

// --- 描画 ---
function renderBoard() {
    boardElement.innerHTML = ''; // 盤面をクリア
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const square = document.createElement('div');
            square.classList.add('square');
            square.dataset.x = x;
            square.dataset.y = y;

            const piece = board[y][x];
            if (piece) {
                const pieceElement = document.createElement('span');
                pieceElement.classList.add('piece', piece.owner);
                const pieceType = piece.type;

                if (pieceDisplayMode === 'image') {
                    // 画像モード
                    pieceElement.classList.add('image-mode');
                    const img = document.createElement('img');
                    const fileName = pieceImageFiles[pieceType];
                    img.src = `images/koma/${fileName}`;
                    img.alt = pieceNames[pieceType] || '駒';
                    img.draggable = false;
                    pieceElement.appendChild(img);
                } else {
                    // テキストモード（従来通り）
                    let pieceChar = '';
                    if (pieceType === KING) {
                        pieceChar = (piece.owner === SENTE) ? '玉' : '王';
                    } else {
                        pieceChar = pieceNames[pieceType] || '?';
                    }
                    pieceElement.textContent = pieceChar;
                    if (pieceType.startsWith('+')) {
                        pieceElement.classList.add('promoted');
                    }
                }

                if (piece.owner === currentPlayer) {
                    square.classList.add('highlight');
                } else {
                    square.classList.remove('highlight');
                }
                square.appendChild(pieceElement);
            }

            // 選択状態と移動可能範囲のハイライト
            if (selectedPiece && selectedPiece.x === x && selectedPiece.y === y) {
                square.classList.add('selected');
            }
            if (validMoves.some(move => move.x === x && move.y === y)) {
                square.classList.add('valid-move');
            }

            // 最後に打った手のマーク
            if (lastMove && lastMove.x === x && lastMove.y === y) {
                const marker = document.createElement('div');
                marker.classList.add('last-move-marker');
                // 後手の駒の場合は左下に表示
                if (piece && piece.owner === GOTE) {
                    marker.classList.add('gote-marker');
                }
                square.appendChild(marker);
            }

            square.addEventListener('click', handleSquareClick);
            boardElement.appendChild(square);
        }
    }
}

function renderCapturedPieces() {
    renderCapturedSide(capturedWhiteElement, capturedPieces[SENTE], SENTE);
    renderCapturedSide(capturedBlackElement, capturedPieces[GOTE], GOTE);
}

function renderCapturedSide(container, pieces, owner) {
    container.innerHTML = '';
    for (const type in pieces) {
        if (pieces[type] > 0) {
            const pieceElement = document.createElement('div');
            pieceElement.classList.add('captured-piece');
            pieceElement.dataset.type = type;
            pieceElement.dataset.owner = owner;
            pieceElement.textContent = pieceNames[type];

            if (pieces[type] > 1) {
                const countSpan = document.createElement('span');
                countSpan.classList.add('count');
                countSpan.textContent = pieces[type];
                pieceElement.appendChild(countSpan);
            }

            // 持ち駒選択時のハイライト
            if (selectedPiece && selectedPiece.owner === owner && selectedPiece.type === type && !selectedPiece.x && !selectedPiece.y) {
                pieceElement.classList.add('selected');
            }

            pieceElement.addEventListener('click', handleCapturedPieceClick);
            container.appendChild(pieceElement);
        }
    }
}

function updateInfo() {
    currentTurnElement.textContent = currentPlayer === SENTE ? '先手' : '後手';
    moveCountElement.textContent = moveCount;
}

// --- イベントハンドラ ---
function handleSquareClick(event) {
    if (gameOver) return;
    if (isOnlineMode()) {
        const started = Boolean(onlineState.match?.gote_uid);
        if (!started) return;
        if (onlineState.match?.game_over) return;
        if (onlineState.submitting) return;
        if (!onlineState.side || onlineState.side !== currentPlayer) return;
    }

    const square = event.currentTarget;
    const x = parseInt(square.dataset.x);
    const y = parseInt(square.dataset.y);
    const piece = board[y][x];

    if (selectedPiece) {
        // 2回目のクリック: 移動先選択 or 持ち駒の打ち場所選択
        const isValidTarget = validMoves.some(move => move.x === x && move.y === y);

        if (isValidTarget) {
            // --- 移動または駒打ちを実行 ---
            if (selectedPiece.x !== undefined) { // 盤上の駒の移動
                handleMove(selectedPiece.x, selectedPiece.y, x, y, selectedPiece.piece);
            } else { // 持ち駒を打つ
                handleDrop(selectedPiece.type, x, y);
            }
        } else {
            // 無効な移動先、または自分の別の駒を選択した場合
            clearSelection();
            if (piece && piece.owner === currentPlayer) {
                selectPiece(x, y, piece);
            }
        }
    } else {
        // 1回目のクリック: 駒を選択
        if (piece && piece.owner === currentPlayer) {
            selectPiece(x, y, piece);
        }
    }
}

function handleCapturedPieceClick(event) {
    if (gameOver) return;
    if (isOnlineMode()) {
        const started = Boolean(onlineState.match?.gote_uid);
        if (!started) return;
        if (onlineState.match?.game_over) return;
        if (onlineState.submitting) return;
        if (!onlineState.side || onlineState.side !== currentPlayer) return;
    }

    const pieceElement = event.currentTarget;
    const type = pieceElement.dataset.type;
    const owner = pieceElement.dataset.owner;

    if (owner === currentPlayer) {
        clearSelection(); // 他の選択を解除
        selectedPiece = { owner: owner, type: type };
        validMoves = calculateDropLocations(type, owner);
        renderBoard(); // 移動可能箇所ハイライト
        renderCapturedPieces(); // 持ち駒ハイライト
    }
}

function selectPiece(x, y, piece) {
    clearSelection();
    selectedPiece = { x, y, piece: piece };
    validMoves = calculateValidMoves(x, y, piece);
    renderBoard(); // 再描画して選択状態と移動範囲を表示
    renderCapturedPieces();
}

function clearSelection() {
    selectedPiece = null;
    validMoves = [];
    // ハイライト解除のために再描画が必要な場合がある
    renderBoard();
    renderCapturedPieces();
}

// --- ゲームロジック ---

function handleMove(fromX, fromY, toX, toY, piece) {
    const captured = board[toY][toX]; // 取られる駒
    const movingPiece = piece;
    const isOnline = isOnlineMode();

    // --- 成りの確認 ---
    const canPromote = pieceInfo[movingPiece.type]?.canPromote;
    const isEnteringPromotionZone = (movingPiece.owner === SENTE && toY <= 2) || (movingPiece.owner === GOTE && toY >= 6);
    const isLeavingPromotionZone = (movingPiece.owner === SENTE && fromY <= 2 && toY > 2) || (movingPiece.owner === GOTE && fromY >= 6 && toY < 6); // 基本的には関係ないが考慮
    const wasInPromotionZone = (movingPiece.owner === SENTE && fromY <= 2) || (movingPiece.owner === GOTE && fromY >= 6);

    // 成れる条件:
    const mustPromote =
        (movingPiece.type === PAWN || movingPiece.type === LANCE) && (movingPiece.owner === SENTE ? toY === 0 : toY === 8) ||
        (movingPiece.type === KNIGHT) && (movingPiece.owner === SENTE ? toY <= 1 : toY >= 7);

    if (canPromote && (isEnteringPromotionZone || wasInPromotionZone) && !mustPromote) {
        // 成るかどうかの選択肢を表示
        promoteMoveInfo = { fromX, fromY, toX, toY, piece: movingPiece, captured, online: isOnline };
        showPromoteDialog();
        return; // ユーザーの選択を待つ
    }

    // --- 成り選択がない、または強制成りの場合の処理 ---
    const promote = mustPromote || (canPromote && isEnteringPromotionZone); // 成り選択ダイアログなしの場合の自動成り（敵陣に入るとき）

    if (isOnline) {
        clearSelection();
        onlineSubmitMove({ type: 'move', fromX, fromY, toX, toY, promote });
        return;
    }

    executeMove(fromX, fromY, toX, toY, movingPiece, captured, promote);
}

function executeMove(fromX, fromY, toX, toY, piece, captured, promote) {
    const movingPiece = { ...piece }; // コピーを作成
    const usiMove = toUsiMoveString({ type: 'move', fromX, fromY, toX, toY, promote });

    // 成る場合
    if (promote && pieceInfo[movingPiece.type]?.canPromote) {
        movingPiece.type = pieceInfo[movingPiece.type].promoted;
    }

    // 盤面更新
    board[toY][toX] = movingPiece;
    board[fromY][fromX] = null;

    // 玉が動いた場合はキャッシュを更新
    if (movingPiece.type === KING) {
        kingPosCache[movingPiece.owner] = { x: toX, y: toY };
    }

    // 最後の手を記録
    lastMove = { x: toX, y: toY };
    lastMoveDetail = { fromX, fromY, toX, toY };

    // 駒を取った場合の処理
    if (captured) {
        let capturedType = captured.type;
        // 成り駒を取ったら元の駒に戻す
        if (pieceInfo[capturedType]?.base) {
            capturedType = pieceInfo[capturedType].base;
        }
        capturedPieces[currentPlayer][capturedType]++;
    }

    // 駒を動かす音を再生
    piecePlacementSound.currentTime = 0; // 音声を最初から再生
    piecePlacementSound.play().catch(err => console.log('音声再生エラー:', err));

    // ゲーム状態の更新
    finalizeMove(usiMove);
}


function handleDrop(pieceType, toX, toY) {
    if (isOnlineMode()) {
        // Client-side pre-check (server validates again).
        if (pieceType === PAWN) {
            let hasPawnInColumn = false;
            for (let y = 0; y < 9; y++) {
                const p = board[y][toX];
                if (p && p.type === PAWN && p.owner === currentPlayer) {
                    hasPawnInColumn = true;
                    break;
                }
            }
            if (hasPawnInColumn) {
                messageElement.textContent = "二歩です。";
                messageArea.style.display = 'block';
                clearSelection();
                return;
            }

            if (isUchifuzume(toX, toY, currentPlayer)) {
                messageElement.textContent = "打ち歩詰めは反則です。";
                messageArea.style.display = 'block';
                clearSelection();
                return;
            }
        }

        clearSelection();
        onlineSubmitMove({ type: 'drop', pieceType, toX, toY });
        return;
    }

    // 二歩チェックは calculateDropLocations で行っているため、
    // ここに来た時点で合法手のはず
    // ただし、念のため再度チェック
    if (pieceType === PAWN) {
        let hasPawnInColumn = false;
        for (let y = 0; y < 9; y++) {
            const p = board[y][toX];
            if (p && p.type === PAWN && p.owner === currentPlayer) {
                hasPawnInColumn = true;
                break;
            }
        }
        if (hasPawnInColumn) {
            messageElement.textContent = "二歩です。";
            messageArea.style.display = 'block';
            clearSelection();
            return;
        }

        // 打ち歩詰めチェック
        if (isUchifuzume(toX, toY, currentPlayer)) {
            messageElement.textContent = "打ち歩詰めは反則です。";
            messageArea.style.display = 'block';
            clearSelection();
            return;
        }
    }

    const usiMove = toUsiMoveString({ type: 'drop', pieceType, toX, toY });

    // 持ち駒を減らす
    capturedPieces[currentPlayer][pieceType]--;

    // 盤面に置く
    board[toY][toX] = { type: pieceType, owner: currentPlayer };

    // 最後の手を記録
    lastMove = { x: toX, y: toY };
    lastMoveDetail = { drop: true, pieceType, toX, toY, fromX: null, fromY: null };

    // 駒を打つ音を再生
    piecePlacementSound.currentTime = 0; // 音声を最初から再生
    piecePlacementSound.play().catch(err => console.log('音声再生エラー:', err));

    // ゲーム状態の更新
    finalizeMove(usiMove);
}

// 成り選択ダイアログ表示
function showPromoteDialog() {
    promoteDialog.style.display = 'block';
}
function hidePromoteDialog() {
    promoteDialog.style.display = 'none';
    promoteMoveInfo = null;
}

// 成り選択「はい」
promoteYesButton.addEventListener('click', () => {
    if (promoteMoveInfo) {
        const { fromX, fromY, toX, toY, piece, captured } = promoteMoveInfo;
        if (promoteMoveInfo.online) {
            clearSelection();
            onlineSubmitMove({ type: 'move', fromX, fromY, toX, toY, promote: true });
        } else {
            executeMove(fromX, fromY, toX, toY, piece, captured, true); // 成る
        }
        hidePromoteDialog();
    }
});

// 成り選択「いいえ」
promoteNoButton.addEventListener('click', () => {
    if (promoteMoveInfo) {
        const { fromX, fromY, toX, toY, piece, captured } = promoteMoveInfo;
        if (promoteMoveInfo.online) {
            clearSelection();
            onlineSubmitMove({ type: 'move', fromX, fromY, toX, toY, promote: false });
        } else {
            executeMove(fromX, fromY, toX, toY, piece, captured, false); // 成らない
        }
        hidePromoteDialog();
    }
});


function finalizeMove(usiMove = null) {
    moveCount++;

    // プレイヤーの手を記録（定石判定用）
    if (gameMode === 'ai' && currentPlayer === playerSide) {
        josekiMoveIndex++;
    }

    switchPlayer();
    clearSelection(); // 選択状態と移動可能範囲をクリア

    // 王手チェック
    isCheck = isKingInCheck(currentPlayer);
    if (isCheck) {
        // 詰みチェック
        checkmate = isCheckmate(currentPlayer);
        if (checkmate) {
            const winner = currentPlayer === SENTE ? '後手' : '先手';
            messageElement.textContent = `${winner}の勝ちです（詰み）`;
            messageArea.style.display = 'block';
            gameOver = true;
            showGameOverDialog(winner, '詰み');
        } else {
            messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
            messageArea.style.display = 'block';
        }
    } else {
        // 王手でなければ詰みではない
        checkmate = false;

        messageElement.textContent = ''; // メッセージを消す
        messageArea.style.display = 'none';
    }

    // 現在の状態を履歴に保存
    saveCurrentState(usiMove);

    // 千日手判定
    if (!gameOver) {
        const sennichiteResult = checkSennichite();
        if (sennichiteResult.isSennichite) {
            gameOver = true;
            if (sennichiteResult.isConsecutiveCheck) {
                // 連続王手の千日手は反則負け
                const loser = sennichiteResult.checkingPlayer;
                const winner = loser === SENTE ? '後手' : '先手';
                messageElement.textContent = `${winner}の勝ちです（連続王手の千日手）`;
                messageArea.style.display = 'block';
                showGameOverDialog(winner, '連続王手の千日手');
            } else {
                // 通常の千日手は引き分け
                messageElement.textContent = '引き分けです（千日手）';
                messageArea.style.display = 'block';
                showGameOverDialog('引き分け', '千日手');
            }
        }
    }

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();

    scheduleAIMoveIfNeeded();
}

function switchPlayer() {
    currentPlayer = (currentPlayer === SENTE) ? GOTE : SENTE;
}

function getOpponent(player) {
    return player === SENTE ? GOTE : SENTE;
}

function getAIPlayer() {
    return gameMode === 'ai' ? getOpponent(playerSide) : null;
}

function getAiMoveDelay() {
    if (aiDifficulty === 'easy' || aiDifficulty === 'medium') {
        return 430;
    }
    if (aiDifficulty === 'hard') {
        return 280;
    }
    return 1;
}

function scheduleAIMoveIfNeeded() {
    const aiPlayer = getAIPlayer();
    if (!aiPlayer || gameMode !== 'ai' || gameOver) {
        return;
    }
    if (currentPlayer !== aiPlayer) {
        return;
    }

    const delay = getAiMoveDelay();
    setTimeout(() => {
        makeAIMove();
    }, delay);
}

function applyBoardOrientation() {
    if (typeof document === 'undefined') return;
    if (playerSide === GOTE) {
        document.body.classList.add('board-flipped');
    } else {
        document.body.classList.remove('board-flipped');
    }
}

function updatePlayerSideRadios(side) {
    playerSideRadios.forEach(radio => {
        radio.checked = radio.value === side;
    });
}


// --- 移動可能範囲の計算 ---

// 盤面上で自駒・敵駒を考慮した「生の」候補手（自玉の安全性は未考慮）
function calculatePseudoMoves(x, y, piece, boardState = board) {
    const moves = [];
    const owner = piece.owner;
    const opponent = owner === SENTE ? GOTE : SENTE;

    const directions = getPieceMovements(piece.type, owner);

    for (const dir of directions) {
        let currentX = x;
        let currentY = y;

        // dir.range は最大移動距離 (1 または 8)
        for (let i = 0; i < dir.range; i++) {
            currentX += dir.dx;
            currentY += dir.dy;

            // 盤外チェック
            if (currentX < 0 || currentX >= 9 || currentY < 0 || currentY >= 9) {
                break; // この方向は終わり
            }

            const targetPiece = boardState[currentY][currentX];

            if (targetPiece === null) {
                // 空マスなら移動可能
                moves.push({ x: currentX, y: currentY });
            } else if (targetPiece.owner === opponent) {
                // 相手の駒なら取って移動可能
                moves.push({ x: currentX, y: currentY });
                break; // 相手の駒を取ったらその先には進めない
            } else {
                // 自分の駒なら移動不可
                break; // この方向は終わり
            }

            // 桂馬や金など、1マスしか進めない駒の場合
            if (dir.range === 1) {
                break;
            }
        }
    }

    return moves;
}

function calculateValidMoves(x, y, piece) {
    const owner = piece.owner;
    const pseudoMoves = calculatePseudoMoves(x, y, piece);

    // 移動の結果、自玉が王手になる手は除外する 
    const legalMoves = pseudoMoves.filter(move => {
        // 仮想的に動かしてみる
        const tempBoard = cloneBoard(board);

        tempBoard[move.y][move.x] = tempBoard[y][x];
        tempBoard[y][x] = null;

        // 仮想的な移動後に王手になっていないか？
        const kingStillInCheck = isKingInCheck(owner, tempBoard);

        return !kingStillInCheck; // 王手になっていなければ合法手
    });


    return legalMoves;
}

function calculateDropLocations(pieceType, owner) {
    const locations = [];
    const opponent = owner === SENTE ? GOTE : SENTE;

    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            if (board[y][x] === null) { // 空きマスであること
                // 行き所のない駒チェック
                if (
                    (pieceType === PAWN || pieceType === LANCE) && (owner === SENTE ? y === 0 : y === 8) ||
                    (pieceType === KNIGHT) && (owner === SENTE ? y <= 1 : y >= 7)
                ) {
                    continue; // 打てない
                }

                // 二歩チェック（歩の場合のみ）
                if (pieceType === PAWN) {
                    let hasPawnInColumn = false;
                    for (let checkY = 0; checkY < 9; checkY++) {
                        const p = board[checkY][x];
                        if (p && p.type === PAWN && p.owner === owner) {
                            hasPawnInColumn = true;
                            break;
                        }
                    }
                    if (hasPawnInColumn) {
                        continue; // この列には既に歩があるので打てない
                    }

                    // 打ち歩詰めチェック
                    if (isUchifuzume(x, y, owner)) {
                        continue; // 打ち歩詰めとなるので打てない
                    }
                }

                // 仮に打ってみて、王手にならないか（自玉が素通しになるような打つ手はないはずだが念のため）
                const tempBoard = cloneBoard(board);
                tempBoard[y][x] = { type: pieceType, owner: owner };
                if (!isKingInCheck(owner, tempBoard)) {
                    locations.push({ x, y });
                }

            }
        }
    }
    return locations;
}
// 駒の動きを事前定義（先手・後手別）
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

// 成り駒の動きを追加（金の動きと同じ）
[SENTE, GOTE].forEach(owner => {
    const goldMoves = PIECE_MOVEMENTS[owner][GOLD];
    PIECE_MOVEMENTS[owner][PROMOTED_PAWN] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_LANCE] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_KNIGHT] = goldMoves;
    PIECE_MOVEMENTS[owner][PROMOTED_SILVER] = goldMoves;

    // 馬 = 角 + 王(斜め以外の4方向)
    PIECE_MOVEMENTS[owner][PROMOTED_BISHOP] = [
        ...PIECE_MOVEMENTS[owner][BISHOP],
        { dx: 1, dy: 0, range: 1 }, { dx: -1, dy: 0, range: 1 },
        { dx: 0, dy: 1, range: 1 }, { dx: 0, dy: -1, range: 1 }
    ];

    // 龍 = 飛車 + 王(斜め4方向)
    PIECE_MOVEMENTS[owner][PROMOTED_ROOK] = [
        ...PIECE_MOVEMENTS[owner][ROOK],
        { dx: 1, dy: 1, range: 1 }, { dx: 1, dy: -1, range: 1 },
        { dx: -1, dy: 1, range: 1 }, { dx: -1, dy: -1, range: 1 }
    ];
});

function getPieceMovements(type, owner) {
    return PIECE_MOVEMENTS[owner]?.[type] || [];
}

// --- 王手・詰み判定 ---

// 指定されたプレイヤーの玉が王手されているかチェック
function isKingInCheck(player, currentBoard = board) {

    const kingPos = getKingPosCached(player, currentBoard);
    if (!kingPos) return false; // 玉が見つからない (ありえないはず)

    const attacker = player === SENTE ? GOTE : SENTE;
    return isSquareAttackedBy(attacker, kingPos.x, kingPos.y, currentBoard);
}

function isSquareAttackedBy(attacker, targetX, targetY, currentBoard = board) {
    // 1) 桂馬（非隣接）
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

    // 2) 隣接8マス（玉/金/銀/歩/と等の1手利き + 竜/馬の追加1手利きも含む）
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
                if (m.range === 1 && m.dx === wantDx && m.dy === wantDy) {
                    return true;
                }
            }
        }
    }

    // 3) 飛車/竜（縦横の射線）+ 香（前方向の射線）
    // 右
    for (let x = targetX + 1; x < 9; x++) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    // 左
    for (let x = targetX - 1; x >= 0; x--) {
        const p = currentBoard[targetY][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === ROOK || p.type === PROMOTED_ROOK)) return true;
        break;
    }
    // 下（y+）
    for (let y = targetY + 1; y < 9; y++) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === SENTE && p.type === LANCE) return true; // 先手の香は上へ利く → 玉から見て下方向に居れば利く
        }
        break;
    }
    // 上（y-）
    for (let y = targetY - 1; y >= 0; y--) {
        const p = currentBoard[y][targetX];
        if (!p) continue;
        if (p.owner === attacker) {
            if (p.type === ROOK || p.type === PROMOTED_ROOK) return true;
            if (attacker === GOTE && p.type === LANCE) return true; // 後手の香は下へ利く → 玉から見て上方向に居れば利く
        }
        break;
    }

    // 4) 角/馬（斜めの射線）
    // 右下
    for (let x = targetX + 1, y = targetY + 1; x < 9 && y < 9; x++, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    // 左下
    for (let x = targetX - 1, y = targetY + 1; x >= 0 && y < 9; x--, y++) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    // 右上
    for (let x = targetX + 1, y = targetY - 1; x < 9 && y >= 0; x++, y--) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }
    // 左上
    for (let x = targetX - 1, y = targetY - 1; x >= 0 && y >= 0; x--, y--) {
        const p = currentBoard[y][x];
        if (!p) continue;
        if (p.owner === attacker && (p.type === BISHOP || p.type === PROMOTED_BISHOP)) return true;
        break;
    }

    return false;
}

// 自分の玉の位置を探す
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

// 駒の基本的な利きを計算する（自玉の安全は考慮しない）
function calculateRawPieceMoves(x, y, piece, currentBoard) {
    const moves = [];
    const owner = piece.owner;
    const type = piece.type;

    const directions = getPieceMovements(type, owner);

    for (const dir of directions) {
        let currentX = x;
        let currentY = y;

        for (let i = 0; i < dir.range; i++) {
            currentX += dir.dx;
            currentY += dir.dy;

            if (currentX < 0 || currentX >= 9 || currentY < 0 || currentY >= 9) break;

            const targetPiece = currentBoard[currentY][currentX];
            if (targetPiece === null) {
                moves.push({ x: currentX, y: currentY });
            } else {
                // 相手・自分の駒に関わらず、利きはそのマスまで
                moves.push({ x: currentX, y: currentY });
                break;
            }
            if (dir.range === 1) break;
        }
    }
    return moves;
}


// 詰み判定
function isCheckmate(player) {
    if (!isKingInCheck(player)) {
        return false; // 王手されていなければ詰みではない
    }

    // player の全ての可能な手を試す
    // 1. 盤上の駒の移動
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const validMovesForPiece = calculateValidMoves(x, y, piece); // 合法手のみ計算
                if (validMovesForPiece.length > 0) {
                    // 1つでも王手を回避できる手があれば詰みではない
                    // calculateValidMoves が自玉の安全を考慮しているので、ここで得られた合法手は、実行後に王手になっていない手
                    return false;
                }
            }
        }
    }

    // 2. 持ち駒を打つ
    const playerCaptured = capturedPieces[player];
    for (const pieceType in playerCaptured) {
        if (playerCaptured[pieceType] > 0) {
            const dropLocations = calculateDropLocations(pieceType, player);
            // 安全な打ち場所が見つかれば詰みではない
            if (dropLocations.length > 0) {
                return false;
            }
        }
    }

    // 全ての合法手（移動・駒打ち）を試しても王手が回避できなければ詰み
    return true;
}

// --- ユーティリティ ---

/**
 * 打ち歩詰め判定
 * 歩を打つ手が打ち歩詰め(違法)かどうかをチェック
 * @param {number} toX - 歩を打つX座標
 * @param {number} toY - 歩を打つY座標
 * @param {string} player - 打つプレイヤー
 * @returns {boolean} - 打ち歩詰めの場合true
 */
function isUchifuzume(toX, toY, player) {
    // 一時的に歩を打つ
    const tempBoard = cloneBoard(board);
    tempBoard[toY][toX] = { type: PAWN, owner: player };

    const opponent = getOpponent(player);
    // この手で相手玉が王手になっているかチェック
    if (!isKingInCheck(opponent, tempBoard)) {
        return false; // 王手でなければ打ち歩詰めではない
    }
    // 一時的にボードを入れ替えて詰み判定
    const originalBoard = board;
    board = tempBoard;
    recomputeKingPosCache();
    const isOpponentCheckmated = isCheckmate(opponent);
    board = originalBoard;
    recomputeKingPosCache();

    // 王手で、詰みの場合は打ち歩詰め
    return isOpponentCheckmated;
}

function cloneBoard(boardToClone) {
    return boardToClone.map(row => row.map(piece => piece ? { ...piece } : null));
}

function cloneCapturedPieces(captured) {
    return {
        [SENTE]: { ...captured[SENTE] },
        [GOTE]: { ...captured[GOTE] }
    };
}

// AIが手を指す
function makeAIMove() {
    if (gameOver) return;

    const aiPlayer = getAIPlayer();
    if (!aiPlayer || gameMode !== 'ai') return;
    if (currentPlayer !== aiPlayer) return;

    // 思考中インジケータを表示（思考時間が長い難易度のみ）
    const showIndicatorDifficulties = ['master', 'transcendent', 'legendary1', 'legendary2', 'legendary3'];
    if (showIndicatorDifficulties.includes(aiDifficulty)) {
        showAIThinkingIndicator();
    }

    // 現在のリクエストIDを保存（レスポンスで照合するため）
    const currentRequestId = aiRequestId;

    // 高レベルAI（偉人級以上）はYaneuraOuを使用
    if (isYaneuraouDifficulty(aiDifficulty) && yaneuraouWorker) {
        yaneuraouWorker.postMessage({
            type: 'getBestMove',
            data: {
                board,
                capturedPieces,
                currentPlayer,
                aiDifficulty,
                usiMoves: getActiveUsiMoves(),
                requestId: currentRequestId
            }
        });
    } else if (aiWorker) {
        // 通常のAIワーカーに計算を依頼
        aiWorker.postMessage({
            type: 'getBestMove',
            data: {
                board,
                capturedPieces,
                currentPlayer,
                moveCount,
                lastMoveDetail,
                aiDifficulty,
                aiPlayer,
                josekiEnabled,
                currentJosekiPattern,
                josekiMoveIndex,
                requestId: currentRequestId
            }
        });
    }
}

// AIの手を実行
function executeAIMove(move) {
    // ゲームオーバーの場合は何もしない
    if (gameOver) {
        console.log('Game is over, ignoring AI move');
        return;
    }

    if (move.type === 'move') {
        // 盤上の駒を動かす
        const { fromX, fromY, toX, toY, promote } = move;
        const piece = board[fromY][fromX];

        // 安全性チェック：駒が存在しない場合は何もしない（盤面がリセットされた可能性）
        if (!piece) {
            console.log('No piece at source position, ignoring AI move (board may have been reset)');
            return;
        }

        const captured = board[toY][toX];
        executeMove(fromX, fromY, toX, toY, piece, captured, promote);
    } else if (move.type === 'drop') {
        // 持ち駒を打つ
        const { pieceType, toX, toY } = move;

        // 安全性チェック：持ち駒が存在しない場合は何もしない（盤面がリセットされた可能性）
        if (!capturedPieces[currentPlayer] || capturedPieces[currentPlayer][pieceType] <= 0) {
            console.log('No captured piece available, ignoring AI drop (board may have been reset)');
            return;
        }

        const usiMove = toUsiMoveString({ type: 'drop', pieceType, toX, toY });

        // 持ち駒を減らす
        capturedPieces[currentPlayer][pieceType]--;

        // 盤面に置く
        board[toY][toX] = { type: pieceType, owner: currentPlayer };

        // 最後の手を記録
        lastMove = { x: toX, y: toY };
        lastMoveDetail = { drop: true, pieceType, toX, toY, fromX: null, fromY: null };

        // 駒を打つ音を再生
        piecePlacementSound.currentTime = 0; // 音声を最初から再生
        piecePlacementSound.play().catch(err => console.log('音声再生エラー:', err));

        // ゲーム状態の更新
        finalizeMove(usiMove);
    }
}

// --- localStorage関連 ---
const STORAGE_KEY_GAME_STATE = 'shogi_game_state';
const STORAGE_KEY_AI_DIFFICULTY = 'shogi_ai_difficulty';
const STORAGE_KEY_PIECE_DISPLAY_MODE = 'shogi_piece_display_mode';
const STORAGE_KEY_PLAYER_SIDE = 'shogi_player_side';
const STORAGE_KEY_UNLOCKED_LEVELS = 'shogi_unlocked_levels';

// レベル解放システム
const LEVEL_PROGRESSION = {
    'transcendent': 'legendary1',
    'legendary1': 'legendary2',
    'legendary2': 'legendary3'
};

const LEGENDARY_LEVELS = ['legendary1', 'legendary2', 'legendary3'];

// 次のレベル解放状態の管理
let pendingUnlockedLevel = null;

// 解放済みレベルを取得
function getUnlockedLevels() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_UNLOCKED_LEVELS);
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        return [];
    }
}

// レベルを解放
function unlockLevel(level) {
    const unlocked = getUnlockedLevels();
    if (!unlocked.includes(level)) {
        unlocked.push(level);
        localStorage.setItem(STORAGE_KEY_UNLOCKED_LEVELS, JSON.stringify(unlocked));
    }
}

// レベルが解放されているかチェック
function isLevelUnlocked(level) {
    if (!LEGENDARY_LEVELS.includes(level)) return true;
    return getUnlockedLevels().includes(level);
}

// 難易度セレクトのオプションを更新
function updateDifficultyOptions() {
    const unlocked = getUnlockedLevels();
    LEGENDARY_LEVELS.forEach(level => {
        const option = difficultySelect.querySelector(`option[value="${level}"]`);
        if (option) {
            const isUnlocked = unlocked.includes(level);
            option.disabled = !isUnlocked;
            option.classList.toggle('locked-level', !isUnlocked);

            // テキストを更新
            const levelNum = level.replace('legendary', '');
            option.textContent = isUnlocked ? `伝説${levelNum}` : `伝説${levelNum} 🔒`;
        }
    });
}

// ゲーム状態をlocalStorageに保存
function saveToLocalStorage() {
    try {
        const gameState = {
            moveHistory: moveHistory,
            currentHistoryIndex: currentHistoryIndex,
            positionHistory: positionHistory,
            checkHistory: checkHistory,
            usiMoveHistory: usiMoveHistory,
            moveCount: moveCount,
            currentPlayer: currentPlayer,
            gameOver: gameOver,
            lastMove: lastMove,
            isCheck: isCheck
        };
        localStorage.setItem(STORAGE_KEY_GAME_STATE, JSON.stringify(gameState));
        localStorage.setItem(STORAGE_KEY_AI_DIFFICULTY, aiDifficulty);
        localStorage.setItem(STORAGE_KEY_PIECE_DISPLAY_MODE, pieceDisplayMode);
        localStorage.setItem(STORAGE_KEY_PLAYER_SIDE, playerSide);
    } catch (error) {
        console.error('localStorage保存エラー:', error);
    }
}

// localStorageからゲーム状態を読み込み
function loadFromLocalStorage() {
    try {
        const savedState = localStorage.getItem(STORAGE_KEY_GAME_STATE);
        const savedDifficulty = localStorage.getItem(STORAGE_KEY_AI_DIFFICULTY);
        const savedDisplayMode = localStorage.getItem(STORAGE_KEY_PIECE_DISPLAY_MODE);
        const savedPlayerSide = localStorage.getItem(STORAGE_KEY_PLAYER_SIDE);

        if (savedPlayerSide === SENTE || savedPlayerSide === GOTE) {
            playerSide = savedPlayerSide;
        }
        updatePlayerSideRadios(playerSide);
        applyBoardOrientation();

        // ゲームモードはURLパラメータで管理（localStorageからは復元しない）
        // モードタブの状態を更新
        modeTabs.forEach(tab => {
            if (tab.dataset.mode === gameMode) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
        // AI設定の表示/非表示
        if (gameMode === 'ai') {
            aiSettingsElement.style.display = 'block';
            if (onlineSettingsElement) onlineSettingsElement.style.display = 'none';
        } else if (gameMode === ONLINE_MODE) {
            aiSettingsElement.style.display = 'none';
            if (onlineSettingsElement) onlineSettingsElement.style.display = 'block';
        } else {
            aiSettingsElement.style.display = 'none';
            if (onlineSettingsElement) onlineSettingsElement.style.display = 'none';
        }

        // AI難易度の復元
        if (savedDifficulty) {
            aiDifficulty = savedDifficulty;
        }
        difficultySelect.value = aiDifficulty;
        // optionに存在しない値だった場合はデフォルトに戻す
        if (!difficultySelect.value) {
            aiDifficulty = 'medium';
            difficultySelect.value = aiDifficulty;
        }

        // 駒の表示モードの復元
        if (savedDisplayMode) {
            pieceDisplayMode = savedDisplayMode;
        }
        // ラジオボタンの状態を更新
        pieceDisplayModeRadios.forEach(radio => {
            radio.checked = radio.value === pieceDisplayMode;
        });
        // 画像モードの場合は画像をプリロード
        if (pieceDisplayMode === 'image') {
            preloadPieceImages();
        }

        if (savedState && gameMode !== ONLINE_MODE) {
            const gameState = JSON.parse(savedState);

            // 履歴の復元
            moveHistory = gameState.moveHistory || [];
            currentHistoryIndex = gameState.currentHistoryIndex || -1;
            positionHistory = gameState.positionHistory || [];
            checkHistory = gameState.checkHistory || [];
            const savedUsiMoves = gameState.usiMoveHistory || [];
            usiMoveHistory = savedUsiMoves.slice(0, Math.max((moveHistory.length || 1) - 1, 0));

            if (moveHistory.length > 0 && currentHistoryIndex >= 0 && currentHistoryIndex < moveHistory.length) {
                // 現在の状態を復元
                const state = moveHistory[currentHistoryIndex];
                board = deepCopyBoard(state.board);
                capturedPieces = deepCopyCaptured(state.capturedPieces);

                recomputeKingPosCache();
                currentPlayer = state.currentPlayer;
                lastMove = state.lastMove ? { ...state.lastMove } : null;
                moveCount = state.moveCount;
                gameOver = state.gameOver ?? (gameState.gameOver || false);
                isCheck = state.isCheck ?? (gameState.isCheck || false);

                renderBoard();
                renderCapturedPieces();
                updateInfo();
                updateHistoryButtons();
                scheduleAIMoveIfNeeded();

                console.log('ゲーム状態を復元しました');
                return true;
            }
        }
    } catch (error) {
        console.error('localStorage読み込みエラー:', error);
    }
    return false;
}

// URLで online に入る場合など、盤面状態の復元は不要だがユーザー設定は維持したいケース向け
function loadPreferencesOnlyFromLocalStorage() {
    try {
        const savedDifficulty = localStorage.getItem(STORAGE_KEY_AI_DIFFICULTY);
        const savedDisplayMode = localStorage.getItem(STORAGE_KEY_PIECE_DISPLAY_MODE);
        const savedPlayerSide = localStorage.getItem(STORAGE_KEY_PLAYER_SIDE);

        if (savedPlayerSide === SENTE || savedPlayerSide === GOTE) {
            playerSide = savedPlayerSide;
        }
        updatePlayerSideRadios(playerSide);
        applyBoardOrientation();

        if (savedDifficulty) {
            aiDifficulty = savedDifficulty;
        }
        difficultySelect.value = aiDifficulty;
        if (!difficultySelect.value) {
            aiDifficulty = 'medium';
            difficultySelect.value = aiDifficulty;
        }

        if (savedDisplayMode) {
            pieceDisplayMode = savedDisplayMode;
        }
        pieceDisplayModeRadios.forEach(radio => {
            radio.checked = radio.value === pieceDisplayMode;
        });
        if (pieceDisplayMode === 'image') {
            preloadPieceImages();
        }
    } catch (e) {
        // ignore
    }
}

// localStorageをクリア
function clearLocalStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY_GAME_STATE);
    } catch (error) {
        console.error('localStorageクリアエラー:', error);
    }
}

function startNewGame() {
    hideGameOverDialog();
    clearLocalStorage();
    initializeBoard();
}

// 次のレベルで新規ゲームを開始
function startNextLevelGame() {
    hideGameOverDialog();
    clearLocalStorage();

    // 解放されたレベルがあれば、そのレベルに切り替え
    if (pendingUnlockedLevel && isLevelUnlocked(pendingUnlockedLevel)) {
        aiDifficulty = pendingUnlockedLevel;
        difficultySelect.value = aiDifficulty;
        saveToLocalStorage();
    }

    pendingUnlockedLevel = null;
    initializeBoard();
}

// --- 初期化実行 ---
async function handleResetButtonClick() {
    if (isOnlineMode()) return;
    startNewGame();
}

async function handleNewGameButtonClick() {
    if (isOnlineMode()) {
        // Online: 次のゲーム = 新しい部屋を作成
        await onlineLeaveRoom({ resignIfActive: false });
        await onlineCreateRoom();
        return;
    }

    if (pendingUnlockedLevel) {
        startNextLevelGame();
    } else {
        startNewGame();
    }
}

resetButton.addEventListener('click', () => {
    handleResetButtonClick();
});

newGameButton.addEventListener('click', () => {
    handleNewGameButtonClick();
});

// 履歴ボタンのイベントリスナー
const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');

undoButton.addEventListener('click', () => {
    undoMove();
});

redoButton.addEventListener('click', () => {
    redoMove();
});

// URLのmodeパラメータを現在のgameModeに合わせて更新する
function setUrlMode(mode) {
    const url = new URL(window.location.href);
    if (mode && mode !== 'ai') {
        url.searchParams.set('mode', mode);
    } else {
        url.searchParams.delete('mode');
    }
    window.history.replaceState({}, '', url.toString());
}

async function switchGameMode(nextMode) {
    const targetMode = (nextMode === ONLINE_MODE) ? ONLINE_MODE : (nextMode === 'pvp' ? 'pvp' : 'ai');

    // Leaving an active online game requires confirmation and resign.
    if (gameMode === ONLINE_MODE && targetMode !== ONLINE_MODE) {
        const active = Boolean(onlineState.match?.gote_uid) && !onlineState.match?.game_over;
        if (active) {
            const ok = window.confirm('対局中です。移動すると投了になります。移動しますか？');
            if (!ok) {
                // Restore current tab selection.
                modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === gameMode));
                updateOnlineUiState();
                return;
            }
            await onlineLeaveRoom({ resignIfActive: true });
        } else if (onlineState.roomCode) {
            await onlineLeaveRoom({ resignIfActive: false });
        } else {
            onlineState.roomEpoch += 1;
            stopOnlineHeartbeat();
            stopOnlineRealtime();
            onlineState.roomCode = null;
            onlineState.match = null;
            onlineState.side = null;
            onlineState.appliedRevision = -1;
            onlineState.lastUsiLen = 0;
            onlineState.lastGameOverRevisionShown = null;
            onlineState.matchStartShown = false;
            setUrlRoom(null);
        }
    }

    gameMode = targetMode;

    // URLのmodeパラメータを更新
    setUrlMode(gameMode);

    // Update tab visuals
    modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === gameMode));

    // Toggle settings panels
    if (gameMode === 'ai') {
        aiSettingsElement.style.display = 'block';
        if (onlineSettingsElement) onlineSettingsElement.style.display = 'none';
    } else if (gameMode === ONLINE_MODE) {
        aiSettingsElement.style.display = 'none';
        if (onlineSettingsElement) onlineSettingsElement.style.display = 'block';
    } else {
        aiSettingsElement.style.display = 'none';
        if (onlineSettingsElement) onlineSettingsElement.style.display = 'none';
    }

    // Save preferences (mode is managed via URL, not localStorage)
    saveToLocalStorage();

    // Reset local board state (online state comes from server).
    clearLocalStorage();
    initializeBoard();

    updateOnlineInviteUI();
    updateOnlineUiState();

    // If we entered online mode with an invite URL, auto-join.
    if (gameMode === ONLINE_MODE) {
        const params = new URLSearchParams(window.location.search);
        const room = params.get('room');
        if (room) {
            onlineJoinRoom(room);
        }
    }
}

// モード切り替えタブのイベントリスナー
modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        switchGameMode(tab.dataset.mode);
    });
});

// 通信対戦ボタン
if (onlineCreateRoomButton) {
    onlineCreateRoomButton.addEventListener('click', async () => {
        if (!isOnlineMode()) {
            await switchGameMode(ONLINE_MODE);
        }

        // If already in a room, leaving it creates a new one.
        if (onlineState.roomCode) {
            const active = Boolean(onlineState.match?.gote_uid) && !onlineState.match?.game_over;
            if (active) {
                const ok = window.confirm('対局中です。新しい部屋を作成すると投了になります。作成しますか？');
                if (!ok) return;
                await onlineLeaveRoom({ resignIfActive: true });
            } else {
                await onlineLeaveRoom({ resignIfActive: false });
            }
        }

        await onlineCreateRoom();
    });
}

if (onlineCopyInviteButton) {
    onlineCopyInviteButton.addEventListener('click', () => {
        if (!onlineState.roomCode) return;
        const url = getInviteUrl(onlineState.roomCode);
        navigator.clipboard.writeText(url).then(() => {
            onlineCopyInviteButton.classList.add('copied');
            setTimeout(() => {
                onlineCopyInviteButton.classList.remove('copied');
            }, 1500);
        }).catch(() => {
            alert('招待URLのコピーに失敗しました。');
        });
    });
}

if (resignButton) {
    resignButton.addEventListener('click', async () => {
        if (!isOnlineMode()) return;
        if (!onlineState.roomCode) return;
        if (onlineState.match?.game_over) return;
        const ok = window.confirm('投了しますか？');
        if (!ok) return;
        await onlineResign();
    });
}

// 難易度変更のイベントリスナー
difficultySelect.addEventListener('change', (e) => {
    aiDifficulty = e.target.value;
    // 難易度をlocalStorageに保存
    saveToLocalStorage();
    // 難易度が変更されたらゲームをリセット
    clearLocalStorage();
    initializeBoard();
});

// 手番選択のイベントリスナー
playerSideRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        const selectedSide = e.target.value === GOTE ? GOTE : SENTE;
        playerSide = selectedSide;
        applyBoardOrientation();
        saveToLocalStorage();
        clearLocalStorage();
        initializeBoard();
    });
});

// 駒の表示モード変更のイベントリスナー
pieceDisplayModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        pieceDisplayMode = e.target.value;

        // 画像モードに切り替える場合のみ画像をプリロード
        if (pieceDisplayMode === 'image') {
            preloadPieceImages();
        }

        // 表示モードをlocalStorageに保存
        saveToLocalStorage();

        // 盤面を再描画
        renderBoard();
        renderCapturedPieces();
    });
});

// 設定アイコンボタンのイベントリスナー
settingsIconButton.addEventListener('click', () => {
    advancedSettingsSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ゲーム終了ダイアログの表示
function showGameOverDialog(winner, reason) {
    // 新規ゲームボタンのテキストをリセット
    const newGameMainSpan = newGameButton.querySelector('.new-game-main');
    if (newGameMainSpan) {
        newGameMainSpan.textContent = '次のゲームへ';
    }
    pendingUnlockedLevel = null;

    // タイトルと結果メッセージを設定
    if (winner === '引き分け') {
        gameResultTitle.textContent = '引き分け';
        gameResultMessage.textContent = `${reason}により引き分けとなりました。`;
        victoryCelebration.style.display = 'none';
    } else {
        gameResultTitle.textContent = `${winner}の勝利！`;
        gameResultMessage.textContent = `${reason}により${winner}の勝ちです。`;

        // 先手（プレイヤー）が勝った場合のみ祝福演出を表示
        const isPlayerWin = gameMode === 'ai' && winner === (playerSide === SENTE ? '先手' : '後手');
        if (isPlayerWin || gameMode === 'pvp') {
            victoryCelebration.style.display = 'block';

            // 絵文字エリアをクリアして個別アニメーション付きで再生成
            const emojiElement = document.querySelector('.celebration-emoji');
            if (emojiElement) {
                emojiElement.innerHTML = `
                    <span style="display: inline-block; animation: float1 2s ease-in-out infinite;">🎉</span>
                    <span style="display: inline-block; animation: float2 2s ease-in-out infinite 0.2s;">🎊</span>
                    <span style="display: inline-block; animation: float3 2s ease-in-out infinite 0.4s;">✨</span>
                `;
            }

            // レベル解放チェック（AIモードで勝利した場合）
            if (gameMode === 'ai') {
                const nextLevel = LEVEL_PROGRESSION[aiDifficulty];
                if (nextLevel && !isLevelUnlocked(nextLevel)) {
                    unlockLevel(nextLevel);
                    updateDifficultyOptions();
                    pendingUnlockedLevel = nextLevel;

                    // 解放ポップアップを表示
                    showLevelUnlockPopup(nextLevel);

                    // ボタンテキストを変更
                    if (newGameMainSpan) {
                        newGameMainSpan.textContent = '次のレベルへ';
                    }
                }
            }
        } else {
            victoryCelebration.style.display = 'none';
        }
    }

    // ダイアログを表示
    gameOverDialog.style.display = 'flex';

    // 最初の試合終了後にPWAインストールバナーを表示（少し遅延させる）
    setTimeout(() => {
        showPWAInstallBanner();
    }, 1500);
}

// 対戦開始オーバーレイ表示
function showMatchStartOverlay(side) {
    // 既存のオーバーレイがあれば削除
    const existing = document.getElementById('match-start-overlay');
    if (existing) existing.remove();

    const isSente = side === SENTE;
    const sideLabel = isSente ? '先手' : '後手';
    const sideClass = isSente ? 'sente' : 'gote';
    const icon = isSente ? '☗' : '☖';

    const overlay = document.createElement('div');
    overlay.id = 'match-start-overlay';
    overlay.innerHTML = `
        <div class="match-start-card">
            <div class="match-start-icon">${icon}</div>
            <div class="match-start-label">対戦開始</div>
            <div class="match-start-side ${sideClass}">あなたは${sideLabel}です</div>
            <div class="match-start-bar ${sideClass}"></div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 3秒後にフェードアウトして削除
    setTimeout(() => {
        overlay.classList.add('fade-out');
        setTimeout(() => {
            overlay.remove();
        }, 700);
    }, 3000);
}

// レベル解放ポップアップを表示
function showLevelUnlockPopup(level) {
    const levelNum = level.replace('legendary', '');
    const levelName = `伝説${levelNum}`;

    // 既存のポップアップがあれば削除
    const existingPopup = document.getElementById('level-unlock-popup');
    if (existingPopup) {
        existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'level-unlock-popup';
    popup.innerHTML = `
        <div class="unlock-popup-content">
            <div class="unlock-icon">🔓</div>
            <div class="unlock-title">新たなレベル解放！</div>
            <div class="unlock-level-name">${levelName}</div>
            <div class="unlock-message">さらなる高みへ！</div>
        </div>
    `;

    document.body.appendChild(popup);

    // 3.5秒後に自動で消える
    setTimeout(() => {
        popup.classList.add('fade-out');
        setTimeout(() => {
            popup.remove();
        }, 800);
    }, 3500);
}

// ゲーム終了ダイアログを閉じる
function hideGameOverDialog() {
    gameOverDialog.style.display = 'none';
}

// SNSシェア機能
function shareOnTwitter() {
    const winner = gameResultTitle.textContent;
    const moves = moveCount;
    const url = encodeURIComponent(window.location.href);
    const text = encodeURIComponent(`将棋Webで対局しました！\n\nーーー\n結果: ${winner}\n手数: ${moves}手\nーーー\n\n#将棋Web\n${url}`);
    const twitterUrl = `https://twitter.com/intent/tweet?text=${text}`;
    window.open(twitterUrl, '_blank');
}

function shareOnFacebook() {
    const url = encodeURIComponent(window.location.href);
    const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
    window.open(facebookUrl, '_blank');
}

function shareOnLine() {
    const winner = gameResultTitle.textContent;
    const moves = moveCount;
    const url = encodeURIComponent(window.location.href);
    const text = encodeURIComponent(`将棋Webで対局しました！\n結果: ${winner}\n手数: ${moves}手\n${window.location.href}`);
    const lineUrl = `https://social-plugins.line.me/lineit/share?url=${url}&text=${text}`;
    window.open(lineUrl, '_blank');
}

function copyLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        // コピー成功時の視覚的フィードバック
        const originalText = copyLinkButton.innerHTML;
        copyLinkButton.innerHTML = '<span class="share-icon">✓</span> コピーしました！';
        copyLinkButton.classList.add('copied');

        setTimeout(() => {
            copyLinkButton.innerHTML = originalText;
            copyLinkButton.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('リンクのコピーに失敗しました:', err);
        alert('リンクのコピーに失敗しました。');
    });
}

// イベントリスナーの設定
closeGameOverButton.addEventListener('click', hideGameOverDialog);
shareTwitterButton.addEventListener('click', shareOnTwitter);
shareFacebookButton.addEventListener('click', shareOnFacebook);
shareLineButton.addEventListener('click', shareOnLine);
copyLinkButton.addEventListener('click', copyLink);

// ページ読み込み時に初期化
// まずレベル解放状態を反映
updateDifficultyOptions();

// URLパラメータからモードを決定（mode=ai|pvp|online、未指定はai）
const urlParams = new URLSearchParams(window.location.search);
const urlMode = urlParams.get('mode');
const urlRoom = urlParams.get('room');

// roomパラメータがある場合はonlineモードとして扱う
if (urlRoom && urlRoom.trim() !== '') {
    gameMode = ONLINE_MODE;
} else if (urlMode === ONLINE_MODE) {
    gameMode = ONLINE_MODE;
} else if (urlMode === 'pvp') {
    gameMode = 'pvp';
} else {
    gameMode = 'ai';
}

if (gameMode === ONLINE_MODE) {
    loadPreferencesOnlyFromLocalStorage();
    modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === gameMode));
    aiSettingsElement.style.display = 'none';
    if (onlineSettingsElement) onlineSettingsElement.style.display = 'block';
    clearLocalStorage();
    initializeBoard();
    updateOnlineInviteUI();
    updateOnlineUiState();

    if (urlRoom && urlRoom.trim() !== '') {
        onlineJoinRoom(urlRoom);
    }
} else {
    // ai または pvp モード
    // localStorageから復元を試み、失敗したら新規ゲームを開始
    if (!loadFromLocalStorage()) {
        initializeBoard();
    }
    updateOnlineInviteUI();
    updateOnlineUiState();
}

// 表示モードが画像の場合は初期ロード時にプリロード
if (pieceDisplayMode === 'image') {
    preloadPieceImages();
}

// --- PWA インストールバナー ---
let deferredPrompt = null;
let hasShownInstallBanner = false;

// iOS検出
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isInStandaloneMode() {
    return window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
}

// beforeinstallpromptイベントをキャッチ
window.addEventListener('beforeinstallprompt', (e) => {
    // デフォルトのブラウザプロンプトを防止
    e.preventDefault();
    // イベントを保存して後で使用
    deferredPrompt = e;
    console.log('PWA install prompt captured');
});

// PWAインストールバナーを表示
function showPWAInstallBanner() {
    // 既に表示済みの場合はスキップ
    if (hasShownInstallBanner) {
        return;
    }

    // 既にインストール済みかチェック（standaloneモードで動作中）
    if (isInStandaloneMode()) {
        return;
    }

    // localStorageでバナーを閉じたかチェック
    const bannerDismissed = localStorage.getItem('pwa-banner-dismissed');
    if (bannerDismissed) {
        const dismissedTime = parseInt(bannerDismissed, 10);
        // 7日間は再表示しない
        if (Date.now() - dismissedTime < 7 * 24 * 60 * 60 * 1000) {
            return;
        }
    }

    // iOSの場合は専用モーダルを表示
    if (isIOS()) {
        showIOSInstallModal();
        hasShownInstallBanner = true;
        return;
    }

    // Android/PCの場合は通常のバナー（プロンプトがある場合のみ）
    if (!deferredPrompt) {
        return;
    }

    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
        banner.style.display = 'flex';
        hasShownInstallBanner = true;
    }
}

// iOSインストールモーダルを表示
function showIOSInstallModal() {
    const modal = document.getElementById('ios-install-modal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

// iOSインストールモーダルを非表示
function hideIOSInstallModal() {
    const modal = document.getElementById('ios-install-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// PWAインストールバナーを非表示
function hidePWAInstallBanner() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
        banner.style.display = 'none';
    }
}

// インストールボタンのイベントリスナー
document.addEventListener('DOMContentLoaded', () => {
    const installBtn = document.getElementById('pwa-install-btn');
    const closeBtn = document.getElementById('pwa-install-close');

    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) {
                return;
            }

            // インストールプロンプトを表示
            deferredPrompt.prompt();

            // ユーザーの選択を待つ
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`PWA install prompt outcome: ${outcome}`);

            // プロンプトは一度しか使えない
            deferredPrompt = null;
            hidePWAInstallBanner();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            hidePWAInstallBanner();
            // 閉じた時刻を保存（7日間は再表示しない）
            localStorage.setItem('pwa-banner-dismissed', Date.now().toString());
        });
    }

    // iOSモーダルのイベントリスナー
    const iosModalClose = document.getElementById('ios-modal-close');
    const iosModalOk = document.getElementById('ios-modal-ok');
    const iosModalOverlay = document.querySelector('.ios-modal-overlay');

    const closeIOSModal = () => {
        hideIOSInstallModal();
        // 閉じた時刻を保存（7日間は再表示しない）
        localStorage.setItem('pwa-banner-dismissed', Date.now().toString());
    };

    if (iosModalClose) {
        iosModalClose.addEventListener('click', closeIOSModal);
    }
    if (iosModalOk) {
        iosModalOk.addEventListener('click', closeIOSModal);
    }
    if (iosModalOverlay) {
        iosModalOverlay.addEventListener('click', closeIOSModal);
    }
});

// appinstalledイベント（インストール完了時）
window.addEventListener('appinstalled', () => {
    console.log('PWA was installed');
    hidePWAInstallBanner();
    deferredPrompt = null;
});
