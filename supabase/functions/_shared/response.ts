// SPDX-License-Identifier: GPL-3.0-only

import { corsHeaders } from "./cors.ts";

export type ApiError = {
  code: string;
  message: string;
  details?: unknown;
};

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const err: ApiError = { code, message };
  if (details !== undefined) err.details = details;
  return jsonResponse({ ok: false, error: err }, { status });
}

export async function parseJsonBody<T>(
  req: Request,
): Promise<{ ok: true; data: T } | { ok: false; error: Response }> {
  try {
    const data = (await req.json()) as T;
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: errorResponse(400, "bad_json", "Invalid JSON body", String(e)),
    };
  }
}

