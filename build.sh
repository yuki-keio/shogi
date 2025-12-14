#!/bin/bash
# Netlifyビルド時にService WorkerのCACHE_NAMEを自動更新するスクリプト

# タイムスタンプを生成（UTC）
TIMESTAMP=$(date -u +"%Y%m%d%H%M%S")

# service-worker.jsのCACHE_NAMEを更新
sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-${TIMESTAMP}'/" service-worker.js

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

# JS/CSS を内容ハッシュ付きファイル名で出力
JS_HASH=$(hash_file shogi.js | cut -c1-8)
CSS_HASH=$(hash_file style.css | cut -c1-8)
JS_BUNDLED="shogi.${JS_HASH}.js"
CSS_BUNDLED="style.${CSS_HASH}.css"

# 以前のハッシュ付きファイルを掃除（ローカル実行時の肥大化防止）
rm -f shogi.*.js style.*.css

cp -f shogi.js "$JS_BUNDLED"
cp -f style.css "$CSS_BUNDLED"

# index.html の参照を更新（再実行に耐える）
sed -E -i.bak "s#src=\"shogi(\.[a-f0-9]{8})?\.js\"#src=\"${JS_BUNDLED}\"#" index.html
sed -E -i.bak "s#href=\"style(\.[a-f0-9]{8})?\.css\"#href=\"${CSS_BUNDLED}\"#" index.html

# service-worker.js のプリキャッシュ対象を更新（再実行に耐える）
sed -E -i.bak "s#'/shogi(\.[a-f0-9]{8})?\.js'#'/${JS_BUNDLED}'#" service-worker.js
sed -E -i.bak "s#'/style(\.[a-f0-9]{8})?\.css'#'/${CSS_BUNDLED}'#" service-worker.js

# バックアップファイルを削除
rm -f service-worker.js.bak index.html.bak

echo "✅ CACHE_NAME updated to: shogi-web-${TIMESTAMP}"
echo "✅ Hashed assets generated: ${JS_BUNDLED}, ${CSS_BUNDLED}"
echo "✅ Deploy timestamp updated"
