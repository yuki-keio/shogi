// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const online = readFileSync(new URL('../online-match.js', import.meta.url), 'utf8');
const game = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bot_win_kifu.json', import.meta.url), 'utf8'));

function functions(source, names) {
    const file = ts.createSourceFile('browser.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = new Map();
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
            found.set(node.name.text, node.getText(file));
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    return names.map(name => {
        assert.ok(found.has(name), `実装の関数 ${name} が見つかる`);
        return found.get(name);
    }).join('\n');
}

function localGame() {
    const saved = [];
    const dialogs = [];
    const context = vm.createContext({
        console, structuredClone,
        window: { crypto: { randomUUID } },
        local: { active: false, tutorial: false, reqId: 0 },
        onlineState: {},
        mm: {},
        SENTE: 'sente', GOTE: 'gote', LOCAL_ROOM_CODE: 'LOCAL',
        LOCAL_TC_SECONDS: 30, LOCAL_START_BUFFER_MS: 5000,
        board: [], capturedPieces: {}, currentPlayer: 'sente', moveCount: 0,
        gameOver: false, gameMode: 'online', moves: [],
        recordedGame: null, currentResultDialogState: null,
        savedRecordKeys: new Set(), pendingRecordSaves: new Map(),
        GAME_END_REASON_CODES: {},
        deepCopyBoard: structuredClone, deepCopyCaptured: structuredClone,
        getStoredPlayerName: () => 'player', cachedRankIndex: () => 4,
        isRankHidden: () => false, localSideRandom: () => 'sente',
        isTsumeBoard: () => false, isOnlineMode: () => true,
        wazaScanCached: () => null, mapResultReason: reason => reason,
    });
    const noops = ['closeQueueWs', 'stopCountdown', 'stopWatchTimer', 'stopTsumeChallenge',
        'hideSeekUi', 'setPhase', 'armLocalDeadline', 'scheduleComMove', 'clearLocalTimers',
        'markNameGameFinished', 'updateOnlineUiState', 'onTutorialEnd', 'setNewGameLabel', 'reportBotResult'];
    for (const name of noops) context[name] = () => {};
    context.initializeBoard = () => {
        context.recordedGame = null;
        context.gameOver = false;
        context.moves = [];
    };
    context.applyOnlineMatch = (match, { yourSide }) => {
        context.onlineState.match = match;
        context.onlineState.side = yourSide;
    };
    context.kifuAllMoves = () => context.moves;
    context.kifuCurrentPly = () => context.moves.length;
    context.queueRecordSave = (method, key, value) => {
        assert.equal(method, 'saveGame');
        saved.push(structuredClone(value));
        context.savedRecordKeys.add(key);
        return Promise.resolve(true);
    };
    context.showGameOverDialog = (winner, reason) => dialogs.push({ winner, reason });
    vm.runInContext(functions(game, ['startRecordedGame', 'captureCompletedRecord']) + '\n'
        + functions(online, ['buildLocalMatchPayload', 'startLocalMatch', 'localEndGame', 'exitLocalMatch']), context);
    context.window.ShogiRecordsStart = context.startRecordedGame;
    context.window.ShogiRecordsCapture = context.captureCompletedRecord;
    return { context, saved, dialogs };
}

test('COMの最終棋譜と確定結果をオンラインとして1回だけ記録する', () => {
    const { context, saved, dialogs } = localGame();
    context.startLocalMatch({ opponentName: 'COM', tutorial: false });
    const firstId = context.recordedGame.id;
    assert.match(firstId, /^online-local:/);
    assert.equal(context.recordedGame.startedAt, Date.parse(context.onlineState.match.started_at));
    assert.equal(saved.length, 0);

    // 詰みのダイアログが先に出ても、ローカル対局の結果確定から保存する。
    context.moves = fixture.usi.slice();
    context.gameOver = true;
    context.localEndGame('gote', 'checkmate', { dialogAlreadyShown: true });
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].moves, fixture.usi);
    assert.equal(saved[0].mode, 'online');
    assert.equal(saved[0].player, 'sente');
    assert.equal(saved[0].winner, 'gote');
    assert.equal(saved[0].reason, 'checkmate');
    assert.equal(saved[0].opponentName, 'COM');
    assert.equal(saved[0].opponentRank, null);
    assert.equal(saved[0].opponentRating, null);
    assert.equal(dialogs.length, 0);
    const endedAt = context.onlineState.match.ended_at;
    context.localEndGame('sente', 'timeout');
    assert.equal(saved.length, 1);
    assert.equal(context.onlineState.match.ended_at, endedAt);
    assert.equal(context.onlineState.match.winner, 'gote');

    context.startLocalMatch({ opponentName: 'COM', tutorial: false });
    assert.notEqual(context.recordedGame.id, firstId);
    assert.equal(saved.length, 1);
});

test('COMの時間切れは結果表示より前に理由を確定して記録する', () => {
    const { context, saved, dialogs } = localGame();
    context.startLocalMatch({ opponentName: 'COM', tutorial: false });
    context.localEndGame('gote', 'timeout');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reason, 'timeout');
    assert.equal(saved[0].winner, 'gote');
    assert.equal(saved[0].endedAt, Date.parse(context.onlineState.match.ended_at));
    assert.equal(dialogs.length, 1);
});

test('チュートリアルと未終了で閉じたCOM対局は通常戦績に含めない', () => {
    const { context, saved } = localGame();
    context.startLocalMatch({ opponentName: 'COM', tutorial: true });
    assert.equal(context.recordedGame.source, 'legacy');
    context.localEndGame('sente', 'checkmate');
    assert.equal(saved.length, 0);

    context.startLocalMatch({ opponentName: 'COM', tutorial: false });
    context.exitLocalMatch();
    context.localEndGame('gote', 'timeout');
    assert.equal(saved.length, 0);
});
