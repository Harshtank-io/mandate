// The landing page: what Mandate is, and the way in. Everybody can enter at once as a guest; returning players can
// sign in with an email link or Google/Discord. Entering (or signing in) leads to the world map of Meridia.

import { useState } from 'preact/hooks';
import { sendSignInLink, signInWith } from '../net/auth';
import { cloudConfigured, OAUTH_LABELS, oauthProviders } from '../net/client';
import { useCloud } from '../net/store';
import { hash01 } from '../sim/rng';
import { PRESETS } from '../sim/presets';
import { hexAt, ringOf, WORLD_NAME } from './world';

const FEATURES = [
  { title: 'Every resident is simulated', text: 'Each family has a job, a rent, a grocery bill and an opinion of you. Raise a tax and shops sell less, firms hire less, and approval moves.' },
  { title: 'Seasons decide the harvest', text: 'Farms plough, sow and harvest with the monsoon, the snow or the dry season. A drought shows up in food prices months later.' },
  { title: 'Build the whole town', text: 'Lay out roads, zone land, and build schools, clinics, power plants, waterworks and fire stations. Borrow when you must.' },
  { title: `One shared world`, text: `Your town stands on a continent of ${WORLD_NAME} next to other players’ towns. Visit any of them to see how their mayor is doing.` },
  { title: 'Life goes on while you are away', text: 'Close the game and come back tomorrow: the town has lived the days in between, and a report tells you what happened.' },
  { title: 'No free money', text: 'Every rupee, shilling or dong comes from somebody. Budgets, loans, credit ratings and trade deals all follow the same rules.' },
];

const STEPS = [
  { title: `Enter ${WORLD_NAME}`, text: 'No sign-up: you join as a guest. Add an email later to keep your towns on every device.' },
  { title: 'Pick a plot', text: 'Ten regions modelled on real places, from the Deccan Plateau to the Java highlands. Click a free plot.' },
  { title: 'Name it and take office', text: 'Start on empty land or take over a town that already has a history. Then govern.' },
];

/** A continent of plots drawn in outline, with a few towns on it and one flagged as yours. */
function HexArt() {
  const s = 15, col = s * Math.sqrt(3), row = s * 1.5, rings = 4;
  const hex = (x: number, y: number) => {
    let d = '';
    for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 90); d += `${i ? 'L' : 'M'}${(x + s * 0.94 * Math.cos(a)).toFixed(1)} ${(y + s * 0.94 * Math.sin(a)).toFixed(1)}`; }
    return `${d}Z`;
  };
  const cells: { d: string; cls: string }[] = [];
  let flag: [number, number] = [0, 0];
  for (let n = 0; n < 1 + 3 * (rings + 1) * (rings + 2); n++) {
    const ring = ringOf(n);
    if (ring > rings && hash01(n, 3) > 0.4) continue;
    const [q, r] = hexAt(n);
    const x = col * (q + r / 2), y = row * r;
    const town = ring <= rings && hash01(n, 7) < 0.16;
    const mine = n === 9;
    if (mine) flag = [x, y];
    cells.push({ d: hex(x, y), cls: `hx${ring > rings ? ' coast' : ''}${mine ? ' mine' : town ? ' town' : ''}` });
  }
  const w = col * (rings + 2) + s, h = row * (rings + 2) + s;
  return (
    <svg class="landing-art" viewBox={`${-w} ${-h} ${2 * w} ${2 * h}`} aria-hidden="true">
      {cells.map((c, i) => <path key={i} d={c.d} class={c.cls} />)}
      <line x1={flag[0] - 2} y1={flag[1] + 6} x2={flag[0] - 2} y2={flag[1] - 10} stroke="#e9ecef" stroke-width="1.4" />
      <path class="flag" d={`M${flag[0] - 2} ${flag[1] - 10}L${flag[0] + 9} ${flag[1] - 6.5}L${flag[0] - 2} ${flag[1] - 3}Z`} />
    </svg>
  );
}

export function Landing({ onEnter }: { onEnter(): void }) {
  const c = useCloud();
  const [signIn, setSignIn] = useState(false);
  const [email, setEmail] = useState('');
  const acc = c.phase === 'online' ? c.account : null;
  const signedIn = !!acc && !acc.guest;
  const submit = async (e: Event) => { e.preventDefault(); await sendSignInLink(email); };
  return (
    <main class="landing">
      <div class="landing-inner">
        <header class="landing-top">
          <span class="brand"><span class="brand-mark" aria-hidden="true">⬢</span> Mandate</span>
          {cloudConfigured && !signedIn && <button class="ghost" onClick={() => setSignIn(!signIn)} aria-expanded={signIn}>Sign in</button>}
          {signedIn && <span class="muted small">Signed in as {acc!.name || acc!.email}</span>}
        </header>

        <section class="landing-hero">
          <div>
            <p class="landing-kicker">A living-world city simulation</p>
            <h1>Mandate</h1>
            <p class="landing-lead">Govern a town where every family, farm and shop is simulated, in a world shared with every other mayor.</p>
            <div class="buttons wrap landing-cta">
              <button class="primary big" onClick={onEnter}>Enter {WORLD_NAME}</button>
              {cloudConfigured && !signedIn && <button class="big" onClick={() => setSignIn(!signIn)}>I already have an account</button>}
            </div>
            <p class="muted small">{cloudConfigured ? 'Free to play in your browser. You start as a guest; nothing to fill in.' : 'Free to play in your browser. Towns are saved on this device.'}</p>
            {signIn && cloudConfigured && !signedIn && (
              <div class="landing-signin">
                <form class="inline" onSubmit={(e) => void submit(e)}>
                  <label class="sr-only" for="landing-email">Email address</label>
                  <input id="landing-email" type="email" autoComplete="email" required placeholder="you@example.com" value={email} onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)} />
                  <button class="primary" type="submit" disabled={c.busy}>Email me a link</button>
                </form>
                {oauthProviders.length > 0 && (
                  <div class="buttons wrap">
                    {oauthProviders.map((p) => <button key={p} disabled={c.busy} onClick={() => void signInWith(p)}>Continue with {OAUTH_LABELS[p]}</button>)}
                  </div>
                )}
                {c.notice && <p class="small" role="status">{c.notice}</p>}
                <p class="muted small">Open the link in this browser: you land straight on the world map with your towns.</p>
              </div>
            )}
          </div>
          <HexArt />
        </section>

        <section class="landing-section" aria-label="What the game is about">
          <h2>The game</h2>
          <div class="landing-features">
            {FEATURES.map((f, i) => (
              <article key={f.title} class="feature">
                <span class="feature-n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section class="landing-section" aria-label="How to start">
          <h2>Three steps to your first mandate</h2>
          <ol class="landing-steps">
            {STEPS.map((s, i) => <li key={s.title}><span class="step-n" aria-hidden="true">{i + 1}</span><b>{s.title}</b><p>{s.text}</p></li>)}
          </ol>
        </section>

        <section class="landing-section" aria-label="Regions">
          <h2>The regions of {WORLD_NAME}</h2>
          <ul class="landing-regions">
            {PRESETS.map((p) => <li key={p.id}><b>{p.label}</b><span class="muted small">{p.country}</span></li>)}
          </ul>
        </section>

        <section class="landing-end">
          <h2>Your plot is waiting.</h2>
          <button class="primary big" onClick={onEnter}>Choose your plot</button>
        </section>

        <footer class="landing-foot muted small">Mandate · towns, economies and people are generated; regions are inspired by real places.</footer>
      </div>
    </main>
  );
}
