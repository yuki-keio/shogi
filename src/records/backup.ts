// SPDX-License-Identifier: GPL-3.0-only

// 設定・進み具合・戦績をサーバーに控え、ブラウザが保存データを消したときに戻す。ここは IndexedDB に触らない部分。
//
// Safari系（iPhone・iPadの全ブラウザとMacのSafari）は、しばらく触られていないサイトの
// localStorage・IndexedDB を自動で消す。サーバーが発行した Cookie は消さないので、控えの鍵の
// 番号（uid）を Cookie にも入れておく。ブラウザ内から番号が消えていて Cookie にだけ残っていれば
// 「保存データが消えた」と分かる（通信せずに判定できるので、消えていない人は何も待たない）。
//
// 🔴 戻し終わるまでは控えを送らない。送ると、消えた直後の空に近い状態で控えを上書きしてしまう。

export const UID_KEY = "shogi_online_uid";
/** 設定と進み具合（localStorage）をまだ戻していない印 */
export const RESTORE_LOCAL_KEY = "shogi_restore_local";
/** 戦績（IndexedDB）をまだ戻していない印 */
export const RESTORE_RECORDS_KEY = "shogi_restore_records";
/** 控えに送り済みの対局のうち、いちばん新しい終了時刻 */
const SYNCED_KEY = "shogi_backup_synced";
/**
 * この端末から控えを送れた印。Cookie はロビーの段級位の取得でも配るので、Cookie があるだけでは
 * 控えがあるとは言えない（ロビーを見ただけの人の最初の控えが漏れる）
 */
const BACKED_UP_AT_KEY = "shogi_backup_at";

/**
 * 控えに載せる localStorage。載せないのは、遊びかけの対局（大きく、消えても困らない）・
 * 通信対戦の不具合の記録（一時的）・uid 自身（Cookie で戻す）・この仕組みの印。
 * キーを足したら、ここにも足すかを決めること（載せ忘れると、消えたときにそれだけ戻らない）。
 */
const BACKED_UP_KEYS = [
  // 進み具合
  "shogi_unlocked_levels", "shogi_ai_win_count", "shogi_tsume_v1", "shogi_waza_book",
  "shogi_tutorial_done", "shogi_mm_exempt", "shogiMoveDemoSeen",
  "shogi_wait_tsume_level", "shogi_wait_tsume_seen", "shogi_wait_tsume_hint",
  // 表示名と段級位
  "shogi_player_name", "shogi_name_auto", "shogi_name_custom", "shogi_name_invitation",
  "shogi_rank_hidden", "shogi_online_rank", "shogi_feedback_id",
  // 設定
  "shogi_ai_difficulty", "shogi_piece_display_mode", "shogi_move_hint", "shogi_waza_fx", "aiPlayerSide",
  "shogi_bot_fallback", "shogi_sound_move", "shogi_sound_join", "shogi_sound_byoyomi",
  "shogi_friend_side", "shogi_friend_tc", "pwa-banner-dismissed",
];

/** 控えの本体の上限（サーバーは 48KB で断る）。データが消えた人が駒を並べる前に待つ通信でもあるので小さく保つ */
export const PROFILE_MAX_LENGTH = 44 * 1024;
/** これ未満しか遊んでいない人は控えない（1〜2局だけの人まで控えると、サーバーの容量の大半がそれで埋まる） */
const MIN_PROGRESS = 3;

const COOKIE_UID = /(?:^|;\s*)__Host-shogi_uid=([0-9a-zA-Z-]{8,64})(?=;|$)/;

export function cookieUid(): string | null {
  try {
    return document.cookie.match(COOKIE_UID)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface LostStorage {
  uid: string;
  /** 設定と進み具合を戻す必要がある（ページを開いた直後、駒を並べる前に戻す） */
  local: boolean;
  /** 戦績を戻す必要がある（並べ終わった後に戻す） */
  records: boolean;
}

/**
 * 保存データが消えていたら、番号を Cookie から戻して、戻すべきものを返す。消えていなければ null。
 * 🔴 shogi.js の detectLostStorage と同じ判定。片方だけ変えないこと
 */
export function detectLostStorage(): LostStorage | null {
  try {
    let uid = localStorage.getItem(UID_KEY);
    if (!uid) {
      uid = cookieUid();
      if (!uid) return null;
      localStorage.setItem(UID_KEY, uid);
      localStorage.setItem(RESTORE_LOCAL_KEY, "1");
      localStorage.setItem(RESTORE_RECORDS_KEY, "1");
    }
    const local = localStorage.getItem(RESTORE_LOCAL_KEY) === "1";
    const records = localStorage.getItem(RESTORE_RECORDS_KEY) === "1";
    return local || records ? { uid, local, records } : null;
  } catch {
    return null;
  }
}

export function restorePending(): boolean {
  try {
    return localStorage.getItem(RESTORE_LOCAL_KEY) === "1" || localStorage.getItem(RESTORE_RECORDS_KEY) === "1";
  } catch {
    return true; // 確かめられないなら送らない側に倒す
  }
}

export function finishRestore(key: typeof RESTORE_LOCAL_KEY | typeof RESTORE_RECORDS_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch { /* 次に開いたときにもう一度戻そうとするだけ */ }
}

export function collectLocal(): Record<string, string> {
  const local: Record<string, string> = {};
  for (const key of BACKED_UP_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) local[key] = value;
  }
  return local;
}

/** 控えの設定と進み具合を書き戻す。消えた直後の既定値は上書きしてよい */
export function applyLocal(local: unknown): void {
  if (typeof local !== "object" || local === null) return;
  for (const key of BACKED_UP_KEYS) {
    const value = (local as Record<string, unknown>)[key];
    if (typeof value === "string") localStorage.setItem(key, value);
  }
}

/**
 * 控えを作る価値があるか。通信対戦（友達対戦を含む）を1局以上した人と、ある程度遊んだ人だけ。
 * 番号の有無では決めない（「だれかと対戦」を開いただけで作られる。段級位は Cookie の番号だけで戻る）。
 * 戦績は 2026-09 から数え始めたので、それより前から遊んでいる人の進み具合も見る。
 */
export function worthBackingUp(onlineGames: number, recordsProgress: number): boolean {
  if (onlineGames > 0 || recordsProgress >= MIN_PROGRESS) return true;
  try {
    const levels = JSON.parse(localStorage.getItem("shogi_unlocked_levels") || "[]");
    const tsume = JSON.parse(localStorage.getItem("shogi_tsume_v1") || "null");
    return (Array.isArray(levels) && levels.length > 0)
      || Number(localStorage.getItem("shogi_ai_win_count")) >= MIN_PROGRESS
      || Number(tsume?.total) >= MIN_PROGRESS;
  } catch {
    return false;
  }
}

/**
 * 控えの本体を上限に収める。はみ出したら詰将棋の記録を古い方から削る
 * （解き直した過去問を二重に数えない守りが少し弱まるだけで、ほかは戻る）。
 */
export function fitProfile<T extends { records: { tsume: unknown[] } | null }>(profile: T, limit = PROFILE_MAX_LENGTH): T {
  const tsume = profile.records?.tsume;
  while (tsume?.length && JSON.stringify(profile).length > limit) tsume.splice(0, Math.max(1, Math.ceil(tsume.length / 4)));
  return profile;
}

export function syncedUntil(): number {
  try {
    return Number(localStorage.getItem(SYNCED_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function hasBackedUp(): boolean {
  try {
    return localStorage.getItem(BACKED_UP_AT_KEY) !== null;
  } catch {
    return false;
  }
}

export function markBackedUp(): void {
  try {
    localStorage.setItem(BACKED_UP_AT_KEY, String(Date.now()));
  } catch { /* 次に開いたときにもう一度最初の控えを送るだけ */ }
}

export function markSynced(endedAt: number): void {
  try {
    if (endedAt > syncedUntil()) localStorage.setItem(SYNCED_KEY, String(endedAt));
  } catch { /* 次の控えで同じ対局を送り直すだけ（サーバーが重複を捨てる） */ }
}

export async function postBackup(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return json && typeof json === "object" && json.ok === true ? json : null;
}
