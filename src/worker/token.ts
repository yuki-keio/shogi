// SPDX-License-Identifier: GPL-3.0-only

// Signed player tokens (HMAC-SHA256) bind a browser uid to one room seat.
// Token = base64url(JSON payload) + "." + base64url(HMAC signature).
//
// The same envelope also carries COM-match rating tickets (see signBotTicket):
// the browser runs those games by itself, so the only thing the server can
// trust is a slip it signed at the moment the queue gave up looking for a human.

import type { Player } from "./shogi_engine";

export type TokenPayload = {
  roomCode: string;
  side: Player;
  uid: string;
  exp: number; // epoch ms
};

// COM戦の引換券。jti は使い捨ての識別子で、D1 の rated_game.game_key として
// 消費する（同じ券で2回目を撃つとバッチごと失敗する）。
export type BotTicketPayload = {
  jti: string;
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

async function sign(payload: unknown, secret: string): Promise<string> {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(sig))}`;
}

// Signature + expiry only; the caller checks the payload's own shape.
async function verify(token: string, secret: string, nowMs: number): Promise<unknown | null> {
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
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || nowMs >= payload.exp) return null;
  return payload;
}

export async function signPlayerToken(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  return sign(payload, secret);
}

export async function verifyPlayerToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<TokenPayload | null> {
  const payload = (await verify(token, secret, nowMs)) as TokenPayload | null;
  if (
    !payload ||
    typeof payload.roomCode !== "string" ||
    (payload.side !== "sente" && payload.side !== "gote") ||
    typeof payload.uid !== "string"
  ) {
    return null;
  }
  return payload;
}

export async function signBotTicket(
  payload: BotTicketPayload,
  secret: string,
): Promise<string> {
  return sign(payload, secret);
}

export async function verifyBotTicket(
  token: string,
  secret: string,
  nowMs: number,
): Promise<BotTicketPayload | null> {
  const payload = (await verify(token, secret, nowMs)) as BotTicketPayload | null;
  if (!payload || typeof payload.jti !== "string" || typeof payload.uid !== "string") {
    return null;
  }
  // A forged jti would only ever collide with itself, but keep it bounded so a
  // giant string cannot become a rated_game primary key.
  if (payload.jti.length === 0 || payload.jti.length > 64) return null;
  return payload;
}
