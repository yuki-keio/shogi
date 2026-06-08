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
/
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/manifest.json
  Cache-Control: no-cache, no-store, must-revalidate

/service-worker.js
  Cache-Control: no-cache, no-store, must-revalidate

/shogi.*.js
  Cache-Control: public, max-age=31536000, immutable

/style.*.css
  Cache-Control: public, max-age=31536000, immutable

/ai-worker.*.js
  Cache-Control: public, max-age=31536000, immutable

/yaneuraou-worker.*.js
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
WASM_VERSION=$(extract_wasm_version)

if [ -z "$WASM_VERSION" ]; then
	echo "yaneuraou-worker.js から WASM_VERSION を取得できません" >&2
	exit 1
fi

JS_BUNDLED="shogi.${JS_HASH}.js"
CSS_BUNDLED="style.${CSS_HASH}.css"
AI_WORKER_BUNDLED="ai-worker.${AI_WORKER_HASH}.js"
YANEURAOU_WORKER_BUNDLED="yaneuraou-worker.${YANEURAOU_WORKER_HASH}.js"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp -f index.html service-worker.js manifest.json favicon.ico "$DIST_DIR/"
cp -R images sounds yaneuraou "$DIST_DIR/"

mkdir -p "$DIST_DIR/gunjin"
cp -f gunjin/index.html gunjin/styles.css gunjin/favicon.ico "$DIST_DIR/gunjin/"
cp -R gunjin/src gunjin/images gunjin/sounds "$DIST_DIR/gunjin/"

cp -f shogi.js "$DIST_DIR/$JS_BUNDLED"
cp -f style.css "$DIST_DIR/$CSS_BUNDLED"
cp -f ai-worker.js "$DIST_DIR/$AI_WORKER_BUNDLED"
cp -f yaneuraou-worker.js "$DIST_DIR/$YANEURAOU_WORKER_BUNDLED"

sed -E -i.bak "s#new Worker\\('ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('${AI_WORKER_BUNDLED}')#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"ai-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"${AI_WORKER_BUNDLED}\")#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\('yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('${YANEURAOU_WORKER_BUNDLED}')#g" "$DIST_DIR/$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"yaneuraou-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"${YANEURAOU_WORKER_BUNDLED}\")#g" "$DIST_DIR/$JS_BUNDLED"

sed -E -i.bak "s#src=\"shogi(\\.[a-f0-9]{8})?\\.js\"#src=\"${JS_BUNDLED}\"#" "$DIST_DIR/index.html"
sed -E -i.bak "s#href=\"style(\\.[a-f0-9]{8})?\\.css\"#href=\"${CSS_BUNDLED}\"#" "$DIST_DIR/index.html"

sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-${TIMESTAMP}'/" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/shogi(\\.[a-f0-9]{8})?\\.js'#'/${JS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/style(\\.[a-f0-9]{8})?\\.css'#'/${CSS_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/ai-worker(\\.[a-f0-9]{8})?\\.js'#'/${AI_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'#'/${YANEURAOU_WORKER_BUNDLED}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.js(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.js?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\\.wasm(\\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.wasm?${WASM_VERSION}'#" "$DIST_DIR/service-worker.js"

write_headers

find "$DIST_DIR" -name '*.bak' -delete
find "$DIST_DIR" -name '.DS_Store' -delete

printf 'CACHE_NAME updated to: shogi-web-%s\n' "$TIMESTAMP"
printf 'Hashed assets generated: %s, %s, %s, %s\n' "$JS_BUNDLED" "$CSS_BUNDLED" "$AI_WORKER_BUNDLED" "$YANEURAOU_WORKER_BUNDLED"
printf 'YaneuraOu asset version synced: %s\n' "$WASM_VERSION"
