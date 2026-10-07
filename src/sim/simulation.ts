// Orchestrates the systems. Time advances continuously; at each midnight the daily systems run, and on the first
// of each month the monthly accounting and decisions run. The same code path is used live and for offline catch-up,
// so a world simulated while the player was away evolves exactly as it would have with the game open.

import { dateOf, MIN_PER_DAY } from './calendar';
import { Sim } from './core';
import { createWorld, type NewWorldOptions } from './worldgen';
import { agricultureDaily } from './systems/agriculture';
import { businessDaily, businessMonthly } from './systems/business';
import { constructionDaily, createProject, fmtMoney } from './systems/construction';
import { entryMonthly } from './systems/entry';
import { environmentDaily, environmentMonthly } from './systems/environment';
import { externalDaily, externalMonthly } from './systems/external';
import { governmentDaily, governmentMonthly, rollGovLedger } from './systems/government';
import { householdsDaily, householdsMonthly } from './systems/households';
import { findLot, housingDaily, housingMonthly } from './systems/housing';
import { laborDaily, laborMonthly } from './systems/labor';
import { processArrivals } from './systems/logistics';
import { marketDaily, marketMonthly } from './systems/market';
import { milestonesMonthly, seedMilestones } from './systems/milestones';
import { harvestReport, newsDaily, newsMonthly, onEventNews, pushNews } from './systems/news';
import { populationDaily, populationMonthly } from './systems/population';
import { productionDaily } from './systems/production';
import { servicesMonthly } from './systems/services';
import { shocksMonthly } from './systems/shocks';
import { statsMonthly } from './systems/stats';
import { assignTraffic, transportDaily } from './systems/transport';
import { weatherDaily } from './systems/weather';
import { leisureDaily, leisureMonthly } from './systems/leisure';
import { computeAppeal, tourismCosts, tourismDaily, tourismMonthly } from './systems/tourism';
import { aviationDaily, aviationMonthly } from './systems/aviation';
import { tradeDaily, tradeMonthly } from './systems/trade';
import { foodMonthly } from './systems/food';
import { utilitiesDaily, utilitiesMonthly } from './systems/utilities';
import { fireDaily } from './systems/fire';
import { migrate } from './migrate';
import { Zone, GOODS, type WorldState } from './types';

export interface SystemDef { id: string; daily?: (sim: Sim) => void; monthly?: (sim: Sim) => void }

/** Daily systems in execution order. New systems plug in here. */
export const DAILY: SystemDef[] = [
  { id: 'government', daily: governmentDaily },
  { id: 'trade', daily: tradeDaily },
  { id: 'external', daily: externalDaily },
  { id: 'weather', daily: weatherDaily },
  // electricity and water first: plants, shops and homes work with what they get today
  { id: 'utilities', daily: utilitiesDaily },
  { id: 'labor', daily: laborDaily },
  { id: 'agriculture', daily: agricultureDaily },
  { id: 'production', daily: productionDaily },
  { id: 'market', daily: marketDaily },
  { id: 'aviation', daily: aviationDaily },
  { id: 'leisure', daily: leisureDaily },
  // visitors shop before residents' weekly rounds; both share the day's staff capacity
  { id: 'tourism', daily: tourismDaily },
  { id: 'households', daily: householdsDaily },
  { id: 'business', daily: businessDaily },
  { id: 'construction', daily: constructionDaily },
  { id: 'fire', daily: fireDaily },
  { id: 'population', daily: populationDaily },
  { id: 'housing', daily: housingDaily },
  { id: 'transport', daily: transportDaily },
  { id: 'environment', daily: environmentDaily },
  { id: 'news', daily: newsDaily },
];

/** Monthly systems: first close the books on the month that ended, then take decisions for the new one. */
export const MONTHLY: SystemDef[] = [
  { id: 'business', monthly: businessMonthly },
  { id: 'government', monthly: governmentMonthly },
  { id: 'food', monthly: foodMonthly },
  { id: 'households', monthly: householdsMonthly },
  { id: 'housing', monthly: housingMonthly },
  { id: 'labor', monthly: laborMonthly },
  { id: 'services', monthly: servicesMonthly },
  { id: 'leisure', monthly: leisureMonthly },
  { id: 'environment', monthly: environmentMonthly },
  { id: 'entry', monthly: entryMonthly },
  { id: 'harvest', monthly: harvestReport },
  { id: 'tourismCosts', monthly: tourismCosts },
  { id: 'stats', monthly: statsMonthly },
  // these close their month-to-date counters, so they run after the statistics have read them
  { id: 'utilities', monthly: utilitiesMonthly },
  { id: 'tourism', monthly: tourismMonthly },
  { id: 'aviation', monthly: aviationMonthly },
  { id: 'trade', monthly: tradeMonthly },
  { id: 'news', monthly: newsMonthly },
  { id: 'milestones', monthly: milestonesMonthly },
  { id: 'external', monthly: externalMonthly },
  { id: 'population', monthly: populationMonthly },
  { id: 'shocks', monthly: shocksMonthly },
  { id: 'market', monthly: marketMonthly },
  { id: 'ledgers', monthly: rollGovLedger },
];

export class Simulation {
  sim: Sim;

  constructor(sim: Sim) {
    this.sim = sim;
    sim.listeners.add((e) => onEventNews(sim, e));
  }

  /**
   * Generates a world and simulates the year before the player takes office, so the place has a history
   * (statistics, news, businesses that opened and closed) and has settled into its own rhythm.
   */
  static create(o: NewWorldOptions): Simulation {
    const s = Simulation.generate(o);
    s.advanceTo(s.officeMinute());
    s.takeOffice();
    return s;
  }

  /** Generates a world without its history year. Follow with advanceTo(officeMinute()) and takeOffice(). */
  static generate(o: NewWorldOptions): Simulation {
    const sim = createWorld(o);
    const s = new Simulation(sim);
    s.bootstrap();
    return s;
  }

  static fromState(state: WorldState): Simulation {
    return new Simulation(new Sim(migrate(state)));
  }

  get state(): WorldState { return this.sim.s; }

  /** Minute at which the player's administration takes office (8:00 on 1 January of the office year). */
  officeMinute(): number { return this.sim.s.meta.officeDay * MIN_PER_DAY + 8 * 60; }

  get inOffice(): boolean { return this.sim.s.minute >= this.officeMinute(); }

  /** One-off setup after generation: traffic, services and a baseline statistics snapshot. */
  bootstrap(): void {
    const sim = this.sim, s = sim.s;
    for (const g of GOODS) for (let k = 0; k < 30; k++) s.market[g].hist.push(s.market[g].price);
    assignTraffic(sim);
    laborDaily(sim);
    utilitiesDaily(sim);
    servicesMonthly(sim);
    environmentDaily(sim);
    weatherDaily(sim);
    leisureMonthly(sim);
    computeAppeal(sim);
    statsMonthly(sim);
  }

  /** Hands the place to the player once its history year has been simulated. */
  takeOffice(): void {
    const sim = this.sim, s = sim.s;
    seedMilestones(sim);
    if (s.meta.condition === 'empty') {
      pushNews(sim, {
        tag: 'government', headline: `Work begins on a new town: ${s.meta.name}`,
        body: `The development authority holds ${fmtMoney(sim, s.gov.cash)} to lay out roads, build public facilities and house the first settlers. Nobody lives here yet.`,
        why: ['The regional highway already crosses the site', 'Settlers, farmers and businesses come when there is zoned land, homes and work for them'], eventId: -1,
      });
      return;
    }
    // make sure a few private homes are going up when the player arrives
    const building = s.projects.some((p) => !p.gov && (p.kind === 'house' || p.kind === 'apartment') && p.phase === 'construction');
    const dev = s.businesses.find((b) => b.kind === 'realestate');
    const starts = building ? 0 : s.meta.condition === 'growing' ? 3 : 1;
    for (let k = 0; k < starts && dev; k++) {
      const apt = k === 0 && s.meta.condition !== 'developing';
      const lot = findLot(sim, apt ? [Zone.Residential, Zone.Commercial] : [Zone.Residential]);
      if (!lot) break;
      const p = createProject(sim, { kind: apt ? 'apartment' : 'house', x: lot.x, y: lot.y, w: 1, h: 1, floors: apt ? 6 : 1, gov: false, sponsor: dev.id, name: `${apt ? 'Apartment block' : 'House'} by ${dev.name}`, reason: 'Private housing demand' });
      p.phase = 'construction';
      p.started = sim.day;
    }
    const last = s.stats.months[s.stats.months.length - 1];
    pushNews(sim, {
      tag: 'government', headline: `A new administration takes office in ${s.meta.name}`,
      body: `Population ${s.citizens.length.toLocaleString('en-US')}${last ? `, unemployment ${(last.unemployment * 100).toFixed(1)}%` : ''}. The treasury holds ${fmtMoney(sim, s.gov.cash)}${s.gov.debt > 0 ? ` against debts of ${fmtMoney(sim, s.gov.debt)}` : ''}.`,
      why: [], eventId: -1,
    });
  }

  /** Advances simulated time to minute `target`. */
  advanceTo(target: number): void {
    const s = this.sim.s;
    while (s.minute < target) {
      const nextMidnight = (Math.floor(s.minute / MIN_PER_DAY) + 1) * MIN_PER_DAY;
      const step = Math.min(target, nextMidnight);
      processArrivals(this.sim, step);
      s.minute = step;
      if (step === nextMidnight) this.dayTick();
    }
  }

  advanceDays(days: number): void { this.advanceTo(this.sim.s.minute + days * MIN_PER_DAY); }

  private dayTick(): void {
    const sim = this.sim;
    sim.day = Math.floor(sim.s.minute / MIN_PER_DAY);
    sim.date = dateOf(sim.s.meta.startYear, sim.day);
    if (sim.date.dom === 1) for (const sys of MONTHLY) sys.monthly!(sim);
    for (const sys of DAILY) sys.daily!(sim);
  }
}
