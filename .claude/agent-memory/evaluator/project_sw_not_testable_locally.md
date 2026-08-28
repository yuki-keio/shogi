---
name: sw-not-testable-locally
description: Service Worker はローカルでは動かない（index.html が localhost/127.x/[::1] で unregister する）ため、SW経由のキャッシュ挙動は本番でしか確認できない
metadata:
  type: project
---

`index.html` の末尾にある Service Worker 登録スクリプトは、`location.hostname` が
`localhost` / `[::1]` / `127.x.x.x` のとき **登録せず、既存の登録を unregister し、
`shogi-web` で始まるキャッシュも削除する**。

**Why:** 開発中に古いキャッシュを掴まないための意図的な作り。

**How to apply:**
- `npm run cf:dev`（wrangler dev, localhost）でも、静的配信でも、SWは一切動かない。
  「SWのキャッシュに入ること」を前提にした主張は、ローカル確認では検証できない＝未検証として扱う。
- 検証したい場合の選択肢は本番（shogi.yuki-lab.com）で DevTools → Application → Cache Storage →
  `shogi-web-v1` を見るか、`localhost` 以外のホスト名で配信すること。
  ただし Claude の Browser ペイン環境では SW 登録自体が失敗する（`An unknown error occurred
  when fetching the script.`）ので、ブラウザツールでの代替検証も不可。
- SW を経由しない挙動（どのアセットを何回取りに行くか、Worker の起動有無）は
  ローカル配信＋サーバのアクセスログで確認できる。
