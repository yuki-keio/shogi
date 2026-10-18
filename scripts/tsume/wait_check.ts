// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// だれかと対戦の待ち時間に出す7手以上の詰将棋を、出してよいか確かめる。
//
// 待ち時間の画面（online-match.js）は詰み探索を読み込まず、「指した手が正解の一覧（accept）にあるか」を
// 照合して、玉方はデータの defend を指すだけで進める。これがそのまま使えるのは次の2つを満たす問題だけ:
//   1. 途中に別の正解がない。最終手以外の accept が作意の手だけか、作意と同じ手の成・不成で、
//      玉方の defend を指すと作意と同じ局面に戻るもの（defend がその駒を取る形）
//   2. 正解の一覧に抜けがない。作意の各局面で、accept 以外のどの王手も残りの手数では詰まない。
//      生成エンジンは7手以上で45秒で読みを打ち切るので、詰む手が一覧から抜けることがある
//      （11手・13手で各1問を実際に確認。抜けると、正しい手に「その手では詰みません」と出てしまう）
// 2 はブラウザの詰将棋ページと同じ詰み探索（src/tsume/solver.ts）で確かめる。時間では切らずに
// 調べる局面の数で打ち切り、調べ切れなければ出さない（機械の速さで結果が変わらないように）。
// 5手以下は生成の時点で余詰を禁止しているので確かめない（YOZUME_STRICT_MAX_MOVES）。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

import { findDefense } from "../../src/tsume/solver.ts";
import { YOZUME_STRICT_MAX_MOVES } from "./config.ts";
import { addDays, DAILY_DIR, dailyPath } from "./pool.ts";
import {
  applyMoveToPosition,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  fromSfen,
  isDefenderMated,
  toSfen,
  usi,
} from "./position.ts";
import type { Move, Position } from "./position.ts";
import type { SolutionStep } from "./verify.ts";

/** 王手1つあたりに調べる局面の数の上限（2026-10-17 の試算で 13手が平均30秒・最大90秒ほど） */
const WAIT_CHECK_BUDGET = { nodes: 20_000_000, timeMs: 24 * 3600 * 1000 };

export type WaitTarget = { moves: number; sfen: string; line: SolutionStep[] };

export type WaitCheckResult = { ok: true } | { ok: false; reason: string };

/** この問題を待ち時間に出すのに確かめが要るか（7手以上） */
export function needsWaitCheck(problem: { moves: number }): boolean {
  return problem.moves > YOZUME_STRICT_MAX_MOVES;
}

function moveOf(pos: Position, text: string): Move | null {
  return enumerateLegalMoves(pos).find((move) => usi(move) === text) ?? null;
}

const baseMove = (text: string) => text.replace(/\+$/, "");

export function checkWaitProblem(problem: WaitTarget): WaitCheckResult {
  let pos = fromSfen(problem.sfen);
  let remaining = problem.moves;
  for (const [index, step] of problem.line.entries()) {
    const label = `${index * 2 + 1}手目`;
    const attack = moveOf(pos, step.attack);
    if (!attack) return { ok: false, reason: `${label}: 作意の ${step.attack} が指せない` };
    const afterAttack = applyMoveToPosition(pos, attack);
    const accepted = new Set(step.accept);

    if (step.defend === null) {
      // 最終手: 正解の一覧の手はどれもその場で詰み、一覧に無い王手は詰まない
      for (const check of enumerateCheckingMoves(pos)) {
        const mate = isDefenderMated(applyMoveToPosition(pos, check));
        if (accepted.has(usi(check)) !== mate) {
          return { ok: false, reason: `${label}: ${usi(check)} の詰みと正解の一覧が食い違う` };
        }
      }
      return { ok: true };
    }

    const defend = moveOf(afterAttack, step.defend);
    if (!defend) return { ok: false, reason: `${label}: 玉方の ${step.defend} が指せない` };
    const next = applyMoveToPosition(afterAttack, defend);

    // 1. 途中に別の正解がない（成・不成の違いだけで、玉方の応手のあと作意と同じ局面に戻るものは許す）
    for (const text of accepted) {
      if (text === step.attack) continue;
      const alt = baseMove(text) === baseMove(step.attack) ? moveOf(pos, text) : null;
      const altDefend = alt ? moveOf(applyMoveToPosition(pos, alt), step.defend) : null;
      if (!alt || !altDefend || toSfen(applyMoveToPosition(applyMoveToPosition(pos, alt), altDefend)) !== toSfen(next)) {
        return { ok: false, reason: `${label}: 途中に別の正解 ${text} がある` };
      }
    }

    // 2. 正解の一覧に抜けがない（一覧に無い王手は、残りの手数では詰まない）
    for (const check of enumerateCheckingMoves(pos)) {
      const text = usi(check);
      if (accepted.has(text)) continue;
      const after = applyMoveToPosition(pos, check);
      if (isDefenderMated(after)) return { ok: false, reason: `${label}: ${text} でもその場で詰む` };
      const result = findDefense({ board: after.board, hands: after.hands }, remaining - 1, WAIT_CHECK_BUDGET);
      if (result.kind === "allLose" || result.kind === "mated") {
        return { ok: false, reason: `${label}: ${text} でも${remaining}手以内に詰む` };
      }
      if (result.kind === "partial") return { ok: false, reason: `${label}: ${text} を調べ切れない` };
    }

    pos = next;
    remaining -= 2;
  }
  return { ok: false, reason: "手順が詰みで終わっていない" };
}

/** 待ち時間に出る可能性のある日。過去問は今日の30日前まで配っている（build-pages.mjs の TSUME_ARCHIVE_DAYS） */
const WAIT_CHECK_LOOKBACK_DAYS = 30;

/**
 * だれかと対戦の待ち時間に出す7手以上の問題を確かめ、出題ファイルに wait: true/false を書く（設計書 §7.5）。
 * まだ確かめていない問題だけを見るので1問1回だけ。最初に動いたときは先の予定の分もまとめて確かめる（数十分）。
 * 🔴 ここで失敗しても例外を外へ出さない。その問題を出さないだけで、当日の出題・Xの画像・デプロイは止めない
 */
type DailyFile = { date: string; problems: Array<WaitTarget & { id: string; wait?: boolean }> };

export function markWaitProblems(today: string): void {
  const from = addDays(today, -WAIT_CHECK_LOOKBACK_DAYS);
  let checked = 0;
  let passed = 0;
  const started = Date.now();
  let names: string[] = [];
  try {
    names = readdirSync(DAILY_DIR).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    console.error(`警告: 出題ファイルを読めず、待ち時間の確認をしませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const name of names) {
    const date = name.slice(0, -5);
    if (date < from) continue;
    try {
      const path = dailyPath(date);
      const day = JSON.parse(readFileSync(path, "utf8")) as DailyFile;
      let changed = false;
      for (const problem of day.problems) {
        if (!needsWaitCheck(problem) || typeof problem.wait === "boolean") continue;
        const at = Date.now();
        let reason = "";
        try {
          const result = checkWaitProblem(problem);
          problem.wait = result.ok;
          if (!result.ok) reason = result.reason;
        } catch (error) {
          problem.wait = false;
          reason = `確かめに失敗 ${error instanceof Error ? error.message : String(error)}`;
        }
        changed = true;
        checked++;
        if (problem.wait) passed++;
        const seconds = ((Date.now() - at) / 1000).toFixed(1);
        console.log(`  待ち時間 ${date} ${problem.id}（${problem.moves}手）: ${problem.wait ? "出す" : `出さない（${reason}）`} ${seconds}秒`);
      }
      if (changed) writeFileSync(path, JSON.stringify(day, null, 1) + "\n");
    } catch (error) {
      console.error(`警告: ${date} の待ち時間の確認ができませんでした（その日の7手以上は出しません）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (checked > 0) {
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`待ち時間に出す7手以上を確かめました: ${checked}問中 ${passed}問を出します（${minutes}分）`);
  }
}
