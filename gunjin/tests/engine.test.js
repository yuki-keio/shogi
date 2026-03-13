import test from "node:test";
import assert from "node:assert/strict";

import { AI_HQ, DISPLAY_SLOTS, HOME_NODES, NODE_IDS, PLAYER_HQ, getRearNode } from "../src/engine/board.js";
import { PIECE_DEFS, SIDES } from "../src/engine/constants.js";
import { compareTypes, compareTypesFromPerspective, applyMove, getLegalMovesForPiece } from "../src/engine/rules.js";
import {
  applyPresetToSetup,
  createEmptySetupState,
  setPiecePlacement,
  validateSetup,
} from "../src/engine/setup.js";
import { deriveViewerState } from "../src/engine/view.js";
import { getPieceTokenViewModel } from "../src/ui/piece-token.js";

function createState({ turn = SIDES.PLAYER, pieces = [] }) {
  const board = Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, null]));
  const pieceMap = {};
  for (const piece of pieces) {
    pieceMap[piece.id] = {
      id: piece.id,
      side: piece.side,
      type: piece.type,
      nodeId: piece.nodeId,
      alive: true,
      moveCount: 0,
    };
    board[piece.nodeId] = piece.id;
  }
  return {
    phase: "battle",
    turn,
    turnCount: 1,
    difficulty: "medium",
    winner: null,
    winReason: null,
    board,
    pieces: pieceMap,
    history: [],
    aiSetupMeta: {},
  };
}

test("home nodes treat HQ as one node", () => {
  assert.equal(HOME_NODES[SIDES.PLAYER].length, 23);
  assert.equal(HOME_NODES[SIDES.AI].length, 23);
  assert.equal(HOME_NODES[SIDES.PLAYER].filter((nodeId) => nodeId === PLAYER_HQ).length, 1);
  assert.equal(HOME_NODES[SIDES.AI].filter((nodeId) => nodeId === AI_HQ).length, 1);
});

test("setup validation rejects flag on the player's back rank", () => {
  const setupState = applyPresetToSetup(createEmptySetupState(), "balanced");
  const flag = setupState.pieces.find((piece) => piece.type === "flag");
  const backRankPiece = setupState.pieces.find((piece) => piece.nodeId === "B9");

  setupState.placements[flag.nodeId] = backRankPiece.id;
  setupState.placements.B9 = flag.id;
  backRankPiece.nodeId = flag.nodeId;
  flag.nodeId = "B9";

  const validation = validateSetup(setupState);

  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "軍旗は自陣最後尾列に置けません。");
});

test("setup validation rejects mines and flags on bridge approach nodes", () => {
  const setupState = applyPresetToSetup(createEmptySetupState(), "balanced");
  const mine = setupState.pieces.find((piece) => piece.type === "mine");
  const entrancePiece = setupState.pieces.find((piece) => piece.nodeId === "B6");

  setupState.placements[mine.nodeId] = entrancePiece.id;
  setupState.placements.B6 = mine.id;
  entrancePiece.nodeId = mine.nodeId;
  mine.nodeId = "B6";

  const validation = validateSetup(setupState);

  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "突入口には地雷・軍旗を置けません。");
});

test("setPiecePlacement ignores forbidden setup targets", () => {
  const setupState = createEmptySetupState();
  const flag = setupState.pieces.find((piece) => piece.type === "flag");
  const mine = setupState.pieces.find((piece) => piece.type === "mine");

  const blockedFlagSetup = setPiecePlacement(setupState, flag.id, "B6");
  const blockedMineSetup = setPiecePlacement(setupState, mine.id, "E6");

  assert.equal(blockedFlagSetup.pieces.find((piece) => piece.id === flag.id)?.nodeId, null);
  assert.equal(blockedMineSetup.pieces.find((piece) => piece.id === mine.id)?.nodeId, null);
  assert.equal(blockedFlagSetup.placements.B6, undefined);
  assert.equal(blockedMineSetup.placements.E6, undefined);
});

test("setPiecePlacement rejects swaps that would place a flag or mine on forbidden nodes", () => {
  const flagSetup = applyPresetToSetup(createEmptySetupState(), "balanced");
  const flag = flagSetup.pieces.find((piece) => piece.type === "flag");
  const backRankPiece = flagSetup.pieces.find((piece) => piece.nodeId === "B9");
  const blockedFlagSwap = setPiecePlacement(flagSetup, backRankPiece.id, flag.nodeId);

  assert.equal(blockedFlagSwap.pieces.find((piece) => piece.id === flag.id)?.nodeId, flag.nodeId);
  assert.equal(blockedFlagSwap.pieces.find((piece) => piece.id === backRankPiece.id)?.nodeId, "B9");
  assert.equal(blockedFlagSwap.placements[flag.nodeId], flag.id);
  assert.equal(blockedFlagSwap.placements.B9, backRankPiece.id);

  const mineSetup = applyPresetToSetup(createEmptySetupState(), "balanced");
  const mine = mineSetup.pieces.find((piece) => piece.type === "mine");
  const entrancePiece = mineSetup.pieces.find((piece) => piece.nodeId === "B6");
  const blockedMineSwap = setPiecePlacement(mineSetup, entrancePiece.id, mine.nodeId);

  assert.equal(blockedMineSwap.pieces.find((piece) => piece.id === mine.id)?.nodeId, mine.nodeId);
  assert.equal(blockedMineSwap.pieces.find((piece) => piece.id === entrancePiece.id)?.nodeId, "B6");
  assert.equal(blockedMineSwap.placements[mine.nodeId], mine.id);
  assert.equal(blockedMineSwap.placements.B6, entrancePiece.id);
});

test("bridge cells stay on the display grid but are not playable nodes", () => {
  assert.equal(DISPLAY_SLOTS.find((slot) => slot.displayId === "B5")?.nodeId, null);
  assert.equal(DISPLAY_SLOTS.find((slot) => slot.displayId === "E5")?.nodeId, null);
  assert(!NODE_IDS.includes("B5"));
  assert(!NODE_IDS.includes("E5"));
});

test("HQ move generation exposes front and side exits for player HQ", () => {
  const state = createState({
    pieces: [{ id: "p_marshal", side: SIDES.PLAYER, type: "marshal", nodeId: PLAYER_HQ }],
  });
  const moves = getLegalMovesForPiece(state, "p_marshal").map((move) => move.to).sort();
  assert.deepEqual(moves, ["B9", "C8", "D8", "E9"]);
});

test("back-rank flank nodes can enter HQ horizontally", () => {
  const playerState = createState({
    pieces: [{ id: "p_captain", side: SIDES.PLAYER, type: "captain", nodeId: "B9" }],
  });
  const aiState = createState({
    turn: SIDES.AI,
    pieces: [{ id: "a_captain", side: SIDES.AI, type: "captain", nodeId: "E1" }],
  });

  const playerMoves = getLegalMovesForPiece(playerState, "p_captain").map((move) => move.to);
  const aiMoves = getLegalMovesForPiece(aiState, "a_captain").map((move) => move.to);

  assert(playerMoves.includes(PLAYER_HQ));
  assert(aiMoves.includes(AI_HQ));
});

test("bridge acts as a passage for ground pieces while aircraft may cross any file", () => {
  const groundState = createState({
    pieces: [{ id: "p_captain", side: SIDES.PLAYER, type: "captain", nodeId: "B6" }],
  });
  const aircraftState = createState({
    pieces: [{ id: "p_air", side: SIDES.PLAYER, type: "aircraft", nodeId: "A6" }],
  });
  const groundMoves = getLegalMovesForPiece(groundState, "p_captain").map((move) => move.to);
  const bridgeMove = getLegalMovesForPiece(groundState, "p_captain").find((move) => move.to === "B4");
  const airMoves = getLegalMovesForPiece(aircraftState, "p_air").map((move) => move.to);

  assert(bridgeMove);
  assert.deepEqual(bridgeMove.path, ["B6", "B5", "B4"]);
  assert(!groundMoves.includes("B5"));
  assert(airMoves.includes("A4"));
});

test("tank forward two-step requires a clear middle node after crossing the bridge", () => {
  const clearState = createState({
    pieces: [{ id: "p_tank", side: SIDES.PLAYER, type: "tank", nodeId: "B7" }],
  });
  const blockedState = createState({
    pieces: [
      { id: "p_tank", side: SIDES.PLAYER, type: "tank", nodeId: "B7" },
      { id: "a_guard", side: SIDES.AI, type: "captain", nodeId: "B6" },
    ],
  });

  const clearMoves = getLegalMovesForPiece(clearState, "p_tank").map((move) => move.to);
  const blockedMoves = getLegalMovesForPiece(blockedState, "p_tank").map((move) => move.to);

  assert(clearMoves.includes("B4"));
  assert(!blockedMoves.includes("B4"));
});

test("engineer moves straight through the bridge lane", () => {
  const state = createState({
    pieces: [{ id: "p_eng", side: SIDES.PLAYER, type: "engineer", nodeId: "B6" }],
  });
  const move = getLegalMovesForPiece(state, "p_eng").find((candidate) => candidate.to === "B2");
  assert(move);
  assert.deepEqual(move.path, ["B6", "B5", "B4", "B3", "B2"]);
});

test("rear support crosses the bridge as a single node step", () => {
  assert.equal(getRearNode("B4", SIDES.PLAYER), "B6");
  assert.equal(getRearNode("B6", SIDES.AI), "B4");
});

test("flag backed by mine removes attacker and flag only", () => {
  const state = createState({
    turn: SIDES.AI,
    pieces: [
      { id: "a_captain", side: SIDES.AI, type: "captain", nodeId: "B7" },
      { id: "p_flag", side: SIDES.PLAYER, type: "flag", nodeId: "B8" },
      { id: "p_mine", side: SIDES.PLAYER, type: "mine", nodeId: "B9" },
    ],
  });
  const move = getLegalMovesForPiece(state, "a_captain").find((candidate) => candidate.to === "B8");
  const next = applyMove(state, move);

  assert.equal(next.pieces.a_captain.alive, false);
  assert.equal(next.pieces.p_flag.alive, false);
  assert.equal(next.pieces.p_mine.alive, true);
  assert.equal(next.board.B8, null);
  assert.equal(next.board.B9, "p_mine");
});

test("landmine removes itself against ordinary attackers", () => {
  const state = createState({
    pieces: [
      { id: "p_captain", side: SIDES.PLAYER, type: "captain", nodeId: "B7" },
      { id: "a_mine", side: SIDES.AI, type: "mine", nodeId: "B6" },
    ],
  });
  const move = getLegalMovesForPiece(state, "p_captain").find((candidate) => candidate.to === "B6");
  const next = applyMove(state, move);

  assert.equal(next.pieces.p_captain.alive, false);
  assert.equal(next.pieces.a_mine.alive, false);
  assert.equal(next.board.B6, null);
});

test("same piece types fight to mutual removal", () => {
  const state = createState({
    pieces: [
      { id: "p_tank", side: SIDES.PLAYER, type: "tank", nodeId: "C7" },
      { id: "a_tank", side: SIDES.AI, type: "tank", nodeId: "C6" },
    ],
  });
  const move = getLegalMovesForPiece(state, "p_tank").find((candidate) => candidate.to === "C6");
  const next = applyMove(state, move);

  assert.equal(next.pieces.p_tank.alive, false);
  assert.equal(next.pieces.a_tank.alive, false);
  assert.equal(next.board.C6, null);
});

test("capturing the enemy HQ finishes the game once", () => {
  const state = createState({
    pieces: [{ id: "p_major", side: SIDES.PLAYER, type: "major", nodeId: "C2" }],
  });
  const move = getLegalMovesForPiece(state, "p_major").find((candidate) => candidate.to === AI_HQ);
  const next = applyMove(state, move);

  assert.equal(next.phase, "finished");
  assert.equal(next.winner, SIDES.PLAYER);
  assert.equal(next.winReason, "hq");
  assert.equal(next.board[AI_HQ], "p_major");
  assert.equal(next.history.length, 1);
});

test("eliminating the last movable enemy piece wins by elimination", () => {
  const state = createState({
    pieces: [
      { id: "p_general", side: SIDES.PLAYER, type: "general", nodeId: "C7" },
      { id: "a_spy", side: SIDES.AI, type: "spy", nodeId: "C6" },
      { id: "a_flag", side: SIDES.AI, type: "flag", nodeId: "A1" },
      { id: "a_mine1", side: SIDES.AI, type: "mine", nodeId: "B1" },
      { id: "a_mine2", side: SIDES.AI, type: "mine", nodeId: "E1" },
    ],
  });
  const move = getLegalMovesForPiece(state, "p_general").find((candidate) => candidate.to === "C6");
  const next = applyMove(state, move);

  assert.equal(next.phase, "finished");
  assert.equal(next.winner, SIDES.PLAYER);
  assert.equal(next.winReason, "elimination");
});

test("AI viewer state hides player piece types", () => {
  const state = createState({
    pieces: [
      { id: "p_marshal", side: SIDES.PLAYER, type: "marshal", nodeId: "C8" },
      { id: "a_major", side: SIDES.AI, type: "major", nodeId: "C2" },
    ],
  });
  const aiView = deriveViewerState(state, SIDES.AI);

  assert.equal(aiView.pieces.p_marshal.type, null);
  assert.equal(aiView.pieces.a_major.type, "major");
});

test("hidden enemy battle tokens stay reversed and label-free", () => {
  const viewModel = getPieceTokenViewModel(
    { id: "a_major", side: SIDES.AI, type: "major" },
    { context: "battle", hidden: true, draggable: false },
  );

  assert.equal(viewModel.isOpponentPiece, true);
  assert.equal(viewModel.isReadableFromViewer, false);
  assert.equal(viewModel.showLabel, false);
  assert.equal(viewModel.badgeHtml, "");
});

test("revealed enemy battle tokens keep the piece reversed but rotate the face back", () => {
  const viewModel = getPieceTokenViewModel(
    { id: "a_major", side: SIDES.AI, type: "major" },
    { context: "battle", hidden: false, draggable: false },
  );

  assert.equal(viewModel.isOpponentPiece, true);
  assert.equal(viewModel.isReadableFromViewer, true);
  assert.equal(viewModel.showLabel, true);
  assert.equal(viewModel.label, PIECE_DEFS.major.label);
  assert.notEqual(viewModel.badgeHtml, "");
});

test("compareTypes matches aircraft and spy special rules", () => {
  assert.equal(compareTypes("aircraft", "colonel").outcome, "attacker");
  assert.equal(compareTypes("aircraft", "general").outcome, "defender");
  assert.equal(compareTypes("spy", "marshal").outcome, "attacker");
  assert.equal(compareTypes("spy", "captain").outcome, "defender");
});

test("compareTypesFromPerspective treats mine as a defending matchup", () => {
  assert.equal(compareTypesFromPerspective("mine", "marshal").outcome, "mutual");
  assert.equal(compareTypesFromPerspective("mine", "captain").outcome, "mutual");
  assert.equal(compareTypesFromPerspective("mine", "engineer").outcome, "opponent");
  assert.equal(compareTypesFromPerspective("mine", "aircraft").outcome, "opponent");
  assert.equal(compareTypesFromPerspective("captain", "mine").outcome, "mutual");
});

test("officer pieces expose star metadata and special pieces do not", () => {
  const expectedOfficerVisuals = {
    marshal: { type: "officer", officerClass: "general", stars: 3 },
    general: { type: "officer", officerClass: "general", stars: 2 },
    brigadier: { type: "officer", officerClass: "general", stars: 1 },
    colonel: { type: "officer", officerClass: "senior", stars: 3 },
    lieutenantColonel: { type: "officer", officerClass: "senior", stars: 2 },
    major: { type: "officer", officerClass: "senior", stars: 1 },
    captain: { type: "officer", officerClass: "junior", stars: 3 },
    lieutenant: { type: "officer", officerClass: "junior", stars: 2 },
    secondLieutenant: { type: "officer", officerClass: "junior", stars: 1 },
  };

  for (const [type, visual] of Object.entries(expectedOfficerVisuals)) {
    assert.deepEqual(PIECE_DEFS[type].tokenVisual, visual);
  }

  for (const type of ["cavalry", "spy", "flag", "mine", "engineer", "tank", "aircraft"]) {
    assert.equal(PIECE_DEFS[type].tokenVisual, undefined);
  }
});
