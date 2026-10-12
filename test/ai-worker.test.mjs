// ai-worker.js の「弱さのつまみ」が状態を壊さないことを見張る回帰テスト。
// 入門・初級は候補手をふるいにかける段階で一手ずつ指してみて戻すので、戻し忘れ・反則手・
// 手駒の壊れが起きると「点数を見ていない手」が出る（実際に一度やった）。
// ファイルは無改変のまま Node の vm に読み込み、内部関数だけ橋渡しして自己対局させる。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const WORKER_PATH = fileURLToPath(new URL("../ai-worker.js", import.meta.url));

function loadWorker() {
  const ctx = { performance, console, Math, Date, JSON, self: {} };
  vm.createContext(ctx);
  const bridge = `
    globalThis.__api = {
      set board(v){board=v}, set capturedPieces(v){capturedPieces=v},
      set currentPlayer(v){currentPlayer=v}, set moveCount(v){moveCount=v},
      recomputeKingPosCache, getAllLegalMovesFast, applyMoveFast, undoMoveFast,
      getBestMoveWithWeakness, WEAKNESS_BY_DIFFICULTY, PLAN_WEAKNESS, STRATEGIES, minmaxEvaluate,
      checkPlanSeparately, findPlanStep, readPlan,
      get kingPosCache(){return kingPosCache},
      get transpositionTable(){return transpositionTable},
      get knobs(){return { exchangeDepth, safeMove, safeDrop, dropBlind, farCapture, kingWeight, spreadPicks }},
    };
  `;
  vm.runInContext(readFileSync(WORKER_PATH, "utf8") + bridge, ctx, { filename: "ai-worker.js" });
  return ctx.__api;
}

const SENTE = "sente";
const GOTE = "gote";
const BACK_RANK = ["KY", "KE", "GI", "KI", "OU", "KI", "GI", "KE", "KY"];

function initialBoard() {
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  for (let x = 0; x < 9; x++) {
    board[0][x] = { type: BACK_RANK[x], owner: GOTE };
    board[8][x] = { type: BACK_RANK[x], owner: SENTE };
    board[2][x] = { type: "FU", owner: GOTE };
    board[6][x] = { type: "FU", owner: SENTE };
  }
  board[1][1] = { type: "HI", owner: GOTE };
  board[1][7] = { type: "KA", owner: GOTE };
  board[7][1] = { type: "KA", owner: SENTE };
  board[7][7] = { type: "HI", owner: SENTE };
  return board;
}

const emptyHand = () => ({ HI: 0, KA: 0, KI: 0, GI: 0, KE: 0, KY: 0, FU: 0 });
const snapshot = (board) => board.map((row) => row.map((c) => (c ? c.type + c.owner[0] : ".")).join("")).join("/");
const sameMove = (a, b) =>
  a.type === b.type &&
  (a.type === "move"
    ? a.fromX === b.fromX && a.fromY === b.fromY && a.toX === b.toX && a.toY === b.toY && !!a.promote === !!b.promote
    : a.pieceType === b.pieceType && a.toX === b.toX && a.toY === b.toY);

test("入門・初級は手を選んだあとに盤と手駒を元どおりにし、必ず合法手を返す", () => {
  const api = loadWorker();
  const weakness = api.WEAKNESS_BY_DIFFICULTY;
  assert.ok(weakness.novice && weakness.easy, "入門と初級の設定がある");

  const board = initialBoard();
  const hands = { [SENTE]: emptyHand(), [GOTE]: emptyHand() };
  let player = SENTE;
  let checked = 0;

  for (let ply = 0; ply < 60; ply++) {
    // 本番のワーカーは1手ごとに盤と手駒を受け取り直す
    api.board = board;
    api.capturedPieces = hands;
    api.currentPlayer = player;
    api.moveCount = ply;
    api.recomputeKingPosCache();

    const legal = api.getAllLegalMovesFast(player);
    if (legal.length === 0) break;
    const before = snapshot(board);
    const king = { ...api.kingPosCache[player] };

    const move = api.getBestMoveWithWeakness(1, player, player === SENTE ? weakness.novice : weakness.easy);
    checked++;

    assert.ok(move, "手を返す");
    assert.equal(snapshot(board), before, "読みのあと盤が元どおり");
    assert.deepEqual({ ...api.kingPosCache[player] }, king, "玉の位置の控えが元どおり");
    for (const side of [SENTE, GOTE]) {
      for (const [type, count] of Object.entries(hands[side])) {
        // 読みの途中で玉を取る手が出ても、手駒に OU を生やして NaN にしてはいけない
        assert.notEqual(type, "OU", "手駒に玉が入らない");
        assert.ok(Number.isFinite(count) && count >= 0, `手駒の枚数が壊れていない (${side} ${type})`);
      }
    }
    assert.ok(legal.some((m) => sameMove(m, move)), "返す手は本物の盤で合法");

    api.board = board;
    api.capturedPieces = hands;
    api.applyMoveFast(move, player);
    player = player === SENTE ? GOTE : SENTE;
  }

  assert.ok(checked >= 30, `十分な手数を確かめた (${checked})`);
});

test("玉を取る手を指しても手駒に玉が入らず、戻せば元どおりになる", () => {
  // 読みの途中では「相手の玉を取る手」が現れることがある。昔はここで手駒に OU が生え、
  // `undefined + 1` で NaN になって評価値が丸ごと壊れ、点数を一切見ていない手が出ていた。
  // 普通の読みからは合法手の生成で弾かれるので、駒を動かす部品を直接呼んで確かめる。
  const api = loadWorker();
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  board[0][4] = { type: "OU", owner: GOTE };
  board[1][4] = { type: "HI", owner: SENTE };
  board[8][4] = { type: "OU", owner: SENTE };
  const hands = { [SENTE]: emptyHand(), [GOTE]: emptyHand() };

  api.board = board;
  api.capturedPieces = hands;
  api.currentPlayer = SENTE;
  api.recomputeKingPosCache();

  const before = snapshot(board);
  const takeKing = { type: "move", fromX: 4, fromY: 1, toX: 4, toY: 0, promote: false };
  const undo = api.applyMoveFast(takeKing, SENTE);

  assert.ok(!("OU" in hands[SENTE]), "玉を取っても手駒に玉が入らない");
  for (const count of Object.values(hands[SENTE])) assert.ok(Number.isFinite(count), "手駒の枚数が有限");
  assert.ok(Number.isFinite(api.minmaxEvaluate(SENTE)), "評価値が NaN にならない");

  api.undoMoveFast(undo);
  assert.equal(snapshot(board), before, "戻すと盤が元どおり");
  for (const [type, count] of Object.entries(hands[SENTE])) {
    assert.equal(count, 0, `戻すと手駒が元どおり (${type})`);
  }
});

// ---- 作戦（戦法） ----

const FILES = "abcdefghi";
const sq = (s) => ({ x: 9 - Number(s[0]), y: FILES.indexOf(s[1]) });

/** USI の手（駒を動かす手だけ）を盤と手駒に当てる */
function play(board, hands, usi, player) {
  const from = sq(usi.slice(0, 2));
  const to = sq(usi.slice(2, 4));
  const target = board[to.y][to.x];
  if (target) hands[player][target.type.replace("+", "")]++;
  board[to.y][to.x] = board[from.y][from.x];
  board[from.y][from.x] = null;
}

/** 平手から USI の手順を並べた局面 */
function position(moves) {
  const board = initialBoard();
  const hands = { [SENTE]: emptyHand(), [GOTE]: emptyHand() };
  moves.forEach((usi, i) => play(board, hands, usi, i % 2 === 0 ? SENTE : GOTE));
  return { board, hands, moveCount: moves.length, currentPlayer: moves.length % 2 === 0 ? SENTE : GOTE };
}

/** 本番と同じ onmessage を通して答えを1つ受け取る */
function ask(ctx, type, data) {
  let out = null;
  ctx.self.postMessage = (msg) => { out = msg; };
  ctx.self.onmessage({ data: { type, data } });
  return out;
}

function loadContext() {
  const ctx = { performance, console, Math, Date, JSON, self: {} };
  vm.createContext(ctx);
  const bridge = `
    globalThis.__api = {
      set board(v){board=v}, set capturedPieces(v){capturedPieces=v},
      set currentPlayer(v){currentPlayer=v}, set moveCount(v){moveCount=v},
      recomputeKingPosCache, getAllLegalMovesFast, getBestMoveWithWeakness, checkPlanSeparately,
      WEAKNESS_BY_DIFFICULTY, PLAN_WEAKNESS, STRATEGIES,
      get transpositionTable(){return transpositionTable},
      get knobs(){return { exchangeDepth, safeMove, safeDrop, dropBlind, farCapture, kingWeight, spreadPicks }},
    };
  `;
  vm.runInContext(readFileSync(WORKER_PATH, "utf8") + bridge, ctx, { filename: "ai-worker.js" });
  return ctx;
}

const request = (pos, aiPlayer, extra) => ({
  board: pos.board, capturedPieces: pos.hands, currentPlayer: aiPlayer, moveCount: pos.moveCount, aiPlayer, requestId: 1, ...extra,
});
const freshPlan = (id) => ({ id, rests: {}, misses: 0, off: false });
const usiOf = (m) => `${9 - m.fromX}${FILES[m.fromY]}${9 - m.toX}${FILES[m.toY]}`;

test("作戦の最初の手は合法手で、後手は盤を180度回した手になる", () => {
  const ctx = loadContext();
  const ids = Object.keys(ctx.__api.STRATEGIES);
  assert.ok(ids.length >= 6, "戦法が6種以上ある");
  for (const id of ids) {
    const first = ctx.__api.STRATEGIES[id].split(" ")[0];
    const senteUsi = first.slice(2, 6);
    const gote = senteUsi.replace(/(\d)([a-i])/g, (_, f, r) => `${10 - Number(f)}${FILES[8 - FILES.indexOf(r)]}`);

    const s = ask(ctx, "nextPlanMove", request(position([]), SENTE, { plan: freshPlan(id) }));
    assert.equal(s.data.planMove, senteUsi, `${id} の先手の1手目`);
    const g = ask(ctx, "nextPlanMove", request(position(["7g7f"]), GOTE, { plan: freshPlan(id) }));
    assert.equal(g.data.planMove, gote, `${id} の後手の1手目`);
  }
});

test("作戦の手は本物の盤で合法で、指した手と状態を返す（入門〜超級）", () => {
  for (const level of ["novice", "easy", "medium", "hard", "super"]) {
    const ctx = loadContext();
    const pos = position(["7g7f", "3c3d"]);
    const legal = (() => {
      ctx.__api.board = pos.board; ctx.__api.capturedPieces = pos.hands; ctx.__api.currentPlayer = SENTE;
      ctx.__api.moveCount = pos.moveCount; ctx.__api.recomputeKingPosCache();
      return ctx.__api.getAllLegalMovesFast(SENTE);
    })();
    const out = ask(ctx, "getBestMove", request(pos, SENTE, { aiDifficulty: level, plan: freshPlan("shiken_bisha") }));
    assert.ok(out.data.move, `${level} が手を返す`);
    assert.ok(legal.some((m) => sameMove(m, out.data.move)), `${level} の手は合法`);
    assert.equal(out.data.plan.id, "shiken_bisha", `${level} は作戦の状態を返す`);
  }
});

test("飛車を振る手には印を付ける（やねうら王が確かめで許す差を広げる）。取り返す飛車の手には付けない", () => {
  const ctx = loadContext();
  const swing = ask(ctx, "nextPlanMove", request(position(["7g7f", "3c3d", "6g6f", "8c8d"]), SENTE, { plan: freshPlan("shiken_bisha") }));
  assert.equal(swing.data.planMove, "2h6h");
  assert.equal(swing.data.planSwing, true);
  const pawn = ask(ctx, "nextPlanMove", request(position([]), SENTE, { plan: freshPlan("shiken_bisha") }));
  assert.equal(pawn.data.planMove, "7g7f");
  assert.equal(pawn.data.planSwing, false);
  // ▲6五歩・▲6四歩 を △同歩 と取られたあと、取り返す ▲6四飛
  const recapture = position(["7g7f", "3c3d", "6g6f", "8c8d", "2h6h", "8d8e", "5i4h", "7a6b", "4h3h", "5a4b",
    "3h2h", "4b3b", "3i3h", "1c1d", "6f6e", "1d1e", "6e6d", "6c6d"]);
  const r = ask(ctx, "nextPlanMove", request(recapture, SENTE, { plan: freshPlan("shiken_bisha") }));
  assert.equal(r.data.planMove, "6h6d");
  assert.equal(r.data.planSwing, false);
});

test("済んだ行・駒が無い行・休み中の行は飛ばし、休ませるのは見送ったその1行だけ", () => {
  const ctx = loadContext();
  // 棒銀：0 ▲2六歩 1 ▲2五歩 2 ▲7八金 3 ▲3八銀 …。▲2六歩は済んだ
  const pos = position(["2g2f", "8c8d"]);
  const next = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: freshPlan("bogin") }));
  assert.equal(next.data.planMove, "2f2e", "済んだ行の次の行");

  const skipped = next.data.ifSkipped;
  assert.deepEqual({ ...skipped.rests }, { 1: pos.moveCount + 4 }, "見送った1行だけを moveCount+4 まで休ませる");
  assert.equal(skipped.misses, 1, "見送りを1回数える");

  const resting = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: skipped }));
  assert.equal(resting.data.planMove, "6i7h", "休み中の行を飛ばして次の行");
  assert.equal(resting.data.ifUsed.misses, 0, "作戦の手を指せたら見送りは0に戻る");

  const later = position(["2g2f", "8c8d", "9g9f", "8d8e", "9f9e", "1c1d"]);
  const back = ask(ctx, "nextPlanMove", request(later, SENTE, { plan: skipped }));
  assert.equal(back.data.planMove, "2f2e", "休みが終われば、その行に戻る");
});

test("先の行を休ませている間、後ろの行の駒をその行き先や通り道に入れない", () => {
  const ctx = loadContext();
  // 四間飛車で玉が4八まで来たところ。▲3八玉の行を休ませると、▲3八銀は玉の行き先なので指さず、後ろの行へ進む
  const pos = position(["7g7f", "3c3d", "6g6f", "8c8d", "2h6h", "8d8e", "8h7g", "7a6b", "7i7h", "5a4b", "5i4h", "4b3b"]);
  const kingRow = ctx.__api.STRATEGIES.shiken_bisha.split(" ").indexOf("OU4h3h");
  const plan = { ...freshPlan("shiken_bisha"), rests: { [kingRow]: 99 } };
  const out = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan }));
  assert.ok(out.data.planMove, "後ろの行の手を返す");
  assert.notEqual(out.data.planMove, "3i3h", "玉の入る3八に銀を上げない");

  // 飛車を振る前（2行目）を休ませると、通り道の5八に金を上げる手は後ろの行でも指さない
  const early = position(["7g7f", "3c3d", "6g6f", "8c8d"]);
  const rows = ctx.__api.STRATEGIES.shiken_bisha.split(" ");
  const goldRow = rows.indexOf("KI6i5h");
  const restAll = Object.fromEntries(rows.map((_, i) => [i, 99]).filter(([i]) => Number(i) !== goldRow && Number(i) !== 2));
  const blocked = ask(ctx, "nextPlanMove", request(early, SENTE, { plan: { ...freshPlan("shiken_bisha"), rests: { ...restAll, 2: 99 } } }));
  assert.notEqual(blocked.data.planMove, "6i5h", "飛車の通り道をふさがない");

  // 玉がまだ5九のまま ▲4八玉 を休ませても、その先の3八（▲3八玉の行き先）に銀を上げない
  const before = position(["7g7f", "3c3d", "6g6f", "8c8d", "2h6h", "8d8e", "8h7g", "6a5b"]);
  const firstKing = rows.indexOf("OU5i4h");
  const waiting = ask(ctx, "nextPlanMove", request(before, SENTE, { plan: { ...freshPlan("shiken_bisha"), rests: { [firstKing]: 99 } } }));
  assert.ok(waiting.data.planMove, "後ろの行の手を返す");
  assert.notEqual(waiting.data.planMove, "3i3h", "玉がこのあと入る3八に銀を上げない");
});

test("仕掛けの歩が取られるのを待つ取り返しの行は、通り道を押さえず後ろの行を止めない", () => {
  const ctx = loadContext();
  // 三間飛車で ▲7四歩 と突いて、取られるのを待っている（取り返す ▲7四飛 の行は今は指せない）。
  // 飛車の通り道の7七を押さえると ▲7七角 がずっと止まる
  const pos = position(["7g7f", "1c1d", "6g6f", "9c9d", "2h7h", "1d1e", "5i4h", "9d9e", "4h3h", "4a4b",
    "3h2h", "6a6b", "3i3h", "4b4a", "7f7e", "6b6a", "7e7d", "3a3b"]);
  const out = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: freshPlan("sanken_bisha") }));
  assert.equal(out.data.planMove, "8h7g");
});

test("飛車を振る前は玉を囲いへ寄せない。振る先や通り道を自分の駒にふさがれたら、どくまで待つ", () => {
  const ctx = loadContext();
  // 三間飛車で ▲7八飛 を休ませている間に、普段の手の ▲7八金 が振る先に入った。飛車は2八のまま
  const gold = position(["7g7f", "8c8d", "6g6f", "8d8e", "8h7g", "3c3d", "6i7h", "7a6b"]);
  const stuck = ask(ctx, "nextPlanMove", request(gold, SENTE, { plan: { ...freshPlan("sanken_bisha"), rests: { 2: 8 } } }));
  assert.ok(stuck.data.planMove, "ほかの行の手を返す");
  assert.ok(!stuck.data.planMove.startsWith("5i"), "振っていない飛車のそばへ玉を寄せない");
  for (const sq of ["3h", "4h", "5h", "6h", "7e"]) assert.ok(!stuck.data.planMove.endsWith(sq), `通り道と、振ったあとに進む筋（${sq}）に駒を入れない`);
  assert.equal(stuck.data.ifNone.off, false, "金がどけば振れるので作戦は続く");
  // 金がどいたら振る
  const moved = position(["7g7f", "8c8d", "6g6f", "8d8e", "8h7g", "3c3d", "6i7h", "7a6b", "7h8h", "6b5c"]);
  const swing = ask(ctx, "nextPlanMove", request(moved, SENTE, { plan: { ...freshPlan("sanken_bisha"), rests: {} } }));
  assert.equal(swing.data.planMove, "2h7h", "振る");

  // 向かい飛車の振る先（8八）にいる角は先の行（▲7七角）が動かす。待つだけで作戦は続け、玉も寄せない
  const rows = ctx.__api.STRATEGIES.mukai_bisha.split(" ");
  const bishop = position(["7g7f", "3c3d", "6g6f", "8c8d"]);
  const waiting = ask(ctx, "nextPlanMove", request(bishop, SENTE, { plan: { ...freshPlan("mukai_bisha"), rests: { [rows.indexOf("KA8h7g")]: 99 } } }));
  assert.ok(waiting.data.planMove, "ほかの行の手を返す");
  assert.ok(!waiting.data.planMove.startsWith("5i"), "玉を動かさない");
  assert.equal(waiting.data.ifNone.off, false, "作戦は続く");

  // 振る前に飛車が2八から動いた（浮き飛車）。飛車のいる右側へ玉を寄せない
  const floating = position(["7g7f", "3c3d", "6g6f", "8c8d"]);
  floating.board[7][7] = null;
  floating.board[5][7] = { type: "HI", owner: SENTE };
  const out = ask(ctx, "nextPlanMove", request(floating, SENTE, { plan: freshPlan("shiken_bisha") }));
  assert.ok(out.data.planMove, "ほかの行の手を返す");
  assert.ok(!out.data.planMove.startsWith("5i"), "玉を動かさない");

  // 後手も同じ（盤を180度回して見る）。8二の飛車が8四へ浮いたら、左側（後手から見て右側）へ玉を寄せない
  const goteFloating = position(["7g7f", "3c3d", "6g6f", "4c4d", "2g2f"]);
  goteFloating.board[1][1] = null;
  goteFloating.board[3][1] = { type: "HI", owner: GOTE };
  const gote = ask(ctx, "nextPlanMove", request(goteFloating, GOTE, { plan: freshPlan("shiken_bisha") }));
  assert.ok(gote.data.planMove, "ほかの行の手を返す");
  assert.ok(!gote.data.planMove.startsWith("5a"), "後手も玉を動かさない");
});

test("見送りは連続で数え、5回で作戦を終える", () => {
  const ctx = loadContext();
  let plan = freshPlan("bogin");
  const pos = position([]);
  for (let i = 1; i <= 5; i++) {
    const out = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: { ...plan, rests: {} } }));
    plan = out.data.ifSkipped;
    assert.equal(plan.misses, i);
    assert.equal(plan.off, i >= 5, `${i}回目`);
  }
  const off = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan }));
  assert.equal(off.data.planMove, null, "終えた作戦は手を返さない");
});

test("その手番に指せる行が無くても作戦は終えない。指せる行が残っていなければ終える", () => {
  const ctx = loadContext();
  // 6九の金を後手の飛車に替えて王手をかけ、棒銀の行を3つ指せなくする（▲2六歩・▲3八銀は王手を外さない、▲6八玉は飛車の利き）
  const blocked = position([]);
  blocked.board[8][3] = { type: "HI", owner: GOTE };
  const out = ask(ctx, "nextPlanMove", request(blocked, SENTE, { plan: freshPlan("bogin") }));
  assert.equal(out.data.planMove, null, "指せない行を3つ見たら、その手番は諦める");
  assert.equal(out.data.ifNone.off, false, "作戦は続く");

  // 手順の駒がどれも元の場所にいない（全部の行が済みか駒が無い）なら終える
  const empty = Array.from({ length: 9 }, () => Array(9).fill(null));
  empty[8][0] = { type: "OU", owner: SENTE };
  empty[0][8] = { type: "OU", owner: GOTE };
  const pos = { board: empty, hands: { [SENTE]: emptyHand(), [GOTE]: emptyHand() }, moveCount: 10 };
  const done = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: freshPlan("shiken_bisha") }));
  assert.equal(done.data.planMove, null);
  assert.equal(done.data.ifNone.off, true, "指せる行が残っていなければ作戦を終える");
});

test("50手目を過ぎたら作戦の手を探さない", () => {
  const ctx = loadContext();
  const pos = position([]);
  pos.moveCount = 50;
  const out = ask(ctx, "nextPlanMove", request(pos, SENTE, { plan: freshPlan("bogin") }));
  assert.equal(out.data.planMove, null);
  assert.equal(out.data.ifNone.off, true, "作戦を終えた印を付ける（達人級以上で毎手聞きに行かない）");
});

test("損な作戦の手は指さず、その行を休ませて見送りを数える", () => {
  // 四間飛車の1手目 ▲7六歩。後手の銀が6五にいて、突いた歩をただで取られる
  for (const level of ["novice", "medium", "hard"]) {
    const ctx = loadContext();
    const pos = position([]);
    const p = sq("6e");
    pos.board[p.y][p.x] = { type: "GI", owner: GOTE };
    const out = ask(ctx, "getBestMove", request(pos, SENTE, { aiDifficulty: level, plan: freshPlan("shiken_bisha") }));
    // 入門・中級は見送ったあとの普段の手が散らしで同じ手になることもあるので、手は上級だけで見る
    if (level === "hard") assert.notEqual(usiOf(out.data.move), "7g7f", "上級は取られる歩を突かない");
    assert.equal(out.data.plan.misses, 1, `${level} は見送りを数える`);
    assert.equal(out.data.plan.rests[0], pos.moveCount + 4, `${level} はその行を休ませる`);
  }
});

test("確かめは確かめ専用の置換表で読み、普段の読みの表に書かない", () => {
  const ctx = loadContext();
  const api = ctx.__api;
  const pos = position(["7g7f", "3c3d"]);
  api.board = pos.board; api.capturedPieces = pos.hands; api.currentPlayer = SENTE;
  api.moveCount = pos.moveCount; api.recomputeKingPosCache();

  api.getBestMoveWithWeakness(2, SENTE, api.WEAKNESS_BY_DIFFICULTY.medium);
  const table = api.transpositionTable;
  const before = JSON.stringify([...table.entries()]);
  assert.ok(table.size > 0, "普段の読みで表が埋まる");

  // 答え（ok / bad、時間内に読み切れなければ null）は問わない。見るのは普段の表に触れていないことだけ
  api.checkPlanSeparately({ type: "move", fromX: 3, fromY: 6, toX: 3, toY: 5, promote: false }, SENTE);
  assert.equal(api.transpositionTable, table, "確かめのあと、普段の表に戻っている");
  assert.equal(JSON.stringify([...table.entries()]), before, "普段の表の中身は変わらない");
});

test("作戦の状態を渡さない依頼は今のつまみ、渡した依頼は作戦用のつまみで読む", () => {
  const ctx = loadContext();
  const api = ctx.__api;
  api.PLAN_WEAKNESS.medium = { exchange: 2, kingWeight: 0.5 };
  const pos = position(["7g7f", "3c3d"]);

  ask(ctx, "getBestMove", request(pos, SENTE, { aiDifficulty: "medium" }));
  assert.equal(api.knobs.exchangeDepth, 0, "作戦なし（チュートリアル・駒落ち・指し継ぎ）は今の中級のつまみ");
  assert.equal(api.knobs.kingWeight, 1);

  ask(ctx, "getBestMove", request(position(["7g7f", "3c3d"]), SENTE, { aiDifficulty: "medium", plan: { ...freshPlan("bogin"), off: true } }));
  assert.equal(api.knobs.exchangeDepth, 2, "作戦つきは作戦を終えたあとも作戦用のつまみ");
  assert.equal(api.knobs.kingWeight, 0.5);
});
