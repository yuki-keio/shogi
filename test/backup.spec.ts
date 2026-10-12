// SPDX-License-Identifier: GPL-3.0-only

// POST /api/backup と /api/backup/restore: 控えの保存・取り出し・Cookie・上限・上書きの守り。
// 後半は、本体の DB の古い表から控え専用の DB へ移す処理（backup_move.ts）。

import { createScheduledController, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_GAMES_KEPT,
  BACKUP_KEEP_MS,
  type BackupGame,
  pruneInactiveBackups,
  saveBackup,
  unpackText,
} from "../src/worker/backup";
import { KEEP_LEGACY_MS, legacyGamesKept, stepBackupMove } from "../src/worker/backup_move";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
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

/** 控え専用の DB を空にし、古い表もまだ写していない状態に戻す */
async function resetBackups() {
  await env.BACKUP.batch([
    env.BACKUP.prepare("DELETE FROM backup"),
    env.BACKUP.prepare("UPDATE backup_move SET copied_rowid = 0, copied_at = NULL, deleted_rowid = 0, dropped_at = NULL WHERE id = 1"),
  ]);
  await env.DB.batch([env.DB.prepare("DELETE FROM backup_profile"), env.DB.prepare("DELETE FROM backup_game")]);
}

async function backupRows() {
  const row = await env.BACKUP.prepare("SELECT COUNT(*) AS n FROM backup").first<{ n: number }>();
  return row?.n ?? 0;
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
  beforeEach(resetBackups);

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

  it("keeps the initial position together with a handicap game's moves", async () => {
    const initialPosition = { handicap: "rook", handicapSide: "sente", firstPlayer: "sente" };
    const handicapGame = { ...game(1), initialPosition };
    const res = await post("/api/backup", { uid: UID, profile: profile(1), games: [handicapGame] });
    expect(res.status).toBe(200);
    expect((await restore("games")).games).toEqual([handicapGame]);
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
    // 戻したときに戦績ページの日付表示が例外になる時刻
    expect((await post("/api/backup", { uid: UID, profile: profile(0), games: [{ id: "g", endedAt: 8.64e15 + 1 }] })).status).toBe(400);
    expect(await backupRows()).toBe(0);
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
    const result = await saveBackup(env.BACKUP, env.DB, UID, { profile: profile(1) }, Date.now(), 1);
    expect(result).toMatchObject({ ok: false, error: { code: "backup_paused" } });
    expect((await restore("profile")).profile).toBeNull();
  });

  it("drops the backups of people who have not sent one for 180 days, and keeps the rest", async () => {
    const now = Date.now();
    await post("/api/backup", { uid: UID, profile: profile(1), games: [game(1)] });
    await pruneInactiveBackups(env.BACKUP, now + BACKUP_KEEP_MS - 60_000);
    expect((await restore("profile")).profile).not.toBeNull();
    await pruneInactiveBackups(env.BACKUP, now + BACKUP_KEEP_MS + 60_000);
    expect((await restore("profile")).profile).toBeNull();
    expect((await restore("games")).games).toEqual([]);
  });

  it("keeps each person in one compressed row, with the count readable without opening it", async () => {
    await post("/api/backup", { uid: UID, profile: profile(2), games: [game(1), game(2)] });
    const row = await env.BACKUP
      .prepare("SELECT game_count, last_game_at, typeof(profile) AS p, typeof(games) AS g, games FROM backup WHERE uid = ?1")
      .bind(UID)
      .first<{ game_count: number; last_game_at: number; p: string; g: string; games: number[] }>();
    expect(row).toMatchObject({ game_count: 2, last_game_at: game(2).endedAt, p: "blob", g: "blob" });
    expect((JSON.parse(await unpackText(row!.games)) as BackupGame[]).map((g) => g.id)).toEqual(["game-2", "game-1"]);
  });

  it("still adds the games sent with a smaller record, without overwriting the settings", async () => {
    await post("/api/backup", { uid: UID, profile: profile(5, 0, { shogi_ai_difficulty: "hard" }), games: [game(1)] });
    await post("/api/backup", { uid: UID, profile: profile(1, 0, { shogi_ai_difficulty: "easy" }), games: [game(2)] });
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("hard");
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-2", "game-1"]);
  });

  it("counts every accepted backup as a visit, even one that keeps the old settings", async () => {
    const first = Date.now();
    await saveBackup(env.BACKUP, env.DB, UID, { profile: profile(5), games: [game(1)] }, first);
    // 100日後に、対局数が減る送信（設定は据え置き）が届いた。最後に受け取った時刻はここから数え直す
    await saveBackup(env.BACKUP, env.DB, UID, { profile: profile(1), games: [game(2)] }, first + 100 * 86_400_000);
    await pruneInactiveBackups(env.BACKUP, first + BACKUP_KEEP_MS + 60_000);
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-2", "game-1"]);
  });

  it("does not lose either game when two tabs send at the same moment", async () => {
    const now = Date.now();
    const results = await Promise.all([
      saveBackup(env.BACKUP, env.DB, UID, { profile: profile(1), games: [game(1)] }, now),
      saveBackup(env.BACKUP, env.DB, UID, { profile: profile(1), games: [game(2)] }, now),
      saveBackup(env.BACKUP, env.DB, UID, { profile: profile(1), games: [game(3)] }, now),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-3", "game-2", "game-1"]);
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

describe("requests sent from other sites", () => {
  beforeEach(async () => {
    await resetBackups();
    await env.DB.prepare("DELETE FROM feedback").run();
  });

  function send(path: string, body: unknown, site: string | null) {
    const headers: Record<string, string> = { "CF-Connecting-IP": uniqueIp(), "Content-Type": "text/plain" };
    if (site) headers["Sec-Fetch-Site"] = site;
    return SELF.fetch(`https://example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("refuses POSTs that another site made the browser send, and stores nothing", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await send("/api/backup", { uid: UID, profile: profile(1) }, site)).status).toBe(403);
      expect((await send("/api/feedback", { message: "spam" }, site)).status).toBe(403);
    }
    const feedback = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>();
    expect(await backupRows()).toBe(0);
    expect(feedback?.n).toBe(0);
  });

  it("still takes the site's own requests, and clients that send no Sec-Fetch-Site", async () => {
    expect((await send("/api/backup", { uid: UID, profile: profile(1) }, "same-origin")).status).toBe(200);
    expect((await send("/api/feedback", { message: "ok" }, null)).status).toBe(200);
  });

  it("does not hand out the key cookie for a link opened from another site", async () => {
    for (const site of ["cross-site", "none"]) {
      const res = await SELF.fetch(`https://example.com/api/online-stats?uid=${UID}`, {
        headers: { "CF-Connecting-IP": uniqueIp(), "Sec-Fetch-Site": site },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    const own = await SELF.fetch(`https://example.com/api/online-stats?uid=${UID}`, {
      headers: { "CF-Connecting-IP": uniqueIp(), "Sec-Fetch-Site": "same-origin" },
    });
    expect(own.headers.get("Set-Cookie")).toMatch(new RegExp(`^__Host-shogi_uid=${UID};`));
  });
});

describe("moving backups out of the old tables in the main database", () => {
  const OTHER = "22222222-3333-4444-8555-666666666666";

  beforeEach(resetBackups);

  /** 古い表（本体の DB）に1人分の控えを入れる */
  async function putLegacy(uid: string, progress: number, updatedAt: number, games: BackupGame[], local: Record<string, string> = {}) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO backup_profile (uid, data, progress, updated_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(uid, JSON.stringify(profile(progress, 0, local)), progress, updatedAt),
      ...games.map((g) =>
        env.DB.prepare("INSERT INTO backup_game (uid, id, ended_at, data) VALUES (?1, ?2, ?3, ?4)").bind(uid, g.id, g.endedAt, JSON.stringify(g))),
    ]);
  }

  async function stored(uid: string) {
    const row = await env.BACKUP.prepare("SELECT progress, updated_at, games FROM backup WHERE uid = ?1")
      .bind(uid)
      .first<{ progress: number; updated_at: number; games: number[] }>();
    if (!row) return null;
    const ids = (JSON.parse(await unpackText(row.games)) as BackupGame[]).map((g) => g.id);
    return { progress: row.progress, updatedAt: row.updated_at, ids };
  }

  async function moveState() {
    return env.BACKUP.prepare("SELECT copied_at, dropped_at FROM backup_move WHERE id = 1")
      .first<{ copied_at: number | null; dropped_at: number | null }>();
  }

  /** 古い表に残っている行の数。表ごと消えていたら null */
  async function legacyLeft() {
    const { results } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('backup_profile', 'backup_game')")
      .all<{ name: string }>();
    if (results.length === 0) return null;
    const [profiles, games] = await env.DB.batch<{ n: number }>([
      env.DB.prepare("SELECT COUNT(*) AS n FROM backup_profile"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM backup_game"),
    ]);
    return { profiles: profiles.results[0].n, games: games.results[0].n };
  }

  it("restores from the old tables until they are dropped", async () => {
    await putLegacy(UID, 3, 1_000, [game(1), game(2)], { shogi_ai_difficulty: "hard" });
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("hard");
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-2", "game-1"]);
    // 写し終わった後も、写せなかった人のために古い表は見る
    await env.BACKUP.prepare("UPDATE backup_move SET copied_at = 1 WHERE id = 1").run();
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("hard");
    // 表ごと消した後は見に行かない
    await env.BACKUP.prepare("UPDATE backup_move SET dropped_at = 2 WHERE id = 1").run();
    expect((await restore("profile")).profile).toBeNull();
  });

  it("builds on the old backup when someone sends only their newest game after the switch", async () => {
    await putLegacy(UID, 5, 1_000, [game(1), game(2)], { shogi_ai_difficulty: "hard" });
    // ブラウザは前回からの差分しか送らない。対局数が減る送信（消えた直後）でも、古い控えの設定を残す
    await post("/api/backup", { uid: UID, profile: profile(1, 0, { shogi_ai_difficulty: "easy" }), games: [game(3)] });
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-3", "game-2", "game-1"]);
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("hard");
    await post("/api/backup", { uid: UID, profile: profile(6, 0, { shogi_ai_difficulty: "super" }), games: [game(4)] });
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("super");
  });

  it("copies everyone, keeps when they were last seen, waits two weeks, then empties and drops the old tables", async () => {
    const start = Date.now();
    await putLegacy(UID, 2, 1_000, [game(1)]);
    await putLegacy(OTHER, 4, 2_000, [game(2), game(3)]);
    // OTHER は切り替えの後に1局送ってきている
    await post("/api/backup", { uid: OTHER, profile: profile(5), games: [game(4)] });

    await stepBackupMove(env.BACKUP, env.DB, start);
    expect(await stored(UID)).toEqual({ progress: 2, updatedAt: 1_000, ids: ["game-1"] });
    expect(await stored(OTHER)).toMatchObject({ progress: 5, ids: ["game-4", "game-3", "game-2"] });
    expect((await moveState())?.copied_at).toBe(start);
    expect(await legacyLeft()).toEqual({ profiles: 2, games: 3 });

    // 写し終わってから2週間は古い表を残す
    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS - 60_000);
    expect(await legacyLeft()).toEqual({ profiles: 2, games: 3 });

    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS);
    expect(await legacyLeft()).toBeNull();
    expect((await moveState())?.dropped_at).toBe(start + KEEP_LEGACY_MS);
    // 古い表が無くなっても、控えの読み書きは新しい DB だけで続く
    expect((await restore("games", OTHER)).games?.map((g) => g.id)).toEqual(["game-4", "game-3", "game-2"]);
    expect((await post("/api/backup", { uid: UID, profile: profile(3), games: [game(5)] })).status).toBe(200);
    expect((await stored(UID))?.ids).toEqual(["game-5", "game-1"]);
    const newcomer = "44444444-5555-4666-8777-888888888888";
    expect((await post("/api/backup", { uid: newcomer, profile: profile(3), games: [game(6)] })).status).toBe(200);
    expect((await restore("games", newcomer)).games?.map((g) => g.id)).toEqual(["game-6"]);
    // その後の Cron は何もしない
    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS + 60_000);
  });

  it("keeps settings changed after the switch when the record is the same size", async () => {
    await putLegacy(UID, 3, 1_000, [game(1)], { shogi_ai_difficulty: "hard" });
    await post("/api/backup", { uid: UID, profile: profile(3, 0, { shogi_ai_difficulty: "super" }) });
    await stepBackupMove(env.BACKUP, env.DB, Date.now());
    expect((await restore("profile")).profile?.local.shogi_ai_difficulty).toBe("super");
    expect((await restore("games")).games?.map((g) => g.id)).toEqual(["game-1"]);
  });

  it("copies more people than one cron run handles, over several runs", async () => {
    const uids = Array.from({ length: 305 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (let i = 0; i < uids.length; i += 50) {
      await env.DB.batch(uids.slice(i, i + 50).map((uid) =>
        env.DB.prepare("INSERT INTO backup_profile (uid, data, progress, updated_at) VALUES (?1, ?2, 1, 1000)").bind(uid, JSON.stringify(profile(1)))));
    }
    const start = Date.now();
    await stepBackupMove(env.BACKUP, env.DB, start);
    expect(await backupRows()).toBe(300);
    expect((await moveState())?.copied_at).toBeNull();
    await stepBackupMove(env.BACKUP, env.DB, start + 60_000);
    expect(await backupRows()).toBe(305);
    expect((await moveState())?.copied_at).toBe(start + 60_000);
  });

  it("keeps the newest 100 when old and new games add up to more, and still lets the old rows go", async () => {
    const start = Date.now();
    await putLegacy(UID, 100, 1_000, Array.from({ length: BACKUP_GAMES_KEPT }, (_, i) => game(i + 1)));
    await post("/api/backup", { uid: UID, profile: profile(105), games: [101, 102, 103, 104, 105].map((n) => game(n)) });
    await stepBackupMove(env.BACKUP, env.DB, start);
    const ids = (await stored(UID))?.ids;
    expect(ids).toHaveLength(BACKUP_GAMES_KEPT);
    expect(ids?.[0]).toBe("game-105");
    expect(ids?.at(-1)).toBe("game-6");
    // 押し出された5局が新しい行に無くても、確かめは通って古い行を消せる
    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS);
    expect(await legacyLeft()).toBeNull();
  });

  it("leaves an unreadable person's old rows alone, and retries only them until the tables can be dropped", async () => {
    const start = Date.now();
    await putLegacy(UID, 1, 1_000, [game(1)]);
    await putLegacy(OTHER, 1, 1_000, []);
    await env.DB.prepare("INSERT INTO backup_game (uid, id, ended_at, data) VALUES (?1, 'broken', 5, '{broken')").bind(OTHER).run();

    await stepBackupMove(env.BACKUP, env.DB, start);
    expect((await stored(UID))?.ids).toEqual(["game-1"]);
    expect(await stored(OTHER)).toBeNull();
    expect((await moveState())?.copied_at).toBe(start);

    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS);
    expect(await legacyLeft()).toEqual({ profiles: 1, games: 1 });
    expect((await moveState())?.dropped_at).toBeNull();

    // 読めるようになれば（一時的な失敗なら）、残った人だけをやり直して表を消せる
    await env.DB.prepare("UPDATE backup_game SET data = ?1 WHERE uid = ?2").bind(JSON.stringify({ ...game(5), id: "broken" }), OTHER).run();
    await stepBackupMove(env.BACKUP, env.DB, start + KEEP_LEGACY_MS + 60_000);
    expect((await stored(OTHER))?.ids).toEqual(["broken"]);
    expect(await legacyLeft()).toBeNull();
  });

  it("is driven by the every-minute cron of the worker", async () => {
    await putLegacy(UID, 2, 1_000, [game(1)]);
    const controller = createScheduledController({ scheduledTime: new Date(), cron: "* * * * *" });
    await worker.scheduled(controller, env as unknown as Env);
    expect((await stored(UID))?.ids).toEqual(["game-1"]);
  });

  it("lets an old game be missing only when newer games pushed it out of the newest 100", () => {
    const old = [game(1), game(2)] as BackupGame[];
    expect(legacyGamesKept(old, [game(2), game(1)] as BackupGame[])).toBe(true);
    expect(legacyGamesKept(old, [game(2)] as BackupGame[])).toBe(false);
    const newer = Array.from({ length: BACKUP_GAMES_KEPT }, (_, i) => game(i + 3)).reverse() as BackupGame[];
    expect(legacyGamesKept(old, newer)).toBe(true);
    expect(legacyGamesKept([game(500)] as BackupGame[], newer)).toBe(false);
  });
});
