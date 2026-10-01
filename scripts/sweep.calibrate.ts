// Runs every preset/condition for a few simulated years and prints a compact health report.
// Run with: npx vitest run --config vitest.calibrate.config.ts scripts/sweep.calibrate.ts --silent=false
import { test } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { CONDITIONS, PRESETS } from '../src/sim/presets';

const years = Number(process.env.CAL_YEARS ?? 3);
const only = process.env.CAL_ONLY;
const f = (v: number) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(0));

const combos: [string, string][] = [];
for (const c of CONDITIONS) combos.push(['in-deccan', c.id]);
for (const p of PRESETS) if (p.id !== 'in-deccan') combos.push([p.id, 'growing']);

test('sweep', () => {
  for (const [preset, cond] of combos) {
    if (only && !`${preset}/${cond}`.includes(only)) continue;
    const t0 = performance.now();
    // generate without the history year so the settling-in transient is visible (months 0-12)
    const S = Simulation.generate({ name: 'Sweep', preset, startYear: 2026, condition: cond, seed: 7, pace: 2, offlineCapDays: 365, now: 0 });
    const s = S.state;
    const t1 = performance.now();
    const closedBy: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    const orig = S.sim.closeBusiness.bind(S.sim);
    S.sim.closeBusiness = (b, reason, causes) => {
      closedBy[b.kind] = (closedBy[b.kind] ?? 0) + 1;
      const key = `${b.kind}: ${reason.slice(0, 60)}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
      return orig(b, reason, causes);
    };
    const openedBy: Record<string, number> = {};
    S.sim.listeners.add((e) => {
      if (e.type === 'business.opened' && e.ref) { const bl = S.sim.bld(e.ref.id); const b = bl ? S.sim.biz(bl.biz) : undefined; if (b) openedBy[b.kind] = (openedBy[b.kind] ?? 0) + 1; }
    });
    const lines: string[] = [];
    // filled jobs (+ working owners) and average monthly profit by business kind
    const jobsBy = () => {
      const o: Record<string, string> = {};
      const agg: Record<string, { n: number; filled: number; prof: number; unmet: number }> = {};
      for (const b of s.businesses) {
        const a = (agg[b.kind] ??= { n: 0, filled: 0, prof: 0, unmet: 0 });
        a.n++;
        a.filled += b.jobs.filter((j) => j.worker >= 0).length;
        a.prof += b.profitHist.length ? b.profitHist[b.profitHist.length - 1] : 0;
        a.unmet += b.last.unmet;
      }
      for (const [k, a] of Object.entries(agg)) o[k] = `${a.n}/${a.filled}j/${f(a.prof / a.n)}${a.unmet > 0 ? `/u${f(a.unmet / a.n)}` : ''}`;
      return JSON.stringify(o);
    };
    const snap: string[] = [`  jobs m0 ${jobsBy()}`];
    let seen = s.stats.months.length;
    let inOffice = false;
    for (let d = 0; d < years * 365; d++) {
      S.advanceDays(1);
      if (!inOffice && S.inOffice) { S.takeOffice(); inOffice = true; }
      if (s.stats.months.length !== seen) {
        seen = s.stats.months.length;
        const n = seen - 1;
        if (n === 6 || n === 12 * years) snap.push(`  jobs m${n} ${jobsBy()}`);
        if (n === 1 || n % 6 === 0) {
          const m = s.stats.months[n];
          lines.push(`  m${String(n).padStart(2)} pop ${m.population} un ${(m.unemployment * 100).toFixed(1)}% wage ${f(m.avgWage)} gdp ${f(m.gdp)} rev ${f(m.revenue)} exp ${f(m.spending)} cash ${f(m.treasury)} debt ${f(m.debt)} biz ${m.businesses} vac ${((m.vacantUnits / Math.max(1, m.units)) * 100).toFixed(0)}% home ${m.homeless} rent ${m.rentIndex.toFixed(2)} cpi ${m.cpi.toFixed(0)} sat ${m.satisfaction.toFixed(2)} food ${m.foodPrice.toFixed(0)} insec ${(m.foodInsecure * 100).toFixed(0)}% cong ${m.congestion.toFixed(2)} com ${m.commute.toFixed(0)}`);
        }
      }
    }
    const t2 = performance.now();
    const closed = s.events.filter((e) => e.type === 'business.closed').length;
    const opened = s.events.filter((e) => e.type === 'business.opened').length;
    console.log(`${preset}/${cond}: gen ${(t1 - t0).toFixed(0)}ms, ${(((t2 - t1) / (years * 365))).toFixed(1)}ms/day, opened ${opened}, closed ${closed}, projects ${s.projects.length}`);
    console.log(lines.join('\n'));
    console.log(snap.join('\n'));
    // yearly demographic flows
    const ms = s.stats.months;
    for (let y = 0; y * 12 + 1 < ms.length; y++) {
      const sl = ms.slice(1 + y * 12, 13 + y * 12);
      const sum = (k: 'births' | 'deaths' | 'immigrants' | 'emigrants') => sl.reduce((a, m) => a + m[k], 0);
      console.log(`  year ${y + 1}: births ${sum('births')} deaths ${sum('deaths')} in ${sum('immigrants')} out ${sum('emigrants')}`);
    }
    const out: Record<string, number> = {};
    for (const e of s.events) if (e.type === 'migration.out') for (const w of e.why ?? []) { const m = /^(\d+) left citing (.+)$/.exec(w); if (m) out[m[2]] = (out[m[2]] ?? 0) + Number(m[1]); }
    console.log('  emigration causes', JSON.stringify(out));
    console.log('  opened', JSON.stringify(openedBy), 'closed', JSON.stringify(closedBy));
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`    ${v}x ${k}`);
    const st = s.citizens.reduce<Record<string, number>>((a, c) => { a[c.status] = (a[c.status] ?? 0) + 1; return a; }, {});
    console.log('  status', JSON.stringify(st), 'budget funding', JSON.stringify(Object.fromEntries(Object.entries(s.gov.deptFunding).map(([k, v]) => [k, v.toFixed(2)]))));
  }
});
