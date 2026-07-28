# 将棋Web

ブラウザですぐに遊べる、[GPLv3ライセンス](https://qiita.com/ShigemoriMasato/items/7346eee65f1a47934a26)の将棋ゲームです。インストール不要で、初心者から有段者まで楽しめる本格的な対局環境を提供します。

公式サイト： **[https://shogi.yuki-lab.com/](https://shogi.yuki-lab.com/)**

## 機能

- AI対戦モード：初心者でも遊びやすい「初級」から、有段者レベルの「伝説」まで幅広い難易度を用意しています。
- 将棋盤モード：1台のデバイスを使って、友人や家族と対局できます。
- 通信対戦モード：招待URLを発行してオンラインで対局できます
- 将棋初心者向けのサポート：駒の動き方ガイド付き
- PWA対応

## 開発メモ（ページ構成）

- モードはURLのパスで表現しています。`/` がAI対戦、`/board/` が将棋盤、`/online/` が通信対戦で、それぞれ独立したHTMLとして配信されます。
- `index.html` は3ページ共通の**テンプレート**で、`<!--@@HEAD_SEO@@-->` などのマーカーを `build-pages.mjs` が置換します。ページごとのtitle・description・OGP・構造化データは `pages/pages.mjs`、記事本文は `pages/article.*.html` が定義元です。`npm run build` の中で `dist/` へ書き出され、`sitemap.xml` と `robots.txt` も同時に生成されます。
- テンプレートは `dist/` 配下で配信されるため、HTMLとJSからのアセット参照はすべて絶対パス（`/images/...`）にしてください。相対パスにすると `/board/` 配下で解決先がずれます。
- 旧形式の `?mode=pvp` `?mode=online&room=...` は `pages/legacy-redirect.mjs` がパス形式へ移し替えます。トップページを Worker 経由にしたくないため、この関数は `build-pages.mjs` が `/` のページの `<head>` 先頭へインライン展開します（コメントは埋め込み時に落とされるので、行中コメントや `//` を含む文字列リテラルは書かないこと）。

## 開発メモ（通信対戦）

- ブラウザは同一オリジンの `/api/*` を利用し、各対局は1部屋につき1つの Durable Object `MatchRoom` が管理します。
- 対局状態は Durable Object 内の SQLite に保存し、WebSocket Hibernation API で配信します。WebSocketが利用できない場合はHTTPポーリングへ自動的に切り替わります。
- 参加者は署名付き `playerToken` で認証し、切断判定は60秒の猶予、部屋の有効期限は24時間です。

## コントリビューション

開発へのご参加、大歓迎です！機能追加のアイデアやバグ修正のプルリクエストをお待ちしています。

バグ報告や機能提案、遊んでみた感想などは [フリーゲーム夢現のレビュー欄](https://freegame-mugen.jp/browser/game_14262.html#reviewVote) へいただけると励みになります。

## ライセンス

本プロジェクトは [GPLv3ライセンス](https://qiita.com/ShigemoriMasato/items/7346eee65f1a47934a26) の下で公開されています。ご利用の際はライセンス条項に従ってください。

### クレジット

本アプリケーションの「AI対戦モード」における高難易度オプションの将棋AIには、以下の素晴らしいオープンソースプロジェクトを編集して利用させていただきました。

ベースにしたプロジェクト：
- [YaneuraOu](https://github.com/yaneurao/YaneuraOu) : Original Project
 - Forked : [mizar/YaneuraOu](https://github.com/mizar/YaneuraOu)

その他、参考にしたプロジェクト：
- [usumerican/yaneuraou-suisho-petite](https://github.com/usumerican/yaneuraou-suisho-petite)

そのため本プロジェクトも上記のライセンスを継承し、GPLv3ライセンスとしています。

低〜中難易度の将棋AI、および他の機能・UIは [Yuki Lab](https://yuki-lab.com/) の実装となります。
