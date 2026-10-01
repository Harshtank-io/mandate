// The world outside the city: commodity prices, fuel, and the business cycle that drives export demand.
// Local prices are tied to these through import/export parity in the market system.

import type { Sim } from '../core';
import { GOOD_SPECS } from '../tables';
import { GOODS, type Good } from '../types';

const RISE = ['poor harvests abroad', 'export restrictions by a major producer', 'strong import demand in Asia', 'a weaker currency'];
const FALL = ['bumper harvests abroad', 'weak global demand', 'large carry-over stocks', 'a stronger currency'];

export function externalDaily(sim: Sim): void {
  const e = sim.s.ext, r = sim.rng;
  e.trend *= Math.pow(1 + sim.preset.inflation, 1 / 365);
  for (const g of GOODS) e.dev[g] = e.dev[g] * 0.995 + GOOD_SPECS[g].vol * r.normal();
  // processed food tracks grain prices with a lag
  const grain = (e.dev.wheat + e.dev.rice + e.dev.maize) / 3;
  e.dev.food = e.dev.food * 0.97 + grain * 0.03 * 0.7 + GOOD_SPECS.food.vol * r.normal();
  const target = e.phase === 'recession' ? 0.8 : e.phase === 'boom' ? 1.1 : 1;
  e.demand += (target - e.demand) * 0.02 + 0.002 * r.normal();
  // world prices are set in foreign currency: a weaker exchange rate makes every traded good dearer locally
  const fx = sim.s.trade.fx;
  for (const g of GOODS) {
    const cyc = g === 'goods' || g === 'materials' ? 0.8 + 0.2 * e.demand : g === 'cotton' ? 0.85 + 0.15 * e.demand : 1;
    e.prices[g] = GOOD_SPECS[g].world * sim.scale * e.trend * Math.exp(e.dev[g]) * cyc * fx;
  }
  e.fuelDev = e.fuelDev * 0.996 + 0.006 * r.normal();
  e.fuel = 60 * sim.scale * e.trend * Math.exp(e.fuelDev) * (0.9 + 0.1 * e.demand) * fx;
}

export function externalMonthly(sim: Sim): void {
  const e = sim.s.ext, r = sim.rng;
  if (e.phase === 'normal') {
    if (r.chance(0.011)) {
      e.phase = 'recession'; e.phaseLeft = 6 + r.int(12);
      sim.emit('world.recession', 'A global recession is cutting demand for manufactured goods and services exports.', 3, undefined, undefined,
        ['Export prices for manufactured goods fall', 'Technology and services companies see fewer contracts']);
    } else if (r.chance(0.01)) {
      e.phase = 'boom'; e.phaseLeft = 6 + r.int(12);
      sim.emit('world.boom', 'A global upswing is lifting demand for exports.', 2, undefined, undefined, ['Export prices and services demand rise']);
    }
  } else if (--e.phaseLeft <= 0) {
    const was = e.phase;
    e.phase = 'normal';
    sim.emit('world.normal', was === 'recession' ? 'The global recession has ended; export demand is recovering.' : 'The global boom is cooling to normal growth.', 1);
  }
  if (r.chance(0.03)) {
    const g = r.pick<Good>(['wheat', 'rice', 'maize', 'cotton', 'vegetables']);
    if (!sim.preset.crops[g as keyof typeof sim.preset.crops] && g !== 'vegetables') return;
    const up = r.chance(0.5);
    const jump = (up ? 1 : -1) * r.range(0.14, 0.3);
    const before = e.prices[g];
    e.dev[g] += jump;
    const pct = Math.round((Math.exp(jump) - 1) * 100);
    sim.emit('world.price', `Global ${GOOD_SPECS[g].label.toLowerCase()} prices ${up ? 'jump' : 'fall'} ${Math.abs(pct)}% on ${r.pick(up ? RISE : FALL)}.`, 2, undefined, undefined,
      [`World ${GOOD_SPECS[g].label.toLowerCase()} price moved from ${Math.round(before)} to about ${Math.round(before * Math.exp(jump))} per tonne`]);
  }
  if (r.chance(0.012)) {
    const up = r.chance(0.65);
    const jump = up ? r.range(0.15, 0.35) : -r.range(0.12, 0.25);
    e.fuelDev += jump;
    sim.emit('world.fuel', `Global oil prices ${up ? 'spike' : 'slump'} ${Math.round(Math.abs(Math.exp(jump) - 1) * 100)}%.`, 2, undefined, undefined,
      [up ? 'Fuel, freight and farm pumping costs rise' : 'Fuel and freight costs ease']);
  }
}
