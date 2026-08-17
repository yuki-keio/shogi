// SPDX-License-Identifier: GPL-3.0-only

// Shared types for the online-match API (Worker routes / MatchRoom DO / client).
// The wire payload uses stable snake_case fields expected by the browser client.
// Player uids are never exposed because a uid doubles as the reconnect credential;
// clients receive joined-state booleans and a per-connection `yourSide` instead.

import type { GameState, Move, Player } from "./shogi_engine";

export type Winner = "sente" | "gote" | "draw" | null;

// Friend-match time control. "total" = sudden death (切れ負け), "per_move" =
// a fixed allowance per move (1手ごと). Enforced server-side by the DO alarm.
export type TimeControlType = "none" | "total" | "per_move";

// The creator's stored seat preference; "random" is preserved so the lobby UI
// can restore the selection after a reload (the resolved seat is `yourSide`).
export type SidePref = "sente" | "gote" | "random";

// How the room came to exist: "invite" = friend match via invite URL,
// "matchmaking" = seats assigned by the Matchmaker DO. Mechanism-based names
// on purpose — no "quick"/"random"/"casual" (they would go stale if rated
// play is ever layered on top of the same mechanisms).
export type MatchType = "invite" | "matchmaking";

export type MatchPayload = {
  room_code: string;
  created_at: string; // ISO
  expires_at: string; // ISO
  sente_joined: boolean;
  gote_joined: boolean;
  sente_name: string | null;
  gote_name: string | null;
  state: GameState;
  revision: number;
  game_over: boolean;
  winner: Winner;
  result_reason: string | null;
  disconnect_side: Player | null;
  disconnect_deadline: string | null; // ISO
  side_pref: SidePref | null;
  match_type: MatchType;
  tc_type: TimeControlType;
  tc_seconds: number; // 0 when tc_type === "none"
  sente_time_ms: number | null; // remaining at turn start (total mode only)
  gote_time_ms: number | null;
  turn_deadline: string | null; // ISO; the current mover flags at this instant
  server_now: string; // ISO; lets clients offset their clock skew
};

export type DisconnectInfo = {
  side: Player | null;
  deadline: string | null; // ISO
};

export type ApiError = { code: string; message: string };

// DO RPC results (also serialized into HTTP/WS responses).
export type RoomResult =
  | { ok: true; match: MatchPayload; yourSide: Player; disconnect: DisconnectInfo }
  | { ok: false; error: ApiError; match?: MatchPayload };

export type MoveResult =
  | { ok: true; match: MatchPayload }
  | { ok: false; error: ApiError; match?: MatchPayload };

// Client -> server WebSocket messages.
export type ClientWsMessage =
  | { type: "move"; reqId: number; expectedRevision: number; move: Move }
  | { type: "resign"; reqId: number; expectedRevision: number };

// Matchmaker queue: server -> client messages (GET /api/match/ws). Clients
// send nothing on this socket ("ping" keepalives are auto-answered; cancelling
// is just closing it). After "matched" / "bot" the server closes the socket.
export type MatchmakerServerMessage =
  | { type: "queued"; playing: number }
  | {
      type: "matched";
      room_code: string;
      token: string;
      yourSide: Player;
      opponentName: string | null;
    }
  | { type: "bot" }
  | { type: "error"; error: ApiError };

// Server -> client WebSocket messages.
export type ServerWsMessage =
  | {
      type: "state";
      match: MatchPayload;
      disconnect: DisconnectInfo;
      yourSide: Player;
    }
  | ({ type: "ack"; reqId: number } & MoveResult)
  | { type: "expired" }
  | { type: "error"; error: ApiError };
