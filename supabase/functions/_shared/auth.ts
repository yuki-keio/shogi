// SPDX-License-Identifier: GPL-3.0-only

import { createSupabaseAuthClient } from "./supabase.ts";

export type AuthedUser = {
  id: string;
};

export async function requireUser(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const supabase = createSupabaseAuthClient(authHeader);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;

  return { id: data.user.id };
}

