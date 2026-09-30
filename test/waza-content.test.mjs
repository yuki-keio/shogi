// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articles, tabs, categories, sideComparison } from '../pages/waza-content.mjs';
import { WAZA_CATALOG } from '../src/records/catalog.ts';
import { boardFromPieces, diagramStart, expandWaza } from '../src/records/waza_steps.ts';
import { applyMove, calculateValidMoves, createInitialGameState, isCheckmate, isKingInCheck } from '../src/worker/shogi_engine.ts';
import { parseUsiMove } from '../src/kifu/moves.ts';
import { replayUsiMoves } from '../src/kifu/replay.ts';
import { detectWaza, scanWaza } from '../src/waza/index.ts';
import { completedCastle } from '../src/waza/castle.ts';

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
  hidari_mino: [[8, 7, '玉'], [8, 8, '角'], [7, 8, '銀'], [6, 9, '金']],
  yagura: [[8, 8, '玉'], [7, 7, '銀'], [7, 8, '金'], [6, 7, '金']],
  kani_gakoi: [[6, 9, '玉'], [7, 8, '金'], [6, 8, '銀'], [5, 8, '金']],
  gangi: [[6, 9, '玉'], [7, 8, '金'], [5, 8, '金'], [6, 7, '銀'], [5, 7, '銀']],
  kin_muso: [[3, 8, '玉'], [4, 8, '金'], [5, 8, '金'], [2, 8, '銀']],
  ibisha_anaguma: [[9, 9, '玉'], [9, 8, '香'], [8, 8, '銀'], [7, 9, '金'], [7, 8, '金']],
  furibisha_anaguma: [[1, 9, '玉'], [1, 8, '香'], [2, 8, '銀'], [3, 9, '金'], [3, 8, '金']],
};

test('すべての技に解説があり、図を将棋のルール通りに作れる', () => {
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

test('図のどの局面でも、次に指さない側の玉に王手がかかっていない', () => {
  // 自分の番なのに相手の玉がもう王手されている、のような実戦ではありえない局面を載せない。
  // 自分の手だけを続けて並べる図では、王手への受けを飛ばしていないかも見る
  for (const [id, a] of Object.entries(articles)) {
    for (const spec of [a.diagram, ...a.sections.map(s => s[2]), a.joseki?.diagram].filter(Boolean)) {
      let { state } = diagramStart(spec);
      // 手の無い図は、自分（先手）が次に指す局面として見る
      if (!spec.moves?.length) assert.equal(isKingInCheck('gote', state.board), false, `${id}: 相手の玉が王手されている`);
      for (const [i, [usi, , gote]] of (spec.moves ?? []).entries()) {
        assert.equal(isKingInCheck(gote ? 'sente' : 'gote', state.board), false, `${id}: ${i + 1}手目の前に、指さない側の玉が王手されている`);
        state.currentPlayer = gote ? 'gote' : 'sente';
        state = applyMove(state, parseUsiMove(usi)).state;
      }
    }
  }
});

test('囲いは、対局の最初の形から指し継いで完成形になる', () => {
  assert.deepEqual(Object.keys(CASTLE_SHAPE).sort(), WAZA_CATALOG.filter(w => w.kind === 'castle').map(w => w.id).sort(), '完成形を確かめていない囲いがある');
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

test('囲いの記事は、組み上げた最後の手で、対局中にもその囲いの名前が出る', () => {
  for (const { id, kind } of WAZA_CATALOG) {
    if (kind !== 'castle') continue;
    const { figures } = expand(id);
    // 図は盤の自分側だけを映しているが、囲いの判定は自分の駒しか見ない
    assert.equal(completedCastle(boardOf(figures.at(-2)), boardOf(figures.at(-1)), 'sente'), id, id);
  }
});

const replayState = state => ({ board: state.board, capturedPieces: state.capturedPieces, currentPlayer: state.currentPlayer, lastMove: null, moveCount: 0, gameOver: state.gameOver, isCheck: state.isCheck });

test('手筋の記事で技をかけた手は、対局中の判定でも同じ名前になる', () => {
  for (const { id, kind } of WAZA_CATALOG) {
    if (kind !== 'tesuji') continue;
    const spec = articles[id].diagram;
    const main = expand(id).main; // 技をかけた図＝その番号の手を指した後
    let { state } = diagramStart(spec);
    let hit = null;
    for (const [i, [usi, , gote]] of spec.moves.slice(0, main).entries()) {
      const move = parseUsiMove(usi);
      state.currentPlayer = gote ? 'gote' : 'sente';
      const before = replayState(state);
      state = applyMove(state, move).state;
      hit = detectWaza({ before, after: replayState(state), move, ply: i + 1 });
    }
    assert.equal(hit?.id, id, `${id}: 対局中は ${hit?.id ?? '名前なし'} になる`);
  }
});

test('頭金の完成図は詰みで、支えの歩がなければ玉で金を取れる', () => {
  const { capturedPieces } = createInitialGameState();
  const last = expand('atama_kin').figures.at(-1);
  assert.equal(isCheckmate('gote', boardOf(last), capturedPieces), true);
  assert.equal(isCheckmate('gote', boardFromPieces(last.pieces.filter(p => p.type !== '歩')), capturedPieces), false);
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
// 底歩は竜で取ること自体はできるが、真上の金で取り返せて竜を失う。取り返せて、取った側が損をするならよい
const GUARDED = new Set(['sokofu']);

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
        if (canTake && GUARDED.has(id)) {
          const taken = board.map(row => row.slice());
          taken[rank - 1][9 - file] = p;
          taken[y][x] = null;
          const retake = movesOf(taken, mover.owner).some(m => m.to.x === 9 - file && m.to.y === rank - 1);
          assert.ok(retake && VALUE[p.type] > VALUE[mover.type], `${id}: ${figure.notation} の駒を ${9 - x}${y + 1} の${p.type}に取られて損をしない`);
          continue;
        }
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

// そのマスへ動ける駒があるか（取れる・押さえている）。筋と段は棋譜の数え方
const reaches = (board, owner, file, rank) => movesOf(board, owner).some(m => m.to.x === 9 - file && m.to.y === rank - 1);
const moveOn = (board, [fromFile, fromRank], [file, rank]) => play(board, { x: 9 - fromFile, y: fromRank - 1, to: { x: 9 - file, y: rank - 1 } });

test('腹金と両王手の最後の図は詰みで、本文で挙げた駒が欠けると詰まない', () => {
  const { capturedPieces } = createInitialGameState();
  const hara = expand('hara_kin').figures.at(-1);
  assert.equal(isCheckmate('gote', boardOf(hara), capturedPieces), true);
  // 桂が金を支え、歩が玉のすぐ下のマスを押さえている
  for (const type of ['桂', '歩']) {
    assert.equal(isCheckmate('gote', boardFromPieces(hara.pieces.filter(p => p.type !== type)), capturedPieces), false, `腹金: ${type}がなくても詰む`);
  }
  // 両王手は、相手が持ち駒を持っていても間に打って防げない
  const ryo = boardOf(expand('ryo_oute').figures.at(-1));
  const hand = { sente: { ...capturedPieces.sente }, gote: { ...capturedPieces.gote, KI: 1, GI: 1 } };
  assert.equal(isCheckmate('gote', ryo, hand), true);
  assert.equal(movesOf(ryo, 'sente').filter(m => ryo[m.to.y][m.to.x]?.type === 'OU').length, 2, '両王手: 王手している駒が2枚ではない');
});

test('開き王手は、王手をかけているのが動かした駒ではなく、守られていた駒を取っても取り返されない', () => {
  const { figures, main } = expand('aki_oute');
  const board = boardOf(figures[main]);
  assert.equal(isKingInCheck('gote', board), true);
  const [file, rank] = figures[main].to;
  const moved = calculateValidMoves(9 - file, rank - 1, board[rank - 1][9 - file], board);
  assert.equal(moved.some(m => board[m.y][m.x]?.type === 'OU'), false, '開き王手: 動かした駒でも王手している');
  // 取った駒は相手の駒が守っていたが、取り返すと王手が残るので取り返せない（後ろの飛車がいなければ取り返せる）
  const noCheck = boardFromPieces(figures[main].pieces.filter(p => p.gote || p.type !== '飛'));
  assert.equal(reaches(noCheck, 'gote', file, rank), true, '開き王手: 取った駒を守る相手の駒が図にいない');
  assert.equal(reaches(board, 'gote', file, rank), false, '開き王手: 王手を残さずに取り返せる');
});

test('底歩は、打つ前は竜に金をただで取られ、打った後は竜で金を取っても歩で取り返せる', () => {
  const { figures } = expand('sokofu');
  const [before, after] = [boardOf(figures[0]), boardOf(figures.at(-1))];
  const [dragon, gold] = [[8, 9], [7, 8]];
  assert.equal(reaches(before, 'gote', ...gold), true, '底歩: 竜が金を狙っていない');
  assert.equal(reaches(moveOn(before, dragon, gold), 'sente', ...gold), false, '底歩: 打つ前から金に支えがある');
  assert.equal(reaches(moveOn(after, dragon, gold), 'sente', ...gold), true, '底歩: 打った歩で金を取り返せない');
});

test('桂頭の銀は、打つ前は桂が跳ねると王手で取り返せず、打った後は跳ねる先を銀が押さえる', () => {
  const { figures } = expand('keito_no_gin');
  const [before, after] = [boardOf(figures[0]), boardOf(figures.at(-1))];
  const knight = [2, 4];
  for (const jump of [[3, 6], [1, 6]]) {
    assert.equal(isKingInCheck('sente', moveOn(before, knight, jump)), true, `桂頭の銀: ${jump.join('')}へ跳ねても王手にならない`);
    assert.equal(reaches(moveOn(before, knight, jump), 'sente', ...jump), false, `桂頭の銀: 銀を打つ前から${jump.join('')}の桂を取れる`);
    assert.equal(reaches(moveOn(after, knight, jump), 'sente', ...jump), true, `桂頭の銀: 銀が${jump.join('')}を押さえていない`);
  }
  assert.equal(reaches(after, 'gote', ...figures.at(-1).to), false, '桂頭の銀: 打った銀を取られる');
});

test('技図鑑のタブに、すべての技がちょうど1回ずつ並ぶ', () => {
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
  const shape = { shiken_bisha: [6, 8, '飛'], sanken_bisha: [7, 8, '飛'], naka_bisha: [5, 8, '飛'], mukai_bisha: [8, 8, '飛'], migi_shiken_bisha: [4, 8, '飛'] };
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

test('右四間飛車は、定跡の後に左美濃を組んだ形が、最初の図と攻め方の図の自分の駒と同じ', () => {
  const article = articles.migi_shiken_bisha;
  // 左美濃の図は定跡の続き（開始局面を定跡の手順で作る図）。攻め方の図は最初の図と同じ局面から始まる
  const castle = expandWaza(article.sections.map(s => s[2]).find(spec => spec?.setup)).figures.at(-1);
  const top = expand('migi_shiken_bisha').figures[0];
  const mine = figure => figure.pieces.filter(p => !p.gote).map(p => `${p.file}${p.rank}${p.type}`).sort();
  assert.deepEqual(mine(castle), mine(top));
  // 左美濃（玉を一段上に置く形）と、右四間飛車の攻めの駒
  for (const [file, rank, type] of [[8, 7, '玉'], [7, 8, '銀'], [6, 9, '金'], [5, 8, '金'], [8, 8, '角'], [4, 8, '飛'], [5, 6, '銀'], [3, 7, '桂'], [4, 6, '歩']]) {
    const piece = at(castle, file, rank);
    assert.ok(piece && piece.type === type && !piece.gote, `左美濃の図の最後で${file}${rank}に${type}がいない`);
  }
  const attack = expandWaza(article.sections.map(s => s[2]).find(spec => spec?.start === article.diagram.start));
  assert.deepEqual(attack.figures[0].pieces, top.pieces);
  const last = attack.figures.at(-1);
  assert.deepEqual(last.to, [4, 5]);
  assert.equal(at(last, 4, 5).type, '歩');
});

test('右四間飛車の記事の定跡どおりに指すと、飛車を回した手で対局中にも右四間飛車の名前が出る', () => {
  const moves = articles.migi_shiken_bisha.joseki.diagram.moves.map(([usi]) => usi);
  const scan = scanWaza(moves, replayUsiMoves(moves));
  assert.deepEqual(scan.hits.filter(h => h.player === 'sente').map(h => [h.id, h.ply]), [['migi_shiken_bisha', moves.length]]);
});

test('戦法の記事の定跡どおりに指すと、対局中にもその戦法の名前が出る', () => {
  // 棒銀の定跡は、銀を棒銀の位置まで上げる一歩手前で終わる（続きは本文で説明している）
  const LATER = new Set(['bogin']);
  // 角換わりは角を交換し終えた手で、二人ともにその名前が付く
  const players = { kakugawari: ['sente', 'gote'] };
  for (const [id, a] of Object.entries(articles)) {
    if (!a.joseki || LATER.has(id)) continue;
    const moves = a.joseki.diagram.moves.map(([usi]) => usi);
    const scan = scanWaza(moves, replayUsiMoves(moves));
    assert.deepEqual(scan.hits.filter(h => h.id === id).map(h => h.player), players[id] || ['sente'], id);
  }
});

test('図の開始局面を手順で作れて、続きの最初の手も「同」で書ける', () => {
  const files = [9, 8, 7, 6, 5, 4, 3, 2, 1], ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const spec = { files, ranks, mark: 'moved', start: 'initial', caption: '', setup: ['7g7f', '3c3d', '8h2b+'], moves: [['3a2b', '', true]] };
  assert.equal(expandWaza(spec).figures[1].notation, '△同銀');
  assert.throws(() => expandWaza({ ...spec, setup: ['7g7e'] }), '指せない手順は止める');
  assert.throws(() => expandWaza({ ...spec, start: [] }), '駒を並べた開始局面には手順を足せない');
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
