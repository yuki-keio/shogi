// SPDX-License-Identifier: GPL-3.0-only

// 棋譜の表記。設計書 §7 / §14
// 🔴 同じマスへ行ける同種の駒があるときの 右/左/直/上/寄/引 がいちばん大事。
//    ここが無いと一覧に同じ表記が並んで読めなくなる。

import { describe, expect, it } from "vitest";
import { buildNotation, notateMove } from "../src/kifu/notation";
import {
  GOLD,
  GOTE,
  KING,
  SENTE,
  SILVER,
  type Board,
  type Piece,
  type PieceType,
  type Player,
} from "../src/worker/shogi_engine";

const GAME = [
  "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e", "8h7g", "4a3b",
  "7i8h", "2b7g+", "8h7g", "3a2b",
];

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

function moveText(board: Board, player: Player, from: [number, number], to: [number, number]) {
  const f = at(from[0], from[1]);
  const t = at(to[0], to[1]);
  return notateMove(
    board,
    player,
    { type: "move", fromX: f.x, fromY: f.y, toX: t.x, toY: t.y, promote: false },
    null,
  ).text;
}

describe("基本の表記", () => {
  const entries = buildNotation(GAME);

  it("先手は▲、後手は△、筋は全角数字・段は漢数字", () => {
    expect(entries[0].text).toBe("▲７六歩");
    expect(entries[1].text).toBe("△８四歩");
    expect(entries[2].text).toBe("▲７八金");
  });

  it("成る手は「成」", () => {
    expect(entries[9].text).toBe("△７七角成");
  });

  it("直前と同じマスなら「同」＋全角スペース", () => {
    expect(entries[10].text).toBe("▲同　銀");
  });

  it("KIF用は移動元を括弧で書く（曖昧さ解消は付けない）", () => {
    expect(entries[0].kif).toBe("７六歩(77)");
    expect(entries[9].kif).toBe("７七角成(22)");
    expect(entries[10].kif).toBe("同　銀(88)");
  });

  it("手数と手番が交互に並ぶ", () => {
    expect(entries[0].ply).toBe(1);
    expect(entries[0].player).toBe(SENTE);
    expect(entries[1].player).toBe(GOTE);
    expect(entries.length).toBe(GAME.length);
  });
});

describe("駒打ち", () => {
  it("「打」を付ける", () => {
    const board = emptyBoard();
    const t = at(5, 5);
    const { text, kif } = notateMove(
      board,
      SENTE,
      { type: "drop", pieceType: "FU", toX: t.x, toY: t.y },
      null,
    );
    expect(text).toBe("▲５五歩打");
    expect(kif).toBe("５五歩打");
  });
});

describe("成れるのに成らなかったときは「不成」", () => {
  it("敵陣に入る銀が成らなければ不成", () => {
    const board = emptyBoard();
    put(board, 5, 4, SILVER, SENTE);
    expect(moveText(board, SENTE, [5, 4], [5, 3])).toBe("▲５三銀不成");
  });

  it("敵陣に関わらない手には付けない", () => {
    const board = emptyBoard();
    put(board, 5, 6, SILVER, SENTE);
    expect(moveText(board, SENTE, [5, 6], [5, 5])).toBe("▲５五銀");
  });
});

describe("🔴 同じマスへ行ける同種の駒があるとき", () => {
  it("左右で区別する（６九の金は左、４九の金は右）", () => {
    const board = emptyBoard();
    put(board, 5, 9, KING, SENTE);
    put(board, 6, 9, GOLD, SENTE);
    put(board, 4, 9, GOLD, SENTE);
    expect(moveText(board, SENTE, [6, 9], [5, 8])).toBe("▲５八金左");
    expect(moveText(board, SENTE, [4, 9], [5, 8])).toBe("▲５八金右");
  });

  it("後手は左右が逆になる", () => {
    const board = emptyBoard();
    put(board, 5, 1, KING, GOTE);
    put(board, 6, 1, GOLD, GOTE);
    put(board, 4, 1, GOLD, GOTE);
    expect(moveText(board, GOTE, [6, 1], [5, 2])).toBe("△５二金右");
    expect(moveText(board, GOTE, [4, 1], [5, 2])).toBe("△５二金左");
  });

  it("真下から上がる手は「直」", () => {
    const board = emptyBoard();
    put(board, 5, 9, GOLD, SENTE);
    put(board, 6, 8, GOLD, SENTE);
    expect(moveText(board, SENTE, [5, 9], [5, 8])).toBe("▲５八金直");
    expect(moveText(board, SENTE, [6, 8], [5, 8])).toBe("▲５八金左");
  });

  it("同じ筋の上下は「上」「引」", () => {
    const board = emptyBoard();
    put(board, 5, 7, GOLD, SENTE);
    put(board, 5, 9, GOLD, SENTE);
    expect(moveText(board, SENTE, [5, 9], [5, 8])).toBe("▲５八金上");
    expect(moveText(board, SENTE, [5, 7], [5, 8])).toBe("▲５八金引");
  });

  it("同じマスへ行けない同種の駒は区別に数えない", () => {
    const board = emptyBoard();
    put(board, 6, 9, GOLD, SENTE);
    put(board, 1, 9, GOLD, SENTE); // ５八には届かない
    expect(moveText(board, SENTE, [6, 9], [5, 8])).toBe("▲５八金");
  });
});

describe("読めない手が混ざったとき", () => {
  it("そこまでの表記を返して落ちない", () => {
    const entries = buildNotation(["7g7f", "8c8d", "9i9a"]);
    expect(entries.length).toBe(2);
  });
});

describe("表記も続きから作れる", () => {
  it("前回の表記を渡しても、作り直したのと同じになる", () => {
    const previous = buildNotation(GAME.slice(0, 6));
    const continued = buildNotation(GAME, undefined, previous);
    expect(continued).toEqual(buildNotation(GAME));
  });

  it("🔴 途中が違う手順なら使い回さない（「同」の付き方が変わるため）", () => {
    const previous = buildNotation(GAME);
    const branched = GAME.slice(0, 4).concat(["2g2f", "8d8e"]);
    expect(buildNotation(branched, undefined, previous)).toEqual(buildNotation(branched));
  });
});
