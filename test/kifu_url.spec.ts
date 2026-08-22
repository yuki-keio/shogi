// SPDX-License-Identifier: GPL-3.0-only

// 共有URL（?k=）の往復。設計書 §6 / §14
// 移動・成り・駒打ちの全種類を通し、壊れた入力で落ちないことも見る。

import { describe, expect, it } from "vitest";
import { clampMoveIndex, decodeKifuParam, encodeKifuParam } from "../src/kifu/url";
import { replayUsiMoves } from "../src/kifu/replay";
import { parseUsiMove } from "../src/kifu/moves";
import { applyMove, createInitialGameState } from "../src/worker/shogi_engine";

// 実際に指せる棋譜（成り・駒打ち・取り合いを含む）
const GAME = [
  "7g7f", "8c8d", "6i7h", "3c3d", "2g2f", "8d8e", "8h7g", "4a3b",
  "7i8h", "2b7g+", "8h7g", "3a2b", "3i3h", "7a7b", "3h2g", "6c6d",
  "2g3f", "7b6c", "4i4h", "5a4b", "5i6h", "7c7d", "3f4e", "8e8f",
  "8g8f", "8b8f",
];

describe("共有URLの往復", () => {
  it("実戦の手順がそのまま戻る", () => {
    const encoded = encodeKifuParam(GAME);
    expect(encoded).not.toBeNull();
    expect(decodeKifuParam(encoded)).toEqual(GAME);
  });

  it("base64url なので URL に入れて危ない文字を含まない", () => {
    const encoded = encodeKifuParam(GAME)!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("駒打ちを7種類すべて往復できる", () => {
    const drops = ["P*5e", "L*5e", "N*5e", "S*5e", "G*5e", "B*5e", "R*5e"];
    expect(decodeKifuParam(encodeKifuParam(drops))).toEqual(drops);
  });

  it("成る手と成らない手を区別する", () => {
    const moves = ["8h2b+", "8h2b"];
    expect(decodeKifuParam(encodeKifuParam(moves))).toEqual(moves);
  });

  it("盤の四隅を往復できる", () => {
    const corners = ["9a1i", "1i9a", "1a9i", "9i1a"];
    expect(decodeKifuParam(encodeKifuParam(corners))).toEqual(corners);
  });

  it("0手でも往復できる", () => {
    const encoded = encodeKifuParam([]);
    expect(encoded).not.toBeNull();
    expect(decodeKifuParam(encoded)).toEqual([]);
  });

  it("120手ぶんでも URL の上限にまったく届かない", () => {
    const long = Array.from({ length: 120 }, () => "7g7f");
    const encoded = encodeKifuParam(long)!;
    // ?k= と &m= を足しても数百文字。Cloudflare の上限は 16,384 文字
    expect(encoded.length).toBeLessThan(400);
  });

  it("読めない指し手は null（呼び出し側が案内に落とす）", () => {
    expect(encodeKifuParam(["zzzz"])).toBeNull();
    expect(encodeKifuParam(["7g7f", ""])).toBeNull();
  });
});

describe("壊れた k で落ちない", () => {
  it.each([
    ["空文字", ""],
    ["base64url にない文字", "!!!!"],
    ["バージョンが違う", "AgAA"],
    ["中身なし", ""],
  ])("%s は null を返す", (_label, value) => {
    expect(decodeKifuParam(value)).toBeNull();
  });

  it("null / undefined でも例外にならない", () => {
    expect(decodeKifuParam(null)).toBeNull();
    expect(decodeKifuParam(undefined)).toBeNull();
  });

  it("マス番号が範囲外なら null", () => {
    // from=0, to=127（81以上は駒打ちの番号だが移動先には使えない）
    const bytes = [1, 0x00, 0xfe];
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let encoded = "";
    encoded += chars[bytes[0] >> 2];
    encoded += chars[((bytes[0] & 3) << 4) | (bytes[1] >> 4)];
    encoded += chars[((bytes[1] & 15) << 2) | (bytes[2] >> 6)];
    encoded += chars[bytes[2] & 63];
    expect(decodeKifuParam(encoded)).toBeNull();
  });
});

describe("m（表示する手数）の丸め", () => {
  it("範囲内はそのまま", () => {
    expect(clampMoveIndex("20", 26)).toBe(20);
    expect(clampMoveIndex(0, 26)).toBe(0);
  });

  it("範囲外・数字でない・未指定は最終手に丸める（エラーにしない）", () => {
    expect(clampMoveIndex("999", 26)).toBe(26);
    expect(clampMoveIndex("-3", 26)).toBe(26);
    expect(clampMoveIndex("abc", 26)).toBe(26);
    expect(clampMoveIndex(null, 26)).toBe(26);
    expect(clampMoveIndex(undefined, 26)).toBe(26);
    expect(clampMoveIndex("", 26)).toBe(26);
  });
});

// 通信対戦の棋譜はサーバー（src/worker/shogi_engine.ts）が組み立てたものをそのまま共有URLに載せる。
// サーバーの toUsiMoveString() が吐く文字列を encodeKifuParam が受け取れることを固定しておく
describe("サーバーが組み立てた棋譜も共有URLにできる", () => {
  it("通信対戦の指し手をそのまま往復できる", () => {
    let state = createInitialGameState();
    for (const usi of GAME) {
      const move = parseUsiMove(usi);
      expect(move).not.toBeNull();
      state = applyMove(state, move!).state;
    }
    // サーバー側で組み立てられた棋譜（手元の GAME とは別経路で作られている）
    expect(state.usiMoveHistory).toEqual(GAME);

    const encoded = encodeKifuParam(state.usiMoveHistory);
    expect(encoded).not.toBeNull();
    expect(decodeKifuParam(encoded)).toEqual(GAME);
    expect(replayUsiMoves(decodeKifuParam(encoded)!).ok).toBe(true);
  });
});

describe("復元した手順が実際に指せる", () => {
  it("デコード結果をそのまま並べ直せる", () => {
    const decoded = decodeKifuParam(encodeKifuParam(GAME))!;
    const replay = replayUsiMoves(decoded);
    expect(replay.ok).toBe(true);
    expect(replay.states.length).toBe(GAME.length + 1);
  });
});
