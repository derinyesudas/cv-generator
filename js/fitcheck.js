// ---------------------------------------------------------------------------
// Phase 6: the fit check (build spec section 6). Runs after the archetype
// is chosen and the CV is assembled, and answers three separate questions
// from the same pasted JD:
//
//   1. Verdict - BLOCKED / STRETCH / GOOD (see computeVerdict below).
//   2. Findings - every data.warnings pattern that matched, each one
//      quoting the actual sentence of the ad it came from ("Wants 3+
//      years, you have 1" is useful; "experience mismatch" is not - spec
//      section 6, verbatim).
//   3. A keyword table - term, does the JD want it, do I have it, did it
//      make the CV - spec section 9's "middle pane" requirement.
//
// Deliberately never touches the DOM and never decides anything about
// rendering - js/app.js owns turning this into the verdict band / findings
// list / keyword table on screen. This file also never refuses to build a
// CV: spec section 6 is explicit - "Never refuse to generate. Show the
// verdict prominently and let me decide. I have applied to BLOCKED roles
// deliberately before and I will again." A BLOCKED verdict is information,
// not a gate; it does not touch the download button (js/verify.js's four
// gates are the only things that do that).
//
// One correction to js/matcher.js's own header comment, made here rather
// than there: that file's header says warnings patterns would be "wired up"
// through CVMatcher once Phase 6 existed. That turned out not to be
// possible as written - data.warnings[].pattern entries are full regex
// fragments (alternation, quantifiers, `\d+`, `.{0,60}` gaps), not simple
// matchRule stem/exact terms, and running them through CVMatcher.escapeRe()
// would turn "(freelance|self-employed...)" into a literal string search
// for those exact characters, breaking every pattern that isn't a bare
// word. Warnings are matched here as ordinary JS regexes instead, against
// the RAW (un-normalized) JD text so a finding can quote the ad's actual
// wording, punctuation included - not the never-claim gate's job, which is
// why it's a separate, simpler matcher in the first place.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Score = global.CVScore;
  var Matcher = global.CVMatcher;
  var Experience = global.CVExperience;
  var Segment = global.CVSegment;
  if (!Score || !Matcher || !Experience || !Segment) {
    throw new Error("fitcheck.js loaded before js/score.js, js/matcher.js, js/experience.js, or js/segment.js. Check <script> order.");
  }

  // --- Quoting the ad: find the sentence/line a regex match fell inside ---
  // sentenceSpans/quoteAt moved to js/segment.js (18-19 Sept 2026) - both
  // this file's own findWarningFindings below and segment.js's heading
  // segmentation / years extractor need the same "split into quotable
  // chunks" utility, so it now lives below both of its consumers rather
  // than being owned by (and duplicated from) just one of them. Delegated
  // here, not re-implemented, and re-exported below under the same names so
  // js/letterbuild.js's existing `FitCheck.sentenceSpans` call keeps
  // working unchanged.
  var sentenceSpans = Segment.sentenceSpans;
  var quoteAt = Segment.quoteAt;

  // --- Wording-driven severity (data.warnings[].severityByWording), added
  // 14 Sept 2026 for w-qualification per Derin's own escalation instruction:
  // "drive severity off the advert's wording, not a constant." A credential
  // Derin already holds or is demonstrably working toward never flags at
  // all (checked against the whole JD - a held credential is a fact about
  // him, not about ad phrasing). Otherwise, severity depends on whether a
  // hedge word (desirable / or equivalent / working towards / would be an
  // advantage / or relevant experience) appears in the SAME sentence as the
  // credential mention - checked against the already-extracted quote, not
  // the whole ad, so a hedge attached to a different requirement elsewhere
  // in the posting can't soften an unhedged line it has nothing to do with.
  // Returns null when the finding should not be raised at all (held/
  // in-progress case), otherwise {severity, message}.
  function resolveWordingSeverity(w, quote, rawJD) {
    var rule = w.severityByWording;
    var held = rule.heldOrInProgress || [];
    for (var i = 0; i < held.length; i++) {
      var hp;
      try {
        hp = new RegExp(held[i], "i");
      } catch (e) {
        throw new Error("fitcheck.js: data.warnings['" + w.id + "'].severityByWording.heldOrInProgress[" + i + "] is not a valid regex: " + e.message);
      }
      if (hp.test(rawJD)) return null;
    }
    var hedgeRe;
    try {
      hedgeRe = new RegExp(rule.hedgePattern, "i");
    } catch (e) {
      throw new Error("fitcheck.js: data.warnings['" + w.id + "'].severityByWording.hedgePattern is not a valid regex: " + e.message);
    }
    if (hedgeRe.test(quote)) {
      return { severity: rule.hedgedSeverity, message: w.hedgedMessage || w.message };
    }
    return { severity: rule.unhedgedSeverity, message: w.message };
  }

  // --- Outcome-log summary (data.warnings[].outcomeLog), added 14 Sept 2026
  // per Derin's own instruction: the log may PROMPT, it may never ACT.
  // Nothing here changes severity - it only surfaces a plain-language count
  // so a person can look at the evidence and decide, the same way a real
  // fit-check finding is shown but never auto-applied. Returns null when the
  // log is empty (today: always, for every real warning) so nothing renders.
  // "Negative" is deliberately narrow - only a confirmed "rejected" outcome
  // counts, not "no response" (silence is not evidence of anything) and not
  // a later-stage outcome (screened/interviewed/offer aren't negative at all).
  function summarizeOutcomeLog(log) {
    if (!log || !log.length) return null;
    var negative = log.filter(function (e) { return e.outcome === "rejected"; }).length;
    var dates = log.map(function (e) { return e.date; }).filter(Boolean).sort();
    var mostRecent = dates.length ? dates[dates.length - 1] : "an unknown date";
    return log.length + " logged outcome" + (log.length === 1 ? "" : "s") +
      " (" + negative + " rejected), most recent " + mostRecent + " - worth a look, not a verdict.";
  }

  // --- Findings: every data.warnings entry whose pattern matches the raw
  // JD text. BLOCKED/STRETCH/GOOD is computed separately (computeVerdict) -
  // this just collects what matched, so "info" findings (like w-sponsorship's
  // good news) are shown even though they never affect the verdict. Most
  // entries have a flat severity; an entry with severityByWording (today:
  // w-qualification) instead gets its severity resolved per-match from the
  // ad's own wording, and can resolve to "raise nothing at all" (a held or
  // in-progress credential) - see resolveWordingSeverity above.
  function findWarningFindings(data, rawJD) {
    var findings = [];
    // Fix 1 (18-19 Sept 2026, Derin's own instruction): computed once per
    // call, not per warning - a warning pattern should not be able to fire
    // off a sentence under an IGNORED heading (or one caught by segment.js's
    // belt-and-braces absolute exclusion) any more than that sentence
    // should be offered as an ECHO quote. See js/segment.js's header.
    var segmentation = Segment.classifySentences(rawJD);
    function isMatchableAt(index) {
      for (var i = 0; i < segmentation.sentences.length; i++) {
        var s = segmentation.sentences[i];
        if (index >= s.start && index < s.end) return s.matchable;
      }
      return true; // no containing sentence found (shouldn't happen) - fail open rather than silently drop a real finding
    }
    // 9 Oct 2026: a warning marked confirmedByYearsExtractor (w-years) only
    // counts a hit inside a sentence whose figure js/segment.js's years
    // extractor accepted as an experience requirement (Derin's four
    // conditions: a years word, an experience word or a matchable section,
    // and 15 or under). Without this the warning's plain regex fired on
    // company history ("for over 100 years") that the extractor had already
    // discarded, so the screen said "no experience requirement detected"
    // and "Years of experience demanded" about the same ad.
    var yearsInfo = null;
    function yearsAcceptedAt(index) {
      if (!yearsInfo) yearsInfo = Segment.extractYearsInfo(rawJD);
      return yearsInfo.candidates.some(function (c) {
        return c.valid && index >= c.sentenceStart && index < c.sentenceEnd;
      });
    }
    (data.warnings || []).forEach(function (w) {
      var re;
      try {
        re = new RegExp(w.pattern, "gi");
      } catch (e) {
        throw new Error("fitcheck.js: data.warnings['" + w.id + "'].pattern is not a valid regex: " + e.message);
      }
      // Loops past a boilerplate (non-matchable) hit to find a real one
      // later in the ad, rather than stopping at the first match the way
      // the old single re.exec() call did - a false hit earlier in the ad
      // must not suppress a genuine one later in it.
      var m;
      var chosen = null;
      while ((m = re.exec(rawJD)) !== null) {
        if (isMatchableAt(m.index) && (!w.confirmedByYearsExtractor || yearsAcceptedAt(m.index))) { chosen = m; break; }
        if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width match loops
      }
      if (!chosen) return;
      var quote = quoteAt(rawJD, chosen.index, chosen[0]);
      var outcomeNote = summarizeOutcomeLog(w.outcomeLog);
      if (w.severityByWording) {
        var resolved = resolveWordingSeverity(w, quote, rawJD);
        if (!resolved) return;
        findings.push({ id: w.id, severity: resolved.severity, message: resolved.message, quote: quote, source: "warning", outcomeNote: outcomeNote });
      } else {
        findings.push({ id: w.id, severity: w.severity, message: w.message, quote: quote, source: "warning", outcomeNote: outcomeNote });
      }
    });
    return findings;
  }

  // --- Experience-test skip conditions (data.facts.experienceRule.skipSignals,
  // Derin's own instruction 14 Sept 2026): the years-required check below
  // never runs at all - no stretch reason, no gap trigger - when the CHOSEN
  // archetype is one his MSc-completion timeline makes the test meaningless
  // for (graduate-programme today), or when the ad's own text signals an
  // internship or an explicitly no-experience-required/entry-level/graduate
  // posting. This is checked before anything else about years, not folded
  // into the band logic below, because it's a different kind of rule: the
  // band logic says "how big is the gap", this says "there is no gap
  // question to ask here at all."
  function shouldSkipExperienceTest(data, archetype, rawJD) {
    var rule = data.facts.experienceRule;
    var skip = rule && rule.skipSignals;
    if (!skip) return false;
    if (archetype && (skip.skipArchetypeIds || []).indexOf(archetype.id) !== -1) return true;
    if (skip.internshipLanguagePattern && new RegExp(skip.internshipLanguagePattern, "i").test(rawJD)) return true;
    if (skip.noExperienceLanguagePattern && new RegExp(skip.noExperienceLanguagePattern, "i").test(rawJD)) return true;
    return false;
  }

  // --- Ambiguous experience language (data.facts.experienceRule.ambiguousLanguagePattern):
  // Derin, 14 Sept 2026: "figure is ambiguous or extraction failed -> say so
  // on the job card. Don't guess a number and don't silently drop the
  // requirement." Only meaningful when NO numeric years figure was found -
  // if one was found, there's nothing ambiguous about it, whatever else the
  // ad also says.
  function detectAmbiguousExperienceLanguage(data, rawJD, yearsRequired) {
    if (yearsRequired != null) return false;
    var rule = data.facts.experienceRule;
    if (!rule || !rule.ambiguousLanguagePattern) return false;
    var re;
    try {
      re = new RegExp(rule.ambiguousLanguagePattern, "i");
    } catch (e) {
      throw new Error("fitcheck.js: data.facts.experienceRule.ambiguousLanguagePattern is not a valid regex: " + e.message);
    }
    return re.test(rawJD);
  }

  // --- Verdict -----------------------------------------------------------
  //   BLOCKED - any warnings entry with severity "block" matched.
  //   STRETCH - years required falls in a stretch/reach band against
  //             yearsRelevant (see data.facts.experienceRule.verdictBands),
  //             OR 2+ named tools confirmed missing.
  //   GOOD    - everything else.
  // Years-required thresholds and the skip/ambiguous rules above are all
  // Derin's own instruction, 14 Sept 2026, replacing the original Phase 6
  // "gap >= 2 years" placeholder - see data.facts.experienceRule for his
  // exact wording and this file's own reasoning for NOT adding a fourth
  // verdict tier for the "4+ years = out of reach" case (verdictBands._answer).
  // "Years had" is now js/experience.js's CVExperience.computeExperience()
  // output (yearsRelevant), derived from data.facts.roles[].employment at
  // call time - never a stored, frozen figure.
  function computeVerdict(data, extraction, warningFindings, archetype) {
    if (warningFindings.some(function (f) { return f.severity === "block"; })) {
      return { verdict: "BLOCKED", stretchReasons: [], yearsAmbiguous: false, yearsRequiredDiscarded: false };
    }
    var rawJD = extraction.raw || "";
    var experience = Experience.computeExperience(data);
    var bands = data.facts.experienceRule && data.facts.experienceRule.verdictBands;
    var yearsRequired = extraction.yearsRequired;
    var stretchReasons = [];
    var yearsAmbiguous = false;

    if (!shouldSkipExperienceTest(data, archetype, rawJD)) {
      if (yearsRequired != null && bands) {
        if (yearsRequired >= bands.reachMinYears) {
          stretchReasons.push("Wants " + yearsRequired + "+ years in a relevant role, you have " +
            experience.yearsRelevant + " - likely out of reach, not just a stretch.");
        } else if (yearsRequired >= bands.stretchMinYears) {
          stretchReasons.push("Wants " + yearsRequired + "+ years in a relevant role, you have " +
            experience.yearsRelevant + " - a stretch.");
        }
        // yearsRequired <= bands.noStretchMaxYears falls through here with no
        // reason added, by design: "not a stretch factor at all" (Derin).
      } else if (yearsRequired == null) {
        // No figure given must not move the verdict either way - UNLESS the
        // ad's own wording signals a real, unparsed requirement, which gets
        // surfaced (not scored) instead of silently dropped.
        yearsAmbiguous = detectAmbiguousExperienceLanguage(data, rawJD, yearsRequired);
      }
    }

    var missing = extraction.tools.confirmedMissing || [];
    if (missing.length >= 2) {
      stretchReasons.push(missing.length + " named tools confirmed missing: " + missing.join(", ") + ".");
    }
    // Fix 3 reporting requirement (18-19 Sept 2026, Derin's own instruction:
    // "Track discards... show 'no experience requirement detected in this
    // ad'"): distinct from yearsAmbiguous above (no number at all, but vague
    // language) - this is "a number WAS found, and every candidate got
    // discarded by condition 3 or 4" (e.g. a company's "100 years" history
    // claim). Both are surfaced, never silently merged into a guessed
    // figure or a dropped requirement.
    return {
      verdict: stretchReasons.length ? "STRETCH" : "GOOD",
      stretchReasons: stretchReasons,
      yearsAmbiguous: yearsAmbiguous,
      yearsRequiredDiscarded: !!extraction.yearsRequiredAllDiscarded
    };
  }

  // --- Gap trigger for the eventual cover letter (Phase 7) -------------
  // data.letterBlocks.gap only had two real triggers before 21 Sept 2026:
  // "yearsShort" and "titleMismatch" (the latter still a manual flag, not
  // auto-detected here - see below). "titleMismatch" needs the ad's own job
  // title compared against Derin's, which spec 5.1 extraction does not
  // capture and which Phase 6 has no input field for yet (that's the "role
  // title" field spec section 9 describes for the cover-letter pane) - so it
  // is never auto-triggered here. Uses the same skip rule as the verdict
  // above, for the same reason: a graduate/internship posting has no years
  // gap to write a cover-letter paragraph about.
  //
  // 21 Sept 2026 (Derin's Suggestion A, "top gap" wiring): after the years
  // check above (kept separate - it has its own skip rules and a numeric
  // comparison against yearsRelevant, not a plain warnings match), the FIRST
  // data.warnings match (file order - the same "first-listed wins" tie-break
  // this app uses everywhere else, e.g. js/letterbuild.js's frame-variant
  // pick) whose id names a gap this app has an approved letter paragraph for
  // becomes the gap trigger. `warningFindings` is already computed by
  // runFitCheck below (findWarningFindings) - passed in rather than
  // recomputed, same layering discipline as everything else in this file
  // taking its inputs as arguments instead of calling back into its own
  // caller's other computations.
  //
  // w-qualification is a special case, not a straight id->trigger mapping:
  // its pattern matches several distinct credentials (ACA/ACCA/CIMA/CFA/QFA/
  // qualified accountant/chartered), but letterBlocks.gap only has an
  // approved paragraph for QFA specifically ("I am not QFA qualified",
  // let-gap-qfa). Mapping any w-qualification match to that paragraph would
  // misdescribe the gap the moment a future ad names ACCA/CIMA/CFA instead -
  // checked here against the finding's own quoted sentence (same "checked
  // against the ad's actual wording, not assumed" discipline
  // resolveWordingSeverity above already uses for the same warning), not
  // guessed.
  var GAP_TRIGGER_BY_WARNING_ID = {
    "w-qualification": "qfa",
    "w-irish-pensions-legislation": "irishPensions",
    "w-sales-experience": "sales"
  };
  function topWarningGapTrigger(data, warningFindings) {
    var warnings = data.warnings || [];
    for (var i = 0; i < warnings.length; i++) {
      var id = warnings[i].id;
      var trigger = GAP_TRIGGER_BY_WARNING_ID[id];
      if (!trigger) continue;
      var finding = warningFindings.filter(function (f) { return f.id === id; })[0];
      if (!finding) continue;
      if (id === "w-qualification" && !/\bqfa\b/i.test(finding.quote)) continue;
      return trigger;
    }
    return null;
  }

  function computeGapTrigger(data, extraction, archetype, warningFindings) {
    var rawJD = extraction.raw || "";
    if (shouldSkipExperienceTest(data, archetype, rawJD)) return "none";
    var experience = Experience.computeExperience(data);
    if (extraction.yearsRequired != null && extraction.yearsRequired > experience.yearsRelevant) {
      return "yearsShort";
    }
    var topWarning = topWarningGapTrigger(data, warningFindings || []);
    if (topWarning) return topWarning;
    return "none";
  }

  // --- Keyword table: spec section 9's middle pane - "term, whether the JD
  // wants it, whether I have it, whether it made the CV." Rows are every
  // keyword the CURRENT archetype scores on (so the table explains that
  // archetype's own score) plus every data.knownAbsentTools.tools entry the
  // JD actually names (so a tool gap shows up even if it's not one of the
  // archetype's scoring keywords). `modelText` is the already-assembled
  // CV's full text (js/verify.js's CVVerify.collectText output) - "made the
  // CV" is a literal presence check against what was actually printed, not
  // a re-derivation of assemble.js's own selection logic.
  function buildKeywordTable(data, archetype, extraction, modelText) {
    var rows = [];
    var seen = {};
    function addRow(term, have) {
      var key = term.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      // Sentence-scoped (27 Sept 2026 fix) - matches what scoreArchetype
      // itself now checks against, so this table's "wanted" column can
      // never disagree with the score that was actually computed from it.
      var wanted = Score.countHits(extraction.matchableSentences || [], term) > 0;
      var madeCV = Matcher.test(modelText, term);
      rows.push({ term: term, wanted: wanted, have: have, madeCV: madeCV });
    }
    Object.keys(archetype.keywords).forEach(function (term) { addRow(term, "yes"); });
    (extraction.tools.have || []).forEach(function (term) { addRow(term, "yes"); });
    (extraction.tools.confirmedMissing || []).forEach(function (term) {
      var isSql = term.toLowerCase() === "sql" && data.knownAbsentTools && data.knownAbsentTools._sqlNote;
      addRow(term, isSql ? "in progress" : "no");
    });
    return rows;
  }

  // extraction: js/score.js's CVScore.extractFromJD() output.
  // archetype: the chosen archetype object (data.archetypes entry).
  // modelText: js/verify.js's CVVerify.collectText(model) - the already-
  // assembled CV's text, for the keyword table's "made the CV" column.
  function runFitCheck(data, extraction, archetype, modelText) {
    var rawJD = extraction.raw || "";
    var warningFindings = findWarningFindings(data, rawJD);
    var verdictResult = computeVerdict(data, extraction, warningFindings, archetype);
    return {
      verdict: verdictResult.verdict,
      stretchReasons: verdictResult.stretchReasons,
      yearsAmbiguous: verdictResult.yearsAmbiguous,
      // Fix 3 reporting requirement, see computeVerdict's own comment.
      yearsRequiredDiscarded: verdictResult.yearsRequiredDiscarded,
      // Fix 1 reporting requirement (18-19 Sept 2026, Derin's own
      // instruction: "failing open is acceptable; failing open without
      // telling anyone is not") - lifted straight from extraction (already
      // computed once in js/score.js's extractFromJD) so the UI can show
      // "no section headings found, matched against full ad" / list any
      // heading-shaped lines segment.js couldn't classify, rather than the
      // matchable/ignored split happening invisibly.
      headingsFound: extraction.headingsFound,
      unclassifiedHeadings: extraction.unclassifiedHeadings,
      experience: Experience.computeExperience(data),
      findings: warningFindings,
      gapTrigger: computeGapTrigger(data, extraction, archetype, warningFindings),
      keywordTable: buildKeywordTable(data, archetype, extraction, modelText)
    };
  }

  // sentenceSpans exported (Phase 7 addition, 18 Sept 2026, now delegating
  // to js/segment.js - see that file's header): js/letterbuild.js needs the
  // same "split the pasted JD into quotable sentence/line chunks" utility
  // for ECHO candidate extraction - NOT the gap-oriented quoteAt/
  // findWarningFindings logic above, which Derin was explicit is the wrong
  // selection criterion for ECHO (it surfaces what he FAILS; ECHO needs what
  // he MEETS). Only the splitting mechanism is shared; the selection logic
  // that consumes it is entirely separate and lives in letterbuild.js.
  global.CVFitCheck = { run: runFitCheck, sentenceSpans: sentenceSpans };
})(typeof window !== "undefined" ? window : globalThis);
