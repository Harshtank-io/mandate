// Brings worlds saved by earlier versions up to date, so a persistent world keeps running after an update.

import { EXP_CATS, REV_CATS } from './core';
import { initAir, initFood, initLeisure, initTourism, initTrade, initUtilities } from './init';
import { getPreset, moneyScale } from './presets';
import { DEPTS, type MonthStats, type WorldState } from './types';

export const STATE_VERSION = 3;

const MONTH_DEFAULTS_V2: Partial<MonthStats> = {
  leisure: 0.6, tourists: 0, foreignTourists: 0, touristNights: 0, tourismSpend: 0, turnedAway: 0, hotelRooms: 0, occupancy: 0, appeal: 0,
  passengers: 0, flights: 0, tradeBalance: 0, fx: 1, procured: 0, grainStock: 0, rationed: 0,
};
const MONTH_DEFAULTS_V3: Partial<MonthStats> = {
  powerPeak: 0, powerCap: 0, powerServed: 1, waterServed: 1, waterUse: 0, waterCap: 0, blackouts: 0, fires: 0, burned: 0, fireCoverage: 0,
};

function monthDefaults(s: WorldState, d: Partial<MonthStats>): void {
  for (const m of s.stats.months) for (const [k, v] of Object.entries(d)) (m as unknown as Record<string, number>)[k] ??= v as number;
}

function ledgers(s: WorldState): void {
  const g = s.gov;
  for (const l of [g.m, g.last, g.ytd, g.lastYear]) {
    for (const c of REV_CATS) l.rev[c] ??= 0;
    for (const c of EXP_CATS) l.exp[c] ??= 0;
  }
  for (const d of DEPTS) { g.level[d] ??= 1; g.deptNeed[d] ??= 0; g.deptFunding[d] ??= 1; g.deptSpend[d] ??= 0; }
}

/** v1 -> v2: leisure, tourism, aviation, foreign trade and food programmes. */
function toV2(s: WorldState): void {
  const p = getPreset(s.meta.preset);
  const n = moneyScale(s.meta.preset, s.meta.startYear) * (s.ext?.trend ?? 1);
  const g = s.gov;
  ledgers(s);
  const t = g.taxes;
  t.importFood ??= t.import;
  t.tourism ??= p.taxes.tourism;
  t.entertainment ??= p.taxes.entertainment;
  t.passengerFee ??= p.taxes.passengerFee * n;
  const pol = g.policies;
  // new programmes start switched off in existing worlds: nothing starts costing money without a decision
  pol.msp ??= 0; pol.rationShops ??= false; pol.povertyTransfer ??= 0; pol.exportIncentive ??= 0;
  pol.investmentIncentive ??= 0; pol.tourismPromotion ??= 0; pol.festival ??= 0;
  for (const h of s.households) {
    h.ration ??= 0;
    h.leisure ??= 0.5;
    h.m.leisure ??= 0;
    h.last.leisure ??= 0;
  }
  s.leisure ??= initLeisure();
  s.tourism ??= initTourism(p);
  s.air ??= initAir();
  s.trade ??= initTrade(p);
  s.pds ??= initFood();
  monthDefaults(s, MONTH_DEFAULTS_V2);
}

/**
 * v2 -> v3: electricity, water and the fire service. Towns that existed before had these services without them being
 * simulated, so on the first day they get the waterworks and fire station they would have had, and a grid
 * connection with some headroom over today's demand (see utilities.ts).
 */
function toV3(s: WorldState): void {
  ledgers(s);
  s.gov.taxes.power ??= 1;
  s.gov.taxes.water ??= 1;
  for (const h of s.households) { h.m.utilities ??= 0; h.last.utilities ??= 0; }
  s.services.fireCov ??= new Array(256).fill(0);
  s.stats.acc.fires ??= 0;
  s.stats.acc.burned ??= 0;
  if (!s.util) { s.util = initUtilities(0); s.util.retrofit = true; }
  monthDefaults(s, MONTH_DEFAULTS_V3);
}

export function migrate(s: WorldState): WorldState {
  const v = s.v ?? 1;
  if (v >= STATE_VERSION) return s;
  if (v < 2) toV2(s);
  if (v < 3) toV3(s);
  s.v = STATE_VERSION;
  return s;
}
