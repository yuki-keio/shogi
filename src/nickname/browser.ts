// SPDX-License-Identifier: GPL-3.0-only

// ブラウザ側の入口。build.sh がこのファイルを esbuild で束ね（グローバル名 ShogiNames）、
// online-match.js の後ろに連結して配る。/online/ でしか読み込まれない。
//
// 🔴 連結は online-match.js が先、この束ねたものが後。逆にすると esbuild が出す "use strict" が
//    ファイル先頭のディレクティブになり、online-match.js 全体が strict mode の扱いに変わる
//    （src/kifu/browser.ts と同じ理由）。
//
// isGeneratedName も出す。保存済みの名前がいまの語彙から作れるかを読み込み時に確かめるため
// （語彙を直したあとの再訪者に、サーバーで落ちる名前を持たせ続けないための照合。+0.1KB）。

export { MODS, NOUNS, randomName, isGeneratedName } from "./words.ts";
export { initialNameProfile, normalizeCustomName, validCustomName } from "./profile.ts";
