// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { isValidRoomCode, normalizeRoomCode } from "../_shared/room.ts";
import { touchPresence } from "../_shared/presence.ts";
import { GOTE, SENTE } from "../_shared/shogi_engine.ts";

type ReqBody = {
  roomCode?: string;
  displayName?: string;
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

  const displayName = (parsed.data.displayName ?? "").trim().slice(0, 40) || null;

  const supabase = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();

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
  const goteEmpty = !match.gote_uid;
  const assigningGote = !isSente && !isGote && goteEmpty;

  if (match.game_over && !isSente && !isGote) {
    return errorResponse(403, "game_over", "This match has already ended");
  }

  if (!isSente && !isGote && !goteEmpty) {
    return errorResponse(403, "room_full", "This room is already full");
  }

  // Seat assignment / reconnect heartbeat
  let update: Record<string, unknown> = {};
  if (isSente) {
    if (displayName && !match.sente_name) update.sente_name = displayName;
  } else if (isGote) {
    if (displayName && !match.gote_name) update.gote_name = displayName;
  } else {
    update.gote_uid = user.id;
    update.gote_name = displayName;
  }

  let updated = match;
  if (Object.keys(update).length > 0) {
    let query = supabase
      .from("online_matches")
      .update(update)
      .eq("id", match.id);

    // Prevent race conditions where two users try to take the gote seat.
    if (assigningGote) {
      query = query.is("gote_uid", null);
    }

    const { data: rows, error: updErr } = await query.select("*");

    if (updErr) return errorResponse(500, "db_error", "Failed to join room", updErr);
    updated = rows?.[0];
    if (!updated) {
      const { data: latest } = await supabase
        .from("online_matches")
        .select("*")
        .eq("id", match.id)
        .single();

      if (latest && latest.gote_uid && latest.gote_uid !== user.id) {
        return errorResponse(403, "room_full", "This room is already full");
      }
      return errorResponse(409, "join_conflict", "Failed to join due to a concurrent update");
    }
  }

  if (assigningGote) {
    const sentePresence = await touchPresence(supabase, updated.id, SENTE, nowIso);
    if (sentePresence.error) {
      return errorResponse(500, "db_error", "Failed to update player presence", sentePresence.error);
    }
  }

  const mySide = updated.sente_uid === user.id ? SENTE : updated.gote_uid === user.id ? GOTE : null;
  if (mySide) {
    const touched = await touchPresence(supabase, updated.id, mySide, nowIso);
    if (touched.error) {
      return errorResponse(500, "db_error", "Failed to update player presence", touched.error);
    }
  }

  return jsonResponse({ ok: true, match: updated });
});
