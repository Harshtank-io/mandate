// The Sim object: world state + runtime indexes + helpers shared by every system.
// Systems communicate through the shared state and through emitted events (sim.emit), never by calling
// each other's internals directly.

import { dateOf, MIN_PER_DAY, type CalDate } from './calendar';
import { getPreset, moneyScale, type Preset } from './presets';
import { Rng } from './rng';
import { BUSINESSES, ROLES } from './tables';
import {
  MAP_SIZE, TILE,
  type Building, type Business, type BusinessKind, type Citizen, type ExpCat, type GovLedger, type Good, type HhLedger,
  type Household, type Ledger, type Project, type RevCat, type RoleId, type SimEvent, type StatsAcc, type WorldState,
} from './types';

export const W = MAP_SIZE;
export const idx = (x: number, y: number) => y * W + x;
export const tx = (i: number) => i % W;
export const ty = (i: number) => (i / W) | 0;
export const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < W;

export const REV_CATS: RevCat[] = ['incomeTax', 'corporateTax', 'smallBizTax', 'salesTax', 'foodTax', 'propertyTax', 'fuelTax', 'importTariff', 'exportTax', 'agriTax', 'luxuryTax', 'licenseFees', 'rents', 'fares', 'premiums', 'grants', 'tourismTax', 'entertainmentTax', 'airportFees', 'tickets', 'grainSales', 'other'];
export const EXP_CATS: ExpCat[] = ['admin', 'health', 'education', 'safety', 'transport', 'agriculture', 'environment', 'culture', 'unemployment', 'pensions', 'fertilizer', 'insurance', 'capital', 'interest', 'land', 'procurement', 'rations', 'transfers', 'exportSupport', 'promotion'];

export function emptyLedger(): Ledger {
  return { revenue: 0, cogs: 0, wages: 0, taxes: 0, other: 0, sales: 0, production: 0, unmet: 0 };
}
export function emptyHhLedger(): HhLedger {
  return { wages: 0, benefits: 0, dividends: 0, rent: 0, food: 0, goods: 0, services: 0, leisure: 0, transport: 0, taxes: 0, other: 0 };
}
export function emptyGovLedger(): GovLedger {
  const rev = {} as Record<RevCat, number>;
  for (const c of REV_CATS) rev[c] = 0;
  const exp = {} as Record<ExpCat, number>;
  for (const c of EXP_CATS) exp[c] = 0;
  return { rev, exp };
}
export function emptyAcc(): StatsAcc {
  return {
    births: 0, deaths: 0, immigrants: 0, emigrants: 0, opened: 0, closed: 0, harvest: {}, harvestNormal: {}, harvestLoss: {},
    fuelLitres: 0, industryCO2: 0, foodUnmet: 0, foodWanted: 0,
  };
}
export const sumRev = (l: GovLedger) => REV_CATS.reduce((a, c) => a + l.rev[c], 0);
export const sumExp = (l: GovLedger) => EXP_CATS.reduce((a, c) => a + l.exp[c], 0);

export interface Account { cash: number }

export interface StoreLists { grocery: number[]; shop: number[]; restaurant: number[]; services: number[]; cinema: number[] }

export class SimIndex {
  cit = new Map<number, Citizen>();
  hh = new Map<number, Household>();
  biz = new Map<number, Business>();
  bld = new Map<number, Building>();
  proj = new Map<number, Project>();
  ver = { buildings: 1, roads: 1, farms: 1, projects: 1, terrain: 1, zones: 1, shipments: 1 };
  storesDirty = true;
  stores = new Map<number, StoreLists>();
  roadsDirty = true; // only for worlds saved without travel times; afterwards times refresh eagerly
  pathCache = new Map<number, number[]>();
  /** Per-day retail throughput used against staff capacity (bizId -> value served today). */
  served = new Map<number, number>();
  /** Per-day sales by business and good, folded into Business.ema at the end of the day. */
  sold = new Map<number, Partial<Record<Good, number>>>();
  casualPool: number[] = []; // citizen ids available for casual day labour today
  casualUsed = 0;
  /** Businesses visitors use, nearest to where they stay and sightsee first (rebuilt with the store lists). */
  visitorStores: StoreLists | null = null;
}

export type EventListener = (e: SimEvent) => void;

export class Sim {
  s: WorldState;
  ix = new SimIndex();
  rng: Rng;
  preset: Preset;
  scale: number;
  day: number;
  date: CalDate;
  listeners = new Set<EventListener>();

  constructor(state: WorldState) {
    this.s = state;
    this.rng = new Rng(state.rng);
    this.preset = getPreset(state.meta.preset);
    this.scale = moneyScale(state.meta.preset, state.meta.startYear);
    this.day = Math.floor(state.minute / MIN_PER_DAY);
    this.date = dateOf(state.meta.startYear, this.day);
    this.reindex();
  }

  reindex(): void {
    const ix = this.ix;
    ix.cit.clear(); ix.hh.clear(); ix.biz.clear(); ix.bld.clear(); ix.proj.clear();
    for (const c of this.s.citizens) ix.cit.set(c.id, c);
    for (const h of this.s.households) ix.hh.set(h.id, h);
    for (const b of this.s.businesses) ix.biz.set(b.id, b);
    for (const b of this.s.buildings) ix.bld.set(b.id, b);
    for (const p of this.s.projects) ix.proj.set(p.id, p);
    ix.storesDirty = true;
    ix.roadsDirty = !(this.s.traffic.tileTime && this.s.traffic.tileTime.length === W * W);
    if (ix.roadsDirty) this.s.traffic.tileTime = new Array(W * W).fill(0);
    for (const k of Object.keys(ix.ver) as (keyof SimIndex['ver'])[]) ix.ver[k]++;
  }

  get gov() { return this.s.gov; }
  get minute() { return this.s.minute; }
  get timeOfDay() { return this.s.minute - this.day * MIN_PER_DAY; }

  newId(): number { return this.s.nextId++; }

  // ---------------------------------------------------------------- events
  emit(type: string, text: string, sev = 1, ref?: SimEvent['ref'], causes?: number[], why?: string[]): SimEvent {
    const e: SimEvent = { id: this.newId(), day: this.day, type, text, sev };
    if (ref) e.ref = ref;
    if (causes && causes.length) e.causes = causes;
    if (why && why.length) e.why = why;
    this.s.events.push(e);
    if (this.s.events.length > 800) this.s.events.splice(0, this.s.events.length - 800);
    for (const l of this.listeners) l(e);
    return e;
  }

  findEvent(id: number): SimEvent | undefined {
    const ev = this.s.events;
    for (let i = ev.length - 1; i >= 0; i--) if (ev[i].id === id) return ev[i];
    return undefined;
  }

  /** Most recent event of a type within `days`. */
  recentEvent(type: string, days: number): SimEvent | undefined {
    const ev = this.s.events;
    for (let i = ev.length - 1; i >= 0; i--) {
      if (this.day - ev[i].day > days) break;
      if (ev[i].type === type) return ev[i];
    }
    return undefined;
  }

  // ---------------------------------------------------------------- money
  pay(from: Account, to: Account, amt: number): void {
    if (!(amt > 0)) return;
    from.cash -= amt;
    to.cash += amt;
  }

  /** Money flowing to the government, recorded by revenue category. */
  tax(cat: RevCat, from: Account, amt: number): number {
    if (!(amt > 0)) return 0;
    const g = this.s.gov;
    from.cash -= amt;
    g.cash += amt;
    g.m.rev[cat] += amt;
    g.ytd.rev[cat] += amt;
    g.total.rev += amt;
    return amt;
  }

  /** Government spending recorded by expense category. */
  spend(cat: ExpCat, to: Account, amt: number): void {
    if (!(amt > 0)) return;
    const g = this.s.gov;
    g.cash -= amt;
    to.cash += amt;
    g.m.exp[cat] += amt;
    g.ytd.exp[cat] += amt;
    g.total.exp += amt;
  }

  // ---------------------------------------------------------------- prices and wages
  /** Converts a base (INR 2026) value to current local currency. */
  nominal(base: number): number { return base * this.scale * this.s.ext.trend; }

  worldPrice(g: Good): number { return this.s.ext.prices[g]; }

  roleWage(role: RoleId): number {
    const r = ROLES[role];
    const w = r.wage * this.scale * this.s.ext.trend * this.s.labor.wage[r.edu];
    return Math.max(w, this.s.gov.policies.minWage);
  }

  fuelPrice(): number { return this.s.ext.fuel * (1 + this.s.gov.taxes.fuel); }

  isWorkDay(): boolean { return this.date.dow !== 0; }

  /**
   * How much a town founded on empty land is still a frontier settlement: 1 at the start, falling to 0 as it passes
   * 3,000 residents. Towns that existed when the world was created are never frontiers.
   */
  frontier(): number {
    return this.s.meta.condition === 'empty' ? Math.max(0, 1 - this.s.citizens.length / 3000) : 0;
  }

  // ---------------------------------------------------------------- lookups
  cit(id: number) { return this.ix.cit.get(id); }
  hh(id: number) { return this.ix.hh.get(id); }
  biz(id: number) { return this.ix.biz.get(id); }
  bld(id: number) { return this.ix.bld.get(id); }

  age(c: Citizen): number { return (this.day - c.born) / 365.25; }

  fullName(c: Citizen): string {
    return this.preset.familyFirst ? `${c.last} ${c.first}` : `${c.first} ${c.last}`;
  }

  /** Centre of a building in tile coordinates. */
  center(b: Building): [number, number] { return [b.x + b.w / 2, b.y + b.h / 2]; }

  homeOf(c: Citizen): Building | undefined {
    const h = this.ix.hh.get(c.hh);
    return h && h.home >= 0 ? this.ix.bld.get(h.home) : undefined;
  }

  workplaceOf(c: Citizen): Building | undefined {
    const id = c.employer >= 0 ? c.employer : c.school;
    if (id < 0) return undefined;
    const b = this.ix.biz.get(id);
    return b ? this.ix.bld.get(b.building) : undefined;
  }

  // ---------------------------------------------------------------- entity management
  addBuilding(b: Building): Building {
    this.s.buildings.push(b);
    this.ix.bld.set(b.id, b);
    const m = this.s.map;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) m.owner[idx(x, y)] = b.id;
    this.ix.ver.buildings++;
    this.ix.storesDirty = true;
    return b;
  }

  removeBuilding(b: Building): void {
    for (const hid of [...b.occupants]) { const h = this.hh(hid); if (h) this.moveOut(h); }
    const m = this.s.map;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (m.owner[idx(x, y)] === b.id) m.owner[idx(x, y)] = -1;
    const i = this.s.buildings.indexOf(b);
    if (i >= 0) this.s.buildings.splice(i, 1);
    this.ix.bld.delete(b.id);
    this.ix.ver.buildings++;
    this.ix.storesDirty = true;
  }

  addBusiness(b: Business): Business {
    this.s.businesses.push(b);
    this.ix.biz.set(b.id, b);
    const bl = this.bld(b.building);
    if (bl) bl.biz = b.id;
    this.ix.storesDirty = true;
    this.ix.ver.buildings++;
    return b;
  }

  newBusiness(kind: BusinessKind, name: string, building: number, owner: number, extOwned: boolean, cash: number, status: Business['status']): Business {
    const spec = BUSINESSES[kind];
    const b: Business = {
      id: this.newId(), name, kind, pub: spec.pub, owner, extOwned, building, status, statusDay: this.day, founded: this.day,
      jobs: [], cash, loan: 0, inv: {}, transit: {}, capacity: 0, m: emptyLedger(), last: emptyLedger(), profitHist: [],
      revHist: [], costHist: [], ema: {}, lossMonths: 0, taxesTotal: 0, quality: 1, downDays: 0, reason: '',
    };
    return b;
  }

  closeBusiness(b: Business, reason: string, causes?: number[]): SimEvent | undefined {
    if (b.status === 'closed') return undefined;
    const laid = b.jobs.filter((j) => j.worker >= 0).length;
    for (const j of b.jobs) {
      if (j.worker >= 0) { const c = this.cit(j.worker); if (c) this.leaveJob(c); }
    }
    b.jobs = [];
    const owner = b.owner >= 0 ? this.cit(b.owner) : undefined;
    // settle the balance sheet: positive cash to the owner, losses absorbed by creditors outside the city
    if (b.cash > 0) {
      const oh = owner ? this.hh(owner.hh) : undefined;
      this.pay(b, oh ?? this.s.ext, b.cash);
    } else if (b.cash < 0) {
      this.pay(this.s.ext, b, -b.cash);
    }
    b.loan = 0;
    // the owner and any family members working in the business are now out of work
    const oh = owner ? this.hh(owner.hh) : undefined;
    for (const id of oh ? oh.members : []) {
      const c = this.cit(id);
      if (c && c.employer === b.id && c.status === 'owner') { c.status = 'unemployed'; c.employer = -1; c.job = -1; c.unempDays = 0; }
    }
    b.status = 'closed';
    b.statusDay = this.day;
    const bl = this.bld(b.building);
    if (bl) {
      bl.biz = -1;
      if (b.kind !== 'farm') { bl.ownerT = 3; bl.ownerId = -1; }
    }
    if (b.farm) {
      for (const t of b.farm.fields) if (this.s.map.farm[t] === b.id) this.s.map.farm[t] = -1;
      this.ix.ver.farms++;
    }
    // cancel orders in transit to this business
    for (const sh of this.s.shipments) if (sh.to === b.id) sh.to = -2;
    const i = this.s.businesses.indexOf(b);
    if (i >= 0) this.s.businesses.splice(i, 1);
    this.ix.biz.delete(b.id);
    this.ix.storesDirty = true;
    this.ix.ver.buildings++;
    this.s.stats.acc.closed++;
    return this.emit('business.closed', `${b.name} closed${laid ? `, ${laid} jobs lost` : ''}. ${reason}`, laid >= 20 ? 3 : laid >= 5 ? 2 : 1,
      bl ? { k: 'building', id: bl.id } : undefined, causes, [reason]);
  }

  addJobs(b: Business, role: RoleId, n: number): void {
    for (let i = 0; i < n; i++) b.jobs.push({ role, wage: this.roleWage(role), worker: -1 });
  }

  hire(b: Business, jobIdx: number, c: Citizen): void {
    if (c.employer >= 0) this.leaveJob(c);
    const j = b.jobs[jobIdx];
    j.worker = c.id;
    j.wage = Math.max(j.wage, this.s.gov.policies.minWage);
    c.employer = b.id;
    c.job = jobIdx;
    c.wage = j.wage;
    c.status = 'working';
    c.unempDays = 0;
    this.estimateCommute(c);
  }

  leaveJob(c: Citizen, status: Citizen['status'] = 'unemployed'): void {
    if (c.employer >= 0) {
      const b = this.biz(c.employer);
      if (b && c.job >= 0 && b.jobs[c.job] && b.jobs[c.job].worker === c.id) b.jobs[c.job].worker = -1;
    }
    c.employer = -1;
    c.job = -1;
    c.wage = 0;
    if (c.status === 'working' || c.status === 'owner') c.status = status;
    c.unempDays = 0;
  }

  /** Remove a job slot and keep worker job indices consistent. */
  removeJob(b: Business, jobIdx: number): void {
    const j = b.jobs[jobIdx];
    if (j.worker >= 0) { const c = this.cit(j.worker); if (c) this.leaveJob(c); }
    b.jobs.splice(jobIdx, 1);
    for (let k = jobIdx; k < b.jobs.length; k++) {
      const w = b.jobs[k].worker;
      if (w >= 0) { const c = this.cit(w); if (c) c.job = k; }
    }
  }

  addHousehold(h: Household): void {
    this.s.households.push(h);
    this.ix.hh.set(h.id, h);
  }

  addCitizen(c: Citizen): void {
    this.s.citizens.push(c);
    this.ix.cit.set(c.id, c);
    const h = this.hh(c.hh);
    if (h && !h.members.includes(c.id)) h.members.push(c.id);
  }

  moveIn(h: Household, b: Building, owns = false): void {
    if (h.home >= 0) this.moveOut(h);
    b.occupants.push(h.id);
    h.home = b.id;
    h.owns = owns;
    h.rent = owns ? 0 : b.rent;
    h.rentArrears = 0;
    for (const id of h.members) { const c = this.cit(id); if (c) this.estimateCommute(c); }
  }

  moveOut(h: Household): void {
    if (h.home < 0) return;
    const b = this.bld(h.home);
    if (b) {
      const i = b.occupants.indexOf(h.id);
      if (i >= 0) b.occupants.splice(i, 1);
      if (h.owns && b.ownerT === 1 && b.ownerId === h.id) { b.ownerT = 3; b.ownerId = -1; }
    }
    h.home = -1;
    h.owns = false;
    h.rent = 0;
  }

  /** Citizen-level cleanup shared by deaths and departures (does not touch the household record). */
  private detachCitizen(c: Citizen, why: 'death' | 'emigration'): void {
    this.leaveJob(c, 'inactive');
    c.school = -1;
    // business ownership passes to the partner, otherwise the business is sold to outside investors
    for (const b of this.s.businesses) {
      if (b.owner === c.id) {
        const p = c.partner >= 0 ? this.cit(c.partner) : undefined;
        if (p && why === 'death' && this.age(p) >= 18) {
          if (p.employer >= 0) this.leaveJob(p);
          b.owner = p.id; p.status = 'owner'; p.employer = b.id; p.job = -1;
        } else { b.owner = -1; b.extOwned = true; }
      }
    }
    if (c.partner >= 0) { const p = this.cit(c.partner); if (p) p.partner = -1; }
    const i = this.s.citizens.indexOf(c);
    if (i >= 0) this.s.citizens.splice(i, 1);
    this.ix.cit.delete(c.id);
  }

  /** Removes a citizen. The household keeps its cash unless it is the last member. */
  removeCitizen(c: Citizen, why: 'death' | 'emigration'): void {
    const h = this.hh(c.hh);
    this.detachCitizen(c, why);
    if (h) {
      const i = h.members.indexOf(c.id);
      if (i >= 0) h.members.splice(i, 1);
      if (h.members.length === 0) this.removeHousehold(h, why === 'death' ? 'estate' : 'ext');
    }
  }

  removeHousehold(h: Household, cashTo: 'estate' | 'ext'): void {
    for (const id of h.members) {
      const c = this.cit(id);
      if (c) this.detachCitizen(c, 'emigration');
    }
    h.members = [];
    // properties owned by the household pass to outside owners
    for (const b of this.s.buildings) if (b.ownerT === 1 && b.ownerId === h.id) { b.ownerT = 3; b.ownerId = -1; }
    this.moveOut(h);
    if (h.cash > 0) {
      if (cashTo === 'estate') this.tax('other', h, h.cash);
      else this.pay(h, this.s.ext, h.cash);
    } else if (h.cash < 0) this.pay(this.s.ext, h, -h.cash);
    const i = this.s.households.indexOf(h);
    if (i >= 0) this.s.households.splice(i, 1);
    this.ix.hh.delete(h.id);
  }

  // ---------------------------------------------------------------- geometry & commuting
  dist(a: Building, b: Building): number {
    const [ax, ay] = this.center(a);
    const [bx, by] = this.center(b);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  /** Quick commute estimate (updated precisely by the traffic model). */
  estimateCommute(c: Citizen): void {
    const home = this.homeOf(c);
    const work = this.workplaceOf(c);
    if (!home || !work || (c.status === 'owner' && work.id === home.id)) { c.mode = 0; c.commute = 0; c.commuteKm = 0; return; }
    const km = (this.dist(home, work) * TILE) / 1000 * 1.2;
    c.commuteKm = km;
    const h = this.hh(c.hh);
    c.mode = chooseMode(km, !!h?.car, !!h?.bike, this.s.gov.policies.busService, this.age(c));
    c.commute = travelMinutes(km, c.mode, 1);
  }
}

export function chooseMode(km: number, car: boolean, bike: boolean, bus: number, age: number): number {
  if (km < 1.2) return 1;
  if (car && age >= 18) return 3;
  if (bike && age >= 16 && km < 15) return 2;
  if (bus > 0 && km > 1.8) return 4;
  return 1;
}

/** One-way minutes for a trip. `congestion` multiplies motorised in-vehicle time. */
export function travelMinutes(km: number, mode: number, congestion: number): number {
  switch (mode) {
    case 1: return (km / 4.8) * 60;
    case 2: return 3 + (km / 28) * 60 * congestion;
    case 3: return 5 + (km / 32) * 60 * congestion;
    case 4: return 12 + (km / 18) * 60 * congestion;
    default: return 0;
  }
}
