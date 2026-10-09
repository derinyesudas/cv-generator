// ---------------------------------------------------------------------------
// Golden unit tests for the hard-requirement ineligibility alert
// (js/hardreq.js, added 30 Sept 2026). Plain Node, no browser/Playwright -
// the classification logic is pure JS with no DOM dependency, so this loads
// js/matcher.js, js/segment.js and js/hardreq.js directly via CommonJS
// require() (they are plain UMD-style scripts that attach to globalThis
// when `window` doesn't exist, same as this repo's other modules - see
// js/matcher.js's own closing line) instead of going through the Playwright
// golden suite the way DOM-dependent behaviour has to.
//
// Run: node tests/hardreq.test.mjs
//
// Sentence provenance (spec section 5's own "IMPORTANT" note): three of the
// ten required sentences are VERBATIM lines from real fixtures already
// tracked in tests/fixtures/jd/ (clydeco's solicitor line, wtw's QFA line,
// alphasense's "up to 1-2 years" line - confirmed against those files
// before writing this, not assumed) and are tested against those files
// directly, not retyped. The other seven (Sedgwick x2, GMIB, Zurich,
// StepStone x2) are NOT drawn from any fixture file tracked in this repo -
// no "Sedgwick"/"GMIB"/"Zurich"/"StepStone" fixture exists here - so they
// are treated as standalone classifier unit-test strings, per the spec's
// own instruction for exactly this case. They are never written to
// tests/fixtures/jd/ as if they were real ads.
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

require(path.join(ROOT, 'js/matcher.js'));
require(path.join(ROOT, 'js/segment.js'));
require(path.join(ROOT, 'js/hardreq.js'));
const data = require(path.join(ROOT, 'data/cv-generator-data.json'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('PASS - ' + label);
  } else {
    failures++;
    console.log('FAIL - ' + label + (detail ? '\n       ' + detail : ''));
  }
}

function run(jd) {
  return globalThis.CVHardReq.run(data, jd);
}
function hasFindingFor(result, idPrefix) {
  return result.findings.some((f) => f.id === idPrefix);
}

console.log('\n--- Section 5 required cases ---');

// RED #1: Sedgwick (standalone - no Sedgwick fixture file exists)
{
  const jd = 'Requirements\n\n' +
    'Insurance Qualifications - APA qualified as a minimum, with CIP qualification considered highly desirable.';
  const r = run(jd);
  check('Sedgwick APA-as-minimum sentence -> RED', r.verdict === 'RED', JSON.stringify(r));
  check('  ...and the blocking finding is hr-apa, classified required', r.findings.some((f) => f.id === 'hr-apa' && f.severity === 'red' && f.requirementType === 'required'), JSON.stringify(r.findings));
}

// RED #2: Sedgwick, under a requirements heading (standalone)
{
  const jd = 'Requirements\n\n' +
    'Leadership Experience - Previous supervisory or people management experience.';
  const r = run(jd);
  check('Sedgwick supervisory-under-Requirements-heading sentence -> RED', r.verdict === 'RED', JSON.stringify(r));
  check('  ...and the blocking finding is hr-supervisory, classified required (heading-driven)', r.findings.some((f) => f.id === 'hr-supervisory' && f.severity === 'red' && f.requirementType === 'required'), JSON.stringify(r.findings));
}

// RED #3: real clydeco fixture line, verbatim-confirmed present
{
  const jdPath = path.join(ROOT, 'tests/fixtures/jd/clydeco-junior-associate-corporate-insurance.txt');
  const jd = fs.readFileSync(jdPath, 'utf8');
  check('clydeco fixture contains the exact solicitor sentence verbatim', jd.indexOf('Is a qualified solicitor in Ireland.') !== -1);
  const r = run(jd);
  check('clydeco full fixture -> RED, naming the solicitor line', r.verdict === 'RED' && r.findings.some((f) => f.id === 'hr-solicitor' && f.severity === 'red' && f.quote.indexOf('Is a qualified solicitor in Ireland.') !== -1), JSON.stringify(r.findings));
}

// NOT RED: GMIB (standalone - no GMIB fixture file exists)
{
  const jd = 'APA qualified, or willing to complete the relevant Insurance Institute qualifications with full support from GMIB.';
  const r = run(jd);
  check('GMIB "APA qualified, or willing to complete... with full support" -> NOT RED', r.verdict !== 'RED', JSON.stringify(r));
}

// NOT RED: real wtw fixture line, verbatim-confirmed present
{
  const jdPath = path.join(ROOT, 'tests/fixtures/jd/wtw-pensions-administrator.txt');
  const jd = fs.readFileSync(jdPath, 'utf8');
  check('wtw fixture contains the exact QFA-desirable sentence verbatim', jd.indexOf('Working towards or holding a relevant professional qualification (QFA) is desirable.') !== -1);
  const r = run(jd);
  check('wtw full fixture -> NOT RED', r.verdict !== 'RED', JSON.stringify(r));
  check('  ...QFA line present and classified preferred (AMBER), not a block', r.findings.some((f) => f.id === 'hr-qfa' && f.severity === 'amber' && f.requirementType === 'preferred'), JSON.stringify(r.findings));
}

// NOT RED: Zurich (standalone - no Zurich fixture file exists)
{
  const jd = 'Its desirable to be working towards a recognised industry qualification that meets Central Bank Minimum Competency Requirements e.g. IIPM/QFA';
  const r = run(jd);
  check('Zurich IIPM/QFA "desirable" sentence -> NOT RED', r.verdict !== 'RED', JSON.stringify(r));
}

// AMBER: StepStone sponsorship now-or-future (standalone)
{
  const jd = 'Must be able to work legally in Ireland without requiring visa sponsorship now or in the future.';
  const r = run(jd);
  check('StepStone sponsorship-now-or-future sentence -> AMBER', r.verdict === 'AMBER', JSON.stringify(r));
  check('  ...with the fixed permission note', r.findings.some((f) => f.id === 'hr-sponsorship-future' && /permission to work/.test(f.note || '')), JSON.stringify(r.findings));
}

// PASS (no finding): StepStone degree-pursuit sentence (standalone)
{
  const jd = "Currently pursuing or recently graduated with a bachelor's or master's degree in finance, economics, business, or a related quantitative field.";
  const r = run(jd);
  check('StepStone degree-pursuit sentence -> GREEN, no findings', r.verdict === 'GREEN' && r.findings.length === 0, JSON.stringify(r));
}

// PASS (no finding): real alphasense "up to 1-2 years" line, verbatim-confirmed present
{
  const jdPath = path.join(ROOT, 'tests/fixtures/jd/alphasense-associate-expert-call-services.txt');
  const jd = fs.readFileSync(jdPath, 'utf8');
  check('alphasense fixture contains the exact "up to 1-2 years of full-time experience" phrase verbatim', jd.indexOf('up to 1-2 years of full-time experience') !== -1);
  const r = run(jd);
  check('alphasense full fixture -> no hr-years finding (lower bound of range read as 1, not 2)', !hasFindingFor(r, 'hr-years'), JSON.stringify(r.findings));
}

console.log('\n--- The ad\'s wording wins (Derin, 8 Oct 2026) ---');
// Standalone strings shaped like Derin's Intact Insurance ad (7 Oct): the
// requirement line calls APA optional, a salary line mentions APA in passing,
// and "controlled function" boilerplate appears further down. The ad itself
// waits in inbox/ for his OK before it can become a tracked fixture.
{
  const jd = 'Customer Claims Recovery Handler\n\n' +
    'You will be rewarded with a competitive salary which will progress when you achieve APA & CIP qualification in line with our refreshed reward offering.\n\n' +
    'Requirements:\n\n' +
    'APA Qualified working toward CIP (preferrable but not required)\n' +
    'Strong customer services skills\n\n' +
    'Regulatory Requirements:\n\n' +
    'If this role is defined as a "controlled function" by the Central Bank Reform Act 2010 Regulations 2011.';
  const r = run(jd);
  const apa = r.findings.find((f) => f.id === 'hr-apa');
  const cip = r.findings.find((f) => f.id === 'hr-cip');
  check('Intact-shaped ad -> AMBER, not RED', r.verdict === 'AMBER', JSON.stringify(r));
  check('Intact-shaped ad: APA is preferred, quoting the line that calls it optional', apa && apa.requirementType === 'preferred' && apa.severity === 'amber' && apa.quote === 'APA Qualified working toward CIP (preferrable but not required)', JSON.stringify(apa));
  check('Intact-shaped ad: CIP is preferred too', cip && cip.requirementType === 'preferred' && cip.severity === 'amber', JSON.stringify(cip));
}
{
  const r = run('Requirements:\n\nAPA qualified (not required)\n');
  check('"not required" under a requirements heading -> preferred (AMBER), not required', r.verdict === 'AMBER' && r.findings[0].requirementType === 'preferred', JSON.stringify(r));
  const r2 = run('Requirements:\n\nQFA qualification is not essential.\n');
  check('"not essential" -> preferred (AMBER)', r2.verdict === 'AMBER' && r2.findings[0].requirementType === 'preferred', JSON.stringify(r2));
  const r3 = run('Requirements:\n\nQFA preferable\n');
  check('"preferable" -> preferred (AMBER)', r3.verdict === 'AMBER' && r3.findings[0].requirementType === 'preferred', JSON.stringify(r3));
  const r4 = run('Requirements:\n\nQFA preferrable\n');
  check('"preferrable" (the misspelling) -> preferred (AMBER)', r4.verdict === 'AMBER' && r4.findings[0].requirementType === 'preferred', JSON.stringify(r4));
}
{
  // Unchanged: a regulated role whose ad never calls the item optional.
  const r = run('The successful candidate will be APA qualified.\n\nThis is a controlled function role under the Fitness and Probity regime.');
  check('Passing mention in a regulated role, never called optional -> still RED (controlled-function rule kept)', r.verdict === 'RED' && r.findings.some((f) => f.id === 'hr-apa' && f.requirementType === 'required'), JSON.stringify(r));
  // Unchanged: when the ad's own words disagree, the stricter one wins.
  const r2 = run('APA qualified is essential.\n\nAPA qualified would be an advantage.');
  check('The ad says both essential and an advantage -> required (stricter of two explicit readings)', r2.verdict === 'RED', JSON.stringify(r2));
  // Unchanged: "must" still reads as required.
  const r3 = run('Requirements:\n\nMust be APA qualified.\n');
  check('"Must be APA qualified" -> RED', r3.verdict === 'RED', JSON.stringify(r3));
}

console.log('\n--- Existing 8 real JD fixtures: clydeco RED; ornua/netapp/softco/alphasense NOT RED ---');
{
  const jdDir = path.join(ROOT, 'tests/fixtures/jd');
  const files = fs.readdirSync(jdDir).filter((f) => f.endsWith('.txt')).sort();
  check('8 real JD fixtures present', files.length === 8, JSON.stringify(files));
  const results = {};
  files.forEach((f) => {
    const name = f.replace(/\.txt$/, '');
    results[name] = run(fs.readFileSync(path.join(jdDir, f), 'utf8'));
    console.log('  ' + name + ' -> ' + results[name].verdict + (results[name].findings.length ? ' (' + results[name].findings.map((x) => x.id).join(', ') + ')' : ''));
  });
  check('clydeco-junior-associate-corporate-insurance -> RED', results['clydeco-junior-associate-corporate-insurance'].verdict === 'RED');
  ['ornua-graduate-trainee', 'netapp-fpa-intern', 'softco-document-processing-administrator', 'alphasense-associate-expert-call-services'].forEach((name) => {
    check(name + ' -> NOT RED', results[name].verdict !== 'RED', results[name].verdict);
  });
}

console.log('\n--- Additive-safety spot checks ---');
{
  // Every finding must come from a real, quoted JD sentence - never an
  // invented string - and every RED finding for a not-held item without a
  // gapBlockId must never claim one it doesn't have (belt and braces on the
  // data itself, not just the classifier).
  const items = data.hardRequirements.items;
  const gapIds = data.hardRequirements.gapBlocks.map((g) => g.id);
  check('every item.gapBlockId (if present) resolves to a real gapBlocks entry', items.every((it) => !it.gapBlockId || gapIds.indexOf(it.gapBlockId) !== -1), JSON.stringify(items.filter((it) => it.gapBlockId && gapIds.indexOf(it.gapBlockId) === -1)));
  check('only hr-apa, hr-qfa, hr-supervisory carry a gapBlockId (spec: only these three approved gap sentences exist)', items.filter((it) => it.gapBlockId).map((it) => it.id).sort().join(',') === 'hr-apa,hr-qfa,hr-supervisory');
  check('empty/whitespace-only JD text -> GREEN, no findings, no throw', (() => { const r = run('   '); return r.verdict === 'GREEN' && r.findings.length === 0; })());
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All hardreq checks passed') + '.');
process.exit(failures ? 1 : 0);
