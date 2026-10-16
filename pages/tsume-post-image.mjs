// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 公式Xに毎日投稿する「今日の一問」の画像（PNG）をビルド時に作る。
//
// 投稿は Buffer が予約の時刻に行い、画像はそのとき postImagePath() のURLへ取りに来る。
// だから当日ぶんは、誰がいつデプロイしても配信物に入っていなければならない（ビルドで毎回作る）。
//
// 見た目はサイトの盤（#shogi-board と .piece）に合わせてある。サイト側の色や駒の形を変えたら、
// ここも合わせること。
//
// 正方形にしているのは、タイムラインで切り取られずにいちばん大きく出る比率だから。
// 横長（16:9）だと盤が小さくなり、スマホで駒の字が読めない。
//
// 書体は Yuji Syuku（サイトの駒と同じ。SIL OFL 1.1、fonts/OFL.txt）から、ここで使う文字だけを
// 抜き出したもの。使う文字を増やしたら FONT_CHARS に足して、同じ文字で取り直すこと:
//   curl -s "https://fonts.googleapis.com/css2?family=Yuji+Syuku&text=<FONT_CHARS をURLエンコード>"
//   で返るCSSの url(...)（truetype）を pages/fonts/YujiSyuku-subset.ttf に保存する。

import { Resvg } from "@resvg/resvg-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 埋め込んだ書体に入っている文字。テストがこの集合と書体の中身・画像に出る文字を突き合わせる */
export const FONT_CHARS =
  "歩香桂銀金角飛玉王と杏圭全馬竜一二三四五六七八九本日の詰将棋持駒なしWeb0123456789";

const FONT_FILE = join(dirname(fileURLToPath(import.meta.url)), "fonts", "YujiSyuku-subset.ttf");
const FONT_FAMILY = "Yuji Syuku";

const SIZE = 1200;
const CELL = 92;
const FRAME = 10;
const BOARD_X = 56;
const BOARD_Y = 232;
const GRID_X = BOARD_X + FRAME;
const GRID_Y = BOARD_Y + FRAME;
const BOARD_OUTER = CELL * 9 + FRAME * 2;
/** サイトの駒は升目の約87%（52pxの升に45px） */
const PIECE = 80;
const HAND_X = 1070;

const KAN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
/** 出題データの成駒（2文字）を、サイトの盤（shogi.js の pieceNames）と同じ1文字にする */
const BOARD_LABEL = { 成香: "杏", 成桂: "圭", 成銀: "全" };

const COLOR = {
  text: "#fbeedb",
  muted: "#d4bd9c",
  frame: "#5c3d2e",
  line: "rgb(160,132,100)",
  piece: "rgb(255,239,197)",
  pieceBase: "rgb(136,90,67)",
  ink: "#333",
  promoted: "#E60033",
};

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 文字。筆の書体はサイトでも太字（ブラウザが合成）で出しているので、同じ色の縁取りで太らせる。
 * anchor は SVG の text-anchor。
 */
function text(x, y, content, { size, fill, anchor = "middle", weight = size / 34, opacity } = {}) {
  const extra = opacity === undefined ? "" : ` opacity="${opacity}"`;
  return (
    `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" text-anchor="${anchor}" ` +
    `fill="${fill}" stroke="${fill}" stroke-width="${weight.toFixed(2)}" stroke-linejoin="round"${extra}>` +
    `${escapeXml(content)}</text>`
  );
}

/** 駒の五角形。サイトの clip-path: polygon(50% 0, 90% 20%, 95% 100%, 5% 100%, 10% 20%) と同じ */
function piecePolygon(x, y, size) {
  const p = (px, py) => `${(x + px * size).toFixed(1)},${(y + py * size).toFixed(1)}`;
  return [p(0.5, 0), p(0.9, 0.2), p(0.95, 1), p(0.05, 1), p(0.1, 0.2)].join(" ");
}

/**
 * 駒1枚。(cx, cy) は駒の中心。gote は180度回す。
 * 底の帯はサイトの border-bottom（2.5px / 45px）に相当する。
 */
function piece(cx, cy, label, { gote = false, promoted = false, size = PIECE } = {}) {
  const x = cx - size / 2;
  const y = cy - size / 2;
  const band = size * 0.055;
  // 底の帯は五角形の下端の台形。側面の傾き（10%→5% を 80% の高さで）に合わせて内側へ寄せる
  const inset = 0.05 * size + (0.05 * size * band) / (0.8 * size);
  const bandPoints = [
    `${(x + inset).toFixed(1)},${(y + size - band).toFixed(1)}`,
    `${(x + size - inset).toFixed(1)},${(y + size - band).toFixed(1)}`,
    `${(x + 0.95 * size).toFixed(1)},${(y + size).toFixed(1)}`,
    `${(x + 0.05 * size).toFixed(1)},${(y + size).toFixed(1)}`,
  ].join(" ");
  const ink = promoted ? COLOR.promoted : COLOR.ink;

  const glyph = text(cx, y + size * 0.82, BOARD_LABEL[label] ?? label, { size: size * 0.64, fill: ink });

  const rotate = gote ? ` transform="rotate(180 ${cx} ${cy})"` : "";
  return (
    `<g${rotate}>` +
    `<polygon points="${piecePolygon(x, y, size)}" fill="${COLOR.piece}"/>` +
    `<polygon points="${bandPoints}" fill="${COLOR.pieceBase}"/>` +
    glyph +
    `</g>`
  );
}

function renderBoard(render) {
  const parts = [];
  // 盤の影・枠・盤面（サイトの #shogi-board: 5px の枠と放射状のグラデーション）
  parts.push(
    `<rect x="${BOARD_X}" y="${BOARD_Y + 8}" width="${BOARD_OUTER}" height="${BOARD_OUTER}" fill="#000" opacity="0.35" filter="url(#shadow)"/>`,
    `<rect x="${BOARD_X}" y="${BOARD_Y}" width="${BOARD_OUTER}" height="${BOARD_OUTER}" fill="${COLOR.frame}"/>`,
    `<rect x="${GRID_X}" y="${GRID_Y}" width="${CELL * 9}" height="${CELL * 9}" fill="url(#wood)"/>`,
  );
  for (let i = 0; i <= 9; i++) {
    const offset = i * CELL;
    parts.push(
      `<line x1="${GRID_X + offset}" y1="${GRID_Y}" x2="${GRID_X + offset}" y2="${GRID_Y + CELL * 9}" stroke="${COLOR.line}" stroke-width="1.6"/>`,
      `<line x1="${GRID_X}" y1="${GRID_Y + offset}" x2="${GRID_X + CELL * 9}" y2="${GRID_Y + offset}" stroke="${COLOR.line}" stroke-width="1.6"/>`,
    );
  }
  // 筋（上の算用数字）と段（右の漢数字）。答えを「２三金」のように書いてもらうのに要る
  for (let i = 0; i < 9; i++) {
    const center = i * CELL + CELL / 2;
    parts.push(text(GRID_X + center, BOARD_Y - 14, String(9 - i), { size: 34, fill: COLOR.muted }));
    parts.push(text(BOARD_X + BOARD_OUTER + 27, GRID_Y + center + 12, KAN_NUM[i], { size: 34, fill: COLOR.muted }));
  }
  for (const cell of render.cells) {
    parts.push(
      piece(GRID_X + cell.x * CELL + CELL / 2, GRID_Y + cell.y * CELL + CELL / 2, cell.label, {
        gote: cell.owner !== "s",
        promoted: cell.promoted,
      }),
    );
  }
  return parts.join("");
}

/** 攻方の持駒。詰将棋の図の慣習どおり盤の右に縦に並べる。玉方の持駒（残り全部）は描かない */
function renderHand(render) {
  const parts = [text(HAND_X, BOARD_Y + 40, "持駒", { size: 44, fill: COLOR.text })];
  const hand = render.hands.attacker;
  if (hand.length === 0) {
    parts.push(text(HAND_X, BOARD_Y + 110, "なし", { size: 40, fill: COLOR.muted }));
    return parts.join("");
  }
  hand.forEach((entry, index) => {
    const cy = BOARD_Y + 120 + index * 102;
    const hasCount = entry.count > 1;
    const cx = hasCount ? HAND_X - 16 : HAND_X;
    parts.push(piece(cx, cy, entry.label));
    if (hasCount) parts.push(text(cx + 62, cy + 30, String(entry.count), { size: 40, fill: COLOR.text }));
  });
  return parts.join("");
}

export function renderPostSvg(problem) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d2a1f"/><stop offset="1" stop-color="#22170f"/></linearGradient>`,
    `<radialGradient id="wood" cx="0.5" cy="0.5" r="0.7"><stop offset="0" stop-color="rgb(228,189,140)"/><stop offset="1" stop-color="rgb(212,168,109)"/></radialGradient>`,
    `<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="10"/></filter>`,
    `</defs>`,
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>`,
    text(BOARD_X, 128, "本日の詰将棋", { size: 68, fill: COLOR.text, anchor: "start" }),
    renderBoard(problem.render),
    renderHand(problem.render),
    piece(SIZE - 282, SIZE - 64, "歩", { size: 52 }),
    text(SIZE - 40, SIZE - 46, "将棋Web", { size: 48, fill: COLOR.text, anchor: "end" }),
    `</svg>`,
  ].join("");
}

export function renderPostPng(problem) {
  const resvg = new Resvg(renderPostSvg(problem), {
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}
