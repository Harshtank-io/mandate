// Births, deaths, retirement, new households and migration. People move in when there are jobs and homes,
// and leave when they are unemployed, unhappy or cannot find housing.

import { emptyHhLedger, type Sim } from '../core';
import { hhIncome } from '../econ';
import { firstName, lastName } from '../names';
import { ROLES } from '../tables';
import type { Business, Citizen, Household } from '../types';

const SQRT_PI = Math.sqrt(Math.PI);

function newCitizen(sim: Sim, h: Household, ageYears: number, female: boolean, last: string, partial?: Partial<Citizen>): Citizen {
  const r = sim.rng;
  const c: Citizen = {
    id: sim.newId(), first: firstName(sim, female), last, female, born: sim.day - Math.round(ageYears * 365.25), hh: h.id,
    edu: 0, field: 'gen', status: ageYears < 6 ? 'child' : ageYears < 18 ? 'student' : 'unemployed', school: -1,
    schoolYears: Math.max(0, ageYears - 6) * 0.8, studyLeft: 0, employer: -1, job: -1, wage: 0, exp: Math.max(0, ageYears - 21) * 0.7,
    health: 0.88 + r.next() * 0.1, sat: 0.6, lean: Math.max(-1, Math.min(1, r.normal() * 0.45)), green: r.next() * 0.8,
    mode: 0, commute: 0, commuteKm: 0, unempDays: 0, partner: -1, injured: 0, ...partial,
  };
  sim.addCitizen(c);
  return c;
}

function newHousehold(sim: Sim, cash: number): Household {
  const h: Household = {
    id: sim.newId(), members: [], home: -1, cash, car: false, bike: false, owns: false, rent: 0,
    m: emptyHhLedger(), last: emptyHhLedger(), foodSec: 1, arrived: sim.day, rentArrears: 0, unhappy: 0, incAvg: 0, ration: 0, leisure: 0.5,
  };
  sim.addHousehold(h);
  return h;
}

export function populationDaily(sim: Sim): void {
  const s = sim.s, r = sim.rng, p = sim.preset;
  const deaths: Citizen[] = [];
  const mothers: Citizen[] = [];
  const pandemic = s.weather.pandemic > 0;
  const heat = s.weather.heatDays >= 3;
  const hc = s.services.health;
  const fert = p.tfr / 0.72;
  for (const c of s.citizens) {
    const age = (sim.day - c.born) / 365.25;
    let m = 0.0006 + 0.00004 * Math.exp(0.093 * age);
    if (age < 1) m += 0.02 * (1.25 - 0.5 * hc);
    m *= p.mortality * (1 + 2.2 * Math.max(0, 0.75 - c.health));
    if (pandemic) m *= age > 60 ? 2.5 : 1.3;
    if (heat && age > 70) m *= 1.8;
    if (r.next() < m / 365) { deaths.push(c); continue; }
    if (c.female && c.partner >= 0 && age >= 18 && age < 45) {
      const asfr = (fert * Math.exp(-(((age - 28) / 6) ** 2))) / (6 * SQRT_PI);
      const h = sim.hh(c.hh);
      const housing = !h || h.home < 0 ? 0.5 : h.members.length > 6 ? 0.6 : 1;
      if (r.next() < (asfr * housing) / 365) mothers.push(c);
    }
  }
  for (const c of deaths) {
    s.stats.acc.deaths++;
    sim.removeCitizen(c, 'death');
  }
  for (const mom of mothers) {
    const h = sim.hh(mom.hh);
    if (!h) continue;
    const dad = mom.partner >= 0 ? sim.cit(mom.partner) : undefined;
    newCitizen(sim, h, 0, r.chance(0.49), dad?.last ?? mom.last, { health: 0.85 + 0.12 * hc, lean: ((dad?.lean ?? 0) + mom.lean) / 2 + r.normal() * 0.2 });
    s.stats.acc.births++;
  }
}

function vacantUnits(sim: Sim): { b: number; free: number; rent: number }[] {
  const out: { b: number; free: number; rent: number }[] = [];
  for (const b of sim.s.buildings) {
    if (b.units <= 0 || b.kind === 'farmhouse') continue;
    const free = b.units - b.occupants.length;
    if (free > 0) out.push({ b: b.id, free, rent: b.rent });
  }
  return out;
}

/** Best vacant dwelling for a household given income and workplace. */
export function findHome(sim: Sim, income: number, near: [number, number] | null, cash = 0): number {
  let best = -1, bestScore = -Infinity;
  for (const b of sim.s.buildings) {
    if (b.units <= 0 || b.kind === 'farmhouse' || b.occupants.length >= b.units) continue;
    const burden = income > 0 ? b.rent / income : 2;
    // affordable from income, or from savings that cover half a year of rent
    if (burden > 0.5 && cash < b.rent * 6) continue;
    const [x, y] = sim.center(b);
    const d = near ? Math.abs(x - near[0]) + Math.abs(y - near[1]) : 0;
    const score = -d * 0.8 - burden * 40 + b.condition * 5;
    if (score > bestScore) { bestScore = score; best = b.id; }
  }
  return best;
}

function retirement(sim: Sim): void {
  const retire = sim.s.gov.policies.retirementAge;
  for (const c of sim.s.citizens) {
    if (c.status !== 'working' && c.status !== 'unemployed' && c.status !== 'owner' && c.status !== 'inactive') continue;
    const age = sim.age(c);
    if (c.status === 'owner' && sim.biz(c.employer)?.owner !== c.id) {
      // family members working in the business keep going a little past retirement age
      if (age >= retire + 5) { c.employer = -1; c.status = 'retired'; }
      continue;
    }
    if (c.status === 'owner') {
      if (age >= retire + 8) {
        // hand the business to an adult in the household, or sell it to outside investors
        const b = sim.biz(c.employer);
        const h = sim.hh(c.hh);
        const heir = h?.members.map((id) => sim.cit(id)!).find((m) => m && m.id !== c.id && sim.age(m) >= 22 && sim.age(m) < retire && m.status !== 'owner');
        if (b) {
          if (heir) { if (heir.employer >= 0) sim.leaveJob(heir); heir.status = 'owner'; heir.employer = b.id; heir.job = -1; b.owner = heir.id; }
          else { b.owner = -1; b.extOwned = true; }
        }
        c.employer = -1; c.status = 'retired';
      }
      continue;
    }
    if (age >= retire) { sim.leaveJob(c); c.status = 'retired'; }
  }
}

function formHouseholds(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const singles: Citizen[] = [];
  for (const c of s.citizens) {
    if (c.partner >= 0 || c.status === 'child' || c.status === 'student' || c.status === 'retired') continue;
    const a = sim.age(c);
    if (a >= 21 && a <= 38) singles.push(c);
  }
  r.shuffle(singles);
  const vacant = vacantUnits(sim);
  let free = vacant.reduce((a, v) => a + v.free, 0);
  const used = new Set<number>();
  for (const c of singles) {
    if (used.has(c.id) || !r.chance(0.02)) continue;
    const partner = singles.find((o) => !used.has(o.id) && o.id !== c.id && o.female !== c.female && o.hh !== c.hh && Math.abs(sim.age(o) - sim.age(c)) < 6);
    if (!partner) continue;
    used.add(c.id); used.add(partner.id);
    c.partner = partner.id; partner.partner = c.id;
    const ch = sim.hh(c.hh)!, ph = sim.hh(partner.hh)!;
    // move out of the parents' home if there is somewhere to go; otherwise the couple joins one household
    const income = c.wage + partner.wage;
    if (free > 0 && income > 0) {
      const home = findHome(sim, income, null);
      if (home >= 0) {
        const cash = ch.cash * 0.2 + ph.cash * 0.2;
        ch.cash *= 0.8; ph.cash *= 0.8;
        const h = newHousehold(sim, cash);
        for (const [m, old] of [[c, ch], [partner, ph]] as [Citizen, Household][]) {
          old.members.splice(old.members.indexOf(m.id), 1);
          m.hh = h.id;
          h.members.push(m.id);
          if (old.members.length === 0) { h.cash += old.cash; old.cash = 0; sim.removeHousehold(old, 'ext'); }
        }
        h.car = ch.car && r.chance(0.3);
        h.bike = true;
        h.arrived = sim.day;
        h.incAvg = income * 0.92;
        sim.moveIn(h, sim.bld(home)!, false);
        free--;
        continue;
      }
    }
    // no home available: partner joins the other's household (overcrowding)
    ph.members.splice(ph.members.indexOf(partner.id), 1);
    partner.hh = ch.id;
    ch.members.push(partner.id);
    if (ph.members.length === 0) { ch.cash += ph.cash; ph.cash = 0; sim.removeHousehold(ph, 'ext'); }
    sim.estimateCommute(partner);
  }
}

function emigration(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  let left = 0, households = 0;
  const reasons: Record<string, number> = {};
  for (const h of [...s.households]) {
    let sat = 0, adults = 0, longUnemployed = 0, working = 0, owners = 0;
    for (const id of h.members) {
      const c = sim.cit(id);
      if (!c || sim.age(c) < 18) continue;
      adults++; sat += c.sat;
      if (c.status === 'unemployed' && c.unempDays > 150) longUnemployed++;
      if (c.status === 'working') working++;
      if (c.status === 'owner') owners++;
    }
    if (!adults || owners) continue;
    sat /= adults;
    h.unhappy = sat < 0.4 ? h.unhappy + 1 : 0;
    let p = 0.0005 + 0.02 * Math.max(0, 0.42 - sat);
    let reason = 'dissatisfaction';
    if (longUnemployed && !working) { p += 0.03; reason = 'no work'; }
    if (h.home < 0) { p += 0.025; reason = 'no housing'; }
    if (h.unhappy >= 6) p += 0.02;
    if (r.chance(p)) {
      left += h.members.length;
      households++;
      reasons[reason] = (reasons[reason] ?? 0) + h.members.length;
      sim.removeHousehold(h, 'ext');
    }
  }
  s.stats.acc.emigrants += left;
  if (left >= 25) {
    const main = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0][0];
    sim.emit('migration.out', `${left} residents in ${households} households left the city last month, mainly because of ${main}.`, left >= 80 ? 3 : 2, undefined, undefined,
      Object.entries(reasons).map(([k, v]) => `${v} left citing ${k}`));
  }
}

function immigration(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const vac: { b: Business; j: number }[] = [];
  for (const b of s.businesses) {
    if (b.status !== 'operating' && b.status !== 'hiring') continue;
    b.jobs.forEach((jb, j) => { if (jb.worker < 0) vac.push({ b, j }); });
  }
  const units = vacantUnits(sim);
  const freeUnits = units.reduce((a, u) => a + u.free, 0);
  const pop = s.citizens.length;
  const attract = Math.max(0.1, Math.min(1.5, 0.4 + s.gov.approval));
  const unemp = s.labor.unemployed.reduce((a, x) => a + x, 0);
  // job-driven migration plus a small rural-urban drift when homes are available
  let lambda = Math.max(0, vac.length - unemp * 0.5) * 0.12 * attract + (freeUnits > 0 ? pop * 0.0006 * attract * (1 + 4 * Math.max(0, sim.s.housing.vacancy - 0.05)) : 0);
  if (freeUnits <= 0) lambda *= 0.15;
  else lambda = Math.min(lambda, freeUnits * 0.5 + 1);
  const n = r.poisson(lambda);
  let arrived = 0, noHome = 0;
  for (let k = 0; k < n; k++) {
    const target = vac.length ? vac.splice(r.int(vac.length), 1)[0] : undefined;
    const role = target ? ROLES[target.b.jobs[target.j].role] : undefined;
    const wage = role ? sim.roleWage(role.id) : sim.roleWage('helper');
    const h = newHousehold(sim, 0);
    sim.pay(s.ext, h, wage * (1.5 + 3 * r.next())); // newcomers bring savings from outside
    const last = lastName(sim);
    const female = r.chance(0.3);
    const head = newCitizen(sim, h, 23 + r.int(22), female, last, {
      edu: role ? Math.min(4, role.edu + (r.chance(0.2) ? 1 : 0)) : r.int(3), field: role?.fields ? r.pick(role.fields) : r.chance(0.5) ? 'gen' : 'trade',
      schoolYears: role ? [4, 7, 11, 13, 15][role.edu] : 6,
    });
    if (r.chance(0.55)) {
      const partner = newCitizen(sim, h, Math.max(19, sim.age(head) - 2 + r.int(5)), !female, last, { edu: r.int(4) });
      head.partner = partner.id; partner.partner = head.id;
      partner.status = partner.female && !r.chance(sim.preset.femaleLFP) ? 'inactive' : 'unemployed';
      for (let q = 0, kids = r.poisson(1); q < kids; q++) newCitizen(sim, h, r.int(14), r.chance(0.5), last);
    }
    h.bike = r.chance(sim.preset.bike2026);
    const near = target ? sim.bld(target.b.building) : undefined;
    const home = findHome(sim, wage, near ? sim.center(near) : null);
    if (home >= 0) sim.moveIn(h, sim.bld(home)!, false);
    else noHome++;
    if (target && target.b.jobs[target.j] && target.b.jobs[target.j].worker < 0) sim.hire(target.b, target.j, head);
    h.incAvg = head.wage * 0.92;
    arrived += h.members.length;
  }
  s.stats.acc.immigrants += arrived;
  if (arrived >= 25) {
    sim.emit('migration.in', `${arrived} people moved to the city last month${noHome ? `; ${noHome} families found no home and are living with relatives` : ''}.`, 1, undefined, undefined,
      [`${vac.length + n} job vacancies attracted workers`, `${freeUnits} homes were available`]);
  }
}

export function populationMonthly(sim: Sim): void {
  retirement(sim);
  formHouseholds(sim);
  emigration(sim);
  immigration(sim);
  // families without a home keep looking; a few move in with relatives instead
  for (const h of sim.s.households) {
    if (h.home >= 0) continue;
    const income = Math.max(1, hhIncome(h));
    const home = findHome(sim, income, null);
    if (home >= 0) sim.moveIn(h, sim.bld(home)!, false);
  }
}
