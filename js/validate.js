// ---------------------------------------------------------------------------
// Validates the loaded data file's internal consistency BEFORE anything is
// built from it. Every check here is something that would otherwise fail
// silently, or fail loudly but only for whichever archetype happens to be
// selected first - same class of problem as the customer-ops crash: a bad
// reference (an include id with no matching fact, a bullet group id with no
// matching variants, a sectionOrder type the code doesn't handle) should
// surface at load time, in one place, not partway through a build the user
// triggered by clicking the wrong dropdown option.
//
// Returns an array of plain-string problem descriptions. Empty array means
// clean. The caller decides what "refuse to start" means in the UI - this
// module only finds problems, it never renders anything itself.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  if (!Matcher) {
    throw new Error("validate.js loaded before js/matcher.js. Check <script> order.");
  }
  var BlockHash = global.CVBlockHash;
  if (!BlockHash) {
    throw new Error("validate.js loaded before js/blockhash.js. Check <script> order.");
  }

  var VALID_SECTION_TYPES = ["profile", "skills", "experience", "project", "education", "certifications"];

  function validateData(data) {
    var errors = [];

    // --- fact id index: every id an archetype's `include` can legally name ---
    var factIds = {};
    (data.facts.education || []).forEach(function (e) { factIds[e.id] = true; });
    (data.facts.roles || []).forEach(function (r) { factIds[r.id] = true; });
    if (data.facts.project) factIds[data.facts.project.id] = true;
    (data.facts.projects || []).forEach(function (p) { factIds[p.id] = true; });
    (data.facts.certifications || []).forEach(function (c) { factIds[c.id] = true; });
    if (data.facts.volunteering) factIds[data.facts.volunteering.id] = true;

    (data.archetypes || []).forEach(function (a) {
      (a.include || []).forEach(function (id) {
        if (!factIds[id]) {
          errors.push("archetype '" + a.id + "': include references unknown fact id '" + id + "' - no education/role/project/certification/volunteering entry has this id.");
        }
      });
      (a.sectionOrder || []).forEach(function (so, i) {
        if (!so || typeof so !== "object" || !so.type || !so.heading) {
          errors.push("archetype '" + a.id + "': sectionOrder[" + i + "] is not a {type, heading} object - " + JSON.stringify(so));
          return;
        }
        if (VALID_SECTION_TYPES.indexOf(so.type) === -1) {
          errors.push("archetype '" + a.id + "': sectionOrder[" + i + "].type '" + so.type + "' is not one of " + VALID_SECTION_TYPES.join(", ") + " - assemble.js has no builder for it and would hard-fail if this archetype were ever selected.");
        }
      });
      (a.skillCategories || []).forEach(function (catKey) {
        if (!data.skillLines[catKey]) {
          errors.push("archetype '" + a.id + "': skillCategories references unknown category '" + catKey + "' - no such key in skillLines.");
        }
      });
      if (!data.profileVariants.some(function (p) { return (p.archetypes || []).indexOf(a.id) !== -1; })) {
        errors.push("archetype '" + a.id + "': no profileVariants entry lists this archetype - buildModel would throw the moment it were selected.");
      }
    });

    // --- letterBlocks.evidence: the three let-ev-tcs-* variants must map
    // every archetype, totally and without overlap (Derin, 19 Sept 2026,
    // verbatim: "Every archetype maps to exactly one of the three. No
    // default, no fallback"). Zero matches means js/letterbuild.js's
    // entriesForArchetype()+bestByTags() pick would silently fall through
    // to console/ai evidence with no TCS paragraph ever offered for that
    // archetype; more than one means two variants are both eligible and
    // the "exactly one" guarantee this rule exists for is already broken,
    // even though bestByTags would still resolve it to some single winner
    // by tag score - resolving a broken invariant silently is exactly the
    // kind of thing this project's checks exist to catch, not paper over.
    (function checkTcsEvidenceMapping() {
      var tcsVariants = (data.letterBlocks.evidence || []).filter(function (e) {
        return /^let-ev-tcs-/.test(e.id);
      });
      if (!tcsVariants.length) return; // nothing to check yet
      (data.archetypes || []).forEach(function (a) {
        var covering = tcsVariants.filter(function (v) { return (v.archetypes || []).indexOf(a.id) !== -1; });
        if (covering.length === 0) {
          errors.push("archetype '" + a.id + "': no let-ev-tcs-* evidence variant lists this archetype - " +
            "the TCS letter-evidence mapping must be total (Derin, 19 Sept 2026).");
        } else if (covering.length > 1) {
          errors.push("archetype '" + a.id + "': " + covering.length + " let-ev-tcs-* evidence variants " +
            "(" + covering.map(function (v) { return v.id; }).join(", ") + ") list this archetype - must be exactly one.");
        }
      });
    })();

    // --- bullet group ids named by roles/projects must exist in bulletVariants ---
    var bulletBearers = (data.facts.roles || []).slice();
    if (data.facts.project) bulletBearers.push(data.facts.project);
    (data.facts.projects || []).forEach(function (p) { bulletBearers.push(p); });
    bulletBearers.forEach(function (entry) {
      (entry.bullets || []).forEach(function (gid) {
        var group = data.bulletVariants[gid];
        if (!group || !group.variants || !group.variants.length) {
          errors.push("fact '" + entry.id + "': bullet group '" + gid + "' is missing or empty in bulletVariants.");
        }
      });
    });

    // --- education-ordering / degree-classification hard rule ---
    // Tightened 19 Sept 2026 (Derin's own six-decision spec, section 1) now
    // that BOTH degrees carry a classification (edu-msc "2:1 Honours",
    // edu-bms "First Class Honours"): the old looser regex (any of "first
    // class"/"second class"/"honours"/"distinction", checked separately from
    // a degree-name word) is replaced by his own literal rule, verbatim:
    // "the first sentence of every profileVariant must contain one of the
    // literal strings 'First Class Honours', '2:1 Honours', '2:2 Honours'.
    // Absent, the app refuses to start and names the variant." No separate
    // degree-name check - the literal string already implies which degree,
    // and a looser heuristic here is exactly the kind of soft mode Derin's
    // spec explicitly rules out elsewhere ("no default, no fallback, no soft
    // mode").
    //
    // One explicit, named exception: a profileVariant can carry its own
    // `_educationRuleExempt` (a non-empty string explaining why). This is
    // NOT a way to silently paper over a missed rule - it's how a real,
    // deliberate content decision (prof-retail: the retail/part-time
    // archetype leads with experience on purpose, Derin's explicit call,
    // 14 Sept 2026) gets recorded as a decision rather than left as an
    // unexplained gap the validator has to keep rediscovering. Adding this
    // field to a variant without discussing it with Derin first defeats
    // the point of the rule.
    var CLASSIFICATION_STRINGS = ["First Class Honours", "2:1 Honours", "2:2 Honours"];
    (data.profileVariants || []).forEach(function (p) {
      if (p._educationRuleExempt) return;
      var firstSentence = String(p.text || "").split(/\.\s|\.$/)[0] || "";
      var hasClassification = CLASSIFICATION_STRINGS.some(function (s) { return firstSentence.indexOf(s) !== -1; });
      if (!hasClassification) {
        errors.push(
          "profileVariants['" + p.id + "']: first sentence does not contain one of the literal strings " +
          "\"First Class Honours\", \"2:1 Honours\", \"2:2 Honours\" (Derin's own hard rule, 19 Sept 2026, not a " +
          "preference; add an _educationRuleExempt string if this is meant to be a deliberate exception) - " +
          "first sentence is: \"" + firstSentence + ".\""
        );
      }
    });

    // --- Action-verb-first gate (26 Sept 2026, item 2a, Derin's own
    // instruction, verbatim: "Action verbs first. The profile and every
    // bullet start with an action verb wherever logical... Add a gate:
    // the first word of the profile and of every bullet must be on an
    // approved action-verb list, or the build fails. A mid-sentence
    // phrase like 'on my manager's recommendation' is fine." This
    // REPLACES the old "let one bullet open on a noun" allowance
    // (b-blarney-drive was the one variant built for it, and is now
    // rewritten to open on a verb rather than carrying an exemption -
    // Derin's instruction names no exception, only a gate that applies
    // everywhere). Checked against data.actionVerbs.list, case-
    // insensitively, first word only - everything after the first word
    // is untouched by this rule, exactly as the "on my manager's
    // recommendation" example says. `.short` is checked exactly like
    // `.text`: a shortened bullet is still a bullet a reader sees, and
    // js/trim.js's shorten step can swap either one in at build time.
    function firstWordOf(text) {
      var m = /^[A-Za-z']+/.exec(String(text || ""));
      return m ? m[0].toLowerCase() : null;
    }
    (function checkActionVerbFirst() {
      var list = (data.actionVerbs && data.actionVerbs.list) || [];
      if (!list.length) {
        errors.push("data.actionVerbs.list is missing or empty - the action-verb-first gate (Derin, 26 Sept 2026) " +
          "has nothing to check against. Every profile and bullet opener would fail this gate with no way to pass it.");
        return;
      }
      var allowed = {};
      list.forEach(function (v) { allowed[String(v).toLowerCase()] = true; });
      function checkOpener(text, label) {
        if (!text) return;
        var fw = firstWordOf(text);
        if (!fw || !allowed[fw]) {
          errors.push(label + ": first word is " + JSON.stringify(fw ? fw : String(text).slice(0, 20)) +
            ", not on data.actionVerbs.list - every profile and bullet must open on an approved action verb " +
            "(Derin's own gate, 26 Sept 2026; a mid-sentence phrase after the first word is unaffected). " +
            "Add the verb to data.actionVerbs.list if it's genuinely a new opener, or rewrite the opening word.");
        }
      }
      Object.keys(data.bulletVariants || {}).forEach(function (gid) {
        (data.bulletVariants[gid].variants || []).forEach(function (v) {
          checkOpener(v.text, "bulletVariants['" + gid + "'].variants['" + v.id + "'].text");
          checkOpener(v.short, "bulletVariants['" + gid + "'].variants['" + v.id + "'].short");
        });
      });
      (data.profileVariants || []).forEach(function (p) {
        checkOpener(p.text, "profileVariants['" + p.id + "'].text");
        checkOpener(p.short, "profileVariants['" + p.id + "'].short");
      });
    })();

    // --- matchRule stemming trap: a stem on a short term is a known way to
    // reintroduce the exact bug the stem/exact split exists to prevent (see
    // data.matchRule._trap). Flag any stemmed term under 6 characters so
    // whoever edits neverClaim/knownAbsentTools next sees this before it
    // ships, not after it false-positives.
    function checkStemLengths(list, label) {
      (list || []).forEach(function (term) {
        var t = String(term);
        if (/\*$/.test(t) && t.length - 1 < 6) {
          errors.push(label + ": '" + t + "' is stemmed (trailing *) but under 6 characters - data.matchRule._trap warns this can reintroduce the exact boundary bug stemming exists to prevent. Test it against real ad text before shipping, or drop the *.");
        }
      });
    }
    checkStemLengths(data.neverClaim, "neverClaim");
    checkStemLengths((data.knownAbsentTools && data.knownAbsentTools.tools) || [], "knownAbsentTools.tools");

    // --- Fix 2 (18-19 Sept 2026, Derin's own instruction, in response to a
    // real ECHO false-hit traced to single-word tags like "legacy" and
    // "requirements" matching ordinary company prose that had nothing to
    // do with the claim): every tag must be at least two words, with one
    // exception - an all-caps acronym of 2 to 6 characters (OMNI, GDPR,
    // SLA...). Deliberately mechanical - "needs no word list and no
    // frequency data" (Derin's own words) - checked purely by whitespace
    // and a fixed regex, not by any judgement about whether a given word
    // "feels" specific enough. No warnings, no soft mode - a violation here
    // stops the app from starting, same severity as a missing basis or a
    // stale heightPx.
    //
    // SCOPE NOTE (20 Sept 2026, deliberately NOT extended, flagged instead
    // of guessed): this check still runs only over skillLines/bulletVariants/
    // profileVariants tags, as it always has. js/score.js's allKnownTags()
    // was just fixed to also read letterBlocks tags (see that file's own
    // comment - a plumbing completeness bug, unrelated to this rule), which
    // means the ORIGINAL claim this comment used to make here ("scoped to
    // exactly the three tag sources allKnownTags() reads") is no longer
    // true - allKnownTags now reads four. letterBlocks.evidence currently
    // carries nine single-word tags that would fail this exact rule if it
    // applied to them (console: dashboard/reporting/visualisation/decision;
    // ai: ai/automation/tooling; pilot/control/improve/shift: accuracy,
    // migration, controls, automation again, plus "ai" itself) - the same
    // shape of risk this rule was written to catch (a generic single word
    // false-hitting unrelated JD boilerplate: "decision" or "controls" are
    // exactly that kind of word). NOT rewritten here: picking new two-word
    // phrasings for nine tags across five evidence entries is a content
    // judgement call, not a mechanical fix, and widening what this
    // validator enforces is a rule-severity change - both are Derin's call,
    // not mine to make silently. Flagged in the pass report; left as-is
    // until he decides.
    var ACRONYM_RE = /^[A-Z]{2,6}$/;
    function checkTagWord(tag, label) {
      var t = String(tag);
      if (/\s/.test(t.trim())) return; // two or more words - fine
      if (ACRONYM_RE.test(t)) return; // all-caps 2-6 char acronym - exempt
      errors.push(label + ": tag '" + t + "' is a single word and not a 2-6 character all-caps acronym - " +
        "widen it to a two-word phrase or delete it (data.matchRule's own two-word tag rule, added after a " +
        "single-word tag matched unrelated boilerplate prose in a real job ad).");
    }
    Object.keys(data.skillLines || {}).forEach(function (catKey) {
      (data.skillLines[catKey].terms || []).forEach(function (term) {
        (term.tags || []).forEach(function (tag) {
          checkTagWord(tag, "skillLines['" + catKey + "'] term '" + term.text + "'");
        });
      });
    });
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v) {
        (v.tags || []).forEach(function (tag) {
          checkTagWord(tag, "bulletVariants['" + gid + "'].variants['" + v.id + "']");
        });
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      (p.tags || []).forEach(function (tag) {
        checkTagWord(tag, "profileVariants['" + p.id + "']");
      });
    });

    // --- basis validation (19 Sept 2026, Derin's "A-E" spec, part A): every
    // bulletVariants GROUP and every profileVariant must carry a
    // `basis: {strength, why}` object - the field js/trim.js's shorten-then-
    // drop ladder actually reads, now that the old numeric `priority` field
    // is gone entirely (see data.trimPolicy.basisRule's 19-Sept status
    // update: "this is now mechanically enforced, not just recorded
    // policy"). `why` is display-only and never parsed by any code path,
    // but a stub string would defeat the entire point of stating one - the
    // 20-character floor is a cheap, mechanical proxy for "actually says
    // something," same spirit as the tag-word-count rule above.
    var VALID_STRENGTHS = ["required", "core", "support", "filler"];
    function checkBasis(basis, label) {
      if (!basis || typeof basis !== "object") {
        errors.push(label + ": missing `basis` object - every bulletVariants group and profileVariant must state " +
          "{strength, why} (Derin's own basisRule, mechanically enforced since 19 Sept 2026 - see data.trimPolicy).");
        return;
      }
      if (VALID_STRENGTHS.indexOf(basis.strength) === -1) {
        errors.push(label + ": basis.strength is " + JSON.stringify(basis.strength) + ", must be one of " + VALID_STRENGTHS.join("/") + ".");
      }
      if (typeof basis.why !== "string" || basis.why.length < 20) {
        errors.push(label + ": basis.why must be a string of at least 20 characters (display-only, but a stub defeats the point of stating one) - got " + JSON.stringify(basis.why) + ".");
      }
    }
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      checkBasis(data.bulletVariants[gid].basis, "bulletVariants['" + gid + "']");
    });
    (data.profileVariants || []).forEach(function (p) {
      checkBasis(p.basis, "profileVariants['" + p.id + "']");
    });

    // --- factGuards (19 Sept 2026, Derin's "A-E" spec, part D): a figure
    // that is only true in a narrow scope (today: "99%", true only for the
    // US life insurer pilot-team figure, never a whole-year claim) must
    // carry that scope every time it appears, and must never sit next to
    // wording that implies a broader one. Generalised, not a one-off fix -
    // "Any future figure that is only true in a narrow scope gets one"
    // (Derin's own instruction). Checked against every hand-authored,
    // user-facing string in the file: bulletVariants, profileVariants,
    // skillLines AND letterBlocks - "The letter blocks and skill lines have
    // the same two violations. The profiles are not the only hand-authored
    // prose" (part E1). A hard load-time failure, same severity as every
    // other check in this file - no default, no fallback, no soft mode.
    function collectApprovedStrings(d) {
      var strings = [];
      function add(text, path) { if (text) strings.push({ text: String(text), path: path }); }
      Object.keys(d.bulletVariants || {}).forEach(function (gid) {
        (d.bulletVariants[gid].variants || []).forEach(function (v) {
          add(v.text, "bulletVariants['" + gid + "'].variants['" + v.id + "'].text");
          add(v.short, "bulletVariants['" + gid + "'].variants['" + v.id + "'].short");
        });
      });
      (d.profileVariants || []).forEach(function (p) {
        add(p.text, "profileVariants['" + p.id + "'].text");
        add(p.short, "profileVariants['" + p.id + "'].short");
      });
      Object.keys(d.skillLines || {}).forEach(function (catKey) {
        (d.skillLines[catKey].terms || []).forEach(function (term, i) {
          add(term.text, "skillLines['" + catKey + "'].terms[" + i + "].text");
        });
      });
      Object.keys(d.letterBlocks || {}).forEach(function (category) {
        var entries = d.letterBlocks[category];
        if (!Array.isArray(entries)) return; // e.g. letterBlocks._rules, a plain string
        entries.forEach(function (b) {
          add(b.text, "letterBlocks['" + category + "']['" + b.id + "'].text");
          // noEchoText (19 Sept 2026, evidence category only so far): the
          // sibling text used whenever no ECHO quote survives selection -
          // just as capable of carrying a mis-scoped figure as the primary
          // text, so it gets the same factGuards sweep, not a pass.
          add(b.noEchoText, "letterBlocks['" + category + "']['" + b.id + "'].noEchoText");
        });
      });
      // formAnswers (26 Sept 2026, item 5): tcsRoleDescription and
      // subjectsStudiedRelevance are newly hand-authored prose carrying real
      // figures (the 99% accuracy figure, dates) same as any letterBlocks
      // entry - factGuards applies to them exactly the same way. careerBreak
      // ("No.") and rightToWorkSponsorship carry no guarded figures but are
      // swept too for uniformity/future-proofing, at zero cost.
      Object.keys(d.formAnswers || {}).forEach(function (key) {
        var entry = d.formAnswers[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return; // e.g. formAnswers._why, a plain string
        add(entry.answer, "formAnswers['" + key + "'].answer");
      });
      return strings;
    }
    var approvedStrings = collectApprovedStrings(data);
    (data.factGuards || []).forEach(function (guard) {
      if (!guard.figure) return;
      var required = guard.requiredNear || [];
      var forbidden = guard.forbiddenNear || [];
      approvedStrings.forEach(function (s) {
        if (s.text.indexOf(guard.figure) === -1) return;
        if (required.length && !required.some(function (w) { return s.text.indexOf(w) !== -1; })) {
          errors.push(s.path + ": SCOPE CHECK failed - contains figure '" + guard.figure + "' but none of its required " +
            "scope phrases (" + required.join(" / ") + "). String: \"" + s.text + "\"");
        }
        forbidden.forEach(function (w) {
          if (s.text.indexOf(w) !== -1) {
            errors.push(s.path + ": ATTRIBUTION CHECK failed - contains figure '" + guard.figure + "' alongside forbidden " +
              "wording '" + w + "', which implies a broader scope than the figure actually has. String: \"" + s.text + "\"");
          }
        });
      });
    });

    // --- short-is-subset-of-full (20 Sept 2026, Derin's own instruction,
    // made permanent after this exact pass caught two of his own supplied
    // shorts mashing up content from a SIBLING variant instead of their own
    // full text): "every `.short` must be a strict content subset of its
    // full text... Mechanically, check that every digit sequence and every
    // capitalised token in the short also appears in the full."
    //
    // HONEST LIMITATION, stated up front rather than implied by a clean
    // pass: this is exactly Derin's own mechanical rule, no more. It catches
    // a short asserting a NEW number or a NEW proper noun/acronym that the
    // full text never mentions - the shape of failure his rule targets. It
    // would NOT have caught this pass's other rejected short
    // (b-blarney-hospitality's proposed text, which asserted "shifts" and
    // "full-time study" - ordinary lowercase words, no digits, no proper
    // nouns - content that belongs to a sibling bullet). That rejection was
    // caught by hand, reading the full text, not by this check - and
    // tests/golden/run-golden-tests.mjs proves this limitation is real
    // (runs this exact rejected short back through this function and
    // confirms it passes clean), rather than asserting it only in this
    // comment. A stronger check would need to compare MEANING, not just
    // proper-noun/number tokens - out of scope for "needs no word list and
    // no frequency data" mechanical validation.
    //
    // Sentence-initial capitals (the first word of a sentence - "Rotated",
    // "No", "Wrote", "I"...) are deliberately excluded from what a short
    // must justify: those are capitalised by ordinary English grammar, not
    // because the word is a proper noun/acronym claim. A word only has to
    // appear in the full text if it is capitalised somewhere NOT at a
    // sentence boundary in the short (nonInitialCapWords) - checked against
    // every capitalised occurrence anywhere in the full text (allCapWords),
    // sentence-initial or not, since what matters on the full side is
    // simply whether the word appears there at all.
    function allCapWords(text) {
      var words = {};
      var re = /[A-Z][A-Za-z']*/g, m;
      while ((m = re.exec(String(text)))) words[m[0]] = true;
      return words;
    }
    function nonInitialCapWords(text) {
      var s = String(text);
      var words = {};
      var re = /[A-Z][A-Za-z']*/g, m;
      while ((m = re.exec(s))) {
        var before = s.slice(0, m.index);
        if (!/(^\s*|[.!?]\s+)$/.test(before)) words[m[0]] = true;
      }
      return words;
    }
    function digitSequences(text) {
      var seqs = {};
      var re = /\d+/g, m;
      while ((m = re.exec(String(text)))) seqs[m[0]] = true;
      return seqs;
    }
    function checkShortIsSubset(fullText, shortText, label) {
      if (!fullText || !shortText) return;
      var shortDigits = digitSequences(shortText);
      var fullDigits = digitSequences(fullText);
      Object.keys(shortDigits).forEach(function (d) {
        if (!fullDigits[d]) {
          errors.push(label + ": .short contains figure '" + d + "' that its own full text does not - " +
            "a short must never assert a number absent from the full (Derin's short-subset rule, 20 Sept 2026). " +
            "short: \"" + shortText + "\"");
        }
      });
      var shortCaps = nonInitialCapWords(shortText);
      var fullCaps = allCapWords(fullText);
      Object.keys(shortCaps).forEach(function (w) {
        if (!fullCaps[w]) {
          errors.push(label + ": .short contains capitalised term '" + w + "' that its own full text does not - " +
            "a short must never assert a name/proper-noun/acronym absent from the full (Derin's short-subset rule, " +
            "20 Sept 2026). short: \"" + shortText + "\"");
        }
      });
    }
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v) {
        checkShortIsSubset(v.text, v.short, "bulletVariants['" + gid + "'].variants['" + v.id + "']");
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      checkShortIsSubset(p.text, p.short, "profileVariants['" + p.id + "']");
    });
    Object.keys(data.letterBlocks || {}).forEach(function (category) {
      var entries = data.letterBlocks[category];
      if (!Array.isArray(entries)) return;
      entries.forEach(function (b) {
        checkShortIsSubset(b.text, b.short, "letterBlocks['" + category + "']['" + b.id + "']");
      });
    });

    // --- facts.roles[].employment shape (Phase 6 addendum, 14 Sept 2026):
    // js/experience.js computes years-of-experience figures from these at
    // scan time, so a malformed date here doesn't fail loudly where it
    // happens (Date parsing failure deep inside a fit-check run) but where
    // it's easy to fix - on load, same reasoning as every other check in
    // this file. A role simply omitting `employment` is fine (see
    // experience.js's own comment on that) - only a PRESENT-but-malformed
    // one is an error.
    var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    (data.facts.roles || []).forEach(function (role) {
      var emp = role.employment;
      if (!emp) return;
      if (!ISO_DATE.test(emp.startDate) || !ISO_DATE.test(emp.endDate)) {
        errors.push("facts.roles['" + role.id + "'].employment: startDate/endDate must be 'YYYY-MM-DD' strings - got startDate=" + JSON.stringify(emp.startDate) + ", endDate=" + JSON.stringify(emp.endDate) + ".");
      } else if (emp.endDate < emp.startDate) {
        errors.push("facts.roles['" + role.id + "'].employment: endDate (" + emp.endDate + ") is before startDate (" + emp.startDate + ").");
      }
      if (typeof emp.fullTime !== "boolean") {
        errors.push("facts.roles['" + role.id + "'].employment.fullTime must be a boolean, got " + JSON.stringify(emp.fullTime) + ".");
      }
      if (typeof emp.countsAsRelevant !== "boolean") {
        errors.push("facts.roles['" + role.id + "'].employment.countsAsRelevant must be a boolean, got " + JSON.stringify(emp.countsAsRelevant) + ".");
      }
    });

    // --- data.warnings[].severityByWording shape (w-qualification
    // escalation, 14 Sept 2026): a malformed hedgePattern or a missing
    // unhedged/hedgedSeverity would otherwise fail deep inside a fit-check
    // run against whatever JD the user happened to paste first, not at
    // load time where it's obvious which entry is broken.
    var VALID_SEVERITIES = ["block", "warn", "info"];
    (data.warnings || []).forEach(function (w) {
      var rule = w.severityByWording;
      if (!rule) return;
      if (typeof rule.hedgePattern !== "string" || !rule.hedgePattern) {
        errors.push("data.warnings['" + w.id + "'].severityByWording.hedgePattern must be a non-empty regex string.");
      }
      if (VALID_SEVERITIES.indexOf(rule.unhedgedSeverity) === -1) {
        errors.push("data.warnings['" + w.id + "'].severityByWording.unhedgedSeverity must be one of " + VALID_SEVERITIES.join("/") + ", got " + JSON.stringify(rule.unhedgedSeverity) + ".");
      }
      if (VALID_SEVERITIES.indexOf(rule.hedgedSeverity) === -1) {
        errors.push("data.warnings['" + w.id + "'].severityByWording.hedgedSeverity must be one of " + VALID_SEVERITIES.join("/") + ", got " + JSON.stringify(rule.hedgedSeverity) + ".");
      }
      if (rule.heldOrInProgress && !Array.isArray(rule.heldOrInProgress)) {
        errors.push("data.warnings['" + w.id + "'].severityByWording.heldOrInProgress must be an array of regex strings.");
      }
    });

    // --- data.warnings[].outcomeLog shape (second review pass, 14 Sept
    // 2026): the log may only ever prompt, never adjust severity itself -
    // see the file-level _README constraint - but a malformed entry should
    // still fail loudly at load time rather than silently rendering a
    // wrong or missing outcome-log note. VALID_OUTCOMES matches the
    // schema documented in each warning's own _outcomeLogSchema.
    var VALID_OUTCOMES = ["rejected", "no response", "screened", "interviewed", "offer"];
    (data.warnings || []).forEach(function (w) {
      (w.outcomeLog || []).forEach(function (entry, i) {
        var where = "data.warnings['" + w.id + "'].outcomeLog[" + i + "]";
        if (!entry.date || !entry.company || !entry.role) {
          errors.push(where + " is missing date/company/role - an outcomeLog entry is meaningless without a referent.");
        }
        if (!entry.dataVersion) {
          errors.push(where + ".dataVersion is required - without it a later reader cannot tell which data-file version produced the CV this outcome is about.");
        }
        if (VALID_OUTCOMES.indexOf(entry.outcome) === -1) {
          errors.push(where + ".outcome must be one of " + VALID_OUTCOMES.join("/") + ", got " + JSON.stringify(entry.outcome) + ".");
        }
        if (!entry.bearsOn) {
          errors.push(where + ".bearsOn is required - which rule this entry is evidence for or against.");
        }
      });
    });

    // --- style.letterPage shape (third review pass, 14 Sept 2026): data
    // only today, not read by any renderer yet (Phase 7 doesn't exist),
    // but if it's present it should at least be shaped correctly so a
    // future Phase 7 doesn't inherit a silently-broken geometry block.
    // Absence is fine - it's optional until Phase 7 needs it.
    if (data.style && data.style.letterPage) {
      var lp = data.style.letterPage;
      ["widthTwips", "heightTwips", "textWidthTwips", "usableHeightTwips"].forEach(function (k) {
        if (typeof lp[k] !== "number" || lp[k] <= 0) {
          errors.push("data.style.letterPage." + k + " must be a positive number, got " + JSON.stringify(lp[k]) + ".");
        }
      });
      if (!lp.margin || ["top", "right", "bottom", "left"].some(function (k) { return typeof lp.margin[k] !== "number"; })) {
        errors.push("data.style.letterPage.margin must have numeric top/right/bottom/left.");
      }
    }

    // --- heightPx presence/freshness (third review pass, 17 Sept 2026;
    // rewritten 27 Sept 2026, item 6 - "stop stamping dataVersion... store
    // a hash of each block's text plus the style values it depends on"):
    // js/pagefit.js sums pre-measured block heights instead of measuring a
    // live DOM mirror, so every includable block must carry a heightPx
    // measured against ITS OWN CURRENT text and style dependencies - a
    // stale or missing one is exactly the silent-wrong-answer failure mode
    // the old browser-measurement approach was replaced to eliminate (see
    // pagefit.js's own header). This check makes _blockHeightMeta._readme's
    // claim ("validate.js refuses to build if it doesn't match") actually
    // true, rather than just documented. js/pagefit.js ALSO throws at
    // measure time if it hits a stale/missing height - this check exists so
    // the problem surfaces at load time, for every block, in one place,
    // instead of one at a time, mid-build, only for whichever archetype
    // happens to be selected first (same reasoning as every other check in
    // this file).
    //
    // Old behaviour compared node.dataVersion to data._version - a single
    // file-wide stamp, so ANY version bump invalidated every one of the
    // ~60 measured blocks at once, whether or not that block's own text or
    // style dependencies had actually changed (see js/blockhash.js's own
    // header for the full story - this is the "forgotten re-stamp" pain
    // point item 6 exists to close). Now each block carries a `hash` of
    // exactly the inputs that can actually change its measured height
    // (see CVBlockHash.blockHash) - a version bump for an unrelated reason
    // leaves every hash unchanged and needs no remeasurement at all.
    //
    // `spec` names the block's own text and style dependencies - see each
    // call site below for how it's derived per block type. This is
    // deliberately duplicated (not shared as one target list) against
    // tests/golden/measure-blocks.js's own collectTargets() - see that
    // file's own header note on this same duplication and why: one is a
    // slow, real-LibreOffice measuring+writing pass, the other a fast,
    // load-time read-only check, and forcing them through one shared
    // enumeration would only add a cross-dependency neither actually
    // needs, the same reasoning js/matcher.js's header already gives for
    // tokenize()/normalize()'s own, similar duplication.
    var META = data._blockHeightMeta;
    function checkHeight(h, subKey, label, spec) {
      var node = subKey ? (h && h[subKey]) : h;
      if (!node) {
        errors.push(label + ": missing heightPx" + (subKey ? "." + subKey : "") + " - run `node tests/golden/measure-blocks.js --apply`, then re-check.");
        return;
      }
      if (typeof node.cv !== "number" && typeof node.letter !== "number") {
        errors.push(label + ": heightPx" + (subKey ? "." + subKey : "") + " has neither a numeric .cv nor .letter value - " + JSON.stringify(node));
        return;
      }
      if (!META) return; // the missing-_blockHeightMeta error is raised separately, below - nothing to hash against yet
      var expected = BlockHash.blockHash(data, META, spec);
      if (node.hash !== expected) {
        errors.push(label + ": heightPx" + (subKey ? "." + subKey : "") + " is stale - its stored hash ('" + node.hash +
          "') doesn't match its current text/style fingerprint ('" + expected + "'). Its own text, or one of the style " +
          "values it depends on (font size, page text width, line-advance for its role" + (spec.isBullet ? ", bullet indent/hanging" : "") +
          "), changed since this was measured. Re-run `node tests/golden/measure-blocks.js --apply` to remeasure it.");
      }
    }

    if (!data._blockHeightMeta) {
      errors.push("data._blockHeightMeta is missing entirely - js/pagefit.js cannot compute identity/heading heights or run the wrap-simulator without it. This is a small, fixed set of numbers (see tests/golden/measure-blocks.js's own header for the measurement method, and identity/headings for why this script doesn't compute them automatically) - measure by hand and restore it.");
    } else {
      // Same item-6 rewrite as checkHeight above, applied to this bundle's
      // own single freshness stamp: lineAdvancePx/charWidths are
      // empirically-calibrated style constants (font + size + page
      // geometry -> real px-per-line/per-glyph, not derivable by formula -
      // see this object's own _readme), so there's no "expected value" to
      // recompute and compare the way checkHeight does for a block's
      // height. What CAN be recomputed is whether the style inputs these
      // constants were calibrated against are still the current ones -
      // BlockHash.styleHash(data) fingerprints exactly that (font, every
      // role's size, both pages' text widths, bullet geometry). Was
      // data._blockHeightMeta.dataVersion (compared to data._version) -
      // same "any unrelated version bump invalidates this" problem as
      // every per-block heightPx used to have, fixed the same way.
      if (META.styleHash !== BlockHash.styleHash(data)) {
        errors.push("data._blockHeightMeta.styleHash does not match the data file's current style values (font/sizes/page widths/bullet geometry) - stale. Re-run `node tests/golden/measure-blocks.js --apply`.");
      }
      ["name", "contact", "rightToWork"].forEach(function (k) {
        if (typeof (META.identity && META.identity[k]) !== "number") {
          errors.push("data._blockHeightMeta.identity['" + k + "'] must be a measured number.");
        }
      });
      ["name", "contact", "rightToWork", "heading", "body", "small", "letterBody"].forEach(function (k) {
        if (typeof (META.lineAdvancePx && META.lineAdvancePx[k]) !== "number") {
          errors.push("data._blockHeightMeta.lineAdvancePx['" + k + "'] must be a measured number - js/pagefit.js's skillLine wrap-simulator and one-line allowance both depend on it.");
        }
      });
      ["body", "letterBody"].forEach(function (sizeKey) {
        var cw = META.charWidths && META.charWidths[sizeKey];
        if (!cw || typeof cw["m"] !== "number" || typeof cw[" "] !== "number") {
          errors.push("data._blockHeightMeta.charWidths['" + sizeKey + "'] must be a measured advance-width table with at least 'm' and ' ' entries - js/textwrap.js's wrap-simulator depends on it.");
        }
      });
      // Every heading string any archetype actually prints must have a
      // measured height - a new section heading added without measuring it
      // would otherwise only surface as a runtime throw deep inside
      // pagefit.js, the first time that archetype gets built.
      // tests/golden/measure-blocks.js does NOT compute this one - headings
      // are a small, effectively-fixed set of strings (see that script's
      // own header for why they're out of scope) - measure it by hand with
      // the same render-and-measure method and add the number here.
      var seenHeadings = {};
      (data.archetypes || []).forEach(function (a) {
        (a.sectionOrder || []).forEach(function (so) {
          if (!so || !so.heading || seenHeadings[so.heading]) return;
          seenHeadings[so.heading] = true;
          if (typeof (META.headings && META.headings[so.heading]) !== "number") {
            errors.push("data._blockHeightMeta.headings['" + so.heading + "'] is missing - archetype '" + a.id +
              "' prints this heading but no height was ever measured for it (tests/golden/measure-blocks.js does not " +
              "cover headings - see its own header; measure by hand with the same method and add it here).");
          }
        });
      });
    }

    // A variant/profile that HAS a `.short` string must also have a
    // measured, current `.shortHeightPx` - otherwise js/trim.js's shorten
    // step would pick it as a candidate (it only checks for `.short`
    // existing - see trim.js's canShorten()) and js/pagefit.js would throw
    // mid-trim, deep inside a build, the first time that specific block
    // happened to get shortened. Same "surface at load time, not mid-use"
    // reasoning as checkHeight itself. A block with NO `.short` at all is
    // fine either way - see js/validate.js's own shortCoverageReport,
    // which is where a genuine coverage gap belongs (visible, non-blocking),
    // not here (this only catches a `.short` that was written without also
    // measuring it).
    // checkHeight already reads `h[subKey]` when a subKey is given, which is
    // exactly "treat the container as the flat node's owner" - reused as-is
    // here (container=the variant/profile itself, key="shortHeightPx") so
    // the existing function needs no change of its own.
    function checkHeightAt(container, key, label, spec) {
      var node = container && container[key];
      if (node == null) return;
      checkHeight(container, key, label, spec);
    }

    // Reconstructs the exact same hash text tests/golden/measure-blocks.js's
    // own roleAndDates() derives from a role/education/project entry - see
    // that function's own comment on `roleOrgOnTitleLine` (roles/education
    // print org on the title line; projects print it on the dates line
    // instead - assemble.js's own split, mirrored here and there on
    // purpose, not shared, for the same reason checkHeight's own header
    // gives for not sharing a target list between the two files).
    function roleHashText(entry, roleOrgOnTitleLine) {
      var titleOrg = roleOrgOnTitleLine ? (entry.org || null) : null;
      return [entry.title, titleOrg, (entry.right || entry.stack || null)]
        .map(function (x) { return x == null ? "" : String(x); }).join("\u0001");
    }
    function datesHashText(entry, roleOrgOnTitleLine) {
      return roleOrgOnTitleLine ? (entry.dates || "") : (entry.dates || entry.org || "");
    }

    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v) {
        var label = "bulletVariants['" + gid + "'].variants['" + v.id + "']";
        checkHeight(v.heightPx, null, label, { text: v.text, sizeKey: "body", docType: "cv", isBullet: true });
        if (typeof v.short === "string" && v.short.length) {
          checkHeightAt(v, "shortHeightPx", label + ".short", { text: v.short, sizeKey: "body", docType: "cv", isBullet: true });
        }
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      checkHeight(p.heightPx, null, "profileVariants['" + p.id + "']", { text: p.text, sizeKey: "body", docType: "cv", isBullet: false });
      if (typeof p.short === "string" && p.short.length) {
        checkHeightAt(p, "shortHeightPx", "profileVariants['" + p.id + "'].short", { text: p.short, sizeKey: "body", docType: "cv", isBullet: false });
      }
    });
    (data.facts.roles || []).forEach(function (r) {
      var label = "facts.roles['" + r.id + "']";
      checkHeight(r.heightPx, "role", label, { text: roleHashText(r, true), sizeKey: "body", docType: "cv", isBullet: false });
      checkHeight(r.heightPx, "dates", label, { text: datesHashText(r, true), sizeKey: "small", docType: "cv", isBullet: false });
    });
    var projectFacts = (data.facts.projects || []).slice();
    if (data.facts.project) projectFacts.push(data.facts.project);
    projectFacts.forEach(function (p) {
      var label = "facts.project(s)['" + p.id + "']";
      checkHeight(p.heightPx, "role", label, { text: roleHashText(p, false), sizeKey: "body", docType: "cv", isBullet: false });
      checkHeight(p.heightPx, "dates", label, { text: datesHashText(p, false), sizeKey: "small", docType: "cv", isBullet: false });
    });
    (data.facts.education || []).forEach(function (e) {
      var label = "facts.education['" + e.id + "']";
      checkHeight(e.heightPx, "role", label, { text: roleHashText(e, true), sizeKey: "body", docType: "cv", isBullet: false });
      checkHeight(e.heightPx, "dates", label, { text: datesHashText(e, true), sizeKey: "small", docType: "cv", isBullet: false });
      if (e.printModules && e.modules && e.modules.length) {
        checkHeight(e.heightPx, "modules", label, { text: "Modules: " + e.modules.join(", "), sizeKey: "small", docType: "cv", isBullet: false });
      }
    });
    (data.facts.certifications || []).forEach(function (c) {
      var label = "facts.certifications['" + c.id + "']";
      var itemsText = (c.items || []).map(function (it) { return it.display; }).join(data.style.separator);
      checkHeight(c.heightPx, "items", label, { text: itemsText, sizeKey: "body", docType: "cv", isBullet: false });
      checkHeight(c.heightPx, "body", label, { text: c.body, sizeKey: "small", docType: "cv", isBullet: false });
    });
    if (data.facts.volunteering) {
      checkHeight(data.facts.volunteering.heightPx, null, "facts.volunteering", { text: data.facts.volunteering.text, sizeKey: "small", docType: "cv", isBullet: false });
    }
    // letterBlocks: Phase 7 (cover letters) hasn't been built yet, so
    // nothing reads these at runtime today - but the heights were measured
    // now, alongside everything else, so they're checked now too rather
    // than waiting for Phase 7 to discover a gap. Entries with no text
    // (e.g. let-gap-none) were never measured on purpose - nothing to
    // measure - so they're skipped here, not flagged as missing. Measured
    // (and hashed) with {{SLOT}} template markers stripped - same
    // "measured with template slots empty" note already on every
    // letterBlocks heightPx.letter, see measure-blocks.js's stripSlots().
    Object.keys(data.letterBlocks || {}).forEach(function (category) {
      var entries = data.letterBlocks[category];
      if (!Array.isArray(entries)) return; // e.g. letterBlocks._rules, a plain string, not a block list
      entries.forEach(function (b) {
        if (!b.text) return;
        var baseline = String(b.text).replace(/\{\{[A-Z]+\}\}/g, "");
        checkHeight(b.heightPx, null, "letterBlocks['" + category + "']['" + b.id + "']", { text: baseline, sizeKey: "letterBody", docType: "letter", isBullet: false });
      });
    });
    // The sentences a letter adds after "Build anyway" on a RED ad: the
    // letter's page-fit check reads their heights like any letter
    // paragraph's, and cannot build the letter without one.
    ((data.hardRequirements && data.hardRequirements.gapBlocks) || []).forEach(function (b) {
      if (!b.text) return;
      var baseline = String(b.text).replace(/\{\{[A-Z]+\}\}/g, "");
      checkHeight(b.heightPx, null, "hardRequirements.gapBlocks['" + b.id + "']", { text: baseline, sizeKey: "letterBody", docType: "letter", isBullet: false });
    });

    // --- Template slot shape (25 Sept 2026, item 4: "the RECIPIENT_NAME
    // bug is a class, not an incident. Fix the class."). Scans every
    // letterBlocks text/noEchoText field for {{...}}-shaped tokens using
    // Matcher.braceRe() - which, unlike Matcher.slotRe(), matches a
    // MALFORMED token too (an underscore, a lowercase letter, a digit,
    // empty braces) - and fails the data file at author time, before a
    // single letter is ever built, on either of two distinct problems:
    // (1) the token isn't shaped like a slot at all (Matcher.slotRe()
    // itself would silently pass over it forever, at render time, exactly
    // the RECIPIENT_NAME bug); (2) it IS shaped like a slot but isn't one
    // this app actually fills anywhere (a typo - "{{ROLLE}}" - which today
    // would only surface as a thrown error the moment some archetype/
    // category combination happened to render that specific block, not
    // at load time for every block regardless of whether it's ever
    // exercised).
    (function checkTemplateSlotShapes() {
      function scanForSlots(text, path) {
        var m, re = Matcher.braceRe();
        while ((m = re.exec(text)) !== null) {
          var inner = m[1];
          if (!/^[A-Z]+$/.test(inner)) {
            errors.push(path + ": malformed template token '" + m[0] + "' - a slot name must be one or more " +
              "uppercase letters only (no underscore, digit, or lowercase) or the substitution code " +
              "will silently leave it unfilled in the rendered output, exactly like the RECIPIENT_NAME bug.");
          } else if (Matcher.KNOWN_LETTER_SLOTS.indexOf(inner) === -1) {
            errors.push(path + ": unknown template slot '" + m[0] + "' - not one of " +
              Matcher.KNOWN_LETTER_SLOTS.join(", ") + " (js/matcher.js's KNOWN_LETTER_SLOTS). Either this is a " +
              "typo, or a genuinely new slot that needs wiring into js/letterbuild.js's buildLetterModel, " +
              "js/letter.js's salutationBlock, or js/assemble.js's buildAuthLine, AND adding to " +
              "KNOWN_LETTER_SLOTS in the same change.");
          }
        }
      }
      Object.keys(data.letterBlocks || {}).forEach(function (category) {
        var entries = data.letterBlocks[category];
        if (!Array.isArray(entries)) return; // e.g. letterBlocks._rules, a plain string
        entries.forEach(function (b) {
          ["text", "noEchoText"].forEach(function (field) {
            var text = b[field];
            if (!text) return;
            scanForSlots(text, "letterBlocks['" + category + "']['" + b.id + "']." + field);
          });
        });
      });
      // data.identity.rightToWorkExtendedTemplate (26 Sept 2026, item 2b):
      // the one template slot that lives outside letterBlocks - same
      // author-time shape check, same reason (see js/assemble.js's
      // buildAuthLine and js/matcher.js's KNOWN_LETTER_SLOTS comment).
      if (data.identity && data.identity.rightToWorkExtendedTemplate) {
        scanForSlots(data.identity.rightToWorkExtendedTemplate, "identity.rightToWorkExtendedTemplate");
      }
    })();

    // --- Privacy pass (25 Sept 2026, Derin's own instruction, verbatim:
    // "nothing ships that is not already printed on a CV sent to a
    // stranger"). Fails the data file the moment any of the specific
    // patterns from that instruction reappear, so a future edit that
    // reintroduces one (a pasted note, a restored field, a careless
    // find-replace) is caught at load time rather than discovered after
    // the repo goes public. Runs against JSON.stringify(data) - the whole
    // file as text - rather than a hand-picked list of fields, on purpose:
    // a sensitive value could hide in a `_note`/`_why`/`_neverClaimNotes`
    // freeform comment as easily as in a structured field, and this check
    // exists to catch the SHAPE of the leak, not just the field it used to
    // live in.
    (function checkPrivacyPatterns() {
      var whole = JSON.stringify(data);

      if (Object.prototype.hasOwnProperty.call(data, "salary")) {
        errors.push("PRIVACY: top-level 'salary' key is present - salary bands must not ship in a published bundle (Derin, 25 Sept 2026).");
      }
      if (/"certNo"\s*:/.test(whole)) {
        errors.push("PRIVACY: a 'certNo' key is present somewhere in facts.certifications - certificate numbers must not ship in a published bundle.");
      }

      // Reference-number-shaped tokens. Each is deliberately narrow (a
      // real shape seen in this project's own data, not a bare "any
      // digits" catch-all that would drown in false positives against
      // dates, percentages, and heightPx values) - see the false-positive
      // check this pass ran against the live file before adopting these
      // exact patterns (build-status-and-decision-log.md, 25 Sept 2026).
      //
      // AUDITED 26 Sept 2026 (item 6, Derin's own instruction, verbatim:
      // "Confirm the check that blocks sensitive data matches by shape,
      // not by literal value... A validator that hardcodes the secrets
      // publishes them."). Every pattern below matches a PREFIX/PROXIMITY
      // SHAPE plus a digit-count floor - none of them contain a literal
      // secret value, so the validator's own source can be committed and
      // published without itself being the leak. Confirmed against the
      // four patterns that predate this audit (TCS/Word/digits, GNIB/IRP/
      // ISD+digits, Mon/YY/NNN, the salary-range digit pattern) - all four
      // were already shape-only. Two new patterns added for the two
      // additional shapes Derin named that this repo's data has never
      // contained (neither fires against the live file today - confirmed
      // by running this check against the clean file before and after
      // adding them; they exist to catch a FUTURE paste, not a present one):
      // an OREG-prefixed reference number, and a 7-digit number sitting
      // next to the word "Employee" in either order (an HR/payroll-style
      // employee-number field, distinct in shape from the TCS/Word/digits
      // pattern above, which requires the literal "TCS/" prefix).
      var shapedPatterns = [
        { re: /\bTCS\/[A-Za-z]+\/\d+\b/g, label: "a TCS employee/trainee reference number (TCS/Word/digits)" },
        { re: /\b(GNIB|IRP|ISD)[\s/-]?\d{4,}\b/gi, label: "an immigration reference number (GNIB/IRP/ISD + digits)" },
        { re: /\bOREG[\s/-]?\d{4,}\b/gi, label: "an OREG-prefixed reference number (OREG + digits)" },
        { re: /\b[A-Z][a-z]{2}\/\d{2}\/\d{2,}\b/g, label: "a certificate-number-shaped token (Mon/YY/NNN)" },
        { re: /\b\d{2,3},?\d{3}\s*-\s*\d{2,3},?\d{3}\b/g, label: "a salary-band-shaped number range" },
        { re: /\bEmployee\b[^\d]{0,30}\b\d{7}\b/gi, label: "an employee-number-shaped token (7-digit number within 30 characters of 'Employee')" },
        { re: /\b\d{7}\b[^\d]{0,30}\bEmployee\b/gi, label: "an employee-number-shaped token (7-digit number within 30 characters of 'Employee')" }
      ];
      shapedPatterns.forEach(function (p) {
        var m = whole.match(p.re);
        if (m) {
          errors.push("PRIVACY: the data file contains what looks like " + p.label + ": " + m.join(", ") +
            " - strip it, or move it to the gitignored private-overrides.json (see data/private-overrides.example.json for the shape), before this can be published.");
        }
      });

      // Contact details belonging to anyone other than Derin himself.
      // Allowlisted against data.identity.contact - Derin's own email/
      // phone are meant to be here (every CV has them); anyone else's
      // is not. HONEST LIMITATION, stated up front: the phone check only
      // catches '+'-prefixed international format, which is how every
      // phone number in this project's data has been written so far
      // (Derin's own included) - a bare local-format number would slip
      // past it. Tightening this further risks false positives against
      // ordinary long digit runs (dates, heightPx decimals) - see the
      // same false-positive check referenced above, which is exactly why
      // this shape was chosen over a looser one.
      var allowedContacts = {};
      (data.identity && data.identity.contact || []).forEach(function (c) {
        if (c.text) allowedContacts[c.text] = true;
        if (c.link) allowedContacts[c.link] = true;
      });
      var emails = whole.match(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g) || [];
      emails.forEach(function (e) {
        if (!allowedContacts[e] && !allowedContacts["mailto:" + e]) {
          errors.push("PRIVACY: an email address not in identity.contact appears in the data file: " + e + " - referee/third-party contact details must not ship.");
        }
      });
      var phones = whole.match(/\+\d[\d\s\-()]{6,}\d/g) || [];
      phones.forEach(function (p) {
        if (!allowedContacts[p]) {
          errors.push("PRIVACY: a phone number not in identity.contact appears in the data file: " + p + " - referee/third-party contact details must not ship.");
        }
      });

      // Referee name, structural check: let-close-referee's text must
      // still be templated ({{REFEREE}}), never a literal name - see
      // js/letterbuild.js's REFEREE slot and the Private settings form in
      // js/app.js. This catches a future hand-edit that puts a
      // real name back into the committed block, even though it can't
      // name-match the specific name (the whole point is that name is
      // never allowed in committed source, including this check's own
      // code).
      var closeEntries = (data.letterBlocks && data.letterBlocks.close) || [];
      var refereeEntry = closeEntries.filter(function (e) { return e.id === "let-close-referee"; })[0];
      if (refereeEntry && refereeEntry.text.indexOf("{{REFEREE}}") === -1) {
        errors.push("PRIVACY: letterBlocks.close['let-close-referee'].text no longer contains the {{REFEREE}} " +
          "template token - a referee's real name must never be typed directly into the published data file " +
          "(see data/private-overrides.example.json).");
      }
    })();

    return errors;
  }

  // --- Short-variant coverage (19 Sept 2026, Derin's "A-E" spec, part A's
  // own implementation note): "a block with no `.short` is skipped in step
  // 1, not an error. Validation should report coverage ('14 of 22
  // includable blocks have short variants') so gaps are visible without
  // blocking." Deliberately NOT pushed into validateData()'s `errors` -
  // this is visibility, not a gate; the caller (js/app.js's boot()) logs it
  // to the console once, on a clean load. "Includable" here means every
  // bulletVariants VARIANT (any could be the one pickBestVariant chooses)
  // and every profileVariant (one per archetype, but which variant could
  // still vary by JD) - not every group/profile ENTRY, since two variants
  // in the same group can differ on whether they have a `.short` at all.
  function shortCoverageReport(data) {
    var total = 0, withShort = 0;
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v) {
        total++;
        if (typeof v.short === "string" && v.short.length) withShort++;
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      total++;
      if (typeof p.short === "string" && p.short.length) withShort++;
    });
    return withShort + " of " + total + " includable blocks have short variants.";
  }

  // Zero-saving shorts (20 Sept 2026, Derin's own instruction, part of the
  // same spec that added linesSaved to tests/golden/measure-blocks.js and
  // taught js/trim.js's shorten step to skip these at runtime): "WARN AT
  // LOAD. Zero-saving shorts are a warning, not a build failure - they are
  // harmless once skipped, but they are dead weight somebody should clean
  // up." Same non-blocking shape as shortCoverageReport just above -
  // NOT pushed into validateData()'s `errors`, the caller logs it once on
  // a clean load. linesSaved === 0 specifically (not falsy/missing) - a
  // `.short` that has never been measured yet (no measure-blocks.js --apply
  // run since it was added) says nothing here; that state is what
  // validateData()'s existing staleness/missing-heightPx checks already
  // catch as a hard error, so this function only ever sees blocks that
  // measure-blocks.js has actually scored.
  function zeroSavingShortsReport(data) {
    var ids = [];
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v) {
        if (typeof v.linesSaved === "number" && v.linesSaved === 0) {
          ids.push("bulletVariants['" + gid + "'].variants['" + v.id + "']");
        }
      });
    });
    (data.profileVariants || []).forEach(function (p) {
      if (typeof p.linesSaved === "number" && p.linesSaved === 0) {
        ids.push("profileVariants['" + p.id + "']");
      }
    });
    if (!ids.length) return null;
    return ids.length + " short variant(s) save zero lines - dead weight, js/trim.js already skips " +
      "them but they should be rewritten or removed: " + ids.join(", ");
  }

  global.CVValidate = { validateData: validateData, shortCoverageReport: shortCoverageReport, zeroSavingShortsReport: zeroSavingShortsReport, VALID_SECTION_TYPES: VALID_SECTION_TYPES };
})(typeof window !== "undefined" ? window : globalThis);
