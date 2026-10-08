// Meridia, the world map: the hub of the game. Every region is a continent of hexagonal plots; every town is a plot.
// Players see their own towns (on this device and in their account) and everybody else's, visit other mayors' towns,
// and found new towns by picking a free plot on a continent. The map works offline too: then it shows the towns on
// this device only.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { deleteWorld, listSaves, storageAvailable, type SaveMeta } from '../game/persist';
import { playAsGuest, startCloud } from '../net/auth';
import { cloudConfigured, errText, within } from '../net/client';
import { deleteCloudTown } from '../net/saves';
import { useCloud } from '../net/store';
import { forgetLocal } from '../net/sync';
import { cachedWorld, fetchWorld, worldError, type WorldTown } from '../net/world';
import { BUILD_MODES } from '../sim/commands';
import { hash01 } from '../sim/rng';
import { OFFLINE_CAPS, PACES, PRESETS, START_OPTIONS, START_YEARS, getPreset } from '../sim/presets';
import { CROPS } from '../sim/tables';
import type { BuildMode, CropId } from '../sim/types';
import type { NewWorldOptions } from '../sim/worldgen';
import { AccountPanel } from './account';
import { mayorTitle, num, pct, realSpan } from './util';

/** The name of the shared world every town belongs to. */
export const WORLD_NAME = 'Meridia';

// ------------------------------------------------------------------------------------------------ hex geometry

/** Hexagon radius in map units (pointy-top hexagons). */
const HS = 10;
const COL = HS * Math.sqrt(3), ROW = HS * 1.5;
const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** The ring a plot falls in: plot 0 is a region's centre, and ring k holds the next 6k plots around it. */
export function ringOf(n: number): number {
  let k = 0;
  while (1 + 3 * k * (k + 1) <= n) k++;
  return k;
}

/** Axial hex coordinates of a plot, numbered outwards from the centre ring by ring (as the server hands them out). */
export function hexAt(n: number): [number, number] {
  const k = ringOf(n);
  if (k === 0) return [0, 0];
  let i = n - (1 + 3 * k * (k - 1));
  let q = -k, r = k;
  for (let side = 0; side < 6 && i > 0; side++) {
    const steps = Math.min(i, k);
    q += DIRS[side][0] * steps;
    r += DIRS[side][1] * steps;
    i -= steps;
  }
  return [q, r];
}

const toPx = (q: number, r: number): [number, number] => [COL * (q + r / 2), ROW * r];
/** Plots in rings 0..k. */
const cells = (rings: number) => 1 + 3 * rings * (rings + 1);

function hexPath(x: number, y: number, s: number): string {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    d += `${i ? 'L' : 'M'}${(x + s * Math.cos(a)).toFixed(1)} ${(y + s * Math.sin(a)).toFixed(1)}`;
  }
  return `${d}Z`;
}

// ------------------------------------------------------------------------------------------------ layout

/**
 * Where each region's continent lies (roughly as on a real map), its colours and scenery, and its outline: beyond a
 * hexagonal heartland of plots, the land runs out into peninsulas and capes that are stretched east-west (`ex`) or
 * north-south (`ey`) by region, so no two continents share a shape. `lakes` are inland lakes on those outer lands.
 */
interface RegionLook { at: [number, number]; land: string; shore: string; trees: number; hills: number; ex: number; ey: number; lakes?: number }

const LOOKS: Record<string, RegionLook> = {
  fictional: { at: [-1.55, -1.1], land: '#6f8f5a', shore: '#b3bf92', trees: 0.34, hills: 0.12, ex: 0.7, ey: 1.3, lakes: 1 },
  'ng-savanna': { at: [-1.9, 0.35], land: '#a99a5a', shore: '#d4c58f', trees: 0.14, hills: 0.02, ex: 1.5, ey: 0.55 },
  'et-highlands': { at: [-0.5, 0.15], land: '#7f8c56', shore: '#bcc08c', trees: 0.08, hills: 0.32, ex: 1, ey: 1, lakes: 3 },
  'ke-rift': { at: [-0.85, 1.35], land: '#9a8957', shore: '#cbbb8c', trees: 0.12, hills: 0.18, ex: 0.45, ey: 1.6, lakes: 2 },
  'in-punjab': { at: [0.55, -1.2], land: '#9c9655', shore: '#cfc58f', trees: 0.06, hills: 0.01, ex: 1.4, ey: 0.6 },
  'in-deccan': { at: [0.7, 0.45], land: '#a7845a', shore: '#d2b48d', trees: 0.1, hills: 0.16, ex: 0.8, ey: 1.45 },
  'bd-delta': { at: [1.6, -0.55], land: '#5f9663', shore: '#a8c9a0', trees: 0.24, hills: 0, ex: 1.1, ey: 1.1, lakes: 2 },
  'vn-mekong': { at: [2.4, 0.35], land: '#4f8a5c', shore: '#9cc196', trees: 0.22, hills: 0.02, ex: 0.6, ey: 1.5 },
  'id-java': { at: [1.85, 1.4], land: '#4c8a55', shore: '#97c08e', trees: 0.3, hills: 0.2, ex: 1.9, ey: 0.4 },
};
const OTHER_LAND = { land: '#7b8a7c', shore: '#adb8a9', trees: 0.1, hills: 0.05, ex: 1, ey: 1 };
/** How many rings beyond the heartland the capes and peninsulas reach, at most. */
const CAPES = 4;
/** Every continent has at least this many rings of land, so there is always room to found a town. */
const MIN_RINGS = 6;

/** A town on the map: from the world server, or one kept only on this device. */
export interface MapTown extends WorldTown { local: boolean }

/** A free plot a new town can be founded on. */
export interface Spot { region: string; plot: number; x: number; y: number }

interface Continent { region: string; label: string; country: string; land: string; shore: string; x: number; y: number; top: number; landPath: string; shorePath: string; treePath: string; hillPath: string; lakePath: string; count: number }

interface Cell { ring: number; q: number; r: number; shore: boolean }

/**
 * The hexes of a continent: its heartland (rings 0..k, where towns are founded) and capes and peninsulas beyond, reaching
 * out by a few overlapping waves round the coast that are unique to the region and stretched along its long axis.
 */
function continentCells(k: number, L: { ex: number; ey: number }, salt: number): Map<number, Cell> {
  const max = k + CAPES + 1;
  const waves = [2, 3, 5].map((f, i) => ({ f, a: 0.4 + hash01(salt, 40 + i), p: hash01(salt, 50 + i) * Math.PI * 2 }));
  const total = waves.reduce((a, w) => a + w.a, 0);
  const reach = (theta: number) => {
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(theta * w.f + w.p);
    const axis = Math.abs(Math.cos(theta)) * L.ex + Math.abs(Math.sin(theta)) * L.ey;
    return k + Math.min(CAPES, Math.max(0, (0.3 + 0.7 * (v / total)) * CAPES * axis));
  };
  const key = (q: number, r: number) => (q + 64) * 256 + (r + 64);
  const land = new Map<number, Cell>(), keys = new Set<number>();
  for (let n = 0; n < cells(max); n++) {
    const ring = ringOf(n);
    const [q, r] = hexAt(n);
    const [px, py] = toPx(q, r);
    // the heartland is always land; beyond it the coast is ragged
    if (ring <= k || ring <= reach(Math.atan2(py, px)) - hash01(n, salt) * 0.9) { land.set(n, { ring, q, r, shore: false }); keys.add(key(q, r)); }
  }
  for (const c of land.values()) c.shore = DIRS.some(([dq, dr]) => !keys.has(key(c.q + dq, c.r + dr)));
  return land;
}
interface Placed { town: MapTown; x: number; y: number }
interface Layout { continents: Continent[]; placed: Placed[]; free: Spot[]; x0: number; y0: number; x1: number; y1: number }

function regionInfo(id: string): { label: string; country: string } {
  const p = PRESETS.find((x) => x.id === id);
  // towns of regions this version does not know (or no longer has) stand on the continent of other lands
  return p ? { label: p.label, country: p.country } : { label: 'Other lands', country: '' };
}

const strHash = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const regionOf = (preset: string) => (PRESETS.some((p) => p.id === preset) ? preset : 'other');

function layoutWorld(towns: MapTown[]): Layout {
  const byRegion = new Map<string, MapTown[]>();
  for (const id of Object.keys(LOOKS)) byRegion.set(id, []);
  for (const t of towns) {
    const list = byRegion.get(t.region);
    if (list) list.push(t); else byRegion.set(t.region, [t]);
  }
  const regions = [...byRegion.keys()];
  let extra = 0;
  const looks = regions.map((r) => LOOKS[r] ?? { at: [-1.6 + 1.3 * extra++, 2.3] as [number, number], ...OTHER_LAND });
  // land reaches two rings past the outermost town, so every continent has a shore and room to grow
  const rings = regions.map((r) => Math.max(MIN_RINGS, ringOf(Math.max(0, ...byRegion.get(r)!.map((t) => t.plot))) + 2));
  // capes reach CAPES rings past the heartland at most, further along the region's long axis
  const radius = (k: number) => (k + 1.6 + CAPES) * COL;
  // spread the continents far enough apart that none can touch another, however big they grow
  let s = 9.5 * COL;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const d = Math.hypot(looks[i].at[0] - looks[j].at[0], looks[i].at[1] - looks[j].at[1]);
      // with room between them for the region names
      s = Math.max(s, (radius(rings[i]) + radius(rings[j]) + COL * 3.5) / Math.max(0.3, d));
    }
  }
  const continents: Continent[] = [], placed: Placed[] = [], free: Spot[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  regions.forEach((region, i) => {
    const k = rings[i], L = looks[i];
    const cx = L.at[0] * s, cy = L.at[1] * s;
    const salt = strHash(region);
    const list = byRegion.get(region)!;
    const taken = new Set(list.map((t) => t.plot));
    let landPath = '', shorePath = '', treePath = '', hillPath = '', lakePath = '';
    const land = continentCells(k, L, salt);
    let lakes = L.lakes ?? 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [n, cell] of land) {
      const { ring, q, r } = cell;
      const [px, py] = toPx(q, r);
      const x = cx + px, y = cy + py;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      const d = hexPath(x, y, HS * 1.02);
      if (cell.shore) shorePath += d; else landPath += d;
      if (ring < k && taken.has(n)) continue;
      // inland lakes lie on the outer lands, never on a plot a town could have
      if (ring >= k && !cell.shore && lakes > 0 && hash01(n, salt + 9) < 0.07) { lakePath += hexPath(x, y, HS * 0.98); lakes--; continue; }
      // towns may be founded anywhere in the heartland; scenery decorates every plot nobody has taken
      if (ring < k) free.push({ region, plot: n, x, y });
      if (cell.shore) continue;
      const h = hash01(n, salt + 5) / (ring >= k ? 1.6 : 1);
      if (h < L.hills) {
        const w = HS * 0.55, ht = HS * 0.62;
        hillPath += `M${(x - w).toFixed(1)} ${(y + ht * 0.45).toFixed(1)}L${x.toFixed(1)} ${(y - ht * 0.55).toFixed(1)}L${(x + w).toFixed(1)} ${(y + ht * 0.45).toFixed(1)}Z`;
      } else if (h < L.hills + L.trees) {
        for (const [dx, dy, rr] of [[-3, 1.5, 2.4], [2.6, 2.2, 2.1], [0, -2.4, 2.6]]) {
          const tx = x + dx, ty = y + dy;
          treePath += `M${(tx - rr).toFixed(1)} ${ty.toFixed(1)}a${rr} ${rr} 0 1 0 ${(rr * 2).toFixed(1)} 0a${rr} ${rr} 0 1 0 ${(-rr * 2).toFixed(1)} 0`;
        }
      }
    }
    for (const t of list) {
      const [q, r] = hexAt(t.plot);
      const [px, py] = toPx(q, r);
      placed.push({ town: t, x: cx + px, y: cy + py });
    }
    const info = regionInfo(region);
    continents.push({ region, ...info, land: L.land, shore: L.shore, x: cx, y: cy, top: by0 - HS - 6, landPath, shorePath, treePath, hillPath, lakePath, count: list.length });
    x0 = Math.min(x0, bx0 - HS * 2); x1 = Math.max(x1, bx1 + HS * 2);
    y0 = Math.min(y0, by0 - HS - 40); y1 = Math.max(y1, by1 + HS * 2);
  });
  return { continents, placed, free, x0, y0, x1, y1 };
}

/**
 * The player's towns that the world server does not list (kept on this device only, or the server is out of reach),
 * placed on the plot their founder chose, or on the next free plot of their region.
 */
function mergeTowns(server: WorldTown[], locals: SaveMeta[], mayor: string): MapTown[] {
  const out: MapTown[] = server.map((t) => ({ ...t, local: false }));
  const known = new Set(server.map((t) => t.worldId).filter(Boolean));
  const taken = new Map<string, Set<number>>();
  const used = (r: string) => { let s = taken.get(r); if (!s) { s = new Set(); taken.set(r, s); } return s; };
  for (const t of out) used(t.region).add(t.plot);
  const later: [SaveMeta, string][] = [];
  const add = (s: SaveMeta, region: string, plot: number) => {
    used(region).add(plot);
    out.push({
      id: `local:${s.worldId}`, name: s.name || 'Unnamed town', mayor, region, plot, preset: s.preset, condition: s.condition ?? '',
      population: s.population, date: s.date, approval: null, unemployment: null, year: null, officeYear: null,
      savedAt: new Date(s.savedAt).toISOString(), playing: false, mine: true, onMap: false, worldId: s.worldId, local: true,
    });
  };
  for (const s of [...locals].sort((a, b) => a.savedAt - b.savedAt)) {
    if (known.has(s.worldId)) continue;
    const region = regionOf(s.preset);
    if (s.plot !== undefined && !used(region).has(s.plot)) add(s, region, s.plot);
    else later.push([s, region]);
  }
  for (const [s, region] of later) {
    let p = 0;
    while (used(region).has(p)) p++;
    add(s, region, p);
  }
  return out;
}

/** One entry per town on this device: its autosave, or else its latest save. */
function localTowns(saves: SaveMeta[]): SaveMeta[] {
  const worlds = new Map<string, SaveMeta>();
  for (const s of saves) {
    const cur = worlds.get(s.worldId);
    if (!cur || (s.kind === 'auto' && cur.kind !== 'auto') || (s.kind === cur.kind && s.savedAt > cur.savedAt)) worlds.set(s.worldId, s);
  }
  return [...worlds.values()];
}

// ------------------------------------------------------------------------------------------------ looks of a town

const POP_STOPS: [number, [number, number, number]][] = [[0, [207, 216, 196]], [0.35, [232, 220, 174]], [0.6, [241, 192, 112]], [0.8, [236, 154, 82]], [1, [217, 102, 63]]];

/** Plot colour by population: pale for a hamlet, deep orange for a city. */
function popColor(pop: number): string {
  const t = Math.max(0, Math.min(1, Math.log10(pop + 1) / Math.log10(30000)));
  for (let i = 1; i < POP_STOPS.length; i++) {
    const [t1, c1] = POP_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = POP_STOPS[i - 1];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * f)).join(',')})`;
    }
  }
  return 'rgb(217,102,63)';
}

/** A little skyline that grows with the town: [offset, width, height] of each building. */
function skyline(pop: number): [number, number, number][] {
  if (pop <= 0) return [[0, 1.2, 4.5]]; // a surveyor's flag on empty land
  if (pop < 800) return [[0, 3, 3]];
  if (pop < 3000) return [[-2, 2.8, 3.2], [1.8, 2.8, 4.6]];
  if (pop < 8000) return [[-3.4, 2.6, 3.4], [0, 2.8, 5.8], [3.4, 2.6, 4.2]];
  return [[-4.4, 2.4, 3.6], [-1.4, 2.6, 7.2], [1.6, 2.6, 5.2], [4.4, 2.2, 3.8]];
}

const since = (iso: string | null) => {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  return ms < 60_000 ? 'just now' : `${realSpan(ms)} ago`;
};

const townLabel = (t: MapTown) => `${t.name}, ${mayorTitle(t.mayor)}, ${num(t.population)} residents${t.playing ? ', being played now' : ''}${t.mine ? ', your town' : ''}`;

function TownHex({ p, selected, onSelect }: { p: Placed; selected: boolean; onSelect(id: string): void }) {
  const t = p.town;
  return (
    <g class={`town-hex${t.mine ? ' mine' : ''}${t.onMap || t.local ? '' : ' off'}${selected ? ' sel' : ''}`} role="button" tabIndex={0} aria-label={townLabel(t)} aria-pressed={selected}
      onClick={() => onSelect(t.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id); } }}>
      <title>{`${t.name} · ${mayorTitle(t.mayor)} · ${num(t.population)} residents`}</title>
      <path d={hexPath(p.x, p.y, HS * 0.9)} fill={popColor(t.population)} />
      {skyline(t.population).map(([dx, w, h], i) => <rect key={i} class="bld" x={p.x + dx - w / 2} y={p.y + 3.4 - h} width={w} height={h} />)}
      {t.playing && <><circle class="pulse" cx={p.x + 5.3} cy={p.y - 5.3} r={2.4} /><circle class="live" cx={p.x + 5.3} cy={p.y - 5.3} r={2.1} /></>}
    </g>
  );
}

/** Long names are shortened on the map; the card and the list show them in full. */
const shortName = (s: string) => (s.length > 14 ? `${s.slice(0, 13).trimEnd()}…` : s);

// ------------------------------------------------------------------------------------------------ the map

// Labels keep the same size on screen at every zoom (see --u in the CSS), so all town names are shown only once
// neighbouring plots are far enough apart on screen for a name to fit between them.
const K_MIN = 0.2, K_MAX = 8, NAMES_AT = 3.6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** A request to centre the map on a point, optionally zoomed in to at least `k`. `seq` makes repeat requests count. */
export interface FocusRequest { x: number; y: number; k?: number; seq: number }

interface MapProps {
  layout: Layout; selected: string | null; focus: FocusRequest | null; onSelect(id: string): void;
  /** Founding a town: free plots can be picked. */
  founding: boolean; spot: Spot | null; onPick(s: Spot): void;
}

function WorldMap({ layout, selected, focus, onSelect, founding, spot, onPick }: MapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const view = useRef({ cx: 0, cy: 0, k: 1 });
  const size = useRef({ w: 800, h: 600 });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const touched = useRef(false); // the player has moved the map, so new data does not re-fit it
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // the view is applied straight to the SVG, so panning and zooming never re-render the hundreds of plots
  const apply = () => {
    const s = svgRef.current;
    if (!s) return;
    const { cx, cy, k } = view.current, { w, h } = size.current;
    s.setAttribute('viewBox', `${(cx - w / 2 / k).toFixed(1)} ${(cy - h / 2 / k).toFixed(1)} ${(w / k).toFixed(1)} ${(h / k).toFixed(1)}`);
    s.style.setProperty('--u', `${(1 / k).toFixed(4)}px`);
    s.classList.toggle('names', k >= NAMES_AT);
  };
  const fit = () => {
    const L = layoutRef.current, { w, h } = size.current;
    // keep room above the top continents for their names, which stay the same size on screen
    const k = clamp(Math.min(w / (L.x1 - L.x0), (h - 44) / (L.y1 - L.y0)) * 0.94, K_MIN, K_MAX);
    view.current = { cx: (L.x0 + L.x1) / 2, cy: (L.y0 + L.y1) / 2 - 22 / k, k };
    apply();
  };
  const zoomAt = (mx: number, my: number, f: number) => {
    const v = view.current, { w, h } = size.current;
    const k = clamp(v.k * f, K_MIN, K_MAX);
    const px = v.cx + (mx - w / 2) / v.k, py = v.cy + (my - h / 2) / v.k;
    view.current = { k, cx: px - (mx - w / 2) / k, cy: py - (my - h / 2) / k };
    touched.current = true;
    apply();
  };
  const pan = (dx: number, dy: number) => {
    const v = view.current;
    view.current = { ...v, cx: v.cx - dx / v.k, cy: v.cy - dy / v.k };
    touched.current = true;
    apply();
  };

  useEffect(() => {
    const s = svgRef.current!;
    const measure = () => { size.current = { w: s.clientWidth || 800, h: s.clientHeight || 600 }; };
    measure();
    const ro = new ResizeObserver(() => { measure(); if (touched.current) apply(); else fit(); });
    ro.observe(s);
    // wheel zoom needs a non-passive listener so the page does not scroll instead
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = s.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    s.addEventListener('wheel', onWheel, { passive: false });
    return () => { ro.disconnect(); s.removeEventListener('wheel', onWheel); };
  }, []);

  // until the player moves the map, keep the whole world in view as towns load
  useEffect(() => { if (!touched.current) fit(); }, [layout]);

  useEffect(() => {
    if (!focus) return;
    const v = view.current;
    view.current = { cx: focus.x, cy: focus.y, k: Math.max(v.k, focus.k ?? v.k) };
    touched.current = true;
    apply();
  }, [focus?.seq]);

  // a drag only takes over the pointer once it has moved, so a plain click still reaches the plot under it
  const onDown = (e: PointerEvent) => { if (e.button === 0) drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }; };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      svgRef.current?.setPointerCapture(e.pointerId);
      svgRef.current?.classList.add('dragging');
    }
    d.x = e.clientX;
    d.y = e.clientY;
    pan(dx, dy);
  };
  const onUp = (e: PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    svgRef.current?.classList.remove('dragging');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== svgRef.current) return;
    const step = 60;
    const { w, h } = size.current;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => pan(step, 0), ArrowRight: () => pan(-step, 0), ArrowUp: () => pan(0, step), ArrowDown: () => pan(0, -step),
      '+': () => zoomAt(w / 2, h / 2, 1.4), '=': () => zoomAt(w / 2, h / 2, 1.4), '-': () => zoomAt(w / 2, h / 2, 1 / 1.4),
    };
    const m = moves[e.key];
    if (m) { e.preventDefault(); m(); }
  };

  return (
    <div class="world-map">
      <svg ref={svgRef} class={`world-svg${founding ? ' founding' : ''}`} tabIndex={0} role="group"
        aria-label={`Map of ${WORLD_NAME}. Drag or use the arrow keys to move, scroll or press plus and minus to zoom.`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
        <defs>
          <pattern id="sea-waves" width="46" height="26" patternUnits="userSpaceOnUse">
            <path d="M2 14 q5.5 -5 11 0 t11 0" class="wave" />
            <path d="M25 3 q5.5 -5 11 0" class="wave" />
          </pattern>
        </defs>
        <rect class="sea" x={layout.x0 - 4000} y={layout.y0 - 4000} width={layout.x1 - layout.x0 + 8000} height={layout.y1 - layout.y0 + 8000} fill="url(#sea-waves)" />
        {layout.continents.map((c) => (
          <g key={c.region} class="continent">
            <path d={c.shorePath} fill={c.shore} />
            <path d={c.landPath} fill={c.land} />
            <path class="lake" d={c.lakePath} />
            <path class="hills" d={c.hillPath} />
            <path class="trees" d={c.treePath} />
          </g>
        ))}
        {founding && (
          <g class="free-plots">
            {layout.free.map((f) => (
              <path key={`${f.region}:${f.plot}`} class={`free-hex${spot && spot.region === f.region && spot.plot === f.plot ? ' on' : ''}`} d={hexPath(f.x, f.y, HS * 0.86)}
                role="button" tabIndex={-1} aria-label={`Free plot in ${regionInfo(f.region).label}`} onClick={() => onPick(f)} />
            ))}
          </g>
        )}
        {layout.placed.map((p) => <TownHex key={p.town.id} p={p} selected={p.town.id === selected} onSelect={onSelect} />)}
        {spot && (
          <g class="spot" aria-hidden="true">
            <circle class="spot-ring" cx={spot.x} cy={spot.y} r={HS * 0.9} />
            <path class="spot-hex" d={hexPath(spot.x, spot.y, HS * 0.9)} />
            <line x1={spot.x - 1} y1={spot.y + 4} x2={spot.x - 1} y2={spot.y - 7} class="spot-pole" />
            <path d={`M${spot.x - 1} ${spot.y - 7}L${spot.x + 6} ${spot.y - 4.8}L${spot.x - 1} ${spot.y - 2.6}Z`} class="spot-flag" />
          </g>
        )}
        {/* labels go on top of every plot so neighbouring hexes never cover them */}
        <g aria-hidden="true">
          {layout.continents.map((c) => (
            <g key={c.region}>
              <text class="continent-name" x={c.x} y={c.top} dy="-1.25em">{c.label}</text>
              <text class="continent-sub" x={c.x} y={c.top}>{[c.country, c.count ? `${c.count} town${c.count > 1 ? 's' : ''}` : 'unsettled'].filter(Boolean).join(' · ')}</text>
            </g>
          ))}
          {layout.placed.map((p) => (
            <text key={p.town.id} class={`town-name${p.town.mine ? ' mine' : ''}${p.town.id === selected ? ' sel' : ''}`} x={p.x} y={p.y + HS * 0.9} dy="1.05em">{shortName(p.town.name)}</text>
          ))}
        </g>
      </svg>
      <div class="world-controls panel" role="group" aria-label="Map zoom">
        <button class="small" aria-label="Zoom in" onClick={() => zoomAt(size.current.w / 2, size.current.h / 2, 1.4)}>+</button>
        <button class="small" aria-label="Zoom out" onClick={() => zoomAt(size.current.w / 2, size.current.h / 2, 1 / 1.4)}>−</button>
        <button class="small" onClick={() => { touched.current = false; fit(); }}>Whole world</button>
      </div>
      <div class="world-legend panel small" aria-hidden="true">
        <span><i style={{ background: popColor(300) }} /><i style={{ background: popColor(3000) }} /><i style={{ background: popColor(20000) }} /> hamlet → city</span>
        <span><b class="dot" /> being played now</span>
        <span><i class="mine" /> your town</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the screen

export interface WorldScreenProps {
  /** Town to select when the map opens (e.g. the one just visited). */
  focus?: string;
  /** Back to the landing page. */
  onHome(): void;
  onVisit(t: WorldTown): void;
  onOpenMine(worldId: string): void;
  onFound(o: NewWorldOptions): void;
  onImport(): void;
}

type Sort = 'people' | 'playing' | 'recent';

export function WorldScreen({ focus, onHome, onVisit, onOpenMine, onFound, onImport }: WorldScreenProps) {
  const c = useCloud();
  const [server, setServer] = useState<WorldTown[] | null>(() => cachedWorld()?.towns ?? null);
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [sort, setSort] = useState<Sort>('people');
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const [founding, setFounding] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [account, setAccount] = useState(false);
  const online = c.phase === 'online' && !!c.account;

  const loadLocal = () => (storageAvailable() ? listSaves().then((s) => setSaves(localTowns(s))).catch(() => setSaves([])) : Promise.resolve());
  const load = async () => {
    if (!online) return;
    setLoading(true);
    try { setServer(await within(fetchWorld(), 15_000, 'The world map')); setError(''); } catch (e) { setError(worldError(e)); } finally { setLoading(false); }
  };
  useEffect(() => { void loadLocal(); }, []);
  useEffect(() => { void load(); }, [online]);
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => clearInterval(id);
  }, [online]);

  const mayor = c.account?.name || 'You';
  const towns = useMemo(() => mergeTowns(online ? server ?? [] : [], saves, mayor), [server, saves, online, mayor]);
  const layout = useMemo(() => layoutWorld(towns), [towns]);
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.town.id, p])), [layout]);
  const selected = sel ? placedById.get(sel)?.town ?? null : null;

  // coming back from a town or a visit: show it
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focus) return;
    const p = placedById.get(focus) ?? layout.placed.find((x) => x.town.worldId === focus);
    if (!p) return;
    focused.current = true;
    setSel(p.town.id);
    setFocusReq({ x: p.x, y: p.y, k: 2.2, seq: Date.now() });
  }, [placedById]);

  const select = (id: string, centre = false) => {
    if (founding) return;
    setSel(id);
    const p = placedById.get(id);
    if (centre && p) setFocusReq({ x: p.x, y: p.y, k: 2.2, seq: Date.now() });
  };
  const pickRegion = (id: string) => {
    setRegion(id);
    const ct = layout.continents.find((x) => x.region === id);
    if (ct) setFocusReq({ x: ct.x, y: ct.y, k: 1.2, seq: Date.now() });
  };
  const startFounding = () => { setSel(null); setSpot(null); setFounding(true); };
  const stopFounding = () => { setFounding(false); setSpot(null); };
  const pick = (s: Spot) => { setSpot(s); setFocusReq({ x: s.x, y: s.y, k: 1.6, seq: Date.now() }); };

  const remove = async (t: MapTown) => {
    const id = t.worldId;
    if (!id) return;
    setSel(null);
    try {
      await deleteWorld(id);
      forgetLocal(id);
      if (online && c.towns.some((x) => x.worldId === id && x.path)) await deleteCloudTown(id);
    } catch (e) { setError(`Could not delete ${t.name} everywhere: ${errText(e)}`); }
    await loadLocal();
    await load();
  };

  const mine = towns.filter((t) => t.mine).sort((a, b) => Date.parse(b.savedAt ?? '0') - Date.parse(a.savedAt ?? '0'));
  const others = towns.filter((t) => !t.mine);
  const q = query.trim().toLowerCase();
  const list = others
    .filter((t) => (region === 'all' || t.region === region) && (!q || t.name.toLowerCase().includes(q) || t.mayor.toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'playing' ? Number(b.playing) - Number(a.playing) : 0)
      || (sort === 'recent' ? Date.parse(b.savedAt ?? '0') - Date.parse(a.savedAt ?? '0') : 0)
      || b.population - a.population);
  const shown = list.slice(0, 200);
  const playing = towns.filter((t) => t.playing).length;
  const mayors = new Set(others.map((t) => t.mayor)).size + (mine.length ? 1 : 0);
  const unplaced = c.towns.filter((t) => t.path && t.plot === null).length;

  let status: ComponentChildren = null;
  if (!cloudConfigured) status = <p class="muted small">This copy of the game has no server, so the map shows the towns on this device only.</p>;
  else if (c.phase === 'connecting' || c.phase === 'off') status = <p class="muted small" role="status">Connecting to {WORLD_NAME}…</p>;
  else if (c.phase === 'offline') status = <><p class="muted small" role="status">{c.notice || 'The world server could not be reached.'} Your own towns still work.</p><div class="buttons"><button class="small" onClick={() => void startCloud()}>Try again</button></div></>;
  else if (c.phase === 'signedOut') status = <><p class="muted small">Signed out: you see only the towns on this device. Join as a guest to see every mayor’s town.</p><div class="buttons"><button class="small primary" disabled={c.busy} onClick={() => void playAsGuest()}>Join as a guest</button></div></>;
  else if (error) status = <><p class="bad small" role="alert">{error}</p><div class="buttons"><button class="small" onClick={() => void load()}>Try again</button></div></>;
  else if (!server) status = <p class="muted small" role="status">Loading the world…</p>;

  return (
    <main class="world" aria-label={WORLD_NAME}>
      <WorldMap layout={layout} selected={sel} focus={focusReq} onSelect={(id) => select(id)} founding={founding} spot={spot} onPick={pick} />
      <div class="world-top">
        <button class="brand" onClick={onHome} aria-label="Mandate home page"><span class="brand-mark" aria-hidden="true">⬢</span> Mandate</button>
      </div>
      {founding && (
        <div class="found-banner panel" role="status">
          <b>{spot ? `${regionInfo(spot.region).label}, ${regionInfo(spot.region).country}` : 'Choose where your town will stand'}</b>
          <span class="muted small">{spot ? 'Pick another plot to move, or found your town in the panel.' : 'Click any free plot on a continent. Each region has its own climate, crops, currency and people.'}</span>
          <button class="small ghost" onClick={stopFounding}>Cancel</button>
        </div>
      )}
      <aside class="world-side panel" aria-label={founding ? 'Found a town' : `Towns of ${WORLD_NAME}`}>
        <div class="world-side-body">
          {founding ? (
            spot ? <FoundCard spot={spot} towns={towns} onFound={onFound} onBack={() => setSpot(null)} />
              : <RegionPicker free={layout.free} onPick={pick} onCancel={stopFounding} />
          ) : (
            <>
              <header class="world-head">
                <div>
                  <h1>{WORLD_NAME}</h1>
                  <p class="muted small">{num(towns.length)} town{towns.length === 1 ? '' : 's'} · {num(mayors)} mayor{mayors === 1 ? '' : 's'}{online ? ` · ${num(playing)} being played now` : ''}</p>
                </div>
                {online && <button class="ghost small" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>}
              </header>
              <button class="primary found-btn" onClick={startFounding}><span aria-hidden="true">＋</span> Found a new town</button>
              {status}
              {selected && <TownCard t={selected} cloud={cloudConfigured} onVisit={() => onVisit(selected)} onPlay={() => selected.worldId && onOpenMine(selected.worldId)}
                onDelete={() => void remove(selected)} onClose={() => setSel(null)} />}
              <section class="world-section">
                <h2>Your towns</h2>
                {mine.length ? (
                  <ul class="world-list">
                    {mine.map((t) => <TownRow key={t.id} t={t} on={t.id === sel} onClick={() => select(t.id, true)} />)}
                  </ul>
                ) : <p class="muted small">You have no town yet. Found one: pick a plot on any continent and name it.</p>}
                {unplaced > 0 && online && <p class="muted small">{unplaced} of your town{unplaced > 1 ? 's' : ''} move{unplaced > 1 ? '' : 's'} onto the shared map after the next cloud save.</p>}
              </section>
              {others.length > 0 && (
                <section class="world-section">
                  <h2>Other mayors</h2>
                  <div class="inline">
                    <label class="sr-only" for="world-search">Find a town or mayor</label>
                    <input id="world-search" type="search" placeholder="Find a town or mayor" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
                    <label class="sr-only" for="world-sort">Sort towns</label>
                    <select id="world-sort" value={sort} onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as Sort)}>
                      <option value="people">Most people</option>
                      <option value="playing">Being played</option>
                      <option value="recent">Recently saved</option>
                    </select>
                  </div>
                  <div class="chips" role="group" aria-label="Regions">
                    <button class={`chip ${region === 'all' ? 'on' : ''}`} aria-pressed={region === 'all'} onClick={() => setRegion('all')}>All</button>
                    {layout.continents.filter((ct) => others.some((t) => t.region === ct.region)).map((ct) => (
                      <button key={ct.region} class={`chip ${region === ct.region ? 'on' : ''}`} aria-pressed={region === ct.region} onClick={() => pickRegion(ct.region)}>{ct.label}</button>
                    ))}
                  </div>
                  <ul class="world-list">
                    {shown.map((t) => <TownRow key={t.id} t={t} on={t.id === sel} onClick={() => select(t.id, true)} />)}
                  </ul>
                  {list.length > shown.length && <p class="muted small">Showing {shown.length} of {num(list.length)}. Search to narrow it down.</p>}
                  {list.length === 0 && <p class="muted small">No town matches.</p>}
                </section>
              )}
              <footer class="world-foot">
                {cloudConfigured && (
                  <button class="ghost small" aria-expanded={account} onClick={() => setAccount(!account)}>
                    {c.account ? `${c.account.name || 'Mayor'}${c.account.guest ? ' (guest)' : ''}` : 'Account'} ▾
                  </button>
                )}
                <button class="ghost small" onClick={onImport}>Import a town file</button>
              </footer>
              {account && <AccountPanel />}
            </>
          )}
        </div>
      </aside>
    </main>
  );
}

function TownRow({ t, on, onClick }: { t: MapTown; on: boolean; onClick(): void }) {
  return (
    <li>
      <button class={on ? 'on' : ''} aria-pressed={on} onClick={onClick}>
        <span class="world-list-name">
          {t.playing && <><b class="dot" aria-hidden="true" /><span class="sr-only">Being played now:</span></>}
          {t.name}{t.local && <span class="chip">this device</span>}
        </span>
        <span class="muted small">{t.mine ? `${regionInfo(t.region).label} · ${num(t.population)} residents${t.date ? ` · ${t.date}` : ''}` : `${t.mayor} · ${num(t.population)} residents · ${regionInfo(t.region).label}`}</span>
      </button>
    </li>
  );
}

function TownCard({ t, cloud, onVisit, onPlay, onDelete, onClose }: { t: MapTown; cloud: boolean; onVisit(): void; onPlay(): void; onDelete(): void; onClose(): void }) {
  const r = regionInfo(t.region);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [t.id]);
  return (
    <section class="town-card" aria-label={t.name}>
      <header>
        <h2>{t.name}</h2>
        <button class="close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <p class="muted">{mayorTitle(t.mayor)} · {r.label}{r.country ? `, ${r.country}` : ''}</p>
      <div class="chips">
        {t.playing && <span class="chip on">Being played now</span>}
        {t.mine && <span class="chip">Your town</span>}
        {t.local && <span class="chip">{cloud ? 'On this device; joins the shared map after a cloud save' : 'Saved on this device'}</span>}
        {!t.local && !t.onMap && <span class="chip">Off the map: only you see it</span>}
      </div>
      <dl class="rows">
        <div><dt>Residents</dt><dd>{num(t.population)}</dd></div>
        {t.approval !== null && <div><dt>Approval</dt><dd>{pct(t.approval)}</dd></div>}
        {t.unemployment !== null && <div><dt>Unemployment</dt><dd>{pct(t.unemployment, 1)}</dd></div>}
        {t.date && <div><dt>Date in the town</dt><dd>{t.date}</dd></div>}
        {t.officeYear !== null && <div><dt>Mayor since</dt><dd>{t.officeYear}</dd></div>}
        {t.condition && <div><dt>Started as</dt><dd>{START_OPTIONS.find((o) => o.id === t.condition)?.label ?? t.condition}</dd></div>}
        <div><dt>Last saved</dt><dd>{since(t.savedAt)}</dd></div>
      </dl>
      <div class="buttons wrap">
        {t.mine && t.worldId
          ? <button class="primary" onClick={onPlay}>Play {t.name}</button>
          : <button class="primary" onClick={onVisit}>Visit {t.name}</button>}
        {t.mine && t.worldId && (confirm
          ? <><button class="danger small" onClick={onDelete}>Delete for good</button><button class="ghost small" onClick={() => setConfirm(false)}>Keep</button></>
          : <button class="ghost small" onClick={() => setConfirm(true)}>Delete</button>)}
      </div>
      {confirm && <p class="muted small">This deletes the town and its saves on this device{cloud ? ' and in your account' : ''}. It cannot be undone.</p>}
      {!t.mine && <p class="muted small">A visit is read-only. You see the town as its mayor last saved it, with time running on your device. Nothing you do there changes it.</p>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ founding a town

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The skyline a starting point begins with, as drawn on the map: a surveyor's flag for empty land. */
function StartArt({ population }: { population: number }) {
  return (
    <svg class="start-art" width="34" height="22" viewBox="-8.5 -6 17 11" aria-hidden="true">
      {skyline(population).map(([dx, w, h], i) => <rect key={i} x={dx - w / 2} y={4.6 - h} width={w} height={h} />)}
      <rect x={-8.5} y={4.6} width={17} height={0.5} />
    </svg>
  );
}

/** Before a plot is picked: the regions, so a player who would rather not hunt on the map can jump to one. */
function RegionPicker({ free, onPick, onCancel }: { free: Spot[]; onPick(s: Spot): void; onCancel(): void }) {
  return (
    <section>
      <h1>Found a town</h1>
      <p class="muted">Click a free plot on the map, or pick a region and you get the plot nearest its heart.</p>
      <ul class="region-list">
        {PRESETS.map((p) => {
          const first = free.find((f) => f.region === p.id);
          return (
            <li key={p.id}>
              <button disabled={!first} onClick={() => first && onPick(first)}>
                <i style={{ background: (LOOKS[p.id] ?? OTHER_LAND).land }} aria-hidden="true" />
                <span><b>{p.label}</b><span class="muted small">{p.country} · {p.currency}</span></span>
              </button>
            </li>
          );
        })}
      </ul>
      <div class="buttons"><button class="ghost" onClick={onCancel}>Cancel</button></div>
    </section>
  );
}

/** A name for a new town that no town of the region has yet. */
function suggestName(preset: string, taken: Set<string>, skip = ''): string {
  const names = getPreset(preset).towns;
  const free = names.filter((n) => !taken.has(n.toLowerCase()) && n !== skip);
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  const base = names[Math.floor(Math.random() * names.length)];
  for (let k = 2; k < 99; k++) { const n = `${base} ${['II', 'III', 'IV', 'V', 'VI'][k - 2] ?? k}`; if (!taken.has(n.toLowerCase())) return n; }
  return base;
}

function FoundCard({ spot, towns, onFound, onBack }: { spot: Spot; towns: MapTown[]; onFound(o: NewWorldOptions): void; onBack(): void }) {
  const p = getPreset(spot.region);
  const taken = useMemo(() => new Set(towns.filter((t) => t.region === spot.region).map((t) => t.name.toLowerCase())), [towns, spot.region]);
  const [name, setName] = useState(() => suggestName(spot.region, taken));
  const [touched, setTouched] = useState(false);
  const [cond, setCond] = useState('growing');
  const [year, setYear] = useState(2026);
  const [pace, setPace] = useState(2);
  const [build, setBuild] = useState<BuildMode>('realistic');
  const [cap, setCap] = useState(365);
  // a new region gets a name from that region, unless the player has typed their own
  useEffect(() => { if (!touched) setName(suggestName(spot.region, taken)); }, [spot.region]);
  const crops = (Object.keys(p.crops) as CropId[]).map((c) => CROPS[c].label.toLowerCase());
  const wet = p.climate.rain.map((r, i) => (r >= 100 ? MONTHS[i] : '')).filter(Boolean);
  const t = p.climate.temp;
  const found = () => onFound({
    name: name.trim() || p.towns[0], preset: p.id, startYear: year, condition: cond, seed: Math.floor(Math.random() * 2 ** 31),
    pace, offlineCapDays: cap, now: Date.now(), build, plot: spot.plot,
  });
  const chosen = START_OPTIONS.find((x) => x.id === cond);
  return (
    <section class="found-card" aria-label="Found a town">
      <p class="found-kicker">New town in</p>
      <h1>{p.label}</h1>
      <p class="muted">{p.region}, {p.country}</p>
      <p class="small">{p.blurb}</p>
      <dl class="found-facts">
        <div><dt>Climate</dt><dd>{Math.round(Math.min(...t))}–{Math.round(Math.max(...t))} °C{wet.length ? `, rains ${wet[0]}–${wet[wet.length - 1]}` : Math.min(...p.climate.rain) >= 30 ? ', rain all year round' : ', mostly dry'}</dd></div>
        <div><dt>Farms grow</dt><dd>{crops.join(', ')}</dd></div>
        <div><dt>Currency</dt><dd>{p.currency} ({p.currencyCode})</dd></div>
      </dl>

      <label class="found-label" for="town-name">Name your town</label>
      <div class="inline">
        <input id="town-name" type="text" maxLength={40} value={name} onInput={(e) => { setTouched(true); setName((e.currentTarget as HTMLInputElement).value); }} />
        <button title="Suggest another name" onClick={() => { setTouched(false); setName(suggestName(p.id, taken, name)); }}>Shuffle</button>
      </div>

      <p class="found-label" id="start-label">What stands there today?</p>
      <div class="start-tiles" role="radiogroup" aria-labelledby="start-label">
        {START_OPTIONS.map((x) => (
          <button key={x.id} role="radio" aria-checked={cond === x.id} class={`start-tile ${cond === x.id ? 'on' : ''}`} onClick={() => setCond(x.id)}>
            <StartArt population={x.population} />
            <b>{x.label}</b>
            <span class="muted small">{x.population ? `${num(x.population)} people` : 'Nobody yet'}</span>
          </button>
        ))}
      </div>
      {chosen && <p class="muted small">{chosen.blurb}</p>}

      <details class="found-more">
        <summary>More options</summary>
        <p class="found-label">Take office in</p>
        <div class="segmented" role="radiogroup" aria-label="Year">
          {START_YEARS.map((y) => <button key={y} role="radio" aria-checked={year === y} class={year === y ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
        </div>
        <p class="found-label">How fast the world lives</p>
        <div class="segmented" role="radiogroup" aria-label="Pace">
          {PACES.map((x) => <button key={x.id} role="radio" aria-checked={pace === x.pace} class={pace === x.pace ? 'on' : ''} title={x.blurb} onClick={() => setPace(x.pace)}>{x.label}</button>)}
        </div>
        <p class="muted small">{PACES.find((x) => x.pace === pace)?.blurb}</p>
        <p class="found-label">Construction</p>
        <div class="segmented" role="radiogroup" aria-label="Construction">
          {BUILD_MODES.map((x) => <button key={x.id} role="radio" aria-checked={build === x.id} class={build === x.id ? 'on' : ''} title={x.note} onClick={() => setBuild(x.id)}>{x.label}</button>)}
        </div>
        <p class="muted small">{BUILD_MODES.find((x) => x.id === build)?.note}</p>
        <p class="found-label">While the game is closed, keep the town running for up to</p>
        <div class="segmented" role="radiogroup" aria-label="Time simulated while away">
          {OFFLINE_CAPS.map((x) => <button key={x.days} role="radio" aria-checked={cap === x.days} class={cap === x.days ? 'on' : ''} onClick={() => setCap(x.days)}>{x.label}</button>)}
        </div>
      </details>

      <button class="primary found-go" onClick={found}>Found {name.trim() || p.towns[0]}</button>
      <div class="buttons"><button class="ghost small" onClick={onBack}>Choose another region</button></div>
    </section>
  );
}
