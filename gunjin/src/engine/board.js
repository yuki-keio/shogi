import { SIDES } from "./constants.js";

export const PLAYER_HQ = "HQ_P";
export const AI_HQ = "HQ_E";
export const HQ_NODES = new Set([PLAYER_HQ, AI_HQ]);
export const BRIDGE_CELLS = new Set(["B5", "E5"]);
export const BRIDGE_APPROACH_NODES = new Set(["B4", "B6", "E4", "E6"]);
export const BLOCKED_CELLS = new Set(["A5", "C5", "D5", "F5"]);
export const FILES = ["A", "B", "C", "D", "E", "F"];
export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const CARDINAL_DIRECTIONS = Object.freeze(["north", "south", "west", "east"]);

const OPPOSITE_DIRECTIONS = Object.freeze({
  north: "south",
  south: "north",
  west: "east",
  east: "west",
});

export const DISPLAY_SLOTS = [
  createPlayableSlot("A1", 1, 1),
  createPlayableSlot("B1", 1, 2),
  createHqSlot(AI_HQ, 1, 3, SIDES.AI),
  createPlayableSlot("E1", 1, 5),
  createPlayableSlot("F1", 1, 6),
  ...buildRankRows(2, 4),
  createDisplayOnlySlot("A5", 5, 1, "blocked"),
  createDisplayOnlySlot("B5", 5, 2, "bridge"),
  createDisplayOnlySlot("C5", 5, 3, "blocked"),
  createDisplayOnlySlot("D5", 5, 4, "blocked"),
  createDisplayOnlySlot("E5", 5, 5, "bridge"),
  createDisplayOnlySlot("F5", 5, 6, "blocked"),
  ...buildRankRows(6, 8),
  createPlayableSlot("A9", 9, 1),
  createPlayableSlot("B9", 9, 2),
  createHqSlot(PLAYER_HQ, 9, 3, SIDES.PLAYER),
  createPlayableSlot("E9", 9, 5),
  createPlayableSlot("F9", 9, 6),
];

function createPlayableSlot(nodeId, row, col, cellType = "plain", extra = {}) {
  return {
    displayId: nodeId,
    nodeId,
    row,
    col,
    span: 1,
    cellType,
    side: null,
    ...extra,
  };
}

function createHqSlot(nodeId, row, col, side) {
  return {
    displayId: nodeId,
    nodeId,
    row,
    col,
    span: 2,
    cellType: "hq",
    side,
  };
}

function createDisplayOnlySlot(displayId, row, col, cellType) {
  return {
    displayId,
    nodeId: null,
    row,
    col,
    span: 1,
    cellType,
    side: null,
  };
}

function buildRankRows(start, end) {
  const rows = [];
  for (let rank = start; rank <= end; rank += 1) {
    for (let index = 0; index < FILES.length; index += 1) {
      rows.push(createPlayableSlot(`${FILES[index]}${rank}`, rank, index + 1));
    }
  }
  return rows;
}

export const DISPLAY_CELL_TO_NODE = buildDisplayCellMap();
export const NODE_META = buildNodeMeta();
export const NODE_IDS = Object.freeze(
  [...new Set(DISPLAY_SLOTS.flatMap((slot) => (slot.nodeId ? [slot.nodeId] : [])))],
);
export const NODE_ID_SET = new Set(NODE_IDS);
export const HOME_NODES = {
  [SIDES.PLAYER]: Object.freeze([
    "A9",
    "B9",
    PLAYER_HQ,
    "E9",
    "F9",
    "A8",
    "B8",
    "C8",
    "D8",
    "E8",
    "F8",
    "A7",
    "B7",
    "C7",
    "D7",
    "E7",
    "F7",
    "A6",
    "B6",
    "C6",
    "D6",
    "E6",
    "F6",
  ]),
  [SIDES.AI]: Object.freeze([
    "A1",
    "B1",
    AI_HQ,
    "E1",
    "F1",
    "A2",
    "B2",
    "C2",
    "D2",
    "E2",
    "F2",
    "A3",
    "B3",
    "C3",
    "D3",
    "E3",
    "F3",
    "A4",
    "B4",
    "C4",
    "D4",
    "E4",
    "F4",
  ]),
};

export const ADJACENCY = buildAdjacency();
export const DISTANCE_TO_PLAYER_HQ = buildDistances(PLAYER_HQ);
export const DISTANCE_TO_AI_HQ = buildDistances(AI_HQ);

export function getNodeMeta(nodeId) {
  return NODE_META[nodeId] ?? null;
}

export function getEnemySide(side) {
  return side === SIDES.PLAYER ? SIDES.AI : SIDES.PLAYER;
}

export function isNodePlayable(nodeId) {
  return NODE_ID_SET.has(nodeId);
}

export function isBridgeCell(cellId) {
  return BRIDGE_CELLS.has(cellId);
}

export function isBridgeApproachNode(nodeId) {
  return BRIDGE_APPROACH_NODES.has(nodeId);
}

export function isHqNode(nodeId) {
  return HQ_NODES.has(nodeId);
}

export function toCoord(nodeId) {
  if (nodeId === PLAYER_HQ) {
    return { hq: true, row: 9, col: 3.5, cells: ["C9", "D9"] };
  }
  if (nodeId === AI_HQ) {
    return { hq: true, row: 1, col: 3.5, cells: ["C1", "D1"] };
  }
  const file = nodeId[0];
  const row = Number.parseInt(nodeId.slice(1), 10);
  return { hq: false, file, row, col: FILES.indexOf(file) + 1 };
}

export function fromFileRank(file, rank) {
  const id = `${file}${rank}`;
  return NODE_META[id] ? id : null;
}

export function mirrorNodeForAi(nodeId, horizontalMirror = false) {
  if (nodeId === PLAYER_HQ) {
    return AI_HQ;
  }
  if (nodeId === AI_HQ) {
    return PLAYER_HQ;
  }
  const { file, row } = toCoord(nodeId);
  const mappedRow = 10 - row;
  const fileIndex = FILES.indexOf(file);
  const mappedFile = horizontalMirror ? FILES[FILES.length - 1 - fileIndex] : file;
  return `${mappedFile}${mappedRow}`;
}

export function getRearNode(nodeId, side) {
  if (HQ_NODES.has(nodeId)) {
    return null;
  }
  const direction = side === SIDES.PLAYER ? "south" : "north";
  return getStepTransition(nodeId, direction)?.targetNode ?? null;
}

export function getNeighbors(nodeId) {
  return ADJACENCY[nodeId] ?? [];
}

export function getOppositeDirection(direction) {
  return OPPOSITE_DIRECTIONS[direction] ?? null;
}

export function getStepTransition(nodeId, direction) {
  if (HQ_NODES.has(nodeId)) {
    return null;
  }

  switch (direction) {
    case "north":
      return getVerticalStep(nodeId, -1);
    case "south":
      return getVerticalStep(nodeId, 1);
    case "west":
      return getHorizontalStep(nodeId, -1);
    case "east":
      return getHorizontalStep(nodeId, 1);
    default:
      return null;
  }
}

function buildDisplayCellMap() {
  const result = {};
  for (const slot of DISPLAY_SLOTS) {
    if (!slot.nodeId) {
      result[slot.displayId] = null;
      continue;
    }
    if (slot.nodeId === PLAYER_HQ) {
      result.C9 = PLAYER_HQ;
      result.D9 = PLAYER_HQ;
      continue;
    }
    if (slot.nodeId === AI_HQ) {
      result.C1 = AI_HQ;
      result.D1 = AI_HQ;
      continue;
    }
    result[slot.displayId] = slot.nodeId;
  }
  return result;
}

function buildNodeMeta() {
  const meta = {};
  for (const slot of DISPLAY_SLOTS) {
    if (!slot.nodeId) {
      continue;
    }
    meta[slot.nodeId] = {
      row: slot.row,
      col: slot.col,
      span: slot.span,
      cellType: slot.cellType,
      side: slot.side ?? null,
    };
  }
  return meta;
}

function buildAdjacency() {
  const adjacency = {};
  for (const nodeId of NODE_IDS) {
    adjacency[nodeId] = [];
  }

  adjacency[PLAYER_HQ].push("B9", "C8", "D8", "E9");
  adjacency[AI_HQ].push("B1", "C2", "D2", "E1");

  for (const nodeId of NODE_IDS) {
    if (HQ_NODES.has(nodeId)) {
      continue;
    }
    for (const direction of CARDINAL_DIRECTIONS) {
      const transition = getStepTransition(nodeId, direction);
      if (transition) {
        adjacency[nodeId].push(transition.targetNode);
      }
    }
  }

  return adjacency;
}

function getHorizontalStep(nodeId, fileDelta) {
  const { file, row, col } = toCoord(nodeId);
  const targetFile = FILES[col - 1 + fileDelta];
  if (!targetFile) {
    return null;
  }
  if ((row === 1 || row === 9) && (targetFile === "C" || targetFile === "D")) {
    if (row === 1 && ((file === "B" && fileDelta === 1) || (file === "E" && fileDelta === -1))) {
      return {
        targetNode: AI_HQ,
        path: [AI_HQ],
      };
    }
    if (row === 9 && ((file === "B" && fileDelta === 1) || (file === "E" && fileDelta === -1))) {
      return {
        targetNode: PLAYER_HQ,
        path: [PLAYER_HQ],
      };
    }
    return null;
  }
  const targetNode = `${targetFile}${row}`;
  if (!NODE_META[targetNode]) {
    return null;
  }
  return {
    targetNode,
    path: [targetNode],
  };
}

function getVerticalStep(nodeId, rowDelta) {
  const { file, row } = toCoord(nodeId);
  const intermediateRow = row + rowDelta;
  if (intermediateRow < 1 || intermediateRow > 9) {
    return null;
  }

  if (intermediateRow === 1 && (file === "C" || file === "D")) {
    return row === 2
      ? {
          targetNode: AI_HQ,
          path: [AI_HQ],
        }
      : null;
  }

  if (intermediateRow === 9 && (file === "C" || file === "D")) {
    return row === 8
      ? {
          targetNode: PLAYER_HQ,
          path: [PLAYER_HQ],
        }
      : null;
  }

  const intermediateCell = `${file}${intermediateRow}`;
  if (BLOCKED_CELLS.has(intermediateCell)) {
    return null;
  }

  if (BRIDGE_CELLS.has(intermediateCell)) {
    const landingRow = intermediateRow + rowDelta;
    if (landingRow < 1 || landingRow > 9) {
      return null;
    }
    const landingNode = `${file}${landingRow}`;
    if (!NODE_META[landingNode]) {
      return null;
    }
    return {
      targetNode: landingNode,
      path: [intermediateCell, landingNode],
    };
  }

  if (!NODE_META[intermediateCell]) {
    return null;
  }

  return {
    targetNode: intermediateCell,
    path: [intermediateCell],
  };
}

function buildDistances(targetNode) {
  const distances = {};
  for (const nodeId of NODE_IDS) {
    distances[nodeId] = Number.POSITIVE_INFINITY;
  }
  distances[targetNode] = 0;
  const queue = [targetNode];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of ADJACENCY[current]) {
      if (distances[neighbor] > distances[current] + 1) {
        distances[neighbor] = distances[current] + 1;
        queue.push(neighbor);
      }
    }
  }

  return distances;
}
