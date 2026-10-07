-- Mandate, the shared world (step 1): a world map of every public town, and read-only visits.
--
-- Run once in the Supabase SQL editor after 20261002000000_accounts_cloud_saves.sql, or with the Supabase CLI
-- (`supabase db push`). Safe to run again.
--
-- Each town in the cloud gets a plot on the world map, in its region, the first time it is saved. Towns are on the map
-- by default: every signed-in player (guests too) sees them there and may download their latest save to visit them.
-- The owner can take a town off the map at any time. Older copies, and towns off the map, stay readable by their owner
-- only. The map shows a town's name, its mayor's display name, a few figures and whether it is being played right now;
-- email addresses are never exposed. A visit downloads the file from the owner's folder, so its path contains the
-- owner's random account id, which grants no access by itself.

-- ------------------------------------------------------------------------------------------------ towns on the map

alter table public.towns add column if not exists on_map boolean not null default true;
alter table public.towns add column if not exists region text;
alter table public.towns add column if not exists plot integer;
alter table public.towns add column if not exists stats jsonb not null default '{}'::jsonb;

-- one town per plot; visitors' downloads look towns up by their latest file
create unique index if not exists towns_region_plot on public.towns (region, plot);
create index if not exists towns_save_path on public.towns (save_path);

-- the next free plot in each region; plots are numbered outwards from the region's centre
create table if not exists public.world_regions (
  region text primary key,
  next_plot integer not null default 0
);
alter table public.world_regions enable row level security;
revoke all on public.world_regions from anon, authenticated;

-- A number from the save's description, kept within [lo, hi]; null when it is missing or not a number.
create or replace function public.meta_number(p jsonb, k text, lo double precision, hi double precision)
returns double precision language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p -> k) = 'number' then least(hi, greatest(lo, (p ->> k)::double precision)) end
$$;

-- Gives a town the next plot in its region, once. The region is the town's preset.
create or replace function public.place_town(p_town uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_region text;
  v_plot integer;
begin
  select case when preset ~ '^[a-z][a-z0-9-]{0,39}$' then preset else 'other' end into v_region
    from public.towns where id = p_town and plot is null for update;
  if not found then return; end if;
  insert into public.world_regions as w (region, next_plot) values (v_region, 1)
    on conflict (region) do update set next_plot = w.next_plot + 1
    returning next_plot - 1 into v_plot;
  update public.towns set region = v_region, plot = v_plot where id = p_town;
end;
$$;

revoke execute on function public.meta_number(jsonb, text, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.place_town(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ saving

-- As in the accounts migration, plus the figures the world map shows and, on the first save, a plot on the map.
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
    stats = jsonb_strip_nulls(jsonb_build_object(
      'approval', public.meta_number(p_meta, 'approval', 0, 1),
      'unemployment', public.meta_number(p_meta, 'unemployment', 0, 1),
      'year', round(public.meta_number(p_meta, 'year', -100000, 100000)),
      'officeYear', round(public.meta_number(p_meta, 'officeYear', -100000, 100000))
    )),
    lease_device = p_device,
    lease_until = now() + interval '3 minutes'
  where id = t.id;
  if t.plot is null then perform public.place_town(t.id); end if;
  return jsonb_build_object('ok', true, 'revision', t.revision + 1);
end;
$$;

revoke execute on function public.commit_save(text, text, integer, boolean, text, jsonb) from public, anon;
grant execute on function public.commit_save(text, text, integer, boolean, text, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ the world map

-- Every town on the map that has a save, plus the caller's own towns that are off it (marked on_map = false).
-- world_id is only filled in for the caller's own towns, so they can open them from the map.
drop function if exists public.world_towns();
create function public.world_towns()
returns table (
  id uuid, name text, mayor text, region text, plot integer, preset text, condition text, population integer,
  sim_date text, stats jsonb, saved_at timestamptz, playing boolean, mine boolean, on_map boolean, world_id text
) language sql stable security definer set search_path = '' as $$
  select t.id, t.name, coalesce(p.display_name, 'Mayor'), t.region, t.plot, t.preset, t.condition, t.population,
         t.sim_date, t.stats, t.saved_at, coalesce(t.lease_until > now(), false), t.owner = auth.uid(), t.on_map,
         case when t.owner = auth.uid() then t.world_id end
    from public.towns t
    left join public.profiles p on p.id = t.owner
   where auth.uid() is not null and t.plot is not null and t.save_path is not null
     and (t.on_map or t.owner = auth.uid())
   order by t.region, t.plot
   limit 5000;
$$;

-- What a visitor needs to download a town's latest save, read at the moment of the visit.
create or replace function public.visit_town(p_town uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t public.towns;
  v_mayor text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  select * into t from public.towns where id = p_town;
  if not found or t.save_path is null or not (t.on_map or t.owner = auth.uid()) then
    raise exception 'That town is not open to visitors' using errcode = '42501';
  end if;
  select display_name into v_mayor from public.profiles where id = t.owner;
  return jsonb_build_object('path', t.save_path, 'enc', t.save_enc, 'revision', t.revision, 'saved_at', t.saved_at,
    'name', t.name, 'mayor', coalesce(v_mayor, 'Mayor'), 'playing', coalesce(t.lease_until > now(), false));
end;
$$;

-- Puts one of the caller's towns on the map or takes it off. False when the caller has no such town in the cloud.
create or replace function public.set_town_public(p_world_id text, p_public boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  update public.towns set on_map = coalesce(p_public, true), updated_at = now()
   where owner = auth.uid() and world_id = p_world_id;
  return found;
end;
$$;

revoke execute on function public.world_towns() from public, anon;
revoke execute on function public.visit_town(uuid) from public, anon;
revoke execute on function public.set_town_public(text, boolean) from public, anon;
grant execute on function public.world_towns() to authenticated;
grant execute on function public.visit_town(uuid) to authenticated;
grant execute on function public.set_town_public(text, boolean) to authenticated;

-- ------------------------------------------------------------------------------------------------ save files

-- Whether a file is the latest save of a town on the map: the only file outside their own folder a player may read.
create or replace function public.is_visitable_save(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.towns t where t.save_path = p_name and t.on_map);
$$;

revoke execute on function public.is_visitable_save(text) from public, anon;
grant execute on function public.is_visitable_save(text) to authenticated;

drop policy if exists "Mandate players read the latest saves of towns on the map" on storage.objects;
create policy "Mandate players read the latest saves of towns on the map" on storage.objects
  for select to authenticated
  using (bucket_id = 'saves' and public.is_visitable_save(name));

-- ------------------------------------------------------------------------------------------------ existing towns

-- towns saved before the world map existed get their plots now, oldest first
do $$
declare
  r record;
begin
  for r in select id from public.towns where plot is null and save_path is not null order by created_at, id loop
    perform public.place_town(r.id);
  end loop;
end;
$$;
