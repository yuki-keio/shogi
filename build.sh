#!/bin/bash
# Netlifyビルド時にService WorkerのCACHE_NAMEを自動更新するスクリプト

# タイムスタンプを生成（UTC）
TIMESTAMP=$(date -u +"%Y%m%d%H%M%S")

# service-worker.jsのCACHE_NAMEを更新
sed -i.bak "s/const CACHE_NAME = 'shogi-web-[^']*'/const CACHE_NAME = 'shogi-web-${TIMESTAMP}'/" service-worker.js

# バックアップファイルを削除
rm -f service-worker.js.bak

echo "✅ CACHE_NAME updated to: shogi-web-${TIMESTAMP}"
echo "✅ Deploy timestamp updated"
