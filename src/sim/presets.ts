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
}

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
  tourism: 0.12, entertainment: 0.18, passengerFee: 350,
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
    towns: ['Sahyadri Nagar', 'Godavari Wadi', 'Shivapur', 'Deolgaon', 'Nandanvan', 'Pimpalgaon Khurd'],
    bizPrefix: ['Sai', 'Shree', 'Om', 'Ganesh', 'Deccan', 'Sahyadri', 'Laxmi', 'Vishwas', 'Samarth', 'Mauli', 'Siddhi', 'Krishna'],
    words: { ...baseWords, grocery: ['Kirana Store', 'Provisions', 'Supermart', 'Fresh Mart'], restaurant: ['Bhojanalay', 'Misal House', 'Dhaba', 'Café'] },
    taxes: indiaTaxes, policies: indiaPolicies, canals: false, wells: 0.35, hhSize: 4.1, elderWithFamily: 0.3,
    tourism: {
      nature: 0.5, heritage: ['Old Hill Fort', 'Peshwa-era Temple', 'Stepwell of the Nine Arches'], heritageStyle: 'fort',
      festival: { name: 'Ganeshotsav', month: 8, days: 10 }, hubs: ['Mumbai', 'Pune', 'Bengaluru', 'Delhi'], ...indiaAir,
    },
    partners: indiaPartners, fxName: 'US dollar',
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
    towns: ['Sutlej Nagar', 'Nawanpind', 'Kheri Kalan', 'Doaba Nagar', 'Panjgrain', 'Bhullar Wala'],
    bizPrefix: ['Punjab', 'Sutlej', 'Khalsa', 'Guru Kripa', 'Doaba', 'Malwa', 'Golden', 'Royal', 'Five Rivers', 'Shan-e'],
    words: { ...baseWords, restaurant: ['Dhaba', 'Kitchen', 'Rasoi', 'Café'] },
    taxes: indiaTaxes, policies: { ...indiaPolicies, fertilizerSubsidy: 0.5 }, canals: true, wells: 0.7, hhSize: 4.4, elderWithFamily: 0.35,
    tourism: {
      nature: 0.3, heritage: ['Old Gurdwara Sahib', 'Mughal Sarai', 'Maharaja’s Haveli'], heritageStyle: 'temple',
      festival: { name: 'Baisakhi Mela', month: 3, days: 4 }, hubs: ['Delhi', 'Amritsar', 'Mumbai', 'Chandigarh'], ...indiaAir,
    },
    partners: indiaPartners, fxName: 'US dollar',
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
    towns: ['Kiptoro', 'Soko Mpya', 'Mlima Mweupe', 'Nyandarua Vale', 'Ziwa Nakuru', 'Baraka Town'],
    bizPrefix: ['Rift', 'Baraka', 'Uhuru', 'Jamii', 'Neema', 'Imani', 'Savannah', 'Highland', 'Mlima', 'Tumaini'],
    words: { ...baseWords, grocery: ['Supermarket', 'Duka', 'Provisions'], restaurant: ['Hotel', 'Nyama Choma', 'Café'], hotel: ['Lodge', 'Safari Inn', 'Guest House', 'Hotel'] },
    taxes: { income: 0.12, incomeTop: 0.3, allowance: 24000, topThreshold: 90000, corporate: 0.3, smallBusiness: 0.15, sales: 0.16, foodSales: 0, property: 0.005, fuel: 0.45, import: 0.1, importFood: 0.25, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 20000, tourism: 0.02, entertainment: 0.1, passengerFee: 400 },
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
    fxName: 'US dollar',
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
    towns: ['Tân Phú Đông', 'Vĩnh Hòa', 'Mỹ Thạnh', 'Long Hưng', 'Phước Lộc', 'An Bình'],
    bizPrefix: ['Mekong', 'Cửu Long', 'Phú Quý', 'An Khang', 'Tân Tiến', 'Hòa Bình', 'Sông Hậu', 'Đại Phát'],
    words: { ...baseWords, restaurant: ['Quán', 'Phở', 'Café', 'Kitchen'], hotel: ['Hotel', 'Riverside Inn', 'Homestay', 'Palace'] },
    taxes: { income: 0.1, incomeTop: 0.25, allowance: 30000, topThreshold: 110000, corporate: 0.2, smallBusiness: 0.15, sales: 0.1, foodSales: 0.05, property: 0.003, fuel: 0.35, import: 0.08, importFood: 0.1, export: 0, agriculture: 0, luxury: 0.1, licenseFee: 15000, tourism: 0.1, entertainment: 0.1, passengerFee: 300 },
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
    fxName: 'US dollar',
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
    towns: ['Havenmoor', 'Eastbrook', 'Lindenfeld', 'Marrowgate', 'Ostara', 'Valdor'],
    bizPrefix: ['Valley', 'Riverside', 'Northgate', 'Evergreen', 'Summit', 'Crescent', 'Meridian', 'Oakridge', 'Pioneer', 'Harbor'],
    words: baseWords,
    taxes: { income: 0.15, incomeTop: 0.3, allowance: 20000, topThreshold: 90000, corporate: 0.22, smallBusiness: 0.15, sales: 0.1, foodSales: 0.03, property: 0.008, fuel: 0.5, import: 0.08, importFood: 0.12, export: 0, agriculture: 0.05, luxury: 0.1, licenseFee: 20000, tourism: 0.06, entertainment: 0.08, passengerFee: 450 },
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
    fxName: 'Aurelian mark',
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

export function getCondition(id: string): StartCondition {
  return CONDITIONS.find((c) => c.id === id) ?? CONDITIONS[0];
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

export const SPEEDS = [0, 1, 10, 60, 360, 1800];

export function moneyScale(presetId: string, startYear: number): number {
  const p = getPreset(presetId);
  return p.money * Math.pow(1 + p.inflation, startYear - 2026);
}
