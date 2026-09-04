// SPDX-License-Identifier: GPL-3.0-only

// 手筋・囲い・戦法の名前を出す機能。
// 🔴 いちばん大事なのは嘘をつかないこと。成立する形より、成立しない形のテストを厚くする。

import { describe, expect, it } from "vitest";
import {
  BISHOP,
  GOLD,
  GOTE,
  KING,
  KNIGHT,
  LANCE,
  PAWN,
  PROMOTED_PAWN,
  ROOK,
  SENTE,
  SILVER,
  applyMove,
  type BasePieceType,
  type Board,
  type CapturedPieces,
  type GameState,
  type Move,
  type Piece,
  type PieceType,
  type Player,
} from "../src/worker/shogi_engine";
import { replayUsiMoves, type ReplayState } from "../src/kifu/replay";
import { see, seeCapture, survivesOnSquare } from "../src/waza/see";
import { completedCastle, matchedCastles } from "../src/waza/castle";
import { detectStrategy } from "../src/waza/strategy";
import { detectWaza, scanWaza, summarizeWaza } from "../src/waza/index";
import { WAZA_NAMES } from "../src/waza/names";

/** '5八' のような表記から盤の座標へ。x=0 が９筋、y=0 が一段目 */
function at(file: number, rank: number) {
  return { x: 9 - file, y: rank - 1 };
}

function emptyBoard(): Board {
  return Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
}

function put(board: Board, file: number, rank: number, type: PieceType, owner: Player) {
  const { x, y } = at(file, rank);
  board[y][x] = { type, owner };
}

function emptyHand() {
  return { HI: 0, KA: 0, KI: 0, GI: 0, KE: 0, KY: 0, FU: 0 };
}

function hands(sente: Partial<Record<BasePieceType, number>> = {}): CapturedPieces {
  return {
    [SENTE]: { ...emptyHand(), ...sente },
    [GOTE]: { ...emptyHand() },
  };
}

type Placement = [number, number, PieceType, Player];

function buildState(
  pieces: Placement[],
  currentPlayer: Player,
  captured: CapturedPieces = hands(),
): GameState {
  const board = emptyBoard();
  for (const [file, rank, type, owner] of pieces) put(board, file, rank, type, owner);
  return {
    board,
    capturedPieces: captured,
    currentPlayer,
    moveCount: 0,
    lastMove: null,
    isCheck: false,
    positionHistory: [],
    checkHistory: [],
    turnHistory: [],
    usiMoveHistory: [],
  };
}

function toReplayState(state: GameState): ReplayState {
  return {
    board: state.board,
    capturedPieces: state.capturedPieces,
    currentPlayer: state.currentPlayer,
    lastMove: state.lastMove,
    moveCount: state.moveCount,
    gameOver: false,
    isCheck: state.isCheck,
  };
}

/** 局面を組んで1手指し、その手の名前を返す */
function nameOf(
  pieces: Placement[],
  player: Player,
  move: Move,
  captured: CapturedPieces = hands(),
): string | null {
  const state = buildState(pieces, player, captured);
  const before = toReplayState(state);
  const result = applyMove(state, move);
  const after = toReplayState(result.state);
  const hit = detectWaza({ before, after, move, ply: 1 });
  return hit ? hit.id : null;
}

function drop(pieceType: BasePieceType, file: number, rank: number): Move {
  const { x, y } = at(file, rank);
  return { type: "drop", pieceType, toX: x, toY: y };
}

function step(from: [number, number], to: [number, number], promote = false): Move {
  const f = at(from[0], from[1]);
  const t = at(to[0], to[1]);
  return { type: "move", fromX: f.x, fromY: f.y, toX: t.x, toY: t.y, promote };
}

// ---------------------------------------------------------------------------

describe("取り合い計算", () => {
  it("守りの無い駒はただで取れる", () => {
    const board = emptyBoard();
    put(board, 5, 5, SILVER, GOTE);
    put(board, 5, 6, GOLD, SENTE);
    const f = at(5, 6);
    const t = at(5, 5);
    expect(seeCapture(board, f.x, f.y, t.x, t.y)).toBe(1000);
  });

  it("取り返される交換は符号が合う（金で銀を取って金で取り返される＝損）", () => {
    const board = emptyBoard();
    put(board, 5, 5, SILVER, GOTE);
    put(board, 5, 6, GOLD, SENTE);
    put(board, 5, 4, GOLD, GOTE);
    const f = at(5, 6);
    const t = at(5, 5);
    expect(seeCapture(board, f.x, f.y, t.x, t.y)).toBe(1000 - 1200);
  });

  it("🔴 と金を銀で取って歩で取り返されると損（持ち駒の価値を分けているか）", () => {
    const board = emptyBoard();
    put(board, 5, 5, PROMOTED_PAWN, GOTE);
    put(board, 5, 6, SILVER, SENTE);
    put(board, 5, 4, PAWN, GOTE);
    const f = at(5, 6);
    const t = at(5, 5);
    // と金を取っても手に入るのは歩。750 - 1000
    expect(seeCapture(board, f.x, f.y, t.x, t.y)).toBe(750 - 1000);
  });

  it("歩でと金を取るのは得", () => {
    const board = emptyBoard();
    put(board, 5, 5, PROMOTED_PAWN, GOTE);
    put(board, 5, 6, PAWN, SENTE);
    put(board, 5, 4, GOLD, GOTE);
    const f = at(5, 6);
    const t = at(5, 5);
    expect(seeCapture(board, f.x, f.y, t.x, t.y)).toBe(750 - 200);
  });

  it("香の後ろの香が数に入る（後ろ抜け）", () => {
    const withBack = emptyBoard();
    put(withBack, 1, 5, SILVER, GOTE);
    put(withBack, 1, 7, LANCE, SENTE);
    put(withBack, 1, 8, LANCE, SENTE);
    put(withBack, 1, 4, GOLD, GOTE);
    const f = at(1, 7);
    const t = at(1, 5);
    // 金で取り返すと後ろの香に取られるので、後手は取り返さない＝銀のただ取り
    expect(seeCapture(withBack, f.x, f.y, t.x, t.y)).toBe(1000);

    const withoutBack = emptyBoard();
    put(withoutBack, 1, 5, SILVER, GOTE);
    put(withoutBack, 1, 7, LANCE, SENTE);
    put(withoutBack, 1, 4, GOLD, GOTE);
    expect(seeCapture(withoutBack, f.x, f.y, t.x, t.y)).toBe(1000 - 800);
  });

  it("玉では取り返せない（相手の利きが残っているとき）", () => {
    const board = emptyBoard();
    put(board, 5, 5, PAWN, GOTE);
    put(board, 5, 6, KING, SENTE);
    put(board, 4, 4, SILVER, GOTE);
    const { x, y } = at(5, 5);
    expect(see(board, x, y, SENTE)).toBe(0);
  });

  it("攻め手が無いマスは 0", () => {
    const board = emptyBoard();
    put(board, 5, 5, ROOK, GOTE);
    const { x, y } = at(5, 5);
    expect(see(board, x, y, SENTE)).toBe(0);
  });

  it("門1: 単に取られる駒は残らない", () => {
    const board = emptyBoard();
    put(board, 5, 5, SILVER, SENTE);
    put(board, 5, 4, PAWN, GOTE);
    const { x, y } = at(5, 5);
    expect(survivesOnSquare(board, x, y)).toBe(false);
  });

  it("門1: 紐が付いていれば残る", () => {
    const board = emptyBoard();
    put(board, 5, 5, SILVER, SENTE);
    put(board, 4, 4, SILVER, GOTE);
    put(board, 5, 6, GOLD, SENTE);
    const { x, y } = at(5, 5);
    expect(survivesOnSquare(board, x, y)).toBe(true);
  });

  it("門2: 桂で守られた金は取っても損", () => {
    const board = emptyBoard();
    put(board, 5, 5, GOLD, GOTE);
    put(board, 4, 3, KNIGHT, GOTE);
    put(board, 5, 9, ROOK, SENTE);
    const f = at(5, 9);
    const t = at(5, 5);
    expect(seeCapture(board, f.x, f.y, t.x, t.y)).toBe(1200 - 1800);
  });
});

// ---------------------------------------------------------------------------

describe("手筋", () => {
  it("割り打ちの銀", () => {
    const pieces: Placement[] = [
      [8, 2, ROOK, GOTE],
      [6, 2, GOLD, GOTE],
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 7, 1), hands({ GI: 1 }))).toBe("wariuchi_no_gin");
  });

  it("割り打ちの銀: 打った銀が単に取られるなら出さない", () => {
    const pieces: Placement[] = [
      [8, 2, ROOK, GOTE],
      [6, 2, GOLD, GOTE],
      [7, 2, GOLD, GOTE], // 7一に利いている
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 7, 1), hands({ GI: 1 }))).toBeNull();
  });

  it("割り打ちの銀: 当たっているのが歩2枚なら出さない", () => {
    const pieces: Placement[] = [
      [8, 2, PAWN, GOTE],
      [6, 2, PAWN, GOTE],
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 7, 1), hands({ GI: 1 }))).toBeNull();
  });

  it("ふんどしの桂", () => {
    const pieces: Placement[] = [
      [6, 3, GOLD, GOTE],
      [4, 3, ROOK, GOTE],
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(KNIGHT, 5, 5), hands({ KE: 1 }))).toBe("fundoshi_no_kei");
  });

  it("ふんどしの桂: 歩で取られる桂は出さない", () => {
    const pieces: Placement[] = [
      [6, 3, GOLD, GOTE],
      [4, 3, ROOK, GOTE],
      [5, 4, PAWN, GOTE], // 5五に利いている
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(KNIGHT, 5, 5), hands({ KE: 1 }))).toBeNull();
  });

  it("王手飛車", () => {
    const pieces: Placement[] = [
      [8, 2, KING, GOTE],
      [2, 2, ROOK, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(BISHOP, 5, 5), hands({ KA: 1 }))).toBe("oute_bisha");
  });

  it("王手飛車: 打った角が歩でただ取りされるなら出さない", () => {
    const pieces: Placement[] = [
      [8, 2, KING, GOTE],
      [2, 2, ROOK, GOTE],
      [5, 4, PAWN, GOTE], // 5五に利いている
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(BISHOP, 5, 5), hands({ KA: 1 }))).toBeNull();
  });

  it("十字飛車", () => {
    const pieces: Placement[] = [
      [5, 2, GOLD, GOTE],
      [2, 5, SILVER, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(ROOK, 5, 5), hands({ HI: 1 }))).toBe("juji_bisha");
  });

  it("十字飛車: 縦にしか当たっていないなら出さない", () => {
    const pieces: Placement[] = [
      [5, 2, GOLD, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(ROOK, 5, 5), hands({ HI: 1 }))).toBeNull();
  });

  it("十字飛車: 片方が守られていて取れないなら出さない", () => {
    const pieces: Placement[] = [
      [5, 2, GOLD, GOTE],
      [2, 5, SILVER, GOTE],
      [2, 4, GOLD, GOTE], // 銀に紐が付いているので、飛車で取ると損
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(ROOK, 5, 5), hands({ HI: 1 }))).toBeNull();
  });

  it("田楽刺し", () => {
    const pieces: Placement[] = [
      [5, 5, GOLD, GOTE],
      [5, 4, ROOK, GOTE],
      [9, 1, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(LANCE, 5, 7), hands({ KY: 1 }))).toBe("dengaku_zashi");
  });

  it("田楽刺し: 飛車では出さない（香だけ）", () => {
    const pieces: Placement[] = [
      [5, 5, GOLD, GOTE],
      [5, 4, ROOK, GOTE],
      [9, 1, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(ROOK, 5, 7), hands({ HI: 1 }))).not.toBe("dengaku_zashi");
  });

  it("田楽刺し: 手前がただの歩なら出さない（横に逃げられないので串刺しにならない）", () => {
    const pieces: Placement[] = [
      [5, 5, PAWN, GOTE],
      [5, 4, ROOK, GOTE],
      [9, 1, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(LANCE, 5, 7), hands({ KY: 1 }))).toBeNull();
  });

  it("田楽刺し: 手前がと金なら出す（成った駒は横へ逃げられる）", () => {
    const pieces: Placement[] = [
      [5, 5, PROMOTED_PAWN, GOTE],
      [5, 4, ROOK, GOTE],
      [9, 1, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(LANCE, 5, 7), hands({ KY: 1 }))).toBe("dengaku_zashi");
  });

  it("田楽刺し: 奥が玉ならピンなので出さない", () => {
    const pieces: Placement[] = [
      [5, 5, GOLD, GOTE],
      [5, 4, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(LANCE, 5, 7), hands({ KY: 1 }))).toBeNull();
  });

  it("垂れ歩", () => {
    const pieces: Placement[] = [
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBe("tarefu");
  });

  it("垂れ歩: 成るマスが金に守られていたら出さない", () => {
    const pieces: Placement[] = [
      [4, 2, GOLD, GOTE], // 5三を守っている
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBeNull();
  });

  it("たたきの歩", () => {
    const pieces: Placement[] = [
      [5, 3, SILVER, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBe("tataki_no_fu");
  });

  it("たたきの歩: 標的が歩なら出さない", () => {
    const pieces: Placement[] = [
      [5, 3, PAWN, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBeNull();
  });

  it("たたきの歩: 標的は金・銀だけ（自己対局で出過ぎたので絞ってある）", () => {
    const pieces: Placement[] = [
      [5, 3, ROOK, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBeNull();
  });

  it("と金作り", () => {
    const pieces: Placement[] = [
      [5, 4, PAWN, SENTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([5, 4], [5, 3], true))).toBe("tokin_zukuri");
  });

  it("と金作り: できたと金がすぐ取られるなら出さない", () => {
    const pieces: Placement[] = [
      [5, 4, PAWN, SENTE],
      [4, 2, GOLD, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([5, 4], [5, 3], true))).toBeNull();
  });

  it("頭金", () => {
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [5, 9, ROOK, SENTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(GOLD, 5, 2), hands({ KI: 1 }))).toBe("atama_kin");
  });

  it("頭金: 詰んでいなければ出さない", () => {
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(GOLD, 5, 2), hands({ KI: 1 }))).toBeNull();
  });
});

describe("名前の優先順位", () => {
  it("玉と飛の両取りをかけた桂は「ふんどしの桂」ではなく「王手飛車」", () => {
    const pieces: Placement[] = [
      [6, 3, KING, GOTE],
      [4, 3, ROOK, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(KNIGHT, 5, 5), hands({ KE: 1 }))).toBe("oute_bisha");
  });

  it("進む先に駒がある歩打ちは「垂れ歩」ではなく「たたきの歩」", () => {
    const pieces: Placement[] = [
      [5, 3, GOLD, GOTE],
      [9, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 4), hands({ FU: 1 }))).toBe("tataki_no_fu");
  });
});

// ---------------------------------------------------------------------------

describe("囲い", () => {
  function mino(): Board {
    const board = emptyBoard();
    put(board, 2, 8, KING, SENTE);
    put(board, 3, 8, SILVER, SENTE);
    put(board, 4, 9, GOLD, SENTE);
    return board;
  }

  it("片美濃・本美濃・高美濃・銀冠がそれぞれ成立する", () => {
    expect(matchedCastles(mino(), SENTE)).toContain("kata_mino");

    const hon = mino();
    put(hon, 5, 8, GOLD, SENTE);
    expect(matchedCastles(hon, SENTE)).toContain("hon_mino");

    const taka = mino();
    put(taka, 4, 7, GOLD, SENTE);
    expect(matchedCastles(taka, SENTE)).toContain("taka_mino");

    const kanmuri = emptyBoard();
    put(kanmuri, 2, 8, KING, SENTE);
    put(kanmuri, 2, 7, SILVER, SENTE);
    put(kanmuri, 3, 8, GOLD, SENTE);
    expect(matchedCastles(kanmuri, SENTE)).toContain("gin_kanmuri");
  });

  it("舟囲い・矢倉・カニ囲い・金無双・穴熊2種", () => {
    const fune = emptyBoard();
    put(fune, 7, 8, KING, SENTE);
    put(fune, 7, 9, SILVER, SENTE);
    put(fune, 6, 9, GOLD, SENTE);
    put(fune, 5, 8, GOLD, SENTE);
    expect(matchedCastles(fune, SENTE)).toContain("fune_gakoi");

    const yagura = emptyBoard();
    put(yagura, 8, 8, KING, SENTE);
    put(yagura, 7, 8, GOLD, SENTE);
    put(yagura, 6, 7, GOLD, SENTE);
    put(yagura, 7, 7, SILVER, SENTE);
    expect(matchedCastles(yagura, SENTE)).toContain("yagura");

    const kani = emptyBoard();
    put(kani, 6, 9, KING, SENTE);
    put(kani, 7, 8, GOLD, SENTE);
    put(kani, 6, 8, SILVER, SENTE);
    put(kani, 5, 8, GOLD, SENTE);
    expect(matchedCastles(kani, SENTE)).toContain("kani_gakoi");

    const muso = emptyBoard();
    put(muso, 3, 8, KING, SENTE);
    put(muso, 4, 8, GOLD, SENTE);
    put(muso, 5, 8, GOLD, SENTE);
    put(muso, 2, 8, SILVER, SENTE);
    expect(matchedCastles(muso, SENTE)).toContain("kin_muso");

    const ibisha = emptyBoard();
    put(ibisha, 9, 9, KING, SENTE);
    put(ibisha, 8, 8, SILVER, SENTE);
    put(ibisha, 7, 9, GOLD, SENTE);
    expect(matchedCastles(ibisha, SENTE)).toContain("ibisha_anaguma");

    const furibisha = emptyBoard();
    put(furibisha, 1, 9, KING, SENTE);
    put(furibisha, 2, 8, SILVER, SENTE);
    put(furibisha, 3, 9, GOLD, SENTE);
    expect(matchedCastles(furibisha, SENTE)).toContain("furibisha_anaguma");
  });

  it("🔴 後手は盤を180度回した位置で同じ名前になる", () => {
    const board = emptyBoard();
    // 先手の本美濃を (8-x, 8-y) に写す ＝ 8二玉・7二銀・6一金・5二金
    put(board, 8, 2, KING, GOTE);
    put(board, 7, 2, SILVER, GOTE);
    put(board, 6, 1, GOLD, GOTE);
    put(board, 5, 2, GOLD, GOTE);
    expect(matchedCastles(board, GOTE)).toContain("hon_mino");
    expect(matchedCastles(board, SENTE)).toEqual([]);
  });

  it("🔴 育つ関係: 1手ずつ、正しい順に1つだけ出る", () => {
    const half = emptyBoard();
    put(half, 2, 8, KING, SENTE);
    put(half, 3, 8, SILVER, SENTE);
    const kata = mino();
    expect(completedCastle(half, kata, SENTE)).toBe("kata_mino");

    const hon = mino();
    put(hon, 5, 8, GOLD, SENTE);
    expect(completedCastle(kata, hon, SENTE)).toBe("hon_mino");

    const taka = mino();
    put(taka, 4, 7, GOLD, SENTE);
    expect(completedCastle(hon, taka, SENTE)).toBe("taka_mino");

    const kanmuri = emptyBoard();
    put(kanmuri, 2, 8, KING, SENTE);
    put(kanmuri, 2, 7, SILVER, SENTE);
    put(kanmuri, 3, 8, GOLD, SENTE);
    put(kanmuri, 4, 7, GOLD, SENTE);
    expect(completedCastle(taka, kanmuri, SENTE)).toBe("gin_kanmuri");
  });

  it("同じ形のままなら何度でも出したりしない", () => {
    expect(completedCastle(mino(), mino(), SENTE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("戦法", () => {
  function rookTo(file: number, player: Player = SENTE): string | null {
    const from: [number, number] = player === SENTE ? [2, 8] : [8, 2];
    const rank = player === SENTE ? 8 : 2;
    const pieces: Placement[] = [
      [from[0], from[1], ROOK, player],
      [5, 9, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    const state = buildState(pieces, player);
    const move = step(from, [file, rank]);
    const before = toReplayState(state);
    const after = toReplayState(applyMove(state, move).state);
    const hit = detectStrategy({ before, after, move, ply: 3 });
    return hit ? hit.id : null;
  }

  it("🔴 飛車の筋が入れ替わっていない", () => {
    expect(rookTo(5)).toBe("naka_bisha");
    expect(rookTo(6)).toBe("shiken_bisha");
    expect(rookTo(7)).toBe("sanken_bisha");
    expect(rookTo(8)).toBe("mukai_bisha");
  });

  it("後手も同じ名前になる", () => {
    expect(rookTo(4, GOTE)).toBe("shiken_bisha");
    expect(rookTo(5, GOTE)).toBe("naka_bisha");
  });

  it("棒銀は飛車先の銀。早繰り銀・腰掛け銀では出ない", () => {
    function silverTo(
      from: [number, number],
      to: [number, number],
      rookFile = 2,
    ): string | null {
      const pieces: Placement[] = [
        [rookFile, 8, ROOK, SENTE],
        [from[0], from[1], SILVER, SENTE],
        [5, 9, KING, SENTE],
        [5, 1, KING, GOTE],
      ];
      const state = buildState(pieces, SENTE);
      const move = step(from, to);
      const before = toReplayState(state);
      const after = toReplayState(applyMove(state, move).state);
      const hit = detectStrategy({ before, after, move, ply: 11 });
      return hit ? hit.id : null;
    }
    expect(silverTo([2, 7], [2, 6])).toBe("bogin");
    expect(silverTo([2, 6], [2, 5])).toBe("bogin");
    expect(silverTo([3, 7], [3, 6])).toBeNull(); // 早繰り銀
    expect(silverTo([5, 7], [5, 6])).toBeNull(); // 腰掛け銀
    // 🔴 振り飛車の自然な駒組みを棒銀と呼ばない（飛車が初期の筋にいるときだけ）
    expect(silverTo([5, 7], [5, 6], 5)).toBeNull(); // 中飛車の5六銀
    expect(silverTo([6, 7], [6, 6], 6)).toBeNull(); // 四間飛車の6六銀
  });

  it("飛車を五段目へ寄せただけでは戦法にしない", () => {
    const pieces: Placement[] = [
      [2, 5, ROOK, SENTE],
      [5, 9, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    const state = buildState(pieces, SENTE);
    const move = step([2, 5], [5, 5]);
    const before = toReplayState(state);
    const after = toReplayState(applyMove(state, move).state);
    expect(detectStrategy({ before, after, move, ply: 41 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("棋譜まるごと", () => {
  const OPENING = [
    "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e",
    "8h7g", "4a3b", "7i8h", "2b7g+",
  ];

  it("🔴 序盤の駒組みで手筋が1つも出ない", () => {
    const replay = replayUsiMoves(OPENING);
    expect(replay.ok).toBe(true);
    const scan = scanWaza(OPENING, replay);
    expect(scan.hits.filter((h) => h.kind === "tesuji")).toEqual([]);
  });

  it("🔴 続きから走らせても、頭から走らせたのと同じになる", () => {
    const replay = replayUsiMoves(OPENING);
    const half = OPENING.slice(0, 6);
    const first = scanWaza(half, replayUsiMoves(half));
    const continued = scanWaza(OPENING, replay, first);
    const fromScratch = scanWaza(OPENING, replay);
    expect(continued.hits).toEqual(fromScratch.hits);
  });

  it("枝分かれしたら使い回さない", () => {
    const branch = [...OPENING.slice(0, 4), "2g2f", "1c1d"];
    const previous = scanWaza(OPENING, replayUsiMoves(OPENING));
    const scan = scanWaza(branch, replayUsiMoves(branch), previous);
    expect(scan.usiMoves).toEqual(branch);
    expect(scan.hits.every((h) => h.ply <= branch.length)).toBe(true);
  });

  it("🔴 四間飛車から美濃が育つ手順を、実際の指し手で追える", () => {
    const moves = [
      "7g7f", "3c3d",
      "2h6h", "4c4d", // ▲6八飛（四間飛車）
      "5i4h", "5c5d",
      "4h3h", "6c6d",
      "3h2h", "7c7d",
      "3i3h", "8c8d", // ▲3八銀（片美濃囲い）
      "6i5h", "9c9d", // ▲5八金左（本美濃囲い）
      "4g4f", "1c1d", // ▲4六歩（金の道をあける）
      "5h4g", "2c2d", // ▲4七金（高美濃囲い）
      "2g2f", "9d9e", // ▲2六歩（銀の道をあける）
      "3h2g", "1d1e", // ▲2七銀（形が崩れるので、ここでは何も出ない）
      "4i3h", // ▲3八金（銀冠）
    ];
    const replay = replayUsiMoves(moves);
    expect(replay.ok).toBe(true);
    const scan = scanWaza(moves, replay);
    const mine = scan.hits.filter((h) => h.player === SENTE).map((h) => h.id);
    expect(mine).toEqual([
      "shiken_bisha",
      "kata_mino",
      "hon_mino",
      "taka_mino",
      "gin_kanmuri",
    ]);
    // 名前は最後に完成した1つだけが棋譜バーに残る
    expect(scan.byPly.get(11)?.id).toBe("kata_mino");
    expect(scan.byPly.get(23)?.id).toBe("gin_kanmuri");
  });

  it("まとめは自分の側だけを数える", () => {
    const replay = replayUsiMoves(OPENING);
    const scan = scanWaza(OPENING, replay);
    const all = summarizeWaza(scan, [SENTE, GOTE]);
    const senteOnly = summarizeWaza(scan, [SENTE]);
    expect(senteOnly.length).toBeLessThanOrEqual(all.length);
    for (const entry of senteOnly) expect(entry.count).toBeGreaterThan(0);
  });
});

describe("名前の表", () => {
  it("棋譜バーに出す名前はすべて6文字以内", () => {
    for (const [id, entry] of Object.entries(WAZA_NAMES)) {
      expect(entry.name.length, id).toBeLessThanOrEqual(6);
      expect(entry.sub.length, id).toBeGreaterThan(0);
    }
  });
});
