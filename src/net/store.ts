// Shared, observable state of the player's account and of cloud syncing. The menu, the in-game panels and the cloud
// dialogs all read it through useCloud() and re-render when it changes.

import { useEffect, useState } from 'preact/hooks';

export type CloudPhase =
  | 'off' // this copy of the game has no Supabase project configured
  | 'connecting'
  | 'online' // signed in (as a guest or with an account)
  | 'signedOut'
  | 'offline'; // configured, but the service could not be reached

export interface Account {
  id: string;
  guest: boolean;
  email: string | null;
  pendingEmail: string | null; // address waiting for the player to confirm it
  name: string;
  providers: string[];
}

export interface CloudTown {
  worldId: string;
  name: string;
  preset: string;
  condition: string;
  population: number;
  minute: number;
  date: string;
  revision: number;
  savedAt: string | null;
  path: string | null;
  size: number;
  enc: 'gzip' | 'json';
  leaseDevice: string | null;
  leaseUntil: string | null;
}

export type SyncStatus = 'pending' | 'uploading' | 'synced' | 'offline' | 'conflict' | 'lost' | 'error';

export interface SyncInfo { worldId: string; status: SyncStatus; revision: number; at: number; message: string }

export interface CloudState {
  phase: CloudPhase;
  account: Account | null;
  towns: CloudTown[];
  notice: string; // last message for the account panel
  busy: boolean; // an account action is in progress
  sync: SyncInfo | null; // the town being played on this device
}

let state: CloudState = { phase: 'off', account: null, towns: [], notice: '', busy: false, sync: null };
const listeners = new Set<() => void>();

export function cloud(): CloudState { return state; }

export function setCloud(patch: Partial<CloudState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function setSync(patch: Partial<SyncInfo> & { worldId: string }): void {
  const cur = state.sync && state.sync.worldId === patch.worldId ? state.sync : { worldId: patch.worldId, status: 'pending' as SyncStatus, revision: 0, at: 0, message: '' };
  setCloud({ sync: { ...cur, ...patch } });
}

/** Subscribes the component to cloud state changes. */
export function useCloud(): CloudState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}
