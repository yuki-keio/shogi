// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as KifuCore from '../src/kifu/browser.ts';

const source = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const file = ts.createSourceFile('shogi.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const clockFunctions = [
    'localClockMatch', 'settleLocalClock', 'pauseLocalClock', 'resumeLocalClock', 'resetLocalClock',
    'advanceLocalClock', 'savedLocalClock', 'restoreLocalClock', 'checkLocalTimeout', 'finishLocalTimeout',
    'isValidFriendTcValue', 'markLatestStateGameOver', 'syncLocalClockVisibility',
    'restoreState', 'saveCurrentState', 'deepCopyBoard', 'deepCopyCaptured', 'getBoardHash', 'updateInfo',
].map(name => {
    const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, `実装の関数 ${name} が見つかる`);
    return node.getText(file);
}).join('\n');
const timeOptions = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'FRIEND_TC_OPTIONS'));
assert.ok(timeOptions, '実装の時間設定一覧が見つかる');

function createClock({ mode = 'ai', human = 'sente', turn = 'sente', time = 'total:180', at = 0, historyLength = 1, shared = false } = {}) {
    let now = Date.UTC(2026, 9, 6, 12);
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const effects = [];
    const saves = [];
    const initial = KifuCore.createInitialGameState();
    const lane = () => ({ classList: { toggle() {} } });
    const context = vm.createContext({
        Date: ClockDate,
        SENTE: 'sente', GOTE: 'gote',
        gameMode: mode, aiPlayerSide: human, currentPlayer: turn,
        gameOver: false, isViewingSharedKifu: shared,
        currentHistoryIndex: at,
        board: structuredClone(initial.board), capturedPieces: structuredClone(initial.capturedPieces),
        moveCount: 0, lastMove: null, isCheck: false, checkmate: false,
        positionHistory: [], checkHistory: [], usiMoveHistory: [],
        moveHistory: Array.from({ length: historyLength }, () => ({ gameOver: false,
            board: structuredClone(initial.board), capturedPieces: structuredClone(initial.capturedPieces),
            currentPlayer: turn, moveCount: 0, lastMove: null, isCheck: false })),
        currentTurnElement: {}, moveCountElement: {},
        capturedWhiteLaneElement: lane(), capturedBlackLaneElement: lane(),
        settingsModal: { style: { display: 'none' } },
        document: { visibilityState: 'visible' },
        localMatchPrefs: { ai: { time }, pvp: { time } },
        localClock: null, aiRequestId: 10,
        updateClockUi: () => effects.push(['clockUi']),
        showGameOverDialog: (winner, reason) => effects.push(['result', winner, reason]),
        captureCompletedRecord: () => effects.push(['record']),
        saveToLocalStorage: () => saves.push({ gameOver: context.gameOver, clock: structuredClone(context.savedLocalClock()) }),
    });
    for (const name of ['clearAiMoveDelayTimer', 'clearAiWatchdog', 'hideAIThinkingIndicator', 'hidePromoteDialog',
        'clearSelection', 'renderBoard', 'updateHistoryButtons', 'recomputeKingPosCache', 'clearMoveHint',
        'hideGameOverDialog', 'renderCapturedPieces', 'noticeOpponentTurnIfStuck', 'scheduleAIMoveIfNeeded',
        'renderKifuBar', 'updatePlayerBarTurn']) {
        context[name] = () => effects.push([name]);
    }
    context.isOnlineMode = () => context.gameMode === 'online';
    context.sideName = side => side === 'sente' ? '先手' : '後手';
    vm.runInContext(timeOptions.getText(file) + '\n' + clockFunctions, context);
    return {
        context, effects, saves,
        now: () => now,
        elapse(ms) { now += ms; },
        move() {
            context.currentPlayer = context.currentPlayer === 'sente' ? 'gote' : 'sente';
            context.advanceLocalClock();
            context.moveHistory.push({ gameOver: false });
            context.currentHistoryIndex = context.moveHistory.length - 1;
            context.resumeLocalClock();
        },
    };
}

const banks = context => structuredClone(context.localClock.remaining);
const startClock = context => { context.resetLocalClock(); context.resumeLocalClock(); };
// 最初の1手は時間を数えないので、減り方そのものを見るテストは両者が1手ずつ指した後の時計で始める
const markMoved = context => { context.localClock.moved = { sente: true, gote: true }; };
const startRunningClock = context => { context.resetLocalClock(); markMoved(context); context.resumeLocalClock(); };

function createHistoryClock(options = {}) {
    const game = createClock({ mode: 'pvp', ...options });
    const { context } = game;
    context.moveHistory = [];
    context.currentHistoryIndex = -1;
    context.resetLocalClock();
    markMoved(context);
    context.saveCurrentState();
    context.updateInfo();
    game.recordMove = usi => {
        const moves = [...context.usiMoveHistory.slice(0, context.currentHistoryIndex), usi];
        const replay = KifuCore.replayUsiMoves(moves);
        assert.equal(replay.ok, true, '時計テストでも実際に指せる手で進める');
        for (const key of ['board', 'capturedPieces', 'currentPlayer', 'lastMove', 'moveCount', 'isCheck']) {
            context[key] = structuredClone(replay.state[key]);
        }
        context.advanceLocalClock();
        context.saveCurrentState(usi);
        context.updateInfo();
    };
    return game;
}

test('AI対戦は人間の手番だけ総持ち時間が減り、AIの思考時間を人間に加算しない', () => {
    const game = createClock();
    const { context } = game;
    startRunningClock(context);
    game.elapse(4000);
    game.move();
    assert.deepEqual(banks(context), { sente: 176000, gote: 180000 });
    assert.equal(context.localClock.startedAt, 0);
    game.elapse(20000);
    game.move();
    game.elapse(2000);
    context.settleLocalClock();
    assert.deepEqual(banks(context), { sente: 174000, gote: 180000 });
});

test('人間が後手でも、AIの初手のあと人間が最初の1手を指すまでは時計が動かない', () => {
    const game = createClock({ human: 'gote', turn: 'sente' });
    const { context } = game;
    startClock(context);
    assert.equal(context.localClock.startedAt, 0);
    game.elapse(9000);
    game.move(); // AIの初手
    assert.equal(context.localClock.startedAt, 0, '人間はまだ1手も指していない');
    game.elapse(60000);
    game.move(); // 人間の最初の1手（数えない）
    game.move(); // AI
    assert.equal(context.localClock.startedAt, game.now(), '2手目から動く');
    game.elapse(6000);
    context.settleLocalClock();
    assert.deepEqual(banks(context), { sente: 180000, gote: 174000 });
});

test('最初の1手は時間を数えない（AI対戦・将棋盤とも、それぞれの最初の1手）', () => {
    const ai = createClock({ time: 'per_move:10' });
    startClock(ai.context);
    ai.elapse(60000);
    assert.equal(ai.context.checkLocalTimeout(), false, '対局を始めただけでは時間切れにならない');
    assert.equal(ai.context.localClock.remaining.sente, 10000);
    ai.move(); // 人間の最初の1手
    ai.move(); // AI
    assert.equal(ai.context.localClock.startedAt, ai.now());
    ai.elapse(10000);
    assert.equal(ai.context.checkLocalTimeout(), true, '2手目からは時間を数える');

    const board = createClock({ mode: 'pvp', time: 'total:180' });
    startClock(board.context);
    board.elapse(30000);
    board.move(); // 先手の最初の1手
    assert.equal(board.context.localClock.startedAt, 0, '後手もまだ指していない');
    board.elapse(30000);
    board.move(); // 後手の最初の1手
    assert.equal(board.context.localClock.startedAt, board.now());
    board.elapse(5000);
    board.move();
    assert.deepEqual(banks(board.context), { sente: 175000, gote: 180000 });
});

test('将棋盤は両者の総持ち時間がそれぞれ減り、前の手で使った時間を引き継ぐ', () => {
    const game = createClock({ mode: 'pvp', time: 'total:600' });
    const { context } = game;
    startRunningClock(context);
    game.elapse(3000);
    game.move();
    assert.deepEqual(banks(context), { sente: 597000, gote: 600000 });
    game.elapse(7000);
    game.move();
    game.elapse(2000);
    context.settleLocalClock();
    assert.deepEqual(banks(context), { sente: 595000, gote: 593000 });
});

test('1手ごとの時間は指し終わると次の手のために全額へ戻る', () => {
    const game = createClock({ mode: 'pvp', time: 'per_move:30' });
    const { context } = game;
    startRunningClock(context);
    game.elapse(12000);
    assert.equal(Date.parse(context.localClockMatch().turn_deadline) - game.now(), 18000);
    game.move();
    assert.deepEqual(banks(context), { sente: 30000, gote: 30000 });
    assert.equal(Date.parse(context.localClockMatch().turn_deadline) - game.now(), 30000);
    game.elapse(7000);
    game.move();
    assert.deepEqual(banks(context), { sente: 30000, gote: 30000 });
});

test('再開を繰り返しても開始時刻を伸ばさず、停止後に経過を二重に引かない', () => {
    const game = createClock({ time: 'per_move:30' });
    const { context } = game;
    startRunningClock(context);
    const start = context.localClock.startedAt;
    game.elapse(2000);
    context.resumeLocalClock();
    assert.equal(context.localClock.startedAt, start);
    game.elapse(3000);
    context.pauseLocalClock();
    assert.equal(context.localClock.remaining.sente, 25000);
    game.elapse(60000);
    context.pauseLocalClock();
    context.settleLocalClock();
    assert.equal(context.localClock.remaining.sente, 25000);
    assert.equal(context.localClockMatch().turn_deadline, null);
});

test('開き直した時計は閉じていた時間を引かず、それぞれ次の1手を指すまで止めておく', () => {
    const original = createClock({ mode: 'pvp' });
    startRunningClock(original.context);
    original.elapse(5000);
    const saved = structuredClone(original.context.savedLocalClock());
    assert.ok(saved.startedAt > 0, '動いている途中で保存した');
    const restored = createClock({ mode: 'pvp' });
    restored.elapse(60000);
    restored.context.restoreLocalClock(saved);
    assert.equal(restored.context.localClock.startedAt, 0);
    assert.equal(restored.context.localClockMatch().turn_deadline, null);
    restored.elapse(60000);
    assert.equal(restored.context.checkLocalTimeout(), false, '開いただけでは減らない');
    assert.equal(restored.context.localClock.remaining.sente, 180000, '閉じていた間も引かない');
    restored.move(); // 先手が開き直してから最初の1手
    restored.move(); // 後手が開き直してから最初の1手
    assert.equal(restored.context.localClock.startedAt, restored.now());
    restored.elapse(4000);
    restored.context.settleLocalClock();
    assert.equal(restored.context.localClock.remaining.sente, 176000);
    assert.equal(saved.remaining.sente, 180000, '復元しても保存データを変更しない');
});

test('設定を開いて停止すると保存も更新され、時間超過後のリロードで停止中の時間を引かない', () => {
    const original = createClock({ time: 'per_move:10' });
    startRunningClock(original.context);
    original.elapse(3000);
    const savesBeforePause = original.saves.length;
    original.context.settingsModal.style.display = 'flex';
    original.context.pauseLocalClock();
    assert.equal(original.saves.length, savesBeforePause + 1, '停止操作そのものが保存を更新する');
    const saved = structuredClone(original.saves.at(-1).clock);
    assert.equal(saved.startedAt, 0);
    assert.equal(saved.remaining.sente, 7000);

    original.elapse(20000);
    const restored = createClock({ time: 'per_move:10' });
    restored.elapse(23000);
    restored.context.restoreLocalClock(saved);
    assert.equal(restored.context.gameOver, false);
    assert.equal(restored.context.localClock.remaining.sente, 7000);
    assert.equal(restored.context.localClock.startedAt, 0, '開き直した直後は次の1手まで止めておく');
    restored.elapse(60000);
    assert.equal(restored.context.checkLocalTimeout(), false);
});

test('過去の棋譜を見る間は停止し、最新の局面へ戻った後だけ再開する', () => {
    const game = createClock({ mode: 'pvp', historyLength: 3, at: 2 });
    const { context } = game;
    startRunningClock(context);
    game.elapse(4000);
    context.pauseLocalClock();
    context.currentHistoryIndex = 1;
    context.resumeLocalClock();
    game.elapse(60000);
    assert.equal(context.checkLocalTimeout(), false);
    context.settleLocalClock();
    assert.equal(context.localClock.remaining.sente, 176000);
    assert.equal(context.localClock.startedAt, 0);
    context.currentHistoryIndex = 2;
    context.resumeLocalClock();
    game.elapse(3000);
    context.settleLocalClock();
    assert.equal(context.localClock.remaining.sente, 173000);
});

test('過去局面で復元した時計と設定を開いている間の時計は動かない', () => {
    const original = createClock({ mode: 'pvp', historyLength: 2, at: 1 });
    startRunningClock(original.context);
    const saved = structuredClone(original.context.savedLocalClock());
    const restored = createClock({ mode: 'pvp', historyLength: 2, at: 0 });
    restored.elapse(60000);
    restored.context.restoreLocalClock(saved);
    markMoved(restored.context);
    assert.equal(restored.context.localClock.startedAt, 0);
    restored.context.resumeLocalClock();
    assert.equal(restored.context.localClock.startedAt, 0);
    restored.context.currentHistoryIndex = 1;
    restored.context.settingsModal.style.display = 'flex';
    restored.context.resumeLocalClock();
    assert.equal(restored.context.localClock.startedAt, 0);
    restored.context.settingsModal.style.display = 'none';
    restored.context.resumeLocalClock();
    assert.equal(restored.context.localClock.startedAt, restored.now());
});

test('共有棋譜・時間制限なしでは時計を作らない', () => {
    for (const options of [{ shared: true }, { time: 'none' }]) {
        const { context } = createClock(options);
        startClock(context);
        assert.equal(context.localClock, null);
        assert.equal(context.localClockMatch(), null);
        assert.equal(context.savedLocalClock(), undefined);
        assert.equal(context.checkLocalTimeout(), false);
    }
});

test('時間が尽きた瞬間に一度だけ終局し、AI・成りの保留を取消して結果と保存を確定する', () => {
    const game = createClock({ time: 'per_move:30', historyLength: 2, at: 1 });
    const { context, effects, saves } = game;
    startRunningClock(context);
    effects.length = 0;
    saves.length = 0;
    game.elapse(29999);
    assert.equal(context.checkLocalTimeout(), false);
    game.elapse(1);
    assert.equal(context.checkLocalTimeout(), true);
    assert.equal(context.gameOver, true);
    assert.equal(context.localClock.remaining.sente, 0);
    assert.equal(context.localClock.expiredSide, 'sente');
    assert.equal(context.aiRequestId, 11);
    assert.equal(context.moveHistory[0].gameOver, false);
    assert.equal(context.moveHistory[1].gameOver, true);
    assert.deepEqual(effects.filter(([kind]) => kind === 'result'), [['result', '後手', '時間切れ']]);
    for (const name of ['record', 'clearAiMoveDelayTimer', 'clearAiWatchdog', 'hideAIThinkingIndicator', 'hidePromoteDialog', 'clearSelection']) {
        assert.equal(effects.filter(([kind]) => kind === name).length, 1);
    }
    assert.equal(saves.length, 1);
    assert.equal(saves[0].gameOver, true);
    assert.equal(saves[0].clock.expiredSide, 'sente');
    assert.equal(context.checkLocalTimeout(), false);
    context.finishLocalTimeout('sente');
    game.elapse(10000);
    context.resumeLocalClock();
    assert.equal(context.localClock.startedAt, 0);
    assert.equal(context.aiRequestId, 11);
    assert.equal(saves.length, 1);
    assert.equal(effects.filter(([kind]) => kind === 'record').length, 1);
});

test('時間切れの保存を復元すると終局を維持し、終了処理を再実行しない', () => {
    const original = createClock({ mode: 'pvp', turn: 'gote', time: 'per_move:10' });
    startRunningClock(original.context);
    original.elapse(10000);
    original.context.checkLocalTimeout();
    const saved = structuredClone(original.context.savedLocalClock());
    const restored = createClock({ mode: 'pvp', turn: 'gote', time: 'per_move:10' });
    restored.context.restoreLocalClock(saved);
    assert.equal(restored.context.gameOver, true);
    assert.equal(restored.context.moveHistory[0].gameOver, true);
    assert.equal(restored.context.localClock.expiredSide, 'gote');
    assert.equal(restored.context.checkLocalTimeout(), false);
    assert.equal(restored.effects.filter(([kind]) => kind === 'result' || kind === 'record').length, 0);
});

test('不正な保存値を拒否し、有効な履歴の時計だけ復元する', () => {
    for (const value of [
        { value: 'total:1', remaining: { sente: 1000, gote: 1000 } },
        { value: 'none', remaining: { sente: 0, gote: 0 } },
        { value: 'total:180', remaining: { sente: -1, gote: 180000 } },
        { value: 'total:180', remaining: { sente: 180001, gote: 180000 } },
        { value: 'total:180', remaining: { sente: '180000', gote: 180000 } },
    ]) {
        const { context } = createClock();
        context.restoreLocalClock(value);
        assert.equal(context.localClock, null);
    }
    const { context } = createClock({ historyLength: 3, at: 2 });
    context.restoreLocalClock({ value: 'total:180', remaining: { sente: 120000, gote: 140000 },
        startedAt: 0, history: [[180000, 180000], [170000, -1], [120000, 140000]] });
    assert.deepEqual(structuredClone(context.moveHistory[0].clockBanks), [180000, 180000]);
    assert.equal(context.moveHistory[1].clockBanks, undefined);
    assert.deepEqual(structuredClone(context.moveHistory[2].clockBanks), [120000, 140000]);
});

test('restoreStateで最新の経過時間を保存し、過去から最新へ戻っても時計を巻き戻さない', () => {
    for (const mode of ['ai', 'pvp']) {
        const game = createHistoryClock({ mode });
        const { context } = game;
        game.elapse(4000);
        game.recordMove('7g7f');
        game.elapse(6000);
        game.recordMove('3c3d');
        game.elapse(5000);
        context.restoreState(1);
        const goteBank = mode === 'pvp' ? 174000 : 180000;
        assert.deepEqual(structuredClone(context.moveHistory[2].clockBanks), [171000, goteBank]);
        assert.deepEqual(banks(context), { sente: 176000, gote: 180000 });
        assert.equal(context.currentPlayer, 'gote');
        assert.equal(context.localClock.startedAt, 0);

        game.elapse(60000);
        context.restoreState(2);
        assert.deepEqual(banks(context), { sente: 171000, gote: goteBank });
        assert.equal(context.localClock.startedAt, game.now());
        assert.equal(context.currentPlayer, 'sente');
        game.elapse(1000);
        context.restoreState(1);
        context.restoreState(2);
        assert.deepEqual(banks(context), { sente: 170000, gote: goteBank });
        assert.deepEqual(structuredClone(context.moveHistory[2].clockBanks), [170000, goteBank]);
    }
});

test('過去局面から別の手を指すと、その局面の時計を引き継ぎ古い分岐を捨てる', () => {
    for (const mode of ['ai', 'pvp']) {
        const game = createHistoryClock({ mode });
        const { context } = game;
        game.elapse(4000);
        game.recordMove('7g7f');
        game.elapse(6000);
        game.recordMove('3c3d');
        game.elapse(5000);
        context.restoreState(1);
        const oldLatest = context.moveHistory[2];
        assert.equal(oldLatest.clockBanks[0], 171000);
        game.elapse(60000);
        game.recordMove('8c8d');
        assert.deepEqual(structuredClone(context.usiMoveHistory), ['7g7f', '8c8d']);
        assert.equal(context.moveHistory.length, 3);
        assert.notEqual(context.moveHistory[2], oldLatest);
        assert.deepEqual(structuredClone(context.moveHistory[2].clockBanks), [176000, 180000]);
        assert.deepEqual(banks(context), { sente: 176000, gote: 180000 });
        assert.equal(context.localClock.startedAt, game.now());
        game.elapse(2000);
        context.settleLocalClock();
        assert.deepEqual(banks(context), { sente: 174000, gote: 180000 });
    }
});

test('時間切れ後に過去へ戻って保存しても期限切れ側と最新局面の0秒が残る', () => {
    const game = createHistoryClock({ time: 'per_move:10' });
    const { context, effects, saves } = game;
    game.elapse(2000);
    game.recordMove('7g7f');
    game.elapse(3000);
    game.recordMove('3c3d');
    game.elapse(10000);
    assert.equal(context.checkLocalTimeout(), true);
    assert.equal(context.localClock.expiredSide, 'sente');
    assert.deepEqual(structuredClone(context.moveHistory[2].clockBanks), [0, 10000]);

    context.restoreState(1);
    assert.equal(context.gameOver, false, '過去の局面は閲覧できる');
    assert.equal(context.localClock.startedAt, 0);
    assert.deepEqual(banks(context), { sente: 10000, gote: 10000 });
    const saved = structuredClone(context.savedLocalClock());
    assert.equal(saved.expiredSide, 'sente');
    assert.deepEqual(saved.history[2], [0, 10000]);
    assert.equal(saves.at(-1).clock.expiredSide, 'sente');

    const reloaded = createClock({ mode: 'pvp', time: 'per_move:10', turn: 'gote', historyLength: 3, at: 1 });
    reloaded.context.restoreLocalClock(saved);
    assert.equal(reloaded.context.gameOver, false);
    assert.equal(reloaded.context.moveHistory[2].gameOver, true);
    assert.equal(reloaded.context.localClock.expiredSide, 'sente');
    reloaded.context.restoreState(2);
    assert.equal(reloaded.context.gameOver, true);
    assert.equal(reloaded.context.localClock.remaining.sente, 0);
    assert.equal(reloaded.context.localClock.startedAt, 0);
    assert.equal(reloaded.context.checkLocalTimeout(), false);

    game.elapse(60000);
    context.restoreState(2);
    assert.equal(context.gameOver, true);
    assert.equal(context.localClock.remaining.sente, 0);
    assert.equal(context.localClock.startedAt, 0);
    assert.equal(effects.filter(([kind]) => kind === 'record').length, 1);
    assert.equal(effects.filter(([kind]) => kind === 'result').length, 1);
});

test('別のタブ・アプリに切り替えている間は止まり、戻ると続きから動く', () => {
    const game = createClock({ mode: 'pvp', time: 'total:180' });
    const { context } = game;
    startRunningClock(context);
    game.elapse(3000);
    context.document.visibilityState = 'hidden';
    context.syncLocalClockVisibility();
    assert.equal(context.localClock.startedAt, 0);
    assert.equal(context.localClock.remaining.sente, 177000);
    game.elapse(120000);
    context.resumeLocalClock();
    assert.equal(context.localClock.startedAt, 0, '隠れている間はほかの経路からも再開しない');
    context.document.visibilityState = 'visible';
    context.syncLocalClockVisibility();
    assert.equal(context.localClock.startedAt, game.now());
    game.elapse(2000);
    context.settleLocalClock();
    assert.equal(context.localClock.remaining.sente, 175000);
});

test('止まっている時計（終局後・最初の1手待ち）は、画面が裏に回っても保存しない', () => {
    // ページを離れるときにも hidden が来る。読み直しで消した終局済みの対局を保存し直さないため
    const over = createClock({ time: 'per_move:10', historyLength: 2, at: 1 });
    startRunningClock(over.context);
    over.elapse(10000);
    assert.equal(over.context.checkLocalTimeout(), true);
    const savesAfterEnd = over.saves.length;
    over.context.document.visibilityState = 'hidden';
    over.context.syncLocalClockVisibility();
    assert.equal(over.saves.length, savesAfterEnd);

    const waiting = createClock({ time: 'per_move:10' });
    startClock(waiting.context);
    const savesBefore = waiting.saves.length;
    waiting.context.document.visibilityState = 'hidden';
    waiting.context.syncLocalClockVisibility();
    assert.equal(waiting.saves.length, savesBefore);
});
