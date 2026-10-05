import type { Sim } from './core';
import type { BusinessKind } from './types';

const FARM_A = ['Green', 'Golden', 'River', 'Hill', 'Sunrise', 'Old Well', 'East', 'West', 'Banyan', 'Stone', 'Willow', 'Canal'];
const FARM_B = ['Valley', 'Fields', 'Acres', 'Meadow', 'Bend', 'Ridge', 'Orchard', 'Plains', 'Grove'];

export function firstName(sim: Sim, female: boolean): string {
  const n = sim.preset.names;
  return sim.rng.pick(female ? n.female : n.male);
}

export function lastName(sim: Sim): string {
  return sim.rng.pick(sim.preset.names.last);
}

export function businessName(sim: Sim, kind: BusinessKind, ownerLast?: string): string {
  const p = sim.preset;
  const r = sim.rng;
  if (kind === 'farm') {
    return r.chance(0.5) && ownerLast ? `${ownerLast} Farm` : `${r.pick(FARM_A)} ${r.pick(FARM_B)} Farm`;
  }
  const town = sim.s.meta.name;
  switch (kind) {
    case 'school': return `${town} School No. ${1 + sim.s.businesses.filter((b) => b.kind === 'school').length}`;
    case 'college': return `${town} College of Arts, Science & Technology`;
    case 'clinic': return `${town} Health Clinic ${String.fromCharCode(65 + sim.s.businesses.filter((b) => b.kind === 'clinic').length)}`;
    case 'hospital': return `${town} District Hospital`;
    case 'police': return `${town} Police Station ${1 + sim.s.businesses.filter((b) => b.kind === 'police').length}`;
    case 'townhall': return `${town} Town Hall`;
    case 'museum': {
      const n = sim.s.businesses.filter((b) => b.kind === 'museum').length;
      return n === 0 ? `${town} Museum` : `${town} ${['Art Gallery', 'Science Centre', 'Museum of the Region'][(n - 1) % 3]}`;
    }
    case 'stadium': return sim.s.businesses.some((b) => b.kind === 'stadium') ? `${town} Sports Ground` : `${town} Stadium`;
    case 'airport': return `${town} Airport`;
    default: break;
  }
  const words = p.words[kind] ?? ['Enterprises'];
  const prefix = ownerLast && r.chance(0.45) ? ownerLast : r.pick(p.bizPrefix);
  return `${prefix} ${r.pick(words)}`;
}
