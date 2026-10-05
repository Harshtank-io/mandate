// How each kind of building looks: footprint, height, wall and roof colours. Variation comes from the building's
// stable style seed so the same building always looks the same.

import { hash01 } from '../sim/rng';
import type { Building, BuildingKind } from '../sim/types';

export const FLOOR = 0.16; // world units per storey (vertical scale is exaggerated ~1.5x for readability)

export interface Look {
  w: number; d: number; h: number;
  wall: number;
  roof: 'gable' | 'flat';
  roofColor: number;
  roofH: number;
  floors: number; // window rows
  extra?: 'chimney' | 'silos' | 'tower' | 'sign' | 'marquee' | 'stands' | 'columns' | 'fort' | 'runway';
  /** The footprint was turned a quarter (it is deeper than it is wide): the usual look, rotated. */
  turned?: boolean;
}

const pick = (arr: number[], r: number) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

const HOUSE_WALLS = [0xe8dcc0, 0xe9c9a8, 0xc9d6df, 0xefe2a8, 0xf0ede6, 0xd8a47f, 0xdfe3d2];
const HOUSE_ROOFS = [0xa2503a, 0x7a4a3a, 0x5e5e66, 0x8c3b2e, 0x6b5a4a];
const APT_WALLS = [0xd9d4c7, 0xc8c2b5, 0xe3dccb, 0xbfc6cc, 0xd8c6a8, 0xcfd6d2];
const OFFICE_WALLS = [0x9fb3c4, 0x8aa0b4, 0xb4c2cc, 0x7f95a8];

export function lookFor(kind: BuildingKind, w: number, h: number, floors: number, style: number): Look {
  // every building type is designed wider than deep; a footprint placed the other way round is the same building turned
  if (h > w) { const L = lookFor(kind, h, w, floors, style); return { ...L, w: L.d, d: L.w, turned: true }; }
  const r = hash01(style, 1), r2 = hash01(style, 2);
  const f = Math.max(1, floors);
  switch (kind) {
    case 'house': return { w: 0.5, d: 0.46, h: FLOOR * f + 0.02, wall: pick(HOUSE_WALLS, r), roof: 'gable', roofColor: pick(HOUSE_ROOFS, r2), roofH: 0.14, floors: f };
    case 'luxury': return { w: 0.7, d: 0.58, h: FLOOR * f + 0.03, wall: pick([0xf4f1ea, 0xece3cf, 0xf6efe0], r), roof: 'gable', roofColor: pick([0x4a4a52, 0x6b3a2e], r2), roofH: 0.16, floors: f };
    case 'apartment': return { w: 0.72, d: 0.72, h: FLOOR * f, wall: pick(APT_WALLS, r), roof: 'flat', roofColor: 0x8f8a80, roofH: 0.03, floors: f };
    case 'affordable': return { w: Math.max(0.7, w - 0.28), d: 0.7, h: FLOOR * f, wall: pick([0xcfc8b8, 0xbdb6a6, 0xc9cfc4], r), roof: 'flat', roofColor: 0x807b70, roofH: 0.03, floors: f };
    case 'shop': return { w: 0.78, d: 0.7, h: FLOOR * 1.15 * f, wall: pick([0xe0d6c2, 0xe8c8b0, 0xd2d8e0], r), roof: 'flat', roofColor: 0x9a8f80, roofH: 0.03, floors: f };
    case 'grocery': return { w: 0.78, d: 0.7, h: FLOOR * 1.15 * f, wall: pick([0xd5e0c4, 0xe6e0b8], r), roof: 'flat', roofColor: 0x7d9a6a, roofH: 0.03, floors: f };
    case 'restaurant': return { w: 0.74, d: 0.68, h: FLOOR * 1.15 * f, wall: pick([0xe6c7a0, 0xe9b89a, 0xf0d7b0], r), roof: 'flat', roofColor: 0xa0603e, roofH: 0.03, floors: f };
    case 'services': return { w: 0.76, d: 0.66, h: FLOOR * f, wall: pick([0xd6cdb8, 0xcdd2c8, 0xe2d2bc], r), roof: 'flat', roofColor: 0x8c857a, roofH: 0.03, floors: f };
    case 'office': return { w: 0.66, d: 0.66, h: FLOOR * 1.2 * f, wall: pick(OFFICE_WALLS, r), roof: 'flat', roofColor: 0x6e7a86, roofH: 0.04, floors: f };
    case 'factory': return { w: w - 0.3, d: h - 0.3, h: 0.44, wall: pick([0x9aa2a8, 0xa7a49c], r), roof: 'flat', roofColor: 0x6f757a, roofH: 0.05, floors: 1, extra: 'chimney' };
    case 'foodplant': return { w: w - 0.35, d: h - 0.35, h: 0.36, wall: 0xc9c0a8, roof: 'flat', roofColor: 0x8f8876, roofH: 0.04, floors: 1, extra: 'silos' };
    case 'materials': return { w: w - 0.3, d: h - 0.3, h: 0.4, wall: 0xa5a09a, roof: 'flat', roofColor: 0x7c7770, roofH: 0.04, floors: 1, extra: 'chimney' };
    case 'depot': return { w: w - 0.3, d: h - 0.4, h: 0.26, wall: 0xb0a58c, roof: 'flat', roofColor: 0x7d7465, roofH: 0.03, floors: 1 };
    case 'yard': return { w: w - 0.3, d: h - 0.35, h: 0.14, wall: 0xa89c80, roof: 'flat', roofColor: 0x8a7f66, roofH: 0.02, floors: 1 };
    case 'farmhouse': return { w: 0.42, d: 0.4, h: 0.2, wall: pick([0xe2d6b8, 0xd9c9a2, 0xe8e0cc], r), roof: 'gable', roofColor: pick([0xa8452f, 0x8e5a3a, 0x9a6b4a], r2), roofH: 0.13, floors: 1 };
    case 'townhall': return { w: w - 0.3, d: h - 0.3, h: FLOOR * 3 + 0.08, wall: 0xd9c7a1, roof: 'flat', roofColor: 0xa88f68, roofH: 0.05, floors: 3, extra: 'tower' };
    case 'school': return { w: w - 0.3, d: h - 0.4, h: FLOOR * 2, wall: 0xe8d28c, roof: 'flat', roofColor: 0x9a8f7a, roofH: 0.04, floors: 2 };
    case 'college': return { w: w - 0.3, d: h - 0.3, h: FLOOR * 3, wall: 0xb5694f, roof: 'flat', roofColor: 0x7a4a3a, roofH: 0.04, floors: 3 };
    case 'clinic': return { w: 0.74, d: 0.7, h: FLOOR * 2, wall: 0xe9efe9, roof: 'flat', roofColor: 0x6fae7a, roofH: 0.04, floors: 2 };
    case 'hospital': return { w: w - 0.35, d: h - 0.35, h: FLOOR * 4, wall: 0xf1f1ee, roof: 'flat', roofColor: 0xc94c4c, roofH: 0.05, floors: 4 };
    case 'police': return { w: w - 0.3, d: 0.68, h: FLOOR * 2, wall: 0x8fa6c4, roof: 'flat', roofColor: 0x4d5f7a, roofH: 0.04, floors: 2 };
    case 'park': return { w: 0, d: 0, h: 0, wall: 0x5e9a48, roof: 'flat', roofColor: 0x5e9a48, roofH: 0, floors: 0 };
    case 'hotel': return { w: 0.7, d: 0.64, h: FLOOR * 1.1 * f, wall: pick([0xf2ece0, 0xe9d8c0, 0xd9e2ea, 0xf0dcc8], r), roof: 'flat', roofColor: 0x7d6a58, roofH: 0.04, floors: f, extra: 'sign' };
    case 'cinema': return { w: 0.86, d: 0.78, h: 0.36, wall: pick([0x7a3b4a, 0x5b4a78, 0x8a4a3a], r), roof: 'flat', roofColor: 0x3d3540, roofH: 0.04, floors: 1, extra: 'marquee' };
    case 'stadium': return { w: w - 0.2, d: h - 0.2, h: 0.34, wall: 0xcfc9bd, roof: 'flat', roofColor: 0xe6e6e2, roofH: 0.03, floors: 2, extra: 'stands' };
    case 'museum': return { w: w - 0.4, d: h - 0.62, h: FLOOR * 2.3, wall: 0xe8e0cc, roof: 'gable', roofColor: 0x8d8371, roofH: 0.16, floors: 2, extra: 'columns' };
    case 'heritage': return { w: w - 0.5, d: h - 0.5, h: 0.3, wall: pick([0xb8a07a, 0xa89272, 0xc2ab86], r), roof: 'flat', roofColor: 0x9a845f, roofH: 0.03, floors: 1, extra: 'fort' };
    // the look is the terminal; the view lays out the runway, taxiway, apron and tower around it
    case 'airport': return { w: Math.min(4.2, w - 0.3), d: 0.72, h: 0.32, wall: 0xdfe6ea, roof: 'flat', roofColor: 0x9aa6ae, roofH: 0.035, floors: 2, extra: 'runway' };
  }
}

export function buildingLook(b: Building): Look { return lookFor(b.kind, b.w, b.h, b.floors, b.style); }

/** Colours of freight by good, for trucks. */
export const GOOD_COLORS: Record<string, number> = {
  wheat: 0xd9b24a, rice: 0xb9c35a, maize: 0xe3c04f, vegetables: 0x5aa04a, cotton: 0xf2f2ee, food: 0xe0823a, goods: 0x4f7fd0, materials: 0x9a9a9a,
};

export const CAR_COLORS = [0xd8d8d8, 0x3a3f47, 0xb03a2e, 0x2f5f9a, 0xe6e2d6, 0x6b6f75, 0x9a7b4f, 0x2e6b4f];
