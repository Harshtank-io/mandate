// "While you were away": a snapshot before catching up and a comparison afterwards. Plus the list of matters
// that need the player's attention right now. Both are computed from the simulated state and event log.

import { spanText } from './calendar';
import { sumExp, sumRev, type Sim } from './core';
import { CROPS, ROAD_CAPACITY } from './tables';
import { fmtMoney } from './systems/construction';
import { DEPT_LABELS } from './systems/government';
import { districtName, projectProgress } from './inspect';
import { DEPTS, Zone, type Building, type SimEvent } from './types';

export interface Snapshot {
  minute: number;
  day: number;
  lastEventId: number;
  population: number;
  businesses: number;
  jobsFilled: number;
  unemployment: number;
  rev: number;
  exp: number;
  cash: number;
  debt: number;
  harvest: Record<string, number>;
  projects: Record<number, { name: string; progress: number; phase: string }>;
  units: number;
  congestion: number;
  districtLoad: number[]; // 8x8 grid of peak volume/capacity
  pollution: number;
  satisfaction: number;
  foodPrice: number;
  rentIndex: number;
  opened: number;
  closed: number;
  visitors: number; foreignVisitors: number; visitorSpend: number;
  passengers: number;
  routes: number[];
  fx: number;
}

export interface SummaryLine { text: string; tone: 'good' | 'bad' | 'neutral'; ref?: SimEvent['ref'] }
export interface AwaySummary { days: number; span: string; lines: SummaryLine[]; events: SimEvent[]; attention: Alert[] }

function cum(sim: Sim, k: 'opened' | 'closed'): number {
  let t = sim.s.stats.acc[k];
  for (const m of sim.s.stats.months) t += m[k];
  return t;
}

function districtLoad(sim: Sim): number[] {
  const out = new Array(64).fill(0), cnt = new Array(64).fill(0);
  const m = sim.s.map, v = sim.s.traffic.volume;
  for (let i = 0; i < m.road.length; i++) {
    const c = m.road[i];
    if (!c) continue;
    const k = Math.min(7, ((i / 128) | 0) >> 4) * 8 + Math.min(7, (i % 128) >> 4);
    out[k] += v[i] / ROAD_CAPACITY[c];
    cnt[k]++;
  }
  return out.map((x, k) => (cnt[k] ? x / cnt[k] : 0));
}

function avgPollution(sim: Sim): number {
  const m = sim.s.stats.months;
  return m.length ? m[m.length - 1].pollution : 0;
}

export function snapshot(sim: Sim): Snapshot {
  const s = sim.s;
  const projects: Snapshot['projects'] = {};
  for (const p of s.projects) projects[p.id] = { name: p.name, progress: projectProgress(p), phase: p.phase };
  let adults = 0, sat = 0, lf = 0, un = 0, units = 0, jobs = 0;
  for (const c of s.citizens) {
    if (sim.age(c) >= 16) { adults++; sat += c.sat; }
    if (c.status === 'working' || c.status === 'owner') lf++;
    if (c.status === 'unemployed') { lf++; un++; }
  }
  for (const b of s.buildings) if (b.units > 0 && b.kind !== 'farmhouse') units += b.units;
  for (const b of s.businesses) for (const j of b.jobs) if (j.worker >= 0) jobs++;
  const ev = s.events;
  return {
    minute: s.minute, day: sim.day, lastEventId: ev.length ? ev[ev.length - 1].id : 0,
    population: s.citizens.length, businesses: s.businesses.filter((b) => !b.pub && b.status === 'operating').length, jobsFilled: jobs,
    unemployment: lf ? un / lf : 0, rev: s.gov.total.rev, exp: s.gov.total.exp, cash: s.gov.cash, debt: s.gov.debt,
    harvest: { ...s.stats.cumHarvest }, projects, units, congestion: s.traffic.congestion, districtLoad: districtLoad(sim),
    pollution: avgPollution(sim), satisfaction: adults ? sat / adults : 0, foodPrice: s.market.food.price, rentIndex: s.housing.rentIndex,
    opened: cum(sim, 'opened'), closed: cum(sim, 'closed'),
    visitors: s.tourism.total.visitors, foreignVisitors: s.tourism.total.foreign, visitorSpend: s.tourism.total.spend,
    passengers: s.air.totalPax, routes: s.air.routes.map((r) => r.id), fx: s.trade.fx,
  };
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const whole = (v: number) => Math.round(v).toLocaleString('en-US');
const pctChange = (a: number, b: number) => (a > 0 ? (b / a - 1) * 100 : 0);

export function summarize(sim: Sim, before: Snapshot): AwaySummary {
  const now = snapshot(sim);
  const days = (now.minute - before.minute) / 1440;
  const lines: SummaryLine[] = [];
  const dp = now.population - before.population;
  lines.push({ text: `Population ${signed(dp)} (now ${now.population.toLocaleString('en-US')})`, tone: dp > 0 ? 'good' : dp < 0 ? 'bad' : 'neutral' });
  const op = now.opened - before.opened, cl = now.closed - before.closed;
  if (op) lines.push({ text: `${op} new business${op > 1 ? 'es' : ''} opened`, tone: 'good' });
  if (cl) lines.push({ text: `${cl} business${cl > 1 ? 'es' : ''} closed`, tone: 'bad' });
  const dj = now.jobsFilled - before.jobsFilled;
  if (Math.abs(dj) >= 5) lines.push({ text: `${signed(dj)} jobs; unemployment ${(before.unemployment * 100).toFixed(1)}% → ${(now.unemployment * 100).toFixed(1)}%`, tone: dj > 0 ? 'good' : 'bad' });
  const rev = now.rev - before.rev, exp = now.exp - before.exp;
  lines.push({ text: `${fmtMoney(sim, rev)} collected in taxes, fees and grants; ${fmtMoney(sim, exp)} spent`, tone: rev >= exp ? 'good' : 'neutral' });
  if (Math.abs(now.debt - before.debt) > 1) lines.push({ text: `Debt ${now.debt > before.debt ? 'rose' : 'fell'} to ${fmtMoney(sim, now.debt)}`, tone: now.debt > before.debt ? 'bad' : 'good' });
  // construction
  for (const [id, b] of Object.entries(before.projects)) {
    const p = sim.ix.proj.get(Number(id));
    const after = now.projects[Number(id)];
    if (!p || !p.gov) continue;
    if (p.phase === 'done' || p.phase === 'staffing') { if (b.phase !== 'done' && b.phase !== 'staffing') lines.push({ text: `${b.name} completed`, tone: 'good', ref: { k: 'project', id: p.id } }); continue; }
    if (after && after.progress - b.progress >= 0.01) lines.push({ text: `${b.name}: construction ${Math.round(b.progress * 100)}% → ${Math.round(after.progress * 100)}%`, tone: 'neutral', ref: { k: 'project', id: p.id } });
    else if (p.issue) lines.push({ text: `${b.name} is held up: ${p.issue.toLowerCase()}`, tone: 'bad', ref: { k: 'project', id: p.id } });
  }
  for (const p of sim.s.projects) if (p.gov && !before.projects[p.id]) lines.push({ text: `New project under way: ${p.name}`, tone: 'neutral', ref: { k: 'project', id: p.id } });
  // harvests
  const crops = Object.entries(now.harvest).map(([k, v]) => [k, v - (before.harvest[k] ?? 0)] as [string, number]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]);
  if (crops.length) lines.push({ text: `Farms harvested ${crops.slice(0, 3).map(([k, v]) => `${Math.round(v).toLocaleString('en-US')} t of ${(CROPS[k as keyof typeof CROPS]?.label ?? k).toLowerCase()}`).join(', ')}`, tone: 'good' });
  const du = now.units - before.units;
  if (du > 0) lines.push({ text: `${du} new home${du > 1 ? 's' : ''} completed`, tone: 'good' });
  // traffic by district
  let worst = -1, wd = 0;
  now.districtLoad.forEach((v, k) => { const d = v - (before.districtLoad[k] ?? 0); if (d > wd) { wd = d; worst = k; } });
  if (worst >= 0 && wd > 0.05) lines.push({ text: `Traffic heavier in ${districtName(sim, (worst % 8) * 16 + 8, Math.floor(worst / 8) * 16 + 8)}`, tone: 'bad' });
  const df = pctChange(before.foodPrice, now.foodPrice);
  if (Math.abs(df) >= 3) lines.push({ text: `Wholesale food prices ${df > 0 ? 'up' : 'down'} ${Math.abs(df).toFixed(0)}%`, tone: df > 0 ? 'bad' : 'good' });
  const dr = pctChange(before.rentIndex, now.rentIndex);
  if (Math.abs(dr) >= 3) lines.push({ text: `Rents ${dr > 0 ? 'up' : 'down'} ${Math.abs(dr).toFixed(0)}%`, tone: dr > 0 ? 'bad' : 'neutral' });
  const ds = now.satisfaction - before.satisfaction;
  if (Math.abs(ds) >= 0.02) lines.push({ text: `Public satisfaction ${ds > 0 ? 'rose' : 'fell'} to ${Math.round(now.satisfaction * 100)}%`, tone: ds > 0 ? 'good' : 'bad' });
  // visitors, flights, trade and the food programmes, from running totals and the months recorded meanwhile
  const recorded = sim.s.stats.months.filter((m) => m.day > before.day);
  const sumOf = (k: 'turnedAway' | 'exports' | 'imports' | 'procured' | 'rationed') => recorded.reduce((a, m) => a + m[k], 0);
  const dv = now.visitors - before.visitors;
  if (dv >= 1) {
    const df = now.foreignVisitors - before.foreignVisitors;
    lines.push({ text: `${whole(dv)} visitors came${df >= 1 ? ` (${whole(df)} from abroad)` : ''} and spent ${fmtMoney(sim, now.visitorSpend - before.visitorSpend)}`, tone: 'good' });
  }
  const turned = sumOf('turnedAway');
  if (turned >= 20) lines.push({ text: `Hotels turned away about ${whole(turned)} visitors who found no room`, tone: 'bad' });
  const pax = now.passengers - before.passengers;
  if (pax >= 1) lines.push({ text: `${whole(pax)} passengers flew in or out of the airport`, tone: 'good' });
  for (const r of sim.s.air.routes) if (!before.routes.includes(r.id)) lines.push({ text: `New flights: ${r.airline} to ${r.dest}, ${r.weekly} a week`, tone: 'good' });
  if (recorded.length) {
    const ex = sumOf('exports'), im = sumOf('imports');
    lines.push({ text: `Exports ${fmtMoney(sim, ex)}, imports ${fmtMoney(sim, im)} (${ex >= im ? 'surplus' : 'deficit'} ${fmtMoney(sim, Math.abs(ex - im))})`, tone: ex >= im ? 'good' : 'neutral' });
  }
  const dfx = before.fx > 0 ? now.fx / before.fx - 1 : 0;
  if (Math.abs(dfx) >= 0.03) {
    lines.push({ text: `The ${sim.preset.currencyCode} ${dfx > 0 ? 'fell' : 'rose'} about ${Math.round(Math.abs(dfx) * 100)}% against the ${sim.preset.fxName}`, tone: 'neutral' });
  }
  const procured = sumOf('procured');
  if (procured >= 1) lines.push({ text: `The government bought ${whole(procured)} t of grain from farmers at the support price`, tone: 'neutral' });
  const rationed = sumOf('rationed');
  if (rationed >= 1000) lines.push({ text: `Ration shops handed out ${whole(rationed / 1000)} t of subsidised grain to ${whole(sim.s.pds.families)} families`, tone: 'good' });
  const investments = sim.s.events.filter((e) => e.id > before.lastEventId && e.type === 'investment.announced');
  for (const e of investments.slice(-3)) lines.push({ text: e.text, tone: 'good', ref: e.ref });
  const skip = new Set(['business.opened', 'business.closed', 'investment.announced', 'project.phase', 'project.completed']);
  const events = sim.s.events.filter((e) => e.id > before.lastEventId && e.sev >= 2 && !skip.has(e.type)).slice(-12).reverse();
  return { days, span: spanText(days), lines, events, attention: alerts(sim) };
}

export interface Alert { sev: 1 | 2 | 3; text: string; hint: string; ref?: SimEvent['ref']; tab?: string }

export interface FoundingStep { done: boolean; text: string; hint: string }

/** What a town founded on empty land still lacks, read from the current state. */
export function foundingSteps(sim: Sim): FoundingStep[] {
  const s = sim.s, zone = s.map.zone;
  let res = 0, com = 0, ind = 0, agr = 0;
  for (let i = 0; i < zone.length; i++) {
    const z = zone[i];
    if (z === Zone.Residential) res++; else if (z === Zone.Commercial) com++; else if (z === Zone.Industrial) ind++; else if (z === Zone.Agricultural) agr++;
  }
  const has = (k: string) => s.businesses.some((b) => b.kind === k) || s.projects.some((p) => p.kind === k && p.phase !== 'cancelled');
  return [
    { done: res > 0, text: 'Zone land for homes', hint: 'Developers build houses on residential land next to a road (the highway counts); settlers move in once homes are ready.' },
    { done: com > 0, text: 'Zone land for shops and services', hint: 'Traders among the settlers open groceries, shops and workshops once enough families live nearby.' },
    { done: has('townhall'), text: 'Commission a town hall', hint: 'The first public employer. It speeds up approvals and tax collection.' },
    { done: has('school') && has('clinic'), text: 'Build a school and a clinic', hint: 'Families look for schools and healthcare nearby, and the staff posts are jobs.' },
    { done: ind > 0, text: 'Zone industrial land', hint: 'A local construction company needs a yard. Until one sets up, outside contractors build at about 30% higher labour cost.' },
    { done: agr > 0, text: 'Zone farmland', hint: 'Farming families settle unused agricultural land next to a road.' },
  ];
}

export function alerts(sim: Sim): Alert[] {
  const s = sim.s, g = s.gov;
  const out: Alert[] = [];
  if (s.meta.condition === 'empty' && s.citizens.length < 1500) {
    for (const st of foundingSteps(sim).filter((x) => !x.done).slice(0, 3)) out.push({ sev: 1, text: `Founding: ${st.text.toLowerCase()}`, hint: st.hint });
  }
  const st = s.stats.months[s.stats.months.length - 1];
  const spend = Math.max(1, sumExp(g.last));
  if (g.arrears > 0) out.push({ sev: 3, text: 'The treasury cannot pay its bills', hint: 'Raise revenue or cut spending; lenders will not lend more at this debt level.', tab: 'budget' });
  else if (g.cash < spend) out.push({ sev: 2, text: `Treasury covers less than a month of spending (${fmtMoney(sim, g.cash)})`, hint: 'The city will borrow once cash runs out.', tab: 'budget' });
  const ms = s.stats.months.slice(-3);
  if (ms.length === 3 && ms.every((m) => m.balance < 0)) out.push({ sev: 2, text: 'Three months of deficits in a row', hint: `Last month: revenue ${fmtMoney(sim, sumRev(g.last))}, spending ${fmtMoney(sim, sumExp(g.last))}.`, tab: 'budget' });
  if (st) {
    if (st.unemployment > 0.12) out.push({ sev: 2, text: `Unemployment is ${(st.unemployment * 100).toFixed(1)}%`, hint: 'People out of work for months start leaving the city.', tab: 'overview' });
    if (st.foodInsecure > 0.1) out.push({ sev: 2, text: `${Math.round(st.foodInsecure * 100)}% of households cannot buy enough food`, hint: 'Poverty, food prices or empty shelves. See the food explanation on the overview.', tab: 'overview' });
    if (st.homeless > s.households.length * 0.03) out.push({ sev: 2, text: `${st.homeless} families have no home of their own`, hint: 'Rezone land for housing, build public housing or make sure rents are affordable.', tab: 'overview' });
    if (st.poorRoads > 0.2) out.push({ sev: 1, text: `${Math.round(st.poorRoads * 100)}% of roads are in poor condition`, hint: 'Raise transport funding to catch up on repairs.', tab: 'budget' });
  }
  for (const d of DEPTS) if (g.deptFunding[d] < 0.9) out.push({ sev: 1, text: `${DEPT_LABELS[d]} is running at ${Math.round(g.deptFunding[d] * 100)}% funding`, hint: 'Staff are laid off and service quality falls below 90%.', tab: 'budget' });
  for (const p of s.projects) if (p.gov && p.issue && (p.issues[p.issue] ?? 0) >= 10) out.push({ sev: 1, text: `${p.name} is held up: ${p.issue.toLowerCase()}`, hint: `${p.issues[p.issue]} days lost so far.`, ref: { k: 'project', id: p.id }, tab: 'projects' });
  const w = s.weather;
  if (w.drought) out.push({ sev: 2, text: 'Drought: rain-fed crops are failing', hint: 'Canals and wells protect farms; crop insurance cushions farm incomes.', tab: 'policies' });
  if (w.pandemic > 0) out.push({ sev: 3, text: `Epidemic under way (${w.pandemic} more days expected)`, hint: 'Healthcare coverage determines how many people fall seriously ill.', tab: 'budget' });
  if (g.approval < 0.4) out.push({ sev: 2, text: `Approval has fallen to ${Math.round(g.approval * 100)}%`, hint: 'See what residents are unhappy about on the overview.', tab: 'overview' });
  for (const p of g.pending) if (p.day - sim.day <= 7 && p.day >= sim.day) out.push({ sev: 1, text: `${p.label} in ${Math.max(0, p.day - sim.day)} days`, hint: 'Announced change about to take effect.', tab: p.kind === 'tax' ? 'taxes' : 'policies' });
  out.push(...tradeAlerts(sim), ...visitorAlerts(sim));
  return out.sort((a, b) => b.sev - a.sev).slice(0, 10);
}

function tradeAlerts(sim: Sim): Alert[] {
  const s = sim.s, out: Alert[] = [];
  for (const p of s.trade.partners) {
    if (p.dispute > 0) out.push({ sev: 2, text: `${p.name} has punitive tariffs on our manufactured goods`, hint: `About ${Math.max(1, Math.round(p.dispute / 30))} more months. Exporters must sell elsewhere for less; disputes are rarer under an agreement.`, tab: 'trade' });
    const left = p.due - sim.day;
    if (p.status === 'talks' && left >= 0 && left <= 14) out.push({ sev: 1, text: `Trade talks with ${p.name} conclude in ${left} days`, hint: 'An agreement removes tariffs on manufactures both ways and halves those on farm goods.', tab: 'trade' });
    if (p.status === 'leaving' && left >= 0 && left <= 14) out.push({ sev: 1, text: `The trade agreement with ${p.name} ends in ${left} days`, hint: 'Tariffs return in both directions.', tab: 'trade' });
  }
  const ms = s.stats.months;
  if (ms.length >= 4) {
    const d = s.trade.fx / ms[ms.length - 4].fx - 1;
    if (Math.abs(d) >= 0.08) {
      out.push({
        sev: 1, text: `The ${sim.preset.currencyCode} has ${d > 0 ? 'fallen' : 'risen'} ${Math.round(Math.abs(d) * 100)}% in three months`,
        hint: d > 0 ? 'Imports and fuel cost more; exporters, tech firms and foreign visitors gain.' : 'Imports and fuel are cheaper; exporters earn less and the city is dearer for visitors.', tab: 'trade',
      });
    }
  }
  const g = s.gov, spend = sumExp(g.last);
  if (g.policies.msp > 0 && spend > 0 && g.last.exp.procurement > spend * 0.12) {
    out.push({ sev: 1, text: `Grain purchases took ${Math.round((g.last.exp.procurement / spend) * 100)}% of spending last month`, hint: 'The support price beats what markets pay, so farmers sell to the state. Surplus stock is sold abroad at a loss.', tab: 'policies' });
  }
  return out;
}

function visitorAlerts(sim: Sim): Alert[] {
  const s = sim.s, out: Alert[] = [];
  const st = s.stats.months[s.stats.months.length - 1];
  if (st) {
    const overnight = st.tourists - s.tourism.last.dayTrips;
    if (st.turnedAway > 60 && overnight > 0 && st.turnedAway / overnight > 0.15) {
      out.push({ sev: 1, text: `Hotels turned away ${Math.round(st.turnedAway).toLocaleString('en-US')} visitors last month`, hint: 'Hotel investors build on commercial land when rooms are full; visitors who find no room tell others.', tab: 'tourism' });
    }
    if (st.leisure < 0.3 && s.citizens.length > 500) out.push({ sev: 1, text: 'Residents have few places to go out', hint: 'Cinemas open on commercial land where there is demand; museums, a stadium and parks are built by the city.', tab: 'tourism' });
  }
  let empty: { dest: string; load: number } | null = null;
  for (const r of s.air.routes) {
    if (r.lastSeats <= 0 || sim.day - r.since < 90) continue;
    const load = r.lastPax / r.lastSeats;
    if (load < 0.4 && (!empty || load < empty.load)) empty = { dest: r.dest, load };
  }
  if (empty) out.push({ sev: 1, text: `Flights to ${empty.dest} were only ${Math.round(empty.load * 100)}% full last month`, hint: 'Airlines cut flights that stay empty. Promotion, attractions and hotel rooms bring more passengers.', tab: 'tourism' });
  let worst: Building | null = null;
  for (const b of s.buildings) if (b.kind === 'heritage' && b.condition < 0.45 && (!worst || b.condition < worst.condition)) worst = b;
  if (worst) out.push({ sev: 1, text: `${worst.name || 'A heritage site'} is falling into disrepair (${Math.round(worst.condition * 100)}%)`, hint: 'Funding culture at full service or above conserves heritage sites; visitors notice their state.', ref: { k: 'building', id: worst.id }, tab: 'budget' });
  return out;
}
