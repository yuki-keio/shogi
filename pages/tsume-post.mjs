// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 公式Xの「今日の一問」で、ビルド（画像を作る側）と投稿の予約（scripts/x/）が共有する決まり。
// 予約の側は依存パッケージを入れずに動かすので、ここには何も import しないこと。

/** 投稿に使う難易度。3手詰は、画像を見ただけで考えられて、答えが一目では分からない長さ */
export const POST_LEVEL = "intermediate";

/** 画像の置き場所（配信物の中のパス）。日付ごとに1枚 */
export function postImagePath(date) {
  return `/tsume/post/${date}.png`;
}

const KAN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const ZEN_NUM = ["１", "２", "３", "４", "５", "６", "７", "８", "９"];
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「10月15日（木）」 */
export function formatPostDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日（${weekday}）`;
}

/**
 * 画像の代替テキスト（読み上げ用）。盤の駒を棋譜と同じ「８一竜」の形で全部書き出す。
 * 内部座標は x=0 が9筋、y=0 が一段目。
 */
export function postImageAltText(problem) {
  const pieces = (attacker) =>
    problem.render.cells
      .filter((cell) => (cell.owner === "s") === attacker)
      .map((cell) => `${ZEN_NUM[8 - cell.x]}${KAN_NUM[cell.y]}${cell.label}`)
      .join("、");
  const hand = problem.render.hands.attacker
    .map((entry) => (entry.count > 1 ? `${entry.label}${entry.count}枚` : entry.label))
    .join("、");
  return (
    `詰将棋の問題図（${problem.moves}手詰）。` +
    `攻方：${pieces(true)}。玉方：${pieces(false)}。` +
    `攻方の持駒：${hand || "なし"}。`
  );
}
