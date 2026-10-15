// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FONT_CHARS, renderPostPng, renderPostSvg } from '../pages/tsume-post-image.mjs';
import { POST_LEVEL, formatPostDate, postImageAltText } from '../pages/tsume-post.mjs';
import { buildPostText, postDueAt, problemUrl, xWeightedLength } from '../scripts/x/post-daily-tsume.mjs';

const DAILY_DIR = new URL('../tsume_data/daily/', import.meta.url);
const days = readdirSync(DAILY_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(new URL(name, DAILY_DIR), 'utf8')));
const problems = days.flatMap(day => day.problems.map(problem => ({ problem, date: day.date })));

/** TrueType の cmap（format 4 / 12）から、字形のある文字を集める */
function fontCodePoints(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const tables = view.getUint16(4);
    let cmap = -1;
    for (let i = 0; i < tables; i++) {
        const record = 12 + i * 16;
        if (buffer.toString('latin1', record, record + 4) === 'cmap') cmap = view.getUint32(record + 8);
    }
    assert.ok(cmap >= 0, 'cmap がありません');
    const points = new Set();
    const subtables = view.getUint16(cmap + 2);
    for (let i = 0; i < subtables; i++) {
        const offset = cmap + view.getUint32(cmap + 4 + i * 8 + 4);
        const format = view.getUint16(offset);
        if (format === 12) {
            const groups = view.getUint32(offset + 12);
            for (let g = 0; g < groups; g++) {
                const at = offset + 16 + g * 12;
                for (let c = view.getUint32(at); c <= view.getUint32(at + 4); c++) points.add(c);
            }
        } else if (format === 4) {
            const segments = view.getUint16(offset + 6) / 2;
            const ends = offset + 14;
            const starts = ends + segments * 2 + 2;
            const deltas = starts + segments * 2;
            const rangeOffsets = deltas + segments * 2;
            for (let s = 0; s < segments; s++) {
                const start = view.getUint16(starts + s * 2);
                const end = view.getUint16(ends + s * 2);
                const delta = view.getInt16(deltas + s * 2);
                const rangeOffset = view.getUint16(rangeOffsets + s * 2);
                for (let c = start; c <= end && c !== 0xffff; c++) {
                    const glyph = rangeOffset === 0
                        ? (c + delta) & 0xffff
                        : view.getUint16(rangeOffsets + s * 2 + rangeOffset + (c - start) * 2);
                    if (glyph !== 0) points.add(c);
                }
            }
        }
    }
    return points;
}

test('埋め込んだ書体に FONT_CHARS の字がすべて入っている', () => {
    const points = fontCodePoints(readFileSync(new URL('../pages/fonts/YujiSyuku-subset.ttf', import.meta.url)));
    const missing = [...FONT_CHARS].filter(char => !points.has(char.codePointAt(0)));
    assert.deepEqual(missing, []);
});

test('画像に出る文字はすべて FONT_CHARS にある（出題データ全部と1年ぶんの日付）', () => {
    const allowed = new Set(FONT_CHARS);
    const used = new Set();
    for (const { problem, date } of problems) {
        for (const [, content] of renderPostSvg(problem, date).matchAll(/<text[^>]*>([^<]*)<\/text>/g)) {
            for (const char of content) used.add(char);
        }
    }
    for (let day = 0; day < 366; day++) {
        const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
        for (const char of formatPostDate(date)) used.add(char);
    }
    assert.deepEqual([...used].filter(char => !allowed.has(char)), []);
});

test('画像は 1200×1200 の PNG', () => {
    const { problem, date } = problems.find(({ problem }) => problem.level === POST_LEVEL);
    const png = renderPostPng(problem, date);
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 1200);
});

test('投稿の文面は X の上限（280）に収まり、その日・その難易度のページを指す', () => {
    for (const day of days) {
        const problem = day.problems.find(candidate => candidate.level === POST_LEVEL);
        if (!problem) continue;
        const text = buildPostText(problem, day.date);
        assert.ok(xWeightedLength(text) <= 280, `${day.date}: ${xWeightedLength(text)}`);
        const url = new URL(text.match(/https:\/\/\S+/)[0]);
        assert.equal(url.pathname, '/tsume/');
        assert.equal(url.searchParams.get('date'), day.date);
        assert.equal(url.searchParams.get('level'), POST_LEVEL);
    }
});

test('X の文字数の数え方: 日本語は2、英数字は1、URLは長さによらず23', () => {
    assert.equal(xWeightedLength('詰将棋'), 6);
    assert.equal(xWeightedLength('Web 3'), 5);
    assert.equal(xWeightedLength(problemUrl('2026-10-15')), 23);
});

test('投稿時刻は日本時間の20時', () => {
    assert.equal(postDueAt('2026-10-15'), '2026-10-15T11:00:00.000Z');
    assert.equal(postDueAt('2026-10-31', 1), '2026-11-01T11:00:00.000Z');
});

test('代替テキストに盤の駒と持駒がすべて入る', () => {
    for (const { problem } of problems) {
        const alt = postImageAltText(problem);
        for (const cell of problem.render.cells) assert.ok(alt.includes(cell.label), `${problem.id}: ${cell.label}`);
        for (const entry of problem.render.hands.attacker) assert.ok(alt.includes(entry.label), `${problem.id}: ${entry.label}`);
    }
});
