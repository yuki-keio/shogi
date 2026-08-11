#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright 2025~ Yuki Lab
#
# 詰将棋ソルバー（KomoringHeights）をビルドして .engines/bin に置く。
# GitHub Actions ではビルド結果を actions/cache に載せるので、通常は走らない。
#
# KomoringHeights は やねうら王ベースの df-pn 詰将棋エンジン（GPL-3.0）。
# 本リポジトリと同じライセンスなので同梱に問題はない。
#
# ランナーの CPU が AVX2 を持つ保証はどこにも書かれていないため、
# AVX2 と SSE4.2 の2本を作り、実行時に /proc/cpuinfo を見て選ぶ
# （選択は scripts/tsume/engine_path.ts）。

set -euo pipefail

KH_TAG="kh-v1.1.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="${REPO_ROOT}/.engines/bin"
WORK_DIR="${REPO_ROOT}/.engines/build"

mkdir -p "$BIN_DIR" "$WORK_DIR"

if [ -x "${BIN_DIR}/komoring-sse42" ] || [ -x "${BIN_DIR}/komoring" ]; then
	echo "ビルド済みのエンジンがあります: ${BIN_DIR}"
	exit 0
fi

# macOS には公式のビルド済みバイナリがあるので、手元の開発ではそれを使う。
# （CI は Linux なので下のソースビルドに進む）
if [ "$(uname -s)" = "Darwin" ]; then
	echo "macOS 向けの配布バイナリを取得します（${KH_TAG}）"
	ZIP="${WORK_DIR}/kh-mac.zip"
	curl -sSL -o "$ZIP" \
		"https://github.com/komori-n/KomoringHeights/releases/download/${KH_TAG}/KomoringHeights-${KH_TAG}-mac.zip"
	unzip -o -q "$ZIP" -d "${WORK_DIR}/kh-mac"
	case "$(uname -m)" in
	arm64) VARIANT="M1" ;;
	*) VARIANT="AVX2" ;;
	esac
	SRC="${WORK_DIR}/kh-mac/mac/KomoringHeights/KomoringHeights-mac-clang++-14-normal-${VARIANT}"
	if [ ! -f "$SRC" ]; then
		echo "配布物に ${VARIANT} 版がありません: $SRC" >&2
		exit 1
	fi
	cp -f "$SRC" "${BIN_DIR}/komoring"
	chmod +x "${BIN_DIR}/komoring"
	rm -rf "${WORK_DIR}/kh-mac" "$ZIP"
	echo "完成: ${BIN_DIR}/komoring (${VARIANT})"
	exit 0
fi

COMPILER="${TSUME_COMPILER:-}"
if [ -z "$COMPILER" ]; then
	# KomoringHeights の CI が検証しているのは clang 14〜17 / g++ 11〜12。
	# 新しすぎるコンパイラを避けて、確実に通る順で探す。
	for candidate in clang++-17 clang++-16 clang++-15 clang++-14 g++-12 g++-11 clang++ g++; do
		if command -v "$candidate" >/dev/null 2>&1; then
			COMPILER="$candidate"
			break
		fi
	done
fi
if [ -z "$COMPILER" ]; then
	echo "C++ コンパイラが見つかりません" >&2
	exit 1
fi
echo "コンパイラ: ${COMPILER} ($("$COMPILER" --version | head -1))"

SRC_DIR="${WORK_DIR}/KomoringHeights"
if [ ! -d "$SRC_DIR" ]; then
	git clone --depth 1 --branch "$KH_TAG" \
		https://github.com/komori-n/KomoringHeights.git "$SRC_DIR"
fi

build_variant() {
	local target_cpu="$1"
	local out_name="$2"
	echo "--- ${out_name} (TARGET_CPU=${target_cpu}) をビルドします ---"
	make -C "${SRC_DIR}/source" clean >/dev/null 2>&1 || true
	make -C "${SRC_DIR}/source" normal \
		COMPILER="$COMPILER" \
		TARGET_CPU="$target_cpu" \
		-j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
	cp -f "${SRC_DIR}/source/KomoringHeights-by-gcc" "${BIN_DIR}/${out_name}"
	chmod +x "${BIN_DIR}/${out_name}"
}

build_variant AVX2 komoring-avx2
build_variant SSE42 komoring-sse42

# ソースは巨大なのでキャッシュには載せない
rm -rf "$SRC_DIR"

echo "完成:"
ls -la "$BIN_DIR"
