// Air pollution (industry + traffic, dispersed over a coarse grid), CO2 and water quality.

import type { Sim } from '../core';
import { Terrain } from '../types';

const G = 32; // grid cells per side (4x4 tiles each)
const EMIT: Record<string, number> = { factory: 0.012, materials: 0.03, foodplant: 0.006 };
const REG = [1, 0.65, 0.4];

/** Pollution level at a tile, 0 = clean, ~1 = heavily polluted. */
export function envAt(sim: Sim, x: number, y: number): number {
  const gx = Math.max(0, Math.min(G - 1, Math.floor(x / 4))), gy = Math.max(0, Math.min(G - 1, Math.floor(y / 4)));
  return sim.s.env.pollution[gy * G + gx];
}

export function environmentDaily(sim: Sim): void {
  if (sim.day % 7 !== 0) return;
  const s = sim.s, m = s.map;
  const reg = REG[s.gov.policies.environmentalRegulation];
  const enforcement = Math.min(1, s.gov.deptFunding.environment);
  const factor = 1 - (1 - reg) * enforcement;
  const emis = new Float64Array(G * G);
  for (const b of s.businesses) {
    const e = EMIT[b.kind];
    if (!e || b.status !== 'operating' || b.downDays > 0) continue;
    const bl = sim.bld(b.building);
    if (!bl) continue;
    let ops = 0;
    for (const j of b.jobs) if (j.worker >= 0 && j.role === 'operator') ops++;
    const k = Math.min(G - 1, Math.floor((bl.y + bl.h / 2) / 4)) * G + Math.min(G - 1, Math.floor((bl.x + bl.w / 2) / 4));
    emis[k] += ops * e * factor;
  }
  for (let i = 0; i < m.road.length; i++) {
    if (!m.road[i]) continue;
    const v = s.traffic.volume[i];
    if (v <= 0) continue;
    const x = i % 128, y = (i / 128) | 0;
    emis[(y >> 2) * G + (x >> 2)] += v * 0.00012;
  }
  const p = s.env.pollution;
  const next = new Array(G * G).fill(0);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    let acc = 0, wsum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
      acc += (p[ny * G + nx] * 0.55 + emis[ny * G + nx]) * w;
      wsum += w;
    }
    next[y * G + x] = Math.min(2, acc / wsum);
  }
  // trees and parks absorb a little
  for (let k = 0; k < G * G; k++) {
    const gx = k % G, gy = Math.floor(k / G);
    let green = 0;
    for (let yy = gy * 4; yy < gy * 4 + 4; yy++) for (let xx = gx * 4; xx < gx * 4 + 4; xx++) if (m.terrain[yy * 128 + xx] === Terrain.Forest || m.zone[yy * 128 + xx] === 5) green++;
    next[k] = Math.max(0, next[k] * (1 - green * 0.01));
  }
  s.env.pollution = next;
}

export function environmentMonthly(sim: Sim): void {
  const s = sim.s, acc = s.stats.acc;
  s.env.co2 = (acc.fuelLitres * 2.3) / 1000 + acc.industryCO2;
  // water quality: fertiliser run-off from farms near water and industrial discharge
  let runoff = 0, farms = 0;
  for (const b of s.businesses) {
    if (!b.farm) continue;
    farms++;
    if (b.farm.lowland && b.farm.phase !== 'fallow') runoff += b.farm.fertilizer;
  }
  const reg = REG[s.gov.policies.environmentalRegulation];
  const industry = s.businesses.filter((b) => EMIT[b.kind] && b.status === 'operating').length;
  s.env.water = Math.max(0.1, Math.min(0.97, 0.95 - (farms ? (runoff / farms) * 0.25 : 0) - industry * 0.02 * reg));
}
