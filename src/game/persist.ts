// Save storage. Worlds are stored in IndexedDB, gzip-compressed when the browser supports CompressionStream.
// Each world has a rolling autosave, three rotating backups and any number of named manual saves.

import { formatDate } from '../sim/calendar';
import { STATE_VERSION } from '../sim/migrate';
import type { WorldState } from '../sim/types';

export type SaveKind = 'auto' | 'backup' | 'manual';

export interface SaveMeta {
  key: string;
  worldId: string;
  kind: SaveKind;
  label: string;
  name: string; // city name
  preset: string;
  savedAt: number; // real ms
  minute: number; // sim minute
  date: string; // in-world date of the save
  population: number;
  size: number; // bytes stored
  enc: 'gzip' | 'json';
  condition?: string; // how the town started (missing in older saves)
  plot?: number; // plot chosen on the world map
}

const DB_NAME = 'mandate';
const DB_VERSION = 1;
const LAST_KEY = 'mandate.last';
export const SAVE_VERSION = STATE_VERSION;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T | undefined;
    const req = fn(t);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
  }));
}

// ------------------------------------------------------------------------------------------------ encoding

const hasGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export async function encode(state: WorldState): Promise<{ blob: Blob; enc: 'gzip' | 'json' }> {
  const json = JSON.stringify(state);
  const raw = new Blob([json], { type: 'application/json' });
  if (!hasGzip()) return { blob: raw, enc: 'json' };
  const stream = raw.stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  return { blob: new Blob([blob], { type: 'application/gzip' }), enc: 'gzip' };
}

const TOO_LARGE = 'The save file is too large to open.';

/** Reads a stream as text, giving up past `max` bytes, so a small file that inflates enormously cannot exhaust memory. */
async function readLimited(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => { /* already failing */ }); throw new Error(TOO_LARGE); }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[]).text();
}

/**
 * Turns a stored or downloaded file back into a world. `maxBytes` limits the size of the unpacked file; use it for
 * files from other players.
 */
export async function decode(blob: Blob, enc?: 'gzip' | 'json', maxBytes = Infinity): Promise<WorldState> {
  let text: string;
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gz = enc === 'gzip' || (head[0] === 0x1f && head[1] === 0x8b);
  if (gz) {
    if (!hasGzip()) throw new Error('This browser cannot read compressed saves.');
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    text = Number.isFinite(maxBytes) ? await readLimited(stream, maxBytes) : await new Response(stream).text();
  } else {
    if (blob.size > maxBytes) throw new Error(TOO_LARGE);
    text = await blob.text();
  }
  const state = JSON.parse(text) as WorldState;
  validate(state);
  return state;
}

/** Throws if the object is not a world this version can load. */
export function validate(s: WorldState): void {
  if (!s || typeof s !== 'object') throw new Error('Not a save file.');
  if (typeof s.v !== 'number' || s.v > SAVE_VERSION) throw new Error('This save was made by a newer version of the game.');
  if (!s.meta?.id || !Array.isArray(s.citizens) || !Array.isArray(s.buildings) || !s.map?.terrain?.length) throw new Error('The save file is damaged.');
}

// ------------------------------------------------------------------------------------------------ slots

export function autoKey(worldId: string) { return `auto:${worldId}`; }

export async function putSave(state: WorldState, kind: SaveKind, label: string, key?: string): Promise<SaveMeta> {
  const { blob, enc } = await encode(state);
  const k = key ?? (kind === 'auto' ? autoKey(state.meta.id) : `${kind}:${state.meta.id}:${Date.now().toString(36)}`);
  const meta: SaveMeta = {
    key: k, worldId: state.meta.id, kind, label, name: state.meta.name, preset: state.meta.preset, savedAt: Date.now(),
    minute: state.minute, date: formatDate(state.meta.startYear, state.minute, false), population: state.citizens.length, size: blob.size, enc,
    condition: state.meta.condition, ...(state.meta.plot !== undefined ? { plot: state.meta.plot } : {}),
  };
  await tx(['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('data').put({ key: k, blob });
    t.objectStore('meta').put(meta);
  });
  if (kind === 'auto') try { localStorage.setItem(LAST_KEY, k); } catch { /* storage may be unavailable */ }
  return meta;
}

export async function listSaves(): Promise<SaveMeta[]> {
  const all = (await tx<SaveMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll() as IDBRequest<SaveMeta[]>)) ?? [];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function readSave(key: string): Promise<WorldState> {
  const [meta, rec] = await Promise.all([
    tx<SaveMeta>(['meta'], 'readonly', (t) => t.objectStore('meta').get(key) as IDBRequest<SaveMeta>),
    tx<{ key: string; blob: Blob }>(['data'], 'readonly', (t) => t.objectStore('data').get(key) as IDBRequest<{ key: string; blob: Blob }>),
  ]);
  if (!rec) throw new Error('Save not found.');
  return decode(rec.blob, meta?.enc);
}

/** Loads a world, falling back to the newest readable backup if the save is damaged. */
export async function readWithRecovery(key: string): Promise<{ state: WorldState; recoveredFrom?: SaveMeta }> {
  try {
    return { state: await readSave(key) };
  } catch (err) {
    const saves = await listSaves();
    const worldId = saves.find((s) => s.key === key)?.worldId ?? key.split(':')[1];
    for (const b of saves.filter((s) => s.worldId === worldId && s.key !== key)) {
      try { return { state: await readSave(b.key), recoveredFrom: b }; } catch { /* try the next one */ }
    }
    throw err;
  }
}

export async function deleteSave(key: string): Promise<void> {
  await tx(['meta', 'data'], 'readwrite', (t) => { t.objectStore('meta').delete(key); t.objectStore('data').delete(key); });
}

export async function deleteWorld(worldId: string): Promise<void> {
  for (const s of await listSaves()) if (s.worldId === worldId) await deleteSave(s.key);
  try { if (localStorage.getItem(LAST_KEY)?.includes(worldId)) localStorage.removeItem(LAST_KEY); } catch { /* ignore */ }
}

/** Keeps the three most recent backups of a world. */
export async function rotateBackup(state: WorldState): Promise<void> {
  await putSave(state, 'backup', 'Automatic backup');
  const old = (await listSaves()).filter((s) => s.worldId === state.meta.id && s.kind === 'backup');
  for (const s of old.slice(3)) await deleteSave(s.key);
}

export function lastPlayedKey(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
