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
  extra?: 'chimney' | 'silos' | 'tower' | 'sign' | 'marquee' | 'stands' | 'columns' | 'fort' | 'runway' | 'firehall' | 'stacks' | 'panels' | 'turbines' | 'tanks' | 'yard';
  /** The footprint was turned a quarter (it is deeper than it is wide): the usual look, rotated. */
  turned?: boolean;
}

const pick = (arr: number[], r: number) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

const HOUSE_WALLS = [0xe8dcc0, 0xe9c9a8, 0xc9d6df, 0xefe2a8, 0xf0ede6, 0xd8a47f, 0xdfe3d2];
const HOUSE_ROOFS = [0xa2503a, 0x7a4a3a, 0x5e5e66, 0x8c3b2e, 0x6b5a4a];
const APT_WALLS = [0xd9d4c7, 0xc8c2b5, 0xe3dccb, 0xbfc6cc, 0xd8c6a8, 0xcfd6d2];
const OFFICE_WALLS = [0x9fb3c4, 0x8aa0b4, 0xb4c2cc, 0x7f95a8];

/**
 * How each region builds its homes: wall colours, roofing (clay tiles, slate, painted tin sheets, concrete) and how
 * many houses have flat roofs. This is what makes a Mekong street, a highland village and a Punjab town look apart.
 */
interface RegionStyle { walls: number[]; roofs: number[]; flat: number; flatRoofs: number[]; apartments: number[]; farmWalls: number[]; farmRoofs: number[] }
const DEFAULT_STYLE: RegionStyle = {
  walls: HOUSE_WALLS, roofs: HOUSE_ROOFS, flat: 0, flatRoofs: [0x9a958a, 0x8f8a80], apartments: APT_WALLS,
  farmWalls: [0xe2d6b8, 0xd9c9a2, 0xe8e0cc], farmRoofs: [0xa8452f, 0x8e5a3a, 0x9a6b4a],
};
const STYLES: Record<string, RegionStyle> = {
  'in-deccan': { ...DEFAULT_STYLE, walls: [0xe8dcc0, 0xefe2a8, 0xd8a47f, 0xc9d6df, 0xf0ede6, 0xe9c9a8, 0xb8d0b0], roofs: [0xa2503a, 0x8c3b2e, 0x9a5a3a, 0x7a4a3a], flat: 0.35 },
  'in-punjab': { ...DEFAULT_STYLE, walls: [0xb5664a, 0xc47a5a, 0xe3d3b5, 0xd9c29a, 0xa95c45, 0xead9bd], roofs: [0x8c3b2e, 0x7a4a3a], flat: 0.8,
    flatRoofs: [0xa39a8a, 0x958c7c, 0xb0a594], farmWalls: [0xb5664a, 0xc8a27a, 0xd9c29a] },
  'ke-rift': { ...DEFAULT_STYLE, walls: [0xe9e2d0, 0xc9b28a, 0xd8cdb5, 0xa9c4d4, 0xe0c890, 0xbfd4b0], roofs: [0x8a8f94, 0x9a3b30, 0x3f6b4a, 0x5a6e8a, 0x7f868c], flat: 0.08,
    farmWalls: [0xc9a878, 0xb8956a, 0xd8c49a], farmRoofs: [0x8a8f94, 0x7f868c, 0x9a3b30] },
  'vn-mekong': { ...DEFAULT_STYLE, walls: [0xf2d16b, 0x9fd0c0, 0xf0b0a0, 0xa8c8e8, 0xf4f0e6, 0xe8c0e0], roofs: [0xb5502e, 0xc0623a, 0x8a8f94], flat: 0.45,
    apartments: [0xf2d16b, 0x9fd0c0, 0xf0c8b0, 0xb8d4ec, 0xf4f0e6], farmRoofs: [0x8a8f94, 0xb5502e, 0x7f868c] },
  fictional: { ...DEFAULT_STYLE, walls: [0xf2efe6, 0xe8e2d2, 0xd9cfbc, 0xc9b8a0, 0xe6ddc8], roofs: [0x3f4450, 0x4a4a52, 0x6b3a2e, 0x55402f], flat: 0,
    apartments: [0xd9d4c7, 0xc8c2b5, 0xb8ad98, 0xcfc4ae], farmWalls: [0xe8e0cc, 0xd9cfbc, 0xc9b8a0], farmRoofs: [0x3f4450, 0x55402f, 0x6b3a2e] },
  'bd-delta': { ...DEFAULT_STYLE, walls: [0xc9b8a8, 0xd8cbb8, 0xb04a3a, 0xe6dccb, 0xa8c8b8], roofs: [0x7f8a94, 0x96a0a8, 0x6d7780, 0xa05a3a], flat: 0.3,
    farmWalls: [0xc2a77e, 0xb89a72, 0xd0bc96], farmRoofs: [0x7f8a94, 0x96a0a8, 0x6d7780] },
  'id-java': { ...DEFAULT_STYLE, walls: [0xf4f1ea, 0xe8d8b8, 0xd8e8d0, 0xf0d8c0, 0xc8dce8], roofs: [0xb04a2a, 0xa0402a, 0xc0603a, 0x8a3a28], flat: 0.05,
    farmRoofs: [0xb04a2a, 0xa0402a, 0x8a3a28] },
  'ng-savanna': { ...DEFAULT_STYLE, walls: [0xc8945a, 0xb8804a, 0xd8b080, 0xe8d8b8, 0xa87048], roofs: [0x8a8f94, 0x9a6040, 0x7f8486], flat: 0.35,
    flatRoofs: [0xb08050, 0xa07448, 0x9a958a], apartments: [0xe0c8a0, 0xd8b890, 0xe8dcc8, 0xc8b8a0], farmWalls: [0xb8804a, 0xa87048, 0xc8945a], farmRoofs: [0xc8a060, 0x8a8f94, 0xb89050] },
  'et-highlands': { ...DEFAULT_STYLE, walls: [0x6aa0c8, 0x8cc08a, 0xe8d870, 0xe8e2d0, 0xd88a6a, 0xb8a0d0], roofs: [0x9aa0a6, 0x8a9096, 0xa8aeb4], flat: 0.1,
    farmWalls: [0xb89a72, 0xc8ac80, 0xa8885e], farmRoofs: [0x9aa0a6, 0xb8a070, 0x8a9096] },
};
let regional: RegionStyle = DEFAULT_STYLE;

/** Chooses the building styles of the region whose town is on screen. */
export function setRegionStyle(region: string): void { regional = STYLES[region] ?? DEFAULT_STYLE; }

export function lookFor(kind: BuildingKind, w: number, h: number, floors: number, style: number): Look {
  // every building type is designed wider than deep; a footprint placed the other way round is the same building turned
  if (h > w) { const L = lookFor(kind, h, w, floors, style); return { ...L, w: L.d, d: L.w, turned: true }; }
  const r = hash01(style, 1), r2 = hash01(style, 2);
  const f = Math.max(1, floors);
  const S = regional;
  switch (kind) {
    case 'house': return hash01(style, 6) < S.flat
      ? { w: 0.52, d: 0.48, h: FLOOR * f + 0.04, wall: pick(S.walls, r), roof: 'flat', roofColor: pick(S.flatRoofs, r2), roofH: 0.025, floors: f }
      : { w: 0.5, d: 0.46, h: FLOOR * f + 0.02, wall: pick(S.walls, r), roof: 'gable', roofColor: pick(S.roofs, r2), roofH: 0.14, floors: f };
    case 'luxury': return { w: 0.7, d: 0.58, h: FLOOR * f + 0.03, wall: pick([0xf4f1ea, 0xece3cf, 0xf6efe0], r), roof: 'gable', roofColor: pick([0x4a4a52, ...S.roofs.slice(0, 1)], r2), roofH: 0.16, floors: f };
    case 'apartment': return { w: 0.72, d: 0.72, h: FLOOR * f, wall: pick(S.apartments, r), roof: 'flat', roofColor: 0x8f8a80, roofH: 0.03, floors: f };
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
    case 'farmhouse': return { w: 0.42, d: 0.4, h: 0.2, wall: pick(S.farmWalls, r), roof: 'gable', roofColor: pick(S.farmRoofs, r2), roofH: 0.13, floors: 1 };
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
    case 'firestation': return { w: w - 0.3, d: 0.7, h: FLOOR * 2, wall: 0xc4473c, roof: 'flat', roofColor: 0x7d2c26, roofH: 0.04, floors: 2, extra: 'firehall' };
    case 'gasplant': return { w: w - 0.9, d: h - 0.6, h: 0.42, wall: 0xa9aeb2, roof: 'flat', roofColor: 0x6d7378, roofH: 0.04, floors: 1, extra: 'stacks' };
    case 'waterworks': return { w: 0.8, d: 0.7, h: 0.26, wall: 0xc9d2d4, roof: 'flat', roofColor: 0x6f8a94, roofH: 0.03, floors: 1, extra: 'tanks' };
    // panels, turbines and switchgear are laid out by the view; the look is the control building a click hits
    case 'solarfarm': return { w: 0.42, d: 0.3, h: 0.14, wall: 0xd9dcd6, roof: 'flat', roofColor: 0x8c9196, roofH: 0.02, floors: 1, extra: 'panels' };
    case 'windfarm': return { w: 0.36, d: 0.28, h: 0.14, wall: 0xdfe2e4, roof: 'flat', roofColor: 0x9aa0a5, roofH: 0.02, floors: 1, extra: 'turbines' };
    case 'substation': return { w: 0.34, d: 0.26, h: 0.14, wall: 0xb8bcbf, roof: 'flat', roofColor: 0x7a7f84, roofH: 0.02, floors: 1, extra: 'yard' };
  }
}

export function buildingLook(b: Building): Look { return lookFor(b.kind, b.w, b.h, b.floors, b.style); }

/** Colours of freight by good, for trucks. */
export const GOOD_COLORS: Record<string, number> = {
  wheat: 0xd9b24a, rice: 0xb9c35a, maize: 0xe3c04f, vegetables: 0x5aa04a, cotton: 0xf2f2ee, food: 0xe0823a, goods: 0x4f7fd0, materials: 0x9a9a9a,
};

export const CAR_COLORS = [0xd8d8d8, 0x3a3f47, 0xb03a2e, 0x2f5f9a, 0xe6e2d6, 0x6b6f75, 0x9a7b4f, 0x2e6b4f];
