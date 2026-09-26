// SPDX-License-Identifier: GPL-3.0-only

import type {
  Counts,
  GameInput,
  GameMode,
  GameRecord,
  RecordMode,
  Summary,
  TsumeInput,
  TsumeSummary,
} from "./types.ts";

export function emptyCounts(): Counts {
  return { games: 0, wins: 0, losses: 0, draws: 0, eligible: 0 };
}

export function emptySummary(): Summary {
  return { ...emptyCounts(), waza: {} };
}

export function emptyTsumeSummary(): TsumeSummary {
  return { cleared: 0, firstTry: 0, byMoves: {} };
}

export function modeGroup(mode: GameMode): Exclude<RecordMode, "all"> {
  return mode === "friend" ? "online" : mode;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlayer(value: unknown): value is "sente" | "gote" {
  return value === "sente" || value === "gote";
}

/** 対象外の対局は null。保存できない入力は例外にして失敗を呼び元へ返す。 */
export function normalizeGame(input: GameInput, trackingStartedAt: number): GameRecord | null {
  if (!input.completed || input.source !== "played") return null;
  if (!validTime(input.startedAt) || !validTime(input.endedAt) || input.endedAt < input.startedAt) {
    throw new TypeError("Invalid game timestamps");
  }
  // 初回の対局を始めた後に別タブが記録を初期化しても、完了した対局は残す。
  if (input.endedAt < trackingStartedAt) return null;
  if (!input.id || !["ai", "online", "friend", "board"].includes(input.mode)) {
    throw new TypeError("Invalid game identity");
  }
  if ((input.mode !== "board" && !isPlayer(input.player)) || (input.winner !== null && !isPlayer(input.winner))) {
    throw new TypeError("Invalid game players");
  }

  const wazaIds = [...new Set(input.waza.filter(hit =>
    hit.id && isPlayer(hit.player) && Number.isInteger(hit.ply) && hit.ply > 0 &&
    hit.ply <= input.moves.length && (input.mode === "board" || hit.player === input.player),
  ).map(hit => hit.id))];

  const record: GameRecord = {
    id: input.id,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    mode: input.mode,
    player: input.mode === "board" ? null : input.player,
    winner: input.winner,
    reason: input.reason,
    opponentName: input.opponentName,
    moves: [...input.moves],
    wazaIds,
  };
  if (input.mode === "ai" && input.aiLevel) record.aiLevel = input.aiLevel;
  if (input.mode === "online") {
    if (input.opponentRank) record.opponentRank = input.opponentRank;
    if (typeof input.opponentRating === "number" && Number.isFinite(input.opponentRating)) {
      record.opponentRating = input.opponentRating;
    }
  }
  return record;
}

export function gameCounts(game: GameRecord): Counts {
  const eligible = game.mode !== "board" && game.winner !== null;
  return {
    games: 1,
    wins: Number(eligible && game.winner === game.player),
    losses: Number(eligible && game.winner !== game.player),
    draws: Number(game.winner === null),
    eligible: Number(eligible),
  };
}

function addCounts(current: Counts, added: Counts): Counts {
  return {
    games: current.games + added.games,
    wins: current.wins + added.wins,
    losses: current.losses + added.losses,
    draws: current.draws + added.draws,
    eligible: current.eligible + added.eligible,
  };
}

/** 小計だけを更新し、過去の対局を読み直さない。 */
export function addGameToSummary(summary: Summary, game: GameRecord): Summary {
  const delta = gameCounts(game);
  const waza = { ...summary.waza };
  for (const id of game.wazaIds) {
    const previous = Object.hasOwn(waza, id) ? waza[id] : emptyCounts();
    Object.defineProperty(waza, id, { value: addCounts(previous, delta), enumerable: true, writable: true, configurable: true });
  }
  return { ...addCounts(summary, delta), waza };
}

export function normalizeTsume(input: TsumeInput, trackingStartedAt: number): TsumeInput | null {
  if (!validTime(input.clearedAt)) throw new TypeError("Invalid clear timestamp");
  if (input.clearedAt < trackingStartedAt) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.problemId ||
      !Number.isInteger(input.moves) || input.moves <= 0 || input.moves % 2 !== 1 ||
      typeof input.firstTry !== "boolean") {
    throw new TypeError("Invalid tsume record");
  }
  return { date: input.date, problemId: input.problemId, moves: input.moves, firstTry: input.firstTry, clearedAt: input.clearedAt };
}

export function addTsumeToSummary(summary: TsumeSummary, record: TsumeInput): TsumeSummary {
  return {
    cleared: summary.cleared + 1,
    firstTry: summary.firstTry + Number(record.firstTry),
    byMoves: { ...summary.byMoves, [record.moves]: (summary.byMoves[record.moves] || 0) + 1 },
  };
}

/** 別々の対局から作った小計を足す。同じ対局を二度数えないのは呼び元の責任 */
export function mergeSummaries(a: Summary, b: Summary): Summary {
  const waza: Record<string, Counts> = {};
  for (const source of [a.waza, b.waza]) {
    for (const [id, counts] of Object.entries(source)) {
      const previous = Object.hasOwn(waza, id) ? waza[id] : emptyCounts();
      Object.defineProperty(waza, id, { value: addCounts(previous, counts), enumerable: true, writable: true, configurable: true });
    }
  }
  return { ...addCounts(a, b), waza };
}

export function mergeTsumeSummaries(a: TsumeSummary, b: TsumeSummary): TsumeSummary {
  const byMoves: Record<string, number> = { ...a.byMoves };
  for (const [moves, n] of Object.entries(b.byMoves)) byMoves[moves] = (byMoves[moves] || 0) + n;
  return { cleared: a.cleared + b.cleared, firstTry: a.firstTry + b.firstTry, byMoves };
}

// ---- サーバーの控えから戻ってきた値の確認 ----
// 控えは同じ端末が送ったものだが、壊れていても手元の記録を壊さないよう、形を確かめてから使う。

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function readCounts(value: unknown): Counts | null {
  if (!isObject(value)) return null;
  const counts = {
    games: readCount(value.games),
    wins: readCount(value.wins),
    losses: readCount(value.losses),
    draws: readCount(value.draws),
    eligible: readCount(value.eligible),
  };
  return Object.values(counts).every(n => n !== null) ? counts as Counts : null;
}

export function readSummary(value: unknown): Summary | null {
  const counts = readCounts(value);
  if (!counts || !isObject(value) || !isObject(value.waza)) return null;
  const waza: Record<string, Counts> = {};
  for (const [id, entry] of Object.entries(value.waza)) {
    const read = readCounts(entry);
    if (!read) return null;
    Object.defineProperty(waza, id, { value: read, enumerable: true, writable: true, configurable: true });
  }
  return { ...counts, waza };
}

export function readTsumeSummary(value: unknown): TsumeSummary | null {
  if (!isObject(value) || !isObject(value.byMoves)) return null;
  const cleared = readCount(value.cleared);
  const firstTry = readCount(value.firstTry);
  if (cleared === null || firstTry === null) return null;
  const byMoves: Record<string, number> = {};
  for (const [moves, n] of Object.entries(value.byMoves)) {
    const read = readCount(n);
    if (read === null || !/^\d+$/.test(moves)) return null;
    byMoves[moves] = read;
  }
  return { cleared, firstTry, byMoves };
}

export function readTsume(value: unknown): TsumeInput | null {
  if (!isObject(value)) return null;
  try {
    return normalizeTsume(value as unknown as TsumeInput, 0);
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function readGame(value: unknown): GameRecord | null {
  if (!isObject(value)) return null;
  const { id, startedAt, endedAt, mode, player, winner, reason, opponentName, moves, wazaIds } = value;
  if (typeof id !== "string" || !id || readCount(startedAt) === null || readCount(endedAt) === null) return null;
  if (!["ai", "online", "friend", "board"].includes(mode as string)) return null;
  if ((player !== null && !isPlayer(player)) || (winner !== null && !isPlayer(winner))) return null;
  if (typeof reason !== "string" || typeof opponentName !== "string" || !isStringArray(moves) || !isStringArray(wazaIds)) return null;
  const game: GameRecord = {
    id, startedAt: startedAt as number, endedAt: endedAt as number, mode: mode as GameMode,
    player, winner, reason, opponentName, moves: [...moves], wazaIds: [...wazaIds],
  };
  if (typeof value.aiLevel === "string") game.aiLevel = value.aiLevel;
  if (typeof value.opponentRank === "string") game.opponentRank = value.opponentRank;
  if (typeof value.opponentRating === "number" && Number.isFinite(value.opponentRating)) game.opponentRating = value.opponentRating;
  return game;
}
