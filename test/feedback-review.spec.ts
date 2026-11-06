// SPDX-License-Identifier: GPL-3.0-only

// 届いた意見の審査：判定ごとの通知、失敗したときの扱い、廃棄した投稿の削除。
// Claude API と Discord は作り物に置き換える（本物は呼ばない）。

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { reviewAndNotify } from "../src/worker/index";

const DISCORD_URL = "https://discord.test/webhook";
const testEnv = { ...env, ANTHROPIC_API_KEY: "test-key", DISCORD_WEBHOOK_URL: DISCORD_URL };

type ApiAnswer = () => Promise<Response>;

const answer = (verdict: string, summary = "", stop_reason = "end_turn"): ApiAnswer => async () =>
  Response.json({
    stop_reason,
    content: [{ type: "text", text: JSON.stringify({ verdict, reason: "理由", summary }) }],
  });

function stubNetwork(apiAnswer: ApiAnswer) {
  const apiRequests: Array<{ headers: Headers; body: { messages: Array<{ content: string }> } }> = [];
  const notified: Array<{ title: string; description: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url === DISCORD_URL) {
      notified.push(body.embeds[0]);
      return new Response(null, { status: 204 });
    }
    apiRequests.push({ headers: new Headers(init?.headers), body });
    return apiAnswer();
  });
  return { apiRequests, notified };
}

async function insertPost(message: string, createdAt?: string): Promise<number> {
  const result = createdAt
    ? await env.DB.prepare("INSERT INTO feedback (message, created_at) VALUES (?1, ?2)").bind(message, createdAt).run()
    : await env.DB.prepare("INSERT INTO feedback (message) VALUES (?1)").bind(message).run();
  return result.meta.last_row_id;
}

const savedRow = (id: number) =>
  env.DB.prepare("SELECT review_verdict, review_reason, review_summary FROM feedback WHERE id = ?1")
    .bind(id)
    .first<{ review_verdict: string | null; review_reason: string | null; review_summary: string | null }>();

// 全テスト共通の通知の見出し（判定のない通知と比べるために、鍵なしで一度送って取る）
async function plainTitle(): Promise<string> {
  const { notified } = stubNetwork(answer("pass"));
  await reviewAndNotify({ ...testEnv, ANTHROPIC_API_KEY: "" }, 0, "x", null, "");
  return notified[0].title;
}

describe("reviewAndNotify", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM feedback").run();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies the original text when the post passes", async () => {
    const title = await plainTitle();
    const id = await insertPost("架空の不具合の報告");
    const { notified } = stubNetwork(answer("pass"));
    await reviewAndNotify(testEnv, id, "架空の不具合の報告", null, "");
    expect(notified).toEqual([expect.objectContaining({ title, description: "架空の不具合の報告" })]);
    expect((await savedRow(id))?.review_verdict).toBe("pass");
  });

  it("notifies only the summary, marked with the post number, when it is summarized", async () => {
    const title = await plainTitle();
    const id = await insertPost("架空の暴言まじりの要望");
    const { notified } = stubNetwork(answer("summary", "架空の要望の要約"));
    await reviewAndNotify(testEnv, id, "架空の暴言まじりの要望", null, "");
    expect(notified).toHaveLength(1);
    expect(notified[0].description).toBe("架空の要望の要約");
    expect(notified[0].title).not.toBe(title);
    expect(notified[0].title).toContain(`#${id}`);
    expect(await savedRow(id)).toMatchObject({ review_verdict: "summary", review_summary: "架空の要望の要約" });
  });

  it("does not notify a discarded post but keeps it recorded", async () => {
    const id = await insertPost("架空の暴言");
    const { notified } = stubNetwork(answer("discard"));
    await reviewAndNotify(testEnv, id, "架空の暴言", null, "");
    expect(notified).toHaveLength(0);
    expect((await savedRow(id))?.review_verdict).toBe("discard");
  });

  it.each([
    ["the API returns an error", async () => new Response("{}", { status: 500 }), "http_500"],
    [
      "the request times out",
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      "timeout",
    ],
    [
      "the network fails",
      async () => {
        throw new TypeError("network");
      },
      "network",
    ],
    ["the answer is refused", answer("pass", "", "refusal"), "stop_refusal"],
    ["the answer has an unknown verdict", answer("other"), "unreadable"],
    ["a summary comes back empty", answer("summary", "  "), "unreadable"],
    ["the answer is not JSON", async () => new Response("not json"), "bad_json"],
    ["the answer body is null", async () => Response.json(null), "stop_undefined"],
  ] as Array<[string, ApiAnswer, string]>)("notifies the original text as unreviewed when %s", async (_name, api, reason) => {
    const title = await plainTitle();
    const id = await insertPost("架空の投稿");
    const { notified } = stubNetwork(api);
    await reviewAndNotify(testEnv, id, "架空の投稿", null, "");
    expect(notified).toHaveLength(1);
    expect(notified[0].description).toBe("架空の投稿");
    expect(notified[0].title).not.toBe(title);
    expect(await savedRow(id)).toMatchObject({ review_verdict: "unreviewed", review_reason: reason });
  });

  it("skips the review and notifies as before when there is no API key", async () => {
    const title = await plainTitle();
    const id = await insertPost("架空の投稿");
    const { apiRequests, notified } = stubNetwork(answer("discard"));
    await reviewAndNotify({ ...testEnv, ANTHROPIC_API_KEY: undefined }, id, "架空の投稿", null, "");
    expect(apiRequests).toHaveLength(0);
    expect(notified).toEqual([expect.objectContaining({ title, description: "架空の投稿" })]);
    expect((await savedRow(id))?.review_verdict).toBeNull();
  });

  it("sends the API only the message, not the attached details", async () => {
    const id = await insertPost("架空の投稿");
    const { apiRequests } = stubNetwork(answer("pass"));
    await reviewAndNotify(testEnv, id, "架空の投稿", '["online"]', "id:abcd1234 / mode:online");
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0].headers.get("Authorization")).toBe("Bearer test-key");
    const sent = JSON.stringify(apiRequests[0].body.messages);
    expect(sent).toContain("架空の投稿");
    expect(sent).not.toContain("abcd1234");
    expect(sent).not.toContain("online");
  });

  it("deletes only discarded posts older than the keep period", async () => {
    const oldDiscarded = await insertPost("古い廃棄", "2020-01-01T00:00:00.000Z");
    const oldKept = await insertPost("古い通常の投稿", "2020-01-01T00:00:00.000Z");
    const recentDiscarded = await insertPost("新しい廃棄");
    await env.DB.prepare("UPDATE feedback SET review_verdict = 'discard' WHERE id IN (?1, ?2)")
      .bind(oldDiscarded, recentDiscarded)
      .run();
    const id = await insertPost("架空の投稿");
    stubNetwork(answer("pass"));
    await reviewAndNotify(testEnv, id, "架空の投稿", null, "");
    const { results } = await env.DB.prepare("SELECT id FROM feedback ORDER BY id").all<{ id: number }>();
    expect(results.map((r) => r.id)).toEqual([oldKept, recentDiscarded, id]);
  });

  it("still notifies when the verdict cannot be saved", async () => {
    const { notified } = stubNetwork(answer("pass"));
    const brokenDb = { ...testEnv, DB: { ...env.DB, batch: () => Promise.reject(new Error("db down")), prepare: env.DB.prepare.bind(env.DB) } };
    await reviewAndNotify(brokenDb as unknown as typeof testEnv, 1, "架空の投稿", null, "");
    expect(notified).toHaveLength(1);
  });

  it("notifies before saving, so a stuck save cannot hold the notification back", async () => {
    const { notified } = stubNetwork(answer("pass"));
    const stuckDb = { ...testEnv, DB: { ...env.DB, batch: () => new Promise(() => {}), prepare: env.DB.prepare.bind(env.DB) } };
    void reviewAndNotify(stuckDb as unknown as typeof testEnv, 1, "架空の投稿", null, "");
    await vi.waitFor(() => expect(notified).toHaveLength(1));
  });
});

describe("POST /api/feedback", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM feedback").run();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers without waiting for the review, then saves the verdict on the new post", async () => {
    let finishReview!: () => void;
    const reviewFinished = new Promise<void>((resolve) => {
      finishReview = resolve;
    });
    const { apiRequests, notified } = stubNetwork(async () => {
      await reviewFinished;
      return answer("discard")();
    });
    const ctx = createExecutionContext();
    const request = new Request("https://example.com/api/feedback", {
      method: "POST",
      headers: { "CF-Connecting-IP": "10.77.0.1", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "架空の投稿" }),
    });
    const response = await Promise.race([
      worker.fetch(request, testEnv, ctx),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 300)),
    ]);
    expect(response).not.toBe("waited");
    finishReview();
    await waitOnExecutionContext(ctx);
    expect(apiRequests).toHaveLength(1);
    expect(notified).toHaveLength(0);
    const row = await env.DB.prepare("SELECT review_verdict FROM feedback WHERE message = ?1")
      .bind("架空の投稿")
      .first<{ review_verdict: string }>();
    expect(row?.review_verdict).toBe("discard");
  });
});
