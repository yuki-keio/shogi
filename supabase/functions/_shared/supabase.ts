// SPDX-License-Identifier: GPL-3.0-only

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getSupabaseUrl(): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("Missing env: SUPABASE_URL");
  return url;
}

export function getSupabaseAnonKey(): string {
  // Supabase is migrating from JWT-based `anon` keys to non-JWT `publishable` keys.
  // Keep compatibility with both variable names.
  const key =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_API_KEY");
  if (!key) {
    throw new Error(
      "Missing env: SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY)",
    );
  }
  return key;
}

export function getSupabaseServiceRoleKey(): string {
  // In the new API key system, this may be called a "secret" key.
  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SECRET_API_KEY") ??
    // Some environments reserve the `SUPABASE_` prefix; allow a project-specific name.
    Deno.env.get("SHOGI_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY");
  if (!key) {
    throw new Error(
      "Missing env: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)",
    );
  }
  return key;
}

export function createSupabaseAuthClient(authHeader: string | null) {
  // `verify_jwt = false` at the gateway, so we validate via Auth API here.
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;

  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

export function createSupabaseAdminClient() {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
