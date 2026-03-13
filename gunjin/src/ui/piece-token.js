import { PIECE_DEFS, SIDES } from "../engine/constants.js";

export function getPieceTokenViewModel(
  piece,
  { context, hidden, draggable, viewerSide = SIDES.PLAYER },
) {
  const pieceDef = hidden ? null : PIECE_DEFS[piece.type] ?? null;
  const isOpponentPiece = context === "battle" && piece.side !== viewerSide;

  return {
    badgeHtml: pieceDef ? renderPieceBadge(pieceDef) : "",
    dataAttrs: buildPieceDataAttrs(piece, { context, hidden, draggable }),
    isAiOwned: piece.side === SIDES.AI,
    isHidden: hidden,
    isOpponentPiece,
    isRankPiece: pieceDef?.category === "rank",
    isReadableFromViewer: isOpponentPiece && !hidden,
    isStatic: !piece.id,
    label: pieceDef?.label ?? "",
    showLabel: Boolean(pieceDef),
  };
}

export function renderPieceToken(piece, options) {
  const viewModel = getPieceTokenViewModel(piece, options);
  const tokenClassName = classNames(
    "piece-token",
    viewModel.isHidden && "is-enemy-hidden",
    viewModel.isAiOwned && "is-ai-owned",
    viewModel.isRankPiece && "is-rank-piece",
    viewModel.isStatic && "is-static",
    viewModel.isOpponentPiece && "is-opponent-piece",
  );
  const faceClassName = classNames(
    "piece-face",
    viewModel.isReadableFromViewer && "is-readable-from-viewer",
  );

  return `
    <div
      class="${tokenClassName}"
      ${viewModel.dataAttrs}
    >
      <div class="${faceClassName}">
        ${viewModel.showLabel ? `<div class="piece-main">${viewModel.label}</div>` : ""}
        ${viewModel.badgeHtml}
      </div>
    </div>
  `;
}

function buildPieceDataAttrs(piece, { context, hidden, draggable }) {
  if (piece.id) {
    return `
      data-piece-id="${piece.id}"
      data-context="${context}"
      data-hidden="${hidden ? "1" : "0"}"
      draggable="${draggable ? "true" : "false"}"
    `;
  }
  return `
    data-hidden="${hidden ? "1" : "0"}"
    draggable="false"
  `;
}

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

function renderPieceBadge(pieceDef) {
  const tokenVisual = pieceDef.tokenVisual;
  if (!tokenVisual || tokenVisual.type !== "officer") {
    return "";
  }
  return `
    <div class="piece-sub officer-badge is-${tokenVisual.officerClass}" aria-hidden="true">
      <span class="officer-mark"></span>
      <span class="officer-stars">
        ${renderOfficerStars(tokenVisual.stars)}
      </span>
    </div>
  `;
}

function renderOfficerStars(stars) {
  const positions = {
    1: [[2, 1]],
    2: [
      [1, 1],
      [3, 1],
    ],
    3: [
      [1, 1],
      [3, 1],
      [2, 2],
    ],
  };

  return positions[stars]
    .map(
      ([column, row]) =>
        `<span class="officer-star" style="grid-column:${column};grid-row:${row};">★</span>`,
    )
    .join("");
}
