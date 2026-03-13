import { PIECE_DEFS, PIECE_TYPES, PRESET_LAYOUTS, SIDES } from "./constants.js";
import {
  HOME_NODES,
  getNodeMeta,
  isBridgeApproachNode,
  mirrorNodeForAi,
} from "./board.js";

const ENTRANCE_BLOCKED_TYPES = new Set(["flag", "mine"]);

export function createSetupPieces(side) {
  const pieces = [];
  for (const type of PIECE_TYPES) {
    for (let index = 1; index <= PIECE_DEFS[type].count; index += 1) {
      pieces.push({
        id: `${side}_${type}_${index}`,
        side,
        type,
        nodeId: null,
        alive: true,
        moveCount: 0,
      });
    }
  }
  return pieces;
}

export function createEmptySetupState() {
  const pieces = createSetupPieces(SIDES.PLAYER);
  return {
    pieces,
    placements: {},
    presetId: null,
  };
}

export function cloneSetupState(setupState) {
  return {
    pieces: setupState.pieces.map((piece) => ({ ...piece })),
    placements: { ...setupState.placements },
    presetId: setupState.presetId,
  };
}

export function applyPresetToSetup(setupState, presetId) {
  const preset = PRESET_LAYOUTS[presetId];
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }
  const next = createEmptySetupState();
  const availableByType = groupPiecesByType(next.pieces);
  for (const [nodeId, type] of Object.entries(preset.placements)) {
    const piece = availableByType[type].shift();
    piece.nodeId = nodeId;
    next.placements[nodeId] = piece.id;
  }
  next.presetId = presetId;
  return next;
}

export function validateSetup(setupState) {
  const homeNodes = new Set(HOME_NODES[SIDES.PLAYER]);
  if (Object.keys(setupState.placements).length !== HOME_NODES[SIDES.PLAYER].length) {
    return {
      valid: false,
      reason: "23 マスすべてに駒を配置してください。",
    };
  }
  for (const piece of setupState.pieces) {
    if (!piece.nodeId) {
      return {
        valid: false,
        reason: "未配置の駒があります。",
      };
    }
    if (!homeNodes.has(piece.nodeId)) {
      return {
        valid: false,
        reason: "自陣の配置可能マスに置いてください。",
      };
    }
    const violation = getSetupPlacementViolation(piece.type, piece.nodeId, piece.side);
    if (violation) {
      return {
        valid: false,
        reason: violation,
      };
    }
  }
  return { valid: true, reason: "" };
}

export function setPiecePlacement(setupState, pieceId, targetNodeId) {
  const next = cloneSetupState(setupState);
  const piece = next.pieces.find((item) => item.id === pieceId);
  if (!piece) {
    return next;
  }
  if (getSetupMoveViolation(next, pieceId, targetNodeId)) {
    return next;
  }
  const previousNode = piece.nodeId;
  const occupyingPieceId = next.placements[targetNodeId] ?? null;
  if (previousNode) {
    delete next.placements[previousNode];
  }
  if (occupyingPieceId && occupyingPieceId !== piece.id) {
    const otherPiece = next.pieces.find((item) => item.id === occupyingPieceId);
    if (otherPiece) {
      otherPiece.nodeId = previousNode ?? null;
      if (previousNode) {
        next.placements[previousNode] = otherPiece.id;
      } else {
        delete next.placements[targetNodeId];
      }
    }
  }
  piece.nodeId = targetNodeId;
  next.placements[targetNodeId] = piece.id;
  next.presetId = null;
  return next;
}

export function removePieceFromSetup(setupState, pieceId) {
  const next = cloneSetupState(setupState);
  const piece = next.pieces.find((item) => item.id === pieceId);
  if (!piece || !piece.nodeId) {
    return next;
  }
  delete next.placements[piece.nodeId];
  piece.nodeId = null;
  next.presetId = null;
  return next;
}

export function isSetupPlacementAllowed(type, targetNodeId, side = SIDES.PLAYER) {
  return !getSetupPlacementViolation(type, targetNodeId, side);
}

export function isSetupMoveAllowed(setupState, pieceId, targetNodeId) {
  return !getSetupMoveViolation(setupState, pieceId, targetNodeId);
}

export function getSetupMoveViolation(setupState, pieceId, targetNodeId) {
  const piece = setupState.pieces.find((item) => item.id === pieceId);
  if (!piece) {
    return "対象の駒が見つかりません。";
  }

  const ownViolation = getSetupPlacementViolation(piece.type, targetNodeId, piece.side);
  if (ownViolation) {
    return ownViolation;
  }

  const previousNode = piece.nodeId;
  if (!previousNode || previousNode === targetNodeId) {
    return "";
  }

  const occupyingPieceId = setupState.placements[targetNodeId] ?? null;
  if (!occupyingPieceId || occupyingPieceId === piece.id) {
    return "";
  }

  const otherPiece = setupState.pieces.find((item) => item.id === occupyingPieceId);
  if (!otherPiece) {
    return "";
  }

  return getSetupPlacementViolation(otherPiece.type, previousNode, otherPiece.side);
}

export function getSetupPlacementViolation(type, targetNodeId, side = SIDES.PLAYER) {
  if (!HOME_NODES[side]?.includes(targetNodeId)) {
    return "自陣の配置可能マスに置いてください。";
  }

  if (ENTRANCE_BLOCKED_TYPES.has(type) && isBridgeApproachNode(targetNodeId)) {
    return "突入口には地雷・軍旗を置けません。";
  }

  const nodeMeta = getNodeMeta(targetNodeId);
  const backRank = side === SIDES.PLAYER ? 9 : 1;
  if (type === "flag" && nodeMeta?.row === backRank) {
    return "軍旗は自陣最後尾列に置けません。";
  }

  return "";
}

export function buildAiLayout(random = Math.random) {
  const presetIds = Object.keys(PRESET_LAYOUTS);
  const presetId = presetIds[Math.floor(random() * presetIds.length)];
  const horizontalMirror = random() > 0.5;
  const preset = PRESET_LAYOUTS[presetId];
  const pieces = createSetupPieces(SIDES.AI);
  const availableByType = groupPiecesByType(pieces);
  const placements = {};

  for (const [nodeId, type] of Object.entries(preset.placements)) {
    const mappedNode = mirrorNodeForAi(nodeId, horizontalMirror);
    const piece = availableByType[type].shift();
    piece.nodeId = mappedNode;
    placements[mappedNode] = piece.id;
  }

  return {
    pieces,
    placements,
    presetId,
    horizontalMirror,
  };
}

export function setupStateToSerializable(setupState) {
  return {
    pieces: setupState.pieces.map((piece) => ({
      id: piece.id,
      side: piece.side,
      type: piece.type,
      nodeId: piece.nodeId,
      alive: piece.alive,
      moveCount: piece.moveCount,
    })),
    placements: { ...setupState.placements },
    presetId: setupState.presetId,
  };
}

export function setupStateFromSerializable(value) {
  if (!value || !Array.isArray(value.pieces)) {
    return createEmptySetupState();
  }
  return {
    pieces: value.pieces.map((piece) => ({ ...piece })),
    placements: { ...(value.placements ?? {}) },
    presetId: value.presetId ?? null,
  };
}

function groupPiecesByType(pieces) {
  const map = {};
  for (const type of PIECE_TYPES) {
    map[type] = [];
  }
  for (const piece of pieces) {
    map[piece.type].push(piece);
  }
  return map;
}
