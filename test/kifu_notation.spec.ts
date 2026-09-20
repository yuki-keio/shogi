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
  PROMOTED_BISHOP,
  PROMOTED_PAWN,
  PROMOTED_ROOK,
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

function moveText(
  board: Board,
  player: Player,
  from: [number, number],
  to: [number, number],
  promote = false,
) {
  const f = at(from[0], from[1]);
  const t = at(to[0], to[1]);
  return notateMove(
    board,
    player,
    { type: "move", fromX: f.x, fromY: f.y, toX: t.x, toY: t.y, promote },
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

// 連盟「棋譜の表記方法」の例をそのまま並べたもの。
// https://www.shogi.or.jp/faq/kihuhyouki.html （2026-09-20 時点では 404。Internet Archive の 2026-04-02 保存分で確認）
// 🔴 決まりは「動作（上・寄・引）が先、左右はあと」。
describe("🔴 同じマスへ行ける同種の駒があるとき", () => {
  it("同じマスへ行けない同種の駒は区別に数えない", () => {
    const board = emptyBoard();
    put(board, 6, 9, GOLD, SENTE);
    put(board, 1, 9, GOLD, SENTE); // ５八には届かない
    expect(moveText(board, SENTE, [6, 9], [5, 8])).toBe("▲５八金");
  });

  describe("動作（上・寄・引）だけで区別が付くときは、左右を付けない", () => {
    it("９三の金は上、７二の金は寄（連盟の動作の例Ａ）", () => {
      const board = emptyBoard();
      put(board, 9, 3, GOLD, SENTE);
      put(board, 7, 2, GOLD, SENTE);
      expect(moveText(board, SENTE, [9, 3], [8, 2])).toBe("▲８二金上");
      expect(moveText(board, SENTE, [7, 2], [8, 2])).toBe("▲８二金寄");
    });

    it("真下から上がる手でも、動作で決まるなら「直」ではなく「上」（連盟の動作の例Ｃ）", () => {
      const board = emptyBoard();
      put(board, 5, 6, GOLD, SENTE);
      put(board, 4, 5, GOLD, SENTE);
      expect(moveText(board, SENTE, [5, 6], [5, 5])).toBe("▲５五金上");
      expect(moveText(board, SENTE, [4, 5], [5, 5])).toBe("▲５五金寄");
    });

    it("８九の銀は上、７七の銀は引（連盟の動作の例Ｄ）", () => {
      const board = emptyBoard();
      put(board, 8, 9, SILVER, SENTE);
      put(board, 7, 7, SILVER, SENTE);
      expect(moveText(board, SENTE, [8, 9], [8, 8])).toBe("▲８八銀上");
      expect(moveText(board, SENTE, [7, 7], [8, 8])).toBe("▲８八銀引");
    });

    it("🔴 振り飛車穴熊の▲３九金は「寄」（左ではない）", () => {
      const board = emptyBoard();
      put(board, 3, 8, GOLD, SENTE);
      put(board, 4, 9, GOLD, SENTE);
      expect(moveText(board, SENTE, [4, 9], [3, 9])).toBe("▲３九金寄");
      expect(moveText(board, SENTE, [3, 8], [3, 9])).toBe("▲３九金引");
    });

    it("🔴 居飛車穴熊の▲７九金は「寄」（右ではない）", () => {
      const board = emptyBoard();
      put(board, 7, 8, GOLD, SENTE);
      put(board, 6, 9, GOLD, SENTE);
      expect(moveText(board, SENTE, [6, 9], [7, 9])).toBe("▲７九金寄");
      expect(moveText(board, SENTE, [7, 8], [7, 9])).toBe("▲７九金引");
    });

    it("同じ筋の上下は「上」「引」", () => {
      const board = emptyBoard();
      put(board, 5, 7, GOLD, SENTE);
      put(board, 5, 9, GOLD, SENTE);
      expect(moveText(board, SENTE, [5, 9], [5, 8])).toBe("▲５八金上");
      expect(moveText(board, SENTE, [5, 7], [5, 8])).toBe("▲５八金引");
    });

    it("🔴 後手は「上」が下向きになる（動作の例Ａを点対称にしたもの）", () => {
      const board = emptyBoard();
      put(board, 1, 7, GOLD, GOTE);
      put(board, 3, 8, GOLD, GOTE);
      expect(moveText(board, GOTE, [1, 7], [2, 8])).toBe("△２八金上");
      expect(moveText(board, GOTE, [3, 8], [2, 8])).toBe("△２八金寄");
    });
  });

  describe("動作が同じで区別が付かないときだけ、左・右・直を使う", () => {
    it("どちらも上がるとき（６九の金は左、４九の金は右）", () => {
      const board = emptyBoard();
      put(board, 5, 9, KING, SENTE);
      put(board, 6, 9, GOLD, SENTE);
      put(board, 4, 9, GOLD, SENTE);
      expect(moveText(board, SENTE, [6, 9], [5, 8])).toBe("▲５八金左");
      expect(moveText(board, SENTE, [4, 9], [5, 8])).toBe("▲５八金右");
    });

    it("どちらも寄るとき（連盟の左右の例Ｂ）", () => {
      const board = emptyBoard();
      put(board, 3, 2, GOLD, SENTE);
      put(board, 1, 2, GOLD, SENTE);
      expect(moveText(board, SENTE, [3, 2], [2, 2])).toBe("▲２二金左");
      expect(moveText(board, SENTE, [1, 2], [2, 2])).toBe("▲２二金右");
    });

    it("どちらも引くとき（連盟の左右の例Ｃ）", () => {
      const board = emptyBoard();
      put(board, 6, 5, SILVER, SENTE);
      put(board, 4, 5, SILVER, SENTE);
      expect(moveText(board, SENTE, [6, 5], [5, 6])).toBe("▲５六銀左");
      expect(moveText(board, SENTE, [4, 5], [5, 6])).toBe("▲５六銀右");
    });

    it("真下から上がる手は「直」（連盟の左右の例Ｄ）", () => {
      const board = emptyBoard();
      put(board, 8, 9, GOLD, SENTE);
      put(board, 7, 9, GOLD, SENTE);
      expect(moveText(board, SENTE, [8, 9], [7, 8])).toBe("▲７八金左");
      expect(moveText(board, SENTE, [7, 9], [7, 8])).toBe("▲７八金直");
    });

    it("銀でも「直」（連盟の左右の例Ｅ）", () => {
      const board = emptyBoard();
      put(board, 3, 9, SILVER, SENTE);
      put(board, 2, 9, SILVER, SENTE);
      expect(moveText(board, SENTE, [3, 9], [3, 8])).toBe("▲３八銀直");
      expect(moveText(board, SENTE, [2, 9], [3, 8])).toBe("▲３八銀右");
    });

    it("🔴 後手は左右が逆になる", () => {
      const board = emptyBoard();
      put(board, 5, 1, KING, GOTE);
      put(board, 6, 1, GOLD, GOTE);
      put(board, 4, 1, GOLD, GOTE);
      expect(moveText(board, GOTE, [6, 1], [5, 2])).toBe("△５二金右");
      expect(moveText(board, GOTE, [4, 1], [5, 2])).toBe("△５二金左");
    });
  });

  describe("3枚以上あって片側だけでも足りないときは、左右と動作を重ねる", () => {
    it("3枚とも上がるが、左右だけで足りる形（連盟の3枚以上の例Ａ）", () => {
      const board = emptyBoard();
      for (const file of [6, 5, 4]) put(board, file, 3, GOLD, SENTE);
      expect(moveText(board, SENTE, [6, 3], [5, 2])).toBe("▲５二金左");
      expect(moveText(board, SENTE, [5, 3], [5, 2])).toBe("▲５二金直");
      expect(moveText(board, SENTE, [4, 3], [5, 2])).toBe("▲５二金右");
    });

    it("と金が5枚（連盟の3枚以上の例Ｂ）", () => {
      const board = emptyBoard();
      for (const [file, rank] of [[7, 9], [8, 9], [9, 9], [9, 8], [8, 7]] as const) {
        put(board, file, rank, PROMOTED_PAWN, SENTE);
      }
      expect(moveText(board, SENTE, [7, 9], [8, 8])).toBe("▲８八と右");
      expect(moveText(board, SENTE, [8, 9], [8, 8])).toBe("▲８八と直");
      expect(moveText(board, SENTE, [9, 9], [8, 8])).toBe("▲８八と左上");
      expect(moveText(board, SENTE, [9, 8], [8, 8])).toBe("▲８八と寄");
      expect(moveText(board, SENTE, [8, 7], [8, 8])).toBe("▲８八と引");
    });

    it("銀が4枚（連盟の3枚以上の例Ｃ）", () => {
      const board = emptyBoard();
      for (const [file, rank] of [[2, 9], [1, 7], [3, 9], [3, 7]] as const) {
        put(board, file, rank, SILVER, SENTE);
      }
      expect(moveText(board, SENTE, [2, 9], [2, 8])).toBe("▲２八銀直");
      expect(moveText(board, SENTE, [1, 7], [2, 8])).toBe("▲２八銀右");
      expect(moveText(board, SENTE, [3, 9], [2, 8])).toBe("▲２八銀左上");
      expect(moveText(board, SENTE, [3, 7], [2, 8])).toBe("▲２八銀左引");
    });
  });

  describe("🔴 竜と馬は「直」を使わず、左・右で書く", () => {
    it("竜も動作が先（連盟の竜の例Ｂ）", () => {
      const board = emptyBoard();
      put(board, 2, 3, PROMOTED_ROOK, SENTE);
      put(board, 5, 2, PROMOTED_ROOK, SENTE);
      expect(moveText(board, SENTE, [2, 3], [4, 3])).toBe("▲４三龍寄");
      expect(moveText(board, SENTE, [5, 2], [4, 3])).toBe("▲４三龍引");
    });

    it("同じ筋から上がる竜は「直」ではなく「右」（連盟の竜の例Ｄ）", () => {
      const board = emptyBoard();
      put(board, 9, 9, PROMOTED_ROOK, SENTE);
      put(board, 8, 9, PROMOTED_ROOK, SENTE);
      expect(moveText(board, SENTE, [9, 9], [8, 8])).toBe("▲８八龍左");
      expect(moveText(board, SENTE, [8, 9], [8, 8])).toBe("▲８八龍右");
    });

    it("同じ筋から下がる馬も「左」「右」（連盟の馬の例Ａ）", () => {
      const board = emptyBoard();
      put(board, 9, 1, PROMOTED_BISHOP, SENTE);
      put(board, 8, 1, PROMOTED_BISHOP, SENTE);
      expect(moveText(board, SENTE, [9, 1], [8, 2])).toBe("▲８二馬左");
      expect(moveText(board, SENTE, [8, 1], [8, 2])).toBe("▲８二馬右");
    });

    it("馬も動作が先（連盟の馬の例Ｂ）", () => {
      const board = emptyBoard();
      put(board, 9, 5, PROMOTED_BISHOP, SENTE);
      put(board, 6, 3, PROMOTED_BISHOP, SENTE);
      expect(moveText(board, SENTE, [9, 5], [8, 5])).toBe("▲８五馬寄");
      expect(moveText(board, SENTE, [6, 3], [8, 5])).toBe("▲８五馬引");
    });
  });
});

describe("成と重なるときの並び", () => {
  it("相対位置のあとに「成」が来る", () => {
    const board = emptyBoard();
    put(board, 6, 3, SILVER, SENTE);
    put(board, 4, 3, SILVER, SENTE);
    expect(moveText(board, SENTE, [6, 3], [5, 2], true)).toBe("▲５二銀左成");
    expect(moveText(board, SENTE, [4, 3], [5, 2], true)).toBe("▲５二銀右成");
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
