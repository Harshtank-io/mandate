// The build bar along the bottom of the screen, as in city builders: tool categories that open a tray of cards for
// every facility, the bulldozer, info views, the camera and the demand meter for zoned land.

import type { Sim } from '../sim/core';
import type { Overlay, Tool } from '../render/view';
import type { CameraPreset } from '../render/camera';
import { facilityCard, roadCard, ZONE_LABELS, type RoadTool } from '../sim/commands';
import { demand, type ZoneDemand } from '../sim/demand';
import { isInstant } from '../sim/systems/construction';
import { ROADWORKS } from '../sim/tables';
import { Zone, type BuildingKind } from '../sim/types';
import { Icon, type IconName } from './icons';
import { money } from './util';

export type DockMenu = 'roads' | 'zones' | 'utilities' | 'services' | 'parks' | 'transport' | 'info' | 'camera';

const BUILD_MENUS: { id: DockMenu; label: string; icon: IconName; kinds: BuildingKind[] }[] = [
  { id: 'utilities', label: 'Water & power', icon: 'power', kinds: ['waterworks', 'substation', 'gasplant', 'solarfarm', 'windfarm'] },
  { id: 'services', label: 'Services', icon: 'services', kinds: ['clinic', 'hospital', 'firestation', 'police', 'school', 'college', 'affordable', 'townhall'] },
  { id: 'parks', label: 'Parks & culture', icon: 'park', kinds: ['park', 'museum', 'stadium'] },
  { id: 'transport', label: 'Transport', icon: 'plane', kinds: ['airport'] },
];

const KIND_ICON: Record<string, IconName> = {
  waterworks: 'water', substation: 'pylon', gasplant: 'gas', solarfarm: 'sun', windfarm: 'turbine', clinic: 'clinic', hospital: 'hospital', firestation: 'fire',
  police: 'police', school: 'school', college: 'college', affordable: 'housing', townhall: 'townhall', park: 'park', museum: 'museum', stadium: 'stadium', airport: 'plane',
};

const ROAD_CARDS: { tool: RoadTool; icon: IconName; note: string }[] = [
  { tool: 'road', icon: 'road', note: 'About 600 vehicles an hour; opens frontage for building' },
  { tool: 'avenue', icon: 'avenue', note: '1,600 vehicles an hour; can bridge the river' },
  { tool: 'upgrade', icon: 'widen', note: 'Widens an existing street to an avenue' },
  { tool: 'canal', icon: 'canal', note: 'Irrigates fields within 160 m' },
];

const ZONE_CARDS: { zone: number; icon: IconName; note: string; key: 'res' | 'com' | 'ind' | null }[] = [
  { zone: Zone.Residential, icon: 'residential', note: 'Houses and flats, built by developers', key: 'res' },
  { zone: Zone.Commercial, icon: 'commercial', note: 'Shops, services, offices and hotels', key: 'com' },
  { zone: Zone.Industrial, icon: 'industrial', note: 'Plants, depots and builders’ yards', key: 'ind' },
  { zone: Zone.Agricultural, icon: 'agricultural', note: 'Farms for settling families', key: null },
];

export const INFO_VIEWS: { id: Overlay; label: string; icon: IconName; legend?: string }[] = [
  { id: 'none', label: 'Normal view', icon: 'eye' },
  { id: 'zoning', label: 'Zoning', icon: 'zone', legend: 'Green residential · blue commercial · yellow industrial · olive agricultural' },
  { id: 'power', label: 'Electricity', icon: 'power', legend: 'Roads carry power lines: yellow from the grid, orange from local plants only, dark none. Buildings green when fully supplied, red in blackouts' },
  { id: 'water', label: 'Water', icon: 'water', legend: 'Roads in blue carry water mains. Buildings green on the mains, red where families rely on wells and tankers' },
  { id: 'fire', label: 'Fire cover', icon: 'fire', legend: 'Fire stations within reach: red none → green full cover' },
  { id: 'health', label: 'Healthcare reach', icon: 'clinic', legend: 'Share of residents a clinic or hospital can serve: red none → green all' },
  { id: 'schools', label: 'School places', icon: 'school', legend: 'School places for local children: red none → green enough' },
  { id: 'police', label: 'Police coverage', icon: 'police', legend: 'Red none → green full coverage' },
  { id: 'happiness', label: 'Happiness', icon: 'smile', legend: 'How content residents are at home: red unhappy → green content' },
  { id: 'pollution', label: 'Air pollution', icon: 'cloud', legend: 'Shaded where the air is polluted; red is worst' },
  { id: 'traffic', label: 'Traffic', icon: 'car', legend: 'Rush-hour load: green free-flowing → red over capacity' },
  { id: 'roads', label: 'Road condition', icon: 'cone', legend: 'Green good surface → red potholed' },
  { id: 'landValue', label: 'Land value', icon: 'coin', legend: 'Blue low → red high' },
];

const CAMERAS: { id: CameraPreset; label: string }[] = [{ id: 'strategic', label: 'Strategic map' }, { id: 'city', label: 'City view' }, { id: 'street', label: 'Street level' }];

interface DockProps {
  sim: Sim;
  tool: Tool;
  overlay: Overlay;
  menu: DockMenu | null;
  readOnly: boolean;
  setMenu(m: DockMenu | null): void;
  setTool(t: Tool): void;
  setOverlay(o: Overlay): void;
  camera(p: CameraPreset): void;
  /** Switches instant construction for the city's own projects on or off. */
  setInstant(on: boolean): void;
}

function DockButton({ icon, label, on, expanded, onClick, keyHint }: { icon: IconName; label: string; on?: boolean; expanded?: boolean; onClick(): void; keyHint?: string }) {
  return (
    <button class={`dock-btn ${on ? 'on' : ''}`} aria-pressed={expanded === undefined ? !!on : undefined} aria-expanded={expanded} title={keyHint ? `${label} (${keyHint})` : label} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

const DEMAND_NAMES = { res: 'Residential', com: 'Commercial', ind: 'Industrial' } as const;

/** Demand bars for residential, commercial and industrial land. Opens the zoning tray, which explains them. */
function DemandMeter({ sim, onClick, open }: { sim: Sim; onClick(): void; open: boolean }) {
  const d = demand(sim);
  const bars = (['res', 'com', 'ind'] as const).map((k) => ({ k, z: d[k] }));
  const summary = bars.map(({ k, z }) => `${DEMAND_NAMES[k]} ${z.label.toLowerCase()}${z.blocked ? ', no land' : ''}`).join('; ');
  return (
    <button class={`rci ${open ? 'on' : ''}`} aria-expanded={open} aria-label={`Demand for zoned land: ${summary}. Show details`} title="Demand for zoned land" onClick={onClick}>
      {bars.map(({ k, z }) => (
        <span key={k} class={`rci-bar rci-${k}`}>
          <span class="rci-track"><span class="rci-fill" style={{ height: `${Math.round(Math.max(0, z.value) * 100)}%` }} /></span>
          <span class={`rci-k ${z.blocked ? 'blocked' : ''}`}>{k === 'res' ? 'R' : k === 'com' ? 'C' : 'I'}</span>
        </span>
      ))}
    </button>
  );
}

function DemandNote({ z, name }: { z: ZoneDemand; name: string }) {
  return (
    <div class="demand-note">
      <h4>{name}: <span class={z.value > 0.25 ? 'good' : z.value < -0.25 ? 'bad' : ''}>{z.label.toLowerCase()}</span></h4>
      <ul class="lines small">{z.why.slice(0, 3).map((w) => <li key={w}>{w}</li>)}</ul>
      {z.blocked && <p class="small bad">{z.blocked}</p>}
    </div>
  );
}

export function Dock(p: DockProps) {
  const { sim, tool, overlay, menu, readOnly } = p;
  const instant = isInstant(sim, { gov: true });
  const toggle = (m: DockMenu) => p.setMenu(menu === m ? null : m);
  const build = BUILD_MENUS.find((m) => m.id === menu);
  const inMenu = (m: DockMenu) => (m === 'roads' && tool.mode === 'road') || (m === 'zones' && tool.mode === 'zone')
    || (tool.mode === 'build' && !!BUILD_MENUS.find((b) => b.id === m)?.kinds.includes(tool.kind));
  return (
    <>
      {menu && (
        <section class="tray panel" aria-label={menu === 'info' ? 'Info views' : menu === 'camera' ? 'Camera' : build?.label ?? (menu === 'roads' ? 'Roads' : 'Zoning')}>
          {(build || menu === 'roads') && (
            <div class="tray-head">
              <span>{instant ? 'Built the moment you approve' : 'Built at the realistic pace; each proposal can also be built instantly'}</span>
              <label class="switch">
                <input type="checkbox" checked={instant} onChange={(e) => p.setInstant((e.currentTarget as HTMLInputElement).checked)} />
                Instant construction
              </label>
            </div>
          )}
          {build && (
            <div class="cards">
              {build.kinds.map((k) => {
                const c = facilityCard(sim, k);
                const on = tool.mode === 'build' && tool.kind === k;
                return (
                  <button key={k} class={`build-card ${on ? 'on' : ''}`} disabled={!!c.disabled} aria-pressed={on} onClick={() => p.setTool({ mode: 'build', kind: k })}>
                    <span class="build-icon"><Icon name={KIND_ICON[k] ?? 'services'} size={26} /></span>
                    <b>{c.label}</b>
                    <span class="build-note">{c.disabled ?? c.note}</span>
                    <span class="build-meta">{money(sim, c.cost)} · {c.w}×{c.h}</span>
                    <span class="build-meta">{c.monthly > 0 ? `${money(sim, c.monthly)}/mo · ` : ''}{instant ? 'instant' : `~${c.months} mo`}</span>
                  </button>
                );
              })}
            </div>
          )}
          {menu === 'roads' && (
            <div class="cards">
              {ROAD_CARDS.map((r) => {
                const c = roadCard(sim, r.tool);
                const on = tool.mode === 'road' && tool.kind === r.tool;
                return (
                  <button key={r.tool} class={`build-card ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => p.setTool({ mode: 'road', kind: r.tool })}>
                    <span class="build-icon"><Icon name={r.icon} size={26} /></span>
                    <b>{ROADWORKS[r.tool].label}</b>
                    <span class="build-note">{r.note}</span>
                    <span class="build-meta">{money(sim, c.cost)} per 40 m</span>
                    <span class="build-meta">upkeep {money(sim, c.monthly)}/mo</span>
                  </button>
                );
              })}
            </div>
          )}
          {menu === 'zones' && (
            <>
              <div class="cards">
                {ZONE_CARDS.map((z) => {
                  const on = tool.mode === 'zone' && tool.zone === z.zone;
                  const d = z.key ? demand(sim)[z.key] : null;
                  return (
                    <button key={z.zone} class={`build-card zone-${z.zone} ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => { p.setTool({ mode: 'zone', zone: z.zone }); p.setOverlay('zoning'); }}>
                      <span class="build-icon"><Icon name={z.icon} size={26} /></span>
                      <b>{ZONE_LABELS[z.zone]}</b>
                      <span class="build-note">{z.note}</span>
                      {d && <span class={`build-meta ${d.blocked ? 'bad' : ''}`}>Demand: {d.label.toLowerCase()}{d.blocked ? ' · no land' : ''}</span>}
                    </button>
                  );
                })}
              </div>
              <div class="demand-notes">
                <DemandNote z={demand(sim).res} name="Homes" />
                <DemandNote z={demand(sim).com} name="Shops & offices" />
                <DemandNote z={demand(sim).ind} name="Industry" />
              </div>
            </>
          )}
          {menu === 'info' && (
            <div class="info-grid" role="group" aria-label="Info views">
              {INFO_VIEWS.map((v) => (
                <button key={v.id} class={overlay === v.id ? 'on' : ''} aria-pressed={overlay === v.id} onClick={() => p.setOverlay(v.id)}>
                  <Icon name={v.icon} size={18} /><span>{v.label}</span>
                </button>
              ))}
            </div>
          )}
          {menu === 'camera' && (
            <div class="camera-tray">
              <div class="buttons">{CAMERAS.map((c) => <button key={c.id} onClick={() => { p.camera(c.id); p.setMenu(null); }}>{c.label}</button>)}</div>
              <p class="muted small">Drag to pan · right-drag to rotate · scroll to zoom · WASD/arrows move · Q/E rotate · R/F tilt</p>
            </div>
          )}
        </section>
      )}
      <nav class="dock panel" aria-label="Tools">
        {!readOnly && <DemandMeter sim={sim} open={menu === 'zones'} onClick={() => toggle('zones')} />}
        <DockButton icon="cursor" label="Inspect" on={tool.mode === 'inspect'} onClick={() => p.setTool({ mode: 'inspect' })} />
        {!readOnly && <>
          <DockButton icon="road" label="Roads" on={inMenu('roads')} expanded={menu === 'roads'} onClick={() => toggle('roads')} />
          <DockButton icon="zone" label="Zoning" on={inMenu('zones')} expanded={menu === 'zones'} onClick={() => toggle('zones')} />
          {BUILD_MENUS.map((m) => <DockButton key={m.id} icon={m.icon} label={m.label} on={inMenu(m.id)} expanded={menu === m.id} onClick={() => toggle(m.id)} />)}
          <DockButton icon="bulldoze" label="Bulldoze" keyHint="B" on={tool.mode === 'bulldoze'} onClick={() => p.setTool(tool.mode === 'bulldoze' ? { mode: 'inspect' } : { mode: 'bulldoze' })} />
        </>}
        <DockButton icon="layers" label="Info views" on={overlay !== 'none'} expanded={menu === 'info'} onClick={() => toggle('info')} />
        <DockButton icon="camera" label="Camera" expanded={menu === 'camera'} onClick={() => toggle('camera')} />
      </nav>
    </>
  );
}
