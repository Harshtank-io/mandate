// Farms: crop choice, field work, soil water, growth, stress, harvest and crop insurance.
// Every harvest outcome can be traced to weather, water, inputs, labour and prices.

import type { Sim } from '../core';
import { buyFuel, casualWage, hireCasual } from '../econ';
import { CROPS, cropTempFactor } from '../tables';
import type { Business, CropId } from '../types';
import { mspPrice } from './food';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function agricultureDaily(sim: Sim): void {
  const flood = sim.s.weather.flood === 0;
  for (const b of sim.s.businesses) if (b.farm && b.status === 'operating') farmDay(sim, b, flood);
}

function laborOf(sim: Sim, b: Business): number {
  let labor = 0;
  // the owner's family works the farm alongside any hired hands
  const owner = b.owner >= 0 ? sim.cit(b.owner) : undefined;
  const hh = owner ? sim.hh(owner.hh) : undefined;
  if (hh) {
    for (const id of hh.members) {
      const c = sim.cit(id);
      if (c && c.employer === b.id && c.status === 'owner' && c.injured <= 0 && sim.age(c) < 78) labor += 0.6 + 0.4 * c.health;
    }
  }
  for (const j of b.jobs) if (j.worker >= 0) { const c = sim.cit(j.worker); if (c && c.injured <= 0) labor += 0.6 + 0.4 * c.health; }
  if (sim.s.weather.pandemic > 0) labor *= 0.8;
  return labor;
}

function addLoss(b: Business, cause: string, v: number) {
  const f = b.farm!;
  f.losses[cause] = (f.losses[cause] ?? 0) + v;
}

function farmDay(sim: Sim, b: Business, flood: boolean): void {
  const f = b.farm!, w = sim.s.weather;
  f.phaseDays++;
  f.waterToday = 0;
  const spec = f.crop ? CROPS[f.crop] : null;
  const workDay = sim.isWorkDay() && w.rain < 30 && w.flood > 1;
  const labor = workDay ? laborOf(sim, b) : 0;

  // soil water balance (moisture 1.0 ~ 100 mm plant-available water)
  const et = Math.max(1, 1.2 + 0.13 * w.temp);
  let demand = 0.35 * et;
  if (spec && (f.phase === 'growing' || f.phase === 'ready')) {
    const stage = f.growth < 0.2 ? 0.55 : f.growth < 0.75 ? 1.1 : 0.75;
    demand = spec.water * (et / 5) * stage;
  }
  let mm = f.moisture * 100 + w.rain - demand;
  if (spec && f.phase === 'growing' && f.irrigation > 0 && mm < 55) {
    let avail = f.irrigation * 14;
    if (w.drought) avail *= f.well ? 0.7 : 0.45;
    if (!f.well) avail *= Math.min(1, 0.4 + 0.6 * sim.s.gov.deptFunding.agriculture);
    const apply = Math.min(avail, 75 - mm);
    if (apply > 0) {
      mm += apply;
      f.waterToday = apply * f.ha * 10_000;
      if (f.well) {
        const cost = buyFuel(sim, b, apply * f.ha * 0.3);
        b.m.cogs += cost; f.seasonCost += cost;
      } else {
        const fee = apply * f.ha * 4 * sim.scale * sim.s.ext.trend;
        sim.tax('other', b, fee);
        b.m.cogs += fee; f.seasonCost += fee;
      }
    }
  }
  f.moisture = clamp(mm / 100, 0, 1.3);

  switch (f.phase) {
    case 'fallow':
      if (f.phaseDays % 3 === 0) planCrop(sim, b);
      break;
    case 'preparing':
    case 'sowing': {
      const need = (f.phase === 'preparing' ? spec!.prep : spec!.sow) * f.ha;
      if (workDay) {
        const gap = need - f.work - labor;
        const casual = gap > 0 ? hireCasual(sim, b, Math.ceil(Math.min(gap, f.ha * 4))) : 0;
        f.work += labor + casual;
        if (casual) f.seasonCost += casual * casualWage(sim);
      }
      if (f.work >= need) {
        if (f.phase === 'preparing') {
          const fuel = buyFuel(sim, b, 7 * f.ha);
          b.m.cogs += fuel; f.seasonCost += fuel;
          startSowing(sim, b);
        } else {
          f.phase = 'growing'; f.phaseDays = 0; f.growth = 0; f.health = 1; f.work = 0;
        }
      } else if (f.phaseDays > 45) {
        f.phase = 'fallow'; f.crop = null; f.phaseDays = 0; f.work = 0;
        f.plan = 'Season abandoned: not enough labour to prepare and sow the fields in time';
      }
      break;
    }
    case 'growing': {
      const s = spec!;
      const tf = cropTempFactor(s, w.temp);
      const waterF = f.moisture >= 0.35 ? 1 : f.moisture / 0.35;
      f.growth += (tf * (0.45 + 0.55 * waterF)) / s.days;
      let dmg = 0;
      if (f.moisture < 0.3) {
        // yield falls roughly in proportion to the season's water deficit; ripening crops need less
        const d = (1.3 / s.days) * ((0.3 - f.moisture) / 0.3) * (f.crop === 'rice' ? 1.4 : 1) * (f.growth > 0.8 ? 0.5 : 1);
        // losses during a declared drought are an insured peril; ordinary dry spells are the farmer's risk
        dmg += d; addLoss(b, w.drought ? 'drought' : 'water', d);
      }
      if (f.moisture > 1.05 && f.crop !== 'rice') { dmg += 0.008; addLoss(b, 'flood', 0.008); }
      if (w.temp > s.tmax) { const d = 0.01 * (w.temp - s.tmax); dmg += d; addLoss(b, w.heatDays >= 3 ? 'heatwave' : 'heat', d); }
      if (w.temp < s.tmin - 4) { dmg += 0.004; addLoss(b, 'cold', 0.004); }
      if (f.disease > 0) { f.disease--; dmg += 0.009; addLoss(b, 'disease', 0.009); }
      if (flood && f.lowland) { const d = f.crop === 'rice' ? 0.15 : 0.35; dmg += d; addLoss(b, 'flood', d); }
      if (workDay && labor < f.ha * 0.05) { dmg += 0.0015; addLoss(b, 'labour', 0.0015); }
      if (dmg > 0.004) f.stressDays++;
      f.health = clamp(f.health - dmg + (dmg === 0 ? 0.0012 : 0), 0.02, 1);
      if (f.growth >= 1) { f.growth = 1; f.phase = 'ready'; f.phaseDays = 0; }
      f.expected = expectedYield(sim, b);
      break;
    }
    case 'ready':
      f.health = Math.max(0.02, f.health - 0.003);
      addLoss(b, 'labour', 0.003);
      f.expected = expectedYield(sim, b);
      if (workDay) { f.phase = 'harvesting'; f.phaseDays = 0; f.work = 0; f.harvested = 0; }
      break;
    case 'harvesting': {
      const s = spec!;
      const need = s.harvest * f.ha;
      if (workDay) {
        const gap = need - f.work - labor;
        const casual = gap > 0 ? hireCasual(sim, b, Math.ceil(Math.min(gap, f.ha * 5))) : 0;
        f.work += labor + casual;
        if (casual) f.seasonCost += casual * casualWage(sim);
        const fuel = buyFuel(sim, b, 0.9 * f.ha);
        b.m.cogs += fuel; f.seasonCost += fuel;
      } else if (w.rain > 30) { f.health = Math.max(0.02, f.health - 0.004); addLoss(b, 'flood', 0.004); }
      const frac = Math.min(1, f.work / need);
      const target = f.expected * frac;
      const delta = target - f.harvested;
      if (delta > 0) {
        b.inv[s.good] = (b.inv[s.good] ?? 0) + delta;
        f.harvested = target;
        b.m.production += delta;
      }
      if (frac >= 1 || f.phaseDays > 60) finishHarvest(sim, b);
      break;
    }
  }
}

function fieldFertility(sim: Sim, b: Business): number {
  const f = b.farm!;
  let s = 0;
  for (const t of f.fields) s += sim.s.map.fertility[t];
  return f.fields.length ? s / f.fields.length : 0.6;
}

export function expectedYield(sim: Sim, b: Business): number {
  const f = b.farm!;
  if (!f.crop) return 0;
  const s = CROPS[f.crop];
  const ext = 0.95 + 0.05 * Math.min(1, sim.s.gov.deptFunding.agriculture);
  return f.ha * s.yield * f.health * (0.6 + 0.4 * f.fertilizer) * (0.7 + 0.3 * fieldFertility(sim, b)) * ext;
}

function normalYield(sim: Sim, b: Business): number {
  const f = b.farm!;
  if (!f.crop) return 0;
  return f.ha * CROPS[f.crop].yield * (0.6 + 0.4 * f.fertilizer) * (0.7 + 0.3 * fieldFertility(sim, b));
}

function startSowing(sim: Sim, b: Business): void {
  const f = b.farm!, s = CROPS[f.crop!];
  const pol = sim.s.gov.policies;
  const seed = s.seed * f.ha * sim.scale * sim.s.ext.trend;
  const fertFull = s.fert * f.ha * sim.scale * sim.s.ext.trend;
  const farmShare = 1 - pol.fertilizerSubsidy;
  // the farmer buys a full dose if the budget allows, borrowing from outside lenders if needed
  let dose = 1;
  const need = seed + fertFull * farmShare;
  if (b.cash < need) {
    const loanRoom = Math.max(0, f.ha * 60_000 * sim.scale * sim.s.ext.trend - b.loan);
    const borrow = Math.min(loanRoom, need - b.cash + 1);
    if (borrow > 0) { sim.pay(sim.s.ext, b, borrow); b.loan += borrow; }
    if (b.cash < need) dose = clamp((b.cash - seed) / Math.max(1, fertFull * farmShare), 0, 1);
  }
  sim.pay(b, sim.s.ext, seed);
  const fertCost = fertFull * dose;
  sim.pay(b, sim.s.ext, fertCost * farmShare);
  if (pol.fertilizerSubsidy > 0 && fertCost > 0) sim.spend('fertilizer', sim.s.ext, fertCost * pol.fertilizerSubsidy);
  f.fertilizer = dose;
  b.m.cogs += seed + fertCost * farmShare;
  f.seasonCost += seed + fertCost * farmShare;
  f.insured = false;
  if (pol.cropInsurance) {
    const value = normalYield(sim, b) * sim.s.market[s.good].price;
    f.premium = value * 0.02;
    sim.tax('premiums', b, f.premium);
    b.m.other += f.premium;
    f.insured = true;
  }
  f.phase = 'sowing';
  f.phaseDays = 0;
  f.work = 0;
}

function finishHarvest(sim: Sim, b: Business): void {
  const f = b.farm!, crop = f.crop!, s = CROPS[crop];
  const acc = sim.s.stats.acc;
  const t = f.harvested;
  const normal = normalYield(sim, b);
  f.lastHarvest = { crop, t, day: sim.day, health: f.health };
  acc.harvest[crop] = (acc.harvest[crop] ?? 0) + t;
  sim.s.stats.cumHarvest[crop] = (sim.s.stats.cumHarvest[crop] ?? 0) + t;
  acc.harvestNormal[crop] = (acc.harvestNormal[crop] ?? 0) + normal;
  const totalLoss = Object.values(f.losses).reduce((a, x) => a + x, 0);
  const lost = Math.max(0, normal - t);
  if (totalLoss > 0) for (const [cause, v] of Object.entries(f.losses)) acc.harvestLoss[cause] = (acc.harvestLoss[cause] ?? 0) + (lost * v) / totalLoss;
  if (f.insured && sim.s.gov.policies.cropInsurance) {
    // covers losses from weather and disease beyond a 20% deductible, at 70% of their value
    const peril = ['drought', 'flood', 'heatwave', 'disease'].reduce((a, k) => a + (f.losses[k] ?? 0), 0);
    const claim = Math.max(0, Math.min(1, peril) - 0.2) * 0.7;
    if (claim > 0) {
      const payout = claim * normal * sim.s.market[s.good].price;
      sim.spend('insurance', b, payout);
      b.m.other -= payout;
    }
  }
  f.phase = 'fallow';
  f.phaseDays = 0;
  f.crop = null;
  f.growth = 0;
  f.work = 0;
  f.harvested = 0;
  f.insured = false;
  f.losses = {};
  f.stressDays = 0;
  f.seasonCost = 0;
  f.seasonRevenue = 0;
}

function avgPrice(sim: Sim, good: string): number {
  const m = sim.s.market[good as keyof typeof sim.s.market];
  const h = m.hist.slice(-30);
  return h.length ? h.reduce((a, x) => a + x, 0) / h.length : m.price;
}

function planCrop(sim: Sim, b: Business): void {
  const f = b.farm!, p = sim.preset, d = sim.date, r = sim.rng;
  const pol = sim.s.gov.policies;
  const fert = fieldFertility(sim, b);
  const cw = casualWage(sim);
  const nominal = sim.scale * sim.s.ext.trend;
  let best: { crop: CropId; score: number; profit: number; expHealth: number } | null = null;
  for (const [crop, windows] of Object.entries(p.crops) as [CropId, [number, number][]][]) {
    const s = CROPS[crop];
    let open = false;
    for (const [a, z] of windows) {
      const len = z - a;
      if (len >= 300) { open = true; break; }
      if (mod(d.doy - a, 365) <= len - 5 || mod(a - d.doy, 365) <= 12) { open = true; break; }
    }
    if (!open) continue;
    const months = Math.max(1, Math.ceil(s.days / 30));
    let rainExp = 0, tf = 0;
    for (let k = 0; k < months; k++) {
      rainExp += p.climate.rain[(d.month + k) % 12];
      tf += cropTempFactor(s, p.climate.temp[(d.month + k) % 12]);
    }
    tf /= months;
    if (tf < 0.35) continue;
    const needMm = s.water * s.days * 0.8;
    const supply = rainExp * 0.75 + f.irrigation * needMm * (sim.s.weather.drought ? 0.6 : 1);
    const waterRatio = Math.min(1, supply / needMm);
    const expHealth = 0.05 + 0.95 * Math.pow(waterRatio, 1.3);
    const price = Math.max(avgPrice(sim, s.good), mspPrice(sim, s.good));
    const yieldT = s.yield * expHealth * (0.7 + 0.3 * fert) * f.ha;
    const cost = ((s.seed + s.fert * (1 - pol.fertilizerSubsidy)) * nominal + (s.prep + s.sow + s.harvest) * cw * 0.6) * f.ha;
    const profit = yieldT * price - cost;
    const score = profit * (p.cropBias[crop] ?? 1) * (0.85 + 0.3 * r.next());
    if (!best || score > best.score) best = { crop, score, profit, expHealth };
  }
  if (!best || best.profit <= 0) {
    if (f.phaseDays > 30) f.plan = best ? 'Waiting: no crop is expected to cover its costs at current prices' : 'Waiting for the next sowing season';
    return;
  }
  const s = CROPS[best.crop];
  f.crop = best.crop;
  f.phase = 'preparing';
  f.phaseDays = 0;
  f.work = 0;
  f.losses = {};
  f.seasonCost = 0;
  f.seasonRevenue = 0;
  f.health = 1;
  f.growth = 0;
  const water = f.irrigation > 0.5 ? 'irrigated' : best.expHealth > 0.8 ? 'rain-fed, good rains expected' : 'rain-fed, water will be tight';
  f.plan = `Chose ${s.label.toLowerCase()}: best expected return at recent market prices (${water})`;
}
