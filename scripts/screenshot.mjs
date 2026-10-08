// End-to-end check in a real browser (the installed Microsoft Edge, headless): creates a world through the UI,
// plays it, inspects things, uses the tools, saves, reopens it after a simulated absence, and checks that every page
// keeps its address through reloads, Back and Forward.
// Usage: npm run build; npx vite preview --port 4173 --strictPort   (leave running), then: npm run screenshot
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/?debug';
const out = 'screenshots';
mkdirSync(out, { recursive: true });
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log(`saved ${out}/${name}.png`); };
const game = (fn, arg) => page.evaluate(fn, arg);
const canvasCenter = async (dx = 0, dy = 0) => {
  const box = await page.locator('canvas.world-canvas').boundingBox();
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
};

try {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Mandate', level: 1 }).waitFor();
  await shot('00-landing');
  await page.getByRole('button', { name: /^Enter / }).first().click();
  await page.getByRole('button', { name: /Found a new town/ }).waitFor();
  await page.waitForTimeout(800);
  await shot('01-world-map');
  await page.getByRole('button', { name: /Found a new town/ }).click();
  await page.waitForTimeout(400);
  await shot('01b-founding');
  // a free plot clicked on the map itself, then the region list as a shortcut
  const plot = page.locator('path.free-hex').nth(40);
  await plot.click({ force: true });
  await page.waitForTimeout(500);
  await shot('02-found-card-map');
  await page.getByRole('button', { name: 'Choose another region' }).click();
  await page.locator('.region-list button', { hasText: 'Deccan Plateau' }).click();
  await page.getByRole('radio', { name: /Growing town/ }).click();
  await page.waitForTimeout(300);
  await shot('02-found-card');
  const t0 = Date.now();
  await page.getByRole('button', { name: /^Found / }).click();
  await page.getByRole('dialog', { name: /Welcome to/ }).waitFor({ timeout: 180_000 });
  console.log(`world generated and its history year simulated in ${Date.now() - t0} ms`);
  await page.waitForTimeout(1200);
  await shot('03-briefing');
  await page.getByRole('dialog').getByRole('button', { name: 'Take office' }).click();
  await page.waitForTimeout(2500);
  await shot('04-world-day');

  // let time run quickly, then pause
  await page.getByRole('button', { name: '360×' }).click();
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Pause' }).click();
  await shot('05-after-running');

  // inspect whatever is in the middle of the view
  const c = await canvasCenter(-60, 40);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(600);
  await shot('06-inspect');

  // dashboard tabs
  for (const tab of ['Budget', 'Taxes', 'News']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await page.waitForTimeout(400);
    await shot(`07-tab-${tab.toLowerCase()}`);
  }
  await page.getByRole('tab', { name: /^Overview/ }).click();
  await page.getByRole('button', { name: 'Why?' }).first().click();
  await page.waitForTimeout(300);
  await shot('08-overview-why');

  // info views (the tray stays open while views are compared)
  await page.getByRole('button', { name: 'Info views', exact: true }).click();
  await page.getByRole('button', { name: 'Traffic', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('09-layer-traffic');
  await page.getByRole('button', { name: 'Electricity', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('10-layer-power');
  await page.getByRole('button', { name: 'Healthcare reach', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('10b-layer-health');
  await page.getByRole('button', { name: 'Normal view', exact: true }).click();
  await page.keyboard.press('Escape');

  // the demand meter opens the zoning tray, which explains it; then the water & power cards
  await page.getByRole('button', { name: /Demand for zoned land/ }).click();
  await page.waitForTimeout(300);
  await shot('11a-zoning-demand');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Water & power', exact: true }).click();
  await page.waitForTimeout(300);
  await shot('11b-tray-utilities');
  await page.keyboard.press('Escape');

  // build tool: propose a clinic where the cursor is
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('button', { name: /Health clinic/ }).click();
  const b = await canvasCenter(80, -30);
  await page.mouse.move(b.x, b.y);
  await page.waitForTimeout(300);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(500);
  await shot('11-build-proposal');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // bulldozer: point at a building, then click it for a demolition order
  await page.getByRole('button', { name: 'Bulldoze', exact: true }).click();
  const d = await canvasCenter(-60, 40);
  await page.mouse.move(d.x, d.y);
  await page.waitForTimeout(400);
  await page.mouse.click(d.x, d.y);
  await page.waitForTimeout(500);
  await shot('11c-bulldoze');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // instant construction without changing any setting: "Build instantly" on the proposal
  const clinics = () => game(() => window.__mandate.game.state.buildings.filter((x) => x.kind === 'clinic').length);
  const clinicsBefore = await clinics();
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.waitForTimeout(300);
  await shot('11d-tray-instant-switch');
  await page.getByRole('button', { name: /Health clinic/ }).click();
  let built = false;
  for (const [dx, dy] of [[120, 60], [-140, 80], [60, 140], [-80, -120], [180, -60], [0, 180], [-200, 20]]) {
    const pt = await canvasCenter(dx, dy);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(200);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(300);
    const btn = page.getByRole('button', { name: 'Build instantly' });
    if ((await btn.count()) && (await btn.isEnabled())) { await shot('11e-instant-proposal'); await btn.click(); built = true; break; }
    await page.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
  }
  await page.waitForTimeout(600);
  const clinicsAfter = await clinics();
  console.log(`instant build: approved ${built}, clinics ${clinicsBefore} -> ${clinicsAfter}`);
  if (!built || clinicsAfter !== clinicsBefore + 1) problems.push('instant build did not add a clinic');
  await shot('11f-instant-built');
  await page.keyboard.press('Escape');

  // loans: borrow from the development fund in the Budget tab
  await page.getByRole('tab', { name: 'Budget', exact: true }).click();
  const loans = () => game(() => window.__mandate.game.state.gov.loans.length);
  const loansBefore = await loans();
  await page.getByRole('button', { name: /^Borrow / }).first().click();
  await page.waitForTimeout(400);
  const loansAfter = await loans();
  console.log(`loans: ${loansBefore} -> ${loansAfter}`);
  if (loansAfter !== loansBefore + 1) problems.push('borrowing did not add a loan');
  await page.getByRole('heading', { name: 'Loans', exact: true }).scrollIntoViewIfNeeded();
  await shot('11g-loans');

  // the switch on the build trays turns instant construction on for every project
  await page.getByRole('button', { name: 'Water & power', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Instant construction' }).check();
  await page.waitForTimeout(300);
  const mode = await game(() => window.__mandate.game.state.meta.build);
  console.log(`tray switch: construction is ${mode}`);
  if (mode !== 'public') problems.push(`tray switch left construction at ${mode}`);
  await shot('11h-tray-instant-on');
  await page.keyboard.press('Escape');

  // camera modes
  await page.getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'Strategic map' }).click();
  await page.waitForTimeout(1500);
  await shot('12-strategic');
  await page.getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'Street level' }).click();
  await page.waitForTimeout(1500);
  await shot('13-street');
  await page.getByRole('button', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'City view' }).click();

  // night: jump the clock to 21:30
  await game(() => {
    const { game: g } = window.__mandate;
    const m = g.state.minute, day = Math.floor(m / 1440);
    const target = day * 1440 + 21.5 * 60;
    g.sim.advanceTo(target > m ? target : target + 1440);
  });
  await page.waitForTimeout(1500);
  await shot('14-night');

  // persistence: leave for the world map (saves), make the stored save look six hours old, reload and continue
  const before = await game(() => ({ minute: window.__mandate.game.state.minute, name: window.__mandate.game.state.meta.name, id: window.__mandate.game.state.meta.id }));
  const path = () => page.evaluate(() => location.pathname);
  const expectPath = async (want, what) => { const p = await path(); if (p !== want) problems.push(`${what}: the address is ${p}, not ${want}`); };
  await expectPath(`/town/${before.id}`, 'playing a town');
  await page.getByRole('button', { name: 'World map', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^Play ${before.name}`) }).waitFor({ timeout: 30_000 });
  await shot('14b-back-on-map');
  await page.evaluate(async (hours) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('mandate'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const key = localStorage.getItem('mandate.last');
    const rec = await new Promise((res, rej) => { const q = db.transaction('data', 'readonly').objectStore('data').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const state = JSON.parse(await new Response(rec.blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
    state.meta.lastReal = Date.now() - hours * 3600_000;
    const blob = await new Response(new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    await new Promise((res, rej) => { const t = db.transaction('data', 'readwrite'); t.objectStore('data').put({ key, blob }); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
  }, 6);
  await expectPath('/world', 'the world map');
  await page.reload(); // stays on the world map
  await page.locator('.world-list button', { hasText: before.name }).first().click();
  await page.getByRole('button', { name: new RegExp(`^Play ${before.name}`) }).click();
  await page.waitForTimeout(500);
  const report = page.getByRole('dialog', { name: 'While you were away' });
  const hasReport = await report.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  await shot('15-reopened');
  const after = await game(() => window.__mandate?.game.state.minute ?? null);
  console.log(`reopened: world minute ${before.minute} -> ${after}; "While you were away" shown: ${hasReport}`);

  // addresses: a reload reopens the same town, Back and Forward move between pages, the landing page stays put
  const townOpen = (id) => page.waitForFunction((x) => window.__mandate?.game.state.meta.id === x, id, { timeout: 60_000 });
  await page.reload();
  await townOpen(before.id);
  await page.getByRole('button', { name: 'World map', exact: true }).waitFor();
  await expectPath(`/town/${before.id}`, 'a town after a reload');
  await shot('16-town-reloaded');
  await page.goBack();
  await page.getByRole('button', { name: new RegExp(`^Play ${before.name}`) }).waitFor({ timeout: 30_000 });
  await expectPath('/world', 'Back from the town');
  await game(() => { window.__mandate = undefined; });
  await page.goForward();
  await townOpen(before.id);
  await expectPath(`/town/${before.id}`, 'Forward to the town');
  await page.getByRole('button', { name: 'World map', exact: true }).click();
  await page.getByRole('button', { name: 'Mandate home page' }).click();
  await page.getByRole('button', { name: /^Enter / }).first().waitFor();
  await expectPath('/', 'the landing page');
  await page.reload();
  await page.getByRole('button', { name: /^Enter / }).first().waitFor();
  await expectPath('/', 'the landing page after a reload');
  // addresses of towns that cannot be opened lead to the world map with a note
  const origin = new URL(url).origin;
  for (const [address, note] of [['/town/nowhere', /not saved on this device/], ['/visit/nowhere', /world server/]]) {
    await page.goto(`${origin}${address}?debug`);
    await page.getByRole('alert').filter({ hasText: note }).waitFor({ timeout: 30_000 });
    await expectPath('/world', address);
  }
  await shot('17-unknown-town');
  console.log('addresses: reload, Back, Forward and unknown towns checked');
} catch (e) {
  problems.push(`script: ${e.message}`);
  await shot('99-failure').catch(() => {});
} finally {
  await browser.close();
}

if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else console.log('No console errors.');
