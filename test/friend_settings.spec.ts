// SPDX-License-Identifier: GPL-3.0-only

// Friend-match settings tests: creator side selection (sente/gote/random),
// pre-join settings updates (seat move + token re-issue + WS force-close),
// and server-authoritative time control (per-move / total) with flag fall.

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

type RoomHttpResult = {
  ok: boolean;
  match?: MatchPayload;
  yourSide?: "sente" | "gote";
  token?: string;
  disconnect?: { side: string | null; deadline: string | null };
  error?: { code: string; message: string };
};

// Distinct per-create IPs (10.8.x.x, away from match_room.spec.ts's 10.9.x.x)
// so tests never trip the per-IP create rate limit.
let nextTestIp = 1;

async function createRoom(body: Record<string, unknown> = {}) {
  nextTestIp += 1;
  const res = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": `10.8.${Math.floor(nextTestIp / 256)}.${nextTestIp % 256}`,
    },
    body: JSON.stringify({ uid: UID_A, ...body }),
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

async function postSettings(code: string, token: string, body: Record<string, unknown>) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RoomHttpResult;
  return { res, json };
}

async function postMove(code: string, token: string, expectedRevision: number, move: unknown) {
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

const MOVE_7G7F = { type: "move", fromX: 2, fromY: 6, toX: 2, toY: 5 };

describe("creator side selection", () => {
  it("creator can take gote; the joiner fills the sente seat and moves first", async () => {
    const { json: created } = await createRoom({ side: "gote" });
    expect(created.ok).toBe(true);
    expect(created.yourSide).toBe("gote");
    expect(created.match!.sente_joined).toBe(false);
    expect(created.match!.gote_joined).toBe(true);
    expect(created.match!.side_pref).toBe("gote");
    const code = created.match!.room_code;

    const { json: joined } = await joinRoom(code, UID_B);
    expect(joined.ok).toBe(true);
    expect(joined.yourSide).toBe("sente");
    expect(joined.match!.sente_joined).toBe(true);

    // Rejoin keeps seats on both sides.
    const { json: rejoinA } = await joinRoom(code, UID_A);
    expect(rejoinA.yourSide).toBe("gote");
    const { json: rejoinB } = await joinRoom(code, UID_B);
    expect(rejoinB.yourSide).toBe("sente");

    // The joiner holds sente and plays the first move.
    const mv = await postMove(code, joined.token!, 0, MOVE_7G7F);
    expect(mv.json.ok).toBe(true);
    expect(mv.json.match!.state.usiMoveHistory).toEqual(["7g7f"]);
  });

  it("random resolves to exactly one occupied seat and preserves the pref", async () => {
    const { json: created } = await createRoom({ side: "random" });
    expect(created.ok).toBe(true);
    expect(["sente", "gote"]).toContain(created.yourSide);
    expect(created.match!.side_pref).toBe("random");
    const seatFlags = [created.match!.sente_joined, created.match!.gote_joined];
    expect(seatFlags.filter(Boolean)).toHaveLength(1);
    expect(created.match!.sente_joined).toBe(created.yourSide === "sente");
  });

  it("an unknown side value falls back to sente (old-client compat)", async () => {
    const { json: created } = await createRoom({ side: "diagonal" });
    expect(created.ok).toBe(true);
    expect(created.yourSide).toBe("sente");
  });
});

describe("pre-join settings updates", () => {
  it("moves the creator's seat, re-issues the token, and invalidates the old one", async () => {
    const { json: created } = await createRoom({});
    const code = created.match!.room_code;
    expect(created.yourSide).toBe("sente");

    // Time-control-only change: seat (and token side) unchanged.
    const tcOnly = await postSettings(code, created.token!, {
      side: "sente",
      tc: { type: "per_move", seconds: 30 },
    });
    expect(tcOnly.json.ok).toBe(true);
    expect(tcOnly.json.yourSide).toBe("sente");
    expect(tcOnly.json.match!.tc_type).toBe("per_move");
    expect(tcOnly.json.match!.tc_seconds).toBe(30);

    // Seat flip to gote.
    const flipped = await postSettings(code, tcOnly.json.token!, {
      side: "gote",
      tc: { type: "total", seconds: 300 },
    });
    expect(flipped.json.ok).toBe(true);
    expect(flipped.json.yourSide).toBe("gote");
    expect(flipped.json.token).toBeTruthy();
    expect(flipped.json.match!.side_pref).toBe("gote");
    expect(flipped.json.match!.sente_joined).toBe(false);
    expect(flipped.json.match!.gote_joined).toBe(true);
    expect(flipped.json.match!.tc_type).toBe("total");
    expect(flipped.json.match!.tc_seconds).toBe(300);

    // The pre-flip token binds the now-vacant sente seat -> rejected.
    const stale = await getState(code, created.token!);
    expect(stale.res.status).toBe(403);
    // The re-issued token works.
    const fresh = await getState(code, flipped.json.token!);
    expect(fresh.res.status).toBe(200);
    expect(fresh.json.ok).toBe(true);
  });

  it("locks settings once the opponent joins", async () => {
    const { json: created } = await createRoom({});
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);

    const locked = await postSettings(code, created.token!, {
      side: "gote",
      tc: { type: "none" },
    });
    expect(locked.res.status).toBe(409);
    expect(locked.json.error?.code).toBe("match_started");
  });

  it("rejects foreign tokens and off-whitelist time controls", async () => {
    const { json: created } = await createRoom({});
    const code = created.match!.room_code;

    const { json: other } = await createRoom({});
    const foreign = await postSettings(code, other.token!, { side: "sente", tc: { type: "none" } });
    expect(foreign.res.status).toBe(401);

    const badTc = await postSettings(code, created.token!, {
      side: "sente",
      tc: { type: "per_move", seconds: 7 },
    });
    expect(badTc.res.status).toBe(400);
    expect(badTc.json.error?.code).toBe("bad_time_control");

    const badCreate = await createRoom({ tc: { type: "total", seconds: 1 } });
    expect(badCreate.res.status).toBe(400);
    expect(badCreate.json.error?.code).toBe("bad_time_control");
  });

  it("force-closes room sockets with 4001 when the seat moves", async () => {
    const { json: created } = await createRoom({});
    const code = created.match!.room_code;

    const res = await SELF.fetch(
      `https://example.com/api/rooms/${code}/ws?token=${encodeURIComponent(created.token!)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closes: Array<{ code: number; reason: string }> = [];
    ws.accept();
    ws.addEventListener("close", (event) => {
      closes.push({ code: (event as CloseEvent).code, reason: (event as CloseEvent).reason });
    });

    const flipped = await postSettings(code, created.token!, {
      side: "gote",
      tc: { type: "none" },
    });
    expect(flipped.json.ok).toBe(true);

    await waitFor(() => closes.length >= 1);
    expect(closes[0].code).toBe(4001);
    expect(closes[0].reason).toBe("seat_changed");
  });
});

describe("time control (server-authoritative)", () => {
  it("arms the first mover's clock when the opponent joins", async () => {
    const before = Date.now();
    const { json: created } = await createRoom({ tc: { type: "per_move", seconds: 10 } });
    const code = created.match!.room_code;
    expect(created.match!.turn_deadline).toBeNull();

    const { json: joined } = await joinRoom(code, UID_B);
    const deadline = Date.parse(joined.match!.turn_deadline!);
    // join time + 5s start buffer + 10s allowance
    expect(deadline).toBeGreaterThan(before + 14_000);
    expect(deadline).toBeLessThan(Date.now() + 16_000);
    expect(joined.match!.tc_type).toBe("per_move");
    expect(joined.match!.sente_time_ms).toBeNull(); // per-move mode has no banks
  });

  it("the start buffer is not charged to the first mover (total)", async () => {
    const { json: created } = await createRoom({ tc: { type: "total", seconds: 300 } });
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);

    // Move immediately: turn_started_at still sits in the future (start buffer),
    // so the elapsed time clamps to 0 and the bank stays full.
    const mv = await postMove(code, created.token!, 0, MOVE_7G7F);
    expect(mv.json.ok).toBe(true);
    expect(mv.json.match!.sente_time_ms).toBe(300_000);
  });

  it("per-move: the side to move loses on flag fall via the alarm", async () => {
    const { json: created } = await createRoom({ tc: { type: "per_move", seconds: 10 } });
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET turn_started_at = ?, turn_deadline = ? WHERE id = 1",
        Date.now() - 11_000,
        Date.now() - 1_000,
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const after = await getState(code, joined.token!);
    expect(after.json.match!.game_over).toBe(true);
    expect(after.json.match!.winner).toBe("gote"); // sente was to move
    expect(after.json.match!.result_reason).toBe("timeout");
    expect(after.json.match!.turn_deadline).toBeNull();
    expect(after.json.match!.revision).toBe(1);
  });

  it("total: a move deducts the mover's bank and arms the opponent's deadline", async () => {
    const { json: created } = await createRoom({ tc: { type: "total", seconds: 300 } });
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);
    expect(joined.match!.sente_time_ms).toBe(300_000);
    expect(joined.match!.gote_time_ms).toBe(300_000);

    // Pretend sente has been thinking for ~5s.
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET turn_started_at = ?, turn_deadline = ? WHERE id = 1",
        Date.now() - 5_000,
        Date.now() + 295_000,
      );
    });

    const mv = await postMove(code, created.token!, 0, MOVE_7G7F);
    expect(mv.json.ok).toBe(true);
    const senteMs = mv.json.match!.sente_time_ms!;
    expect(senteMs).toBeGreaterThan(293_000);
    expect(senteMs).toBeLessThan(296_000);
    expect(mv.json.match!.gote_time_ms).toBe(300_000);
    // Gote's deadline is now + gote's full bank.
    const deadline = Date.parse(mv.json.match!.turn_deadline!);
    const delta = deadline - Date.now();
    expect(delta).toBeGreaterThan(297_000);
    expect(delta).toBeLessThan(301_000);
  });

  it("total: flag fall zeroes the loser's bank", async () => {
    const { json: created } = await createRoom({ tc: { type: "total", seconds: 180 } });
    const code = created.match!.room_code;
    const { json: joined } = await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET turn_started_at = ?, turn_deadline = ? WHERE id = 1",
        Date.now() - 181_000,
        Date.now() - 1_000,
      );
    });
    await runDurableObjectAlarm(stub);

    const after = await getState(code, joined.token!);
    expect(after.json.match!.game_over).toBe(true);
    expect(after.json.match!.winner).toBe("gote");
    expect(after.json.match!.result_reason).toBe("timeout");
    expect(after.json.match!.sente_time_ms).toBe(0);
    expect(after.json.match!.gote_time_ms).toBe(180_000);
  });

  it("a flagged player's move request finalizes the timeout instead of applying", async () => {
    const { json: created } = await createRoom({ tc: { type: "per_move", seconds: 10 } });
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);

    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET turn_started_at = ?, turn_deadline = ? WHERE id = 1",
        Date.now() - 11_000,
        Date.now() - 1_000,
      );
    });

    const mv = await postMove(code, created.token!, 0, MOVE_7G7F);
    expect(mv.json.ok).toBe(true); // idempotent final-state shape
    expect(mv.json.match!.game_over).toBe(true);
    expect(mv.json.match!.result_reason).toBe("timeout");
    expect(mv.json.match!.state.usiMoveHistory).toEqual([]); // move NOT applied
  });

  it("no time control: moves never set a deadline", async () => {
    const { json: created } = await createRoom({});
    const code = created.match!.room_code;
    await joinRoom(code, UID_B);

    const mv = await postMove(code, created.token!, 0, MOVE_7G7F);
    expect(mv.json.ok).toBe(true);
    expect(mv.json.match!.tc_type).toBe("none");
    expect(mv.json.match!.turn_deadline).toBeNull();
    expect(mv.json.match!.sente_time_ms).toBeNull();
  });

  it("does not forfeit a waiting room whose sente seat is empty (creator=gote)", async () => {
    const { json: created } = await createRoom({ side: "gote" });
    const code = created.match!.room_code;
    const stub = env.MATCH_ROOM.getByName(code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE match SET last_seen_gote = ? WHERE id = 1",
        Date.now() - 90_000,
      );
    });
    await runDurableObjectAlarm(stub);
    const after = await getState(code, created.token!);
    expect(after.json.ok).toBe(true);
    expect(after.json.match!.game_over).toBe(false);
  });
});
