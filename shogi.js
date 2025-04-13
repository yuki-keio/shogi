const boardElement = document.getElementById('shogi-board');
const capturedWhiteElement = document.getElementById('captured-white').querySelector('.pieces-container');
const capturedBlackElement = document.getElementById('captured-black').querySelector('.pieces-container');
const currentTurnElement = document.getElementById('current-turn');
const moveCountElement = document.getElementById('move-count');
const messageElement = document.getElementById('message');
const promoteDialog = document.getElementById('promote-dialog');
const promoteYesButton = document.getElementById('promote-yes');
const promoteNoButton = document.getElementById('promote-no');
const resetButton = document.getElementById('reset-button');

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
    messageElement.textContent = '';

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

    renderBoard();
    renderCapturedPieces();
    updateInfo();
}

function initCaptured() {
    const pieces = { [ROOK]: 0, [BISHOP]: 0, [GOLD]: 0, [SILVER]: 0, [KNIGHT]: 0, [LANCE]: 0, [PAWN]: 0 };
    return pieces;
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
                pieceElement.textContent = pieceChar;              if (pieceType.startsWith('+')) {
                    pieceElement.classList.add('promoted');
                }
                if (piece.owner === currentPlayer) {
                    square.classList.add('highlight');
                } else{
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
    moveCountElement.textContent = moveCount+1;
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
    // 1. 成れる駒である
    // 2. 移動元か移動先のどちらかが敵陣(3段目以内)である
    // 3. 強制成りでない場合 (歩・香が最終段、桂が最終or penultimate段)
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

    // 駒を取った場合の処理
    if (captured) {
        let capturedType = captured.type;
        // 成り駒を取ったら元の駒に戻す
        if (pieceInfo[capturedType]?.base) {
            capturedType = pieceInfo[capturedType].base;
        }
        capturedPieces[currentPlayer][capturedType]++;
    }

    // ゲーム状態の更新
    finalizeMove();
}


function handleDrop(pieceType, toX, toY) {
     // 二歩チェック
     if (pieceType === PAWN) {
        for (let y = 0; y < 9; y++) {
            const p = board[y][toX];
            if (p && p.type === PAWN && p.owner === currentPlayer && !p.type.startsWith('+')) { // 成ってない歩
                messageElement.textContent = "二歩です。";
                clearSelection();
                return;
            }
        }
    }

    // 打ち歩詰めチェック (簡易版 - ここでは省略、別途実装が必要)
    // if (pieceType === PAWN && isUchifuzume(toX, toY, currentPlayer)) {
    //     messageElement.textContent = "打ち歩詰めです。";
    //     clearSelection();
    //     return;
    // }

    // 持ち駒を減らす
    capturedPieces[currentPlayer][pieceType]--;

    // 盤面に置く
    board[toY][toX] = { type: pieceType, owner: currentPlayer };

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
            gameOver = true;
        } else {
            messageElement.textContent = `${currentPlayer === SENTE ? '先手' : '後手'}に王手！`;
        }
    } else {
        // 王手でなければ詰みではない
        checkmate = false;
        messageElement.textContent = ''; // 王手メッセージを消す
        // ここで千日手などの判定も将来的に追加
    }


    renderBoard();
    renderCapturedPieces();
    updateInfo();
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

    // 移動の結果、自玉が王手になる手は除外する (重要！)
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

        // 成りの可能性はここでは考慮しない（移動の可否だけ見るため）

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

                // 二歩チェックは handleDrop で行う (打つ直前)
                // 打ち歩詰めチェックも handleDrop で行う (打つ直前)

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
function getPieceMovements(type, owner) {
    const dir = owner === SENTE ? -1 : 1; // 先手は上(-1), 後手は下(+1)

    // 基本の駒の動きを定義 (変数に格納)
    const pawnMoves = [{ dx: 0, dy: dir, range: 1 }];//歩
    const lanceMoves = [{ dx: 0, dy: dir, range: 8 }];//香
    const knightMoves = [{ dx: -1, dy: dir * 2, range: 1 }, { dx: 1, dy: dir * 2, range: 1 }];//桂
    const silverMoves = [{ dx: 0, dy: dir, range: 1 }, { dx: -1, dy: dir, range: 1 }, { dx: 1, dy: dir, range: 1 }, { dx: -1, dy: -dir, range: 1 }, { dx: 1, dy: -dir, range: 1 }];//銀
    const goldMoves = [{ dx: 0, dy: dir, range: 1 }, { dx: -1, dy: dir, range: 1 }, { dx: 1, dy: dir, range: 1 }, { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: -dir, range: 1 }];//金
    const bishopMoves = [{ dx: 1, dy: 1, range: 8 }, { dx: 1, dy: -1, range: 8 }, { dx: -1, dy: 1, range: 8 }, { dx: -1, dy: -1, range: 8 }];//角
    const rookMoves = [{ dx: 1, dy: 0, range: 8 }, { dx: -1, dy: 0, range: 8 }, { dx: 0, dy: 1, range: 8 }, { dx: 0, dy: -1, range: 8 }];//飛車
    const kingMoves = [{ dx: 0, dy: dir, range: 1 }, { dx: -1, dy: dir, range: 1 }, { dx: 1, dy: dir, range: 1 }, { dx: -1, dy: 0, range: 1 }, { dx: 1, dy: 0, range: 1 }, { dx: 0, dy: -dir, range: 1 }, { dx: -1, dy: -dir, range: 1 }, { dx: 1, dy: -dir, range: 1 }];//王

    // 動きのマッピング (再帰呼び出しを避ける)
    const movements = {
        [PAWN]:   pawnMoves,
        [LANCE]:  lanceMoves,
        [KNIGHT]: knightMoves,
        [SILVER]: silverMoves,
        [GOLD]:   goldMoves,
        [BISHOP]: bishopMoves,
        [ROOK]:   rookMoves,
        [KING]:   kingMoves,

        // 成り駒 (直接定義または基本の動きをコピー)
        [PROMOTED_PAWN]:   goldMoves, // 金の動きを参照
        [PROMOTED_LANCE]:  goldMoves, // 金の動きを参照
        [PROMOTED_KNIGHT]: goldMoves, // 金の動きを参照
        [PROMOTED_SILVER]: goldMoves, // 金の動きを参照
        [PROMOTED_BISHOP]: [ // 馬 = 角 + 王(斜め以外)
            ...bishopMoves, // 角の動きをコピー
            { dx: 1, dy: 0, range: 1 }, { dx: -1, dy: 0, range: 1 }, { dx: 0, dy: 1, range: 1 }, { dx: 0, dy: -1, range: 1 }
        ],
        [PROMOTED_ROOK]:   [ // 龍 = 飛車 + 王(直進以外)
            ...rookMoves, // 飛車の動きをコピー
            { dx: 1, dy: 1, range: 1 }, { dx: 1, dy: -1, range: 1 }, { dx: -1, dy: 1, range: 1 }, { dx: -1, dy: -1, range: 1 }
        ],
    };
    return movements[type] || [];
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
                for(const loc of dropLocations) {
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

// --- 初期化実行 ---
resetButton.addEventListener('click', initializeBoard);
initializeBoard(); // ページ読み込み時に初期化