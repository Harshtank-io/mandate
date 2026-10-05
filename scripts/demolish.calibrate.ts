// TEMPORARY: bulldozer checks. Delete after use.
import { test, expect } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { previewDemolish, proposeDemolish } from '../src/sim/commands';
import { integrity, nonFinite, totalMoney } from '../tests/helpers';

test('demolition', () => {
  const S = Simulation.generate({ name: 'Testville', preset: 'in-deccan', startYear: 2026, condition: 'established', seed: 3, pace: 2, offlineCapDays: 365, now: 1 });
  const sim = S.sim, s = sim.s, m = s.map;
  S.advanceDays(3);
  const m0 = totalMoney(s);
  const house = s.buildings.find((b) => b.kind === 'house' && b.occupants.length > 0)!;
  const school = s.buildings.find((b) => b.kind === 'school')!;
  const heritage = s.buildings.find((b) => b.kind === 'heritage');
  const at = (b: { x: number; y: number }) => b.y * 128 + b.x;
  // a highway tile and a lone street tile in front of some building (removing it would strand it unless it has another road)
  const hwy = m.road.findIndex((c) => c === 3);
  const r1 = previewDemolish(sim, [hwy]);
  console.log('highway:', r1.ok, r1.errors);
  expect(r1.ok).toBe(false);
  if (heritage) { const r = previewDemolish(sim, [at(heritage)]); console.log('heritage:', r.ok, r.errors); expect(r.ok).toBe(false); }
  // a street tile that is the only access of some 1x1 building
  let strand = -1;
  for (const b of s.buildings) {
    if (b.w !== 1 || b.h !== 1) continue;
    const roads = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => (b.y + dy) * 128 + b.x + dx).filter((t) => m.road[t] === 1);
    if (roads.length === 1) { strand = roads[0]; break; }
  }
  const r2 = previewDemolish(sim, [strand]);
  console.log('stranding street:', r2.ok, r2.errors);
  expect(r2.ok).toBe(false);
  const ph = previewDemolish(sim, [at(house)]);
  console.log('house:', ph.ok, ph.label, ph.requirements, ph.risks);
  expect(ph.ok).toBe(true);
  const ps = previewDemolish(sim, [at(school)]);
  console.log('school:', ps.ok, ps.label, ps.requirements, ps.risks);
  const a = proposeDemolish(sim, [at(house)]);
  const b = proposeDemolish(sim, [at(school)]);
  console.log(a, b);
  expect(a.ok && b.ok).toBe(true);
  // a safe stretch of street: a tile whose removal strands nobody
  let safe = -1;
  for (let t = 0; t < 128 * 128 && safe < 0; t++) if (m.road[t] === 1 && m.project[t] < 0 && previewDemolish(sim, [t]).ok) safe = t;
  const c = proposeDemolish(sim, [safe]);
  console.log('street', safe, c);
  const houseId = house.id, schoolId = school.id, schoolBiz = school.biz;
  for (let d = 0; d < 200; d++) {
    S.advanceDays(1);
    if (!s.projects.some((p) => p.kind === 'demolish' && p.phase !== 'done' && p.phase !== 'cancelled')) { console.log('all done on day', d); break; }
  }
  for (const p of s.projects.filter((p) => p.kind === 'demolish')) console.log(p.name, p.phase, `spent ${Math.round(p.spent)}`, p.issue, JSON.stringify(p.issues));
  console.log('house gone', !sim.bld(houseId), 'school gone', !sim.bld(schoolId), 'school biz gone', !sim.biz(schoolBiz), 'street removed', m.road[safe] === 0);
  expect(sim.bld(houseId)).toBeUndefined();
  expect(sim.bld(schoolId)).toBeUndefined();
  expect(m.road[safe]).toBe(0);
  const errs = integrity(sim);
  console.log('integrity', errs, 'nonFinite', nonFinite(s), 'drift', totalMoney(s) - m0);
  for (const bl of s.buildings) if (bl.access >= 0 && !m.road[bl.access]) console.log('building with dead access', bl.kind, bl.id);
  expect(errs).toEqual([]);
  expect(Math.abs(totalMoney(s) - m0)).toBeLessThan(1);
  console.log(s.events.filter((e) => e.type.startsWith('project')).slice(-8).map((e) => e.text).join('\n'));
});
