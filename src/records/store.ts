// SPDX-License-Identifier: GPL-3.0-only

import {
  addGameToSummary,
  addTsumeToSummary,
  emptySummary,
  emptyTsumeSummary,
  modeGroup,
  normalizeGame,
  normalizeTsume,
} from "./model.ts";
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
