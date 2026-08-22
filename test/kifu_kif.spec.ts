// SPDX-License-Identifier: GPL-3.0-only

// KIF の書き出し・読み込みと、形式の自動判定。設計書 §8 §9 / §14
// 🔴 平手のみ。KI2・CSA は理由を出して断る。黙って失敗しないこと。

import { describe, expect, it } from "vitest";
import {
  describeParsed,
  detectKifuFormat,
  formatKif,
  parseKifuText,
} from "../src/kifu/kif";

const GAME = [
  "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e", "8h7g", "4a3b",
  "7i8h", "2b7g+", "8h7g", "3a2b", "3i3h", "7a7b", "3h2g", "6c6d",
  "2g3f", "7b6c", "4i4h", "5a4b", "5i6h", "7c7d", "3f4e", "8e8f",
  "8g8f", "8b8f",
];

// 駒打ちを含む短い手順（打を往復できるか見る）
const WITH_DROP = ["7g7f", "3c3d", "8h2b+", "3a2b", "B*5e"];

describe("KIF の往復", () => {
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

  it("駒落ちは断る", () => {
    const kif = [
      "手合割：角落ち",
      "手数----指手---------消費時間--",
      "   1 ７六歩(77)   ( 0:01/00:00:01)",
    ].join("\r\n");
    const parsed = parseKifuText(kif);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("駒落ち");
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
