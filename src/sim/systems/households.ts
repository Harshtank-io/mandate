// Household behaviour: weekly shopping at nearby stores, outings, monthly rent, fuel, fares and vehicle purchases.
// The selling functions are shared with visitors, who use the same shops, restaurants and services.

import { emptyHhLedger, type Account, type Sim, type StoreLists } from '../core';
import { buyFuel, foodRetail, goodsRetail, hhIncome, mealPrice, servicePrice, vegRetail } from '../econ';
import { FOOD_NEED, LEISURE_SHARE, MEAL_INPUT, MEAL_SUPPLIES, MEALS_PER_STAFF, SERVICE_SUPPLY_SHARE, VEG_NEED } from '../tables';
import type { Building, Business, Good, Household, RevCat } from '../types';
import { goOut } from './leisure';

type StoreKind = keyof StoreLists;
const STORE_KINDS: StoreKind[] = ['grocery', 'shop', 'restaurant', 'services', 'cinema'];
const emptyLists = (): StoreLists => ({ grocery: [], shop: [], restaurant: [], services: [], cinema: [] });

export function rebuildStores(sim: Sim): void {
  const ix = sim.ix;
  ix.stores.clear();
  const kinds: Record<StoreKind, Business[]> = emptyLists() as unknown as Record<StoreKind, Business[]>;
  for (const b of sim.s.businesses) {
    if (b.status !== 'operating' && b.status !== 'hiring') continue;
    if ((STORE_KINDS as string[]).includes(b.kind)) kinds[b.kind as StoreKind].push(b);
  }
  const pos = (b: Business) => { const bl = sim.bld(b.building); return bl ? sim.center(bl) : [0, 0]; };
  const cache = {} as Record<StoreKind, number[][]>;
  for (const k of STORE_KINDS) cache[k] = kinds[k].map(pos);
  const nearest = (k: StoreKind, x: number, y: number, n: number) => kinds[k]
    .map((b, i) => ({ id: b.id, d: Math.abs(cache[k][i][0] - x) + Math.abs(cache[k][i][1] - y) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((e) => e.id);
  for (const bl of sim.s.buildings) {
    if (bl.units <= 0) continue;
    const [x, y] = sim.center(bl);
    ix.stores.set(bl.id, { grocery: nearest('grocery', x, y, 3), shop: nearest('shop', x, y, 3), restaurant: nearest('restaurant', x, y, 3), services: nearest('services', x, y, 3), cinema: nearest('cinema', x, y, 2) });
  }
  // visitors eat, shop and hire guides around where they stay and sightsee
  const spots = sim.s.buildings.filter((b) => b.kind === 'hotel' || b.kind === 'heritage' || b.kind === 'museum');
  const th = sim.s.buildings.find((b) => b.kind === 'townhall');
  let vx = th ? sim.center(th)[0] : 64, vy = th ? sim.center(th)[1] : 64;
  if (spots.length) { vx = 0; vy = 0; for (const b of spots) { const [x, y] = sim.center(b); vx += x / spots.length; vy += y / spots.length; } }
  ix.visitorStores = { grocery: [], shop: nearest('shop', vx, vy, 6), restaurant: nearest('restaurant', vx, vy, 8), services: nearest('services', vx, vy, 8), cinema: nearest('cinema', vx, vy, 2) };
  ix.storesDirty = false;
}

function storesFor(sim: Sim, home: Building | undefined): StoreLists {
  if (sim.ix.storesDirty) rebuildStores(sim);
  if (home) { const s = sim.ix.stores.get(home.id); if (s) return s; }
  const first = sim.s.buildings.find((b) => b.units > 0);
  return (first && sim.ix.stores.get(first.id)) ?? emptyLists();
}

export function visitorStores(sim: Sim): StoreLists {
  if (sim.ix.storesDirty || !sim.ix.visitorStores) rebuildStores(sim);
  return sim.ix.visitorStores ?? emptyLists();
}

/** Value of sales a store's staff can handle per day. */
function staffCapacity(sim: Sim, b: Business): number {
  let staff = b.owner >= 0 ? 1 : 0;
  for (const j of b.jobs) if (j.worker >= 0) staff++;
  const nominal = sim.scale * sim.s.ext.trend;
  switch (b.kind) {
    case 'grocery': return staff * 24_000 * nominal;
    case 'shop': return staff * 28_000 * nominal;
    case 'restaurant': return staff * MEALS_PER_STAFF * mealPrice(sim);
    default: return staff * 11 * servicePrice(sim);
  }
}

function recordSale(sim: Sim, b: Business, g: Good, q: number) {
  let m = sim.ix.sold.get(b.id);
  if (!m) { m = {}; sim.ix.sold.set(b.id, m); }
  m[g] = (m[g] ?? 0) + q;
}

/** Buys `qty` of a good from the listed stores for `payer`. Returns quantity obtained and total paid (incl. tax). */
export function purchase(sim: Sim, payer: Account, ids: number[], g: Good, qty: number, unit: number, taxCat: RevCat, rate: number): { got: number; cost: number } {
  let need = qty, paid = 0;
  let firstStore: Business | undefined;
  for (const id of ids) {
    if (need <= 1e-9) break;
    const b = sim.biz(id);
    if (!b || b.status !== 'operating' || b.downDays > 0) continue;
    firstStore ??= b;
    const served = sim.ix.served.get(b.id) ?? 0;
    const capLeft = Math.max(0, staffCapacity(sim, b) - served);
    const q = Math.min(need, b.inv[g] ?? 0, capLeft / unit);
    if (q <= 0) continue;
    const value = q * unit;
    const cost = value * (1 + rate);
    if (payer.cash < cost) break;
    sim.pay(payer, b, value);
    sim.tax(taxCat, payer, value * rate);
    b.inv[g] = (b.inv[g] ?? 0) - q;
    b.m.revenue += value;
    b.m.sales += q;
    sim.ix.served.set(b.id, served + value);
    recordSale(sim, b, g, q);
    paid += cost;
    need -= q;
  }
  if (need > 1e-9 && firstStore) firstStore.m.unmet += need * unit;
  return { got: qty - need, cost: paid };
}

function buy(sim: Sim, h: Household, ids: number[], g: Good, qty: number, unit: number, taxCat: RevCat, rate: number, field: 'food' | 'goods'): number {
  const r = purchase(sim, h, ids, g, qty, unit, taxCat, rate);
  h.m[field] += r.cost;
  return r.got;
}

function shop(sim: Sim, h: Household): void {
  const s = sim.s, t = s.gov.taxes;
  let adults = 0, kids = 0;
  for (const id of h.members) { const c = sim.cit(id); if (!c) continue; if (sim.age(c) >= 12) adults++; else kids++; }
  if (!adults && !kids) return;
  const home = h.home >= 0 ? sim.bld(h.home) : undefined;
  const st = storesFor(sim, home);
  const needT = (7 * (adults * FOOD_NEED.adult + kids * FOOD_NEED.child)) / 1000;
  // grain from the ration shop covers part of the staples
  const rationKg = Math.min(h.ration, needT * 1000);
  h.ration -= rationKg;
  const foodT = needT - rationKg / 1000;
  const vegT = (7 * (adults * VEG_NEED.adult + kids * VEG_NEED.child)) / 1000;
  const pf = foodRetail(sim) * 1000, pv = vegRetail(sim) * 1000;
  const foodCost = (foodT * pf + vegT * pv) * (1 + t.foodSales);
  const frac = h.cash >= foodCost ? 1 : Math.max(0, h.cash / Math.max(1, foodCost));
  let gotF = buy(sim, h, st.grocery, 'food', foodT * frac, pf, 'foodTax', t.foodSales, 'food');
  let gotV = buy(sim, h, st.grocery, 'vegetables', vegT * frac, pv, 'foodTax', t.foodSales, 'food');
  // informal street vendors fill part of any gap at a premium (money leaves the formal economy)
  const gapF = foodT * frac - gotF, gapV = vegT * frac - gotV;
  if (gapF + gapV > 1e-6) {
    const inf = Math.min(h.cash, ((gapF * pf + gapV * pv) * 0.6) * 1.15);
    if (inf > 0) {
      sim.pay(h, s.ext, inf);
      h.m.food += inf;
      const share = inf / (((gapF * pf + gapV * pv) * 1.15) || 1);
      gotF += gapF * share; gotV += gapV * share;
    }
  }
  const wantKg = (needT + vegT) * 1000;
  const gotKg = (gotF + gotV) * 1000 + rationKg;
  h.foodSec = wantKg > 0 ? Math.min(1, gotKg / wantKg) : 1;
  s.stats.acc.foodWanted += wantKg;
  s.stats.acc.foodUnmet += Math.max(0, wantKg - gotKg);

  // discretionary spending. Households smooth consumption: they spend most of their usual disposable income and
  // steer their savings towards a buffer of about four months' income, drawing it down when they hold more.
  const income = Math.max(0, h.incAvg);
  const weekly = income / 4.33;
  const fixed = (h.rent + h.last.transport) / 4.33;
  const disposable = Math.max(0, weekly - foodCost - fixed);
  const buffer = Math.max(4 * income, 15_000 * sim.scale * s.ext.trend);
  const gap = h.cash - buffer;
  const adjust = gap > 0 ? gap * 0.015 : gap * 0.006;
  const spend = Math.max(0, Math.min(0.85 * disposable + adjust, h.cash * 0.4));
  if (spend <= 0) { goOut(sim, h, 0, st.cinema); return; }
  const rest = 1 - LEISURE_SHARE;
  const rich = income > t.topThreshold;
  const goodsRate = t.sales + (rich ? t.luxury : 0);
  const gp = goodsRetail(sim);
  const crates = (spend * 0.45 * rest) / (gp * (1 + goodsRate));
  if (crates > 0.01) {
    const got = buy(sim, h, st.shop, 'goods', crates, gp, 'salesTax', t.sales, 'goods');
    if (rich && got > 0) sim.tax('luxuryTax', h, got * gp * t.luxury);
  }
  const mp = mealPrice(sim);
  const meals = Math.floor((spend * 0.22 * rest) / (mp * (1 + t.sales)));
  if (meals > 0) h.m.services += serveMeals(sim, h, st.restaurant, meals, mp);
  const sp = servicePrice(sim);
  const jobs = Math.floor((spend * 0.33 * rest) / (sp * (1 + t.sales)));
  if (jobs > 0) h.m.services += serveServices(sim, h, st.services, jobs, sp);
  goOut(sim, h, spend * LEISURE_SHARE, st.cinema);
}

/** Local services (repairs, salons, rickshaws, guides) bought by `payer`. Returns the total paid. */
export function serveServices(sim: Sim, payer: Account, ids: number[], n: number, sp: number): number {
  const t = sim.s.gov.taxes;
  let need = n, paid = 0;
  let first: Business | undefined;
  for (const id of ids) {
    if (need <= 0) break;
    const b = sim.biz(id);
    if (!b || b.status !== 'operating' || b.downDays > 0) continue;
    first ??= b;
    const served = sim.ix.served.get(b.id) ?? 0;
    const q = Math.min(need, Math.floor((staffCapacity(sim, b) - served) / sp));
    if (q <= 0) continue;
    const value = q * sp;
    if (payer.cash < value * (1 + t.sales)) break;
    sim.pay(payer, b, value);
    sim.tax('salesTax', payer, value * t.sales);
    // parts, cosmetics and fuel are bought in from outside
    const supplies = value * SERVICE_SUPPLY_SHARE;
    sim.pay(b, sim.s.ext, supplies);
    b.m.cogs += supplies;
    b.m.revenue += value;
    b.m.sales += q;
    sim.ix.served.set(b.id, served + value);
    paid += value * (1 + t.sales);
    need -= q;
  }
  if (need > 0 && first) first.m.unmet += need * sp;
  return paid;
}

/** Restaurant meals bought by `payer`. Returns the total paid. */
export function serveMeals(sim: Sim, payer: Account, ids: number[], meals: number, mp: number): number {
  const t = sim.s.gov.taxes;
  let need = meals, paid = 0;
  let first: Business | undefined;
  for (const id of ids) {
    if (need <= 0) break;
    const b = sim.biz(id);
    if (!b || b.status !== 'operating' || b.downDays > 0) continue;
    first ??= b;
    const demandF = sim.s.weather.pandemic > 0 ? 0.5 : 1;
    const served = sim.ix.served.get(b.id) ?? 0;
    const capMeals = Math.floor((staffCapacity(sim, b) - served) / mp);
    const stockMeals = Math.floor(Math.min((b.inv.food ?? 0) / MEAL_INPUT.food, (b.inv.vegetables ?? 0) / MEAL_INPUT.vegetables));
    const q = Math.floor(Math.min(need * demandF, capMeals, stockMeals));
    if (q <= 0) continue;
    const value = q * mp;
    if (payer.cash < value * (1 + t.sales)) break;
    sim.pay(payer, b, value);
    sim.tax('salesTax', payer, value * t.sales);
    b.inv.food = (b.inv.food ?? 0) - q * MEAL_INPUT.food;
    b.inv.vegetables = (b.inv.vegetables ?? 0) - q * MEAL_INPUT.vegetables;
    recordSale(sim, b, 'food', q * MEAL_INPUT.food);
    recordSale(sim, b, 'vegetables', q * MEAL_INPUT.vegetables);
    // cooking gas, oil, electricity and packaging come from outside
    const supplies = q * MEAL_SUPPLIES * sim.scale * sim.s.ext.trend;
    sim.pay(b, sim.s.ext, supplies);
    b.m.cogs += supplies;
    b.m.revenue += value;
    b.m.sales += q;
    sim.ix.served.set(b.id, served + value);
    paid += value * (1 + t.sales);
    need -= q;
  }
  if (need > 0 && first) first.m.unmet += need * mp;
  return paid;
}

/** Folds today's sales into each store's running average (used for restocking). */
function foldSales(sim: Sim): void {
  for (const b of sim.s.businesses) {
    if (b.kind !== 'grocery' && b.kind !== 'shop' && b.kind !== 'restaurant') continue;
    const sold = sim.ix.sold.get(b.id);
    const goods: Good[] = b.kind === 'shop' ? ['goods'] : ['food', 'vegetables'];
    for (const g of goods) {
      const q = sold?.[g] ?? 0;
      b.ema[g] = b.ema[g] === undefined ? q : b.ema[g]! * 0.93 + q * 0.07;
    }
  }
  sim.ix.sold.clear();
  sim.ix.served.clear();
}

export function householdsDaily(sim: Sim): void {
  const dow = sim.day % 7;
  for (const h of sim.s.households) if (h.id % 7 === dow) shop(sim, h);
  foldSales(sim);
}

/** Pays rent to whoever owns the dwelling and records it as their income. */
function payRent(sim: Sim, h: Household, b: Building, amt: number): void {
  if (b.ownerT === 0) { sim.tax('rents', h, amt); return; }
  if (b.ownerT === 1) {
    const o = sim.hh(b.ownerId);
    if (o) { sim.pay(h, o, amt); o.m.dividends += amt; return; }
  } else if (b.ownerT === 2) {
    const o = sim.biz(b.ownerId);
    if (o) { sim.pay(h, o, amt); o.m.revenue += amt; return; }
  }
  sim.pay(h, sim.s.ext, amt);
}

export function householdsMonthly(sim: Sim): void {
  const s = sim.s;
  const nominal = sim.scale * s.ext.trend;
  const r = sim.rng;
  for (const h of [...s.households]) {
    // rent
    if (h.home >= 0 && !h.owns && h.rent > 0) {
      const b = sim.bld(h.home);
      if (b) {
        const amt = Math.min(h.rent, Math.max(0, h.cash));
        payRent(sim, h, b, amt);
        h.m.rent += amt;
        if (amt < h.rent * 0.98) h.rentArrears++; else h.rentArrears = 0;
      }
    }
    // commuting and personal travel
    let litres = 0, fares = 0;
    for (const id of h.members) {
      const c = sim.cit(id);
      if (!c) continue;
      if (c.mode === 3) litres += c.commuteKm * 2 * 22 * 0.075;
      else if (c.mode === 2) litres += c.commuteKm * 2 * 22 * 0.025;
      else if (c.mode === 4) fares += 44 * 15 * nominal;
    }
    if (h.car) litres += 35;
    if (h.bike) litres += 10;
    const affordable = Math.max(0, h.cash) / Math.max(1, sim.fuelPrice());
    litres = Math.min(litres, affordable);
    h.m.transport += buyFuel(sim, h, litres);
    if (fares > 0 && s.gov.policies.busService > 0) {
      const f = Math.min(fares, Math.max(0, h.cash));
      sim.tax('fares', h, f);
      h.m.transport += f;
    }
    // vehicle purchases as incomes rise
    const income = hhIncome(h);
    const carPrice = 650_000 * nominal, bikePrice = 85_000 * nominal;
    if (!h.car && income > 45_000 * nominal && h.cash > carPrice * 0.5 && r.chance(0.02)) {
      const tax = carPrice * s.gov.taxes.sales;
      sim.pay(h, s.ext, carPrice);
      sim.tax('salesTax', h, tax);
      h.m.other += carPrice + tax;
      h.car = true;
    } else if (!h.bike && income > 15_000 * nominal && h.cash > bikePrice && r.chance(0.02)) {
      sim.pay(h, s.ext, bikePrice);
      sim.tax('salesTax', h, bikePrice * s.gov.taxes.sales);
      h.m.other += bikePrice;
      h.bike = true;
    }
    const net = h.m.wages + h.m.benefits + h.m.dividends - h.m.taxes;
    h.incAvg = h.incAvg * 0.8 + Math.max(0, net) * 0.2;
    h.last = h.m;
    h.m = emptyHhLedger();
  }
}
