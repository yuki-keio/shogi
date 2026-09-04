// SPDX-License-Identifier: GPL-3.0-only

// ブラウザ側の入口。build.sh がこのファイルを esbuild で束ね（グローバル名 KifuCore）、
// shogi.js の後ろに連結して配る。<script> は増やさない（README の「クラシックスクリプト2本」）。
//
// 🔴 連結は shogi.js が先、この束ねたものが後。逆にすると esbuild が出す "use strict" が
//    ファイル先頭のディレクティブになり、shogi.js 全体が strict mode に変わる。

export { clampMoveIndex, decodeKifuParam, encodeKifuParam, KIFU_URL_VERSION } from "./url.ts";
export { formatUsiMove, parseUsiMove, isUsiMoveToken } from "./moves.ts";
export { replayUsiMoves, initialPositionHash } from "./replay.ts";
export { buildNotation, compactNotation, notateMove, KIFU_PIECE_NAMES } from "./notation.ts";
export { describeParsed, detectKifuFormat, formatKif, parseKifuText, HIRATE_SFEN } from "./kif.ts";

// 手筋・囲い・戦法の名前（src/waza/）。<script> を増やさないためにここから出す
export { scanWaza, summarizeWaza, WAZA_NAMES, WAZA_FIRST_SUB } from "../waza/index.ts";
