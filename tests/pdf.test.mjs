// ---------------------------------------------------------------------------
// PDF downloads (2 Oct 2026, js/render-pdf.js), end to end in the real page:
// for every fixture ad, the CV and letter PDF buttons each save a one-page
// PDF with the right name, the same text as the .docx, working links and
// clean extractable text - and, laid over LibreOffice's rendering of the
// very same .docx by tests/pdf-compare.py, identical line breaks with every
// baseline within 1.5pt. Also: the PDF buttons are blocked exactly when the
// .docx buttons are, with the same reason.
//
// Needs the sandbox's poppler (pdftotext/pdfinfo), LibreOffice (soffice)
// and python3 with pdfplumber, plus a static server on :8299:
//   python3 -m http.server 8299 &   (repo root)
//   node tests/pdf.test.mjs
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = fs.mkdtempSync('/tmp/pdf-test-');
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}
const FIXTURES = fs.readdirSync(path.join(ROOT, 'tests/fixtures/jd')).map((f) => f.replace(/\.txt$/, ''));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8299/index.test.html');
await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), { timeout: 15000 });

// --- Gating mirrors the .docx buttons ----------------------------------------
const before = await page.evaluate(() => ({
  pdf: [document.getElementById('download-pdf-btn').disabled, document.getElementById('download-pdf-btn').title],
  docx: [document.getElementById('download-btn').disabled, document.getElementById('download-btn').title],
  lpdf: [document.getElementById('letter-download-pdf-btn').disabled, document.getElementById('letter-download-pdf-btn').title],
  ldocx: [document.getElementById('letter-download-btn').disabled, document.getElementById('letter-download-btn').title]
}));
check('no ad yet: PDF buttons blocked with the .docx buttons\' own reason',
  before.pdf[0] && JSON.stringify(before.pdf) === JSON.stringify(before.docx) && before.lpdf[0] && JSON.stringify(before.lpdf) === JSON.stringify(before.ldocx), JSON.stringify(before));

async function save(id, file) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#' + id)]);
  const target = path.join(OUT, file);
  await download.saveAs(target);
  return { target, suggested: download.suggestedFilename() };
}

for (const fx of FIXTURES) {
  await page.fill('#jd-input', fs.readFileSync(path.join(ROOT, 'tests/fixtures/jd', fx + '.txt'), 'utf8'));
  await page.waitForTimeout(1100);
  if (await page.isVisible('#hardreq-build-anyway-btn')) {
    const blocked = await page.evaluate(() => [document.getElementById('download-pdf-btn').disabled, document.getElementById('download-pdf-btn').title === document.getElementById('download-btn').title]);
    check(`${fx}: a hard-requirement RED blocks the PDF too, until "Build anyway"`, blocked[0] && blocked[1], JSON.stringify(blocked));
    await page.click('#hardreq-build-anyway-btn');
    await page.waitForTimeout(800);
  }
  const docs = [
    { pdfBtn: 'download-pdf-btn', docxBtn: 'download-btn', name: fx, label: 'CV', expect: /^Derin_Yesudas_CV_.+\.pdf$/ },
    { pdfBtn: 'letter-download-pdf-btn', docxBtn: 'letter-download-btn', name: fx + '-letter', label: 'letter', expect: /^Derin_Yesudas_Cover_Letter_.+\.pdf$/ }
  ];
  for (const d of docs) {
    const pdf = await save(d.pdfBtn, d.name + '.pdf');
    const docx = await save(d.docxBtn, d.name + '.docx');
    check(`${fx} ${d.label}: PDF saved under the .docx's name`, d.expect.test(pdf.suggested) && pdf.suggested.replace(/\.pdf$/, '') === docx.suggested.replace(/\.docx$/, ''), pdf.suggested + ' / ' + docx.suggested);
    const info = execFileSync('pdfinfo', [pdf.target]).toString();
    check(`${fx} ${d.label}: one A4 page`, /Pages:\s+1\n/.test(info) && /Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/.test(info), info.split('\n').filter((l) => /Pages|Page size/.test(l)).join(' | '));
    const text = execFileSync('pdftotext', ['-layout', pdf.target, '-']).toString();
    check(`${fx} ${d.label}: text extracts cleanly (name, contact line, no stray markup or replacement glyphs)`,
      /DERIN YESUDAS/.test(text) && /derinyesudas@gmail\.com/.test(text) && !/[�]|\{\{|\}\}|undefined/.test(text), text.slice(0, 200));
    const cmp = spawnSync('python3', [path.join(ROOT, 'tests/pdf-compare.py'), pdf.target, docx.target], { encoding: 'utf8' });
    check(`${fx} ${d.label}: same line breaks as LibreOffice's PDF of the .docx, baselines within 1.5pt`, cmp.status === 0, (cmp.stdout + cmp.stderr).trim().split('\n').slice(0, 6).join(' / '));
  }
}

// --- Links -----------------------------------------------------------------------
const links = spawnSync('python3', ['-c', `
import pdfplumber, sys
with pdfplumber.open(sys.argv[1]) as pdf:
    print(' '.join(sorted(h['uri'] for h in pdf.pages[0].hyperlinks)))
`, path.join(OUT, FIXTURES[0] + '.pdf')], { encoding: 'utf8' });
check('contact line links work in the PDF (email and LinkedIn)', /mailto:derinyesudas@gmail\.com/.test(links.stdout) && /https:\/\/www\.linkedin\.com\/in\/derinyesudas/.test(links.stdout), links.stdout + links.stderr);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
