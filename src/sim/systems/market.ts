// Wholesale markets. The city is a small open economy: local prices move with local supply and demand but are
// bounded by import parity (world price + tariff + freight) and export parity (world price - export tax - freight).
// Every trade is paid for and shipped by truck, so shortages, delays and price changes have physical causes.

import type { Account, Sim } from '../core';
import { GOOD_SPECS } from '../tables';
import { GOODS, GRAINS, type Business, type Good, type TradePartner } from '../types';
import { airportOf } from './aviation';
import { mspPrice, procure } from './food';
import { dispatch, freightPerUnit } from './logistics';
import { exportDest, importSource, type Source } from './trade';
import { nearestEdge } from './transport';

interface Offer { b: Business; qty: number; left: number; tile: number; perishable: boolean; producer: boolean }
interface Bid {
  b: Business | null; acct: Account; gov: boolean; payerBiz: Business | null; qty: number; left: number; tile: number; project: number;
  localOnly?: boolean; // buy only from local sellers; never import the unfilled remainder
}

export const FOOD_PLANT_RATE = 0.5; // t of packaged food per operator-day
export const GRAIN_PER_FOOD = 1.25;

/** Share of the world price an exporter receives before freight: perishables fetch far less in distant markets. */
export const EXPORT_REACH: Record<Good, number> = { wheat: 0.96, rice: 0.96, maize: 0.96, vegetables: 0.5, cotton: 0.97, food: 0.92, goods: 0.95, materials: 0.85 };

const W = 128;
const manhattan = (a: number, b: number) => Math.abs((a % W) - (b % W)) + Math.abs(((a / W) | 0) - ((b / W) | 0));

function operators(sim: Sim, b: Business): number {
  let n = 0;
  for (const j of b.jobs) if (j.role === 'operator' && j.worker >= 0) n++;
  return n;
}

export function foodPlantCapacity(sim: Sim, b: Business): number {
  return operators(sim, b) * FOOD_PLANT_RATE;
}

export function marketDaily(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const offers = new Map<Good, Offer[]>();
  const bids = new Map<Good, Bid[]>();
  for (const g of GOODS) { offers.set(g, []); bids.set(g, []); }
  const pop = s.citizens.length;
  let nGroc = 0, nShop = 0;
  for (const b of s.businesses) { if (b.kind === 'grocery') nGroc++; else if (b.kind === 'shop') nShop++; }
  const plants: { b: Business; tile: number }[] = [];

  const bidRetail = (b: Business, g: Good, tile: number, target: number, reorder: number, minQ: number, def: number) => {
    // a store that ran out still expects some trade: never let the restocking target decay to nothing
    const use = Math.max(b.ema[g] ?? def, def * 0.3);
    const have = (b.inv[g] ?? 0) + (b.transit[g] ?? 0);
    if (have >= use * reorder) return;
    let q = Math.max(use * target - have, have < minQ ? minQ : 0);
    const price = s.market[g].price * 1.1;
    q = Math.min(q, Math.max(0, b.cash) / price);
    if (q < minQ * 0.5) return;
    bids.get(g)!.push({ b, acct: b, gov: false, payerBiz: b, qty: q, left: q, tile, project: -1 });
  };
  const offerSurplus = (b: Business, g: Good, tile: number, min: number, keep: number) => {
    const q = (b.inv[g] ?? 0) - keep;
    if (q >= min) offers.get(g)!.push({ b, qty: q, left: q, tile, perishable: false, producer: true });
  };

  for (const b of s.businesses) {
    if (b.status !== 'operating' && b.status !== 'hiring') continue;
    for (const g of GOODS) {
      const q = b.inv[g];
      const sp = GOOD_SPECS[g].spoil;
      if (q && q > 0 && sp) b.inv[g] = q * (1 - (b.farm ? sp : sp * 0.7));
    }
    const bl = sim.bld(b.building);
    if (!bl || bl.access < 0) continue;
    const tile = bl.access;
    switch (b.kind) {
      case 'farm': {
        const f = b.farm!;
        for (const g of ['wheat', 'rice', 'maize', 'vegetables', 'cotton'] as Good[]) {
          const q = b.inv[g] ?? 0;
          if (q < 0.05) continue;
          const mk = s.market[g];
          let offer = 0;
          if (g === 'vegetables') offer = q >= 0.3 || r.chance(0.3) ? q : 0;
          else {
            const avg = mk.hist.length ? mk.hist.reduce((a, x) => a + x, 0) / mk.hist.length : mk.price;
            const holding = mk.price < 0.9 * avg && b.cash > 0 && q < f.ha * 8 && !(mspPrice(sim, g) > mk.price);
            if (r.chance(holding ? 0.06 : 0.35)) offer = Math.min(q, GOOD_SPECS[g].truck * 1.5);
            if (b.cash < 0) offer = q;
          }
          if (offer > 0) offers.get(g)!.push({ b, qty: offer, left: offer, tile, perishable: g === 'vegetables', producer: false });
        }
        break;
      }
      case 'foodplant':
        offerSurplus(b, 'food', tile, 2, foodPlantCapacity(sim, b));
        plants.push({ b, tile });
        break;
      case 'factory': offerSurplus(b, 'goods', tile, 300, 100); break;
      case 'materials': offerSurplus(b, 'materials', tile, 12, 4); break;
      case 'grocery':
        bidRetail(b, 'food', tile, 10, 6, 0.4, (pop * 0.00055) / Math.max(1, nGroc));
        bidRetail(b, 'vegetables', tile, 3, 1.8, 0.25, (pop * 0.00032) / Math.max(1, nGroc));
        break;
      case 'restaurant':
        bidRetail(b, 'food', tile, 7, 3, 0.06, 0.012);
        bidRetail(b, 'vegetables', tile, 3, 1.5, 0.04, 0.007);
        break;
      case 'shop': bidRetail(b, 'goods', tile, 10, 6, 60, (pop * 0.12) / Math.max(1, nShop)); break;
    }
  }
  // construction sites order materials ahead of the work
  for (const p of s.projects) {
    if (p.phase !== 'construction' || p.access < 0) continue;
    const ahead = Math.min(1, (p.laborDone + 14 * Math.max(4, p.workersToday)) / Math.max(1, p.labor));
    const need = p.materials * ahead - p.matDelivered - p.matOrdered;
    const left = p.materials - p.matDelivered - p.matOrdered;
    if (need <= 0 || need < Math.min(3, left)) continue;
    const sponsor = p.gov ? null : sim.biz(p.sponsor) ?? null;
    if (!p.gov && (!sponsor || sponsor.cash <= 0)) continue;
    bids.get('materials')!.push({ b: null, acct: p.gov ? s.gov : sponsor!, gov: p.gov, payerBiz: sponsor, qty: need, left: need, tile: p.access, project: p.id });
  }
  // food processors take whatever grain local farmers bring to market (up to a month of storage) and import
  // only when their silos run low, so a good local harvest displaces imports and a poor one brings them back
  for (const { b, tile } of plants) {
    const cap = foodPlantCapacity(sim, b);
    if (cap <= 0) continue;
    let have = 0;
    for (const g of GRAINS) have += (b.inv[g] ?? 0) + (b.transit[g] ?? 0);
    const daily = cap * GRAIN_PER_FOOD;
    const budget = Math.max(0, b.cash) / (s.market.wheat.price * 1.1);
    let room = Math.min(daily * 30 - have, budget);
    let local = 0;
    for (const g of GRAINS) {
      if (room <= 0.5) break;
      const offered = offers.get(g)!.reduce((a, o) => a + o.qty, 0);
      const q = Math.min(room, offered);
      if (q <= 0.5) continue;
      bids.get(g)!.push({ b, acct: b, gov: false, payerBiz: b, qty: q, left: q, tile, project: -1, localOnly: true });
      room -= q;
      local += q;
    }
    if (have < daily * 6) {
      const q = Math.min(daily * 14 - have, budget) - local;
      if (q >= 5) {
        const g = GRAINS.reduce((a, x) => (sim.worldPrice(x) < sim.worldPrice(a) ? x : a), GRAINS[0]);
        bids.get(g)!.push({ b, acct: b, gov: false, payerBiz: b, qty: q, left: q, tile, project: -1 });
      }
    }
  }
  for (const g of GOODS) clear(sim, g, offers.get(g)!, bids.get(g)!);
}

function clear(sim: Sim, g: Good, offers: Offer[], bids: Bid[]): void {
  const s = sim.s, mk = s.market[g], t = s.gov.taxes;
  let S = 0, D = 0;
  for (const o of offers) S += o.qty;
  for (const b of bids) D += b.qty;
  mk.supply = S;
  mk.demand = D;
  const world = sim.worldPrice(g);
  const fr = freightPerUnit(sim, g, 60);
  const src = importSource(sim, g);
  const dst = exportDest(sim, g);
  const imp = world * (1 + src.tariff) * src.mult + fr;
  const banned = s.gov.policies.grainExportBan && GRAINS.includes(g);
  // an airport flies perishables to distant markets; exporters may also get a share of their sales refunded
  const reach = EXPORT_REACH[g] + (g === 'vegetables' && airportOf(sim) ? 0.12 : 0);
  const incentive = s.gov.policies.exportIncentive;
  const exp = banned ? world * 0.45 : Math.max(world * 0.3, world * reach * dst.factor * (1 - t.export + incentive) - fr);
  if (S + D > 0) mk.price *= 1 + (0.05 * (D - S)) / Math.max(D, S);
  else mk.price += ((imp + exp) / 2 - mk.price) * 0.01;
  mk.price = Math.min(imp, Math.max(exp, mk.price));
  const price = mk.price;
  // with a support price above the market, farmers sell their grain to the state instead
  const msp = mspPrice(sim, g);
  const toState = msp > Math.max(price, exp) ? offers.filter((o) => o.b.farm) : [];
  for (const o of toState) { procure(sim, g, o.b, o.left, msp); o.left = 0; }
  sim.rng.shuffle(bids);
  for (const bid of bids) {
    if (bid.left <= 0.01) continue;
    const avail = offers.filter((o) => o.left > 0.01);
    if (!avail.length) break;
    avail.sort((a, b) => manhattan(a.tile, bid.tile) - manhattan(b.tile, bid.tile));
    for (const o of avail) {
      if (bid.left <= 0.01) break;
      const q = Math.min(o.left, bid.left);
      trade(sim, g, o, bid, q, price);
    }
  }
  for (const bid of bids) if (bid.left > 0.01 && !bid.localOnly) importFor(sim, g, bid, bid.left, world * src.mult, src);
  if (!banned) {
    for (const o of offers) {
      if (o.left <= 0.01) continue;
      if (msp > 0 && o.b.farm && msp >= exp) { procure(sim, g, o.b, o.left, msp); o.left = 0; continue; }
      if (o.perishable || o.producer || price <= exp * 1.03) exportFrom(sim, g, o, o.left, world * dst.factor, dst.p, incentive);
    }
  }
  mk.hist.push(price);
  if (mk.hist.length > 120) mk.hist.shift();
  if (D > 0 && S < D * 0.98) mk.lastWhy = `Local supply covered ${Math.round((S / D) * 100)}% of demand; the rest came in at import parity (world price + ${Math.round(src.tariff * 100)}% tariff + freight${src.p ? `, from ${src.p.name}` : ''}).`;
  else if (S > D * 1.02) mk.lastWhy = banned ? 'Local surplus with exports banned: prices are falling below world levels.' : 'Local surplus: the excess is exported, so prices sit near export parity.';
  else if (S + D > 0) mk.lastWhy = 'Local supply and demand are roughly balanced.';
}

function trade(sim: Sim, g: Good, o: Offer, bid: Bid, q: number, price: number): void {
  const value = q * price;
  if (bid.gov) sim.spend('capital', o.b, value);
  else sim.pay(bid.acct, o.b, value);
  if (bid.payerBiz) bid.payerBiz.m.cogs += value;
  o.b.m.revenue += value;
  o.b.m.sales += q;
  if (o.b.farm) o.b.farm.seasonRevenue += value;
  o.b.inv[g] = (o.b.inv[g] ?? 0) - q;
  o.left -= q;
  bid.left -= q;
  if (bid.project >= 0) {
    const p = sim.ix.proj.get(bid.project);
    if (p) { p.matOrdered += q; p.spent += value; }
  } else if (bid.b) bid.b.transit[g] = (bid.b.transit[g] ?? 0) + q;
  sim.s.market[g].local += q;
  dispatch(sim, {
    good: g, qty: q, value, from: o.b.id, to: bid.project >= 0 ? -1 : bid.b!.id, fromTile: o.tile, toTile: bid.tile,
    purpose: bid.project >= 0 ? 'project' : 'supply', project: bid.project, payer: bid.acct, payerBiz: bid.payerBiz, gov: bid.gov,
  });
}

function importFor(sim: Sim, g: Good, bid: Bid, q: number, world: number, src: Source): void {
  const s = sim.s;
  const value = q * world;
  let tariff = 0;
  if (bid.gov) sim.spend('capital', s.ext, value);
  else {
    sim.pay(bid.acct, s.ext, value);
    tariff = sim.tax('importTariff', bid.acct, value * src.tariff);
  }
  if (src.p) src.p.imp += value;
  if (bid.payerBiz) bid.payerBiz.m.cogs += value + tariff;
  if (bid.project >= 0) {
    const p = sim.ix.proj.get(bid.project);
    if (p) { p.matOrdered += q; p.spent += value + tariff; }
  } else if (bid.b) bid.b.transit[g] = (bid.b.transit[g] ?? 0) + q;
  const mk = s.market[g];
  mk.imported += q;
  mk.importValue += value + tariff;
  bid.left -= q;
  dispatch(sim, {
    good: g, qty: q, value, from: -1, to: bid.project >= 0 ? -1 : bid.b!.id, fromTile: nearestEdge(sim, bid.tile), toTile: bid.tile,
    purpose: bid.project >= 0 ? 'project' : 'import', project: bid.project, payer: bid.acct, payerBiz: bid.payerBiz, gov: bid.gov,
  });
}

function exportFrom(sim: Sim, g: Good, o: Offer, q: number, world: number, dest: TradePartner | null, incentive: number): void {
  const s = sim.s;
  const gross = q * world;
  sim.pay(s.ext, o.b, gross);
  const tax = sim.tax('exportTax', o.b, gross * s.gov.taxes.export);
  const refund = gross * incentive;
  if (refund > 0) { sim.spend('exportSupport', o.b, refund); o.b.m.revenue += refund; }
  if (dest) dest.exp += gross;
  o.b.m.revenue += gross;
  o.b.m.taxes += tax;
  o.b.m.sales += q;
  if (o.b.farm) o.b.farm.seasonRevenue += gross - tax + refund;
  o.b.inv[g] = (o.b.inv[g] ?? 0) - q;
  o.left -= q;
  const mk = s.market[g];
  mk.exported += q;
  mk.exportValue += gross;
  dispatch(sim, {
    good: g, qty: q, value: gross, from: o.b.id, to: -1, fromTile: o.tile, toTile: nearestEdge(sim, o.tile),
    purpose: 'export', project: -1, payer: o.b, payerBiz: o.b, gov: false,
  });
}

/** Month roll-over of market counters. */
export function marketMonthly(sim: Sim): void {
  for (const g of GOODS) {
    const mk = sim.s.market[g];
    mk.lastLocal = mk.local; mk.lastImported = mk.imported; mk.lastExported = mk.exported;
    mk.local = 0; mk.imported = 0; mk.exported = 0; mk.importValue = 0; mk.exportValue = 0;
  }
}
