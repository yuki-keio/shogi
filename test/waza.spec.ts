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
  PROMOTED_BISHOP,
  PROMOTED_KNIGHT,
  PROMOTED_PAWN,
  PROMOTED_ROOK,
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
import { detectStrategy, strategyStands } from "../src/waza/strategy";
import { detectWaza, keptWaza, scanWaza, summarizeWaza, wazaHitAt } from "../src/waza/index";
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

/** 局面を組んで1手指し、その手に付く名前（札に要る中身ごと）を返す */
function hitOf(
  pieces: Placement[],
  player: Player,
  move: Move,
  captured: CapturedPieces = hands(),
) {
  const state = buildState(pieces, player, captured);
  const before = toReplayState(state);
  const after = toReplayState(applyMove(state, move).state);
  return detectWaza({ before, after, move, ply: 1 });
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

  it("🔴 門1: と金と金が同時に利くなら、先に使うのは「と金」（攻め手の順序）", () => {
    const board = emptyBoard();
    put(board, 5, 5, KNIGHT, SENTE); // 先手が打った桂
    put(board, 5, 4, PROMOTED_PAWN, GOTE); // と金（取られても後手が失うのは 750）
    put(board, 4, 4, GOLD, GOTE); // 金（取られると 1200 の損）
    put(board, 5, 6, PAWN, SENTE); // 取り返す歩
    const { x, y } = at(5, 5);
    // と金→歩→金 の順で後手が 250 得する。盤上の価値（金600 < と金650）で並べると
    // 金から使ってしまい 0（＝桂が残る）と誤判定する。
    expect(see(board, x, y, GOTE)).toBe(250);
    expect(survivesOnSquare(board, x, y)).toBe(false);
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

  it("腹金", () => {
    const pieces: Placement[] = [
      [1, 2, KING, GOTE],
      [1, 1, LANCE, GOTE],
      [1, 4, PAWN, SENTE],
      [3, 4, KNIGHT, SENTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(GOLD, 2, 2), hands({ KI: 1 }))).toBe("hara_kin");
  });

  it("腹金: 詰んでいなければ出さない", () => {
    // 1四の歩が無いと、玉は1三へ逃げられる
    const pieces: Placement[] = [
      [1, 2, KING, GOTE],
      [1, 1, LANCE, GOTE],
      [3, 4, KNIGHT, SENTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(GOLD, 2, 2), hands({ KI: 1 }))).toBeNull();
  });

  it("🔴 腹金: 盤上の金を寄せて詰ませた手は出さない（出典はどれも打つ形）", () => {
    const pieces: Placement[] = [
      [1, 2, KING, GOTE],
      [1, 1, LANCE, GOTE],
      [1, 4, PAWN, SENTE],
      [3, 4, KNIGHT, SENTE],
      [3, 3, GOLD, SENTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([3, 3], [2, 2]))).toBeNull();
  });

  it("開き王手: 動かした駒の後ろの駒で王手。札の先頭は王手をかけた駒、線はそこから玉へ", () => {
    // 5五の角が8二の飛車を取ると、後ろの5八の飛車の通り道が開いて王手になる
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [8, 2, ROOK, GOTE],
      [5, 5, BISHOP, SENTE],
      [5, 8, ROOK, SENTE],
      [1, 9, KING, SENTE],
    ];
    const hit = hitOf(pieces, SENTE, step([5, 5], [8, 2], true));
    expect(hit?.id).toBe("aki_oute");
    expect(hit?.squares).toEqual([at(5, 8), at(5, 1)]);
  });

  it("🔴 開き王手: 動かした駒そのものの王手なら出さない", () => {
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [5, 3, GOLD, SENTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([5, 3], [5, 2]))).toBeNull();
  });

  it("両王手: 動かした駒と後ろの駒の2枚で王手。2枚目からも線を引く", () => {
    // 5三の金が4二の金を取って王手、同時に後ろの5五の飛車の王手も通る（詰み）
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [4, 2, GOLD, GOTE],
      [6, 2, SILVER, GOTE],
      [5, 3, GOLD, SENTE],
      [4, 3, PAWN, SENTE],
      [7, 3, KNIGHT, SENTE],
      [5, 5, ROOK, SENTE],
      [1, 9, KING, SENTE],
    ];
    const hit = hitOf(pieces, SENTE, step([5, 3], [4, 2]));
    expect(hit?.id).toBe("ryo_oute");
    expect(hit?.tier).toBe("big");
    expect(hit?.squares).toEqual([at(4, 2), at(5, 1)]);
    expect(hit?.alsoFrom).toEqual([at(5, 5)]);
  });

  it("底歩（金底の歩）: 金の真下に打って、竜の横の通り道を止める", () => {
    const pieces: Placement[] = [
      [8, 9, PROMOTED_ROOK, GOTE],
      [7, 8, GOLD, SENTE],
      [4, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 7, 9), hands({ FU: 1 }))).toBe("sokofu");
  });

  it("底歩: 竜の横からの王手を、いちばん下の段の歩で止める合駒も底歩", () => {
    // 1九の竜が6九の玉に王手。5九に歩を打つ（竜で取れば玉で取り返せる）
    const pieces: Placement[] = [
      [1, 9, PROMOTED_ROOK, GOTE],
      [6, 9, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 5, 9), hands({ FU: 1 }))).toBe("sokofu");
  });

  it("🔴 底歩: 同じ段に相手の飛車・竜がいなければ出さない", () => {
    const pieces: Placement[] = [
      [7, 8, GOLD, SENTE],
      [4, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 7, 9), hands({ FU: 1 }))).toBeNull();
  });

  it("🔴 底歩: 飛車・竜との間にほかの駒がいて、もともと通り道が止まっていれば出さない", () => {
    // 9九の竜の横の通り道は、8九の銀がすでに止めている
    const pieces: Placement[] = [
      [9, 9, PROMOTED_ROOK, GOTE],
      [8, 9, SILVER, GOTE],
      [7, 8, GOLD, SENTE],
      [5, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 7, 9), hands({ FU: 1 }))).toBeNull();
  });

  it("🔴 底歩: 竜にただで取られる歩は出さない", () => {
    // 金が離れていて、竜で歩を取っても誰も取り返せない
    const pieces: Placement[] = [
      [8, 9, PROMOTED_ROOK, GOTE],
      [4, 9, GOLD, SENTE],
      [4, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 7, 9), hands({ FU: 1 }))).toBeNull();
  });

  it("🔴 底歩: どの駒で取っても得にならないかを1枚ずつ見る（馬なら取り返せても、竜ならただ）", () => {
    // 4九の歩は2九の竜にも5八の馬にも取られる。馬で取れば6七の角が取り返すが、竜で取れば取り返せない
    const pieces: Placement[] = [
      [2, 9, PROMOTED_ROOK, GOTE],
      [5, 8, PROMOTED_BISHOP, GOTE],
      [6, 7, BISHOP, SENTE],
      [6, 9, GOLD, SENTE],
      [8, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(PAWN, 4, 9), hands({ FU: 1 }))).toBeNull();
  });

  it("桂頭の銀: 打ち込まれた桂の頭に銀を打つ", () => {
    const pieces: Placement[] = [
      [2, 4, KNIGHT, GOTE],
      [2, 3, PAWN, GOTE],
      [2, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    const hit = hitOf(pieces, SENTE, drop(SILVER, 2, 5), hands({ GI: 1 }));
    expect(hit?.id).toBe("keito_no_gin");
    expect(hit?.squares).toEqual([at(2, 5), at(2, 4)]);
  });

  it("桂頭の銀: 盤上の銀を動かして、跳ねてきた桂の頭に置く手も含む", () => {
    // 先手の4五の桂に、後手が3三の銀を4四へ上げて受ける
    const pieces: Placement[] = [
      [4, 5, KNIGHT, SENTE],
      [3, 3, SILVER, GOTE],
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, GOTE, step([3, 3], [4, 4]))).toBe("keito_no_gin");
  });

  it("🔴 桂頭の銀: 持ち主の陣の中にいる桂の前へ打ち込む手は出さない（攻めの手）", () => {
    const pieces: Placement[] = [
      [2, 1, KNIGHT, GOTE],
      [5, 1, KING, GOTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 2, 2), hands({ GI: 1 }))).toBeNull();
  });

  it("🔴 桂頭の銀: 成桂の前なら出さない（成桂は金の動きで前へ出られる）", () => {
    const pieces: Placement[] = [
      [2, 4, PROMOTED_KNIGHT, GOTE],
      [2, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 2, 5), hands({ GI: 1 }))).toBeNull();
  });

  it("🔴 桂頭の銀: 置いた銀がほかの駒にただで取られるなら出さない", () => {
    const pieces: Placement[] = [
      [2, 4, KNIGHT, GOTE],
      [3, 4, GOLD, GOTE],
      [2, 8, KING, SENTE],
      [5, 1, KING, GOTE],
    ];
    expect(nameOf(pieces, SENTE, drop(SILVER, 2, 5), hands({ GI: 1 }))).toBeNull();
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

  it("2枚で王手しながら飛車にも当てた手は「王手飛車」ではなく「両王手」", () => {
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [4, 2, GOLD, GOTE],
      [3, 1, ROOK, GOTE],
      [5, 3, GOLD, SENTE],
      [4, 3, PAWN, SENTE],
      [5, 5, ROOK, SENTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([5, 3], [4, 2]))).toBe("ryo_oute");
  });

  it("後ろの駒で王手しながら、動かした駒が飛車に当たる手は「開き王手」ではなく「王手飛車」", () => {
    // 5五の角が7三へ動いて8二の飛車に当たり、後ろの5八の飛車で王手（6二の銀で角の王手は止まっている）
    const pieces: Placement[] = [
      [5, 1, KING, GOTE],
      [6, 2, SILVER, GOTE],
      [8, 2, ROOK, GOTE],
      [5, 5, BISHOP, SENTE],
      [5, 8, ROOK, SENTE],
      [1, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([5, 5], [7, 3]))).toBe("oute_bisha");
  });

  it("詰ませる金打ちが飛車にも当たっていれば「王手飛車」ではなく「腹金」", () => {
    // 2二の金は1二の玉に王手しながら3一の飛車に当たる。1四の歩が玉の逃げ道を押さえて詰み
    const pieces: Placement[] = [
      [1, 2, KING, GOTE],
      [1, 1, LANCE, GOTE],
      [3, 1, ROOK, GOTE],
      [1, 4, PAWN, SENTE],
      [3, 4, KNIGHT, SENTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, drop(GOLD, 2, 2), hands({ KI: 1 }))).toBe("hara_kin");
    // 1四の歩が無ければ詰まないので、王手飛車
    const escapable = pieces.filter(([file, rank]) => !(file === 1 && rank === 4));
    expect(nameOf(escapable, SENTE, drop(GOLD, 2, 2), hands({ KI: 1 }))).toBe("oute_bisha");
  });

  it("後ろの駒で王手しながら、動かした飛車が2枚に当たる手は「開き王手」ではなく「十字飛車」", () => {
    // 3三の飛車が3五へ動くと、後ろの5五の角の通り道が開いて1一の玉に王手。飛車は1五の金と3八の金に当たる
    const pieces: Placement[] = [
      [1, 1, KING, GOTE],
      [1, 5, GOLD, GOTE],
      [3, 8, GOLD, GOTE],
      [3, 3, ROOK, SENTE],
      [5, 5, BISHOP, SENTE],
      [5, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([3, 3], [3, 5]))).toBe("juji_bisha");
  });

  it("歩を成って後ろの角の王手を通した手は「と金作り」ではなく「開き王手」", () => {
    const pieces: Placement[] = [
      [1, 2, KING, GOTE],
      [3, 4, PAWN, SENTE],
      [5, 6, BISHOP, SENTE],
      [9, 9, KING, SENTE],
    ];
    expect(nameOf(pieces, SENTE, step([3, 4], [3, 3], true))).toBe("aki_oute");
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


  it("雁木囲い: 昔からの形（銀6七・5七）とツノ銀雁木（銀6七・4七）。玉6九は外せない", () => {
    function gangi(rightSilver: [number, number], king: [number, number]): Board {
      const board = emptyBoard();
      put(board, king[0], king[1], KING, SENTE);
      put(board, 7, 8, GOLD, SENTE);
      put(board, 5, 8, GOLD, SENTE);
      put(board, 6, 7, SILVER, SENTE);
      put(board, rightSilver[0], rightSilver[1], SILVER, SENTE);
      return board;
    }
    expect(matchedCastles(gangi([5, 7], [6, 9]), SENTE)).toContain("gangi");
    expect(matchedCastles(gangi([4, 7], [6, 9]), SENTE)).toContain("gangi");
    // 🔴 玉を囲っていない（5九のまま）・右へ囲った形は雁木にしない
    expect(matchedCastles(gangi([5, 7], [5, 9]), SENTE)).not.toContain("gangi");
    expect(matchedCastles(gangi([5, 7], [4, 8]), SENTE)).not.toContain("gangi");
  });

  it("左美濃: 玉8八・銀7八・金6九。玉を一段上の8七に置く天守閣美濃も左美濃", () => {
    function hidari(king: [number, number]): Board {
      const board = emptyBoard();
      put(board, king[0], king[1], KING, SENTE);
      put(board, 7, 8, SILVER, SENTE);
      put(board, 6, 9, GOLD, SENTE);
      return board;
    }
    expect(matchedCastles(hidari([8, 8]), SENTE)).toContain("hidari_mino");
    expect(matchedCastles(hidari([8, 7]), SENTE)).toContain("hidari_mino");
    // 相居飛車で使う玉7九の形は、出典で呼び名が割れるので左美濃にしない
    expect(matchedCastles(hidari([7, 9]), SENTE)).not.toContain("hidari_mino");
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

  describe("右四間飛車", () => {
    function held(
      sente: Partial<Record<BasePieceType, number>>,
      gote: Partial<Record<BasePieceType, number>> = {},
    ): CapturedPieces {
      return { [SENTE]: { ...emptyHand(), ...sente }, [GOTE]: { ...emptyHand(), ...gote } };
    }
    function rookMove(
      from: [number, number],
      to: [number, number],
      captured: CapturedPieces = hands(),
      player: Player = SENTE,
    ): string | null {
      const pieces: Placement[] = [
        [from[0], from[1], ROOK, player],
        [5, 9, KING, SENTE],
        [5, 1, KING, GOTE],
      ];
      const state = buildState(pieces, player, captured);
      const move = step(from, to);
      const before = toReplayState(state);
      const after = toReplayState(applyMove(state, move).state);
      const hit = detectStrategy({ before, after, move, ply: 21 });
      return hit ? hit.id : null;
    }

    it("最初の筋の飛車を、右から4番目の筋へ回したとき", () => {
      expect(rookMove([2, 8], [4, 8])).toBe("migi_shiken_bisha");
      expect(rookMove([8, 2], [6, 2], hands(), GOTE)).toBe("migi_shiken_bisha");
      // 飛車を一段引いてから回す形も右四間飛車
      expect(rookMove([2, 9], [4, 9])).toBe("migi_shiken_bisha");
    });

    it("角換わりと、歩の突き捨て1回くらいまでは序盤とみなす", () => {
      expect(rookMove([2, 8], [4, 8], held({ KA: 1 }, { KA: 1 }))).toBe("migi_shiken_bisha");
      expect(rookMove([2, 8], [4, 8], held({ FU: 1 }, { FU: 1 }))).toBe("migi_shiken_bisha");
    });

    it("🔴 駒の取り合いが進んだ後に飛車を回した手は、逃げや受けの手かもしれないので出さない", () => {
      expect(rookMove([2, 8], [4, 8], held({ FU: 2 }))).toBeNull();
      expect(rookMove([2, 8], [4, 8], held({ GI: 1 }))).toBeNull();
      expect(rookMove([2, 8], [4, 8], held({}, { KI: 1 }))).toBeNull();
      expect(rookMove([2, 8], [4, 8], held({ KA: 2 }))).toBeNull();
      // 後手が回すときも、両者の持ち駒を見る
      expect(rookMove([8, 2], [6, 2], held({}, { FU: 2 }), GOTE)).toBeNull();
      expect(rookMove([8, 2], [6, 2], held({ GI: 1 }), GOTE)).toBeNull();
    });

    it("🔴 振り飛車から戻した飛車と、自陣の外で回した飛車は右四間飛車にしない", () => {
      expect(rookMove([6, 8], [4, 8])).toBeNull();
      expect(rookMove([2, 6], [4, 6])).toBeNull();
    });
  });


  describe("角換わり", () => {
    // ▲7六歩 △8四歩 ▲2六歩 △8五歩 ▲7七角 △3四歩 ▲8八銀 △3二金 ▲7八金 △7七角成 ▲同銀
    const KAKU = ["7g7f", "8c8d", "2g2f", "8d8e", "8h7g", "3c3d", "7i8h", "4a3b", "6i7h", "2b7g+", "8h7g"];

    function scanOf(moves: string[]) {
      const replay = replayUsiMoves(moves);
      expect(replay.ok).toBe(true);
      return scanWaza(moves, replay);
    }

    it("交換が済んだ手で、取り返した側にも、先に角を取った側にも出す", () => {
      const scan = scanOf(KAKU);
      expect(scan.hits.map((h) => [h.id, h.player, h.ply])).toEqual([
        ["kakugawari", SENTE, 11],
        ["kakugawari", GOTE, 11],
      ]);
      // 後手の札は、先手が取り返した手（11手目）で出る。角を取った10手目には出さない
      expect(wazaHitAt(scan, 11, [GOTE])?.id).toBe("kakugawari");
      expect(wazaHitAt(scan, 10, [GOTE])).toBeNull();
      // 見る側の分だけを拾う（札・棋譜の行に出る名前の持ち主が、見ている人と一致する）
      expect(wazaHitAt(scan, 11, [SENTE])?.player).toBe(SENTE);
      expect(wazaHitAt(scan, 11, [GOTE])?.player).toBe(GOTE);
      // 盤の上に光らせるマスは無い（交換した後は盤に角がいない）
      expect(scan.hits[0].squares).toEqual([]);
      expect(summarizeWaza(scan, [GOTE]).map((e) => e.id)).toEqual(["kakugawari"]);
    });

    it("🔴 すぐの角交換（まだ飛車の前の歩を突いていない）では出さない。角交換振り飛車と見分けられないため", () => {
      expect(scanOf(["7g7f", "3c3d", "8h2b+", "3a2b"]).hits).toEqual([]);
      // ダイレクト向かい飛車：交換の後に後手が飛車を振る
      const direct = scanOf(["7g7f", "3c3d", "2g2f", "2b8h+", "7i8h", "8b2b"]);
      expect(direct.hits.map((h) => h.id)).toEqual(["mukai_bisha"]);
    });

    it("🔴 先に飛車を振っていれば出さない", () => {
      // ▲7八飛（三間飛車）の後に角を交換
      const scan = scanOf(["7g7f", "8c8d", "2g2f", "8d8e", "8h7g", "3c3d", "2h7h", "2b7g+", "8i7g"]);
      expect(scan.hits.map((h) => h.id)).toEqual(["sanken_bisha"]);
    });

    it("🔴 先に歩を取り合っていれば出さない（相掛かり・横歩取りの角交換）", () => {
      const scan = scanOf([
        "2g2f", "8c8d", "2f2e", "8d8e", "6i7h", "4a3b", "2e2d", "2c2d", "2h2d", "P*2c",
        "2d2f", "3c3d", "7g7f", "8e8f", "8g8f", "8b8f", "P*8g", "8f8d", "8h2b+", "3a2b",
      ]);
      expect(scan.hits.map((h) => h.id)).not.toContain("kakugawari");
    });

    it("🔴 30手目より後の角交換は、戦いが始まってからの交換なので出さない", () => {
      // 端歩や玉の移動で20手ほど指してから、同じ出だしで角を交換する（交換が済むのは31手目）
      const waiting = [
        "1g1f", "1c1d", "9g9f", "9c9d", "5i6h", "5a4b", "6h5i", "4b5a", "5i6h", "5a4b",
        "6h5i", "4b5a", "5i6h", "5a4b", "6h5i", "4b5a", "5i6h", "5a4b", "6h5i", "4b5a",
      ];
      const scan = scanOf([...waiting, ...KAKU]);
      expect(waiting.length + KAKU.length).toBe(31);
      expect(scan.hits.map((h) => h.id)).not.toContain("kakugawari");
      // 同じ待ち手でも、交換が30手目までに済めば出る
      const early = scanOf([...waiting.slice(0, 18), ...KAKU]);
      expect(early.hits.map((h) => h.id)).toContain("kakugawari");
    });

    it("棋譜の行には、先に角を取った側にも、次に自分で指した後も出したまま", () => {
      const scan = scanOf([...KAKU, "3a4b"]);
      expect(keptWaza(scan, 11, [SENTE])?.id).toBe("kakugawari");
      expect(keptWaza(scan, 12, [GOTE])?.id).toBe("kakugawari");
    });

    it("棋譜の行には、飛車が最初の筋にいるあいだ出したまま", () => {
      const scan = scanOf(KAKU);
      const hit = scan.hits[0];
      const board = replayUsiMoves(KAKU).states[11].board;
      expect(strategyStands(board, hit)).toBe(true);
      // 飛車を2八から動かすと崩れたとみなす
      const moved = board.map((row) => row.slice());
      moved[7][6] = moved[7][7];
      moved[7][7] = null;
      expect(strategyStands(moved, hit)).toBe(false);
    });
  });

  describe("石田流", () => {
    it("三間飛車の飛車を、2つ伸ばした歩のすぐ後ろへ上げた手（日本将棋連盟のコラムの手順）", () => {
      // ▲7六歩 △3四歩 ▲7五歩 △4二玉 ▲6六歩 △8四歩 ▲7八飛 △8五歩 ▲7六飛
      const moves = ["7g7f", "3c3d", "7f7e", "5a4b", "6g6f", "8c8d", "2h7h", "8d8e", "7h7f"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.map((h) => [h.id, h.ply])).toEqual([["sanken_bisha", 7], ["ishida_ryu", 9]]);
      // ふつうの名前は指した側だけに付く。相手の側から引くと何も無い
      expect(wazaHitAt(scan, 9, [SENTE])?.id).toBe("ishida_ryu");
      expect(wazaHitAt(scan, 9, [GOTE])).toBeNull();
    });

    it("🔴 7五の歩がいなくなった後に7六へ上げた飛車は石田流にしない", () => {
      // 7五の歩を突き捨てて△同歩と取らせてから、▲7六飛
      const moves = ["7g7f", "3c3d", "7f7e", "8c8d", "2h7h", "8d8e", "7e7d", "7c7d", "7h7f"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.map((h) => h.id)).toEqual(["sanken_bisha"]);
    });

    it("後手も同じ（△3五歩・△3四飛）", () => {
      const moves = ["7g7f", "3c3d", "2g2f", "3d3e", "2f2e", "8b3b", "3i4h", "3b3d"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.filter((h) => h.player === GOTE).map((h) => [h.id, h.ply])).toEqual([["sanken_bisha", 6], ["ishida_ryu", 8]]);
    });

    it("🔴 横から回ってきた飛車は石田流にしない（中盤に2筋から7六へ回した手など）", () => {
      const moves = ["7g7f", "3c3d", "7f7e", "8c8d", "2g2f", "8d8e", "2f2e", "4a3b", "2h2f", "8e8f", "2f7f"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.map((h) => h.id)).not.toContain("ishida_ryu");
    });
  });

  describe("嬉野流", () => {
    it("初手▲6八銀・3手目▲7九角", () => {
      const moves = ["7i6h", "3c3d", "8h7i"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.map((h) => [h.id, h.ply])).toEqual([["ureshino_ryu", 3]]);
    });

    it("後手は△4二銀・△3一角", () => {
      const moves = ["7g7f", "3a4b", "2g2f", "2b3a"];
      const scan = scanWaza(moves, replayUsiMoves(moves));
      expect(scan.hits.map((h) => [h.id, h.player])).toEqual([["ureshino_ryu", GOTE]]);
    });

    it("🔴 銀を6八ではなく7八へ上げてからの▲7九角は出さない", () => {
      const moves = ["7i7h", "3c3d", "8h7i"];
      expect(scanWaza(moves, replayUsiMoves(moves)).hits).toEqual([]);
    });

    it("🔴 角の通り道の歩を突いた後の▲7九角（矢倉の角の引き方）と、4手目以降の▲7九角は出さない", () => {
      const opened = ["7g7f", "3c3d", "7i6h", "8c8d", "8h7i"];
      expect(scanWaza(opened, replayUsiMoves(opened)).hits).toEqual([]);
      const late = ["7i6h", "3c3d", "5g5f", "8c8d", "6i7h", "8d8e", "8h7i"];
      expect(scanWaza(late, replayUsiMoves(late)).hits).toEqual([]);
    });

    it("棋譜の行には、引いた角が7九にいるあいだ出したまま", () => {
      const moves = ["7i6h", "3c3d", "8h7i"];
      const replay = replayUsiMoves(moves);
      const hit = scanWaza(moves, replay).hits[0];
      const board = replay.states[3].board;
      expect(strategyStands(board, hit)).toBe(true);
      const moved = board.map((row) => row.slice());
      moved[5][4] = moved[8][2]; // 角を5六へ
      moved[8][2] = null;
      expect(strategyStands(moved, hit)).toBe(false);
    });
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
    expect(wazaHitAt(scan, 11, [SENTE])?.id).toBe("kata_mino");
    expect(wazaHitAt(scan, 23, [SENTE])?.id).toBe("gin_kanmuri");
  });


  it("雁木囲いは、カニ囲いを通って組み上がる（日本将棋連盟のコラムの組み方）", () => {
    // ▲7六歩 ▲6六歩 ▲6八銀 ▲5六歩 ▲4八銀 ▲7八金 ▲6九玉 ▲5八金 ▲6七銀 ▲5七銀（後手は端歩などで待つ）
    const moves = [
      "7g7f", "1c1d", "6g6f", "9c9d", "7i6h", "1d1e", "5g5f", "9d9e", "3i4h", "4a3b",
      "6i7h", "6a5b", "5i6i", "7a6b", "4i5h", "3a4b", "6h6g", "5a4a", "4h5g",
    ];
    const replay = replayUsiMoves(moves);
    expect(replay.ok).toBe(true);
    const mine = scanWaza(moves, replay).hits.filter((h) => h.player === SENTE).map((h) => [h.id, h.ply]);
    expect(mine).toEqual([["kani_gakoi", 15], ["gangi", 19]]);
  });

  it("左美濃（天守閣美濃）は、舟囲いを通って組み上がる（日本将棋連盟のコラムの組み方）", () => {
    // ▲7六歩 ▲2六歩 ▲4八銀 ▲5六歩 ▲6八玉 ▲7八玉 ▲5八金右 ▲9六歩 ▲5七銀 ▲8六歩 ▲8七玉 ▲7八銀
    const moves = [
      "7g7f", "3c3d", "2g2f", "8c8d", "3i4h", "4a3b", "5g5f", "1c1d", "5i6h", "6a5b",
      "6h7h", "7a6b", "4i5h", "5a4a", "9g9f", "9c9d", "4h5g", "3a4b", "8g8f", "1d1e",
      "7h8g", "7c7d", "7i7h",
    ];
    const replay = replayUsiMoves(moves);
    expect(replay.ok).toBe(true);
    const mine = scanWaza(moves, replay).hits.filter((h) => h.player === SENTE).map((h) => [h.id, h.ply]);
    expect(mine).toEqual([["fune_gakoi", 13], ["hidari_mino", 23]]);
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

describe("棋譜バーに出し続ける名前", () => {
  // 四間飛車 → 片美濃 → 本美濃 → 高美濃 → 銀冠（23手目）
  const MINO = [
    "7g7f", "3c3d", "2h6h", "4c4d", "5i4h", "5c5d", "4h3h", "6c6d", "3h2h", "7c7d",
    "3i3h", "8c8d", "6i5h", "9c9d", "4g4f", "1c1d", "5h4g", "2c2d", "2g2f", "9d9e",
    "3h2g", "1d1e", "4i3h",
  ];

  function keptIds(moves: string[], plies: number[]) {
    const replay = replayUsiMoves(moves);
    expect(replay.ok).toBe(true);
    const scan = scanWaza(moves, replay);
    return plies.map((ply) => keptWaza(scan, ply, [SENTE])?.id ?? null);
  }

  it("🔴 高美濃から銀冠へ組み替える途中（▲2七銀で形が崩れる）も、名前を出したまま", () => {
    expect(keptIds(MINO, [20, 21, 22, 23])).toEqual([
      "taka_mino", "taka_mino", "taka_mino", "gin_kanmuri",
    ]);
  });

  it("玉が一時的に逃げても、すぐ戻れば出したまま", () => {
    const moves = [...MINO, "4a4b", "2h1h", "6a6b", "1h2h"]; // ▲1八玉 → ▲2八玉
    expect(keptIds(moves, [24, 25, 26, 27])).toEqual([
      "gin_kanmuri", "gin_kanmuri", "gin_kanmuri", "gin_kanmuri",
    ]);
  });

  it("🔴 崩れたまま自分が2手指したら消える。古い名前（四間飛車）には戻さず、形が戻れば、また出す", () => {
    const moves = [
      ...MINO,
      "4a4b", "2h1h", // ▲1八玉（崩れる。この手は数えない）
      "6a6b", "5g5f", // 1手目
      "7a7b", "5f5e", // 2手目 → 消える
      "3a3b", "1h2h", // ▲2八玉（戻る）
    ];
    expect(keptIds(moves, [25, 27, 28, 29, 30, 31])).toEqual([
      "gin_kanmuri", "gin_kanmuri", "gin_kanmuri", null, null, "gin_kanmuri",
    ]);
  });

  const BOGIN = [
    "2g2f", "3c3d", "2f2e", "8c8d", "3i3h", "8d8e", "3h2g", "4a3b",
    "2g2f", "7a6b", // ▲2六銀（棒銀）
  ];

  it("棒銀は銀を引いたら崩れたとみなす", () => {
    const moves = [
      ...BOGIN,
      "3g3f", "6a5b",
      "2f3g", "5a4b", // ▲3七銀（引く）
      "9g9f", "6c6d",
      "9f9e",
    ];
    const replay = replayUsiMoves(moves);
    expect(wazaHitAt(scanWaza(moves, replay), 9, [SENTE])?.id).toBe("bogin");
    expect(keptIds(moves, [11, 13, 15, 17])).toEqual(["bogin", "bogin", "bogin", null]);
  });

  it("🔴 相手の手で崩されたときも、そのあと自分が2手指したら消える", () => {
    const moves = [
      ...BOGIN,
      "2f1e", "6a5b", "2e2d", "2c2d", "1e2d", "5a4b",
      "2d2c+", "3b2c", // ▲2三銀成 △同金（相手に取られて崩れる）
      "9g9f", "6c6d", // 1手目
      "9f9e", // 2手目 → 消える
    ];
    expect(keptIds(moves, [17, 18, 20, 21])).toEqual(["bogin", "bogin", "bogin", null]);
  });

  it("棒銀の銀が端（1五銀）へ回っても棒銀のまま", () => {
    const moves = [...BOGIN, "2f1e", "6a5b", "9g9f", "5a4b", "9f9e"];
    expect(keptIds(moves, [11, 13, 15])).toEqual(["bogin", "bogin", "bogin"]);
  });

  it("振り飛車は飛車がその筋を離れたら崩れたとみなす", () => {
    const moves = [
      "7g7f", "3c3d",
      "2h6h", "8c8d", // ▲6八飛（四間飛車）
      "6h2h", "8d8e", // ▲2八飛（戻す）
      "9g9f", "4a3b",
      "9f9e",
    ];
    expect(keptIds(moves, [3, 5, 7, 9])).toEqual([
      "shiken_bisha", "shiken_bisha", "shiken_bisha", null,
    ]);
  });

  it("🔴 両方の名前を出すとき（将棋盤・共有棋譜）も、新しいほうが消えたら古いほうには戻さない", () => {
    const moves = [
      "7g7f", "3c3d",
      "2h6h", "8b4b", // ▲四間飛車 △四間飛車（後手のほうが新しい）
      "9g9f", "4b8b", // △8二飛（戻す）
      "9f9e", "1c1d", // 後手の1手目
      "1g1f", "1d1e", // 後手の2手目 → 後手の名前が消える
    ];
    const replay = replayUsiMoves(moves);
    expect(replay.ok).toBe(true);
    const scan = scanWaza(moves, replay);
    const both = (ply: number) => keptWaza(scan, ply, [SENTE, GOTE]);
    expect(both(4)?.player).toBe(GOTE);
    expect(both(8)?.player).toBe(GOTE);
    expect(both(10)).toBeNull();
    // 先手だけを出すなら、先手の四間飛車はまだ残っている
    expect(keptWaza(scan, 10, [SENTE])?.id).toBe("shiken_bisha");
  });

  const LONG = [...MINO, "4a4b", "2h1h", "6a6b", "5g5f", "7a7b", "5f5e", "3a3b", "1h2h"];

  it("🔴 続きから走らせても、頭から走らせたのと同じになる", () => {
    const head = LONG.slice(0, 26);
    const first = scanWaza(head, replayUsiMoves(head));
    const replay = replayUsiMoves(LONG);
    expect(scanWaza(LONG, replay, first).kept).toEqual(scanWaza(LONG, replay).kept);
  });

  it("🔴 枝分かれしたら、分かれた先の状態を持ち越さない", () => {
    const previous = scanWaza(LONG, replayUsiMoves(LONG));
    const branch = [...LONG.slice(0, 26), "1h2h"];
    const replay = replayUsiMoves(branch);
    const scan = scanWaza(branch, replay, previous);
    expect(scan.kept).toEqual(scanWaza(branch, replay).kept);
    expect(scan.kept).toHaveLength(branch.length + 1);
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
