// SPDX-License-Identifier: GPL-3.0-only

// 表示名の自動生成に使う語彙（src/nickname/words.ts）の見張り番。
// この語彙が閉じていることが「日本語のNG語リストを持たない」根拠なので、
// 語を足すときの決まり（長さ・「の」・重複）をここで機械的に確かめる。
// 併せて、サーバーが日本語の表示名を通す唯一の口（POST /api/rooms）も確認する。

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CATEGORY_MASK, MODS, NOUNS, SUB_MASKS, isGeneratedName, randomName } from "../src/nickname/words";
import type { MatchPayload } from "../src/worker/protocol";

const UID = "cccccccc-3333-4333-8333-333333333333";

// 対局中でいちばん狭い場所（終局ダイアログの成績ストリップ「相手」欄）に入る上限
const MAX_NAME_LENGTH = 10;

// 札が重なるか＝ランダムで出てよい組み合わせか（自分で選ぶときとサーバーは札を問わない）
function tagsMatch(name: string): boolean {
  const at = name.indexOf("の");
  const mask = MODS.find(([w]) => w === name.slice(0, at))?.[1] ?? 0;
  const kind = NOUNS.find(([w]) => w === name.slice(at + 1))?.[1] ?? 0;
  return (mask & kind) !== 0;
}

// 札が重ならない組み合わせの1つ（ランダムでは出ないが、自分で選べば名乗れる）
const UNMATCHED = MODS.flatMap(([mod, mask]) =>
  NOUNS.filter(([, kind]) => !(mask & kind)).map(([noun]) => `${mod}の${noun}`))[0];

describe("表示名の語彙", () => {
  it("どの組み合わせも「の」込みで10文字以内", () => {
    const tooLong: string[] = [];
    for (const [mod] of MODS) {
      for (const [noun] of NOUNS) {
        const name = `${mod}の${noun}`;
        if (name.length > MAX_NAME_LENGTH) tooLong.push(name);
      }
    }
    expect(tooLong).toEqual([]);
  });

  it("MODS に「の」を含む語がない（先頭の「の」で前後を切り分けているため）", () => {
    expect(MODS.filter(([w]) => w.includes("の")).map(([w]) => w)).toEqual([]);
  });

  it("同じ語が二度出てこない", () => {
    expect(new Set(MODS.map(([w]) => w)).size).toBe(MODS.length);
    expect(new Set(NOUNS.map(([w]) => w)).size).toBe(NOUNS.length);
  });

  it("ものの名前は種類の札をちょうど1つ持つ", () => {
    const wrong = NOUNS.filter(([, kind]) => {
      const category = kind & CATEGORY_MASK;
      return category === 0 || (category & (category - 1)) !== 0; // 0個 or 2個以上
    });
    expect(wrong.map(([w]) => w)).toEqual([]);
  });

  it("組む相手が1つも無い語がない（前半・後半とも）", () => {
    const lonelyMods = MODS.filter(([, mask]) => !NOUNS.some(([, kind]) => kind & mask));
    expect(lonelyMods.map(([w]) => w)).toEqual([]);
    const lonelyNouns = NOUNS.filter(([, kind]) => !MODS.some(([, mask]) => kind & mask));
    expect(lonelyNouns.map(([w]) => w)).toEqual([]);
  });

  // 札は1つでも重なればランダムで出るので、修飾に種類とその下位を一緒に付けると下位の絞り込みが消える
  //（例: ほかほか に FOOD を足すと、温かくない食べものにも付いてしまう）
  it("修飾のことばは、種類の札とその下位の札を一緒に付けていない", () => {
    const mixed = MODS.filter(([, mask]) =>
      SUB_MASKS.some(([category, sub]) => (mask & category) !== 0 && (mask & sub) !== 0));
    expect(mixed.map(([w]) => w)).toEqual([]);
  });

  it("ものの名前は、自分の種類の下位の札しか持たない", () => {
    const wrong = NOUNS.filter(([, kind]) =>
      SUB_MASKS.some(([category, sub]) => (kind & sub) !== 0 && (kind & category) === 0));
    expect(wrong.map(([w]) => w)).toEqual([]);
  });

  it("語彙の語どうしなら、札が重ならない組み合わせも通す（自分で選べるため）", () => {
    const wrong: string[] = [];
    for (const [mod] of MODS) {
      for (const [noun] of NOUNS) {
        const name = `${mod}の${noun}`;
        if (!isGeneratedName(name)) wrong.push(name);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("語彙にない日本語は通さない", () => {
    for (const bad of [
      "しねの死ね",
      "もっちもちの死ね",
      "ばかのプリン",
      "もっちもちプリン",
      "のプリン",
      "もっちもちの",
      "もっちもちのプリンの",
      "",
      "yuki",
    ]) {
      expect(isGeneratedName(bad)).toBe(false);
    }
  });

  it("ランダムで出したい組み合わせは札が重なる", () => {
    for (const good of [
      "もっちもちのプリン",
      "ふわふわのひつじ",
      "ふわふわのくらげ",
      "ほかほかのおにぎり",
      "ゆうやけの飛車",
      "ねぼすけの穴熊",
      "幻影の使徒",
      "紅蓮のかえで",
      "さいごの歩",
      "こもれびのすずめ",
      "はつゆきのかき氷",
    ]) {
      expect(tagsMatch(good)).toBe(true);
    }
  });

  it("噛み合わない組み合わせは札が重ならない（ランダムでは出ない）", () => {
    for (const odd of [
      "もっちもちの香車", // 食感 × 駒
      "あばれのカステラ", // 将棋の戦い方 × 食べもの
      "ねばりのこねこ", // 将棋の戦い方 × 生きもの
      "ほかほかのかき氷", // 食感どうしが噛み合わない
      "ふわふわのめだか",
      "しぐれの湯のみ", // 情景 × 道具
    ]) {
      expect(tagsMatch(odd)).toBe(false);
    }
  });

  it("randomName() は必ず札の合う組み合わせを返す", () => {
    for (let i = 0; i < 300; i++) {
      const name = randomName();
      expect(tagsMatch(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  });
});

describe("サーバーが受け取る表示名", () => {
  let nextIp = 1;
  async function createRoom(displayName: unknown) {
    nextIp += 1;
    const res = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: { "CF-Connecting-IP": `10.7.${Math.floor(nextIp / 256)}.${nextIp % 256}` },
      body: JSON.stringify({ uid: UID, displayName, tc: { type: "per_move", seconds: 30 } }),
    });
    const json = (await res.json()) as { ok: boolean; match?: MatchPayload };
    return json.match?.sente_name ?? null;
  }

  it("自動生成の名前はそのまま通る", async () => {
    expect(await createRoom("もっちもちのプリン")).toBe("もっちもちのプリン");
  });

  it("札が重ならない組み合わせも通る（自分で選んだ名前が相手に届く）", async () => {
    expect(await createRoom(UNMATCHED)).toBe(UNMATCHED);
  });

  it("語彙にない日本語は落ちる（＝日本語のNG語リストが要らない）", async () => {
    expect(await createRoom("しねしね")).toBeNull();
    expect(await createRoom("もっちもちの死ね")).toBeNull();
  });

  it("自分で決めた英数字の名前は今までどおり", async () => {
    expect(await createRoom("yuki")).toBe("yuki");
    expect(await createRoom("ＹＵＫＩ")).toBe("YUKI");
  });
});
