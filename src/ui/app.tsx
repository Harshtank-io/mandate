// Top-level screens: the landing page, the world map of Meridia (the hub: your towns, other mayors' towns, founding a
// new one), loading, the game itself, and errors. Every page has its own address (see route.ts): a reload or a shared
// link opens the same page, and Back/Forward move between pages. Opening, creating and leaving a town also keep its
// cloud copy in step (see net/sync.ts) when the player has an account.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Game, type AwayReport, type Progress } from '../game/game';
import { autoKey, listSaves, type SaveMeta } from '../game/persist';
import { startCloud } from '../net/auth';
import { cloudConfigured, errText, within } from '../net/client';
import type { Claim } from '../net/saves';
import { cloud, type CloudTown } from '../net/store';
import { CloudSync, fetchCloud, keepMine, planOpen } from '../net/sync';
import { cachedWorld, fetchWorld, visitTown, type WorldTown } from '../net/world';
import { WorldView } from '../render/view';
import type { NewWorldOptions } from '../sim/worldgen';
import { CloudDialog, type Ask } from './account';
import { Hud, type Bus, type VisitInfo } from './hud';
import { Landing } from './landing';
import { firstRoute, nav, onRouteChange, parseRoute, type Route } from './route';
import { WORLD_NAME, WorldScreen } from './world';

type Screen =
  | { k: 'landing' } | { k: 'loading'; p: Progress } | { k: 'game' } | { k: 'error'; message: string }
  | { k: 'world'; focus?: string };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Gives the account a moment to connect before deciding which copy of a town to open. */
const cloudReady = () => (cloudConfigured ? Promise.race([startCloud(), wait(4000)]) : Promise.resolve());

/** What shows first for the page in the address bar (a town or a visit opens once the app has started). */
function firstScreen(r: Route): Screen {
  if (r.k === 'landing') return { k: 'landing' };
  if (r.k === 'world') return { k: 'world' };
  return { k: 'loading', p: { label: r.k === 'town' ? 'Opening your town' : 'Finding the town', done: 0, total: 1 } };
}

export function App() {
  const [screen, setScreen] = useState<Screen>(() => firstScreen(firstRoute()));
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
  /** The town or the visit on screen, as a page. */
  const shownRef = useRef<{ k: 'town' | 'visit'; id: string } | null>(null);
  /** The last save and upload of the town being left. The next town waits for them, so its claim is not handed back. */
  const leavingRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Each trip to another page takes the next ticket. A town that finishes loading after the player has set off
   * elsewhere (Back or Forward while it loads) is dropped instead of shown; it has saved itself already.
   */
  const ticket = useRef(0);
  const homeTitle = useRef(document.title);

  const trip = () => ++ticket.current;
  const live = (t: number) => t === ticket.current;

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

  // the browser tab and the history list name the page
  useEffect(() => {
    if (screen.k === 'landing') document.title = homeTitle.current;
    else if (screen.k === 'world') document.title = `${WORLD_NAME} · Mandate`;
    else if (screen.k === 'game' && game) document.title = `${game.state.meta.name}${visit ? ' (visiting)' : ''} · Mandate`;
  }, [screen.k, game, visit]);

  /** Shows how the load of trip `t` is going, unless the player has gone elsewhere since. */
  const progress = (t: number) => (p: Progress) => { if (live(t)) setScreen({ k: 'loading', p }); };
  const fail = (t: number, e: unknown) => { if (live(t)) setScreen({ k: 'error', message: errText(e) }); };

  const showLanding = () => { setScreen({ k: 'landing' }); nav({ k: 'landing' }); };
  /** Shows the world map. `replace`: in place of the page in the address bar (a town that could not be opened). */
  const showWorld = (focus?: string, replace = false) => { setScreen({ k: 'world', focus }); nav({ k: 'world' }, replace); };

  /** Shows a town and keeps its cloud copy in step. `leased`: it was claimed for this device as it opened. */
  const start = (g: Game, r: AwayReport | null, brief: boolean, leased: boolean, t: number) => {
    if (!live(t)) return; // the player went elsewhere while it loaded; an unused claim simply expires
    const sync = new CloudSync(g, leased);
    const id = g.state.meta.id, name = g.state.meta.name;
    sync.onLost = () => setAsk({
      k: 'lost', name,
      onTakeOver: () => { setAsk(null); void open(autoKey(id), { force: true }); },
      onMenu: () => { setAsk(null); void menu(); },
    });
    sync.onConflict = (claim) => setAsk(conflictAsk(id, name, claim, {
      onCloud: async () => { const t2 = trip(); await leave(t2); if (live(t2)) await fromCloud(id, claim, true, t2); },
      onMine: () => { void sync.upload(true); },
    }));
    gameRef.current = g;
    syncRef.current = sync;
    shownRef.current = { k: 'town', id };
    sync.start();
    setVisit(null);
    setReport(r);
    setBriefing(brief);
    setCatching(null);
    setGame(g);
    setScreen({ k: 'game' });
    nav({ k: 'town', id });
  };

  /**
   * Closes the town on screen for trip `t`: saves it (a visit saves nothing) and hands its claim back, after any
   * earlier leave has finished. The town stays on screen meanwhile.
   */
  const leave = async (t: number) => {
    const g = gameRef.current, sync = syncRef.current;
    gameRef.current = null;
    syncRef.current = null;
    shownRef.current = null;
    const earlier = leavingRef.current;
    const done = (async () => {
      await earlier;
      if (g) await g.save('Autosave');
      if (sync) await sync.stop();
    })().catch(() => { /* a failed save is reported by the save itself */ });
    leavingRef.current = done;
    await done;
    if (!live(t)) return; // a newer trip sets up the screen
    setGame(null);
    setVisit(null);
    setReport(null);
    setBriefing(false);
    setCatching(null);
  };

  /** Leaves whatever is open (saving the player's own town) and shows the world map, with `focus` selected. */
  const goWorld = async (focus?: string, replace = false) => {
    const t = trip();
    await leave(t);
    if (live(t)) showWorld(focus, replace);
  };

  const goHome = async () => {
    const t = trip();
    await leave(t);
    if (live(t)) showLanding();
  };

  /** Leaves the town on screen for the world map, showing that town there. */
  const menu = () => goWorld(gameRef.current?.state.meta.id);

  /** Downloads another player's town and opens it read-only. Nothing about the visit is saved. */
  const visitOther = async (town: WorldTown, t = trip()) => {
    await leave(t);
    if (!live(t)) return;
    progress(t)({ label: `Travelling to ${town.name}`, done: 0, total: 1 });
    try {
      const v = await within(visitTown(town), 90_000, 'The download');
      if (!live(t)) return;
      const g = await Game.visit(v.state, progress(t));
      if (!live(t)) return;
      gameRef.current = g;
      syncRef.current = null;
      shownRef.current = { k: 'visit', id: town.id };
      setVisit({ town, info: { mayor: v.mayor, savedAt: v.savedAt, playing: v.playing } });
      setReport(null);
      setBriefing(false);
      setCatching(null);
      setGame(g);
      setScreen({ k: 'game' });
      nav({ k: 'visit', id: town.id });
    } catch (e) {
      if (!live(t)) return;
      showWorld(town.id, true);
      setNotice(`Could not visit ${town.name}: ${errText(e)}`);
    }
  };

  /** Opens a visit from its address (a reload or a shared link): looks the town up on the world map first. */
  const visitById = async (id: string, t = trip()) => {
    progress(t)({ label: 'Finding the town', done: 0, total: 1 });
    await cloudReady();
    if (!live(t)) return;
    let town: WorldTown | undefined;
    let problem = !cloudConfigured ? 'Visiting other towns needs the world server, and this copy of the game has none.'
      : cloud().phase !== 'online' ? 'The world server could not be reached, so that town cannot be visited right now.' : '';
    if (!problem) {
      const find = (ts: WorldTown[] | undefined) => ts?.find((x) => x.id === id);
      try { town = find(cachedWorld()?.towns) ?? find(await within(fetchWorld(), 15_000, 'The world map')); } catch (e) { problem = `Could not find that town: ${errText(e)}`; }
      if (!live(t)) return;
      if (!town && !problem) problem = `That town is no longer on the map of ${WORLD_NAME}.`;
    }
    // a link to a visit of the player's own town opens it to play
    if (town?.mine && town.worldId) { nav({ k: 'town', id: town.worldId }, true); return openMine(town.worldId, t); }
    if (town) return visitOther(town, t);
    showWorld(undefined, true);
    setNotice(problem);
  };

  /** Plays one of the player's own towns: this device's copy if it has one, else the account's. */
  const openMine = async (worldId: string, t = trip()) => {
    progress(t)({ label: 'Opening your town', done: 0, total: 1 });
    const local = (await listSaves().catch(() => [] as SaveMeta[])).find((s) => s.worldId === worldId && s.kind === 'auto');
    if (!live(t)) return;
    if (local) return open(local.key, {}, t);
    if (cloudConfigured && !cloud().towns.some((x) => x.worldId === worldId)) {
      // the account's list of towns may not have loaded yet (always so right after a reload)
      progress(t)({ label: 'Looking for the town in your account', done: 0, total: 1 });
      await cloudReady();
      if (!live(t)) return;
    }
    const town = cloud().towns.find((x) => x.worldId === worldId);
    if (town) return openCloud(town, false, t);
    showWorld(undefined, true);
    setNotice(!cloudConfigured ? 'That town is not saved on this device.'
      : cloud().phase === 'online' ? 'That town is not on this device or in your account.'
      : 'That town is not on this device, and your account could not be reached. Try again in a moment.');
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
  const openKey = async (key: string, catchUp: boolean, leased: boolean, t = trip()) => {
    progress(t)({ label: 'Opening the archive', done: 0, total: 1 });
    try {
      const { game: g, report: r, recovered } = await Game.open(key, progress(t), catchUp);
      if (!live(t)) return;
      if (recovered) setNotice(`The latest save could not be read, so the world was restored from the ${recovered.kind} saved ${new Date(recovered.savedAt).toLocaleString()}.`);
      start(g, r, false, leased, t);
    } catch (e) { fail(t, e); }
  };

  /** Downloads the account's latest copy of a town (keeping this device's copy when asked), then opens it. */
  const fromCloud = async (worldId: string, claim: Claim, keepThisCopy: boolean, t = trip()) => {
    progress(t)({ label: 'Downloading the latest copy from your account', done: 0, total: 1 });
    try { await fetchCloud(worldId, claim, keepThisCopy); } catch (e) { fail(t, e); return; }
    if (live(t)) await openKey(autoKey(worldId), true, true, t);
  };

  /**
   * Opens a town from this device. With an account it first claims the town (only one device plays it at a time) and
   * checks whether the account holds newer play. `catchUp: false` loads an older copy on purpose (rewinds the town).
   */
  const open = async (key: string, o: { catchUp?: boolean; force?: boolean } = {}, t = trip()) => {
    const catchUp = o.catchUp ?? true;
    await leave(t);
    if (!live(t)) return;
    progress(t)({ label: 'Checking your account for a newer copy', done: 0, total: 1 });
    const local = (await listSaves().catch(() => [] as SaveMeta[])).find((s) => s.key === key);
    const worldId = local?.worldId ?? key.split(':')[1] ?? '';
    const name = local?.name ?? 'This town';
    await cloudReady();
    if (!live(t)) return;
    const plan = await planOpen(worldId, true, { force: o.force, rewind: !catchUp });
    if (!live(t)) return;
    switch (plan.k) {
      case 'busy':
        showWorld(undefined, true);
        setAsk(busyAsk(name, plan.claim, () => void open(key, { ...o, force: true })));
        return;
      case 'conflict':
        showWorld(undefined, true);
        setAsk(conflictAsk(worldId, name, plan.claim, {
          onCloud: () => fromCloud(worldId, plan.claim, true),
          onMine: () => { keepMine(worldId, plan.claim); void openKey(key, catchUp, true); },
        }, local));
        return;
      case 'cloud': return fromCloud(worldId, plan.claim, false, t);
      default: return openKey(key, catchUp, plan.k === 'local', t);
    }
  };

  /** Opens a town that is only in the account, not on this device. */
  const openCloud = async (town: CloudTown, force = false, t = trip()) => {
    await leave(t);
    if (!live(t)) return;
    progress(t)({ label: 'Checking your account', done: 0, total: 1 });
    const plan = await planOpen(town.worldId, false, { force });
    if (!live(t)) return;
    if (plan.k === 'busy') { showWorld(undefined, true); setAsk(busyAsk(town.name, plan.claim, () => void openCloud(town, true))); return; }
    if (plan.k === 'cloud' || plan.k === 'conflict') return fromCloud(town.worldId, plan.claim, false, t);
    showWorld(undefined, true);
    setNotice(plan.k === 'offline' ? `Your account could not be reached${plan.reason ? ` (${plan.reason})` : ''}. Try again in a moment.` : 'There is no copy of that town in your account yet.');
  };

  const create = async (o: NewWorldOptions, t = trip()) => {
    progress(t)({ label: 'Preparing', done: 0, total: 1 });
    try {
      const g = await Game.create(o, progress(t));
      if (!live(t)) return; // saved already: it waits among the player's towns on the world map
      await cloudReady();
      if (!live(t)) return;
      const plan = await planOpen(g.state.meta.id, true);
      start(g, null, true, plan.k === 'local', t);
    } catch (e) { fail(t, e); }
  };

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
    const t = trip();
    await leave(t);
    if (!live(t)) return;
    progress(t)({ label: 'Reading the file', done: 0, total: 1 });
    try {
      const { game: g, report: r } = await Game.fromFile(f, progress(t));
      if (!live(t)) return;
      await cloudReady();
      if (!live(t)) return;
      // an imported file is a deliberate choice: it becomes the latest copy of that town
      const plan = await planOpen(g.state.meta.id, true, { rewind: true });
      start(g, r, false, plan.k === 'local', t);
    } catch (err) { fail(t, err); }
  };

  /** Back or Forward: shows the page now in the address bar. */
  const followRoute = (r: Route) => {
    setAsk(null); // a question belongs to the page it was asked on
    setNotice('');
    switch (r.k) {
      case 'landing': void goHome(); return;
      case 'world': void goWorld(shownRef.current?.id); return;
      case 'town': void openMine(r.id); return;
      case 'visit': void visitById(r.id); return;
    }
  };
  const followRef = useRef(followRoute);
  followRef.current = followRoute;

  useEffect(() => {
    void startCloud();
    // a reload, a bookmark or a shared link of a town or a visit opens it
    const r = parseRoute();
    if (r.k === 'town') void openMine(r.id);
    else if (r.k === 'visit') void visitById(r.id);
    return onRouteChange((to) => followRef.current(to));
  }, []);

  return (
    <>
      {screen.k === 'landing' && <Landing onEnter={() => { trip(); showWorld(); }} />}
      {screen.k === 'world' && <WorldScreen focus={screen.focus} onHome={() => void goHome()} onVisit={(t) => void visitOther(t)}
        onOpenMine={(id) => void openMine(id)} onFound={(o) => void create(o)} onImport={() => fileRef.current?.click()} />}
      {screen.k === 'loading' && <Loading p={screen.p} />}
      {screen.k === 'error' && (
        <main class="screen">
          <div class="screen-card" role="alert">
            <h1>Something went wrong</h1>
            <p>{screen.message}</p>
            <div class="buttons"><button class="primary" onClick={() => void goWorld(undefined, true)}>Back to the world map</button></div>
          </div>
        </main>
      )}
      {screen.k === 'game' && game && (
        <Hud game={game} view={view} bus={busRef.current} report={report} clearReport={() => setReport(null)} briefing={briefing} clearBriefing={() => setBriefing(false)}
          catching={catching} onMenu={() => void menu()} onLoad={(k) => void open(k, { catchUp: false })} onExport={() => void exportWorld()} onImport={() => fileRef.current?.click()}
          visit={visit?.info ?? null} onLeaveVisit={() => void goWorld(visit?.town.id)} />
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
