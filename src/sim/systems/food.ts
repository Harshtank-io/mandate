// Food-security programmes: a minimum support price for wheat and rice (the government buys any grain offered at
// that price), ration shops that hand subsidised grain to poor families, and monthly cash support. Procured grain is
// stored, distributed, and surplus stock is sold abroad at whatever the world market pays.

import type { Sim } from '../core';
import { hhIncome } from '../econ';
import { GOOD_SPECS, RATION_HANDLING, RATION_KG, STORAGE_COST } from '../tables';
import type { Business, Good } from '../types';
import { povertyLine } from './services';

const MSP_GOODS: Good[] = ['wheat', 'rice'];

/** Support price per tonne for a grain; 0 when the scheme is off or the grain is not covered. */
export function mspPrice(sim: Sim, g: Good): number {
  const msp = sim.s.gov.policies.msp;
  if (!(msp > 0) || !MSP_GOODS.includes(g)) return 0;
  return GOOD_SPECS[g].world * sim.scale * sim.s.ext.trend * msp;
}

/** The government buys grain from a farm at the support price; the grain goes into public stock. */
export function procure(sim: Sim, g: Good, farm: Business, q: number, price: number): void {
  const value = q * price;
  sim.spend('procurement', farm, value);
  farm.m.revenue += value;
  farm.m.sales += q;
  if (farm.farm) farm.farm.seasonRevenue += value;
  farm.inv[g] = (farm.inv[g] ?? 0) - q;
  const P = sim.s.pds;
  P.stock += q;
  P.stockValue += value;
  P.procured += q;
  P.procuredValue += value;
}

export function foodMonthly(sim: Sim): void {
  const s = sim.s, P = s.pds, pol = s.gov.policies;
  const line = povertyLine(sim);
  const poor = s.households.filter((h) => h.members.length > 0 && hhIncome(h) / h.members.length < line * 1.2);
  let families = 0;
  // ration shops: 5 kg of grain per person a month for poor families, handed out by local grocers
  if (pol.rationShops) {
    let need = 0;
    for (const h of poor) need += h.members.length * RATION_KG;
    const needT = need / 1000;
    if (P.stock < needT) {
      // not enough procured grain: the programme buys the rest at import prices
      const buyT = needT - P.stock;
      const price = s.ext.prices.wheat * 1.08;
      sim.spend('rations', s.ext, buyT * price);
      P.stock += buyT;
      P.stockValue += buyT * price;
    }
    const avg = P.stock > 0 ? P.stockValue / P.stock : 0;
    P.stock -= needT;
    P.stockValue = Math.max(0, P.stockValue - needT * avg);
    for (const h of poor) h.ration += h.members.length * RATION_KG;
    P.rationed += need;
    families = poor.length;
    const shops = s.businesses.filter((b) => b.kind === 'grocery' && b.status === 'operating');
    const fee = need * RATION_HANDLING * sim.scale * s.ext.trend;
    if (shops.length) for (const b of shops) { const amt = fee / shops.length; sim.spend('rations', b, amt); b.m.revenue += amt; }
    else sim.spend('rations', s.ext, fee);
  }
  // cash support for families below the poverty line
  if (pol.povertyTransfer > 0) {
    for (const h of poor) {
      if (hhIncome(h) / h.members.length >= line) continue;
      sim.spend('transfers', h, pol.povertyTransfer);
      h.m.benefits += pol.povertyTransfer;
    }
    families = Math.max(families, poor.filter((h) => hhIncome(h) / h.members.length < line).length);
  }
  P.families = families;
  // storage, and selling surplus stock abroad
  if (P.stock > 0.01) {
    sim.spend('procurement', s.ext, P.stockValue * STORAGE_COST);
    const keep = pol.rationShops ? Math.max(50, (P.rationed / 1000) * 4) : 0;
    if (P.stock > keep + 20) {
      const q = P.stock - keep;
      const price = s.ext.prices.wheat * 0.92;
      const avg = P.stockValue / P.stock;
      sim.tax('grainSales', s.ext, q * price);
      P.stock -= q;
      P.stockValue = Math.max(0, P.stockValue - q * avg);
      P.sold += q;
      if (q > 50) sim.emit('food.stockSale', `The government sold ${Math.round(q).toLocaleString('en-US')} t of surplus grain abroad at ${Math.round(price).toLocaleString('en-US')} per tonne.`, 1, undefined, undefined,
        [`It paid about ${Math.round(avg).toLocaleString('en-US')} per tonne at the support price`, 'The difference is the cost of supporting farm prices']);
    }
  }
  if (P.procured > 50) sim.emit('food.procured', `The government bought ${Math.round(P.procured).toLocaleString('en-US')} t of grain from farmers at the support price last month.`, P.procured > 500 ? 2 : 1, undefined, undefined,
    ['Farmers sell to the state when the support price beats what mills and exporters pay']);
  P.lastProcured = P.procured; P.procured = 0;
  P.lastProcuredValue = P.procuredValue; P.procuredValue = 0;
  P.lastRationed = P.rationed; P.rationed = 0;
  P.lastSold = P.sold; P.sold = 0;
}
