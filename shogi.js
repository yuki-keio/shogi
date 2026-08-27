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

// 共有リンク（/?k=…）で開いたときは、モードタブと難易度パネルを隠して
// 「共有された棋譜」の見出しに差し替える（設計書 §6）。
// ここで body にクラスを付けるのは、defer のスクリプトが最初の描画より前に走るため。
// bootGame まで待つと、タブが一瞬見えてから消えることがある。
(function markSharedKifuBodyClass() {
    try {
        const params = new URLSearchParams(window.location.search);
        // 棋譜を受けるのは AI対戦 と 将棋盤 だけ（通信対戦・詰将棋は棋譜バーを使わない）。
        // start=1 は「この局面から指す」で将棋盤ページへ移ってきた場合。閲覧画面にはしない
        const kifuPage = gameMode === 'ai' || gameMode === 'pvp';
        if (kifuPage && params.has('k') && params.get('start') !== '1' && document.body) {
            document.body.classList.add('kifu-shared');
        }
    } catch (error) {
        /* URL が読めないだけなら、ふつうの画面のままでよい */
    }
})();

// --- 計測（GA4） ------------------------------------------------------------
// 受け皿（dataLayer と gtag）だけをここで用意する。gtag.js 本体の読み込みは
// window.load のまま（ファーストビューを邪魔しないための措置）で、ここでやるのは
// 「配列を1つ作って関数を1つ定義する」だけなので通信も描画も発生しない。
// 受け皿が無いと、タグが読み込まれるまでの間に起きたことがどこにも溜まらず消える。
const GA_MEASUREMENT_ID = 'G-KH9HBZ92L4';

/** 共有URLのどれで来たか。パラメータの有無だけで判定するのでURLは汚さない */
function detectEntrySource() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.has('room')) return 'invite';
        if (params.has('k')) return 'kifu';
        if (params.has('date')) return 'tsume';
    } catch (error) {
        /* URL が読めないだけなら none 扱いでよい */
    }
    return 'none';
}

window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function () { dataLayer.push(arguments); };
gtag('js', new Date());
gtag('config', GA_MEASUREMENT_ID);
gtag('set', 'user_properties', {
    // インストールした人が実際に遊んでいるかを、ブラウザ利用者と比べるための印
    pwa: (window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true) ? 'standalone' : 'browser',
    entry: detectEntrySource(),
});

/**
 * 記録の入口はここ1つ。値は必ず決まった選択肢に丸めてから渡すこと
 * （部屋コードや生の秒数を入れるとGA4が「その他」にまとめてしまい、レポートが読めなくなる）。
 * undefined のパラメータは送らない。計測が転んでも対局は絶対に止めない。
 */
function track(name, params) {
    try {
        const clean = {};
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) clean[key] = value;
        }
        gtag('event', name, clean);
    } catch (error) {
        /* 計測の失敗は握りつぶす */
    }
}

// 不具合の記録は1ページ3件まで。広告など外部スクリプト由来の例外で溢れさせないため
const APP_ERROR_TRACK_MAX = 3;
let appErrorTracked = 0;

function trackAppError(kind) {
    if (appErrorTracked >= APP_ERROR_TRACK_MAX) return;
    appErrorTracked++;
    try {
        track('app_error', {
            error_kind: kind,
            mode: gameMode,
            difficulty: gameMode === 'ai' ? aiDifficulty : undefined,
        });
    } catch (error) {
        /* 初期化前に呼ばれた場合など。記録できないだけで実害はない */
    }
}

// フィードバック送信時に添付する直近エラーの記録。記録するだけで挙動は一切変えない。
// 「コマが反応しない」系の報告で、裏で起きたJSエラーを特定するための仕組み。
const RECENT_ERRORS_MAX = 5;
const recentErrors = [];

function recordDiagnosticError(source, message) {
    recentErrors.push({
        at: Date.now(),
        source,
        message: String(message || 'unknown error').slice(0, 300),
    });
    if (recentErrors.length > RECENT_ERRORS_MAX) recentErrors.shift();

    // エンジンが落ちたことだけは計測にも上げる。
    // 「駒が動かなくなる」報告の実在と発生条件を測るための手がかりになる
    if (source === 'ai-worker' || source === 'yaneuraou-worker') {
        trackAppError('engine_fail');
    }
}

/**
 * 計測に上げてよい例外か。広告（AdSense）は毎回のように例外を投げるので、
 * そのまま数えると不具合の件数が広告のノイズで埋まり、肝心の
 * 「駒が動かなくなる」不具合が見えなくなる。自分のコード由来だけを数える。
 * 別ドメインのスクリプトは message も "Script error." になり中身が分からないので、
 * どのみち記録する値がない。
 */
function isOwnScriptError(filename) {
    if (!filename) return false;
    try {
        return new URL(filename, window.location.href).origin === window.location.origin;
    } catch (error) {
        return false;
    }
}

window.addEventListener('error', (e) => {
    // リソース読み込みエラーはbubbleしないので、ここに来るのはスクリプト実行エラーのみ
    const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno || 0})` : '';
    recordDiagnosticError('page', `${e.message || 'error'}${where}`);
    if (isOwnScriptError(e.filename)) trackAppError('js_error');
});

window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    recordDiagnosticError('promise', reason instanceof Error ? reason.message : String(reason));
});

// AI Workerの初期化
let aiWorker = null;
let yaneuraouWorker = null;
let yaneuraouReady = false;

// AI思考リクエストの管理（古い思考結果を無視するため）
let aiRequestId = 0;

// AIの応手は「自分が指してから最低 MIN_AI_THINK_MS 経ってから」盤に載せる。
// 探索を先に走らせて足りない分だけ待つ形なので、待ち時間は
// 「固定待ち＋探索時間」ではなく max(MIN_AI_THINK_MS, 探索時間) になる。
// 定跡手や軽い難易度で応手が一瞬になり、駒音が自分の手と重なるのを防ぐのが狙い。
const MIN_AI_THINK_MS = 600;
let aiThinkStartedAt = 0;
let aiMoveDelayTimerId = null;

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

// AIを使うのはAI対戦ページだけ。将棋盤・オンライン対戦のページでWorkerを起動すると、
// やねうら王のWASM（約1.4MB）を無駄にダウンロード・初期化してしまう。
if (window.Worker && gameMode === 'ai') {
    aiWorker = new Worker('/ai-worker.js');
    // 記録のみ。通常AIのworker例外は現状「無音の停止」になるため、
    // せめてフィードバックに乗るようにしておく（復旧処理は別課題）。
    aiWorker.onerror = function (error) {
        recordDiagnosticError('ai-worker', error && error.message ? error.message : 'worker error');
    };
    aiWorker.onmessage = function (e) {
        const { type, data } = e.data;
        if (type === 'bestMove') {
            // リクエストIDをチェックして古い思考結果を無視
            if (data.requestId !== undefined && data.requestId !== aiRequestId) {
                console.log('Ignoring outdated AI response (requestId mismatch)');
                return;
            }

            const { move, currentJosekiPattern: newPattern, josekiMoveIndex: newIndex } = data;

            // 定跡の進行も応手と同じタイミングで反映する。
            // 先に代入すると、待っている間に「待った」されたとき定跡だけ進んでしまう。
            finishAiTurnAfterMinThinkTime(data.requestId, () => {
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
            });
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
                // リクエストIDをチェックして古い思考結果を無視
                if (data.requestId !== undefined && data.requestId !== aiRequestId) {
                    console.log('Ignoring outdated YaneuraOu response (requestId mismatch)');
                    return;
                }

                const { move } = data;
                finishAiTurnAfterMinThinkTime(data.requestId, () => {
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
                });
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

                if (requestId !== aiRequestId) {
                    console.log('Ignoring outdated YaneuraOu error (requestId mismatch)');
                    return;
                }

                // 通常AIに引き継ぐ。インジケータは出したままにして、
                // 最低思考時間の起点（aiThinkStartedAt）も引き継ぐので待ちは自分の手からの通算になる。
                requestStandardAiMove(requestId, aiDifficulty);
            }
        };
        yaneuraouWorker.onerror = function (error) {
            recordDiagnosticError('yaneuraou-worker', error && error.message ? error.message : 'worker error');
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
const gameResultSub = document.getElementById('game-result-sub');
const gameResultStrip = document.getElementById('game-result-strip');
const gameResultRank = document.getElementById('game-result-rank');
const gameResultRankBadge = document.getElementById('game-result-rank-badge');
const gameResultRankName = document.getElementById('game-result-rank-name');
const gameResultRankNote = document.getElementById('game-result-rank-note');
const gameResultRankRating = document.getElementById('game-result-rank-rating');
const gameResultRankDelta = document.getElementById('game-result-rank-delta');
const gameResultRankProgress = document.getElementById('game-result-rank-progress');
const gameResultRankFill = document.getElementById('game-result-rank-fill');
const gameResultRankTrack = gameResultRank ? gameResultRank.querySelector('.result-rank-track') : null;
const gameResultRankNext = document.getElementById('game-result-rank-next');
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

// オンライン対戦関連の要素（友達対戦カード）
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
const timeDangerOverlay = document.getElementById('time-danger-overlay');

// 設定関連の要素
const pieceDisplayModeRadios = document.querySelectorAll('input[name="piece-display-mode"]');
const moveHintCheckbox = document.getElementById('move-hint-checkbox');
const botFallbackCheckbox = document.getElementById('bot-fallback-checkbox');
const soundMoveCheckbox = document.getElementById('sound-move-checkbox');
const soundJoinCheckbox = document.getElementById('sound-join-checkbox');
const moveHintElement = document.getElementById('move-hint');
const boardStageElement = document.getElementById('board-stage');
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

// 対局者バー（オンライン対戦のみ）。盤の上下に「相手：〜」と自分の名前を出す。
// SENTE / GOTE をキーにするので、この2定数より後ろで宣言する
const playerBarElements = {
    [SENTE]: document.getElementById('player-bar-sente'),
    [GOTE]: document.getElementById('player-bar-gote'),
};
const playerBarNameElements = {
    [SENTE]: document.getElementById('player-name-sente'),
    [GOTE]: document.getElementById('player-name-gote'),
};
const playerBarAlertElements = {
    [SENTE]: document.getElementById('player-alert-sente'),
    [GOTE]: document.getElementById('player-alert-gote'),
};
const playerBarRankElements = {
    [SENTE]: document.getElementById('player-rank-sente'),
    [GOTE]: document.getElementById('player-rank-gote'),
};

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

// --- オンライン対戦 (online) ---
// Backend: Cloudflare Workers + Durable Objects (same origin, /api/*).
// Sync: WebSocket push (with HTTP polling as an automatic fallback).
const ONLINE_MODE = 'online';
const TSUME_MODE = 'tsume';

// --- 詰将棋との接点 ---
// 詰将棋のロジックは別ファイル（shogi-tsume.js）で、/tsume/ でしか読み込まない。
// 読み込まれていないページでも壊れないよう、このファイルからの呼び出しは必ずここを通す。
// 中身は shogi-tsume.js が末尾で Object.assign して埋める。
const tsumeBridge = {
    /** 詰将棋モードの起動 */
    start: null,
    /** 攻方が指したあとの判定と玉方の応手 */
    afterMove: null,
    /** 「待った」などで局面を戻したあとの状態合わせ */
    syncFromHistory: null,
    /** 「待った」「進む」で飛ぶ先の履歴インデックス */
    historyTargetIndex: null,
    /** 玉方の応手待ちなど、盤の操作を受け付けない状態か */
    isBusy: () => false,
};

// --- だれかと対戦（マッチング）との接点 ---
// ロジックは online-match.js（/online/ でしか読み込まない）。tsumeBridge と同じ流儀で、
// 読み込まれていないページでも壊れないよう、呼び出しは必ずオプショナル（?.）にする。
const matchmakingBridge = {
    /** ロビーUIの初期化（/online/ の bootGame から呼ぶ） */
    start: null,
    /** オンライン対戦の終局時。マッチング対戦なら「もう一度」への差し替えなどを行う */
    onGameOver: null,
    /** 終局ダイアログの「次のゲームへ」を横取りして再キューする（trueなら処理済み） */
    handleNewGame: null,
    /** ローカル対局（COM戦・チュートリアル）や詰めチャレンジの指し手を横取りする（trueなら処理済み） */
    interceptMove: null,
    /** ローカル対局の投了を横取りする（trueなら処理済み） */
    interceptResign: null,
    /** 相手を探している最中か（待機中はロビー扱いにしない） */
    isSeeking: () => false,
    /** 待機中の詰めチャレンジが盤を使っているか */
    claimsBoard: null,
    /** 詰めチャレンジ中に盤入力を受け付けるか */
    boardInputAllowed: null,
    /** 計測用。いまの通信対戦の種類 'random' | 'invite' | 'bot' */
    matchKind: null,
    /** 計測用。相手が見つかるまでの待ち時間の段階（だれかと対戦のみ） */
    waitBucket: null,
    /** 計測用。部屋を離れたことを知らせる（次の対局に前の対局の素性を持ち越さないため） */
    onLeaveRoom: null,
};

const ONLINE_API_BASE = '/api';
// 遅延ロードするQRライブラリ（build.shがハッシュ付きファイル名へ書き換える）
const QR_LIB_SRC = '/qrcode.js';
const FRIEND_SIDE_KEY = 'shogi_friend_side';
const FRIEND_TC_KEY = 'shogi_friend_tc';
// 表示名（ロビーの #player-name で入力・online-match.js が保存する）。
// マッチング対戦でも友達対戦でも同じ名前を使う。サーバー側でNG語は伏せ字になる
const PLAYER_NAME_KEY = 'shogi_player_name';
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
    // 対局成立を数えたか（同じ部屋の state は何度も届くので二重計上を防ぐ）
    matchFoundTracked: false,
    submitting: false,
    lastUsiLen: 0,
    // サーバーが確定した指し手（USI）。通信対戦は手元の usiMoveHistory が育たないので、
    // 対局後の共有URLはこれを使う。先読み表示（optimistic）では触らない
    usiMoves: [],
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

/** 持ち時間を選択肢と同じ文字列（'none' / 'total:300' など）に直す */
function onlineTimeControlValue(match) {
    if (!match || !match.tc_type || match.tc_type === 'none') return 'none';
    return `${match.tc_type}:${match.tc_seconds}`;
}

// 部屋がある間はサーバー保存値が正（リロード復元・多タブ同期）
function syncFriendControlsFromMatch() {
    const match = onlineState.match;
    if (!match || isMatchStarted(match) || onlineState.settingsBusy) return;
    if (match.side_pref === 'sente' || match.side_pref === 'gote' || match.side_pref === 'random') {
        setFriendSidePref(match.side_pref);
    }
    const tcValue = onlineTimeControlValue(match);
    if (isValidFriendTcValue(tcValue)) {
        setFriendTcValue(tcValue);
    }
}

// ---- 友達対戦: 対局時計の表示（サーバー権威、ここは表示のみ） ----

function formatClockMs(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 残り時間の警告しきい値（ミリ秒）。allowanceMs は 1手ごとの秒数、または総持ち時間。
// 黄: 半分か60秒の短い方。切れ負け10分で「残り5分からずっと黄色」になるのを防ぐ。
// 赤: 6秒か30%の短い方。1手10秒のような短い設定で赤が長引かないようにする。
function clockWarnThresholdMs(allowanceMs) {
    return Math.min(allowanceMs / 2, 60000);
}

function clockDangerThresholdMs(allowanceMs) {
    return Math.min(6000, allowanceMs * 0.3);
}

// 危険域の画面エフェクト。自分の手番で自分の持ち時間が尽きかけているときだけ点ける
function setTimeDangerEffect(on, remainMs) {
    if (!timeDangerOverlay) return;
    timeDangerOverlay.classList.toggle('is-on', Boolean(on));
    // 残り3秒からは明滅を速めて切迫感を上げる
    timeDangerOverlay.style.setProperty(
        '--time-danger-pulse',
        on && remainMs <= 3000 ? '0.6s' : '1s'
    );
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
    if (!friendClockSente || !friendClockGote) return;
    const match = onlineState.match;
    const timed = isOnlineMode() && match && match.tc_type && match.tc_type !== 'none'
        && isMatchStarted(match);
    friendClockSente.hidden = !timed;
    friendClockGote.hidden = !timed;
    if (!timed) {
        setTimeDangerEffect(false, 0);
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

    const warnMs = clockWarnThresholdMs(allowanceMs);
    const dangerMs = clockDangerThresholdMs(allowanceMs);
    let myDangerRemainMs = null;

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
        // 警告は手番側だけ。待っている側は減らないので出す意味がない
        const danger = isTurn && ms <= dangerMs;
        el.classList.toggle('danger', danger);
        el.classList.toggle('warn', isTurn && !danger && ms <= warnMs);
        if (danger && side === onlineState.side) myDangerRemainMs = ms;
    };
    renderSide(friendClockSente, SENTE);
    renderSide(friendClockGote, GOTE);

    // 相手の残りが少なくても画面は光らせない（自分が急かされていると誤解させないため）
    setTimeDangerEffect(myDangerRemainMs !== null, myDangerRemainMs ?? 0);

    // 0:00表示のままサーバーの終局通知（WS/ポーリング）を待つ。自滅はしない。
    if (!match.game_over) {
        startClockTicker();
    } else {
        stopClockTicker();
    }
}

// 保存済みの表示名（半角英数字と _ - . のみ・最大10文字）。未入力は null
function getStoredPlayerName() {
    try {
        const raw = localStorage.getItem(PLAYER_NAME_KEY) || '';
        return raw.replace(/[^A-Za-z0-9_\-.]/g, '').slice(0, 10) || null;
    } catch (_) {
        return null;
    }
}

// 相手側の表示名。無ければ null（従来の「相手」表記のまま）。
// 表示直前にもクライアント側フィルタを通す（name-filter.js を読み込むページのみ）
function getMatchDisplayName(match, side) {
    if (!match || !side) return null;
    const raw = side === SENTE ? match.sente_name : match.gote_name;
    if (typeof raw !== 'string') return null;
    let name = raw.trim().slice(0, 10);
    if (typeof nameFilter !== 'undefined' && nameFilter?.clean) {
        try { name = String(nameFilter.clean(name)); } catch (_) { /* ignore */ }
    }
    return name || null;
}

function getOpponentDisplayName(match, mySide) {
    if (!mySide) return null;
    return getMatchDisplayName(match, mySide === SENTE ? GOTE : SENTE);
}

// 名前を入れていない相手の呼び方。COM には使わない
const ANON_OPPONENT_LABEL = '匿名プレイヤー';

// 敬称を付けない予約名。ローカル対局（COMフォールバック・チュートリアル）の相手名がこれにあたる
function isReservedOpponentName(name) {
    return name === 'COM';
}

/** 対局者バーの相手側の表記。「相手：yuki」「相手：COM」「相手：匿名プレイヤー」 */
function getOpponentBarLabel(match, mySide) {
    return `相手：${getOpponentDisplayName(match, mySide) || ANON_OPPONENT_LABEL}`;
}

/** 対局者バーの自分側の表記。名前を入れていれば名前、未入力なら「あなた」。
 *  localStorage ではなく match の記録を見るのは、**相手に見えているのと同じ名前**を出すため。
 *  部屋を作ったあとで名前を入れた場合、サーバーは古い値のままなので localStorage とズレる */
function getMyBarLabel(match, mySide) {
    return getMatchDisplayName(match, mySide) || 'あなた';
}

/** 文中で相手を指すときの呼び方。「yuki さん」「COM」、名前未入力なら「相手」。
 *  未入力のとき ANON_OPPONENT_LABEL を使わないのは、「匿名プレイヤーの勝利！」だと硬いため。
 *  名前として置く対局者バー（getOpponentBarLabel）とは使い分ける */
function getOpponentSubject(match, mySide) {
    const name = getOpponentDisplayName(match, mySide);
    if (!name) return '相手';
    return isReservedOpponentName(name) ? name : `${name} さん`;
}

// --- 段級位バッジ（だれかと対戦） ---------------------------------------
// サーバー（src/worker/rating.ts の RANKS）と同じ並び。**添字が唯一の受け渡し**なので、
// 片方だけ増やしたり並べ替えたりしないこと。サーバーは段級位の添字だけを配り、
// ラベルと色はここで付ける（毎回の通信に文字列を載せないため）。
const ONLINE_RANK_LABELS = [
    '9級', '8級', '7級', '6級', '5級', '4級', '3級', '2級', '1級',
    '初段', '二段', '三段', '四段', '五段', '六段'
];
// 3ランクごとに1つ上がる階級。文字を読まなくても強さが伝わるようにするための色分け
function onlineRankTier(rank) {
    return Math.min(4, Math.floor(rank / 3));
}

function isValidOnlineRank(rank) {
    return Number.isInteger(rank) && rank >= 0 && rank < ONLINE_RANK_LABELS.length;
}

function onlineRankLabel(rank) {
    return isValidOnlineRank(rank) ? ONLINE_RANK_LABELS[rank] : null;
}

/**
 * 段級位バッジを組み立てる。style は 'pill'（対局中・小さくても読める）か
 * 'koma'（ロビー・結果画面。将棋の駒の五角形）。
 * 🔴 対局者バーに入れるときも高さを増やさないこと（盤がずれると誤タップの元になる）。
 */
function createRankBadge(rank, style) {
    const label = onlineRankLabel(rank);
    if (label === null) return null;
    const el = document.createElement('span');
    el.className = `rank-badge rank-badge--${style} rank-tier-${onlineRankTier(rank)}`;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    if (style === 'koma') {
        // 駒は2文字を縦に置く（本物の駒と同じ書き方）。9級〜六段は必ず2文字
        const face = document.createElement('span');
        face.className = 'rank-badge-face';
        for (const ch of label) {
            const line = document.createElement('i');
            line.textContent = ch;
            face.appendChild(line);
        }
        el.appendChild(face);
    } else {
        el.textContent = label;
    }
    return el;
}

/** 要素の中身をバッジ1つに差し替える。段級位が無いときは空にする */
function renderRankBadgeInto(host, rank, style) {
    if (!host) return;
    const badge = createRankBadge(rank, style);
    host.textContent = '';
    if (badge) host.appendChild(badge);
    host.hidden = badge === null;
}

// --- 詰将棋局面のセットアップ（/tsume/ と /online/ の待機中詰めチャレンジで共用） ---
// もとは shogi-tsume.js にあったが、待機中の詰めチャレンジでも使うためここへ移した。
// 詰将棋ページ固有の後始末（tsumeSession の更新）は shogi-tsume.js 側のラッパーが行う。

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

/**
 * 現在の局面をSFEN文字列にする。フィードバックの診断情報に添えて、
 * 報告時の盤面をそのまま再現できるようにするために使う（parseTsumeSfen の逆）。
 */
function boardToSfen(
    currentBoard = board,
    captured = capturedPieces,
    player = currentPlayer,
    moveNumber = moveCount + 1
) {
    const LETTER_BY_TYPE = {
        [PAWN]: 'P', [LANCE]: 'L', [KNIGHT]: 'N', [SILVER]: 'S',
        [GOLD]: 'G', [BISHOP]: 'B', [ROOK]: 'R', [KING]: 'K'
    };
    const letterOf = (type) => {
        const promoted = type.startsWith('+');
        const letter = LETTER_BY_TYPE[promoted ? type.slice(1) : type];
        if (!letter) return null;
        return promoted ? `+${letter}` : letter;
    };

    const rows = [];
    for (let y = 0; y < 9; y++) {
        let row = '';
        let empty = 0;
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y]?.[x];
            const letter = piece ? letterOf(piece.type) : null;
            if (!letter) {
                empty++;
                continue;
            }
            if (empty > 0) {
                row += empty;
                empty = 0;
            }
            row += piece.owner === GOTE ? letter.toLowerCase() : letter;
        }
        if (empty > 0) row += empty;
        rows.push(row);
    }

    // 持ち駒は先手→後手、それぞれ飛角金銀桂香歩の順（SFENの慣例）
    const HAND_ORDER = [ROOK, BISHOP, GOLD, SILVER, KNIGHT, LANCE, PAWN];
    let hand = '';
    for (const owner of [SENTE, GOTE]) {
        for (const type of HAND_ORDER) {
            const count = captured?.[owner]?.[type] || 0;
            if (count <= 0) continue;
            if (count > 1) hand += count;
            hand += owner === GOTE ? LETTER_BY_TYPE[type].toLowerCase() : LETTER_BY_TYPE[type];
        }
    }

    return `${rows.join('/')} ${player === GOTE ? 'w' : 'b'} ${hand || '-'} ${moveNumber}`;
}

/** 詰将棋の局面を盤に載せる。initializeBoard から初期配置だけ差し替えた形。 */
function setupTsumePosition(problem) {
    aiRequestId++;
    clearAiMoveDelayTimer();
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

// フィードバックの連投が同じ端末からのものかを見分けるためだけの匿名ID。
// online の uid は再接続の資格情報を兼ねているので、絶対に流用しない。
const STORAGE_KEY_FEEDBACK_ID = 'shogi_feedback_id';

function getFeedbackReporterId() {
    let id = null;
    try { id = localStorage.getItem(STORAGE_KEY_FEEDBACK_ID); } catch (_) { /* ignore */ }
    if (!id || !/^[0-9a-f]{8}$/.test(id)) {
        if (crypto && crypto.getRandomValues) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(4)))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('');
        } else {
            id = (Math.random().toString(16).slice(2) + '00000000').slice(0, 8);
        }
        try { localStorage.setItem(STORAGE_KEY_FEEDBACK_ID, id); } catch (_) { /* ignore */ }
    }
    return id;
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
        // ポーリングへ落ちた＝WebSocketが続かなかった対局。ここだけ記録する
        // （切れるたびに送ると、再接続を繰り返す1対局で何件も立ってしまう）
        if (onlineState.wsFailures === ONLINE_WS_FAILS_BEFORE_POLLING) {
            trackAppError('ws_error');
        }
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

// --- 音（駒音・対局開始音） --------------------------------------------------
// 音を鳴らす入口はこの節の playPieceSound / playJoinSound の2つだけ。
// 駒音と対局開始音を別々に切れるようにしてある（毎手鳴る駒音だけ消して、
// 対局が始まった合図は残したい人がいるため）。設定の見た目は詳細設定モーダル。

const STORAGE_KEY_SOUND_MOVE = 'shogi_sound_move'; // '1' / '0'。未保存なら ON
const STORAGE_KEY_SOUND_JOIN = 'shogi_sound_join'; // '1' / '0'。未保存なら ON

/** 未保存なら ON。localStorage が読めない環境でも音は鳴らす */
function readSoundPreference(key) {
    try {
        return localStorage.getItem(key) !== '0';
    } catch (_) {
        return true;
    }
}

function writeSoundPreference(key, enabled) {
    try {
        localStorage.setItem(key, enabled ? '1' : '0');
    } catch (_) { /* 保存できなくても、今開いているページには効かせる */ }
}

let moveSoundEnabled = readSoundPreference(STORAGE_KEY_SOUND_MOVE);
let joinSoundEnabled = readSoundPreference(STORAGE_KEY_SOUND_JOIN);

/** 駒を置く音 */
function playPieceSound() {
    if (!moveSoundEnabled || typeof piecePlacementSound === 'undefined') return;
    piecePlacementSound.currentTime = 0;
    piecePlacementSound.play().catch(() => { });
}

/** 通信対戦で対局が始まったときの音 */
function playJoinSound() {
    if (!joinSoundEnabled || typeof playerJoinSound === 'undefined') return;
    playerJoinSound.currentTime = 0;
    playerJoinSound.play().catch(() => { });
}

function setMoveSoundEnabled(enabled, method) {
    moveSoundEnabled = enabled;
    writeSoundPreference(STORAGE_KEY_SOUND_MOVE, enabled);
    if (soundMoveCheckbox) soundMoveCheckbox.checked = enabled;
    track('sound_toggle', { sound: 'move', result: enabled ? 'on' : 'off', method });
}

function setJoinSoundEnabled(enabled, method) {
    joinSoundEnabled = enabled;
    writeSoundPreference(STORAGE_KEY_SOUND_JOIN, enabled);
    if (soundJoinCheckbox) soundJoinCheckbox.checked = enabled;
    track('sound_toggle', { sound: 'join', result: enabled ? 'on' : 'off', method });
}

if (soundMoveCheckbox) {
    soundMoveCheckbox.checked = moveSoundEnabled;
    soundMoveCheckbox.addEventListener('change', () => {
        setMoveSoundEnabled(soundMoveCheckbox.checked, 'settings');
    });
}

if (soundJoinCheckbox) {
    soundJoinCheckbox.checked = joinSoundEnabled;
    soundJoinCheckbox.addEventListener('change', () => {
        setJoinSoundEnabled(soundJoinCheckbox.checked, 'settings');
    });
}

function playMoveSoundIfNeeded(prevUsiLen, nextUsiLen) {
    if (nextUsiLen > prevUsiLen) playPieceSound();
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

/**
 * 対局が成立した瞬間（両者が入室した最初の1回）を数える。
 * 友達対戦・だれかと対戦・COM戦・チュートリアルはすべて applyOnlineMatch を通るので、
 * 入口をここ1つにまとめておけば数え漏れも二重計上も起きない。
 * 通信対戦の「始めた数」もここで数える（1手目を待つと、指さずに離れた対局が分母から落ちる）
 */
function trackOnlineMatchFound(match) {
    if (!isMatchStarted(match)) return;
    if (onlineState.matchFoundTracked) return;
    onlineState.matchFoundTracked = true;

    const kind = matchmakingBridge.matchKind?.() || 'invite';
    const opponent = kind === 'bot' ? 'com' : 'human';
    const timeControl = onlineTimeControlValue(match);

    gameStartTracked = true;
    gameStartedAt = Date.now();
    track('match_found', {
        match_type: kind,
        opponent,
        time_control: timeControl,
        // 待った秒数の段階。「だれかと対戦」だけが持つ（招待対局には待ち行列が無い）
        wait_bucket: matchmakingBridge.waitBucket?.() || undefined,
    });
    track('game_start', {
        mode: gameMode,
        start_from: gameStartedFrom,
        match_type: kind,
        opponent,
        time_control: timeControl,
        side: onlineState.side || undefined,
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
    // 🔴 自分の手番が決まった後に呼ぶこと。先に置くと side が入らないまま記録される
    trackOnlineMatchFound(match);
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
        const nextUsi = Array.isArray(state.usiMoveHistory) ? state.usiMoveHistory : [];
        const nextUsiLen = nextUsi.length;
        // 🔴 描画より前に入れること。棋譜バーはここを読むので、後ろに置くと1手ぶん遅れて出る
        onlineState.usiMoves = nextUsi;

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
        // 自分の手を先読み表示したときは updateInfo() を通らないので、棋譜バーはここで更新する
        renderKifuBar();
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
        playJoinSound(); // 対局開始の合図
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

    // Google Analytics: オンライン対戦の終局イベントを送信
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

    if (winner === SENTE) {
        showGameOverDialog('先手', reason);
    } else if (winner === GOTE) {
        showGameOverDialog('後手', reason);
    } else {
        showGameOverDialog('引き分け', reason);
    }

    // マッチング対戦なら「もう一度対戦する」への差し替えを行う。
    // showGameOverDialog がラベルを毎回リセットするので、必ずその後に呼ぶ
    matchmakingBridge.onGameOver?.(match);
}

function updateOnlineUiState() {
    // オンライン対戦のUI一式（#online-settings など）は /online/ のページにしか無い。
    // ここで丸ごと return すると、新規対局ボタンや手番ラジオの制御まで止まってしまうので、
    // オンライン対戦だけの要素は個別に null チェックする（下の friendActionsElement 等と同じ流儀）
    if (!resignButton) return;

    const matchStarted = isMatchStarted(onlineState.match);
    const matchActive = matchStarted && !onlineState.match?.game_over;
    // だれかと対戦の待機中はロビー扱いにしない（盤を見せ、設定パネルは隠す）
    const seeking = matchmakingBridge.isSeeking?.() === true;

    // Lobby – the board area (with move counter / controls) stays hidden via CSS
    // until both players have joined.
    document.body.classList.toggle('online-lobby', isOnlineMode() && !matchStarted && !seeking);

    // Board cursor – show not-allowed cursor before the match starts in online mode.
    // 待機中の詰めチャレンジが盤を使っている間は通常カーソルに戻す
    boardElement.classList.toggle(
        'online-waiting',
        isOnlineMode() && !matchStarted && !matchmakingBridge.claimsBoard?.(),
    );

    // Settings visibility – hide the entire panel once both players have joined.
    // It stays hidden even after game_over; it reappears when the user leaves the room.
    if (onlineSettingsElement) {
        onlineSettingsElement.style.display =
            (isOnlineMode() && !matchStarted && !seeking) ? 'block' : 'none';
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
    // このステータス欄（#online-status）は上で隠している #online-settings の中にあるので、
    // 対局が始まるとパネルごと消える。つまり文言が要るのは対局前の3状態だけ。
    // 対局中の手番と切断は対局者バー（updatePlayerBars）が受け持つ
    if (isOnlineMode()) {
        const match = onlineState.match;
        if (onlineState.joining) {
            setOnlineStatus('接続中…');
        } else if (!onlineState.roomCode) {
            setOnlineStatus('招待URLをコピーするか、QRコードで友達を招待できます。');
        } else if (match && !isMatchStarted(match)) {
            setOnlineStatus('招待URLを相手に共有してください。相手が参加すると自動で対局が始まります。');
        }
    }

    updatePlayerBars();
    updateClockUi();
}

/** 切断中の残り秒数。切断していない・期限が壊れているときは null */
function disconnectRemainingSeconds(dcInfo) {
    if (!dcInfo || !dcInfo.side || !dcInfo.deadline) return null;
    const deadlineMs = Date.parse(dcInfo.deadline);
    if (!Number.isFinite(deadlineMs)) return null;
    return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
}

// 対局者バー。オンライン対戦（友達対戦・だれかと対戦）で対局が始まってからだけ出す。
// AI対戦と詰将棋では出さないので、盤の高さは今までどおり
function updatePlayerBars() {
    const match = onlineState.match;
    const show = isOnlineMode() && isMatchStarted(match) && Boolean(onlineState.side);
    const dcInfo = onlineState.disconnectInfo || { side: null, deadline: null };
    const dcRemainSec = match && match.game_over ? null : disconnectRemainingSeconds(dcInfo);

    [SENTE, GOTE].forEach((side) => {
        const bar = playerBarElements[side];
        if (!bar) return;
        bar.hidden = !show;
        if (!show) return;

        const isMine = side === onlineState.side;
        const nameElement = playerBarNameElements[side];
        if (nameElement) {
            nameElement.textContent = isMine
                ? getMyBarLabel(match, onlineState.side)
                : getOpponentBarLabel(match, onlineState.side);
        }

        // 段級位は入室時にサーバーが固めた値。友達対戦では null なので何も出ない
        renderRankBadgeInto(
            playerBarRankElements[side],
            side === SENTE ? match.sente_rank : match.gote_rank,
            'pill',
        );

        const alertElement = playerBarAlertElements[side];
        if (alertElement) {
            const disconnected = dcRemainSec !== null && dcInfo.side === side;
            alertElement.hidden = !disconnected;
            // 隠すときに文言も消す。次の切断でまた読み上げてもらうため（同じ文言のままだと変化にならない）
            renderDisconnectAlert(alertElement, isMine, disconnected ? dcRemainSec : null);
        }
    });

    updatePlayerBarTurn();
}

// 切断中の帯。名前の行に重ねるので、誰の名前かはバーの位置で分かる＝文言に名前は入れない
// （名前を入れると狭い端末で折り返し、盤がずれてしまう）。
// 読み上げは文言だけにして、毎秒変わる秒数は aria-hidden 側に置く。
// そうしないと最大60秒間、1秒ごとに同じ文が読み上げられ続ける
function renderDisconnectAlert(alertElement, isMine, remainSec) {
    const textElement = alertElement.querySelector('.player-bar-alert-text');
    const countElement = alertElement.querySelector('.player-bar-alert-count');
    const sentence = remainSec === null ? '' : `${isMine ? 'あなた' : '相手'}の接続が切れています`;
    if (textElement && textElement.textContent !== sentence) {
        textElement.textContent = sentence;
    }
    if (countElement) {
        countElement.textContent = remainSec === null ? '' : ` ・ 残り${remainSec}秒`;
    }
}

// 手番側のバーを淡く光らせる。明暗の主役は持ち駒レーンの先手/後手の札のままなので、
// こちらは背景を少し変えるだけに留める
function updatePlayerBarTurn() {
    const match = onlineState.match;
    const active = isOnlineMode() && isMatchStarted(match) && !match.game_over;
    [SENTE, GOTE].forEach((side) => {
        playerBarElements[side]?.classList.toggle('is-active', active && currentPlayer === side);
    });
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
            body: { uid, displayName: getStoredPlayerName(), side: getFriendSidePref(), tc: getFriendTcPref() },
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
            body: { uid, displayName: getStoredPlayerName() },
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

    playPieceSound();

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
    // ローカル対局（COM戦・チュートリアル）や詰めチャレンジ中は online-match.js が引き取る
    if (matchmakingBridge.interceptMove?.(move)) return;
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
    // ローカル対局（COM戦・チュートリアル）の投了は online-match.js が引き取る
    if (matchmakingBridge.interceptResign?.()) return;
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
        onlineState.usiMoves = [];
        onlineState.matchFoundTracked = false; // 次の対局成立をまた数えられるようにする
        matchmakingBridge.onLeaveRoom?.();
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
        // 危険域のまま退室したときに赤いエフェクトが残らないよう、時計表示も片付ける
        updateClockUi();
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
// 直近に選んだ駒と、そのとき盤に出した移動先。フィードバックの調査にだけ使う
// （「行けるのに出てこない」系の報告で、実際に何を表示していたかを残すため）。
let lastSelection = null;

// --- 動かせない理由の案内（詳細設定でOFFにできる。初期値ON） ---
// 「その手を指すと自玉が取られる」ときだけ出す。二歩・行き所のない駒・打ち歩詰め・
// 自駒で塞がっている、といった理由では何も出さない（盤を静かに保つため）。
let moveHintEnabled = true;
// { text, attackers: [{x, y, type}], kingPos: {x, y}|null, refuse: {x, y}|null }
let moveHintState = null;
let moveHintHideTimer = null;
// 文章を出しているか。盤に重ねているので、印（赤い枠・利き筋）より先に文章だけ引っ込める
let moveHintTextVisible = false;
// 盤に重ねる以上、文章を出しっぱなしにすると駒が隠れる。数秒で必ず引っ込める
// （詰将棋の「不正解」トーストと同じ長さ。shogi-tsume.js の TSUME_TOAST_MS.bad）
const MOVE_HINT_AUTO_HIDE_MS = 4000;
// 文章を画面の端からこれだけは離す。盤を上へスクロールしたとき、ここで止まって追従する
const MOVE_HINT_SCREEN_MARGIN = 12;
// 盤の内側の余白
const MOVE_HINT_BOARD_MARGIN = 8;
let moveHintFollowActive = false;
let moveHintFollowFrame = 0;
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
// 棋譜を眺めているだけの状態。true の間は遊びかけの対局を上書きしない（設計書 §12）
let isViewingSharedKifu = false;
// 共有リンク（/?k=…）で開いた画面かどうか。見出し・タブ・盤の向きがこれで変わる
let isSharedKifuLink = false;

// 千日手判定用
let positionHistory = []; // 局面のハッシュを保存
let checkHistory = []; // 各局面で王手だったかを保存

// 計測用。「始めた数」は1手目が指された時点で1回だけ数える（盤を見ただけと区別するため）。
// gameStartFrom は次に始まる対局のきっかけで、initializeBoard が消費して 'new' に戻る
let gameStartFrom = 'new';
let gameStartedFrom = 'new';
let gameStartTracked = false;
let gameStartedAt = 0;

// --- 初期化 ---
function initializeBoard() {
    // AI思考中の場合はキャンセル（リクエストIDを更新して古い結果を無視）
    aiRequestId++;
    clearAiMoveDelayTimer();
    clearAiWatchdog();
    hideAIThinkingIndicator();

    gameStartedFrom = gameStartFrom;
    gameStartFrom = 'new';
    gameStartTracked = false;
    gameStartedAt = 0;

    applyBoardOrientation();

    board = Array(9).fill(null).map(() => Array(9).fill(null));
    capturedPieces = { [SENTE]: initCaptured(), [GOTE]: initCaptured() };
    currentPlayer = SENTE;
    moveCount = 0;
    selectedPiece = null;
    validMoves = [];
    lastSelection = null; // 前の対局の選択をフィードバックに持ち越さない
    clearMoveHint();
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
    clearAiMoveDelayTimer();
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
    clearMoveHint();

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

    // 相手の手番の局面に着いたら、その場で理由を出す（上の clearMoveHint() より後ろに置くこと）
    noticeOpponentTurnIfStuck();

    // localStorageに保存
    saveToLocalStorage();
}

// ＜＞ も棋譜一覧も、どの局面にも止まれる（設計書 §10）。
// 相手の手番の局面に着地したときは、その場で理由を出す（noticeOpponentTurnIfStuck）。
// 飛ばして着地させると、棋譜一覧の行と ＜＞ で行き先が食い違ってしまう。
function historyTargetIndex(direction) {
    if (gameMode === TSUME_MODE) return tsumeBridge.historyTargetIndex(currentHistoryIndex, direction);
    return currentHistoryIndex + direction;
}

function undoMove() {
    // 成り選択中の「待った」は保留中の手のキャンセルとして扱う（盤面・履歴は未更新のため閉じるだけでよい）
    if (promoteMoveInfo) {
        hidePromoteDialog();
        clearSelection();
        return;
    }
    if (gameMode === TSUME_MODE && tsumeBridge.isBusy()) return;
    const targetIndex = historyTargetIndex(-1);
    if (targetIndex >= 0) {
        restoreState(targetIndex);
        if (gameMode === TSUME_MODE) tsumeBridge.syncFromHistory();
    }
}

function redoMove() {
    if (promoteMoveInfo) return;
    if (gameMode === TSUME_MODE && tsumeBridge.isBusy()) return;
    const targetIndex = historyTargetIndex(1);
    if (targetIndex >= 0 && targetIndex < moveHistory.length) {
        restoreState(targetIndex);
        if (gameMode === TSUME_MODE) tsumeBridge.syncFromHistory();
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

    if (undoButton) undoButton.disabled = currentHistoryIndex <= 0;
    if (redoButton) redoButton.disabled = currentHistoryIndex >= moveHistory.length - 1;
}

window.addEventListener('load', function () {
    // 🔴 この読み込みは load 後のまま（ファーストビューを邪魔しないための措置）。
    // 受け皿と config はファイル先頭で済ませてあるので、それまでに溜まったぶんは
    // このスクリプトが読み込まれた時点でまとめて送られる。onload での初期化は不要
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    document.head.appendChild(script);

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

            // 動かせない理由の案内（原因の駒・玉・タップしたマス）
            if (moveHintState) {
                if (moveHintState.attackers.some(a => a.x === x && a.y === y)) {
                    square.classList.add('threat-source');
                }
                const kingPos = moveHintState.kingPos;
                if (kingPos && kingPos.x === x && kingPos.y === y) {
                    square.classList.add('threat-target');
                }
                const refuse = moveHintState.refuse;
                if (refuse && refuse.x === x && refuse.y === y) {
                    square.classList.add('no-move');
                }
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
    renderThreatLines();
}

function renderCapturedPieces() {
    renderCapturedSide(capturedWhiteElement, capturedPieces[SENTE], SENTE);
    renderCapturedSide(capturedBlackElement, capturedPieces[GOTE], GOTE);
}

// 持ち駒レーンの札は詰将棋だけ専用の呼び方で、それ以外は先手/後手で統一する。
// オンライン対戦で誰と指しているかは対局者バーが受け持つ
function getCapturedSideLabel(owner) {
    if (gameMode === TSUME_MODE) {
        // 詰将棋の呼び方に合わせる（攻方＝詰ます側、玉方＝詰まされる側）
        return owner === SENTE ? '攻方' : '玉方';
    }
    if (isOnlineMode() && matchmakingBridge.claimsBoard?.()) {
        // 待機中の詰めチャレンジ。ここも詰将棋なので同じ呼び方にする
        return owner === SENTE ? '攻方' : '玉方';
    }
    return owner === SENTE ? '先手' : '後手';
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
    renderKifuBar();
    capturedWhiteLaneElement.classList.toggle('is-active', currentPlayer === SENTE);
    capturedBlackLaneElement.classList.toggle('is-active', currentPlayer === GOTE);
    updatePlayerBarTurn();
}

function isLocalPlayersTurn() {
    if (gameOver) return false;

    if (isOnlineMode()) {
        // 待機中の詰めチャレンジが盤を使っている間は online-match.js が入力可否を決める
        if (matchmakingBridge.claimsBoard?.()) {
            return matchmakingBridge.boardInputAllowed?.() === true;
        }
        const started = isMatchStarted(onlineState.match);
        return started
            && !onlineState.match?.game_over
            && !onlineState.submitting
            && Boolean(onlineState.side)
            && onlineState.side === currentPlayer;
    }

    if (gameMode === 'ai') {
        // 棋譜を見ている間はどちらの側も動かせる。動かした側が「あなた」になって対局が始まる
        if (isViewingSharedKifu) return true;
        return currentPlayer === aiPlayerSide;
    }

    if (gameMode === TSUME_MODE) {
        // 玉方は自動で応じるので、攻方（先手）の手番だけ操作を受け付ける
        return currentPlayer === SENTE && !tsumeBridge.isBusy();
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
    if (!isLocalPlayersTurn()) {
        noticeOpponentTurnIfStuck();
        return;
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
            // 無効な移動先、または自分の別の駒を選択した場合。
            // 案内は選択を読むので、解除する前に組み立てておく
            const hint = moveHintEnabled ? explainRejectedTarget(x, y) : null;
            setMoveHint(hint, hint ? { x, y } : null);
            clearSelection(); // 従来どおり選択は解除する（renderBoard もここで走る）
            if (piece && piece.owner === currentPlayer) {
                selectPiece(x, y, piece); // 自駒なら選び直し。案内は selectPiece が上書きする
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
    if (!isLocalPlayersTurn()) {
        noticeOpponentTurnIfStuck();
        return;
    }

    const pieceElement = event.currentTarget;
    const type = pieceElement.dataset.type;
    const owner = pieceElement.dataset.owner;

    if (owner === currentPlayer) {
        clearSelection(); // 他の選択を解除
        selectedPiece = { owner: owner, type: type };
        validMoves = calculateDropLocations(type, owner);
        rememberSelection('*', type, validMoves);
        setMoveHint(moveHintEnabled && validMoves.length === 0 ? explainNoDropLocations(owner) : null);
        renderBoard(); // 移動可能箇所ハイライト
        renderCapturedPieces(); // 持ち駒ハイライト
    }
}

function selectPiece(x, y, piece) {
    clearSelection();
    selectedPiece = { x, y, piece: piece };
    validMoves = calculateValidMoves(x, y, piece);
    rememberSelection(toUsiSquare(x, y), piece.type, validMoves);
    // 指せる手が0でも、自駒で塞がっているだけなら何も言わない
    setMoveHint(
        moveHintEnabled && validMoves.length === 0 && calculatePseudoMoves(x, y, piece).length > 0
            ? explainNoLegalMoves(x, y, piece)
            : null
    );
    renderBoard(); // 再描画して選択状態と移動範囲を表示
    renderCapturedPieces();
}

// from は USI のマス（例 '7g'）。持ち駒を選んだときは '*'
function rememberSelection(from, pieceType, moves) {
    lastSelection = {
        at: Date.now(),
        from,
        piece: pieceType,
        moves: moves.map(move => toUsiSquare(move.x, move.y)),
    };
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
        rememberSelection(toUsiSquare(state.fromX, state.fromY), piece.type, validMoves);
        setMoveHint(
            moveHintEnabled && validMoves.length === 0
                && calculatePseudoMoves(state.fromX, state.fromY, piece).length > 0
                ? explainNoLegalMoves(state.fromX, state.fromY, piece)
                : null
        );
    } else {
        if (!capturedPieces[state.owner] || capturedPieces[state.owner][state.pieceType] <= 0) {
            disarmPieceDrag();
            return;
        }
        selectedPiece = { owner: state.owner, type: state.pieceType };
        validMoves = calculateDropLocations(state.pieceType, state.owner);
        rememberSelection('*', state.pieceType, validMoves);
        setMoveHint(moveHintEnabled && validMoves.length === 0 ? explainNoDropLocations(state.owner) : null);
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
        const hint = (moveHintEnabled && square) ? explainRejectedTarget(dropX, dropY) : null;
        setMoveHint(hint, hint ? { x: dropX, y: dropY } : null);
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

    playPieceSound();

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

    playPieceSound();

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
    // 棋譜を見ている途中で駒を動かしたら、その1手で対局に切り替える。
    // currentPlayer はまだ「いま指した側」なので、この行より後ろに置いてはいけない
    // （josekiMoveIndex の判定が aiPlayerSide を読むため）。
    // 案内の文だけは受け取って、下の clearMoveHint() より後ろで出す
    const kifuStartNotice = isViewingSharedKifu ? beginPlayFromKifu(currentPlayer) : null;

    moveCount++;

    // 「実際に遊び始めた数」。盤を見ただけの人と区別する分母になるので、1手目で1回だけ数える。
    // 通信対戦は対局成立の時点で数えるので（trackOnlineMatchFound）ここでは扱わない。
    // 詰将棋と待機中の詰めチャレンジは対局ではないので除く
    if (!gameStartTracked
        && !isOnlineMode()
        && gameMode !== TSUME_MODE
        && !matchmakingBridge.claimsBoard?.()) {
        gameStartTracked = true;
        gameStartedAt = Date.now();
        track('game_start', {
            mode: gameMode,
            start_from: gameStartedFrom,
            difficulty: gameMode === 'ai' ? aiDifficulty : undefined,
            side: gameMode === 'ai' ? aiPlayerSide : undefined,
            opponent: gameMode === 'ai' ? 'ai' : 'self',
        });
    }

    // プレイヤーの手を記録（定石判定用）
    if (gameMode === 'ai' && currentPlayer === aiPlayerSide) {
        josekiMoveIndex++;
    }

    switchPlayer();
    clearSelection(); // 選択状態と移動可能範囲をクリア
    clearMoveHint(); // 局面が変わったので、前の手についての案内は消す
    // 🔴 clearMoveHint() より後で出すこと。先に出すとこの行で消えてしまい、
    // 盤が180度回った理由が何も出ないまま対局が始まる
    if (kifuStartNotice) showKifuToast(kifuStartNotice);

    // 王手チェック
    isCheck = isKingInCheck(currentPlayer);
    if (isCheck) {
        // 詰みチェック
        checkmate = isCheckmate(currentPlayer);
        if (gameMode === TSUME_MODE || matchmakingBridge.claimsBoard?.()) {
            // 詰将棋（と待機中の詰めチャレンジ）は毎手が王手なので王手表示は出さない。
            // 詰み上がりの演出も対局用ダイアログではなく詰将棋側で出す。
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

    // 千日手判定（詰将棋・待機中の詰めチャレンジには無関係。決着は手数で決まるので対局用の終局を出さない）
    if (!gameOver && gameMode !== TSUME_MODE && !matchmakingBridge.claimsBoard?.()) {
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
        tsumeBridge.afterMove(usiMove);
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

function scheduleAIMoveIfNeeded() {
    // 🔴 過去の局面を見ているだけのときはAIを動かさない（設計書 §10）。
    // ＜＞ で戻っただけなら restoreState() がAIを打ち切るので指さないが、
    // その状態でページを再読み込みすると復元処理の最後にここへ来てしまう。
    // 呼び出し側を個別に直すより、入口で1回止めるほうが安全。
    if (currentHistoryIndex !== moveHistory.length - 1) return;
    // 共有された棋譜を眺めているだけのときも指さない
    if (isViewingSharedKifu) return;

    const aiPlayer = getAIPlayer();
    if (!aiPlayer || gameMode !== 'ai' || gameOver) {
        return;
    }
    if (currentPlayer !== aiPlayer) {
        return;
    }

    // 待ちは応手が返ってきた後に入れる（finishAiTurnAfterMinThinkTime）。
    // ここでは探索をすぐ始めて、経過時間の起点だけ記録しておく。
    // makeAIMove は Worker への postMessage だけなので同期呼び出しでよい。
    aiThinkStartedAt = Date.now();
    makeAIMove();
}

function getBoardPerspectiveSide() {
    // 共有された棋譜は他人の対局なので、自分の手番の好みで上下が入れ替わらないようにする
    if (isSharedKifuLink) return SENTE;
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

// --- 動かせない理由の案内 ---
// 探索の速い経路（isSquareAttackedBy）には手を入れず、ユーザー操作のときだけ呼ぶ素朴な実装。
// 「玉を攻めている駒はどれか」を知りたいので、真偽値ではなくマスを返す。

/** player の玉を攻めている相手の駒を全部返す */
function findKingAttackers(player, boardState = board) {
    const kingPos = findKing(player, boardState);
    if (!kingPos) return { kingPos: null, attackers: [] };

    const opponent = player === SENTE ? GOTE : SENTE;
    const attackers = [];
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = boardState[y][x];
            if (!piece || piece.owner !== opponent) continue;
            const moves = calculateRawPieceMoves(x, y, piece, boardState);
            if (moves.some(move => move.x === kingPos.x && move.y === kingPos.y)) {
                attackers.push({ x, y, type: piece.type });
            }
        }
    }
    return { kingPos, attackers };
}

// 盤の駒は1文字だが、文章の中では読みやすい呼び方にする
const PIECE_SENTENCE_NAMES = {
    [KING]: '玉', [ROOK]: '飛車', [BISHOP]: '角', [GOLD]: '金', [SILVER]: '銀',
    [KNIGHT]: '桂馬', [LANCE]: '香車', [PAWN]: '歩',
    [PROMOTED_ROOK]: '竜', [PROMOTED_BISHOP]: '馬', [PROMOTED_SILVER]: '成銀',
    [PROMOTED_KNIGHT]: '成桂', [PROMOTED_LANCE]: '成香', [PROMOTED_PAWN]: 'と金'
};

function pieceLabelOf(type) {
    return PIECE_SENTENCE_NAMES[type] || pieceNames[type] || '駒';
}

/** 今まさに王手されているときの案内。されていなければ null */
function buildCheckHint(player) {
    const { kingPos, attackers } = findKingAttackers(player);
    if (attackers.length === 0) return null;
    return {
        text: '王手されています。玉を逃がすか、王手を防ぐ手だけ指せます',
        attackers,
        kingPos,
    };
}

/** 案2: 選んだ駒に指せる手が1つも無いときの理由。理由が「自玉が取られる」でなければ null */
function explainNoLegalMoves(x, y, piece) {
    const owner = piece.owner;
    const checkHint = buildCheckHint(owner);
    if (checkHint) return checkHint;

    // 王手ではないので、動かすと開いてしまう筋（ピン）を探す。
    // その駒を盤から外した状態で玉を攻めている駒＝ピンしている駒
    const tempBoard = cloneBoard(board);
    tempBoard[y][x] = null;
    const { kingPos, attackers } = findKingAttackers(owner, tempBoard);
    if (attackers.length === 0) return null;

    return {
        text: `この${pieceLabelOf(piece.type)}を動かすと${pieceLabelOf(attackers[0].type)}に玉を取られます`,
        attackers,
        kingPos,
    };
}

/** 案2（持ち駒）: 打てる場所が1つも無いとき。王手を防げない場合だけ出す */
function explainNoDropLocations(owner) {
    return buildCheckHint(owner);
}

/** 案3: 選択中の駒を (toX, toY) へ動かす／打つと自玉が取られるか。取られないなら null */
function explainRejectedTarget(toX, toY) {
    if (!selectedPiece) return null;

    const isDrop = selectedPiece.x === undefined;
    const owner = isDrop ? selectedPiece.owner : selectedPiece.piece.owner;
    const tempBoard = cloneBoard(board);

    if (isDrop) {
        if (board[toY][toX] !== null) return null; // 駒がある所には打てない
        tempBoard[toY][toX] = { type: selectedPiece.type, owner };
    } else {
        // その駒が本来届かないマスなら、動き方の話なので何も言わない
        const reachable = calculatePseudoMoves(selectedPiece.x, selectedPiece.y, selectedPiece.piece)
            .some(move => move.x === toX && move.y === toY);
        if (!reachable) return null;
        tempBoard[toY][toX] = tempBoard[selectedPiece.y][selectedPiece.x];
        tempBoard[selectedPiece.y][selectedPiece.x] = null;
    }

    const { kingPos, attackers } = findKingAttackers(owner, tempBoard);
    if (attackers.length === 0) return null;

    const attackerLabel = pieceLabelOf(attackers[0].type);
    return {
        text: isDrop
            ? `そこに打っても、${attackerLabel}の王手は防げません`
            : `そこへ動かすと${attackerLabel}に玉を取られます`,
        attackers,
        kingPos,
    };
}

/**
 * 案内を差し替える。描画は呼び出し側の renderBoard() に任せる。
 * @param {object|null} hint explain* の戻り値
 * @param {{x: number, y: number}|null} refuse 赤く光らせるマス（断ったタップ先）
 * @param {{force?: boolean}} options force を立てると、詳細設定で
 *   「動かせない理由の案内」をOFFにしている人にも出す。親切な案内ではなく
 *   「なぜ動かないのか」の説明にだけ使う（設計書 §10）
 */
function setMoveHint(hint, refuse = null, options = {}) {
    if (moveHintHideTimer) {
        clearTimeout(moveHintHideTimer);
        moveHintHideTimer = null;
    }
    moveHintState = ((moveHintEnabled || options.force === true) && hint) ? { ...hint, refuse } : null;
    moveHintTextVisible = moveHintState !== null;
    renderMoveHintText();

    // 文章は盤に重なるので、どの出し方でも数秒で引っ込める。
    // マスのタップで出した案内（refuse あり）は選択が残らないので、赤い印も一緒に片付ける。
    // 駒を選んで出した案内は、選び直すまで印だけ残す（何が原因かは見えたままにする）
    if (moveHintState) {
        moveHintHideTimer = setTimeout(() => {
            moveHintHideTimer = null;
            moveHintTextVisible = false;
            const clearMarks = !!(moveHintState && moveHintState.refuse);
            if (clearMarks) moveHintState = null;
            renderMoveHintText();
            if (clearMarks) renderBoard();
        }, MOVE_HINT_AUTO_HIDE_MS);
    }
}

function clearMoveHint() {
    if (!moveHintState && !moveHintHideTimer) return;
    setMoveHint(null);
}

function renderMoveHintText() {
    if (!moveHintElement) return;
    const textElement = moveHintElement.querySelector('.move-hint-text');
    if (!moveHintState || !moveHintTextVisible) {
        if (textElement) textElement.textContent = '';
        moveHintElement.hidden = true;
        moveHintElement.classList.remove('is-visible');
        stopMoveHintFollow();
        return;
    }
    if (textElement) textElement.textContent = moveHintState.text;
    moveHintElement.hidden = false;
    positionMoveHint();
    moveHintElement.classList.add('is-visible');
    startMoveHintFollow();
}

/**
 * 盤に重ねた案内の置き場所を決める。
 * 1. 赤く光っているマス（原因の駒・玉・タップしたマス）から遠い側の辺に置く
 * 2. その位置が画面から外れそうなら、画面のやや内側へ寄せる（スクロールすると追従して止まる）
 * どちらも盤の内側からは出ない。
 */
function positionMoveHint() {
    if (!moveHintElement || moveHintElement.hidden || !boardStageElement) return;

    const rect = boardStageElement.getBoundingClientRect();
    const height = moveHintElement.offsetHeight;
    if (!rect.height || !height) return;

    // 盤の画面上端からの距離で考える（盤を180度回していても画面基準でそろう）
    const min = MOVE_HINT_BOARD_MARGIN;
    const max = Math.max(min, rect.height - height - MOVE_HINT_BOARD_MARGIN);
    let screenTop = rect.top + (moveHintAnchorsInUpperHalf() ? max : min);

    // 画面の上に隠れそうなら下げ、下に隠れそうなら上げる
    screenTop = Math.max(screenTop, MOVE_HINT_SCREEN_MARGIN);
    screenTop = Math.min(screenTop, window.innerHeight - height - MOVE_HINT_SCREEN_MARGIN);

    const offset = Math.round(Math.min(Math.max(screenTop - rect.top, min), max));

    // 盤を180度回しているときは、画面の上端＝盤の座標では下端になる
    // 上下どちらか一方だけを指定する。両方が効くと高さが引き伸ばされてしまう
    const flipped = document.body.classList.contains('board-flipped');
    moveHintElement.style.top = flipped ? 'auto' : `${offset}px`;
    moveHintElement.style.bottom = flipped ? `${offset}px` : 'auto';
}

/** 赤く光っているマスが画面の上半分に集まっているか（集まっていれば案内は下辺へ逃がす） */
function moveHintAnchorsInUpperHalf() {
    if (!moveHintState) return false;
    const rows = moveHintState.attackers.map(attacker => attacker.y);
    if (moveHintState.kingPos) rows.push(moveHintState.kingPos.y);
    if (moveHintState.refuse) rows.push(moveHintState.refuse.y);
    if (rows.length === 0) return false;

    const average = rows.reduce((sum, y) => sum + y, 0) / rows.length;
    const flipped = document.body.classList.contains('board-flipped');
    return (flipped ? 8 - average : average) < 4;
}

// 文章を出している間だけスクロールを追いかける（出していないときは何も張らない）
function handleMoveHintFollow() {
    if (moveHintFollowFrame) return;
    moveHintFollowFrame = requestAnimationFrame(() => {
        moveHintFollowFrame = 0;
        positionMoveHint();
    });
}

function startMoveHintFollow() {
    if (moveHintFollowActive) return;
    moveHintFollowActive = true;
    window.addEventListener('scroll', handleMoveHintFollow, { passive: true });
    window.addEventListener('resize', handleMoveHintFollow);
}

function stopMoveHintFollow() {
    if (!moveHintFollowActive) return;
    moveHintFollowActive = false;
    window.removeEventListener('scroll', handleMoveHintFollow);
    window.removeEventListener('resize', handleMoveHintFollow);
    if (moveHintFollowFrame) {
        cancelAnimationFrame(moveHintFollowFrame);
        moveHintFollowFrame = 0;
    }
}

/**
 * 原因の駒から玉までの利き筋を1本の線で引く。
 * 引くのは「同じ筋・段・斜めに並んでいて2マス以上離れている」ときだけ。
 * 飛・角・香・竜・馬は必ずここに当てはまり、桂や隣接の駒は線にしても意味がないので枠だけになる。
 */
function renderThreatLines() {
    if (!moveHintState || !moveHintState.kingPos) return;

    const king = moveHintState.kingPos;
    const targets = moveHintState.attackers.filter((attacker) => {
        const dx = king.x - attacker.x;
        const dy = king.y - attacker.y;
        const aligned = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
        return aligned && Math.max(Math.abs(dx), Math.abs(dy)) >= 2;
    });
    if (targets.length === 0) return;

    // viewBox は 1マス=40 の抽象単位。盤の実寸が変わっても比率で追従する
    const CELL = 40;
    const HALF = CELL / 2;
    const EDGE = 19; // 赤い枠のすぐ外から引き、駒の中心を貫かない
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'threat-overlay');
    svg.setAttribute('viewBox', `0 0 ${CELL * 9} ${CELL * 9}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const kingCx = king.x * CELL + HALF;
    const kingCy = king.y * CELL + HALF;
    for (const attacker of targets) {
        const cx = attacker.x * CELL + HALF;
        const cy = attacker.y * CELL + HALF;
        const dx = kingCx - cx;
        const dy = kingCy - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', cx + (dx / dist) * EDGE);
        line.setAttribute('y1', cy + (dy / dist) * EDGE);
        line.setAttribute('x2', kingCx - (dx / dist) * EDGE);
        line.setAttribute('y2', kingCy - (dy / dist) * EDGE);
        svg.appendChild(line);
    }
    boardElement.appendChild(svg);
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

    // 思考中インジケータを表示。どの難易度でも最低 MIN_AI_THINK_MS は表示されるので、
    // 一瞬だけ出て消えるチラつきにはならない。非表示は実際に指す瞬間に行う。
    showAIThinkingIndicator();

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

    startAiWatchdog(currentRequestId);
}

function clearAiMoveDelayTimer() {
    if (aiMoveDelayTimerId === null) return;
    clearTimeout(aiMoveDelayTimerId);
    aiMoveDelayTimerId = null;
}

// AIの応手が返らないまま手番が止まる不具合（報告あり・原因未特定）の実在と条件を測る。
// 記録するだけで盤には一切手を触れない。伝説級の正当な長考と区別できるよう
// 難易度も一緒に送る（60秒は最上位でも通常は超えない想定）
const AI_WATCHDOG_MS = 60000;
let aiWatchdogTimerId = null;

function clearAiWatchdog() {
    if (aiWatchdogTimerId === null) return;
    clearTimeout(aiWatchdogTimerId);
    aiWatchdogTimerId = null;
}

function startAiWatchdog(requestId) {
    clearAiWatchdog();
    aiWatchdogTimerId = setTimeout(() => {
        aiWatchdogTimerId = null;
        // 「待った」や新規対局で用済みになっていたら数えない
        if (requestId !== aiRequestId) return;
        if (gameOver || currentPlayer !== getAIPlayer()) return;
        trackAppError('ai_timeout');
    }, AI_WATCHDOG_MS);
}

// 探索が速く終わっても、自分が指してから MIN_AI_THINK_MS 経つまでは盤に載せない。
// 詰将棋の TSUME_REPLY_DELAY_MS、軍人将棋の MIN_AI_THINK_MS と同じ考え方。
function finishAiTurnAfterMinThinkTime(requestId, apply) {
    clearAiMoveDelayTimer();
    clearAiWatchdog(); // 応手は返ってきた（この先の遅れは最低思考時間の待ちだけ）

    const wait = Math.max(0, MIN_AI_THINK_MS - (Date.now() - aiThinkStartedAt));
    const run = () => {
        aiMoveDelayTimerId = null;
        hideAIThinkingIndicator();

        // 待っている間に「待った」や新規対局が入っていたら、この応手は捨てる
        if (requestId !== undefined && requestId !== aiRequestId) {
            console.log('Ignoring AI move resolved after reset (requestId mismatch)');
            return;
        }
        // 待っている間に対局が終わっていた場合も捨てる（詰み表示の二重出しを防ぐ）
        if (gameOver) return;

        apply();
    };

    if (wait === 0) {
        run();
        return;
    }

    aiMoveDelayTimerId = setTimeout(run, wait);
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

        playPieceSound();

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
const STORAGE_KEY_MOVE_HINT = 'shogi_move_hint'; // '1' / '0'。未保存なら ON
const STORAGE_KEY_BOT_FALLBACK = 'shogi_bot_fallback'; // '1' / '0'。未保存なら ON
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
        // オンライン対戦の局面はサーバーが持っているのでローカルには保存しない。
        // 共有された棋譜を眺めているだけのときも触らない（遊びかけの対局を消さないため。設計書 §12）。
        // 難易度などの好みはこの下で保存するので、関数ごと抜けてはいけない
        const stateKey = isViewingSharedKifu ? null : gameStateStorageKey();
        if (stateKey) {
            localStorage.setItem(stateKey, JSON.stringify(buildSavedGameState()));
        }
        localStorage.setItem(STORAGE_KEY_AI_DIFFICULTY, aiDifficulty);
        localStorage.setItem(STORAGE_KEY_PIECE_DISPLAY_MODE, pieceDisplayMode);
        localStorage.setItem(STORAGE_KEY_MOVE_HINT, moveHintEnabled ? '1' : '0');
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
        applyMoveHintPreference(localStorage.getItem(STORAGE_KEY_MOVE_HINT));
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

            // 新形式（v2）は指し手の並びだけ。開くときに並べ直して盤を組み立てる（設計書 §12）
            if (gameState.v === 2) {
                if (!restoreSavedMoves(gameState)) return false;
                renderBoard();
                renderCapturedPieces();
                updateInfo();
                updateHistoryButtons();
                scheduleAIMoveIfNeeded();
                console.log('ゲーム状態を復元しました（指し手の並びから再生）');
                return true;
            }

            // 旧形式。これまでどおり履歴まるごと読む。次の保存で v2 に切り替わる
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
        applyMoveHintPreference(localStorage.getItem(STORAGE_KEY_MOVE_HINT));
    } catch (e) {
        // ignore
    }
}

/** 保存値（未保存なら ON）を状態とチェックボックスに反映する */
function applyMoveHintPreference(saved) {
    moveHintEnabled = saved !== '0';
    if (moveHintCheckbox) moveHintCheckbox.checked = moveHintEnabled;
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
    gameStartFrom = 'next_level';
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
    // 結果ダイアログから続けて始めた対局は「連戦」として数える。
    // 押した回数そのものではなく、終局のうち何割が次の対局に進んだかを見たいため
    gameStartFrom = 'rematch';

    // マッチング対戦の「もう一度」= 自動再キュー（online-match.js が処理）
    if (matchmakingBridge.handleNewGame?.()) return;
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

// オンライン対戦から離れるときの確認と投了。タブは通常のリンクなので、遷移を止めて
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
        console.error('オンライン対戦の離脱処理に失敗しました:', error);
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
    const focusables = openFriendModalElement.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea');
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
    [friendQrModal, friendGuideModal, friendTimeModal, difficultyModal, kifuImportModal, kifuBranchModal].forEach((m) => {
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
        // 招待を出した数。成立数と並べて「作ったが相手が来なかった」を切り分ける
        track('invite_create', { method: 'copy', time_control: getFriendTcValue() });
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
        track('invite_create', { method: 'qr', time_control: getFriendTcValue() });
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

// 「だれかと対戦」で相手が見つからないときのCOM対局。実際に使うのは /online/ の
// online-match.js だが、設定はどのページの詳細設定からでも変えられるようにここで面倒を見る
// （online-match.js は対局を探し始めるたびに同じキーを読み直す）。
if (botFallbackCheckbox) {
    try {
        botFallbackCheckbox.checked = localStorage.getItem(STORAGE_KEY_BOT_FALLBACK) !== '0';
    } catch (_) { /* ignore */ }
    botFallbackCheckbox.addEventListener('change', () => {
        try {
            localStorage.setItem(STORAGE_KEY_BOT_FALLBACK, botFallbackCheckbox.checked ? '1' : '0');
        } catch (_) { /* ignore */ }
    });
}

// 「動かせない理由を表示する」の切り替え
moveHintCheckbox?.addEventListener('change', (e) => {
    moveHintEnabled = e.target.checked;
    saveToLocalStorage();
    clearMoveHint(); // OFFにした瞬間に盤の赤い枠と線を消す
    renderBoard();
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
    // ハニーポット（type=text）や非表示ビュー内の要素はフォーカス対象から除く。
    // チェックボックスはモード選択チップ（friend-chip流用）のもの。
    return Array.from(
        feedbackModal.querySelectorAll('button, textarea, input[type="checkbox"]')
    ).filter((el) => el.offsetParent !== null && !el.disabled);
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

// 原因調査用の診断情報。ユーザー入力なしで分かるものだけを集める（個人情報は含めない）。
// 失敗してもフィードバック送信自体は止めない。
// 診断情報の上限。meta はサーバ側で 4000 文字に切り詰められるので、その手前に収める。
// 収まらないときに削るのは棋譜だけ（いちばん長くなる項目で、末尾さえあれば大半は追える）。
const FEEDBACK_MAX_SELECT_MOVES = 40;
const FEEDBACK_META_BUDGET = 3800;

/**
 * 棋譜（USI）を診断情報に載せる。全体が FEEDBACK_META_BUDGET に収まる範囲で、
 * 直近の手をできるだけ多く残す（原因に近いのは直近の手なので、削るのは古いほう）。
 * 🔴 1手でも削ったときは movesTotal に本当の手数を入れること。
 *    これが無いと「短い対局」なのか「切られた棋譜」なのか後から見分けられない。
 */
function attachFeedbackMoves(context, usiMoves) {
    const total = usiMoves.length;
    if (total === 0) return;

    // 棋譜以外がどれだけ使っているかを1回だけ測る。「切った印」を付けた状態で測っておき、
    // 全部載ったときだけ後から外す（外すと短くなるだけなので予算を割らない）
    context.moves = '';
    context.movesTotal = total;
    const room = FEEDBACK_META_BUDGET - JSON.stringify(context).length;

    const full = usiMoves.join(' ');
    if (full.length <= room) {
        context.moves = full;
        delete context.movesTotal; // 1手も削っていないので印は付けない
        return;
    }

    let kept = 0;
    let length = 0;
    for (let i = total - 1; i >= 0; i--) {
        const next = length + usiMoves[i].length + (kept > 0 ? 1 : 0); // 区切りの空白ぶん
        if (next > room) break;
        length = next;
        kept++;
    }
    // kept が 0 でも movesTotal は残す（「載せられなかった」ことが分かるように）
    context.moves = usiMoves.slice(total - kept).join(' ');
}

function collectFeedbackContext() {
    try {
        const scriptEl = document.querySelector('script[src*="shogi"]');
        const context = {
            mode: gameMode,
            build: scriptEl ? (scriptEl.getAttribute('src') || '').split('/').pop() : null,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            dpr: window.devicePixelRatio || 1,
            standalone: window.matchMedia('(display-mode: standalone)').matches
                || window.navigator.standalone === true,
            netOnline: navigator.onLine,
            lang: navigator.language,
            sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
            reporter: getFeedbackReporterId(),
            game: {
                moveCount,
                currentPlayer,
                gameOver,
            },
            // 報告時の局面。これがあれば「本当に行ける手だったのか」を後から再現できる
            position: boardToSfen(),
            errors: recentErrors.map((err) => ({
                source: err.source,
                message: err.message,
                secondsAgo: Math.round((Date.now() - err.at) / 1000),
            })),
        };
        // 直前に選んでいた駒と、そのとき盤に出していた移動先
        if (lastSelection) {
            context.select = {
                from: lastSelection.from,
                piece: lastSelection.piece,
                moves: lastSelection.moves.slice(0, FEEDBACK_MAX_SELECT_MOVES),
                moveCount: lastSelection.moves.length,
                secondsAgo: Math.round((Date.now() - lastSelection.at) / 1000),
            };
        }
        if (gameMode === 'ai') {
            context.ai = {
                difficulty: aiDifficulty,
                playerSide: aiPlayerSide,
                yaneuraouReady,
                yaneuraouAlive: !!yaneuraouWorker,
                thinking: !!(aiThinkingIndicator
                    && aiThinkingIndicator.classList.contains('visible')),
            };
        }
        if (isOnlineMode()) {
            context.onlineMatch = {
                inRoom: !!onlineState.roomCode,
                side: onlineState.side,
                wsReady: onlineState.wsReady,
                wsState: onlineState.ws ? onlineState.ws.readyState : null,
            };
        }
        // 棋譜は最後に載せる。残りがどれだけ場所を使ったかを測ってから量を決めるため
        attachFeedbackMoves(context, getActiveUsiMoves());
        return context;
    } catch (_) {
        return { mode: gameMode, collectFailed: true };
    }
}

function selectedFeedbackModes() {
    return Array.from(
        feedbackForm.querySelectorAll('input[name="feedback-mode"]:checked')
    ).map((el) => el.value);
}

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
            body: {
                message,
                website: feedbackHoneypot.value,
                modes: selectedFeedbackModes(),
                context: collectFeedbackContext(),
            },
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

// 勝者の呼び方。自分がいる対局（オンライン・AI対戦）は先後ではなく
// 「あなた」「yuki さん」「AI」で伝える。将棋盤モード・詰将棋は先手/後手のまま
// （1台を2人で使うので「あなた」が決まらない）
function getResultWinnerLabel(winner) {
    if (winner === '引き分け') return winner;
    if (gameMode === 'ai') {
        // aiPlayerSide は「プレイヤーが担当する手番」
        return winner === (aiPlayerSide === SENTE ? '先手' : '後手') ? 'あなた' : 'AI';
    }
    if (!isOnlineMode()) return winner;
    const match = onlineState.match;
    if (!isMatchStarted(match) || !onlineState.side) return winner;
    const winnerSide = winner === '先手' ? SENTE : GOTE;
    return winnerSide === onlineState.side
        ? 'あなた'
        : getOpponentSubject(match, onlineState.side);
}

function createResultDialogState(winner, reason) {
    const winnerLabel = getResultWinnerLabel(winner);
    return {
        winner,
        winnerLabel,
        title: winner === '引き分け' ? '引き分け' : `${winnerLabel}の勝利！`,
        reason,
        tone: getGameResultTone(winner),
        moveCount: Number.isFinite(moveCount) ? moveCount : 0,
    };
}

/** 対局後の共有URL（/?k=…&m=…）。作れないときは null（呼び側がこのページのURLに落とす） */
function buildResultShareUrl() {
    if (!kifuCoreAvailable()) return null;
    const moves = kifuAllMoves();
    if (!moves.length) return null; // 0手で終わった対局はURLに載せる中身がない
    let encoded = null;
    try {
        encoded = KifuCore.encodeKifuParam(moves);
    } catch (error) {
        console.error('棋譜URLを作れませんでした:', error);
        return null;
    }
    if (encoded === null) return null;
    return buildKifuUrl(encoded, moves.length);
}

/**
 * 共有する文面。1行目に「◯手・◯◯で◯の勝ち」までまとめる（Xで読まれやすい長さにする）。
 * @param kifuUrl  棋譜URL。あるときだけ「▼ 棋譜はこちら」を付ける
 * @param embedUrl 本文にURLまで入れる（X）。false なら見出しだけ出し、URLは共有先が付ける（LINE）
 * @param hashtag  #将棋Web を付けるか（LINEは1対1のトークなので付けない）
 */
function buildResultShareText({ kifuUrl = null, embedUrl = false, hashtag = true } = {}) {
    const state = currentResultDialogState;
    // 共有文は第三者が読むので、勝敗は名前ではなく先後のままにする
    const outcome = !state.winner ? '終局'
        : state.winner === '引き分け' ? '引き分け'
            : `${state.winner}の勝ち`;
    // reason が '終局'（理由不明のとき既定値）なら「終局で〜」と書かずに省く
    const reason = state.reason && state.reason !== '終局' ? `${state.reason}で` : '';
    const lines = [`将棋Webで対局しました！（${state.moveCount}手・${reason}${outcome}）`];
    if (kifuUrl) {
        lines.push('', '▼ 棋譜はこちら');
        if (embedUrl) lines.push(kifuUrl);
    }
    if (hashtag) lines.push('', '#将棋Web');
    return lines.join('\n');
}

// 🔴 window.open は noopener を付けると「新しいタブが開けても null」を返す仕様なので、
// 戻り値で開けたかどうかは判定できない（判定に使うと新タブ＋同じタブの二重遷移になる）。
// a要素のクリックなら判定が要らず、タブを増やせない環境では同じタブで開いてくれる。
function openShareWindow(url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// 終局理由の表示文 → 記録用のコード。表示文は showGameOverDialog の呼び出し側と
// mapResultReason が作るので、増やしたらここにも足すこと（漏れは 'other' に落ちる）
const GAME_END_REASON_CODES = {
    '詰み': 'checkmate',
    '投了': 'resign',
    '時間切れ': 'timeout',
    '切断': 'disconnect',
    '千日手': 'sennichite',
    '連続王手の千日手': 'perpetual_check',
    '終局': 'other',
};

/** 自分から見た勝敗。自分がいない対局（将棋盤モード）では null を返す */
function selfResultFrom(winner, mySide) {
    if (!mySide) return null;
    if (winner === '引き分け') return 'draw';
    return winner === (mySide === SENTE ? '先手' : '後手') ? 'win' : 'lose';
}

function trackGameEnd(winner, reason) {
    const params = {
        mode: gameMode,
        reason: GAME_END_REASON_CODES[reason] || 'other',
        moves: moveCount,
        start_from: gameStartedFrom,
    };
    if (gameStartedAt) {
        params.duration_sec = Math.round((Date.now() - gameStartedAt) / 1000);
    }
    if (gameMode === 'ai') {
        params.difficulty = aiDifficulty;
        params.opponent = 'ai';
        params.side = aiPlayerSide;
        params.result = selfResultFrom(winner, aiPlayerSide);
    } else if (isOnlineMode()) {
        const kind = matchmakingBridge.matchKind?.() || 'invite';
        params.match_type = kind;
        params.opponent = kind === 'bot' ? 'com' : 'human';
        params.time_control = onlineTimeControlValue(onlineState.match);
        params.side = onlineState.side || undefined;
        params.result = selfResultFrom(winner, onlineState.side);
    } else {
        // 将棋盤モードは1台を2人で使うので「自分」がいない。result は付けない
        params.opponent = 'self';
    }
    track('game_end', params);
}

// --- 結果ダイアログの中身（見出しの下） -----------------------------------
// モードごとに出すものが違う。**この4通りしかない**ので、増やすときはここだけ触る。
//   だれかと対戦（実力値あり） … 「投了 ・ 42手」＋ 段位カード
//   AI対戦・友達対戦           … 「42手で決着」＋ 成績ストリップ
//   将棋盤・実力値が付かない対局 … 「投了 ・ 42手」だけ
// 仕様の正本は docs/online-rating-spec.md §8。

/** 見出しの下の1行。parts を中黒でつないで出す */
function renderResultSub(parts) {
    if (!gameResultSub) return;
    gameResultSub.textContent = '';
    parts.filter(Boolean).forEach((text, index) => {
        if (index > 0) {
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.setAttribute('aria-hidden', 'true');
            gameResultSub.appendChild(sep);
        }
        const span = document.createElement('span');
        span.textContent = text;
        gameResultSub.appendChild(span);
    });
}

/**
 * 成績ストリップ。cells = [{ label, value, unit, kind }] で、kind は
 * 'reason'（決まり方。長いと折り返す）か 'text'（レベル名・相手の名前。長いと省略）。
 * 省略すると数字あつかい。cells が空なら枠ごと隠す。
 */
function renderResultStrip(cells) {
    if (!gameResultStrip) return;
    gameResultStrip.textContent = '';
    gameResultStrip.hidden = cells.length === 0;
    if (!cells.length) return;
    gameResultStrip.style.setProperty('--result-strip-cols', String(cells.length));
    cells.forEach((cell) => {
        const wrap = document.createElement('div');
        wrap.className = 'result-strip-cell';

        const label = document.createElement('span');
        label.className = 'result-strip-label';
        label.textContent = cell.label;

        const value = document.createElement('span');
        value.className = 'result-strip-value';
        const main = document.createElement('span');
        if (cell.kind) main.className = cell.kind;
        main.textContent = cell.value;
        value.appendChild(main);
        if (cell.unit) {
            const unit = document.createElement('span');
            unit.className = 'unit';
            unit.textContent = cell.unit;
            value.appendChild(unit);
        }

        wrap.append(label, value);
        gameResultStrip.appendChild(wrap);
    });
}

/** AI対戦の勝った回数。ロビーの解放条件と同じ値を読む（保存は showGameOverDialog 側） */
function readAiWinCount() {
    try {
        return parseInt(localStorage.getItem('shogi_ai_win_count') || '0', 10) || 0;
    } catch (_) {
        return 0;
    }
}

/** ストリップに出す「相手」。友達対戦は名前、名前未入力なら匿名プレイヤー */
function resultOpponentName() {
    return getOpponentDisplayName(onlineState.match, onlineState.side) || ANON_OPPONENT_LABEL;
}

/**
 * 見出しの下をまとめて描き直す。ratingInfo は段位カードに出す値
 * （だれかと対戦で実力値が動いたときだけ。無ければ null）。
 * COM戦はサーバーの返事を待つので、あとから renderResultRating が呼び直す。
 */
function renderResultBody(ratingInfo) {
    const state = currentResultDialogState;
    const moves = `${state.moveCount}手`;

    // 実力値が動いた「だれかと対戦」だけが段位カード。それ以外はカードを出さない
    if (ratingInfo) {
        renderResultSub([state.reason, moves]);
        renderResultStrip([]);
        renderResultRankCard(ratingInfo);
        return;
    }
    renderResultRankCard(null);

    if (gameMode === 'ai') {
        // 通算勝利は0のとき出さない（初対局で負けた人に「0」を見せない）
        const wins = readAiWinCount();
        renderResultSub([`${moves}で決着`]);
        renderResultStrip([
            { label: '決まり方', value: state.reason, kind: 'reason' },
            { label: 'レベル', value: getDifficultyLabel(aiDifficulty), kind: 'text' },
            ...(wins > 0 ? [{ label: '通算勝利', value: String(wins), unit: '勝' }] : []),
        ]);
        return;
    }

    // 友達対戦。だれかと対戦でも実力値が付かない対局（チュートリアル・上限など）は
    // ここではなく下の「理由と手数だけ」に落ちる
    if (isOnlineMode() && isFriendMatch()) {
        renderResultSub([`${moves}で決着`]);
        renderResultStrip([
            { label: '決まり方', value: state.reason, kind: 'reason' },
            { label: '相手', value: resultOpponentName(), kind: 'text' },
        ]);
        return;
    }

    // 将棋盤モードと、実力値が付かなかった「だれかと対戦」
    renderResultSub([state.reason, moves]);
    renderResultStrip([]);
}

/** 友達対戦（招待）か。だれかと対戦・COM戦は match_type が 'matchmaking' */
function isFriendMatch() {
    const match = onlineState.match;
    return Boolean(match) && match.match_type !== 'matchmaking';
}

/**
 * 段位カード。だれかと対戦で実力値が動いたときだけ出す。
 * info = { rating, delta, rank, promotedTo } / 出さないときは null。
 * 次の段級位までのゲージは対局データに入っていないので、ここでは埋めない
 * （/status の返事が届いたら applyResultRankProgress が入れる）。
 * 昇格した対局だけは下の startPromotionSequence が動き、
 * 「昇格前のカード → ゲージが伸びきる → 駒が裏返る」を見せてからこの形に着地する。
 */
function renderResultRankCard(info) {
    if (!gameResultRank) return;
    // 前局の演出が残っていると数字が書き換わり続けるので、必ず止めてから描く
    stopPromotionSequence();
    resetPromotionDecorations();

    if (!info || typeof info.delta !== 'number' || typeof info.rating !== 'number') {
        gameResultRank.hidden = true;
        return;
    }
    gameResultRank.hidden = false;

    const promoted = typeof info.promotedTo === 'string' && info.promotedTo ? info.promotedTo : null;
    gameResultRankDelta.textContent = info.delta === 0
        ? '±0'
        : (info.delta > 0 ? '+' : '') + info.delta;
    gameResultRankDelta.className =
        'result-rank-delta ' + (info.delta === 0 ? '' : info.delta > 0 ? 'is-up' : 'is-down');

    // 前局のゲージが残らないよう毎回たたむ
    resetResultRankProgress();

    // 1局で2つ上がることはない（1勝で最大+37点・刻みは100〜150点）ので、
    // 昇格前の段級位は「ひとつ下」で確定する
    const fromRank = promoted && isValidOnlineRank(info.rank - 1) ? info.rank - 1 : null;
    if (fromRank === null || prefersReducedMotion()) {
        applyRankCardResult(info, promoted ? fromRank : null);
        return;
    }
    startPromotionSequence(info, fromRank);
}

/** 段位カードの「最終形」。演出をしないときはこれだけを置く */
function applyRankCardResult(info, fromRank) {
    gameResultRank.classList.toggle('is-promo', fromRank !== null);
    renderRankBadgeInto(gameResultRankBadge, info.rank, 'koma');
    gameResultRankName.textContent = onlineRankLabel(info.rank) || '';
    gameResultRankNote.textContent = fromRank !== null
        ? `${onlineRankLabel(fromRank)}から${promotionWord(info.rank)}しました`
        : 'あなたの段級位';
    gameResultRankRating.textContent = String(info.rating);
}

function resetResultRankProgress() {
    if (!gameResultRankProgress) return;
    gameResultRankProgress.classList.remove('is-ready');
    if (gameResultRankTrack) gameResultRankTrack.classList.remove('is-full');
    setRankFill(0, true);
    gameResultRankNext.textContent = '';
}

/** ゲージの幅。instant のときは伸びる動きを挟まずその場で置き換える */
function setRankFill(pct, instant) {
    if (!gameResultRankFill) return;
    if (instant) {
        gameResultRankFill.style.transition = 'none';
        gameResultRankFill.style.width = `${pct}%`;
        void gameResultRankFill.offsetWidth; // ここで確定させないと transition を戻した瞬間に動いてしまう
        gameResultRankFill.style.transition = '';
        return;
    }
    gameResultRankFill.style.width = `${pct}%`;
}

/** RatingView をゲージに当てる */
function paintRankProgress(view) {
    setRankFill(Math.round(view.progress * 100), false);
    gameResultRankNext.textContent = view.nextLabel
        ? `${view.nextLabel}まで あと${view.pointsToNext}`
        : '最高位';
    gameResultRankProgress.classList.add('is-ready');
}

/**
 * 段位カードのゲージ。/status と COM戦の結果で返る RatingView をそのまま受ける。
 * 対局データには入っていない値なので、届いたときだけ埋める（届かなくても数字は正しい）。
 * 🔴 昇格の演出中に届いたぶんはその場で書かず、台本の最後まで溜めておく
 *    （途中で新しい値が入ると「ゲージが伸びきる」が飛んでしまう）。
 */
function applyResultRankProgress(view) {
    if (!view || typeof view.progress !== 'number') return;
    // 次の対局の「昇格前のゲージ」はこれを使う。対局結果より先にここへ届くことはない
    lastRatingView = view;
    if (promoAnim.active) {
        promoAnim.pendingView = view;
        return;
    }
    // ダイアログを閉じたあとのポーリングで書き込まないよう、出ているときだけ触る
    if (!gameResultRankProgress || gameResultRank.hidden) return;
    if (gameOverDialog.style.display === 'none') return;
    paintRankProgress(view);
}

// --- 昇級・昇段の演出 ---------------------------------------------------
// 仕様は docs/online-rating-spec.md §8。見た目は style.css の「昇級・昇段の演出」。
// 中心は「駒が成る」。段級位バッジをそのまま将棋の駒として裏返す。
// 階級（バッジの色）が変わる昇格だけ、前に全画面のカットインを挟む（生涯4回）。

/** 直近に届いた RatingView。昇格演出の「昇格前のゲージ」に使う */
let lastRatingView = null;

const promoAnim = {
    active: false,      // 演出中。ゲージの書き込みを溜める合図でもある
    timers: [],
    raf: null,
    pendingView: null,  // 演出中に届いたゲージ
    cutIn: null,        // 出しているカットインの要素
    finish: null,       // カットインを飛ばされたときに残りを当てる関数
};

function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 級は「昇級」、段は「昇段」。9級〜1級だけが級 */
function promotionWord(rank) {
    return (onlineRankLabel(rank) || '').slice(-1) === '段' ? '昇段' : '昇級';
}

function promoAt(ms, fn) {
    promoAnim.timers.push(setTimeout(fn, ms));
}

function stopPromotionSequence() {
    promoAnim.timers.forEach(clearTimeout);
    promoAnim.timers = [];
    if (promoAnim.raf !== null) {
        cancelAnimationFrame(promoAnim.raf);
        promoAnim.raf = null;
    }
    promoAnim.active = false;
    promoAnim.pendingView = null;
    promoAnim.finish = null;
    removePromoCutIn();
}

/** 昇格したときだけ出す「もう1局」の文言 */
const PROMOTION_CTA_LABEL = 'この勢いでもう1局';

/** 見出し・シェア・判子など、昇格したときだけ足したものを元に戻す */
function resetPromotionDecorations() {
    const eyebrow = gameOverContent && gameOverContent.querySelector('.game-result-eyebrow');
    if (eyebrow) eyebrow.textContent = '対局結果';
    // 🔴 自分が書き換えたときだけ戻す。AI対戦の「次のレベルへ」を消さないため
    const ctaLabel = newGameButton && newGameButton.querySelector('.new-game-main');
    if (ctaLabel && ctaLabel.textContent === PROMOTION_CTA_LABEL) {
        ctaLabel.textContent = '次のゲームへ';
    }
    if (gameOverContent) gameOverContent.classList.remove('promo-hold');

    const shareButtons = document.querySelector('.share-section .share-buttons');
    if (shareButtons) shareButtons.classList.remove('is-promo');
    const shareNote = document.querySelector('.share-section .share-promo-note');
    if (shareNote) shareNote.remove();

    if (!gameResultRank) return;
    const sweep = gameResultRank.querySelector('.result-rank-sweep');
    if (sweep) sweep.remove();
    const seal = gameResultRank.querySelector('.result-rank-seal');
    if (seal) seal.remove();
}

/** 差し替えた文字が見落とされないよう、下から差し込む動きを付け直す */
function restartSwapIn(element) {
    if (!element) return;
    element.classList.remove('result-swap-in');
    void element.offsetWidth;
    element.classList.add('result-swap-in');
}

/** バッジを2面（表＝昇格前・裏＝昇格後）にして入れる。返り値は裏返す対象 */
function renderRankFlipInto(host, fromRank, toRank) {
    if (!host) return null;
    const front = createRankBadge(fromRank, 'koma');
    const back = createRankBadge(toRank, 'koma');
    if (!front || !back) return null;

    const flip = document.createElement('span');
    flip.className = 'rank-flip';
    const frontFace = document.createElement('span');
    frontFace.className = 'rank-flip-face';
    frontFace.appendChild(front);
    const backFace = document.createElement('span');
    backFace.className = 'rank-flip-face is-back';
    backFace.appendChild(back);
    flip.append(frontFace, backFace);

    host.textContent = '';
    host.hidden = false;
    host.appendChild(flip);
    return flip;
}

function stopRatingCount() {
    if (promoAnim.raf === null) return;
    cancelAnimationFrame(promoAnim.raf);
    promoAnim.raf = null;
}

/** 実力値の数字を回しながら上げる */
function countRatingTo(from, to, ms) {
    let started = null;
    const step = (now) => {
        if (started === null) started = now;
        const k = Math.min(1, (now - started) / ms);
        const eased = 1 - Math.pow(1 - k, 3);
        gameResultRankRating.textContent = String(Math.round(from + (to - from) * eased));
        promoAnim.raf = k < 1 ? requestAnimationFrame(step) : null;
    };
    promoAnim.raf = requestAnimationFrame(step);
}

/** カードを金にして、光を一閃させ、判子を押す */
function markRankCardPromoted() {
    gameResultRank.classList.add('is-promo');
    const sweep = document.createElement('span');
    sweep.className = 'result-rank-sweep';
    sweep.setAttribute('aria-hidden', 'true');
    gameResultRank.appendChild(sweep);
    setTimeout(() => sweep.remove(), 900);
}

function stampRankSeal(rank) {
    const word = promotionWord(rank);
    const seal = document.createElement('span');
    seal.className = 'result-rank-seal';
    seal.setAttribute('aria-hidden', 'true');
    for (const ch of word) {
        const line = document.createElement('i');
        line.style.fontStyle = 'normal';
        line.textContent = ch;
        seal.appendChild(line);
    }
    gameResultRank.appendChild(seal);
}

/** 見出しの主役を勝敗から昇格へ入れ替える。勝ったことは下の行に残す */
function applyPromotionHeadline(info) {
    const state = currentResultDialogState;
    const word = promotionWord(info.rank);
    const eyebrow = gameOverContent && gameOverContent.querySelector('.game-result-eyebrow');
    if (eyebrow) {
        eyebrow.textContent = word;
        restartSwapIn(eyebrow);
    }
    gameResultTitle.textContent = `${onlineRankLabel(info.rank) || ''}に${word}！`;
    restartSwapIn(gameResultTitle);
    renderResultSub([
        state.winner === '引き分け' ? '引き分け' : `${state.winnerLabel}の勝利`,
        state.reason,
        `${state.moveCount}手`,
    ]);
    restartSwapIn(gameResultSub);

    const ctaLabel = newGameButton && newGameButton.querySelector('.new-game-main');
    if (ctaLabel) {
        ctaLabel.textContent = PROMOTION_CTA_LABEL;
        restartSwapIn(ctaLabel);
    }
}

/** 昇格した対局だけシェアを目立たせる。昇段報告はいちばん投稿されやすい */
function highlightPromotionShare(rank) {
    const shareButtons = document.querySelector('.share-section .share-buttons');
    if (!shareButtons) return;
    shareButtons.classList.add('is-promo');
    const section = shareButtons.closest('.share-section');
    if (!section || section.querySelector('.share-promo-note')) return;
    const note = document.createElement('p');
    note.className = 'share-promo-note';
    note.textContent = `${onlineRankLabel(rank) || ''}になったことをシェアする`;
    section.appendChild(note);
}

/** 溜めておいたゲージを当てて演出を終える */
function settlePromotionProgress() {
    promoAnim.active = false;
    const view = promoAnim.pendingView;
    promoAnim.pendingView = null;
    if (!view) {
        // まだ届いていないだけ。届いた時点で applyResultRankProgress が普通に埋める
        resetResultRankProgress();
        return;
    }
    setRankFill(0, true); // 満タンのまま次の値に縮むと逆流して見えるので、一度0に戻す
    paintRankProgress(view);
}

/**
 * 昇格した対局の台本。
 * カードを「昇格前」の姿で出し、ゲージ → 駒 → カードの色 の順に変えていく。
 */
function startPromotionSequence(info, fromRank) {
    const fromRating = info.rating - info.delta;
    const fromProgress = lastRatingView && typeof lastRatingView.progress === 'number'
        ? lastRatingView.progress
        : null; // 控えが無い人（初回・別端末）はゲージが伸びる一手間だけ省く

    // まず昇格前の姿を置く。ここが変わっていくところを見せるのが演出の中身
    gameResultRank.classList.remove('is-promo');
    gameResultRankName.textContent = onlineRankLabel(fromRank) || '';
    gameResultRankNote.textContent = 'あなたの段級位';
    gameResultRankRating.textContent = String(fromRating);
    const flip = renderRankFlipInto(gameResultRankBadge, fromRank, info.rank);
    if (!flip) {
        applyRankCardResult(info, fromRank);
        return;
    }
    promoAnim.active = true;

    const landOnResult = () => {
        stopRatingCount();
        flip.classList.add('is-flipped');
        markRankCardPromoted();
        gameResultRankName.textContent = onlineRankLabel(info.rank) || '';
        gameResultRankNote.textContent =
            `${onlineRankLabel(fromRank)}から${promotionWord(info.rank)}しました`;
        gameResultRankRating.textContent = String(info.rating);
        applyPromotionHeadline(info);
    };

    // 階級（バッジの色）が変わる昇格だけカットインを挟む。生涯4回しか起きない
    if (onlineRankTier(info.rank) !== onlineRankTier(fromRank)) {
        promoAnim.finish = () => {
            landOnResult();
            stampRankSeal(info.rank);
            settlePromotionProgress();
            highlightPromotionShare(info.rank);
        };
        runPromotionCutIn(info, fromRank, landOnResult);
        return;
    }

    if (fromProgress !== null) {
        promoAt(380, () => {
            gameResultRankProgress.classList.add('is-ready');
            setRankFill(Math.round(fromProgress * 100), true);
            gameResultRankNext.textContent = lastRatingView.nextLabel
                ? `${lastRatingView.nextLabel}まで あと${lastRatingView.pointsToNext}`
                : '';
        });
        promoAt(560, () => setRankFill(100, false));
        promoAt(1180, () => {
            if (gameResultRankTrack) gameResultRankTrack.classList.add('is-full');
        });
    }
    promoAt(380, () => countRatingTo(fromRating, info.rating, 620));
    promoAt(1320, () => {
        flip.classList.add('is-flipped');
        markRankCardPromoted();
        applyPromotionHeadline(info);
    });
    promoAt(1600, () => {
        // 数字を回すのを先に止める。裏で走ったままだと、そのあと途中の値で上書きされる
        stopRatingCount();
        gameResultRankName.textContent = onlineRankLabel(info.rank) || '';
        gameResultRankNote.textContent =
            `${onlineRankLabel(fromRank)}から${promotionWord(info.rank)}しました`;
        gameResultRankRating.textContent = String(info.rating);
        stampRankSeal(info.rank);
    });
    promoAt(1900, settlePromotionProgress);
    promoAt(2300, () => highlightPromotionShare(info.rank));
}

/**
 * 全画面のカットイン。要素は必要になったときだけ作り、終わったら消す。
 * 裏の結果ダイアログは promo-hold で登場アニメを止めておき、暗転が明けてから出す。
 */
function runPromotionCutIn(info, fromRank, landOnResult) {
    const layer = document.createElement('div');
    layer.className = 'promo-cutin';
    layer.innerHTML =
        '<div class="promo-cutin-rays"></div>' +
        '<div class="promo-cutin-confetti"></div>' +
        '<div class="promo-cutin-koma"></div>' +
        '<div class="promo-cutin-band"></div>' +
        '<div class="promo-cutin-flash"></div>' +
        '<p class="promo-cutin-skip">タップでスキップ</p>';

    const komaHost = layer.querySelector('.promo-cutin-koma');
    const komaFlip = renderRankFlipInto(komaHost, fromRank, info.rank);
    const band = layer.querySelector('.promo-cutin-band');
    band.textContent = promotionWord(info.rank);
    buildPromoConfetti(layer.querySelector('.promo-cutin-confetti'));
    layer.addEventListener('click', skipPromotionCutIn);

    document.body.appendChild(layer);
    promoAnim.cutIn = layer;
    if (gameOverContent) gameOverContent.classList.add('promo-hold');
    // 🔴 ここを requestAnimationFrame にしないこと。裏に回ったタブでは呼ばれるのが遅れ、
    //    暗転しきらないまま結果が透けて見えてしまう。反映を確定させてからクラスを足す
    void layer.offsetWidth;
    layer.classList.add('is-on');

    promoAt(150, () => komaHost.classList.add('is-on'));
    promoAt(950, () => {
        if (komaFlip) komaFlip.classList.add('is-flipped');
        layer.querySelector('.promo-cutin-flash').classList.add('is-on');
        layer.querySelector('.promo-cutin-rays').classList.add('is-on');
        layer.querySelector('.promo-cutin-confetti').classList.add('is-on');
    });
    promoAt(1400, () => band.classList.add('is-on'));
    // 暗転が完全に効いている最中にカードを差し替える（裏で答えが見えると台無しになる）
    promoAt(1500, landOnResult);
    promoAt(2300, () => layer.classList.remove('is-on'));
    promoAt(2600, () => {
        removePromoCutIn();
        stampRankSeal(info.rank);
    });
    promoAt(2900, settlePromotionProgress);
    promoAt(3500, () => highlightPromotionShare(info.rank));
}

/**
 * 紙吹雪を撒く。1枚を3層（落ちる・横に揺れる・回る）に分け、**全部の値を1枚ずつ乱数で振る**。
 * 🔴 「i番目から計算する」書き方にしないこと。どんな式を使っても周期が揃い、
 *    斜めの筋になって降るのが見えてしまう。
 */
function buildPromoConfetti(host) {
    if (!host) return;
    // 金と和紙の色。朱は差し色なので1色ぶんだけ
    const colors = ['#f0cf82', '#fdf3e0', '#d9a441', '#e8d9b5', '#f0cf82', '#b0392a'];
    const rand = (min, max) => min + Math.random() * (max - min);
    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    for (let i = 0; i < 32; i++) {
        // 落ちる層。上端をばらして、ひと固まりで入ってこないようにする
        const fall = document.createElement('i');
        fall.style.left = `${rand(1, 97).toFixed(1)}%`;
        fall.style.top = `${-rand(20, 130).toFixed(0)}px`;
        fall.style.width = `${rand(4, 9).toFixed(1)}px`;
        fall.style.height = `${rand(8, 15).toFixed(1)}px`;
        // カットインで見えているのは1.35秒ぶんだけ。ゆっくり落とすと上端に溜まって終わる
        fall.style.animationDelay = `${rand(0, 0.3).toFixed(2)}s`;
        fall.style.animationDuration = `${rand(1.1, 2.2).toFixed(2)}s`;

        // 横に揺れる層。負の遅延で開始位置（揺れの位相）をずらす
        const sway = document.createElement('s');
        sway.style.setProperty('--sway', `${rand(6, 30).toFixed(1)}px`);
        sway.style.animationDelay = `${rand(-1.5, 0).toFixed(2)}s`;
        sway.style.animationDuration = `${rand(0.6, 1.5).toFixed(2)}s`;

        // 回る層。軸を斜めにすると、真横を向いた瞬間に紙が消えてちらつく
        const spin = document.createElement('b');
        spin.style.background = pick(colors);
        spin.style.setProperty('--ax', rand(-1, 1).toFixed(2));
        spin.style.setProperty('--ay', rand(-1, 1).toFixed(2));
        spin.style.setProperty('--spin', `${Math.round(rand(360, 1080)) * (Math.random() < 0.5 ? -1 : 1)}deg`);
        spin.style.animationDelay = `${rand(-2, 0).toFixed(2)}s`;
        spin.style.animationDuration = `${rand(0.7, 2).toFixed(2)}s`;

        sway.appendChild(spin);
        fall.appendChild(sway);
        host.appendChild(fall);
    }
}

function removePromoCutIn() {
    if (promoAnim.cutIn) {
        promoAnim.cutIn.remove();
        promoAnim.cutIn = null;
    }
    if (gameOverContent) gameOverContent.classList.remove('promo-hold');
}

/** カットインをタップで飛ばす。残りの台本は一気に当てる */
function skipPromotionCutIn() {
    if (!promoAnim.cutIn || !promoAnim.finish) return;
    promoAnim.timers.forEach(clearTimeout);
    promoAnim.timers = [];
    removePromoCutIn();
    const finish = promoAnim.finish;
    promoAnim.finish = null;
    finish();
}

/**
 * だれかと対戦の実力値欄を出し直す。COM戦は結果をサーバーへ送ってから返事が来るので、
 * online-match.js があとから呼ぶ。view を渡すとゲージまで一度に埋まる。
 */
function renderResultRating(info, view) {
    renderResultBody(info);
    if (view) applyResultRankProgress(view);
}

/** 終局した対局の payload から、自分の側の実力値変動を取り出す */
function onlineRatingResultFor(match, mySide) {
    if (!match || !mySide) return null;
    const delta = mySide === SENTE ? match.sente_rating_delta : match.gote_rating_delta;
    const rating = mySide === SENTE ? match.sente_rating : match.gote_rating;
    if (typeof delta !== 'number' || typeof rating !== 'number') return null;
    return {
        rating,
        delta,
        // 終局時に更新ずみの段級位。昇級していなくてもカードの駒バッジに使う
        rank: mySide === SENTE ? match.sente_rank : match.gote_rank,
        promotedTo: mySide === SENTE ? match.sente_promoted : match.gote_promoted,
    };
}

// ゲーム終了ダイアログの表示
function showGameOverDialog(winner, reason) {
    trackGameEnd(winner, reason);

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
    setGameOverTone(currentResultDialogState.tone);

    // 🔴 勝利数の加算は中身を描くより先に。ストリップの「通算勝利」はこの値を読む
    // AIモードで勝利した場合のみレベル解放を確認
    const isPlayerWin = gameMode === 'ai' && winner === (aiPlayerSide === SENTE ? '先手' : '後手');
    if (winner !== '引き分け' && isPlayerWin) {
        // AI対戦の勝利数（難易度不問）。「だれかと対戦」の解放条件のひとつ
        try {
            localStorage.setItem('shogi_ai_win_count', String(readAiWinCount() + 1));
        } catch (_) { /* ignore */ }
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

    // 前局の値が残らないよう毎回出し直す。COM戦はサーバーの返事を待って
    // online-match.js が renderResultRating を呼び直す
    renderResultBody(
        isOnlineMode() ? onlineRatingResultFor(onlineState.match, onlineState.side) : null,
    );
    resetCopyLinkFeedback();
    renderResultBoardPreview();

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
    stopPromotionSequence();
    resetPromotionDecorations();
    gameOverDialog.style.display = 'none';
    setGameOverTone('tone-draw');
    resetCopyLinkFeedback();
    resetResultBoardPreview();
    currentResultDialogState = createEmptyResultDialogState();
}

// SNSシェア機能。共有先は棋譜付きURL、作れないときだけ今見ているページのURLに落とす
function shareOnTwitter() {
    const kifuUrl = buildResultShareUrl();
    const shareUrl = new URL('https://twitter.com/intent/tweet');
    // 🔴 棋譜URLは url パラメータに渡さず本文に入れる。url に渡すと X 側の連結のされ方次第で
    // 「▼ 棋譜はこちら」と離れてしまう。カードは本文中のURLからも出る
    shareUrl.searchParams.set('text', buildResultShareText({ kifuUrl, embedUrl: true }));
    if (!kifuUrl) shareUrl.searchParams.set('url', window.location.href);
    openShareWindow(shareUrl.toString());
}

function shareOnFacebook() {
    const shareUrl = new URL('https://www.facebook.com/sharer/sharer.php');
    // Facebookは本文のパラメータを無視するのでURLだけ渡す
    shareUrl.searchParams.set('u', buildResultShareUrl() || window.location.href);
    openShareWindow(shareUrl.toString());
}

function shareOnLine() {
    const kifuUrl = buildResultShareUrl();
    const shareUrl = new URL('https://social-plugins.line.me/lineit/share');
    shareUrl.searchParams.set('url', kifuUrl || window.location.href);
    // URLはLINEが本文の後ろに付けるので、本文には入れない
    shareUrl.searchParams.set('text', buildResultShareText({ kifuUrl, hashtag: false }));
    openShareWindow(shareUrl.toString());
}

function copyLink() {
    const url = buildResultShareUrl() || window.location.href;
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
closeGameOverButton.addEventListener('click', () => {
    hideGameOverDialog();
    openKifuBar();
});
shareTwitterButton.addEventListener('click', () => {
    track('share', { method: 'x', content: 'result', mode: gameMode });
    shareOnTwitter();
});
shareFacebookButton.addEventListener('click', () => {
    track('share', { method: 'facebook', content: 'result', mode: gameMode });
    shareOnFacebook();
});
shareLineButton.addEventListener('click', () => {
    track('share', { method: 'line', content: 'result', mode: gameMode });
    shareOnLine();
});
copyLinkButton.addEventListener('click', () => {
    track('share', { method: 'copy', content: 'result', mode: gameMode });
    copyLink();
});

// ===================== 棋譜（表示・共有・書き出し・読み込み） =====================
// 表記変換・URL・KIF・局面の再生は src/kifu/*.ts にあり、build.sh がこのファイルの
// 後ろに束ねて連結する（グローバル KifuCore）。ここは画面と対局状態のつなぎだけ。
// 仕様は docs/kifu-spec.md。

const kifuBarElement = document.getElementById('kifu-bar');
const kifuBarHeadElement = document.getElementById('kifu-bar-head');
const kifuBarBodyElement = document.getElementById('kifu-bar-body');
const kifuBarCountWrapElement = document.getElementById('kifu-bar-count-wrap');
const kifuBarCountElement = document.getElementById('kifu-bar-count');
const kifuBarMoveElement = document.getElementById('kifu-bar-move');
const kifuBarNextElement = document.getElementById('kifu-bar-next');
const kifuBarTurnLabelElement = document.getElementById('kifu-bar-turn-label');
const kifuListElement = document.getElementById('kifu-list');
const kifuActionsElement = document.getElementById('kifu-actions');
const kifuShareSheetElement = document.getElementById('kifu-share-sheet');
const kifuShareUrlElement = document.getElementById('kifu-share-url');
const kifuViewHeadElement = document.getElementById('kifu-shared-head');
const kifuViewTitleElement = document.getElementById('kifu-shared-title');
const kifuViewSubElement = document.getElementById('kifu-shared-sub');
const kifuViewSetupButton = document.getElementById('kifu-view-setup');
const kifuRestartViewButton = document.getElementById('kifu-restart-view');
const kifuImportModal = document.getElementById('kifu-import-modal');
const kifuImportTextElement = document.getElementById('kifu-import-text');
const kifuImportDetectElement = document.getElementById('kifu-import-detect');
const kifuImportApplyButton = document.getElementById('kifu-import-apply');
const kifuBranchModal = document.getElementById('kifu-branch-modal');
const kifuBranchTitleElement = document.getElementById('kifu-branch-title');
const kifuBranchSideRow = document.getElementById('kifu-branch-side-row');
const kifuBranchFoeRow = document.getElementById('kifu-branch-foe-row');
const kifuBranchFoeAiButton = document.getElementById('kifu-branch-foe-ai');
const kifuBranchLevelRow = document.getElementById('kifu-branch-level-row');
const kifuBranchLevelsElement = document.getElementById('kifu-branch-levels');
const kifuBranchStartButton = document.getElementById('kifu-branch-start');

let kifuBarOpen = false;
// 表記（一覧・バー）と保存（設計書 §12 の新形式）が同じ再生結果を使い回す。
// 手順が変わったときだけ並べ直すので、1手につき1回で済む
let kifuReplayCache = { key: null, replay: null, entries: [] };
let kifuListRenderedFor = null;
let kifuImportParsed = null;
let kifuBranchChoice = { side: SENTE, foe: 'ai', difficulty: null };
let kifuCopyFeedbackTimer = null;

/** ビルド前の素の shogi.js でも壊れないようにしておく（連結されていれば必ずある） */
function kifuCoreAvailable() {
    return typeof KifuCore !== 'undefined' && KifuCore !== null;
}

/** ローカル対局（COMフォールバック・チュートリアル）の最中か。
 *  /online/ のCOM戦も gameMode は 'online' のままなので、isOnlineMode() では見分けられない */
function isLocalOnlineMatch() {
    return matchmakingBridge.matchKind?.() === 'bot';
}

/**
 * この対局の全手数（いま見ている局面より後ろも含む）。
 * 🔴 相手が人間の通信対戦だけはサーバーが確定した指し手を使う。盤をサーバーの状態で
 * 置き換えるだけなので、手元の usiMoveHistory も moveHistory も育たない。
 * 🔴 逆に /online/ のCOM戦は finalizeMove を通るので手元に揃い、
 * onlineState.usiMoves のほうが空のまま残る（そちらを見ると棋譜がまるごと消える）。
 */
function kifuAllMoves() {
    if (isLocalOnlineMatch()) return usiMoveHistory.slice(0, Math.max(moveHistory.length - 1, 0));
    if (isOnlineMode()) return onlineState.usiMoves;
    return usiMoveHistory.slice(0, Math.max(moveHistory.length - 1, 0));
}

function kifuTotalPlies() {
    if (isLocalOnlineMatch()) return Math.max(moveHistory.length - 1, 0);
    if (isOnlineMode()) return onlineState.usiMoves.length;
    return Math.max(moveHistory.length - 1, 0);
}

/** いま盤に出ている手数。通信対戦は過去に戻れないので、つねに最新手 */
function kifuCurrentPly() {
    if (isOnlineMode()) return kifuTotalPlies();
    return Math.max(currentHistoryIndex, 0);
}

/** 棋譜バーを出すモードか（詰将棋は第1弾では出さない。設計書 §5） */
function kifuBarEnabled() {
    return Boolean(kifuBarElement) && gameMode !== TSUME_MODE && kifuCoreAvailable();
}

/** 一覧の行から局面へ飛べるか。通信対戦は表示のみ（対局中に戻れてはいけない） */
function canJumpInKifu() {
    return !isOnlineMode();
}

/** 棋譜を盤に載せ替えてよいモードか。通信対戦・詰将棋の盤は自分のものではない */
function canImportKifu() {
    return !isOnlineMode() && gameMode !== TSUME_MODE;
}

function kifuReplayCached() {
    const moves = kifuAllMoves();
    const key = moves.join('|');
    if (kifuReplayCache.key !== key) {
        let replay = null;
        let entries = [];
        try {
            // 前回の結果を渡すと、共通の頭の部分は並べ直さずに続きだけ足してくれる。
            // 1手指すたびに全手数を並べ直すと、終盤ほど指したときの反応が鈍る
            replay = KifuCore.replayUsiMoves(moves, kifuReplayCache.replay || undefined);
            entries = KifuCore.buildNotation(moves, replay, kifuReplayCache.entries);
        } catch (error) {
            console.error('棋譜を並べ直せませんでした:', error);
        }
        kifuReplayCache = { key, replay, entries };
    }
    return kifuReplayCache;
}

function kifuNotationEntries() {
    return kifuReplayCached().entries;
}

/**
 * 指し手の並びだけで保存してよいか（設計書 §12 の新形式 v2）。
 * 🔴 読み戻せない形では保存しない。ルールの食い違いや壊れたデータで
 * 遊びかけの対局が消えるのを防ぐ保険で、そのときは旧形式のまま保存する。
 */
function canSaveMovesOnly() {
    if (!kifuCoreAvailable() || isOnlineMode() || gameMode === TSUME_MODE) return false;
    const replay = kifuReplayCached().replay;
    if (!replay || !replay.ok) return false;
    if (replay.states.length !== moveHistory.length) return false;
    // 千日手判定に使うハッシュまで一致していること（ここがずれると
    // 再読み込みで千日手の判定が変わる、という一番たちの悪い壊れ方をする）
    return replay.positionHistory[replay.positionHistory.length - 1]
        === positionHistory[positionHistory.length - 1];
}

/** localStorage に書く中身。v2 は120手で約700バイト（旧形式は234KB） */
function buildSavedGameState() {
    if (canSaveMovesOnly()) {
        return { v: 2, mode: gameMode, moves: kifuAllMoves(), at: currentHistoryIndex };
    }
    return {
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
}

/** 再生結果を対局の履歴として載せ替える */
function applyReplayToHistory(replay) {
    moveHistory = replay.states.map(state => ({
        board: state.board,
        capturedPieces: state.capturedPieces,
        currentPlayer: state.currentPlayer,
        lastMove: state.lastMove,
        moveCount: state.moveCount,
        gameOver: state.gameOver,
        isCheck: state.isCheck
    }));
    positionHistory = replay.positionHistory;
    checkHistory = replay.checkHistory;
    usiMoveHistory = replay.usiMoves;
    currentHistoryIndex = moveHistory.length - 1;
    kifuReplayCache = { key: null, replay: null, entries: [] };
}

/** v2 の保存データから盤を組み直す。できなければ false（新規対局に落とす） */
function restoreSavedMoves(saved) {
    if (!kifuCoreAvailable()) return false;
    const moves = Array.isArray(saved.moves) ? saved.moves : [];
    let replay;
    try {
        replay = KifuCore.replayUsiMoves(moves);
    } catch (error) {
        console.error('保存された棋譜を並べ直せませんでした:', error);
        return false;
    }
    if (!replay.ok) return false;

    applyReplayToHistory(replay);
    const at = Number(saved.at);
    currentHistoryIndex = Number.isFinite(at)
        ? Math.min(Math.max(at, 0), moveHistory.length - 1)
        : moveHistory.length - 1;

    const state = moveHistory[currentHistoryIndex];
    board = deepCopyBoard(state.board);
    capturedPieces = deepCopyCaptured(state.capturedPieces);
    recomputeKingPosCache();
    currentPlayer = state.currentPlayer;
    lastMove = state.lastMove ? { ...state.lastMove } : null;
    moveCount = state.moveCount;
    gameOver = state.gameOver ?? false;
    isCheck = state.isCheck ?? false;
    return true;
}

/**
 * 棋譜バーに出す手番の呼び方。
 * 「先手」とだけ出しても、それが自分なのか相手なのかは分からない
 * （AI対戦は後手を選べるし、通信対戦では相手が先手のこともある）。
 * 自分の担当する側が決まっているモードでは「あなた」「AI」「相手」で出す。
 * 1台を2人で使う将棋盤モードと、他人の共有棋譜を眺めているときは先手／後手のまま。
 */
function kifuBarTurnLabel() {
    const sideLabel = currentPlayer === SENTE ? '先手' : '後手';
    if (isViewingSharedKifu) return sideLabel;
    if (isOnlineMode()) {
        // 席が決まる前（ロビー・入室待ち）は先後で出すしかない
        if (onlineState.side !== SENTE && onlineState.side !== GOTE) return sideLabel;
        return currentPlayer === onlineState.side ? 'あなた' : '相手';
    }
    if (gameMode === 'ai') {
        return currentPlayer === aiPlayerSide ? 'あなた' : 'AI';
    }
    return sideLabel;
}

function renderKifuBar() {
    if (!kifuBarEnabled()) return;
    const entries = kifuNotationEntries();
    const shown = kifuCurrentPly();

    if (shown <= 0) {
        // 開始局面のときは「0手目:」ではなく「開始局面」とだけ出す（設計書 §4）
        kifuBarCountWrapElement.hidden = true;
        kifuBarMoveElement.textContent = '開始局面';
    } else {
        kifuBarCountWrapElement.hidden = false;
        kifuBarCountElement.textContent = String(shown);
        const entry = entries[shown - 1];
        kifuBarMoveElement.textContent = entry ? KifuCore.compactNotation(entry.text) : '';
    }
    // 終局後に「手番：あなた」と出したままだと「まだ指せる」と読めてしまう。
    // 終わったことだけを出す（＜＞で途中の局面に戻れば gameOver は false に戻る）
    if (kifuBarTurnLabelElement) kifuBarTurnLabelElement.hidden = gameOver;
    kifuBarNextElement.textContent = gameOver ? '対局終了' : kifuBarTurnLabel();

    if (kifuBarOpen) renderKifuList(entries);
    updateKifuActions();
    updateKifuViewHead();
}

/**
 * 棋譜バーの下のボタン（共有・出力／読み込み）の出し分け。
 * まだ1手も指していない開始局面では共有できる棋譜がないので、共有・出力は出さない
 * （押しても中身のないURLになるだけ）。並べる列数も残ったボタンに合わせる。
 */
function updateKifuActions() {
    if (!kifuActionsElement) return;
    const hasKifu = kifuTotalPlies() > 0;
    kifuActionsElement.classList.toggle('is-no-share', !hasKifu);
    // 通信対戦は読み込みを CSS で消しているので、共有まで消えると枠だけが残る
    kifuActionsElement.classList.toggle('is-empty', !hasKifu && !canImportKifu());
}

function renderKifuList(entries) {
    if (!kifuListElement) return;
    if (kifuListRenderedFor !== entries) {
        const fragment = document.createDocumentFragment();
        // まだ1手も指していない開始局面は、空の枠だけが残って壊れて見えるので一言出す。
        // 手が並んでいないあいだは一覧（role="list"）ではないので role も外す
        if (entries.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'kempty';
            empty.textContent = 'まだ棋譜がありません';
            fragment.appendChild(empty);
            kifuListElement.removeAttribute('role');
        } else {
            kifuListElement.setAttribute('role', 'list');
        }
        entries.forEach(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'kmove';
            button.dataset.ply = String(entry.ply);
            const number = document.createElement('span');
            number.className = 'kmove-n';
            number.textContent = String(entry.ply);
            const text = document.createElement('span');
            text.textContent = entry.text;
            button.appendChild(number);
            button.appendChild(text);
            fragment.appendChild(button);
        });
        kifuListElement.replaceChildren(fragment);
        kifuListRenderedFor = entries;
    }
    kifuListElement.classList.toggle('is-readonly', !canJumpInKifu());
    highlightKifuList();
}

function highlightKifuList() {
    if (!kifuListElement) return;
    const current = kifuCurrentPly();
    for (const button of kifuListElement.children) {
        button.classList.toggle('is-current', Number(button.dataset.ply) === current);
    }
}

function scrollKifuListToCurrent() {
    if (!kifuListElement) return;
    const current = kifuListElement.querySelector('.kmove.is-current');
    if (!current) return;
    const listRect = kifuListElement.getBoundingClientRect();
    const rect = current.getBoundingClientRect();
    kifuListElement.scrollTop +=
        (rect.top - listRect.top) - (kifuListElement.clientHeight - rect.height) / 2;
}

function setKifuBarOpen(open) {
    if (!kifuBarEnabled()) return;
    kifuBarOpen = open;
    kifuBarElement.classList.toggle('is-open', open);
    kifuBarBodyElement.hidden = !open;
    kifuBarHeadElement.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        closeKifuShareSheet();
        renderKifuBar();
        // 開いたときは、いま見ている手が見える位置まで送る
        requestAnimationFrame(scrollKifuListToCurrent);
    }
}

function openKifuBar() {
    setKifuBarOpen(true);
}

function jumpToKifuPly(ply) {
    if (!Number.isFinite(ply) || ply < 0 || ply >= moveHistory.length) return;
    restoreState(ply);
    if (gameMode === TSUME_MODE) tsumeBridge.syncFromHistory();
}

/**
 * 通知バーの副題を、いま見ている局面に合わせて書き換える。
 * 「駒を動かせば指せる」ことをここで教えるのが要点（ボタンを押さなくても始められるため）。
 */
function updateKifuViewHead() {
    if (!isSharedKifuLink || !kifuViewSubElement) return;
    const total = kifuTotalPlies();
    const finished = Boolean(moveHistory[currentHistoryIndex] && moveHistory[currentHistoryIndex].gameOver);
    const from = Math.max(currentHistoryIndex, 0);
    const where = from === 0 ? '開始局面' : `${from}手目`;
    // 終局した局面では指せないので、戻れば指せることを伝える
    kifuViewSubElement.textContent = finished
        ? `${total}手・${where}（終局）。戻ればその局面から指せます`
        : `${total}手・駒を動かすと${where}から指せます`;
}

// ---- 共有 ----

/** 共有先はいつも AI対戦ページ（/）。新しいページは作らない（設計書 §6） */
function buildKifuUrl(encoded, moveIndex) {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('k', encoded);
    url.searchParams.set('m', String(Math.max(moveIndex, 0)));
    return url.toString();
}

function buildKifuShareUrl() {
    const encoded = KifuCore.encodeKifuParam(kifuAllMoves());
    if (encoded === null) return null;
    // 共有シートは「いま見ている局面」で開く（設計書 §6）。対局後の共有（buildResultShareUrl）が
    // 最終手を入れるのと違うのはこのため
    return buildKifuUrl(encoded, kifuCurrentPly());
}

function openKifuShareSheet() {
    const url = buildKifuShareUrl();
    if (!url) {
        showKifuToast('この棋譜は共有できませんでした。');
        return;
    }
    kifuShareUrlElement.textContent = url.replace(/^https?:\/\//, '');
    kifuShareUrlElement.dataset.url = url;
    setKifuBarOpen(false);
    kifuShareSheetElement.hidden = false;
}

function closeKifuShareSheet() {
    if (kifuShareSheetElement) kifuShareSheetElement.hidden = true;
}

function flashKifuButtonLabel(labelElement, message) {
    if (!labelElement) return;
    if (kifuCopyFeedbackTimer) clearTimeout(kifuCopyFeedbackTimer);
    const original = labelElement.dataset.label || labelElement.textContent;
    labelElement.dataset.label = original;
    labelElement.textContent = message;
    kifuCopyFeedbackTimer = setTimeout(() => {
        labelElement.textContent = original;
        kifuCopyFeedbackTimer = null;
    }, 1800);
}

async function copyKifuText(text, labelElement) {
    try {
        await navigator.clipboard.writeText(text);
        flashKifuButtonLabel(labelElement, 'コピーしました');
    } catch (error) {
        console.error('コピーに失敗しました:', error);
        showKifuToast('コピーできませんでした。長押しで選択してコピーしてください。');
    }
}

/** KIF に書く対局者名。AI対戦は難易度まで入れる（設計書 §8） */
function kifuPlayerNames() {
    if (gameMode === 'ai') {
        const label = `将棋Web（${getDifficultyLabel(aiDifficulty)}）`;
        return aiPlayerSide === SENTE
            ? { sente: 'あなた', gote: label }
            : { sente: label, gote: 'あなた' };
    }
    return { sente: '先手', gote: '後手' };
}

function buildKifText() {
    const names = kifuPlayerNames();
    return KifuCore.formatKif(kifuAllMoves(), {
        senteName: names.sente,
        goteName: names.gote,
        date: new Date(),
    });
}

function downloadKifFile() {
    // KIF は Shift_JIS が慣例だが、ブラウザだけで変換できないので UTF-8 で出す
    // （最近の棋譜ソフトは UTF-8 も読める）
    const now = new Date();
    const stamp =
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const blob = new Blob([buildKifText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `shogi-${stamp}.kif`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shareKifuTo(service) {
    const url = kifuShareUrlElement?.dataset.url;
    if (!url) return;
    // 「▼ 棋譜はこちら」と重ならないよう、見出しは「棋譜」ではなく「指した将棋」にする
    const head = `将棋Webで指した将棋（${kifuTotalPlies()}手）`;
    if (service === 'x') {
        const share = new URL('https://twitter.com/intent/tweet');
        // 対局後の共有と同じ理由でURLは本文に入れる（buildResultShareText のコメント参照）
        share.searchParams.set('text', `${head}\n\n▼ 棋譜はこちら\n${url}\n\n#将棋Web`);
        openShareWindow(share.toString());
        return;
    }
    const share = new URL('https://social-plugins.line.me/lineit/share');
    share.searchParams.set('url', url);
    share.searchParams.set('text', `${head}\n\n▼ 棋譜はこちら`);
    openShareWindow(share.toString());
}

// ---- 読み込み ----

function openKifuImportModal() {
    if (!kifuImportModal) return;
    // 🔴 通信対戦の盤はサーバーが持っている。ここで別の棋譜を載せると、相手が次に指すまで
    // 手元だけ違う局面になる。読み込みは自分の対局（AI対戦・将棋盤）だけ
    if (!canImportKifu()) return;
    kifuImportParsed = null;
    kifuImportTextElement.value = '';
    kifuImportDetectElement.hidden = true;
    kifuImportDetectElement.classList.remove('is-error');
    kifuImportApplyButton.disabled = true;
    openFriendModal(kifuImportModal);
    kifuImportTextElement.focus();
}

/** 貼られた瞬間に形式と手数を出す。🔴 読めないときは必ず理由を出す（設計書 §9） */
function handleKifuImportInput() {
    const text = kifuImportTextElement.value;
    if (text.trim() === '') {
        kifuImportParsed = null;
        kifuImportDetectElement.hidden = true;
        kifuImportApplyButton.disabled = true;
        return;
    }
    const parsed = KifuCore.parseKifuText(text);
    kifuImportParsed = parsed.ok ? parsed : null;
    kifuImportDetectElement.hidden = false;
    kifuImportDetectElement.textContent = KifuCore.describeParsed(parsed);
    kifuImportDetectElement.classList.toggle('is-error', !parsed.ok);
    kifuImportApplyButton.disabled = !parsed.ok;
}

function applyKifuImport() {
    if (!kifuImportParsed) return;
    const moves = kifuImportParsed.moves;
    closeFriendModals();
    // 別の棋譜に入れ替わるので、共有リンクの見出しとURLは片付ける
    exitKifuView();
    stripKifuParamsFromUrl();
    // 読み込んだら棋譜を表示するだけ。対局は始めない（設計書 §9）。
    // 遊びかけの対局は上書きしないので、読み込みをやめても消えない
    enterKifuView(moves.length, '読み込まれた棋譜');
    loadKifuIntoBoard(moves, moves.length);
    showKifuToast(`${moves.length}手の棋譜を読み込みました。駒を動かすとその局面から指し継げます。`);
}

// ---- 手順を盤に載せる ----

/**
 * 手順を頭から並べ直して、指定の手数の局面を表示する。対局は始めない。
 * 失敗したら false（呼び出し側が案内に落とす）。
 */
function loadKifuIntoBoard(moves, showIndex) {
    isViewingSharedKifu = true;
    initializeBoard(); // 平手に戻す。AIは isViewingSharedKifu のガードで動かない

    let replay;
    try {
        replay = KifuCore.replayUsiMoves(moves);
    } catch (error) {
        console.error('棋譜を並べ直せませんでした:', error);
        return false;
    }
    applyReplayToHistory(replay);
    restoreState(Math.min(Math.max(showIndex, 0), moveHistory.length - 1));
    openKifuBar();
    return replay.ok;
}

// ---- この局面から指す（設計書 §11） ----

const KIFU_BRANCH_CHIP_ATTRIBUTES = { side: 'branchSide', foe: 'branchFoe' };

function setKifuBranchChoice(key, value) {
    kifuBranchChoice[key] = value;
    const attribute = KIFU_BRANCH_CHIP_ATTRIBUTES[key];
    if (!attribute) return;
    const selector = key === 'side' ? '[data-branch-side]' : '[data-branch-foe]';
    kifuBranchModal.querySelectorAll(selector).forEach(chip => {
        chip.classList.toggle('is-on', chip.dataset[attribute] === value);
    });
    if (key === 'foe') syncKifuBranchRows();
}

/** 相手がAIのときだけ「強さ」を選ばせる。自分で両方なら選ぶものが無い */
function syncKifuBranchRows() {
    if (kifuBranchLevelRow) kifuBranchLevelRow.hidden = kifuBranchChoice.foe !== 'ai';
    // 将棋盤モードで「自分で両方」を選んでいる間は、手番を決める意味がない
    if (kifuBranchSideRow) kifuBranchSideRow.hidden = kifuBranchChoice.foe !== 'ai';
}

/**
 * 「強さ」の選択肢を作る。解放済みのレベルだけを出す（＝いまAI対戦で選べる強さ）。
 * 🔴 既存の難易度モーダルは選んだ瞬間に対局を消して初期化するので、そちらの経路は使わない。
 */
function renderKifuBranchLevels() {
    if (!kifuBranchLevelsElement) return;
    kifuBranchLevelsElement.textContent = '';
    const unlockedLevels = getUnlockedLevels();
    DIFFICULTY_LEVELS.forEach(def => {
        if (!isLevelUnlocked(def.value, unlockedLevels)) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.branchLevel = def.value;
        chip.textContent = def.label;
        chip.classList.toggle('is-on', def.value === kifuBranchChoice.difficulty);
        chip.setAttribute('aria-pressed', def.value === kifuBranchChoice.difficulty ? 'true' : 'false');
        kifuBranchLevelsElement.appendChild(chip);
    });
}

function setKifuBranchLevel(value) {
    if (!isValidDifficulty(value) || !isLevelUnlocked(value)) return;
    kifuBranchChoice.difficulty = value;
    renderKifuBranchLevels();
}

function openKifuBranchModal() {
    if (!kifuBranchModal) return;
    const from = Math.max(currentHistoryIndex, 0);
    kifuBranchTitleElement.textContent = from === 0 ? '開始局面から指す' : `${from}手目から指す`;
    kifuBranchFoeAiButton.textContent = 'AIと対戦';
    if (kifuBranchStartButton) {
        kifuBranchStartButton.textContent = from === 0 ? '開始局面から指す' : `${from}手目から指す`;
    }
    kifuBranchChoice.difficulty = aiDifficulty;
    setKifuBranchChoice('side', aiPlayerSide);
    // 将棋盤モードの既定は「自分で両方」。そのページに居る＝両方指すつもりで来ているため
    setKifuBranchChoice('foe', gameMode === 'pvp' ? 'self' : 'ai');
    renderKifuBranchLevels();
    openFriendModal(kifuBranchModal);
}

/** 🔴 その場で履歴を切る。切らないと scheduleAIMoveIfNeeded のガードでAIが指し始めない */
function truncateHistoryToCurrent() {
    moveHistory = moveHistory.slice(0, currentHistoryIndex + 1);
    positionHistory = positionHistory.slice(0, currentHistoryIndex + 1);
    checkHistory = checkHistory.slice(0, currentHistoryIndex + 1);
    usiMoveHistory = usiMoveHistory.slice(0, currentHistoryIndex);
    kifuReplayCache = { key: null, replay: null, entries: [] };
}

/** 🔴 ?k= と &m= を落とす。残すとリロードで棋譜表示に戻り、指した手が消えたように見える */
function stripKifuParamsFromUrl() {
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has('k') && !url.searchParams.has('m') && !url.searchParams.has('start')) return;
        url.searchParams.delete('k');
        url.searchParams.delete('m');
        url.searchParams.delete('start');
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (error) {
        console.error('URLの整理に失敗しました:', error);
    }
}

/**
 * 別のページで指し継ぐときの受け渡し。好みは localStorage 経由で伝わるので、
 * URLには手順（k）と手数（m）と「閲覧ではなく対局」の印（start=1）だけ載せる。
 */
function jumpToOtherModeAndPlay(path) {
    const encoded = KifuCore.encodeKifuParam(usiMoveHistory.slice(0, currentHistoryIndex));
    if (encoded === null) {
        showKifuToast('この局面から指し始められませんでした。');
        return false;
    }
    // 移動先で読み直されるので、選んだ手番と強さは先に保存しておく
    saveToLocalStorage();
    window.location.href = `${path}?k=${encoded}&m=${currentHistoryIndex}&start=1`;
    return true;
}

function startPlayingFromCurrentPosition() {
    const wantsAi = kifuBranchChoice.foe === 'ai';
    if (wantsAi && isValidDifficulty(kifuBranchChoice.difficulty)) {
        // 🔴 難易度モーダル側のハンドラは対局を消して初期化するので、ここでは直接入れる
        aiDifficulty = kifuBranchChoice.difficulty;
        renderDifficultyUi();
    }
    if (wantsAi) {
        aiPlayerSide = kifuBranchChoice.side;
        updateAiPlayerSideRadios(aiPlayerSide);
    }

    // 「自分で両方」は将棋盤モードそのもの、AI対戦はAI対戦ページそのものなので、
    // 足りないほうのページへ移す（設計書 §11）
    if (gameMode === 'ai' && !wantsAi) {
        jumpToOtherModeAndPlay('/board/');
        return;
    }
    if (gameMode === 'pvp' && wantsAi) {
        jumpToOtherModeAndPlay('/');
        return;
    }

    closeFriendModals();
    truncateHistoryToCurrent();
    isViewingSharedKifu = false;
    exitKifuView();

    applyBoardOrientation();
    stripKifuParamsFromUrl();

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();
    saveToLocalStorage();
    scheduleAIMoveIfNeeded();
    setKifuBarOpen(false);
}

/**
 * 棋譜を見ている途中で駒を動かしたときに、その1手で対局へ切り替える。
 * ボタンを押さなくても指し継げるのが既定の動き（設計書 §11）。
 * @returns {string} 画面に出す案内の文。呼び出し側が clearMoveHint() より後で出す
 */
function beginPlayFromKifu(side) {
    const from = Math.max(currentHistoryIndex, 0);
    gameStartedFrom = 'kifu'; // 途中局面から指し継ぐので initializeBoard を通らない
    isViewingSharedKifu = false;
    exitKifuView();
    stripKifuParamsFromUrl();

    // AI対戦では、動かした側が「あなた」になる。盤も自分側が手前に回る
    const playingAsAi = gameMode === 'ai';
    if (playingAsAi) {
        aiPlayerSide = side;
        updateAiPlayerSideRadios(aiPlayerSide);
    }
    applyBoardOrientation();

    setKifuBarOpen(false);

    // 盤が回る理由を添えておかないと事故に見える
    const where = from === 0 ? '開始局面' : `${from}手目`;
    const who = playingAsAi
        ? `（あなた：${side === SENTE ? '先手' : '後手'}／AI：${getDifficultyLabel(aiDifficulty)}）`
        : '';
    return `${where}から対局を始めました${who}`;
}

// ---- 棋譜を見ている画面（共有リンク・読み込みの両方。設計書 §6） ----

/** @param {string} title 「共有された棋譜」または「読み込まれた棋譜」 */
function enterKifuView(totalMoves, title) {
    isSharedKifuLink = true;
    document.body.classList.add('kifu-shared');
    if (kifuViewHeadElement) kifuViewHeadElement.hidden = false;
    if (kifuViewTitleElement) kifuViewTitleElement.textContent = title;
    // k に入っているのは指し手だけ。難易度や日付は分からないので手数だけ出す
    if (kifuViewSubElement) kifuViewSubElement.textContent = `${totalMoves}手`;
    if (kifuRestartViewButton) kifuRestartViewButton.style.display = 'inline-block';
    applyBoardOrientation();
}

function exitKifuView() {
    // 🔴 早期returnを入れないこと。読めない k= で開いたときは、描画前に付けた
    // body.kifu-shared（モードタブ・難易度・新規対局を隠す）だけが残っていて
    // isSharedKifuLink は false のまま。そこで抜けると操作できない画面が残る
    isSharedKifuLink = false;
    document.body.classList.remove('kifu-shared');
    if (kifuViewHeadElement) kifuViewHeadElement.hidden = true;
    if (kifuRestartViewButton) kifuRestartViewButton.style.display = 'none';
}

/** 盤に重ねる案内を、理由の説明として出す（4秒で引っ込む既存の仕組みを使う） */
function showKifuToast(message) {
    setMoveHint({ text: message, attackers: [], kingPos: null }, null, { force: true });
}

const OPPONENT_TURN_NOTICE = 'ここは相手の手番です。＜ ＞ で自分の手番の局面に移ると指せます';

/**
 * 🔴 過去の局面に戻っていて、そこが相手の手番か。
 * この局面では自分もAIも指せないので、何も言わないと「AIが動かない」に見える。
 * 最新局面でAIが考えている最中は該当しない（そこは「思考中」表示の担当）。
 */
function isStuckOnOpponentTurn() {
    if (gameMode !== 'ai' || isOnlineMode() || gameOver || isViewingSharedKifu) return false;
    if (currentHistoryIndex >= moveHistory.length - 1) return false;
    return currentPlayer !== aiPlayerSide;
}

/**
 * 上の局面に着いたときの案内。＜＞・棋譜一覧で着地した時点と、駒に触れた時点の両方で出す。
 * 詳細設定の「動かせない理由の案内」がOFFでも出す（親切な案内ではなく理由の説明のため。設計書 §10）。
 */
function noticeOpponentTurnIfStuck() {
    if (!isStuckOnOpponentTurn()) return;
    showKifuToast(OPPONENT_TURN_NOTICE);
}

/** /?k=… で開いたときの起動。読めなければ、ふつうの対局画面に落とす（設計書 §6） */
function bootSharedKifu(params) {
    const startImmediately = params.get('start') === '1';
    const moves = KifuCore.decodeKifuParam(params.get('k'));

    loadPreferencesOnlyFromLocalStorage();

    if (!moves) {
        exitKifuView();
        isViewingSharedKifu = false;
        stripKifuParamsFromUrl();
        if (!loadFromLocalStorage()) initializeBoard();
        showKifuToast('棋譜を読み取れませんでした。リンクが途中で切れている可能性があります。');
        return;
    }

    const showIndex = KifuCore.clampMoveIndex(params.get('m'), moves.length);
    // 盤の向きを先手側に固定してから並べる（初期化の途中で上下が入れ替わらないように）
    if (!startImmediately) enterKifuView(moves.length, '共有された棋譜');
    loadKifuIntoBoard(moves, showIndex);

    if (startImmediately) {
        // 別のモードの「この局面から指す」から移ってきた場合。そのまま対局として続ける。
        // 手番と強さは移る前に保存されているので、読み込んだ好みをそのまま使う
        kifuBranchChoice = {
            side: aiPlayerSide,
            foe: gameMode === 'ai' ? 'ai' : 'self',
            difficulty: aiDifficulty,
        };
        startPlayingFromCurrentPosition();
    }
}

// ---- 画面のつなぎ ----

if (kifuBarHeadElement) {
    kifuBarHeadElement.addEventListener('click', () => {
        if (!kifuBarOpen && !kifuShareSheetElement.hidden) {
            closeKifuShareSheet();
        }
        setKifuBarOpen(!kifuBarOpen);
    });
}

if (kifuListElement) {
    kifuListElement.addEventListener('click', (event) => {
        const button = event.target.closest('.kmove');
        if (!button || !canJumpInKifu()) return;
        jumpToKifuPly(Number(button.dataset.ply));
    });
}

document.getElementById('kifu-action-share')?.addEventListener('click', openKifuShareSheet);
document.getElementById('kifu-action-import')?.addEventListener('click', openKifuImportModal);
document.getElementById('kifu-share-back')?.addEventListener('click', () => {
    closeKifuShareSheet();
    setKifuBarOpen(true);
});
document.getElementById('kifu-copy-url')?.addEventListener('click', () => {
    const url = kifuShareUrlElement?.dataset.url;
    if (!url) return;
    track('share', { method: 'copy', content: 'kifu', mode: gameMode });
    copyKifuText(url, document.getElementById('kifu-copy-url-label'));
});
document.getElementById('kifu-share-x')?.addEventListener('click', () => {
    track('share', { method: 'x', content: 'kifu', mode: gameMode });
    shareKifuTo('x');
});
document.getElementById('kifu-share-line')?.addEventListener('click', () => {
    track('share', { method: 'line', content: 'kifu', mode: gameMode });
    shareKifuTo('line');
});
document.getElementById('kifu-copy-kif')?.addEventListener('click', () => {
    track('share', { method: 'kif', content: 'kifu', mode: gameMode });
    copyKifuText(buildKifText(), document.getElementById('kifu-copy-kif-label'));
});
document.getElementById('kifu-download-kif')?.addEventListener('click', () => {
    track('share', { method: 'kif', content: 'kifu', mode: gameMode });
    downloadKifFile();
});

kifuViewSetupButton?.addEventListener('click', openKifuBranchModal);
kifuRestartViewButton?.addEventListener('click', () => jumpToKifuPly(0));

kifuImportTextElement?.addEventListener('input', handleKifuImportInput);
kifuImportTextElement?.addEventListener('paste', () => setTimeout(handleKifuImportInput, 0));
kifuImportApplyButton?.addEventListener('click', applyKifuImport);
document.getElementById('kifu-import-close')?.addEventListener('click', closeFriendModals);
document.getElementById('kifu-import-cancel')?.addEventListener('click', closeFriendModals);
document.getElementById('kifu-import-backdrop')?.addEventListener('click', closeFriendModals);

document.getElementById('kifu-branch-close')?.addEventListener('click', closeFriendModals);
document.getElementById('kifu-branch-backdrop')?.addEventListener('click', closeFriendModals);
document.getElementById('kifu-branch-start')?.addEventListener('click', startPlayingFromCurrentPosition);
kifuBranchModal?.querySelectorAll('[data-branch-side]').forEach(chip => {
    chip.addEventListener('click', () => setKifuBranchChoice('side', chip.dataset.branchSide));
});
kifuBranchModal?.querySelectorAll('[data-branch-foe]').forEach(chip => {
    chip.addEventListener('click', () => setKifuBranchChoice('foe', chip.dataset.branchFoe));
});
// 強さの選択肢は解放状態に応じて作り直されるので、コンテナへの委譲で束ねる
kifuBranchLevelsElement?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-branch-level]');
    if (chip) setKifuBranchLevel(chip.dataset.branchLevel);
});

// ページ読み込み時の初期化。
// 詰将棋モードの起動は shogi-tsume.js（このファイルの後に読み込む別スクリプト）に
// 入っているので、全スクリプトの評価が終わる DOMContentLoaded まで待ってから呼ぶ。
function bootGame() {
    // まずレベル解放状態を反映
    renderDifficultyUi();

    // gameMode はファイル冒頭でパスから確定済み（/ = ai, /board/ = pvp, /online/ = online）。
    // 旧形式の ?mode= / ?room= はWorker側でパス形式へリダイレクトしている。
    const urlRoom = new URLSearchParams(window.location.search).get('room');

    // 友達対戦の前回設定（手番・持ち時間）を復元
    loadFriendPrefs();

    if (gameMode === ONLINE_MODE) {
        // オンライン対戦の局面はサーバーが持っているのでローカルには保存も復元もしない
        loadPreferencesOnlyFromLocalStorage();
        initializeBoard();
        updateOnlineUiState();

        if (urlRoom && urlRoom.trim() !== '') {
            onlineJoinRoom(urlRoom);
        }
        matchmakingBridge.start?.();
    } else if (gameMode === TSUME_MODE) {
        // 詰将棋は当日の問題がHTMLに焼き込まれている。対局状態は保存しない
        loadPreferencesOnlyFromLocalStorage();
        tsumeBridge.start();
        updateOnlineUiState();
    } else {
        // ai または pvp モード
        const params = new URLSearchParams(window.location.search);
        if (params.has('k') && kifuCoreAvailable()) {
            // 共有された棋譜。🔴 眺めている間は遊びかけの対局に触らない（設計書 §12）
            bootSharedKifu(params);
        } else if (!loadFromLocalStorage()) {
            // localStorageから復元を試み、失敗したら新規ゲームを開始
            initializeBoard();
        }
        updateOnlineUiState();
        // 相手の手番の局面で終わっていた対局を開き直した場合。
        // 🔴 requestAnimationFrame で遅らせないこと。タブが裏に居るあいだ呼ばれず、
        // 出るはずの案内が出ない。位置決めは getBoundingClientRect() が採寸を強制するので
        // ここで直接呼んで問題ない
        noticeOpponentTurnIfStuck();
    }

    // 表示モードが画像の場合は初期ロード時にプリロード
    if (pieceDisplayMode === 'image') {
        preloadPieceImages();
    }
}

// index.html はどちらのスクリプトも defer で読み込む。defer は必ず DOMContentLoaded より
// 前に評価が終わるので、ここで待てば shogi-tsume.js の登録が済んだ状態で起動できる。
// index.html の defer を外すと起動しなくなるので注意。
document.addEventListener('DOMContentLoaded', bootGame);

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
        // iOSはインストールを促す案内しか出せない（承諾・拒否はブラウザ側で分からない）
        track('pwa_prompt', { result: 'ios_view' });
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
            track('pwa_prompt', { result: outcome === 'accepted' ? 'accept' : 'dismiss' });

            // プロンプトは一度しか使えない
            deferredPrompt = null;
            hidePWAInstallBanner();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            track('pwa_prompt', { result: 'dismiss' });
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
    track('pwa_install', {});
    hidePWAInstallBanner();
    deferredPrompt = null;
});
