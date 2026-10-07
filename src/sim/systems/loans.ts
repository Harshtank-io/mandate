// Term loans. The city can borrow from a national development fund (cheap, for towns still growing), a commercial bank
// (quick, short) or the bond market (large, long, priced off the credit rating), and repays each loan in equal monthly
// instalments of interest and capital. The treasury's automatic overdraft (Government.debt) stays for emergencies.
// Every loan comes from outside the city and is repaid to it, so money is conserved.

import type { Sim } from '../core';
import { sumRev } from '../core';
import type { Loan, LoanKind } from '../types';

export interface LoanProduct { label: string; lender: string; years: number; note: string }

export const LOAN_PRODUCTS: Record<LoanKind, LoanProduct> = {
  development: { label: 'Development loan', lender: 'National Urban Development Fund', years: 20, note: 'Cheap, fixed-rate finance for towns still growing; it does not count against the credit rating' },
  bank: { label: 'Bank loan', lender: 'Commercial bank', years: 5, note: 'Quick to arrange; repaid over five years at the market rate for the city’s rating' },
  bond: { label: 'Municipal bonds', lender: 'Bond investors', years: 15, note: 'Large and long; investors want a year of accounts and a BBB rating or better' },
};
export const LOAN_KINDS: LoanKind[] = ['development', 'bank', 'bond'];
/** Interest on development loans, fixed by the national fund. */
export const DEVELOPMENT_RATE = 0.04;
/** Towns above this size borrow on the market instead. */
export const DEVELOPMENT_MAX_POP = 20_000;
/** Lenders stop lending once market debt reaches this multiple of annual revenue (the overdraft stops there too). */
export const DEBT_LIMIT = 4.5;
const SPREAD: Record<LoanKind, number> = { development: 0, bank: 0.015, bond: 0.005 };

/** Market interest rate by credit rating. */
export const RATING_RATE: Record<string, number> = { AA: 0.065, A: 0.075, BBB: 0.09, BB: 0.11, B: 0.14 };

/** Credit rating and market interest rate for a ratio of market debt to annual revenue. */
export function ratingFor(ratio: number): [string, number] {
  const r = ratio < 1 ? 'AA' : ratio < 2 ? 'A' : ratio < 3 ? 'BBB' : ratio < 4 ? 'BB' : 'B';
  return [r, RATING_RATE[r]];
}

/** Monthly instalment that repays `principal` with interest over `months`. */
export function instalment(principal: number, rate: number, months: number): number {
  const r = rate / 12;
  return r > 0 ? (principal * r) / (1 - Math.pow(1 + r, -months)) : principal / months;
}

export function loanBalance(sim: Sim, kind?: LoanKind): number {
  let t = 0;
  for (const l of sim.s.gov.loans ?? []) if (!kind || l.kind === kind) t += l.balance;
  return t;
}

/** Debt that lenders and the credit rating look at: the overdraft, bank loans and bonds (not development loans). */
export function marketDebt(sim: Sim): number { return sim.s.gov.debt + loanBalance(sim, 'bank') + loanBalance(sim, 'bond'); }

/** Everything the city owes. */
export function totalDebt(sim: Sim): number { return sim.s.gov.debt + loanBalance(sim); }

/** Monthly instalments on all loans. */
export function loanPayments(sim: Sim): number { return (sim.s.gov.loans ?? []).reduce((a, l) => a + l.payment, 0); }

/** The annual revenue lenders judge the city by: this year's pace once there are a few months of it, else last month's. */
export function annualRevenue(sim: Sim): number {
  const g = sim.s.gov;
  return Math.max(1, sumRev(g.ytd) > 0 && sim.date.month > 2 ? (sumRev(g.ytd) / sim.date.month) * 12 : sumRev(g.last) * 12 || sumRev(g.m) * 12);
}

export interface LoanOffer { kind: LoanKind; label: string; lender: string; rate: number; years: number; min: number; max: number; note: string; blocked: string | null }

/** What each lender would lend the city today, and on what terms. */
export function loanOffers(sim: Sim, fmt: (v: number) => string): LoanOffer[] {
  const s = sim.s, g = s.gov;
  const n = sim.scale * s.ext.trend;
  const rev = annualRevenue(sim), monthly = rev / 12;
  const room = Math.max(0, rev * DEBT_LIMIT - marketDebt(sim));
  // lenders price off the published credit rating (reviewed monthly), not the city's books of the day
  const market = RATING_RATE[g.rating] ?? ratingFor(marketDebt(sim) / rev)[1];
  const min = 5_000_000 * n;
  const behind = g.arrears > 0 ? 'Lenders will not lend while the city is behind on its bills' : null;
  const tooSmall = `Lenders judge the city by its revenue (${fmt(rev)} a year): they will not lend more against it now`;
  const out: LoanOffer[] = [];
  const offer = (kind: LoanKind, rate: number, max: number, blocked: string | null) => {
    const p = LOAN_PRODUCTS[kind];
    out.push({ kind, label: p.label, lender: p.lender, rate, years: p.years, min, max: Math.max(min, Math.floor(max / min) * min), note: p.note, blocked: blocked ?? (max < min ? tooSmall : null) });
  };
  const devCap = Math.max(150_000_000 * n, monthly * 12);
  const devLeft = devCap - loanBalance(sim, 'development');
  offer('development', DEVELOPMENT_RATE, devLeft,
    s.citizens.length > DEVELOPMENT_MAX_POP ? `Only for towns of under ${DEVELOPMENT_MAX_POP.toLocaleString('en-US')} people` : behind ?? (devLeft < min ? `The fund lends a town at most ${fmt(devCap)}; repay some first` : null));
  offer('bank', market + SPREAD.bank, Math.min(room, Math.max(30_000_000 * n, monthly * 6)), behind ?? (g.rating === 'B' ? 'Banks will not lend to a city rated B' : null));
  offer('bond', market + SPREAD.bond, Math.min(room, Math.max(80_000_000 * n, monthly * 18)),
    behind ?? (!['AA', 'A', 'BBB'].includes(g.rating) ? 'Investors buy the city’s bonds only at a BBB rating or better' : s.stats.months.length < 13 ? 'Investors want a full year of accounts first' : null));
  return out;
}

/** Records a new loan: the money arrives in the treasury today. */
export function newLoan(sim: Sim, o: LoanOffer, amount: number): Loan {
  const months = o.years * 12;
  const l: Loan = { id: sim.newId(), kind: o.kind, lender: o.lender, principal: amount, balance: amount, rate: o.rate, months, left: months, payment: instalment(amount, o.rate, months), taken: sim.day, interest: 0 };
  sim.pay(sim.s.ext, sim.s.gov, amount);
  sim.s.gov.loans.push(l);
  return l;
}

/** Monthly instalments: interest is spending; capital repaid reduces what is owed. */
export function serviceLoans(sim: Sim): void {
  const s = sim.s, g = s.gov;
  if (!g.loans?.length) return;
  for (const l of [...g.loans]) {
    const interest = (l.balance * l.rate) / 12;
    const capital = l.left <= 1 ? l.balance : Math.min(l.balance, Math.max(0, l.payment - interest));
    sim.spend('interest', s.ext, interest);
    l.interest += interest;
    sim.pay(g, s.ext, capital);
    l.balance -= capital;
    l.left--;
    if (l.left <= 0 || l.balance <= 1) {
      g.loans = g.loans.filter((x) => x !== l);
      sim.emit('gov.loanRepaid', `The city has repaid its ${l.kind === 'bond' ? 'bonds' : `loan from the ${l.lender}`} in full.`, 1);
    }
  }
}
