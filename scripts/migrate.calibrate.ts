// TEMPORARY: loads a world saved by the previous version and checks the v3 migration. Delete after use.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Simulation } from '../src/sim/simulation';
import { integrity, nonFinite, totalMoney } from '../tests/helpers';
import type { WorldState } from '../src/sim/types';

test('migrate v2 world', () => {
  const raw = JSON.parse(readFileSync(join(process.env.TEMP ?? '.', 'v2world.json'), 'utf8')) as WorldState;
  expect(raw.v).toBe(2);
  const S = Simulation.fromState(raw);
  const s = S.state;
  const m0 = totalMoney(s);
  console.log('after migrate v', s.v, 'retrofit', s.util.retrofit, 'grid', s.util.gridBase);
  S.advanceDays(1);
  const fac = s.buildings.filter((b) => b.kind === 'waterworks' || b.kind === 'firestation');
  console.log('day1 grid', s.util.gridBase.toFixed(2), 'peak', s.util.peak.toFixed(2), 'facilities', fac.map((b) => `${b.kind}@${b.x},${b.y} staff ${S.sim.biz(b.biz)?.jobs.filter((j) => j.worker >= 0).length}/${S.sim.biz(b.biz)?.jobs.length}`).join(', '));
  console.log('served', s.util.served.toFixed(3), 'water', s.util.waterServed.toFixed(3), Math.round(s.util.waterUse), '/', Math.round(s.util.waterCap));
  S.advanceDays(120);
  const m = s.stats.months[s.stats.months.length - 1];
  console.log('after 120 days pop', s.citizens.length, 'sat', m.satisfaction.toFixed(3), 'pServ', m.powerServed.toFixed(3), 'wServ', m.waterServed.toFixed(3), 'fires', m.fires, 'fcov', m.fireCoverage.toFixed(2), 'unemp', (m.unemployment * 100).toFixed(1));
  console.log('integrity', integrity(S.sim), 'nonFinite', nonFinite(s), 'drift', totalMoney(s) - m0);
  expect(integrity(S.sim)).toEqual([]);
  expect(nonFinite(s)).toEqual([]);
  expect(Math.abs(totalMoney(s) - m0)).toBeLessThan(1);
});
