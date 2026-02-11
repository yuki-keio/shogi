// SPDX-License-Identifier: GPL-3.0-only

import { GOTE, Player, SENTE } from "./shogi_engine.ts";

export const DISCONNECT_GRACE_MS = 60_000;

export type DisconnectEval = {
  // If true, the game should be ended due to timeout.
  gameOver: boolean;
  winner: "sente" | "gote" | "draw" | null;
  resultReason: "disconnect" | null;

  // Optional info for UI.
  disconnect_side: Player | null;
  disconnect_deadline: string | null; // ISO
};

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

export function evaluateDisconnect(params: {
  nowMs: number;
  lastSeenSente: string | null;
  lastSeenGote: string | null;
  started: boolean;
}): DisconnectEval {
  if (!params.started) {
    return {
      gameOver: false,
      winner: null,
      resultReason: null,
      disconnect_side: null,
      disconnect_deadline: null,
    };
  }

  const sMs = parseTs(params.lastSeenSente);
  const gMs = parseTs(params.lastSeenGote);

  // If either side never heartbeated, treat as "just now" for a moment;
  // real clients should call heartbeat immediately after join.
  const sLast = sMs ?? params.nowMs;
  const gLast = gMs ?? params.nowMs;

  const sDeadline = sLast + DISCONNECT_GRACE_MS;
  const gDeadline = gLast + DISCONNECT_GRACE_MS;

  const sExpired = params.nowMs >= sDeadline;
  const gExpired = params.nowMs >= gDeadline;

  if (sExpired && gExpired) {
    return {
      gameOver: true,
      winner: "draw",
      resultReason: "disconnect",
      disconnect_side: null,
      disconnect_deadline: null,
    };
  }
  if (sExpired) {
    return {
      gameOver: true,
      winner: GOTE,
      resultReason: "disconnect",
      disconnect_side: SENTE,
      disconnect_deadline: new Date(sDeadline).toISOString(),
    };
  }
  if (gExpired) {
    return {
      gameOver: true,
      winner: SENTE,
      resultReason: "disconnect",
      disconnect_side: GOTE,
      disconnect_deadline: new Date(gDeadline).toISOString(),
    };
  }

  // Optional: expose the more-stale side's deadline to show a countdown.
  const sAge = params.nowMs - sLast;
  const gAge = params.nowMs - gLast;
  const showAfterMs = 15_000;
  if (sAge >= showAfterMs && sAge > gAge) {
    return {
      gameOver: false,
      winner: null,
      resultReason: null,
      disconnect_side: SENTE,
      disconnect_deadline: new Date(sDeadline).toISOString(),
    };
  }
  if (gAge >= showAfterMs && gAge > sAge) {
    return {
      gameOver: false,
      winner: null,
      resultReason: null,
      disconnect_side: GOTE,
      disconnect_deadline: new Date(gDeadline).toISOString(),
    };
  }

  return {
    gameOver: false,
    winner: null,
    resultReason: null,
    disconnect_side: null,
    disconnect_deadline: null,
  };
}

