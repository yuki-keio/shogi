// SPDX-License-Identifier: GPL-3.0-only

// 控えを、本体の DB の古い表（backup_profile・backup_game）から控え専用の DB（env.BACKUP）へ移す。
// 1分ごとの Cron で少しずつ進め、デプロイのほかに人の手は要らない。
//   1. 写す: 古い表の人を rowid 順にたどり、新しい行と重ねて書く（送信で先に行ができた人も、上書きも飛ばしもしない）
//   2. 待つ: 写し終わってから KEEP_LEGACY_MS は古い表をそのまま残す（確かめて、問題があれば直してデプロイし止める）
//   3. 消す: もう一度重ねてから、古い棋譜が新しい行に入っているのを読み直して確かめ、その人の古い行を消す
//   4. 古い表が空になったら表ごと消す（マイグレーションはコードより先に走るので、ここで消す）
// 新しい行が無い人の送信と復元は、表ごと消すまで古い表も見る（backup.ts）。写せなかった人がいても取りこぼさない。
// 終わったら（backup_move.dropped_at が入ったら）、この処理・Cron・backup.ts の古い表を読む部分を外す。

import {
  BACKUP_GAMES_KEPT,
  type Backup,
  type BackupGame,
  SELECT_BACKUP,
  type StoredBackup,
  type StoredBytes,
  decodeBackup,
  legacyBackup,
  mergeBackup,
  newerFirst,
  sameBackup,
  unpackText,
  writeBackup,
} from "./backup";

/** 写し終わってから古い表を残す期間 */
export const KEEP_LEGACY_MS = 14 * 24 * 60 * 60 * 1000;
/** 1回にまとめて扱う人数（1つの SQL に渡せる値は100個まで） */
const CHUNK = 100;
/** 1回の Cron で進める回数（1回の呼び出しで使える D1 の問い合わせは1000回まで） */
const CHUNKS_PER_RUN = 3;
/** 書き込みがぶつかったときに読み直す回数 */
const WRITE_ATTEMPTS = 3;

interface MoveState {
  copied_rowid: number;
  copied_at: number | null;
  deleted_rowid: number;
  dropped_at: number | null;
}

interface LegacyUser {
  rowid: number;
  uid: string;
  data: string;
  progress: number;
  updated_at: number;
}

export async function stepBackupMove(db: D1Database, legacy: D1Database, nowMs: number): Promise<void> {
  const state = await db
    .prepare("SELECT copied_rowid, copied_at, deleted_rowid, dropped_at FROM backup_move WHERE id = 1")
    .first<MoveState>();
  if (!state || state.dropped_at != null) return;
  if (state.copied_at == null) {
    await copyLegacy(db, legacy, state.copied_rowid, nowMs);
  } else if (nowMs - state.copied_at >= KEEP_LEGACY_MS) {
    await deleteLegacy(db, legacy, state.deleted_rowid, nowMs);
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");
}

async function legacyUsers(legacy: D1Database, afterRowid: number): Promise<LegacyUser[]> {
  const { results } = await legacy
    .prepare("SELECT rowid, uid, data, progress, updated_at FROM backup_profile WHERE rowid > ?1 ORDER BY rowid LIMIT ?2")
    .bind(afterRowid, CHUNK)
    .all<LegacyUser>();
  return results;
}

async function legacyGames(legacy: D1Database, uids: string[]): Promise<Map<string, string[]>> {
  const { results } = await legacy
    .prepare(`SELECT uid, data FROM backup_game WHERE uid IN (${placeholders(uids.length)})`)
    .bind(...uids)
    .all<{ uid: string; data: string }>();
  const byUid = new Map<string, string[]>();
  for (const row of results) {
    const list = byUid.get(row.uid);
    if (list) list.push(row.data);
    else byUid.set(row.uid, [row.data]);
  }
  return byUid;
}

/** 古い表の控えを新しい行に重ねる。重ね終わった（もう重ねるものが無い）人の uid を返す */
async function mergeLegacy(db: D1Database, users: LegacyUser[], games: Map<string, string[]>): Promise<Set<string>> {
  const uids = users.map((user) => user.uid);
  // 1人ずつ読むと問い合わせの数が上限（1回の呼び出しで1000回）に近づくので、最初はまとめて読む
  const { results } = await db
    .prepare(`SELECT uid, version, progress, updated_at, profile, games FROM backup WHERE uid IN (${placeholders(uids.length)})`)
    .bind(...uids)
    .all<StoredBackup & { uid: string }>();
  const prefetched = new Map(results.map((row) => [row.uid, row]));
  const done = new Set<string>();
  for (const user of users) {
    // 1人分が読めなくても、ほかの人の移し替えは止めない（その人の古い行は消さずに残る）
    try {
      const old = legacyBackup(user, games.get(user.uid) ?? []);
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const stored = attempt === 0
          ? prefetched.get(user.uid)
          : await db.prepare(`${SELECT_BACKUP} WHERE uid = ?1`).bind(user.uid).first<StoredBackup>();
        const current = stored ? await decodeBackup(stored) : null;
        // 新しい行の方が後なので、設定・進み具合は対局数＋クリア数が同じなら新しい行を残す。最後に受け取った時刻は古い表の値を引き継ぐ
        const next = current ? mergeBackup(old, current) : old;
        if ((current && sameBackup(current, next)) || (await writeBackup(db, user.uid, stored?.version ?? 0, next))) {
          done.add(user.uid);
          break;
        }
      }
    } catch (e) {
      console.error("backup move: could not read", user.uid.slice(0, 8), e);
    }
    if (!done.has(user.uid)) console.error("backup move: could not merge", user.uid.slice(0, 8));
  }
  return done;
}

async function copyLegacy(db: D1Database, legacy: D1Database, afterRowid: number, nowMs: number): Promise<void> {
  let cursor = afterRowid;
  for (let i = 0; i < CHUNKS_PER_RUN; i++) {
    const users = await legacyUsers(legacy, cursor);
    if (users.length === 0) {
      await db.prepare("UPDATE backup_move SET copied_at = ?1 WHERE id = 1").bind(nowMs).run();
      console.log("backup move: copied all");
      return;
    }
    // 重ねられなかった人は、消す段階でもう一度重ねる
    await mergeLegacy(db, users, await legacyGames(legacy, users.map((user) => user.uid)));
    cursor = users[users.length - 1].rowid;
    await db.prepare("UPDATE backup_move SET copied_rowid = ?1 WHERE id = 1").bind(cursor).run();
  }
}

/**
 * 古い棋譜が新しい行に入っているか。入っていなくてよいのは、後から届いた新しい棋譜に押し出されて
 * 直近100局から外れたものだけ
 */
export function legacyGamesKept(oldGames: readonly BackupGame[], stored: readonly BackupGame[]): boolean {
  const ids = new Set(stored.map((game) => game.id));
  const oldest = stored.length >= BACKUP_GAMES_KEPT ? stored[stored.length - 1] : null;
  return oldGames.every((game) => ids.has(game.id) || (oldest != null && newerFirst(game, oldest) > 0));
}

/** 消す前に、新しい行を読み直して確かめる（重ねた結果でなく、実際に書かれた中身で） */
async function verifiedUids(db: D1Database, users: LegacyUser[], games: Map<string, string[]>): Promise<string[]> {
  const uids = users.map((user) => user.uid);
  const { results } = await db
    .prepare(`SELECT uid, games FROM backup WHERE uid IN (${placeholders(uids.length)})`)
    .bind(...uids)
    .all<{ uid: string; games: StoredBytes }>();
  const stored = new Map(results.map((row) => [row.uid, row.games]));
  const verified: string[] = [];
  for (const user of users) {
    const bytes = stored.get(user.uid);
    try {
      const kept = bytes ? (JSON.parse(await unpackText(bytes)) as BackupGame[]) : null;
      const old: Backup = legacyBackup(user, games.get(user.uid) ?? []);
      if (kept && legacyGamesKept(old.games, kept)) {
        verified.push(user.uid);
        continue;
      }
    } catch {
      // 読めない人は確かめられなかった扱い
    }
    console.error("backup move: kept legacy rows of", user.uid.slice(0, 8));
  }
  return verified;
}

async function deleteLegacy(db: D1Database, legacy: D1Database, afterRowid: number, nowMs: number): Promise<void> {
  let cursor = afterRowid;
  for (let i = 0; i < CHUNKS_PER_RUN; i++) {
    const users = await legacyUsers(legacy, cursor);
    if (users.length === 0) {
      await dropLegacy(db, legacy, nowMs);
      return;
    }
    // 写した後に古い表へ書かれた分（デプロイの切り替わり中の送信）も拾うため、もう一度重ねる
    const games = await legacyGames(legacy, users.map((user) => user.uid));
    await mergeLegacy(db, users, games);
    const verified = await verifiedUids(db, users, games);
    if (verified.length > 0) {
      const marks = placeholders(verified.length);
      await legacy.batch([
        legacy.prepare(`DELETE FROM backup_game WHERE uid IN (${marks})`).bind(...verified),
        legacy.prepare(`DELETE FROM backup_profile WHERE uid IN (${marks})`).bind(...verified),
      ]);
    }
    // 確かめられなかった人の古い行は残し、先へ進む（表は空にならないので消さない）
    cursor = users[users.length - 1].rowid;
    await db.prepare("UPDATE backup_move SET deleted_rowid = ?1 WHERE id = 1").bind(cursor).run();
  }
}

async function dropLegacy(db: D1Database, legacy: D1Database, nowMs: number): Promise<void> {
  const [profiles, games] = await legacy.batch<{ n: number }>([
    legacy.prepare("SELECT COUNT(*) AS n FROM backup_profile"),
    legacy.prepare("SELECT COUNT(*) AS n FROM backup_game"),
  ]);
  const left = (profiles.results[0]?.n ?? 0) + (games.results[0]?.n ?? 0);
  if (left > 0) {
    // 確かめられなかった人だけが残っている。一時的な失敗なら次で通るよう、残った人を頭からやり直す
    console.error("backup move: legacy rows left", profiles.results[0]?.n, games.results[0]?.n);
    await db.prepare("UPDATE backup_move SET deleted_rowid = 0 WHERE id = 1").run();
    return;
  }
  // 先に印を付けて、送信と復元が古い表を見に行かないようにしてから消す（消した後に見に行くと、表が無くて失敗する）
  await db.prepare("UPDATE backup_move SET dropped_at = ?1 WHERE id = 1").bind(nowMs).run();
  await legacy.batch([legacy.prepare("DROP TABLE IF EXISTS backup_game"), legacy.prepare("DROP TABLE IF EXISTS backup_profile")]);
  console.log("backup move: dropped legacy tables");
}
