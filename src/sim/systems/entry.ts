// New businesses. Local entrepreneurs open shops where customers are going unserved; investors build plants and
// offices when the numbers work: prices, wages, taxes, available workers, regulation and land all matter.

import { idx, W, type Sim } from '../core';
import { businessName } from '../names';
import { BUILDINGS, BUSINESSES } from '../tables';
import { Terrain, Zone, type Building, type Business, type BusinessKind, type Citizen } from '../types';
import { createProject, estimate } from './construction';
import { rebuildStores } from './households';
import { findLot } from './housing';
import { freightPerUnit } from './logistics';

const nominalOf = (sim: Sim) => sim.scale * sim.s.ext.trend;

function vacantBuilding(sim: Sim, kinds: string[], near: [number, number] | null, maxD = 14): Building | undefined {
  let best: Building | undefined, bd = maxD;
  for (const b of sim.s.buildings) {
    if (b.biz >= 0 || !kinds.includes(b.kind) || sim.s.map.project[idx(b.x, b.y)] >= 0) continue;
    const [x, y] = sim.center(b);
    const d = near ? Math.abs(x - near[0]) + Math.abs(y - near[1]) : 0;
    if (d < bd || !near) { bd = d; best = b; if (!near) break; }
  }
  return best;
}

function entrepreneur(sim: Sim, capital: number): Citizen | undefined {
  const s = sim.s, r = sim.rng;
  for (let k = 0; k < 300; k++) {
    const c = s.citizens[r.int(s.citizens.length)];
    if (!c || (c.status !== 'unemployed' && c.status !== 'working') || c.edu < 1) continue;
    const a = sim.age(c);
    if (a < 24 || a > 58) continue;
    if (s.businesses.some((b) => b.owner === c.id)) continue;
    const h = sim.hh(c.hh);
    if (h && h.cash >= capital * 0.25) return c;
  }
  return undefined;
}

/** Sets up a new business, reusing vacant premises when possible, otherwise commissioning a building. */
function open(sim: Sim, kind: BusinessKind, near: [number, number] | null, owner: Citizen | undefined, reason: string, zones: number[], w = 1, h = 1, floors?: number): Business | undefined {
  const s = sim.s;
  const spec = BUSINESSES[kind];
  const bkind = spec.building as keyof typeof BUILDINGS;
  const nominal = nominalOf(sim);
  const retail = ['grocery', 'shop', 'restaurant', 'services'];
  const reuse = vacantBuilding(sim, retail.includes(kind) ? retail : [bkind], near, retail.includes(kind) ? 14 : 200);
  let lot: { x: number; y: number } | null = null;
  if (!reuse) {
    lot = findLot(sim, zones, w, h);
    if (!lot) return undefined;
  }
  const est = reuse ? null : estimate(sim, bkind, [idx(lot!.x, lot!.y)], kind === 'office' ? 6 : floors, false);
  const capital = spec.startup * nominal + (reuse ? reuse.value : est!.cost);
  const b = sim.newBusiness(kind, businessName(sim, kind, owner?.last), reuse ? reuse.id : -1, owner ? owner.id : -1, !owner, 0, reuse ? 'registering' : 'planned');
  b.reason = reason;
  // finance: owner's equity, the rest borrowed from outside lenders or brought in by investors
  if (owner) {
    const oh = sim.hh(owner.hh)!;
    const equity = Math.min(oh.cash * 0.5, capital * 0.5);
    sim.pay(oh, b, equity);
    const loan = capital - equity + spec.startup * nominal * 0.5;
    sim.pay(s.ext, b, loan);
    b.loan = loan;
  } else sim.pay(s.ext, b, capital + spec.startup * nominal * 0.5);
  for (const [role, n] of spec.jobs) sim.addJobs(b, role, kind === 'office' ? n : n);
  b.capacity = Math.round(b.jobs.length * 1.6);
  if (kind === 'logistics') b.trucks = b.jobs.filter((j) => j.role === 'driver').map(() => ({ freeAt: 0 }));
  if (reuse) {
    // buy the premises from their outside owner
    sim.pay(b, s.ext, reuse.value);
    reuse.ownerT = 2; reuse.ownerId = b.id;
    if (retail.includes(kind) && reuse.kind !== bkind) { reuse.kind = bkind as Building['kind']; sim.ix.ver.buildings++; }
  }
  sim.addBusiness(b);
  if (!reuse && lot) {
    const bs = BUILDINGS[bkind];
    createProject(sim, { kind: bkind, x: lot.x, y: lot.y, w: bs.w, h: bs.h, floors: kind === 'office' ? 6 : floors, gov: false, sponsor: b.id, bizKind: kind, bizId: b.id, name: `${b.name} (${bs.label.toLowerCase()})`, reason });
  }
  return b;
}

function retailEntry(sim: Sim, kind: 'grocery' | 'shop' | 'restaurant' | 'services'): void {
  const s = sim.s, r = sim.rng;
  const nominal = nominalOf(sim);
  const all = s.businesses.filter((b) => b.kind === kind);
  if (all.filter((b) => b.status !== 'operating').length >= 2) return;
  const ops = all.filter((b) => b.status === 'operating');
  let unmet = 0, top: Business | undefined;
  for (const b of ops) { unmet += b.last.unmet; if (!top || b.last.unmet > top.last.unmet) top = b; }
  const informal = kind === 'grocery' ? s.stats.acc.foodUnmet * (s.market.food.price / 1000) * 1.2 : 0;
  // residents far from any store of this kind
  if (sim.ix.storesDirty) rebuildStores(sim);
  let far = 0, farAt: [number, number] | null = null, farMax = 0;
  for (const bl of s.buildings) {
    if (bl.units <= 0 || !bl.occupants.length) continue;
    const st = sim.ix.stores.get(bl.id);
    const nearest = st?.[kind][0] !== undefined ? sim.bld(sim.biz(st[kind][0])?.building ?? -1) : undefined;
    const d = nearest ? sim.dist(bl, nearest) : 99;
    if (d > 16) { far += bl.occupants.length; if (d > farMax) { farMax = d; farAt = sim.center(bl); } }
  }
  const minRev = { grocery: 450_000, shop: 500_000, restaurant: 300_000, services: 200_000 }[kind] * nominal;
  const signal = unmet + informal;
  // strong profits attract competitors even when nobody is being turned away
  const recent = (b: Business) => { const h = b.profitHist.slice(-3); return h.length ? h.reduce((a, x) => a + x, 0) / h.length : 0; };
  const avgProfit = ops.length ? ops.reduce((a, b) => a + recent(b), 0) / ops.length : 0;
  const rich = ops.length > 0 && avgProfit > 2.5 * sim.roleWage('supervisor');
  if (signal < minRev * 0.35 && far < 60 && !rich) return;
  const ease = [1, 0.8, 0.55][s.gov.policies.businessRegulation];
  if (!r.chance(0.5 * ease)) return;
  const topBl = top ? sim.bld(top.building) : undefined;
  let near = far >= 60 && farAt ? farAt : topBl ? sim.center(topBl) : null;
  if (rich && signal < minRev * 0.35 && far < 60) {
    const homes = s.buildings.filter((b) => b.occupants.length > 0);
    if (homes.length) near = sim.center(r.pick(homes));
  }
  const capital = BUSINESSES[kind].startup * nominal + BUILDINGS[kind].cost * nominal;
  const owner = entrepreneur(sim, capital);
  if (!owner) return;
  const label = BUSINESSES[kind].label.toLowerCase();
  const why = far >= 60 ? `About ${far} households live more than 600 m from the nearest ${label}`
    : signal >= minRev * 0.35 ? `Existing ${label}s turned away customers worth ${Math.round(signal / nominal / 1000)}K a month`
      : `Existing ${label}s are earning strong profits`;
  const b = open(sim, kind, near, owner, why, [Zone.Commercial, Zone.Residential]);
  if (b) sim.emit('business.planned', `${sim.fullName(owner)} is opening ${b.name}. ${why}.`, 1, b.building >= 0 ? { k: 'building', id: b.building } : undefined, undefined, [why]);
}

interface ProForma { roi: number; reasons: string[]; jobs: number }

function laborAvailability(sim: Sim, minEdu: number, fields?: string[]): number {
  let n = 0;
  for (const c of sim.s.citizens) if (c.status === 'unemployed' && c.edu >= minEdu && (!fields || fields.includes(c.field))) n++;
  return n;
}

function freeHomes(sim: Sim): number {
  let n = 0;
  for (const b of sim.s.buildings) if (b.units > 0 && b.kind !== 'farmhouse') n += Math.max(0, b.units - b.occupants.length);
  return n;
}

function proForma(sim: Sim, kind: BusinessKind): ProForma | null {
  const s = sim.s, t = s.gov.taxes, nominal = nominalOf(sim);
  const spec = BUSINESSES[kind];
  const jobs = spec.jobs.reduce((a, [, n]) => a + n, 0);
  const wages = spec.jobs.reduce((a, [r, n]) => a + sim.roleWage(r) * n, 0);
  const bs = spec.building ? BUILDINGS[spec.building] : null;
  const capital = bs ? ((bs.perFloor ? bs.cost * 6 : bs.cost) + bs.equipment) * nominal + spec.startup * nominal : spec.startup * nominal;
  const homes = freeHomes(sim);
  const reasons: string[] = [];
  let monthly = 0;
  let labor = 1;
  switch (kind) {
    case 'factory': {
      const out = 40 * 3.5 * 26 * 0.9;
      const world = s.ext.prices.goods;
      const sell = Math.max(s.market.goods.price, world * (1 - t.export) - freightPerUnit(sim, 'goods', 60));
      const unit = 0.5 * world * (1 + t.import) + 40 * nominal;
      monthly = out * (sell - unit) - wages - capital * 0.0012;
      const avail = laborAvailability(sim, 1) + homes * 0.6;
      labor = Math.min(1, avail / jobs);
      reasons.push(`Goods sell for ${Math.round((sell / unit - 1) * 100)}% above component costs (import tariff ${Math.round(t.import * 100)}%)`, `${Math.round(avail)} potential workers`);
      break;
    }
    case 'foodplant': {
      const out = 22 * 0.5 * 26 * 0.9;
      const grain = Math.min(s.market.wheat.price, s.market.maize.price, s.market.rice.price);
      const food = s.market.food.price;
      monthly = out * (food - grain * 1.25 - 900 * nominal) - wages - capital * 0.0012;
      const avail = laborAvailability(sim, 1) + homes * 0.6;
      labor = Math.min(1, avail / jobs);
      const surplus = ['wheat', 'rice', 'maize'].reduce((a, g) => a + s.market[g as 'wheat'].lastExported, 0);
      reasons.push(surplus > 20 ? `Local farms exported ${Math.round(surplus)} t of grain last month` : 'Grain is available at world prices', `Packaged food sells at ${Math.round((food / (grain * 1.25) - 1) * 100)}% over grain cost`);
      break;
    }
    case 'materials': {
      const out = 18 * 0.5 * 26 * 0.9;
      const world = s.ext.prices.materials;
      const sell = Math.max(s.market.materials.price, world * (1 - t.export) - freightPerUnit(sim, 'materials', 60));
      monthly = out * (sell - 0.2 * world - 9 * sim.fuelPrice()) - wages - capital * 0.0012;
      labor = Math.min(1, (laborAvailability(sim, 1) + homes * 0.6) / jobs);
      const building = s.projects.filter((p) => p.phase === 'construction').length;
      reasons.push(`${building} construction sites need materials`, `Fuel costs ${Math.round(sim.fuelPrice())} per litre`);
      break;
    }
    case 'office': {
      const rev = (5 * 4200 + 3 * 3300 + 3 * 1500 + 2200) * 22 * nominal * s.ext.demand * 0.95;
      monthly = rev - wages - 12 * 250 * 22 * nominal - capital * 0.001;
      const grads = laborAvailability(sim, 4, ['eng', 'biz']);
      labor = Math.min(1, (grads + homes * 0.25) / 8);
      reasons.push(`${grads} unemployed engineering and business graduates`, s.ext.phase === 'recession' ? 'Global demand for services is weak' : 'Steady demand for outsourced services');
      break;
    }
    case 'logistics': {
      let late = 0;
      for (const sh of s.shipments) if (sh.purpose === 'supply' && sh.depart - s.minute > 1440) late++;
      if (late < 4) return null;
      monthly = wages * 0.25;
      reasons.push(`${late} deliveries are waiting for a free truck`);
      break;
    }
    case 'construction': {
      const starved = s.projects.filter((p) => p.phase === 'construction' && (p.issue.startsWith('No construction') || p.issue.startsWith('Contractor has no'))).length;
      if (starved < 1) return null;
      monthly = wages * 0.3;
      reasons.push(`${starved} building sites are waiting for a contractor`);
      break;
    }
    default: return null;
  }
  const rate = kind === 'logistics' || kind === 'construction' ? t.smallBusiness : t.corporate;
  const after = monthly > 0 ? monthly * (1 - rate) : monthly;
  reasons.push(`Corporate tax ${Math.round(t.corporate * 100)}%`);
  const roi = ((after * 12) / Math.max(1, capital)) * labor;
  return { roi, reasons, jobs };
}

const BASE_P: Partial<Record<BusinessKind, number>> = { factory: 0.12, foodplant: 0.1, materials: 0.08, office: 0.12, logistics: 0.3, construction: 0.3 };

function invest(sim: Sim, kind: BusinessKind): void {
  const s = sim.s, r = sim.rng;
  if (s.businesses.some((b) => b.kind === kind && (b.status === 'planned' || b.status === 'registering' || b.status === 'licensing'))) return;
  const pf = proForma(sim, kind);
  if (!pf) return;
  const hurdle = 0.12 + [0, 0.01, 0.03][s.gov.policies.businessRegulation] + (s.gov.arrears > 0 ? 0.05 : 0) + (s.gov.rating === 'B' ? 0.02 : 0);
  const p = (BASE_P[kind] ?? 0.05) / (1 + Math.exp(-(pf.roi - hurdle) / 0.03));
  if (!r.chance(p)) return;
  const bs = BUILDINGS[BUSINESSES[kind].building as keyof typeof BUILDINGS];
  const local = r.chance(0.45) ? entrepreneur(sim, (bs.cost + bs.equipment) * nominalOf(sim) * 0.5) : undefined;
  const zones = kind === 'office' ? [Zone.Commercial] : [Zone.Industrial];
  const reason = pf.reasons.join('; ');
  const b = open(sim, kind, null, local, reason, zones, bs.w, bs.h);
  if (!b) {
    if (!sim.recentEvent('investment.noSite', 150))
      sim.emit('investment.noSite', `An investor looked at building a ${BUSINESSES[kind].label.toLowerCase()} but found no suitable ${kind === 'office' ? 'commercial' : 'industrial'} land.`, 2, undefined, undefined,
        [...pf.reasons, 'Zone more land or extend roads to create sites']);
    return;
  }
  sim.emit('investment.announced', `${b.name} will ${b.status === 'planned' ? 'build' : 'open'} a ${BUSINESSES[kind].label.toLowerCase()} here, creating about ${pf.jobs} jobs.`,
    pf.jobs >= 30 ? 3 : 2, b.building >= 0 ? { k: 'building', id: b.building } : undefined, undefined, pf.reasons);
}

function farmEntry(sim: Sim): void {
  const s = sim.s, r = sim.rng, m = s.map;
  const vacant = s.buildings.filter((b) => b.kind === 'farmhouse' && b.biz < 0);
  if (!vacant.length || !r.chance(0.3)) return;
  const farms = s.businesses.filter((b) => b.farm && b.profitHist.length >= 6);
  const avg = farms.length ? farms.reduce((a, b) => a + b.profitHist.reduce((x, y) => x + y, 0), 0) / farms.length : 0;
  if (avg <= 0) return;
  const fh = r.pick(vacant);
  const fields: number[] = [];
  const seen = new Set<number>();
  const q = [idx(fh.x, fh.y)];
  while (q.length && fields.length < 32) {
    const i = q.shift()!;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const j = idx(nx, ny);
      if (seen.has(j)) continue;
      seen.add(j);
      if (m.terrain[j] === Terrain.Farmland && m.farm[j] < 0 && m.project[j] < 0 && m.owner[j] < 0) { fields.push(j); q.push(j); }
    }
  }
  if (fields.length < 6) return;
  const owner = entrepreneur(sim, 200_000 * nominalOf(sim));
  if (!owner) return;
  const b = sim.newBusiness('farm', businessName(sim, 'farm', owner.last), fh.id, owner.id, false, 0, 'operating');
  const ha = fields.length * 0.16;
  b.farm = {
    fields, ha, crop: null, phase: 'fallow', phaseDays: 0, growth: 0, health: 1, moisture: 0.5, fertilizer: 0.8, irrigation: 0, well: false,
    seasonCost: 0, seasonRevenue: 0, expected: 0, harvested: 0, waterToday: 0, stressDays: 0, disease: 0, insured: false, premium: 0,
    lastHarvest: null, plan: 'New farm', work: 0, lowland: false, losses: {},
  };
  for (const t of fields) {
    m.farm[t] = b.id;
    const x = t % W, y = (t / W) | 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < W && m.terrain[idx(nx, ny)] === Terrain.Canal) b.farm.irrigation = 0.9;
    }
  }
  const oh = sim.hh(owner.hh)!;
  const equity = Math.min(oh.cash * 0.5, 150_000 * nominalOf(sim));
  sim.pay(oh, b, equity);
  b.loan = fh.value; // the farmstead is bought with a mortgage from outside lenders
  fh.ownerT = 2; fh.ownerId = b.id;
  if (owner.employer >= 0) sim.leaveJob(owner);
  owner.status = 'owner'; owner.employer = b.id; owner.job = -1;
  sim.addBusiness(b);
  sim.ix.ver.farms++;
  s.stats.acc.opened++;
  sim.emit('business.opened', `${sim.fullName(owner)} has taken over the vacant farm ${b.name} (${ha.toFixed(1)} ha).`, 1, { k: 'building', id: fh.id }, undefined, ['Farming has been profitable in recent seasons']);
}

/** Hotels open where rooms are full or visitors are being turned away. */
function hotelEntry(sim: Sim): void {
  const s = sim.s, T = s.tourism, r = sim.rng;
  if (s.businesses.some((b) => b.kind === 'hotel' && b.status !== 'operating')) return;
  let rooms = 0, nights = 0;
  for (const b of s.businesses) if (b.kind === 'hotel' && b.status === 'operating' && b.hotel) { rooms += b.hotel.rooms; nights += b.hotel.nights; }
  const occ = rooms > 0 ? nights / (rooms * sim.date.daysInMonth) : 1;
  const extra = ((T.m.turned / 30) * 2.2) / 2; // rooms a night that would have been let
  if (occ < 0.72 && extra < 10) return;
  const ease = [1, 0.8, 0.55][s.gov.policies.businessRegulation] * (s.gov.policies.investmentIncentive >= 1 ? 1.3 : 1);
  if (!r.chance(0.35 * ease)) return;
  const floors = Math.max(3, Math.min(8, Math.round((extra + rooms * Math.max(0, occ - 0.7)) / 8)));
  const spots = s.buildings.filter((b) => b.kind === 'heritage' || b.kind === 'museum' || b.kind === 'townhall');
  const near = spots.length ? sim.center(r.pick(spots)) : null;
  const bs = BUILDINGS.hotel;
  const owner = entrepreneur(sim, (bs.cost * floors + BUSINESSES.hotel.startup) * nominalOf(sim) * 0.4);
  const why = rooms ? `Hotels were ${Math.round(occ * 100)}% full last month${T.m.turned > 0 ? ` and turned away about ${Math.round(T.m.turned)} visitors` : ''}` : `Visitors are coming but the city has no hotel (${Math.round(T.m.turned)} found no room last month)`;
  const b = open(sim, 'hotel', near, owner, why, [Zone.Commercial], 1, 1, floors);
  if (b) sim.emit('investment.announced', `${b.name} will build a ${floors}-storey hotel with ${floors * 8} rooms.`, 2, b.building >= 0 ? { k: 'building', id: b.building } : undefined, undefined, [why]);
  else if (!sim.recentEvent('investment.noSite', 150)) sim.emit('investment.noSite', 'A hotel investor found no commercial land with road access.', 2, undefined, undefined, [why, 'Zone commercial land near the centre or the attractions']);
}

/** A cinema opens when residents want to go out but have nowhere (or no seat) to go. */
function cinemaEntry(sim: Sim): void {
  const s = sim.s, r = sim.rng, n = nominalOf(sim);
  if (s.businesses.some((b) => b.kind === 'cinema' && b.status !== 'operating')) return;
  const unmet = s.leisure.lastUnmet;
  if (unmet < 180_000 * n || !r.chance(0.3 * [1, 0.8, 0.55][s.gov.policies.businessRegulation])) return;
  const homes = s.buildings.filter((b) => b.occupants.length > 0);
  if (!homes.length) return;
  const bs = BUILDINGS.cinema;
  const owner = entrepreneur(sim, (bs.cost + bs.equipment) * n * 0.4);
  const why = `Residents wanted to spend ${Math.round(unmet / n / 1000)}K a month on films and outings they could not find`;
  const b = open(sim, 'cinema', sim.center(r.pick(homes)), owner, why, [Zone.Commercial]);
  if (b) sim.emit('business.planned', `${b.name} will open a cinema. ${why}.`, 1, b.building >= 0 ? { k: 'building', id: b.building } : undefined, undefined, [why]);
}

export function entryMonthly(sim: Sim): void {
  retailEntry(sim, 'grocery');
  retailEntry(sim, 'shop');
  retailEntry(sim, 'restaurant');
  retailEntry(sim, 'services');
  hotelEntry(sim);
  cinemaEntry(sim);
  for (const k of ['factory', 'foodplant', 'materials', 'office', 'logistics', 'construction'] as BusinessKind[]) invest(sim, k);
  farmEntry(sim);
}
