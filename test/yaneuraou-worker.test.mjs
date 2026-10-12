// SPDX-License-Identifier: GPL-3.0-only

// やねうら王の計算役が、答えを頼んだ依頼へ正しく返すことを見張る回帰テスト。
// 以前は待ち受けを1つの変数で上書きしていたため、思考中に次の依頼（待った→別の手・新規対局など）が来ると
// 前の局面への答えが新しい依頼の答えとして返り、前の局面向けの手が今の盤に指されていた。
// ファイルは無改変のまま Node の vm に読み込み、エンジンだけ「局面ごとに決まった答えを後から返す」偽物に差し替える。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const WORKER_PATH = fileURLToPath(new URL("../yaneuraou-worker.js", import.meta.url));

// △3四歩 = 3c3d（6,2 → 6,3）、△8四歩 = 8c8d（1,2 → 1,3）
const ANSWERS = { "position startpos moves 7g7f": "bestmove 3c3d", "position startpos moves 2g2f": "bestmove 8c8d" };

/**
 * 本物と同じく、読みは頼んだ順に1つずつ終わり、答えの行は後から届く。silent に入れた局面では bestmove を出さない。
 * getoption の返事は本物と同じ形（区切りに使われる）。届いたコマンドは commands に残す
 */
function loadWorker({ silent = [] } = {}) {
  const ctx = { self: {}, console, setTimeout, clearTimeout, performance, Math, JSON };
  vm.createContext(ctx);
  const bridge = `globalThis.__api = { set engine(v){engine=v}, set engineReady(v){engineReady=v}, getBestMove, handleEngineMessage };`;
  vm.runInContext(readFileSync(WORKER_PATH, "utf8") + bridge, ctx, { filename: "yaneuraou-worker.js" });
  const api = ctx.__api;
  api.commands = [];
  let position = null;
  api.engine = {
    postMessage(command) {
      api.commands.push(command);
      if (command.startsWith("position")) position = command;
      if (command.startsWith("go") && !silent.includes(position)) {
        const line = ANSWERS[position];
        setTimeout(() => api.handleEngineMessage(line), 0);
      }
      if (command === "getoption USI_Hash") setTimeout(() => api.handleEngineMessage("Options[USI_Hash] == 16"), 0);
    },
  };
  api.engineReady = true;
  return api;
}

const within = (promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("答えが返らない依頼がある")), 1000))]);
const squares = (m) => [m.fromX, m.fromY, m.toX, m.toY];

test("思考中に次の依頼が来ても、それぞれの依頼に自分の局面への答えが返る", async () => {
  const api = loadWorker();
  const first = api.getBestMove(null, null, "gote", "legendary3", ["7g7f"]);
  const second = api.getBestMove(null, null, "gote", "legendary3", ["2g2f"]);
  const [a, b] = await within(Promise.all([first, second]));
  assert.deepEqual(squares(a), [6, 2, 6, 3], "1つ目の依頼には ▲7六歩 への答え");
  assert.deepEqual(squares(b), [1, 2, 1, 3], "2つ目の依頼には ▲2六歩 への答え");
  // isready はやねうら王の読みの記憶（置換表）を消すので、起動のあとに送ると毎手浅く読んで弱くなる
  assert.ok(!api.commands.includes("isready"), "指し手の依頼で isready を送らない");
});

test("エンジンが答えを出さなかった依頼は失敗になり、次の依頼の答えはずれない", async () => {
  const api = loadWorker({ silent: ["position startpos moves 7g7f"] });
  const first = api.getBestMove(null, null, "gote", "legendary3", ["7g7f"]);
  const second = api.getBestMove(null, null, "gote", "legendary3", ["2g2f"]);
  const [a, b] = await within(Promise.allSettled([first, second]));
  assert.equal(a.status, "rejected", "答えの無かった依頼は失敗として返る（呼び出し側が通常AIに引き継ぐ）");
  assert.equal(b.status, "fulfilled");
  assert.deepEqual(squares(b.value), [1, 2, 1, 3], "次の依頼には自分の局面への答え");
});

test("駒落ちは開始局面のSFENから手順を並べる（平手の初形で読まない）", async () => {
  const api = loadWorker({ silent: ["position sfen lnsgkgsnl/7b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1 moves 9c9d"] });
  const sfen = "lnsgkgsnl/7b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1";
  api.getBestMove(null, null, "sente", "legendary3", ["9c9d"], sfen).catch(() => {});
  assert.ok(api.commands.includes(`position sfen ${sfen} moves 9c9d`));
  api.getBestMove(null, null, "gote", "legendary3", ["7g7f"]).catch(() => {});
  assert.ok(api.commands.includes("position startpos moves 7g7f"), "平手は従来どおり startpos");
});

test("起動時に入玉宣言を切る（'bestmove win' を返させない）", () => {
  // サイトに入玉宣言のルールは無い。既定の CSARule27 のままだと宣言できる局面で 'bestmove win' が返り、
  // 指し手なし＝AIの詰みとして人間の勝ちにされていた
  const api = loadWorker();
  api.handleEngineMessage("usiok");
  const option = api.commands.indexOf("setoption name EnteringKingRule value NoEnteringKing");
  assert.ok(option !== -1, "EnteringKingRule を NoEnteringKing にする");
  assert.ok(option < api.commands.indexOf("isready"), "isready より前に設定する");
});

// ---- 戦法を指定した対局（作戦の手を浅く読んで確かめる） ----

/**
 * 読みごとに答えを決められる偽物のエンジン。reply(position, go) が返す行（info … と bestmove …）を後から届ける。
 * null を返すと bestmove を出さない（読みの失敗）
 */
function loadPlanned(reply) {
  const ctx = { self: {}, console, setTimeout, clearTimeout, performance, Math, JSON };
  vm.createContext(ctx);
  const bridge = `globalThis.__api = { set engine(v){engine=v}, set engineReady(v){engineReady=v}, getBestMove, getPlannedMove, handleEngineMessage };`;
  vm.runInContext(readFileSync(WORKER_PATH, "utf8") + bridge, ctx, { filename: "yaneuraou-worker.js" });
  const api = ctx.__api;
  api.goes = [];
  let position = null;
  api.engine = {
    postMessage(command) {
      if (command.startsWith("position")) position = command;
      if (command.startsWith("go")) {
        api.goes.push(command);
        const lines = reply(position, command);
        if (lines) setTimeout(() => lines.forEach((l) => api.handleEngineMessage(l)), 0);
      }
      if (command === "getoption USI_Hash") setTimeout(() => api.handleEngineMessage("Options[USI_Hash] == 16"), 0);
    },
  };
  api.engineReady = true;
  return api;
}

const PLAN = "2g2f"; // 作戦の手（▲2六歩）
const planned = (api, level = "legendary3") => within(api.getPlannedMove(null, null, "sente", level, ["7g7f", "3c3d"], null, PLAN));
const usi = (m) => m && `${9 - m.fromX}${"abcdefghi"[m.fromY]}${9 - m.toX}${"abcdefghi"[m.toY]}`;
const NORMAL = "go nodes 1000000";

test("作戦の手が最善なら、確かめ1回で指す", async () => {
  const api = loadPlanned(() => ["info depth 8 score cp 40 nodes 5000 pv 2g2f", `bestmove ${PLAN}`]);
  const r = await planned(api);
  assert.equal(r.plan, "used");
  assert.equal(usi(r.move), PLAN);
  assert.deepEqual(api.goes, ["go nodes 5000"], "そのレベル本来の量では読まない");
});

test("最善から150cp以内なら作戦の手を指し、それより損なら見送って普段の読みの手を指す", async () => {
  for (const [planScore, expect] of [[-100, "used"], [-120, "skipped"]]) {
    const api = loadPlanned((pos, go) => go.includes("searchmoves")
      ? [`info depth 8 score cp ${planScore} pv ${PLAN}`, `bestmove ${PLAN}`]
      : go === NORMAL ? ["info score cp 30", "bestmove 6i7h"] : ["info depth 8 score cp 40 pv 8h2b+", "bestmove 8h2b+"]);
    const r = await planned(api);
    assert.equal(r.plan, expect, `作戦の手が ${40 - planScore}cp 損`);
    assert.equal(usi(r.move), expect === "used" ? PLAN : "6i7h");
    assert.equal(api.goes.includes(NORMAL), expect === "skipped", "見送ったときだけ本来の量で読む");
  }
});

test("飛車を振る手だけは200cp以内まで指す（ほかの作戦の手は150cp）。最善が駒を取る手でも同じ", async () => {
  // 最善は ▲2二角成。盤を渡すと、行き先の2二に後手の角がいる（＝駒を取る手）
  const capturable = Array.from({ length: 9 }, () => Array(9).fill(null));
  capturable[1][7] = { type: "KA", owner: "gote" };
  for (const [swing, loss, board, expect, label] of [
    [true, 190, null, "used", "振る手は190cp損でも指す"],
    [true, 210, null, "skipped", "振る手でも210cp損なら見送る"],
    [false, 190, null, "skipped", "ほかの手は190cp損なら見送る"],
    [true, 190, capturable, "used", "最善が駒を取る手でも、振る手の許す差は同じ"],
  ]) {
    const api = loadPlanned((pos, go) => go.includes("searchmoves")
      ? [`info depth 8 score cp ${40 - loss} pv ${PLAN}`, `bestmove ${PLAN}`]
      : go === NORMAL ? ["info score cp 30", "bestmove 6i7h"] : ["info depth 8 score cp 40 pv 8h2b+", "bestmove 8h2b+"]);
    const r = await within(api.getPlannedMove(board, null, "sente", "legendary3", ["7g7f", "3c3d"], null, PLAN, swing));
    assert.equal(r.plan, expect, label);
  }
});

test("確かめで resign が返っても、それを指さずに普段の読みの手を指す", async () => {
  const api = loadPlanned((pos, go) => go.includes("searchmoves") ? ["info score mate -0", "bestmove resign"]
    : go === NORMAL ? ["bestmove 6i7h"] : ["info score cp 40", "bestmove 8h2b+"]);
  const r = await planned(api);
  assert.equal(r.plan, "skipped");
  assert.equal(usi(r.move), "6i7h", "null（＝AIが詰んだ）や作戦の手にならない");
});

test("確かめが失敗しても依頼は失敗にせず、作戦を使わない手番として普段の読みの手を指す", async () => {
  const api = loadPlanned((pos, go) => (go === NORMAL ? ["bestmove 6i7h"] : null));
  const r = await planned(api);
  assert.equal(r.plan, "none", "作戦の状態は変えない");
  assert.equal(usi(r.move), "6i7h");
});

test("達人級は確かめ1と同じ量なので、見送ったら確かめ1の手をそのまま指す", async () => {
  const api = loadPlanned((pos, go) => go.includes("searchmoves") ? ["info score cp -300", `bestmove ${PLAN}`] : ["info score cp 40", "bestmove 8h2b+"]);
  const r = await planned(api, "master");
  assert.equal(r.plan, "skipped");
  assert.equal(usi(r.move), "8h2b");
  assert.equal(api.goes.length, 2, "読みは2回だけ");
});

test("窓の外れの印が付いた点は使わず、詰みは ±30000 とみなす", async () => {
  // 最後の行が印つき（lowerbound 300）。印の無い 100 と比べれば作戦の手（-40）は140cp差で指せる
  const api = loadPlanned((pos, go) => go.includes("searchmoves") ? ["info score cp -40", `bestmove ${PLAN}`]
    : ["info depth 7 score cp 100 pv 8h2b+", "info depth 8 score cp 300 lowerbound pv 8h2b+", "bestmove 8h2b+"]);
  assert.equal((await planned(api)).plan, "used");
  const mate = loadPlanned((pos, go) => go.includes("searchmoves") ? ["info score cp 500", `bestmove ${PLAN}`]
    : go === NORMAL ? ["bestmove 5i4h"] : ["info score mate 5", "bestmove 5i4h"]);
  assert.equal((await planned(mate)).plan, "skipped", "詰みがあるのに作戦の手は指さない");
});

test("作戦の確かめの途中で別の依頼が来ても、答えを取り違えない", async () => {
  const api = loadPlanned((pos, go) => {
    if (pos.endsWith("2g2f")) return ["info score cp 10", "bestmove 8c8d"]; // 別の依頼（▲2六歩の局面）
    if (go.includes("searchmoves")) return ["info score cp -500", `bestmove ${PLAN}`];
    return go === NORMAL ? ["bestmove 6i7h"] : ["info score cp 40", "bestmove 8h2b+"];
  });
  const a = api.getPlannedMove(null, null, "sente", "legendary3", ["7g7f", "3c3d"], null, PLAN);
  const b = api.getBestMove(null, null, "gote", "legendary3", ["2g2f"]);
  const [ra, rb] = await within(Promise.all([a, b]));
  assert.equal(usi(ra.move), "6i7h", "作戦の依頼には自分の局面の手");
  assert.equal(usi(rb), "8c8d", "割り込んだ依頼には自分の局面の手");
});
