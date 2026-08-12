// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 問題プールと出題台帳の読み書き。1行1問の JSONL にしてあるのは、
// 毎日追記される差分を git 上で読みやすくするため。

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SolutionStep } from "./verify.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(REPO_ROOT, "tsume_data");
export const POOL_DIR = join(DATA_DIR, "pool");
export const DAILY_DIR = join(DATA_DIR, "daily");
export const REGISTRY_PATH = join(DATA_DIR, "registry.json");

/** プールに貯める1問。作意手順まで含めて検証済み。 */
export type PoolProblem = {
  id: string;
  moves: number;
  sfen: string;
  line: SolutionStep[];
  /** 鏡像を同一視した重複判定キー */
  key: string;
  /** 出題順を決める品質スコア（高いほど良い） */
  score: number;
  /** 盤上の駒数 */
  pieces: number;
  /**
   * 生成方法。今はすべて selfplay（自己対局の棋譜から採る）。
   * "search"（ランダム配置からの探索生成）は取り除いたが、
   * 既存の在庫に残っている値なので型からは外さない。
   */
  source: "search" | "selfplay";
  /** 生成した日（JST） */
  createdAt: string;
};

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, POOL_DIR, DAILY_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function poolPath(moves: number): string {
  return join(POOL_DIR, `len${moves}.jsonl`);
}

export function readPool(moves: number): PoolProblem[] {
  const path = poolPath(moves);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as PoolProblem);
}

export function appendPool(moves: number, problems: PoolProblem[]): void {
  if (problems.length === 0) return;
  ensureDirs();
  appendFileSync(poolPath(moves), problems.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

export function writePool(moves: number, problems: PoolProblem[]): void {
  ensureDirs();
  writeFileSync(poolPath(moves), problems.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

/** 出題済み・生成済みの局面キー台帳。重複出題を防ぐ。 */
export type Registry = {
  /** 正規形キー → 使った日付（未出題なら null） */
  used: Record<string, string | null>;
};

export function readRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { used: {} };
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
}

export function writeRegistry(registry: Registry): void {
  ensureDirs();
  const sorted = Object.keys(registry.used).sort();
  const out: Registry = { used: {} };
  for (const key of sorted) out.used[key] = registry.used[key];
  writeFileSync(REGISTRY_PATH, JSON.stringify(out, null, 1) + "\n");
}

/** JST の YYYY-MM-DD。日付境界は日本時間で決める。 */
export function jstDate(at: number): string {
  return new Date(at + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const at = Date.parse(date + "T00:00:00Z") + days * 86400 * 1000;
  return new Date(at).toISOString().slice(0, 10);
}

/** from から to までの日数。to のほうが古ければ負になる。 */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000,
  );
}

export function dailyPath(date: string): string {
  return join(DAILY_DIR, `${date}.json`);
}
