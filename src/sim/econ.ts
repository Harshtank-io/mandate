// Shared economic helpers: taxes on wages, retail prices, casual day labour.

import type { Account, Sim } from './core';
import { MEAL_PRICE, SERVICE_PRICE } from './tables';
import type { Business, Citizen, ExpCat } from './types';

export function incomeTax(sim: Sim, gross: number): number {
  const t = sim.s.gov.taxes;
  const basic = Math.max(0, Math.min(gross, t.topThreshold) - t.allowance) * t.income;
  const top = Math.max(0, gross - Math.max(t.topThreshold, t.allowance)) * t.incomeTop;
  return (basic + top) * sim.s.gov.compliance;
}

/** Pays a gross wage (from a business or from a government department) and withholds income tax. */
export function payWage(sim: Sim, payer: Account | null, c: Citizen, gross: number, dept?: ExpCat): number {
  const h = sim.hh(c.hh);
  if (!h || gross <= 0) return 0;
  if (dept) sim.spend(dept, h, gross);
  else if (payer) sim.pay(payer, h, gross);
  const tax = incomeTax(sim, gross);
  sim.tax('incomeTax', h, tax);
  h.m.wages += gross;
  h.m.taxes += tax;
  return gross;
}

export const MARKUP = { food: 1.25, vegetables: 1.35, goods: 1.22 };

/** Retail price per kg of staples. */
export function foodRetail(sim: Sim): number { return (sim.s.market.food.price * MARKUP.food) / 1000; }
export function vegRetail(sim: Sim): number { return (sim.s.market.vegetables.price * MARKUP.vegetables) / 1000; }
export function goodsRetail(sim: Sim): number { return sim.s.market.goods.price * MARKUP.goods; }
export function mealPrice(sim: Sim): number {
  const inputs = sim.s.market.food.price * 0.00025 + sim.s.market.vegetables.price * 0.00015;
  return MEAL_PRICE * sim.scale * sim.s.ext.trend * (0.75 + 0.25 * sim.s.labor.wage[1]) + inputs;
}

export function servicePrice(sim: Sim): number {
  return SERVICE_PRICE * sim.scale * sim.s.ext.trend * (0.7 + 0.3 * sim.s.labor.wage[0]);
}

export function casualWage(sim: Sim): number { return (sim.roleWage('farmhand') / 26) * 1.1; }

const firmCache = new WeakMap<Sim, { day: number; firms: Business[] }>();

/**
 * Upkeep and repair work is contracted to local construction companies: labour and margins stay in town,
 * materials (35%) are bought from outside. Without a local contractor the money leaves the city.
 */
export function maintenanceWork(sim: Sim, payer: Account, amount: number, dept?: ExpCat): void {
  if (!(amount > 0)) return;
  const s = sim.s;
  let c = firmCache.get(sim);
  if (!c || c.day !== sim.day) {
    c = { day: sim.day, firms: s.businesses.filter((b) => b.kind === 'construction' && b.status === 'operating') };
    firmCache.set(sim, c);
  }
  const firms = c.firms.filter((b) => b.status === 'operating');
  if (!firms.length) {
    if (dept) sim.spend(dept, s.ext, amount); else sim.pay(payer, s.ext, amount);
    return;
  }
  let total = 0;
  const crews = firms.map((b) => { let n = 0; for (const j of b.jobs) if (j.worker >= 0) n++; total += n; return n; });
  const plant = s.businesses.find((b) => b.kind === 'materials' && b.status === 'operating' && (b.inv.materials ?? 0) > 5);
  firms.forEach((b, k) => {
    const amt = amount * (total > 0 ? crews[k] / total : 1 / firms.length);
    if (dept) sim.spend(dept, b, amt); else sim.pay(payer, b, amt);
    b.m.revenue += amt;
    const mat = amt * 0.35;
    // repair materials come from the local plant when it has stock
    const qty = mat / s.market.materials.price;
    if (plant && (plant.inv.materials ?? 0) >= qty) {
      sim.pay(b, plant, mat);
      plant.inv.materials! -= qty;
      plant.m.revenue += mat;
      plant.m.sales += qty;
      s.market.materials.local += qty;
    } else sim.pay(b, s.ext, mat);
    b.m.cogs += mat;
  });
}

/** Buys fuel: the base price leaves the city, the fuel tax goes to the government. Returns total cost. */
export function buyFuel(sim: Sim, payer: Account, litres: number): number {
  if (litres <= 0) return 0;
  const base = sim.s.ext.fuel * litres;
  sim.pay(payer, sim.s.ext, base);
  const tax = sim.tax('fuelTax', payer, base * sim.s.gov.taxes.fuel);
  sim.s.stats.acc.fuelLitres += litres;
  return base + tax;
}

/**
 * Hires casual day labour from the pool of unemployed/inactive residents. Each worker-day is paid to a
 * real household, so harvest seasons and building booms raise informal incomes. Returns worker-days obtained.
 */
export function hireCasual(sim: Sim, payer: Business, wanted: number): number {
  const ix = sim.ix;
  const cap = Math.floor(ix.casualPool.length * 0.6);
  let got = 0;
  const wage = casualWage(sim);
  while (got < wanted && ix.casualUsed < cap) {
    const c = sim.cit(ix.casualPool[ix.casualUsed++]);
    if (!c) continue;
    const h = sim.hh(c.hh);
    if (!h) continue;
    sim.pay(payer, h, wage);
    h.m.wages += wage;
    payer.m.wages += wage;
    got++;
  }
  return got;
}

/** Monthly household income used for budgeting. */
export function hhIncome(h: { last: { wages: number; benefits: number; dividends: number; taxes: number } }): number {
  return h.last.wages + h.last.benefits + h.last.dividends - h.last.taxes;
}
