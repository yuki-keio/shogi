// SPDX-License-Identifier: GPL-3.0-only

// 設定・進み具合・戦績の控え（POST /api/backup）と、その取り出し（POST /api/backup/restore）。
//
// Safari系（iPhone・iPadの全ブラウザとMacのSafari）は、しばらく触られていないサイトの
// localStorage・IndexedDB を自動で消す。サーバーが発行した Cookie は消さないので、
// 控えの鍵の uid を Cookie にも入れておき、ブラウザ内から uid が消えていたら Cookie の uid で戻す。
//
// 控えは専用の D1（env.BACKUP）に1人1行で持ち、設定・進み具合と直近100局をそれぞれ圧縮する。
// 棋譜を1局1行で持っていたころは、上限を超えた古い局を消した跡が新しい局に使い回されず、
// 人数が増えなくても容量が増え続けた（1局足すと約1.4KB増え、1局消しても0.5KBほどしか戻らない）。
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
/** JavaScript の Date が表せる最大の時刻（ミリ秒） */
const MAX_DATE_MS = 8.64e15;
/** Cookie の寿命。ブラウザが受け付ける上限（Chrome の400日）。控えを送るたびに延びる。段級位を戻す鍵も兼ねる */
const BACKUP_COOKIE_TTL_SECONDS = 400 * 24 * 60 * 60;
/**
 * 最後に受け取ってから控えを持つ期間。Safari が消すのは来なくなって30日ほど後なので、それより十分長く取る。
 * 容量はほぼこの日数に比例する。控えのデータベースが5GBを超えたら90日に縮める
 * （プライバシーポリシーには「180日を過ぎたものは削除」と書いてあるので、縮める分には書き直さなくてよい）
 */
export const BACKUP_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
/** 長く来ていない人の控えを1回に消す人数。一度に大量に消すと D1 の時間切れになる */
const PRUNE_BATCH = 500;
/** 同じ人の送信が同時に届いて書き込みがぶつかったときに、読み直して重ね直す回数 */
const WRITE_ATTEMPTS = 3;

export const BACKUP_COOKIE_NAME = "__Host-shogi_uid";

/**
 * 控えのデータベースがこの大きさを超えたら控えを受け付けない（1データベースの上限は10GB）。
 * 大量の書き込みで埋まりきって、掃除の書き込みまでできなくなるのを防ぐ。止まったらログに出る
 */
export const BACKUP_DB_SOFT_LIMIT_BYTES = 9e9;

/**
 * 控えの鍵を入れる Cookie。
 * - __Host- ＋ Domain なし: shogi.yuki-lab.com にだけ届く（同じドメインの他のアプリと混ざらない）
 * - HttpOnly にしない: ページを開いた瞬間に、通信せずに「消えたかどうか」を判定するため。
 *   uid はもともと localStorage にあってページから読めるので、読めても危なさは変わらない。
 *   サーバーが発行した Cookie であれば、ページから読めても自動削除の対象にはならない
 */
export function backupCookie(uid: string): string {
  return `${BACKUP_COOKIE_NAME}=${uid}; Max-Age=${BACKUP_COOKIE_TTL_SECONDS}; Path=/; Secure; SameSite=Lax`;
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

/** 控えの棋譜1局。中身は確かめず、並べ替えと重複に使う id と endedAt だけを見る */
export type BackupGame = Record<string, unknown> & { id: string; endedAt: number };

/** 1人分の控え。profile は設定・進み具合・戦績の集計の JSON、games は新しい順 */
export interface Backup {
  progress: number;
  updatedAt: number;
  profile: string;
  games: BackupGame[];
}

// ---- 圧縮 ----------------------------------------------------------------------
// 棋譜の JSON は1人分まとめると3分の1以下になる（実データで平均10.8KB→3.2KB）

/** D1 の BLOB は、書くときは ArrayBuffer で渡し、読むと数の配列で返ってくる */
export type StoredBytes = ArrayBuffer | ArrayBufferView | number[];

export async function packText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unpackText(bytes: StoredBytes): Promise<string> {
  const data = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

// ---- 重ね方 --------------------------------------------------------------------

/** 新しい順。SQL の ORDER BY ended_at DESC, id DESC と同じ */
export function newerFirst(a: BackupGame, b: BackupGame): number {
  return b.endedAt - a.endedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** 重複を除いて新しい順に並べ、上限まで残す。同じ id は先に来た方を残す */
export function mergeGames(kept: readonly BackupGame[], added: readonly BackupGame[]): BackupGame[] {
  const seen = new Set<string>();
  const games: BackupGame[] = [];
  for (const game of [...kept, ...added]) {
    if (seen.has(game.id)) continue;
    seen.add(game.id);
    games.push(game);
  }
  return games.sort(newerFirst).slice(0, BACKUP_GAMES_KEPT);
}

/**
 * 控えに後から来た分を重ねる。棋譜は足すだけで、設定・進み具合は対局数＋詰将棋のクリア数が減らないときだけ置き換える
 * （減るのは、消えた直後の空に近い状態からの送信。それで控えを上書きさせない）
 */
export function mergeBackup(base: Backup, later: Backup): Backup {
  const replace = later.progress >= base.progress;
  return {
    progress: replace ? later.progress : base.progress,
    profile: replace ? later.profile : base.profile,
    updatedAt: Math.max(base.updatedAt, later.updatedAt),
    games: mergeGames(base.games, later.games),
  };
}

export function sameBackup(a: Backup, b: Backup): boolean {
  return a.progress === b.progress
    && a.updatedAt === b.updatedAt
    && a.profile === b.profile
    && a.games.length === b.games.length
    && a.games.every((game, i) => game.id === b.games[i].id);
}

// ---- 読み書き ------------------------------------------------------------------

export interface StoredBackup {
  version: number;
  progress: number;
  updated_at: number;
  profile: StoredBytes;
  games: StoredBytes;
}

export const SELECT_BACKUP = "SELECT version, progress, updated_at, profile, games FROM backup";

export async function decodeBackup(row: StoredBackup): Promise<Backup> {
  return {
    progress: row.progress,
    updatedAt: row.updated_at,
    profile: await unpackText(row.profile),
    games: JSON.parse(await unpackText(row.games)) as BackupGame[],
  };
}

/**
 * 控えを書く。version は読んだときの版（行が無かったら 0）。その後に別の書き込みが入っていたら書かずに false を返すので、
 * 読み直して重ね直す（同じ人の送信が2つのタブから同時に届いても、片方の棋譜を落とさないため）
 */
export async function writeBackup(db: D1Database, uid: string, version: number, backup: Backup): Promise<boolean> {
  const profile = await packText(backup.profile);
  const games = await packText(JSON.stringify(backup.games));
  const lastGameAt = backup.games[0]?.endedAt ?? null;
  const statement = version === 0
    ? db.prepare(
      `INSERT INTO backup (uid, progress, updated_at, version, game_count, last_game_at, profile, games)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7) ON CONFLICT(uid) DO NOTHING`,
    ).bind(uid, backup.progress, backup.updatedAt, backup.games.length, lastGameAt, profile, games)
    : db.prepare(
      `UPDATE backup SET progress = ?2, updated_at = ?3, version = version + 1, game_count = ?4,
         last_game_at = ?5, profile = ?6, games = ?7
       WHERE uid = ?1 AND version = ?8`,
    ).bind(uid, backup.progress, backup.updatedAt, backup.games.length, lastGameAt, profile, games, version);
  const { meta } = await statement.run();
  return meta.changes > 0;
}

/** 送られてきた控えを確かめる。中身の細かい検査はしない（戻すときにブラウザ側で確かめる） */
function parseBackup(body: Record<string, unknown>, nowMs: number): Backup | Failure {
  const profile = body.profile;
  if (!isRecord(profile) || profile.v !== 1 || !isRecord(profile.local)) {
    return invalid("profile is required");
  }
  const profileJson = JSON.stringify(profile);
  if (profileJson.length > PROFILE_MAX_LENGTH) return invalid("profile is too large");

  const games = body.games === undefined ? [] : body.games;
  if (!Array.isArray(games) || games.length > BACKUP_GAMES_KEPT) return invalid("games must be an array");
  const parsed: BackupGame[] = [];
  for (const game of games) {
    if (!isRecord(game)) return invalid("game must be an object");
    const { id, endedAt } = game;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return invalid("game id is invalid");
    // Date で扱える上限（8.64e15）を超える値は、戻したときに戦績ページの日付表示が例外で止まる。
    // 端末の時計が狂っている人もいるので、未来の日付そのものは拒まない
    if (!Number.isSafeInteger(endedAt) || (endedAt as number) < 0 || (endedAt as number) > MAX_DATE_MS) {
      return invalid("game endedAt is invalid");
    }
    if (JSON.stringify(game).length > GAME_MAX_LENGTH) return invalid("game is too large");
    parsed.push(game as BackupGame);
  }
  return { progress: backupProgress(profile), updatedAt: nowMs, profile: profileJson, games: parsed };
}

/** 控えを受け取る。守るのは大きさと、控えを空に近い状態で上書きさせないことだけ */
export async function saveBackup(
  db: D1Database,
  legacy: D1Database,
  uid: string,
  body: Record<string, unknown>,
  nowMs: number,
  softLimitBytes = BACKUP_DB_SOFT_LIMIT_BYTES,
): Promise<{ ok: true } | Failure> {
  const received = parseBackup(body, nowMs);
  if ("ok" in received) return received;

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const { results, meta } = await db.prepare(`${SELECT_BACKUP} WHERE uid = ?1`).bind(uid).run<StoredBackup>();
    if (meta.size_after > softLimitBytes) {
      console.error("backup paused: database size", meta.size_after);
      return { ok: false, error: { code: "backup_paused", message: "Backups are paused" } };
    }
    const stored = results[0];
    // まだ行が無い人は、古い表に残っている控えを土台にする（移し替えの途中だけ。ブラウザは前回からの差分しか送らない）
    const base = stored ? await decodeBackup(stored) : await readLegacyBackup(db, legacy, uid);
    const next = mergeBackup(base ?? { ...received, games: [] }, received);
    if (await writeBackup(db, uid, stored?.version ?? 0, next)) return { ok: true };
  }
  return { ok: false, error: { code: "backup_busy", message: "Backup is busy; try again later" } };
}

/** 控えの設定・進み具合（JSON文字列のまま）。無ければ null */
export async function loadBackupProfile(db: D1Database, legacy: D1Database, uid: string): Promise<string | null> {
  const row = await db.prepare("SELECT profile FROM backup WHERE uid = ?1").bind(uid).first<{ profile: StoredBytes }>();
  if (row) return unpackText(row.profile);
  return (await readLegacyBackup(db, legacy, uid))?.profile ?? null;
}

/** 控えの棋譜（新しい順の JSON 配列の文字列） */
export async function loadBackupGames(db: D1Database, legacy: D1Database, uid: string): Promise<string> {
  const row = await db.prepare("SELECT games FROM backup WHERE uid = ?1").bind(uid).first<{ games: StoredBytes }>();
  if (row) return unpackText(row.games);
  return JSON.stringify((await readLegacyBackup(db, legacy, uid))?.games ?? []);
}

/** 最後に受け取ってから BACKUP_KEEP_MS たった控えを消す。送信のついでにときどき呼ぶ */
export async function pruneInactiveBackups(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare("DELETE FROM backup WHERE uid IN (SELECT uid FROM backup WHERE updated_at < ?1 LIMIT ?2)")
    .bind(nowMs - BACKUP_KEEP_MS, PRUNE_BATCH)
    .run();
}

// ---- 移し替えの間だけ使う（本体の DB の古い表 backup_profile・backup_game）---------------
// 古い表を表ごと消し終わったら（backup_move.dropped_at が入ったら。backup_move.ts）、ここから下は外す。
// 写し終わっただけで外すと、写せなかった人の復元が「控え無し」になり、ブラウザは二度と取りに来ない

/**
 * 古い表がまだあるか。写し終わった後も、写せなかった人の行は残るので、表ごと消すまでは
 * 新しい行が無い人だけ古い表も見る。分からないときは「ある」と答える（無いと答えると復元を取りこぼす）
 */
async function legacyInUse(db: D1Database): Promise<boolean> {
  const state = await db.prepare("SELECT dropped_at FROM backup_move WHERE id = 1").first<{ dropped_at: number | null }>();
  return state == null || state.dropped_at == null;
}

interface LegacyProfile {
  data: string;
  progress: number;
  updated_at: number;
}

export function legacyBackup(profile: LegacyProfile, games: readonly string[]): Backup {
  return {
    progress: profile.progress,
    updatedAt: profile.updated_at,
    profile: profile.data,
    games: mergeGames([], games.map((json) => JSON.parse(json) as BackupGame)),
  };
}

async function readLegacyBackup(db: D1Database, legacy: D1Database, uid: string): Promise<Backup | null> {
  if (!(await legacyInUse(db))) return null;
  const [profiles, games] = await legacy.batch([
    legacy.prepare("SELECT data, progress, updated_at FROM backup_profile WHERE uid = ?1").bind(uid),
    legacy.prepare("SELECT data FROM backup_game WHERE uid = ?1").bind(uid),
  ]);
  const profile = (profiles.results as LegacyProfile[])[0];
  if (!profile) return null;
  return legacyBackup(profile, (games.results as Array<{ data: string }>).map((row) => row.data));
}
