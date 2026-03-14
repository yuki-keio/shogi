import {
  GAME_PHASES,
  GENERAL_TYPES,
  HQ_VICTORY_ELIGIBLE_TYPES,
  IMMOBILE_TYPES,
  PIECE_DEFS,
  SIDES,
} from "./constants.js";
import {
  AI_HQ,
  CARDINAL_DIRECTIONS,
  PLAYER_HQ,
  fromFileRank,
  getEnemySide,
  getNeighbors,
  getOppositeDirection,
  getRearNode,
  getStepTransition,
  isBridgeCell,
  isHqNode,
  toCoord,
} from "./board.js";
import {
  cloneGameState,
  countMovablePieces,
  getPiece,
  getPieceAtNode,
  listPieces,
} from "./state.js";

export function getLegalMoves(state, side = state.turn) {
  const moves = [];
  for (const piece of listPieces(state, side)) {
    if (!piece.alive || piece.side !== side) {
      continue;
    }
    moves.push(...getLegalMovesForPiece(state, piece.id));
  }
  return moves;
}

export function getLegalMovesForPiece(state, pieceId) {
  const piece = getPiece(state, pieceId);
  if (!piece || !piece.alive || piece.side !== state.turn) {
    return [];
  }
  if (IMMOBILE_TYPES.has(piece.type)) {
    return [];
  }

  switch (piece.type) {
    case "tank":
    case "cavalry":
      return getTankLikeMoves(state, piece);
    case "engineer":
      return getEngineerMoves(state, piece);
    case "aircraft":
      return getAircraftMoves(state, piece);
    default:
      return getAdjacentMoves(state, piece);
  }
}

export function isMoveLegal(state, move) {
  return getLegalMovesForPiece(state, move.pieceId).some(
    (candidate) => candidate.to === move.to && candidate.path.join("->") === move.path.join("->"),
  );
}

export function applyMove(state, move) {
  if (!isMoveLegal(state, move)) {
    throw new Error("Illegal move");
  }

  const next = cloneGameState(state);
  const attacker = next.pieces[move.pieceId];
  const targetPieceId = next.board[move.to];
  const event = {
    turnNumber: next.turnCount,
    side: attacker.side,
    pieceId: attacker.id,
    from: move.from,
    to: move.to,
    path: [...move.path],
    battle: null,
  };

  next.board[attacker.nodeId] = null;
  attacker.nodeId = move.to;
  attacker.moveCount += 1;

  if (!targetPieceId) {
    next.board[move.to] = attacker.id;
    finalizeAfterMove(next, attacker, event);
    return next;
  }

  const defender = next.pieces[targetPieceId];
  const battle = resolveBattle(next, attacker, defender);
  event.battle = {
    attackerId: attacker.id,
    defenderId: defender.id,
    ...battle.public,
  };

  if (battle.attackerSurvives) {
    next.board[move.to] = attacker.id;
  } else {
    next.board[move.to] = battle.defenderSurvives ? defender.id : null;
    attacker.alive = false;
    attacker.nodeId = null;
  }

  if (!battle.defenderSurvives) {
    defender.alive = false;
    defender.nodeId = null;
  }

  if (battle.attackerSurvives) {
    attacker.nodeId = move.to;
  }
  if (battle.defenderSurvives) {
    defender.nodeId = move.to;
  }

  finalizeAfterMove(next, battle.attackerSurvives ? attacker : defender, event, battle);
  return next;
}

export function resolveBattle(state, attacker, defender) {
  if (defender.type === "flag") {
    return resolveFlagDefense(state, attacker, defender);
  }

  const base = compareTypes(attacker.type, defender.type);
  return toBattleResult(base, attacker, defender);
}

export function compareTypes(attackerType, defenderType) {
  if (attackerType === defenderType) {
    return { outcome: "mutual", reason: "same" };
  }

  if (defenderType === "mine") {
    if (attackerType === "engineer" || attackerType === "aircraft") {
      return { outcome: "attacker", reason: "mine-broken" };
    }
    return { outcome: "mutual", reason: "mine-blast" };
  }

  if (attackerType === "spy" && defenderType === "marshal") {
    return { outcome: "attacker", reason: "spy" };
  }
  if (defenderType === "spy" && attackerType === "marshal") {
    return { outcome: "defender", reason: "spy" };
  }

  if (attackerType === "aircraft") {
    return GENERAL_TYPES.has(defenderType)
      ? { outcome: "defender", reason: "aircraft" }
      : { outcome: "attacker", reason: "aircraft" };
  }
  if (defenderType === "aircraft") {
    return GENERAL_TYPES.has(attackerType)
      ? { outcome: "attacker", reason: "aircraft" }
      : { outcome: "defender", reason: "aircraft" };
  }

  if (attackerType === "tank") {
    return GENERAL_TYPES.has(defenderType)
      ? { outcome: "defender", reason: "tank" }
      : { outcome: "attacker", reason: "tank" };
  }
  if (defenderType === "tank") {
    return GENERAL_TYPES.has(attackerType)
      ? { outcome: "attacker", reason: "tank" }
      : { outcome: "defender", reason: "tank" };
  }

  if (attackerType === "cavalry") {
    if (defenderType === "engineer" || defenderType === "spy") {
      return { outcome: "attacker", reason: "cavalry" };
    }
    return { outcome: "defender", reason: "cavalry" };
  }
  if (defenderType === "cavalry") {
    if (attackerType === "engineer" || attackerType === "spy") {
      return { outcome: "defender", reason: "cavalry" };
    }
    return { outcome: "attacker", reason: "cavalry" };
  }

  if (attackerType === "engineer") {
    if (defenderType === "spy") {
      return { outcome: "attacker", reason: "engineer" };
    }
    return { outcome: "defender", reason: "engineer" };
  }
  if (defenderType === "engineer") {
    if (attackerType === "spy") {
      return { outcome: "defender", reason: "engineer" };
    }
    return { outcome: "attacker", reason: "engineer" };
  }

  if (attackerType === "spy") {
    return { outcome: "defender", reason: "spy" };
  }
  if (defenderType === "spy") {
    return { outcome: "attacker", reason: "spy" };
  }

  const attackerRank = PIECE_DEFS[attackerType].strength ?? 0;
  const defenderRank = PIECE_DEFS[defenderType].strength ?? 0;
  if (attackerRank > defenderRank) {
    return { outcome: "attacker", reason: "rank" };
  }
  if (attackerRank < defenderRank) {
    return { outcome: "defender", reason: "rank" };
  }
  return { outcome: "mutual", reason: "same" };
}

export function compareTypesFromPerspective(subjectType, opponentType) {
  const result =
    subjectType === "mine"
      ? compareTypes(opponentType, subjectType)
      : compareTypes(subjectType, opponentType);

  if (result.outcome === "mutual") {
    return { outcome: "mutual", reason: result.reason };
  }

  if (subjectType === "mine") {
    return {
      outcome: result.outcome === "defender" ? "subject" : "opponent",
      reason: result.reason,
    };
  }

  return {
    outcome: result.outcome === "attacker" ? "subject" : "opponent",
    reason: result.reason,
  };
}

export function canTypeWinByOccupyingEnemyHq(type) {
  return HQ_VICTORY_ELIGIBLE_TYPES.has(type);
}

function resolveFlagDefense(state, attacker, defender) {
  const supportNode = getRearNode(defender.nodeId, defender.side);
  const supportPiece = supportNode ? getPieceAtNode(state, supportNode) : null;

  if (!supportPiece || !supportPiece.alive || supportPiece.side !== defender.side) {
    return {
      attackerSurvives: true,
      defenderSurvives: false,
      public: {
        outcome: "attacker",
        reason: "flag-unbacked",
        attackerRemoved: false,
        defenderRemoved: true,
        removedIds: [defender.id],
      },
    };
  }

  if (supportPiece.type === "mine") {
    const attackerSurvives = attacker.type === "engineer" || attacker.type === "aircraft";
    return {
      attackerSurvives,
      defenderSurvives: false,
      public: {
        outcome: attackerSurvives ? "attacker" : "mutual",
        reason: "flag-mine",
        attackerRemoved: !attackerSurvives,
        defenderRemoved: true,
        removedIds: attackerSurvives ? [defender.id] : [attacker.id, defender.id],
      },
    };
  }

  const base = compareTypes(attacker.type, supportPiece.type);
  const result = toBattleResult(base, attacker, defender);
  result.public.reason = "flag-borrow";
  return result;
}

function toBattleResult(base, attacker, defender) {
  if (base.outcome === "attacker") {
    return {
      attackerSurvives: true,
      defenderSurvives: false,
      public: {
        outcome: "attacker",
        reason: base.reason,
        attackerRemoved: false,
        defenderRemoved: true,
        removedIds: [defender.id],
      },
    };
  }
  if (base.outcome === "defender") {
    return {
      attackerSurvives: false,
      defenderSurvives: true,
      public: {
        outcome: "defender",
        reason: base.reason,
        attackerRemoved: true,
        defenderRemoved: false,
        removedIds: [attacker.id],
      },
    };
  }
  return {
    attackerSurvives: false,
    defenderSurvives: false,
    public: {
      outcome: "mutual",
      reason: base.reason,
      attackerRemoved: true,
      defenderRemoved: true,
      removedIds: [attacker.id, defender.id],
    },
  };
}

function finalizeAfterMove(state, pieceOnTarget, event, battle = null) {
  const moverSide = event.side;
  const enemySide = getEnemySide(moverSide);
  const enemyHq = moverSide === SIDES.PLAYER ? AI_HQ : PLAYER_HQ;

  if (
    pieceOnTarget &&
    pieceOnTarget.id === event.pieceId &&
    pieceOnTarget.nodeId === enemyHq &&
    canTypeWinByOccupyingEnemyHq(pieceOnTarget.type)
  ) {
    state.phase = GAME_PHASES.FINISHED;
    state.winner = moverSide;
    state.winReason = "hq";
  }

  const moverMovable = countMovablePieces(state, moverSide);
  const enemyMovable = countMovablePieces(state, enemySide);

  if (!state.winner) {
    if (moverMovable === 0 && enemyMovable === 0) {
      state.phase = GAME_PHASES.FINISHED;
      state.winner = "draw";
      state.winReason = "mutual-elimination";
    } else if (enemyMovable === 0) {
      state.phase = GAME_PHASES.FINISHED;
      state.winner = moverSide;
      state.winReason = "elimination";
    } else if (moverMovable === 0) {
      state.phase = GAME_PHASES.FINISHED;
      state.winner = enemySide;
      state.winReason = "elimination";
    }
  }

  state.history.push(event);
  if (state.phase !== GAME_PHASES.FINISHED) {
    state.turn = enemySide;
    state.turnCount += 1;
  }
  if (battle && !event.battle) {
    event.battle = battle.public;
  }
}

function getAdjacentMoves(state, piece) {
  const moves = [];
  if (isHqNode(piece.nodeId)) {
    for (const targetNode of getNeighbors(piece.nodeId)) {
      if (!canOccupyTarget(state, piece, targetNode)) {
        continue;
      }
      moves.push(createMove(piece, targetNode, [targetNode]));
    }
    return dedupeMoves(moves);
  }

  for (const direction of CARDINAL_DIRECTIONS) {
    const transition = getStepTransition(piece.nodeId, direction);
    if (!transition || !canOccupyTarget(state, piece, transition.targetNode)) {
      continue;
    }
    moves.push(createMove(piece, transition.targetNode, transition.path));
  }
  return dedupeMoves(moves);
}

function getTankLikeMoves(state, piece) {
  if (isHqNode(piece.nodeId)) {
    return getAdjacentMoves(state, piece);
  }

  const moves = [];
  const forwardDirection = getForwardDirection(piece.side);
  const backwardDirection = getOppositeDirection(forwardDirection);

  for (const direction of [forwardDirection, backwardDirection, "west", "east"]) {
    const transition = getStepTransition(piece.nodeId, direction);
    if (!transition || !canOccupyTarget(state, piece, transition.targetNode)) {
      continue;
    }
    moves.push(createMove(piece, transition.targetNode, transition.path));
  }

  const firstForward = getStepTransition(piece.nodeId, forwardDirection);
  if (
    firstForward &&
    !state.board[firstForward.targetNode]
  ) {
    const secondForward = getStepTransition(firstForward.targetNode, forwardDirection);
    if (secondForward && canOccupyTarget(state, piece, secondForward.targetNode)) {
      moves.push(
        createMove(piece, secondForward.targetNode, [...firstForward.path, ...secondForward.path]),
      );
    }
  }

  return dedupeMoves(moves);
}

function getEngineerMoves(state, piece) {
  if (isHqNode(piece.nodeId)) {
    return getAdjacentMoves(state, piece);
  }
  const moves = [];
  for (const direction of CARDINAL_DIRECTIONS) {
    const path = [piece.nodeId];
    let cursorNode = piece.nodeId;
    while (true) {
      const transition = getStepTransition(cursorNode, direction);
      if (!transition) {
        break;
      }
      path.push(...transition.path);
      const targetNode = transition.targetNode;
      const occupantId = state.board[targetNode];
      if (occupantId) {
        if (state.pieces[occupantId].side !== piece.side) {
          moves.push(createMove(piece, targetNode, path.slice(1)));
        }
        break;
      }
      moves.push(createMove(piece, targetNode, path.slice(1)));
      if (isHqNode(targetNode)) {
        break;
      }
      cursorNode = targetNode;
    }
  }

  return dedupeMoves(moves);
}

function getAircraftMoves(state, piece) {
  const moves = [];
  if (isHqNode(piece.nodeId)) {
    return getAdjacentMoves(state, piece);
  }
  const { file, row } = toCoord(piece.nodeId);

  for (const rowDelta of [-1, 1]) {
    const path = [piece.nodeId];
    let nextRow = row + rowDelta;
    while (nextRow >= 1 && nextRow <= 9) {
      let targetNode = null;
      if (nextRow === 1 && (file === "C" || file === "D")) {
        targetNode = AI_HQ;
      } else if (nextRow === 9 && (file === "C" || file === "D")) {
        targetNode = PLAYER_HQ;
      } else {
        const cellId = `${file}${nextRow}`;
        if (isBridgeCell(cellId)) {
          path.push(cellId);
          nextRow += rowDelta;
          continue;
        }
        targetNode = fromFileRank(file, nextRow);
      }

      nextRow += rowDelta;
      if (!targetNode) {
        continue;
      }

      path.push(targetNode);
      const occupantId = state.board[targetNode];
      if (occupantId && state.pieces[occupantId].side === piece.side) {
        if (isHqNode(targetNode)) {
          break;
        }
        continue;
      }
      moves.push(createMove(piece, targetNode, path.slice(1)));
      if (isHqNode(targetNode)) {
        break;
      }
    }
  }

  for (const direction of ["west", "east"]) {
    const transition = getStepTransition(piece.nodeId, direction);
    if (!transition || !canOccupyTarget(state, piece, transition.targetNode)) {
      continue;
    }
    moves.push(createMove(piece, transition.targetNode, transition.path));
  }

  return dedupeMoves(moves);
}

function canOccupyTarget(state, piece, targetNode) {
  const occupantId = state.board[targetNode];
  if (!occupantId) {
    return true;
  }
  return state.pieces[occupantId].side !== piece.side;
}

function getForwardDirection(side) {
  return side === SIDES.PLAYER ? "north" : "south";
}

function createMove(piece, targetNode, pathSegments) {
  return {
    pieceId: piece.id,
    from: piece.nodeId,
    to: targetNode,
    path: [piece.nodeId, ...pathSegments],
  };
}

function dedupeMoves(moves) {
  const seen = new Set();
  return moves.filter((move) => {
    const key = `${move.pieceId}:${move.to}:${move.path.join(">")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
