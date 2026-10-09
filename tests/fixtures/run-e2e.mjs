// One-off, real end-to-end driver: loads the actual sandbox app
// (index.test.html) in a real browser, pastes a real JD fixture in cold
// (no manual archetype selection), reads the live archetype pick / verdict
// / gates off the real DOM, and downloads the real .docx the download
// button produces - the same file a user would get. Does NOT touch the
// cover letter (js/letterbuild.js builds a content model but nothing
// renders it to a document yet, and no UI exists for company/role/team
// input or a letter download button - confirmed by reading js/app.js and
// js/render-docx.js directly, not assumed).
//
// Usage: node tests/fixtures/run-e2e.mjs <fixture-basename>
// e.g.   node tests/fixtures/run-e2e.mjs ornua-graduate-trainee

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'e2e-out');
mkdirSync(OUT, { recursive: true });

const fixtureName = process.argv[2];
if (!fixtureName) {
  console.error('Usage: node run-e2e.mjs <fixture-basename>');
  process.exit(1);
}
const jdPath = path.join(ROOT, 'tests', 'fixtures', 'jd', fixtureName + '.txt');
const jdText = readFileSync(jdPath, 'utf8');

const PORT = 8299;
// Server must already be running (started separately) - starting it inline
// via spawnSync's backgrounded shell was unreliable (process didn't detach
// before this script's goto() fired). Caller's job, not this script's.

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

await page.goto(`http://localhost:${PORT}/index.test.html`);
await page.waitForFunction(() => window.CVApp && window.CVApp._test && window.CVApp._test.getLoadedData(), { timeout: 15000 });
await page.waitForSelector('#validation-errors[hidden]', { timeout: 15000 }).catch(() => {});

// Paste the ad cold - no hints, no manual archetype selection.
await page.fill('#jd-input', jdText);
await page.dispatchEvent('#jd-input', 'input');
// Live recompute is debounced 250ms; give it real margin.
await page.waitForTimeout(900);

const archetypeReadout = await page.textContent('#archetype-readout').catch(() => null);
const archetypeSelectValue = await page.$eval('#archetype-select', el => el.value).catch(() => null);
const buildError = await page.$eval('#build-error', el => el.hidden ? null : el.textContent).catch(() => null);
const verdictText = await page.textContent('#fitcheck-verdict').catch(() => null);
const verdictClass = await page.$eval('#fitcheck-verdict', el => el.className).catch(() => null);
const findings = await page.$$eval('#fitcheck-findings li', els => els.map(e => e.textContent.trim()));
const fitReadout = await page.textContent('#fit-readout').catch(() => null);
const trimLog = await page.$eval('#trim-log', el => el.hidden ? null : el.textContent.trim()).catch(() => null);
const gates = await page.$$eval('#gates-list .gate-item', els => els.map(e => ({
  pass: e.classList.contains('gate-pass'),
  text: e.querySelector('.gate-head') ? e.querySelector('.gate-head').textContent.trim() : e.textContent.trim()
})));
const downloadDisabled = await page.$eval('#download-btn', el => el.disabled).catch(() => true);
const keywordRows = await page.$$eval('#fitcheck-keywords-body tr', els => els.map(e =>
  Array.from(e.children).map(td => td.textContent.trim())
));

let downloadResult = null;
if (!downloadDisabled) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#download-btn')
  ]);
  const outPath = path.join(OUT, fixtureName + '.docx');
  await download.saveAs(outPath);
  downloadResult = outPath;
}

await browser.close();

const result = {
  fixture: fixtureName,
  archetypeReadout,
  archetypeSelectValue,
  buildError,
  verdictText: verdictText ? verdictText.trim() : null,
  verdictClass,
  findings,
  fitReadout: fitReadout ? fitReadout.trim() : null,
  trimLog,
  gates,
  downloadDisabled,
  downloadedTo: downloadResult,
  keywordRows,
  consoleErrors
};
console.log(JSON.stringify(result, null, 2));
