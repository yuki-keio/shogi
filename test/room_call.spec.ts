// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoom, isTransientRoomError } from "../src/worker/room_call";

// Cloudflare が部屋の実体を作り直したときに実際に返す文面
const RESET_MESSAGES = [
  "Durable Object storage operation exceeded timeout which caused object to be reset.",
  "Internal error in Durable Object storage caused object to be reset; reference = k810hfejlhnft9f2igg90d06",
  "Durable Object storage is no longer accessible.",
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
  "Durable Object reset because its code was updated.",
];

describe("isTransientRoomError", () => {
  it("treats Cloudflare's reset errors as transient", () => {
    for (const message of RESET_MESSAGES) {
      expect(isTransientRoomError(new Error(message)), message).toBe(true);
    }
  });

  it("follows the retryable flag but never retries an overloaded object", () => {
    expect(isTransientRoomError(Object.assign(new Error("Network connection lost."), { retryable: true }))).toBe(true);
    expect(isTransientRoomError(Object.assign(new Error("Too many requests"), { retryable: true, overloaded: true }))).toBe(false);
    expect(isTransientRoomError(Object.assign(new Error(RESET_MESSAGES[0]), { overloaded: true }))).toBe(false);
  });

  it("does not retry the room's own errors or non-errors", () => {
    expect(isTransientRoomError(new Error("bad_state"))).toBe(false);
    expect(isTransientRoomError("caused object to be reset")).toBe(false);
    expect(isTransientRoomError(null)).toBe(false);
    expect(isTransientRoomError(undefined)).toBe(false);
  });
});

describe("callRoom", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // getByName のたびに新しい stub を返し、n 回目の stub は outcomes[n] で応える
  function fakeRooms(outcomes: (Error | string)[]) {
    const stubs: { name: string; outcome: Error | string }[] = [];
    const ns = {
      getByName(name: string) {
        const stub = { name, outcome: outcomes[stubs.length] };
        stubs.push(stub);
        return stub;
      },
    };
    const call = async (stub: { outcome: Error | string }) => {
      if (stub.outcome instanceof Error) throw stub.outcome;
      return stub.outcome;
    };
    return { ns, stubs, call };
  }

  it("retries once on a fresh stub after a transient failure", async () => {
    const { ns, stubs, call } = fakeRooms([new Error(RESET_MESSAGES[0]), "ok"]);
    await expect(callRoom(ns, "ABCDEFGHJK", "state", call)).resolves.toBe("ok");
    expect(stubs).toHaveLength(2);
    expect(stubs[1]).not.toBe(stubs[0]);
    expect(stubs.map((s) => s.name)).toEqual(["ABCDEFGHJK", "ABCDEFGHJK"]);
  });

  it("does not retry other failures", async () => {
    const { ns, stubs, call } = fakeRooms([new Error("boom"), "ok"]);
    await expect(callRoom(ns, "ABCDEFGHJK", "move", call)).rejects.toThrow("boom");
    expect(stubs).toHaveLength(1);
  });

  it("does not retry a failure that came after a long wait", async () => {
    const { ns, stubs, call } = fakeRooms([new Error(RESET_MESSAGES[0]), "ok"]);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const slowCall = async (stub: { outcome: Error | string }) => {
      clock += 20_000;
      return call(stub);
    };
    await expect(callRoom(ns, "ABCDEFGHJK", "state", slowCall)).rejects.toThrow(RESET_MESSAGES[0]);
    expect(stubs).toHaveLength(1);
  });

  it("gives up after one retry", async () => {
    const { ns, stubs, call } = fakeRooms([new Error(RESET_MESSAGES[1]), new Error(RESET_MESSAGES[2]), "ok"]);
    await expect(callRoom(ns, "ABCDEFGHJK", "join", call)).rejects.toThrow(RESET_MESSAGES[2]);
    expect(stubs).toHaveLength(2);
  });
});
