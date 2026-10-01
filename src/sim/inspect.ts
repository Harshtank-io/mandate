// Read-only views of the simulation for the inspector and dashboard. Every figure is read from the simulated
// entities; explanations point at the causes the systems recorded.

import { formatDay, spanText } from './calendar';
import { hhIncome } from './econ';
import { idx, sumExp, sumRev, W, type Sim } from './core';
import { BUILDINGS, BUSINESSES, CROPS, EDU_LABEL, FIELD_LABEL, GOOD_SPECS, ROAD_CAPACITY, ROAD_SPEED, ROLES, cropTempFactor } from './tables';
import { fmtMoney, isRoadwork } from './systems/construction';
import { DEPT_LABELS } from './systems/government';
import { envAt } from './systems/environment';
import { cellOf, SAT_WEIGHTS, satisfactionParts, type SatParts } from './systems/services';
import { ZONE_LABELS } from './commands';
import { GOODS, Mode, Terrain, type Building, type Business, type Citizen, type Household, type Project, type RevCat, type ExpCat, type SimEvent } from './types';

export type Ref = NonNullable<SimEvent['ref']>;
export interface Link { label: string; ref: Ref }
export interface Section { title: string; rows?: [string, string][]; lines?: string[]; links?: Link[]; bar?: { label: string; value: number; tone?: 'good' | 'bad' }[] }
export interface Card {
  ref: Ref;
  title: string;
  subtitle: string;
  rows: [string, string][];
  sections: Section[];
  focus: [number, number]; // tile coordinates for the camera
}

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => Math.round(v).toLocaleString('en-US');
const MODE_LABEL: Record<number, string> = { [Mode.None]: 'Works from home', [Mode.Walk]: 'Walks', [Mode.TwoWheeler]: 'Two-wheeler', [Mode.Car]: 'Car', [Mode.Bus]: 'Bus' };
const STATUS_LABEL: Record<string, string> = { child: 'Child', student: 'Student', working: 'Employed', unemployed: 'Looking for work', retired: 'Retired', owner: 'Runs a business', inactive: 'Not in the labour force' };
const PHASE_LABEL: Record<string, string> = {
  planning: 'Planning', assessment: 'Environmental assessment', approval: 'Awaiting approval', land: 'Land acquisition', funding: 'Awaiting funding',
  construction: 'Under construction', staffing: 'Hiring staff', done: 'Completed', cancelled: 'Cancelled',
};

export function money(sim: Sim, v: number): string { return fmtMoney(sim, v); }

function ownerLabel(sim: Sim, b: Building): string {
  switch (b.ownerT) {
    case 0: return 'City government';
    case 1: { const h = sim.hh(b.ownerId); const c = h ? sim.cit(h.members[0]) : undefined; return c ? `${sim.fullName(c)} (household)` : 'A local family'; }
    case 2: return sim.biz(b.ownerId)?.name ?? 'A local company';
    default: return 'Outside investors';
  }
}

function bizLink(b: Business): Link { return { label: b.name, ref: { k: 'business', id: b.id } }; }
function citLink(sim: Sim, c: Citizen): Link { return { label: sim.fullName(c), ref: { k: 'citizen', id: c.id } }; }

// ------------------------------------------------------------------------------------------------ tiles

export function refAtTile(sim: Sim, t: number): Ref {
  const m = sim.s.map;
  if (m.project[t] >= 0 && sim.ix.proj.has(m.project[t])) return { k: 'project', id: m.project[t] };
  if (m.owner[t] >= 0 && sim.bld(m.owner[t])) return { k: 'building', id: m.owner[t] };
  if (m.farm[t] >= 0 && sim.biz(m.farm[t])) return { k: 'business', id: m.farm[t] };
  return { k: 'tile', id: t };
}

export function inspect(sim: Sim, ref: Ref): Card | null {
  switch (ref.k) {
    case 'building': { const b = sim.bld(ref.id); return b ? inspectBuilding(sim, b) : null; }
    case 'business': { const b = sim.biz(ref.id); return b ? inspectBusiness(sim, b) : null; }
    case 'citizen': { const c = sim.cit(ref.id); return c ? inspectCitizen(sim, c) : null; }
    case 'household': { const h = sim.hh(ref.id); return h ? inspectHousehold(sim, h) : null; }
    case 'project': { const p = sim.ix.proj.get(ref.id); return p ? inspectProject(sim, p) : null; }
    case 'tile': return inspectTile(sim, ref.id);
  }
}

export function inspectTile(sim: Sim, t: number): Card {
  const m = sim.s.map;
  const x = t % W, y = (t / W) | 0;
  if (m.road[t] > 0) return inspectRoad(sim, t);
  const terr = ['Open land', 'Woodland', 'River', 'Farmland', 'Irrigation canal'][m.terrain[t]] ?? 'Land';
  const rows: [string, string][] = [
    ['Zoning', ZONE_LABELS[m.zone[t]] ?? '—'],
    ['Soil fertility', pct(m.fertility[t])],
    ['Land value', `${Math.round(m.landValue[t] * 100)} (index)`],
    ['Air pollution', pollutionLabel(envAt(sim, x, y))],
  ];
  const k = cellOf(x, y);
  const sv = sim.s.services;
  const sections: Section[] = [{ title: 'Public services within reach', bar: [
    { label: 'Healthcare', value: sv.healthCov[k] }, { label: 'Schools', value: sv.schoolCov[k] }, { label: 'Police', value: sv.policeCov[k] },
  ] }];
  return { ref: { k: 'tile', id: t }, title: terr, subtitle: `Tile ${x}, ${y} · ${(0.16).toFixed(2)} ha`, rows, sections, focus: [x + 0.5, y + 0.5] };
}

function pollutionLabel(v: number): string {
  return v < 0.08 ? 'Clean' : v < 0.2 ? 'Moderate' : v < 0.4 ? 'Poor' : 'Very poor';
}

export function inspectRoad(sim: Sim, t: number): Card {
  const m = sim.s.map, tr = sim.s.traffic;
  const cls = m.road[t];
  const x = t % W, y = (t / W) | 0;
  const vol = tr.volume[t], cap = ROAD_CAPACITY[cls];
  const tt = tr.tileTime[t] || 1;
  const speed = (40 / tt) * 3.6;
  const name = ['', 'Street', 'Avenue', 'Highway'][cls];
  const bridge = m.terrain[t] === Terrain.Water;
  let trucks = 0;
  for (const sh of sim.s.shipments) if (sh.path.includes(t)) trucks += sh.trucks;
  const cond = m.roadCond[t];
  return {
    ref: { k: 'tile', id: t }, title: bridge ? `${name} bridge` : name, subtitle: `Tile ${x}, ${y}`,
    rows: [
      ['Peak traffic', `${num(vol)} vehicles/hour`],
      ['Capacity', `${num(cap)} vehicles/hour (${pct(vol / cap)} used)`],
      ['Peak speed', `${Math.round(speed)} km/h (free flow ${ROAD_SPEED[cls]} km/h)`],
      ['Surface', `${pct(cond)} ${cond < 0.35 ? '(potholes slow traffic)' : cond < 0.6 ? '(worn)' : '(good)'}`],
      ['Trucks on this stretch today', num(trucks)],
    ],
    sections: [{ title: 'Why', lines: [
      vol > cap ? 'Demand exceeds capacity at rush hour, so speeds collapse' : vol > cap * 0.7 ? 'Busy at rush hour' : 'Traffic flows freely',
      cond < 0.35 ? 'Road maintenance is behind: the transport budget does not cover the wear' : 'Surface kept up by the transport department',
    ] }],
    focus: [x + 0.5, y + 0.5],
  };
}

// ------------------------------------------------------------------------------------------------ buildings

export function inspectBuilding(sim: Sim, b: Building): Card {
  const biz = b.biz >= 0 ? sim.biz(b.biz) : undefined;
  if (biz && biz.farm) return inspectBusiness(sim, biz);
  if (biz) return inspectBusiness(sim, biz);
  const spec = BUILDINGS[b.kind];
  const rows: [string, string][] = [['Owner', ownerLabel(sim, b)], ['Built', b.built <= 0 ? 'Before records began' : formatDay(sim.s.meta.startYear, b.built)], ['Condition', pct(b.condition)], ['Value', money(sim, b.value)]];
  const sections: Section[] = [];
  if (b.units > 0) {
    rows.push(['Homes', `${b.occupants.length} of ${b.units} occupied`]);
    if (b.rent > 0) rows.push(['Rent', `${money(sim, b.rent)} a month per home`]);
    const links: Link[] = [];
    for (const hid of b.occupants.slice(0, 12)) {
      const h = sim.hh(hid);
      const c = h ? sim.cit(h.members[0]) : undefined;
      if (h && c) links.push({ label: `${c.last} household (${h.members.length})`, ref: { k: 'household', id: h.id } });
    }
    if (links.length) sections.push({ title: 'Residents', links, lines: b.occupants.length > 12 ? [`and ${b.occupants.length - 12} more households`] : undefined });
  }
  if (b.kind === 'park') rows.push(['Use', 'Public green space']);
  if (b.kind === 'heritage') {
    const T = sim.s.tourism.last;
    rows.push(['Use', 'Historic site open to visitors'], ['Visitors to the city last month', num(T.domestic + T.foreign)]);
    sections.push({ title: 'Conservation', lines: [
      b.condition < 0.5 ? 'The site is decaying: visitors are put off and the entry fees fall' : 'The site is well kept and draws visitors from across the region',
      `Upkeep is paid from the culture budget (funding ${pct(sim.s.gov.deptFunding.culture)}); below full funding it slowly deteriorates`,
    ] });
  }
  return { ref: { k: 'building', id: b.id }, title: b.name || spec.label, subtitle: `${spec.label}${b.floors > 1 ? ` · ${b.floors} floors` : ''}`, rows, sections, focus: sim.center(b) };
}

/** Extra rows for hotels, venues and the airport. */
function venueRows(sim: Sim, b: Business, rows: [string, string][], sections: Section[]): void {
  if (b.hotel) {
    const h = b.hotel;
    const occ = h.rooms > 0 ? h.lastNights / (h.rooms * 30) : 0;
    rows.push(['Rooms', num(h.rooms)], ['Occupancy last month', pct(occ)], ['Guests last month', `${num(h.lastGuests)} (${num(h.lastForeign)} from abroad)`], ['Occupied last night', num(h.occupied)]);
  }
  if (b.venue) {
    const v = b.venue;
    rows.push(['Tickets sold last month', `${num(v.lastSold)}${v.lastVisitors ? ` (${num(v.lastVisitors)} to visitors)` : ''}`]);
    if (b.kind === 'stadium') {
      rows.push(['Events last month', num(v.lastEvents)], ['Last crowd', num(v.lastCrowd)]);
      if (v.nextEvent >= sim.day) rows.push(['Next event', `${formatDay(sim.s.meta.startYear, v.nextEvent)} (${num(v.eventSold)} tickets sold)`]);
    }
  }
  if (b.kind === 'airport') {
    const A = sim.s.air;
    rows.push(['Passengers last month', num(A.last.pax)], ['Flights last month', num(A.last.flights)], ['Fees last month', money(sim, A.last.fees)]);
    sections.push({ title: 'Routes', lines: A.routes.length ? A.routes.map((r) => `${r.airline} to ${r.dest}: ${r.weekly} a week, ${r.lastSeats ? pct(r.lastPax / r.lastSeats) : '–'} full`) : ['No airline flies here yet'] });
  }
}

function staffLines(sim: Sim, b: Business): Section {
  const byRole = new Map<string, { n: number; filled: number; wage: number }>();
  for (const j of b.jobs) {
    const r = byRole.get(j.role) ?? { n: 0, filled: 0, wage: 0 };
    r.n++; if (j.worker >= 0) r.filled++; r.wage += j.wage;
    byRole.set(j.role, r);
  }
  const rows: [string, string][] = [...byRole.entries()].map(([role, r]) => [ROLES[role as keyof typeof ROLES].label, `${r.filled}/${r.n} · ${money(sim, r.wage / r.n)}`]);
  const links = b.jobs.filter((j) => j.worker >= 0).slice(0, 10).map((j) => citLink(sim, sim.cit(j.worker)!)).filter(Boolean);
  return { title: `Staff (${b.jobs.filter((j) => j.worker >= 0).length} of ${b.jobs.length} posts filled)`, rows, links };
}

function ledgerRows(sim: Sim, b: Business): [string, string][] {
  const L = b.last;
  const profit = L.revenue - L.cogs - L.wages - L.other - L.taxes;
  return [
    ['Revenue', money(sim, L.revenue)], ['Purchases & freight', money(sim, L.cogs)], ['Wages', money(sim, L.wages)],
    ['Other costs', money(sim, L.other)], ['Taxes', money(sim, L.taxes)], ['Profit', money(sim, profit)],
  ];
}

export function inspectBusiness(sim: Sim, b: Business): Card {
  const bl = sim.bld(b.building);
  const spec = BUSINESSES[b.kind];
  const owner = b.owner >= 0 ? sim.cit(b.owner) : undefined;
  const rows: [string, string][] = [];
  const sections: Section[] = [];
  rows.push(['Owner', b.pub ? 'City government' : owner ? sim.fullName(owner) : 'Outside investors']);
  if (b.farm) return inspectFarm(sim, b, bl, rows, owner);
  const status = { planned: 'Premises being built', registering: 'Registering the company', licensing: 'Waiting for licences', hiring: 'Hiring staff', operating: 'Operating', closed: 'Closed' }[b.status];
  rows.push(['Status', status + (b.downDays > 0 ? ` (shut for ${b.downDays} days)` : '')]);
  if (b.founded > 0) rows.push(['Founded', formatDay(sim.s.meta.startYear, b.founded)]);
  rows.push(['Employees', `${b.jobs.filter((j) => j.worker >= 0).length}`]);
  if (!b.pub) {
    rows.push(['Cash', money(sim, b.cash)]);
    if (b.loan > 0) rows.push(['Loans', money(sim, b.loan)]);
    rows.push(['Taxes paid (all time)', money(sim, b.taxesTotal)]);
    sections.push({ title: 'Last month', rows: ledgerRows(sim, b) });
    const inv = GOODS.filter((g) => (b.inv[g] ?? 0) > 0.01).map((g) => [GOOD_SPECS[g].label, `${(b.inv[g] ?? 0).toFixed(g === 'goods' ? 0 : 1)} ${GOOD_SPECS[g].unit}`] as [string, string]);
    if (inv.length) sections.push({ title: 'Stock', rows: inv });
    if (b.last.unmet > 0) sections.push({ title: 'Demand', lines: [`Turned away customers worth ${money(sim, b.last.unmet)} last month (not enough staff or stock)`] });
  } else {
    const dept = spec.dept!;
    rows.push(['Department', DEPT_LABELS[dept]], ['Funding', pct(sim.s.gov.deptFunding[dept])]);
    if (spec.serves) rows.push(['Capacity', `${num(spec.serves)} ${b.kind === 'school' || b.kind === 'college' ? 'students' : 'residents'}`]);
    if (b.kind === 'school' || b.kind === 'college') {
      const n = sim.s.citizens.filter((c) => c.school === b.id).length;
      rows.push(['Enrolled', num(n)]);
    }
  }
  venueRows(sim, b, rows, sections);
  if (b.reason) sections.push({ title: b.lossMonths > 0 ? 'Why it is struggling' : 'Why it is here', lines: [b.reason] });
  if (b.jobs.length) sections.push(staffLines(sim, b));
  const title = b.name;
  return { ref: { k: 'business', id: b.id }, title, subtitle: spec.label, rows, sections, focus: bl ? sim.center(bl) : [64, 64] };
}

function inspectFarm(sim: Sim, b: Business, bl: Building | undefined, rows: [string, string][], owner?: Citizen): Card {
  const f = b.farm!;
  const sections: Section[] = [];
  const hands = b.jobs.filter((j) => j.worker >= 0).length;
  const family = owner ? (sim.hh(owner.hh)?.members.filter((id) => { const c = sim.cit(id); return c && c.employer === b.id; }).length ?? 1) : 0;
  rows.push(['Employees', `${hands} hired, ${family} family`], ['Land', `${f.ha.toFixed(1)} ha`], ['Irrigation', f.irrigation >= 0.85 ? 'Canal' : f.well ? 'Tube well' : 'Rain-fed']);
  const phase = { fallow: 'Fallow', preparing: 'Preparing land', sowing: 'Sowing', growing: 'Growing', ready: 'Ready to harvest', harvesting: 'Harvesting' }[f.phase];
  if (f.crop) {
    const spec = CROPS[f.crop];
    rows.push(['Crop', `${spec.label} · ${phase}`]);
    if (f.phase === 'growing') {
      const rate = Math.max(0.15, cropTempFactor(spec, sim.s.weather.temp)) / spec.days;
      rows.push(['Growth', pct(f.growth)], ['Expected harvest', `in about ${Math.ceil((1 - f.growth) / rate)} days`]);
    }
    rows.push(['Crop condition', pct(f.health)], ['Expected yield', `${f.expected.toFixed(1)} t`]);
  } else rows.push(['Crop', phase]);
  rows.push(['Water use today', `${num(f.waterToday)} L`], ['Soil moisture', pct(Math.min(1, f.moisture))]);
  rows.push(['Revenue this season', money(sim, f.seasonRevenue)], ['Costs this season', money(sim, f.seasonCost)], ['Tax paid (all time)', money(sim, b.taxesTotal)]);
  if (f.plan) sections.push({ title: 'Farmer’s plan', lines: [f.plan] });
  const losses = Object.entries(f.losses).filter(([, v]) => v > 0.01).sort((a, c) => c[1] - a[1]);
  const names: Record<string, string> = { water: 'Dry spells', drought: 'Drought', flood: 'Waterlogging', heat: 'Heat', heatwave: 'Heatwave', cold: 'Cold', disease: 'Disease', labour: 'Labour shortage' };
  if (losses.length) sections.push({ title: 'Crop damage this season', bar: losses.map(([k, v]) => ({ label: names[k] ?? k, value: Math.min(1, v), tone: 'bad' as const })) });
  if (f.lastHarvest) sections.push({ title: 'Last harvest', lines: [`${f.lastHarvest.t.toFixed(1)} t of ${CROPS[f.lastHarvest.crop].label.toLowerCase()} on ${formatDay(sim.s.meta.startYear, f.lastHarvest.day)} (condition ${pct(f.lastHarvest.health)})`] });
  if (f.disease > 0) sections.push({ title: 'Warning', lines: [`Crop disease: ${f.disease} more days of damage expected`] });
  sections.push({ title: 'Last month', rows: ledgerRows(sim, b) });
  if (b.jobs.length) sections.push(staffLines(sim, b));
  return { ref: { k: 'business', id: b.id }, title: b.name, subtitle: 'Farm', rows, sections, focus: bl ? sim.center(bl) : [64, 64] };
}

// ------------------------------------------------------------------------------------------------ people

export function inspectCitizen(sim: Sim, c: Citizen): Card {
  const h = sim.hh(c.hh);
  const home = sim.homeOf(c);
  const emp = c.employer >= 0 ? sim.biz(c.employer) : undefined;
  const school = c.school >= 0 ? sim.biz(c.school) : undefined;
  const age = Math.floor(sim.age(c));
  let occupation = STATUS_LABEL[c.status];
  if (c.status === 'working' && emp && c.job >= 0 && emp.jobs[c.job]) occupation = ROLES[emp.jobs[c.job].role].label;
  if (c.status === 'owner' && emp) occupation = emp.owner === c.id ? `Owner, ${BUSINESSES[emp.kind].label.toLowerCase()}` : `Family member working at the ${BUSINESSES[emp.kind].label.toLowerCase()}`;
  const rows: [string, string][] = [['Age', `${age}`], ['Occupation', occupation]];
  if (c.wage > 0) rows.push(['Salary', `${money(sim, c.wage)}/month`]);
  if (emp) rows.push(['Employer', emp.name]);
  if (school) rows.push([sim.age(c) >= 18 ? 'College' : 'School', school.name]);
  if (home) {
    const work = sim.workplaceOf(c);
    rows.push(['Home', work && work.id !== home.id ? `${(c.commuteKm || (sim.dist(home, work) * 40) / 1000).toFixed(1)} km from ${c.school >= 0 ? 'school' : 'work'}` : home.name || BUILDINGS[home.kind].label]);
  } else rows.push(['Home', 'No home of their own (staying with relatives)']);
  if (c.commute > 0) rows.push(['Commute', `${MODE_LABEL[c.mode]}, ${Math.round(c.commute)} min each way`]);
  rows.push(['Education', `${EDU_LABEL[c.edu]}${c.edu >= 3 ? ` (${FIELD_LABEL[c.field]})` : ''}`], ['Health', pct(c.health)]);
  if (c.status === 'unemployed') rows.push(['Out of work for', spanText(c.unempDays)]);
  if (c.injured > 0) rows.push(['Injured', `${c.injured} more days`]);
  const sections: Section[] = [];
  if (sim.age(c) >= 16) {
    const parts = satisfactionParts(sim, c, h, sim.s.services.crime);
    sections.push({ title: `Satisfaction ${pct(c.sat)}`, bar: satBars(parts) });
    sections.push({ title: 'Views', lines: [c.lean > 0.3 ? 'Favours low taxes and free markets' : c.lean < -0.3 ? 'Favours public services and welfare' : 'Politically moderate', c.green > 0.55 ? 'Cares strongly about the environment' : 'Moderate concern for the environment'] });
  }
  const links: Link[] = [];
  if (h) links.push({ label: `Household (${h.members.length} people)`, ref: { k: 'household', id: h.id } });
  if (emp) links.push(bizLink(emp));
  if (home) links.push({ label: 'Home', ref: { k: 'building', id: home.id } });
  if (c.partner >= 0) { const p = sim.cit(c.partner); if (p) links.push(citLink(sim, p)); }
  sections.push({ title: 'Connections', links });
  return { ref: { k: 'citizen', id: c.id }, title: sim.fullName(c), subtitle: `${c.female ? 'Woman' : 'Man'}, ${age}`, rows, sections, focus: home ? sim.center(home) : [64, 64] };
}

const SAT_LABEL: Record<keyof SatParts, string> = {
  employment: 'Work', income: 'Income', housing: 'Housing', commute: 'Commute', health: 'Health', safety: 'Safety', environment: 'Environment',
  food: 'Food', taxes: 'Taxes', services: 'Public services', leisure: 'Leisure',
};

export function satBars(p: SatParts): { label: string; value: number; tone?: 'good' | 'bad' }[] {
  return (Object.keys(SAT_WEIGHTS) as (keyof SatParts)[]).map((k) => ({ label: SAT_LABEL[k], value: p[k], tone: p[k] < 0.45 ? 'bad' : p[k] > 0.75 ? 'good' : undefined }));
}

export function inspectHousehold(sim: Sim, h: Household): Card {
  const home = h.home >= 0 ? sim.bld(h.home) : undefined;
  const L = h.last;
  const head = sim.cit(h.members[0]);
  const rows: [string, string][] = [
    ['Members', `${h.members.length}`], ['Income last month', money(sim, hhIncome(h))], ['Savings', money(sim, h.cash)],
    ['Home', home ? `${home.name || BUILDINGS[home.kind].label}${h.owns ? ' (owned)' : ` · rent ${money(sim, h.rent)}`}` : 'None: living with relatives'],
    ['Vehicles', [h.car ? 'car' : '', h.bike ? 'two-wheeler' : ''].filter(Boolean).join(', ') || 'none'],
    ['Food security', pct(h.foodSec)],
  ];
  const spend: [string, string][] = [
    ['Wages', money(sim, L.wages)], ['Benefits & pensions', money(sim, L.benefits)], ['Business & rental income', money(sim, L.dividends)], ['Income tax', money(sim, L.taxes)],
    ['Rent', money(sim, L.rent)], ['Food', money(sim, L.food)], ['Goods', money(sim, L.goods)], ['Meals & services', money(sim, L.services)], ['Transport', money(sim, L.transport)],
  ];
  const links = h.members.map((id) => sim.cit(id)).filter((c): c is Citizen => !!c).map((c) => ({ label: `${sim.fullName(c)} (${Math.floor(sim.age(c))}, ${STATUS_LABEL[c.status].toLowerCase()})`, ref: { k: 'citizen' as const, id: c.id } }));
  const sections: Section[] = [{ title: 'Members', links }, { title: 'Last month', rows: spend }];
  if (h.rentArrears > 0) sections.push({ title: 'Warning', lines: [`${h.rentArrears} month${h.rentArrears > 1 ? 's' : ''} behind on rent: eviction after three`] });
  return { ref: { k: 'household', id: h.id }, title: `${head?.last ?? ''} household`, subtitle: home ? BUILDINGS[home.kind].label : 'Without a home', rows, sections, focus: home ? sim.center(home) : [64, 64] };
}

// ------------------------------------------------------------------------------------------------ projects

export function projectProgress(p: Project): number {
  if (p.phase === 'done' || p.phase === 'staffing') return 1;
  return p.labor > 0 ? Math.min(1, p.laborDone / p.labor) : 0;
}

export function inspectProject(sim: Sim, p: Project): Card {
  const s = sim.s;
  const rows: [string, string][] = [
    ['Stage', PHASE_LABEL[p.phase] + (p.phaseLeft > 0 && ['planning', 'assessment', 'approval', 'land'].includes(p.phase) ? ` (${p.phaseLeft} days left)` : '')],
    ['Construction', pct(projectProgress(p))],
    ['Estimated cost', `${money(sim, p.cost)} (original ${money(sim, p.budget)})`],
    ['Spent so far', money(sim, p.spent)],
    ['Materials delivered', `${Math.round(p.matDelivered)} of ${Math.round(p.materials)} t`],
    ['Workers on site today', `${p.workersToday}`],
    ['Started', formatDay(s.meta.startYear, p.created)],
  ];
  const planned = p.created + p.plannedDays + p.delayDays;
  if (p.phase !== 'done' && p.phase !== 'cancelled') rows.push(['Expected completion', formatDay(s.meta.startYear, Math.max(sim.day + 1, planned))]);
  const contractor = p.contractor >= 0 ? sim.biz(p.contractor) : undefined;
  if (contractor) rows.push(['Contractor', contractor.name]);
  const sections: Section[] = [];
  if (p.issue) sections.push({ title: 'Current problem', lines: [p.issue] });
  const delays = Object.entries(p.issues).sort((a, b) => b[1] - a[1]);
  if (delays.length) sections.push({ title: `Delays (${p.delayDays} days)`, rows: delays.map(([k, v]) => [k, `${v} days`]) });
  if (p.reason) sections.push({ title: 'Why', lines: [p.reason] });
  const kind = isRoadwork(p.kind) ? p.kind : BUILDINGS[p.kind as keyof typeof BUILDINGS].label;
  const [x, y] = [p.x + p.w / 2, p.y + p.h / 2];
  const focus: [number, number] = p.tiles.length > 1 && isRoadwork(p.kind) ? [(p.tiles[Math.floor(p.tiles.length / 2)] % W) + 0.5, ((p.tiles[Math.floor(p.tiles.length / 2)] / W) | 0) + 0.5] : [x, y];
  return { ref: { k: 'project', id: p.id }, title: p.name, subtitle: `${p.gov ? 'Public project' : 'Private development'} · ${kind}`, rows, sections, focus };
}

// ------------------------------------------------------------------------------------------------ dashboard explanations

export type MetricKey = 'population' | 'unemployment' | 'budget' | 'housing' | 'food' | 'traffic' | 'satisfaction' | 'health' | 'environment' | 'education' | 'agriculture';

export const REV_LABELS: Record<RevCat, string> = {
  incomeTax: 'Income tax', corporateTax: 'Corporate tax', smallBizTax: 'Small business tax', salesTax: 'Sales tax', foodTax: 'Sales tax on food', propertyTax: 'Property tax',
  fuelTax: 'Fuel tax', importTariff: 'Import tariffs', exportTax: 'Export tax', agriTax: 'Agricultural tax', luxuryTax: 'Luxury tax', licenseFees: 'Licence fees', rents: 'Public housing rents',
  fares: 'Bus fares', premiums: 'Crop insurance premiums', grants: 'Grants from higher government', tourismTax: 'Hotel room tax', entertainmentTax: 'Entertainment tax',
  airportFees: 'Airport fees', tickets: 'Museum, stadium and heritage tickets', grainSales: 'Sales of surplus grain', other: 'Other (water charges, estates)',
};
export const EXP_LABELS: Record<ExpCat, string> = {
  admin: 'Administration', health: 'Health', education: 'Education', safety: 'Police & safety', transport: 'Transport & roads', agriculture: 'Agriculture', environment: 'Environment',
  culture: 'Culture, sport & heritage', unemployment: 'Unemployment benefits', pensions: 'Pensions', fertilizer: 'Fertilizer subsidy', insurance: 'Crop insurance payouts',
  capital: 'Construction projects', interest: 'Interest on debt', land: 'Land acquisition', procurement: 'Grain procurement & storage', rations: 'Ration shops',
  transfers: 'Cash support for poor families', exportSupport: 'Export incentives', promotion: 'Tourism promotion & festivals',
};

function lastMonth(sim: Sim) { const m = sim.s.stats.months; return m[m.length - 1]; }
function monthsAgo(sim: Sim, k: number) { const m = sim.s.stats.months; return m[Math.max(0, m.length - 1 - k)]; }

function recent(sim: Sim, types: string[], days: number, n = 4): string[] {
  const out: string[] = [];
  const ev = sim.s.events;
  for (let i = ev.length - 1; i >= 0 && out.length < n; i--) {
    if (sim.day - ev[i].day > days) break;
    if (types.some((t) => ev[i].type.startsWith(t))) out.push(`${ev[i].text} (${formatDay(sim.s.meta.startYear, ev[i].day)})`);
  }
  return out;
}

/** Explains what is driving a dashboard figure, using the simulation's own records. */
export function explain(sim: Sim, key: MetricKey): Section[] {
  const s = sim.s, st = lastMonth(sim), q = monthsAgo(sim, 3);
  if (!st) return [];
  switch (key) {
    case 'population': return [
      { title: 'Last month', rows: [['Births', num(st.births)], ['Deaths', num(st.deaths)], ['Moved in', num(st.immigrants)], ['Moved out', num(st.emigrants)]] },
      { title: 'What drives it', lines: ['People move in when there are vacancies and homes to rent', 'They leave when out of work for months, without a home, or unhappy'] },
      { title: 'Recent', lines: recent(sim, ['migration'], 120) },
    ];
    case 'unemployment': {
      const tiers = s.labor.unemployed.map((u, i) => [EDU_LABEL[i], `${u} looking · ${s.labor.vacancies[i]} vacancies`] as [string, string]);
      return [
        { title: `Unemployment ${pct(st.unemployment, 1)} (3 months ago ${pct(q.unemployment, 1)})`, rows: tiers },
        { title: 'Job changes', lines: recent(sim, ['business.closed', 'business.layoffs', 'business.opened', 'gov.cuts', 'project.opened', 'investment'], 120, 6) },
      ];
    }
    case 'budget': {
      const g = s.gov;
      const rev = (Object.keys(g.last.rev) as RevCat[]).filter((k) => g.last.rev[k] > 0).sort((a, b) => g.last.rev[b] - g.last.rev[a]).map((k) => [REV_LABELS[k], money(sim, g.last.rev[k])] as [string, string]);
      const exp = (Object.keys(g.last.exp) as ExpCat[]).filter((k) => g.last.exp[k] > 0).sort((a, b) => g.last.exp[b] - g.last.exp[a]).map((k) => [EXP_LABELS[k], money(sim, g.last.exp[k])] as [string, string]);
      return [
        { title: `Revenue last month: ${money(sim, sumRev(g.last))}`, rows: rev },
        { title: `Spending last month: ${money(sim, sumExp(g.last))}`, rows: exp },
        { title: 'Debt', rows: [['Outstanding', money(sim, g.debt)], ['Interest rate', pct(g.rate, 1)], ['Credit rating', g.rating]], lines: g.debt > 0 ? ['When spending exceeds revenue the gap is borrowed; interest then takes a growing share of the budget'] : undefined },
      ];
    }
    case 'housing': return [
      { title: 'Housing market', rows: [['Homes', num(st.units)], ['Vacant', `${num(st.vacantUnits)} (${pct(st.vacantUnits / Math.max(1, st.units), 1)})`], ['Families without a home', num(st.homeless)], ['Rent index', `${Math.round(st.rentIndex * 100)}`], ['Median rent burden', pct(st.rentBurden)]] },
      { title: 'What drives it', lines: ['Rents rise when fewer than 5% of homes are empty and fall slowly when many are', 'Developers build when homes would sell for well over their building cost, on zoned land with road access'] },
      { title: 'Recent', lines: recent(sim, ['housing', 'zoning'], 200) },
    ];
    case 'food': {
      const why = [s.market.food.lastWhy, s.market.vegetables.lastWhy].filter(Boolean);
      const grains = (['wheat', 'rice', 'maize'] as const).map((g) => [GOOD_SPECS[g].label, `local ${num(s.market[g].lastLocal)} t · imported ${num(s.market[g].lastImported)} t · exported ${num(s.market[g].lastExported)} t`] as [string, string]);
      return [
        { title: `Staple food ${money(sim, st.foodPrice)}/kg in shops`, lines: why },
        { title: 'Grain last month', rows: grains },
        { title: 'Recent', lines: recent(sim, ['weather', 'farm', 'world.price', 'price', 'tax.changed'], 150) },
      ];
    }
    case 'traffic': {
      const m = s.map;
      let worst = -1, wr = 0;
      for (let i = 0; i < m.road.length; i++) { const c = m.road[i]; if (!c) continue; const r = s.traffic.volume[i] / ROAD_CAPACITY[c]; if (r > wr) { wr = r; worst = i; } }
      return [
        { title: 'Commuting', rows: [['Average commute', `${Math.round(st.commute)} min`], ['Congestion (delay factor)', st.congestion.toFixed(2)], ['Roads in poor condition', pct(st.poorRoads)]] },
        { title: 'Busiest road', lines: worst >= 0 ? [`Tile ${worst % W}, ${(worst / W) | 0}: ${pct(wr)} of capacity at rush hour`] : [] },
        { title: 'What drives it', lines: ['Traffic comes from commuters by car, two-wheeler and bus plus delivery trucks', 'More car owners as incomes rise; wider roads and buses add capacity'] },
      ];
    }
    case 'satisfaction': {
      const acc: Record<string, number> = {};
      let n = 0;
      for (const c of s.citizens) {
        if (sim.age(c) < 16) continue;
        if (c.id % 5 !== 0) continue; // a representative sample keeps this cheap
        const p = satisfactionParts(sim, c, sim.hh(c.hh), s.services.crime);
        for (const k of Object.keys(p) as (keyof SatParts)[]) acc[k] = (acc[k] ?? 0) + p[k];
        n++;
      }
      const avg = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / Math.max(1, n)])) as unknown as SatParts;
      return [{ title: `Satisfaction ${pct(st.satisfaction)}`, bar: n ? satBars(avg) : [] }, { title: 'Recent', lines: recent(sim, ['tax', 'policy', 'gov', 'housing.evictions'], 120) }];
    }
    case 'health': return [
      { title: 'Health', rows: [['Average health', pct(st.health)], ['Life expectancy', `${st.lifeExp.toFixed(1)} years`], ['Healthcare coverage', pct(st.healthCoverage)], ['Health funding', pct(s.gov.deptFunding.health)]] },
      { title: 'What drives it', lines: ['Clinics and hospitals staffed with doctors and nurses', 'Food security, air pollution and age'] },
    ];
    case 'environment': return [
      { title: 'Environment', rows: [['Air pollution where people live', pollutionLabel(st.pollution)], ['CO₂ last month', `${num(st.co2)} t`], ['Water quality', pct(st.water)], ['Green cover', pct(st.green)]] },
      { title: 'Sources', lines: ['Factories, the materials plant and food processing emit in proportion to output', 'Traffic along busy roads', 'Stricter regulation, enforced by the environment budget, cuts emissions'] },
    ];
    case 'education': return [
      { title: 'Education', rows: [['Children in school', pct(st.enrollment)], ['Adult literacy', pct(st.literacy)], ['Adults with a diploma or degree', pct(st.tertiary)], ['Education funding', pct(s.gov.deptFunding.education)]] },
      { title: 'What drives it', lines: ['School places and staffed classrooms near where families live', 'A college turns school leavers into engineers, nurses and technicians after 3–4 years'] },
    ];
    case 'agriculture': {
      const crops = Object.entries(st.cropOutput).map(([k, v]) => [CROPS[k as keyof typeof CROPS]?.label ?? k, `${num(v)} t`] as [string, string]);
      const farms = s.businesses.filter((b) => b.farm);
      const phases: Record<string, number> = {};
      for (const b of farms) { const k = b.farm!.crop ? `${CROPS[b.farm!.crop].label} (${b.farm!.phase})` : 'Fallow'; phases[k] = (phases[k] ?? 0) + 1; }
      return [
        { title: 'Harvested last month', rows: crops.length ? crops : [['—', 'No harvest']] },
        { title: `${farms.length} farms now`, rows: Object.entries(phases).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${v}`]) },
        { title: 'Recent', lines: recent(sim, ['weather', 'farm', 'world.price'], 180) },
      ];
    }
  }
}

/** Short district name relative to the town hall, for news and summaries. */
export function districtName(sim: Sim, x: number, y: number): string {
  const th = sim.s.buildings.find((b) => b.kind === 'townhall');
  const [cx, cy] = th ? sim.center(th) : [64, 64];
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < 6) return 'the town centre';
  const dir = Math.abs(dx) > Math.abs(dy) * 2 ? (dx > 0 ? 'east' : 'west') : Math.abs(dy) > Math.abs(dx) * 2 ? (dy > 0 ? 'south' : 'north') : `${dy > 0 ? 'south' : 'north'}-${dx > 0 ? 'east' : 'west'}`;
  return d > 30 ? `the far ${dir}` : `the ${dir}ern district`;
}

export function roadClassName(c: number): string { return ['', 'Street', 'Avenue', 'Highway'][c] ?? ''; }

/** Tile index for tile coordinates (re-exported for UI code). */
export const tileIndex = idx;
