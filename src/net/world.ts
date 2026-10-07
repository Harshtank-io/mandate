// The shared world: every town on the world map, visits to other players' towns, and taking a town off the map.
// Everything here goes through the functions in supabase/migrations/20261005000000_shared_world.sql, which work for
// every signed-in player, guests included. Other players' save files are untrusted input: they are size-limited and
// validated like an imported file, and a visit never saves anything (see Game.visit).

import { decode } from '../game/persist';
import type { WorldState } from '../sim/types';
import { errText, supabase } from './client';
import { refreshTowns } from './saves';

export interface WorldTown {
  id: string;
  name: string;
  mayor: string;
  region: string;
  plot: number;
  preset: string;
  condition: string;
  population: number;
  date: string; // in-game date of its latest save
  approval: number | null;
  unemployment: number | null;
  year: number | null; // in-game year of its latest save
  officeYear: number | null;
  savedAt: string | null;
  playing: boolean; // open on its mayor's device right now
  mine: boolean;
  onMap: boolean; // false only for the player's own towns that are kept off the map
  worldId: string | null; // only known for the player's own towns
}

interface Row {
  id: string; name: string; mayor: string; region: string | null; plot: number | null; preset: string; condition: string; population: number;
  sim_date: string; stats: Record<string, unknown> | null; saved_at: string | null; playing: boolean; mine: boolean; on_map: boolean; world_id: string | null;
}

const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const toWorldTown = (r: Row): WorldTown => ({
  id: r.id, name: r.name || 'Unnamed town', mayor: r.mayor || 'Mayor', region: r.region || 'other', plot: r.plot ?? 0, preset: r.preset,
  condition: r.condition, population: r.population ?? 0, date: r.sim_date ?? '', approval: numOr(r.stats?.approval),
  unemployment: numOr(r.stats?.unemployment), year: numOr(r.stats?.year), officeYear: numOr(r.stats?.officeYear),
  savedAt: r.saved_at, playing: !!r.playing, mine: !!r.mine, onMap: r.on_map !== false, worldId: r.world_id ?? null,
});

/** The largest unpacked save a visit will open (a big town after decades is a few tens of megabytes). */
const VISIT_MAX_BYTES = 120 * 1024 * 1024;

/** A readable reason why the world map, a visit or the map switch did not work. */
export function worldError(e: unknown): string {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
  const m = errText(e);
  if (code === 'PGRST202' || /could not find the function|schema cache/i.test(m)) return 'The world map is not set up on this server yet.';
  return m;
}

/** What the map showed last, so it can be drawn at once when the player comes back to it. */
let last: { towns: WorldTown[]; at: number } | null = null;
export const cachedWorld = () => last;

/** Every town on the world map, plus the player's own towns kept off it. */
export async function fetchWorld(): Promise<WorldTown[]> {
  const sb = await supabase();
  const { data, error } = await sb.rpc('world_towns');
  if (error) throw new Error(worldError(error));
  const towns = ((data ?? []) as Row[]).map(toWorldTown);
  last = { towns, at: Date.now() };
  return towns;
}

export interface Visit {
  town: WorldTown;
  state: WorldState;
  revision: number;
  savedAt: string | null;
  mayor: string;
  playing: boolean;
}

/** Recently downloaded saves: going back to a town downloads it again only if its mayor has saved since. */
const files = new Map<string, { revision: number; blob: Blob; enc: 'gzip' | 'json' }>();
const KEEP_FILES = 4;

/** Downloads a town's latest save to visit it. Fails if the town has been taken off the map since the map loaded. */
export async function visitTown(town: WorldTown): Promise<Visit> {
  const sb = await supabase();
  const { data, error } = await sb.rpc('visit_town', { p_town: town.id });
  if (error) throw new Error(/not open to visitors/i.test(error.message) ? `${town.name} is no longer open to visitors.` : worldError(error));
  const d = data as { path: string; enc?: 'gzip' | 'json'; revision: number; saved_at: string | null; mayor?: string; playing?: boolean };
  let file = files.get(town.id);
  if (!file || file.revision !== d.revision) {
    const res = await sb.storage.from('saves').download(d.path);
    if (res.error || !res.data) throw new Error(`${town.name} could not be downloaded (${errText(res.error ?? 'no data')}).`);
    file = { revision: d.revision, blob: res.data, enc: d.enc === 'json' ? 'json' : 'gzip' };
  }
  files.delete(town.id);
  files.set(town.id, file);
  while (files.size > KEEP_FILES) files.delete(files.keys().next().value as string);
  const state = await decode(file.blob, file.enc, VISIT_MAX_BYTES);
  return { town, state, revision: d.revision, savedAt: d.saved_at, mayor: d.mayor || town.mayor, playing: !!d.playing };
}

/** Puts one of the player's towns on the world map or takes it off. */
export async function setOnMap(worldId: string, onMap: boolean): Promise<void> {
  const sb = await supabase();
  const { data, error } = await sb.rpc('set_town_public', { p_world_id: worldId, p_public: onMap });
  if (error) throw new Error(worldError(error));
  if (data !== true) throw new Error('This town is not in your account yet. It goes on the map after its first cloud save.');
  if (last) last = { ...last, towns: last.towns.map((t) => (t.worldId === worldId ? { ...t, onMap } : t)) };
  await refreshTowns();
}
