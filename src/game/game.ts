// The running game: owns the simulation, the live clock, offline catch-up and saving.
// The world runs at its chosen pace whenever the game is closed; when it is open the player can pause or speed it up.

import { MIN_PER_DAY } from '../sim/calendar';
import { Simulation } from '../sim/simulation';
import { snapshot, summarize, type AwaySummary } from '../sim/summary';
import type { WorldState } from '../sim/types';
import type { NewWorldOptions } from '../sim/worldgen';
import { decode, encode, putSave, readWithRecovery, rotateBackup, type SaveMeta } from './persist';

export interface Progress { label: string; done: number; total: number }
export type ProgressFn = (p: Progress) => void;
export interface AwayReport extends AwaySummary { realMs: number; cappedDays?: number }

const AUTOSAVE_MS = 60_000;
/** The most simulated time a visit catches up when it opens a town (its mayor's own game catches up the rest). */
const VISIT_CATCH_UP_DAYS = 365;
const BACKUP_MS = 10 * 60_000;
const MAX_FRAME_MINUTES = 3 * MIN_PER_DAY;

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Advances the simulation to `target` in slices of whole days so the page stays responsive. */
export async function runChunked(sim: Simulation, target: number, label: string, onProgress?: ProgressFn, budgetMs = 40): Promise<void> {
  const start = sim.state.minute;
  const total = Math.max(1, target - start);
  onProgress?.({ label, done: 0, total });
  while (sim.state.minute < target) {
    const t0 = performance.now();
    while (sim.state.minute < target && performance.now() - t0 < budgetMs) {
      const nextMidnight = (Math.floor(sim.state.minute / MIN_PER_DAY) + 1) * MIN_PER_DAY;
      sim.advanceTo(Math.min(target, nextMidnight));
    }
    onProgress?.({ label, done: sim.state.minute - start, total });
    await yieldToUi();
  }
}

export class Game {
  sim: Simulation;
  /** Multiplier on the world's pace; 0 = paused. */
  speed = 1;
  busy = false;
  /** Set when another device has taken this town over: time stops here and nothing more is saved. */
  locked = false;
  /**
   * A visit to another player's town: time runs here for the visitor, but nothing is ever saved on this device or
   * uploaded, so the visit cannot change the town or leave a copy of it behind.
   */
  readonly visiting: boolean;
  /** Called after every successful save to this device (used by cloud sync). */
  onSaved?: () => void;
  version = 0;
  lastSaved = 0;
  saveError = '';
  private saving = false;
  private lastAutosave = Date.now();
  private lastBackup = Date.now();
  private hiddenAt = 0;

  constructor(sim: Simulation, visiting = false) {
    this.sim = sim;
    this.visiting = visiting;
  }

  get state(): WorldState { return this.sim.state; }

  /** Generates a region and simulates its year of history before the player takes office. */
  static async create(o: NewWorldOptions, onProgress?: ProgressFn): Promise<Game> {
    onProgress?.({ label: 'Surveying the region', done: 0, total: 1 });
    await yieldToUi();
    const s = Simulation.generate(o);
    await runChunked(s, s.officeMinute(), 'Simulating the year before you take office', onProgress);
    s.takeOffice();
    s.state.meta.lastReal = Date.now();
    const g = new Game(s);
    await g.save('Autosave');
    return g;
  }

  /**
   * Loads a saved world. With `catchUp` (the default, used for "Continue") the time that passed while it was closed
   * is simulated; without it (loading an older copy) the world resumes from the moment that copy was saved.
   */
  static async open(key: string, onProgress?: ProgressFn, catchUp = true): Promise<{ game: Game; report: AwayReport | null; recovered?: SaveMeta }> {
    onProgress?.({ label: 'Opening the archive', done: 0, total: 1 });
    const { state, recoveredFrom } = await readWithRecovery(key);
    if (!catchUp) state.meta.lastReal = Date.now();
    const g = new Game(Simulation.fromState(state));
    const report = await g.catchUp(onProgress);
    await g.save('Autosave');
    return { game: g, report, recovered: recoveredFrom };
  }

  /** Imports an exported world file. Time since the export is caught up like any other absence. */
  static async fromFile(file: Blob, onProgress?: ProgressFn): Promise<{ game: Game; report: AwayReport | null }> {
    const state = await decode(file);
    const g = new Game(Simulation.fromState(state));
    const report = await g.catchUp(onProgress);
    await g.save('Imported');
    return { game: g, report };
  }

  /**
   * Opens another player's town to look around in. The time since its mayor last saved it is caught up as their own
   * game would, but by at most `VISIT_CATCH_UP_DAYS`, so a town left alone for months still opens quickly.
   */
  static async visit(state: WorldState, onProgress?: ProgressFn): Promise<Game> {
    const g = new Game(Simulation.fromState(state), true);
    await g.catchUp(onProgress, { label: `Catching up on ${state.meta.name} since its mayor last saved it`, maxDays: VISIT_CATCH_UP_DAYS });
    return g;
  }

  /** Simulates the real time elapsed since the state was last saved, at the world's pace (1x). */
  async catchUp(onProgress?: ProgressFn, o: { label?: string; maxDays?: number } = {}): Promise<AwayReport | null> {
    const meta = this.state.meta;
    const now = Date.now();
    const realMs = Math.max(0, now - meta.lastReal);
    let minutes = (realMs / 1000) * meta.pace;
    const capDays = Math.min(meta.offlineCapDays > 0 ? meta.offlineCapDays : Infinity, o.maxDays ?? Infinity);
    const cap = Number.isFinite(capDays) ? capDays * MIN_PER_DAY : Infinity;
    const capped = minutes > cap;
    if (capped) minutes = cap;
    meta.lastReal = now;
    if (minutes < 1) return null;
    const before = snapshot(this.sim.sim);
    this.busy = true;
    try {
      await runChunked(this.sim, this.state.minute + minutes, o.label ?? 'Catching up on what happened while you were away', onProgress);
    } finally {
      this.busy = false;
    }
    meta.lastReal = Date.now();
    this.version++;
    if (minutes < MIN_PER_DAY / 4) return null;
    const report: AwayReport = { ...summarize(this.sim.sim, before), realMs };
    if (capped) report.cappedDays = capDays;
    return report;
  }

  get isSaving(): boolean { return this.saving; }

  /** Called once per animation frame with the real milliseconds since the last frame. */
  frame(realMs: number): void {
    if (this.busy || this.locked) return;
    // slow frames still advance the world by the real time that passed (up to a second; longer gaps are
    // absences, handled by catch-up when the tab becomes visible again)
    const dt = Math.min(Math.max(0, realMs), 1000);
    const meta = this.state.meta;
    if (this.speed > 0) {
      const minutes = Math.min((dt / 1000) * meta.pace * this.speed, MAX_FRAME_MINUTES);
      if (minutes > 0) { this.sim.advanceTo(this.state.minute + minutes); this.version++; }
    }
    meta.playedMs += dt;
    if (this.visiting) return;
    const now = Date.now();
    if (now - this.lastAutosave > AUTOSAVE_MS) void this.save('Autosave');
    if (now - this.lastBackup > BACKUP_MS) {
      this.lastBackup = now;
      void rotateBackup(this.state).catch((e) => { this.saveError = String(e); });
    }
  }

  async save(label = 'Autosave'): Promise<SaveMeta | null> {
    if (this.saving || this.locked || this.visiting) return null;
    this.saving = true;
    this.lastAutosave = Date.now();
    this.state.meta.lastReal = Date.now();
    try {
      const meta = await putSave(this.state, 'auto', label);
      this.lastSaved = Date.now();
      this.saveError = '';
      this.onSaved?.();
      return meta;
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      this.saving = false;
    }
  }

  async saveAs(label: string): Promise<SaveMeta> {
    if (this.visiting) throw new Error('You are visiting this town; only its mayor can save it.');
    if (this.locked) throw new Error('This town is open on another device.');
    this.state.meta.lastReal = Date.now();
    return putSave(this.state, 'manual', label || 'Manual save');
  }

  async exportFile(): Promise<{ blob: Blob; filename: string }> {
    if (this.visiting) throw new Error('You are visiting this town; only its mayor can export it.');
    this.state.meta.lastReal = Date.now();
    const { blob, enc } = await encode(this.state);
    const safe = this.state.meta.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'world';
    return { blob, filename: `${safe}-${new Date().toISOString().slice(0, 10)}.mandate${enc === 'gzip' ? '' : '.json'}` };
  }

  /**
   * Saves when the tab is hidden or closed, and catches up when it becomes visible again after more than a minute.
   * Returns a function that removes the listeners.
   */
  attachLifecycle(onAway: (r: AwayReport) => void, onProgress?: ProgressFn): () => void {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        void this.save('Autosave');
      } else if (this.hiddenAt) {
        const away = Date.now() - this.hiddenAt;
        this.hiddenAt = 0;
        if (away > 60_000 && !this.locked) {
          this.state.meta.lastReal = Date.now() - away;
          void this.catchUp(onProgress).then((r) => { if (r) onAway(r); });
        }
      }
    };
    const onHide = () => { this.state.meta.lastReal = Date.now(); void this.save('Autosave'); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    };
  }
}
