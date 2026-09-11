// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { initialNameProfile, normalizeCustomName, validCustomName } from "../src/nickname/profile";
import { isGeneratedName } from "../src/nickname/words";

describe("表示名の保存値の復元", () => {
  it("初回の中立的な名前は保存後の再訪でも変わらない", () => {
    const profile = initialNameProfile("", "");
    expect(profile.name).toMatch(/^Player[1-9]\d{3}$/);
    expect(profile.mode).toBe("default");
    expect(initialNameProfile(profile.name, profile.mode)).toEqual(profile);
  });

  it("既存の自由入力名は記号を含めてそのまま復元する", () => {
    expect(initialNameProfile("yuki_1-2.3", "0")).toEqual({ name: "yuki_1-2.3", mode: "0" });
    expect(initialNameProfile("yuki_1-2.3", "")).toEqual({ name: "yuki_1-2.3", mode: "0" });
    expect(initialNameProfile("Player1234", "")).toEqual({ name: "Player1234", mode: "0" });
  });

  it("匿名を選んだ人は再訪しても匿名のまま", () => {
    expect(initialNameProfile("", "0")).toEqual({ name: "", mode: "0" });
  });

  it("有効な二つ名を維持し、語彙から作れなくなった二つ名だけを再生成する", () => {
    expect(initialNameProfile("もっちもちのプリン", "1")).toEqual({ name: "もっちもちのプリン", mode: "1" });
    for (const oldName of ["ほかほかのかき氷", ""]) {
      const profile = initialNameProfile(oldName, "1");
      expect(isGeneratedName(profile.name)).toBe(true);
      expect(profile.mode).toBe("1");
    }
  });

  it("中立的な名前の保存値が欠けた場合は中立的な名前を復元する", () => {
    expect(initialNameProfile("", "default")).toEqual({
      name: expect.stringMatching(/^Player[1-9]\d{3}$/),
      mode: "default",
    });
  });
});

describe("自由入力の確認", () => {
  it("全角英数字を半角へ揃えて受け付ける", () => {
    const name = normalizeCustomName("Ｙｕｋｉ１２３");
    expect(name).toBe("Yuki123");
    expect(validCustomName(name)).toBe(true);
  });

  it("空欄と10文字までの英数字・記号 _ - . を受け付ける", () => {
    expect(validCustomName("")).toBe(true);
    expect(validCustomName("Abc1234567")).toBe(true);
    expect(validCustomName("yuki_1-2.3")).toBe(true);
    expect(validCustomName("Abc12345678")).toBe(false);
  });

  it("使えない文字を消さずに入力エラーとして扱う", () => {
    for (const input of ["名前", "yuki@1", " yuki", "yuki ", "yuki\n"]) {
      expect(normalizeCustomName(input)).toBe(input);
      expect(validCustomName(input)).toBe(false);
    }
  });
});
