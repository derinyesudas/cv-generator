// ---------------------------------------------------------------------------
// Hard-requirement ineligibility alert (30 Sept 2026, Derin's own
// instruction). Purely additive, isolated module: reads data.hardRequirements
// and a pasted JD, and reports RED/AMBER/GREEN with findings BEFORE any
// document is built. Never touches the DOM, never mutates a model, never
// refuses to build - js/app.js decides what RED/AMBER/GREEN means for the
// download flow, exactly the same division of labour js/fitcheck.js already
// has with js/app.js's renderFitCheck. This file is never consulted by
// js/assemble.js, js/letterbuild.js's existing gap-trigger system, or any
// existing safety gate - it is a second, independent read of the same JD
// text, reusing this app's own matching infrastructure rather than adding a
// third way to match text:
//   - js/matcher.js's CVMatcher.tagMatchesText for pattern matching (same
//     stem-set matching used for tag scoring everywhere else in this app).
//   - js/segment.js's CVSegment.sentenceSpans/extractYearsInfo for splitting
//     the JD and for the years-required figure - NOT js/score.js's own
//     extractYearsRequired() wrapper, which only returns a single collapsed
//     max value. This file needs the full per-sentence `candidates` list
//     (value, sentence text, start offset) the same way js/letterbuild.js's
//     buildEchoCandidates already reads directly from CVSegment.
//     extractYearsInfo for the exact same reason (see that file's own
//     comment on sentenceHasUnmetYears) - reading the richer extractor
//     directly, rather than through score.js's thin single-value wrapper,
//     IS reusing the existing years extractor, not reimplementing it.
//
// Section headings here are a SEPARATE, narrower classifier from
// js/segment.js's own MATCHABLE_HEADING_TERMS/IGNORED_HEADING_TERMS -
// deliberately not reused. Two reasons: (1) segment.js's own IGNORED list
// includes "what's next"/"submitting an application", which this feature's
// spec explicitly requires to stay INCLUDED ("regulatory text often sits at
// the end under headings like 'Next steps' or 'Additional information' -
// those ARE included, don't treat them as boilerplate"); reusing segment.js's
// list here would silently drop exactly the content this feature exists to
// catch. (2) segment.js's own REQUIREMENT_HEADING_TERMS doesn't match this
// feature's own spec'd list verbatim ("the skills you will have when you
// apply" isn't in it). Keeping a second, narrower, purpose-built classifier
// here is the same "one way to do a thing PER CONCERN" reasoning
// js/matcher.js's own header already uses for tokenize()/normalize() being
// duplicated rather than shared across files with different needs - not
// laziness, a deliberate scoping decision, flagged here as such.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  var Segment = global.CVSegment;
  if (!Matcher || !Segment) {
    throw new Error("hardreq.js loaded before js/matcher.js or js/segment.js. Check <script> order.");
  }

  // --- Narrow boilerplate-heading classifier --------------------------------
  // Only benefits / about-us / EEO / privacy / agency notices are ignored -
  // see file header for why this is deliberately narrower than
  // js/segment.js's own IGNORED_HEADING_TERMS.
  var IGNORED_HEADING_TERMS = [
    "benefit", "what's on offer", "what we offer", "perks",
    "about us", "about the company", "about the firm", "about the team",
    "our culture", "our values", "why join", "why you'll thrive", "why work",
    "equal opportunit", "eeo", "diversity", "inclusion", "our commitment", "commitment to",
    "privacy", "data protection", "recruiting scam", "recruitment scam", "fraud",
    "accessibility", "reasonable accommodation",
    "agency", "agencies", "recruitment agenc", "unsolicited"
  ];
  // Derin's own list, verbatim (spec section 2).
  var REQUIREMENT_HEADING_TERMS = [
    "essential", "requirements", "what you need to have",
    "the skills you will have when you apply", "about you", "what we're looking for"
  ];

  // Word-boundary term match, not a raw substring indexOf - this is the
  // exact "aca"/"academic" boundary trap js/matcher.js's own file header
  // warns about, and it is real here: a plain indexOf("about you") matches
  // inside "About Your New Job" (a real heading in the Sigmar fixture),
  // since "about your" literally starts with the same 10 characters as
  // "about you". Caught empirically running this module against the real
  // fixture corpus (not assumed), same discipline this project's own
  // matchRule._trap comment establishes for every other term list here.
  function headingTermMatches(term, lowerLine) {
    var re = new RegExp("\\b" + String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    return re.test(lowerLine);
  }

  function stripHeadingPunctuation(line) {
    return String(line || "").trim().replace(/[:?]+\s*$/, "").trim();
  }
  // Same structural heuristic js/segment.js's isHeadingShaped and
  // js/letterbuild.js's looksLikeHeadingFragment already use (a heading is
  // short and doesn't end like a sentence) - duplicated here rather than
  // imported for the same per-concern reason given in the file header.
  function isHeadingShaped(strippedLine) {
    var t = strippedLine;
    if (!t) return false;
    if (/[.!?]$/.test(t)) return false;
    var words = t.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 10;
  }
  function spanLooksLikeHeading(text) {
    return isHeadingShaped(stripHeadingPunctuation(text));
  }

  // { state: "included"|"ignored", requirement: bool } for a heading-shaped
  // line, or null when the line isn't heading-shaped, or is heading-shaped
  // but names neither list (transparent - inherits whatever section it's
  // nested under, same "unknown headings don't reset state" rule
  // js/segment.js's segmentHeadings already documents and uses).
  function headingState(line) {
    var stripped = stripHeadingPunctuation(line);
    if (!isHeadingShaped(stripped)) return null;
    var lower = stripped.toLowerCase();
    if (REQUIREMENT_HEADING_TERMS.some(function (t) { return headingTermMatches(t, lower); })) {
      return { state: "included", requirement: true };
    }
    if (IGNORED_HEADING_TERMS.some(function (t) { return headingTermMatches(t, lower); })) {
      return { state: "ignored", requirement: false };
    }
    return null;
  }

  // Walks the JD line by line tracking included/ignored + requirement-heading
  // state - same shape as js/segment.js's own segmentHeadings, own narrower
  // term lists. Default state before any heading is "included" (fail open,
  // same "scan every section except IGNORED boilerplate" rule the spec
  // states, and the same discipline js/segment.js's own header already
  // establishes for this app: "failing open is acceptable; failing open
  // without telling anyone is not").
  // Returns { regions, headingLineTexts }. headingLineTexts is the set of
  // (trimmed) line texts that ACTUALLY matched a heading term (requirement
  // or ignored) - i.e. real section headers, not merely lines that happen
  // to be short and unpunctuated. Only these are excluded from content
  // scanning below (see includedContentSentences) - fixing a real bug found
  // comparing against cv-engine-reference.js on the real Standard Life
  // fixture (1 Oct 2026): "- QFA qualified or part-qualified" is a bare
  // bullet with no trailing punctuation and five words, so the old filter
  // (spanLooksLikeHeading, a purely structural "is this short and
  // sentence-less" check) misclassified it as a heading line and silently
  // dropped it from scanning entirely - a real hard-requirement line
  // producing NO finding at all (not even amber), the exact silent-miss
  // failure mode this feature exists to prevent. js/segment.js and the
  // reference engine both only ever call a line a heading when it matches a
  // known term; shape alone was never meant to be sufient, and isn't here
  // either - isHeadingShaped/spanLooksLikeHeading remain in use only inside
  // headingState() itself, which still requires a term match before a line
  // counts as a heading at all.
  function segmentRegions(rawJD) {
    var text = rawJD || "";
    var lines = text.split("\n");
    var offset = 0;
    var regions = [];
    var state = "included";
    var requirement = false;
    var regionStart = 0;
    var headingLineTexts = {};
    lines.forEach(function (line) {
      var lineStart = offset;
      var hs = headingState(line);
      if (hs) {
        if (lineStart > regionStart) regions.push({ start: regionStart, end: lineStart, state: state, requirement: requirement });
        state = hs.state;
        requirement = hs.requirement;
        regionStart = lineStart;
        headingLineTexts[line.trim()] = true;
      }
      offset = lineStart + line.length + 1; // +1 for the '\n' split() removed
    });
    if (regionStart < text.length) regions.push({ start: regionStart, end: text.length, state: state, requirement: requirement });
    return { regions: regions, headingLineTexts: headingLineTexts };
  }
  function regionAt(regions, offset) {
    for (var i = 0; i < regions.length; i++) {
      if (offset >= regions[i].start && offset < regions[i].end) return regions[i];
    }
    return { state: "included", requirement: false }; // shouldn't happen - regions cover [0, text.length)
  }

  // Every included (non-ignored), non-heading sentence/line, via
  // js/segment.js's own sentence splitter (reused, not reimplemented).
  // headingLineTexts excludes only lines that ACTUALLY matched a heading
  // term (see segmentRegions above) - not every structurally heading-shaped
  // line, so a short, unpunctuated requirement bullet is never silently
  // dropped just because it happens to look heading-shaped.
  function includedContentSentences(rawJD, regions, headingLineTexts) {
    var spans = Segment.sentenceSpans(rawJD || "");
    return spans
      .map(function (span) {
        var region = regionAt(regions, span.start);
        return { text: span.text, start: span.start, included: region.state === "included", requirement: region.requirement };
      })
      .filter(function (s) { return s.included && !headingLineTexts[s.text.trim()]; });
  }

  // --- REQUIRED vs PREFERRED classification ---------------------------------
  // Signal lists are Derin's own (spec section 2). Added 8 Oct 2026 with his
  // OK: "preferable" and its common misspelling "preferrable", and a negated
  // requirement word ("not required", "not essential", "not mandatory",
  // "not a must") - an ad's "preferrable but not required" means optional,
  // and was being read as required because it contains "required". Listed
  // here, ahead of the REQUIRED check, so the negation is seen first.
  var PREFERRED_RES = [
    /\bdesirable\b/i, /\bpreferred\b/i, /\badvantageous\b/i, /\bideally\b/i,
    /would be an advantage/i, /\ba plus\b/i, /nice to have/i,
    /or working towards/i, /willing to complete/i,
    /with support\b/i, /full support\b/i, /study support\b/i,
    /\bpreferr?able\b/i,
    /\bnot (?:required|essential|mandatory|a must)\b/i
  ];
  var REQUIRED_RES = [
    /\bmust\b/i, /\brequired\b/i, /\bessential\b/i, /\bmandatory\b/i,
    /\bminimum\b/i, /as a minimum/i, /at least/i, /is a must\b/i
  ];
  function isPreferred(text) { return PREFERRED_RES.some(function (r) { return r.test(text); }); }
  function isRequired(text) { return REQUIRED_RES.some(function (r) { return r.test(text); }); }

  // Regulatory upgrade (spec section 2): these trigger ANYWHERE in the ad
  // upgrade an otherwise-ambiguous QUALIFICATION line to required.
  var REGULATORY_UPGRADE_RE = /minimum competency code|\bmcc\b|controlled function|\bcf\b\s+roles?|fitness and probity/i;
  function regulatoryUpgradeTriggered(rawJD) { return REGULATORY_UPGRADE_RE.test(rawJD || ""); }

  // Splits a sentence into clause-sized chunks on commas/semicolons - real
  // job-ad lines routinely pack a required item and a preferred item into
  // ONE printed sentence ("APA qualified as a minimum, with CIP
  // qualification considered highly desirable" - the Sedgwick fixture this
  // feature's own spec names). Classifying at whole-sentence granularity
  // would let "desirable" (attached to CIP) leak a PREFERRED verdict onto
  // APA, which the spec's own worked example requires to be REQUIRED.
  // Clause-scoping the required/preferred signal check is the fix; the
  // finding's own quote (see findItemFindings below) still shows the FULL
  // sentence, exactly as the spec asks ("shows the exact JD sentence
  // verbatim"), it's only the classification decision that's clause-scoped.
  function splitClauses(text) {
    var parts = String(text || "").split(/[,;]/).map(function (c) { return c.trim(); }).filter(Boolean);
    return parts.length ? parts : [String(text || "")];
  }

  // Classifies clause `idx` of `clauses`. A preferred/required signal in
  // THAT clause wins outright. Failing that, a preferred signal in the VERY
  // NEXT clause of the same sentence also counts ("APA qualified, or
  // willing to complete... with full support" - the GMIB fixture this
  // feature's spec names - the hedge sits in a clause of its own, trailing
  // the credential it's hedging). This only ever widens PREFERRED, never
  // REQUIRED, and only looks one clause forward - so it cannot leak a later,
  // unrelated clause's hedge backward past a clause that already resolved to
  // required on its own (classifyLocal returns as soon as a local
  // preferred/required signal is found, before ever reaching the next-clause
  // check - see the Sedgwick worked example above for exactly the case this
  // ordering protects).
  //
  // Returns { cls, explicit }: `explicit` is true when the ad's own words in
  // this clause (or the next) say required or optional, false when the
  // answer only comes from the section heading or nothing at all.
  function classifyLocal(clauses, idx, requirementHeading) {
    var local = clauses[idx];
    if (isPreferred(local)) return { cls: "preferred", explicit: true };
    if (isRequired(local)) return { cls: "required", explicit: true };
    var next = clauses[idx + 1];
    if (next && isPreferred(next)) return { cls: "preferred", explicit: true };
    if (requirementHeading) return { cls: "required", explicit: false };
    return { cls: "ambiguous", explicit: false };
  }

  // Whole-sentence classification (no clause splitting) - used only for the
  // generic years-figure check below, which the spec states purely in terms
  // of "a required line" / "a preferred line", with no comma-scoping worked
  // example the way the qualification items have. Kept simpler on purpose.
  function classifyWholeSentence(text, requirementHeading) {
    if (isPreferred(text)) return "preferred";
    if (isRequired(text)) return "required";
    if (requirementHeading) return "required";
    return "ambiguous";
  }

  // --- Sponsorship "now or in the future" (spec section 3): always AMBER,
  // independent of required/preferred classification and independent of
  // data.hardRequirements entirely.
  var SPONSORSHIP_FUTURE_RE = /\bsponsorship\b[\s\S]{0,60}?\bnow or in the future\b/i;
  function findSponsorshipFinding(sentences) {
    var hit = sentences.filter(function (s) { return SPONSORSHIP_FUTURE_RE.test(s.text); })[0];
    if (!hit) return null;
    return {
      id: "hr-sponsorship-future",
      label: "Sponsorship (now or in the future)",
      quote: hit.text,
      requirementType: "n/a",
      held: "unknown",
      severity: "amber",
      note: "Depends on how long your permission to work lasts - your answer to decide.",
      gapBlockId: null
    };
  }

  // --- data.hardRequirements.items findings ---------------------------------
  // held:true items are things Derin holds - never scanned for a gap.
  var SEVERITY_RANK = { required: 2, preferred: 1, ambiguous: 0 };

  // Which of two readings of the same item counts (Derin, 8 Oct 2026: the
  // ad's wording wins). A reading from the ad's own words beats one that is
  // only inferred - from a requirements heading, or from the
  // controlled-function rule upgrading a passing mention - so an item the ad
  // calls optional stays optional even in a regulated role. Between two
  // readings of the same kind, the stricter one wins.
  function outranks(a, b) {
    if (a.explicit !== b.explicit) return a.explicit;
    return SEVERITY_RANK[a.classification] > SEVERITY_RANK[b.classification];
  }
  function findItemFindings(data, rawJD, sentences) {
    var items = (data.hardRequirements && data.hardRequirements.items) || [];
    var findings = [];
    items.forEach(function (item) {
      if (item.held === true) return;
      var best = null;
      sentences.forEach(function (s) {
        var clauses = splitClauses(s.text);
        clauses.forEach(function (clauseText, i) {
          var hit = (item.patterns || []).some(function (p) { return Matcher.tagMatchesText(p, clauseText); });
          if (!hit) return;
          var local = classifyLocal(clauses, i, s.requirement);
          var cls = local.cls;
          if (cls === "ambiguous" && item.qualification && regulatoryUpgradeTriggered(rawJD)) cls = "required";
          var reading = { classification: cls, explicit: local.explicit, quote: s.text };
          if (!best || outranks(reading, best)) best = reading;
        });
      });
      if (!best) return;
      var severity;
      if (item.held === false) {
        severity = best.classification === "required" ? "red" : "amber";
      } else { // "unknown"
        severity = "amber";
      }
      findings.push({
        id: item.id,
        label: item.label,
        quote: best.quote,
        requirementType: best.classification,
        held: item.held,
        severity: severity,
        gapBlockId: item.gapBlockId || null
      });
    });
    return findings;
  }

  // --- Generic years-figure check (spec section 2, "Years"). Reuses
  // CVSegment.extractYearsInfo's own candidates (see file header) - a
  // candidate's own `valid` flag already applies the app's one existing
  // years-sanity rule (an experience word nearby, or a matchable section,
  // plus the <=15 plausibility cap that keeps "100 years" of company
  // history out) - not reimplemented here. This module adds its OWN
  // included/ignored filter on top (this file's narrower boilerplate list),
  // and its own minimum-above-1 / required-vs-preferred rule.
  function findYearsFindings(rawJD, regions) {
    var info = Segment.extractYearsInfo(rawJD);
    var findings = [];
    var seen = {};
    (info.candidates || []).forEach(function (c) {
      if (!c.valid) return;
      if (c.value <= 1) return; // spec: "up to 1-2 years" / "1-3 years" pass, no finding
      var region = regionAt(regions, c.start);
      if (region.state !== "included") return;
      if (seen[c.sentence]) return;
      seen[c.sentence] = true;
      var cls = classifyWholeSentence(c.sentence, region.requirement);
      findings.push({
        id: "hr-years",
        label: "Years of experience required",
        quote: c.sentence,
        requirementType: cls,
        held: false,
        severity: cls === "required" ? "red" : "amber",
        gapBlockId: null
      });
    });
    return findings;
  }

  // --- Top-level entry point -------------------------------------------------
  // Returns { verdict: "RED"|"AMBER"|"GREEN", findings: [...] }. Never
  // throws on ordinary input, never refuses anything - see file header.
  function run(data, rawJD) {
    var text = String(rawJD || "");
    if (!text.trim()) return { verdict: "GREEN", findings: [] };
    var segmented = segmentRegions(text);
    var regions = segmented.regions;
    var sentences = includedContentSentences(text, regions, segmented.headingLineTexts);

    var findings = [];
    findings = findings.concat(findItemFindings(data, text, sentences));
    findings = findings.concat(findYearsFindings(text, regions));
    var sponsorship = findSponsorshipFinding(sentences);
    if (sponsorship) findings.push(sponsorship);

    var verdict = "GREEN";
    if (findings.some(function (f) { return f.severity === "red"; })) verdict = "RED";
    else if (findings.length) verdict = "AMBER";

    return { verdict: verdict, findings: findings };
  }

  global.CVHardReq = {
    run: run,
    // Exposed for tests/debugging, not part of the "public API" other
    // modules are expected to call directly.
    _internal: {
      segmentRegions: segmentRegions,
      includedContentSentences: includedContentSentences,
      classifyLocal: classifyLocal,
      classifyWholeSentence: classifyWholeSentence,
      regulatoryUpgradeTriggered: regulatoryUpgradeTriggered,
      splitClauses: splitClauses
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
