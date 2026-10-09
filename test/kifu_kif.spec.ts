// SPDX-License-Identifier: GPL-3.0-only

// KIF の書き出し・読み込みと、形式の自動判定。設計書 §8 §9 / §14
// KI2・CSA は理由を出して断る。黙って失敗しないこと。

import { describe, expect, it } from "vitest";
import {
  describeParsed,
  detectKifuFormat,
  formatKif,
  formatUsi,
  initialPositionSfen,
  parseKifuText,
} from "../src/kifu/kif";
import { HANDICAPS, normalizeInitialPosition } from "../src/shared/initial_position";
import { replayUsiMoves } from "../src/kifu/replay";
import { createInitialGameState, type Board } from "../src/worker/shogi_engine";

const GAME = [
  "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e", "8h7g", "4a3b",
  "7i8h", "2b7g+", "8h7g", "3a2b", "3i3h", "7a7b", "3h2g", "6c6d",
  "2g3f", "7b6c", "4i4h", "5a4b", "5i6h", "7c7d", "3f4e", "8e8f",
  "8g8f", "8b8f",
];

// 駒打ちを含む短い手順（打を往復できるか見る）
const WITH_DROP = ["7g7f", "3c3d", "8h2b+", "3a2b", "B*5e"];

const DIAGRAM_NAMES: Record<string, string> = { OU: "玉", HI: "飛", KA: "角", KI: "金", GI: "銀", KE: "桂", KY: "香", FU: "歩" };

/** 他のアプリが書き出す、開始局面の盤面図つきのKIF */
function kifWithDiagram(board: Board, turn: "先手番" | "後手番" | "上手番", move: string): string {
  return [
    "手合割：その他",
    "後手の持駒：なし",
    "  ９ ８ ７ ６ ５ ４ ３ ２ １",
    "+---------------------------+",
    ...board.map((row, y) => "|" + row.map((piece) => !piece ? " ・"
      : `${piece.owner === "gote" ? "v" : " "}${DIAGRAM_NAMES[piece.type]}`).join("") + "|" + "一二三四五六七八九"[y]),
    "+---------------------------+",
    "先手の持駒：なし",
    turn,
    "手数----指手---------消費時間--",
    move,
  ].join("\n");
}

describe("KIF の往復", () => {
  it("全駒落ちをKIF・USIで往復して同じ局面へ戻す", () => {
    for (const entry of HANDICAPS) {
      const initial = normalizeInitialPosition({ handicap: entry.id });
      const moves = initial.firstPlayer === "sente" ? ["7g7f", "3c3d"] : ["3c3d", "7g7f"];
      for (const text of [formatKif(moves, { initialPosition: initial }), formatUsi(moves, initial)]) {
        const parsed = parseKifuText(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.initialPosition).toEqual(initial);
        expect(parsed.moves).toEqual(moves);
        expect(replayUsiMoves(parsed.moves, undefined, parsed.initialPosition).state)
          .toEqual(replayUsiMoves(moves, undefined, initial).state);
      }
    }
  });

  it("一般的な後手駒落ちは手合割と上手・下手で書き出す", () => {
    const initial = normalizeInitialPosition({ handicap: "six" });
    const text = formatKif(["3c3d", "7g7f"], { initialPosition: initial, senteName: "下手役", goteName: "上手役" });
    expect(text).toContain("手合割：六枚落ち\r\n下手：下手役\r\n上手：上手役");
    expect(text).not.toContain("|v");
    const parsed = parseKifuText(text);
    expect(parsed).toMatchObject({ ok: true, senteName: "下手役", goteName: "上手役", initialPosition: initial });
  });

  it("上手の手番から始まる駒落ちの盤面図は、その駒落ちとして読む", () => {
    const initial = normalizeInitialPosition({ handicap: "rook" });
    for (const turn of ["後手番", "上手番"] as const) {
      const text = kifWithDiagram(createInitialGameState(initial).board, turn, "1 ３四歩(33)");
      expect(parseKifuText(text)).toMatchObject({ ok: true, initialPosition: initial, moves: ["3c3d"] });
    }
  });

  it("将棋の決まりと違う開始局面（先手が駒を減らす・平手を後手から）は読み込まない", () => {
    const hirate = createInitialGameState().board;
    const senteDropped = hirate.map((row, y) => row.map((piece, x) => y === 7 && x === 7 ? null : piece));
    expect(parseKifuText(kifWithDiagram(senteDropped, "先手番", "1 ７六歩(77)"))).toMatchObject({ ok: false });
    expect(parseKifuText(kifWithDiagram(hirate, "後手番", "1 ３四歩(33)"))).toMatchObject({ ok: false });
    expect(parseKifuText("手合割：平手\n後手番\n手数----指手---------消費時間--\n1 ３四歩(33)")).toMatchObject({ ok: false });
    const sfen = initialPositionSfen().replace(" b ", " w ");
    expect(parseKifuText(`position sfen ${sfen} moves 3c3d`)).toMatchObject({ ok: false });
  });
  it("書き出して読み込むと元の手順に戻る", () => {
    const kif = formatKif(GAME, { senteName: "あなた", goteName: "将棋Web（中級）" });
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.moves).toEqual(GAME);
    expect(parsed.senteName).toBe("あなた");
    expect(parsed.goteName).toBe("将棋Web（中級）");
  });

  it("駒打ちも往復できる", () => {
    const parsed = parseKifuText(formatKif(WITH_DROP));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.moves).toEqual(WITH_DROP);
  });

  it("ヘッダと改行コード（CRLF）が慣例どおり", () => {
    const kif = formatKif(GAME);
    expect(kif).toContain("手合割：平手");
    expect(kif).toContain("手数----指手---------消費時間--");
    expect(kif.split("\r\n")[0]).toMatch(/^開始日時：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(kif).toContain("\r\n   1 ７六歩(77)");
  });

  it("相対表記（右左直上寄引）が入っていても読める", () => {
    const kif = [
      "手合割：平手",
      "手数----指手---------消費時間--",
      "   1 ７六歩(77)   ( 0:01/00:00:01)",
      "   2 ３四歩(33)   ( 0:01/00:00:01)",
    ].join("\r\n");
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.moves).toEqual(["7g7f", "3c3d"]);
  });

  it("「変化：」以降は読まない（本譜だけ）", () => {
    const kif =
      formatKif(["7g7f", "3c3d"]) + "変化：2手\r\n   2 ８四歩(83)   ( 0:01/00:00:01)\r\n";
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.moves).toEqual(["7g7f", "3c3d"]);
  });

  it("投了などの終局行で止まる", () => {
    const kif = formatKif(["7g7f", "3c3d"]) + "   3 投了         ( 0:01/00:00:02)\r\n";
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.moves).toEqual(["7g7f", "3c3d"]);
  });
});

describe("USI / SFEN の読み込み", () => {
  it("position startpos moves … を読める", () => {
    const parsed = parseKifuText(`position startpos moves ${GAME.join(" ")}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.moves).toEqual(GAME);
  });

  it("startpos moves … も、指し手の羅列だけでも読める", () => {
    expect(parseKifuText(`startpos moves 7g7f 3c3d`)).toMatchObject({ ok: true });
    expect(parseKifuText(`7g7f 3c3d 8h2b+`)).toMatchObject({ ok: true });
  });

  it("平手の初形から始まる sfen なら読める", () => {
    const sfen = "position sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1 moves 7g7f";
    const parsed = parseKifuText(sfen);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.moves).toEqual(["7g7f"]);
  });

  it("SFENの駒落ちで外した駒を持ち駒として扱わない", () => {
    const sfen = initialPositionSfen({ handicap: "rook" });
    expect(sfen).toBe("lnsgkgsnl/7b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1");
    expect(parseKifuText(`position sfen ${sfen.replace(" - ", " r ")} moves 3c3d`)).toMatchObject({ ok: false });
  });

  it("🔴 平手でない sfen は理由を出して断る", () => {
    const sfen = "position sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSN1 b - 1 moves 7g7f";
    const parsed = parseKifuText(sfen);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("平手");
  });
});

describe("形式の自動判定", () => {
  it.each([
    ["KIF", "手数----指手---------消費時間--\n   1 ７六歩(77)", "kif"],
    ["USI", "position startpos moves 7g7f", "usi"],
    ["USI（羅列）", "7g7f 8c8d", "usi"],
    ["KI2", "▲７六歩 △８四歩 ▲７八金", "ki2"],
    ["CSA", "V2.2\n+7776FU\n-8384FU", "csa"],
  ])("%s を見分ける", (_label, text, expected) => {
    expect(detectKifuFormat(text)).toBe(expected);
  });
});

describe("🔴 断るときは必ず理由を出す", () => {
  it("KI2 は移動元が無いので断る", () => {
    const parsed = parseKifuText("▲７六歩 △８四歩 ▲７八金");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.format).toBe("ki2");
      expect(parsed.message).toContain("KI2形式");
    }
  });

  it("CSA も断る", () => {
    const parsed = parseKifuText("V2.2\n+7776FU\n-8384FU");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("CSA形式");
  });

  it("未対応の駒落ちは断る", () => {
    const kif = [
      "手合割：三枚落ち",
      "手数----指手---------消費時間--",
      "   1 ７六歩(77)   ( 0:01/00:00:01)",
    ].join("\r\n");
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("駒落ち");
  });

  it("後手駒落ちなのに先手が初手を指した棋譜は合法性検査で断る", () => {
    const text = "手合割：角落ち\n手数----指手---------消費時間--\n1 ７六歩(77)";
    const parsed = parseKifuText(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("1手目");
  });

  it("盤面図なしの「その他」や途中局面の盤面図は理由を出して断る", () => {
    expect(parseKifuText("手合割：その他\n1 ７六歩(77)")).toMatchObject({ ok: false });
    const corrupt = createInitialGameState().board.map((row, y) => row.map((piece, x) => y === 6 && x === 2 ? null : piece));
    expect(parseKifuText(kifWithDiagram(corrupt, "先手番", "1 ７六歩(77)"))).toMatchObject({ ok: false });
  });

  it("将棋のルールに合わない棋譜は何手目かを言う", () => {
    const parsed = parseKifuText("position startpos moves 7g7f 8c8d 9i9a");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("3手目");
  });

  it("空文字・意味のない文字列でも落ちない", () => {
    expect(parseKifuText("")).toMatchObject({ ok: false });
    expect(parseKifuText("   ")).toMatchObject({ ok: false });
    expect(parseKifuText("こんにちは")).toMatchObject({ ok: false });
  });
});

describe("読み込み欄に出す文言", () => {
  it("形式と手数が分かる", () => {
    const parsed = parseKifuText(formatKif(GAME, { senteName: "あなた", goteName: "将棋Web（中級）" }));
    expect(describeParsed(parsed)).toContain("KIF形式");
    expect(describeParsed(parsed)).toContain("26手");
  });

  it("読めないときは理由がそのまま出る", () => {
    expect(describeParsed(parseKifuText("▲７六歩"))).toContain("KI2形式");
  });
});
