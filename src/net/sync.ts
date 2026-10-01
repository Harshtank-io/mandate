// Keeps the cloud copy of the town being played in step with this device, and decides which copy to open.
//
// The cloud holds numbered revisions of each town. This device remembers which revision its own copy grew from and
// whether it has changed since ("dirty"). Only the device holding the town's lease uploads; if another device takes
// the town over, play here stops so the two copies cannot drift apart.

import type { Game } from '../game/game';
import { autoKey, encode, putSave, readSave } from '../game/persist';
import { cloudConfigured, errText, within } from './client';
import { claimTown, describe, downloadSave, refreshTowns, releaseLease, renewLease, uploadSave, type Claim } from './saves';
import { cloud, setSync } from './store';

const HEARTBEAT_MS = 60_000;
const UPLOAD_EVERY_MS = 5 * 60_000;

// ------------------------------------------------------------------------------------------------ bookkeeping

interface Local { user: string; rev: number; dirty: boolean }
const bookKey = (worldId: string) => `mandate.cloud.${worldId}`;

/** This device's bookkeeping for a town, if it was last synced with the account that is signed in now. */
export function localSync(worldId: string): Local | null {
  try {
    const raw = localStorage.getItem(bookKey(worldId));
    const l = raw ? (JSON.parse(raw) as Local) : null;
    return l && l.user === cloud().account?.id ? l : null;
  } catch { return null; }
}

function setLocal(worldId: string, rev: number, dirty: boolean): void {
  const user = cloud().account?.id;
  if (!user) return;
  try { localStorage.setItem(bookKey(worldId), JSON.stringify({ user, rev, dirty } satisfies Local)); } catch { /* ignore */ }
}

export function forgetLocal(worldId: string): void {
  try { localStorage.removeItem(bookKey(worldId)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------------------------------------ opening a town

export type Decision = 'local' | 'cloud' | 'busy' | 'conflict';

/**
 * Which copy to open. busy: another device is playing the town. cloud: the cloud has newer play and this device has
 * nothing new. conflict: both have changed since they last matched (or this copy was never synced and differs).
 */
export function decide(claim: Claim, local: Local | null, hasLocal: boolean): Decision {
  if (!claim.granted) return 'busy';
  if (!claim.path || claim.revision === 0) return 'local';
  if (!hasLocal) return 'cloud';
  if (!local) return 'conflict';
  if (claim.revision <= local.rev) return 'local';
  return local.dirty ? 'conflict' : 'cloud';
}

export type OpenPlan = { k: 'local' } | { k: 'cloud' | 'busy' | 'conflict'; claim: Claim } | { k: 'offline'; reason: string };

/**
 * Claims the town for this device and works out what to open. `rewind` means the player chose an older saved copy on
 * purpose: it becomes the latest revision. `force` takes the town over from another device.
 */
export async function planOpen(worldId: string, hasLocal: boolean, opts: { force?: boolean; rewind?: boolean } = {}): Promise<OpenPlan> {
  if (!cloudConfigured || cloud().phase !== 'online' || !cloud().account) return { k: 'offline', reason: '' };
  let claim: Claim;
  try { claim = await within(claimTown(worldId, !!opts.force), 12_000, 'Your account'); } catch (e) { return { k: 'offline', reason: errText(e) }; }
  const local = localSync(worldId);
  const d = opts.rewind && claim.granted ? 'local' : decide(claim, local, hasLocal);
  if (d !== 'local') return { k: d, claim };
  // this device's copy carries on from the cloud's latest revision
  const changed = !!opts.rewind || !local || claim.revision === 0 || claim.revision !== local.rev;
  setLocal(worldId, claim.revision, changed || local.dirty);
  return { k: 'local' };
}

/** Replaces this device's copy with the cloud's latest revision. With `keepMine`, the old copy is kept as a named save. */
export async function fetchCloud(worldId: string, claim: Claim, keepMine: boolean): Promise<void> {
  if (!claim.path) throw new Error('There is no cloud copy of this town yet.');
  if (keepMine) {
    try { await putSave(await readSave(autoKey(worldId)), 'manual', 'This device’s copy before syncing'); } catch { /* nothing to keep */ }
  }
  const state = await within(downloadSave(claim.path, claim.enc), 90_000, 'The download');
  if (state.meta.id !== worldId) throw new Error('The cloud copy belongs to a different town.');
  await putSave(state, 'auto', 'From the cloud');
  setLocal(worldId, claim.revision, false);
}

/** Resolves a conflict in favour of this device: its copy becomes the next revision. */
export function keepMine(worldId: string, claim: Claim): void { setLocal(worldId, claim.revision, true); }

// ------------------------------------------------------------------------------------------------ while playing

let active: CloudSync | null = null;

/** The sync of the town open on this device, if any. */
export function activeSync(): CloudSync | null { return active; }

export class CloudSync {
  /** Another device has taken the town over; play here has been stopped. */
  onLost?: () => void;
  /** The cloud has a revision this device did not start from; the player must choose which copy to keep. */
  onConflict?: (claim: Claim) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private lastUpload = 0;
  private pending: Promise<void> | null = null;
  private saves = 0; // local saves since the sync started
  private halted = false; // set while a conflict is unresolved
  private stopped = false;

  /** `leased`: the town was claimed for this device when it was opened (false when it was opened offline). */
  constructor(private game: Game, private leased: boolean) {}

  get worldId(): string { return this.game.state.meta.id; }

  start(): void {
    if (!cloudConfigured) return;
    active = this;
    this.game.onSaved = () => {
      this.saves++;
      const l = localSync(this.worldId);
      setLocal(this.worldId, l?.rev ?? 0, true);
      if (cloud().sync?.status === 'synced') setSync({ worldId: this.worldId, status: 'pending' });
    };
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    const l = localSync(this.worldId);
    setSync({ worldId: this.worldId, status: !this.online() ? 'offline' : l?.dirty ? 'pending' : 'synced', revision: l?.rev ?? 0, message: '' });
    void this.tick(true);
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.upload();
    else void this.tick();
  };

  private online(): boolean { return cloud().phase === 'online' && !!cloud().account; }

  private async tick(first = false): Promise<void> {
    if (this.stopped || this.game.locked || this.halted) return;
    const id = this.worldId;
    if (!this.online()) { setSync({ worldId: id, status: 'offline', message: '' }); return; }
    try {
      if (!this.leased) {
        // opened while offline: claim it now, and check nobody played it elsewhere in the meantime
        const c = await claimTown(id, false);
        if (!c.granted) { this.lose(); return; }
        const l = localSync(id);
        if (c.path && c.revision > (l?.rev ?? 0)) { this.conflict(c); return; }
        if (!l) setLocal(id, c.revision, true);
        this.leased = true;
      } else if (!(await renewLease(id))) {
        this.lose();
        return;
      }
    } catch (e) {
      setSync({ worldId: id, status: 'offline', message: errText(e) });
      return;
    }
    if (first || Date.now() - this.lastUpload >= UPLOAD_EVERY_MS) await this.upload();
  }

  /** Uploads this device's copy if it changed. `force` makes it the latest revision even after a conflict. */
  upload(force = false): Promise<void> {
    this.pending ??= this.doUpload(force).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async doUpload(force: boolean): Promise<void> {
    const id = this.worldId;
    if (this.game.locked || !this.online() || !this.leased || (this.halted && !force)) return;
    const l = localSync(id);
    if (!l || (!l.dirty && !force) || this.game.isSaving) return;
    setSync({ worldId: id, status: 'uploading', message: '' });
    try {
      // save locally and encode for the cloud at the same moment, so both copies are identical
      const seq = this.saves + 1;
      const localSave = this.game.save('Autosave');
      const meta = describe(this.game.state);
      const file = encode(this.game.state);
      const [{ blob, enc }] = await Promise.all([file, localSave]);
      const res = await uploadSave(id, blob, enc, meta, l.rev, force);
      if (res.ok) {
        const newer = this.saves > seq; // saved again while uploading
        setLocal(id, res.revision, newer);
        this.lastUpload = Date.now();
        this.halted = false;
        setSync({ worldId: id, status: newer ? 'pending' : 'synced', revision: res.revision, at: Date.now(), message: '' });
        void refreshTowns().catch(() => { /* the list refreshes next time */ });
      } else if (res.reason === 'lease') this.lose();
      else if (res.reason === 'missing') { this.leased = false; setSync({ worldId: id, status: 'pending', message: '' }); }
      else this.conflict(await claimTown(id, false));
    } catch (e) {
      setSync({ worldId: id, status: 'offline', message: errText(e) });
    }
  }

  private lose(): void {
    this.game.locked = true;
    this.game.speed = 0;
    setSync({ worldId: this.worldId, status: 'lost', message: 'This town is now open on another device.' });
    this.onLost?.();
  }

  private conflict(claim: Claim): void {
    this.halted = true;
    setSync({ worldId: this.worldId, status: 'conflict', message: 'This town was also played on another device.' });
    this.onConflict?.(claim);
  }

  /** Last upload and release of the town when the player leaves it. Never keeps them waiting more than a few seconds. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (active === this) active = null;
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.game.onSaved = undefined;
    if (this.game.locked || this.halted || !this.online() || !this.leased) return;
    const finish = (async () => { await this.upload(); await releaseLease(this.worldId); })().catch(() => { /* the lease simply expires */ });
    await Promise.race([finish, new Promise((r) => setTimeout(r, 5000))]);
  }
}
