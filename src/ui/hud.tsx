// The in-game interface layered over the 3D world.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AwayReport, Game, Progress } from '../game/game';
import type { Sim } from '../sim/core';
import type { Overlay, Selection, Tool, WorldView } from '../render/view';
import type { CameraPreset } from '../render/camera';
import { inspect, inspectCitizen, type Card, type Ref } from '../sim/inspect';
import { GOV_BUILDINGS, previewBuilding, previewRoad, proposeBuilding, proposeRoad, rezone, ZONE_LABELS, type Preview, type RoadTool } from '../sim/commands';
import { BUILDINGS, GOOD_SPECS, ROADWORKS } from '../sim/tables';
import { getPreset, SPEEDS } from '../sim/presets';
import { alerts } from '../sim/summary';
import { formatDate } from '../sim/calendar';
import { Terrain, Zone, type BuildingKind } from '../sim/types';
import { Budget, Milestones, News, Overview, PoliciesPanel, Projects, Saves, Taxes, type Ctx, type Tab } from './panels';
import { CardView, dateTime, Modal, money, num, pct, realSpan, Rows, useTick } from './util';

/** Event hub the 3D view calls into; the HUD installs the handlers. */
export interface Bus {
  select?(s: Selection | null): void;
  place?(x: number, y: number): void;
  route?(tiles: number[]): void;
  zone?(tiles: number[]): void;
}

type Proposal =
  | { k: 'build'; kind: BuildingKind; x: number; y: number }
  | { k: 'road'; tool: RoadTool; tiles: number[] }
  | { k: 'zone'; zone: number; tiles: number[] };

interface HudProps {
  game: Game;
  view: WorldView | null;
  bus: Bus;
  report: AwayReport | null;
  clearReport(): void;
  briefing: boolean;
  clearBriefing(): void;
  catching: Progress | null;
  onMenu(): void;
  onLoad(key: string): void;
  onExport(): void;
  onImport(): void;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'budget', label: 'Budget' }, { id: 'taxes', label: 'Taxes' }, { id: 'policies', label: 'Laws' },
  { id: 'projects', label: 'Projects' }, { id: 'news', label: 'News' }, { id: 'milestones', label: 'Milestones' }, { id: 'saves', label: 'World' },
];

const OVERLAYS: { id: Overlay; label: string; legend?: string }[] = [
  { id: 'none', label: 'Normal view' },
  { id: 'zoning', label: 'Zoning', legend: 'Green residential · blue commercial · yellow industrial · olive agricultural' },
  { id: 'landValue', label: 'Land value', legend: 'Blue low → red high' },
  { id: 'pollution', label: 'Air pollution', legend: 'Shaded where the air is polluted; red is worst' },
  { id: 'traffic', label: 'Traffic', legend: 'Rush-hour load: green free-flowing → red over capacity' },
  { id: 'roads', label: 'Road condition', legend: 'Green good surface → red potholed' },
  { id: 'health', label: 'Healthcare reach', legend: 'Share of residents a clinic or hospital can serve: red none → green all' },
  { id: 'schools', label: 'School places', legend: 'School places for local children: red none → green enough' },
  { id: 'police', label: 'Police coverage', legend: 'Red none → green full coverage' },
];

const ROAD_TOOLS: RoadTool[] = ['road', 'avenue', 'upgrade', 'canal'];
const ROAD_HINT: Record<RoadTool, string> = {
  road: 'Drag from an existing road to draw a street.',
  avenue: 'Drag from an existing road to draw an avenue; avenues can bridge the river.',
  upgrade: 'Drag along existing streets to widen them to avenues.',
  canal: 'Drag across open land or fields to dig an irrigation canal.',
};
const ZONES = [Zone.Residential, Zone.Commercial, Zone.Industrial, Zone.Agricultural];

function vehicleCard(sim: Sim, sel: Selection, following: boolean): Card | null {
  if (!('vehicle' in sel)) return null;
  if (sel.vehicle === 'car') {
    const c = sim.cit(sel.id);
    if (!c) return null;
    const card = inspectCitizen(sim, c);
    const tod = sim.s.minute % 1440;
    card.subtitle = `${c.mode === 3 ? 'Driving' : 'Riding a two-wheeler'} ${tod < 720 ? 'to work' : 'home'}${following ? ' · following' : ''}`;
    return card;
  }
  const sh = sim.s.shipments.find((x) => x.id === sel.id);
  if (!sh) return null;
  const from = sh.from >= 0 ? sim.biz(sh.from)?.name ?? 'a local business' : 'outside the region';
  const to = sh.to >= 0 ? sim.biz(sh.to)?.name ?? 'a local business' : sh.project >= 0 ? sim.ix.proj.get(sh.project)?.name ?? 'a building site' : 'outside the region';
  const g = GOOD_SPECS[sh.good];
  const carrier = sh.carrier >= 0 ? sim.biz(sh.carrier)?.name ?? 'local haulier' : 'outside haulier';
  const purpose = { supply: 'Local delivery', import: 'Import', export: 'Export', project: 'Construction delivery' }[sh.purpose];
  const at = sh.path[0] ?? 0;
  return {
    ref: { k: 'tile', id: at },
    title: `Truck: ${sh.qty.toFixed(sh.good === 'goods' ? 0 : 1)} ${g.unit} of ${g.label.toLowerCase()}`,
    subtitle: `${purpose}${following ? ' · following' : ''}`,
    rows: [['From', from], ['To', to], ['Carrier', carrier], ['Trucks', `${sh.trucks}`], ['Value', money(sim, sh.value)], ['Expected arrival', formatDate(sim.s.meta.startYear, sh.arrive)]],
    sections: [],
    focus: [(at % 128) + 0.5, Math.floor(at / 128) + 0.5],
  };
}

export function Hud(p: HudProps) {
  useTick(250);
  const { game, view } = p;
  const sim = game.sim.sim;
  const s = sim.s;
  const [tab, setTab] = useState<Tab | null>('overview');
  const [sel, setSel] = useState<Selection | null>(null);
  const [tool, setToolState] = useState<Tool>({ mode: 'inspect' });
  const [overlay, setOverlayState] = useState<Overlay>('none');
  const [menu, setMenu] = useState<'build' | 'roads' | 'zone' | 'layers' | 'camera' | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [floors, setFloors] = useState<number | undefined>(undefined);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone?: string }[]>([]);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const lastSpeed = useRef(1);

  const toast = (text: string, tone?: 'good' | 'bad') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6500);
  };
  const setTool = (t: Tool) => {
    setToolState(t);
    view?.setTool(t);
    setProposal(null);
    setMenu(null);
    if (t.mode === 'build') setFloors(BUILDINGS[t.kind].floors[0]);
  };
  const setOverlay = (o: Overlay) => { setOverlayState(o); view?.setOverlay(o); setMenu(null); };
  const openRef = (ref: Ref) => {
    const card = inspect(sim, ref);
    const next: Selection = { ref };
    setSel(next);
    view?.select(next, card?.focus);
  };
  const closeInspector = () => { setSel(null); view?.select(null); };
  const setSpeed = (v: number) => { if (v > 0) lastSpeed.current = v; game.speed = v; };

  useEffect(() => {
    p.bus.select = (x) => setSel(x);
    p.bus.place = (x, y) => { const t = toolRef.current; if (t.mode === 'build') setProposal({ k: 'build', kind: t.kind, x, y }); };
    p.bus.route = (tiles) => { const t = toolRef.current; if (t.mode === 'road') setProposal({ k: 'road', tool: t.kind, tiles }); };
    p.bus.zone = (tiles) => { const t = toolRef.current; if (t.mode === 'zone') setProposal({ k: 'zone', zone: t.zone, tiles }); };
  }, [p.bus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === ' ') { e.preventDefault(); setSpeed(game.speed > 0 ? 0 : lastSpeed.current); }
      else if (/^[1-5]$/.test(e.key)) setSpeed(SPEEDS[Number(e.key)]);
      else if (e.key === 'Escape') {
        if (p.report || p.briefing) return;
        if (proposal) { setProposal(null); view?.clearPending(); }
        else if (toolRef.current.mode !== 'inspect') setTool({ mode: 'inspect' });
        else if (menu) setMenu(null);
        else closeInspector();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ctx: Ctx = {
    game, sim, select: setSel, openRef, toast, setTab: (t) => setTab(t), menu: p.onMenu, loadSave: p.onLoad, exportWorld: p.onExport, importWorld: p.onImport,
  };
  const preset = getPreset(s.meta.preset);
  const w = s.weather;
  const weather = [`${Math.round(w.temp)}°C`, w.rain > 0.5 ? `rain ${w.rain.toFixed(0)} mm` : '', w.drought ? 'drought' : '', w.flood < 3 ? 'flooding' : '', w.pandemic > 0 ? 'epidemic' : ''].filter(Boolean).join(' · ');
  const st = s.stats.months[s.stats.months.length - 1];
  const urgent = alerts(sim).filter((a) => a.sev >= 2).length;
  const latest = s.news[s.news.length - 1];
  const hint = tool.mode === 'build' ? `Click a spot next to a road to place a ${BUILDINGS[tool.kind].label.toLowerCase()} (${BUILDINGS[tool.kind].w}×${BUILDINGS[tool.kind].h} tiles). Esc to stop.`
    : tool.mode === 'road' ? `${ROAD_HINT[tool.kind]} Esc to stop.`
      : tool.mode === 'zone' ? `Drag to rezone land as ${ZONE_LABELS[tool.zone].toLowerCase()}. Esc to stop.` : '';
  const legend = OVERLAYS.find((o) => o.id === overlay)?.legend;

  const panel = () => {
    switch (tab) {
      case 'overview': return <Overview ctx={ctx} />;
      case 'budget': return <Budget ctx={ctx} />;
      case 'taxes': return <Taxes ctx={ctx} />;
      case 'policies': return <PoliciesPanel ctx={ctx} />;
      case 'projects': return <Projects ctx={ctx} />;
      case 'news': return <News ctx={ctx} />;
      case 'milestones': return <Milestones ctx={ctx} />;
      case 'saves': return <Saves ctx={ctx} />;
      default: return null;
    }
  };

  // inspector content
  let card: Card | null = null;
  let following = false;
  if (sel) {
    if ('ref' in sel) card = inspect(sim, sel.ref);
    else { following = !!view?.isFollowing(); card = vehicleCard(sim, sel, following); }
  }
  const citizenCar = sel && 'ref' in sel && sel.ref.k === 'citizen' && view?.vehicleVisible({ vehicle: 'car', id: sel.ref.id });

  return (
    <div class="hud">
      <header class="topbar panel">
        <div class="city">
          <strong>{s.meta.name}</strong>
          <span class="muted small">{preset.label}, {preset.country}</span>
        </div>
        <div class="clock" aria-live="off">
          <time>{dateTime(sim)}</time>
          <span class="muted small">{weather}</span>
        </div>
        <div class="speeds" role="group" aria-label="Simulation speed">
          {SPEEDS.map((v, i) => (
            <button key={v} class={game.speed === v ? 'on' : ''} aria-pressed={game.speed === v} title={v === 0 ? 'Pause (Space)' : `${v}× the world's pace (key ${i})`} onClick={() => setSpeed(v)}>
              {v === 0 ? 'Pause' : `${v}×`}
            </button>
          ))}
          {game.busy && <span class="small muted">catching up…</span>}
        </div>
        <div class="kpis">
          <button class="kpi" onClick={() => setTab('overview')}><span>Population</span><b>{num(s.citizens.length)}</b></button>
          <button class="kpi" onClick={() => setTab('budget')}><span>Treasury</span><b class={s.gov.cash < 0 ? 'bad' : ''}>{money(sim, s.gov.cash)}</b></button>
          <button class="kpi" onClick={() => setTab('overview')}><span>Approval</span><b class={s.gov.approval < 0.45 ? 'bad' : ''}>{pct(s.gov.approval)}</b></button>
          {st && <button class="kpi" onClick={() => setTab('overview')}><span>Unemployment</span><b class={st.unemployment > 0.1 ? 'bad' : ''}>{pct(st.unemployment, 1)}</b></button>}
        </div>
        <div class="actions">
          <button class="ghost" onClick={() => { void game.save('Autosave').then((m) => toast(m ? 'Saved.' : 'Save skipped (already saving).')); }}>Save</button>
          <button class="ghost" onClick={p.onMenu}>Menu</button>
        </div>
      </header>

      <aside class={`sidebar panel ${tab ? '' : 'collapsed'}`} aria-label="Government">
        <nav class="tabs" role="tablist" aria-label="Government departments">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} class={tab === t.id ? 'on' : ''} onClick={() => setTab(tab === t.id ? null : t.id)}>
              {t.label}{t.id === 'overview' && urgent > 0 && <span class="badge" aria-label={`${urgent} urgent`}>{urgent}</span>}
            </button>
          ))}
        </nav>
        {tab && <div class="tab-panel" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>{panel()}</div>}
      </aside>

      {sel && (
        <aside class="inspector panel" aria-label="Inspector">
          <button class="close" aria-label="Close inspector" onClick={closeInspector}>×</button>
          {card ? (
            <CardView card={card} onLink={openRef} actions={<>
              <button class="small" onClick={() => view?.focus(card!.focus[0], card!.focus[1], Math.min(view.rig.dist, 30))}>Show</button>
              {'vehicle' in sel && <button class="small" onClick={() => view?.follow(sel)}>Follow</button>}
              {citizenCar && <button class="small" onClick={() => { const v: Selection = { vehicle: 'car', id: (sel as { ref: Ref }).ref.id }; setSel(v); view?.select(v); }}>Follow commute</button>}
            </>} />
          ) : <p class="muted">{'vehicle' in sel ? 'This trip has ended.' : 'This no longer exists.'}</p>}
        </aside>
      )}

      {proposal && (
        <ProposalPanel sim={sim} proposal={proposal} floors={floors} setFloors={setFloors}
          onApprove={() => {
            let r;
            if (proposal.k === 'build') r = proposeBuilding(sim, proposal.kind, proposal.x, proposal.y, floors);
            else if (proposal.k === 'road') r = proposeRoad(sim, proposal.tool, proposal.tiles);
            else r = rezone(sim, proposal.tiles, proposal.zone);
            toast(r.ok ? r.message : r.error, r.ok ? 'good' : 'bad');
            view?.clearPending();
            setProposal(null);
            if (r.ok && r.id !== undefined) setTab('projects');
          }}
          onCancel={() => { view?.clearPending(); setProposal(null); }} />
      )}

      <div class="bottom-left">
        {(hint || legend) && (
          <div class="hint panel small" role="status">
            {hint && <p>{hint}</p>}
            {legend && <p>{legend}</p>}
            {overlay === 'none' && tool.mode === 'inspect' && view && view.carScale > 1.5 && <p class="muted">Each moving car stands for about {Math.round(view.carScale)} commuters.</p>}
          </div>
        )}
        <nav class="toolbar panel" aria-label="Tools">
          <button class={tool.mode === 'inspect' ? 'on' : ''} aria-pressed={tool.mode === 'inspect'} onClick={() => setTool({ mode: 'inspect' })}>Inspect</button>
          <div class="tool-group">
            <button class={tool.mode === 'build' ? 'on' : ''} aria-expanded={menu === 'build'} onClick={() => setMenu(menu === 'build' ? null : 'build')}>Build</button>
            {menu === 'build' && (
              <div class="flyout panel">
                {GOV_BUILDINGS.map((k) => <button key={k} onClick={() => setTool({ mode: 'build', kind: k })}>{BUILDINGS[k].label}<small>{BUILDINGS[k].w}×{BUILDINGS[k].h}</small></button>)}
              </div>
            )}
          </div>
          <div class="tool-group">
            <button class={tool.mode === 'road' ? 'on' : ''} aria-expanded={menu === 'roads'} onClick={() => setMenu(menu === 'roads' ? null : 'roads')}>Roads</button>
            {menu === 'roads' && <div class="flyout panel">{ROAD_TOOLS.map((k) => <button key={k} onClick={() => setTool({ mode: 'road', kind: k })}>{ROADWORKS[k].label}</button>)}</div>}
          </div>
          <div class="tool-group">
            <button class={tool.mode === 'zone' ? 'on' : ''} aria-expanded={menu === 'zone'} onClick={() => setMenu(menu === 'zone' ? null : 'zone')}>Zone</button>
            {menu === 'zone' && <div class="flyout panel">{ZONES.map((z) => <button key={z} onClick={() => { setTool({ mode: 'zone', zone: z }); setOverlay('zoning'); }}>{ZONE_LABELS[z]}</button>)}</div>}
          </div>
          <div class="tool-group">
            <button class={overlay !== 'none' ? 'on' : ''} aria-expanded={menu === 'layers'} onClick={() => setMenu(menu === 'layers' ? null : 'layers')}>Layers</button>
            {menu === 'layers' && <div class="flyout panel">{OVERLAYS.map((o) => <button key={o.id} class={overlay === o.id ? 'on' : ''} onClick={() => setOverlay(o.id)}>{o.label}</button>)}</div>}
          </div>
          <div class="tool-group">
            <button aria-expanded={menu === 'camera'} onClick={() => setMenu(menu === 'camera' ? null : 'camera')}>Camera</button>
            {menu === 'camera' && (
              <div class="flyout panel">
                {(['strategic', 'city', 'street'] as CameraPreset[]).map((c) => <button key={c} onClick={() => { view?.preset(c); setMenu(null); }}>{c === 'strategic' ? 'Strategic map' : c === 'city' ? 'City view' : 'Street level'}</button>)}
                <p class="muted small">Drag to pan · right-drag to rotate · scroll to zoom · WASD/arrows move · Q/E rotate · R/F tilt</p>
              </div>
            )}
          </div>
        </nav>
      </div>

      {latest && (
        <button class="ticker panel" onClick={() => setTab('news')} aria-label={`Latest news: ${latest.headline}`}>
          <span class="chip">{latest.tag}</span> {latest.headline}
        </button>
      )}

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} class={`toast panel ${t.tone ?? ''}`}>{t.text}</div>)}
      </div>

      {p.catching && (
        <div class="catchup panel" role="status">
          {p.catching.label}… {Math.round((p.catching.done / Math.max(1, p.catching.total)) * 100)}%
        </div>
      )}

      {p.report && <WelcomeBack sim={sim} report={p.report} onClose={p.clearReport} openRef={(r) => { p.clearReport(); openRef(r); }} />}
      {p.briefing && !p.report && <Briefing sim={sim} onClose={p.clearBriefing} />}
    </div>
  );
}

function ProposalPanel({ sim, proposal, floors, setFloors, onApprove, onCancel }: {
  sim: Sim; proposal: Proposal; floors?: number; setFloors(f: number): void; onApprove(): void; onCancel(): void;
}) {
  if (proposal.k === 'zone') {
    const m = sim.s.map;
    const farmed = proposal.tiles.filter((t) => m.farm[t] >= 0).length;
    const forest = proposal.tiles.filter((t) => m.terrain[t] === Terrain.Forest).length;
    return (
      <section class="proposal panel" aria-label="Rezoning proposal">
        <h3>Rezone {(proposal.tiles.length * 0.16).toFixed(1)} ha as {ZONE_LABELS[proposal.zone].toLowerCase()}</h3>
        <ul class="lines">
          <li>{proposal.tiles.length} tiles; roads, water, buildings and project sites are left as they are</li>
          {proposal.zone !== Zone.Agricultural && <li>Developers and businesses can build here once there is road access and demand</li>}
          {farmed > 0 && <li>{farmed} tiles are farmed today: farmers keep working them until a developer buys the land</li>}
          {forest > 0 && <li class="bad">{forest} tiles are woodland that would be cleared for building</li>}
        </ul>
        <div class="buttons"><button class="primary" onClick={onApprove}>Rezone</button><button class="ghost" onClick={onCancel}>Cancel</button></div>
      </section>
    );
  }
  const pv: Preview = proposal.k === 'build' ? previewBuilding(sim, proposal.kind, proposal.x, proposal.y, floors) : previewRoad(sim, proposal.tool, proposal.tiles);
  const spec = proposal.k === 'build' ? BUILDINGS[proposal.kind] : null;
  const months = pv.est ? Math.max(1, Math.round(pv.est.days / 30.4)) : 0;
  return (
    <section class="proposal panel" aria-label="Project proposal">
      <h3>{proposal.k === 'build' && proposal.kind === 'affordable' ? `Public housing` : pv.label}{proposal.k === 'road' ? ` · ${(pv.tiles.length * 40).toLocaleString()} m` : ''}</h3>
      {pv.est && <Rows rows={[['Cost', money(sim, pv.est.cost)], ['Time', `about ${months} month${months > 1 ? 's' : ''} from proposal to opening`], ['Running cost', `${money(sim, pv.monthly)} a month`]]} />}
      {spec && spec.floors[1] > spec.floors[0] && (
        <div class="inline">
          <label for="floors">Floors</label>
          <input id="floors" type="number" min={spec.floors[0]} max={spec.floors[1]} value={pv.floors} onInput={(e) => setFloors(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
      )}
      {pv.errors.length > 0 && <ul class="lines bad">{pv.errors.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div class="proposal-grid">
        {pv.requirements.length > 0 && <div><h4>Requirements</h4><ul class="lines">{pv.requirements.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        {pv.benefits.length > 0 && <div><h4>Benefits</h4><ul class="lines good">{pv.benefits.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        {pv.risks.length > 0 && <div><h4>Potential problems</h4><ul class="lines">{pv.risks.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      </div>
      {pv.warnings.length > 0 && <ul class="lines muted">{pv.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div class="buttons sticky-actions">
        <button class="primary" disabled={!pv.ok} onClick={onApprove}>Approve project</button>
        <button class="ghost" onClick={onCancel}>Cancel</button>
        {!pv.ok && <span class="small bad">{pv.errors[0]}</span>}
      </div>
    </section>
  );
}

function WelcomeBack({ sim, report, onClose, openRef }: { sim: Sim; report: AwayReport; onClose(): void; openRef(r: Ref): void }) {
  return (
    <Modal title="While you were away" onClose={onClose} wide>
      <p class="muted">You were gone {realSpan(report.realMs)}; {report.span} passed in {sim.s.meta.name}.{report.cappedDays ? ` (The world only runs ahead ${report.cappedDays} days while you are away; you can change this when creating a world.)` : ''}</p>
      <ul class="summary">
        {report.lines.map((l, i) => (
          <li key={i} class={l.tone}>{l.ref ? <button class="link" onClick={() => openRef(l.ref!)}>{l.text}</button> : l.text}</li>
        ))}
      </ul>
      {report.events.length > 0 && (
        <>
          <h3>What happened</h3>
          <ul class="lines">{report.events.map((e) => <li key={e.id}><span class="muted small">{formatDate(sim.s.meta.startYear, e.day * 1440, false)}</span> {e.ref ? <button class="link" onClick={() => openRef(e.ref!)}>{e.text}</button> : e.text}</li>)}</ul>
        </>
      )}
      {report.attention.length > 0 && (
        <>
          <h3>Needs your attention</h3>
          <ul class="lines">{report.attention.map((a, i) => <li key={i} class={`sev${a.sev}`}>{a.text} <span class="muted small">{a.hint}</span></li>)}</ul>
        </>
      )}
      <div class="buttons"><button class="primary" onClick={onClose} autoFocus>Continue</button></div>
    </Modal>
  );
}

function Briefing({ sim, onClose }: { sim: Sim; onClose(): void }) {
  const s = sim.s;
  const st = s.stats.months[s.stats.months.length - 1];
  const p = getPreset(s.meta.preset);
  const count = (k: string) => s.businesses.filter((b) => b.kind === k && b.status === 'operating').length;
  const problems = alerts(sim);
  return (
    <Modal title={`Welcome to ${s.meta.name}`} wide>
      <p>{p.blurb}</p>
      {st && (
        <div class="brief-grid">
          <div><h4>People</h4><p>{num(st.population)} residents in {num(st.households)} households. Unemployment {pct(st.unemployment, 1)}; average wage {money(sim, st.avgWage)} a month.</p></div>
          <div><h4>Economy</h4><p>{num(st.businesses)} businesses and {num(s.businesses.filter((b) => b.farm).length)} farms. Food costs {money(sim, st.foodPrice)} a kilo in the shops.</p></div>
          <div><h4>Budget</h4><p>Treasury {money(sim, s.gov.cash)}{s.gov.debt > 0 ? `, debt ${money(sim, s.gov.debt)}` : ', no debt'}. Last month the city took in {money(sim, st.revenue)} and spent {money(sim, st.spending)}.</p></div>
          <div><h4>Infrastructure</h4><p>{st.roadKm.toFixed(0)} km of roads, {count('school')} school{count('school') === 1 ? '' : 's'}, {count('clinic')} clinic{count('clinic') === 1 ? '' : 's'}{count('hospital') ? ', a hospital' : ', no hospital'}{count('college') ? ' and a college' : ''}.</p></div>
        </div>
      )}
      <h3>Current problems</h3>
      {problems.length ? <ul class="lines">{problems.slice(0, 5).map((a, i) => <li key={i}>{a.text} <span class="muted small">{a.hint}</span></li>)}</ul> : <p class="muted">Nothing urgent yet. The dashboard will tell you when that changes.</p>}
      <h3>How to govern</h3>
      <ul class="lines">
        <li>Click anything in the world to inspect it: farms, shops, homes, roads, people, trucks.</li>
        <li>Set funding, taxes and laws in the panel on the right. Changes are announced and take effect with a delay.</li>
        <li>Propose facilities and roads from the toolbar; they take months to plan and build.</li>
        <li>The world keeps running while the game is closed. When you come back you will see what happened.</li>
      </ul>
      <p class="lead">You are now responsible for this place.</p>
      <div class="buttons"><button class="primary" onClick={onClose} autoFocus>Take office</button></div>
    </Modal>
  );
}
