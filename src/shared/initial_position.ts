// SPDX-License-Identifier: GPL-3.0-only

export type InitialPlayer = "sente" | "gote";
export type Handicap =
  | "none" | "lance" | "bishop" | "rook" | "rook-lance"
  | "two" | "four" | "six" | "eight" | "ten";

export type InitialPosition = {
  handicap: Handicap;
  handicapSide: InitialPlayer;
  firstPlayer: InitialPlayer;
};

type RemovedPiece = {
  x: number;
  y: number;
  type: "HI" | "KA" | "KI" | "GI" | "KE" | "KY";
};

export type HandicapDefinition = {
  id: Handicap;
  label: string;
  kifLabel: string;
  /** 上手（後手）の初形から外す駒 */
  removed: readonly RemovedPiece[];
};

const rook: RemovedPiece = { x: 1, y: 1, type: "HI" };
const bishop: RemovedPiece = { x: 7, y: 1, type: "KA" };
const lances: RemovedPiece[] = [
  { x: 8, y: 0, type: "KY" }, { x: 0, y: 0, type: "KY" },
];
const knights: RemovedPiece[] = [
  { x: 7, y: 0, type: "KE" }, { x: 1, y: 0, type: "KE" },
];
const silvers: RemovedPiece[] = [
  { x: 6, y: 0, type: "GI" }, { x: 2, y: 0, type: "GI" },
];
const golds: RemovedPiece[] = [
  { x: 5, y: 0, type: "KI" }, { x: 3, y: 0, type: "KI" },
];

export const HANDICAPS: readonly HandicapDefinition[] = [
  { id: "none", label: "平手", kifLabel: "平手", removed: [] },
  { id: "lance", label: "香落ち", kifLabel: "香落ち", removed: [lances[0]] },
  { id: "bishop", label: "角落ち", kifLabel: "角落ち", removed: [bishop] },
  { id: "rook", label: "飛車落ち", kifLabel: "飛車落ち", removed: [rook] },
  { id: "rook-lance", label: "飛香落ち", kifLabel: "飛香落ち", removed: [rook, lances[0]] },
  { id: "two", label: "2枚落ち", kifLabel: "二枚落ち", removed: [rook, bishop] },
  { id: "four", label: "4枚落ち", kifLabel: "四枚落ち", removed: [rook, bishop, ...lances] },
  { id: "six", label: "6枚落ち", kifLabel: "六枚落ち", removed: [rook, bishop, ...lances, ...knights] },
  { id: "eight", label: "8枚落ち", kifLabel: "八枚落ち", removed: [rook, bishop, ...lances, ...knights, ...silvers] },
  { id: "ten", label: "10枚落ち", kifLabel: "十枚落ち", removed: [rook, bishop, ...lances, ...knights, ...silvers, ...golds] },
];

/**
 * 将棋の棋譜の決まりどおり、平手は先手から指し、駒落ちは駒を減らす側（上手）を後手として上手から指す。
 * この2つ以外の形（平手を後手から・先手が駒を減らす）は作らない。
 */
export function normalizeInitialPosition(input?: unknown): InitialPosition {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const handicap = HANDICAPS.find((entry) => entry.id === value.handicap)?.id ?? "none";
  return { handicap, handicapSide: "gote", firstPlayer: handicap === "none" ? "sente" : "gote" };
}

export function handicapRemovedSquares(input?: unknown): RemovedPiece[] {
  const initial = normalizeInitialPosition(input);
  return HANDICAPS.find((entry) => entry.id === initial.handicap)!.removed.map((piece) => ({ ...piece }));
}

export function isStandardInitialPosition(input?: unknown): boolean {
  return normalizeInitialPosition(input).handicap === "none";
}
