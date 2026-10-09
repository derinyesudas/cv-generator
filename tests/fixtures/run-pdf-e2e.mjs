// ---------------------------------------------------------------------------
// End-to-end driver for the PDF downloads (2 Oct 2026). Same discipline as
// run-e2e.mjs / run-letter-e2e.mjs: the real sandbox page, a real fixture ad
// pasted cold (letter details fill themselves in from the ad now), and the
// real files the buttons produce - both the .pdf and the .docx of the CV and
// the letter, so tests/pdf-compare.py can lay the PDF over LibreOffice's
// rendering of the very same .docx.
//
//   python3 -m http.server 8299 &   (repo root)
//   node tests/fixtures/run-pdf-e2e.mjs <fixture-basename> [archetype-id]
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'e2e-out');
mkdirSync(OUT, { recursive: true });

const fixtureName = process.argv[2];
const archetype = process.argv[3] || '';
if (!fixtureName) {
  console.error('Usage: node run-pdf-e2e.mjs <fixture-basename> [archetype-id]');
  process.exit(1);
}
const jdText = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'jd', fixtureName + '.txt'), 'utf8');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ acceptDownloads: true });
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error' && !/404/.test(msg.text())) consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

await page.goto('http://localhost:8299/index.test.html');
await page.waitForFunction(() => window.CVApp && window.CVApp._test && window.CVApp._test.getLoadedData(), { timeout: 15000 });
await page.fill('#jd-input', jdText);
await page.waitForTimeout(1200);
if (archetype) {
  await page.selectOption('#archetype-select', archetype);
  await page.waitForTimeout(800);
}
// A hard-requirement RED ad needs "Build anyway" before anything downloads.
if (await page.isVisible('#hardreq-build-anyway-btn')) {
  await page.click('#hardreq-build-anyway-btn');
  await page.waitForTimeout(800);
}

async function save(buttonId, file) {
  if (await page.$eval('#' + buttonId, (el) => el.disabled)) return { file: null, disabled: true, title: await page.$eval('#' + buttonId, (el) => el.title) };
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#' + buttonId)]);
  const target = path.join(OUT, file);
  await download.saveAs(target);
  return { file: target, suggested: download.suggestedFilename() };
}

const result = {
  fixtureName,
  cvPdf: await save('download-pdf-btn', fixtureName + '.pdf'),
  cvDocx: await save('download-btn', fixtureName + '.docx'),
  letterPdf: await save('letter-download-pdf-btn', fixtureName + '-letter.pdf'),
  letterDocx: await save('letter-download-btn', fixtureName + '-letter.docx'),
  cvStatus: await page.textContent('#status'),
  letterStatus: await page.textContent('#letter-status'),
  consoleErrors
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
