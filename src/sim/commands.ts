// Player actions. Every decision goes through here: it is validated, costed, announced as an event (so the news
// and cause chains can refer to it) and applied with a realistic delay. Nothing the player does is instant
// except the announcement itself.

import { dateOf, dayIndex, formatDay } from './calendar';
import { idx, inMap, W, type Sim } from './core';
import { BUILDINGS, BUSINESSES, ROADWORKS, ROLES } from './tables';
import { cancelProject, createProject, estimate, fmtMoney, isRoadwork, localLabourers, minLocalCrew, OUTSIDE_PREMIUM, type Estimate } from './systems/construction';
import { DEPT_LABELS, POLICY_DELAY, POLICY_LABELS, TAX_LABELS } from './systems/government';
import { projectedPassengers } from './systems/aviation';
import { AIRPORT_COFUND, AIRPORT_MIN_DEMAND } from './tables';
import { Terrain, Zone, type BuildingKind, type Dept, type Policies, type ProjectKind, type RoleId, type TaxSettings } from './types';

export type CommandResult = { ok: true; message: string; id?: number } | { ok: false; error: string };

const ok = (message: string, id?: number): CommandResult => ({ ok: true, message, id });
const fail = (error: string): CommandResult => ({ ok: false, error });

// ------------------------------------------------------------------------------------------------ value display

const MONEY_KEYS = new Set(['allowance', 'topThreshold', 'licenseFee', 'minWage', 'unemploymentBenefit', 'pension', 'passengerFee', 'povertyTransfer']);
const LEVELS = ['Light', 'Standard', 'Strict'];
const BUS = ['None', 'Basic', 'Extensive'];
const NAMED: Record<string, string[]> = {
  investmentIncentive: ['None', 'Tax holiday', 'Special economic zone'], tourismPromotion: ['None', 'Regional', 'National', 'International'], festival: ['None', 'Local', 'Grand'],
};

export function describeValue(sim: Sim, key: string, v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (MONEY_KEYS.has(key)) return fmtMoney(sim, v);
  if (key === 'retirementAge') return `${v} years`;
  if (key === 'businessRegulation' || key === 'environmentalRegulation') return LEVELS[v] ?? String(v);
  if (key === 'busService') return BUS[v] ?? String(v);
  if (NAMED[key]) return NAMED[key][v] ?? String(v);
  if (key === 'msp') return v > 0 ? `${Math.round(v * 100)}% of the normal world price` : 'Off';
  if (key === 'property') return `${(v * 100).toFixed(2)}% a year`;
  return `${Math.round(v * 1000) / 10}%`;
}

/** Allowed ranges for each setting (money limits are multiples of the base currency level). */
export function taxRange(sim: Sim, key: keyof TaxSettings): [number, number, number] {
  const n = sim.scale * sim.s.ext.trend;
  switch (key) {
    case 'allowance': return [0, 150_000 * n, 1000 * n];
    case 'topThreshold': return [20_000 * n, 500_000 * n, 5000 * n];
    case 'licenseFee': return [0, 200_000 * n, 5000 * n];
    case 'passengerFee': return [0, 3000 * n, 50 * n];
    case 'tourism': return [0, 0.3, 0.01];
    case 'importFood': return [0, 0.6, 0.01];
    case 'property': return [0, 0.03, 0.0005];
    case 'fuel': return [0, 2, 0.05];
    case 'income': case 'corporate': case 'smallBusiness': return [0, 0.5, 0.01];
    case 'incomeTop': return [0, 0.6, 0.01];
    default: return [0, 0.4, 0.01];
  }
}

export function policyRange(sim: Sim, key: keyof Policies): [number, number, number] {
  const n = sim.scale * sim.s.ext.trend;
  switch (key) {
    case 'minWage': return [0, 60_000 * n, 500 * n];
    case 'unemploymentBenefit': case 'pension': return [0, 30_000 * n, 250 * n];
    case 'retirementAge': return [50, 75, 1];
    case 'fertilizerSubsidy': return [0, 0.8, 0.05];
    case 'msp': return [0, 1.5, 0.05];
    case 'povertyTransfer': return [0, 10_000 * n, 250 * n];
    case 'exportIncentive': return [0, 0.1, 0.005];
    case 'tourismPromotion': return [0, 3, 1];
    case 'businessRegulation': case 'environmentalRegulation': case 'busService': case 'investmentIncentive': case 'festival': return [0, 2, 1];
    default: return [0, 1, 1];
  }
}

// ------------------------------------------------------------------------------------------------ taxes & policies

/** First day of next month: the date tax changes take effect. */
function nextMonthStart(sim: Sim): number {
  const d = sim.date;
  return dayIndex(sim.s.meta.startYear, d.year, d.month + 1, 1);
}

export function announceTax(sim: Sim, key: keyof TaxSettings, value: number): CommandResult {
  if (!(key in TAX_LABELS)) return fail('Unknown tax.');
  const [lo, hi] = taxRange(sim, key);
  if (!Number.isFinite(value) || value < lo || value > hi) return fail(`${TAX_LABELS[key]} must be between ${describeValue(sim, key, lo)} and ${describeValue(sim, key, hi)}.`);
  const g = sim.s.gov;
  const cur = g.taxes[key];
  g.pending = g.pending.filter((p) => !(p.kind === 'tax' && p.key === key));
  if (Math.abs(cur - value) < 1e-9) return ok(`${TAX_LABELS[key]} stays at ${describeValue(sim, key, cur)}; the scheduled change was withdrawn.`);
  const day = nextMonthStart(sim);
  const dir = value > cur ? 'raise' : 'cut';
  const label = `${TAX_LABELS[key]} ${value > cur ? 'rises' : 'falls'} from ${describeValue(sim, key, cur)} to ${describeValue(sim, key, value)}`;
  g.pending.push({ day, kind: 'tax', key, value, label });
  sim.emit('tax.announced', `Government will ${dir} ${TAX_LABELS[key].toLowerCase()} from ${describeValue(sim, key, cur)} to ${describeValue(sim, key, value)} from ${formatDay(sim.s.meta.startYear, day)}.`, 2,
    undefined, undefined, taxEffects(key, value > cur));
  return ok(`Announced. ${label} on ${formatDay(sim.s.meta.startYear, day)}.`);
}

/** Plain-language description of how a tax works through the simulation (not a prediction of numbers). */
export function taxEffects(key: keyof TaxSettings, up: boolean): string[] {
  const more = up ? 'more' : 'less';
  switch (key) {
    case 'income': case 'incomeTop': case 'allowance': case 'topThreshold':
      return [`Take-home pay changes, so households have ${up ? 'less' : 'more'} to spend in local shops, restaurants and services`, 'Satisfaction falls most among residents who favour low taxes'];
    case 'corporate': case 'smallBusiness':
      return [`Firms keep ${up ? 'less' : 'more'} of their profit: dividends to local owners and investors' willingness to open new plants and offices change`];
    case 'sales': case 'foodSales': case 'luxury':
      return [`Shop, restaurant and service prices change, so each household's weekly budget buys ${up ? 'less' : 'more'}`];
    case 'property':
      return ['Owners of homes, shops and plants pay the tax every month', `Landlords and developers earn ${up ? 'less' : 'more'} on each building`];
    case 'fuel':
      return [`Driving, freight, farm pumps and tractors cost ${more}`, 'Freight costs feed into import prices and food prices', `Commuters ${up ? 'drive less' : 'drive more'} over time; bus fares become ${up ? 'relatively cheaper' : 'relatively dearer'}`];
    case 'import':
      return [`Imported consumer goods, components and building materials cost ${more}: shop prices and construction costs follow`, `Local factories face ${up ? 'less' : 'more'} competition from outside`, 'Imports from trade-agreement partners are exempt'];
    case 'importFood':
      return [`Imported grain and food cost ${more}: food prices follow when local farms fall short`, `Local farmers face ${up ? 'less' : 'more'} competition`, 'Agreement partners pay half the rate'];
    case 'tourism':
      return [`Hotel stays cost visitors ${more}`, `Hotels earn ${up ? 'less' : 'more'} per guest after tax; fewer rooms get built when margins are thin`];
    case 'entertainment':
      return [`Cinema and stadium tickets cost ${more}, so families go out ${up ? 'less' : 'more'} for the same budget`];
    case 'passengerFee':
      return [`Every departing passenger pays ${up ? 'more' : 'less'} towards the airport`, 'Collected by the city once the airport operates'];
    case 'export':
      return [`Farmers and plants receive ${up ? 'less' : 'more'} for what they sell outside the city`];
    case 'agriculture':
      return [`Farm families keep ${up ? 'less' : 'more'} of each season's profit`];
    case 'licenseFee':
      return [`Opening a business costs ${more}`];
    default: return [];
  }
}

export function announcePolicy(sim: Sim, key: keyof Policies, value: number | boolean): CommandResult {
  if (!(key in POLICY_LABELS)) return fail('Unknown policy.');
  const g = sim.s.gov;
  const cur = g.policies[key];
  if (typeof cur !== typeof value) return fail('Invalid value.');
  if (typeof value === 'number') {
    const [lo, hi] = policyRange(sim, key);
    if (!Number.isFinite(value) || value < lo || value > hi) return fail(`${POLICY_LABELS[key]} must be between ${describeValue(sim, key, lo)} and ${describeValue(sim, key, hi)}.`);
  }
  g.pending = g.pending.filter((p) => !(p.kind === 'policy' && p.key === key));
  if (cur === value) return ok(`${POLICY_LABELS[key]} stays at ${describeValue(sim, key, cur)}; the scheduled change was withdrawn.`);
  const delay = POLICY_DELAY[key];
  const label = `${POLICY_LABELS[key]}: ${describeValue(sim, key, cur)} → ${describeValue(sim, key, value)}`;
  if (delay === 0) {
    (g.policies as unknown as Record<string, number | boolean>)[key] = value;
    sim.emit('policy.changed', `${label}, effective immediately.`, 2, undefined, undefined, policyEffects(key, value));
    return ok(`${label} is in effect.`);
  }
  const day = sim.day + delay;
  g.pending.push({ day, kind: 'policy', key, value, label });
  sim.emit('policy.announced', `Government announces: ${label}, from ${formatDay(sim.s.meta.startYear, day)}.`, 2, undefined, undefined,
    [`Takes ${delay} days: ${delay >= 60 ? 'legislation and procurement' : 'notice period for employers and landlords'}`, ...policyEffects(key, value)]);
  return ok(`Announced. ${label} from ${formatDay(sim.s.meta.startYear, day)}.`);
}

export function policyEffects(key: keyof Policies, v: number | boolean): string[] {
  switch (key) {
    case 'minWage': return ['Low-paid jobs pay more; employers with thin margins hire less or cut staff', 'Unemployed residents hold out for better offers'];
    case 'unemploymentBenefit': return ['Paid monthly to residents out of work for more than two weeks', 'Supports spending in shops; slightly raises what the unemployed will accept'];
    case 'pension': return ['Paid monthly to every retired resident'];
    case 'retirementAge': return ['Workers retire later or earlier: labour supply and pension costs change'];
    case 'fertilizerSubsidy': return ['The government pays this share of every fertilizer bill', 'Better-fed crops yield more; the subsidy bill grows with the area sown'];
    case 'cropInsurance': return [v ? 'Farmers pay a 2% premium; the government covers drought, flood, heatwave and disease losses beyond 20%' : 'Farmers carry the full risk of bad seasons'];
    case 'businessRegulation': return ['Registration and licensing take longer under stricter rules', 'Stricter safety rules make industrial accidents less likely'];
    case 'environmentalRegulation': return ['Plants pay for pollution controls; emissions fall as enforcement is funded', 'Large projects need longer environmental assessments'];
    case 'rentControl': return [v ? 'Rents on existing tenancies can rise at most 0.4% a month' : 'Rents follow the market again', v ? 'Developers demand a higher return before building' : ''].filter(Boolean);
    case 'busService': return ['Buses carry commuters without cars; fares are collected by the government', 'The transport department needs more funding for the service'];
    case 'grainExportBan': return [v ? 'Farmers cannot sell grain outside the city: local grain prices fall, food gets cheaper, farm incomes drop' : 'Farmers can export grain again'];
    case 'msp': return v ? ['The government buys any wheat and rice offered at this price', 'Farm incomes rise and farmers plant more of both; the bill grows with every good harvest', 'Surplus stock is stored and eventually sold abroad at a loss'] : ['Farmers sell at market prices again'];
    case 'rationShops': return v ? ['Poor families receive 5 kg of grain per person a month through local grocers', 'Grain comes from government stocks, or is bought when stocks run out', 'Fewer families go hungry; grocers earn a handling fee'] : ['Rations stop: poor families buy all their grain'];
    case 'povertyTransfer': return ['Paid every month to families whose income per person is below the poverty line', 'Most of it is spent in local shops'];
    case 'exportIncentive': return ['Exporters get this share of their export sales refunded', 'Raises what farms, plants and tech firms earn abroad; the refund is a cost to the city'];
    case 'investmentIncentive': return v === 2 ? ['New plants, offices and hotels pay no profit tax for three years', 'Factories import components duty-free', 'Lost tax revenue, more investment'] : v === 1 ? ['New plants, offices and hotels pay no profit tax for three years', 'Lost tax revenue, more investment'] : ['New firms pay tax from the start'];
    case 'tourismPromotion': return ['Campaigns raise awareness of the city slowly, over many months', 'International campaigns reach foreign travellers, who stay longer and spend more', 'Paid monthly from the promotion budget'];
    case 'festival': return ['Once a year the city stages its festival: residents celebrate and visitors pour in', 'Stages, decoration and catering are hired from local firms'];
    default: return [];
  }
}

export function setFunding(sim: Sim, dept: Dept, level: number): CommandResult {
  if (!(dept in DEPT_LABELS)) return fail('Unknown department.');
  if (!Number.isFinite(level) || level < 0.3 || level > 1.5) return fail('Funding must be between 30% and 150% of full-service cost.');
  const g = sim.s.gov;
  const before = g.level[dept];
  g.level[dept] = Math.round(level * 100) / 100;
  if (Math.abs(before - level) >= 0.05) {
    sim.emit('budget.changed', `${DEPT_LABELS[dept]} funding set to ${Math.round(level * 100)}% of full-service cost (was ${Math.round(before * 100)}%).`, level < before - 0.1 ? 2 : 1,
      undefined, undefined, [level < 0.9 ? 'Below 90%, the department lays off staff and services decline' : level > 1 ? 'Extra funding buys more operations (repairs, outreach, enforcement)' : 'Full service']);
  }
  return ok(`${DEPT_LABELS[dept]}: ${Math.round(level * 100)}% from next month's allocation.`);
}

// ------------------------------------------------------------------------------------------------ development

export const GOV_BUILDINGS: BuildingKind[] = ['school', 'clinic', 'hospital', 'police', 'college', 'affordable', 'park', 'museum', 'stadium', 'airport', 'townhall'];
export type RoadTool = 'road' | 'avenue' | 'upgrade' | 'canal';

export interface Preview {
  ok: boolean;
  errors: string[];
  warnings: string[];
  kind: ProjectKind;
  label: string;
  tiles: number[];
  x: number; y: number; w: number; h: number;
  floors: number;
  est: Estimate | null;
  monthly: number; // running cost at full service
  requirements: string[];
  benefits: string[];
  risks: string[];
}

function staffNeed(sim: Sim, kind: BuildingKind): { role: RoleId; n: number; avail: number }[] {
  const biz = BUILDINGS[kind].biz;
  if (!biz || !BUSINESSES[biz].pub) return [];
  return BUSINESSES[biz].jobs.map(([role, n]) => {
    const spec = ROLES[role];
    let avail = 0;
    for (const c of sim.s.citizens) if (c.status === 'unemployed' && c.edu >= spec.edu && (!spec.fields || spec.fields.includes(c.field))) avail++;
    return { role, n, avail };
  });
}

function tileProblem(sim: Sim, t: number, road: boolean, bridge: boolean): string | null {
  const m = sim.s.map;
  const tt = m.terrain[t];
  if (m.project[t] >= 0) return 'Already reserved for another project';
  if (tt === Terrain.Water && !bridge) return road ? 'Streets cannot cross the river; build an avenue to bridge it' : 'Cannot build on water';
  if (tt === Terrain.Canal && !road) return 'Cannot build on a canal';
  if (!road && m.road[t] > 0) return 'Cannot build on a road';
  const o = m.owner[t];
  if (o >= 0) {
    const b = sim.bld(o);
    if (b && b.ownerT === 0) return `Occupied by ${b.name || BUILDINGS[b.kind].label}`;
  }
  return null;
}

const OUTSIDE_NOTE = `No local construction company has a crew yet: an outside contractor will build this, charging about ${Math.round((OUTSIDE_PREMIUM - 1) * 100)}% more for labour than estimated and taking on local people as day labourers.`;

function contractorLoad(sim: Sim): { workers: number; active: number } {
  let active = 0;
  const workers = localLabourers(sim);
  for (const p of sim.s.projects) if (p.phase === 'construction' || p.phase === 'planning' || p.phase === 'approval' || p.phase === 'land' || p.phase === 'assessment' || p.phase === 'funding') active++;
  return { workers, active };
}

function wetMonths(sim: Sim, days: number): number {
  const rain = sim.preset.climate.rain;
  let wet = 0;
  const months = Math.min(24, Math.ceil(days / 30.4));
  for (let k = 0; k < months; k++) if (rain[(sim.date.month + k) % 12] > 120) wet++;
  return wet;
}

/** Share of the cost a national scheme would pay for this facility here and now (airports only). */
export function cofundShare(sim: Sim, kind: BuildingKind): number {
  return kind === 'airport' && projectedPassengers(sim) >= AIRPORT_MIN_DEMAND ? AIRPORT_COFUND : 0;
}

export function previewBuilding(sim: Sim, kind: BuildingKind, x: number, y: number, floors?: number, rot = false): Preview {
  const spec = BUILDINGS[kind];
  const w = rot ? spec.h : spec.w, h = rot ? spec.w : spec.h;
  const errors: string[] = [], warnings: string[] = [], requirements: string[] = [], benefits: string[] = [], risks: string[] = [];
  const tiles: number[] = [];
  const f = Math.max(spec.floors[0], Math.min(spec.floors[1], floors ?? spec.floors[0]));
  const base: Preview = { ok: false, errors, warnings, kind, label: spec.label, tiles, x, y, w, h, floors: f, est: null, monthly: 0, requirements, benefits, risks };
  if (!GOV_BUILDINGS.includes(kind)) { errors.push('The government only builds public facilities; private buildings follow zoning and demand.'); return base; }
  if (!inMap(x, y) || !inMap(x + w - 1, y + h - 1)) { errors.push('Outside the region.'); return base; }
  const m = sim.s.map;
  let access = false;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const t = idx(xx, yy);
    tiles.push(t);
    // an airport may close local streets that cross its site, but not avenues or the highway
    const street = kind === 'airport' && m.road[t] === 1;
    const p = kind === 'airport' && m.road[t] >= 2 ? 'Cannot close an avenue or the highway' : tileProblem(sim, t, street, false);
    if (p && !errors.includes(p)) errors.push(p);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = xx + dx, ny = yy + dy;
      if (inMap(nx, ny) && m.road[idx(nx, ny)] > 0) access = true;
    }
  }
  if (!access) errors.push('Needs road access: place it next to a street.');
  if (kind === 'townhall' && sim.s.businesses.some((b) => b.kind === 'townhall')) errors.push('The city already has a town hall.');
  const est = estimate(sim, kind, tiles, f, true);
  base.est = est;
  const n = sim.scale * sim.s.ext.trend;
  const staff = staffNeed(sim, kind);
  base.monthly = staff.reduce((a, s) => a + sim.roleWage(s.role) * s.n * 1.2, 0) + (kind === 'park' ? 10_000 * n : 0) + est.cost * BUILDINGS[kind].maintenance * 0.2;
  // requirements
  requirements.push(`Budget: ${fmtMoney(sim, est.cost)}${est.equipment > 0 ? ` including ${fmtMoney(sim, est.equipment)} of equipment` : ''}`);
  if (est.landCost > 0) requirements.push(`Land: ${fmtMoney(sim, est.landCost)} to acquire${est.farmsAffected ? ` fields from ${est.farmsAffected} farm${est.farmsAffected > 1 ? 's' : ''}` : ''}${est.displaced ? `, relocating ${est.displaced} household${est.displaced > 1 ? 's' : ''}` : ''}`);
  const cl = contractorLoad(sim);
  const outside = cl.workers < minLocalCrew(sim);
  requirements.push(`Construction: ${Math.round(est.labor)} worker-days and ${Math.round(est.materials)} t of materials (crews of up to ${est.crew}; local contractors employ ${cl.workers} labourers)`);
  if (outside) warnings.push(OUTSIDE_NOTE);
  for (const s of staff) if (ROLES[s.role].edu >= 3) requirements.push(`Staff: ${s.n} ${ROLES[s.role].label.toLowerCase()}${s.n > 1 ? 's' : ''} (${s.avail} qualified people are looking for work)`);
  // benefits
  const served = BUILDINGS[kind].biz ? BUSINESSES[BUILDINGS[kind].biz as keyof typeof BUSINESSES].serves : undefined;
  const jobs = staff.reduce((a, s) => a + s.n, 0);
  switch (kind) {
    case 'school': benefits.push(`Places for about ${served} pupils; better schooling raises the skills of future workers`); break;
    case 'college': benefits.push(`About ${served} students a year; graduates become engineers, analysts, nurses and technicians after 3–4 years`); break;
    case 'clinic': benefits.push(`Primary care for about ${served?.toLocaleString()} residents nearby`, 'Healthier residents work more and live longer'); break;
    case 'hospital': benefits.push(`Hospital care for about ${served?.toLocaleString()} residents across the region`, 'Lower infant mortality and longer lives'); break;
    case 'police': benefits.push(`Policing for about ${served?.toLocaleString()} residents; crime falls where coverage is good`); break;
    case 'affordable': benefits.push(`${est.floors * BUILDINGS.affordable.unitsPerFloor} low-rent homes owned by the city; rents flow to the treasury`); break;
    case 'park': benefits.push('Green space absorbs some pollution and raises nearby land values'); break;
    case 'townhall': benefits.push('Administrative capacity: faster approvals and better tax collection'); break;
    case 'museum': benefits.push(`Up to ${served?.toLocaleString()} visitors a day: residents gain somewhere to go, and the city becomes more attractive to tourists`, 'Ticket income goes to the city'); break;
    case 'stadium': benefits.push(`Matches and concerts for up to ${served?.toLocaleString()} spectators, several times a month`, 'Fans come from across the region; ticket income goes to the city'); break;
    case 'airport': {
      const pax = projectedPassengers(sim);
      benefits.push('Airlines open routes once it operates: visitors who cannot come by road fly in, foreign visitors above all',
        'Perishable produce flies to distant markets; tech firms reach clients more easily', `About ${pax.toLocaleString('en-US')} passengers a month expected at today's demand`);
      const share = cofundShare(sim, kind);
      if (share > 0) benefits.push(`The national regional-airport scheme pays ${Math.round(share * 100)}% of construction (not land)`);
      else warnings.push(`The national scheme co-funds airports only above ${AIRPORT_MIN_DEMAND.toLocaleString('en-US')} expected passengers a month; the city would pay the full cost`);
      risks.push('Aircraft noise lowers the quality of life of anyone living close to the runway', 'Local streets across the site will be closed');
      break;
    }
  }
  if (jobs) benefits.push(`${jobs} public jobs once staffed`);
  benefits.push(outside ? 'Day labour on the site for local residents' : `Construction work for local contractors (${fmtMoney(sim, (est.labor / 0.9) * (sim.roleWage('laborer') / 26) * 1.35)} in wages)`);
  // risks
  const wet = wetMonths(sim, est.construction);
  if (wet) risks.push(`${wet} rainy-season month${wet > 1 ? 's' : ''} during construction: heavy rain stops work on site`);
  if (cl.active >= 3) risks.push(`${cl.active} other projects are competing for contractors`);
  for (const s of staff) if (ROLES[s.role].edu >= 3 && s.avail < s.n * 0.5) risks.push(`Staff shortage: only ${s.avail} of ${s.n} ${ROLES[s.role].label.toLowerCase()}s can be found locally; it may open below capacity`);
  if (est.cost > 50_000_000 * n) risks.push('Large contracts attract inflated invoices unless the administration is well funded');
  risks.push('Material prices and delays can push costs above the estimate');
  if (est.displaced > 0) risks.push(`${est.displaced} relocated household${est.displaced > 1 ? 's' : ''} will be unhappy`);
  const g = sim.s.gov;
  if (g.cash < est.cost * 0.1) warnings.push('The treasury is low: the project will wait for funds after approval, or be financed by borrowing.');
  if (base.monthly > 0) warnings.push(`Running cost at full service: about ${fmtMoney(sim, base.monthly)} a month (added to the ${deptOf(kind)} budget).`);
  base.ok = errors.length === 0;
  return base;
}

function deptOf(kind: BuildingKind): string {
  const biz = BUILDINGS[kind].biz;
  const d = biz ? BUSINESSES[biz as keyof typeof BUSINESSES].dept : kind === 'park' ? 'environment' : undefined;
  return d ? DEPT_LABELS[d].toLowerCase() : 'city';
}

export function proposeBuilding(sim: Sim, kind: BuildingKind, x: number, y: number, floors?: number, rot = false): CommandResult {
  const pv = previewBuilding(sim, kind, x, y, floors, rot);
  if (!pv.ok) return fail(pv.errors.join(' '));
  const name = kind === 'affordable' ? `Public housing (${pv.floors} floors)` : BUILDINGS[kind].label;
  const p = createProject(sim, { kind, x, y, w: pv.w, h: pv.h, floors: pv.floors, gov: true, sponsor: -1, name, reason: 'Commissioned by the government', cofund: cofundShare(sim, kind) });
  return ok(`${name} proposed: planning starts now. Expected completion in about ${Math.round(pv.est!.days / 30.4)} months.`, p.id);
}

/** Tiles of an L-shaped route from a to b (horizontal first). */
export function routeTiles(ax: number, ay: number, bx: number, by: number): number[] {
  const out: number[] = [];
  const sx = Math.sign(bx - ax) || 1, sy = Math.sign(by - ay) || 1;
  for (let x = ax; x !== bx + sx; x += sx) out.push(idx(x, ay));
  for (let y = ay + sy; y !== by + sy; y += sy) if (y !== ay) out.push(idx(bx, y));
  return [...new Set(out.filter((t) => t >= 0 && t < W * W))];
}

export function previewRoad(sim: Sim, tool: RoadTool, route: number[]): Preview {
  const m = sim.s.map;
  const errors: string[] = [], warnings: string[] = [], requirements: string[] = [], benefits: string[] = [], risks: string[] = [];
  const label = ROADWORKS[tool].label;
  const tiles: number[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const t of route) {
    const cls = m.road[t];
    if (tool === 'upgrade') { if (cls === 1 && m.project[t] < 0) tiles.push(t); else skip(cls >= 2 ? 'already wide' : 'not a street'); continue; }
    if (tool === 'canal') {
      if (cls > 0) { skip('roads'); continue; }
      const p = tileProblem(sim, t, false, false);
      if (p || m.terrain[t] === Terrain.Canal) { skip(p ?? 'already a canal'); continue; }
      tiles.push(t);
      continue;
    }
    const want = tool === 'road' ? 1 : 2;
    if (cls >= want) { skip('already a road'); continue; }
    const p = tileProblem(sim, t, true, tool === 'avenue');
    if (p) { errors.push(p); break; }
    tiles.push(t);
  }
  const x = tiles.length ? Math.min(...tiles.map((t) => t % W)) : 0, y = tiles.length ? Math.min(...tiles.map((t) => (t / W) | 0)) : 0;
  const base: Preview = { ok: false, errors, warnings, kind: tool, label, tiles, x, y, w: 1, h: 1, floors: 1, est: null, monthly: 0, requirements, benefits, risks };
  if (!tiles.length) { if (!errors.length) errors.push('Nothing to build along this route.'); return base; }
  if (tool !== 'canal' && tool !== 'upgrade') {
    const connects = tiles.some((t) => {
      const tx0 = t % W, ty0 = (t / W) | 0;
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inMap(tx0 + dx, ty0 + dy) && m.road[idx(tx0 + dx, ty0 + dy)] > 0 && !tiles.includes(idx(tx0 + dx, ty0 + dy)));
    });
    if (!connects) errors.push('The new road must connect to the existing network.');
  }
  const est = estimate(sim, tool, tiles, 1, true);
  base.est = est;
  const n = sim.scale * sim.s.ext.trend;
  base.monthly = tool === 'canal' ? tiles.length * 800 * n : tiles.length * [0, 120, 600, 1500][tool === 'road' ? 1 : 2] * 1.3 * n;
  requirements.push(`Budget: ${fmtMoney(sim, est.cost)}`);
  if (est.landCost > 0) requirements.push(`Land: ${fmtMoney(sim, est.landCost)} to acquire (${est.farmsAffected} farm${est.farmsAffected === 1 ? '' : 's'}${est.displaced ? `, ${est.displaced} households relocated` : ''})`);
  requirements.push(`Construction: ${Math.round(est.labor)} worker-days, ${Math.round(est.materials)} t of materials`);
  if (localLabourers(sim) < minLocalCrew(sim)) warnings.push(OUTSIDE_NOTE);
  const spans = tiles.filter((t) => m.terrain[t] === Terrain.Water).length;
  if (spans) requirements.push(`${spans} bridge span${spans > 1 ? 's' : ''} over the river`);
  const km = (tiles.length * 40) / 1000;
  switch (tool) {
    case 'road': benefits.push(`${km.toFixed(2)} km of street (about 600 vehicles an hour)`, 'Opens road frontage for homes, shops and businesses where the land is zoned'); break;
    case 'avenue': benefits.push(`${km.toFixed(2)} km of avenue (about 1,600 vehicles an hour at 50 km/h)`); break;
    case 'upgrade': benefits.push(`Widens ${km.toFixed(2)} km of street to avenue capacity: less congestion, faster deliveries`); break;
    case 'canal': {
      let farms = 0;
      for (const b of sim.s.businesses) {
        if (!b.farm || b.farm.irrigation >= 0.9) continue;
        if (b.farm.fields.some((f) => tiles.some((t) => Math.abs((t % W) - (f % W)) <= 4 && Math.abs(((t / W) | 0) - ((f / W) | 0)) <= 4))) farms++;
      }
      benefits.push(`Irrigation for ${farms} farm${farms === 1 ? '' : 's'} within 160 m: a second crop in the dry season and protection against drought`);
      risks.push('Farms next to canals are more exposed to flooding; fertilizer run-off reaches the water');
      break;
    }
  }
  if (tool === 'upgrade') risks.push('Traffic is disrupted while the street is rebuilt');
  const wet = wetMonths(sim, est.construction);
  if (wet) risks.push('Heavy rain stops work on site');
  if (Object.keys(skipped).length) warnings.push(`Skipped ${Object.entries(skipped).map(([k, v]) => `${v} tile${v > 1 ? 's' : ''} (${k})`).join(', ')}.`);
  warnings.push(`Upkeep about ${fmtMoney(sim, base.monthly)} a month (${tool === 'canal' ? 'agriculture' : 'transport'} budget).`);
  base.ok = errors.length === 0;
  return base;
}

export function proposeRoad(sim: Sim, tool: RoadTool, route: number[]): CommandResult {
  const pv = previewRoad(sim, tool, route);
  if (!pv.ok) return fail(pv.errors.join(' '));
  const name = `${pv.label} (${(pv.tiles.length * 40).toLocaleString()} m)`;
  const p = createProject(sim, { kind: tool, x: pv.x, y: pv.y, w: 1, h: 1, tiles: pv.tiles, gov: true, sponsor: -1, name, reason: 'Commissioned by the government' });
  return ok(`${name} proposed. Expected completion in about ${Math.max(1, Math.round(pv.est!.days / 30.4))} months.`, p.id);
}

export function cancel(sim: Sim, projectId: number): CommandResult {
  const p = sim.ix.proj.get(projectId);
  if (!p) return fail('No such project.');
  if (!p.gov) return fail('Only government projects can be cancelled.');
  if (p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'staffing') return fail('This project can no longer be cancelled.');
  cancelProject(sim, p);
  return ok(`${p.name} cancelled after spending ${fmtMoney(sim, p.spent)}.`);
}

// ------------------------------------------------------------------------------------------------ zoning

export const ZONE_LABELS: Record<number, string> = {
  [Zone.None]: 'Unzoned', [Zone.Residential]: 'Residential', [Zone.Commercial]: 'Commercial', [Zone.Industrial]: 'Industrial', [Zone.Agricultural]: 'Agricultural', [Zone.Park]: 'Park',
};

export function zoneable(sim: Sim, t: number): boolean {
  const m = sim.s.map;
  const tt = m.terrain[t];
  return m.road[t] === 0 && tt !== Terrain.Water && tt !== Terrain.Canal && m.owner[t] < 0 && m.project[t] < 0 && m.zone[t] !== Zone.Park;
}

export function rezone(sim: Sim, tiles: number[], zone: number): CommandResult {
  if (![Zone.Residential, Zone.Commercial, Zone.Industrial, Zone.Agricultural].includes(zone as 1)) return fail('Choose residential, commercial, industrial or agricultural.');
  const m = sim.s.map;
  let changed = 0, farmed = 0, forest = 0;
  for (const t of tiles) {
    if (!zoneable(sim, t) || m.zone[t] === zone) continue;
    m.zone[t] = zone;
    changed++;
    if (m.farm[t] >= 0) farmed++;
    if (m.terrain[t] === Terrain.Forest) forest++;
  }
  if (!changed) return fail('None of these tiles can be rezoned (roads, water, buildings and project sites are excluded).');
  sim.ix.ver.zones++;
  const ha = (changed * 0.16).toFixed(1);
  const why: string[] = [];
  if (zone !== Zone.Agricultural) {
    why.push('Developers and businesses can now build here if the land has road access and demand is there');
    if (farmed) why.push(`${farmed} tiles are still farmed; farmers will sell when a developer offers to buy`);
    if (forest) why.push(`${forest} tiles are woodland that would be cleared`);
  }
  sim.emit('zoning.changed', `${ha} ha rezoned as ${ZONE_LABELS[zone].toLowerCase()}.`, 1, { k: 'tile', id: tiles[0] }, undefined, why);
  return ok(`${ha} ha rezoned as ${ZONE_LABELS[zone].toLowerCase()}.`);
}

/** Rectangle of tiles between two corners. */
export function rectTiles(ax: number, ay: number, bx: number, by: number): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, Math.min(ay, by)); y <= Math.min(W - 1, Math.max(ay, by)); y++)
    for (let x = Math.max(0, Math.min(ax, bx)); x <= Math.min(W - 1, Math.max(ax, bx)); x++) out.push(idx(x, y));
  return out;
}

export function isRoadTool(k: ProjectKind): k is RoadTool { return isRoadwork(k); }

export function pendingSummary(sim: Sim): { label: string; date: string }[] {
  return sim.s.gov.pending.map((p) => ({ label: p.label, date: formatDay(sim.s.meta.startYear, p.day) }));
}

export function monthLabel(sim: Sim): string {
  const d = dateOf(sim.s.meta.startYear, sim.day);
  return `${d.year}-${String(d.month + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------------ trade diplomacy

/** Opens negotiations for a trade agreement. Talks take 9–17 months and may fail. */
export function openTalks(sim: Sim, partnerId: string): CommandResult {
  const tr = sim.s.trade;
  const p = tr.partners.find((x) => x.id === partnerId);
  if (!p) return fail('Unknown trading partner.');
  if (p.status !== 'none') return fail(p.status === 'talks' ? `Talks with ${p.name} are already under way.` : `An agreement with ${p.name} is already in force.`);
  if (sim.day - tr.lastTalks < 365) return fail(`Talks collapsed on ${formatDay(sim.s.meta.startYear, tr.lastTalks)}; partners will not reopen them for a year.`);
  p.status = 'talks';
  p.statusDay = sim.day;
  p.due = sim.day + 270 + sim.rng.int(240);
  sim.emit('trade.talks', `Trade talks with ${p.name} begin.`, 2, undefined, undefined, [
    `Negotiators expect to finish around ${formatDay(sim.s.meta.startYear, p.due)}`,
    'An agreement would remove tariffs on manufactures both ways and halve those on farm goods',
  ]);
  return ok(`Talks with ${p.name} have begun; expect a result around ${formatDay(sim.s.meta.startYear, p.due)}.`);
}

/** Gives notice to leave an agreement (takes effect after six months) or breaks off talks. */
export function leaveAgreement(sim: Sim, partnerId: string): CommandResult {
  const p = sim.s.trade.partners.find((x) => x.id === partnerId);
  if (!p) return fail('Unknown trading partner.');
  if (p.status === 'talks') {
    p.status = 'none';
    p.statusDay = sim.day;
    sim.emit('trade.talksEnded', `The government breaks off trade talks with ${p.name}.`, 2);
    return ok(`Talks with ${p.name} ended.`);
  }
  if (p.status !== 'agreement') return fail(`There is no agreement with ${p.name} to leave.`);
  p.status = 'leaving';
  p.statusDay = sim.day;
  p.due = sim.day + 182;
  sim.emit('trade.leaving', `The government gives notice to leave the trade agreement with ${p.name}.`, 3, undefined, undefined,
    [`Tariffs return on ${formatDay(sim.s.meta.startYear, p.due)}`, 'Local producers get protection back; exporters and importers lose their tariff-free access']);
  return ok(`Notice given: the agreement with ${p.name} ends on ${formatDay(sim.s.meta.startYear, p.due)}.`);
}
