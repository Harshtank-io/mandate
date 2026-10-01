// Development milestones emerge from the simulation state; there are no levels or experience points.

import type { Sim } from '../core';
import type { MonthStats } from '../types';

export interface Milestone { id: string; label: string; test: (sim: Sim, st: MonthStats) => boolean }

const running = (sim: Sim, kind: string) => sim.s.businesses.some((b) => b.kind === kind && b.status === 'operating');

export const MILESTONES: Milestone[] = [
  { id: 'pop5k', label: 'Population reaches 5,000', test: (_, st) => st.population >= 5000 },
  { id: 'pop10k', label: 'Population reaches 10,000', test: (_, st) => st.population >= 10000 },
  { id: 'pop25k', label: 'Population reaches 25,000', test: (_, st) => st.population >= 25000 },
  { id: 'pop50k', label: 'Population reaches 50,000', test: (_, st) => st.population >= 50000 },
  { id: 'pop100k', label: 'Population reaches 100,000', test: (_, st) => st.population >= 100000 },
  { id: 'hospital', label: 'A hospital serves the city', test: (sim) => running(sim, 'hospital') },
  { id: 'college', label: 'The city has its own college', test: (sim) => running(sim, 'college') },
  { id: 'factory', label: 'First factory in operation', test: (sim) => running(sim, 'factory') },
  { id: 'tech5', label: 'Technology district: five tech & services companies', test: (sim) => sim.s.businesses.filter((b) => b.kind === 'office' && b.status === 'operating').length >= 5 },
  { id: 'unemp5', label: 'Unemployment below 5%', test: (_, st) => st.laborForce > 500 && st.unemployment < 0.05 },
  { id: 'literacy90', label: '90% adult literacy', test: (_, st) => st.literacy >= 0.9 },
  { id: 'enrol95', label: '95% of children in school', test: (_, st) => st.enrollment >= 0.95 },
  { id: 'tertiary20', label: 'One in five adults holds a diploma or degree', test: (_, st) => st.tertiary >= 0.2 },
  { id: 'life75', label: 'Life expectancy reaches 75 years', test: (_, st) => st.lifeExp >= 75 },
  { id: 'health90', label: '90% of residents within reach of healthcare', test: (_, st) => st.healthCoverage >= 0.9 },
  { id: 'balanced', label: 'Twelve months of balanced budgets', test: (sim) => { const m = sim.s.stats.months; return m.length >= 12 && m.slice(-12).every((x) => x.balance >= 0); } },
  { id: 'debtfree', label: 'The government is debt-free', test: (sim) => sim.s.gov.debt <= 1 },
  { id: 'gdp2x', label: 'The economy is twice its starting size (real terms)', test: (sim, st) => { const f = sim.s.stats.months[0]; return !!f && f.gdp > 0 && st.gdp / (st.cpi / 100) >= f.gdp * 2; } },
  { id: 'homes', label: 'Every family has a home of its own', test: (_, st) => st.population > 1000 && st.homeless === 0 },
  { id: 'cleanair', label: 'Clean air in every neighbourhood', test: (_, st) => st.pollution < 0.12 },
  { id: 'roads50', label: '50 km of roads', test: (_, st) => st.roadKm >= 50 },
  { id: 'food', label: 'No family goes hungry', test: (_, st) => st.population > 1000 && st.foodInsecure < 0.01 },
];

/** Marks milestones already true at the start so only genuine progress is celebrated. */
export function seedMilestones(sim: Sim): void {
  const st = sim.s.stats.months[sim.s.stats.months.length - 1];
  if (!st) return;
  for (const m of MILESTONES) if (m.test(sim, st)) sim.s.milestones[m.id] = -1;
}

export function milestonesMonthly(sim: Sim): void {
  // milestones count only from the day the player's administration takes office
  if (sim.day <= sim.s.meta.officeDay) return;
  const st = sim.s.stats.months[sim.s.stats.months.length - 1];
  if (!st) return;
  for (const m of MILESTONES) {
    if (sim.s.milestones[m.id] !== undefined) continue;
    if (m.test(sim, st)) {
      sim.s.milestones[m.id] = sim.day;
      sim.emit('milestone', `Milestone: ${m.label}.`, 2);
    }
  }
}
