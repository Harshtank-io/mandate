// Electricity and water. Power lines and water mains run along the roads, so a building is served by whatever sources
// its road network connects to. The regional grid feeds every network that reaches the highway at the edge of the
// region; local plants and waterworks feed the network they stand on. When an area's evening peak exceeds what its
// sources can deliver it gets rolling blackouts; where the mains run dry or do not reach, families buy water from
// wells and tankers. Homes and businesses are billed for what they use (homes at half the business rate) and the city
// pays the grid and its gas suppliers for every kWh it buys.

import { idx, inMap, W, type Sim } from '../core';
import { emptyUtilityLedger } from '../init';
import { businessName } from '../names';
import {
  BASE_KWH, BUILDINGS, BUSINESSES, GAS_FUEL, GRID_PRICE, HOME_KWH, HOME_WATER, MEALS_PER_STAFF, PEAK_FACTOR, PLANTS, POWER_TARIFF, PUMP_KWH, ROLES,
  STREETLIGHT_KWH, SUBSTATION_MW, USE_KWH, WATER_TARIFF, WATERWORKS_M3, WELL_WATER,
} from '../tables';
import { RoadClass, Terrain, Zone, type Building, type BuildingKind, type Business } from '../types';
import { fmtMoney } from './construction';
import { FOOD_PLANT_RATE } from './market';
import { facilityQuality } from './services';

const nominalOf = (sim: Sim) => sim.scale * sim.s.ext.trend;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Water a business uses per member of staff a day (m3): washrooms, cleaning, canteens. */
const STAFF_WATER = 0.05;
/** Kilograms of CO2 per kWh from the gas plant. */
const GAS_CO2 = 0.45;

// ------------------------------------------------------------------------------------------------ prices

/** Electricity tariffs per kWh. */
export function homeTariff(sim: Sim): number { return POWER_TARIFF.home * nominalOf(sim) * sim.s.gov.taxes.power; }
export function bizTariff(sim: Sim): number { return POWER_TARIFF.business * nominalOf(sim) * sim.s.gov.taxes.power; }
/** Water tariff per m3. */
export function waterTariff(sim: Sim): number { return WATER_TARIFF * nominalOf(sim) * sim.s.gov.taxes.water; }
/** What the regional grid charges per kWh. */
export function gridPrice(sim: Sim): number { return GRID_PRICE * nominalOf(sim); }
/** Gas burned per kWh generated: it follows world oil prices and the exchange rate. */
export function gasPrice(sim: Sim): number { return GAS_FUEL * nominalOf(sim) * (sim.s.ext.fuel / (60 * nominalOf(sim))); }

/** Bills a business for electricity it used producing or serving, at the business tariff. Returns the amount billed. */
export function powerBill(sim: Sim, b: Business, kwh: number): number {
  if (!(kwh > 0)) return 0;
  const amt = kwh * bizTariff(sim);
  if (!(amt > 0)) return 0;
  sim.tax('utilityBills', b, amt);
  sim.s.util.m.bills += amt;
  return amt;
}

/** Share of a building's electricity demand that was met yesterday. */
export const powered = (b: Building | undefined) => b?.pw ?? 1;
/** Share of a building's water that came from the mains yesterday. */
export const watered = (b: Building | undefined) => b?.wt ?? 1;

// ------------------------------------------------------------------------------------------------ networks

export interface Net {
  /** Network number of each road tile (-1 = not a road). */
  comp: Int32Array;
  count: number;
  /** Whether each network reaches the regional grid (the highway at the edge of the region). */
  grid: boolean[];
  /** Road tiles in each network. */
  tiles: number[];
}

const nets = new WeakMap<Sim, { ver: number; net: Net }>();

/** Road networks: tiles joined by roads share power lines and water mains. Cached until the roads change. */
export function network(sim: Sim): Net {
  const cached = nets.get(sim);
  if (cached && cached.ver === sim.ix.ver.roads) return cached.net;
  const m = sim.s.map;
  const comp = new Int32Array(W * W).fill(-1);
  const grid: boolean[] = [], tiles: number[] = [];
  let count = 0;
  const q: number[] = [];
  for (let i = 0; i < W * W; i++) {
    if (!m.road[i] || comp[i] >= 0) continue;
    let onGrid = false, n = 0;
    comp[i] = count;
    q.push(i);
    while (q.length) {
      const t = q.pop()!;
      n++;
      const x = t % W, y = (t / W) | 0;
      if (m.road[t] === RoadClass.Highway && (x === 0 || y === 0 || x === W - 1 || y === W - 1)) onGrid = true;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) continue;
        const j = idx(nx, ny);
        if (m.road[j] && comp[j] < 0) { comp[j] = count; q.push(j); }
      }
    }
    grid.push(onGrid);
    tiles.push(n);
    count++;
  }
  const net = { comp, count, grid, tiles };
  nets.set(sim, { ver: sim.ix.ver.roads, net });
  return net;
}

/** The network a building is connected to through its access road, or any road along its edge (-1 = none). */
export function networkOf(sim: Sim, net: Net, b: Building): number {
  const m = sim.s.map;
  if (b.access >= 0 && m.road[b.access]) return net.comp[b.access];
  for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) {
    if (!inMap(x, y) || (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)) continue;
    const t = idx(x, y);
    if (m.road[t]) return net.comp[t];
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------ demand

function staffOf(b: Business): number {
  let n = b.owner >= 0 ? 1 : 0;
  for (const j of b.jobs) if (j.worker >= 0) n++;
  return n;
}

/**
 * Average daily activity: crates, tonnes, staff-days, meals or services, from this month's books (last month's on the
 * first). A business with no books yet is expected to work at about half its staff's capacity.
 */
function dailyActivity(sim: Sim, b: Business, what: 'production' | 'sales'): number {
  const dom = sim.date.dom;
  const books = dom > 1 && b.m[what] > 0 ? b.m[what] / (dom - 1) : b.last[what] / 30;
  if (books > 0) return books;
  let ops = 0, staff = b.owner >= 0 ? 1 : 0;
  for (const j of b.jobs) if (j.worker >= 0) { staff++; if (j.role === 'operator') ops++; }
  switch (b.kind) {
    case 'factory': return ops * 3.5 * 0.85;
    case 'foodplant': return ops * FOOD_PLANT_RATE * 0.85;
    case 'office': return staff * (5 / 7);
    case 'restaurant': return staff * MEALS_PER_STAFF * 0.5;
    case 'services': return staff * 11 * 0.5;
    default: return 0;
  }
}

function activityKwh(sim: Sim, b: Business): number {
  switch (b.kind) {
    case 'factory': return dailyActivity(sim, b, 'production') * USE_KWH.crate;
    case 'foodplant': return dailyActivity(sim, b, 'production') * USE_KWH.foodTonne;
    case 'office': return dailyActivity(sim, b, 'production') * USE_KWH.officeStaff;
    case 'restaurant': return dailyActivity(sim, b, 'sales') * USE_KWH.meal;
    case 'services': return dailyActivity(sim, b, 'sales') * USE_KWH.service;
    case 'hotel': return Math.max(b.hotel?.occupied ?? 0, (b.hotel?.rooms ?? 0) * (b.hotel?.lastNights ? 0 : 0.5)) * USE_KWH.roomNight;
    default: return 0;
  }
}

/** Household electricity (kWh) and water (m3) a day. */
export function homeUse(b: Building, members: number): { kwh: number; m3: number } {
  const lux = b.kind === 'luxury';
  return { kwh: (HOME_KWH.household + HOME_KWH.person * members) * (lux ? 2 : 1), m3: HOME_WATER * members * (lux ? 1.6 : 1) };
}

interface Use {
  kwh: number; m3: number; // expected today (homes and premises), for planning supply
  fixed: number; // premises electricity billed by this system (the rest is billed as it is used)
  bizM3: number; // water used by the business on the premises (homes are billed per household)
  biz?: Business;
}

function buildingUse(sim: Sim, b: Building): Use {
  let kwh = 0, m3 = 0, fixed = 0, bizM3 = 0;
  if (b.units > 0) for (const hid of b.occupants) {
    const h = sim.hh(hid);
    if (!h) continue;
    const u = homeUse(b, h.members.length);
    kwh += u.kwh; m3 += u.m3;
  }
  const biz = b.biz >= 0 ? sim.biz(b.biz) : undefined;
  const open = !!biz && (biz.status === 'operating' || biz.status === 'hiring');
  // farms pump with diesel or subsidised farm connections, which are not metered here
  if (open && biz && !biz.farm) {
    fixed = BASE_KWH[b.kind] ?? 0;
    kwh += fixed + activityKwh(sim, biz);
    bizM3 = staffOf(biz) * STAFF_WATER + (biz.kind === 'hotel' ? (biz.hotel?.occupied ?? 0) * 0.3 : 0) + (biz.kind === 'hospital' ? 25 : 0)
      + (biz.kind === 'foodplant' ? dailyActivity(sim, biz, 'production') * 2 : 0) + (biz.kind === 'restaurant' ? dailyActivity(sim, biz, 'sales') * 0.012 : 0);
    m3 += bizM3;
  } else if (!biz && b.ownerT === 0 && b.units === 0) {
    fixed = BASE_KWH[b.kind] ?? 0; // parks, heritage sites and substations: paid by the city
    kwh += fixed;
  }
  return { kwh, m3, fixed, bizM3, biz: open ? biz : undefined };
}

// ------------------------------------------------------------------------------------------------ daily supply

interface Plan {
  net: Net;
  comp: Int32Array; // network of each building, by index into s.buildings
  use: Use[];
  D: Float64Array; Wd: Float64Array; // electricity (kWh) and water (m3) wanted per network
}

function survey(sim: Sim): Plan {
  const s = sim.s;
  const net = network(sim);
  const D = new Float64Array(net.count), Wd = new Float64Array(net.count);
  const comp = new Int32Array(s.buildings.length);
  const use: Use[] = [];
  s.buildings.forEach((b, i) => {
    const c = networkOf(sim, net, b);
    const u = buildingUse(sim, b);
    comp[i] = c;
    use.push(u);
    if (c >= 0) { D[c] += u.kwh; Wd[c] += u.m3; }
  });
  for (let c = 0; c < net.count; c++) D[c] += STREETLIGHT_KWH * net.tiles[c];
  return { net, comp, use, D, Wd };
}

/** MW the regional grid can deliver: the line itself plus substations on networks that reach it. */
export function gridCapacity(sim: Sim, net = network(sim)): number {
  let subs = 0;
  for (const b of sim.s.buildings) if (b.kind === 'substation') { const c = networkOf(sim, net, b); if (c >= 0 && net.grid[c]) subs++; }
  return sim.s.util.gridBase + SUBSTATION_MW * subs;
}

/** Availability of a plant or waterworks: its key staff, funding and the treasury's ability to pay suppliers. */
function availability(sim: Sim, b: Business): number {
  return b.status === 'operating' ? facilityQuality(sim, b, false) : 0;
}

export function utilitiesDaily(sim: Sim): void {
  const s = sim.s, u = s.util, r = sim.rng;
  if (u.gridBase <= 0) firstDay(sim);
  const w = s.weather;
  // today's sunshine and wind
  u.sun = (PLANTS.solarfarm?.cf ?? 0.2) * Math.max(0.25, 1.15 - 0.7 * Math.min(1, w.rain / 25));
  u.wind = (PLANTS.windfarm?.cf ?? 0.28) * (0.35 + 1.3 * r.next());
  // regional grid failures: storms and heatwaves bring lines down
  let gridDown = false;
  if (u.outage > 0) { u.outage--; gridDown = true; }
  else if (r.chance(0.0025 + (w.temp > 40 ? 0.008 : 0) + (w.rain > 80 ? 0.03 : 0))) {
    u.outage = r.chance(0.3) ? 1 : 0;
    gridDown = true;
    const why = w.rain > 80 ? 'Storms brought down regional transmission lines' : w.temp > 40 ? 'The heatwave overloaded the regional grid' : 'A fault on the regional grid tripped the line into town';
    const own = s.businesses.some((b) => PLANTS[b.kind as BuildingKind] && b.status === 'operating');
    if (s.citizens.length > 0) sim.emit('utility.outage', `The regional grid failed${u.outage ? ' for two days' : ''}: ${own ? 'every area without a power plant of its own is dark' : 'the town is without electricity'}.`, 2, undefined, undefined,
      [why, own ? 'Local plants keep the areas their roads connect to running' : 'A gas plant, or solar and wind with the grid back, would keep some of the town running', 'Waterworks switch to diesel pumps and supply less']);
  }
  if (gridDown) u.m.outages++;

  const plan = survey(sim);
  const { net, D, Wd } = plan;
  const C = net.count;
  // local plants and waterworks by network
  const firm = new Float64Array(C), gasMW = new Float64Array(C), solarMW = new Float64Array(C), windMW = new Float64Array(C), works = new Float64Array(C);
  const plants: { b: Business; c: number; kind: BuildingKind; mw: number }[] = [];
  const waterworks: { b: Business; c: number; cap: number }[] = [];
  s.buildings.forEach((bl, i) => {
    const c = plan.comp[i];
    const biz = plan.use[i].biz;
    if (c < 0 || !biz) return;
    const pl = PLANTS[bl.kind];
    if (pl) {
      const mw = pl.mw * availability(sim, biz);
      plants.push({ b: biz, c, kind: bl.kind, mw });
      firm[c] += mw * pl.peak;
      if (bl.kind === 'gasplant') gasMW[c] += mw; else if (bl.kind === 'solarfarm') solarMW[c] += mw; else windMW[c] += mw;
    } else if (bl.kind === 'waterworks') {
      const cap = WATERWORKS_M3 * availability(sim, biz);
      waterworks.push({ b: biz, c, cap });
      works[c] += cap;
    }
  });
  // waterworks need electricity to treat and pump what they deliver
  for (let c = 0; c < C; c++) D[c] += PUMP_KWH * Math.min(works[c], Wd[c]);
  // the grid is shared among the networks that reach it, in proportion to their evening peak
  const G = gridDown ? 0 : gridCapacity(sim, net);
  const peak = new Float64Array(C);
  let gridPeak = 0;
  for (let c = 0; c < C; c++) { peak[c] = (D[c] / 24) * PEAK_FACTOR / 1000; if (net.grid[c]) gridPeak += peak[c]; }
  const share = gridPeak > G ? G / gridPeak : 1;
  const served = new Float64Array(C), wServed = new Float64Array(C);
  const gp = gridPrice(sim), fp = gasPrice(sim);
  let E = 0, Dsum = 0, gridE = 0, gasE = 0, solarE = 0, windE = 0, P = 0, cap = G, blackout = false, isolated = 0;
  const gasBy = new Float64Array(C), solarBy = new Float64Array(C), windBy = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    const g = net.grid[c] ? peak[c] * share : 0;
    const supply = g + firm[c];
    const p = peak[c] > 0 ? Math.min(1, supply / peak[c]) : 1;
    served[c] = p;
    // roads that reach neither the grid nor a plant: nothing to connect to (streetlights alone do not count)
    if (!net.grid[c] && firm[c] <= 0) isolated += Math.max(0, D[c] - STREETLIGHT_KWH * net.tiles[c]);
    const e = D[c] * p;
    // renewables first (free), then the grid, then gas
    const sol = solarMW[c] * 24_000 * u.sun, wnd = windMW[c] * 24_000 * u.wind;
    const ren = Math.min(e, sol + wnd);
    const gr = Math.min(e - ren, (g * 24_000) / PEAK_FACTOR);
    const gs = Math.min(Math.max(0, e - ren - gr), gasMW[c] * 24_000);
    const rs = sol + wnd > 0 ? ren / (sol + wnd) : 0;
    solarBy[c] = sol * rs; windBy[c] = wnd * rs; gasBy[c] = gs;
    E += e; Dsum += D[c]; gridE += gr; gasE += gs; solarE += sol * rs; windE += wnd * rs; P += peak[c]; cap += firm[c];
    if (p < 0.98 && D[c] > 50) blackout = true;
  }
  // water: each network's waterworks, pumping as far as their own electricity allows
  let water = 0, wantW = 0, wcapAll = 0;
  const wcap = new Float64Array(C);
  // diesel standby pumps keep some water flowing through a blackout
  const pumping = (c: number) => Math.max(0.4, served[c]);
  for (const ww of waterworks) wcap[ww.c] += ww.cap * pumping(ww.c);
  for (let c = 0; c < C; c++) {
    const got = Math.min(Wd[c], wcap[c]);
    wServed[c] = Wd[c] > 0 ? got / Wd[c] : wcap[c] > 0 ? 1 : 0;
    water += got; wantW += Wd[c]; wcapAll += wcap[c];
  }
  // what each plant and waterworks produced today
  for (const pl of plants) {
    const tot = pl.kind === 'gasplant' ? gasMW[pl.c] : pl.kind === 'solarfarm' ? solarMW[pl.c] : windMW[pl.c];
    const made = pl.kind === 'gasplant' ? gasBy[pl.c] : pl.kind === 'solarfarm' ? solarBy[pl.c] : windBy[pl.c];
    if (tot > 0) pl.b.m.production += made * (pl.mw / tot);
  }
  for (const ww of waterworks) if (wcap[ww.c] > 0) ww.b.m.production += Math.min(Wd[ww.c], wcap[ww.c]) * ((ww.cap * pumping(ww.c)) / wcap[ww.c]);
  // the city pays for what it buys
  const cost = gridE * gp + gasE * fp;
  if (cost > 0) sim.spend('energy', s.ext, cost);
  s.stats.acc.industryCO2 += (gasE * GAS_CO2) / 1000;
  u.unit = E > 0 ? cost / E : gp;
  u.peak = P; u.cap = cap;
  u.served = Dsum > 0 ? E / Dsum : 1;
  u.waterUse = wantW; u.waterCap = wcapAll;
  u.waterServed = wantW > 0 ? water / wantW : 1;
  const L = u.m;
  L.kwh += E; L.short += Dsum - E; L.grid += gridE; L.gas += gasE; L.solar += solarE; L.wind += windE;
  L.water += water; L.waterShort += wantW - water; L.cost += cost;
  if (blackout) L.blackouts++;
  // what each building got, and the bills
  bill(sim, plan, served, wServed);
  warn(sim, gridDown, Dsum > 0 ? isolated / Dsum : 0);
}

/** Records each building's supply and bills homes and businesses for today's electricity and water. */
function bill(sim: Sim, plan: Plan, served: Float64Array, wServed: Float64Array): void {
  const s = sim.s;
  const ht = homeTariff(sim), bt = bizTariff(sim), wtr = waterTariff(sim), well = WELL_WATER * nominalOf(sim);
  let bills = 0;
  s.buildings.forEach((b, i) => {
    const c = plan.comp[i];
    const p = c >= 0 ? served[c] : 0, w = c >= 0 ? wServed[c] : 0;
    b.pw = Math.round(p * 1000) / 1000;
    b.wt = Math.round(w * 1000) / 1000;
    if (b.units > 0) for (const hid of b.occupants) {
      const h = sim.hh(hid);
      if (!h) continue;
      const use = homeUse(b, h.members.length);
      const due = use.kwh * p * ht + use.m3 * w * wtr;
      const paid = Math.min(due, Math.max(0, h.cash));
      if (paid > 0) { sim.tax('utilityBills', h, paid); h.m.utilities += paid; bills += paid; }
      // without mains water, families make do with less from wells, hand pumps and tankers
      const tanker = Math.min(use.m3 * (1 - w) * 0.7 * well, Math.max(0, h.cash));
      if (tanker > 0) { sim.pay(h, s.ext, tanker); h.m.utilities += tanker; }
    }
    const u = plan.use[i];
    const biz = u.biz;
    // public buildings are the city's own: it pays for their electricity when it buys it
    if (!biz || biz.pub) return;
    const due = u.fixed * p * bt + u.bizM3 * w * wtr;
    if (due > 0) { sim.tax('utilityBills', biz, due); biz.m.cogs += due; bills += due; }
    const tanker = u.bizM3 * (1 - w) * well;
    if (tanker > 0) { sim.pay(biz, s.ext, tanker); biz.m.cogs += tanker; }
  });
  s.util.m.bills += bills;
}

/** Announces blackouts and water shortages when they begin. */
function warn(sim: Sim, gridDown: boolean, isolated: number): void {
  const s = sim.s, u = s.util;
  if (!s.citizens.length) return;
  if (isolated > 0.02 && !sim.recentEvent('utility.unconnected', 60)) {
    sim.emit('utility.unconnected', 'Some neighbourhoods have no electricity: their roads connect neither to the regional highway nor to a power plant.', 2, undefined, undefined,
      ['Power lines follow the roads: link those streets to the rest of town, or build a plant there']);
  } else if (!gridDown && u.served < 0.97 && !sim.recentEvent('utility.blackouts', 45)) {
    sim.emit('utility.blackouts', `Rolling blackouts: at the evening peak the town needs ${u.peak.toFixed(1)} MW but can only get ${Math.min(u.cap, u.peak).toFixed(1)} MW.`, 2, undefined, undefined,
      ['Factories and offices lose output; shops serve fewer customers; homes go without fans and lights', 'A substation raises what the town can draw from the regional grid; power plants add supply of their own']);
  }
  const works = s.businesses.some((b) => b.kind === 'waterworks' && b.status === 'operating');
  if (works && !gridDown && u.waterServed < 0.9 && !sim.recentEvent('utility.water', 60)) {
    sim.emit('utility.water', `Water shortage: the mains deliver ${Math.round(u.waterServed * 100)}% of what the town needs; families queue at wells and tankers.`, 2, undefined, undefined,
      [u.waterCap < u.waterUse ? `Waterworks can supply ${Math.round(u.waterCap).toLocaleString('en-US')} m³ a day against demand of ${Math.round(u.waterUse).toLocaleString('en-US')} m³` : 'Some neighbourhoods are not connected to a waterworks by road',
        'Unsafe water makes people ill']);
  }
}

export function utilitiesMonthly(sim: Sim): void {
  const u = sim.s.util;
  // the regional utility invests in the line into town as the region grows
  u.gridBase *= Math.pow(1.04, 1 / 12);
  u.last = u.m;
  u.m = emptyUtilityLedger();
}

// ------------------------------------------------------------------------------------------------ first day

/** Electricity demand at the evening peak today (MW), from what the town's buildings need. */
export function peakDemand(sim: Sim): number {
  const plan = survey(sim);
  let kwh = 0;
  for (let c = 0; c < plan.net.count; c++) kwh += plan.D[c] + PUMP_KWH * plan.Wd[c];
  return (kwh / 24) * PEAK_FACTOR / 1000;
}

/**
 * The first simulated day: the town's connection to the regional grid is sized with some headroom over today's peak
 * (a new town gets a rural feeder line). Towns saved before utilities were simulated first get the waterworks and
 * fire station they always had.
 */
function firstDay(sim: Sim): void {
  const u = sim.s.util;
  if (u.retrofit) { retrofit(sim); delete u.retrofit; }
  u.gridBase = Math.max(0.6, 1.25 * peakDemand(sim));
}

function retrofit(sim: Sim): void {
  const s = sim.s;
  if (s.citizens.length < 300) return;
  const th = s.buildings.find((b) => b.kind === 'townhall');
  const [cx, cy] = th ? sim.center(th) : [64, 64];
  const has = (k: string) => s.businesses.some((b) => b.kind === k);
  if (!has('waterworks')) {
    const site = findSite(sim, 2, 2, cx - 8, cy, (x, y) => nearWaterTiles(sim, x, y, 2, 2, 4));
    if (site) staffNow(sim, addFacility(sim, 'waterworks', site.x, site.y, site.access));
  }
  if (!has('firestation') && s.citizens.length >= 1500) {
    const site = findSite(sim, 2, 1, cx + 3, cy + 3, () => true);
    if (site) staffNow(sim, addFacility(sim, 'firestation', site.x, site.y, site.access));
  }
}

function nearWaterTiles(sim: Sim, x: number, y: number, w: number, h: number, r: number): boolean {
  const m = sim.s.map;
  for (let yy = y - r; yy < y + h + r; yy++) for (let xx = x - r; xx < x + w + r; xx++) {
    if (!inMap(xx, yy)) continue;
    const t = m.terrain[idx(xx, yy)];
    if (t === Terrain.Water || t === Terrain.Canal) return true;
  }
  return false;
}

/** Nearest free, road-accessible site for a facility of w x h tiles. */
export function findSite(sim: Sim, w: number, h: number, tx: number, ty: number, ok: (x: number, y: number) => boolean, maxR = 40): { x: number; y: number; access: number } | null {
  const m = sim.s.map;
  const free = (t: number) => {
    const tt = m.terrain[t];
    return !m.road[t] && m.owner[t] < 0 && m.project[t] < 0 && m.farm[t] < 0 && tt !== Terrain.Water && tt !== Terrain.Canal && m.zone[t] !== Zone.Park;
  };
  let best: { x: number; y: number; access: number } | null = null, bd = Infinity;
  const x0 = Math.max(0, Math.round(tx) - maxR), x1 = Math.min(W - w, Math.round(tx) + maxR);
  const y0 = Math.max(0, Math.round(ty) - maxR), y1 = Math.min(W - h, Math.round(ty) + maxR);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x + w / 2 - tx, y + h / 2 - ty);
    if (d >= bd) continue;
    let fits = true;
    for (let yy = y; yy < y + h && fits; yy++) for (let xx = x; xx < x + w; xx++) if (!free(idx(xx, yy))) { fits = false; break; }
    if (!fits || !ok(x, y)) continue;
    let access = -1;
    for (let yy = y - 1; yy <= y + h && access < 0; yy++) for (let xx = x - 1; xx <= x + w; xx++) {
      if (!inMap(xx, yy) || (xx >= x && xx < x + w && yy >= y && yy < y + h)) continue;
      const corner = (xx < x || xx >= x + w) && (yy < y || yy >= y + h);
      if (!corner && m.road[idx(xx, yy)]) { access = idx(xx, yy); break; }
    }
    if (access < 0) continue;
    best = { x, y, access };
    bd = d;
  }
  return best;
}

function addFacility(sim: Sim, kind: BuildingKind, x: number, y: number, access: number): Business | undefined {
  const spec = BUILDINGS[kind];
  const nominal = nominalOf(sim);
  const b: Building = {
    id: sim.newId(), kind, x, y, w: spec.w, h: spec.h, floors: spec.floors[0], units: 0, occupants: [], biz: -1, ownerT: 0, ownerId: -1,
    value: (spec.cost + spec.equipment) * nominal * 0.7, rent: 0, condition: 0.8, built: Math.min(0, sim.day - 3650), access, style: sim.rng.int(1_000_000), name: '',
  };
  const m = sim.s.map;
  for (let yy = y; yy < y + spec.h; yy++) for (let xx = x; xx < x + spec.w; xx++) if (m.terrain[idx(xx, yy)] === Terrain.Forest) { m.terrain[idx(xx, yy)] = Terrain.Grass; sim.ix.ver.terrain++; }
  sim.addBuilding(b);
  if (!spec.biz) return undefined;
  const biz = sim.newBusiness(spec.biz, businessName(sim, spec.biz), b.id, -1, false, 0, 'operating');
  biz.founded = b.built;
  for (const [role, n] of BUSINESSES[spec.biz].jobs) sim.addJobs(biz, role, n);
  biz.capacity = biz.jobs.length;
  sim.addBusiness(biz);
  b.name = biz.name;
  return biz;
}

/** Fills a facility's posts from residents looking for work, as if it had always been staffed. */
function staffNow(sim: Sim, biz: Business | undefined): void {
  if (!biz) return;
  const pool = sim.s.citizens.filter((c) => c.status === 'unemployed');
  biz.jobs.forEach((j, k) => {
    const role = ROLES[j.role];
    const i = pool.findIndex((c) => c.edu >= role.edu && (!role.fields || role.fields.includes(c.field)));
    if (i < 0) return;
    const c = pool[i];
    pool.splice(i, 1);
    sim.hire(biz, k, c);
  });
}

// ------------------------------------------------------------------------------------------------ reporting

export interface UtilityReport {
  peak: number; cap: number; grid: number; served: number;
  waterUse: number; waterCap: number; waterServed: number;
  plants: { kind: BuildingKind; mw: number; n: number }[];
  substations: number;
  outage: boolean;
  unit: number; home: number; business: number; water: number;
  lines: string[];
}

/** Today's electricity and water position, for the dashboard. */
export function utilityReport(sim: Sim): UtilityReport {
  const s = sim.s, u = s.util;
  const plants: UtilityReport['plants'] = [];
  for (const kind of ['gasplant', 'solarfarm', 'windfarm'] as BuildingKind[]) {
    const list = s.businesses.filter((b) => b.kind === kind && b.status === 'operating');
    if (list.length) plants.push({ kind, n: list.length, mw: list.length * (PLANTS[kind]?.mw ?? 0) });
  }
  const substations = s.buildings.filter((b) => b.kind === 'substation').length;
  const lines: string[] = [];
  const L = u.last.kwh > 0 ? u.last : u.m;
  const tot = L.grid + L.gas + L.solar + L.wind;
  if (tot > 0) {
    const pc = (x: number) => Math.round((x / tot) * 100);
    lines.push(`Electricity came ${[`${pc(L.grid)}% from the regional grid`, L.gas > 0 ? `${pc(L.gas)}% from gas` : '', L.solar + L.wind > 0 ? `${pc(L.solar + L.wind)}% from solar and wind` : ''].filter(Boolean).join(', ')}`);
  }
  if (L.cost > 0 || L.bills > 0) lines.push(`Bills raised ${fmtMoney(sim, L.bills)}; electricity bought cost ${fmtMoney(sim, L.cost)}`);
  if (L.blackouts > 0) lines.push(`${L.blackouts} day${L.blackouts > 1 ? 's' : ''} with rolling blackouts${L.outages ? `, ${L.outages} with the regional grid down` : ''}`);
  return {
    peak: u.peak, cap: u.cap, grid: gridCapacity(sim), served: u.served, waterUse: u.waterUse, waterCap: u.waterCap, waterServed: u.waterServed,
    plants, substations, outage: u.outage > 0, unit: u.unit, home: homeTariff(sim), business: bizTariff(sim), water: waterTariff(sim), lines,
  };
}
