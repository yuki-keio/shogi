// SPDX-License-Identifier: GPL-3.0-only

// 「だれかと対戦」の実力値と段級位の計算。ここは**純粋な関数だけ**を置く
// （D1 の読み書きは rating_store.ts、対局への当て込みは match_room.ts / bot_result.ts）。
// 仕様の正本は docs/online-rating-spec.md。
//
// 数字は2本立て。
//   内部レート（internal） … 普通のイロレーティング。画面には出さない
//   実力値（display）… 内部レートから毎回導出するだけ。上振れを盛って気持ちよくする
// リバーシWeb（game/rating_service.py）と同じ起点・同じ倍率にそろえてある。

/** 内部レートの初期値。画面には出さない */
export const INTERNAL_START = 1000;
/** 実力値の初期値。リバーシWebと同じ起点 */
export const DISPLAY_BASE = 1500;
/** 実力値の下限。内部レート0のときの値 */
export const DISPLAY_FLOOR = 100;
/** スタートより上の引き伸ばし。勝ったときの数字を大きく動かす */
const DISPLAY_UP = 2.3;
/** スタートより下の引き伸ばし。負けが込んでも落ち方を緩やかにする */
const DISPLAY_DOWN = 1.4;
/** 1局あたりの変動幅。リバーシWebと同じ */
export const K_FACTOR = 32;

export type RankDef = {
  label: string;
  /** 階級（0=白木 1=青銅 2=銀 3=金 4=紫檀）。3ランクごとに1つ上がる */
  tier: number;
  /** そのランクの下限（実力値）。9級だけ下限なし */
  from: number | null;
};

// 級は100点刻み、段は150点刻み。段を広げているのは、降格が無いぶん
// 上位が安売りにならないようにするため。**この表が段級位の唯一の定義**で、
// 締めたくなったらここだけ触れば済む。
export const RANKS: readonly RankDef[] = [
  { label: "9級", tier: 0, from: null },
  { label: "8級", tier: 0, from: 1200 },
  { label: "7級", tier: 0, from: 1300 },
  { label: "6級", tier: 1, from: 1400 },
  { label: "5級", tier: 1, from: 1500 },
  { label: "4級", tier: 1, from: 1600 },
  { label: "3級", tier: 2, from: 1700 },
  { label: "2級", tier: 2, from: 1800 },
  { label: "1級", tier: 2, from: 1900 },
  { label: "初段", tier: 3, from: 2000 },
  { label: "二段", tier: 3, from: 2150 },
  { label: "三段", tier: 3, from: 2300 },
  { label: "四段", tier: 4, from: 2450 },
  { label: "五段", tier: 4, from: 2600 },
  { label: "六段", tier: 4, from: 2750 },
];

/** 全員ここから始める（5級）。既存プレイヤーも例外なし */
export const START_RANK = 4;
export const MAX_RANK = RANKS.length - 1;
/** 9級のゲージの起点。下限が無いので便宜的に置く */
const LOWEST_RANK_FLOOR = 1100;

export function isValidRank(rank: unknown): rank is number {
  return typeof rank === "number" && Number.isInteger(rank) && rank >= 0 && rank <= MAX_RANK;
}

export function clampRank(rank: number): number {
  if (!Number.isFinite(rank)) return START_RANK;
  return Math.min(MAX_RANK, Math.max(0, Math.trunc(rank)));
}

/** 内部レート → 画面に出す実力値 */
export function displayRating(internal: number): number {
  const safe = Math.max(0, Math.trunc(internal));
  const diff = safe - INTERNAL_START;
  const raw = DISPLAY_BASE + (diff >= 0 ? DISPLAY_UP : DISPLAY_DOWN) * diff;
  return Math.max(DISPLAY_FLOOR, Math.round(raw));
}

/**
 * 実力値 → 内部レート。**COM側の強さを内部スケールに直すためだけ**に使う。
 * 🔴 段級位のしきい値判定に使ってはいけない（丸めのぶん往復が一致しない。
 *    例: internalFromDisplay(2000) = 1217 だが displayRating(1217) = 1999）。
 *    段級位は必ず rankOf(displayRating(internal)) で出すこと。
 */
export function internalFromDisplay(display: number): number {
  const diff = display - DISPLAY_BASE;
  return Math.round(INTERNAL_START + diff / (diff >= 0 ? DISPLAY_UP : DISPLAY_DOWN));
}

/** 実力値から素直に導いた段級位。降格しない扱いは呼び出し側（best_rank との max）で行う */
export function rankOf(display: number): number {
  for (let i = MAX_RANK; i >= 0; i--) {
    const from = RANKS[i].from;
    if (from !== null && display >= from) return i;
  }
  return 0;
}

/** 実際に見せる段級位。一度上がったら戻らない */
export function visibleRank(internal: number, bestRank: number): number {
  return Math.max(clampRank(bestRank), rankOf(displayRating(internal)));
}

export type RankProgress = {
  /** 0〜1。最高位と、実力値が今の段級位の下限を割っているあいだは動かない */
  ratio: number;
  /** 次の段級位まであと何点か。最高位なら null */
  pointsToNext: number | null;
  nextLabel: string | null;
};

/**
 * 次の段級位までの進み具合。
 * 降格しないので「今の段級位の下限を実力値が割っている」状態がありえる。
 * そのときはマイナスを出さずに 0% で止める（ゲージが逆流すると意味が読めない）。
 */
export function rankProgress(display: number, rank: number): RankProgress {
  const index = clampRank(rank);
  const next = RANKS[index + 1];
  if (!next || next.from === null) {
    return { ratio: 1, pointsToNext: null, nextLabel: null };
  }
  const low = RANKS[index].from ?? LOWEST_RANK_FLOOR;
  const span = next.from - low;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (display - low) / span)) : 0;
  return {
    ratio,
    pointsToNext: Math.max(0, next.from - display),
    nextLabel: next.label,
  };
}

/** 対局結果。勝ち=1 / 引き分け=0.5 / 負け=0 */
export type Score = 1 | 0.5 | 0;

/**
 * イロレーティングの変動。
 * プラス側は切り上げ、マイナス側は切り捨て（リバーシWebと同じ非対称丸め）。
 * こうしておくと、どんなに小さくても 0 で止まらず必ず ±1 は動く。
 */
export function eloDelta(mine: number, theirs: number, score: Score): number {
  const expected = 1 / (1 + Math.pow(10, (theirs - mine) / 400));
  const raw = K_FACTOR * (score - expected);
  return raw >= 0 ? Math.ceil(raw) : Math.floor(raw);
}

/** COM戦の変動倍率。人との対局の半分 */
export const BOT_SCALE = 0.5;
/** 段級位がこれを超えたら、COM戦では実力値が一切動かない（1級まで） */
export const BOT_RATED_MAX_RANK = 8;
/** COM戦で実力値が動くのは1日この数まで（雑な稼ぎ止めの保険） */
export const BOT_DAILY_LIMIT = 20;
/** COM戦の棋譜がこれ未満なら受け付けない（雑な捏造だけを弾く保険） */
export const BOT_MIN_MOVES = 12;
/** COM戦の引換券の寿命 */
export const BOT_TICKET_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * COM側の実力値（**表示スケール**）。
 * 「だれかと対戦」のCOM戦は難易度を選べず、AI対戦で最後に選んだ難易度がそのまま使われる。
 * やねうら王級は super に丸められる（online-match.js の getStandardAiDifficulty）ので、
 * ここに出てくるのはこの4つだけ。上限を1級相当（1900）にしてあるので、
 * 難易度を偽っても届く先は変わらない。
 */
export const COM_DISPLAY_RATING: Record<string, number> = {
  easy: 1400,
  medium: 1600,
  hard: 1750,
  super: 1900,
};
const COM_DEFAULT_DIFFICULTY = "medium";

export function comInternalRating(difficulty: unknown): number {
  const key = typeof difficulty === "string" ? difficulty : COM_DEFAULT_DIFFICULTY;
  const display = COM_DISPLAY_RATING[key] ?? COM_DISPLAY_RATING[COM_DEFAULT_DIFFICULTY];
  return internalFromDisplay(display);
}

/**
 * 同じ相手とその日に何局目か → 変動の倍率。
 * 1〜2局目はそのまま、3局目で半分、4局目で4分の1、5局目以降は最小値（±1）。
 * 「変動なし」にしないのは、何も動かないと理由が分からず気持ちが悪いため。
 * 勝ちも負けも同じように小さくする（片方だけ小さいとそこが抜け道になる）。
 */
export function streakScale(gameNumberToday: number): number | "min" {
  if (gameNumberToday <= 2) return 1;
  if (gameNumberToday === 3) return 0.5;
  if (gameNumberToday === 4) return 0.25;
  return "min";
}

/** 倍率をかけたあとの変動。0 に潰さず、符号を保ったまま最低 ±1 を残す */
export function scaleDelta(delta: number, scale: number | "min"): number {
  if (delta === 0) return 0;
  const sign = delta > 0 ? 1 : -1;
  if (scale === "min") return sign;
  const scaled = delta * scale;
  const rounded = sign > 0 ? Math.ceil(scaled) : Math.floor(scaled);
  return rounded === 0 ? sign : rounded;
}

export type RatingOutcome = {
  /** 更新後の内部レート */
  rating: number;
  /** 更新後の到達最高段級位 */
  bestRank: number;
  /** 画面に出す変動幅（実力値の差分。内部レートの差分ではない） */
  displayDelta: number;
  display: number;
  /** 段級位が上がったならそのラベル。上がっていなければ null */
  promotedTo: string | null;
};

/**
 * 1局ぶんの適用。内部レート・到達最高段級位・画面に出す変動幅をまとめて出す。
 * 🔴 変動幅は「実力値を両端で換算してから引いた差」であって、
 *    内部レートの差に倍率をかけたものではない（±1 の食い違いが出る）。
 */
export function applyGame(params: {
  rating: number;
  bestRank: number;
  opponentRating: number;
  score: Score;
  /** COM戦なら 0.5、同じ相手との連戦なら 0.5 / 0.25 / "min" */
  scales?: (number | "min")[];
}): RatingOutcome {
  const before = params.rating;
  let delta = eloDelta(before, params.opponentRating, params.score);
  for (const scale of params.scales ?? []) {
    delta = scaleDelta(delta, scale);
  }
  const after = Math.max(0, before + delta);
  const displayBefore = displayRating(before);
  const displayAfter = displayRating(after);
  const bestRank = Math.max(clampRank(params.bestRank), rankOf(displayAfter));
  const promoted = bestRank > clampRank(params.bestRank);
  return {
    rating: after,
    bestRank,
    displayDelta: displayAfter - displayBefore,
    display: displayAfter,
    promotedTo: promoted ? RANKS[bestRank].label : null,
  };
}

/** 「その日」の区切りは日本時間で数える（深夜0時をまたぐ体感に合わせる） */
export function jstDateKey(nowMs: number): string {
  return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 対人戦の連戦カウント用の鍵。どちらから見ても同じ文字列になるよう辞書順で固定する */
export function pairKey(uidA: string, uidB: string): string {
  return uidA <= uidB ? `${uidA}|${uidB}` : `${uidB}|${uidA}`;
}

/** COM戦のカウント用の鍵。uid は英数字とハイフンだけなので 'COM' とは衝突しない */
export function botPairKey(uid: string): string {
  return `${uid}|COM`;
}

/** 画面に出すぶんだけをまとめた形。ロビーのカードと対局者バーが使う */
export type RatingView = {
  /** 実力値（内部レートではない） */
  rating: number;
  rank: number;
  rankLabel: string;
  /** 階級（0〜4）。バッジの色に使う */
  tier: number;
  /** 0〜1 */
  progress: number;
  pointsToNext: number | null;
  nextLabel: string | null;
};

export function ratingView(internal: number, bestRank: number): RatingView {
  const display = displayRating(internal);
  const rank = visibleRank(internal, bestRank);
  const progress = rankProgress(display, rank);
  return {
    rating: display,
    rank,
    rankLabel: RANKS[rank].label,
    tier: RANKS[rank].tier,
    progress: progress.ratio,
    pointsToNext: progress.pointsToNext,
    nextLabel: progress.nextLabel,
  };
}
