// Public services and wellbeing: school enrolment and graduation, colleges, healthcare coverage, policing and
// crime, citizen health and satisfaction.

import type { Sim } from '../core';
import { hhIncome } from '../econ';
import { BUSINESSES, ROLES } from '../tables';
import type { Business, Citizen, Field, Household } from '../types';
import { envAt } from './environment';

const CELLS = 16;
export const cellOf = (x: number, y: number) => Math.min(CELLS - 1, Math.max(0, Math.floor(y / 8))) * CELLS + Math.min(CELLS - 1, Math.max(0, Math.floor(x / 8)));

function staffShare(b: Business, roles?: string[]): number {
  let tot = 0, fil = 0;
  for (const j of b.jobs) {
    if (roles && !roles.includes(j.role)) continue;
    tot++;
    if (j.worker >= 0) fil++;
  }
  const template = BUSINESSES[b.kind].jobs.filter(([r]) => !roles || roles.includes(r)).reduce((a, [, n]) => a + n, 0);
  return template > 0 ? fil / template : tot ? fil / tot : 0;
}

const KEY: Partial<Record<string, string[]>> = {
  school: ['teacher'], college: ['lecturer'], police: ['officer'], clinic: ['doctor', 'nurse'], hospital: ['doctor', 'nurse'],
  museum: ['curator', 'host'], stadium: ['host', 'security'], airport: ['controller', 'security'], firestation: ['firefighter'],
  gasplant: ['plantop', 'technician'], waterworks: ['plantop', 'technician'], solarfarm: ['technician'], windfarm: ['technician'],
};

/**
 * Service a public facility delivers, 0..1: its key staff, the department's funding and whether suppliers get paid.
 * Blackouts take a little off (`power` false for plants and waterworks, whose own supply is worked out separately).
 */
export function facilityQuality(sim: Sim, b: Business, power = true): number {
  const dept = BUSINESSES[b.kind].dept;
  const funding = dept ? Math.min(1, sim.s.gov.deptFunding[dept]) : 1;
  const staff = Math.min(1, staffShare(b, KEY[b.kind]));
  const arrears = sim.s.gov.arrears > 0 ? 0.8 : 1;
  const pw = power ? 0.8 + 0.2 * (sim.bld(b.building)?.pw ?? 1) : 1;
  return Math.max(0, staff * (0.7 + 0.3 * funding) * arrears * pw);
}

/** Two-step floating catchment: facility capacity shared among nearby residents with distance decay. */
function catchment(sim: Sim, kinds: string[], radius: (b: Business) => number, capacity: (b: Business) => number, pop: number[]): number[] {
  const cov = new Array(CELLS * CELLS).fill(0);
  for (const b of sim.s.businesses) {
    if (!kinds.includes(b.kind) || (b.status !== 'operating' && b.status !== 'hiring')) continue;
    const bl = sim.bld(b.building);
    if (!bl) continue;
    const [bx, by] = sim.center(bl);
    const r = radius(b);
    const ws: number[] = [];
    let demand = 0;
    for (let k = 0; k < CELLS * CELLS; k++) {
      const cx = (k % CELLS) * 8 + 4, cy = Math.floor(k / CELLS) * 8 + 4;
      const d = Math.hypot(cx - bx, cy - by);
      const w = d > r * 2 ? 0 : 1 / (1 + (d / r) ** 2);
      ws.push(w);
      demand += pop[k] * w;
    }
    const ratio = capacity(b) / Math.max(1, demand);
    for (let k = 0; k < CELLS * CELLS; k++) if (ws[k] > 0) cov[k] += ratio * ws[k];
  }
  return cov.map((v) => Math.min(1, v));
}

export function servicesMonthly(sim: Sim): void {
  const s = sim.s, sv = s.services;
  const pop = new Array(CELLS * CELLS).fill(0);
  const kidsCell = new Array(CELLS * CELLS).fill(0);
  for (const c of s.citizens) {
    const home = sim.homeOf(c);
    if (!home) continue;
    const k = cellOf(home.x, home.y);
    pop[k]++;
    const a = sim.age(c);
    if (a >= 6 && a < 18) kidsCell[k]++;
  }
  sv.healthCov = catchment(sim, ['clinic', 'hospital'], (b) => (b.kind === 'hospital' ? 55 : 22), (b) => (BUSINESSES[b.kind].serves ?? 0) * facilityQuality(sim, b), pop);
  sv.policeCov = catchment(sim, ['police'], () => 30, (b) => (BUSINESSES.police.serves ?? 0) * facilityQuality(sim, b), pop);
  sv.schoolCov = catchment(sim, ['school'], () => 30, (b) => (BUSINESSES.school.serves ?? 0) * facilityQuality(sim, b), kidsCell);
  // fire engines reach about 1.2 km in the first minutes; crews without mains water fight fires with what they carry
  sv.fireCov = catchment(sim, ['firestation'], () => 26, (b) => (BUSINESSES.firestation.serves ?? 0) * facilityQuality(sim, b) * (0.6 + 0.4 * (sim.bld(b.building)?.wt ?? 1)), pop);
  education(sim);
  // crime: unemployment and poverty raise it, police coverage lowers it
  const lf = s.citizens.filter((c) => c.status === 'working' || c.status === 'unemployed' || c.status === 'owner').length;
  const unemp = lf ? s.citizens.filter((c) => c.status === 'unemployed').length / lf : 0;
  const line = povertyLine(sim);
  const poorCell = new Array(CELLS * CELLS).fill(0), hhCell = new Array(CELLS * CELLS).fill(0);
  for (const h of s.households) {
    const home = h.home >= 0 ? sim.bld(h.home) : undefined;
    if (!home) continue;
    const k = cellOf(home.x, home.y);
    hhCell[k]++;
    if (hhIncome(h) / Math.max(1, h.members.length) < line) poorCell[k]++;
  }
  const crimeCell = pop.map((_, k) => 0.02 * (1 + 3 * unemp + 0.8 * (hhCell[k] ? poorCell[k] / hhCell[k] : 0)) * (1.3 - 0.9 * sv.policeCov[k]));
  let cw = 0, ct = 0, hw = 0, ht = 0;
  for (let k = 0; k < pop.length; k++) { cw += crimeCell[k] * pop[k]; ct += pop[k]; hw += sv.healthCov[k] * pop[k]; }
  sv.crime = ct ? cw / ct : 0.02;
  sv.health = ct ? hw / ct : 0;
  ht = kidsCell.reduce((a, x) => a + x, 0);
  sv.education = ht ? kidsCell.reduce((a, x, k) => a + x * sv.schoolCov[k], 0) / ht : 1;
  sv.safety = Math.max(0, 1 - sv.crime * 10);
  wellbeing(sim, crimeCell);
}

export function povertyLine(sim: Sim): number { return 4500 * sim.scale * sim.s.ext.trend; }

function education(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const schools = s.businesses.filter((b) => b.kind === 'school' && (b.status === 'operating' || b.status === 'hiring'));
  const college = s.businesses.find((b) => b.kind === 'college' && (b.status === 'operating' || b.status === 'hiring'));
  const enrolled = new Map<number, number>();
  for (const c of s.citizens) if (c.school >= 0) enrolled.set(c.school, (enrolled.get(c.school) ?? 0) + 1);
  const quality = new Map<number, number>();
  for (const b of [...schools, ...(college ? [college] : [])]) {
    const q = facilityQuality(sim, b);
    const n = enrolled.get(b.id) ?? 0;
    const seats = BUSINESSES[b.kind].serves ?? 400;
    quality.set(b.id, q * Math.min(1, seats / Math.max(1, n)));
  }
  const yearStart = sim.date.month === sim.preset.schoolStartMonth;
  const lfp = sim.preset.femaleLFP;
  for (const c of [...s.citizens]) {
    const age = sim.age(c);
    if (c.status === 'child' && age >= 6) c.status = 'student';
    if (c.status !== 'student') continue;
    if (age < 18) {
      if (c.school >= 0 && !sim.biz(c.school)) c.school = -1;
      if (c.school < 0 || (yearStart && !schools.some((sc) => sc.id === c.school))) {
        const home = sim.homeOf(c);
        let best: Business | undefined, bd = 60;
        for (const sc of schools) {
          const bl = sim.bld(sc.building);
          if (!bl || !home) continue;
          const seats = BUSINESSES.school.serves ?? 420;
          if ((enrolled.get(sc.id) ?? 0) >= seats) continue;
          const d = sim.dist(bl, home);
          if (d < bd) { bd = d; best = sc; }
        }
        if (best) { c.school = best.id; enrolled.set(best.id, (enrolled.get(best.id) ?? 0) + 1); sim.estimateCommute(c); }
      }
      if (c.school >= 0) c.schoolYears += (quality.get(c.school) ?? 0.5) / 12;
      continue;
    }
    // adults: college students progress, school leavers choose what comes next
    if (college && c.school === college.id) {
      c.studyLeft -= 30.4 * (0.6 + 0.4 * (quality.get(college.id) ?? 0.5));
      if (c.studyLeft <= 0) {
        c.edu = c.schoolYears >= 11 ? 4 : 3;
        if (c.edu === 3 && (c.field === 'biz' || c.field === 'gen')) c.field = 'trade';
        c.school = -1;
        c.status = 'unemployed';
        c.unempDays = 0;
        sim.estimateCommute(c);
      }
      continue;
    }
    // finished school
    c.school = -1;
    c.edu = c.schoolYears >= 9.5 ? 2 : c.schoolYears >= 4.5 ? 1 : 0;
    const h = sim.hh(c.hh);
    const income = h ? hhIncome(h) / Math.max(1, h.members.length) : 0;
    const aspire = c.edu >= 2 ? 0.3 + Math.min(0.35, income / (povertyLine(sim) * 8)) : 0;
    if (college && r.chance(aspire)) {
      const cEnrolled = enrolled.get(college.id) ?? 0;
      if (cEnrolled < (BUSINESSES.college.serves ?? 600)) {
        c.school = college.id;
        c.field = chooseField(sim);
        c.studyLeft = (c.schoolYears >= 11 ? 4 : 3) * 365;
        enrolled.set(college.id, cEnrolled + 1);
        sim.estimateCommute(c);
        continue;
      }
    }
    if (!college && c.edu >= 2 && r.chance(aspire * 0.7)) {
      // leaves to study elsewhere
      c.status = 'inactive';
      sim.s.stats.acc.emigrants++;
      sim.removeCitizen(c, 'emigration');
      continue;
    }
    c.status = !c.female || r.chance(lfp + 0.1) ? 'unemployed' : 'inactive';
    c.unempDays = 0;
  }
}

function chooseField(sim: Sim): Field {
  const vac: Record<Field, number> = { gen: 1, eng: 1, med: 1, biz: 1, trade: 1 };
  for (const b of sim.s.businesses) for (const j of b.jobs) {
    if (j.worker >= 0) continue;
    const f = ROLES[j.role].fields;
    if (!f) continue;
    for (const x of f) vac[x] += 0.4;
  }
  const fields: Field[] = ['gen', 'eng', 'med', 'biz', 'trade'];
  return sim.rng.weighted(fields, fields.map((f) => vac[f] * (f === 'eng' ? 1.3 : 1)));
}

export interface SatParts {
  employment: number; income: number; housing: number; commute: number; health: number; safety: number; environment: number; food: number; taxes: number;
  services: number; leisure: number; utilities: number;
}
export const SAT_WEIGHTS: SatParts = {
  employment: 0.141, income: 0.141, housing: 0.1128, commute: 0.0752, health: 0.094, safety: 0.0752, environment: 0.0658, food: 0.094, taxes: 0.047,
  services: 0.047, leisure: 0.047, utilities: 0.06,
};

export function satisfactionParts(sim: Sim, c: Citizen, h: Household | undefined, crime: number): SatParts {
  const s = sim.s, sv = s.services;
  const home = sim.homeOf(c);
  const k = home ? cellOf(home.x, home.y) : 0;
  const income = h ? Math.max(0, hhIncome(h)) : 0;
  const pc = h ? income / Math.max(1, h.members.length) : 0;
  const line = povertyLine(sim);
  const benefit = s.gov.policies.unemploymentBenefit / Math.max(1, s.gov.policies.minWage);
  const employment = c.status === 'unemployed' ? 0.25 + Math.min(0.3, benefit * 0.5) : c.status === 'inactive' ? 0.7 : 1;
  const incomeS = Math.max(0, Math.min(1, Math.log2(Math.max(1, pc) / line) / 3 + 0.45));
  let housing = 0.8;
  if (!h || h.home < 0) housing = 0.05;
  else if (!h.owns) {
    const burden = income > 0 ? h.rent / income : 1;
    housing = 1 - Math.max(0, Math.min(0.85, (burden - 0.25) * 2.5));
    if (h.rentArrears > 0) housing *= 0.6;
  } else housing = 0.95;
  if (h && home && home.units > 0 && h.members.length > 6) housing *= 0.8;
  const commute = c.commute > 0 ? 1 - Math.max(0, Math.min(1, (c.commute - 20) / 60)) : 0.9;
  const health = Math.min(1, 0.5 * c.health + 0.5 * sv.healthCov[k]);
  const safety = Math.max(0, 1 - crime * 9);
  const env = envAt(sim, home ? home.x : 64, home ? home.y : 64);
  const environment = Math.max(0, 1 - env * (0.5 + c.green));
  const food = h ? h.foodSec : 0.5;
  const gross = h ? h.last.wages + h.last.benefits + h.last.dividends : 0;
  const burden = h && gross > 0 ? (h.last.taxes + h.last.food * 0.05) / gross : 0;
  const taxes = Math.max(0, Math.min(1, 1 - burden * (2 + 2 * c.lean)));
  const hasKids = h ? h.members.some((id) => { const m = sim.cit(id); return !!m && m.status === 'student' && sim.age(m) < 18; }) : false;
  const services = hasKids ? 0.5 * sv.schoolCov[k] + 0.5 * sv.healthCov[k] : sv.healthCov[k] * 0.7 + 0.3 * (1 - (c.lean > 0.3 ? 0 : 0.3));
  // places to go nearby (parks are free) and whether the family can afford to go out
  const leisure = Math.min(1, 0.25 + 0.4 * (s.leisure.cov[k] ?? 0) + 0.35 * (h?.leisure ?? 0.3));
  // reliable electricity and mains water at home, and bills the family can afford
  const pw = home ? home.pw ?? 1 : 0.5, wt = home ? home.wt ?? 1 : 0.3;
  const billShare = h && income > 0 ? h.last.utilities / income : 0;
  const utilities = (0.55 * pw + 0.45 * wt) * (1 - Math.max(0, Math.min(0.4, (billShare - 0.03) * 5)));
  return { employment, income: incomeS, housing, commute, health, safety, environment, food, taxes, services, leisure, utilities };
}

export function satisfactionOf(p: SatParts): number {
  let t = 0;
  for (const k of Object.keys(SAT_WEIGHTS) as (keyof SatParts)[]) t += SAT_WEIGHTS[k] * p[k];
  return t;
}

function wellbeing(sim: Sim, crimeCell: number[]): void {
  const s = sim.s, sv = s.services;
  const pandemic = s.weather.pandemic > 0;
  let satSum = 0, adults = 0, leisureSum = 0;
  for (const c of s.citizens) {
    const h = sim.hh(c.hh);
    const home = sim.homeOf(c);
    const k = home ? cellOf(home.x, home.y) : 0;
    const age = sim.age(c);
    const pollution = envAt(sim, home ? home.x : 64, home ? home.y : 64);
    // well and tanker water is often unsafe; blackouts mean no fans in the heat and spoiled food
    const unsafe = home ? 1 - (home.wt ?? 1) : 0.7, dark = home ? 1 - (home.pw ?? 1) : 0.5;
    const target = 0.92 - Math.max(0, age - 45) * 0.006 - pollution * 0.25 - (1 - (h?.foodSec ?? 0.7)) * 0.3
      - (1 - sv.healthCov[k]) * 0.15 - (pandemic ? 0.12 : 0) - (!h || h.home < 0 ? 0.08 : 0) - unsafe * 0.05 - dark * 0.02;
    c.health = Math.max(0.05, Math.min(1, c.health + (target - c.health) * 0.15));
    if (age < 16) continue;
    const parts = satisfactionParts(sim, c, h, crimeCell[k]);
    const t = satisfactionOf(parts);
    c.sat += (t - c.sat) * 0.3;
    satSum += c.sat;
    leisureSum += parts.leisure;
    adults++;
  }
  s.gov.approval = adults ? satSum / adults : 0.5;
  s.leisure.avg = adults ? leisureSum / adults : 0.6;
}
