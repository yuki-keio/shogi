-- SPDX-License-Identifier: GPL-3.0-only

-- Online matches (invite URL based)
create extension if not exists pgcrypto;

create table if not exists public.online_matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),

  sente_uid uuid not null,
  gote_uid uuid,
  sente_name text,
  gote_name text,

  state jsonb not null,
  revision integer not null default 0,

  game_over boolean not null default false,
  winner text,
  result_reason text,

  last_seen_sente timestamptz,
  last_seen_gote timestamptz,
  disconnect_deadline timestamptz,
  disconnect_side text
);

-- Keep winner/result_reason small and predictable.
alter table public.online_matches
  add constraint online_matches_winner_check
    check (winner is null or winner in ('sente', 'gote', 'draw'));

alter table public.online_matches
  add constraint online_matches_disconnect_side_check
    check (disconnect_side is null or disconnect_side in ('sente', 'gote'));

create index if not exists online_matches_expires_at_idx on public.online_matches (expires_at);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_online_matches_updated_at on public.online_matches;
create trigger set_online_matches_updated_at
before update on public.online_matches
for each row
execute function public.set_updated_at();

-- Realtime (Postgres Changes)
alter table public.online_matches replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.online_matches;
  end if;
end $$;

-- RLS: participants only (read), writes are blocked for clients and done via Edge Functions.
alter table public.online_matches enable row level security;

drop policy if exists "online_matches_select_participants" on public.online_matches;
create policy "online_matches_select_participants"
on public.online_matches
for select
to authenticated
using ((auth.uid() = sente_uid or auth.uid() = gote_uid) and expires_at > now());
