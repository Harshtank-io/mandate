// Leisure and entertainment. Families spend part of their discretionary budget on outings: films, museum visits,
// matches and concerts at the stadium, the yearly festival. Parks are free. Venues need staff and audiences, and how
// well residents can get out and enjoy themselves feeds into their satisfaction.

import type { Account, Sim } from '../core';
import { emptyVenue } from '../init';
import { BUSINESSES, CINEMA_TICKET, CINEMA_TICKETS_PER_STAFF, DISTRIBUTOR_SHARE, FESTIVAL_COST, MUSEUM_TICKET, STADIUM_TICKET } from '../tables';
import type { Business, Household } from '../types';
import { fmtMoney } from './construction';
import { facilityQuality } from './services';

const nominalOf = (sim: Sim) => sim.scale * sim.s.ext.trend;
export const live = (b: Business) => b.status === 'operating' && b.downDays <= 0;
type VenueKind = 'cinema' | 'museum' | 'stadium';

/**
 * Visitors pay with money from outside the city. The shared selling functions check that a buyer can afford what it
 * buys, so visitors get a wallet funded from the outside world, and whatever is left goes back afterwards.
 */
export function withVisitorWallet<T>(sim: Sim, fn: (w: Account) => T): T {
  const w: Account = { cash: 0 };
  sim.pay(sim.s.ext, w, 1e7 * nominalOf(sim));
  try { return fn(w); } finally { if (w.cash > 0) sim.pay(w, sim.s.ext, w.cash); else if (w.cash < 0) sim.pay(sim.s.ext, w, -w.cash); }
}

export function ticketPrice(sim: Sim, kind: VenueKind, foreign = false): number {
  const n = nominalOf(sim);
  switch (kind) {
    case 'cinema': return CINEMA_TICKET * n * (0.75 + 0.25 * sim.s.labor.wage[1]);
    case 'museum': return MUSEUM_TICKET * n * (foreign ? 4 : 1);
    case 'stadium': return STADIUM_TICKET * n;
  }
}

/** Tickets a venue can handle today (per event for a stadium). */
export function venueCapacity(sim: Sim, b: Business): number {
  if (b.kind === 'cinema') {
    let staff = b.owner >= 0 ? 1 : 0;
    for (const j of b.jobs) if (j.worker >= 0) staff++;
    return staff * CINEMA_TICKETS_PER_STAFF;
  }
  return Math.floor((BUSINESSES[b.kind].serves ?? 0) * facilityQuality(sim, b));
}

/**
 * Sells up to `n` tickets at a venue. Cinema takings belong to the cinema, which pays the film distributor's share out
 * of the city; museum and stadium takings go to the city. Entertainment tax applies to cinema and stadium tickets.
 * Returns what the buyer paid in total.
 */
export function sellTickets(sim: Sim, payer: Account, b: Business, n: number, foreign = false, visitor = false): number {
  if (n <= 0 || !live(b)) return 0;
  const v = (b.venue ??= emptyVenue());
  const served = sim.ix.served.get(b.id) ?? 0;
  const cap = b.kind === 'stadium' ? venueCapacity(sim, b) - v.eventSold : venueCapacity(sim, b) - served;
  const q = Math.floor(Math.min(n, cap));
  if (q <= 0) return 0;
  const kind = b.kind as VenueKind;
  const value = q * ticketPrice(sim, kind, foreign);
  const rate = kind === 'museum' ? 0 : sim.s.gov.taxes.entertainment;
  if (payer.cash < value * (1 + rate)) return 0;
  if (kind === 'cinema') {
    sim.pay(payer, b, value);
    const dist = value * DISTRIBUTOR_SHARE;
    sim.pay(b, sim.s.ext, dist);
    b.m.cogs += dist;
  } else sim.tax('tickets', payer, value);
  b.m.revenue += value;
  b.m.sales += q;
  sim.tax('entertainmentTax', payer, value * rate);
  if (kind === 'stadium') v.eventSold += q; else sim.ix.served.set(b.id, served + q);
  v.sold += q;
  if (visitor) v.visitors += q;
  return value * (1 + rate);
}

/** Spending on outings that counts as "doing well": about two cinema tickets per person a month. */
function decentLevel(sim: Sim, people: number): number {
  return people * ticketPrice(sim, 'cinema') * (1 + sim.s.gov.taxes.entertainment) * 0.5;
}

/**
 * The household's outings this week, from its leisure budget. An outing costs a ticket per family member, so a
 * modest budget means going out now and then rather than every week. Wishes that find no venue or no seat are
 * recorded as unmet demand, which entrepreneurs notice.
 */
export function goOut(sim: Sim, h: Household, budget: number, cinemas: number[]): number {
  const s = sim.s, r = sim.rng;
  const people = Math.max(1, h.members.length);
  let spent = 0;
  if (budget > 0) {
    const stadium = s.businesses.find((b) => b.kind === 'stadium' && live(b) && b.venue && b.venue.nextEvent >= sim.day && b.venue.nextEvent - sim.day < 7);
    const museum = s.businesses.find((b) => b.kind === 'museum' && live(b));
    const plan: [VenueKind, number][] = [['cinema', 0.6], ['museum', museum ? 0.15 : 0], ['stadium', stadium ? 0.3 : 0]];
    const tot = plan.reduce((a, [, w]) => a + w, 0);
    for (const [kind, w] of plan) {
      if (w <= 0) continue;
      const money = (budget * w) / tot;
      const rate = kind === 'museum' ? 0 : s.gov.taxes.entertainment;
      const cost = people * ticketPrice(sim, kind) * (1 + rate);
      if (money < cost && !r.chance(money / cost)) continue;
      let paid = 0;
      if (kind === 'cinema') {
        for (const id of cinemas) {
          const b = sim.biz(id);
          if (!b || !live(b)) continue;
          paid = sellTickets(sim, h, b, people);
          if (paid > 0) break;
        }
      } else paid = sellTickets(sim, h, kind === 'museum' ? museum! : stadium!, people);
      if (paid <= 0) s.leisure.unmet += cost;
      spent += paid;
    }
  }
  s.leisure.spend += spent;
  h.m.leisure += spent;
  h.leisure = h.leisure * 0.85 + 0.15 * Math.min(1, spent / Math.max(1, decentLevel(sim, people) / 4.33));
  return spent;
}

const EVENTS = ['a league match', 'a concert', 'a derby', 'a cup semi-final', 'a music night', 'a championship game'];

function startFestival(sim: Sim, level: number): void {
  const s = sim.s;
  const fest = sim.preset.tourism.festival;
  const cost = FESTIVAL_COST[level] * nominalOf(sim);
  if (s.gov.arrears > 0) {
    sim.emit('leisure.festivalCancelled', `${fest.name} is cancelled this year: the treasury cannot pay for it.`, 2, undefined, undefined, ['The city is behind on its bills']);
    return;
  }
  // stages, lighting, decoration and catering are hired locally; performers and equipment largely come from outside
  const local = s.businesses.filter((b) => (b.kind === 'services' || b.kind === 'restaurant') && live(b));
  const localShare = local.length ? 0.55 : 0;
  for (const b of local) { const amt = (cost * localShare) / local.length; sim.spend('promotion', b, amt); b.m.revenue += amt; }
  sim.spend('promotion', s.ext, cost * (1 - localShare));
  s.tourism.festival = fest.days;
  s.tourism.festivalVisitors = 0;
  for (const h of s.households) h.leisure = Math.min(1, h.leisure + (level === 2 ? 0.35 : 0.2));
  sim.emit('leisure.festival', `${fest.name} begins: ${fest.days} days of celebrations${level === 2 ? ' with a grand programme' : ''}.`, 2, undefined, undefined,
    [`The city spends ${fmtMoney(sim, cost)} on the festival, ${Math.round(localShare * 100)}% of it with local firms`, 'Visitors come from across the region; hotels, restaurants and shops get busier', 'Residents enjoy the celebrations']);
}

export function leisureDaily(sim: Sim): void {
  const s = sim.s;
  for (const b of s.businesses) {
    if (b.kind !== 'stadium' || !live(b)) continue;
    const v = (b.venue ??= emptyVenue());
    if (v.nextEvent < 0) { v.nextEvent = sim.day + 2 + sim.rng.int(6); continue; }
    if (sim.day < v.nextEvent) continue;
    // match day: fans from the surrounding region come too
    const cap = venueCapacity(sim, b);
    const outside = Math.floor(Math.max(0, Math.min(cap - v.eventSold, v.eventSold * 0.35 + cap * 0.05 * s.tourism.awareness)));
    const paid = withVisitorWallet(sim, (w) => sellTickets(sim, w, b, outside, false, true));
    if (paid > 0) {
      const T = s.tourism;
      T.m.domestic += outside; T.m.dayTrips += outside; T.m.spend += paid;
      T.total.visitors += outside; T.total.spend += paid;
    }
    const crowd = v.eventSold;
    v.lastCrowd = crowd;
    v.events++;
    v.eventSold = 0;
    const perMonth = Math.max(1, Math.round((1 + s.citizens.length / 5000) * Math.min(1.2, s.gov.deptFunding.culture) * Math.max(0.3, facilityQuality(sim, b))));
    v.nextEvent = sim.day + Math.max(3, Math.round(30 / perMonth));
    if (crowd >= 2500) sim.emit('leisure.event', `${crowd.toLocaleString('en-US')} people watched ${EVENTS[sim.day % EVENTS.length]} at ${b.name}.`, 1, { k: 'building', id: b.building });
  }
  const fest = sim.preset.tourism.festival, level = s.gov.policies.festival;
  if (level > 0 && s.tourism.festival === 0 && sim.date.month === fest.month && sim.date.dom === 1) startFestival(sim, level);
}

const W8 = 16;

export function leisureMonthly(sim: Sim): void {
  const s = sim.s, L = s.leisure;
  // heritage sites are conserved by the culture department; without funding they decay
  const f = Math.min(1.2, s.gov.deptFunding.culture);
  for (const b of s.buildings) if (b.kind === 'heritage') b.condition = Math.max(0.05, Math.min(1, b.condition + 0.02 * f - 0.012));
  // access to places to go: parks, cinemas, museums, stadiums and heritage sites, with distance decay
  const spots: { x: number; y: number; w: number; r: number }[] = [];
  for (const b of s.buildings) {
    const [x, y] = sim.center(b);
    if (b.kind === 'park') spots.push({ x, y, w: 0.35, r: 10 });
    else if (b.kind === 'heritage') spots.push({ x, y, w: 0.25 * b.condition, r: 40 });
    else if (b.biz >= 0) {
      const biz = sim.biz(b.biz);
      if (!biz || !live(biz)) continue;
      if (biz.kind === 'cinema') spots.push({ x, y, w: 0.45, r: 30 });
      else if (biz.kind === 'museum') spots.push({ x, y, w: 0.35, r: 45 });
      else if (biz.kind === 'stadium') spots.push({ x, y, w: 0.3, r: 50 });
    }
  }
  for (let k = 0; k < W8 * W8; k++) {
    const cx = (k % W8) * 8 + 4, cy = Math.floor(k / W8) * 8 + 4;
    let a = 0;
    for (const p of spots) a += p.w / (1 + (Math.hypot(cx - p.x, cy - p.y) / p.r) ** 2);
    L.cov[k] = Math.min(1, a);
  }
  L.lastUnmet = L.unmet; L.unmet = 0;
  L.lastSpend = L.spend; L.spend = 0;
  for (const b of s.businesses) {
    const v = b.venue;
    if (!v) continue;
    v.lastSold = v.sold; v.sold = 0;
    v.lastVisitors = v.visitors; v.visitors = 0;
    v.lastEvents = v.events; v.events = 0;
  }
}
