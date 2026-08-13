// SPDX-License-Identifier: GPL-3.0-only

// web-shogi Worker entry.
// Static assets are served by the assets pipeline before this code runs;
// only /api/* (and asset misses) reach this handler.

import type { Env } from "./env";
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "./room";
import { signPlayerToken, verifyPlayerToken, TokenPayload } from "./token";
import { ROOM_TTL_MS, TC_ALLOWED } from "./match_room";
import type { SidePref, TimeControlType } from "./protocol";
import type { Move, Player } from "./shogi_engine";

export { MatchRoom } from "./match_room";

// ---- responses ---------------------------------------------------------------

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, error: { code, message } }, { status });
}

// Map room-domain error codes to stable HTTP statuses for API clients.
const ERROR_STATUS: Record<string, number> = {
  bad_json: 400,
  bad_move: 400,
  bad_room_code: 400,
  bad_expected_revision: 400,
  illegal_move: 400,
  unauthorized: 401,
  forbidden: 403,
  room_full: 403,
  game_over: 403,
  not_your_turn: 403,
  not_found: 404,
  method_not_allowed: 405,
  not_started: 409,
  revision_conflict: 409,
  join_conflict: 409,
  match_started: 409,
  bad_time_control: 400,
  rate_limited: 429,
  bad_state: 500,
  room_exists: 500,
  room_code_exhausted: 500,
};

function resultResponse(result: { ok: boolean; error?: { code: string } }): Response {
  if (result.ok) return jsonResponse(result);
  const status = ERROR_STATUS[result.error?.code ?? ""] ?? 500;
  return jsonResponse(result, { status });
}

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// ---- rate limiting --------------------------------------------------------------
// In-memory, per-isolate sliding window. Approximate by design (each isolate
// keeps its own counters) but enough to stop casual abuse, per the plan (§5.6).
// create and join are the only unauthenticated endpoints, so both are limited
// (join would otherwise let anyone spin up DO requests for guessed codes).

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CREATES = 10;
const RATE_MAX_JOINS = 30;
const RATE_MAX_FEEDBACK = 5;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(key: string, nowMs: number, max: number): boolean {
  if (rateBuckets.size > 10_000) {
    for (const [k, bucket] of rateBuckets) {
      if (nowMs - bucket.windowStart > RATE_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || nowMs - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: nowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// ---- helpers -------------------------------------------------------------------

function isValidUid(uid: unknown): uid is string {
  return typeof uid === "string" && /^[0-9a-zA-Z-]{8,64}$/.test(uid);
}

function normalizeDisplayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 40);
  return trimmed || null;
}

// Missing/unknown -> "sente" so pre-feature clients keep today's behavior.
function normalizeSidePref(v: unknown): SidePref {
  return v === "gote" || v === "random" ? v : "sente";
}

// Missing -> no time control; an explicit but invalid value -> null (=> 400).
function normalizeTimeControl(
  v: unknown,
): { type: TimeControlType; seconds: number } | null {
  if (v === undefined || v === null) return { type: "none", seconds: 0 };
  if (typeof v !== "object") return null;
  const tc = v as { type?: unknown; seconds?: unknown };
  if (tc.type === undefined || tc.type === "none") return { type: "none", seconds: 0 };
  if (tc.type !== "total" && tc.type !== "per_move") return null;
  const seconds = typeof tc.seconds === "number" ? tc.seconds : NaN;
  if (!TC_ALLOWED[tc.type].includes(seconds)) return null;
  return { type: tc.type, seconds };
}

async function requireToken(
  request: Request,
  env: Env,
  roomCode: string,
): Promise<TokenPayload | null> {
  const auth = request.headers.get("Authorization");
  let token: string | null = null;
  if (auth?.startsWith("Bearer ")) {
    token = auth.slice("Bearer ".length);
  }
  if (!token) return null;
  const payload = await verifyPlayerToken(token, env.TOKEN_SECRET, Date.now());
  if (!payload || payload.roomCode !== roomCode) return null;
  return payload;
}

async function issueToken(
  env: Env,
  roomCode: string,
  side: Player,
  uid: string,
): Promise<string> {
  return signPlayerToken(
    { roomCode, side, uid, exp: Date.now() + ROOM_TTL_MS },
    env.TOKEN_SECRET,
  );
}

// ---- API routing ----------------------------------------------------------------

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Fail fast (and loudly) if the deployment forgot `wrangler secret put
  // TOKEN_SECRET` — signing tokens with a guessable default would let anyone
  // forge seat credentials.
  if (typeof env.TOKEN_SECRET !== "string" || env.TOKEN_SECRET.length < 16) {
    return errorResponse(500, "server_misconfigured", "TOKEN_SECRET is not configured");
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "rooms", ...]

  if (segments[0] !== "api") {
    return errorResponse(404, "not_found", "Unknown API endpoint");
  }

  // POST /api/feedback — store user feedback and notify Discord.
  if (segments[1] === "feedback" && segments.length === 2) {
    return handleFeedback(request, env, ctx);
  }

  if (segments[1] !== "rooms") {
    return errorResponse(404, "not_found", "Unknown API endpoint");
  }

  // POST /api/rooms — create a room.
  if (segments.length === 2) {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    return handleCreateRoom(request, env);
  }

  // /api/rooms/{code}/{action}
  if (segments.length !== 4) {
    return errorResponse(404, "not_found", "Unknown API endpoint");
  }
  const roomCode = normalizeRoomCode(segments[2]);
  if (!roomCode || !isValidRoomCode(roomCode)) {
    return errorResponse(400, "bad_room_code", "Invalid room code");
  }
  const action = segments[3];
  const stub = env.MATCH_ROOM.getByName(roomCode);

  if (action === "join") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    const body = await parseJsonBody<{ uid?: unknown; displayName?: unknown }>(request);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(`join:${ip}`, Date.now(), RATE_MAX_JOINS)) {
      return errorResponse(429, "rate_limited", "Too many join attempts; try again later");
    }
    if (!body || !isValidUid(body.uid)) {
      return errorResponse(400, "bad_request", "uid is required");
    }
    const result = await stub.join({
      uid: body.uid,
      displayName: normalizeDisplayName(body.displayName),
    });
    if (!result.ok) return resultResponse(result);
    const token = await issueToken(env, roomCode, result.yourSide, body.uid);
    return jsonResponse({ ...result, token });
  }

  if (action === "ws") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(400, "bad_request", "Expected WebSocket upgrade");
    }
    const token = url.searchParams.get("token") || "";
    const payload = await verifyPlayerToken(token, env.TOKEN_SECRET, Date.now());
    if (!payload || payload.roomCode !== roomCode) {
      return errorResponse(401, "unauthorized", "Missing or invalid token");
    }
    const headers = new Headers(request.headers);
    headers.set("x-match-side", payload.side);
    headers.set("x-match-uid", payload.uid);
    return stub.fetch(new Request(request, { headers }));
  }

  if (action === "state") {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "Use GET");
    }
    const payload = await requireToken(request, env, roomCode);
    if (!payload) {
      return errorResponse(401, "unauthorized", "Missing or invalid token");
    }
    const result = await stub.getStateFor({ side: payload.side, uid: payload.uid });
    return resultResponse(result);
  }

  if (action === "move") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    const payload = await requireToken(request, env, roomCode);
    if (!payload) {
      return errorResponse(401, "unauthorized", "Missing or invalid token");
    }
    const body = await parseJsonBody<{ expectedRevision?: unknown; move?: unknown }>(request);
    if (!body) return errorResponse(400, "bad_json", "Invalid JSON body");
    const expectedRevision =
      typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : null;
    if (expectedRevision === null || expectedRevision < 0) {
      return errorResponse(400, "bad_expected_revision", "expectedRevision is required");
    }
    const move = body.move as Move | undefined;
    if (!move || (move.type !== "move" && move.type !== "drop")) {
      return errorResponse(400, "bad_move", "Invalid move payload");
    }
    const result = await stub.submitMove({
      side: payload.side,
      uid: payload.uid,
      expectedRevision,
      move,
    });
    return resultResponse(result);
  }

  // POST /api/rooms/{code}/settings — pre-join settings edit by the creator.
  // The seat may move, so the response always carries a freshly signed token.
  if (action === "settings") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    const payload = await requireToken(request, env, roomCode);
    if (!payload) {
      return errorResponse(401, "unauthorized", "Missing or invalid token");
    }
    const body = await parseJsonBody<{ side?: unknown; tc?: unknown }>(request);
    if (!body) return errorResponse(400, "bad_json", "Invalid JSON body");
    const tc = normalizeTimeControl(body.tc);
    if (!tc) return errorResponse(400, "bad_time_control", "Invalid time control");
    const result = await stub.updateSettings({
      uid: payload.uid,
      sidePref: normalizeSidePref(body.side),
      tcType: tc.type,
      tcSeconds: tc.seconds,
    });
    if (!result.ok) return resultResponse(result);
    const token = await issueToken(env, roomCode, result.yourSide, payload.uid);
    return jsonResponse({ ...result, token });
  }

  if (action === "resign") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    const payload = await requireToken(request, env, roomCode);
    if (!payload) {
      return errorResponse(401, "unauthorized", "Missing or invalid token");
    }
    const body = (await parseJsonBody<{ expectedRevision?: unknown }>(request)) ?? {};
    const expectedRevision =
      typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : null;
    const result = await stub.resign({
      side: payload.side,
      uid: payload.uid,
      expectedRevision,
    });
    return resultResponse(result);
  }

  return errorResponse(404, "not_found", "Unknown API endpoint");
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  // Read the body before rate limiting so the request stream is always consumed.
  const body = await parseJsonBody<{
    uid?: unknown;
    displayName?: unknown;
    side?: unknown;
    tc?: unknown;
  }>(request);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(`create:${ip}`, now, RATE_MAX_CREATES)) {
    return errorResponse(429, "rate_limited", "Too many rooms created; try again later");
  }

  if (!body || !isValidUid(body.uid)) {
    return errorResponse(400, "bad_request", "uid is required");
  }
  const displayName = normalizeDisplayName(body.displayName);
  const sidePref = normalizeSidePref(body.side);
  const tc = normalizeTimeControl(body.tc);
  if (!tc) return errorResponse(400, "bad_time_control", "Invalid time control");

  // Retry on the astronomically unlikely room-code collision.
  for (let attempt = 0; attempt < 8; attempt++) {
    const roomCode = generateRoomCode(10);
    const stub = env.MATCH_ROOM.getByName(roomCode);
    const result = await stub.createRoom({
      roomCode,
      uid: body.uid,
      displayName,
      sidePref,
      tcType: tc.type,
      tcSeconds: tc.seconds,
    });
    if (!result.ok && result.error.code === "room_exists") continue;
    if (!result.ok) return resultResponse(result);
    const token = await issueToken(env, roomCode, result.yourSide, body.uid);
    return jsonResponse({ ...result, token });
  }
  return errorResponse(500, "room_code_exhausted", "Failed to allocate a unique room code");
}

// ---- feedback --------------------------------------------------------------------

const FEEDBACK_MAX_LENGTH = 2000;
const FEEDBACK_UA_MAX_LENGTH = 255;
// 診断情報(meta)はJSON文字列で保存。超過分は切り捨てる（フィードバック本文を最優先し、
// meta が原因で送信を失敗させない）。
const FEEDBACK_META_MAX_LENGTH = 4000;
// クライアントのモード選択チップと対応。未知の値は黙って捨てる。
const FEEDBACK_MODES = new Set(["ai", "pvp", "online", "tsume"]);

// ユーザーが任意選択した「問題が起きたモード」を検証してJSON文字列にする。
// 何も残らなければ null（列もNULLのまま）。
function normalizeFeedbackModes(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const modes = [...new Set(value.filter(
    (v): v is string => typeof v === "string" && FEEDBACK_MODES.has(v),
  ))];
  return modes.length > 0 ? JSON.stringify(modes) : null;
}

// クライアントが自動添付した診断情報。中身は信用せず、プレーンなobjectのみ受け、
// サイズ上限で切り捨てて保存する（切り捨て後はJSONとして壊れていても調査用途には足りる）。
function normalizeFeedbackMeta(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}") return null;
    return json.slice(0, FEEDBACK_META_MAX_LENGTH);
  } catch {
    return null;
  }
}

async function handleFeedback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Use POST");
  }
  // Reject obviously oversized bodies before parsing them into memory
  // (2000 chars of JSON-escaped UTF-8 stays far below this).
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64_000) {
    return errorResponse(413, "payload_too_large", "Body too large");
  }
  // Read the body before rate limiting so the request stream is always consumed.
  const body = await parseJsonBody<{
    message?: unknown;
    website?: unknown;
    modes?: unknown;
    context?: unknown;
  }>(request);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(`feedback:${ip}`, Date.now(), RATE_MAX_FEEDBACK)) {
    return errorResponse(429, "rate_limited", "Too many submissions; try again later");
  }
  if (!body) return errorResponse(400, "bad_json", "Invalid JSON body");

  // Honeypot: bots that fill the hidden field get a fake success and no row.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return jsonResponse({ ok: true });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > FEEDBACK_MAX_LENGTH) {
    return errorResponse(400, "bad_request", "message is required (max 2000 chars)");
  }

  const ua = (request.headers.get("User-Agent") || "").slice(0, FEEDBACK_UA_MAX_LENGTH);
  const modes = normalizeFeedbackModes(body.modes);
  const meta = normalizeFeedbackMeta(body.context);
  await env.DB
    .prepare("INSERT INTO feedback (message, ua, modes, meta) VALUES (?1, ?2, ?3, ?4)")
    .bind(message, ua, modes, meta)
    .run();

  // D1 is the source of truth; Discord is best-effort and must not affect the response.
  ctx.waitUntil(notifyDiscord(env, message, modes, meta));
  return jsonResponse({ ok: true });
}

// 通知を見ただけで状況がわかるよう、metaの主要項目を1行に要約する。
// meta はクライアント由来なので、型が合わない項目は黙って飛ばす。
function summarizeFeedbackMeta(metaJson: string | null): string {
  if (!metaJson) return "";
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metaJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  const parts: string[] = [];
  if (typeof meta.mode === "string") parts.push(`mode:${meta.mode}`);
  if (typeof meta.build === "string") parts.push(meta.build);
  const ai = meta.ai as Record<string, unknown> | undefined;
  if (ai && typeof ai === "object" && typeof ai.difficulty === "string") {
    parts.push(`難易度:${ai.difficulty}`);
  }
  const game = meta.game as Record<string, unknown> | undefined;
  if (game && typeof game === "object" && typeof game.moveCount === "number") {
    parts.push(`${game.moveCount}手`);
  }
  if (Array.isArray(meta.errors)) {
    parts.push(meta.errors.length > 0 ? `⚠️JSエラー${meta.errors.length}件` : "エラーなし");
  }
  return parts.join(" / ").slice(0, 900);
}

async function notifyDiscord(
  env: Env,
  message: string,
  modes: string | null,
  meta: string | null,
): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const fields: Array<{ name: string; value: string }> = [];
    if (modes) fields.push({ name: "問題のモード（申告）", value: modes.slice(0, 900) });
    const summary = summarizeFeedbackMeta(meta);
    if (summary) fields.push({ name: "状況（自動）", value: summary });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "将棋Web フィードバック",
            description: message.slice(0, 1900),
            color: 0x9a3b00,
            timestamp: new Date().toISOString(),
            fields,
          },
        ],
      }),
    });
    if (!res.ok) console.error("discord webhook failed:", res.status);
  } catch (e) {
    console.error("discord webhook error:", e);
  }
}

// ---- entry ------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx);
      } catch (e) {
        console.error("API error:", e);
        return errorResponse(500, "internal_error", "Internal server error");
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
