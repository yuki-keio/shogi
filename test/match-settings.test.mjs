// SPDX-License-Identifier: GPL-3.0-only

// 設定の「対局」の欄：閉じたときに始め直すかどうかを決める判定。
// ここが狂うと「何も変えていないのに対局が消える」「変えたのに反映されない」になる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as KifuCore from '../src/kifu/browser.ts';

const source = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const file = ts.createSourceFile('shogi.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ['normalizedMatchPref', 'currentMatchConditions', 'sameMatchConditions', 'aiSideForConditions', 'hasLocalGameInProgress', 'isValidFriendTcValue']
    .map(name => {
        const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(node, `実装の関数 ${name} が見つかる`);
        return node.getText(file);
    }).join('\n');
const timeOptions = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'FRIEND_TC_OPTIONS'));
assert.ok(timeOptions, '実装の時間設定一覧が見つかる');

const PREF = { handicap: 'none', dropSide: 'opponent', time: 'none', side: 'sente' };

function createContext({ mode = 'ai', human = 'sente', initial, clock = null, prefs = {}, plies = 0, over = false, lastOver = false } = {}) {
    const context = vm.createContext({
        SENTE: 'sente', GOTE: 'gote', KifuCore,
        gameMode: mode, aiPlayerSide: human,
        currentInitialPosition: KifuCore.normalizeInitialPosition(initial),
        localClock: clock ? { value: clock } : null,
        localMatchPrefs: { ai: { ...PREF, ...prefs }, pvp: { ...PREF, ...prefs } },
        gameOver: over,
        moveHistory: [{ gameOver: false }, { gameOver: lastOver }],
        kifuTotalPlies: () => plies,
    });
    vm.runInContext(timeOptions.getText(file) + '\n' + functions, context);
    return context;
}

test('同じ条件なら始め直さない。欄で選べる項目が違えば始め直す', () => {
    const { sameMatchConditions } = createContext();
    const base = { handicap: 'none', dropSide: 'opponent', time: 'none', side: 'sente' };
    assert.equal(sameMatchConditions(base, { ...base }), true);
    assert.equal(sameMatchConditions(base, { ...base, time: 'per_move:30' }), false);
    assert.equal(sameMatchConditions(base, { ...base, side: 'gote' }), false);
    assert.equal(sameMatchConditions(base, { ...base, handicap: 'two' }), false);
    // 平手では「駒を減らす側」は欄に出ていないので、違っていても始め直さない
    assert.equal(sameMatchConditions(base, { ...base, dropSide: 'self' }), true);
    const dropped = { ...base, handicap: 'two' };
    assert.equal(sameMatchConditions(dropped, { ...dropped, dropSide: 'self' }), false);
    // 駒落ちでは手番の選択肢を隠しているので、手番の違いでは始め直さない
    assert.equal(sameMatchConditions(dropped, { ...dropped, side: 'gote' }), true);
});

test('欄には好みではなく、いま盤にある対局の条件を出す', () => {
    // 共有棋譜から指し継いだ2枚落ち（好みは平手のまま）。上手（AI）が後手
    const kifu = createContext({ human: 'sente', prefs: { handicap: 'none' }, clock: 'total:180',
        initial: { handicap: 'two', handicapSide: 'gote', firstPlayer: 'gote' } });
    const shown = kifu.currentMatchConditions();
    assert.equal(shown.handicap, 'two');
    assert.equal(shown.dropSide, 'opponent');
    assert.equal(shown.time, 'total:180');
    // 自分が駒を落としている対局
    const self = createContext({ human: 'gote', initial: { handicap: 'bishop', handicapSide: 'gote', firstPlayer: 'gote' } });
    assert.equal(self.currentMatchConditions().dropSide, 'self');
    // 駒落ちの手番は欄に無いので、平手で選んでいた手番を引き継ぐ（平手に戻したときに使う）
    assert.equal(self.currentMatchConditions().side, 'sente');
    // 時計が無ければ時間制限なし。AI対戦の手番は aiPlayerSide
    const plain = createContext({ human: 'gote' });
    assert.deepEqual({ ...plain.currentMatchConditions() }, { handicap: 'none', dropSide: 'opponent', time: 'none', side: 'gote' });
});

test('AI対戦の駒落ちは、駒を減らす側（上手）が後手。あなたが減らすならあなたが後手', () => {
    const { aiSideForConditions } = createContext();
    assert.equal(aiSideForConditions({ ...PREF, handicap: 'rook', dropSide: 'self', side: 'sente' }), 'gote');
    assert.equal(aiSideForConditions({ ...PREF, handicap: 'rook', dropSide: 'opponent', side: 'gote' }), 'sente');
    assert.equal(aiSideForConditions({ ...PREF, side: 'gote' }), 'gote');
});

test('将棋盤は手番も減らす側も欄に無いので、駒落ちと時間だけで見比べる', () => {
    const { sameMatchConditions } = createContext({ mode: 'pvp' });
    const base = { handicap: 'none', dropSide: 'opponent', time: 'none', side: 'sente' };
    assert.equal(sameMatchConditions(base, { ...base, side: 'gote' }), true);
    assert.equal(sameMatchConditions({ ...base, handicap: 'two' }, { ...base, handicap: 'two', dropSide: 'self' }), true);
    assert.equal(sameMatchConditions(base, { ...base, handicap: 'two' }), false);
    assert.equal(sameMatchConditions(base, { ...base, time: 'per_move:30' }), false);
});

test('対局中かどうか：1手以上・終局前だけ。終局後に戻って見ている間も終わった扱い', () => {
    assert.equal(createContext({ plies: 0 }).hasLocalGameInProgress(), false);
    assert.equal(createContext({ plies: 1 }).hasLocalGameInProgress(), true);
    assert.equal(createContext({ plies: 5, over: true }).hasLocalGameInProgress(), false);
    assert.equal(createContext({ plies: 5, lastOver: true }).hasLocalGameInProgress(), false);
});
