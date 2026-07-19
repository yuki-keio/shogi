// SPDX-License-Identifier: GPL-3.0-only

// MatchRoom Durable Object — one instance and one SQLite row per online-match room.
// WebSocket Hibernation pushes state changes, client pings track liveness without
// waking the object, and alarms enforce disconnect outcomes and 24-hour expiry.
// Room logic runs single-threaded inside the DO, while revision checks remain the
// client-facing conflict protocol.

import { DurableObject } from "cloudflare:workers";
import {
  applyMove,
  createInitialGameState,
  GameState,
  GOTE,
  Move,
  Player,
  SENTE,
} from "./shogi_engine";
import { DISCONNECT_GRACE_MS, evaluateDisconnect, DisconnectEval } from "./disconnect";
import type {
  DisconnectInfo,
  MatchPayload,
  MoveResult,
  RoomResult,
  ServerWsMessage,
} from "./protocol";
import type { Env } from "./env";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
// Mirrors `showAfterMs` inside evaluateDisconnect (disconnect.ts): how long a
// side must be unseen before the opponent sees the disconnect countdown.
const DISCONNECT_SHOW_AFTER_MS = 15_000;
// While a match is running the DO wakes at least this often as a safety net
// (silent TCP death detection + authoritative state re-sync).
const ACTIVE_TICK_MS = 60_000;
// A WebSocket counts as "live" if its last ping auto-response (or open) is
// newer than this. The client pings every 10s.
const WS_FRESH_MS = 25_000;

type MatchRow = {
  room_code: string;
  created_at: number;
  expires_at: number;
  sente_uid: string;
  gote_uid: string | null;
  sente_name: string | null;
  gote_name: string | null;
  state: string; // GameState as JSON
  revision: number;
  game_over: number;
  winner: string | null;
  result_reason: string | null;
  disconnect_side: string | null;
  disconnect_deadline: number | null;
  last_seen_sente: number | null;
  last_seen_gote: number | null;
};

type WsAttachment = { side: Player; uid: string; openedAt: number };

function err(code: string, message: string) {
  return { code, message };
}

export class MatchRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer client keepalive pings without waking the object (uncharged).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- storage helpers -------------------------------------------------

  // Created only when a room is actually created: a DO instantiated by a
  // guessed/expired room code must not write storage (a DO with zero storage
  // and no alarm simply ceases to exist — that IS the cleanup).
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS match (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        room_code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        sente_uid TEXT NOT NULL,
        gote_uid TEXT,
        sente_name TEXT,
        gote_name TEXT,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        game_over INTEGER NOT NULL DEFAULT 0,
        winner TEXT,
        result_reason TEXT,
        disconnect_side TEXT,
        disconnect_deadline INTEGER,
        last_seen_sente INTEGER,
        last_seen_gote INTEGER
      )
    `);
  }

  private loadRow(): MatchRow | null {
    try {
      const rows = this.ctx.storage.sql
        .exec<MatchRow>("SELECT * FROM match WHERE id = 1")
        .toArray();
      return rows.length > 0 ? rows[0] : null;
    } catch {
      // Table does not exist: never created, or wiped by the expiry alarm.
      return null;
    }
  }

  private activeRow(nowMs: number): MatchRow | null {
    const row = this.loadRow();
    if (!row) return null;
    if (nowMs >= row.expires_at) return null; // expired; alarm will clean up
    return row;
  }

  private touch(side: Player, nowMs: number): void {
    const col = side === SENTE ? "last_seen_sente" : "last_seen_gote";
    this.ctx.storage.sql.exec(`UPDATE match SET ${col} = ? WHERE id = 1`, nowMs);
  }

  // ---- presence / disconnect -------------------------------------------

  // `exclude` skips a socket that is in the middle of closing —
  // webSocketClose still sees it in getWebSockets() while the handler runs.
  private sideSocketFreshness(side: Player, exclude?: WebSocket): number | null {
    let newest: number | null = null;
    for (const ws of this.ctx.getWebSockets(side)) {
      if (ws === exclude) continue;
      const att = ws.deserializeAttachment() as WsAttachment | null;
      let ts = att?.openedAt ?? 0;
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (auto && auto.getTime() > ts) ts = auto.getTime();
      if (newest === null || ts > newest) newest = ts;
    }
    return newest;
  }

  private effectiveLastSeen(
    row: MatchRow,
    side: Player,
    exclude?: WebSocket,
  ): number | null {
    const stored = side === SENTE ? row.last_seen_sente : row.last_seen_gote;
    const wsTs = this.sideSocketFreshness(side, exclude);
    if (stored === null && wsTs === null) return null;
    return Math.max(stored ?? 0, wsTs ?? 0);
  }

  private sideConnected(side: Player, nowMs: number, exclude?: WebSocket): boolean {
    const ts = this.sideSocketFreshness(side, exclude);
    return ts !== null && nowMs - ts < WS_FRESH_MS;
  }

  private evaluate(row: MatchRow, nowMs: number): DisconnectEval {
    const started = Boolean(row.gote_uid) && !row.game_over;
    const s = this.effectiveLastSeen(row, SENTE);
    const g = this.effectiveLastSeen(row, GOTE);
    return evaluateDisconnect({
      nowMs,
      started,
      lastSeenSente: s !== null ? new Date(s).toISOString() : null,
      lastSeenGote: g !== null ? new Date(g).toISOString() : null,
    });
  }

  // ---- payload building --------------------------------------------------

  private toPayload(row: MatchRow, dc: DisconnectEval | null): MatchPayload {
    const gameOver = Boolean(row.game_over);
    let dcSide: Player | null = null;
    let dcDeadline: string | null = null;
    if (gameOver) {
      dcSide = (row.disconnect_side as Player | null) ?? null;
      dcDeadline =
        row.disconnect_deadline !== null
          ? new Date(row.disconnect_deadline).toISOString()
          : null;
    } else if (dc) {
      dcSide = dc.disconnect_side;
      dcDeadline = dc.disconnect_deadline;
    }
    return {
      room_code: row.room_code,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      sente_joined: true,
      gote_joined: Boolean(row.gote_uid),
      sente_name: row.sente_name,
      gote_name: row.gote_name,
      state: JSON.parse(row.state) as GameState,
      revision: row.revision,
      game_over: gameOver,
      winner: (row.winner as MatchPayload["winner"]) ?? null,
      result_reason: row.result_reason,
      disconnect_side: dcSide,
      disconnect_deadline: dcDeadline,
    };
  }

  private toDisconnectInfo(row: MatchRow, dc: DisconnectEval | null): DisconnectInfo {
    if (row.game_over || !dc) return { side: null, deadline: null };
    return { side: dc.disconnect_side, deadline: dc.disconnect_deadline };
  }

  // ---- broadcasting ------------------------------------------------------

  private broadcastState(row: MatchRow, dc: DisconnectEval | null, exclude?: WebSocket): void {
    const match = this.toPayload(row, dc);
    const disconnect = this.toDisconnectInfo(row, dc);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att) continue;
      const msg: ServerWsMessage = { type: "state", match, disconnect, yourSide: att.side };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        try {
          ws.close(1011, "send_failed");
        } catch {
          // ignore
        }
      }
    }
  }

  // ---- alarm scheduling ----------------------------------------------------

  private scheduleAlarm(row: MatchRow, nowMs: number, exclude?: WebSocket): void {
    let next = row.expires_at;
    if (row.gote_uid && !row.game_over) {
      next = Math.min(next, nowMs + ACTIVE_TICK_MS);
      for (const side of [SENTE, GOTE] as const) {
        if (this.sideConnected(side, nowMs, exclude)) continue;
        const ls = this.effectiveLastSeen(row, side, exclude);
        if (ls === null) continue;
        const show = ls + DISCONNECT_SHOW_AFTER_MS;
        const drop = ls + DISCONNECT_GRACE_MS;
        if (show > nowMs) next = Math.min(next, show);
        if (drop > nowMs) next = Math.min(next, drop);
      }
    }
    void this.ctx.storage.setAlarm(next);
  }

  private finalizeDisconnect(row: MatchRow, dc: DisconnectEval, nowMs: number): MatchRow {
    const deadlineMs = dc.disconnect_deadline ? Date.parse(dc.disconnect_deadline) : null;
    this.ctx.storage.sql.exec(
      `UPDATE match SET game_over = 1, winner = ?, result_reason = ?,
         disconnect_side = ?, disconnect_deadline = ?, revision = revision + 1
       WHERE id = 1`,
      dc.winner,
      dc.resultReason,
      dc.disconnect_side,
      Number.isFinite(deadlineMs as number) ? deadlineMs : null,
    );
    const updated = this.loadRow()!;
    this.broadcastState(updated, null);
    this.scheduleAlarm(updated, nowMs);
    return updated;
  }

  // ---- RPC: room lifecycle -------------------------------------------------

  async createRoom(params: {
    roomCode: string;
    uid: string;
    displayName: string | null;
  }): Promise<RoomResult> {
    const now = Date.now();
    this.ensureSchema();
    if (this.loadRow()) {
      return { ok: false, error: err("room_exists", "Room already exists") };
    }
    const initialState = createInitialGameState();
    this.ctx.storage.sql.exec(
      `INSERT INTO match (
         id, room_code, created_at, expires_at,
         sente_uid, gote_uid, sente_name, gote_name,
         state, revision, game_over, winner, result_reason,
         disconnect_side, disconnect_deadline, last_seen_sente, last_seen_gote
       ) VALUES (1, ?, ?, ?, ?, NULL, ?, NULL, ?, 0, 0, NULL, NULL, NULL, NULL, ?, NULL)`,
      params.roomCode,
      now,
      now + ROOM_TTL_MS,
      params.uid,
      params.displayName,
      JSON.stringify(initialState),
      now,
    );
    const row = this.loadRow()!;
    this.scheduleAlarm(row, now);
    return {
      ok: true,
      match: this.toPayload(row, null),
      yourSide: SENTE,
      disconnect: { side: null, deadline: null },
    };
  }

  async join(params: { uid: string; displayName: string | null }): Promise<RoomResult> {
    const now = Date.now();
    const row = this.activeRow(now);
    if (!row) {
      return { ok: false, error: err("not_found", "Room not found (or expired)") };
    }

    const isSente = row.sente_uid === params.uid;
    const isGote = row.gote_uid === params.uid;
    const goteEmpty = !row.gote_uid;
    const assigningGote = !isSente && !isGote && goteEmpty;

    if (row.game_over && !isSente && !isGote) {
      return { ok: false, error: err("game_over", "This match has already ended") };
    }
    if (!isSente && !isGote && !goteEmpty) {
      return { ok: false, error: err("room_full", "This room is already full") };
    }

    if (assigningGote) {
      this.ctx.storage.sql.exec(
        `UPDATE match SET gote_uid = ?, gote_name = ?, last_seen_sente = ?, last_seen_gote = ?
         WHERE id = 1`,
        params.uid,
        params.displayName,
        now,
        now,
      );
    } else if (isSente && params.displayName && !row.sente_name) {
      this.ctx.storage.sql.exec(
        "UPDATE match SET sente_name = ? WHERE id = 1",
        params.displayName,
      );
    } else if (isGote && params.displayName && !row.gote_name) {
      this.ctx.storage.sql.exec(
        "UPDATE match SET gote_name = ? WHERE id = 1",
        params.displayName,
      );
    }

    const mySide: Player = isSente ? SENTE : isGote ? GOTE : GOTE;
    this.touch(mySide, now);

    const updated = this.loadRow()!;
    const dc = updated.game_over ? null : this.evaluate(updated, now);

    if (assigningGote) {
      // The match just started, so tell the waiting sente immediately.
      this.broadcastState(updated, dc);
    }
    this.scheduleAlarm(updated, now);

    return {
      ok: true,
      match: this.toPayload(updated, dc),
      yourSide: mySide,
      disconnect: this.toDisconnectInfo(updated, dc),
    };
  }

  async getStateFor(params: { side: Player; uid: string }): Promise<RoomResult> {
    const now = Date.now();
    const row = this.activeRow(now);
    if (!row) {
      return { ok: false, error: err("not_found", "Room not found (or expired)") };
    }
    if (!this.uidMatchesSeat(row, params.side, params.uid)) {
      return { ok: false, error: err("forbidden", "You are not a participant of this room") };
    }

    if (row.game_over) {
      return {
        ok: true,
        match: this.toPayload(row, null),
        yourSide: params.side,
        disconnect: { side: null, deadline: null },
      };
    }

    this.touch(params.side, now);
    const touched = this.loadRow()!;
    const dc = this.evaluate(touched, now);

    if (dc.gameOver) {
      const finalized = this.finalizeDisconnect(touched, dc, now);
      return {
        ok: true,
        match: this.toPayload(finalized, null),
        yourSide: params.side,
        disconnect: { side: null, deadline: null },
      };
    }

    this.scheduleAlarm(touched, now);
    return {
      ok: true,
      match: this.toPayload(touched, dc),
      yourSide: params.side,
      disconnect: this.toDisconnectInfo(touched, dc),
    };
  }

  private uidMatchesSeat(row: MatchRow, side: Player, uid: string): boolean {
    if (side === SENTE) return row.sente_uid === uid;
    return row.gote_uid !== null && row.gote_uid === uid;
  }

  // ---- RPC: gameplay -------------------------------------------------------

  async submitMove(params: {
    side: Player;
    uid: string;
    expectedRevision: number;
    move: Move;
  }): Promise<MoveResult> {
    const now = Date.now();
    const row = this.activeRow(now);
    if (!row) return { ok: false, error: err("not_found", "Room not found (or expired)") };
    if (!this.uidMatchesSeat(row, params.side, params.uid)) {
      return { ok: false, error: err("forbidden", "You are not a participant of this room") };
    }
    return this.handleMove(params.side, params.expectedRevision, params.move, now);
  }

  async resign(params: {
    side: Player;
    uid: string;
    expectedRevision: number | null;
  }): Promise<MoveResult> {
    const now = Date.now();
    const row = this.activeRow(now);
    if (!row) return { ok: false, error: err("not_found", "Room not found (or expired)") };
    if (!this.uidMatchesSeat(row, params.side, params.uid)) {
      return { ok: false, error: err("forbidden", "You are not a participant of this room") };
    }
    return this.handleResign(params.side, params.expectedRevision, now);
  }

  private handleMove(
    side: Player,
    expectedRevision: number,
    move: Move,
    now: number,
    exclude?: WebSocket,
  ): MoveResult {
    const row = this.activeRow(now);
    if (!row) return { ok: false, error: err("not_found", "Room not found (or expired)") };

    if (!row.gote_uid) {
      return { ok: false, error: err("not_started", "Opponent has not joined yet") };
    }
    if (row.game_over) {
      // Keep retries idempotent by returning the authoritative final state.
      return { ok: true, match: this.toPayload(row, null) };
    }

    this.touch(side, now);
    const touched = this.loadRow()!;

    // Disconnect timeout check before accepting the move.
    const dc = this.evaluate(touched, now);
    if (dc.gameOver) {
      const finalized = this.finalizeDisconnect(touched, dc, now);
      return { ok: true, match: this.toPayload(finalized, null) };
    }

    if (touched.revision !== expectedRevision) {
      return {
        ok: false,
        error: err("revision_conflict", "Revision mismatch"),
        match: this.toPayload(touched, dc),
      };
    }

    const state = JSON.parse(touched.state) as GameState;
    if (!state || (state.currentPlayer !== SENTE && state.currentPlayer !== GOTE)) {
      return { ok: false, error: err("bad_state", "Corrupted match state") };
    }
    if (state.currentPlayer !== side) {
      return {
        ok: false,
        error: err("not_your_turn", "It is not your turn"),
        match: this.toPayload(touched, dc),
      };
    }

    let applied;
    try {
      applied = applyMove(state, move);
    } catch (e) {
      return {
        ok: false,
        error: err("illegal_move", `Move rejected by server: ${String(e)}`),
        match: this.toPayload(touched, dc),
      };
    }

    if (applied.gameOver) {
      this.ctx.storage.sql.exec(
        `UPDATE match SET state = ?, revision = revision + 1,
           game_over = 1, winner = ?, result_reason = ?,
           disconnect_side = NULL, disconnect_deadline = NULL
         WHERE id = 1`,
        JSON.stringify(applied.state),
        applied.winner,
        applied.resultReason,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE match SET state = ?, revision = revision + 1,
           disconnect_side = NULL, disconnect_deadline = NULL
         WHERE id = 1`,
        JSON.stringify(applied.state),
      );
    }

    const updated = this.loadRow()!;
    const updatedDc = updated.game_over ? null : this.evaluate(updated, now);
    this.broadcastState(updated, updatedDc, exclude);
    this.scheduleAlarm(updated, now);
    return { ok: true, match: this.toPayload(updated, updatedDc) };
  }

  private handleResign(
    side: Player,
    expectedRevision: number | null,
    now: number,
    exclude?: WebSocket,
  ): MoveResult {
    const row = this.activeRow(now);
    if (!row) return { ok: false, error: err("not_found", "Room not found (or expired)") };

    if (row.game_over) {
      return { ok: true, match: this.toPayload(row, null) };
    }
    if (expectedRevision !== null && row.revision !== expectedRevision) {
      return {
        ok: false,
        error: err("revision_conflict", "Revision mismatch"),
        match: this.toPayload(row, row.game_over ? null : this.evaluate(row, now)),
      };
    }

    const winner = side === SENTE ? GOTE : SENTE;
    this.ctx.storage.sql.exec(
      `UPDATE match SET game_over = 1, winner = ?, result_reason = 'resign',
         disconnect_side = NULL, disconnect_deadline = NULL, revision = revision + 1
       WHERE id = 1`,
      winner,
    );

    const updated = this.loadRow()!;
    this.broadcastState(updated, null, exclude);
    this.scheduleAlarm(updated, now);
    return { ok: true, match: this.toPayload(updated, null) };
  }

  // ---- WebSocket (Hibernation API) ------------------------------------------

  // The Worker verifies the player token and forwards the upgrade request with
  // x-match-side / x-match-uid headers.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { ok: false, error: err("bad_request", "Expected WebSocket upgrade") },
        { status: 400 },
      );
    }
    const side = request.headers.get("x-match-side") as Player | null;
    const uid = request.headers.get("x-match-uid");
    if ((side !== SENTE && side !== GOTE) || !uid) {
      return Response.json(
        { ok: false, error: err("unauthorized", "Missing player identity") },
        { status: 401 },
      );
    }

    const now = Date.now();
    const row = this.activeRow(now);
    if (!row) {
      return Response.json(
        { ok: false, error: err("not_found", "Room not found (or expired)") },
        { status: 404 },
      );
    }
    if (!this.uidMatchesSeat(row, side, uid)) {
      return Response.json(
        { ok: false, error: err("forbidden", "You are not a participant of this room") },
        { status: 403 },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [side]);
    const attachment: WsAttachment = { side, uid, openedAt: now };
    server.serializeAttachment(attachment);

    if (!row.game_over) this.touch(side, now);
    const fresh = this.loadRow()!;
    const dc = fresh.game_over ? null : this.evaluate(fresh, now);

    // Initial state to the new socket…
    const initial: ServerWsMessage = {
      type: "state",
      match: this.toPayload(fresh, dc),
      disconnect: this.toDisconnectInfo(fresh, dc),
      yourSide: side,
    };
    server.send(JSON.stringify(initial));
    // …and let everyone else know (e.g. clears their disconnect countdown).
    this.broadcastState(fresh, dc, server);
    this.scheduleAlarm(fresh, now);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;

    let data: { type?: string; reqId?: unknown; expectedRevision?: unknown; move?: unknown };
    try {
      data = JSON.parse(message);
    } catch {
      this.sendTo(ws, { type: "error", error: err("bad_json", "Invalid JSON message") });
      return;
    }

    const now = Date.now();
    const reqId = typeof data.reqId === "number" ? data.reqId : null;

    if (data.type === "move") {
      const expectedRevision =
        typeof data.expectedRevision === "number" && Number.isInteger(data.expectedRevision)
          ? data.expectedRevision
          : null;
      const move = data.move as Move | undefined;
      if (reqId === null || expectedRevision === null || expectedRevision < 0 ||
          !move || (move.type !== "move" && move.type !== "drop")) {
        this.sendTo(ws, { type: "error", error: err("bad_move", "Invalid move payload") });
        return;
      }
      const result = this.handleMove(att.side, expectedRevision, move, now, ws);
      this.sendTo(ws, { type: "ack", reqId, ...result });
      return;
    }

    if (data.type === "resign") {
      if (reqId === null) {
        this.sendTo(ws, { type: "error", error: err("bad_request", "Missing reqId") });
        return;
      }
      const expectedRevision =
        typeof data.expectedRevision === "number" && Number.isInteger(data.expectedRevision)
          ? data.expectedRevision
          : null;
      const result = this.handleResign(att.side, expectedRevision, now, ws);
      this.sendTo(ws, { type: "ack", reqId, ...result });
      return;
    }

    this.sendTo(ws, { type: "error", error: err("bad_request", "Unknown message type") });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.noteSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.noteSocketGone(ws);
  }

  private noteSocketGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;
    const now = Date.now();
    const row = this.loadRow();
    if (!row || now >= row.expires_at || row.game_over) return;
    // Freeze last_seen at the disconnect moment; the alarm chain takes it from
    // here (countdown push at +15s, forfeit at +60s — same rules as before).
    this.touch(att.side, now);
    const touched = this.loadRow()!;
    this.scheduleAlarm(touched, now, ws);
  }

  private sendTo(ws: WebSocket, msg: ServerWsMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore — close handling will pick this socket up
    }
  }

  // ---- alarm -----------------------------------------------------------------

  async alarm(): Promise<void> {
    const row = this.loadRow();
    if (!row) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();

    // 24h expiry: notify clients, close sockets, and wipe all room storage.
    if (now >= row.expires_at) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ type: "expired" } satisfies ServerWsMessage));
          ws.close(1000, "room_expired");
        } catch {
          // ignore
        }
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    if (row.gote_uid && !row.game_over) {
      const dc = this.evaluate(row, now);
      if (dc.gameOver) {
        this.finalizeDisconnect(row, dc, now);
        return;
      }
      // Periodic authoritative re-sync + disconnect countdown updates.
      this.broadcastState(row, dc);
      this.scheduleAlarm(row, now);
      return;
    }

    this.scheduleAlarm(row, now);
  }
}
