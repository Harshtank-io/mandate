// The Supabase client. It exists only when the project is configured (VITE_SUPABASE_URL and
// VITE_SUPABASE_PUBLISHABLE_KEY in .env.local). The library is loaded on demand, so without a project, or offline,
// the game is fully playable and saves stay on this device.

import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

export const cloudConfigured = PROJECT_URL !== '' && PUBLISHABLE_KEY !== '';

export type OAuthProvider = 'google' | 'discord';
export const OAUTH_LABELS: Record<OAuthProvider, string> = { google: 'Google', discord: 'Discord' };

/** OAuth providers switched on for this project (VITE_AUTH_PROVIDERS=google,discord). */
export const oauthProviders: OAuthProvider[] = (import.meta.env.VITE_AUTH_PROVIDERS ?? '')
  .split(',').map((s) => s.trim().toLowerCase())
  .filter((s): s is OAuthProvider => s === 'google' || s === 'discord');

let client: Promise<SupabaseClient> | null = null;

export function supabase(): Promise<SupabaseClient> {
  if (!cloudConfigured) return Promise.reject(new Error('Cloud saves are not set up for this copy of the game.'));
  client ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'mandate.auth' },
  }));
  return client;
}

/**
 * Where sign-in links and OAuth logins return to: the game's home address, whatever page they were asked for on (the
 * world map then opens, see ui/route.ts). It must be listed in the project's redirect URLs.
 */
export function returnUrl(): string { return `${location.origin}${import.meta.env.BASE_URL}`; }

/** Whether the address holds the result of a sign-in link or an OAuth login. */
export function authReturn(): boolean {
  return /access_token|refresh_token|error_description/.test(location.hash) || /[?&](code|error_description)=/.test(location.search);
}

let memoryDevice = '';

/** A random id for this browser, used so only one device plays a town at a time. */
export function deviceId(): string {
  try {
    const known = localStorage.getItem('mandate.device');
    if (known) return known;
  } catch { /* storage unavailable: fall back to an id for this session */ }
  if (!memoryDevice) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    memoryDevice = `d${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  try { localStorage.setItem('mandate.device', memoryDevice); } catch { /* ignore */ }
  return memoryDevice;
}

/** Fails if a network call takes longer than `ms`, so a stalled connection never leaves the player waiting. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took too long to answer`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A readable message for errors from the network, Supabase or the browser. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
