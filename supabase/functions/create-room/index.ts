// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { errorResponse, jsonResponse, parseJsonBody } from "../_shared/response.ts";
import { createSupabaseAdminClient } from "../_shared/supabase.ts";
import { generateRoomCode } from "../_shared/room.ts";
import { createInitialGameState } from "../_shared/shogi_engine.ts";

type ReqBody = {
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

  const displayName = (parsed.data.displayName ?? "").trim().slice(0, 40) || null;

  const supabase = createSupabaseAdminClient();
  const now = Date.now();
  const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const initialState = createInitialGameState();

  for (let attempt = 0; attempt < 8; attempt++) {
    const roomCode = generateRoomCode(10);

    const { data, error } = await supabase
      .from("online_matches")
      .insert({
        room_code: roomCode,
        sente_uid: user.id,
        sente_name: displayName,
        gote_uid: null,
        gote_name: null,
        state: initialState,
        revision: 0,
        game_over: false,
        winner: null,
        result_reason: null,
        last_seen_sente: new Date(now).toISOString(),
        last_seen_gote: null,
        disconnect_deadline: null,
        disconnect_side: null,
        expires_at: expiresAt,
      })
      .select("*")
      .single();

    if (!error) return jsonResponse({ ok: true, match: data });

    // Unique violation on room_code.
    if ((error as { code?: string }).code === "23505") continue;

    return errorResponse(500, "db_error", "Failed to create room", error);
  }

  return errorResponse(500, "room_code_exhausted", "Failed to allocate a unique room code");
});

