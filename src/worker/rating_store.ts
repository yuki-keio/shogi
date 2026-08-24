// SPDX-License-Identifier: GPL-3.0-only

// レートの読み書き（D1）。計算そのものは rating.ts、対局への当て込みは
// match_room.ts / bot_result.ts。ここは「保存の都合」だけを引き受ける。
//
// 二重適用の防止は rated_game の主キーに任せている。レート更新は必ず
//   batch([INSERT rated_game, UPSERT player_rating ...])
// の1トランザクションで撃つので、同じ game_key で2回目を撃つと
// バッチごと失敗して1点も動かない（D1 の batch は SQL トランザクション）。
// これで DO alarm の再実行も、COM戦の引換券の再送も、同じ1つの仕組みで弾ける。

import {
  applyGame,
  botPairKey,
  BOT_SCALE,
  INTERNAL_START,
  jstDateKey,
  pairKey,
  ratingView,
  START_RANK,
  streakScale,
  type RatingOutcome,
  type RatingView,
  type Score,
} from "./rating";

export type PlayerRating = {
  uid: string;
  rating: number;
  bestRank: number;
};

type Row = { uid: string; rating: number; best_rank: number };

/** まだ1局も指していない人の初期値。行は作らない（読むだけで書き込まない） */
function freshPlayer(uid: string): PlayerRating {
  return { uid, rating: INTERNAL_START, bestRank: START_RANK };
}

export async function loadPlayers(
  db: D1Database,
  uids: string[],
): Promise<Map<string, PlayerRating>> {
  const wanted = [...new Set(uids.filter((uid) => typeof uid === "string" && uid.length > 0))];
  const found = new Map<string, PlayerRating>(wanted.map((uid) => [uid, freshPlayer(uid)]));
  if (wanted.length === 0) return found;
  const placeholders = wanted.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT uid, rating, best_rank FROM player_rating WHERE uid IN (${placeholders})`)
    .bind(...wanted)
    .all<Row>();
  for (const row of results ?? []) {
    found.set(row.uid, { uid: row.uid, rating: row.rating, bestRank: row.best_rank });
  }
  return found;
}

export async function loadPlayer(db: D1Database, uid: string): Promise<PlayerRating> {
  return (await loadPlayers(db, [uid])).get(uid) ?? freshPlayer(uid);
}

/** ロビー用。行が無い人にも 5級/1500 を返す（行は作らない） */
export async function loadView(db: D1Database, uid: string): Promise<RatingView> {
  const player = await loadPlayer(db, uid);
  return ratingView(player.rating, player.bestRank);
}

async function countPairGames(db: D1Database, key: string, day: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM rated_game WHERE pair_key = ?1 AND played_on = ?2")
    .bind(key, day)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 同じ相手とその日に何局目になるか（これから指す1局を含む） */
export async function pairGameNumber(
  db: D1Database,
  uidA: string,
  uidB: string,
  nowMs: number,
): Promise<number> {
  return (await countPairGames(db, pairKey(uidA, uidB), jstDateKey(nowMs))) + 1;
}

export async function botGamesToday(db: D1Database, uid: string, nowMs: number): Promise<number> {
  return countPairGames(db, botPairKey(uid), jstDateKey(nowMs));
}

function upsert(db: D1Database, uid: string, outcome: RatingOutcome, score: Score, nowMs: number) {
  // 戦績は加算、レートと到達最高段級位は算出済みの絶対値で置く。
  // 同じ人が同時に2局を終えることはない（1人は1部屋にしか入れない）ので、
  // 読んでから書くまでの間に別の対局が割り込む筋は実質ない。
  return db
    .prepare(
      `INSERT INTO player_rating (uid, rating, best_rank, wins, losses, draws, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(uid) DO UPDATE SET
         rating = ?2, best_rank = ?3,
         wins = wins + ?4, losses = losses + ?5, draws = draws + ?6,
         updated_at = ?7`,
    )
    .bind(
      uid,
      outcome.rating,
      outcome.bestRank,
      score === 1 ? 1 : 0,
      score === 0 ? 1 : 0,
      score === 0.5 ? 1 : 0,
      nowMs,
    );
}

function insertGame(db: D1Database, gameKey: string, key: string, day: string, nowMs: number) {
  return db
    .prepare(
      "INSERT INTO rated_game (game_key, played_on, pair_key, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(gameKey, day, key, nowMs);
}

/** 判定に要るのは当日ぶんだけ。ごくたまに古い行を落として表を小さく保つ */
const PRUNE_PROBABILITY = 0.02;
const PRUNE_KEEP_DAYS = 3;

function pruneStatement(db: D1Database, nowMs: number) {
  const cutoff = jstDateKey(nowMs - PRUNE_KEEP_DAYS * 24 * 3600 * 1000);
  return db.prepare("DELETE FROM rated_game WHERE played_on < ?1").bind(cutoff);
}

function withPrune(db: D1Database, statements: D1PreparedStatement[], nowMs: number) {
  if (Math.random() >= PRUNE_PROBABILITY) return statements;
  // 掃除はバッチの末尾に足す。先頭に置くと、二重適用で巻き戻すたびに掃除も巻き戻る
  return [...statements, pruneStatement(db, nowMs)];
}

export type MatchRatingResult = {
  sente: RatingOutcome;
  gote: RatingOutcome;
};

/**
 * 対人戦（だれかと対戦）1局ぶんの反映。
 * 既に同じ room_code で反映済みなら null を返す（二重適用なし）。
 */
export async function applyMatchRating(
  db: D1Database,
  params: {
    roomCode: string;
    senteUid: string;
    goteUid: string;
    /** 先手から見た結果 */
    senteScore: Score;
    nowMs: number;
  },
): Promise<MatchRatingResult | null> {
  const { roomCode, senteUid, goteUid, senteScore, nowMs } = params;
  if (!senteUid || !goteUid || senteUid === goteUid) return null;

  const day = jstDateKey(nowMs);
  const key = pairKey(senteUid, goteUid);
  const [players, priorGames] = await Promise.all([
    loadPlayers(db, [senteUid, goteUid]),
    countPairGames(db, key, day),
  ]);
  const sente = players.get(senteUid)!;
  const gote = players.get(goteUid)!;
  const scale = streakScale(priorGames + 1);
  const goteScore = (1 - senteScore) as Score;

  const senteOut = applyGame({
    rating: sente.rating,
    bestRank: sente.bestRank,
    opponentRating: gote.rating,
    score: senteScore,
    scales: [scale],
  });
  const goteOut = applyGame({
    rating: gote.rating,
    bestRank: gote.bestRank,
    opponentRating: sente.rating,
    score: goteScore,
    scales: [scale],
  });

  await db.batch(
    withPrune(
      db,
      [
        insertGame(db, roomCode, key, day, nowMs),
        upsert(db, senteUid, senteOut, senteScore, nowMs),
        upsert(db, goteUid, goteOut, goteScore, nowMs),
      ],
      nowMs,
    ),
  );
  return { sente: senteOut, gote: goteOut };
}

/**
 * COM戦1局ぶんの反映。呼ぶ前に「1級以下か」「棋譜が本物か」を確かめておくこと。
 * 券（jti）を game_key に使うので、同じ券で2回目を撃つとバッチごと失敗する。
 */
export async function applyBotRating(
  db: D1Database,
  params: {
    ticketId: string;
    uid: string;
    score: Score;
    comRating: number;
    nowMs: number;
  },
): Promise<RatingOutcome | null> {
  const { ticketId, uid, score, comRating, nowMs } = params;
  const day = jstDateKey(nowMs);
  const key = botPairKey(uid);
  const player = await loadPlayer(db, uid);
  const outcome = applyGame({
    rating: player.rating,
    bestRank: player.bestRank,
    opponentRating: comRating,
    score,
    scales: [BOT_SCALE],
  });
  await db.batch(
    withPrune(db, [insertGame(db, ticketId, key, day, nowMs), upsert(db, uid, outcome, score, nowMs)], nowMs),
  );
  return outcome;
}
