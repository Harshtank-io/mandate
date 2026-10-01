// End-to-end check in a real browser (the installed Microsoft Edge, headless): creates a world through the UI,
// plays it, inspects things, uses the tools, saves, and reopens it after a simulated absence.
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
  await page.getByRole('button', { name: 'New world' }).click();
  await shot('01-wizard-region');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('radio', { name: /Growing town/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await shot('02-wizard-mandate');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Take office' }).click();
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

  // data layers
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Traffic' }).click();
  await page.waitForTimeout(800);
  await shot('09-layer-traffic');
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Healthcare reach' }).click();
  await page.waitForTimeout(800);
  await shot('10-layer-health');
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Normal view' }).click();

  // build tool: propose a clinic where the cursor is
  await page.getByRole('button', { name: 'Build' }).click();
  await page.getByRole('button', { name: /Health clinic/ }).click();
  const b = await canvasCenter(80, -30);
  await page.mouse.move(b.x, b.y);
  await page.waitForTimeout(300);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(500);
  await shot('11-build-proposal');
  await page.keyboard.press('Escape');
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

  // persistence: leave to the menu (saves), make the stored save look six hours old, reload and continue
  const before = await game(() => ({ minute: window.__mandate.game.state.minute, name: window.__mandate.game.state.meta.name }));
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: new RegExp(`Continue ${before.name}`) }).waitFor({ timeout: 30_000 });
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
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`Continue ${before.name}`) }).click();
  await page.waitForTimeout(500);
  const report = page.getByRole('dialog', { name: 'While you were away' });
  const hasReport = await report.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  await shot('15-reopened');
  const after = await game(() => window.__mandate?.game.state.minute ?? null);
  console.log(`reopened: world minute ${before.minute} -> ${after}; "While you were away" shown: ${hasReport}`);
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
