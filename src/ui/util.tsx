// Shared UI pieces: formatting, small SVG charts, and rendering of inspector cards.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Sim } from '../sim/core';
import { formatDate, formatDay } from '../sim/calendar';
import { fmtMoney } from '../sim/systems/construction';
import type { Card, Ref, Section } from '../sim/inspect';

export const money = (sim: Sim, v: number) => fmtMoney(sim, v);
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
export const num = (v: number) => Math.round(v).toLocaleString('en-US');
export const dateTime = (sim: Sim) => formatDate(sim.s.meta.startYear, sim.s.minute);
export const dayLabel = (sim: Sim, d: number) => formatDay(sim.s.meta.startYear, d);

export function realSpan(ms: number): string {
  const m = ms / 60000;
  if (m < 90) return `${Math.max(1, Math.round(m))} minutes`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

/** Re-renders the calling component every `ms` milliseconds. */
export function useTick(ms: number): number {
  const [n, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function Spark({ values, color = '#8fd3ff', w = 110, h = 26 }: { values: number[]; color?: string; w?: number; h?: number }) {
  if (values.length < 2) return <svg class="spark" width={w} height={h} aria-hidden="true" />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} stroke-width="1.6" stroke-linejoin="round" />
    </svg>
  );
}

export interface Series { label: string; values: number[]; color: string }

export function Chart({ series, w = 300, h = 110, fmt, labels }: { series: Series[]; w?: number; h?: number; fmt: (v: number) => string; labels?: string[] }) {
  const all = series.flatMap((s) => s.values);
  if (all.length < 2) return <p class="muted">Not enough history yet.</p>;
  let min = Math.min(...all, 0), max = Math.max(...all);
  if (max === min) max = min + 1;
  const pad = 4, left = 4;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => left + (i / Math.max(1, n - 1)) * (w - left - pad);
  const y = (v: number) => h - 14 - ((v - min) / (max - min)) * (h - 26);
  return (
    <figure class="chart">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={series.map((s) => `${s.label} from ${fmt(s.values[0])} to ${fmt(s.values[s.values.length - 1])}`).join('; ')}>
        {min < 0 && max > 0 && <line x1={left} x2={w - pad} y1={y(0)} y2={y(0)} stroke="#ffffff33" stroke-dasharray="3 3" />}
        {series.map((s) => (
          <polyline key={s.label} fill="none" stroke={s.color} stroke-width="1.8" stroke-linejoin="round"
            points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
        ))}
        <text x={w - pad} y={10} text-anchor="end" class="axis">{fmt(max)}</text>
        <text x={w - pad} y={h - 16} text-anchor="end" class="axis">{fmt(min)}</text>
        {labels && labels.length > 1 && <>
          <text x={left} y={h - 2} class="axis">{labels[0]}</text>
          <text x={w - pad} y={h - 2} text-anchor="end" class="axis">{labels[labels.length - 1]}</text>
        </>}
      </svg>
      {series.length > 1 && <figcaption>{series.map((s) => <span key={s.label} class="legend"><i style={{ background: s.color }} />{s.label}</span>)}</figcaption>}
    </figure>
  );
}

export function Bars({ bars }: { bars: NonNullable<Section['bar']> }) {
  return (
    <ul class="bars">
      {bars.map((b) => (
        <li key={b.label}>
          <span class="bar-label">{b.label}</span>
          <span class="bar-track" role="meter" aria-label={b.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(b.value * 100)}>
            <span class={`bar-fill ${b.tone ?? ''}`} style={{ width: `${Math.max(2, Math.min(100, b.value * 100))}%` }} />
          </span>
          <span class="bar-value">{Math.round(b.value * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

export function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl class="rows">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

export function SectionView({ s, onLink }: { s: Section; onLink: (r: Ref) => void }) {
  return (
    <section class="card-section">
      <h4>{s.title}</h4>
      {s.rows && <Rows rows={s.rows} />}
      {s.bar && <Bars bars={s.bar} />}
      {s.lines && s.lines.length > 0 && <ul class="lines">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {s.links && s.links.length > 0 && (
        <ul class="links">{s.links.map((l, i) => <li key={i}><button class="link" onClick={() => onLink(l.ref)}>{l.label}</button></li>)}</ul>
      )}
    </section>
  );
}

export function CardView({ card, onLink, actions }: { card: Card; onLink: (r: Ref) => void; actions?: ComponentChildren }) {
  return (
    <div class="card">
      <header>
        <h3>{card.title}</h3>
        <p class="muted">{card.subtitle}</p>
      </header>
      {actions && <div class="card-actions">{actions}</div>}
      <Rows rows={card.rows} />
      {card.sections.map((s, i) => <SectionView key={`${s.title}${i}`} s={s} onLink={onLink} />)}
    </div>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ComponentChildren; onClose?: () => void; wide?: boolean }) {
  useEffect(() => {
    if (!onClose) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="modal-backdrop">
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
