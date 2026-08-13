// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋モードのロジック。/tsume/ でだけ読み込む（他のモードでは転送も解析もしない）。
// shogi.js と同じクラシックスクリプトなので、盤面(board)・描画(renderBoard)・
// 指し手(movePiece)といった core 側のグローバルはそのまま参照できる。
// 読み込み順は index.html で shogi.js の「後」。順序を入れ替えないこと。
//
// core からこのファイルへの入口は、末尾で登録する tsumeBridge の5つだけに絞ってある。
// 増やすときは shogi.js 側の tsumeBridge の定義も併せて直すこと。

// 当日の5問はビルド時に #tsume-data へ焼き込まれている。
// 作意どおりに指している間は焼き込み済みの応手を並べるだけで、探索は動かさない。
// 作意から外れたときだけ、玉方の逃げ方を Web Worker の詰み探索（src/tsume/solver.ts）に選ばせる。
//
// 用語: 攻方 = 先手（利用者）、玉方 = 後手（自動で応じる）。
// 攻方の玉は盤上に無いが、isKingInCheck() は玉が見つからなければ false を返すので
// 既存の合法手生成・王手判定はそのまま動く。

const TSUME_STORAGE_KEY = 'shogi_tsume_v1';
/**
 * 記録を残す日数。日付ナビで選べるのは build-pages.mjs の TSUME_ARCHIVE_DAYS(30日) までで、
 * それより古い日の記録は出す場所が無い。当日ぶんを足した31日だけ持ち、古い順に捨てる。
 */
const TSUME_PROGRESS_KEEP_DAYS = 31;
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
// 王手をその場で突き返すより、自分で指し切ったほうが納得できる。
//
// 遅い端末では逃げ方を最後まで読み切れないこともあるが、そのときも探索は
// 「攻方の何手ぶんまでは詰まない」と証明できた手を返す（src/tsume/solver.ts）。
// 読み切れなかった受けに対して手数内に詰ませたときも、正解は正解として扱う。
// こちらの読みが足りなかっただけの話を、解いた側の記録に持ち込まない。

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
/**
 * 「待った」で取り消したまま、まだ指し直していない攻方の手（USI）。
 *
 * 別解に入ると以降の手は作意とも照合されないので、悪手を指してもその場では咎めない。
 * そのままだと「待った」で戻して別の手を試す、を繰り返して手を探せてしまうので、
 * 取り消した手と違う手に差し替えたら助けを借りたものとして扱う。
 * 同じ手を指し直しただけ（見直しや操作ミス）のときは咎めない。
 */
let tsumeRedoCandidate = null;
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
 *
 * 探索は予算を使い切っても「攻方の何手ぶんまでは詰まないと証明できた手」を返すので、
 * 手が返らないのは worker が動かないときだけ。そのときは 'unknown' になり、
 * 呼び出し側が pickTsumeFallbackDefense() で1手選んで続ける。
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

/**
 * 探索が使えないときに玉方の手を1つ選ぶ、最後の手段。
 * worker が起動しない・応答が返らないときだけ通る。
 *
 * 読まないので粘りの保証は無いが、手を返さずに盤を止めるよりはよい。
 * 選び方は src/tsume/solver.ts の naturalness と揃える
 * （駒を取る手 ＞ 玉が逃げる手 ＞ その他 ＞ 合駒）。
 * 玉方は王手されている前提で、calculateValidMoves / calculateDropLocations が
 * どちらも「指したあと自玉に王手が残る手」を落とすので、合法性はそこに任せてよい。
 */
function pickTsumeFallbackDefense() {
    let best = null;
    let bestScore = -1;

    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
            const piece = board[y][x];
            if (!piece || piece.owner !== GOTE) continue;
            const isKing = piece.type === KING;
            for (const spot of calculateValidMoves(x, y, piece)) {
                const score = (board[spot.y][spot.x] ? 2 : 0) + (isKing ? 1 : 0) + 1;
                if (score <= bestScore) continue;
                bestScore = score;
                best = {
                    type: 'move',
                    fromX: x, fromY: y, toX: spot.x, toY: spot.y,
                    // 成るかどうかは選べる場面もあるが、成らないと反則になる手だけ成る
                    promote: (piece.type === PAWN || piece.type === LANCE) && spot.y === 8
                        || piece.type === KNIGHT && spot.y >= 7
                };
            }
        }
    }
    if (best) return toUsiMoveString(best);

    // 盤上の駒では受けられない。合駒を探す（打つ手は成れないので迷う余地が無い）
    for (const pieceType of Object.keys(capturedPieces[GOTE] || {})) {
        if ((capturedPieces[GOTE][pieceType] || 0) <= 0) continue;
        const spot = calculateDropLocations(pieceType, GOTE)[0];
        if (spot) return toUsiMoveString({ type: 'drop', pieceType, toX: spot.x, toY: spot.y });
    }
    return null;
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
    // 局面を戻す用事はここ以外にもある（王手でない手の差し戻しなど）。
    // 「待った」で取り消した手を覚えるのは rememberTsumeRedoCandidate() の役目なので、
    // ここでは必ず捨てて、あとから上書きしてもらう
    tsumeRedoCandidate = null;
    tsumeToast('');
    // 「待った」で詰み上がりより前に戻ったなら、正解の知らせも引っ込める
    hideTsumeResult();
    renderTsumeUi();
}

/**
 * 「待った」「進む」のあと、この局面から元々指されていた攻方の手を覚えておく。
 *
 * usiMoveHistory[i] は moveHistory[i+1] に至る手なので、いまの局面の次の手は
 * usiMoveHistory[currentHistoryIndex]。「進む」で先端まで戻ったときは何も無い。
 * 履歴が切り詰められるのは次に指したときなので、この時点ではまだ残っている。
 */
function rememberTsumeRedoCandidate() {
    tsumeRedoCandidate = currentHistoryIndex >= 0 && currentHistoryIndex < usiMoveHistory.length
        ? usiMoveHistory[currentHistoryIndex]
        : null;
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
    tsumeRedoCandidate = null;
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
        tsumeRejectMove();
        return;
    }

    // 別解ルートでは悪手をその場で咎めないぶん、「待った」で戻して別の手を試す、を
    // 繰り返せば手を探せてしまう。差し替えた時点で助けを借りたことにする。
    // 詰みの判定より先に置くのは、差し替えた手で詰ませたときこそ効かせたいため
    if (tsumeAltLine && tsumeRedoCandidate && usiMove && usiMove !== tsumeRedoCandidate) {
        markTsumeAssisted(tsumeCurrent);
    }
    tsumeRedoCandidate = null;

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
        // 探索は打ち切られても「そこまでは詰まないと証明できた手」を返すので、
        // 手が無いのは worker が落ちた・応答が返らなかったときだけ。
        // それでも盤を止めるわけにはいかないので、自前で1手選んで続ける
        const usi = result.usi || pickTsumeFallbackDefense();
        if (!usi) {
            // 玉方に指す手が無い＝詰んでいる。直前の詰み判定の取りこぼし
            tsumeBusy = false;
            tsumeFinish();
            return;
        }
        // 応手のあと王手が続かないなら、指す手が無くなって手詰まりになる。そこで終わりにする。
        // 自前で選んだ手のときは王手が残るかを調べていないので、続くものとして扱う
        // （王手でない手は差し戻されるだけで、「待った」も残っている）
        tsumePlayDefense(session, usi, startedAt, result.attackerHasCheck === false);
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
            const usi = result.usi || pickTsumeFallbackDefense();
            if (usi) {
                tsumeAutoPlaying = true;
                try {
                    executeAIMove(usiMoveToMove(usi));
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
 * 王手でない手をその場で1手戻す。詰将棋は王手を続けるというルールの話なので、
 * 悪手として咎めるのではなく、指せなかったことにして指し直してもらう。
 */
function tsumeRejectMove() {
    // ルール違反で差し戻すだけなので、「待った」で取り消した手の記憶は残しておく。
    // ここで消すと、わざと王手でない手を挟んで記憶を流せてしまう
    const keepRedoCandidate = tsumeRedoCandidate;
    const target = currentHistoryIndex - 1;
    if (target >= 0) restoreState(target);
    syncTsumeStateFromHistory();
    tsumeRedoCandidate = keepRedoCandidate;
    // syncTsumeStateFromHistory がトーストを消すので、そのあとに出す
    tsumeToast('詰将棋では王手をかけ続ける必要があります', 'bad');
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
    tsumeRedoCandidate = null;
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
 *   lastDate … 最後に「1問でも解いた」日。連続日数を数えるのはこれだけ。
 *              解いた日だけが入る（ヒントを見ただけで終わった日は入らない）。
 *              一緒にすると、その日に解いていないのに連続日数が伸びてしまう
 *   streak   … 連続日数。当日ぶんを解いたときだけ動かす
 *   total    … 解いた問題の累計。過去の日のぶんも数える
 *   days     … 日付ごと・難易度ごとの状態 'clean' | 'solved' | 'assisted'
 *              （古い形式では true。それは 'solved' として読む）
 *
 * days を日付ごとに持つのは、過去の日の✓を残すため。当日1日分だけを持っていた頃は、
 * 過去の日を解いても再読み込みで✓が消え、「答えを見る → 読み込み直す」で
 * 一発正解が取れる抜け道も過去の日に残っていた。
 */
function emptyTsumeProgress() {
    return { lastDate: '', streak: 0, total: 0, days: {} };
}

function readTsumeProgress() {
    try {
        const raw = localStorage.getItem(TSUME_STORAGE_KEY);
        if (!raw) return emptyTsumeProgress();
        const parsed = JSON.parse(raw);
        const lastDate = parsed.lastDate || '';
        const days = parsed.days && typeof parsed.days === 'object' ? { ...parsed.days } : {};
        // 日付ごとに持つ前の形式（当日1日分だけの today）を引き継ぐ。
        // todayDate が無いのは today と lastDate を分ける前のもので、当時は lastDate の日のぶんだった
        const legacyDate = parsed.todayDate || lastDate;
        if (legacyDate && !days[legacyDate] && parsed.today && typeof parsed.today === 'object') {
            days[legacyDate] = parsed.today;
        }
        return {
            lastDate,
            streak: Number(parsed.streak) || 0,
            total: Number(parsed.total) || 0,
            days
        };
    } catch (error) {
        return emptyTsumeProgress();
    }
}

/** その日の記録。まだ無ければ作って返す */
function tsumeDayRecord(progress, date) {
    if (!progress.days[date]) progress.days[date] = {};
    return progress.days[date];
}

/**
 * 「助けを借りた」を残す。ヒント・答えを見る・作意から外れる の3か所から呼ぶ。
 *
 * localStorage にも書くのは、これがメモリだけだと再読み込みで消えてしまい、
 * 答えを見る → 読み込み直す → 覚えた手順をなぞる、で一発正解が付いてしまうため。
 * 当日だけでなく過去の日も残すのは、この抜け道が日付を問わず同じように空くから。
 * すでに正解の記録がある問題は触らない（解き直しで格下げしない）。
 */
function markTsumeAssisted(index) {
    tsumeAssisted[index] = true;

    const problem = tsumeProblems[index];
    if (!problem || !tsumeDate) return;
    const progress = readTsumeProgress();
    const day = tsumeDayRecord(progress, tsumeDate);
    if (day[problem.level]) return;
    day[problem.level] = 'assisted';
    writeTsumeProgress(progress);
}

function writeTsumeProgress(progress) {
    try {
        localStorage.setItem(TSUME_STORAGE_KEY, JSON.stringify(pruneTsumeDays(progress)));
    } catch (error) {
        // プライベートブラウジングなどで書けなくても進行は妨げない
    }
}

/** 選べない日付の記録は出す場所が無いまま増え続けるので、新しい順に上限まで残して捨てる */
function pruneTsumeDays(progress) {
    const dates = Object.keys(progress.days);
    if (dates.length <= TSUME_PROGRESS_KEEP_DAYS) return progress;
    const keep = dates.sort().slice(-TSUME_PROGRESS_KEEP_DAYS);
    progress.days = Object.fromEntries(keep.map((date) => [date, progress.days[date]]));
    return progress;
}

/**
 * 正解を記録する。1問でも解いた日を「挑戦した日」として連続日数を数える。
 *
 * 連続日数を動かすのは当日ぶんを解いたときだけ。あとからさかのぼって連続日数が
 * 伸びるのは実態に合わない。✓と累計は過去の日のぶんも残す（解いた事実は同じなので）。
 *
 * @param {boolean} clean 一発正解だったか。難易度ごとに 'clean' として残す
 * @returns {{streak: number, streakUp: boolean, milestone: number}|null}
 *          結果バーに出す情報。問題が無いときだけ null
 */
function recordTsumeSolved(clean) {
    const problem = tsumeProblems[tsumeCurrent];
    if (!problem || !tsumeDate) return null;
    const today = jstToday();
    const progress = readTsumeProgress();

    // その日の1問目かどうか。連続日数が伸びた瞬間だけ演出したいので覚えておく
    let streakUp = false;
    if (isTsumeDateToday() && progress.lastDate !== today) {
        progress.streak = progress.lastDate === previousDate(today) ? progress.streak + 1 : 1;
        progress.lastDate = today;
        streakUp = true;
    }
    // 以前に一発で解いていればその記録を優先する（解き直しで格下げしない）
    const day = tsumeDayRecord(progress, tsumeDate);
    const already = day[problem.level];
    day[problem.level] = clean || already === 'clean' ? 'clean' : 'solved';
    progress.total += 1;
    // 節目はまたいだ瞬間だけ。毎回出すと「達成」の重みが無くなる
    const milestone = TSUME_MILESTONES.includes(progress.total) ? progress.total : 0;

    writeTsumeProgress(progress);
    renderTsumeUi();
    return { streak: progress.streak, streakUp, milestone };
}

/**
 * 表示している日の記録を画面の状態に戻す。
 * これが無いと、再読み込みしただけで難易度タブの✓も進捗ドットも 0 に戻り、
 * 「今日は3問解いた」という事実と画面が食い違う。
 *
 * 助けを借りた記録（'assisted' と、一発ではない 'solved'）も戻す。
 * ここを戻さないと、答えを見たあと読み込み直すだけで一発正解が取れてしまう。
 */
function restoreTsumeStatusFromProgress() {
    if (!tsumeDate) return;
    const day = readTsumeProgress().days[tsumeDate];
    if (!day) return;

    tsumeProblems.forEach((problem, index) => {
        const record = day[problem.level];
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

// --- core との接点 ---
// shogi.js は詰将棋の関数を直接呼ばず、必ずこの窓口を通す。
// こうしておくと、このファイルを読み込まないページで未定義参照が起きない。
Object.assign(tsumeBridge, {
    start: startTsumeMode,
    afterMove: tsumeAfterMove,
    // 「待った」「進む」から来たときだけ、取り消した手を覚えておく（別解での手探り対策）
    syncFromHistory: () => {
        syncTsumeStateFromHistory();
        rememberTsumeRedoCandidate();
    },
    historyTargetIndex: findTsumeHistoryTargetIndex,
    isBusy: () => tsumeBusy,
});
