// Fires. Every building carries a small risk of fire that rises with what goes on inside (kitchens, machinery, fuel),
// with its age and condition, and in hot, dry weather. Crews put most fires out quickly where a station is close and
// the mains carry water; without them a fire can gut the building and spread next door. A private building that
// burns down is cleared: its residents look for new homes and the business in it closes. Public buildings are
// repaired by the city.

import { idx, inMap, type Sim } from '../core';
import { maintenanceWork } from '../econ';
import { BUILDINGS } from '../tables';
import type { Building, BuildingKind } from '../types';
import { cellOf } from './services';
import { powered, watered } from './utilities';

/** Chance of a fire in a year, by building type. Kitchens, machinery and fuel stores raise it. */
const ANNUAL: Partial<Record<BuildingKind, number>> = {
  house: 0.0022, luxury: 0.002, apartment: 0.004, affordable: 0.006, farmhouse: 0.003,
  shop: 0.006, grocery: 0.006, restaurant: 0.018, services: 0.007, office: 0.005, hotel: 0.012, cinema: 0.009,
  factory: 0.045, foodplant: 0.035, materials: 0.04, depot: 0.02, yard: 0.015,
  townhall: 0.004, school: 0.004, college: 0.005, clinic: 0.004, hospital: 0.008, police: 0.004, firestation: 0.002,
  museum: 0.004, stadium: 0.006, heritage: 0.005, airport: 0.01, gasplant: 0.03, waterworks: 0.004, substation: 0.015,
  solarfarm: 0.004, windfarm: 0.004,
};
/** Days flames and smoke show after a fire. */
const SMOKE_DAYS = 2;

/** How quickly and well crews respond at a building: nearby stations and water in the mains (0..1). */
export function fireResponse(sim: Sim, b: Building): number {
  const [x, y] = sim.center(b);
  const cov = sim.s.services.fireCov?.[cellOf(x, y)] ?? 0;
  return cov * (0.5 + 0.5 * watered(b));
}

/** Daily chance of fire breaking out in a building. */
export function fireRisk(sim: Sim, b: Building): number {
  const base = ANNUAL[b.kind];
  if (!base) return 0;
  const s = sim.s, w = s.weather;
  const cat = BUILDINGS[b.kind].category;
  let k = (base / 365) * (1.6 - 0.6 * b.condition);
  if (b.kind === 'apartment') k *= 0.6 + b.floors / 10;
  // safety codes, enforced under stricter business regulation
  if (cat === 'commercial' || cat === 'industrial') k *= [1.3, 1, 0.8][s.gov.policies.businessRegulation];
  // empty buildings rarely catch fire; candles, lamps and generators do during blackouts
  const used = b.occupants.length > 0 || b.biz >= 0;
  if (!used) k *= 0.4;
  if (cat === 'residential') k *= 1 + 0.6 * (1 - powered(b));
  if (w.temp > 35 && w.rain < 1) k *= 1.6;
  if (w.drought) k *= 1.3;
  if (w.rain > 20) k *= 0.6;
  return k;
}

export function fireDaily(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  for (const b of s.buildings) if (b.fire !== undefined && --b.fire <= 0) delete b.fire;
  if (!s.buildings.length) return;
  // at most one fire breaks out on any day; which building is weighted by risk
  let total = 0;
  const risk = s.buildings.map((b) => { const k = fireRisk(sim, b); total += k; return k; });
  if (!(total > 0) || !r.chance(Math.min(0.5, total))) return;
  let pick = r.next() * total, target: Building | undefined;
  for (let i = 0; i < risk.length; i++) { pick -= risk[i]; if (pick <= 0) { target = s.buildings[i]; break; } }
  if (!target) target = s.buildings[s.buildings.length - 1];
  burn(sim, target, 0);
}

/** A fire in `b`. `depth` counts how far it has spread from where it started. */
function burn(sim: Sim, b: Building, depth: number): void {
  const s = sim.s, r = sim.rng;
  const response = fireResponse(sim, b);
  // good cover keeps most fires small; without it the size of a fire is down to luck
  const damage = Math.min(1, (0.05 + 0.95 * Math.pow(r.next(), 1 + 4 * response)) * (1 - 0.6 * response) * (depth ? 0.7 : 1));
  s.stats.acc.fires++;
  b.fire = SMOKE_DAYS;
  const spec = BUILDINGS[b.kind];
  const label = spec.label.toLowerCase();
  const name = b.name || `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
  const station = nearestStation(sim, b);
  const why: string[] = [];
  if (!station) why.push('No fire station is close enough to respond quickly');
  else if (response < 0.5) why.push(`The nearest crews, at ${station}, are stretched or far away`);
  else why.push(`Crews from ${station} were on the scene within minutes`);
  if (watered(b) < 0.6) why.push('The mains carry little water here; crews had to bring their own');
  // injuries among the people inside
  let hurt = 0;
  for (const hid of b.occupants) {
    const h = sim.hh(hid);
    if (!h) continue;
    for (const id of h.members) {
      const c = sim.cit(id);
      if (c && r.chance(damage * 0.12)) { c.injured = Math.max(c.injured, 5 + r.int(30)); hurt++; }
    }
  }
  const biz = b.biz >= 0 ? sim.biz(b.biz) : undefined;
  const destroy = damage >= 0.75 && b.ownerT !== 0 && b.kind !== 'farmhouse' && b.kind !== 'heritage';
  const tile = { k: 'tile' as const, id: idx(b.x, b.y) };
  if (destroy) {
    const families = b.occupants.length;
    const jobs = biz ? biz.jobs.filter((j) => j.worker >= 0).length : 0;
    const displaced = b.occupants.map((id) => sim.hh(id)).filter((h) => !!h);
    if (biz) sim.closeBusiness(biz, 'Its premises burned down.');
    sim.removeBuilding(b);
    for (const h of displaced) {
      h!.unhappy += 2;
      for (const id of h!.members) { const c = sim.cit(id); if (c) c.sat = Math.max(0, c.sat - 0.15); }
    }
    s.stats.acc.burned++;
    const what = families ? `${families} famil${families === 1 ? 'y has' : 'ies have'} lost their home` : jobs ? `${jobs} people have lost their jobs` : 'nobody was inside';
    sim.emit('fire.destroyed', `Fire destroyed ${name}: ${what}${hurt ? `; ${hurt} injured` : ''}.`, families >= 8 || jobs >= 20 ? 3 : 2, tile, undefined,
      [...why, 'The owners will have to rebuild or sell the plot']);
  } else {
    if (b.ownerT === 0) {
      // the city repairs its own buildings through local contractors
      const repair = b.value * damage * 0.2;
      if (repair > 0) maintenanceWork(sim, s.gov, repair, 'capital');
    } else {
      b.condition = Math.max(0.1, b.condition - damage * 0.5);
      b.value *= 1 - damage * 0.25;
    }
    if (biz) biz.downDays = Math.max(biz.downDays, Math.round(damage * 25));
    const major = damage >= 0.35;
    const outcome = major ? `badly damaged${biz && biz.downDays > 0 ? `; it is shut for about ${biz.downDays} days` : ''}` : 'put out quickly; damage is minor';
    sim.emit(major ? 'fire.major' : 'fire.minor', `Fire at ${name}: ${outcome}${hurt ? `, ${hurt} injured` : ''}.`, major ? 2 : 1, { k: 'building', id: b.id }, undefined, why);
  }
  // a large fire with nobody to fight it spreads to the building next door
  if (damage > 0.6 && response < 0.4 && depth < 2 && r.chance(0.35)) {
    const next = neighbour(sim, b);
    if (next) burn(sim, next, depth + 1);
  }
}

function nearestStation(sim: Sim, b: Building): string | null {
  let best: string | null = null, bd = 30;
  for (const biz of sim.s.businesses) {
    if (biz.kind !== 'firestation' || biz.status !== 'operating') continue;
    const bl = sim.bld(biz.building);
    if (!bl) continue;
    const d = sim.dist(bl, b);
    if (d < bd) { bd = d; best = biz.name; }
  }
  return best;
}

/** A building sharing an edge with `b`, if any (chosen at random). */
function neighbour(sim: Sim, b: Building): Building | undefined {
  const m = sim.s.map;
  const ids = new Set<number>();
  for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) {
    if (!inMap(x, y) || (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)) continue;
    const corner = (x < b.x || x >= b.x + b.w) && (y < b.y || y >= b.y + b.h);
    if (corner) continue;
    const o = m.owner[idx(x, y)];
    if (o >= 0 && o !== b.id) ids.add(o);
  }
  const list = [...ids].map((id) => sim.bld(id)).filter((x): x is Building => !!x && x.kind !== 'park');
  return list.length ? sim.rng.pick(list) : undefined;
}
