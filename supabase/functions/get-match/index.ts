// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { isValidRoomCode, normalizeRoomCode } from "../_shared/room.ts";
import { evaluateDisconnect } from "../_shared/disconnect.ts";

type ReqBody = {
  roomCode?: string;
};

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Use POST");
  }

  const user = await requireUser(req);
  if (!user) return errorResponse(401, "unauthorized", "Missing or invalid Authorization header");

  const parsed = await parseJsonBody<ReqBody>(req);
  if (!parsed.ok) return parsed.error;

  const roomCode = normalizeRoomCode(parsed.data.roomCode ?? "");
  if (!roomCode || !isValidRoomCode(roomCode)) {
    return errorResponse(400, "bad_room_code", "Invalid room code");
  }

  const supabase = createSupabaseAdminClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data: match, error: getErr } = await supabase
    .from("online_matches")
    .select("*")
    .eq("room_code", roomCode)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (getErr) return errorResponse(500, "db_error", "Failed to load match", getErr);
  if (!match) return errorResponse(404, "not_found", "Room not found (or expired)");

  const isSente = match.sente_uid === user.id;
  const isGote = match.gote_uid === user.id;
  if (!isSente && !isGote) {
    return errorResponse(403, "forbidden", "You are not a participant of this room");
  }

  const started = Boolean(match.gote_uid);

  const dcTimeout = evaluateDisconnect({
    nowMs,
    lastSeenSente: match.last_seen_sente,
    lastSeenGote: match.last_seen_gote,
    started,
  });

  const update: Record<string, unknown> = {};
  if (isSente) update.last_seen_sente = nowIso;
  if (isGote) update.last_seen_gote = nowIso;

  if (!match.game_over && dcTimeout.gameOver) {
    update.game_over = true;
    update.winner = dcTimeout.winner;
    update.result_reason = dcTimeout.resultReason;
    update.disconnect_side = dcTimeout.disconnect_side;
    update.disconnect_deadline = dcTimeout.disconnect_deadline;
    update.revision = (match.revision ?? 0) + 1;
  } else if (!match.game_over) {
    const uiLastSeenSente = isSente ? nowIso : match.last_seen_sente;
    const uiLastSeenGote = isGote ? nowIso : match.last_seen_gote;
    const dcUi = evaluateDisconnect({
      nowMs,
      lastSeenSente: uiLastSeenSente,
      lastSeenGote: uiLastSeenGote,
      started,
    });
    update.disconnect_side = dcUi.disconnect_side;
    update.disconnect_deadline = dcUi.disconnect_deadline;
  } else {
    update.disconnect_side = null;
    update.disconnect_deadline = null;
  }

  const { data: updated, error: updErr } = await supabase
    .from("online_matches")
    .update(update)
    .eq("id", match.id)
    .select("*")
    .single();

  if (updErr) return errorResponse(500, "db_error", "Failed to update match", updErr);
  return jsonResponse({ ok: true, match: updated });
});
