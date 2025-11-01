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

// AI関連の要素
const modeTabs = document.querySelectorAll('.mode-tab');
const aiSettingsElement = document.getElementById('ai-settings');
const difficultySelect = document.getElementById('difficulty');

// 音声要素
const piecePlacementSound = new Audio('sounds/piece_placement.mp3');

// ゲームモード
let gameMode = 'ai'; // 'ai' or 'pvp'
let aiDifficulty = 'medium'; // 'easy', 'medium', 'hard', 'super'

const SENTE = 'sente'; // 先手
const GOTE = 'gote'; // 後手

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

// 棋譜関連
let moveHistory = []; // 手の履歴を保存 { board, capturedPieces, currentPlayer, lastMove, moveCount }
let currentHistoryIndex = -1; // 現在の履歴インデックス

// 千日手判定用
let positionHistory = []; // 局面のハッシュを保存
let checkHistory = []; // 各局面で王手だったかを保存

// --- 初期化 ---
function initializeBoard() {
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
    moveHistory = [];
    currentHistoryIndex = -1;
    positionHistory = [];
    checkHistory = [];
    messageElement.textContent = '';
    messageArea.style.display = 'none';

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

    // 初期状態を履歴に保存
    saveCurrentState();

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();
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

function saveCurrentState() {
    // 現在のインデックスより後ろの履歴を削除（分岐を防ぐ）
    moveHistory = moveHistory.slice(0, currentHistoryIndex + 1);
    positionHistory = positionHistory.slice(0, currentHistoryIndex + 1);
    checkHistory = checkHistory.slice(0, currentHistoryIndex + 1);

    // 現在の状態を保存
    const state = {
        board: deepCopyBoard(board),
        capturedPieces: deepCopyCaptured(capturedPieces),
        currentPlayer: currentPlayer,
        lastMove: lastMove ? { ...lastMove } : null,
        moveCount: moveCount
    };

    moveHistory.push(state);

    // 局面ハッシュと王手状態を保存
    const hash = getBoardHash(board, capturedPieces, currentPlayer);
    positionHistory.push(hash);
    checkHistory.push(isCheck);

    currentHistoryIndex = moveHistory.length - 1;
    updateHistoryButtons();
}

function restoreState(index) {
    if (index < 0 || index >= moveHistory.length) return;

    const state = moveHistory[index];
    board = deepCopyBoard(state.board);
    capturedPieces = deepCopyCaptured(state.capturedPieces);
    currentPlayer = state.currentPlayer;
    lastMove = state.lastMove ? { ...state.lastMove } : null;
    moveCount = state.moveCount;
    currentHistoryIndex = index;

    clearSelection();
    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();
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

    if (undoButton) {
        undoButton.disabled = gameOver || currentHistoryIndex <= 0;
    }
    if (redoButton) {
        redoButton.disabled = gameOver || currentHistoryIndex >= moveHistory.length - 1;
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
                let pieceChar = '';
                if (pieceType === KING) {
                    pieceChar = (piece.owner === SENTE) ? '玉' : '王';
                } else {
                    pieceChar = pieceNames[pieceType] || '?';
                }
                pieceElement.textContent = pieceChar; if (pieceType.startsWith('+')) {
                    pieceElement.classList.add('promoted');
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
        promoteMoveInfo = { fromX, fromY, toX, toY, piece: movingPiece, captured };
        showPromoteDialog();
        return; // ユーザーの選択を待つ
    }

    // --- 成り選択がない、または強制成りの場合の処理 ---
    const promote = mustPromote || (canPromote && isEnteringPromotionZone); // 成り選択ダイアログなしの場合の自動成り（敵陣に入るとき）

    executeMove(fromX, fromY, toX, toY, movingPiece, captured, promote);
}

function executeMove(fromX, fromY, toX, toY, piece, captured, promote) {
    const movingPiece = { ...piece }; // コピーを作成

    // 成る場合
    if (promote && pieceInfo[movingPiece.type]?.canPromote) {
        movingPiece.type = pieceInfo[movingPiece.type].promoted;
    }

    // 盤面更新
    board[toY][toX] = movingPiece;
    board[fromY][fromX] = null;

    // 最後の手を記録
    lastMove = { x: toX, y: toY };

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
    finalizeMove();
}


function handleDrop(pieceType, toX, toY) {
    // 二歩チェックは calculateDropLocations で行っているため、
    // ここに来た時点で合法手のはず
    // ただし、念のため人間プレイヤーの場合は再度チェック
    if (pieceType === PAWN && currentPlayer === SENTE) {
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
    }

    // 持ち駒を減らす
    capturedPieces[currentPlayer][pieceType]--;

    // 盤面に置く
    board[toY][toX] = { type: pieceType, owner: currentPlayer };

    // 最後の手を記録
    lastMove = { x: toX, y: toY };

    // 駒を打つ音を再生
    piecePlacementSound.currentTime = 0; // 音声を最初から再生
    piecePlacementSound.play().catch(err => console.log('音声再生エラー:', err));

    // ゲーム状態の更新
    finalizeMove();
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
        executeMove(fromX, fromY, toX, toY, piece, captured, true); // 成る
        hidePromoteDialog();
    }
});

// 成り選択「いいえ」
promoteNoButton.addEventListener('click', () => {
    if (promoteMoveInfo) {
        const { fromX, fromY, toX, toY, piece, captured } = promoteMoveInfo;
        executeMove(fromX, fromY, toX, toY, piece, captured, false); // 成らない
        hidePromoteDialog();
    }
});


function finalizeMove() {
    moveCount++;
    switchPlayer();
    clearSelection(); // 選択状態と移動可能範囲をクリア

    // 王手チェック
    isCheck = isKingInCheck(currentPlayer);
    if (isCheck) {
        // 詰みチェック
        checkmate = isCheckmate(currentPlayer);
        if (checkmate) {
            messageElement.textContent = `${currentPlayer === SENTE ? '後手' : '先手'}の勝ちです（詰み）`;
            messageArea.style.display = 'block';
            gameOver = true;
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
    saveCurrentState();

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
            } else {
                // 通常の千日手は引き分け
                messageElement.textContent = '引き分けです（千日手）';
            }
            messageArea.style.display = 'block';
        }
    }

    renderBoard();
    renderCapturedPieces();
    updateInfo();
    updateHistoryButtons();

    // AIモードで後手（GOTE）の番ならAIに手を指させる
    if (gameMode === 'ai' && currentPlayer === GOTE && !gameOver) {

        if (aiDifficulty === 'easy' || aiDifficulty === 'medium') {
            setTimeout(() => {
                makeAIMove();
            }, 430);
        } else if (aiDifficulty === 'hard') {
            setTimeout(() => {
                makeAIMove();
            }, 280);
        } else {
            setTimeout(() => {
                makeAIMove();
            }, 1);
        }
    }
}

function switchPlayer() {
    currentPlayer = (currentPlayer === SENTE) ? GOTE : SENTE;
}


// --- 移動可能範囲の計算 ---

function calculateValidMoves(x, y, piece) {
    const moves = [];
    const owner = piece.owner;
    const type = piece.type;
    const opponent = owner === SENTE ? GOTE : SENTE;

    const directions = getPieceMovements(type, owner);

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

            const targetPiece = board[currentY][currentX];

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

    // 移動の結果、自玉が王手になる手は除外する 
    const legalMoves = moves.filter(move => {
        // 仮想的に動かしてみる
        const tempBoard = cloneBoard(board);
        const tempCaptured = cloneCapturedPieces(capturedPieces); // 持ち駒もコピー（王手回避で駒打ちは関係ないが念のため）

        const targetPiece = tempBoard[move.y][move.x];
        let capturedForTemp = null;
        if (targetPiece) {
            capturedForTemp = { ...targetPiece }; // 取られる駒を仮想的に保持
        }

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
    const kingPos = findKing(player, currentBoard);
    if (!kingPos) return false; // 玉が見つからない (ありえないはず)

    const opponent = player === SENTE ? GOTE : SENTE;

    // 相手の全ての駒について、playerの玉に利きがあるか調べる
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = currentBoard[y][x];
            if (piece && piece.owner === opponent) {
                // この駒(piece)が kingPos に移動できるか(利きがあるか)をチェック
                // calculateValidMoves は自玉の安全を考慮するので、ここでは単純な利きを計算
                const rawMoves = calculateRawPieceMoves(x, y, piece, currentBoard);
                if (rawMoves.some(move => move.x === kingPos.x && move.y === kingPos.y)) {
                    return true; // 王手されている
                }
            }
        }
    }
    // 相手の持ち駒で王手になる可能性は、将棋のルール上ありえない（駒を打って即王手はOK）

    return false; // 王手されていない
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
                    // calculateValidMoves が自玉の安全を考慮しているので、
                    // ここで得られた合法手は、実行後に王手になっていない手のはず
                    return false;
                }
                // Note: calculateValidMovesが正しく自玉の安全を考慮していれば、
                //       ここで改めて仮想的に動かしてisKingInCheckする必要はない。
            }
        }
    }

    // 2. 持ち駒を打つ
    const playerCaptured = capturedPieces[player];
    for (const pieceType in playerCaptured) {
        if (playerCaptured[pieceType] > 0) {
            const dropLocations = calculateDropLocations(pieceType, player); // 合法な打てる場所
            // 合法な打ち場所が見つかれば詰みではない（打ち歩詰めのチェックは handleDrop で）
            // calculateDropLocations が自玉の安全を考慮している前提
            if (dropLocations.length > 0) {

                // さらに、打った結果、王手が回避されているかをチェックする必要がある
                // (calculateDropLocationsだけでは不十分な場合がある。例えば合駒)
                for (const loc of dropLocations) {
                    const tempBoard = cloneBoard(board);
                    tempBoard[loc.y][loc.x] = { type: pieceType, owner: player };
                    if (!isKingInCheck(player, tempBoard)) {
                        // 王手を回避できる打ち手が見つかった
                        return false;
                    }
                }
            }
        }
    }


    // 全ての合法手（移動・駒打ち）を試しても王手が回避できなければ詰み
    return true;
}

// --- ユーティリティ ---
function cloneBoard(boardToClone) {
    return boardToClone.map(row => row.map(piece => piece ? { ...piece } : null));
}

function cloneCapturedPieces(captured) {
    return {
        [SENTE]: { ...captured[SENTE] },
        [GOTE]: { ...captured[GOTE] }
    };
}

// --- AI関連の関数 ---

// 置換表（Transposition Table）
const transpositionTable = new Map();
const MAX_TT_SIZE = 100000; // 置換表のサイズ上限

// 駒の価値を定義
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

// 駒の位置評価テーブル（先手視点、0が先手陣地、8が後手陣地）
const POSITION_BONUS = {
    [PAWN]: [
        [-5, -5, -5, -5, -5, -5, -5, -5, -5], // 9段目(敵陣)
        [3, 3, 3, 3, 3, 3, 3, 3, 3],       // 8段目(敵陣)
        [4, 4, 4, 4, 4, 4, 4, 4, 4],       // 7段目(敵陣)
        [3, 3, 3, 3, 3, 3, 3, 3, 3],       // 6段目
        [0, 0, 0, 0, 0, 0, 0, 0, 0],       // 5段目
        [-1, -1, -1, -1, -1, -1, -1, -1, -1], // 4段目
        [-1, -1, -1, -1, -1, -1, -1, -1, -1], // 3段目(自陣)
        [-2, -2, -2, -2, -2, -2, -2, -2, -2], // 2段目(自陣)
        [-3, -3, -3, -3, -3, -3, -3, -3, -3]  // 1段目(自陣)
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
        [-24, -21, -21, -21, -21, -21, -21, -21, -24],
        [-22, -21, -21, -21, -21, -21, -21, -21, -22],
        [-22, -21, -21, -21, -21, -21, -21, -21, -22],
        [-15, -14, -14, -14, -14, -14, -14, -14, -15],
        [-8, -7, -7, -7, -7, -7, -7, -7, -8],
        [-1, 0, 0, 0, 0, 0, 0, 0, -1],
        [2, 4, 4, 4, 4, 4, 4, 4, 2],
        [5, 7, 9, 11, 11, 11, 9, 7, 5],
        [5, 11, 11, 12, 12, 12, 11, 11, 5]
    ],
    // 成り駒は金と同じボーナス
    [PROMOTED_PAWN]: null, // 後で金のテーブルを使用
    [PROMOTED_LANCE]: null,
    [PROMOTED_KNIGHT]: null,
    [PROMOTED_SILVER]: null,
    // 成り飛車・成り角は元の駒のテーブルを使用
    [PROMOTED_ROOK]: null,
    [PROMOTED_BISHOP]: null
};

// 位置ボーナスを取得する関数
function getPositionBonus(pieceType, x, y, owner) {
    let table = POSITION_BONUS[pieceType];

    // 成り駒で専用テーブルがない場合
    if (!table) {
        if (pieceType === PROMOTED_PAWN || pieceType === PROMOTED_LANCE ||
            pieceType === PROMOTED_KNIGHT || pieceType === PROMOTED_SILVER) {
            table = POSITION_BONUS[GOLD]; // 金のテーブルを使用
        } else if (pieceType === PROMOTED_ROOK) {
            table = POSITION_BONUS[ROOK];
        } else if (pieceType === PROMOTED_BISHOP) {
            table = POSITION_BONUS[BISHOP];
        }
    }

    if (!table) return 0;

    // 後手の場合は盤面を反転
    const evalY = owner === SENTE ? y : 8 - y;
    return table[evalY][x];
}

// AIが手を指す
function makeAIMove() {
    if (gameOver) return;

    let move = null;
    let depth = 1; // デフォルト

    // 難易度に応じてdepthを設定
    switch (aiDifficulty) {
        case 'easy':
            depth = 1;
            break;
        case 'medium':
            depth = 2;
            break;
        case 'hard':
            depth = 3;
            break;
        case 'super':
            depth = 4;
            break;
        default:
            depth = 1;
    }

    // 置換表をクリア（探索前に）
    if (transpositionTable.size > MAX_TT_SIZE) {
        transpositionTable.clear();
    }

    const startTime = performance.now();
    move = getBestMoveWithSearch(depth);
    const endTime = performance.now();
    console.log(`AI思考時間: ${(endTime - startTime).toFixed(2)}ms (depth: ${depth}, TT size: ${transpositionTable.size})`);

    if (move) {
        executeAIMove(move);
    } else {
        // 合法手がない場合（詰み）
        gameOver = true;
        messageElement.textContent = '先手の勝ちです';
        messageArea.style.display = 'block';
        updateHistoryButtons();
    }
}

// AIの手を実行
function executeAIMove(move) {
    if (move.type === 'move') {
        // 盤上の駒を動かす
        const { fromX, fromY, toX, toY, promote } = move;
        const piece = board[fromY][fromX];
        const captured = board[toY][toX];
        executeMove(fromX, fromY, toX, toY, piece, captured, promote);
    } else if (move.type === 'drop') {
        // 持ち駒を打つ（AIの場合は二歩チェック済みなので直接実行）
        const { pieceType, toX, toY } = move;

        // 持ち駒を減らす
        capturedPieces[currentPlayer][pieceType]--;

        // 盤面に置く
        board[toY][toX] = { type: pieceType, owner: currentPlayer };

        // 最後の手を記録
        lastMove = { x: toX, y: toY };

        // 駒を打つ音を再生
        piecePlacementSound.currentTime = 0; // 音声を最初から再生
        piecePlacementSound.play().catch(err => console.log('音声再生エラー:', err));

        // ゲーム状態の更新
        finalizeMove();
    }
}

// 全ての合法手を取得
function getAllLegalMoves(player) {
    const moves = [];

    // 1. 盤上の駒の移動
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece && piece.owner === player) {
                const validMovesForPiece = calculateValidMoves(x, y, piece);
                for (const move of validMovesForPiece) {
                    // 成る・成らないの両方を考慮
                    const canPromote = pieceInfo[piece.type]?.canPromote;
                    const isEnteringPromotionZone = (player === SENTE && move.y <= 2) || (player === GOTE && move.y >= 6);
                    const wasInPromotionZone = (player === SENTE && y <= 2) || (player === GOTE && y >= 6);
                    const mustPromote =
                        (piece.type === PAWN || piece.type === LANCE) && (player === SENTE ? move.y === 0 : move.y === 8) ||
                        (piece.type === KNIGHT) && (player === SENTE ? move.y <= 1 : move.y >= 7);

                    if (canPromote && (isEnteringPromotionZone || wasInPromotionZone)) {
                        if (mustPromote) {
                            moves.push({ type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: true });
                        } else {
                            // 成る・成らないの両方を追加
                            moves.push({ type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: true });
                            moves.push({ type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: false });
                        }
                    } else {
                        moves.push({ type: 'move', fromX: x, fromY: y, toX: move.x, toY: move.y, promote: false });
                    }
                }
            }
        }
    }

    // 2. 持ち駒を打つ
    const playerCaptured = capturedPieces[player];
    for (const pieceType in playerCaptured) {
        if (playerCaptured[pieceType] > 0) {
            const dropLocations = calculateDropLocations(pieceType, player);
            for (const loc of dropLocations) {
                moves.push({ type: 'drop', pieceType: pieceType, toX: loc.x, toY: loc.y });
            }
        }
    }

    return moves;
}

// 手の並び替え（Move Ordering）- より良い手を先に探索
function orderMoves(moves, player) {
    // シンプルで高速な並び替え
    const scoredMoves = [];

    for (const move of moves) {
        let score = 0;

        if (move.type === 'move') {
            const target = board[move.toY][move.toX];
            if (target) {
                // 駒を取る手は優先（価値の高い駒ほど優先）
                score = PIECE_VALUES[target.type] || 0;
            }
            // 成りは優先
            if (move.promote) {
                score += 100;
            }
        }

        scoredMoves.push({ move, score });
    }

    // スコアで降順ソート（高い方が先）
    scoredMoves.sort((a, b) => b.score - a.score);

    return scoredMoves.map(sm => sm.move);
}

// ミニマックス法で探索（全難易度共通）
function getBestMoveWithSearch(depth) {
    const moves = getAllLegalMoves(GOTE);
    if (moves.length === 0) return null;

    // 手を並び替え（良い手を先に探索）
    const orderedMoves = orderMoves(moves, GOTE);

    let bestMove = null;
    let bestScore = -Infinity;

    for (const move of orderedMoves) {
        // 仮想的に手を指す
        const state = saveGameState();
        virtuallyApplyMove(move, GOTE);

        // ミニマックス探索（AIの手を打った後なので、次は相手のターン = 最小化）
        let score = minimax(depth - 1, -Infinity, Infinity, false);

        // 状態を戻す
        restoreGameState(state);

        // 低難易度では乱数を加えて弱くする
        if (depth < 3) {
            score *= 1 + (Math.random() - 0.5) * (3 - depth) * 0.5;
        }

        if (score > bestScore) {
            bestScore = score;
            bestMove = move;
        }
    }

    return bestMove;
}

// ミニマックス法（アルファベータ枝刈り付き + 置換表）
function minimax(depth, alpha, beta, isMaximizing) {
    // 終端条件
    if (depth === 0) {
        return minmaxEvaluate();
    }

    // 置換表のチェック（深さ2以上の時のみ）
    let boardHash;
    if (depth >= 2) {
        boardHash = getBoardHash(board, capturedPieces, isMaximizing ? GOTE : SENTE);
        const ttEntry = transpositionTable.get(boardHash);

        if (ttEntry && ttEntry.depth >= depth) {
            if (ttEntry.flag === 'exact') {
                return ttEntry.score;
            } else if (ttEntry.flag === 'lowerbound') {
                alpha = Math.max(alpha, ttEntry.score);
            } else if (ttEntry.flag === 'upperbound') {
                beta = Math.min(beta, ttEntry.score);
            }
            if (alpha >= beta) {
                return ttEntry.score;
            }
        }
    }

    const player = isMaximizing ? GOTE : SENTE;
    const moves = getAllLegalMoves(player);

    if (moves.length === 0) {
        // 手がない = 負け（大きなペナルティ）
        return isMaximizing ? -100000 : 100000;
    }

    // 手を並び替え（深さ2以上の時のみ）
    const orderedMoves = depth >= 2 ? orderMoves(moves, player) : moves;

    let bestScore;
    let flag;

    if (isMaximizing) {
        bestScore = -Infinity;
        for (const move of orderedMoves) {
            const state = saveGameState();
            virtuallyApplyMove(move, player);
            const score = minimax(depth - 1, alpha, beta, false);
            restoreGameState(state);

            bestScore = Math.max(bestScore, score);
            alpha = Math.max(alpha, score);
            if (beta <= alpha) {
                flag = 'lowerbound';
                break; // 枝刈り
            }
        }
        if (!flag) flag = bestScore <= alpha ? 'upperbound' : 'exact';
    } else {
        bestScore = Infinity;
        for (const move of orderedMoves) {
            const state = saveGameState();
            virtuallyApplyMove(move, player);
            const score = minimax(depth - 1, alpha, beta, true);
            restoreGameState(state);

            bestScore = Math.min(bestScore, score);
            beta = Math.min(beta, score);
            if (beta <= alpha) {
                flag = 'upperbound';
                break; // 枝刈り
            }
        }
        if (!flag) flag = bestScore >= beta ? 'lowerbound' : 'exact';
    }

    // 置換表に保存（深さ2以上の時のみ）
    if (depth >= 2 && boardHash) {
        transpositionTable.set(boardHash, {
            depth: depth,
            score: bestScore,
            flag: flag
        });
    }

    return bestScore;
}

// 盤面の評価
function minmaxEvaluate() {
    let score = 0;

    // 駒の価値を合計
    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (piece) {
                const value = PIECE_VALUES[piece.type] || 0;
                const positionBonus = getPositionBonus(piece.type, x, y, piece.owner);

                if (piece.owner === GOTE) {
                    score += value + positionBonus;
                } else {
                    score -= value + positionBonus;
                }
            }
        }
    }

    // 持ち駒の価値
    for (const pieceType in capturedPieces[GOTE]) {
        score += capturedPieces[GOTE][pieceType] * (PIECE_VALUES[pieceType] || 0) * 1.11;
    }
    for (const pieceType in capturedPieces[SENTE]) {
        score -= capturedPieces[SENTE][pieceType] * (PIECE_VALUES[pieceType] || 0) * 1.11;
    }

    // 王手の評価
    if (isKingInCheck(SENTE)) {
        score += 500; // 相手を王手にしているのは有利
    }
    if (isKingInCheck(GOTE)) {
        score -= 500; // 自分が王手されているのは不利
    }

    return score;
}

// 手を適用（仮想的に）
function virtuallyApplyMove(move, player) {
    if (move.type === 'move') {
        const { fromX, fromY, toX, toY, promote } = move;
        const piece = board[fromY][fromX];
        const captured = board[toY][toX];

        if (captured) {
            let capturedType = captured.type;
            if (pieceInfo[capturedType]?.base) {
                capturedType = pieceInfo[capturedType].base;
            }
            capturedPieces[player][capturedType]++;
        }

        const movingPiece = { ...piece };
        if (promote && pieceInfo[movingPiece.type]?.canPromote) {
            movingPiece.type = pieceInfo[movingPiece.type].promoted;
        }

        board[toY][toX] = movingPiece;
        board[fromY][fromX] = null;
    } else if (move.type === 'drop') {
        const { pieceType, toX, toY } = move;
        capturedPieces[player][pieceType]--;
        board[toY][toX] = { type: pieceType, owner: player };
    }
}

// ゲーム状態の保存
function saveGameState() {
    return {
        board: cloneBoard(board),
        capturedPieces: cloneCapturedPieces(capturedPieces)
    };
}

// ゲーム状態の復元
function restoreGameState(state) {
    board = state.board;
    capturedPieces = state.capturedPieces;
}

// --- 初期化実行 ---
resetButton.addEventListener('click', initializeBoard);

// 履歴ボタンのイベントリスナー
const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');

undoButton.addEventListener('click', () => {
    if (!gameOver) {
        undoMove();
    }
});

redoButton.addEventListener('click', () => {
    if (!gameOver) {
        redoMove();
    }
});

// モード切り替えタブのイベントリスナー
modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        // 全てのタブから active クラスを削除
        modeTabs.forEach(t => t.classList.remove('active'));
        // クリックされたタブに active クラスを追加
        tab.classList.add('active');

        // モードを設定
        gameMode = tab.dataset.mode;

        // AI設定の表示/非表示を切り替え
        if (gameMode === 'ai') {
            aiSettingsElement.style.display = 'block';
        } else {
            aiSettingsElement.style.display = 'none';
        }

        // ゲームをリセット
        initializeBoard();
    });
});

// 難易度変更のイベントリスナー
difficultySelect.addEventListener('change', (e) => {
    aiDifficulty = e.target.value;
    // 難易度が変更されたらゲームをリセット
    initializeBoard();
});

initializeBoard(); // ページ読み込み時に初期化