// SPDX-License-Identifier: GPL-3.0-only

// 表示名NG語フィルタのテスト。
// 1) パリティ: TS版（サーバー）とJS版（クライアント）が全ケースで同じ出力になること
// 2) 判定: リバーシ由来のケーステーブル（test/fixtures/name_filter_cases.json）どおりに検知・許容すること
//    ※日本語文字のNGケースだけは対象外。JP_WORDS辞書は移植していない（表示名が
//      半角英数字と _ - . に制限されるため日本語はフィルタに到達しない。設計書 §5.2）
// 3) 統合: normalizeDisplayName 経由（部屋作成API）で実際に伏せ字になること

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/name_filter_cases.json";
import { isProfane, maskBadWords } from "../src/worker/name_filter";
// @ts-expect-error 素のJS（UMD）を型定義なしで読み込む（globalThis.nameFilter に登録される）
import * as clientModule from "../name-filter.js";

type ClientFilter = { clean(input: unknown): string; isProfane(input: unknown): boolean };

function resolveClientFilter(): ClientFilter {
  const m = clientModule as Record<string, unknown>;
  if (typeof m.clean === "function") return m as unknown as ClientFilter;
  const dflt = m.default as ClientFilter | undefined;
  if (dflt && typeof dflt.clean === "function") return dflt;
  const g = (globalThis as unknown as { nameFilter?: ClientFilter }).nameFilter;
  if (g && typeof g.clean === "function") return g;
  throw new Error("client name filter (name-filter.js) not loaded");
}

const client = resolveClientFilter();

// JP_WORDS（未移植の日本語辞書）が無いと検知できないケースの判別
const NEEDS_JP_DICT = /[぀-ヿ㐀-鿿ｦ-ﾟ○]/;

const allInputs: string[] = [
  ...cases.ng,
  ...cases.ok,
  ...cases.output.map(([input]) => input),
];

describe("name filter parity (TS server == JS client)", () => {
  it("produces identical output for every case-table input", () => {
    for (const input of allInputs) {
      expect(maskBadWords(input), `input: ${JSON.stringify(input)}`).toBe(client.clean(input));
    }
  });
});

describe("name filter behavior (riversi case table)", () => {
  it("detects every NG case (except JP-dictionary-only ones)", () => {
    for (const input of cases.ng) {
      if (NEEDS_JP_DICT.test(input)) continue;
      expect(isProfane(input), `should be NG: ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it("passes every OK case unchanged", () => {
    for (const input of cases.ok) {
      expect(maskBadWords(input), `should be OK: ${JSON.stringify(input)}`).toBe(input);
    }
  });

  it("matches the exact masked outputs (except JP-dictionary-only ones)", () => {
    for (const [input, expected] of cases.output) {
      if (NEEDS_JP_DICT.test(input)) continue;
      expect(maskBadWords(input)).toBe(expected);
    }
  });
});

describe("normalizeDisplayName integration (via the rooms API)", () => {
  const UID = "dddddddd-4444-4444-8444-444444444444";
  let ip = 1;
  async function createRoomWithName(displayName: unknown) {
    ip += 1;
    const res = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: { "CF-Connecting-IP": `10.7.0.${ip}` },
      body: JSON.stringify({ uid: UID, displayName }),
    });
    return (await res.json()) as { match?: { sente_name: string | null } };
  }

  it("masks NG words end to end", async () => {
    const json = await createRoomWithName("FuckMan99");
    expect(json.match?.sente_name).toBe("****Man99");
  });

  it("strips disallowed characters and caps at 10", async () => {
    const json = await createRoomWithName("山田yamada太郎12345");
    expect(json.match?.sente_name).toBe("yamada1234");
  });

  it("stores null when nothing survives normalization", async () => {
    const json = await createRoomWithName("山田太郎！");
    expect(json.match?.sente_name).toBeNull();
  });
});
