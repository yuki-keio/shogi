// SPDX-License-Identifier: GPL-3.0-only

// ページを開いた直後の「保存データが消えていたら控えから戻す」処理（shogi.js）。
// 通信の成功・控え無し・失敗・待ちきれない場合を、通信と保存用ファイルを差し替えて確かめる。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
const functions = names => {
    const file = ts.createSourceFile('shogi.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return names.map(name => {
        const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(node, `実装の関数 ${name} が見つかる`);
        return node.getText(file);
    }).join('\n');
};
const constant = name => {
    const match = source.match(new RegExp(`^const ${name} = [^;]+;`, 'm'));
    assert.ok(match, `定数 ${name} が見つかる`);
    return match[0];
};
// 保存用ファイルの読み込みは、差し替えた関数を呼ぶ形に置き換える（vm では import() を使えないため）
const code = [
    constant('RESTORE_LOCAL_KEY'), constant('RESTORE_RECORDS_KEY'), constant('RESTORE_WAIT_MS'),
    'var restoredProfile;',
    functions(['backupCookieUid', 'detectLostStorage', 'trackStorageRestore', 'restoreLostSettings']),
].join('\n').replace("import('/records-store.js')", 'importStore()');
assert.ok(code.includes('importStore()'), '保存用ファイルの読み込みを差し替えられる');

const UID = 'c4eafa94-e894-43f5-8e55-50990c4bee63';

function setup({ storage = {}, cookie = `a=1; __Host-shogi_uid=${UID}`, fetch }) {
    const map = new Map(Object.entries(storage));
    const tracked = [];
    const applied = [];
    let fireDeadline = null;
    const context = vm.createContext({
        Promise, JSON, Error, AbortController,
        localStorage: {
            getItem: key => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => map.set(key, String(value)),
            removeItem: key => map.delete(key),
        },
        document: { cookie },
        performance: { now: () => 0 },
        fetch,
        importStore: async () => ({ applyBackupProfile: profile => applied.push(profile) }),
        setTimeout: (callback, _ms, value) => { fireDeadline = () => callback(value); return 1; },
        clearTimeout: () => { fireDeadline = null; },
        track: (name, params) => tracked.push({ name, ...params }),
        reloadPreferencesReadAtLoad: () => {},
    });
    vm.runInContext(code, context);
    return { context, map, tracked, applied, fireDeadline: () => fireDeadline?.() };
}

const respond = body => async () => ({ ok: true, json: async () => body });

test('保存データが残っている人には何もしない（通信もしない）', () => {
    let fetched = false;
    const { context } = setup({ storage: { shogi_online_uid: UID }, fetch: async () => { fetched = true; } });
    assert.equal(context.restoreLostSettings(), null);
    assert.equal(fetched, false);
});

test('初めて来た人（Cookie も無い）には何もしない', () => {
    const { context, map } = setup({ cookie: '_ga=1', fetch: async () => assert.fail('通信しない') });
    assert.equal(context.restoreLostSettings(), null);
    assert.equal(map.size, 0);
});

test('番号が消えていれば Cookie から戻し、控えの設定を書き戻してから駒を並べる', async () => {
    const profile = { v: 1, local: { shogi_ai_difficulty: 'hard' } };
    const { context, map, tracked, applied } = setup({ fetch: respond({ ok: true, profile }) });
    const waiting = context.restoreLostSettings();
    // 判定の時点で番号は戻っている（通信を待たない）
    assert.equal(map.get('shogi_online_uid'), UID);
    await waiting;
    assert.deepEqual(applied, [profile]);
    assert.deepEqual(context.restoredProfile, profile);
    assert.deepEqual(tracked.map(t => t.result), ['restored']);
});

test('控えが無ければ、戻すものが無いことを保存用ファイルに伝える', async () => {
    const { context, tracked, applied } = setup({ fetch: respond({ ok: true, profile: null }) });
    await context.restoreLostSettings();
    assert.deepEqual(applied, [null]);
    assert.deepEqual(tracked.map(t => t.result), ['none']);
});

test('通信に失敗したら何も書き戻さず、次に開いたときのために印を残す', async () => {
    const { context, map, tracked, applied } = setup({ fetch: async () => { throw new TypeError('offline'); } });
    await context.restoreLostSettings();
    assert.deepEqual(applied, []);
    assert.equal(map.get('shogi_restore_local'), '1');
    assert.equal(map.get('shogi_restore_records'), '1');
    assert.deepEqual(tracked.map(t => t.result), ['failed']);
});

test('待つ上限が来たら駒を並べ、後から届いた控えは使わない', async () => {
    let arrive;
    const { context, map, tracked, applied, fireDeadline } = setup({
        fetch: () => new Promise(resolve => { arrive = resolve; }),
    });
    const waiting = context.restoreLostSettings();
    fireDeadline();
    await waiting;
    assert.deepEqual(tracked.map(t => t.result), ['timeout']);
    arrive({ ok: true, json: async () => ({ ok: true, profile: { v: 1, local: {} } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(applied, []);
    assert.equal(map.get('shogi_restore_local'), '1');
});

test('設定は戻したが戦績がまだの人は、駒を並べるのを待たせない', () => {
    const { context } = setup({
        storage: { shogi_online_uid: UID, shogi_restore_records: '1' },
        fetch: async () => assert.fail('設定は取りに行かない'),
    });
    assert.equal(context.restoreLostSettings(), null);
});
