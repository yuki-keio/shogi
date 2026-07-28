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

JS_HASH=$(hash_file shogi.js | cut -c1-8)
CSS_HASH=$(hash_file style.css | cut -c1-8)
AI_WORKER_HASH=$(hash_file ai-worker.js | cut -c1-8)
YANEURAOU_WORKER_HASH=$(hash_file yaneuraou-worker.js | cut -c1-8)
QR_HASH=$(hash_file qrcode.js | cut -c1-8)
WASM_VERSION=$(extract_wasm_version)

if [ -z "$WASM_VERSION" ]; then
	echo "yaneuraou-worker.js から WASM_VERSION を取得できません" >&2
	exit 1
fi

JS_BUNDLED="shogi.${JS_HASH}.js"
CSS_BUNDLED="style.${CSS_HASH}.css"
AI_WORKER_BUNDLED="ai-worker.${AI_WORKER_HASH}.js"
YANEURAOU_WORKER_BUNDLED="yaneuraou-worker.${YANEURAOU_WORKER_HASH}.js"
QR_BUNDLED="qrcode.${QR_HASH}.js"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# index.html はテンプレート。build-pages.mjs がモード別ページを生成するのでコピーしない
cp -f service-worker.js manifest.json favicon.ico "$DIST_DIR/"
cp -R images sounds yaneuraou "$DIST_DIR/"

mkdir -p "$DIST_DIR/gunjin"
cp -f gunjin/index.html gunjin/styles.css gunjin/favicon.ico "$DIST_DIR/gunjin/"
cp -R gunjin/src gunjin/images gunjin/sounds "$DIST_DIR/gunjin/"

cp -f shogi.js "$DIST_DIR/$JS_BUNDLED"
cp -f style.css "$DIST_DIR/$CSS_BUNDLED"
cp -f ai-worker.js "$DIST_DIR/$AI_WORKER_BUNDLED"
cp -f yaneuraou-worker.js "$DIST_DIR/$YANEURAOU_WORKER_BUNDLED"
cp -f qrcode.js "$DIST_DIR/$QR_BUNDLED"

# ドキュメントが /board/ や /online/ 配下でも解決できるよう、参照は先頭スラッシュ付きにする
sed -E -i.bak "s#new Worker\\('/?ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${AI_WORKER_BUNDLED}')#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"/?ai-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${AI_WORKER_BUNDLED}\")#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\('/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('/${YANEURAOU_WORKER_BUNDLED}')#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"/?yaneuraou-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"/${YANEURAOU_WORKER_BUNDLED}\")#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#QR_LIB_SRC = '/?qrcode(\\.[a-f0-9]{8})?\\.js'#QR_LIB_SRC = '/${QR_BUNDLED}'#" "$DIST_DIR/$JS_BUNDLED"

# sed はマッチしなくても成功するため、置換が効いたことを明示的に確かめる
assert_contains() {
	if ! grep -qF "$2" "$1"; then
		echo "ビルド失敗: $1 に '$2' が見つかりません（置換パターンが古くなっている可能性）" >&2
		exit 1
	fi
}

assert_contains "$DIST_DIR/$JS_BUNDLED" "new Worker('/${AI_WORKER_BUNDLED}')"
assert_contains "$DIST_DIR/$JS_BUNDLED" "new Worker('/${YANEURAOU_WORKER_BUNDLED}')"
assert_contains "$DIST_DIR/$JS_BUNDLED" "QR_LIB_SRC = '/${QR_BUNDLED}'"

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
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"

# CACHE_NAME の更新に失敗すると古いキャッシュが永久に残るので必ず確認する
assert_contains "$DIST_DIR/service-worker.js" "const CACHE_NAME = 'shogi-web-${TIMESTAMP}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${JS_BUNDLED}'"
assert_contains "$DIST_DIR/service-worker.js" "'/${CSS_BUNDLED}'"

write_headers

find "$DIST_DIR" -name '*.bak' -delete
find "$DIST_DIR" -name '.DS_Store' -delete

printf 'CACHE_NAME updated to: shogi-web-%s\n' "$TIMESTAMP"
printf 'Hashed assets generated: %s, %s, %s, %s, %s\n' "$JS_BUNDLED" "$CSS_BUNDLED" "$AI_WORKER_BUNDLED" "$YANEURAOU_WORKER_BUNDLED" "$QR_BUNDLED"
printf 'YaneuraOu asset version synced: %s\n' "$WASM_VERSION"
