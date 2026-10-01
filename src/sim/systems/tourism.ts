// Visitors. Domestic and foreign tourists come for the region's attractions when they know about it, can get there
// and find somewhere to stay. They fill hotels, eat in restaurants, shop, hire guides and pay entry fees, bringing
// money in from outside, and they use the same businesses residents use, so they also compete for them.

import type { Account, Sim } from '../core';
import { emptyTourismLedger } from '../init';
import { goodsRetail, mealPrice, servicePrice } from '../econ';
import {
  BUSINESSES, DAY_TRIP_SHARE, FESTIVAL_BOOST, FOREIGN_RATE, HERITAGE_FEE, HOTEL_ROOMS_PER_FLOOR, HOTEL_SUPPLY_SHARE,
  PROMOTION_COST, PROMOTION_REACH, ROOM_RATE, STAY_NIGHTS, VISITOR_BASE, VISITOR_SPEND,
} from '../tables';
import type { Business, HotelState } from '../types';
import { boardVisitors, connectivity, seatsForVisitors } from './aviation';
import { purchase, serveMeals, serveServices, visitorStores } from './households';
import { live, sellTickets, withVisitorWallet } from './leisure';
import { facilityQuality } from './services';

const nominalOf = (sim: Sim) => sim.scale * sim.s.ext.trend;

export function hotelRooms(sim: Sim, b: Business): number {
  const bl = sim.bld(b.building);
  return bl && bl.kind === 'hotel' ? bl.floors * HOTEL_ROOMS_PER_FLOOR : 0;
}

export function hotelOf(b: Business): HotelState {
  return (b.hotel ??= { rooms: 0, occupied: 0, nights: 0, lastNights: 0, guests: 0, lastGuests: 0, foreign: 0, lastForeign: 0 });
}

/** Rooms a hotel can keep clean and staffed tonight. */
function serviceable(sim: Sim, b: Business): number {
  const rooms = hotelRooms(sim, b);
  const floors = sim.bld(b.building)?.floors ?? 4;
  const need = BUSINESSES.hotel.jobs.reduce((a, [, n]) => a + n, 0) * Math.max(1, Math.round(floors / 4)) * 0.8;
  let staff = b.owner >= 0 ? 1 : 0;
  for (const j of b.jobs) if (j.worker >= 0) staff++;
  return rooms * Math.min(1, staff / Math.max(1, need));
}

export function roomRate(sim: Sim, foreign: boolean): number {
  return ROOM_RATE * nominalOf(sim) * (0.8 + 0.2 * sim.s.labor.wage[1]) * (foreign ? FOREIGN_RATE : 1);
}

/** The attractions index and its parts: what there is to see and do, and how pleasant the city is to visit. */
export function computeAppeal(sim: Sim): void {
  const s = sim.s, T = s.tourism;
  const parts: Record<string, number> = { heritage: 0, museum: 0, stadium: 0, parks: 0, nature: sim.preset.tourism.nature, river: 0.2, food: 0, cinema: 0 };
  let parks = 0, restaurants = 0, cinemas = 0;
  for (const b of s.buildings) {
    if (b.kind === 'heritage') parts.heritage += 1.2 * b.condition;
    else if (b.kind === 'park') parks++;
  }
  for (const b of s.businesses) {
    if (!live(b)) continue;
    if (b.kind === 'museum') parts.museum += 0.9 * facilityQuality(sim, b);
    else if (b.kind === 'stadium') parts.stadium += 0.35 * facilityQuality(sim, b);
    else if (b.kind === 'restaurant') restaurants++;
    else if (b.kind === 'cinema') cinemas++;
  }
  parts.parks = Math.min(0.4, 0.08 * parks);
  parts.food = Math.min(0.3, 0.025 * restaurants);
  parts.cinema = Math.min(0.1, 0.04 * cinemas);
  const st = s.stats.months[s.stats.months.length - 1];
  const safety = Math.max(0.5, Math.min(1, 1 - s.services.crime * 5));
  const clean = 1 - Math.min(0.4, (st?.pollution ?? 0) * 0.8);
  const crowd = 1 / (1 + Math.max(0, s.traffic.congestion - 1.15) * 0.6);
  const sum = Object.values(parts).reduce((a, x) => a + x, 0);
  T.appeal = sum * safety * clean * crowd;
  T.appealParts = { ...parts, xSafety: safety, xClean: clean, xCrowd: crowd };
}

/** What visitors present today spend besides their rooms. Returns the total paid. */
function visitorSpending(sim: Sim, d: number, f: number): number {
  return withVisitorWallet(sim, (w) => spendFrom(sim, w, d, f));
}

function spendFrom(sim: Sim, ext: Account, d: number, f: number): number {
  const s = sim.s, t = s.gov.taxes, n = nominalOf(sim);
  const V = VISITOR_SPEND;
  const st = visitorStores(sim);
  let paid = 0;
  const meals = Math.floor(d * V.domestic.meals + f * V.foreign.meals);
  if (meals > 0) paid += serveMeals(sim, ext, st.restaurant, meals, mealPrice(sim));
  const gp = goodsRetail(sim);
  const crates = ((d * V.domestic.goods + f * V.foreign.goods) * n) / (gp * (1 + t.sales));
  if (crates > 0.01) paid += purchase(sim, ext, st.shop, 'goods', crates, gp, 'salesTax', t.sales).cost;
  const sp = servicePrice(sim);
  const jobs = Math.floor(((d * V.domestic.services + f * V.foreign.services) * n) / (sp * (1 + t.sales)));
  if (jobs > 0) paid += serveServices(sim, ext, st.services, jobs, sp);
  // heritage sites charge an entry fee (foreigners pay more), collected by the city
  const sites = s.buildings.filter((b) => b.kind === 'heritage');
  if (sites.length) {
    const cond = sites.reduce((a, b) => a + b.condition, 0) / sites.length;
    const fee = (d * V.domestic.heritage * HERITAGE_FEE.domestic + f * V.foreign.heritage * HERITAGE_FEE.foreign) * n * Math.min(1, 0.4 + cond);
    paid += sim.tax('tickets', ext, fee);
  }
  const museum = s.businesses.find((b) => b.kind === 'museum' && live(b));
  if (museum) {
    paid += sellTickets(sim, ext, museum, Math.round(d * V.domestic.museum), false, true);
    paid += sellTickets(sim, ext, museum, Math.round(f * V.foreign.museum), true, true);
  }
  for (const id of st.cinema) {
    const b = sim.biz(id);
    if (b && live(b)) { paid += sellTickets(sim, ext, b, Math.round(d * V.domestic.cinema + f * V.foreign.cinema), false, true); break; }
  }
  return paid;
}

export function tourismDaily(sim: Sim): void {
  const s = sim.s, T = s.tourism, r = sim.rng, pol = s.gov.policies;
  if (!T.appeal) computeAppeal(sim);
  const season = T.season[sim.date.month] ?? 1;
  const fest = T.festival > 0 ? 1 + FESTIVAL_BOOST[Math.max(1, pol.festival)] : 1;
  const rep = 0.5 + T.reputation;
  let dom = VISITOR_BASE.domestic * T.appeal * T.awareness * rep * season * (0.85 + 0.15 * s.ext.demand) * fest;
  let forn = VISITOR_BASE.foreign * T.appeal * T.awarenessIntl * rep * season * s.ext.demand * s.trade.fx * (T.festival > 0 ? 1 + (fest - 1) * 0.3 : 1);
  if (s.weather.pandemic > 0) { dom *= 0.3; forn *= 0.1; }
  // getting here: long-distance visitors fly when there are flights, otherwise many do not come at all
  const airD = dom * 0.3, airF = forn * 0.85;
  const seats = seatsForVisitors(sim);
  const want = airD + airF;
  const got = Math.min(want, seats);
  const f = want > 0 ? got / want : 0;
  dom -= airD * (1 - f) * 0.5;
  forn -= airF * (1 - f) * 0.75;
  const nd = r.poisson(Math.max(0, dom)), nf = r.poisson(Math.max(0, forn));
  const flyIn = Math.min(nd + nf, Math.round(got));
  boardVisitors(sim, flyIn);
  // day-trippers and overnight guests
  const dtD = Math.round(nd * DAY_TRIP_SHARE.domestic), dtF = Math.round(nf * DAY_TRIP_SHARE.foreign);
  const oD = nd - dtD, oF = nf - dtF;
  const hotels = s.businesses.filter((b) => b.kind === 'hotel' && live(b));
  let capacity = 0;
  const caps = hotels.map((b) => { const c = serviceable(sim, b); capacity += c; return c; });
  const stayD = T.inDom * (1 - 1 / STAY_NIGHTS.domestic), stayF = T.inFor * (1 - 1 / STAY_NIGHTS.foreign);
  const free = Math.max(0, capacity - (stayD + stayF) / 2);
  const needRooms = (oD + oF) / 2;
  const housed = needRooms > 0 ? Math.min(1, free / needRooms) : 1;
  const turned = (oD + oF) * (1 - housed);
  const extraDay = oD * (1 - housed) * 0.5; // some domestic visitors come for the day instead
  T.inDom = stayD + oD * housed;
  T.inFor = stayF + oF * housed;
  const occupied = Math.min(capacity, (T.inDom + T.inFor) / 2);
  const guests = T.inDom + T.inFor;
  const rateD = roomRate(sim, false), rateF = roomRate(sim, true);
  const avgRate = guests > 0 ? (T.inDom * rateD + T.inFor * rateF) / guests : rateD;
  let rooms = 0;
  hotels.forEach((b, k) => {
    const h = hotelOf(b);
    h.rooms = hotelRooms(sim, b);
    const share = capacity > 0 ? caps[k] / capacity : 0;
    const occ = occupied * share;
    h.occupied = occ;
    const value = occ * avgRate;
    if (value <= 0) return;
    sim.pay(s.ext, b, value);
    sim.tax('tourismTax', s.ext, value * s.gov.taxes.tourism);
    const supplies = value * HOTEL_SUPPLY_SHARE;
    sim.pay(b, s.ext, supplies);
    b.m.revenue += value;
    b.m.cogs += supplies;
    b.m.sales += occ;
    h.nights += occ;
    h.guests += (oD + oF) * housed * share;
    h.foreign += oF * housed * share;
    rooms += value;
  });
  const spent = visitorSpending(sim, T.inDom + dtD + extraDay, T.inFor + dtF);
  const total = rooms * (1 + s.gov.taxes.tourism) + spent;
  const M = T.m;
  M.domestic += nd; M.foreign += nf; M.dayTrips += dtD + dtF;
  M.nights += guests; M.turned += turned; M.byAir += flyIn; M.spend += total; M.rooms += rooms;
  T.total.visitors += nd + nf; T.total.foreign += nf; T.total.spend += total;
  if (T.festival > 0) {
    T.festivalVisitors += nd + nf;
    if (--T.festival === 0) sim.emit('leisure.festivalEnded', `${sim.preset.tourism.festival.name} is over: about ${Math.round(T.festivalVisitors).toLocaleString('en-US')} visitors came during the festival.`, 2, undefined, undefined,
      ['Hotels, restaurants, shops and local services took in extra business', 'Residents enjoyed the celebrations']);
  }
}

/** Promotion campaigns are paid monthly, before the month's accounts are closed. */
export function tourismCosts(sim: Sim): void {
  const lvl = sim.s.gov.policies.tourismPromotion;
  if (lvl > 0) sim.spend('promotion', sim.s.ext, PROMOTION_COST[lvl] * nominalOf(sim));
}

export function tourismMonthly(sim: Sim): void {
  const s = sim.s, T = s.tourism, M = T.m;
  const overnight = Math.max(1, M.domestic + M.foreign - M.dayTrips);
  const turnedShare = Math.min(1, M.turned / overnight);
  const safety = Math.max(0, 1 - s.services.crime * 6);
  const st = s.stats.months[s.stats.months.length - 1];
  const clean = 1 - Math.min(1, (st?.pollution ?? 0) * 1.5);
  const sites = s.buildings.filter((b) => b.kind === 'heritage');
  const upkeep = sites.length ? sites.reduce((a, b) => a + b.condition, 0) / sites.length : 0.7;
  const experience = 0.35 * (1 - Math.min(1, turnedShare * 2)) + 0.25 * safety + 0.2 * clean + 0.2 * upkeep;
  T.reputation += (experience - T.reputation) * 0.1;
  // promotion raises awareness slowly; flights add reach
  const lvl = s.gov.policies.tourismPromotion;
  const air = connectivity(sim);
  const intl = s.air.routes.some((r) => r.intl) ? 0.15 : 0;
  T.awareness += (PROMOTION_REACH.domestic[lvl] + 0.1 * air - T.awareness) * 0.06;
  T.awarenessIntl += (PROMOTION_REACH.foreign[lvl] + 0.05 * air + intl - T.awarenessIntl) * 0.06;
  if (turnedShare > 0.15 && M.turned > 60 && !sim.recentEvent('tourism.full', 90)) {
    sim.emit('tourism.full', `Hotels turned away about ${Math.round(M.turned).toLocaleString('en-US')} visitors last month.`, 2, undefined, undefined,
      [`${Math.round(turnedShare * 100)}% of overnight visitors found no room`, 'Hotel investors look for commercial land when rooms are full', 'Visitors who find no room tell others: reputation suffers']);
  }
  for (const b of s.businesses) {
    const h = b.hotel;
    if (!h) continue;
    h.lastNights = h.nights; h.nights = 0;
    h.lastGuests = h.guests; h.guests = 0;
    h.lastForeign = h.foreign; h.foreign = 0;
  }
  T.last = M;
  T.m = emptyTourismLedger();
  computeAppeal(sim);
}
