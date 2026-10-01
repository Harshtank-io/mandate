// Unexpected events that act through the simulated systems: crop disease, industrial accidents, epidemics,
// procurement scandals. Probabilities respond to policy (regulation, funding) and conditions (weather).

import type { Sim } from '../core';
import { CROPS } from '../tables';
import type { CropId } from '../types';
import { fmtMoney } from './construction';

const DISEASE: Record<CropId, string> = { wheat: 'Wheat rust', rice: 'Rice blast', maize: 'Fall armyworm', vegetables: 'Leaf blight', cotton: 'Pink bollworm' };

export function shocksMonthly(sim: Sim): void {
  const s = sim.s, r = sim.rng;
  const w = s.weather;
  const agri = Math.min(1, s.gov.deptFunding.agriculture);
  // crop disease spreads among neighbouring farms growing the same crop
  const growing = new Map<CropId, number>();
  for (const b of s.businesses) if (b.farm && b.farm.phase === 'growing' && b.farm.crop) growing.set(b.farm.crop, (growing.get(b.farm.crop) ?? 0) + 1);
  const wet = w.rainLog.slice(-30).reduce((a, x) => a + x, 0) > w.normalLog.slice(-30).reduce((a, x) => a + x, 0) * 1.2;
  for (const [crop, n] of growing) {
    if (n < 4 || !r.chance(0.03 * (wet ? 1.8 : 1))) continue;
    const farms = s.businesses.filter((b) => b.farm && b.farm.phase === 'growing' && b.farm.crop === crop);
    const seed = r.pick(farms);
    const sb = sim.bld(seed.building)!;
    let hit = 0;
    for (const f of farms) {
      const bl = sim.bld(f.building);
      if (!bl || sim.dist(bl, sb) > 30 || !r.chance(0.7)) continue;
      f.farm!.disease = Math.round((20 + r.int(25)) * (1.3 - 0.5 * agri));
      hit++;
    }
    if (hit) sim.emit('farm.disease', `${DISEASE[crop]} outbreak hits ${hit} ${CROPS[crop].label.toLowerCase()} farms.`, hit >= 8 ? 3 : 2, { k: 'building', id: sb.id }, undefined,
      [wet ? 'Unusually wet, humid weather favours the disease' : 'The disease spread from a neighbouring district',
        agri < 0.8 ? 'Underfunded agricultural extension services are slow to respond' : 'Extension officers are helping farmers treat fields']);
  }
  // industrial accidents are more likely under light regulation
  const regF = [2, 1, 0.5][s.gov.policies.businessRegulation];
  for (const b of s.businesses) {
    if (!['factory', 'materials', 'foodplant'].includes(b.kind) || b.status !== 'operating') continue;
    if (!r.chance(0.004 * regF)) continue;
    b.downDays = 7 + r.int(20);
    const staff = b.jobs.filter((j) => j.worker >= 0);
    const injured = Math.min(staff.length, 1 + r.int(5));
    for (let k = 0; k < injured; k++) {
      const c = sim.cit(r.pick(staff).worker);
      if (c) { c.injured = 20 + r.int(40); c.health = Math.max(0.1, c.health - 0.25); }
    }
    sim.emit('business.accident', `Accident at ${b.name}: ${injured} workers injured; production halted for ${b.downDays} days.`, 2, { k: 'building', id: b.building }, undefined,
      [s.gov.policies.businessRegulation === 0 ? 'Light-touch safety regulation makes accidents more likely' : 'Investigators are examining the plant']);
  }
  // epidemics are rare; healthcare coverage determines how hard they hit
  if (w.pandemic === 0 && r.chance(0.0012)) {
    w.pandemic = 90 + r.int(90);
    sim.emit('health.pandemic', 'An infectious disease epidemic has reached the city.', 3, undefined, undefined,
      ['Restaurants lose half their customers', 'Absences cut output at workplaces', `Healthcare coverage is ${Math.round(s.services.health * 100)}%`]);
  }
  // procurement scandals on large public works
  const admin = Math.min(1, s.gov.deptFunding.admin);
  for (const p of s.projects) {
    if (!p.gov || p.phase !== 'construction' || p.cost < 50_000_000 * sim.scale * s.ext.trend) continue;
    if (!r.chance(0.01 * [1.6, 1, 0.6][s.gov.policies.businessRegulation] * (1.4 - 0.4 * admin))) continue;
    const extra = p.cost * 0.08;
    p.cost += extra;
    p.issues['Audit into inflated invoices'] = (p.issues['Audit into inflated invoices'] ?? 0) + 20;
    p.delayDays += 20;
    sim.emit('project.audit', `Audit finds inflated invoices on ${p.name}; costs rise by ${fmtMoney(sim, extra)}.`, 2, { k: 'project', id: p.id }, undefined,
      [admin < 0.9 ? 'An understaffed administration struggles to oversee contracts' : 'Auditors caught the overbilling early']);
  }
}
