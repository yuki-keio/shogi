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

TIMESTAMP=$(date -u +"%Y%m%d%H%M%S")

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

extract_wasm_version() {
	sed -nE "s/^const WASM_VERSION = '([^']+)';/\\1/p" yaneuraou-worker.js | head -n 1
}

write_headers() {
	cat >"${DIST_DIR}/_headers" <<'HEADERS'
# AI対戦と将棋盤は no-cache（保存はするが毎回再検証）。304で済むうえ、
# no-store と違って bfcache が効くのでブラウザバックが速い。
# 通信対戦は対局状態を持つので no-store のままにする。
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

/ads.txt
  Cache-Control: public, max-age=86400

/robots.txt
  Cache-Control: public, max-age=3600

/sitemap.xml
  Cache-Control: public, max-age=3600

/shogi.*.js
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

# shogi.js のハッシュはここでは採らない。中身の worker 参照を書き換えたあとに採る
# （名前と中身がずれると、1年 immutable で配っている都合上、再訪した人が
#   古い中身を使い続けて消えたファイルを参照してしまう）
CSS_HASH=$(hash_file style.css | cut -c1-8)
AI_WORKER_HASH=$(hash_file ai-worker.js | cut -c1-8)
YANEURAOU_WORKER_HASH=$(hash_file yaneuraou-worker.js | cut -c1-8)
QR_HASH=$(hash_file qrcode.js | cut -c1-8)
WASM_VERSION=$(extract_wasm_version)

if [ -z "$WASM_VERSION" ]; then
	echo "yaneuraou-worker.js から WASM_VERSION を取得できません" >&2
	exit 1
fi

CSS_BUNDLED="style.${CSS_HASH}.css"
AI_WORKER_BUNDLED="ai-worker.${AI_WORKER_HASH}.js"
YANEURAOU_WORKER_BUNDLED="yaneuraou-worker.${YANEURAOU_WORKER_HASH}.js"
QR_BUNDLED="qrcode.${QR_HASH}.js"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 詰将棋の詰み探索だけは TypeScript を束ねてから配る。
# src/worker/shogi_engine.ts（出題の検証に使っているのと同じルール）を取り込むため、
# ここだけコピーではなく esbuild を通す。詰将棋ページ以外は読み込まない。
npx --no-install esbuild src/tsume/browser_worker.ts \
	--bundle \
	--format=iife \
	--target=es2020 \
	--minify \
	--legal-comments=inline \
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

# shogi.js だけは書き換えてから名前を決めるので、いったん仮の名前で置く
JS_STAGED="$DIST_DIR/shogi.staged.js"
cp -f shogi.js "$JS_STAGED"
cp -f style.css "$DIST_DIR/$CSS_BUNDLED"
cp -f ai-worker.js "$DIST_DIR/$AI_WORKER_BUNDLED"
cp -f yaneuraou-worker.js "$DIST_DIR/$YANEURAOU_WORKER_BUNDLED"
cp -f qrcode.js "$DIST_DIR/$QR_BUNDLED"

# ドキュメントが /board/ や /online/ 配下でも解決できるよう、参照は先頭スラッシュ付きにする
sed -E -i.bak "s#new Worker\\('/?ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${AI_WORKER_BUNDLED}')#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\(\"/?ai-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${AI_WORKER_BUNDLED}\")#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\('/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${YANEURAOU_WORKER_BUNDLED}')#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\(\"/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${YANEURAOU_WORKER_BUNDLED}\")#g" "$JS_STAGED"
sed -E -i.bak "s#new Worker\\('/?tsume-solver(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${TSUME_SOLVER_BUNDLED}')#g" "$JS_STAGED"
sed -E -i.bak "s#QR_LIB_SRC = '/?qrcode(\\.[a-f0-9]{8})?\\.js'#QR_LIB_SRC = '/${QR_BUNDLED}'#" "$JS_STAGED"

# sed はマッチしなくても成功するため、置換が効いたことを明示的に確かめる
assert_contains() {
	if ! grep -qF "$2" "$1"; then
		echo "ビルド失敗: $1 に '$2' が見つかりません（置換パターンが古くなっている可能性）" >&2
		exit 1
	fi
}

assert_contains "$JS_STAGED" "new Worker('/${AI_WORKER_BUNDLED}')"
assert_contains "$JS_STAGED" "new Worker('/${YANEURAOU_WORKER_BUNDLED}')"
assert_contains "$JS_STAGED" "new Worker('/${TSUME_SOLVER_BUNDLED}')"
assert_contains "$JS_STAGED" "QR_LIB_SRC = '/${QR_BUNDLED}'"

# 書き換えが済んだので、ここで初めて名前を決める。
# 逆順にすると（= 元の shogi.js からハッシュを採ると）、worker 側だけを直したデプロイで
# 「名前は同じなのに中身が違う」ファイルができ、immutable で持っている再訪者が
# 消えた古い worker を参照し続けることになる
JS_HASH=$(hash_file "$JS_STAGED" | cut -c1-8)
JS_BUNDLED="shogi.${JS_HASH}.js"
mv "$JS_STAGED" "$DIST_DIR/$JS_BUNDLED"

# index.html テンプレート -> dist/{index,board/index,online/index}.html + sitemap.xml + robots.txt
node build-pages.mjs \
	--out="$DIST_DIR" \
	--js="$JS_BUNDLED" \
	--css="$CSS_BUNDLED"

sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-${TIMESTAMP}'/" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/shogi(\\.[a-f0-9]{8})?\\.js'#'/${JS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/style(\\.[a-f0-9]{8})?\\.css'#'/${CSS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/ai-worker(\\.[a-f0-9]{8})?\\.js'#'/${AI_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'#'/${YANEURAOU_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/tsume-solver(\\.[a-f0-9]{8})?\\.js'#'/${TSUME_SOLVER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"

# CACHE_NAME の更新に失敗すると古いキャッシュが永久に残るので必ず確認する
assert_contains "$DIST_DIR/service-worker.js" "const CACHE_NAME = 'shogi-web-${TIMESTAMP}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${JS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${CSS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${TSUME_SOLVER_BUNDLED}'"

write_headers

find "$DIST_DIR" -name '*.bak' -delete
find "$DIST_DIR" -name '.DS_Store' -delete

# 1年 immutable で配るファイルは、名前のハッシュと中身のハッシュが必ず一致していること。
# ずれると「名前は同じなのに中身が違う」ファイルが生まれ、再訪した人のブラウザが
# 古い中身を再検証せずに使い続ける。書き換え処理を足したときに気付けるよう最後に見張る
for hashed in \
	"$DIST_DIR/$JS_BUNDLED" \
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

printf 'CACHE_NAME updated to: shogi-web-%s\n' "$TIMESTAMP"
printf 'Hashed assets generated: %s, %s, %s, %s, %s, %s\n' "$JS_BUNDLED" "$CSS_BUNDLED" "$AI_WORKER_BUNDLED" "$YANEURAOU_WORKER_BUNDLED" "$TSUME_SOLVER_BUNDLED" "$QR_BUNDLED"
printf 'YaneuraOu asset version synced: %s\n' "$WASM_VERSION"
