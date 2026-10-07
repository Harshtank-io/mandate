// Top-level screens: main menu, new world, loading, the game itself, and errors. Opening, creating and leaving a town
// also keep its cloud copy in step (see net/sync.ts) when the player has an account.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Game, type AwayReport, type Progress } from '../game/game';
import { autoKey, deleteWorld, lastPlayedKey, listSaves, storageAvailable, type SaveMeta } from '../game/persist';
import { startCloud } from '../net/auth';
import { cloudConfigured, errText, within } from '../net/client';
import { deleteCloudTown, type Claim } from '../net/saves';
import { cloud, useCloud, type CloudTown } from '../net/store';
import { CloudSync, fetchCloud, forgetLocal, keepMine, planOpen } from '../net/sync';
import { visitTown, type WorldTown } from '../net/world';
import { WorldView } from '../render/view';
import { getPreset } from '../sim/presets';
import type { NewWorldOptions } from '../sim/worldgen';
import { AccountPanel, CloudDialog, CloudTownList, type Ask } from './account';
import { Hud, type Bus, type VisitInfo } from './hud';
import { NewGame } from './newgame';
import { num } from './util';
import { WorldScreen } from './world';

type Screen =
  | { k: 'menu' } | { k: 'new' } | { k: 'loading'; p: Progress } | { k: 'game' } | { k: 'error'; message: string }
  | { k: 'world'; focus?: string };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Gives the account a moment to connect before deciding which copy of a town to open. */
const cloudReady = () => (cloudConfigured ? Promise.race([startCloud(), wait(4000)]) : Promise.resolve());

export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'menu' });
  const [game, setGame] = useState<Game | null>(null);
  const [view, setView] = useState<WorldView | null>(null);
  const [report, setReport] = useState<AwayReport | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [catching, setCatching] = useState<Progress | null>(null);
  const [notice, setNotice] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  /** The other player's town being visited, if the game on screen is a visit. */
  const [visit, setVisit] = useState<{ town: WorldTown; info: VisitInfo } | null>(null);
  const busRef = useRef<Bus>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const gameRef = useRef<Game | null>(null);
  const syncRef = useRef<CloudSync | null>(null);

  useEffect(() => { void startCloud(); }, []);

  useEffect(() => {
    if (!game || screen.k !== 'game') return;
    const el = document.getElementById('viewport')!;
    let v: WorldView;
    try {
      v = new WorldView(el, { getSim: () => game.sim.sim, onFrame: (dt) => game.frame(dt) }, {
        select: (s) => busRef.current.select?.(s),
        place: (x, y) => busRef.current.place?.(x, y),
        route: (t) => busRef.current.route?.(t),
        zone: (t) => busRef.current.zone?.(t),
        demolish: (t) => busRef.current.demolish?.(t),
      });
    } catch (e) {
      setScreen({ k: 'error', message: `The 3D view could not start (${e instanceof Error ? e.message : String(e)}). This game needs a browser with WebGL enabled.` });
      return;
    }
    setView(v);
    // opt-in handle for automated browser checks (?debug in the URL); not used by the game itself
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __mandate?: unknown }).__mandate = { game, view: v };
    // a visitor coming back to the tab sees the town caught up, without a "while you were away" report meant for its mayor
    const detach = game.attachLifecycle((r) => { setCatching(null); if (!game.visiting) setReport(r); }, (p) => setCatching(p.done >= p.total ? null : p));
    return () => { detach(); v.dispose(); setView(null); };
  }, [game, screen.k]);

  const progress = (p: Progress) => setScreen({ k: 'loading', p });
  const fail = (e: unknown) => setScreen({ k: 'error', message: errText(e) });

  /** Shows a town and keeps its cloud copy in step. `leased`: it was claimed for this device as it opened. */
  const start = (g: Game, r: AwayReport | null, brief: boolean, leased: boolean) => {
    const sync = new CloudSync(g, leased);
    const id = g.state.meta.id, name = g.state.meta.name;
    sync.onLost = () => setAsk({
      k: 'lost', name,
      onTakeOver: () => { setAsk(null); void open(autoKey(id), { force: true }); },
      onMenu: () => { setAsk(null); void menu(); },
    });
    sync.onConflict = (claim) => setAsk(conflictAsk(id, name, claim, {
      onCloud: async () => { await leave(); await fromCloud(id, claim, true); },
      onMine: () => { void sync.upload(true); },
    }));
    gameRef.current = g;
    syncRef.current = sync;
    sync.start();
    setReport(r);
    setBriefing(brief);
    setGame(g);
    setScreen({ k: 'game' });
  };

  const leave = async () => {
    const g = gameRef.current, sync = syncRef.current;
    gameRef.current = null;
    syncRef.current = null;
    if (g) await g.save('Autosave'); // a visit saves nothing
    if (sync) await sync.stop();
    setGame(null);
    setVisit(null);
    setReport(null);
    setBriefing(false);
    setCatching(null);
  };

  /** Leaves whatever is open (saving the player's own town) and shows the world map. */
  const goWorld = async (focus?: string) => { await leave(); setScreen({ k: 'world', focus }); };

  /** Downloads another player's town and opens it read-only. Nothing about the visit is saved. */
  const visitOther = async (t: WorldTown) => {
    await leave();
    progress({ label: `Travelling to ${t.name}`, done: 0, total: 1 });
    try {
      const v = await within(visitTown(t), 90_000, 'The download');
      const g = await Game.visit(v.state, progress);
      gameRef.current = g;
      syncRef.current = null;
      setVisit({ town: t, info: { mayor: v.mayor, savedAt: v.savedAt, playing: v.playing } });
      setReport(null);
      setBriefing(false);
      setGame(g);
      setScreen({ k: 'game' });
    } catch (e) {
      setScreen({ k: 'world', focus: t.id });
      setNotice(`Could not visit ${t.name}: ${errText(e)}`);
    }
  };

  /** Plays one of the player's own towns picked on the world map: this device's copy if it has one, else the account's. */
  const openMine = async (worldId: string) => {
    const local = (await listSaves().catch(() => [] as SaveMeta[])).find((s) => s.worldId === worldId && s.kind === 'auto');
    if (local) return open(local.key);
    const t = cloud().towns.find((x) => x.worldId === worldId);
    if (t) return openCloud(t);
    setNotice('That town is not on this device, and your account’s list of towns has not loaded yet. Try again in a moment.');
  };

  const conflictAsk = (worldId: string, name: string, claim: Claim, act: { onCloud(): Promise<void> | void; onMine(): void }, local?: SaveMeta): Ask => ({
    k: 'conflict', name,
    cloud: { savedAt: claim.savedAt, date: cloud().towns.find((t) => t.worldId === worldId)?.date ?? '' },
    mine: { savedAt: local?.savedAt ?? gameRef.current?.lastSaved ?? null, date: local?.date ?? '' },
    onCloud: () => { setAsk(null); void act.onCloud(); },
    onMine: () => { setAsk(null); act.onMine(); },
    onCancel: local ? () => setAsk(null) : undefined,
  });

  const busyAsk = (name: string, claim: Claim, takeOver: () => void): Ask => ({
    k: 'busy', name, until: claim.leaseUntil,
    onTakeOver: () => { setAsk(null); takeOver(); },
    onCancel: () => setAsk(null),
  });

  /** Opens the copy stored on this device. */
  const openKey = async (key: string, catchUp: boolean, leased: boolean) => {
    progress({ label: 'Opening the archive', done: 0, total: 1 });
    try {
      const { game: g, report: r, recovered } = await Game.open(key, progress, catchUp);
      if (recovered) setNotice(`The latest save could not be read, so the world was restored from the ${recovered.kind} saved ${new Date(recovered.savedAt).toLocaleString()}.`);
      start(g, r, false, leased);
    } catch (e) { fail(e); }
  };

  /** Downloads the account's latest copy of a town (keeping this device's copy when asked), then opens it. */
  const fromCloud = async (worldId: string, claim: Claim, keepThisCopy: boolean) => {
    progress({ label: 'Downloading the latest copy from your account', done: 0, total: 1 });
    try { await fetchCloud(worldId, claim, keepThisCopy); } catch (e) { fail(e); return; }
    await openKey(autoKey(worldId), true, true);
  };

  /**
   * Opens a town from this device. With an account it first claims the town (only one device plays it at a time) and
   * checks whether the account holds newer play. `catchUp: false` loads an older copy on purpose (rewinds the town).
   */
  const open = async (key: string, o: { catchUp?: boolean; force?: boolean } = {}) => {
    const catchUp = o.catchUp ?? true;
    await leave();
    progress({ label: 'Checking your account for a newer copy', done: 0, total: 1 });
    const local = (await listSaves().catch(() => [] as SaveMeta[])).find((s) => s.key === key);
    const worldId = local?.worldId ?? key.split(':')[1] ?? '';
    const name = local?.name ?? 'This town';
    await cloudReady();
    const plan = await planOpen(worldId, true, { force: o.force, rewind: !catchUp });
    switch (plan.k) {
      case 'busy':
        setScreen({ k: 'menu' });
        setAsk(busyAsk(name, plan.claim, () => void open(key, { ...o, force: true })));
        return;
      case 'conflict':
        setScreen({ k: 'menu' });
        setAsk(conflictAsk(worldId, name, plan.claim, {
          onCloud: () => fromCloud(worldId, plan.claim, true),
          onMine: () => { keepMine(worldId, plan.claim); void openKey(key, catchUp, true); },
        }, local));
        return;
      case 'cloud': return fromCloud(worldId, plan.claim, false);
      default: return openKey(key, catchUp, plan.k === 'local');
    }
  };

  /** Opens a town that is only in the account, not on this device. */
  const openCloud = async (town: CloudTown, force = false) => {
    await leave();
    progress({ label: 'Checking your account', done: 0, total: 1 });
    const plan = await planOpen(town.worldId, false, { force });
    if (plan.k === 'busy') { setScreen({ k: 'menu' }); setAsk(busyAsk(town.name, plan.claim, () => void openCloud(town, true))); return; }
    if (plan.k === 'cloud' || plan.k === 'conflict') return fromCloud(town.worldId, plan.claim, false);
    setScreen({ k: 'menu' });
    setNotice(plan.k === 'offline' ? `Your account could not be reached${plan.reason ? ` (${plan.reason})` : ''}. Try again in a moment.` : 'There is no copy of that town in your account yet.');
  };

  const create = async (o: NewWorldOptions) => {
    progress({ label: 'Preparing', done: 0, total: 1 });
    try {
      const g = await Game.create(o, progress);
      await cloudReady();
      const plan = await planOpen(g.state.meta.id, true);
      start(g, null, true, plan.k === 'local');
    } catch (e) { fail(e); }
  };

  const menu = async () => { await leave(); setScreen({ k: 'menu' }); };

  const exportWorld = async () => {
    if (!game) return;
    const { blob, filename } = await game.exportFile();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    await leave();
    progress({ label: 'Reading the file', done: 0, total: 1 });
    try {
      const { game: g, report: r } = await Game.fromFile(f, progress);
      await cloudReady();
      // an imported file is a deliberate choice: it becomes the latest copy of that town
      const plan = await planOpen(g.state.meta.id, true, { rewind: true });
      start(g, r, false, plan.k === 'local');
    } catch (err) { fail(err); }
  };

  return (
    <>
      {screen.k === 'menu' && <Menu onNew={() => setScreen({ k: 'new' })} onOpen={(k) => void open(k)} onOpenCloud={(t) => void openCloud(t)} onImport={() => fileRef.current?.click()}
        onWorld={() => setScreen({ k: 'world' })} />}
      {screen.k === 'new' && <NewGame onCreate={(o) => void create(o)} onBack={() => setScreen({ k: 'menu' })} />}
      {screen.k === 'world' && <WorldScreen focus={screen.focus} onBack={() => setScreen({ k: 'menu' })} onVisit={(t) => void visitOther(t)} onOpenMine={(id) => void openMine(id)} />}
      {screen.k === 'loading' && <Loading p={screen.p} />}
      {screen.k === 'error' && (
        <main class="screen">
          <div class="screen-card" role="alert">
            <h1>Something went wrong</h1>
            <p>{screen.message}</p>
            <div class="buttons"><button class="primary" onClick={() => setScreen({ k: 'menu' })}>Back to the menu</button></div>
          </div>
        </main>
      )}
      {screen.k === 'game' && game && (
        <Hud game={game} view={view} bus={busRef.current} report={report} clearReport={() => setReport(null)} briefing={briefing} clearBriefing={() => setBriefing(false)}
          catching={catching} onMenu={() => void menu()} onLoad={(k) => void open(k, { catchUp: false })} onExport={() => void exportWorld()} onImport={() => fileRef.current?.click()}
          visit={visit?.info ?? null} onLeaveVisit={() => void goWorld(visit?.town.id)} onWorld={cloudConfigured ? () => void goWorld() : undefined} />
      )}
      <input ref={fileRef} type="file" accept=".mandate,.json,.gz,application/gzip,application/json" class="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} />
      {notice && (
        <div class="notice panel" role="alert">
          <p>{notice}</p>
          <button class="small" onClick={() => setNotice('')}>OK</button>
        </div>
      )}
      {ask && <CloudDialog ask={ask} />}
    </>
  );
}

function Loading({ p }: { p: Progress }) {
  const f = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  return (
    <main class="screen">
      <div class="screen-card" role="status" aria-live="polite">
        <h1>Mandate</h1>
        <p>{p.label}…</p>
        <div class="progress big" role="progressbar" aria-valuenow={Math.round(f * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${f * 100}%` }} /></div>
        <p class="muted small">Every farm, shop, household and truck is being simulated day by day.</p>
      </div>
    </main>
  );
}

function Menu({ onNew, onOpen, onOpenCloud, onImport, onWorld }: { onNew(): void; onOpen(key: string): void; onOpenCloud(t: CloudTown): void; onImport(): void; onWorld(): void }) {
  const c = useCloud();
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ok = storageAvailable();
  const refresh = () => (ok ? listSaves().then(setSaves).catch(() => setSaves([])) : setSaves([]));
  useEffect(() => { void refresh(); }, []);
  const worlds = new Map<string, SaveMeta>();
  for (const s of saves ?? []) {
    const cur = worlds.get(s.worldId);
    if (!cur || (s.kind === 'auto' && cur.kind !== 'auto') || (s.kind === cur.kind && s.savedAt > cur.savedAt)) worlds.set(s.worldId, s);
  }
  const last = lastPlayedKey();
  const lastWorld = [...worlds.values()].find((w) => w.key === last);
  const inCloud = (id: string) => c.phase === 'online' && c.towns.some((t) => t.worldId === id && t.path);
  const remove = async (worldId: string, everywhere: boolean) => {
    setConfirm(null);
    try {
      await deleteWorld(worldId);
      forgetLocal(worldId);
      if (everywhere && inCloud(worldId)) await deleteCloudTown(worldId);
    } catch (e) { setError(`Could not delete the cloud copy: ${errText(e)}`); }
    await refresh();
  };
  return (
    <main class="screen">
      <div class="screen-card menu">
        <h1>Mandate</h1>
        <p class="lead">A living place, and you are responsible for running it.</p>
        <p class="muted">Govern a town modelled on a real region. Farms plant and harvest with the seasons, businesses open and fail, families move in and out, and every decision works through the economy with a delay. The world keeps going while you are away.</p>
        {!ok && <p class="bad">This browser does not allow storage, so the world cannot be saved.</p>}
        <div class="buttons wrap">
          {lastWorld && <button class="primary" onClick={() => onOpen(lastWorld.key)}>Continue {lastWorld.name}</button>}
          {/* only the main action once the saves have loaded, so it does not flash before "Continue" appears */}
          <button class={saves !== null && !lastWorld ? 'primary' : ''} onClick={onNew}>New world</button>
          {cloudConfigured && <button onClick={onWorld}>World map</button>}
          <button class="ghost" onClick={onImport}>Import a world file</button>
        </div>
        {cloudConfigured && <p class="muted small">The world map shows every player's town. Visit any of them to see how its mayor is doing.</p>}
        {worlds.size > 0 && (
          <section>
            <h2>Your worlds</h2>
            <ul class="saves">
              {[...worlds.values()].map((w) => (
                <li key={w.worldId}>
                  <div>
                    <b>{w.name}</b>
                    <p class="muted small">{getPreset(w.preset).label}, {getPreset(w.preset).country} · {w.date} · {num(w.population)} residents · last played {new Date(w.savedAt).toLocaleString()}{inCloud(w.worldId) ? ' · in your account' : ''}</p>
                  </div>
                  <div class="buttons">
                    <button class="small" onClick={() => onOpen(w.key)}>Open</button>
                    {confirm === w.worldId
                      ? <>
                        <button class="danger small" onClick={() => void remove(w.worldId, true)}>{inCloud(w.worldId) ? 'Delete everywhere' : 'Delete for good'}</button>
                        {inCloud(w.worldId) && <button class="ghost small" onClick={() => void remove(w.worldId, false)}>Only from this device</button>}
                        <button class="ghost small" onClick={() => setConfirm(null)}>Keep</button>
                      </>
                      : <button class="ghost small" onClick={() => setConfirm(w.worldId)}>Delete</button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <CloudTownList localIds={new Set(worlds.keys())} onOpen={onOpenCloud}
          onDelete={async (t) => { try { await deleteCloudTown(t.worldId); } catch (e) { setError(`Could not delete it: ${errText(e)}`); } }} />
        {error && <p class="bad small" role="alert">{error}</p>}
        <AccountPanel />
      </div>
    </main>
  );
}
