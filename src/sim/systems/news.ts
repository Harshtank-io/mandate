// City news. Every story is generated from simulation events or measured changes, and carries its causes.

import { dateOf, MONTHS_LONG } from '../calendar';
import type { Sim } from '../core';
import { CROPS } from '../tables';
import type { NewsItem, SimEvent } from '../types';

const TAGS: [string, NewsItem['tag']][] = [
  ['weather', 'weather'], ['world', 'economy'], ['business', 'business'], ['investment', 'business'], ['project', 'development'],
  ['gov', 'government'], ['tax', 'government'], ['policy', 'government'], ['migration', 'society'], ['housing', 'society'],
  ['farm', 'agriculture'], ['health', 'society'], ['milestone', 'milestone'], ['env', 'environment'],
  ['tourism', 'tourism'], ['air', 'tourism'], ['leisure', 'society'], ['trade', 'trade'], ['food', 'agriculture'],
  ['utility', 'development'], ['fire', 'society'],
];
const ALWAYS = new Set(['project.completed', 'project.phase', 'business.planned', 'migration.in', 'world.fx', 'air.more', 'air.fewer', 'leisure.event', 'food.procured', 'food.stockSale']);

function tagOf(type: string): NewsItem['tag'] {
  for (const [p, t] of TAGS) if (type.startsWith(p)) return t;
  return 'economy';
}

function headlineFor(e: SimEvent): string | undefined {
  switch (e.type) {
    case 'weather.drought': return 'Drought grips the region';
    case 'weather.flood': return 'Floods swamp low-lying farms and roads';
    case 'weather.heat': return 'Heatwave bakes the city';
    case 'world.recession': return 'Global recession hits export demand';
    case 'world.boom': return 'Global upswing lifts export demand';
    case 'world.fuel': return e.text.includes('spike') ? 'Oil price shock drives up fuel costs' : 'Oil prices slump';
    case 'health.pandemic': return 'Epidemic reaches the city';
    default: return undefined;
  }
}

export function pushNews(sim: Sim, n: Omit<NewsItem, 'id' | 'day'>): NewsItem {
  const item: NewsItem = { id: sim.newId(), day: sim.day, ...n };
  sim.s.news.push(item);
  if (sim.s.news.length > 250) sim.s.news.splice(0, sim.s.news.length - 250);
  return item;
}

function whyOf(sim: Sim, e: SimEvent): string[] {
  const why = [...(e.why ?? [])];
  for (const id of e.causes ?? []) {
    const c = sim.findEvent(id);
    if (c) why.push(`${c.text} (${dayLabel(sim, c.day)})`);
  }
  return why;
}

function dayLabel(sim: Sim, day: number): string {
  const d = new Date(Date.UTC(sim.s.meta.startYear, 0, 1 + day));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function onEventNews(sim: Sim, e: SimEvent): void {
  if (e.sev < 2 && !ALWAYS.has(e.type)) return;
  const dot = e.text.indexOf('. ');
  const first = dot > 0 ? e.text.slice(0, dot) : e.text.replace(/\.$/, '');
  const rest = dot > 0 ? e.text.slice(dot + 2) : '';
  pushNews(sim, { tag: tagOf(e.type), headline: headlineFor(e) ?? first, body: headlineFor(e) ? e.text : rest, why: whyOf(sim, e), eventId: e.id, ref: e.ref });
}

function recentNews(sim: Sim, key: string, days: number): boolean {
  const n = sim.s.news;
  for (let i = n.length - 1; i >= 0 && sim.day - n[i].day <= days; i--) if (n[i].headline.includes(key)) return true;
  return false;
}

function priceWatch(sim: Sim, good: 'food' | 'vegetables', threshold: number, label: string): void {
  const s = sim.s;
  const hist = s.market[good].hist;
  if (hist.length < 35) return;
  const now = hist[hist.length - 1], then = hist[hist.length - 31];
  const d = now / then - 1;
  if (Math.abs(d) < threshold || recentNews(sim, `${label} prices`, 25)) return;
  const up = d > 0;
  const why: string[] = [];
  const causes: SimEvent[] = [];
  for (const t of ['weather.drought', 'weather.flood', 'farm.disease', 'world.price', 'world.fuel', 'tax.changed', 'policy.changed']) {
    const e = sim.recentEvent(t, t.startsWith('weather') || t === 'farm.disease' ? 150 : 60);
    if (!e) continue;
    if (t === 'world.price' && !/wheat|rice|maize|vegetable/i.test(e.text)) continue;
    if ((t === 'tax.changed' || t === 'policy.changed') && !/tariff|fuel|food|export/i.test(e.text)) continue;
    causes.push(e);
  }
  const grains = (['wheat', 'rice', 'maize'] as const).map((g) => s.market[g]);
  const imp = grains.reduce((a, m) => a + m.lastImported, 0), loc = grains.reduce((a, m) => a + m.lastLocal, 0), exp = grains.reduce((a, m) => a + m.lastExported, 0);
  if (good === 'food') {
    if (imp > loc * 0.3) why.push(`Local grain covered only ${Math.round((loc / Math.max(1, loc + imp)) * 100)}% of mills' needs last month; the rest was imported at world price plus tariff and freight`);
    else if (exp > loc * 0.5) why.push('Local grain is plentiful: surplus is being exported, holding wholesale prices near export parity');
    why.push(s.market.food.lastWhy);
  } else {
    why.push(s.market.vegetables.lastWhy);
  }
  for (const e of causes) why.push(`${e.text} (${dayLabel(sim, e.day)})`);
  // severity 1 so the event listener does not publish a duplicate story; the item below carries it
  const e = sim.emit('price.change', `${label} prices ${up ? 'rise' : 'fall'} ${Math.round(Math.abs(d) * 100)}% in a month.`, 1, undefined, causes.map((c) => c.id), why);
  pushNews(sim, { tag: 'economy', headline: `${label} prices ${up ? 'rise' : 'fall'} ${Math.round(Math.abs(d) * 100)}% in a month`, body: `Wholesale ${good === 'food' ? 'packaged food' : 'vegetable'} prices moved from ${Math.round(then)} to ${Math.round(now)} per tonne; shop prices follow.`, why, eventId: e.id });
}

export function newsDaily(sim: Sim): void {
  if (sim.day % 7 !== 3) return;
  priceWatch(sim, 'food', 0.06, 'Food');
  priceWatch(sim, 'vegetables', 0.18, 'Vegetable');
}

/** Harvest reports need last month's accumulators, so this runs before the stats roll-over. */
export function harvestReport(sim: Sim): void {
  const acc = sim.s.stats.acc;
  // runs on the 1st, so the figures belong to the month that just ended; name it so they can't be mistaken for other periods
  const month = MONTHS_LONG[dateOf(sim.s.meta.startYear, sim.day - 1).month];
  for (const [crop, t] of Object.entries(acc.harvest)) {
    const normal = acc.harvestNormal[crop] ?? 0;
    if (t < 15 || normal <= 0) continue;
    const gap = 1 - t / normal;
    const label = CROPS[crop as keyof typeof CROPS]?.label ?? crop;
    const noun = crop === 'vegetables' ? 'vegetable' : label.toLowerCase();
    const causes = Object.entries(acc.harvestLoss).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > normal * 0.03);
    const names: Record<string, string> = {
      water: 'dry spells', drought: 'the drought', flood: 'flooding and waterlogging', heat: 'heat', heatwave: 'the heatwave', cold: 'cold',
      disease: 'crop disease', labour: 'labour shortages at harvest',
    };
    const why = causes.slice(0, 3).map(([k, v]) => `${Math.round(v)} t lost to ${names[k] ?? k}`);
    const ev = gap > 0.15 ? sim.recentEvent('weather.drought', 200) ?? sim.recentEvent('weather.flood', 200) ?? sim.recentEvent('farm.disease', 200) : undefined;
    if (ev) why.push(`${ev.text} (${dayLabel(sim, ev.day)})`);
    const headline = gap > 0.15 ? `${month} ${noun} harvest ${Math.round(gap * 100)}% below its potential` : gap < 0.06 ? `Strong ${month} ${noun} harvest: ${Math.round(t)} t brought in` : `${month} ${noun} harvest: ${Math.round(t)} t brought in`;
    pushNews(sim, { tag: 'agriculture', headline, body: `Farms harvested ${Math.round(t)} t of ${label.toLowerCase()} in ${month} against a potential of ${Math.round(normal)} t.`, why, eventId: ev?.id ?? -1 });
  }
}

export function newsMonthly(sim: Sim): void {
  const m = sim.s.stats.months;
  if (m.length < 4) return;
  const now = m[m.length - 1], q = m[m.length - 4];
  const du = now.unemployment - q.unemployment;
  if (Math.abs(du) >= 0.01 && !recentNews(sim, 'Unemployment', 80)) {
    const why: string[] = [];
    const closures = sim.s.events.filter((e) => (e.type === 'business.closed' || e.type === 'business.layoffs' || e.type === 'gov.cuts') && sim.day - e.day < 95);
    const openings = sim.s.events.filter((e) => (e.type === 'business.opened' || e.type === 'project.opened') && sim.day - e.day < 95);
    if (du > 0 && closures.length) why.push(...closures.slice(-3).map((e) => e.text));
    if (du < 0 && openings.length) why.push(...openings.slice(-3).map((e) => e.text));
    why.push(`${now.vacancies} vacancies and ${now.unemployed} job seekers`);
    if (now.immigrants > 30) why.push(`${now.immigrants} newcomers arrived last month`);
    pushNews(sim, { tag: 'economy', headline: `Unemployment ${du > 0 ? 'rises' : 'falls'} to ${(now.unemployment * 100).toFixed(1)}%`, body: `Three months ago it was ${(q.unemployment * 100).toFixed(1)}%.`, why, eventId: -1 });
  }
  if (now.inflation > 0.08 && !recentNews(sim, 'Inflation', 170)) {
    pushNews(sim, { tag: 'economy', headline: `Inflation reaches ${(now.inflation * 100).toFixed(1)}%`, body: 'The cost of the typical household basket (food, goods, rent, meals and fuel) is rising quickly.', why: [sim.s.market.food.lastWhy], eventId: -1 });
  }
  if (m.length >= 13) {
    const y = m[m.length - 13];
    const dr = now.rentIndex / y.rentIndex - 1;
    if (dr > 0.1 && !recentNews(sim, 'Rents', 170)) {
      const why = [`Only ${(100 * now.vacantUnits / Math.max(1, now.units)).toFixed(1)}% of homes are vacant`, `${now.homeless} families have no home of their own`];
      const e = sim.recentEvent('housing.noLand', 200) ?? sim.recentEvent('housing.unprofitable', 200);
      if (e) why.push(e.text);
      pushNews(sim, { tag: 'society', headline: `Rents up ${Math.round(dr * 100)}% in a year`, body: 'Housing demand is outpacing new construction.', why, eventId: e?.id ?? -1 });
    }
  }
  const maxCong = Math.max(...m.slice(0, -1).map((x) => x.congestion));
  if (now.congestion > 1.25 && now.congestion > maxCong * 1.03 && !recentNews(sim, 'Traffic', 120)) {
    pushNews(sim, { tag: 'society', headline: 'Traffic congestion reaches record levels', body: `Average commute is now ${Math.round(now.commute)} minutes.`, why: [`Population ${now.population}`, 'More households own cars and two-wheelers as incomes rise', 'Road capacity has not kept pace'], eventId: -1 });
  }
  if (m.slice(-3).every((x) => x.balance < 0) && !recentNews(sim, 'deficit', 170)) {
    pushNews(sim, { tag: 'government', headline: 'Government runs a deficit for the third month in a row', body: `Debt now stands at ${Math.round(now.debt).toLocaleString()}.`, why: ['Spending exceeds tax revenue; the gap is being borrowed', 'Interest on the debt will squeeze future budgets'], eventId: -1 });
  }
}
