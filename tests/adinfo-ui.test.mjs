// ---------------------------------------------------------------------------
// Auto-filled letter details, in the real page (2 Oct 2026). Pastes real
// fixture ads into index.test.html and checks that company/role/city/team/
// start date fill themselves in, say where they came from, leave Derin's
// own edits alone, start over for a different ad, and raise an alert and a
// notification for anything the ad doesn't give.
//
//   python3 -m http.server 8199 &   (repo root)
//   node tests/adinfo-ui.test.mjs
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8199/index.test.html');
await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), { timeout: 15000 });

const IDS = ['letter-company', 'letter-role', 'letter-city', 'letter-team', 'letter-recipient-name', 'jd-start-date'];
async function state() {
  return page.evaluate((ids) => {
    const out = {};
    ids.forEach((id) => {
      const src = document.getElementById(id + '-source');
      out[id] = { value: document.getElementById(id).value, source: src ? src.textContent : null, state: src ? src.getAttribute('data-state') : null };
    });
    const status = document.getElementById('adinfo-status');
    out.status = status.hidden ? '' : status.textContent;
    out.toast = document.getElementById('toast-region').textContent;
    const dl = document.getElementById('letter-download-btn');
    out.letterDl = { disabled: dl.disabled, title: dl.title };
    return out;
  }, IDS);
}
async function paste(text) {
  await page.fill('#jd-input', text);
  await page.waitForTimeout(900);
}
const fixture = (n) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/jd', n + '.txt'), 'utf8');

// 1. WTW: everything the letter needs is in the ad.
await paste(fixture('wtw-pensions-administrator'));
let s = await state();
check('WTW: company read from the ad and tidied', s['letter-company'].value === 'WTW' && /WTW \(Willis Towers Watson\)/.test(s['letter-company'].source), JSON.stringify(s['letter-company']));
check('WTW: role read and title-cased', s['letter-role'].value === 'Pensions Administrator' && s['letter-role'].state === 'ad', JSON.stringify(s['letter-role']));
check('WTW: city read from the location line', s['letter-city'].value === 'Dublin', JSON.stringify(s['letter-city']));
check('WTW: absent team/recipient/start date explained, not flagged', s['letter-team'].state === 'none' && s['letter-recipient-name'].state === 'none' && s['jd-start-date'].state === 'none', JSON.stringify([s['letter-team'], s['letter-recipient-name'], s['jd-start-date']]));
check('WTW: step 6 says the details are filled in; no notification', /filled in/.test(s.status) && s.toast === '', JSON.stringify([s.status, s.toast]));
check('WTW: letter downloadable with nothing typed by hand', s.letterDl.disabled === false, JSON.stringify(s.letterDl));

// 2. A hand edit survives an edit to the same ad.
await page.fill('#letter-company', 'Willis Towers Watson');
await page.waitForTimeout(300);
await paste(fixture('wtw-pensions-administrator') + '\nOne more line added to the same ad.');
s = await state();
check('hand-typed company kept when the same ad is edited', s['letter-company'].value === 'Willis Towers Watson' && s['letter-company'].state === 'typed', JSON.stringify(s['letter-company']));

// 3. A different ad starts over and flags what is missing.
await paste(fixture('standard-life-pensions-investments-administrator'));
s = await state();
check('different ad: hand-typed company replaced by the new ad\'s', s['letter-company'].value === 'Standard Life' && s['letter-company'].state === 'ad', JSON.stringify(s['letter-company']));
check('Standard Life: city not in the ad -> empty and marked missing', s['letter-city'].value === '' && s['letter-city'].state === 'missing', JSON.stringify(s['letter-city']));
check('Standard Life: step 6 alert names the city', /Not found in this ad: city/.test(s.status), s.status);
check('Standard Life: a notification names the city', /Couldn't find the city/.test(s.toast), s.toast);
await page.click('#toast-region .toast-action');
await page.waitForTimeout(500);
const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
check('notification "Fill in" goes to the missing field', focused === 'letter-city', focused);
check('notification closes once used', (await state()).toast === '');

// 4. NetApp: team and start date, both word for word from the ad.
await paste(fixture('netapp-fpa-intern'));
s = await state();
check('NetApp: team read word for word', s['letter-team'].value === 'Financial Planning & Analysis team', JSON.stringify(s['letter-team']));
check('NetApp: start date read (month and year)', s['jd-start-date'].value === 'January 2027', JSON.stringify(s['jd-start-date']));
const docs = await page.evaluate(() => ({
  cv: document.getElementById('preview-container').textContent,
  letter: document.getElementById('letter-preview-container').textContent
}));
check('NetApp: CV right-to-work line names the ad\'s start', /and for a January 2027 start\./.test(docs.cv), docs.cv.slice(0, 300));
check('NetApp: letter opening names role, team and company', /I am applying for the FP&A Intern role with the Financial Planning & Analysis team at NetApp\./.test(docs.letter), docs.letter.slice(0, 400));

// 5. No company in the ad: alert, notification, letter download blocked.
await paste('Claims Processor\n\nResponsibilities\n- Process insurance claims accurately against service level agreements.\n- Answer customer queries by phone and email.');
s = await state();
check('no company: field empty and marked missing', s['letter-company'].value === '' && s['letter-company'].state === 'missing', JSON.stringify(s['letter-company']));
check('no company: notification names the company name', /company name/.test(s.toast), s.toast);
check('no company: letter download blocked with the reason', s.letterDl.disabled === true && /no company name/.test(s.letterDl.title), JSON.stringify(s.letterDl));
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check('Escape dismisses the notification', (await state()).toast === '');
await page.fill('#letter-company', 'Acme Claims');
await page.waitForTimeout(600);
s = await state();
check('typing the missing company unblocks the letter and drops it from the alert (city still listed)', s.letterDl.disabled === false && !/company name/.test(s.status) && /city/.test(s.status), JSON.stringify([s.letterDl, s.status]));

// 6. Clearing the ad clears what it filled in.
await paste('');
s = await state();
check('cleared ad: auto-filled fields emptied, status hidden',
  IDS.every((id) => s[id].value === '' || s[id].state === 'typed') && s.status === '', JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
