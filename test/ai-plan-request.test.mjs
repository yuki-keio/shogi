// SPDX-License-Identifier: GPL-3.0-only

// 達人級以上で戦法を指定した対局の「次の作戦の手」の聞き方（shogi.js）。
// ai-worker が答えない・落ちた・聞いている間に待ったされた、のどれでもAIの手番が止まらないことを見る。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const file = ts.createSourceFile('shogi.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const statement = (name) => {
    const node = file.statements.find(node => (ts.isFunctionDeclaration(node) && node.name?.text === name)
        || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(file) === name)));
    assert.ok(node, `実装の ${name} が見つかる`);
    return node.getText(file);
};
// ワーカーの例外の受け口（名前の無い関数なので、代入の文ごと切り出す）
const onerrorStart = source.indexOf('aiWorker.onerror = function');
const onerror = source.slice(onerrorStart, source.indexOf('\n    };', onerrorStart) + '\n    };'.length);
assert.ok(onerrorStart > 0, '実装の aiWorker.onerror が見つかる');

function createContext({ plan = { id: 'bogin', rests: {}, misses: 0, off: false }, level = 'master' } = {}) {
    const timers = new Map();
    let nextTimer = 1;
    const context = vm.createContext({
        console,
        aiWorker: { sent: [], postMessage(message) { this.sent.push(message); } },
        yaneuraouWorker: { sent: [], postMessage(message) { this.sent.push(message); } },
        aiPlan: plan, aiDifficulty: level, gameMode: 'ai', gameOver: false,
        board: [], capturedPieces: {}, currentPlayer: 'gote', moveCount: 6,
        aiRequestId: 1, yaneuraouAwaitingId: null,
        setTimeout(callback, ms) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        getAIPlayer: () => 'gote',
        isYaneuraouDifficulty: () => true,
        showAIThinkingIndicator() {}, startAiWatchdog() {}, requestStandardAiMove() {},
        recordDiagnosticError() {}, buildErrorSignature: () => '',
        gameInitialPosition: () => ({ handicap: 'none' }),
        getActiveUsiMoves: () => [],
    });
    vm.runInContext(['PLAN_MOVE_TIMEOUT_MS', 'pendingPlanMove', 'pendingPlanChoice', 'askPlanMoveThen', 'settlePlanMove', 'makeAIMove']
        .map(statement).join('\n') + '\n' + onerror, context);
    /** 残っている時間切れを全部起こす */
    context.fireTimers = () => {
        const due = [...timers.values()];
        timers.clear();
        for (const timer of due) timer.callback();
    };
    context.timers = timers;
    return context;
}

const answer = (requestId) => ({ requestId, planMove: '8c8d', planSwing: true, ifUsed: { id: 'bogin' }, ifSkipped: { id: 'bogin' }, ifNone: { id: 'bogin' } });

test('作戦が無い・終えた対局は聞かずにすぐ進める', () => {
    for (const plan of [null, { id: 'bogin', rests: {}, misses: 0, off: true }]) {
        const context = createContext({ plan });
        const got = [];
        context.askPlanMoveThen(1, (info) => got.push(info));
        assert.deepEqual(got, [null]);
        assert.equal(context.aiWorker.sent.length, 0);
    }
});

test('答えが来たら1回だけ進め、遅れて届いた同じ答えや時間切れでは二度進めない', () => {
    const context = createContext();
    const got = [];
    context.askPlanMoveThen(1, (info) => got.push(info));
    assert.equal(context.aiWorker.sent[0].type, 'nextPlanMove');
    assert.equal(context.aiWorker.sent[0].data.requestId, 1);
    context.settlePlanMove(1, answer(1));
    context.settlePlanMove(1, answer(1));
    context.fireTimers();
    assert.equal(got.length, 1);
    assert.equal(got[0].planMove, '8c8d');
});

test('答えが来なければ時間切れで作戦を使わない手番として進め、あとから来た答えは捨てる', () => {
    const context = createContext();
    const got = [];
    context.askPlanMoveThen(1, (info) => got.push(info));
    assert.equal([...context.timers.values()][0].ms, vm.runInContext('PLAN_MOVE_TIMEOUT_MS', context));
    context.fireTimers();
    context.settlePlanMove(1, answer(1));
    assert.deepEqual(got, [null]);
});

test('ai-worker が落ちたら、待っている手番を作戦を使わない手番として進める', () => {
    const context = createContext();
    const got = [];
    context.askPlanMoveThen(1, (info) => got.push(info));
    context.aiWorker.onerror({ message: 'boom' });
    assert.deepEqual(got, [null], '時間切れを待たずに進める');
    context.fireTimers();
    assert.deepEqual(got, [null], '時間切れでもう一度進めない');
});

test('聞いている間に待ったされたら、前の手番の答えではやねうら王に頼まない', () => {
    const context = createContext();
    context.makeAIMove();
    assert.equal(context.aiWorker.sent.length, 1, 'まず ai-worker に次の作戦の手を聞く');
    assert.equal(context.yaneuraouWorker.sent.length, 0);

    // 待った（依頼の番号が進む）。前の手番の答えが届いても、やねうら王には頼まない
    context.aiRequestId = 2;
    context.settlePlanMove(1, answer(1));
    assert.equal(context.yaneuraouWorker.sent.length, 0);

    // 新しい手番は新しく聞き、その答えで作戦の手を添えて頼む
    context.makeAIMove();
    context.settlePlanMove(2, answer(2));
    assert.equal(context.yaneuraouWorker.sent.length, 1);
    assert.equal(context.yaneuraouWorker.sent[0].data.planMove, '8c8d');
    assert.equal(context.yaneuraouWorker.sent[0].data.planSwing, true, '飛車を振る手の印も添える');
    assert.equal(context.yaneuraouWorker.sent[0].data.requestId, 2);
    assert.equal(vm.runInContext('pendingPlanChoice', context).requestId, 2);

    // 前の手番の答えが、新しい手番で聞き直したあとに届いても捨てる
    const late = createContext();
    late.makeAIMove();
    late.aiRequestId = 2;
    late.makeAIMove();
    late.settlePlanMove(1, answer(1));
    assert.equal(late.yaneuraouWorker.sent.length, 0);
    late.settlePlanMove(2, answer(2));
    late.fireTimers();
    assert.equal(late.yaneuraouWorker.sent.length, 1);
});
