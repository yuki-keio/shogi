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
      set josekiEnabled(v){josekiEnabled=v},
      recomputeKingPosCache, getAllLegalMovesFast, applyMoveFast, undoMoveFast,
      getBestMoveWithWeakness, WEAKNESS_BY_DIFFICULTY, minmaxEvaluate,
      get kingPosCache(){return kingPosCache},
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
    api.josekiEnabled = false;
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
