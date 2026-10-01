// Foreign trade: partner economies, the exchange rate, the tariffs partners charge on our exports, trade agreements
// and disputes. The market's import price comes from the cheapest source and its export price from the best-paying
// destination, so agreements, disputes and currency moves change what local producers and buyers face.

import type { Sim } from '../core';
import type { Good, TradePartner } from '../types';

const AGRI = new Set<Good>(['wheat', 'rice', 'maize', 'vegetables', 'cotton', 'food']);
export const isAgri = (g: Good) => AGRI.has(g);
/** Foreign tariff level already reflected in the baseline export price. */
const BASE_FOREIGN_TARIFF = 0.05;
/** Markets without a partner relationship pay a little less (smaller, further or harder to reach). */
const OTHER_MARKETS = 0.97;
export const DISPUTE_TARIFF = 0.25;
const inForce = (p: TradePartner) => p.status === 'agreement' || p.status === 'leaving';
const shipping = (p: TradePartner) => 1 + 0.03 * (p.dist - 1);

/** Our tariff on a good from a partner. Agreements remove tariffs on manufactures and halve them on farm goods. */
export function ourTariff(sim: Sim, g: Good, p: TradePartner | null): number {
  const t = sim.s.gov.taxes;
  const base = isAgri(g) ? t.importFood : t.import;
  if (!p || !inForce(p)) return base;
  return isAgri(g) ? base * 0.5 : 0;
}

/** The tariff a partner charges on our exports of a good. */
export function theirTariff(p: TradePartner, g: Good): number {
  let t = isAgri(g) ? p.tariffAgri : p.tariffGoods;
  if (inForce(p)) t = isAgri(g) ? t * 0.5 : 0;
  if (p.dispute > 0 && !isAgri(g)) t += DISPUTE_TARIFF;
  return t;
}

export interface Source { p: TradePartner | null; tariff: number; mult: number }
export interface Dest { p: TradePartner | null; factor: number }

/** Cheapest place to import a good from, after our tariff and shipping. */
export function importSource(sim: Sim, g: Good): Source {
  let best: Source = { p: null, tariff: ourTariff(sim, g, null), mult: 1 };
  let cost = 1 + best.tariff;
  for (const p of sim.s.trade.partners) {
    if (!p.sells.includes(g)) continue;
    const tariff = ourTariff(sim, g, p), mult = shipping(p);
    const c = (1 + tariff) * mult;
    if (c < cost - 1e-9) { cost = c; best = { p, tariff, mult }; }
  }
  return best;
}

/** Best-paying export market for a good, as a factor on the world price. */
export function exportDest(sim: Sim, g: Good): Dest {
  let best: Dest = { p: null, factor: OTHER_MARKETS };
  for (const p of sim.s.trade.partners) {
    if (!p.buys.includes(g)) continue;
    const f = ((1 - theirTariff(p, g)) / (1 - BASE_FOREIGN_TARIFF)) * (2 - shipping(p));
    if (f > best.factor + 1e-9) best = { p, factor: f };
  }
  return best;
}

function conclude(sim: Sim, p: TradePartner): void {
  const r = sim.rng;
  const chance = 0.7 - (p.dispute > 0 ? 0.35 : 0);
  if (r.chance(chance)) {
    p.status = 'agreement';
    p.statusDay = sim.day;
    sim.emit('trade.agreement', `A trade agreement with ${p.name} is now in force.`, 3, undefined, undefined, [
      'Tariffs on manufactured goods are removed both ways; tariffs on farm goods are halved',
      `Local exporters get better prices in ${p.name}; imports from there become cheaper`,
      'Local producers competing with those imports face more competition',
    ]);
  } else {
    p.status = 'none';
    p.statusDay = sim.day;
    sim.s.trade.lastTalks = sim.day;
    sim.emit('trade.talksFailed', `Trade talks with ${p.name} have collapsed over farm market access.`, 2, undefined, undefined,
      ['Nothing changes for now; talks can be reopened after a cooling-off period of a year']);
  }
}

export function tradeDaily(sim: Sim): void {
  const tr = sim.s.trade, r = sim.rng;
  // the national currency floats: a slow random walk plus occasional shocks (see tradeMonthly)
  tr.fxDev = tr.fxDev * 0.9985 + 0.0022 * r.normal();
  tr.fx = Math.exp(tr.fxDev);
  for (const p of tr.partners) {
    if (p.dispute > 0 && --p.dispute === 0) sim.emit('trade.disputeEnded', `${p.name} lifts its punitive tariffs on our goods.`, 2, undefined, undefined, ['Manufactured exports there are competitive again']);
    if (p.status === 'talks' && sim.day >= p.due) conclude(sim, p);
    else if (p.status === 'leaving' && sim.day >= p.due) {
      p.status = 'none';
      p.statusDay = sim.day;
      sim.emit('trade.left', `The trade agreement with ${p.name} has ended.`, 2, undefined, undefined, ['Tariffs return to their normal levels in both directions']);
    }
  }
}

export function tradeMonthly(sim: Sim): void {
  const s = sim.s, tr = s.trade, r = sim.rng;
  for (const p of tr.partners) {
    if (p.dispute > 0) continue;
    if (r.chance(p.status === 'agreement' ? 0.0015 : 0.005)) {
      p.dispute = 180 + r.int(360);
      sim.emit('trade.dispute', `${p.name} imposes ${Math.round(DISPUTE_TARIFF * 100)}% punitive tariffs on our manufactured goods in a trade dispute.`, 3, undefined, undefined,
        [`Exporters of manufactured goods lose their market in ${p.name} and must sell elsewhere for less`, `Expected to last about ${Math.round(p.dispute / 30)} months`]);
    }
  }
  if (r.chance(0.01)) {
    const jump = (r.chance(0.55) ? 1 : -1) * r.range(0.05, 0.12);
    tr.fxDev += jump;
    const code = sim.preset.currencyCode;
    sim.emit('world.fx', `The ${code} ${jump > 0 ? 'falls' : 'rises'} ${Math.round(Math.abs(Math.exp(jump) - 1) * 100)}% against the ${sim.preset.fxName}.`, 2, undefined, undefined,
      jump > 0 ? ['Imports, fuel and imported components cost more', 'Exporters, tech firms and foreign visitors gain: the city becomes cheaper for them']
        : ['Imports and fuel get cheaper', 'Exporters earn less in local currency and foreign visitors find the city dearer']);
  }
  for (const p of tr.partners) {
    p.totalExp += p.exp; p.totalImp += p.imp;
    p.lastExp = p.exp; p.lastImp = p.imp;
    p.exp = 0; p.imp = 0;
  }
}
