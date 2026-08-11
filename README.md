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

- モードはURLのパスで表現しています。`/` がAI対戦、`/board/` が将棋盤、`/online/` が通信対戦、`/tsume/` が詰将棋で、それぞれ独立したHTMLとして配信されます。
- `index.html` は4ページ共通の**テンプレート**で、`<!--@@HEAD_SEO@@-->` などのマーカーを `build-pages.mjs` が置換します。ページごとのtitle・description・OGP・構造化データは `pages/pages.mjs`、記事本文は `pages/article.*.html` が定義元です。`npm run build` の中で `dist/` へ書き出され、`sitemap.xml` と `robots.txt` も同時に生成されます。
- テンプレートは `dist/` 配下で配信されるため、HTMLとJSからのアセット参照はすべて絶対パス（`/images/...`）にしてください。相対パスにすると `/board/` 配下で解決先がずれます。
- クライアントのJSは `shogi.js`（4ページ共通）と `shogi-tsume.js`（詰将棋モードだけ）の2本立てです。詰将棋のロジックは全体の約3割あるので、`/`・`/board/`・`/online/` では読み込みません。どちらも `<script defer>` のクラシックスクリプトでグローバルスコープを共有しており、`shogi.js` から詰将棋を呼ぶ入口は `tsumeBridge`（`shogi.js` で定義し、`shogi-tsume.js` の末尾で中身を入れる）の5つだけです。詰将棋側が未読み込みのページでも壊れないようにするための窓口なので、直接呼び出しを増やさないでください。
- 起動は `shogi.js` 末尾の `DOMContentLoaded` → `bootGame()` です。`shogi-tsume.js` の評価が終わってから走らせる必要があるので、`index.html` の2つの `<script>` から `defer` を外したり順序を入れ替えたりしないでください。
- 旧形式の `?mode=pvp` `?mode=online&room=...` は `pages/legacy-redirect.mjs` がパス形式へ移し替えます。トップページを Worker 経由にしたくないため、この関数は `build-pages.mjs` が `/` のページの `<head>` 先頭へインライン展開します（コメントは埋め込み時に落とされるので、行中コメントや `//` を含む文字列リテラルは書かないこと）。

## 開発メモ（詰将棋）

- 問題は `scripts/tsume/` が GitHub Actions 上で自動生成し、`tsume_data/` にコミットして在庫30日分を保ちます。出題の検証（手数・余詰・駒余り）に使う KomoringHeights は**配信するサイト側では動きません**。当日の5問はビルド時にHTMLへ焼き込まれます。
- 難易度は7段階（初級=1手詰 〜 超越=13手詰）で、**種局面はAIの自己対局から採ります**。採れなかった手数だけ `search.ts` のランダム配置＋焼きなましで埋めます。自己対局にはリポジトリ同梱のやねうら王WASM（`yaneuraou/`、サイトのAI対戦と同じもの）をそのまま Node で動かすので、追加のビルドも評価関数ファイルも要りません。
- **「終局からN手前だからN手詰」と対応させてはいけません。** 勝つ側は終局の5手ほど手前まで最短の詰みを読み切っておらず、遠回りに詰ますことがあります。実測では距離17手以上で一致率が0%になり、長手数がまったく採れませんでした。局面ごとにソルバーが返す実際の手数で分類します（`MINE_LENGTHS`）。
- **玉方の持ち駒は詰将棋のルール通り**、盤上にも攻方の持ち駒にもない駒すべてです。実戦局面ではこれが実戦でその人が持っていた持ち駒と一致するので、攻方の玉を外す以外の改変がゼロになります。副次的に余詰も消えます（既存在庫40問で試して余詰・駒余りともに0件）。
- 実戦由来にしている理由は、ランダム配置だと1手詰・3手詰の約45%が裸玉（玉方が玉1枚）になり、駒がそこにある理由を説明できない盤が混ざるためです。実戦の詰みは玉方自身の駒が逃げ道を塞いで成立するので、削っても守り駒が残ります。
- **採るのは「実際に指された詰み」ではなく「実際に現れた局面にある詰み」です。** 攻方の玉を外す必要があり、それだけでも詰み手数は変わり得ます。だから手数は必ず変換の**後**に測ります（`mine.ts`）。
- 削る作業（`minimize.ts`）は玉方の持ち駒が空の状態で行い、**削り終えてから**ルール通りの持ち駒に直します。順序が逆だと、削った駒が玉方の持ち駒に回って受けが強くなり、詰みが壊れます。
- 自己対局は**必ず別プロセス**で動かします（`selfplay_child.ts`）。やねうら王WASMは探索中 Node のメインスレッドを専有し、`generate.ts` に同居させると全ワーカーと USI のタイムアウトが巻き添えで止まります。
- 採掘の歩留まりを在庫の前提にしないよう、手数ごとに一定局数で見切って探索生成に戻し、制限時間の残り1/4は探索生成に一本化します。
- ブラウザ側には別に小さな詰み探索（`src/tsume/solver.ts`）があり、詰将棋ページでだけ Web Worker として動きます。利用者が作意から外れた手を指したとき、玉方が「その手数内では絶対に詰まない逃げ方」を選ぶのに使います。`build.sh` が esbuild で `/tsume-solver.js` に束ねます。駒の動きは `src/worker/shogi_engine.ts` の `PIECE_MOVEMENTS` を出題の検証側と共有しており、両者が食い違わないことを `scripts/tsume/solver.test.ts` が在庫全問で確かめます。
- この探索は結論が出せなければ必ず「わからない」を返し、そのとき画面は従来どおり手を戻して警告します。推測で玉方を指させると「本当は詰まないのに正解」が出てしまうためです。
- 手元で試すには次の順に実行します。エンジンは `.engines/` に置かれ、git 管理外です。

  ```
  bash scripts/tsume/engine_setup.sh   # 初回のみ（数分〜20分）
  npm run tsume:generate -- --minutes=30
  npm run tsume:plan
  npm run tsume:check                  # 在庫を独立に再検証
  ```

- 採掘の歩留まりを測るときは `--dry-run` を付けます。プールには書かず、各段の通過数だけを出します。生成方式を触ったらまずこれで効きを見ます。

  ```
  node scripts/tsume/generate.ts --minutes=10 --workers=2 --selfplay-procs=2 --dry-run
  ```

- 攻方は常に先手で、盤上に攻方の玉を置きません。`isKingInCheck()` は玉が見つからなければ false を返すので、既存の合法手生成はそのまま使えます。
- 出題済みの局面は `tsume_data/registry.json` に控えて再出題しません。例外は `REUSE_AFTER_DAYS`（`scripts/tsume/config.ts`）に載せた手数だけで、1手詰・3手詰は作れる形が限られているため1年空けたら再び出します。再出題は在庫切れの穴埋めであり、未出題の問題があるかぎりそちらが先に出ます。再出題の割合が高くなると `plan.ts` が警告します（在庫切れが表に出なくなるため）。
- 難易度と手数の対応（初級=1手詰〜超越=13手詰）は `scripts/tsume/config.ts` の `LEVEL_MOVES` が唯一の定義元です。ここを変えたら `tsume_data/daily/*.json` と `registry.json` を消して `npm run tsume:plan` をやり直します（作成済みの出題は古い対応のままのため）。

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

この YaneuraOu は「詰将棋モード」でも使っています。初級〜上級（1/3/5手詰）の種局面を作る自己対局を GitHub Actions 上で回す用途で、配信するサイト側での使われ方は AI対戦モードと変わりません。

また「詰将棋モード」の問題は、以下の詰将棋専用エンジンで検証したうえで出題しています（GitHub Actions 上でのみ使用し、配信するサイトには含まれません）。

- [komori-n/KomoringHeights](https://github.com/komori-n/KomoringHeights) : やねうら王ベースの df-pn 詰将棋ソルバー（GPLv3）

そのため本プロジェクトも上記のライセンスを継承し、GPLv3ライセンスとしています。

低〜中難易度の将棋AI、および他の機能・UIは [Yuki Lab](https://yuki-lab.com/) の実装となります。
