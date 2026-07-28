// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";

// build-pages.mjs が `/` のページの <head> へインライン展開するのと同じ関数
import { resolveLegacyModeRedirect } from "../pages/legacy-redirect.mjs";

const at = (u: string) => {
  const url = new URL(u, "https://shogi.yuki-lab.com");
  return resolveLegacyModeRedirect(url.pathname, url.search);
};

describe("resolveLegacyModeRedirect", () => {
  it("素の / は絶対に遷移させない", () => {
    expect(at("/")).toBeNull();
    expect(at("/?utm_source=newsletter")).toBeNull();
    expect(at("/?fbclid=abc")).toBeNull();
  });

  it("未知の mode 値には触らない", () => {
    expect(at("/?mode=zzz")).toBeNull();
    expect(at("/?mode=")).toBeNull();
  });

  it("mode をパスへ移す", () => {
    expect(at("/?mode=ai")).toBe("/");
    expect(at("/?mode=pvp")).toBe("/board/");
    expect(at("/?mode=online")).toBe("/online/");
  });

  it("招待URLの room を引き継ぐ", () => {
    expect(at("/?mode=online&room=ABCDEFGHJK")).toBe("/online/?room=ABCDEFGHJK");
    expect(at("/?room=ABCDEFGHJK")).toBe("/online/?room=ABCDEFGHJK");
  });

  it("room があれば mode の値によらず通信対戦へ送る", () => {
    expect(at("/?mode=pvp&room=ABCDEFGHJK")).toBe("/online/?room=ABCDEFGHJK");
  });

  it("空の room は落として mode の指す先へ送る", () => {
    expect(at("/?mode=pvp&room=")).toBe("/board/");
    expect(at("/?room=")).toBeNull();
  });

  it("mode 以外のクエリは温存する", () => {
    expect(at("/?mode=pvp&utm_source=x")).toBe("/board/?utm_source=x");
    expect(at("/?mode=online&room=ABC&utm_source=x")).toBe("/online/?room=ABC&utm_source=x");
  });

  it("/ 以外のパスは対象外", () => {
    expect(at("/board/?mode=ai")).toBeNull();
    expect(at("/online/?room=ABCDEFGHJK")).toBeNull();
    expect(at("/gunjin/?mode=pvp")).toBeNull();
  });
});
