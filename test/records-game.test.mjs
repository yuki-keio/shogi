// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as engine from '../src/worker/shogi_engine.ts';
import * as KifuCore from '../src/kifu/browser.ts';

const source = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const tsumeSource = readFileSync(new URL('../shogi-tsume.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bot_win_kifu.json', import.meta.url), 'utf8'));
const functions = (text, names) => {
    const file = ts.createSourceFile('browser.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return names.map(name => {
        const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(node, `実装の関数 ${name} が見つかる`);
        return node.getText(file);
    }).join('\n');
};
const declarations = names => {
    const file = ts.createSourceFile('browser.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return names.map(name => {
        const node = file.statements.find(node => ts.isVariableStatement(node)
            && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === name));
        assert.ok(node, `実装の定数 ${name} が見つかる`);
        return node.getText(file);
    }).join('\n');
};
const recording = source.slice(source.indexOf('const recordsBootAt'), source.indexOf('// --- 初期化 ---', source.indexOf('const recordsBootAt')));

function makeDocument() {
    const elements = new Map();
    const make = tag => ({
        tag, hidden: false, disabled: false, textContent: '', children: [], listeners: {},
        style: {}, className: '', classList: { add() {}, remove() {} },
        setAttribute() {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        append(...children) {
            this.children.push(...children);
            for (const child of children) if (child.id) elements.set(child.id, child);
        },
        before(element) { if (element.id) elements.set(element.id, element); },
        after(element) { if (element.id) elements.set(element.id, element); },
        querySelector(selector) { return this.children.find(child => `.${child.className}` === selector) || null; },
    });
    elements.set('kifu-bar', make('div'));
    elements.set('tsume-panel', make('div'));
    return { getElementById: id => elements.get(id) || null, createElement: make, body: make('body') };
}

function createGame(overrides = {}) {
    const saved = [];
    const tsumeSaved = [];
    const callbacks = [];
    const local = new Map();
    const context = vm.createContext({
        ...engine, ...overrides, console, structuredClone, URL, URLSearchParams,
        window: { crypto: { randomUUID }, location: { origin: 'https://example.test' } },
        document: makeDocument(), KifuCore,
        localStorage: {
            getItem: key => local.get(key) ?? null,
            setItem: (key, value) => local.set(key, String(value)),
            removeItem: key => local.delete(key),
        },
        gameMode: 'ai', TSUME_MODE: 'tsume', aiDifficulty: 'medium', aiPlayerSide: engine.GOTE,
        currentInitialPosition: KifuCore.normalizeInitialPosition(), localClock: null, leavingForNextGame: false,
        localMatchPrefs: {
            ai: { handicap: 'none', dropSide: 'opponent', time: 'none', side: engine.SENTE },
            pvp: { handicap: 'none', dropSide: 'opponent', time: 'none', side: engine.SENTE },
        },
        settingsModal: null, gameResultRecordsElement: null,
        pieceDisplayMode: 'normal', moveHintEnabled: true, wazaFxLevel: 'std',
        currentResultDialogState: { winner: '後手', reason: '詰み' },
        GAME_END_REASON_CODES: { '詰み': 'checkmate', '千日手': 'sennichite' },
        gameOverDialog: { style: { display: 'none' } },
        onlineState: { side: engine.SENTE, usiMoves: [] },
        matchmakingBridge: {},
        isViewingSharedKifu: false, gameOver: false, checkmate: false,
        gameStartTracked: true, gameStartedFrom: 'new', gameStartFrom: 'new', gameStartedAt: 0,
        aiRequestId: 0, currentJosekiPattern: null, josekiMoveIndex: 0,
        moveHistory: [], usiMoveHistory: [], currentHistoryIndex: -1,
        positionHistory: [], checkHistory: [],
        kifuReplayCache: { key: null, replay: null, entries: [] },
        wazaScanCache: { key: null, scan: null },
        promoteMoveInfo: null, RESET_UNDO_MIN_PLIES: 3,
        setTimeout(callback) { callbacks.push(callback); },
        testStore: {
            async saveGame(value) { saved.push(structuredClone(value)); return true; },
            async saveTsume(value) { tsumeSaved.push(structuredClone(value)); return true; },
        },
        ...overrides,
    });
    const noops = ['clearAiMoveDelayTimer', 'clearAiWatchdog', 'hideAIThinkingIndicator', 'applyBoardOrientation',
        'clearMoveHint', 'hidePromoteDialog', 'hideBoardNotice', 'recomputeKingPosCache', 'renderBoard',
        'renderCapturedPieces', 'updateInfo', 'updateHistoryButtons', 'scheduleAIMoveIfNeeded', 'armFirstDemo',
        'hideGameOverDialog', 'clearSelection', 'noticeOpponentTurnIfStuck', 'markFirstDemoDone',
        'hideResetUndo', 'track', 'showKifuToast', 'showCheckNotice', 'openKifuBar',
        'exitKifuView', 'stripKifuParamsFromUrl', 'updateAiPlayerSideRadios', 'setKifuBarOpen',
        'renderDifficultyUi', 'closeFriendModals', 'clearWazaEffect', 'updateClockUi'];
    for (const name of noops) context[name] = () => {};
    context.isOnlineMode = () => context.gameMode === 'online';
    context.isLocalOnlineMatch = () => context.localOnline === true;
    context.isTsumeBoard = () => context.gameMode === 'tsume' || context.tsumeChallenge === true;
    context.kifuCoreAvailable = context.wazaAvailable = () => true;
    context.getDifficultyLabel = () => '中級';
    context.isLocalPlayersTurn = () => true;
    context.isKingInCheck = side => engine.isKingInCheck(side, context.board);
    context.isCheckmate = side => engine.isCheckmate(side, context.board, context.capturedPieces);
    context.showGameOverDialog = (winner, reason) => { context.currentResultDialogState = { winner, reason }; };
    vm.runInContext(declarations([
        'FRIEND_TC_OPTIONS', 'MATCH_SETTINGS_KEY', 'STORAGE_KEY_GAME_STATE_BY_MODE',
        'STORAGE_KEY_AI_DIFFICULTY', 'STORAGE_KEY_PIECE_DISPLAY_MODE', 'STORAGE_KEY_MOVE_HINT',
        'STORAGE_KEY_WAZA_FX', 'STORAGE_KEY_AI_PLAYER_SIDE',
    ]) + '\n' + recording + '\n' + functions(source, [
        'gameInitialPosition', 'sideName', 'ownSideName', 'localInitialPosition', 'aiSideForConditions', 'normalizedMatchPref', 'isValidFriendTcValue',
        'saveLocalMatchPrefs', 'gameStateStorageKey', 'saveToLocalStorage', 'clearLocalStorage', 'getOpponent',
        'resetLocalClock', 'advanceLocalClock', 'savedLocalClock', 'restoreLocalClock',
        'settleLocalClock', 'resumeLocalClock',
        'initializeBoard', 'initCaptured', 'deepCopyBoard', 'deepCopyCaptured', 'getBoardHash',
        'saveCurrentState', 'restoreState', 'checkSennichite', 'finalizeMove', 'switchPlayer',
        'kifuAllMoves', 'kifuCurrentPly', 'kifuTotalPlies', 'kifuReplayCached', 'wazaScanCached',
        'canSaveMovesOnly', 'buildSavedGameState', 'applyReplayToHistory', 'restoreSavedMoves',
        'captureResetUndo', 'applyResetUndo', 'loadKifuIntoBoard', 'beginPlayFromKifu',
    ]), context);
    // 通信・DOM は境界で置き換え、対局・保存情報・棋譜の実装そのものを動かす。
    vm.runInContext('loadRecordsStore = () => Promise.resolve(testStore);', context);
    context.resetWazaState = () => {
        context.wazaScanCache = { key: null, scan: null };
    };
    Object.defineProperty(context, 'savedState', {
        get() {
            const value = local.get(context.gameStateStorageKey());
            return value ? JSON.parse(value) : null;
        },
    });
    context.initializeBoard();
    return { context, saved, tsumeSaved, callbacks, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

function loadMoves(context, moves, initialPosition = context.gameInitialPosition()) {
    const replay = KifuCore.replayUsiMoves(moves, undefined, initialPosition);
    assert.equal(replay.ok, true);
    const record = context.savedState?.record;
    assert.equal(context.restoreSavedMoves({ moves, at: moves.length, record, initialPosition }), true);
    return replay;
}

test('詰みの最終手が保存されたあとに棋譜と技を確定し、再通知で増やさない', async () => {
    const { context, saved, settle } = createGame();
    const moves = fixture.usi;
    loadMoves(context, moves.slice(0, -1));
    const full = KifuCore.replayUsiMoves(moves);
    context.board = full.state.board;
    context.capturedPieces = full.state.capturedPieces;
    context.lastMove = full.state.lastMove;
    context.finalizeMove(moves.at(-1));
    await settle();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].moves, moves);
    assert.equal(saved[0].winner, engine.GOTE);
    assert.equal(saved[0].reason, 'checkmate');
    assert.deepEqual(saved[0].waza, KifuCore.scanWaza(moves, full).hits.map(({ id, player, ply }) => ({ id, player, ply })));
    await context.captureCompletedRecord();
    assert.equal(saved.length, 1);
});

test('新規対局・保存復元・リセット取り消しで対局 ID を正しく受け渡す', () => {
    const { context } = createGame();
    const id = context.savedState.record.id;
    loadMoves(context, fixture.usi.slice(0, 4));
    context.saveToLocalStorage();
    const saved = context.savedState;
    const snapshot = context.captureResetUndo('button');
    context.initializeBoard();
    assert.notEqual(context.savedState.record.id, id);
    context.resetUndoSnapshot = snapshot;
    context.applyResetUndo();
    assert.equal(context.savedState.record.id, id);
    assert.deepEqual(context.savedState.moves, saved.moves);
    context.restoreState(2);
    assert.equal(context.savedState.record.id, id);
    assert.equal(context.savedState.at, 2);
});

// 駒落ちは駒を減らす側（上手）が後手で先に指す。AI対戦であなたが減らすときは、あなたが後手を受け持つ
for (const [gameMode, handicap, dropSide, aiPlayerSide] of [
    ['ai', 'six', 'opponent', engine.SENTE],
    ['ai', 'rook', 'self', engine.GOTE],
    ['pvp', 'rook', 'opponent', engine.SENTE],
]) {
    test(`${gameMode} の ${dropSide} 駒落ち対局は初手・配置・開始条件を戦績へ残す`, async () => {
        const { context, saved } = createGame({ gameMode, aiPlayerSide });
        context.localMatchPrefs[gameMode] = { handicap, dropSide, time: 'none', side: engine.SENTE };
        context.initializeBoard();
        const initialPosition = { handicap, handicapSide: engine.GOTE, firstPlayer: engine.GOTE };
        const moves = ['3c3d', '7g7f'];
        assert.equal(context.currentPlayer, engine.GOTE);
        assert.deepEqual(context.savedState.initialPosition, initialPosition);
        assert.equal(context.board.flat().filter(Boolean).length, handicap === 'six' ? 34 : 39);
        loadMoves(context, moves);
        context.gameOver = true;
        await context.captureCompletedRecord({ winner: engine.SENTE, reason: 'timeout' });
        assert.equal(saved.length, 1);
        assert.deepEqual(saved[0].initialPosition, initialPosition);
        assert.deepEqual(saved[0].moves, moves);
        assert.equal(saved[0].mode, gameMode === 'pvp' ? 'board' : 'ai');
        assert.equal(saved[0].player, gameMode === 'pvp' ? null : aiPlayerSide);
    });
}

test('AI対戦の駒落ちは、棋譜から指し継いだあとの新しい対局でも選んだ減らす側から手番を決める', () => {
    // 指し継ぎで先手を受け持ったあと（aiPlayerSide が先手のまま）に、好みの「あなたが減らす」で始める
    const { context } = createGame({ gameMode: 'ai', aiPlayerSide: engine.SENTE });
    context.localMatchPrefs.ai = { handicap: 'rook', dropSide: 'self', time: 'none', side: engine.SENTE };
    context.initializeBoard();
    assert.equal(context.aiPlayerSide, engine.GOTE);
    assert.equal(context.currentPlayer, engine.GOTE);
});

test('駒落ちのリセット取り消しは盤・初手・条件・対局IDをまとめて戻す', () => {
    const { context } = createGame({ gameMode: 'pvp' });
    context.localMatchPrefs.pvp = { handicap: 'six', dropSide: 'opponent', time: 'none', side: engine.SENTE };
    context.initializeBoard();
    const initialPosition = { handicap: 'six', handicapSide: engine.GOTE, firstPlayer: engine.GOTE };
    const moves = ['3c3d', '7g7f', '8c8d', '2g2f'];
    loadMoves(context, moves);
    context.saveToLocalStorage();
    const original = context.savedState;
    const snapshot = context.captureResetUndo('settings');
    assert.ok(snapshot);
    assert.deepEqual(snapshot.initialPosition, initialPosition);
    context.localMatchPrefs.pvp = { handicap: 'none', dropSide: 'self', time: 'none', side: engine.SENTE };
    context.initializeBoard();
    assert.equal(context.board.flat().filter(Boolean).length, 40);
    assert.notEqual(context.savedState.record.id, original.record.id);
    context.resetUndoSnapshot = snapshot;
    context.applyResetUndo();
    assert.deepEqual(context.savedState.initialPosition, initialPosition);
    assert.deepEqual(context.savedState.moves, moves);
    assert.equal(context.savedState.record.id, original.record.id);
    assert.equal(context.localMatchPrefs.pvp.handicap, 'six');
    context.restoreState(0);
    assert.equal(context.currentPlayer, engine.GOTE);
    assert.equal(context.board.flat().filter(Boolean).length, 34);
});

test('共有・読込の駒落ち棋譜を閲覧しても、保存済みの実対局を上書きしない', async () => {
    for (const source of ['shared', 'imported']) {
        const { context, saved } = createGame();
        loadMoves(context, fixture.usi.slice(0, 4));
        context.saveToLocalStorage();
        const original = context.savedState;
        const initialPosition = { handicap: 'six', handicapSide: engine.GOTE, firstPlayer: engine.GOTE };
        const moves = ['3c3d', '7g7f'];
        assert.equal(context.loadKifuIntoBoard(moves, moves.length, source, initialPosition), true);
        assert.deepEqual(context.gameInitialPosition(), initialPosition);
        assert.equal(context.board.flat().filter(Boolean).length, 34);
        context.saveToLocalStorage();
        assert.deepEqual(context.savedState, original);
        context.gameOver = true;
        await context.captureCompletedRecord();
        assert.equal(saved.length, 0);
        assert.deepEqual(context.savedState, original);

        // 自分で指し継いだ後は保存が始まるが、共有・読込由来の実績は加算しない。
        context.gameOver = false;
        context.beginPlayFromKifu(engine.GOTE);
        context.saveToLocalStorage();
        assert.equal(context.savedState.record.source, source);
        assert.deepEqual(context.savedState.initialPosition, initialPosition);
        context.gameOver = true;
        await context.captureCompletedRecord();
        assert.equal(saved.length, 0);
    }
});

test('次の対局のために読み直している途中は、消した対局を保存し直さない', () => {
    const { context } = createGame();
    loadMoves(context, fixture.usi.slice(0, 4));
    context.gameOver = true;
    context.saveToLocalStorage();
    assert.notEqual(context.savedState, null);
    // reloadForNextGame は印を立ててから保存を消し、ページを読み直す。離れる途中の保存は無視する
    context.leavingForNextGame = true;
    context.clearLocalStorage();
    context.saveToLocalStorage();
    assert.equal(context.savedState, null, '終わった対局が書き戻されない');
    assert.equal(context.localStorage.getItem('shogi_ai_difficulty'), 'medium', '好みの保存は続ける');
    // 読み直しが中止され、さかのぼって指し直した対局（終わっていない）は保存する
    context.gameOver = false;
    context.saveToLocalStorage();
    assert.notEqual(context.savedState, null, '指し直した対局は保存される');
});

test('待った後の別の手は旧分岐を捨て、最後に残った技だけを渡す', async () => {
    const { context, saved, settle } = createGame({ gameMode: 'pvp' });
    const moves = fixture.usi;
    loadMoves(context, moves);
    context.restoreState(moves.length - 2);
    const replacement = '2e3f';
    const changedMoves = [...moves.slice(0, -2), replacement];
    const replay = KifuCore.replayUsiMoves(changedMoves);
    assert.equal(replay.ok, true);
    context.board = replay.state.board;
    context.capturedPieces = replay.state.capturedPieces;
    context.currentPlayer = replay.state.currentPlayer;
    context.moveCount = changedMoves.length;
    context.saveCurrentState(replacement);
    // 最後の局面で終局が確定した場合。捨てた先の手筋を拾わないことを確認する。
    context.gameOver = true;
    await context.captureCompletedRecord();
    await settle();
    assert.deepEqual(saved[0].moves, changedMoves);
    assert.equal(saved[0].mode, 'board');
    assert.equal(saved[0].player, null);
    assert.deepEqual(saved[0].waza, KifuCore.scanWaza(changedMoves, replay).hits.map(({ id, player, ply }) => ({ id, player, ply })));
});

test('未終了・旧保存・共有と読み込みの指し継ぎは戦績に入れない', async () => {
    const { context, saved } = createGame();
    await context.captureCompletedRecord();
    assert.equal(saved.length, 0);
    context.restoreSavedMoves({ moves: fixture.usi, at: fixture.usi.length });
    await context.captureCompletedRecord();
    for (const source of ['shared', 'imported']) {
        context.loadKifuIntoBoard(fixture.usi, fixture.usi.length - 2, source);
        context.beginPlayFromKifu(engine.SENTE);
        context.saveToLocalStorage();
        const savedState = context.savedState;
        assert.equal(savedState.record.source, source);
        context.restoreSavedMoves(savedState);
        context.gameOver = true;
        await context.captureCompletedRecord();
    }
    assert.equal(saved.length, 0);
});

test('保存失敗は通知し、同じ内容で再試行できる', async () => {
    const { context, saved } = createGame();
    loadMoves(context, fixture.usi);
    let attempts = 0;
    const payloads = [];
    context.testStore.saveGame = async value => {
        payloads.push(structuredClone(value));
        if (++attempts === 1) throw new Error('quota');
        saved.push(structuredClone(value));
        return true;
    };
    await context.captureCompletedRecord();
    const status = context.document.getElementById('records-save-status');
    assert.equal(status.hidden, false);
    assert.match(status.querySelector('.records-save-message').textContent, /保存できませんでした/);
    await context.captureCompletedRecord();
    assert.equal(attempts, 1);
    status.querySelector('.records-save-retry').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(status.hidden, true);
    assert.equal(saved.length, 1);
});

test('保存失敗後に戻る・指し継ぐ・再読み込みしても最初の終局内容を復旧する', async () => {
    const original = createGame({ gameMode: 'pvp' });
    loadMoves(original.context, fixture.usi);
    let attempted;
    original.context.testStore.saveGame = async value => {
        // 保存・再読み込みでは未指定の任意項目がJSONから落ちる。終局の内容全体を比べる。
        attempted = JSON.parse(JSON.stringify(value));
        throw new Error('quota');
    };
    await original.context.captureCompletedRecord();
    original.context.restoreState(fixture.usi.length - 2);
    const savedAtEarlierPly = original.context.savedState;
    const reloaded = createGame({ gameMode: 'pvp' });
    reloaded.context.restoreSavedMoves(savedAtEarlierPly);
    assert.equal(reloaded.context.gameOver, false);
    await reloaded.context.captureCompletedRecord();
    assert.deepEqual(reloaded.saved[0], attempted);

    const changedMoves = [...fixture.usi.slice(0, -2), '2e3f'];
    const reloadedAfterBranch = createGame({ gameMode: 'pvp' });
    reloadedAfterBranch.context.restoreSavedMoves({ ...savedAtEarlierPly, moves: changedMoves, at: changedMoves.length });
    reloadedAfterBranch.context.gameOver = true;
    reloadedAfterBranch.context.currentResultDialogState = { winner: '先手', reason: '千日手' };
    await reloadedAfterBranch.context.captureCompletedRecord();
    assert.deepEqual(reloadedAfterBranch.saved[0], attempted);
});

test('オンラインは権威日時と相手の公開設定を守り、友達の段級位を渡さない', async () => {
    const { context, saved, settle } = createGame({ gameMode: 'online' });
    context.onlineState.usiMoves = fixture.usi;
    context.gameOver = true;
    context.onlineRankLabel = rank => `${rank}級`;
    const match = {
        game_over: true, room_code: 'ROOM', created_at: '2026-09-13T00:00:00Z',
        started_at: '2026-09-13T00:01:00Z', ended_at: '2026-09-13T00:02:00Z',
        match_type: 'matchmaking', winner: engine.GOTE, result_reason: 'checkmate',
        gote_name: '相手', gote_rank: 2, gote_rating: 1800, gote_rank_visible: true,
    };
    context.captureOnlineCompletedRecord({ ...match, started_at: null });
    await settle();
    assert.equal(saved.length, 0);
    context.captureOnlineCompletedRecord(match);
    await settle();
    assert.equal(saved[0].opponentRank, '2級');
    assert.equal(saved[0].opponentRating, 1800);
    context.captureOnlineCompletedRecord({ ...match, room_code: 'HIDDEN', gote_rank_visible: false });
    const initialPosition = { handicap: 'six', handicapSide: engine.GOTE, firstPlayer: engine.GOTE };
    const friend = { ...match, room_code: 'FRIEND', match_type: 'invite', initial_position: initialPosition };
    context.onlineState.match = friend;
    context.onlineState.usiMoves = ['3c3d', '7g7f'];
    context.captureOnlineCompletedRecord(friend);
    await settle();
    assert.equal(saved[1].opponentRank, null);
    assert.equal(saved[1].opponentRating, null);
    assert.equal(saved[2].mode, 'friend');
    assert.equal(saved[2].opponentRank, null);
    assert.equal(saved[2].opponentRating, null);
    assert.deepEqual(saved[2].initialPosition, initialPosition);
    assert.deepEqual(saved[2].moves, ['3c3d', '7g7f']);
});

test('COMは終局メタデータを揃えた明示フックだけで確定し、チュートリアルは除外する', async () => {
    const { context, saved, settle } = createGame({ gameMode: 'online', localOnline: true });
    const moves = fixture.usi;
    loadMoves(context, moves.slice(0, -1));
    context.window.ShogiRecordsStart({
        id: 'online-local:match', mode: 'online', player: engine.SENTE,
        source: 'played', opponentName: 'COM',
    });
    const final = KifuCore.replayUsiMoves(moves).state;
    context.board = final.board;
    context.capturedPieces = final.capturedPieces;
    context.lastMove = final.lastMove;
    context.finalizeMove(moves.at(-1));
    await settle();
    assert.equal(saved.length, 0);
    await context.window.ShogiRecordsCapture({ endedAt: Date.now(), winner: engine.GOTE, reason: 'checkmate' });
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].moves, moves);
    assert.equal(saved[0].opponentName, 'COM');
    context.window.ShogiRecordsStart({ id: 'tutorial', mode: 'online', source: 'legacy' });
    await context.window.ShogiRecordsCapture({ winner: engine.GOTE, reason: 'checkmate' });
    assert.equal(saved.length, 1);
});

test('詰将棋は初回クリアだけを独立記録し、一発正解の既存判定を使う', async () => {
    const { context, tsumeSaved, settle } = createGame({ gameMode: 'tsume' });
    const progress = { lastDate: '', total: 0, streak: 0, days: {} };
    Object.assign(context, {
        tsumeProblems: [{ id: 'problem-a', level: 'beginner', moves: 1 }],
        tsumeDate: '2026-09-13', tsumeCurrent: 0, tsumeStatus: ['unsolved'], tsumeClean: [false],
        tsumeAssisted: [true], tsumeOffLine: false, tsumeSession: 1,
        TSUME_MILESTONES: [10], TSUME_MATE_PAUSE_MS: 400,
        setTsumeThinking() {}, tsumeToast() {}, renderTsumeUi() {},
        tsumeAssistValue() { return 'hint'; }, isTsumeDateToday() { return false; },
        jstToday() { return '2026-09-13'; },
        readTsumeProgress() { return progress; }, writeTsumeProgress() {},
    });
    vm.runInContext(functions(tsumeSource, ['tsumeDayRecord', 'recordTsumeSolved', 'tsumeFinish']), context);
    context.tsumeFinish();
    await settle();
    assert.equal(tsumeSaved.length, 1);
    assert.equal(tsumeSaved[0].problemId, 'problem-a');
    assert.equal(tsumeSaved[0].date, '2026-09-13');
    assert.equal(tsumeSaved[0].moves, 1);
    assert.equal(tsumeSaved[0].firstTry, false);
    context.tsumeFinish();
    await settle();
    assert.equal(tsumeSaved.length, 1);
    assert.equal(progress.total, 1);
    context.tsumeDate = '2026-09-14';
    context.tsumeStatus = ['unsolved'];
    context.tsumeAssisted = [false];
    context.tsumeFinish();
    await settle();
    assert.equal(tsumeSaved.length, 2);
    assert.equal(tsumeSaved[1].firstTry, true);
    assert.equal(tsumeSaved[1].date, '2026-09-14');
});
