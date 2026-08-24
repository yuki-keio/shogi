# 将棋Web（shogi.yuki-lab.com）

Cloudflare Workers Static Assets（配信）+ Worker API / Durable Objects（通信対戦）+ D1（フィードバック）。
高難易度AIは YaneuraOu 改造版（`yaneuraou/`）。ブランチは `main` 直で作業する。

## 設計判断は README.md が正本

アーキテクチャの決定事項と落とし穴は `README.md` の「開発メモ」3節に書いてある。**このファイルでは繰り返さない。**
触る前に該当節を読むこと。

| 触る場所 | 先に読む節 |
|---|---|
| ページ構成 / `shogi.js` / 棋譜 | README「開発メモ（ページ構成）」 |
| 詰将棋 | README「開発メモ（詰将棋）」 |
| 通信対戦 / マッチング / 表示名 | README「開発メモ（通信対戦）」 |

機能仕様の正本は `docs/kifu-spec.md`（棋譜）、`docs/online-matchmaking-spec.md`（だれかと対戦）、
`docs/online-rating-spec.md`（レート・段級位）。

## コマンド

```bash
npm run build        # dist/ を生成
npm test             # vitest + 詰将棋のテスト
npm run cf:dev       # ビルドしてローカル起動（wrangler dev）
npm run cf:dry-run   # 本番に出さずにデプロイ内容を検証
```

## push = 本番デプロイ（最重要）

`main` への push で GitHub Actions が走り、**ビルド → D1マイグレーションを本番DBに適用 → wrangler deploy** まで自動で通る。
ステージング環境は無い。

**push は原則ユーザーが行う。AI側はコミットまで。** push が要るときは必ず事前に確認を取る。
`deploy_timestamp.txt` と `Deploy: <時刻>` コミットはこの運用の副産物なので、手で書き換えない。

## 編集してよい場所 / だめな場所

**これが正本（編集する）**

- ルート直下: `shogi.js` `shogi-tsume.js` `online-match.js` `name-filter.js` `ai-worker.js` `yaneuraou-worker.js` `style.css` `service-worker.js`
- `index.html` … 4ページ（`/` `/board/` `/online/` `/tsume/`）共通の**テンプレート**。`pages/` が中身の定義元
- `src/` … TypeScript（`worker/`=Worker本体・`kifu/`=棋譜コア・`tsume/`=ブラウザ側ソルバー）
- `scripts/tsume/` … 詰将棋の生成・検証（GitHub Actions から動く）
- `test/` … vitest

**生成物・自動更新（編集しない）**

- `dist/` … `build.sh` が毎回 `rm -rf` して作り直す
- ルートの8桁ハッシュ付き `shogi.*.js` `style.*.css` 等 … ビルドの残骸（.gitignore 済み）
- `tsume_data/` … 日次ジョブ（`tsume-daily.yml`、毎日 04:00 JST）が書く
- `node_modules/` `.wrangler/` `.engines/` `dev/`

**`build.sh` は処理の順序そのものが仕様。** ハッシュを採る位置、sed と minify の前後関係、`shogi.js` と棋譜コアの連結順が全部意味を持つ。
順序を変えると「名前は同じで中身が違う」ファイルが生まれ、1年 immutable で配っている都合上、再訪ユーザーが壊れた組み合わせを掴み続ける。
触る前にファイル内のコメントを読むこと。

## このリポジトリ固有の決まり

- **CSSの置き場所**: ファーストビューに関わるものは `index.html` に Critical CSS として1行に最小化して書く。それ以外は `style.css`。同じ指定を両方に書かない。
- **`gunjin/` は別アプリ（軍人将棋）。** それ以外は普通の将棋。混同しない。ビルドでは `gunjin/` はコピーされるだけで minify もハッシュ付与もされない。
- `CLAUDE.md` はこのファイルを読み込むだけの1行。指示を足すときは `AGENTS.md` 側に書く。
