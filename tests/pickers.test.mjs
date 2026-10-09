// ---------------------------------------------------------------------------
// Section dropdowns (2 Oct 2026): step 4 (CV sections) and step 7 (Letter
// paragraphs), driven in the real page. Checks that every section offers
// its approved versions with the automatic pick marked Recommended, that
// hovering (or arrowing to) an option previews it on the page beside the
// sidebar without committing anything, that leaving puts the committed
// page back exactly, that clicking/Enter commits and rebuilds, and that
// every option of every dropdown, across the real fixture ads, builds a
// document that passes the same gates as the automatic one, and that no
// letter quotes the same line from the ad twice (3 Oct 2026).
//
//   python3 -m http.server 8199 &   (repo root)
//   node tests/pickers.test.mjs
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}
const fixture = (n) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/jd', n + '.txt'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8199/index.test.html');
await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), { timeout: 15000 });
// The dropdowns live in the collapsed "Change sections and settings" panel
// (8 Oct 2026): open it the way a user would.
check('the section dropdowns start tucked away in the collapsed adjust panel', await page.evaluate(() => !document.getElementById('panel-adjust').open));
await page.click('#panel-adjust > summary');

async function paste(text) {
  await page.fill('#jd-input', text);
  await page.waitForTimeout(1000);
}
function pickerButton(host, label) {
  return page.locator(`#${host} .picker`).filter({ has: page.locator('.picker-label', { hasText: label }) }).first().locator('.picker-button');
}
const openList = () => page.locator('.picker-list:not([hidden])');
async function snapshot() {
  return page.evaluate(() => ({
    cvHtml: document.getElementById('preview-container').innerHTML,
    letterHtml: document.getElementById('letter-preview-container').innerHTML,
    cvReadout: document.getElementById('fit-readout').textContent,
    letterReadout: document.getElementById('letter-fit-readout').textContent,
    cvPreviewing: document.getElementById('doc-cv').classList.contains('is-previewing'),
    letterPreviewing: document.getElementById('doc-letter').classList.contains('is-previewing'),
    cvChanged: document.querySelectorAll('#preview-container .pv-changed').length,
    letterChanged: document.querySelectorAll('#letter-preview-container .pv-changed').length,
    cvTag: document.getElementById('doc-cv-title').getAttribute('data-preview'),
    state: CVApp._test.getSectionState()
  }));
}

// --- 1. What the panels offer ------------------------------------------------
await paste(fixture('wtw-pensions-administrator'));
const labels = await page.evaluate(() => ({
  cv: [...document.querySelectorAll('#cv-pickers .picker-label')].map((e) => e.textContent),
  letter: [...document.querySelectorAll('#letter-pickers .picker-label')].map((e) => e.textContent),
  faces: [...document.querySelectorAll('#cv-pickers .picker-face, #letter-pickers .picker-face')].map((e) => e.textContent)
}));
check('CV sections: profile, skill categories and roles have dropdowns',
  ['Profile paragraph', 'Skill categories', 'Roles shown'].every((l) => labels.cv.includes(l)), JSON.stringify(labels.cv));
check('Letter paragraphs: type, why, quoted line, wording, both evidence paragraphs and gap have dropdowns',
  ['Letter type', 'Why this role', 'Line quoted from the ad', 'Quote wording', 'First evidence paragraph', 'Second evidence paragraph', 'Gap paragraph'].every((l) => labels.letter.includes(l)), JSON.stringify(labels.letter));
check('every dropdown starts on its Recommended option', labels.faces.every((f) => /Recommended/.test(f)), JSON.stringify(labels.faces));
const base = await snapshot();
check('the letter quotes its recommended line on its own (no click needed)', !!base.state.echoText && base.state.echoCandidates.includes(base.state.echoText), base.state.echoText);

// --- 2. Hover previews, Escape reverts ----------------------------------------
await pickerButton('cv-pickers', 'Profile paragraph').click();
await page.waitForTimeout(300);
const statuses = await openList().locator('.picker-status:not([hidden])').allTextContents();
check('opening a list shows a fit verdict on every option', statuses.length === 8 && statuses.every((t) => /Fits|Too long|Blocked/.test(t)), JSON.stringify(statuses));
const optionCount = await openList().locator('.picker-option').count();
let hoverIndex = -1;
for (let i = 0; i < optionCount; i++) {
  if ((await openList().locator('.picker-option').nth(i).getAttribute('aria-selected')) === 'false') { hoverIndex = i; break; }
}
await openList().locator('.picker-option').nth(hoverIndex).hover();
await page.waitForTimeout(500);
const hovered = await snapshot();
check('hover: the CV beside the sidebar shows the option', hovered.cvPreviewing && hovered.cvHtml !== base.cvHtml, JSON.stringify({ previewing: hovered.cvPreviewing }));
check('hover: the changed text is highlighted', hovered.cvChanged >= 1, String(hovered.cvChanged));
check('hover: readout and document bar say it is a preview', /^Preview:/.test(hovered.cvReadout) && /^Preview:/.test(hovered.cvTag || ''), JSON.stringify([hovered.cvReadout, hovered.cvTag]));
check('hover: nothing is committed', JSON.stringify(hovered.state.cvChoices) === '{}', JSON.stringify(hovered.state.cvChoices));
await page.mouse.move(1000, 500); // off the list, towards the page
await page.waitForTimeout(300);
check('moving the mouse off the open list keeps the preview up', (await snapshot()).cvPreviewing);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const reverted = await snapshot();
check('Escape: the committed CV comes back exactly', !reverted.cvPreviewing && reverted.cvHtml === base.cvHtml && reverted.cvReadout === base.cvReadout && reverted.cvTag === null,
  JSON.stringify({ previewing: reverted.cvPreviewing, same: reverted.cvHtml === base.cvHtml, readout: reverted.cvReadout }));
check('Escape returns focus to the dropdown button', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('picker-button')));

// --- 3. Keyboard: arrows preview, Enter commits ---------------------------------
await page.keyboard.press('ArrowDown'); // opens
await page.waitForTimeout(200);
check('ArrowDown on the button opens the list', await openList().count() === 1);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(400);
const arrowed = await snapshot();
check('arrowing to another option previews it', arrowed.cvPreviewing && arrowed.cvChanged >= 1);
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const committed = await snapshot();
check('Enter commits the option', !!committed.state.cvChoices.profile && committed.state.cvChoices.profile !== committed.state.cvAuto.profile, JSON.stringify(committed.state.cvChoices));
check('after committing, the page is no longer a preview and the gates still pass',
  !committed.cvPreviewing && await page.evaluate(() => [...document.querySelectorAll('#gates-list .gate-item')].every((li) => /PASS/.test(li.textContent))));
check('the dropdown now reads "Your pick" and "Back to recommended" appears',
  /Your pick/.test(await pickerButton('cv-pickers', 'Profile paragraph').textContent()) && await page.isVisible('#cv-pickers-reset'));
await page.click('#cv-pickers-reset');
await page.waitForTimeout(900);
const reset = await snapshot();
check('"Back to recommended" restores every automatic pick', JSON.stringify(reset.state.cvChoices) === '{}' && reset.cvHtml === base.cvHtml && !(await page.isVisible('#cv-pickers-reset')));

// --- 4. Letter: hover, outside click, letter type, no quote ----------------------
await pickerButton('letter-pickers', 'First evidence paragraph').click();
await page.waitForTimeout(300);
const evCount = await openList().locator('.picker-option').count();
for (let i = 0; i < evCount; i++) {
  if ((await openList().locator('.picker-option').nth(i).getAttribute('aria-selected')) === 'false') { await openList().locator('.picker-option').nth(i).hover(); break; }
}
await page.waitForTimeout(600);
const lh = await snapshot();
check('letter hover previews the paragraph in the letter and highlights it', lh.letterPreviewing && lh.letterChanged >= 1 && lh.letterHtml !== base.letterHtml);
await page.mouse.click(1000, 120);
await page.waitForTimeout(400);
const lr = await snapshot();
check('a click elsewhere closes the list and restores the letter', !lr.letterPreviewing && lr.letterHtml === base.letterHtml && await openList().count() === 0);

await pickerButton('letter-pickers', 'Letter type').click();
await page.waitForTimeout(300);
await openList().locator('.picker-option').filter({ hasText: 'Close-match letter' }).click();
await page.waitForTimeout(900);
const cm = await page.evaluate(() => ({
  letter: document.getElementById('letter-preview-container').textContent,
  disabled: [...document.querySelectorAll('#letter-pickers .picker')].filter((p) => p.classList.contains('picker-fixed')).map((p) => p.querySelector('.picker-label').textContent),
  gates: [...document.querySelectorAll('#letter-gates-list .gate-item')].map((li) => li.textContent.trim()),
  notice: document.getElementById('letter-notice').hidden ? '' : document.getElementById('letter-notice').textContent
}));
check('choosing Close-match rewrites the letter in close-match shape', /Reading this ad, the respons/.test(cm.letter), cm.letter.slice(0, 300));
check('close-match: paragraphs it doesn\'t use are greyed out with a reason', ['Why this role', 'Line quoted from the ad', 'First evidence paragraph', 'Second evidence paragraph', 'Gap paragraph'].every((l) => cm.disabled.includes(l)), JSON.stringify(cm.disabled));
check('close-match letter still passes every gate', cm.gates.length === 5 && cm.gates.every((g) => /PASS/.test(g)), JSON.stringify(cm.gates));
await page.click('#letter-pickers-reset');
await page.waitForTimeout(800);

await pickerButton('letter-pickers', 'Line quoted from the ad').click();
await page.waitForTimeout(300);
await openList().locator('.picker-option').filter({ hasText: 'No quote' }).click();
await page.waitForTimeout(900);
const nq = await snapshot();
check('"No quote" removes the quote and uses the no-quote paragraph', nq.state.echoText === '' && /What you have described is close to the work/.test(nq.letterHtml), nq.state.echoText);
check('"Quote wording" is greyed out when nothing is quoted', await page.evaluate(() => {
  var p = [...document.querySelectorAll('#letter-pickers .picker')].find((x) => x.querySelector('.picker-label').textContent === 'Quote wording');
  return !!p && p.classList.contains('picker-fixed');
}));

// --- 4b. Quoted lines drop a leading label (3 Oct 2026) -------------------------
const labelCases = await page.evaluate(() => {
  var q = CVLetterBuild.quoteForm;
  var cases = [
    ['Reporting: Produces regular administration reports for clients, trustees, and senior management.', 'Produces regular administration reports for clients, trustees, and senior management'],
    ['- Stakeholder Engagement & Communication: Work closely with internal teams to deliver results.', 'Work closely with internal teams to deliver results'],
    ['Co-ordination: Liaise with clients to confirm data receipt.', 'Liaise with clients to confirm data receipt'],
    ['Note: SQL is a plus.', 'SQL is a plus'],
    ['Location: Dublin.', 'Location: Dublin'],
    ['Data Analysis: SQL, Python.', 'Data Analysis: SQL, Python'],
    ['The successful candidate will have the following: strong Excel skills.', 'The successful candidate will have the following: strong Excel skills'],
    ['9:00am start, Monday to Friday, in the Dublin office.', '9:00am start, Monday to Friday, in the Dublin office'],
    ['reporting: produces reports for clients every week.', 'reporting: produces reports for clients every week']
  ];
  return cases.map(function (c) { return { input: c[0], want: c[1], got: q(c[0]) }; }).filter(function (c) { return c.got !== c.want; });
});
check('a quoted line drops a leading label ("Reporting: ...") only when four or more words follow, and nothing else changes',
  labelCases.length === 0, JSON.stringify(labelCases));
await paste(fixture('sigmar-customer-service-representative-night')); // a different ad first, so WTW starts fresh (section 4 left "No quote" picked)
await paste(fixture('wtw-pensions-administrator'));
const wtwQuote = await snapshot();
check('WTW: the auto-picked quote starts at the duty itself, not its label, and is still word for word from the ad',
  wtwQuote.state.echoText === 'Produces regular administration reports for clients, trustees, and senior management' &&
  fixture('wtw-pensions-administrator').includes(wtwQuote.state.echoText) && !/"Reporting:/.test(wtwQuote.letterHtml),
  wtwQuote.state.echoText);

// --- 4c. The automatic quote skips the employer talking about itself (8 Oct 2026)
const selfTalk = await page.evaluate(() => {
  var pick = CVLetterBuild.pickEchoAuto, self = CVLetterBuild.employerTalksAboutItself;
  var company = { text: "With offices in Belfast, Galway, and Dublin, we've embraced hybrid work, empowering our people to work flexibly", rank: 1 };
  var duty = { text: 'Review and assess claims and keep customers updated', rank: 2 };
  return {
    skipsCompany: (pick([company, duty]) || {}).text === duty.text,
    noneLeft: pick([company]) === null,
    usCase: !self('Support US and UK clients with monthly reporting') && self('Join us in shaping the future of claims'),
    pronouns: ['We are hiring a claims handler', "We're growing fast", 'Our team handles claims', 'deliver great service to our customers'].every(self)
  };
});
check('the automatic quote skips a line where the employer talks about itself and takes the next one', selfTalk.skipsCompany);
check('when only such lines are left, no line is quoted automatically (the letter uses its no-quote paragraph)', selfTalk.noneLeft);
check('"we", "we\'re", "our" count as the employer talking; upper-case "US" (the country) does not', selfTalk.pronouns && selfTalk.usCase, JSON.stringify(selfTalk));

// --- 5. Resets: new ad, archetype change -----------------------------------------
await paste(fixture('netapp-fpa-intern'));
check('a different ad starts every section on its recommended option again',
  JSON.stringify((await snapshot()).state.letterChoices) === '{}');

// --- 6. Never-claim: multi-word terms written with hyphens --------------------
// On 2 Oct 2026 the scan was found to miss "anomaly-detection" in one approved
// variant (b-report-presentation), which the Davy Group business-analyst ad
// auto-picked. Derin had that variant deleted on 3 Oct 2026 (data 1.27). The
// gate fix stays, so it is checked here against an injected copy of the old
// wording: a future hyphenated term can't slip through the same way.
const davy = fs.readFileSync(path.join(ROOT, 'tests/golden/real-jds/business-analyst__Davy_Group.txt'), 'utf8');
await paste(davy);
await page.selectOption('#archetype-select', 'business-analyst');
await page.waitForTimeout(900);
const davyState = await snapshot();
check('Davy BA ad: the CV prints no "anomaly" wording and b-report has no dropdown (one approved variant left)',
  davyState.state.cvAuto.bullets['b-report'] === 'b-report-full' && !/anomaly/i.test(davyState.cvHtml) &&
  !(await page.locator('#cv-pickers .picker-label').allTextContents()).some((t) => /Stock Market Manipulation Detection, bullet 2/.test(t)),
  davyState.state.cvAuto.bullets['b-report']);
const nc = await page.evaluate(() => {
  var data = JSON.parse(JSON.stringify(CVApp._test.getLoadedData()));
  var dirty = "Wrote and structured the project presentation, translating the team's anomaly-detection output into a clear narrative for a non-specialist audience.";
  var r = {};
  r.dataClean = JSON.stringify(data.bulletVariants).indexOf("anomaly-detection") === -1 && data.bulletVariants['b-report'].variants.length === 1;
  r.termListed = data.neverClaim.indexOf('anomaly detection') !== -1;
  r.plainScanMisses = CVMatcher.scanList(dirty, data.neverClaim).length === 0;
  r.gateCatches = CVVerify.neverClaimScan(dirty, data.neverClaim).indexOf('anomaly detection') !== -1;
  var full = data.bulletVariants['b-report'].variants[0];
  var tags = full.tags.concat(['non-technical audience']);
  var hits = {};
  tags.forEach(function (t) { hits[t.toLowerCase()] = true; });
  data.bulletVariants['b-report'].variants.push({ id: 'b-report-injected', tags: tags, text: dirty });
  r.autoSkipsDirty = CVAssemble.autoPicks(data, 'business-analyst', { keywordHits: hits }).bullets['b-report'] === 'b-report-full';
  // control: the same injected variant with clean wording wins on its extra tag
  data.bulletVariants['b-report'].variants[1].text = "Wrote the presentation that took the team's findings to a non-technical audience.";
  r.cleanTwinWins = CVAssemble.autoPicks(data, 'business-analyst', { keywordHits: hits }).bullets['b-report'] === 'b-report-injected';
  return r;
});
check('the old "anomaly-detection" wording is gone from the data file, the term is still on the never-claim list',
  nc.dataClean && nc.termListed, JSON.stringify(nc));
check('an injected hyphenated never-claim term: the plain scan misses it, the never-claim gate catches it',
  nc.plainScanMisses && nc.gateCatches, JSON.stringify(nc));
check('an injected hyphenated never-claim term: the automatic pick skips it even when its tags would win (control: a clean twin does win)',
  nc.autoSkipsDirty && nc.cleanTwinWins, JSON.stringify(nc));

// --- 7. Every option of every dropdown builds a document that passes the gates ---
const sweep = await page.evaluate((fixtures) => {
  var data = CVApp._test.getLoadedData();
  var problems = [];
  var built = 0;
  function fitToPage(model) {
    var fit = CVPageFit.measure(model, 'cv');
    var n = 0;
    while (fit.overflows && n < 200) {
      var step = CVTrim.applyOneStep(model);
      if (!step.applied) break;
      model = step.model;
      CVAssemble.fixLastParagraphSpacing(model);
      fit = CVPageFit.measure(model, 'cv');
      n++;
    }
    return { model: model, fit: fit };
  }
  fixtures.forEach(function (jd) {
    var extraction = CVScore.extractFromJD(data, jd);
    var archetypeId = CVScore.pickArchetype(data, extraction).winner.archetype.id;
    var options = [];
    data.profileVariants.forEach(function (v) { options.push({ profile: v.id }); });
    data.archetypes.forEach(function (a) { options.push({ skills: a.id }); options.push({ roles: a.id }); });
    Object.keys(data.bulletVariants).forEach(function (gid) {
      data.bulletVariants[gid].variants.forEach(function (v) { var b = {}; b[gid] = v.id; options.push({ bullets: b }); });
    });
    options.forEach(function (choices) {
      var model = CVAssemble.buildModel(data, archetypeId, { excludeFactIds: ['vol'], extraction: extraction, choices: choices });
      var f = fitToPage(model);
      var gates = CVVerify.runGates(f.model, data, f.fit);
      built++;
      if (!gates.passed) problems.push({ choices: choices, archetypeId: archetypeId, failed: gates.gates.filter(function (g) { return !g.passed; }).map(function (g) { return g.name + ': ' + g.findings.join(' | ').slice(0, 160); }) });
    });
  });
  return { built: built, problems: problems };
}, ['wtw-pensions-administrator', 'netapp-fpa-intern', 'ornua-graduate-trainee', 'sigmar-customer-service-representative-night', 'standard-life-pensions-investments-administrator', 'softco-document-processing-administrator'].map(fixture));
check(`every CV dropdown option, on 6 real ads (${sweep.built} builds), passes every gate`,
  sweep.problems.length === 0, JSON.stringify(sweep.problems.slice(0, 4)));

const letterSweep = await page.evaluate((fixtures) => {
  var data = CVApp._test.getLoadedData();
  var problems = [];
  var repeats = [];
  var quotedOnce = 0;
  var built = 0;
  var yrs = CVExperience.computeExperience(data).yearsRelevant;
  fixtures.forEach(function (jd) {
    var extraction = CVScore.extractFromJD(data, jd);
    var archetypeId = CVScore.pickArchetype(data, extraction).winner.archetype.id;
    var cands = CVLetterBuild.buildEchoCandidates(data, jd, yrs);
    var lb = data.letterBlocks;
    var choicesList = [{}, { mode: 'standard' }, { mode: 'closeMatch' }, { why: 'none' }, { evidence: 'none' }, { evidence2: 'none' }, { gap: 'none' }];
    lb.why.forEach(function (e) { if (e.isEchoFrame) choicesList.push({ echoFrame: e.id }); else if (!e.isEchoFallback) choicesList.push({ why: e.id }); });
    lb.evidence.forEach(function (e) { choicesList.push({ evidence: e.id }); choicesList.push({ evidence2: e.id }); });
    lb.gap.forEach(function (e) { if (e.text) choicesList.push({ gap: e.id }); });
    var echoes = [''].concat(cands.map(function (c) { return c.text; }));
    echoes.forEach(function (echoText) {
      choicesList.forEach(function (choices) {
        var built1 = CVLetter.buildLetterContentModel(data, {
          archetypeId: archetypeId, extraction: extraction, rawJD: jd, yearsRelevant: yrs,
          company: 'Test Company', role: 'Test Role', team: '', recipientName: '', city: 'Dublin',
          echoText: echoText, titleMismatch: false, fitCheckGapTrigger: 'none', refereeName: '', hardReqGapIds: [], choices: choices
        });
        built++;
        var fit = CVPageFit.measure(built1.model, 'letter');
        var gates = CVVerify.runGates(built1.model, data, fit, { docType: 'letter', rawJD: jd, echoText: echoText, team: '', recipientName: '' });
        var text = built1.model.map(function (b) { return b.text || ''; }).join('\n');
        var bad = /\{\{|\}\}|\.\.|"\.|\.",|  |\bundefined\b|\bnull\b/.test(text);
        if (!gates.passed || bad) problems.push({ echo: echoText.slice(0, 40), choices: choices, failed: gates.gates.filter(function (g) { return !g.passed; }).map(function (g) { return g.name; }), bad: bad });
        if (echoText) {
          var times = text.split(echoText).length - 1;
          if (times > 1) repeats.push({ echo: echoText.slice(0, 40), choices: choices, times: times });
          else if (times === 1) quotedOnce++;
        }
      });
    });
  });
  return { built: built, problems: problems, repeats: repeats, quotedOnce: quotedOnce };
}, ['wtw-pensions-administrator', 'netapp-fpa-intern', 'sigmar-customer-service-representative-night', 'standard-life-pensions-investments-administrator', 'softco-document-processing-administrator'].map(fixture));
check(`every letter dropdown option x every quotable line, on 5 real ads (${letterSweep.built} builds), passes every gate with clean punctuation (no '..', '".', '.",' or double spaces)`,
  letterSweep.problems.length === 0, JSON.stringify(letterSweep.problems.slice(0, 4)));
check(`no letter quotes the same line from the ad twice (${letterSweep.quotedOnce} builds quote a line, each exactly once)`,
  letterSweep.repeats.length === 0 && letterSweep.quotedOnce > 0, JSON.stringify(letterSweep.repeats.slice(0, 4)));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
