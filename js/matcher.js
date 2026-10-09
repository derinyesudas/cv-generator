// ---------------------------------------------------------------------------
// Single matcher, used everywhere a term from the data file has to be found
// inside JD text: js/verify.js's never-claim gate, js/score.js's qualification
// -demand and tools-mentioned checks, skill-tag hit counting, and (once
// Phase 6 wires it up) data.warnings patterns. Before this file existed,
// four separate hand-rolled techniques did this (neverClaimScan's raw
// substring check, extractQualificationDemands's raw substring check,
// countHits's whitespace-boundary regex, warnings' own ad-hoc patterns) -
// that's how the short term "aca" ended up matching inside "vacancy" and
// "academic" in one place while being correctly boundary-checked in
// another. One matcher, one bug class to get right.
//
// data.matchRule (in cv-generator-data.json) documents the syntax this file
// implements: a trailing "*" on a term means STEM (match the word and its
// inflections - "reconcil*" catches reconcile/reconciled/reconciling/
// reconciliation); no "*" means EXACT WORD ("aca" must not match
// "academic"). See data.matchRule._trap: never stem a term under about six
// characters without testing it against real ad text, because the stem
// wildcard can reintroduce the exact boundary bug it exists to prevent
// (\baca\w*\b DOES match "academic" - that's why "aca" stays exact, not
// stemmed, in data.neverClaim).
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Strips a trailing literal "*" and reports whether it was there.
  function parseTerm(term) {
    var t = String(term == null ? "" : term);
    var stem = /\*$/.test(t);
    return { base: stem ? t.slice(0, -1) : t, stem: stem };
  }

  // Boolean-match regex: exact terms get \b{term}\b, stemmed terms get
  // \b{term}\w*\b. This is the "does this term appear at all" form, used
  // for neverClaim, knownAbsentTools, qualification demands, warnings.
  function testRegex(term) {
    var p = parseTerm(term);
    var esc = escapeRe(p.base);
    return new RegExp("\\b" + esc + (p.stem ? "\\w*" : "") + "\\b", "gi");
  }

  // Counting regex: a lookahead, so consecutive repeats of the same term
  // don't consume each other's boundary ("sql sql sql" must count 3, not
  // 2 - see data.matchRule.countHits and the audit that caught this).
  // Always allows an optional trailing \w* regardless of the term's own
  // stem flag - per data.matchRule's own canonical formula - because
  // counting hits for scoring purposes (keyword weight, tag overlap) is
  // not the safety-critical exact-match case neverClaim/qualification
  // checks are; those use testRegex, not this.
  function countRegex(term) {
    var p = parseTerm(term);
    var esc = escapeRe(p.base);
    return new RegExp("(?=\\b" + esc + "(\\w*)?\\b)", "gi");
  }

  function test(text, term) {
    return testRegex(term).test(String(text == null ? "" : text));
  }

  function countHits(normalizedText, term) {
    var m = String(normalizedText == null ? "" : normalizedText).match(countRegex(term));
    return m ? m.length : 0;
  }

  // Every term in `terms` that appears anywhere in `text` (case
  // insensitive), each tested independently.
  function scanList(text, terms) {
    return (terms || []).filter(function (t) { return test(text, t); });
  }

  // scanListJoined (2 Oct 2026): scanList, but also catching a multi-word
  // term written with hyphens - "anomaly-detection" for the never-claim
  // term "anomaly detection". scanList's own word-boundary matching treats
  // the hyphenated compound as a different string, which let exactly one
  // approved bullet variant (bulletVariants.b-report, presentation
  // wording, deleted 3 Oct 2026) print a never-claim term on real CVs.
  // Additive: scanList and
  // every other caller are unchanged; only the never-claim scan
  // (js/verify.js) and the never-claim-aware variant pick (js/assemble.js)
  // use this.
  function scanListJoined(text, terms) {
    var spaced = String(text || "").replace(/([A-Za-z0-9])-(?=[A-Za-z0-9])/g, "$1 ");
    return (terms || []).filter(function (t) { return test(text, t) || test(spaced, t); });
  }

  // ---------------------------------------------------------------------
  // Letter-template slot syntax (25 Sept 2026, item 4 of Derin's privacy-
  // and-correctness pass - "the RECIPIENT_NAME bug is a class, not an
  // incident. Fix the class."). The bug: js/letterbuild.js's fillTemplate
  // matches "{{SLOT}}" with a bare [A-Z]+ token - no underscore, no digits,
  // no lowercase. When a data-file author wrote "{{RECIPIENT_NAME}}" (an
  // underscore), that regex simply never matched it, in either direction:
  // not for substitution, and not for the "did everything get filled in"
  // leftover check that uses the exact same pattern - so a literal,
  // unfilled "{{RECIPIENT_NAME}}" could have shipped straight into a real
  // letter with every existing gate green, because none of them read the
  // rendered text as text. (The actual fix applied at the time was to
  // rename the slot to "{{RECIPIENT}}", which happens to fit the pattern -
  // this export is the follow-up: making sure the NEXT malformed slot name
  // fails loudly instead of getting the same free pass.)
  //
  // These two are exported from here, not from js/letterbuild.js, purely
  // because of <script> load order in index.html: js/validate.js (which
  // needs to check slot shape at data-author time, before a single letter
  // is ever built) loads before js/letterbuild.js does. js/matcher.js is
  // the one shared module already loaded first, so it is the single
  // source of truth both files import from - same "one way to do a thing"
  // reasoning as everything else in this file.
  //
  // slotRe() - matches only a WELL-FORMED slot ({{ROLE}}, {{ECHO}}, ...).
  // This is what fillTemplate uses to substitute, and to detect "is
  // anything still unfilled" afterwards.
  //
  // braceRe() - matches ANY {{...}}-shaped token, well-formed or not. This
  // is what js/validate.js uses to FIND a malformed one (an underscore, a
  // lowercase letter, a digit, empty braces) that slotRe() would silently
  // ignore - the exact blind spot the RECIPIENT_NAME bug lived in.
  //
  // Both return a NEW RegExp on every call (not a shared /g instance) -
  // same reasoning as testRegex/countRegex above: a shared global-flagged
  // regex object carries mutable lastIndex state between calls, which is
  // exactly the kind of subtle cross-call bug this file exists to avoid
  // introducing a second time.
  function slotRe() {
    return /\{\{([A-Z]+)\}\}/g;
  }
  function braceRe() {
    return /\{\{([^{}]*)\}\}/g;
  }
  // The complete set of slot names actually wired up to a real value
  // somewhere in this app (js/letterbuild.js's buildLetterModel `slots`
  // object, plus js/letter.js's salutationBlock RECIPIENT slot, plus
  // js/assemble.js's buildAuthLine ADSTARTDATE slot, added 26 Sept 2026,
  // item 2b - the first template slot used OUTSIDE letterBlocks, on the
  // CV's own right-to-work line via data.identity.rightToWorkExtendedTemplate;
  // this list's name predates that and is kept rather than renamed, since
  // every name here is still "a known template slot", letter-only or not).
  // A well-formed but unregistered slot ({{ROLLE}}, a typo) is a different
  // failure than a malformed one, but the same class Derin named: still
  // silent everywhere except a render-time throw that only fires for
  // whichever archetype/category combination happens to touch that one
  // block. js/validate.js checks new slot tokens against this list too, at
  // author time. If a new slot is ever wired up in js/letterbuild.js,
  // js/letter.js, or js/assemble.js, it must be added here in the same
  // change, or validate.js will (correctly) refuse to load the data file
  // that uses it.
  var KNOWN_LETTER_SLOTS = ["ROLE", "COMPANY", "TEAM", "ECHO", "YEARS", "RECIPIENT", "REFEREE", "ADSTARTDATE"];

  // ---------------------------------------------------------------------
  // Stem-set tag matching (27 Sept 2026, item 1 of Derin's matcher/deploy
  // work order, verbatim diagnosis: "Exact multi-word phrase matching is
  // the wrong tool for real ad prose... this applies to scoring generally,
  // not just close-match"). Root cause, confirmed against the real SoftCo
  // fixture (26 Sept 2026 pass): the closeMatch tag "client liaison" never
  // matched the real ad's own wording, "Liaise with clients to confirm
  // data receipt" - same idea, different inflection and word order, which
  // a literal Matcher.test(text, "client liaison") phrase match can never
  // bridge. Replaces phrase matching for TAG matching specifically
  // (bulletVariants/profileVariants/skillLines/letterBlocks tags, and
  // archetype.keywords) - NOT for js/matcher.js's testRegex/countRegex
  // exact/stem-wildcard matching, which stays exactly as it was: neverClaim,
  // qualificationDemands, and knownAbsentTools are false-CLAIM safety gates
  // ("does the rendered text literally say X"), not fuzzy-recall scoring,
  // and loosening those would trade a false-claim risk for a recall
  // improvement that has no business being made there. See data.matchRule
  // for that split's own documentation.
  //
  // A tag matches a sentence when EVERY content word of the tag, after
  // stemming and stopword removal, has a matching stem among the
  // sentence's own words - "matching" being stem equality, OR (for longer
  // stems only - see MIN_PREFIX_STEM_LEN below) one stem being a prefix of
  // the other, so "liaise"/"liaising"/"liaison" (which a 7-suffix hand-
  // rolled stemmer cannot force to one identical root - see stem()'s own
  // comment) still recognise each other. Order-independent within a
  // sentence (span-scoped, same as every existing per-sentence check in
  // this app - js/segment.js's classifySentences already keeps the scope
  // to one sentence, which is what keeps this from also matching two
  // unrelated words that happen to share a sentence with 30 other words).
  var STOPWORDS = { "a": 1, "an": 1, "the": 1, "of": 1, "to": 1, "in": 1, "on": 1, "and": 1, "or": 1, "for": 1, "with": 1, "your": 1, "you": 1, "our": 1 };

  // Minimum stem length before two DIFFERENT-length stems are allowed to
  // match by prefix-containment rather than exact equality. Below this
  // length, only an EXACT stem match counts - this is the direct extension
  // of data.matchRule._trap's own warning ("never stem a term under about
  // six characters without testing it against real ad text... \baca\w*\b
  // DOES match academic") into stem-SET matching: without this floor, a
  // short tag word like "aca" (unchanged by stem() below, since stem()
  // itself also leaves words this short alone) would count as a "prefix
  // match" against "academic" the same way the old wildcard bug did.
  // Chosen empirically against every stemmer pair this pass was asked to
  // prove (see tests/golden/run-golden-tests.mjs's "Stemmer pairs" section):
  // the shortest genuine cross-form stem produced by any of them is 5
  // characters ("valid" from validation, "escal" from escalation, "liais"
  // from liaise/liaising) - 5 is the floor that accepts every one of those
  // and still excludes "aca" (3, exact-only) from ever reaching this branch.
  var MIN_PREFIX_STEM_LEN = 5;

  // Second guard on the same prefix relationship, added after the first
  // guard alone still let a real regression through (27 Sept 2026, found
  // by re-running the full real fixture corpus, not assumed safe): the
  // archetype keyword "finance" (stem "financ", 6 chars, clears
  // MIN_PREFIX_STEM_LEN on its own) was found to prefix-match "financial"
  // (9 chars) - a real word, but a MUCH weaker signal that a JD is
  // actually finance-flavoured than "finance"/"financing"/"financed" would
  // be, and it flipped the standard-life-pensions-investments-administrator
  // fixture's archetype pick away from insurance-pensions (its own
  // documented, previously-correct expectation in tests/fixtures/README.txt)
  // via a scoring tie broken by archetype priority. Every REQUIRED stemmer
  // pair this pass was asked to prove has an overhang (the longer stem's
  // extra length beyond the shorter one) of at most 2 characters -
  // liais/liaison (+2), liais/liaising (+2 after its own -ing strip),
  // valid/validat (+2), escal/escalat (+2); "financ"/"financial" overhangs
  // by 3. Capping the allowed overhang at 2 keeps every required pair
  // matching (verified directly, not assumed) while excluding this one -
  // not a special case for "finance" specifically, a general rule that
  // happens to exclude it.
  var MAX_PREFIX_OVERHANG = 2;

  // Hand-rolled, deterministic, single-pass (the FIRST matching suffix
  // wins - not applied repeatedly) suffix stripper, per Derin's own list:
  // -ing, -ed, -es, -s, -ion, -ation, -ise/-ize, trailing -e. Checked in an
  // order that gives correct results rather than his list's literal order
  // (documented per-branch below) - "-ation" must be tried before "-ion"
  // (an "-ation" word also ends in "-ion"; checking the shorter suffix
  // first would under-strip it and silently break the very
  // validate/validation/validating pairing this stemmer exists to fix).
  // Every branch requires at least 3 characters left after stripping, so
  // "-ing"/"-ed"/etc never reduce a short/irregular word (e.g. "king",
  // "bed") down to nothing meaningful.
  //
  // Words of 3 characters or fewer are returned unstemmed outright - the
  // same floor js/matcher.js already applies everywhere else in this file
  // (data.matchRule._trap: a term this short must stay exact, not fuzzed).
  function stem(word) {
    var w = String(word == null ? "" : word).toLowerCase();
    if (w.length <= 3) return w;
    // "-ation" before "-ion": documentation -> document (strips all 5 of
    // "ation", not just "ion"'s 3) - checked first so a longer, more
    // specific suffix isn't shadowed by a shorter one that's also a valid
    // (but wrong) match.
    if (/ation$/.test(w) && w.length - 5 >= 3) return w.slice(0, -5);
    if (/ing$/.test(w) && w.length - 3 >= 3) return w.slice(0, -3);
    if (/ion$/.test(w) && w.length - 3 >= 3) return w.slice(0, -3);
    if (/ed$/.test(w) && w.length - 2 >= 3) return w.slice(0, -2);
    if (/es$/.test(w) && w.length - 2 >= 3) return w.slice(0, -2);
    // Trailing "-s", but NOT a double "-ss" ("process", "access") - the
    // false-friend case this app has hit before (see js/matcher.js's own
    // file-header "aca"/"academic" story): blindly stripping a trailing s
    // off "process" would give "proces", one edit away from colliding with
    // unrelated short words. /[^s]s$/ requires the character before the
    // final "s" not itself be "s".
    if (/[^s]s$/.test(w) && w.length - 1 >= 3) return w.slice(0, -1);
    // "-ize" normalised to the SAME root as "-ise" (organise/organize
    // should be one stem, not two that differ only in their final letter) -
    // this is the one case in Derin's list that isn't just "strip a
    // suffix": it also rewrites "z" to "s" so the British and American
    // spellings converge, which plain trailing-e stripping alone (below)
    // would not do (it would leave "organis" vs "organiz" - still unequal).
    if (/ize$/.test(w) && w.length - 3 >= 3) return w.slice(0, -3) + "is";
    if (/e$/.test(w) && w.length - 1 >= 3) return w.slice(0, -1);
    return w;
  }

  // Two stems "overlap" (count as the same word for tag-matching purposes)
  // when they're identical, or - only once both are long enough to be safe,
  // see MIN_PREFIX_STEM_LEN above - one is a prefix of the other. The
  // prefix half exists because this hand-rolled stemmer, by design, does
  // NOT force every inflection of a word to one identical root (see stem()
  // - "liaison" is left completely unstemmed, since it matches none of the
  // 7 listed suffixes) - it only needs to get close enough that a
  // prefix check bridges the rest, and does so safely below the length
  // floor.
  function stemsOverlap(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    var shorter = a.length <= b.length ? a : b;
    var longer = a.length <= b.length ? b : a;
    if (shorter.length < MIN_PREFIX_STEM_LEN) return false;
    if (longer.length - shorter.length > MAX_PREFIX_OVERHANG) return false;
    return longer.slice(0, shorter.length) === shorter;
  }

  // Splits normalized text into individual word tokens for stemming - a
  // deliberately simple tokenizer (not js/score.js's normalize(), which
  // matcher.js must not depend on - see this file's header on why
  // js/score.js depends on js/matcher.js and not the other way around).
  // Lowercases, keeps letters/digits/+/%  (mirrors js/score.js's own
  // normalize() punctuation policy so "2:1" and "power+" tokenize the same
  // way on both the tag side and the JD side), splits on everything else.
  function tokenize(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .split(/[^a-z0-9+%]+/)
      .filter(Boolean);
  }

  // A tag's own content words: tokenized, stopwords dropped, each stemmed.
  // Stopword removal only ever matters for a tag with a filler word in it
  // (none of the current closeMatch/evidence tags have one, but a future
  // one might read more naturally with one - "single point of contact"
  // already has "of"); it never changes a tag that's already all content
  // words.
  function tagContentStems(tag) {
    return tokenize(tag)
      .filter(function (w) { return !STOPWORDS[w]; })
      .map(stem);
  }

  // Does every content word of `tag` have a stem-overlapping word
  // somewhere in `text`? `text` is meant to be scoped to one sentence/span
  // by the caller (js/letterbuild.js's per-sentence ECHO/close-match scan,
  // js/score.js's per-JD keyword extraction) - this function itself has no
  // sentence awareness, it just tokenizes whatever string it's given.
  //
  // Numeric/symbol tags (anything containing a digit - "2:1", "2.1") are
  // deliberately EXCLUDED from stem-set matching and fall back to the old
  // literal phrase match instead (Matcher.test with word-boundary regex,
  // unchanged behaviour). Reason, a real false-friend this app hasn't hit
  // yet but would the moment stem-set matching went in unconditionally: a
  // JD sentence like "1-2 years' experience in a similar role" contains
  // both the standalone tokens "1" and "2" - which, under word-set
  // (order-independent) matching, would satisfy the two content words of
  // the "2:1" degree-classification tag despite being about something
  // completely unrelated. Digits carry no useful "inflection" for a
  // stemmer to bridge in the first place, so there is no recall benefit to
  // trade against that risk - literal phrase matching (already correct for
  // this one case) is kept for anything digit-bearing.
  // Small, self-contained mirror of js/score.js's own normalize() (lower-
  // case, strip everything but letters/digits/+/%, collapse whitespace) -
  // duplicated here rather than called from there, same layering reason as
  // tokenize()'s own comment. Used ONLY by the digit-guard branch below: a
  // literal phrase match needs BOTH sides normalized the SAME way, because
  // this function is fed either a raw JD sentence (from js/letterbuild.js)
  // or an ALREADY-normalized whole-JD blob (from js/score.js's
  // extractKeywordHits/scoreArchetype) depending on the caller, and a tag
  // like "2:1" would otherwise silently stop matching the moment its
  // colon-stripped counterpart in an already-normalized blob no longer has
  // a colon to compare against - the exact bug score.js's own header
  // already documents having hit once before with the old countHits path.
  function normalizeForPhrase(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^a-z0-9+%\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // A tag is normally a plain string. It MAY instead be an object
  // { term, alsoMatch } (27 Sept 2026, item 1c, Derin's own instruction,
  // verbatim: "A tag may also carry an optional alsoMatch list for genuine
  // synonyms that stems can't reach (e.g. 'data validation' also matches
  // 'error-checking')."). alsoMatch is a list of alternate phrases, each
  // matched the SAME way `term` itself would be (stem-set, or literal for
  // a digit-bearing alternate) - any ONE of them matching is enough to
  // satisfy the whole tag; this is a per-TAG alternative, not a per-word
  // one; there is no way for a stemmer alone to know "error-checking"
  // means the same thing as "data validation" - that is a content
  // judgement about genuine synonyms, which is why this is an explicit,
  // human-authored list on the tag itself rather than something inferred.
  // Infrastructure only - added ready to use, not retroactively applied
  // to any existing tag on Derin's own initiative (see the pass report:
  // no alsoMatch pairs have been invented here for the current closeMatch
  // tags, since which words are "genuine synonyms" is exactly the kind of
  // content judgement this project's standing rule reserves for Derin).
  function tagLabel(tag) {
    return (tag && typeof tag === "object") ? String(tag.term == null ? "" : tag.term) : String(tag == null ? "" : tag);
  }

  // Stems are worked out once per distinct string and reused. A rebuild
  // asks whether each of about 170 tags appears in the same few dozen ad
  // sentences, so without this every sentence was re-split and re-stemmed
  // once per tag - most of a rebuild's script time. The results are pure
  // functions of the string, so reusing them changes nothing; the caches are
  // emptied if they ever grow large (a long session of edits).
  var CACHE_LIMIT = 4000;
  var textStemsCache = new Map();
  var tagStemsCache = new Map();
  function cached(cache, key, compute) {
    var hit = cache.get(key);
    if (hit) return hit;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    hit = Object.freeze(compute(key));
    cache.set(key, hit);
    return hit;
  }
  function textStemsOf(text) {
    return cached(textStemsCache, String(text == null ? "" : text), function (t) { return tokenize(t).map(stem); });
  }

  function tagMatchesText(tag, text) {
    if (tag && typeof tag === "object") {
      if (tagMatchesText(tag.term, text)) return true;
      return (tag.alsoMatch || []).some(function (alt) { return tagMatchesText(alt, text); });
    }
    if (/\d/.test(String(tag))) {
      return test(normalizeForPhrase(text), normalizeForPhrase(tag));
    }
    var tagStems = cached(tagStemsCache, String(tag == null ? "" : tag), tagContentStems);
    if (!tagStems.length) return false;
    var textStems = textStemsOf(text);
    return tagStems.every(function (ts) {
      return textStems.some(function (xs) { return stemsOverlap(ts, xs); });
    });
  }

  // Every tag in `tags` that stem-set-matches `text` - the tag-matching
  // sibling of scanList() above (which does exact/stem-wildcard term
  // matching, unchanged, for neverClaim-style single-term lists).
  function scanTags(text, tags) {
    return (tags || []).filter(function (t) { return tagMatchesText(text, t); });
  }

  global.CVMatcher = {
    escapeRe: escapeRe,
    parseTerm: parseTerm,
    testRegex: testRegex,
    countRegex: countRegex,
    test: test,
    countHits: countHits,
    scanList: scanList,
    scanListJoined: scanListJoined,
    slotRe: slotRe,
    braceRe: braceRe,
    KNOWN_LETTER_SLOTS: KNOWN_LETTER_SLOTS,
    stem: stem,
    stemsOverlap: stemsOverlap,
    tagContentStems: tagContentStems,
    tagMatchesText: tagMatchesText,
    tagLabel: tagLabel,
    scanTags: scanTags
  };
})(typeof window !== "undefined" ? window : globalThis);
