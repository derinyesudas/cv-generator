// ---------------------------------------------------------------------------
// Records the keyword-precision baseline (25 Sept 2026, Derin's own
// instruction, item 6: "Record the keyword baseline now that NetApp's 7
// keywords landed. Run the per-tag hit count across all 7 fixtures and
// commit it as tests/keyword-baseline.json. Every future tag edit prints a
// delta against it. Without the baseline the precision trade goes back to
// being a judgement made in the dark.").
//
// This is the thing tests/fixtures/README.txt's own "WHAT THIS CORPUS IS
// ALSO FOR" section describes but never actually committed anywhere:
//
//   excel:            5 ads -> 3 ads   (-2: netapp, wtw)
//   data validation:  2 ads -> 2 ads   (no change)
//
// A "hit" here means js/score.js's CVScore.extractFromJD(data, jd)
// .keywordHits has a nonzero count for that tag against that fixture's raw
// text - the exact same function and the exact same allKnownTags() universe
// js/assemble.js's overlapScore() actually scores archetypes with, not a
// separate hand-rolled count that could quietly diverge from what the app
// itself does. Recorded per-fixture (which ads matched, not just how many)
// so a future delta can name them the way the README's own example does.
//
// Run by HAND, deliberately - not part of the automated golden suite, and
// not run on every commit. Recording a new baseline is an explicit act
// ("I am accepting this precision trade"), the same way Derin's own
// approval is what makes a tag addition/removal legitimate in the first
// place; the golden suite's own keyword-baseline section (see
// run-golden-tests.mjs) only ever COMPARES against whatever is currently
// committed and prints a delta - it never rewrites the file itself.
//
// Usage:
//   python3 -m http.server 8199 &
//   node tests/golden/record-keyword-baseline.mjs http://localhost:8199
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = process.argv[2] || 'http://localhost:8199';

const dataJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'cv-generator-data.json'), 'utf8'));

const FIXTURE_JD_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'jd');
const fixtureTexts = fs.readdirSync(FIXTURE_JD_DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(FIXTURE_JD_DIR, f), 'utf8') }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (fixtureTexts.length !== 8) {
  console.error('Expected 8 real fixtures in tests/fixtures/jd/, found ' + fixtureTexts.length + ' - aborting, not recording a baseline against an incomplete corpus.');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext()).newPage();
await page.goto(BASE_URL + '/index.test.html');
await page.waitForFunction(
  () => document.getElementById('load-status').textContent.includes('loaded') ||
        !document.getElementById('validation-errors').hidden,
  { timeout: 10000 }
);

const tagHits = await page.evaluate(([data, fixtures]) => {
  var allTags = CVScore.allKnownTags(data).map(function (t) { return t.toLowerCase(); });
  var out = {};
  allTags.forEach(function (tag) { out[tag] = []; });
  fixtures.forEach(function (fx) {
    var extraction = CVScore.extractFromJD(data, fx.text);
    Object.keys(extraction.keywordHits).forEach(function (tag) {
      if (out[tag]) out[tag].push(fx.name);
    });
  });
  return out;
}, [dataJson, fixtureTexts]);

const baseline = {
  _readme: "Per-tag keyword-precision baseline (Derin, 25 Sept 2026, item 6). For each tag js/score.js's " +
    "CVScore.allKnownTags() knows about, the list of real fixture ads (tests/fixtures/jd/) whose raw JD text " +
    "produces a nonzero CVScore.extractFromJD().keywordHits count for that tag - the exact function/universe the " +
    "app itself scores archetypes with. Recompute with `node tests/golden/record-keyword-baseline.mjs` ONLY when " +
    "intentionally accepting a precision trade (a tag was added/removed/reworded on purpose); every other run just " +
    "compares against this file and prints a delta (see run-golden-tests.mjs) - it never rewrites this file.",
  generatedAt: new Date().toISOString(),
  dataVersion: dataJson._version,
  fixtures: fixtureTexts.map((f) => f.name),
  tagHitCounts: Object.fromEntries(
    Object.keys(tagHits).sort().map((tag) => [tag, tagHits[tag].length])
  ),
  tagFixtures: Object.fromEntries(
    Object.keys(tagHits).sort().map((tag) => [tag, tagHits[tag].sort()])
  )
};

const outPath = path.join(REPO_ROOT, 'tests', 'keyword-baseline.json');
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n');
console.log('Wrote ' + outPath + ' - ' + Object.keys(tagHits).length + ' tags across ' + fixtureTexts.length + ' fixtures, dataVersion ' + dataJson._version + '.');

await browser.close();
