// SPDX-License-Identifier: GPL-3.0-only

// 戦績の保存場所（IndexedDB）の控えの書き出し・取り込み（src/records/store.ts）。
// ブラウザの IndexedDB の代わりに fake-indexeddb を使い、通信は差し替える。

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const saved = new Map();
globalThis.localStorage = {
    getItem: key => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: key => saved.delete(key),
};
globalThis.document = { cookie: '' };
const store = await import('../src/records/store.ts');

const UID = 'c4eafa94-e894-43f5-8e55-50990c4bee63';

function game(n, overrides = {}) {
    return {
        id: `g${n}`, startedAt: n * 1000, endedAt: n * 1000 + 500, mode: 'ai', player: 'sente', winner: 'sente',
        reason: 'checkmate', opponentName: 'AI', moves: ['7g7f', '3c3d'], waza: [], source: 'played', completed: true,
        ...overrides,
    };
}

function tsume(n) {
    return { date: new Date().toISOString().slice(0, 10), problemId: `t${n}`, moves: 1, firstTry: true, clearedAt: n * 1000 + 700 };
}

/** Safari が消したのと同じく、戦績の保存場所をまるごと消す */
function wipe() {
    return new Promise(resolve => {
        const request = indexedDB.deleteDatabase('shogi-records');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
}

/** 消える前の端末: 2局と詰将棋1問を記録して、控えを書き出す */
async function recordAndExport() {
    await store.initialize(1000);
    await store.saveGame(game(1));
    await store.saveGame(game(2, { winner: 'gote' }));
    await store.saveTsume(tsume(3));
    return store.exportRecords(0);
}

beforeEach(async () => {
    saved.clear();
    await wipe();
});

test('控えには集計・詰将棋・棋譜（新しい順）が入る', async () => {
    await store.initialize(1000);
    // 過去問として選べる範囲より前の出題日の記録は、集計には入るが控えの行には載せない
    await store.saveTsume({ ...tsume(9), date: '2020-01-01' });
    const { records, games } = await recordAndExport();
    assert.equal(records.startedAt, 1000);
    assert.equal(records.summaries.find(s => s.mode === 'all').games, 2);
    assert.equal(records.tsumeSummary.cleared, 2);
    assert.deepEqual(records.tsume.map(r => r.problemId), ['t3']);
    assert.deepEqual(games.map(g => g.id), ['g2', 'g1']);
    assert.equal('modeGroup' in games[0], false);
});

test('消えていない保存場所には取り込まない（二重に数えない）', async () => {
    const { records, games } = await recordAndExport();
    assert.equal(await store.importRecords(records, games), false);
    assert.equal((await store.getSummary()).games, 2);
});

test('消えた後に指した分と足し合わせ、2回目は取り込まない', async () => {
    const { records, games } = await recordAndExport();
    await wipe();
    await store.initialize(10_000);
    await store.saveGame(game(20));

    assert.equal(await store.importRecords(records, games), true);
    const summary = await store.getSummary();
    assert.equal(summary.games, 3);
    assert.equal(summary.wins, 2);
    assert.deepEqual((await store.getGames({ limit: 10 })).games.map(g => g.id), ['g20', 'g2', 'g1']);
    assert.equal((await store.getTsumeSummary()).cleared, 1);
    // 戻した後も、控えの開始時刻より前に終わった対局は記録の対象
    assert.equal((await store.initialize()).startedAt, 1000);

    assert.equal(await store.importRecords(records, games), false);
    assert.equal((await store.getSummary()).games, 3);
});

test('2つのタブが同時に取り込んでも1回だけ', async () => {
    const { records, games } = await recordAndExport();
    await wipe();
    await store.initialize(10_000);
    const results = await Promise.all([store.importRecords(records, games), store.importRecords(records, games)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await store.getSummary()).games, 2);
});

test('戻し終わったら印を外し、戻した棋譜をまた送らない', async () => {
    const { records, games } = await recordAndExport();
    await wipe();
    saved.set('shogi_restore_records', '1');
    globalThis.fetch = async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), { uid: UID, part: 'games' });
        return { ok: true, json: async () => ({ ok: true, games }) };
    };
    assert.equal(await store.restoreRecords(UID, { v: 1, local: {}, records }), true);
    assert.equal(saved.has('shogi_restore_records'), false);
    assert.equal(saved.get('shogi_backup_synced'), String(games[0].endedAt));
    assert.equal((await store.getSummary()).games, 2);
});

test('控えは、戻し終わるまで・遊んだ量が少ないうちは送らない', async () => {
    const sent = [];
    globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) };
    };
    const newUid = () => UID;
    await store.initialize(1000);
    await store.saveGame(game(1));
    await store.saveGame(game(2));
    assert.equal(await store.syncBackup(null, newUid), false);

    await store.saveGame(game(3));
    saved.set('shogi_restore_local', '1');
    assert.equal(await store.syncBackup(null, newUid), false);
    saved.delete('shogi_restore_local');

    assert.equal(await store.syncBackup(null, newUid), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].uid, UID);
    assert.deepEqual(sent[0].games.map(g => g.id), ['g1', 'g2', 'g3']);
    assert.equal(saved.get('shogi_backup_synced'), String(game(3).endedAt));
});

test('ロビーで Cookie だけ先に付いた人にも、通信対戦をしたら最初の控えを送る', async () => {
    const sent = [];
    globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) };
    };
    globalThis.document.cookie = `__Host-shogi_uid=${UID}`;
    saved.set('shogi_online_uid', UID);
    await store.initialize(1000);
    await store.saveGame(game(1));
    // ロビーを開いただけ（番号はあるが通信対戦をしていない）の人は控えない
    assert.equal(await store.seedBackup(() => UID, UID), false);
    assert.equal(sent.length, 0);
    await store.saveGame(game(2, { mode: 'online', opponentName: '相手' }));
    assert.equal(await store.seedBackup(() => UID, UID), true);
    assert.equal(sent.length, 1);
    // 一度送れたら、同じ端末では最初の控えを繰り返さない
    assert.equal(await store.seedBackup(() => UID, UID), false);
    globalThis.document.cookie = '';
});

test('戦績の保存場所が使えない端末では、戻す印を外して控えを止めたままにしない', async () => {
    saved.set('shogi_restore_records', '1');
    const indexedDB = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
        assert.equal(await store.restoreRecords(UID, { v: 1, local: {}, records: null }), false);
    } finally {
        globalThis.indexedDB = indexedDB;
    }
    assert.equal(saved.has('shogi_restore_records'), false);
});
