// Monthly statistics. Every number here is computed from the simulated entities, never generated.

import { dateOf } from '../calendar';
import { emptyAcc, sumExp, sumRev, type Sim } from '../core';
import { foodRetail, goodsRetail, hhIncome, mealPrice, vegRetail } from '../econ';
import { GOODS, Terrain, type MonthStats } from '../types';
import { envAt } from './environment';
import { roadStats } from './transport';

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function lifeExpectancy(sim: Sim, health: number): number {
  const p = sim.preset;
  const hc = sim.s.services.health;
  let S = 1, le = 0;
  for (let a = 0; a < 110; a++) {
    let m = 0.0006 + 0.00004 * Math.exp(0.093 * a);
    if (a < 1) m += 0.02 * (1.25 - 0.5 * hc);
    m *= p.mortality * (1 + 2.2 * Math.max(0, 0.75 - health));
    le += S * (1 - m / 2);
    S *= 1 - Math.min(1, m);
  }
  return le;
}

export function basketCost(sim: Sim): number {
  const s = sim.s;
  let rent = 0, n = 0;
  for (const h of s.households) if (!h.owns && h.rent > 0) { rent += h.rent; n++; }
  const avgRent = n ? rent / n : 0;
  return foodRetail(sim) * 60 + vegRetail(sim) * 35 + goodsRetail(sim) * 4 + mealPrice(sim) * 8 + avgRent * 0.9 + sim.fuelPrice() * 30;
}

export function statsMonthly(sim: Sim): void {
  const s = sim.s, acc = s.stats.acc, g = s.gov, u = s.util;
  let children = 0, students = 0, working = 0, unemployed = 0, retired = 0, wageSum = 0, wageN = 0, healthSum = 0, satSum = 0, adults = 0;
  let kids = 0, enrolled = 0, lit = 0, adults15 = 0, tert = 0, adults25 = 0, pollution = 0, homed = 0;
  for (const c of s.citizens) {
    const age = sim.age(c);
    healthSum += c.health;
    if (c.status === 'child') children++;
    else if (c.status === 'student') students++;
    else if (c.status === 'working' || c.status === 'owner') { working++; if (c.wage > 0) { wageSum += c.wage; wageN++; } }
    else if (c.status === 'unemployed') unemployed++;
    else if (c.status === 'retired') retired++;
    if (age >= 6 && age < 18) { kids++; if (c.school >= 0) enrolled++; }
    if (age >= 15) { adults15++; if (c.edu >= 1 || c.schoolYears >= 4) lit++; }
    if (age >= 25) { adults25++; if (c.edu >= 3) tert++; }
    if (age >= 16) { satSum += c.sat; adults++; }
    const home = sim.homeOf(c);
    if (home) { pollution += envAt(sim, home.x, home.y); homed++; }
  }
  const laborForce = working + unemployed;
  const incomes = s.households.map((h) => hhIncome(h));
  let units = 0, occ = 0, rentSum = 0, renters = 0;
  const burdens: number[] = [];
  for (const b of s.buildings) if (b.units > 0 && b.kind !== 'farmhouse') { units += b.units; occ += Math.min(b.units, b.occupants.length); }
  for (const h of s.households) {
    if (h.home >= 0 && !h.owns && h.rent > 0) {
      rentSum += h.rent; renters++;
      const inc = hhIncome(h);
      if (inc > 0) burdens.push(h.rent / inc);
    }
  }
  let va = 0, jobs = 0, vacancies = 0, businesses = 0, services = 0;
  for (const b of s.businesses) {
    for (const j of b.jobs) { jobs++; if (j.worker < 0) vacancies++; }
    if (b.pub) { va += b.m.wages; continue; }
    if (b.status === 'operating') businesses++;
    va += b.last.revenue - b.last.cogs;
    if (b.kind === 'office') services += b.last.revenue;
  }
  const basket = basketCost(sim);
  const months = s.stats.months;
  const base = months.length ? months[0].basket : basket;
  const cpi = (100 * basket) / Math.max(1e-9, base);
  const prev12 = months.length >= 12 ? months[months.length - 12] : months[0];
  const inflation = prev12 && months.length >= 3 ? Math.pow(cpi / prev12.cpi, 12 / Math.max(1, Math.min(12, months.length - months.indexOf(prev12)))) - 1 : 0;
  const T = s.tourism.m;
  // visitor spending is an export of services: money earned from outside the city
  let exportsV = services + T.spend, importsV = acc.fuelLitres * s.ext.fuel;
  for (const gd of GOODS) { exportsV += s.market[gd].exportValue; importsV += s.market[gd].importValue; }
  let rooms = 0, roomNights = 0;
  for (const b of s.businesses) if (b.hotel && b.status === 'operating') { rooms += b.hotel.rooms; roomNights += b.hotel.nights; }
  let land = 0, green = 0;
  for (let i = 0; i < s.map.terrain.length; i++) {
    const t = s.map.terrain[i];
    if (t === Terrain.Water || t === Terrain.Canal) continue;
    land++;
    if (t === Terrain.Forest || s.map.zone[i] === 5) green++;
  }
  const rs = roadStats(sim);
  const health = s.citizens.length ? healthSum / s.citizens.length : 0.7;
  const harvest = Object.values(acc.harvest).reduce((a, x) => a + x, 0);
  const cov = (arr: number[]) => {
    let w = 0, t = 0;
    for (const h of s.households) { const b = h.home >= 0 ? sim.bld(h.home) : undefined; if (!b) continue; const k = Math.min(15, b.y >> 3) * 16 + Math.min(15, b.x >> 3); w += arr[k] * h.members.length; t += h.members.length; }
    return t ? w / t : 0;
  };
  const st: MonthStats = {
    day: sim.day, year: sim.date.year, month: sim.date.month,
    population: s.citizens.length, households: s.households.length, births: acc.births, deaths: acc.deaths, immigrants: acc.immigrants, emigrants: acc.emigrants,
    children, working, unemployed, retired, students, laborForce, unemployment: laborForce ? unemployed / laborForce : 0,
    avgWage: wageN ? wageSum / wageN : 0, medianIncome: median(incomes),
    gdp: va, cpi, inflation, foodPrice: foodRetail(sim),
    revenue: sumRev(g.m), spending: sumExp(g.m), balance: sumRev(g.m) - sumExp(g.m), debt: g.debt, treasury: g.cash,
    businesses, opened: acc.opened, closed: acc.closed, jobs, vacancies,
    units, vacantUnits: units - occ, homeless: s.households.filter((h) => h.home < 0).length, avgRent: renters ? rentSum / renters : 0,
    rentIndex: s.housing.rentIndex, rentBurden: median(burdens),
    commute: s.traffic.avgCommute, congestion: s.traffic.congestion, crime: s.services.crime, health, lifeExp: lifeExpectancy(sim, health),
    enrollment: kids ? enrolled / kids : 1, literacy: adults15 ? lit / adults15 : 0, tertiary: adults25 ? tert / adults25 : 0,
    pollution: homed ? pollution / homed : 0, co2: s.env.co2, green: land ? green / land : 0, water: s.env.water,
    satisfaction: adults ? satSum / adults : 0.5, approval: g.approval,
    farmOutput: harvest, cropOutput: { ...acc.harvest },
    exports: exportsV, imports: importsV, foodInsecure: s.households.length ? s.households.filter((h) => h.foodSec < 0.85).length / s.households.length : 0,
    healthCoverage: cov(s.services.healthCov), schoolCoverage: cov(s.services.schoolCov), policeCoverage: cov(s.services.policeCov),
    basket, roadKm: rs.km, poorRoads: rs.poor,
    leisure: s.leisure.avg,
    tourists: T.domestic + T.foreign, foreignTourists: T.foreign, touristNights: T.nights, tourismSpend: T.spend, turnedAway: T.turned,
    hotelRooms: rooms, occupancy: rooms > 0 ? roomNights / (rooms * dateOf(s.meta.startYear, sim.day - 1).daysInMonth) : 0, appeal: s.tourism.appeal,
    passengers: s.air.m.pax, flights: s.air.m.flights,
    tradeBalance: exportsV - importsV, fx: s.trade.fx,
    // the food programmes close their month before the statistics are taken (see MONTHLY), so read last month's figures
    procured: s.pds.lastProcured, grainStock: s.pds.stock, rationed: s.pds.lastRationed,
    // utilities close their month after the statistics, so this is the month that just ended
    powerPeak: u.peak, powerCap: u.cap,
    powerServed: u.m.kwh + u.m.short > 0 ? u.m.kwh / (u.m.kwh + u.m.short) : 1,
    waterServed: u.m.water + u.m.waterShort > 0 ? u.m.water / (u.m.water + u.m.waterShort) : 1,
    waterUse: u.waterUse, waterCap: u.waterCap, blackouts: u.m.blackouts,
    fires: acc.fires, burned: acc.burned, fireCoverage: cov(s.services.fireCov),
  };
  months.push(st);
  if (months.length > 600) months.splice(1, months.length - 600);
  s.stats.acc = emptyAcc();
}
