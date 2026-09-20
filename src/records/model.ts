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
