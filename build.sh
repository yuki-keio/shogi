#!/bin/bash
# Cloudflare Workers Static Assets 用の本番ビルドを dist/ に生成するスクリプト

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DIST_DIR="${DIST_DIR:-dist}"
case "$DIST_DIR" in
	"" | "/" | ".")
		echo "Invalid DIST_DIR: ${DIST_DIR}" >&2
		exit 1
		;;
esac

hash_file() {
	local file="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file" | awk '{print $1}'
		return
	fi
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file" | awk '{print $1}'
		return
	fi

	echo "sha256sum/shasum が見つかりません" >&2
	exit 1
}

# minify すると先頭の `//` コメントは落ちるので、ライセンス表示は banner で入れ直す
LICENSE_BANNER='SPDX-License-Identifier: GPL-3.0-only | Copyright 2025~ Yuki Lab'

# --tsconfig-raw='{}' は必須。付けないと tsconfig.json の "strict": true を拾って
# esbuild が出力の先頭に "use strict" を足し、素の JS が sloppy mode から
# strict mode に変わってしまう（暗黙のグローバル代入などが実行時に例外になる）。
# --target=es2020 は今のコードを変換しないまま、minifier が ES2021 以降の構文
# （||= など）を勝手に持ち込むのを抑える上限として指定している。
minify_js() {
	npx --no-install esbuild "$1" \
		--minify \
		--target=es2020 \
		--log-level=warning \
		--tsconfig-raw='{}' \
		--banner:js="//! ${LICENSE_BANNER}" \
		--outfile="$2" >/dev/null
}

minify_css() {
	npx --no-install esbuild "$1" \
		--minify \
		--log-level=warning \
		--tsconfig-raw='{}' \
		--banner:css="/*! ${LICENSE_BANNER} */" \
		--outfile="$2" >/dev/null
}

write_headers() {
	cat >"${DIST_DIR}/_headers" <<'HEADERS'
# AI対戦と将棋盤は no-cache（保存はするが毎回再検証）。304で済むうえ、
# no-store と違って bfcache が効くのでブラウザバックが速い。
# オンライン対戦は対局状態を持つので no-store のままにする。
/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/manifest.json
  Cache-Control: no-cache, no-store, must-revalidate

/service-worker.js
  Cache-Control: no-cache, no-store, must-revalidate

/board/
  Cache-Control: no-cache

/board/index.html
  Cache-Control: no-cache

/online/
  Cache-Control: no-cache, no-store, must-revalidate

/online/index.html
  Cache-Control: no-cache, no-store, must-revalidate

# 詰将棋は毎日出題が変わる。日付をまたいでも古い問題を出さないよう no-cache。
/tsume/
  Cache-Control: no-cache

/tsume/index.html
  Cache-Control: no-cache

# 過去の出題は内容が変わらない。差し替える余地だけ残して1週間。
/tsume/days/*
  Cache-Control: public, max-age=604800

# 待機中の詰めチャレンジ（公開済み過去問の集約）。毎朝の詰将棋ジョブで必ず中身が変わるので、
# max-age を付けるとその期間ずっと古いプールを出すことになる。no-cache なら変わっていなければ
# 304 で済むうえ、取りに行くのは /online/ を開いたとき1回だけ（online-match.js が持ち回す）
/tsume/challenge.json
  Cache-Control: no-cache

/ads.txt
  Cache-Control: public, max-age=86400

/robots.txt
  Cache-Control: public, max-age=3600

/sitemap.xml
  Cache-Control: public, max-age=3600

/shogi.*.js
  Cache-Control: public, max-age=31536000, immutable

# 詰将棋のロジック。/tsume/ でだけ読み込む
/shogi-tsume.*.js
  Cache-Control: public, max-age=31536000, immutable

# だれかと対戦のロジック。/online/ でだけ読み込む
/online-match.*.js
  Cache-Control: public, max-age=31536000, immutable

# 表示名のNG語フィルタ。/online/ でだけ読み込む
/name-filter.*.js
  Cache-Control: public, max-age=31536000, immutable

/style.*.css
  Cache-Control: public, max-age=31536000, immutable

/ai-worker.*.js
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou-worker.*.js
  Cache-Control: public, max-age=31536000, immutable

/tsume-solver.*.js
  Cache-Control: public, max-age=31536000, immutable

/qrcode.*.js
  Cache-Control: public, max-age=31536000, immutable

/favicon.ico
  Cache-Control: public, max-age=31536000, immutable

/images/*
  Cache-Control: public, max-age=31536000, immutable

/sounds/*
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou/sse42/*.js
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou/nosimd/*.js
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou/sse42/*.wasm
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/wasm

/yaneuraou/nosimd/*.wasm
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/wasm

/yaneuraou/sse42/*.nnue
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou/nosimd/*.nnue
  Cache-Control: public, max-age=31536000, immutable

/gunjin/
  Cache-Control: no-cache, no-store, must-revalidate

/gunjin/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/gunjin/styles.css
  Cache-Control: no-cache, no-store, must-revalidate

/gunjin/src/*
  Cache-Control: no-cache, no-store, must-revalidate

/gunjin/favicon.ico
  Cache-Control: public, max-age=31536000, immutable

/gunjin/images/*
  Cache-Control: public, max-age=31536000, immutable

/gunjin/sounds/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS
}

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ハッシュは必ず minify のあとに採る。逆順にすると「名前は同じなのに中身が違う」
# ファイルができ、1年 immutable で配っている都合上、再訪した人が古い中身を使い続ける。
# shogi.js / shogi-tsume.js は worker 参照の書き換えもあるのでさらに後ろで採る
minify_css style.css "$DIST_DIR/style.staged.css"
minify_js ai-worker.js "$DIST_DIR/ai-worker.staged.js"
minify_js yaneuraou-worker.js "$DIST_DIR/yaneuraou-worker.staged.js"
# NG語フィルタは書き換えが無いので、この時点で minify してハッシュを採ってよい
minify_js name-filter.js "$DIST_DIR/name-filter.staged.js"

CSS_HASH=$(hash_file "$DIST_DIR/style.staged.css" | cut -c1-8)
AI_WORKER_HASH=$(hash_file "$DIST_DIR/ai-worker.staged.js" | cut -c1-8)
YANEURAOU_WORKER_HASH=$(hash_file "$DIST_DIR/yaneuraou-worker.staged.js" | cut -c1-8)
NAME_FILTER_HASH=$(hash_file "$DIST_DIR/name-filter.staged.js" | cut -c1-8)
# qrcode.js は配布物が既に minify 済み（かけ直しても 40 バイトしか減らない）のでそのまま配る
QR_HASH=$(hash_file qrcode.js | cut -c1-8)

CSS_BUNDLED="style.${CSS_HASH}.css"
AI_WORKER_BUNDLED="ai-worker.${AI_WORKER_HASH}.js"
YANEURAOU_WORKER_BUNDLED="yaneuraou-worker.${YANEURAOU_WORKER_HASH}.js"
NAME_FILTER_BUNDLED="name-filter.${NAME_FILTER_HASH}.js"
QR_BUNDLED="qrcode.${QR_HASH}.js"

# 詰将棋の詰み探索だけは TypeScript を束ねてから配る。
# src/worker/shogi_engine.ts（出題の検証に使っているのと同じルール）を取り込むため、
# ここだけコピーではなく esbuild を通す。詰将棋ページ以外は読み込まない。
npx --no-install esbuild src/tsume/browser_worker.ts \
	--bundle \
	--format=iife \
	--target=es2020 \
	--minify \
	--log-level=warning \
	--legal-comments=inline \
	--banner:js="//! ${LICENSE_BANNER}" \
	--outfile="$DIST_DIR/tsume-solver.js" >/dev/null
TSUME_SOLVER_HASH=$(hash_file "$DIST_DIR/tsume-solver.js" | cut -c1-8)
TSUME_SOLVER_BUNDLED="tsume-solver.${TSUME_SOLVER_HASH}.js"
mv "$DIST_DIR/tsume-solver.js" "$DIST_DIR/$TSUME_SOLVER_BUNDLED"

# index.html はテンプレート。build-pages.mjs がモード別ページを生成するのでコピーしない
cp -f service-worker.js manifest.json favicon.ico ads.txt "$DIST_DIR/"
cp -R images sounds yaneuraou "$DIST_DIR/"

mkdir -p "$DIST_DIR/gunjin"
cp -f gunjin/index.html gunjin/styles.css gunjin/favicon.ico "$DIST_DIR/gunjin/"
cp -R gunjin/src gunjin/images gunjin/sounds "$DIST_DIR/gunjin/"

# shogi.js / shogi-tsume.js / online-match.js は書き換えてから名前を決めるので、いったん仮の名前で置く
JS_STAGED="$DIST_DIR/shogi.staged.js"
TSUME_JS_STAGED="$DIST_DIR/shogi-tsume.staged.js"
ONLINE_JS_STAGED="$DIST_DIR/online-match.staged.js"

# 棋譜の純粋な関数（表記変換・URL・KIF・再生）は src/kifu/ の TypeScript にあり、
# src/worker/shogi_engine.ts の将棋ルールをそのまま使っている。
# <script> を増やさない（README「クラシックスクリプト2本」）ため、束ねて shogi.js に連結する。
# 🔴 連結は shogi.js が先、束ねたものが後。逆にすると esbuild が出す "use strict" が
#    ファイル先頭のディレクティブになり、shogi.js 全体が strict mode に変わる
#    （minify_js が --tsconfig-raw='{}' を付けているのと同じ理由）。
# minify はここではかけない。連結後に minify_js が1回でかけたほうが縮む。
KIFU_CORE_STAGED="$DIST_DIR/kifu-core.staged.js"
npx --no-install esbuild src/kifu/browser.ts \
	--bundle \
	--format=iife \
	--global-name=KifuCore \
	--target=es2020 \
	--log-level=warning \
	--tsconfig-raw='{}' \
	--outfile="$KIFU_CORE_STAGED" >/dev/null
cat shogi.js "$KIFU_CORE_STAGED" > "$JS_STAGED"
rm -f "$KIFU_CORE_STAGED"
cp -f shogi-tsume.js "$TSUME_JS_STAGED"
cp -f online-match.js "$ONLINE_JS_STAGED"
mv "$DIST_DIR/style.staged.css" "$DIST_DIR/$CSS_BUNDLED"
mv "$DIST_DIR/ai-worker.staged.js" "$DIST_DIR/$AI_WORKER_BUNDLED"
mv "$DIST_DIR/yaneuraou-worker.staged.js" "$DIST_DIR/$YANEURAOU_WORKER_BUNDLED"
mv "$DIST_DIR/name-filter.staged.js" "$DIST_DIR/$NAME_FILTER_BUNDLED"
cp -f qrcode.js "$DIST_DIR/$QR_BUNDLED"

# ドキュメントが /board/ や /online/ 配下でも解決できるよう、参照は先頭スラッシュ付きにする
sed -E -i.bak "s#new Worker\\('/?ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${AI_WORKER_BUNDLED}')#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\(\"/?ai-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${AI_WORKER_BUNDLED}\")#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\('/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${YANEURAOU_WORKER_BUNDLED}')#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\(\"/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${YANEURAOU_WORKER_BUNDLED}\")#g" "$JS_STAGED"
sed -E -i.bak "s#QR_LIB_SRC = '/?qrcode(\\.[a-f0-9]{8})?\\.js'#QR_LIB_SRC = '/${QR_BUNDLED}'#" "$JS_STAGED"

# 詰み探索の Worker を作るのは詰将棋側だけ
sed -E -i.bak "s#new Worker\\('/?tsume-solver(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${TSUME_SOLVER_BUNDLED}')#g" "$TSUME_JS_STAGED"

# だれかと対戦のCOM戦は online-match.js が自前で ai-worker を起動する
sed -E -i.bak "s#new Worker\\('/?ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${AI_WORKER_BUNDLED}')#g" "$ONLINE_JS_STAGED"

# sed はマッチしなくても成功するため、置換が効いたことを明示的に確かめる
assert_contains() {
	if ! grep -qF "$2" "$1"; then
		echo "ビルド失敗: $1 に '$2' が見つかりません（置換パターンが古くなっている可能性）" >&2
		exit 1
	fi
}

assert_not_contains() {
	if grep -qF "$2" "$1"; then
		echo "ビルド失敗: $1 に '$2' が入っています（$3）" >&2
		exit 1
	fi
}

assert_contains "$JS_STAGED" "var KifuCore ="
assert_contains "$JS_STAGED" "new Worker('/${AI_WORKER_BUNDLED}')"
assert_contains "$JS_STAGED" "new Worker('/${YANEURAOU_WORKER_BUNDLED}')"
assert_contains "$JS_STAGED" "QR_LIB_SRC = '/${QR_BUNDLED}'"
assert_contains "$TSUME_JS_STAGED" "new Worker('/${TSUME_SOLVER_BUNDLED}')"
assert_contains "$ONLINE_JS_STAGED" "new Worker('/${AI_WORKER_BUNDLED}')"

# minify は必ず sed のあと。先に minify すると文字列のクォートが " に変わり、
# 上の sed パターン（' 前提）が当たらなくなる
JS_MIN="$DIST_DIR/shogi.min.js"
TSUME_JS_MIN="$DIST_DIR/shogi-tsume.min.js"
ONLINE_JS_MIN="$DIST_DIR/online-match.min.js"
minify_js "$JS_STAGED" "$JS_MIN"
minify_js "$TSUME_JS_STAGED" "$TSUME_JS_MIN"
minify_js "$ONLINE_JS_STAGED" "$ONLINE_JS_MIN"
rm -f "$JS_STAGED" "$TSUME_JS_STAGED" "$ONLINE_JS_STAGED"

# minify が worker のパスを壊していないこと（クォートは " に変わる）
assert_contains "$JS_MIN" "new Worker(\"/${AI_WORKER_BUNDLED}\")"
assert_contains "$JS_MIN" "new Worker(\"/${YANEURAOU_WORKER_BUNDLED}\")"
assert_contains "$JS_MIN" "\"/${QR_BUNDLED}\""
assert_contains "$TSUME_JS_MIN" "new Worker(\"/${TSUME_SOLVER_BUNDLED}\")"
assert_contains "$ONLINE_JS_MIN" "new Worker(\"/${AI_WORKER_BUNDLED}\")"

# 書き換えと minify が済んだので、ここで初めて名前を決める。
# 逆順にすると（= 元の shogi.js からハッシュを採ると）、worker 側だけを直したデプロイで
# 「名前は同じなのに中身が違う」ファイルができ、immutable で持っている再訪者が
# 消えた古い worker を参照し続けることになる
JS_HASH=$(hash_file "$JS_MIN" | cut -c1-8)
JS_BUNDLED="shogi.${JS_HASH}.js"
mv "$JS_MIN" "$DIST_DIR/$JS_BUNDLED"

TSUME_JS_HASH=$(hash_file "$TSUME_JS_MIN" | cut -c1-8)
TSUME_JS_BUNDLED="shogi-tsume.${TSUME_JS_HASH}.js"
mv "$TSUME_JS_MIN" "$DIST_DIR/$TSUME_JS_BUNDLED"

ONLINE_JS_HASH=$(hash_file "$ONLINE_JS_MIN" | cut -c1-8)
ONLINE_JS_BUNDLED="online-match.${ONLINE_JS_HASH}.js"
mv "$ONLINE_JS_MIN" "$DIST_DIR/$ONLINE_JS_BUNDLED"

# index.html テンプレート -> dist/{index,board/index,online/index,tsume/index}.html + sitemap.xml + robots.txt
# shogi-tsume.js の <script> は /tsume/ にだけ入る
node build-pages.mjs \
	--out="$DIST_DIR" \
	--js="$JS_BUNDLED" \
	--css="$CSS_BUNDLED" \
	--tsume-js="$TSUME_JS_BUNDLED" \
	--online-js="$ONLINE_JS_BUNDLED" \
	--name-filter-js="$NAME_FILTER_BUNDLED"

# CACHE_NAME はビルドで書き換えない。名前を変えると activate で全捨てになり、
# 中身が変わっていない 3MB 超を毎デプロイで入れ直すことになる（service-worker.js 冒頭を参照）
# やねうら王のWASM(/yaneuraou/<variant>/)はここで書き換えない。先読みリストから外し、
# URLのクエリは yaneuraou-worker.js の WASM_VERSION だけで完結させている
sed -E -i.bak "s#'/shogi(\\.[a-f0-9]{8})?\\.js'#'/${JS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/shogi-tsume(\\.[a-f0-9]{8})?\\.js'#'/${TSUME_JS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/online-match(\\.[a-f0-9]{8})?\\.js'#'/${ONLINE_JS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/name-filter(\\.[a-f0-9]{8})?\\.js'#'/${NAME_FILTER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/style(\\.[a-f0-9]{8})?\\.css'#'/${CSS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/ai-worker(\\.[a-f0-9]{8})?\\.js'#'/${AI_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'#'/${YANEURAOU_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/tsume-solver(\\.[a-f0-9]{8})?\\.js'#'/${TSUME_SOLVER_BUNDLED}'#" "$DIST_DIR/service-worker.js"

# CACHE_NAME が固定のままであること。ここが可変（時刻入りなど）に戻ると、
# デプロイのたびにキャッシュを全捨てして入れ直す状態に逆戻りする
assert_contains "$DIST_DIR/service-worker.js" "const CACHE_NAME = 'shogi-web-v1'"
assert_contains "$DIST_DIR/service-worker.js" "'/${JS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${TSUME_JS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${ONLINE_JS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${NAME_FILTER_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${CSS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${TSUME_SOLVER_BUNDLED}'"
# 先読みリストにWASMを戻さないこと。戻すと、AIを一切使わない詰将棋・だれかと対戦の
# 訪問者にまで、実際には片方しか読まない 2.8MB を初回訪問で配ることになる
assert_not_contains "$DIST_DIR/service-worker.js" "'/yaneuraou/sse42/yaneuraou.wasm" "先読みリストから外した設計に戻すこと"
assert_not_contains "$DIST_DIR/service-worker.js" "'/yaneuraou/nosimd/yaneuraou.wasm" "先読みリストから外した設計に戻すこと"
# 同じ理由で、ホーム画面に追加した人しか使わないアイコン・スクリーンショット（約680KB）も戻さないこと
assert_not_contains "$DIST_DIR/service-worker.js" "'/images/shogi_web_maskable" "先読みリストから外した設計に戻すこと"
assert_not_contains "$DIST_DIR/service-worker.js" "'/images/screenshot_" "先読みリストから外した設計に戻すこと"
assert_not_contains "$DIST_DIR/service-worker.js" "'/images/apple-touch-icon" "先読みリストから外した設計に戻すこと"

write_headers

find "$DIST_DIR" -name '*.bak' -delete
find "$DIST_DIR" -name '.DS_Store' -delete

# 1年 immutable で配るファイルは、名前のハッシュと中身のハッシュが必ず一致していること。
# ずれると「名前は同じなのに中身が違う」ファイルが生まれ、再訪した人のブラウザが
# 古い中身を再検証せずに使い続ける。書き換え処理を足したときに気付けるよう最後に見張る
for hashed in \
	"$DIST_DIR/$JS_BUNDLED" \
	"$DIST_DIR/$TSUME_JS_BUNDLED" \
	"$DIST_DIR/$ONLINE_JS_BUNDLED" \
	"$DIST_DIR/$NAME_FILTER_BUNDLED" \
	"$DIST_DIR/$CSS_BUNDLED" \
	"$DIST_DIR/$AI_WORKER_BUNDLED" \
	"$DIST_DIR/$YANEURAOU_WORKER_BUNDLED" \
	"$DIST_DIR/$QR_BUNDLED" \
	"$DIST_DIR/$TSUME_SOLVER_BUNDLED"; do
	name_hash=$(basename "$hashed" | sed -E 's/^[^.]+\.([a-f0-9]{8})\..+$/\1/')
	content_hash=$(hash_file "$hashed" | cut -c1-8)
	if [ "$name_hash" != "$content_hash" ]; then
		echo "ビルド失敗: $(basename "$hashed") の名前(${name_hash})と中身(${content_hash})が一致しません" >&2
		exit 1
	fi
done

printf 'CACHE_NAME: shogi-web-v1 (固定。更新はファイル名のハッシュで判別)\n'
printf 'Hashed assets generated: %s, %s, %s, %s, %s, %s, %s, %s\n' "$JS_BUNDLED" "$TSUME_JS_BUNDLED" "$ONLINE_JS_BUNDLED" "$CSS_BUNDLED" "$AI_WORKER_BUNDLED" "$YANEURAOU_WORKER_BUNDLED" "$TSUME_SOLVER_BUNDLED" "$QR_BUNDLED"
