// ---------------------------------------------------------------------------
// Cover-letter renderer (21 Sept 2026). Derin's own order-of-work, verbatim:
// "expose primitives from render-docx.js, compose letter.js from them,
// target the reference letters in the zips. No new spec is coming. Build to
// that one." This file is that composition - it never invents its own
// text-selection logic (that is js/letterbuild.js's job, already built in
// Phase 7) and never invents its own docx-paragraph logic (that is
// js/render-docx.js's job, extended this same pass with buildWithPage()
// and the letterPara/letterLine block types specifically so this file
// would not need to). What this file actually does: turns a chosen
// archetype + the letterbuild.js selection result + a handful of manual
// inputs (company/role/team/city) into the FULL content-model array a
// cover letter needs - header (name/contact, same as the CV), date,
// recipient block, salutation, the selected body paragraphs, and a
// signature - then hands that model to CVStyle.blocksToChildren() and
// CVStyle.buildWithPage() exactly the way js/app.js already hands a CV
// model to those same two functions today.
//
// Two pieces of content this file needs do not exist anywhere in the data
// file as of the previous pass, and are NOT invented here - they were added
// to data/cv-generator-data.json as part of this same pass, each flagged
// for what it actually is:
//   - identity.signatureName ("Derin Yesudas") - not a new fact, a
//     mixed-case rendering of the name identity.name already carries in
//     capitals for the CV header. Added because this project's core rule
//     ("nothing may appear unless it exists verbatim in the data file")
//     applies to a signature line exactly as it applies to everything
//     else - there is no code-level "just title-case it" shortcut that
//     would still be provably traceable to the data file the way every
//     other field on the page already is.
//   - letterBlocks.salutation ("Dear Hiring Team,") - genuinely NEW
//     boilerplate, not a rendering variant of an existing fact. Originally
//     shipped as a flagged, Claude-authored working default (_pendingReview,
//     with an on-screen banner) pending confirmation; Derin confirmed it
//     21 Sept 2026 (already written into CV-house-style.md - never a guess)
//     and the _pendingReview flag was cleared the same pass. Since then a
//     second entry, let-salutation-named, exists for the "named recruiter"
//     case (see salutationBlock's own comment below) - house style's other
//     half of the same rule.
//
// Recipient block (TEAM / COMPANY / city) collapses per tests/fixtures/
// README.txt's own instruction for the Sigmar fixture: "Recipient block
// must collapse to company and city, or use the named recruiter. No prompt
// to invent one." A named recruiter, where known, now drives the salutation
// (see salutationBlock below and CVLetterBuild.validateRecipientName) - an
// empty TEAM and/or empty city/recipient name simply omit that content,
// never a guess at what should fill it.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Style = global.CVStyle;
  var Assemble = global.CVAssemble;
  var LetterBuild = global.CVLetterBuild;
  if (!Style || !Assemble || !LetterBuild) {
    throw new Error("letter.js loaded before js/render-docx.js, js/assemble.js, or js/letterbuild.js. Check <script> order.");
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  // Exposed (not just used internally) so a test can pin the letter's date
  // without depending on the real clock - the ONLY thing in this whole
  // renderer that is not derived from the data file or from what Derin
  // typed, because a letter's send date is metadata about WHEN it was
  // generated, not a claim about Derin, and every real reference letter in
  // this project's fixtures carries one.
  function todayLine(d) {
    d = d || new Date();
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  // --- Header (name/contact) - identical to the CV's own, same source
  // fields, same provenance shape (CVAssemble.oneProv), reused rather than
  // re-typed. No "auth" (right-to-work) block - the two real reference
  // letters carry no such line, and js/verify.js's provenance gate no
  // longer requires one for a docType:"letter" model (that check was
  // always a CV-only invariant - see trimPolicy.neverDo).
  function headerBlocks(data) {
    return [
      { t: "name", text: data.identity.name, _prov: { text: Assemble.oneProv(data.identity, "name") } },
      {
        t: "contact", items: data.identity.contact,
        _prov: { items: data.identity.contact.map(function (it) { return Assemble.oneProv(it, "text"); }) }
      },
      { t: "spacer" }
    ];
  }

  function letterLine(text, prov, after) {
    var block = { t: "letterLine", text: text, opts: { size: Style.letterBodySize(), after: after } };
    if (prov) block._prov = { text: prov };
    return block;
  }

  // --- Date -----------------------------------------------------------
  // No data-file ref (see file header) - genuinely no _prov, same as the
  // CV's own "spacer" blocks carry none: nothing here is a claim about
  // Derin, so there is nothing for the provenance gate to trace.
  function dateBlocks(data, now) {
    return [letterLine(todayLine(now), null, data.style.spacingAfter.dates), { t: "spacer" }];
  }

  // --- Recipient block --------------------------------------------------
  // team/company/city each become their own line, in that order, and each
  // is genuinely OMITTED (not blanked) when empty - the collapse behaviour
  // tests/fixtures/README.txt requires for the Sigmar fixture. None of the
  // three is data-file content (they are typed per application, or - for
  // team - a verbatim JD quote the caller has already run through
  // CVLetterBuild.validateTeam before this is ever called), so none of
  // these lines carries a _prov either, for the same reason the date line
  // above does not.
  function recipientBlocks(data, opts) {
    var lines = [];
    if (opts.team) lines.push(opts.team);
    if (opts.company) lines.push(opts.company);
    if (opts.city) lines.push(opts.city);
    if (!lines.length) return [];
    var out = lines.map(function (t) {
      return letterLine(t, null, data.style.spacingAfter.dates);
    });
    out.push({ t: "spacer" });
    return out;
  }

  // --- Salutation ---------------------------------------------------------
  // Real data-file content (letterBlocks.salutation - see file header),
  // real provenance. Throws if the standard entry is missing rather than
  // falling back to a hardcoded string - the whole point of moving this
  // into the data file was to make it a real, checkable, editable fact, not
  // an escape hatch back to hardcoding the moment the entry is absent.
  //
  // recipientName (21 Sept 2026, Derin's own instruction, house style: "use
  // a named recruiter where one is known") - already validated by the
  // caller via CVLetterBuild.validateRecipientName (same layering as TEAM:
  // this function trusts the caller has already blocked the download on an
  // invalid name, the same way it already trusts `team` upstream). When
  // present, selects let-salutation-named and fills its {{RECIPIENT}}
  // slot via a template provenance (CVLetterBuild.templateProv/fillTemplate
  // - the same shape and the same functions every other templated letter
  // block already uses, not a second copy). When absent, falls back to the
  // standard entry exactly as before. Never Mr/Ms, never "Dear Sir/Madam"
  // (already banned by letterBlocks._rules), never "To," alone - the name
  // is used exactly as typed, with nothing prepended.
  function salutationBlock(data, recipientName) {
    var entries = data.letterBlocks.salutation || [];
    var std = Assemble.findById(entries, "let-salutation-std") || entries[0];
    if (!std) throw new Error("letter.js: data.letterBlocks.salutation has no entry - add one (see build-status-and-decision-log.md, 21 Sept 2026 pass) before building a letter.");
    var after = data.style.spacingAfter.letterPara;
    if (recipientName) {
      var named = Assemble.findById(entries, "let-salutation-named");
      if (!named) throw new Error("letter.js: data.letterBlocks.salutation has no 'let-salutation-named' entry - a recipient name was supplied but there is nothing to render it with.");
      var slots = { RECIPIENT: recipientName };
      var text = LetterBuild.fillTemplate(named.text, slots, named.id);
      return letterLine(text, LetterBuild.templateProv(named, "text", slots), after);
    }
    return letterLine(std.text, Assemble.oneProv(std, "text"), after);
  }

  // --- Signature ------------------------------------------------------
  // identity.signatureName (see file header) - real data-file content,
  // real provenance.
  function signatureBlocks(data) {
    return [
      { t: "spacer" },
      letterLine(data.identity.signatureName, Assemble.oneProv(data.identity, "signatureName"), 0)
    ];
  }

  // --- Body paragraphs --------------------------------------------------
  // letterResult.blocks (js/letterbuild.js's CVLetterBuild.buildLetterModel
  // output) already carries {id, category, text, ref, _prov} per block -
  // this just re-tags each one "letterPara" (js/pagefit.js and
  // js/verify.js both need that type name to apply the right height/
  // provenance rule - see those files' own comments) and attaches the
  // rendering opts (letterBody size, the letterPara spacing value).
  //
  // category preserved (21 Sept 2026, Suggestion A): previously dropped
  // here, which meant js/verify.js's never-claim gate had no way to tell a
  // gap paragraph apart from any other body paragraph. A gap block
  // legitimately names something Derin does NOT have ("I am not QFA
  // qualified") - see that file's own exemption comment - and that
  // exemption can only work if `category` survives into the content model.
  function bodyBlocks(data, letterResult) {
    var after = data.style.spacingAfter.letterPara;
    return letterResult.blocks.map(function (b) {
      return { t: "letterPara", text: b.text, ref: b.ref, category: b.category, _prov: b._prov, opts: { size: Style.letterBodySize(), after: after } };
    });
  }

  // --- Top-level assembly -------------------------------------------------
  // opts: same shape js/letterbuild.js's buildLetterModel already takes
  // (archetypeId, extraction, rawJD, yearsRelevant, company, role, team,
  // echoText, titleMismatch, fitCheckGapTrigger), plus `city` and `now`
  // (optional Date, for tests), and `recipientName` (21 Sept 2026 - already
  // validated by the caller via CVLetterBuild.validateRecipientName, same
  // layering as `team`; empty/omitted falls back to the standard
  // salutation).
  //
  // Returns { model, letterResult } - `model` is the full content-model
  // array ready for CVPreview.render / CVPageFit.measure / CVVerify.
  // runGates(..., 'letter') / CVStyle.blocksToChildren, exactly the same
  // four consumers a CV model already has. `letterResult` is
  // buildLetterModel's own return value (echoCandidates, gapTrigger),
  // passed through so the caller can render the ECHO picker and know which
  // gap paragraph got selected.
  function assembleLetter(data, opts, letterResult) {
    var model = []
      .concat(headerBlocks(data))
      .concat(dateBlocks(data, opts.now))
      .concat(recipientBlocks(data, opts))
      .concat([salutationBlock(data, opts.recipientName)])
      .concat(bodyBlocks(data, letterResult))
      .concat(signatureBlocks(data));
    Assemble.fixLastParagraphSpacing(model);
    return model;
  }

  function buildLetterContentModel(data, opts) {
    opts = opts || {};
    var letterResult = LetterBuild.buildLetterModel(data, opts);
    var model = assembleLetter(data, opts, letterResult);
    // Second evidence paragraph, "whenever it fits on the page" (Derin, 4
    // Oct 2026): if the letter would run past one page, the paragraph
    // js/letterbuild.js marked droppable (the less relevant automatic one,
    // never a hand pick) comes out again and the letter is rebuilt with
    // the other one alone. The page-fit gate still covers everything else.
    var PageFit = global.CVPageFit;
    if (letterResult.evidenceDroppableId && PageFit && typeof PageFit.measure === "function") {
      var fit = null;
      try { fit = PageFit.measure(model, "letter"); } catch (e) { fit = null; }
      if (fit && fit.overflows) {
        var dropped = letterResult.evidenceDroppableId;
        var opts2 = {};
        Object.keys(opts).forEach(function (k) { opts2[k] = opts[k]; });
        opts2.choices = {};
        Object.keys(opts.choices || {}).forEach(function (k) { opts2.choices[k] = opts.choices[k]; });
        opts2.choices.evidence = letterResult.evidenceKeepId;
        opts2.choices.evidence2 = "none";
        letterResult = LetterBuild.buildLetterModel(data, opts2);
        letterResult.evidence2DroppedForFit = dropped;
        model = assembleLetter(data, opts2, letterResult);
      }
    }
    return { model: model, letterResult: letterResult };
  }

  // --- Filename / download -------------------------------------------------
  function filenameFor(company, role) {
    var label = [role, company].filter(Boolean).join("_") || "Application";
    var slug = label.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return "Derin_Yesudas_Cover_Letter_" + slug + ".docx";
  }

  // buildWithPage (not build()) - a cover letter's page geometry
  // (data.style.letterPage) is genuinely different from the CV's
  // (data.style.page), and js/render-docx.js's own build() only ever used
  // whichever geometry configure(data.style) last set globally. See that
  // file's buildWithPage() comment for the full reasoning.
  function download(data, model, filename) {
    return global.CVLibs.load("word").then(function () {
      var children = Style.blocksToChildren(model);
      return Style.buildWithPage(children, filename, data.style.letterPage);
    });
  }

  global.CVLetter = {
    todayLine: todayLine,
    buildLetterContentModel: buildLetterContentModel,
    filenameFor: filenameFor,
    download: download
  };
})(typeof window !== "undefined" ? window : globalThis);
