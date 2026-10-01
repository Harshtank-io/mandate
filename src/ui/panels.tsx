// Sidebar panels: the government dashboard and the levers of government.

import { useEffect, useState } from 'preact/hooks';
import type { Sim } from '../sim/core';
import type { Game } from '../game/game';
import type { Selection } from '../render/view';
import { alerts } from '../sim/summary';
import { explain, projectProgress, REV_LABELS, type MetricKey, type Ref } from '../sim/inspect';
import { announcePolicy, announceTax, cancel, describeValue, policyEffects, policyRange, setFunding, taxEffects, taxRange } from '../sim/commands';
import { DEPT_LABELS, POLICY_DELAY, POLICY_LABELS, TAX_LABELS } from '../sim/systems/government';
import { milestonesFor } from '../sim/systems/milestones';
import { OFFLINE_CAPS, PACES, getPreset } from '../sim/presets';
import { DEPTS, type MonthStats, type Policies, type RevCat, type TaxSettings } from '../sim/types';
import { deleteSave, listSaves, type SaveMeta } from '../game/persist';
import { activeSync } from '../net/sync';
import { CloudSection } from './account';
import { Chart, dayLabel, money, num, pct, realSpan, SectionView, Spark } from './util';

export type Tab = 'overview' | 'budget' | 'taxes' | 'policies' | 'projects' | 'news' | 'milestones' | 'saves';

export interface Ctx {
  game: Game;
  sim: Sim;
  select(sel: Selection | null): void;
  openRef(ref: Ref): void;
  toast(text: string, tone?: 'good' | 'bad'): void;
  setTab(t: Tab): void;
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
