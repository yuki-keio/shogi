// SPDX-License-Identifier: GPL-3.0-only

// だれかと対戦の待ち時間の詰将棋（online-match.js）の段の上げ下げと出し直し。
// 実装の関数と定数をそのまま切り出して、盤や画面の部品を持たない vm の中で動かす。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const online = readFileSync(new URL('../online-match.js', import.meta.url), 'utf8');

/** 関数宣言と const 宣言を名前で切り出す */
function declarations(source, names) {
    const file = ts.createSourceFile('online-match.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = new Map();
    function visit(node) {
        if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
            found.set(node.name.text, node.getText(file));
        } else if (ts.isVariableStatement(node)) {
            const decl = node.declarationList.declarations[0];
            if (decl && ts.isIdentifier(decl.name) && names.includes(decl.name.text)) {
                found.set(decl.name.text, node.getText(file).replace(/^const /, 'var '));
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    return names.map((name) => {
        assert.ok(found.has(name), `実装の ${name} が見つかる`);
        return found.get(name);
    }).join('\n');
}

const problem = (id, moves) => ({ id, moves, level: 'x', date: '2026-10-01', sfen: '', line: [] });

function waitTsume({ storage = {}, problems }) {
    const store = new Map(Object.entries(storage));
    const presented = [];
    const context = vm.createContext({
        console,
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
        },
        document: { body: { classList: { add() {}, remove() {} } } },
        els: {},
        mm: { phase: 'seeking' },
        local: { active: false },
        setupTsumePosition: (p) => presented.push(p.id),
        updateWaitBar() {}, updateOnlineUiState() {}, syncCapturedDropState() {}, hideWaitToast() {},
    });
    vm.runInContext(declarations(online, [
        'WAIT_TSUME_LEVEL_KEY', 'WAIT_TSUME_SEEN_KEY', 'WAIT_LEVELS', 'TSUME_LEVEL_MOVES', 'tsc',
        'lsGet', 'getWaitLevel', 'inferInitialWaitLevel', 'bumpWaitLevel', 'readSeenIds', 'rememberSeen',
        'poolForLevel', 'presentNextTsume', 'stopTsumeChallenge',
    ]), context);
    context.tsc.problems = problems;
    return {
        context,
        presented,
        level: () => vm.runInContext('getWaitLevel()', context),
        present: () => vm.runInContext('presentNextTsume()', context),
        stop: () => vm.runInContext('stopTsumeChallenge()', context),
        /** 利用者が何手目まで指したか・まちがえたか（handleTsumeChallengeMove が付ける値） */
        play: ({ ply = 0, busy = false, flawless = true }) => Object.assign(context.tsc, { ply, busy, flawless }),
        miss: () => vm.runInContext('if (tsc.flawless) bumpWaitLevel(-1); tsc.flawless = false;', context),
    };
}

test('最初の段は詰将棋ページで解いた一番長い手数から（記録が無ければ1手）', () => {
    const days = { '2026-10-01': { beginner: 'clean', master: 'solved' }, '2026-10-02': { great: 'shown' } };
    assert.equal(waitTsume({ storage: { shogi_tsume_v1: JSON.stringify({ days }) }, problems: [] }).level(), 9);
    assert.equal(waitTsume({ problems: [] }).level(), 1);
    // 保存した段があればそれを使う（13手まで）
    assert.equal(waitTsume({ storage: { shogi_wait_tsume_level: '13' }, problems: [] }).level(), 13);
    assert.equal(waitTsume({ storage: { shogi_wait_tsume_level: '4' }, problems: [] }).level(), 1);
});

test('その段の在庫が無ければ、短い段を長い順に、それも無ければ長い段を短い順に代用する', () => {
    const t = waitTsume({ storage: { shogi_wait_tsume_level: '11' }, problems: [problem('a', 5), problem('b', 13)] });
    t.present();
    assert.deepEqual(t.presented, ['a']);
    const u = waitTsume({ storage: { shogi_wait_tsume_level: '3' }, problems: [problem('b', 13), problem('c', 9)] });
    u.present();
    assert.deepEqual(u.presented, ['c']);
});

test('まちがえずに途中で終わった問題は、次の待ち時間に1回だけ出し直し、段は下げない', () => {
    const t = waitTsume({ storage: { shogi_wait_tsume_level: '7' }, problems: [problem('a', 7), problem('b', 7)] });
    t.present();
    const first = t.presented[0];
    t.play({ ply: 1 });
    t.stop();
    assert.equal(t.level(), 7);
    t.present();
    assert.equal(t.presented[1], first, '同じ問題を最初から');
    // 出し直しも途中で終わったら1段下げ、それきり出し直さない
    t.play({ ply: 2 });
    t.stop();
    assert.equal(t.level(), 5);
    assert.equal(t.context.tsc.retry, null);
});

test('玉方の応手を待っている間に終わっても「指した」と数える', () => {
    const t = waitTsume({ storage: { shogi_wait_tsume_level: '7' }, problems: [problem('a', 7)] });
    t.present();
    t.play({ ply: 0, busy: true });
    t.stop();
    assert.equal(t.context.tsc.retry?.id, 'a');
});

test('1手も指す前に終わったら段は下げず、出し直しの問題なら次もう一度出す', () => {
    const t = waitTsume({ storage: { shogi_wait_tsume_level: '7' }, problems: [problem('a', 7), problem('b', 7)] });
    t.present();
    t.stop();
    assert.equal(t.level(), 7);
    assert.equal(t.context.tsc.retry, null, 'ふつうの問題は出し直さない');

    t.present();
    const shown = t.presented.at(-1);
    t.play({ ply: 1 });
    t.stop(); // 出し直しが決まる
    t.present();
    assert.equal(t.presented.at(-1), shown);
    t.stop(); // 出し直しを1手も指さずに終えた
    assert.equal(t.level(), 7);
    assert.equal(t.context.tsc.retry?.id, shown);
});

test('まちがえた問題はその場で1段下げ、出し直さず、途中で終わっても追加では下げない', () => {
    const t = waitTsume({ storage: { shogi_wait_tsume_level: '9' }, problems: [problem('a', 9), problem('b', 7)] });
    t.present();
    t.play({ ply: 1 });
    t.miss();
    assert.equal(t.level(), 7);
    t.stop();
    assert.equal(t.level(), 7);
    assert.equal(t.context.tsc.retry, null);
});
