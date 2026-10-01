// Cloud copies of towns: one row per town in public.towns plus its compressed save files in the private "saves"
// bucket, under <user id>/<world id>/. Every upload becomes the next revision; the newest few files are kept.

import { formatDate } from '../sim/calendar';
import { STATE_VERSION } from '../sim/migrate';
import type { WorldState } from '../sim/types';
import { decode } from '../game/persist';
import { deviceId, supabase } from './client';
import { cloud, setCloud, type CloudTown } from './store';

const BUCKET = 'saves';
const KEEP_FILES = 3;

interface TownRow {
  world_id: string; name: string; preset: string; condition: string; population: number; sim_minute: number; sim_date: string;
  revision: number; saved_at: string | null; save_path: string | null; save_size: number; save_enc: 'gzip' | 'json';
  lease_device: string | null; lease_until: string | null;
}
const COLUMNS = 'world_id,name,preset,condition,population,sim_minute,sim_date,revision,saved_at,save_path,save_size,save_enc,lease_device,lease_until';

const toTown = (r: TownRow): CloudTown => ({
  worldId: r.world_id, name: r.name, preset: r.preset, condition: r.condition, population: r.population, minute: r.sim_minute, date: r.sim_date,
  revision: r.revision, savedAt: r.saved_at, path: r.save_path, size: r.save_size, enc: r.save_enc, leaseDevice: r.lease_device, leaseUntil: r.lease_until,
});

/** Reloads the list of the account's towns in the cloud. */
export async function refreshTowns(): Promise<CloudTown[]> {
  const sb = await supabase();
  const { data, error } = await sb.from('towns').select(COLUMNS).order('saved_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  const towns = ((data ?? []) as TownRow[]).map(toTown);
  setCloud({ towns });
  return towns;
}

export interface Claim {
  granted: boolean; // this device may play the town now
  revision: number; // latest revision in the cloud (0 = nothing uploaded yet)
  path: string | null;
  enc: 'gzip' | 'json';
  savedAt: string | null;
  minute: number;
  leaseUntil: string | null; // when refused: until when the other device holds it (unless renewed)
}

/** Asks to play a town on this device; creates its cloud record the first time. */
export async function claimTown(worldId: string, force = false): Promise<Claim> {
  const sb = await supabase();
  const { data, error } = await sb.rpc('claim_town', { p_world_id: worldId, p_device: deviceId(), p_force: force });
  if (error) throw error;
  const d = data as { granted: boolean; revision: number; path: string | null; enc?: 'gzip' | 'json'; saved_at: string | null; minute: number; lease_until?: string };
  return { granted: d.granted, revision: d.revision, path: d.path, enc: d.enc ?? 'gzip', savedAt: d.saved_at, minute: d.minute, leaseUntil: d.lease_until ?? null };
}

/** Keeps this device's claim alive. False when another device has taken the town over. */
export async function renewLease(worldId: string): Promise<boolean> {
  const sb = await supabase();
  const { data, error } = await sb.rpc('renew_lease', { p_world_id: worldId, p_device: deviceId() });
  if (error) throw error;
  return data === true;
}

export async function releaseLease(worldId: string): Promise<void> {
  const sb = await supabase();
  const { error } = await sb.rpc('release_lease', { p_world_id: worldId, p_device: deviceId() });
  if (error) throw error;
}

/** What the cloud list shows about a save, taken from the state at the moment it is encoded. */
export function describe(state: WorldState): Record<string, string | number> {
  return {
    name: state.meta.name, preset: state.meta.preset, condition: state.meta.condition, population: state.citizens.length,
    minute: state.minute, date: formatDate(state.meta.startYear, state.minute, false), version: STATE_VERSION,
  };
}

export type Commit = { ok: true; revision: number } | { ok: false; reason: 'conflict' | 'lease' | 'missing'; revision: number };

/** Uploads an encoded save file and records it as the revision after `base`. */
export async function uploadSave(worldId: string, blob: Blob, enc: 'gzip' | 'json', meta: Record<string, string | number>, base: number, force = false): Promise<Commit> {
  const sb = await supabase();
  const uid = cloud().account?.id;
  if (!uid) throw new Error('Not signed in.');
  const path = `${uid}/${worldId}/${base + 1}-${deviceId().slice(0, 9)}-${Date.now().toString(36)}.mandate`;
  const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'application/octet-stream', upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await sb.rpc('commit_save', {
    p_world_id: worldId, p_device: deviceId(), p_base_revision: base, p_force: force, p_path: path, p_meta: { ...meta, size: blob.size, enc },
  });
  const res = data as { ok: boolean; reason?: 'conflict' | 'lease' | 'missing'; revision?: number } | null;
  if (error || !res?.ok) {
    await sb.storage.from(BUCKET).remove([path]); // the file was not recorded, so it would only take up space
    if (error) throw error;
    return { ok: false, reason: res?.reason ?? 'conflict', revision: res?.revision ?? base };
  }
  void prune(uid, worldId, path).catch(() => { /* tidying is best effort */ });
  return { ok: true, revision: res.revision ?? base + 1 };
}

/** Keeps the newest few files of a town (always including the current one) and removes the rest. */
async function prune(uid: string, worldId: string, current: string): Promise<void> {
  const sb = await supabase();
  const { data, error } = await sb.storage.from(BUCKET).list(`${uid}/${worldId}`, { limit: 100 });
  if (error || !data) return;
  const files = data.map((f) => ({ path: `${uid}/${worldId}/${f.name}`, rev: parseInt(f.name, 10) || 0 })).sort((a, b) => b.rev - a.rev);
  const old = files.slice(KEEP_FILES).map((f) => f.path).filter((p) => p !== current);
  if (old.length) await sb.storage.from(BUCKET).remove(old);
}

export async function downloadSave(path: string, enc: 'gzip' | 'json'): Promise<WorldState> {
  const sb = await supabase();
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw error ?? new Error('The cloud copy could not be downloaded.');
  return decode(data, enc);
}

/** Removes a town and all its files from the account. */
export async function deleteCloudTown(worldId: string): Promise<void> {
  const sb = await supabase();
  const uid = cloud().account?.id;
  if (!uid) return;
  const { data } = await sb.storage.from(BUCKET).list(`${uid}/${worldId}`, { limit: 100 });
  if (data?.length) await sb.storage.from(BUCKET).remove(data.map((f) => `${uid}/${worldId}/${f.name}`));
  const { error } = await sb.from('towns').delete().eq('owner', uid).eq('world_id', worldId);
  if (error) throw error;
  await refreshTowns();
}
