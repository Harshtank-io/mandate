// TEMPORARY: utilities and fire diagnostics. Delete after tuning.
import { test } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { sumExp, sumRev } from '../src/sim/core';

const preset = process.env.CAL_PRESET ?? 'in-deccan';
const cond = process.env.CAL_COND ?? 'growing';
const years = Number(process.env.CAL_YEARS ?? 2);
const seed = Number(process.env.CAL_SEED ?? 42);
const f = (v: number, d = 0) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(d));

test(`utilities ${preset}/${cond}`, () => {
  const S = Simulation.generate({ name: 'Testville', preset, startYear: 2026, condition: cond, seed, pace: 2, offlineCapDays: 365, now: 1 });
  const sim = S.sim, s = sim.s;
  const money = () => { let t = s.gov.cash + s.ext.cash; for (const h of s.households) t += h.cash; for (const b of s.businesses) t += b.cash; return t; };
  const m0 = money();
  const u = s.util;
  console.log(`pop ${s.citizens.length} grid ${u.gridBase.toFixed(2)}MW peak ${u.peak.toFixed(2)} cap ${u.cap.toFixed(2)} served ${u.served.toFixed(3)} water ${f(u.waterUse)}/${f(u.waterCap)} ${u.waterServed.toFixed(3)}`);
  console.log('kinds', s.buildings.filter((b) => ['waterworks', 'firestation'].includes(b.kind)).map((b) => `${b.kind}@${b.x},${b.y} pw${b.pw} wt${b.wt}`).join(' '));
  let last = s.stats.months.length, inOffice = false;
  console.log('mon     pop  unemp  sat   appr  peak  cap   pServ wServ blk fires burn fcov  bills  energy util$  rev    spend  bal');
  for (let d = 0; d < years * 365; d++) {
    S.advanceDays(1);
    if (!inOffice && S.inOffice) { S.takeOffice(); inOffice = true; }
    if (s.stats.months.length !== last) {
      last = s.stats.months.length;
      const m = s.stats.months[last - 1];
      const g = s.gov.last;
      console.log([`${m.year}-${String(m.month + 1).padStart(2, '0')}`, m.population, (m.unemployment * 100).toFixed(1), m.satisfaction.toFixed(3), m.approval.toFixed(3),
        m.powerPeak.toFixed(2), m.powerCap.toFixed(2), m.powerServed.toFixed(3), m.waterServed.toFixed(3), m.blackouts, m.fires, m.burned, m.fireCoverage.toFixed(2),
        f(g.rev.utilityBills), f(g.exp.energy), f(g.exp.utilities), f(m.revenue), f(m.spending), f(m.balance)].join(' '));
    }
  }
  const g = s.gov;
  console.log('rev', JSON.stringify(Object.fromEntries(Object.entries(g.last.rev).filter(([, v]) => v).map(([k, v]) => [k, f(v)]))));
  console.log('exp', JSON.stringify(Object.fromEntries(Object.entries(g.last.exp).filter(([, v]) => v).map(([k, v]) => [k, f(v)]))), 'tot', f(sumRev(g.last)), f(sumExp(g.last)));
  console.log('util last', JSON.stringify(Object.fromEntries(Object.entries(u.last).map(([k, v]) => [k, f(v)]))), 'unit', u.unit.toFixed(2));
  const hh = s.households.filter((h) => h.last.wages > 0);
  const share = hh.reduce((a, h) => a + h.last.utilities / Math.max(1, h.last.wages + h.last.benefits + h.last.dividends), 0) / Math.max(1, hh.length);
  console.log('avg household utility share of income', (share * 100).toFixed(2) + '%', 'avg bill', f(hh.reduce((a, h) => a + h.last.utilities, 0) / Math.max(1, hh.length)));
  console.log('fire events', s.events.filter((e) => e.type.startsWith('fire') || e.type.startsWith('utility')).slice(-12).map((e) => `${e.day}:${e.text}`).join('\n  '));
  console.log('money drift', f(money() - m0));
});
