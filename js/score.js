// ---------------------------------------------------------------------------
// Phase 5: "Scoring and assembly. Paste a JD, get the right archetype and
// variants." (build spec, section 11, step 5; the rules themselves are
// section 5.) Hardened after the 13 Sept 2026 code review - see
// cv-generator-data.json's _changelog for the data-side half of these fixes.
//
// This module does ONLY section 5.1 (extraction) and 5.2 (archetype
// scoring). Section 5.3 (using the extraction to actually choose profile/
// bullet/skill content) lives in js/assemble.js.
//
// All term-matching in this file goes through js/matcher.js's CVMatcher -
// this file no longer implements its own regex. That is the direct fix for
// the review's Finding 2/3: four separate hand-rolled matching techniques
// (this file had two of its own) is how a short term like "aca" ended up
// exact-matched safely in one place and raw-substring-matched (matching
// "vacancy", "academic") in another.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  var Segment = global.CVSegment;
  if (!Matcher) {
    throw new Error("score.js loaded before js/matcher.js. Check <script> order.");
  }
  if (!Segment) {
    throw new Error("score.js loaded before js/segment.js. Check <script> order.");
  }

  // Lowercase, strip punctuation except + and % (spec 5.1, verbatim), collapse
  // whitespace. Applied to both the JD and every term/tag before matching, so
  // "Power BI", "power-bi" and "POWER BI" all normalize the same way.
  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9+%\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Presence check for `term` against a list of individually-matchable
  // sentences, via js/matcher.js's stem-set tag matching (27 Sept 2026,
  // item 1e: "apply the new matcher to archetype scoring as well" - this
  // is that extension). Kept as CVScore.countHits, and still returns a
  // number (1 present, 0 not) rather than a plain boolean, since every
  // caller already just checks `> 0` - no return-shape change at any call
  // site for that part.
  //
  // The FIRST ARGUMENT'S SHAPE changed this pass, though, and is the more
  // important fix: this used to take one flattened, whole-document
  // normalized string. Empirically wrong once stem-set (word-set, order-
  // independent) matching went in - checked directly against the real
  // fixture corpus, not assumed: "finance administrator" newly registered
  // a hit against the real WTW pensions-administrator ad, and flipped its
  // archetype pick away from insurance-pensions, purely because "financial"
  // (from an unrelated "previous experience in Financial Services" bullet)
  // and "administrator"/"administration" (from the scheme-administration
  // description, several paragraphs away) happened to both appear
  // SOMEWHERE in the document - two unrelated sentences, word-salad-matched
  // into one false tag hit. A literal phrase match could never have made
  // that mistake (it needs the exact phrase together); stem-set matching
  // can, unless it's scoped down the same way js/letterbuild.js's
  // computeCloseMatchTrigger/buildEchoCandidates already scope theirs - to
  // one sentence at a time, never the whole document. So: `sentences` here
  // is an array of already-matchable sentence/span texts (js/segment.js's
  // classifySentences output, matchable ones only - see extractFromJD's
  // new matchableSentences field below), and a hit requires ONE sentence
  // to satisfy every content word of the term, not the words being spread
  // arbitrarily across the whole ad.
  //
  // The term itself needs no separate pre-normalize() step any more (unlike
  // before 27 Sept 2026): js/matcher.js's tagMatchesText normalizes/
  // tokenizes both sides itself for the ordinary stem-set path, and its
  // digit-guard fallback (for a term like "2:1") normalizes both sides the
  // same way internally too - so passing the raw term and a raw sentence
  // straight through is correct without this file doing that work first.
  function countHits(sentences, term) {
    var list = sentences || [];
    return list.some(function (s) { return Matcher.tagMatchesText(term, s); }) ? 1 : 0;
  }

  // Every tag that appears anywhere in skillLines terms, bulletVariants
  // variants, profileVariants, OR letterBlocks entries - built from the data
  // file itself, not a separately hand-typed list, so it can never silently
  // drift from what the app actually knows how to match against.
  //
  // Bug found and fixed 20 Sept 2026, while adding a fourth letterBlocks.
  // evidence variant: this function's own header comment claimed exactly
  // that guarantee ("can never silently drift") but had never actually
  // walked data.letterBlocks - a gap that predates even the 19 Sept TCS
  // split (let-ev-console/let-ev-ai always had tags too). Checked directly:
  // of the (pre-fix) 14 distinct letterBlocks.evidence tags, only 4
  // ("peer review", "financial services", "ai", "process improvement")
  // happened to coincide with a tag used elsewhere in the file; the other
  // 10 ("accuracy", "pilot", "migration", "controls", "dashboard",
  // "visualisation", "reporting", "decision", "tooling", "automation")
  // could never register a hit in extraction.keywordHits no matter what a
  // real JD said, because js/assemble.js's overlapScore() only ever reads
  // that dict - so js/letterbuild.js's archetype-scoped evidence pick
  // (entriesForArchetype + bestByTags) was tying 0-0-0 against real JDs far
  // more often than the synthetic-keywordHits golden tests (which build
  // extraction.keywordHits directly from each variant's own tag list,
  // bypassing this function entirely) ever exercised. This is a plumbing
  // completeness fix, not a rule/threshold/weight/severity change: it
  // restores allKnownTags' own documented contract by adding the one
  // remaining tag source (letterBlocks) it was supposed to cover from the
  // start. Purely additive - verified (see tests/golden/run-golden-tests.mjs)
  // that no existing bulletVariants/profileVariants/skillLines tag
  // collides with a letterBlocks-only tag, so no other selection's scoring
  // changes; only evidence's own tags become matchable, which is what the
  // 19 Sept archetype-mapping design assumed was already true.
  function allKnownTags(data) {
    var seen = {};
    var list = [];
    function add(tag) {
      var key = tag.toLowerCase();
      if (!seen[key]) { seen[key] = true; list.push(tag); }
    }
    Object.keys(data.skillLines).forEach(function (catKey) {
      data.skillLines[catKey].terms.forEach(function (term) {
        (term.tags || []).forEach(add);
      });
    });
    Object.keys(data.bulletVariants).forEach(function (gid) {
      data.bulletVariants[gid].variants.forEach(function (v) {
        (v.tags || []).forEach(add);
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      (p.tags || []).forEach(add);
    });
    Object.keys(data.letterBlocks || {}).forEach(function (category) {
      var entries = data.letterBlocks[category];
      if (!Array.isArray(entries)) return; // e.g. letterBlocks._rules, a plain string
      entries.forEach(function (b) {
        (b.tags || []).forEach(add);
      });
    });
    return list;
  }

  function extractKeywordHits(data, matchableSentences) {
    var hits = {};
    allKnownTags(data).forEach(function (tag) {
      var n = countHits(matchableSentences, tag);
      if (n > 0) hits[tag.toLowerCase()] = n;
    });
    return hits;
  }
  // Note (27 Sept 2026, item 1e): countHits above now matches by stem-set,
  // not literal phrase - see its own updated comment. This function's
  // consumers (js/assemble.js's overlapScore, js/letterbuild.js's
  // bestByTags) only ever check a tag's presence in this dict, never the
  // count value, so the behaviour change is exactly "a tag can now register
  // a hit from an inflected/reordered real-ad sentence, not only an exact
  // phrase" - the same recall improvement item 1 asked for, applied to
  // variant/bullet/profile tag-overlap selection as well as archetype
  // scoring, since both read through this one function.

  // Delegates to js/segment.js's CVSegment.extractYearsInfo, which replaced
  // this function's original naive "(\d+)\s*\+?\s*years, take the max"
  // regex (18-19 Sept 2026, Derin's own fix - see segment.js's header for
  // the "100 years of company history" bug the naive version was exploited
  // by, live, on the real Davy Group ad). Kept here, under the same name,
  // purely for backward compatibility with any caller that just wants a
  // plain number|null. js/letterbuild.js no longer calls this per-sentence
  // the way it used to - see that file's own comment on why a lone
  // sentence string can't satisfy the new rule's condition 3 (needs to know
  // whether the sentence sits in a MATCHABLE section, which requires
  // whole-document heading context) - it now reads
  // CVSegment.extractYearsInfo's `candidates` list directly instead.
  function extractYearsRequired(rawJD) {
    return Segment.extractYearsInfo(rawJD).value;
  }

  // Spec 5.1's own list, verbatim. Matched via CVMatcher.test() (exact word/
  // phrase boundaries) instead of the old raw indexOf substring check - that
  // old check is exactly what let "aca" match inside "vacancy" and
  // "academic" (confirmed live, 13 Sept 2026 review). None of these terms
  // need stemming (they're either short acronyms, where stemming would
  // reintroduce the same bug, or already-plural-safe phrases), so all are
  // matched exact.
  var QUALIFICATION_TERMS = [
    "2:1", "2.1", "first class", "honours", "degree in", "bachelor",
    "master", "qualified accountant", "aca", "acca", "cima", "cfa"
  ];
  function extractQualificationDemands(normalizedJD) {
    // Terms normalized before matching, same reason as countHits() above -
    // "2:1"/"2.1" contain punctuation the JD side has already lost.
    return QUALIFICATION_TERMS.filter(function (q) {
      return Matcher.test(normalizedJD, normalize(q));
    });
  }

  // Tools mentioned in the JD that Derin either has (present in his own
  // skillLines tags) or is confirmed NOT to have (data.knownAbsentTools.tools
  // - its own key in the data file, not derived from data.neverClaim; see
  // that key's own _why for exactly why those are different concepts and
  // deriving one from the other was a false claim in a prior code comment
  // here). Anything the JD names that is neither is reported as neither -
  // "mentioned, not confirmed either way" - rather than guessed as a gap.
  function extractToolsMentioned(data, normalizedJD) {
    var have = [];
    var haveSeen = {};
    Object.keys(data.skillLines).forEach(function (catKey) {
      data.skillLines[catKey].terms.forEach(function (term) {
        (term.tags || []).forEach(function (tag) {
          var key = tag.toLowerCase();
          if (haveSeen[key]) return;
          if (Matcher.test(normalizedJD, normalize(tag))) { haveSeen[key] = true; have.push(tag); }
        });
      });
    });
    var absentTools = (data.knownAbsentTools && data.knownAbsentTools.tools) || [];
    var confirmedMissing = absentTools.filter(function (tool) {
      return Matcher.test(normalizedJD, normalize(tool));
    });
    return { have: have, confirmedMissing: confirmedMissing };
  }

  // Fix 1 (18-19 Sept 2026, Derin's own instruction, "segment the JD before
  // matching anything"): every keyword/qualification/tool match below runs
  // against the MATCHABLE-only text, not the raw ad - see js/segment.js's
  // header for why (boilerplate - values statements, EEO/diversity/privacy
  // notices, benefits copy - was scoring and matching as if it described
  // the job). When no heading in the document matched either of
  // segment.js's lists, CVSegment.classifySentences marks every sentence
  // matchable on its own (Derin's own explicit fallback: "no headings
  // detected at all: match the whole text... failing open is acceptable;
  // failing open without telling anyone is not"), so this function doesn't
  // need its own separate fallback branch - it just needs to surface
  // headingsFound/unclassifiedHeadings so the UI can show that notice
  // rather than silently absorb it.
  function extractFromJD(data, rawJD) {
    var raw = rawJD || "";
    var segmentation = Segment.classifySentences(raw);
    var matchableTexts = segmentation.sentences
      .filter(function (s) { return s.matchable; })
      .map(function (s) { return s.text; });
    var matchableSource = matchableTexts.join(" ");
    var normalized = normalize(matchableSource);
    var yearsInfo = Segment.extractYearsInfo(raw);
    return {
      raw: raw,
      normalized: normalized,
      // 27 Sept 2026 (item 1e/fix): the individual matchable sentence
      // texts, kept alongside the flattened `normalized` blob above -
      // `.normalized` is still used for the LITERAL exact-phrase checks
      // below (qualificationDemands/tools), which are safe against a
      // flattened blob (a literal phrase can't word-salad across a
      // sentence boundary the way stem-set word-set matching can - see
      // countHits' own comment for the real false-positive this fixes:
      // "finance administrator" hitting the real WTW ad from two
      // unrelated sentences). keywordHits below reads THIS field, not
      // `.normalized`, for exactly that reason.
      matchableSentences: matchableTexts,
      keywordHits: extractKeywordHits(data, matchableTexts),
      yearsRequired: yearsInfo.value,
      // True only when the extractor found at least one number-with-a-
      // years-token match and EVERY one was discarded by condition 3 or 4
      // (e.g. "100 years" of company history) - the specific "extraction
      // found something and threw it all out" case Derin asked to be
      // surfaced distinctly from yearsRequired simply being null (no years
      // language at all) or from js/fitcheck.js's pre-existing
      // yearsAmbiguous (vague language, no number at all).
      yearsRequiredAllDiscarded: yearsInfo.allDiscarded,
      qualificationDemands: extractQualificationDemands(normalized),
      tools: extractToolsMentioned(data, normalized),
      headingsFound: segmentation.headingsFound,
      unclassifiedHeadings: segmentation.unclassifiedHeadings
    };
  }

  // --- 5.2: archetype scoring -------------------------------------------
  // "Score = sum of weights for terms present. Highest score wins; ties
  // break by the priority field." Priority is ascending-preferred (1 is
  // most preferred).
  //
  // matchedTerms is sorted by weight descending using the same
  // index-tracked, strict-improvement-only technique js/assemble.js's
  // stableSortDesc uses - NOT a bare Array.sort, which the review flagged
  // as an inconsistency: assemble.js deliberately avoids relying on
  // Array.sort's stability elsewhere in this app specifically because a
  // non-deterministic tie-break here would mean the same JD could produce
  // two different top-3-terms readouts (and, worse, two different chosen
  // archetypes were this ever used for more than display) across runs or
  // JS engines. Matching that pattern here, not just for consistency's own
  // sake, but because archetype selection determines the entire CV and
  // must be reproducible.
  function scoreArchetype(archetype, extraction) {
    var candidates = [];
    var score = 0;
    var i = 0;
    Object.keys(archetype.keywords).forEach(function (term) {
      var weight = archetype.keywords[term];
      // Sentence-scoped, not the flattened blob - see countHits' and
      // extractFromJD's own comments (27 Sept 2026 fix): matching against
      // the whole document let two unrelated sentences' words combine into
      // one false multi-word hit ("finance administrator" from "Financial
      // Services" in one bullet and "administration" in an unrelated one),
      // which flipped a real archetype pick on the WTW fixture before this
      // was caught. A synthetic extraction built directly with only
      // `.normalized` and no `.matchableSentences` (none exist in this
      // codebase today, but just in case) falls back to treating the whole
      // blob as one sentence, rather than throwing.
      var hits = countHits(extraction.matchableSentences || (extraction.normalized ? [extraction.normalized] : []), term);
      if (hits > 0) {
        score += weight;
        candidates.push({ term: term, weight: weight, hits: hits, _i: i });
      }
      i++;
    });
    var matched = candidates
      .sort(function (a, b) { return b.weight !== a.weight ? b.weight - a.weight : a._i - b._i; })
      .map(function (c) { return { term: c.term, weight: c.weight, hits: c.hits }; });
    return { archetype: archetype, score: score, matchedTerms: matched };
  }

  // Returns { winner, ranked, topTerms, noMatch }. `ranked` is every
  // archetype's score, highest first (ties broken by priority) - the caller
  // (the UI) uses this to populate the override dropdown with every option.
  //
  // noMatch is true when the winner's score is 0 - i.e. the JD text didn't
  // hit a single keyword for any archetype. Before this flag existed,
  // highest-score-wins would silently return whichever archetype sits first
  // by priority (graduate-programme) even on a JD about something the data
  // file has no vocabulary for at all, producing a confidently wrong CV with
  // no visible sign anything was uncertain. The caller must not auto-build
  // from a noMatch pick; it should refuse and ask for a manual choice.
  function pickArchetype(data, extraction) {
    var ranked = data.archetypes
      .map(function (a) { return scoreArchetype(a, extraction); })
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.archetype.priority - b.archetype.priority;
      });
    return {
      winner: ranked[0],
      ranked: ranked,
      topTerms: ranked[0].matchedTerms.slice(0, 3),
      noMatch: ranked[0].score === 0
    };
  }

  global.CVScore = {
    normalize: normalize,
    countHits: countHits,
    extractFromJD: extractFromJD,
    scoreArchetype: scoreArchetype,
    pickArchetype: pickArchetype,
    // extractYearsRequired exported (Phase 7 addition, 18 Sept 2026):
    // js/letterbuild.js needs to run the exact same "(\d+)\s*\+?\s*years"
    // regex per-sentence, to exclude a job ad's own unmet-years sentence
    // from ECHO candidates (echoing back a gap is self-harm - Derin's own
    // framing). Reusing this rather than a second copy of the regex keeps
    // "what counts as a years requirement" defined in exactly one place.
    extractYearsRequired: extractYearsRequired,
    // allKnownTags exported 25 Sept 2026 (item 6, keyword baseline): the
    // keyword-precision harness (tests/golden/record-keyword-baseline.mjs
    // and run-golden-tests.mjs's baseline-delta section) needs the exact
    // same tag universe extractKeywordHits() scores against, not a second
    // hand-typed list that could drift from it - same "one way to do a
    // thing" reasoning as every other shared export in this app.
    allKnownTags: allKnownTags
  };
})(typeof window !== "undefined" ? window : globalThis);
