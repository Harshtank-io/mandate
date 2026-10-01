// Static reference data: roles, buildings, businesses, crops and goods.
// All money values are base values (INR, 2026 price level). A world multiplies them by its money scale.

import type { BuildingKind, BusinessKind, CropId, Dept, Field, Good, RoleId } from './types';
import { Zone } from './types';

export interface RoleSpec { id: RoleId; label: string; edu: number; fields?: Field[]; wage: number }

export const ROLES: Record<RoleId, RoleSpec> = {
  farmhand: { id: 'farmhand', label: 'Farm worker', edu: 0, wage: 12000 },
  laborer: { id: 'laborer', label: 'Construction worker', edu: 0, wage: 15000 },
  helper: { id: 'helper', label: 'Helper', edu: 0, wage: 11000 },
  operator: { id: 'operator', label: 'Machine operator', edu: 1, wage: 16500 },
  driver: { id: 'driver', label: 'Truck driver', edu: 1, wage: 19000 },
  clerk: { id: 'clerk', label: 'Shop assistant', edu: 1, wage: 13500 },
  cook: { id: 'cook', label: 'Cook', edu: 1, wage: 15000 },
  officeassist: { id: 'officeassist', label: 'Administrative clerk', edu: 2, wage: 22000 },
  officer: { id: 'officer', label: 'Police officer', edu: 2, wage: 30000 },
  supervisor: { id: 'supervisor', label: 'Supervisor', edu: 2, wage: 26000 },
  support: { id: 'support', label: 'Customer support', edu: 2, wage: 21000 },
  technician: { id: 'technician', label: 'Technician', edu: 3, fields: ['trade', 'eng'], wage: 28000 },
  nurse: { id: 'nurse', label: 'Nurse', edu: 3, fields: ['med'], wage: 30000 },
  engineer: { id: 'engineer', label: 'Software engineer', edu: 4, fields: ['eng'], wage: 62000 },
  analyst: { id: 'analyst', label: 'Analyst', edu: 4, fields: ['biz', 'eng'], wage: 50000 },
  manager: { id: 'manager', label: 'Manager', edu: 4, wage: 70000 },
  teacher: { id: 'teacher', label: 'Teacher', edu: 4, wage: 40000 },
  lecturer: { id: 'lecturer', label: 'Lecturer', edu: 4, wage: 65000 },
  doctor: { id: 'doctor', label: 'Doctor', edu: 4, fields: ['med'], wage: 105000 },
  sitemgr: { id: 'sitemgr', label: 'Site engineer', edu: 4, fields: ['eng', 'trade'], wage: 55000 },
  host: { id: 'host', label: 'Hospitality staff', edu: 1, wage: 14000 },
  security: { id: 'security', label: 'Security guard', edu: 1, wage: 15000 },
  curator: { id: 'curator', label: 'Curator', edu: 4, fields: ['gen', 'biz'], wage: 45000 },
  controller: { id: 'controller', label: 'Air traffic controller', edu: 4, fields: ['eng'], wage: 85000 },
};

export const EDU_LABEL = ['No schooling', 'Primary', 'Secondary', 'Vocational diploma', 'University degree'];
export const FIELD_LABEL: Record<Field, string> = { gen: 'General studies', eng: 'Engineering', med: 'Medicine & nursing', biz: 'Business', trade: 'Technical trades' };

export interface BuildingSpec {
  kind: BuildingKind;
  label: string;
  w: number; h: number;
  floors: [number, number];
  unitsPerFloor: number; // residential units per floor (0 = none)
  cost: number; labor: number; materials: number; // per building, or per floor when perFloor
  perFloor: boolean;
  equipment: number; // fitted after construction (medical equipment, machinery)
  crew: number; // max construction workers on site
  zones: number[]; // zones where it may be built (empty = any non-agricultural)
  biz: BusinessKind | '';
  maintenance: number; // monthly upkeep as share of value
  category: 'residential' | 'commercial' | 'industrial' | 'agricultural' | 'civic';
}

const R = Zone.Residential, C = Zone.Commercial, I = Zone.Industrial, A = Zone.Agricultural;

export const BUILDINGS: Record<BuildingKind, BuildingSpec> = {
  house: { kind: 'house', label: 'House', w: 1, h: 1, floors: [1, 2], unitsPerFloor: 0, cost: 1_200_000, labor: 700, materials: 100, perFloor: false, equipment: 0, crew: 8, zones: [R], biz: '', maintenance: 0.0008, category: 'residential' },
  apartment: { kind: 'apartment', label: 'Apartment block', w: 1, h: 1, floors: [4, 8], unitsPerFloor: 4, cost: 4_000_000, labor: 2300, materials: 340, perFloor: true, equipment: 0, crew: 40, zones: [R, C], biz: '', maintenance: 0.0008, category: 'residential' },
  luxury: { kind: 'luxury', label: 'Luxury villa', w: 1, h: 1, floors: [2, 3], unitsPerFloor: 0, cost: 7_000_000, labor: 4000, materials: 600, perFloor: false, equipment: 0, crew: 12, zones: [R], biz: '', maintenance: 0.0008, category: 'residential' },
  affordable: { kind: 'affordable', label: 'Public housing', w: 2, h: 1, floors: [4, 6], unitsPerFloor: 8, cost: 10_000_000, labor: 3600, materials: 640, perFloor: true, equipment: 0, crew: 50, zones: [R, C], biz: '', maintenance: 0.001, category: 'residential' },
  shop: { kind: 'shop', label: 'Shop', w: 1, h: 1, floors: [1, 2], unitsPerFloor: 0, cost: 3_000_000, labor: 1200, materials: 200, perFloor: false, equipment: 0, crew: 12, zones: [C], biz: 'shop', maintenance: 0.001, category: 'commercial' },
  grocery: { kind: 'grocery', label: 'Grocery', w: 1, h: 1, floors: [1, 2], unitsPerFloor: 0, cost: 3_000_000, labor: 1200, materials: 200, perFloor: false, equipment: 0, crew: 12, zones: [C, R], biz: 'grocery', maintenance: 0.001, category: 'commercial' },
  restaurant: { kind: 'restaurant', label: 'Restaurant', w: 1, h: 1, floors: [1, 2], unitsPerFloor: 0, cost: 3_000_000, labor: 1200, materials: 200, perFloor: false, equipment: 0, crew: 12, zones: [C], biz: 'restaurant', maintenance: 0.001, category: 'commercial' },
  services: { kind: 'services', label: 'Local services row', w: 1, h: 1, floors: [1, 2], unitsPerFloor: 0, cost: 2_500_000, labor: 1000, materials: 180, perFloor: false, equipment: 0, crew: 12, zones: [C, R], biz: 'services', maintenance: 0.001, category: 'commercial' },
  office: { kind: 'office', label: 'Office building', w: 1, h: 1, floors: [4, 12], unitsPerFloor: 0, cost: 5_000_000, labor: 1800, materials: 320, perFloor: true, equipment: 0, crew: 40, zones: [C], biz: 'office', maintenance: 0.001, category: 'commercial' },
  factory: { kind: 'factory', label: 'Factory', w: 3, h: 2, floors: [1, 1], unitsPerFloor: 0, cost: 80_000_000, labor: 18000, materials: 3500, perFloor: false, equipment: 40_000_000, crew: 60, zones: [I], biz: 'factory', maintenance: 0.0012, category: 'industrial' },
  foodplant: { kind: 'foodplant', label: 'Food processing plant', w: 2, h: 2, floors: [1, 1], unitsPerFloor: 0, cost: 45_000_000, labor: 10000, materials: 2000, perFloor: false, equipment: 25_000_000, crew: 40, zones: [I], biz: 'foodplant', maintenance: 0.0012, category: 'industrial' },
  materials: { kind: 'materials', label: 'Building materials plant', w: 2, h: 2, floors: [1, 1], unitsPerFloor: 0, cost: 40_000_000, labor: 9000, materials: 1800, perFloor: false, equipment: 20_000_000, crew: 40, zones: [I], biz: 'materials', maintenance: 0.0012, category: 'industrial' },
  depot: { kind: 'depot', label: 'Logistics depot', w: 2, h: 2, floors: [1, 1], unitsPerFloor: 0, cost: 15_000_000, labor: 4000, materials: 700, perFloor: false, equipment: 30_000_000, crew: 25, zones: [I], biz: 'logistics', maintenance: 0.0012, category: 'industrial' },
  yard: { kind: 'yard', label: 'Construction yard', w: 2, h: 1, floors: [1, 1], unitsPerFloor: 0, cost: 8_000_000, labor: 2500, materials: 400, perFloor: false, equipment: 10_000_000, crew: 20, zones: [I], biz: 'construction', maintenance: 0.0012, category: 'industrial' },
  farmhouse: { kind: 'farmhouse', label: 'Farmhouse', w: 1, h: 1, floors: [1, 1], unitsPerFloor: 0, cost: 1_800_000, labor: 800, materials: 100, perFloor: false, equipment: 0, crew: 6, zones: [A], biz: 'farm', maintenance: 0.0008, category: 'agricultural' },
  townhall: { kind: 'townhall', label: 'Town hall', w: 2, h: 2, floors: [3, 3], unitsPerFloor: 0, cost: 60_000_000, labor: 18000, materials: 3200, perFloor: false, equipment: 0, crew: 50, zones: [], biz: 'townhall', maintenance: 0.001, category: 'civic' },
  school: { kind: 'school', label: 'School', w: 2, h: 2, floors: [2, 2], unitsPerFloor: 0, cost: 45_000_000, labor: 14000, materials: 2600, perFloor: false, equipment: 3_000_000, crew: 40, zones: [], biz: 'school', maintenance: 0.001, category: 'civic' },
  college: { kind: 'college', label: 'College', w: 3, h: 2, floors: [3, 3], unitsPerFloor: 0, cost: 140_000_000, labor: 40000, materials: 7000, perFloor: false, equipment: 15_000_000, crew: 80, zones: [], biz: 'college', maintenance: 0.001, category: 'civic' },
  clinic: { kind: 'clinic', label: 'Health clinic', w: 1, h: 1, floors: [2, 2], unitsPerFloor: 0, cost: 25_000_000, labor: 7000, materials: 1300, perFloor: false, equipment: 6_000_000, crew: 30, zones: [], biz: 'clinic', maintenance: 0.001, category: 'civic' },
  hospital: { kind: 'hospital', label: 'Hospital', w: 3, h: 3, floors: [4, 4], unitsPerFloor: 0, cost: 102_000_000, labor: 60000, materials: 11000, perFloor: false, equipment: 118_000_000, crew: 110, zones: [], biz: 'hospital', maintenance: 0.001, category: 'civic' },
  police: { kind: 'police', label: 'Police station', w: 2, h: 1, floors: [2, 2], unitsPerFloor: 0, cost: 22_000_000, labor: 6500, materials: 1200, perFloor: false, equipment: 2_000_000, crew: 30, zones: [], biz: 'police', maintenance: 0.001, category: 'civic' },
  park: { kind: 'park', label: 'Park', w: 1, h: 1, floors: [0, 0], unitsPerFloor: 0, cost: 400_000, labor: 150, materials: 10, perFloor: false, equipment: 0, crew: 10, zones: [], biz: '', maintenance: 0.004, category: 'civic' },
  hotel: { kind: 'hotel', label: 'Hotel', w: 1, h: 1, floors: [3, 8], unitsPerFloor: 0, cost: 14_000_000, labor: 2600, materials: 400, perFloor: true, equipment: 0, crew: 40, zones: [C], biz: 'hotel', maintenance: 0.0012, category: 'commercial' },
  cinema: { kind: 'cinema', label: 'Cinema', w: 1, h: 1, floors: [2, 2], unitsPerFloor: 0, cost: 30_000_000, labor: 6000, materials: 900, perFloor: false, equipment: 8_000_000, crew: 30, zones: [C], biz: 'cinema', maintenance: 0.001, category: 'commercial' },
  stadium: { kind: 'stadium', label: 'Stadium', w: 4, h: 3, floors: [1, 1], unitsPerFloor: 0, cost: 180_000_000, labor: 60000, materials: 14000, perFloor: false, equipment: 20_000_000, crew: 120, zones: [], biz: 'stadium', maintenance: 0.0008, category: 'civic' },
  museum: { kind: 'museum', label: 'Museum', w: 2, h: 2, floors: [2, 2], unitsPerFloor: 0, cost: 70_000_000, labor: 20000, materials: 3500, perFloor: false, equipment: 10_000_000, crew: 50, zones: [], biz: 'museum', maintenance: 0.001, category: 'civic' },
  heritage: { kind: 'heritage', label: 'Heritage site', w: 2, h: 2, floors: [1, 1], unitsPerFloor: 0, cost: 40_000_000, labor: 0, materials: 0, perFloor: false, equipment: 0, crew: 0, zones: [], biz: '', maintenance: 0, category: 'civic' },
  airport: { kind: 'airport', label: 'Regional airport', w: 24, h: 4, floors: [1, 1], unitsPerFloor: 0, cost: 450_000_000, labor: 200000, materials: 45000, perFloor: false, equipment: 150_000_000, crew: 260, zones: [], biz: 'airport', maintenance: 0.0006, category: 'civic' },
};

export function unitsFor(kind: BuildingKind, floors: number): number {
  const s = BUILDINGS[kind];
  if (kind === 'house') return floors >= 2 ? 2 : 1;
  if (kind === 'luxury' || kind === 'farmhouse') return 1;
  return s.unitsPerFloor * floors;
}

export interface BizSpec {
  kind: BusinessKind;
  label: string;
  jobs: [RoleId, number][];
  pub: boolean;
  dept?: Dept;
  building: BuildingKind | '';
  startup: number; // capital needed on top of premises
  sector: 'agriculture' | 'retail' | 'services' | 'industry' | 'public' | 'logistics' | 'construction' | 'property';
  serves?: number; // public services: people served at full staffing / seats
}

export const BUSINESSES: Record<BusinessKind, BizSpec> = {
  farm: { kind: 'farm', label: 'Farm', jobs: [], pub: false, building: 'farmhouse', startup: 0, sector: 'agriculture' },
  grocery: { kind: 'grocery', label: 'Grocery store', jobs: [['clerk', 1], ['helper', 1]], pub: false, building: 'grocery', startup: 1_500_000, sector: 'retail' },
  shop: { kind: 'shop', label: 'Retail shop', jobs: [['clerk', 2], ['supervisor', 1]], pub: false, building: 'shop', startup: 2_000_000, sector: 'retail' },
  restaurant: { kind: 'restaurant', label: 'Restaurant', jobs: [['cook', 2], ['helper', 2]], pub: false, building: 'restaurant', startup: 1_200_000, sector: 'retail' },
  services: { kind: 'services', label: 'Local services (repairs, salons, transport, tailoring)', jobs: [['helper', 3], ['clerk', 2], ['driver', 1], ['support', 1]], pub: false, building: 'services', startup: 600_000, sector: 'services' },
  office: { kind: 'office', label: 'Technology & services company', jobs: [['engineer', 5], ['analyst', 3], ['support', 3], ['manager', 1]], pub: false, building: 'office', startup: 8_000_000, sector: 'services' },
  factory: { kind: 'factory', label: 'Manufacturer', jobs: [['operator', 40], ['technician', 6], ['supervisor', 4], ['engineer', 2], ['manager', 2], ['driver', 2]], pub: false, building: 'factory', startup: 0, sector: 'industry' },
  foodplant: { kind: 'foodplant', label: 'Food processor', jobs: [['operator', 22], ['technician', 3], ['supervisor', 2], ['manager', 1], ['driver', 2]], pub: false, building: 'foodplant', startup: 0, sector: 'industry' },
  materials: { kind: 'materials', label: 'Building materials producer', jobs: [['operator', 18], ['technician', 2], ['supervisor', 2], ['manager', 1], ['driver', 3]], pub: false, building: 'materials', startup: 0, sector: 'industry' },
  logistics: { kind: 'logistics', label: 'Logistics company', jobs: [['driver', 10], ['clerk', 2], ['supervisor', 1], ['manager', 1]], pub: false, building: 'depot', startup: 0, sector: 'logistics' },
  construction: { kind: 'construction', label: 'Construction company', jobs: [['laborer', 16], ['technician', 2], ['supervisor', 2], ['sitemgr', 1], ['manager', 1]], pub: false, building: 'yard', startup: 0, sector: 'construction' },
  realestate: { kind: 'realestate', label: 'Property company', jobs: [], pub: false, building: '', startup: 0, sector: 'property' },
  school: { kind: 'school', label: 'School', jobs: [['teacher', 16], ['officeassist', 2], ['helper', 2]], pub: true, dept: 'education', building: 'school', startup: 0, sector: 'public', serves: 420 },
  college: { kind: 'college', label: 'College', jobs: [['lecturer', 20], ['officeassist', 4], ['helper', 3]], pub: true, dept: 'education', building: 'college', startup: 0, sector: 'public', serves: 600 },
  clinic: { kind: 'clinic', label: 'Health clinic', jobs: [['doctor', 3], ['nurse', 6], ['officeassist', 2], ['helper', 2]], pub: true, dept: 'health', building: 'clinic', startup: 0, sector: 'public', serves: 3500 },
  hospital: { kind: 'hospital', label: 'Hospital', jobs: [['doctor', 14], ['nurse', 36], ['technician', 6], ['officeassist', 6], ['helper', 10], ['manager', 2]], pub: true, dept: 'health', building: 'hospital', startup: 0, sector: 'public', serves: 22000 },
  police: { kind: 'police', label: 'Police station', jobs: [['officer', 20], ['officeassist', 2], ['supervisor', 2]], pub: true, dept: 'safety', building: 'police', startup: 0, sector: 'public', serves: 9000 },
  townhall: { kind: 'townhall', label: 'Town hall', jobs: [['officeassist', 22], ['manager', 3], ['analyst', 4], ['helper', 3]], pub: true, dept: 'admin', building: 'townhall', startup: 0, sector: 'public', serves: 40000 },
  hotel: { kind: 'hotel', label: 'Hotel', jobs: [['host', 4], ['helper', 4], ['cook', 2], ['supervisor', 1], ['manager', 1]], pub: false, building: 'hotel', startup: 8_000_000, sector: 'services' },
  cinema: { kind: 'cinema', label: 'Cinema', jobs: [['host', 4], ['technician', 1], ['cook', 1], ['supervisor', 1]], pub: false, building: 'cinema', startup: 3_000_000, sector: 'services' },
  stadium: { kind: 'stadium', label: 'Stadium', jobs: [['host', 8], ['security', 6], ['helper', 6], ['supervisor', 2], ['manager', 1]], pub: true, dept: 'culture', building: 'stadium', startup: 0, sector: 'public', serves: 12000 },
  museum: { kind: 'museum', label: 'Museum', jobs: [['curator', 3], ['host', 4], ['security', 3], ['helper', 2], ['officeassist', 1]], pub: true, dept: 'culture', building: 'museum', startup: 0, sector: 'public', serves: 1500 },
  airport: { kind: 'airport', label: 'Regional airport', jobs: [['controller', 4], ['technician', 8], ['security', 12], ['host', 10], ['helper', 8], ['supervisor', 3], ['manager', 2]], pub: true, dept: 'transport', building: 'airport', startup: 0, sector: 'public', serves: 60000 },
};

export interface CropSpec {
  id: CropId; good: Good; label: string;
  days: number; // growing days at optimal temperature
  yield: number; // t/ha at full health
  water: number; // mm/day crop water need
  tmin: number; tmax: number;
  seed: number; fert: number; // cost per ha
  prep: number; sow: number; harvest: number; // worker-days per ha
  color: [number, number, number];
}

export const CROPS: Record<CropId, CropSpec> = {
  wheat: { id: 'wheat', good: 'wheat', label: 'Wheat', days: 125, yield: 3.6, water: 4.2, tmin: 5, tmax: 32, seed: 5500, fert: 8500, prep: 6, sow: 3, harvest: 9, color: [0.83, 0.68, 0.3] },
  rice: { id: 'rice', good: 'rice', label: 'Rice', days: 130, yield: 4.4, water: 7.0, tmin: 16, tmax: 38, seed: 4000, fert: 9000, prep: 8, sow: 12, harvest: 10, color: [0.62, 0.72, 0.28] },
  maize: { id: 'maize', good: 'maize', label: 'Maize', days: 105, yield: 3.4, water: 4.8, tmin: 12, tmax: 36, seed: 6000, fert: 8000, prep: 6, sow: 3, harvest: 8, color: [0.85, 0.75, 0.35] },
  vegetables: { id: 'vegetables', good: 'vegetables', label: 'Vegetables', days: 85, yield: 14, water: 5.0, tmin: 8, tmax: 35, seed: 18000, fert: 14000, prep: 8, sow: 8, harvest: 35, color: [0.35, 0.6, 0.25] },
  cotton: { id: 'cotton', good: 'cotton', label: 'Cotton', days: 165, yield: 1.9, water: 5.0, tmin: 16, tmax: 40, seed: 7000, fert: 9000, prep: 7, sow: 4, harvest: 22, color: [0.92, 0.92, 0.88] },
};

/** Growth-rate multiplier for a crop at a given daily mean temperature (°C). */
export function cropTempFactor(c: CropSpec, t: number): number {
  if (t <= c.tmin) return 0;
  if (t < c.tmin + 7) return (t - c.tmin) / 7;
  if (t <= c.tmax - 4) return 1;
  if (t < c.tmax + 2) return Math.max(0.15, 1 - ((t - (c.tmax - 4)) / 6) * 0.85);
  return 0.1;
}

/** Hectares represented by one map tile (40 m x 40 m). */
export const HA_PER_TILE = 0.16;

export interface GoodSpec { id: Good; label: string; unit: string; truck: number; world: number; vol: number; spoil: number }

export const GOOD_SPECS: Record<Good, GoodSpec> = {
  wheat: { id: 'wheat', label: 'Wheat', unit: 't', truck: 10, world: 24500, vol: 0.008, spoil: 0 },
  rice: { id: 'rice', label: 'Rice (paddy)', unit: 't', truck: 10, world: 23000, vol: 0.007, spoil: 0 },
  maize: { id: 'maize', label: 'Maize', unit: 't', truck: 10, world: 21000, vol: 0.009, spoil: 0 },
  vegetables: { id: 'vegetables', label: 'Vegetables', unit: 't', truck: 8, world: 19000, vol: 0.02, spoil: 0.03 },
  cotton: { id: 'cotton', label: 'Cotton', unit: 't', truck: 6, world: 68000, vol: 0.01, spoil: 0 },
  food: { id: 'food', label: 'Packaged food', unit: 't', truck: 10, world: 36000, vol: 0.003, spoil: 0.002 },
  goods: { id: 'goods', label: 'Consumer goods', unit: 'crates', truck: 300, world: 1000, vol: 0.002, spoil: 0 },
  materials: { id: 'materials', label: 'Building materials', unit: 't', truck: 12, world: 5200, vol: 0.004, spoil: 0 },
};

/** Road-building specs per tile. */
export const ROADWORKS = {
  road: { label: 'Street', cost: 0, labor: 350, materials: 120, crew: 12 },
  avenue: { label: 'Avenue', cost: 0, labor: 700, materials: 260, crew: 20 },
  upgrade: { label: 'Widen to avenue', cost: 0, labor: 450, materials: 160, crew: 16 },
  canal: { label: 'Irrigation canal', cost: 0, labor: 300, materials: 60, crew: 14 },
} as const;

/** Monthly base rent per dwelling unit (before location and market adjustments). */
export const BASE_RENT: Partial<Record<BuildingKind, number>> = { house: 3800, apartment: 3400, luxury: 18000, affordable: 1500, farmhouse: 0 };

/** Monthly maintenance per road tile by class, plus wear per vehicle/hour of peak volume. */
export const ROAD_MAINT = [0, 120, 600, 1500];
export const ROAD_WEAR_COST = 3;
/** Price of one local service (haircut, repair, rickshaw ride, tuition hour), base. */
export const SERVICE_PRICE = 120;

export const ROAD_CAPACITY = [0, 600, 1600, 3200]; // vehicles/hour
export const ROAD_SPEED = [0, 30, 50, 80]; // km/h free-flow

// Per-person daily consumption (kg) of staples and vegetables.
export const FOOD_NEED = { adult: 0.6, child: 0.4 };
export const VEG_NEED = { adult: 0.35, child: 0.25 };
export const MEAL_PRICE = 90; // restaurant meal, base
/** Cooking gas, oil, spices, electricity and packaging bought in for each meal, base. */
export const MEAL_SUPPLIES = 25;
/** Meals a restaurant worker can prepare and serve in a day. */
export const MEALS_PER_STAFF = 30;
/** Share of a local service's price spent on bought-in parts, cosmetics and fuel. */
export const SERVICE_SUPPLY_SHARE = 0.2;
/** Gross rental yield at which investors buy finished homes (sale price = annual rent / yield). */
export const HOUSING_YIELD = 0.04;
export const MEAL_INPUT = { food: 0.00025, vegetables: 0.00015 }; // tonnes per meal (grain, pulses, oil; vegetables)

// ---------------------------------------------------------------------------------------- leisure & tourism (base values)
/** Share of a household's discretionary budget that goes on outings (cinema, museums, matches). */
export const LEISURE_SHARE = 0.07;
export const CINEMA_TICKET = 180;
/** Tickets a member of cinema staff can handle per day (box office, ushers, cleaning between shows). */
export const CINEMA_TICKETS_PER_STAFF = 320;
/** Share of ticket revenue paid to film distributors outside the city. */
export const DISTRIBUTOR_SHARE = 0.42;
export const MUSEUM_TICKET = 60;
export const STADIUM_TICKET = 220;
/** Entry fee at heritage sites: residents and domestic visitors / foreign visitors (dual pricing). */
export const HERITAGE_FEE = { domestic: 40, foreign: 500 };
export const HOTEL_ROOMS_PER_FLOOR = 8;
export const ROOM_RATE = 2600; // per night, domestic guests; foreign guests pay more
export const FOREIGN_RATE = 1.6;
/** Linen, toiletries, laundry, utilities and booking commissions, as a share of room revenue (bought in). */
export const HOTEL_SUPPLY_SHARE = 0.24;
/** What a visitor spends per day besides the room. */
export const VISITOR_SPEND = {
  domestic: { meals: 2, goods: 260, services: 160, museum: 0.25, cinema: 0.08, heritage: 0.8 },
  foreign: { meals: 2.5, goods: 750, services: 420, museum: 0.6, cinema: 0.02, heritage: 1 },
};
export const STAY_NIGHTS = { domestic: 1.8, foreign: 3.2 };
export const DAY_TRIP_SHARE = { domestic: 0.4, foreign: 0.1 };
/** Potential visitors per day for an attraction index of 1 at full awareness. */
export const VISITOR_BASE = { domestic: 40, foreign: 7 };
/** Monthly cost of tourism promotion campaigns by level (none, regional, national, international). */
export const PROMOTION_COST = [0, 150_000, 600_000, 2_000_000];
export const PROMOTION_REACH = { domestic: [0.35, 0.5, 0.75, 0.85], foreign: [0.08, 0.1, 0.18, 0.5] };
/** Cost of the annual festival by level (none, local, grand). */
export const FESTIVAL_COST = [0, 1_500_000, 5_000_000];
export const FESTIVAL_BOOST = [0, 0.6, 1.6];

// ---------------------------------------------------------------------------------------- aviation
export const SEATS_PER_FLIGHT = 72; // twin turboprop
export const LANDING_FEE = 18000;
export const AIRFARE = 5200; // average one-way domestic fare, base
/** Passengers a month the national scheme expects before it co-funds a regional airport. */
export const AIRPORT_MIN_DEMAND = 2000;
export const AIRPORT_COFUND = 0.75;

// ---------------------------------------------------------------------------------------- food programmes
/** Grain handed out per person per month through ration shops (kg). */
export const RATION_KG = 5;
/** Handling margin paid to the fair-price shop per kg distributed, base. */
export const RATION_HANDLING = 1.5;
/** Monthly storage and handling cost of government grain stocks, share of their value. */
export const STORAGE_COST = 0.012;
