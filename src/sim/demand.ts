// Demand for zoned land, like the demand meter of a city builder, except that every bar is read from the town's own
// people: families looking for a home, customers turned away by shops, investors weighing up plants and offices.
// Read-only: nothing here touches the random number generator or the state, so the interface may call it freely.

import { idx, W, type Sim } from './core';
import { fmtMoney } from './systems/construction';
import { investorAppetite } from './systems/entry';
import { BUILDINGS } from './tables';
import { Terrain, Zone } from './types';

export interface ZoneDemand {
  value: number; // -1 (oversupplied) .. 1 (strong)
  label: string;
  why: string[];
  /** Why the demand cannot be met right now, if it cannot. */
  blocked: string | null;
}
export interface Demand { res: ZoneDemand; com: ZoneDemand; ind: ZoneDemand }

const clamp = (v: number, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const label = (v: number) => (v > 0.6 ? 'Strong' : v > 0.25 ? 'Moderate' : v > 0.05 ? 'Weak' : v < -0.25 ? 'Oversupplied' : 'Little');
const pctOf = (v: number) => `${Math.round(v * 100)}%`;
const RETAIL = new Set(['grocery', 'shop', 'restaurant', 'services']);

/** Whether any free lot of w x h tiles in one of the zones has road access (the test developers apply, without the dice). */
export function hasLot(sim: Sim, zones: number[], w = 1, h = 1): boolean {
  const m = sim.s.map;
  for (let y = 0; y <= W - h; y++) for (let x = 0; x <= W - w; x++) {
    if (!zones.includes(m.zone[idx(x, y)])) continue;
    let ok = true, road = false;
    for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) {
      const j = idx(xx, yy);
      const tt = m.terrain[j];
      const farmed = m.farm[j] >= 0 && m.zone[j] === Zone.Agricultural;
      if (!zones.includes(m.zone[j]) || m.road[j] || m.owner[j] >= 0 || farmed || m.project[j] >= 0 || tt === Terrain.Water || tt === Terrain.Canal) { ok = false; break; }
      if (!road) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = xx + dx, ny = yy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < W && m.road[idx(nx, ny)] > 0) { road = true; break; }
      }
    }
    if (ok && road) return true;
  }
  return false;
}

function residential(sim: Sim): ZoneDemand {
  const s = sim.s;
  let units = 0, occ = 0, vac = 0, unemp = 0, pipeline = 0;
  for (const b of s.buildings) if (b.units > 0 && b.kind !== 'farmhouse') { units += b.units; occ += Math.min(b.units, b.occupants.length); }
  for (const b of s.businesses) if (b.status === 'operating' || b.status === 'hiring') for (const j of b.jobs) if (j.worker < 0) vac++;
  for (const c of s.citizens) if (c.status === 'unemployed') unemp++;
  for (const p of s.projects) {
    if (p.phase === 'done' || p.phase === 'cancelled') continue;
    if (p.kind === 'house' || p.kind === 'luxury') pipeline++;
    else if (p.kind === 'apartment' || p.kind === 'affordable') pipeline += p.floors * BUILDINGS[p.kind].unitsPerFloor;
  }
  const homeless = s.households.filter((h) => h.home < 0).length;
  const hh = s.households.length;
  const vacancy = units ? (units - occ) / units : 0;
  const jobsWaiting = Math.max(0, vac - unemp);
  const fr = sim.frontier();
  const need = homeless + 0.6 * jobsWaiting + hh * (0.05 - vacancy) + fr * 12 - pipeline;
  const value = clamp(need / Math.max(10, hh * 0.06));
  const why: string[] = [];
  if (homeless) why.push(`${homeless} famil${homeless === 1 ? 'y has' : 'ies have'} no home of their own`);
  if (jobsWaiting >= 3) why.push(`${jobsWaiting} jobs are waiting for workers who would move here`);
  if (fr > 0.2) why.push('Settlers are looking for somewhere to live in the new town');
  if (units) why.push(`${pctOf(vacancy)} of homes stand empty${vacancy > 0.08 ? ': more than enough for now' : ''}`);
  if (pipeline) why.push(`${pipeline} home${pipeline === 1 ? ' is' : 's are'} already being built`);
  const blocked = value > 0.15 && !hasLot(sim, [Zone.Residential]) ? 'No residential land next to a road is free: zone more, or build streets into zoned land' : null;
  return { value, label: label(value), why, blocked };
}

function commercial(sim: Sim): ZoneDemand {
  const s = sim.s;
  let unmet = 0, rev = 0, losing = 0, n = 0, grocers = 0;
  for (const b of s.businesses) {
    if (!RETAIL.has(b.kind) || b.status !== 'operating') continue;
    n++;
    if (b.kind === 'grocery') grocers++;
    unmet += b.last.unmet;
    rev += b.last.revenue;
    if (b.lossMonths >= 2) losing++;
  }
  const hh = s.households.length;
  const why: string[] = [];
  const leisure = s.leisure.lastUnmet;
  let retail = clamp(((unmet + leisure) / Math.max(1, rev + unmet + leisure)) * 4, 0, 1);
  if (unmet + leisure > 0) why.push(`Shops, restaurants, services and cinemas turned away customers worth ${fmtMoney(sim, unmet + leisure)} last month`);
  if (!grocers && hh >= 12) { retail = Math.max(retail, 0.8); why.push('There is no grocery: families shop at weekly markets and in other towns'); }
  const office = investorAppetite(sim).find((a) => a.kind === 'office');
  const off = office ? clamp((office.roi - office.hurdle) / 0.06) : -1;
  if (office && off > 0) why.push(`Investors expect ${pctOf(office.roi)} a year on a new office, above the ${pctOf(office.hurdle)} they want`);
  const turned = s.tourism.last.turned;
  const hotel = turned > 60 ? clamp(turned / 600, 0.2, 0.7) : 0;
  if (hotel) why.push(`Hotels turned away ${Math.round(turned).toLocaleString('en-US')} visitors last month`);
  const glut = n ? losing / n : 0;
  if (losing) why.push(`${losing} of ${n} shops, restaurants and services are losing money`);
  const value = clamp(Math.max(retail, off, hotel) - glut * 0.8);
  if (!why.length) why.push(n ? 'Shops are coping with the custom they have' : 'Too few residents yet to support a shop');
  const blocked = value > 0.15 && !hasLot(sim, [Zone.Commercial])
    ? (hasLot(sim, [Zone.Residential]) ? 'No commercial land next to a road is free: shops make do with residential plots, but offices and hotels need it' : 'No commercial land next to a road is free: zone more')
    : null;
  return { value, label: label(value), why, blocked };
}

function industrial(sim: Sim): ZoneDemand {
  const s = sim.s;
  const why: string[] = [];
  const NAMES: Record<string, string> = { factory: 'a factory', foodplant: 'a food processing plant', materials: 'a building materials plant', construction: 'a construction yard', logistics: 'a logistics depot' };
  let best = -1;
  for (const a of investorAppetite(sim)) {
    if (a.kind === 'office') continue;
    const edge = clamp((a.roi - a.hurdle) / 0.06);
    if (edge > best) best = edge;
    if (edge > 0) why.push(`Investors expect ${pctOf(a.roi)} a year on ${NAMES[a.kind]}, above the ${pctOf(a.hurdle)} they want`);
  }
  let unemp = 0, lf = 0;
  for (const c of s.citizens) { if (c.status === 'unemployed') { unemp++; lf++; } else if (c.status === 'working' || c.status === 'owner') lf++; }
  const u = lf ? unemp / lf : 0;
  if (u > 0.07) why.push(`${unemp} people (${pctOf(u)}) are looking for work: plants would find staff easily`);
  const value = clamp(best + (u > 0.07 ? 0.15 : 0));
  if (!why.length) why.push('Plants would not pay at today’s prices, wages and taxes');
  const blocked = value > 0.15 && !hasLot(sim, [Zone.Industrial], 2, 2) ? 'No industrial land next to a road has room for a plant (2×2 tiles): zone more' : null;
  return { value, label: label(value), why, blocked };
}

const cache = new WeakMap<Sim, { key: string; d: Demand }>();

/** Demand for residential, commercial and industrial land today. */
export function demand(sim: Sim): Demand {
  const v = sim.ix.ver;
  const key = `${sim.day}:${v.zones}:${v.roads}:${v.buildings}:${v.projects}`;
  const c = cache.get(sim);
  if (c && c.key === key) return c.d;
  const d = { res: residential(sim), com: commercial(sim), ind: industrial(sim) };
  cache.set(sim, { key, d });
  return d;
}
