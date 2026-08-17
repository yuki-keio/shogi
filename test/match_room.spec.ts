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
});
