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
