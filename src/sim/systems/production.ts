// Daily production at processing plants, factories, materials plants and offices.

import type { Sim } from '../core';
import { buyFuel } from '../econ';
import { GRAINS, type Business, type RoleId } from '../types';
import { connectivity } from './aviation';
import { FOOD_PLANT_RATE, GRAIN_PER_FOOD } from './market';
import { importSource } from './trade';

const OFFICE_OUTPUT: Partial<Record<RoleId, number>> = { engineer: 4200, analyst: 3300, support: 1500, manager: 2200 };

/** Productivity multiplier from support staff (supervisors, technicians, managers) and worker health. */
function staffing(sim: Sim, b: Business): { ops: number; support: number; health: number } {
  let ops = 0, sup = 0, supTot = 0, hsum = 0, n = 0;
  for (const j of b.jobs) {
    const isOp = j.role === 'operator';
    if (!isOp && j.role !== 'driver') supTot++;
    if (j.worker < 0) continue;
    const c = sim.cit(j.worker);
    if (!c || c.injured > 0) continue;
    if (isOp) ops++;
    else if (j.role !== 'driver') sup++;
    hsum += c.health; n++;
  }
  const support = supTot ? 0.6 + (0.4 * sup) / supTot : 1;
  const health = n ? 0.7 + 0.3 * (hsum / n) : 1;
  return { ops, support, health };
}

export function productionDaily(sim: Sim): void {
  const s = sim.s;
  const nominal = sim.scale * s.ext.trend;
  const workDay = sim.isWorkDay();
  const weekday = sim.date.dow >= 1 && sim.date.dow <= 5;
  const attendance = s.weather.pandemic > 0 ? 0.85 : 1;
  const t = s.gov.taxes;
  for (const b of s.businesses) {
    if (b.status !== 'operating') continue;
    if (b.downDays > 0) { b.downDays--; continue; }
    switch (b.kind) {
      case 'foodplant': {
        if (!workDay) break;
        const st = staffing(sim, b);
        let grain = 0;
        for (const g of GRAINS) grain += b.inv[g] ?? 0;
        const out = Math.min(st.ops * FOOD_PLANT_RATE * st.support * st.health * attendance, grain / GRAIN_PER_FOOD);
        if (out <= 0.01) break;
        const use = out * GRAIN_PER_FOOD;
        for (const g of GRAINS) { const q = b.inv[g] ?? 0; if (q > 0) b.inv[g] = q - use * (q / grain); }
        b.inv.food = (b.inv.food ?? 0) + out;
        const energy = out * 900 * nominal;
        sim.pay(b, s.ext, energy);
        b.m.cogs += energy;
        b.m.production += out;
        s.stats.acc.industryCO2 += out * 0.05;
        break;
      }
      case 'factory': {
        if (!workDay) break;
        const st = staffing(sim, b);
        const out = st.ops * 3.5 * st.support * st.health * attendance;
        const world = s.ext.prices.goods;
        const components = 0.5 * world;
        const energy = 40 * nominal;
        const expParity = world * (1 - t.export);
        // in a special economic zone components come in duty-free; otherwise from the cheapest source
        const duty = s.gov.policies.investmentIncentive >= 2 ? 0 : importSource(sim, 'goods').tariff;
        if (out <= 0 || expParity < components * (1 + duty) + energy) { b.reason = 'Output halted: components cost more than goods sell for'; break; }
        const comp = components * out;
        sim.pay(b, s.ext, comp + energy * out);
        const tariff = sim.tax('importTariff', b, comp * duty);
        b.m.cogs += comp + tariff + energy * out;
        b.inv.goods = (b.inv.goods ?? 0) + out;
        b.m.production += out;
        s.stats.acc.industryCO2 += out * 0.02;
        break;
      }
      case 'materials': {
        if (!workDay) break;
        const st = staffing(sim, b);
        const out = st.ops * 0.5 * st.support * st.health * attendance;
        if (out <= 0) break;
        const fuel = buyFuel(sim, b, out * 9);
        const raw = 0.2 * s.ext.prices.materials * out;
        sim.pay(b, s.ext, raw);
        b.m.cogs += fuel + raw;
        b.inv.materials = (b.inv.materials ?? 0) + out;
        b.m.production += out;
        s.stats.acc.industryCO2 += out * 0.25;
        break;
      }
      case 'office': {
        if (!weekday) break;
        let rev = 0, staff = 0;
        for (const j of b.jobs) {
          if (j.worker < 0) continue;
          const c = sim.cit(j.worker);
          if (!c || c.injured > 0) continue;
          staff++;
          rev += (OFFICE_OUTPUT[j.role] ?? 1000) * (0.8 + 0.2 * c.health) * Math.min(1.25, 0.9 + c.exp * 0.02);
        }
        // contracts are priced in foreign currency; flights bring clients within reach
        rev *= nominal * s.ext.demand * attendance * s.trade.fx * (1 + 0.06 * connectivity(sim));
        if (rev <= 0) break;
        sim.pay(s.ext, b, rev);
        b.m.revenue += rev;
        const refund = rev * s.gov.policies.exportIncentive * 0.5;
        if (refund > 0) { sim.spend('exportSupport', b, refund); b.m.revenue += refund; }
        const util = staff * 250 * nominal;
        sim.pay(b, s.ext, util);
        b.m.cogs += util;
        b.m.production += staff;
        break;
      }
    }
  }
}
