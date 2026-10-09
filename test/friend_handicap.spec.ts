// SPDX-License-Identifier: GPL-3.0-only

import { env, SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MatchRoom } from "../src/worker/match_room";
import type { MatchPayload, PublicRoomInfo } from "../src/worker/protocol";

const HOST = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";
const GUEST = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb";

type Result = {
  ok: boolean;
  match?: MatchPayload;
  room?: PublicRoomInfo;
  token?: string;
  yourSide?: "sente" | "gote";
  error?: { code: string };
};

let requestNumber = 0;
async function request(path: string, body?: Record<string, unknown>, token?: string) {
  requestNumber += 1;
  const headers: Record<string, string> = {
    "CF-Connecting-IP": `10.7.${Math.floor(requestNumber / 256)}.${requestNumber % 256}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await SELF.fetch(`https://example.com/api/rooms${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, json: await response.json() as Result };
}

async function create(body: Record<string, unknown>) {
  const { json } = await request("", { uid: HOST, ...body });
  expect(json.ok).toBe(true);
  return json;
}

const SENTE_MOVE = { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 };
const GOTE_MOVE = { type: "move", fromX: 2, fromY: 2, toX: 2, toY: 3 };

describe("friend handicaps", () => {
  // 駒落ちは駒を減らす人（上手）が後手の席に着き、先に指す。招待した人の先手・後手の希望は平手でだけ使う
  it.each([
    ["sente", "host", "gote"],
    ["sente", "guest", "sente"],
    ["gote", "host", "gote"],
    ["gote", "guest", "sente"],
  ] as const)("%s host / %s handicap seats the host as %s, removes only gote pieces and lets gote begin", async (side, handicapBy, hostSide) => {
    const first = "gote";
    const created = await create({ side, handicap: "six", handicap_by: handicapBy });
    const code = created.match!.room_code;
    const initial = { handicap: "six", handicapSide: first, firstPlayer: first };
    expect(created.yourSide).toBe(hostSide);
    expect(created.match!.initial_position).toEqual(initial);
    expect(created.match!.state.currentPlayer).toBe(first);
    const pieces = created.match!.state.board.flat().filter((piece) => piece !== null);
    expect(pieces.filter((piece) => piece.owner === first)).toHaveLength(14);
    expect(pieces.filter((piece) => piece.owner !== first)).toHaveLength(20);
    expect(Object.values(created.match!.state.capturedPieces).flatMap(Object.values).every((n) => n === 0)).toBe(true);

    // Reading conditions is public and never claims the guest seat.
    const info = await request(`/${code}/info`);
    expect(info.response.status).toBe(200);
    expect(info.json.room).toMatchObject({ initial_position: initial, handicap_by: handicapBy, host_side: hostSide, joinable: true });
    expect(JSON.stringify(info.json)).not.toContain(HOST);
    expect(JSON.stringify(info.json)).not.toContain("state");
    const waiting = await request(`/${code}/state`, undefined, created.token);
    expect(waiting.json.match!.started_at).toBeNull();

    const joined = await request(`/${code}/join`, { uid: GUEST });
    const firstToken = first === hostSide ? created.token : joined.json.token;
    const otherToken = first === hostSide ? joined.json.token : created.token;
    expect(joined.json.match!.initial_position).toEqual(initial);
    const wrongTurn = await request(`/${code}/move`, { expectedRevision: 0, move: first === "gote" ? SENTE_MOVE : GOTE_MOVE }, otherToken);
    expect(wrongTurn.response.status).toBe(403);
    expect(wrongTurn.json.error?.code).toBe("not_your_turn");
    const moved = await request(`/${code}/move`, { expectedRevision: 0, move: first === "gote" ? GOTE_MOVE : SENTE_MOVE }, firstToken);
    expect(moved.json.ok).toBe(true);
    expect(moved.json.match!.state.usiMoveHistory).toEqual([first === "gote" ? "7c7d" : "7g7f"]);
    expect(moved.json.match!.initial_position).toEqual(initial);
  });

  it.each([
    ["none", 40], ["lance", 39], ["bishop", 39], ["rook", 39], ["rook-lance", 38],
    ["two", 38], ["four", 36], ["six", 34], ["eight", 32], ["ten", 30],
  ])("accepts %s with %i pieces on the board", async (handicap, count) => {
    const created = await create({ handicap, handicap_by: "guest" });
    expect(created.match!.state.board.flat().filter(Boolean)).toHaveLength(count);
  });

  it.each([
    { handicap: "five", handicap_by: "host" },
    { handicap: "rook", handicap_by: "both" },
    { handicap: ["six"], handicap_by: "guest" },
    { handicap: null },
  ])("rejects invalid handicap input %j on create and update", async (bad) => {
    const rejected = await request("", { uid: HOST, ...bad });
    expect(rejected.response.status).toBe(400);
    expect(rejected.json.error?.code).toBe("bad_handicap");
    const created = await create({});
    const updated = await request(`/${created.match!.room_code}/settings`, bad, created.token);
    expect(updated.response.status).toBe(400);
    expect(updated.json.error?.code).toBe("bad_handicap");
  });

  it("changes the handicap before joining, keeps it through seat changes, and locks it at join", async () => {
    const created = await create({ handicap: "rook", handicap_by: "guest" });
    const code = created.match!.room_code;
    const updated = await request(`/${code}/settings`, { side: "gote", handicap: "ten", handicap_by: "host", tc: { type: "total", seconds: 300 } }, created.token);
    expect(updated.json.ok).toBe(true);
    expect(updated.json.yourSide).toBe("gote");
    expect(updated.json.match!.state.currentPlayer).toBe("gote");
    expect(updated.json.match!.state.board.flat().filter(Boolean)).toHaveLength(30);
    expect(updated.json.match!.revision).toBe(1);
    const tcOnly = await request(`/${code}/settings`, { side: "gote", tc: { type: "per_move", seconds: 30 } }, updated.json.token);
    expect(tcOnly.json.match!.initial_position).toEqual(updated.json.match!.initial_position);
    expect(tcOnly.json.match!.revision).toBe(2);
    await request(`/${code}/join`, { uid: GUEST });
    const locked = await request(`/${code}/settings`, { side: "gote", handicap: "none" }, tcOnly.json.token);
    expect(locked.response.status).toBe(409);
    expect(locked.json.error?.code).toBe("match_started");
    const full = await request(`/${code}/info`);
    expect(full.json.room!.joinable).toBe(false);
  });

  it("requires the guest to review conditions again when the creator changed them", async () => {
    const created = await create({ handicap: "rook", handicap_by: "host" });
    const code = created.match!.room_code;
    const preview = await request(`/${code}/info`);
    await request(`/${code}/settings`, { handicap: "six", handicap_by: "guest" }, created.token);
    const stale = await request(`/${code}/join`, { uid: GUEST, expectedRevision: preview.json.room!.revision });
    expect(stale.response.status).toBe(409);
    expect(stale.json.error?.code).toBe("join_conflict");
    const latest = await request(`/${code}/info`);
    expect(latest.json.room).toMatchObject({ joinable: true, handicap: "six", handicap_by: "guest" });
    const joined = await request(`/${code}/join`, { uid: GUEST, expectedRevision: latest.json.room!.revision });
    expect(joined.json.ok).toBe(true);
  });

  it("recognizes only already seated players for invitation-link reconnection without exposing their identities", async () => {
    const created = await create({ side: "gote", handicap: "rook", handicap_by: "host", displayName: "hostName" });
    const code = created.match!.room_code;
    const waitingHost = await request(`/${code}/info?uid=${HOST}`);
    expect(waitingHost.json.room).toMatchObject({ rejoining: true, joinable: true });
    const waitingGuest = await request(`/${code}/info?uid=${GUEST}`);
    expect(waitingGuest.json.room!.rejoining).toBe(false);
    for (const suffix of ["", "?uid=", "?uid=invalid!", "?uid=cccccccc-5555-4555-8555-cccccccccccc"]) {
      const info = await request(`/${code}/info${suffix}`);
      expect(info.response.status).toBe(200);
      expect(info.json.room!.rejoining).toBe(false);
    }
    await request(`/${code}/join`, { uid: GUEST, displayName: "guestName" });
    for (const uid of [HOST, GUEST]) {
      const info = await request(`/${code}/info?uid=${uid}`);
      expect(info.json.room).toMatchObject({ rejoining: true, joinable: false });
      expect(JSON.stringify(info.json)).not.toContain(HOST);
      expect(JSON.stringify(info.json)).not.toContain(GUEST);
      expect(JSON.stringify(info.json)).not.toContain("hostName");
      expect(JSON.stringify(info.json)).not.toContain("guestName");
    }
    // Finished games can also be restored by their existing players.
    await env.MATCH_ROOM.getByName(code).resign({ side: "gote", uid: HOST, expectedRevision: 0 });
    const ended = await request(`/${code}/info?uid=${GUEST}`);
    expect(ended.json.room).toMatchObject({ rejoining: true, joinable: false, game_over: true });
  });

  it.each(["host", "guest"])("ignores a random seat for the %s handicap and seats the handicap giver as gote", async (handicapBy) => {
    const created = await create({ side: "random", handicap: "rook", handicap_by: handicapBy });
    expect(created.yourSide).toBe(handicapBy === "host" ? "gote" : "sente");
    expect(created.match!.initial_position.handicapSide).toBe("gote");
    expect(created.match!.state.currentPlayer).toBe("gote");
  });

  it("reloads persisted conditions and position after reconnecting by HTTP and WebSocket", async () => {
    const created = await create({ side: "gote", handicap: "rook", handicap_by: "host" });
    const code = created.match!.room_code;
    await request(`/${code}/join`, { uid: GUEST });
    const moved = await request(`/${code}/move`, { expectedRevision: 0, move: GOTE_MOVE }, created.token);
    const stub = env.MATCH_ROOM.getByName(code);
    const reloaded = await runInDurableObject(stub, async (_instance, ctx) => {
      // Recreate the class on its existing SQLite context; no in-memory state survives.
      const fresh = new MatchRoom(ctx, env);
      return fresh.getStateFor({ side: "gote", uid: HOST });
    });
    expect(reloaded.ok && reloaded.match.initial_position).toEqual(moved.json.match!.initial_position);
    expect(reloaded.ok && reloaded.match.state).toEqual(moved.json.match!.state);
    const rejoined = await request(`/${code}/join`, { uid: HOST });
    expect(rejoined.json.match!.initial_position).toEqual(created.match!.initial_position);
    const response = await SELF.fetch(`https://example.com/api/rooms/${code}/ws?token=${encodeURIComponent(rejoined.json.token!)}`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const initial = new Promise<MatchPayload>((resolve) => {
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data as string);
        if (message.type === "state") resolve(message.match);
      }, { once: true });
    });
    ws.accept();
    expect((await initial).initial_position).toEqual(created.match!.initial_position);
    ws.close();
  });

  it("reads older rows without handicap columns as a standard initial position", async () => {
    const created = await create({ side: "gote" });
    const code = created.match!.room_code;
    await runInDurableObject(env.MATCH_ROOM.getByName(code), async (_instance, ctx) => {
      ctx.storage.sql.exec("ALTER TABLE match DROP COLUMN initial_position");
      ctx.storage.sql.exec("ALTER TABLE match DROP COLUMN host_side");
      const fresh = new MatchRoom(ctx, env);
      const result = await fresh.getStateFor({ side: "gote", uid: HOST });
      expect(result.ok && result.match.initial_position).toEqual({ handicap: "none", handicapSide: "gote", firstPlayer: "sente" });
      expect(result.ok && result.match.state.currentPlayer).toBe("sente");
    });
  });

  it.each([["total", 180], ["per_move", 10]] as const)("starts the gote handicap clock first in %s mode and flags gote rather than sente", async (tcType, seconds) => {
    const before = Date.now();
    const created = await create({ side: "sente", handicap: "six", handicap_by: "guest", tc: { type: tcType, seconds } });
    const code = created.match!.room_code;
    const joined = await request(`/${code}/join`, { uid: GUEST });
    const match = joined.json.match!;
    expect(match.state.currentPlayer).toBe("gote");
    expect(Date.parse(match.turn_deadline!)).toBeGreaterThan(before + (seconds + 4) * 1000);
    const first = await request(`/${code}/move`, { expectedRevision: 0, move: GOTE_MOVE }, joined.json.token);
    expect(first.json.match!.gote_time_ms).toBe(tcType === "total" ? seconds * 1000 : null); // the start buffer is free
    await request(`/${code}/move`, { expectedRevision: 1, move: SENTE_MOVE }, created.token);
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE match SET turn_started_at = ?, turn_deadline = ? WHERE id = 1", Date.now() - (seconds + 2) * 1000, Date.now() - 2_000);
    });
    await runDurableObjectAlarm(stub);
    const after = await request(`/${code}/state`, undefined, created.token);
    expect(after.json.match!).toMatchObject({ game_over: true, winner: "sente", result_reason: "timeout", gote_time_ms: tcType === "total" ? 0 : null });
  });

  it("matchmaking remains a standard game with 30 seconds per move regardless of supplied handicap", async () => {
    const stub = env.MATCH_ROOM.getByName("HANDICAP22");
    const created = await stub.createRoom({ roomCode: "HANDICAP22", uid: HOST, displayName: null, sidePref: "gote", tcType: "total", tcSeconds: 180, matchType: "matchmaking", handicap: "ten", handicapBy: "host" });
    expect(created.ok && created.match).toMatchObject({ initial_position: { handicap: "none", firstPlayer: "sente" }, tc_type: "per_move", tc_seconds: 30 });
    expect(created.ok && created.match.state.board.flat().filter(Boolean)).toHaveLength(40);
    const edited = await stub.updateSettings({ uid: HOST, sidePref: "gote", tcType: "none", tcSeconds: 0, handicap: "six", handicapBy: "host" });
    expect(edited.ok).toBe(false);
  });
});
