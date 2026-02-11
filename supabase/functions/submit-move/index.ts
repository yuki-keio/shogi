// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { isValidRoomCode, normalizeRoomCode } from "../_shared/room.ts";
import { evaluateDisconnect } from "../_shared/disconnect.ts";
import { applyMove, GameState, Move, SENTE, GOTE } from "../_shared/shogi_engine.ts";

type ReqBody = {
  roomCode?: string;
  expectedRevision?: number;
  move?: Move;
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
  if (expectedRevision === null || expectedRevision < 0) {
    return errorResponse(400, "bad_expected_revision", "expectedRevision is required");
  }

  const move = parsed.data.move as Move | undefined;
  if (!move || (move.type !== "move" && move.type !== "drop")) {
    return errorResponse(400, "bad_move", "Invalid move payload");
  }

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
  if (!match.gote_uid) {
    return errorResponse(409, "not_started", "Opponent has not joined yet");
  }
  if (match.game_over) {
    return jsonResponse({ ok: true, match });
  }

  // Disconnect timeout check before accepting the move.
  const dc = evaluateDisconnect({
    nowMs: Date.now(),
    lastSeenSente: match.last_seen_sente,
    lastSeenGote: match.last_seen_gote,
    started: true,
  });

  if (dc.gameOver) {
    const { data: rows, error: dcErr } = await supabase
      .from("online_matches")
      .update({
        game_over: true,
        winner: dc.winner,
        result_reason: dc.resultReason,
        disconnect_side: dc.disconnect_side,
        disconnect_deadline: dc.disconnect_deadline,
        revision: (match.revision ?? 0) + 1,
      })
      .eq("id", match.id)
      .select("*");

    if (dcErr) return errorResponse(500, "db_error", "Failed to finalize disconnect", dcErr);
    const updated = rows?.[0] ?? match;
    return jsonResponse({ ok: true, match: updated });
  }

  if ((match.revision ?? 0) !== expectedRevision) {
    return jsonResponse(
      {
        ok: false,
        error: { code: "revision_conflict", message: "Revision mismatch" },
        match,
      },
      { status: 409 },
    );
  }

  const side = isSente ? SENTE : GOTE;
  const state = match.state as GameState;
  if (!state || (state.currentPlayer !== SENTE && state.currentPlayer !== GOTE)) {
    return errorResponse(500, "bad_state", "Corrupted match state");
  }

  if (state.currentPlayer !== side) {
    return errorResponse(403, "not_your_turn", "It is not your turn");
  }

  let nextState: GameState;
  let gameOver = false;
  let winner: "sente" | "gote" | "draw" | null = null;
  let resultReason: "checkmate" | "sennichite" | "perpetual_check" | null = null;

  try {
    const applied = applyMove(state, move);
    nextState = applied.state;
    gameOver = applied.gameOver;
    winner = applied.winner;
    resultReason = applied.resultReason;
  } catch (e) {
    return errorResponse(400, "illegal_move", "Move rejected by server", String(e));
  }

  const update: Record<string, unknown> = {
    state: nextState,
    revision: expectedRevision + 1,
    disconnect_side: null,
    disconnect_deadline: null,
  };
  if (isSente) update.last_seen_sente = nowIso;
  if (isGote) update.last_seen_gote = nowIso;

  if (gameOver) {
    update.game_over = true;
    update.winner = winner;
    update.result_reason = resultReason;
  }

  const { data: rows, error: updErr } = await supabase
    .from("online_matches")
    .update(update)
    .eq("id", match.id)
    .eq("revision", expectedRevision)
    .select("*");

  if (updErr) return errorResponse(500, "db_error", "Failed to save move", updErr);

  if (!rows || rows.length === 0) {
    const { data: latest, error: latestErr } = await supabase
      .from("online_matches")
      .select("*")
      .eq("id", match.id)
      .single();
    if (latestErr) return errorResponse(409, "revision_conflict", "Revision mismatch");
    return jsonResponse(
      {
        ok: false,
        error: { code: "revision_conflict", message: "Revision mismatch" },
        match: latest,
      },
      { status: 409 },
    );
  }

  return jsonResponse({ ok: true, match: rows[0] });
});

