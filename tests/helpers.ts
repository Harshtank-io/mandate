import { Simulation } from '../src/sim/simulation';
import type { Sim } from '../src/sim/core';
import type { WorldState } from '../src/sim/types';
import type { NewWorldOptions } from '../src/sim/worldgen';

export const OPTS: NewWorldOptions = { name: 'Testpur', preset: 'in-deccan', startYear: 2026, condition: 'developing', seed: 1234, pace: 2, offlineCapDays: 365, now: 0 };

export function world(o: Partial<NewWorldOptions> = {}): Simulation {
  return Simulation.generate({ ...OPTS, ...o });
}

export function clone(sim: Simulation): Simulation {
  return Simulation.fromState(JSON.parse(JSON.stringify(sim.state)) as WorldState);
}

export function totalMoney(s: WorldState): number {
  let t = s.gov.cash + s.ext.cash;
  for (const h of s.households) t += h.cash;
  for (const b of s.businesses) t += b.cash;
  return t;
}

/** Path of the first difference between two JSON-like values, or null when equal. */
export function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (typeof a === 'number' && typeof b === 'number' && Object.is(a, -0) !== Object.is(b, -0) && a === b) return null;
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return `${path}: keys ${ka.length} vs ${kb.length}`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Every number in the state must be finite (NaN or Infinity would not survive a save either). */
export function nonFinite(v: unknown, path = '$', out: string[] = []): string[] {
  if (out.length > 5) return out;
  if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(path); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) nonFinite(x, `${path}.${k}`, out);
  return out;
}

/** Cross-references between citizens, households, homes, jobs, buildings and the map must agree. */
export function integrity(sim: Sim): string[] {
  const s = sim.s, errs: string[] = [];
  const err = (m: string) => { if (errs.length < 12) errs.push(m); };
  for (const c of s.citizens) {
    const h = sim.hh(c.hh);
    if (!h) err(`citizen ${c.id} has no household ${c.hh}`);
    else if (!h.members.includes(c.id)) err(`citizen ${c.id} missing from household ${h.id}`);
    if (c.employer >= 0) {
      const b = sim.biz(c.employer);
      if (!b) err(`citizen ${c.id} works for missing business ${c.employer}`);
      else if (c.job >= 0 && b.jobs[c.job]?.worker !== c.id) err(`citizen ${c.id} job slot mismatch at ${b.name}`);
    }
    if (c.status === 'working' && (c.employer < 0 || c.job < 0)) err(`citizen ${c.id} working without a job`);
    if (c.partner >= 0 && sim.cit(c.partner)?.partner !== c.id) err(`citizen ${c.id} partner link broken`);
  }
  for (const h of s.households) {
    if (!h.members.length) err(`household ${h.id} is empty`);
    for (const id of h.members) if (sim.cit(id)?.hh !== h.id) err(`household ${h.id} lists citizen ${id} who lives elsewhere`);
    if (h.home >= 0) {
      const b = sim.bld(h.home);
      if (!b) err(`household ${h.id} lives in missing building ${h.home}`);
      else if (!b.occupants.includes(h.id)) err(`household ${h.id} not in occupant list of ${b.id}`);
    }
  }
  for (const b of s.businesses) {
    b.jobs.forEach((j, k) => {
      if (j.worker < 0) return;
      const c = sim.cit(j.worker);
      if (!c) err(`${b.name} job ${k} held by missing citizen ${j.worker}`);
      else if (c.employer !== b.id || c.job !== k) err(`${b.name} job ${k} holder ${c.id} points elsewhere`);
    });
    if (b.building >= 0 && !sim.bld(b.building)) err(`${b.name} has missing premises ${b.building}`);
    if (b.farm) for (const t of b.farm.fields) if (s.map.farm[t] !== b.id) err(`${b.name} field ${t} not on the map`);
  }
  for (const b of s.buildings) {
    if (b.occupants.length > Math.max(b.units, 1)) err(`building ${b.id} over capacity`);
    for (const hid of b.occupants) if (sim.hh(hid)?.home !== b.id) err(`building ${b.id} lists household ${hid} that lives elsewhere`);
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (s.map.owner[y * 128 + x] !== b.id) err(`building ${b.id} footprint not on the map`);
  }
  return errs;
}
