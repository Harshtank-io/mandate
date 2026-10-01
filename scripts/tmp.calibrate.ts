// Temporary check of the new systems (deleted after use).
import { test } from 'vitest';
import { Simulation } from '../src/sim/simulation';

for (const cond of ['developing', 'established']) {
  test(`expansion ${cond}`, () => {
    const S = Simulation.create({ name: 'T', preset: 'in-deccan', startYear: 2026, condition: cond, seed: 7, pace: 2, offlineCapDays: 365, now: 0 });
    const s = S.state;
    S.advanceDays(200);
    const m = s.stats.months.slice(-8);
    const f = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v.toFixed(2));
    console.log(cond, 'appeal', s.tourism.appeal.toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(s.tourism.appealParts).map(([k, v]) => [k, v.toFixed(2)]))));
    for (const x of m) console.log(`${x.year}-${x.month + 1} pop ${x.population} un ${(x.unemployment * 100).toFixed(1)} sat ${x.satisfaction.toFixed(2)} leis ${x.leisure.toFixed(2)} vis ${x.tourists} for ${x.foreignTourists} nights ${Math.round(x.touristNights)} spend ${f(x.tourismSpend)} rooms ${x.hotelRooms} occ ${(x.occupancy * 100).toFixed(0)}% turned ${Math.round(x.turnedAway)} bal ${f(x.balance)} tb ${f(x.tradeBalance)} fx ${x.fx.toFixed(3)} food ${(x.foodInsecure * 100).toFixed(0)}%`);
    for (const b of s.businesses.filter((q) => ['hotel', 'cinema', 'museum', 'stadium'].includes(q.kind))) {
      const p = b.profitHist.length ? b.profitHist.reduce((a, x) => a + x, 0) / b.profitHist.length : 0;
      console.log(' ', b.kind, b.name, b.status, 'rev', f(b.last.revenue), 'avgProfit', f(p), 'jobs', b.jobs.filter((j) => j.worker >= 0).length, '/', b.jobs.length, b.hotel ? `rooms ${b.hotel.rooms} nights ${Math.round(b.hotel.lastNights)}` : '', b.venue ? `sold ${b.venue.lastSold}` : '');
    }
    console.log('  leisure unmet', f(s.leisure.lastUnmet), 'spend', f(s.leisure.lastSpend), 'partners', s.trade.partners.map((p) => `${p.id}:${p.status}:x${f(p.lastExp)}:m${f(p.lastImp)}`).join(' '));
    console.log('  rev', JSON.stringify(Object.fromEntries(Object.entries(s.gov.last.rev).filter(([, v]) => v > 0).map(([k, v]) => [k, f(v)]))));
    console.log('  exp', JSON.stringify(Object.fromEntries(Object.entries(s.gov.last.exp).filter(([, v]) => v > 0).map(([k, v]) => [k, f(v)]))));
  }, 300000);
}
