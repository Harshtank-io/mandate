// Sidebar panels: the government dashboard and the levers of government.

import { useEffect, useState } from 'preact/hooks';
import type { Sim } from '../sim/core';
import type { Game } from '../game/game';
import type { Selection } from '../render/view';
import { alerts } from '../sim/summary';
import { explain, projectProgress, REV_LABELS, type MetricKey, type Ref } from '../sim/inspect';
import {
  announcePolicy, announceTax, cancel, cofundShare, describeValue, leaveAgreement, openTalks, policyEffects, policyRange, setFunding, taxEffects, taxRange,
  type CommandResult,
} from '../sim/commands';
import { DEPT_LABELS, POLICY_DELAY, POLICY_LABELS, TAX_LABELS } from '../sim/systems/government';
import { milestonesFor } from '../sim/systems/milestones';
import { DISPUTE_TARIFF, exportDest, importSource, ourTariff, theirTariff } from '../sim/systems/trade';
import { airportOf, projectedPassengers } from '../sim/systems/aviation';
import { roomRate } from '../sim/systems/tourism';
import { MONTHS_LONG } from '../sim/calendar';
import { OFFLINE_CAPS, PACES, getPreset } from '../sim/presets';
import { AIRPORT_MIN_DEMAND, GOOD_SPECS, PROMOTION_COST } from '../sim/tables';
import { DEPTS, GOODS, GRAINS, type BuildingKind, type Good, type MonthStats, type Policies, type RevCat, type TaxSettings, type TradePartner } from '../sim/types';
import { deleteSave, listSaves, type SaveMeta } from '../game/persist';
import { activeSync } from '../net/sync';
import { CloudSection } from './account';
import { Bars, Chart, dayLabel, money, num, pct, realSpan, SectionView, Spark } from './util';

export type Tab = 'overview' | 'budget' | 'taxes' | 'policies' | 'trade' | 'tourism' | 'projects' | 'news' | 'milestones' | 'saves';

export interface Ctx {
  game: Game;
  sim: Sim;
  select(sel: Selection | null): void;
  openRef(ref: Ref): void;
  toast(text: string, tone?: 'good' | 'bad'): void;
  setTab(t: Tab): void;
  /** Picks up the build tool for a facility, as if chosen from the Build menu. */
  build(kind: BuildingKind): void;
  menu(): void;
  loadSave(key: string): void;
  exportWorld(): void;
  importWorld(): void;
}

function monthLabels(sim: Sim, ms: MonthStats[]): string[] {
  return ms.map((m) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m.month]} ${m.year}`);
}

// ------------------------------------------------------------------------------------------------ overview

interface Item { label: string; value: string; spark?: number[]; tone?: 'good' | 'bad' }
interface Group { title: string; key: MetricKey; items: Item[] }

export function Overview({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const [open, setOpen] = useState<MetricKey | null>(null);
  const ms = sim.s.stats.months;
  const st = ms[ms.length - 1];
  if (!st) return <p class="muted">Statistics appear after the first month.</p>;
  const hist = (k: keyof MonthStats, n = 24) => ms.slice(-n).map((m) => m[k] as number);
  const gdp12 = ms.slice(-12).reduce((a, m) => a + m.gdp, 0);
  const prev12 = ms.length >= 25 ? ms.slice(-24, -12).reduce((a, m) => a + m.gdp, 0) : 0;
  const cpiPrev = ms[Math.max(0, ms.length - 13)].cpi;
  const growth = prev12 > 0 ? gdp12 / prev12 / (st.cpi / cpiPrev) - 1 : null;
  const g = sim.s.gov;
  const groups: Group[] = [
    { title: 'Economy', key: 'unemployment', items: [
      { label: 'Output, last 12 months', value: money(sim, gdp12), spark: hist('gdp') },
      { label: 'Real growth', value: growth === null ? 'needs 2 years of data' : pct(growth, 1), tone: growth === null ? undefined : growth >= 0 ? 'good' : 'bad' },
      { label: 'Inflation', value: pct(st.inflation, 1), spark: hist('cpi'), tone: st.inflation > 0.08 ? 'bad' : undefined },
      { label: 'Unemployment', value: pct(st.unemployment, 1), spark: hist('unemployment'), tone: st.unemployment > 0.1 ? 'bad' : st.unemployment < 0.05 ? 'good' : undefined },
      { label: 'Average wage', value: `${money(sim, st.avgWage)}/mo`, spark: hist('avgWage') },
      { label: 'Median household income', value: `${money(sim, st.medianIncome)}/mo` },
      { label: 'Businesses', value: `${num(st.businesses)} (${st.opened} opened, ${st.closed} closed last month)` },
    ] },
    { title: 'Public finances', key: 'budget', items: [
      { label: 'Revenue last month', value: money(sim, st.revenue), spark: hist('revenue') },
      { label: 'Spending last month', value: money(sim, st.spending), spark: hist('spending') },
      { label: 'Balance', value: money(sim, st.balance), tone: st.balance >= 0 ? 'good' : 'bad' },
      { label: 'Treasury', value: money(sim, g.cash), tone: g.cash < 0 ? 'bad' : undefined },
      { label: 'Debt', value: `${money(sim, g.debt)} · rated ${g.rating}`, spark: hist('debt') },
    ] },
    { title: 'Population', key: 'population', items: [
      { label: 'Residents', value: num(st.population), spark: hist('population') },
      { label: 'Births / deaths last month', value: `${st.births} / ${st.deaths}` },
      { label: 'Moved in / out last month', value: `${st.immigrants} / ${st.emigrants}`, tone: st.emigrants > st.immigrants * 1.5 && st.emigrants > 10 ? 'bad' : undefined },
      { label: 'Working / retired / in school', value: `${num(st.working)} / ${num(st.retired)} / ${num(st.students)}` },
    ] },
    { title: 'Housing', key: 'housing', items: [
      { label: 'Empty homes', value: pct(st.vacantUnits / Math.max(1, st.units), 1) },
      { label: 'Families without a home', value: num(st.homeless), tone: st.homeless > st.households * 0.03 ? 'bad' : undefined },
      { label: 'Rent index', value: num(st.rentIndex * 100), spark: hist('rentIndex') },
      { label: 'Median rent burden', value: pct(st.rentBurden), tone: st.rentBurden > 0.35 ? 'bad' : undefined },
    ] },
    { title: 'Food', key: 'food', items: [
      { label: 'Staple food in shops', value: `${money(sim, st.foodPrice)}/kg`, spark: hist('foodPrice') },
      { label: 'Households short of food', value: pct(st.foodInsecure), tone: st.foodInsecure > 0.1 ? 'bad' : undefined },
    ] },
    { title: 'Farming', key: 'agriculture', items: [
      { label: 'Harvest last month', value: `${num(st.farmOutput)} t`, spark: hist('farmOutput') },
      { label: 'Farms', value: num(sim.s.businesses.filter((b) => b.farm).length) },
    ] },
    { title: 'Society', key: 'satisfaction', items: [
      { label: 'Satisfaction', value: pct(st.satisfaction), spark: hist('satisfaction'), tone: st.satisfaction < 0.45 ? 'bad' : st.satisfaction > 0.7 ? 'good' : undefined },
      { label: 'Crime index', value: (st.crime * 100).toFixed(1), spark: hist('crime') },
      { label: 'Police coverage', value: pct(st.policeCoverage) },
    ] },
    { title: 'Health', key: 'health', items: [
      { label: 'Life expectancy', value: `${st.lifeExp.toFixed(1)} years`, spark: hist('lifeExp') },
      { label: 'Within reach of healthcare', value: pct(st.healthCoverage), tone: st.healthCoverage < 0.6 ? 'bad' : undefined },
      { label: 'Average health', value: pct(st.health) },
    ] },
    { title: 'Education', key: 'education', items: [
      { label: 'Children in school', value: pct(st.enrollment), tone: st.enrollment < 0.85 ? 'bad' : undefined },
      { label: 'Adult literacy', value: pct(st.literacy), spark: hist('literacy') },
      { label: 'Adults with a diploma or degree', value: pct(st.tertiary) },
    ] },
    { title: 'Transport', key: 'traffic', items: [
      { label: 'Average commute', value: `${Math.round(st.commute)} min`, spark: hist('commute') },
      { label: 'Congestion (delay factor)', value: st.congestion.toFixed(2), tone: st.congestion > 1.3 ? 'bad' : undefined },
      { label: 'Roads', value: `${st.roadKm.toFixed(1)} km, ${pct(st.poorRoads)} in poor condition` },
    ] },
    { title: 'Environment', key: 'environment', items: [
      { label: 'Air pollution where people live', value: (st.pollution * 100).toFixed(0), spark: hist('pollution'), tone: st.pollution > 0.2 ? 'bad' : undefined },
      { label: 'CO₂ last month', value: `${num(st.co2)} t`, spark: hist('co2') },
      { label: 'Water quality', value: pct(st.water) },
      { label: 'Green cover', value: pct(st.green) },
    ] },
  ];
  const al = alerts(sim);
  return (
    <div class="panel-body">
      {al.length > 0 && (
        <section class="attention">
          <h3>Needs your attention</h3>
          <ul>
            {al.map((a, i) => (
              <li key={i} class={`sev${a.sev}`}>
                <button class="link" onClick={() => (a.ref ? ctx.openRef(a.ref) : a.tab ? ctx.setTab(a.tab as Tab) : undefined)}>{a.text}</button>
                <p class="muted">{a.hint}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.map((gr) => (
        <section class="metric-group" key={gr.title}>
          <header>
            <h3>{gr.title}</h3>
            <button class="ghost small" aria-expanded={open === gr.key} onClick={() => setOpen(open === gr.key ? null : gr.key)}>{open === gr.key ? 'Hide' : 'Why?'}</button>
          </header>
          <ul class="metrics">
            {gr.items.map((it) => (
              <li key={it.label}>
                <span class="metric-label">{it.label}</span>
                <span class={`metric-value ${it.tone ?? ''}`}>{it.value}</span>
                {it.spark && <Spark values={it.spark} />}
              </li>
            ))}
          </ul>
          {open === gr.key && <div class="explain">{explain(sim, gr.key).map((s, i) => <SectionView key={i} s={s} onLink={ctx.openRef} />)}</div>}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ budget

export function Budget({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const g = sim.s.gov;
  const [draft, setDraft] = useState<Record<string, number>>({});
  const ms = sim.s.stats.months.slice(-36);
  const apply = (d: (typeof DEPTS)[number], v: number) => {
    const r = setFunding(sim, d, v / 100);
    ctx.toast(r.ok ? r.message : r.error, r.ok ? undefined : 'bad');
    setDraft((x) => { const n = { ...x }; delete n[d]; return n; });
  };
  return (
    <div class="panel-body">
      <section>
        <h3>Treasury</h3>
        <dl class="rows">
          <div><dt>Cash</dt><dd class={g.cash < 0 ? 'bad' : ''}>{money(sim, g.cash)}</dd></div>
          <div><dt>Debt</dt><dd>{money(sim, g.debt)} at {pct(g.rate, 1)} · rated {g.rating}</dd></div>
          <div><dt>Revenue this year</dt><dd>{money(sim, Object.values(g.ytd.rev).reduce((a, x) => a + x, 0))}</dd></div>
          <div><dt>Spending this year</dt><dd>{money(sim, Object.values(g.ytd.exp).reduce((a, x) => a + x, 0))}</dd></div>
        </dl>
        <Chart series={[{ label: 'Revenue', values: ms.map((m) => m.revenue), color: '#7fd18b' }, { label: 'Spending', values: ms.map((m) => m.spending), color: '#f08a6c' }]}
          fmt={(v) => money(sim, v)} labels={monthLabels(sim, ms)} />
      </section>
      <section>
        <h3>Department funding</h3>
        <p class="muted">Share of each department's full-service cost it receives every month. Below 90% staff are laid off; above 100% buys extra operations such as faster road repair.</p>
        {DEPTS.map((d) => {
          const v = draft[d] ?? Math.round(g.level[d] * 100);
          return (
            <div class="setting" key={d}>
              <div class="setting-head">
                <label for={`dept-${d}`}>{DEPT_LABELS[d]}</label>
                <output class={v < 90 ? 'bad' : ''}>{v}%</output>
              </div>
              <input id={`dept-${d}`} type="range" min={30} max={150} step={5} value={v}
                onInput={(e) => setDraft((x) => ({ ...x, [d]: Number((e.currentTarget as HTMLInputElement).value) }))}
                onChange={(e) => apply(d, Number((e.currentTarget as HTMLInputElement).value))} />
              <p class="muted small">Full service {money(sim, g.deptNeed[d])}/mo · spent last month {money(sim, g.deptSpend[d])} · effective {pct(g.deptFunding[d])}</p>
            </div>
          );
        })}
      </section>
      {explain(sim, 'budget').map((s, i) => <SectionView key={i} s={s} onLink={ctx.openRef} />)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ taxes

const TAX_GROUPS: [string, (keyof TaxSettings)[]][] = [
  ['Income', ['income', 'incomeTop', 'allowance', 'topThreshold']],
  ['Business', ['corporate', 'smallBusiness', 'licenseFee']],
  ['Spending', ['sales', 'foodSales', 'luxury', 'fuel']],
  ['Property & farming', ['property', 'agriculture']],
  ['Trade', ['import', 'importFood', 'export']],
  ['Tourism & leisure', ['tourism', 'entertainment', 'passengerFee']],
];
const TAX_REV: Record<keyof TaxSettings, RevCat> = {
  income: 'incomeTax', incomeTop: 'incomeTax', allowance: 'incomeTax', topThreshold: 'incomeTax', corporate: 'corporateTax', smallBusiness: 'smallBizTax',
  sales: 'salesTax', foodSales: 'foodTax', luxury: 'luxuryTax', fuel: 'fuelTax', property: 'propertyTax', agriculture: 'agriTax', import: 'importTariff',
  importFood: 'importTariff', export: 'exportTax', licenseFee: 'licenseFees', tourism: 'tourismTax', entertainment: 'entertainmentTax', passengerFee: 'airportFees',
};

export function Taxes({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const g = sim.s.gov;
  const [draft, setDraft] = useState<Partial<Record<keyof TaxSettings, number>>>({});
  const announce = (k: keyof TaxSettings, v: number) => {
    const r = announceTax(sim, k, v);
    ctx.toast(r.ok ? r.message : r.error, r.ok ? undefined : 'bad');
    if (r.ok) setDraft((x) => { const n = { ...x }; delete n[k]; return n; });
  };
  return (
    <div class="panel-body">
      <p class="muted">Changes are announced now and take effect on the first day of next month. Every tax works through the economy: see the notes under each change.</p>
      {TAX_GROUPS.map(([title, keys]) => (
        <section key={title}>
          <h3>{title}</h3>
          {keys.map((k) => {
            const [lo, hi, step] = taxRange(sim, k);
            const cur = g.taxes[k];
            const v = draft[k] ?? cur;
            const pending = g.pending.find((p) => p.kind === 'tax' && p.key === k);
            const changed = Math.abs(v - cur) > step / 10;
            const rev = TAX_REV[k];
            return (
              <div class="setting" key={k}>
                <div class="setting-head">
                  <label for={`tax-${k}`}>{TAX_LABELS[k]}</label>
                  <output>{describeValue(sim, k, v)}</output>
                </div>
                <input id={`tax-${k}`} type="range" min={lo} max={hi} step={step} value={v}
                  onInput={(e) => setDraft((x) => ({ ...x, [k]: Number((e.currentTarget as HTMLInputElement).value) }))} />
                <p class="muted small">{REV_LABELS[rev]} raised {money(sim, g.last.rev[rev])} last month</p>
                {pending && <p class="pending">Scheduled: {describeValue(sim, k, pending.value)} from {dayLabel(sim, pending.day)}</p>}
                {changed && (
                  <div class="change">
                    <ul class="effects">{taxEffects(k, v > cur).map((t) => <li key={t}>{t}</li>)}</ul>
                    <div class="buttons">
                      <button class="primary" onClick={() => announce(k, v)}>Announce {describeValue(sim, k, v)}</button>
                      <button class="ghost" onClick={() => setDraft((x) => { const n = { ...x }; delete n[k]; return n; })}>Reset</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ policies

const POLICY_GROUPS: [string, (keyof Policies)[]][] = [
  ['Work & welfare', ['minWage', 'unemploymentBenefit', 'pension', 'retirementAge', 'povertyTransfer']],
  ['Food security', ['msp', 'rationShops', 'grainExportBan']],
  ['Farming', ['fertilizerSubsidy', 'cropInsurance']],
  ['Investment & trade', ['investmentIncentive', 'exportIncentive']],
  ['Tourism & culture', ['tourismPromotion', 'festival']],
  ['Regulation', ['businessRegulation', 'environmentalRegulation', 'rentControl']],
  ['Transport', ['busService']],
];
const LEVEL_NAMES: Partial<Record<keyof Policies, string[]>> = {
  businessRegulation: ['Light', 'Standard', 'Strict'], environmentalRegulation: ['Light', 'Standard', 'Strict'], busService: ['None', 'Basic', 'Extensive'],
  investmentIncentive: ['None', 'Tax holiday', 'Special zone'], tourismPromotion: ['None', 'Regional', 'National', 'International'], festival: ['None', 'Local', 'Grand'],
};

export function PoliciesPanel({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const g = sim.s.gov;
  const [draft, setDraft] = useState<Partial<Record<keyof Policies, number | boolean>>>({});
  const announce = (k: keyof Policies, v: number | boolean) => {
    const r = announcePolicy(sim, k, v);
    ctx.toast(r.ok ? r.message : r.error, r.ok ? undefined : 'bad');
    if (r.ok) setDraft((x) => { const n = { ...x }; delete n[k]; return n; });
  };
  const set = (k: keyof Policies, v: number | boolean) => setDraft((x) => ({ ...x, [k]: v }));
  return (
    <div class="panel-body">
      {POLICY_GROUPS.map(([title, keys]) => (
        <section key={title}>
          <h3>{title}</h3>
          {keys.map((k) => {
            const cur = g.policies[k];
            const v = draft[k] ?? cur;
            const pending = g.pending.find((p) => p.kind === 'policy' && p.key === k);
            const changed = v !== cur;
            const levels = LEVEL_NAMES[k];
            let control;
            if (typeof cur === 'boolean') {
              control = (
                <label class="switch">
                  <input type="checkbox" checked={v as boolean} onChange={(e) => set(k, (e.currentTarget as HTMLInputElement).checked)} />
                  <span>{v ? 'On' : 'Off'}</span>
                </label>
              );
            } else if (levels) {
              control = (
                <div class="segmented" role="radiogroup" aria-label={POLICY_LABELS[k]}>
                  {levels.map((name, i) => <button key={name} role="radio" aria-checked={v === i} class={v === i ? 'on' : ''} onClick={() => set(k, i)}>{name}</button>)}
                </div>
              );
            } else {
              const [lo, hi, step] = policyRange(sim, k);
              control = <input id={`pol-${k}`} type="range" min={lo} max={hi} step={step} value={v as number} onInput={(e) => set(k, Number((e.currentTarget as HTMLInputElement).value))} />;
            }
            return (
              <div class="setting" key={k}>
                <div class="setting-head">
                  <label for={`pol-${k}`}>{POLICY_LABELS[k]}</label>
                  <output>{describeValue(sim, k, v)}</output>
                </div>
                {control}
                <p class="muted small">{POLICY_DELAY[k] ? `Takes effect ${POLICY_DELAY[k]} days after it is announced` : 'Takes effect immediately'}</p>
                {pending && <p class="pending">Scheduled: {describeValue(sim, k, pending.value)} from {dayLabel(sim, pending.day)}</p>}
                {changed && (
                  <div class="change">
                    <ul class="effects">{policyEffects(k, v).map((t) => <li key={t}>{t}</li>)}</ul>
                    <div class="buttons">
                      <button class="primary" onClick={() => announce(k, v)}>Announce</button>
                      <button class="ghost" onClick={() => setDraft((x) => { const n = { ...x }; delete n[k]; return n; })}>Reset</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ trade

const TRADE_STATUS: Record<TradePartner['status'], string> = { none: 'No agreement', talks: 'In talks', agreement: 'Trade agreement', leaving: 'Leaving' };
const goodsList = (gs: Good[]) => gs.map((g) => GOOD_SPECS[g].label.toLowerCase()).join(', ') || '–';
const unitOf = (g: Good) => (GOOD_SPECS[g].unit === 't' ? 't' : GOOD_SPECS[g].unit);

function partnerStatus(sim: Sim, p: TradePartner): string {
  switch (p.status) {
    case 'talks': return `Talks began ${dayLabel(sim, p.statusDay)}; a result is expected around ${dayLabel(sim, p.due)}.`;
    case 'agreement': return p.statusDay < sim.s.meta.officeDay ? 'In force since before you took office.' : `In force since ${dayLabel(sim, p.statusDay)}.`;
    case 'leaving': return `Notice given: tariffs return on ${dayLabel(sim, p.due)}.`;
    default: return 'Trade runs on standard tariffs both ways.';
  }
}

export function TradePanel({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const s = sim.s, tr = s.trade, g = s.gov;
  const [confirm, setConfirm] = useState<string | null>(null);
  const all = s.stats.months;
  const st = all[all.length - 1];
  if (!st) return <p class="muted panel-body">Trade figures appear after the first month.</p>;
  const ms = all.slice(-24);
  const yearAgo = all[Math.max(0, all.length - 13)];
  const fxYear = yearAgo.fx > 0 ? tr.fx / yearAgo.fx - 1 : 0;
  const code = sim.preset.currencyCode, fxName = sim.preset.fxName;
  const coolOff = Math.max(0, 365 - (sim.day - tr.lastTalks));
  const run = (r: CommandResult) => { ctx.toast(r.ok ? r.message : r.error, r.ok ? 'good' : 'bad'); setConfirm(null); };
  const recentTrade = s.events.filter((e) => e.type.startsWith('trade.') || e.type === 'world.fx').slice(-6).reverse();
  const fxLine = Math.abs(fxYear) < 0.005 ? `The ${code} has held steady against the ${fxName} over the past year.`
    : fxYear > 0 ? `The ${code} has fallen about ${pct(fxYear, 1)} against the ${fxName} in a year: imports and fuel cost more, while exporters, tech firms and foreign visitors gain.`
      : `The ${code} has risen about ${pct(-fxYear, 1)} against the ${fxName} in a year: imports and fuel are cheaper, while exporters earn less and visitors find the city dearer.`;
  return (
    <div class="panel-body">
      <section>
        <h3>Trade balance</h3>
        <dl class="rows">
          <div><dt>Exports last month</dt><dd>{money(sim, st.exports)}</dd></div>
          <div><dt>Imports last month</dt><dd>{money(sim, st.imports)}</dd></div>
          <div><dt>Balance</dt><dd class={st.tradeBalance >= 0 ? 'good' : 'bad'}>{money(sim, st.tradeBalance)}</dd></div>
          <div><dt>Exchange rate index</dt><dd>{(tr.fx * 100).toFixed(1)} <span class="muted small">(100 when the world began)</span></dd></div>
        </dl>
        <p class="muted small">{fxLine}</p>
        <Chart series={[{ label: 'Exports', values: ms.map((m) => m.exports), color: '#7fd18b' }, { label: 'Imports', values: ms.map((m) => m.imports), color: '#f08a6c' }]}
          fmt={(v) => money(sim, v)} labels={monthLabels(sim, ms)} />
        <p class="muted small">Exports include what visitors spend here and services sold to clients elsewhere; imports include fuel.</p>
      </section>
      <section>
        <h3>Trading partners</h3>
        {tr.partners.map((p) => {
          const inForce = p.status === 'agreement' || p.status === 'leaving';
          return (
            <article class="partner" key={p.id}>
              <header><b>{p.name}</b><span class={`chip ${inForce ? 'on' : ''}`}>{TRADE_STATUS[p.status]}</span></header>
              {p.dispute > 0 && <p class="bad small">Trade dispute: {pct(DISPUTE_TARIFF)} punitive tariffs on our manufactured goods for about {Math.max(1, Math.round(p.dispute / 30))} more months</p>}
              <dl class="rows">
                <div><dt>They buy</dt><dd>{goodsList(p.buys)}</dd></div>
                <div><dt>They sell</dt><dd>{goodsList(p.sells)}</dd></div>
                <div><dt>Their tariffs on our goods</dt><dd>{pct(theirTariff(p, 'goods'))} manufactures · {pct(theirTariff(p, 'wheat'))} farm</dd></div>
                <div><dt>Our tariffs on theirs</dt><dd>{pct(ourTariff(sim, 'goods', p))} manufactures · {pct(ourTariff(sim, 'wheat', p))} farm</dd></div>
                <div><dt>Last month</dt><dd>exports {money(sim, p.lastExp)} · imports {money(sim, p.lastImp)}</dd></div>
              </dl>
              <p class="muted small">{partnerStatus(sim, p)}</p>
              {p.status === 'none' && (
                <div class="buttons wrap">
                  <button class="small" disabled={coolOff > 0} onClick={() => run(openTalks(sim, p.id))}>Open trade talks</button>
                  <span class="muted small">{coolOff > 0 ? `Partners will not reopen talks for another ${coolOff} days after the last ones collapsed.` : 'Talks take 9–17 months; about 7 in 10 end in an agreement.'}</span>
                </div>
              )}
              {(p.status === 'talks' || p.status === 'agreement') && (confirm === p.id ? (
                <div class="change">
                  <ul class="effects">
                    {p.status === 'talks'
                      ? <li>Talks end at once; nothing changes, and they can be reopened later</li>
                      : <><li>Tariffs return six months after notice is given</li><li>Local producers get protection back; exporters and importers lose tariff-free access</li></>}
                  </ul>
                  <div class="buttons">
                    <button class="danger small" onClick={() => run(leaveAgreement(sim, p.id))}>{p.status === 'talks' ? 'Break off talks' : 'Give notice'}</button>
                    <button class="ghost small" onClick={() => setConfirm(null)}>Keep</button>
                  </div>
                </div>
              ) : <button class="ghost small" onClick={() => setConfirm(p.id)}>{p.status === 'talks' ? 'Break off talks' : 'Leave the agreement'}</button>)}
            </article>
          );
        })}
      </section>
      <section>
        <h3>Goods</h3>
        <p class="muted small">Imports come from the cheapest source after tariffs and shipping; exports go to the best-paying market.</p>
        <ul class="goods">
          {GOODS.map((gd) => {
            const mk = s.market[gd];
            const src = importSource(sim, gd), dest = exportDest(sim, gd);
            const banned = g.policies.grainExportBan && GRAINS.includes(gd);
            return (
              <li key={gd}>
                <div class="goods-head"><b>{GOOD_SPECS[gd].label}</b><span class="muted small">{money(sim, mk.price)}/{unitOf(gd)} here · {money(sim, s.ext.prices[gd])} abroad</span></div>
                <p class="small">Last month: imported {num(mk.lastImported)} {unitOf(gd)} · exported {num(mk.lastExported)} {unitOf(gd)}</p>
                <p class="muted small">Cheapest from {src.p ? src.p.name : 'the world market'} ({pct(src.tariff)} tariff) · {banned ? 'exports banned' : `best market: ${dest.p ? dest.p.name : 'other markets'}`}</p>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h3>Levers</h3>
        <dl class="rows">
          {(['import', 'importFood', 'export'] as const).map((k) => <div key={k}><dt>{TAX_LABELS[k]}</dt><dd>{describeValue(sim, k, g.taxes[k])}</dd></div>)}
          {(['exportIncentive', 'grainExportBan', 'investmentIncentive'] as const).map((k) => <div key={k}><dt>{POLICY_LABELS[k]}</dt><dd>{describeValue(sim, k, g.policies[k])}</dd></div>)}
        </dl>
        <div class="buttons">
          <button class="small" onClick={() => ctx.setTab('taxes')}>Tariffs and export tax</button>
          <button class="small" onClick={() => ctx.setTab('policies')}>Trade and investment laws</button>
        </div>
      </section>
      {recentTrade.length > 0 && (
        <section>
          <h3>Recent</h3>
          <ul class="lines">{recentTrade.map((e) => <li key={e.id}><span class="muted small">{dayLabel(sim, e.day)}</span> {e.text}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ tourism & leisure

const ATTRACTION_LABELS: Record<string, string> = {
  heritage: 'Heritage sites', museum: 'Museums', stadium: 'Stadium', parks: 'Parks', nature: 'Countryside', river: 'River', food: 'Restaurants', cinema: 'Cinemas',
};

export function TourismPanel({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const s = sim.s, T = s.tourism, A = s.air, g = s.gov, pol = g.policies;
  const all = s.stats.months;
  const st = all[all.length - 1];
  if (!st) return <p class="muted panel-body">Visitor figures appear after the first month.</p>;
  const ms = all.slice(-24);
  const last = T.last;
  const overnight = Math.max(0, last.domestic + last.foreign - last.dayTrips);
  const turnedShare = overnight > 0 ? last.turned / overnight : 0;
  const nominal = sim.scale * s.ext.trend;
  const fest = sim.preset.tourism.festival;
  const parts = T.appealParts;
  const partSum = Object.keys(ATTRACTION_LABELS).reduce((a, k) => a + (parts[k] ?? 0), 0);
  const attractions = Object.keys(ATTRACTION_LABELS).filter((k) => (parts[k] ?? 0) > 0.001)
    .sort((a, b) => (parts[b] ?? 0) - (parts[a] ?? 0))
    .map((k) => ({ label: ATTRACTION_LABELS[k], value: partSum > 0 ? (parts[k] ?? 0) / partSum : 0 }));
  const season = T.season[sim.date.month] ?? 1;
  const seasonText = season >= 1.15 ? 'high season' : season <= 0.85 ? 'low season' : 'ordinary season';
  const hotels = s.businesses.filter((b) => b.kind === 'hotel' && b.status === 'operating');
  const sites = s.buildings.filter((b) => b.kind === 'heritage');
  const venues = s.businesses.filter((b) => (b.kind === 'museum' || b.kind === 'stadium') && b.status !== 'closed');
  const cinemas = s.businesses.filter((b) => b.kind === 'cinema' && b.status === 'operating');
  const parks = s.buildings.filter((b) => b.kind === 'park').length;
  const ap = airportOf(sim);
  const apProject = s.projects.find((p) => p.kind === 'airport' && p.phase !== 'done' && p.phase !== 'cancelled');
  const tone = (v: number) => (v < 0.4 ? 'bad' : v > 0.7 ? 'good' : undefined);
  return (
    <div class="panel-body">
      <section>
        <h3>Visitors last month</h3>
        <dl class="rows">
          <div><dt>Visitors</dt><dd>{num(st.tourists)} <span class="muted small">({num(st.foreignTourists)} from abroad)</span></dd></div>
          <div><dt>Came for the day</dt><dd>{num(last.dayTrips)}</dd></div>
          <div><dt>Guest-nights in hotels</dt><dd>{num(last.nights)}</dd></div>
          <div><dt>Found no room</dt><dd class={turnedShare > 0.15 ? 'bad' : ''}>{num(last.turned)}{overnight > 0 ? ` (${pct(turnedShare)})` : ''}</dd></div>
          <div><dt>Arrived by air</dt><dd>{num(last.byAir)}</dd></div>
          <div><dt>Spent in the city</dt><dd>{money(sim, last.spend)}</dd></div>
        </dl>
        <Chart series={[{ label: 'All visitors', values: ms.map((m) => m.tourists), color: '#8fd3ff' }, { label: 'From abroad', values: ms.map((m) => m.foreignTourists), color: '#f0b04a' }]}
          fmt={(v) => num(v)} labels={monthLabels(sim, ms)} />
        {T.festival > 0 && <p class="good small">{fest.name} is on: {T.festival} more day{T.festival > 1 ? 's' : ''}, about {num(T.festivalVisitors)} visitors so far.</p>}
      </section>
      <section>
        <h3>Why visitors come</h3>
        <p class="muted small">Attractions index {T.appeal.toFixed(2)} · {seasonText} this month (×{season.toFixed(2)})</p>
        {attractions.length ? <Bars bars={attractions} /> : <p class="muted">Nothing draws visitors yet.</p>}
        <h4>How well the city is known</h4>
        <Bars bars={[
          { label: 'At home', value: T.awareness, tone: tone(T.awareness) },
          { label: 'Abroad', value: T.awarenessIntl, tone: tone(T.awarenessIntl) },
          { label: 'Reputation', value: T.reputation, tone: tone(T.reputation) },
        ]} />
        <h4>What holds visitors back</h4>
        <Bars bars={[
          { label: 'Safety', value: parts.xSafety ?? 1, tone: tone(parts.xSafety ?? 1) },
          { label: 'Clean air', value: parts.xClean ?? 1, tone: tone(parts.xClean ?? 1) },
          { label: 'Free-flowing roads', value: parts.xCrowd ?? 1, tone: tone(parts.xCrowd ?? 1) },
          { label: 'Size of the town', value: parts.xTown ?? 1, tone: tone(parts.xTown ?? 1) },
        ]} />
        <p class="muted small">Promotion and flights make the city better known; good experiences, safety and enough hotel rooms build its reputation.</p>
      </section>
      <section>
        <h3>Hotels</h3>
        {hotels.length === 0 ? <p class="muted">No hotels yet. Investors build them on commercial land once visitors start finding no room.</p> : (
          <>
            <dl class="rows">
              <div><dt>Rooms</dt><dd>{num(st.hotelRooms)} in {hotels.length} hotel{hotels.length > 1 ? 's' : ''}</dd></div>
              <div><dt>Occupancy last month</dt><dd>{pct(st.occupancy)}</dd></div>
              <div><dt>Room rate</dt><dd>{money(sim, roomRate(sim, false))} a night · {money(sim, roomRate(sim, true))} for foreign guests</dd></div>
              <div><dt>{TAX_LABELS.tourism}</dt><dd>{pct(g.taxes.tourism)} · raised {money(sim, g.last.rev.tourismTax)}</dd></div>
            </dl>
            <ul class="lines">
              {hotels.slice(0, 12).map((b) => {
                const h = b.hotel;
                return (
                  <li key={b.id}>
                    <button class="link" onClick={() => ctx.openRef({ k: 'business', id: b.id })}>{b.name}</button>{' '}
                    <span class="muted small">{h ? `${h.rooms} rooms · ${pct(h.rooms ? h.occupied / h.rooms : 0)} full last night · ${num(h.lastGuests)} guests last month` : 'opening'}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      <section>
        <h3>Attractions</h3>
        {sites.length + venues.length + cinemas.length + parks === 0 && <p class="muted">Nothing much to see yet. Museums, a stadium and parks are on the Build menu.</p>}
        <ul class="lines">
          {sites.map((b) => (
            <li key={b.id}>
              <button class="link" onClick={() => ctx.openRef({ k: 'building', id: b.id })}>{b.name || 'Heritage site'}</button>{' '}
              <span class={`small ${b.condition < 0.5 ? 'bad' : 'muted'}`}>condition {pct(b.condition)}{b.condition < 0.5 ? ': needs conservation (culture budget)' : ''}</span>
            </li>
          ))}
          {venues.map((b) => {
            const v = b.venue;
            const detail = b.status !== 'operating' ? 'not open yet'
              : b.kind === 'museum' ? `${num(v?.lastSold ?? 0)} visitors last month, ${num(v?.lastVisitors ?? 0)} from outside the city`
                : `${v?.lastEvents ?? 0} events last month · last crowd ${num(v?.lastCrowd ?? 0)}${v && v.nextEvent >= sim.day ? ` · next on ${dayLabel(sim, v.nextEvent)}` : ''}`;
            return <li key={b.id}><button class="link" onClick={() => ctx.openRef({ k: 'business', id: b.id })}>{b.name}</button> <span class="muted small">{detail}</span></li>;
          })}
          {cinemas.length > 0 && <li>{cinemas.length} cinema{cinemas.length > 1 ? 's' : ''} <span class="muted small">{num(cinemas.reduce((a, b) => a + (b.venue?.lastSold ?? 0), 0))} tickets last month</span></li>}
          {parks > 0 && <li>{parks} park{parks > 1 ? 's' : ''} <span class="muted small">free to visit</span></li>}
        </ul>
      </section>
      <section>
        <h3>Festival and promotion</h3>
        <dl class="rows">
          <div><dt>{fest.name}</dt><dd>{MONTHS_LONG[fest.month]}, {fest.days} days · {['not held', 'local festival', 'grand festival'][pol.festival] ?? '–'}</dd></div>
          <div><dt>{POLICY_LABELS.tourismPromotion}</dt><dd>{describeValue(sim, 'tourismPromotion', pol.tourismPromotion)} · {money(sim, (PROMOTION_COST[pol.tourismPromotion] ?? 0) * nominal)} a month</dd></div>
          <div><dt>Spent on promotion and festivals last month</dt><dd>{money(sim, g.last.exp.promotion)}</dd></div>
        </dl>
        <div class="buttons"><button class="small" onClick={() => ctx.setTab('policies')}>Change in Laws</button></div>
      </section>
      <section>
        <h3>Airport</h3>
        {ap ? (
          <>
            <dl class="rows">
              <div><dt>Open since</dt><dd>{A.opened >= 0 ? dayLabel(sim, A.opened) : 'this month'}</dd></div>
              <div><dt>Passengers last month</dt><dd>{num(A.last.pax)}</dd></div>
              <div><dt>Of whom</dt><dd>{num(A.last.tourists)} visitors · {num(A.last.residents)} residents · {num(A.last.business)} on business</dd></div>
              <div><dt>Flights last month</dt><dd>{num(A.last.flights)}</dd></div>
              <div><dt>Fees raised</dt><dd>{money(sim, A.last.fees)}</dd></div>
            </dl>
            <ul class="lines">
              {A.routes.map((r) => (
                <li key={r.id}>{r.dest} <span class="muted small">{r.airline}{r.intl ? ' · international' : ''} · {r.weekly} flights a week{r.lastSeats > 0 ? ` · ${pct(r.lastPax / r.lastSeats)} of seats filled last month` : ' · new'}</span></li>
              ))}
              {A.pending.map((p) => <li key={`${p.dest}-${p.day}`}>{p.dest} <span class="muted small">{p.airline} starts flying around {dayLabel(sim, p.day)}</span></li>)}
            </ul>
            {A.routes.length === 0 && A.pending.length === 0 && <p class="muted">No airline flies here yet.</p>}
          </>
        ) : apProject ? (
          <p><button class="link" onClick={() => ctx.openRef({ k: 'project', id: apProject.id })}>{apProject.name}</button> <span class="muted small">{Math.round(projectProgress(apProject) * 100)}% built</span></p>
        ) : (
          <>
            <p class="muted">No airport: visitors come by road, and many who would fly stay away.</p>
            <dl class="rows">
              <div><dt>Expected passengers</dt><dd>about {num(projectedPassengers(sim))} a month</dd></div>
              <div><dt>National co-funding</dt><dd>{cofundShare(sim, 'airport') > 0 ? `${pct(cofundShare(sim, 'airport'))} of construction` : `only above ${num(AIRPORT_MIN_DEMAND)} expected passengers a month`}</dd></div>
            </dl>
            <div class="buttons"><button class="small" onClick={() => ctx.build('airport')}>Plan an airport</button></div>
          </>
        )}
      </section>
      <section>
        <h3>Going out</h3>
        <dl class="rows">
          <div><dt>Residents' leisure</dt><dd class={tone(st.leisure) ?? ''}>{pct(st.leisure)}</dd></div>
          <div><dt>Spent on outings last month</dt><dd>{money(sim, s.leisure.lastSpend)}</dd></div>
          <div><dt>Wanted to go out but found no seat</dt><dd>{money(sim, s.leisure.lastUnmet)}</dd></div>
          <div><dt>{TAX_LABELS.entertainment}</dt><dd>{pct(g.taxes.entertainment)}</dd></div>
        </dl>
        <p class="muted small">Families want a couple of films a month, the odd museum visit and a match now and then. Unmet demand draws cinema investors; venues near home and the festival lift satisfaction.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ projects

const PHASES: Record<string, string> = {
  planning: 'Planning', assessment: 'Environmental assessment', approval: 'Awaiting approval', land: 'Land acquisition', funding: 'Awaiting funding',
  construction: 'Under construction', staffing: 'Hiring staff', done: 'Completed', cancelled: 'Cancelled',
};

export function Projects({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const all = sim.s.projects;
  const active = all.filter((p) => p.gov && p.phase !== 'done' && p.phase !== 'cancelled');
  const finished = all.filter((p) => p.gov && (p.phase === 'done' || p.phase === 'cancelled'));
  const priv = all.filter((p) => !p.gov && p.phase !== 'done' && p.phase !== 'cancelled');
  const [confirm, setConfirm] = useState<number | null>(null);
  return (
    <div class="panel-body">
      <p class="muted">Propose new facilities with <b>Build</b> and new roads or canals with <b>Roads</b> on the toolbar. Projects move through planning, approvals, land and funding before construction starts.</p>
      <section>
        <h3>Public projects ({active.length})</h3>
        {active.length === 0 && <p class="muted">No public projects under way.</p>}
        {active.map((p) => (
          <article class="project" key={p.id}>
            <header><button class="link" onClick={() => ctx.openRef({ k: 'project', id: p.id })}>{p.name}</button><span class="chip">{PHASES[p.phase]}</span></header>
            <div class="progress" role="progressbar" aria-valuenow={Math.round(projectProgress(p) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} construction progress`}>
              <span style={{ width: `${Math.round(projectProgress(p) * 100)}%` }} />
            </div>
            <p class="muted small">{Math.round(projectProgress(p) * 100)}% built · spent {money(sim, p.spent)} of {money(sim, p.cost)}{p.cost > p.budget * 1.05 ? ` (budget was ${money(sim, p.budget)})` : ''}{p.delayDays > 0 ? ` · ${p.delayDays} days of delays` : ''}</p>
            {p.issue && <p class="bad small">{p.issue}</p>}
            {p.phase !== 'staffing' && (confirm === p.id
              ? <div class="buttons"><span class="small">Cancel after spending {money(sim, p.spent)}?</span><button class="danger small" onClick={() => { const r = cancel(sim, p.id); ctx.toast(r.ok ? r.message : r.error, r.ok ? undefined : 'bad'); setConfirm(null); }}>Yes, cancel</button><button class="ghost small" onClick={() => setConfirm(null)}>Keep</button></div>
              : <button class="ghost small" onClick={() => setConfirm(p.id)}>Cancel project</button>)}
          </article>
        ))}
      </section>
      <section>
        <h3>Private developments ({priv.length})</h3>
        {priv.slice(0, 12).map((p) => (
          <p key={p.id} class="small"><button class="link" onClick={() => ctx.openRef({ k: 'project', id: p.id })}>{p.name}</button> · {PHASES[p.phase]} · {Math.round(projectProgress(p) * 100)}%</p>
        ))}
        {priv.length === 0 && <p class="muted">Developers are not building anything right now.</p>}
      </section>
      {finished.length > 0 && (
        <section>
          <h3>Recently finished</h3>
          {finished.map((p) => <p key={p.id} class="small">{p.name}: {PHASES[p.phase].toLowerCase()} on {dayLabel(sim, p.completed)}</p>)}
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ news

const TAGS = ['all', 'economy', 'government', 'development', 'business', 'tourism', 'trade', 'agriculture', 'society', 'weather', 'environment', 'milestone'];

export function News({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const [tag, setTag] = useState('all');
  const [open, setOpen] = useState<number | null>(null);
  const items = sim.s.news.slice().reverse().filter((n) => tag === 'all' || n.tag === tag).slice(0, 80);
  return (
    <div class="panel-body">
      <div class="chips" role="group" aria-label="Filter news">
        {TAGS.map((t) => <button key={t} class={`chip ${tag === t ? 'on' : ''}`} aria-pressed={tag === t} onClick={() => setTag(t)}>{t}</button>)}
      </div>
      {items.length === 0 && <p class="muted">No news yet.</p>}
      {items.map((n) => (
        <article class="news" key={n.id}>
          <p class="muted small">{dayLabel(sim, n.day)} · {n.tag}</p>
          <h4>{n.headline}</h4>
          {n.body && <p>{n.body}</p>}
          <div class="buttons">
            {n.why.length > 0 && <button class="ghost small" aria-expanded={open === n.id} onClick={() => setOpen(open === n.id ? null : n.id)}>{open === n.id ? 'Hide causes' : 'Why?'}</button>}
            {n.ref && <button class="ghost small" onClick={() => ctx.openRef(n.ref!)}>Show on map</button>}
          </div>
          {open === n.id && <ul class="why">{n.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ milestones

export function Milestones({ ctx }: { ctx: Ctx }) {
  const { sim } = ctx;
  const got = sim.s.milestones;
  const list = milestonesFor(sim);
  const done = list.filter((m) => got[m.id] !== undefined);
  return (
    <div class="panel-body">
      <p class="muted">Milestones are recognised when the simulation reaches them. {done.length} of {list.length} reached.</p>
      <ul class="milestones">
        {list.map((m) => {
          const d = got[m.id];
          return (
            <li key={m.id} class={d !== undefined ? 'done' : ''}>
              <span class="tick" aria-hidden="true">{d !== undefined ? '✓' : '○'}</span>
              <span>{m.label}</span>
              <span class="muted small">{d === undefined ? 'not yet' : d < 0 ? 'already true when you took office' : dayLabel(sim, d)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ saves

export function Saves({ ctx }: { ctx: Ctx }) {
  const { sim, game } = ctx;
  const meta = sim.s.meta;
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => listSaves().then(setSaves).catch(() => setSaves([]));
  useEffect(() => { void refresh(); }, []);
  const mine = (saves ?? []).filter((s) => s.worldId === meta.id);
  const pace = PACES.find((p) => Math.abs(p.pace - meta.pace) < 1e-9);
  const cap = OFFLINE_CAPS.find((c) => c.days === meta.offlineCapDays);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); ctx.toast(ok, 'good'); } catch (e) { ctx.toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(false); void refresh(); }
  };
  return (
    <div class="panel-body">
      <section>
        <h3>{meta.name}</h3>
        <dl class="rows">
          <div><dt>Region</dt><dd>{getPreset(meta.preset).label}, {getPreset(meta.preset).country}</dd></div>
          <div><dt>In office since</dt><dd>{meta.officeYear}</dd></div>
          <div><dt>World pace</dt><dd>{pace ? `${pace.label}: ${pace.blurb}` : `${meta.pace} sim-min/s`}</dd></div>
          <div><dt>While you are away</dt><dd>The world keeps running at its pace, up to {cap ? cap.label : 'no limit'}</dd></div>
          <div><dt>Time played</dt><dd>{realSpan(meta.playedMs)}</dd></div>
          <div><dt>Last saved</dt><dd>{game.lastSaved ? new Date(game.lastSaved).toLocaleTimeString() : 'not yet'} (saves automatically every minute)</dd></div>
        </dl>
        {game.saveError && <p class="bad small">Saving failed: {game.saveError}</p>}
        <div class="buttons wrap">
          <button disabled={busy} onClick={() => run(() => game.save('Autosave'), 'Saved.')}>Save now</button>
          <button disabled={busy} onClick={() => ctx.exportWorld()}>Export file</button>
          <button disabled={busy} onClick={() => ctx.importWorld()}>Import file</button>
          <button class="ghost" onClick={() => ctx.menu()}>Main menu</button>
        </div>
      </section>
      <CloudSection onSaveNow={() => void game.save('Autosave').then((m) => { if (m) void activeSync()?.upload(); })} />
      <section>
        <h3>Save a copy</h3>
        <div class="inline">
          <label class="sr-only" for="save-label">Name for this save</label>
          <input id="save-label" type="text" placeholder={`e.g. Before the ${sim.date.year + 1} budget`} value={label} maxLength={60}
            onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)} />
          <button disabled={busy} onClick={() => run(async () => { await game.saveAs(label.trim()); setLabel(''); }, 'Copy saved.')}>Save</button>
        </div>
      </section>
      <section>
        <h3>Saves of this world</h3>
        {saves === null && <p class="muted">Loading…</p>}
        <ul class="saves">
          {mine.map((s) => (
            <li key={s.key}>
              <div>
                <b>{s.kind === 'auto' ? 'Autosave' : s.kind === 'backup' ? 'Backup' : s.label}</b>
                <p class="muted small">{new Date(s.savedAt).toLocaleString()} · {num(s.population)} residents · {(s.size / 1024).toFixed(0)} KB</p>
              </div>
              {s.kind !== 'auto' && (
                <div class="buttons">
                  <button class="small" onClick={() => ctx.loadSave(s.key)}>Load</button>
                  <button class="ghost small" onClick={() => run(() => deleteSave(s.key), 'Deleted.')}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p class="muted small">Loading a copy or backup rewinds this world to the moment it was saved.</p>
      </section>
    </div>
  );
}
