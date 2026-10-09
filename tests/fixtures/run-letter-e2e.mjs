// Real end-to-end driver for the cover-letter renderer (21 Sept 2026),
// same discipline as run-e2e.mjs: loads the actual sandbox app, pastes a
// real JD, fills the letter's own form fields, reads the live gates/fit
// readout off the real DOM, and downloads the real .docx the letter
// download button produces.
//
// Usage: node tests/fixtures/run-letter-e2e.mjs <fixture-basename> <company> <role> <team> <city>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'e2e-out');
mkdirSync(OUT, { recursive: true });

const [fixtureName, company, role, team, city] = process.argv.slice(2);
if (!fixtureName || !company || !role) {
  console.error('Usage: node run-letter-e2e.mjs <fixture-basename> <company> <role> [team] [city]');
  process.exit(1);
}
const jdPath = path.join(ROOT, 'tests', 'fixtures', 'jd', fixtureName + '.txt');
const jdText = readFileSync(jdPath, 'utf8');

const PORT = 8299;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

await page.goto(`http://localhost:${PORT}/index.test.html`);
await page.waitForFunction(() => window.CVApp && window.CVApp._test && window.CVApp._test.getLoadedData(), { timeout: 15000 });
await page.waitForSelector('#validation-errors[hidden]', { timeout: 15000 }).catch(() => {});

await page.fill('#jd-input', jdText);
await page.dispatchEvent('#jd-input', 'input');
await page.waitForTimeout(900);

await page.fill('#letter-company', company);
await page.dispatchEvent('#letter-company', 'input');
await page.fill('#letter-role', role);
await page.dispatchEvent('#letter-role', 'input');
if (team) {
  await page.fill('#letter-team', team);
  await page.dispatchEvent('#letter-team', 'input');
}
if (city) {
  await page.fill('#letter-city', city);
  await page.dispatchEvent('#letter-city', 'input');
}
await page.waitForTimeout(900);

// ECHO: since 2 Oct 2026 the letter quotes its recommended line on its own
// (CVLetterBuild.pickEchoAuto - strongest match, preferring a line that
// reads well quoted) and the radio list became the "Line quoted from the
// ad" dropdown in step 7. Read what was picked rather than clicking.
const echoPicked = await page.evaluate(() => {
  var st = window.CVApp._test.getSectionState();
  return st.echoText || null;
});

const notice = await page.$eval('#letter-notice', el => el.hidden ? null : el.textContent).catch(() => null);
const fitReadout = await page.textContent('#letter-fit-readout').catch(() => null);
const gateItems = await page.$$eval('#letter-gates-list .gate-item', els => els.map(e => e.textContent.trim()));
const downloadDisabled = await page.$eval('#letter-download-btn', el => el.disabled).catch(() => null);

let downloadedPath = null;
if (!downloadDisabled) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#letter-download-btn'),
  ]);
  downloadedPath = path.join(OUT, fixtureName + '-letter.docx');
  await download.saveAs(downloadedPath);
}

console.log(JSON.stringify({
  fixtureName, company, role, team, city, echoPicked,
  notice, fitReadout, gateItems, downloadDisabled, downloadedPath,
  consoleErrors
}, null, 2));

await browser.close();
