-- Mandate, multiplayer phase 1: player accounts and cloud saves.
--
-- Run once in the Supabase SQL editor, or with the Supabase CLI (`supabase db push`). Safe to run again.
-- Project settings this relies on (Authentication in the dashboard):
--   * Sign In / Providers: enable "Allow anonymous sign-ins" and Email.
--   * "Allow manual linking" on, so a guest can attach Google or Discord later.
--   * URL Configuration: add every address the game is served from (e.g. http://localhost:5173) as a redirect URL.
--
-- Model: every player is a Supabase Auth user (guests are anonymous users). A town is one row in public.towns plus
-- its compressed save files in the private "saves" storage bucket under <user id>/<world id>/. Each upload is a new
-- revision; the row points at the latest file. Only one device plays a town at a time: the device holding the lease.
-- Saves and leases change only through the functions below, which check the caller and the lease atomically.

-- ------------------------------------------------------------------------------------------------ profiles

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 3 and 24),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Players read their own profile" on public.profiles;
create policy "Players read their own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "Players rename themselves" on public.profiles;
create policy "Players rename themselves" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- players may change their display name and nothing else
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, updated_at) on public.profiles to authenticated;

-- every new user (guests included) gets a profile with a placeholder name
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Mayor ' || upper(substr(replace(new.id::text, '-', ''), 1, 6)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------------------------------------ towns

create table if not exists public.towns (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  world_id text not null check (char_length(world_id) between 1 and 64),
  name text not null default '',
  preset text not null default '',
  condition text not null default '',
  population integer not null default 0,
  sim_minute double precision not null default 0,
  sim_date text not null default '',
  revision integer not null default 0,
  save_path text,
  save_size integer not null default 0,
  save_enc text not null default 'gzip' check (save_enc in ('gzip', 'json')),
  state_version integer not null default 1,
  saved_at timestamptz,
  lease_device text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, world_id)
);

alter table public.towns enable row level security;

drop policy if exists "Players see their own towns" on public.towns;
create policy "Players see their own towns" on public.towns
  for select to authenticated using ((select auth.uid()) = owner);

drop policy if exists "Players delete their own towns" on public.towns;
create policy "Players delete their own towns" on public.towns
  for delete to authenticated using ((select auth.uid()) = owner);

-- rows are created and changed only by the functions below
revoke insert, update on public.towns from anon, authenticated;
grant select, delete on public.towns to authenticated;

-- Claims the right to play a town on a device for the next three minutes (renewed while playing). Creates the row
-- the first time. Returns granted=false with the cloud revision when another device is playing it, unless forced.
create or replace function public.claim_town(p_world_id text, p_device text, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  t public.towns;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if p_device is null or char_length(p_device) not between 8 and 64 then raise exception 'Bad device id'; end if;
  if char_length(coalesce(p_world_id, '')) not between 1 and 64 then raise exception 'Bad world id'; end if;
  if not exists (select 1 from public.towns where owner = uid and world_id = p_world_id)
     and (select count(*) from public.towns where owner = uid) >= 25 then
    raise exception 'An account can keep at most 25 towns in the cloud';
  end if;
  insert into public.towns (owner, world_id) values (uid, p_world_id) on conflict (owner, world_id) do nothing;
  select * into t from public.towns where owner = uid and world_id = p_world_id for update;
  if t.lease_device is not null and t.lease_device <> p_device and t.lease_until > now() and not p_force then
    return jsonb_build_object('granted', false, 'revision', t.revision, 'path', t.save_path, 'enc', t.save_enc,
      'saved_at', t.saved_at, 'minute', t.sim_minute, 'lease_until', t.lease_until);
  end if;
  update public.towns set lease_device = p_device, lease_until = now() + interval '3 minutes', updated_at = now()
   where id = t.id;
  return jsonb_build_object('granted', true, 'revision', t.revision, 'path', t.save_path, 'enc', t.save_enc,
    'saved_at', t.saved_at, 'minute', t.sim_minute);
end;
$$;

-- Keeps the lease alive. Returns false when another device has taken the town over.
create or replace function public.renew_lease(p_world_id text, p_device text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.towns set lease_until = now() + interval '3 minutes'
   where owner = auth.uid() and world_id = p_world_id and lease_device = p_device;
  return found;
end;
$$;

-- Lets go of the town when the player leaves it on this device.
create or replace function public.release_lease(p_world_id text, p_device text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.towns set lease_device = null, lease_until = null
   where owner = auth.uid() and world_id = p_world_id and lease_device = p_device;
end;
$$;

-- Records an uploaded save file as the town's next revision. The file must already be in the caller's folder.
-- Refuses when another device holds the lease ('lease') or someone saved a newer revision first ('conflict'),
-- unless forced (the player chose to keep this device's copy).
create or replace function public.commit_save(
  p_world_id text, p_device text, p_base_revision integer, p_force boolean, p_path text, p_meta jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  t public.towns;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if split_part(p_path, '/', 1) <> uid::text or split_part(p_path, '/', 2) <> p_world_id then
    raise exception 'Save file is outside your folder';
  end if;
  select * into t from public.towns where owner = uid and world_id = p_world_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  if t.lease_device is distinct from p_device and t.lease_until > now() and not p_force then
    return jsonb_build_object('ok', false, 'reason', 'lease', 'revision', t.revision);
  end if;
  if t.revision <> p_base_revision and not p_force then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', t.revision);
  end if;
  update public.towns set
    revision = t.revision + 1,
    save_path = p_path,
    saved_at = now(),
    updated_at = now(),
    name = left(coalesce(p_meta ->> 'name', ''), 60),
    preset = left(coalesce(p_meta ->> 'preset', ''), 40),
    condition = left(coalesce(p_meta ->> 'condition', ''), 40),
    population = greatest(0, coalesce((p_meta ->> 'population')::integer, 0)),
    sim_minute = greatest(0, coalesce((p_meta ->> 'minute')::double precision, 0)),
    sim_date = left(coalesce(p_meta ->> 'date', ''), 40),
    save_size = greatest(0, coalesce((p_meta ->> 'size')::integer, 0)),
    save_enc = case when p_meta ->> 'enc' = 'json' then 'json' else 'gzip' end,
    state_version = coalesce((p_meta ->> 'version')::integer, 1),
    lease_device = p_device,
    lease_until = now() + interval '3 minutes'
  where id = t.id;
  return jsonb_build_object('ok', true, 'revision', t.revision + 1);
end;
$$;

revoke execute on function public.claim_town(text, text, boolean) from public, anon;
revoke execute on function public.renew_lease(text, text) from public, anon;
revoke execute on function public.release_lease(text, text) from public, anon;
revoke execute on function public.commit_save(text, text, integer, boolean, text, jsonb) from public, anon;
grant execute on function public.claim_town(text, text, boolean) to authenticated;
grant execute on function public.renew_lease(text, text) to authenticated;
grant execute on function public.release_lease(text, text) to authenticated;
grant execute on function public.commit_save(text, text, integer, boolean, text, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ save files

-- private bucket, 25 MB per file; each player can only touch files under their own user id
insert into storage.buckets (id, name, public, file_size_limit)
values ('saves', 'saves', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "Mandate players read their own saves" on storage.objects;
create policy "Mandate players read their own saves" on storage.objects
  for select to authenticated
  using (bucket_id = 'saves' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Mandate players upload their own saves" on storage.objects;
create policy "Mandate players upload their own saves" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'saves' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Mandate players delete their own saves" on storage.objects;
create policy "Mandate players delete their own saves" on storage.objects
  for delete to authenticated
  using (bucket_id = 'saves' and (storage.foldername(name))[1] = (select auth.uid())::text);
