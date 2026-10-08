// Real-world-inspired starting regions. Climate, crops, culture, currency and fiscal defaults are modelled on
// real places; the town itself and its map are generated. Money values are base (INR 2026) and get multiplied
// by `money` and the price level of the chosen start year.

import type { BusinessKind, CropId, Good, Policies, TaxSettings } from './types';

export interface PartnerSpec {
  id: string;
  name: string;
  dist: number; // shipping distance factor (1 = typical)
  tariffGoods: number; tariffAgri: number; // tariffs they charge on our exports
  buys: Good[];
  sells: Good[];
  agreement?: boolean; // a trade agreement is already in force at the start
}

export interface TourismSpec {
  nature: number; // scenic appeal of the landscape, 0..1
  heritage: string[]; // heritage sites found in the region
  heritageStyle: 'fort' | 'temple' | 'pagoda' | 'castle' | 'colonial';
  festival: { name: string; month: number; days: number };
  hubs: string[]; // domestic airline hubs, most important first
  intlHubs: string[];
  airlines: string[]; // regional carriers (fictional)
}

export interface Preset {
  id: string;
  label: string;
  region: string;
  country: string;
  blurb: string;
  currency: string;
  currencyCode: string;
  money: number;
  inflation: number;
  climate: { temp: number[]; rain: number[]; rainDays: number[]; variability: number };
  crops: Partial<Record<CropId, [number, number][]>>; // sowing windows, day-of-year ranges
  cropBias: Partial<Record<CropId, number>>;
  schoolStartMonth: number;
  tfr: number;
  mortality: number;
  car2026: number;
  bike2026: number;
  literacy2026: number;
  tertiary2026: number;
  femaleLFP: number;
  familyFirst: boolean;
  names: { male: string[]; female: string[]; last: string[] };
  towns: string[];
  bizPrefix: string[];
  words: Partial<Record<BusinessKind, string[]>>;
  taxes: TaxSettings;
  policies: Policies;
  canals: boolean;
  wells: number; // share of farms with their own well / tube well
  hhSize: number; // average household size
  elderWithFamily: number; // probability a family household includes a grandparent
  tourism: TourismSpec;
  partners: PartnerSpec[];
  fxName: string; // the foreign currency the exchange-rate index is quoted against
  /** Traffic keeps to the left. */
  driveLeft?: boolean;
  /** The shape of the land a town of this region is generated on (missing: one winding river through farmland). */
  landscape?: LandscapeSpec;
}

/** What the land of a region looks like: its river, lakes, woods and hills. */
export interface LandscapeSpec {
  /** Half-width of the main river in tiles: 0 is a stream, 1 a river, 2 or 3 a broad river. */
  river: number;
  /** How far the river winds from side to side, in tiles. */
  wind: number;
  /** Where the river runs, as a share of the map from the west. */
  at: number;
  /** Woodland noise threshold: lower means more woods (0.63 is typical farmland country). */
  forest: number;
  /** Woods thicken towards the sides of a river valley. */
  valley?: boolean;
  /** Scattered groves and lone stands of trees, as on a savanna (0..1). */
  groves?: number;
  /** The river splits into this many more channels below the town, as in a delta. */
  branches?: number;
  /** Radius in tiles of a lake north of the town. */
  lake?: number;
  /** Ponds, village tanks or crater lakes: how many, and their smallest and largest radius in tiles. */
  ponds?: [number, number, number];
  /** Radius in tiles of a wooded volcano rising in a corner of the map, with a crater lake. */
  mountain?: number;
  /** How the town spreads: stretched east-west along the highway (x above 1) or north-south along the river (y above 1). */
  town?: [number, number];
}

/** One winding river through farmland and woods: the landscape of a region that does not describe its own. */
export const DEFAULT_LANDSCAPE: LandscapeSpec = { river: 1, wind: 8, at: 0.4, forest: 0.63 };

const baseWords: Partial<Record<BusinessKind, string[]>> = {
  grocery: ['Grocers', 'Fresh Mart', 'Provisions', 'Supermart'],
  shop: ['Traders', 'Emporium', 'General Store', 'Electronics', 'Garments'],
  restaurant: ['Kitchen', 'Eatery', 'Café', 'Diner'],
  office: ['Technologies', 'Software', 'Consulting', 'Analytics', 'Digital'],
  factory: ['Industries', 'Manufacturing', 'Engineering Works', 'Polymers', 'Textiles'],
  foodplant: ['Foods', 'Agro Processing', 'Mills'],
  materials: ['Cement Works', 'Bricks & Tiles', 'Building Materials'],
  logistics: ['Logistics', 'Roadways', 'Carriers'],
  services: ['Services', 'Repairs', 'Salon', 'Tailors', 'Motor Works', 'Tuition Centre', 'Travels'],
  construction: ['Constructions', 'Builders', 'Infra'],
  realestate: ['Properties', 'Realty', 'Estates'],
  hotel: ['Residency', 'Grand Hotel', 'Inn', 'Comforts', 'Regency'],
  cinema: ['Talkies', 'Cinemas', 'Picture House', 'Multiplex'],
};

const indiaTaxes: TaxSettings = {
  income: 0.1, incomeTop: 0.25, allowance: 25000, topThreshold: 100000,
  corporate: 0.25, smallBusiness: 0.15, sales: 0.12, foodSales: 0.05, property: 0.006,
  fuel: 0.55, import: 0.1, importFood: 0.1, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 25000,
  tourism: 0.12, entertainment: 0.18, passengerFee: 350, power: 1, water: 1,
};
const indiaPolicies: Policies = {
  minWage: 10000, unemploymentBenefit: 2500, pension: 2500, retirementAge: 60, fertilizerSubsidy: 0.4,
  cropInsurance: true, businessRegulation: 1, environmentalRegulation: 1, rentControl: false, busService: 1, grainExportBan: false,
  msp: 0, rationShops: false, povertyTransfer: 0, exportIncentive: 0, investmentIncentive: 0, tourismPromotion: 1, festival: 1,
};

const indiaPartners: PartnerSpec[] = [
  { id: 'gulf', name: 'Gulf states', dist: 0.8, tariffGoods: 0.05, tariffAgri: 0.04, buys: ['rice', 'vegetables', 'food', 'goods'], sells: ['materials', 'goods'], agreement: true },
  { id: 'asean', name: 'Southeast Asia (ASEAN)', dist: 1, tariffGoods: 0.05, tariffAgri: 0.1, buys: ['cotton', 'maize', 'wheat', 'goods'], sells: ['rice', 'goods', 'materials'], agreement: true },
  { id: 'eu', name: 'European Union', dist: 1.4, tariffGoods: 0.04, tariffAgri: 0.12, buys: ['cotton', 'goods', 'food'], sells: ['goods', 'materials'] },
  { id: 'us', name: 'United States', dist: 1.6, tariffGoods: 0.05, tariffAgri: 0.06, buys: ['goods', 'food', 'cotton'], sells: ['goods', 'maize', 'wheat'] },
  { id: 'china', name: 'China', dist: 1.1, tariffGoods: 0.08, tariffAgri: 0.12, buys: ['cotton', 'rice'], sells: ['goods', 'materials'] },
];
const indiaAir = { intlHubs: ['Dubai', 'Singapore', 'Doha'], airlines: ['Sahyadri Air', 'Monsoon Airways', 'Saffron Wings'] };

export const PRESETS: Preset[] = [
  {
    id: 'in-deccan', label: 'Deccan Plateau', region: 'Maharashtra', country: 'India',
    blurb: 'A monsoon-fed plateau town. Kharif crops ride the June–September rains; rabi wheat depends on irrigation.',
    currency: '₹', currencyCode: 'INR', money: 1, inflation: 0.055,
    climate: {
      temp: [21.5, 23.5, 26.5, 29.5, 30.5, 27.5, 25.5, 25, 25.5, 25.5, 23, 21],
      rain: [2, 1, 3, 12, 30, 150, 190, 150, 140, 80, 25, 5],
      rainDays: [0.3, 0.2, 0.5, 1.2, 3, 12, 18, 16, 11, 5, 2, 0.5], variability: 0.3,
    },
    crops: { wheat: [[288, 345]], rice: [[160, 205]], maize: [[158, 205], [280, 320]], vegetables: [[0, 364]], cotton: [[152, 195]] },
    cropBias: { wheat: 1, rice: 0.6, maize: 1, vegetables: 1.1, cotton: 0.9 },
    schoolStartMonth: 5, tfr: 1.9, mortality: 1, car2026: 0.12, bike2026: 0.55, literacy2026: 0.86, tertiary2026: 0.14, femaleLFP: 0.35,
    familyFirst: false,
    names: {
      male: ['Rahul', 'Amit', 'Suresh', 'Vijay', 'Sachin', 'Rohan', 'Aniket', 'Prakash', 'Ganesh', 'Mahesh', 'Sandeep', 'Nitin', 'Vikas', 'Ajay', 'Sunil', 'Rajesh', 'Ashok', 'Kiran', 'Omkar', 'Tushar', 'Yogesh', 'Swapnil', 'Pravin', 'Santosh', 'Nilesh', 'Sagar', 'Shubham', 'Akash', 'Pratik', 'Harsh', 'Manoj', 'Dinesh', 'Ravi', 'Anil', 'Arjun', 'Siddharth', 'Vaibhav', 'Abhijit', 'Mangesh', 'Datta'],
      female: ['Priya', 'Sneha', 'Pooja', 'Anjali', 'Kavita', 'Sunita', 'Madhuri', 'Ashwini', 'Pallavi', 'Shruti', 'Neha', 'Swati', 'Aarti', 'Rupali', 'Vaishali', 'Deepa', 'Manisha', 'Jyoti', 'Rekha', 'Meena', 'Sayali', 'Gauri', 'Radhika', 'Komal', 'Prachi', 'Snehal', 'Varsha', 'Anita', 'Seema', 'Rutuja', 'Ketaki', 'Mrunal', 'Tejaswini', 'Asha', 'Lata', 'Sharda', 'Archana', 'Minal', 'Shilpa', 'Nandini'],
      last: ['Patil', 'Deshmukh', 'Jadhav', 'Pawar', 'Shinde', 'Kulkarni', 'Joshi', 'Deshpande', 'More', 'Gaikwad', 'Chavan', 'Kale', 'Sawant', 'Bhosale', 'Kadam', 'Salunkhe', 'Thorat', 'Gokhale', 'Apte', 'Sharma', 'Nair', 'Iyer', 'Shaikh', 'Khan', 'Mane', 'Kamble', 'Wagh', 'Lokhande', 'Naik', 'Rane', 'Phadke', 'Karande', 'Mali', 'Borse', 'Pingale', 'Nikam', 'Ghule', 'Tambe'],
    },
    towns: ['Sahyadri Nagar', 'Godavari Wadi', 'Shivapur', 'Deolgaon', 'Nandanvan', 'Pimpalgaon Khurd', 'Krishnapur', 'Ambegaon', 'Malwadi', 'Pathardi', 'Sonegaon', 'Bhimashankar Peth'],
    bizPrefix: ['Sai', 'Shree', 'Om', 'Ganesh', 'Deccan', 'Sahyadri', 'Laxmi', 'Vishwas', 'Samarth', 'Mauli', 'Siddhi', 'Krishna'],
    words: { ...baseWords, grocery: ['Kirana Store', 'Provisions', 'Supermart', 'Fresh Mart'], restaurant: ['Bhojanalay', 'Misal House', 'Dhaba', 'Café'] },
    taxes: indiaTaxes, policies: indiaPolicies, canals: false, wells: 0.35, hhSize: 4.1, elderWithFamily: 0.3,
    tourism: {
      nature: 0.5, heritage: ['Old Hill Fort', 'Peshwa-era Temple', 'Stepwell of the Nine Arches'], heritageStyle: 'fort',
      festival: { name: 'Ganeshotsav', month: 8, days: 10 }, hubs: ['Mumbai', 'Pune', 'Bengaluru', 'Delhi'], ...indiaAir,
    },
    partners: indiaPartners, fxName: 'US dollar', driveLeft: true, landscape: { river: 1, wind: 8, at: 0.4, forest: 0.66, groves: 0.25, ponds: [6, 2, 3] },
  },
  {
    id: 'in-punjab', label: 'Indo-Gangetic Plains', region: 'Punjab', country: 'India',
    blurb: 'Flat, fertile alluvial plains with a canal legacy. Wheat–rice rotations, hot summers and cool winters.',
    currency: '₹', currencyCode: 'INR', money: 1, inflation: 0.055,
    climate: {
      temp: [12.5, 15.5, 21, 27.5, 32, 33, 30.5, 29.5, 28.5, 24, 18.5, 13.5],
      rain: [25, 30, 25, 12, 20, 75, 210, 190, 110, 15, 5, 15],
      rainDays: [2, 2.5, 2, 1.5, 2, 5, 11, 10, 5, 1, 0.5, 1], variability: 0.3,
    },
    crops: { wheat: [[295, 340]], rice: [[160, 195]], maize: [[165, 200]], vegetables: [[30, 330]], cotton: [[105, 140]] },
    cropBias: { wheat: 1.3, rice: 1.2, maize: 0.6, vegetables: 0.8, cotton: 0.7 },
    schoolStartMonth: 3, tfr: 1.6, mortality: 1, car2026: 0.22, bike2026: 0.6, literacy2026: 0.85, tertiary2026: 0.15, femaleLFP: 0.25,
    familyFirst: false,
    names: {
      male: ['Gurpreet', 'Harpreet', 'Jaspreet', 'Manpreet', 'Amandeep', 'Ravinder', 'Sukhwinder', 'Gurdeep', 'Jaswinder', 'Harjit', 'Balwinder', 'Kuldeep', 'Paramjit', 'Rajinder', 'Satnam', 'Navjot', 'Arshdeep', 'Karan', 'Harsimran', 'Simranjit', 'Lakhwinder', 'Inderjit', 'Jagdeep', 'Sarabjit', 'Tejinder', 'Hardeep', 'Gagandeep', 'Mandeep', 'Rupinder', 'Baljit'],
      female: ['Harleen', 'Simran', 'Jasleen', 'Manjit', 'Navneet', 'Gurleen', 'Amrit', 'Kiranjit', 'Rajwinder', 'Sukhpreet', 'Parminder', 'Harjot', 'Ramandeep', 'Sharanjit', 'Kulwinder', 'Navpreet', 'Taranjit', 'Prabhjot', 'Arshpreet', 'Komal', 'Neha', 'Jasmine', 'Manpreet', 'Gurpreet'],
      last: ['Sandhu', 'Gill', 'Sidhu', 'Dhillon', 'Grewal', 'Brar', 'Bajwa', 'Chahal', 'Randhawa', 'Virk', 'Cheema', 'Mann', 'Aulakh', 'Bains', 'Johal', 'Kang', 'Sekhon', 'Toor', 'Khaira', 'Hundal', 'Sharma', 'Arora', 'Malhotra', 'Kapoor', 'Bhatia', 'Sethi', 'Khanna', 'Mehta', 'Verma', 'Garg'],
    },
    towns: ['Sutlej Nagar', 'Nawanpind', 'Kheri Kalan', 'Doaba Nagar', 'Panjgrain', 'Bhullar Wala', 'Fatehgarh Kalan', 'Rangpur Khurd', 'Beas Kinara', 'Jandiala', 'Sarhali', 'Kotla Nihang'],
    bizPrefix: ['Punjab', 'Sutlej', 'Khalsa', 'Guru Kripa', 'Doaba', 'Malwa', 'Golden', 'Royal', 'Five Rivers', 'Shan-e'],
    words: { ...baseWords, restaurant: ['Dhaba', 'Kitchen', 'Rasoi', 'Café'] },
    taxes: indiaTaxes, policies: { ...indiaPolicies, fertilizerSubsidy: 0.5 }, canals: true, wells: 0.7, hhSize: 4.4, elderWithFamily: 0.35,
    tourism: {
      nature: 0.3, heritage: ['Old Gurdwara Sahib', 'Mughal Sarai', 'Maharaja’s Haveli'], heritageStyle: 'temple',
      festival: { name: 'Baisakhi Mela', month: 3, days: 4 }, hubs: ['Delhi', 'Amritsar', 'Mumbai', 'Chandigarh'], ...indiaAir,
    },
    partners: indiaPartners, fxName: 'US dollar', driveLeft: true, landscape: { river: 2, wind: 3, at: 0.3, forest: 0.8, town: [1.35, 0.74] },
  },
  {
    id: 'ke-rift', label: 'Rift Valley Highlands', region: 'Nakuru County', country: 'Kenya',
    blurb: 'Mild highland climate with two rainy seasons. Maize and wheat farms around a fast-growing market town.',
    currency: 'KSh', currencyCode: 'KES', money: 1.5, inflation: 0.06,
    climate: {
      temp: [18.5, 19, 19.5, 18.5, 17.5, 16.5, 16, 16.5, 17.5, 18, 17.5, 18],
      rain: [30, 40, 70, 130, 110, 70, 80, 90, 60, 50, 65, 40],
      rainDays: [3, 4, 7, 12, 11, 7, 8, 9, 6, 5, 7, 4], variability: 0.3,
    },
    crops: { maize: [[60, 110], [270, 300]], wheat: [[150, 200]], vegetables: [[0, 364]] },
    cropBias: { maize: 1.4, wheat: 0.8, vegetables: 1 },
    schoolStartMonth: 0, tfr: 3.2, mortality: 1.25, car2026: 0.08, bike2026: 0.3, literacy2026: 0.82, tertiary2026: 0.08, femaleLFP: 0.6,
    familyFirst: false,
    names: {
      male: ['Brian', 'Kevin', 'Dennis', 'Collins', 'Samuel', 'Peter', 'John', 'Joseph', 'David', 'Daniel', 'James', 'Paul', 'Evans', 'Kelvin', 'Victor', 'Wycliffe', 'Otieno', 'Kiprono', 'Mwangi', 'Kamau', 'Onyango', 'Kipchoge', 'Njoroge', 'Omondi', 'Wafula', 'Barasa', 'Mutua', 'Kibet', 'Cheruiyot', 'Githinji'],
      female: ['Mercy', 'Faith', 'Grace', 'Joy', 'Esther', 'Mary', 'Ann', 'Jane', 'Lucy', 'Caroline', 'Beatrice', 'Nancy', 'Purity', 'Sharon', 'Winnie', 'Wanjiru', 'Akinyi', 'Chebet', 'Atieno', 'Njeri', 'Wambui', 'Nyambura', 'Jepchirchir', 'Achieng', 'Wanjiku', 'Moraa', 'Kerubo', 'Nafula', 'Muthoni', 'Cherono'],
      last: ['Mwangi', 'Kamau', 'Otieno', 'Odhiambo', 'Kiprop', 'Kibet', 'Cheruiyot', 'Njoroge', 'Wanjala', 'Wafula', 'Mutua', 'Omondi', 'Ochieng', 'Kimani', 'Kariuki', 'Ndungu', 'Chege', 'Korir', 'Rotich', 'Langat', 'Koech', 'Karanja', 'Maina', 'Gitau', 'Onyango', 'Barasa', 'Simiyu', 'Nyaga'],
    },
    towns: ['Kiptoro', 'Soko Mpya', 'Mlima Mweupe', 'Nyandarua Vale', 'Ziwa Nakuru', 'Baraka Town', 'Kambi Mpya', 'Mto Mwekundu', 'Lanet Ridge', 'Elementaita', 'Subukia Hills', 'Kilima Kijani'],
    bizPrefix: ['Rift', 'Baraka', 'Uhuru', 'Jamii', 'Neema', 'Imani', 'Savannah', 'Highland', 'Mlima', 'Tumaini'],
    words: { ...baseWords, grocery: ['Supermarket', 'Duka', 'Provisions'], restaurant: ['Hotel', 'Nyama Choma', 'Café'], hotel: ['Lodge', 'Safari Inn', 'Guest House', 'Hotel'] },
    taxes: { income: 0.12, incomeTop: 0.3, allowance: 24000, topThreshold: 90000, corporate: 0.3, smallBusiness: 0.15, sales: 0.16, foodSales: 0, property: 0.005, fuel: 0.45, import: 0.1, importFood: 0.25, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 20000, tourism: 0.02, entertainment: 0.1, passengerFee: 400, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 9000, unemploymentBenefit: 0, pension: 2000, retirementAge: 60, fertilizerSubsidy: 0.3, cropInsurance: false, busService: 0 },
    canals: false, wells: 0.1, hhSize: 4.2, elderWithFamily: 0.2,
    tourism: {
      nature: 0.9, heritage: ['Prehistoric Hill Site', 'Old Railway Station', 'Crater Rim Viewpoint'], heritageStyle: 'colonial',
      festival: { name: 'Rift Valley Music Festival', month: 7, days: 4 }, hubs: ['Nairobi', 'Mombasa', 'Kisumu'], intlHubs: ['Addis Ababa', 'Dubai', 'Johannesburg'],
      airlines: ['Savannah Air', 'Rift Link', 'Jambo Wings'],
    },
    partners: [
      { id: 'eac', name: 'East African Community', dist: 0.6, tariffGoods: 0.1, tariffAgri: 0.1, buys: ['maize', 'food', 'goods', 'vegetables'], sells: ['maize', 'food', 'goods'], agreement: true },
      { id: 'eu', name: 'European Union', dist: 1.3, tariffGoods: 0.04, tariffAgri: 0.1, buys: ['vegetables', 'food', 'cotton'], sells: ['goods', 'wheat'], agreement: true },
      { id: 'gulf', name: 'Gulf states', dist: 0.9, tariffGoods: 0.05, tariffAgri: 0.05, buys: ['vegetables', 'food'], sells: ['goods', 'materials'] },
      { id: 'china', name: 'China', dist: 1.2, tariffGoods: 0.08, tariffAgri: 0.1, buys: ['cotton', 'food'], sells: ['goods', 'materials'] },
      { id: 'us', name: 'United States', dist: 1.5, tariffGoods: 0.04, tariffAgri: 0.06, buys: ['goods', 'cotton'], sells: ['wheat', 'goods'] },
    ],
    fxName: 'US dollar', driveLeft: true, landscape: { river: 0, wind: 6, at: 0.42, forest: 0.72, groves: 0.55, lake: 21, town: [1.15, 0.87] },
  },
  {
    id: 'vn-mekong', label: 'Mekong Delta', region: 'Cần Thơ', country: 'Vietnam',
    blurb: 'A low, wet delta laced with canals. Two to three rice crops a year, orchards and a growing processing industry.',
    currency: '₫', currencyCode: 'VND', money: 300, inflation: 0.04,
    climate: {
      temp: [25.5, 26, 27.5, 28.5, 28.5, 27.5, 27, 27, 27, 27, 26.5, 25.5],
      rain: [10, 5, 15, 50, 170, 210, 230, 240, 270, 260, 130, 40],
      rainDays: [1, 0.5, 1.5, 5, 14, 17, 19, 19, 20, 19, 11, 4], variability: 0.22,
    },
    crops: { rice: [[0, 30], [95, 135], [215, 245]], maize: [[300, 340]], vegetables: [[0, 364]] },
    cropBias: { rice: 1.6, maize: 0.5, vegetables: 1 },
    schoolStartMonth: 8, tfr: 1.8, mortality: 0.9, car2026: 0.07, bike2026: 0.85, literacy2026: 0.95, tertiary2026: 0.12, femaleLFP: 0.7,
    familyFirst: true,
    names: {
      male: ['Minh', 'Hùng', 'Dũng', 'Tuấn', 'Nam', 'Huy', 'Khang', 'Phúc', 'Long', 'Quang', 'Thắng', 'Hải', 'Sơn', 'Tài', 'Bảo', 'Đức', 'Trung', 'Vinh', 'Toàn', 'Hiếu'],
      female: ['Lan', 'Hương', 'Mai', 'Linh', 'Trang', 'Thảo', 'Ngọc', 'Hà', 'Anh', 'Vy', 'Nhung', 'Yến', 'Hạnh', 'Hoa', 'Thủy', 'Phương', 'Nga', 'Diệp', 'Uyên', 'Hằng'],
      last: ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'],
    },
    towns: ['Tân Phú Đông', 'Vĩnh Hòa', 'Mỹ Thạnh', 'Long Hưng', 'Phước Lộc', 'An Bình', 'Thới Lai', 'Cái Răng Mới', 'Phong Điền', 'Bình Thủy', 'Hòa An', 'Tân Lộc'],
    bizPrefix: ['Mekong', 'Cửu Long', 'Phú Quý', 'An Khang', 'Tân Tiến', 'Hòa Bình', 'Sông Hậu', 'Đại Phát'],
    words: { ...baseWords, restaurant: ['Quán', 'Phở', 'Café', 'Kitchen'], hotel: ['Hotel', 'Riverside Inn', 'Homestay', 'Palace'] },
    taxes: { income: 0.1, incomeTop: 0.25, allowance: 30000, topThreshold: 110000, corporate: 0.2, smallBusiness: 0.15, sales: 0.1, foodSales: 0.05, property: 0.003, fuel: 0.35, import: 0.08, importFood: 0.1, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 15000, tourism: 0.1, entertainment: 0.1, passengerFee: 300, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 11000, unemploymentBenefit: 3000, pension: 3000, retirementAge: 62, fertilizerSubsidy: 0.2 },
    canals: true, wells: 0.2, hhSize: 3.7, elderWithFamily: 0.3,
    tourism: {
      nature: 0.7, heritage: ['Floating Market Pier', 'Old Khmer Pagoda', 'French Colonial Market Hall'], heritageStyle: 'pagoda',
      festival: { name: 'Tết Flower Festival', month: 0, days: 7 }, hubs: ['Hồ Chí Minh City', 'Hà Nội', 'Đà Nẵng'], intlHubs: ['Bangkok', 'Singapore', 'Seoul'],
      airlines: ['Lotus Regional', 'Mekong Air', 'Delta Wings'],
    },
    partners: [
      { id: 'asean', name: 'ASEAN neighbours', dist: 0.6, tariffGoods: 0.03, tariffAgri: 0.05, buys: ['rice', 'food', 'goods'], sells: ['goods', 'materials', 'maize'], agreement: true },
      { id: 'china', name: 'China', dist: 0.8, tariffGoods: 0.06, tariffAgri: 0.1, buys: ['rice', 'vegetables', 'food'], sells: ['goods', 'materials'] },
      { id: 'eu', name: 'European Union', dist: 1.4, tariffGoods: 0.04, tariffAgri: 0.12, buys: ['goods', 'food', 'rice'], sells: ['goods', 'wheat'], agreement: true },
      { id: 'us', name: 'United States', dist: 1.5, tariffGoods: 0.06, tariffAgri: 0.05, buys: ['goods', 'food'], sells: ['wheat', 'maize', 'cotton'] },
      { id: 'jpk', name: 'Japan and Korea', dist: 1, tariffGoods: 0.03, tariffAgri: 0.15, buys: ['goods', 'food', 'rice'], sells: ['goods', 'materials'] },
    ],
    fxName: 'US dollar', landscape: { river: 2, wind: 6, at: 0.36, forest: 0.72, branches: 3, ponds: [5, 1, 2], town: [0.72, 1.39] },
  },
  {
    id: 'fictional', label: 'Valdoria River Valley', region: 'Northern Province', country: 'Valdoria (fictional)',
    blurb: 'A fictional temperate valley with cold winters. Winter wheat, maize and market gardens around a river town.',
    currency: 'Cr', currencyCode: 'CR', money: 1, inflation: 0.03,
    climate: {
      temp: [1, 2.5, 6, 10.5, 15, 18.5, 20.5, 20, 16, 11, 6, 2],
      rain: [55, 45, 50, 55, 65, 70, 70, 75, 60, 60, 65, 60],
      rainDays: [10, 9, 10, 10, 11, 10, 9, 9, 8, 9, 10, 10], variability: 0.25,
    },
    crops: { wheat: [[258, 300]], maize: [[110, 150]], vegetables: [[85, 230]] },
    cropBias: { wheat: 1.2, maize: 1, vegetables: 0.9 },
    schoolStartMonth: 8, tfr: 1.7, mortality: 0.85, car2026: 0.45, bike2026: 0.3, literacy2026: 0.98, tertiary2026: 0.25, femaleLFP: 0.65,
    familyFirst: false,
    names: {
      male: ['Adrian', 'Tomas', 'Lukas', 'Felix', 'Jonas', 'Elias', 'Mateo', 'Henrik', 'Oskar', 'Viktor', 'Anton', 'Emil', 'Julian', 'Marek', 'Nikolai', 'Pavel', 'Stefan', 'Theo', 'Anders', 'Bruno', 'Caspar', 'Dario', 'Erik', 'Florian', 'Gabriel', 'Hugo', 'Ivo', 'Jakob', 'Leon', 'Milan'],
      female: ['Elena', 'Mira', 'Sofia', 'Clara', 'Ines', 'Lena', 'Nora', 'Alma', 'Freya', 'Ida', 'Livia', 'Maja', 'Petra', 'Rosa', 'Sanna', 'Talia', 'Vera', 'Yara', 'Zoe', 'Anika', 'Beatrix', 'Carla', 'Dora', 'Esme', 'Greta', 'Hanna', 'Iris', 'Jana', 'Klara', 'Linnea'],
      last: ['Varga', 'Novak', 'Lindqvist', 'Moreau', 'Brandt', 'Kovac', 'Halvorsen', 'Ferreira', 'Rossi', 'Weber', 'Horvath', 'Dimitrov', 'Jansen', 'Laurent', 'Nilsson', 'Oliveira', 'Petrov', 'Richter', 'Santos', 'Toth', 'Ulrich', 'Vidal', 'Wolff', 'Almeida', 'Berg', 'Costa', 'Engel', 'Falk'],
    },
    towns: ['Havenmoor', 'Eastbrook', 'Lindenfeld', 'Marrowgate', 'Ostara', 'Valdor', 'Ashford Mill', 'Kestrel Bridge', 'Wyvernholt', 'Silverbeck', 'Thornwick', 'Brightwater'],
    bizPrefix: ['Valley', 'Riverside', 'Northgate', 'Evergreen', 'Summit', 'Crescent', 'Meridian', 'Oakridge', 'Pioneer', 'Harbor'],
    words: baseWords,
    taxes: { income: 0.15, incomeTop: 0.3, allowance: 20000, topThreshold: 90000, corporate: 0.22, smallBusiness: 0.15, sales: 0.1, foodSales: 0.03, property: 0.008, fuel: 0.5, import: 0.08, importFood: 0.12, export: 0, agriculture: 0.05, luxury: 0.1, licenseFee: 20000, tourism: 0.06, entertainment: 0.08, passengerFee: 450, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 11000, unemploymentBenefit: 4000, pension: 4000, retirementAge: 65, fertilizerSubsidy: 0.2 },
    canals: false, wells: 0.1, hhSize: 3.2, elderWithFamily: 0.08,
    tourism: {
      nature: 0.6, heritage: ['Castle Ruins', 'Old Abbey', 'Guildhall Square'], heritageStyle: 'castle',
      festival: { name: 'Valley Harvest Fair', month: 8, days: 5 }, hubs: ['Valdor City', 'Port Meridian', 'Northgate'], intlHubs: ['Aurelia International', 'Belmont Hub'],
      airlines: ['Valley Air', 'Crescent Regional', 'Northwind'],
    },
    partners: [
      { id: 'league', name: 'Eastern League', dist: 0.8, tariffGoods: 0.04, tariffAgri: 0.08, buys: ['wheat', 'food', 'goods'], sells: ['goods', 'materials'], agreement: true },
      { id: 'coast', name: 'Coastal Union', dist: 1.1, tariffGoods: 0.03, tariffAgri: 0.12, buys: ['goods', 'vegetables', 'food'], sells: ['goods', 'rice'] },
      { id: 'south', name: 'Southern Republic', dist: 1.3, tariffGoods: 0.07, tariffAgri: 0.05, buys: ['maize', 'wheat', 'materials'], sells: ['cotton', 'food', 'goods'] },
      { id: 'north', name: 'Northern Federation', dist: 1.5, tariffGoods: 0.05, tariffAgri: 0.1, buys: ['goods', 'food'], sells: ['materials', 'goods'] },
    ],
    fxName: 'Aurelian mark', landscape: { river: 1, wind: 13, at: 0.42, forest: 0.6, valley: true, town: [0.8, 1.25] },
  },
  {
    id: 'bd-delta', label: 'Ganges Delta', region: 'Khulna Division', country: 'Bangladesh',
    blurb: 'A low green delta of rivers and paddies. Three rice crops a year, monsoon floods, and the mangroves of the Sundarbans close by.',
    currency: '৳', currencyCode: 'BDT', money: 1.4, inflation: 0.065,
    climate: {
      temp: [19, 22, 27, 30, 30, 29, 29, 29, 29, 28, 24, 20],
      rain: [10, 25, 45, 85, 200, 330, 350, 330, 280, 160, 35, 10],
      rainDays: [1, 2, 3, 6, 12, 18, 22, 21, 17, 9, 2, 1], variability: 0.25,
    },
    crops: { rice: [[5, 40], [160, 200]], wheat: [[310, 340]], maize: [[300, 335]], vegetables: [[0, 364]] },
    cropBias: { rice: 1.6, wheat: 0.5, maize: 0.6, vegetables: 1.1 },
    schoolStartMonth: 0, tfr: 2.0, mortality: 1.05, car2026: 0.03, bike2026: 0.25, literacy2026: 0.76, tertiary2026: 0.1, femaleLFP: 0.4,
    familyFirst: true,
    names: {
      male: ['Rahim', 'Karim', 'Arif', 'Sabbir', 'Tanvir', 'Rakib', 'Imran', 'Hasan', 'Mahmud', 'Shakil', 'Nayeem', 'Fahim', 'Rasel', 'Sohel', 'Jahid', 'Masud', 'Habib', 'Sumon', 'Biplob', 'Anik', 'Shuvo', 'Rafiq', 'Jamal', 'Kamal'],
      female: ['Fatema', 'Ayesha', 'Nusrat', 'Sadia', 'Taslima', 'Rina', 'Shirin', 'Jannat', 'Mim', 'Tania', 'Sumaiya', 'Farzana', 'Rupa', 'Laila', 'Nasrin', 'Shapla', 'Moushumi', 'Sharmin', 'Popy', 'Bristi'],
      last: ['Hossain', 'Rahman', 'Islam', 'Ahmed', 'Khan', 'Chowdhury', 'Miah', 'Sarkar', 'Uddin', 'Akter', 'Das', 'Saha', 'Roy', 'Biswas', 'Mondal', 'Sheikh', 'Talukder', 'Bhuiyan', 'Haque', 'Alam', 'Siddique'],
    },
    towns: ['Padma Ghat', 'Rupsha Bazar', 'Kapotaksha', 'Sonadanga', 'Baliadanga', 'Char Kukri', 'Moheshpur', 'Shapla Nagar', 'Nodi Para', 'Sundarban Haat', 'Bhairab Tola', 'Meghna Char'],
    bizPrefix: ['Bismillah', 'Sonar Bangla', 'Padma', 'Meghna', 'Rupali', 'Shapla', 'Bengal', 'Delta', 'Al-Amin', 'Janata'],
    words: { ...baseWords, grocery: ['Mudi Dokan', 'Bazar', 'Super Shop'], restaurant: ['Hotel & Restaurant', 'Biryani House', 'Mishti Ghar', 'Café'] },
    taxes: { income: 0.1, incomeTop: 0.25, allowance: 25000, topThreshold: 90000, corporate: 0.275, smallBusiness: 0.15, sales: 0.15, foodSales: 0, property: 0.004, fuel: 0.4, import: 0.15, importFood: 0.15, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 15000, tourism: 0.1, entertainment: 0.15, passengerFee: 300, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 8000, unemploymentBenefit: 0, pension: 1500, retirementAge: 59, fertilizerSubsidy: 0.4 },
    canals: true, wells: 0.4, hhSize: 4.2, elderWithFamily: 0.35,
    tourism: {
      nature: 0.75, heritage: ['Terracotta Temple', 'Sixty-Dome Mosque', 'Old Zamindar Palace'], heritageStyle: 'temple',
      festival: { name: 'Pohela Boishakh', month: 3, days: 3 }, hubs: ['Dhaka', 'Chattogram', 'Sylhet'], intlHubs: ['Kolkata', 'Dubai', 'Kuala Lumpur'],
      airlines: ['Padma Air', 'Delta Regional', 'Shapla Wings'],
    },
    partners: [
      { id: 'india', name: 'India', dist: 0.5, tariffGoods: 0.06, tariffAgri: 0.1, buys: ['goods', 'food', 'vegetables'], sells: ['wheat', 'cotton', 'goods', 'materials'], agreement: true },
      { id: 'eu', name: 'European Union', dist: 1.3, tariffGoods: 0, tariffAgri: 0.08, buys: ['goods', 'food'], sells: ['goods', 'wheat'], agreement: true },
      { id: 'china', name: 'China', dist: 1, tariffGoods: 0.06, tariffAgri: 0.1, buys: ['food', 'rice'], sells: ['goods', 'materials', 'cotton'] },
      { id: 'us', name: 'United States', dist: 1.6, tariffGoods: 0.1, tariffAgri: 0.06, buys: ['goods'], sells: ['cotton', 'wheat', 'goods'] },
      { id: 'gulf', name: 'Gulf states', dist: 0.9, tariffGoods: 0.05, tariffAgri: 0.04, buys: ['rice', 'vegetables', 'food'], sells: ['materials', 'goods'] },
    ],
    fxName: 'US dollar', driveLeft: true, landscape: { river: 3, wind: 5, at: 0.3, forest: 0.74, branches: 2, ponds: [14, 1, 2], town: [0.75, 1.33] },
  },
  {
    id: 'id-java', label: 'Java Volcano Highlands', region: 'Central Java', country: 'Indonesia',
    blurb: 'Terraced rice fields on the slopes of a volcano. A long wet season, a short dry one, temple ruins and busy scooter traffic.',
    currency: 'Rp', currencyCode: 'IDR', money: 190, inflation: 0.035,
    climate: {
      temp: [26, 26, 26.5, 27, 27, 26.5, 26, 26, 26.5, 27, 27, 26.5],
      rain: [330, 300, 270, 210, 140, 90, 60, 50, 80, 170, 260, 320],
      rainDays: [21, 19, 18, 14, 10, 6, 4, 3, 5, 11, 17, 20], variability: 0.22,
    },
    crops: { rice: [[50, 80], [300, 340]], maize: [[160, 200]], vegetables: [[0, 364]] },
    cropBias: { rice: 1.5, maize: 0.8, vegetables: 1.1 },
    schoolStartMonth: 6, tfr: 2.1, mortality: 0.95, car2026: 0.1, bike2026: 0.85, literacy2026: 0.96, tertiary2026: 0.12, femaleLFP: 0.53,
    familyFirst: true,
    names: {
      male: ['Budi', 'Agus', 'Joko', 'Bambang', 'Eko', 'Dwi', 'Hendra', 'Rizky', 'Arif', 'Wahyu', 'Andi', 'Sigit', 'Teguh', 'Bayu', 'Dimas', 'Fajar', 'Gilang', 'Yusuf', 'Hadi', 'Slamet', 'Ahmad', 'Rudi'],
      female: ['Siti', 'Sri', 'Dewi', 'Rina', 'Wati', 'Ayu', 'Putri', 'Indah', 'Nur', 'Lestari', 'Ratna', 'Yuni', 'Fitri', 'Kartika', 'Endang', 'Sari', 'Ani', 'Tika', 'Wulan', 'Mega'],
      last: ['Santoso', 'Wijaya', 'Pratama', 'Saputra', 'Hidayat', 'Susanto', 'Purnomo', 'Setiawan', 'Nugroho', 'Wibowo', 'Kurniawan', 'Gunawan', 'Sutrisno', 'Prasetyo', 'Hartono', 'Utomo', 'Rahayu', 'Sulistyo', 'Haryanto', 'Wahyudi'],
    },
    towns: ['Sukamaju', 'Mekarsari', 'Sidomulyo', 'Karanganyar', 'Wonosari', 'Tirtomoyo', 'Banyumili', 'Sumberejo', 'Kaliurang Baru', 'Ngadirejo', 'Gunungsari', 'Tegalrejo'],
    bizPrefix: ['Sinar', 'Jaya', 'Makmur', 'Sejahtera', 'Mulia', 'Abadi', 'Sentosa', 'Barokah', 'Merapi', 'Nusantara'],
    words: { ...baseWords, grocery: ['Toko', 'Warung', 'Minimarket'], restaurant: ['Warung Makan', 'Rumah Makan', 'Bakso', 'Café'], hotel: ['Hotel', 'Losmen', 'Homestay', 'Resort'] },
    taxes: { income: 0.05, incomeTop: 0.25, allowance: 30000, topThreshold: 100000, corporate: 0.22, smallBusiness: 0.1, sales: 0.11, foodSales: 0, property: 0.003, fuel: 0.3, import: 0.075, importFood: 0.1, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 15000, tourism: 0.1, entertainment: 0.1, passengerFee: 300, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 10000, unemploymentBenefit: 0, pension: 2000, retirementAge: 58, fertilizerSubsidy: 0.5 },
    canals: true, wells: 0.2, hhSize: 3.8, elderWithFamily: 0.3,
    tourism: {
      nature: 0.85, heritage: ['Ancient Stupa Temple', 'Hindu Temple Compound', 'Old Kraton Palace'], heritageStyle: 'pagoda',
      festival: { name: 'Sekaten', month: 9, days: 7 }, hubs: ['Jakarta', 'Surabaya', 'Yogyakarta', 'Denpasar'], intlHubs: ['Singapore', 'Kuala Lumpur', 'Jeddah'],
      airlines: ['Merapi Air', 'Garuda Regional', 'Nusa Wings'],
    },
    partners: [
      { id: 'asean', name: 'ASEAN neighbours', dist: 0.6, tariffGoods: 0.03, tariffAgri: 0.05, buys: ['food', 'goods', 'vegetables'], sells: ['rice', 'goods', 'materials'], agreement: true },
      { id: 'china', name: 'China', dist: 1, tariffGoods: 0.04, tariffAgri: 0.08, buys: ['food', 'materials'], sells: ['goods', 'materials'], agreement: true },
      { id: 'jpk', name: 'Japan and Korea', dist: 1, tariffGoods: 0.03, tariffAgri: 0.15, buys: ['goods', 'food'], sells: ['goods', 'materials'] },
      { id: 'us', name: 'United States', dist: 1.6, tariffGoods: 0.06, tariffAgri: 0.05, buys: ['goods', 'food'], sells: ['wheat', 'cotton', 'maize'] },
      { id: 'eu', name: 'European Union', dist: 1.5, tariffGoods: 0.04, tariffAgri: 0.12, buys: ['food', 'goods'], sells: ['goods', 'wheat'] },
    ],
    fxName: 'US dollar', driveLeft: true, landscape: { river: 1, wind: 7, at: 0.38, forest: 0.64, mountain: 34, town: [1.2, 0.83] },
  },
  {
    id: 'ng-savanna', label: 'Guinea Savanna', region: 'Kaduna State', country: 'Nigeria',
    blurb: 'Open savanna with one long rainy season. Maize, rice and cotton farms around a fast-growing market town with a young population.',
    currency: '₦', currencyCode: 'NGN', money: 18, inflation: 0.1,
    climate: {
      temp: [24, 26.5, 29, 29.5, 28, 25.5, 24, 23.5, 24.5, 25.5, 25, 24],
      rain: [0, 1, 8, 50, 140, 175, 230, 290, 220, 70, 2, 0],
      rainDays: [0, 0.2, 1, 5, 11, 13, 16, 18, 15, 6, 0.2, 0], variability: 0.3,
    },
    crops: { maize: [[140, 175]], rice: [[160, 190]], cotton: [[165, 195]], vegetables: [[0, 364]] },
    cropBias: { maize: 1.5, rice: 0.7, cotton: 0.9, vegetables: 0.9 },
    schoolStartMonth: 8, tfr: 4.0, mortality: 1.5, car2026: 0.07, bike2026: 0.25, literacy2026: 0.62, tertiary2026: 0.08, femaleLFP: 0.5,
    familyFirst: false,
    names: {
      male: ['Musa', 'Ibrahim', 'Abubakar', 'Usman', 'Aliyu', 'Sani', 'Yusuf', 'Bello', 'Haruna', 'Garba', 'Emeka', 'Chinedu', 'Tunde', 'Segun', 'Danjuma', 'Bala', 'Idris', 'Suleiman', 'Samuel', 'John', 'Daniel', 'Peter'],
      female: ['Aisha', 'Fatima', 'Hauwa', 'Zainab', 'Hadiza', 'Amina', 'Maryam', 'Halima', 'Rakiya', 'Binta', 'Ngozi', 'Chioma', 'Funmilayo', 'Blessing', 'Grace', 'Esther', 'Ladi', 'Asabe', 'Rahila', 'Comfort'],
      last: ['Abdullahi', 'Mohammed', 'Bello', 'Usman', 'Yakubu', 'Aliyu', 'Garba', 'Danladi', 'Sule', 'Ibrahim', 'Okafor', 'Adeyemi', 'Okonkwo', 'Bako', 'Gambo', 'Audu', 'Ayuba', 'Haruna', 'Tanko', 'Maikano'],
    },
    towns: ['Kurmin Gari', 'Sabon Birni', 'Tudun Wada', 'Rafin Kudu', 'Kauyen Dutse', 'Gidan Waya', 'Samaru Mai', 'Dogon Daji', 'Kasuwan Magani', 'Unguwan Rimi', 'Kafin Hausa', 'Zangon Gari'],
    bizPrefix: ['Alheri', 'Albarka', 'Nasara', 'Arewa', 'Zuma', 'Kaduna', 'Savannah', 'Unity', 'Royal', 'Bright Star'],
    words: { ...baseWords, grocery: ['Provisions', 'Supermarket', 'Mama Store'], restaurant: ['Suya Spot', 'Mai Shayi', 'Buka', 'Restaurant'] },
    taxes: { income: 0.07, incomeTop: 0.24, allowance: 25000, topThreshold: 110000, corporate: 0.3, smallBusiness: 0.2, sales: 0.075, foodSales: 0, property: 0.005, fuel: 0.3, import: 0.2, importFood: 0.35, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 20000, tourism: 0.05, entertainment: 0.1, passengerFee: 400, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 8000, unemploymentBenefit: 0, pension: 1500, retirementAge: 60, fertilizerSubsidy: 0.25, cropInsurance: false, busService: 0 },
    canals: false, wells: 0.12, hhSize: 5.2, elderWithFamily: 0.25,
    tourism: {
      nature: 0.55, heritage: ['Old Emir’s Palace Walls', 'Ancient Nok Hill Site', 'Colonial Railway Station'], heritageStyle: 'fort',
      festival: { name: 'Durbar Festival', month: 5, days: 3 }, hubs: ['Abuja', 'Lagos', 'Kano'], intlHubs: ['Addis Ababa', 'Dubai', 'London'],
      airlines: ['Arewa Air', 'Savannah Express', 'Niger Wings'],
    },
    partners: [
      { id: 'ecowas', name: 'ECOWAS neighbours', dist: 0.6, tariffGoods: 0.05, tariffAgri: 0.05, buys: ['maize', 'food', 'goods'], sells: ['food', 'goods', 'rice'], agreement: true },
      { id: 'china', name: 'China', dist: 1.3, tariffGoods: 0.08, tariffAgri: 0.1, buys: ['cotton', 'materials'], sells: ['goods', 'materials'] },
      { id: 'eu', name: 'European Union', dist: 1.1, tariffGoods: 0.04, tariffAgri: 0.1, buys: ['cotton', 'food'], sells: ['goods', 'wheat'] },
      { id: 'india', name: 'India', dist: 1.2, tariffGoods: 0.1, tariffAgri: 0.12, buys: ['cotton', 'materials'], sells: ['rice', 'goods'] },
      { id: 'us', name: 'United States', dist: 1.5, tariffGoods: 0.04, tariffAgri: 0.06, buys: ['goods'], sells: ['wheat', 'goods'] },
    ],
    fxName: 'US dollar', landscape: { river: 0, wind: 9, at: 0.42, forest: 0.82, groves: 0.8, town: [1.3, 0.77] },
  },
  {
    id: 'et-highlands', label: 'Ethiopian Highlands', region: 'Oromia', country: 'Ethiopia',
    blurb: 'A cool plateau two thousand metres up. The big rains come in July and August; wheat and maize feed one of the world’s fastest-growing regions.',
    currency: 'Br', currencyCode: 'ETB', money: 1.6, inflation: 0.08,
    climate: {
      temp: [16, 17.5, 19, 19, 19.5, 18.5, 17, 17, 17, 16.5, 15.5, 15.5],
      rain: [15, 25, 55, 75, 70, 110, 240, 250, 150, 40, 10, 5],
      rainDays: [2, 3, 6, 9, 8, 12, 22, 22, 15, 5, 1.5, 1], variability: 0.35,
    },
    crops: { wheat: [[170, 200]], maize: [[120, 160]], vegetables: [[0, 364]] },
    cropBias: { wheat: 1.2, maize: 1.2, vegetables: 0.8 },
    schoolStartMonth: 8, tfr: 4.0, mortality: 1.35, car2026: 0.03, bike2026: 0.08, literacy2026: 0.55, tertiary2026: 0.07, femaleLFP: 0.6,
    familyFirst: false,
    names: {
      male: ['Abebe', 'Bekele', 'Dawit', 'Girma', 'Haile', 'Kebede', 'Mulugeta', 'Tesfaye', 'Yohannes', 'Solomon', 'Tadesse', 'Getachew', 'Alemu', 'Dereje', 'Chala', 'Gemechu', 'Lemma', 'Fikru', 'Mesfin', 'Ermias'],
      female: ['Almaz', 'Aster', 'Genet', 'Hirut', 'Meseret', 'Selam', 'Tigist', 'Yeshi', 'Bethlehem', 'Hanna', 'Liya', 'Marta', 'Sara', 'Chaltu', 'Fatuma', 'Ayantu', 'Lomi', 'Kidist', 'Rahel', 'Mahlet'],
      last: ['Tadesse', 'Bekele', 'Haile', 'Kebede', 'Tesfaye', 'Girma', 'Alemu', 'Mekonnen', 'Worku', 'Desta', 'Wolde', 'Abebe', 'Assefa', 'Negash', 'Gudeta', 'Tolosa', 'Fayisa', 'Dinka', 'Lemma', 'Mengistu'],
    },
    towns: ['Debre Selam', 'Adama Hayk', 'Bishan Gari', 'Ginbot Ber', 'Meskel Meda', 'Hora Lake', 'Dukem Sefer', 'Wenji Mender', 'Ejere Kebele', 'Bulbula', 'Arsi Negele Hills', 'Sululta Plain'],
    bizPrefix: ['Abyssinia', 'Selam', 'Habesha', 'Oromia', 'Rift', 'Unity', 'Dashen', 'Tsehay', 'Ethio', 'Lucy'],
    words: { ...baseWords, grocery: ['Suq', 'Supermarket', 'Mini Market'], restaurant: ['Buna Bet', 'Injera House', 'Restaurant', 'Café'] },
    taxes: { income: 0.1, incomeTop: 0.35, allowance: 20000, topThreshold: 100000, corporate: 0.3, smallBusiness: 0.2, sales: 0.15, foodSales: 0, property: 0.004, fuel: 0.4, import: 0.2, importFood: 0.2, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 15000, tourism: 0.1, entertainment: 0.1, passengerFee: 400, power: 1, water: 1 },
    policies: { ...indiaPolicies, minWage: 6000, unemploymentBenefit: 0, pension: 1500, retirementAge: 60, fertilizerSubsidy: 0.3, cropInsurance: false },
    canals: false, wells: 0.08, hhSize: 4.6, elderWithFamily: 0.25,
    tourism: {
      nature: 0.85, heritage: ['Rock-hewn Church', 'Old Emperor’s Castle', 'Ancient Obelisk Field'], heritageStyle: 'castle',
      festival: { name: 'Meskel', month: 8, days: 3 }, hubs: ['Addis Ababa', 'Dire Dawa', 'Bahir Dar'], intlHubs: ['Nairobi', 'Dubai', 'Frankfurt'],
      airlines: ['Abyssinia Air', 'Highland Link', 'Lalibela Wings'],
    },
    partners: [
      { id: 'igad', name: 'Horn of Africa neighbours', dist: 0.6, tariffGoods: 0.1, tariffAgri: 0.1, buys: ['food', 'maize', 'goods'], sells: ['food', 'goods'], agreement: true },
      { id: 'china', name: 'China', dist: 1.2, tariffGoods: 0.08, tariffAgri: 0.1, buys: ['food', 'cotton'], sells: ['goods', 'materials'] },
      { id: 'gulf', name: 'Gulf states', dist: 0.8, tariffGoods: 0.05, tariffAgri: 0.05, buys: ['vegetables', 'food'], sells: ['goods', 'materials'] },
      { id: 'eu', name: 'European Union', dist: 1.3, tariffGoods: 0.04, tariffAgri: 0.1, buys: ['food', 'vegetables'], sells: ['goods', 'wheat'], agreement: true },
      { id: 'us', name: 'United States', dist: 1.6, tariffGoods: 0.04, tariffAgri: 0.06, buys: ['goods', 'food'], sells: ['wheat', 'goods'] },
    ],
    fxName: 'US dollar', landscape: { river: 0, wind: 7, at: 0.4, forest: 0.7, groves: 0.45, ponds: [3, 4, 6] },
  },
];

export function getPreset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

export interface StartCondition {
  id: string;
  label: string;
  blurb: string;
  population: number;
  farms: number;
  treasury: number;
  debt: number;
  schools: number; clinics: number; hospital: boolean; college: boolean; police: number;
  factories: number; offices: number; foodplants: number; materials: number; logistics: number; construction: number;
  apartmentShare: number;
  unemployment: number;
  wealth: number;
  vacancy: number;
  heritage: number; // heritage sites in and around the town
  stadium: boolean;
  museum: boolean;
}

export const CONDITIONS: StartCondition[] = [
  { id: 'developing', label: 'Small developing town', blurb: 'Few services, many small farms, low incomes and room to grow.', population: 3200, farms: 95, treasury: 35e6, debt: 0, schools: 2, clinics: 1, hospital: false, college: false, police: 1, factories: 0, offices: 1, foodplants: 1, materials: 1, logistics: 1, construction: 1, apartmentShare: 0.12, unemployment: 0.09, wealth: 0.8, vacancy: 0.06, heritage: 1, stadium: false, museum: false },
  { id: 'growing', label: 'Growing town', blurb: 'Jobs are arriving faster than homes. Tight housing and busy roads.', population: 5500, farms: 80, treasury: 70e6, debt: 40e6, schools: 3, clinics: 1, hospital: false, college: false, police: 1, factories: 1, offices: 2, foodplants: 1, materials: 1, logistics: 1, construction: 2, apartmentShare: 0.3, unemployment: 0.05, wealth: 1, vacancy: 0.02, heritage: 2, stadium: false, museum: false },
  { id: 'established', label: 'Established city', blurb: 'A hospital, a college, a stadium and a museum, and a diversified economy carrying a sizeable debt.', population: 9500, farms: 70, treasury: 120e6, debt: 300e6, schools: 5, clinics: 2, hospital: true, college: true, police: 2, factories: 2, offices: 4, foodplants: 1, materials: 1, logistics: 2, construction: 2, apartmentShare: 0.4, unemployment: 0.07, wealth: 1.2, vacancy: 0.05, heritage: 2, stadium: true, museum: true },
  { id: 'industrial', label: 'Industrial town', blurb: 'Factories and a materials plant dominate employment. Good wages, dirty air.', population: 7000, farms: 50, treasury: 90e6, debt: 120e6, schools: 3, clinics: 1, hospital: false, college: false, police: 1, factories: 4, offices: 1, foodplants: 1, materials: 2, logistics: 2, construction: 2, apartmentShare: 0.35, unemployment: 0.06, wealth: 1, vacancy: 0.04, heritage: 1, stadium: true, museum: false },
  { id: 'agricultural', label: 'Agricultural region', blurb: 'A market town serving a wide belt of farms. Weather decides good years and bad.', population: 4200, farms: 170, treasury: 30e6, debt: 0, schools: 2, clinics: 1, hospital: false, college: false, police: 1, factories: 0, offices: 0, foodplants: 2, materials: 1, logistics: 2, construction: 1, apartmentShare: 0.1, unemployment: 0.08, wealth: 0.8, vacancy: 0.05, heritage: 1, stadium: false, museum: false },
];

/**
 * Empty land: no town yet. Open country by the river, the regional highway and a development grant. Roads, zoning
 * and the first public facilities are up to the player; settlers, farmers and businesses respond to what is built.
 */
export const EMPTY_LAND: StartCondition = {
  id: 'empty', label: 'Empty land', blurb: 'No town yet: open land, the regional highway and a development grant. You lay out roads, zone land and commission the first facilities; settlers, farmers and businesses follow.',
  population: 0, farms: 0, treasury: 450e6, debt: 0, schools: 0, clinics: 0, hospital: false, college: false, police: 0, factories: 0, offices: 0, foodplants: 0, materials: 0, logistics: 0, construction: 0,
  apartmentShare: 0, unemployment: 0, wealth: 1, vacancy: 0, heritage: 0, stadium: false, museum: false,
};

/** Every way a world can start: an existing town of some kind, or empty land. */
export const START_OPTIONS: StartCondition[] = [...CONDITIONS, EMPTY_LAND];

export function getCondition(id: string): StartCondition {
  return START_OPTIONS.find((c) => c.id === id) ?? CONDITIONS[0];
}

export const START_YEARS = [1995, 2005, 2015, 2026];

/** World pace: simulated minutes per real second at 1x speed. */
export const PACES = [
  { id: 'calm', label: 'Calm', pace: 0.4, blurb: '1 simulated day per real hour — a season lasts about 4 real days.' },
  { id: 'standard', label: 'Standard', pace: 2, blurb: '1 simulated day per 12 real minutes — a year takes about 3 real days.' },
  { id: 'brisk', label: 'Brisk', pace: 8, blurb: '1 simulated day per 3 real minutes — a year takes about 18 real hours.' },
];

export const OFFLINE_CAPS = [
  { days: 90, label: '3 months' },
  { days: 365, label: '1 year' },
  { days: 1095, label: '3 years' },
  { days: 0, label: 'No limit' },
];

export const SPEEDS = [0, 1, 10, 60, 360, 1800, 3600, 7200];

export function moneyScale(presetId: string, startYear: number): number {
  const p = getPreset(presetId);
  return p.money * Math.pow(1 + p.inflation, startYear - 2026);
}
