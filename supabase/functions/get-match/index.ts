// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { isValidRoomCode, normalizeRoomCode } from "../_shared/room.ts";
import { evaluateDisconnectFromPresence, toDisconnectInfo, touchPresence } from "../_shared/presence.ts";
import { GOTE, SENTE } from "../_shared/shogi_engine.ts";

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

  if (match.game_over) {
    return jsonResponse({
      ok: true,
      match,
      disconnect: { side: null, deadline: null },
    });
  }

  const side = isSente ? SENTE : GOTE;

  const started = Boolean(match.gote_uid);
  const touched = await touchPresence(supabase, match.id, side, nowIso);
  if (touched.error) {
    return errorResponse(500, "db_error", "Failed to update player presence", touched.error);
  }

  const dc = evaluateDisconnectFromPresence({
    nowMs,
    started,
    presence: touched.presence,
  });

  if (!match.game_over && dc.gameOver) {
    const expectedRevision = match.revision ?? 0;
    const { data: rows, error: updErr } = await supabase
      .from("online_matches")
      .update({
        game_over: true,
        winner: dc.winner,
        result_reason: dc.resultReason,
        disconnect_side: dc.disconnect_side,
        disconnect_deadline: dc.disconnect_deadline,
        revision: expectedRevision + 1,
      })
      .eq("id", match.id)
      .eq("revision", expectedRevision)
      .select("*");

    if (updErr) return errorResponse(500, "db_error", "Failed to update match", updErr);
    const updated = rows?.[0];
    if (!updated) {
      const { data: latest, error: latestErr } = await supabase
        .from("online_matches")
        .select("*")
        .eq("id", match.id)
        .single();
      if (latestErr) return errorResponse(500, "db_error", "Failed to load latest match", latestErr);
      return jsonResponse({
        ok: true,
        match: latest,
        disconnect: {
          side: latest.disconnect_side ?? null,
          deadline: latest.disconnect_deadline ?? null,
        },
      });
    }
    return jsonResponse({
      ok: true,
      match: updated,
      disconnect: {
        side: updated.disconnect_side ?? null,
        deadline: updated.disconnect_deadline ?? null,
      },
    });
  }

  const disconnect = match.game_over
    ? { side: null, deadline: null }
    : toDisconnectInfo(dc);

  return jsonResponse({
    ok: true,
    match: {
      ...match,
      disconnect_side: disconnect.side,
      disconnect_deadline: disconnect.deadline,
    },
    disconnect,
  });
});
