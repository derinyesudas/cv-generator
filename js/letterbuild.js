// ---------------------------------------------------------------------------
// Phase 7: cover-letter assembly. Turns a chosen archetype + a pasted JD +
// a handful of manual inputs (company, role, team, and Derin's own ECHO
// pick) into a filled data.letterBlocks model, the same way js/assemble.js
// turns an archetype + JD into a filled CV model. Never touches the DOM;
// js/app.js owns the form fields and the preview.
//
// This file exists because of one design decision Derin gave directly
// (18 Sept 2026), and everything below implements it verbatim rather than
// approximating it:
//
//   ECHO is SELECTION, never composition. The matcher already knows which
//   JD sentence contains which approved term. buildEchoCandidates() below
//   turns that into a ranked pick-list of VERBATIM JD sentences - never a
//   typed field - because a typed ECHO is the one input path in this whole
//   app where a FALSE CLAIM ABOUT THE EMPLOYER could get in (every other
//   gate in this project protects against a false claim about Derin). A
//   verbatim string lifted from text Derin pasted himself cannot be wrong,
//   because the text is the source.
//
//   Ranking is by the STRENGTH of what matched (core > support > filler -
//   mapped straight onto the existing bulletVariants[...].priority field,
//   1-2/3-4/5; no new "strength" field was added to the schema, because
//   priority already carries this meaning - see build-status-and-decision-
//   log.md, role-dmart resolution, for the same reasoning applied there).
//   NOT by term frequency - frequency rewards boilerplate (Derin's own
//   words).
//
//   Two hard exclusions, checked per-sentence before a sentence is ever
//   offered as a candidate: (1) a knownAbsentTools term or a years-of-
//   experience figure Derin does not meet - echoing back a gap is self-
//   harm; (2) a neverClaim term - quoting the ad saying "SQL" still puts
//   "SQL" in the letter, whoever said it first. A third exclusion not in
//   Derin's spec but a direct consequence of it: a letterBlocks._rules
//   banned phrase (e.g. "passionate") - the ad itself can use a banned
//   word about ITSELF, and if that sentence got echoed the banned word
//   would land in the letter regardless of who wrote it originally. Same
//   logic as the neverClaim exclusion, one level up. Flagged here because
//   it is a Claude-made addition, not something Derin asked for by name.
//
//   When every candidate is excluded, buildSelectedWhy() below omits the
//   ECHO paragraph entirely and falls back to letterBlocks.why's no-echo
//   sibling - never a placeholder, never an empty quote.
//
//   A fourth exclusion added 18-19 Sept 2026, Derin's own fix, after live
//   testing against the real Davy Group ad found two false candidates: a
//   sentence under an IGNORED heading (company values/benefits/EEO copy -
//   see js/segment.js) can never be offered either, even when it happens to
//   contain an approved term. Boilerplate describing the COMPANY isn't a
//   claim Derin is making about himself, but it isn't a real match to his
//   experience either - it's noise that was outranking genuine matches.
//
// TEAM is the opposite shape: manual entry (there is no reliable JD signal
// to extract it from), but constrained - validateTeam() below blocks the
// download unless whatever was typed is a verbatim substring of the pasted
// JD, and an empty TEAM auto-collapses the opening block to company-only.
// No invention either way.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  var Score = global.CVScore;
  var Assemble = global.CVAssemble;
  var FitCheck = global.CVFitCheck;
  var Segment = global.CVSegment;
  if (!Matcher || !Score || !Assemble || !FitCheck || !Segment) {
    throw new Error("letterbuild.js loaded before js/matcher.js, js/score.js, js/assemble.js, js/fitcheck.js, or js/segment.js. Check <script> order.");
  }

  // --- Hard-requirement gap paragraph (30 Sept 2026, additive) -------------
  // js/app.js's hard-requirement ineligibility alert (js/hardreq.js) names,
  // for a RED verdict, which not-held items the ad requires. When the
  // person building the letter chooses to build anyway, up to the first TWO
  // of those RED items that carry a gapBlockId are named ONCE, in ONE
  // paragraph, using ONLY the pre-approved, verbatim gap sentences stored in
  // data.hardRequirements.gapBlocks - never composed here. A RED item with
  // no gapBlockId is never written into the letter (js/app.js's banner is
  // the only place it appears) - opts.hardReqGapIds below is already
  // filtered to gapBlockId-bearing ids by the caller, but this function
  // re-checks against the real gapBlocks list itself rather than trusting
  // the caller blindly, same "never invent, always verify against the data
  // file" discipline as everything else in this file.
  //
  // category: "gap" (same as every other gap paragraph) so js/verify.js's
  // never-claim gate exemption for gap content (a gap block, by definition,
  // names something Derin does NOT have) applies here too, unchanged - see
  // that file's own comment on the "gap" category exemption.
  function buildHardReqGapBlock(data, hardReqGapIds) {
    var ids = (hardReqGapIds || []).slice(0, 2);
    if (!ids.length) return null;
    var gapBlocks = (data.hardRequirements && data.hardRequirements.gapBlocks) || [];
    var entries = ids.map(function (id) { return Assemble.findById(gapBlocks, id); }).filter(Boolean);
    if (!entries.length) return null;
    var text = entries.map(function (e) { return e.text; }).join(" ");
    var atoms = entries.map(function (e) { return { ref: e, field: "text" }; });
    return {
      id: "hardreq-gap-" + entries.map(function (e) { return e.id; }).join("-"),
      category: "gap",
      text: text,
      ref: entries[0],
      _prov: { text: Assemble.textProv(atoms, entries.length > 1 ? " " : null) }
    };
  }

  // --- Strength vocabulary -------------------------------------------------
  // 19 Sept 2026 (Derin's "A-E" spec, part A/B): bulletVariants[...].priority
  // no longer exists - every group now carries `basis: {strength, why}`
  // directly, using the app's own core/support/filler/required vocabulary
  // (see data.trimPolicy and js/trim.js). strengthLabel() used to translate
  // a raw 1-5 integer into that same vocabulary; now the data file already
  // speaks it, so this is a pass-through (kept, not removed, since it's
  // still exported below and something else may call it) plus a defensive
  // check against a value validate.js should already have refused to let
  // through.
  var STRENGTH_RANK = { required: 0, core: 1, support: 2, filler: 3 };
  function strengthLabel(strength) {
    if (STRENGTH_RANK[strength] == null) {
      throw new Error("letterbuild.js: unknown basis.strength '" + strength + "' - js/validate.js should already have refused to load a data file with this.");
    }
    return strength;
  }

  // tag (lowercased) -> {rank, strength, tag} for the STRONGEST group that
  // uses it, scanning bulletVariants only (Phase 7 scoping decision -
  // flagged to Derin, not silently assumed: skillLines and profileVariants
  // tags don't carry a basis/strength concept the way bulletVariants groups
  // do, and "core/support/filler block" is bulletVariants' own vocabulary
  // elsewhere in this app, so that's the one source this reads from).
  // `rank` (lower = stronger) replaces the old raw priority integer for the
  // one thing this file used it for: comparing two candidate tags' strength
  // to keep the stronger one - see buildEchoCandidates() below.
  function tagStrengthMap(data) {
    var map = {};
    var groups = data.bulletVariants || {};
    Object.keys(groups).forEach(function (gid) {
      var group = groups[gid];
      var strength = group.basis && group.basis.strength;
      if (!strength) return; // js/validate.js already refuses to load a data file missing this
      var rank = STRENGTH_RANK[strength];
      (group.variants || []).forEach(function (v) {
        (v.tags || []).forEach(function (tag) {
          var t = String(tag).toLowerCase();
          if (!(t in map) || rank < map[t].rank) {
            map[t] = { rank: rank, strength: strength, tag: t };
          }
        });
      });
    });
    return map;
  }

  // --- Rules-derived banned phrases -----------------------------------
  // See file header's third exclusion. data.letterBlocks._rules is prose,
  // not a structured list - this pulls out every single-quoted substring
  // ('passionate', 'grateful for the opportunity', ...) and treats each as
  // a literal banned phrase. Reads the rule rather than re-typing it, so
  // if Derin edits _rules this exclusion updates itself - and this file
  // never writes to _rules, only reads it (the "app may never modify its
  // own rules" constraint in data._README).
  function bannedPhrases(data) {
    var rules = data.letterBlocks && data.letterBlocks._rules;
    if (!rules) return [];
    var out = [];
    var re = /'([^']+)'/g;
    var m;
    while ((m = re.exec(rules)) !== null) {
      var phrase = m[1].trim();
      if (phrase) out.push(phrase.toLowerCase());
    }
    return out;
  }

  // --- ECHO ------------------------------------------------------------
  // Does THIS sentence carry a years-of-experience figure Derin does not
  // meet. Checked per-sentence (not against the whole JD) so a met
  // requirement elsewhere in the ad can't be excluded by an unrelated unmet
  // one, and vice versa - same "checked against the quote, not the whole
  // ad" discipline js/fitcheck.js already uses for hedge-word severity.
  //
  // Rewritten 18-19 Sept 2026 (Fix 3, Derin's own instruction) to read
  // js/segment.js's CVSegment.extractYearsInfo `candidates` list - computed
  // ONCE per buildEchoCandidates call against the whole JD - rather than
  // calling Score.extractYearsRequired(sentenceText) on an isolated
  // sentence string the way this used to. That old approach is exactly
  // what let "100 years" of company history through in the first place
  // (no way to know, from a bare sentence, whether it sits in a MATCHABLE
  // section - condition 3 of the new rule needs whole-document heading
  // context a lone string can't supply), so this needed restructuring, not
  // a patch. `candidates` already carries each match's parsed value, its
  // sentence-level matchable flag, and whether it survived all four
  // conditions (`valid`) - this just asks "is there a valid candidate
  // whose value exceeds yearsRelevant, inside this span."
  function sentenceHasUnmetYears(yearsCandidates, span, yearsRelevant) {
    if (yearsRelevant == null) return false;
    return yearsCandidates.some(function (c) {
      return c.valid && c.value > yearsRelevant && c.start >= span.start && c.start < span.end;
    });
  }

  // Section headings and label fragments ("Requirements", "Stakeholder
  // Engagement", "Reporting & Performance Analysis") pass sentenceSpans
  // too - a heading is just a line with no terminal punctuation, which the
  // splitter's own [.!?]? is deliberately optional about (fitcheck.js
  // needs that, for ads with unpunctuated bullet lines). They are not
  // requirement sentences and should never be offered as an ECHO quote -
  // caught live, 18 Sept 2026, testing against the real Davy Group ad:
  // "Requirements" and "Stakeholder Engagement" both got ranked "core"
  // purely because the tag word happened to appear in a one/two-word
  // heading. Mechanical filter, not a content judgement: require real
  // terminal punctuation and a handful of words, which a heading by
  // definition doesn't have and an ordinary requirement sentence always
  // does ("Advanced Microsoft Excel skills." passes at 4 words + period).
  function looksLikeHeadingFragment(text) {
    if (!/[.!?]$/.test(text)) return true;
    return text.split(/\s+/).filter(Boolean).length < 4;
  }

  // Ranked, de-duplicated, exclusion-filtered list of {text, matchedTag,
  // priority, strength} candidates - text is VERBATIM from rawJD, never
  // rewritten. yearsRelevant is js/experience.js's CVExperience.
  // computeExperience(data).yearsRelevant (caller's job to compute, same
  // layering as js/fitcheck.js's runFitCheck taking modelText/extraction
  // as arguments rather than recomputing them itself).
  // The quoted form of a candidate sentence (2 Oct 2026): the ad's own words
  // with a leading list marker ("- ", "* ", "• ", "1. ") and the closing
  // full stop taken off, so it sits inside a frame's quotation marks
  // without colliding with the frame's own punctuation - frame a used to
  // print 'mentoring.", and', frame c '"...skills.." That'. Only the two
  // ends are trimmed, so the quote is still an exact substring of the ad
  // and js/verify.js's verbatim-quote gate checks it unchanged.
  //
  // 3 Oct 2026 (Derin: "yes"): a leading label is trimmed too. Ads often
  // write a duty as "Reporting: Produces regular administration reports
  // for clients, trustees, and senior management", and the auto-picked
  // quote then read 'Your description asks for "Reporting: Produces...'.
  // A label is 1-5 words starting with a capital letter, then a colon and
  // a space; it is only dropped when at least four words follow, so a
  // short "Label: value" line is left alone. Still the start of the
  // sentence trimmed, nothing reworded.
  var QUOTE_LABEL_RE = /^[A-Z][A-Za-z]*(?:(?:[ \t]+|[ \t]*[&\/,'’-][ \t]*)[A-Za-z]+){0,4}[ \t]*:[ \t]+(?=\S)/;
  function stripQuoteLabel(text) {
    var m = QUOTE_LABEL_RE.exec(text);
    if (!m) return text;
    var rest = text.slice(m[0].length);
    return rest.split(/\s+/).filter(Boolean).length >= 4 ? rest : text;
  }
  function quoteForm(sentence) {
    var s = String(sentence || "")
      .replace(/^[\s\-–—*•·▪◦]+/, "")
      .replace(/^\d{1,2}[.)]\s+/, "");
    return stripQuoteLabel(s)
      .replace(/[\s.!?;:,]+$/, "")
      .trim();
  }

  // Which candidate a letter quotes when Derin hasn't picked one (2 Oct
  // 2026 - his answer: "auto-pick the top line"). Strength still comes
  // first (core over support over filler); within a strength, a line that
  // reads well inside "Your description asks for "...", and..." wins:
  // 5-22 words, and not addressed to the reader ("you will"), which quoted
  // back reads oddly. Ties keep the ad's own order. The list itself stays
  // strongest-first.
  //
  // A line where the employer talks about itself ("we", "our", "us") is
  // never picked automatically (Derin, 8 Oct 2026): it describes the
  // company, not the job, and the frame would claim he has done it - the
  // Intact ad's only candidate was "With offices in Belfast, Galway, and
  // Dublin, we've embraced hybrid work...". With nothing else to quote, the
  // letter uses its no-quote paragraph. Every line can still be picked by
  // hand in the dropdown.
  function quotePenalty(text) {
    var words = String(text).split(/\s+/).filter(Boolean).length;
    var p = 0;
    if (words > 30) p += 3;
    else if (words > 22) p += 2;
    else if (words < 5) p += 2;
    if (/\b(?:you|your|you'll|you’ll|you're|you’re|we|we're|we’re|our|us)\b/i.test(text)) p += 2;
    if (/[<>]/.test(text)) p += 5;
    return p;
  }
  // "us" only in lower case, so "US and UK clients" is not caught.
  function employerTalksAboutItself(text) {
    return /\b(?:we|we're|we’re|we've|we’ve|our|ours)\b/i.test(text) || /\bus\b/.test(text);
  }
  function pickEchoAuto(candidates) {
    var best = null;
    var bestScore = Infinity;
    (candidates || []).forEach(function (c) {
      if (employerTalksAboutItself(c.text)) return;
      var score = c.rank * 10 + quotePenalty(c.text);
      if (score < bestScore) { best = c; bestScore = score; }
    });
    return best;
  }

  function buildEchoCandidates(data, rawJD, yearsRelevant) {
    if (!rawJD) return [];
    // Fix 1 (18-19 Sept 2026, Derin's own instruction): classifySentences
    // tags every sentence matchable/not against the ad's own headings (plus
    // the belt-and-braces absolute exclusion) - see js/segment.js's header.
    // extractYearsInfo is computed once here too, not per-sentence - see
    // sentenceHasUnmetYears's own comment on why.
    var spans = Segment.classifySentences(rawJD).sentences;
    var yearsInfo = Segment.extractYearsInfo(rawJD);
    var strengths = tagStrengthMap(data);
    var neverClaim = data.neverClaim || [];
    var absentTools = (data.knownAbsentTools && data.knownAbsentTools.tools) || [];
    var banned = bannedPhrases(data);
    var tags = Object.keys(strengths);
    var seen = {};
    var candidates = [];

    spans.forEach(function (span) {
      var text = span.text;
      if (looksLikeHeadingFragment(text)) return;
      // A sentence under an IGNORED heading (company values, benefits copy,
      // EEO/diversity/privacy boilerplate) or caught by the absolute
      // exclusion can never be offered as an ECHO quote - this is the fix
      // for the two real false hits found live against the Davy Group ad
      // (see this file's header and js/segment.js's for the detail).
      if (!span.matchable) return;
      // Markup is never a sentence (2 Oct 2026): an ad pasted as raw HTML
      // must not get a tag quoted into a letter.
      if (/[<>]/.test(text)) return;
      if (Matcher.scanList(text, neverClaim).length) return;
      if (Matcher.scanList(text, absentTools).length) return;
      if (sentenceHasUnmetYears(yearsInfo.candidates, span, yearsRelevant)) return;
      var lower = text.toLowerCase();
      if (banned.some(function (p) { return lower.indexOf(p) !== -1; })) return;

      // RESOLVED, 18-19 Sept 2026, by Derin's own two-part fix, not by
      // anything guessed here. This loop's original problem: a handful of
      // bulletVariants tags were ordinary English words on their own -
      // "legacy", "requirements", "review" - matched wherever they
      // appeared in the ad, whatever the ad actually meant by them.
      // Against the real Davy Group posting this had ranked a company-
      // values sentence ("...building a proud legacy") and a diversity-
      // statement sentence ("...even if you don't meet all of the
      // requirements...") both as "core" candidates. Fix 1 (the `!span.
      // matchable` check above) already removes both of those specific
      // sentences - they live under Davy's "About us" and "Important
      // Information" headings, both IGNORED. Fix 2 (js/validate.js's tag-
      // length rule, data-file-wide) closes the underlying cause: a tag
      // must now be at least two words (or a short all-caps acronym), so
      // "legacy"/"requirements"/"review" alone can no longer exist as a
      // matchable tag at all, even inside genuinely matchable text a
      // future ad might put them in.
      var bestRank = null;
      var bestStrength = null;
      var bestTag = null;
      tags.forEach(function (tag) {
        // Stem-set tag matching (27 Sept 2026, item 1) - was a literal
        // Matcher.test(text, tag) phrase match; see js/matcher.js's own
        // header on tagMatchesText for why phrase matching was too brittle
        // against real ad prose, and stays exact for anything digit-
        // bearing (falls back to the old phrase check by construction).
        if (Matcher.tagMatchesText(tag, text)) {
          if (bestRank === null || strengths[tag].rank < bestRank) {
            bestRank = strengths[tag].rank;
            bestStrength = strengths[tag].strength;
            bestTag = tag;
          }
        }
      });
      if (bestRank === null) return; // matched nothing from approved content

      var quote = quoteForm(text);
      if (!quote) return;
      var key = quote.toLowerCase();
      if (seen[key]) return; // same sentence repeated in the ad
      seen[key] = true;

      candidates.push({ text: quote, sentence: text, matchedTag: bestTag, rank: bestRank, strength: strengthLabel(bestStrength) });
    });

    // Rank by strength (lower rank number = stronger, first); stable,
    // first-listed wins on a tie - the same tie-break discipline as
    // everywhere else.
    return Assemble.stableSortDesc(candidates, function (c) { return -c.rank; });
  }

  // --- TEAM --------------------------------------------------------------
  // Manual entry, constrained (see file header). Empty TEAM is always
  // valid (it means "collapse to company-only", not an error). A
  // non-empty TEAM must appear verbatim (case-insensitive) in the pasted
  // JD - this turns Derin's rule 1 ("paste it verbatim") from advice into
  // an enforced check, and makes his rules 2/3 (programme name, named
  // recruiter) free, since both are quotes from the ad too - nothing here
  // needs to know WHICH of his three rules justified the text, only that
  // it really is in the ad.
  function validateTeam(teamText, rawJD) {
    var t = (teamText || "").trim();
    if (!t) return { valid: true, team: "" };
    var jd = rawJD || "";
    if (jd.toLowerCase().indexOf(t.toLowerCase()) === -1) {
      return { valid: false, team: t, reason: "\"" + t + "\" does not appear in the pasted job description. Paste it verbatim from the ad, or leave this blank." };
    }
    return { valid: true, team: t };
  }

  // --- START DATE (right-to-work auth line) -------------------------------
  // 26 Sept 2026, item 2b, Derin's own instruction, verbatim: "Take the
  // date from the ad and validate it verbatim, the same way as TEAM."
  // Identical shape to validateTeam above - manual entry, empty-is-valid
  // (no ad start date typed means "use the plain rightToWork line", not an
  // error), non-empty must be a verbatim (case-insensitive) substring of
  // the pasted JD. Lives here rather than in js/assemble.js because
  // js/assemble.js loads BEFORE this file (<script> order in index.html) -
  // js/app.js calls this (and startDateTriggersExtendedAuth below) BEFORE
  // calling CVAssemble.buildModel, and passes only the trusted result in,
  // the same division of labour buildModel() already uses for JD scoring
  // (js/score.js decides, js/assemble.js only ever consumes the decision).
  function validateStartDate(dateText, rawJD) {
    var t = (dateText || "").trim();
    if (!t) return { valid: true, date: "" };
    var jd = rawJD || "";
    if (jd.toLowerCase().indexOf(t.toLowerCase()) === -1) {
      return { valid: false, date: t, reason: "\"" + t + "\" does not appear in the pasted job description. Paste the start date verbatim from the ad, or leave this blank." };
    }
    return { valid: true, date: t };
  }

  // Deliberately narrow, mechanical parse: "Month YYYY" only (full month
  // name, case-insensitive), matching the one shape Derin's own example
  // uses ("September 2027"). A date text that doesn't match this shape
  // (a bare year, a DD/MM/YYYY figure, "Q3 2027") returns null rather than
  // guessing - the extended auth line then simply does not fire, same
  // "no invention" discipline as everything else in this file. If a real
  // ad ever needs a different shape recognised, that is a deliberate,
  // named addition to this parser, not something to guess past silently.
  var MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  function parseMonthYear(text) {
    var m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i.exec(String(text || ""));
    if (!m) return null;
    return { month: MONTH_NAMES.indexOf(m[1].toLowerCase()), year: parseInt(m[2], 10) };
  }

  // "Later than 1 November 2026" (Derin's own threshold, verbatim). Month-
  // granularity input means November 2026 itself is treated as NOT later
  // (it could be the 1st) - only December 2026 or any month in 2027+
  // trips it. Returns false (never fires the extended line) for anything
  // that doesn't parse as Month+YYYY, per parseMonthYear's own comment.
  function startDateTriggersExtendedAuth(dateText) {
    var my = parseMonthYear(dateText);
    if (!my) return false;
    if (my.year > 2026) return true;
    if (my.year === 2026 && my.month === 11 /* December, 0-indexed */) return true;
    return false;
  }

  // --- Close-match letter mode (26 Sept 2026, item 4, Derin's own
  // instruction, verbatim: "Derin rejected a letter today as generic, for
  // an ad... whose responsibilities were almost exactly his TCS job.
  // Trigger: 50% or more of the responsibility lines in the MATCHABLE
  // section hit approved evidence tags."). "Approved evidence tags" is read
  // as the tag union across letterBlocks.closeMatch's own five entries
  // specifically (the five clusters Derin named), not the whole app's tag
  // universe, since a ratio against every tag this app knows (skills,
  // every bullet, every other evidence variant) would trigger on a much
  // weaker match than the one Derin actually rejected a letter over. A
  // judgement call on ambiguous wording, not given verbatim - flagged here
  // and in the pass report rather than silently assumed.
  //
  // "Responsibility lines in the MATCHABLE section" (27 Sept 2026, item 1d
  // rewrite): originally read as every js/segment.js matchable sentence,
  // full stop - which is what the 26 Sept run against the real SoftCo
  // fixture found wrong on its own numbers (1 hit out of 27, a denominator
  // that silently included "Your profile" bullets too, nothing to do with
  // "responsibility lines"). js/segment.js's heading classification now
  // tags each matchable region with a subType ("responsibility" /
  // "requirement" / "other" - see that file's header) - this reads the
  // denominator literally against that, filtering to subType ===
  // "responsibility" specifically, rather than every matchable sentence.
  //
  // Tag matching itself (27 Sept 2026, item 1a-c): was a literal phrase
  // match (Matcher.test after js/score.js's normalize() on both sides) -
  // replaced with js/matcher.js's stem-set Matcher.tagMatchesText, which
  // tolerates the real ad's own inflection/word-order ("liaise with
  // clients" vs. the tag "client liaison") the way a literal phrase never
  // could. No longer needs to pre-normalize through Score.normalize() -
  // tagMatchesText does its own tokenizing - so that dependency on Score
  // is gone from this function entirely.
  function computeCloseMatchTrigger(data, rawJD) {
    var entries = (data.letterBlocks && data.letterBlocks.closeMatch) || [];
    var tagSeen = {};
    var tags = [];
    entries.forEach(function (e) {
      (e.tags || []).forEach(function (t) {
        // Matcher.tagLabel(), not a bare String(t) - a tag entry may be an
        // object ({term, alsoMatch}, see js/matcher.js's own comment on
        // tagMatchesText) going forward, and String() on an object would
        // silently dedupe every one of them under the single literal key
        // "[object object]".
        var k = Matcher.tagLabel(t).toLowerCase();
        if (!tagSeen[k]) { tagSeen[k] = true; tags.push(t); }
      });
    });
    // Also excludes heading-shaped fragments (the SAME looksLikeHeadingFragment
    // check buildEchoCandidates already applies above, for the same reason:
    // a heading line - "Document Processing Administrator - Your role:",
    // "Your responsibilities:" - is not itself a responsibility LINE, it's
    // the label over a group of them, and would otherwise inflate both the
    // denominator and (when a heading happens to contain an approved word,
    // as "Processing" does here) the numerator. Caught empirically this
    // pass: the real SoftCo fixture's own "Your role:" heading line
    // registered as a false hit against the "process documentation" tag
    // before this filter was added.
    var sentences = Segment.classifySentences(rawJD || "").sentences.filter(function (s) {
      return s.matchable && s.subType === "responsibility" && !looksLikeHeadingFragment(s.text);
    });
    var total = sentences.length;
    if (!total || !tags.length) return { fired: false, hitCount: 0, totalCount: total, ratio: 0 };
    var hitCount = 0;
    sentences.forEach(function (s) {
      var hit = tags.some(function (t) { return Matcher.tagMatchesText(t, s.text); });
      if (hit) hitCount++;
    });
    var ratio = hitCount / total;
    return { fired: ratio >= 0.5, hitCount: hitCount, totalCount: total, ratio: ratio };
  }

  // --- RECIPIENT NAME ----------------------------------------------------
  // 21 Sept 2026, Derin's own instruction (house style: "use a named
  // recruiter where one is known"). Identical shape to validateTeam above -
  // same verbatim-JD-substring constraint, same empty-is-valid collapse
  // (empty means "use the standard salutation", not an error) - reused
  // rather than duplicated with a different message, except the message
  // itself, which talks about the salutation rather than the recipient
  // block. No title (Mr/Ms) logic anywhere in this file or in
  // js/letter.js's salutation building: Derin's own words, "it would mean
  // guessing gender" - the name is used exactly as typed, nothing prepended.
  function validateRecipientName(nameText, rawJD) {
    var n = (nameText || "").trim();
    if (!n) return { valid: true, name: "" };
    var jd = rawJD || "";
    if (jd.toLowerCase().indexOf(n.toLowerCase()) === -1) {
      return { valid: false, name: n, reason: "\"" + n + "\" does not appear in the pasted job description. Paste the recruiter's name verbatim from the ad, or leave this blank to use \"Dear Hiring Team,\"." };
    }
    return { valid: true, name: n };
  }

  // --- Generic letterBlocks category selectors ----------------------------
  // Mechanical selection against the data shape itself (archetypes/tags/
  // trigger fields already present on every letterBlocks entry) - not a
  // content judgement call, so safe to implement straight from the shape.

  function entriesForArchetype(list, archetypeId) {
    return (list || []).filter(function (e) {
      var a = e.archetypes || [];
      return a.indexOf("*") !== -1 || a.indexOf(archetypeId) !== -1;
    });
  }

  function entryForTrigger(list, trigger) {
    var found = (list || []).filter(function (e) { return e.trigger === trigger; });
    return found.length ? found[0] : null;
  }

  // Single highest tag-overlap entry, tie -> first-listed (same helper CV
  // profile/bullet selection uses). Evidence and the non-echo "why" entry
  // are both single paragraphs, not a list, so this is a pick-one, not a
  // pick-all - flagged as a Phase 7 scoping decision, not a rediscovered
  // spec: if Derin wants more than one evidence paragraph in some cases,
  // this needs to change. (4 Oct 2026: he did - buildLetterModel now
  // calls this a second time for a second evidence paragraph.)
  function bestByTags(list, extraction) {
    if (!list || !list.length) return null;
    return Assemble.pickBestVariant(list, function (e) { return e.tags || []; }, extraction);
  }

  // An entry's requiresTags (4 Oct 2026): at least one of them must be
  // among the ad's own keyword hits for the entry to be picked
  // automatically. Entries without the field are always eligible.
  function requiredTagsMatched(entry, extraction) {
    var req = entry && entry.requiresTags;
    if (!req || !req.length) return true;
    var hits = (extraction && extraction.keywordHits) || {};
    return req.some(function (t) { return !!hits[String(t).toLowerCase()]; });
  }

  function isTcsEvidence(entry) {
    return !!entry && /^let-ev-tcs-/.test(entry.id);
  }

  // --- Template substitution -----------------------------------------
  // slots: {ROLE, COMPANY, TEAM, YEARS, ECHO} - only the ones a given
  // block's text actually references get substituted; anything left over
  // after substitution is a bug (a slot this function doesn't know about,
  // or a caller that forgot to supply one it should have) and throws
  // rather than shipping a literal "{{ECHO}}" into a letter - the same
  // "fail loud, not silent" discipline as validate.js's staleness gate.
  // Uses Matcher.slotRe() for both the substitution and the leftover
  // check - the single source of truth for the "{{SLOT}}" shape (see that
  // function's own comment in js/matcher.js for why it lives there and not
  // here: js/validate.js needs the same pattern at data-author time, and
  // it loads before this file does).
  function fillTemplate(text, slots, blockId) {
    var src = String(text);
    var out = src.replace(Matcher.slotRe(), function (m, key, offset) {
      var v = slots[key];
      if (v == null) return m;
      // ECHO in sentence position (2 Oct 2026): the quote is stored without
      // its closing full stop so it sits cleanly inside a frame's quotation
      // marks (see quoteForm). Where a template drops it in as a sentence
      // of its own - let-ev-tcs-*'s closing "{{ECHO}}", no quotation mark
      // before it - the full stop goes back on, exactly as the ad wrote it.
      // (Since 3 Oct 2026 that ending is only used when no why-paragraph
      // frame has already quoted the line - see the evidence block below.)
      if (key === "ECHO" && v && !/["“'‘]/.test(src.charAt(offset - 1)) && !/[.!?]$/.test(v)) return v + ".";
      return v;
    });
    if (Matcher.slotRe().test(out)) {
      throw new Error("letterbuild.js: letterBlocks['" + blockId + "'] still has an unfilled {{SLOT}} after substitution - a slot value is missing.");
    }
    return out;
  }

  // 21 Sept 2026 (cover-letter renderer, order-of-work step 3): every
  // letterBlocks entry this file selects gets a template-shaped _prov, the
  // same "provably traceable to the data file" discipline every CV block
  // has carried since Phase 4 - just extended to cover template
  // substitution, which the CV side never had to deal with. A plain
  // equality check against ref[field] (the CV's own provenance shape)
  // cannot work here: the rendered text has {{ROLE}}/{{COMPANY}}/{{TEAM}}/
  // {{ECHO}}/{{YEARS}} slots filled in with runtime values, so it will
  // never equal the raw template string. js/verify.js's expectedFromProv()
  // recognises this shape (prov.template) and re-runs fillTemplate() with
  // the SAME slots recorded here to compute what the rendered text SHOULD
  // be - a real check (wrong ref, tampered text, or a stale slot value
  // still fails it), not a rubber stamp that trusts whatever this file
  // just built.
  function templateProv(ref, field, slots) {
    return { template: { ref: ref, field: field, slots: slots } };
  }

  // --- titleMismatch gap trigger -----------------------------------------
  // js/fitcheck.js's computeGapTrigger only ever returns "yearsShort" or
  // "none" - its own comment says titleMismatch needs a ROLE-title
  // comparison that is Phase 7's job to add. Deliberately NOT auto-detected
  // here either: comparing the ad's title against Derin's own career
  // history is a semantic judgement (does "Business Analyst" but with a
  // materially different job behind it count as a mismatch?), not a
  // mechanical check like years-required or a neverClaim term, and this
  // project's whole discipline is "never guess a fact / never guess a
  // judgement call about Derin - ask." So titleMismatch is a MANUAL flag
  // (opts.titleMismatch === true) the person building the letter sets
  // themselves, exactly like the ECHO click - the app supplies the
  // paragraph text once told, it does not infer the judgement. Flagged to
  // Derin as a deliberate choice, not an oversight.
  function resolveGapTrigger(fitCheckGapTrigger, titleMismatchFlag) {
    if (titleMismatchFlag) return "titleMismatch";
    return fitCheckGapTrigger || "none";
  }

  // --- Top-level assembly -------------------------------------------------
  // opts: {
  //   archetypeId, extraction (js/score.js CVScore.extractFromJD output or
  //   null), rawJD, yearsRelevant, company, role, team (already validated -
  //   caller's job to call validateTeam() first and block the download on
  //   !valid, same layering as js/verify.js's other gates), echoText
  //   (the verbatim string Derin clicked from buildEchoCandidates(), or ""
  //   if he chose none / none were offered), titleMismatch (bool, manual).
  // }
  // Returns { blocks: [{id, category, text, ref}], echoCandidates }.
  // `ref` is the original letterBlocks entry (id + empty-slot heightPx),
  // needed downstream by js/pagefit.js's letterBlockHeight(ref, filledText)
  // - not called here, same layering as buildModel() never calling
  // js/pagefit.js itself.
  // opts.choices (2 Oct 2026, the per-section dropdowns) - Derin's own
  // picks, each one an id of an approved letterBlocks entry (or "none"):
  //   mode:      "standard" | "closeMatch" - overrides the close-match
  //              trigger either way (the trigger still decides by default)
  //   why:       a letterBlocks.why id (a plain, non-echo entry) | "none"
  //   echoFrame: which echo-frame entry wraps the quoted line
  //   evidence:  a letterBlocks.evidence id | "none"
  //   gap:       a letterBlocks.gap id | "none"
  // Missing or stale values mean "auto": exactly the selection this
  // function always made. Nothing is composed - the same fillTemplate/
  // templateProv path builds every block, so js/verify.js checks a picked
  // paragraph exactly the way it checks an auto-picked one.
  // opts.echoCandidates / opts.closeMatchResult: already-computed results
  // for this same JD, so the dropdowns can build a letter per option
  // without re-segmenting the ad each time. Omitted -> computed here.
  function buildLetterModel(data, opts) {
    opts = opts || {};
    var choices = opts.choices || {};
    var lb = data.letterBlocks;
    var archetypeId = opts.archetypeId;
    var extraction = opts.extraction || null;
    var rawJD = opts.rawJD || (extraction && extraction.raw) || "";
    var company = opts.company || "";
    var role = opts.role || "";
    var team = opts.team || "";
    var echoText = opts.echoText || "";
    // refereeName (25 Sept 2026, privacy pass): NOT read from the data
    // file - see let-close-referee's basis.why and js/app.js's boot(). A
    // real name is private-overrides-only, supplied at runtime by whoever
    // is running this app locally; the committed data file only ever holds
    // the {{REFEREE}} slot, never a name. Empty is the normal case for
    // anyone who has not set up an override file, and must mean "omit the
    // referee block entirely" - never "render the slot empty" - so this is
    // read here but NOT put in `slots` unless non-empty (see the
    // conditional push below, which also gates on it directly).
    var refereeName = opts.refereeName || "";

    var echoCandidates = opts.echoCandidates || buildEchoCandidates(data, rawJD, opts.yearsRelevant);

    var slots = { ROLE: role, COMPANY: company, TEAM: team, ECHO: echoText, YEARS: opts.yearsRequiredText || (extraction && extraction.yearsRequired != null ? String(extraction.yearsRequired) : ""), REFEREE: refereeName };

    // Close-match mode (26 Sept 2026, item 4): checked once, up front, and
    // used below to pick the opening variant and to replace why+evidence+
    // gap with the five letterBlocks.closeMatch entries - see
    // computeCloseMatchTrigger's own comment for what "fired" means and
    // the two judgement calls its definition rests on.
    var closeMatch = opts.closeMatchResult || computeCloseMatchTrigger(data, rawJD);
    // closeMatchUsed: whether this letter is actually written in close-match
    // shape - the trigger's own answer unless Derin picked a mode.
    var closeMatchUsed = choices.mode === "closeMatch" ? true : (choices.mode === "standard" ? false : closeMatch.fired);

    var blocks = [];

    // Opening: with-team variant only when TEAM is non-empty (already
    // validated by the caller) - the app supplies the collapse, it does
    // not ask "do you want a team mentioned." Close-match mode swaps in
    // its own opening pair instead (still team-collapsed the same way),
    // never both.
    var openingId;
    if (closeMatchUsed) {
      openingId = team ? "let-open-closematch-team" : "let-open-closematch-std";
    } else {
      openingId = team ? "let-open-team" : "let-open-std";
    }
    var opening = Assemble.findById(lb.opening, openingId);
    if (!opening) throw new Error("letterbuild.js: letterBlocks.opening['" + openingId + "'] not found.");
    blocks.push({
      id: opening.id, category: "opening", text: fillTemplate(opening.text, slots, opening.id), ref: opening,
      _prov: { text: templateProv(opening, "text", slots) }
    });

    // Why: every plain archetype-matched entry, in file order, PLUS at most
    // one ECHO paragraph. letterBlocks.why entries marked isEchoFrame:true
    // are alternate phrasings of the same paragraph (Derin: "add two or
    // three frame variants so the letters do not all open the same way") -
    // never all included together, exactly one is chosen. The entry marked
    // isEchoFallback:true is the single no-echo sibling all of them share
    // when echoText is empty (no candidates, or Derin picked none) - see
    // file header, never an empty quote, never a placeholder.
    //
    // Which frame variant gets chosen: first-listed (file order), same
    // tie-break discipline as everywhere else in this app. There is no
    // rotation mechanism (by company, by archetype, at random) - this app
    // has no randomness anywhere and none was specced for this, so the
    // "do not all open the same way" goal is only half-delivered right
    // now (the variants exist; nothing yet varies which one is picked).
    // Flagged, not silently left unfinished.
    var whyEntries = closeMatchUsed ? [] : entriesForArchetype(lb.why, archetypeId);
    var plainWhy = whyEntries.filter(function (e) { return !e.isEchoFrame && !e.isEchoFallback; });
    var echoFrames = whyEntries.filter(function (e) { return e.isEchoFrame; });
    var echoFallback = whyEntries.filter(function (e) { return e.isEchoFallback; })[0];
    if (!closeMatchUsed && choices.why) {
      var pickedWhy = choices.why === "none" ? null : Assemble.findById(lb.why, choices.why);
      if (choices.why === "none") plainWhy = [];
      else if (pickedWhy && !pickedWhy.isEchoFrame && !pickedWhy.isEchoFallback) plainWhy = [pickedWhy];
    }

    plainWhy.forEach(function (entry) {
      blocks.push({
        id: entry.id, category: "why", text: fillTemplate(entry.text, slots, entry.id), ref: entry,
        _prov: { text: templateProv(entry, "text", slots) }
      });
    });
    var echoQuotedInWhy = false;
    if (echoText && echoFrames.length) {
      var chosen = (choices.echoFrame && echoFrames.filter(function (e) { return e.id === choices.echoFrame; })[0]) || echoFrames[0];
      blocks.push({
        id: chosen.id, category: "why", text: fillTemplate(chosen.text, slots, chosen.id), ref: chosen,
        _prov: { text: templateProv(chosen, "text", slots) }
      });
      echoQuotedInWhy = true;
    } else if (echoFallback) {
      blocks.push({
        id: echoFallback.id, category: "why", text: fillTemplate(echoFallback.text, slots, echoFallback.id), ref: echoFallback,
        _prov: { text: templateProv(echoFallback, "text", slots) }
      });
    }

    // Close-match mode: one paragraph per matched cluster, in the data
    // file's own fixed order - "the opening paragraph states the match
    // plainly, then one paragraph per matched cluster... Then the standard
    // close" (Derin, verbatim). Replaces why+evidence entirely; never both.
    var evidence = null;
    if (closeMatchUsed) {
      (data.letterBlocks.closeMatch || []).forEach(function (entry) {
        blocks.push({
          id: entry.id, category: "evidence", text: fillTemplate(entry.text, slots, entry.id), ref: entry,
          _prov: { text: templateProv(entry, "text", slots) }
        });
      });
    }

    // Evidence: single highest tag-overlap entry (see bestByTags' comment
    // on this being a Phase 7 scoping decision) - AMONG the entries this
    // archetype is even eligible for. Added 19 Sept 2026: the three
    // let-ev-tcs-* variants (pilot/control/improve) each cover a fixed,
    // disjoint set of archetypes (data.archetypes[i]._pendingReview flags
    // the one archetype - retail-parttime - whose mapping is a guess, not
    // Derin's instruction), and letting all three compete on tags the way
    // console/ai/tcs used to would silently reintroduce a wrong-archetype
    // pick that happens to share tags. Same entriesForArchetype() filter
    // `why` already used; let-ev-console/let-ev-ai carry archetypes:["*"]
    // so they still compete for everyone underneath it.
    //
    // requiresTags (4 Oct 2026): an entry carrying it is only picked
    // automatically when the ad matches one of those tags - let-ev-ai says
    // "the AI tooling you mention", which would be false for an ad that
    // only matched its looser 'automation'/'tooling' tags. A hand pick from
    // the dropdown is honoured as chosen.
    var evidenceCandidates = closeMatchUsed ? [] : entriesForArchetype(lb.evidence, archetypeId).filter(function (e) {
      return requiredTagsMatched(e, extraction);
    });
    // Two evidence paragraphs (4 Oct 2026, Derin: "yes" to "add a second
    // evidence paragraph whenever it fits on the page"; same day: "keep my
    // tcs experience in the 2nd para atleast because that is the only
    // office/mnc experience I have").
    //
    // Automatically: the best match by tags (ties to file order) plus a
    // partner for it - the archetype's TCS paragraph whenever the first
    // isn't one (every archetype has exactly one, see js/validate.js), or
    // the best non-TCS match when it is (two TCS paragraphs would tell the
    // same pilot-team story twice). The two print in the data file's own
    // order (console, the TCS variants, then AI): let-ev-console opens "The
    // clearest thing I can point to...", which only reads right first.
    // js/letter.js takes the non-TCS one out again if the letter would not
    // fit on one page - the TCS paragraph is never the one dropped.
    //
    // The two dropdowns are the two printed positions. A hand pick in
    // either keeps an automatic partner in the other (the TCS paragraph
    // again if the pick isn't one); a hand pick is never overridden, except
    // that the same paragraph is never printed twice. "none" turns a
    // position off: second off leaves one paragraph (the TCS one unless the
    // first was picked by hand), first off leaves none.
    var tcsCandidate = evidenceCandidates.filter(isTcsEvidence)[0] || null;
    var partnerFor = function (first) {
      if (!first) return null;
      if (!isTcsEvidence(first) && tcsCandidate) return tcsCandidate;
      return bestByTags(evidenceCandidates.filter(function (e) {
        return e.id !== first.id && !(isTcsEvidence(e) && isTcsEvidence(first));
      }), extraction);
    };
    var autoPrimary = null;
    var autoSecond = null;
    if (!closeMatchUsed) {
      autoPrimary = bestByTags(evidenceCandidates, extraction);
      autoSecond = partnerFor(autoPrimary);
    }
    var evidenceOrder = (lb.evidence || []).map(function (e) { return e.id; });
    var autoSlots = [autoPrimary, autoSecond].filter(Boolean).sort(function (a, b) {
      return evidenceOrder.indexOf(a.id) - evidenceOrder.indexOf(b.id);
    });
    var evidence2 = null;
    var picked1 = null;
    var picked2 = null;
    if (!closeMatchUsed && choices.evidence !== "none") {
      picked1 = choices.evidence ? Assemble.findById(lb.evidence, choices.evidence) : null;
      picked2 = (choices.evidence2 && choices.evidence2 !== "none") ? Assemble.findById(lb.evidence, choices.evidence2) : null;
      if (choices.evidence2 === "none") {
        evidence = picked1 || tcsCandidate || autoPrimary;
      } else if (picked1 && picked2) {
        evidence = picked1;
        evidence2 = picked2.id !== picked1.id ? picked2 : null;
      } else if (picked1) {
        evidence = picked1;
        evidence2 = partnerFor(picked1);
      } else if (picked2) {
        evidence = partnerFor(picked2);
        evidence2 = picked2;
      } else {
        evidence = autoSlots[0] || null;
        evidence2 = autoSlots[1] || null;
      }
      if (!evidence && evidence2) { evidence = evidence2; evidence2 = null; }
    }
    var slot1Hand = !!picked1 && evidence === picked1;
    var slot2Hand = !!picked2 && evidence2 === picked2;
    // The paragraph js/letter.js may take out for space: the automatic
    // non-TCS one. Never the TCS paragraph, never one Derin picked himself.
    var evidenceDroppableId = null;
    var evidenceKeepId = null;
    if (evidence && evidence2 && !(slot1Hand && slot2Hand)) {
      var dropMe = null;
      if (!slot1Hand && !slot2Hand) {
        if (isTcsEvidence(evidence) !== isTcsEvidence(evidence2)) dropMe = isTcsEvidence(evidence) ? evidence2 : evidence;
        else dropMe = autoSecond;
      } else {
        var autoOne = slot1Hand ? evidence2 : evidence;
        if (!isTcsEvidence(autoOne)) dropMe = autoOne;
      }
      if (dropMe === evidence || dropMe === evidence2) {
        evidenceDroppableId = dropMe.id;
        evidenceKeepId = (dropMe === evidence ? evidence2 : evidence).id;
      }
    }
    var noHandPicks = !slot1Hand && !slot2Hand;
    [evidence, evidence2].forEach(function (entry, i) {
      if (!entry) return;
      var role = noHandPicks ? (autoPrimary && entry.id === autoPrimary.id ? "primary" : "second") : (i === 0 ? "primary" : "second");
      pushEvidence(entry, role, i + 1);
    });

    function pushEvidence(evidence, role, slot) {
      // noEchoText (added 19 Sept 2026, TCS variants only): the sibling
      // ending before the {{ECHO}} sentence, used whenever no ECHO quote
      // survived selection/exclusion - same "never a placeholder, never a
      // dangling {{ECHO}}" discipline as `why`'s echoFallback, just kept
      // on the single winning entry instead of a separate list entry,
      // since these three already differ in emphasis and don't need a
      // second competing sibling in the tag-overlap pick above.
      //
      // 3 Oct 2026 (Derin, "apply them all" - yes to dropping the repeat):
      // noEchoText is ALSO used when the why paragraph above has already
      // quoted the line. Every echo frame is archetypes:["*"], so before
      // this a letter with a quote printed it twice - once in quotation
      // marks, then again as this paragraph's own closing sentence. The
      // quote now appears once, in the frame; the {{ECHO}} ending is only
      // reached when a quote exists and no frame used it. Selection between
      // two approved texts, nothing composed.
      var evidenceField = (evidence.noEchoText && (!echoText || echoQuotedInWhy)) ? "noEchoText" : "text";
      var evidenceText = evidence[evidenceField];
      blocks.push({
        id: evidence.id, category: "evidence", evidenceRole: role, evidenceSlot: slot, text: fillTemplate(evidenceText, slots, evidence.id), ref: evidence,
        _prov: { text: templateProv(evidence, evidenceField, slots) }
      });
    }

    // Gap: trigger-matched entry; "none"'s own text is "" and is dropped,
    // not rendered as a blank paragraph. At most ONE gap paragraph is ever
    // possible here by construction (entryForTrigger picks a single entry
    // for a single gapTrigger string, and there is exactly one push below,
    // not a loop) - that is the "cap gap paragraphs at one per letter"
    // part of Derin's 25 Sept 2026 instruction, satisfied by the shape of
    // this function, not by an extra check. The golden suite has a
    // permanent regression test proving this invariant holds across the
    // real fixture corpus, so a future change that broke it (e.g. someone
    // looping over multiple gap categories) would be caught.
    //
    // The other half of that instruction is new here: "fail if the same
    // gap is already named in the archetype paragraph - a letter that
    // names its own gap twice reads worse than one that never named it."
    // GAP_DUPLICATE_TERMS below is the three term-based gaps' own
    // "named once" wording turned into a real check - Matcher.test() (the
    // same exact-word matcher every other gate in this app uses) against
    // the `why`/`evidence` paragraphs actually selected above, i.e. the
    // archetype's OWN authored content, not the gap paragraph itself.
    // yearsShort/titleMismatch are deliberately excluded: neither is a
    // named-credential/topic collision this app can check with a term
    // list (yearsShort is a numeric comparison, titleMismatch is a manual
    // flag), so there is nothing meaningful to de-duplicate against.
    var GAP_DUPLICATE_TERMS = {
      qfa: ["QFA"],
      irishPensions: ["Irish pensions legislation"],
      sales: ["sales", "recruiting", "cold outreach"]
    };
    var gapTrigger = resolveGapTrigger(opts.fitCheckGapTrigger, opts.titleMismatch);
    // Close-match mode carries no gap paragraph (Derin's own fixed shape
    // names opening, clusters, then the standard close only) - gapTrigger
    // is still computed above for the return value's sake, but `gap`
    // itself is forced null so nothing is ever pushed.
    var gap = closeMatchUsed ? null : entryForTrigger(lb.gap, gapTrigger);
    var gapPicked = false;
    if (!closeMatchUsed && choices.gap) {
      gap = choices.gap === "none" ? null : (Assemble.findById(lb.gap, choices.gap) || gap);
      gapPicked = choices.gap !== "none" && !!Assemble.findById(lb.gap, choices.gap);
    }
    var gapSuppressedDuplicate = false;
    if (gap && gap.text && gapPicked) {
      // Derin's own pick: no duplicate suppression - he chose it knowing
      // what the rest of the letter says.
      blocks.push({
        id: gap.id, category: "gap", text: fillTemplate(gap.text, slots, gap.id), ref: gap,
        _prov: { text: templateProv(gap, "text", slots) }
      });
    } else if (gap && gap.text) {
      var dupTerms = GAP_DUPLICATE_TERMS[gapTrigger];
      var archetypeParaText = blocks.filter(function (b) { return b.category === "why" || b.category === "evidence"; })
        .map(function (b) { return b.text; }).join(" ");
      var alreadyNamed = !!dupTerms && dupTerms.some(function (term) { return Matcher.test(archetypeParaText, term); });
      if (alreadyNamed) {
        gapSuppressedDuplicate = true;
      } else {
        blocks.push({
          id: gap.id, category: "gap", text: fillTemplate(gap.text, slots, gap.id), ref: gap,
          _prov: { text: templateProv(gap, "text", slots) }
        });
      }
    }

    // Hard-requirement gap paragraph (30 Sept 2026, additive): a SEPARATE
    // mechanism from the gap-trigger system just above - that one is capped
    // at a single entry by construction (entryForTrigger picks one entry for
    // one trigger string) and is driven by js/fitcheck.js's warnings, not by
    // js/hardreq.js. This one is driven by opts.hardReqGapIds (already
    // computed by js/app.js from the RED findings that carry a gapBlockId,
    // capped at two, in finding order) and is independent of gapTrigger/gap
    // above - both can appear in the same letter (e.g. a years-short gap
    // AND an APA gap), each its own paragraph, never merged. Close-match
    // mode carries no such paragraph either, same reasoning as the existing
    // gap block just above (Derin's own fixed shape names opening, clusters,
    // then the standard close only).
    var hardReqGap = closeMatchUsed ? null : buildHardReqGapBlock(data, opts.hardReqGapIds);
    if (hardReqGap) blocks.push(hardReqGap);

    // Close: with-company variant unless COMPANY is empty (mirrors the
    // opening's collapse logic rather than always assuming COMPANY is set).
    var closeId = company ? "let-close-std" : "let-close-plain";
    var close = Assemble.findById(lb.close, closeId);
    if (!close) throw new Error("letterbuild.js: letterBlocks.close['" + closeId + "'] not found.");
    blocks.push({
      id: close.id, category: "close", text: fillTemplate(close.text, slots, close.id), ref: close,
      _prov: { text: templateProv(close, "text", slots) }
    });

    // Referee (added 21 Sept 2026, Derin's own instruction: TCS narrative-
    // gap fix, a named referee). Appended after the main close block
    // whenever the evidence paragraph actually selected above is one of
    // the three TCS pilot-team variants - never for let-ev-tcs-shift
    // (retail) or any non-TCS evidence, exactly as instructed. Checked
    // against `evidence.id` (the entry actually chosen by bestByTags, not
    // the archetype id) so this can never fire for an archetype merely
    // eligible for TCS evidence that ended up NOT being the winning
    // tag-overlap pick.
    //
    // ALSO gated on refereeName (25 Sept 2026, privacy pass): the real
    // name lives only in a local, gitignored private-overrides file (see
    // js/app.js's boot() and this file's own refereeName comment above),
    // never in the committed data file. Without an override loaded, this
    // block is omitted entirely - same "omit rather than guess/placeholder"
    // discipline as the TEAM and COMPANY collapses elsewhere in this
    // function - never rendered with an empty {{REFEREE}} slot.
    // refereeEligible/refereeRendered (26 Sept 2026, item 3 of the follow-up
    // work order): "never drop the referee line silently" - js/app.js needs
    // to tell the difference between "not eligible for a referee this time"
    // (any non-TCS-pilot-team evidence pick; nothing to say) and "eligible,
    // but no private-overrides.json is loaded" (a real omission Derin asked
    // to be surfaced, not silently swallowed). Both flags returned below so
    // the caller can show a notice in exactly the second case.
    // Close-match mode (26 Sept 2026, item 4) is also referee-eligible:
    // its five clusters ARE the same TCS pilot-team story the three
    // REFEREE_EVIDENCE_IDS variants tell in condensed form, just split
    // across paragraphs instead of selected as one - the manager referee
    // fact is unchanged either way. Derin's own close-match spec does not
    // mention the referee line either way; this is a judgement call, not
    // a literal instruction, flagged here and in the pass report rather
    // than silently assumed.
    var REFEREE_EVIDENCE_IDS = ["let-ev-tcs-pilot", "let-ev-tcs-control", "let-ev-tcs-improve"];
    // Either evidence paragraph counts (4 Oct 2026: a letter can now carry
    // two, e.g. the console paragraph first and a TCS variant second).
    var refereeEligible = closeMatchUsed || [evidence, evidence2].some(function (e) { return !!e && REFEREE_EVIDENCE_IDS.indexOf(e.id) !== -1; });
    var refereeRendered = false;
    if (refereeEligible && refereeName) {
      var referee = Assemble.findById(lb.close, "let-close-referee");
      if (!referee) throw new Error("letterbuild.js: letterBlocks.close['let-close-referee'] not found.");
      blocks.push({
        id: referee.id, category: "close", text: fillTemplate(referee.text, slots, referee.id), ref: referee,
        _prov: { text: templateProv(referee, "text", slots) }
      });
      refereeRendered = true;
    }

    // Signoff: one entry, no selection logic.
    (lb.signoff || []).forEach(function (entry) {
      blocks.push({
        id: entry.id, category: "signoff", text: fillTemplate(entry.text, slots, entry.id), ref: entry,
        _prov: { text: templateProv(entry, "text", slots) }
      });
    });

    return { blocks: blocks, echoCandidates: echoCandidates, gapTrigger: gapTrigger, gapSuppressedDuplicate: gapSuppressedDuplicate, refereeEligible: refereeEligible, refereeRendered: refereeRendered, closeMatch: closeMatch, closeMatchUsed: closeMatchUsed,
      evidenceId: evidence ? evidence.id : null, evidence2Id: evidence2 ? evidence2.id : null, evidenceDroppableId: evidenceDroppableId, evidenceKeepId: evidenceKeepId };
  }

  global.CVLetterBuild = {
    buildEchoCandidates: buildEchoCandidates,
    pickEchoAuto: pickEchoAuto,
    employerTalksAboutItself: employerTalksAboutItself,
    quoteForm: quoteForm,
    validateTeam: validateTeam,
    validateRecipientName: validateRecipientName,
    validateStartDate: validateStartDate,
    startDateTriggersExtendedAuth: startDateTriggersExtendedAuth,
    computeCloseMatchTrigger: computeCloseMatchTrigger,
    buildLetterModel: buildLetterModel,
    // fillTemplate is exported for one real caller, not for convenience:
    // js/verify.js's provenance gate must recompute the SAME substitution
    // against the SAME slots to check a templated block's rendered text is
    // what it should be (see templateProv's comment above) - reusing this
    // function instead of a second copy is the same "one way to do a thing"
    // discipline as js/matcher.js being the app's one way to match text.
    fillTemplate: fillTemplate,
    // templateProv exported 21 Sept 2026 so js/letter.js's salutationBlock()
    // can build the same {template: {ref, field, slots}} provenance shape
    // for the new named-salutation entry, rather than duplicating this
    // three-line function as a second copy that could drift from this one -
    // same "one way to do a thing" reasoning as fillTemplate's own export.
    templateProv: templateProv,
    // exposed for tests / debugging, not part of the "public API" the UI
    // is expected to call directly:
    tagStrengthMap: tagStrengthMap,
    bannedPhrases: bannedPhrases,
    strengthLabel: strengthLabel,
    resolveGapTrigger: resolveGapTrigger,
    // exported 30 Sept 2026 for the hard-requirement gap paragraph's own
    // tests, same reason the functions above it are exported.
    buildHardReqGapBlock: buildHardReqGapBlock
  };
})(typeof window !== "undefined" ? window : globalThis);
