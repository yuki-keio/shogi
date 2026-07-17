// SPDX-License-Identifier: GPL-3.0-only

// Signed player tokens (HMAC-SHA256) — replaces Supabase anonymous auth.
// Token = base64url(JSON payload) + "." + base64url(HMAC signature).

import type { Player } from "./shogi_engine";

export type TokenPayload = {
  roomCode: string;
  side: Player;
  uid: string;
  exp: number; // epoch ms
};

const encoder = new TextEncoder();

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array | null {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signPlayerToken(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyPlayerToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<TokenPayload | null> {
  if (typeof token !== "string" || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigBytes = base64urlDecode(token.slice(dot + 1));
  if (!sigBytes) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    encoder.encode(body),
  );
  if (!valid) return null;

  const payloadBytes = base64urlDecode(body);
  if (!payloadBytes) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.roomCode !== "string" ||
    (payload.side !== "sente" && payload.side !== "gote") ||
    typeof payload.uid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (nowMs >= payload.exp) return null;
  return payload;
}
