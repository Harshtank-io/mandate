// Top-level screens: main menu, new world, loading, the game itself, and errors.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Game, type AwayReport, type Progress } from '../game/game';
import { deleteWorld, lastPlayedKey, listSaves, storageAvailable, type SaveMeta } from '../game/persist';
import { WorldView } from '../render/view';
import { getPreset } from '../sim/presets';
import type { NewWorldOptions } from '../sim/worldgen';
import { Hud, type Bus } from './hud';
import { NewGame } from './newgame';
import { num } from './util';

type Screen = { k: 'menu' } | { k: 'new' } | { k: 'loading'; p: Progress } | { k: 'game' } | { k: 'error'; message: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'menu' });
  const [game, setGame] = useState<Game | null>(null);
  const [view, setView] = useState<WorldView | null>(null);
  const [report, setReport] = useState<AwayReport | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [catching, setCatching] = useState<Progress | null>(null);
  const [notice, setNotice] = useState('');
  const busRef = useRef<Bus>({});
  const fileRef = useRef<HTMLInputElement>(null);

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
      });
    } catch (e) {
      setScreen({ k: 'error', message: `The 3D view could not start (${e instanceof Error ? e.message : String(e)}). This game needs a browser with WebGL enabled.` });
      return;
    }
    setView(v);
    // opt-in handle for automated browser checks (?debug in the URL); not used by the game itself
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __mandate?: unknown }).__mandate = { game, view: v };
    const detach = game.attachLifecycle((r) => { setCatching(null); setReport(r); }, (p) => setCatching(p.done >= p.total ? null : p));
    return () => { detach(); v.dispose(); setView(null); };
  }, [game, screen.k]);

  const progress = (p: Progress) => setScreen({ k: 'loading', p });
  const fail = (e: unknown) => setScreen({ k: 'error', message: e instanceof Error ? e.message : String(e) });
  const start = (g: Game, r: AwayReport | null, brief: boolean) => { setReport(r); setBriefing(brief); setGame(g); setScreen({ k: 'game' }); };

  const leave = async () => {
    if (game) await game.save('Autosave');
    setGame(null);
    setReport(null);
    setBriefing(false);
    setCatching(null);
  };

  const create = async (o: NewWorldOptions) => {
    progress({ label: 'Preparing', done: 0, total: 1 });
    try { start(await Game.create(o, progress), null, true); } catch (e) { fail(e); }
  };

  const open = async (key: string, catchUp = true) => {
    await leave();
    progress({ label: 'Opening the archive', done: 0, total: 1 });
    try {
      const { game: g, report: r, recovered } = await Game.open(key, progress, catchUp);
      if (recovered) setNotice(`The latest save could not be read, so the world was restored from the ${recovered.kind} saved ${new Date(recovered.savedAt).toLocaleString()}.`);
      start(g, r, false);
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
    try { const { game: g, report: r } = await Game.fromFile(f, progress); start(g, r, false); } catch (err) { fail(err); }
  };

  return (
    <>
      {screen.k === 'menu' && <Menu onNew={() => setScreen({ k: 'new' })} onOpen={(k) => void open(k)} onImport={() => fileRef.current?.click()} />}
      {screen.k === 'new' && <NewGame onCreate={(o) => void create(o)} onBack={() => setScreen({ k: 'menu' })} />}
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
          catching={catching} onMenu={() => void menu()} onLoad={(k) => void open(k, false)} onExport={() => void exportWorld()} onImport={() => fileRef.current?.click()} />
      )}
      <input ref={fileRef} type="file" accept=".mandate,.json,.gz,application/gzip,application/json" class="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} />
      {notice && (
        <div class="notice panel" role="alert">
          <p>{notice}</p>
          <button class="small" onClick={() => setNotice('')}>OK</button>
        </div>
      )}
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

function Menu({ onNew, onOpen, onImport }: { onNew(): void; onOpen(key: string): void; onImport(): void }) {
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
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
  return (
    <main class="screen">
      <div class="screen-card">
        <h1>Mandate</h1>
        <p class="lead">A living place, and you are responsible for running it.</p>
        <p class="muted">Govern a town modelled on a real region. Farms plant and harvest with the seasons, businesses open and fail, families move in and out, and every decision works through the economy with a delay. The world keeps going while you are away.</p>
        {!ok && <p class="bad">This browser does not allow storage, so the world cannot be saved.</p>}
        <div class="buttons wrap">
          {lastWorld && <button class="primary" onClick={() => onOpen(lastWorld.key)}>Continue {lastWorld.name}</button>}
          <button class={lastWorld ? '' : 'primary'} onClick={onNew}>New world</button>
          <button class="ghost" onClick={onImport}>Import a world file</button>
        </div>
        {worlds.size > 0 && (
          <section>
            <h2>Your worlds</h2>
            <ul class="saves">
              {[...worlds.values()].map((w) => (
                <li key={w.worldId}>
                  <div>
                    <b>{w.name}</b>
                    <p class="muted small">{getPreset(w.preset).label}, {getPreset(w.preset).country} · {w.date} · {num(w.population)} residents · last played {new Date(w.savedAt).toLocaleString()}</p>
                  </div>
                  <div class="buttons">
                    <button class="small" onClick={() => onOpen(w.key)}>Open</button>
                    {confirm === w.worldId
                      ? <><button class="danger small" onClick={() => { void deleteWorld(w.worldId).then(refresh); setConfirm(null); }}>Delete for good</button><button class="ghost small" onClick={() => setConfirm(null)}>Keep</button></>
                      : <button class="ghost small" onClick={() => setConfirm(w.worldId)}>Delete</button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
