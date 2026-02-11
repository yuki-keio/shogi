// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { isValidRoomCode, normalizeRoomCode } from "../_shared/room.ts";
import { GOTE, SENTE } from "../_shared/shogi_engine.ts";

type ReqBody = {
  roomCode?: string;
  expectedRevision?: number;
};

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isInteger(Number(v))) return Number(v);
  return null;
}

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

  const expectedRevision = asInt(parsed.data.expectedRevision);

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
  if (!isSente && !isGote) {
    return errorResponse(403, "forbidden", "You are not a participant of this room");
  }

  if (match.game_over) return jsonResponse({ ok: true, match });

  if (expectedRevision !== null && (match.revision ?? 0) !== expectedRevision) {
    return jsonResponse(
      {
        ok: false,
        error: { code: "revision_conflict", message: "Revision mismatch" },
        match,
      },
      { status: 409 },
    );
  }

  const resigningSide = isSente ? SENTE : GOTE;
  const winner = resigningSide === SENTE ? GOTE : SENTE;

  const { data: rows, error: updErr } = await supabase
    .from("online_matches")
    .update({
      game_over: true,
      winner,
      result_reason: "resign",
      disconnect_side: null,
      disconnect_deadline: null,
      revision: (match.revision ?? 0) + 1,
    })
    .eq("id", match.id)
    .eq("revision", match.revision ?? 0)
    .select("*");

  if (updErr) return errorResponse(500, "db_error", "Failed to resign", updErr);
  if (!rows || rows.length === 0) {
    return errorResponse(409, "revision_conflict", "Revision mismatch");
  }

  return jsonResponse({ ok: true, match: rows[0] });
});

