// ---------------------------------------------------------------------------
// Visual-review harness (not part of the golden suite). Loads
// index.test.html, drives a real fixture through the real UI, and writes
// screenshots so a layout change can be looked at, not just reasoned about.
//
//   node tests/golden/shoot.mjs <outDir> <tag> <fixture|empty> [widths] [light|dark] [scrollTo]
//
// e.g. node tests/golden/shoot.mjs /tmp/shots after wtw-pensions-administrator 1440,390 light
// Needs a static server on :8199 (python3 -m http.server 8199).
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || '/tmp/shots';
const TAG = process.argv[3] || 'shot';
const FIXTURE = process.argv[4] || 'wtw-pensions-administrator';
const WIDTHS = (process.argv[5] || '1440,390').split(',').map(Number);
const SCHEME = process.argv[6] || 'light';
const SCROLL_TO = process.argv[7] || '';
fs.mkdirSync(OUT, { recursive: true });

const LETTER_FIELDS = {
  'wtw-pensions-administrator': { company: 'WTW', role: 'Pensions Administrator', city: 'Dublin' },
  'clydeco-junior-associate-corporate-insurance': { company: 'Clyde & Co', role: 'Junior Associate', city: 'Dublin' },
  'softco-document-processing-administrator': { company: 'SoftCo', role: 'Document Processing Administrator', city: 'Dublin' },
  'ornua-graduate-trainee': { company: 'Ornua', role: 'Graduate Trainee', city: 'Dublin' },
  'sigmar-customer-service-representative-night': { company: 'Sigmar Recruitment', role: 'Customer Service Representative', city: 'Dublin' },
  'standard-life-pensions-investments-administrator': { company: 'Standard Life', role: 'Pensions and Investments Administrator', city: 'Dublin' },
  'netapp-fpa-intern': { company: 'NetApp', role: 'FP&A Intern', city: 'Cork' },
  'alphasense-associate-expert-call-services': { company: 'AlphaSense', role: 'Associate, Expert Call Services', city: 'Dublin' }
};

const jd = FIXTURE === 'empty' ? '' : fs.readFileSync(path.join('tests/fixtures/jd', FIXTURE + '.txt'), 'utf8');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const w of WIDTHS) {
  const mobile = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: SCHEME });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/private-overrides/.test(r.url())) errors.push('requestfailed ' + r.url()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/private-overrides/.test(r.url())) errors.push(r.status() + ' ' + r.url()); });
  await page.goto('http://localhost:8199/index.test.html');
  await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), { timeout: 15000 });
  if (jd) {
    const f = LETTER_FIELDS[FIXTURE] || { company: 'Company', role: 'Role', city: 'Dublin' };
    await page.fill('#jd-input', jd);
    await page.dispatchEvent('#jd-input', 'input');
    await page.waitForTimeout(700);
    await page.fill('#letter-company', f.company);
    await page.dispatchEvent('#letter-company', 'input');
    await page.fill('#letter-role', f.role);
    await page.dispatchEvent('#letter-role', 'input');
    await page.fill('#letter-city', f.city);
    await page.dispatchEvent('#letter-city', 'input');
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; document.activeElement && document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); const sb = document.querySelector('.sidebar'); if (sb) sb.scrollTop = 0; });
  if (SCROLL_TO) {
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' }); }, SCROLL_TO);
  }
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${TAG}-${w}-viewport.png`) });
  await page.screenshot({ path: path.join(OUT, `${TAG}-${w}-full.png`), fullPage: true });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(`${TAG} @${w}: full height ${h}px, horizontal overflow: ${hscroll}, errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await ctx.close();
}
await browser.close();
