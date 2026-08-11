// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab

const boardElement = document.getElementById('shogi-board');
const capturedWhiteLaneElement = document.getElementById('captured-white');
const capturedBlackLaneElement = document.getElementById('captured-black');
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

// ゲームモード。モードはURLのパスで表現し、1モード=1ページとして配信している
// （pages/pages.mjs と pages/legacy-redirect.mjs の定義と揃えること）。
// AI Worker を作るかどうかの判断に使うので、ここで先に確定させる。
const MODE_PATHS = {
    ai: '/',
    pvp: '/board/',
    online: '/online/',
    tsume: '/tsume/'
};

// MODE_PATHS から判定を導出するので、パスを変えるときは MODE_PATHS だけ直せばよい
function detectGameModeFromPath(pathname = window.location.pathname) {
    for (const [mode, path] of Object.entries(MODE_PATHS)) {
        if (path === '/') continue;
        const base = path.replace(/\/$/, '');
        if (pathname === base || pathname.startsWith(`${base}/`)) return mode;
    }
    return 'ai';
}

let gameMode = detectGameModeFromPath(); // 'ai' | 'pvp' | 'online'

// AI Workerの初期化
let aiWorker = null;
let yaneuraouWorker = null;
let yaneuraouReady = false;

// AI思考リクエストの管理（古い思考結果を無視するため）
let aiRequestId = 0;

// 難易度レベルの単一定義元（value・表示名・エンジン種別・解放条件）。
// エンジンの強さ設定は ai-worker.js / yaneuraou-worker.js 側が持つ。
const DIFFICULTY_LEVELS = [
    { value: 'easy', label: '初級', engine: 'standard' },
    { value: 'medium', label: '中級', engine: 'standard' },
    { value: 'hard', label: '上級', engine: 'standard' },
    { value: 'super', label: '超級', engine: 'standard' },
    { value: 'master', label: '達人級', engine: 'yaneuraou' },
    { value: 'great', label: '偉人級', engine: 'yaneuraou' },
    { value: 'transcendent', label: '超越級', engine: 'yaneuraou' },
    { value: 'legendary1', label: '伝説1', engine: 'yaneuraou', unlockedBy: 'transcendent' },
    { value: 'legendary2', label: '伝説2', engine: 'yaneuraou', unlockedBy: 'legendary1' },
    { value: 'legendary3', label: '伝説3', engine: 'yaneuraou', unlockedBy: 'legendary2' },
];

function getDifficultyDef(value) {
    return DIFFICULTY_LEVELS.find(l => l.value === value) || null;
}

function getDifficultyLabel(value) {
    const def = getDifficultyDef(value);
    return def ? def.label : value;
}

function isValidDifficulty(value) {
    return getDifficultyDef(value) !== null;
}

function isYaneuraouDifficulty(difficulty) {
    return getDifficultyDef(difficulty)?.engine === 'yaneuraou';
}

function getStandardAiDifficulty(difficulty) {
    return isYaneuraouDifficulty(difficulty) ? 'super' : difficulty;
}

function requestStandardAiMove(requestId, difficulty = aiDifficulty) {
    if (!aiWorker) return;

    aiWorker.postMessage({
        type: 'getBestMove',
        data: {
            board,
            capturedPieces,
            currentPlayer,
            moveCount,
            lastMoveDetail,
            aiDifficulty: getStandardAiDifficulty(difficulty),
            aiPlayer: getAIPlayer(),
            josekiEnabled,
            currentJosekiPattern,
            josekiMoveIndex,
            requestId
        }
    });
}

// AI思考中インジケータの表示/非表示。
// text を渡すと文言を差し替えられる（詰将棋の「玉方が応じています…」などに使う）。
// 省略時は対局用の「思考中」に戻すので、モードをまたいでも前の文言が残らない。
const AI_THINKING_DEFAULT_TEXT = '思考中';

function showAIThinkingIndicator(text) {
    if (!aiThinkingIndicator) return;
    const label = aiThinkingIndicator.querySelector('.thinking-text');
    if (label) label.textContent = text || AI_THINKING_DEFAULT_TEXT;
    aiThinkingIndicator.classList.add('visible');
}

function hideAIThinkingIndicator() {
    if (aiThinkingIndicator) {
        aiThinkingIndicator.classList.remove('visible');
    }
}

function scheduleYaneuraouWarmup() {
    const warmup = () => {
        if (yaneuraouWorker) {
            yaneuraouWorker.postMessage({ type: 'init' });
        }
    };

    const schedule = () => {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(() => {
                warmup();
            }, { timeout: 3000 });
            return;
        }

        window.setTimeout(warmup, 1500);
    };

    if (document.readyState === 'complete') {
        schedule();
        return;
    }

    window.addEventListener('load', schedule, { once: true });
}

// AIを使うのはAI対戦ページだけ。将棋盤・通信対戦のページでWorkerを起動すると、
// やねうら王のWASM（約1.4MB）を無駄にダウンロード・初期化してしまう。
if (window.Worker && gameMode === 'ai') {
    aiWorker = new Worker('/ai-worker.js');
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
        yaneuraouWorker = new Worker('/yaneuraou-worker.js');
        yaneuraouWorker.onmessage = function (e) {
            const { type, data, error, requestId } = e.data;
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

                if (requestId === undefined) {
                    yaneuraouReady = false;
                    if (yaneuraouWorker) {
                        yaneuraouWorker.terminate();
                        yaneuraouWorker = null;
                    }
                    return;
                }

                hideAIThinkingIndicator();

                if (requestId !== aiRequestId) {
                    console.log('Ignoring outdated YaneuraOu error (requestId mismatch)');
                    return;
                }

                requestStandardAiMove(requestId, aiDifficulty);
            }
        };
        yaneuraouWorker.onerror = function (error) {
            console.error('YaneuraOu Worker error:', error.message, error.filename, error.lineno);
            hideAIThinkingIndicator();
            yaneuraouReady = false;
            if (yaneuraouWorker) {
                yaneuraouWorker.terminate();
            }
            yaneuraouWorker = null; // Disable yaneuraou worker
        };

        // YaneuraOuの事前初期化は初期表示を邪魔しないタイミングで行う
        scheduleYaneuraouWarmup();
    } catch (e) {
        console.error('Failed to create YaneuraOu worker:', e);
        yaneuraouWorker = null;
    }
}

// ゲーム終了ダイアログの要素
const gameOverDialog = document.getElementById('game-over-dialog');
const gameOverContent = gameOverDialog.querySelector('.game-over-content');
const gameResultTitle = document.getElementById('game-result-title');
const gameResultMessage = document.getElementById('game-result-message');
const gameResultMeta = document.getElementById('game-result-meta');
const gameResultBoardPanel = document.getElementById('game-result-board-panel');
const gameResultBoardMount = document.getElementById('game-result-board-mount');
const shareTwitterButton = document.getElementById('share-twitter');
const shareFacebookButton = document.getElementById('share-facebook');
const shareLineButton = document.getElementById('share-line');
const copyLinkButton = document.getElementById('copy-link');
const newGameButton = document.getElementById('new-game-button');
const closeGameOverButton = document.getElementById('close-game-over');

let currentResultDialogState = createEmptyResultDialogState();
let resultCopyFeedbackTimerId = null;

// AI関連の要素
// #ai-settings の表示はページ生成時の body クラスで決まるためJSからは触らない
const modeTabs = document.querySelectorAll('.mode-tab');
const difficultyTrigger = document.getElementById('difficulty-trigger');
const difficultyTriggerValue = document.getElementById('difficulty-trigger-value');
const difficultyModal = document.getElementById('difficulty-modal');
const difficultyOptionsContainer = document.getElementById('difficulty-options');

// 通信対戦関連の要素（友達対戦カード）
const onlineSettingsElement = document.getElementById('online-settings');
const onlineStatusElement = document.getElementById('online-status');
const friendCopyInviteButton = document.getElementById('friend-copy-invite');
const friendQrButton = document.getElementById('friend-qr-button');
const friendInfoButton = document.getElementById('friend-info-button');
const friendActionsElement = document.querySelector('.friend-actions');
const friendSettingsElement = document.getElementById('friend-settings');
const friendSideRadios = document.querySelectorAll('input[name="friend-side"]');
const friendTimeTrigger = document.getElementById('friend-time-trigger');
const friendTimeTriggerValue = document.getElementById('friend-time-trigger-value');
const friendTimeModal = document.getElementById('friend-time-modal');
const friendTimeOptionButtons = friendTimeModal
    ? Array.from(friendTimeModal.querySelectorAll('.friend-time-option'))
    : [];
const friendQrModal = document.getElementById('friend-qr-modal');
const friendGuideModal = document.getElementById('friend-guide-modal');
const friendClockSente = document.getElementById('friend-clock-sente');
const friendClockGote = document.getElementById('friend-clock-gote');
const boardAreaElement = document.getElementById('board-area');

// 設定関連の要素
const pieceDisplayModeRadios = document.querySelectorAll('input[name="piece-display-mode"]');
const aiPlayerSideRadios = document.querySelectorAll('input[name="player-side"]');
const settingsIconButton = document.getElementById('settings-icon');
const settingsModal = document.getElementById('settings-modal');
const settingsModalCloseButton = document.getElementById('settings-modal-close');
const settingsModalBackdrop = settingsModal.querySelector('.settings-modal-backdrop');
const resignButton = document.getElementById('resign-button');

// メニュー・フィードバック関連の要素
const menuIconButton = document.getElementById('menu-icon');
const menuPanel = document.getElementById('menu-panel');
const menuFeedbackItem = document.getElementById('menu-feedback');
const feedbackModal = document.getElementById('feedback-modal');
const feedbackModalBackdrop = document.getElementById('feedback-modal-backdrop');
const feedbackModalCloseButton = document.getElementById('feedback-modal-close');
const feedbackForm = document.getElementById('feedback-form');
const feedbackTextarea = document.getElementById('feedback-message');
const feedbackCharCount = document.getElementById('feedback-char-count');
const feedbackErrorElement = document.getElementById('feedback-error');
const feedbackHoneypot = document.getElementById('feedback-website');
const feedbackSubmitButton = document.getElementById('feedback-submit');
const feedbackThanks = document.getElementById('feedback-thanks');
const feedbackThanksCloseButton = document.getElementById('feedback-thanks-close');


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

let aiDifficulty = 'medium'; // 'easy', 'medium', 'hard', 'super', 'master', 'great', 'transcendent', 'legendary1', 'legendary2', 'legendary3'
let aiPlayerSide = SENTE; // AI対戦でプレイヤーが担当する手番

// 駒の表示モード
let pieceDisplayMode = 'text'; // 'text' or 'image'

// --- 通信対戦 (online) ---
// Backend: Cloudflare Workers + Durable Objects (same origin, /api/*).
// Sync: WebSocket push (with HTTP polling as an automatic fallback).
const ONLINE_MODE = 'online';
const TSUME_MODE = 'tsume';

const ONLINE_API_BASE = '/api';
// 遅延ロードするQRライブラリ（build.shがハッシュ付きファイル名へ書き換える）
const QR_LIB_SRC = '/qrcode.js';
const FRIEND_SIDE_KEY = 'shogi_friend_side';
const FRIEND_TC_KEY = 'shogi_friend_tc';
const ONLINE_WS_PING_INTERVAL_MS = 10000;  // answered by the server without waking the room
const ONLINE_WS_PONG_TIMEOUT_MS = 25000;   // silence longer than this -> reconnect
const ONLINE_WS_MAX_BACKOFF_MS = 15000;
const ONLINE_WS_FAILS_BEFORE_POLLING = 2;
const ONLINE_POLL_INTERVAL_MS = 3000;

const onlineState = {
    roomCode: null,
    match: null,
    userId: null,
    side: null, // 'sente' | 'gote'
    token: null, // signed playerToken from the server
    appliedRevision: -1,
    ws: null,
    wsReady: false,
    wsFailures: 0,
    wsBackoffMs: 1000,
    wsReconnectTimer: null,
    wsPingTimer: null,
    wsLastPongAt: 0,
    wsReqCounter: 0,
    pendingWsRequests: new Map(),
    pollTimer: null,
    dcTicker: null,
    // Incremented whenever we leave a room (or otherwise invalidate online async work).
    // Used to ignore stale poll/WS/API results that can arrive after a room switch.
    roomEpoch: 0,
    submitting: false,
    lastUsiLen: 0,
    lastGameOverRevisionShown: null,
    matchStartShown: false,
    disconnectInfo: { side: null, deadline: null },
    // Optimistic UI: snapshot of board state before an optimistic move, for rollback if server rejects.
    optimisticSnapshot: null,
    // 友達対戦: 時計とロビー設定
    serverSkewMs: 0,      // Date.parse(match.server_now) - 受信時のDate.now()
    clockTicker: null,    // 持ち時間表示の更新タイマー（~250ms）
    settingsBusy: false,  // /settings POST の直列化＋コントロール無効化
    joining: false,       // 招待URLからの参加処理中
};

let _onlineStatusDotsTimer = null;

function isOnlineMode() {
    return gameMode === ONLINE_MODE;
}

// 両席が埋まっていれば対局開始済み（作成者が後手席の場合があるため、
// gote_joined 単独では開始判定にならない）
function isMatchStarted(match) {
    return Boolean(match?.sente_joined && match?.gote_joined);
}

function _clearOnlineStatusDots() {
    if (_onlineStatusDotsTimer) {
        clearInterval(_onlineStatusDotsTimer);
        _onlineStatusDotsTimer = null;
    }
}

function setOnlineStatus(text) {
    if (!onlineStatusElement) return;
    _clearOnlineStatusDots();
    if (text === '接続中…') {
        let dotCount = 1;
        onlineStatusElement.textContent = '接続中.';
        _onlineStatusDotsTimer = setInterval(() => {
            dotCount = (dotCount % 3) + 1;
            onlineStatusElement.textContent = '接続中' + '.'.repeat(dotCount);
        }, 800);
    } else {
        onlineStatusElement.textContent = text || '';
    }
}

function getInviteUrl(roomCode) {
    const url = new URL(MODE_PATHS[ONLINE_MODE], window.location.href);
    url.searchParams.set('room', roomCode);
    return url.toString();
}

// ---- 友達対戦: 手番/持ち時間の設定コントロール ----

function getFriendSidePref() {
    for (const r of friendSideRadios) {
        if (r.checked) return r.value;
    }
    return 'sente';
}

function setFriendSidePref(value) {
    let matched = false;
    friendSideRadios.forEach(r => {
        const hit = r.value === value;
        r.checked = hit;
        if (hit) matched = true;
    });
    if (!matched) {
        friendSideRadios.forEach(r => { r.checked = r.value === 'sente'; });
    }
}

// ---- 持ち時間セレクター（押すと選択モーダルが開く） ----
// 値は旧<select>と同じ 'none' | 'total:600' | 'per_move:30' ... 形式
// （localStorageの保存値と後方互換）。ラベルはトリガーの現在値表示に使う。
// 値の一覧はサーバーのTC_ALLOWED（match_room.ts）と同一。

const FRIEND_TC_OPTIONS = {
    'none': '時間制限なし',
    'total:180': '切れ負け 3分',
    'total:300': '切れ負け 5分',
    'total:600': '切れ負け 10分',
    'per_move:10': '1手10秒',
    'per_move:30': '1手30秒',
    'per_move:60': '1手1分',
};

let friendTcValue = 'none';

function isValidFriendTcValue(value) {
    return Object.prototype.hasOwnProperty.call(FRIEND_TC_OPTIONS, value);
}

// トリガーの現在値ラベルとモーダル内の選択ハイライトを反映
function renderFriendTcUi() {
    if (friendTimeTriggerValue) {
        friendTimeTriggerValue.textContent = FRIEND_TC_OPTIONS[friendTcValue] || FRIEND_TC_OPTIONS.none;
    }
    friendTimeOptionButtons.forEach(btn => {
        const selected = btn.dataset.tcValue === friendTcValue;
        btn.classList.toggle('is-selected', selected);
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
}

function getFriendTcValue() {
    return friendTcValue;
}

function setFriendTcValue(value) {
    if (!isValidFriendTcValue(value)) return;
    friendTcValue = value;
    renderFriendTcUi();
}

// セレクターの値 'none' | 'total:600' | 'per_move:30' ... をAPI形式へ
function getFriendTcPref() {
    const v = getFriendTcValue();
    if (v === 'none') return { type: 'none', seconds: 0 };
    const [type, s] = v.split(':');
    const seconds = Number(s) || 0;
    if ((type !== 'total' && type !== 'per_move') || seconds <= 0) {
        return { type: 'none', seconds: 0 };
    }
    return { type, seconds };
}

function saveFriendPrefs() {
    try {
        localStorage.setItem(FRIEND_SIDE_KEY, getFriendSidePref());
        localStorage.setItem(FRIEND_TC_KEY, getFriendTcValue());
    } catch (_) { /* ignore */ }
}

function loadFriendPrefs() {
    try {
        const side = localStorage.getItem(FRIEND_SIDE_KEY);
        if (side === 'sente' || side === 'gote' || side === 'random') {
            setFriendSidePref(side);
        }
        const tc = localStorage.getItem(FRIEND_TC_KEY);
        if (tc && isValidFriendTcValue(tc)) {
            friendTcValue = tc;
        }
    } catch (_) { /* ignore */ }
    renderFriendTcUi();
}

function setFriendControlsDisabled(disabled) {
    friendSideRadios.forEach(r => { r.disabled = disabled; });
    if (friendTimeTrigger) friendTimeTrigger.disabled = disabled;
    friendTimeOptionButtons.forEach(btn => { btn.disabled = disabled; });
}

// 部屋がある間はサーバー保存値が正（リロード復元・多タブ同期）
function syncFriendControlsFromMatch() {
    const match = onlineState.match;
    if (!match || isMatchStarted(match) || onlineState.settingsBusy) return;
    if (match.side_pref === 'sente' || match.side_pref === 'gote' || match.side_pref === 'random') {
        setFriendSidePref(match.side_pref);
    }
    const tcValue = (!match.tc_type || match.tc_type === 'none')
        ? 'none'
        : `${match.tc_type}:${match.tc_seconds}`;
    if (isValidFriendTcValue(tcValue)) {
        setFriendTcValue(tcValue);
    }
}

// ---- 友達対戦: 対局時計の表示（サーバー権威、ここは表示のみ） ----

function formatClockMs(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stopClockTicker() {
    if (onlineState.clockTicker) {
        clearInterval(onlineState.clockTicker);
        onlineState.clockTicker = null;
    }
}

function startClockTicker() {
    if (!onlineState.clockTicker) {
        onlineState.clockTicker = setInterval(updateClockUi, 250);
    }
}

function updateClockUi() {
    if (!friendClockSente || !friendClockGote || !boardAreaElement) return;
    const match = onlineState.match;
    const timed = isOnlineMode() && match && match.tc_type && match.tc_type !== 'none'
        && isMatchStarted(match);
    boardAreaElement.classList.toggle('has-clocks', Boolean(timed));
    friendClockSente.hidden = !timed;
    friendClockGote.hidden = !timed;
    if (!timed) {
        stopClockTicker();
        return;
    }

    const allowanceMs = (match.tc_seconds || 0) * 1000;
    const deadlineMs = match.turn_deadline ? Date.parse(match.turn_deadline) : NaN;
    const turn = currentPlayer; // applyOnlineMatch がサーバー状態を反映済み

    // 手番側の残り時間はdeadline基準（server_nowでスキュー補正）。
    // 開始バッファ中に名目値を超えて見えないよう上限でクランプする。
    let activeRemainMs = 0;
    if (!match.game_over && Number.isFinite(deadlineMs)) {
        activeRemainMs = deadlineMs - (Date.now() + onlineState.serverSkewMs);
        const cap = match.tc_type === 'total'
            ? ((turn === SENTE ? match.sente_time_ms : match.gote_time_ms) ?? allowanceMs)
            : allowanceMs;
        activeRemainMs = Math.min(activeRemainMs, cap);
    }

    const renderSide = (el, side) => {
        const isTurn = !match.game_over && side === turn;
        let ms;
        if (match.tc_type === 'total') {
            const bank = (side === SENTE ? match.sente_time_ms : match.gote_time_ms) ?? 0;
            ms = isTurn ? activeRemainMs : bank;
        } else {
            ms = isTurn ? activeRemainMs : allowanceMs;
        }
        el.textContent = formatClockMs(ms);
        el.classList.toggle('active', isTurn);
        el.classList.toggle('low', isTurn && ms < 10000);
    };
    renderSide(friendClockSente, SENTE);
    renderSide(friendClockGote, GOTE);

    // 0:00表示のままサーバーの終局通知（WS/ポーリング）を待つ。自滅はしない。
    if (!match.game_over) {
        startClockTicker();
    } else {
        stopClockTicker();
    }
}

function getOnlineUid() {
    let uid = null;
    try { uid = localStorage.getItem('shogi_online_uid'); } catch (_) { /* ignore */ }
    if (!uid || !/^[0-9a-zA-Z-]{8,64}$/.test(uid)) {
        uid = (crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        try { localStorage.setItem('shogi_online_uid', uid); } catch (_) { /* ignore */ }
    }
    onlineState.userId = uid;
    return uid;
}

// API error responses with a JSON body are returned as
// { ok: false, error: { code } }; only network-level failures throw.
async function onlineApi(path, { method = 'GET', body = null } = {}) {
    const headers = {};
    if (onlineState.token) headers['Authorization'] = 'Bearer ' + onlineState.token;
    const options = { method, headers };
    if (body !== null) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const res = await fetch(ONLINE_API_BASE + path, options);
    const json = await res.json().catch(() => null);
    if (json) return json;
    throw new Error(`online_api_${res.status}`);
}

function _rejectPendingWsRequests(reason) {
    for (const pending of onlineState.pendingWsRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
    onlineState.pendingWsRequests.clear();
}

function stopWsPing() {
    if (onlineState.wsPingTimer) {
        clearInterval(onlineState.wsPingTimer);
        onlineState.wsPingTimer = null;
    }
}

function startWsPing() {
    stopWsPing();
    onlineState.wsLastPongAt = Date.now();
    onlineState.wsPingTimer = setInterval(() => {
        const ws = onlineState.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - onlineState.wsLastPongAt > ONLINE_WS_PONG_TIMEOUT_MS) {
            // Connection is silently dead; closing triggers the reconnect path.
            try { ws.close(); } catch (_) { /* ignore */ }
            return;
        }
        try { ws.send('ping'); } catch (_) { /* ignore */ }
    }, ONLINE_WS_PING_INTERVAL_MS);
}

function stopOnlineWs() {
    if (onlineState.wsReconnectTimer) {
        clearTimeout(onlineState.wsReconnectTimer);
        onlineState.wsReconnectTimer = null;
    }
    stopWsPing();
    const ws = onlineState.ws;
    onlineState.ws = null;
    onlineState.wsReady = false;
    _rejectPendingWsRequests(new Error('ws_closed'));
    if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
    }
}

function stopOnlinePolling() {
    if (onlineState.pollTimer) {
        clearInterval(onlineState.pollTimer);
        onlineState.pollTimer = null;
    }
}

async function onlinePollOnce(epoch) {
    const roomCode = onlineState.roomCode;
    if (!roomCode || onlineState.roomEpoch !== epoch) return;
    if (onlineState.match?.game_over) {
        stopOnlinePolling();
        return;
    }
    try {
        const res = await onlineApi(`/rooms/${roomCode}/state`);
        if (onlineState.roomEpoch !== epoch || onlineState.roomCode !== roomCode) return;
        if (res?.ok && res.match) {
            applyOnlineMatch(res.match, {
                source: 'poll',
                roomEpoch: epoch,
                expectedRoomCode: roomCode,
                disconnect: res.disconnect || null,
                yourSide: res.yourSide || null,
            });
        } else if (res?.ok === false && res?.error?.code === 'not_found') {
            await onlineLeaveRoom({ resignIfActive: false });
            alert('部屋の有効期限が切れました。');
        }
    } catch (e) {
        // Poll errors are non-fatal; user may be temporarily offline.
    }
}

// HTTP fallback for networks where WebSocket is blocked.
function startOnlinePolling() {
    if (onlineState.pollTimer) return;
    const epoch = onlineState.roomEpoch;
    onlineState.pollTimer = setInterval(() => { onlinePollOnce(epoch); }, ONLINE_POLL_INTERVAL_MS);
    onlinePollOnce(epoch);
}

function _handleWsFailure(epoch) {
    if (onlineState.roomEpoch !== epoch || !onlineState.roomCode || !onlineState.token) return;
    if (onlineState.match?.game_over) return;
    if (onlineState.wsReconnectTimer) return;
    onlineState.wsFailures += 1;
    if (onlineState.wsFailures >= ONLINE_WS_FAILS_BEFORE_POLLING) {
        startOnlinePolling();
    }
    const delay = onlineState.wsBackoffMs;
    onlineState.wsBackoffMs = Math.min(delay * 2, ONLINE_WS_MAX_BACKOFF_MS);
    onlineState.wsReconnectTimer = setTimeout(() => {
        onlineState.wsReconnectTimer = null;
        if (onlineState.roomEpoch !== epoch) return;
        onlineConnectWs();
    }, delay);
}

function _handleWsServerMessage(msg, epoch, roomCode) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state' && msg.match) {
        applyOnlineMatch(msg.match, {
            source: 'ws',
            roomEpoch: epoch,
            expectedRoomCode: roomCode,
            disconnect: msg.disconnect || null,
            yourSide: msg.yourSide || null,
        });
        return;
    }
    if (msg.type === 'ack' && typeof msg.reqId === 'number') {
        const pending = onlineState.pendingWsRequests.get(msg.reqId);
        if (pending) {
            onlineState.pendingWsRequests.delete(msg.reqId);
            clearTimeout(pending.timer);
            pending.resolve(msg);
        }
        return;
    }
    if (msg.type === 'expired') {
        onlineLeaveRoom({ resignIfActive: false }).then(() => {
            alert('部屋の有効期限が切れました。');
        });
    }
}

function onlineConnectWs() {
    const roomCode = onlineState.roomCode;
    const token = onlineState.token;
    if (!roomCode || !token) return;
    const epoch = onlineState.roomEpoch;
    stopOnlineWs();

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}${ONLINE_API_BASE}/rooms/${roomCode}/ws?token=${encodeURIComponent(token)}`;
    let ws;
    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        _handleWsFailure(epoch);
        return;
    }
    onlineState.ws = ws;

    ws.onopen = () => {
        if (onlineState.roomEpoch !== epoch || onlineState.ws !== ws) return;
        onlineState.wsReady = true;
        onlineState.wsFailures = 0;
        onlineState.wsBackoffMs = 1000;
        stopOnlinePolling();
        startWsPing();
    };
    ws.onmessage = (event) => {
        if (onlineState.roomEpoch !== epoch || onlineState.ws !== ws) return;
        if (event.data === 'pong') {
            onlineState.wsLastPongAt = Date.now();
            return;
        }
        let msg = null;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        _handleWsServerMessage(msg, epoch, roomCode);
    };
    ws.onclose = () => {
        // If this socket was already replaced (reconnect) or intentionally
        // closed (leave room), it must not schedule another reconnect.
        if (onlineState.ws !== ws) return;
        onlineState.ws = null;
        onlineState.wsReady = false;
        stopWsPing();
        _rejectPendingWsRequests(new Error('ws_closed'));
        _handleWsFailure(epoch);
    };
    ws.onerror = () => { /* onclose fires next */ };
}

// Send a move/resign over the WebSocket and await the server's ack.
function onlineWsRequest(payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const ws = onlineState.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || !onlineState.wsReady) {
            reject(new Error('ws_not_open'));
            return;
        }
        const reqId = ++onlineState.wsReqCounter;
        const timer = setTimeout(() => {
            onlineState.pendingWsRequests.delete(reqId);
            reject(new Error('ws_timeout'));
        }, timeoutMs);
        onlineState.pendingWsRequests.set(reqId, { resolve, reject, timer });
        try {
            ws.send(JSON.stringify({ ...payload, reqId }));
        } catch (e) {
            onlineState.pendingWsRequests.delete(reqId);
            clearTimeout(timer);
            reject(e);
        }
    });
}

// While the opponent is disconnected, re-render the countdown every second
// (the deadline itself is pushed by the server).
function refreshDisconnectTicker() {
    const active = isOnlineMode()
        && Boolean(onlineState.disconnectInfo?.deadline)
        && !onlineState.match?.game_over;
    if (active && !onlineState.dcTicker) {
        onlineState.dcTicker = setInterval(() => { updateOnlineUiState(); }, 1000);
    } else if (!active && onlineState.dcTicker) {
        clearInterval(onlineState.dcTicker);
        onlineState.dcTicker = null;
    }
}

// Mobile browsers drop the socket on tab switch / screen lock; reconnect
// immediately when the page becomes visible again.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!isOnlineMode() || !onlineState.roomCode || !onlineState.token) return;
    if (onlineState.match?.game_over) return;
    const ws = onlineState.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (onlineState.wsReconnectTimer) {
        clearTimeout(onlineState.wsReconnectTimer);
        onlineState.wsReconnectTimer = null;
    }
    onlineState.wsBackoffMs = 1000;
    onlineConnectWs();
});

function setUrlRoom(roomCodeOrNull) {
    const url = new URL(window.location.href);
    if (roomCodeOrNull) {
        url.searchParams.set('room', roomCodeOrNull);
    } else {
        url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
}

// The server tells each connection its own side (`yourSide`); uids are never
// sent to clients (the uid doubles as the reconnect credential).

function playMoveSoundIfNeeded(prevUsiLen, nextUsiLen) {
    if (typeof piecePlacementSound === 'undefined') return;
    if (nextUsiLen > prevUsiLen) {
        piecePlacementSound.currentTime = 0;
        piecePlacementSound.play().catch(() => { });
    }
}

function normalizeDisconnectInfo(source) {
    const sideRaw = source?.side;
    const deadlineRaw = source?.deadline;
    const side = (sideRaw === SENTE || sideRaw === GOTE) ? sideRaw : null;
    const deadline = typeof deadlineRaw === 'string' ? deadlineRaw : null;
    return { side, deadline };
}

function disconnectInfoFromMatch(match) {
    if (!match) return { side: null, deadline: null };
    return normalizeDisconnectInfo({
        side: match.disconnect_side,
        deadline: match.disconnect_deadline,
    });
}

function applyOnlineMatch(match, { source, roomEpoch, expectedRoomCode, disconnect, yourSide } = {}) {
    if (!match) return;
    if (!isOnlineMode()) return;

    // Ignore stale async results (e.g. poll/WS/API) that arrive after leaving a room.
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
    // サーバー時刻とのズレを記録（時計表示のスキュー補正に使用）
    if (match.server_now) {
        const serverNowMs = Date.parse(match.server_now);
        if (Number.isFinite(serverNowMs)) {
            onlineState.serverSkewMs = serverNowMs - Date.now();
        }
    }
    if (yourSide === SENTE || yourSide === GOTE) {
        onlineState.side = yourSide;
        // The assigned online side controls orientation independently of the AI preference.
        // Apply it even when the authoritative board revision has not changed.
        applyBoardOrientation();
    }
    onlineState.disconnectInfo = disconnect
        ? normalizeDisconnectInfo(disconnect)
        : disconnectInfoFromMatch(match);
    if (match.game_over) {
        stopOnlinePolling();
        onlineState.disconnectInfo = { side: null, deadline: null };
    }

    const nextRevision = typeof match.revision === 'number' ? match.revision : 0;
    const state = match.state || null;

    // If a server push or polling update arrives while an optimistic move is pending,
    // clear the snapshot because the authoritative state will overwrite it.
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
        // Even if the revision did not change, reflect authoritative game-over state.
        gameOver = Boolean(match.game_over);
    }

    syncFriendControlsFromMatch();
    updateOnlineUiState();
    refreshDisconnectTicker();

    // 対戦開始オーバーレイ（両者揃った瞬間に1回だけ表示）
    if (isMatchStarted(match) && onlineState.side && !onlineState.matchStartShown && !match.game_over) {
        onlineState.matchStartShown = true;
        closeFriendModals(); // QRモーダル等が開いたままなら閉じる
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
        case 'timeout': return '時間切れ';
        default: return '終局';
    }
}

function showOnlineGameOver(match) {
    const winner = match.winner;
    const reason = mapResultReason(match.result_reason);

    // Google Analytics: 通信対戦の終局イベントを送信
    if (typeof gtag === 'function') {
        const playerResult = winner === 'draw' ? 'draw'
            : winner === onlineState.side ? 'win' : 'lose';
        gtag('event', 'online_match_end', {
            result_reason: match.result_reason || 'unknown',
            winner: winner || 'draw',
            player_result: playerResult,
            move_count: match.state?.moveCount || 0,
        });
    }

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

    const matchStarted = isMatchStarted(onlineState.match);
    const matchActive = matchStarted && !onlineState.match?.game_over;

    // Lobby – the board area (with move counter / controls) stays hidden via CSS
    // until both players have joined.
    document.body.classList.toggle('online-lobby', isOnlineMode() && !matchStarted);

    // Board cursor – show not-allowed cursor before the match starts in online mode.
    boardElement.classList.toggle('online-waiting', isOnlineMode() && !matchStarted);

    // Settings visibility – hide the entire panel once both players have joined.
    // It stays hidden even after game_over; it reappears when the user leaves the room.
    if (isOnlineMode() && !matchStarted) {
        onlineSettingsElement.style.display = 'block';
    } else {
        onlineSettingsElement.style.display = 'none';
    }

    // 招待URLから参加中の側には設定・招待ボタンを出さない（ステータスのみ）
    const hideFriendControls = Boolean(onlineState.joining);
    if (friendActionsElement) {
        friendActionsElement.style.display = hideFriendControls ? 'none' : '';
    }
    if (friendSettingsElement) {
        friendSettingsElement.style.display = hideFriendControls ? 'none' : '';
    }

    // Resign button only when a game is active (both joined and not ended)
    resignButton.style.display = (isOnlineMode() && matchActive) ? 'inline-block' : 'none';

    // The AI preference remains editable in every mode and never changes the online side.
    aiPlayerSideRadios.forEach(r => { r.disabled = false; });

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
        const dcInfo = onlineState.disconnectInfo || { side: null, deadline: null };
        if (onlineState.joining) {
            setOnlineStatus('接続中…');
        } else if (!onlineState.roomCode) {
            setOnlineStatus('招待URLをコピーするか、QRコードで友達を招待できます。');
        } else if (match && !isMatchStarted(match)) {
            setOnlineStatus('招待URLを相手に共有してください。相手が参加すると自動で対局が始まります。');
        } else if (match && onlineState.side && !match.game_over) {
            const mySideJa = onlineState.side === SENTE ? '先手' : '後手';
            const turnJa = (currentPlayer === onlineState.side) ? 'あなたの手番です。' : '相手の手番です。';
            let extra = '';
            if (dcInfo.side && dcInfo.deadline) {
                const deadlineMs = Date.parse(dcInfo.deadline);
                if (Number.isFinite(deadlineMs)) {
                    const remainSec = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
                    const sideJa = dcInfo.side === SENTE ? '先手' : '後手';
                    const subject = (onlineState.side && dcInfo.side === onlineState.side) ? 'あなた' : '相手';
                    extra = `（${subject}(${sideJa})が切断中: 残り${remainSec}秒）`;
                }
            }
            setOnlineStatus(`${mySideJa}として参加中。${turnJa} ${extra}`.trim());
        }
    }

    updateClockUi();
}

// 部屋の遅延作成: 招待URLコピー／QRボタンの初回押下時に、その時点の
// 設定（手番・持ち時間）で部屋を作る。作成済みなら何もしない。
async function ensureFriendRoom() {
    if (onlineState.roomCode && onlineState.token) return true;
    if (onlineState.submitting) return false;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;
    try {
        setOnlineStatus('接続中…');
        const uid = getOnlineUid();
        const res = await onlineApi('/rooms', {
            method: 'POST',
            body: { uid, side: getFriendSidePref(), tc: getFriendTcPref() },
        });
        if (onlineState.roomEpoch !== epoch) return false;
        if (!res?.ok || !res.match || !res.token) throw new Error(res?.error?.code || 'create_room_failed');
        onlineState.token = res.token;
        onlineState.roomCode = res.match.room_code;
        setUrlRoom(res.match.room_code);
        applyOnlineMatch(res.match, {
            source: 'create',
            roomEpoch: epoch,
            expectedRoomCode: res.match.room_code,
            disconnect: res.disconnect || null,
            yourSide: res.yourSide || null,
        });
        onlineConnectWs();
        return true;
    } catch (e) {
        console.error('ensureFriendRoom failed:', e);
        if (onlineState.roomEpoch === epoch) {
            alert('部屋の作成に失敗しました。通信状況を確認して再試行してください。');
        }
        return false;
    } finally {
        onlineState.submitting = false;
        updateOnlineUiState();
    }
}

// 設定変更をサーバーへ同期。部屋作成前はlocalStorage保存のみ。
// 手番が変わった場合はサーバーが席を移動して旧WSを4001で閉じるため、
// 返却された新トークンに差し替えて再接続する。
async function onFriendSettingsChanged() {
    saveFriendPrefs();
    if (!onlineState.roomCode || !onlineState.token) return;
    if (isMatchStarted(onlineState.match)) return; // 参加後は変更不可（UIも非表示）
    if (onlineState.settingsBusy) return;
    const epoch = onlineState.roomEpoch;
    const roomCode = onlineState.roomCode;
    const prevSide = onlineState.side;
    onlineState.settingsBusy = true;
    setFriendControlsDisabled(true);
    try {
        const res = await onlineApi(`/rooms/${encodeURIComponent(roomCode)}/settings`, {
            method: 'POST',
            body: { side: getFriendSidePref(), tc: getFriendTcPref() },
        });
        if (onlineState.roomEpoch !== epoch || onlineState.roomCode !== roomCode) return;
        if (res?.ok && res.match) {
            if (res.token) onlineState.token = res.token; // 再接続より先に差し替える
            applyOnlineMatch(res.match, {
                source: 'settings',
                roomEpoch: epoch,
                expectedRoomCode: roomCode,
                disconnect: res.disconnect || null,
                yourSide: res.yourSide || null,
            });
            if (res.yourSide && res.yourSide !== prevSide) {
                onlineConnectWs();
            }
        } else if (res?.error?.code === 'match_started') {
            // 変更中に相手が参加した: 最新状態を取り直して対局へ
            const latest = await onlineApi(`/rooms/${encodeURIComponent(roomCode)}/state`);
            if (onlineState.roomEpoch === epoch && latest?.ok && latest.match) {
                applyOnlineMatch(latest.match, {
                    source: 'refresh',
                    roomEpoch: epoch,
                    expectedRoomCode: roomCode,
                    disconnect: latest.disconnect || null,
                    yourSide: latest.yourSide || null,
                });
            }
        } else {
            alert('設定の変更に失敗しました。通信状況を確認してください。');
        }
    } catch (e) {
        console.error('onFriendSettingsChanged failed:', e);
        alert('設定の変更に失敗しました。通信状況を確認してください。');
    } finally {
        onlineState.settingsBusy = false;
        setFriendControlsDisabled(false);
        syncFriendControlsFromMatch(); // サーバー保存値へ表示を合わせ直す
        updateOnlineUiState();
    }
}

async function onlineJoinRoom(roomCode) {
    if (onlineState.submitting) return;
    const epoch = onlineState.roomEpoch;
    onlineState.submitting = true;
    onlineState.joining = true; // 参加中はカードをステータス表示のみにする
    updateOnlineUiState();
    try {
        setOnlineStatus('接続中…');
        const uid = getOnlineUid();
        const normalizedCode = String(roomCode || '').trim().toUpperCase();
        const res = await onlineApi(`/rooms/${encodeURIComponent(normalizedCode)}/join`, {
            method: 'POST',
            body: { uid },
        });
        if (onlineState.roomEpoch !== epoch) return;
        if (!res?.ok || !res.match || !res.token) throw new Error(res?.error?.code || 'join_room_failed');
        onlineState.token = res.token;
        onlineState.roomCode = res.match.room_code;
        setUrlRoom(res.match.room_code);
        applyOnlineMatch(res.match, {
            source: 'join',
            roomEpoch: epoch,
            expectedRoomCode: res.match.room_code,
            disconnect: res.disconnect || null,
            yourSide: res.yourSide || null,
        });
        // The WebSocket pushes the latest state immediately after connecting,
        // so no extra state request is needed.
        onlineConnectWs();
    } catch (e) {
        console.error('onlineJoinRoom failed:', e);
        alert('参加に失敗しました。URLが正しいか確認してください。');
    } finally {
        onlineState.submitting = false;
        onlineState.joining = false;
        updateOnlineUiState();
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
        let res;
        if (onlineState.wsReady && onlineState.ws?.readyState === WebSocket.OPEN) {
            try {
                res = await onlineWsRequest({ type: 'move', expectedRevision, move });
            } catch (wsErr) {
                // WS dropped mid-request: retry once over HTTP. If the move was
                // already applied, the server answers revision_conflict and the
                // authoritative state (which contains our move) is re-applied.
                res = await onlineApi(`/rooms/${roomCode}/move`, {
                    method: 'POST',
                    body: { expectedRevision, move },
                });
            }
        } else {
            res = await onlineApi(`/rooms/${roomCode}/move`, {
                method: 'POST',
                body: { expectedRevision, move },
            });
        }
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
            let latestMatch = res?.match || null;
            let latestDisconnect = res?.disconnect || null;
            if (!latestMatch) {
                const latestRes = await onlineApi(`/rooms/${roomCode}/state`);
                latestMatch = latestRes?.match || null;
                latestDisconnect = latestRes?.disconnect || null;
            }
            if (latestMatch) {
                applyOnlineMatch(latestMatch, {
                    source: 'refresh',
                    roomEpoch: epoch,
                    expectedRoomCode: roomCode,
                    disconnect: latestDisconnect,
                });
            }
        }
    } catch (e) {
        console.error('onlineSubmitMove failed:', e);
        // Rollback optimistic move on network error.
        rollbackOptimisticMove();
        alert('手の送信に失敗しました。通信状況を確認してください。');
        try {
            const latest = await onlineApi(`/rooms/${roomCode}/state`);
            if (latest?.ok && latest.match) {
                applyOnlineMatch(latest.match, {
                    source: 'refresh',
                    roomEpoch: epoch,
                    expectedRoomCode: roomCode,
                    disconnect: latest.disconnect || null,
                });
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
        let res;
        if (onlineState.wsReady && onlineState.ws?.readyState === WebSocket.OPEN) {
            try {
                res = await onlineWsRequest({ type: 'resign', expectedRevision });
            } catch (wsErr) {
                res = await onlineApi(`/rooms/${roomCode}/resign`, {
                    method: 'POST',
                    body: { expectedRevision },
                });
            }
        } else {
            res = await onlineApi(`/rooms/${roomCode}/resign`, {
                method: 'POST',
                body: { expectedRevision },
            });
        }
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
        if (resignIfActive && isMatchStarted(onlineState.match) && !onlineState.match?.game_over) {
            await onlineResign();
        }
    } finally {
        stopOnlineWs();
        stopOnlinePolling();
        stopClockTicker();
        onlineState.submitting = false;
        onlineState.roomCode = null;
        onlineState.match = null;
        onlineState.side = null;
        onlineState.token = null;
        onlineState.wsFailures = 0;
        onlineState.wsBackoffMs = 1000;
        onlineState.appliedRevision = -1;
        onlineState.lastUsiLen = 0;
        onlineState.lastGameOverRevisionShown = null;
        onlineState.matchStartShown = false;
        onlineState.disconnectInfo = { side: null, deadline: null };
        onlineState.optimisticSnapshot = null;
        onlineState.serverSkewMs = 0;
        onlineState.settingsBusy = false;
        onlineState.joining = false;
        setFriendControlsDisabled(false);
        refreshDisconnectTicker();
        setUrlRoom(null);
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

function getPieceDisplayLabel(pieceType, owner) {
    if (pieceType === KING) {
        return owner === SENTE ? '玉' : '王';
    }
    return pieceNames[pieceType] || '?';
}

// ゲーム状態
let board = []; // 9x9の盤面, board[y][x] = { type: 'FU', owner: 'sente' } or null
let capturedPieces = {
    [SENTE]: {}, // { 'FU': 1, 'KY': 0, ... }
    [GOTE]: {}
};
let currentPlayer = SENTE;
let moveCount = 0;
let selectedPiece = null; // { x, y, piece } (盤上) or { owner, type } (持ち駒)
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
    hidePromoteDialog(); // 成り選択ダイアログが開いたままなら保留手ごと破棄
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
    if (count >= 4) {
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

    // 成り選択が残っていれば破棄（古い保留手が復元後の盤面に適用されるのを防ぐ）
    hidePromoteDialog();

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

// AI対戦の履歴移動では、AI手番や終局済みの局面に着地すると操作不能になる。
// そのため前後いずれも、対局中かつ人間手番の局面だけを移動先にする。
function findAiModeHistoryTargetIndex(fromIndex, direction) {
    for (
        let index = fromIndex + direction;
        index >= 0 && index < moveHistory.length;
        index += direction
    ) {
        const state = moveHistory[index];
        if (state && !state.gameOver && state.currentPlayer === aiPlayerSide) {
            return index;
        }
    }
    return -1;
}

// 詰将棋の「待った」は攻方の手と玉方の応手をまとめて戻す。
// 玉方の手番で止まると、玉方は自動で応じる側なので操作できなくなる。
function findTsumeHistoryTargetIndex(fromIndex, direction) {
    for (
        let index = fromIndex + direction;
        index >= 0 && index < moveHistory.length;
        index += direction
    ) {
        const state = moveHistory[index];
        if (state && state.currentPlayer === SENTE) return index;
    }
    return -1;
}

function historyTargetIndex(direction) {
    if (gameMode === 'ai') return findAiModeHistoryTargetIndex(currentHistoryIndex, direction);
    if (gameMode === TSUME_MODE) return findTsumeHistoryTargetIndex(currentHistoryIndex, direction);
    return currentHistoryIndex + direction;
}

function undoMove() {
    // 成り選択中の「待った」は保留中の手のキャンセルとして扱う（盤面・履歴は未更新のため閉じるだけでよい）
    if (promoteMoveInfo) {
        hidePromoteDialog();
        clearSelection();
        return;
    }
    if (gameMode === TSUME_MODE && tsumeBusy) return;
    const targetIndex = historyTargetIndex(-1);
    if (targetIndex >= 0) {
        restoreState(targetIndex);
        if (gameMode === TSUME_MODE) syncTsumeStateFromHistory();
    }
}

function redoMove() {
    if (promoteMoveInfo) return;
    if (gameMode === TSUME_MODE && tsumeBusy) return;
    const targetIndex = historyTargetIndex(1);
    if (targetIndex >= 0 && targetIndex < moveHistory.length) {
        restoreState(targetIndex);
        if (gameMode === TSUME_MODE) syncTsumeStateFromHistory();
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
        undoButton.disabled = gameMode === 'ai'
            ? findAiModeHistoryTargetIndex(currentHistoryIndex, -1) < 0
            : currentHistoryIndex <= 0;
    }
    if (redoButton) {
        redoButton.disabled = gameMode === 'ai'
            ? findAiModeHistoryTargetIndex(currentHistoryIndex, 1) < 0
            : currentHistoryIndex >= moveHistory.length - 1;
    }
}

window.addEventListener('load', function () {
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-KH9HBZ92L4';
    document.head.appendChild(script);

    script.onload = function () {
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { dataLayer.push(arguments); };
        gtag('js', new Date());
        gtag('config', 'G-KH9HBZ92L4');
    };

    var adsScript = document.createElement('script');
    adsScript.async = true;
    adsScript.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1918692579240633';
    adsScript.crossOrigin = 'anonymous';
    document.head.appendChild(adsScript);

    var bottomAdDiv = document.getElementById('bottom-ad');
    if (bottomAdDiv) {
        bottomAdDiv.innerHTML = '<ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1918692579240633" data-ad-slot="1676714211" data-ad-format="auto" data-full-width-responsive="false"></ins>';
        bottomAdDiv.classList.remove("adloading");
        (adsbygoogle = window.adsbygoogle || []).push({});
    }
});
// --- 画像の遅延読み込み ---
function preloadPieceImages() {
    if (pieceDisplayMode !== 'image') return;

    for (const [pieceType, fileName] of Object.entries(pieceImageFiles)) {
        if (!pieceImageCache[pieceType]) {
            const img = new Image();
            img.src = `/images/koma/${fileName}`;
            pieceImageCache[pieceType] = img;
        }
    }
}

// --- 描画 ---
function renderBoard() {
    boardElement.innerHTML = ''; // 盤面をクリア
    const movablePieceSquareKeys = getMovablePieceSquareKeys();
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
                    img.src = `/images/koma/${fileName}`;
                    img.alt = pieceNames[pieceType] || '駒';
                    img.draggable = false;
                    pieceElement.appendChild(img);
                } else {
                    // テキストモード（従来通り）
                    pieceElement.textContent = getPieceDisplayLabel(pieceType, piece.owner);
                    if (pieceType.startsWith('+')) {
                        pieceElement.classList.add('promoted');
                    }
                }

                if (movablePieceSquareKeys.has(`${x},${y}`)) {
                    square.classList.add('movable-piece');
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

// 将棋盤モードは1台を二人で囲んで指すので、「自分／相手」では誰を指すのか決まらない
function getCapturedSideLabel(owner) {
    if (gameMode === 'pvp') {
        return owner === SENTE ? '先手' : '後手';
    }
    if (gameMode === TSUME_MODE) {
        // 詰将棋の呼び方に合わせる（攻方＝詰ます側、玉方＝詰まされる側）
        return owner === SENTE ? '攻方' : '玉方';
    }
    return owner === getBoardPerspectiveSide() ? '自分' : '相手';
}

function renderCapturedSide(container, pieces, owner) {
    const sideLabel = getCapturedSideLabel(owner);
    const lane = container.closest('.captured-pieces');
    container.innerHTML = '';
    container.setAttribute('aria-label', `${sideLabel}の持ち駒一覧`);
    if (lane) {
        lane.dataset.empty = 'true';
        lane.setAttribute('aria-label', `${sideLabel}の持ち駒`);
        const labelElement = lane.querySelector('.captured-side-label');
        if (labelElement) {
            labelElement.textContent = sideLabel;
        }
    }

    for (const type in pieces) {
        if (pieces[type] > 0) {
            const pieceElement = document.createElement('div');
            pieceElement.classList.add('captured-piece');
            pieceElement.dataset.type = type;
            pieceElement.dataset.owner = owner;
            pieceElement.textContent = pieceNames[type];
            pieceElement.setAttribute('role', 'listitem');

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
            if (lane) {
                lane.dataset.empty = 'false';
            }
        }
    }

    updateCapturedOverflowFade(container);
}

// あふれた持ち駒がスクロールで見えることを端のフェードで示す
// （盤面反転時はmaskがレーンごと回転するため、ローカル座標のままで正しい側に出る）
function updateCapturedOverflowFade(container) {
    const maxScroll = container.scrollWidth - container.clientWidth;
    const hasOverflow = maxScroll > 1;
    // あふれている間はチップの touch-action を pan-x に緩め、横スワイプでのスクロールを優先させる（CSSで参照）
    container.classList.toggle('is-overflowing', hasOverflow);
    container.classList.toggle('fade-left', hasOverflow && container.scrollLeft > 1);
    container.classList.toggle('fade-right', hasOverflow && container.scrollLeft < maxScroll - 1);
}

for (const capturedContainer of [capturedWhiteElement, capturedBlackElement]) {
    capturedContainer.addEventListener('scroll', () => updateCapturedOverflowFade(capturedContainer), { passive: true });
}
if (typeof ResizeObserver !== 'undefined') {
    const capturedFadeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            updateCapturedOverflowFade(entry.target);
        }
    });
    capturedFadeObserver.observe(capturedWhiteElement);
    capturedFadeObserver.observe(capturedBlackElement);
}

function updateInfo() {
    currentTurnElement.textContent = currentPlayer === SENTE ? '先手' : '後手';
    moveCountElement.textContent = moveCount;
    capturedWhiteLaneElement.classList.toggle('is-active', currentPlayer === SENTE);
    capturedBlackLaneElement.classList.toggle('is-active', currentPlayer === GOTE);
}

function isLocalPlayersTurn() {
    if (gameOver) return false;

    if (isOnlineMode()) {
        const started = isMatchStarted(onlineState.match);
        return started
            && !onlineState.match?.game_over
            && !onlineState.submitting
            && Boolean(onlineState.side)
            && onlineState.side === currentPlayer;
    }

    if (gameMode === 'ai') {
        return currentPlayer === aiPlayerSide;
    }

    if (gameMode === TSUME_MODE) {
        // 玉方は自動で応じるので、攻方（先手）の手番だけ操作を受け付ける
        return currentPlayer === SENTE && !tsumeBusy;
    }

    return true;
}

function getMovablePieceSquareKeys() {
    if (selectedPiece || !isLocalPlayersTurn()) {
        return new Set();
    }

    const movableSquares = new Set();
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (!piece || piece.owner !== currentPlayer) {
                continue;
            }
            if (calculateValidMoves(x, y, piece).length > 0) {
                movableSquares.add(`${x},${y}`);
            }
        }
    }
    return movableSquares;
}

// --- イベントハンドラ ---
function handleSquareClick(event) {
    if (!isLocalPlayersTurn()) return;

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
    if (!isLocalPlayersTurn()) return;

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

// --- 駒のドラッグ移動 ---
// タップ操作（clickイベント）には一切手を入れず、Pointer Events による追加レイヤーとして実装。
// ドラッグ開始時は renderBoard() を呼ばず既存DOMへ直接ハイライトを適用する
// （再描画で pointerdown 対象要素がDOMから外れるとタッチの暗黙キャプチャが切れるため）。
// 移動の確定は既存の handleMove / handleDrop に委譲する。

const DRAG_START_THRESHOLD_MOUSE = 5; // ドラッグ開始とみなす移動量(px)
const DRAG_START_THRESHOLD_TOUCH = 8; // タッチは指ブレが大きいため広めに取る

let dragState = null; // ドラッグ候補〜ドラッグ中の情報。null なら非ドラッグ
let suppressClickAfterDrag = false; // ドラッグ確定直後の合成clickを1回だけ無視するフラグ

function handleBoardPointerDown(event) {
    if (dragState || !event.isPrimary || event.button !== 0) return;
    if (promoteMoveInfo || !isLocalPlayersTurn()) return;

    const square = event.target.closest('.square');
    if (!square || !boardElement.contains(square)) return;

    const x = parseInt(square.dataset.x);
    const y = parseInt(square.dataset.y);
    const piece = board[y][x];
    if (!piece || piece.owner !== currentPlayer) return;

    const pieceElement = square.querySelector('.piece');
    if (!pieceElement) return;

    armPieceDrag(event, {
        kind: 'board',
        fromX: x,
        fromY: y,
        owner: piece.owner,
        pieceType: piece.type,
        sourceElement: pieceElement,
    });
}

function handleCapturedPointerDown(event) {
    if (dragState || !event.isPrimary || event.button !== 0) return;
    if (promoteMoveInfo || !isLocalPlayersTurn()) return;

    const chip = event.target.closest('.captured-piece');
    if (!chip || chip.dataset.owner !== currentPlayer) return;

    armPieceDrag(event, {
        kind: 'captured',
        fromX: null,
        fromY: null,
        owner: chip.dataset.owner,
        pieceType: chip.dataset.type,
        sourceElement: chip,
    });
}

// pointerdown 時点では記録だけ行う（タップなら何もせず native click に委ねるため、
// preventDefault や状態・DOMの変更はしない）
function armPieceDrag(event, source) {
    dragState = {
        ...source,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        piece: null,
        active: false,
        ghostElement: null,
        ghostHalfWidth: 0,
        ghostHalfHeight: 0,
        hoverSquare: null,
        rafId: null,
    };
    window.addEventListener('pointermove', handleDragPointerMove);
    window.addEventListener('pointerup', handleDragPointerUp);
    window.addEventListener('pointercancel', handleDragPointerCancel);
    window.addEventListener('blur', handleDragWindowBlur);
}

function disarmPieceDrag() {
    window.removeEventListener('pointermove', handleDragPointerMove);
    window.removeEventListener('pointerup', handleDragPointerUp);
    window.removeEventListener('pointercancel', handleDragPointerCancel);
    window.removeEventListener('blur', handleDragWindowBlur);
    dragState = null;
}

function handleDragPointerMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    dragState.lastClientX = event.clientX;
    dragState.lastClientY = event.clientY;

    if (!dragState.active) {
        const threshold = dragState.pointerType === 'mouse'
            ? DRAG_START_THRESHOLD_MOUSE
            : DRAG_START_THRESHOLD_TOUCH;
        const dx = event.clientX - dragState.startClientX;
        const dy = event.clientY - dragState.startClientY;
        if (dx * dx + dy * dy < threshold * threshold) return;
        startPieceDrag();
        if (!dragState || !dragState.active) return; // 開始ガードで中断された場合
    }

    if (dragState.rafId === null) {
        dragState.rafId = requestAnimationFrame(updateDragFrame);
    }
}

// 移動閾値を超えた時点で呼ばれ、実際のドラッグを開始する
function startPieceDrag() {
    const state = dragState;

    // pointerdown 以降に状況が変わっていないか再確認（オンラインの非同期更新・undoなど）
    if (promoteMoveInfo || !isLocalPlayersTurn() || !state.sourceElement.isConnected) {
        disarmPieceDrag();
        return;
    }
    if (state.kind === 'board') {
        const piece = board[state.fromY][state.fromX];
        if (!piece || piece.owner !== state.owner || piece.type !== state.pieceType) {
            disarmPieceDrag();
            return;
        }
        state.piece = piece;
        selectedPiece = { x: state.fromX, y: state.fromY, piece: piece };
        validMoves = calculateValidMoves(state.fromX, state.fromY, piece);
    } else {
        if (!capturedPieces[state.owner] || capturedPieces[state.owner][state.pieceType] <= 0) {
            disarmPieceDrag();
            return;
        }
        selectedPiece = { owner: state.owner, type: state.pieceType };
        validMoves = calculateDropLocations(state.pieceType, state.owner);
    }

    applyDragSelectionHighlights();
    createDragGhost();

    // 元の駒はドラッグ中だけ隠す（elementFromPoint がマスを拾えるよう visibility を使う）
    if (state.kind === 'board') {
        state.sourceElement.style.visibility = 'hidden';
    } else {
        state.sourceElement.classList.add('drag-source');
    }

    try {
        state.sourceElement.setPointerCapture(state.pointerId);
    } catch (err) {
        // キャプチャに失敗しても window リスナーで追従できるため無視
    }

    document.body.classList.add('piece-dragging');
    state.active = true;
}

// タップ選択（selectPiece / handleCapturedPieceClick）と同じ見た目を再描画なしで適用する
function applyDragSelectionHighlights() {
    const state = dragState;
    for (const square of boardElement.querySelectorAll('.square')) {
        const x = parseInt(square.dataset.x);
        const y = parseInt(square.dataset.y);
        square.classList.remove('movable-piece', 'drag-over');
        square.classList.toggle('selected', state.kind === 'board' && state.fromX === x && state.fromY === y);
        square.classList.toggle('valid-move', validMoves.some(move => move.x === x && move.y === y));
    }
    for (const chip of document.querySelectorAll('.captured-piece.selected')) {
        chip.classList.remove('selected');
    }
    if (state.kind === 'captured') {
        state.sourceElement.classList.add('selected');
    }
}

function createDragGhost() {
    const state = dragState;
    document.getElementById('drag-ghost')?.remove(); // 念のため残留ゴーストを除去

    const sourceRect = state.sourceElement.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.id = 'drag-ghost';
    ghost.style.width = `${sourceRect.width}px`;
    ghost.style.height = `${sourceRect.height}px`;

    const clone = state.sourceElement.cloneNode(true);
    clone.classList.remove('selected', 'drag-source');
    clone.removeAttribute('style');
    const countBadge = clone.querySelector('.count');
    if (countBadge) {
        countBadge.remove(); // 掴んでいるのは1枚なので枚数バッジは出さない
    }
    ghost.appendChild(clone);
    document.body.appendChild(ghost);

    state.ghostElement = ghost;
    state.ghostHalfWidth = sourceRect.width / 2;
    state.ghostHalfHeight = sourceRect.height / 2;
    positionDragGhost();
}

function positionDragGhost() {
    const state = dragState;
    const x = state.lastClientX - state.ghostHalfWidth;
    const y = state.lastClientY - state.ghostHalfHeight;
    state.ghostElement.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function updateDragFrame() {
    if (!dragState || !dragState.active) return;
    dragState.rafId = null;
    positionDragGhost();
    updateDragHover(getSquareAtPoint(dragState.lastClientX, dragState.lastClientY));
}

// 画面座標から盤上のマスを特定する。盤の180度回転（後手視点）は
// elementFromPoint が実際の描画位置で判定するため自動的に正しく扱われる
function getSquareAtPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) return null;
    const square = element.closest('.square');
    if (!square || !boardElement.contains(square)) return null;
    return square;
}

function updateDragHover(square) {
    const state = dragState;
    if (state.hoverSquare === square) return;
    if (state.hoverSquare) {
        state.hoverSquare.classList.remove('drag-over');
    }
    state.hoverSquare = null;
    if (square) {
        const x = parseInt(square.dataset.x);
        const y = parseInt(square.dataset.y);
        if (validMoves.some(move => move.x === x && move.y === y)) {
            square.classList.add('drag-over');
            state.hoverSquare = square;
        }
    }
}

function handleDragPointerUp(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    if (!dragState.active) {
        // 閾値未満＝タップ。何もせず native click（既存のタップ操作）に委ねる
        disarmPieceDrag();
        return;
    }

    finishPieceDrag(event);
}

function finishPieceDrag(event) {
    const state = dragState;

    // このジェスチャ由来の合成 click が既存ハンドラに二重処理されるのを防ぐ
    suppressClickAfterDrag = true;

    cleanupDragVisuals();

    const square = getSquareAtPoint(event.clientX, event.clientY);
    const dropX = square ? parseInt(square.dataset.x) : null;
    const dropY = square ? parseInt(square.dataset.y) : null;

    // ドラッグ中に投了・終局・オンライン更新が起きた場合に備えて再チェック。
    // validMoves はグローバル参照のため、外部でリセット済みなら自動的に無効になる
    const isValidTarget = square !== null
        && isLocalPlayersTurn()
        && validMoves.some(move => move.x === dropX && move.y === dropY);

    if (isValidTarget) {
        if (state.kind === 'board') {
            handleMove(state.fromX, state.fromY, dropX, dropY, state.piece);
        } else {
            handleDrop(state.pieceType, dropX, dropY);
        }
    } else if (state.kind === 'board' && square && dropX === state.fromX && dropY === state.fromY) {
        // 元のマスへ戻した: タップ選択と同じ「選択中」状態を維持する
        // （selectedPiece / validMoves / ハイライトは適用済みのため何もしない）
    } else if (state.kind === 'captured'
        && document.elementFromPoint(event.clientX, event.clientY)?.closest('.captured-piece') === state.sourceElement) {
        // 元の持ち駒チップの上で離した: 選択状態を維持する
    } else {
        clearSelection();
    }

    disarmPieceDrag();
}

function handleDragPointerCancel(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    cancelPieceDrag();
}

function handleDragWindowBlur() {
    if (dragState) {
        cancelPieceDrag();
    }
}

// スクロール奪取・OSジェスチャ・着信などでドラッグが中断された場合の完全復元
function cancelPieceDrag() {
    const wasActive = dragState.active;
    cleanupDragVisuals();
    disarmPieceDrag();
    if (wasActive) {
        clearSelection(); // 再描画で選択・ハイライトを完全に元へ戻す
    }
}

function cleanupDragVisuals() {
    const state = dragState;
    if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
    }
    if (state.ghostElement) {
        state.ghostElement.remove();
        state.ghostElement = null;
    }
    if (state.hoverSquare) {
        state.hoverSquare.classList.remove('drag-over');
        state.hoverSquare = null;
    }
    // 元要素の復元は、ドラッグ中の再描画で要素がDOMから外れていても安全（no-op）
    if (state.kind === 'board') {
        state.sourceElement.style.visibility = '';
    } else {
        state.sourceElement.classList.remove('drag-source');
    }
    document.body.classList.remove('piece-dragging');
}

if (window.PointerEvent) {
    boardElement.addEventListener('pointerdown', handleBoardPointerDown);
    capturedWhiteElement.addEventListener('pointerdown', handleCapturedPointerDown);
    capturedBlackElement.addEventListener('pointerdown', handleCapturedPointerDown);

    // ドラッグ確定直後の合成 click を capture 段階で1回だけ握り潰す。
    // タッチ等で click が発生しなかった場合に備え、次の pointerdown で必ずフラグを戻す
    document.addEventListener('click', (event) => {
        if (!suppressClickAfterDrag) return;
        suppressClickAfterDrag = false;
        event.stopPropagation();
        event.preventDefault();
    }, true);
    document.addEventListener('pointerdown', () => {
        suppressClickAfterDrag = false;
    }, true);

    // ドラッグ（候補含む）中の長押しコンテキストメニューを抑制（Androidの画像長押し対策）
    document.addEventListener('contextmenu', (event) => {
        if (dragState) {
            event.preventDefault();
        }
    });
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
    if (gameMode === 'ai' && currentPlayer === aiPlayerSide) {
        josekiMoveIndex++;
    }

    switchPlayer();
    clearSelection(); // 選択状態と移動可能範囲をクリア

    // 王手チェック
    isCheck = isKingInCheck(currentPlayer);
    if (isCheck) {
        // 詰みチェック
        checkmate = isCheckmate(currentPlayer);
        if (gameMode === TSUME_MODE) {
            // 詰将棋は毎手が王手なので王手表示は出さない。
            // 詰み上がりの演出も対局用ダイアログではなく tsumeAfterMove 側で出す。
            messageElement.textContent = '';
            messageArea.style.display = 'none';
        } else if (checkmate) {
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

    // 千日手判定（詰将棋には無関係。決着は手数で決まるので対局用の終局を出さない）
    if (!gameOver && gameMode !== TSUME_MODE) {
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

    if (gameMode === TSUME_MODE) {
        tsumeAfterMove(usiMove);
    }
}

function switchPlayer() {
    currentPlayer = (currentPlayer === SENTE) ? GOTE : SENTE;
}

function getOpponent(player) {
    return player === SENTE ? GOTE : SENTE;
}

function getAIPlayer() {
    return gameMode === 'ai' ? getOpponent(aiPlayerSide) : null;
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

function getBoardPerspectiveSide() {
    if (gameMode === 'ai') {
        return aiPlayerSide;
    }
    if (isOnlineMode() && onlineState.side === GOTE) {
        return GOTE;
    }
    return SENTE;
}

function applyBoardOrientation() {
    if (typeof document === 'undefined') return;
    if (getBoardPerspectiveSide() === GOTE) {
        document.body.classList.add('board-flipped');
    } else {
        document.body.classList.remove('board-flipped');
    }
}

function updateAiPlayerSideRadios(side) {
    aiPlayerSideRadios.forEach(radio => {
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
    const showIndicatorDifficulties = ['super', 'transcendent', 'legendary1', 'legendary2', 'legendary3'];
    if (showIndicatorDifficulties.includes(aiDifficulty)) {
        showAIThinkingIndicator();
    }

    // 現在のリクエストIDを保存（レスポンスで照合するため）
    const currentRequestId = aiRequestId;

    // 高レベルAI（達人級以上）はYaneuraOuを使用
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
    } else {
        // 通常のAIワーカーに計算を依頼
        requestStandardAiMove(currentRequestId, aiDifficulty);
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
// 盤面はモードごとに別ページなので、保存先もモードごとに分ける。
// こうしないと /board/ を開いただけでAI対戦の途中局面が消えてしまう。
// AI対戦だけは旧キーのままにして、既存ユーザーの対局を引き継ぐ。
const STORAGE_KEY_GAME_STATE_BY_MODE = {
    ai: 'shogi_game_state',
    pvp: 'shogi_game_state_pvp'
};

function gameStateStorageKey(mode = gameMode) {
    return STORAGE_KEY_GAME_STATE_BY_MODE[mode] || null;
}

const STORAGE_KEY_AI_DIFFICULTY = 'shogi_ai_difficulty';
const STORAGE_KEY_PIECE_DISPLAY_MODE = 'shogi_piece_display_mode';
const STORAGE_KEY_AI_PLAYER_SIDE = 'aiPlayerSide';
const LEGACY_STORAGE_KEY_PLAYER_SIDE = 'shogi_player_side';
const STORAGE_KEY_UNLOCKED_LEVELS = 'shogi_unlocked_levels';

// レベル解放システム（進行順・ロック対象は DIFFICULTY_LEVELS の unlockedBy から導出）
const LEVEL_PROGRESSION = Object.fromEntries(
    DIFFICULTY_LEVELS.filter(l => l.unlockedBy).map(l => [l.unlockedBy, l.value])
);

const LOCKABLE_LEVELS = DIFFICULTY_LEVELS.filter(l => l.unlockedBy).map(l => l.value);

// 次のレベル解放状態の管理
let pendingUnlockedLevel = null;

function isValidPlayerSide(side) {
    return side === SENTE || side === GOTE;
}

function loadAiPlayerSidePreference() {
    const savedAiPlayerSide = localStorage.getItem(STORAGE_KEY_AI_PLAYER_SIDE);
    if (isValidPlayerSide(savedAiPlayerSide)) {
        return savedAiPlayerSide;
    }

    const legacyPlayerSide = localStorage.getItem(LEGACY_STORAGE_KEY_PLAYER_SIDE);
    if (!isValidPlayerSide(legacyPlayerSide)) {
        return SENTE;
    }

    try {
        localStorage.setItem(STORAGE_KEY_AI_PLAYER_SIDE, legacyPlayerSide);
        localStorage.removeItem(LEGACY_STORAGE_KEY_PLAYER_SIDE);
    } catch (error) {
        console.error('AI手番設定の移行エラー:', error);
    }
    return legacyPlayerSide;
}

function saveAiPlayerSidePreference() {
    try {
        localStorage.setItem(STORAGE_KEY_AI_PLAYER_SIDE, aiPlayerSide);
    } catch (error) {
        console.error('AI手番設定の保存エラー:', error);
    }
}

// 解放済みレベルを取得
function getUnlockedLevels() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_UNLOCKED_LEVELS);
        const parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

// レベルを解放
function unlockLevel(level) {
    const unlocked = getUnlockedLevels();
    if (!unlocked.includes(level)) {
        unlocked.push(level);
        try {
            localStorage.setItem(STORAGE_KEY_UNLOCKED_LEVELS, JSON.stringify(unlocked));
        } catch (error) {
            console.error('レベル解放の保存エラー:', error);
        }
    }
}

// レベルが解放されているかチェック（unlockedLevels を渡すと localStorage を読み直さない）
function isLevelUnlocked(level, unlockedLevels = null) {
    if (!LOCKABLE_LEVELS.includes(level)) return true;
    return (unlockedLevels || getUnlockedLevels()).includes(level);
}

// 難易度UI（トリガーの現在値ラベルとモーダル内オプション）を反映
function renderDifficultyUi() {
    if (difficultyTriggerValue) {
        difficultyTriggerValue.textContent = getDifficultyLabel(aiDifficulty);
    }
    renderDifficultyOptions();
}

// モーダル内のオプション一覧を解放状態に合わせて生成
function renderDifficultyOptions() {
    if (!difficultyOptionsContainer) return;
    difficultyOptionsContainer.textContent = '';
    const unlockedLevels = getUnlockedLevels();
    DIFFICULTY_LEVELS.forEach(def => {
        const unlocked = isLevelUnlocked(def.value, unlockedLevels);
        // 解放条件となる前のレベルも未解放なら選択肢に出さない
        if (!unlocked && def.unlockedBy && !isLevelUnlocked(def.unlockedBy, unlockedLevels)) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'difficulty-option';
        btn.dataset.difficultyValue = def.value;

        const name = document.createElement('span');
        name.className = 'difficulty-option-name';
        name.textContent = def.label;
        btn.appendChild(name);

        if (unlocked) {
            const selected = def.value === aiDifficulty;
            btn.classList.toggle('is-selected', selected);
            btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        } else {
            btn.disabled = true;
            btn.classList.add('is-locked');
            const note = document.createElement('span');
            note.className = 'difficulty-option-note';
            note.textContent = `${getDifficultyLabel(def.unlockedBy)}に勝利して解放`;
            btn.appendChild(note);
        }
        difficultyOptionsContainer.appendChild(btn);
    });
}

// ゲーム状態をlocalStorageに保存
function saveToLocalStorage() {
    try {
        // 通信対戦の局面はサーバーが持っているのでローカルには保存しない
        const stateKey = gameStateStorageKey();
        if (stateKey) {
            const gameState = {
                mode: gameMode,
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
            localStorage.setItem(stateKey, JSON.stringify(gameState));
        }
        localStorage.setItem(STORAGE_KEY_AI_DIFFICULTY, aiDifficulty);
        localStorage.setItem(STORAGE_KEY_PIECE_DISPLAY_MODE, pieceDisplayMode);
        localStorage.setItem(STORAGE_KEY_AI_PLAYER_SIDE, aiPlayerSide);
    } catch (error) {
        console.error('localStorage保存エラー:', error);
    }
}

// localStorageからゲーム状態を読み込み
function loadFromLocalStorage() {
    try {
        const stateKey = gameStateStorageKey();
        const savedState = stateKey ? localStorage.getItem(stateKey) : null;
        const savedDifficulty = localStorage.getItem(STORAGE_KEY_AI_DIFFICULTY);
        const savedDisplayMode = localStorage.getItem(STORAGE_KEY_PIECE_DISPLAY_MODE);
        aiPlayerSide = loadAiPlayerSidePreference();
        updateAiPlayerSideRadios(aiPlayerSide);
        applyBoardOrientation();

        // タブのactive状態と設定パネルの表示はページ生成時に確定しているため、
        // ここでは触らない（body の mode-* クラスが唯一の定義元）。

        // AI難易度の復元
        if (savedDifficulty) {
            aiDifficulty = savedDifficulty;
        }
        // 不正値やロック中レベルが保存されていた場合はデフォルトに戻す
        if (!isValidDifficulty(aiDifficulty) || !isLevelUnlocked(aiDifficulty)) {
            aiDifficulty = 'medium';
        }
        renderDifficultyUi();

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

        if (savedState) {
            const gameState = JSON.parse(savedState);

            // キーはモード別だが、念のため中身のモードも確認する
            if ((gameState.mode || 'ai') !== gameMode) {
                clearLocalStorage();
                return false;
            }

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
        aiPlayerSide = loadAiPlayerSidePreference();
        updateAiPlayerSideRadios(aiPlayerSide);
        applyBoardOrientation();

        if (savedDifficulty) {
            aiDifficulty = savedDifficulty;
        }
        if (!isValidDifficulty(aiDifficulty) || !isLevelUnlocked(aiDifficulty)) {
            aiDifficulty = 'medium';
        }
        renderDifficultyUi();

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
        const stateKey = gameStateStorageKey();
        if (stateKey) localStorage.removeItem(stateKey);
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
        renderDifficultyUi();
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
        hideGameOverDialog();
        // Online: 次のゲームへ = 部屋を離れて友達対戦カードに戻る
        // （招待URLコピー/QRの押下時に新しい部屋が作られる）
        await onlineLeaveRoom({ resignIfActive: false });
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

// 通信対戦から離れるときの確認と投了。タブは通常のリンクなので、遷移を止めて
// この処理を終えてから移動する。
// ブラウザバックやタブを閉じた場合はここを通らないが、その場合はサーバー側の
// 切断猶予（60秒）で処理される。
async function confirmLeaveOnlineForNavigation() {
    if (gameMode !== ONLINE_MODE) return true;

    const active = isMatchStarted(onlineState.match) && !onlineState.match?.game_over;
    if (active) {
        if (!window.confirm('対局中です。移動すると投了になります。移動しますか？')) {
            return false;
        }
        await onlineLeaveRoom({ resignIfActive: true });
        return true;
    }

    if (onlineState.roomCode) {
        await onlineLeaveRoom({ resignIfActive: false });
    }
    return true;
}

function isPlainLeftClick(event) {
    // 新しいタブで開く操作などはブラウザ標準の挙動に任せる
    return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0;
}

// 離脱処理が失敗してもリンクを死なせない。確認でキャンセルされたときだけ遷移を止める。
async function navigateAfterLeavingOnline(href, onCancel) {
    let allowed = true;
    try {
        allowed = await confirmLeaveOnlineForNavigation();
    } catch (error) {
        // 退室APIが失敗しても、サーバー側は切断猶予で処理するので遷移は妨げない
        console.error('通信対戦の離脱処理に失敗しました:', error);
    }
    if (!allowed) {
        onCancel?.();
        return;
    }
    window.location.href = href;
}

// モード切り替えタブ。<a href> なのでJSが動かなくても遷移でき、クローラーも辿れる。
modeTabs.forEach(tab => {
    tab.addEventListener('click', (event) => {
        // 現在のモードのタブはブラウザ標準の再読み込みに任せる（無反応にしない）
        if (!isPlainLeftClick(event) || tab.dataset.mode === gameMode) return;

        event.preventDefault();

        // 押した直後にタブを光らせて、遷移待ちが無反応に見えないようにする
        modeTabs.forEach(t => t.classList.toggle('active', t === tab));

        // 盤面はモードごとに別キーで保存しているので、ここでは消さない
        // （移動先のモードで前回の続きから再開できる）
        navigateAfterLeavingOnline(tab.href, () => {
            modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === gameMode));
            updateOnlineUiState();
        });
    });
});

// 記事本文などタブ以外のサイト内リンクからも、対局中の離脱には同じ確認を通す。
document.addEventListener('click', (event) => {
    if (gameMode !== ONLINE_MODE || !isPlainLeftClick(event) || event.defaultPrevented) return;

    // `//host/...` はプロトコル相対＝外部リンクなので対象外
    const link = event.target.closest?.('a[href^="/"]:not([href^="//"])');
    if (!link || link.classList.contains('mode-tab') || link.target === '_blank') return;

    event.preventDefault();
    navigateAfterLeavingOnline(link.href);
});

// ---- 友達対戦: QRライブラリの遅延ロードとモーダル ----

let qrLibPromise = null;
function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    if (!qrLibPromise) {
        qrLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = QR_LIB_SRC;
            s.onload = () => resolve();
            s.onerror = () => {
                qrLibPromise = null; // 次回押下で再試行できるように
                reject(new Error('qr_load_failed'));
            };
            document.head.appendChild(s);
        });
    }
    return qrLibPromise;
}

let friendModalReturnFocus = null;
let openFriendModalElement = null;

function handleFriendModalKeydown(e) {
    if (e.key === 'Escape') {
        closeFriendModals();
        return;
    }
    // Tabフォーカスをモーダル内で循環させる（handleSettingsModalKeydown と同形）
    if (e.key !== 'Tab' || !openFriendModalElement) return;
    const focusables = openFriendModalElement.querySelectorAll('button:not(:disabled), input:not(:disabled)');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function openFriendModal(modal) {
    if (!modal) return;
    friendModalReturnFocus = document.activeElement;
    openFriendModalElement = modal;
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', handleFriendModalKeydown);
    const closeBtn = modal.querySelector('.settings-modal-close-btn');
    if (closeBtn) closeBtn.focus();
}

function closeFriendModals() {
    let closedAny = false;
    // AI難易度モーダルも同じ開閉インフラを共用している
    [friendQrModal, friendGuideModal, friendTimeModal, difficultyModal].forEach((m) => {
        if (m && m.style.display !== 'none' && m.style.display !== '') {
            m.style.display = 'none';
            closedAny = true;
        }
    });
    if (!closedAny) return;
    openFriendModalElement = null;
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', handleFriendModalKeydown);
    if (friendModalReturnFocus instanceof HTMLElement) {
        try { friendModalReturnFocus.focus(); } catch (_) { /* ignore */ }
    }
    friendModalReturnFocus = null;
}

async function openFriendQrModal() {
    if (!friendQrModal || !onlineState.roomCode) return;
    try {
        await loadQrLib();
    } catch (_) {
        alert('QRコードの読み込みに失敗しました。通信状況を確認してください。');
        return;
    }
    const url = getInviteUrl(onlineState.roomCode);
    const target = document.getElementById('friend-qr-target');
    if (target) {
        target.innerHTML = '';
        new QRCode(target, {
            text: url,
            width: 200,
            height: 200,
            correctLevel: QRCode.CorrectLevel.M,
        });
    }
    const urlEl = document.getElementById('friend-qr-url');
    if (urlEl) urlEl.textContent = url;
    openFriendModal(friendQrModal);
}

// ---- 友達対戦: 招待ボタン ----

function showCopyInviteSuccess() {
    if (!friendCopyInviteButton) return;
    friendCopyInviteButton.classList.add('copied');
    setTimeout(() => friendCopyInviteButton.classList.remove('copied'), 1500);
}

if (friendCopyInviteButton) {
    friendCopyInviteButton.addEventListener('click', async () => {
        if (friendCopyInviteButton.disabled) return;
        friendCopyInviteButton.disabled = true;
        try {
            // 部屋作成（初回のみ）を待ってから招待URLを返すPromise
            const urlPromise = ensureFriendRoom().then((ok) => {
                if (!ok) throw new Error('room_not_ready');
                return getInviteUrl(onlineState.roomCode);
            });

            // Safari対策: ClipboardItemへPromiseを渡すと、部屋作成POSTを
            // またいでもユーザー操作の文脈が保たれる（WebKit公式パターン）
            if (navigator.clipboard && window.ClipboardItem) {
                try {
                    const item = new ClipboardItem({
                        'text/plain': urlPromise.then(
                            (url) => new Blob([url], { type: 'text/plain' }),
                        ),
                    });
                    await navigator.clipboard.write([item]);
                    showCopyInviteSuccess();
                    return;
                } catch (_) {
                    // 部屋作成失敗 or クリップボード拒否 → 下のフォールバックへ
                }
            }

            let url;
            try {
                url = await urlPromise;
            } catch (_) {
                return; // 部屋作成失敗（ensureFriendRoom側でalert済み）
            }
            try {
                await navigator.clipboard.writeText(url);
                showCopyInviteSuccess();
            } catch (_) {
                // 最終フォールバック: QRモーダル（URLテキストは選択コピー可能）
                await openFriendQrModal();
            }
        } finally {
            friendCopyInviteButton.disabled = false;
        }
    });
}

if (friendQrButton) {
    friendQrButton.addEventListener('click', async () => {
        if (friendQrButton.disabled) return;
        friendQrButton.disabled = true;
        try {
            if (!(await ensureFriendRoom())) return;
            await openFriendQrModal();
        } finally {
            friendQrButton.disabled = false;
        }
    });
}

if (friendInfoButton) {
    friendInfoButton.addEventListener('click', () => {
        openFriendModal(friendGuideModal);
    });
}

document.getElementById('friend-qr-close')?.addEventListener('click', closeFriendModals);
document.getElementById('friend-qr-backdrop')?.addEventListener('click', closeFriendModals);
document.getElementById('friend-guide-close')?.addEventListener('click', closeFriendModals);
document.getElementById('friend-guide-close-btn')?.addEventListener('click', closeFriendModals);
document.getElementById('friend-guide-backdrop')?.addEventListener('click', closeFriendModals);

// 手番・持ち時間の変更を保存し、部屋作成済みならサーバーへ同期
friendSideRadios.forEach((r) => {
    r.addEventListener('change', () => { onFriendSettingsChanged(); });
});

// 持ち時間セレクター: トリガーで選択モーダルを開き、選択で即決定して閉じる
if (friendTimeTrigger) {
    friendTimeTrigger.addEventListener('click', () => {
        renderFriendTcUi();
        openFriendModal(friendTimeModal);
    });
}
friendTimeOptionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        const value = btn.dataset.tcValue;
        if (!isValidFriendTcValue(value)) return;
        const changed = value !== getFriendTcValue();
        setFriendTcValue(value);
        closeFriendModals();
        if (changed) onFriendSettingsChanged();
    });
});
document.getElementById('friend-time-close')?.addEventListener('click', closeFriendModals);
document.getElementById('friend-time-backdrop')?.addEventListener('click', closeFriendModals);

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

// 難易度セレクター: トリガーで選択モーダルを開き、選択で即決定して閉じる
if (difficultyTrigger) {
    difficultyTrigger.addEventListener('click', () => {
        renderDifficultyUi();
        openFriendModal(difficultyModal);
        // 選択中のレベルが見える位置に出し、フォーカスも現在値から始める
        const selectedOption = difficultyOptionsContainer?.querySelector('.difficulty-option.is-selected');
        if (selectedOption) {
            selectedOption.scrollIntoView({ block: 'nearest' });
            selectedOption.focus();
        }
    });
}
// オプション行は解放状態に応じて再生成されるため、コンテナへのイベント委譲で束ねる
if (difficultyOptionsContainer) {
    difficultyOptionsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.difficulty-option');
        if (!btn || btn.disabled) return;
        const value = btn.dataset.difficultyValue;
        if (!isValidDifficulty(value) || !isLevelUnlocked(value)) return;
        const changed = value !== aiDifficulty;
        closeFriendModals();
        // 同じ難易度の再選択では対局をリセットしない
        if (!changed) return;
        aiDifficulty = value;
        renderDifficultyUi();
        saveToLocalStorage();
        clearLocalStorage();
        initializeBoard();
    });
}
document.getElementById('difficulty-close')?.addEventListener('click', closeFriendModals);
document.getElementById('difficulty-backdrop')?.addEventListener('click', closeFriendModals);

// AI対戦での手番選択のイベントリスナー
aiPlayerSideRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        const selectedSide = e.target.value === GOTE ? GOTE : SENTE;
        aiPlayerSide = selectedSide;
        saveAiPlayerSidePreference();

        // In board and online modes this is only a saved AI preference.
        if (gameMode !== 'ai') return;

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

// 詳細設定モーダルの開閉
let settingsModalReturnFocusElement = null;

function handleSettingsModalKeydown(e) {
    if (e.key === 'Escape') {
        closeSettingsModal();
        return;
    }
    if (e.key !== 'Tab') return;
    const focusables = settingsModal.querySelectorAll('button, input');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function openSettingsModal() {
    settingsModalReturnFocusElement = settingsModal.contains(document.activeElement)
        ? settingsIconButton
        : document.activeElement;
    settingsModal.style.display = 'flex';
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', handleSettingsModalKeydown);
    settingsModalCloseButton.focus();
}

function closeSettingsModal() {
    settingsModal.style.display = 'none';
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', handleSettingsModalKeydown);
    const returnFocus = settingsModalReturnFocusElement instanceof HTMLElement
        ? settingsModalReturnFocusElement
        : settingsIconButton;
    settingsModalReturnFocusElement = null;
    returnFocus.focus();
}

settingsIconButton.addEventListener('click', openSettingsModal);
settingsModalCloseButton.addEventListener('click', closeSettingsModal);
settingsModalBackdrop.addEventListener('click', closeSettingsModal);

// ハンバーガーメニューの開閉
function openMenuPanel() {
    menuPanel.hidden = false;
    menuIconButton.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', handleMenuKeydown);
    document.addEventListener('pointerdown', handleMenuOutsidePointer);
    // role="menu" の作法に合わせて先頭項目へフォーカスを移す
    const firstItem = menuPanel.querySelector('.menu-panel-item');
    if (firstItem) firstItem.focus();
}

function closeMenuPanel({ restoreFocus = true } = {}) {
    menuPanel.hidden = true;
    menuIconButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', handleMenuKeydown);
    document.removeEventListener('pointerdown', handleMenuOutsidePointer);
    if (restoreFocus) menuIconButton.focus();
}

function handleMenuKeydown(e) {
    if (e.key === 'Escape') {
        closeMenuPanel();
        return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(menuPanel.querySelectorAll('.menu-panel-item'));
        if (items.length === 0) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        items[(index + delta + items.length) % items.length].focus();
    }
}

function handleMenuOutsidePointer(e) {
    if (!menuPanel.contains(e.target) && !menuIconButton.contains(e.target)) {
        closeMenuPanel({ restoreFocus: false });
    }
}

menuIconButton.addEventListener('click', () => {
    if (menuPanel.hidden) {
        openMenuPanel();
    } else {
        closeMenuPanel();
    }
});

menuFeedbackItem.addEventListener('click', () => {
    closeMenuPanel({ restoreFocus: false });
    openFeedbackModal();
});

// フィードバックモーダルの開閉
function feedbackModalFocusables() {
    // ハニーポットや非表示ビュー内の要素はフォーカス対象から除く
    return Array.from(feedbackModal.querySelectorAll('button, textarea')).filter(
        (el) => el.offsetParent !== null && !el.disabled
    );
}

function handleFeedbackModalKeydown(e) {
    if (e.key === 'Escape') {
        closeFeedbackModal();
        return;
    }
    if (e.key !== 'Tab') return;
    const focusables = feedbackModalFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function openFeedbackModal() {
    // 前回の送信結果が残らないようフォーム表示に戻す
    feedbackForm.hidden = false;
    feedbackThanks.hidden = true;
    hideFeedbackError();
    feedbackModal.style.display = 'flex';
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', handleFeedbackModalKeydown);
    feedbackTextarea.focus();
}

function closeFeedbackModal() {
    feedbackModal.style.display = 'none';
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', handleFeedbackModalKeydown);
    menuIconButton.focus();
}

function showFeedbackError(message) {
    feedbackErrorElement.textContent = message;
    feedbackErrorElement.hidden = false;
}

function hideFeedbackError() {
    feedbackErrorElement.textContent = '';
    feedbackErrorElement.hidden = true;
}

feedbackTextarea.addEventListener('input', () => {
    feedbackCharCount.textContent = `${feedbackTextarea.value.length} / 2000`;
});

feedbackForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = feedbackTextarea.value.trim();
    if (!message) {
        showFeedbackError('内容を入力してください。');
        feedbackTextarea.focus();
        return;
    }
    hideFeedbackError();
    feedbackSubmitButton.disabled = true;
    feedbackSubmitButton.textContent = '送信中…';
    try {
        const json = await onlineApi('/feedback', {
            method: 'POST',
            body: { message, website: feedbackHoneypot.value },
        });
        if (json && json.ok) {
            feedbackForm.hidden = true;
            feedbackThanks.hidden = false;
            feedbackThanksCloseButton.focus();
            feedbackForm.reset();
            feedbackCharCount.textContent = '0 / 2000';
        } else if (json && json.error && json.error.code === 'rate_limited') {
            showFeedbackError('送信回数が多すぎます。しばらくしてからお試しください。');
        } else {
            showFeedbackError('送信に失敗しました。時間をおいて再度お試しください。');
        }
    } catch (_) {
        showFeedbackError('通信エラーが発生しました。接続をご確認ください。');
    } finally {
        feedbackSubmitButton.disabled = false;
        feedbackSubmitButton.textContent = '送信する';
    }
});

feedbackModalCloseButton.addEventListener('click', closeFeedbackModal);
feedbackModalBackdrop.addEventListener('click', closeFeedbackModal);
feedbackThanksCloseButton.addEventListener('click', closeFeedbackModal);

const RESULT_TONE_CLASSES = ['tone-victory', 'tone-defeat', 'tone-draw'];

function createEmptyResultDialogState() {
    return {
        winner: null,
        title: '',
        reason: '',
        tone: 'tone-draw',
        moveCount: 0,
    };
}

function setGameOverTone(tone) {
    if (!gameOverContent) return;
    gameOverContent.classList.remove(...RESULT_TONE_CLASSES);
    gameOverContent.classList.add(RESULT_TONE_CLASSES.includes(tone) ? tone : 'tone-draw');
}

function resetCopyLinkFeedback() {
    if (resultCopyFeedbackTimerId !== null) {
        clearTimeout(resultCopyFeedbackTimerId);
        resultCopyFeedbackTimerId = null;
    }
    copyLinkButton.classList.remove('copied');
}

function resetResultBoardPreview() {
    if (gameResultBoardPanel) {
        gameResultBoardPanel.hidden = true;
    }
    if (gameResultBoardMount) {
        gameResultBoardMount.replaceChildren();
    }
}

function getResultPerspectiveWinnerLabel() {
    if (isOnlineMode()) {
        if (onlineState.side === SENTE) return '先手';
        if (onlineState.side === GOTE) return '後手';
        return null;
    }
    if (gameMode === 'ai') {
        return aiPlayerSide === SENTE ? '先手' : '後手';
    }
    return null;
}

function getGameResultTone(winner) {
    if (winner === '引き分け') {
        return 'tone-draw';
    }
    if (gameMode === 'pvp') {
        return 'tone-victory';
    }

    const playerWinnerLabel = getResultPerspectiveWinnerLabel();
    if (!playerWinnerLabel) {
        return 'tone-victory';
    }

    return winner === playerWinnerLabel ? 'tone-victory' : 'tone-defeat';
}

function handleResultBoardPreviewKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    event.preventDefault();
    hideGameOverDialog();
}

function renderResultBoardPreview() {
    if (!gameResultBoardPanel || !gameResultBoardMount || !boardElement) {
        resetResultBoardPreview();
        return;
    }

    const previewBoard = boardElement.cloneNode(true);
    previewBoard.removeAttribute('id');
    previewBoard.classList.remove('online-waiting');
    previewBoard.classList.add('result-board-preview');
    previewBoard.classList.toggle('is-flipped', getBoardPerspectiveSide() === GOTE);
    previewBoard.setAttribute('role', 'button');
    previewBoard.tabIndex = 0;
    previewBoard.setAttribute('aria-label', '終局盤面。クリックで閉じる');

    previewBoard.querySelectorAll('.square').forEach(square => {
        square.classList.remove('movable-piece', 'highlight', 'selected', 'valid-move');
        square.removeAttribute('data-x');
        square.removeAttribute('data-y');
    });

    previewBoard.addEventListener('click', hideGameOverDialog);
    previewBoard.addEventListener('keydown', handleResultBoardPreviewKeydown);

    gameResultBoardMount.replaceChildren(previewBoard);
    gameResultBoardPanel.hidden = false;
}

function createResultDialogState(winner, reason) {
    return {
        winner,
        title: winner === '引き分け' ? '引き分け' : `${winner}の勝利！`,
        reason,
        tone: getGameResultTone(winner),
        moveCount: Number.isFinite(moveCount) ? moveCount : 0,
    };
}

function buildResultShareText() {
    const state = currentResultDialogState;
    const lines = [
        '将棋Webで対局しました！',
        '',
        `結果: ${state.title || '終局'}`
    ];

    if (state.reason) {
        lines.push(`終局理由: ${state.reason}`);
    }

    lines.push(`手数: ${state.moveCount}手`, '', '#将棋Web');
    return lines.join('\n');
}

function openShareWindow(url) {
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (!popup) {
        window.location.assign(url);
    }
}

// ゲーム終了ダイアログの表示
function showGameOverDialog(winner, reason) {
    // 開いたままのモーダル（難易度選択など）が結果ダイアログに重ならないよう閉じる
    closeFriendModals();

    // 新規ゲームボタンのテキストをリセット
    const newGameMainSpan = newGameButton.querySelector('.new-game-main');
    if (newGameMainSpan) {
        newGameMainSpan.textContent = '次のゲームへ';
    }
    pendingUnlockedLevel = null;

    currentResultDialogState = createResultDialogState(winner, reason);
    gameResultTitle.textContent = currentResultDialogState.title;
    gameResultMessage.textContent = winner === '引き分け'
        ? `${reason}により引き分けとなりました。`
        : `${reason}により${winner}の勝ちです。`;
    gameResultMeta.textContent = `${currentResultDialogState.moveCount}手`;
    setGameOverTone(currentResultDialogState.tone);
    resetCopyLinkFeedback();
    renderResultBoardPreview();

    // AIモードで勝利した場合のみレベル解放を確認
    const isPlayerWin = gameMode === 'ai' && winner === (aiPlayerSide === SENTE ? '先手' : '後手');
    if (winner !== '引き分け' && isPlayerWin) {
        const nextLevel = LEVEL_PROGRESSION[aiDifficulty];
        if (nextLevel && !isLevelUnlocked(nextLevel)) {
            unlockLevel(nextLevel);
            renderDifficultyUi();
            pendingUnlockedLevel = nextLevel;

            showLevelUnlockPopup(nextLevel);

            if (newGameMainSpan) {
                newGameMainSpan.textContent = '次のレベルへ';
            }
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
    const levelName = getDifficultyLabel(level);

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
    setGameOverTone('tone-draw');
    resetCopyLinkFeedback();
    resetResultBoardPreview();
    currentResultDialogState = createEmptyResultDialogState();
}

// SNSシェア機能
function shareOnTwitter() {
    const shareUrl = new URL('https://twitter.com/intent/tweet');
    shareUrl.searchParams.set('text', buildResultShareText());
    shareUrl.searchParams.set('url', window.location.href);
    openShareWindow(shareUrl.toString());
}

function shareOnFacebook() {
    const shareUrl = new URL('https://www.facebook.com/sharer/sharer.php');
    shareUrl.searchParams.set('u', window.location.href);
    openShareWindow(shareUrl.toString());
}

function shareOnLine() {
    const shareUrl = new URL('https://social-plugins.line.me/lineit/share');
    shareUrl.searchParams.set('url', window.location.href);
    shareUrl.searchParams.set('text', buildResultShareText());
    openShareWindow(shareUrl.toString());
}

function copyLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        resetCopyLinkFeedback();
        copyLinkButton.classList.add('copied');

        resultCopyFeedbackTimerId = setTimeout(() => {
            copyLinkButton.classList.remove('copied');
            resultCopyFeedbackTimerId = null;
        }, 1800);
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
// --- 詰将棋 (tsume) ---
// 当日の5問はビルド時に #tsume-data へ焼き込まれている。
// 作意どおりに指している間は焼き込み済みの応手を並べるだけで、探索は動かさない。
// 作意から外れたときだけ、玉方の逃げ方を Web Worker の詰み探索（src/tsume/solver.ts）に選ばせる。
//
// 用語: 攻方 = 先手（利用者）、玉方 = 後手（自動で応じる）。
// 攻方の玉は盤上に無いが、isKingInCheck() は玉が見つからなければ false を返すので
// 既存の合法手生成・王手判定はそのまま動く。

const TSUME_STORAGE_KEY = 'shogi_tsume_v1';
// 玉方が応じるまでの間。指した手が見えないほど速いと何が起きたか分からない
const TSUME_REPLY_DELAY_MS = 600;
// 「答えを見る」の再生間隔。読みながら追える速さにする
const TSUME_REVEAL_INTERVAL_MS = 1300;

/** 玉方が「手数内では詰まない逃げ方」を考えるのに使ってよい時間 */
const TSUME_SOLVER_TIMEOUT_MS = 4000;
/** 玉方が考えている間の表示。作意どおりでも外れていても同じ文言にする（下の注記を参照） */
const TSUME_THINKING_TEXT = '玉方が応じています…';
/** トーストを出しておく時間。悪い知らせは読むのに時間がかかるので長めにする */
const TSUME_TOAST_MS = { good: 2600, bad: 4000, '': 3000 };

/**
 * 詰み上がり図をそのまま見せる時間。詰んだ瞬間に演出を始めると、
 * せっかく作った詰み形を見る間がないまま次の画面に目を移すことになる。
 */
const TSUME_MATE_PAUSE_MS = 400;
/** 波紋が広がりきるまで。これを待ってから結果バーを出す */
const TSUME_MATE_EFFECT_MS = 900;
/** 累計正解数の節目。またいだ瞬間だけ結果バーに出す */
const TSUME_MILESTONES = [10, 25, 50, 100, 200, 300, 500, 1000];

let tsumeProblems = [];
let tsumeDate = '';
/** さかのぼって解ける出題日（古い順）。日付ナビの選択肢がそのまま一覧になる */
let tsumeDates = [];
/** 取得済みの日ぶんのデータ。同じ日を行き来しても取り直さない */
const tsumeDayCache = new Map();
/** 日付の切り替え中。二重に押されると盤が壊れる */
let tsumeDateLoading = false;
let tsumeCurrent = 0;
/** 作意手順の何手目（攻方の手を数えた数）まで進んだか */
let tsumePly = 0;
/** 玉方の応手を再生している間は利用者の操作を止める */
let tsumeBusy = false;
/** 自動応手中は詰将棋の判定を走らせない */
let tsumeAutoPlaying = false;
/**
 * 難易度ごとの状態: 'unsolved' | 'solved'
 * 答えを見たかどうかは持たない。見たあとに解き直しても普通に 'solved' になり、
 * 連続日数にも共有にも乗る（見たことを蒸し返さない）
 */
let tsumeStatus = [];
/**
 * 難易度ごとに「一発正解」で解いたか（ヒント・答え・手順のずれのどれも使わずに解いた）。
 * 一度立ったら下ろさない。解き直しで取り消されると、達成した事実まで無かったことになる。
 */
let tsumeClean = [];
/** この挑戦でヒントを出したか。ヒントボタンを1回だけにするために持つ（並べ直すと戻る） */
let tsumeHintShown = false;
/**
 * 難易度ごとに「その日、一度でも助けを借りたか」。
 * ヒント・答えを見る・作意から外れる のどれかで立ち、「もう一度」では下ろさない。
 * 答えを見てから並べ直して同じ手順をなぞっただけで一発正解になってしまうのを防ぐ。
 *
 * 立てるときは必ず markTsumeAssisted() を通す。localStorage にも残さないと、
 * 読み込み直すだけで同じ抜け道が開いてしまう。
 */
let tsumeAssisted = [];
/** 出しているトーストを消すためのタイマー */
let tsumeToastTimer = null;

// --- 手数を使い切るまで指させるための状態 ---
// 作意から外れた手でもその場では止めない。玉方が「この手数では絶対に詰まない逃げ方」を
// 選んで応じ続け、残り手数が 0 になったところで詰まなかったことを伝える。
// 「その王手では詰みません」と即座に突き返すより、自分で指し切ったほうが納得できる。

/** 残り手数。攻方・玉方どちらの手でも1つ減る */
let tsumeRemaining = 0;
/** 作意手順から外れているか */
let tsumeOffLine = false;
/** 外れた手を指す直前の履歴インデックス。「戻る」の行き先 */
let tsumeDeviationIndex = -1;
/** 外れたのが何手目か（1始まり）。利用者に伝えるためだけに持つ */
let tsumeDeviationPly = 0;
/**
 * 別解に入ったか。作意手（step.attack）と同じ手数で詰む別の正解手を指すと立つ。
 * 7手以上は余詰を許して出しているので（scripts/tsume/config.ts の YOZUME_STRICT_MAX_MOVES）、
 * 別解を指すのは想定内の遊び方。
 *
 * ただし問題に焼き込んである玉方の応手は作意手のあとの局面にしか通じない。
 * そのまま指すと違法手になるので、ここから先の応手は探索に選ばせる。
 * 間違えたわけではないため、tsumeOffLine と違って「手順が変わった」とは言わず、
 * 一発正解の資格も落とさない。
 */
let tsumeAltLine = false;
/** 別解に入る直前の履歴インデックス。「待った」で作意へ戻れたかの判定に使う */
let tsumeAltIndex = -1;
/** 手数内に詰ませられなかった状態か */
let tsumeFailed = false;
/**
 * 局面を並べ直すたびに増やす番号。
 * 玉方の応手を待っている間に問題を切り替えたり「答えを見る」を押されたときに、
 * 遅れて返ってきた応手が新しい局面に割り込まないよう、これで捨てる。
 */
let tsumeSession = 0;

function isTsumeMode() {
    return gameMode === TSUME_MODE;
}

// --- 玉方の応手を考える Worker ---
// 詰み探索は src/tsume/solver.ts。出題を検証しているのと同じルールで動く。
// 盤の操作を止めたくないので別スレッドに置く。詰将棋ページ以外では起動しない。

let tsumeSolver = null;
let tsumeSolverUnavailable = false;
let tsumeSolverRequestId = 0;
const tsumeSolverPending = new Map();

function ensureTsumeSolver() {
    if (tsumeSolver || tsumeSolverUnavailable) return tsumeSolver;
    if (!window.Worker) {
        tsumeSolverUnavailable = true;
        return null;
    }
    try {
        tsumeSolver = new Worker('/tsume-solver.js');
        tsumeSolver.onmessage = (event) => {
            const data = event.data || {};
            const resolve = tsumeSolverPending.get(data.id);
            if (!resolve) return;
            tsumeSolverPending.delete(data.id);
            resolve(data);
        };
        tsumeSolver.onerror = () => {
            // 読み込みに失敗しても詰将棋自体は遊べる。以降は従来の即時判定に戻す
            console.warn('tsume solver worker failed to start');
            tsumeSolverUnavailable = true;
            tsumeSolver = null;
            for (const resolve of tsumeSolverPending.values()) resolve({ kind: 'unknown' });
            tsumeSolverPending.clear();
        };
    } catch (error) {
        console.warn('tsume solver worker unavailable', error);
        tsumeSolverUnavailable = true;
        tsumeSolver = null;
    }
    return tsumeSolver;
}

/**
 * 玉方の応手を1つもらう。remaining はこの応手を含めた残り手数。
 * 結論が出せなければ 'unknown'。そのときは推測で指さず、従来どおり手を戻す。
 */
function askTsumeDefense(remaining) {
    const worker = ensureTsumeSolver();
    if (!worker) return Promise.resolve({ kind: 'unknown' });

    const id = ++tsumeSolverRequestId;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            tsumeSolverPending.delete(id);
            resolve(result);
        };
        tsumeSolverPending.set(id, finish);
        // 応答が返らないまま操作不能になるのを防ぐ
        setTimeout(() => finish({ kind: 'unknown' }), TSUME_SOLVER_TIMEOUT_MS);
        worker.postMessage({ id, board, hands: capturedPieces, remaining });
    });
}

/** SFEN から盤面と持ち駒を組み立てる。詰将棋の局面設定にだけ使う簡易版。 */
function parseTsumeSfen(sfen) {
    const TYPE_BY_LETTER = {
        P: PAWN, L: LANCE, N: KNIGHT, S: SILVER, G: GOLD, B: BISHOP, R: ROOK, K: KING
    };
    const [boardPart, turnPart, handPart] = String(sfen).trim().split(/\s+/);
    const nextBoard = Array(9).fill(null).map(() => Array(9).fill(null));

    boardPart.split('/').forEach((row, y) => {
        let x = 0;
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (ch >= '1' && ch <= '9') {
                x += Number(ch);
                continue;
            }
            let promoted = false;
            let letter = ch;
            if (ch === '+') {
                promoted = true;
                letter = row[++i];
            }
            const owner = letter === letter.toUpperCase() ? SENTE : GOTE;
            const base = TYPE_BY_LETTER[letter.toUpperCase()];
            if (base && x < 9) {
                nextBoard[y][x] = { type: promoted ? `+${base}` : base, owner };
            }
            x++;
        }
    });

    const nextCaptured = { [SENTE]: initCaptured(), [GOTE]: initCaptured() };
    if (handPart && handPart !== '-') {
        let count = 0;
        for (const ch of handPart) {
            if (ch >= '0' && ch <= '9') {
                count = count * 10 + Number(ch);
                continue;
            }
            const owner = ch === ch.toUpperCase() ? SENTE : GOTE;
            const base = TYPE_BY_LETTER[ch.toUpperCase()];
            if (base) nextCaptured[owner][base] += count || 1;
            count = 0;
        }
    }

    return {
        board: nextBoard,
        capturedPieces: nextCaptured,
        turn: turnPart === 'w' ? GOTE : SENTE
    };
}

/** 詰将棋の局面を盤に載せる。initializeBoard から初期配置だけ差し替えた形。 */
function setupTsumePosition(problem) {
    aiRequestId++;
    tsumeSession++;
    hideAIThinkingIndicator();
    applyBoardOrientation();

    const parsed = parseTsumeSfen(problem.sfen);
    board = parsed.board;
    capturedPieces = parsed.capturedPieces;
    currentPlayer = parsed.turn;
    moveCount = 0;
    selectedPiece = null;
    validMoves = [];
    isCheck = false;
    checkmate = false;
    gameOver = false;
    lastMove = null;
    lastMoveDetail = null;
    hidePromoteDialog();
    hideGameOverDialog();
    moveHistory = [];
    usiMoveHistory = [];
    currentHistoryIndex = -1;
    positionHistory = [];
    checkHistory = [];

    recomputeKingPosCache();
    saveCurrentState();

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();
}

/** 「待った」などで局面を戻したあと、詰将棋側の状態を履歴に合わせ直す。 */
function syncTsumeStateFromHistory() {
    const problem = tsumeProblems[tsumeCurrent];
    const played = Math.max(0, currentHistoryIndex);

    tsumeRemaining = problem ? Math.max(0, problem.moves - played) : 0;
    tsumeFailed = false;

    // 作意から分かれた地点。外れた手（tsumeOffLine）でも別解（tsumeAltLine）でも、
    // そこから先は焼き込んだ手順が使えないという意味では同じなので、同じ扱いにする
    const branchIndex = tsumeOffLine ? tsumeDeviationIndex : tsumeAltLine ? tsumeAltIndex : -1;

    if (branchIndex >= 0 && played > branchIndex) {
        // まだ分かれた手より先にいる。作意の進行位置は分かれた時点で止めておく
        tsumePly = Math.max(0, Math.floor(branchIndex / 2));
    } else {
        tsumeOffLine = false;
        tsumeAltLine = false;
        tsumeDeviationIndex = -1;
        tsumeDeviationPly = 0;
        tsumeAltIndex = -1;
        tsumePly = Math.max(0, Math.floor(played / 2));
    }

    tsumeHintShown = false;
    tsumeToast('');
    // 「待った」で詰み上がりより前に戻ったなら、正解の知らせも引っ込める
    hideTsumeResult();
    renderTsumeUi();
}

/**
 * 助言・結果の表示。盤の中に浮かせて数秒で消す。
 *
 * 盤の上のパネルに枠を持たないので、盤の位置は文言の長さに影響されない。
 * そのぶん sub に補足を足して2行にしてもよい（枠を置いていた頃は1行に縛られていた）。
 * ここに出すのは一過性のものだけ。継続中の状態は setTsumeThinking() の方に出す。
 *
 * @param {string} text 主文。空文字なら今出ているトーストを即座に消す
 * @param {'good'|'bad'|''} [tone] 色
 * @param {string} [sub] 2行目の補足
 */
function tsumeToast(text, tone, sub) {
    if (tsumeToastTimer) {
        clearTimeout(tsumeToastTimer);
        tsumeToastTimer = null;
    }

    const stage = document.getElementById('board-stage');
    if (!stage) return;
    let toast = document.getElementById('tsume-toast');
    if (!toast) {
        if (!text) return;
        toast = document.createElement('div');
        toast.id = 'tsume-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        stage.appendChild(toast);
    }

    if (!text) {
        toast.classList.remove('visible');
        return;
    }

    toast.textContent = text;
    if (sub) {
        const line = document.createElement('span');
        line.className = 'tsume-toast-sub';
        line.textContent = sub;
        toast.appendChild(line);
    }
    toast.classList.toggle('tone-good', tone === 'good');
    toast.classList.toggle('tone-bad', tone === 'bad');
    toast.classList.add('visible');

    tsumeToastTimer = setTimeout(() => {
        tsumeToastTimer = null;
        toast.classList.remove('visible');
    }, TSUME_TOAST_MS[tone || ''] ?? TSUME_TOAST_MS['']);
}

/**
 * 玉方の応手待ち・答えの再生中といった「続いている状態」の表示。
 * トーストで出すと数秒で消えてしまい、待っているのか固まったのか分からなくなるので、
 * 対局の思考中と同じ盤上インジケータを文言だけ差し替えて使う。
 * null を渡すと消す。
 *
 * 詰将棋では駒が盤の上側に固まるので、インジケータもトーストと同じ下辺に出す
 * （位置は style.css の body.mode-tsume #ai-thinking-indicator）。同じ場所なので、
 * 出すときに残っているトーストを引っ込める。新しく何かが始まった時点で、
 * 前の一言は用済みになっている。
 */
function setTsumeThinking(text) {
    if (text) {
        tsumeToast('');
        showAIThinkingIndicator(text);
    } else {
        hideAIThinkingIndicator();
    }
}

/**
 * 指定の難易度の問題を最初から並べ直す。
 * 同じ難易度を押したときも並べ直すので、これが「やり直す」の役目も兼ねている。
 * 解けた記録（✓）は消さない。解き直しで✓が消えると、解いた事実まで無かったことになる。
 */
function loadTsumeProblem(index) {
    const problem = tsumeProblems[index];
    if (!problem) return;
    tsumeCurrent = index;
    tsumePly = 0;
    tsumeBusy = false;
    tsumeHintShown = false;
    tsumeRemaining = problem.moves;
    tsumeOffLine = false;
    tsumeDeviationIndex = -1;
    tsumeDeviationPly = 0;
    tsumeAltLine = false;
    tsumeAltIndex = -1;
    tsumeFailed = false;

    // 前の問題の答えや結果を出したままにしない（ここは再挑戦の入口も兼ねている）
    hideTsumeKifu();
    hideTsumeResult();
    setupTsumePosition(problem);
    renderTsumeUi();

    if (tsumeStatus[index] === 'solved') {
        tsumeToast('正解済みです。もう一度解けます', 'good');
    } else {
        tsumeToast('');
    }
}

/**
 * finalizeMove の最後から呼ばれる。攻方の手を受けて次に何をするかを決める。
 *
 *   王手でない        → その場で戻す（詰将棋は王手の連続というルールの話）
 *   手数内に詰んだ    → 正解。作意どおりでも別手順でも同じ
 *   残り0で詰んでない → 玉方に1手だけ逃げてもらってから「詰みませんでした」
 *   作意どおり        → 焼き込み済みの応手を再生する（探索は要らない）
 *   別解（accept）    → 探索に応手を選ばせる。焼き込みの応手は作意手にしか通じないため
 *   作意から外れた    → 探索に「残りN手で詰まない応手」を選ばせて指す
 */
function tsumeAfterMove(usiMove) {
    if (tsumeAutoPlaying) return;
    const problem = tsumeProblems[tsumeCurrent];
    if (!problem) return;

    // 王手を続けるのは詰将棋のルール。ここだけは即座に戻して理由を伝える
    if (!isCheck) {
        tsumeRejectMove('nocheck');
        return;
    }

    const startedAt = Date.now();
    const session = tsumeSession;
    tsumeRemaining = Math.max(0, tsumeRemaining - 1);

    if (checkmate) {
        tsumeFinish();
        return;
    }

    const onLine = !tsumeOffLine && !tsumeAltLine;
    const step = onLine ? problem.line[tsumePly] : null;
    if (step && usiMove && step.accept.includes(usiMove)) {
        // 作意手そのものなら、焼き込んだ応手をそのまま指せる（探索を待たせずに済む）。
        // 合法性を確かめるのは、「待った」と「進む」で作意の進行位置がずれていても
        // 違法手を盤に載せないため。executeAIMove は合法性を見ないので、ここが最後の砦。
        if (usiMove === step.attack) {
            if (step.defend === null) {
                // 作意の最終手なのに詰んでいない＝データが壊れている。念のため正解にしておく
                tsumePly++;
                tsumeFinish();
                return;
            }
            if (canPlayTsumeDefense(step.defend)) {
                tsumePly++;
                tsumePlayDefense(session, step.defend, startedAt, false);
                return;
            }
        }
        // 別解（作意と同じ手数で詰む別の正解手）。焼き込んだ応手は作意手のあとの局面に
        // しか通じないので、ここから先は探索に任せる。正しい手なので咎めない
        tsumeAltLine = true;
        tsumeAltIndex = Math.max(0, currentHistoryIndex - 1);
    } else if (onLine) {
        tsumeOffLine = true;
        tsumeDeviationIndex = Math.max(0, currentHistoryIndex - 1);
        tsumeDeviationPly = currentHistoryIndex;
        // 一度でも外れたら、その日その問題ではもう一発正解にはならない
        markTsumeAssisted(tsumeCurrent);
    }

    if (tsumeRemaining <= 0) {
        tsumeShowEscapeThenFail(session, startedAt);
        return;
    }

    tsumeBusy = true;
    setTsumeThinking(TSUME_THINKING_TEXT);
    renderTsumeUi();
    askTsumeDefense(tsumeRemaining).then((result) => {
        if (!isTsumeCurrentSession(session)) return;
        if (result.kind === 'mated') {
            // 直前に詰みを見落としていた場合の保険
            tsumeBusy = false;
            tsumeFinish();
            return;
        }
        if (!result.usi) {
            // 証明できないときは推測で指さない。従来どおり1手戻して伝える
            tsumeBusy = false;
            tsumeRejectMove('unproven');
            return;
        }
        // 応手のあと王手が続かないなら、指す手が無くなって手詰まりになる。そこで終わりにする
        tsumePlayDefense(session, result.usi, startedAt, result.attackerHasCheck === false);
    });
}

/** 応手を頼んだときの局面がまだ画面に出ているか。並べ直されていたら捨てる。 */
function isTsumeCurrentSession(session) {
    return isTsumeMode() && tsumeSession === session;
}

/**
 * 焼き込んである玉方の応手を、いまの局面にそのまま指してよいか。
 *
 * この応手は作意手のあとの局面に対してだけ求めてあるので、別解を指されたあとや、
 * 「待った」と「進む」で進行位置がずれたあとでは違法手になりうる
 * （玉が相手の利きへ逃げる、味方の駒に重なる、駒がもう無い、など）。
 * executeAIMove は合法性を見ずに盤へ載せてしまうため、指す前にここで確かめる。
 */
function canPlayTsumeDefense(usiMove) {
    const move = usiMoveToMove(usiMove);
    if (!move) return false;

    if (move.type === 'drop') {
        if ((capturedPieces[currentPlayer]?.[move.pieceType] ?? 0) <= 0) return false;
        return calculateDropLocations(move.pieceType, currentPlayer)
            .some((spot) => spot.x === move.toX && spot.y === move.toY);
    }

    const piece = board[move.fromY]?.[move.fromX];
    if (!piece || piece.owner !== currentPlayer) return false;
    return calculateValidMoves(move.fromX, move.fromY, piece)
        .some((spot) => spot.x === move.toX && spot.y === move.toY);
}

/**
 * 玉方の応手を、少し間を置いてから指す。
 *
 * 待ち時間を作意どおりのときと揃えているのは、探索が走ったかどうかで間が変わると
 * 「いま手順を外した」と分かってしまい、最後まで指させる意味が無くなるため。
 */
function tsumePlayDefense(session, usiMove, startedAt, outOfChecks) {
    tsumeBusy = true;
    setTsumeThinking(TSUME_THINKING_TEXT);
    renderTsumeUi();

    const wait = Math.max(0, TSUME_REPLY_DELAY_MS - (Date.now() - startedAt));
    setTimeout(() => {
        if (!isTsumeCurrentSession(session)) return;
        tsumeBusy = false;
        tsumeAutoPlaying = true;
        try {
            executeAIMove(usiMoveToMove(usiMove));
        } finally {
            tsumeAutoPlaying = false;
        }
        tsumeRemaining = Math.max(0, tsumeRemaining - 1);
        setTsumeThinking(null);
        if (outOfChecks) {
            tsumeFail(tsumeProblems[tsumeCurrent], 'nomorecheck');
            return;
        }
        renderTsumeUi();
    }, wait);
}

/**
 * 手数を使い切ったのに詰んでいない。
 * 玉方に1手だけ逃げてもらってから伝える。文字で「詰みません」と言われるより、
 * 実際に逃げられるところを見たほうが納得できる。
 */
function tsumeShowEscapeThenFail(session, startedAt) {
    tsumeBusy = true;
    setTsumeThinking(TSUME_THINKING_TEXT);
    renderTsumeUi();

    askTsumeDefense(0).then((result) => {
        const wait = Math.max(0, TSUME_REPLY_DELAY_MS - (Date.now() - startedAt));
        setTimeout(() => {
            if (!isTsumeCurrentSession(session)) return;
            tsumeBusy = false;
            if (result.usi) {
                tsumeAutoPlaying = true;
                try {
                    executeAIMove(usiMoveToMove(result.usi));
                } finally {
                    tsumeAutoPlaying = false;
                }
            }
            tsumeFail(tsumeProblems[tsumeCurrent]);
        }, wait);
    });
}

/**
 * 詰ませられなかった。どこで手順が変わったかを添えて伝える。
 *   （既定）      … 手数を使い切った
 *   nomorecheck … 王手が続かなくなった。このまま置くと指す手が無くて固まる
 */
function tsumeFail(problem, reason) {
    if (!problem) return;
    gameOver = true;
    tsumeFailed = true;
    setTsumeThinking(null);
    // 王手が尽きた場合、手数は残っていても使えない。数字だけ残ると
    // 「まだ指せるのに詰まないと言われた」と読めるので 0 に揃える
    tsumeRemaining = 0;
    // トーストは盤の上に浮くので、何手目で外したかを2行目に添えられる
    tsumeToast(
        reason === 'nomorecheck'
            ? `王手が続かず詰みませんでした`
            : `${problem.moves}手では詰みませんでした`,
        'bad',
        tsumeDeviationPly > 0 ? `${tsumeDeviationPly}手目から手順が変わっています` : ''
    );
    renderTsumeUi();
}

/** 手順が変わったところまで戻す。失敗表示と、外れている間のヒントから使う。 */
function tsumeReturnToDeviation() {
    if (tsumeDeviationIndex < 0) return;
    restoreState(tsumeDeviationIndex);
    syncTsumeStateFromHistory();
    tsumeToast('手順が変わった手の前に戻しました');
}

/**
 * その場で1手戻す。
 *   nocheck  … 王手でない手（ルール違反）
 *   unproven … 玉方の逃げ方を証明できなかったとき。手数を使い切らせると
 *              誤って「正解」を出しかねないので、ここは従来どおりの動きにする。
 */
function tsumeRejectMove(reason) {
    const target = currentHistoryIndex - 1;
    if (target >= 0) restoreState(target);
    syncTsumeStateFromHistory();
    // syncTsumeStateFromHistory がトーストを消すので、そのあとに出す
    tsumeToast(
        reason === 'nocheck'
            ? '詰将棋では王手をかけ続ける必要があります'
            : 'その王手では詰みません',
        'bad'
    );
}

// --- 詰み上がりの演出と結果バー ---
//
// 正解しても専用の音は鳴らさない。駒音は指すたびに鳴っているので正解も耳に届くし、
// 音を切る手立てをこのサイトは持っていないため、鳴らす種類を増やすほど
// 音を出せない場所で開いた人の逃げ場が無くなる。伝えるのは画面の中だけで足りる。

/** (fromX, fromY) の駒が (targetX, targetY) に利いているか。間に駒があれば止まる */
function tsumePieceAttacks(fromX, fromY, piece, targetX, targetY) {
    for (const movement of getPieceMovements(piece.type, piece.owner)) {
        for (let step = 1; step <= movement.range; step++) {
            const x = fromX + movement.dx * step;
            const y = fromY + movement.dy * step;
            if (x < 0 || x >= 9 || y < 0 || y >= 9) break;
            if (x === targetX && y === targetY) return true;
            if (board[y][x]) break;
        }
    }
    return false;
}

/** 玉に王手をかけている攻方の駒のマス。両王手なら複数返る */
function tsumeCheckingSquares() {
    const kingPos = getKingPosCached(GOTE);
    if (!kingPos) return [];

    const found = [];
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (!piece || piece.owner !== SENTE) continue;
            if (tsumePieceAttacks(x, y, piece, kingPos.x, kingPos.y)) found.push({ x, y });
        }
    }
    return found;
}

/**
 * 詰み上がりの演出。玉のマスから波紋を広げ、詰ましている駒を光らせる。
 *
 * 光らせるのは「王手をかけている駒」と「最後に指した駒」だけにする。
 * 逃げ道を塞いでいる駒まで拾うと盤の半分が光り、どれが効いているのか分からなくなる。
 *
 * 付けたクラスは消さない。局面を並べ直すと renderBoard() がマスごと作り直すため。
 */
function showTsumeMateEffect() {
    const kingPos = getKingPosCached(GOTE);
    if (!kingPos || !boardElement) return;

    const kingSquare = boardElement.querySelector(
        `.square[data-x="${kingPos.x}"][data-y="${kingPos.y}"]`
    );
    if (kingSquare) {
        kingSquare.classList.add('tsume-mate-king');
        const ripple = document.createElement('span');
        ripple.className = 'tsume-mate-ripple';
        ripple.addEventListener('animationend', () => ripple.remove());
        kingSquare.appendChild(ripple);
    }

    const marks = tsumeCheckingSquares();
    if (lastMove) marks.push(lastMove);
    for (const { x, y } of marks) {
        if (x === kingPos.x && y === kingPos.y) continue;
        const square = boardElement.querySelector(`.square[data-x="${x}"][data-y="${y}"]`);
        if (square) square.classList.add('tsume-mate-piece');
    }
}

/**
 * 「次の問題へ」の行き先。まだ解けていない中から、いまより難しいほうを先に探す。
 * 上に無ければやさしいほうへ回す（導線が消えるより、逆方向でも次があるほうがよい）。
 * 難易度は tsumeProblems の並び順そのもの。見つからなければ -1（＝全問正解）。
 */
function nextTsumeIndex() {
    for (let index = tsumeCurrent + 1; index < tsumeProblems.length; index++) {
        if (tsumeStatus[index] !== 'solved') return index;
    }
    for (let index = tsumeCurrent - 1; index >= 0; index--) {
        if (tsumeStatus[index] !== 'solved') return index;
    }
    return -1;
}

/** 結果バーの中の進捗ドット。見た目だけの要素なので、読み上げには件数だけを渡す */
function renderTsumeResultDots(solvedCount) {
    const dots = document.getElementById('tsume-result-dots');
    if (!dots) return;

    dots.replaceChildren(...tsumeProblems.map((problem, index) => {
        const dot = document.createElement('span');
        dot.className = 'tsume-result-dot';
        if (tsumeStatus[index] === 'solved') dot.classList.add('is-done');
        // いま解けた1つだけ跳ねさせる。全部が動くと何が変わったのか分からない
        if (index === tsumeCurrent) dot.classList.add('is-just');
        return dot;
    }));

    const label = document.createElement('span');
    label.className = 'tsume-result-dots-label';
    label.textContent = `${solvedCount}/${tsumeProblems.length}問`;
    dots.appendChild(label);
    dots.setAttribute('aria-label', `${tsumeProblems.length}問中${solvedCount}問正解`);
}

/**
 * 結果バーを組み立てて出す。7問すべて解けたときは同じ枠を制覇カードに切り替える。
 *
 * @param {object} problem いま解けた問題
 * @param {{clean: boolean, offLine: boolean}} outcome 解き方。バッジの文言を決める
 * @param {{streakUp: boolean, milestone: number}|null} record 初めて解いたときの記録
 */
function openTsumeResult(problem, outcome, record) {
    const bar = document.getElementById('tsume-result');
    if (!bar) return;

    const solvedCount = tsumeStatus.filter((status) => status === 'solved').length;
    const nextIndex = nextTsumeIndex();
    const cleared = nextIndex < 0;
    bar.classList.toggle('is-clear', cleared);

    const crown = document.getElementById('tsume-result-crown');
    if (crown) crown.hidden = !cleared;

    const title = document.getElementById('tsume-result-title');
    if (title) {
        title.textContent = cleared
            ? `${tsumeProblems.length}問すべて正解`
            : `正解！ ${problem.moves}手詰`;
    }

    // 作意とは違う手順で詰ませたのも十分な成果なので、一発正解と同じ枠で伝える。
    // 作意を外れた時点で一発正解ではなくなるので、この2つが並ぶことはない。
    // 制覇カードでは一発正解の数を下の行にまとめて出すので、バッジは重ねない
    const badge = document.getElementById('tsume-result-badge');
    if (badge) {
        const label = outcome.clean ? '一発正解' : (outcome.offLine ? '別手順で達成' : '');
        badge.textContent = label;
        badge.hidden = cleared || label === '';
    }

    renderTsumeResultSub(cleared, record);
    renderTsumeResultDots(solvedCount);

    const next = document.getElementById('tsume-result-next');
    if (next) {
        next.hidden = cleared;
        if (!cleared) {
            const target = tsumeProblems[nextIndex];
            next.textContent = `次の問題へ（${target.levelLabel} ${target.moves}手詰）`;
            next.dataset.index = String(nextIndex);
        }
    }
    // 制覇したときは共有が主役。それ以外は「次の問題へ」に譲って脇に置く
    const share = document.getElementById('tsume-result-share');
    if (share) {
        share.textContent = cleared ? '結果をXで共有' : '共有';
        share.classList.toggle('is-primary', cleared);
    }
    const dismiss = document.getElementById('tsume-result-dismiss');
    if (dismiss) dismiss.hidden = !cleared;

    bar.hidden = false;
    // hidden を外した直後に is-open を足しても transition が始まらないので、
    // レイアウトを一度確定させてから付ける。requestAnimationFrame ではなくこの形にするのは、
    // タブが裏に回っているとフレームが来ず、戻るまでバーが出ないままになるため
    void bar.offsetWidth;
    bar.classList.add('is-open');
}

/** 連続日数・累計の節目・一発正解の数。出せるものが無い日は行ごと消す */
function renderTsumeResultSub(cleared, record) {
    const sub = document.getElementById('tsume-result-sub');
    if (!sub) return;

    const parts = [];
    if (cleared) {
        const cleanCount = tsumeClean.filter(Boolean).length;
        if (cleanCount > 0) parts.push({ text: `一発正解 ${cleanCount}問` });
    }
    // 過去の日をさかのぼって解いても連続日数は動かないので、その日は出さない
    if (isTsumeDateToday()) {
        const streak = tsumeLiveStreak();
        if (streak > 0) {
            parts.push({
                text: `${streak}日連続`,
                className: 'tsume-result-streak',
                up: Boolean(record?.streakUp)
            });
        }
    }
    if (record?.milestone > 0) {
        parts.push({ text: `累計${record.milestone}問達成`, className: 'tsume-result-milestone' });
    }

    sub.replaceChildren(...parts.map((part) => {
        const span = document.createElement('span');
        if (part.className) span.className = part.className;
        if (part.up) span.classList.add('is-up');
        span.textContent = part.text;
        return span;
    }));
    sub.hidden = parts.length === 0;
}

/**
 * 結果バーを閉じる。閉じたあとも難易度タブから次の問題へ行けるので行き止まりにはならない。
 * 局面を並べ直すときにも呼ぶ（前の問題の結果が残っていると今の局面と食い違う）。
 */
function hideTsumeResult() {
    const bar = document.getElementById('tsume-result');
    if (!bar || bar.hidden) return;
    bar.classList.remove('is-open');
    // 透明になりきってから hidden にする。すぐ隠すと閉じる動きが出ない。
    // 待っている間に開き直されることがあるので、そのときは触らない
    setTimeout(() => {
        if (!bar.classList.contains('is-open')) bar.hidden = true;
    }, 280);
}

/** 結果バーの操作。ページを開いたときに1度だけ繋ぐ */
function setUpTsumeResultBar() {
    const bar = document.getElementById('tsume-result');
    if (!bar) return;

    const next = document.getElementById('tsume-result-next');
    if (next) {
        next.addEventListener('click', () => {
            const index = Number(next.dataset.index);
            // loadTsumeProblem がバーを閉じるので、ここでは閉じない
            if (Number.isInteger(index)) loadTsumeProblem(index);
        });
    }
    const share = document.getElementById('tsume-result-share');
    if (share) {
        share.addEventListener('click', () => window.open(tsumeShareUrl(), '_blank', 'noopener'));
    }
    for (const id of ['tsume-result-close', 'tsume-result-dismiss']) {
        document.getElementById(id)?.addEventListener('click', hideTsumeResult);
    }

    // バー以外を押したら閉じる。盤の操作を止めている要素があっても拾えるよう捕捉段階で見る。
    // pointerdown ではなく click にしているのは、スマホで画面を送っただけで消えないようにするため
    document.addEventListener('click', (event) => {
        if (bar.hidden) return;
        if (event.target instanceof Element && event.target.closest('#tsume-result')) return;
        hideTsumeResult();
    }, true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideTsumeResult();
    });
}

/** 詰み上がり。図を見せる間を置いてから演出、そのあと結果バーを出す。 */
function tsumeFinish() {
    gameOver = true;
    tsumeFailed = false;
    setTsumeThinking(null);
    // 結果はバーに一本化する。トーストと二重に出すと同じことを2箇所で言うことになる
    tsumeToast('');

    const problem = tsumeProblems[tsumeCurrent];
    if (!problem) return;

    // ヒントも答えも使わず、作意から一度も外れずに解けたか。
    // 「もう一度」をまたいでも消えないので、答えを見てからなぞっただけでは付かない
    const clean = !tsumeAssisted[tsumeCurrent];
    const outcome = { clean, offLine: tsumeOffLine };
    // 答えを見たあとでも、自分で並べ直して詰ませたなら正解として扱う。
    // 「一度見たらその日はもう記録が付かない」だと、押し間違いの代償が大きすぎるうえ、
    // 見て理解してから解き直すという一番伸びる練習の仕方に罰を与えることになる
    const firstTime = tsumeStatus[tsumeCurrent] !== 'solved';
    tsumeStatus[tsumeCurrent] = 'solved';
    if (clean) tsumeClean[tsumeCurrent] = true;
    const record = firstTime ? recordTsumeSolved(clean) : null;

    renderTsumeUi();

    const session = tsumeSession;
    setTimeout(() => {
        // 待っている間に問題を切り替えられたり「待った」で戻されたら何も出さない
        if (!isTsumeCurrentSession(session) || !gameOver) return;
        showTsumeMateEffect();
        setTimeout(() => {
            if (!isTsumeCurrentSession(session) || !gameOver) return;
            openTsumeResult(problem, outcome, record);
        }, TSUME_MATE_EFFECT_MS);
    }, TSUME_MATE_PAUSE_MS);
}

/** USI 文字列を内部の指し手に戻す。作意手順の再生用。 */
function usiMoveToMove(usiMove) {
    const TYPE_BY_LETTER = {
        P: PAWN, L: LANCE, N: KNIGHT, S: SILVER, G: GOLD, B: BISHOP, R: ROOK
    };
    const drop = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(usiMove);
    if (drop) {
        return {
            type: 'drop',
            pieceType: TYPE_BY_LETTER[drop[1]],
            toX: 9 - Number(drop[2]),
            toY: drop[3].charCodeAt(0) - 97
        };
    }
    const move = /^([1-9])([a-i])([1-9])([a-i])(\+?)$/.exec(usiMove);
    if (!move) return null;
    return {
        type: 'move',
        fromX: 9 - Number(move[1]),
        fromY: move[2].charCodeAt(0) - 97,
        toX: 9 - Number(move[3]),
        toY: move[4].charCodeAt(0) - 97,
        promote: move[5] === '+'
    };
}

/** 次の一手のヒント。動かす駒（または打つ駒）の位置だけを光らせる。 */
function showTsumeHint() {
    const problem = tsumeProblems[tsumeCurrent];
    if (!problem || gameOver) return;

    // 別解に入っている。用意してある手順はこの局面に続かないので、答えを教えられない。
    // 間違っているわけではないので、そこは誤解されないように書く。
    //
    // ここだけは助けを借りたことにせず、ボタンも押せるまま残す。
    // 教えられるものが何も無いのに一発正解の資格とヒント1回を取り上げるのは、
    // 別解を「間違いではない」と扱う（tsumeAltLine の説明を参照）のと食い違う
    if (tsumeAltLine) {
        tsumeToast('用意した手順とは別の詰み筋に入っています', '', 'この先のヒントは出せません');
        return;
    }

    // ここから先は何かしら答えに近づく話をするので、押した時点で助けを借りたことにする
    markTsumeAssisted(tsumeCurrent);

    // 作意から外れているとここから先の正解手は無い。
    // 「詰みません」と自分から言われに来た操作なので、ここでは素直に伝えてよい
    if (tsumeOffLine) {
        tsumeHintShown = true;
        tsumeToast(`残り${tsumeRemaining}手では詰みません`, 'bad');
        renderTsumeUi();
        return;
    }

    const step = problem.line[tsumePly];
    if (!step) return;

    tsumeHintShown = true;
    const move = usiMoveToMove(step.attack);
    if (!move) return;

    if (move.type === 'drop') {
        const label = getPieceDisplayLabel(move.pieceType, SENTE);
        tsumeToast(`ヒント: 持ち駒の「${label}」を打ちます`);
        document.querySelectorAll(`.captured-piece[data-type="${move.pieceType}"][data-owner="${SENTE}"]`)
            .forEach(el => el.classList.add('tsume-hint'));
    } else {
        tsumeToast('ヒント: 光っている駒を動かします');
        const square = boardElement.querySelector(`.square[data-x="${move.fromX}"][data-y="${move.fromY}"]`);
        if (square) square.classList.add('tsume-hint');
    }
    renderTsumeUi();
}

/**
 * 「答えを見る」で出す正解の棋譜。ボタンのすぐ下に、指す順のまま1行に並べる。
 *
 * 1行に収めて横スクロールにするのは、盤より上に置く要素だから。
 * 折り返して何行にもなると盤が画面の下に押し出され、肝心の再生が見えなくなる。
 * 再生に合わせて今の手に色と下線を付けるので、盤とテキストの対応が取れる。
 */
function renderTsumeKifu(problem) {
    const list = document.getElementById('tsume-kifu');
    if (!list) return;

    // 古い形式のJSONが残っていると棋譜が無い。その場合は盤の再生だけにする
    const labels = Array.isArray(problem.solution) ? problem.solution : [];
    if (labels.length === 0) {
        hideTsumeKifu();
        return;
    }

    list.replaceChildren(...labels.map((label, index) => {
        const item = document.createElement('li');
        item.className = 'tsume-kifu-move';
        const number = document.createElement('span');
        number.className = 'tsume-kifu-no';
        number.textContent = String(index + 1);
        const text = document.createElement('span');
        text.textContent = label;
        item.append(number, text);
        return item;
    }));
    list.scrollLeft = 0;
    list.hidden = false;
}

/** 再生中の手を濃くして、見えていなければ横スクロールで送る */
function highlightTsumeKifu(index) {
    const list = document.getElementById('tsume-kifu');
    if (!list || list.hidden) return;

    Array.from(list.children).forEach((item, position) => {
        item.classList.toggle('current', position === index);
    });

    // scrollIntoView はページごと動くことがあるので、棋譜の中だけを自分で送る
    // （.tsume-kifu は position: relative なので offsetLeft がそのまま中での位置になる）。
    // scrollLeft に直接入れているのは、なめらかスクロールが効かない環境だと
    // behavior: 'smooth' が丸ごと無視されて送られないため。1手ごとの短い移動なので困らない
    const current = list.children[index];
    if (!current) return;
    const left = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
    list.scrollLeft = Math.max(0, left);
}

function hideTsumeKifu() {
    const list = document.getElementById('tsume-kifu');
    if (!list) return;
    list.hidden = true;
    list.replaceChildren();
}

/** 答えを見る。棋譜をボタンの下に出したうえで、作意手順を1手ずつゆっくり並べる。 */
function revealTsumeAnswer() {
    const problem = tsumeProblems[tsumeCurrent];
    if (!problem) return;

    // 答えを見たら、そのあと並べ直して同じ手順をなぞっても一発正解にはしない
    markTsumeAssisted(tsumeCurrent);
    tsumeBusy = true;
    hideTsumeResult();
    renderTsumeKifu(problem);
    loadTsumeProblemForReveal(problem);
}

/**
 * 攻方の手と玉方の応手を1手ずつ間を空けて再生する。
 * まとめて並べると何が起きたか追えないので、指すたびに「何手目か」を出して待つ。
 */
function loadTsumeProblemForReveal(problem) {
    setupTsumePosition(problem);
    const session = tsumeSession;
    tsumePly = 0;
    tsumeRemaining = problem.moves;
    tsumeOffLine = false;
    tsumeDeviationIndex = -1;
    tsumeDeviationPly = 0;
    tsumeAltLine = false;
    tsumeAltIndex = -1;
    tsumeFailed = false;
    renderTsumeUi();

    // 攻方・玉方を交互に並べた1手ずつの列にする
    const plies = [];
    for (const step of problem.line) {
        plies.push({ usi: step.attack, side: '攻方' });
        if (step.defend) plies.push({ usi: step.defend, side: '玉方' });
    }

    let index = 0;
    const playNext = () => {
        // 再生中に問題を並べ直されたら止める。同じ難易度を押し直しても並べ直しになるので、
        // 問題オブジェクトの比較ではなく通し番号で見ないと古い再生が生き残る
        if (!isTsumeCurrentSession(session)) return;
        const ply = plies[index];
        if (!ply) {
            tsumeBusy = false;
            gameOver = true;
            tsumePly = problem.line.length;
            setTsumeThinking(null);
            tsumeToast(
                `これが正解の手順です（${problem.moves}手詰）`,
                '',
                '「もう一度」で挑戦できます'
            );
            renderTsumeUi();
            return;
        }
        tsumeAutoPlaying = true;
        try {
            executeAIMove(usiMoveToMove(ply.usi));
        } finally {
            tsumeAutoPlaying = false;
        }
        index++;
        tsumeRemaining = Math.max(0, problem.moves - index);
        // 棋譜は plies と同じ並び（攻方・玉方の交互）なので、そのまま今の手を指せる
        highlightTsumeKifu(index - 1);
        // 再生は数秒続く「状態」なので、消えるトーストではなく盤上インジケータに出す
        setTsumeThinking(`答えを再生中 ${index}/${plies.length}手目（${ply.side}）`);
        renderTsumeUi();
        setTimeout(playNext, TSUME_REVEAL_INTERVAL_MS);
    };
    setTsumeThinking(`答えを再生します（全${plies.length}手）`);
    setTimeout(playNext, TSUME_REVEAL_INTERVAL_MS);
}

// --- 出題日の切り替え ---
// 当日の問題はHTMLに焼き込み済み。過去の日は押されたときだけ
// /tsume/days/YYYY-MM-DD.json を取りに行って、盤と本文の答えを差し替える。
// 選べる日付は日付ナビ（#tsume-date）の選択肢がそのまま一覧なので、
// 未来の予定が混じることはない（ビルド時に当日以前だけを書き出している）。

/** 「8月9日」。日付を切り替えている間の表示に使う */
function tsumeDatePlain(date) {
    const [, month, day] = date.split('-').map(Number);
    return `${month}月${day}日`;
}

/** 表示中が最新の出題日か。デプロイが前日のままでも「今日へ」が迷子にならないよう最新で見る */
function tsumeLatestDate() {
    return tsumeDates.length > 0 ? tsumeDates[tsumeDates.length - 1] : tsumeDate;
}

/** 表示中が実際の今日か。記録や共有文の文言を分けるのに使う */
function isTsumeDateToday() {
    return Boolean(tsumeDate) && tsumeDate === jstToday();
}

/** 難易度タブを表示中の日のデータで組み直す。問題数や手数が変わっても追従できるようにする */
function renderTsumeLevelTabs() {
    const list = document.querySelector('#tsume-panel .tsume-levels');
    if (!list) return;
    list.replaceChildren(...tsumeProblems.map((problem, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tsume-level';
        button.dataset.index = String(index);
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        const name = document.createElement('span');
        name.className = 'tsume-level-name';
        name.textContent = problem.levelLabel;
        const moves = document.createElement('span');
        moves.className = 'tsume-level-moves';
        moves.textContent = `${problem.moves}手詰`;
        button.append(name, moves);
        return button;
    }));
}

/** 表示中の日付をURLに反映する。最新の日は既定なので付けない */
function tsumeSyncDateToUrl() {
    const url = new URL(window.location.href);
    if (tsumeDate === tsumeLatestDate()) {
        url.searchParams.delete('date');
    } else {
        url.searchParams.set('date', tsumeDate);
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * 日付まわりの見た目。日付そのもののほかに、
 *   ・「今日」の印（今日を見ているときだけ）
 *   ・左の「毎日更新」／「今日の問題へ」の入れ替え
 * を合わせて面倒を見る。どちらも行を増やさず、日付が日替わりであることを示すためのもの。
 */
function updateTsumeDateUi() {
    const select = document.getElementById('tsume-date');
    if (!select) return;
    select.value = tsumeDate;
    // 玉方の応手を再生している最中に切り替えると盤が壊れるので、その間は触れなくする
    const locked = tsumeDateLoading || tsumeBusy;
    select.disabled = locked;

    // 「今日」の印はビルド時に付いている。日付が今日でない日だけ外す
    // （デプロイが前日のままの日と、過去の日を選んだとき）
    const field = document.getElementById('tsume-date-field');
    if (field) {
        field.classList.toggle('is-today', isTsumeDateToday());
        field.classList.toggle('is-disabled', locked);
    }
    select.setAttribute('aria-label', isTsumeDateToday() ? '出題日（今日）' : '出題日');

    // 過去の日を見ている間は、左を戻り口に差し替える。
    // 最新の日で見るのは、デプロイが前日のままでも戻り先が迷子にならないようにするため
    const showBack = Boolean(tsumeDate) && tsumeDate !== tsumeLatestDate();
    const note = document.getElementById('tsume-date-note');
    const back = document.getElementById('tsume-date-back');
    if (note) note.hidden = showBack;
    if (back) {
        back.hidden = !showBack;
        back.disabled = locked;
    }
}

/** 表示中の日を差し替える。日付ナビ以外の見た目は renderTsumeUi に任せる */
function applyTsumeDay(data) {
    tsumeProblems = Array.isArray(data.problems) ? data.problems : [];
    tsumeDate = data.date || '';
    tsumeStatus = tsumeProblems.map(() => 'unsolved');
    tsumeClean = tsumeProblems.map(() => false);
    tsumeAssisted = tsumeProblems.map(() => false);
    restoreTsumeStatusFromProgress();
    tsumeToast('');
    renderTsumeLevelTabs();
    updateTsumeDateUi();
    loadTsumeProblem(0);
}

async function fetchTsumeDay(date) {
    const cached = tsumeDayCache.get(date);
    if (cached) return cached;

    const response = await fetch(`/tsume/days/${encodeURIComponent(date)}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.problems) || data.problems.length === 0) {
        throw new Error('問題が入っていません');
    }
    tsumeDayCache.set(date, data);
    return data;
}

/** 日付を選び直す。取れなかったときは今の問題をそのまま続けられるようにしておく */
async function selectTsumeDate(date) {
    if (tsumeDateLoading || tsumeBusy) return;
    if (!date || date === tsumeDate || !tsumeDates.includes(date)) {
        updateTsumeDateUi();
        return;
    }

    tsumeDateLoading = true;
    updateTsumeDateUi();
    // 取りに行っている間ずっと続く状態なので、消えるトーストではなく盤上インジケータに出す
    setTsumeThinking(`${tsumeDatePlain(date)}の問題を読み込んでいます…`);

    try {
        const data = await fetchTsumeDay(date);
        tsumeDateLoading = false;
        setTsumeThinking(null);
        applyTsumeDay(data);
        tsumeSyncDateToUrl();
    } catch (error) {
        console.warn('詰将棋の日付切り替えに失敗しました', error);
        tsumeDateLoading = false;
        setTsumeThinking(null);
        updateTsumeDateUi();
        tsumeToast('その日の問題を読み込めませんでした', 'bad');
    }
}

function setUpTsumeDateNav() {
    const select = document.getElementById('tsume-date');
    if (!select) return;
    // 選択肢は新しい順に並べてあるので、扱いやすい古い順に直して持つ
    tsumeDates = Array.from(select.options).map((option) => option.value).reverse();
    select.addEventListener('change', () => selectTsumeDate(select.value));

    const back = document.getElementById('tsume-date-back');
    if (back) back.addEventListener('click', () => selectTsumeDate(tsumeLatestDate()));
}

// --- 進捗（連続日数・正解数） ---

function jstToday() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD の前日。日付だけを扱うので、時差は考えずに1日引く */
function previousDate(date) {
    return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

/**
 * いま生きている連続日数。途切れていれば 0。
 *
 * 記録は解いた日にしか書き換わらないので、読むときに期限を見ないと、
 * 1週間ぶりに来た人にも「🔥5日連続」と出してしまう。
 * 昨日まで続いていれば、今日まだ解いていなくても生きている（今日解けば伸びる）。
 */
function tsumeLiveStreak(progress = readTsumeProgress()) {
    if (progress.streak <= 0) return 0;
    const today = jstToday();
    if (progress.lastDate === today || progress.lastDate === previousDate(today)) {
        return progress.streak;
    }
    return 0;
}

/**
 * 保存している進捗。
 *
 *   lastDate  … 最後に「1問でも解いた」日。連続日数を数えるのはこれだけ
 *   todayDate … today がどの日のものか。lastDate と分けているのは、
 *               ヒントを見ただけで解かずに終わった日があるため。
 *               一緒にすると、その日に解いていないのに連続日数が伸びてしまう
 *   today     … 難易度ごとの状態 'clean' | 'solved' | 'assisted'
 *               （古い形式では true。それは 'solved' として読む）
 */
function emptyTsumeProgress() {
    return { lastDate: '', todayDate: '', streak: 0, total: 0, today: {} };
}

function readTsumeProgress() {
    try {
        const raw = localStorage.getItem(TSUME_STORAGE_KEY);
        if (!raw) return emptyTsumeProgress();
        const parsed = JSON.parse(raw);
        const lastDate = parsed.lastDate || '';
        return {
            lastDate,
            // todayDate が無いのは分ける前に保存されたもの。当時は lastDate の日のぶんだった
            todayDate: parsed.todayDate || lastDate,
            streak: Number(parsed.streak) || 0,
            total: Number(parsed.total) || 0,
            today: parsed.today && typeof parsed.today === 'object' ? parsed.today : {}
        };
    } catch (error) {
        return emptyTsumeProgress();
    }
}

/** today を今日のものに揃える。日付が変わっていれば作り直す */
function freshenTsumeToday(progress, today) {
    if (progress.todayDate !== today) {
        progress.todayDate = today;
        progress.today = {};
    }
    return progress;
}

/**
 * 「助けを借りた」を残す。ヒント・答えを見る・作意から外れる の3か所から呼ぶ。
 *
 * localStorage にも書くのは、これがメモリだけだと再読み込みで消えてしまい、
 * 答えを見る → 読み込み直す → 覚えた手順をなぞる、で一発正解が付いてしまうため。
 * すでに正解の記録がある問題は触らない（解き直しで格下げしない）。
 */
function markTsumeAssisted(index) {
    tsumeAssisted[index] = true;

    const problem = tsumeProblems[index];
    if (!problem || !isTsumeDateToday()) return;
    const progress = freshenTsumeToday(readTsumeProgress(), jstToday());
    if (progress.today[problem.level]) return;
    progress.today[problem.level] = 'assisted';
    writeTsumeProgress(progress);
}

function writeTsumeProgress(progress) {
    try {
        localStorage.setItem(TSUME_STORAGE_KEY, JSON.stringify(progress));
    } catch (error) {
        // プライベートブラウジングなどで書けなくても進行は妨げない
    }
}

/**
 * 正解を記録する。1問でも解いた日を「挑戦した日」として連続日数を数える。
 * 過去の日を解いても記録しない。あとからさかのぼって連続日数が伸びるのは実態に合わない。
 *
 * @param {boolean} clean 一発正解だったか。難易度ごとに 'clean' として残す
 * @returns {{streak: number, streakUp: boolean, milestone: number}|null}
 *          結果バーに出す情報。記録しない日（過去の日）は null
 */
function recordTsumeSolved(clean) {
    if (!isTsumeDateToday()) return null;
    const today = jstToday();
    const progress = freshenTsumeToday(readTsumeProgress(), today);
    const problem = tsumeProblems[tsumeCurrent];
    if (!problem) return null;

    // その日の1問目かどうか。連続日数が伸びた瞬間だけ演出したいので覚えておく
    let streakUp = false;
    if (progress.lastDate !== today) {
        progress.streak = progress.lastDate === previousDate(today) ? progress.streak + 1 : 1;
        progress.lastDate = today;
        streakUp = true;
    }
    // 以前に一発で解いていればその記録を優先する（解き直しで格下げしない）
    const already = progress.today[problem.level];
    progress.today[problem.level] = clean || already === 'clean' ? 'clean' : 'solved';
    progress.total += 1;
    // 節目はまたいだ瞬間だけ。毎回出すと「達成」の重みが無くなる
    const milestone = TSUME_MILESTONES.includes(progress.total) ? progress.total : 0;

    writeTsumeProgress(progress);
    renderTsumeUi();
    return { streak: progress.streak, streakUp, milestone };
}

/**
 * 今日ぶんの記録を画面の状態に戻す。
 * これが無いと、再読み込みしただけで難易度タブの✓も進捗ドットも 0 に戻り、
 * 「今日は3問解いた」という事実と画面が食い違う。
 *
 * 助けを借りた記録（'assisted' と、一発ではない 'solved'）も戻す。
 * ここを戻さないと、答えを見たあと読み込み直すだけで一発正解が取れてしまう。
 */
function restoreTsumeStatusFromProgress() {
    if (!isTsumeDateToday()) return;
    const progress = readTsumeProgress();
    if (progress.todayDate !== jstToday()) return;

    tsumeProblems.forEach((problem, index) => {
        const record = progress.today[problem.level];
        if (!record) return;
        // 'assisted' は「助けは借りたが、まだ解けていない」
        if (record !== 'assisted') tsumeStatus[index] = 'solved';
        if (record === 'clean') tsumeClean[index] = true;
        else tsumeAssisted[index] = true;
    });
}

// --- UI ---

/**
 * 日付の行の右に出す連続日数。
 * 解いた数（n/7）は難易度タブの✓と同じことを言っているので出さない。
 * 連続日数は他に表す場所が無く、明日また来る理由になるのでこれだけ残す。
 * 記録を付けていない過去の日は空にする（1日ぶん解いても連続が伸びるわけではない）。
 *
 * 1日目から出す。始めた日に何も出ないと、次の日に「2日連続」が急に現れることになり、
 * 何を数えているのかが伝わらない。
 */
function tsumeStreakText() {
    if (tsumeDate && !isTsumeDateToday()) return '';
    const streak = tsumeLiveStreak();
    return streak > 0 ? `🔥 ${streak}日連続` : '';
}

function renderTsumeUi() {
    const panel = document.getElementById('tsume-panel');
    if (!panel) return;

    panel.querySelectorAll('.tsume-level').forEach((button) => {
        const index = Number(button.dataset.index);
        const active = index === tsumeCurrent;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.classList.toggle('solved', tsumeStatus[index] === 'solved');
    });

    const streak = document.getElementById('tsume-streak');
    if (streak) streak.textContent = tsumeStreakText();

    // 残り手数。「この手数で詰ませる」という制約が常に見えていないと、
    // 手数を使い切ったときに何が起きたのか分からない。
    // どこで手順が外れたかは、失敗のトーストの2行目に添える（ここは数字だけに保つ）
    const remaining = document.getElementById('tsume-remaining');
    const count = remaining?.querySelector('b');
    if (remaining && count) {
        count.textContent = tsumeProblems[tsumeCurrent] ? String(tsumeRemaining) : '0';
        remaining.classList.toggle('tsume-remaining-low', !gameOver && tsumeRemaining <= 1);
        remaining.classList.toggle('tsume-remaining-out', tsumeFailed);
    }

    // 終わったあとの「ヒント」はどのみち押せないので、その場面でしたいことに差し替える。
    // 行を増やすと盤が下にずれるので、この枠に出すのは常に1つだけ（ボタンの数は変えない）
    //   失敗（手順が外れた）        … 外れた手の前に戻る
    //   正解・答えを見終わった      … もう一度
    const showBack = tsumeFailed && tsumeDeviationPly > 0;
    const showRetry = !showBack && gameOver;
    const hintButton = document.getElementById('tsume-hint');
    if (hintButton) {
        hintButton.hidden = showBack || showRetry;
        hintButton.disabled = gameOver || tsumeHintShown;
    }
    const backButton = document.getElementById('tsume-back');
    if (backButton) {
        backButton.hidden = !showBack;
        // 2つ並びの1つぶんの幅に収める。折り返すとボタンの列が高くなって盤が下にずれる
        backButton.textContent = `${tsumeDeviationPly}手目に戻る`;
    }

    // 再生中・応手待ち中に押されると盤が壊れるので、局面を並べ直す操作は止める
    const retryButton = document.getElementById('tsume-retry');
    if (retryButton) {
        retryButton.hidden = !showRetry;
        retryButton.disabled = tsumeBusy;
    }
    const revealButton = document.getElementById('tsume-reveal');
    if (revealButton) revealButton.disabled = tsumeBusy;
    panel.querySelectorAll('.tsume-level').forEach((button) => {
        button.disabled = tsumeBusy;
    });

    updateTsumeDateUi();
}

/**
 * 共有する文面。難易度の並びをそのまま四角の列にする（左が初級、右が超越）。
 * どの問題を解いたかは伝わるが、手順は何も漏れない。
 * 数字だけの「3問解きました」より、並びが見えるほうが目に留まり話題にもなる。
 */
function tsumeShareUrl() {
    // 過去の日は「今日の詰将棋」ではないので、文言もリンク先もその日のものにする
    const pageUrl = new URL('https://shogi.yuki-lab.com/tsume/');
    const today = isTsumeDateToday();
    if (tsumeDate && !today) pageUrl.searchParams.set('date', tsumeDate);

    const solved = tsumeStatus.filter((status) => status === 'solved').length;
    const grid = tsumeProblems
        .map((problem, index) => (tsumeStatus[index] === 'solved' ? '🟧' : '⬜'))
        .join('');

    const lines = [`詰将棋Web ${tsumeShareDate()}　${solved}/${tsumeProblems.length}問`, grid];

    const notes = [];
    const cleanCount = tsumeClean.filter(Boolean).length;
    if (cleanCount > 0) notes.push(`一発正解 ${cleanCount}問`);
    if (today) {
        const streak = tsumeLiveStreak();
        if (streak > 0) notes.push(`${streak}日連続`);
    }
    if (notes.length > 0) lines.push(notes.join('／'));
    lines.push('#将棋Web');

    const text = lines.join('\n');
    return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl.toString())}`;
}

/** 共有文の頭に置く「8/11」。長い日付だと1行目が折り返して並びが読みにくくなる */
function tsumeShareDate() {
    const [, month, day] = (tsumeDate || jstToday()).split('-').map(Number);
    return `${month}/${day}`;
}

function startTsumeMode() {
    const dataElement = document.getElementById('tsume-data');
    if (dataElement) {
        try {
            const parsed = JSON.parse(dataElement.textContent);
            tsumeProblems = Array.isArray(parsed.problems) ? parsed.problems : [];
            tsumeDate = parsed.date || '';
            // 当日は取りに行かなくて済むよう、焼き込み済みのぶんを最初から控えておく
            if (tsumeDate) tsumeDayCache.set(tsumeDate, parsed);
        } catch (error) {
            console.error('詰将棋データの読み込みに失敗しました', error);
        }
    }

    if (tsumeProblems.length === 0) {
        tsumeToast('本日の問題を読み込めませんでした', 'bad');
        return;
    }

    tsumeStatus = tsumeProblems.map(() => 'unsolved');
    tsumeClean = tsumeProblems.map(() => false);
    tsumeAssisted = tsumeProblems.map(() => false);
    restoreTsumeStatusFromProgress();
    setUpTsumeResultBar();

    const panel = document.getElementById('tsume-panel');
    if (panel) {
        // タブは日付を切り替えるたびに組み直すので、まとめて1つで受ける。
        // 押されたのが今と同じ難易度でも並べ直すので、これが再挑戦の入口も兼ねる
        const levels = panel.querySelector('.tsume-levels');
        if (levels) {
            levels.addEventListener('click', (event) => {
                const button = event.target.closest('.tsume-level');
                if (button && !button.disabled) loadTsumeProblem(Number(button.dataset.index));
            });
        }
        setUpTsumeDateNav();
        const hintButton = document.getElementById('tsume-hint');
        if (hintButton) hintButton.addEventListener('click', showTsumeHint);
        const revealButton = document.getElementById('tsume-reveal');
        if (revealButton) revealButton.addEventListener('click', revealTsumeAnswer);
        const backButton = document.getElementById('tsume-back');
        if (backButton) backButton.addEventListener('click', tsumeReturnToDeviation);
        const retryButton = document.getElementById('tsume-retry');
        if (retryButton) retryButton.addEventListener('click', () => loadTsumeProblem(tsumeCurrent));
    }

    loadTsumeProblem(0);

    // ?date= 付きで開かれたときは、当日の盤を出してからその日に差し替える。
    // 盤を1度描き直すことになるが、当日ぶんの表示速度は変えたくない
    const requested = new URLSearchParams(window.location.search).get('date');
    if (requested && requested !== tsumeDate) {
        if (tsumeDates.includes(requested)) {
            selectTsumeDate(requested);
        } else {
            // もう選べない日付。URLだけ当日に揃えておく
            tsumeSyncDateToUrl();
        }
    }

    // 玉方の応手を待たせないよう、手が空いているうちに探索を読み込んでおく。
    // 詰将棋ページ以外では起動しないので、他のページの転送量は変わらない。
    const warmUpSolver = () => ensureTsumeSolver();
    if (window.requestIdleCallback) {
        window.requestIdleCallback(warmUpSolver, { timeout: 4000 });
    } else {
        window.setTimeout(warmUpSolver, 1500);
    }
}

renderDifficultyUi();

// gameMode はファイル冒頭でパスから確定済み（/ = ai, /board/ = pvp, /online/ = online）。
// 旧形式の ?mode= / ?room= はWorker側でパス形式へリダイレクトしている。
const urlRoom = new URLSearchParams(window.location.search).get('room');

// 友達対戦の前回設定（手番・持ち時間）を復元
loadFriendPrefs();

if (gameMode === ONLINE_MODE) {
    // 通信対戦の局面はサーバーが持っているのでローカルには保存も復元もしない
    loadPreferencesOnlyFromLocalStorage();
    initializeBoard();
    updateOnlineUiState();

    if (urlRoom && urlRoom.trim() !== '') {
        onlineJoinRoom(urlRoom);
    }
} else if (gameMode === TSUME_MODE) {
    // 詰将棋は当日の問題がHTMLに焼き込まれている。対局状態は保存しない
    loadPreferencesOnlyFromLocalStorage();
    startTsumeMode();
    updateOnlineUiState();
} else {
    // ai または pvp モード
    // localStorageから復元を試み、失敗したら新規ゲームを開始
    if (!loadFromLocalStorage()) {
        initializeBoard();
    }
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
