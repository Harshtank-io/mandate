export const MIN_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface CalDate {
  day: number; // sim day index
  year: number;
  month: number; // 0..11
  dom: number; // 1..31
  dow: number; // 0 Sunday
  doy: number; // 0-based day of year
  daysInMonth: number;
}

export function dateOf(startYear: number, day: number): CalDate {
  const d = new Date(Date.UTC(startYear, 0, 1 + day));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const dom = d.getUTCDate();
  const doy = Math.round((Date.UTC(year, month, dom) - Date.UTC(year, 0, 1)) / MS_PER_DAY);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { day, year, month, dom, dow: d.getUTCDay(), doy, daysInMonth };
}

/** Sim day index of a calendar date. */
export function dayIndex(startYear: number, year: number, month: number, dom: number): number {
  return Math.round((Date.UTC(year, month, dom) - Date.UTC(startYear, 0, 1)) / MS_PER_DAY);
}

export function ageYears(born: number, day: number): number {
  return (day - born) / 365.25;
}

export function formatDate(startYear: number, minute: number, withTime = true): string {
  const day = Math.floor(minute / MIN_PER_DAY);
  const c = dateOf(startYear, day);
  const base = `${DOW[c.dow]} ${c.dom} ${MONTHS[c.month]} ${c.year}`;
  if (!withTime) return base;
  const m = Math.floor(minute - day * MIN_PER_DAY);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${base}, ${hh}:${mm}`;
}

export function formatDay(startYear: number, day: number): string {
  const c = dateOf(startYear, day);
  return `${c.dom} ${MONTHS[c.month]} ${c.year}`;
}

export function formatMonth(startYear: number, day: number): string {
  const c = dateOf(startYear, day);
  return `${MONTHS[c.month]} ${c.year}`;
}

/** Human description of a span of simulated days. */
export function spanText(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 45) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 730) return `${Math.round(days / 30.4)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}
