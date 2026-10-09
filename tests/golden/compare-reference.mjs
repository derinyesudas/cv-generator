// ---------------------------------------------------------------------------
// One-off comparison harness: current generator vs cv-engine-reference.js,
// fixture by fixture. NOT part of the golden suite - a throwaway research
// tool for the "adopt its rule" task (1 Oct 2026). Writes one JSON file per
// fixture to /tmp/current-runs/<fixture>.json with verdict/archetype/
// closeMatch/gaps/skill items/CV bullets/letter paragraphs, in a shape
// comparable to the reference engine's own .report.json + .txt dumps.
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = process.argv[2] || 'http://localhost:8199';
const OUT_DIR = '/tmp/current-runs';
fs.mkdirSync(OUT_DIR, { recursive: true });

const dataJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'cv-generator-data.json'), 'utf8'));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));

await page.goto(BASE_URL + '/index.test.html');
await page.waitForFunction(
  () => document.getElementById('load-status').textContent.includes('loaded') ||
        !document.getElementById('validation-errors').hidden,
  { timeout: 10000 }
);
if (pageErrors.length) { console.error('Page errors:', pageErrors); process.exit(1); }

const FIXTURE_JD_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'jd');
const fixtureTexts = fs.readdirSync(FIXTURE_JD_DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(FIXTURE_JD_DIR, f), 'utf8') }));

const results = await page.evaluate(([data, fixtures]) => {
  function flatten(blocks) {
    var texts = [];
    (blocks || []).forEach(function (b) {
      if (typeof b.text === 'string') texts.push(b.text);
      if (typeof b.title === 'string') texts.push([b.title, b.org].filter(Boolean).join(' - '));
      if (typeof b.label === 'string' && Array.isArray(b.items)) {
        texts.push(b.label + ': ' + b.items.map(function (it) { return it.text; }).join(' | '));
      }
    });
    return texts;
  }
  function bullets(blocks) {
    return (blocks || []).filter(function (b) { return b.t === 'bullet' || b.type === 'bullet'; }).map(function (b) { return b.text; });
  }
  function skillLines(blocks) {
    return (blocks || []).filter(function (b) { return Array.isArray(b.items); }).map(function (b) { return { label: b.label, items: b.items.map(function (it) { return it.text; }) }; });
  }

  return fixtures.map(function (fx) {
    var entry = { fixture: fx.name };

    // Hard-requirement classifier (directly comparable to the reference's
    // eligibility() - both use RED/AMBER/GREEN vocabulary).
    try {
      var hr = CVHardReq.run(data, fx.text);
      entry.hardReq = { verdict: hr.verdict, findings: hr.findings.map(function (f) { return { id: f.id, severity: f.severity, held: f.held, quote: f.quote }; }) };
    } catch (e) { entry.hardReq = { error: e.message }; }

    var extraction = CVScore.extractFromJD(data, fx.text);
    var pick = CVScore.pickArchetype(data, extraction);
    entry.archetype = pick.noMatch ? null : pick.winner.archetype.id;
    entry.archetypeScore = pick.noMatch ? null : pick.winner.score;
    entry.allScores = (pick.scored || pick.all || []).map ? undefined : undefined;

    var trig = CVLetterBuild.computeCloseMatchTrigger(data, fx.text);
    entry.closeMatch = { fired: trig.fired, ratio: trig.ratio, hitCount: trig.hitCount, totalCount: trig.totalCount };

    if (entry.archetype) {
      var archetypeObj = CVAssemble.findById(data.archetypes, entry.archetype);
      var cvModel = CVAssemble.buildModel(data, entry.archetype, { excludeFactIds: ['vol'], extraction: extraction });
      var fit = CVFitCheck.run(data, extraction, archetypeObj, CVVerify.collectText(cvModel));
      entry.fitCheck = {
        verdict: fit.verdict,
        stretchReasons: fit.stretchReasons,
        findings: fit.findings.map(function (f) { return { id: f.id, severity: f.severity, message: f.message, quote: f.quote }; }),
        gapTrigger: fit.gapTrigger
      };
      entry.cvSkillLines = skillLines(cvModel);
      entry.cvBullets = bullets(cvModel);
      entry.cvFlat = flatten(cvModel);

      var yearsRelevant = CVExperience.computeExperience(data).yearsRelevant;
      var letterOpts = {
        archetypeId: entry.archetype, extraction: extraction, rawJD: fx.text, yearsRelevant: yearsRelevant,
        company: 'Company', role: 'Role', team: '', city: '',
        recipientName: 'Hiring Team', titleMismatch: false,
        fitCheckGapTrigger: (fit.gapTrigger && fit.gapTrigger.id) ? fit.gapTrigger.id : 'none',
        refereeName: 'Referee', echoText: ''
      };
      try {
        var built = CVLetter.buildLetterContentModel(data, letterOpts);
        entry.letterParagraphs = (built.model || []).filter(function (b) { return b.t === 'letterPara'; }).map(function (b) { return { category: b.category, text: b.text }; });
        entry.echoCandidates = built.letterResult.echoCandidates.map(function (c) { return c.text; });
      } catch (e) { entry.letterError = e.message; }
    } else {
      entry.noArchetypeMatch = true;
    }
    return entry;
  });
}, [dataJson, fixtureTexts]);

for (const r of results) {
  fs.writeFileSync(path.join(OUT_DIR, r.fixture + '.json'), JSON.stringify(r, null, 2));
}
console.log('Wrote ' + results.length + ' comparison files to ' + OUT_DIR);
await browser.close();
