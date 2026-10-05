// Government finances: department budgets and public payroll, entitlements, debt, borrowing, credit rating,
// scheduled policy/tax changes.

import { emptyGovLedger, sumExp, sumRev, type Sim } from '../core';
import { maintenanceWork, payWage } from '../econ';
import { BUSINESSES, ROAD_MAINT, ROAD_WEAR_COST } from '../tables';
import { DEPTS, Terrain, type Dept, type Policies, type TaxSettings } from '../types';
import { roadMaintenance } from './transport';

export const TAX_LABELS: Record<keyof TaxSettings, string> = {
  income: 'Income tax (basic rate)', incomeTop: 'Income tax (top rate)', allowance: 'Tax-free allowance', topThreshold: 'Top-rate threshold',
  corporate: 'Corporate tax', smallBusiness: 'Small business tax', sales: 'Sales tax', foodSales: 'Sales tax on food',
  property: 'Property tax', fuel: 'Fuel tax', import: 'Import tariff (manufactures)', importFood: 'Import tariff (food & farm goods)',
  export: 'Export tax', agriculture: 'Agricultural income tax', luxury: 'Luxury tax', licenseFee: 'Business licence fee',
  tourism: 'Hotel room tax', entertainment: 'Entertainment tax', passengerFee: 'Airport passenger fee',
  power: 'Electricity tariff', water: 'Water tariff',
};

export const POLICY_LABELS: Record<keyof Policies, string> = {
  minWage: 'Minimum wage', unemploymentBenefit: 'Unemployment benefit', pension: 'State pension', retirementAge: 'Retirement age',
  fertilizerSubsidy: 'Fertilizer subsidy', cropInsurance: 'Crop insurance', businessRegulation: 'Business regulation',
  environmentalRegulation: 'Environmental regulation', rentControl: 'Rent control', busService: 'Public bus service', grainExportBan: 'Grain export ban',
  msp: 'Minimum support price (wheat, rice)', rationShops: 'Ration shops (subsidised grain)', povertyTransfer: 'Cash support for poor families',
  exportIncentive: 'Export incentive (duty remission)', investmentIncentive: 'Investment incentives', tourismPromotion: 'Tourism promotion', festival: 'Annual festival',
};

/** Days before a policy change takes effect (notice periods, procurement, legislation). */
export const POLICY_DELAY: Record<keyof Policies, number> = {
  minWage: 30, unemploymentBenefit: 0, pension: 0, retirementAge: 90, fertilizerSubsidy: 0, cropInsurance: 30, businessRegulation: 30,
  environmentalRegulation: 60, rentControl: 30, busService: 60, grainExportBan: 7,
  msp: 30, rationShops: 60, povertyTransfer: 30, exportIncentive: 30, investmentIncentive: 60, tourismPromotion: 30, festival: 0,
};

/** Monthly per-resident transfer from state/national government (base value). */
export const GRANT_PER_CAPITA = 550;

export const DEPT_LABELS: Record<Dept, string> = {
  admin: 'Administration', health: 'Health', education: 'Education', safety: 'Police, fire & safety', transport: 'Transport & roads',
  agriculture: 'Agriculture', environment: 'Environment', culture: 'Culture, sport & heritage', utilities: 'Water & power',
};

export function governmentDaily(sim: Sim): void {
  const g = sim.s.gov;
  if (!g.pending.length) return;
  const due = g.pending.filter((p) => p.day <= sim.day);
  if (!due.length) return;
  g.pending = g.pending.filter((p) => p.day > sim.day);
  for (const p of due) {
    if (p.kind === 'tax') (g.taxes as unknown as Record<string, number>)[p.key] = p.value as number;
    else (g.policies as unknown as Record<string, number | boolean>)[p.key] = p.value;
    sim.emit(p.kind === 'tax' ? 'tax.changed' : 'policy.changed', `${p.label} now in effect.`, 2, undefined, undefined, [p.label]);
  }
}

/** Extra monthly operating needs beyond staff for each department. */
export function deptExtras(sim: Sim): Record<Dept, number> {
  const s = sim.s, m = s.map;
  const nominal = sim.scale * s.ext.trend;
  const ex = {} as Record<Dept, number>;
  for (const d of DEPTS) ex[d] = 0;
  let roads = 0, canals = 0;
  for (let i = 0; i < m.road.length; i++) {
    const c = m.road[i];
    if (c) roads += ROAD_MAINT[c] + ROAD_WEAR_COST * s.traffic.volume[i];
    if (m.terrain[i] === Terrain.Canal) canals++;
  }
  ex.transport = roads * 1.3 * nominal + (s.gov.policies.busService ? 110 * nominal * s.citizens.length * s.gov.policies.busService : 0);
  const farms = s.businesses.filter((b) => b.kind === 'farm').length;
  ex.agriculture = (600 * farms + 800 * canals) * nominal;
  const parks = s.buildings.filter((b) => b.kind === 'park').length;
  const industry = s.businesses.filter((b) => ['factory', 'materials', 'foodplant'].includes(b.kind)).length;
  ex.environment = (25_000 + 10_000 * parks + 15_000 * industry) * nominal;
  // conservation of heritage sites, exhibitions, stadium upkeep; airport operations (fire cover, navigation aids)
  const heritage = s.buildings.filter((b) => b.kind === 'heritage').length;
  const venues = s.businesses.filter((b) => (b.kind === 'museum' || b.kind === 'stadium') && b.status !== 'planned').length;
  ex.culture = (15_000 + 60_000 * heritage + 90_000 * venues) * nominal;
  if (s.businesses.some((b) => b.kind === 'airport' && b.status !== 'planned')) ex.transport += 450_000 * nominal;
  // fire engines, breathing sets and hoses; water treatment chemicals, pumps and mains repairs; plant spares
  let fire = 0, util = 0;
  for (const b of s.businesses) {
    if (b.status === 'planned' || b.status === 'closed') continue;
    if (b.kind === 'firestation') fire += 60_000;
    else if (b.kind === 'waterworks') util += 90_000;
    else if (b.kind === 'gasplant') util += 120_000;
    else if (b.kind === 'solarfarm' || b.kind === 'windfarm') util += 30_000;
  }
  for (const b of s.buildings) if (b.kind === 'substation') util += 50_000;
  ex.safety += fire * nominal;
  ex.utilities = util * nominal;
  return ex;
}

export function deptNeeds(sim: Sim): { need: Record<Dept, number>; salaries: Record<Dept, number>; positions: Record<Dept, number> } {
  const need = deptExtras(sim);
  const salaries = {} as Record<Dept, number>;
  const positions = {} as Record<Dept, number>;
  for (const d of DEPTS) { salaries[d] = 0; positions[d] = 0; }
  for (const b of sim.s.businesses) {
    const d = BUSINESSES[b.kind].dept;
    if (!d || b.status === 'planned' || b.status === 'closed') continue;
    for (const j of b.jobs) {
      need[d] += j.wage * 1.2;
      positions[d] += j.wage;
      if (j.worker >= 0) salaries[d] += j.wage;
    }
  }
  return { need, salaries, positions };
}

/** Monthly allocation a department receives at its current funding level. */
export function allocation(sim: Sim, d: Dept): number {
  return sim.s.gov.level[d] * sim.s.gov.deptNeed[d];
}

export function governmentMonthly(sim: Sim): void {
  const s = sim.s, g = s.gov;
  const { need, salaries, positions } = deptNeeds(sim);
  // when the treasury is in arrears, suppliers are paid late and operations shrink
  const squeeze = g.arrears > 0 ? 0.75 : 1;
  for (const d of DEPTS) {
    g.deptNeed[d] = need[d];
    const level = g.level[d];
    const alloc = level * need[d] * squeeze;
    g.deptFunding[d] = need[d] > 0 ? Math.max(0, alloc / need[d]) : 1;
    // salaries are contractual and always paid; operations (supplies, road works, programmes) get what is left.
    // Funding above 100% buys extra operations (faster road repair, more outreach) up to the level set.
    const opsNeed = Math.max(0, need[d] - positions[d]);
    const ops = Math.max(0, Math.min(alloc - salaries[d], opsNeed * Math.max(1, level)));
    const opsShare = opsNeed > 0 ? ops / opsNeed : 1;
    // road, park and heritage upkeep is done by local contractors; supplies and programmes are bought in
    if (ops > 0) {
      if (d === 'transport' || d === 'environment' || d === 'culture' || d === 'utilities') maintenanceWork(sim, g, ops, d);
      else sim.spend(d, s.ext, ops);
    }
    g.deptSpend[d] = salaries[d] + ops;
    if (d === 'transport') roadMaintenance(sim, opsShare);
  }
  for (const b of s.businesses) {
    const d = BUSINESSES[b.kind].dept;
    if (!d || (b.status !== 'operating' && b.status !== 'hiring')) continue;
    for (const j of b.jobs) {
      if (j.worker < 0) continue;
      const c = sim.cit(j.worker);
      if (c) payWage(sim, null, c, j.wage, d);
    }
    b.m.wages = b.jobs.reduce((a, j) => a + (j.worker >= 0 ? j.wage : 0), 0);
  }
  rightsizePublicStaff(sim);
  // per-capita transfers from higher levels of government
  const grant = s.citizens.length * GRANT_PER_CAPITA * sim.scale * s.ext.trend * (s.meta.condition === 'developing' || s.meta.condition === 'agricultural' ? 1.25 : 1);
  sim.tax('grants', s.ext, grant);
  // entitlements
  const p = g.policies;
  for (const c of s.citizens) {
    let amt = 0, cat: 'unemployment' | 'pensions' | null = null;
    if (c.status === 'unemployed' && c.unempDays > 14 && p.unemploymentBenefit > 0) { amt = p.unemploymentBenefit; cat = 'unemployment'; }
    else if (c.status === 'retired' && p.pension > 0) { amt = p.pension; cat = 'pensions'; }
    if (!cat) continue;
    const h = sim.hh(c.hh);
    if (!h) continue;
    sim.spend(cat, h, amt);
    h.m.benefits += amt;
  }
  // debt service
  const interest = (g.debt * g.rate) / 12;
  if (interest > 0) sim.spend('interest', s.ext, interest);
  const annualRev = Math.max(1, sumRev(g.ytd) > 0 && sim.date.month > 2 ? (sumRev(g.ytd) / sim.date.month) * 12 : sumRev(g.last) * 12 || sumRev(g.m) * 12);
  const limit = annualRev * 4.5;
  const monthlySpend = Math.max(sumExp(g.last), sumExp(g.m) * 0.5);
  if (g.cash < 0) {
    const want = -g.cash + monthlySpend * 0.5;
    const room = Math.max(0, limit - g.debt);
    const borrow = Math.min(want, room);
    if (borrow > 0) {
      sim.pay(s.ext, g, borrow);
      g.debt += borrow;
    }
    if (g.cash < 0) {
      g.arrears++;
      sim.emit('gov.arrears', `The treasury cannot borrow more: bills worth ${Math.round(-g.cash).toLocaleString()} are unpaid.`, 3, undefined, undefined,
        [`Debt has reached ${(g.debt / annualRev).toFixed(1)}x annual revenue; lenders refuse new loans`, 'Unpaid suppliers delay public services']);
    }
  } else {
    g.arrears = 0;
    if (g.debt > 0 && g.cash > monthlySpend * 4) {
      const repay = Math.min(g.debt, (g.cash - monthlySpend * 4) * 0.25);
      sim.pay(g, s.ext, repay);
      g.debt -= repay;
    }
  }
  const ratio = g.debt / annualRev;
  const [rating, rate] = ratio < 1 ? ['AA', 0.065] : ratio < 2 ? ['A', 0.075] : ratio < 3 ? ['BBB', 0.09] : ratio < 4 ? ['BB', 0.11] : ['B', 0.14];
  if (rating !== g.rating) {
    const worse = rate > g.rate;
    sim.emit('gov.rating', `Credit rating ${worse ? 'downgraded' : 'upgraded'} to ${rating}; new borrowing costs ${(rate * 100).toFixed(1)}%.`, worse ? 2 : 1, undefined, undefined,
      [`Debt is ${ratio.toFixed(1)}x annual revenue`]);
    g.rating = rating;
  }
  // new borrowing is priced at the current rate; the average rate on the stock drifts towards it
  g.rate += (rate - g.rate) * 0.15;
  g.compliance = Math.min(0.97, 0.8 + 0.15 * Math.min(1, g.deptFunding.admin));
}

/** Cuts or restores public positions so staff costs fit the department allocation. */
function rightsizePublicStaff(sim: Sim): void {
  const s = sim.s, g = s.gov;
  for (const d of DEPTS) {
    const f = g.deptFunding[d];
    const facilities = s.businesses.filter((b) => BUSINESSES[b.kind].dept === d && (b.status === 'operating' || b.status === 'hiring'));
    if (!facilities.length) continue;
    if (f < 0.9) {
      let cut = 0;
      for (const b of facilities) {
        const target = Math.max(1, Math.floor(BUSINESSES[b.kind].jobs.reduce((a, [, n]) => a + n, 0) * Math.max(0.3, f / 0.95)));
        while (b.jobs.length > target) {
          let k = b.jobs.findIndex((j) => j.worker < 0);
          if (k < 0) k = b.jobs.length - 1;
          if (b.jobs[k].worker >= 0) cut++;
          sim.removeJob(b, k);
        }
      }
      if (cut > 0) sim.emit('gov.cuts', `Budget shortfall in ${DEPT_LABELS[d].toLowerCase()}: ${cut} public employees laid off.`, 2, undefined, undefined,
        [`The ${DEPT_LABELS[d].toLowerCase()} allocation covers only ${Math.round(f * 100)}% of full-service costs`]);
    } else if (f >= 0.98) {
      for (const b of facilities) {
        const template = BUSINESSES[b.kind].jobs;
        for (const [role, n] of template) {
          const have = b.jobs.filter((j) => j.role === role).length;
          if (have < n) sim.addJobs(b, role, n - have);
        }
      }
    }
  }
}

export function rollGovLedger(sim: Sim): void {
  const g = sim.s.gov;
  g.last = g.m;
  g.m = emptyGovLedger();
  if (sim.date.month === 0) { g.lastYear = g.ytd; g.ytd = emptyGovLedger(); }
}
