// Construction projects. Nothing appears instantly: projects move through planning, assessments, approvals,
// land acquisition and funding before contractors start work. Progress depends on crews, material deliveries,
// money and weather, and every lost day is recorded with its reason.

import { idx, W, type Account, type Sim } from '../core';
import { casualWage } from '../econ';
import { BASE_RENT, BUILDINGS, BUSINESSES, HA_PER_TILE, HOUSING_YIELD, ROADWORKS, unitsFor } from '../tables';
import { RoadClass, Terrain, type Building, type BuildingKind, type Business, type BusinessKind, type Project, type ProjectKind, type ProjectPhase } from '../types';
import { businessName } from '../names';
import { settleFarmFamily } from './population';
import { refreshTileTimes } from './transport';
import { badWeather } from './weather';

export interface ProjectSpec {
  kind: ProjectKind;
  x: number; y: number; w: number; h: number;
  tiles?: number[];
  floors?: number;
  gov: boolean;
  sponsor: number;
  bizKind?: BusinessKind | '';
  bizId?: number;
  name?: string;
  reason?: string;
  cofund?: number;
}

export interface Estimate {
  cost: number; labor: number; materials: number; equipment: number; landCost: number; displaced: number; farmsAffected: number;
  crew: number; days: number; construction: number; tiles: number[]; floors: number;
}

const ROAD_KINDS = ['road', 'avenue', 'upgrade', 'canal'];
const BIG_WORKS = new Set<string>(['airport', 'stadium']);
export const isRoadwork = (k: ProjectKind) => ROAD_KINDS.includes(k);

export function laborRate(sim: Sim): number { return (sim.roleWage('laborer') / 26) * 1.35; }

function adminDelay(sim: Sim): number { return 1 + Math.max(0, 1 - sim.s.gov.deptFunding.admin) * 1.5; }

function phaseDays(sim: Sim, p: { kind: ProjectKind; gov: boolean; tiles: number[] }, phase: ProjectPhase, landTiles = 0): number {
  const env = sim.s.gov.policies.environmentalRegulation;
  const reg = sim.s.gov.policies.businessRegulation;
  const big = isRoadwork(p.kind) ? p.tiles.length >= 6 : ['hospital', 'college', 'factory', 'materials', 'foodplant'].includes(p.kind);
  switch (phase) {
    case 'planning': return p.gov ? (isRoadwork(p.kind) ? 10 : 25) : 12;
    case 'assessment': return big ? [10, 30, 60][env] : 0;
    case 'approval': return Math.round((p.gov ? 14 : [10, 25, 50][reg]) * adminDelay(sim));
    case 'land': return landTiles > 0 ? Math.min(120, 30 + landTiles * 2) : 0;
    default: return 0;
  }
}

export function footprintTiles(x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out.push(idx(xx, yy));
  return out;
}

export function estimate(sim: Sim, kind: ProjectKind, tiles: number[], floors?: number, gov = true): Estimate {
  const s = sim.s, m = s.map;
  const nominal = sim.scale * s.ext.trend;
  const rate = laborRate(sim);
  const mat = s.market.materials.price * 1.05;
  let labor = 0, materials = 0, equipment = 0, crew = 10, f = floors ?? 1;
  if (isRoadwork(kind)) {
    const spec = ROADWORKS[kind as keyof typeof ROADWORKS];
    // bridge spans over the river or canals take three times the work and materials
    let spans = 0;
    for (const t of tiles) if (m.terrain[t] === Terrain.Water || (m.terrain[t] === Terrain.Canal && kind !== 'canal')) spans++;
    labor = spec.labor * (tiles.length + spans * 2);
    materials = spec.materials * (tiles.length + spans * 2);
    crew = Math.min(60, spec.crew + tiles.length);
  } else {
    const spec = BUILDINGS[kind as BuildingKind];
    f = floors ?? spec.floors[0];
    const mult = spec.perFloor ? f : kind === 'park' ? tiles.length : 1;
    labor = spec.labor * mult;
    materials = spec.materials * mult;
    equipment = spec.equipment * nominal;
    crew = spec.crew;
  }
  let landCost = 0, displaced = 0;
  const farms = new Set<number>();
  if (gov) {
    const seen = new Set<number>();
    for (const t of tiles) {
      if (m.farm[t] >= 0) { landCost += 0.16 * 3_000_000 * nominal; farms.add(m.farm[t]); }
      const o = m.owner[t];
      if (o >= 0 && !seen.has(o)) {
        seen.add(o);
        const b = sim.bld(o);
        if (b && b.ownerT !== 0) { landCost += b.value * 1.1; displaced += b.occupants.length; }
      }
    }
  }
  // crews achieve 90% productivity on site, so paid worker-days exceed the engineering estimate
  const cost = (labor / 0.9) * rate + materials * mat + equipment + landCost;
  const construction = Math.ceil((labor / (crew * 0.85)) * (7 / 6));
  const shape = { kind, gov, tiles };
  const days = phaseDays(sim, shape, 'planning') + phaseDays(sim, shape, 'assessment') + phaseDays(sim, shape, 'approval') +
    phaseDays(sim, shape, 'land', landCost > 0 ? tiles.length : 0) + construction + (BUILDINGS[kind as BuildingKind]?.biz && gov ? 30 : 0);
  return { cost, labor, materials, equipment, landCost, displaced, farmsAffected: farms.size, crew, days, construction, tiles, floors: f };
}

function accessTile(sim: Sim, tiles: number[]): number {
  const m = sim.s.map;
  for (const t of tiles) {
    const x = t % W, y = (t / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
      const j = idx(nx, ny);
      if (m.road[j] > 0 && !tiles.includes(j)) return j;
    }
  }
  return tiles.find((t) => m.road[t] > 0) ?? -1;
}

export function createProject(sim: Sim, spec: ProjectSpec): Project {
  const s = sim.s;
  const tiles = spec.tiles ?? footprintTiles(spec.x, spec.y, spec.w, spec.h);
  const est = estimate(sim, spec.kind, tiles, spec.floors, spec.gov);
  const label = isRoadwork(spec.kind) ? ROADWORKS[spec.kind as keyof typeof ROADWORKS].label : BUILDINGS[spec.kind as BuildingKind].label;
  const p: Project = {
    id: sim.newId(), kind: spec.kind, name: spec.name ?? `${label}${isRoadwork(spec.kind) ? ` (${tiles.length * 40} m)` : ''}`, sponsor: spec.sponsor, gov: spec.gov,
    tiles, x: spec.x, y: spec.y, w: spec.w, h: spec.h, phase: 'planning', phaseLeft: 0, cost: est.cost, budget: est.cost, spent: 0,
    labor: est.labor, laborDone: 0, materials: est.materials, matDelivered: 0, matOrdered: 0, contractor: -1,
    created: sim.day, started: -1, completed: -1, plannedDays: est.days, delayDays: 0, issue: '', issues: {}, workersToday: 0,
    building: -1, bizKind: spec.bizKind ?? '', bizId: spec.bizId ?? -1, landCost: est.landCost, displaced: est.displaced,
    reason: spec.reason ?? '', access: accessTile(sim, tiles), floors: est.floors,
  };
  p.phaseLeft = phaseDays(sim, p, 'planning');
  if (spec.cofund && spec.cofund > 0) { p.cofund = spec.cofund; p.grant = 0; }
  if (!spec.gov) {
    // private developers buy rezoned farmland outright and clear any woodland on the plot
    const sponsor = sim.biz(spec.sponsor);
    for (const t of tiles) {
      if (s.map.farm[t] >= 0) sellField(sim, t, sponsor ?? s.ext, p.name);
      if (s.map.terrain[t] === Terrain.Forest) { s.map.terrain[t] = Terrain.Grass; sim.ix.ver.terrain++; }
    }
  }
  for (const t of tiles) s.map.project[t] = p.id;
  s.projects.push(p);
  sim.ix.proj.set(p.id, p);
  sim.ix.ver.projects++;
  if (spec.gov) sim.emit('project.proposed', `Government announces ${p.name.toLowerCase().startsWith('a') ? '' : 'a '}${p.name}; estimated cost ${fmtMoney(sim, est.cost)}.`, 2, { k: 'project', id: p.id }, undefined,
    [`Expected to take about ${Math.round(est.days / 30.4)} months`, ...(est.landCost > 0 ? [`Requires acquiring land (${est.farmsAffected} farms, ${est.displaced} households affected)`] : [])]);
  return p;
}

/** A farm sells one field tile (e.g. rezoned land bought by a developer). */
export function sellField(sim: Sim, t: number, payer: Account, buyer: string): void {
  const m = sim.s.map;
  const farm = sim.biz(m.farm[t]);
  const price = HA_PER_TILE * 3_000_000 * sim.scale * sim.s.ext.trend;
  if (farm?.farm) {
    sim.pay(payer, farm, price);
    farm.farm.fields = farm.farm.fields.filter((x) => x !== t);
    farm.farm.ha = farm.farm.fields.length * HA_PER_TILE;
  }
  m.farm[t] = -1;
  m.terrain[t] = Terrain.Grass;
  sim.ix.ver.farms++;
  sim.ix.ver.terrain++;
  if (farm?.farm && farm.farm.ha < 0.5) sim.closeBusiness(farm, `The family sold the last of its land for ${buyer}.`);
}

export function fmtMoney(sim: Sim, v: number): string {
  const sym = sim.preset.currency;
  const a = Math.abs(v);
  const str = a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(0);
  return `${sym}${str}`;
}

function nextPhase(sim: Sim, p: Project): void {
  const order: ProjectPhase[] = p.gov ? ['planning', 'assessment', 'approval', 'land', 'funding', 'construction'] : ['planning', 'approval', 'construction'];
  let i = order.indexOf(p.phase) + 1;
  while (i < order.length) {
    const ph = order[i];
    const d = ph === 'land' ? (p.landCost > 0 ? phaseDays(sim, p, 'land', p.tiles.length) : 0) : ph === 'funding' || ph === 'construction' ? 1 : phaseDays(sim, p, ph);
    if (d > 0) {
      p.phase = ph; p.phaseLeft = d;
      if (ph === 'construction' && p.started < 0) p.started = sim.day;
      if (p.gov && (ph === 'land' || ph === 'construction')) {
        sim.emit('project.phase', ph === 'land' ? `Land acquisition begins for ${p.name}.` : `Construction begins on ${p.name}.`, 1, { k: 'project', id: p.id });
      }
      return;
    }
    i++;
  }
  p.phase = 'construction';
  if (p.started < 0) p.started = sim.day;
}

function acquireLand(sim: Sim, p: Project): void {
  const s = sim.s, m = s.map;
  const nominal = sim.scale * s.ext.trend;
  let farms = 0, households = 0, businesses = 0;
  const seenFarm = new Set<number>(), seenB = new Set<number>();
  for (const t of p.tiles) {
    const fid = m.farm[t];
    if (fid >= 0) {
      const farm = sim.biz(fid);
      if (farm?.farm) {
        const comp = 0.16 * 3_000_000 * nominal;
        sim.spend('land', farm, comp);
        farm.farm.fields = farm.farm.fields.filter((x) => x !== t);
        farm.farm.ha = farm.farm.fields.length * 0.16;
        if (!seenFarm.has(fid)) { seenFarm.add(fid); farms++; }
      }
      m.farm[t] = -1;
      m.terrain[t] = Terrain.Grass;
      sim.ix.ver.farms++;
    }
    const o = m.owner[t];
    if (o >= 0 && !seenB.has(o)) {
      seenB.add(o);
      const b = sim.bld(o);
      if (b && b.ownerT !== 0) {
        const comp = b.value * 1.1;
        const to = b.ownerT === 1 ? sim.hh(b.ownerId) : b.ownerT === 2 ? sim.biz(b.ownerId) : undefined;
        sim.spend('land', to ?? s.ext, comp);
        for (const hid of [...b.occupants]) {
          const h = sim.hh(hid);
          if (!h) continue;
          households++;
          sim.moveOut(h);
          h.unhappy += 3;
          for (const id of h.members) { const c = sim.cit(id); if (c) c.sat = Math.max(0, c.sat - 0.2); }
        }
        if (b.biz >= 0) {
          const biz = sim.biz(b.biz);
          if (biz && !biz.pub) { businesses++; sim.closeBusiness(biz, `Its premises were acquired for ${p.name}.`); }
        }
        sim.removeBuilding(b);
      }
    }
  }
  for (const fid of seenFarm) {
    const farm = sim.biz(fid);
    if (farm?.farm && farm.farm.ha < 0.5) sim.closeBusiness(farm, `Most of its land was acquired for ${p.name}.`);
  }
  if (farms || households || businesses) {
    sim.emit('project.land', `Land acquired for ${p.name}: ${farms} farms lose fields${households ? `, ${households} households relocated` : ''}${businesses ? `, ${businesses} businesses closed` : ''}.`, households + farms >= 5 ? 2 : 1,
      { k: 'project', id: p.id }, undefined, ['Affected residents are unhappy about the acquisition', 'Compensation was paid from the treasury']);
  }
}

function pickContractor(sim: Sim, committed: Map<number, number>): Business | undefined {
  let best: Business | undefined, spare = 0;
  for (const b of sim.s.businesses) {
    if (b.kind !== 'construction' || b.status !== 'operating') continue;
    const crew = b.jobs.filter((j) => j.role === 'laborer' && j.worker >= 0).length;
    if (crew <= 0) continue; // a yard without labourers cannot take on work
    const free = crew - (committed.get(b.id) ?? 0);
    if (!best || free > spare) { best = b; spare = free; }
  }
  return best;
}

/** Contractor id used for projects built by a firm from outside the city. */
export const OUTSIDE_CONTRACTOR = -2;
/** Outside firms charge more for labour: travel, lodging and their overheads. */
export const OUTSIDE_PREMIUM = 1.3;

/**
 * Local labourers the town needs before its own construction firms take on new projects. A new town relies on
 * outside contractors until its first local firm has a real crew; elsewhere they step in only when there is none.
 */
export function minLocalCrew(sim: Sim): number { return sim.s.meta.condition === 'empty' ? 8 : 1; }

/** Healthy labourers on the books of local construction firms. */
export function localLabourers(sim: Sim): number {
  let n = 0;
  for (const b of sim.s.businesses) {
    if (b.kind !== 'construction' || b.status !== 'operating') continue;
    for (const j of b.jobs) if (j.role === 'laborer' && j.worker >= 0) { const c = sim.cit(j.worker); if (c && c.injured <= 0) n++; }
  }
  return n;
}

/** Local people taken on as day labourers by an outside contractor. Pays each one and returns how many came. */
function dayLabour(sim: Sim, wanted: number, pay: (to: Account, amt: number) => void): number {
  const ix = sim.ix;
  const cap = Math.floor(ix.casualPool.length * 0.6);
  const wage = casualWage(sim);
  let got = 0;
  while (got < wanted && ix.casualUsed < cap) {
    const c = sim.cit(ix.casualPool[ix.casualUsed++]);
    if (!c) continue;
    const h = sim.hh(c.hh);
    if (!h) continue;
    pay(h, wage);
    h.m.wages += wage;
    got++;
  }
  return got;
}

function delay(p: Project, reason: string): void {
  p.issue = reason;
  p.issues[reason] = (p.issues[reason] ?? 0) + 1;
  p.delayDays++;
}

export function constructionDaily(sim: Sim): void {
  const s = sim.s;
  if (!s.projects.length) return;
  const work = sim.isWorkDay() && !badWeather(sim);
  const weatherStop = sim.isWorkDay() && badWeather(sim);
  // crews available per contractor today
  const crews = new Map<number, number>();
  const committed = new Map<number, number>();
  for (const b of s.businesses) {
    if (b.kind !== 'construction' || b.status !== 'operating') continue;
    let n = 0;
    for (const j of b.jobs) if (j.role === 'laborer' && j.worker >= 0) { const c = sim.cit(j.worker); if (c && c.injured <= 0) n++; }
    crews.set(b.id, n);
  }
  for (const p of s.projects) if (p.phase === 'construction' && p.contractor >= 0) committed.set(p.contractor, (committed.get(p.contractor) ?? 0) + (BUILDINGS[p.kind as BuildingKind]?.crew ?? 20));
  let localCrew = 0;
  for (const n of crews.values()) localCrew += n;
  const minLocal = minLocalCrew(sim);
  const done: Project[] = [];
  const ordered = [...s.projects].sort((a, b) => Number(b.gov) - Number(a.gov) || a.created - b.created);
  for (const p of ordered) {
    p.workersToday = 0;
    switch (p.phase) {
      case 'planning': case 'assessment': case 'approval': case 'land':
        if (--p.phaseLeft <= 0) {
          if (p.phase === 'land') acquireLand(sim, p);
          nextPhase(sim, p);
        }
        break;
      case 'funding': {
        const g = s.gov;
        if (g.cash > p.cost * 0.1 || (g.arrears === 0 && g.rating !== 'B')) { p.issue = ''; nextPhase(sim, p); }
        else delay(p, 'Awaiting funds in the treasury');
        break;
      }
      case 'construction': {
        if (weatherStop) { delay(p, 'Heavy rain / flooding halted work'); break; }
        if (!work) break;
        const maxCrew = isRoadwork(p.kind) ? Math.min(60, ROADWORKS[p.kind as keyof typeof ROADWORKS].crew + p.tiles.length) : BUILDINGS[p.kind as BuildingKind].crew;
        let c = p.contractor >= 0 ? sim.biz(p.contractor) : undefined;
        if (p.contractor !== OUTSIDE_CONTRACTOR && (!c || c.status !== 'operating')) {
          c = localCrew >= minLocal ? pickContractor(sim, committed) : undefined;
          // in a new town, work goes to outside firms rather than queueing behind a local firm whose crews are taken
          if (c && sim.frontier() > 0 && (crews.get(c.id) ?? 0) - (committed.get(c.id) ?? 0) < Math.min(8, maxCrew) * 0.75) c = undefined;
          if (c) {
            p.contractor = c.id;
            committed.set(c.id, (committed.get(c.id) ?? 0) + (BUILDINGS[p.kind as BuildingKind]?.crew ?? 20));
          } else {
            // no local firm has a crew: a contractor from outside the city takes the job
            p.contractor = OUTSIDE_CONTRACTOR;
            sim.emit('project.outside', `No local construction company can take on ${p.name}; an outside contractor is building it.`, 1, { k: 'project', id: p.id }, undefined,
              [`Outside firms charge about ${Math.round((OUTSIDE_PREMIUM - 1) * 100)}% more for labour, and most of the money leaves the city`, 'They take on local people as day labourers when they can']);
          }
        }
        const outsideFirm = p.contractor === OUTSIDE_CONTRACTOR;
        const avail = c ? crews.get(c.id) ?? 0 : 0;
        const local = c ? Math.min(maxCrew, avail) : 0;
        // outside crews: the whole crew for an outside contractor; on very large public works a national contractor
        // also works alongside the local firm
        const extra = outsideFirm ? maxCrew : BIG_WORKS.has(p.kind) ? Math.min(maxCrew - local, Math.max(0, Math.round(maxCrew * 0.7) - avail)) : 0;
        if (local + extra <= 0) { delay(p, 'Contractor has no free workers'); break; }
        const matAllowed = p.materials > 0 ? (p.matDelivered / p.materials) * p.labor + p.labor * 0.05 : p.labor;
        if (p.laborDone >= matAllowed) { delay(p, 'Waiting for building materials'); break; }
        const rate = laborRate(sim);
        const outRate = rate * OUTSIDE_PREMIUM;
        const cost = local * rate + extra * outRate;
        let sp: Business | undefined;
        if (p.gov) {
          if (s.gov.arrears > 0 && s.gov.cash < cost) { delay(p, 'Government cannot pay the contractor'); break; }
        } else {
          sp = sim.biz(p.sponsor);
          if (!sp) { delay(p, 'Developer has gone out of business'); break; }
          if (sp.cash < cost) {
            // lenders cover overruns until spending reaches 130% of the original budget
            const room = p.budget * 1.3 - p.spent;
            if (room > cost) { const borrow = Math.min(room, cost * 10); sim.pay(s.ext, sp, borrow); sp.loan += borrow; }
            else { delay(p, 'Developer is short of cash'); break; }
          }
        }
        // capital outlay (not an operating cost of the sponsor)
        const payer = sp;
        const pay = (to: Account, amt: number) => { if (!(amt > 0)) return; if (payer) sim.pay(payer, to, amt); else sim.spend('capital', to, amt); };
        if (c && local > 0) {
          pay(c, local * rate);
          c.m.revenue += local * rate;
          crews.set(c.id, Math.max(0, avail - local));
        }
        if (extra > 0) {
          // an outside firm takes on local people as day labourers and brings the rest of its crew from elsewhere
          const day = outsideFirm ? dayLabour(sim, Math.floor(maxCrew * 0.6), pay) : 0;
          pay(s.ext, extra * outRate - day * casualWage(sim));
        }
        const workers = local + extra;
        p.spent += cost;
        p.laborDone += workers * 0.9;
        p.workersToday = workers;
        p.issue = '';
        const remaining = (Math.max(0, p.labor - p.laborDone) / 0.9) * (outsideFirm ? outRate : rate) + Math.max(0, p.materials - p.matDelivered - p.matOrdered) * s.market.materials.price * 1.05;
        const equipment = isRoadwork(p.kind) ? 0 : BUILDINGS[p.kind as BuildingKind].equipment * sim.scale * s.ext.trend;
        p.cost = p.spent + remaining + equipment + (p.phase === 'construction' ? 0 : p.landCost);
        if (p.laborDone >= p.labor && p.matDelivered >= p.materials * 0.98) done.push(p);
        break;
      }
      case 'staffing': {
        const b = sim.biz(p.bizId);
        const days = sim.day - p.completed;
        if (!b) { p.phase = 'done'; break; }
        const filled = b.jobs.filter((j) => j.worker >= 0).length;
        if (filled >= b.jobs.length * 0.6 || days >= 90) {
          b.status = 'operating'; b.statusDay = sim.day;
          p.phase = 'done';
          sim.ix.storesDirty = true;
          sim.emit('project.opened', `${b.name} opens with ${Math.round((filled / Math.max(1, b.jobs.length)) * 100)}% of its staff.`, 2, { k: 'building', id: b.building }, undefined,
            filled < b.jobs.length * 0.6 ? ['Not enough qualified staff could be hired; it will run below capacity'] : undefined);
        }
        break;
      }
    }
  }
  // national co-funding reimburses its share of what co-funded projects have spent
  for (const p of s.projects) {
    if (!p.cofund) continue;
    const due = p.spent * p.cofund - (p.grant ?? 0);
    if (due > 1) { sim.tax('grants', s.ext, due); p.grant = (p.grant ?? 0) + due; }
  }
  for (const p of done) complete(sim, p);
  // tidy finished projects after a while
  const before = s.projects.length;
  s.projects = s.projects.filter((p) => !((p.phase === 'done' || p.phase === 'cancelled') && sim.day - Math.max(p.completed, p.created) > 60));
  if (s.projects.length !== before) { sim.ix.proj.clear(); for (const p of s.projects) sim.ix.proj.set(p.id, p); sim.ix.ver.projects++; }
}

function complete(sim: Sim, p: Project): void {
  const s = sim.s, m = s.map;
  p.completed = sim.day;
  for (const t of p.tiles) if (m.project[t] === p.id) m.project[t] = -1;
  sim.ix.ver.projects++;
  if (isRoadwork(p.kind)) {
    if (p.kind === 'canal') {
      for (const t of p.tiles) { m.terrain[t] = Terrain.Canal; m.zone[t] = 0; }
      for (const b of s.businesses) {
        if (!b.farm) continue;
        const near = b.farm.fields.some((f) => p.tiles.some((t) => Math.abs((t % W) - (f % W)) <= 4 && Math.abs(((t / W) | 0) - ((f / W) | 0)) <= 4));
        if (near) { b.farm.irrigation = Math.max(b.farm.irrigation, 0.9); b.farm.lowland = true; }
      }
      sim.ix.ver.terrain++;
    } else {
      const cls = p.kind === 'road' ? RoadClass.Street : RoadClass.Avenue;
      for (const t of p.tiles) {
        m.road[t] = Math.max(m.road[t], cls);
        m.roadCond[t] = 1;
        m.zone[t] = 0;
        if (m.terrain[t] === Terrain.Forest || m.terrain[t] === Terrain.Farmland) m.terrain[t] = Terrain.Grass;
      }
      refreshTileTimes(sim);
      sim.ix.ver.roads++;
      sim.ix.ver.terrain++;
    }
    p.phase = 'done';
    if (p.gov) sim.emit('project.completed', `${p.name} is complete${p.delayDays > 20 ? `, ${p.delayDays} days late` : ''}.`, 1, { k: 'project', id: p.id }, undefined, lateReasons(p));
    return;
  }
  const kind = p.kind as BuildingKind;
  const spec = BUILDINGS[kind];
  const floors = p.floors || spec.floors[0];
  if (kind === 'airport') {
    // local streets across the runway are closed
    let closed = 0;
    for (const t of p.tiles) if (m.road[t] === 1) { m.road[t] = 0; m.roadCond[t] = 0; closed++; }
    if (closed) { refreshTileTimes(sim); sim.ix.ver.roads++; }
  }
  let lv = 0;
  for (const t of p.tiles) lv += m.landValue[t];
  lv /= Math.max(1, p.tiles.length);
  const b: Building = {
    id: sim.newId(), kind, x: p.x, y: p.y, w: p.w, h: p.h, floors, units: unitsFor(kind, floors), occupants: [], biz: -1,
    ownerT: p.gov ? 0 : 2, ownerId: p.gov ? -1 : p.sponsor, value: Math.max(p.spent, p.budget * 0.6) * (0.9 + 0.4 * lv), rent: 0, condition: 1, built: sim.day,
    access: p.access, style: sim.rng.int(1_000_000), name: '',
  };
  const base = BASE_RENT[kind];
  if (base) b.rent = Math.round((base * sim.scale * s.ext.trend * (0.75 + 0.6 * lv) * s.housing.rentIndex) / 50) * 50;
  if (kind === 'apartment') b.name = `${sim.rng.pick(sim.preset.bizPrefix)} ${sim.rng.pick(['Residency', 'Heights', 'Apartments', 'Towers', 'Enclave'])}`;
  if (kind === 'affordable') b.name = `${s.meta.name} Housing Block ${1 + s.buildings.filter((q) => q.kind === 'affordable').length}`;
  if (kind === 'park') b.name = p.name;
  if (kind === 'park') for (const t of p.tiles) m.zone[t] = 5;
  sim.addBuilding(b);
  p.building = b.id;
  if (spec.equipment > 0) {
    const eq = spec.equipment * sim.scale * s.ext.trend;
    if (p.gov) sim.spend('capital', s.ext, eq);
    else { const sp = sim.biz(p.sponsor); if (sp) { sim.pay(sp, s.ext, eq); } }
    p.spent += eq;
  }
  const bizKind = spec.biz;
  if (p.gov && bizKind && BUSINESSES[bizKind].pub) {
    const biz = sim.newBusiness(bizKind, businessName(sim, bizKind), b.id, -1, false, 0, 'hiring');
    for (const [role, n] of BUSINESSES[bizKind].jobs) sim.addJobs(biz, role, n);
    biz.capacity = biz.jobs.length;
    sim.addBusiness(biz);
    b.name = biz.name;
    p.bizId = biz.id;
    p.phase = 'staffing';
    sim.emit('project.completed', `Construction of ${biz.name} is complete; hiring ${biz.jobs.length} staff${p.delayDays > 20 ? ` (${p.delayDays} days late)` : ''}.`, 2, { k: 'building', id: b.id }, undefined, lateReasons(p));
    return;
  }
  if (p.bizId >= 0) {
    const biz = sim.biz(p.bizId);
    if (biz) {
      biz.building = b.id;
      b.biz = biz.id;
      b.ownerT = 2; b.ownerId = biz.id;
      biz.status = 'registering';
      biz.statusDay = sim.day;
      sim.ix.storesDirty = true;
      // a settler family's farmhouse is ready: the family moves in and starts working its fields
      if (biz.kind === 'farm') settleFarmFamily(sim, biz, b);
    }
  }
  if (!p.gov && b.units > 0 && kind !== 'farmhouse') sellHomes(sim, p, b);
  p.phase = 'done';
  if (p.gov) sim.emit('project.completed', `${b.name || spec.label} completed${p.delayDays > 20 ? `, ${p.delayDays} days late` : ''}.`, 1, { k: 'building', id: b.id }, undefined, lateReasons(p));
}

/**
 * A developer sells finished homes: a wealthy local family buys if it can, otherwise outside investors.
 * The price capitalises the expected rent; the developer repays its construction loan from the proceeds.
 */
function sellHomes(sim: Sim, p: Project, b: Building): void {
  const s = sim.s;
  const dev = sim.biz(p.sponsor);
  // in a new town investors pay a premium, betting that rents and values will rise as it grows
  const price = ((b.rent * b.units * 12 * 0.92) / HOUSING_YIELD) * (1 + 0.3 * sim.frontier());
  b.value = price;
  const buyer = s.households.filter((h) => h.home >= 0 && h.cash > price * 1.5).sort((x, y) => y.cash - x.cash)[0];
  if (buyer) {
    if (dev) sim.pay(buyer, dev, price); else sim.pay(buyer, s.ext, price);
    buyer.m.other += price;
    b.ownerT = 1; b.ownerId = buyer.id;
  } else {
    if (dev) sim.pay(s.ext, dev, price);
    b.ownerT = 3; b.ownerId = -1;
  }
  if (dev) {
    dev.m.revenue += price - p.spent; // development margin
    const repay = Math.min(dev.loan, Math.max(0, dev.cash));
    if (repay > 0) { sim.pay(dev, s.ext, repay); dev.loan -= repay; }
  }
}

function lateReasons(p: Project): string[] | undefined {
  const e = Object.entries(p.issues).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return e.length ? e.map(([k, v]) => `${v} days lost: ${k.toLowerCase()}`) : undefined;
}

export function cancelProject(sim: Sim, p: Project): void {
  if (p.phase === 'done' || p.phase === 'cancelled') return;
  p.phase = 'cancelled';
  p.completed = sim.day;
  for (const t of p.tiles) if (sim.s.map.project[t] === p.id) sim.s.map.project[t] = -1;
  if (p.bizId >= 0) { const b = sim.biz(p.bizId); if (b && b.status === 'planned') { sim.closeBusiness(b, 'Its building project was cancelled.'); } }
  sim.ix.ver.projects++;
  sim.emit('project.cancelled', `${p.name} was cancelled after spending ${fmtMoney(sim, p.spent)}.`, p.gov ? 2 : 1, { k: 'project', id: p.id });
}
