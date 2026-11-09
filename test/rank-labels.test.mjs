// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// 段級位は添字だけを受け渡すので、サーバー（src/worker/rating.ts の RANKS）と画面（shogi.js の ONLINE_RANK_LABELS）の
// 並びが1つでもずれると、別の段級位が表示される。段級位を足すときに片方だけ直す事故を防ぐ
test('サーバーと画面の段級位の並びが同じ', () => {
  const server = readFileSync(new URL('../src/worker/rating.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../shogi.js', import.meta.url), 'utf8');
  const serverLabels = [...server.slice(server.indexOf('export const RANKS'), server.indexOf('];', server.indexOf('export const RANKS')))
    .matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  const clientBlock = client.match(/const ONLINE_RANK_LABELS = \[([\s\S]*?)\];/);
  assert.ok(clientBlock, 'shogi.js に ONLINE_RANK_LABELS がある');
  const clientLabels = [...clientBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(serverLabels.length >= 15);
  assert.deepEqual(clientLabels, serverLabels);
});
