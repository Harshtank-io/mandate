// Starting values for the leisure, tourism, aviation, trade and food-programme parts of a world. Shared by world
// generation and by the migration of worlds saved before these systems existed.

import type { Preset } from './presets';
import type { AirLedger, AirState, FoodProgrammes, LeisureState, TourismLedger, TourismState, TradeState, UtilityLedger, UtilityState, VenueState } from './types';

export const emptyUtilityLedger = (): UtilityLedger => ({ kwh: 0, short: 0, grid: 0, gas: 0, solar: 0, wind: 0, water: 0, waterShort: 0, bills: 0, cost: 0, blackouts: 0, outages: 0 });

/** Electricity and water before the first day is simulated. The regional grid line is sized by the caller. */
export function initUtilities(gridBase: number): UtilityState {
  return {
    gridBase, outage: 0, unit: 0, peak: 0, cap: 0, waterUse: 0, waterCap: 0, served: 1, waterServed: 1, wind: 0.28, sun: 0.2,
    m: emptyUtilityLedger(), last: emptyUtilityLedger(),
  };
}

export const emptyTourismLedger = (): TourismLedger => ({ domestic: 0, foreign: 0, dayTrips: 0, nights: 0, turned: 0, byAir: 0, spend: 0, rooms: 0 });
export const emptyAirLedger = (): AirLedger => ({ pax: 0, residents: 0, tourists: 0, business: 0, flights: 0, seats: 0, fees: 0 });
export const emptyVenue = (): VenueState => ({ sold: 0, lastSold: 0, visitors: 0, lastVisitors: 0, events: 0, lastEvents: 0, nextEvent: -1, eventSold: 0, lastCrowd: 0 });

/** Monthly seasonality of visits from the regional climate: people travel when it is mild and dry. Mean 1. */
export function seasonality(p: Preset): number[] {
  const raw = p.climate.temp.map((t, m) => Math.exp(-(((t - 23) / 9) ** 2)) * (1 - Math.min(0.7, p.climate.rain[m] / 350)) + 0.15);
  const mean = raw.reduce((a, x) => a + x, 0) / 12;
  return raw.map((x) => x / mean);
}

export function initTourism(p: Preset): TourismState {
  return {
    awareness: 0.5, awarenessIntl: 0.1, reputation: 0.6, appeal: 0, appealParts: {}, season: seasonality(p),
    inDom: 0, inFor: 0, festival: 0, festivalVisitors: 0, m: emptyTourismLedger(), last: emptyTourismLedger(),
    total: { visitors: 0, foreign: 0, spend: 0 },
  };
}

export function initAir(): AirState {
  return { routes: [], pending: [], opened: -1, m: emptyAirLedger(), last: emptyAirLedger(), totalPax: 0, resTrips: 0, bizTrips: 0 };
}

export function initTrade(p: Preset): TradeState {
  return {
    partners: p.partners.map((q) => ({
      id: q.id, name: q.name, dist: q.dist, tariffGoods: q.tariffGoods, tariffAgri: q.tariffAgri, buys: [...q.buys], sells: [...q.sells],
      status: q.agreement ? 'agreement' : 'none', statusDay: q.agreement ? -3650 : 0, due: -1, dispute: 0,
      exp: 0, imp: 0, lastExp: 0, lastImp: 0, totalExp: 0, totalImp: 0,
    })),
    fx: 1, fxDev: 0, lastTalks: -9999,
  };
}

export function initLeisure(): LeisureState {
  return { cov: new Array(256).fill(0), unmet: 0, lastUnmet: 0, spend: 0, lastSpend: 0, avg: 0.6 };
}

export function initFood(): FoodProgrammes {
  return { stock: 0, stockValue: 0, procured: 0, lastProcured: 0, procuredValue: 0, lastProcuredValue: 0, rationed: 0, lastRationed: 0, sold: 0, lastSold: 0, families: 0 };
}
