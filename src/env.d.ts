/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xyzcompany.supabase.co (public). */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable key (sb_publishable_...), safe to ship to the browser. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** OAuth providers enabled in Supabase Auth, comma-separated: google, discord. */
  readonly VITE_AUTH_PROVIDERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
