// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋エンジンの実体を探す。
// CI では engine_setup.sh が CPU 別に複数ビルドするので、動く1本を選ぶ。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./pool.ts";

export const ENGINE_DIR = join(REPO_ROOT, ".engines", "bin");

/** CPU が AVX2 を持つか（Linux のみ判定。他は false 扱いで安全側に倒す）。 */
function hasAvx2(): boolean {
  try {
    return readFileSync("/proc/cpuinfo", "utf8").includes(" avx2");
  } catch {
    return false;
  }
}

/**
 * 使える詰将棋エンジンのパス。
 * TSUME_ENGINE 環境変数があればそれを最優先する。
 */
export function resolveEngineBinary(): string {
  const fromEnv = process.env.TSUME_ENGINE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`TSUME_ENGINE が見つかりません: ${fromEnv}`);
    return fromEnv;
  }

  const candidates = [
    // CI がビルドしたもの（CPU 対応順）
    hasAvx2() ? "komoring-avx2" : null,
    "komoring-sse42",
    // 手元の macOS 向け
    "komoring",
  ].filter((name): name is string => name !== null);

  for (const name of candidates) {
    const path = join(ENGINE_DIR, name);
    if (existsSync(path)) return path;
  }

  throw new Error(
    `詰将棋エンジンが見つかりません。scripts/tsume/engine_setup.sh を実行するか、` +
      `TSUME_ENGINE で実体を指定してください（探した場所: ${ENGINE_DIR}）`,
  );
}
