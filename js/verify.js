// ---------------------------------------------------------------------------
// Safety gates: never-claim, dashes, provenance, page fit (build spec
// section 8). This module never touches the DOM and never mutates the
// content model - it only reads a model (from js/assemble.js) plus the
// loaded data file and reports pass/fail per gate, with human-readable
// findings. The caller (js/app.js) decides what to do with the result -
// disable the download button and show why, per section 9.
//
// 13 Sept 2026 review fixes in this file:
//   - Gate 1 (never-claim) now matches through js/matcher.js instead of a
//     raw case-insensitive substring check. This is not optional any more:
//     data.neverClaim now uses matchRule's stem syntax ("reconcil*"), and a
//     raw substring check would search for the literal characters
//     "reconcil*" (asterisk included) and never match anything - silently
//     disabling the gate for every stemmed term. It also fixes the same
//     boundary-collision risk class the review's Finding 3 found in
//     score.js's qualification check (confirmed NOT currently live against
//     this data file's own approved text, via a dedicated collision test -
//     see tests/golden/run-golden-tests.mjs - but latent all the same).
//   - Gates 1 and 2 now scan PER FIELD instead of one flattened text blob,
//     so a finding can report exactly which block and field it came from,
//     and - via a path index built once from the data file - exactly which
//     JSON path the offending text lives at (e.g.
//     "skillLines.technical.terms[4]"), not just a fuzzy text snippet. This
//     directly answers the review's ask: "not 'never-claim term found' but
//     'never-claim term sql found in skillLines.technical.terms[4]'."
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  if (!Matcher) {
    throw new Error("verify.js loaded before js/matcher.js. Check <script> order.");
  }

  // ---- Path index: object reference -> human-readable JSON path -----------
  // Built once per data file (cheap - it's a handful of arrays/objects, not
  // the whole tree) so gate findings can name where in cv-generator-data.json
  // a piece of text actually lives, using the SAME live object references
  // js/assemble.js's _prov entries already point at - no separate id scheme
  // to keep in sync, same principle as provenance itself.
  function buildPathIndex(data) {
    var index = new Map();
    function record(ref, path) { if (ref && typeof ref === "object") index.set(ref, path); }
    if (data.identity) {
      record(data.identity, "identity");
      (data.identity.contact || []).forEach(function (c, i) { record(c, "identity.contact[" + i + "]"); });
    }
    Object.keys(data.skillLines || {}).forEach(function (catKey) {
      var cat = data.skillLines[catKey];
      record(cat, "skillLines." + catKey);
      (cat.terms || []).forEach(function (term, i) { record(term, "skillLines." + catKey + ".terms[" + i + "]"); });
    });
    Object.keys(data.bulletVariants || {}).forEach(function (gid) {
      (data.bulletVariants[gid].variants || []).forEach(function (v, i) {
        record(v, "bulletVariants." + gid + ".variants[" + i + "]");
      });
    });
    (data.profileVariants || []).forEach(function (p, i) { record(p, "profileVariants[" + i + "]"); });
    (data.facts && data.facts.roles || []).forEach(function (r, i) { record(r, "facts.roles[" + i + "]"); });
    (data.facts && data.facts.education || []).forEach(function (e, i) { record(e, "facts.education[" + i + "]"); });
    if (data.facts && data.facts.project) record(data.facts.project, "facts.project");
    (data.facts && data.facts.projects || []).forEach(function (p, i) { record(p, "facts.projects[" + i + "]"); });
    (data.facts && data.facts.certifications || []).forEach(function (c, i) {
      record(c, "facts.certifications[" + i + "]");
      (c.items || []).forEach(function (it, j) { record(it, "facts.certifications[" + i + "].items[" + j + "]"); });
    });
    if (data.facts && data.facts.volunteering) record(data.facts.volunteering, "facts.volunteering");
    // letterBlocks (21 Sept 2026, cover-letter renderer): indexed the same
    // way as every other content source above, so a letter provenance
    // finding can name a real data-file path ("letterBlocks.why[2]") too,
    // not just "template block, no path available".
    var lb = data.letterBlocks || {};
    // "salutation" added 21 Sept 2026: previously missing from this list
    // (the standard salutation carried real provenance from day one, but
    // its data-file path could never be named in a finding). Both
    // let-salutation-std and the new let-salutation-named now index
    // correctly, same as every other letterBlocks category.
    ["opening", "why", "evidence", "gap", "close", "signoff", "salutation"].forEach(function (cat) {
      (lb[cat] || []).forEach(function (e, i) { record(e, "letterBlocks." + cat + "[" + i + "]"); });
    });
    return index;
  }

  function pathFor(pathIndex, ref) {
    return (ref && pathIndex.get(ref)) || null;
  }

  // ---- Gate 3: provenance --------------------------------------------------

  function resolveAtom(atom) {
    return atom.ref[atom.field];
  }

  // 21 Sept 2026 (cover-letter renderer): a templated letterBlocks entry's
  // rendered text is never equal to ref[field] directly - it has
  // {{ROLE}}/{{COMPANY}}/{{TEAM}}/{{ECHO}}/{{YEARS}} slots filled in with
  // runtime values (company name, ECHO quote, etc.), which the CV side
  // never had to deal with. js/letterbuild.js's templateProv() records
  // which ref/field/slots produced the text; this recomputes the SAME
  // substitution (via CVLetterBuild.fillTemplate - one function, reused,
  // not a second copy that could disagree with the one that actually built
  // the letter) so the check still means something: a wrong ref, a hand-
  // edited block, or a stale slot value all still fail it, exactly the
  // same as the CV's plain-equality check catches its own failure modes.
  function expectedFromProv(prov) {
    if (prov.template) {
      var fill = global.CVLetterBuild && global.CVLetterBuild.fillTemplate;
      if (!fill) throw new Error("verify.js: a template provenance entry was checked before js/letterbuild.js loaded. Check <script> order.");
      var t = prov.template;
      return fill(t.ref[t.field], t.slots, t.ref.id);
    }
    var texts = prov.atoms.map(resolveAtom);
    var joined = prov.join != null ? texts.join(prov.join) : texts[0];
    return (prov.prefix || "") + joined + (prov.suffix || "");
  }

  function provPath(pathIndex, prov) {
    if (!prov) return null;
    if (prov.template) return pathFor(pathIndex, prov.template.ref);
    if (!prov.atoms || !prov.atoms.length) return null;
    return pathFor(pathIndex, prov.atoms[0].ref);
  }

  // Which fields each block type renders as free text, and how to read the
  // block's own (already-built) value for that field. Kept as a lookup
  // table, not a switch, so a block type with no entry here fails loudly
  // instead of silently skipping verification.
  var TEXT_FIELDS = {
    name: { text: function (b) { return b.text; } },
    auth: { text: function (b) { return b.text; } },
    head: { text: function (b) { return b.text; } },
    dates: { text: function (b) { return b.text; } },
    bullet: { text: function (b) { return b.text; } },
    para: { text: function (b) { return b.text; } },
    // letterPara/letterLine (21 Sept 2026, cover-letter renderer): same
    // shape as "para" - a single text field - so gates 1/2/3 (never-claim,
    // dash, provenance) already cover letter content for free once these
    // are listed here. letterLine (date/recipient/salutation/signature)
    // still goes through the never-claim and dash scans like everything
    // else; it just has no _prov most of the time (js/letter.js does not
    // attach one for header furniture that isn't sourced from the data
    // file - see fieldEntriesFor below, which already treats a missing
    // prov on a non-empty field as its own provenance failure).
    letterPara: { text: function (b) { return b.text; } },
    letterLine: { text: function (b) { return b.text; } },
    skillLine: { label: function (b) { return b.label; }, text: function (b) { return b.text; } },
    role: {
      title: function (b) { return b.title; },
      org: function (b) { return b.org; },
      right: function (b) { return b.right; }
    },
    spacer: {},
    contact: {} // handled specially below - items is an array, not a single field
  };

  function checkProvenance(model, pathIndex, docType) {
    var failures = [];
    model.forEach(function (block, i) {
      if (block.t === "contact") {
        var items = block.items || [];
        var provItems = (block._prov && block._prov.items) || [];
        items.forEach(function (item, j) {
          var prov = provItems[j];
          if (!prov) {
            failures.push({ index: i, type: "contact", field: "items[" + j + "]", reason: "no provenance recorded - not traceable to the data file", path: null });
            return;
          }
          var expected = expectedFromProv(prov);
          if (expected !== item.text) {
            failures.push({ index: i, type: "contact", field: "items[" + j + "]", reason: "text does not match the data file exactly", expected: expected, actual: item.text, path: provPath(pathIndex, prov) });
          }
        });
        return;
      }

      var fields = TEXT_FIELDS[block.t];
      if (!fields) {
        failures.push({ index: i, type: block.t, field: null, reason: "unknown block type - verify.js has no provenance rule for it. Add one before shipping.", path: null });
        return;
      }
      Object.keys(fields).forEach(function (field) {
        var actual = fields[field](block);
        if (actual == null || actual === "") return; // nothing rendered for this field - no claim made, nothing to trace
        var prov = block._prov && block._prov[field];
        if (!prov) {
          // letterLine (21 Sept 2026, cover-letter renderer) is the one
          // block type in this app that legitimately mixes data-file
          // content (the salutation, the signature name - both DO carry a
          // real prov, checked below like anything else) with generated,
          // non-claim text that was never meant to trace back to the data
          // file at all: the send date, and the recipient block's company/
          // role/team/city lines, typed per application or lifted verbatim
          // from the pasted JD by CVLetterBuild.validateTeam before this
          // gate ever runs. A missing prov on THIS type is the deliberate,
          // documented shape of that content (see js/letter.js's own
          // header) - failing the gate on it would incorrectly refuse to
          // download every single letter, since a date/company/role/team
          // line legitimately has nothing to trace. Every other block type
          // still fails loudly on a missing prov, exactly as before.
          if (block.t === "letterLine") return;
          failures.push({ index: i, type: block.t, field: field, reason: "no provenance recorded - not traceable to the data file", actual: actual, path: null });
          return;
        }
        var expected = expectedFromProv(prov);
        if (expected !== actual) {
          failures.push({ index: i, type: block.t, field: field, reason: "text does not match the data file exactly", expected: expected, actual: actual, path: provPath(pathIndex, prov) });
        }
      });
    });

    // Structural check: the right-to-work line must be PRESENT on every CV,
    // no matter the archetype or trimming (see trimPolicy.neverDo) - a
    // missing block would otherwise pass this whole gate silently, since
    // there's nothing to check text against if the block was never built.
    //
    // docType-gated (21 Sept 2026, cover-letter renderer): this was always
    // a CV-specific invariant - trimPolicy.neverDo's own wording says "on
    // every CV" - never a universal one, and a cover letter correctly
    // carries no such line (confirmed against both real reference letters
    // in tests/fixtures/reference/ - neither has one). Before this fix
    // there was no letter model to run through this gate at all, so the
    // rule's CV-only scope was never actually exercised; it needed to be
    // stated explicitly the moment a second docType existed to check.
    if (docType !== "letter") {
      var hasAuth = model.some(function (b) { return b.t === "auth" && b.text; });
      if (!hasAuth) {
        failures.push({
          index: -1, type: "model", field: "auth", path: null,
          reason: "no right-to-work/authorisation block present anywhere in the model - this must appear on every CV, no matter the archetype or trimming (see trimPolicy.neverDo)"
        });
      }
    }

    return failures;
  }

  // ---- Field-level text access, shared by gates 1 and 2 --------------------
  // Returns [{field, text, prov}] for every non-empty text field a block
  // carries - reusing TEXT_FIELDS/contact-items so gates 1/2 see exactly the
  // same fields gate 3 checks, and can attach the same provenance-derived
  // path to a finding.
  function fieldEntriesFor(block) {
    var out = [];
    if (block.t === "contact") {
      (block.items || []).forEach(function (item, j) {
        if (item && item.text) {
          out.push({ field: "items[" + j + "]", text: item.text, prov: block._prov && block._prov.items && block._prov.items[j] });
        }
      });
      return out;
    }
    var fields = TEXT_FIELDS[block.t];
    if (!fields) {
      throw new Error("verify.js: unknown block type '" + block.t + "' - add it to TEXT_FIELDS before shipping, or banned-term/dash scans will silently skip it.");
    }
    Object.keys(fields).forEach(function (field) {
      var text = fields[field](block);
      if (text) out.push({ field: field, text: text, prov: block._prov && block._prov[field] });
    });
    return out;
  }

  // Flattened full text, kept for callers (e.g. the golden collision test)
  // that just want every user-visible string in one block, independent of
  // per-field attribution.
  function collectText(model) {
    var parts = [];
    model.forEach(function (b) {
      fieldEntriesFor(b).forEach(function (e) { parts.push(e.text); });
    });
    return parts.join("\n");
  }

  // ---- Gate 1: never-claim ---------------------------------------------------
  // Matches via js/matcher.js (data.matchRule syntax: trailing * = stem, no
  // * = exact word) - required now that data.neverClaim uses stems like
  // "reconcil*", which a raw substring check can no longer interpret.
  function neverClaimScan(text, neverClaimList) {
    // scanListJoined (2 Oct 2026): also catches a never-claim term written
    // with hyphens ("anomaly-detection") - see js/matcher.js.
    return Matcher.scanListJoined(text, neverClaimList || []);
  }

  // What the never-claim scan reads in a letter (8 Oct 2026): the data
  // file's own words, not the details of this application. The company,
  // role, team, recipient and city come from the ad or are typed in, and the
  // quoted line is the ad's own; they describe the employer and the job, not
  // Derin, so a never-claim term among them is not a claim. Applying to
  // Salesforce ("salesforce" is on the list as a CRM he has not used) put
  // the company's name in the address and in the opening and closing lines,
  // and the letter could not be downloaded. A templated block is scanned as
  // its template with the slots left out; a recipient or date line, which
  // has no data-file source at all, is not scanned. Everything else - the
  // whole CV, and every approved letter paragraph - is scanned as before.
  function claimText(block, entry) {
    if (block.t !== "letterLine" && block.t !== "letterPara") return entry.text;
    var prov = entry.prov;
    if (!prov) return block.t === "letterLine" ? "" : entry.text;
    if (prov.template) {
      return String(prov.template.ref[prov.template.field] || "").replace(/\{\{[A-Z]+\}\}/g, " ");
    }
    return entry.text;
  }

  // Per-field version used by runGates: same matching, but returns exactly
  // which block/field/path each hit came from.
  function neverClaimScanModel(model, neverClaimList, pathIndex) {
    var findings = [];
    model.forEach(function (block, i) {
      // 21 Sept 2026 (Suggestion A, gap paragraphs): a gap block, by
      // definition, names something Derin does NOT have - "I am not QFA
      // qualified", "I have not worked in sales, recruiting or cold
      // outreach" - so the terms it legitimately contains are exactly the
      // terms this gate exists to keep off every other page. Otherwise a
      // gap about SQL (or anything else on data.neverClaim) could never be
      // written at all. Exempted here by the same explicit, narrow,
      // documented-reason pattern as checkProvenance's own letterLine
      // exemption above (never a blanket "letters are exempt" - only this
      // specific, deliberate content shape, identified by the `category`
      // js/letter.js's bodyBlocks() now preserves): every other block type,
      // including every OTHER category of letter content, is still fully
      // scanned.
      if (block.category === "gap") return;
      fieldEntriesFor(block).forEach(function (entry) {
        var hits = neverClaimScan(claimText(block, entry), neverClaimList);
        hits.forEach(function (term) {
          var path = provPath(pathIndex, entry.prov);
          findings.push(
            'Banned term "' + term + '" found in block ' + i + ' (' + block.t + '.' + entry.field + ')' +
            (path ? ", data file path " + path : "") + ': "' + entry.text + '"'
          );
        });
      });
    });
    return findings;
  }

  // ---- Gate 2: dashes ---------------------------------------------------------
  // Plain hyphens only, per spec section 7. En dash U+2013, em dash U+2014.

  function dashScan(text) {
    var hits = [];
    var re = /[–—]/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      hits.push({
        char: m[0],
        index: m.index,
        context: text.slice(Math.max(0, m.index - 20), m.index + 20)
      });
    }
    return hits;
  }

  function dashScanModel(model, pathIndex) {
    var findings = [];
    model.forEach(function (block, i) {
      fieldEntriesFor(block).forEach(function (entry) {
        dashScan(entry.text).forEach(function (h) {
          var path = provPath(pathIndex, entry.prov);
          findings.push(
            'Found "' + h.char + '" (not a plain hyphen) in block ' + i + ' (' + block.t + '.' + entry.field + ')' +
            (path ? ", data file path " + path : "") + ', near: …' + h.context + '…'
          );
        });
      });
    });
    return findings;
  }

  // ---- Gate 5 (letters only): verbatim-quote check -------------------------
  // 21 Sept 2026 (cover-letter renderer). js/letterbuild.js's own header
  // states the rule as a design intent: "ECHO is SELECTION, never
  // composition... a typed ECHO is the one input path in this whole app
  // where a FALSE CLAIM ABOUT THE EMPLOYER could get in," and TEAM is
  // manual entry constrained by CVLetterBuild.validateTeam() to be a
  // verbatim JD substring. Both are already enforced upstream - ECHO by
  // buildEchoCandidates() only ever offering verbatim spans, TEAM by
  // validateTeam() itself - so this gate should, correctly, never find
  // anything wrong in normal operation. It exists as defence in depth, the
  // same "belt and braces" reasoning js/segment.js's dual heading/absolute-
  // exclusion check already used (18-19 Sept 2026): enforcing the rule in
  // CODE that runs on every build, not only in the one UI code path that
  // is supposed to already guarantee it, so a future bug upstream (a new
  // call site that forgets to validate, a refactor that drops the check)
  // fails loudly here instead of silently shipping an invented quote.
  //
  // recipientName (21 Sept 2026, named-salutation addition) is the exact
  // same shape as TEAM - manual entry constrained by
  // CVLetterBuild.validateRecipientName() to be a verbatim JD substring -
  // so it gets the same belt-and-braces re-check here, for the same reason.
  function letterQuoteFindings(rawJD, echoText, team, recipientName) {
    var jd = (rawJD || "").toLowerCase();
    var findings = [];
    if (echoText && jd.indexOf(String(echoText).toLowerCase()) === -1) {
      findings.push('ECHO text "' + echoText + '" was not found verbatim in the pasted job description - ECHO must be selected from the ad, never typed or composed.');
    }
    if (team && jd.indexOf(String(team).toLowerCase()) === -1) {
      findings.push('TEAM text "' + team + '" was not found verbatim in the pasted job description - paste it verbatim from the ad, or leave it blank.');
    }
    if (recipientName && jd.indexOf(String(recipientName).toLowerCase()) === -1) {
      findings.push('Recipient name "' + recipientName + '" was not found verbatim in the pasted job description - paste it verbatim from the ad, or leave it blank.');
    }
    return findings;
  }

  // ---- Bringing it together ---------------------------------------------------
  // `fit`, if given, is a js/pagefit.js CVPageFit.measure() result (17 Sept
  // 2026 - previously js/preview.js's CVPreview.measure(), same shape) -
  // gate 4 is included only when the caller has actually measured something.
  //
  // `opts` (21 Sept 2026, cover-letter renderer, additive - every existing
  // CV call site omits it and is unaffected): { docType: "cv"|"letter",
  // rawJD, echoText, team }. docType gates the CV-only auth-line structural
  // check (see checkProvenance above); rawJD/echoText/team feed the new
  // gate 5, added to the list only for docType "letter" since a CV model
  // has neither field.
  function runGates(model, data, fit, opts) {
    opts = opts || {};
    var docType = opts.docType || "cv";
    var pathIndex = buildPathIndex(data);
    var neverClaimFindings = neverClaimScanModel(model, data.neverClaim, pathIndex);
    var dashFindings = dashScanModel(model, pathIndex);
    var provFailures = checkProvenance(model, pathIndex, docType);

    var gates = [
      {
        name: "Never-claim scan",
        passed: neverClaimFindings.length === 0,
        findings: neverClaimFindings
      },
      {
        name: "Dash scan",
        passed: dashFindings.length === 0,
        findings: dashFindings
      },
      {
        name: "Provenance check",
        passed: provFailures.length === 0,
        findings: provFailures.map(function (f) {
          var loc = "Block " + f.index + " (" + f.type + (f.field ? "." + f.field : "") + ")" + (f.path ? ", data file path " + f.path : "");
          var detail = f.reason;
          if (f.expected != null) {
            detail += ' [data file says: "' + f.expected + '", output has: "' + f.actual + '"]';
          }
          return loc + ": " + detail;
        })
      }
    ];

    if (fit) {
      gates.push({
        name: "Page fit",
        passed: !fit.overflows,
        findings: fit.overflows
          ? ["Overflows by " + Math.round(fit.overflowPx) + "px against the " + Math.round(fit.usableHeightPx) +
             "px budget. Would risk spilling to a second page - drop content (trimPolicy.order) and re-check."]
          : []
      });
    }

    if (docType === "letter") {
      var quoteFindings = letterQuoteFindings(opts.rawJD, opts.echoText, opts.team, opts.recipientName);
      gates.push({
        name: "Letter verbatim-quote check",
        passed: quoteFindings.length === 0,
        findings: quoteFindings
      });
    }

    return {
      passed: gates.every(function (g) { return g.passed; }),
      gates: gates
    };
  }

  global.CVVerify = {
    buildPathIndex: buildPathIndex,
    collectText: collectText,
    neverClaimScan: neverClaimScan,
    dashScan: dashScan,
    checkProvenance: checkProvenance,
    runGates: runGates
  };
})(typeof window !== "undefined" ? window : globalThis);
