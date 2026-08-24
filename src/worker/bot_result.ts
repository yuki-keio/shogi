// SPDX-License-Identifier: GPL-3.0-only

// POST /api/bot-result — 「だれかと対戦」で60秒待って相手が見つからなかったときの
// COM戦の結果を受け取る。この対局はブラウザの中だけで進むので、サーバーは何も見ていない。
// 放っておくと「対局せずに勝ちだけ申告する」ことができてしまうため、5段構えで守る。
//
//   ① 棋譜をサーバーで並べ直して、最後が本当に詰みかを確かめる（勝ちの申告のみ）
//   ② 負け・引き分けは自己申告のまま受ける（損する方向に嘘をつく動機が無い）
//   ③ 1回きりの引換券。60秒待った人にしか出ないので1人60秒に1枚が構造的な上限
//   ④ 手数の下限。雑な捏造だけを弾く保険
//   ⑤ 1日の上限。60秒待ちが要るので普通に遊んで届く数ではない（保険）
//
// そのうえで、COM戦で届く段級位の上限は1級。初段より上は人と戦うしかない。
// 🔴 Matchmaker DO は経由しない。あれは全マッチングの首なので、
//    棋譜の検証で詰まらせてはいけない。

import { replayUsiMoves } from "../kifu/replay.ts";
import type { Env } from "./env";
import {
  BOT_DAILY_LIMIT,
  BOT_MIN_MOVES,
  BOT_RATED_MAX_RANK,
  comInternalRating,
  ratingView,
  visibleRank,
  type RatingView,
  type Score,
} from "./rating";
import { applyBotRating, botGamesToday, loadPlayer } from "./rating_store";
import { verifyBotTicket } from "./token";

export type BotResultOutcome = {
  /** レートが動いたか。false のときは理由が skipped に入る */
  rated: boolean;
  skipped: "frozen" | "daily_limit" | null;
  rating: RatingView;
  ratingDelta: number;
  promotedTo: string | null;
};

export type BotResultError = { code: string; message: string };

const MAX_MOVES = 600;

function scoreOf(result: unknown): Score | null {
  if (result === "win") return 1;
  if (result === "lose") return 0;
  if (result === "draw") return 0.5;
  return null;
}

function readMoves(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_MOVES) return null;
  const moves: string[] = [];
  for (const move of raw) {
    if (typeof move !== "string" || move.length === 0 || move.length > 8) return null;
    moves.push(move);
  }
  return moves;
}

/**
 * 勝ちの申告だけ、棋譜を初手から並べ直して確かめる。
 * ルールは通信対戦とまったく同じ engine（src/worker/shogi_engine.ts）を通るので、
 * 「クライアントだけが知っている抜け道」は原理的に作れない。
 */
function isGenuineWin(moves: string[], side: "sente" | "gote"): boolean {
  if (moves.length < BOT_MIN_MOVES) return false;
  const replay = replayUsiMoves(moves);
  if (!replay.ok || !replay.gameOver) return false;
  if (replay.winner !== side) return false;
  // 投了・時間切れはサーバーからは確かめようがない。詰みだけを通す
  return replay.resultReason === "checkmate";
}

export async function handleBotResult(
  env: Env,
  body: {
    ticket?: unknown;
    side?: unknown;
    result?: unknown;
    difficulty?: unknown;
    moves?: unknown;
  },
  nowMs: number,
): Promise<{ ok: true; outcome: BotResultOutcome } | { ok: false; error: BotResultError }> {
  const ticketRaw = typeof body.ticket === "string" ? body.ticket : "";
  const ticket = await verifyBotTicket(ticketRaw, env.TOKEN_SECRET, nowMs);
  if (!ticket) {
    return { ok: false, error: { code: "bad_ticket", message: "Invalid or expired ticket" } };
  }

  const side = body.side === "sente" || body.side === "gote" ? body.side : null;
  const score = scoreOf(body.result);
  if (side === null || score === null) {
    return { ok: false, error: { code: "bad_request", message: "Invalid side or result" } };
  }

  const player = await loadPlayer(env.DB, ticket.uid);
  const rank = visibleRank(player.rating, player.bestRank);
  const currentView = ratingView(player.rating, player.bestRank);

  // 初段より上はCOM戦では一切動かない。券は消費しない
  // （best_rank は下がらないので、あとで使い回されても結果は同じ）。
  if (rank > BOT_RATED_MAX_RANK) {
    return {
      ok: true,
      outcome: { rated: false, skipped: "frozen", rating: currentView, ratingDelta: 0, promotedTo: null },
    };
  }

  if ((await botGamesToday(env.DB, ticket.uid, nowMs)) >= BOT_DAILY_LIMIT) {
    return {
      ok: true,
      outcome: {
        rated: false,
        skipped: "daily_limit",
        rating: currentView,
        ratingDelta: 0,
        promotedTo: null,
      },
    };
  }

  if (score === 1) {
    const moves = readMoves(body.moves);
    if (!moves || !isGenuineWin(moves, side)) {
      return { ok: false, error: { code: "bad_kifu", message: "Could not verify the win" } };
    }
  }

  let outcome;
  try {
    outcome = await applyBotRating(env.DB, {
      ticketId: ticket.jti,
      uid: ticket.uid,
      score,
      comRating: comInternalRating(body.difficulty),
      nowMs,
    });
  } catch {
    // 券の使い回し（rated_game の主キー衝突）か、D1 の不調。どちらも点は動いていない
    return { ok: false, error: { code: "ticket_used", message: "This result was already counted" } };
  }
  if (!outcome) {
    return { ok: false, error: { code: "ticket_used", message: "This result was already counted" } };
  }

  return {
    ok: true,
    outcome: {
      rated: true,
      skipped: null,
      rating: ratingView(outcome.rating, outcome.bestRank),
      ratingDelta: outcome.displayDelta,
      promotedTo: outcome.promotedTo,
    },
  };
}
