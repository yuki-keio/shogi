// SPDX-License-Identifier: GPL-3.0-only

// Source of truth for disconnect heartbeat is `online_match_presence.last_seen_*`.
// `online_matches.last_seen_*` is legacy compatibility data and should not be read by new logic.

import { DisconnectEval, evaluateDisconnect } from "./disconnect.ts";
import { GOTE, Player, SENTE } from "./shogi_engine.ts";

export type MatchPresenceRow = {
  match_id: string;
  last_seen_sente: string | null;
  last_seen_gote: string | null;
  updated_at: string;
};

export type DisconnectInfo = {
  side: Player | null;
  deadline: string | null;
};

const PRESENCE_SELECT = "match_id,last_seen_sente,last_seen_gote,updated_at";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

export async function touchPresence(
  supabase: any,
  matchId: string,
  side: Player,
  nowIso: string,
): Promise<{ presence: MatchPresenceRow | null; error: unknown | null }> {
  const update: Record<string, unknown> = { updated_at: nowIso };
  if (side === SENTE) update.last_seen_sente = nowIso;
  if (side === GOTE) update.last_seen_gote = nowIso;

  const { data: updated, error: updateErr } = await supabase
    .from("online_match_presence")
    .update(update)
    .eq("match_id", matchId)
    .select(PRESENCE_SELECT);

  if (updateErr) return { presence: null, error: updateErr };
  if (updated && updated.length > 0) {
    return { presence: updated[0] as MatchPresenceRow, error: null };
  }

  const insertPayload: Record<string, unknown> = {
    match_id: matchId,
    updated_at: nowIso,
  };
  if (side === SENTE) insertPayload.last_seen_sente = nowIso;
  if (side === GOTE) insertPayload.last_seen_gote = nowIso;

  const { data: inserted, error: insertErr } = await supabase
    .from("online_match_presence")
    .insert(insertPayload)
    .select(PRESENCE_SELECT)
    .single();

  if (insertErr) {
    if (!isUniqueViolation(insertErr)) {
      return { presence: null, error: insertErr };
    }
    const { data: retried, error: retryErr } = await supabase
      .from("online_match_presence")
      .update(update)
      .eq("match_id", matchId)
      .select(PRESENCE_SELECT)
      .single();
    if (retryErr) return { presence: null, error: retryErr };
    return { presence: retried as MatchPresenceRow, error: null };
  }

  return { presence: inserted as MatchPresenceRow, error: null };
}

export function evaluateDisconnectFromPresence(params: {
  nowMs: number;
  started: boolean;
  presence: MatchPresenceRow | null;
}): DisconnectEval {
  return evaluateDisconnect({
    nowMs: params.nowMs,
    started: params.started,
    lastSeenSente: params.presence?.last_seen_sente ?? null,
    lastSeenGote: params.presence?.last_seen_gote ?? null,
  });
}

export function toDisconnectInfo(evalResult: DisconnectEval): DisconnectInfo {
  return {
    side: evalResult.disconnect_side,
    deadline: evalResult.disconnect_deadline,
  };
}
