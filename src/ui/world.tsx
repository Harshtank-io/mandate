// The shared world map. Every town in the cloud has a plot in its region, and each region is a continent of hexagonal
// plots that grows outwards as towns are founded. Players browse and search the map here and visit other mayors' towns.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { playAsGuest, startCloud } from '../net/auth';
import { cloudConfigured, within } from '../net/client';
import { useCloud } from '../net/store';
import { cachedWorld, fetchWorld, worldError, type WorldTown } from '../net/world';
import { hash01 } from '../sim/rng';
import { PRESETS, START_OPTIONS } from '../sim/presets';
import { mayorTitle, num, pct, realSpan } from './util';

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

interface RegionLook { at: [number, number]; land: string; shore: string }

/** Where each region's continent lies, roughly as on a real map, and the colour of its land. */
const LOOKS: Record<string, RegionLook> = {
  fictional: { at: [-1.55, -0.85], land: '#6f8f5a', shore: '#b3bf92' },
  'in-punjab': { at: [0.45, -1.05], land: '#9c9655', shore: '#cfc58f' },
  'in-deccan': { at: [0.65, 0.35], land: '#a7845a', shore: '#d2b48d' },
  'vn-mekong': { at: [1.9, -0.15], land: '#4f8a5c', shore: '#9cc196' },
  'ke-rift': { at: [-0.95, 0.95], land: '#9a8957', shore: '#cbbb8c' },
};
const OTHER_LAND = { land: '#7b8a7c', shore: '#adb8a9' };

interface Continent { region: string; label: string; country: string; land: string; shore: string; x: number; y: number; top: number; landPath: string; shorePath: string; count: number }
interface Placed { town: WorldTown; x: number; y: number }
interface Layout { continents: Continent[]; placed: Placed[]; x0: number; y0: number; x1: number; y1: number }

function regionInfo(id: string): { label: string; country: string } {
  const p = PRESETS.find((x) => x.id === id);
  return p ? { label: p.label, country: p.country } : { label: id === 'other' ? 'Other lands' : id, country: '' };
}

const strHash = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

function layoutWorld(towns: WorldTown[]): Layout {
  const byRegion = new Map<string, WorldTown[]>();
  for (const id of Object.keys(LOOKS)) byRegion.set(id, []);
  for (const t of towns) {
    const list = byRegion.get(t.region);
    if (list) list.push(t); else byRegion.set(t.region, [t]);
  }
  const regions = [...byRegion.keys()];
  let extra = 0;
  const looks = regions.map((r) => LOOKS[r] ?? { at: [-1.6 + 1.3 * extra++, 2.15] as [number, number], ...OTHER_LAND });
  // land reaches two rings past the outermost town, so every continent has a shore and room to grow
  const rings = regions.map((r) => Math.max(2, ringOf(Math.max(0, ...byRegion.get(r)!.map((t) => t.plot))) + 2));
  const radius = (k: number) => (k + 1.6) * COL;
  // spread the continents far enough apart that none can touch another, however big they grow
  let s = 9.5 * COL;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const d = Math.hypot(looks[i].at[0] - looks[j].at[0], looks[i].at[1] - looks[j].at[1]);
      s = Math.max(s, (radius(rings[i]) + radius(rings[j]) + COL * 1.5) / Math.max(0.3, d));
    }
  }
  const continents: Continent[] = [], placed: Placed[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  regions.forEach((region, i) => {
    const k = rings[i], L = looks[i];
    const cx = L.at[0] * s, cy = L.at[1] * s;
    const salt = strHash(region);
    let landPath = '', shorePath = '';
    for (let n = 0; n < cells(k + 1); n++) {
      const ring = ringOf(n);
      // the outermost ring is a ragged coastline: only some of its hexes are land
      if (ring > k && hash01(n, salt) > 0.32) continue;
      const [q, r] = hexAt(n);
      const [px, py] = toPx(q, r);
      const d = hexPath(cx + px, cy + py, HS * 1.02);
      if (ring < k) landPath += d; else shorePath += d;
    }
    const list = byRegion.get(region)!;
    for (const t of list) {
      const [q, r] = hexAt(t.plot);
      const [px, py] = toPx(q, r);
      placed.push({ town: t, x: cx + px, y: cy + py });
    }
    const R = radius(k + 1);
    const info = regionInfo(region);
    continents.push({ region, ...info, land: L.land, shore: L.shore, x: cx, y: cy, top: cy - R - 8, landPath, shorePath, count: list.length });
    x0 = Math.min(x0, cx - R); x1 = Math.max(x1, cx + R);
    y0 = Math.min(y0, cy - R - 34); y1 = Math.max(y1, cy + R);
  });
  return { continents, placed, x0, y0, x1, y1 };
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
  if (pop <= 0) return [];
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

const townLabel = (t: WorldTown) => `${t.name}, ${mayorTitle(t.mayor)}, ${num(t.population)} residents${t.playing ? ', being played now' : ''}${t.mine ? ', your town' : ''}`;

function TownHex({ p, selected, onSelect }: { p: Placed; selected: boolean; onSelect(id: string): void }) {
  const t = p.town;
  return (
    <g class={`town-hex${t.mine ? ' mine' : ''}${t.onMap ? '' : ' off'}${selected ? ' sel' : ''}`} role="button" tabIndex={0} aria-label={townLabel(t)} aria-pressed={selected}
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
const K_MIN = 0.25, K_MAX = 8, NAMES_AT = 3.6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** A request to centre the map on a point, optionally zoomed in to at least `k`. `seq` makes repeat requests count. */
export interface FocusRequest { x: number; y: number; k?: number; seq: number }

function WorldMap({ layout, selected, focus, onSelect }: { layout: Layout; selected: string | null; focus: FocusRequest | null; onSelect(id: string): void }) {
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

  // a drag only takes over the pointer once it has moved, so a plain click still reaches the town under it
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
      <svg ref={svgRef} class="world-svg" tabIndex={0} role="group" aria-label="World map. Drag or use the arrow keys to move, scroll or press plus and minus to zoom."
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
        {layout.continents.map((c) => (
          <g key={c.region} class="continent">
            <path d={c.shorePath} fill={c.shore} />
            <path d={c.landPath} fill={c.land} />
          </g>
        ))}
        {layout.placed.map((p) => <TownHex key={p.town.id} p={p} selected={p.town.id === selected} onSelect={onSelect} />)}
        {/* labels go on top of every plot so neighbouring hexes never cover them */}
        <g aria-hidden="true">
          {layout.continents.map((c) => (
            <g key={c.region}>
              <text class="continent-name" x={c.x} y={c.top} dy="-1.25em">{c.label}</text>
              <text class="continent-sub" x={c.x} y={c.top}>{[c.country, c.count ? `${c.count} town${c.count > 1 ? 's' : ''}` : 'no towns yet'].filter(Boolean).join(' · ')}</text>
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
  onBack(): void;
  onVisit(t: WorldTown): void;
  onOpenMine(worldId: string): void;
}

type Sort = 'people' | 'playing' | 'recent';

export function WorldScreen({ focus, onBack, onVisit, onOpenMine }: WorldScreenProps) {
  const c = useCloud();
  const [towns, setTowns] = useState<WorldTown[] | null>(() => cachedWorld()?.towns ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [sort, setSort] = useState<Sort>('people');
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const online = c.phase === 'online' && !!c.account;

  const load = async () => {
    if (!online) return;
    setLoading(true);
    try { setTowns(await within(fetchWorld(), 15_000, 'The world map')); setError(''); } catch (e) { setError(worldError(e)); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [online]);
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => clearInterval(id);
  }, [online]);

  const layout = useMemo(() => layoutWorld(towns ?? []), [towns]);
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.town.id, p])), [layout]);
  const selected = sel ? placedById.get(sel)?.town ?? null : null;

  // coming back from a visit: show the town just visited
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focus) return;
    const p = placedById.get(focus);
    if (!p) return;
    focused.current = true;
    setFocusReq({ x: p.x, y: p.y, k: 2.2, seq: Date.now() });
  }, [placedById]);

  const select = (id: string, centre = false) => {
    setSel(id);
    const p = placedById.get(id);
    if (centre && p) setFocusReq({ x: p.x, y: p.y, k: 2.2, seq: Date.now() });
  };
  const pickRegion = (id: string) => {
    setRegion(id);
    const ct = layout.continents.find((x) => x.region === id);
    if (ct) setFocusReq({ x: ct.x, y: ct.y, k: 1.2, seq: Date.now() });
  };

  const q = query.trim().toLowerCase();
  const list = (towns ?? [])
    .filter((t) => (region === 'all' || t.region === region) && (!q || t.name.toLowerCase().includes(q) || t.mayor.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.mine) - Number(a.mine)
      || (sort === 'playing' ? Number(b.playing) - Number(a.playing) : 0)
      || (sort === 'recent' ? Date.parse(b.savedAt ?? '0') - Date.parse(a.savedAt ?? '0') : 0)
      || b.population - a.population);
  const shown = list.slice(0, 200);
  const playing = (towns ?? []).filter((t) => t.playing).length;
  const mayors = new Set((towns ?? []).map((t) => t.mayor)).size;
  const unplaced = c.towns.filter((t) => t.path && t.plot === null).length;

  let status: ComponentChildren = null;
  if (!cloudConfigured) status = <p class="muted">This copy of the game is not connected to a server, so there is no shared world to show.</p>;
  else if (c.phase === 'connecting' || c.phase === 'off') status = <p class="muted" role="status">Connecting to your account…</p>;
  else if (c.phase === 'offline') status = <><p class="muted small" role="status">{c.notice || 'Your account could not be reached.'}</p><div class="buttons"><button class="small" onClick={() => void startCloud()}>Try again</button></div></>;
  else if (c.phase === 'signedOut') status = <><p class="muted">The world map needs an account. A guest account is enough.</p><div class="buttons"><button class="small primary" disabled={c.busy} onClick={() => void playAsGuest()}>Play as a guest</button></div></>;
  else if (error) status = <><p class="bad small" role="alert">{error}</p><div class="buttons"><button class="small" onClick={() => void load()}>Try again</button></div></>;
  else if (!towns) status = <p class="muted" role="status">Loading the world…</p>;

  return (
    <main class="world" aria-label="The world">
      <WorldMap layout={layout} selected={sel} focus={focusReq} onSelect={(id) => select(id)} />
      <div class="world-top"><button onClick={onBack}>Back to the menu</button></div>
      <aside class="world-side panel" aria-label="Towns of the world">
        <div class="world-side-body">
          <header class="world-head">
            <div>
              <h1>The world</h1>
              <p class="muted small">{towns ? `${num(towns.length)} town${towns.length === 1 ? '' : 's'} · ${num(mayors)} mayor${mayors === 1 ? '' : 's'} · ${num(playing)} being played now` : 'Every public town, region by region'}</p>
            </div>
            {online && <button class="ghost small" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>}
          </header>
          {status}
          {selected ? (
            <TownCard t={selected} onVisit={() => onVisit(selected)} onOpenMine={() => selected.worldId && onOpenMine(selected.worldId)} onClose={() => setSel(null)} />
          ) : towns && !status && (
            <p class="muted small">{towns.length
              ? 'Each plot is a town run by a player. Pick one to see who runs it, then visit: you can look around, inspect anything and watch time pass there.'
              : 'No towns on the map yet. Towns saved to an account appear here, so yours could be the first.'}</p>
          )}
          {unplaced > 0 && online && <p class="muted small">{unplaced} of your town{unplaced > 1 ? 's' : ''} will appear on the map after {unplaced > 1 ? 'their' : 'its'} next cloud save.</p>}
          {towns && towns.length > 0 && (
            <>
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
                {layout.continents.filter((ct) => ct.count > 0).map((ct) => (
                  <button key={ct.region} class={`chip ${region === ct.region ? 'on' : ''}`} aria-pressed={region === ct.region} onClick={() => pickRegion(ct.region)}>{ct.label} ({ct.count})</button>
                ))}
              </div>
              <ul class="world-list">
                {shown.map((t) => (
                  <li key={t.id}>
                    <button class={t.id === sel ? 'on' : ''} aria-pressed={t.id === sel} onClick={() => select(t.id, true)}>
                      <span class="world-list-name">
                        {t.playing && <><b class="dot" aria-hidden="true" /><span class="sr-only">Being played now:</span></>}
                        {t.name}{t.mine && <span class="chip">yours</span>}
                      </span>
                      <span class="muted small">{t.mayor} · {num(t.population)} residents · {regionInfo(t.region).label}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {list.length > shown.length && <p class="muted small">Showing {shown.length} of {num(list.length)}. Search to narrow it down.</p>}
              {list.length === 0 && <p class="muted small">No town matches.</p>}
            </>
          )}
        </div>
      </aside>
    </main>
  );
}

function TownCard({ t, onVisit, onOpenMine, onClose }: { t: WorldTown; onVisit(): void; onOpenMine(): void; onClose(): void }) {
  const r = regionInfo(t.region);
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
        {!t.onMap && <span class="chip">Off the map: only you see it</span>}
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
      <div class="buttons">
        {t.mine && t.worldId
          ? <button class="primary" onClick={onOpenMine}>Play your town</button>
          : <button class="primary" onClick={onVisit}>Visit {t.name}</button>}
      </div>
      {!t.mine && <p class="muted small">A visit is read-only. You see the town as its mayor last saved it, with time running on your device. Nothing you do there changes it.</p>}
    </section>
  );
}
