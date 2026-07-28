---
name: project-online-backend
description: 通信対戦バックエンドの現行Cloudflare Workers + Durable Objects構成
metadata:
  type: project
---

通信対戦は、同一オリジンのCloudflare Worker APIと、1部屋につき1インスタンスのDurable Object `MatchRoom`で処理する。状態は各Durable Object内のSQLiteに保存し、WebSocket Hibernation APIで配信する。WebSocketが利用できないクライアントはHTTPポーリングへ自動的に切り替わる。

レビュー時に維持する契約:

- 実装の正本は`src/worker/`。合法手、切断判定、部屋状態、APIルーティング、署名トークンをここで管理する。
- 招待URLは`/online/?room=CODE`（2026-07-28のパス移行以降）。旧形式`/?mode=online&room=CODE`と`/?room=CODE`は実ユーザー間で共有済みのため、`pages/legacy-redirect.mjs`の移し替えを恒久的に維持する（トップページをWorker経由にしないため、`build-pages.mjs`が`/`の`<head>`先頭へインライン展開する方式）。
- uidは再接続資格情報を兼ねるためクライアントへ返さない。クライアントには参加状態と接続ごとの`yourSide`だけを返す。
- `playerToken`はHMAC-SHA256署名であり暗号化ではない。有効期限は部屋と同じ24時間。
- 切断猶予は60秒、両者切断は引き分け、部屋は作成から24時間後にAlarmで削除する。
- テストは`npm test`で実行し、Worker統合テストは`test/`に置く。

Durable Objectのクラスライフサイクル変更を跨ぐ過去versionへの単純なWorker rollbackは前提にしない。復旧が必要な場合は、現行bindingとmigrationを維持したforward deployを設計する。
