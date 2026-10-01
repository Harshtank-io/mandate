// The persistent-world promise rests on these: the same world always evolves the same way, however time is stepped,
// and a saved world continues exactly as if it had never been closed.

import { describe, expect, it } from 'vitest';
import { MIN_PER_DAY } from '../src/sim/calendar';
import { Simulation } from '../src/sim/simulation';
import { Game } from '../src/game/game';
import { decode, encode } from '../src/game/persist';
import type { WorldState } from '../src/sim/types';
import { clone, firstDiff, nonFinite, totalMoney, world } from './helpers';

describe('determinism', () => {
  it('produces identical worlds from the same seed', () => {
    const a = world(), b = world();
    expect(firstDiff(a.state, b.state)).toBeNull();
    a.advanceDays(60);
    b.advanceDays(60);
    expect(firstDiff(a.state, b.state)).toBeNull();
  });

  it('produces different worlds from different seeds', () => {
    const a = world({ seed: 1 }), b = world({ seed: 2 });
    expect(firstDiff(a.state.map.terrain, b.state.map.terrain)).not.toBeNull();
  });

  it('gives the same result whether time moves in frame-sized steps or whole days', () => {
    const a = world(), b = clone(a);
    const target = a.state.minute + 25 * MIN_PER_DAY + 517;
    // a: live play at an uneven frame rate
    let k = 0;
    while (a.state.minute + 9 < target) a.advanceTo(a.state.minute + 3.7 + (k++ % 5) * 1.3);
    a.advanceTo(target);
    // b: one catch-up jump
    b.advanceTo(target);
    expect(firstDiff(a.state, b.state)).toBeNull();
  });

  it('continues a saved world exactly as if it had never been closed', () => {
    const live = world({ condition: 'growing', seed: 99 });
    live.advanceTo(live.state.minute + 40 * MIN_PER_DAY + 333); // save in the middle of a day
    const saved = JSON.stringify(live.state);
    live.advanceDays(75);
    const reopened = Simulation.fromState(JSON.parse(saved) as WorldState);
    reopened.advanceDays(75);
    expect(firstDiff(live.state, reopened.state)).toBeNull();
  });
});

describe('money and state health', () => {
  it('conserves money: every payment has a payer and a payee', () => {
    const sim = world({ condition: 'established', seed: 5 });
    const before = totalMoney(sim.state);
    sim.advanceDays(365);
    const drift = totalMoney(sim.state) - before;
    expect(Math.abs(drift)).toBeLessThan(10);
    // and there was real activity to conserve
    expect(sim.state.gov.total.rev).toBeGreaterThan(0);
  });

  it('keeps every number finite over a year', () => {
    const sim = world({ preset: 'ke-rift', condition: 'agricultural', seed: 8 });
    sim.advanceDays(365);
    expect(nonFinite(sim.state)).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips a world through the compressed save format', async () => {
    const sim = world();
    sim.advanceDays(10);
    const { blob, enc } = await encode(sim.state);
    expect(enc).toBe('gzip');
    expect(blob.size).toBeLessThan(JSON.stringify(sim.state).length / 3);
    const back = await decode(blob);
    expect(firstDiff(sim.state, back)).toBeNull();
  });

  it('rejects files that are not saves', async () => {
    await expect(decode(new Blob(['{"hello":1}']))).rejects.toThrow();
    await expect(decode(new Blob(['not json']))).rejects.toThrow();
  });
});

describe('offline progression', () => {
  it('simulates the real time that passed at the world pace and reports it', async () => {
    const sim = world({ seed: 42 });
    const g = new Game(sim);
    const hours = 3;
    sim.state.meta.lastReal = Date.now() - hours * 3600_000;
    const start = sim.state.minute;
    const report = await g.catchUp();
    const expected = hours * 3600 * sim.state.meta.pace;
    expect(Math.abs(sim.state.minute - start - expected)).toBeLessThan(5);
    expect(report).not.toBeNull();
    expect(report!.days).toBeGreaterThan(14);
    expect(report!.lines.some((l) => l.text.startsWith('Population'))).toBe(true);
    expect(report!.lines.some((l) => l.text.includes('collected'))).toBe(true);
  });

  it('stops at the offline limit chosen for the world', async () => {
    const sim = world({ seed: 43, offlineCapDays: 5 });
    const g = new Game(sim);
    sim.state.meta.lastReal = Date.now() - 48 * 3600_000;
    const start = sim.state.minute;
    const report = await g.catchUp();
    expect(sim.state.minute - start).toBeCloseTo(5 * MIN_PER_DAY, 6);
    expect(report?.cappedDays).toBe(5);
  });

  it('matches uninterrupted play: catching up is the same simulation', async () => {
    const a = world({ seed: 77 }), b = clone(a);
    const g = new Game(b);
    const realMs = 2 * 3600_000;
    b.state.meta.lastReal = Date.now() - realMs;
    await g.catchUp();
    a.advanceTo(b.state.minute);
    const strip = (s: WorldState) => ({ ...s, meta: { ...s.meta, lastReal: 0 } });
    expect(firstDiff(strip(a.state), strip(b.state))).toBeNull();
  });
});
