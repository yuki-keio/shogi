-- SPDX-License-Identifier: GPL-3.0-only

-- Do not expose the cleanup function to clients via RPC.
-- Cron jobs run as the scheduling role (typically `postgres`) and do not need PUBLIC execute.

alter function public.cleanup_expired_online_matches() security invoker;
revoke all on function public.cleanup_expired_online_matches() from public;

