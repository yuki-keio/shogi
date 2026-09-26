// SPDX-License-Identifier: GPL-3.0-only

// POST /api/backup と /api/backup/restore: 控えの保存・取り出し・Cookie・上限・上書きの守り。

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKUP_GAMES_KEPT, pruneInactiveBackups, saveBackup } from "../src/worker/backup";
import { fitProfile } from "../src/records/backup";

const UID = "11111111-2222-4333-8444-555555555555";

// レート制限は isolate ごとの記憶なので、テストごとに別のIPから送る
let nextIp = 1;
function uniqueIp(): string {
  nextIp += 1;
  return `10.9.${Math.floor(nextIp / 256)}.${nextIp % 256}`;
}

function profile(games: number, tsume = 0, local: Record<string, string> = {}) {
  return {
    v: 1,
    local,
    records: {
      startedAt: 1_000,
      summaries: [{ mode: "all", games, wins: games, losses: 0, draws: 0, eligible: games, waza: {} }],
      tsumeSummary: { cleared: tsume, firstTry: tsume, byMoves: {} },
      tsume: [],
    },
  };
}

function game(n: number) {
  return { id: `game-${n}`, startedAt: n * 1000, endedAt: n * 1000 + 500, mode: "ai", moves: ["7g7f"], wazaIds: [] };
}

async function post(path: string, body: unknown, ip = uniqueIp()) {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function restore(part: "profile" | "games", uid = UID) {
  const res = await post("/api/backup/restore", { uid, part });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; profile?: ReturnType<typeof profile> | null; games?: Array<{ id: string }> };
}

describe("POST /api/backup", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM backup_profile"),
      env.DB.prepare("DELETE FROM backup_game"),
    ]);
  });

  it("stores the profile and games, and hands them back", async () => {
    const res = await post("/api/backup", {
      uid: UID,
      profile: profile(2, 1, { shogi_ai_difficulty: "hard" }),
      games: [game(1), game(2)],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = await restore("profile");
    expect(stored.profile?.local).toEqual({ shogi_ai_difficulty: "hard" });
    expect(stored.profile?.records.summaries[0].games).toBe(2);

    const { games } = await restore("games");
    expect(games?.map((g) => g.id)).toEqual(["game-2", "game-1"]);
  });

  it("issues the key cookie only to this host, readable by the page, for 400 days", async () => {
    const res = await post("/api/backup", { uid: UID, profile: profile(0) });
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^__Host-shogi_uid=${UID};`));
    expect(cookie).toContain("Max-Age=34560000");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).not.toContain("Domain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never lets a smaller record overwrite the backup, but takes equal ones", async () => {
    await post("/api/backup", { uid: UID, profile: profile(5, 2, { shogi_ai_difficulty: "hard" }) });
    // 消えた直後の空に近い状態
    await post("/api/backup", { uid: UID, profile: profile(1, 0, { shogi_ai_difficulty: "medium" }) });
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("hard");

    // 対局数が同じなら設定だけの変更も通す
    await post("/api/backup", { uid: UID, profile: profile(5, 2, { shogi_ai_difficulty: "super" }) });
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("super");
  });

  it("keeps only the newest games and ignores ones already stored", async () => {
    const first = Array.from({ length: BACKUP_GAMES_KEPT }, (_, i) => game(i + 1));
    await post("/api/backup", { uid: UID, profile: profile(100), games: first });
    await post("/api/backup", { uid: UID, profile: profile(103), games: [game(100), game(101), game(102), game(103)] });

    const { games } = await restore("games");
    expect(games).toHaveLength(BACKUP_GAMES_KEPT);
    expect(games?.[0].id).toBe("game-103");
    expect(games?.at(-1)?.id).toBe("game-4");
  });

  it("returns an empty backup for someone who never sent one", async () => {
    expect((await restore("profile", "99999999-2222-4333-8444-555555555555")).profile).toBeNull();
    expect((await restore("games", "99999999-2222-4333-8444-555555555555")).games).toEqual([]);
  });

  it("rejects malformed and oversized requests", async () => {
    expect((await post("/api/backup", { profile: profile(0) })).status).toBe(400);
    expect((await post("/api/backup", { uid: "../x", profile: profile(0) })).status).toBe(400);
    expect((await post("/api/backup", "{not json")).status).toBe(400);
    expect((await post("/api/backup", { uid: UID, profile: { v: 2, local: {} } })).status).toBe(400);
    expect((await post("/api/backup", { uid: UID, profile: profile(0), games: [{ id: "", endedAt: 1 }] })).status).toBe(400);
    const tooMany = Array.from({ length: BACKUP_GAMES_KEPT + 1 }, (_, i) => game(i));
    expect((await post("/api/backup", { uid: UID, profile: profile(0), games: tooMany })).status).toBe(400);
    const huge = { ...profile(0), local: { shogi_waza_book: "x".repeat(60 * 1024) } };
    expect((await post("/api/backup", { uid: UID, profile: huge })).status).toBe(400);
    expect((await post("/api/backup/restore", { part: "profile" })).status).toBe(400);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_profile").all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });

  it("accepts the backup of someone who solves every tsume every day, once it is trimmed to size", async () => {
    // 詰将棋7問×62日ぶんの解答記録・技24種×4モードの集計・31日ぶんの✓という重い利用者
    const waza = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`waza-${i}`, { games: 99, wins: 60, losses: 39, draws: 0, eligible: 99 }]));
    const heavy = profile(500, 434, {
      shogi_tsume_v1: JSON.stringify({ lastDate: "2026-09-26", streak: 62, total: 434, days: Object.fromEntries(Array.from({ length: 31 }, (_, d) => [`2026-09-${String(d).padStart(2, "0")}`, { beginner: "clean", intermediate: "clean", advanced: "solved", expert: "clean", master: "clean", great: "assisted", transcendent: "clean" }])) }),
    });
    heavy.records.summaries = ["all", "ai", "online", "board"].map((mode) => ({ mode, games: 500, wins: 300, losses: 200, draws: 0, eligible: 500, waza }));
    heavy.records.tsume = Array.from({ length: 434 }, (_, i) => ({ date: "2026-09-01", problemId: `t${i % 7}-${String(i).padStart(4, "0")}`, moves: 1 + 2 * (i % 7), firstTry: true, clearedAt: 1_790_000_000_000 + i }));

    const fitted = fitProfile(structuredClone(heavy));
    expect(fitted.records.tsume.length).toBeGreaterThan(0);
    expect(fitted.records.tsume.at(-1)).toEqual(heavy.records.tsume.at(-1)); // 新しい記録は残る
    const res = await post("/api/backup", { uid: UID, profile: fitted });
    expect(res.status).toBe(200);
    expect((await restore("profile")).profile?.records.tsumeSummary.cleared).toBe(434);
  });

  it("stops taking backups once the database grows past the safety limit", async () => {
    const result = await saveBackup(env.DB, UID, { profile: profile(1) }, Date.now(), 1);
    expect(result).toMatchObject({ ok: false, error: { code: "backup_paused" } });
    expect((await restore("profile")).profile).toBeNull();
  });

  it("drops the backups of people who have not come back within the cookie lifetime", async () => {
    await post("/api/backup", { uid: UID, profile: profile(1), games: [game(1)] });
    await pruneInactiveBackups(env.DB, Date.now() + 401 * 24 * 60 * 60 * 1000);
    expect((await restore("profile")).profile).toBeNull();
    expect((await restore("games")).games).toEqual([]);
  });
});

describe("GET /api/online-stats cookie", () => {
  it("hands out the key cookie only when the lobby sends its uid", async () => {
    const withUid = await SELF.fetch(`https://example.com/api/online-stats?uid=${UID}`, {
      headers: { "CF-Connecting-IP": uniqueIp() },
    });
    expect(withUid.headers.get("Set-Cookie")).toMatch(new RegExp(`^__Host-shogi_uid=${UID};`));

    const withoutUid = await SELF.fetch("https://example.com/api/online-stats", {
      headers: { "CF-Connecting-IP": uniqueIp() },
    });
    expect(withoutUid.headers.get("Set-Cookie")).toBeNull();
  });
});
