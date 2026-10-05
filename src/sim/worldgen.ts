// Procedural generation of a starting region: terrain, river, road network, zoning, buildings, farms,
// businesses, households and citizens. The result is a coherent economy close to a steady state so the
// simulation can take over immediately.

import { dateOf, dayIndex, MIN_PER_DAY } from './calendar';
import { emptyAcc, emptyGovLedger, emptyHhLedger, idx, inMap, Sim, W } from './core';
import { businessName, firstName, lastName } from './names';
import { emptyVenue, initAir, initFood, initLeisure, initTourism, initTrade } from './init';
import { STATE_VERSION } from './migrate';
import { getCondition, getPreset, moneyScale, type Preset, type StartCondition } from './presets';
import { type Rng, seedState } from './rng';
import {
  BASE_RENT, BUILDINGS, BUSINESSES, CROPS, DAY_TRIP_SHARE, FOOD_NEED, GOOD_SPECS, HA_PER_TILE, HOTEL_ROOMS_PER_FLOOR, ROAD_MAINT, ROLES, STAY_NIGHTS,
  VEG_NEED, VISITOR_BASE, cropTempFactor, unitsFor,
} from './tables';
import { computeAppeal } from './systems/tourism';
import {
  DEPTS, GOODS, RoadClass, Terrain, Zone,
  type Building, type BuildingKind, type Business, type BusinessKind, type Citizen, type CropId, type Dept, type FarmState, type Field,
  type Good, type Household, type MarketGood, type RoleId, type WorldState,
} from './types';

export interface NewWorldOptions {
  name: string;
  preset: string;
  /** Year the player's administration takes office. The simulation starts a year earlier to build up history. */
  startYear: number;
  condition: string;
  seed: number;
  pace: number;
  offlineCapDays: number;
  now: number;
}

const N = W * W;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function makeNoise(r: Rng, cells: number) {
  const n = cells + 1;
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = r.next();
  return (x: number, y: number) => {
    const fx = clamp(x, 0, 0.9999) * cells, fy = clamp(y, 0, 0.9999) * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const ux = fx - ix, uy = fy - iy;
    const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
    const a = g[iy * n + ix], b = g[iy * n + ix + 1], c = g[(iy + 1) * n + ix], d = g[(iy + 1) * n + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

export function skeleton(o: NewWorldOptions): WorldState {
  const preset = getPreset(o.preset);
  const cond = getCondition(o.condition);
  const epoch = o.startYear - 1;
  const officeDay = dayIndex(epoch, o.startYear, 0, 1);
  const scale = moneyScale(o.preset, epoch);
  // empty land has no history to simulate: the clock starts the day the player takes office, at that year's prices
  const empty = cond.id === 'empty';
  const trend = empty ? 1 + preset.inflation : 1;
  const prices = {} as Record<Good, number>;
  const dev = {} as Record<Good, number>;
  const market = {} as Record<Good, MarketGood>;
  for (const g of GOODS) {
    prices[g] = GOOD_SPECS[g].world * scale * trend;
    dev[g] = 0;
    market[g] = { price: prices[g], supply: 0, demand: 0, local: 0, imported: 0, exported: 0, lastLocal: 0, lastImported: 0, lastExported: 0, importValue: 0, exportValue: 0, hist: [], lastWhy: '' };
  }
  const zeroDept = {} as Record<Dept, number>;
  const oneDept = {} as Record<Dept, number>;
  for (const d of DEPTS) { zeroDept[d] = 0; oneDept[d] = 1; }
  const t = preset.taxes;
  const p = preset.policies;
  return {
    v: STATE_VERSION,
    meta: {
      id: `w${o.now.toString(36)}${Math.floor(o.seed % 1e6).toString(36)}`, name: o.name, preset: o.preset, startYear: epoch,
      officeYear: o.startYear, officeDay, condition: o.condition, seed: o.seed, pace: o.pace, offlineCapDays: o.offlineCapDays, createdAt: o.now, lastReal: o.now, playedMs: 0,
    },
    minute: (empty ? officeDay * MIN_PER_DAY : 0) + 8 * 60,
    rng: seedState(o.seed),
    nextId: 1,
    map: {
      w: W, h: W,
      terrain: new Array(N).fill(Terrain.Grass), zone: new Array(N).fill(Zone.None), road: new Array(N).fill(0), roadCond: new Array(N).fill(0.9),
      owner: new Array(N).fill(-1), farm: new Array(N).fill(-1), fertility: new Array(N).fill(0.6), project: new Array(N).fill(-1), landValue: new Array(N).fill(0),
    },
    buildings: [], businesses: [], citizens: [], households: [], projects: [], shipments: [],
    market,
    ext: { cash: 0, demand: 1, phase: 'normal', phaseLeft: 0, fuel: 60 * scale * trend, fuelDev: 0, prices, dev, trend },
    weather: { temp: preset.climate.temp[0], tempDev: 0, rain: 0, rainLog: [], normalLog: [], anomaly: 1, anomalyQuarter: -1, drought: false, flood: 999, heatDays: 0, pandemic: 0 },
    gov: {
      cash: cond.treasury * scale, debt: cond.debt * scale, rate: 0.07, rating: 'A',
      taxes: { ...t, allowance: t.allowance * scale, topThreshold: t.topThreshold * scale, licenseFee: t.licenseFee * scale, passengerFee: t.passengerFee * scale },
      level: { ...oneDept }, deptSpend: { ...zeroDept },
      policies: { ...p, minWage: p.minWage * scale, unemploymentBenefit: p.unemploymentBenefit * scale, pension: p.pension * scale, povertyTransfer: p.povertyTransfer * scale },
      pending: [], m: emptyGovLedger(), last: emptyGovLedger(), ytd: emptyGovLedger(), lastYear: emptyGovLedger(),
      deptNeed: { ...zeroDept }, deptFunding: { ...oneDept }, arrears: 0, total: { rev: 0, exp: 0 }, compliance: 0.93, approval: 0.55,
    },
    labor: { wage: [1, 1, 1, 1, 1], vacancies: [0, 0, 0, 0, 0], unemployed: [0, 0, 0, 0, 0] },
    housing: { rentIndex: 1, vacancy: cond.vacancy, demandGap: 0 },
    traffic: { volume: new Array(N).fill(0), avgCommute: 0, congestion: 0, lastRun: -999, truckLoad: new Array(N).fill(0), tileTime: new Array(N).fill(0) },
    env: { pollution: new Array(32 * 32).fill(0), co2: 0, water: 0.8 },
    services: { health: 0.6, education: 0.6, safety: 0.6, crime: 0.03, healthCov: new Array(256).fill(0), schoolCov: new Array(256).fill(0), policeCov: new Array(256).fill(0) },
    stats: { months: [], acc: emptyAcc(), cumHarvest: {} },
    events: [], news: [], milestones: {},
    leisure: initLeisure(), tourism: initTourism(preset), air: initAir(), trade: initTrade(preset), pds: initFood(),
  };
}

export function createWorld(o: NewWorldOptions): Sim {
  const sim = new Sim(skeleton(o));
  new Generator(sim).run();
  sim.reindex();
  return sim;
}

interface Parcel { tiles: number[]; touches: boolean; d: number }

/** Initial crop growth reached `days` after sowing on day-of-year `sowDoy`, using the monthly climate. */
function growthSince(p: Preset, crop: CropId, sowDoy: number, days: number): number {
  const spec = CROPS[crop];
  let g = 0;
  for (let k = 0; k < days; k++) {
    const doy = mod(sowDoy + k, 365);
    const month = Math.min(11, Math.floor(doy / 30.42));
    g += cropTempFactor(spec, p.climate.temp[month]) / spec.days;
  }
  return g;
}

class Generator {
  sim: Sim;
  s: WorldState;
  r: Rng;
  p: Preset;
  c: StartCondition;
  cx = 64; cy = 64; R = 20; yH = 84;
  urban = new Uint8Array(N);
  riverX = new Int16Array(W);
  ind = { x0: 0, y0: 0, x1: 0, y1: 0 };
  farms: Business[] = [];

  constructor(sim: Sim) {
    this.sim = sim;
    this.s = sim.s;
    this.r = sim.rng;
    this.p = sim.preset;
    this.c = getCondition(sim.s.meta.condition);
  }

  run(): void {
    this.terrain();
    if (this.c.id === 'empty') {
      this.emptyLand();
      this.finance();
      return;
    }
    this.roads();
    this.zones();
    this.placeCivic();
    this.placeIndustry();
    this.placeCommerce();
    this.placeParks();
    this.placeLeisure();
    this.placeFarms();
    this.placeHousing();
    this.populate();
    this.finance();
  }

  // ------------------------------------------------------------------ terrain
  terrain(): void {
    const m = this.s.map, r = this.r;
    const n1 = makeNoise(r, 7), n2 = makeNoise(r, 22), nr = makeNoise(r, 9), nu = makeNoise(r, 6);
    const phase = r.range(0, Math.PI * 2);
    for (let y = 0; y < W; y++) this.riverX[y] = Math.round(W * 0.4 + 8 * Math.sin(y / 17 + phase) + 10 * (nr(0.3, y / W) - 0.5));
    this.cy = 58 + r.int(8);
    this.cx = this.riverX[this.cy] + 13;
    this.R = Math.round(9 + Math.sqrt(this.c.population) * 0.2);
    this.yH = this.cy + 20;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const dr = Math.abs(x - this.riverX[y]);
        if (dr <= 1) m.terrain[i] = Terrain.Water;
        m.fertility[i] = clamp(0.45 + 0.4 * Math.exp(-dr / 14) + 0.3 * (n2(x / W, y / W) - 0.5), 0.2, 1);
        const d = Math.hypot(x - this.cx, y - this.cy);
        const f = 0.6 * n1(x / W, y / W) + 0.4 * n2(x / W, y / W);
        if (m.terrain[i] !== Terrain.Water && f > 0.63 && d > this.R + 8) m.terrain[i] = Terrain.Forest;
        if (m.terrain[i] !== Terrain.Water && d < this.R * (0.82 + 0.36 * nu(x / W, y / W))) this.urban[i] = 1;
      }
    }
    // industrial district east of the centre along the highway
    const R = this.R;
    this.ind = { x0: this.cx + Math.round(R * 0.45), x1: Math.min(W - 3, this.cx + R + 10), y0: this.yH - 8, y1: Math.min(W - 3, this.yH + 5) };
    for (let y = this.ind.y0; y <= this.ind.y1; y++) for (let x = this.ind.x0; x <= this.ind.x1; x++) {
      const i = idx(x, y);
      if (m.terrain[i] !== Terrain.Water) { this.urban[i] = 1; if (m.terrain[i] === Terrain.Forest) m.terrain[i] = Terrain.Grass; }
    }
    if (this.p.canals) {
      for (const yc of [this.cy - 26, this.cy + 34, this.cy - 50]) {
        if (yc < 3 || yc > W - 4) continue;
        for (let x = 0; x < W; x++) {
          const i = idx(x, yc);
          if (m.terrain[i] === Terrain.Water || this.urban[i]) continue;
          if (Math.hypot(x - this.cx, yc - this.cy) < R + 3) continue;
          m.terrain[i] = Terrain.Canal;
        }
      }
    }
  }

  // ------------------------------------------------------------------ roads
  roads(): void {
    const m = this.s.map;
    const set = (x: number, y: number, cls: number) => {
      if (!inMap(x, y)) return;
      const i = idx(x, y);
      if (m.terrain[i] === Terrain.Water && cls < RoadClass.Avenue) return;
      if (m.road[i] < cls) m.road[i] = cls;
      if (m.terrain[i] === Terrain.Forest) m.terrain[i] = Terrain.Grass;
    };
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const gx = mod(x - this.cx, 4) === 0, gy = mod(y - this.cy, 4) === 0;
        const ax = mod(x - this.cx, 16) === 0, ay = mod(y - this.cy, 16) === 0;
        if (this.urban[i]) {
          if (ax || ay) set(x, y, RoadClass.Avenue);
          else if (gx || gy) set(x, y, RoadClass.Street);
        } else if (ax || ay) set(x, y, RoadClass.Street);
      }
    }
    for (let x = 0; x < W; x++) set(x, this.yH, RoadClass.Highway);
    for (let y = 0; y < W; y++) set(this.cx, y, RoadClass.Avenue);
    for (let x = 0; x < W; x++) set(x, this.cy, RoadClass.Avenue);
    // keep only the network connected to the centre
    const seen = new Uint8Array(N);
    const start = idx(this.cx, this.cy);
    const q = [start];
    seen[start] = 1;
    while (q.length) {
      const i = q.pop()!;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) continue;
        const j = idx(nx, ny);
        if (!seen[j] && m.road[j] > 0) { seen[j] = 1; q.push(j); }
      }
    }
    for (let i = 0; i < N; i++) if (m.road[i] > 0 && !seen[i]) m.road[i] = 0;
    for (let i = 0; i < N; i++) m.roadCond[i] = m.road[i] ? 0.7 + 0.3 * this.r.next() : 0;
  }

  /** Empty land: only the regional highway crosses the region. Nothing is zoned, built or farmed. */
  emptyLand(): void {
    const m = this.s.map;
    for (let x = 0; x < W; x++) {
      const i = idx(x, this.yH);
      m.road[i] = RoadClass.Highway;
      if (m.terrain[i] === Terrain.Forest) m.terrain[i] = Terrain.Grass;
    }
    for (let i = 0; i < N; i++) m.roadCond[i] = m.road[i] ? 0.8 + 0.2 * this.r.next() : 0;
    // land value: the riverbank and the highway are the most sought-after places to settle
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const dr = Math.abs(x - this.riverX[y]), dh = Math.abs(y - this.yH);
      m.landValue[idx(x, y)] = clamp(0.2 + 0.3 * Math.exp(-dr / 10) + 0.25 * Math.exp(-dh / 8), 0, 1);
    }
  }

  roadNeighbor(i: number): number {
    const m = this.s.map;
    const x = i % W, y = (i / W) | 0;
    let best = -1, bestC = 99;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inMap(nx, ny)) continue;
      const j = idx(nx, ny);
      const c = m.road[j];
      if (c > 0) {
        const pref = c === 1 ? 0 : c === 2 ? 1 : 2; // prefer quiet streets for access
        if (pref < bestC) { bestC = pref; best = j; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ zoning
  zones(): void {
    const m = this.s.map;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const t = m.terrain[i];
      const d = Math.hypot(x - this.cx, y - this.cy);
      if (m.road[i] > 0 || t === Terrain.Water || t === Terrain.Canal) m.zone[i] = Zone.None;
      else if (x >= this.ind.x0 && x <= this.ind.x1 && y >= this.ind.y0 && y <= this.ind.y1) m.zone[i] = Zone.Industrial;
      else if (this.urban[i]) {
        let nearAvenue = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (inMap(x + dx, y + dy) && m.road[idx(x + dx, y + dy)] >= 2) nearAvenue = true;
        if (d < 5.5) m.zone[i] = Zone.Commercial;
        else if (nearAvenue && this.r.next() < 0.4 && d < this.R * 0.8) m.zone[i] = Zone.Commercial;
        else m.zone[i] = Zone.Residential;
      } else if (t !== Terrain.Forest) m.zone[i] = Zone.Agricultural;
      // land value: centrality, river views, distance from industry
      let lv = clamp(1 - d / (this.R * 1.6), 0, 1);
      if (Math.abs(x - this.riverX[y]) < 5 && this.urban[i]) lv += 0.15;
      if (m.zone[i] === Zone.Industrial) lv *= 0.6;
      m.landValue[i] = lv;
    }
  }

  // ------------------------------------------------------------------ placement helpers
  free(i: number): boolean {
    const m = this.s.map;
    const t = m.terrain[i];
    return m.road[i] === 0 && m.owner[i] < 0 && m.farm[i] < 0 && t !== Terrain.Water && t !== Terrain.Canal && t !== Terrain.Forest;
  }

  accessFor(x: number, y: number, w: number, h: number): number {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (yy !== y && yy !== y + h - 1 && xx !== x && xx !== x + w - 1) continue;
      const a = this.roadNeighbor(idx(xx, yy));
      if (a >= 0) return a;
    }
    return -1;
  }

  findRect(w: number, h: number, tx0: number, ty0: number, ok: (i: number) => boolean, maxR = 30): { x: number; y: number; access: number } | null {
    let best: { x: number; y: number; access: number } | null = null;
    let bestD = Infinity;
    const x0 = Math.max(0, Math.round(tx0) - maxR), x1 = Math.min(W - w, Math.round(tx0) + maxR);
    const y0 = Math.max(0, Math.round(ty0) - maxR), y1 = Math.min(W - h, Math.round(ty0) + maxR);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + w / 2 - tx0, y + h / 2 - ty0);
        if (d >= bestD) continue;
        let okAll = true;
        for (let yy = y; yy < y + h && okAll; yy++) for (let xx = x; xx < x + w; xx++) {
          const i = idx(xx, yy);
          if (!this.free(i) || !ok(i)) { okAll = false; break; }
        }
        if (!okAll) continue;
        const a = this.accessFor(x, y, w, h);
        if (a < 0) continue;
        best = { x, y, access: a };
        bestD = d;
      }
    }
    return best;
  }

  mkBuilding(kind: BuildingKind, x: number, y: number, w: number, h: number, access: number, floors?: number): Building {
    const spec = BUILDINGS[kind];
    const r = this.r;
    const f = floors ?? spec.floors[0] + r.int(spec.floors[1] - spec.floors[0] + 1);
    let lv = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) lv += this.s.map.landValue[idx(xx, yy)];
    lv /= w * h;
    const baseCost = spec.perFloor ? spec.cost * f : spec.cost;
    const b: Building = {
      id: this.sim.newId(), kind, x, y, w, h, floors: f, units: unitsFor(kind, f), occupants: [], biz: -1, ownerT: 0, ownerId: -1,
      value: baseCost * this.sim.scale * (0.8 + 0.6 * lv), rent: 0, condition: 0.75 + 0.25 * r.next(), built: -r.int(9000), access, style: r.int(1_000_000), name: '',
    };
    const base = BASE_RENT[kind];
    if (base) b.rent = Math.round((base * this.sim.scale * (0.75 + 0.6 * lv) * (0.9 + 0.2 * r.next())) / 50) * 50;
    if (kind === 'apartment') b.name = `${r.pick(this.p.bizPrefix)} ${r.pick(['Residency', 'Heights', 'Apartments', 'Towers', 'Enclave'])}`;
    if (kind === 'affordable') b.name = `${this.s.meta.name} Housing Block ${1 + this.s.buildings.filter((q) => q.kind === 'affordable').length}`;
    return this.sim.addBuilding(b);
  }

  mkBusiness(kind: BusinessKind, bl: Building): Business {
    const sim = this.sim;
    const spec = BUSINESSES[kind];
    const b = sim.newBusiness(kind, businessName(sim, kind), bl.id, -1, false, 0, 'operating');
    b.founded = -this.r.int(5000);
    const mult = kind === 'office' || kind === 'hotel' ? Math.max(1, Math.round(bl.floors / 4)) : 1;
    if (kind === 'cinema' || kind === 'museum' || kind === 'stadium') b.venue = emptyVenue();
    for (const [role, n] of spec.jobs) sim.addJobs(b, role, Math.max(1, Math.round(n * mult)));
    for (const j of b.jobs) j.wage *= 0.92 + 0.16 * this.r.next();
    b.capacity = Math.round(b.jobs.length * 1.6);
    if (kind === 'logistics') b.trucks = b.jobs.filter((j) => j.role === 'driver').map(() => ({ freeAt: 0 }));
    if (spec.pub) { bl.ownerT = 0; bl.name = b.name; }
    else { bl.ownerT = 2; bl.ownerId = b.id; }
    sim.addBusiness(b);
    return b;
  }

  place(kind: BuildingKind, bizKind: BusinessKind | '', tx0: number, ty0: number, ok: (i: number) => boolean, maxR = 30, floors?: number): Building | null {
    const spec = BUILDINGS[kind];
    const spot = this.findRect(spec.w, spec.h, tx0, ty0, ok, maxR);
    if (!spot) return null;
    const bl = this.mkBuilding(kind, spot.x, spot.y, spec.w, spec.h, spot.access, floors);
    if (bizKind) this.mkBusiness(bizKind, bl);
    return bl;
  }

  // ------------------------------------------------------------------ civic, industry, commerce
  placeCivic(): void {
    const m = this.s.map;
    const okUrban = (i: number) => this.urban[i] === 1 && m.zone[i] !== Zone.Industrial;
    const { cx, cy, R } = this;
    this.place('townhall', 'townhall', cx + 2, cy + 2, okUrban, 14);
    if (this.c.hospital) this.place('hospital', 'hospital', cx - 7, cy + 7, okUrban, 22);
    if (this.c.college) this.place('college', 'college', cx + 10, cy - 9, okUrban, 25);
    for (let k = 0; k < this.c.schools; k++) {
      const a = (2 * Math.PI * k) / this.c.schools + 0.6;
      this.place('school', 'school', cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5, okUrban, 18);
    }
    for (let k = 0; k < this.c.clinics; k++) {
      const a = (2 * Math.PI * k) / this.c.clinics + 1.9;
      this.place('clinic', 'clinic', cx + Math.cos(a) * R * 0.35, cy + Math.sin(a) * R * 0.35, okUrban, 18);
    }
    for (let k = 0; k < this.c.police; k++) {
      const a = (2 * Math.PI * k) / this.c.police + 3.4;
      this.place('police', 'police', cx + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3, okUrban, 18);
    }
  }

  placeIndustry(): void {
    const m = this.s.map;
    const okInd = (i: number) => m.zone[i] === Zone.Industrial;
    const tx0 = (this.ind.x0 + this.ind.x1) / 2, ty0 = (this.ind.y0 + this.ind.y1) / 2;
    const c = this.c;
    for (let k = 0; k < c.factories; k++) this.place('factory', 'factory', tx0 + 4, ty0, okInd, 30);
    for (let k = 0; k < c.materials; k++) this.place('materials', 'materials', tx0 + 8, ty0 + 3, okInd, 30);
    for (let k = 0; k < c.foodplants; k++) this.place('foodplant', 'foodplant', tx0 - 4, ty0, okInd, 30);
    for (let k = 0; k < c.logistics; k++) this.place('depot', 'logistics', this.ind.x0 + 1, this.yH, okInd, 30);
    for (let k = 0; k < c.construction; k++) this.place('yard', 'construction', tx0, ty0 - 4, okInd, 30);
  }

  randomUrbanPoint(maxFrac: number): [number, number] {
    const a = this.r.range(0, Math.PI * 2), d = Math.sqrt(this.r.next()) * this.R * maxFrac;
    return [this.cx + Math.cos(a) * d, this.cy + Math.sin(a) * d];
  }

  placeCommerce(): void {
    const m = this.s.map;
    const okCom = (i: number) => m.zone[i] === Zone.Commercial;
    const okComRes = (i: number) => m.zone[i] === Zone.Commercial || m.zone[i] === Zone.Residential;
    const pop = this.c.population;
    for (let k = 0; k < this.c.offices; k++) {
      const [x, y] = this.randomUrbanPoint(0.25);
      this.place('office', 'office', x, y, okCom, 20, 4 + this.r.int(6)) ?? this.place('office', 'office', x, y, okComRes, 25, 4 + this.r.int(4));
    }
    const nGroc = Math.max(2, Math.round(pop / 650));
    for (let k = 0; k < nGroc; k++) {
      const a = (2 * Math.PI * k) / nGroc + this.r.range(-0.3, 0.3);
      const d = this.R * (k === 0 ? 0.1 : this.r.range(0.25, 0.7));
      const x = this.cx + Math.cos(a) * d, y = this.cy + Math.sin(a) * d;
      this.place('grocery', 'grocery', x, y, okCom, 8) ?? this.place('grocery', 'grocery', x, y, okComRes, 20);
    }
    const nShop = Math.max(2, Math.round(pop / 1100));
    for (let k = 0; k < nShop; k++) {
      const [x, y] = this.randomUrbanPoint(0.5);
      this.place('shop', 'shop', x, y, okCom, 20) ?? this.place('shop', 'shop', x, y, okComRes, 25);
    }
    const nRest = Math.max(2, Math.round(pop / 1400));
    for (let k = 0; k < nRest; k++) {
      const [x, y] = this.randomUrbanPoint(0.6);
      this.place('restaurant', 'restaurant', x, y, okCom, 20) ?? this.place('restaurant', 'restaurant', x, y, okComRes, 25);
    }
    // repair shops, salons, tailors, tuition, auto-rickshaw operators: the bulk of small-town employment
    const nServ = Math.max(2, Math.round(pop / 420));
    for (let k = 0; k < nServ; k++) {
      const [x, y] = this.randomUrbanPoint(0.75);
      this.place('services', 'services', x, y, okComRes, 25);
    }
  }

  placeParks(): void {
    const m = this.s.map;
    const ok = (i: number) => this.urban[i] === 1 && m.zone[i] === Zone.Residential;
    const targets: [number, number][] = [[this.riverX[this.cy + 5] + 4, this.cy + 5]];
    if (this.c.population > 5000) targets.push([this.cx + 3, this.cy - 10]);
    for (const [x, y] of targets) {
      const spot = this.findRect(3, 3, x, y, ok, 16);
      if (!spot) continue;
      const bl = this.mkBuilding('park', spot.x, spot.y, 3, 3, spot.access, 0);
      bl.name = `${this.s.meta.name} ${this.r.pick(['Riverside Park', 'Central Garden', 'Public Garden', 'Green'])}`;
      for (let yy = spot.y; yy < spot.y + 3; yy++) for (let xx = spot.x; xx < spot.x + 3; xx++) m.zone[idx(xx, yy)] = Zone.Park;
    }
  }

  // ------------------------------------------------------------------ heritage, venues and hotels
  placeLeisure(): void {
    const m = this.s.map, r = this.r, c = this.c, p = this.p;
    const okUrban = (i: number) => this.urban[i] === 1 && m.zone[i] !== Zone.Industrial;
    const okCom = (i: number) => m.zone[i] === Zone.Commercial;
    const okComRes = (i: number) => m.zone[i] === Zone.Commercial || m.zone[i] === Zone.Residential;
    // heritage: an old fort, temple or ruin near the river at the edge of town
    for (let k = 0; k < c.heritage; k++) {
      const y = clamp(Math.round(this.cy + (k === 0 ? -1 : 1) * this.R * 0.75), 4, W - 5);
      const x = this.riverX[y] + (k === 0 ? 5 : -6);
      const spot = this.findRect(2, 2, x, y, (i) => m.zone[i] !== Zone.Industrial, 24);
      if (!spot) continue;
      const bl = this.mkBuilding('heritage', spot.x, spot.y, 2, 2, spot.access, 1);
      bl.name = p.tourism.heritage[k % p.tourism.heritage.length];
      bl.condition = 0.55 + 0.3 * r.next();
      bl.built = -36500;
    }
    if (c.museum) this.place('museum', 'museum', this.cx - 5, this.cy - 5, okUrban, 18);
    if (c.stadium) {
      // a stadium needs a bigger plot than the town's street blocks offer: try the town either way round, then open
      // land at its edge
      const tx = this.cx + this.R * 0.55, ty = this.cy - this.R * 0.45;
      const edge = (i: number) => m.zone[i] !== Zone.Industrial;
      const tries: [number, number, (i: number) => boolean, number][] = [[4, 3, okUrban, 25], [3, 4, okUrban, 25], [4, 3, edge, 35], [3, 4, edge, 35]];
      for (const [w, h, ok, maxR] of tries) {
        const spot = this.findRect(w, h, tx, ty, ok, maxR);
        if (!spot) continue;
        this.mkBusiness('stadium', this.mkBuilding('stadium', spot.x, spot.y, w, h, spot.access, 1));
        break;
      }
    }
    const nCin = Math.max(1, Math.round(c.population / 5000));
    for (let k = 0; k < nCin; k++) {
      const [x, y] = this.randomUrbanPoint(0.35);
      this.place('cinema', 'cinema', x, y, okCom, 20) ?? this.place('cinema', 'cinema', x, y, okComRes, 25);
    }
    // hotels sized to the visitors the attractions already draw (residents are placed later, so use the target)
    computeAppeal(this.sim, c.population);
    const T = this.s.tourism, rep = 0.5 + T.reputation;
    const dom = VISITOR_BASE.domestic * T.appeal * T.awareness * rep * 0.85;
    const forn = VISITOR_BASE.foreign * T.appeal * T.awarenessIntl * rep * 0.36;
    const guests = dom * (1 - DAY_TRIP_SHARE.domestic) * STAY_NIGHTS.domestic + forn * (1 - DAY_TRIP_SHARE.foreign) * STAY_NIGHTS.foreign;
    let floors = Math.ceil(guests / 2 / 0.7 / HOTEL_ROOMS_PER_FLOOR);
    while (floors > 0) {
      const f = Math.min(6, Math.max(3, floors));
      const [x, y] = this.randomUrbanPoint(0.3);
      if (!(this.place('hotel', 'hotel', x, y, okCom, 20, f) ?? this.place('hotel', 'hotel', x, y, okComRes, 25, f))) break;
      floors -= f;
    }
  }

  // ------------------------------------------------------------------ farms
  placeFarms(): void {
    const m = this.s.map;
    const xs = [-1], ys = [-1];
    for (let x = 0; x < W; x++) if (mod(x - this.cx, 16) === 0) xs.push(x);
    for (let y = 0; y < W; y++) if (mod(y - this.cy, 16) === 0) ys.push(y);
    xs.push(W); ys.push(W);
    const parcels: Parcel[] = [];
    for (let a = 0; a < xs.length - 1; a++) {
      for (let b = 0; b < ys.length - 1; b++) {
        const bx0 = xs[a] + 1, bx1 = xs[a + 1] - 1, by0 = ys[b] + 1, by1 = ys[b + 1] - 1;
        if (bx1 < bx0 || by1 < by0) continue;
        let urbanCount = 0, total = 0;
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { total++; if (this.urban[idx(x, y)]) urbanCount++; }
        if (urbanCount > total * 0.2) continue;
        const cutsX = this.cuts(bx0, bx1), cutsY = this.cuts(by0, by1);
        const grid: Parcel[][] = [];
        for (let gy = 0; gy < cutsY.length; gy++) {
          grid.push([]);
          for (let gx = 0; gx < cutsX.length; gx++) {
            const tiles: number[] = [];
            let touches = false;
            const [x0, x1] = cutsX[gx], [y0, y1] = cutsY[gy];
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
              const i = idx(x, y);
              if (!this.free(i) || this.urban[i] || m.zone[i] !== Zone.Agricultural) continue;
              tiles.push(i);
              if (this.roadNeighbor(i) >= 0) touches = true;
            }
            const d = Math.hypot((x0 + x1) / 2 - this.cx, (y0 + y1) / 2 - this.cy);
            grid[gy].push({ tiles, touches, d });
          }
        }
        // merge parcels without road frontage into a neighbour that has it
        for (let gy = 0; gy < grid.length; gy++) for (let gx = 0; gx < grid[gy].length; gx++) {
          const pc = grid[gy][gx];
          if (pc.touches || pc.tiles.length === 0) continue;
          const nb = [grid[gy - 1]?.[gx], grid[gy + 1]?.[gx], grid[gy]?.[gx - 1], grid[gy]?.[gx + 1]].find((q) => q && q.touches);
          if (nb) { nb.tiles.push(...pc.tiles); pc.tiles = []; }
        }
        for (const row of grid) for (const pc of row) if (pc.touches && pc.tiles.length >= 8) parcels.push(pc);
      }
    }
    parcels.sort((a, b) => a.d + this.r.next() * 6 - (b.d + this.r.next() * 6));
    const wanted = this.c.farms;
    for (const pc of parcels) {
      if (this.farms.length >= wanted) break;
      this.mkFarm(pc);
    }
  }

  cuts(a: number, b: number): [number, number][] {
    const len = b - a + 1;
    const k = Math.max(1, Math.round(len / 5));
    const out: [number, number][] = [];
    for (let i = 0; i < k; i++) {
      const s = a + Math.floor((i * len) / k), e = a + Math.floor(((i + 1) * len) / k) - 1;
      out.push([s, e]);
    }
    return out;
  }

  mkFarm(pc: Parcel): void {
    const m = this.s.map;
    // farmhouse on the road-facing tile closest to town
    let houseTile = -1, bestD = Infinity;
    for (const i of pc.tiles) {
      if (this.roadNeighbor(i) < 0) continue;
      const d = Math.hypot((i % W) - this.cx, ((i / W) | 0) - this.cy);
      if (d < bestD) { bestD = d; houseTile = i; }
    }
    if (houseTile < 0) return;
    const fields = pc.tiles.filter((i) => i !== houseTile);
    const hx = houseTile % W, hy = (houseTile / W) | 0;
    const bl = this.mkBuilding('farmhouse', hx, hy, 1, 1, this.roadNeighbor(houseTile), 1);
    const sim = this.sim;
    const b = sim.newBusiness('farm', businessName(sim, 'farm'), bl.id, -1, false, 0, 'operating');
    b.founded = -this.r.int(12000);
    const ha = fields.length * HA_PER_TILE;
    let canal = false;
    for (const t of fields) {
      m.farm[t] = b.id;
      m.terrain[t] = Terrain.Farmland;
      const x = t % W, y = (t / W) | 0;
      for (let dy = -4; dy <= 4 && !canal; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (inMap(x + dx, y + dy) && m.terrain[idx(x + dx, y + dy)] === Terrain.Canal) { canal = true; break; }
      }
    }
    const well = this.r.chance(this.p.wells);
    // irrigated farms crop twice a year and can keep permanent hands; rain-fed farms rely on family and day labour
    const hands = Math.max(0, Math.round(canal || well ? ha / 2.5 : ha / 8));
    sim.addJobs(b, 'farmhand', hands);
    for (const j of b.jobs) j.wage *= 0.92 + 0.16 * this.r.next();
    b.capacity = hands + 3;
    b.farm = this.initialFarm(fields, ha, canal, well);
    bl.ownerT = 2; bl.ownerId = b.id;
    sim.addBusiness(b);
    this.farms.push(b);
  }

  initialFarm(fields: number[], ha: number, canal: boolean, well: boolean): FarmState {
    const r = this.r;
    const st: FarmState = {
      fields, ha, crop: null, phase: 'fallow', phaseDays: r.int(20), growth: 0, health: 1, moisture: 0.5, fertilizer: 0.8,
      irrigation: canal ? 0.9 : well ? 0.6 : 0, well, seasonCost: 0, seasonRevenue: 0, expected: 0, harvested: 0, waterToday: 0,
      stressDays: 0, disease: 0, insured: false, premium: 0, lastHarvest: null, plan: '', work: 0, lowland: false, losses: {},
    };
    const m = this.s.map;
    for (const t of fields) {
      const x = t % W, y = (t / W) | 0;
      for (let dy = -3; dy <= 3 && !st.lowland; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (!inMap(x + dx, y + dy)) continue;
        const tt = m.terrain[idx(x + dx, y + dy)];
        if (tt === Terrain.Water || tt === Terrain.Canal) { st.lowland = true; break; }
      }
      if (st.lowland) break;
    }
    const doy = dateOf(this.s.meta.startYear, 0).doy;
    const cands: { crop: CropId; growth: number; w: number }[] = [];
    for (const [crop, windows] of Object.entries(this.p.crops) as [CropId, [number, number][]][]) {
      const spec = CROPS[crop];
      for (const [a, b] of windows) {
        let dss: number;
        if (b - a > 300) dss = r.int(Math.round(spec.days * 0.9));
        else dss = mod(doy - Math.round((a + b) / 2), 365);
        if (dss > 330) continue;
        const sowDoy = mod(doy - dss, 365);
        const g = growthSince(this.p, crop, sowDoy, dss);
        if (g >= 0.97) continue;
        if (crop === 'rice' && st.irrigation < 0.5 && this.p.climate.rain[this.sim.date.month] < 60) continue;
        cands.push({ crop, growth: g, w: this.p.cropBias[crop] ?? 1 });
      }
    }
    if (cands.length && r.next() > 0.12) {
      const pick = r.weighted(cands, cands.map((c) => c.w));
      const spec = CROPS[pick.crop];
      st.crop = pick.crop;
      st.phase = 'growing';
      st.growth = pick.growth;
      st.health = 0.82 + 0.18 * r.next();
      st.fertilizer = 0.6 + 0.4 * r.next();
      st.moisture = 0.55;
      st.seasonCost = (spec.seed + spec.fert * 0.6) * this.sim.scale * ha;
      st.plan = `${spec.label} sown last season`;
    }
    return st;
  }

  // ------------------------------------------------------------------ housing stock
  placeHousing(): void {
    const m = this.s.map;
    const c = this.c;
    const farmPeople = this.farms.length * 5.4;
    const cityHH = Math.max(50, Math.round((c.population - farmPeople) / this.p.hhSize));
    const unitsTarget = Math.ceil(cityHH / (1 - c.vacancy));
    const aptTarget = unitsTarget * c.apartmentShare;
    let units = 0, aptUnits = 0;
    if (c.id === 'established' || c.id === 'industrial') {
      const bl = this.place('affordable', '', (this.cx + this.ind.x0) / 2, this.cy + 10, (i) => this.urban[i] === 1 && (m.zone[i] === Zone.Residential || m.zone[i] === Zone.Commercial), 20, 5);
      if (bl) { units += bl.units; aptUnits += bl.units; }
    }
    // luxury villas on the river bank / outer ring
    const lux = Math.max(2, Math.round(cityHH * 0.02));
    for (let k = 0; k < lux; k++) {
      const y = this.cy + this.r.int(this.R) - this.R / 2;
      const x = this.riverX[clamp(Math.round(y), 0, W - 1)] + 3 + this.r.int(4);
      const bl = this.place('luxury', '', x, y, (i) => this.urban[i] === 1 && m.zone[i] === Zone.Residential, 14);
      if (bl) units += bl.units;
    }
    const lots: { i: number; d: number; a: number }[] = [];
    for (let i = 0; i < N; i++) {
      if (!this.urban[i] || !this.free(i)) continue;
      const z = m.zone[i];
      if (z !== Zone.Residential && z !== Zone.Commercial) continue;
      const a = this.roadNeighbor(i);
      if (a < 0) continue;
      lots.push({ i, d: Math.hypot((i % W) - this.cx, ((i / W) | 0) - this.cy) + this.r.next() * 3, a });
    }
    lots.sort((p, q) => p.d - q.d);
    for (const lot of lots) {
      if (units >= unitsTarget) break;
      const x = lot.i % W, y = (lot.i / W) | 0;
      const z = m.zone[lot.i];
      if (!this.free(lot.i)) continue;
      if (aptUnits < aptTarget && (lot.d < this.R * 0.65 || z === Zone.Commercial)) {
        const bl = this.mkBuilding('apartment', x, y, 1, 1, lot.a, 4 + this.r.int(5));
        units += bl.units; aptUnits += bl.units;
      } else if (z === Zone.Residential) {
        const bl = this.mkBuilding('house', x, y, 1, 1, lot.a, this.r.chance(0.3) ? 2 : 1);
        units += bl.units;
      }
    }
    if (units < unitsTarget) {
      // not enough land in the urban core: densify with apartments on remaining lots
      for (const lot of lots) {
        if (units >= unitsTarget) break;
        if (!this.free(lot.i)) continue;
        const bl = this.mkBuilding('apartment', lot.i % W, (lot.i / W) | 0, 1, 1, lot.a, 6 + this.r.int(4));
        units += bl.units;
      }
    }
  }

  // ------------------------------------------------------------------ people
  sampleEdu(birthYear: number): { edu: number; field: Field } {
    const p = this.p, r = this.r;
    const cohort = birthYear + 22;
    const lit = clamp(p.literacy2026 - 0.011 * (2026 - cohort), 0.25, 0.995);
    const ter = p.tertiary2026 * clamp(1 - 0.022 * (2026 - cohort), 0.2, 1.3);
    const x = r.next();
    let edu = 0;
    if (x < ter) edu = 4;
    else if (x < ter + 0.07) edu = 3;
    else if (x < lit * 0.72) edu = 2;
    else if (x < lit) edu = 1;
    let field: Field = 'gen';
    if (edu === 4) field = r.weighted<Field>(['eng', 'biz', 'med', 'gen'], [0.32, 0.25, 0.12, 0.31]);
    else if (edu === 3) field = r.weighted<Field>(['trade', 'med', 'eng'], [0.55, 0.3, 0.15]);
    return { edu, field };
  }

  mkHousehold(): Household {
    const h: Household = {
      id: this.sim.newId(), members: [], home: -1, cash: 0, car: false, bike: false, owns: false, rent: 0,
      m: emptyHhLedger(), last: emptyHhLedger(), foodSec: 1, arrived: -this.r.int(8000), rentArrears: 0, unhappy: 0, incAvg: 0, ration: 0, leisure: 0.6,
    };
    this.sim.addHousehold(h);
    return h;
  }

  mkCitizen(h: Household, age: number, female: boolean, last: string): Citizen {
    const sim = this.sim, r = this.r, p = this.p;
    const born = -Math.round(age * 365.25);
    const birthYear = this.s.meta.startYear - age;
    const e = age >= 18 ? this.sampleEdu(birthYear) : { edu: 0, field: 'gen' as Field };
    const retire = this.s.gov.policies.retirementAge;
    let status: Citizen['status'];
    if (age < 6) status = 'child';
    else if (age < 18) status = 'student';
    else if (age >= retire) status = 'retired';
    else status = r.chance(female ? p.femaleLFP : age < 25 ? 0.8 : 0.92) ? 'unemployed' : 'inactive';
    const c: Citizen = {
      id: sim.newId(), first: firstName(sim, female), last, female, born, hh: h.id, edu: e.edu, field: e.field, status, school: -1,
      schoolYears: age >= 18 ? [0, 5, 10, 12, 15][e.edu] : Math.max(0, age - 6) * 0.85, studyLeft: 0,
      employer: -1, job: -1, wage: 0, exp: Math.max(0, age - 20) * 0.8, health: clamp(0.92 - age * 0.004 + r.normal() * 0.05, 0.3, 1),
      sat: 0.6, lean: clamp(r.normal() * 0.45, -1, 1), green: r.next() * 0.8, mode: 0, commute: 0, commuteKm: 0, unempDays: r.int(60), partner: -1, injured: 0,
    };
    sim.addCitizen(c);
    return c;
  }

  /** Rural joint family: parents, one or two grown children (sometimes married), grandchildren, an elder. */
  mkFarmFamily(h: Household, last: string): void {
    const r = this.r, p = this.p;
    const add = (age: number, female: boolean) => this.mkCitizen(h, age, female, last);
    const headAge = 42 + r.int(22);
    const head = add(headAge, r.chance(0.12));
    const spouse = add(clamp(headAge - 2 - r.int(6), 30, 80), !head.female);
    head.partner = spouse.id; spouse.partner = head.id;
    const grown = 1 + (r.chance(0.5) ? 1 : 0);
    for (let k = 0; k < grown; k++) {
      const age = clamp(headAge - 22 - r.int(8), 18, 40);
      const son = add(age, r.chance(0.35));
      if (!son.female && age >= 24 && r.chance(0.6)) {
        const dil = add(clamp(age - 1 - r.int(4), 19, 40), true);
        son.partner = dil.id; dil.partner = son.id;
        const kids = r.poisson(Math.max(0.3, p.tfr * 0.5));
        for (let q = 0; q < Math.min(3, kids); q++) add(r.int(Math.max(1, Math.min(14, age - 20))) + r.next(), r.chance(0.49));
      }
    }
    if (headAge < 50 && r.chance(0.6)) add(8 + r.int(9) + r.next(), r.chance(0.49));
    if (r.chance(p.elderWithFamily)) add(Math.min(92, headAge + 22 + r.int(10)), r.chance(0.65));
  }

  mkFamily(h: Household, type: 'family' | 'couple' | 'single' | 'elders' | 'parent', last: string): void {
    const r = this.r, p = this.p;
    const add = (age: number, female: boolean) => this.mkCitizen(h, age, female, last);
    const pair = (ha: number) => {
      const a = add(ha, false);
      const b = add(clamp(ha - 1 - r.int(6), 19, 90), true);
      a.partner = b.id; b.partner = a.id;
      return b;
    };
    const kids = (motherAge: number, n: number) => {
      for (let k = 0; k < n; k++) {
        const maxAge = Math.min(17, motherAge - 19);
        if (maxAge < 0) break;
        add(r.int(maxAge + 1) + r.next(), r.chance(0.49));
      }
    };
    switch (type) {
      case 'family': {
        const mother = pair(27 + r.int(28));
        const age = this.sim.age(mother);
        kids(age, Math.min(4, 1 + r.poisson(Math.max(0.2, p.tfr * 0.75 - 1))));
        if (r.chance(p.elderWithFamily)) add(62 + r.int(22), r.chance(0.65));
        break;
      }
      case 'couple': { const m = pair(23 + r.int(12)); if (r.chance(0.35)) kids(this.sim.age(m), 1); break; }
      case 'single': add(20 + r.int(22), r.chance(0.4)); break;
      case 'elders': pair(60 + r.int(22)); break;
      case 'parent': { const m = add(25 + r.int(20), r.chance(0.8)); kids(this.sim.age(m), 1 + r.int(2)); break; }
    }
  }

  populate(): void {
    const sim = this.sim, r = this.r, p = this.p, s = this.s;
    // farm families live on their farms and run them
    for (const f of this.farms) {
      const h = this.mkHousehold();
      const last = lastName(sim);
      this.mkFarmFamily(h, last);
      const bl = sim.bld(f.building)!;
      sim.moveIn(h, bl, true);
      bl.ownerT = 2; bl.ownerId = f.id;
      const members = h.members.map((id) => sim.cit(id)!);
      const head = members[0];
      head.status = 'owner'; head.employer = f.id; head.job = -1;
      f.owner = head.id;
      // the rest of the working-age family works the land too (unpaid family labour)
      for (const c of members) {
        const a = sim.age(c);
        if (c === head || a < 18 || a > 68) continue;
        c.status = 'owner'; c.employer = f.id; c.job = -1;
      }
      if (r.chance(0.5)) f.name = businessName(sim, 'farm', head.last);
    }
    // town households
    const cityTarget = this.c.population - s.citizens.length;
    const units = s.buildings.filter((b) => b.kind !== 'farmhouse').reduce((a, b) => a + b.units, 0);
    const maxHH = Math.floor(units * (1 - this.c.vacancy));
    let made = 0, hhCount = 0;
    while (made < cityTarget && hhCount < maxHH) {
      const h = this.mkHousehold();
      hhCount++;
      const x = r.next();
      const type = x < 0.62 ? 'family' : x < 0.74 ? 'couple' : x < 0.86 ? 'single' : x < 0.95 ? 'elders' : 'parent';
      this.mkFamily(h, type, lastName(sim));
      made += h.members.length;
    }
    // owners of private businesses
    const pool = s.citizens.filter((c) => c.status === 'unemployed' && c.edu >= 1);
    r.shuffle(pool);
    const takeOwner = (minEdu: number) => {
      const i = pool.findIndex((c) => c.edu >= minEdu && c.status === 'unemployed');
      return i >= 0 ? pool.splice(i, 1)[0] : undefined;
    };
    const realestate: Business[] = [];
    const nRe = Math.max(1, Math.round(s.buildings.filter((b) => b.kind === 'apartment').length / 12));
    for (let k = 0; k < nRe; k++) {
      const re = sim.newBusiness('realestate', businessName(sim, 'realestate'), -1, -1, false, 0, 'operating');
      sim.addBusiness(re);
      realestate.push(re);
    }
    for (const b of s.businesses) {
      if (b.pub || b.kind === 'farm') continue;
      const big = ['factory', 'foodplant', 'materials', 'logistics', 'construction'].includes(b.kind);
      if (big && r.chance(0.45)) { b.extOwned = true; continue; }
      const owner = takeOwner(b.kind === 'office' ? 4 : big ? 2 : 1);
      if (!owner) { b.extOwned = true; continue; }
      b.owner = owner.id;
      if (b.kind === 'realestate') continue;
      owner.status = 'owner'; owner.employer = b.id; owner.job = -1;
      if (r.chance(0.4) && !big) b.name = businessName(sim, b.kind, owner.last);
    }
    this.assignJobs();
    this.balanceJobs();
    this.pruneLabourSurplus();
    this.assignHousing(realestate);
    this.pruneVacantStock();
    // schools and colleges
    const college = s.businesses.find((b) => b.kind === 'college');
    for (const c of s.citizens) {
      const age = sim.age(c);
      if (college && age >= 18 && age < 22 && c.status === 'unemployed' && c.edu >= 2 && r.chance(0.35)) {
        c.status = 'student'; c.school = college.id; c.studyLeft = Math.round(r.range(100, 1300));
      }
    }
    // expected income (wages net of tax, plus business profits for owners), vehicles and savings
    const ownerOf = new Map<number, Business>();
    for (const b of s.businesses) if (b.owner >= 0 && !b.extOwned) ownerOf.set(b.owner, b);
    const ownerIncome = (b: Business) => {
      switch (b.kind) {
        case 'farm': return 9_000 * (1 + (b.farm?.ha ?? 2) / 2);
        case 'office': case 'factory': case 'foodplant': case 'materials': return 90_000;
        case 'construction': case 'logistics': return 60_000;
        case 'realestate': return 40_000;
        default: return 22_000;
      }
    };
    const inc = (h: Household) => h.members.reduce((a, id) => {
      const c = sim.cit(id);
      if (!c) return a;
      const own = ownerOf.get(c.id);
      return a + c.wage * 0.95 + (own ? ownerIncome(own) * sim.scale * this.c.wealth : 0);
    }, 0);
    const hhs = [...s.households];
    for (const h of hhs) h.incAvg = inc(h);
    hhs.sort((a, b) => b.incAvg - a.incAvg);
    const yearF = Math.max(0.25, 1 - 0.028 * Math.max(0, 2026 - s.meta.startYear));
    const carShare = p.car2026 * yearF, bikeShare = p.bike2026 * Math.max(0.4, yearF);
    hhs.forEach((h, k) => {
      const q = k / Math.max(1, hhs.length - 1);
      h.car = r.chance(Math.min(0.95, carShare * 2.5 * Math.pow(1 - q, 1.5)));
      h.bike = r.chance(Math.min(0.95, bikeShare));
      // savings of about four months' income on average; the richest tenth hold far more
      const income = Math.max(h.incAvg, 6000 * sim.scale);
      h.cash = income * this.c.wealth * (2.5 + 3 * r.next() + (q < 0.1 ? 6 : 0));
    });
    for (const c of s.citizens) sim.estimateCommute(c);
  }

  assignJobs(): void {
    const sim = this.sim, r = this.r, s = this.s;
    const labor = s.citizens.filter((c) => c.status === 'unemployed');
    const owners = s.citizens.filter((c) => c.status === 'owner').length;
    const maxHires = Math.max(0, labor.length - Math.round(this.c.unemployment * (labor.length + owners)));
    const buckets = new Map<string, Citizen[]>();
    for (const c of r.shuffle(labor)) {
      const key = `${c.edu}:${c.field}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(c);
    }
    const fields: Field[] = ['gen', 'eng', 'med', 'biz', 'trade'];
    const take = (minEdu: number, allowed?: Field[]) => {
      for (let e = minEdu; e <= 4; e++) {
        for (const f of r.shuffle([...(allowed ?? fields)])) {
          const b = buckets.get(`${e}:${f}`);
          if (b && b.length) return b.pop()!;
        }
      }
      return undefined;
    };
    const jobs: { b: Business; j: number; edu: number }[] = [];
    for (const b of s.businesses) b.jobs.forEach((jb, j) => jobs.push({ b, j, edu: ROLES[jb.role].edu }));
    r.shuffle(jobs);
    jobs.sort((a, b) => b.edu - a.edu);
    let hires = 0;
    for (const { b, j } of jobs) {
      if (hires >= maxHires) break;
      const role = ROLES[b.jobs[j].role];
      const c = take(role.edu, role.fields);
      if (!c) continue;
      sim.hire(b, j, c);
      c.exp = Math.max(c.exp, 1);
      hires++;
    }
  }

  /**
   * Expands the sectors whose demand does not depend on local spending (construction crews paid from maintenance
   * budgets, plant operators whose output is exported, irrigated farms) until unemployment is close to the
   * starting condition's level. Shops, services and hauliers are left at the size local demand supports.
   */
  balanceJobs(): void {
    const sim = this.sim, s = this.s, r = this.r;
    const unemployed = () => s.citizens.filter((c) => c.status === 'unemployed');
    const employed = s.citizens.filter((c) => c.status === 'working' || c.status === 'owner').length;
    let pool = r.shuffle(unemployed());
    const target = Math.round(this.c.unemployment * (pool.length + employed));
    let excess = pool.length - target;
    if (excess <= 0) return;
    const slots: { b: Business; role: RoleId; left: number }[] = [];
    for (const b of s.businesses) {
      const ops = b.jobs.filter((j) => j.role === 'operator').length;
      switch (b.kind) {
        case 'construction': slots.push({ b, role: 'laborer', left: 20 }); break;
        case 'foodplant': case 'materials': case 'factory': slots.push({ b, role: 'operator', left: Math.round(ops * 0.5) }); break;
        case 'farm': if (b.farm && b.farm.irrigation > 0) slots.push({ b, role: 'farmhand', left: 1 }); break;
      }
    }
    let progress = true;
    while (excess > 0 && progress) {
      progress = false;
      for (const sl of slots) {
        if (excess <= 0) break;
        if (sl.left <= 0) continue;
        const minEdu = ROLES[sl.role].edu;
        const k = pool.findIndex((c) => c.status === 'unemployed' && c.edu >= minEdu && c.edu <= minEdu + 2);
        if (k < 0) continue;
        const c = pool[k];
        pool.splice(k, 1);
        sim.addJobs(sl.b, sl.role, 1);
        sim.hire(sl.b, sl.b.jobs.length - 1, c);
        if (sl.role === 'driver' && sl.b.trucks) sl.b.trucks.push({ freeAt: 0 });
        sl.b.capacity = Math.max(sl.b.capacity, sl.b.jobs.length + 2);
        sl.left--;
        excess--;
        progress = true;
      }
    }
    // still too many job seekers: more small service businesses, run and staffed by local people
    const m = s.map;
    const okComRes = (i: number) => m.zone[i] === Zone.Commercial || m.zone[i] === Zone.Residential;
    let extra = 0;
    while (excess > 4 && extra < Math.round(this.c.population / 450)) {
      const [x, y] = this.randomUrbanPoint(0.8);
      const bl = this.place('services', 'services', x, y, okComRes, 25);
      if (!bl) break;
      extra++;
      const b = sim.biz(bl.biz)!;
      pool = unemployed();
      const owner = pool.find((c) => c.edu >= 1);
      if (owner) { b.owner = owner.id; owner.status = 'owner'; owner.employer = b.id; owner.job = -1; excess--; }
      b.jobs.forEach((jb, j) => {
        if (excess <= 0) return;
        const minEdu = ROLES[jb.role].edu;
        const c = unemployed().find((q) => q.edu >= minEdu && q.edu <= minEdu + 2);
        if (!c) return;
        sim.hire(b, j, c);
        excess--;
      });
    }
  }

  /**
   * A town only holds as many people as its economy supports. Households with no earner are dropped first,
   * then some second earners stop looking for work (discouraged workers), until unemployment is near target.
   */
  pruneLabourSurplus(): void {
    const sim = this.sim, s = this.s, r = this.r;
    const target = this.c.unemployment + 0.015;
    const rate = () => {
      let u = 0, e = 0;
      for (const c of s.citizens) { if (c.status === 'unemployed') u++; else if (c.status === 'working' || c.status === 'owner') e++; }
      return u / Math.max(1, u + e);
    };
    const farmHouseholds = new Set(this.farms.map((f) => sim.cit(f.owner)?.hh ?? -1));
    const noEarner = r.shuffle(s.households.filter((h) => !farmHouseholds.has(h.id) && h.members.every((id) => {
      const c = sim.cit(id)!;
      return c.status !== 'working' && c.status !== 'owner';
    }) && h.members.some((id) => sim.cit(id)!.status === 'unemployed')));
    for (const h of noEarner) {
      if (rate() <= target) break;
      sim.removeHousehold(h, 'ext');
    }
    if (rate() <= target) return;
    const seekers = r.shuffle(s.citizens.filter((c) => c.status === 'unemployed' && sim.hh(c.hh)!.members.some((id) => {
      const m = sim.cit(id)!;
      return m.id !== c.id && (m.status === 'working' || m.status === 'owner');
    })));
    let u = 0, e = 0;
    for (const c of s.citizens) { if (c.status === 'unemployed') u++; else if (c.status === 'working' || c.status === 'owner') e++; }
    for (const c of seekers) {
      if (u / Math.max(1, u + e) <= target) break;
      c.status = 'inactive';
      u--;
    }
  }

  /** Demolishes surplus empty dwellings (outermost first) so vacancy starts near the condition's level. */
  pruneVacantStock(): void {
    const sim = this.sim, s = this.s;
    const count = () => {
      let units = 0, occ = 0;
      for (const b of s.buildings) if (b.units > 0 && b.kind !== 'farmhouse') { units += b.units; occ += b.occupants.length; }
      return { units, occ };
    };
    const empty = s.buildings.filter((b) => (b.kind === 'house' || b.kind === 'apartment') && b.occupants.length === 0)
      .sort((a, b) => Math.hypot(b.x - this.cx, b.y - this.cy) - Math.hypot(a.x - this.cx, a.y - this.cy));
    for (const b of empty) {
      const { units, occ } = count();
      if (units - b.units <= 0 || (units - occ - b.units) / (units - b.units) < this.c.vacancy) continue;
      sim.removeBuilding(b);
    }
  }

  assignHousing(realestate: Business[]): void {
    const sim = this.sim, r = this.r, s = this.s;
    const inc = (h: Household) => h.members.reduce((a, id) => {
      const c = sim.cit(id)!;
      return a + c.wage + (c.status === 'owner' ? 35000 * sim.scale : 0);
    }, 0);
    const hhs = s.households.filter((h) => h.home < 0);
    hhs.sort((a, b) => inc(b) - inc(a));
    // fill dwellings from the centre outwards so surplus stock is left at the edge of town
    const pools: Record<string, Building[]> = { luxury: [], house: [], apartment: [], affordable: [] };
    const dist = (b: Building) => Math.hypot(b.x - this.cx, b.y - this.cy) + r.next() * 4;
    const order = [...s.buildings].map((b) => ({ b, d: dist(b) })).sort((a, b) => b.d - a.d).map((e) => e.b);
    for (const b of order) if (pools[b.kind]) for (let u = 0; u < b.units; u++) pools[b.kind].push(b);
    const landlords = hhs.slice(0, Math.max(1, Math.floor(hhs.length * 0.3)));
    hhs.forEach((h, k) => {
      const q = k / Math.max(1, hhs.length - 1);
      let order: string[];
      if (q < 0.02) order = ['luxury', 'house', 'apartment'];
      else if (q < 0.5) order = ['house', 'apartment', 'affordable', 'luxury'];
      else order = ['affordable', 'apartment', 'house', 'luxury'];
      if (q > 0.5 && r.chance(0.35)) order = ['house', 'apartment', 'affordable', 'luxury'];
      for (const kind of order) {
        const bl = pools[kind].pop();
        if (!bl) continue;
        let owns = false;
        if (kind === 'luxury') owns = true;
        else if (kind === 'house' && bl.occupants.length === 0 && bl.ownerT !== 1) owns = r.chance(q < 0.25 ? 0.8 : 0.5);
        sim.moveIn(h, bl, owns);
        if (owns) { bl.ownerT = 1; bl.ownerId = h.id; }
        break;
      }
    });
    // ownership of the rented stock
    for (const b of s.buildings) {
      if (b.kind === 'apartment') {
        const re = realestate.length ? r.pick(realestate) : undefined;
        if (re && r.chance(0.8)) { b.ownerT = 2; b.ownerId = re.id; } else { b.ownerT = 3; b.ownerId = -1; }
      } else if (b.kind === 'affordable') { b.ownerT = 0; b.ownerId = -1; }
      else if ((b.kind === 'house' || b.kind === 'luxury') && b.ownerT !== 1) {
        if (r.chance(0.6) && landlords.length) { b.ownerT = 1; b.ownerId = r.pick(landlords).id; }
        else { b.ownerT = 3; b.ownerId = -1; }
      }
      for (const hid of b.occupants) { const h = sim.hh(hid)!; h.rent = h.owns ? 0 : b.rent; }
    }
  }

  // ------------------------------------------------------------------ money & budgets
  finance(): void {
    const sim = this.sim, s = this.s, r = this.r;
    const sc = sim.scale * this.c.wealth;
    const cash: Partial<Record<BusinessKind, number>> = {
      grocery: 700_000, shop: 900_000, restaurant: 450_000, services: 350_000, office: 3_000_000, factory: 16_000_000, foodplant: 9_000_000, materials: 7_000_000,
      logistics: 5_000_000, construction: 6_000_000, realestate: 2_500_000, hotel: 2_000_000, cinema: 900_000,
    };
    // expected daily staples demand per grocery, used to stock shelves
    let foodKg = 0, vegKg = 0;
    for (const c of s.citizens) {
      const adult = sim.age(c) >= 12;
      foodKg += adult ? FOOD_NEED.adult : FOOD_NEED.child;
      vegKg += adult ? VEG_NEED.adult : VEG_NEED.child;
    }
    const groc = s.businesses.filter((b) => b.kind === 'grocery');
    for (const b of s.businesses) {
      if (b.pub) continue;
      if (b.farm) {
        b.cash = 120_000 * sc * (0.5 + b.farm.ha / 4) * (0.6 + 0.8 * r.next());
        continue;
      }
      b.cash = (cash[b.kind] ?? 500_000) * sc * (0.6 + 0.8 * r.next());
      switch (b.kind) {
        case 'grocery':
          b.inv.food = (foodKg / Math.max(1, groc.length)) * 10 / 1000;
          b.inv.vegetables = (vegKg / Math.max(1, groc.length)) * 3 / 1000;
          break;
        case 'restaurant': b.inv.food = 0.08; b.inv.vegetables = 0.05; break;
        case 'shop': b.inv.goods = 900; break;
        case 'foodplant': b.inv.wheat = 40; b.inv.food = 20; break;
        case 'factory': b.inv.goods = 2000; break;
        case 'materials': b.inv.materials = 60; break;
      }
    }
    // government departments start funded at the cost of their current staff and upkeep
    const need = {} as Record<Dept, number>;
    for (const d of DEPTS) need[d] = 0;
    for (const b of s.businesses) {
      const dept = BUSINESSES[b.kind].dept;
      if (!dept) continue;
      need[dept] += b.jobs.reduce((a, j) => a + j.wage, 0) * 1.2;
    }
    const m = s.map;
    let roadCost = 0, canals = 0;
    for (let i = 0; i < N; i++) {
      if (m.road[i]) roadCost += ROAD_MAINT[m.road[i]] * sim.scale;
      if (m.terrain[i] === Terrain.Canal) canals++;
    }
    const pop = s.citizens.length;
    need.transport += roadCost * 1.3 + (s.gov.policies.busService ? 110 * sim.scale * pop * s.gov.policies.busService : 0);
    need.agriculture += (600 * this.farms.length + 800 * canals) * sim.scale;
    need.environment += (25_000 + 10_000 * s.buildings.filter((b) => b.kind === 'park').length + 15_000 * s.businesses.filter((b) => ['factory', 'materials', 'foodplant'].includes(b.kind)).length) * sim.scale;
    need.culture += (15_000 + 60_000 * s.buildings.filter((b) => b.kind === 'heritage').length + 90_000 * s.businesses.filter((b) => b.kind === 'museum' || b.kind === 'stadium').length) * sim.scale;
    // departments start at full service; the player adjusts levels from there
    for (const d of DEPTS) {
      s.gov.level[d] = 1;
      s.gov.deptNeed[d] = need[d];
      s.gov.deptSpend[d] = need[d];
    }
  }
}
