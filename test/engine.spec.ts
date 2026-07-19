// SPDX-License-Identifier: GPL-3.0-only

// These tests pin down the engine behaviour that online play depends on:
// legal moves, drops, promotion, uchifuzume, nifu, checkmate, sennichite,
// perpetual check, and USI records.

import { describe, expect, it } from "vitest";
import {
  applyMove,
  Board,
  createInitialGameState,
  GameState,
  GOTE,
  Move,
  Player,
  SENTE,
  toUsiMoveString,
} from "../src/worker/shogi_engine";

function emptyBoard(): Board {
  return Array.from({ length: 9 }, () => Array(9).fill(null));
}

function emptyHands() {
  return {
    HI: 0, KA: 0, KI: 0, GI: 0, KE: 0, KY: 0, FU: 0,
  };
}

function buildState(params: {
  pieces: Array<{ x: number; y: number; type: string; owner: Player }>;
  currentPlayer: Player;
  senteHand?: Partial<Record<string, number>>;
  goteHand?: Partial<Record<string, number>>;
  isCheck?: boolean;
}): GameState {
  const board = emptyBoard();
  for (const p of params.pieces) {
    board[p.y][p.x] = { type: p.type as never, owner: p.owner };
  }
  return {
    board,
    capturedPieces: {
      [SENTE]: { ...emptyHands(), ...(params.senteHand ?? {}) } as never,
      [GOTE]: { ...emptyHands(), ...(params.goteHand ?? {}) } as never,
    },
    currentPlayer: params.currentPlayer,
    moveCount: 0,
    lastMove: null,
    isCheck: Boolean(params.isCheck),
    positionHistory: [],
    checkHistory: [],
    turnHistory: [],
    usiMoveHistory: [],
  };
}

describe("initial position and basic moves", () => {
  it("accepts a legal pawn push and records USI", () => {
    const state = createInitialGameState();
    const move: Move = { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 };
    const result = applyMove(state, move);
    expect(result.gameOver).toBe(false);
    expect(result.state.currentPlayer).toBe(GOTE);
    expect(result.state.moveCount).toBe(1);
    expect(result.state.board[5][2]).toEqual({ type: "FU", owner: SENTE });
    expect(result.state.board[6][2]).toBeNull();
    expect(result.state.usiMoveHistory).toEqual(["7g7f"]);
  });

  it("rejects moving an opponent piece", () => {
    const state = createInitialGameState();
    expect(() =>
      applyMove(state, { type: "move", fromX: 2, fromY: 2, toX: 2, toY: 3 }),
    ).toThrow("not_your_piece");
  });

  it("rejects an illegal two-square pawn push", () => {
    const state = createInitialGameState();
    expect(() =>
      applyMove(state, { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 4 }),
    ).toThrow("illegal_move");
  });

  it("does not mutate the input state (defensive copies)", () => {
    const state = createInitialGameState();
    const before = JSON.stringify(state);
    applyMove(state, { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("promotion rules", () => {
  it("forces promotion when a pawn reaches the last rank", () => {
    const state = buildState({
      pieces: [
        { x: 0, y: 1, type: "FU", owner: SENTE },
        { x: 8, y: 8, type: "OU", owner: SENTE },
        { x: 4, y: 4, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
    });
    expect(() =>
      applyMove(state, { type: "move", fromX: 0, fromY: 1, toX: 0, toY: 0 }),
    ).toThrow("must_promote");

    const promoted = applyMove(state, {
      type: "move", fromX: 0, fromY: 1, toX: 0, toY: 0, promote: true,
    });
    expect(promoted.state.board[0][0]).toEqual({ type: "+FU", owner: SENTE });
    expect(promoted.state.usiMoveHistory).toEqual(["9b9a+"]);
  });

  it("rejects promotion outside the zone", () => {
    const state = buildState({
      pieces: [
        { x: 4, y: 6, type: "GI", owner: SENTE },
        { x: 8, y: 8, type: "OU", owner: SENTE },
        { x: 0, y: 0, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
    });
    expect(() =>
      applyMove(state, { type: "move", fromX: 4, fromY: 6, toX: 4, toY: 5, promote: true }),
    ).toThrow("promotion_not_allowed");
  });
});

describe("drop rules", () => {
  it("rejects nifu (two pawns in a column)", () => {
    const state = buildState({
      pieces: [
        { x: 2, y: 6, type: "FU", owner: SENTE },
        { x: 8, y: 8, type: "OU", owner: SENTE },
        { x: 0, y: 0, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
      senteHand: { FU: 1 },
    });
    expect(() =>
      applyMove(state, { type: "drop", pieceType: "FU", toX: 2, toY: 4 }),
    ).toThrow("nifu");
  });

  it("rejects a drop with no captured piece in hand", () => {
    const state = buildState({
      pieces: [
        { x: 8, y: 8, type: "OU", owner: SENTE },
        { x: 0, y: 0, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
    });
    expect(() =>
      applyMove(state, { type: "drop", pieceType: "KI", toX: 4, toY: 4 }),
    ).toThrow("no_captured_piece");
  });

  it("rejects uchifuzume (pawn-drop mate)", () => {
    // Gote king cornered at 9a; the dropped pawn would deliver mate:
    // lance protects the pawn, gold covers the escape squares, knight
    // protects the gold.
    const state = buildState({
      pieces: [
        { x: 0, y: 0, type: "OU", owner: GOTE },
        { x: 0, y: 2, type: "KY", owner: SENTE },
        { x: 1, y: 1, type: "KI", owner: SENTE },
        { x: 2, y: 3, type: "KE", owner: SENTE },
        { x: 4, y: 8, type: "OU", owner: SENTE },
      ],
      currentPlayer: SENTE,
      senteHand: { FU: 1 },
    });
    expect(() =>
      applyMove(state, { type: "drop", pieceType: "FU", toX: 0, toY: 1 }),
    ).toThrow("uchifuzume");
  });

  it("accepts a legal drop and records USI", () => {
    const state = buildState({
      pieces: [
        { x: 8, y: 8, type: "OU", owner: SENTE },
        { x: 0, y: 0, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
      senteHand: { KI: 1 },
    });
    const result = applyMove(state, { type: "drop", pieceType: "KI", toX: 4, toY: 4 });
    expect(result.state.board[4][4]).toEqual({ type: "KI", owner: SENTE });
    expect(result.state.capturedPieces[SENTE].KI).toBe(0);
    expect(result.state.usiMoveHistory).toEqual(["G*5e"]);
  });
});

describe("game end detection", () => {
  it("detects checkmate (dragon + gold mate)", () => {
    // Same shape as the manual-test snippet in notes.md.
    const state = buildState({
      pieces: [
        { x: 4, y: 0, type: "OU", owner: GOTE },
        { x: 4, y: 2, type: "+HI", owner: SENTE },
        { x: 3, y: 1, type: "KI", owner: SENTE },
        { x: 4, y: 8, type: "OU", owner: SENTE },
      ],
      currentPlayer: SENTE,
    });
    const result = applyMove(state, {
      type: "move", fromX: 3, fromY: 1, toX: 4, toY: 1,
    });
    expect(result.gameOver).toBe(true);
    expect(result.winner).toBe(SENTE);
    expect(result.resultReason).toBe("checkmate");
  });

  it("detects sennichite (repetition draw)", () => {
    let state = createInitialGameState();
    const cycle: Move[] = [
      { type: "move", fromX: 4, fromY: 8, toX: 4, toY: 7 }, // sente king up
      { type: "move", fromX: 4, fromY: 0, toX: 4, toY: 1 }, // gote king down
      { type: "move", fromX: 4, fromY: 7, toX: 4, toY: 8 }, // sente king back
      { type: "move", fromX: 4, fromY: 1, toX: 4, toY: 0 }, // gote king back
    ];
    let ended: ReturnType<typeof applyMove> | null = null;
    outer: for (let i = 0; i < 4; i++) {
      for (const move of cycle) {
        const result = applyMove(state, move);
        state = result.state;
        if (result.gameOver) {
          ended = result;
          break outer;
        }
      }
    }
    expect(ended).not.toBeNull();
    expect(ended!.state.moveCount).toBe(12);
    expect(ended!.winner).toBe("draw");
    expect(ended!.resultReason).toBe("sennichite");
  });

  it("detects perpetual check (checking side loses)", () => {
    // Sente rook checks forever; gote king shuffles 5a <-> 6a.
    // The first pushed position is the checked one, so the repetition
    // counter reaches it first (same behaviour as the frontend engine).
    let state = buildState({
      pieces: [
        { x: 4, y: 0, type: "OU", owner: GOTE },
        { x: 3, y: 3, type: "HI", owner: SENTE },
        { x: 8, y: 8, type: "OU", owner: SENTE },
      ],
      currentPlayer: SENTE,
    });
    const cycle: Move[] = [
      { type: "move", fromX: 3, fromY: 3, toX: 4, toY: 3 }, // sente rook checks
      { type: "move", fromX: 4, fromY: 0, toX: 3, toY: 0 }, // gote king evades
      { type: "move", fromX: 4, fromY: 3, toX: 3, toY: 3 }, // sente rook checks again
      { type: "move", fromX: 3, fromY: 0, toX: 4, toY: 0 }, // gote king back
    ];
    let ended: ReturnType<typeof applyMove> | null = null;
    outer: for (let i = 0; i < 5; i++) {
      for (const move of cycle) {
        const result = applyMove(state, move);
        state = result.state;
        if (result.gameOver) {
          ended = result;
          break outer;
        }
      }
    }
    expect(ended).not.toBeNull();
    expect(ended!.resultReason).toBe("perpetual_check");
    expect(ended!.winner).toBe(GOTE);
  });

  it("rejects a move that leaves the king in check", () => {
    // Sente king pinned against a gote rook: moving the blocking gold
    // sideways would expose the king.
    const state = buildState({
      pieces: [
        { x: 4, y: 8, type: "OU", owner: SENTE },
        { x: 4, y: 5, type: "KI", owner: SENTE },
        { x: 4, y: 1, type: "HI", owner: GOTE },
        { x: 0, y: 0, type: "OU", owner: GOTE },
      ],
      currentPlayer: SENTE,
    });
    expect(() =>
      applyMove(state, { type: "move", fromX: 4, fromY: 5, toX: 3, toY: 5 }),
    ).toThrow("illegal_move");
  });
});

describe("USI replay (full game fragment)", () => {
  it("replays a real opening sequence with identical results", () => {
    // 7g7f 3c3d 8h2b+ (bishop trade opening) — promoted bishop capture.
    let state = createInitialGameState();
    state = applyMove(state, { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 }).state;
    state = applyMove(state, { type: "move", fromX: 6, fromY: 2, toX: 6, toY: 3 }).state;
    const capture = applyMove(state, {
      type: "move", fromX: 1, fromY: 7, toX: 7, toY: 1, promote: true,
    });
    state = capture.state;
    expect(state.usiMoveHistory).toEqual(["7g7f", "3c3d", "8h2b+"]);
    expect(state.board[1][7]).toEqual({ type: "+KA", owner: SENTE });
    expect(state.capturedPieces[SENTE].KA).toBe(1);
    expect(capture.gameOver).toBe(false);

    // Gote recaptures with the silver.
    const recapture = applyMove(state, {
      type: "move", fromX: 6, fromY: 0, toX: 7, toY: 1,
    });
    expect(recapture.state.capturedPieces[GOTE].KA).toBe(1);
    expect(recapture.state.usiMoveHistory[3]).toBe("3a2b");
  });
});

describe("USI notation", () => {
  it("converts coordinates and drops", () => {
    expect(toUsiMoveString({ type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 })).toBe("7g7f");
    expect(toUsiMoveString({ type: "move", fromX: 1, fromY: 7, toX: 7, toY: 1, promote: true })).toBe("8h2b+");
    expect(toUsiMoveString({ type: "drop", pieceType: "FU", toX: 4, toY: 4 })).toBe("P*5e");
  });
});
