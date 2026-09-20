// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articles, tabs, categories, sideComparison } from '../pages/waza-content.mjs';
import { WAZA_CATALOG } from '../src/records/catalog.ts';
import { boardFromPieces, expandWaza } from '../src/records/waza_steps.ts';
import { calculateValidMoves, createInitialGameState, isCheckmate, isKingInCheck } from '../src/worker/shogi_engine.ts';

const expand = id => expandWaza(articles[id].diagram);
const boardOf = figure => boardFromPieces(figure.pieces);
const at = (figure, file, rank) => figure.pieces.find(p => p.file === file && p.rank === rank);

/** 完成形にこの駒が並んでいれば、その囲いが組めたと言える */
const CASTLE_SHAPE = {
  kata_mino: [[2, 8, '玉'], [3, 8, '銀'], [4, 9, '金']],
  hon_mino: [[2, 8, '玉'], [3, 8, '銀'], [4, 9, '金'], [5, 8, '金']],
  taka_mino: [[2, 8, '玉'], [3, 8, '銀'], [4, 9, '金'], [4, 7, '金'], [4, 6, '歩']],
  gin_kanmuri: [[2, 8, '玉'], [2, 7, '銀'], [3, 8, '金'], [4, 7, '金'], [2, 6, '歩']],
  fune_gakoi: [[7, 8, '玉'], [7, 9, '銀'], [6, 9, '金'], [5, 8, '金']],
  yagura: [[8, 8, '玉'], [7, 7, '銀'], [7, 8, '金'], [6, 7, '金']],
  kani_gakoi: [[6, 9, '玉'], [7, 8, '金'], [6, 8, '銀'], [5, 8, '金']],
  kin_muso: [[3, 8, '玉'], [4, 8, '金'], [5, 8, '金'], [2, 8, '銀']],
  ibisha_anaguma: [[9, 9, '玉'], [9, 8, '香'], [8, 8, '銀'], [7, 9, '金'], [7, 8, '金']],
  furibisha_anaguma: [[1, 9, '玉'], [1, 8, '香'], [2, 8, '銀'], [3, 9, '金'], [3, 8, '金']],
};

test('24種すべてに解説があり、図を将棋のルール通りに作れる', () => {
  assert.deepEqual(Object.keys(articles).sort(), WAZA_CATALOG.map(w => w.id).sort());
  for (const [id, article] of Object.entries(articles)) {
    assert.ok(article.intro && article.description && article.sections.length, id);
    // 指せない手が混じっていればここで例外になる
    const diagram = expand(id);
    assert.ok(diagram.figures.length >= 1, id);
    assert.ok(diagram.main >= 0 && diagram.main < diagram.figures.length, `${id}: 最初に見せる図が範囲外`);
    for (const figure of diagram.figures) {
      assert.ok(figure.pieces.length, `${id}: 駒のない図がある`);
      boardOf(figure); // 同じマスの重複や盤の外があれば例外
      for (const piece of figure.pieces) {
        assert.ok(diagram.files.includes(piece.file), `${id}: 筋が図の外`);
        assert.ok(diagram.ranks.includes(piece.rank), `${id}: 段が図の外`);
      }
      assert.ok(figure.caption, `${id}: 説明のない図がある`);
    }
    // 開始図以外には棋譜の表記と、動いたマスの印がある
    for (const figure of diagram.figures.slice(1)) {
      assert.match(figure.notation, /^[▲△]/, `${id}: ${figure.notation}`);
      assert.ok(figure.to, `${id}: 動いたマスが分からない図がある`);
    }
    for (const related of article.related) assert.ok(articles[related], `${id}: missing ${related}`);
    // 節の中に添えた図も、将棋のルール通りに作れる
    for (const [, , spec] of article.sections) if (spec) assert.ok(expandWaza(spec).figures.length >= 2, `${id}: 節の図に手順がない`);
  }
});

test('囲い10種は、対局の最初の形から指し継いで完成形になる', () => {
  for (const [id, shape] of Object.entries(CASTLE_SHAPE)) {
    const diagram = expand(id);
    const last = diagram.figures.at(-1);
    assert.equal(diagram.main, diagram.figures.length - 1, `${id}: 完成形を最初に見せていない`);
    // 対局の最初の形から始める＝40枚が揃っている（盤の下半分だけを映すので、その中の駒数で見る）
    assert.equal(diagram.figures[0].pieces.length, 20, `${id}: 最初の図が対局開始の形ではない`);
    for (const [file, rank, type] of shape) {
      const piece = at(last, file, rank);
      assert.ok(piece && piece.type === type && !piece.gote, `${id}: ${file}${rank}が${type}になっていない`);
    }
  }
});

test('頭金の完成図は詰みで、支えの飛車がなければ玉で金を取れる', () => {
  const { capturedPieces } = createInitialGameState();
  const last = expand('atama_kin').figures.at(-1);
  assert.equal(isCheckmate('gote', boardOf(last), capturedPieces), true);
  assert.equal(isCheckmate('gote', boardFromPieces(last.pieces.filter(p => p.type !== '飛')), capturedPieces), false);
});

test('王手飛車は、角を打った図が王手で、最後に飛車を持ち駒にしている', () => {
  const { figures, main } = expand('oute_bisha');
  assert.match(figures[main].notation, /角打$/);
  assert.equal(isKingInCheck('gote', boardOf(figures[main])), true, '角を打った図が王手になっていない');
  assert.equal(isKingInCheck('gote', boardOf(figures[main + 1])), false, '玉が逃げた図がまだ王手になっている');
  assert.match(figures.at(-1).hand, /：飛$/);
});

test('たたきの歩は、金を釣り上げた後の金打ちが詰みで、釣り上げる前は同じ手を金で取られる', () => {
  const { capturedPieces } = createInitialGameState();
  const { figures } = expand('tataki_no_fu');
  assert.equal(isCheckmate('gote', boardOf(figures.at(-1)), capturedPieces), true);
  // 最初の図で同じ5二に金を打つと、4二の金で取れる（だから先に歩で釣り上げる）
  const early = boardFromPieces([...figures[0].pieces, { file: 5, rank: 2, type: '金' }]);
  assert.equal(isCheckmate('gote', early, capturedPieces), false);
});

test('両取りの手筋は、技をかけた図を最初に見せ、最後に狙った駒を取っている', () => {
  // 十字飛車は盤上の飛車を動かす形（持ち駒の飛車を打つ形は、十字飛車とはあまり呼ばない）。途中で歩も取る
  for (const [id, taken, drop] of [['wariuchi_no_gin', '金', true], ['fundoshi_no_kei', '飛', true], ['juji_bisha', '銀歩', false], ['dengaku_zashi', '飛', true]]) {
    const { figures, main } = expand(id);
    if (drop) assert.match(figures[main].notation, /打$/, `${id}: 技をかける図が「駒を打つ手」になっていない`);
    else assert.doesNotMatch(figures[main].notation, /打$/, `${id}: 盤上の駒を動かす形になっていない`);
    assert.ok(figures.at(-1).hand.endsWith(`：${taken}`), `${id}: 最後に取った駒が合わない`);
  }
});

// 「指せる手」と「指してよい手」は別。初心者向けの図で、狙いの駒をただで取られる手順を
// 載せないための検査。たたきの歩だけは、歩を取らせること自体が狙いなので対象外にする。
const SACRIFICE = new Set(['tataki_no_fu']);

test('技をかけた図と最後の図で、動かした駒を相手にただで取られない', () => {
  for (const id of Object.keys(articles)) {
    const diagram = expand(id);
    const targets = [diagram.figures.at(-1), diagram.figures[diagram.main]];
    for (const figure of targets) {
      if (!figure.to || (SACRIFICE.has(id) && figure !== diagram.figures.at(-1))) continue;
      const [file, rank] = figure.to;
      const board = boardOf(figure);
      const mover = board[rank - 1][9 - file];
      const taker = mover.owner === 'sente' ? 'gote' : 'sente';
      for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
        const p = board[y][x];
        if (!p || p.owner !== taker) continue;
        const canTake = calculateValidMoves(x, y, p, board).some(m => m.x === 9 - file && m.y === rank - 1);
        assert.equal(canTake, false, `${id}: ${figure.notation} の駒を ${9 - x}${y + 1} の${p.type === 'OU' ? '玉' : p.type}に取られる`);
      }
    }
  }
});

// 駒のおおよその価値。取り返されたときに損かどうかを見るためだけに使う
const VALUE = { FU: 1, KY: 4, KE: 4, GI: 5, KI: 6, KA: 8, HI: 10, OU: 99, '+FU': 6, '+KY': 6, '+KE': 6, '+GI': 6, '+KA': 12, '+HI': 14 };
// 「両取りをかけた」と本文で言い切っている技。相手がどう応じても駒得になっていないと、記事の説明が嘘になる
const FORK = ['wariuchi_no_gin', 'fundoshi_no_kei', 'oute_bisha', 'juji_bisha', 'dengaku_zashi'];

const movesOf = (board, owner) => {
  const list = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const p = board[y][x];
    if (p?.owner === owner) for (const to of calculateValidMoves(x, y, p, board)) list.push({ x, y, to });
  }
  return list;
};
const play = (board, { x, y, to }) => {
  const next = board.map(row => row.slice());
  next[to.y][to.x] = next[y][x];
  next[y][x] = null;
  return next;
};
/** 先手がいちばん得する取り方の損得。取り返されるなら取った駒から自分の駒を引く */
function bestGain(board) {
  let best = 0;
  for (const move of movesOf(board, 'sente')) {
    const target = board[move.to.y][move.to.x];
    if (!target || target.owner !== 'gote') continue;
    const after = play(board, move);
    const retaken = movesOf(after, 'gote').some(m => m.to.x === move.to.x && m.to.y === move.to.y);
    best = Math.max(best, VALUE[target.type] - (retaken ? VALUE[board[move.y][move.x].type] : 0));
  }
  return best;
}

test('両取りの図は、相手がどう応じても先手が駒得になる', () => {
  for (const id of FORK) {
    const { figures, main } = expand(id);
    // 図に映っている駒だけで考える（図の外に補った玉は、この検証の対象ではない）
    const board = boardOf(figures[main]);
    for (const reply of movesOf(board, 'gote')) {
      const gain = bestGain(play(board, reply));
      // 金を銀で取って取り返される（＋1）程度では両取りが成立したとは言えない。桂1枚ぶんを下限にする
      assert.ok(gain >= VALUE.KE, `${id}: 相手が ${9 - reply.x}${reply.y + 1}の駒を${9 - reply.to.x}${reply.to.y + 1}へ動かすと、先手の得が ${gain} にしかならない`);
    }
  }
});

test('技図鑑のタブに、24種がちょうど1回ずつ並ぶ', () => {
  const listed = tabs.flatMap(t => t.ids);
  assert.deepEqual([...listed].sort(), WAZA_CATALOG.map(w => w.id).sort());
  assert.equal(new Set(tabs.map(t => t.path)).size, tabs.length);
  for (const t of tabs) {
    assert.ok(t.title && t.description && t.intro && t.h1, t.id);
    // 1つのタブには同じ種類の技だけを並べる
    assert.equal(new Set(t.ids.map(id => WAZA_CATALOG.find(w => w.id === id).kind)).size, 1, t.id);
  }
  // 文中の [[id]] は実在する技か、居飛車・振り飛車のページを指す
  const links = [...tabs.map(t => t.intro), ...Object.values(articles).flatMap(a => [a.intro, ...a.sections.map(s => s[1]), a.counter, a.breakdown, a.scenes, a.defense, a.joseki?.text, a.joseki?.after, ...(a.pros || []), ...(a.weak || [])])]
    .filter(Boolean).flatMap(text => [...text.matchAll(/\[\[(\w+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1]));
  for (const id of links) assert.ok(articles[id] || categories[id], `リンク先がない: ${id}`);
});

test('記事には種類ごとに決めた節がそろっている', () => {
  const kindOf = id => WAZA_CATALOG.find(w => w.id === id).kind;
  for (const [id, a] of Object.entries(articles)) {
    assert.ok(a.summary, `${id}: 一覧の説明1行がない`);
    const kind = kindOf(id);
    if (kind === 'strategy' || kind === 'castle') assert.ok(a.pros?.length && a.weak?.length, `${id}: 長所と弱点がない`);
    if (kind === 'strategy') assert.ok(a.joseki && a.counter, `${id}: 定跡か対策がない`);
    if (kind === 'castle') assert.ok(a.breakdown, `${id}: 崩し方がない`);
    if (kind === 'tesuji') assert.ok(a.scenes && a.defense, `${id}: よく出る場面か防ぎ方がない`);
  }
});

test('定跡の図は、対局の最初の形から先手・後手が交互に指して、その戦法の形になる', () => {
  // 最後の図で、先手の飛車がいる筋（棒銀は銀の位置）
  const shape = { shiken_bisha: [6, 8, '飛'], sanken_bisha: [7, 8, '飛'], naka_bisha: [5, 8, '飛'], mukai_bisha: [8, 8, '飛'] };
  for (const [id, a] of Object.entries(articles)) {
    if (!a.joseki) continue;
    const diagram = expandWaza(a.joseki.diagram); // 指せない手があればここで例外
    assert.equal(diagram.figures[0].pieces.length, 40, `${id}: 最初の図が対局開始の形ではない`);
    diagram.figures.slice(1).forEach((f, i) => assert.equal(f.notation[0], i % 2 ? '△' : '▲', `${id}: ${i + 1}手目の手番が違う`));
    if (shape[id]) {
      const [file, rank, type] = shape[id];
      const piece = at(diagram.figures.at(-1), file, rank);
      assert.ok(piece && piece.type === type && !piece.gote, `${id}: 最後の図で${file}${rank}に${type}がいない`);
    }
  }
});

test('居飛車・振り飛車のページは、図鑑にある記事だけを指し、タグは1つの技に1つまで', () => {
  const linkIds = text => [...text.matchAll(/\[\[(\w+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1]);
  const texts = c => [c.intro, c.strategies.lead, c.difference, c.castles.lead, ...c.pros, ...c.weak, ...c.closing[1],
    ...(c.strategies.others?.[1].map(row => row[2]) || []), ...c.castles.groups.map(g => g[2]).filter(Boolean)];
  const tagged = new Map();
  for (const [id, c] of Object.entries(categories)) {
    assert.ok(c.title && c.description && c.summary && c.intro, id);
    for (const link of [...texts(c).flatMap(linkIds), ...sideComparison.flat(2).flatMap(linkIds)]) {
      assert.ok(articles[link] || categories[link], `${id}: リンク先がない ${link}`);
    }
    const castleIds = c.castles.groups.flatMap(g => g[1]).map(item => [].concat(item)[0]);
    for (const shown of [...c.strategies.ids, ...castleIds]) assert.ok(articles[shown], `${id}: 記事がない ${shown}`);
    for (const label of Object.values(c.rookMap.labels)) if (/^[a-z_]+$/.test(label)) assert.ok(articles[label], `${id}: 図の札の記事がない ${label}`);
    for (const t of c.tagged) {
      assert.ok(!tagged.has(t), `${t}: 居飛車と振り飛車の両方のタグが付いている`);
      tagged.set(t, id);
      // タグを付けた技は、そのページのどこかに載っている（左右逆の注記付きで載せたものは数えない）
      const plain = [...c.strategies.ids, ...c.castles.groups.flatMap(g => g[1]).filter(item => typeof item === 'string')];
      assert.ok(plain.includes(t), `${id}: タグを付けた ${t} がページに無い`);
    }
    assert.ok(tabs.some(tab => tab.categories?.ids.includes(id)), `${id}: 一覧からの入口がない`);
  }
});

test('居飛車・振り飛車のページに、先手と後手で変わる筋の数字やマスの座標を書かない', () => {
  // 「2筋」「5〜8筋」「3四」のような書き方。「左から4筋目」のように数える書き方と、先手でも後手でも中央の「5筋」はよい
  const fileNumber = /[1-9１-９][〜~][1-9１-９]筋|[1-46-9１-４６-９]筋(?!目)|[1-9１-９][一二三四五六七八九]/;
  for (const [id, c] of Object.entries(categories)) {
    // ページには、そのページに並べた戦法の記事の1行説明も載る
    const all = JSON.stringify([c, sideComparison, c.strategies.ids.map(i => articles[i].summary)]);
    assert.doesNotMatch(all, fileNumber, id);
  }
});
