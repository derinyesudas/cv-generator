// ---------------------------------------------------------------------------
// Phase 7 hardening, 18-19 Sept 2026. Derin's own fix, in response to two
// real false hits found testing js/letterbuild.js against the real Davy
// Group ad: a company-values sentence ("...building a proud legacy") and a
// diversity-statement sentence ("...even if you don't meet all of the
// requirements...") both got ranked as strong ECHO candidates, and a
// years-required extractor pulled "100" out of "the foundations of our
// success for 100 years" - a company-history claim, not an experience ask.
//
// Derin's diagnosis, verbatim in spirit: both false hits came from the same
// place - the parts of a job ad that are identical on every ad that company
// posts (values statements, EEO/diversity/privacy/accessibility notices,
// benefits copy, "how to apply" boilerplate). None of it describes the job.
// Everything in this app that reads a JD was matching it anyway.
//
// This file is the fix: split a pasted JD into MATCHABLE and IGNORED text
// BEFORE any matching happens, by heading. Everything downstream that reads
// a JD - js/score.js's archetype scoring/qualification-demand/tools-mentioned
// extraction, js/fitcheck.js's warning findings, js/letterbuild.js's ECHO
// candidates - now goes through this module first. One segmentation, one
// place it can be wrong, not N separate places matching the raw ad text
// each in their own way (the exact "two copies of one truth" failure mode
// this project keeps finding and fixing in different clothes).
//
// sentenceSpans/quoteAt moved here from js/fitcheck.js (which now delegates
// to this file and re-exports them, so js/letterbuild.js's existing
// `FitCheck.sentenceSpans` call keeps working unchanged) - both the heading
// segmentation and the years-required extractor below need the same
// "split into quotable chunks" utility fitcheck.js already had, and a
// shared utility belongs below both of its consumers in the dependency
// graph, not duplicated or owned by only one of them.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // --- Sentence/line splitting --------------------------------------------
  // "Sentence" here means "the chunk of text between newlines or .?!
  // punctuation" - not grammatical sentence. Job ads are rarely clean prose
  // (bullet lines, no terminal punctuation), and a heading line ("Requirements")
  // has no punctuation either, so this also doubles as a line splitter for
  // the heading-detection pass below - a heading and an unpunctuated bullet
  // both come out as their own span, which is exactly what heading
  // detection needs (see classifyHeadingLine).
  function sentenceSpans(text) {
    var spans = [];
    var re = /[^.!?\n]+[.!?]?/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var trimmed = m[0].trim();
      if (trimmed) spans.push({ start: m.index, end: m.index + m[0].length, text: trimmed });
    }
    return spans;
  }
  function quoteAt(text, index, fallback) {
    var spans = sentenceSpans(text);
    for (var i = 0; i < spans.length; i++) {
      if (index >= spans[i].start && index < spans[i].end) return spans[i].text;
    }
    return fallback;
  }

  // --- Heading vocabulary (Derin's own lists, verbatim) --------------------
  // Split into RESPONSIBILITY / REQUIREMENT / OTHER on 27 Sept 2026 (item 5
  // of Derin's matcher/deploy work order), on top of the original flat
  // MATCHABLE_HEADING_TERMS list this file shipped with. Two reasons, not
  // one: (a) Derin named the split himself, giving two separate lists of
  // NEW headings to add ("Responsibilities headings" / "Requirements
  // headings") rather than one combined list; (b) item 1's close-match
  // trigger rewrite needs to isolate "the responsibilities section"
  // specifically (its new denominator is responsibility LINES, not every
  // matchable sentence in the ad) - a distinction the old flat list had no
  // way to express. Every consumer that only ever needed "is this
  // matchable at all" (js/score.js's extraction, js/letterbuild.js's ECHO
  // candidates, js/fitcheck.js's warning findings) is unaffected - the
  // union of all three lists below is exactly the old MATCHABLE_HEADING_TERMS
  // set (plus this pass's additions), still exported under that same name.
  var RESPONSIBILITY_HEADING_TERMS = [
    "responsibilit", "key responsibilities", "what you'll do", "the role",
    "about the role", "duties",
    // New this pass (27 Sept 2026, item 5, Derin's own list, verbatim) -
    // the SoftCo fixture's own heading, "Document Processing Administrator
    // - Your role:", is the real ad that exposed the gap: the old list only
    // had "the role"/"about the role", not "your role".
    "your role", "your new role", "your responsibilities",
    "what will you do in this role", "role responsibilities"
  ];
  var REQUIREMENT_HEADING_TERMS = [
    "requirement", "key requirement", "essential", "skills",
    "what skills you need", "who you are", "your profile", "qualification",
    "experience",
    // New this pass (27 Sept 2026, item 5, Derin's own list, verbatim).
    "about you", "what we're looking for", "what you need to have",
    "what we prefer you to have", "your skills and experience",
    "experience & knowledge"
  ];
  // Matchable, but not specifically a responsibility or requirement heading
  // (a role-overview/context heading) - carried over unchanged from the
  // original flat list; nothing added here this pass.
  var OTHER_MATCHABLE_HEADING_TERMS = [
    "position overview", "job description", "about your new job",
    "about the team", "the department"
  ];
  // Backward-compatible combined list - the union of the three above, same
  // set the original flat MATCHABLE_HEADING_TERMS export held (plus this
  // pass's additions). Kept under the same name/shape so anything that only
  // ever asked "is this term in the matchable vocabulary at all" keeps
  // working unchanged.
  var MATCHABLE_HEADING_TERMS = RESPONSIBILITY_HEADING_TERMS
    .concat(REQUIREMENT_HEADING_TERMS)
    .concat(OTHER_MATCHABLE_HEADING_TERMS);
  var IGNORED_HEADING_TERMS = [
    "equal opportunit", "eeo", "our commitment", "commitment to", "diversity",
    "inclusion", "privacy", "data protection", "recruiting scam", "fraud",
    "accessibility", "reasonable accommodation", "about the firm", "about us",
    "our culture", "our values", "why you'll thrive",
    "benefit", "what's on offer", "what we offer", "perks", "how to apply",
    "submitting an application", "what's next", "application process",
    "ai disclosure"
  ];
  // "about <company>" (spec's own wildcard entry - a heading using the
  // literal company name, e.g. "About Davy Group", instead of the fixed
  // phrase "About us") can't be matched against a fixed term list, so it
  // gets a narrow structural rule instead: a heading starting "About " is
  // treated as company self-description UNLESS it also names the
  // candidate/role/team as its subject. Narrow on purpose - tested live
  // against the real Davy ad, which has an "About you" heading opening its
  // requirements section. A blanket "About X -> ignored" rule (my first
  // draft) would have wrongly ignored that entire section; this list is
  // what "About you" needs to survive it. Flagged as a Claude refinement of
  // the spec, not a literal reading of it - "about <company>" as given
  // needs some company-name heuristic, and this is the narrowest one that
  // doesn't break a real, already-observed case.
  var ABOUT_SAFE_WORDS = ["you", "your", "role", "team", "position", "job", "department"];

  // Belt and braces (Derin's own list, verbatim): excluded at the SENTENCE
  // level regardless of which heading it falls under, because boilerplate
  // sometimes runs on without its own heading (the Davy ad's own
  // "Important Information" paragraph mixes an EEO sentence into running
  // prose under a heading that isn't itself in IGNORED_HEADING_TERMS).
  var ABSOLUTE_EXCLUDE_PATTERNS = [
    /equal opportunity/i, /regardless of race/i, /does not discriminate/i,
    /privacy notice/i, /recruitment scam/i, /reasonable accommodation/i,
    /protected veteran/i, /non-merit factor/i
  ];
  function sentenceIsAbsoluteExcluded(text) {
    return ABSOLUTE_EXCLUDE_PATTERNS.some(function (re) { return re.test(text); });
  }

  // Strips a trailing colon or question mark (any run of them, plus
  // trailing whitespace) before a line is judged heading-shaped or matched
  // against the term lists. New 27 Sept 2026 (item 5b): a heading phrased
  // as a question ("What will you do in this role?") or ending in a colon
  // (every heading in this app's own real fixtures already does) should be
  // read the same way regardless of that trailing mark - the mark is
  // punctuation around the heading, not part of judging whether the line
  // IS one. Only a trailing ':'/'?' is stripped, never a '.'/'!' - those
  // remain genuine "this is a sentence, not a heading" signals.
  function stripHeadingPunctuation(line) {
    return String(line || "").trim().replace(/[:?]+\s*$/, "").trim();
  }

  // A line "looks like a heading" if it's short and doesn't end the way a
  // sentence does. Same structural test js/letterbuild.js's
  // looksLikeHeadingFragment uses for the same reason (a heading is
  // structurally not a sentence, checkable by punctuation/word count alone,
  // no content judgement needed) - not shared code between the two files
  // because they serve different purposes (this decides section state;
  // that decides whether to offer something as an ECHO quote), but the same
  // underlying structural fact.
  //
  // Word limit widened 8 -> 10 on 27 Sept 2026 (item 5c, Derin's own
  // instruction: "accept a short line (10 words or fewer) that ends with a
  // known heading"). Takes the already-punctuation-stripped line (see
  // stripHeadingPunctuation above), not the raw one, so a trailing "?"/":"
  // no longer disqualifies an otherwise heading-shaped line, matching item
  // 5b in the same change.
  function isHeadingShaped(strippedLine) {
    var t = strippedLine;
    if (!t) return false;
    if (/[.!?]$/.test(t)) return false;
    var words = t.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 10;
  }

  // Classifies one heading-shaped line, returning { state, subType } or
  // null (not heading-shaped at all). state is "matchable"/"ignored"/
  // "unknown" (heading-shaped, names neither list - see segmentHeadings for
  // what happens to these). subType is "responsibility"/"requirement"/
  // "other"/null - only meaningful when state is "matchable"; item 1's
  // close-match trigger reads it to isolate the responsibilities section
  // specifically. Matching stays "term appears anywhere in the line"
  // (unchanged mechanism, case-insensitive since both sides are lowercased)
  // rather than a stricter "line ends with the term" rule - a substring-
  // anywhere check already accepts item 5c's own example ("Document
  // Processing Administrator - Your role:" contains "your role" as a
  // substring once that term is in the list) without needing a second,
  // narrower matching rule alongside it, so the simpler existing mechanism
  // was kept rather than special-cased.
  function headingInfo(line) {
    var stripped = stripHeadingPunctuation(line);
    if (!isHeadingShaped(stripped)) return null;
    var lower = stripped.toLowerCase();
    if (RESPONSIBILITY_HEADING_TERMS.some(function (term) { return lower.indexOf(term) !== -1; })) {
      return { state: "matchable", subType: "responsibility" };
    }
    if (REQUIREMENT_HEADING_TERMS.some(function (term) { return lower.indexOf(term) !== -1; })) {
      return { state: "matchable", subType: "requirement" };
    }
    if (OTHER_MATCHABLE_HEADING_TERMS.some(function (term) { return lower.indexOf(term) !== -1; })) {
      return { state: "matchable", subType: "other" };
    }
    var isIgnored = IGNORED_HEADING_TERMS.some(function (term) { return lower.indexOf(term) !== -1; });
    if (!isIgnored && /^about\b/.test(lower)) {
      isIgnored = !ABOUT_SAFE_WORDS.some(function (w) { return lower.indexOf(w) !== -1; });
    }
    if (isIgnored) return { state: "ignored", subType: null };
    return { state: "unknown", subType: null };
  }

  // Backward-compatible export: the plain state string only, same contract
  // as before this pass (exported for tests/debugging - see the bottom of
  // this file). Nothing in this app calls this for its subType, only
  // segmentHeadings below (which calls headingInfo directly).
  function classifyHeadingLine(line) {
    var info = headingInfo(line);
    return info ? info.state : null;
  }

  // Walks the JD line by line, tracking which section state (matchable/
  // ignored) is currently active. A recognized heading changes the state; an
  // "unknown" heading-shaped line does NOT - it's transparent, inheriting
  // whatever section it's nested under, rather than reset to a fixed
  // default. This matters for real documents: the Davy ad's Benefits block
  // has its own unrecognized sub-headings ("Health and Wellbeing", "Reward
  // and Recognition", "Growth and Development") that would otherwise flip
  // state back to matchable mid-boilerplate if "unknown" defaulted to
  // matchable outright - tested live, this is what actually happens without
  // the inherit rule. The section BEFORE the first recognized heading
  // defaults to matchable (least likely to silently drop real content when
  // there's nothing yet to classify it by).
  function segmentHeadings(rawJD) {
    var text = rawJD || "";
    var lines = text.split("\n");
    var offset = 0;
    var regions = [];
    var currentState = "matchable";
    var currentSubType = null;
    var anyHeadingMatched = false;
    var unclassifiedHeadings = [];
    var regionStart = 0;

    lines.forEach(function (line) {
      var lineStart = offset;
      var info = headingInfo(line);
      if (info) {
        if (lineStart > regionStart) {
          regions.push({ start: regionStart, end: lineStart, state: currentState, subType: currentSubType });
        }
        if (info.state === "matchable" || info.state === "ignored") {
          currentState = info.state;
          currentSubType = info.subType;
          anyHeadingMatched = true;
        } else {
          unclassifiedHeadings.push(line.trim());
          // currentState/currentSubType intentionally unchanged - see
          // function header ("unknown" headings are transparent).
        }
        regionStart = lineStart;
      }
      offset = lineStart + line.length + 1; // +1 for the '\n' split() removed
    });
    if (regionStart < text.length) {
      regions.push({ start: regionStart, end: text.length, state: currentState, subType: currentSubType });
    }

    return { regions: regions, headingsFound: anyHeadingMatched, unclassifiedHeadings: unclassifiedHeadings };
  }

  function stateAtOffset(regions, offset) {
    for (var i = 0; i < regions.length; i++) {
      if (offset >= regions[i].start && offset < regions[i].end) return regions[i].state;
    }
    return "matchable"; // shouldn't happen - regions cover [0, text.length)
  }

  // 27 Sept 2026 (item 1d): the region's subType, or null when no region
  // contains this offset (shouldn't happen - regions cover the whole text,
  // same as stateAtOffset above) or when the containing region's state
  // isn't "matchable" in the first place (an ignored region has no
  // meaningful subType).
  function subTypeAtOffset(regions, offset) {
    for (var i = 0; i < regions.length; i++) {
      if (offset >= regions[i].start && offset < regions[i].end) return regions[i].subType;
    }
    return null;
  }

  // Every sentence span, tagged matchable/not, plus (27 Sept 2026, item 1d)
  // which matchable sub-section it falls in - "responsibility" /
  // "requirement" / "other" / null. When NO heading in the whole document
  // matched either list, headingsFound is false and EVERY sentence is
  // matchable - Derin's own explicit fallback rule ("no headings detected
  // at all: match the whole text... failing open is acceptable; failing
  // open without telling anyone is not" - hence headingsFound is returned,
  // for the UI to show the fallback notice, not silently absorbed here).
  // This also keeps every existing single-paragraph test JD (the golden
  // suite's inline strings, none of which have headings) behaving exactly
  // as before this file existed. In that same fallback state, subType is
  // reported as "responsibility" for every sentence too (same failing-open
  // reasoning extended to item 1's new denominator - a JD with no headings
  // at all gets no narrower a matchable pool than it always has) - flagged
  // here as a direct extension of Derin's own stated fallback rule, not a
  // separately given instruction.
  function classifySentences(rawJD) {
    var text = rawJD || "";
    var seg = segmentHeadings(text);
    var spans = sentenceSpans(text);
    var sentences = spans.map(function (span) {
      var matchable = seg.headingsFound ? (stateAtOffset(seg.regions, span.start) === "matchable") : true;
      if (matchable && sentenceIsAbsoluteExcluded(span.text)) matchable = false;
      var subType = seg.headingsFound ? subTypeAtOffset(seg.regions, span.start) : "responsibility";
      return { start: span.start, end: span.end, text: span.text, matchable: matchable, subType: matchable ? subType : null };
    });
    return { headingsFound: seg.headingsFound, unclassifiedHeadings: seg.unclassifiedHeadings, sentences: sentences };
  }

  // Matchable sentences joined back into one blob, for js/score.js's
  // extraction to normalize/match against instead of the raw JD. Order
  // preserved (file order), space-joined - good enough for keyword/term
  // matching, which doesn't care about sentence boundaries.
  function matchableText(rawJD) {
    var result = classifySentences(rawJD);
    return result.sentences.filter(function (s) { return s.matchable; }).map(function (s) { return s.text; }).join(" ");
  }

  // --- Years-required extraction (Fix 3) ------------------------------------
  // Replaces the old spec-5.1 "(\d+)\s*\+?\s*years, take the max" regex,
  // which is exactly what pulled "100" out of "100 years" of company
  // history. Four conditions, ALL required, per Derin's own instruction:
  //
  //   1. A years token adjacent to the number (year/years/years'/yr/yrs).
  //   2. Dashes normalized first (en/em dash -> hyphen) so a real range
  //      like "1-2 years" (seen with an en dash in a live ad) parses.
  //   3. An experience word in the SAME SENTENCE, or the sentence sits in a
  //      MATCHABLE section (see classifySentences above).
  //   4. The parsed figure is <= 15 (a founding year, headcount or revenue
  //      figure is never an entry-to-mid experience ask).
  //
  // Plus a correctness fix unrelated to the four conditions: for a range
  // ("1-5 years", "up to 1-2 years"), the LOWER bound is the requirement,
  // not the upper - Derin's own worked example: "up to 1-2 years... requires
  // one, and is a MATCH for a candidate with one year," where taking the
  // upper bound would report a gap where there is a fit.
  var YEARS_TOKEN_RE = /(\d+)(?:\s*-\s*(\d+))?\s*\+?\s*(?:years?|yrs?)\b/gi;
  var EXPERIENCE_WORD_RE = /\b(experience|pqe|post-qualification|in a similar role|background in|working in)\b/i;
  var YEARS_UPPER_BOUND = 15;

  function normalizeDashes(text) {
    return String(text || "").replace(/[–—]/g, "-");
  }

  // candidates: every number+years-token match found, whether or not it
  // ultimately survives conditions 3/4 - `valid` says which. Exposed (not
  // just the final max) so js/letterbuild.js can check, per ECHO candidate
  // sentence, "does THIS sentence contain a years figure I don't meet" -
  // against the SAME parsed-and-filtered candidates the JD-level figure
  // came from, rather than re-running a second, isolated per-sentence
  // extraction that has no heading context to satisfy condition 3 with (a
  // lone sentence handed to a JD-level extractor can't know what section it
  // came from - this is why the old design, "call extractYearsRequired on
  // just the sentence text," could never have implemented condition 3, and
  // had to be restructured, not patched).
  //
  // Returns { value, candidates, hadCandidates, allDiscarded }. `value` is
  // the max of all `valid` candidates (spec 5.1's original aggregation rule,
  // unchanged - only what counts as a valid candidate changed). hadCandidates
  // is true if the regex found ANY number+years-token match at all, valid or
  // not. allDiscarded is true when candidates existed but none survived -
  // the specific "extraction found something and discarded all of it" case
  // Derin asked to be surfaced distinctly ("no experience requirement
  // detected in this ad"), separate from the pre-existing yearsAmbiguous
  // case (no number found at all, but vague language like "extensive
  // experience" was) which js/fitcheck.js already handles on its own.
  function extractYearsInfo(rawJD) {
    var text = normalizeDashes(rawJD || "");
    var seg = classifySentences(text);
    var candidates = [];

    seg.sentences.forEach(function (sentence) {
      var re = new RegExp(YEARS_TOKEN_RE.source, "gi");
      var m;
      while ((m = re.exec(sentence.text)) !== null) {
        var lower = parseInt(m[1], 10);
        var upper = m[2] != null ? parseInt(m[2], 10) : lower;
        var value = Math.min(lower, upper); // the lower bound is the requirement
        var hasExperienceWord = EXPERIENCE_WORD_RE.test(sentence.text);
        var conditionThree = hasExperienceWord || sentence.matchable;
        var conditionFour = value <= YEARS_UPPER_BOUND;
        candidates.push({
          start: sentence.start + m.index,
          // The sentence's own span (9 Oct 2026), so js/fitcheck.js can ask
          // whether a years warning hit sits in a sentence whose figure
          // this extractor accepted. Dash normalization swaps one character
          // for one, so these offsets hold in the raw ad too.
          sentenceStart: sentence.start,
          sentenceEnd: sentence.end,
          value: value,
          sentence: sentence.text,
          matchable: sentence.matchable,
          hasExperienceWord: hasExperienceWord,
          valid: conditionThree && conditionFour
        });
      }
    });

    var validValues = candidates.filter(function (c) { return c.valid; }).map(function (c) { return c.value; });
    var value = validValues.length ? Math.max.apply(null, validValues) : null;
    return {
      value: value,
      candidates: candidates,
      hadCandidates: candidates.length > 0,
      allDiscarded: candidates.length > 0 && validValues.length === 0
    };
  }

  global.CVSegment = {
    sentenceSpans: sentenceSpans,
    quoteAt: quoteAt,
    classifySentences: classifySentences,
    matchableText: matchableText,
    extractYearsInfo: extractYearsInfo,
    // exposed for tests/debugging, not part of the "public API" other
    // modules are expected to call directly:
    MATCHABLE_HEADING_TERMS: MATCHABLE_HEADING_TERMS,
    RESPONSIBILITY_HEADING_TERMS: RESPONSIBILITY_HEADING_TERMS,
    REQUIREMENT_HEADING_TERMS: REQUIREMENT_HEADING_TERMS,
    OTHER_MATCHABLE_HEADING_TERMS: OTHER_MATCHABLE_HEADING_TERMS,
    IGNORED_HEADING_TERMS: IGNORED_HEADING_TERMS,
    classifyHeadingLine: classifyHeadingLine
  };
})(typeof window !== "undefined" ? window : globalThis);
