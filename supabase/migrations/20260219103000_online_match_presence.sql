-- SPDX-License-Identifier: GPL-3.0-only

-- Keep frequent heartbeat timestamps outside the realtime-published table.
create table if not exists public.online_match_presence (
  match_id uuid primary key references public.online_matches(id) on delete cascade,
  last_seen_sente timestamptz,
  last_seen_gote timestamptz,
  updated_at timestamptz not null default now()
);

-- Preserve existing presence data.
insert into public.online_match_presence (
  match_id,
  last_seen_sente,
  last_seen_gote,
  updated_at
)
select
  id,
  last_seen_sente,
  last_seen_gote,
  coalesce(updated_at, now())
from public.online_matches
on conflict (match_id) do update
set
  last_seen_sente = excluded.last_seen_sente,
  last_seen_gote = excluded.last_seen_gote,
  updated_at = excluded.updated_at;

-- Keep updated_at current on every update.
drop trigger if exists set_online_match_presence_updated_at on public.online_match_presence;
create trigger set_online_match_presence_updated_at
before update on public.online_match_presence
for each row
execute function public.set_updated_at();

-- Heartbeats no longer need FULL row images on online_matches.
alter table public.online_matches replica identity default;

-- Presence table is internal (service-role only).
alter table public.online_match_presence enable row level security;
