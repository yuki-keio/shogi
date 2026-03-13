import { GAME_PHASES, SIDES } from "./constants.js";
import { NODE_IDS } from "./board.js";

export function createGameState({ playerSetup, aiSetup, difficulty }) {
  const board = Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, null]));
  const pieces = {};

  for (const piece of [...playerSetup.pieces, ...aiSetup.pieces]) {
    pieces[piece.id] = {
      id: piece.id,
      side: piece.side,
      type: piece.type,
      nodeId: piece.nodeId,
      alive: true,
      moveCount: 0,
    };
    if (piece.nodeId) {
      board[piece.nodeId] = piece.id;
    }
  }

  return {
    phase: GAME_PHASES.BATTLE,
    turn: SIDES.PLAYER,
    turnCount: 1,
    difficulty,
    winner: null,
    winReason: null,
    board,
    pieces,
    history: [],
    aiSetupMeta: {
      presetId: aiSetup.presetId,
      horizontalMirror: aiSetup.horizontalMirror ?? false,
    },
  };
}

export function cloneGameState(state) {
  return {
    phase: state.phase,
    turn: state.turn,
    turnCount: state.turnCount,
    difficulty: state.difficulty,
    winner: state.winner,
    winReason: state.winReason,
    board: { ...state.board },
    pieces: Object.fromEntries(
      Object.entries(state.pieces).map(([pieceId, piece]) => [pieceId, { ...piece }]),
    ),
    history: state.history.map((entry) => ({
      ...entry,
      path: [...entry.path],
      battle: entry.battle
        ? {
            ...entry.battle,
            removedIds: [...entry.battle.removedIds],
          }
        : null,
    })),
    aiSetupMeta: { ...(state.aiSetupMeta ?? {}) },
  };
}

export function getPiece(state, pieceId) {
  return state.pieces[pieceId] ?? null;
}

export function getPieceAtNode(state, nodeId) {
  const pieceId = state.board[nodeId];
  return pieceId ? state.pieces[pieceId] : null;
}

export function listPieces(state, side = null) {
  const pieces = Object.values(state.pieces);
  return side ? pieces.filter((piece) => piece.side === side) : pieces;
}

export function countMovablePieces(state, side) {
  return Object.values(state.pieces).filter(
    (piece) => piece.side === side && piece.alive && piece.type !== "flag" && piece.type !== "mine",
  ).length;
}

export function stateToSerializable(state) {
  return {
    phase: state.phase,
    turn: state.turn,
    turnCount: state.turnCount,
    difficulty: state.difficulty,
    winner: state.winner,
    winReason: state.winReason,
    board: { ...state.board },
    pieces: state.pieces,
    history: state.history,
    aiSetupMeta: state.aiSetupMeta,
  };
}

export function stateFromSerializable(value) {
  if (!value || !value.pieces || !value.board) {
    return null;
  }
  return {
    phase: value.phase,
    turn: value.turn,
    turnCount: value.turnCount,
    difficulty: value.difficulty,
    winner: value.winner,
    winReason: value.winReason,
    board: { ...value.board },
    pieces: Object.fromEntries(
      Object.entries(value.pieces).map(([pieceId, piece]) => [pieceId, { ...piece }]),
    ),
    history: Array.isArray(value.history)
      ? value.history.map((entry) => ({
          ...entry,
          path: [...entry.path],
          battle: entry.battle
            ? { ...entry.battle, removedIds: [...entry.battle.removedIds] }
            : null,
        }))
      : [],
    aiSetupMeta: { ...(value.aiSetupMeta ?? {}) },
  };
}
