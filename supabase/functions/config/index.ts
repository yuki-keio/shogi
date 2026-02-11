// SPDX-License-Identifier: GPL-3.0-only

import { handleCorsPreflight } from "../_shared/cors.ts";
import { jsonResponse } from "../_shared/response.ts";
import { DISCONNECT_GRACE_MS } from "../_shared/disconnect.ts";

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  return jsonResponse({
    ok: true,
    config: {
      disconnectGraceSeconds: Math.floor(DISCONNECT_GRACE_MS / 1000),
      matchExpiresHours: 24,
      roomCodeLength: 10,
    },
  });
});

