// SPDX-License-Identifier: GPL-3.0-only

// 共有URL（/?k=…&m=…）の中身。設計書 §6
//
// 先頭1バイト = 書式バージョン、以降は1手2バイト（15ビット）。
//   上位7ビット: 移動元（0〜80 のマス番号 / 駒を打つときは 81〜87）
//   中位7ビット: 移動先（0〜80）
//   下位1ビット: 成るなら1
// 🔴 圧縮はしない（実測で 126バイト → 128バイト と増えた）。

import {
  DROP_ORDER,
  formatUsiMove,
  parseUsiMove,
  squareIndexToXY,
  xyToSquareIndex,
} from "./moves.ts";

export const KIFU_URL_VERSION = 1;

const DROP_INDEX_BASE = 81;

const B64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// btoa / atob に頼らない（ブラウザと workerd で同じ結果になることを担保するため）
function bytesToBase64Url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_CHARS[b0 >> 2];
    if (b1 === undefined) {
      out += B64URL_CHARS[(b0 & 0x03) << 4];
      break;
    }
    out += B64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b2 === undefined) {
      out += B64URL_CHARS[(b1 & 0x0f) << 2];
      break;
    }
    out += B64URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += B64URL_CHARS[b2 & 0x3f];
  }
  return out;
}

function base64UrlToBytes(text: string): number[] | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = B64URL_CHARS.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * USI の手順を `k` の値にする。読めない手が混ざっていたら null。
 * 手が0手でもバージョンバイトだけの文字列を返す（空の棋譜も共有できる）。
 */
export function encodeKifuParam(usiMoves: readonly string[]): string | null {
  const bytes: number[] = [KIFU_URL_VERSION];

  for (const usi of usiMoves) {
    const move = parseUsiMove(usi);
    if (!move) return null;

    let fromCode: number;
    let promote = 0;
    if (move.type === "drop") {
      const dropIndex = DROP_ORDER.indexOf(move.pieceType);
      if (dropIndex < 0) return null;
      fromCode = DROP_INDEX_BASE + dropIndex;
    } else {
      fromCode = xyToSquareIndex(move.fromX, move.fromY);
      promote = move.promote ? 1 : 0;
    }
    const toCode = xyToSquareIndex(move.toX, move.toY);
    const packed = (fromCode << 8) | (toCode << 1) | promote;
    bytes.push((packed >> 8) & 0xff, packed & 0xff);
  }

  return bytesToBase64Url(bytes);
}

/**
 * `k` の値を USI の手順に戻す。読めなければ null（エラーで止めずに案内へ落とすため）。
 */
export function decodeKifuParam(param: string | null | undefined): string[] | null {
  if (typeof param !== "string" || param === "") return null;
  const bytes = base64UrlToBytes(param);
  if (!bytes || bytes.length === 0) return null;
  if (bytes[0] !== KIFU_URL_VERSION) return null;

  const body = bytes.length - 1;
  // base64 は4文字単位でしか区切れないため、末尾に0が1バイト余ることがある
  const moveCount = Math.floor(body / 2);
  if (body - moveCount * 2 > 1) return null;

  const moves: string[] = [];
  for (let i = 0; i < moveCount; i++) {
    const packed = (bytes[1 + i * 2] << 8) | bytes[2 + i * 2];
    if (packed >> 15 !== 0) return null;
    const fromCode = (packed >> 8) & 0x7f;
    const toCode = (packed >> 1) & 0x7f;
    const promote = (packed & 1) === 1;
    if (toCode > 80) return null;

    const to = squareIndexToXY(toCode);
    if (fromCode >= DROP_INDEX_BASE) {
      const dropIndex = fromCode - DROP_INDEX_BASE;
      const pieceType = DROP_ORDER[dropIndex];
      if (!pieceType || promote) return null;
      moves.push(formatUsiMove({ type: "drop", pieceType, toX: to.x, toY: to.y }));
      continue;
    }
    const from = squareIndexToXY(fromCode);
    moves.push(
      formatUsiMove({
        type: "move",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        promote,
      }),
    );
  }
  return moves;
}

/**
 * `m`（開いたときに表示する手数）を 0〜total に丸める。
 * 範囲外・数字でない・未指定はすべて最終手（total）。設計書 §6
 */
export function clampMoveIndex(
  raw: string | number | null | undefined,
  total: number,
): number {
  if (raw === null || raw === undefined || raw === "") return total;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return total;
  const index = Math.floor(value);
  if (index < 0 || index > total) return total;
  return index;
}
