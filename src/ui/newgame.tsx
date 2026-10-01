// New world: choose a place, a starting year, starting conditions, a name and how fast the world lives.

import { useState } from 'preact/hooks';
import { CONDITIONS, OFFLINE_CAPS, PACES, PRESETS, START_YEARS, getPreset } from '../sim/presets';
import type { NewWorldOptions } from '../sim/worldgen';

const STEPS = ['Place', 'Year', 'Starting point', 'Your mandate'];

export function NewGame({ onCreate, onBack }: { onCreate(o: NewWorldOptions): void; onBack(): void }) {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [year, setYear] = useState(2026);
  const [cond, setCond] = useState('growing');
  const [name, setName] = useState(PRESETS[0].towns[0]);
  const [touched, setTouched] = useState(false);
  const [pace, setPace] = useState(2);
  const [cap, setCap] = useState(365);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const p = getPreset(preset);

  const choosePreset = (id: string) => {
    setPreset(id);
    if (!touched) { const t = getPreset(id).towns; setName(t[seed % t.length]); }
  };
  const create = () => onCreate({ name: name.trim() || p.towns[0], preset, startYear: year, condition: cond, seed, pace, offlineCapDays: cap, now: Date.now() });

  return (
    <main class="screen">
      <div class="screen-card wide">
        <header class="wizard-head">
          <h1>A new mandate</h1>
          <ol class="steps" aria-label="Steps">
            {STEPS.map((s, i) => <li key={s} class={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>)}
          </ol>
        </header>

        {step === 0 && (
          <section>
            <h2>Where will you govern?</h2>
            <p class="muted">Each region is modelled on a real place: its climate and seasons, crops, currency, tax system, household patterns and names. The town itself is generated.</p>
            <div class="choices" role="radiogroup" aria-label="Region">
              {PRESETS.map((x) => (
                <button key={x.id} role="radio" aria-checked={preset === x.id} class={`choice ${preset === x.id ? 'on' : ''}`} onClick={() => choosePreset(x.id)}>
                  <b>{x.label}</b>
                  <span class="muted small">{x.region}, {x.country} · {x.currency}</span>
                  <span class="small">{x.blurb}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <h2>When do you take office?</h2>
            <p class="muted">Prices, wages, car ownership and education levels are set to match the year. The simulation runs the year before you arrive, so the place has a recent history.</p>
            <div class="choices row" role="radiogroup" aria-label="Year">
              {START_YEARS.map((y) => (
                <button key={y} role="radio" aria-checked={year === y} class={`choice ${year === y ? 'on' : ''}`} onClick={() => setYear(y)}><b>{y}</b></button>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h2>What kind of place?</h2>
            <div class="choices" role="radiogroup" aria-label="Starting conditions">
              {CONDITIONS.map((c) => (
                <button key={c.id} role="radio" aria-checked={cond === c.id} class={`choice ${cond === c.id ? 'on' : ''}`} onClick={() => setCond(c.id)}>
                  <b>{c.label}</b>
                  <span class="small">{c.blurb}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h2>Your mandate</h2>
            <div class="field">
              <label for="city-name">Name of the town</label>
              <input id="city-name" type="text" value={name} maxLength={40} onInput={(e) => { setTouched(true); setName((e.currentTarget as HTMLInputElement).value); }} />
            </div>
            <fieldset class="field">
              <legend>How fast does the world live?</legend>
              {PACES.map((x) => (
                <label key={x.id} class="radio">
                  <input type="radio" name="pace" checked={pace === x.pace} onChange={() => setPace(x.pace)} />
                  <span><b>{x.label}</b> <span class="muted small">{x.blurb}</span></span>
                </label>
              ))}
            </fieldset>
            <fieldset class="field">
              <legend>While the game is closed, keep the world running for up to</legend>
              <div class="choices row">
                {OFFLINE_CAPS.map((c) => (
                  <label key={c.days} class={`choice small ${cap === c.days ? 'on' : ''}`}>
                    <input class="sr-only" type="radio" name="cap" checked={cap === c.days} onChange={() => setCap(c.days)} />{c.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <p class="muted">{p.label}, {p.country} · taking office in {year} · {CONDITIONS.find((c) => c.id === cond)?.label.toLowerCase()}</p>
          </section>
        )}

        <footer class="buttons spread">
          <button class="ghost" onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>{step === 0 ? 'Back' : 'Previous'}</button>
          {step < STEPS.length - 1
            ? <button class="primary" onClick={() => setStep(step + 1)}>Next</button>
            : <button class="primary" onClick={create}>Take office</button>}
        </footer>
      </div>
    </main>
  );
}
