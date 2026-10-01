// Labour market: job search and matching, casual labour pool, market wages by skill tier.

import type { Sim } from '../core';
import { BUSINESSES, ROLES } from '../tables';
import type { Business, Citizen } from '../types';

type Vacancy = { b: Business; j: number };
const TIER_BASE = [12000, 15000, 22000, 28000, 55000];

export function tierWage(sim: Sim, tier: number): number {
  return Math.max(sim.s.gov.policies.minWage, TIER_BASE[tier] * sim.scale * sim.s.ext.trend * sim.s.labor.wage[tier]);
}

function vacancies(sim: Sim): Vacancy[][] {
  const s = sim.s;
  const vac: Vacancy[][] = [[], [], [], [], []];
  for (const b of s.businesses) {
    if (b.status !== 'operating' && b.status !== 'hiring') continue;
    if (b.downDays > 0 && !b.pub) continue;
    let limit = b.jobs.length;
    if (b.pub) {
      const dept = BUSINESSES[b.kind].dept!;
      limit = Math.floor(b.jobs.length * Math.min(1, s.gov.deptFunding[dept] + 0.02));
    }
    let filled = 0;
    for (const jb of b.jobs) if (jb.worker >= 0) filled++;
    if (filled >= limit) continue;
    b.jobs.forEach((jb, j) => { if (jb.worker < 0) vac[ROLES[jb.role].edu].push({ b, j }); });
  }
  return vac;
}

function tryMatch(sim: Sim, c: Citizen, vac: Vacancy[][], minGain: number): boolean {
  const r = sim.rng;
  const home = sim.homeOf(c);
  const reservation = Math.max(
    sim.s.gov.policies.minWage,
    sim.s.gov.policies.unemploymentBenefit * 1.25,
    tierWage(sim, Math.min(4, c.edu)) * 0.8 * Math.max(0.55, 1 - c.unempDays / 400),
  );
  let best: { list: Vacancy[]; k: number; u: number } | null = null;
  for (let t = Math.min(4, c.edu); t >= Math.max(0, c.edu - 2); t--) {
    if (t < c.edu && c.status === 'unemployed' && c.unempDays < 45 * (c.edu - t)) continue;
    const list = vac[t];
    if (!list.length) continue;
    for (let n = 0; n < 8; n++) {
      const k = r.int(list.length);
      const v = list[k];
      const jb = v.b.jobs[v.j];
      if (!jb || jb.worker >= 0) continue;
      const role = ROLES[jb.role];
      if (role.fields && !role.fields.includes(c.field)) continue;
      const bl = sim.bld(v.b.building);
      const km = home && bl ? (sim.dist(home, bl) * 40) / 1000 : 3;
      const u = jb.wage * (1 - Math.min(0.35, km * 0.018));
      if (!best || u > best.u) best = { list, k, u };
    }
    if (best) break;
  }
  if (!best) return false;
  const v = best.list[best.k];
  if (best.u < reservation * minGain) return false;
  if (c.status === 'working' && best.u < c.wage * minGain) return false;
  sim.hire(v.b, v.j, c);
  best.list[best.k] = best.list[best.list.length - 1];
  best.list.pop();
  return true;
}

export function laborDaily(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const vac = vacancies(sim);
  for (let t = 0; t < 5; t++) s.labor.vacancies[t] = vac[t].length;
  const unemp = [0, 0, 0, 0, 0];
  const pool: number[] = [];
  const retire = s.gov.policies.retirementAge;
  const pandemic = s.weather.pandemic > 0;
  for (const c of s.citizens) {
    if (c.injured > 0) c.injured--;
    if (c.status === 'unemployed') {
      c.unempDays++;
      unemp[Math.min(4, c.edu)]++;
      if (c.injured <= 0) pool.push(c.id);
      if (c.injured <= 0 && r.chance(pandemic ? 0.1 : c.unempDays < 30 ? 0.35 : 0.2)) tryMatch(sim, c, vac, 1);
    } else if (c.status === 'working') {
      if (r.chance(0.003)) tryMatch(sim, c, vac, 1.15);
    } else if (c.status === 'owner' && c.job === -1 && r.chance(0.002)) {
      // family members on farms and in shops take town jobs when those pay well
      const b = sim.biz(c.employer);
      if (b && b.owner !== c.id) tryMatch(sim, c, vac, 1.1);
    } else if (c.status === 'inactive' && c.injured <= 0 && r.chance(0.3)) {
      const age = sim.age(c);
      if (age >= 16 && age < retire) pool.push(c.id);
    }
  }
  s.labor.unemployed = unemp;
  sim.ix.casualPool = r.shuffle(pool);
  sim.ix.casualUsed = 0;
}

export function laborMonthly(sim: Sim): void {
  const s = sim.s;
  for (let t = 0; t < 5; t++) {
    const V = s.labor.vacancies[t], U = s.labor.unemployed[t];
    const tight = (V - U) / Math.max(20, V + U);
    // wages rise quickly when employers compete for workers but are sticky on the way down
    const change = tight >= 0 ? Math.min(0.02, 0.03 * tight) : U > 2 * V + 10 ? Math.max(-0.0025, 0.01 * tight) : 0;
    s.labor.wage[t] = Math.max(0.5, s.labor.wage[t] * (1 + change));
  }
  const minWage = s.gov.policies.minWage;
  for (const b of s.businesses) {
    for (const jb of b.jobs) {
      const mkt = sim.roleWage(jb.role);
      if (jb.worker < 0) jb.wage = mkt;
      else if (mkt > jb.wage) jb.wage += (mkt - jb.wage) * 0.08;
      if (jb.wage < minWage) jb.wage = minWage;
      if (jb.worker >= 0) { const c = sim.cit(jb.worker); if (c) { c.wage = jb.wage; c.exp += 1 / 12; } }
    }
  }
}
