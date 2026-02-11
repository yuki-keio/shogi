-- SPDX-License-Identifier: GPL-3.0-only

-- Auto-delete expired online matches to keep DB size and realtime load under control.

create extension if not exists pg_cron;

create or replace function public.cleanup_expired_online_matches()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  with deleted as (
    delete from public.online_matches
    where expires_at <= now()
    returning 1
  )
  select count(*) into deleted_count from deleted;

  return deleted_count;
end;
$$;

-- Schedule hourly cleanup job.
-- pg_cron has two variants:
--   cron.schedule(schedule, command)
--   cron.schedule(job_name, schedule, command)
-- Try the newer signature first, then fall back.
do $$
declare
  already_scheduled boolean := false;
begin
  -- Best-effort guard against duplicate schedules (e.g. if the block is re-run manually).
  begin
    select true
      into already_scheduled
      from cron.job
     where command = 'select public.cleanup_expired_online_matches();'
     limit 1;
  exception
    when undefined_table then
      already_scheduled := false;
  end;

  if already_scheduled then
    return;
  end if;

  begin
    perform cron.schedule(
      'cleanup_expired_online_matches',
      '0 * * * *',
      'select public.cleanup_expired_online_matches();'
    );
  exception
    when undefined_function then
      perform cron.schedule(
        '0 * * * *',
        'select public.cleanup_expired_online_matches();'
      );
  end;
end $$;
