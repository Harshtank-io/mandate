// Accounts. Everyone starts as a guest (an anonymous Supabase user), so playing never needs a sign-up. A guest can add
// an email address or a Google/Discord login to keep their towns and reach them from other devices.

import type { Session } from '@supabase/supabase-js';
import { cloudConfigured, errText, OAUTH_LABELS, returnUrl, supabase, within, type OAuthProvider } from './client';
import { cloud, setCloud, type Account } from './store';
import { refreshTowns } from './saves';

const OPT_OUT = 'mandate.signedOut';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let connecting: Promise<void> | null = null;
let listening = false;

const optedOut = () => { try { return localStorage.getItem(OPT_OUT) === '1'; } catch { return false; } };
const setOptedOut = (v: boolean) => { try { if (v) localStorage.setItem(OPT_OUT, '1'); else localStorage.removeItem(OPT_OUT); } catch { /* ignore */ } };

/** Connects to the account service, signing in as a guest the first time. Calling it again retries. */
export function startCloud(): Promise<void> {
  if (!cloudConfigured) { setCloud({ phase: 'off' }); return Promise.resolve(); }
  connecting ??= connect().finally(() => { connecting = null; });
  return connecting;
}

async function connect(): Promise<void> {
  if (cloud().phase !== 'online') setCloud({ phase: 'connecting' });
  try {
    const sb = await supabase();
    if (!listening) {
      listening = true;
      // the auth client must not be awaited from inside its own callback, so react on the next tick
      sb.auth.onAuthStateChange((event, session) => { setTimeout(() => void applySession(session, event), 0); });
    }
    const linkError = takeLinkError();
    const { data, error } = await within(sb.auth.getSession(), 15_000, 'The account service');
    if (error) throw error;
    let session = data.session;
    if (!session && !optedOut()) {
      const res = await within(sb.auth.signInAnonymously(), 15_000, 'The account service');
      if (res.error) throw res.error;
      session = res.data.session;
    }
    await applySession(session);
    if (linkError) setCloud({ notice: `That link did not work: ${linkError}` });
  } catch (e) {
    setCloud({ phase: 'offline', notice: `Can't reach your account right now (${errText(e)}). Towns are still saved on this device.` });
  }
}

/** Reads and clears the result of a sign-in link from the address bar (the auth client has already used any tokens). */
function takeLinkError(): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, '') || location.search);
  const err = params.get('error_description') ?? '';
  if (/access_token|refresh_token|error_description/.test(location.hash) || /[?&](code|error_description)=/.test(location.search)) {
    history.replaceState(null, '', returnUrl());
  }
  return err.replace(/\+/g, ' ');
}

async function applySession(session: Session | null, event?: string): Promise<void> {
  if (!session) {
    if (cloud().phase !== 'off') setCloud({ phase: 'signedOut', account: null, towns: [] });
    return;
  }
  const u = session.user;
  const prev = cloud().account;
  const account: Account = {
    id: u.id, guest: u.is_anonymous === true, email: u.email ?? null, pendingEmail: u.new_email ?? null,
    name: prev?.id === u.id ? prev.name : '', providers: (u.identities ?? []).map((i) => i.provider),
  };
  setCloud({ phase: 'online', account });
  if (event === 'USER_UPDATED' && prev?.guest && !account.guest) setCloud({ notice: 'Your account is confirmed. Your towns now belong to it and you can sign in on other devices.' });
  try { await Promise.all([loadName(u.id), refreshTowns()]); } catch (e) { setCloud({ notice: `Could not load your towns (${errText(e)}).` }); }
}

async function loadName(uid: string): Promise<void> {
  const sb = await supabase();
  const { data, error } = await sb.from('profiles').select('display_name').eq('id', uid).maybeSingle();
  if (error) throw error;
  const acc = cloud().account;
  if (acc && acc.id === uid && data) setCloud({ account: { ...acc, name: (data as { display_name: string }).display_name } });
}

/** Runs an account action, showing progress and its outcome in the account panel. */
async function act(fn: () => Promise<string>): Promise<void> {
  setCloud({ busy: true, notice: '' });
  try { setCloud({ notice: await fn() }); } catch (e) { setCloud({ notice: errText(e) }); } finally { setCloud({ busy: false }); }
}

function checkEmail(email: string): string {
  const e = email.trim();
  if (!EMAIL.test(e)) throw new Error('That does not look like an email address.');
  return e;
}

/** Turns the guest account into a permanent one once the player confirms the link sent to this address. */
export const addEmail = (email: string) => act(async () => {
  const e = checkEmail(email);
  const sb = await supabase();
  const { error } = await sb.auth.updateUser({ email: e }, { emailRedirectTo: returnUrl() });
  if (error) throw error;
  return `We sent a link to ${e}. Open it to confirm the address; your towns then belong to that account.`;
});

/** Signs in to an existing account with a one-time link (for playing on another device). */
export const sendSignInLink = (email: string) => act(async () => {
  const e = checkEmail(email);
  const sb = await supabase();
  const { error } = await sb.auth.signInWithOtp({ email: e, options: { shouldCreateUser: false, emailRedirectTo: returnUrl() } });
  if (error) {
    throw new Error(/sign ?ups?|not found|not allowed/i.test(error.message)
      ? 'No account uses that address yet. If you are playing as a guest, add the address to this account instead.' : error.message);
  }
  setOptedOut(false);
  return `Check ${e} for a sign-in link and open it in this browser.`;
});

/** Attaches a Google or Discord login to the current account (guests keep their towns). */
export const linkProvider = (p: OAuthProvider) => act(async () => {
  const sb = await supabase();
  const { error } = await sb.auth.linkIdentity({ provider: p, options: { redirectTo: returnUrl() } });
  if (error) throw error;
  return `Opening ${OAUTH_LABELS[p]}…`;
});

/** Signs in to an existing account with Google or Discord. */
export const signInWith = (p: OAuthProvider) => act(async () => {
  const sb = await supabase();
  setOptedOut(false);
  const { error } = await sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: returnUrl() } });
  if (error) throw error;
  return `Opening ${OAUTH_LABELS[p]}…`;
});

export const rename = (name: string) => act(async () => {
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length < 3 || n.length > 24) throw new Error('Names need 3 to 24 characters.');
  const acc = cloud().account;
  if (!acc) throw new Error('Not signed in.');
  const sb = await supabase();
  const { error } = await sb.from('profiles').update({ display_name: n, updated_at: new Date().toISOString() }).eq('id', acc.id);
  if (error) throw error;
  setCloud({ account: { ...acc, name: n } });
  return 'Name saved.';
});

/** Signs out of a permanent account. Towns stay on this device; the cloud copies stay in the account. */
export const signOut = () => act(async () => {
  const sb = await supabase();
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  setOptedOut(true);
  setCloud({ phase: 'signedOut', account: null, towns: [] });
  return 'Signed out. Your towns are still on this device and in your account.';
});

/** Starts a fresh guest session after signing out. */
export const playAsGuest = () => act(async () => {
  setOptedOut(false);
  await startCloud();
  return cloud().phase === 'online' ? 'Playing as a guest.' : cloud().notice;
});
