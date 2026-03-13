import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { NODE_IDS } from "../src/engine/board.js";
import { SIDES } from "../src/engine/constants.js";

let aiInternalsPromise = null;

async function loadAiInternals() {
  if (!aiInternalsPromise) {
    const moduleUrl = new URL("../src/ai/shared.js", import.meta.url);
    const srcRoot = new URL("../src/", import.meta.url).href;
    let source = await fs.readFile(moduleUrl, "utf8");

    source = source.replace("../engine/constants.js", `${srcRoot}engine/constants.js`);
    source = source.replace("../engine/board.js", `${srcRoot}engine/board.js`);
    source = source.replace("../engine/rules.js", `${srcRoot}engine/rules.js`);
    source += "\nexport { assignCandidateTypes, inferEnemyCandidates };\n";

    aiInternalsPromise = import(`data:text/javascript,${encodeURIComponent(source)}`);
  }

  return aiInternalsPromise;
}

function createView({ pieces, history, turn = SIDES.AI }) {
  const board = Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, null]));
  const pieceMap = {};

  for (const piece of pieces) {
    pieceMap[piece.id] = piece;
    if (piece.nodeId) {
      board[piece.nodeId] = piece;
    }
  }

  return {
    phase: "battle",
    turn,
    turnCount: history.length + 1,
    difficulty: "hard",
    winner: null,
    winReason: null,
    revealAll: false,
    board,
    pieces: pieceMap,
    history,
  };
}

test("AI inference keeps battle deductions after the hidden enemy piece moves away", async () => {
  const { inferEnemyCandidates } = await loadAiInternals();
  const view = createView({
    pieces: [
      {
        id: "p_hidden",
        side: SIDES.PLAYER,
        type: null,
        nodeId: "C6",
        alive: true,
        moveCount: 1,
        known: false,
      },
      {
        id: "a_marshal",
        side: SIDES.AI,
        type: "marshal",
        nodeId: null,
        alive: false,
        moveCount: 1,
        known: true,
      },
    ],
    history: [
      {
        turnNumber: 1,
        side: SIDES.AI,
        pieceId: "a_marshal",
        from: "C6",
        to: "C7",
        path: ["C6", "C7"],
        battle: {
          attackerId: "a_marshal",
          defenderId: "p_hidden",
          outcome: "defender",
          reason: "spy",
          attackerRemoved: true,
          defenderRemoved: false,
          removedIds: ["a_marshal"],
          attackerLabel: "大将",
          defenderLabel: null,
        },
      },
      {
        turnNumber: 2,
        side: SIDES.PLAYER,
        pieceId: "p_hidden",
        from: "C7",
        to: "C6",
        path: ["C7", "C6"],
        battle: null,
      },
    ],
  });

  assert.deepEqual([...inferEnemyCandidates(view).p_hidden], ["spy"]);
});

test("AI inference learns from battles initiated by the hidden enemy piece", async () => {
  const { inferEnemyCandidates } = await loadAiInternals();
  const view = createView({
    pieces: [
      {
        id: "p_hidden",
        side: SIDES.PLAYER,
        type: null,
        nodeId: "C7",
        alive: true,
        moveCount: 1,
        known: false,
      },
      {
        id: "a_marshal",
        side: SIDES.AI,
        type: "marshal",
        nodeId: null,
        alive: false,
        moveCount: 0,
        known: true,
      },
    ],
    history: [
      {
        turnNumber: 1,
        side: SIDES.PLAYER,
        pieceId: "p_hidden",
        from: "C8",
        to: "C7",
        path: ["C8", "C7"],
        battle: {
          attackerId: "p_hidden",
          defenderId: "a_marshal",
          outcome: "attacker",
          reason: "spy",
          attackerRemoved: false,
          defenderRemoved: true,
          removedIds: ["a_marshal"],
          attackerLabel: null,
          defenderLabel: "大将",
        },
      },
    ],
  });

  assert.deepEqual([...inferEnemyCandidates(view).p_hidden], ["spy"]);
});

test("AI hidden-piece assignment preserves inventory when a valid mapping exists", async () => {
  const { assignCandidateTypes } = await loadAiInternals();
  const hiddenEnemyPieces = [{ id: "p_one" }, { id: "p_two" }];
  const candidateMap = {
    p_one: new Set(["marshal"]),
    p_two: new Set(["marshal", "general"]),
  };
  const originalRandom = Math.random;
  const sequence = [0, 0.75];
  let index = 0;

  Math.random = () => sequence[index++ % sequence.length];

  try {
    assert.deepEqual(assignCandidateTypes(hiddenEnemyPieces, candidateMap), {
      p_one: "marshal",
      p_two: "general",
    });
  } finally {
    Math.random = originalRandom;
  }
});
