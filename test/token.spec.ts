// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { blockKey, signPlayerToken, verifyPlayerToken } from "../src/worker/token";

const SECRET = "test-secret";

describe("blockKey", () => {
  const UID = "11111111-1111-4111-8111-111111111111";

  it("is 16 hex digits, the same for the same uid, and does not reveal the uid", async () => {
    const key = await blockKey(UID, SECRET);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(await blockKey(UID, SECRET)).toBe(key);
    expect(key).not.toContain("1111");
  });

  it("differs by uid and by secret", async () => {
    const key = await blockKey(UID, SECRET);
    expect(await blockKey("22222222-2222-4222-8222-222222222222", SECRET)).not.toBe(key);
    expect(await blockKey(UID, "other-secret")).not.toBe(key);
  });
});

describe("playerToken", () => {
  it("round-trips a valid token", async () => {
    const payload = {
      roomCode: "ABCDEFGHJK",
      side: "sente" as const,
      uid: "11111111-1111-4111-8111-111111111111",
      exp: Date.now() + 60_000,
    };
    const token = await signPlayerToken(payload, SECRET);
    const verified = await verifyPlayerToken(token, SECRET, Date.now());
    expect(verified).toEqual(payload);
  });

  it("rejects a tampered token", async () => {
    const token = await signPlayerToken(
      { roomCode: "ABCDEFGHJK", side: "sente", uid: "u-1234567", exp: Date.now() + 60_000 },
      SECRET,
    );
    const forged = await signPlayerToken(
      { roomCode: "ABCDEFGHJK", side: "gote", uid: "u-1234567", exp: Date.now() + 60_000 },
      SECRET,
    );
    // Body of the forged token with the signature of the original.
    const frankenstein = `${forged.split(".")[0]}.${token.split(".")[1]}`;
    expect(await verifyPlayerToken(frankenstein, SECRET, Date.now())).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signPlayerToken(
      { roomCode: "ABCDEFGHJK", side: "sente", uid: "u-1234567", exp: Date.now() + 60_000 },
      "other-secret",
    );
    expect(await verifyPlayerToken(token, SECRET, Date.now())).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signPlayerToken(
      { roomCode: "ABCDEFGHJK", side: "sente", uid: "u-1234567", exp: Date.now() - 1 },
      SECRET,
    );
    expect(await verifyPlayerToken(token, SECRET, Date.now())).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyPlayerToken("", SECRET, Date.now())).toBeNull();
    expect(await verifyPlayerToken("abc", SECRET, Date.now())).toBeNull();
    expect(await verifyPlayerToken("a.b.c", SECRET, Date.now())).toBeNull();
  });
});
