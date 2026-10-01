// Freight: every wholesale trade becomes a truck trip on the road network. Local logistics companies
// have a finite fleet; when it is busy, deliveries wait, shelves run down and shortages appear.

import { MIN_PER_DAY } from '../calendar';
import type { Account, Sim } from '../core';
import { buyFuel } from '../econ';
import { GOOD_SPECS } from '../tables';
import type { Business, Good, Shipment } from '../types';
import { findPath, pathKm, pathSeconds } from './transport';

export interface Freight {
  good: Good;
  qty: number;
  value: number;
  from: number;
  to: number;
  fromTile: number;
  toTile: number;
  purpose: Shipment['purpose'];
  project: number;
  payer: Account;
  payerBiz: Business | null;
  gov: boolean;
}

function workingTime(minute: number): number {
  const day = Math.floor(minute / MIN_PER_DAY);
  const t = minute - day * MIN_PER_DAY;
  if (t < 360) return day * MIN_PER_DAY + 360;
  if (t > 1200) return (day + 1) * MIN_PER_DAY + 360;
  return minute;
}

/** Freight cost per unit of a good for a trip of `km` (used for import/export parity). */
export const FREIGHT_PER_KM = 30;
export const FREIGHT_HANDLING = 300;

export function freightPerUnit(sim: Sim, g: Good, km: number): number {
  const nominal = sim.scale * sim.s.ext.trend;
  const truck = FREIGHT_PER_KM * nominal * km * 2 + 0.32 * km * 2 * sim.fuelPrice() + FREIGHT_HANDLING * nominal;
  return truck / GOOD_SPECS[g].truck;
}

export function dispatch(sim: Sim, f: Freight): Shipment {
  const s = sim.s;
  let path = findPath(sim, f.fromTile, f.toTile);
  if (!path.length) path = [f.fromTile, f.toTile];
  const km = Math.max(0.2, pathKm(path));
  const trucks = Math.max(1, Math.ceil(f.qty / GOOD_SPECS[f.good].truck - 1e-9));
  const travel = pathSeconds(sim, path) / 60 + 20;
  const now = s.minute;
  let carrier: Business | undefined;
  let truckRef: { freeAt: number } | undefined;
  for (const b of s.businesses) {
    if (b.kind !== 'logistics' || b.status !== 'operating' || !b.trucks || b.downDays > 0) continue;
    let drivers = 0;
    for (const j of b.jobs) if (j.role === 'driver' && j.worker >= 0) drivers++;
    const n = Math.min(b.trucks.length, drivers);
    for (let k = 0; k < n; k++) {
      const t = b.trucks[k];
      if (!truckRef || t.freeAt < truckRef.freeAt) { truckRef = t; carrier = b; }
    }
  }
  let depart: number;
  const external = f.purpose === 'import' || f.purpose === 'export';
  if (truckRef && (!external || truckRef.freeAt < now + MIN_PER_DAY)) depart = Math.max(now + 30, truckRef.freeAt);
  else { carrier = undefined; truckRef = undefined; depart = now + (external ? 60 : 180); }
  depart = workingTime(depart);
  // a local truck shuttles back and forth; an outside haulier sends the whole load in one convoy
  const arrive = truckRef ? depart + (trucks - 1) * 2 * travel + travel : depart + travel + (trucks - 1) * 4;
  if (truckRef) truckRef.freeAt = arrive + travel + 10;

  const nominal = sim.scale * s.ext.trend;
  const labour = FREIGHT_PER_KM * nominal * km * 2 * trucks + FREIGHT_HANDLING * nominal * trucks;
  const litres = 0.32 * km * 2 * trucks;
  const fuelCost = litres * sim.fuelPrice();
  const fee = labour + fuelCost;
  const to: Account = carrier ?? s.ext;
  if (f.gov) sim.spend('capital', to, fee);
  else sim.pay(f.payer, to, fee);
  if (f.payerBiz) f.payerBiz.m.cogs += fee;
  if (carrier) {
    carrier.m.revenue += fee;
    carrier.m.cogs += buyFuel(sim, carrier, litres);
  } else {
    s.stats.acc.fuelLitres += litres;
  }
  if (f.project >= 0) { const p = sim.ix.proj.get(f.project); if (p) p.spent += f.gov ? fee : 0; }
  for (const t of path) s.traffic.truckLoad[t] += trucks * 2;
  const sh: Shipment = {
    id: sim.newId(), good: f.good, qty: f.qty, value: f.value, from: f.from, to: f.to, path, depart, arrive,
    carrier: carrier ? carrier.id : -1, purpose: f.purpose, project: f.project, trucks, leg: travel,
  };
  s.shipments.push(sh);
  sim.ix.ver.shipments++;
  return sh;
}

export function processArrivals(sim: Sim, upto: number): void {
  const list = sim.s.shipments;
  const due: Shipment[] = [];
  for (const sh of list) if (sh.arrive <= upto) due.push(sh);
  if (!due.length) return;
  // unload in arrival order, so the result does not depend on how finely time was stepped
  due.sort((a, b) => a.arrive - b.arrive || a.id - b.id);
  for (const sh of due) {
    if (sh.to >= 0) {
      const b = sim.biz(sh.to);
      if (b) {
        b.inv[sh.good] = (b.inv[sh.good] ?? 0) + sh.qty;
        b.transit[sh.good] = Math.max(0, (b.transit[sh.good] ?? 0) - sh.qty);
      }
    }
    if (sh.project >= 0) {
      const p = sim.ix.proj.get(sh.project);
      if (p) { p.matDelivered += sh.qty; p.matOrdered = Math.max(0, p.matOrdered - sh.qty); }
    }
  }
  sim.s.shipments = list.filter((sh) => sh.arrive > upto);
  sim.ix.ver.shipments++;
}

/** Deliveries currently late: ordered more than two days ago and still not arrived. */
export function backlog(sim: Sim): number {
  let n = 0;
  for (const sh of sim.s.shipments) if (sh.purpose === 'supply' && sh.depart - sim.s.minute > MIN_PER_DAY) n++;
  return n;
}
