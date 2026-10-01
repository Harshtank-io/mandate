// Brings worlds saved by earlier versions up to date, so a persistent world keeps running after an update.

import { EXP_CATS, REV_CATS } from './core';
import { initAir, initFood, initLeisure, initTourism, initTrade } from './init';
import { getPreset, moneyScale } from './presets';
import { DEPTS, type MonthStats, type WorldState } from './types';

export const STATE_VERSION = 2;

const MONTH_DEFAULTS: Partial<MonthStats> = {
  leisure: 0.6, tourists: 0, foreignTourists: 0, touristNights: 0, tourismSpend: 0, turnedAway: 0, hotelRooms: 0, occupancy: 0, appeal: 0,
  passengers: 0, flights: 0, tradeBalance: 0, fx: 1, procured: 0, grainStock: 0, rationed: 0,
};

export function migrate(s: WorldState): WorldState {
  if ((s.v ?? 1) >= STATE_VERSION) return s;
  // v1 -> v2: leisure, tourism, aviation, foreign trade and food programmes
  const p = getPreset(s.meta.preset);
  const n = moneyScale(s.meta.preset, s.meta.startYear) * (s.ext?.trend ?? 1);
  const g = s.gov;
  for (const l of [g.m, g.last, g.ytd, g.lastYear]) {
    for (const c of REV_CATS) l.rev[c] ??= 0;
    for (const c of EXP_CATS) l.exp[c] ??= 0;
  }
  for (const d of DEPTS) { g.level[d] ??= 1; g.deptNeed[d] ??= 0; g.deptFunding[d] ??= 1; g.deptSpend[d] ??= 0; }
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
  for (const m of s.stats.months) for (const [k, v] of Object.entries(MONTH_DEFAULTS)) (m as unknown as Record<string, number>)[k] ??= v as number;
  s.v = STATE_VERSION;
  return s;
}
