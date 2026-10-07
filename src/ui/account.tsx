// Accounts and cloud saves in the interface: the account panel on the main menu, the list of towns kept in the
// account, the cloud status while playing, and the dialogs for a town open on another device or changed in two places.

import { useState } from 'preact/hooks';
import { addEmail, linkProvider, playAsGuest, rename, sendSignInLink, signInWith, signOut, startCloud } from '../net/auth';
import { cloudConfigured, errText, OAUTH_LABELS, oauthProviders } from '../net/client';
import { useCloud, type CloudTown, type SyncInfo } from '../net/store';
import { setOnMap } from '../net/world';
import { getPreset } from '../sim/presets';
import { Modal, num, realSpan } from './util';

const ago = (iso: string | number | null) => {
  if (iso === null) return 'never';
  const ms = Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso));
  return ms < 60_000 ? 'just now' : `${realSpan(ms)} ago`;
};

// ------------------------------------------------------------------------------------------------ main menu

export function AccountPanel() {
  const c = useCloud();
  const [form, setForm] = useState<'add' | 'signin' | 'rename' | null>(null);
  const [text, setText] = useState('');
  if (!cloudConfigured) return null;
  const acc = c.account;
  const submit = async (e: Event) => {
    e.preventDefault();
    if (form === 'add') await addEmail(text);
    else if (form === 'signin') await sendSignInLink(text);
    else if (form === 'rename') await rename(text);
    setForm(null);
    setText('');
  };
  const open = (f: 'add' | 'signin' | 'rename') => { setForm(f); setText(f === 'rename' ? acc?.name ?? '' : ''); };
  return (
    <section class="account" aria-label="Your account">
      <h2>Your account</h2>
      {c.phase === 'connecting' && <p class="muted">Connecting to your account…</p>}
      {c.phase === 'offline' && (
        <>
          <p class="muted small" role="status">{c.notice}</p>
          <div class="buttons"><button class="small" disabled={c.busy} onClick={() => void startCloud()}>Try again</button></div>
        </>
      )}
      {c.phase === 'signedOut' && (
        <>
          <p class="muted">You are signed out. Towns on this device still work; they are not copied to an account.</p>
          <div class="buttons wrap">
            <button class="small" disabled={c.busy} onClick={() => void playAsGuest()}>Play as a guest</button>
            <button class="small ghost" disabled={c.busy} onClick={() => open('signin')}>Sign in with email</button>
            {oauthProviders.map((p) => <button key={p} class="small ghost" disabled={c.busy} onClick={() => void signInWith(p)}>Sign in with {OAUTH_LABELS[p]}</button>)}
          </div>
        </>
      )}
      {c.phase === 'online' && acc && (
        <>
          <p>
            <b>{acc.name || 'Mayor'}</b>{' '}
            <span class="muted small">{acc.guest ? 'guest' : acc.email ?? acc.providers.filter((x) => x !== 'email').map((x) => OAUTH_LABELS[x as keyof typeof OAUTH_LABELS] ?? x).join(', ')}</span>{' '}
            <button class="link small" disabled={c.busy} onClick={() => open('rename')}>Rename</button>
          </p>
          {acc.guest ? (
            <>
              <p class="muted small">Your towns are copied to a guest account that only this browser can reach. Add an email address to keep them and play on other devices.</p>
              {acc.pendingEmail && <p class="small">Waiting for you to confirm {acc.pendingEmail}.</p>}
              <div class="buttons wrap">
                <button class="small" disabled={c.busy} onClick={() => open('add')}>Add an email</button>
                {oauthProviders.map((p) => <button key={p} class="small ghost" disabled={c.busy} onClick={() => void linkProvider(p)}>Link {OAUTH_LABELS[p]}</button>)}
                <button class="small ghost" disabled={c.busy} onClick={() => open('signin')}>I already have an account</button>
              </div>
            </>
          ) : (
            <div class="buttons wrap">
              {oauthProviders.filter((p) => !acc.providers.includes(p)).map((p) => <button key={p} class="small ghost" disabled={c.busy} onClick={() => void linkProvider(p)}>Link {OAUTH_LABELS[p]}</button>)}
              <button class="small ghost" disabled={c.busy} onClick={() => void signOut()}>Sign out</button>
            </div>
          )}
        </>
      )}
      {form && (
        <form class="inline account-form" onSubmit={(e) => void submit(e)}>
          <label class="sr-only" for="account-input">{form === 'rename' ? 'Display name' : 'Email address'}</label>
          <input id="account-input" type={form === 'rename' ? 'text' : 'email'} autoComplete={form === 'rename' ? 'nickname' : 'email'} required
            maxLength={form === 'rename' ? 24 : 254} placeholder={form === 'rename' ? 'Display name' : 'you@example.com'} value={text}
            onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
          <button class="small primary" type="submit" disabled={c.busy}>{form === 'rename' ? 'Save' : form === 'add' ? 'Send link' : 'Send sign-in link'}</button>
          <button class="small ghost" type="button" onClick={() => setForm(null)}>Cancel</button>
        </form>
      )}
      {form === 'signin' && acc?.guest && <p class="muted small">Signing in replaces this guest account in this browser. Towns on this device move to the account you sign in to; copies kept only in the guest account stay behind.</p>}
      {c.notice && c.phase !== 'offline' && <p class="small" role="status">{c.notice}</p>}
    </section>
  );
}

/** Towns in the account that are not on this device yet. */
export function CloudTownList({ localIds, onOpen, onDelete }: { localIds: Set<string>; onOpen(t: CloudTown): void; onDelete(t: CloudTown): Promise<void> }) {
  const c = useCloud();
  const [confirm, setConfirm] = useState<string | null>(null);
  const towns = c.towns.filter((t) => t.path && !localIds.has(t.worldId));
  if (c.phase !== 'online' || !towns.length) return null;
  return (
    <section>
      <h2>In your account</h2>
      <ul class="saves">
        {towns.map((t) => (
          <li key={t.worldId}>
            <div>
              <b>{t.name || 'Unnamed town'}</b>
              <p class="muted small">{getPreset(t.preset).label} · {t.date} · {num(t.population)} residents · saved {ago(t.savedAt)}</p>
            </div>
            <div class="buttons">
              <button class="small" onClick={() => onOpen(t)}>Open</button>
              {confirm === t.worldId
                ? <><button class="danger small" onClick={() => { void onDelete(t); setConfirm(null); }}>Delete for good</button><button class="ghost small" onClick={() => setConfirm(null)}>Keep</button></>
                : <button class="ghost small" onClick={() => setConfirm(t.worldId)}>Delete</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ while playing

const BADGE: Record<SyncInfo['status'], string> = {
  pending: 'Cloud: not saved yet', uploading: 'Saving to cloud…', synced: 'Saved to cloud', offline: 'Cloud offline',
  conflict: 'Cloud: two versions', lost: 'Open on another device', error: 'Cloud error',
};

/** Compact cloud status for the top bar. */
export function CloudBadge() {
  const c = useCloud();
  if (!cloudConfigured || !c.sync || c.phase === 'signedOut') return null;
  const s = c.sync;
  return <span class={`cloud-badge ${s.status}`} title={s.message || (s.at ? `Last saved to the cloud ${ago(s.at)}` : BADGE[s.status])}>{BADGE[s.status]}</span>;
}

function syncText(s: SyncInfo | null): string {
  if (!s) return 'Not synced yet';
  switch (s.status) {
    case 'synced': return `Saved to the cloud ${s.at ? ago(s.at) : ''} (revision ${s.revision})`.replace('  ', ' ');
    case 'pending': return 'Changes since the last cloud save; they upload within five minutes and when you leave.';
    case 'uploading': return 'Saving to the cloud…';
    case 'offline': return `Offline${s.message ? ` (${s.message})` : ''}: saves go to the cloud once the connection is back.`;
    case 'conflict': return 'This town was also played on another device. Choose which copy to keep.';
    case 'lost': return 'Opened on another device; play has stopped here.';
    default: return s.message || 'Something went wrong with the cloud copy.';
  }
}

/** Whether a town appears on the shared world map, switchable by its owner once it is in the account. */
function MapSwitch({ worldId }: { worldId: string }) {
  const c = useCloud();
  const [busy, setBusy] = useState(false);
  const [want, setWant] = useState<boolean | null>(null); // the player's choice while the server confirms it
  const [error, setError] = useState('');
  const town = c.towns.find((t) => t.worldId === worldId && t.path);
  const onMap = want ?? town?.onMap ?? true;
  const toggle = async (v: boolean) => {
    setBusy(true);
    setWant(v);
    setError('');
    try { await setOnMap(worldId, v); } catch (e) { setError(errText(e)); } finally { setWant(null); setBusy(false); }
  };
  return (
    <div class="setting">
      <label class="switch">
        <input type="checkbox" checked={onMap} disabled={!town || busy} onChange={(e) => void toggle((e.currentTarget as HTMLInputElement).checked)} />
        <span>Show this town on the world map</span>
      </label>
      <p class="muted small">{!town ? 'It goes on the world map after its first cloud save.'
        : onMap ? 'Every player can find it on the world map and visit it. Visitors see the copy last saved to your account and cannot change anything.'
          : 'Off the map: only you can see it there, and nobody else can visit it.'}</p>
      {error && <p class="bad small" role="alert">{error}</p>}
    </div>
  );
}

/** Cloud section of the World panel. */
export function CloudSection({ worldId, onSaveNow }: { worldId: string; onSaveNow(): void }) {
  const c = useCloud();
  if (!cloudConfigured) return <section><h3>Cloud</h3><p class="muted small">Cloud saves are not set up in this copy of the game, so this town is saved on this device only.</p></section>;
  const acc = c.account;
  const status = c.sync?.status;
  return (
    <section>
      <h3>Cloud</h3>
      {c.phase === 'online' && acc ? (
        <dl class="rows">
          <div><dt>Account</dt><dd>{acc.name || 'Mayor'}{acc.guest ? ' (guest)' : acc.email ? ` · ${acc.email}` : ''}</dd></div>
          <div><dt>This town</dt><dd>{syncText(c.sync)}</dd></div>
        </dl>
      ) : (
        <p class="muted small">{c.phase === 'connecting' ? 'Connecting to your account…'
          : c.phase === 'signedOut' ? 'Signed out: this town is saved on this device only. Sign in from the main menu.'
            : c.notice || 'Offline: saves go to the cloud once the connection is back.'}</p>
      )}
      {c.phase === 'online' && <div class="buttons"><button disabled={status === 'uploading' || status === 'lost' || status === 'conflict'} onClick={onSaveNow}>Save to cloud now</button></div>}
      {acc?.guest && <p class="muted small">Guest towns can only be reached from this browser. Add an email on the main menu to keep them safe.</p>}
      {c.phase === 'online' && acc && <MapSwitch worldId={worldId} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ dialogs

export type Ask =
  | { k: 'busy'; name: string; until: string | null; onTakeOver(): void; onCancel(): void }
  | { k: 'conflict'; name: string; cloud: { savedAt: string | null; date: string }; mine: { savedAt: number | null; date: string }; onCloud(): void; onMine(): void; onCancel?(): void }
  | { k: 'lost'; name: string; onTakeOver(): void; onMenu(): void };

export function CloudDialog({ ask }: { ask: Ask }) {
  if (ask.k === 'busy') {
    return (
      <Modal title="Open on another device" onClose={ask.onCancel}>
        <p>{ask.name} is being played on another device{ask.until ? ` (active until ${new Date(ask.until).toLocaleTimeString()} unless it keeps going)` : ''}. Only one device can play a town at a time.</p>
        <p class="muted">If you take it over here, the other device stops within a minute and this device continues from the latest cloud copy.</p>
        <div class="buttons"><button class="primary" onClick={ask.onTakeOver} autoFocus>Take over here</button><button class="ghost" onClick={ask.onCancel}>Cancel</button></div>
      </Modal>
    );
  }
  if (ask.k === 'lost') {
    return (
      <Modal title="Now open on another device">
        <p>{ask.name} was opened on another device, so play has stopped here to keep a single version of the town. Nothing after that moment was saved on this device.</p>
        <div class="buttons"><button class="primary" onClick={ask.onTakeOver} autoFocus>Take over here</button><button class="ghost" onClick={ask.onMenu}>Main menu</button></div>
      </Modal>
    );
  }
  return (
    <Modal title={`Two versions of ${ask.name}`} onClose={ask.onCancel} wide>
      <p>This device and your account have each moved on since they last matched. Choose which one to continue.</p>
      <div class="conflict-choices">
        <div>
          <h3>Your account</h3>
          <p class="muted small">Saved {ago(ask.cloud.savedAt)}{ask.cloud.date ? `, in-game ${ask.cloud.date}` : ''}.</p>
          <button class="primary" onClick={ask.onCloud} autoFocus>Use the account copy</button>
          <p class="muted small">This device’s copy is kept as a named save in the World panel.</p>
        </div>
        <div>
          <h3>This device</h3>
          <p class="muted small">Saved {ago(ask.mine.savedAt)}{ask.mine.date ? `, in-game ${ask.mine.date}` : ''}.</p>
          <button onClick={ask.onMine}>Keep this device’s copy</button>
          <p class="muted small">It becomes the latest copy in your account.</p>
        </div>
      </div>
      {ask.onCancel && <div class="buttons"><button class="ghost" onClick={ask.onCancel}>Decide later</button></div>}
    </Modal>
  );
}
