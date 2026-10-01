// Paints the ground texture (land use, crops at their current stage, water) and the data-layer overlays straight
// from the simulation state.

import type { Sim } from '../sim/core';
import { hash01 } from '../sim/rng';
import { BUILDINGS, CROPS, ROAD_CAPACITY } from '../sim/tables';
import { MAP_SIZE, Terrain, Zone } from '../sim/types';

export const N = MAP_SIZE;
export const PX = 4; // texels per tile
export const TEX = N * PX;

export type Overlay = 'none' | 'zoning' | 'landValue' | 'pollution' | 'traffic' | 'roads' | 'health' | 'schools' | 'police';

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

const GRASS: RGB = [118, 146, 82];
const FOREST: RGB = [66, 94, 52];
const WATER: RGB = [56, 110, 148];
const CANAL: RGB = [72, 128, 158];
const SOIL: RGB = [112, 88, 58];
const PLOWED: RGB = [98, 74, 48];
const DRY: RGB = [150, 128, 90];
const YOUNG: RGB = [96, 142, 62];
const STUBBLE: RGB = [176, 156, 104];
const BLIGHT: RGB = [150, 125, 70];
const PAVED: RGB = [176, 171, 160];
const CONCRETE: RGB = [158, 154, 144];
const YARD: RGB = [150, 132, 96];
const GARDEN: RGB = [110, 148, 78];
const PARK: RGB = [84, 148, 70];
const SIDEWALK: RGB = [166, 164, 156];
const SITE: RGB = [140, 118, 86];

function farmLook(sim: Sim, fid: number): { c: RGB; rows: boolean } {
  const f = sim.biz(fid)?.farm;
  if (!f) return { c: DRY, rows: false };
  const crop = f.crop ? CROPS[f.crop] : null;
  const mature: RGB = crop ? [crop.color[0] * 255, crop.color[1] * 255, crop.color[2] * 255] : DRY;
  const sick = (c: RGB) => (f.health < 0.7 ? mix(c, BLIGHT, (0.7 - f.health) * 1.3) : c);
  switch (f.phase) {
    case 'fallow': return { c: f.phaseDays > 60 ? mix(DRY, GRASS, 0.35) : DRY, rows: false };
    case 'preparing': return { c: PLOWED, rows: true };
    case 'sowing': return { c: SOIL, rows: true };
    case 'growing': return { c: sick(f.growth < 0.5 ? mix(SOIL, YOUNG, f.growth / 0.5) : mix(YOUNG, mature, (f.growth - 0.5) / 0.5)), rows: true };
    case 'ready': return { c: sick(mature), rows: true };
    case 'harvesting': return { c: mix(mature, STUBBLE, 0.55), rows: true };
  }
}

function urban(sim: Sim, t: number): boolean {
  const z = sim.s.map.zone[t];
  return z === Zone.Residential || z === Zone.Commercial || z === Zone.Industrial;
}

function tileLook(sim: Sim, t: number): { c: RGB; rows: boolean } {
  const m = sim.s.map;
  const tt = m.terrain[t];
  if (tt === Terrain.Water) return { c: WATER, rows: false };
  if (tt === Terrain.Canal) return { c: CANAL, rows: false };
  if (m.farm[t] >= 0) return farmLook(sim, m.farm[t]);
  if (m.project[t] >= 0 && m.road[t] === 0) return { c: SITE, rows: false };
  const o = m.owner[t];
  if (o >= 0) {
    const b = sim.bld(o);
    if (b) {
      if (b.kind === 'park') return { c: PARK, rows: false };
      switch (BUILDINGS[b.kind].category) {
        case 'residential': return { c: GARDEN, rows: false };
        case 'industrial': return { c: CONCRETE, rows: false };
        case 'agricultural': return { c: YARD, rows: false };
        default: return { c: PAVED, rows: false };
      }
    }
  }
  if (m.road[t] > 0) return { c: urban(sim, t) ? SIDEWALK : GRASS, rows: false };
  if (m.zone[t] === Zone.Park) return { c: PARK, rows: false };
  if (tt === Terrain.Forest) return { c: FOREST, rows: false };
  if (tt === Terrain.Farmland) return { c: mix(DRY, GRASS, 0.5), rows: false };
  switch (m.zone[t]) {
    case Zone.Residential: return { c: mix(GRASS, [150, 162, 110], 0.25), rows: false };
    case Zone.Commercial: return { c: mix(GRASS, PAVED, 0.3), rows: false };
    case Zone.Industrial: return { c: mix(GRASS, CONCRETE, 0.35), rows: false };
    default: return { c: mix(GRASS, FOREST, 0.12 * hash01(t, 5)), rows: false };
  }
}

/** Paints ground texels for the given tiles (all tiles when omitted). Row 0 of the texture is the map's south edge. */
export function paintTerrain(sim: Sim, data: Uint8Array, tiles?: Iterable<number>): void {
  const paint = (t: number) => {
    const { c, rows } = tileLook(sim, t);
    const tx = t % N, ty = (t / N) | 0;
    const vertical = (sim.s.map.farm[t] & 1) === 1;
    const water = sim.s.map.terrain[t] === Terrain.Water;
    for (let py = 0; py < PX; py++) {
      const row = TEX - 1 - (ty * PX + py);
      for (let px = 0; px < PX; px++) {
        const gx = tx * PX + px, gy = ty * PX + py;
        let k = 1 + (hash01(gx * 7919 + gy, 11) - 0.5) * (water ? 0.05 : 0.09);
        if (rows && ((vertical ? px : py) & 1) === 0) k *= 0.86;
        const i = (row * TEX + gx) * 4;
        data[i] = Math.min(255, c[0] * k);
        data[i + 1] = Math.min(255, c[1] * k);
        data[i + 2] = Math.min(255, c[2] * k);
        data[i + 3] = 255;
      }
    }
  };
  if (tiles) for (const t of tiles) paint(t);
  else for (let t = 0; t < N * N; t++) paint(t);
}

const HEAT: [number, RGB][] = [[0, [49, 54, 149]], [0.25, [69, 117, 180]], [0.5, [254, 224, 144]], [0.75, [244, 109, 67]], [1, [165, 0, 38]]];
const GOOD: [number, RGB][] = [[0, [215, 48, 39]], [0.5, [254, 224, 139]], [1, [26, 152, 80]]];

export function ramp(stops: [number, RGB][], v: number): RGB {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return stops[stops.length - 1][1];
}
export const heat = (v: number) => ramp(HEAT, v);
export const goodBad = (v: number) => ramp(GOOD, v);

export const ZONE_RGB: Record<number, RGB> = {
  [Zone.Residential]: [95, 191, 106], [Zone.Commercial]: [90, 143, 224], [Zone.Industrial]: [224, 184, 90], [Zone.Agricultural]: [184, 192, 112], [Zone.Park]: [40, 120, 50],
};

/** Paints an N x N RGBA overlay. */
export function paintOverlay(sim: Sim, kind: Overlay, data: Uint8Array): void {
  data.fill(0);
  if (kind === 'none') return;
  const s = sim.s, m = s.map;
  const put = (t: number, c: RGB, a: number) => {
    const x = t % N, y = (t / N) | 0;
    const i = ((N - 1 - y) * N + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = a;
  };
  for (let t = 0; t < N * N; t++) {
    const water = m.terrain[t] === Terrain.Water;
    const x = t % N, y = (t / N) | 0;
    switch (kind) {
      case 'zoning': { const c = ZONE_RGB[m.zone[t]]; if (c && !m.road[t]) put(t, c, m.zone[t] === Zone.Agricultural ? 70 : 150); break; }
      case 'landValue': if (!water) put(t, heat(m.landValue[t] / 1.2), 140); break;
      case 'pollution': { const v = s.env.pollution[Math.min(31, y >> 2) * 32 + Math.min(31, x >> 2)]; if (v > 0.02) put(t, heat(0.35 + v * 0.8), Math.min(200, 40 + v * 300)); break; }
      case 'health': case 'schools': case 'police': {
        const cov = kind === 'health' ? s.services.healthCov : kind === 'schools' ? s.services.schoolCov : s.services.policeCov;
        const v = cov[Math.min(15, y >> 3) * 16 + Math.min(15, x >> 3)];
        if (!water) put(t, goodBad(v), m.owner[t] >= 0 || urban(sim, t) ? 150 : 70);
        break;
      }
      case 'traffic': case 'roads': if (!m.road[t]) put(t, [12, 16, 22], 120); break;
    }
  }
}

const ROAD_RGB = [0, 0x6b6f75, 0x575b61, 0x46494e];

export function roadColor(sim: Sim, t: number, overlay: Overlay): number {
  const m = sim.s.map, cls = m.road[t];
  const toHex = (c: RGB) => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
  if (overlay === 'traffic') return toHex(ramp([[0, [26, 152, 80]], [0.6, [254, 224, 139]], [1, [215, 48, 39]]], s01(sim.s.traffic.volume[t] / ROAD_CAPACITY[cls])));
  if (overlay === 'roads') return toHex(goodBad((m.roadCond[t] - 0.2) / 0.7));
  return m.terrain[t] === Terrain.Water ? 0x7b7f86 : ROAD_RGB[cls];
}

const s01 = (v: number) => Math.max(0, Math.min(1, v));
