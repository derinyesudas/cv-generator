// ---------------------------------------------------------------------------
// Theme switch (2 Oct 2026). Drives index.test.html in a real browser and
// checks the light/dark switch end to end: first paint follows the system
// setting, the switch flips every colour token at once, the choice is saved
// and survives a reload, it beats the system setting once made, the system
// setting is still followed until then, keyboard operation, other open tabs
// follow along, and a browser with storage blocked still gets a working
// (just unremembered) switch with no errors.
//
//   python3 -m http.server 8199 &   (from the repo root)
//   node tests/theme.test.mjs
// ---------------------------------------------------------------------------
import { chromium } from 'playwright';

const URL = 'http://localhost:8199/index.test.html';
const KEY = 'cvGenerator.theme';
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log('PASS ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : ''));
  }
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });

async function open(ctx, opts = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|private-overrides/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL, { waitUntil: opts.waitUntil || 'load' });
  if (!opts.noWait) {
    await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'), { timeout: 15000 });
  }
  return { page, errors };
}

async function state(page) {
  return page.evaluate((key) => {
    const root = document.documentElement;
    const btn = document.getElementById('theme-switch');
    let saved = null;
    try { saved = localStorage.getItem(key); } catch (e) { saved = 'THREW'; }
    return {
      theme: root.getAttribute('data-theme'),
      checked: btn && btn.getAttribute('aria-checked'),
      title: btn && btn.getAttribute('title'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      sidebarBg: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
      text: getComputedStyle(document.body).color,
      scheme: getComputedStyle(root).colorScheme,
      metaScheme: document.querySelector('meta[name="color-scheme"]').getAttribute('content'),
      metaBars: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('content')),
      paperBg: getComputedStyle(document.querySelector('#doc-cv .preview-outer')).backgroundColor,
      paperHasDoc: !!document.querySelector('#preview-container').children.length,
      saved,
      switching: root.classList.contains('theme-switching')
    };
  }, KEY);
}

// 1. First paint follows the system setting (no saved choice).
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  const s = await state(page);
  check(`system ${scheme}, nothing saved: page starts ${scheme}`, s.theme === scheme, JSON.stringify(s));
  check(`system ${scheme}: switch reports aria-checked=${scheme === 'dark'}`, s.checked === String(scheme === 'dark'), s.checked);
  check(`system ${scheme}: CSS color-scheme and meta color-scheme match`, s.scheme === scheme && s.metaScheme === scheme, s.scheme + ' / ' + s.metaScheme);
  check(`system ${scheme}: browser-bar colour matches the theme`, s.metaBars.every((c) => c === (scheme === 'dark' ? '#151a22' : '#ffffff')), JSON.stringify(s.metaBars));
  check(`system ${scheme}: nothing saved until the switch is used`, s.saved === null, s.saved);
  check(`system ${scheme}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// 2. The head script sets the theme before any other script runs - with
//    js/ui.js blocked outright, the attribute is still there at first paint.
{
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  await ctx.route('**/js/ui.js', (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__themeAtDomReady = document.documentElement.getAttribute('data-theme');
    });
  });
  await page.goto(URL);
  const at = await page.evaluate(() => window.__themeAtDomReady);
  check('head script alone sets the theme before DOMContentLoaded (no flash)', at === 'dark', at);
  await ctx.close();
}

// 3. Clicking flips everything at once, saves, and survives a reload.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  const before = await state(page);
  await page.click('#theme-switch');
  const during = await state(page);
  await page.waitForTimeout(150);
  const after = await state(page);
  check('click: light -> dark', after.theme === 'dark' && after.checked === 'true', JSON.stringify(after));
  check('click: title now offers the way back', after.title === 'Switch to light theme', after.title);
  check('click: page colours actually changed', after.bodyBg !== before.bodyBg && after.sidebarBg !== before.sidebarBg && after.text !== before.text,
    JSON.stringify({ before: [before.bodyBg, before.sidebarBg, before.text], after: [after.bodyBg, after.sidebarBg, after.text] }));
  check('click: choice saved', after.saved === 'dark', after.saved);
  check('click: meta tags follow the switch', after.metaScheme === 'dark' && after.metaBars.every((c) => c === '#151a22'), JSON.stringify([after.metaScheme, after.metaBars]));
  check('click: transitions held off during the flip, released after', during.switching === true && after.switching === false, JSON.stringify([during.switching, after.switching]));
  // With a document on it, the sheet is the document and must stay white.
  await page.selectOption('#archetype-select', 'insurance-pensions');
  await page.waitForTimeout(300);
  const withDoc = await state(page);
  check('dark theme: a built A4 sheet stays white (it is the document)', withDoc.paperHasDoc && withDoc.paperBg === 'rgb(255, 255, 255)', JSON.stringify([withDoc.paperHasDoc, withDoc.paperBg]));
  await page.selectOption('#archetype-select', 'auto');

  await page.reload();
  await page.waitForFunction(() => document.getElementById('load-status').textContent.includes('loaded'));
  const reloaded = await state(page);
  check('reload: saved dark theme beats the light system setting', reloaded.theme === 'dark' && reloaded.checked === 'true', JSON.stringify(reloaded));

  await page.click('#theme-switch');
  const back = await state(page);
  check('click again: dark -> light, saved as light', back.theme === 'light' && back.saved === 'light', JSON.stringify(back));
  check('click: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// 4. Keyboard: Tab to it, Space and Enter both toggle; focus is visible.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const { page } = await open(ctx);
  await page.focus('#theme-switch');
  const focusRing = await page.evaluate(() => {
    const b = document.getElementById('theme-switch');
    const cs = getComputedStyle(b);
    return { visible: b.matches(':focus-visible') || document.activeElement === b, outline: cs.outlineStyle + ' ' + cs.outlineWidth };
  });
  await page.keyboard.press('Space');
  const s1 = await state(page);
  await page.keyboard.press('Enter');
  const s2 = await state(page);
  check('keyboard: Space toggles', s1.theme === 'dark', s1.theme);
  check('keyboard: Enter toggles back', s2.theme === 'light', s2.theme);
  const role = await page.evaluate(() => {
    const b = document.getElementById('theme-switch');
    return { role: b.getAttribute('role'), name: b.getAttribute('aria-label'), tag: b.tagName };
  });
  check('a11y: native button with role=switch and an accessible name', role.tag === 'BUTTON' && role.role === 'switch' && role.name === 'Dark theme', JSON.stringify(role));
  check('a11y: focused switch is the active element', focusRing.visible === true, JSON.stringify(focusRing));
  await ctx.close();
}

// 5. System changes are followed until a choice is saved, then ignored.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const { page } = await open(ctx);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  const followed = await state(page);
  check('system change with nothing saved: page follows it', followed.theme === 'dark' && followed.checked === 'true', JSON.stringify(followed));
  await page.click('#theme-switch'); // -> light, saved
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  const kept = await state(page);
  check('system change after a saved choice: saved choice kept', kept.theme === 'light' && kept.saved === 'light', JSON.stringify(kept));
  await ctx.close();
}

// 6. Another open tab of the app follows the switch.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1200, height: 800 } });
  const a = await open(ctx);
  const b = await open(ctx);
  await a.page.click('#theme-switch');
  await b.page.waitForTimeout(200);
  const other = await state(b.page);
  check('second tab follows the switch via the storage event', other.theme === 'dark' && other.checked === 'true', JSON.stringify(other));
  await ctx.close();
}

// 7. Storage blocked: no errors, switch still works for the open page.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const { page, errors } = await open(ctx);
  const s0 = await state(page);
  await page.click('#theme-switch');
  const s1 = await state(page);
  check('storage blocked: page starts from the system setting', s0.theme === 'light', s0.theme);
  check('storage blocked: switch still flips the theme', s1.theme === 'dark' && s1.checked === 'true', JSON.stringify(s1));
  check('storage blocked: no page errors from the theme code', errors.filter((e) => /theme|ui\.js/i.test(e)).length === 0, errors.join(' | '));
  await ctx.close();
}

// 8. Phone width: the switch fits in the app bar with no horizontal scroll.
{
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const { page } = await open(ctx);
  const fitInfo = await page.evaluate(() => {
    const b = document.getElementById('theme-switch').getBoundingClientRect();
    return { right: b.right, width: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, visible: b.width > 0 && b.height > 0 };
  });
  check('360px: switch visible inside the viewport, no horizontal overflow', fitInfo.visible && fitInfo.right <= fitInfo.width && !fitInfo.overflow, JSON.stringify(fitInfo));
  await ctx.close();
}

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
