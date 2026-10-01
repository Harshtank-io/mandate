// Business lifecycle (registration -> licensing -> hiring -> operating -> closure) and monthly accounts:
// payroll, upkeep, loans, profit tax, dividends, hiring and layoffs.

import { emptyLedger, type Sim } from '../core';
import { maintenanceWork, payWage } from '../econ';
import { BUILDINGS, BUSINESSES, ROLES } from '../tables';
import type { Business, RoleId, SimEvent } from '../types';
import { backlog } from './logistics';

const REG_DAYS = [5, 14, 30];
export const HOLIDAY = new Set(['factory', 'foodplant', 'materials', 'office', 'hotel']);
/** Businesses whose staff grows with the size of the building. */
const SCALED = new Set(['office', 'hotel']);
const LIC_DAYS = [7, 21, 45];

function adminDelay(sim: Sim): number {
  return 1 + Math.max(0, 1 - sim.s.gov.deptFunding.admin) * 1.5;
}

export function businessDaily(sim: Sim): void {
  const s = sim.s;
  const reg = s.gov.policies.businessRegulation;
  for (const b of s.businesses) {
    const days = sim.day - b.statusDay;
    switch (b.status) {
      case 'registering':
        if (days >= REG_DAYS[reg] * adminDelay(sim)) {
          sim.tax('licenseFees', b, s.gov.taxes.licenseFee);
          b.m.other += s.gov.taxes.licenseFee;
          b.status = 'licensing'; b.statusDay = sim.day;
        }
        break;
      case 'licensing': {
        const industrial = ['factory', 'foodplant', 'materials'].includes(b.kind);
        if (days >= LIC_DAYS[reg] * adminDelay(sim) * (industrial ? 1 + 0.5 * s.gov.policies.environmentalRegulation : 1)) {
          b.status = 'hiring'; b.statusDay = sim.day;
          sim.ix.storesDirty = true;
        }
        break;
      }
      case 'hiring': {
        const filled = b.jobs.filter((j) => j.worker >= 0).length;
        if (filled >= b.jobs.length * 0.5 || days >= 45 || b.jobs.length === 0) {
          b.status = 'operating'; b.statusDay = sim.day; b.lossMonths = 0;
          // a local founder now works in the business full time
          const o = b.owner >= 0 && b.kind !== 'realestate' ? sim.cit(b.owner) : undefined;
          if (o && o.status !== 'owner') { if (o.employer >= 0) sim.leaveJob(o); o.status = 'owner'; o.employer = b.id; o.job = -1; }
          sim.ix.storesDirty = true;
          s.stats.acc.opened++;
          const bl = sim.bld(b.building);
          sim.emit('business.opened', `${b.name} opened${b.jobs.length ? ` with ${filled} of ${b.jobs.length} jobs filled` : ''}.`, b.jobs.length >= 30 ? 2 : 1,
            bl ? { k: 'building', id: bl.id } : undefined, undefined, b.reason ? [b.reason] : undefined);
        }
        break;
      }
    }
  }
}

function jobsRole(b: Business): RoleId {
  switch (b.kind) {
    case 'services': return 'helper';
    case 'grocery': case 'shop': return 'clerk';
    case 'restaurant': return 'cook';
    case 'hotel': case 'cinema': return 'host';
    case 'office': return 'engineer';
    case 'logistics': return 'driver';
    case 'construction': return 'laborer';
    case 'farm': return 'farmhand';
    default: return 'operator';
  }
}

function cutJobs(sim: Sim, b: Business, n: number, reason: string): number {
  let cut = 0;
  // vacant positions go first, then the least experienced staff
  for (let i = b.jobs.length - 1; i >= 0 && cut < n; i--) if (b.jobs[i].worker < 0) { sim.removeJob(b, i); cut++; }
  while (cut < n && b.jobs.length > 1) {
    let worst = -1, we = Infinity;
    b.jobs.forEach((j, i) => { const c = sim.cit(j.worker); if (c && c.exp < we) { we = c.exp; worst = i; } });
    if (worst < 0) break;
    sim.removeJob(b, worst);
    cut++;
  }
  if (cut >= 5) {
    const bl = sim.bld(b.building);
    sim.emit('business.layoffs', `${b.name} cut ${cut} jobs. ${reason}`, cut >= 20 ? 3 : 2, bl ? { k: 'building', id: bl.id } : undefined, undefined, [reason]);
  }
  return cut;
}

function adjustJobs(sim: Sim, b: Business, after: number): void {
  const L = b.last;
  const revenue = L.revenue;
  const margin = revenue > 0 ? after / revenue : -1;
  const vacant = b.jobs.filter((j) => j.worker < 0).length;
  const role = jobsRole(b);
  switch (b.kind) {
    case 'grocery': case 'shop': case 'restaurant': case 'services': case 'cinema':
      if (L.unmet > revenue * 0.1 && after > 0 && vacant === 0 && b.jobs.length < b.capacity) sim.addJobs(b, role, 1);
      else if (b.lossMonths >= 2 && b.jobs.length > 1) cutJobs(sim, b, 1, 'Sales no longer cover staff costs.');
      break;
    case 'hotel': {
      const occ = b.hotel && b.hotel.rooms > 0 ? b.hotel.lastNights / (b.hotel.rooms * 30) : 0;
      if (occ > 0.8 && after > 0 && vacant === 0 && b.jobs.length < b.capacity) sim.addJobs(b, 'helper', 1);
      else if (b.lossMonths >= 2 && occ < 0.35 && b.jobs.length > 3) cutJobs(sim, b, 1, 'Too few guests to keep all staff.');
      break;
    }
    case 'factory': case 'foodplant': case 'materials': {
      const ops = b.jobs.filter((j) => j.role === 'operator').length;
      if (after > 0 && margin > 0.08 && vacant <= 1 && b.jobs.length < b.capacity) sim.addJobs(b, 'operator', Math.max(1, Math.round(ops * 0.1)));
      else if (b.lossMonths >= 2) cutJobs(sim, b, Math.max(1, Math.round(ops * 0.12)), b.reason || 'Losses for two months running.');
      break;
    }
    case 'office':
      if (after > 0 && margin > 0.1 && vacant === 0 && b.jobs.length < b.capacity) sim.addJobs(b, sim.rng.chance(0.6) ? 'engineer' : 'analyst', 1);
      else if (b.lossMonths >= 2) cutJobs(sim, b, Math.max(1, Math.round(b.jobs.length * 0.1)), b.reason || 'Contracts have dried up.');
      break;
    case 'logistics': {
      const late = backlog(sim);
      const nominal = sim.scale * sim.s.ext.trend;
      if (late > 3 && after > 0 && b.cash > 3_200_000 * nominal && b.jobs.length < b.capacity) {
        sim.pay(b, sim.s.ext, 3_000_000 * nominal);
        b.m.other += 3_000_000 * nominal;
        sim.addJobs(b, 'driver', 1);
        b.trucks!.push({ freeAt: 0 });
      } else if (b.lossMonths >= 3 && b.trucks!.length > 2) {
        cutJobs(sim, b, 1, 'Freight volumes are down.');
        b.trucks!.pop();
      }
      break;
    }
    case 'construction': {
      // crews follow the order book: project crews plus maintenance contracts
      let demand = 0;
      // sites already contracted to an outside firm (contractor -2) are not work this firm will get
      for (const p of sim.s.projects) if (p.phase === 'construction' && (p.contractor === b.id || p.contractor === -1)) demand += BUILDINGS[p.kind as keyof typeof BUILDINGS]?.crew ?? 15;
      const crew = b.jobs.filter((j) => j.role === 'laborer').length;
      if ((demand > crew * 1.1 || margin > 0.12) && after > 0 && vacant <= 2 && b.jobs.length < b.capacity * 2) sim.addJobs(b, 'laborer', Math.min(8, Math.max(1, Math.ceil((demand - crew) / 3))));
      else if (b.lossMonths >= 2 && crew > 6) cutJobs(sim, b, Math.max(1, Math.round(crew * 0.15)), 'Not enough construction contracts.');
      break;
    }
  }
}

/** Works out why a business is losing money, pointing at simulation events where possible. */
export function diagnose(sim: Sim, b: Business): { text: string; causes: number[] } {
  const causes: number[] = [];
  const parts: string[] = [];
  const rev = b.revHist, cost = b.costHist;
  const n = rev.length;
  const avg = (a: number[], i: number, j: number) => { const sl = a.slice(Math.max(0, i), Math.max(0, j)); return sl.length ? sl.reduce((x, y) => x + y, 0) / sl.length : 0; };
  const r1 = avg(rev, n - 3, n), r0 = avg(rev, n - 9, n - 3);
  const c1 = avg(cost, n - 3, n), c0 = avg(cost, n - 9, n - 3);
  if (sim.s.ext.phase === 'recession' && (b.kind === 'factory' || b.kind === 'office')) {
    const e = sim.recentEvent('world.recession', 540);
    parts.push('the global recession cut export demand');
    if (e) causes.push(e.id);
  }
  if (r0 > 0 && r1 < r0 * 0.85) {
    let why = `sales fell ${Math.round((1 - r1 / r0) * 100)}%`;
    const bl = sim.bld(b.building);
    if (bl && ['grocery', 'shop', 'restaurant'].includes(b.kind)) {
      const rival = sim.s.events.slice().reverse().find((e) => e.type === 'business.opened' && sim.day - e.day < 240 && e.ref?.k === 'building'
        && (() => { const ob = sim.bld(e.ref!.id); const obz = ob ? sim.biz(ob.biz) : undefined; return !!ob && !!obz && obz.kind === b.kind && obz.id !== b.id && sim.dist(ob, bl) < 10; })());
      if (rival) { why += ' after a competitor opened nearby'; causes.push(rival.id); }
    }
    if (b.farm) {
      const d = sim.recentEvent('weather.drought', 300) ?? sim.recentEvent('weather.flood', 300);
      if (d) { why += d.type === 'weather.drought' ? ' after the drought ruined the harvest' : ' after floods damaged the crop'; causes.push(d.id); }
    }
    parts.push(why);
  }
  if (c0 > 0 && c1 > c0 * 1.12) {
    let why = `costs rose ${Math.round((c1 / c0 - 1) * 100)}%`;
    const tax = sim.s.events.slice().reverse().find((e) => (e.type === 'tax.changed' || e.type === 'policy.changed') && sim.day - e.day < 240);
    if (tax) { why += ` (${tax.text.replace(/\.$/, '').toLowerCase()})`; causes.push(tax.id); }
    const fuel = sim.recentEvent('world.fuel', 240);
    if (fuel && (b.kind === 'logistics' || b.kind === 'materials' || b.farm)) { why += ', including fuel'; causes.push(fuel.id); }
    parts.push(why);
  }
  if (!parts.length) parts.push(b.revHist.length < 4 ? 'it never built up enough customers' : 'revenue has not covered costs for months');
  const text = parts.join(' and ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1) + '.', causes };
}

export function businessMonthly(sim: Sim): void {
  const s = sim.s, t = s.gov.taxes;
  const nominal = sim.scale * s.ext.trend;
  for (const b of [...s.businesses]) {
    if (b.pub || b.status === 'closed') { b.last = b.m; b.m = emptyLedger(); continue; }
    const running = b.status === 'operating' || b.status === 'hiring';
    for (const j of b.jobs) {
      if (j.worker < 0) continue;
      const c = sim.cit(j.worker);
      if (!c) { j.worker = -1; continue; }
      payWage(sim, b, c, j.wage);
      b.m.wages += j.wage;
    }
    const bl = sim.bld(b.building);
    if (bl && bl.ownerT === 2 && bl.ownerId === b.id && b.kind !== 'construction') {
      const maint = bl.value * BUILDINGS[bl.kind].maintenance;
      maintenanceWork(sim, b, maint);
      b.m.other += maint;
    }
    if (['factory', 'materials', 'foodplant'].includes(b.kind)) {
      const comp = b.m.revenue * [0.004, 0.015, 0.035][s.gov.policies.environmentalRegulation];
      sim.pay(b, s.ext, comp);
      b.m.other += comp;
    }
    if (b.loan > 0) {
      const interest = (b.loan * 0.11) / 12;
      sim.pay(b, s.ext, interest);
      b.m.other += interest;
      const repay = Math.min(b.loan, Math.max(0, b.cash - (b.m.cogs + b.m.wages) * 1.5) * 0.3);
      if (repay > 0) { sim.pay(b, s.ext, repay); b.loan -= repay; }
    }
    const profit = b.m.revenue - b.m.cogs - b.m.wages - b.m.other - b.m.taxes;
    let tax = 0;
    // investment incentives: new plants, offices and hotels pay no profit tax for their first three years
    const holiday = s.gov.policies.investmentIncentive >= 1 && HOLIDAY.has(b.kind) && sim.day - b.founded < 1095;
    if (profit > 0 && running && !holiday) {
      const small = b.jobs.length <= 10;
      const rate = b.farm ? t.agriculture : small ? t.smallBusiness : t.corporate;
      tax = sim.tax(b.farm ? 'agriTax' : small ? 'smallBizTax' : 'corporateTax', b, profit * rate * s.gov.compliance);
    }
    b.m.taxes += tax;
    b.taxesTotal += b.m.taxes;
    const after = profit - tax;
    const monthlyCost = b.m.cogs + b.m.wages + b.m.other;
    const reserve = monthlyCost * 1.5 + (b.farm ? b.farm.ha * 25_000 * nominal : 0);
    if (after > 0 && b.cash > reserve) {
      const div = Math.min(after * 0.75, b.cash - reserve);
      const owner = b.owner >= 0 ? sim.cit(b.owner) : undefined;
      const oh = owner ? sim.hh(owner.hh) : undefined;
      if (oh && !b.extOwned) { sim.pay(b, oh, div); oh.m.dividends += div; }
      else sim.pay(b, s.ext, div);
    }
    b.last = b.m;
    b.m = emptyLedger();
    // businesses still being set up are not judged on profit yet
    if (!running) { b.lossMonths = 0; continue; }
    b.profitHist.push(after); if (b.profitHist.length > 12) b.profitHist.shift();
    b.revHist.push(b.last.revenue); if (b.revHist.length > 12) b.revHist.shift();
    b.costHist.push(monthlyCost + b.last.taxes); if (b.costHist.length > 12) b.costHist.shift();
    // the first months after opening are a ramp-up period
    const young = sim.day - b.statusDay < 120 && b.status === 'operating' && b.founded > -1 && sim.day - b.founded < 900;
    b.lossMonths = after < 0 && !young ? b.lossMonths + 1 : Math.max(0, b.lossMonths - 1);
    if (b.lossMonths >= 2) b.reason = diagnose(sim, b).text;
    adjustJobs(sim, b, after);
    let close = false;
    if (b.farm) {
      const year = b.profitHist.reduce((a, x) => a + x, 0);
      close = b.profitHist.length >= 12 && year < 0 && b.cash < 0 && b.loan > b.farm.ha * 90_000 * nominal;
    } else {
      close = (b.lossMonths >= 6 && b.cash < monthlyCost) || b.cash < -3 * Math.max(monthlyCost, 50_000 * nominal);
    }
    if (close) {
      const d = diagnose(sim, b);
      sim.closeBusiness(b, d.text, d.causes);
    }
  }
}

/** Jobs that the premises of a business can hold. */
export function premisesCapacity(kind: Business['kind'], floors: number): number {
  const spec = BUSINESSES[kind];
  const base = spec.jobs.reduce((a, [, n]) => a + n, 0);
  const mult = SCALED.has(kind) ? Math.max(1, Math.round(floors / 4)) : 1;
  return Math.round(base * mult * 1.6);
}

export function jobTemplate(kind: Business['kind'], floors: number): [RoleId, number][] {
  const mult = SCALED.has(kind) ? Math.max(1, Math.round(floors / 4)) : 1;
  return BUSINESSES[kind].jobs.map(([r, n]) => [r, Math.max(1, Math.round(n * mult))] as [RoleId, number]);
}

export function roleLabel(r: RoleId): string { return ROLES[r].label; }

export type { SimEvent };
