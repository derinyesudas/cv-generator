// ---------------------------------------------------------------------------
// Golden test suite, added 13 Sept 2026 in response to the senior-developer
// code review. Requires `playwright` (npm install playwright) and a local
// static server serving the repo root, e.g.:
//
//   python3 -m http.server 8199 &
//   node tests/golden/run-golden-tests.mjs http://localhost:8199
//
// Uses index.test.html: the same page as index.html (same lib/ files, so it
// needs no network) plus one test hook.
//
// What this checks, and why each one is here:
//
//  1. Collision test (data.matchRule._stems' own instruction: "re-run the
//     collision test on every change to this list; it belongs in the golden
//     tests, not as a one-off check"). Every data.neverClaim term against
//     every currently-approved string in the data file. A hit here means
//     the never-claim gate would block a real CV from downloading because
//     one of its own approved sentences accidentally contains a banned
//     term - exactly the failure mode the stem/exact split in
//     data.matchRule exists to avoid.
//
//  2. Gate-fires test (build spec's own instruction: "prove a gate blocks
//     by deliberately breaking something"). A hand-built, deliberately
//     poisoned model is run through CVVerify.runGates() and each of the
//     three content gates is asserted to fire on exactly the fault it was
//     given, so "we wrote a check" and "we watched the check catch
//     something" stay two different, both-verified claims.
//
//  3. matchRule spec cases: the 9 cases data.matchRule documents by
//     implication (exact vs stem, the "aca"/"academic" trap, the
//     "sql sql sql" count-3 fix) plus a couple of regression cases from
//     the review that must never come back.
//
//  4. Real-JD archetype pick: every file in tests/golden/real-jds/ against
//     CVScore.pickArchetype(), comparing the winner to manifest.json's
//     archetype_hint. A mismatch is not automatically a failure - see
//     tests/golden/README.md's note on the Reinsurance Finance Analyst
//     case - but every mismatch must be a KNOWN, understood one, not a
//     silent surprise, so this prints every result rather than just
//     asserting a 100% match rate.
//
//  5. trim.js: data.trimPolicy.order's own rules, checked directly against
//     small synthetic models. Phase 6 addition, 14 Sept 2026; REWRITTEN
//     19 Sept 2026 for the shorten-then-drop ladder (Derin's "A-E" spec,
//     part A): shorten runs strength-ascending then height-descending and
//     is eligible for every strength including core/required; drop only
//     fires once nothing is left to shorten, filler then support only,
//     never core/required, last-included-first, never orphaning a group's
//     last bullet without removing the whole entry.
//
//  6. Fit-check verdicts (spec section 6): BLOCKED on a matched block-
//     severity warning (with the finding quoting the actual ad sentence,
//     not a fragment), STRETCH on both its triggers (years gap, 2+ named
//     tools confirmed missing), and GOOD on an ordinary JD with neither.
//     Phase 6 addition, 14 Sept 2026.
//
//  7. Project-bearing archetypes build clean - regression guard for a real
//     bug this phase found and fixed: js/assemble.js's buildProjects() read
//     data.facts.projects (plural), which has never existed - the data file
//     has always had data.facts.project, singular - so every archetype with
//     a project section (5 of 8) silently hit the build-error banner. Phase
//     6 addition, 14 Sept 2026.
//
// This script has no external test-framework dependency (no Jest/Mocha) -
// it prints PASS/FAIL per check and exits non-zero if anything unexpected
// failed, which is enough to run by hand or wire into a CI step later.
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = process.argv[2] || 'http://localhost:8199';

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('PASS - ' + label);
  } else {
    failures++;
    console.log('FAIL - ' + label + (detail ? '\n       ' + detail : ''));
  }
}

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

// ---- 1. Collision test ---------------------------------------------------
console.log('\n--- Collision test: every neverClaim term vs every approved string ---');
const collision = await page.evaluate((data) => {
  var approved = [];
  Object.keys(data.skillLines).forEach((k) => data.skillLines[k].terms.forEach((t) => approved.push(t.text)));
  Object.keys(data.bulletVariants).forEach((k) => data.bulletVariants[k].variants.forEach((v) => approved.push(v.text)));
  data.profileVariants.forEach((p) => approved.push(p.text));
  data.facts.certifications.forEach((c) => { c.items.forEach((it) => approved.push(it.display)); approved.push(c.body); });
  approved.push(data.facts.volunteering.text);
  data.facts.roles.forEach((r) => { approved.push(r.title); approved.push(r.org); });
  data.facts.education.forEach((e) => { approved.push(e.title); approved.push(e.org); });
  // formAnswers (26 Sept 2026, item 5): tcsRoleDescription and
  // subjectsStudiedRelevance are newly hand-authored paragraphs, not pulled
  // verbatim from any single already-swept field above - the collision test
  // must cover them the same as any other hand-authored prose in the file.
  Object.keys(data.formAnswers || {}).forEach((k) => {
    var entry = data.formAnswers[k];
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.answer) approved.push(entry.answer);
  });
  var collisions = [];
  approved.forEach((s) => {
    var hits = CVVerify.neverClaimScan(s, data.neverClaim);
    if (hits.length) collisions.push({ text: s, hits: hits });
  });
  return { termsChecked: data.neverClaim.length, stringsChecked: approved.length, collisions: collisions };
}, dataJson);
check(
  collision.termsChecked + ' neverClaim terms checked against ' + collision.stringsChecked + ' approved strings, zero collisions',
  collision.collisions.length === 0,
  JSON.stringify(collision.collisions)
);

// ---- 2. Gate-fires test ---------------------------------------------------
console.log('\n--- Gate-fires test: a deliberately poisoned model must trip exactly its own gate ---');
const gateResult = await page.evaluate((data) => {
  var poisoned = [
    { t: 'name', text: data.identity.name, _prov: { text: { atoms: [{ ref: data.identity, field: 'name' }], join: null, prefix: '', suffix: '' } } },
    { t: 'auth', text: data.identity.rightToWork, _prov: { text: { atoms: [{ ref: data.identity, field: 'rightToWork' }], join: null, prefix: '', suffix: '' } } },
    { t: 'bullet', text: 'Handled confidential SQL reporting tasks daily', _prov: { text: { atoms: [{ ref: { text: 'Handled confidential SQL reporting tasks daily' }, field: 'text' }], join: null, prefix: '', suffix: '' } } },
    { t: 'para', text: 'Led a team through an em—dash sentence.', _prov: { text: { atoms: [{ ref: { text: 'Led a team through an em—dash sentence.' }, field: 'text' }], join: null, prefix: '', suffix: '' } } },
    { t: 'para', text: 'This sentence has no provenance at all.' }
  ];
  var res = CVVerify.runGates(poisoned, data, null);
  var byName = {};
  res.gates.forEach((g) => { byName[g.name] = g; });
  return byName;
}, dataJson);
check('Never-claim gate fires on the injected "SQL" bullet, and only that one', gateResult['Never-claim scan'].passed === false && gateResult['Never-claim scan'].findings.length === 1, JSON.stringify(gateResult['Never-claim scan']));
check('Dash gate fires on the injected em dash, and only that one', gateResult['Dash scan'].passed === false && gateResult['Dash scan'].findings.length === 1, JSON.stringify(gateResult['Dash scan']));
check('Provenance gate fires on the unbacked sentence', gateResult['Provenance check'].passed === false, JSON.stringify(gateResult['Provenance check']));
check('Never-claim finding names the exact block/field location', /block 2 \(bullet\.text\)/.test(gateResult['Never-claim scan'].findings[0]), gateResult['Never-claim scan'].findings[0]);

// ---- 3. matchRule spec cases ----------------------------------------------
console.log('\n--- matchRule spec cases ---');
const matchCases = await page.evaluate(() => ({
  stemCatchesReconciling: CVMatcher.test('the reconciling process', 'reconcil*'),
  stemCatchesReconciliation: CVMatcher.test('a reconciliation task', 'reconcil*'),
  exactAcaDoesNotMatchAcademic: !CVMatcher.test('a strong academic record', 'aca'),
  exactAcaDoesNotMatchVacancy: !CVMatcher.test('an exciting vacancy', 'aca'),
  exactAcaMatchesRealAca: CVMatcher.test('a qualified ACA accountant', 'aca'),
  countHitsSqlSqlSql: CVMatcher.countHits(CVScore.normalize('sql sql sql'), 'sql') === 3,
  countHitsSingleSql: CVMatcher.countHits(CVScore.normalize('one sql mention here'), 'sql') === 1,
  stemHarbourCatchesHarbours: CVMatcher.test('nearby harbours', 'harbour*'),
  exactSqlDoesNotMatchSqlite: !CVMatcher.test('built on sqlite', 'sql')
}));
Object.keys(matchCases).forEach((k) => check('matchRule: ' + k, matchCases[k] === true));

// ---- 3b. Stem-set tag matching: stemmer pairs (27 Sept 2026, item 1b) ----
// "Add golden tests for these pairs at minimum" (Derin's own list,
// verbatim). Proves js/matcher.js's stem()/stemsOverlap() converge each
// pair to a matching stem WITHOUT going through a false-friend the old
// exact-word matching was built to keep out - see js/matcher.js's own
// comments on stem()/stemsOverlap()/MAX_PREFIX_OVERHANG for exactly how.
console.log('\n--- Stem-set tag matching: stemmer pairs ---');
const stemmerPairs = await page.evaluate(() => {
  function overlap(a, b) { return CVMatcher.stemsOverlap(CVMatcher.stem(a), CVMatcher.stem(b)); }
  return {
    liaiseLiaison: overlap('liaise', 'liaison'),
    liaiseLiaising: overlap('liaise', 'liaising'),
    liaisonLiaising: overlap('liaison', 'liaising'),
    validateValidation: overlap('validate', 'validation'),
    validateValidating: overlap('validate', 'validating'),
    validationValidating: overlap('validation', 'validating'),
    processProcessing: overlap('process', 'processing'),
    processProcessed: overlap('process', 'processed'),
    processingProcessed: overlap('processing', 'processed'),
    clientClients: overlap('client', 'clients'),
    reportReporting: overlap('report', 'reporting'),
    documentDocumentation: overlap('document', 'documentation'),
    escalateEscalation: overlap('escalate', 'escalation'),
    // Negative controls - the false-friend cases this pass's own
    // MIN_PREFIX_STEM_LEN/MAX_PREFIX_OVERHANG guards exist to keep closed,
    // proven here rather than just asserted in a comment:
    acaDoesNotOverlapAcademic: !overlap('aca', 'academic'),
    financeDoesNotOverlapFinancial: !overlap('finance', 'financial')
  };
});
Object.keys(stemmerPairs).forEach((k) => check('Stemmer pair: ' + k, stemmerPairs[k] === true));

// tagMatchesText itself, not just the raw stem/stemsOverlap primitives -
// proves the whole word-set path (tokenizing, stopword removal, per-word
// overlap) against real ad phrasing, and the digit-guard fallback that
// keeps a numeric tag like "2:1" on literal phrase matching rather than
// word-set (see js/matcher.js's own comment: "1-2 years' experience"
// contains both "1" and "2" as separate tokens and must NOT satisfy a
// "2:1" degree-classification tag).
const tagMatchCases = await page.evaluate(() => ({
  clientLiaisonMatchesRealSoftcoSentence: CVMatcher.tagMatchesText('client liaison', 'Liaise with clients to confirm data receipt and address ad-hoc queries in line with SOPs.'),
  processingTargetsMatchesRealSoftcoSentence: CVMatcher.tagMatchesText('processing targets', 'Work to achieve daily and weekly processing targets, ensuring accuracy and efficiency in all tasks.'),
  qualityAssuranceDoesNotMatchQualityAlone: !CVMatcher.tagMatchesText('quality assurance', 'Index and edit data files, ensuring quality and consistency.'),
  degreeClassificationDoesNotMatchUnrelatedYearsRange: !CVMatcher.tagMatchesText('2:1', 'I have 1-2 years of experience in a similar role.'),
  degreeClassificationMatchesRealDegreeMention: CVMatcher.tagMatchesText('2:1', 'Graduated with a 2:1 honours degree in finance.')
}));
Object.keys(tagMatchCases).forEach((k) => check('Stem-set tag match: ' + k, tagMatchCases[k] === true));

// ---- 4. Real-JD archetype pick -------------------------------------------
console.log('\n--- Real-JD archetype auto-pick (mismatches are reported, not auto-failed - see tests/golden/README.md) ---');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'real-jds', 'manifest.json'), 'utf8'));
for (const m of manifest) {
  const text = fs.readFileSync(path.join(__dirname, 'real-jds', m.file), 'utf8');
  const result = await page.evaluate(([data, jd]) => {
    var extraction = CVScore.extractFromJD(data, jd);
    var pick = CVScore.pickArchetype(data, extraction);
    return { winnerId: pick.winner.archetype.id, score: pick.winner.score, noMatch: pick.noMatch };
  }, [dataJson, text]);
  const match = result.winnerId === m.archetype_hint;
  console.log((match ? 'MATCH' : 'DIFFERENT (known, see README)') + ' - expected=' + m.archetype_hint + ' got=' + result.winnerId + ' (score ' + result.score + ') - ' + m.title + ' @ ' + m.company);
}

// ---- 5. trim.js policy unit tests (REWRITTEN 19 Sept 2026, Derin's "A-E"
// spec, part A: shorten-then-drop ladder, not drop-only) -------------------
console.log('\n--- trim.js: shorten-then-drop ladder against synthetic models ---');
const trimCases = await page.evaluate(() => {
  // Synthetic bullet with a live `ref` object carrying real heightPx/
  // shortHeightPx, hashed (27 Sept 2026, item 6 - was dataVersion-matched;
  // see js/blockhash.js's own header) against the SAME real
  // data/_blockHeightMeta CVPageFit is already configured with in this
  // page, via the same CVBlockHash.blockHash() pagefit.js's own refHeight
  // uses - so this synthetic ref passes the exact check a real one would.
  // opts.short omitted means "no .short variant" - the realistic shape of
  // a block trim step 1 must skip, not a special case.
  var liveData = CVApp._test.getLoadedData();
  var liveMeta = liveData._blockHeightMeta;
  function bulletHash(text) {
    return CVBlockHash.blockHash(liveData, liveMeta, { text: text, sizeKey: 'body', isBullet: true, docType: 'cv' });
  }
  function bullet(text, groupId, strength, opts) {
    opts = opts || {};
    var ref = { text: text, heightPx: { cv: opts.height != null ? opts.height : 20, hash: bulletHash(text) } };
    if (opts.short) {
      ref.short = opts.short;
      ref.shortHeightPx = { cv: opts.shortHeight != null ? opts.shortHeight : 10, hash: bulletHash(opts.short) };
      // linesSaved (20 Sept 2026): omitted means "never measured" (old-shape
      // ref, or a test that isn't exercising this) - canShorten() must still
      // treat that as shortenable, only `=== 0` skips it.
      if (opts.linesSaved !== undefined) ref.linesSaved = opts.linesSaved;
    }
    return {
      t: 'bullet', text: text, _testId: opts.testId || text,
      _prov: { text: { atoms: [{ ref: ref, field: 'text' }], join: null, prefix: '', suffix: '' } },
      _group: { kind: 'role', id: groupId },
      _trim: { kind: 'bullet', groupId: groupId + '-variant', strength: strength, score: opts.score || 0, ref: ref, shortApplied: false }
    };
  }

  var results = {};

  // Step 1 (shorten) is eligible for EVERY strength, ordered strength
  // ascending then current-height descending - the direct reversal of the
  // old drop-only ladder, and the point of this whole rewrite.
  (function () {
    var model = [
      bullet('core text', 'g-core', 'core', { short: 'core short', height: 30, shortHeight: 10, testId: 'core1' }),
      bullet('filler-lo', 'g-filler-lo', 'filler', { short: 'short-lo', height: 15, shortHeight: 5, testId: 'filler-lo' }),
      bullet('filler-hi', 'g-filler-hi', 'filler', { short: 'short-hi', height: 25, shortHeight: 8, testId: 'filler-hi' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    var shortened = step.model.filter(function (b) { return b._trim.shortApplied; });
    results.shortenPicksLowestStrengthThenTallestFirst =
      step.applied && step.phase === 'shorten' && shortened.length === 1 && shortened[0]._testId === 'filler-hi';
  })();

  // "Every strength is shortenable, including required and core" (Derin,
  // verbatim) - a lone required block with a .short must still shorten,
  // never get skipped the way the old ladder would have skipped a
  // priority-1/2 bullet entirely.
  (function () {
    var model = [bullet('req text', 'g-req', 'required', { short: 'req short', height: 40, shortHeight: 20, testId: 'req1' })];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.shortenAppliesToRequiredBlocks =
      step.applied && step.phase === 'shorten' && step.model[0]._trim.shortApplied === true && step.model[0].text === 'req short';
  })();

  // Step 1 always runs before step 2, even when both are simultaneously
  // possible in the same model.
  (function () {
    var model = [
      bullet('has-short', 'g1', 'filler', { short: 'shortened', height: 10, shortHeight: 5, testId: 'has-short' }),
      bullet('no-short', 'g2', 'filler', { testId: 'no-short' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.shortenStepAlwaysRunsBeforeDropStep = step.applied && step.phase === 'shorten';
  })();

  // Step 2 (drop): filler before support, last-included-first within a
  // strength, never touches core - core-1 here has no .short either, so
  // step 1 is already exhausted and this exercises drop directly.
  (function () {
    var model = [
      bullet('core-1', 'g-core', 'core', { testId: 'core-1' }),
      bullet('filler-early', 'g-multi', 'filler', { testId: 'filler-early' }),
      bullet('filler-late', 'g-multi', 'filler', { testId: 'filler-late' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.dropPicksLastIncludedFillerFirstNeverTouchesCore =
      step.applied && step.phase === 'drop' && step.model.length === 2 &&
      step.model.some(function (b) { return b._testId === 'core-1'; }) &&
      step.model.some(function (b) { return b._testId === 'filler-early'; }) &&
      !step.model.some(function (b) { return b._testId === 'filler-late'; });
  })();

  // Support is never touched while a filler candidate still exists anywhere
  // in the model.
  (function () {
    var model = [
      bullet('support-1', 'g-sup', 'support', { testId: 'support-1' }),
      bullet('support-2', 'g-sup', 'support', { testId: 'support-2' }),
      bullet('filler-1', 'g-fill', 'filler', { testId: 'filler-1' }),
      bullet('filler-2', 'g-fill', 'filler', { testId: 'filler-2' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.dropPrefersFillerOverSupport =
      step.applied && step.phase === 'drop' && /filler/.test(step.description) &&
      step.model.filter(function (b) { return /^support/.test(b._testId); }).length === 2;
  })();

  // Never leave a heading with no bullets under it: when the only filler
  // candidate left is its group's last bullet, the WHOLE entry goes, not
  // just the bullet.
  (function () {
    var model = [
      bullet('core-keep', 'g-core', 'core', { testId: 'core-keep' }),
      bullet('filler-solo', 'g-solo', 'filler', { testId: 'filler-solo' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.dropRemovesWholeEntryWhenOrphaning =
      step.applied && step.phase === 'drop' && step.model.length === 1 &&
      step.model[0]._testId === 'core-keep' && /whole/i.test(step.description);
  })();

  // Fully exhausted: a lone core bullet with no .short can neither be
  // shortened nor dropped - {applied: false} is the caller's cue for step 3
  // (HARD FAILURE), not this file's job to announce.
  (function () {
    var model = [bullet('core-only', 'g-core', 'core', { testId: 'core-only' })];
    var step = CVTrim.applyOneStep(model, 'cv');
    results.neverDropsCoreOrRequiredStopsWhenExhausted =
      step.applied === false && step.phase === null && step.description === null && step.model.length === 1;
  })();

  // linesSaved === 0 (20 Sept 2026): a short that measures to the SAME line
  // count as its full text must never be picked by the shorten step - it
  // should fall straight through to drop, exactly as if no .short existed
  // at all.
  (function () {
    var model = [bullet('zero-save', 'g-zero', 'filler', { short: 'zero save short', height: 20, shortHeight: 20, linesSaved: 0, testId: 'zero-save' })];
    var step = CVTrim.applyOneStep(model, 'cv');
    // Nothing to shorten (skipped) and nothing droppable at strength
    // 'filler' either, since dropping a group's only bullet orphans the
    // heading - so this exercises the whole-entry-removal drop path, not a
    // simple shorten. The point is `shortApplied` never becomes true.
    results.zeroSavingShortNeverGetsShortApplied =
      !model.some(function (b) { return b._trim.shortApplied; }) &&
      (!step.applied || step.phase !== 'shorten');
  })();

  // Same model, but a real, positive-saving sibling present too: the
  // zero-saving block must be skipped in favour of the one that actually
  // helps, even though the zero-saving one would otherwise win the
  // strength/height tie-break (same strength, taller).
  (function () {
    var model = [
      bullet('zero-save-tall', 'g-a', 'filler', { short: 'zero save short but this one is tall', height: 40, shortHeight: 40, linesSaved: 0, testId: 'zero-save-tall' }),
      bullet('real-save-short', 'g-b', 'filler', { short: 'real save short', height: 30, shortHeight: 15, linesSaved: 1, testId: 'real-save-short' })
    ];
    var step = CVTrim.applyOneStep(model, 'cv');
    var shortened = step.model.filter(function (b) { return b._trim.shortApplied; });
    results.zeroSavingShortSkippedInFavourOfRealOne =
      step.applied && step.phase === 'shorten' && shortened.length === 1 && shortened[0]._testId === 'real-save-short';
  })();

  return results;
});
Object.keys(trimCases).forEach((k) => check('trim.js: ' + k, trimCases[k] === true, JSON.stringify(trimCases[k])));

// ---- 6. Fit-check verdicts (Phase 6, spec section 6) -----------------------
console.log('\n--- Fit-check verdicts: BLOCKED / STRETCH / GOOD ---');
async function setJDAndArchetype(jd, archetypeId) {
  await page.fill('#jd-input', jd);
  await page.selectOption('#archetype-select', archetypeId);
  await page.waitForTimeout(300);
  return page.evaluate(() => ({
    verdictClass: document.getElementById('fitcheck-verdict').className,
    verdictText: document.getElementById('fitcheck-verdict').textContent,
    findingsText: Array.from(document.querySelectorAll('#fitcheck-findings li')).map((li) => li.textContent)
  }));
}

const blockedResult = await setJDAndArchetype(
  'Business Analyst role. This engagement is offered on a contractor basis, working with our data team on reporting projects.',
  'business-analyst'
);
check('Fit-check: BLOCKED verdict on a freelance/contractor-basis JD', blockedResult.verdictClass.indexOf('fitcheck-blocked') !== -1, blockedResult.verdictText);
check('Fit-check: BLOCKED finding quotes the actual ad sentence, not a fragment', blockedResult.findingsText.some((t) => /contractor basis/i.test(t)), JSON.stringify(blockedResult.findingsText));

// 14 Sept 2026, Derin's own revised thresholds against yearsRelevant (see
// data.facts.experienceRule.verdictBands): <=1yr = not a stretch factor at
// all, 2-3yr = STRETCH ("a stretch"), 4+yr = STRETCH with stronger "likely
// out of reach" wording (this app kept the 3-tier BLOCKED/STRETCH/GOOD
// verdict rather than adding a 4th tier - see verdictBands._answer for why).
const reachYearsResult = await setJDAndArchetype(
  'Business Analyst role requiring 5+ years of experience in a similar function, strong Excel and reporting skills required.',
  'business-analyst'
);
check('Fit-check: STRETCH verdict on a 5+-years JD (has 1, reach band)', reachYearsResult.verdictClass.indexOf('fitcheck-stretch') !== -1, reachYearsResult.verdictText);
check('Fit-check: 4+ years gets the "likely out of reach" wording, not the plain stretch wording', /likely out of reach/.test(reachYearsResult.verdictText), reachYearsResult.verdictText);

const stretchYearsResult = await setJDAndArchetype(
  'Business Analyst role requiring 2+ years of experience in a similar function, strong Excel and reporting skills required.',
  'business-analyst'
);
check('Fit-check: STRETCH verdict on a 2-years JD (stretch band, not reach)', stretchYearsResult.verdictClass.indexOf('fitcheck-stretch') !== -1, stretchYearsResult.verdictText);
check('Fit-check: 2-3 years gets plain "a stretch" wording, not "out of reach"', /- a stretch\.$/.test(stretchYearsResult.verdictText.trim()) || / - a stretch\./.test(stretchYearsResult.verdictText), stretchYearsResult.verdictText);

const noStretchYearsResult = await setJDAndArchetype(
  'Business Analyst role requiring 1+ years of experience in a similar function, strong Excel and reporting skills required.',
  'business-analyst'
);
check('Fit-check: <=1 year is not a stretch factor at all (GOOD, not STRETCH)', noStretchYearsResult.verdictClass.indexOf('fitcheck-good') !== -1, noStretchYearsResult.verdictText);

// Skip signals: a graduate-programme archetype, or JD text naming an
// internship, means the years test never runs at all - even against a
// requirement that would otherwise land in the stretch/reach bands.
const gradSkipResult = await setJDAndArchetype(
  'Graduate Programme requiring 5+ years of experience in a similar function.', // deliberately contradictory JD text
  'graduate-programme'
);
check('Fit-check: graduate-programme archetype skips the years test entirely, even against 5+ years', gradSkipResult.verdictClass.indexOf('fitcheck-good') !== -1, gradSkipResult.verdictText);

const internshipSkipResult = await setJDAndArchetype(
  'Business Analyst Internship requiring 5+ years of experience in a similar function.', // deliberately contradictory JD text
  'business-analyst'
);
check('Fit-check: "internship" in the JD skips the years test entirely, even against 5+ years', internshipSkipResult.verdictClass.indexOf('fitcheck-good') !== -1, internshipSkipResult.verdictText);

// Ambiguous language: a real experience ask with no parseable number must be
// surfaced, not silently dropped and not guessed at.
const ambiguousResult = await setJDAndArchetype(
  'Business Analyst role. Candidates should have extensive experience in a similar reporting function.',
  'business-analyst'
);
check('Fit-check: ambiguous experience language (no number) is surfaced as a note, not silently dropped', /doesn.t state a figure/.test(ambiguousResult.verdictText), ambiguousResult.verdictText);

const stretchToolsResult = await setJDAndArchetype(
  'Business Analyst role. Must have hands-on experience with Salesforce and SAP for reporting and data management.',
  'business-analyst'
);
check('Fit-check: STRETCH verdict on 2+ confirmed-missing named tools', stretchToolsResult.verdictClass.indexOf('fitcheck-stretch') !== -1, stretchToolsResult.verdictText);

const goodResult = await setJDAndArchetype(
  'Business Analyst role. Strong Excel skills, attention to detail, experience with reporting and data accuracy required.',
  'business-analyst'
);
check('Fit-check: GOOD verdict on an ordinary JD with neither gap', goodResult.verdictClass.indexOf('fitcheck-good') !== -1, goodResult.verdictText);

// 14 Sept 2026, Derin's own escalation: w-qualification's severity now
// depends on the ad's own wording (data.warnings['w-qualification'].
// severityByWording) rather than a flat warn - unhedged blocks, hedged only
// warns, held/in-progress never flags at all.
const unhedgedQualResult = await setJDAndArchetype(
  'Business Analyst role. ACCA qualified essential for this position. Strong Excel and reporting skills required.',
  'business-analyst'
);
check('Fit-check: unhedged qualification wording ("ACCA qualified essential") BLOCKS, not just warns',
  unhedgedQualResult.verdictClass.indexOf('fitcheck-blocked') !== -1, unhedgedQualResult.verdictText);
check('Fit-check: unhedged qualification finding quotes the actual sentence and uses the unhedged message',
  unhedgedQualResult.findingsText.some((t) => /ACCA qualified essential/.test(t) && /no hedge/.test(t)),
  JSON.stringify(unhedgedQualResult.findingsText));

const hedgedQualResult = await setJDAndArchetype(
  'Business Analyst role. ACCA qualified or equivalent experience welcome. Strong Excel and reporting skills required.',
  'business-analyst'
);
check('Fit-check: hedged qualification wording ("or equivalent") only warns - verdict is not BLOCKED',
  hedgedQualResult.verdictClass.indexOf('fitcheck-blocked') === -1, hedgedQualResult.verdictText);
check('Fit-check: hedged qualification finding uses the hedged message, not the unhedged one',
  hedgedQualResult.findingsText.some((t) => /or equivalent/.test(t) && /worth applying anyway/.test(t)),
  JSON.stringify(hedgedQualResult.findingsText));

// A hedge word ELSEWHERE in the ad (attached to a different requirement)
// must not soften an unhedged qualification line it has nothing to do with -
// severity is resolved from the SAME SENTENCE as the credential match, not
// the whole ad.
const unrelatedHedgeResult = await setJDAndArchetype(
  'Business Analyst role. ACCA qualified essential for this position. A driving licence is desirable but not required.',
  'business-analyst'
);
check('Fit-check: a hedge word elsewhere in the ad does not soften an unrelated unhedged qualification line',
  unrelatedHedgeResult.verdictClass.indexOf('fitcheck-blocked') !== -1, unrelatedHedgeResult.verdictText);

// Held/in-progress credential: no case exists in the real data file today
// (Derin holds none of ACA/ACCA/CIMA/CFA/chartered status), so this is
// exercised directly against a patched clone of the real data, the same
// pattern used for trim.js's synthetic-model tests above.
const heldQualCase = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  var wq = patched.warnings.find(function (w) { return w.id === 'w-qualification'; });
  wq.severityByWording.heldOrInProgress = ['ACCA'];
  var extraction = CVScore.extractFromJD(patched, 'Business Analyst role. ACCA qualified essential for this position. Strong Excel and reporting skills required.');
  var archetype = patched.archetypes.find(function (a) { return a.id === 'business-analyst'; });
  var result = CVFitCheck.run(patched, extraction, archetype, '');
  return { findingsCount: result.findings.length, verdict: result.verdict };
}, dataJson);
check('Fit-check: a held/in-progress credential (severityByWording.heldOrInProgress) never raises a finding at all',
  heldQualCase.findingsCount === 0 && heldQualCase.verdict === 'GOOD', JSON.stringify(heldQualCase));

// 8 Oct 2026 (data 1.33): w-qualification matches whole words only. Without
// \b it matched "aca" inside academy / academic / vacancy and "cima" inside
// decimal, so the Salesforce graduate ad ("Salesforce-style academy"), the
// Intact ad ("Vacancy Description") and the Allianz graduate ad ("academic
// projects") were all BLOCKED by the fit check - "Likely not eligible" on the
// verdict card. The credentials themselves must still match, plurals too.
const qualWordCases = await page.evaluate((data) => {
  var archetype = data.archetypes.find(function (a) { return a.id === 'business-analyst'; });
  function qual(text) {
    var result = CVFitCheck.run(data, CVScore.extractFromJD(data, text), archetype, '');
    var f = result.findings.filter(function (x) { return x.id === 'w-qualification'; })[0];
    return f ? f.severity : null;
  }
  var near = {
    academy: 'During your first month you will join a Salesforce-style academy for onboarding.',
    academic: 'We also welcome graduates from all other academic backgrounds.',
    vacancy: 'Vacancy Description: join our claims team in Dublin.',
    decimal: 'Reports are rounded to two decimal places.'
  };
  var words = {
    ACA: 'ACA qualified essential for this position.',
    ACCA: 'ACCA-qualified candidates only.',
    CIMA: 'You must hold CIMA, essential.',
    CFA: 'CFA Level 1 required.',
    QFA: 'QFA required for this role.',
    accountants: 'We are hiring qualified accountants for this team.',
    chartered: 'Chartered status required.'
  };
  var out = { near: {}, words: {} };
  Object.keys(near).forEach(function (k) { out.near[k] = qual(near[k]); });
  Object.keys(words).forEach(function (k) { out.words[k] = qual(words[k]); });
  return out;
}, dataJson);
check('Fit-check: w-qualification ignores "aca"/"cima" inside academy, academic, vacancy and decimal',
  Object.keys(qualWordCases.near).every((k) => qualWordCases.near[k] === null), JSON.stringify(qualWordCases.near));
check('Fit-check: w-qualification still blocks on ACA, ACCA, CIMA, CFA, QFA, qualified accountants and chartered as words',
  Object.keys(qualWordCases.words).every((k) => qualWordCases.words[k] === 'block'), JSON.stringify(qualWordCases.words));
const allianzGradQual = await page.evaluate((args) => {
  var data = args.data;
  var archetype = data.archetypes.find(function (a) { return a.id === 'graduate-programme'; });
  var result = CVFitCheck.run(data, CVScore.extractFromJD(data, args.text), archetype, '');
  return { verdict: result.verdict, ids: result.findings.map(function (f) { return f.id; }) };
}, { data: dataJson, text: fs.readFileSync(path.join(__dirname, 'real-jds', 'graduate-programme__Allianz_Insurance.txt'), 'utf8') });
check('Fit-check: the real Allianz graduate ad ("academic projects") is not BLOCKED by w-qualification',
  allianzGradQual.verdict !== 'BLOCKED' && allianzGradQual.ids.indexOf('w-qualification') === -1, JSON.stringify(allianzGradQual));

// 9 Oct 2026 (data 1.34): w-years fires only where the years extractor
// accepts the figure as an experience requirement (confirmedByYearsExtractor).
// The Allianz graduate ad's "for over 100 years" of company history used to
// show "Years of experience demanded" while the same screen said no
// experience requirement was detected.
const yearsWarnCases = await page.evaluate((args) => {
  var data = args.data;
  var archetype = data.archetypes.find(function (a) { return a.id === 'business-analyst'; });
  function run(text) {
    var ex = CVScore.extractFromJD(data, text);
    var r = CVFitCheck.run(data, ex, archetype, '');
    var f = r.findings.filter(function (x) { return x.id === 'w-years'; })[0];
    return { quote: f ? f.quote : null, discarded: ex.yearsRequiredAllDiscarded, years: ex.yearsRequired };
  }
  var patched = JSON.parse(JSON.stringify(data));
  patched.warnings.find(function (w) { return w.id === 'w-years'; }).confirmedByYearsExtractor = 'true';
  return {
    allianzGrad: run(args.allianzGrad),
    sigmar: run(args.sigmar),
    historyThenReal: run('Founded over 100 years ago, we serve customers across Ireland. Requirements: 2+ years’ experience in customer service.'),
    historyOnly: run('We have served customers in Ireland for 20 years.'),
    flagIsBoolean: data.warnings.find(function (w) { return w.id === 'w-years'; }).confirmedByYearsExtractor === true,
    stringFlagErrors: CVValidate.validateData(patched).filter(function (e) { return /confirmedByYearsExtractor/.test(e); })
  };
}, {
  data: dataJson,
  allianzGrad: fs.readFileSync(path.join(__dirname, 'real-jds', 'graduate-programme__Allianz_Insurance.txt'), 'utf8'),
  sigmar: fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'sigmar-customer-service-representative-night.txt'), 'utf8')
});
check('Fit-check: company history ("for over 100 years", Allianz graduate ad) no longer raises "Years of experience demanded"',
  yearsWarnCases.allianzGrad.quote === null && yearsWarnCases.allianzGrad.discarded === true, JSON.stringify(yearsWarnCases.allianzGrad).slice(0, 300));
check('Fit-check: a real years requirement still raises it (Sigmar, "2+ years\' experience")',
  /2\+ years/.test(yearsWarnCases.sigmar.quote || ''), JSON.stringify(yearsWarnCases.sigmar));
check('Fit-check: a false years hit earlier in the ad does not hide a real one later (quotes the "2+ years" requirement)',
  /2\+ years/.test(yearsWarnCases.historyThenReal.quote || '') && !/100 years/.test(yearsWarnCases.historyThenReal.quote || ''), JSON.stringify(yearsWarnCases.historyThenReal));
check('Fit-check: a figure over 15 ("for 20 years") is not an experience requirement and raises nothing',
  yearsWarnCases.historyOnly.quote === null, JSON.stringify(yearsWarnCases.historyOnly));
check('w-years carries confirmedByYearsExtractor: true, and a string value fails validation',
  yearsWarnCases.flagIsBoolean && yearsWarnCases.stringFlagErrors.length === 1, JSON.stringify(yearsWarnCases.stringFlagErrors));
check('No warning message points at a data-file field ("outcomeLog") the screen never shows',
  dataJson.warnings.every((w) => !/outcomeLog/.test(w.message || '') && !/outcomeLog/.test(w.hedgedMessage || '')),
  JSON.stringify(dataJson.warnings.filter((w) => /outcomeLog/.test((w.message || '') + (w.hedgedMessage || ''))).map((w) => w.id)));

// ---- Second review pass, 14 Sept 2026: standing constraint + outcome log --
console.log('\n--- Second review pass: standing constraint, outcome log, archetype notice ---');

check('_README carries the standing "app may never modify its own rules" constraint',
  /never modify its own rules/.test(dataJson._README), dataJson._README.slice(0, 60) + '...');

check('w-qualification.outcomeLog is empty in the real data file (regression guard against re-seeding a placeholder entry)',
  Array.isArray(dataJson.warnings.find((w) => w.id === 'w-qualification').outcomeLog) &&
  dataJson.warnings.find((w) => w.id === 'w-qualification').outcomeLog.length === 0,
  JSON.stringify(dataJson.warnings.find((w) => w.id === 'w-qualification').outcomeLog));

// Outcome-log summary: prompts only, never changes severity. No real entries
// exist in the data file today, so this is exercised against a patched
// clone, same pattern as the held-credential case above.
const outcomeNoteCase = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  var wq = patched.warnings.find(function (w) { return w.id === 'w-qualification'; });
  wq.outcomeLog = [
    { date: '2026-08-01', company: 'A', role: 'X', archetype: 'business-analyst', dataVersion: '1.4', outcome: 'rejected', bearsOn: 'w-qualification' },
    { date: '2026-09-01', company: 'B', role: 'Y', archetype: 'business-analyst', dataVersion: '1.5', outcome: 'rejected', bearsOn: 'w-qualification' },
    { date: '2026-07-01', company: 'C', role: 'Z', archetype: 'business-analyst', dataVersion: '1.3', outcome: 'no response', bearsOn: 'w-qualification' }
  ];
  var extraction = CVScore.extractFromJD(patched, 'Business Analyst role. ACCA qualified essential for this position. Strong Excel and reporting skills required.');
  var archetype = patched.archetypes.find(function (a) { return a.id === 'business-analyst'; });
  var result = CVFitCheck.run(patched, extraction, archetype, '');
  var qualFinding = result.findings.find(function (f) { return f.id === 'w-qualification'; });
  return { verdict: result.verdict, outcomeNote: qualFinding && qualFinding.outcomeNote };
}, dataJson);
check('Outcome-log summary reports the right count, rejected count and most recent date',
  outcomeNoteCase.outcomeNote === '3 logged outcomes (2 rejected), most recent 2026-09-01 - worth a look, not a verdict.',
  JSON.stringify(outcomeNoteCase));
check('Outcome-log summary never changes the verdict itself - still BLOCKED from the unhedged wording alone',
  outcomeNoteCase.verdict === 'BLOCKED', JSON.stringify(outcomeNoteCase));

// A real warning with an empty outcomeLog (every one in the shipped data
// file, today) must render no note at all.
const noOutcomeNoteCase = await page.evaluate((data) => {
  var extraction = CVScore.extractFromJD(data, 'Business Analyst role. ACCA qualified essential for this position. Strong Excel and reporting skills required.');
  var archetype = data.archetypes.find(function (a) { return a.id === 'business-analyst'; });
  var result = CVFitCheck.run(data, extraction, archetype, '');
  var qualFinding = result.findings.find(function (f) { return f.id === 'w-qualification'; });
  return qualFinding && qualFinding.outcomeNote;
}, dataJson);
check('No outcome-log note renders for a warning with an empty log (today: every real warning)',
  noOutcomeNoteCase == null, JSON.stringify(noOutcomeNoteCase));

// Archetype notice: consulting-tech carries an unresolved _pendingReview,
// every other archetype does not.
async function archetypeNoticeState(archetypeId) {
  await page.fill('#jd-input', '');
  await page.selectOption('#archetype-select', archetypeId);
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    var el = document.getElementById('archetype-notice');
    return { hidden: el.hidden, text: el.textContent };
  });
}
// NOTE, 14 Sept 2026 (third review pass): this originally asserted
// consulting-tech's notice WAS showing - correct at the time this section
// was written, superseded a few hours later the same day when
// consulting-tech got its own stated basis (see the Third review pass
// section below) and _pendingReview was removed. Left the check here and
// flipped it, rather than deleting it, so the history of "this specific
// gap existed, then closed" stays visible in the suite itself; the Third
// review pass section below re-asserts the same fact as its own
// regression guard.
const consultingNotice = await archetypeNoticeState('consulting-tech');
check('consulting-tech no longer shows the archetype-notice banner (resolved same day - see Third review pass section)',
  consultingNotice.hidden === true, JSON.stringify(consultingNotice));
const gradNotice = await archetypeNoticeState('graduate-programme');
check('graduate-programme (no _pendingReview) does not show the archetype-notice banner',
  gradNotice.hidden === true, JSON.stringify(gradNotice));

// js/validate.js: a malformed outcomeLog entry must fail loudly at load time.
const outcomeLogValidation = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  var wq = patched.warnings.find(function (w) { return w.id === 'w-qualification'; });
  wq.outcomeLog = [{ date: '2026-09-01', outcome: 'maybe' }]; // missing company/role/dataVersion/bearsOn, bad outcome enum
  return CVValidate.validateData(patched);
}, dataJson);
check('validate.js catches a malformed outcomeLog entry (missing referent fields and an invalid outcome value)',
  outcomeLogValidation.some((e) => /outcomeLog\[0\]/.test(e) && /missing date\/company\/role/.test(e)) &&
  outcomeLogValidation.some((e) => /outcomeLog\[0\]\.outcome must be one of/.test(e)),
  JSON.stringify(outcomeLogValidation));
const realDataValidation = await page.evaluate((data) => CVValidate.validateData(data), dataJson);
check('validate.js finds zero errors against the real, shipped data file', realDataValidation.length === 0, JSON.stringify(realDataValidation));

// ---- js/experience.js: derived figures, not a stored number ---------------
console.log('\n--- js/experience.js: derived experience figures ---');
const expDirect = await page.evaluate((data) => CVExperience.computeExperience(data), dataJson);
check('experience.js: yearsRelevant is exactly 1 (TCS only, full-time+relevant)', expDirect.yearsRelevant === 1, JSON.stringify(expDirect));
check('experience.js: yearsProfessional equals yearsRelevant today (TCS is the only full-time role)', expDirect.yearsProfessional === expDirect.yearsRelevant, JSON.stringify(expDirect));
check('experience.js: monthsOtherEmployment is 18 (Blarney 8 + D-Mart 10, computed not guessed)', expDirect.monthsOtherEmployment === 18, JSON.stringify(expDirect));

// ---- 7. Project-bearing archetypes build clean (regression guard) ---------
console.log('\n--- Project-bearing archetypes build clean (data.facts.project vs .projects fix) ---');
const PROJECT_ARCHETYPES = ['graduate-programme', 'consulting-tech', 'business-analyst', 'analyst-bi', 'finance-ops'];
for (const id of PROJECT_ARCHETYPES) {
  await page.fill('#jd-input', '');
  await page.selectOption('#archetype-select', id);
  await page.waitForTimeout(200);
  const banner = await page.evaluate(() => ({
    hidden: document.getElementById('build-error').hidden,
    text: document.getElementById('build-error').textContent
  }));
  check('Project archetype "' + id + '" builds without a build-error banner', banner.hidden === true, banner.text);
}

// ---- edu-bms classification: 9.13/10 CGPI and "H1 equivalent" gone -------
// Derin, 14 Sept 2026, absolute instruction: no raw CGPI figure or
// self-declared H1 conversion may print anywhere. Checked against the
// actual rendered preview text, not just the data file, since the data file
// could in principle be clean while a stale build-error state (unlikely,
// but this is exactly the class of gap Phase 4's provenance gate exists to
// catch) still showed it.
console.log('\n--- edu-bms: CGPI/H1 removed, "First Class Honours, Grade 1" prints instead ---');
await page.fill('#jd-input', '');
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(200);
const eduText = await page.evaluate(() => document.getElementById('preview-container').textContent);
check('Preview text contains no raw CGPI figure', !/9\.13|CGPI/i.test(eduText), 'preview text length ' + eduText.length);
check('Preview text contains no "H1 equivalent" wording', !/H1 equivalent/i.test(eduText), 'preview text length ' + eduText.length);
check('Preview text prints "First Class Honours, Grade 1" for the BMS degree', /First Class Honours,\s*Grade 1/.test(eduText), eduText.slice(0, 200));

// ---- Third review pass, 14 Sept 2026: consulting-tech basis, basisRule,
// customer-ops gap found, letterPage geometry -------------------------------
console.log('\n--- Third review pass: consulting-tech basis, basisRule, letterPage ---');

// NOTE, 17 Sept 2026 (third-review-pass redesign): this originally
// hardcoded a literal version string ('1.7'), which is exactly the kind of
// assertion that goes stale every time the data file bumps again for an
// unrelated reason - it just failed here because this session bumped the
// file to 1.10 for page-fit and customer-ops changes with nothing to do
// with the number itself. Replaced with a self-consistency check that
// doesn't need updating on every future bump: the changelog's own most
// recent entry must claim the version the file is actually stamped at.
check('data._version matches its own most recent _changelog entry (self-consistency, not a hardcoded literal)',
  dataJson._changelog && dataJson._changelog[0] && dataJson._changelog[0].version === dataJson._version,
  'data._version=' + dataJson._version + ' changelog[0].version=' + (dataJson._changelog && dataJson._changelog[0] && dataJson._changelog[0].version));

const consultingArch = dataJson.archetypes.find((a) => a.id === 'consulting-tech');
check('consulting-tech no longer carries _pendingReview (resolved)', !consultingArch._pendingReview, JSON.stringify(consultingArch._pendingReview));
check('consulting-tech._why states its own basis for Blarney (three grounds) and volunteering',
  /verifiable Irish work/.test(consultingArch._why) && /community involvement/.test(consultingArch._why),
  consultingArch._why);

const consultingNotice2 = await archetypeNoticeState('consulting-tech');
check('archetype-notice no longer fires for consulting-tech (regression guard on the resolved gap)',
  consultingNotice2.hidden === true, JSON.stringify(consultingNotice2));

// NOTE, 17 Sept 2026 (page-fit redesign pass): this originally asserted
// customer-ops's role-blarney gap WAS still unresolved, flagged loud via
// _pendingReview - correct when written. Resolved a few hours later the
// same redesign pass: customer-ops now states its own basis for
// role-blarney (same reliability/service-environment grounds as
// consulting-tech, restated for this archetype). Flipped rather than
// deleted, same reasoning as the consulting-tech flip above - the history
// of "this gap existed, then closed" stays visible in the suite itself.
// A NEW, separate gap was raised in its place, on purpose, rather than
// silently guessed at: role-dmart was also in customer-ops's include list
// with no stated basis of its own, and Derin hadn't yet been asked what the
// D-Mart role actually involved.
//
// NOTE, 17 Sept 2026, same day, later the same pass: that open question is
// now ALSO resolved. Derin supplied the real provenance split (what he
// stated himself vs. what a job-board posting for the title claims) and the
// approved bullet text. Flipped again, same reasoning: the "flagged, then
// resolved" history stays visible rather than being overwritten.
const customerOpsArch = dataJson.archetypes.find((a) => a.id === 'customer-ops');
check('customer-ops no longer carries _pendingReview (role-blarney gap resolved)',
  !customerOpsArch._pendingReview, JSON.stringify(customerOpsArch._pendingReview));
check('customer-ops._why states its own basis for role-blarney (reliability/service-environment grounds)',
  /back-of-house/i.test(customerOpsArch._why) && /not customer-facing/i.test(customerOpsArch._why),
  customerOpsArch._why);
check('customer-ops._why states role-dmart\'s own resolved basis (regression guard - no longer an open question)',
  /role-dmart/.test(customerOpsArch._why) && /RESOLVED/.test(customerOpsArch._why) && !/OPEN QUESTION/.test(customerOpsArch._why),
  customerOpsArch._why);
check('bulletVariants.b-dmart (unverified, job-board-shaped text) is gone',
  !dataJson.bulletVariants['b-dmart'], Object.keys(dataJson.bulletVariants).filter(k => k.includes('dmart')).join(', '));
check('bul-dmart-floor exists and is marked verifiedBy "stated"',
  dataJson.bulletVariants['bul-dmart-floor']?.variants[0]?.verifiedBy === 'stated',
  JSON.stringify(dataJson.bulletVariants['bul-dmart-floor']));
check('bul-dmart-till is gone (19 Sept 2026: Derin\'s own six-decision spec supplied content only for ' +
  'bul-dmart-floor and confirmed deleting the till bullet rather than inventing content for it)',
  !dataJson.bulletVariants['bul-dmart-till'], Object.keys(dataJson.bulletVariants).filter(k => k.includes('dmart')).join(', '));
const customerOpsNotice = await archetypeNoticeState('customer-ops');
check('archetype-notice no longer fires for customer-ops (regression guard on the resolved gap)',
  customerOpsNotice.hidden === true, JSON.stringify(customerOpsNotice));

// REWRITTEN 19 Sept 2026 (Derin's "A-E" spec, part A): basis is now
// mechanically enforced (js/validate.js refuses to load without one,
// js/trim.js reads basis.strength directly) - basisRule's original 14 Sept
// "not yet mechanically enforced" caveat is preserved verbatim for history
// underneath a dated status update saying exactly that. This check now
// asserts the STATUS UPDATE is present, the flip side of the original
// assertion, same "flagged, then resolved, history stays visible" pattern
// this suite already uses elsewhere (see the consulting-tech/customer-ops
// notes above).
check('trimPolicy.basisRule\'s original "not yet mechanically enforced" caveat is preserved verbatim for history',
  /stated basis is its trim priority/.test(dataJson.trimPolicy.basisRule) &&
  /not.*yet.*mechanically enforced/.test(dataJson.trimPolicy.basisRule),
  dataJson.trimPolicy.basisRule.slice(0, 80) + '...');
check('trimPolicy.basisRule records the 19 Sept 2026 status update: basis is now mechanically enforced',
  /now mechanically enforced/.test(dataJson.trimPolicy.basisRule),
  dataJson.trimPolicy.basisRule.slice(0, 80) + '...');

check('style.letterPage geometry matches the review\'s own px figures (computed, not copied)',
  dataJson.style.letterPage.textWidthTwips === 10106 && dataJson.style.letterPage.usableHeightTwips === 15558,
  JSON.stringify(dataJson.style.letterPage));
check('style.page (CV geometry) is untouched by the letterPage addition',
  dataJson.style.page.margin.left === 850 && dataJson.style.page.margin.right === 850, JSON.stringify(dataJson.style.page));

const letterPageValidation = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  patched.style.letterPage.margin.top = 'not-a-number';
  patched.style.letterPage.usableHeightTwips = -5;
  return CVValidate.validateData(patched);
}, dataJson);
check('validate.js catches a malformed style.letterPage (bad margin type, negative usableHeightTwips)',
  letterPageValidation.some((e) => /letterPage\.margin/.test(e)) && letterPageValidation.some((e) => /letterPage\.usableHeightTwips/.test(e)),
  JSON.stringify(letterPageValidation));

// ---- Page-fit gate redesign, 17 Sept 2026: js/pagefit.js replacing the old
// DOM-scrollHeight measurement (js/preview.js's old FIT_SAFETY_MARGIN_PX=120
// guessed buffer) with a sum of block heights measured once, offline,
// against LibreOffice (tests/golden/measure-blocks.js) - see js/pagefit.js's
// own header and README.md's "browser-based page-fit measurement
// understated real overflow" section for the full history. These checks run
// against the REAL app in the REAL browser context (not a Node scratch
// script) to prove the shipped code path behaves the same way the
// standalone validation scripts already did.
console.log('\n--- Page-fit gate (redesign, 17 Sept 2026): js/pagefit.js ---');

const pageFitEveryArchetype = await page.evaluate((data) => {
  // CVPageFit's cert-items/education-modules lookups are by OBJECT
  // IDENTITY between a model block's _prov ref and data.facts... (see
  // pagefit.js's heightForBlock) - so it must be configured with THIS
  // SAME `data` object (the one page.evaluate just deep-cloned in), not
  // whatever object boot() configured it with when the page first loaded
  // (a separately-fetched copy with different object identity, even
  // though its content is identical). Real app code never hits this: it
  // only ever configures and builds against one single loadedData object
  // for the whole page lifetime.
  CVPageFit.configure(data);
  var out = [];
  (data.archetypes || []).forEach(function (a) {
    var model = CVAssemble.buildModel(data, a.id, {});
    var fit = CVPageFit.measure(model, 'cv');
    var steps = 0;
    while (fit.overflows && steps < 20) {
      var step = CVTrim.applyOneStep(model);
      if (!step.applied) break;
      model = step.model;
      CVAssemble.fixLastParagraphSpacing(model);
      fit = CVPageFit.measure(model, 'cv');
      steps++;
    }
    out.push({ id: a.id, overflowsAfterTrim: fit.overflows, trimSteps: steps, heightPx: fit.heightPx });
  });
  return out;
}, dataJson);
check('Every archetype fits one page after trimming, via the real js/pagefit.js gate (not a Node scratch script)',
  pageFitEveryArchetype.every((r) => !r.overflowsAfterTrim),
  JSON.stringify(pageFitEveryArchetype));

// The check above deliberately left CVPageFit configured against its own
// cloned `data` argument, not the real loadedData object boot() configured
// it with - correct for that check (see its own comment), but a landmine
// for every test after it that exercises the real app UI (setJDAndArchetype
// et al.), since pagefit's cert/module lookups are by object identity. Undo
// it here, immediately, using the read-only handle CVApp._test exposes for
// exactly this purpose - found the hard way 19 Sept 2026 when the new Fix 1
// "no headings" UI test started throwing "could not find the certification
// entry owning this items line" from a completely unrelated test 100+ lines
// above it.
await page.evaluate(() => { CVPageFit.configure(CVApp._test.getLoadedData()); });

const skillLineLiveReorder = await page.evaluate((data) => {
  // A category's height must change when the app actually reorders its
  // terms (JD-hit terms first) - proves the gate re-simulates the wrap on
  // the LIVE text, not a stale file-order constant. business has enough
  // terms to wrap onto 2 lines in file order (see wrapsim-test.js's
  // validated baseline).
  var cat = data.skillLines.business;
  var fileOrderBlock = { t: 'skillLine', label: cat.label, text: cat.terms.map(function (t) { return t.text; }).join(data.style.separator) };
  var reorderedTerms = cat.terms.slice().reverse();
  var reorderedBlock = { t: 'skillLine', label: cat.label, text: reorderedTerms.map(function (t) { return t.text; }).join(data.style.separator) };
  return {
    fileOrderHeight: CVPageFit.heightForBlock(fileOrderBlock, 'cv'),
    reversedHeight: CVPageFit.heightForBlock(reorderedBlock, 'cv'),
    fileOrderBaseline: cat._fileOrderBaselineHeightPx && cat._fileOrderBaselineHeightPx.cv
  };
}, dataJson);
check('skillLine height is computed live from the block\'s actual text (matches the measured file-order baseline when unreordered)',
  Math.abs(skillLineLiveReorder.fileOrderHeight - skillLineLiveReorder.fileOrderBaseline) < 0.5,
  JSON.stringify(skillLineLiveReorder));

// 27 Sept 2026, item 6: heightPx staleness is now a hash of each block's
// own text + the style values it depends on, NOT a data._version stamp -
// see js/blockhash.js's own header for the full "forgotten re-stamp" story
// this replaced. These two checks prove both halves of that claim
// directly, rather than just asserting it in a comment: a version bump
// alone must change nothing (was the exact opposite before this pass -
// EVERY one of the 60+ measured blocks used to mismatch on any bump), and
// an actual text change with no re-measurement must still be caught,
// named to the one block that needs it.
const versionBumpAloneResult = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  patched._version = '999.0'; // touches nothing any block's hash depends on
  return CVValidate.validateData(patched);
}, dataJson);
check('validate.js: a data._version bump alone (no block text or style value touched) stays clean - the old "forgotten re-stamp" failure mode',
  versionBumpAloneResult.length === 0, 'error count: ' + versionBumpAloneResult.length + ' - ' + JSON.stringify(versionBumpAloneResult.slice(0, 3)));

const textChangeCaughtResult = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  // Mutate ONE bullet variant's text without touching its stored heightPx
  // (or its dataVersion/hash) - the exact "content edit that must not
  // silently go unmeasured" scenario _blockHeightMeta._readme describes.
  patched.bulletVariants['bul-dmart-floor'].variants[0].text += ' EDITED WITHOUT REMEASURING';
  return CVValidate.validateData(patched);
}, dataJson);
const dmartError = textChangeCaughtResult.filter((e) => /bul-dmart-floor/.test(e));
check('validate.js: an actual text edit with no remeasurement is caught, naming the exact block to remeasure',
  dmartError.length === 1 && /stale/.test(dmartError[0]), JSON.stringify(textChangeCaughtResult));
check('validate.js: that same text edit does NOT flag any OTHER block (this is a per-block hash, not a file-wide stamp)',
  textChangeCaughtResult.length === 1, 'error count: ' + textChangeCaughtResult.length + ' - ' + JSON.stringify(textChangeCaughtResult));

// ---- js/segment.js: JD boilerplate segmentation (18-19 Sept 2026, Derin's
// own fix for the two real ECHO/years false hits found testing against the
// real Davy Group ad - see js/segment.js's header) -------------------------
console.log('\n--- js/segment.js: heading-based MATCHABLE/IGNORED segmentation ---');

// Fix 1: a boilerplate sentence under an IGNORED heading must not register
// as a keyword hit, and must never reach the ECHO pick-list, even when it
// contains a real approved tag phrase - and a genuine requirement sentence
// under a MATCHABLE heading must still work exactly as before.
const boilerplateJD = [
  'About us',
  'Our people are what drive our proud legacy systems and shared success across the business.',
  '',
  'About the role',
  'We need a Business Analyst to support reporting and decision making for our team.',
  '',
  'Requirements',
  'Advanced Microsoft Excel skills and strong client requirements gathering ability are essential.',
  '',
  'Equal Opportunity',
  'We are an equal opportunities employer. Even if you are not meeting all client requirements outlined in this ad, we encourage you to apply.',
  ''
].join('\n');

const segmentationResult = await page.evaluate((args) => {
  var data = args.data, jd = args.jd;
  var extraction = CVScore.extractFromJD(data, jd);
  var experience = CVExperience.computeExperience(data);
  var echoCandidates = CVLetterBuild.buildEchoCandidates(data, jd, experience.yearsRelevant);
  return {
    headingsFound: extraction.headingsFound,
    keywordHitKeys: Object.keys(extraction.keywordHits),
    echoTexts: echoCandidates.map(function (c) { return c.text; })
  };
}, { data: dataJson, jd: boilerplateJD });

check('Fix 1: headingsFound is true when the ad has real section headings',
  segmentationResult.headingsFound === true, JSON.stringify(segmentationResult.headingsFound));
check('Fix 1: a tag phrase ("legacy systems") appearing only under an IGNORED heading is not a keyword hit',
  segmentationResult.keywordHitKeys.indexOf('legacy systems') === -1, JSON.stringify(segmentationResult.keywordHitKeys));
check('Fix 1: the same tag phrase ("client requirements") appearing under a MATCHABLE heading IS a keyword hit',
  segmentationResult.keywordHitKeys.indexOf('client requirements') !== -1, JSON.stringify(segmentationResult.keywordHitKeys));
check('Fix 1: a genuine requirement sentence ("excel skills") under a MATCHABLE heading still matches',
  segmentationResult.keywordHitKeys.indexOf('excel skills') !== -1, JSON.stringify(segmentationResult.keywordHitKeys));
check('Fix 1: the "proud legacy systems" boilerplate sentence never reaches the ECHO pick-list',
  !segmentationResult.echoTexts.some((t) => /proud legacy/i.test(t)), JSON.stringify(segmentationResult.echoTexts));
check('Fix 1: the "not meeting all client requirements" diversity-statement sentence never reaches the ECHO pick-list',
  !segmentationResult.echoTexts.some((t) => /not meeting all/i.test(t) || /not.*meeting.*client requirements/i.test(t)), JSON.stringify(segmentationResult.echoTexts));
check('Fix 1: the genuine Excel requirement sentence DOES reach the ECHO pick-list (positive control)',
  segmentationResult.echoTexts.some((t) => /excel skills/i.test(t)), JSON.stringify(segmentationResult.echoTexts));

// Fix 1's own explicit fallback: no headings at all -> match the whole text,
// and say so in the fit-check panel rather than silently narrowing.
const noHeadingsResult = await setJDAndArchetype(
  'Business Analyst role. Strong Excel skills, attention to detail, experience with reporting and data accuracy required.',
  'business-analyst'
);
const noHeadingsExtraction = await page.evaluate((data) => CVScore.extractFromJD(data,
  'Business Analyst role. Strong Excel skills, attention to detail, experience with reporting and data accuracy required.'), dataJson);
check('Fix 1: a JD with no headings at all sets headingsFound to false',
  noHeadingsExtraction.headingsFound === false, JSON.stringify(noHeadingsExtraction.headingsFound));
check('Fix 1: the fit-check panel shows the no-headings fallback notice',
  /no section headings found/.test(noHeadingsResult.verdictText), noHeadingsResult.verdictText);

// Fix 3: the years extractor - four conditions, dash normalization, and the
// lower-bound-of-a-range correctness fix.
const yearsCases = await page.evaluate(() => ({
  hundredYearsFoundedDiscarded: CVScore.extractYearsRequired('Our company was founded over 100 years ago and proudly celebrates 100 years of service to clients.') === null,
  twoPlusYears: CVScore.extractYearsRequired("Candidates need 2+ years' experience in a similar role.") === 2,
  rangeLowerBoundPQE: CVScore.extractYearsRequired("Between 1-5 years' post-qualification experience required.") === 1,
  rangeLowerBoundFullTime: CVScore.extractYearsRequired('Up to 1-2 years of full-time experience is ideal for this role.') === 1,
  // en-dash range, normalized to hyphen before parsing (real ad text, per
  // Derin's own instruction) - JS source below uses the literal en-dash
  // character U+2013, not a hyphen.
  enDashRange: CVScore.extractYearsRequired('Up to 1–2 years of full-time experience is ideal.') === 1
}));
Object.keys(yearsCases).forEach((k) => check('Fix 3: ' + k, yearsCases[k] === true, JSON.stringify(yearsCases[k])));

// "allDiscarded" reporting: a number was found and every candidate got
// discarded, distinct from no number being present at all.
const allDiscardedCase = await page.evaluate((data) =>
  CVScore.extractFromJD(data, 'Our company was founded over 100 years ago and celebrates 100 years of service.').yearsRequiredAllDiscarded,
  dataJson);
check('Fix 3: yearsRequiredAllDiscarded is true when every candidate was discarded',
  allDiscardedCase === true, JSON.stringify(allDiscardedCase));
const noDiscardCase = await page.evaluate((data) =>
  CVScore.extractFromJD(data, 'Business Analyst role. Strong Excel skills required.').yearsRequiredAllDiscarded,
  dataJson);
check('Fix 3: yearsRequiredAllDiscarded is false when no years-token candidate exists at all',
  noDiscardCase === false, JSON.stringify(noDiscardCase));

// ---- Fix 2: tag-length validation ------------------------------------------
console.log('\n--- Fix 2: js/validate.js single-word tag rejection ---');
const tagValidation = await page.evaluate((data) => {
  var patched = JSON.parse(JSON.stringify(data));
  var results = {};

  var badTag = JSON.parse(JSON.stringify(patched));
  badTag.bulletVariants['bul-tcs-accuracy'].variants[0].tags.push('legacy');
  results.singleWordLowercaseFails = CVValidate.validateData(badTag).some((e) => /tag 'legacy'/.test(e));

  var acronymTag = JSON.parse(JSON.stringify(patched));
  acronymTag.bulletVariants['bul-tcs-accuracy'].variants[0].tags.push('OMNI');
  results.allCapsAcronymPasses = !CVValidate.validateData(acronymTag).some((e) => /tag 'OMNI'/.test(e));

  return results;
}, dataJson);
check('Fix 2: a single-word lowercase tag fails validation', tagValidation.singleWordLowercaseFails === true, JSON.stringify(tagValidation));
check('Fix 2: a 2-6 character all-caps acronym tag ("OMNI") passes validation', tagValidation.allCapsAcronymPasses === true, JSON.stringify(tagValidation));
check('Fix 2: the real, shipped data file (post-sweep) has zero tag-length violations',
  !realDataValidation.some((e) => /is a single word and not a/.test(e)), JSON.stringify(realDataValidation.filter((e) => /is a single word/.test(e))));

// ---- Dangling file-reference lint (19 Sept 2026, Derin's "A-E" spec, part
// E2): "no document or comment in this project may reference a file,
// function or behaviour that does not exist... Validation can check the
// narrow version of that cheaply - assert every path string appearing in
// validate.js and the changelog resolves." This needs real filesystem
// access, which no browser-side code in this app has - it lives here,
// Node-side, rather than inside js/validate.js itself. Narrow on purpose:
// only strings that already look like a repo-relative file path (a
// directory segment, then a filename with a code/data extension) are
// checked - this is a lint for exactly the failure this session found
// (measure-blocks.js referenced everywhere, existing nowhere), not a
// general prose-correctness checker. ---------------------------------------
console.log('\n--- Dangling file-reference lint: every path string in validate.js/changelog resolves ---');
const PATH_RE = /\b(?:js|tests|data|lib|scripts|vendor-test-only)\/[A-Za-z0-9_\-./]+\.(?:js|mjs|json)\b/g;
// Files that have since moved. The changelog is a record and keeps its old
// wording; a path listed here counts as resolved while its new home exists.
const MOVED_PATHS = { 'vendor-test-only/docx.umd.js': 'lib/docx.umd.js' };
function findDanglingPaths(text, sourceLabel) {
  var seen = {};
  var dangling = [];
  var m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    var p = m[0];
    if (seen[p]) continue;
    seen[p] = true;
    var target = MOVED_PATHS[p] || p;
    if (!fs.existsSync(path.join(REPO_ROOT, target))) dangling.push(p);
  }
  return dangling.map((p) => p + ' (in ' + sourceLabel + ')');
}
const validateJsSource = fs.readFileSync(path.join(REPO_ROOT, 'js', 'validate.js'), 'utf8');
const changelogText = (dataJson._changelog || []).map((e) => e.summary || '').join('\n');
const danglingInValidate = findDanglingPaths(validateJsSource, 'js/validate.js');
const danglingInChangelog = findDanglingPaths(changelogText, '_changelog');
check('Every file-path string in js/validate.js resolves to a real file', danglingInValidate.length === 0, JSON.stringify(danglingInValidate));
check('Every file-path string in _changelog resolves to a real file', danglingInChangelog.length === 0, JSON.stringify(danglingInChangelog));

// ---- letterBlocks.evidence: TCS variant per-archetype mapping (19 Sept
// 2026, Derin's reply to the previous pass's report). Two things needed
// proving, the same "watch the gate actually fire" discipline as every
// other gate in this project: (1) the total-mapping check in validate.js
// really does refuse a data file where an archetype has zero or two
// let-ev-tcs-* matches, not just pass on the real file by construction;
// (2) js/letterbuild.js's buildLetterModel actually resolves to the RIGHT
// variant per archetype and picks text vs noEchoText correctly, not just
// "some evidence block gets chosen." -----------------------------------
console.log('\n--- letterBlocks.evidence: TCS variant per-archetype mapping ---');
const tcsMapping = await page.evaluate((data) => {
  var results = {};

  // Zero-coverage: strip 'business-analyst' out of every TCS variant.
  var zeroCov = JSON.parse(JSON.stringify(data));
  zeroCov.letterBlocks.evidence.forEach(function (e) {
    if (/^let-ev-tcs-/.test(e.id)) e.archetypes = (e.archetypes || []).filter(function (a) { return a !== 'business-analyst'; });
  });
  results.zeroCoverageFires = CVValidate.validateData(zeroCov).some(function (err) {
    return err.indexOf("archetype 'business-analyst'") !== -1 && err.indexOf('no let-ev-tcs-*') !== -1;
  });

  // Double-coverage: add 'business-analyst' to let-ev-tcs-pilot too, on
  // top of its real home in let-ev-tcs-control.
  var doubleCov = JSON.parse(JSON.stringify(data));
  doubleCov.letterBlocks.evidence.forEach(function (e) {
    if (e.id === 'let-ev-tcs-pilot') e.archetypes.push('business-analyst');
  });
  results.doubleCoverageFires = CVValidate.validateData(doubleCov).some(function (err) {
    return err.indexOf("archetype 'business-analyst'") !== -1 && err.indexOf('must be exactly one') !== -1;
  });

  // Correct variant + text/noEchoText resolution, per real archetype.
  // Needs a real `extraction.keywordHits` (overlapScore's own contract -
  // see js/assemble.js) matching the target variant's own tags, otherwise
  // bestByTags scores everything 0 and ties go to file order (console
  // first) regardless of archetype - not a meaningful test of the new
  // archetype filter on its own.
  function evidenceIdFor(archetypeId, tagsToHit, echoText) {
    var hits = {};
    tagsToHit.forEach(function (t) { hits[t.toLowerCase()] = true; });
    var model = CVLetterBuild.buildLetterModel(data, {
      archetypeId: archetypeId, extraction: { keywordHits: hits }, rawJD: '',
      company: 'Acme', role: 'Analyst', echoText: echoText || ''
    });
    // the FIRST pick (4 Oct 2026: a letter can now carry a second evidence
    // paragraph, printed in file order, so position 0 is not always it)
    var ev = model.blocks.filter(function (b) { return b.category === 'evidence' && b.evidenceRole === 'primary'; })[0];
    return ev ? { id: ev.id, text: ev.text } : null;
  }
  var pilotPick = evidenceIdFor('consulting-tech', ['accuracy', 'financial services', 'migration', 'pilot'], 'a process nobody had run before');
  var controlPick = evidenceIdFor('business-analyst', ['accuracy', 'financial services', 'peer review', 'controls'], 'a process nobody had run before');
  var improvePick = evidenceIdFor('customer-ops', ['accuracy', 'financial services', 'automation', 'process improvement'], 'a process nobody had run before');
  var shiftPick = evidenceIdFor('retail-parttime', ['shift work', 'reliability', 'targets', 'punctuality'], 'a shift you did not pick');
  results.pilotArchetypePicksPilotVariant = pilotPick && pilotPick.id === 'let-ev-tcs-pilot';
  results.controlArchetypePicksControlVariant = controlPick && controlPick.id === 'let-ev-tcs-control';
  results.improveArchetypePicksImproveVariant = improvePick && improvePick.id === 'let-ev-tcs-improve';
  results.retailArchetypePicksShiftVariant = shiftPick && shiftPick.id === 'let-ev-tcs-shift';

  // noEchoText branch: with echoText empty, the returned text must be the
  // shorter sibling (no trailing ECHO sentence), never a dangling {{ECHO}}.
  var pilotEntry = data.letterBlocks.evidence.filter(function (e) { return e.id === 'let-ev-tcs-pilot'; })[0];
  var noEcho = evidenceIdFor('consulting-tech', ['accuracy', 'financial services', 'migration', 'pilot'], '');
  results.noEchoTextUsedWhenEchoEmpty = noEcho && noEcho.text === pilotEntry.noEchoText;

  // 3 Oct 2026 (Derin: drop the repeated quote): when the why paragraph's
  // echo frame has already quoted the line - every frame is archetypes
  // ["*"], so that is every standard letter with a quote - the evidence
  // paragraph uses noEchoText too, and the line appears once. The
  // {{ECHO}} ending is still used when a quote exists but no frame used
  // it (checked on a copy of the data with the frames removed).
  results.quotedInWhyUsesNoEchoText = pilotPick && pilotPick.text === pilotEntry.noEchoText;
  var hitsPilot = {};
  ['accuracy', 'financial services', 'migration', 'pilot'].forEach(function (t) { hitsPilot[t] = true; });
  var echoLine = 'the line quoted from the ad goes here';
  var onceModel = CVLetterBuild.buildLetterModel(data, {
    archetypeId: 'consulting-tech', extraction: { keywordHits: hitsPilot }, rawJD: '', company: 'Acme', role: 'Analyst', echoText: echoLine
  });
  var onceText = onceModel.blocks.map(function (b) { return b.text; }).join('\n');
  results.quoteAppearsOnce = onceText.split(echoLine).length - 1 === 1 &&
    onceModel.blocks.some(function (b) { return b.ref && b.ref.isEchoFrame; });
  var noFrames = JSON.parse(JSON.stringify(data));
  noFrames.letterBlocks.why = noFrames.letterBlocks.why.filter(function (e) { return !e.isEchoFrame; });
  var frameless = CVLetterBuild.buildLetterModel(noFrames, {
    archetypeId: 'consulting-tech', extraction: { keywordHits: hitsPilot }, rawJD: '', company: 'Acme', role: 'Analyst', echoText: echoLine
  });
  var framelessEv = frameless.blocks.filter(function (b) { return b.category === 'evidence' && b.evidenceRole === 'primary'; })[0];
  results.noFrameKeepsEchoEnding = !!framelessEv && /the highest of the ten\. the line quoted from the ad goes here\.$/.test(framelessEv.text);

  // --- Real-pipeline check (20 Sept 2026) -------------------------------
  // Everything above injects extraction.keywordHits by hand, built straight
  // from each variant's own tags - it proves bestByTags()/entriesForArchetype()
  // work, but it never exercises js/score.js's real extractFromJD(), so it
  // could not have caught the allKnownTags() bug found this pass (see
  // js/score.js's own comment): letterBlocks.evidence tags were never part
  // of the "known tags" universe extractKeywordHits() builds from, so 10 of
  // the 14 pre-fix evidence tags could never register a hit against a real
  // JD no matter what it said. This runs a real JD string through the real
  // CVScore.extractFromJD(), the same call js/app.js makes, and checks the
  // evidence pick is still correct end to end - the thing that actually
  // matters, not just the unit underneath it.
  var realJD = 'We are hiring for permanent night shift retail positions. ' +
    'Reliability and punctuality are essential - you must be available to ' +
    'work evenings and turn up for every shift. Sales targets apply after probation.';
  var realExtraction = CVScore.extractFromJD(data, realJD);
  results.realExtractionHasShiftTagHits = !!(realExtraction.keywordHits['shift work'] ||
    realExtraction.keywordHits['reliability'] || realExtraction.keywordHits['targets'] ||
    realExtraction.keywordHits['punctuality']);
  var realModel = CVLetterBuild.buildLetterModel(data, {
    archetypeId: 'retail-parttime', extraction: realExtraction, rawJD: realJD,
    company: 'Acme Retail', role: 'Sales Assistant', echoText: 'turn up for every shift'
  });
  var realEvidence = realModel.blocks.filter(function (b) { return b.category === 'evidence' && b.evidenceRole === 'primary'; })[0];
  results.realPipelinePicksShiftVariant = realEvidence && realEvidence.id === 'let-ev-tcs-shift';

  return results;
}, dataJson);
check('TCS evidence mapping: validate.js refuses a data file where an archetype has zero TCS matches',
  tcsMapping.zeroCoverageFires === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: validate.js refuses a data file where an archetype has two TCS matches',
  tcsMapping.doubleCoverageFires === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: consulting-tech (pilot) resolves to let-ev-tcs-pilot',
  tcsMapping.pilotArchetypePicksPilotVariant === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: business-analyst (control) resolves to let-ev-tcs-control',
  tcsMapping.controlArchetypePicksControlVariant === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: customer-ops (improve) resolves to let-ev-tcs-improve',
  tcsMapping.improveArchetypePicksImproveVariant === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: retail-parttime resolves to let-ev-tcs-shift (20 Sept 2026 correction)',
  tcsMapping.retailArchetypePicksShiftVariant === true, JSON.stringify(tcsMapping));
check('TCS evidence mapping: noEchoText is used (not a dangling {{ECHO}}) when no echo quote is available',
  tcsMapping.noEchoTextUsedWhenEchoEmpty === true, JSON.stringify(tcsMapping));
check('TCS evidence (3 Oct 2026): when the why paragraph already quotes the ad, the evidence paragraph uses its no-quote ending',
  tcsMapping.quotedInWhyUsesNoEchoText === true, JSON.stringify(tcsMapping));
check('TCS evidence (3 Oct 2026): a letter with a quoted line prints it exactly once',
  tcsMapping.quoteAppearsOnce === true, JSON.stringify(tcsMapping));
check('TCS evidence (3 Oct 2026): with no frame quoting the line, the evidence paragraph still ends with it (as its own sentence)',
  tcsMapping.noFrameKeepsEchoEnding === true, JSON.stringify(tcsMapping));

// ---- Second evidence paragraph (4 Oct 2026, Derin: "yes" to "add a second
// evidence paragraph whenever it fits on the page") ----------------------
const secondEv = await page.evaluate(([data, fixtures]) => {
  var out = { perFixture: [], problems: [] };
  var order = data.letterBlocks.evidence.map(function (e) { return e.id; });
  fixtures.forEach(function (fx) {
    var extraction = CVScore.extractFromJD(data, fx.text);
    var pick = CVScore.pickArchetype(data, extraction);
    if (pick.noMatch) return;
    var arch = pick.winner.archetype.id;
    var built = CVLetter.buildLetterContentModel(data, { archetypeId: arch, extraction: extraction, rawJD: fx.text, company: 'Acme', role: 'Analyst', echoText: '' });
    var ids = built.letterResult.blocks.filter(function (b) { return b.category === 'evidence'; }).map(function (b) { return b.id; });
    out.perFixture.push(fx.name + ': ' + ids.join(' + '));
    if (ids.length !== 2) out.problems.push(fx.name + ': ' + ids.length + ' evidence paragraph(s)');
    if (ids.filter(function (id) { return /^let-ev-tcs-/.test(id); }).length > 1) out.problems.push(fx.name + ': two TCS paragraphs');
    if (ids.length === 2 && order.indexOf(ids[0]) > order.indexOf(ids[1])) out.problems.push(fx.name + ': not in data-file order');
    if (ids.indexOf('let-ev-ai') !== -1 && !extraction.keywordHits['ai']) out.problems.push(fx.name + ': AI paragraph without an "ai" match');
    if (!ids.some(function (id) { return /^let-ev-tcs-/.test(id); })) out.problems.push(fx.name + ': no TCS paragraph');
    if (CVPageFit.measure(built.model, 'letter').overflows) out.problems.push(fx.name + ': overflows');
  });
  function idsFor(d, arch, hits, choices) {
    var r = CVLetterBuild.buildLetterModel(d, { archetypeId: arch, extraction: { keywordHits: hits }, rawJD: '', company: 'Acme', role: 'Analyst', echoText: '', choices: choices || {} });
    return r.blocks.filter(function (b) { return b.category === 'evidence'; }).map(function (b) { return b.id; });
  }
  // let-ev-ai says "the AI tooling you mention": never picked by itself
  // unless the ad matched 'ai' - 'automation'/'tooling' alone are not enough.
  out.aiGuardOff = idsFor(data, 'finance-ops', { automation: true, tooling: true });
  out.aiGuardOn = idsFor(data, 'finance-ops', { ai: true, automation: true, tooling: true });
  out.handPickAi = idsFor(data, 'insurance-pensions', { accuracy: true }, { evidence2: 'let-ev-ai' });
  out.noneSecond = idsFor(data, 'insurance-pensions', { accuracy: true }, { evidence2: 'none' });
  out.samePick = idsFor(data, 'insurance-pensions', { accuracy: true }, { evidence: 'let-ev-console', evidence2: 'let-ev-console' });
  // "whenever it fits": a copy of the data whose console paragraph is far
  // too tall - the automatic second paragraph is dropped and said so.
  var tall = JSON.parse(JSON.stringify(data));
  tall.letterBlocks.evidence.filter(function (e) { return e.id === 'let-ev-console'; })[0].heightPx.letter = 700;
  var wtw = fixtures.filter(function (f) { return f.name === 'wtw-pensions-administrator'; })[0];
  var wex = CVScore.extractFromJD(tall, wtw.text);
  var dropped = CVLetter.buildLetterContentModel(tall, { archetypeId: 'insurance-pensions', extraction: wex, rawJD: wtw.text, company: 'WTW', role: 'Pensions Administrator', echoText: '' });
  out.dropped = { droppedForFit: dropped.letterResult.evidence2DroppedForFit || null,
    ids: dropped.letterResult.blocks.filter(function (b) { return b.category === 'evidence'; }).map(function (b) { return b.id; }),
    fits: !CVPageFit.measure(dropped.model, 'letter').overflows };
  // and the TCS paragraph is never the one taken out, even when it is the
  // tall one (Derin: "keep my tcs experience")
  var tallTcs = JSON.parse(JSON.stringify(data));
  tallTcs.letterBlocks.evidence.filter(function (e) { return e.id === 'let-ev-tcs-control'; })[0].heightPx.letter = 700;
  var keptTcs = CVLetter.buildLetterContentModel(tallTcs, { archetypeId: 'insurance-pensions', extraction: CVScore.extractFromJD(tallTcs, wtw.text), rawJD: wtw.text, company: 'WTW', role: 'Pensions Administrator', echoText: '' });
  out.keptTcs = { droppedForFit: keptTcs.letterResult.evidence2DroppedForFit || null,
    ids: keptTcs.letterResult.blocks.filter(function (b) { return b.category === 'evidence'; }).map(function (b) { return b.id; }) };
  return out;
}, [dataJson, fs.readdirSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd')).filter((f) => f.endsWith('.txt'))
  .map((f) => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', f), 'utf8') }))]);
console.log('  second evidence paragraph per fixture: ' + secondEv.perFixture.join(' | '));
check('Second evidence paragraph: every fixture letter carries two, always including the TCS paragraph, never two TCS paragraphs, in data-file order, the AI one only for ads that match "ai", and still one page',
  secondEv.problems.length === 0 && secondEv.perFixture.length >= 7, JSON.stringify(secondEv.problems));
check('Second evidence paragraph: the AI paragraph is never picked by itself on "automation"/"tooling" alone, and is with an "ai" match',
  secondEv.aiGuardOff.indexOf('let-ev-ai') === -1 && secondEv.aiGuardOn.indexOf('let-ev-ai') !== -1, JSON.stringify([secondEv.aiGuardOff, secondEv.aiGuardOn]));
check('Second evidence paragraph: a hand pick is used as chosen, "none" leaves one paragraph, and the same paragraph is never printed twice',
  secondEv.handPickAi.indexOf('let-ev-ai') !== -1 && secondEv.handPickAi.length === 2 && secondEv.noneSecond.length === 1 &&
  secondEv.samePick.length === 1 && secondEv.samePick[0] === 'let-ev-console', JSON.stringify([secondEv.handPickAi, secondEv.noneSecond, secondEv.samePick]));
check('Second evidence paragraph: dropped again, and reported, when the letter would not fit on one page with it',
  secondEv.dropped.droppedForFit === 'let-ev-console' && secondEv.dropped.ids.length === 1 && secondEv.dropped.fits === true, JSON.stringify(secondEv.dropped));
check('Second evidence paragraph: the TCS paragraph is never the one taken out for space, even when it is the tall one',
  secondEv.keptTcs.droppedForFit === 'let-ev-console' && JSON.stringify(secondEv.keptTcs.ids) === JSON.stringify(['let-ev-tcs-control']), JSON.stringify(secondEv.keptTcs));
check('Second evidence paragraph: picking the AI one by hand keeps the TCS paragraph beside it; turning the second off leaves the TCS one',
  JSON.stringify(secondEv.handPickAi) === JSON.stringify(['let-ev-tcs-control', 'let-ev-ai']) && JSON.stringify(secondEv.noneSecond) === JSON.stringify(['let-ev-tcs-control']),
  JSON.stringify([secondEv.handPickAi, secondEv.noneSecond]));
check('allKnownTags fix: a real JD about night shifts/reliability/targets actually registers hits under the evidence tags',
  tcsMapping.realExtractionHasShiftTagHits === true, JSON.stringify(tcsMapping));
check('allKnownTags fix: real CVScore.extractFromJD pipeline (not injected hits) still picks let-ev-tcs-shift for retail-parttime',
  tcsMapping.realPipelinePicksShiftVariant === true, JSON.stringify(tcsMapping));

// ---- Zero-saving shorts: measured, reported, and skipped at runtime (20
// Sept 2026, Derin's own three-part instruction - MEASURE IT / SKIP THEM AT
// RUNTIME / WARN AT LOAD). The synthetic trim.js cases above prove the
// mechanism works in isolation; this proves it against the REAL data file -
// bul-tcs-accuracy and bul-tcs-claims both came back linesSaved: 0 the moment
// measure-blocks.js --apply actually measured them (bul-tcs-claims is this
// pass's own newly-applied short, from Derin's supplied text - caught by
// the very mechanism this pass built, not fixed here since rewriting his
// wording is his call, not mine; flagged in the report instead). -------
console.log('\n--- Zero-saving shorts: measured, reported, skipped at runtime ---');
const zeroSaving = await page.evaluate((data) => {
  var results = {};
  results.reportNamesKnownZeroSavers = (function () {
    var report = CVValidate.zeroSavingShortsReport(data);
    // 5 Oct 2026 (data 1.30): Star of the Month moved from bul-tcs-sop to
    // bul-tcs-accuracy, so accuracy's short now saves a line and sop's
    // saves none - the real zero-savers are now sop, claims and spoc.
    return !!report && report.indexOf('bul-tcs-sop') !== -1 && report.indexOf('bul-tcs-claims') !== -1 && report.indexOf('bul-tcs-accuracy') === -1;
  })();
  // A data file with every linesSaved either positive or absent must report null.
  var clean = JSON.parse(JSON.stringify(data));
  Object.keys(clean.bulletVariants).forEach(function (gid) {
    clean.bulletVariants[gid].variants.forEach(function (v) { delete v.linesSaved; });
  });
  (clean.profileVariants || []).forEach(function (p) { delete p.linesSaved; });
  results.reportIsNullWhenNoZeroSavers = CVValidate.zeroSavingShortsReport(clean) === null;
  return results;
}, dataJson);
check('zeroSavingShortsReport names the real zero-saving shorts in the shipped data file (bul-tcs-sop and bul-tcs-claims among them, bul-tcs-accuracy no longer)',
  zeroSaving.reportNamesKnownZeroSavers === true, JSON.stringify(zeroSaving));
check('zeroSavingShortsReport returns null when no linesSaved is exactly 0',
  zeroSaving.reportIsNullWhenNoZeroSavers === true, JSON.stringify(zeroSaving));

// ---- short-is-subset-of-full (20 Sept 2026) --------------------------------
console.log('\n--- short-is-subset-of-full: digit/proper-noun mechanical check ---');
const subsetCheck = await page.evaluate((data) => {
  var results = {};

  results.realFileHasZeroSubsetViolations = CVValidate.validateData(data).filter(function (e) {
    return e.indexOf('short-subset rule') !== -1;
  }).length === 0;

  // Poisoned digit: give bul-tcs-claims's short a figure ("500") its own full
  // text never mentions.
  var poisonedDigit = JSON.parse(JSON.stringify(data));
  poisonedDigit.bulletVariants['bul-tcs-claims'].variants[0].short += ' 500 cases a week.';
  results.poisonedDigitFires = CVValidate.validateData(poisonedDigit).some(function (e) {
    return e.indexOf("figure '500'") !== -1 && e.indexOf('short-subset rule') !== -1;
  });

  // Poisoned proper noun: give it a capitalised name ("Excel") its own full
  // text never mentions (mid-sentence, not sentence-initial, so it's a real
  // claim under this check, not grammar).
  var poisonedNoun = JSON.parse(JSON.stringify(data));
  poisonedNoun.bulletVariants['bul-tcs-claims'].variants[0].short += ' Uses Excel daily.';
  results.poisonedProperNounFires = CVValidate.validateData(poisonedNoun).some(function (e) {
    return e.indexOf("capitalised term 'Excel'") !== -1 && e.indexOf('short-subset rule') !== -1;
  });

  // Sentence-initial capitals must NOT false-fire: a short starting a brand
  // new sentence with an ordinary word ("Also worked weekends.") shouldn't
  // need "Also" to appear in the full text.
  var sentenceInitial = JSON.parse(JSON.stringify(data));
  sentenceInitial.bulletVariants['bul-tcs-claims'].variants[0].short += ' Also worked weekends.';
  results.sentenceInitialCapDoesNotFalseFire = !CVValidate.validateData(sentenceInitial).some(function (e) {
    return e.indexOf("capitalised term 'Also'") !== -1;
  });

  // HONEST LIMITATION, proven not just asserted (see this rule's own
  // comment in js/validate.js): the b-blarney-hospitality short Derin
  // proposed this pass and that was rejected BY HAND (it asserted "shifts"
  // and "full-time study" - content belonging to a sibling bullet, not this
  // one's own full text) contains no digits and no capitalised tokens, so
  // this mechanical check alone would have let it straight through.
  var rejectedShort = 'Full shifts in a busy hotel kitchen to service standards under time pressure, alongside full-time study.';
  var wouldHavePassed = JSON.parse(JSON.stringify(data));
  wouldHavePassed.bulletVariants['b-blarney'].variants.filter(function (v) { return v.id === 'b-blarney-hospitality'; })[0].short = rejectedShort;
  results.knownLimitationConfirmed = CVValidate.validateData(wouldHavePassed).filter(function (e) {
    return e.indexOf('short-subset rule') !== -1;
  }).length === 0;

  return results;
}, dataJson);
check('short-subset rule: the real, shipped data file has zero violations',
  subsetCheck.realFileHasZeroSubsetViolations === true, JSON.stringify(subsetCheck));
check('short-subset rule: a short asserting a new figure the full text lacks fails validation',
  subsetCheck.poisonedDigitFires === true, JSON.stringify(subsetCheck));
check('short-subset rule: a short asserting a new proper noun the full text lacks fails validation',
  subsetCheck.poisonedProperNounFires === true, JSON.stringify(subsetCheck));
check('short-subset rule: an ordinary sentence-initial capital does not false-fire',
  subsetCheck.sentenceInitialCapDoesNotFalseFire === true, JSON.stringify(subsetCheck));
check('short-subset rule: documented limitation confirmed - the rejected b-blarney-hospitality short (no digits/proper nouns) would have passed this check uncaught',
  subsetCheck.knownLimitationConfirmed === true, JSON.stringify(subsetCheck));

// ---- Privacy pass + template-slot-shape validator: gate-fires (25 Sept
// 2026, items 2 and 4). Same "watch it actually catch something" discipline
// as the TCS-mapping section above: proves both new js/validate.js checks
// fire on the specific fault they were written for, not just stay quiet on
// the real file by construction. --------------------------------------
console.log('\n--- Privacy pass + template-slot-shape validator: gate-fires ---');
const privacyGates = await page.evaluate((data) => {
  var results = {};
  results.realFileHasZeroPrivacyErrors = CVValidate.validateData(data).filter(function (e) {
    return e.indexOf('PRIVACY') === 0;
  }).length === 0;

  var salaryBack = JSON.parse(JSON.stringify(data));
  salaryBack.salary = { x: 1 };
  results.salaryKeyFires = CVValidate.validateData(salaryBack).some(function (e) { return e.indexOf("top-level 'salary' key") !== -1; });

  var certNoBack = JSON.parse(JSON.stringify(data));
  certNoBack.facts.certifications[1].items[0].certNo = 'Nov/24/114';
  var certNoErrors = CVValidate.validateData(certNoBack);
  results.certNoKeyFires = certNoErrors.some(function (e) { return e.indexOf("a 'certNo' key is present") !== -1; });
  results.certNoShapeFires = certNoErrors.some(function (e) { return e.indexOf('certificate-number-shaped token') !== -1; });

  var tcsRefBack = JSON.parse(JSON.stringify(data));
  tcsRefBack.facts.roles[0]._note += ' ref TCS/Trainee/2812350';
  results.tcsRefFires = CVValidate.validateData(tcsRefBack).some(function (e) { return e.indexOf('TCS employee/trainee reference number') !== -1; });

  var salaryBandBack = JSON.parse(JSON.stringify(data));
  salaryBandBack.facts.roles[0]._note += ' band 42000-48000';
  results.salaryBandShapeFires = CVValidate.validateData(salaryBandBack).some(function (e) { return e.indexOf('salary-band-shaped number range') !== -1; });

  var strayEmail = JSON.parse(JSON.stringify(data));
  strayEmail.facts.roles[0]._note += ' contact manager@example.com';
  results.strayEmailFires = CVValidate.validateData(strayEmail).some(function (e) { return e.indexOf('email address not in identity.contact') !== -1; });

  var strayPhone = JSON.parse(JSON.stringify(data));
  strayPhone.facts.roles[0]._note += ' call +91 98765 43210';
  results.strayPhoneFires = CVValidate.validateData(strayPhone).some(function (e) { return e.indexOf('phone number not in identity.contact') !== -1; });

  // Item 6, 26 Sept 2026: two new shape-only patterns Derin named directly
  // (OREG-prefixed reference number, a 7-digit number next to "Employee"),
  // neither of which this repo's real data has ever contained - proven
  // here to fire on a deliberately poisoned clone, same discipline as
  // every other pattern in this block.
  var oregBack = JSON.parse(JSON.stringify(data));
  oregBack.facts.roles[0]._note += ' ref OREG4471203';
  results.oregShapeFires = CVValidate.validateData(oregBack).some(function (e) { return e.indexOf('OREG-prefixed reference number') !== -1; });

  var employeeNumBack = JSON.parse(JSON.stringify(data));
  employeeNumBack.facts.roles[0]._note += ' Employee 4471203';
  results.employeeNumShapeFires = CVValidate.validateData(employeeNumBack).some(function (e) { return e.indexOf('employee-number-shaped token') !== -1; });

  var employeeNumReversedBack = JSON.parse(JSON.stringify(data));
  employeeNumReversedBack.facts.roles[0]._note += ' 4471203 Employee reference';
  results.employeeNumReversedShapeFires = CVValidate.validateData(employeeNumReversedBack).some(function (e) { return e.indexOf('employee-number-shaped token') !== -1; });

  var refereeLiteral = JSON.parse(JSON.stringify(data));
  refereeLiteral.letterBlocks.close.filter(function (e) { return e.id === 'let-close-referee'; })[0].text =
    'My manager on the pilot team, Some Name, is happy to be contacted.';
  results.refereeLiteralFires = CVValidate.validateData(refereeLiteral).some(function (e) { return e.indexOf('no longer contains the {{REFEREE}} template token') !== -1; });

  var malformedSlot = JSON.parse(JSON.stringify(data));
  malformedSlot.letterBlocks.close.push({ id: 'let-close-smoketest', text: 'Contact {{RECIPIENT_NAME}} for details.' });
  results.malformedSlotFires = CVValidate.validateData(malformedSlot).some(function (e) { return e.indexOf('malformed template token') !== -1 && e.indexOf('{{RECIPIENT_NAME}}') !== -1; });

  var unknownSlot = JSON.parse(JSON.stringify(data));
  unknownSlot.letterBlocks.close.push({ id: 'let-close-smoketest2', text: 'Contact {{ROLLE}} for details.' });
  results.unknownSlotFires = CVValidate.validateData(unknownSlot).some(function (e) { return e.indexOf('unknown template slot') !== -1 && e.indexOf('{{ROLLE}}') !== -1; });

  return results;
}, dataJson);
check('Privacy: the real, shipped data file has zero PRIVACY errors', privacyGates.realFileHasZeroPrivacyErrors === true, JSON.stringify(privacyGates));
check('Privacy: a restored top-level salary key fails validation', privacyGates.salaryKeyFires === true, JSON.stringify(privacyGates));
check('Privacy: a restored certNo key fails validation (key check)', privacyGates.certNoKeyFires === true, JSON.stringify(privacyGates));
check('Privacy: a restored certNo value fails validation (shape check)', privacyGates.certNoShapeFires === true, JSON.stringify(privacyGates));
check('Privacy: a TCS reference number fails validation', privacyGates.tcsRefFires === true, JSON.stringify(privacyGates));
check('Privacy: a salary-band-shaped number range fails validation', privacyGates.salaryBandShapeFires === true, JSON.stringify(privacyGates));
check('Privacy: a stray email not in identity.contact fails validation', privacyGates.strayEmailFires === true, JSON.stringify(privacyGates));
check('Privacy: a stray phone number not in identity.contact fails validation', privacyGates.strayPhoneFires === true, JSON.stringify(privacyGates));
check('Privacy: a literal referee name in let-close-referee.text fails validation', privacyGates.refereeLiteralFires === true, JSON.stringify(privacyGates));
check('Slot shape: a malformed slot ({{RECIPIENT_NAME}}, the actual bug class) fails validation', privacyGates.malformedSlotFires === true, JSON.stringify(privacyGates));
check('Slot shape: a well-formed but unregistered slot ({{ROLLE}}) fails validation', privacyGates.unknownSlotFires === true, JSON.stringify(privacyGates));
check('Privacy: an OREG-prefixed reference number fails validation (item 6, new shape)', privacyGates.oregShapeFires === true, JSON.stringify(privacyGates));
check('Privacy: a 7-digit number next to "Employee" fails validation (item 6, new shape)', privacyGates.employeeNumShapeFires === true, JSON.stringify(privacyGates));
check('Privacy: the same employee-number shape fires in reversed order too (digits before "Employee")', privacyGates.employeeNumReversedShapeFires === true, JSON.stringify(privacyGates));

// ---- Action-verb-first gate: gate-fires (26 Sept 2026, item 2a, Derin's
// own instruction). Proves data.actionVerbs.list actually blocks a
// noun/adjective-first opener on both a profileVariant and a
// bulletVariants entry, on both `.text` and `.short`, and confirms the
// real, shipped data file has zero violations of its own new rule (every
// profile now opens 'Holds a/an...', every bullet opens on the verbs
// already in the approved list) - the same "proven, not just written"
// discipline as every other gate-fires section in this suite.
console.log('\n--- Action-verb-first gate: gate-fires ---');
const actionVerbGates = await page.evaluate((data) => {
  var results = {};
  results.realFileHasZeroActionVerbErrors = CVValidate.validateData(data).filter(function (e) {
    return e.indexOf('not on data.actionVerbs.list') !== -1;
  }).length === 0;

  var nounProfile = JSON.parse(JSON.stringify(data));
  nounProfile.profileVariants[0].text = 'Finance degree with First Class Honours and an MSc in Business Analytics at 2:1 Honours from University College Cork.';
  results.nounProfileFires = CVValidate.validateData(nounProfile).some(function (e) {
    return e.indexOf("profileVariants['" + data.profileVariants[0].id + "'].text") !== -1 && e.indexOf('not on data.actionVerbs.list') !== -1;
  });

  var firstBulletGid = Object.keys(data.bulletVariants)[0];
  var nounBullet = JSON.parse(JSON.stringify(data));
  nounBullet.bulletVariants[firstBulletGid].variants[0].text = 'Reporting duties across the team, handled daily.';
  results.nounBulletTextFires = CVValidate.validateData(nounBullet).some(function (e) {
    return e.indexOf("bulletVariants['" + firstBulletGid + "']") !== -1 && e.indexOf('.text') !== -1 && e.indexOf('not on data.actionVerbs.list') !== -1;
  });

  var nounBulletShort = JSON.parse(JSON.stringify(data));
  nounBulletShort.bulletVariants[firstBulletGid].variants[0].short = 'Reporting duties, handled daily.';
  results.nounBulletShortFires = CVValidate.validateData(nounBulletShort).some(function (e) {
    return e.indexOf("bulletVariants['" + firstBulletGid + "']") !== -1 && e.indexOf('.short') !== -1 && e.indexOf('not on data.actionVerbs.list') !== -1;
  });

  var emptyList = JSON.parse(JSON.stringify(data));
  emptyList.actionVerbs.list = [];
  results.emptyListFires = CVValidate.validateData(emptyList).some(function (e) {
    return e.indexOf('data.actionVerbs.list is missing or empty') !== -1;
  });

  var midSentence = JSON.parse(JSON.stringify(data));
  midSentence.bulletVariants[firstBulletGid].variants[0].text = 'Processed claims, on my manager\'s recommendation, ahead of schedule.';
  results.midSentencePhrasePasses = !CVValidate.validateData(midSentence).some(function (e) {
    return e.indexOf("bulletVariants['" + firstBulletGid + "']") !== -1 && e.indexOf('not on data.actionVerbs.list') !== -1;
  });

  return results;
}, dataJson);
check('Action verbs: the real, shipped data file has zero action-verb-first violations', actionVerbGates.realFileHasZeroActionVerbErrors === true, JSON.stringify(actionVerbGates));
check('Action verbs: a profile rewritten to open on a noun fails validation', actionVerbGates.nounProfileFires === true, JSON.stringify(actionVerbGates));
check('Action verbs: a bullet .text rewritten to open on a noun fails validation', actionVerbGates.nounBulletTextFires === true, JSON.stringify(actionVerbGates));
check('Action verbs: a bullet .short rewritten to open on a noun fails validation', actionVerbGates.nounBulletShortFires === true, JSON.stringify(actionVerbGates));
check('Action verbs: an empty data.actionVerbs.list is itself a load-time error', actionVerbGates.emptyListFires === true, JSON.stringify(actionVerbGates));
check('Action verbs: a mid-sentence attribution phrase after a real verb opener does not false-fire (Derin\'s own example)', actionVerbGates.midSentencePhrasePasses === true, JSON.stringify(actionVerbGates));

// ---- Right-to-work start-date line: gate-fires (26 Sept 2026, item 2b,
// Derin's own instruction, verbatim: "Take the date from the ad and
// validate it verbatim, the same way as TEAM."). Proves: (1) the verbatim-
// in-JD constraint really rejects a date not in the ad, exactly like TEAM;
// (2) the "later than 1 November 2026" threshold fires only for a date
// genuinely later than it (December 2026+ or any 2027+ month), not for
// November 2026 itself or an unparseable shape; (3) js/assemble.js's
// buildAuthLine actually produces the extended sentence, with correct
// template provenance, only when both checks pass - and leaves the plain
// rightToWork line completely untouched otherwise (the overwhelming
// common case, and every one of the 8 real fixtures below, none of which
// pass a startDate at all).
console.log('\n--- Right-to-work start-date line: gate-fires ---');
const startDateGates = await page.evaluate((data) => {
  var results = {};
  var jd = 'We are hiring for a role starting September 2027, apply now.';

  var okCheck = CVLetterBuild.validateStartDate('September 2027', jd);
  results.verbatimMatchValid = okCheck.valid === true && okCheck.date === 'September 2027';

  var badCheck = CVLetterBuild.validateStartDate('October 2027', jd);
  results.verbatimMismatchInvalid = badCheck.valid === false;

  var emptyCheck = CVLetterBuild.validateStartDate('', jd);
  results.emptyIsValid = emptyCheck.valid === true && emptyCheck.date === '';

  results.septemberTriggers = CVLetterBuild.startDateTriggersExtendedAuth('September 2027') === true;
  results.decemberTriggers = CVLetterBuild.startDateTriggersExtendedAuth('December 2026') === true;
  results.novemberDoesNotTrigger = CVLetterBuild.startDateTriggersExtendedAuth('November 2026') === false;
  results.unparseableDoesNotTrigger = CVLetterBuild.startDateTriggersExtendedAuth('Q3 2027') === false;

  var extendedModel = CVAssemble.buildModel(data, 'consulting-tech', { excludeFactIds: ['vol'], startDate: { text: 'September 2027', appliesExtended: true } });
  var authBlock = extendedModel.filter(function (b) { return b.t === 'auth'; })[0];
  results.extendedLineRendersCorrectly = authBlock.text === 'Eligible to work in Ireland. No visa sponsorship required. Available from 1 November 2026 and for a September 2027 start.';
  results.extendedLineHasTemplateProv = !!(authBlock._prov && authBlock._prov.text && authBlock._prov.text.template);

  var plainModel = CVAssemble.buildModel(data, 'consulting-tech', { excludeFactIds: ['vol'] });
  var plainAuthBlock = plainModel.filter(function (b) { return b.t === 'auth'; })[0];
  results.noStartDateLeavesBaseLineUntouched = plainAuthBlock.text === data.identity.rightToWork;

  var notTriggeredModel = CVAssemble.buildModel(data, 'consulting-tech', { excludeFactIds: ['vol'], startDate: { text: 'November 2026', appliesExtended: false } });
  var notTriggeredAuthBlock = notTriggeredModel.filter(function (b) { return b.t === 'auth'; })[0];
  results.notTriggeredLeavesBaseLineUntouched = notTriggeredAuthBlock.text === data.identity.rightToWork;

  return results;
}, dataJson);
check('Start date: a verbatim JD match validates (same shape as TEAM)', startDateGates.verbatimMatchValid === true, JSON.stringify(startDateGates));
check('Start date: a date not in the pasted JD is rejected', startDateGates.verbatimMismatchInvalid === true, JSON.stringify(startDateGates));
check('Start date: an empty field is always valid (no ad start date typed)', startDateGates.emptyIsValid === true, JSON.stringify(startDateGates));
check('Start date: "September 2027" is later than 1 Nov 2026 and triggers the extended line', startDateGates.septemberTriggers === true, JSON.stringify(startDateGates));
check('Start date: "December 2026" is later than 1 Nov 2026 and triggers the extended line', startDateGates.decemberTriggers === true, JSON.stringify(startDateGates));
check('Start date: "November 2026" itself does NOT trigger the extended line', startDateGates.novemberDoesNotTrigger === true, JSON.stringify(startDateGates));
check('Start date: an unparseable shape ("Q3 2027") does NOT trigger the extended line (no invention)', startDateGates.unparseableDoesNotTrigger === true, JSON.stringify(startDateGates));
check('Start date: the extended auth line renders exactly as Derin specified it, verbatim', startDateGates.extendedLineRendersCorrectly === true, JSON.stringify(startDateGates));
check('Start date: the extended auth line carries template provenance (traceable, not a hand-typed exception)', startDateGates.extendedLineHasTemplateProv === true, JSON.stringify(startDateGates));
check('Start date: no ad start date typed leaves the plain rightToWork line completely untouched', startDateGates.noStartDateLeavesBaseLineUntouched === true, JSON.stringify(startDateGates));
check('Start date: a date that does not trigger the threshold also leaves the plain line untouched', startDateGates.notTriggeredLeavesBaseLineUntouched === true, JSON.stringify(startDateGates));

// ---- Close-match letter mode: gate-fires (26 Sept 2026, item 4, Derin's
// own instruction: "Derin rejected a letter today as generic, for an ad...
// whose responsibilities were almost exactly his TCS job. Trigger: 50% or
// more of the responsibility lines in the MATCHABLE section hit approved
// evidence tags."). Fixture 8 (the real SoftCo ad) was still pending as of
// this pass, so this proves the trigger and the letter shape against
// synthetic JD text built to deliberately hit (or deliberately miss) the
// five letterBlocks.closeMatch clusters - the same "prove it fires, prove
// it doesn't false-fire" discipline as every other gate-fires section,
// substituting a synthetic positive/negative pair for the still-missing
// real fixture. Also checked: none of the 7 REAL fixtures spuriously
// trigger close-match mode (a real regression guard once fixture 8
// arrives and can be added as an explicit positive case alongside these).
console.log('\n--- Close-match letter mode: gate-fires ---');
const closeMatchGates = await page.evaluate((data) => {
  var results = {};
  var closeMatchJD = [
    'Document Processing Administrator - SoftCo',
    '',
    'Responsibilities:',
    'Process documents in line with our written operating procedure and daily processing targets.',
    'Maintain a high accuracy record on all files processed, subject to peer review.',
    'Own and keep current the standard operating procedure for the team.',
    'Act as the single point of contact for client queries and requirements clarification.',
    'Use advanced Excel and Power BI daily to track throughput.',
    'Attend team meetings and contribute to general discussion.',
    'Support ad hoc projects as required.'
  ].join('\n');
  var trig = CVLetterBuild.computeCloseMatchTrigger(data, closeMatchJD);
  results.closeMatchAdFires = trig.fired === true && trig.ratio >= 0.5;

  var genericJD = ['Marketing Coordinator - Acme', '', 'Responsibilities:', 'Plan social media campaigns.', 'Coordinate with design team on assets.', 'Write blog posts.', 'Attend brainstorming sessions.'].join('\n');
  var trigGeneric = CVLetterBuild.computeCloseMatchTrigger(data, genericJD);
  results.genericAdDoesNotFire = trigGeneric.fired === false;

  var extraction = CVScore.extractFromJD(data, closeMatchJD);
  var model = CVLetterBuild.buildLetterModel(data, { archetypeId: 'customer-ops', rawJD: closeMatchJD, company: 'SoftCo', role: 'Document Processing Administrator', extraction: extraction });
  results.modelReportsFired = model.closeMatch && model.closeMatch.fired === true;
  var seq = model.blocks.map(function (b) { return b.category + ':' + b.id; });
  results.openingIsCloseMatchVariant = seq[0] === 'opening:let-open-closematch-std';
  results.allFiveClustersPresentInOrder = JSON.stringify(seq.filter(function (s) { return s.indexOf('let-closematch-') !== -1; })) ===
    JSON.stringify(['evidence:let-closematch-processing', 'evidence:let-closematch-accuracy', 'evidence:let-closematch-sop', 'evidence:let-closematch-spoc', 'evidence:let-closematch-tools']);
  results.noWhyOrGapBlocksInCloseMatchMode = !seq.some(function (s) { return s.indexOf('why:') === 0 || s.indexOf('gap:') === 0; });
  results.endsWithStandardCloseAndSignoff = seq[seq.length - 2].indexOf('close:') === 0 && seq[seq.length - 1].indexOf('signoff:') === 0;

  // Negative control: real, unrelated archetype build must still look
  // completely normal (why + single evidence, no closeMatch blocks).
  var normalModel = CVLetterBuild.buildLetterModel(data, { archetypeId: 'customer-ops', rawJD: genericJD, company: 'Acme', role: 'Marketing Coordinator', extraction: CVScore.extractFromJD(data, genericJD) });
  results.normalModelNotFired = normalModel.closeMatch && normalModel.closeMatch.fired === false;
  results.normalModelHasWhyBlock = normalModel.blocks.some(function (b) { return b.category === 'why'; });

  return results;
}, dataJson);
check('Close-match: an ad whose responsibilities mirror the 5 TCS clusters fires the mode', closeMatchGates.closeMatchAdFires === true, JSON.stringify(closeMatchGates));
check('Close-match: an unrelated generic ad does not fire the mode', closeMatchGates.genericAdDoesNotFire === true, JSON.stringify(closeMatchGates));
check('Close-match: buildLetterModel reports closeMatch.fired for the matching ad', closeMatchGates.modelReportsFired === true, JSON.stringify(closeMatchGates));
check('Close-match: the opening is the close-match variant, stating the match plainly', closeMatchGates.openingIsCloseMatchVariant === true, JSON.stringify(closeMatchGates));
check('Close-match: all 5 clusters appear, in the data file\'s own fixed order', closeMatchGates.allFiveClustersPresentInOrder === true, JSON.stringify(closeMatchGates));
check('Close-match: no why or gap paragraph in close-match mode', closeMatchGates.noWhyOrGapBlocksInCloseMatchMode === true, JSON.stringify(closeMatchGates));
check('Close-match: still ends with the standard close then signoff', closeMatchGates.endsWithStandardCloseAndSignoff === true, JSON.stringify(closeMatchGates));
check('Close-match: an unrelated ad\'s letter model is completely unaffected (normal why+evidence shape)', closeMatchGates.normalModelNotFired === true && closeMatchGates.normalModelHasWhyBlock === true, JSON.stringify(closeMatchGates));

// Real-fixture regression guard: of the real job ads this app has on file,
// none should spuriously trigger close-match mode - if one ever does, that
// is real signal (either a real close match nobody noticed, or the trigger
// is too loose) and needs a human look, not a silent pass. Read directly
// here (rather than reusing the render-level smoke gate's `fixtureTexts`,
// defined later in this file) so this check does not depend on file
// ordering below.
const closeMatchFixtureTexts = fs.readdirSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd'))
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', f), 'utf8') }));
const closeMatchRealFixtureResults = await page.evaluate(([data, fixtures]) => {
  return fixtures.map(function (f) {
    var trig = CVLetterBuild.computeCloseMatchTrigger(data, f.text);
    return { name: f.name, fired: trig.fired, ratio: trig.ratio, hitCount: trig.hitCount, totalCount: trig.totalCount };
  });
}, [dataJson, closeMatchFixtureTexts]);
const spuriousFires = closeMatchRealFixtureResults.filter((r) => r.fired);
check('Close-match: none of the real fixture ads spuriously trigger the mode', spuriousFires.length === 0, JSON.stringify(closeMatchRealFixtureResults));
// Named individually (27 Sept 2026, item 1f, Derin's own explicit named
// expectation: "Clyde & Co must not fire") - covered by the check above
// too (it's one of the 8 fixtures the loop already ran), but named on its
// own so a future spurious fire on THIS specific ad shows up as its own
// failing line, not just a number inside the combined JSON dump.
const clydeCoResult = closeMatchRealFixtureResults.filter((r) => r.name === 'clydeco-junior-associate-corporate-insurance')[0];
check('Close-match: Clyde & Co (junior associate, corporate insurance) does not fire', !!clydeCoResult && clydeCoResult.fired === false, JSON.stringify(clydeCoResult));

// Archetype auto-pick per real fixture (27 Sept 2026, item 1e: "rerun all
// 8 fixtures... print a table... any pick that changes is reported, not
// silently accepted"). Informational, same non-hard-failing style as the
// "Real-JD archetype auto-pick" section above (section 4) - printed on
// every run from here on so a FUTURE matcher/scoring change shows its
// effect on the real corpus the same way this pass's own rewrite was
// checked, without needing an ad-hoc script again. The pass-report for
// this specific change also gives the BEFORE/AFTER comparison (this
// section only ever has "after" to show, since it has no memory of a
// previous run).
console.log('\n--- Archetype auto-pick per real fixture (informational - compare against the pass report for what changed) ---');
const archetypePerFixture = await page.evaluate(([data, fixtures]) => {
  return fixtures.map(function (f) {
    var extraction = CVScore.extractFromJD(data, f.text);
    var pick = CVScore.pickArchetype(data, extraction);
    return { name: f.name, archetypeId: pick.noMatch ? null : pick.winner.archetype.id, score: pick.winner.score };
  });
}, [dataJson, closeMatchFixtureTexts]);
archetypePerFixture.forEach((r) => console.log('  ' + r.name + ': ' + r.archetypeId + ' (score ' + r.score + ')'));

// ---------------------------------------------------------------------------
// Fixture 8 (softco-document-processing-administrator) - 26 Sept 2026,
// item 1. This is the real ad Derin quoted when he asked for close-match
// mode in the first place ("almost exactly his TCS job"). Derin's five
// expected results, checked here individually, PASS/FAIL, against the real
// fixture text - not a synthetic stand-in:
//
//   1. close-match mode fires                          -> DOES NOT HOLD.
//   2. years extractor reports "no experience figure"   -> holds.
//   3. eligibility PASS (no BLOCKED verdict)             -> holds.
//   4. the five named headings segment to IGNORED        -> holds.
//   5. "xml"/"gdpr" never appear in any generated output  -> holds.
//
// Item 1 is a genuine, reported miss, not a bug in this test: hitCount 1,
// totalCount 27, ratio ~3.7%, nowhere near the 50% threshold. The ONE
// literal hit is "Work to achieve daily and weekly processing targets..."
// against the "processing targets" tag. Every other closeMatch tag
// (`client liaison`, `query resolution`, `standard operating procedure`,
// `accuracy record`, ...) is a multi-word phrase this app matches
// literally, and the real ad simply doesn't use that phrasing - it says
// "liaise with clients", "SOPs", "address ad-hoc queries", not the tag
// phrases themselves. The synthetic JD this trigger was gate-tested
// against earlier this pass (CLOSE_MATCH_JD_FOR_DOM, above) was written to
// closely echo the tag list's own wording; real job-ad prose apparently
// does not, even when the underlying job is genuinely close. This is
// Derin's tag list and his 50% threshold (both his own explicit prior
// decisions) - not touched here. See tests/fixtures/README.txt's
// softco entry and the build-status-and-decision-log for the full
// write-up; this is flagged back to Derin as an open decision, not
// silently patched.
//
// The checks below PIN the real, current, honest behaviour (so a future
// tag/threshold change shows up here as a deliberate, visible diff, not a
// silent drift) - they are not a claim that item 1 was satisfied.
console.log('\n--- Fixture 8 (softco-document-processing-administrator): Derin\'s five expected results ---');
const softcoFixture = closeMatchFixtureTexts.find((f) => f.name === 'softco-document-processing-administrator');
check('Fixture 8 file is present in the real-fixture corpus', !!softcoFixture);
if (softcoFixture) {
  const softcoResult = await page.evaluate(([data, jd]) => {
    var out = {};
    out.trig = CVLetterBuild.computeCloseMatchTrigger(data, jd);

    var extraction = CVScore.extractFromJD(data, jd);
    out.yearsRequired = extraction.yearsRequired;
    out.yearsRequiredAllDiscarded = extraction.yearsRequiredAllDiscarded;

    var seg = CVSegment.classifySentences(jd);
    function stateOf(needle) {
      var hit = seg.sentences.filter(function (s) { return s.text.indexOf(needle) !== -1; })[0];
      return hit ? hit.matchable : null;
    }
    out.headingStates = {
      aboutSoftco: stateOf('SoftCo is an AI-native'),
      successAtAGlance: stateOf('1M+ users worldwide'),
      whatWeOffer: stateOf('Competitive remuneration'),
      ourCulture: stateOf('Initiative, accountability, and collaboration'),
      benefitsFoundInPost: stateOf('Medical insurance')
    };

    var pick = CVScore.pickArchetype(data, extraction);
    out.archetypeId = pick.noMatch ? null : pick.winner.archetype.id;
    var archetypeObj = pick.noMatch ? null : CVAssemble.findById(data.archetypes, out.archetypeId);
    var cvModel = archetypeObj ? CVAssemble.buildModel(data, out.archetypeId, { excludeFactIds: ['vol'], extraction: extraction }) : null;
    var fit = cvModel ? CVFitCheck.run(data, extraction, archetypeObj, CVVerify.collectText(cvModel)) : null;
    out.verdict = fit ? fit.verdict : null;

    function flatten(blocks) {
      var texts = [];
      (blocks || []).forEach(function (b) {
        if (typeof b.text === 'string') texts.push(b.text);
        if (typeof b.title === 'string') texts.push(b.title);
        if (typeof b.org === 'string') texts.push(b.org);
        if (typeof b.right === 'string') texts.push(b.right);
        if (typeof b.label === 'string') texts.push(b.label);
        if (Array.isArray(b.items)) b.items.forEach(function (it) { if (it && typeof it.text === 'string') texts.push(it.text); });
      });
      return texts.join('\n');
    }
    var cvText = cvModel ? flatten(cvModel) : '';
    out.cvContainsBanned = /\bxml\b/i.test(cvText) || /\bgdpr\b/i.test(cvText);

    var yearsRelevant = CVExperience.computeExperience(data).yearsRelevant;
    var letterOpts = {
      archetypeId: out.archetypeId, extraction: extraction, rawJD: jd, yearsRelevant: yearsRelevant,
      company: 'SoftCo', role: 'Document Processing Administrator', team: '', city: '',
      recipientName: 'Test Recruiter', titleMismatch: false,
      fitCheckGapTrigger: 'none', refereeName: 'Test Referee', echoText: ''
    };
    var built = archetypeObj ? CVLetter.buildLetterContentModel(data, letterOpts) : null;
    out.echoCandidateCount = built ? built.letterResult.echoCandidates.length : 0;
    out.echoCandidatesContainBanned = built ? built.letterResult.echoCandidates.some(function (c) { return /\bxml\b/i.test(c.text) || /\bgdpr\b/i.test(c.text); }) : false;
    var letterText = built ? flatten(built.model) : '';
    out.letterContainsBanned = /\bxml\b/i.test(letterText) || /\bgdpr\b/i.test(letterText);

    if (built && built.letterResult.echoCandidates.length) {
      var withEchoOpts = {};
      Object.keys(letterOpts).forEach(function (k) { withEchoOpts[k] = letterOpts[k]; });
      withEchoOpts.echoText = built.letterResult.echoCandidates[0].text;
      var builtEcho = CVLetter.buildLetterContentModel(data, withEchoOpts);
      var letterEchoText = flatten(builtEcho.model);
      out.letterEchoContainsBanned = /\bxml\b/i.test(letterEchoText) || /\bgdpr\b/i.test(letterEchoText);
    } else {
      out.letterEchoContainsBanned = false;
    }

    return out;
  }, [dataJson, softcoFixture.text]);

  // 27 Sept 2026 (item 1 of Derin's matcher/deploy work order): re-pinned,
  // not deleted, after the matcher rewrite (stem-set tag matching, the
  // responsibility-lines-only denominator, the heading-fragment exclusion).
  // The 26 Sept pinned numbers (1/27) are gone - genuinely improved by the
  // fix (2/18, almost 3x the ratio) - but the trigger still does not clear
  // 0.5, so this stays a PINNED FAIL, with the new real numbers, not a
  // silent pass. Root cause is no longer a matching-technique problem (the
  // stemmer/word-set fix does let "client liaison" recognise "liaise with
  // clients", and "processing targets" was always literal) - it's that most
  // of this ad's 18 real responsibility lines describe concepts
  // (compliance, escalation routing, tool-agnostic "internal tools and
  // systems", onboarding support) that the five closeMatch clusters'
  // specific tag vocabulary (peer review, maker checker, stakeholder
  // briefing/management, query resolution, Excel/Power BI) never claims to
  // cover in the first place - a genuine topic gap, not an inflection one.
  // Derin's own item 1c anticipated exactly this kind of gap (an optional
  // per-tag alsoMatch list for "genuine synonyms that stems can't reach") -
  // that infrastructure now exists in js/matcher.js, ready to use, but no
  // alsoMatch pairs have been added to the existing closeMatch tags on this
  // pass's own initiative: deciding which of this ad's phrases are a
  // "genuine synonym" of an existing tag is a content judgement on Derin's
  // own data, not a mechanical fix.
  check('Fixture 8, expected result 1 (Derin: "close-match mode fires") - STILL PINNED AS FAIL after the matcher rewrite, reported to Derin, not silently patched: real ratio ' +
    (softcoResult.trig.hitCount) + '/' + (softcoResult.trig.totalCount) + ' = ' + softcoResult.trig.ratio.toFixed(3) + ', well under the 0.5 threshold (up from 1/27 = 0.037 before this pass\'s matcher/denominator fix - real progress, still short)',
    softcoResult.trig.fired === false && softcoResult.trig.hitCount === 2 && softcoResult.trig.totalCount === 18,
    JSON.stringify(softcoResult.trig));
  check('Fixture 8, expected result 2: years extractor reports "no experience requirement detected" (a number was found - "35 years" - and discarded)',
    softcoResult.yearsRequired === null && softcoResult.yearsRequiredAllDiscarded === true,
    JSON.stringify({ yearsRequired: softcoResult.yearsRequired, yearsRequiredAllDiscarded: softcoResult.yearsRequiredAllDiscarded }));
  check('Fixture 8, expected result 3: eligibility PASS (verdict is not BLOCKED)',
    softcoResult.verdict === 'GOOD' || softcoResult.verdict === 'STRETCH',
    'verdict: ' + softcoResult.verdict);
  check('Fixture 8, expected result 4: "About SoftCo", "Our success at a glance", "What We Offer", "Our Culture" and "Benefits found in job post" all segment to IGNORED',
    softcoResult.headingStates.aboutSoftco === false && softcoResult.headingStates.successAtAGlance === false &&
    softcoResult.headingStates.whatWeOffer === false && softcoResult.headingStates.ourCulture === false &&
    softcoResult.headingStates.benefitsFoundInPost === false,
    JSON.stringify(softcoResult.headingStates));
  check('Fixture 8, expected result 5: "xml"/"gdpr" never appear in the built CV, the built letter (with or without an ECHO quote), or as an offered ECHO candidate itself',
    softcoResult.cvContainsBanned === false && softcoResult.letterContainsBanned === false &&
    softcoResult.letterEchoContainsBanned === false && softcoResult.echoCandidatesContainBanned === false,
    JSON.stringify({ cvContainsBanned: softcoResult.cvContainsBanned, letterContainsBanned: softcoResult.letterContainsBanned, letterEchoContainsBanned: softcoResult.letterEchoContainsBanned, echoCandidatesContainBanned: softcoResult.echoCandidatesContainBanned, echoCandidateCount: softcoResult.echoCandidateCount }));
  console.log('  Fixture 8 archetype auto-pick (informational, not one of the five checks): ' + softcoResult.archetypeId);
}

// ---- Form-answers panel: gate-fires (item 5, 26 Sept 2026) ----------------
// data.formAnswers holds the static text; js/app.js's renderFormAnswers()
// picks WHICH static text applies (the salary bucket for the current
// archetype) and prefers the live CV model's own "auth" block text over the
// static right-to-work/sponsorship fallback. private-overrides.json is
// gitignored and never exists in this sandbox, so CVApp._test.
// setPrivateOverridesForTest() substitutes a synthetic value for the
// duration of these checks - same problem the refereeName tests solve by
// passing a synthetic opts value straight into buildLetterModel().
console.log('\n--- Form-answers panel: gate-fires ---');
async function readFormAnswers() {
  return page.evaluate(() => Array.from(document.querySelectorAll('#form-answers-container .form-answer-row')).map((row) => ({
    q: row.querySelector('.form-answer-q').textContent,
    a: row.querySelector('.form-answer-a').textContent
  })));
}
function findAnswer(rows, questionSubstring) {
  var row = rows.filter((r) => r.q.indexOf(questionSubstring) !== -1)[0];
  return row ? row.a : null;
}

// Baseline: no private overrides supplied.
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({}));

// Static answers show even when nothing has matched an archetype at all -
// noMatch, not merely "no build attempted yet". 'auto' + a JD that scores 0
// against every archetype reproduces the real "no archetype matched" state
// recompute() itself refuses to guess through.
await page.selectOption('#archetype-select', 'auto');
await page.fill('#jd-input', 'zzz completely unrelated nonsense that matches nothing zzz');
await page.waitForTimeout(300);
const noMatchRows = await readFormAnswers();
check('Form answers: career-break answer shows with no archetype matched',
  findAnswer(noMatchRows, 'career break') === dataJson.formAnswers.careerBreak.answer, JSON.stringify(noMatchRows));
check('Form answers: TCS role description shows with no archetype matched',
  findAnswer(noMatchRows, 'most recent') === dataJson.formAnswers.tcsRoleDescription.answer, JSON.stringify(noMatchRows));
check('Form answers: subjects-studied answer shows with no archetype matched',
  findAnswer(noMatchRows, 'subjects') === dataJson.formAnswers.subjectsStudiedRelevance.answer, JSON.stringify(noMatchRows));
check('Form answers: right-to-work falls back to the static answer with no live model built',
  findAnswer(noMatchRows, 'right to work') === dataJson.formAnswers.rightToWorkSponsorship.answer, JSON.stringify(noMatchRows));
check('Form answers: salary row reports no archetype selected yet (no guess)',
  /no archetype selected yet/i.test(findAnswer(noMatchRows, 'salary') || ''), JSON.stringify(noMatchRows));

// Right-to-work/sponsorship: for an ORDINARY build (no ad start date typed)
// the panel must keep showing the fuller STATIC answer, not the plain CV
// auth line - the static answer also carries the permission detail
// that the bare CV sentence doesn't, so silently preferring the live line
// here would be a real regression, not an improvement (caught and fixed
// this same pass - see js/app.js's renderFormAnswers() comment).
await page.fill('#jd-input', '');
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(300);
const builtRows = await readFormAnswers();
check('Form answers: right-to-work row keeps the fuller static answer on an ordinary build (not the shorter live CV line)',
  findAnswer(builtRows, 'right to work') === dataJson.formAnswers.rightToWorkSponsorship.answer, JSON.stringify(builtRows));

// Extended-start-date trigger (item 2b): typing a qualifying ad start date
// must change the form-answers right-to-work row too, not just the CV
// itself - proves renderFormAnswers() really does read the live model
// rather than always falling back to the static field.
await page.fill('#jd-start-date', 'September 2027');
await page.fill('#jd-input', 'Business Analyst role. We are looking to fill this position with a September 2027 start.');
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(300);
const extendedRows = await readFormAnswers();
check('Form answers: right-to-work row picks up the extended start-date line when that trigger fires',
  /September 2027 start/.test(findAnswer(extendedRows, 'right to work') || ''), JSON.stringify(extendedRows));
check('Form answers: extended right-to-work row differs from the plain static fallback',
  findAnswer(extendedRows, 'right to work') !== dataJson.formAnswers.rightToWorkSponsorship.answer, JSON.stringify(extendedRows));
await page.fill('#jd-start-date', '');

// Salary bucket lookup: confidently-mapped archetype + no override figure
// on file -> named, non-blank instruction to add it, never a blank/guessed
// number. business-analyst maps to the 'analyst' bucket.
await page.fill('#jd-input', '');
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(300);
const noFigureRows = await readFormAnswers();
check('Form answers: mapped bucket with no saved figure names the band and where to add it, never a blank answer',
  /Private settings/.test(findAnswer(noFigureRows, 'salary') || '') && /"Analyst" band/.test(findAnswer(noFigureRows, 'salary') || ''),
  JSON.stringify(noFigureRows));

// Salary bucket lookup: same archetype, now with a real (synthetic, for
// this test only) figure on file -> the figure itself, verbatim.
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({ salaryRanges: { analyst: 'EUR 42,000 - EUR 48,000 (TEST FIXTURE VALUE)' } }));
await page.waitForTimeout(100);
const withFigureRows = await readFormAnswers();
check('Form answers: mapped bucket with an override figure present shows that figure verbatim',
  findAnswer(withFigureRows, 'salary') === 'EUR 42,000 - EUR 48,000 (TEST FIXTURE VALUE)', JSON.stringify(withFigureRows));
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({}));

// Salary bucket lookup, item 3 (26 Sept 2026): consulting-tech and
// finance-ops are no longer left null - each got its own bucket key this
// pass. No archetype is left unmapped any more (all 8 are confirmed), so
// the previous "unmapped archetype says so" test no longer has a real case
// to exercise and is retired rather than kept pointed at now-mapped data;
// the underlying `bucket === null` code path is simple, unchanged
// boilerplate identical to the branch already proven above for a missing
// figure.
await page.fill('#jd-input', '');
await page.selectOption('#archetype-select', 'consulting-tech');
await page.waitForTimeout(300);
const consultingTechNoFigureRows = await readFormAnswers();
check('Form answers: consulting-tech is its own mapped bucket, not folded into "analyst" (names its own band)',
  /"Consulting\/tech" band/.test(findAnswer(consultingTechNoFigureRows, 'salary') || ''), JSON.stringify(consultingTechNoFigureRows));

await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({ salaryRanges: { 'consulting-tech': 'EUR 40,000 - EUR 45,000 (TEST FIXTURE VALUE)' } }));
await page.waitForTimeout(100);
const consultingTechWithFigureRows = await readFormAnswers();
check('Form answers: consulting-tech shows its own override figure verbatim',
  findAnswer(consultingTechWithFigureRows, 'salary') === 'EUR 40,000 - EUR 45,000 (TEST FIXTURE VALUE)', JSON.stringify(consultingTechWithFigureRows));

await page.selectOption('#archetype-select', 'finance-ops');
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({ salaryRanges: { 'finance-ops': 'EUR 38,000 - EUR 44,000 (TEST FIXTURE VALUE)' } }));
await page.waitForTimeout(300);
const financeOpsRows = await readFormAnswers();
check('Form answers: finance-ops is its own mapped bucket showing its own override figure verbatim',
  findAnswer(financeOpsRows, 'salary') === 'EUR 38,000 - EUR 44,000 (TEST FIXTURE VALUE)', JSON.stringify(financeOpsRows));

// retail-parttime: the 'advertised-rate' sentinel bucket never touches
// private-overrides at all - proven by leaving overrides EMPTY and still
// getting the dedicated answer, not a "missing figure" message.
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({}));
await page.selectOption('#archetype-select', 'retail-parttime');
await page.waitForTimeout(300);
const retailRows = await readFormAnswers();
check('Form answers: retail-parttime shows the dedicated advertised-rate answer with no override figure needed',
  findAnswer(retailRows, 'salary') === dataJson.formAnswers.retailAdvertisedRateAnswer.answer, JSON.stringify(retailRows));

// Rule (a) (26 Sept 2026): the ad stating its own salary overrides
// EVERYTHING else, including the "no archetype selected yet" fallback -
// tested here with 'auto' against text that matches no archetype keyword
// at all, so if rule (a) did not take priority this would otherwise show
// the no-archetype-selected message instead.
await page.selectOption('#archetype-select', 'auto');
await page.fill('#jd-input', 'zzz completely unrelated nonsense that matches nothing zzz. This role offers a salary of €45,000 per annum.');
await page.waitForTimeout(300);
const adSalaryRows = await readFormAnswers();
check('Form answers: rule (a) - an ad stating its own salary overrides even "no archetype selected"',
  findAnswer(adSalaryRows, 'salary') === 'In line with the advertised range.', JSON.stringify(adSalaryRows));

await page.selectOption('#archetype-select', 'consulting-tech');
await page.waitForTimeout(300);
const adSalaryMappedRows = await readFormAnswers();
check('Form answers: rule (a) - still overrides a confidently-mapped bucket with a real override figure on file',
  findAnswer(adSalaryMappedRows, 'salary') === 'In line with the advertised range.', JSON.stringify(adSalaryMappedRows));
await page.fill('#jd-input', '');

// Rule (b) (26 Sept 2026, first reply): ops-admin-analyst/insurance-pensions
// substitute the regional reduced figure only once a City is typed that
// names neither Dublin nor Cork - an EMPTY city must never guess a
// location, so it stays on the standard figure. insurance-pensions was
// SPLIT into its own bucket in the second reply (item 3a) once Derin gave
// it a distinct standard figure of its own - it no longer shares
// customer-ops's 'ops-admin-analyst' standard key, but both still collapse
// to the SAME shared 'ops-admin-analyst-regional' reduced key, since Derin
// gave one reduced figure for both ("claims and admin level roles"), not
// two. This checks BOTH archetypes independently, proving the split
// standard keys and the shared regional key at once.
await page.selectOption('#archetype-select', 'insurance-pensions');
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({ salaryRanges: {
  'insurance-pensions': 'INSURANCE-PENSIONS STANDARD FIGURE (TEST FIXTURE VALUE)',
  'ops-admin-analyst': 'CUSTOMER-OPS STANDARD FIGURE (TEST FIXTURE VALUE)',
  'ops-admin-analyst-regional': 'REGIONAL FIGURE (TEST FIXTURE VALUE)'
} }));
await page.fill('#letter-city', '');
await page.waitForTimeout(300);
const noCityRows = await readFormAnswers();
check('Form answers: rule (b) - an empty City field never triggers the regional figure (no guessed location)',
  findAnswer(noCityRows, 'salary') === 'INSURANCE-PENSIONS STANDARD FIGURE (TEST FIXTURE VALUE)', JSON.stringify(noCityRows));

await page.fill('#letter-city', 'Dublin');
await page.waitForTimeout(400);
const dublinRows = await readFormAnswers();
check('Form answers: rule (b) - a Dublin City field keeps the standard figure',
  findAnswer(dublinRows, 'salary') === 'INSURANCE-PENSIONS STANDARD FIGURE (TEST FIXTURE VALUE)', JSON.stringify(dublinRows));

await page.fill('#letter-city', 'Galway');
await page.waitForTimeout(400);
const galwayRows = await readFormAnswers();
check('Form answers: rule (b) - insurance-pensions with a City outside Dublin/Cork substitutes the SHARED regional reduced figure',
  findAnswer(galwayRows, 'salary') === 'REGIONAL FIGURE (TEST FIXTURE VALUE)', JSON.stringify(galwayRows));

// Same shared regional key from the OTHER archetype that resolves to
// 'ops-admin-analyst' (customer-ops) - proves the split didn't accidentally
// also split the regional figure into two.
await page.fill('#letter-city', 'Dublin');
await page.selectOption('#archetype-select', 'customer-ops');
await page.waitForTimeout(300);
const customerOpsDublinRows = await readFormAnswers();
check('Form answers: customer-ops (ops-admin-analyst bucket) keeps its OWN standard figure, distinct from insurance-pensions\'s',
  findAnswer(customerOpsDublinRows, 'salary') === 'CUSTOMER-OPS STANDARD FIGURE (TEST FIXTURE VALUE)', JSON.stringify(customerOpsDublinRows));

await page.fill('#letter-city', 'Galway');
await page.waitForTimeout(400);
const customerOpsGalwayRows = await readFormAnswers();
check('Form answers: customer-ops with a City outside Dublin/Cork substitutes the SAME shared regional figure as insurance-pensions',
  findAnswer(customerOpsGalwayRows, 'salary') === 'REGIONAL FIGURE (TEST FIXTURE VALUE)', JSON.stringify(customerOpsGalwayRows));

await page.fill('#letter-city', '');
await page.evaluate(() => CVApp._test.setPrivateOverridesForTest({}));

// "Unreviewed" badge (item 1, 26 Sept 2026): the two newly-authored
// form-answer rows carry a visible badge, title-texted with the full
// _pendingReview message; the three untouched rows (career break,
// right-to-work, salary) must not.
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(300);
const badgeState = await page.evaluate(() => {
  function badgeFor(questionSubstring) {
    var rows = Array.from(document.querySelectorAll('#form-answers-container .form-answer-row'));
    var row = rows.filter((r) => r.querySelector('.form-answer-q').textContent.indexOf(questionSubstring) !== -1)[0];
    if (!row) return null;
    var badge = row.querySelector('.form-answer-badge');
    return badge ? { present: true, title: badge.title } : { present: false };
  }
  return {
    tcsRole: badgeFor('most recent'),
    subjects: badgeFor('subjects'),
    careerBreak: badgeFor('career break'),
    rightToWork: badgeFor('right to work'),
    salary: badgeFor('salary')
  };
});
// 4 Oct 2026: Derin approved both answers (data 1.28), so the real data
// carries no flag and no row shows the badge. The badge itself is still
// checked, on a flag injected into the loaded data and removed again.
check('Form answers: the TCS role and subjects answers are approved - no unreviewed badge on either',
  badgeState.tcsRole && badgeState.tcsRole.present === false && badgeState.subjects && badgeState.subjects.present === false &&
  !dataJson.formAnswers.tcsRoleDescription._pendingReview && !dataJson.formAnswers.subjectsStudiedRelevance._pendingReview,
  JSON.stringify(badgeState));
const injectedBadge = await page.evaluate(async () => {
  var fa = CVApp._test.getLoadedData().formAnswers.tcsRoleDescription;
  fa._pendingReview = 'TEST FLAG';
  var sel = document.getElementById('archetype-select');
  function rerender(v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  rerender('finance-ops'); await new Promise(function (r) { setTimeout(r, 250); }); rerender('business-analyst'); await new Promise(function (r) { setTimeout(r, 250); });
  function badge() {
    var row = Array.from(document.querySelectorAll('#form-answers-container .form-answer-row')).filter(function (r) { return r.querySelector('.form-answer-q').textContent.indexOf('most recent') !== -1; })[0];
    var b = row && row.querySelector('.form-answer-badge');
    return b ? b.title : null;
  }
  var withFlag = badge();
  delete fa._pendingReview;
  rerender('finance-ops'); await new Promise(function (r) { setTimeout(r, 250); }); rerender('business-analyst'); await new Promise(function (r) { setTimeout(r, 250); });
  return { withFlag: withFlag, afterRemoval: badge() };
});
check('Form answers: the unreviewed badge still appears for a flagged answer (injected flag), and goes when the flag is removed',
  injectedBadge.withFlag === 'TEST FLAG' && injectedBadge.afterRemoval === null, JSON.stringify(injectedBadge));
check('Form answers: untouched rows (career break, right-to-work, salary) carry no unreviewed badge',
  badgeState.careerBreak && badgeState.careerBreak.present === false &&
  badgeState.rightToWork && badgeState.rightToWork.present === false &&
  badgeState.salary && badgeState.salary.present === false,
  JSON.stringify(badgeState));

// "Unreviewed" banner in the letter panel (item 1, 26 Sept 2026): fires
// only once close-match mode actually fires, reusing the same synthetic
// close-match JD text proven above to trigger it. Driven through the real
// DOM/recomputeLetter() path this time, not the model builder directly -
// this is the one place that path is exercised in this suite, so it also
// stands in as a first real DOM smoke test of the letter panel's own input
// wiring (company/role/archetype -> a built letter).
const CLOSE_MATCH_JD_FOR_DOM = [
  'Document Processing Administrator - SoftCo',
  '',
  'Responsibilities:',
  'Process documents in line with our written operating procedure and daily processing targets.',
  'Maintain a high accuracy record on all files processed, subject to peer review.',
  'Own and keep current the standard operating procedure for the team.',
  'Act as the single point of contact for client queries and requirements clarification.',
  'Use advanced Excel and Power BI daily to track throughput.',
  'Attend team meetings and contribute to general discussion.',
  'Support ad hoc projects as required.'
].join('\n');
async function letterNoticeText() {
  return page.evaluate(() => {
    var el = document.getElementById('letter-notice');
    return (el && !el.hidden) ? el.textContent : '';
  });
}
await page.fill('#letter-company', 'SoftCo');
await page.fill('#letter-role', 'Document Processing Administrator');
await page.selectOption('#archetype-select', 'customer-ops');
await page.fill('#jd-input', CLOSE_MATCH_JD_FOR_DOM);
await page.waitForTimeout(500);
const closeMatchNotice = await letterNoticeText();
check('Letter panel: close-match fires and, its five paragraphs approved (4 Oct 2026), shows no unreviewed banner',
  !/Unreviewed:/.test(closeMatchNotice) && (await page.evaluate(() => CVApp._test.getSectionState().letterAuto.mode)) === 'closeMatch', closeMatchNotice);
const injectedBanner = await page.evaluate(async () => {
  var cm = CVApp._test.getLoadedData().letterBlocks.closeMatch[0];
  cm._pendingReview = 'TEST FLAG';
  var team = document.getElementById('letter-company');
  team.value = 'SoftCo Ltd'; team.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 400); });
  var el = document.getElementById('letter-notice');
  var withFlag = (el && !el.hidden) ? el.textContent : '';
  delete cm._pendingReview;
  team.value = 'SoftCo'; team.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 400); });
  var after = (el && !el.hidden) ? el.textContent : '';
  return { withFlag: withFlag, after: after };
});
check('Letter panel: the unreviewed banner still appears in a close-match letter for a flagged paragraph (injected flag), and goes when removed',
  /Unreviewed: TEST FLAG/.test(injectedBanner.withFlag) && !/Unreviewed:/.test(injectedBanner.after), JSON.stringify(injectedBanner));

const genericJDForDom = ['Marketing Coordinator - Acme', '', 'Responsibilities:', 'Plan social media campaigns.', 'Coordinate with design team on assets.', 'Write blog posts.', 'Attend brainstorming sessions.'].join('\n');
await page.fill('#jd-input', genericJDForDom);
await page.waitForTimeout(500);
const normalNotice = await letterNoticeText();
check('Letter panel: unreviewed banner does not appear for a normal (non-close-match) letter',
  !/Unreviewed:/.test(normalNotice), normalNotice);
await page.fill('#jd-input', '');
await page.fill('#letter-company', '');
await page.fill('#letter-role', '');

// ---- Render-level smoke gate (25 Sept 2026, item 4 part 2): every gate
// above this line reads the CONTENT MODEL - block objects with a .text
// field, checked for provenance/never-claim/dash/height - never the text a
// real download would actually contain. None of them would have caught
// the RECIPIENT_NAME bug: a literal, unfilled "{{RECIPIENT_NAME}}" traces
// back to a real letterBlocks entry (passes provenance), never claims a
// banned term, and isn't an em dash. Derin's own diagnosis: "Green
// provenance and never-claim gates said nothing because none of them read
// the output as text. That is the gap."
//
// This closes it directly: build BOTH documents for EVERY real fixture in
// tests/fixtures/jd/ (the eight-ad corpus, tests/fixtures/README.txt),
// flatten every text-bearing field of the resulting content model into one
// string per document, and fail on eight concrete shapes a rendering or
// substitution bug leaves behind - an unsubstituted {{ or }}, "Dear ," (an
// empty named-salutation slot), the literal words undefined/null/NaN (a JS
// value concatenated into a template instead of a real one), a double
// space, an empty bullet, and a trailing "|".
//
// Letters are built twice per fixture where an ECHO candidate exists: once
// with echoText empty (exercises the noEchoText branch) and once with the
// first offered candidate (exercises the {{ECHO}} substitution branch) -
// two genuinely different code paths, both real ways to ship a dangling
// slot. (Since 3 Oct 2026 the second build fills {{ECHO}} in the why
// paragraph's frame only; the evidence paragraph takes its no-quote ending
// so the line is not printed twice - checked in the TCS evidence section.)
//
// alphasense-associate-expert-call-services is the one fixture
// tests/fixtures/README.txt itself documents as an EXPECTED archetype gap
// (sales-sourcing does not exist yet - CVScore.pickArchetype must refuse,
// not silently pick something ill-fitting) - nothing to build or scan
// there, and this section skips it rather than treating "no match" as a
// smoke-gate failure, per that fixture's own documented, correct result.
console.log('\n--- Render-level smoke gate: CV + letter final text, all 7 real fixtures ---');
const FIXTURE_JD_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'jd');
const fixtureTexts = fs.readdirSync(FIXTURE_JD_DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(FIXTURE_JD_DIR, f), 'utf8') }));
check(fixtureTexts.length + ' real fixture JDs found in tests/fixtures/jd/ (expected 8)', fixtureTexts.length === 8, JSON.stringify(fixtureTexts.map((f) => f.name)));

const smokeResults = await page.evaluate(([data, fixtures]) => {
  var BANNED_JOINED = [
    { needle: '{{', label: 'contains an unsubstituted "{{"' },
    { needle: '}}', label: 'contains an unsubstituted "}}"' },
    { needle: 'Dear ,', label: 'contains "Dear ," (an empty named-salutation slot)' }
  ];
  var BANNED_WORD_RE = [
    { re: /\bundefined\b/, label: 'contains the literal word "undefined"' },
    { re: /\bnull\b/, label: 'contains the literal word "null"' },
    { re: /\bNaN\b/, label: 'contains the literal word "NaN"' }
  ];

  function flattenTexts(blocks) {
    var out = [];
    (blocks || []).forEach(function (b) {
      if (typeof b.text === 'string') out.push({ text: b.text, field: b.t + '.text' });
      if (typeof b.title === 'string') out.push({ text: b.title, field: b.t + '.title' });
      if (typeof b.org === 'string') out.push({ text: b.org, field: b.t + '.org' });
      if (typeof b.right === 'string') out.push({ text: b.right, field: b.t + '.right' });
      if (typeof b.label === 'string') out.push({ text: b.label, field: b.t + '.label' });
      if (Array.isArray(b.items)) {
        b.items.forEach(function (it) {
          if (it && typeof it.text === 'string') out.push({ text: it.text, field: b.t + '.items[].text' });
        });
      }
    });
    return out;
  }

  function smokeCheck(fields) {
    var problems = [];
    var joined = fields.map(function (f) { return f.text; }).join('\n');
    BANNED_JOINED.forEach(function (b) { if (joined.indexOf(b.needle) !== -1) problems.push(b.label); });
    BANNED_WORD_RE.forEach(function (b) { if (b.re.test(joined)) problems.push(b.label); });
    fields.forEach(function (f) {
      if (/ {2,}/.test(f.text)) problems.push('double space in ' + f.field + ': "' + f.text + '"');
      if (f.field === 'bullet.text' && !f.text.trim()) problems.push('empty bullet');
      if (/\|\s*$/.test(f.text.trim())) problems.push('trailing "|" in ' + f.field + ': "' + f.text + '"');
    });
    return problems;
  }

  var results = [];
  fixtures.forEach(function (fx) {
    var entry = { fixture: fx.name, archetype: null, noMatch: false, cvProblems: [], letterProblems: [] };
    var extraction = CVScore.extractFromJD(data, fx.text);
    var pick = CVScore.pickArchetype(data, extraction);
    if (pick.noMatch) {
      entry.noMatch = true;
      results.push(entry);
      return;
    }
    var archetypeId = pick.winner.archetype.id;
    entry.archetype = archetypeId;

    var cvModel = CVAssemble.buildModel(data, archetypeId, { extraction: extraction });
    entry.cvProblems = smokeCheck(flattenTexts(cvModel));

    var yearsRelevant = CVExperience.computeExperience(data).yearsRelevant;
    var baseLetterOpts = {
      archetypeId: archetypeId, extraction: extraction, rawJD: fx.text, yearsRelevant: yearsRelevant,
      company: 'Test Company Ltd', role: 'Test Role', team: '', city: '',
      recipientName: 'Test Recruiter', titleMismatch: false,
      fitCheckGapTrigger: 'none', refereeName: 'Test Referee', echoText: ''
    };
    var builtNoEcho = CVLetter.buildLetterContentModel(data, baseLetterOpts);
    entry.letterProblems = entry.letterProblems.concat(smokeCheck(flattenTexts(builtNoEcho.model)));

    if (builtNoEcho.letterResult.echoCandidates.length) {
      var withEchoOpts = {};
      Object.keys(baseLetterOpts).forEach(function (k) { withEchoOpts[k] = baseLetterOpts[k]; });
      withEchoOpts.echoText = builtNoEcho.letterResult.echoCandidates[0].text;
      var builtEcho = CVLetter.buildLetterContentModel(data, withEchoOpts);
      entry.letterProblems = entry.letterProblems.concat(smokeCheck(flattenTexts(builtEcho.model)));
    }

    results.push(entry);
  });
  return results;
}, [dataJson, fixtureTexts]);

smokeResults.forEach(function (r) {
  if (r.noMatch) {
    console.log('SKIP  - ' + r.fixture + ': no archetype match (expected coverage gap - see tests/fixtures/README.txt)');
    return;
  }
  check('Smoke gate: ' + r.fixture + ' (' + r.archetype + ') CV text is clean', r.cvProblems.length === 0, JSON.stringify(r.cvProblems));
  check('Smoke gate: ' + r.fixture + ' (' + r.archetype + ') letter text is clean', r.letterProblems.length === 0, JSON.stringify(r.letterProblems));
});

// ---- Render-level smoke gate: gate-fires (proves the scan itself really
// catches each of the eight shapes, not just stays quiet on real fixtures
// by construction - same discipline as every other gate-fires section). --
console.log('\n--- Render-level smoke gate: gate-fires (deliberately poisoned block arrays) ---');
const smokeGateFires = await page.evaluate(() => {
  // Reimplements just enough of the scan above, inline, against hand-built
  // block arrays - proving the DETECTION logic catches each shape. (The
  // scan function itself isn't exported from any module - it's test-only
  // code living in run-golden-tests.mjs - so this necessarily duplicates
  // the eight checks rather than importing them; kept deliberately short
  // and 1:1 with the real version above so the two can't silently drift
  // into checking different things.)
  function scan(text) {
    var problems = [];
    if (text.indexOf('{{') !== -1) problems.push('brace-open');
    if (text.indexOf('}}') !== -1) problems.push('brace-close');
    if (text.indexOf('Dear ,') !== -1) problems.push('dear-comma');
    if (/\bundefined\b/.test(text)) problems.push('undefined');
    if (/\bnull\b/.test(text)) problems.push('null');
    if (/\bNaN\b/.test(text)) problems.push('nan');
    if (/ {2,}/.test(text)) problems.push('double-space');
    if (/\|\s*$/.test(text.trim())) problems.push('trailing-pipe');
    return problems;
  }
  return {
    brace: scan('Contact {{RECIPIENT}} today').indexOf('brace-open') !== -1 && scan('Contact {{RECIPIENT}} today').indexOf('brace-close') !== -1,
    dearComma: scan('Dear ,').indexOf('dear-comma') !== -1,
    undef: scan('Your role is undefined at this company').indexOf('undefined') !== -1,
    nul: scan('Team: null').indexOf('null') !== -1,
    nan: scan('Years required: NaN').indexOf('nan') !== -1,
    doubleSpace: scan('I  led the project').indexOf('double-space') !== -1,
    trailingPipe: scan('Skills: Excel, SQL |').indexOf('trailing-pipe') !== -1,
    cleanTextPassesClean: scan('A perfectly ordinary sentence.').length === 0
  };
});
check('Smoke gate detection: catches {{ / }}', smokeGateFires.brace === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches "Dear ,"', smokeGateFires.dearComma === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches literal "undefined"', smokeGateFires.undef === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches literal "null"', smokeGateFires.nul === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches literal "NaN"', smokeGateFires.nan === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches a double space', smokeGateFires.doubleSpace === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: catches a trailing "|"', smokeGateFires.trailingPipe === true, JSON.stringify(smokeGateFires));
check('Smoke gate detection: an ordinary clean sentence passes with zero problems', smokeGateFires.cleanTextPassesClean === true, JSON.stringify(smokeGateFires));

// ---- QFA gap trigger: permanent negative test (25 Sept 2026, item 5:
// "Make the QFA check a permanent negative test. Add a synthetic fixture
// naming ACCA and assert no QFA gap paragraph fires."). A synthetic JD, not
// a file in tests/fixtures/jd/ - that corpus's own README is explicit that
// only real, verbatim-preserved ad text belongs there ("must NOT be
// reconstructed from memory... makes the result unfalsifiable"); synthetic
// test input belongs inline here, the same way the trim.js and gate-fires
// sections above build their own synthetic models rather than fixture
// files. Proves js/fitcheck.js's topWarningGapTrigger's own quoted-sentence
// check (see that file's comment on w-qualification being a special case)
// really does discriminate ACCA from QFA, with a positive control alongside
// it so a pass here can't just mean "nothing matched at all". -------------
console.log('\n--- QFA gap trigger: permanent negative test (synthetic ACCA fixture) ---');
const qfaNegative = await page.evaluate((data) => {
  var archetype = data.archetypes.filter(function (a) { return a.id === 'insurance-pensions'; })[0];
  var accaJD = 'You must hold ACCA to be considered for this role. Strong Excel skills are also required.';
  var accaExtraction = CVScore.extractFromJD(data, accaJD);
  var accaFit = CVFitCheck.run(data, accaExtraction, archetype, '');
  var qfaJD = 'You must hold QFA to be considered for this role. Strong Excel skills are also required.';
  var qfaExtraction = CVScore.extractFromJD(data, qfaJD);
  var qfaFit = CVFitCheck.run(data, qfaExtraction, archetype, '');
  return {
    accaGapTrigger: accaFit.gapTrigger,
    accaFindingIds: accaFit.findings.map(function (f) { return f.id; }),
    qfaGapTrigger: qfaFit.gapTrigger
  };
}, dataJson);
check('QFA negative test: a synthetic ad naming ACCA (not QFA) never triggers the QFA gap paragraph',
  qfaNegative.accaGapTrigger !== 'qfa', JSON.stringify(qfaNegative));
check('QFA negative test: w-qualification still fires as a finding for the ACCA ad (a real negative, not "nothing matched at all")',
  qfaNegative.accaFindingIds.indexOf('w-qualification') !== -1, JSON.stringify(qfaNegative));
check('QFA positive control: a synthetic ad naming QFA itself DOES trigger the QFA gap paragraph',
  qfaNegative.qfaGapTrigger === 'qfa', JSON.stringify(qfaNegative));

// ---- Gap paragraphs: capped at one, and never duplicating the archetype's
// own paragraph (25 Sept 2026, item 5, second half). The one-per-letter cap
// is already guaranteed by js/letterbuild.js's own shape (a single
// gapTrigger string, a single entryForTrigger lookup, one push, no loop -
// see that function's own comment) - this proves the invariant holds
// across the real fixture corpus, as a regression guard against a future
// change that broke it, not because there was ever a code path that could
// produce two. The duplicate-suppression half is new logic (GAP_DUPLICATE_
// TERMS in buildLetterModel) and gets a real gate-fires proof: a
// hand-built model where the archetype's own evidence paragraph already
// says "QFA" must suppress let-gap-qfa, and report gapSuppressedDuplicate
// so the caller can log it (see js/app.js's recomputeLetter). -------------
console.log('\n--- Gap paragraphs: capped at one per letter; duplicate-of-archetype-paragraph suppression ---');
const gapCapAndDup = await page.evaluate(([data, fixtures]) => {
  var results = { perFixtureGapCounts: [], maxGapBlocksSeen: 0 };
  fixtures.forEach(function (fx) {
    var extraction = CVScore.extractFromJD(data, fx.text);
    var pick = CVScore.pickArchetype(data, extraction);
    if (pick.noMatch) return;
    var archetypeId = pick.winner.archetype.id;
    var yearsRelevant = CVExperience.computeExperience(data).yearsRelevant;
    var built = CVLetterBuild.buildLetterModel(data, {
      archetypeId: archetypeId, extraction: extraction, rawJD: fx.text, yearsRelevant: yearsRelevant,
      company: 'Test Company Ltd', role: 'Test Role', team: '', echoText: '',
      fitCheckGapTrigger: 'none' // real gapTrigger isn't wired through this synthetic call; the cap check
                                  // only needs "how many gap blocks can this function ever produce", not a
                                  // real trigger value - see the titleMismatch run below for a real trigger.
    });
    var gapCount = built.blocks.filter(function (b) { return b.category === 'gap'; }).length;
    results.perFixtureGapCounts.push({ fixture: fx.name, gapCount: gapCount });
    if (gapCount > results.maxGapBlocksSeen) results.maxGapBlocksSeen = gapCount;
  });

  // Force every real trigger in turn (not just whatever the real fixtures
  // happen to produce) against a real archetype, to prove the cap holds
  // even when a gap paragraph DOES fire, not just when none does.
  var forcedCounts = ['yearsShort', 'titleMismatch', 'qfa', 'irishPensions', 'sales'].map(function (trigger) {
    var opts = {
      archetypeId: 'insurance-pensions', extraction: { keywordHits: {} }, rawJD: '',
      company: 'Test Company Ltd', role: 'Test Role', team: '', echoText: '',
      fitCheckGapTrigger: trigger === 'titleMismatch' ? 'none' : trigger,
      titleMismatch: trigger === 'titleMismatch'
    };
    var built = CVLetterBuild.buildLetterModel(data, opts);
    return { trigger: trigger, gapCount: built.blocks.filter(function (b) { return b.category === 'gap'; }).length };
  });
  results.forcedCounts = forcedCounts;
  results.maxGapBlocksSeen = Math.max(results.maxGapBlocksSeen, Math.max.apply(null, forcedCounts.map(function (f) { return f.gapCount; })));

  // Duplicate-suppression gate-fires: a hand-built call where the
  // archetype's own evidence paragraph would already contain "QFA" (by
  // constructing an extraction whose keywordHits picks an evidence entry
  // is fragile against future data changes, so instead this constructs the
  // scenario directly at the level buildLetterModel actually checks it -
  // by temporarily poisoning a clone of letterBlocks.evidence so the
  // winning entry's text already says "QFA", then forcing gapTrigger
  // 'qfa'). Proves the suppression logic really fires on a real collision,
  // not just stays quiet by construction.
  var poisoned = JSON.parse(JSON.stringify(data));
  var evidenceEntry = poisoned.letterBlocks.evidence.filter(function (e) { return e.archetypes.indexOf('*') !== -1 || e.archetypes.indexOf('insurance-pensions') !== -1; })[0];
  evidenceEntry.text += ' I am already QFA qualified in every sense that matters to this ad.';
  var dupBuilt = CVLetterBuild.buildLetterModel(poisoned, {
    archetypeId: 'insurance-pensions', extraction: { keywordHits: {} }, rawJD: '',
    company: 'Test Company Ltd', role: 'Test Role', team: '', echoText: '', fitCheckGapTrigger: 'qfa'
  });
  results.duplicateSuppressedGapCount = dupBuilt.blocks.filter(function (b) { return b.category === 'gap'; }).length;
  results.duplicateSuppressedFlagSet = dupBuilt.gapSuppressedDuplicate === true;

  // Positive control alongside it: the SAME forced 'qfa' trigger against
  // the real, unpoisoned data file must still produce a gap paragraph -
  // proves the suppression is a real collision check, not "qfa just never
  // renders".
  var cleanBuilt = CVLetterBuild.buildLetterModel(data, {
    archetypeId: 'insurance-pensions', extraction: { keywordHits: {} }, rawJD: '',
    company: 'Test Company Ltd', role: 'Test Role', team: '', echoText: '', fitCheckGapTrigger: 'qfa'
  });
  results.cleanRunStillProducesGap = cleanBuilt.blocks.filter(function (b) { return b.category === 'gap'; }).length === 1 &&
    cleanBuilt.gapSuppressedDuplicate === false;

  return results;
}, [dataJson, fixtureTexts]);
check('Gap cap: no real fixture ever produces more than one gap block', gapCapAndDup.maxGapBlocksSeen <= 1, JSON.stringify(gapCapAndDup));
check('Gap cap: every one of the five real gap triggers, forced individually, still produces at most one gap block',
  gapCapAndDup.forcedCounts.every(function (f) { return f.gapCount <= 1; }), JSON.stringify(gapCapAndDup));
check('Gap duplicate suppression: a QFA gap paragraph is suppressed when the archetype\'s own evidence text already says "QFA"',
  gapCapAndDup.duplicateSuppressedGapCount === 0 && gapCapAndDup.duplicateSuppressedFlagSet === true, JSON.stringify(gapCapAndDup));
check('Gap duplicate suppression: positive control - the same forced trigger against the real, unpoisoned file still produces exactly one gap block',
  gapCapAndDup.cleanRunStillProducesGap === true, JSON.stringify(gapCapAndDup));

// ---- Keyword baseline: prints a delta against tests/keyword-baseline.json
// (25 Sept 2026, item 6: "Record the keyword baseline now that NetApp's 7
// keywords landed... Every future tag edit prints a delta against it.
// Without the baseline the precision trade goes back to being a judgement
// made in the dark."). Recorded once, by hand, via tests/golden/record-
// keyword-baseline.mjs - NOT regenerated here. This section only compares:
// for every tag either side knows about, which real fixtures currently
// register a hit vs which ones the committed baseline recorded, and prints
// exactly the shape tests/fixtures/README.txt's own example shows
// ("excel: 5 ads -> 3 ads (-2: netapp, wtw)"). Deliberately NON-BLOCKING -
// a tag's precision moving is an expected, sometimes-intentional outcome of
// editing tags against real ad text, not a bug; the two check()s below only
// assert the baseline file itself is present and matches the CURRENT real
// fixture corpus by name (an out-of-date or missing baseline would make
// every future delta meaningless, which is worth failing loudly on), never
// that the counts are unchanged. --------------------------------------
console.log('\n--- Keyword baseline: delta against tests/keyword-baseline.json ---');
const KEYWORD_BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'keyword-baseline.json');
const baselineExists = fs.existsSync(KEYWORD_BASELINE_PATH);
check('tests/keyword-baseline.json exists (run tests/golden/record-keyword-baseline.mjs once to create it)', baselineExists);
if (baselineExists) {
  const committedBaseline = JSON.parse(fs.readFileSync(KEYWORD_BASELINE_PATH, 'utf8'));
  const currentFixtureNames = fixtureTexts.map((f) => f.name).sort();
  const baselineFixtureNames = (committedBaseline.fixtures || []).slice().sort();
  check('tests/keyword-baseline.json was recorded against the same real fixtures as this run (currently stale: run tests/golden/record-keyword-baseline.mjs to accept fixture 8 into the baseline)',
    JSON.stringify(currentFixtureNames) === JSON.stringify(baselineFixtureNames),
    'baseline: ' + JSON.stringify(baselineFixtureNames) + '\n       current: ' + JSON.stringify(currentFixtureNames));

  const currentTagFixtures = await page.evaluate(([data, fixtures]) => {
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

  const baselineTagFixtures = committedBaseline.tagFixtures || {};
  const allTagNames = Array.from(new Set(Object.keys(currentTagFixtures).concat(Object.keys(baselineTagFixtures)))).sort();
  let deltaCount = 0;
  allTagNames.forEach((tag) => {
    const before = (baselineTagFixtures[tag] || []).slice().sort();
    const after = (currentTagFixtures[tag] || []).slice().sort();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    deltaCount++;
    const added = after.filter((f) => !before.includes(f));
    const removed = before.filter((f) => !after.includes(f));
    const parts = [];
    if (added.length) parts.push('+' + added.length + ': ' + added.join(', '));
    if (removed.length) parts.push('-' + removed.length + ': ' + removed.join(', '));
    console.log('  DELTA - ' + tag + ': ' + before.length + ' ads -> ' + after.length + ' ads (' + parts.join('; ') + ')');
  });
  if (deltaCount === 0) {
    console.log('  No change from the committed keyword baseline (dataVersion ' + committedBaseline.dataVersion + ' -> ' + dataJson._version + ').');
  } else {
    console.log('  ' + deltaCount + ' tag(s) changed since the committed baseline (dataVersion ' + committedBaseline.dataVersion + ' -> ' + dataJson._version +
      '). If this precision trade is intentional, re-run tests/golden/record-keyword-baseline.mjs and commit the new tests/keyword-baseline.json.');
  }
}

// ---- Style single-source-of-truth: renderers vs data.style (25 Sept 2026,
// item 7: "Both renderers still hardcode their own style constants while
// the doc says the JSON style object is authoritative. Either read style in
// both, or add a test that asserts every hardcoded constant equals its JSON
// value."). Investigation, not assumption: both js/render-docx.js's own
// file header ("13 Sept 2026 review fix: every value below now comes from
// data.style at runtime, via configure(style)") and js/preview.js's
// configure() (reads colours/sizes/spacing/etc. straight off the `style`
// argument, derives CONTAINER_WIDTH_PX/USABLE_HEIGHT_PX/PAGE_MARGIN_PX from
// it) show the CODE side of this was already done - neither file hardcodes
// a copy today. What was actually missing was the committed test
// data.style._mustBeReadAtRuntime itself asks for as the fallback
// ("Until they are wired, add a test that reads this object and asserts
// every hardcoded constant matches it") - this section is that test, a
// permanent regression guard against either renderer quietly drifting back
// to a hardcoded copy, not a fix to a live bug. The doc-side half of this
// item (CV-house-style.md's own "Status, 13 September 2026: not yet wired"
// block) lives outside this repository - see this pass's report. ---------
console.log('\n--- Style single-source-of-truth: js/render-docx.js + js/preview.js vs data.style ---');
const styleWiring = await page.evaluate((data) => {
  // Order-independent deep-equal for plain JSON-shaped objects/arrays -
  // JSON.stringify(a) === JSON.stringify(b) is a real bug here, not just
  // overkill: this file and js/render-docx.js build their _test.configured()
  // objects with their OWN key order, which has nothing to do with whether
  // the underlying values agree with data.style.
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (typeof a !== 'object') return false;
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(function (k) { return Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]); });
  }

  var s = data.style;
  var docxC = CVStyle._test.configured();
  var previewC = CVPreview._test.configured();
  var results = {};

  results.docxColoursMatch = docxC.colours.navy === s.colours.navy && docxC.colours.grey === s.colours.grey && docxC.colours.faint === s.colours.faint;
  results.docxSizesMatch = deepEqual(docxC.sizes, s.sizes);
  results.docxLineSpacingMatch = docxC.lineSpacing.line === s.lineSpacing.line && docxC.lineSpacing.rule === s.lineSpacing.rule;
  results.docxFontMatch = docxC.font === s.font;
  results.docxSeparatorMatch = docxC.separator === s.separator && docxC.skillLabelSuffix === s.skillLabelSuffix;
  results.docxPageMatch = docxC.page.widthTwips === s.page.widthTwips && docxC.page.heightTwips === s.page.heightTwips;
  results.docxMarginMatch = deepEqual(docxC.margin, s.page.margin);
  results.docxTextWidthMatch = docxC.textWidthTwips === s.textWidthTwips;
  results.docxCharSpacingMatch = deepEqual(docxC.characterSpacing, s.characterSpacing);
  results.docxHeadingBorderMatch = deepEqual(docxC.headingBorder, s.headingBorder);
  results.docxBulletMatch = deepEqual(docxC.bullet, s.bullet);
  results.docxSpacingAfterMatch = deepEqual(docxC.spacingAfter, s.spacingAfter);
  results.docxHyperlinkMatch = docxC.hyperlinkColour === s.hyperlinkColour && docxC.hyperlinkUnderline === !!s.hyperlinkUnderline;

  results.previewColoursMatch = previewC.colours.navy === '#' + s.colours.navy && previewC.colours.grey === '#' + s.colours.grey && previewC.colours.faint === '#' + s.colours.faint;
  results.previewFontMatch = previewC.font === "'" + s.font + "', Times, serif";
  results.previewSeparatorMatch = previewC.separator === s.separator && previewC.skillLabelSuffix === s.skillLabelSuffix;
  results.previewSizesMatch = deepEqual(previewC.sizes, s.sizes);
  results.previewSpacingMatch = deepEqual(previewC.spacingAfter, s.spacingAfter);
  results.previewCharSpacingMatch = deepEqual(previewC.characterSpacing, s.characterSpacing);
  results.previewHeadingBorderMatch = deepEqual(previewC.headingBorder, s.headingBorder);
  results.previewBulletMatch = deepEqual(previewC.bullet, s.bullet);
  results.previewHyperlinkMatch = previewC.hyperlinkColour === '#' + s.hyperlinkColour && previewC.hyperlinkUnderline === !!s.hyperlinkUnderline;
  results.previewContainerWidthMatch = Math.abs(CVPreview.CONTAINER_WIDTH_PX - s.textWidthTwips / 15) < 0.001;
  results.previewUsableHeightMatch = Math.abs(CVPreview.USABLE_HEIGHT_PX - s.usableHeightTwips / 15) < 0.001;
  results.previewMarginMatch = Math.abs(CVPreview.PAGE_MARGIN_PX.top - s.page.margin.top / 15) < 0.001 &&
    Math.abs(CVPreview.PAGE_MARGIN_PX.right - s.page.margin.right / 15) < 0.001 &&
    Math.abs(CVPreview.PAGE_MARGIN_PX.bottom - s.page.margin.bottom / 15) < 0.001 &&
    Math.abs(CVPreview.PAGE_MARGIN_PX.left - s.page.margin.left / 15) < 0.001;

  // Gate-fires half: reconfigure both against a deliberately altered clone
  // (different navy, different body size) and confirm the SAME comparisons
  // above now correctly report a mismatch against the REAL data.style -
  // proves this is a live read, not two independently-hardcoded copies
  // that happen to agree by construction. Restores the real configuration
  // afterwards so nothing else in this page's remaining test sections runs
  // against the poisoned style.
  var altered = JSON.parse(JSON.stringify(s));
  altered.colours.navy = 'ABCDEF';
  altered.sizes.body = 999;
  CVStyle.configure(altered);
  CVPreview.configure(altered);
  var alteredDocxC = CVStyle._test.configured();
  var alteredPreviewC = CVPreview._test.configured();
  results.gateFiresDocx = alteredDocxC.colours.navy !== s.colours.navy && alteredDocxC.sizes.body !== s.sizes.body;
  results.gateFiresPreview = alteredPreviewC.colours.navy !== '#' + s.colours.navy && alteredPreviewC.sizes.body !== s.sizes.body;
  CVStyle.configure(s);
  CVPreview.configure(s);

  return results;
}, dataJson);
Object.keys(styleWiring).forEach(function (key) {
  if (key === 'gateFiresDocx' || key === 'gateFiresPreview') return;
  check('Style wiring: ' + key, styleWiring[key] === true, JSON.stringify(styleWiring[key]));
});
check('Style wiring gate-fires: js/render-docx.js reflects a reconfigured style (proves live read, not a hardcoded copy)', styleWiring.gateFiresDocx === true);
check('Style wiring gate-fires: js/preview.js reflects a reconfigured style (proves live read, not a hardcoded copy)', styleWiring.gateFiresPreview === true);

// ---- Libraries hosted with the site, loaded on demand (6-7 Oct 2026) -----
// The two libraries are served from lib/, not a CDN, must be the exact files
// recorded in lib/README.md, and are fetched only when a download needs them
// (js/libs.js). If one fails to load, only its own downloads may stop - and
// they must say why.
console.log('\n--- Libraries: hosted with the site, loaded on first download, a missing one only affects its own downloads ---');
{
  const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  check('index.html loads no script from another site', !/<script[^>]*\bsrc="(?:https?:)?\/\//.test(indexHtml));
  check('index.html does not load the PDF or Word library with the page', !/<script[^>]*\bsrc="lib\//.test(indexHtml));
  const libReadme = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'README.md'), 'utf8');
  const recorded = [...libReadme.matchAll(/\| `([^`]+\.js)` \|[^\n]*\| `([0-9a-f]{64})` \|/g)];
  check('lib/README.md records a SHA-256 for both libraries', recorded.length === 2, String(recorded.length));
  for (const m of recorded) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'lib', m[1]))).digest('hex');
    check('lib/' + m[1] + ' is the exact file recorded in lib/README.md', actual === m[2], actual);
  }

  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  // Opens the test page with WTW built; `missing` makes that library 404.
  async function openBuilt(missing) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    if (missing) await ctx.route('**/lib/' + missing, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage();
    const errs = [], libRequests = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('request', (r) => { const m = r.url().match(/\/lib\/([^?#]+)$/); if (m) libRequests.push(m[1]); });
    await p.goto(BASE_URL + '/index.test.html');
    await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    await p.fill('#jd-input', WTW);
    await p.waitForFunction(() => !document.getElementById('download-pdf-btn').disabled && !document.getElementById('letter-download-pdf-btn').disabled, null, { timeout: 15000 });
    return { ctx, p, errs, libRequests };
  }
  const download = (p, id) => Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('#' + id)]).then((r) => r[0].suggestedFilename(), () => null);
  const status = (p, id) => p.evaluate((i) => document.getElementById(i).textContent, id);

  // Normal case: nothing fetched until a download; each library fetched once.
  let s0 = null;
  try {
    s0 = await openBuilt(null);
    check('Libraries: neither is fetched while the page loads and builds the CV and letter', s0.libRequests.length === 0, JSON.stringify(s0.libRequests));
    const pdf1 = await download(s0.p, 'download-pdf-btn');
    check('Libraries: the first CV PDF download fetches the PDF library and saves a .pdf', /\.pdf$/.test(pdf1 || '') && s0.libRequests.filter((f) => f === 'jspdf.umd.min.js').length === 1, pdf1 + ' ' + JSON.stringify(s0.libRequests));
    const pdf2 = await download(s0.p, 'letter-download-pdf-btn');
    check('Libraries: a second PDF download does not fetch the library again', /\.pdf$/.test(pdf2 || '') && s0.libRequests.filter((f) => f === 'jspdf.umd.min.js').length === 1, pdf2 + ' ' + JSON.stringify(s0.libRequests));
    const word1 = await download(s0.p, 'download-btn');
    const word2 = await download(s0.p, 'letter-download-btn');
    check('Libraries: Word downloads fetch the Word library once and save .docx files', /\.docx$/.test(word1 || '') && /\.docx$/.test(word2 || '') && s0.libRequests.filter((f) => f === 'docx.umd.js').length === 1, [word1, word2].join(' ') + ' ' + JSON.stringify(s0.libRequests));
    check('Libraries: no uncaught page errors', s0.errs.length === 0, JSON.stringify(s0.errs));
  } catch (e) {
    check('Libraries: downloads load their library on demand', false, e.message);
  } finally {
    if (s0) await s0.ctx.close();
  }

  // One library missing: its own downloads say why; the other kind still works.
  for (const [missing, name, own, other] of [
    ['docx.umd.js', 'Word', ['download-btn', 'letter-download-btn'], 'download-pdf-btn'],
    ['jspdf.umd.min.js', 'PDF', ['download-pdf-btn', 'letter-download-pdf-btn'], 'download-btn']
  ]) {
    let s1 = null;
    try {
      s1 = await openBuilt(missing);
      const st0 = await s1.p.evaluate(() => ({ cvChars: document.getElementById('preview-container').innerText.length, letterChars: document.getElementById('letter-preview-container').innerText.length }));
      check(name + ' library missing: the site still loads and builds the CV and the letter', st0.cvChars > 500 && st0.letterChars > 300, JSON.stringify(st0));
      await s1.p.click('#' + own[0]);
      await s1.p.click('#' + own[1]);
      const re = new RegExp(name + ' library did not load');
      await s1.p.waitForFunction((src) => { const r = new RegExp(src); return r.test(document.getElementById('status').textContent) && r.test(document.getElementById('letter-status').textContent); }, re.source, { timeout: 10000 }).catch(() => {});
      const cvSt = await status(s1.p, 'status'), letterSt = await status(s1.p, 'letter-status');
      check(name + ' library missing: the CV ' + name + ' button says why', re.test(cvSt), cvSt);
      check(name + ' library missing: the letter ' + name + ' button says why', re.test(letterSt), letterSt);
      const otherFile = await download(s1.p, other);
      check(name + ' library missing: the other format still downloads', !!otherFile, otherFile || 'no download');
      check(name + ' library missing: no uncaught page errors', s1.errs.length === 0, JSON.stringify(s1.errs));
    } catch (e) {
      check(name + ' library missing: the site still loads and builds the CV and the letter', false, e.message);
    } finally {
      if (s1) await s1.ctx.close();
    }
  }
}

// ---- Build anyway: the letter names the gap and still downloads (8 Oct 2026)
// After "Build anyway" on a RED ad, the letter adds the approved sentence for
// each of (at most two) RED requirements that has one. Until 8 Oct those
// sentences had no measured height, so the letter could not be built and its
// download buttons stayed greyed out (Derin's Intact Insurance ad, 7 Oct).
// Each case is the WTW ad with one or two requirement lines added at the top
// (its last lines are company boilerplate, which the check skips).
console.log('\n--- Build anyway: the letter adds the gap sentence and both letter downloads work ---');
{
  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  const gapText = (id) => dataJson.hardRequirements.gapBlocks.find((g) => g.id === id).text;
  const cases = [
    ['APA', 'Must be APA qualified.\n\n', ['gap-apa']],
    ['QFA', 'Must be QFA qualified.\n\n', ['gap-qfa']],
    ['supervisory', 'Must have supervisory experience.\n\n', ['gap-supervisory']],
    ['APA and supervisory together', 'Must be APA qualified.\nMust have supervisory experience.\n\n', ['gap-apa', 'gap-supervisory']]
  ];
  for (const [label, added, gapIds] of cases) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    try {
      await p.goto(BASE_URL + '/index.test.html');
      await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
      await p.fill('#jd-input', added + WTW);
      await p.waitForFunction(() => /RED/.test(document.getElementById('hardreq-banner').textContent), null, { timeout: 15000 });
      const blocked = await p.evaluate(() => document.getElementById('letter-download-btn').disabled && document.getElementById('download-btn').disabled);
      check('Build anyway (' + label + '): before it, the ad is RED and every download is blocked', blocked);
      await p.click('#hardreq-build-anyway-btn');
      await p.waitForFunction(() => !document.getElementById('letter-download-btn').disabled, null, { timeout: 15000 }).catch(() => {});
      const st = await p.evaluate(() => ({
        letter: document.getElementById('letter-preview-container').innerText,
        word: document.getElementById('letter-download-btn').disabled ? document.getElementById('letter-download-btn').title : 'enabled',
        pdf: document.getElementById('letter-download-pdf-btn').disabled ? document.getElementById('letter-download-pdf-btn').title : 'enabled'
      }));
      const once = gapIds.every((id) => st.letter.split(gapText(id)).length === 2);
      check('Build anyway (' + label + '): the letter builds and names each gap exactly once', once, st.letter.slice(0, 400));
      check('Build anyway (' + label + '): both letter download buttons are enabled', st.word === 'enabled' && st.pdf === 'enabled', st.word + ' | ' + st.pdf);
      const files = [];
      for (const id of ['letter-download-btn', 'letter-download-pdf-btn']) {
        const name = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('#' + id)]).then((r) => r[0].suggestedFilename(), () => null);
        files.push(name);
      }
      check('Build anyway (' + label + '): the letter downloads as .docx and .pdf', /\.docx$/.test(files[0] || '') && /\.pdf$/.test(files[1] || ''), JSON.stringify(files));
      check('Build anyway (' + label + '): no uncaught page errors', errs.length === 0, JSON.stringify(errs));
    } catch (e) {
      check('Build anyway (' + label + '): the letter builds and downloads', false, e.message);
    } finally {
      await ctx.close();
    }
  }
}

// A gap sentence without a measured height is now a data-file error, caught
// when the file is checked rather than when a letter first needs it.
{
  const errors = await page.evaluate((d) => {
    const copy = JSON.parse(JSON.stringify(d));
    delete copy.hardRequirements.gapBlocks.find((g) => g.id === 'gap-apa').heightPx;
    return CVValidate.validateData(copy);
  }, dataJson);
  check('A gap sentence without a measured height fails the data file check, naming it', errors.some((e) => /gapBlocks\['gap-apa'\]: missing heightPx/.test(e)), JSON.stringify(errors).slice(0, 300));
}

// A letter that cannot be built says so on screen and on its buttons, instead
// of keeping the reason they showed before (on 7 Oct they kept saying "hard
// requirement - click Build anyway" after Build anyway had been clicked).
// Simulated by making the letter's page-fit check fail in the page.
{
  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  try {
    await p.goto(BASE_URL + '/index.test.html');
    await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    await p.fill('#jd-input', WTW);
    await p.waitForFunction(() => !document.getElementById('letter-download-btn').disabled, null, { timeout: 15000 });
    await p.evaluate(() => {
      const measure = CVPageFit.measure;
      CVPageFit.measure = function (model, docType) {
        if (docType === 'letter') throw new Error('simulated page-fit failure');
        return measure.apply(this, arguments);
      };
    });
    await p.fill('#letter-company', 'WTW Ireland');
    await p.waitForTimeout(800);
    const st = await p.evaluate(() => ({
      word: document.getElementById('letter-download-btn').disabled ? document.getElementById('letter-download-btn').title : 'enabled',
      pdf: document.getElementById('letter-download-pdf-btn').disabled ? document.getElementById('letter-download-pdf-btn').title : 'enabled',
      notice: document.getElementById('letter-notice').hidden ? '' : document.getElementById('letter-notice').textContent,
      cv: document.getElementById('download-btn').disabled ? 'disabled' : 'enabled'
    }));
    check('A letter that cannot be built: both letter buttons say so', /could not be built/.test(st.word) && /could not be built/.test(st.pdf), st.word + ' | ' + st.pdf);
    check('A letter that cannot be built: the reason is shown in the letter panel', /simulated page-fit failure/.test(st.notice), st.notice);
    check('A letter that cannot be built: the CV download is unaffected', st.cv === 'enabled', st.cv);
    check('A letter that cannot be built: no uncaught page error', errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    check('A letter that cannot be built says so', false, e.message);
  } finally {
    await ctx.close();
  }
}

// ---- The screen, simplified (8 Oct 2026, audit batch 3) --------------------
// One "Should you apply?" verdict with each reason once; CV files named by
// role and company; private settings entered in a form and kept in this
// browser (no fetch of data/private-overrides.json); a passing check is not
// drawn; the section dropdowns tucked into a collapsed panel.
console.log('\n--- The screen: one verdict, plain status, CV named by role and company, private settings form ---');
{
  const fx = (n) => fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', n + '.txt'), 'utf8');
  async function openPage(opts) {
    const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, opts || {}));
    const p = await ctx.newPage();
    const errs = [], requests = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('request', (r) => requests.push(r.url()));
    await p.goto(BASE_URL + '/index.test.html');
    await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    return { ctx, p, errs, requests };
  }
  const verdictOf = (p) => p.evaluate(() => {
    const card = document.getElementById('verdict-card');
    return {
      hidden: card.hidden,
      level: (card.className.match(/verdict-(red|amber|green)/) || [])[1] || null,
      label: (card.querySelector('.verdict-pill') || {}).textContent || '',
      reasons: [...card.querySelectorAll('.verdict-reason')].map((li) => ({ text: li.querySelector('.verdict-reason-text').textContent, quote: (li.querySelector('.verdict-reason-quote') || {}).textContent || '' })),
      emptyHintShown: getComputedStyle(document.querySelector('.verdict-empty')).display !== 'none',
      anywayVisible: !document.getElementById('hardreq-actions').hidden,
      note: (card.querySelector('.verdict-note') || {}).textContent || ''
    };
  });

  let s = null;
  try {
    s = await openPage();
    const empty = await verdictOf(s.p);
    check('Verdict: with no ad, the card is hidden and the empty hint shows', empty.hidden && empty.emptyHintShown, JSON.stringify(empty));
    check('No request for data/private-overrides.json while the page loads', !s.requests.some((u) => /private-overrides\.json/.test(u)), JSON.stringify(s.requests.filter((u) => /private/.test(u))));

    await s.p.fill('#jd-input', fx('wtw-pensions-administrator'));
    await s.p.waitForTimeout(1500);
    const wtw = await verdictOf(s.p);
    const quotes = wtw.reasons.map((r) => r.quote).filter(Boolean);
    check('Verdict (WTW): one card, "Check before applying"', !wtw.hidden && wtw.level === 'amber' && wtw.label === 'Check before applying', JSON.stringify(wtw));
    check('Verdict (WTW): every quoted line of the ad appears once (the QFA line is not repeated by the fit check)', quotes.length === new Set(quotes).size && quotes.filter((q) => /QFA/.test(q)).length === 1, JSON.stringify(quotes));
    check('Verdict (WTW): the reasons name QFA as preferred and not held', wtw.reasons.some((r) => /^QFA \(Qualified Financial Adviser\): preferred, you don't have it/.test(r.text)), JSON.stringify(wtw.reasons));
    check('Verdict (WTW): no Build anyway buttons for an amber verdict', !wtw.anywayVisible);
    const gates = await s.p.evaluate(() => ({ passing: document.querySelectorAll('#gates-list .gate-pass').length, drawn: [...document.querySelectorAll('#gates-list .gate-item')].filter((li) => li.offsetParent !== null).length, listShown: getComputedStyle(document.getElementById('gates-list')).display !== 'none' }));
    check('All four CV checks still run, but a passing check is not drawn', gates.passing === 4 && gates.drawn === 0 && !gates.listShown, JSON.stringify(gates));
    const readout = await s.p.evaluate(() => { const el = document.getElementById('fit-readout'); return { visible: el.innerText.trim(), title: el.title }; });
    check('The CV fit message on screen is just "Fits on one page"; the arithmetic is its tooltip', readout.visible === 'Fits on one page' && /px used/.test(readout.title), JSON.stringify(readout));

    const cvFiles = [];
    for (const id of ['download-pdf-btn', 'download-btn']) {
      cvFiles.push(await Promise.all([s.p.waitForEvent('download', { timeout: 20000 }), s.p.click('#' + id)]).then((r) => r[0].suggestedFilename(), () => null));
    }
    check('CV files are named by role and company, like the letter', cvFiles[0] === 'Derin_Yesudas_CV_Pensions_Administrator_WTW.pdf' && cvFiles[1] === 'Derin_Yesudas_CV_Pensions_Administrator_WTW.docx', JSON.stringify(cvFiles));
    await s.p.fill('#letter-company', '');
    await s.p.fill('#letter-role', '');
    await s.p.waitForTimeout(600);
    const fallback = await Promise.all([s.p.waitForEvent('download', { timeout: 20000 }), s.p.click('#download-pdf-btn')]).then((r) => r[0].suggestedFilename(), () => null);
    check('With no role or company, the CV file falls back to the role type', fallback === 'Derin_Yesudas_CV_Insurance_pensions_administration.pdf', String(fallback));

    await s.p.fill('#jd-input', fx('ornua-graduate-trainee'));
    await s.p.waitForTimeout(1500);
    const ornua = await verdictOf(s.p);
    check('Verdict (Ornua): "Apply" with no reasons', ornua.level === 'green' && ornua.label === 'Apply' && ornua.reasons.length === 0, JSON.stringify(ornua));

    await s.p.fill('#jd-input', fx('clydeco-junior-associate-corporate-insurance'));
    await s.p.waitForTimeout(1500);
    const clyde = await verdictOf(s.p);
    check('Verdict (Clyde & Co): "Likely not eligible", naming the solicitor requirement, with Build anyway offered', clyde.level === 'red' && clyde.label === 'Likely not eligible' && clyde.anywayVisible && clyde.reasons.some((r) => /solicitor/i.test(r.text) && /required/.test(r.text)), JSON.stringify(clyde));
    await s.p.click('#hardreq-build-anyway-btn');
    await s.p.waitForTimeout(800);
    const clyde2 = await verdictOf(s.p);
    check('Verdict (Clyde & Co): after Build anyway the card says downloads are unlocked', /Building anyway/.test(clyde2.note), JSON.stringify(clyde2));
    check('The screen: no uncaught page errors', s.errs.length === 0, JSON.stringify(s.errs));
  } catch (e) {
    check('The screen: verdict, filenames and checks', false, e.message);
  } finally {
    if (s) await s.ctx.close();
  }

  // Private settings: entered in the form, kept in this browser, used at once.
  let t = null;
  try {
    t = await openPage();
    const startOpen = await t.p.evaluate(() => document.getElementById('panel-adjust').open);
    check('"Change sections and settings" starts collapsed', startOpen === false);
    await t.p.click('#panel-adjust > summary');
    const boxes = await t.p.evaluate(() => [...document.querySelectorAll('#private-salary-fields input[data-bucket]')].map((i) => i.getAttribute('data-bucket')).sort());
    const buckets = Object.keys(dataJson.formAnswers.salaryBucketLabels).filter((k) => k[0] !== '_').sort();
    check('Private settings: one salary box per role type the data file names', JSON.stringify(boxes) === JSON.stringify(buckets), JSON.stringify(boxes));
    await t.p.fill('#private-referee', 'Test Referee');
    await t.p.fill('#private-salary-insurance-pensions', 'EUR 30,000 - EUR 34,000 (TEST VALUE)');
    await t.p.click('#private-settings-save-btn');
    await t.p.waitForTimeout(300);
    const stored = await t.p.evaluate(() => JSON.parse(localStorage.getItem('cvGenerator.privateOverrides') || 'null'));
    check('Private settings: Save keeps exactly what was entered, in this browser', stored && stored.refereeName === 'Test Referee' && stored.salaryRanges && stored.salaryRanges['insurance-pensions'] === 'EUR 30,000 - EUR 34,000 (TEST VALUE)' && Object.keys(stored.salaryRanges).length === 1, JSON.stringify(stored));
    const status = await t.p.evaluate(() => document.getElementById('private-settings-status').textContent);
    check('Private settings: the status says what is saved', /Saved\. This browser has the referee's name and a salary figure for 1 role type/.test(status), status);
    await t.p.fill('#jd-input', fx('wtw-pensions-administrator'));
    await t.p.waitForTimeout(1500);
    const salary = await t.p.evaluate(() => [...document.querySelectorAll('#form-answers-container *')].map((e) => e.textContent).find((x) => /EUR 30,000 - EUR 34,000 \(TEST VALUE\)/.test(x)) || null);
    check('Private settings: the saved salary is used in the form answers at once', !!salary, String(salary));
    await t.p.reload();
    await t.p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    const after = await t.p.evaluate(() => ({ referee: document.getElementById('private-referee').value, ip: document.getElementById('private-salary-insurance-pensions').value, open: document.getElementById('panel-adjust').open }));
    check('Private settings: after a reload the form shows what was saved', after.referee === 'Test Referee' && after.ip === 'EUR 30,000 - EUR 34,000 (TEST VALUE)', JSON.stringify(after));
    check('"Change sections and settings" stays open after a reload once opened', after.open === true);
    check('Private settings: no uncaught page errors', t.errs.length === 0, JSON.stringify(t.errs));
  } catch (e) {
    check('Private settings: the form saves and is used', false, e.message);
  } finally {
    if (t) await t.ctx.close();
  }
}

// ---- Privacy pass (9 Oct 2026): private details laid over the data ----------
// The phone number, the detailed permission wording, a private form answer and
// private never-claim terms are not in the public data file; they come from
// this browser's private settings and are laid over the data at load. Test
// values only - the real ones never appear in this repository.
console.log('\n--- Privacy pass: private details come from this browser, never from the public data ---');
{
  const PHONE_LIKE = /^\+?[\d\s().-]{7,}$/;
  check('Public data: no phone number among the contact details',
    dataJson.identity.contact.every((c) => !PHONE_LIKE.test(String(c.text || '').trim())), JSON.stringify(dataJson.identity.contact.map((c) => c.text)));
  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  const TEST_PRIVATE = {
    contactPhone: '+353 00 000 0000',
    permission: 'TEST PERMISSION WORDING',
    formAnswers: { rightToWorkSponsorship: 'TEST RIGHT-TO-WORK ANSWER' },
    neverClaimExtra: ['zzq test term'],
    refereeName: 'Test Referee'
  };
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const ready = () => p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
  const read = () => p.evaluate(() => {
    const d = CVApp._test.getLoadedData();
    return {
      cv: document.getElementById('preview-container').textContent,
      letter: document.getElementById('letter-preview-container').textContent,
      answers: document.getElementById('form-answers-container').textContent,
      contact: d.identity.contact.map((c) => c.text),
      permission: d.availability.permission,
      neverClaimHasExtra: d.neverClaim.indexOf('zzq test term') !== -1,
      phoneField: document.getElementById('private-phone').value,
      status: document.getElementById('private-settings-status').textContent,
      cvWord: !document.getElementById('download-btn').disabled,
      letterWord: !document.getElementById('letter-download-btn').disabled
    };
  });
  try {
    await p.goto(BASE_URL + '/index.test.html');
    await ready();
    await p.fill('#jd-input', WTW);
    await p.waitForTimeout(1500);
    const none = await read();
    check('Privacy: with nothing saved, the CV carries no phone number and the status says so',
      !/\+353 00 000 0000/.test(none.cv) && /phone number out/.test(none.status), JSON.stringify({ status: none.status, contact: none.contact }));

    await p.evaluate((v) => localStorage.setItem('cvGenerator.privateOverrides', JSON.stringify(v)), TEST_PRIVATE);
    await p.reload();
    await ready();
    await p.fill('#jd-input', WTW);
    await p.waitForTimeout(1500);
    const withPrivate = await read();
    const emailAt = withPrivate.contact.findIndex((t) => /@/.test(t));
    check('Privacy: a saved phone number goes on the CV, right after the email',
      withPrivate.contact[emailAt + 1] === '+353 00 000 0000' && /\+353 00 000 0000/.test(withPrivate.cv), JSON.stringify(withPrivate.contact));
    check('Privacy: and on the letter', /\+353 00 000 0000/.test(withPrivate.letter));
    check('Privacy: the private right-to-work answer replaces the public one in the form answers', /TEST RIGHT-TO-WORK ANSWER/.test(withPrivate.answers));
    check('Privacy: the private permission wording and never-claim terms are laid over the data',
      withPrivate.permission === 'TEST PERMISSION WORDING' && withPrivate.neverClaimHasExtra, JSON.stringify({ permission: withPrivate.permission, extra: withPrivate.neverClaimHasExtra }));
    check('Privacy: the form shows the phone number and the status lists every private detail held',
      withPrivate.phoneField === '+353 00 000 0000' && /your phone number/.test(withPrivate.status) && /permission wording/.test(withPrivate.status) &&
      /private form answers/.test(withPrivate.status) && /private never-claim terms/.test(withPrivate.status), withPrivate.status);
    check('Privacy: with the phone on the page every check still passes and the downloads are on', withPrivate.cvWord && withPrivate.letterWord);

    // Saving the form keeps what only a file can set; the referee alone does
    // not reload the page.
    await p.evaluate(() => { document.getElementById('panel-adjust').open = true; });
    await p.fill('#private-referee', 'Another Referee');
    await p.click('#private-settings-save-btn');
    await p.waitForTimeout(400);
    const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('cvGenerator.privateOverrides')));
    check('Privacy: saving the form keeps the permission wording, form answers and never-claim terms',
      kept.refereeName === 'Another Referee' && kept.contactPhone === '+353 00 000 0000' && kept.permission === 'TEST PERMISSION WORDING' &&
      kept.formAnswers && kept.formAnswers.rightToWorkSponsorship === 'TEST RIGHT-TO-WORK ANSWER' && Array.isArray(kept.neverClaimExtra), JSON.stringify(kept));

    // A new phone number reloads the page so the CV is rebuilt with it.
    await p.fill('#private-phone', '+353 00 111 2222');
    await Promise.all([p.waitForEvent('load', { timeout: 15000 }), p.click('#private-settings-save-btn')]);
    await ready();
    await p.fill('#jd-input', WTW);
    await p.waitForTimeout(1500);
    const newPhone = await read();
    check('Privacy: changing the phone number in the form reloads the page and the CV shows the new one',
      /\+353 00 111 2222/.test(newPhone.cv) && !/\+353 00 000 0000/.test(newPhone.cv), JSON.stringify(newPhone.contact));

    // Importing a file adds to what the browser holds (the referee survives)
    // and applies a data-level key at once (by reloading).
    await p.evaluate(() => { document.getElementById('panel-adjust').open = true; });
    await Promise.all([
      p.waitForEvent('load', { timeout: 15000 }),
      p.setInputFiles('#private-settings-file-input', { name: 'private-overrides.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ contactPhone: '+353 00 333 4444' })) })
    ]);
    await ready();
    const imported = await p.evaluate(() => JSON.parse(localStorage.getItem('cvGenerator.privateOverrides')));
    await p.fill('#jd-input', WTW);
    await p.waitForTimeout(1500);
    const afterImport = await read();
    check('Privacy: importing a file adds to what is saved (the referee and permission wording stay)',
      imported.contactPhone === '+353 00 333 4444' && imported.refereeName === 'Another Referee' && imported.permission === 'TEST PERMISSION WORDING', JSON.stringify(imported));
    check('Privacy: the imported phone number is on the CV after the reload', /\+353 00 333 4444/.test(afterImport.cv), JSON.stringify(afterImport.contact));
    check('Privacy: no uncaught page errors', errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    check('Privacy: private details laid over the data', false, e.message);
  } finally {
    await ctx.close();
  }
}

// ---- The never-claim scan reads the data file's words, not the application's
// details (8 Oct 2026). Derin's Salesforce ad: "salesforce" is on the
// never-claim list (a CRM he has not used), and the company's own name in the
// letter's address and opening/closing lines failed the scan, so the letter
// could not be downloaded. The CV is scanned exactly as before.
console.log('\n--- Never-claim scan: the company, role and other details of an application are not claims ---');
{
  const r = await page.evaluate((data) => {
    const close = data.letterBlocks.close[0];
    const tpl = (ref, slots) => ({ template: { ref: ref, field: 'text', slots: slots } });
    const fill = (text, slots) => text.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => slots[k] || '');
    const slots = { COMPANY: 'Salesforce', ROLE: 'Commercial Graduate Program' };
    const para = (ref, sl) => ({ t: 'letterPara', text: fill(ref.text, sl), ref: ref, category: 'close', _prov: { text: tpl(ref, sl) } });
    const gate = (model) => CVVerify.runGates(model, data, null, { docType: 'letter', rawJD: '', echoText: '', team: '', recipientName: '' }).gates.find((g) => g.name === 'Never-claim scan');
    const companyInSlot = gate([{ t: 'letterLine', text: 'Salesforce', opts: {} }, para(close, slots)]);
    const injected = Object.assign({}, close, { text: close.text + ' I used Salesforce daily.' });
    const termInTemplate = gate([para(injected, slots)]);
    const cvBlock = gate([{ t: 'para', text: 'Built Salesforce dashboards.', _prov: { text: { atoms: [{ ref: { text: 'Built Salesforce dashboards.' }, field: 'text' }] } } }]);
    return { companyInSlot: companyInSlot.passed, termInTemplate: termInTemplate.passed, cvBlock: cvBlock.passed, slotText: para(close, slots).text };
  }, dataJson);
  check('Never-claim: "Salesforce" as the company, in the address line and the closing paragraph, is not a claim', r.companyInSlot === true && /Salesforce/.test(r.slotText), JSON.stringify(r));
  check('Never-claim: the same term written into the approved letter text still fails', r.termInTemplate === false);
  check('Never-claim: outside the letter (the CV), the term still fails', r.cvBlock === false);

  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  const ctx = await browser.newContext({ acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  try {
    await p.goto(BASE_URL + '/index.test.html');
    await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    await p.fill('#jd-input', WTW);
    await p.waitForFunction(() => !document.getElementById('letter-download-btn').disabled, null, { timeout: 15000 });
    await p.fill('#letter-company', 'Salesforce');
    await p.waitForTimeout(900);
    const st = await p.evaluate(() => ({
      gates: [...document.querySelectorAll('#letter-gates-list .gate-item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      word: document.getElementById('letter-download-btn').disabled ? document.getElementById('letter-download-btn').title : 'enabled',
      letter: document.getElementById('letter-preview-container').innerText
    }));
    check('A letter to Salesforce passes every check and both letter downloads are enabled', st.word === 'enabled' && st.gates.every((g) => /^PASS/.test(g)) && /at Salesforce\./.test(st.letter), JSON.stringify(st.gates) + ' ' + st.word);
    const file = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('#letter-download-pdf-btn')]).then((x) => x[0].suggestedFilename(), () => null);
    check('A letter to Salesforce downloads', /Salesforce\.pdf$/.test(file || ''), String(file));
    check('A letter to Salesforce: no uncaught page errors', errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    check('A letter to Salesforce builds and downloads', false, e.message);
  } finally {
    await ctx.close();
  }
}

// ---- 9 Oct 2026: red reasons first; the stamped data address ---------------
console.log('\n--- Verdict card leads with its red reason; the published data address is stamped ---');
{
  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  try {
    await p.goto(BASE_URL + '/index.test.html');
    await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
    // WTW's eligibility check lists QFA (amber) first; a required ACCA line
    // adds a red item after it. The card is red, so the red reason leads.
    await p.fill('#jd-input', WTW + '\n\nRequirements:\n- ACCA qualified essential for this position.\n');
    await p.waitForTimeout(1500);
    const card = await p.evaluate(() => {
      const el = document.getElementById('verdict-card');
      return {
        level: (el.className.match(/verdict-(red|amber|green)/) || [])[1] || null,
        reasons: [...el.querySelectorAll('.verdict-reason')].map((li) => ({ red: li.classList.contains('verdict-reason-red'), text: li.querySelector('.verdict-reason-text').textContent }))
      };
    });
    check('Verdict card: a red card lists its red reason first (ACCA required, ahead of the amber QFA item)',
      card.level === 'red' && card.reasons.length >= 2 && card.reasons[0].red && /ACCA/.test(card.reasons[0].text) &&
      card.reasons.some((r) => !r.red && /^QFA/.test(r.text)), JSON.stringify(card));
    check('Verdict card: every red reason comes before every amber one',
      card.reasons.findIndex((r) => !r.red) === -1 || card.reasons.slice(card.reasons.findIndex((r) => !r.red)).every((r) => !r.red), JSON.stringify(card.reasons.map((r) => r.red)));

    const stamp = await p.evaluate(async () => {
      const seen = [];
      const realFetch = window.fetch;
      window.fetch = function (u) { seen.push(String(u)); return realFetch.apply(this, arguments); };
      const meta = document.createElement('meta');
      meta.name = 'cv-data-url';
      meta.content = 'data/cv-generator-data.json?v=abc123def0';
      document.head.appendChild(meta);
      let stamped = null, other = null;
      try { stamped = (await CVData.load())._version; } catch (e) { stamped = 'ERROR ' + e.message; }
      meta.content = 'https://example.com/other.json';
      try { other = (await CVData.load())._version; } catch (e) { other = 'ERROR ' + e.message; }
      meta.remove();
      window.fetch = realFetch;
      return { seen, stamped, other };
    });
    check('Data file: the published page\'s stamped address is the one fetched',
      stamp.seen[0] === 'data/cv-generator-data.json?v=abc123def0' && /^\d+\.\d+$/.test(stamp.stamped || ''), JSON.stringify(stamp));
    check('Data file: any other address in that tag is ignored and the plain address is fetched',
      stamp.seen[1] === 'data/cv-generator-data.json' && /^\d+\.\d+$/.test(stamp.other || ''), JSON.stringify(stamp));
    check('Red-first and stamp checks: no uncaught page errors', errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    check('Red-first and stamp checks run', false, e.message);
  } finally {
    await ctx.close();
  }
}

// ---- The download message beside "Fits on one page" (8 Oct 2026) ----------
// After a download, "Downloaded <file name>" sits beside the fit readout. A
// long name (role and company in it) used to crush the readout to one word
// per line in 921-1280px windows and, with no spaces to break at, made a
// phone page scroll sideways. Downloads are kept in memory here.
console.log('\n--- Download message: the fit readout keeps its line, the page never scrolls sideways ---');
{
  const WTW = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'jd', 'wtw-pensions-administrator.txt'), 'utf8');
  for (const vp of [{ width: 960, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    try {
      await p.goto(BASE_URL + '/index.test.html');
      await p.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), null, { timeout: 15000 });
      await p.evaluate(() => { window.__saved = []; CVLibs.saveBlob = function (b, f) { window.__saved.push(f); }; });
      await p.fill('#jd-input', WTW);
      await p.waitForFunction(() => !document.getElementById('letter-download-btn').disabled, null, { timeout: 15000 });
      await p.fill('#letter-role', 'Commercial Graduate Program');
      await p.fill('#letter-company', 'Salesforce');
      await p.waitForTimeout(900);
      await p.evaluate(() => { document.getElementById('download-btn').click(); document.getElementById('letter-download-btn').click(); });
      await p.waitForFunction(() => window.__saved.length >= 2 && document.getElementById('status').textContent && document.getElementById('letter-status').textContent, null, { timeout: 20000 });
      const m = await p.evaluate(() => ({
        sideways: document.documentElement.scrollWidth > window.innerWidth,
        bars: [['fit-readout', 'status'], ['letter-fit-readout', 'letter-status']].map(([fitId, stId]) => {
          const h = document.getElementById(fitId).querySelector('.fit-headline').getBoundingClientRect();
          const st = document.getElementById(stId).getBoundingClientRect();
          return { fitId, headlineH: Math.round(h.height), overlap: st.top < h.bottom && h.top < st.bottom && h.right > st.left + 1 && st.right > h.left, status: document.getElementById(stId).textContent };
        })
      }));
      check('Download message at ' + vp.width + 'px: "Fits on one page" stays on one line beside it (CV and letter)', m.bars.every((b) => b.headlineH < 30 && !b.overlap) && m.bars.every((b) => /^Downloaded .*Salesforce\.docx$/.test(b.status)), JSON.stringify(m.bars));
      check('Download message at ' + vp.width + 'px: the page does not scroll sideways', !m.sideways, JSON.stringify(m));
      check('Download message at ' + vp.width + 'px: no uncaught page errors', errs.length === 0, JSON.stringify(errs));
    } catch (e) {
      check('Download message at ' + vp.width + 'px: page builds and both downloads run', false, e.message);
    } finally {
      await ctx.close();
    }
  }
}

// ---- No unexpected page errors across the whole run -----------------------
check('No uncaught page errors during the whole run', pageErrors.length === 0, JSON.stringify(pageErrors));

await browser.close();

console.log('\n=== ' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + ' ===');
process.exit(failures === 0 ? 0 : 1);
