-- Mandate, the shared world (step 2): founders choose where their town stands on the world map.
--
-- Run once in the Supabase SQL editor after 20261005000000_shared_world.sql, or with the Supabase CLI
-- (`supabase db push`). Safe to run again.
--
-- A town founded from the world map carries the plot its founder clicked (p_meta.plot). On the town's first save it
-- gets that plot if it is still free in its region; otherwise, and for towns without a choice, the next free plot
-- outwards from the region's centre. Plots already handed out never move.

-- Gives a town a plot in its region, once: the plot asked for when it is free, else the next free one.
create or replace function public.claim_plot(p_town uuid, p_want integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_region text;
  v_plot integer;
begin
  select case when preset ~ '^[a-z][a-z0-9-]{0,39}$' then preset else 'other' end into v_region
    from public.towns where id = p_town and plot is null for update;
  if not found then return; end if;
  -- one placement at a time per region
  insert into public.world_regions (region, next_plot) values (v_region, 0) on conflict (region) do nothing;
  perform 1 from public.world_regions where region = v_region for update;
  if p_want is not null and p_want between 0 and 20000
     and not exists (select 1 from public.towns where region = v_region and plot = p_want) then
    v_plot := p_want;
  else
    select next_plot into v_plot from public.world_regions where region = v_region;
    while exists (select 1 from public.towns where region = v_region and plot = v_plot) loop
      v_plot := v_plot + 1;
    end loop;
    update public.world_regions set next_plot = v_plot + 1 where region = v_region;
  end if;
  update public.towns set region = v_region, plot = v_plot where id = p_town;
end;
$$;

-- The original placement now skips plots that founders have picked.
create or replace function public.place_town(p_town uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.claim_plot(p_town, null);
end;
$$;

revoke execute on function public.claim_plot(uuid, integer) from public, anon, authenticated;
revoke execute on function public.place_town(uuid) from public, anon, authenticated;

-- As in the shared-world migration, placing a new town on the plot its founder chose.
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
  if t.plot is null then
    perform public.claim_plot(t.id, round(public.meta_number(p_meta, 'plot', 0, 20000))::integer);
  end if;
  return jsonb_build_object('ok', true, 'revision', t.revision + 1);
end;
$$;

revoke execute on function public.commit_save(text, text, integer, boolean, text, jsonb) from public, anon;
grant execute on function public.commit_save(text, text, integer, boolean, text, jsonb) to authenticated;
