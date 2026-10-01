// Housing market: vacancy-driven rents, property tax, evictions and private residential development.

import { idx, W, type Sim } from '../core';
import { hhIncome, maintenanceWork } from '../econ';
import { businessName } from '../names';
import { BASE_RENT, BUILDINGS, HOUSING_YIELD } from '../tables';
import { Terrain, Zone, type Business } from '../types';
import { createProject, estimate } from './construction';
import { findHome } from './population';

export function housingDaily(sim: Sim): void {
  if (sim.day % 3 !== 0) return;
  for (const h of sim.s.households) {
    if (h.home >= 0) continue;
    const head = sim.cit(h.members[0]);
    const work = head ? sim.workplaceOf(head) : undefined;
    const home = findHome(sim, Math.max(1, hhIncome(h)), work ? sim.center(work) : null, h.cash);
    if (home >= 0) sim.moveIn(h, sim.bld(home)!, false);
  }
}

export function housingMonthly(sim: Sim): void {
  const s = sim.s, hs = s.housing, t = s.gov.taxes;
  const nominal = sim.scale * s.ext.trend;
  let units = 0, occupied = 0;
  for (const b of s.buildings) {
    if (b.units <= 0 || b.kind === 'farmhouse') continue;
    units += b.units;
    occupied += Math.min(b.units, b.occupants.length);
  }
  const vacancy = units ? (units - occupied) / units : 0;
  const homeless = s.households.filter((h) => h.home < 0).length;
  // families without a home only push rents up when there is genuinely nothing to rent; with empty flats
  // around they are priced out rather than short of supply
  const pressure = vacancy < 0.03 ? homeless / Math.max(1, s.households.length) : 0;
  hs.vacancy = vacancy;
  hs.demandGap = homeless;
  // landlords raise rents quickly in a tight market and cut them more slowly when flats stand empty
  const d = Math.max(-0.006, Math.min(0.025, 0.3 * (0.05 - vacancy) + 0.25 * pressure));
  hs.rentIndex = Math.max(0.3, hs.rentIndex * (1 + d));
  const control = s.gov.policies.rentControl;
  const m = s.map;
  for (const b of s.buildings) {
    const base = BASE_RENT[b.kind];
    if (!base || b.units <= 0) continue;
    b.condition = Math.max(0.2, b.condition - 0.0015);
    if (b.kind === 'affordable') { b.rent = Math.round((base * nominal) / 10) * 10; }
    else {
      let lv = 0;
      for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) lv += m.landValue[idx(xx, yy)];
      lv /= b.w * b.h;
      const target = base * nominal * (0.75 + 0.6 * lv) * hs.rentIndex * (0.8 + 0.2 * b.condition);
      b.rent = Math.round((control ? Math.min(target, b.rent * 1.004) : target) / 10) * 10;
      b.value *= 1 + d;
    }
    for (const hid of b.occupants) {
      const h = sim.hh(hid);
      if (!h || h.owns) continue;
      h.rent = control ? Math.min(b.rent, h.rent * 1.004) : b.rent;
    }
  }
  // property tax paid by owners
  for (const b of s.buildings) {
    if (b.ownerT === 0 || b.value <= 0) continue;
    const amt = (b.value * t.property * s.gov.compliance) / 12;
    if (b.ownerT === 1) {
      const h = sim.hh(b.ownerId);
      if (h) { const paid = Math.min(amt, Math.max(0, h.cash)); sim.tax('propertyTax', h, paid); h.m.taxes += paid; continue; }
    } else if (b.ownerT === 2) {
      const biz = sim.biz(b.ownerId);
      if (biz) { sim.tax('propertyTax', biz, amt); biz.m.taxes += amt; continue; }
    }
    sim.tax('propertyTax', s.ext, amt);
  }
  // owners pay for upkeep through local contractors; buildings whose owners cannot pay deteriorate
  for (const b of s.buildings) {
    if (b.units <= 0 || b.ownerT === 0 || b.kind === 'farmhouse') continue;
    const amt = b.value * 0.0006;
    if (b.ownerT === 1) {
      const h = sim.hh(b.ownerId);
      if (!h || h.cash < amt * 3) continue;
      maintenanceWork(sim, h, amt);
      h.m.other += amt;
    } else if (b.ownerT === 2) {
      const biz = sim.biz(b.ownerId);
      if (!biz || biz.cash < amt * 3) continue;
      maintenanceWork(sim, biz, amt);
      biz.m.other += amt;
    } else maintenanceWork(sim, s.ext, amt);
    b.condition = Math.min(1, b.condition + 0.002);
  }
  // evictions after three months of arrears
  let evicted = 0;
  for (const h of s.households) {
    if (h.home >= 0 && !h.owns && h.rentArrears >= 3) { sim.moveOut(h); h.rentArrears = 0; h.unhappy += 2; evicted++; }
  }
  if (evicted >= 5) sim.emit('housing.evictions', `${evicted} households were evicted for unpaid rent last month.`, 2, undefined, undefined,
    [`Rents have risen to ${Math.round(hs.rentIndex * 100)}% of their starting level`, 'Unemployment and low wages leave some families unable to pay']);
  developers(sim, vacancy, homeless);
}

function realestate(sim: Sim): Business {
  const s = sim.s;
  const list = s.businesses.filter((b) => b.kind === 'realestate');
  const rich = list.sort((a, b) => b.cash - a.cash)[0];
  if (rich && rich.cash > 0) return rich;
  const b = sim.newBusiness('realestate', businessName(sim, 'realestate'), -1, -1, true, 0, 'operating');
  const capital = 60_000_000 * sim.scale * s.ext.trend;
  sim.pay(s.ext, b, capital);
  sim.addBusiness(b);
  return b;
}

/** Free, road-accessible lot in one of the given zones, preferring higher land value. */
export function findLot(sim: Sim, zones: number[], w = 1, h = 1): { x: number; y: number } | null {
  const m = sim.s.map, r = sim.rng;
  let best: { x: number; y: number } | null = null, bestS = -Infinity;
  for (let y = 0; y <= W - h; y++) for (let x = 0; x <= W - w; x++) {
    const i = idx(x, y);
    if (!zones.includes(m.zone[i])) continue;
    let ok = true, road = false;
    for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) {
      const j = idx(xx, yy);
      const tt = m.terrain[j];
      // farmland and woodland the government has rezoned for building can be bought and cleared
      const farmed = m.farm[j] >= 0 && m.zone[j] === Zone.Agricultural;
      if (!zones.includes(m.zone[j]) || m.road[j] || m.owner[j] >= 0 || farmed || m.project[j] >= 0 || tt === Terrain.Water || tt === Terrain.Canal) { ok = false; break; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = xx + dx, ny = yy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < W && m.road[idx(nx, ny)] > 0) road = true;
      }
    }
    if (!ok || !road) continue;
    const sc = m.landValue[i] + r.next() * 0.15;
    if (sc > bestS) { bestS = sc; best = { x, y }; }
  }
  return best;
}

function developers(sim: Sim, vacancy: number, homeless: number): void {
  const s = sim.s;
  const nominal = sim.scale * s.ext.trend;
  const control = s.gov.policies.rentControl;
  const hurdle = 0.08 + (control ? 0.06 : 0);
  const active = s.projects.filter((p) => !p.gov && (p.kind === 'house' || p.kind === 'apartment') && p.phase !== 'done' && p.phase !== 'cancelled');
  const pipeline = active.reduce((a, p) => a + (p.kind === 'apartment' ? p.floors * 4 : 1), 0);
  const lastImm = s.stats.months.length ? s.stats.months[s.stats.months.length - 1].immigrants / 3.5 : 0;
  const need = homeless + s.households.length * (0.05 - vacancy) + lastImm - pipeline;
  if (need <= 0) return;
  // developers build to sell: investors pay a price that capitalises the rent at the market yield
  const aptEst = estimate(sim, 'apartment', [0], 6, false);
  const houseEst = estimate(sim, 'house', [0], 1, false);
  const aptRent = (BASE_RENT.apartment ?? 0) * nominal * s.housing.rentIndex * 1.05;
  const houseRent = (BASE_RENT.house ?? 0) * nominal * s.housing.rentIndex * 1.05;
  const mApt = (aptRent * 24 * 12 * 0.92) / HOUSING_YIELD / aptEst.cost - 1;
  const mHouse = (houseRent * 12 * 0.95) / HOUSING_YIELD / houseEst.cost - 1;
  let left = need;
  const maxStarts = 1 + Math.floor(s.citizens.length / 2500);
  for (let k = 0; k < maxStarts && left > 0; k++) {
    const apt = mApt >= hurdle && left >= 10;
    if (!apt && mHouse < hurdle) {
      if (sim.day % 90 < 31 && !sim.recentEvent('housing.unprofitable', 180))
        sim.emit('housing.unprofitable', `Developers say new housing does not pay at current rents${control ? ' under rent control' : ''}; ${Math.round(need)} more homes are needed.`, 2, undefined, undefined,
          [`New homes would sell for ${Math.round(Math.max(mApt, mHouse) * 100)}% over their building cost; developers want ${Math.round(hurdle * 100)}%`]);
      return;
    }
    const lot = findLot(sim, apt ? [Zone.Residential, Zone.Commercial] : [Zone.Residential]);
    if (!lot) {
      if (!sim.recentEvent('housing.noLand', 120))
        sim.emit('housing.noLand', `Developers cannot find zoned, road-connected land for new homes; ${Math.round(need)} more are needed.`, 2, undefined, undefined,
          ['Rezone land as residential or build roads into undeveloped areas']);
      return;
    }
    const dev = realestate(sim);
    const kind = apt ? 'apartment' : 'house';
    const floors = apt ? 110 : 1;
    createProject(sim, {
      kind, x: lot.x, y: lot.y, w: 1, h: 1, floors, gov: false, sponsor: dev.id,
      name: `${BUILDINGS[kind].label} by ${dev.name}`, reason: `Vacancy ${Math.round(vacancy * 100)}%, ${homeless} families without a home`,
    });
    left -= apt ? 24 : 1;
  }
}
