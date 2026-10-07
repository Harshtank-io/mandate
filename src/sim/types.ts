// Core data model for the simulation. Everything in WorldState is plain, JSON-serialisable data so
// that it can be persisted, restored and simulated forward (offline catch-up) deterministically.

export const MAP_SIZE = 128; // tiles per side
export const TILE = 40; // metres per tile

export const Terrain = { Grass: 0, Forest: 1, Water: 2, Farmland: 3, Canal: 4 } as const;
export const Zone = { None: 0, Residential: 1, Commercial: 2, Industrial: 3, Agricultural: 4, Park: 5 } as const;
export const RoadClass = { None: 0, Street: 1, Avenue: 2, Highway: 3 } as const;

export type Good = 'wheat' | 'rice' | 'maize' | 'vegetables' | 'cotton' | 'food' | 'goods' | 'materials';
export const GOODS: Good[] = ['wheat', 'rice', 'maize', 'vegetables', 'cotton', 'food', 'goods', 'materials'];
export type CropId = 'wheat' | 'rice' | 'maize' | 'vegetables' | 'cotton';
export const GRAINS: Good[] = ['wheat', 'rice', 'maize'];

export type BuildingKind =
  | 'house' | 'apartment' | 'luxury' | 'affordable'
  | 'shop' | 'grocery' | 'restaurant' | 'services' | 'office' | 'hotel' | 'cinema'
  | 'factory' | 'foodplant' | 'materials' | 'depot' | 'yard'
  | 'farmhouse'
  | 'townhall' | 'school' | 'college' | 'clinic' | 'hospital' | 'police' | 'park'
  | 'stadium' | 'museum' | 'heritage' | 'airport'
  | 'firestation' | 'gasplant' | 'solarfarm' | 'windfarm' | 'waterworks' | 'substation';

export type BusinessKind =
  | 'farm' | 'grocery' | 'shop' | 'restaurant' | 'services' | 'office' | 'factory' | 'foodplant' | 'materials'
  | 'logistics' | 'construction' | 'realestate' | 'hotel' | 'cinema'
  | 'school' | 'college' | 'clinic' | 'hospital' | 'police' | 'townhall' | 'stadium' | 'museum' | 'airport'
  | 'firestation' | 'gasplant' | 'solarfarm' | 'windfarm' | 'waterworks';

export type RoleId =
  | 'farmhand' | 'laborer' | 'helper' | 'operator' | 'driver' | 'clerk' | 'cook' | 'officeassist'
  | 'officer' | 'supervisor' | 'support' | 'technician' | 'nurse' | 'engineer' | 'analyst' | 'manager'
  | 'teacher' | 'lecturer' | 'doctor' | 'sitemgr' | 'host' | 'security' | 'curator' | 'controller'
  | 'firefighter' | 'plantop';

export type Field = 'gen' | 'eng' | 'med' | 'biz' | 'trade';

export type CitizenStatus = 'child' | 'student' | 'working' | 'unemployed' | 'retired' | 'owner' | 'inactive';

/** Commute modes. */
export const Mode = { None: 0, Walk: 1, TwoWheeler: 2, Car: 3, Bus: 4 } as const;

export interface Citizen {
  id: number;
  first: string;
  last: string;
  female: boolean;
  born: number; // sim day of birth (negative = before the simulation started)
  hh: number; // household id
  edu: number; // 0 none, 1 primary, 2 secondary, 3 vocational, 4 university
  field: Field;
  status: CitizenStatus;
  school: number; // business id of school/college attended, -1 if none
  schoolYears: number; // quality-weighted years of schooling
  studyLeft: number; // days left in college programme
  employer: number; // business id (-1 = none)
  job: number; // index into employer.jobs (-1 for owners)
  wage: number; // gross monthly wage
  exp: number; // years of work experience
  health: number; // 0..1
  sat: number; // satisfaction 0..1
  lean: number; // -1 (favours public services / welfare) .. +1 (favours low taxes / markets)
  green: number; // 0..1 environmental concern
  mode: number; // Mode
  commute: number; // one-way minutes
  commuteKm: number;
  unempDays: number;
  partner: number; // citizen id or -1
  injured: number; // days of injury remaining
}

export interface HhLedger {
  wages: number; benefits: number; dividends: number; rent: number; food: number; goods: number;
  services: number; leisure: number; transport: number; taxes: number; other: number;
  utilities: number; // electricity and water bills, wells and water tankers
}

export interface Household {
  id: number;
  members: number[];
  home: number; // building id, -1 = no home of its own (doubling up / informal)
  cash: number;
  car: boolean;
  bike: boolean;
  owns: boolean; // owner-occupier
  rent: number; // monthly rent agreed
  m: HhLedger; // month to date
  last: HhLedger; // last month
  foodSec: number; // 0..1 food security in the last shopping week
  arrived: number; // day arrived in the city
  rentArrears: number;
  unhappy: number; // consecutive unhappy months
  incAvg: number; // smoothed monthly net income, used for spending decisions (consumption smoothing)
  ration: number; // kg of subsidised grain from the ration shop not yet eaten
  leisure: number; // 0..1 how far the family's wish for outings (cinema, museum, matches) is being met
}

export interface Building {
  id: number;
  kind: BuildingKind;
  x: number; y: number; w: number; h: number; // footprint in tiles
  floors: number;
  units: number; // dwelling units (residential)
  occupants: number[]; // household ids
  biz: number; // business operating here (-1)
  ownerT: 0 | 1 | 2 | 3; // 0 government, 1 household, 2 business, 3 external investor
  ownerId: number;
  value: number; // property value
  rent: number; // monthly rent per unit (residential)
  condition: number; // 0..1
  built: number; // sim day completed
  access: number; // road tile index giving access
  style: number; // visual variation seed
  name: string;
  pw?: number; // share of its electricity demand met yesterday (0..1, missing = 1)
  wt?: number; // share of its water demand met by the mains yesterday (0..1, missing = 1)
  fire?: number; // days of flames and smoke left after a fire (missing = none)
}

export interface Job {
  role: RoleId;
  wage: number;
  worker: number; // citizen id or -1 (vacant)
}

export interface Ledger {
  revenue: number; cogs: number; wages: number; taxes: number; other: number;
  sales: number; production: number; unmet: number; // quantities
}

export type FarmPhase = 'fallow' | 'preparing' | 'sowing' | 'growing' | 'ready' | 'harvesting';

export interface FarmState {
  fields: number[]; // tile indices
  ha: number;
  crop: CropId | null;
  phase: FarmPhase;
  phaseDays: number;
  growth: number; // 0..1
  health: number; // 0..1 crop condition
  moisture: number; // 0..1 soil moisture
  fertilizer: number; // 0..1 of recommended dose applied
  irrigation: number; // 0..1 availability of irrigation (canal/well)
  well: boolean;
  seasonCost: number;
  seasonRevenue: number;
  expected: number; // expected harvest (t)
  harvested: number; // harvested so far this season (t)
  waterToday: number; // litres of irrigation today
  stressDays: number;
  disease: number; // days of disease remaining
  insured: boolean;
  premium: number;
  lastHarvest: { crop: CropId; t: number; day: number; health: number } | null;
  plan: string; // why the farmer chose the current crop
  work: number; // worker-days done in the current field operation
  lowland: boolean; // close to the river/canals: floods hit harder
  losses: Record<string, number>; // crop health lost this season, by cause
}

export interface Truck { freeAt: number }

export interface HotelState {
  rooms: number;
  occupied: number; // rooms occupied last night
  nights: number; lastNights: number; // room-nights sold, month to date / last month
  guests: number; lastGuests: number; // guests checked in
  foreign: number; lastForeign: number; // guests from abroad
}

/** Cinemas, museums and stadiums. */
export interface VenueState {
  sold: number; lastSold: number; // tickets, month to date / last month
  visitors: number; lastVisitors: number; // of which visitors from outside the city
  events: number; lastEvents: number; // stadium: matches and concerts held
  nextEvent: number; // stadium: sim day of the next scheduled event (-1 none)
  eventSold: number; // tickets sold so far for the next event
  lastCrowd: number; // attendance at the most recent event
}

export type BizStatus = 'planned' | 'registering' | 'licensing' | 'hiring' | 'operating' | 'closed';

export interface Business {
  id: number;
  name: string;
  kind: BusinessKind;
  pub: boolean; // public service
  owner: number; // citizen id (-1 = government or external investor)
  extOwned: boolean;
  building: number;
  status: BizStatus;
  statusDay: number;
  founded: number;
  jobs: Job[];
  cash: number;
  loan: number;
  inv: Partial<Record<Good, number>>;
  transit: Partial<Record<Good, number>>;
  capacity: number; // max number of jobs the premises allow
  m: Ledger;
  last: Ledger;
  profitHist: number[];
  revHist: number[];
  costHist: number[];
  ema: Partial<Record<Good, number>>; // average daily sales/usage per good
  lossMonths: number;
  taxesTotal: number;
  quality: number; // public services: delivered quality 0..1, private: utilisation
  downDays: number; // shut down (accident etc.)
  reason: string; // why it was founded / why it is struggling
  farm?: FarmState;
  trucks?: Truck[];
  hotel?: HotelState;
  venue?: VenueState;
}

export type ProjectKind = BuildingKind | 'road' | 'avenue' | 'upgrade' | 'canal' | 'demolish';
export type ProjectPhase = 'planning' | 'assessment' | 'approval' | 'land' | 'funding' | 'construction' | 'staffing' | 'done' | 'cancelled';

export interface Project {
  id: number;
  kind: ProjectKind;
  name: string;
  sponsor: number; // -1 government, otherwise business id (developer / investor)
  gov: boolean;
  tiles: number[];
  x: number; y: number; w: number; h: number;
  phase: ProjectPhase;
  phaseLeft: number;
  cost: number; // current cost estimate
  budget: number; // original estimate
  spent: number;
  labor: number; laborDone: number; // worker-days
  materials: number; matDelivered: number; matOrdered: number; // tonnes
  contractor: number;
  created: number; started: number; completed: number;
  plannedDays: number;
  delayDays: number;
  issue: string; // current blocking issue ('' if progressing)
  issues: Record<string, number>; // reason -> days lost
  workersToday: number;
  building: number; // resulting building id
  bizKind: BusinessKind | ''; // business created on completion
  bizId: number; // pre-created business (private investment)
  landCost: number;
  displaced: number;
  reason: string;
  access: number; // road tile used for deliveries to the site
  floors: number;
  cofund?: number; // share of construction costs reimbursed by a national scheme (0..1)
  grant?: number; // co-funding received so far
}

export interface Shipment {
  id: number;
  good: Good;
  qty: number;
  value: number;
  from: number; // business id, -1 = outside the city
  to: number; // business id, -1 = outside the city
  path: number[]; // road tile indices
  depart: number; // sim minute
  arrive: number; // sim minute
  carrier: number; // logistics business id, -1 = external haulier
  purpose: 'supply' | 'import' | 'export' | 'project';
  project: number;
  trucks: number;
  leg: number; // minutes each truck spends on the map (imports/exports also travel off-map)
}

export interface MarketGood {
  price: number; // local wholesale price
  supply: number; demand: number; // today
  local: number; imported: number; exported: number; // month to date quantities
  lastLocal: number; lastImported: number; lastExported: number;
  importValue: number; exportValue: number; // month to date
  hist: number[]; // daily price, last 90 days
  lastWhy: string;
}

export interface External {
  cash: number; // net money held by the outside world (money conservation)
  demand: number; // external economic activity index (1 = normal)
  phase: 'normal' | 'boom' | 'recession';
  phaseLeft: number; // months
  fuel: number; // base fuel price per litre (pre-tax)
  fuelDev: number;
  prices: Record<Good, number>; // world prices
  dev: Record<Good, number>; // log deviation from trend
  trend: number; // world price level multiplier
}

export interface WeatherState {
  temp: number;
  tempDev: number;
  rain: number; // mm today
  rainLog: number[]; // last 60 days of rain
  normalLog: number[]; // last 60 days of normal (expected) rain
  anomaly: number; // current quarter rainfall multiplier
  anomalyQuarter: number;
  drought: boolean;
  flood: number; // days since last flood (large = none)
  heatDays: number;
  pandemic: number; // days remaining
}

export interface TaxSettings {
  income: number; incomeTop: number; allowance: number; topThreshold: number;
  corporate: number; smallBusiness: number;
  sales: number; foodSales: number;
  property: number; // annual rate on property value
  fuel: number; // share of base fuel price
  import: number; // tariff on manufactured goods and building materials
  importFood: number; // tariff on grain, cotton, vegetables and processed food
  export: number;
  agriculture: number; luxury: number;
  licenseFee: number;
  tourism: number; // hotel room tax, share of the room rate
  entertainment: number; // tax on cinema and stadium tickets
  passengerFee: number; // airport fee per departing passenger (money)
  power: number; // electricity tariff as a multiple of the standard tariff (homes pay half the business rate)
  water: number; // water tariff as a multiple of the standard tariff
}

export interface Policies {
  minWage: number;
  unemploymentBenefit: number;
  pension: number;
  retirementAge: number;
  fertilizerSubsidy: number; // 0..0.8
  cropInsurance: boolean;
  businessRegulation: number; // 0 light, 1 standard, 2 strict
  environmentalRegulation: number; // 0 light, 1 standard, 2 strict
  rentControl: boolean;
  busService: number; // 0 none, 1 basic, 2 extensive
  grainExportBan: boolean;
  msp: number; // minimum support price for wheat and rice as a share of the normal world price (0 = no scheme)
  rationShops: boolean; // public distribution of subsidised grain to poor households
  povertyTransfer: number; // monthly cash support per household below the poverty line (money)
  exportIncentive: number; // share of export value refunded to exporters (duty remission)
  investmentIncentive: number; // 0 none, 1 three-year tax holiday for new firms, 2 special economic zone
  tourismPromotion: number; // 0 none, 1 regional, 2 national, 3 international campaign
  festival: number; // 0 none, 1 local festival, 2 grand festival (once a year)
}

export type Dept = 'admin' | 'health' | 'education' | 'safety' | 'transport' | 'agriculture' | 'environment' | 'culture' | 'utilities';
export const DEPTS: Dept[] = ['admin', 'health', 'education', 'safety', 'transport', 'agriculture', 'environment', 'culture', 'utilities'];

export type RevCat =
  | 'incomeTax' | 'corporateTax' | 'smallBizTax' | 'salesTax' | 'foodTax' | 'propertyTax' | 'fuelTax'
  | 'importTariff' | 'exportTax' | 'agriTax' | 'luxuryTax' | 'licenseFees' | 'rents' | 'fares' | 'premiums' | 'grants'
  | 'tourismTax' | 'entertainmentTax' | 'airportFees' | 'tickets' | 'grainSales' | 'utilityBills' | 'powerSales' | 'other';
export type ExpCat =
  | 'admin' | 'health' | 'education' | 'safety' | 'transport' | 'agriculture' | 'environment' | 'culture' | 'utilities'
  | 'unemployment' | 'pensions' | 'fertilizer' | 'insurance' | 'capital' | 'interest' | 'land'
  | 'procurement' | 'rations' | 'transfers' | 'exportSupport' | 'promotion' | 'energy';

export interface GovLedger { rev: Record<RevCat, number>; exp: Record<ExpCat, number> }

export interface PendingChange { day: number; kind: 'tax' | 'policy'; key: string; value: number | boolean; label: string }

/** A term loan the city took out, repaid in equal monthly instalments of interest and capital. */
export type LoanKind = 'development' | 'bank' | 'bond';
export interface Loan {
  id: number;
  kind: LoanKind;
  lender: string;
  principal: number; // amount borrowed
  balance: number; // capital still owed
  rate: number; // annual interest rate, fixed for the life of the loan
  months: number; // term
  left: number; // instalments still to pay
  payment: number; // monthly instalment
  taken: number; // sim day borrowed
  interest: number; // interest paid so far
}

export interface Government {
  cash: number;
  debt: number; // overdraft the treasury draws on automatically when it runs out of cash (plus debts inherited)
  loans: Loan[]; // term loans the city chose to take out
  rate: number; // annual interest rate on debt
  rating: string;
  taxes: TaxSettings;
  level: Record<Dept, number>; // funding level set by the player: share of full-service cost (1 = full service)
  policies: Policies;
  pending: PendingChange[];
  m: GovLedger; last: GovLedger; ytd: GovLedger; lastYear: GovLedger;
  deptNeed: Record<Dept, number>; // monthly cost of full service last month
  deptFunding: Record<Dept, number>; // effective funding level applied last month
  deptSpend: Record<Dept, number>; // actual spending last month (salaries + operations)
  arrears: number; // months unable to pay in full
  total: { rev: number; exp: number }; // cumulative revenue and spending since the world began
  compliance: number; // tax compliance 0..1
  approval: number; // public approval 0..1
}

export interface MonthStats {
  day: number; year: number; month: number;
  population: number; households: number; births: number; deaths: number; immigrants: number; emigrants: number;
  children: number; working: number; unemployed: number; retired: number; students: number; laborForce: number;
  unemployment: number; avgWage: number; medianIncome: number;
  gdp: number; cpi: number; inflation: number; foodPrice: number;
  revenue: number; spending: number; balance: number; debt: number; treasury: number;
  businesses: number; opened: number; closed: number; jobs: number; vacancies: number;
  units: number; vacantUnits: number; homeless: number; avgRent: number; rentIndex: number; rentBurden: number;
  commute: number; congestion: number; crime: number; health: number; lifeExp: number;
  enrollment: number; literacy: number; tertiary: number;
  pollution: number; co2: number; green: number; water: number;
  satisfaction: number; approval: number;
  farmOutput: number; cropOutput: Record<string, number>;
  exports: number; imports: number; foodInsecure: number;
  healthCoverage: number; schoolCoverage: number; policeCoverage: number;
  basket: number; // raw cost of the CPI basket
  roadKm: number; poorRoads: number;
  // leisure, tourism, aviation, trade and food programmes
  leisure: number; // average leisure satisfaction of adults
  tourists: number; foreignTourists: number; touristNights: number; tourismSpend: number; turnedAway: number;
  hotelRooms: number; occupancy: number; appeal: number;
  passengers: number; flights: number;
  tradeBalance: number; fx: number;
  procured: number; grainStock: number; rationed: number;
  // utilities and fire service
  powerPeak: number; powerCap: number; // MW: peak demand and firm supply on the last day of the month
  powerServed: number; waterServed: number; // share of demand met over the month
  waterUse: number; waterCap: number; // m3 a day
  blackouts: number; // days with rolling blackouts somewhere in town
  fires: number; burned: number; // fires last month, buildings lost to them
  fireCoverage: number;
}

/** Electricity and water, month to date or last month. */
export interface UtilityLedger {
  kwh: number; // electricity used
  short: number; // electricity wanted but not supplied
  grid: number; gas: number; solar: number; wind: number; // where the electricity came from (kWh)
  water: number; waterShort: number; // m3 supplied by the mains / wanted but not supplied
  bills: number; // billed to residents and businesses
  cost: number; // paid for grid imports and gas
  exported: number; sales: number; // electricity from the city's plants sold to the regional grid (kWh, money)
  blackouts: number; // days with rolling blackouts somewhere in town
  outages: number; // days the regional grid was down
}

export interface UtilityState {
  gridBase: number; // MW the regional grid line can deliver, before substations (grows with regional investment)
  outage: number; // days of regional grid outage remaining
  unit: number; // blended cost of a kWh bought today (grid and gas)
  peak: number; cap: number; // MW: today's peak demand and firm supply
  waterUse: number; waterCap: number; // m3 a day today
  served: number; waterServed: number; // share of today's demand met, town-wide
  wind: number; sun: number; // today's capacity factors
  m: UtilityLedger; last: UtilityLedger;
  retrofit?: boolean; // saved before utilities were simulated: give the town the waterworks and fire station it had
}

/** Visitors to the city, month to date or last month. */
export interface TourismLedger {
  domestic: number; foreign: number; // arrivals (overnight guests and day-trippers)
  dayTrips: number;
  nights: number; // guest-nights spent in hotels
  turned: number; // overnight visitors who found no room
  byAir: number;
  spend: number; // money spent in the city by visitors (rooms, meals, shopping, services, tickets)
  rooms: number; // room revenue
}

export interface TourismState {
  awareness: number; // how well the city is known as a destination at home, 0..1
  awarenessIntl: number; // ...and abroad
  reputation: number; // visitors' experience and word of mouth, 0..1
  appeal: number; // attractions index
  appealParts: Record<string, number>;
  season: number[]; // monthly seasonality multipliers (mean 1), from the regional climate
  inDom: number; inFor: number; // guests staying in hotels tonight
  festival: number; // days of the festival remaining (0 = none)
  festivalVisitors: number;
  m: TourismLedger; last: TourismLedger;
  total: { visitors: number; foreign: number; spend: number };
}

export interface AirRoute {
  id: number;
  dest: string;
  airline: string;
  intl: boolean;
  weekly: number; // flights a week in each direction
  since: number; // sim day the route started
  pax: number; lastPax: number; // passengers month to date / last month (both directions)
  seats: number; lastSeats: number;
  high: number; low: number; // consecutive months of full / empty flights
}

export interface AirLedger { pax: number; residents: number; tourists: number; business: number; flights: number; seats: number; fees: number }

export interface AirState {
  routes: AirRoute[];
  pending: { dest: string; airline: string; intl: boolean; weekly: number; day: number }[];
  opened: number; // sim day the airport opened (-1 = no airport)
  m: AirLedger; last: AirLedger;
  totalPax: number;
  resTrips: number; bizTrips: number; // expected one-way trips a month by residents and business travellers
}

export type TradeStatus = 'none' | 'talks' | 'agreement' | 'leaving';

export interface TradePartner {
  id: string;
  name: string;
  dist: number; // shipping distance factor (1 = typical)
  tariffGoods: number; tariffAgri: number; // tariffs they charge on our manufactured / farm exports
  buys: Good[]; // what they import from us
  sells: Good[]; // what they can supply us competitively
  status: TradeStatus;
  statusDay: number;
  due: number; // day talks conclude or an exit takes effect
  dispute: number; // days of punitive tariffs remaining (0 = none)
  exp: number; imp: number; lastExp: number; lastImp: number; // trade values, month to date / last month
  totalExp: number; totalImp: number;
}

export interface TradeState {
  partners: TradePartner[];
  fx: number; // exchange-rate index: local currency per unit of foreign currency (1 = start)
  fxDev: number;
  lastTalks: number; // sim day the last round of talks failed (cool-off)
}

export interface LeisureState {
  cov: number[]; // 16x16 cells: access to parks, cinemas, museums, stadiums and heritage sites (0..1)
  unmet: number; lastUnmet: number; // money residents wanted to spend on outings but could not
  spend: number; lastSpend: number;
  avg: number; // average leisure satisfaction last month
}

/** Minimum support price procurement and the public distribution system. */
export interface FoodProgrammes {
  stock: number; // tonnes of grain held by the government
  stockValue: number; // book value of that grain
  procured: number; lastProcured: number; // t bought at the support price
  procuredValue: number; lastProcuredValue: number;
  rationed: number; lastRationed: number; // kg handed out through ration shops
  sold: number; lastSold: number; // t of surplus stock sold off
  families: number; // households receiving rations or cash support last month
}

export interface StatsAcc {
  births: number; deaths: number; immigrants: number; emigrants: number; opened: number; closed: number;
  harvest: Record<string, number>; // tonnes harvested this month by crop
  harvestNormal: Record<string, number>; // tonnes a healthy crop would have given
  harvestLoss: Record<string, number>; // tonnes lost by cause
  fuelLitres: number; industryCO2: number;
  foodUnmet: number; foodWanted: number; // kg this month
  fires: number; burned: number; // fires this month and buildings destroyed by them
}

export interface SimEvent {
  id: number;
  day: number;
  type: string;
  text: string;
  sev: number; // 0 trivial .. 3 major
  ref?: { k: 'building' | 'business' | 'citizen' | 'project' | 'tile' | 'household'; id: number };
  causes?: number[];
  why?: string[];
}

export interface NewsItem {
  id: number;
  day: number;
  tag: 'economy' | 'agriculture' | 'government' | 'society' | 'development' | 'environment' | 'business' | 'weather' | 'milestone' | 'tourism' | 'trade';
  headline: string;
  body: string;
  why: string[]; // cause chain, human readable
  eventId: number;
  ref?: SimEvent['ref'];
}

/**
 * How construction works: 'realistic' (planning, approvals, land purchase and crews take months), 'public' (the city's
 * own projects are finished the moment they are approved) or 'all' (developers and businesses build at once too).
 */
export type BuildMode = 'realistic' | 'public' | 'all';

export interface WorldMeta {
  id: string;
  name: string;
  preset: string;
  startYear: number; // calendar epoch: sim day 0 is 1 January of this year (one year of history before office)
  officeYear: number; // year the player's administration takes office
  officeDay: number; // sim day the player took office
  condition: string;
  seed: number;
  pace: number; // simulated minutes per real second at 1x
  offlineCapDays: number; // 0 = unlimited
  createdAt: number;
  lastReal: number; // real ms timestamp the state corresponds to
  playedMs: number;
  build?: BuildMode; // missing in older saves = 'realistic'
}

export interface MapState {
  w: number; h: number;
  terrain: number[];
  zone: number[];
  road: number[];
  roadCond: number[];
  owner: number[]; // building id occupying tile or -1
  farm: number[]; // farm business id owning field tile or -1
  fertility: number[];
  project: number[]; // project id reserving tile or -1
  landValue: number[]; // relative land value 0..~3
}

export interface WorldState {
  v: number;
  meta: WorldMeta;
  minute: number; // simulated minutes since start
  rng: number[];
  nextId: number;
  map: MapState;
  buildings: Building[];
  businesses: Business[];
  citizens: Citizen[];
  households: Household[];
  projects: Project[];
  shipments: Shipment[];
  market: Record<Good, MarketGood>;
  ext: External;
  weather: WeatherState;
  gov: Government;
  labor: { wage: number[]; vacancies: number[]; unemployed: number[] };
  housing: { rentIndex: number; vacancy: number; demandGap: number };
  traffic: { volume: number[]; avgCommute: number; congestion: number; lastRun: number; truckLoad: number[]; tileTime: number[] };
  env: { pollution: number[]; co2: number; water: number };
  services: { health: number; education: number; safety: number; crime: number; healthCov: number[]; schoolCov: number[]; policeCov: number[]; fireCov: number[] };
  stats: { months: MonthStats[]; acc: StatsAcc; cumHarvest: Record<string, number> };
  events: SimEvent[];
  news: NewsItem[];
  milestones: Record<string, number>;
  leisure: LeisureState;
  tourism: TourismState;
  air: AirState;
  trade: TradeState;
  pds: FoodProgrammes;
  util: UtilityState;
}
