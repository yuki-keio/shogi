// SPDX-License-Identifier: GPL-3.0-only

// だれかと対戦（人間どうし）の対局記録。ソフト指しを見つけるための材料で、
// 本体とは別の D1（binding: RECORDS）に1局1行で残す。
// 記録するのは、棋譜・1手ごとの考えた時間・指した側が手番中に別の画面へ切り替えた回数と時間・
// 端末の種類・対局前後の実力値だけ。IPアドレスと表示名は残さない。
// 🔴 uid は記録の控えを戻す鍵と再接続の合鍵を兼ねるので、ここから外へ出さないこと。

export type DeviceKind = "pc" | "mobile" | "tablet";

/** 古い行を消す期間（約3か月）と、安全弁の行数の上限 */
export const RECORD_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
export const RECORD_MAX_ROWS = 2_000_000;
/** 行数の上限の掃除は、書き込みのついでにときどきだけ行う（rated_game と同じやり方） */
const CAP_PRUNE_PROBABILITY = 0.02;

/** 画面側から届く「画面を離れた回数」の上限。1手30秒でこれを超えることはない */
const AWAY_COUNT_MAX = 99;
/** 画面を離れた時間の上限に足す余裕。手番の始まりの猶予と通信の遅れを吸収する */
const AWAY_MS_MARGIN = 10_000;

/**
 * 端末の種類。User-Agent と、画面側が送る「タッチ端末か」（navigator.maxTouchPoints > 1）で決める。
 * iPadOS の Safari は Mac と同じ名乗り方をするので、Mac でタッチ端末ならタブレットとみなす。
 * Windows のタッチ対応ノートや Chromebook は PC のまま。
 */
export function deviceKind(userAgent: string | null, touch: boolean): DeviceKind | null {
  const ua = userAgent ?? "";
  if (!ua) return null;
  if (/iPhone|iPod/.test(ua)) return "mobile";
  if (/iPad/.test(ua)) return "tablet";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "mobile" : "tablet";
  if (/Macintosh/.test(ua) && touch) return "tablet";
  if (/Windows|Macintosh|CrOS|Linux|X11/.test(ua)) return "pc";
  return null;
}

/** 部屋に預ける端末の種類。決まった値だけを通す */
export function normalizeDevice(value: unknown): DeviceKind | null {
  return value === "pc" || value === "mobile" || value === "tablet" ? value : null;
}

export type AwayStats = { count: number; ms: number };

/**
 * 画面側から届いた「手番中に画面を離れた回数・時間」を丸める。
 * 無い・壊れている値は null（記録では空＝不明になる）。
 */
export function clampAway(count: unknown, ms: unknown, tcSeconds: number): AwayStats | null {
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const maxMs = Math.max(0, tcSeconds) * 1000 + AWAY_MS_MARGIN;
  return {
    count: Math.min(AWAY_COUNT_MAX, Math.max(0, Math.round(count))),
    ms: Math.min(maxMs, Math.max(0, Math.round(ms))),
  };
}

/** 値が届かなかった手の印。0 と区別するため空にはしない */
export const UNKNOWN_PLY = "-";

/** カンマ区切りの列に1手ぶん足す。まだ1手も無い列は NULL */
export function appendPly(prev: string | null, value: string): string {
  return prev === null || prev === "" ? value : `${prev},${value}`;
}

/** カンマ区切りの列が何手ぶんか */
export function plyCount(list: string | null): number {
  return list === null || list === "" ? 0 : list.split(",").length;
}

export type GameRecord = {
  roomCode: string;
  startedAt: number | null;
  endedAt: number;
  senteUid: string;
  goteUid: string;
  winner: string | null;
  resultReason: string | null;
  moves: string[];
  plyMs: string;
  plyAway: string;
  plyAwayMs: string;
  senteDevice: DeviceKind | null;
  goteDevice: DeviceKind | null;
  senteRatingAfter: number | null;
  senteRatingDelta: number | null;
  goteRatingAfter: number | null;
  goteRatingDelta: number | null;
  senteRank: number | null;
  goteRank: number | null;
};

function before(after: number | null, delta: number | null): number | null {
  return typeof after === "number" && typeof delta === "number" ? after - delta : null;
}

/**
 * 1局ぶんを保存する。同じ部屋は二度入らない（room_code が一意）。
 * 期間を過ぎた行は毎回消す（索引で引くので軽い。対局が少ない時期も「最長3か月」を守るため）。
 * 行数の上限を超えた古い行は、ときどきだけ消す。
 */
export async function saveGameRecord(
  db: D1Database,
  record: GameRecord,
  nowMs: number,
  // テスト用の差し替え口（掃除を必ず走らせる・上限を小さくする）
  opts: { random?: () => number; keepMs?: number; maxRows?: number } = {},
): Promise<void> {
  const { random = Math.random, keepMs = RECORD_KEEP_MS, maxRows = RECORD_MAX_ROWS } = opts;
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO online_game_record (
           room_code, started_at, ended_at, sente_uid, gote_uid, winner, result_reason,
           moves, ply_ms, ply_away, ply_away_ms, sente_device, gote_device,
           sente_rating_before, sente_rating_after, gote_rating_before, gote_rating_after,
           sente_rank, gote_rank
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
      )
      .bind(
        record.roomCode,
        record.startedAt,
        record.endedAt,
        record.senteUid,
        record.goteUid,
        record.winner,
        record.resultReason,
        record.moves.join(" "),
        record.plyMs,
        record.plyAway,
        record.plyAwayMs,
        record.senteDevice,
        record.goteDevice,
        before(record.senteRatingAfter, record.senteRatingDelta),
        record.senteRatingAfter,
        before(record.goteRatingAfter, record.goteRatingDelta),
        record.goteRatingAfter,
        record.senteRank,
        record.goteRank,
      ),
  ];
  statements.push(
    db.prepare("DELETE FROM online_game_record WHERE ended_at < ?1").bind(nowMs - keepMs),
  );
  if (random() < CAP_PRUNE_PROBABILITY) {
    // id は増える一方なので、最新の id から数えて上限より古い行を消せば「新しい順に上限まで」になる
    statements.push(
      db
        .prepare(
          "DELETE FROM online_game_record WHERE id <= (SELECT MAX(id) FROM online_game_record) - ?1",
        )
        .bind(maxRows),
    );
  }
  await db.batch(statements);
}
