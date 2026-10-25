// SPDX-License-Identifier: GPL-3.0-only

// MatchRoom DO integration tests: room lifecycle, revision conflicts,
// auth, WebSocket flow, disconnect alarm, 24h self-deletion.

import {
  env,
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MatchPayload } from "../src/worker/protocol";
import { FLOOD_FORFEIT_EXCESS, MAX_REQUESTS_PER_WINDOW } from "../src/worker/match_room";
import { replayUsiMoves } from "../src/kifu/replay";
import { parseUsiMove } from "../src/kifu/moves";
import kifu from "./fixtures/bot_win_kifu.json";

const UID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const UID_B = "bbbbbbbb-2222-4222-8222-222222222222";
const UID_C = "cccccccc-3333-4333-8333-333333333333";

type RoomHttpResult = {
  ok: boolean;
  match?: MatchPayload;
  yourSide?: "sente" | "gote";
  token?: string;
  disconnect?: { side: string | null; deadline: string | null };
  error?: { code: string; message: string };
};

// Each create gets its own IP so tests never trip the per-IP rate limit.
let nextTestIp = 1;

async function createRoom(uid = UID_A) {
  nextTestIp += 1;
  const res = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
    headers: { "CF-Connecting-IP": `10.9.${Math.floor(nextTestIp / 256)}.${nextTestIp % 256}` },
    body: JSON.stringify({ uid }),
  });
  const json = (await res.json()) as RoomHttpResult;
  return { res, json };
}

async function joinRoom(code: string, uid: string) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
    method: "POST",
    body: JSON.stringify({ uid }),
  });
  const json = (await res.json()) as RoomHttpResult;
  return { res, json };
}

async function postMove(
  code: string,
  token: string,
  expectedRevision: number,
  move: unknown,
) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/move`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ expectedRevision, move }),
  });
  const json = (await res.json()) as RoomHttpResult;
  return { res, json };
}

async function getState(code: string, token: string) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as RoomHttpResult;
  return { res, json };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("room lifecycle (HTTP)", () => {
  it("creates a room and returns a sente token", async () => {
    const { res, json } = await createRoom();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.yourSide).toBe("sente");
    expect(json.token).toBeTruthy();
    expect(json.match!.revision).toBe(0);
    expect(json.match!.sente_joined).toBe(true);
    expect(json.match!.gote_joined).toBe(false);
    expect(json.match!.game_over).toBe(false);
    expect(json.match!.started_at).toBeNull();
    expect(json.match!.ended_at).toBeNull();
    expect(json.match!.room_code).toMatch(/^[A-Z2-9]{10}$/);
    // uids must never leak to clients
    expect(JSON.stringify(json)).not.toContain(UID_A);
  });

  it("join assigns gote, reconnect keeps seats, third player is rejected", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;

    const { json: joined } = await joinRoom(code, UID_B);
    expect(joined.ok).toBe(true);
    expect(joined.yourSide).toBe("gote");
    expect(joined.match!.gote_joined).toBe(true);

    // Same browser rejoin -> same seat.
    const { json: rejoinA } = await joinRoom(code, UID_A);
    expect(rejoinA.yourSide).toBe("sente");
    const { json: rejoinB } = await joinRoom(code, UID_B);
    expect(rejoinB.yourSide).toBe("gote");

    // A third uid cannot enter.
    const { res: resC, json: joinC } = await joinRoom(code, UID_C);
    expect(resC.status).toBe(403);
    expect(joinC.error?.code).toBe("room_full");
  });

  it("defaults match_type to 'invite' and reads legacy NULL rows as 'invite'", async () => {
    const { json: created } = await createRoom();
    expect(created.match!.match_type).toBe("invite");

    // Rooms created before the matchmaking feature have match_type = NULL.
    const code = created.match!.room_code;
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE match SET match_type = NULL WHERE id = 1");
    });
    const after = await getState(code, created.token!);
    expect(after.json.match!.match_type).toBe("invite");
  });

  it("fixes the actual start and end times across reconnects and repeated results", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const beforeJoin = Date.now();
    const { json: joined } = await joinRoom(code, UID_B);
    const started = joined.match!.started_at!;
    expect(Date.parse(started)).toBeGreaterThanOrEqual(beforeJoin);
    expect(Date.parse(started)).toBeLessThanOrEqual(Date.now());
    expect(joined.match!.ended_at).toBeNull();

    const { json: rejoined } = await joinRoom(code, UID_B);
    expect(rejoined.match!.started_at).toBe(started);
    const stub = env.MATCH_ROOM.getByName(code);
    const beforeEnd = Date.now();
    const ended = await stub.resign({ side: "gote", uid: UID_B, expectedRevision: 0 });
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(Date.parse(ended.match.ended_at!)).toBeGreaterThanOrEqual(beforeEnd);
    expect(Date.parse(ended.match.ended_at!)).toBeLessThanOrEqual(Date.now());
    expect(ended.match.started_at).toBe(started);

    const repeated = await stub.resign({ side: "gote", uid: UID_B, expectedRevision: 0 });
    expect(repeated.ok && repeated.match.ended_at).toBe(ended.match.ended_at);
    const { json: afterReconnect } = await joinRoom(code, UID_A);
    expect(afterReconnect.match!.started_at).toBe(started);
    expect(afterReconnect.match!.ended_at).toBe(ended.match.ended_at);
  });

  it("does not infer missing times or rank visibility for an older completed game", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);
    const stub = env.MATCH_ROOM.getByName(code);
    await stub.resign({ side: "gote", uid: UID_B, expectedRevision: 0 });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE match SET started_at = NULL, ended_at = NULL, match_type = 'matchmaking',
           sente_rank = 4, gote_rank = 4, sente_rank_visible = 0, gote_rank_visible = 0 WHERE id = 1`,
      );
    });
    const { json: rejoined } = await joinRoom(code, UID_A);
    expect(rejoined.match!.started_at).toBeNull();
    expect(rejoined.match!.ended_at).toBeNull();
    expect(rejoined.match!.sente_rank_visible).toBe(false);
    expect(rejoined.match!.gote_rank_visible).toBe(false);
    const repeated = await stub.resign({ side: "gote", uid: UID_B, expectedRevision: 0 });
    expect(repeated.ok && repeated.match.ended_at).toBeNull();
  });

  it("returns not_found for an unknown room and invalid codes", async () => {
    const { res } = await joinRoom("ZZZZZZZZZZ", UID_A);
    expect(res.status).toBe(404);
    const bad = await SELF.fetch("https://example.com/api/rooms/ab/join", {
      method: "POST",
      body: JSON.stringify({ uid: UID_A }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects state access without a valid token", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const noToken = await SELF.fetch(`https://example.com/api/rooms/${code}/state`);
    expect(noToken.status).toBe(401);
    const badToken = await getState(code, "not-a-token");
    expect(badToken.res.status).toBe(401);
    // A token for another room is rejected too.
    const { json: other } = await createRoom(UID_C);
    const crossRoom = await getState(code, other.token!);
    expect(crossRoom.res.status).toBe(401);
  });
});

describe("gameplay (HTTP fallback)", () => {
  it("plays moves with revision sync; rejects conflicts, wrong turns and illegal moves", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const senteToken = created.token!;
    const { json: joined } = await joinRoom(code, UID_B);
    const goteToken = joined.token!;

    // Moving before... actually the match has started (gote joined). Sente plays 7g7f.
    const mv = await postMove(code, senteToken, 0, {
      type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5,
    });
    expect(mv.json.ok).toBe(true);
    expect(mv.json.match!.revision).toBe(1);
    expect(mv.json.match!.state.usiMoveHistory).toEqual(["7g7f"]);

    // Stale revision -> conflict with latest match attached.
    const stale = await postMove(code, senteToken, 0, {
      type: "move", fromX: 2, fromY: 5, toX: 2, toY: 4,
    });
    expect(stale.res.status).toBe(409);
    expect(stale.json.error?.code).toBe("revision_conflict");
    expect(stale.json.match!.revision).toBe(1);

    // Not sente's turn.
    const wrongTurn = await postMove(code, senteToken, 1, {
      type: "move", fromX: 2, fromY: 5, toX: 2, toY: 4,
    });
    expect(wrongTurn.res.status).toBe(403);
    expect(wrongTurn.json.error?.code).toBe("not_your_turn");

    // Gote plays an illegal move.
    const illegal = await postMove(code, goteToken, 1, {
      type: "move", fromX: 2, fromY: 2, toX: 2, toY: 5,
    });
    expect(illegal.res.status).toBe(400);
    expect(illegal.json.error?.code).toBe("illegal_move");

    // Gote plays a legal move.
    const mv2 = await postMove(code, goteToken, 1, {
      type: "move", fromX: 6, fromY: 2, toX: 6, toY: 3,
    });
    expect(mv2.json.ok).toBe(true);
    expect(mv2.json.match!.revision).toBe(2);
  });

  it("rejects moves before the opponent joins", async () => {
    const { json: created } = await createRoom();
    const mv = await postMove(created.match!.room_code, created.token!, 0, {
      type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5,
    });
    expect(mv.res.status).toBe(409);
    expect(mv.json.error?.code).toBe("not_started");
  });

  it("handles resign", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/resign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${joined.token!}` },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    const json = (await res.json()) as RoomHttpResult;
    expect(json.ok).toBe(true);
    expect(json.match!.game_over).toBe(true);
    expect(json.match!.winner).toBe("sente");
    expect(json.match!.result_reason).toBe("resign");

    // Participants can still read the final state; the game stays over.
    const after = await getState(code, created.token!);
    expect(after.json.match!.game_over).toBe(true);
  });

  it("saves the final move and its checkmate time in the same result", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);
    const beforeMate = replayUsiMoves(kifu.usi.slice(0, -1));
    expect(beforeMate.ok).toBe(true);
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE match SET state = ? WHERE id = 1", JSON.stringify(beforeMate.state));
    });
    const beforeEnd = Date.now();
    const result = await postMove(code, joined.token!, 0, parseUsiMove(kifu.usi.at(-1)!));
    expect(result.json.ok).toBe(true);
    expect(result.json.match!.result_reason).toBe("checkmate");
    expect(result.json.match!.state.usiMoveHistory).toEqual(kifu.usi);
    expect(Date.parse(result.json.match!.ended_at!)).toBeGreaterThanOrEqual(beforeEnd);
    expect(Date.parse(result.json.match!.ended_at!)).toBeLessThanOrEqual(Date.now());
    const after = await getState(code, created.token!);
    expect(after.json.match!.ended_at).toBe(result.json.match!.ended_at);
  });
});

describe("WebSocket flow", () => {
  async function connectWs(code: string, token: string) {
    const res = await SELF.fetch(
      `https://example.com/api/rooms/${code}/ws?token=${encodeURIComponent(token)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: Array<Record<string, unknown>> = [];
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data !== "pong") {
        messages.push(JSON.parse(event.data));
      }
    });
    return { ws, messages };
  }

  it("pushes initial state, acks moves, and broadcasts to the opponent", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const sente = await connectWs(code, created.token!);
    await waitFor(() => sente.messages.length >= 1);
    expect(sente.messages[0].type).toBe("state");
    expect(sente.messages[0].yourSide).toBe("sente");

    const gote = await connectWs(code, joined.token!);
    await waitFor(() => gote.messages.length >= 1);
    expect(gote.messages[0].yourSide).toBe("gote");

    sente.ws.send(JSON.stringify({
      type: "move",
      reqId: 1,
      expectedRevision: 0,
      move: { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 },
    }));

    await waitFor(() => sente.messages.some((m) => m.type === "ack"));
    const ack = sente.messages.find((m) => m.type === "ack") as {
      reqId: number; ok: boolean; match: MatchPayload;
    };
    expect(ack.reqId).toBe(1);
    expect(ack.ok).toBe(true);
    expect(ack.match.revision).toBe(1);

    // The opponent receives the new state as a push.
    await waitFor(() =>
      gote.messages.some((m) => m.type === "state" && (m.match as MatchPayload).revision === 1),
    );

    // Bad move gets a NACK with the current match attached.
    sente.ws.send(JSON.stringify({
      type: "move",
      reqId: 2,
      expectedRevision: 1,
      move: { type: "move", fromX: 2, fromY: 5, toX: 2, toY: 4 },
    }));
    await waitFor(() => sente.messages.some((m) => m.type === "ack" && m.reqId === 2));
    const nack = sente.messages.find((m) => m.type === "ack" && m.reqId === 2) as {
      ok: boolean; error: { code: string };
    };
    expect(nack.ok).toBe(false);
    expect(nack.error.code).toBe("not_your_turn");

    sente.ws.send(JSON.stringify({ type: "resign", reqId: 3, expectedRevision: 1 }));
    await waitFor(() => sente.messages.some(m => m.type === "ack" && m.reqId === 3));
    const ended = sente.messages.find(m => m.type === "ack" && m.reqId === 3) as {
      ok: boolean; match: MatchPayload;
    };
    expect(ended.ok).toBe(true);
    expect(ended.match.game_over).toBe(true);
    expect(Number.isFinite(Date.parse(ended.match.ended_at!))).toBe(true);
    await waitFor(() => gote.messages.some(m => m.type === "state" && (m.match as MatchPayload).game_over));
    const broadcast = gote.messages.find(m => m.type === "state" && (m.match as MatchPayload).game_over)!;
    expect((broadcast.match as MatchPayload).ended_at).toBe(ended.match.ended_at);
    expect((broadcast.match as MatchPayload).winner).toBe("gote");

    sente.ws.close();
    gote.ws.close();
  });

  it("schedules the disconnect countdown alarm when a socket closes", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const gote = await connectWs(code, joined.token!);
    await waitFor(() => gote.messages.length >= 1);

    const closedAt = Date.now();
    gote.ws.close();
    // Give the DO a moment to run webSocketClose.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stub = env.MATCH_ROOM.getByName(code);
    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    // The next alarm must be the +15s countdown push for the closed side,
    // not the 60s safety tick (regression: the closing socket still appears
    // in getWebSockets() while webSocketClose runs).
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(closedAt + 10_000);
    expect(alarm!).toBeLessThan(closedAt + 20_000);
  });

  it("rejects a WebSocket upgrade with an invalid token", async () => {
    const { json: created } = await createRoom();
    const res = await SELF.fetch(
      `https://example.com/api/rooms/${created.match!.room_code}/ws?token=bad`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(401);
  });
});

describe("per-player limits (設計書 §18)", () => {
  type TestSocket = {
    ws: WebSocket;
    messages: Array<Record<string, unknown>>;
    pongs: number;
    closeCode: number | null;
  };

  function wsUrl(code: string, token: string) {
    return `https://example.com/api/rooms/${code}/ws?token=${encodeURIComponent(token)}`;
  }

  // answerClose: false plays a modified client that ignores the server's close and keeps sending.
  async function openSocket(code: string, token: string, { answerClose = true } = {}): Promise<TestSocket> {
    const res = await SELF.fetch(wsUrl(code, token), { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const socket: TestSocket = { ws: res.webSocket!, messages: [], pongs: 0, closeCode: null };
    socket.ws.accept();
    socket.ws.addEventListener("message", (event) => {
      if (event.data === "pong") socket.pongs += 1;
      else if (typeof event.data === "string") socket.messages.push(JSON.parse(event.data));
    });
    socket.ws.addEventListener("close", (event) => {
      socket.closeCode = event.code;
      if (!answerClose) return;
      // Answer a server-side close: the test workerd runs an old compatibility date that does
      // not do it automatically, and a half-closed socket keeps the room alive past the test.
      try {
        socket.ws.close();
      } catch {
        // already closed
      }
    });
    return socket;
  }

  function closeQuietly(socket: TestSocket) {
    try {
      socket.ws.close();
    } catch {
      // already closed
    }
  }

  // Each join gets its own IP so these tests never trip the per-IP join limit.
  async function joinFrom(code: string, uid: string) {
    nextTestIp += 1;
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: "POST",
      headers: { "CF-Connecting-IP": `10.8.${Math.floor(nextTestIp / 256)}.${nextTestIp % 256}` },
      body: JSON.stringify({ uid }),
    });
    const json = (await res.json()) as RoomHttpResult;
    return { res, json };
  }

  // The creator moves from sente to gote before anyone joins; their first token still names sente.
  async function changeSeatToGote(code: string, token: string) {
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ side: "gote" }),
    });
    const json = (await res.json()) as RoomHttpResult;
    expect(json.yourSide).toBe("gote");
    return json.token!;
  }

  const errorCount = (socket: TestSocket) => socket.messages.filter((m) => m.type === "error").length;

  // One request short of the forfeit, so a test sends only the request it is about. Hundreds of
  // real requests crowd the test runtime and could spill out of the 10-second window.
  async function bringToForfeitEdge(code: string, uid: string) {
    await runInDurableObject(env.MATCH_ROOM.getByName(code), (instance) => {
      const counts = (instance as unknown as {
        requestCounts: Map<string, { windowStart: number; count: number }>;
      }).requestCounts;
      counts.set(uid, { windowStart: Date.now(), count: MAX_REQUESTS_PER_WINDOW + FLOOD_FORFEIT_EXCESS - 1 });
    });
  }

  it("refuses a fifth live socket for one seat, and closes silent ones to make room", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const sockets: TestSocket[] = [];
    for (let i = 0; i < 4; i++) sockets.push(await openSocket(code, created.token!));

    const fifth = await SELF.fetch(wsUrl(code, created.token!), { headers: { Upgrade: "websocket" } });
    expect(fifth.status).toBe(429);
    await fifth.text();

    // Test sockets never ping, so their open time is all the room knows: age them past the limit.
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...att, openedAt: Date.now() - 20_000 });
      }
    });
    const fresh = await openSocket(code, created.token!);
    await waitFor(() => fresh.messages.length >= 1);
    await waitFor(() => sockets.every((s) => s.closeCode !== null));
    expect(fresh.closeCode).toBeNull();
    fresh.ws.close();
  });

  it("keeps and counts sockets that keep pinging, however long ago they opened", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const sockets: TestSocket[] = [];
    for (let i = 0; i < 4; i++) sockets.push(await openSocket(code, created.token!));
    for (const s of sockets) s.ws.send("ping");
    await waitFor(() => sockets.every((s) => s.pongs >= 1));

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...att, openedAt: Date.now() - 20_000 });
      }
    });
    const fifth = await SELF.fetch(wsUrl(code, created.token!), { headers: { Upgrade: "websocket" } });
    expect(fifth.status).toBe(429);
    await fifth.text();
    expect(sockets.every((s) => s.closeCode === null)).toBe(true);
    for (const s of sockets) s.ws.close();
  });

  it("closes a socket that sends too many messages, ignores what it keeps sending, and still answers the opponent", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinFrom(code, UID_B);
    const sente = await openSocket(code, created.token!, { answerClose: false });
    const gote = await openSocket(code, joined.token!);
    await waitFor(() => sente.messages.length >= 1 && gote.messages.length >= 1);

    for (let i = 0; i < 80; i++) sente.ws.send(JSON.stringify({ type: "probe" }));
    await waitFor(() => sente.closeCode !== null);
    expect(sente.closeCode).toBe(1008);
    const answered = errorCount(sente);
    expect(answered).toBeGreaterThan(50);
    expect(answered).toBeLessThanOrEqual(60);

    // A modified client that ignores the close keeps sending: none of it is answered.
    for (let i = 0; i < 20; i++) sente.ws.send(JSON.stringify({ type: "probe" }));
    gote.ws.send(JSON.stringify({ type: "probe" }));
    await waitFor(() => errorCount(gote) === 1);
    expect(errorCount(sente)).toBe(answered);
    // Going this far past the limit is not yet enough to lose the game.
    expect((await getState(code, joined.token!)).json.match!.game_over).toBe(false);
    closeQuietly(sente);
    gote.ws.close();
  });

  it("ignores a socket closed by a seat change, so it cannot move or resign for the new occupant", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const old = await openSocket(code, created.token!, { answerClose: false });
    await waitFor(() => old.messages.length >= 1);
    await changeSeatToGote(code, created.token!);
    await waitFor(() => old.closeCode !== null);
    expect(old.closeCode).toBe(4001);
    const { json: guest } = await joinFrom(code, UID_B);
    expect(guest.yourSide).toBe("sente");

    // The old socket still carries the sente seat it opened with.
    old.ws.send(JSON.stringify({
      type: "move",
      reqId: 1,
      expectedRevision: guest.match!.revision,
      move: { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 },
    }));
    old.ws.send(JSON.stringify({ type: "resign", reqId: 2, expectedRevision: null }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await getState(code, guest.token!);
    expect(after.json.match!.game_over).toBe(false);
    expect(after.json.match!.state.moveCount).toBe(0);
    expect(old.messages.some((m) => m.type === "ack")).toBe(false);
    closeQuietly(old);
  });

  it("keeps ignoring a socket it closed, even once that seat is the sender's again", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const old = await openSocket(code, created.token!, { answerClose: false });
    await waitFor(() => old.messages.length >= 1);
    const goteToken = await changeSeatToGote(code, created.token!);
    await waitFor(() => old.closeCode !== null);
    // Back to sente: the old socket's seat and uid match the room again, so only the
    // closed-socket check stands between its resign and the room.
    const back = await SELF.fetch(`https://example.com/api/rooms/${code}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${goteToken}` },
      body: JSON.stringify({ side: "sente" }),
    });
    const backJson = (await back.json()) as RoomHttpResult;
    expect(backJson.yourSide).toBe("sente");

    old.ws.send(JSON.stringify({ type: "resign", reqId: 1, expectedRevision: null }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await getState(code, backJson.token!)).json.match!.game_over).toBe(false);
    closeQuietly(old);
  });

  it("forfeits a player who keeps sending far past the limit, as a disconnect loss", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinFrom(code, UID_B);
    const sente = await openSocket(code, created.token!, { answerClose: false });
    const gote = await openSocket(code, joined.token!);
    await waitFor(() => sente.messages.length >= 1 && gote.messages.length >= 1);

    // Most of these land after the room has closed the socket: a client that ignores the close.
    for (let i = 0; i < 400; i++) sente.ws.send(JSON.stringify({ type: "probe" }));
    const isOver = (m: Record<string, unknown>) => m.type === "state" && (m.match as MatchPayload).game_over;
    await waitFor(() => gote.messages.some(isOver));
    const end = gote.messages.find(isOver)!.match as MatchPayload;
    expect(end.winner).toBe("gote");
    expect(end.result_reason).toBe("disconnect");
    expect(end.disconnect_side).toBe("sente");
    // Let the room work through the rest of the flood before the test ends.
    gote.ws.send(JSON.stringify({ type: "probe" }));
    await waitFor(() => errorCount(gote) === 1);
    closeQuietly(sente);
    gote.ws.close();
  });

  it("counts refused connection attempts toward the forfeit too", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinFrom(code, UID_B);
    // Four live sockets, so the attempt below is one the seat limit would refuse anyway.
    const sockets: TestSocket[] = [];
    for (let i = 0; i < 4; i++) sockets.push(await openSocket(code, created.token!));

    await bringToForfeitEdge(code, UID_A);
    const attempt = await SELF.fetch(wsUrl(code, created.token!), { headers: { Upgrade: "websocket" } });
    expect(attempt.status).toBe(429);
    await attempt.text();
    const end = (await getState(code, joined.token!)).json.match!;
    expect(end.game_over).toBe(true);
    expect(end.winner).toBe("gote");
    expect(end.result_reason).toBe("disconnect");
    for (const s of sockets) s.ws.close();
  });

  it("leaves a finished game alone, however much either player sends afterwards", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    await joinFrom(code, UID_B);
    const stub = env.MATCH_ROOM.getByName(code);
    const resigned = await stub.resign({ side: "gote", uid: UID_B, expectedRevision: null });
    expect(resigned.ok && resigned.match.result_reason).toBe("resign");

    for (const [side, uid] of [["sente", UID_A], ["gote", UID_B]] as const) {
      await bringToForfeitEdge(code, uid);
      const reply = await stub.getStateFor({ side, uid });
      expect(reply.ok).toBe(false);
    }
    const end = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ winner: string; result_reason: string }>(
        "SELECT winner, result_reason FROM match WHERE id = 1",
      ).one(),
    );
    expect(end).toEqual({ winner: "sente", result_reason: "resign" });
  });

  it("forfeits for a state request past the cutoff too, but never before the match starts", async () => {
    const { json: waiting } = await createRoom();
    await bringToForfeitEdge(waiting.match!.room_code, UID_A);
    expect((await getState(waiting.match!.room_code, waiting.token!)).res.status).toBe(429);
    const stillWaiting = await env.MATCH_ROOM.getByName(waiting.match!.room_code).getPublicInfo();
    expect(stillWaiting.ok && stillWaiting.room.game_over).toBe(false);

    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinFrom(code, UID_B);
    await bringToForfeitEdge(code, UID_A);
    expect((await getState(code, created.token!)).res.status).toBe(429);
    const end = (await getState(code, joined.token!)).json.match!;
    expect(end.game_over).toBe(true);
    expect(end.winner).toBe("gote");
    expect(end.result_reason).toBe("disconnect");
  });

  it("refuses moves and resignations sent with the token from before a seat change", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    await changeSeatToGote(code, created.token!);
    const { json: guest } = await joinFrom(code, UID_B);
    expect(guest.yourSide).toBe("sente");

    // The old token still names the sente seat, which now belongs to the guest.
    const move = await postMove(code, created.token!, guest.match!.revision, {
      type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5,
    });
    expect(move.res.status).toBe(403);
    expect(move.json.error?.code).toBe("forbidden");
    const resign = await SELF.fetch(`https://example.com/api/rooms/${code}/resign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({}),
    });
    expect(resign.status).toBe(403);
    await resign.text();

    const after = await getState(code, guest.token!);
    expect(after.json.match!.game_over).toBe(false);
    expect(after.json.match!.state.moveCount).toBe(0);
  });

  it("checks the seat owner for moves and resignations from an open socket too", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    await joinFrom(code, UID_B);
    const sente = await openSocket(code, created.token!);
    await waitFor(() => sente.messages.length >= 1);
    // Make the socket's remembered uid disagree with the seat without closing it,
    // so the closed-socket check cannot be what stops these.
    await runInDurableObject(env.MATCH_ROOM.getByName(code), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...att, uid: UID_C });
      }
    });

    const revision = (sente.messages[0].match as MatchPayload).revision;
    sente.ws.send(JSON.stringify({
      type: "move",
      reqId: 1,
      expectedRevision: revision,
      move: { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 },
    }));
    sente.ws.send(JSON.stringify({ type: "resign", reqId: 2, expectedRevision: null }));
    await waitFor(() => sente.messages.filter((m) => m.type === "ack").length === 2);
    const codes = sente.messages
      .filter((m) => m.type === "ack")
      .map((m) => (m.error as { code: string } | undefined)?.code);
    expect(codes).toEqual(["forbidden", "forbidden"]);
    sente.ws.close();
  });

  it("limits HTTP requests per player: polling and moves, then a rejoin, but not the opponent", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinFrom(code, UID_B);

    let limitedAt = -1;
    for (let i = 0; i < 70; i++) {
      const { res, json } = i % 2 === 0
        ? await getState(code, created.token!)
        : await postMove(code, created.token!, 999, { type: "move", fromX: 0, fromY: 0, toX: 0, toY: 1 });
      if (res.status === 429) {
        expect(json.error?.code).toBe("rate_limited");
        limitedAt = i;
        break;
      }
      expect(res.status).toBe(i % 2 === 0 ? 200 : 409);
    }
    expect(limitedAt).toBe(60);

    expect((await joinFrom(code, UID_A)).res.status).toBe(429);
    expect((await getState(code, joined.token!)).res.status).toBe(200);
  });

  it("answers null and other non-object messages as unreadable", async () => {
    const { json: created } = await createRoom();
    const sente = await openSocket(created.match!.room_code, created.token!);
    await waitFor(() => sente.messages.length >= 1);
    for (const raw of ["null", "[]", "1"]) sente.ws.send(raw);
    await waitFor(() => errorCount(sente) === 3);
    const codes = sente.messages
      .filter((m) => m.type === "error")
      .map((m) => (m.error as { code: string }).code);
    expect(codes).toEqual(["bad_json", "bad_json", "bad_json"]);
    expect(sente.closeCode).toBeNull();
    sente.ws.close();
  });
});

describe("disconnect handling (alarm)", () => {
  it("forfeits a player who stays disconnected past the grace period", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    // Simulate: sente was last seen 70s ago (grace is 60s), gote is fresh.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET last_seen_sente = ?, last_seen_gote = ? WHERE id = 1",
        Date.now() - 70_000,
        Date.now(),
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const after = await getState(code, joined.token!);
    expect(after.json.match!.game_over).toBe(true);
    expect(after.json.match!.winner).toBe("gote");
    expect(after.json.match!.result_reason).toBe("disconnect");
    expect(Number.isFinite(Date.parse(after.json.match!.ended_at!))).toBe(true);
    expect(after.json.match!.disconnect_side).toBe("sente");
    // Finalization bumps the revision so clients pick it up.
    expect(after.json.match!.revision).toBe(1);
  });

  it("declares a draw when both players disconnect", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET last_seen_sente = ?, last_seen_gote = ? WHERE id = 1",
        Date.now() - 90_000,
        Date.now() - 70_000,
      );
    });
    await runDurableObjectAlarm(stub);

    const after = await getState(code, joined.token!);
    expect(after.json.match!.game_over).toBe(true);
    expect(after.json.match!.winner).toBe("draw");
    expect(after.json.match!.result_reason).toBe("disconnect");
  });

  it("does not forfeit before the match starts", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET last_seen_sente = ? WHERE id = 1",
        Date.now() - 90_000,
      );
    });
    await runDurableObjectAlarm(stub);
    const after = await getState(code, created.token!);
    expect(after.json.match!.game_over).toBe(false);
  });
});

describe("24h self-deletion (alarm)", () => {
  it("wipes all storage once the room expires", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET expires_at = ? WHERE id = 1",
        Date.now() - 1000,
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Everything is gone: requests act like the room never existed.
    const after = await getState(code, created.token!);
    expect(after.res.status).toBe(404);
    expect(after.json.error?.code).toBe("not_found");

    const rejoin = await joinRoom(code, UID_B);
    expect(rejoin.res.status).toBe(404);

    // No alarm remains.
    const ranAgain = await runDurableObjectAlarm(stub);
    expect(ranAgain).toBe(false);
  });

  it("treats an expired-but-not-yet-wiped room as gone", async () => {
    const { json: created } = await createRoom();
    const code = created.match!.room_code;
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET expires_at = ? WHERE id = 1",
        Date.now() - 1000,
      );
    });
    const state = await getState(code, created.token!);
    expect(state.res.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("limits room creation per IP", async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ uid: UID_A }),
      });
      if (res.status === 429) {
        limited = true;
        const json = (await res.json()) as RoomHttpResult;
        expect(json.error?.code).toBe("rate_limited");
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("limits join attempts per IP (unauthenticated DO amplification guard)", async () => {
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const res = await SELF.fetch("https://example.com/api/rooms/ZZZZZZZZZZ/join", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.8" },
        body: JSON.stringify({ uid: UID_A }),
      });
      if (res.status === 429) {
        limited = true;
        const json = (await res.json()) as RoomHttpResult;
        expect(json.error?.code).toBe("rate_limited");
        break;
      }
      expect(res.status).toBe(404); // unknown room until the limiter kicks in
    }
    expect(limited).toBe(true);
  });

  it("limits invitation lookups per IP (same guard as join)", async () => {
    let limited = false;
    for (let i = 0; i < 65; i++) {
      const res = await SELF.fetch("https://example.com/api/rooms/ZZZZZZZZZZ/info", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      });
      if (res.status === 429) {
        limited = true;
        const json = (await res.json()) as RoomHttpResult;
        expect(json.error?.code).toBe("rate_limited");
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(limited).toBe(true);
  });
});
