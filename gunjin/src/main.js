import {
  DIFFICULTIES,
  GAME_PHASES,
  GUIDE_OVERVIEW_SECTIONS,
  PIECE_DEFS,
  PIECE_TYPES,
  PRESET_LAYOUTS,
  SIDES,
} from "./engine/constants.js";
import { DISPLAY_SLOTS, HOME_NODES } from "./engine/board.js";
import { applyMove, compareTypesFromPerspective, getLegalMovesForPiece } from "./engine/rules.js";
import {
  applyPresetToSetup,
  buildAiLayout,
  createEmptySetupState,
  getSetupMoveViolation,
  isSetupMoveAllowed,
  removePieceFromSetup,
  setPiecePlacement,
  validateSetup,
} from "./engine/setup.js";
import { createGameState } from "./engine/state.js";
import { deriveViewerState } from "./engine/view.js";
import { loadAppSnapshot, saveAppSnapshot } from "./storage/local-storage.js";
import { renderPieceToken } from "./ui/piece-token.js";

const root = document.getElementById("app");
const worker = new Worker(new URL("./ai/worker.js", import.meta.url), { type: "module" });
const RESULT_OVERLAY_CLOSE_MS = 220;
const MIN_AI_THINK_MS = 500;
const PIECE_PLACEMENT_SOUND_URL = new URL("../sounds/piece_placement.mp3", import.meta.url).href;

let appState = loadAppSnapshot() ?? createDefaultAppState();
let uiState = {
  selectedSetupPieceId: null,
  selectedBattlePieceId: null,
  message: "",
  guideOpen: !appState.tutorialSeen && appState.screen === "setup",
  guideSection: "overview",
  aiThinking: false,
  aiRequestId: null,
  aiThinkingStartedAt: 0,
  dragPieceId: null,
  resultOverlayDismissed: false,
  resultOverlayClosing: false,
  resultOverlayHeight: 0,
};
const BATTLE_DEBUG_ENABLED = isBattleDebugEnabled();
let lastBattleDebugSnapshotKey = null;
let resultOverlayCloseTimerId = null;
let aiMoveDelayTimerId = null;
let aiRequestSequence = 0;
let audioUnlocked = false;

const GUIDE_SECTIONS = Object.freeze([
  { id: "overview", label: "遊び方" },
  { id: "movement", label: "駒の動き" },
  { id: "matchup", label: "駒相性" },
]);

worker.onmessage = (event) => {
  const { move, requestId } = event.data;
  if (!uiState.aiThinking || requestId !== uiState.aiRequestId || !appState.gameState) {
    return;
  }
  const elapsed = getNow() - uiState.aiThinkingStartedAt;
  const waitMs = Math.max(0, MIN_AI_THINK_MS - elapsed);
  clearAiMoveDelayTimer();

  if (waitMs === 0) {
    applyResolvedAiMove(move, requestId);
    return;
  }

  aiMoveDelayTimerId = window.setTimeout(() => {
    aiMoveDelayTimerId = null;
    applyResolvedAiMove(move, requestId);
  }, waitMs);
};

root.addEventListener("click", unlockAudio);
root.addEventListener("click", handleClick);
root.addEventListener("change", handleChange);
root.addEventListener("dragstart", handleDragStart);
root.addEventListener("dragover", handleDragOver);
root.addEventListener("drop", handleDrop);
root.addEventListener("dragend", handleDragEnd);
window.addEventListener("dragend", handleDragEnd);
window.addEventListener("keydown", unlockAudio);

render();
maybeScheduleAiMove();

function createDefaultAppState() {
  return {
    tutorialSeen: false,
    difficulty: "medium",
    matchupHintEnabled: true,
    screen: "setup",
    setupState: applyPresetToSetup(createEmptySetupState(), "balanced"),
    gameState: null,
  };
}

function persist() {
  saveAppSnapshot({
    tutorialSeen: appState.tutorialSeen,
    difficulty: appState.difficulty,
    matchupHintEnabled: appState.matchupHintEnabled,
    screen: appState.screen,
    setupState: appState.setupState,
    gameState: appState.gameState,
  });
}

function unlockAudio() {
  audioUnlocked = true;
}

function playPiecePlacementSound() {
  if (!audioUnlocked) {
    return;
  }

  const audio = new Audio(PIECE_PLACEMENT_SOUND_URL);
  const playback = audio.play();
  playback?.catch(() => {});
}

function commitBattleMove(move) {
  if (!appState.gameState) {
    return;
  }

  appState.gameState = applyMove(appState.gameState, move);
  uiState.selectedBattlePieceId = null;
  persist();
  playPiecePlacementSound();
  render();
  maybeScheduleAiMove();
}

function isBattleDebugEnabled() {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("debug") === "1" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

function render() {
  const revealAll = appState.gameState?.phase === GAME_PHASES.FINISHED;
  const playerView = appState.gameState
    ? deriveViewerState(appState.gameState, SIDES.PLAYER, { revealAll })
    : null;
  const lastBattleNodeId = getLastBattleNodeId(appState.gameState);
  const selectedMoveTargets =
    playerView && appState.gameState?.turn === SIDES.PLAYER && uiState.selectedBattlePieceId
      ? getLegalMovesForPiece(appState.gameState, uiState.selectedBattlePieceId).map((move) => move.to)
      : [];
  const validation = validateSetup(appState.setupState);
  const reservePieces = appState.setupState.pieces.filter((piece) => !piece.nodeId);

  root.innerHTML = `
    <div class="app-shell">
      <div class="main-column">
        <section class="hero">
          <div class="hero-copy">
            <h1>軍人将棋Web</h1>
            <p>一人で遊べる軍人将棋ゲーム（23枚型）です。</p>
          </div>
          <div class="hero-actions">
            <button class="button-secondary" data-action="open-guide" data-guide-section="overview">ルール・遊び方</button>
          </div>
        </section>

        ${renderBoardCard({ playerView, selectedMoveTargets, validation, reservePieces, lastBattleNodeId })}
        ${renderPageFooter()}
      </div>
    </div>
    ${uiState.guideOpen ? renderGuideDrawer() : ""}
    ${renderBattleResultOverlay()}
  `;
  syncResultOverlayHeight();
  logBattleDebugState(playerView);
}

function syncResultOverlayHeight() {
  const resultCard = root.querySelector(".result-overlay-card");
  if (!resultCard) {
    return;
  }

  const nextHeight = Math.round(resultCard.getBoundingClientRect().height);
  if (nextHeight > 0) {
    uiState.resultOverlayHeight = nextHeight;
  }
}

function clearResultOverlayCloseTimer() {
  if (resultOverlayCloseTimerId === null) {
    return;
  }
  window.clearTimeout(resultOverlayCloseTimerId);
  resultOverlayCloseTimerId = null;
}

function clearAiMoveDelayTimer() {
  if (aiMoveDelayTimerId === null) {
    return;
  }
  window.clearTimeout(aiMoveDelayTimerId);
  aiMoveDelayTimerId = null;
}

function resetAiTurnState() {
  clearAiMoveDelayTimer();
  uiState.aiThinking = false;
  uiState.aiRequestId = null;
  uiState.aiThinkingStartedAt = 0;
}

function applyResolvedAiMove(move, requestId) {
  if (!uiState.aiThinking || requestId !== uiState.aiRequestId || !appState.gameState) {
    return;
  }

  resetAiTurnState();
  if (
    appState.gameState.turn !== SIDES.AI ||
    appState.gameState.phase === GAME_PHASES.FINISHED ||
    !move
  ) {
    render();
    return;
  }

  commitBattleMove(move);
}

function resetResultOverlayState() {
  clearResultOverlayCloseTimer();
  uiState.resultOverlayDismissed = false;
  uiState.resultOverlayClosing = false;
  uiState.resultOverlayHeight = 0;
}

function dismissResultOverlay() {
  if (uiState.resultOverlayClosing || uiState.resultOverlayDismissed) {
    return;
  }
  clearResultOverlayCloseTimer();
  uiState.resultOverlayClosing = true;
  render();
  resultOverlayCloseTimerId = window.setTimeout(() => {
    resultOverlayCloseTimerId = null;
    uiState.resultOverlayClosing = false;
    uiState.resultOverlayDismissed = true;
    render();
  }, RESULT_OVERLAY_CLOSE_MS);
}

function logBattleDebugState(playerView) {
  if (!BATTLE_DEBUG_ENABLED || appState.screen !== "battle" || !appState.gameState || !playerView) {
    lastBattleDebugSnapshotKey = null;
    return;
  }

  const state = appState.gameState;
  const snapshotKey = buildBattleDebugSnapshotKey(state);
  if (snapshotKey === lastBattleDebugSnapshotKey) {
    return;
  }
  lastBattleDebugSnapshotKey = snapshotKey;

  const hiddenEnemyPieces = summarizeHiddenEnemyPieces(state, playerView);
  const lastEvent = state.history.at(-1);
  const header = [
    `[軍人将棋 debug] ${state.turnCount} 手目`,
    `手番: ${sideLabel(state.turn)}`,
    `phase: ${state.phase}`,
    state.winner ? `winner: ${state.winner === "draw" ? "draw" : sideLabel(state.winner)}` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  console.groupCollapsed(header);
  console.log("概要", {
    turn: state.turn,
    turnCount: state.turnCount,
    phase: state.phase,
    winner: state.winner,
    winReason: state.winReason,
    historyLength: state.history.length,
    hiddenEnemyCount: hiddenEnemyPieces.length,
  });
  if (lastEvent) {
    console.log("直前のイベント", formatDebugHistoryEntry(lastEvent, state));
  }
  console.table(buildBoardDebugRows(state, playerView));
  console.table(summarizeAlivePieces(state));
  if (hiddenEnemyPieces.length) {
    console.table(hiddenEnemyPieces);
  }
  console.groupEnd();
}

function buildBattleDebugSnapshotKey(state) {
  const boardSignature = Object.entries(state.board)
    .filter(([, pieceId]) => pieceId)
    .sort(([leftNode], [rightNode]) => leftNode.localeCompare(rightNode))
    .map(([nodeId, pieceId]) => {
      const piece = state.pieces[pieceId];
      return `${nodeId}:${pieceId}:${piece.moveCount}:${piece.alive ? "1" : "0"}`;
    })
    .join("|");

  return [
    state.phase,
    state.turn,
    state.turnCount,
    state.winner ?? "",
    state.winReason ?? "",
    state.history.length,
    boardSignature,
  ].join("::");
}

function buildBoardDebugRows(state, playerView) {
  return DISPLAY_SLOTS.filter((slot) => slot.nodeId).map((slot) => {
    const actualPieceId = state.board[slot.nodeId];
    const actualPiece = actualPieceId ? state.pieces[actualPieceId] : null;
    const visiblePiece = playerView.board[slot.nodeId];
    const isHiddenEnemy = actualPiece?.side === SIDES.AI && !visiblePiece?.known;

    return {
      マス: slot.nodeId,
      公開表示: visiblePiece ? formatVisiblePieceLabel(visiblePiece) : "",
      実際の駒: actualPiece ? formatActualPieceLabel(actualPiece) : "",
      隠し敵駒: isHiddenEnemy ? "yes" : "",
      移動回数: actualPiece?.moveCount ?? "",
    };
  });
}

function summarizeAlivePieces(state) {
  return Object.values(state.pieces)
    .filter((piece) => piece.alive)
    .sort((left, right) => {
      const leftSideOrder = left.side === SIDES.PLAYER ? 0 : 1;
      const rightSideOrder = right.side === SIDES.PLAYER ? 0 : 1;
      if (leftSideOrder !== rightSideOrder) {
        return leftSideOrder - rightSideOrder;
      }
      return (left.nodeId ?? "").localeCompare(right.nodeId ?? "");
    })
    .map((piece) => ({
      id: piece.id,
      陣営: sideLabel(piece.side),
      駒: pieceLabel(piece.type),
      位置: piece.nodeId ?? "撃破",
      移動回数: piece.moveCount,
    }));
}

function summarizeHiddenEnemyPieces(state, playerView) {
  return Object.values(state.pieces)
    .filter((piece) => piece.side === SIDES.AI && piece.alive && !playerView.pieces[piece.id]?.known)
    .sort((left, right) => (left.nodeId ?? "").localeCompare(right.nodeId ?? ""))
    .map((piece) => ({
      id: piece.id,
      駒: pieceLabel(piece.type),
      位置: piece.nodeId,
      移動回数: piece.moveCount,
    }));
}

function formatVisiblePieceLabel(piece) {
  return `${sideLabel(piece.side)}:${piece.known ? piece.label : "未公開"}`;
}

function formatActualPieceLabel(piece) {
  return `${sideLabel(piece.side)}:${pieceLabel(piece.type)} (${piece.id})`;
}

function pieceLabel(type) {
  return PIECE_DEFS[type]?.label ?? type;
}

function sideLabel(side) {
  return side === SIDES.PLAYER ? "自分" : "AI";
}

function formatDebugHistoryEntry(entry, state) {
  const actor = state.pieces[entry.pieceId];
  const actorLabel = `${sideLabel(actor.side)}:${pieceLabel(actor.type)}`;

  if (!entry.battle) {
    return `${actorLabel} ${entry.from} -> ${entry.to}`;
  }

  const defender = state.pieces[entry.battle.defenderId];
  const defenderLabel = `${sideLabel(defender.side)}:${pieceLabel(defender.type)}`;
  return `${actorLabel} ${entry.from} -> ${entry.to} / 戦闘: ${defenderLabel} / outcome=${entry.battle.outcome} / reason=${entry.battle.reason}`;
}

function renderBoardCard({ playerView, selectedMoveTargets, validation, reservePieces, lastBattleNodeId }) {
  const setupMode = appState.screen === "setup";
  const activeSetupPiece = setupMode ? getSetupPreviewPiece() : null;
  const showFocusOverlay = Boolean(
    appState.matchupHintEnabled
    && ((setupMode && activeSetupPiece) || (!setupMode && uiState.selectedBattlePieceId)),
  );
  const boardHtml = setupMode
    ? renderSetupBoard(appState.setupState, {
      activeSetupPiece,
      showFocusOverlay,
    })
    : renderBattleBoard(playerView, selectedMoveTargets, showFocusOverlay, lastBattleNodeId);
  const statusHtml = setupMode ? renderSetupControls(reservePieces) : renderBattleControls(playerView);
  const setupOverlayHtml = setupMode ? renderSetupBoardOverlay(validation) : "";

  let overlayHtml = "";
  if (appState.matchupHintEnabled) {
    if (!setupMode && uiState.selectedBattlePieceId && appState.gameState) {
      const piece = appState.gameState.pieces[uiState.selectedBattlePieceId];
      if (piece) {
        const side = getMatchupStripSide(piece.nodeId);
        overlayHtml = renderMatchupHintOverlay(piece.type, side);
      }
    } else if (setupMode && activeSetupPiece) {
      const side = getMatchupStripSide(activeSetupPiece.nodeId);
      overlayHtml = renderMatchupHintOverlay(activeSetupPiece.type, side);
    }
  }

  return `
    <section class="board-card">
      <div class="board-and-status">
        <div class="board-wrap">
          <div class="board-grid">
            <div class="board-river-band" aria-hidden="true"></div>
            ${boardHtml}
            ${setupOverlayHtml}
          </div>
          ${overlayHtml}
        </div>
        <div class="status-card">
          ${statusHtml}
        </div>
      </div>
    </section>
  `;
}

function renderPageFooter() {
  return `
    <footer class="page-footer">
      <p>
        当サイトはブラウザゲーム
        <a href="https://shogi.yuki-lab.com/" target="_blank" rel="noreferrer">「将棋Web」</a>
        の姉妹サイトです。
      </p>
    </footer>
  `;
}

function renderSetupBoard(setupState, { activeSetupPiece = null, showFocusOverlay = false } = {}) {
  const interactiveNodes = new Set(HOME_NODES[SIDES.PLAYER]);
  const dimmedSlots = showFocusOverlay
    ? new Set(
      DISPLAY_SLOTS
        .filter((slot) => !slot.nodeId || !interactiveNodes.has(slot.nodeId))
        .map((slot) => slot.displayId),
    )
    : null;
  return DISPLAY_SLOTS.map((slot) => {
    const pieceId = slot.nodeId ? setupState.placements[slot.nodeId] ?? null : null;
    const piece = pieceId ? setupState.pieces.find((item) => item.id === pieceId) : null;
    const forbidden = Boolean(
      activeSetupPiece
      && slot.nodeId
      && interactiveNodes.has(slot.nodeId)
      && getSetupMoveViolation(setupState, activeSetupPiece.id, slot.nodeId),
    );
    const interactive = slot.nodeId ? interactiveNodes.has(slot.nodeId) && !forbidden : false;
    const selected = Boolean(uiState.selectedSetupPieceId && pieceId === uiState.selectedSetupPieceId);
    const dimmed = Boolean(dimmedSlots?.has(slot.displayId));
    return `
      <div
        class="${buildBoardNodeClassName(slot, {
      interactive,
      selected,
      dimmed,
      forbidden,
    })}"
        style="grid-column:${slot.col} / span ${slot.span};grid-row:${slot.row};"
        ${slot.nodeId ? `data-node-id="${slot.nodeId}"` : ""}
        data-context="setup"
        data-row="${slot.row}"
      >
        ${renderBoardSlotLabel(slot)}
        ${piece ? renderPieceToken(piece, { context: "setup", hidden: false, draggable: true }) : ""}
        ${piece ? renderSetupPieceRemoveButton(piece) : ""}
        ${renderBoardSlotNote(slot, { interactive, showIdleNote: true, forbidden })}
      </div>
    `;
  }).join("");
}

function renderSetupPieceRemoveButton(piece) {
  return `
    <button
      class="setup-piece-remove"
      type="button"
      data-action="remove-setup-piece"
      data-piece-id="${piece.id}"
      aria-label="${PIECE_DEFS[piece.type]?.label ?? "駒"}を控えに戻す"
      title="控えに戻す"
    >
      ×
    </button>
  `;
}

function renderBattleBoard(playerView, selectedMoveTargets, showFocusOverlay = false, lastBattleNodeId = null) {
  const legalTargetSet = new Set(selectedMoveTargets);
  return DISPLAY_SLOTS.map((slot) => {
    const isBlocked = slot.cellType === "blocked";
    const piece = slot.nodeId ? playerView.board[slot.nodeId] : null;
    const selected = Boolean(piece && piece.id === uiState.selectedBattlePieceId);
    const legal = Boolean(slot.nodeId && legalTargetSet.has(slot.nodeId));
    const lastBattle = Boolean(slot.nodeId && slot.nodeId === lastBattleNodeId);
    const dimmed = showFocusOverlay && !selected && !legal;
    const clickable =
      !isBlocked &&
      Boolean(slot.nodeId) &&
      appState.gameState?.phase !== GAME_PHASES.FINISHED &&
      appState.gameState?.turn === SIDES.PLAYER &&
      (legal || (piece && piece.side === SIDES.PLAYER));

    return `
      <div
        class="${buildBoardNodeClassName(slot, {
      interactive: clickable,
      selected,
      legal,
      dimmed,
      lastBattle,
    })}"
        style="grid-column:${slot.col} / span ${slot.span};grid-row:${slot.row};"
        ${slot.nodeId ? `data-node-id="${slot.nodeId}"` : ""}
        data-context="battle"
        data-row="${slot.row}"
      >
        ${renderBoardSlotLabel(slot)}
        ${piece ? renderPieceToken(piece, { context: "battle", hidden: !piece.known && !playerView.revealAll, draggable: false }) : ""}
        ${renderBoardSlotNote(slot)}
      </div>
    `;
  }).join("");
}

function buildBoardNodeClassName(
  slot,
  {
    interactive = false,
    selected = false,
    legal = false,
    dimmed = false,
    forbidden = false,
    lastBattle = false,
  } = {},
) {
  const isRiverBand = slot.row === 5 && (slot.cellType === "bridge" || slot.cellType === "blocked");

  return [
    "board-node",
    slot.cellType === "hq" ? "is-hq" : "",
    isRiverBand ? "is-river" : "",
    slot.cellType === "bridge" ? "is-bridge" : "",
    slot.cellType === "blocked" ? "is-blocked" : "",
    interactive ? "is-clickable" : "",
    selected ? "is-selected" : "",
    legal ? "is-legal" : "",
    forbidden ? "is-forbidden" : "",
    lastBattle ? "is-last-battle" : "",
    dimmed ? "has-dim-overlay" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderBoardSlotLabel(slot) {
  if (slot.row === 5) {
    return "";
  }
  const label = slot.cellType === "hq" ? "司令部" : slot.displayId;
  return `<span class="board-node-label">${label}</span>`;
}

function renderBoardSlotNote(slot, { interactive = false, showIdleNote = false, forbidden = false } = {}) {
  if (slot.row === 5) {
    return "";
  }
  if (forbidden) {
    return `<div class="board-node-note is-forbidden">配置不可</div>`;
  }
  if (!showIdleNote || !slot.nodeId || interactive) {
    return "";
  }
  return `<div class="board-node-note">待機</div>`;
}

function renderSetupControls(reservePieces) {
  return `
    <div class="status-section">
      <h3>陣形作成フェーズ</h3>
      ${renderMatchupHintToggle()}
    </div>
    <div class="status-section">
      <h3>控え駒</h3>
      ${reservePieces.length
      ? `<div class="layout-pieces">${reservePieces
        .map((piece) =>
          `<div class="reserve-piece ${uiState.selectedSetupPieceId === piece.id ? "is-selected" : ""}">${renderPieceToken(piece, {
            context: "setup",
            hidden: false,
            draggable: true,
          })}</div>`,
        )
        .join("")}</div>`
      : `<p class="footer-note">すべて配置済みです。</p>`
    }
    </div>
  `;
}

function renderSetupBoardOverlay(validation) {
  return `
    <div class="setup-top-overlay" style="grid-column:1 / -1;grid-row:1 / span 4;">
      <div class="setup-top-content">
        <p class="setup-overlay-copy">駒をドラッグ&ドロップすると開戦時の陣形をカスタマイズできます</p>
        <div class="setup-top-control-row">
          <div class="setup-difficulty-group">
            <label class="setup-overlay-label" for="difficulty-select">AIの強さ</label>
            ${renderDifficultySelect({ id: "difficulty-select", className: "setup-board-select" })}
          </div>
          <button class="button-primary" data-action="start-game" ${validation.valid ? "" : "disabled"}>対戦開始</button>
        </div>
      </div>
    </div>
    <div class="setup-river-controls" style="grid-column:1 / -1;grid-row:5;">
      <div class="setup-river-panel">
        <div class="setup-river-label">陣形サンプル</div>
        ${renderSetupPresetChoices()}
      </div>
    </div>
  `;
}

function renderDifficultySelect({ id, className = "" }) {
  const classAttr = className ? ` class="${className}"` : "";
  return `
    <select id="${id}"${classAttr} data-action="set-difficulty">
      ${Object.values(DIFFICULTIES)
      .map(
        (difficulty) =>
          `<option value="${difficulty.id}" ${difficulty.id === appState.difficulty ? "selected" : ""}>${difficulty.label}</option>`,
      )
      .join("")}
    </select>
  `;
}

function renderSetupPresetChoices() {
  return `
    <div class="setup-river-choice-grid">
      ${Object.values(PRESET_LAYOUTS)
      .map(
        (preset) =>
          `<button data-action="apply-preset" data-preset-id="${preset.id}">${preset.label}</button>`,
      )
      .join("")}
      <button class="delete-button" data-action="clear-setup">全削除</button>
    </div>
  `;
}

function renderBattleControls(playerView) {
  const ownTotal = countRemainingPieces(playerView, SIDES.PLAYER);
  const enemyTotal = countRemainingPieces(playerView, SIDES.AI);
  return `
    <h3>対戦フェーズ</h3>
    <div class="info-list">
      <div class="info-row"><span>手番</span><strong>${appState.gameState.turn === SIDES.PLAYER ? "あなた" : "AI"}</strong></div>
      <div class="info-row"><span>難易度</span><strong>${DIFFICULTIES[appState.difficulty].label}</strong></div>
      <div class="info-row"><span>選択中</span><strong>${selectedBattlePieceLabel(playerView)}</strong></div>
      <div class="info-row"><span>自軍の総数</span><strong>${ownTotal} 枚</strong></div>
      <div class="info-row"><span>敵の総数</span><strong>${enemyTotal} 枚</strong></div>
    </div>
    <div class="section-divider"></div>
    <div class="controls">
      <button class="button-primary" data-action="next-battle">次の戦いへ</button>
    </div>
    ${uiState.aiThinking
      ? `<div class="pill enemy" style="margin-top:12px;">AI が手を読んでいます…</div>`
      : ""
    }
    <div class="section-divider"></div>
    ${renderMatchupHintToggle()}
    <div class="section-divider"></div>
    <h3>対戦ログ</h3>
    <div class="log">${renderLogEntries(playerView)}</div>
  `;
}

function renderBattleResultOverlay() {
  const result = getBattleResultMeta();
  if (!result) {
    return "";
  }

  if (uiState.resultOverlayDismissed) {
    const handleHeight = uiState.resultOverlayHeight > 0 ? uiState.resultOverlayHeight : 320;
    return `
      <button
        class="result-overlay-handle ${result.toneClass}"
        type="button"
        data-action="reopen-result-overlay"
        aria-label="対局結果を表示"
        title="対局結果を表示"
        style="height:${handleHeight}px"
      >
        <span class="result-overlay-grip" aria-hidden="true"></span>
      </button>
    `;
  }

  return `
    <div class="result-overlay-backdrop ${uiState.resultOverlayClosing ? "is-closing" : ""}">
      <div class="result-overlay-scrim ${uiState.resultOverlayClosing ? "is-closing" : ""}" aria-hidden="true"></div>
      <aside
        class="result-overlay-card ${result.toneClass} ${uiState.resultOverlayClosing ? "is-closing" : ""}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-overlay-title"
      >
        <button
          class="result-overlay-close"
          type="button"
          data-action="dismiss-result-overlay"
          aria-label="対局結果を閉じる"
          title="閉じる"
        >
          <span aria-hidden="true">×</span>
        </button>
        <p class="result-overlay-eyebrow">戦況報告</p>
        <h2 id="result-overlay-title">${result.title}</h2>
        <p class="result-overlay-reason">${result.reason}</p>
        <p class="result-overlay-meta">難易度 ${result.difficultyLabel} / ${result.turnCount}手</p>
        <div class="result-overlay-actions">
          <button class="button-x-share" type="button" data-action="share-result-x">𝕏 でシェア</button>
          <button class="button-primary" type="button" data-action="next-battle">次の戦いへ</button>
        </div>
      </aside>
    </div>
  `;
}

function getBattleResultMeta() {
  const gameState = appState.gameState;
  if (!gameState || gameState.phase !== GAME_PHASES.FINISHED) {
    return null;
  }

  const difficultyLabel =
    DIFFICULTIES[gameState.difficulty]?.label
    ?? DIFFICULTIES[appState.difficulty]?.label
    ?? gameState.difficulty
    ?? "不明";

  if (gameState.winner === "draw") {
    return {
      title: "引き分け",
      reason: formatBattleResultReason(gameState.winReason),
      difficultyLabel,
      turnCount: gameState.turnCount,
      toneClass: "is-draw",
      shareText: `軍人将棋Webで引き分けました（${difficultyLabel}・${gameState.turnCount}手）。`,
    };
  }

  if (gameState.winner === SIDES.PLAYER) {
    return {
      title: "勝利",
      reason: formatBattleResultReason(gameState.winReason),
      difficultyLabel,
      turnCount: gameState.turnCount,
      toneClass: "is-victory",
      shareText: `軍人将棋Webで勝利しました（${difficultyLabel}・${gameState.turnCount}手）。`,
    };
  }

  return {
    title: "敗北",
    reason: formatBattleResultReason(gameState.winReason),
    difficultyLabel,
    turnCount: gameState.turnCount,
    toneClass: "is-defeat",
    shareText: `軍人将棋Webで敗北しました（${difficultyLabel}・${gameState.turnCount}手）。`,
  };
}

function formatBattleResultReason(winReason) {
  if (winReason === "hq") {
    return "司令部を占領しました。";
  }
  if (winReason === "elimination") {
    return "可動駒が尽きました。";
  }
  return "同時に可動駒が尽きました。";
}

function openBattleResultShare() {
  const result = getBattleResultMeta();
  if (!result) {
    return;
  }

  const shareUrl = new URL("https://twitter.com/intent/tweet");
  shareUrl.searchParams.set("text", result.shareText);
  shareUrl.searchParams.set("url", `${window.location.origin}${window.location.pathname}`);

  const popup = window.open(shareUrl.toString(), "_blank", "noopener,noreferrer");
  if (!popup) {
    window.location.assign(shareUrl.toString());
  }
}

function renderMatchupMatrix() {
  const headers = PIECE_TYPES.map((type) => PIECE_DEFS[type].label);
  const rows = PIECE_TYPES.map((attackerType) => {
    const cells = PIECE_TYPES.map((defenderType) => {
      const result = compareDisplayOutcome(attackerType, defenderType);
      return `<td class="${result.className}">${result.label}</td>`;
    }).join("");
    return `<tr><th scope="row">${PIECE_DEFS[attackerType].label}</th>${cells}</tr>`;
  }).join("");

  return `
    <table aria-label="駒相性表">
      <thead>
        <tr>
          <th scope="col">攻＼守</th>
          ${headers.map((label) => `<th scope="col">${label}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderGuideDrawer() {
  const currentSection =
    GUIDE_SECTIONS.find((section) => section.id === uiState.guideSection) ?? GUIDE_SECTIONS[0];
  return `
    <div class="guide-backdrop">
      <div class="guide-scrim" data-action="close-guide" aria-hidden="true"></div>
      <aside class="guide-drawer" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div class="guide-header">
          <div>
            <p class="guide-eyebrow">軍人将棋について</p>
            <h2 id="guide-title">${currentSection.label}</h2>
          </div>
          <button class="button-secondary guide-close" data-action="close-guide">閉じる</button>
        </div>
        <div class="guide-tabs" role="tablist" aria-label="軍人将棋について">
          ${GUIDE_SECTIONS.map(
    (section) => `
              <button
                class="guide-tab ${section.id === uiState.guideSection ? "is-active" : ""}"
                data-action="set-guide-section"
                data-guide-section="${section.id}"
                role="tab"
                aria-selected="${section.id === uiState.guideSection ? "true" : "false"}"
              >
                ${section.label}
              </button>
            `,
  ).join("")}
        </div>
        <div class="guide-body ${currentSection.id === "matchup" ? "is-matchup-view" : ""}">
          ${renderGuideSection()}
        </div>
      </aside>
    </div>
  `;
}

function renderGuideSection() {
  switch (uiState.guideSection) {
    case "movement":
      return renderMovementGuide();
    case "matchup":
      return renderMatchupGuide();
    default:
      return renderOverviewGuide();
  }
}

function renderOverviewGuide() {
  return `
    <section class="guide-section">
      <p class="guide-summary">
        初心者向けに軍人将棋を解説するガイドです。
      </p>
      <div class="guide-cards">
        ${GUIDE_OVERVIEW_SECTIONS.map(
    (section) => `
            <article class="guide-card">
              <h3>${section.title}</h3>
              <p>${section.body}</p>
            </article>
          `,
  ).join("")}
      </div>
    </section>
  `;
}

function renderMovementGuide() {
  return `
    <section class="guide-section">
      <div class="movement-list">
        ${PIECE_TYPES.map((type) => {
    const piece = PIECE_DEFS[type];
    return `
            <article class="movement-item">
              <div class="movement-title">
                <div class="movement-piece">
                  <div class="movement-token">
                    ${renderGuidePieceToken(type)}
                  </div>
                  <div class="movement-meta">
                    <h3>${piece.label}</h3>
                    <span class="piece-count">${piece.count} 枚</span>
                  </div>
                </div>
              </div>
              <p>${movementDescription(type)}</p>
            </article>
          `;
  }).join("")}
      </div>
    </section>
  `;
}

function renderMatchupGuide() {
  return `
    <section class="guide-section is-matchup">
      <p class="guide-summary">左が攻撃側です。「軍旗」は背後の駒と同じ強さになります。</p>
      <div class="matrix-shell">
        <div class="matrix">${renderMatchupMatrix()}</div>
      </div>
    </section>
  `;
}

function renderGuidePieceToken(type) {
  return renderPieceToken(
    {
      type,
      side: SIDES.PLAYER,
      moveCount: 0,
    },
    {
      context: "guide",
      hidden: false,
      draggable: false,
    },
  );
}

function renderLogEntries(playerView) {
  if (!playerView.history.length) {
    return `<div class="log-entry">まだ駒は動いていません。</div>`;
  }
  return playerView.history
    .slice(-8)
    .reverse()
    .map((entry) => `<div class="log-entry">${historyText(entry, playerView)}</div>`)
    .join("");
}

function historyText(entry, playerView) {
  const actor = playerView.pieces[entry.pieceId];
  const actorLabel = actor.known ? actor.label : "相手";
  if (!entry.battle) {
    return entry.side === SIDES.PLAYER
      ? `<strong>${actorLabel}</strong>が ${entry.from} から ${entry.to} へ進軍`
      : `相手の駒が ${entry.from} から ${entry.to} へ進軍`;
  }

  const ownAttackerLabel = entry.battle.attackerLabel ?? "相手";
  const ownDefenderLabel = entry.battle.defenderLabel ?? "相手";

  if (entry.side === SIDES.PLAYER) {
    if (entry.battle.outcome === "attacker") {
      return `あなたの<strong>${actorLabel}</strong>が ${entry.to} の相手に勝利`;
    }
    if (entry.battle.outcome === "defender") {
      return `あなたの<strong>${actorLabel}</strong>が ${entry.to} の相手に敗北`;
    }
    return `<strong>${actorLabel}</strong>が ${entry.to} を攻撃し、相打ち`;
  }

  if (entry.battle.outcome === "attacker") {
    return `${ownAttackerLabel}があなたの <strong>${ownDefenderLabel}</strong> を撃破`;
  }
  if (entry.battle.outcome === "defender") {
    return `あなたの <strong>${ownDefenderLabel}</strong> は${ownAttackerLabel}を退けました`;
  }
  return `あなたの <strong>${ownDefenderLabel}</strong> は${ownAttackerLabel}と相打ちになりました`;
}

function handleClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget) {
    handleAction(actionTarget);
    return;
  }

  const pieceTarget = event.target.closest("[data-piece-id]");
  const nodeTarget = event.target.closest("[data-node-id]");

  if (appState.screen === "setup") {
    if (pieceTarget?.dataset.context === "setup") {
      if (nodeTarget?.dataset.context === "setup") {
        handleSetupBoardPieceClick(pieceTarget.dataset.pieceId, nodeTarget.dataset.nodeId);
        return;
      }
      handleSetupPieceClick(pieceTarget.dataset.pieceId);
      return;
    }
    if (nodeTarget?.dataset.context === "setup") {
      handleSetupNodeClick(nodeTarget.dataset.nodeId);
    }
    return;
  }

  if (!appState.gameState || appState.gameState.turn !== SIDES.PLAYER || appState.gameState.phase === GAME_PHASES.FINISHED) {
    return;
  }

  if (pieceTarget?.dataset.context === "battle") {
    const piece = appState.gameState.pieces[pieceTarget.dataset.pieceId];
    if (piece?.side === SIDES.PLAYER) {
      uiState.selectedBattlePieceId =
        uiState.selectedBattlePieceId === piece.id ? null : piece.id;
      render();
      return;
    }
  }

  if (nodeTarget?.dataset.context === "battle") {
    handleBattleNodeClick(nodeTarget.dataset.nodeId);
  }
}

function handleChange(event) {
  const target = event.target;
  if (target.dataset.action === "set-difficulty") {
    appState.difficulty = target.value;
    persist();
    render();
  }
}

function handleAction(target) {
  const action = target.dataset.action;
  switch (action) {
    case "open-guide":
      uiState.guideOpen = true;
      uiState.guideSection = target.dataset.guideSection || uiState.guideSection || "overview";
      render();
      break;
    case "close-guide":
      closeGuide();
      break;
    case "set-guide-section":
      uiState.guideSection = target.dataset.guideSection || "overview";
      render();
      break;
    case "apply-preset":
      appState.setupState = applyPresetToSetup(createEmptySetupState(), target.dataset.presetId);
      uiState.selectedSetupPieceId = null;
      persist();
      render();
      break;
    case "clear-setup":
      appState.setupState = createEmptySetupState();
      uiState.selectedSetupPieceId = null;
      persist();
      render();
      break;
    case "remove-setup-piece":
      if (target.dataset.pieceId) {
        removeSetupPiece(target.dataset.pieceId);
      }
      break;
    case "start-game":
      startGame();
      break;
    case "next-battle":
      appState.screen = "setup";
      appState.gameState = null;
      uiState.selectedBattlePieceId = null;
      resetAiTurnState();
      resetResultOverlayState();
      persist();
      render();
      break;
    case "dismiss-result-overlay":
      dismissResultOverlay();
      break;
    case "reopen-result-overlay":
      clearResultOverlayCloseTimer();
      uiState.resultOverlayDismissed = false;
      uiState.resultOverlayClosing = false;
      render();
      break;
    case "share-result-x":
      openBattleResultShare();
      break;
    case "toggle-matchup-hint":
      appState.matchupHintEnabled = !appState.matchupHintEnabled;
      persist();
      render();
      break;
    default:
      break;
  }
}

function handleSetupPieceClick(pieceId) {
  uiState.selectedSetupPieceId = uiState.selectedSetupPieceId === pieceId ? null : pieceId;
  render();
}

function handleSetupBoardPieceClick(pieceId, nodeId) {
  if (!uiState.selectedSetupPieceId || uiState.selectedSetupPieceId === pieceId) {
    handleSetupPieceClick(pieceId);
    return;
  }
  handleSetupNodeClick(nodeId);
}

function handleSetupNodeClick(nodeId) {
  if (!HOME_NODES[SIDES.PLAYER].includes(nodeId)) {
    return;
  }
  const pieceId = appState.setupState.placements[nodeId];
  if (!uiState.selectedSetupPieceId) {
    if (pieceId) {
      uiState.selectedSetupPieceId = pieceId;
      render();
    }
    return;
  }
  const selectedPiece = getActiveSetupPiece();
  if (!selectedPiece || !isSetupMoveAllowed(appState.setupState, selectedPiece.id, nodeId)) {
    return;
  }
  appState.setupState = setPiecePlacement(appState.setupState, uiState.selectedSetupPieceId, nodeId);
  uiState.selectedSetupPieceId = null;
  persist();
  render();
}

function handleBattleNodeClick(nodeId) {
  if (!uiState.selectedBattlePieceId) {
    const occupantId = appState.gameState.board[nodeId];
    if (occupantId && appState.gameState.pieces[occupantId].side === SIDES.PLAYER) {
      uiState.selectedBattlePieceId = occupantId;
      render();
    }
    return;
  }
  const legalMoves = getLegalMovesForPiece(appState.gameState, uiState.selectedBattlePieceId);
  const move = legalMoves.find((candidate) => candidate.to === nodeId);
  if (!move) {
    uiState.selectedBattlePieceId = null;
    render();
    return;
  }
  commitBattleMove(move);
}

function handleDragStart(event) {
  const pieceTarget = event.target.closest(".piece-token");
  if (!pieceTarget || pieceTarget.dataset.context !== "setup") {
    return;
  }
  uiState.dragPieceId = pieceTarget.dataset.pieceId;
  event.dataTransfer?.setData("text/plain", pieceTarget.dataset.pieceId);
  requestAnimationFrame(() => {
    if (uiState.dragPieceId === pieceTarget.dataset.pieceId && appState.screen === "setup") {
      render();
    }
  });
}

function handleDragOver(event) {
  const nodeTarget = event.target.closest('[data-context="setup"][data-node-id]');
  const draggedPiece = uiState.dragPieceId ? getSetupPieceById(uiState.dragPieceId) : null;
  const validDropTarget = Boolean(
    nodeTarget
    && draggedPiece
    && isSetupMoveAllowed(appState.setupState, draggedPiece.id, nodeTarget.dataset.nodeId),
  );
  if (validDropTarget) {
    event.preventDefault();
  }
}

function handleDragEnd() {
  if (!uiState.dragPieceId) {
    return;
  }
  uiState.dragPieceId = null;
  if (appState.screen === "setup") {
    render();
  }
}

function handleDrop(event) {
  const pieceId = event.dataTransfer?.getData("text/plain") || uiState.dragPieceId;
  if (!pieceId) {
    return;
  }
  const nodeTarget = event.target.closest('[data-context="setup"][data-node-id]');
  const draggedPiece = getSetupPieceById(pieceId);
  if (
    nodeTarget
    && draggedPiece
    && HOME_NODES[SIDES.PLAYER].includes(nodeTarget.dataset.nodeId)
    && isSetupMoveAllowed(appState.setupState, draggedPiece.id, nodeTarget.dataset.nodeId)
  ) {
    event.preventDefault();
    uiState.dragPieceId = null;
    appState.setupState = setPiecePlacement(appState.setupState, pieceId, nodeTarget.dataset.nodeId);
    uiState.selectedSetupPieceId = null;
    persist();
    render();
    return;
  }
  uiState.dragPieceId = null;
  render();
}

function startGame() {
  const validation = validateSetup(appState.setupState);
  if (!validation.valid) {
    return;
  }
  const aiSetup = buildAiLayout();
  appState.gameState = createGameState({
    playerSetup: appState.setupState,
    aiSetup,
    difficulty: appState.difficulty,
  });
  appState.screen = "battle";
  uiState.selectedBattlePieceId = null;
  resetAiTurnState();
  resetResultOverlayState();
  persist();
  render();
  maybeScheduleAiMove();
}

function maybeScheduleAiMove() {
  if (
    !appState.gameState ||
    appState.gameState.turn !== SIDES.AI ||
    appState.gameState.phase === GAME_PHASES.FINISHED ||
    uiState.aiThinking
  ) {
    return;
  }

  clearAiMoveDelayTimer();
  uiState.aiThinking = true;
  uiState.aiThinkingStartedAt = getNow();
  uiState.aiRequestId = `turn-${appState.gameState.turnCount}-${++aiRequestSequence}`;
  const view = deriveViewerState(appState.gameState, SIDES.AI);
  worker.postMessage({ view, difficulty: appState.difficulty, requestId: uiState.aiRequestId, debug: BATTLE_DEBUG_ENABLED });
  render();
}

function closeGuide() {
  uiState.guideOpen = false;
  if (!appState.tutorialSeen) {
    appState.tutorialSeen = true;
    persist();
  }
  render();
}

function selectedBattlePieceLabel(playerView) {
  if (!uiState.selectedBattlePieceId || !playerView?.pieces[uiState.selectedBattlePieceId]) {
    return "なし";
  }
  return playerView.pieces[uiState.selectedBattlePieceId].label;
}

function getLastBattleNodeId(gameState) {
  if (!gameState?.history.length) {
    return null;
  }

  const lastEntry = gameState.history.at(-1);
  return lastEntry?.battle ? lastEntry.to : null;
}

function getActiveSetupPiece() {
  if (!uiState.selectedSetupPieceId) {
    return null;
  }
  return getSetupPieceById(uiState.selectedSetupPieceId);
}

function removeSetupPiece(pieceId) {
  appState.setupState = removePieceFromSetup(appState.setupState, pieceId);
  if (uiState.selectedSetupPieceId === pieceId) {
    uiState.selectedSetupPieceId = null;
  }
  persist();
  render();
}

function getSetupPreviewPiece() {
  if (uiState.dragPieceId) {
    return getSetupPieceById(uiState.dragPieceId);
  }
  return getActiveSetupPiece();
}

function getSetupPieceById(pieceId) {
  if (!pieceId) {
    return null;
  }
  return appState.setupState.pieces.find((piece) => piece.id === pieceId) ?? null;
}

function countRemainingPieces(playerView, side) {
  return Object.values(playerView.pieces).filter(
    (piece) => piece.side === side && piece.alive,
  ).length;
}

function compareDisplayOutcome(pieceType, opponentType) {
  if (pieceType === "flag") {
    return { label: "―", className: "" };
  }
  if (opponentType === "flag") {
    return { label: "―", className: "" };
  }
  const result = compareTypesFromPerspective(pieceType, opponentType);
  if (result.outcome === "subject") {
    return { label: "◯", className: "is-win" };
  }
  if (result.outcome === "opponent") {
    return { label: "✕", className: "is-loss" };
  }
  return { label: "△", className: "is-tie" };
}

function renderMatchupHintToggle() {
  const checked = appState.matchupHintEnabled;
  return `
    <div class="info-row">
      <span>駒を押すとヒント表示</span>
      <button class="toggle-switch ${checked ? "is-on" : ""}" data-action="toggle-matchup-hint" aria-pressed="${checked}">
        <span class="toggle-knob"></span>
      </button>
    </div>
  `;
}

function renderMatchupHintOverlay(pieceType, side) {
  const RESULT_SYMBOL = { "is-win": "\u25CB", "is-loss": "\u00D7", "is-tie": "\u25B3", "": "\u2014" };
  const rows = PIECE_TYPES.filter((type) => type !== "flag").map((defenderType) => {
    const result = compareDisplayOutcome(pieceType, defenderType);
    const symbol = RESULT_SYMBOL[result.className] ?? "\u2014";
    return `<div class="matchup-row ${result.className}"><span class="matchup-symbol">${symbol}</span><span class="matchup-name">${PIECE_DEFS[defenderType].label}</span></div>`;
  }).join("");

  return `
    <div class="matchup-strip ${side}">
      <div class="matchup-strip-title">${PIECE_DEFS[pieceType].label}</div>
      ${rows}
    </div>
  `;
}

function getMatchupStripSide(nodeId) {
  if (!nodeId) return "is-right";
  const file = nodeId.charAt(0);
  return file >= "D" ? "is-left" : "is-right";
}

function movementDescription(type) {
  switch (type) {
    case "tank":
    case "cavalry":
      return "前 1-2マス、後 1マス、横 1マス";
    case "engineer":
      return "縦横に任意距離、飛び越し不可";
    case "aircraft":
      return "縦に任意距離、横 1マス、飛び越し可";
    case "mine":
    case "flag":
      return "動けません";
    default:
      return "前後左右いずれかに1マス";
  }
}

function getNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
