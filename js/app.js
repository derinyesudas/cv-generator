// ---------------------------------------------------------------------------
// Page logic, shared by index.html and index.test.html (the sandbox test
// copy) - one file, so the two pages cannot disagree. Both load the same
// lib/ files; index.test.html adds one extra line after this file to wire
// its Playwright test hook into the CVApp._test surface this file always
// exposes (harmless and unused on index.html).
//
// This file also carries three other 13 Sept 2026 review fixes that only
// make sense at the page level, not inside score.js/assemble.js themselves:
//
//   1. Data-file validation on load (js/validate.js) - refuses to proceed
//      past a broken data file instead of failing partway through whichever
//      archetype happens to get built first.
//   2. A model "stamp" (archetype id + a hash of the JD text + the data
//      file's own _version) recorded alongside every successfully-built
//      model. Before this, a build failure (e.g. the customer-ops crash the
//      review found) left the OLD model on screen while the archetype
//      dropdown/label had already moved on to the new selection - a
//      silent, plausible-looking WRONG document. Now: a failed build is
//      caught, shown as a visible on-screen error, and never swaps in a
//      stale model under a new label; and updatePreview() itself refuses
//      to render whenever the current model's stamp doesn't match the
//      current JD text / archetype / data version, as a second line of
//      defence against any code path that might otherwise reach it.
//   3. A "no archetype matched" state: if every archetype scores 0 against
//      the pasted JD, the app does not silently fall back to whichever
//      archetype wins the priority tie-break - it refuses to auto-build and
//      asks for a manual choice from the dropdown instead.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var loadedData = null;
  var lastGateResult = null;
  var lastPick = null; // last CVScore.pickArchetype() result, for the readout
  var currentArchetypeId = null;
  var currentModel = null;
  var currentStamp = null; // { archetypeId, jdHash, dataVersion } for whatever currentModel actually is
  var dataErrors = null; // CVValidate.validateData() result, or null before the first check
  // Phase 6 additions: lastExtraction is set on every recompute() (even a
  // noMatch one - the fit check's verdict/findings/keyword table only need
  // the JD text and data file, not a chosen archetype). lastFitCheck/
  // lastTrimLog are set only when updatePreview() actually runs (i.e. a
  // model was successfully built) and are what handleAuditExport() and the
  // fit-check test hooks read.
  var lastExtraction = null;
  var lastFitCheck = null;
  var lastTrimLog = null;

  // Hard-requirement ineligibility alert (30 Sept 2026, additive - see
  // js/hardreq.js's own file header). lastHardReq is CVHardReq.run()'s own
  // return value, refreshed on every recompute() regardless of verdict.
  // hardReqBuildAnywayConfirmed + hardReqConfirmedJdHash together record a
  // one-JD-at-a-time override: clicking "Build anyway" on a RED verdict
  // confirms building THIS pasted JD text specifically, never "RED verdicts
  // in general" - the instant the JD text changes (a new hash), the
  // confirmation no longer applies and a new RED verdict blocks again,
  // exactly the same one-shot-per-input shape js/app.js's own currentStamp
  // staleness check already uses elsewhere in this file. lastHardReqGapIds
  // is the (at most two) gapBlockId values recomputeLetter() passes through
  // to js/letterbuild.js's buildHardReqGapBlock - populated only when a
  // build actually proceeds past a RED verdict (see recompute() below).
  var lastHardReq = null;
  var hardReqBuildAnywayConfirmed = false;
  var hardReqConfirmedJdHash = null;
  var lastHardReqGapIds = [];

  // Cover-letter state (21 Sept 2026, cover-letter renderer). Mirrors the
  // CV's own currentModel/lastGateResult pairing, kept separate rather than
  // folded into the CV's variables - a letter can fail to build (an
  // invalid TEAM, say) independently of the CV succeeding, and the two
  // download buttons are independently gated.
  var currentLetterModel = null;
  var lastLetterResult = null; // CVLetterBuild.buildLetterModel's own return (echoCandidates, gapTrigger)
  var lastLetterGateResult = null;
  // Set when the letter could not be built (an error anywhere in the
  // rebuild), so the letter's download buttons say why instead of keeping
  // whatever reason they showed before. Cleared at the start of every rebuild.
  var letterBuildError = null;
  var selectedEchoText = ''; // '' = no ECHO chosen; must exactly match one of lastLetterResult.echoCandidates[].text

  // Per-section choices (2 Oct 2026, the section dropdowns - see the
  // "Section dropdowns" block further down). Derin's own picks for the
  // current ad; empty = every section on its automatic pick. Both reset when
  // a different ad is pasted, and the CV's when the archetype changes.
  //   cvChoices:     { profile, skills, roles, bullets: { groupId: variantId } }
  //   letterChoices: { mode, why, echo, echoFrame, evidence, gap }
  //     echo: undefined = auto (the top-ranked line, Derin's 2 Oct answer),
  //     'none', or the exact text of one echo candidate.
  var cvChoices = {};
  var letterChoices = {};
  var lastCvAuto = null; // CVAssemble.autoPicks() for the current archetype + ad
  var lastAssembledModel = null; // the committed CV before trimming - which bullet groups are in play
  var lastStartDateOpt = null; // the startDate option the committed CV was built with
  var lastCvFit = null; // committed CV's fit, for the preview readout to fall back to
  var lastLetterBase = null; // everything the committed letter was built from except choices/echo
  var lastLetterAuto = null; // { mode, why, echoFrame, evidence, gap } picked automatically for this letter
  // privateOverrides: the referee's name and the salary figures, which are
  // never in the site or its repository. Kept only in this browser's
  // storage (PRIVATE_OVERRIDES_LS_KEY), entered in the Private settings
  // form or imported from a private-overrides.json file (shape:
  // data/private-overrides.example.json); nothing is ever uploaded. Since
  // 8 Oct 2026 the page no longer fetches data/private-overrides.json: the
  // file never exists on the live site, so the fetch only ever logged a
  // 404. Keys read: refereeName (the letter's REFEREE slot) and
  // salaryRanges (renderFormAnswers()'s salary answer).
  var privateOverrides = {};
  var PRIVATE_OVERRIDES_LS_KEY = 'cvGenerator.privateOverrides';

  // Both wrapped in try/catch: localStorage can throw (privacy mode,
  // storage disabled by policy, quota) and this feature must degrade to
  // "behaves as if nothing was ever loaded", never break the rest of the
  // app.
  function loadPrivateOverridesFromLocalStorage() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(PRIVATE_OVERRIDES_LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('privateOverrides: could not read localStorage - ' + err.message);
      return null;
    }
  }
  function savePrivateOverridesToLocalStorage(overrides) {
    try {
      global.localStorage.setItem(PRIVATE_OVERRIDES_LS_KEY, JSON.stringify(overrides));
      return true;
    } catch (err) {
      console.warn('privateOverrides: could not write localStorage - ' + err.message);
      return false;
    }
  }
  function salaryFigureCount(overrides) {
    var ranges = (overrides && overrides.salaryRanges) || {};
    return Object.keys(ranges).filter(function (k) { return k.charAt(0) !== '_' && String(ranges[k] || '').trim(); }).length;
  }
  // 9 Oct 2026 privacy pass: details that must never sit in the public data
  // file are kept in this browser with the other private settings (imported
  // from a private-overrides.json file) and layered over a copy of the data
  // before validation and before anything is built:
  //   contactPhone     - added to the CV header contact line, after the email
  //   permission       - replaces availability.permission
  //   formAnswers      - { key: answer } replaces formAnswers[key].answer
  //   neverClaimExtra  - terms added to neverClaim (names that must not be public)
  var DATA_LEVEL_KEYS = ['contactPhone', 'permission', 'formAnswers', 'neverClaimExtra'];
  function applyPrivateData(data, ov) {
    if (!data || !ov || typeof ov !== 'object' || !DATA_LEVEL_KEYS.some(function (k) { return k in ov; })) return data;
    var d = JSON.parse(JSON.stringify(data));
    if (typeof ov.contactPhone === 'string' && ov.contactPhone.trim() && d.identity && Array.isArray(d.identity.contact)) {
      var at = -1;
      d.identity.contact.forEach(function (c, i) { if (c && typeof c.link === 'string' && c.link.indexOf('mailto:') === 0) at = i; });
      d.identity.contact.splice(at === -1 ? d.identity.contact.length : at + 1, 0, { text: ov.contactPhone.trim(), link: null });
    }
    if (typeof ov.permission === 'string' && ov.permission.trim() && d.availability) d.availability.permission = ov.permission.trim();
    if (ov.formAnswers && typeof ov.formAnswers === 'object' && d.formAnswers) {
      Object.keys(ov.formAnswers).forEach(function (k) {
        var e = d.formAnswers[k];
        if (e && typeof e === 'object' && !Array.isArray(e) && typeof ov.formAnswers[k] === 'string' && ov.formAnswers[k].trim()) e.answer = ov.formAnswers[k];
      });
    }
    if (Array.isArray(ov.neverClaimExtra) && Array.isArray(d.neverClaim)) {
      ov.neverClaimExtra.forEach(function (t) { if (typeof t === 'string' && t && d.neverClaim.indexOf(t) === -1) d.neverClaim.push(t); });
    }
    return d;
  }

  function renderPrivateSettingsStatus(justSaved) {
    var el = document.getElementById('private-settings-status');
    if (!el) return;
    var bits = [];
    if (privateOverrides && String(privateOverrides.refereeName || '').trim()) bits.push('the referee\'s name');
    var n = salaryFigureCount(privateOverrides);
    if (n) bits.push('a salary figure for ' + n + ' role type' + (n === 1 ? '' : 's'));
    if (privateOverrides && privateOverrides.contactPhone) bits.push('your phone number');
    if (privateOverrides && privateOverrides.permission) bits.push('your permission wording');
    if (privateOverrides && privateOverrides.formAnswers && Object.keys(privateOverrides.formAnswers).length) bits.push('private form answers');
    if (privateOverrides && Array.isArray(privateOverrides.neverClaimExtra) && privateOverrides.neverClaimExtra.length) bits.push('private never-claim terms');
    if (bits.length) {
      el.textContent = (justSaved ? 'Saved. ' : '') + 'This browser has ' + listWords(bits) + '. Another browser or device starts empty.';
    } else {
      el.textContent = (justSaved ? 'Saved. ' : '') + 'Nothing saved in this browser yet: the CV leaves the phone number out, the letter leaves the referee line out, and the salary answer asks for a figure.';
    }
  }

  // The form shows what this browser holds; one salary box per role type
  // the data file names (formAnswers.salaryBucketLabels).
  function renderPrivateSettingsForm() {
    var referee = document.getElementById('private-referee');
    if (referee) referee.value = (privateOverrides && privateOverrides.refereeName) || '';
    var phone = document.getElementById('private-phone');
    if (phone) phone.value = (privateOverrides && privateOverrides.contactPhone) || '';
    var box = document.getElementById('private-salary-fields');
    if (!box || !loadedData) return;
    var labels = (loadedData.formAnswers && loadedData.formAnswers.salaryBucketLabels) || {};
    var ranges = (privateOverrides && privateOverrides.salaryRanges) || {};
    box.innerHTML = '';
    Object.keys(labels).filter(function (k) { return k.charAt(0) !== '_'; }).forEach(function (key) {
      var field = document.createElement('div');
      field.className = 'field';
      var label = document.createElement('label');
      label.setAttribute('for', 'private-salary-' + key);
      label.textContent = labels[key];
      var input = document.createElement('input');
      input.type = 'text';
      input.id = 'private-salary-' + key;
      input.setAttribute('data-bucket', key);
      input.autocomplete = 'off';
      input.value = ranges[key] || '';
      field.appendChild(label);
      field.appendChild(input);
      box.appendChild(field);
    });
  }

  function handlePrivateSettingsSave(ev) {
    if (ev) ev.preventDefault();
    var next = {};
    DATA_LEVEL_KEYS.forEach(function (k) { if (privateOverrides && k in privateOverrides) next[k] = privateOverrides[k]; });
    var referee = document.getElementById('private-referee');
    var name = referee ? referee.value.trim() : '';
    if (name) next.refereeName = name;
    // The phone number box (9 Oct 2026): typed here instead of imported in a
    // file. Empty removes it.
    var phoneBefore = (privateOverrides && privateOverrides.contactPhone) || '';
    var phoneEl = document.getElementById('private-phone');
    if (phoneEl) {
      var phone = phoneEl.value.trim();
      if (phone) next.contactPhone = phone; else delete next.contactPhone;
    }
    var ranges = {};
    Array.prototype.forEach.call(document.querySelectorAll('#private-salary-fields input[data-bucket]'), function (input) {
      var v = input.value.trim();
      if (v) ranges[input.getAttribute('data-bucket')] = v;
    });
    if (Object.keys(ranges).length) next.salaryRanges = ranges;
    privateOverrides = next;
    savePrivateOverridesToLocalStorage(next);
    if ((next.contactPhone || '') !== phoneBefore) {
      var st = document.getElementById('private-settings-status');
      if (st) st.textContent = 'Saved. Reloading to put the phone number on the CV and letter...';
      global.location.reload();
      return;
    }
    renderPrivateSettingsStatus(true);
    renderFormAnswers();
    recomputeLetter();
  }
  function handlePrivateSettingsFile(file) {
    var statusEl = document.getElementById('private-settings-status');
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Could not read "' + file.name + '" - not valid JSON (' + err.message + '). Nothing was changed.';
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (statusEl) statusEl.textContent = 'Could not read "' + file.name + '" - expected a JSON object (see data/private-overrides.example.json), got something else. Nothing was changed.';
        return;
      }
      privateOverrides = Object.assign({}, privateOverrides, parsed);
      savePrivateOverridesToLocalStorage(privateOverrides);
      if (DATA_LEVEL_KEYS.some(function (k) { return k in parsed; })) {
        if (statusEl) statusEl.textContent = 'Private details imported - reloading to apply them...';
        global.location.reload();
        return;
      }
      renderPrivateSettingsForm();
      renderPrivateSettingsStatus(true);
      // Referee name and salary figures both feed rendered output (letter
      // referee block, form-answers salary row) - re-run both so the
      // newly-loaded values show up immediately without needing another
      // keystroke or archetype change.
      renderFormAnswers();
      recomputeLetter();
    };
    reader.onerror = function () {
      if (statusEl) statusEl.textContent = 'Could not read "' + file.name + '" from disk. Nothing was changed.';
    };
    reader.readAsText(file);
  }

  // --- tiny non-cryptographic string hash, good enough to detect "the JD
  // text changed since this model was built" without storing the whole
  // string twice. ---
  function simpleHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  function jdInputEl() { return document.getElementById('jd-input'); }
  function archetypeSelectEl() { return document.getElementById('archetype-select'); }
  function startDateInputEl() { return document.getElementById('jd-start-date'); }

  function inputsNow() {
    var sel = archetypeSelectEl();
    var overridden = sel.value !== 'auto';
    var startDateEl = startDateInputEl();
    return { jdText: jdInputEl().value, overridden: overridden, selValue: sel.value, startDateText: (startDateEl && startDateEl.value || '').trim() };
  }

  // --- Cover-letter form inputs (21 Sept 2026) -----------------------------
  function letterInputsNow() {
    var companyEl = document.getElementById('letter-company');
    var roleEl = document.getElementById('letter-role');
    var teamEl = document.getElementById('letter-team');
    var recipientNameEl = document.getElementById('letter-recipient-name');
    var cityEl = document.getElementById('letter-city');
    var titleMismatchEl = document.getElementById('letter-title-mismatch');
    return {
      company: (companyEl && companyEl.value || '').trim(),
      role: (roleEl && roleEl.value || '').trim(),
      team: (teamEl && teamEl.value || '').trim(),
      recipientName: (recipientNameEl && recipientNameEl.value || '').trim(),
      city: (cityEl && cityEl.value || '').trim(),
      titleMismatch: !!(titleMismatchEl && titleMismatchEl.checked)
    };
  }

  // --- Ad details, read automatically (2 Oct 2026) -------------------------
  // Derin, verbatim: "I don't want to manually fill the details in the
  // cover letter... I will only paste the job description... In case you
  // don't find, alert... that you didn't find the company name or any other
  // similar information."
  //
  // Every time the ad text changes, js/adinfo.js reads company, role, city,
  // team, recipient name and start date out of it and the matching fields
  // are filled in - except a field Derin has edited himself since this ad
  // was pasted, which is left exactly as he typed it. Pasting a different
  // ad (most of the text replaced, not an edit to it) starts over: every
  // field is read afresh from the new ad. Nothing the ad doesn't give is
  // ever guessed: each field says where its value came from (or that the ad
  // didn't give one), step 6 carries an alert naming what is missing, and a
  // notification pops up when a newly pasted ad leaves the company, role or
  // city empty. Team, recipient name and start date still go through the
  // same word-for-word validators as before (js/letterbuild.js), so a value
  // read here can never get past a check a typed one couldn't.
  var AD_FIELDS = [
    { key: 'company', id: 'letter-company', label: 'company name', alert: true,
      none: 'Not found in the ad. The letter\'s opening line names the company - type it here.' },
    { key: 'role', id: 'letter-role', label: 'role title', alert: true,
      none: 'Not found in the ad. The letter\'s opening line names the role - type it here.' },
    { key: 'city', id: 'letter-city', label: 'city', alert: true,
      none: 'Not found in the ad. Optional: the address block just leaves the line out.' },
    { key: 'team', id: 'letter-team', label: 'team', alert: false,
      none: 'No team named in the ad, so the letter addresses the company.' },
    { key: 'recipientName', id: 'letter-recipient-name', label: 'recipient name', alert: false,
      none: 'No contact named in the ad, so the letter opens "Dear Hiring Team,".' },
    { key: 'startDate', id: 'jd-start-date', label: 'start date', alert: false,
      none: 'No start date stated in the ad.' }
  ];
  var adTypedByHand = {}; // field key -> true once Derin edits it for the current ad
  var lastAdText = null; // the ad text applyAdInfo() last read (null before the first read)
  var lastAdInfo = null; // CVAdInfo.extract() result for lastAdText

  // "Different ad" = more than half the text replaced (a fresh paste over
  // the old one), as opposed to an edit inside the same ad. Cheap: common
  // prefix and suffix, no diff library needed for this one question.
  function isDifferentAd(prev, next) {
    var a = String(prev || '');
    var b = String(next || '');
    if (!a.trim() || !b.trim()) return a.trim() !== b.trim();
    var max = Math.max(a.length, b.length);
    var p = 0;
    while (p < a.length && p < b.length && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    var q = 0;
    while (q < a.length - p && q < b.length - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
    return (max - p - q) > max * 0.5;
  }

  function applyAdInfo(jdText) {
    if (!global.CVAdInfo) return;
    if (lastAdText !== null && jdText === lastAdText) return; // same ad (e.g. archetype changed) - nothing to re-read
    var newAd = lastAdText === null ? !!String(jdText).trim() : isDifferentAd(lastAdText, jdText);
    if (newAd) {
      adTypedByHand = {};
      cvChoices = {};
      letterChoices = {};
    }
    lastAdText = jdText;
    try {
      lastAdInfo = global.CVAdInfo.extract(jdText);
    } catch (err) {
      console.error(err);
      lastAdInfo = null;
    }
    AD_FIELDS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (!el || adTypedByHand[f.key]) return;
      var hit = lastAdInfo && lastAdInfo[f.key];
      var value = hit && hit.value ? hit.value : '';
      if (el.value !== value) el.value = value;
    });
    renderAdInfo();
    if (newAd) notifyMissingAdInfo();
  }

  function adFieldState(f) {
    var jd = lastAdText || '';
    if (adTypedByHand[f.key]) return 'typed';
    if (!jd.trim()) return '';
    var hit = lastAdInfo && lastAdInfo[f.key];
    if (hit && hit.value) return 'ad';
    return f.alert ? 'missing' : 'none';
  }

  function missingAdFields() {
    return AD_FIELDS.filter(function (f) {
      var el = document.getElementById(f.id);
      return f.alert && adFieldState(f) === 'missing' && el && !el.value.trim();
    });
  }

  function shorten(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
  }

  // One line under each field saying where its value came from.
  function renderAdInfo() {
    AD_FIELDS.forEach(function (f) {
      var note = document.getElementById(f.id + '-source');
      if (!note) return;
      var state = adFieldState(f);
      note.setAttribute('data-state', state);
      note.textContent = '';
      if (!state) return;
      // One inline span after the icon, so label and quote wrap as text.
      var body = document.createElement('span');
      body.className = 'source-body';
      if (state === 'typed') {
        body.textContent = 'Typed by you.';
      } else if (state === 'ad') {
        var hit = lastAdInfo[f.key];
        var from = hit.raw && hit.raw !== hit.value ? hit.raw : hit.from;
        appendParts(body, [['From the ad', 'source-label'], [': "' + shorten(from, 90) + '"', 'source-text']]);
      } else {
        body.textContent = f.none;
      }
      note.appendChild(body);
    });
    var status = document.getElementById('adinfo-status');
    if (!status) return;
    var jd = lastAdText || '';
    if (!jd.trim()) {
      status.hidden = true;
      status.textContent = '';
      return;
    }
    var missing = missingAdFields();
    var notes = (lastAdInfo && lastAdInfo.notes) || [];
    status.textContent = '';
    status.hidden = false;
    if (missing.length) {
      status.className = 'adinfo-status adinfo-missing';
      appendParts(status, [['Not found in this ad', 'adinfo-head'], [': ' + listWords(missing.map(function (f) { return f.label; })) + '. Type ' + (missing.length > 1 ? 'them' : 'it') + ' in below.', 'adinfo-text']]);
    } else {
      status.className = 'adinfo-status adinfo-found';
      appendParts(status, [['Company, role and city are filled in', 'adinfo-head'], ['. Check them against the ad and edit anything that reads wrong.', 'adinfo-text']]);
    }
    notes.forEach(function (n) {
      var p = document.createElement('span');
      p.className = 'adinfo-note';
      p.textContent = n;
      status.appendChild(p);
    });
  }

  function listWords(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  // Pop-up notice for a newly pasted ad that left company/role/city empty.
  function notifyMissingAdInfo() {
    var missing = missingAdFields();
    if (!missing.length) return;
    var labels = missing.map(function (f) { return f.label; });
    showToast({
      tone: 'warn',
      title: 'Couldn\'t find the ' + listWords(labels) + ' in this ad',
      text: 'Fill ' + (missing.length > 1 ? 'them' : 'it') + ' in under Details from the ad.',
      actionLabel: 'Fill in',
      action: function () {
        var el = document.getElementById(missing[0].id);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.focus({ preventScroll: true });
      }
    });
  }

  // Minimal toast: one region, newest replaces any older one, dismissed by
  // its own button, by Escape, or after 12 seconds. aria-live polite so a
  // screen reader hears it without it stealing focus.
  var toastTimer = null;
  function showToast(opts) {
    var region = document.getElementById('toast-region');
    if (!region) return;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    region.textContent = '';
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (opts.tone || 'info');
    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    toast.appendChild(icon);
    var body = document.createElement('div');
    body.className = 'toast-body';
    var title = document.createElement('p');
    title.className = 'toast-title';
    title.textContent = opts.title;
    body.appendChild(title);
    if (opts.text) {
      var text = document.createElement('p');
      text.className = 'toast-text';
      text.textContent = opts.text;
      body.appendChild(text);
    }
    toast.appendChild(body);
    var actions = document.createElement('div');
    actions.className = 'toast-actions';
    function close() {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    if (opts.action) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-secondary btn-sm toast-action';
      go.textContent = opts.actionLabel || 'Show';
      go.addEventListener('click', function () { close(); opts.action(); });
      actions.appendChild(go);
    }
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
    x.addEventListener('click', close);
    actions.appendChild(x);
    toast.appendChild(actions);
    region.appendChild(toast);
    document.addEventListener('keydown', onKey);
    toastTimer = setTimeout(close, 12000);
  }

  // --- Salary-answer detection rules (26 Sept 2026, item 3 of Derin's
  // three-item reply - "Decisions are final; no need to ask back"), both
  // used only by renderFormAnswers() below.
  //
  // detectAdStatesSalary: rule (a) - "if the ad states a salary or range,
  // the form answer uses 'In line with the advertised range' and never
  // outputs a bucket figure." Shape-only heuristic, same discipline as
  // js/validate.js's privacy-shape patterns - not an exhaustive parse of
  // every way an ad might phrase a figure. Deliberately biased toward false
  // positives over false negatives: a false positive here just shows a
  // still-true generic answer instead of a specific bucket figure; a false
  // negative would show a possibly-stale bucket figure when the ad already
  // named a real one. Three independent shapes, any one is enough:
  // currency symbol adjacent to a 2-3 digit figure (with an optional
  // thousands separator), a bare number near "per annum"/"p.a."/"per
  // year"/"annual salary"/"salary of"/"salary range"/"compensation of", or
  // the word salary/remuneration/compensation near a number.
  function detectAdStatesSalary(jdText) {
    var text = String(jdText || '');
    if (!text) return false;
    var CURRENCY_NEAR_DIGITS = /[€£$]\s?\d{2,3}([,.]\d{3})?/;
    var PER_ANNUM_NEAR_DIGITS = /\b\d{2,3}([,.]\d{3})?\s?(k)?\b[^.]{0,40}\b(per annum|p\.?a\.?|per year|annual salary|salary of|salary range|compensation of)\b/i;
    var SALARY_WORD_NEAR_DIGITS = /\b(salary|remuneration|compensation)\b[^.]{0,40}[€£$]?\s?\d{2,3}([,.]\d{3})?/i;
    return CURRENCY_NEAR_DIGITS.test(text) || PER_ANNUM_NEAR_DIGITS.test(text) || SALARY_WORD_NEAR_DIGITS.test(text);
  }

  // detectOutsideDublinCork: rule (b) - "if the role is outside Dublin and
  // Cork and the bucket is claims/admin, use €32,000 - €36,000." Reads only
  // the hand-typed letter City field, never the raw JD prose - this
  // project has repeatedly found free-text location inference unreliable
  // for anything more specific than section headings (see js/segment.js's
  // own header). An empty City field means "we don't know" and must NOT
  // trigger the regional rule - never guess a location nobody typed.
  function detectOutsideDublinCork(cityText) {
    var c = String(cityText || '').trim();
    if (!c) return false;
    var lc = c.toLowerCase();
    return lc.indexOf('dublin') === -1 && lc.indexOf('cork') === -1;
  }

  // --- Presentation helpers (1 Oct 2026 redesign) -------------------------
  // appendLabelled (1 Oct 2026 redesign): writes "LABEL — text" as three
  // spans (label / " — " separator / text) instead of one text node, purely
  // so css/app.css can style the label as a status pill. The element's
  // textContent comes out character-for-character identical to the old
  // single-string version - the golden suite and e2e harnesses read
  // textContent (e.g. /- a stretch\.$/ on the fit-check verdict), so this
  // must never add, drop or reorder a single character.
  function appendParts(parent, parts) {
    parts.forEach(function (p) {
      if (!p[0]) return;
      var span = document.createElement('span');
      span.className = p[1];
      span.textContent = p[0];
      parent.appendChild(span);
    });
  }
  function appendLabelled(parent, label, text, labelClass, sepClass, textClass) {
    appendParts(parent, [[label, labelClass], [' — ', sepClass], [text, textClass]]);
  }
  // Same idea for a sentence that was already built as one string starting
  // with a known label ("STRETCH — ...", "BLOCKED: ..."): split it back into
  // label / separator / rest without changing a character.
  function setLabelledText(el, label, fullText, prefix) {
    el.textContent = '';
    if (fullText.indexOf(label) !== 0) { el.textContent = fullText; return; }
    var rest = fullText.slice(label.length);
    var m = /^( — |: )/.exec(rest);
    var sep = m ? m[1] : '';
    appendParts(el, [[label, prefix + '-label'], [sep, prefix + '-sep'], [rest.slice(sep.length), prefix + '-text']]);
  }

  // setFitReadout (1 Oct 2026 redesign): the page-fit readout as a short
  // headline ("Fits on one page" / "Overflows by Npx") plus the detail
  // figures, with --fill (height used / budget) for css/app.css's page-fill
  // meter. Same numbers as before, rounded - the safety margin used to print
  // unrounded (e.g. "16.733333333333334px"). Display only: the fit decision
  // itself is CVPageFit.measure()'s, untouched.
  function setFitReadout(el, fits, fit, headline, detail) {
    el.textContent = '';
    appendParts(el, [[headline, 'fit-headline'], [' ', 'fit-gap'], [detail, 'fit-detail']]);
    // The arithmetic is kept for anyone who hovers, not shown (audit item 6).
    el.title = detail;
    var ratio = fit.usableHeightPx > 0 ? Math.max(0, Math.min(1, fit.heightPx / fit.usableHeightPx)) : 0;
    el.style.setProperty('--fill', ratio.toFixed(3));
    el.className = 'fit-readout ' + (fits ? 'fit-good' : 'fit-bad');
  }

  // --- Build-error banner: the visible-error half of fix #2 above. --------
  function showBuildError(message) {
    var el = document.getElementById('build-error');
    el.textContent = message;
    el.hidden = false;
  }
  function clearCvPreview() {
    var container = document.getElementById('preview-container');
    if (container) container.innerHTML = '';
    var readout = document.getElementById('fit-readout');
    if (readout) { readout.textContent = ''; readout.className = 'fit-readout'; }
    var gates = document.getElementById('gates-list');
    if (gates) gates.innerHTML = '';
    var trim = document.getElementById('trim-log');
    if (trim) { trim.hidden = true; trim.innerHTML = ''; }
    var status = document.getElementById('status');
    if (status) status.textContent = '';
    clearPickers('cv');
  }
  function clearBuildError() {
    var el = document.getElementById('build-error');
    el.hidden = true;
    el.textContent = '';
  }

  // --- Data-file validation panel (fix #1). --------------------------------
  function showValidationErrors(errors) {
    var panel = document.getElementById('validation-errors');
    panel.innerHTML = '';
    var heading = document.createElement('div');
    heading.className = 'validation-heading';
    heading.textContent = 'Data file failed validation (' + errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ') - refusing to build any CV until these are fixed:';
    panel.appendChild(heading);
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e;
      ul.appendChild(li);
    });
    panel.appendChild(ul);
    panel.hidden = false;
  }
  function clearValidationErrors() {
    document.getElementById('validation-errors').hidden = true;
    document.getElementById('validation-errors').innerHTML = '';
  }

  // --- Fit-check panel (Phase 6, spec section 6): verdict band, findings
  // (each quoting the ad sentence it matched), and the keyword table. Never
  // touches download-button state - a BLOCKED verdict is information, not a
  // gate (spec, verbatim: "Never refuse to generate... I have applied to
  // BLOCKED roles deliberately before"). ---------------------------------
  function renderFitCheck(result) {
    var verdictEl = document.getElementById('fitcheck-verdict');
    verdictEl.className = 'fitcheck-verdict fitcheck-' + result.verdict.toLowerCase();
    var verdictText = result.verdict;
    if (result.verdict === 'STRETCH') {
      verdictText += ' — ' + result.stretchReasons.join(' ');
    } else if (result.verdict === 'BLOCKED') {
      // 21 Sept 2026, Derin's own instruction after the Clyde & Co fixture:
      // "Never refuse to generate" stands - this file still never touches
      // the download button for a BLOCKED verdict (see file header). What
      // changes is that a BLOCKED verdict must not be missable: it quotes
      // the exact blocking line(s) verbatim, right here in the top banner,
      // not just "see findings below" - so the one piece of information
      // that actually matters (which sentence in the ad is the hard bar) is
      // visible without reading the findings list at all.
      var blockedQuotes = result.findings
        .filter(function (f) { return f.severity === 'block'; })
        .map(function (f) { return '"' + f.quote + '"'; });
      verdictText += ': ' + blockedQuotes.join('; ') +
        ' — documents still generate. This is information, not a gate: it never disables the download.';
    } else {
      verdictText += ' — no years-required or missing-tool gap found, and no blocking warning matched.';
    }
    // Surfaced, not scored: the ad seems to ask for experience but gave no
    // parseable figure (data.facts.experienceRule.ambiguousLanguagePattern) -
    // Derin's own rule: say so rather than guess a number or drop it silently.
    if (result.yearsAmbiguous) {
      verdictText += ' Note: this ad seems to ask for years of experience but doesn’t state a figure — not scored, not guessed.';
    }
    // Fix 3 reporting requirement (18-19 Sept 2026): a number was found
    // (e.g. "100 years" of company history) but discarded by every
    // condition segment.js's years extractor applies - distinct from
    // yearsAmbiguous above (no number at all). "No experience requirement
    // detected" here means the extraction actively rejected everything it
    // found, not that nothing was searched.
    if (result.yearsRequiredDiscarded) {
      verdictText += ' Note: no experience requirement detected in this ad — a number was found but discarded (not near an experience word, not in a requirements section, or implausibly high).';
    }
    // Fix 1 reporting requirement (18-19 Sept 2026): "failing open is
    // acceptable; failing open without telling anyone is not" - shown only
    // when NO heading in the whole ad matched segment.js's lists, meaning
    // the whole document was matched as a fallback rather than narrowed to
    // a requirements/responsibilities section.
    if (result.headingsFound === false) {
      verdictText += ' Note: no section headings found in this ad — matched against the full text.';
    }
    setLabelledText(verdictEl, result.verdict, verdictText, 'verdict');

    var findingsEl = document.getElementById('fitcheck-findings');
    findingsEl.innerHTML = '';
    if (!result.findings.length) {
      var none = document.createElement('li');
      none.className = 'fitcheck-finding-none';
      none.textContent = 'No warning patterns matched this job description.';
      findingsEl.appendChild(none);
    } else {
      result.findings.forEach(function (f) {
        var li = document.createElement('li');
        li.className = 'fitcheck-finding fitcheck-finding-' + f.severity;
        var head = document.createElement('div');
        head.className = 'fitcheck-finding-head';
        appendLabelled(head, f.severity.toUpperCase(), f.message, 'finding-label', 'finding-sep', 'finding-text');
        var quote = document.createElement('div');
        quote.className = 'fitcheck-finding-quote';
        quote.textContent = '"' + f.quote + '"';
        li.appendChild(head);
        li.appendChild(quote);
        // Outcome-log summary (14 Sept 2026): prompts only, never changes
        // f.severity above - the log surfaces evidence, it never acts on it.
        // Renders only once a warning's outcomeLog has real entries; today
        // that's none of them, so this stays invisible until Derin adds one.
        if (f.outcomeNote) {
          var note = document.createElement('div');
          note.className = 'fitcheck-finding-outcomenote';
          note.textContent = f.outcomeNote;
          li.appendChild(note);
        }
        findingsEl.appendChild(li);
      });
    }

    fitCheckShown = true;
    renderVerdictCard();

    var tbody = document.getElementById('fitcheck-keywords-body');
    tbody.innerHTML = '';
    result.keywordTable.forEach(function (row) {
      var tr = document.createElement('tr');
      [row.term, row.wanted ? 'yes' : 'no', row.have, row.madeCV ? 'yes' : 'no'].forEach(function (v, i) {
        var td = document.createElement('td');
        td.textContent = v;
        if (i > 0) td.setAttribute('data-v', String(v).toLowerCase()); // styling hook only
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function clearFitCheck() {
    fitCheckShown = false;
    renderVerdictCard();
    var verdictEl = document.getElementById('fitcheck-verdict');
    verdictEl.textContent = '';
    verdictEl.className = 'fitcheck-verdict';
    document.getElementById('fitcheck-findings').innerHTML = '';
    document.getElementById('fitcheck-keywords-body').innerHTML = '';
    var trimPanel = document.getElementById('trim-log');
    trimPanel.hidden = true;
    trimPanel.innerHTML = '';
  }

  // --- Hard-requirement ineligibility alert (30 Sept 2026, additive) -------
  // Rendered into #hardreq-banner, under "Every check in detail"; its verdict
  // and findings are summed up, with the fit check's, in the "Should you
  // apply?" card (renderVerdictCard). Never touches the download
  // buttons itself; js/hardreq.js's file header and this app's own spec
  // are explicit that a RED verdict is surfaced, never a silent refusal -
  // recompute() below is what actually pauses the build pipeline on an
  // unconfirmed RED verdict, this function only ever renders.
  function hardReqBannerEl() { return document.getElementById('hardreq-banner'); }
  function clearHardReqBanner() {
    var el = hardReqBannerEl();
    if (!el) return;
    el.hidden = true;
    el.className = 'hardreq-banner';
    el.innerHTML = '';
    var actions = document.getElementById('hardreq-actions');
    if (actions) actions.hidden = true;
    renderVerdictCard();
  }
  var HARDREQ_VERDICT_LABEL = { RED: 'Likely ineligible', AMBER: 'Check before applying', GREEN: 'No hard-requirement issues found' };
  function renderHardReqBanner(result, jdText) {
    var el = hardReqBannerEl();
    if (!el) return;
    if (!jdText || !String(jdText).trim()) { clearHardReqBanner(); return; }
    el.hidden = false;
    el.className = 'hardreq-banner hardreq-' + result.verdict.toLowerCase();
    el.innerHTML = '';

    var verdictEl = document.createElement('div');
    verdictEl.className = 'hardreq-verdict';
    appendLabelled(verdictEl, result.verdict, HARDREQ_VERDICT_LABEL[result.verdict] || result.verdict, 'verdict-label', 'verdict-sep', 'verdict-text');
    el.appendChild(verdictEl);

    if (result.findings.length) {
      var list = document.createElement('ul');
      list.className = 'hardreq-findings';
      result.findings.forEach(function (f) {
        var li = document.createElement('li');
        li.className = 'hardreq-finding hardreq-finding-' + f.severity;
        var head = document.createElement('div');
        head.className = 'hardreq-finding-head';
        var heldLabel = f.held === false ? 'not held' : (f.held === 'unknown' ? 'unknown whether held' : '');
        appendLabelled(head, f.severity.toUpperCase(), f.label +
          (f.requirementType && f.requirementType !== 'n/a' ? ' (' + f.requirementType + (heldLabel ? ', ' + heldLabel : '') + ')' : (heldLabel ? ' (' + heldLabel + ')' : '')),
          'finding-label', 'finding-sep', 'finding-text');
        var quote = document.createElement('div');
        quote.className = 'hardreq-finding-quote';
        quote.textContent = '"' + f.quote + '"';
        li.appendChild(head);
        li.appendChild(quote);
        if (f.note) {
          var note = document.createElement('div');
          note.className = 'hardreq-finding-note';
          note.textContent = f.note;
          li.appendChild(note);
        }
        list.appendChild(li);
      });
      el.appendChild(list);
    } else {
      var none = document.createElement('div');
      none.className = 'hardreq-finding-none';
      none.textContent = 'No hard-requirement patterns matched this job description.';
      el.appendChild(none);
    }

    var actions = document.getElementById('hardreq-actions');
    if (actions) {
      actions.hidden = result.verdict !== 'RED';
      // Show whether "Build anyway" is already in effect for THIS ad (1 Oct
      // 2026 redesign) - before, nothing on screen changed when it was
      // clicked except the download buttons quietly enabling. Same test as
      // hardReqBlocksDownload(): confirmed, and for this exact JD text.
      var confirmed = !!(hardReqBuildAnywayConfirmed && hardReqConfirmedJdHash === simpleHash(jdText));
      actions.setAttribute('data-confirmed', confirmed ? 'true' : 'false');
      var anywayBtn = document.getElementById('hardreq-build-anyway-btn');
      if (anywayBtn) {
        anywayBtn.setAttribute('aria-pressed', confirmed ? 'true' : 'false');
        anywayBtn.textContent = confirmed ? 'Building anyway' : 'Build anyway';
      }
    }
    renderVerdictCard();
  }

  // --- "Should you apply?" (8 Oct 2026, audit batch 3) ----------------------
  // One answer for the eligibility check (js/hardreq.js) and the fit check
  // (js/fitcheck.js), each reason listed once: a fit-check finding quoting
  // the same ad line as an eligibility finding is not repeated. Both checks
  // still render in full under "Every check in detail"; this only sums them
  // up and changes nothing about what may be downloaded.
  var fitCheckShown = false;
  var lastVerdict = null;
  var VERDICT_TEXT = {
    red: { label: 'Likely not eligible', text: 'The ad asks for something you don\'t have.' },
    amber: { label: 'Check before applying', text: 'Worth applying, but check these first.' },
    green: { label: 'Apply', text: 'Nothing in the ad rules you out.' }
  };
  function hardReqReasonText(f) {
    var held = f.held === false ? 'you don\'t have it' : (f.held === 'unknown' ? 'check whether this applies to you' : '');
    var type = f.requirementType === 'required' ? 'required' : (f.requirementType === 'preferred' ? 'preferred' : (f.requirementType === 'ambiguous' ? 'mentioned' : ''));
    var tail = [type, held].filter(Boolean).join(', ');
    return f.label + (tail ? ': ' + tail : '') + (f.note ? '. ' + f.note : '');
  }
  function computeVerdict() {
    var jd = inputsNow().jdText;
    var banner = hardReqBannerEl();
    var hr = (banner && !banner.hidden && lastHardReq && jd && jd.trim()) ? lastHardReq : null;
    if (!hr) return null;
    var fc = fitCheckShown ? lastFitCheck : null;
    var reasons = [];
    var quoted = {};
    var key = function (q) { return String(q || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    (hr.findings || []).forEach(function (f) {
      reasons.push({ tone: f.severity === 'red' ? 'red' : 'amber', text: hardReqReasonText(f), quote: f.quote || '' });
      if (f.quote) quoted[key(f.quote)] = true;
    });
    if (fc) {
      (fc.stretchReasons || []).forEach(function (t) { reasons.push({ tone: 'amber', text: t, quote: '' }); });
      (fc.findings || []).forEach(function (f) {
        if (f.severity !== 'block' && f.severity !== 'warn') return;
        if (f.quote && quoted[key(f.quote)]) return;
        reasons.push({ tone: f.severity === 'block' ? 'red' : 'amber', text: f.message, quote: f.quote || '' });
        if (f.quote) quoted[key(f.quote)] = true;
      });
    }
    // Red reasons first (9 Oct 2026): a "Likely not eligible" card opens with
    // the reason that made it red, even when that reason came from the fit
    // check after an amber eligibility item. Order within a tone is kept.
    reasons = reasons.filter(function (r) { return r.tone === 'red'; })
      .concat(reasons.filter(function (r) { return r.tone !== 'red'; }));
    var level = 'green';
    if (hr.verdict === 'RED' || (fc && fc.verdict === 'BLOCKED')) level = 'red';
    else if (hr.verdict === 'AMBER' || reasons.length || (fc && fc.verdict === 'STRETCH')) level = 'amber';
    var anyway = hr.verdict === 'RED' && hardReqBuildAnywayConfirmed && hardReqConfirmedJdHash === simpleHash(jd);
    return { level: level, label: VERDICT_TEXT[level].label, text: VERDICT_TEXT[level].text, reasons: reasons, buildingAnyway: anyway };
  }
  function renderVerdictCard() {
    var card = document.getElementById('verdict-card');
    if (!card) return;
    var v = computeVerdict();
    lastVerdict = v;
    card.innerHTML = '';
    if (!v) { card.hidden = true; card.className = 'verdict-card'; return; }
    card.hidden = false;
    card.className = 'verdict-card verdict-' + v.level;
    var head = document.createElement('div');
    head.className = 'verdict-head';
    var pill = document.createElement('span');
    pill.className = 'verdict-pill';
    pill.textContent = v.label;
    var text = document.createElement('span');
    text.className = 'verdict-text';
    text.textContent = v.text;
    head.appendChild(pill);
    head.appendChild(text);
    card.appendChild(head);
    if (v.reasons.length) {
      var list = document.createElement('ul');
      list.className = 'verdict-reasons';
      v.reasons.forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'verdict-reason verdict-reason-' + r.tone;
        var t = document.createElement('span');
        t.className = 'verdict-reason-text';
        t.textContent = r.text;
        li.appendChild(t);
        if (r.quote) {
          var q = document.createElement('span');
          q.className = 'verdict-reason-quote';
          q.textContent = '"' + r.quote + '"';
          li.appendChild(q);
        }
        list.appendChild(li);
      });
      card.appendChild(list);
    }
    if (v.buildingAnyway) {
      var note = document.createElement('p');
      note.className = 'verdict-note';
      note.textContent = 'Building anyway: downloads are unlocked for this ad.';
      card.appendChild(note);
    }
  }

  function handleHardReqBuildAnyway() {
    hardReqBuildAnywayConfirmed = true;
    hardReqConfirmedJdHash = simpleHash(inputsNow().jdText);
    recompute();
  }
  function handleHardReqSkip() {
    var jdEl = jdInputEl();
    if (jdEl) jdEl.value = '';
    hardReqBuildAnywayConfirmed = false;
    hardReqConfirmedJdHash = null;
    recompute();
  }

  // --- Trim-to-fit log (Phase 6, spec section 8): what trimPolicy actually
  // dropped, and whether it ran out of things it's allowed to drop while
  // still overflowing (trimPolicy.order step 5 - "STOP, don't shrink
  // margins/fonts"). Hidden entirely when nothing was trimmed. ------------
  function renderTrimLog(trimLog, fit) {
    var panel = document.getElementById('trim-log');
    if (!trimLog.length) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    panel.hidden = false;
    panel.innerHTML = '';
    // One line on screen (8 Oct 2026, audit item 6); the full record of what
    // trimPolicy shortened or dropped opens from it. Open by default only
    // when the page still overflows, since then it is what to act on.
    var box = document.createElement('details');
    box.className = 'trim-log-box';
    box.open = !!fit.overflows;
    var heading = document.createElement('summary');
    heading.className = 'trim-log-heading';
    heading.textContent = 'Shortened to fit one page: ' + trimLog.length +
      ' change' + (trimLog.length === 1 ? '' : 's');
    box.appendChild(heading);
    var ul = document.createElement('ul');
    trimLog.forEach(function (d) {
      var li = document.createElement('li');
      li.textContent = d;
      ul.appendChild(li);
    });
    box.appendChild(ul);
    panel.appendChild(box);
    if (fit.overflows) {
      var stopped = document.createElement('div');
      stopped.className = 'trim-log-stopped';
      stopped.textContent = "Still overflows after shortening every block that had a .short variant and dropping " +
        "everything filler/support left to drop (it never drops a core or required block, never drops a " +
        "role/project's last remaining bullet without removing the whole entry, and never shrinks margins/fonts) " +
        '— see the fit readout above. Refusing to download; decide what goes by hand.';
      panel.appendChild(stopped);
    }
  }

  function renderGates(result, listElId) {
    var list = document.getElementById(listElId || 'gates-list');
    list.innerHTML = '';
    result.gates.forEach(function (gate) {
      var li = document.createElement('li');
      li.className = 'gate-item ' + (gate.passed ? 'gate-pass' : 'gate-fail');
      var head = document.createElement('div');
      head.className = 'gate-head';
      // Status / separator / name as three spans (1 Oct 2026 redesign) so
      // css/app.css can draw PASS as a tick chip - head.textContent is still
      // exactly "PASS — <name>", which is what the e2e harnesses read.
      appendLabelled(head, gate.passed ? 'PASS' : 'FAIL', gate.name, 'gate-status', 'gate-sep', 'gate-name');
      li.appendChild(head);
      if (!gate.passed) {
        var ul = document.createElement('ul');
        ul.className = 'gate-findings';
        gate.findings.forEach(function (f) {
          var fli = document.createElement('li');
          fli.textContent = f;
          ul.appendChild(fli);
        });
        li.appendChild(ul);
      }
      list.appendChild(li);
    });
  }

  // Hard-requirement ineligibility alert (30 Sept 2026, additive): true
  // whenever the CURRENT pasted JD's own hard-req verdict is RED and
  // "Build anyway" has not been clicked for this exact JD text (see
  // hardReqConfirmedJdHash's own header comment) - this is the one place
  // "RED: do not auto-generate" (spec section 4) actually takes effect; see
  // recompute()'s own comment for why it deliberately does NOT short-
  // circuit the rest of the pipeline above this.
  function hardReqBlocksDownload() {
    return !!(lastHardReq && lastHardReq.verdict === 'RED' &&
      !(hardReqBuildAnywayConfirmed && hardReqConfirmedJdHash === simpleHash(inputsNow().jdText)));
  }

  // PDF buttons (2 Oct 2026) are gated exactly like the .docx ones: same
  // model, same gates, same reasons - mirrored rather than re-derived, so
  // the two can never disagree about whether a document may be downloaded.
  function mirrorDownloadButton(fromId, toId) {
    var from = document.getElementById(fromId);
    var to = document.getElementById(toId);
    if (!from || !to) return;
    to.disabled = from.disabled;
    to.title = from.title;
  }

  function updateDownloadState() {
    updateDocxDownloadState();
    mirrorDownloadButton('download-btn', 'download-pdf-btn');
  }

  function updateDocxDownloadState() {
    var btn = document.getElementById('download-btn');
    var auditBtn = document.getElementById('audit-export-btn');
    if (dataErrors && dataErrors.length) {
      btn.disabled = true;
      btn.title = 'Blocked: the data file failed validation - see the panel above.';
      if (auditBtn) auditBtn.disabled = true;
      return;
    }
    if (hardReqBlocksDownload()) {
      btn.disabled = true;
      btn.title = 'Blocked: the ad asks for something you don\'t have (see Should you apply?). Click "Build anyway" there to download anyway.';
      if (auditBtn) auditBtn.disabled = true;
      return;
    }
    if (!loadedData || !currentModel) {
      btn.disabled = true;
      btn.title = !loadedData ? 'Still loading the data file.' : 'Nothing to download yet: paste a job ad or choose an archetype.';
      if (auditBtn) auditBtn.disabled = true;
      return;
    }
    if (!lastGateResult || !lastGateResult.passed) {
      btn.disabled = true;
      btn.title = 'Blocked: one or more safety gates failed - see the failed gate listed above the page.';
    } else {
      btn.disabled = false;
      btn.title = '';
    }
    if (auditBtn) auditBtn.disabled = !currentModel;
  }

  // --- Cover letter (21 Sept 2026) -----------------------------------------

  function letterNoticeEl() { return document.getElementById('letter-notice'); }

  function showLetterNotice(text) {
    var el = letterNoticeEl();
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }
  function clearLetterNotice() {
    var el = letterNoticeEl();
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }
  // appendLetterNotice (26 Sept 2026, item 3): showLetterNotice() above
  // REPLACES whatever notice is showing - fine for the early-return cases
  // (an invalid TEAM/RECIPIENT NAME, or a build error, each of which is the
  // only thing wrong at that moment), but the referee-omission notice and
  // the pre-existing salutation _pendingReview banner can both be true of
  // the same letter at once, and neither may silently displace the other -
  // "never drop the referee line silently" means the notice has to survive
  // being joined by something else, not just be shown once and then lost.
  function appendLetterNotice(text) {
    var el = letterNoticeEl();
    if (!el) return;
    el.textContent = (!el.hidden && el.textContent) ? el.textContent + ' | ' + text : text;
    el.hidden = false;
  }

  function clearLetterPanel(reasonText) {
    currentLetterModel = null;
    lastLetterResult = null;
    lastLetterGateResult = null;
    clearPickers('letter');
    var gatesEl = document.getElementById('letter-gates-list');
    if (gatesEl) gatesEl.innerHTML = '';
    var readoutEl = document.getElementById('letter-fit-readout');
    if (readoutEl) { readoutEl.textContent = reasonText || ''; readoutEl.className = 'fit-readout'; }
    var container = document.getElementById('letter-preview-container');
    if (container) container.innerHTML = '';
    updateLetterDownloadState();
  }

  // ECHO candidates used to be a radio list here; since 2 Oct 2026 they are
  // the "Line quoted from the ad" dropdown in step 7 (renderLetterPickers).
  // Still a pick-list of the ad's own verbatim sentences, never a text box -
  // the one input path where free text could put a false claim about the
  // employer into a letter (see js/letterbuild.js's file header).

  function updateLetterDownloadState(teamValid, recipientNameValid) {
    updateLetterDocxDownloadState(teamValid, recipientNameValid);
    mirrorDownloadButton('letter-download-btn', 'letter-download-pdf-btn');
  }

  function updateLetterDocxDownloadState(teamValid, recipientNameValid) {
    var btn = document.getElementById('letter-download-btn');
    if (!btn) return;
    if (dataErrors && dataErrors.length) {
      btn.disabled = true; btn.title = 'Blocked: the data file failed validation.'; return;
    }
    // Hard-requirement ineligibility alert (30 Sept 2026, additive) - same
    // gate as the CV's own updateDownloadState, see hardReqBlocksDownload's
    // own header comment.
    if (hardReqBlocksDownload()) {
      btn.disabled = true; btn.title = 'Blocked: the ad asks for something you don\'t have (see Should you apply?). Click "Build anyway" there to download anyway.'; return;
    }
    if (letterBuildError) {
      btn.disabled = true; btn.title = 'Blocked: the cover letter could not be built (' + letterBuildError.message + '). The CV is not affected.'; return;
    }
    if (!loadedData || !currentLetterModel) {
      btn.disabled = true; btn.title = 'Nothing to download yet: the letter is built once a CV exists.'; return;
    }
    // 2 Oct 2026: the opening line is "I am applying for the {{ROLE}} role
    // at {{COMPANY}}." - without either it reads "the  role at ." - so a
    // letter missing one is never downloadable. Usually filled from the ad
    // (applyAdInfo); when the ad didn't give it, step 6 already says so.
    var liNow = letterInputsNow();
    if (!liNow.company || !liNow.role) {
      var what = !liNow.company && !liNow.role ? 'no company name or role title' : (!liNow.company ? 'no company name' : 'no role title');
      btn.disabled = true; btn.title = 'Blocked: ' + what + ' - the opening line needs ' + (!liNow.company && !liNow.role ? 'both' : 'it') + '. Type ' + (!liNow.company && !liNow.role ? 'them' : 'it') + ' under Details from the ad.'; return;
    }
    if (teamValid === false) {
      btn.disabled = true; btn.title = 'Blocked: TEAM does not appear verbatim in the pasted job description.'; return;
    }
    // recipientNameValid (21 Sept 2026) - same gating shape as TEAM above,
    // CVLetterBuild.validateRecipientName's own constraint (must be a
    // verbatim JD substring, mirroring validateTeam).
    if (recipientNameValid === false) {
      btn.disabled = true; btn.title = 'Blocked: recipient name does not appear verbatim in the pasted job description.'; return;
    }
    if (!lastLetterGateResult || !lastLetterGateResult.passed) {
      btn.disabled = true; btn.title = 'Blocked: one or more safety gates failed - see the failed gate listed above the page.'; return;
    }
    btn.disabled = false; btn.title = '';
  }

  // Rebuilds the letter model from the current CV archetype/extraction plus
  // whatever is in the letter's own form fields right now. Depends on
  // currentArchetypeId/lastExtraction/lastFitCheck already being fresh
  // (set by updatePreview(), which calls this at the very end) - never
  // called before a CV has successfully built at least once.
  function recomputeLetter() {
    letterBuildError = null;
    try {
      recomputeLetterUnguarded();
    } catch (err) {
      console.error(err);
      letterBuildError = err;
      clearLetterPanel('');
      showLetterNotice('The cover letter could not be built: ' + err.message + ' The CV is not affected.');
    }
  }

  function recomputeLetterUnguarded() {
    if (!loadedData || (dataErrors && dataErrors.length) || !currentModel || !currentArchetypeId) {
      clearLetterPanel('');
      return;
    }
    // Salary rule (b), 26 Sept 2026: the form-answers panel's salary row
    // depends on the letter's own City field (detectOutsideDublinCork), but
    // renderFormAnswers() is otherwise only ever called from the CV side
    // (recompute()/updatePreview()) - typing a City with no other CV input
    // changing would never reach it without this call, and rule (b) would
    // silently never fire outside a coincidental CV rebuild. Called here,
    // before any of this function's own early returns below, since the
    // salary row's correctness never depends on whether the LETTER itself
    // is buildable (an invalid TEAM/recipient name blocks the letter, not
    // the salary answer).
    renderFormAnswers();
    var jdText = inputsNow().jdText;
    var li = letterInputsNow();
    var teamCheck = CVLetterBuild.validateTeam(li.team, jdText);
    if (!teamCheck.valid) {
      clearLetterPanel(teamCheck.reason);
      showLetterNotice(teamCheck.reason);
      updateLetterDownloadState(false);
      return;
    }
    // recipientNameCheck (21 Sept 2026) - same layering as teamCheck above,
    // checked before the letter is built so an invalid name blocks the
    // download the same way an invalid TEAM already does, rather than
    // silently falling back to the standard salutation.
    var recipientNameCheck = CVLetterBuild.validateRecipientName(li.recipientName, jdText);
    if (!recipientNameCheck.valid) {
      clearLetterPanel(recipientNameCheck.reason);
      showLetterNotice(recipientNameCheck.reason);
      updateLetterDownloadState(true, false);
      return;
    }

    var yearsRelevant = CVExperience.computeExperience(loadedData).yearsRelevant;
    var echoCandidates = CVLetterBuild.buildEchoCandidates(loadedData, jdText, yearsRelevant);
    var closeMatchResult = CVLetterBuild.computeCloseMatchTrigger(loadedData, jdText);
    // ECHO (2 Oct 2026, Derin's answer: "auto-pick the top line"): the
    // strongest candidate is quoted unless he picked another line or none.
    // A picked line that is no longer offered (the ad changed) falls back
    // to auto rather than echoing a sentence that is no longer a candidate.
    selectedEchoText = resolveEcho(letterChoices.echo, echoCandidates);

    var opts = {
      archetypeId: currentArchetypeId,
      extraction: lastExtraction,
      rawJD: jdText,
      yearsRelevant: yearsRelevant,
      company: li.company,
      role: li.role,
      team: teamCheck.team,
      recipientName: recipientNameCheck.name,
      city: li.city,
      echoText: selectedEchoText,
      titleMismatch: li.titleMismatch,
      fitCheckGapTrigger: lastFitCheck ? lastFitCheck.gapTrigger : 'none',
      // refereeName (25 Sept 2026, privacy pass): from the local, gitignored
      // private-overrides file if present, otherwise "" - see
      // js/data.js's loadPrivateOverrides and js/letterbuild.js's REFEREE
      // slot handling (omits the whole block when this is empty, never
      // renders an empty slot).
      refereeName: privateOverrides.refereeName || '',
      // hardReqGapIds (30 Sept 2026, additive): at most two gapBlockId
      // values from this build's RED hard-requirement findings, set by
      // recompute() above right before it calls updatePreview() (which
      // calls this function) - see that variable's own header comment.
      // Empty for every AMBER/GREEN build and for a RED build with no
      // gapBlockId-bearing finding.
      hardReqGapIds: lastHardReqGapIds,
      // Precomputed once per ad so each dropdown option's preview build
      // doesn't re-segment the ad (2 Oct 2026).
      echoCandidates: echoCandidates,
      closeMatchResult: closeMatchResult,
      choices: letterBuildChoices(letterChoices)
    };
    lastLetterBase = opts;

    var built;
    try {
      built = CVLetter.buildLetterContentModel(loadedData, opts);
    } catch (err) {
      console.error(err);
      letterBuildError = err;
      clearLetterPanel('Could not build a letter: ' + err.message);
      showLetterNotice('Could not build a letter: ' + err.message);
      return;
    }
    clearLetterNotice();
    currentLetterModel = built.model;
    lastLetterResult = built.letterResult;
    // What the letter would pick with no choices at all - the
    // "Recommended" option in each step 7 dropdown.
    lastLetterAuto = autoLetterPicks(isEmptyChoice(letterChoices) ? built : buildLetterWith({}));

    // gapSuppressedDuplicate (25 Sept 2026, item 5): js/letterbuild.js
    // dropped an otherwise-triggered gap paragraph because the archetype's
    // own why/evidence text already names the same gap - "a letter that
    // names its own gap twice reads worse than one that never named it"
    // (Derin's own instruction). Non-blocking, same visibility-not-a-gate
    // treatment as the short-variant coverage/zero-saving-shorts reports
    // above in boot() - this is a correct, silent omission, not an error,
    // but worth knowing about while building, not just trusting silently.
    if (built.letterResult.gapSuppressedDuplicate) {
      console.warn('Letter: gap paragraph for trigger "' + built.letterResult.gapTrigger +
        '" was suppressed - the archetype\'s own why/evidence text already names this gap.');
    }

    // refereeEligible/refereeRendered (26 Sept 2026, item 3): "when the
    // [private-overrides] file is absent, show a visible notice... never
    // drop it silently" - Derin's own instruction. Only fires when the
    // selected evidence entry was actually eligible for a referee line (a
    // TCS pilot-team variant) and no override supplied a name - never for
    // an archetype/evidence pick where a referee was never on the table.
    if (built.letterResult.refereeEligible && !built.letterResult.refereeRendered) {
      appendLetterNotice('referee line left out: no referee name saved under Private settings');
    }

    // Second evidence paragraph left out for space (4 Oct 2026): said on
    // screen rather than dropped silently.
    if (built.letterResult.evidence2DroppedForFit) {
      appendLetterNotice('one evidence paragraph left out (not the TCS one): the letter would run past one page with it');
    }

    // Generic _pendingReview banner (kept, not removed, even though the
    // standard salutation's own flag was cleared 21 Sept 2026 once Derin
    // confirmed "Dear Hiring Team," - see data file and letterbuild.js's
    // header) - same always-on-banner mechanism as archetype._pendingReview,
    // checked against whichever salutation entry actually rendered (std or
    // named), so a future flagged default on either one would still surface
    // rather than silently render unreviewed.
    var salEntries = loadedData.letterBlocks.salutation || [];
    var salEntry = recipientNameCheck.name ? CVAssemble.findById(salEntries, 'let-salutation-named') : CVAssemble.findById(salEntries, 'let-salutation-std');
    if (salEntry && salEntry._pendingReview) {
      appendLetterNotice('Unresolved: ' + salEntry._pendingReview);
    }

    // Close-match _pendingReview banner (26 Sept 2026, item 1): all 5
    // letterBlocks.closeMatch entries render together whenever close-match
    // mode fires (see js/letterbuild.js's buildLetterModel - the whole
    // category is used as one unit, never a subset), so checking any one
    // entry's flag is equivalent to checking all of them; `.some` is used
    // anyway rather than hardcoding the first entry, so a future partial
    // approval (only some of the 5 cleared) still surfaces correctly.
    // closeMatchUsed (2 Oct 2026): the letter's actual shape, which Derin
    // can now set either way in step 7 - the banner follows what is on the
    // page, not just the trigger.
    if (built.letterResult.closeMatchUsed) {
      var cmEntries = loadedData.letterBlocks.closeMatch || [];
      var cmPending = cmEntries.filter(function (e) { return e._pendingReview; });
      if (cmPending.length) {
        appendLetterNotice('Unreviewed: ' + cmPending[0]._pendingReview);
      }
    }

    var container = document.getElementById('letter-preview-container');
    CVPreview.render(currentLetterModel, container);
    var geom = CVPreview.pageGeometryPx(loadedData.style.letterPage);
    var pageEl = document.getElementById('letter-preview-page');
    container.style.width = geom.containerWidthPx + 'px';
    pageEl.style.paddingTop = geom.marginPx.top + 'px';
    pageEl.style.paddingRight = geom.marginPx.right + 'px';
    pageEl.style.paddingBottom = geom.marginPx.bottom + 'px';
    pageEl.style.paddingLeft = geom.marginPx.left + 'px';

    var fit = CVPageFit.measure(currentLetterModel, 'letter');
    var readout = document.getElementById('letter-fit-readout');
    // No trim ladder for letters (flagged, not silently skipped - see
    // js/letter.js's file header and the 21 Sept 2026 changelog entry):
    // letterBlocks entries carry no _trim strength/droppable annotations,
    // so js/trim.js's applyOneStep() would find nothing to act on. Letters
    // "have far more slack than a CV ever does" (js/pagefit.js's own
    // comment) and nothing in this project's fixture corpus has overflowed
    // one yet - an overflow today just fails the Page fit gate below and
    // blocks the download, same as a CV that trim.js gave up on.
    if (fit.overflows) {
      setFitReadout(readout, false, fit,
        'Overflows by ' + Math.round(fit.overflowPx) + 'px',
        'Against a ' + Math.round(fit.usableHeightPx) + 'px budget. No trim mechanism exists for letters yet - shorten COMPANY/TEAM/ECHO or drop a paragraph by hand.');
    } else {
      setFitReadout(readout, true, fit,
        'Fits on one page',
        Math.round(fit.heightPx) + ' of ' + Math.round(fit.usableHeightPx) + 'px used, ' + Math.round(fit.usableHeightPx - fit.heightPx) + 'px to spare.');
    }

    lastLetterGateResult = CVVerify.runGates(currentLetterModel, loadedData, fit, {
      docType: 'letter', rawJD: jdText, echoText: selectedEchoText, team: teamCheck.team, recipientName: recipientNameCheck.name
    });
    renderGates(lastLetterGateResult, 'letter-gates-list');
    updateLetterDownloadState(true, true);
    renderLetterPickers();
  }

  function handleLetterDownload() {
    if (!lastLetterGateResult || !lastLetterGateResult.passed || !currentLetterModel) return;
    var li = letterInputsNow();
    var statusEl = document.getElementById('letter-status');
    statusEl.textContent = 'Rendering...';
    Promise.resolve()
      .then(function () { return CVLetter.download(loadedData, currentLetterModel, CVLetter.filenameFor(li.company, li.role)); })
      .then(function (filename) {
        statusEl.textContent = 'Downloaded ' + filename;
      })
      .catch(function (err) {
        statusEl.textContent = 'Failed: ' + err.message;
        console.error(err);
      });
  }

  // --- PDF downloads (2 Oct 2026, js/render-pdf.js) ---------------------------
  // The same committed, gate-checked model the .docx button saves - never a
  // preview, never a rebuild.
  function pdfStatus(el, text) { if (el) el.textContent = text; }
  function handlePdfDownload() {
    if (!lastGateResult || !lastGateResult.passed || !currentModel || !global.CVPdf) return;
    var statusEl = document.getElementById('status');
    pdfStatus(statusEl, 'Rendering PDF...');
    CVPdf.download(currentModel, filenameFor(currentArchetypeId).replace(/\.docx$/, '.pdf'), {
      page: loadedData.style.page,
      title: loadedData.identity.signatureName + ' - CV',
      author: loadedData.identity.signatureName
    }).then(function (filename) {
      pdfStatus(statusEl, 'Downloaded ' + filename);
    }).catch(function (err) {
      pdfStatus(statusEl, 'PDF failed: ' + err.message);
      console.error(err);
    });
  }
  function handleLetterPdfDownload() {
    if (!lastLetterGateResult || !lastLetterGateResult.passed || !currentLetterModel || !global.CVPdf) return;
    var li = letterInputsNow();
    var statusEl = document.getElementById('letter-status');
    pdfStatus(statusEl, 'Rendering PDF...');
    CVPdf.download(currentLetterModel, CVLetter.filenameFor(li.company, li.role).replace(/\.docx$/, '.pdf'), {
      page: loadedData.style.letterPage,
      title: loadedData.identity.signatureName + ' - cover letter' + (li.role ? ', ' + li.role : '') + (li.company ? ', ' + li.company : ''),
      author: loadedData.identity.signatureName
    }).then(function (filename) {
      pdfStatus(statusEl, 'Downloaded ' + filename);
    }).catch(function (err) {
      pdfStatus(statusEl, 'PDF failed: ' + err.message);
      console.error(err);
    });
  }

  var debouncedRecomputeLetter = null; // assigned after debounce() is defined below

  // Populates the override dropdown from the data file's own archetypes -
  // never a hand-typed list.
  function populateArchetypeSelect(data) {
    var sel = archetypeSelectEl();
    sel.innerHTML = '';
    var autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto (best match to JD)';
    sel.appendChild(autoOpt);
    data.archetypes.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label;
      sel.appendChild(opt);
    });
    sel.value = 'auto';
  }

  // Spec 5.2: "Must always show which archetype was chosen and the
  // top-3 scoring terms."
  function renderArchetypeReadout(pick, chosenId, overridden, noMatch) {
    var el = document.getElementById('archetype-readout');
    el.innerHTML = '';
    var w = document.createElement('div');
    w.className = 'winner';
    // Nothing pasted yet is an empty state, not a failed match (1 Oct 2026
    // redesign) - "every score is 0" was literally true but read as an error
    // on first load.
    if (noMatch && !inputsNow().jdText.trim()) {
      w.className = 'winner winner-empty';
      w.textContent = 'Paste a job ad and the best-matching archetype is picked automatically, or choose one below.';
      el.appendChild(w);
      renderArchetypeNotice(null);
      return;
    }
    if (noMatch) {
      w.textContent = 'No archetype matched this job description (every score is 0) - choose one manually below.';
    } else {
      var chosenLabel = (CVAssemble.findById(loadedData.archetypes, chosenId) || {}).label || chosenId;
      appendParts(w, [
        [overridden ? 'Set manually' : 'Best match', 'winner-kicker'],
        [chosenLabel, 'winner-label'],
        [overridden ? '' : 'score ' + pick.winner.score, 'winner-score']
      ]);
    }
    el.appendChild(w);
    var t = document.createElement('div');
    t.className = 'top-terms';
    appendParts(t, [['Top matched terms for the auto pick', 'top-terms-label']]);
    if (pick.topTerms.length) {
      pick.topTerms.forEach(function (term) {
        var chip = document.createElement('span');
        chip.className = 'term-chip';
        chip.title = term.term + ' (weight ' + term.weight + ')';
        chip.appendChild(document.createTextNode(term.term));
        var weight = document.createElement('span');
        weight.className = 'term-weight';
        weight.textContent = term.weight;
        chip.appendChild(weight);
        t.appendChild(chip);
      });
    } else {
      t.appendChild(document.createTextNode('None yet - no text in the ad matched any archetype keyword.'));
    }
    el.appendChild(t);
    if (overridden && !noMatch) {
      var a = document.createElement('div');
      a.className = 'top-terms';
      a.textContent = 'Auto pick would have been: ' + pick.winner.archetype.label + ' (score ' + pick.winner.score + ')';
      el.appendChild(a);
    }
    renderArchetypeNotice(noMatch ? null : chosenId);
  }

  // --- Standing, always-on notice for an archetype's own unresolved content
  // issues (archetype._pendingReview), added 14 Sept 2026 per Derin's own
  // instruction: a deferred fix gated on a trigger phrase like "before my
  // next application" has no owner and no check, and is exactly the thing
  // that gets forgotten the moment it actually matters. This renders every
  // single time that archetype is selected - not a dismissible toast, not a
  // one-time warning - so it cannot be missed by forgetting it existed.
  // Deliberately non-blocking: the underlying content is defensible, just
  // not yet given its own stated basis (see consulting-tech's own _why),
  // so this is a reminder to verify by hand, not a build-error.
  function renderArchetypeNotice(chosenId) {
    var el = document.getElementById('archetype-notice');
    if (!el) return; // older test fixtures without this element
    var archetype = chosenId ? CVAssemble.findById(loadedData.archetypes, chosenId) : null;
    if (archetype && archetype._pendingReview) {
      el.textContent = 'Unresolved for "' + archetype.label + '": ' + archetype._pendingReview;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  // Named like the letter (8 Oct 2026, audit item 8): role then company,
  // so two applications in the same role type no longer download to the
  // same name. The role type's label is used only when the ad gave neither.
  function filenameFor(archetypeId) {
    var li = letterInputsNow();
    var parts = [li.role, li.company].filter(Boolean);
    if (!parts.length) {
      var a = CVAssemble.findById(loadedData.archetypes, archetypeId);
      parts = [(a && a.label) || archetypeId];
    }
    var slug = parts.join('_').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return 'Derin_Yesudas_CV_' + slug + '.docx';
  }

  // Walks the model, pulling out the id of every bullet/profile variant
  // actually selected - both bulletVariants entries and profileVariants
  // entries carry an `id` field, and _prov.text.atoms[0].ref IS that exact
  // object (see assemble.js's provenance design), so this needs no extra
  // bookkeeping inside assemble.js itself. Used by the audit-trail export.
  function extractSelectionIds(model) {
    var ids = [];
    model.forEach(function (b) {
      if ((b.t === 'bullet' || b.t === 'para') && b._prov && b._prov.text && b._prov.text.atoms && b._prov.text.atoms[0]) {
        var ref = b._prov.text.atoms[0].ref;
        if (ref && typeof ref === 'object' && ref.id) ids.push(ref.id);
      }
    });
    return ids;
  }

  // Re-scores every archetype against whatever's in the JD textarea,
  // resolves auto-vs-override, and rebuilds the model - swapping it in ONLY
  // on success (fix #2 above). A failed build never touches currentModel/
  // currentStamp/currentArchetypeId, and is shown as a visible error rather
  // than silently leaving the previous state on screen under a new label.
  function recompute() {
    if (!loadedData || (dataErrors && dataErrors.length)) return;
    // Ad details first (2 Oct 2026): fills company/role/city/team/recipient/
    // start date from the ad before anything below reads those fields.
    applyAdInfo(jdInputEl().value);
    var inputs = inputsNow();

    // Hard-requirement ineligibility alert (30 Sept 2026, additive): a
    // second, independent read of the same pasted JD text - see
    // js/hardreq.js's own file header. Always computed and always rendered,
    // whatever the verdict (spec section 3: RED/AMBER/GREEN are all shown),
    // and - by design - this does NOT short-circuit the rest of recompute()
    // the way noMatch/startCheck below do. Two reasons, both deliberate:
    // (1) this app's own existing, established convention (see
    // js/fitcheck.js's own file header, "documents still generate... this
    // is information, not a gate") already builds and shows a full preview
    // even for a fitcheck BLOCKED verdict - the preview pane is pre-decision
    // information throughout this app, not a gated document; (2) the
    // existing fit-check golden tests drive this exact pipeline end to end
    // via real JD text (some of which - "5+ years... required",
    // "ACCA qualified essential" - now ALSO trips this new RED check) and
    // assert on #fitcheck-verdict/#gates-list being populated; short-
    // circuiting recompute() here would silently break that pre-existing,
    // unrelated behaviour. What actually changes for a RED verdict is
    // narrower and happens below: the DOWNLOAD buttons (CV and letter) are
    // disabled until "Build anyway" is clicked for this exact JD text (see
    // updateDownloadState/updateLetterDownloadState's own hard-req check),
    // and the letter's hard-req gap paragraph is only ever populated once
    // that confirmation exists (lastHardReqGapIds below) - "do not auto-
    // generate" (spec section 4) is satisfied at the point that matters,
    // the actual downloadable document, not the informational preview.
    lastHardReq = CVHardReq.run(loadedData, inputs.jdText);
    renderHardReqBanner(lastHardReq, inputs.jdText);
    // Only ever non-empty once "Build anyway" has been clicked for THIS
    // exact JD text (see hardReqConfirmedJdHash's own header comment) -
    // AMBER/GREEN, and an unconfirmed RED, both leave this empty, so no gap
    // paragraph is ever written into a letter that hasn't been explicitly
    // confirmed past its own RED verdict.
    var hardReqConfirmedNow = hardReqBuildAnywayConfirmed && hardReqConfirmedJdHash === simpleHash(inputs.jdText);
    lastHardReqGapIds = (lastHardReq.verdict === 'RED' && hardReqConfirmedNow)
      ? (lastHardReq.findings || [])
          .filter(function (f) { return f.severity === 'red' && f.gapBlockId; })
          .map(function (f) { return f.gapBlockId; })
          .slice(0, 2)
      : [];

    var extraction = CVScore.extractFromJD(loadedData, inputs.jdText);
    lastExtraction = extraction; // Phase 6: fit check needs this even on a noMatch recompute
    lastPick = CVScore.pickArchetype(loadedData, extraction);
    var noMatch = lastPick.noMatch && !inputs.overridden;
    var candidateArchetypeId = inputs.overridden ? inputs.selValue : lastPick.winner.archetype.id;
    renderArchetypeReadout(lastPick, candidateArchetypeId, inputs.overridden, noMatch);

    if (noMatch) {
      currentArchetypeId = null;
      currentModel = null;
      currentStamp = null;
      if (!inputs.jdText.trim()) {
        // Empty ad (first load, or just cleared via "Skip this job"): show
        // the empty state rather than an error, and take the previous ad's
        // CV off screen so nothing stale is left looking current (1 Oct 2026
        // redesign). A non-empty ad that matches nothing still gets the
        // build error below, unchanged.
        clearBuildError();
        clearCvPreview();
      } else {
        showBuildError('No archetype matched this job description - every archetype scored 0. Refusing to guess; pick a role type under Should you apply? - the terms shown under "Every check in detail", if any, are the closest the auto-picker found, not a real match.');
      }
      clearFitCheck();
      updateDownloadState();
      clearLetterPanel('');
      renderFormAnswers();
      return;
    }

    // Item 2b (26 Sept 2026): the ad's stated start date, same verbatim-in-
    // JD constraint as TEAM (CVLetterBuild.validateStartDate), checked here
    // rather than left to buildModel - a start date that isn't really in
    // the pasted ad is a false claim about availability, exactly the class
    // of thing this app refuses to build rather than silently drops. Empty
    // is always valid (means "no ad start date typed", not an error).
    var startCheck = CVLetterBuild.validateStartDate(inputs.startDateText, inputs.jdText);
    if (!startCheck.valid) {
      currentArchetypeId = null;
      currentModel = null;
      currentStamp = null;
      showBuildError('Start date: ' + startCheck.reason);
      clearFitCheck();
      updateDownloadState();
      clearLetterPanel('');
      renderFormAnswers();
      return;
    }
    var startDateOpt = startCheck.date
      ? { text: startCheck.date, appliesExtended: CVLetterBuild.startDateTriggersExtendedAuth(startCheck.date) }
      : null;

    var jdHash = simpleHash(inputs.jdText + '|' + inputs.startDateText);
    // Section picks belong to one archetype's CV (2 Oct 2026): a different
    // archetype starts from its own automatic picks again.
    if (currentArchetypeId && candidateArchetypeId !== currentArchetypeId) {
      cvChoices = {};
      letterChoices = { echo: letterChoices.echo };
    }
    var attemptedModel;
    try {
      attemptedModel = CVAssemble.buildModel(loadedData, candidateArchetypeId, { excludeFactIds: ['vol'], extraction: extraction, startDate: startDateOpt, choices: cvChoices });
    } catch (err) {
      console.error(err);
      var label = (CVAssemble.findById(loadedData.archetypes, candidateArchetypeId) || {}).label || candidateArchetypeId;
      showBuildError('Could not build a CV for "' + label + '": ' + err.message +
        '. Nothing changed on screen below - it still shows whatever was last built successfully, if anything, NOT this selection.');
      // Deliberately do not touch currentModel/currentStamp/currentArchetypeId -
      // this is the direct fix for the customer-ops bug: a failed build must
      // never silently become "the new current state." The fit-check panels
      // are cleared, though - they're keyed to a specific attempted build,
      // not to "whatever was last built successfully."
      clearFitCheck();
      updateDownloadState();
      clearLetterPanel('');
      renderFormAnswers();
      return;
    }

    currentModel = attemptedModel;
    currentArchetypeId = candidateArchetypeId;
    currentStamp = { archetypeId: candidateArchetypeId, jdHash: jdHash, dataVersion: loadedData._version };
    lastAssembledModel = attemptedModel.slice();
    lastStartDateOpt = startDateOpt;
    lastCvAuto = CVAssemble.autoPicks(loadedData, candidateArchetypeId, extraction);
    clearBuildError();
    updatePreview();
  }

  // --- Section dropdowns (2 Oct 2026) ------------------------------------------
  // Derin, verbatim: "for the body of the cv or cover letter... make them as
  // a drop down list for every section, and whilst I hover over an option I
  // should get an overview at the side so that I can see the result in real
  // time... rather than not liking it once I download."
  //
  // Step 4 (CV sections) and step 7 (Letter paragraphs) hold one CVPicker
  // (js/picker.js) per choice the data file actually offers. Every option is
  // an existing, approved data-file entry - picking one only changes WHICH
  // entry is selected (opts.choices in CVAssemble.buildModel and
  // CVLetterBuild.buildLetterModel); all gates run on the result exactly as
  // before. Each list shows every approved version (Derin's answer, 2 Oct:
  // "all approved versions"), the automatic pick marked Recommended, and -
  // worked out when the list opens - whether each option still fits on one
  // page. Hovering an option (or arrowing to it) rebuilds the page beside
  // the sidebar with it in place - built, trimmed and measured exactly like
  // the real thing, the changed text highlighted - and leaving without
  // choosing puts the committed page back.

  var pickerInstances = { cv: [], letter: [] };
  var previewing = { cv: false, letter: false };
  var savedReadout = { cv: null, letter: null };

  function isEmptyChoice(c) {
    if (!c) return true;
    return Object.keys(c).every(function (k) {
      var v = c[k];
      if (v && typeof v === 'object') return isEmptyChoice(v);
      return v === undefined || v === null || v === '';
    });
  }

  function copyChoices(c) {
    return JSON.parse(JSON.stringify(c || {}));
  }

  // key/sub: e.g. ('profile') or ('bullets', groupId). value undefined =
  // back to the automatic pick.
  function withChoice(base, key, value, sub) {
    var c = copyChoices(base);
    if (sub) {
      c[key] = c[key] || {};
      if (value === undefined) delete c[key][sub];
      else c[key][sub] = value;
      if (!Object.keys(c[key]).length) delete c[key];
    } else if (value === undefined) {
      delete c[key];
    } else {
      c[key] = value;
    }
    return c;
  }

  // ECHO: 'none' -> no quote; a candidate's exact text -> that line; anything
  // else (undefined, or a line no longer offered) -> the top-ranked line.
  function resolveEcho(choice, candidates) {
    if (choice === 'none') return '';
    if (choice && candidates.some(function (c) { return c.text === choice; })) return choice;
    var auto = CVLetterBuild.pickEchoAuto(candidates);
    return auto ? auto.text : '';
  }

  function letterBuildChoices(choices) {
    var out = {};
    ['mode', 'why', 'echoFrame', 'evidence', 'evidence2', 'gap'].forEach(function (k) {
      if (choices && choices[k]) out[k] = choices[k];
    });
    return out;
  }

  // The CV trim loop (moved here from updatePreview, unchanged): trim.js
  // only ever removes things, so it terminates on its own; the cap is a
  // defensive backstop against a future trim.js bug hanging the tab.
  function fitToPage(model) {
    var fit = CVPageFit.measure(model, 'cv');
    var trimLog = [];
    var iterations = 0;
    var TRIM_ITERATION_CAP = 200;
    while (fit.overflows && iterations < TRIM_ITERATION_CAP) {
      var step = CVTrim.applyOneStep(model);
      if (!step.applied) break;
      model = step.model;
      CVAssemble.fixLastParagraphSpacing(model);
      trimLog.push(step.description);
      fit = CVPageFit.measure(model, 'cv');
      iterations++;
    }
    return { model: model, fit: fit, trimLog: trimLog };
  }

  function buildCvWith(choices) {
    var model = CVAssemble.buildModel(loadedData, currentArchetypeId, {
      excludeFactIds: ['vol'], extraction: lastExtraction, startDate: lastStartDateOpt, choices: choices
    });
    var assembled = model.slice();
    var fitted = fitToPage(model);
    return { assembled: assembled, model: fitted.model, fit: fitted.fit, trimLog: fitted.trimLog };
  }

  function buildLetterWith(choices) {
    var opts = {};
    Object.keys(lastLetterBase).forEach(function (k) { opts[k] = lastLetterBase[k]; });
    opts.choices = letterBuildChoices(choices);
    opts.echoText = resolveEcho(choices.echo, lastLetterBase.echoCandidates || []);
    var built = CVLetter.buildLetterContentModel(loadedData, opts);
    built.fit = CVPageFit.measure(built.model, 'letter');
    built.echoText = opts.echoText;
    return built;
  }

  function autoLetterPicks(built) {
    var r = built.letterResult;
    var out = { mode: r.closeMatchUsed ? 'closeMatch' : 'standard', why: 'none', echoFrame: null, evidence: 'none', evidence2: 'none', gap: 'none' };
    r.blocks.forEach(function (b) {
      if (b.category === 'why' && b.ref) {
        if (b.ref.isEchoFrame) out.echoFrame = b.ref.id;
        else if (!b.ref.isEchoFallback) out.why = b.ref.id;
      }
      if (b.category === 'evidence' && !r.closeMatchUsed) {
        if (b.evidenceSlot === 2) out.evidence2 = b.id;
        else out.evidence = b.id;
      }
      if (b.category === 'gap' && String(b.id).indexOf('hardreq-gap-') !== 0) out.gap = b.id;
    });
    var frames = letterEntriesFor(loadedData.letterBlocks.why).filter(function (e) { return e.isEchoFrame; });
    if (!out.echoFrame && frames.length) out.echoFrame = frames[0].id;
    return out;
  }

  function letterEntriesFor(list) {
    return (list || []).filter(function (e) {
      var a = e.archetypes || [];
      return a.indexOf('*') !== -1 || a.indexOf(currentArchetypeId) !== -1;
    });
  }

  function archetypeLabel(id) {
    var a = CVAssemble.findById(loadedData.archetypes, id);
    return a ? a.label : id;
  }

  function sentenceCase(heading) {
    var h = String(heading || '');
    return h.charAt(0) + h.slice(1).toLowerCase();
  }

  function clearPickers(doc) {
    endPreview(doc);
    (pickerInstances[doc] || []).forEach(function (p) { if (p.destroy) p.destroy(); });
    pickerInstances[doc] = [];
    var host = document.getElementById(doc === 'cv' ? 'cv-pickers' : 'letter-pickers');
    if (host) host.textContent = '';
  }

  // A failed gate outranks fit: an option that would block the download
  // says so in the list, with the gate's own name.
  function gateStatus(gates) {
    if (!gates || gates.passed) return null;
    var failed = gates.gates.filter(function (g) { return !g.passed; }).map(function (g) { return g.name; });
    return { text: 'Blocked', tone: 'bad', title: 'Would fail: ' + failed.join(', ') + '. The download stays blocked with this option.' };
  }
  function fitStatusCv(built) {
    var blocked = gateStatus(CVVerify.runGates(built.model, loadedData, built.fit));
    if (blocked) return blocked;
    if (built.fit.overflows) return { text: 'Too long', tone: 'bad', title: 'Overflows by ' + Math.round(built.fit.overflowPx) + 'px even after trimming' };
    if (built.trimLog.length) return { text: 'Fits, trims ' + built.trimLog.length, tone: 'warn', title: 'Fits after ' + built.trimLog.length + ' automatic trim step' + (built.trimLog.length === 1 ? '' : 's') + ' (shorter variants or dropped low-priority lines)' };
    return { text: 'Fits', tone: 'ok', title: Math.round(built.fit.heightPx) + ' of ' + Math.round(built.fit.usableHeightPx) + 'px used, no trimming' };
  }
  function fitStatusLetter(built) {
    var blocked = gateStatus(CVVerify.runGates(built.model, loadedData, built.fit, {
      docType: 'letter', rawJD: lastLetterBase.rawJD, echoText: built.echoText, team: lastLetterBase.team, recipientName: lastLetterBase.recipientName
    }));
    if (blocked) return blocked;
    if (built.fit.overflows) return { text: 'Too long', tone: 'bad', title: 'Overflows by ' + Math.round(built.fit.overflowPx) + 'px' };
    return { text: 'Fits', tone: 'ok', title: Math.round(built.fit.heightPx) + ' of ' + Math.round(built.fit.usableHeightPx) + 'px used' };
  }

  // --- Preview: render the hovered option onto the page, highlight what
  // changed, keep it in view, and say it's a preview.
  function signature(b) {
    return [b.t, b.text || '', b.label || '', b.title || '', b.org || '', b.right || ''].join('\u0001');
  }
  function markChanges(container, model, base) {
    var counts = {};
    (base || []).forEach(function (b) { var k = signature(b); counts[k] = (counts[k] || 0) + 1; });
    var first = null;
    var nodes = container.children;
    model.forEach(function (b, i) {
      var k = signature(b);
      if (counts[k]) { counts[k]--; return; }
      if (b.t === 'spacer' || !nodes[i]) return;
      nodes[i].classList.add('pv-changed');
      if (!first) first = nodes[i];
    });
    if (!first && base && model.length === base.length) {
      // Same blocks, different order (4 Oct 2026: picking the other evidence
      // paragraph first just swaps the two round): mark the ones that moved.
      model.forEach(function (b, i) {
        if (b.t === 'spacer' || !nodes[i] || signature(b) === signature(base[i])) return;
        nodes[i].classList.add('pv-changed');
        if (!first) first = nodes[i];
      });
    }
    if (!first) {
      // Something was removed: point at where it was.
      for (var i = 0; i < model.length && i < (base || []).length; i++) {
        if (signature(model[i]) !== signature(base[i])) {
          if (nodes[i]) { nodes[i].classList.add('pv-near'); first = nodes[i]; }
          break;
        }
      }
    }
    return first;
  }
  function reveal(node) {
    if (!node) return;
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || window.getComputedStyle(sidebar).position !== 'sticky') return;
    var bar = document.querySelector('.appbar');
    var top = (bar ? bar.getBoundingClientRect().bottom : 56) + 70;
    var r = node.getBoundingClientRect();
    if (r.top >= top && r.bottom <= window.innerHeight - 24) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var y = window.scrollY + r.top - Math.max(top, (window.innerHeight - r.height) * 0.4);
    window.scrollTo({ top: Math.max(0, y), behavior: reduce ? 'auto' : 'smooth' });
  }
  function readoutFor(doc) {
    return document.getElementById(doc === 'cv' ? 'fit-readout' : 'letter-fit-readout');
  }
  // The doc bar stays on screen while the page scrolls, so the preview's
  // fit verdict is shown there too (data-preview on the title, drawn by
  // css/app.css) - the readout itself can be scrolled out of view.
  function setPreviewTag(doc, fit) {
    var title = document.getElementById(doc === 'cv' ? 'doc-cv-title' : 'doc-letter-title');
    if (!title) return;
    if (!fit) { title.removeAttribute('data-preview'); title.removeAttribute('data-preview-fit'); return; }
    title.setAttribute('data-preview', fit.overflows ? 'Preview: too long by ' + Math.round(fit.overflowPx) + 'px' : 'Preview: fits on one page');
    title.setAttribute('data-preview-fit', fit.overflows ? 'bad' : 'ok');
  }
  function beginPreviewChrome(doc) {
    var article = document.getElementById(doc === 'cv' ? 'doc-cv' : 'doc-letter');
    if (article) article.classList.add('is-previewing');
    var readout = readoutFor(doc);
    if (readout && !previewing[doc]) {
      savedReadout[doc] = { html: readout.innerHTML, cls: readout.className, fill: readout.style.getPropertyValue('--fill') };
    }
    previewing[doc] = true;
  }
  function renderLetterInto(model) {
    var container = document.getElementById('letter-preview-container');
    CVPreview.render(model, container);
    var geom = CVPreview.pageGeometryPx(loadedData.style.letterPage);
    container.style.width = geom.containerWidthPx + 'px';
    return container;
  }
  function endPreview(doc) {
    if (!previewing[doc]) return;
    previewing[doc] = false;
    var article = document.getElementById(doc === 'cv' ? 'doc-cv' : 'doc-letter');
    if (article) article.classList.remove('is-previewing');
    setPreviewTag(doc, null);
    var readout = readoutFor(doc);
    var saved = savedReadout[doc];
    if (readout && saved) {
      readout.innerHTML = saved.html;
      readout.className = saved.cls;
      if (saved.fill) readout.style.setProperty('--fill', saved.fill);
      else readout.style.removeProperty('--fill');
    }
    savedReadout[doc] = null;
    if (doc === 'cv' && currentModel) CVPreview.render(currentModel, document.getElementById('preview-container'));
    if (doc === 'letter' && currentLetterModel) renderLetterInto(currentLetterModel);
  }
  function previewCv(choices) {
    if (!currentModel) return;
    var built;
    try { built = buildCvWith(choices); } catch (err) { console.error(err); return; }
    beginPreviewChrome('cv');
    var container = document.getElementById('preview-container');
    CVPreview.render(built.model, container);
    var node = markChanges(container, built.model, currentModel);
    var fit = built.fit;
    setFitReadout(readoutFor('cv'), !fit.overflows, fit,
      fit.overflows ? 'Preview: overflows by ' + Math.round(fit.overflowPx) + 'px' : 'Preview: fits on one page',
      Math.round(fit.heightPx) + ' of ' + Math.round(fit.usableHeightPx) + 'px' + (built.trimLog.length ? ', after ' + built.trimLog.length + ' automatic trim step' + (built.trimLog.length === 1 ? '' : 's') : '') + '. Click the option to use it; move away to keep the current page.');
    readoutFor('cv').classList.add('fit-preview');
    setPreviewTag('cv', fit);
    reveal(node);
  }
  function previewLetter(choices) {
    if (!currentLetterModel || !lastLetterBase) return;
    var built;
    try { built = buildLetterWith(choices); } catch (err) { console.error(err); return; }
    beginPreviewChrome('letter');
    var container = renderLetterInto(built.model);
    var node = markChanges(container, built.model, currentLetterModel);
    var fit = built.fit;
    setFitReadout(readoutFor('letter'), !fit.overflows, fit,
      fit.overflows ? 'Preview: overflows by ' + Math.round(fit.overflowPx) + 'px' : 'Preview: fits on one page',
      Math.round(fit.heightPx) + ' of ' + Math.round(fit.usableHeightPx) + 'px. Click the option to use it; move away to keep the current letter.');
    readoutFor('letter').classList.add('fit-preview');
    setPreviewTag('letter', fit);
    reveal(node);
  }

  // --- Step 4: CV sections ----------------------------------------------------
  function sectionPresent(heading) {
    return (lastAssembledModel || []).some(function (b) { return b.t === 'head' && b.text === heading; });
  }

  function cvPickerConfigs(sectionType, archetype) {
    var data = loadedData;
    var auto = lastCvAuto;
    var out = [];
    function cfgFor(label, key, sub, options, autoValue, current, hint) {
      return {
        label: label, hint: hint, options: options, value: current,
        statuses: function () {
          var st = {};
          options.forEach(function (o) {
            try {
              st[o.value] = fitStatusCv(buildCvWith(withChoice(cvChoices, key, o.value === autoValue ? undefined : o.value, sub)));
            } catch (err) { console.error(err); }
          });
          return st;
        },
        onPreview: function (value) {
          if (value === null) endPreview('cv');
          else previewCv(withChoice(cvChoices, key, value === autoValue ? undefined : value, sub));
        },
        onCommit: function (value) {
          endPreview('cv');
          cvChoices = withChoice(cvChoices, key, value === autoValue ? undefined : value, sub);
          recompute();
        }
      };
    }
    if (sectionType === 'profile') {
      var mine = [];
      var others = [];
      data.profileVariants.forEach(function (v) {
        var o = {
          value: v.id,
          title: v.archetypes.map(archetypeLabel).join(' / '),
          text: v.text,
          recommended: v.id === auto.profile
        };
        if (v.archetypes.indexOf(archetype.id) !== -1) { o.group = 'Written for this role type'; mine.push(o); }
        else { o.group = 'Written for other role types'; others.push(o); }
      });
      out.push(cfgFor('Profile paragraph', 'profile', null, mine.concat(others), auto.profile, cvChoices.profile || auto.profile));
    } else if (sectionType === 'skills') {
      var seen = {};
      var opts = [];
      var autoKey = archetype.skillCategories.join(',');
      var autoRep = null;
      data.archetypes.forEach(function (a) {
        var k = a.skillCategories.join(',');
        if (seen[k]) { seen[k].users.push(a.label); return; }
        var o = {
          value: a.id,
          title: a.skillCategories.map(function (c) { return (data.skillLines[c] && data.skillLines[c].label) || c; }).join(' · '),
          users: [a.label],
          recommended: k === autoKey
        };
        if (k === autoKey) autoRep = a.id;
        seen[k] = o;
        opts.push(o);
      });
      opts.forEach(function (o) { o.text = 'Used on: ' + o.users.join('; ') + '.'; delete o.users; });
      var currentSkills = cvChoices.skills ? (opts.filter(function (o) { return o.value === cvChoices.skills; })[0] || {}).value : autoRep;
      out.push(cfgFor('Skill categories', 'skills', null, opts, autoRep, currentSkills || autoRep, 'Which approved skill lines appear, in which order. Terms inside each line still follow the ad.'));
    } else if (sectionType === 'experience') {
      var roleIds = data.facts.roles.map(function (r) { return r.id; });
      var seenRoles = {};
      var roleOpts = [];
      var autoRolesKey = archetype.include.filter(function (id) { return roleIds.indexOf(id) !== -1; }).join(',');
      var autoRolesRep = null;
      data.archetypes.forEach(function (a) {
        var ids = a.include.filter(function (id) { return roleIds.indexOf(id) !== -1; });
        var k = ids.join(',');
        if (!ids.length) return;
        if (seenRoles[k]) { seenRoles[k].users.push(a.label); return; }
        var o = {
          value: a.id,
          title: ids.map(function (id) { var r = CVAssemble.findById(data.facts.roles, id); return r ? r.title : id; }).join(' · '),
          users: [a.label],
          recommended: k === autoRolesKey
        };
        if (k === autoRolesKey) autoRolesRep = a.id;
        seenRoles[k] = o;
        roleOpts.push(o);
      });
      roleOpts.forEach(function (o) { o.text = 'Used on: ' + o.users.join('; ') + '.'; delete o.users; });
      var currentRoles = cvChoices.roles ? (roleOpts.filter(function (o) { return o.value === cvChoices.roles; })[0] || {}).value : autoRolesRep;
      out.push(cfgFor('Roles shown', 'roles', null, roleOpts, autoRolesRep, currentRoles || autoRolesRep, 'In the order they print.'));
    }
    // Bullet wording, for every role/project bullet group on this CV that
    // has more than one approved version.
    if (sectionType === 'experience' || sectionType === 'project') {
      var groupsSeen = {};
      var bulletCfgs = [];
      (lastAssembledModel || []).forEach(function (b) {
        if (b.t !== 'bullet' || !b._trim || !b._group || groupsSeen[b._trim.groupId]) return;
        if ((sectionType === 'project') !== (b._group.kind === 'project')) return;
        var gid = b._trim.groupId;
        groupsSeen[gid] = true;
        var group = data.bulletVariants[gid];
        if (!group || !group.variants || group.variants.length < 2) return;
        var owner = b._group.kind === 'project' ? data.facts.project : CVAssemble.findById(data.facts.roles, b._group.id);
        var ownerName = owner ? owner.title : b._group.id;
        var position = owner && owner.bullets ? owner.bullets.indexOf(gid) + 1 : 0;
        var autoV = auto.bullets[gid];
        var vopts = group.variants.map(function (v) {
          return { value: v.id, text: v.text, recommended: v.id === autoV };
        });
        var chosen = (cvChoices.bullets && cvChoices.bullets[gid]) || autoV;
        var cfg = cfgFor(ownerName + (position ? ', bullet ' + position : ''), 'bullets', gid, vopts, autoV, chosen);
        cfg._order = (b._group.kind === 'project' ? 0 : 1000) + (owner && data.facts.roles ? data.facts.roles.indexOf(owner) * 50 : 0) + position;
        bulletCfgs.push(cfg);
      });
      // In the order they sit in the data file (the model orders bullets
      // by how well they match the ad, which would list "bullet 2" first).
      bulletCfgs.sort(function (a, b) { return a._order - b._order; });
      out = out.concat(bulletCfgs);
    }
    return out;
  }

  function renderCvPickers() {
    clearPickers('cv');
    var host = document.getElementById('cv-pickers');
    if (!host || !currentModel || !lastCvAuto || !loadedData || !global.CVPicker) return;
    var archetype = CVAssemble.findById(loadedData.archetypes, currentArchetypeId);
    if (!archetype) return;
    archetype.sectionOrder.forEach(function (so) {
      if (!sectionPresent(so.heading)) return;
      var section = document.createElement('div');
      section.className = 'picker-section';
      var h = document.createElement('h3');
      h.className = 'picker-section-title';
      h.textContent = sentenceCase(so.heading);
      section.appendChild(h);
      var configs = cvPickerConfigs(so.type, archetype);
      if (!configs.length) {
        var none = document.createElement('p');
        none.className = 'picker-fixed-note';
        none.textContent = so.type === 'education'
          ? 'Facts only (degrees, dates, grades, modules): one approved version, nothing to choose.'
          : 'One approved version, nothing to choose.';
        section.appendChild(none);
      }
      configs.forEach(function (cfg) {
        var inst = global.CVPicker.create(cfg);
        pickerInstances.cv.push(inst);
        section.appendChild(inst.el);
      });
      host.appendChild(section);
    });
    var custom = !isEmptyChoice(cvChoices);
    var reset = document.getElementById('cv-pickers-reset');
    if (reset) reset.hidden = !custom;
  }

  // --- Step 7: letter paragraphs ------------------------------------------------
  function blockText(built, predicate) {
    var b = built.letterResult.blocks.filter(predicate)[0];
    return b ? b.text : '';
  }

  function renderLetterPickers() {
    clearPickers('letter');
    var host = document.getElementById('letter-pickers');
    if (!host || !currentLetterModel || !lastLetterBase || !lastLetterAuto || !global.CVPicker) return;
    var lb = loadedData.letterBlocks;
    var auto = lastLetterAuto;
    var closeUsed = !!(lastLetterResult && lastLetterResult.closeMatchUsed);
    var candidates = lastLetterBase.echoCandidates || [];
    var built = {}; // value-keyed builds per picker, reused for text and statuses

    function cfgFor(label, key, options, autoValue, current, hint, disabledNote) {
      return {
        label: label, hint: hint, options: options, value: current, disabledNote: disabledNote,
        statuses: function () {
          var st = {};
          options.forEach(function (o) {
            try {
              st[o.value] = fitStatusLetter(buildLetterWith(withChoice(letterChoices, key, o.value === autoValue ? undefined : o.value)));
            } catch (err) { console.error(err); }
          });
          return st;
        },
        onPreview: function (value) {
          if (value === null) endPreview('letter');
          else previewLetter(withChoice(letterChoices, key, value === autoValue ? undefined : value));
        },
        onCommit: function (value) {
          endPreview('letter');
          letterChoices = withChoice(letterChoices, key, value === autoValue ? undefined : value);
          recomputeLetter();
        }
      };
    }
    // Option text is read off a real build with that option in place, so
    // the list shows exactly the paragraph that would print (slots filled).
    // In a close-match letter these paragraphs aren't used; their text is
    // still shown (built in standard shape) so the list stays readable.
    function textWith(key, value, predicate) {
      try {
        var base = closeUsed ? withChoice(letterChoices, 'mode', 'standard') : letterChoices;
        var b = buildLetterWith(withChoice(base, key, value));
        return blockText(b, predicate);
      } catch (err) { console.error(err); return ''; }
    }
    var notInCloseMatch = closeUsed ? 'Not used in a close-match letter (Letter type, above).' : null;
    var configs = [];

    // Letter type
    var cm = lastLetterBase.closeMatchResult || { hitCount: 0, totalCount: 0 };
    configs.push(cfgFor('Letter type', 'mode', [
      { value: 'standard', title: 'Standard letter', text: 'Opening, why this role, one evidence paragraph, any gap, then the close.', recommended: auto.mode === 'standard' },
      { value: 'closeMatch', title: 'Close-match letter', text: 'Says the match plainly, then one paragraph per matching duty, then the close. For ads that read like your TCS job.', recommended: auto.mode === 'closeMatch' }
    ], auto.mode, letterChoices.mode || auto.mode,
    cm.totalCount ? 'Close-match check: ' + cm.hitCount + ' of ' + cm.totalCount + ' duties in this ad match approved evidence (half or more switches it on).' : 'Close-match check: no duties section found in this ad.'));

    // Why this role (plain why paragraph)
    var plain = (lb.why || []).filter(function (e) { return !e.isEchoFrame && !e.isEchoFallback; });
    var whyOpts = plain.map(function (e) {
      var eligible = (e.archetypes || []).indexOf('*') !== -1 || (e.archetypes || []).indexOf(currentArchetypeId) !== -1;
      return { value: e.id, text: textWith('why', e.id, function (b) { return b.id === e.id; }), recommended: auto.why === e.id, group: eligible ? 'Written for this role type' : 'Written for other role types' };
    });
    whyOpts.sort(function (a, b) { return (a.group === b.group) ? 0 : (a.group === 'Written for this role type' ? -1 : 1); });
    whyOpts.push({ value: 'none', title: 'No paragraph here', text: 'Go straight from the opening to the quoted line.', recommended: auto.why === 'none' });
    configs.push(cfgFor('Why this role', 'why', whyOpts, auto.why, letterChoices.why || auto.why, null, notInCloseMatch));

    // Line quoted from the ad (ECHO)
    var autoCandidate = CVLetterBuild.pickEchoAuto(candidates);
    var echoAuto = autoCandidate ? autoCandidate.text : 'none';
    var echoOpts = candidates.map(function (c) {
      return { value: c.text, text: '"' + c.text + '"', badge: c.strength ? { text: String(c.strength), tone: String(c.strength).toLowerCase() === 'core' ? 'brand' : 'info' } : null, recommended: c.text === echoAuto };
    });
    var fallbackText = textWith('echo', 'none', function (b) { return b.ref && b.ref.isEchoFallback; });
    echoOpts.push({ value: 'none', title: 'No quote', text: fallbackText || 'Use the no-quote paragraph instead.', recommended: echoAuto === 'none' });
    configs.push(cfgFor('Line quoted from the ad', 'echo', echoOpts, echoAuto, selectedEchoText || 'none',
      candidates.length && !closeUsed ? 'Only the ad\'s own sentences that match approved content and pass every check are offered, strongest first.' : null,
      notInCloseMatch || (candidates.length ? null : 'Nothing in this ad matched approved content and cleared every check, so there is nothing to quote.')));

    // Quote wording (echo frame)
    var frames = letterEntriesFor(lb.why).filter(function (e) { return e.isEchoFrame; });
    var frameOpts = frames.map(function (e) {
      return { value: e.id, text: selectedEchoText ? textWith('echoFrame', e.id, function (b) { return b.id === e.id; }) : String(e.text).replace(/\{\{ECHO\}\}/g, '…'), recommended: e.id === auto.echoFrame };
    });
    configs.push(cfgFor('Quote wording', 'echoFrame', frameOpts, auto.echoFrame, letterChoices.echoFrame || auto.echoFrame, null,
      notInCloseMatch || (selectedEchoText ? null : 'Only used when a line from the ad is quoted.')));

    // Evidence paragraph
    var evOpts = (lb.evidence || []).map(function (e) {
      var eligible = (e.archetypes || []).indexOf('*') !== -1 || (e.archetypes || []).indexOf(currentArchetypeId) !== -1;
      return { value: e.id, text: textWith('evidence', e.id, function (b) { return b.id === e.id; }), recommended: e.id === auto.evidence, group: eligible ? 'Written for this role type' : 'Written for other role types' };
    });
    evOpts.sort(function (a, b) { return (a.group === b.group) ? 0 : (a.group === 'Written for this role type' ? -1 : 1); });
    evOpts.push({ value: 'none', title: 'No evidence paragraph', text: 'Leave both out.', recommended: auto.evidence === 'none' });
    configs.push(cfgFor('First evidence paragraph', 'evidence', evOpts, auto.evidence, letterChoices.evidence || auto.evidence, null, notInCloseMatch));

    // Second evidence paragraph (4 Oct 2026): every evidence entry except
    // the one already printed first, plus None. Recommended is what the
    // letter adds by itself (the TCS paragraph when the first isn't it).
    var firstEv = (lastLetterResult && lastLetterResult.evidenceId) || null;
    var ev2Opts = (lb.evidence || []).filter(function (e) { return e.id !== firstEv; }).map(function (e) {
      var eligible = (e.archetypes || []).indexOf('*') !== -1 || (e.archetypes || []).indexOf(currentArchetypeId) !== -1;
      return { value: e.id, text: textWith('evidence2', e.id, function (b) { return b.id === e.id; }), recommended: e.id === auto.evidence2, group: eligible ? 'Written for this role type' : 'Written for other role types' };
    });
    ev2Opts.sort(function (a, b) { return (a.group === b.group) ? 0 : (a.group === 'Written for this role type' ? -1 : 1); });
    ev2Opts.push({ value: 'none', title: 'No second paragraph', text: 'Keep the letter to one evidence paragraph.', recommended: auto.evidence2 === 'none' });
    configs.push(cfgFor('Second evidence paragraph', 'evidence2', ev2Opts, auto.evidence2, letterChoices.evidence2 || auto.evidence2,
      'Added automatically: your TCS paragraph whenever the first one isn\'t it, otherwise the next-best match. Left out only if the letter would run past one page, and never the TCS one.', notInCloseMatch || (firstEv ? null : 'Only used alongside a first evidence paragraph.')));

    // Gap paragraph
    var gapOpts = [{ value: 'none', title: 'No gap paragraph', text: 'Say nothing about a gap.', recommended: auto.gap === 'none' }];
    (lb.gap || []).forEach(function (e) {
      if (!e.text) return;
      gapOpts.push({ value: e.id, text: textWith('gap', e.id, function (b) { return b.id === e.id; }), recommended: e.id === auto.gap });
    });
    configs.push(cfgFor('Gap paragraph', 'gap', gapOpts, auto.gap, letterChoices.gap || auto.gap,
      'Recommended follows the checks under Should you apply?: it names a gap only when the ad asks for something you don\'t have yet.', notInCloseMatch));

    configs.forEach(function (cfg) {
      var inst = global.CVPicker.create(cfg);
      pickerInstances.letter.push(inst);
      host.appendChild(inst.el);
    });
    var fixed = document.createElement('p');
    fixed.className = 'picker-fixed-note';
    fixed.textContent = 'Opening and closing lines are set automatically, using the role, team and company under Details from the ad.';
    host.appendChild(fixed);
    var reset = document.getElementById('letter-pickers-reset');
    if (reset) reset.hidden = isEmptyChoice(letterChoices);
  }

  function formAnswersContainerEl() { return document.getElementById('form-answers-container'); }

  // Copy-to-clipboard for a form answer (1 Oct 2026 redesign) - these
  // answers exist to be pasted into application forms, so one click should
  // do it. Copies exactly the answer text shown, nothing added. Lives outside
  // .form-answer-q/.form-answer-a, the two elements the golden suite reads.
  function makeCopyButton(text) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm copy-btn';
    btn.setAttribute('aria-label', 'Copy answer');
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
    var label = document.createElement('span');
    label.textContent = 'Copy';
    btn.appendChild(label);
    var resetTimer = null;
    function done(ok) {
      label.textContent = ok ? 'Copied' : 'Copy failed';
      btn.classList.toggle('is-copied', ok);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(function () { label.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1600);
    }
    btn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
      } else {
        done(fallbackCopy(text));
      }
    });
    return btn;
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // Item 5 (26 Sept 2026): deterministic answers to standard application-
  // form questions - data.formAnswers holds the static text; this function's
  // only job is picking WHICH static text applies: the salary bucket for the
  // current archetype, and, for right-to-work/sponsorship, whether the live
  // CV model's own "auth" block line has actually diverged from the plain
  // data.identity.rightToWork sentence (i.e. the extended start-date
  // template, item 2b, actually fired) - only then is it worth showing in
  // place of the static answer, which is otherwise the MORE informative one
  // (it also carries the permission detail - see data.formAnswers.
  // rightToWorkSponsorship._why). Called once after boot()'s initial load
  // (so the answers that don't depend on a build show immediately) and
  // again at the end of every successful updatePreview(), plus every early
  // return in recompute()/updatePreview() that resets currentModel/
  // currentArchetypeId to null, so the panel never shows stale state.
  function renderFormAnswers() {
    var container = formAnswersContainerEl();
    if (!container) return;
    var fa = loadedData && loadedData.formAnswers;
    container.innerHTML = '';
    if (!fa) return;

    // pendingReviewMsg (26 Sept 2026, item 1 of Derin's three-item reply):
    // an optional 3rd arg renders a visible "Unreviewed" badge next to the
    // question, title-texted with the full _pendingReview message - same
    // always-on-banner discipline as the letter panel's own _pendingReview
    // notice below, just a per-row badge instead of a panel-wide notice,
    // since only 2 of the 5 form-answer rows are newly-authored this pass.
    function addRow(question, answer, pendingReviewMsg) {
      var row = document.createElement('div');
      row.className = 'form-answer-row';
      var q = document.createElement('div');
      q.className = 'form-answer-q';
      q.textContent = question;
      if (pendingReviewMsg) {
        var badge = document.createElement('span');
        badge.className = 'form-answer-badge';
        badge.textContent = 'Unreviewed';
        badge.title = pendingReviewMsg;
        q.appendChild(badge);
      }
      var a = document.createElement('div');
      a.className = 'form-answer-a';
      a.textContent = answer;
      row.appendChild(q);
      row.appendChild(a);
      row.appendChild(makeCopyButton(answer));
      container.appendChild(row);
    }

    addRow(fa.careerBreak.question, fa.careerBreak.answer);

    // The static answer is MORE informative than the plain CV auth line for
    // an ordinary build (it also carries the permission detail from
    // data.availability.permission - see this field's own _why) - so the
    // live model's line is only worth preferring once it actually differs
    // from the plain data.identity.rightToWork sentence, i.e. once the
    // extended-start-date template (item 2b) has actually substituted a
    // real date into it. Preferring the live line unconditionally would
    // silently drop the permission detail on every ordinary build instead.
    var authText = '';
    if (currentModel) {
      for (var i = 0; i < currentModel.length; i++) {
        if (currentModel[i].t === 'auth' && currentModel[i].text) { authText = currentModel[i].text; break; }
      }
    }
    var rtwAnswer = fa.rightToWorkSponsorship.answer;
    if (authText && authText !== loadedData.identity.rightToWork) rtwAnswer = authText;
    addRow(fa.rightToWorkSponsorship.question, rtwAnswer);

    addRow(fa.tcsRoleDescription.question, fa.tcsRoleDescription.answer, fa.tcsRoleDescription._pendingReview);
    addRow(fa.subjectsStudiedRelevance.question, fa.subjectsStudiedRelevance.answer, fa.subjectsStudiedRelevance._pendingReview);

    // Salary resolution (26 Sept 2026, item 3 - "Decisions are final; no
    // need to ask back"). Priority order, each step short-circuiting the
    // next:
    //   (a) the ad states its own salary -> generic answer, ALWAYS, even
    //       before "no archetype selected" - a stated figure in the ad
    //       makes every bucket question moot regardless of what's picked.
    //   no archetype selected yet / archetype has no bucket mapped / bucket
    //       not yet confirmed -> same three messages as before this pass.
    //   'advertised-rate' (retail-parttime) -> its own dedicated answer,
    //       never touches private-overrides at all (see that field's _why).
    //   otherwise -> resolve rule (b)'s regional substitution (ops-admin-
    //       analyst OR insurance-pensions, both to the same shared reduced
    //       figure - item 3a, 26 Sept 2026 second reply - and only once a
    //       non-Dublin/non-Cork City is actually typed), then look up the
    //       (possibly substituted) bucket in private-overrides same as
    //       before.
    var salaryAnswer;
    if (detectAdStatesSalary(inputsNow().jdText)) {
      salaryAnswer = 'In line with the advertised range.';
    } else if (!currentArchetypeId) {
      salaryAnswer = 'No archetype selected yet - pick one (or paste a matching job description) above to see the salary answer.';
    } else if (!(currentArchetypeId in fa.salaryBucketByArchetype)) {
      salaryAnswer = 'No salary bucket mapped for archetype "' + currentArchetypeId + '" - ask Derin.';
    } else {
      var bucket = fa.salaryBucketByArchetype[currentArchetypeId];
      if (bucket === null) {
        salaryAnswer = 'No salary bucket confirmed yet for this archetype - flagged as a judgement call, ask Derin before answering.';
      } else if (bucket === 'advertised-rate') {
        salaryAnswer = fa.retailAdvertisedRateAnswer.answer;
      } else {
        var effectiveBucket = bucket;
        // Item 3a (26 Sept 2026, second reply): "the out-of-region salary
        // rule applies to BOTH ops-admin-analyst and insurance-pensions
        // (claims and admin level roles)" - Derin gave ONE reduced figure
        // for both, not two, so both buckets collapse to the SAME shared
        // 'ops-admin-analyst-regional' key rather than a duplicated
        // 'insurance-pensions-regional' one.
        if ((bucket === 'ops-admin-analyst' || bucket === 'insurance-pensions') && detectOutsideDublinCork(letterInputsNow().city)) {
          effectiveBucket = 'ops-admin-analyst-regional';
        }
        var figure = privateOverrides.salaryRanges && privateOverrides.salaryRanges[effectiveBucket];
        var label = (fa.salaryBucketLabels && fa.salaryBucketLabels[effectiveBucket]) || effectiveBucket;
        salaryAnswer = figure ? figure : ('"' + label + '" band confirmed, but no figure is saved for it - add one under Private settings.');
      }
    }
    addRow('Expected salary range', salaryAnswer);
  }

  function updatePreview() {
    // Refuse to render whenever the current model's stamp doesn't match the
    // CURRENT live inputs - defence in depth beyond recompute()'s own
    // try/catch, for any future code path that might call this directly.
    var inputs = inputsNow();
    var liveJdHash = simpleHash(inputs.jdText + '|' + inputs.startDateText);
    if (!currentStamp || !currentModel ||
        currentStamp.jdHash !== liveJdHash ||
        currentStamp.dataVersion !== loadedData._version ||
        currentStamp.archetypeId !== currentArchetypeId) {
      showBuildError('Internal: the last successfully built model no longer matches the current inputs. Refusing to render a possibly-wrong CV - retype or reselect to rebuild.');
      updateDownloadState();
      clearLetterPanel('');
      renderFormAnswers();
      return;
    }

    var container = document.getElementById('preview-container');
    CVPreview.render(currentModel, container);
    // Third-review-pass redesign (17 Sept 2026): the fit decision no longer
    // comes from measuring this on-screen DOM mirror - js/pagefit.js sums
    // block heights measured once, offline, against the real renderer
    // (LibreOffice) that produces the actual .docx. render() above still
    // draws the mirror purely so Derin has something to look at.
    var fit = CVPageFit.measure(currentModel, 'cv');

    var m = CVPreview.PAGE_MARGIN_PX;
    var pageEl = document.getElementById('preview-page');
    pageEl.style.paddingTop = m.top + 'px';
    pageEl.style.paddingRight = m.right + 'px';
    pageEl.style.paddingBottom = m.bottom + 'px';
    pageEl.style.paddingLeft = m.left + 'px';

    var boundary = document.getElementById('page-boundary');
    boundary.style.top = (m.top + fit.rawUsableHeightPx) + 'px';
    boundary.style.left = m.left + 'px';
    boundary.style.right = m.right + 'px';

    // --- Phase 6: trim-to-fit (spec section 8 - "offer to drop the lowest-
    // priority included bullet and re-measure"). js/trim.js owns WHICH thing
    // to drop next per data.trimPolicy.order; this loop owns re-measuring
    // after each drop, and stopping once trimPolicy is exhausted (its own
    // step 5: "if still overflowing, STOP - don't shrink margins/fonts").
    // currentModel is intentionally reassigned here to the post-trim model -
    // that's also what handleDownload() and handleAuditExport() read, so the
    // downloaded .docx matches what fit.
    //
    // 17 Sept 2026 redesign: re-measuring is now pure arithmetic over the
    // model (js/pagefit.js), not a DOM operation - so this loop no longer
    // re-renders the on-screen mirror on every trim step, only re-sums.
    // The mirror is re-rendered ONCE at the end, after trimming has already
    // settled, purely for display.
    // The trim loop itself lives in fitToPage() (2 Oct 2026) so the section
    // dropdowns' previews trim exactly the way the real build does.
    var fitted = fitToPage(currentModel);
    currentModel = fitted.model;
    fit = fitted.fit;
    var trimLog = fitted.trimLog;
    lastCvFit = fit;
    if (trimLog.length) CVPreview.render(currentModel, container);
    lastTrimLog = trimLog;
    renderTrimLog(trimLog, fit);

    var readout = document.getElementById('fit-readout');
    if (fit.overflows) {
      setFitReadout(readout, false, fit,
        'Overflows by ' + Math.round(fit.overflowPx) + 'px',
        Math.round(fit.heightPx) + 'px measured against a ' + Math.round(fit.usableHeightPx) + 'px budget (A4\'s true limit is ' +
        Math.round(fit.rawUsableHeightPx) + 'px, ' + Math.round(fit.safetyMarginPx) + 'px safety margin held back). Would risk spilling to a second page.');
    } else {
      setFitReadout(readout, true, fit,
        'Fits on one page',
        Math.round(fit.heightPx) + ' of ' + Math.round(fit.usableHeightPx) + 'px used, ' + Math.round(fit.usableHeightPx - fit.heightPx) +
        'px to spare, plus a ' + Math.round(fit.safetyMarginPx) + 'px safety margin before A4\'s true ' + Math.round(fit.rawUsableHeightPx) + 'px limit.');
    }

    // --- Phase 6: the fit check itself (spec section 6) - verdict,
    // findings (each quoting the ad), and the keyword table. Run against
    // the FINAL (post-trim) model's text, since "did it make the CV"
    // should answer for what's actually on screen/downloadable, not a
    // pre-trim draft that may have since lost the bullet in question.
    var archetypeObj = CVAssemble.findById(loadedData.archetypes, currentArchetypeId);
    lastFitCheck = CVFitCheck.run(loadedData, lastExtraction, archetypeObj, CVVerify.collectText(currentModel));
    renderFitCheck(lastFitCheck);

    lastGateResult = CVVerify.runGates(currentModel, loadedData, fit);
    renderGates(lastGateResult);
    updateDownloadState();

    // Cover letter (21 Sept 2026): depends on currentArchetypeId/
    // lastExtraction/lastFitCheck.gapTrigger, all freshly set above - this
    // is the one place in the app where all three are guaranteed current,
    // so it runs at the end of every successful CV render rather than
    // needing its own copy of the recompute()/updatePreview() staleness
    // dance.
    recomputeLetter();

    renderFormAnswers();
    renderCvPickers();
  }

  // Debounced for the live-typing case only (200ms) - the review flagged
  // full extraction+scoring+rebuild+four-gate-run firing on every single
  // keystroke as unnecessary at this data size but a real drag as the data
  // file grows. The archetype-override dropdown fires immediately (a
  // discrete choice, not rapid typing), and the download/export buttons are
  // never debounced - only the live preview is.
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }
  var debouncedRecompute = debounce(recompute, 250);
  debouncedRecomputeLetter = debounce(recomputeLetter, 250);

  function renderDataVersion() {
    var el = document.getElementById('data-version');
    if (el) el.textContent = 'Data file version: ' + (loadedData && loadedData._version || 'unknown');
  }

  function handleDownload() {
    if (!lastGateResult || !lastGateResult.passed || !currentModel) return; // belt and braces
    var statusEl = document.getElementById('status');
    statusEl.textContent = 'Rendering...';
    // The Word library loads on the first Word download; a failure there or
    // while building reaches the catch below and is shown, not lost.
    CVLibs.load('word')
      .then(function () { return CVStyle.build(CVStyle.blocksToChildren(currentModel), filenameFor(currentArchetypeId)); })
      .then(function (filename) {
        statusEl.textContent = 'Downloaded ' + filename;
      })
      .catch(function (err) {
        statusEl.textContent = 'Failed: ' + err.message;
        console.error(err);
      });
  }

  // Audit-trail export: the JD text, the archetype actually used, every
  // selected bullet/profile variant id, the fit-check numbers, and the
  // data file's own _version - saved as a small JSON file alongside (not
  // instead of) the .docx. This is what lets a golden-test failure, or a
  // "why did it produce this CV" question, be answered three weeks later
  // instead of guessed at.
  function handleAuditExport() {
    if (!currentModel || !currentStamp) return;
    var inputs = inputsNow();
    var fit = null;
    if (lastGateResult) {
      var fitGate = lastGateResult.gates.filter(function (g) { return g.name === 'Page fit'; })[0];
      if (fitGate) fit = { passed: fitGate.passed, findings: fitGate.findings };
    }
    var trail = {
      exportedAt: new Date().toISOString(),
      dataVersion: loadedData._version,
      archetypeId: currentArchetypeId,
      archetypeOverridden: inputs.overridden,
      jdText: inputs.jdText,
      selectedVariantIds: extractSelectionIds(currentModel),
      fit: fit,
      gatesPassed: !!(lastGateResult && lastGateResult.passed),
      // Phase 6 additions: the fit check's own verdict/findings/keyword
      // table, and what trimPolicy dropped (if anything) to reach the model
      // that was actually rendered/downloaded - same "never hide what
      // changed" reasoning as everything else this export already carries.
      fitCheck: lastFitCheck,
      trimLog: lastTrimLog || [],
      // 2 Oct 2026: Derin's own section picks, if any (empty = all automatic).
      sectionChoices: { cv: cvChoices, letter: letterChoices }
    };
    var blob = new Blob([JSON.stringify(trail, null, 2)], { type: 'application/json' });
    CVLibs.saveBlob(blob, filenameFor(currentArchetypeId).replace(/\.docx$/, '') + '_audit-trail.json');
  }

  function boot() {
    // Loaded together (25 Sept 2026): private overrides must be in hand
    // before the first recomputeLetter() call, same as loadedData itself -
    // otherwise the referee block would render once as absent, then
    // "appear" on the very next keystroke once the override arrived,
    // which is a confusing, non-deterministic first paint for no reason
    // (the file is tiny and local; there's no cost to waiting for both).
    CVData.load()
      .then(function (data) {
        privateOverrides = loadPrivateOverridesFromLocalStorage() || {};
        renderPrivateSettingsStatus();
        data = applyPrivateData(data, privateOverrides);
        loadedData = data;
        renderPrivateSettingsForm();
        dataErrors = CVValidate.validateData(data);
        renderDataVersion();
        if (dataErrors.length) {
          document.getElementById('load-status').textContent = 'Data file loaded, but failed validation - see below.';
          showValidationErrors(dataErrors);
          updateDownloadState();
          return; // refuse to configure renderers or build anything from a broken data file
        }
        CVStyle.configure(data.style);
        if (global.CVPdf) CVPdf.configure(data);
        CVPreview.configure(data.style);
        CVPageFit.configure(data);
        clearValidationErrors();
        populateArchetypeSelect(data);
        document.getElementById('load-status').textContent = 'Data file v' + (data._version || '?') + ' loaded.';
        // Non-blocking (part A's own implementation note - see
        // js/validate.js's shortCoverageReport): visibility into how many
        // blocks the shorten step can actually act on, not a gate.
        console.log('Short-variant coverage: ' + CVValidate.shortCoverageReport(data));
        // Zero-saving shorts (20 Sept 2026): same non-blocking visibility as
        // the coverage line above, not a gate - see CVValidate.zeroSavingShortsReport.
        var zeroSaving = CVValidate.zeroSavingShortsReport(data);
        if (zeroSaving) console.warn('Zero-saving shorts: ' + zeroSaving);
        recompute();
        // Runs even when recompute() above didn't reach a successful build
        // (e.g. no JD pasted yet) - the answers that don't depend on a build
        // (career break, TCS role, subjects studied) should still show.
        renderFormAnswers();
      })
      .catch(function (err) {
        document.getElementById('load-status').textContent = 'Failed to load data file: ' + err.message;
        console.error(err);
      });

    jdInputEl().addEventListener('input', debouncedRecompute);
    archetypeSelectEl().addEventListener('change', recompute);
    var startDateEl = startDateInputEl();
    if (startDateEl) startDateEl.addEventListener('input', debouncedRecompute);
    document.getElementById('download-btn').addEventListener('click', handleDownload);
    var pdfBtn = document.getElementById('download-pdf-btn');
    if (pdfBtn) pdfBtn.addEventListener('click', handlePdfDownload);
    // Hard-requirement banner actions (30 Sept 2026, additive).
    var hardReqBuildAnywayBtn = document.getElementById('hardreq-build-anyway-btn');
    if (hardReqBuildAnywayBtn) hardReqBuildAnywayBtn.addEventListener('click', handleHardReqBuildAnyway);
    var hardReqSkipBtn = document.getElementById('hardreq-skip-btn');
    if (hardReqSkipBtn) hardReqSkipBtn.addEventListener('click', handleHardReqSkip);
    var auditBtn = document.getElementById('audit-export-btn');
    if (auditBtn) auditBtn.addEventListener('click', handleAuditExport);

    // "Load private settings" (27 Sept 2026, item 3) - the button just
    // proxies to the hidden file input; the input's own change event does
    // the actual reading, via handlePrivateSettingsFile above.
    var loadPrivateBtn = document.getElementById('load-private-settings-btn');
    var privateFileInput = document.getElementById('private-settings-file-input');
    if (loadPrivateBtn && privateFileInput) {
      loadPrivateBtn.addEventListener('click', function () { privateFileInput.click(); });
      var privateForm = document.getElementById('private-settings-form');
      if (privateForm) privateForm.addEventListener('submit', handlePrivateSettingsSave);
      privateFileInput.addEventListener('change', function () {
        var file = privateFileInput.files && privateFileInput.files[0];
        handlePrivateSettingsFile(file);
        // Reset so picking the SAME file again (e.g. after editing it on
        // disk and re-saving) still fires a change event next time.
        privateFileInput.value = '';
      });
    }

    // Cover-letter form fields (21 Sept 2026). Text fields are debounced,
    // same reasoning as the JD textarea (rapid typing); the title-mismatch
    // checkbox fires immediately, same as the archetype dropdown (a
    // discrete choice, not typing).
    ['letter-company', 'letter-role', 'letter-team', 'letter-recipient-name', 'letter-city'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', debouncedRecomputeLetter);
    });
    var titleMismatchEl = document.getElementById('letter-title-mismatch');
    if (titleMismatchEl) titleMismatchEl.addEventListener('change', recomputeLetter);
    // "Back to recommended" for each set of section dropdowns (2 Oct 2026).
    var cvReset = document.getElementById('cv-pickers-reset');
    if (cvReset) cvReset.addEventListener('click', function () { cvChoices = {}; recompute(); });
    var letterReset = document.getElementById('letter-pickers-reset');
    if (letterReset) letterReset.addEventListener('click', function () { letterChoices = {}; recomputeLetter(); });
    // A field Derin edits is his from then on, for this ad (2 Oct 2026).
    AD_FIELDS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (!el) return;
      el.addEventListener('input', function () {
        adTypedByHand[f.key] = true;
        renderAdInfo();
      });
    });
    var letterDownloadBtn = document.getElementById('letter-download-btn');
    if (letterDownloadBtn) letterDownloadBtn.addEventListener('click', handleLetterDownload);
    var letterPdfBtn = document.getElementById('letter-download-pdf-btn');
    if (letterPdfBtn) letterPdfBtn.addEventListener('click', handleLetterPdfDownload);
  }

  boot();

  // Test-only surface. index.html never calls this; index.test.html's own
  // one-line inline script wires window.__testRebuild into it, so the
  // Playwright audit script can inject a deliberately-broken model without
  // this file needing a second, test-specific copy of itself.
  global.CVApp = {
    _test: {
      // 8 Oct 2026: what "Should you apply?" shows, for the suites.
      getVerdict: function () { return lastVerdict ? JSON.parse(JSON.stringify(lastVerdict)) : null; },
      // 2 Oct 2026: the section dropdowns' state, read-only, for the e2e
      // scripts and the picker tests.
      getSectionState: function () {
        return {
          cvChoices: JSON.parse(JSON.stringify(cvChoices)),
          letterChoices: JSON.parse(JSON.stringify(letterChoices)),
          cvAuto: lastCvAuto ? JSON.parse(JSON.stringify(lastCvAuto)) : null,
          letterAuto: lastLetterAuto ? JSON.parse(JSON.stringify(lastLetterAuto)) : null,
          echoText: selectedEchoText,
          echoCandidates: lastLetterResult ? lastLetterResult.echoCandidates.map(function (c) { return c.text; }) : []
        };
      },
      setModelForTest: function (newModel) {
        currentModel = newModel;
        currentStamp = { archetypeId: currentArchetypeId, jdHash: simpleHash(inputsNow().jdText + '|' + inputsNow().startDateText), dataVersion: loadedData && loadedData._version };
        updatePreview();
      },
      // Read-only handle onto the exact object boot() loaded and configured
      // every module with (CVStyle/CVPreview/CVPageFit.configure all got
      // THIS reference, not a copy). Exists so a test that temporarily
      // reconfigures a module against its own cloned data (e.g. CVPageFit's
      // object-identity cert/module lookups) can restore the real app's
      // module state afterwards, rather than leaving it pointed at a clone
      // for the rest of the browser session - a real bug found 19 Sept 2026
      // when a later UI-driven test started throwing "could not find the
      // certification entry" because an earlier test's CVPageFit.configure
      // call was never undone.
      getLoadedData: function () {
        return loadedData;
      },
      // Item 5 (26 Sept 2026): form-answers panel's salary-figure lookup
      // reads the real privateOverrides.json when present, which is
      // gitignored and never exists in this sandbox - same problem the
      // refereeName tests solve by passing a synthetic opts value straight
      // into buildLetterModel(). renderFormAnswers() has no opts parameter
      // (it reads module state directly, by design - see its own header
      // comment on why it re-reads currentModel/currentArchetypeId live), so
      // this hook substitutes privateOverrides for the duration of a test
      // and immediately re-renders the panel; call again with {} (or omit
      // the argument) to restore the "file absent" state real users see.
      setPrivateOverridesForTest: function (overrides) {
        privateOverrides = overrides || {};
        renderFormAnswers();
      }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
