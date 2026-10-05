// The regional airport. Airlines (outside firms) open routes once the airport operates and add or cut flights with
// demand: residents travelling, business trips and visitors. Flights bring visitors who could not come by road,
// carry perishable cargo to distant markets and put the city within reach of business clients.

import type { Sim } from '../core';
import { emptyAirLedger } from '../init';
import { AIRFARE, LANDING_FEE, SEATS_PER_FLIGHT, VISITOR_BASE } from '../tables';
import type { AirRoute, Business, Household } from '../types';

export function airportOf(sim: Sim): Business | undefined {
  return sim.s.businesses.find((b) => b.kind === 'airport' && b.status === 'operating');
}

/** Flights a route operates in each direction on a given day. */
export function flightsOn(r: AirRoute, day: number): number {
  return Math.floor(((day + 1) * r.weekly) / 7) - Math.floor((day * r.weekly) / 7);
}

export function weeklyFlights(sim: Sim): number {
  return sim.s.air.routes.reduce((a, r) => a + r.weekly, 0);
}

/** 0..1 how well connected the city is by air. */
export function connectivity(sim: Sim): number {
  return Math.min(1, weeklyFlights(sim) / 21);
}

const flyerIncome = (sim: Sim) => 8_000 * sim.scale * sim.s.ext.trend;

/** Resident air trips a month (one way), from household incomes, plus business travel. */
function residentTrips(sim: Sim): { residents: number; business: number } {
  const s = sim.s;
  const n = sim.scale * s.ext.trend;
  let trips = 0;
  for (const h of s.households) {
    const x = Math.max(0, Math.min(2, h.incAvg / (40_000 * n) - 0.2));
    trips += x * 0.35 * 2;
  }
  let business = 0;
  for (const b of s.businesses) {
    if (b.status !== 'operating') continue;
    if (b.kind === 'office') business += 12;
    else if (b.kind === 'factory' || b.kind === 'foodplant') business += 6;
    else if (b.kind === 'hotel') business += 2;
  }
  return { residents: trips, business };
}

/** Passengers a month (both directions) a new airport could expect today; used for the national co-funding test. */
export function projectedPassengers(sim: Sim): number {
  const s = sim.s, T = s.tourism;
  const { residents, business } = residentTrips(sim);
  const rep = 0.5 + T.reputation;
  const dom = VISITOR_BASE.domestic * T.appeal * T.awareness * rep * 0.3;
  const forn = VISITOR_BASE.foreign * T.appeal * Math.max(T.awarenessIntl, 0.15) * rep * 0.85 * s.trade.fx;
  return Math.round(residents + business + (dom + forn) * 30 * 2);
}

/**
 * Seats into the city today not taken by residents and business travellers (used by the visitor model). Every trip
 * out by a resident is a seat back in later, so on average a day's outbound trips also fill that many inbound seats.
 */
export function seatsForVisitors(sim: Sim): number {
  const s = sim.s;
  if (!s.air.routes.length) return 0;
  let seats = 0;
  for (const r of s.air.routes) seats += flightsOn(r, sim.day) * SEATS_PER_FLIGHT;
  return Math.max(0, seats - (s.air.resTrips + s.air.bizTrips) / 30);
}

/** Visitors flying in today (and out again later): fees and passenger counts. */
export function boardVisitors(sim: Sim, n: number): void {
  if (n <= 0) return;
  const s = sim.s, A = s.air;
  const fee = sim.tax('airportFees', s.ext, n * s.gov.taxes.passengerFee);
  A.m.fees += fee;
  A.m.pax += n * 2;
  A.m.tourists += n * 2;
  A.totalPax += n * 2;
  spreadPax(sim, n * 2);
}

function spreadPax(sim: Sim, pax: number): void {
  const rs = sim.s.air.routes;
  const tot = rs.reduce((a, r) => a + r.weekly, 0);
  if (tot <= 0) return;
  for (const r of rs) r.pax += (pax * r.weekly) / tot;
}

export function aviationDaily(sim: Sim): void {
  const s = sim.s, A = s.air, r = sim.rng;
  const ap = airportOf(sim);
  if (!ap) return;
  const n = sim.scale * s.ext.trend;
  for (const p of [...A.pending]) {
    if (sim.day < p.day) continue;
    A.pending.splice(A.pending.indexOf(p), 1);
    A.routes.push({ id: sim.newId(), dest: p.dest, airline: p.airline, intl: p.intl, weekly: p.weekly, since: sim.day, pax: 0, lastPax: 0, seats: 0, lastSeats: 0, high: 0, low: 0 });
    sim.emit('air.route', `${p.airline} starts flying ${s.meta.name}–${p.dest}, ${p.weekly} flights a week.`, 2, { k: 'building', id: ap.building }, undefined,
      [p.intl ? 'Visitors from abroad can now fly in directly' : 'Visitors and business travellers can fly in; residents can fly out', 'The airport earns landing and passenger fees']);
  }
  let flights = 0, seats = 0;
  for (const rt of A.routes) {
    const f = flightsOn(rt, sim.day);
    flights += f * 2;
    seats += f * 2 * SEATS_PER_FLIGHT;
    rt.seats += f * 2 * SEATS_PER_FLIGHT;
  }
  if (flights > 0) {
    // airlines pay landing fees for every arrival
    A.m.fees += sim.tax('airportFees', s.ext, (flights / 2) * LANDING_FEE * n);
    // residents and business travellers fly out and back, within the seats available
    const cap = seats / 2;
    const want = (A.resTrips + A.bizTrips) / 30;
    const fly = Math.min(cap, r.poisson(want));
    const res = want > 0 ? Math.round((fly * A.resTrips) / (A.resTrips + A.bizTrips)) : 0;
    const fare = AIRFARE * n * 2;
    const min = flyerIncome(sim);
    const list: Household[] = res > 0 ? s.households.filter((h) => h.incAvg > min) : [];
    let flown = 0;
    for (let k = 0; k < res && list.length; k++) {
      const h = list[r.int(list.length)];
      if (h.cash < fare * 3) continue;
      sim.pay(h, s.ext, fare);
      const fee = sim.tax('airportFees', h, s.gov.taxes.passengerFee);
      h.m.transport += fare + fee;
      A.m.fees += fee;
      flown++;
    }
    const biz = fly - res;
    if (biz > 0) A.m.fees += sim.tax('airportFees', s.ext, biz * s.gov.taxes.passengerFee);
    A.m.residents += flown * 2;
    A.m.business += Math.max(0, biz) * 2;
    A.m.pax += (flown + Math.max(0, biz)) * 2;
    A.totalPax += (flown + Math.max(0, biz)) * 2;
    spreadPax(sim, (flown + Math.max(0, biz)) * 2);
  }
  A.m.flights += flights;
  A.m.seats += seats;
}

export function aviationMonthly(sim: Sim): void {
  const s = sim.s, A = s.air, r = sim.rng;
  const ap = airportOf(sim);
  const hubs = sim.preset.tourism.hubs, intl = sim.preset.tourism.intlHubs, lines = sim.preset.tourism.airlines;
  if (!ap) {
    if (A.routes.length || A.pending.length) { A.routes = []; A.pending = []; }
  } else {
    if (A.opened < 0) {
      A.opened = sim.day;
      const airline = lines[0];
      A.pending.push({ dest: hubs[0], airline, intl: false, weekly: 4, day: sim.day + 45 });
      sim.emit('air.announced', `${airline} will start flights from ${s.meta.name} to ${hubs[0]} in about six weeks.`, 2, { k: 'building', id: ap.building });
    }
    for (const rt of [...A.routes]) {
      const load = rt.seats > 0 ? rt.pax / rt.seats : 0;
      rt.high = load > 0.8 ? rt.high + 1 : 0;
      rt.low = load < 0.4 && sim.day - rt.since > 90 ? rt.low + 1 : 0;
      if (rt.high >= 2 && rt.weekly < 21) {
        rt.weekly = Math.min(21, rt.weekly + 2);
        rt.high = 0;
        sim.emit('air.more', `${rt.airline} adds flights to ${rt.dest}: now ${rt.weekly} a week.`, 1, undefined, undefined, [`Flights were ${Math.round(load * 100)}% full for two months`]);
      } else if (rt.low >= 3) {
        rt.weekly -= 2;
        rt.low = 0;
        if (rt.weekly < 2) {
          A.routes.splice(A.routes.indexOf(rt), 1);
          sim.emit('air.dropped', `${rt.airline} drops its ${rt.dest} route.`, 2, undefined, undefined, [`Flights were only ${Math.round(load * 100)}% full`]);
        } else sim.emit('air.fewer', `${rt.airline} cuts flights to ${rt.dest} to ${rt.weekly} a week.`, 1, undefined, undefined, [`Flights were only ${Math.round(load * 100)}% full`]);
      }
      rt.lastPax = rt.pax; rt.pax = 0;
      rt.lastSeats = rt.seats; rt.seats = 0;
    }
    // new routes: a second hub once flights are busy, an international link when enough foreign visitors come
    const busy = A.routes.length > 0 && A.routes.every((rt) => rt.weekly >= 7 && rt.lastSeats > 0 && rt.lastPax / rt.lastSeats > 0.7);
    const flying = new Set([...A.routes.map((x) => x.dest), ...A.pending.map((x) => x.dest)]);
    const nextHub = hubs.find((h) => !flying.has(h));
    if (busy && nextHub && !A.pending.length) {
      const airline = lines[(A.routes.length + 1) % lines.length];
      A.pending.push({ dest: nextHub, airline, intl: false, weekly: 4, day: sim.day + 60 });
      sim.emit('air.announced', `${airline} announces flights to ${nextHub}.`, 2);
    }
    const hasIntl = A.routes.some((x) => x.intl) || A.pending.some((x) => x.intl);
    if (!hasIntl && A.routes.length && s.tourism.m.foreign > 450 && r.chance(0.5)) {
      const dest = intl[0];
      const airline = lines[lines.length - 1];
      A.pending.push({ dest, airline, intl: true, weekly: 3, day: sim.day + 90 });
      sim.emit('air.announced', `${airline} will open an international route to ${dest}.`, 2, undefined, undefined, [`${Math.round(s.tourism.m.foreign)} foreign visitors came last month`]);
    }
  }
  const d = residentTrips(sim);
  A.resTrips = d.residents;
  A.bizTrips = d.business;
  A.last = A.m;
  A.m = emptyAirLedger();
}
