// Every page has its own address, so a reload, a bookmark or a shared link opens the same page, and Back/Forward move
// between pages. Addresses sit under the base the game is built for (`/`, or `/<repository>/` on GitHub Pages):
//   /                 the landing page
//   /world            the world map of Meridia
//   /town/<worldId>   one of the player's own towns
//   /visit/<townId>   another player's town, read-only
// The hosting answers every one of them with index.html (vercel.json on Vercel, 404.html on GitHub Pages).

import { authReturn } from '../net/client';

export type Route = { k: 'landing' } | { k: 'world' } | { k: 'town'; id: string } | { k: 'visit'; id: string };

const BASE = import.meta.env.BASE_URL;

/** The path of a page. */
export function routeUrl(r: Route, base = BASE): string {
  switch (r.k) {
    case 'landing': return base;
    case 'world': return `${base}world`;
    default: return `${base}${r.k}/${encodeURIComponent(r.id)}`;
  }
}

/** The page a path leads to. Anything unknown is the landing page. */
export function parseRoute(path = location.pathname, base = BASE): Route {
  if (!path.startsWith(base)) return { k: 'landing' };
  const [head, id, more] = path.slice(base.length).split('/').filter(Boolean);
  if (head === 'world' && id === undefined) return { k: 'world' };
  if ((head === 'town' || head === 'visit') && id && more === undefined) {
    try { return { k: head, id: decodeURIComponent(id) }; } catch { /* a malformed escape: no such page */ }
  }
  return { k: 'landing' };
}

/** The path this module last put in the address bar or followed, to tell a new page from a change to the hash alone. */
let shown: string | null = null;

/**
 * The page to open first: the one in the address bar, or the world map after a sign-in link or an OAuth login (they
 * return to the home address). Only the path is tidied: after a sign-in, the query or the hash holds the tokens the
 * auth client reads as it starts (net/auth.ts clears them afterwards).
 */
export function firstRoute(): Route {
  const r: Route = authReturn() ? { k: 'world' } : parseRoute();
  const path = routeUrl(r);
  if (location.pathname !== path) history.replaceState(null, '', path + location.search + location.hash);
  shown = path;
  return r;
}

/** Query parameters that follow the player from page to page (?debug, for automated checks). */
const kept = () => (new URLSearchParams(location.search).has('debug') ? '?debug' : '');

/** Puts a page in the address bar: as a new history entry, or with `replace` instead of the current one. */
export function nav(r: Route, replace = false): void {
  const path = routeUrl(r);
  shown = path;
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path + kept());
  else history.pushState(null, '', path + kept());
}

/** Calls `go` whenever Back or Forward lead to another page. Returns the function that stops listening. */
export function onRouteChange(go: (r: Route) => void): () => void {
  const on = () => {
    if (location.pathname === shown) return; // the same page: only the hash changed (the auth client clears its tokens)
    shown = location.pathname;
    go(parseRoute());
  };
  addEventListener('popstate', on);
  return () => removeEventListener('popstate', on);
}
