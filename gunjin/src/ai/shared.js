import { DIFFICULTIES, HQ_VICTORY_ELIGIBLE_TYPES, PIECE_DEFS, PIECE_TYPES, SIDES } from "../engine/constants.js";
import {
  AI_HQ,
  DISTANCE_TO_AI_HQ,
  DISTANCE_TO_PLAYER_HQ,
  NODE_IDS,
  NODE_ID_SET,
  PLAYER_HQ,
  getRearNode,
  isBridgeApproachNode,
} from "../engine/board.js";
import { applyMove, compareTypes, getLegalMoves, getLegalMovesForPiece } from "../engine/rules.js";

export function chooseAiMoveFromView(view, difficultyId = "medium", { debug = false } = {}) {
  const settings = DIFFICULTIES[difficultyId] ?? DIFFICULTIES.medium;
  const deadline = now() + settings.maxMillis;
  const candidateMap = inferEnemyCandidates(view);
  const aggregate = new Map();
  let fallbackMove = null;
  let samples = 0;

  if (debug) {
    logInference(view, candidateMap);
  }

  while (samples < settings.samples && now() < deadline) {
    const state = materializeHypothesis(view, candidateMap);

    if (debug && samples === 0) {
      logHypothesis(view, state, candidateMap);
    }

    const legalMoves = getLegalMoves(state, SIDES.AI);
    if (!legalMoves.length) {
      break;
    }
    if (!fallbackMove) {
      fallbackMove = legalMoves[0];
    }
    const orderedMoves = orderMoves(state, legalMoves, SIDES.AI).slice(0, settings.moveLimit);
    for (const move of orderedMoves) {
      const nextState = applyMove(state, move);
      const isThreat = move.to === PLAYER_HQ || countNodeSteps(move.path) > 1 || Boolean(view.board[move.to]);
      const remainingDepth = Math.max(0, (isThreat ? settings.threatDepth : settings.depth) - 1);
      const score = search(nextState, remainingDepth, SIDES.AI, deadline, settings);
      const key = moveKey(move);
      const existing = aggregate.get(key) ?? { move, score: 0, count: 0 };
      existing.score += score;
      existing.count += 1;
      aggregate.set(key, existing);
      if (now() >= deadline) {
        break;
      }
    }
    samples += 1;
  }

  if (!aggregate.size) {
    if (debug) {
      console.log("[AI] 合法手なし → fallback");
    }
    return fallbackMove;
  }

  let best = null;
  const scored = [];
  for (const item of aggregate.values()) {
    const average = item.score / item.count;
    const noisyScore = average + randomInt(-settings.noise, settings.noise);
    if (debug) {
      scored.push({
        手: `${item.move.pieceId} ${item.move.from}→${item.move.to}`,
        平均スコア: Math.round(average * 10) / 10,
        ノイズ後: Math.round(noisyScore * 10) / 10,
        サンプル数: item.count,
      });
    }
    if (!best || noisyScore > best.score) {
      best = { score: noisyScore, move: item.move };
    }
  }

  if (debug) {
    logDecision(scored, best, samples);
  }

  return best?.move ?? fallbackMove;
}

function search(state, depth, perspective, deadline, settings) {
  if (state.phase === "finished" || depth <= 0 || now() >= deadline) {
    return evaluateState(state, perspective);
  }

  const side = state.turn;
  const legalMoves = getLegalMoves(state, side);
  if (!legalMoves.length) {
    return evaluateState(state, perspective);
  }
  const orderedMoves = orderMoves(state, legalMoves, side).slice(0, settings.moveLimit);

  if (side === perspective) {
    let best = Number.NEGATIVE_INFINITY;
    for (const move of orderedMoves) {
      best = Math.max(best, search(applyMove(state, move), depth - 1, perspective, deadline, settings));
      if (now() >= deadline) {
        break;
      }
    }
    return best;
  }

  let best = Number.POSITIVE_INFINITY;
  for (const move of orderedMoves) {
    best = Math.min(best, search(applyMove(state, move), depth - 1, perspective, deadline, settings));
    if (now() >= deadline) {
      break;
    }
  }
  return best;
}

function evaluateState(state, perspective) {
  if (state.phase === "finished") {
    if (state.winner === perspective) {
      return 50000;
    }
    if (state.winner === "draw") {
      return 0;
    }
    return -50000;
  }

  let score = 0;
  for (const piece of Object.values(state.pieces)) {
    if (!piece.alive || !piece.nodeId) {
      continue;
    }
    const sign = piece.side === perspective ? 1 : -1;
    score += sign * PIECE_DEFS[piece.type].value;

    if (HQ_VICTORY_ELIGIBLE_TYPES.has(piece.type)) {
      const distanceTable = piece.side === SIDES.AI ? DISTANCE_TO_PLAYER_HQ : DISTANCE_TO_AI_HQ;
      const distance = distanceTable[piece.nodeId];
      if (Number.isFinite(distance)) {
        score += sign * Math.max(0, 18 - distance * 2);
      }
    }

    if (isBridgeApproachNode(piece.nodeId)) {
      score += sign * 8;
    }

    if (piece.type === "flag") {
      const supportBonus = hasRearSupport(state, piece) ? 12 : -14;
      score += sign * supportBonus;
    }

    if (piece.type === "mine" && isNearOwnHq(piece.side, piece.nodeId)) {
      score += sign * 6;
    }
  }

  return score;
}

function orderMoves(state, moves, side) {
  return [...moves].sort((left, right) => quickMoveScore(state, right, side) - quickMoveScore(state, left, side));
}

function quickMoveScore(state, move, side) {
  const piece = state.pieces[move.pieceId];
  const targetId = state.board[move.to];
  let score = 0;

  if (
    move.to === (side === SIDES.AI ? PLAYER_HQ : AI_HQ)
    && HQ_VICTORY_ELIGIBLE_TYPES.has(piece.type)
  ) {
    score += 10000;
  }
  if (targetId) {
    const defender = state.pieces[targetId];
    const preview = compareTypes(piece.type, defender.type);
    score += PIECE_DEFS[defender.type].value * (preview.outcome === "attacker" ? 3 : preview.outcome === "mutual" ? 1.4 : -1.8);
  }

  if (HQ_VICTORY_ELIGIBLE_TYPES.has(piece.type)) {
    const distanceTable = side === SIDES.AI ? DISTANCE_TO_PLAYER_HQ : DISTANCE_TO_AI_HQ;
    const before = distanceTable[piece.nodeId];
    const after = distanceTable[move.to];
    if (Number.isFinite(before) && Number.isFinite(after)) {
      score += (before - after) * 4;
    }
  }

  if (isBridgeApproachNode(move.to)) {
    score += 14;
  }
  if (countNodeSteps(move.path) > 1) {
    score += 6;
  }

  return score;
}

function inferEnemyCandidates(view) {
  const candidates = {};
  const enemyPieces = Object.values(view.pieces).filter(
    (piece) => piece.side === SIDES.PLAYER,
  );

  for (const piece of enemyPieces) {
    let options = new Set(PIECE_TYPES);
    if (piece.moveCount > 0) {
      options.delete("flag");
      options.delete("mine");
    }
    for (const entry of view.history) {
      if (entry.pieceId === piece.id) {
        options = intersect(options, inferMoveCandidates(piece.side, entry.from, entry.to, entry.path));
      }
      if (entry.battle) {
        options = applyBattleInference(view, piece, entry, options);
      }
    }
    candidates[piece.id] = options.size ? options : new Set(PIECE_TYPES);
  }

  return candidates;
}

function applyBattleInference(view, enemyPiece, entry, currentSet) {
  const battle = entry.battle;
  if (!battle) {
    return currentSet;
  }

  const enemyIsAttacker = battle.attackerId === enemyPiece.id;
  const enemyIsDefender = battle.defenderId === enemyPiece.id;
  if (!enemyIsAttacker && !enemyIsDefender) {
    return currentSet;
  }

  const ownPieceId = enemyIsAttacker ? battle.defenderId : battle.attackerId;
  const ownType = view.pieces[ownPieceId]?.type;
  if (!ownType) {
    return currentSet;
  }

  if (ownType === "flag" && enemyIsAttacker) {
    return applyFlagBattleInference(currentSet, battle);
  }

  const filtered = new Set();
  for (const candidateType of currentSet) {
    if (candidateType === "flag" && enemyIsDefender) {
      filtered.add(candidateType);
      continue;
    }

    const result = enemyIsAttacker
      ? compareTypes(candidateType, ownType)
      : compareTypes(ownType, candidateType);
    if (result.outcome === battle.outcome) {
      filtered.add(candidateType);
    }
  }

  return filtered.size ? filtered : currentSet;
}

function applyFlagBattleInference(currentSet, battle) {
  if (battle.reason === "flag-unbacked") {
    return currentSet;
  }

  if (battle.reason === "flag-mine") {
    const filtered = new Set();
    for (const candidateType of currentSet) {
      if (battle.outcome === "attacker") {
        if (candidateType === "engineer" || candidateType === "aircraft") {
          filtered.add(candidateType);
        }
      } else {
        if (candidateType !== "engineer" && candidateType !== "aircraft") {
          filtered.add(candidateType);
        }
      }
    }
    return filtered.size ? filtered : currentSet;
  }

  return currentSet;
}

function inferMoveCandidates(side, from, to, path) {
  const candidates = new Set();
  for (const type of PIECE_TYPES) {
    if (type === "flag" || type === "mine") {
      continue;
    }
    if (publicMoveMatchesType(type, side, from, to, path)) {
      candidates.add(type);
    }
  }
  return candidates;
}

function publicMoveMatchesType(type, side, from, to, path) {
  if (from === to) {
    return false;
  }
  if (!NODE_ID_SET.has(from) || !NODE_ID_SET.has(to)) {
    return false;
  }

  const pieceId = `probe_${type}`;
  const board = Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, null]));
  board[from] = pieceId;

  const state = {
    phase: "battle",
    turn: side,
    turnCount: 1,
    difficulty: "medium",
    winner: null,
    winReason: null,
    board,
    pieces: {
      [pieceId]: {
        id: pieceId,
        side,
        type,
        nodeId: from,
        alive: true,
        moveCount: 0,
      },
    },
    history: [],
    aiSetupMeta: {},
  };

  return getLegalMovesForPiece(state, pieceId).some(
    (candidate) => candidate.to === to && samePath(candidate.path, path),
  );
}

function materializeHypothesis(view, candidateMap) {
  const pieces = {};
  const board = {};
  for (const [nodeId, piece] of Object.entries(view.board)) {
    board[nodeId] = piece ? piece.id : null;
  }

  const hiddenEnemyPieces = Object.values(view.pieces).filter(
    (piece) => piece.side === SIDES.PLAYER && piece.alive && piece.nodeId && !piece.known,
  );
  const inventory = buildReducedInventory(view, candidateMap);
  const assignments = assignCandidateTypes(hiddenEnemyPieces, candidateMap, inventory);

  for (const piece of Object.values(view.pieces)) {
    const resolvedType =
      piece.known || piece.side === SIDES.AI ? piece.type : assignments[piece.id] ?? "captain";
    pieces[piece.id] = {
      id: piece.id,
      side: piece.side,
      type: resolvedType,
      nodeId: piece.nodeId,
      alive: piece.alive,
      moveCount: piece.moveCount,
    };
  }

  return {
    phase: view.phase,
    turn: view.turn,
    turnCount: view.turnCount,
    difficulty: view.difficulty,
    winner: view.winner,
    winReason: view.winReason,
    board,
    pieces,
    history: [],
  };
}

function buildReducedInventory(view, candidateMap) {
  const inventory = Object.fromEntries(
    PIECE_TYPES.map((type) => [type, PIECE_DEFS[type].count]),
  );

  const deadEnemyPieces = Object.values(view.pieces).filter(
    (piece) => piece.side === SIDES.PLAYER && !piece.alive,
  );
  const sorted = [...deadEnemyPieces].sort((a, b) => {
    const sizeA = candidateMap[a.id]?.size ?? PIECE_TYPES.length;
    const sizeB = candidateMap[b.id]?.size ?? PIECE_TYPES.length;
    return sizeA - sizeB;
  });

  for (const piece of sorted) {
    const candidates = candidateMap[piece.id];
    if (!candidates) {
      continue;
    }
    const available = [...candidates].filter((type) => inventory[type] > 0);
    if (available.length === 1) {
      inventory[available[0]] -= 1;
    } else if (available.length > 1) {
      const chosen = available[Math.floor(Math.random() * available.length)];
      inventory[chosen] -= 1;
    }
  }

  return inventory;
}

function assignCandidateTypes(hiddenEnemyPieces, candidateMap, inventory = null) {
  if (!inventory) {
    inventory = Object.fromEntries(
      PIECE_TYPES.map((type) => [type, PIECE_DEFS[type].count]),
    );
  }
  const pieces = [...hiddenEnemyPieces].sort(
    (left, right) => candidateMap[left.id].size - candidateMap[right.id].size,
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const assigned = tryGreedyAssignment(pieces, candidateMap, inventory);
    if (assigned) {
      return assigned;
    }
  }

  const exactAssignment = findExactAssignment(pieces, candidateMap, inventory);
  if (exactAssignment) {
    return exactAssignment;
  }

  return buildFallbackAssignment(pieces, candidateMap, inventory);
}

function hasRearSupport(state, piece) {
  const rearNode = piece.nodeId ? getRearNode(piece.nodeId, piece.side) : null;
  if (!rearNode) {
    return false;
  }
  const occupantId = state.board[rearNode];
  if (!occupantId) {
    return false;
  }
  const support = state.pieces[occupantId];
  return support && support.side === piece.side && support.alive;
}

function isNearOwnHq(side, nodeId) {
  const ownHq = side === SIDES.AI ? AI_HQ : PLAYER_HQ;
  const distanceTable = side === SIDES.AI ? DISTANCE_TO_AI_HQ : DISTANCE_TO_PLAYER_HQ;
  return distanceTable[nodeId] <= 2 || nodeId === ownHq;
}

function moveKey(move) {
  return `${move.pieceId}:${move.to}:${move.path.join(">")}`;
}

function countNodeSteps(path) {
  let steps = 0;
  for (const segment of path.slice(1)) {
    if (NODE_ID_SET.has(segment)) {
      steps += 1;
    }
  }
  return steps;
}

function samePath(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((segment, index) => segment === right[index]);
}

function intersect(source, other) {
  const result = new Set();
  for (const value of source) {
    if (other.has(value)) {
      result.add(value);
    }
  }
  return result;
}

function tryGreedyAssignment(pieces, candidateMap, inventory) {
  const remaining = { ...inventory };
  const assigned = {};

  for (const piece of pieces) {
    const options = shuffle([...candidateMap[piece.id]]).filter((type) => remaining[type] > 0);
    if (!options.length) {
      return null;
    }
    const selectedType = options[0];
    assigned[piece.id] = selectedType;
    remaining[selectedType] -= 1;
  }

  return assigned;
}

function findExactAssignment(pieces, candidateMap, inventory) {
  const remaining = { ...inventory };
  const orderedPieces = [...pieces];
  const assigned = {};

  function search(index) {
    if (index >= orderedPieces.length) {
      return true;
    }

    const next = pickMostConstrainedPiece(orderedPieces, index, candidateMap, remaining);
    if (!next) {
      return false;
    }
    swap(orderedPieces, index, next.index);

    const piece = orderedPieces[index];
    for (const type of next.options) {
      assigned[piece.id] = type;
      remaining[type] -= 1;
      if (search(index + 1)) {
        return true;
      }
      remaining[type] += 1;
      delete assigned[piece.id];
    }

    swap(orderedPieces, index, next.index);
    return false;
  }

  return search(0) ? assigned : null;
}

function pickMostConstrainedPiece(pieces, startIndex, candidateMap, remaining) {
  let bestIndex = -1;
  let bestOptions = null;

  for (let index = startIndex; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const options = [...candidateMap[piece.id]].filter((type) => remaining[type] > 0);
    if (!options.length) {
      return null;
    }
    if (!bestOptions || options.length < bestOptions.length) {
      bestIndex = index;
      bestOptions = shuffle(options);
      if (bestOptions.length === 1) {
        break;
      }
    }
  }

  return bestIndex === -1 ? null : { index: bestIndex, options: bestOptions };
}

function buildFallbackAssignment(pieces, candidateMap, inventory) {
  const remaining = { ...inventory };
  const result = {};

  for (const piece of pieces) {
    const available = [...candidateMap[piece.id]].filter((type) => remaining[type] > 0);
    const selectedType = available[0] ?? [...candidateMap[piece.id]][0] ?? "captain";
    result[piece.id] = selectedType;
    if (remaining[selectedType] > 0) {
      remaining[selectedType] -= 1;
    }
  }

  return result;
}

function swap(values, leftIndex, rightIndex) {
  if (leftIndex === rightIndex) {
    return;
  }
  [values[leftIndex], values[rightIndex]] = [values[rightIndex], values[leftIndex]];
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function logInference(view, candidateMap) {
  const enemyPieces = Object.values(view.pieces).filter(
    (piece) => piece.side === SIDES.PLAYER,
  );

  const inferenceRows = enemyPieces.map((piece) => {
    const candidates = candidateMap[piece.id];
    const types = candidates ? [...candidates] : [];
    return {
      id: piece.id,
      位置: piece.nodeId ?? "撃破",
      状態: piece.alive ? "生存" : "死亡",
      移動回数: piece.moveCount,
      候補数: types.length,
      候補: types.map((t) => PIECE_DEFS[t].label).join(", "),
    };
  });

  console.groupCollapsed(`[AI 推論] ${view.turnCount} 手目 / 敵駒候補`);
  console.table(inferenceRows);
  console.groupEnd();
}

function logHypothesis(view, state, candidateMap) {
  const hiddenPieces = Object.values(view.pieces).filter(
    (piece) => piece.side === SIDES.PLAYER && piece.alive && piece.nodeId && !piece.known,
  );

  const hypothesisRows = hiddenPieces.map((piece) => {
    const candidates = candidateMap[piece.id];
    const assigned = state.pieces[piece.id];
    return {
      id: piece.id,
      位置: piece.nodeId,
      候補: candidates ? [...candidates].map((t) => PIECE_DEFS[t].label).join(", ") : "?",
      仮説: assigned ? PIECE_DEFS[assigned.type].label : "?",
    };
  });

  const inventory = buildReducedInventory(view, candidateMap);
  const inventoryRows = PIECE_TYPES
    .filter((type) => inventory[type] < PIECE_DEFS[type].count)
    .map((type) => ({
      駒種: PIECE_DEFS[type].label,
      全数: PIECE_DEFS[type].count,
      残り: inventory[type],
    }));

  console.groupCollapsed(`[AI 推論] 仮説 (サンプル#0) / インベントリ消費`);
  console.table(hypothesisRows);
  if (inventoryRows.length) {
    console.log("死亡駒による在庫消費:");
    console.table(inventoryRows);
  }
  console.groupEnd();
}

function logDecision(scored, best, samples) {
  scored.sort((a, b) => b.ノイズ後 - a.ノイズ後);

  console.groupCollapsed(
    `[AI 決定] ${best.move.pieceId} ${best.move.from}→${best.move.to} (スコア: ${Math.round(best.score * 10) / 10}, ${samples}サンプル)`,
  );
  console.table(scored);
  console.groupEnd();
}
