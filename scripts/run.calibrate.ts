// Headless multi-year run used to tune the economy. Run with: npm run calibrate
// Env: CAL_PRESET, CAL_COND, CAL_YEARS, CAL_SEED
import { test } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { sumExp, sumRev } from '../src/sim/core';

const preset = process.env.CAL_PRESET ?? 'in-deccan';
const cond = process.env.CAL_COND ?? 'developing';
const years = Number(process.env.CAL_YEARS ?? 3);
const seed = Number(process.env.CAL_SEED ?? 42);

const f = (v: number, d = 0) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(d));

test(`calibrate ${preset}/${cond}`, () => {
  const t0 = performance.now();
  // generate without the history year so the whole trajectory, including the settling-in year, is printed
  const S = Simulation.generate({ name: 'Testville', preset, startYear: 2026, condition: cond, seed, pace: 2, offlineCapDays: 365, now: Date.now() });
  const sim = S.sim, s = sim.s;
  const t1 = performance.now();
  const kinds: Record<string, number> = {};
  for (const b of s.businesses) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
  const jobs = s.businesses.reduce((a, b) => a + b.jobs.length, 0);
  const filled = s.businesses.reduce((a, b) => a + b.jobs.filter((j) => j.worker >= 0).length, 0);
  console.log(`gen ${(t1 - t0).toFixed(0)}ms pop=${s.citizens.length} hh=${s.households.length} bld=${s.buildings.length} jobs=${filled}/${jobs}`);
  console.log('businesses', JSON.stringify(kinds));
  console.log('dept need', JSON.stringify(Object.fromEntries(Object.entries(s.gov.deptNeed).map(([k, v]) => [k, f(v)]))), 'cash', f(s.gov.cash), 'debt', f(s.gov.debt));
  const money0 = totalMoney(S);
  let lastMonths = s.stats.months.length;
  console.log('mon  pop   unemp  wage   gdp    rev    spend  bal    cash   debt   biz op cl vac% home rentI food  cpi   sat  farmT  imp    exp    comm cong');
  const t2 = performance.now();
  let inOffice = false;
  for (let d = 0; d < years * 365; d++) {
    S.advanceDays(1);
    if (!inOffice && S.inOffice) { S.takeOffice(); inOffice = true; console.log('---- player takes office ----'); }
    if (s.stats.months.length !== lastMonths) {
      lastMonths = s.stats.months.length;
      const m = s.stats.months[lastMonths - 1];
      console.log([
        `${m.year}-${String(m.month + 1).padStart(2, '0')}`, m.population, (m.unemployment * 100).toFixed(1), f(m.avgWage), f(m.gdp), f(m.revenue), f(m.spending), f(m.balance), f(m.treasury), f(m.debt),
        m.businesses, m.opened, m.closed, ((m.vacantUnits / Math.max(1, m.units)) * 100).toFixed(1), m.homeless, m.rentIndex.toFixed(2), m.foodPrice.toFixed(1), m.cpi.toFixed(1),
        m.satisfaction.toFixed(2), f(m.farmOutput), f(m.imports), f(m.exports), m.commute.toFixed(0), m.congestion.toFixed(2),
      ].join(' '));
    }
  }
  const t3 = performance.now();
  console.log(`simulated ${years}y in ${((t3 - t2) / 1000).toFixed(1)}s (${((t3 - t2) / (years * 365)).toFixed(1)} ms/day)`);
  const g = s.gov;
  console.log('rev last', JSON.stringify(Object.fromEntries(Object.entries(g.last.rev).filter(([, v]) => v).map(([k, v]) => [k, f(v)]))));
  console.log('exp last', JSON.stringify(Object.fromEntries(Object.entries(g.last.exp).filter(([, v]) => v).map(([k, v]) => [k, f(v)]))), 'tot', f(sumRev(g.last)), f(sumExp(g.last)));
  const kinds2: Record<string, number> = {};
  for (const b of s.businesses) kinds2[`${b.kind}:${b.status}`] = (kinds2[`${b.kind}:${b.status}`] ?? 0) + 1;
  console.log('businesses', JSON.stringify(kinds2));
  const prof: Record<string, number[]> = {};
  for (const b of s.businesses) if (!b.pub) (prof[b.kind] ??= []).push(b.profitHist.reduce((a, x) => a + x, 0) / Math.max(1, b.profitHist.length));
  console.log('avg monthly profit', JSON.stringify(Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, f(v.reduce((a, x) => a + x, 0) / v.length)]))));
  console.log('markets', JSON.stringify(Object.fromEntries(Object.entries(s.market).map(([k, m]) => [k, `${f(m.price)} L${f(m.lastLocal)} I${f(m.lastImported)} E${f(m.lastExported)}`]))));
  console.log('wage idx', s.labor.wage.map((w) => w.toFixed(2)).join(' '), 'vac', s.labor.vacancies.join(' '), 'unemp', s.labor.unemployed.join(' '));
  console.log('projects', s.projects.map((p) => `${p.kind}:${p.phase}:${Math.round((p.laborDone / Math.max(1, p.labor)) * 100)}%:${p.issue}`).join(' | '));
  console.log('events', s.events.filter((e) => e.sev >= 2).slice(-25).map((e) => `${e.day}:${e.text}`).join('\n  '));
  const money1 = totalMoney(S);
  console.log('money drift', f(money1 - money0));
});

function totalMoney(S: Simulation): number {
  const s = S.state;
  let t = s.gov.cash + s.ext.cash;
  for (const h of s.households) t += h.cash;
  for (const b of s.businesses) t += b.cash;
  return t;
}
