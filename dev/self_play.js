// Self-Play Tool for Shogi AI Testing
// This tool runs games between "New AI" (experimentParam=1) and "Old AI" (experimentParam=0)

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

const pieceNames = {
    [KING]: '玉', [ROOK]: '飛', [BISHOP]: '角', [GOLD]: '金', [SILVER]: '銀',
    [KNIGHT]: '桂', [LANCE]: '香', [PAWN]: '歩',
    [PROMOTED_ROOK]: '竜', [PROMOTED_BISHOP]: '馬', [PROMOTED_SILVER]: '全',
    [PROMOTED_KNIGHT]: '圭', [PROMOTED_LANCE]: '杏', [PROMOTED_PAWN]: 'と'
};

// --- UI Elements ---
const numGamesInput = document.getElementById('numGames');
const difficultySelect = document.getElementById('difficulty');
const swapSidesSelect = document.getElementById('swapSides');
const displayModeSelect = document.getElementById('displayMode');
const maxMovesInput = document.getElementById('maxMoves');
const randomnessSelect = document.getElementById('randomness');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');

const statusIndicator = document.getElementById('statusIndicator');
const newWinsEl = document.getElementById('newWins');
const oldWinsEl = document.getElementById('oldWins');
const drawsEl = document.getElementById('draws');
const winRateEl = document.getElementById('winRate');
const avgMovesEl = document.getElementById('avgMoves');
const newAIAvgThinkEl = document.getElementById('newAIAvgThink');
const oldAIAvgThinkEl = document.getElementById('oldAIAvgThink');

const progressNew = document.getElementById('progressNew');
const progressDraw = document.getElementById('progressDraw');
const progressOld = document.getElementById('progressOld');
const gamesPlayedEl = document.getElementById('gamesPlayed');
const elapsedTimeEl = document.getElementById('elapsedTime');

const senteNameEl = document.getElementById('senteName');
const goteNameEl = document.getElementById('goteName');
const currentMoveCountEl = document.getElementById('currentMoveCount');
const boardPreview = document.getElementById('boardPreview');
const logContainer = document.getElementById('logContainer');

// --- State ---
let isRunning = false;
let currentGame = 0;
let totalGames = 0;
let stats = { newWins: 0, oldWins: 0, draws: 0, totalMoves: 0, newAIThinkingTime: 0, oldAIThinkingTime: 0, newAIMoveCount: 0, oldAIMoveCount: 0 };
let startTime = null;
let timerInterval = null;

// Game state
let board = [];
let capturedPieces = { [SENTE]: {}, [GOTE]: {} };
let currentPlayer = SENTE;
let moveCount = 0;
let lastMoveDetail = null;
let josekiEnabled = true;
let currentJosekiPattern = null;
let josekiMoveIndex = 0;

// AI Workers
let newAIWorker = null;
let oldAIWorker = null;

// Current game assignment
let newAISide = SENTE; // Which side the new AI plays

// --- Initialization ---
function initBoard() {
    boardPreview.innerHTML = '';
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const cell = document.createElement('div');
            cell.classList.add('board-cell');
            cell.dataset.x = x;
            cell.dataset.y = y;
            boardPreview.appendChild(cell);
        }
    }
}

function initCaptured() {
    return { [ROOK]: 0, [BISHOP]: 0, [GOLD]: 0, [SILVER]: 0, [KNIGHT]: 0, [LANCE]: 0, [PAWN]: 0 };
}

function setupInitialPosition() {
    board = Array(9).fill(null).map(() => Array(9).fill(null));
    capturedPieces = { [SENTE]: initCaptured(), [GOTE]: initCaptured() };
    currentPlayer = SENTE;
    moveCount = 0;
    lastMoveDetail = null;
    josekiMoveIndex = 0;
    currentJosekiPattern = null;

    const initialSetup = [
        { x: 0, y: 0, type: LANCE, owner: GOTE }, { x: 1, y: 0, type: KNIGHT, owner: GOTE },
        { x: 2, y: 0, type: SILVER, owner: GOTE }, { x: 3, y: 0, type: GOLD, owner: GOTE },
        { x: 4, y: 0, type: KING, owner: GOTE }, { x: 5, y: 0, type: GOLD, owner: GOTE },
        { x: 6, y: 0, type: SILVER, owner: GOTE }, { x: 7, y: 0, type: KNIGHT, owner: GOTE },
        { x: 8, y: 0, type: LANCE, owner: GOTE },
        { x: 1, y: 1, type: ROOK, owner: GOTE }, { x: 7, y: 1, type: BISHOP, owner: GOTE },
        { x: 0, y: 2, type: PAWN, owner: GOTE }, { x: 1, y: 2, type: PAWN, owner: GOTE },
        { x: 2, y: 2, type: PAWN, owner: GOTE }, { x: 3, y: 2, type: PAWN, owner: GOTE },
        { x: 4, y: 2, type: PAWN, owner: GOTE }, { x: 5, y: 2, type: PAWN, owner: GOTE },
        { x: 6, y: 2, type: PAWN, owner: GOTE }, { x: 7, y: 2, type: PAWN, owner: GOTE },
        { x: 8, y: 2, type: PAWN, owner: GOTE },
        { x: 0, y: 6, type: PAWN, owner: SENTE }, { x: 1, y: 6, type: PAWN, owner: SENTE },
        { x: 2, y: 6, type: PAWN, owner: SENTE }, { x: 3, y: 6, type: PAWN, owner: SENTE },
        { x: 4, y: 6, type: PAWN, owner: SENTE }, { x: 5, y: 6, type: PAWN, owner: SENTE },
        { x: 6, y: 6, type: PAWN, owner: SENTE }, { x: 7, y: 6, type: PAWN, owner: SENTE },
        { x: 8, y: 6, type: PAWN, owner: SENTE },
        { x: 1, y: 7, type: BISHOP, owner: SENTE }, { x: 7, y: 7, type: ROOK, owner: SENTE },
        { x: 0, y: 8, type: LANCE, owner: SENTE }, { x: 1, y: 8, type: KNIGHT, owner: SENTE },
        { x: 2, y: 8, type: SILVER, owner: SENTE }, { x: 3, y: 8, type: GOLD, owner: SENTE },
        { x: 4, y: 8, type: KING, owner: SENTE }, { x: 5, y: 8, type: GOLD, owner: SENTE },
        { x: 6, y: 8, type: SILVER, owner: SENTE }, { x: 7, y: 8, type: KNIGHT, owner: SENTE },
        { x: 8, y: 8, type: LANCE, owner: SENTE }
    ];

    initialSetup.forEach(p => {
        board[p.y][p.x] = { type: p.type, owner: p.owner };
    });
}

// --- Board Rendering ---
function renderBoard() {
    const cells = boardPreview.querySelectorAll('.board-cell');
    cells.forEach(cell => {
        const x = parseInt(cell.dataset.x);
        const y = parseInt(cell.dataset.y);
        cell.innerHTML = '';
        cell.classList.remove('last-move');

        const piece = board[y][x];
        if (piece) {
            const pieceEl = document.createElement('span');
            pieceEl.classList.add('piece');
            if (piece.owner === GOTE) {
                pieceEl.classList.add('gote');
            }
            let pieceName = pieceNames[piece.type] || '?';
            if (piece.type === KING && piece.owner === GOTE) {
                pieceName = '王';
            }
            pieceEl.textContent = pieceName;
            cell.appendChild(pieceEl);
        }

        if (lastMoveDetail && lastMoveDetail.toX === x && lastMoveDetail.toY === y) {
            cell.classList.add('last-move');
        }
    });
}

// --- AI Worker Management ---
function createWorkers() {
    if (newAIWorker) newAIWorker.terminate();
    if (oldAIWorker) oldAIWorker.terminate();

    newAIWorker = new Worker('../ai-worker.js');
    oldAIWorker = new Worker('../ai-worker.js');

    newAIWorker.onmessage = handleAIResponse;
    oldAIWorker.onmessage = handleAIResponse;
}

function terminateWorkers() {
    if (newAIWorker) {
        newAIWorker.terminate();
        newAIWorker = null;
    }
    if (oldAIWorker) {
        oldAIWorker.terminate();
        oldAIWorker = null;
    }
}

function requestAIMove() {
    const isNewAITurn = currentPlayer === newAISide;
    const worker = isNewAITurn ? newAIWorker : oldAIWorker;
    const experimentParam = isNewAITurn ? 1 : 0;

    worker.postMessage({
        type: 'getBestMove',
        data: {
            board: board,
            capturedPieces: capturedPieces,
            currentPlayer: currentPlayer,
            moveCount: moveCount,
            lastMoveDetail: lastMoveDetail,
            aiDifficulty: difficultySelect.value,
            aiPlayer: currentPlayer,
            josekiEnabled: josekiEnabled,
            currentJosekiPattern: currentJosekiPattern,
            josekiMoveIndex: josekiMoveIndex,
            experimentParam: experimentParam,
            benchmarkRandomness: parseInt(randomnessSelect.value)
        }
    });
}

function handleAIResponse(e) {
    if (!isRunning) return;

    const { type, data } = e.data;
    if (type === 'bestMove') {
        const { move, currentJosekiPattern: newPattern, josekiMoveIndex: newIndex, thinkingTime } = data;
        currentJosekiPattern = newPattern;
        josekiMoveIndex = newIndex;

        // Track thinking time for the AI that just moved
        const isNewAITurn = currentPlayer === newAISide;
        if (typeof thinkingTime === 'number') {
            if (isNewAITurn) {
                stats.newAIThinkingTime += thinkingTime;
                stats.newAIMoveCount++;
            } else {
                stats.oldAIThinkingTime += thinkingTime;
                stats.oldAIMoveCount++;
            }
        }

        if (move) {
            applyMove(move);
            moveCount++;
            currentMoveCountEl.textContent = moveCount;

            // Check for checkmate or max moves
            const opponent = currentPlayer === SENTE ? GOTE : SENTE;
            const opponentKing = findKing(opponent);

            if (!opponentKing) {
                // Opponent king captured (shouldn't happen in proper shogi, but handle it)
                endGame(currentPlayer === newAISide ? 'new' : 'old', 'キング消失');
                return;
            }

            // Switch player
            currentPlayer = opponent;

            // Check if current player has no moves (checkmate)
            // We rely on the AI returning null move for this
            if (moveCount >= parseInt(maxMovesInput.value)) {
                endGame('draw', '最大手数');
                return;
            }

            // Render if needed
            const displayMode = displayModeSelect.value;
            if (displayMode !== 'skip') {
                renderBoard();
            }

            // Continue game
            if (displayMode === 'normal') {
                setTimeout(requestAIMove, 300);
            } else if (displayMode === 'fast') {
                setTimeout(requestAIMove, 50);
            } else {
                // Skip mode - immediate
                requestAIMove();
            }
        } else {
            // No valid move - checkmate or stalemate
            const winner = currentPlayer === newAISide ? 'old' : 'new';
            endGame(winner, '詰み');
        }
    }
}

// --- Move Application ---
function applyMove(move) {
    if (move.type === 'move') {
        const piece = board[move.fromY][move.fromX];
        const captured = board[move.toY][move.toX];

        // Handle captured piece
        if (captured) {
            let capturedType = captured.type;
            if (pieceInfo[capturedType]?.base) {
                capturedType = pieceInfo[capturedType].base;
            }
            capturedPieces[currentPlayer][capturedType]++;
        }

        // Apply promotion
        let placedPiece = { ...piece };
        if (move.promote && pieceInfo[piece.type]?.canPromote) {
            placedPiece.type = pieceInfo[piece.type].promoted;
        }

        board[move.fromY][move.fromX] = null;
        board[move.toY][move.toX] = placedPiece;
        lastMoveDetail = { fromX: move.fromX, fromY: move.fromY, toX: move.toX, toY: move.toY };

    } else if (move.type === 'drop') {
        capturedPieces[currentPlayer][move.pieceType]--;
        board[move.toY][move.toX] = { type: move.pieceType, owner: currentPlayer };
        lastMoveDetail = { toX: move.toX, toY: move.toY };
    }
}

function findKing(player) {
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.type === KING && piece.owner === player) {
                return { x, y };
            }
        }
    }
    return null;
}

// --- Game Flow ---
function startSelfPlay() {
    if (isRunning) return;

    isRunning = true;
    totalGames = parseInt(numGamesInput.value);
    currentGame = 0;
    stats = { newWins: 0, oldWins: 0, draws: 0, totalMoves: 0, newAIThinkingTime: 0, oldAIThinkingTime: 0, newAIMoveCount: 0, oldAIMoveCount: 0 };

    updateUI();
    setStatus('running', '実行中');
    startBtn.disabled = true;
    stopBtn.disabled = false;

    // Clear log
    logContainer.innerHTML = '';

    // Start timer
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);

    startNextGame();
}

function stopSelfPlay() {
    isRunning = false;
    setStatus('stopped', '停止');
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    terminateWorkers();
    addLog('対戦を中断しました', 'neutral');
}

function resetStats() {
    stats = { newWins: 0, oldWins: 0, draws: 0, totalMoves: 0, newAIThinkingTime: 0, oldAIThinkingTime: 0, newAIMoveCount: 0, oldAIMoveCount: 0 };
    currentGame = 0;
    totalGames = 0;
    updateUI();
    logContainer.innerHTML = '<div class="log-entry" style="color: var(--text-secondary);">対戦を開始してください...</div>';
    setupInitialPosition();
    renderBoard();
    senteNameEl.textContent = '-';
    goteNameEl.textContent = '-';
    senteNameEl.className = 'player-name';
    goteNameEl.className = 'player-name';
    currentMoveCountEl.textContent = '0';

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    elapsedTimeEl.textContent = '経過時間: 0:00';
}

function startNextGame() {
    if (!isRunning || currentGame >= totalGames) {
        if (isRunning) {
            finishAllGames();
        }
        return;
    }

    currentGame++;

    // Recreate workers each game to clear transposition tables
    terminateWorkers();
    createWorkers();

    // Determine sides
    const swapMode = swapSidesSelect.value;
    if (swapMode === 'alternate') {
        newAISide = currentGame % 2 === 1 ? SENTE : GOTE;
    } else if (swapMode === 'newFirst') {
        newAISide = SENTE;
    } else {
        newAISide = GOTE;
    }

    // Update player names
    senteNameEl.textContent = newAISide === SENTE ? '新AI' : '旧AI';
    goteNameEl.textContent = newAISide === GOTE ? '新AI' : '旧AI';
    senteNameEl.className = `player-name ${newAISide === SENTE ? 'new-ai' : 'old-ai'}`;
    goteNameEl.className = `player-name ${newAISide === GOTE ? 'new-ai' : 'old-ai'}`;

    setupInitialPosition();
    renderBoard();
    currentMoveCountEl.textContent = '0';

    updateUI();

    // Start the game
    requestAIMove();
}

function endGame(winner, reason) {
    stats.totalMoves += moveCount;

    let logClass = '';
    let logText = '';

    if (winner === 'new') {
        stats.newWins++;
        logClass = 'new-win';
        logText = `第${currentGame}局: 新AI 勝利 (${reason}, ${moveCount}手)`;
    } else if (winner === 'old') {
        stats.oldWins++;
        logClass = 'old-win';
        logText = `第${currentGame}局: 旧AI 勝利 (${reason}, ${moveCount}手)`;
    } else {
        stats.draws++;
        logClass = 'draw';
        logText = `第${currentGame}局: 引き分け (${reason}, ${moveCount}手)`;
    }

    addLog(logText, logClass);
    updateUI();

    // Render final position
    renderBoard();

    // Start next game after a brief pause
    if (displayModeSelect.value === 'skip') {
        startNextGame();
    } else {
        setTimeout(startNextGame, 500);
    }
}

function finishAllGames() {
    isRunning = false;
    setStatus('stopped', '完了');
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    terminateWorkers();

    const summary = `=== 最終結果 === 新AI: ${stats.newWins}勝 / 旧AI: ${stats.oldWins}勝 / 引分: ${stats.draws}`;
    addLog(summary, 'neutral');
}

// --- UI Updates ---
function updateUI() {
    newWinsEl.textContent = stats.newWins;
    oldWinsEl.textContent = stats.oldWins;
    drawsEl.textContent = stats.draws;

    const completed = stats.newWins + stats.oldWins + stats.draws;
    if (completed > 0) {
        const winRate = ((stats.newWins / completed) * 100).toFixed(1);
        winRateEl.textContent = `${winRate}%`;
        avgMovesEl.textContent = Math.round(stats.totalMoves / completed);

        // Update progress bars
        const newPct = (stats.newWins / totalGames) * 100;
        const drawPct = (stats.draws / totalGames) * 100;
        const oldPct = (stats.oldWins / totalGames) * 100;

        progressNew.style.width = `${newPct}%`;
        progressDraw.style.width = `${drawPct}%`;
        progressOld.style.width = `${oldPct}%`;

        // Update average thinking time
        const newAvgThink = stats.newAIMoveCount > 0 ? Math.round(stats.newAIThinkingTime / stats.newAIMoveCount) : 0;
        const oldAvgThink = stats.oldAIMoveCount > 0 ? Math.round(stats.oldAIThinkingTime / stats.oldAIMoveCount) : 0;
        newAIAvgThinkEl.textContent = `${newAvgThink}ms`;
        oldAIAvgThinkEl.textContent = `${oldAvgThink}ms`;
    } else {
        winRateEl.textContent = '-';
        avgMovesEl.textContent = '-';
        progressNew.style.width = '0%';
        progressDraw.style.width = '0%';
        progressOld.style.width = '0%';
        newAIAvgThinkEl.textContent = '-';
        oldAIAvgThinkEl.textContent = '-';
    }

    gamesPlayedEl.textContent = `${completed} / ${totalGames} 対局完了`;
}

function updateTimer() {
    if (!startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    elapsedTimeEl.textContent = `経過時間: ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function setStatus(type, text) {
    statusIndicator.className = `status ${type}`;
    statusIndicator.innerHTML = `<span class="status-dot"></span>${text}`;
}

function addLog(message, type) {
    const entry = document.createElement('div');
    entry.classList.add('log-entry');
    if (type) entry.classList.add(type);
    entry.textContent = message;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// --- Event Listeners ---
startBtn.addEventListener('click', startSelfPlay);
stopBtn.addEventListener('click', stopSelfPlay);
resetBtn.addEventListener('click', resetStats);

// --- Initialize ---
initBoard();
setupInitialPosition();
renderBoard();
