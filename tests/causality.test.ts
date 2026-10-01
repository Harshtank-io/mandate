// Consequences must have causes: these tests change one thing and check that the effect appears where the
// simulation says it should, and that player decisions go through validation, delays and announcements.

import { describe, expect, it } from 'vitest';
import { DAILY } from '../src/sim/simulation';
import type { Sim } from '../src/sim/core';
import { MIN_PER_DAY, dateOf, dayIndex } from '../src/sim/calendar';
import { announceTax, cancel, previewBuilding, previewRoad, proposeBuilding, proposeRoad, rezone, routeTiles, setFunding, GOV_BUILDINGS } from '../src/sim/commands';
import { freightPerUnit } from '../src/sim/systems/logistics';
import { explain, inspect, type MetricKey } from '../src/sim/inspect';
import { alerts, snapshot, summarize } from '../src/sim/summary';
import { BUSINESSES } from '../src/sim/tables';
import { Terrain, Zone } from '../src/sim/types';
import { clone, world } from './helpers';

function withWeather(patch: (sim: Sim) => void, body: () => void): void {
  const i = DAILY.findIndex((d) => d.id === 'weather');
  const orig = DAILY[i];
  DAILY[i] = { id: 'weather', daily: (sim) => { orig.daily!(sim); patch(sim); } };
  try { body(); } finally { DAILY[i] = orig; }
}

function toNextMonth(sim: ReturnType<typeof world>, extraDays = 1): void {
  const d = dateOf(sim.state.meta.startYear, sim.sim.day);
  const first = dayIndex(sim.state.meta.startYear, d.year, d.month + 1, 1);
  sim.advanceTo((first + extraDays) * MIN_PER_DAY + 8 * 60);
}

describe('agriculture responds to the weather', () => {
  it('no rain damages rain-fed crops while steady rain does not', () => {
    const base = world({ seed: 21 });
    const growing = base.state.businesses.filter((b) => b.farm && b.farm.phase === 'growing').slice(0, 25).map((b) => b.id);
    expect(growing.length).toBeGreaterThan(3);
    const prep = (s: ReturnType<typeof world>) => {
      for (const id of growing) { const f = s.sim.biz(id)!.farm!; f.irrigation = 0; f.moisture = 0.5; f.disease = 0; f.losses = {}; }
    };
    const dry = clone(base), wet = clone(base);
    prep(dry); prep(wet);
    withWeather((sim) => { sim.s.weather.rain = 0; sim.s.weather.temp = 30; sim.s.weather.rainLog[sim.s.weather.rainLog.length - 1] = 0; }, () => dry.advanceDays(20));
    withWeather((sim) => { sim.s.weather.rain = 12; sim.s.weather.temp = 22; sim.s.weather.rainLog[sim.s.weather.rainLog.length - 1] = 12; }, () => wet.advanceDays(20));
    let hDry = 0, hWet = 0, lossDry = 0, lossWet = 0, n = 0;
    for (const id of growing) {
      const a = dry.sim.biz(id)?.farm, b = wet.sim.biz(id)?.farm;
      if (!a || !b || a.phase !== 'growing' || b.phase !== 'growing') continue;
      n++;
      hDry += a.health; hWet += b.health;
      lossDry += (a.losses.water ?? 0) + (a.losses.drought ?? 0);
      lossWet += (b.losses.water ?? 0) + (b.losses.drought ?? 0);
    }
    expect(n).toBeGreaterThan(2);
    expect(lossDry).toBeGreaterThan(0);
    expect(lossWet).toBe(0);
    expect(hDry / n).toBeLessThan(hWet / n - 0.02);
  });
});

describe('taxes and policies', () => {
  it('announces a tax change, applies it on the first of next month and reports it', () => {
    const sim = world({ seed: 3 });
    const g = sim.state.gov;
    const before = g.taxes.sales;
    const r = announceTax(sim.sim, 'sales', before + 0.03);
    expect(r.ok).toBe(true);
    expect(g.pending).toHaveLength(1);
    expect(sim.state.events.some((e) => e.type === 'tax.announced')).toBe(true);
    expect(g.taxes.sales).toBe(before); // not yet
    toNextMonth(sim);
    expect(g.taxes.sales).toBeCloseTo(before + 0.03, 10);
    expect(g.pending).toHaveLength(0);
    expect(sim.state.events.some((e) => e.type === 'tax.changed')).toBe(true);
    expect(sim.state.news.some((n) => /sales tax/i.test(n.headline))).toBe(true);
  });

  it('raising the fuel tax raises fuel, freight and import costs', () => {
    const sim = world({ seed: 4 });
    const fuel0 = sim.sim.fuelPrice(), freight0 = freightPerUnit(sim.sim, 'food', 60);
    expect(announceTax(sim.sim, 'fuel', sim.state.gov.taxes.fuel + 0.5).ok).toBe(true);
    toNextMonth(sim, 0);
    // compare at the same world prices so only the tax differs
    const base = sim.state.ext.fuel;
    expect(sim.sim.fuelPrice() / base).toBeGreaterThan(fuel0 / base + 0.4);
    expect(freightPerUnit(sim.sim, 'food', 60)).toBeGreaterThan(freight0);
  });

  it('cutting a department budget lays off staff, who then look for work', () => {
    const sim = world({ seed: 6, condition: 'growing' });
    const teachers = () => sim.state.businesses.filter((b) => b.kind === 'school').reduce((a, b) => a + b.jobs.filter((j) => j.role === 'teacher').length, 0);
    const before = teachers();
    expect(setFunding(sim.sim, 'education', 0.45).ok).toBe(true);
    toNextMonth(sim);
    expect(teachers()).toBeLessThan(before);
    expect(sim.state.events.some((e) => e.type === 'gov.cuts' && /education/i.test(e.text))).toBe(true);
  });

  it('rejects invalid decisions', () => {
    const sim = world({ seed: 7 });
    expect(announceTax(sim.sim, 'sales', 0.9).ok).toBe(false);
    expect(setFunding(sim.sim, 'health', 5).ok).toBe(false);
    expect(cancel(sim.sim, 999999).ok).toBe(false);
    const m = sim.state.map;
    const water = m.terrain.findIndex((t) => t === Terrain.Water);
    const pv = previewBuilding(sim.sim, 'clinic', water % 128, Math.floor(water / 128));
    expect(pv.ok).toBe(false);
    expect(pv.errors.join(' ')).toMatch(/water/i);
  });
});

describe('development takes time and goes through stages', () => {
  function freeRoute(sim: Sim): number[] | null {
    const m = sim.s.map;
    const free = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= 128 || y >= 128) return false;
      const t = y * 128 + x;
      return !m.road[t] && m.owner[t] < 0 && m.project[t] < 0 && m.terrain[t] !== Terrain.Water && m.terrain[t] !== Terrain.Canal;
    };
    for (let t = 0; t < m.road.length; t++) {
      if (m.road[t] !== 1) continue;
      const x = t % 128, y = (t / 128) | 0;
      if ([1, 2, 3, 4].every((k) => free(x + k, y) && free(x + k, y - 1) && free(x + k, y + 1))) return routeTiles(x + 1, y, x + 4, y);
    }
    return null;
  }

  it('builds a new street with local contractors and connects it to the network', () => {
    const sim = world({ seed: 12 });
    const route = freeRoute(sim.sim);
    expect(route).not.toBeNull();
    const pv = previewRoad(sim.sim, 'road', route!);
    expect(pv.ok).toBe(true);
    expect(pv.est!.cost).toBeGreaterThan(0);
    const r = proposeRoad(sim.sim, 'road', route!);
    expect(r.ok).toBe(true);
    const id = (r as { id: number }).id;
    const phases = new Set<string>();
    for (let d = 0; d < 500; d += 5) {
      sim.advanceDays(5);
      const p = sim.sim.ix.proj.get(id);
      if (!p || p.phase === 'done') break;
      phases.add(p.phase);
    }
    expect(phases.has('planning') || phases.has('approval')).toBe(true);
    expect(phases.has('construction')).toBe(true);
    for (const t of route!) expect(sim.state.map.road[t]).toBeGreaterThan(0);
    expect(sim.state.gov.ytd.exp.capital + sim.state.gov.lastYear.exp.capital).toBeGreaterThan(0);
  });

  it('commissions a public building that starts in planning, not instantly', () => {
    const sim = world({ seed: 13 });
    const th = sim.state.buildings.find((b) => b.kind === 'townhall')!;
    let spot: [number, number] | null = null;
    for (let r = 2; r < 30 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (previewBuilding(sim.sim, 'clinic', th.x + dx, th.y + dy).ok) spot = [th.x + dx, th.y + dy];
    }
    expect(spot).not.toBeNull();
    const buildings = sim.state.buildings.length;
    const r = proposeBuilding(sim.sim, 'clinic', spot![0], spot![1]);
    expect(r.ok).toBe(true);
    const p = sim.sim.ix.proj.get((r as { id: number }).id)!;
    expect(p.phase).toBe('planning');
    sim.advanceDays(3);
    expect(sim.state.buildings.length).toBeLessThanOrEqual(buildings + 3); // nothing appeared from nowhere
    expect(p.phase).not.toBe('done');
  });

  it('rezones farmland for housing and records it', () => {
    const sim = world({ seed: 14 });
    const m = sim.state.map;
    const tiles: number[] = [];
    for (let t = 0; t < m.zone.length && tiles.length < 12; t++) if (m.zone[t] === Zone.Agricultural && !m.road[t] && m.owner[t] < 0 && m.project[t] < 0) tiles.push(t);
    expect(tiles.length).toBe(12);
    const r = rezone(sim.sim, tiles, Zone.Residential);
    expect(r.ok).toBe(true);
    for (const t of tiles) expect(m.zone[t]).toBe(Zone.Residential);
    expect(sim.state.events.some((e) => e.type === 'zoning.changed')).toBe(true);
    // roads and water are never rezoned
    const road = m.road.findIndex((x) => x > 0);
    expect(rezone(sim.sim, [road], Zone.Industrial).ok).toBe(false);
  });
});

describe('the world can be inspected and explained', () => {
  it('describes every entity and every dashboard figure without failing', () => {
    const sim = world({ seed: 15, condition: 'established' });
    sim.advanceDays(45);
    const s = sim.state;
    for (const b of s.buildings) expect(inspect(sim.sim, { k: 'building', id: b.id })).not.toBeNull();
    for (const b of s.businesses) expect(inspect(sim.sim, { k: 'business', id: b.id })?.rows.length).toBeGreaterThan(0);
    for (const c of s.citizens.filter((_, i) => i % 7 === 0)) expect(inspect(sim.sim, { k: 'citizen', id: c.id })?.title).toBeTruthy();
    for (const h of s.households.filter((_, i) => i % 5 === 0)) expect(inspect(sim.sim, { k: 'household', id: h.id })).not.toBeNull();
    for (const p of s.projects) expect(inspect(sim.sim, { k: 'project', id: p.id })).not.toBeNull();
    for (let t = 0; t < s.map.road.length; t += 97) expect(inspect(sim.sim, { k: 'tile', id: t })).not.toBeNull();
    const keys: MetricKey[] = ['population', 'unemployment', 'budget', 'housing', 'food', 'traffic', 'satisfaction', 'health', 'environment', 'education', 'agriculture'];
    for (const k of keys) expect(explain(sim.sim, k).length).toBeGreaterThan(0);
    expect(Array.isArray(alerts(sim.sim))).toBe(true);
  });

  it('farm cards show crop, growth and money like a real ledger', () => {
    const sim = world({ seed: 16 });
    const farm = sim.state.businesses.find((b) => b.farm && b.farm.phase === 'growing')!;
    const card = inspect(sim.sim, { k: 'business', id: farm.id })!;
    const labels = card.rows.map((r) => r[0]);
    for (const l of ['Owner', 'Employees', 'Crop', 'Growth', 'Expected harvest', 'Water use today', 'Revenue this season', 'Tax paid (all time)']) expect(labels).toContain(l);
  });

  it('summarises a month away from the simulated record', () => {
    const sim = world({ seed: 17 });
    const before = snapshot(sim.sim);
    sim.advanceDays(31);
    const sum = summarize(sim.sim, before);
    expect(sum.days).toBeCloseTo(31, 5);
    expect(sum.lines[0].text).toMatch(/^Population/);
    expect(sum.lines.some((l) => /collected/.test(l.text))).toBe(true);
  });

  it('lets the government build every kind of public facility somewhere', () => {
    const sim = world({ seed: 18 });
    for (const kind of GOV_BUILDINGS) {
      if (kind === 'townhall') continue;
      let found = false;
      for (let y = 10; y < 118 && !found; y += 3) for (let x = 10; x < 118 && !found; x += 3) if (previewBuilding(sim.sim, kind, x, y).ok) found = true;
      expect(found, `${kind} (${BUSINESSES[kind as 'school']?.label ?? kind})`).toBe(true);
    }
  });
});
