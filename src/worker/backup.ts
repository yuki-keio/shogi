// SPDX-License-Identifier: GPL-3.0-only

// 設定・進み具合・戦績の控え（POST /api/backup）と、その取り出し（POST /api/backup/restore）。
//
// Safari系（iPhone・iPadの全ブラウザとMacのSafari）は、しばらく触られていないサイトの
// localStorage・IndexedDB を自動で消す。サーバーが発行した Cookie は消さないので、
// 控えの鍵の uid を Cookie にも入れておき、ブラウザ内から uid が消えていたら Cookie の uid で戻す。
//
// 🔴 uid は通信対戦の再接続の合鍵も兼ねている（他人には一切出さない）。控えもこの uid でしか読めない。
// 🔴 Cookie は /api/ の応答にだけ付ける。キャッシュされる応答に付けると他人に配られうる。

/** 1回の送信の上限。初回は直近100局をまとめて送るので、1局1KB前後×100に余裕を見た値 */
export const BACKUP_MAX_BYTES = 256 * 1024;
/** 設定・進み具合・戦績の集計。ふつうは数KB */
const PROFILE_MAX_LENGTH = 48 * 1024;
/** 1局の棋譜。300手でも3KB程度 */
const GAME_MAX_LENGTH = 16 * 1024;
/** 1人あたりに持つ棋譜の数（新しい順） */
export const BACKUP_GAMES_KEPT = 100;
/** Cookie の寿命。ブラウザが受け付ける上限（Chrome の400日）。控えを送るたびに延びる */
const BACKUP_TTL_SECONDS = 400 * 24 * 60 * 60;

export const BACKUP_COOKIE_NAME = "__Host-shogi_uid";

/**
 * データベースがこの大きさを超えたら控えを受け付けない。控えは実力値と同じデータベース（上限10GB）に入るので、
 * 控えや、それを狙った大量の書き込みで埋まって、実力値が書けなくなるのを防ぐ。止まったらログに出る
 */
export const BACKUP_DB_SOFT_LIMIT_BYTES = 8 * 1024 ** 3;

/**
 * 控えの鍵を入れる Cookie。
 * - __Host- ＋ Domain なし: shogi.yuki-lab.com にだけ届く（同じドメインの他のアプリと混ざらない）
 * - HttpOnly にしない: ページを開いた瞬間に、通信せずに「消えたかどうか」を判定するため。
 *   uid はもともと localStorage にあってページから読めるので、読めても危なさは変わらない。
 *   サーバーが発行した Cookie であれば、ページから読めても自動削除の対象にはならない
 */
export function backupCookie(uid: string): string {
  return `${BACKUP_COOKIE_NAME}=${uid}; Max-Age=${BACKUP_TTL_SECONDS}; Path=/; Secure; SameSite=Lax`;
}

type Failure = { ok: false; error: { code: string; message: string } };

function invalid(message: string): Failure {
  return { ok: false, error: { code: "bad_backup", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

/** 対局数＋詰将棋のクリア数。どちらも増える一方なので、正しい更新でこれが減ることはない */
export function backupProgress(profile: Record<string, unknown>): number {
  const records = profile.records;
  if (!isRecord(records)) return 0;
  const all = Array.isArray(records.summaries)
    ? records.summaries.find((summary) => isRecord(summary) && summary.mode === "all")
    : null;
  const tsume = isRecord(records.tsumeSummary) ? records.tsumeSummary : null;
  return count(isRecord(all) ? all.games : 0) + count(tsume?.cleared);
}

/**
 * 控えを受け取る。中身の細かい検査はしない（戻すときにブラウザ側で確かめる）。
 * ここで守るのは大きさと、控えを空に近い状態で上書きさせないことだけ。
 */
export async function saveBackup(
  db: D1Database,
  uid: string,
  body: Record<string, unknown>,
  nowMs: number,
  softLimitBytes = BACKUP_DB_SOFT_LIMIT_BYTES,
): Promise<{ ok: true } | Failure> {
  const profile = body.profile;
  if (!isRecord(profile) || profile.v !== 1 || !isRecord(profile.local)) {
    return invalid("profile is required");
  }
  const profileJson = JSON.stringify(profile);
  if (profileJson.length > PROFILE_MAX_LENGTH) return invalid("profile is too large");

  const games = body.games === undefined ? [] : body.games;
  if (!Array.isArray(games) || games.length > BACKUP_GAMES_KEPT) return invalid("games must be an array");
  const rows: Array<{ id: string; endedAt: number; json: string }> = [];
  for (const game of games) {
    if (!isRecord(game)) return invalid("game must be an object");
    const { id, endedAt } = game;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return invalid("game id is invalid");
    if (!Number.isSafeInteger(endedAt) || (endedAt as number) < 0) return invalid("game endedAt is invalid");
    const json = JSON.stringify(game);
    if (json.length > GAME_MAX_LENGTH) return invalid("game is too large");
    rows.push({ id, endedAt: endedAt as number, json });
  }

  const { meta } = await db.prepare("SELECT 1").run();
  if (meta.size_after > softLimitBytes) {
    console.error("backup paused: database size", meta.size_after);
    return { ok: false, error: { code: "backup_paused", message: "Backups are paused" } };
  }

  await db.batch([
    // 減る書き込みは黙って捨てる（棋譜は足すだけなので、下の INSERT は通してよい）
    db.prepare(
      `INSERT INTO backup_profile (uid, data, progress, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(uid) DO UPDATE SET data = excluded.data, progress = excluded.progress, updated_at = excluded.updated_at
       WHERE excluded.progress >= backup_profile.progress`,
    ).bind(uid, profileJson, backupProgress(profile), nowMs),
    ...rows.map((row) =>
      db.prepare("INSERT OR IGNORE INTO backup_game (uid, id, ended_at, data) VALUES (?1, ?2, ?3, ?4)")
        .bind(uid, row.id, row.endedAt, row.json),
    ),
    db.prepare(
      `DELETE FROM backup_game WHERE uid = ?1 AND rowid NOT IN (
         SELECT rowid FROM backup_game WHERE uid = ?1 ORDER BY ended_at DESC, id DESC LIMIT ?2)`,
    ).bind(uid, BACKUP_GAMES_KEPT),
  ]);
  return { ok: true };
}

/** 控えの本体（JSON文字列のまま）。無ければ null */
export async function loadBackupProfile(db: D1Database, uid: string): Promise<string | null> {
  const row = await db.prepare("SELECT data FROM backup_profile WHERE uid = ?1").bind(uid).first<{ data: string }>();
  return row?.data ?? null;
}

/** 控えの棋譜（JSON文字列のまま、新しい順） */
export async function loadBackupGames(db: D1Database, uid: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT data FROM backup_game WHERE uid = ?1 ORDER BY ended_at DESC, id DESC LIMIT ?2")
    .bind(uid, BACKUP_GAMES_KEPT)
    .all<{ data: string }>();
  return (results ?? []).map((row) => row.data);
}

/** Cookie の寿命が切れた人の控えを消す。送信のついでにときどき呼ぶ */
export async function pruneInactiveBackups(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = nowMs - BACKUP_TTL_SECONDS * 1000;
  await db.batch([
    db.prepare("DELETE FROM backup_game WHERE uid IN (SELECT uid FROM backup_profile WHERE updated_at < ?1)").bind(cutoff),
    db.prepare("DELETE FROM backup_profile WHERE updated_at < ?1").bind(cutoff),
  ]);
}
