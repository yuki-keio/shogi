// SPDX-License-Identifier: GPL-3.0-only

// POST /api/feedback: validation, honeypot, rate limiting, D1 persistence.

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type FeedbackResult = {
  ok: boolean;
  error?: { code: string; message: string };
};

// Each test gets its own IP so tests never trip the per-IP rate limit
// (the limiter map is per-isolate and shared across tests in this file).
let nextTestIp = 1;

function uniqueIp(): string {
  nextTestIp += 1;
  return `10.8.${Math.floor(nextTestIp / 256)}.${nextTestIp % 256}`;
}

async function postFeedback(
  body: unknown,
  { ip = uniqueIp(), raw = false }: { ip?: string; raw?: boolean } = {},
) {
  const res = await SELF.fetch("https://example.com/api/feedback", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": ip,
      "Content-Type": "application/json",
      "User-Agent": "vitest-agent",
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  const json = (await res.json()) as FeedbackResult;
  return { res, json };
}

async function countRows(): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM feedback",
  ).all<{ n: number }>();
  return results[0].n;
}

describe("POST /api/feedback", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM feedback").run();
  });

  it("stores valid feedback in D1", async () => {
    const { res, json } = await postFeedback({ message: "  盤面が見やすくて良いです  " });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    const { results } = await env.DB.prepare(
      "SELECT message, ua, created_at FROM feedback",
    ).all<{ message: string; ua: string; created_at: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("盤面が見やすくて良いです"); // trimmed
    expect(results[0].ua).toBe("vitest-agent");
    expect(results[0].created_at).toBeTruthy();
  });

  it("rejects a missing message", async () => {
    const { res, json } = await postFeedback({});
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_request");
    expect(await countRows()).toBe(0);
  });

  it("rejects an empty / whitespace-only message", async () => {
    const { res } = await postFeedback({ message: "   " });
    expect(res.status).toBe(400);
    expect(await countRows()).toBe(0);
  });

  it("rejects a message longer than 2000 chars", async () => {
    const { res } = await postFeedback({ message: "あ".repeat(2001) });
    expect(res.status).toBe(400);
    expect(await countRows()).toBe(0);
  });

  it("accepts a message of exactly 2000 chars", async () => {
    const { res } = await postFeedback({ message: "あ".repeat(2000) });
    expect(res.status).toBe(200);
    expect(await countRows()).toBe(1);
  });

  it("rejects an oversized body before parsing", async () => {
    const { res, json } = await postFeedback({ message: "あ".repeat(65_000) });
    expect(res.status).toBe(413);
    expect(json.error?.code).toBe("payload_too_large");
    expect(await countRows()).toBe(0);
  });

  it("rejects a non-JSON body", async () => {
    const { res, json } = await postFeedback("not json", { raw: true });
    expect(res.status).toBe(400);
    expect(json.error?.code).toBe("bad_json");
  });

  it("rejects GET", async () => {
    const res = await SELF.fetch("https://example.com/api/feedback");
    expect(res.status).toBe(405);
  });

  it("returns a fake success for honeypot submissions without storing", async () => {
    const { res, json } = await postFeedback({
      message: "spam message",
      website: "https://spam.example.com",
    });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(await countRows()).toBe(0);
  });

  it("rate limits the 6th submission from the same IP", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      const { res } = await postFeedback({ message: `feedback ${i}` }, { ip });
      expect(res.status).toBe(200);
    }
    const { res, json } = await postFeedback({ message: "one too many" }, { ip });
    expect(res.status).toBe(429);
    expect(json.error?.code).toBe("rate_limited");
    expect(await countRows()).toBe(5);
  });

  // DISCORD_WEBHOOK_URL is unset in tests, so the success cases above also
  // prove the endpoint works without the optional notification secret.
});
