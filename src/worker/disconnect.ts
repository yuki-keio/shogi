// SPDX-License-Identifier: GPL-3.0-only

import { GOTE, Player, SENTE } from "./shogi_engine";

export const DISCONNECT_GRACE_MS = 60_000;
// だれかと対戦で、組まれてから一度も部屋に入ってこない席の締め切り（設計書 §4.4.1）。相手を動かない盤の前で待たせない。
// 画面は組まれてから約16.5秒まで入室を試みる（online-match.js の FOUND_PAUSE_MS と watchGameStart）ので、それより長くする
export const ENTRY_GRACE_MS = 20_000;

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
  // 席ごとの猶予。省略すると DISCONNECT_GRACE_MS
  graceSenteMs?: number;
  graceGoteMs?: number;
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

  // A newly joined side may not have sent a liveness signal yet, so grant the
  // initial disconnect grace period before considering that side absent.
  const sLast = sMs ?? params.nowMs;
  const gLast = gMs ?? params.nowMs;

  const sDeadline = sLast + (params.graceSenteMs ?? DISCONNECT_GRACE_MS);
  const gDeadline = gLast + (params.graceGoteMs ?? DISCONNECT_GRACE_MS);

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
