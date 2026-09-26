// SPDX-License-Identifier: GPL-3.0-only

import {
  addGameToSummary,
  addTsumeToSummary,
  emptySummary,
  emptyTsumeSummary,
  mergeSummaries,
  mergeTsumeSummaries,
  modeGroup,
  normalizeGame,
  normalizeTsume,
  readGame,
  readSummary,
  readTsume,
  readTsumeSummary,
} from "./model.ts";
import {
  RESTORE_LOCAL_KEY,
  RESTORE_RECORDS_KEY,
  applyLocal,
  collectLocal,
  cookieUid,
  finishRestore,
  fitProfile,
  hasBackedUp,
  markBackedUp,
  markSynced,
  postBackup,
  restorePending,
  syncedUntil,
  worthBackingUp,
} from "./backup.ts";
import type {
  GameCursor,
  GameInput,
  GameRecord,
  GamesPage,
  GamesQuery,
  RecordMode,
  Summary,
  TsumeInput,
  TsumeSummary,
} from "./types.ts";

export type * from "./types.ts";

interface StoredGame extends GameRecord {
  modeGroup: Exclude<RecordMode, "all">;
}

interface WazaReference {
  wazaId: string;
  modeGroup: Exclude<RecordMode, "all">;
  endedAt: number;
  id: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Records storage is unavailable"));
      return;
    }
    const request = indexedDB.open("shogi-records", 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("meta", { keyPath: "key" });
      const games = db.createObjectStore("games", { keyPath: "id" });
      games.createIndex("byEndedAt", ["endedAt", "id"]);
      games.createIndex("byMode", ["modeGroup", "endedAt", "id"]);
      const waza = db.createObjectStore("gameWaza", { keyPath: ["wazaId", "endedAt", "id"] });
      waza.createIndex("byMode", ["wazaId", "modeGroup", "endedAt", "id"]);
      db.createObjectStore("summaries", { keyPath: "mode" });
      db.createObjectStore("tsume", { keyPath: ["date", "problemId"] });
    };
    request.onerror = () => reject(request.error || new Error("Could not open records storage"));
    request.onblocked = () => {
      rejected = true;
      reject(new Error("Records storage is being upgraded in another tab"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) {
        db.close();
        return;
      }
      const release = () => {
        db.close();
        if (databasePromise === pending) databasePromise = null;
      };
      db.onversionchange = release;
      db.onclose = release;
      resolve(db);
    };
  });
  databasePromise = pending;
  void pending.catch(() => {
    if (databasePromise === pending) databasePromise = null;
  });
  return pending;
}

function completed<T>(transaction: IDBTransaction, result: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = () => reject(transaction.error || new Error("Could not save records"));
  });
}

/** 最初の訪問で固定する。旧累計や過去の保存局面の移行は行わない。 */
export async function initialize(startedAt = Date.now()): Promise<{ startedAt: number }> {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new TypeError("Invalid recording start timestamp");
  const db = await database();
  const transaction = db.transaction("meta", "readwrite");
  const meta = transaction.objectStore("meta");
  let tracking = { startedAt };
  const done = completed(transaction, () => tracking);
  const request = meta.get("tracking");
  request.onsuccess = () => {
    if (request.result) tracking = { startedAt: request.result.startedAt };
    else meta.add({ key: "tracking", startedAt });
  };
  return done;
}

/** 対局・技の参照・各モードの小計を同じトランザクションで追加する。 */
export async function saveGame(input: GameInput): Promise<boolean> {
  if (!input.completed || input.source !== "played") return false;
  const { startedAt } = await initialize();
  const game = normalizeGame(input, startedAt);
  if (!game) return false;
  const db = await database();
  const transaction = db.transaction(["games", "gameWaza", "summaries"], "readwrite");
  const games = transaction.objectStore("games");
  const summaries = transaction.objectStore("summaries");
  let saved = false;
  const done = completed(transaction, () => saved);
  const existing = games.get(game.id);
  existing.onsuccess = () => {
    if (existing.result) return;
    const group = modeGroup(game.mode);
    games.add({ ...game, modeGroup: group } satisfies StoredGame);
    const references = transaction.objectStore("gameWaza");
    for (const wazaId of game.wazaIds) {
      references.add({ wazaId, modeGroup: group, endedAt: game.endedAt, id: game.id } satisfies WazaReference);
    }
    for (const mode of ["all", group]) {
      const request = summaries.get(mode);
      request.onsuccess = () => {
        summaries.put({ mode, ...addGameToSummary(request.result || emptySummary(), game) });
      };
    }
    saved = true;
  };
  return done;
}

export async function saveTsume(input: TsumeInput): Promise<boolean> {
  const { startedAt } = await initialize();
  const record = normalizeTsume(input, startedAt);
  if (!record) return false;
  const db = await database();
  const transaction = db.transaction(["tsume", "meta"], "readwrite");
  const tsume = transaction.objectStore("tsume");
  const meta = transaction.objectStore("meta");
  let saved = false;
  const done = completed(transaction, () => saved);
  const existing = tsume.get([record.date, record.problemId]);
  existing.onsuccess = () => {
    if (existing.result) return;
    tsume.add(record);
    const request = meta.get("tsumeSummary");
    request.onsuccess = () => {
      meta.put({ key: "tsumeSummary", ...addTsumeToSummary(request.result || emptyTsumeSummary(), record) });
    };
    saved = true;
  };
  return done;
}

function checkMode(mode: RecordMode): void {
  if (!["all", "ai", "online", "board"].includes(mode)) throw new TypeError("Invalid records mode");
}

export async function getSummary(mode: RecordMode = "all"): Promise<Summary> {
  checkMode(mode);
  await initialize();
  const db = await database();
  const transaction = db.transaction("summaries", "readonly");
  let result = emptySummary();
  const done = completed(transaction, () => result);
  const request = transaction.objectStore("summaries").get(mode);
  request.onsuccess = () => {
    if (request.result) {
      const { mode: _mode, ...summary } = request.result;
      result = summary;
    }
  };
  return done;
}

export async function getTsumeSummary(): Promise<TsumeSummary> {
  await initialize();
  const db = await database();
  const transaction = db.transaction("meta", "readonly");
  let result = emptyTsumeSummary();
  const done = completed(transaction, () => result);
  const request = transaction.objectStore("meta").get("tsumeSummary");
  request.onsuccess = () => {
    if (request.result) {
      const { key: _key, ...summary } = request.result;
      result = summary;
    }
  };
  return done;
}

function rangeFor(prefix: string[], cursor?: GameCursor | null): IDBKeyRange {
  if (cursor && (!Number.isSafeInteger(cursor.endedAt) || cursor.endedAt < 0 || !cursor.id)) {
    throw new TypeError("Invalid records cursor");
  }
  // Array keys sort after numeric timestamps, covering this prefix without a full scan.
  const upper: IDBValidKey[] = cursor ? [...prefix, cursor.endedAt, cursor.id] : [...prefix, []];
  return IDBKeyRange.bound(prefix, upper, false, Boolean(cursor));
}

function publicGame(stored: StoredGame): GameRecord {
  const { modeGroup: _group, ...game } = stored;
  return game;
}

/** 日時＋IDで安定した降順。技別でも専用の参照だけを最大 limit+1 件読む。 */
export async function getGames(query: GamesQuery = {}): Promise<GamesPage> {
  const mode = query.mode || "all";
  checkMode(mode);
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(100, Math.floor(query.limit!))) : 20;
  const filteredByWaza = Boolean(query.wazaId);
  const prefix = filteredByWaza ? [query.wazaId!] : [];
  if (mode !== "all") prefix.push(mode);
  const range = rangeFor(prefix, query.cursor);
  await initialize();
  const db = await database();
  const transaction = db.transaction(filteredByWaza ? ["games", "gameWaza"] : ["games"], "readonly");
  const gamesStore = transaction.objectStore("games");
  let source: IDBIndex | IDBObjectStore;
  if (filteredByWaza) {
    const references = transaction.objectStore("gameWaza");
    source = mode === "all" ? references : references.index("byMode");
  } else {
    source = gamesStore.index(mode === "all" ? "byEndedAt" : "byMode");
  }
  const games: GameRecord[] = [];
  let count = 0;
  let nextCursor: GameCursor | null = null;
  let hasMore = false;
  const done = completed(transaction, () => ({ games, nextCursor: hasMore ? nextCursor : null }));
  const request = source.openCursor(range, "prev");
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (count === limit) {
      hasMore = true;
      return;
    }
    const row = cursor.value as StoredGame | WazaReference;
    const index = count++;
    nextCursor = { endedAt: row.endedAt, id: row.id };
    if (filteredByWaza) {
      const gameRequest = gamesStore.get(row.id);
      gameRequest.onsuccess = () => { games[index] = publicGame(gameRequest.result); };
    } else games[index] = publicGame(row as StoredGame);
    cursor.continue();
  };
  return done;
}

// ---- サーバーの控えとの受け渡し ----

/** 控えに載せる詰将棋の記録の出題日の範囲。過去問を解き直して二重に数えないための控えなので、選べる30日に余裕を見た分だけ */
const TSUME_BACKUP_DAYS = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 控えに載せる棋譜の数。サーバーが持つ数と同じ */
const BACKUP_GAMES_MAX = 100;
/** 送信1回の大きさの目安（サーバーの上限 256KB に余裕を見る） */
const BACKUP_BODY_MAX = 200 * 1024;
/** 送り済みの境目のあたりで終わった対局を取りこぼさないための重なり（重複はサーバーが捨てる） */
const SYNC_OVERLAP_MS = 10 * 60 * 1000;

export interface BackupRecords {
  startedAt: number;
  summaries: Array<Summary & { mode: RecordMode }>;
  tsumeSummary: TsumeSummary;
  tsume: TsumeInput[];
}

/** 控えに載せる戦績。棋譜は sinceEndedAt 以降に終わったものを新しい順に最大100局 */
export async function exportRecords(sinceEndedAt: number): Promise<{ records: BackupRecords; games: GameRecord[] }> {
  const { startedAt } = await initialize();
  const db = await database();
  const transaction = db.transaction(["summaries", "meta", "tsume", "games"], "readonly");
  const summaries: BackupRecords["summaries"] = [];
  let tsumeSummary = emptyTsumeSummary();
  let tsume: TsumeInput[] = [];
  const games: GameRecord[] = [];
  const done = completed(transaction, () => ({ records: { startedAt, summaries, tsumeSummary, tsume }, games }));
  const summaryRequest = transaction.objectStore("summaries").getAll();
  summaryRequest.onsuccess = () => { summaries.push(...summaryRequest.result); };
  const tsumeSummaryRequest = transaction.objectStore("meta").get("tsumeSummary");
  tsumeSummaryRequest.onsuccess = () => {
    if (tsumeSummaryRequest.result) {
      const { key: _key, ...summary } = tsumeSummaryRequest.result;
      tsumeSummary = summary;
    }
  };
  // 鍵は [出題日, 問題ID] なので、出題日の範囲だけを読む（記録は増える一方なので全件は読まない）
  const since = new Date(Date.now() + JST_OFFSET_MS - TSUME_BACKUP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const tsumeRequest = transaction.objectStore("tsume").getAll(IDBKeyRange.lowerBound([since]));
  tsumeRequest.onsuccess = () => {
    tsume = (tsumeRequest.result as TsumeInput[]).sort((a, b) => a.clearedAt - b.clearedAt);
  };
  const cursorRequest = transaction.objectStore("games").index("byEndedAt").openCursor(IDBKeyRange.lowerBound([sinceEndedAt]), "prev");
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor || games.length >= BACKUP_GAMES_MAX) return;
    games.push(publicGame(cursor.value));
    cursor.continue();
  };
  return done;
}

function readBackupRecords(value: unknown): BackupRecords | null {
  if (typeof value !== "object" || value === null) return null;
  const records = value as Record<string, unknown>;
  if (!Number.isSafeInteger(records.startedAt) || (records.startedAt as number) < 0 || !Array.isArray(records.summaries)) return null;
  const summaries: BackupRecords["summaries"] = [];
  for (const entry of records.summaries) {
    const mode = (entry as { mode?: unknown } | null)?.mode as RecordMode;
    const summary = readSummary(entry);
    if (!summary || !["all", "ai", "online", "board"].includes(mode)) return null;
    summaries.push({ mode, ...summary });
  }
  const tsume = (Array.isArray(records.tsume) ? records.tsume : [])
    .map(readTsume)
    .filter((record): record is TsumeInput => record !== null);
  return {
    startedAt: records.startedAt as number,
    summaries,
    tsumeSummary: readTsumeSummary(records.tsumeSummary) ?? emptyTsumeSummary(),
    tsume,
  };
}

/**
 * 控えの戦績を取り込む。手元の記録が控えより後に始まっている（＝消えて作り直された）ときだけ取り込み、
 * 数字は「控え＋消えた後に指した分」の足し算にする。手元が消えていなければ何もしない（二重に数えない）。
 */
export async function importRecords(recordsValue: unknown, gamesValue: unknown): Promise<boolean> {
  const records = readBackupRecords(recordsValue);
  if (!records) return false;
  const games = (Array.isArray(gamesValue) ? gamesValue : [])
    .map(readGame)
    .filter((game): game is GameRecord => game !== null);
  await initialize();
  const db = await database();
  const transaction = db.transaction(["meta", "summaries", "games", "gameWaza", "tsume"], "readwrite");
  let imported = false;
  const done = completed(transaction, () => imported);
  const meta = transaction.objectStore("meta");
  const tracking = meta.get("tracking");
  tracking.onsuccess = () => {
    // 判定と書き込みを同じトランザクションで行うので、別のタブが同時に取り込んでも二重にならない
    if (tracking.result && tracking.result.startedAt <= records.startedAt) return;
    imported = true;
    meta.put({ key: "tracking", startedAt: records.startedAt });
    const summaries = transaction.objectStore("summaries");
    for (const { mode, ...summary } of records.summaries) {
      const request = summaries.get(mode);
      request.onsuccess = () => {
        summaries.put({ mode, ...mergeSummaries(readSummary(request.result) ?? emptySummary(), summary) });
      };
    }
    const tsumeSummary = meta.get("tsumeSummary");
    tsumeSummary.onsuccess = () => {
      const local = readTsumeSummary(tsumeSummary.result) ?? emptyTsumeSummary();
      meta.put({ key: "tsumeSummary", ...mergeTsumeSummaries(local, records.tsumeSummary) });
    };
    const tsume = transaction.objectStore("tsume");
    for (const record of records.tsume) {
      const existing = tsume.get([record.date, record.problemId]);
      existing.onsuccess = () => { if (!existing.result) tsume.put(record); };
    }
    const stored = transaction.objectStore("games");
    const references = transaction.objectStore("gameWaza");
    for (const game of games) {
      const existing = stored.get(game.id);
      existing.onsuccess = () => {
        if (existing.result) return;
        const group = modeGroup(game.mode);
        stored.put({ ...game, modeGroup: group } satisfies StoredGame);
        for (const wazaId of new Set(game.wazaIds)) {
          references.put({ wazaId, modeGroup: group, endedAt: game.endedAt, id: game.id } satisfies WazaReference);
        }
      };
    }
  };
  return done;
}

/**
 * 控えを送る。戻し終わっていない間は送らない（消えた直後の空に近い状態で控えを上書きしないため）。
 * 番号がまだ無い人は、控える価値があるときだけ ensureUid で作る。
 */
export async function syncBackup(localUid: string | null, ensureUid: () => string): Promise<boolean> {
  if (restorePending()) return false;
  const since = syncedUntil();
  let records: BackupRecords | null = null;
  let games: GameRecord[] = [];
  try {
    ({ records, games } = await exportRecords(since > 0 ? since - SYNC_OVERLAP_MS : 0));
  } catch { /* 戦績の保存場所が使えない端末でも、設定と進み具合は控える */ }
  const played = (mode: RecordMode) => records?.summaries.find(summary => summary.mode === mode)?.games ?? 0;
  if (!worthBackingUp(played("online"), played("all") + (records?.tsumeSummary.cleared ?? 0))) return false;
  const uid = localUid || ensureUid();
  const profile = fitProfile({ v: 1, local: collectLocal(), records });
  // 大きすぎるときは新しい対局を次回に回す（サーバーは上限を超えた送信を丸ごと断る）
  let size = JSON.stringify({ uid, profile, games: [] }).length;
  const sending: GameRecord[] = [];
  for (const game of games.reverse()) {
    size += JSON.stringify(game).length + 1;
    if (size > BACKUP_BODY_MAX) break;
    sending.push(game);
  }
  const result = await postBackup("/api/backup", { uid, profile, games: sending }).catch(() => null);
  if (!result) return false;
  markBackedUp();
  if (sending.length) markSynced(sending[sending.length - 1].endedAt);
  return true;
}

/** この端末からまだ控えを送っていない人に、最初の控えを送る（控える価値が無ければ送らない） */
export async function seedBackup(ensureUid: () => string, localUid: string | null): Promise<boolean> {
  if (restorePending() || (localUid && cookieUid() === localUid && hasBackedUp())) return false;
  return syncBackup(localUid, ensureUid);
}

/** 控えの設定と進み具合を書き戻す（ページを開いた直後、駒を並べる前）。控えが無ければ戻すものは無い */
export function applyBackupProfile(profile: unknown): void {
  if (typeof profile !== "object" || profile === null) {
    finishRestore(RESTORE_LOCAL_KEY);
    finishRestore(RESTORE_RECORDS_KEY);
    return;
  }
  applyLocal((profile as { local?: unknown }).local);
  finishRestore(RESTORE_LOCAL_KEY);
}

/**
 * 控えの戦績を戻す（駒を並べ終わった後）。profile はページを開いた直後に取り寄せた控え。
 * 無ければ取りに行く。通信できなければ、次に開いたときにもう一度戻す。
 */
export async function restoreRecords(uid: string, profile?: unknown): Promise<boolean> {
  try {
    if (localStorage.getItem(RESTORE_RECORDS_KEY) !== "1") return false;
  } catch {
    return false;
  }
  try {
    await initialize();
  } catch {
    // 戦績の保存場所が使えない端末には戻す先が無い。印を残すと控えがずっと送られなくなる
    finishRestore(RESTORE_RECORDS_KEY);
    return false;
  }
  if (profile === undefined) {
    const response = await postBackup("/api/backup/restore", { uid, part: "profile" }).catch(() => null);
    if (!response) return false;
    profile = response.profile;
  }
  const records = (profile as { records?: unknown } | null)?.records;
  if (!records) {
    finishRestore(RESTORE_RECORDS_KEY);
    return false;
  }
  const response = await postBackup("/api/backup/restore", { uid, part: "games" }).catch(() => null);
  if (!response) return false;
  const imported = await importRecords(records, response.games);
  finishRestore(RESTORE_RECORDS_KEY);
  // 戻した棋譜をまた送らない
  const endedAt = (Array.isArray(response.games) ? response.games : [])
    .map(readGame)
    .reduce((latest, game) => Math.max(latest, game?.endedAt ?? 0), 0);
  if (endedAt) markSynced(endedAt);
  return imported;
}
