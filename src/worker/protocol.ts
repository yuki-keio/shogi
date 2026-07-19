// SPDX-License-Identifier: GPL-3.0-only

// Shared types for the online-match API (Worker routes / MatchRoom DO / client).
// The wire payload uses stable snake_case fields expected by the browser client.
// Player uids are never exposed because a uid doubles as the reconnect credential;
// clients receive joined-state booleans and a per-connection `yourSide` instead.

import type { GameState, Move, Player } from "./shogi_engine";

export type Winner = "sente" | "gote" | "draw" | null;

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
