// Daily weather drawn from the region's monthly climate normals with persistent seasonal anomalies.
// Droughts, floods and heatwaves are declared from the simulated weather itself, not rolled separately.

import type { Sim } from '../core';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export function weatherDaily(sim: Sim): void {
  const w = sim.s.weather, cl = sim.preset.climate, d = sim.date, r = sim.rng;
  const quarter = d.year * 4 + Math.floor(d.month / 3);
  if (w.anomalyQuarter !== quarter) {
    w.anomalyQuarter = quarter;
    w.anomaly = Math.exp(r.normal() * cl.variability);
  }
  const m = d.month;
  const nxt = (m + 1) % 12;
  const f = (d.dom - 1) / d.daysInMonth;
  const tNormal = cl.temp[m] * (1 - f * 0.5) + cl.temp[nxt] * f * 0.5;
  w.tempDev = w.tempDev * 0.78 + r.normal() * 1.5;
  w.temp = tNormal + w.tempDev + (w.anomaly < 0.6 && cl.rain[m] > 60 ? 1.5 : 0);
  const pRain = Math.min(0.95, (cl.rainDays[m] / d.daysInMonth) * Math.sqrt(w.anomaly));
  let rain = 0;
  if (r.chance(pRain)) {
    const mean = (cl.rain[m] * Math.sqrt(w.anomaly)) / Math.max(0.2, cl.rainDays[m]);
    rain = -Math.log(1 - r.next() * 0.999) * mean;
  }
  w.rain = rain;
  w.rainLog.push(rain);
  w.normalLog.push(cl.rain[m] / d.daysInMonth);
  if (w.rainLog.length > 90) w.rainLog.shift();
  if (w.normalLog.length > 90) w.normalLog.shift();

  // droughts are judged on a 90-day window during seasons that normally bring substantial rain
  const r90 = sum(w.rainLog), n90 = sum(w.normalLog);
  if (w.rainLog.length >= 80) {
    if (!w.drought && n90 > 220 && r90 < 0.5 * n90) {
      w.drought = true;
      sim.emit('weather.drought', `Drought declared: only ${Math.round((r90 / n90) * 100)}% of normal rainfall in the last three months.`, 3, undefined, undefined,
        [`${Math.round(r90)} mm of rain fell against a normal ${Math.round(n90)} mm`, 'Rain-fed crops are under water stress; canals and wells run lower']);
    } else if (w.drought && (r90 > 0.75 * n90 || n90 < 90)) {
      w.drought = false;
      sim.emit('weather.droughtEnd', 'The drought has eased.', 1);
    }
  }
  w.flood++;
  const r3 = sum(w.rainLog.slice(-3));
  if ((rain > 110 || r3 > 230) && w.flood > 20) {
    w.flood = 0;
    sim.emit('weather.flood', `Flooding after ${Math.round(r3)} mm of rain in three days.`, 3, undefined, undefined,
      ['Low-lying fields near the river and canals are waterlogged', 'Riverside roads are damaged', 'Construction sites stop work']);
  }
  if (w.temp > 40) {
    w.heatDays++;
    if (w.heatDays === 3) sim.emit('weather.heat', `Heatwave: temperatures above 40°C for three days.`, 2, undefined, undefined, ['Crops and elderly residents are at risk']);
  } else w.heatDays = 0;
  if (w.pandemic > 0) {
    w.pandemic--;
    if (w.pandemic === 0) sim.emit('health.pandemicEnd', 'The epidemic has subsided.', 2);
  }
}

/** True when outdoor work (construction, field work) stops today. */
export function badWeather(sim: Sim): boolean {
  const w = sim.s.weather;
  return w.rain > 25 || w.flood < 3;
}
