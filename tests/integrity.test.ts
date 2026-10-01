// Every region and starting condition must generate a coherent world and keep it coherent while it runs.

import { describe, expect, it } from 'vitest';
import { CONDITIONS, PRESETS } from '../src/sim/presets';
import { integrity, nonFinite, world } from './helpers';

describe('world generation', () => {
  const combos: [string, string][] = [
    ...CONDITIONS.map((c) => ['in-deccan', c.id] as [string, string]),
    ...PRESETS.filter((p) => p.id !== 'in-deccan').map((p) => [p.id, 'growing'] as [string, string]),
  ];
  for (const [preset, condition] of combos) {
    it(`${preset} / ${condition} starts coherent`, () => {
      const sim = world({ preset, condition, seed: 31 });
      const s = sim.state;
      expect(s.citizens.length).toBeGreaterThan(800);
      expect(s.businesses.filter((b) => b.farm).length).toBeGreaterThan(20);
      expect(s.businesses.some((b) => b.kind === 'grocery')).toBe(true);
      expect(s.businesses.some((b) => b.kind === 'townhall')).toBe(true);
      expect(s.map.road.filter((r) => r > 0).length).toBeGreaterThan(200);
      expect(s.stats.months.length).toBe(1);
      expect(integrity(sim.sim)).toEqual([]);
    });
  }
});

describe('a running world stays consistent', () => {
  for (const [preset, condition] of [['in-punjab', 'industrial'], ['vn-mekong', 'growing'], ['fictional', 'established']] as [string, string][]) {
    it(`${preset} / ${condition} after half a year`, () => {
      const sim = world({ preset, condition, seed: 51 });
      sim.advanceDays(180);
      expect(integrity(sim.sim)).toEqual([]);
      expect(nonFinite(sim.state)).toEqual([]);
      expect(sim.state.stats.months.length).toBeGreaterThanOrEqual(6);
      expect(sim.state.news.length).toBeGreaterThan(0);
    });
  }

  it('a full history year and taking office work end to end', async () => {
    const { Simulation } = await import('../src/sim/simulation');
    const sim = Simulation.create({ name: 'Office', preset: 'in-deccan', startYear: 2026, condition: 'growing', seed: 61, pace: 2, offlineCapDays: 365, now: 0 });
    const s = sim.state;
    expect(sim.inOffice).toBe(true);
    expect(s.stats.months.length).toBeGreaterThanOrEqual(13);
    expect(s.meta.officeYear).toBe(2026);
    expect(new Date(Date.UTC(s.meta.startYear, 0, 1 + sim.sim.day)).getUTCFullYear()).toBe(2026);
    expect(s.news.some((n) => /new administration/i.test(n.headline))).toBe(true);
    expect(integrity(sim.sim)).toEqual([]);
  });
});
