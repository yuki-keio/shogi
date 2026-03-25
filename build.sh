#!/bin/bash
# Netlifyビルド時にキャッシュバージョンとハッシュ付きアセット参照を更新するスクリプト

set -euo pipefail

restore_development_refs() {
	sed -E -i.bak "s#src=\"shogi(\.[a-f0-9]{8})?\.js\"#src=\"shogi.js\"#" index.html
	sed -E -i.bak "s#href=\"style(\.[a-f0-9]{8})?\.css\"#href=\"style.css\"#" index.html

	sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-dev'/" service-worker.js
	sed -E -i.bak "s#'/shogi(\.[a-f0-9]{8})?\.js'#'/shogi.js'#" service-worker.js
	sed -E -i.bak "s#'/style(\.[a-f0-9]{8})?\.css'#'/style.css'#" service-worker.js
	sed -E -i.bak "s#'/ai-worker(\.[a-f0-9]{8})?\.js'#'/ai-worker.js'#" service-worker.js
	sed -E -i.bak "s#'/yaneuraou-worker(\.[a-f0-9]{8})?\.js'#'/yaneuraou-worker.js'#" service-worker.js

	rm -f service-worker.js.bak index.html.bak
	rm -f shogi.*.js style.*.css ai-worker.*.js yaneuraou-worker.*.js
}

# タイムスタンプを生成（UTC）
TIMESTAMP=$(date -u +"%Y%m%d%H%M%S")

if [ "${PRODUCTION_ASSET_HASHING:-0}" != "1" ]; then
	restore_development_refs
	echo "ℹ️ Development mode: keeping unhashed asset references"
	exit 0
fi

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

	echo "❌ sha256sum/shasum が見つかりません" >&2
	exit 1
}

extract_wasm_version() {
	sed -nE "s/^const WASM_VERSION = '([^']+)';/\\1/p" yaneuraou-worker.js | head -n 1
}

# JS/CSS/Worker を内容ハッシュ付きファイル名で出力
JS_HASH=$(hash_file shogi.js | cut -c1-8)
CSS_HASH=$(hash_file style.css | cut -c1-8)
AI_WORKER_HASH=$(hash_file ai-worker.js | cut -c1-8)
YANEURAOU_WORKER_HASH=$(hash_file yaneuraou-worker.js | cut -c1-8)
WASM_VERSION=$(extract_wasm_version)

if [ -z "$WASM_VERSION" ]; then
	echo "❌ yaneuraou-worker.js から WASM_VERSION を取得できません" >&2
	exit 1
fi

JS_BUNDLED="shogi.${JS_HASH}.js"
CSS_BUNDLED="style.${CSS_HASH}.css"
AI_WORKER_BUNDLED="ai-worker.${AI_WORKER_HASH}.js"
YANEURAOU_WORKER_BUNDLED="yaneuraou-worker.${YANEURAOU_WORKER_HASH}.js"

# 以前のハッシュ付きファイルを掃除（ローカル実行時の肥大化防止）
rm -f shogi.*.js style.*.css ai-worker.*.js yaneuraou-worker.*.js

cp -f shogi.js "$JS_BUNDLED"
cp -f style.css "$CSS_BUNDLED"
cp -f ai-worker.js "$AI_WORKER_BUNDLED"
cp -f yaneuraou-worker.js "$YANEURAOU_WORKER_BUNDLED"

# メインスクリプト内の Worker 参照をハッシュ付きに更新
sed -E -i.bak "s#new Worker\\('ai-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('${AI_WORKER_BUNDLED}')#g" "$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"ai-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"${AI_WORKER_BUNDLED}\")#g" "$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\('yaneuraou-worker(\\.[a-f0-9]{8})?\\.js'\\)#new Worker('${YANEURAOU_WORKER_BUNDLED}')#g" "$JS_BUNDLED"
sed -E -i.bak "s#new Worker\\(\"yaneuraou-worker(\\.[a-f0-9]{8})?\\.js\"\\)#new Worker(\"${YANEURAOU_WORKER_BUNDLED}\")#g" "$JS_BUNDLED"

# index.html の参照を更新（再実行に耐える）
sed -E -i.bak "s#src=\"shogi(\.[a-f0-9]{8})?\.js\"#src=\"${JS_BUNDLED}\"#" index.html
sed -E -i.bak "s#href=\"style(\.[a-f0-9]{8})?\.css\"#href=\"${CSS_BUNDLED}\"#" index.html

# service-worker.js のプリキャッシュ対象を更新（再実行に耐える）
sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-${TIMESTAMP}'/" service-worker.js
sed -E -i.bak "s#'/shogi(\.[a-f0-9]{8})?\.js'#'/${JS_BUNDLED}'#" service-worker.js
sed -E -i.bak "s#'/style(\.[a-f0-9]{8})?\.css'#'/${CSS_BUNDLED}'#" service-worker.js
sed -E -i.bak "s#'/ai-worker(\.[a-f0-9]{8})?\.js'#'/${AI_WORKER_BUNDLED}'#" service-worker.js
sed -E -i.bak "s#'/yaneuraou-worker(\.[a-f0-9]{8})?\.js'#'/${YANEURAOU_WORKER_BUNDLED}'#" service-worker.js
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\.js(\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.js?${WASM_VERSION}'#" service-worker.js
sed -E -i.bak "s#'/yaneuraou/sse42/yaneuraou\.wasm(\?[^']*)?'#'/yaneuraou/sse42/yaneuraou.wasm?${WASM_VERSION}'#" service-worker.js
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\.js(\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.js?${WASM_VERSION}'#" service-worker.js
sed -E -i.bak "s#'/yaneuraou/nosimd/yaneuraou\.wasm(\?[^']*)?'#'/yaneuraou/nosimd/yaneuraou.wasm?${WASM_VERSION}'#" service-worker.js

# バックアップファイルを削除
rm -f service-worker.js.bak index.html.bak "${JS_BUNDLED}.bak"

echo "✅ CACHE_NAME updated to: shogi-web-${TIMESTAMP}"
echo "✅ Hashed assets generated: ${JS_BUNDLED}, ${CSS_BUNDLED}, ${AI_WORKER_BUNDLED}, ${YANEURAOU_WORKER_BUNDLED}"
echo "✅ YaneuraOu asset version synced: ${WASM_VERSION}"
