// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// モードはクエリパラメータからパスへ移行した（SEOのため1モード=1ページにした）。
// 旧形式のうち /?mode=online&room=XXXX は実ユーザー間で共有された招待URLなので、
// この移し替えは恒久的に維持する。
//
// このファイルは build-pages.mjs が `/` のページの <head> 先頭へインライン展開する
// （トップページを Worker 経由にせず、静的配信のまま処理するため）。
// そのためクロージャや import に依存しない自己完結した関数のままにすること。
//
// パスの定義元は pages/pages.mjs。shogi.js の MODE_PATHS とも揃えること。

/**
 * 旧クエリ形式のURLなら遷移先の path+query を返す。対象外なら null。
 *
 * この関数のいちばん重要な契約は「素の `/` を絶対に遷移させないこと」。
 * トップページを飛ばしてしまうと、全ユーザーがトップを開けなくなる。
 */
export function resolveLegacyModeRedirect(pathname, search) {
  if (pathname !== "/") return null;

  const MODE_PATHS = { ai: "/", pvp: "/board/", online: "/online/" };

  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const room = params.get("room");
  if (mode === null && room === null) return null;

  const hasRoom = room !== null && room.trim() !== "";

  // room があれば mode の値によらずオンライン対戦。旧クライアントの判定順と揃えている。
  let target;
  if (hasRoom) {
    target = MODE_PATHS.online;
  } else if (mode !== null && Object.prototype.hasOwnProperty.call(MODE_PATHS, mode)) {
    target = MODE_PATHS[mode];
  } else {
    // 未知の mode 値や空の room だけのURLには触らない
    return null;
  }

  // mode はパスで表現するので落とす。utm_* などその他のパラメータは温存する。
  params.delete("mode");
  if (!hasRoom) params.delete("room");

  const query = params.toString();
  const dest = query ? target + "?" + query : target;

  // 結果が同じURLなら遷移しない（ループ防止）
  return dest === pathname + search ? null : dest;
}
