// SPDX-License-Identifier: GPL-3.0-only

export const corsHeaders: Record<string, string> = {
  // Keep this permissive; auth is enforced by the function itself.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders });
}

