import { APP_SCHEMA_VERSION, PIECE_DEFS } from "./constants.js";
import { NODE_IDS } from "./board.js";

export function deriveViewerState(state, viewerSide, { revealAll = false } = {}) {
  const pieces = {};
  for (const [pieceId, piece] of Object.entries(state.pieces)) {
    const visible = revealAll || piece.side === viewerSide;
    pieces[pieceId] = {
      id: piece.id,
      side: piece.side,
      type: visible ? piece.type : null,
      label: visible ? PIECE_DEFS[piece.type].label : "未公開",
      short: visible ? PIECE_DEFS[piece.type].short : "？",
      nodeId: piece.nodeId,
      alive: piece.alive,
      moveCount: piece.moveCount,
      known: visible,
    };
  }

  const board = {};
  for (const nodeId of NODE_IDS) {
    const pieceId = state.board[nodeId];
    board[nodeId] = pieceId ? pieces[pieceId] : null;
  }

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    viewerSide,
    phase: state.phase,
    turn: state.turn,
    turnCount: state.turnCount,
    difficulty: state.difficulty,
    winner: state.winner,
    winReason: state.winReason,
    revealAll,
    board,
    pieces,
    history: state.history.map((entry) => ({
      turnNumber: entry.turnNumber,
      side: entry.side,
      pieceId: entry.pieceId,
      from: entry.from,
      to: entry.to,
      path: [...entry.path],
      battle: entry.battle
        ? {
            attackerId: entry.battle.attackerId,
            defenderId: entry.battle.defenderId,
            outcome: entry.battle.outcome,
            reason: entry.battle.reason,
            attackerRemoved: entry.battle.attackerRemoved,
            defenderRemoved: entry.battle.defenderRemoved,
            removedIds: [...entry.battle.removedIds],
            attackerLabel: state.pieces[entry.battle.attackerId]?.side === viewerSide
              ? PIECE_DEFS[state.pieces[entry.battle.attackerId].type].label
              : null,
            defenderLabel: state.pieces[entry.battle.defenderId]?.side === viewerSide
              ? PIECE_DEFS[state.pieces[entry.battle.defenderId].type].label
              : null,
          }
        : null,
    })),
  };
}
