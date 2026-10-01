// Road network: travel times, path finding, traffic assignment (commutes + freight), road wear.

import { idx, inMap, travelMinutes, W, type Sim } from '../core';
import { ROAD_CAPACITY, ROAD_SPEED } from '../tables';
import { TILE, Terrain } from '../types';

const N = W * W;
const DIRS = [1, -1, W, -W];

class Heap {
  ids: Int32Array;
  keys: Float64Array;
  size = 0;
  constructor(cap: number) { this.ids = new Int32Array(cap); this.keys = new Float64Array(cap); }
  clear() { this.size = 0; }
  push(id: number, key: number) {
    if (this.size >= this.ids.length) {
      const ni = new Int32Array(this.ids.length * 2); ni.set(this.ids); this.ids = ni;
      const nk = new Float64Array(this.keys.length * 2); nk.set(this.keys); this.keys = nk;
    }
    let i = this.size++;
    const ids = this.ids, keys = this.keys;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p]; i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids[--this.size], lastKey = keys[this.size];
    let i = 0;
    const n = this.size;
    while (true) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= lastKey) break;
      ids[i] = ids[c]; keys[i] = keys[c]; i = c;
    }
    ids[i] = lastId; keys[i] = lastKey;
    return top;
  }
  topKey() { return this.keys[0]; }
}

const heap = new Heap(4096);
const dist = new Float64Array(N);
const prev = new Int32Array(N);
const stamp = new Int32Array(N);
const done = new Int32Array(N);
let stampN = 1;

/** Seconds needed to traverse each road tile given current volume and condition. */
export function refreshTileTimes(sim: Sim): void {
  const m = sim.s.map, vol = sim.s.traffic.volume, tt = sim.s.traffic.tileTime;
  for (let i = 0; i < N; i++) {
    const cls = m.road[i];
    if (!cls) { tt[i] = 0; continue; }
    const ratio = vol[i] / ROAD_CAPACITY[cls];
    const bpr = Math.min(6, 1 + 0.15 * ratio * ratio * ratio * ratio);
    const cond = m.roadCond[i];
    const condF = cond < 0.35 ? 1 + (0.35 - cond) * 2.5 : 1;
    tt[i] = (TILE / (ROAD_SPEED[cls] / 3.6)) * bpr * condF;
  }
  // cached routes were computed with the old times
  sim.ix.pathCache.clear();
  sim.ix.roadsDirty = false;
}

function ensureTimes(sim: Sim) {
  if (sim.ix.roadsDirty) refreshTileTimes(sim);
}

/** A* path over road tiles. Returns [] when unreachable. */
export function findPath(sim: Sim, from: number, to: number): number[] {
  if (from < 0 || to < 0) return [];
  ensureTimes(sim);
  const key = from * N + to;
  const cached = sim.ix.pathCache.get(key);
  if (cached) return cached;
  const m = sim.s.map, tt = sim.s.traffic.tileTime;
  if (!m.road[from] || !m.road[to]) return [];
  const s = ++stampN;
  heap.clear();
  const tx = to % W, ty = (to / W) | 0;
  const vmax = TILE / (80 / 3.6);
  const h = (i: number) => (Math.abs((i % W) - tx) + Math.abs(((i / W) | 0) - ty)) * vmax;
  stamp[from] = s; dist[from] = 0; prev[from] = -1;
  heap.push(from, h(from));
  let found = false;
  while (heap.size) {
    const i = heap.pop();
    if (i === to) { found = true; break; }
    const di = dist[i];
    const x = i % W;
    for (let k = 0; k < 4; k++) {
      const j = i + DIRS[k];
      if (j < 0 || j >= N) continue;
      if ((k === 0 && x === W - 1) || (k === 1 && x === 0)) continue;
      if (!m.road[j]) continue;
      const nd = di + tt[j];
      if (stamp[j] !== s || nd < dist[j]) {
        stamp[j] = s; dist[j] = nd; prev[j] = i;
        heap.push(j, nd + h(j));
      }
    }
  }
  if (!found) return [];
  const path: number[] = [];
  for (let i = to; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  if (sim.ix.pathCache.size > 4000) sim.ix.pathCache.clear();
  sim.ix.pathCache.set(key, path);
  return path;
}

export function pathSeconds(sim: Sim, path: number[]): number {
  const tt = sim.s.traffic.tileTime;
  let t = 0;
  for (const i of path) t += tt[i];
  return t;
}

export function pathKm(path: number[]): number { return (path.length * TILE) / 1000; }

/** Highway end tiles at the map edge, used for imports and exports. */
export function edgeTiles(sim: Sim): number[] {
  const m = sim.s.map;
  const out: number[] = [];
  for (let y = 0; y < W; y++) {
    if (m.road[idx(0, y)] === 3) out.push(idx(0, y));
    if (m.road[idx(W - 1, y)] === 3) out.push(idx(W - 1, y));
  }
  if (!out.length) for (let i = 0; i < N; i++) if (m.road[i]) { out.push(i); break; }
  return out;
}

export function nearestEdge(sim: Sim, tile: number): number {
  const edges = edgeTiles(sim);
  let best = edges[0], bd = Infinity;
  for (const e of edges) {
    const d = Math.abs((e % W) - (tile % W)) + Math.abs(((e / W) | 0) - ((tile / W) | 0));
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

const VEQ = [0, 0, 0.4, 0.83, 0.04]; // vehicle equivalents per commuter by mode
const PEAK_SHARE = 0.45;

/** Assigns commuter and freight traffic to the network and updates commute times. */
export function assignTraffic(sim: Sim): void {
  ensureTimes(sim);
  const s = sim.s, m = s.map, tt = s.traffic.tileTime;
  const vol = new Float64Array(N);
  // group commuters by workplace access tile
  const groups = new Map<number, { origin: number; cit: number }[]>();
  for (const c of s.citizens) {
    if (c.status !== 'working' && c.status !== 'owner') continue;
    const home = sim.homeOf(c), work = sim.workplaceOf(c);
    if (!home || !work || home.id === work.id || home.access < 0 || work.access < 0) { if (!home || !work) c.commute = 0; continue; }
    const h = sim.hh(c.hh);
    let g = groups.get(work.access);
    if (!g) { g = []; groups.set(work.access, g); }
    g.push({ origin: home.access, cit: c.id });
    // mode may change as households buy vehicles
    const km = c.commuteKm || 1;
    c.mode = km < 1.2 ? 1 : h?.car && sim.age(c) >= 18 ? 3 : h?.bike && km < 15 ? 2 : s.gov.policies.busService > 0 && km > 1.8 ? 4 : 1;
  }
  let totalCommute = 0, commuters = 0;
  for (const [dest, list] of groups) {
    const st = ++stampN;
    heap.clear();
    stamp[dest] = st; dist[dest] = 0; prev[dest] = -1;
    heap.push(dest, 0);
    const need = new Set<number>();
    for (const o of list) need.add(o.origin);
    let remaining = need.size;
    while (heap.size && remaining > 0) {
      const key = heap.topKey();
      const i = heap.pop();
      if (key > dist[i] || done[i] === st) continue;
      done[i] = st;
      if (need.has(i)) remaining--;
      const x = i % W;
      const di = dist[i];
      for (let k = 0; k < 4; k++) {
        const j = i + DIRS[k];
        if (j < 0 || j >= N) continue;
        if ((k === 0 && x === W - 1) || (k === 1 && x === 0)) continue;
        if (!m.road[j]) continue;
        const nd = di + tt[j];
        if (stamp[j] !== st || nd < dist[j]) { stamp[j] = st; dist[j] = nd; prev[j] = i; heap.push(j, nd); }
      }
    }
    for (const o of list) {
      const c = sim.cit(o.cit)!;
      if (stamp[o.origin] !== st) { c.commute = travelMinutes(c.commuteKm, 1, 1); continue; }
      let steps = 0;
      const veq = VEQ[c.mode] ?? 0;
      for (let i = o.origin; i !== -1; i = prev[i]) { steps++; if (veq) vol[i] += veq; }
      const km = (steps * TILE) / 1000;
      c.commuteKm = km;
      const inVehicle = dist[o.origin] / 60;
      switch (c.mode) {
        case 1: c.commute = (km / 4.8) * 60; break;
        case 2: c.commute = 3 + inVehicle * 0.9; break;
        case 3: c.commute = 6 + inVehicle; break;
        case 4: c.commute = (s.gov.policies.busService >= 2 ? 8 : 16) + inVehicle * 1.5; break;
        default: c.commute = 0;
      }
      totalCommute += c.commute; commuters++;
    }
  }
  // freight: truck passes over the period, converted to peak-hour passenger car units
  const tl = s.traffic.truckLoad;
  const days = 7;
  for (let i = 0; i < N; i++) {
    s.traffic.volume[i] = m.road[i] ? vol[i] * PEAK_SHARE + (tl[i] / (days * 10)) * 2.5 : 0;
    tl[i] = 0;
  }
  // congestion index: average delay factor weighted by volume
  let wsum = 0, dsum = 0;
  for (let i = 0; i < N; i++) {
    const cls = m.road[i];
    if (!cls) continue;
    const v = s.traffic.volume[i];
    if (v <= 0) continue;
    const ratio = v / ROAD_CAPACITY[cls];
    wsum += v;
    dsum += v * Math.min(6, 1 + 0.15 * ratio ** 4);
  }
  s.traffic.congestion = wsum > 0 ? dsum / wsum : 1;
  s.traffic.avgCommute = commuters ? totalCommute / commuters : 0;
  s.traffic.lastRun = sim.day;
  refreshTileTimes(sim);
}

export function transportDaily(sim: Sim): void {
  const s = sim.s, m = s.map;
  if (sim.day - s.traffic.lastRun >= 7) assignTraffic(sim);
  // wear and weather damage (sampled every 5 days to keep it cheap)
  if (sim.day % 5 === 0) {
    const flood = s.weather.flood <= 4;
    for (let i = 0; i < N; i++) {
      const cls = m.road[i];
      if (!cls) continue;
      let wear = 5 * (0.0002 + s.traffic.volume[i] * 3e-7) * (cls === 3 ? 0.8 : 1);
      if (flood && m.terrain[i] === Terrain.Water) wear += 0.02;
      m.roadCond[i] = Math.max(0.02, m.roadCond[i] - wear);
    }
  }
  if (s.weather.flood === 0) {
    // roads next to the river take damage when it floods
    for (let i = 0; i < N; i++) {
      if (!m.road[i]) continue;
      const x = i % W, y = (i / W) | 0;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (inMap(x + dx, y + dy) && m.terrain[idx(x + dx, y + dy)] === Terrain.Water) { near = true; break; }
      }
      if (near) m.roadCond[i] = Math.max(0.02, m.roadCond[i] - 0.15);
    }
    refreshTileTimes(sim);
  }
}

/** Monthly road maintenance funded by the transport budget. */
export function roadMaintenance(sim: Sim, funding: number): void {
  const m = sim.s.map;
  for (let i = 0; i < N; i++) {
    const cls = m.road[i];
    if (!cls) continue;
    const wear = 30 * (0.0002 + sim.s.traffic.volume[i] * 3e-7);
    m.roadCond[i] = Math.min(0.97, m.roadCond[i] + wear * 1.25 * funding);
  }
  refreshTileTimes(sim);
}

export function roadStats(sim: Sim): { tiles: number; km: number; poor: number; avgCond: number } {
  const m = sim.s.map;
  let tiles = 0, poor = 0, cond = 0;
  for (let i = 0; i < N; i++) if (m.road[i]) { tiles++; cond += m.roadCond[i]; if (m.roadCond[i] < 0.35) poor++; }
  return { tiles, km: (tiles * TILE) / 1000, poor: tiles ? poor / tiles : 0, avgCond: tiles ? cond / tiles : 0 };
}
