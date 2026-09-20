// SPDX-License-Identifier: GPL-3.0-only

export type RecordPlayer = "sente" | "gote";
export type GameMode = "ai" | "online" | "friend" | "board";
export type RecordMode = "all" | "ai" | "online" | "board";

export interface GameInput {
  id: string;
  startedAt: number;
  endedAt: number;
  mode: GameMode;
  player: RecordPlayer | null;
  winner: RecordPlayer | null;
  reason: string;
  opponentName: string;
  aiLevel?: string;
  opponentRank?: string | null;
  opponentRating?: number | null;
  /** 最終的に残った指し手の USI 表記。 */
  moves: string[];
  /** 最終的に残った指し手に対応する検出結果。手数は 1 始まり。 */
  waza: { id: string; player: RecordPlayer; ply: number }[];
  source: "played" | "shared" | "imported" | "legacy";
  completed: boolean;
}

export interface GameRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  mode: GameMode;
  player: RecordPlayer | null;
  winner: RecordPlayer | null;
  reason: string;
  opponentName: string;
  aiLevel?: string;
  opponentRank?: string;
  opponentRating?: number;
  moves: string[];
  /** 同じ種類は 1 局につき 1 回。将棋盤以外は自分の技だけ。 */
  wazaIds: string[];
}

export interface Counts {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** 勝率の分母。将棋盤と引き分けを含めない。 */
  eligible: number;
}

export interface Summary extends Counts {
  waza: Record<string, Counts>;
}

export interface GameCursor {
  endedAt: number;
  id: string;
}

export interface GamesQuery {
  mode?: RecordMode;
  wazaId?: string;
  limit?: number;
  cursor?: GameCursor | null;
}

export interface GamesPage {
  games: GameRecord[];
  nextCursor: GameCursor | null;
}

export interface TsumeInput {
  date: string;
  problemId: string;
  moves: number;
  firstTry: boolean;
  clearedAt: number;
}

export interface TsumeSummary {
  cleared: number;
  firstTry: number;
  byMoves: Record<string, number>;
}
