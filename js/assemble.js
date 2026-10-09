// ---------------------------------------------------------------------------
// Phase 3 (assembly) + Phase 4 (provenance instrumentation) + Phase 5
// (JD-driven content selection): "Data file loaded. Same output, now driven
// by cv-generator-data.json" -> "paste a JD, get the right variants."
//
// buildModel(data, archetypeId, opts) still takes an explicit archetype id -
// choosing WHICH archetype (spec 5.2's scoring + tie-break, or a manual
// override) is the caller's job (js/score.js + the page's own UI), not
// this file's. What this file owns is spec 5.3: given an archetype and an
// optional JD extraction (js/score.js's CVScore.extractFromJD() output,
// passed as opts.extraction), choose which variant of each thing to print
// and in what order. When opts.extraction is omitted (no JD pasted yet),
// every selection below degrades to "first-listed" / "file order" - the
// exact same code path as a JD that matched nothing, not a separate
// fallback branch. That's why Phase 3/4 already looked like this: this file
// was written so Phase 5 would extend it, not replace it.
//
// Spec 5.3, verbatim rules and how they're implemented below:
//   - Profile: pick the highest keyword-overlap variant among those tagged
//     for the chosen archetype (tie -> first-listed). See pickBestVariant().
//   - Bullets: a fact (role/project/education/cert) is included if the
//     archetype's own include list names it - unchanged from Phase 3/4.
//     Within an included role/project, EVERY bullet group listed for it is
//     included (Phase 3's priority<=2 filter is gone - that was a stopgap
//     for a page-fit problem that isn't this file's job to solve; see
//     js/verify.js's Page-fit gate and trimPolicy for where overflow is
//     actually meant to be handled, Phase 6). For each included group, the
//     variant with the highest tag-overlap with the JD is chosen (tie ->
//     first-listed), and the resulting bullets are then ordered within the
//     role by that same overlap score, highest first.
//   - Skills: the categories an archetype lists are unchanged, in its
//     order. Within a category, terms are reordered - JD-hit terms first,
//     then everything else in file order - but NEVER dropped for lacking a
//     hit (only trimPolicy, Phase 6, can drop a skill term, and only for
//     overflow). See buildSkills().
//   - Sections: archetype.sectionOrder, unchanged from Phase 3/4.
//
// Tie-breaks all resolve to "first-listed" by construction: every scoring
// helper below only replaces its current best on a STRICTLY greater score,
// scanning candidates in their original file order - so two overlap-score
// ties always keep whichever came first in the data file, without relying
// on Array.sort's stability.
//
// Phase 6 addition: role/project/bullet blocks now carry `_group`/`_trim`
// metadata (see bulletBlocksFor, buildExperience, buildProjects) purely so
// js/trim.js can execute trimPolicy.order against an already-built model.
// Neither preview.js nor render-docx.js reads these fields - they exist
// only for trimming, same principle as `_prov`: attach real structure to
// the model rather than have a second file re-derive "what role is this
// bullet under, and how important is it" by pattern-matching the flat
// array.
//
// Selection rules used where the spec doesn't yet have a scoring engine to
// decide, and why each one is safe:
//   - Which variant to use within a chosen bullet group, or which profile
//     paragraph when more than one matches the archetype: the first one
//     listed in the data file - this is section 5.3's own tie-break rule
//     ("ties go to the variant listed first"), just with everything tied
//     because there's no JD yet.
//   - Which skill terms to print within a selected category: all of them.
//     There is no filtering step yet (that's the JD-matching part of
//     Phase 5) - so showing every term in an included category is the
//     honest "no opinion yet" default, not a curated subset.
//
// --- Phase 4 addition: provenance metadata --------------------------------
// Section 8.3 of the build spec requires: "Every sentence in the output
// must be traceable to an id in the data file. Assemble the document as a
// list of {id, text} pairs and assert that each text matches the data file
// exactly." Rather than a separate id-string + a hand-maintained lookup
// table (which itself could drift from the truth), every block builder
// below attaches a `_prov` object that stores a LIVE OBJECT REFERENCE into
// the parsed data file for every piece of free text it puts in the model -
// not a copy, the same object `data.facts...` etc. actually points at.
// js/verify.js re-reads that reference at verify time and compares it
// against what the block actually displays. Two things this catches that a
// hand-typed id string could not:
//   1. A block with NO `_prov` entry for a text field it renders - exactly
//      what would have caught Phase 3's finding #2 (hand-typed sentences
//      with no data-file backing at all) automatically instead of by
//      manual paragraph-by-paragraph reading.
//   2. A block whose displayed text no longer matches what's still at that
//      reference - e.g. a future edit that mutates text after pulling it
//      from data, or copy-pastes a value instead of reading it live.
//
// A small number of fields are fixed UI chrome, not claims about Derin -
// the "Modules: " label prefix on the education module-list line is the
// one case here (see buildEducation). Those get an explicit `prefix`/
// `suffix` on the prov entry rather than being left unverified - they are
// literal, reviewed-once strings, not sentences pulled from anywhere, and
// section headings (below) are NOT treated this way: heading text is
// always sourced from an archetype's own `sectionOrder` array (itself data
// file content), never hand-typed, even though the words ("PROFILE" etc.)
// look like plain chrome.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var Matcher = global.CVMatcher;
  if (!Matcher) {
    throw new Error("assemble.js loaded before js/matcher.js. Check <script> order.");
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  // Keeps only the facts whose id is in includeIds, in the order includeIds
  // lists them - the archetype's own include array already encodes the
  // intended print order (edu-msc before edu-bms, role-tcs before
  // role-blarney, etc.), so this isn't a new ordering rule, just reading
  // the one that's already there.
  function selectInOrder(list, includeIds) {
    return includeIds
      .map(function (id) { return findById(list, id); })
      .filter(function (x) { return x != null; });
  }

  // --- Provenance helpers ---------------------------------------------------
  // A "prov" object for one rendered text field: `atoms` are {ref, field}
  // pairs pointing directly at data-file objects/arrays; `join` is the
  // separator to concatenate multiple atoms with (null = single atom, used
  // as-is); `prefix`/`suffix` are fixed literal chrome, not data content
  // (see file header) - both default to "".
  function textProv(atoms, join, prefix, suffix) {
    return { atoms: atoms, join: join || null, prefix: prefix || "", suffix: suffix || "" };
  }
  function oneProv(ref, field) {
    return textProv([{ ref: ref, field: field }], null);
  }

  // --- Right-to-work / start-date auth line (26 Sept 2026, item 2b,
  // Derin's own instruction, verbatim: "When the ad names a start date
  // later than 1 November 2026, the auth line becomes: 'Eligible to work
  // in Ireland. No visa sponsorship required. Available from 1 November
  // 2026 and for a September 2027 start.' Take the date from the ad and
  // validate it verbatim, the same way as TEAM.") The verbatim-in-JD
  // validation and the "later than 1 Nov 2026" comparison both happen
  // UPSTREAM of this file, in js/letterbuild.js's validateStartDate() +
  // startDateTriggersExtendedAuth() (js/app.js calls both before ever
  // reaching buildModel) - this function only ever receives an ALREADY
  // TRUSTED { text, appliesExtended } object, or null/undefined when no ad
  // start date applies, exactly the same division of labour buildModel()
  // already uses for opts.extraction (JD scoring happens in js/score.js,
  // not here). This file cannot call into js/letterbuild.js itself
  // (<script> load order: assemble.js loads before letterbuild.js), which
  // is exactly why the validation lives there and only the trusted RESULT
  // crosses into this file.
  //
  // Provenance: the base line (no extended date, the overwhelming common
  // case) is unchanged from before this item - a plain oneProv atom
  // against data.identity.rightToWork. The extended line reuses the exact
  // template-provenance shape js/letterbuild.js's templateProv() already
  // established for letter blocks ({ template: { ref, field, slots } }) -
  // js/verify.js's expectedFromProv() recognises this shape generically
  // (it re-runs Matcher.slotRe()-based substitution against ref[field],
  // it does not care whether ref is a letterBlocks entry or data.identity),
  // so no change to js/verify.js was needed to make this provable.
  function buildAuthLine(data, startDate) {
    if (!startDate || !startDate.appliesExtended || !startDate.text) {
      return { text: data.identity.rightToWork, prov: oneProv(data.identity, "rightToWork") };
    }
    var slots = { ADSTARTDATE: startDate.text };
    var template = data.identity.rightToWorkExtendedTemplate;
    var text = String(template).replace(Matcher.slotRe(), function (m, key) {
      var v = slots[key];
      return v == null ? m : v;
    });
    if (Matcher.slotRe().test(text)) {
      throw new Error("assemble.js: data.identity.rightToWorkExtendedTemplate still has an unfilled {{SLOT}} after substitution.");
    }
    return {
      text: text,
      prov: { template: { ref: data.identity, field: "rightToWorkExtendedTemplate", slots: slots } }
    };
  }

  // Section headings must be sourced from SOME archetype's sectionOrder
  // array (itself data-file content), never hand-typed - searches every
  // archetype, not just the current one, since the same heading text can
  // legitimately appear under more than one archetype.
  //
  // sectionOrder entries are {type, heading} objects (data _version 1.1,
  // 13 Sept 2026 review fix - see _sectionRule) - code dispatches on
  // `type`, never on `heading`, but the heading STRING is still the thing
  // that has to trace back to the data file for the provenance gate, so
  // this looks for it in the `.heading` field of each entry.
  function findSectionOrderRef(data, headingText) {
    for (var i = 0; i < data.archetypes.length; i++) {
      var so = data.archetypes[i].sectionOrder;
      for (var j = 0; j < so.length; j++) {
        if (so[j].heading === headingText) return { ref: so[j], field: "heading" };
      }
    }
    return null;
  }

  function headBlock(data, headingText) {
    var ref = findSectionOrderRef(data, headingText);
    if (!ref) {
      throw new Error("assemble.js: heading '" + headingText + "' does not appear verbatim in " +
        "any archetype's sectionOrder - it can't be traced to the data file, so verify.js's " +
        "provenance gate would have no way to check it. Add it to some archetype's sectionOrder, " +
        "or fix whatever produced this string.");
    }
    return {
      t: "head",
      text: headingText,
      _prov: { text: oneProv(ref.ref, ref.field) }
    };
  }

  // --- Phase 5: JD-overlap scoring helpers ----------------------------------
  // `extraction` is js/score.js's CVScore.extractFromJD() output, or
  // null/undefined when no JD has been pasted yet - every function here
  // treats that as "everything scores 0", which is what makes the no-JD
  // case fall out of the same code as a JD that happens to match nothing,
  // rather than needing a separate branch.
  //
  // Overlap is counted against extraction.keywordHits - a plain
  // {tag-lowercased: hitCount} dict that js/score.js builds from every tag
  // used anywhere in the data file (skillLines terms, bulletVariants
  // variants, AND profileVariants - see score.js's allKnownTags()), so a
  // profile variant's tags are just as visible to this check as a bullet
  // variant's. Reading that dict (rather than re-deriving hit counts here)
  // keeps this file decoupled from score.js's normalize/countHits logic -
  // it only ever reads a plain data object, same as everything else here.
  function overlapScore(tags, extraction) {
    if (!extraction) return 0;
    var hits = extraction.keywordHits || {};
    var count = 0;
    (tags || []).forEach(function (tag) {
      if (hits[String(tag).toLowerCase()]) count++;
    });
    return count;
  }

  // Highest-scoring candidate, ties going to whichever appears first in
  // `candidates` - deliberately a manual scan (only replace on a STRICT
  // improvement), not Array.sort, so first-listed-wins is guaranteed by
  // construction rather than by relying on sort stability.
  // 2 Oct 2026: the automatic pick never chooses a variant whose own text
  // carries a data.neverClaim term (the never-claim gate would then block
  // the whole CV) while a clean sibling exists. Found because one approved
  // variant (bulletVariants.b-report, presentation wording) says
  // "anomaly-detection", which the gate used to miss and the Davy Group
  // business-analyst ad auto-picked. Picking it by hand is still possible -
  // and then the gate blocks the download and says why. (That variant was
  // deleted on 3 Oct 2026, data 1.27; this stays as the safety net.)
  function cleanVariants(data, variants) {
    var list = data.neverClaim || [];
    var clean = (variants || []).filter(function (v) { return !Matcher.scanListJoined(v.text || "", list).length; });
    return clean.length ? clean : variants;
  }

  function pickBestVariant(candidates, tagsOf, extraction) {
    var best = candidates[0];
    var bestScore = overlapScore(tagsOf(best), extraction);
    for (var i = 1; i < candidates.length; i++) {
      var s = overlapScore(tagsOf(candidates[i]), extraction);
      if (s > bestScore) { best = candidates[i]; bestScore = s; }
    }
    return best;
  }

  // Descending sort by scoreFn(item), stable by original index regardless
  // of the JS engine's own Array.sort stability guarantees - see file
  // header ("Tie-breaks all resolve to first-listed by construction").
  function stableSortDesc(items, scoreFn) {
    return items
      .map(function (item, i) { return { item: item, i: i, score: scoreFn(item) }; })
      .sort(function (a, b) { return b.score !== a.score ? b.score - a.score : a.i - b.i; })
      .map(function (x) { return x.item; });
  }

  // Every bullet group listed for a role/project is included (spec 5.3;
  // see file header - the old priority<=2 filter was a Phase 3 stopgap and
  // is gone). For each group, the highest-tag-overlap variant is chosen;
  // the resulting bullets are then ordered by that same score, highest
  // first, ties keeping the group's original order in the role's own
  // `bullets` array.
  //
  // `groupMeta` (Phase 6 addition) identifies which role/project this call
  // is building bullets for - {kind: 'role'|'project', id, sectionType}.
  // Every returned bullet block carries it as `_group`, plus `_trim`. This
  // is NOT rendered by preview.js/render-docx.js (they only read known
  // block fields) - it exists purely so js/trim.js can execute the trim
  // ladder against a built model without having to re-derive "which role
  // does this bullet belong to, and how important is it" structurally from
  // a flat block array, which is what silently breaks if a section's block
  // shape ever changes. groupMeta is required; a missing one is a caller
  // bug, not something to default away.
  //
  // 19 Sept 2026 (Derin's "A-E" spec, part A/B): `_trim.priority` (an
  // integer 1-5) is gone - the data file no longer has bulletVariants[gid].
  // priority at all, only `basis: {strength, why}` (part of the same pass
  // that pulled work-order step 4 forward - see data.trimPolicy for why).
  // `_trim.strength` carries the same role priority used to, but as the
  // basis vocabulary (required/core/support/filler) js/trim.js's new
  // shorten-then-drop ladder actually orders by. `_trim.ref` is a live
  // object reference to the CHOSEN variant itself (same "live reference,
  // not a copy" principle _prov already uses) - js/trim.js reads
  // `_trim.ref.short`/`_trim.ref.shortHeightPx` directly off it to decide
  // whether a block can be shortened at all, without needing a second
  // lookup back into data.bulletVariants. `_trim.shortApplied` starts
  // false; js/trim.js's shorten step flips it (on a NEW block object, not
  // by mutating this one - see trim.js's own header) so a block is never
  // shortened twice.
  function bulletBlocksFor(data, groupIds, extraction, groupMeta, bulletChoices) {
    if (!groupMeta) {
      throw new Error("assemble.js: bulletBlocksFor() called without groupMeta - every bullet must be traceable to a role/project for trim-ladder execution (Phase 6).");
    }
    var scored = groupIds.map(function (gid) {
      var group = data.bulletVariants[gid];
      if (!group || !group.variants || !group.variants.length) {
        throw new Error("assemble.js: bulletVariants['" + gid + "'] is missing or empty");
      }
      if (!group.basis || !group.basis.strength) {
        throw new Error("assemble.js: bulletVariants['" + gid + "'] has no basis.strength - every group must state one (js/validate.js should have already caught this at load time).");
      }
      // opts.choices.bullets (2 Oct 2026): Derin's own pick for this group,
      // when it names one of the group's own approved variants; anything
      // else (no pick, a stale id) falls back to the tag-overlap pick.
      var picked = bulletChoices && bulletChoices[gid] ? findById(group.variants, bulletChoices[gid]) : null;
      var variant = picked || pickBestVariant(cleanVariants(data, group.variants), function (v) { return v.tags; }, extraction);
      return { variant: variant, score: overlapScore(variant.tags, extraction), gid: gid, strength: group.basis.strength };
    });
    return stableSortDesc(scored, function (x) { return x.score; }).map(function (x) {
      return {
        t: "bullet", text: x.variant.text, _prov: { text: oneProv(x.variant, "text") },
        _group: groupMeta,
        _trim: { kind: "bullet", groupId: x.gid, strength: x.strength, score: x.score, ref: x.variant, shortApplied: false }
      };
    });
  }

  function pickProfile(data, archetype, extraction, profileId) {
    // opts.choices.profile (2 Oct 2026): any approved profile variant
    // Derin picks, including one written for another archetype ("all
    // approved versions", his own answer). A stale id falls back to auto.
    if (profileId) {
      var picked = findById(data.profileVariants, profileId);
      if (picked) return picked;
    }
    var candidates = cleanVariants(data, data.profileVariants.filter(function (p) {
      return p.archetypes.indexOf(archetype.id) !== -1;
    }));
    if (!candidates.length) {
      throw new Error("assemble.js: no profileVariants entry lists archetype '" + archetype.id + "'");
    }
    return pickBestVariant(candidates, function (p) { return p.tags; }, extraction);
  }

  // --- Section builders. Each returns { headingText, blocks } - the head
  // block itself is built centrally by buildModel via headBlock(), so every
  // section gets the same provenance treatment for its heading instead of
  // each builder re-typing (and re-provenancing) the same literal - or
  // returns null/[] to mean "nothing to show, omit the whole section". ---

  // 19 Sept 2026 (Derin's "A-E" spec, part A): the profile paragraph now
  // carries `_trim` too, same shape as a bullet's (see bulletBlocksFor) -
  // "The profile is `required` and is the single most-shortened block in
  // the real documents" (Derin's own words). `_group` is deliberately
  // omitted (a profile isn't part of a role/project entry that could ever
  // be dropped whole), so js/trim.js's drop step - which only ever
  // touches `t === 'bullet'` blocks - can never remove it; the shorten
  // step, which has no such restriction, is how a profile actually gets
  // shortened.
  function buildProfile(data, archetype, headingText, extraction, choices) {
    var variant = pickProfile(data, archetype, extraction, choices && choices.profile);
    if (!variant.basis || !variant.basis.strength) {
      throw new Error("assemble.js: profileVariants['" + variant.id + "'] has no basis.strength - every profile variant must state one.");
    }
    return {
      headingText: headingText,
      blocks: [
        {
          t: "para", text: variant.text,
          opts: { after: data.style.spacingAfter.profile },
          _prov: { text: oneProv(variant, "text") },
          _trim: { kind: "profile", groupId: variant.id, strength: variant.basis.strength, score: overlapScore(variant.tags, extraction), ref: variant, shortApplied: false }
        }
      ]
    };
  }

  // Categories and their order come from the archetype, unchanged. Within
  // a category, terms are reordered - JD-hit terms first, then everything
  // else in the file's own order - but a term is NEVER dropped for lacking
  // a hit (spec 5.3, verbatim: "never drop a term for having no hits - drop
  // only if the archetype excludes the whole category"). The reorder is a
  // stable partition (hit-terms, in file order; then non-hit terms, in file
  // order), via the same index-tie-broken stableSortDesc used for bullets,
  // so with no extraction every term scores 0 and the original file order
  // comes back unchanged.
  function buildSkills(data, archetype, headingText, extraction, choices) {
    var blocks = [];
    // opts.choices.skills (2 Oct 2026): use another archetype's own
    // approved category list (its skillCategories, in its order) - a choice
    // between existing lists, never a new combination.
    var source = (choices && choices.skills && findById(data.archetypes, choices.skills)) || archetype;
    source.skillCategories.forEach(function (catKey) {
      var cat = data.skillLines[catKey];
      if (!cat) throw new Error("assemble.js: archetype '" + archetype.id + "' references unknown skill category '" + catKey + "'");
      var ordered = stableSortDesc(cat.terms, function (term) {
        return overlapScore(term.tags, extraction) > 0 ? 1 : 0;
      });
      var atoms = ordered.map(function (term) { return { ref: term, field: "text" }; });
      var text = ordered.map(function (term) { return term.text; }).join(data.style.separator);
      blocks.push({
        t: "skillLine", label: cat.label, text: text,
        _prov: {
          label: oneProv(cat, "label"),
          text: textProv(atoms, data.style.separator)
        }
      });
    });
    return { headingText: headingText, blocks: blocks };
  }

  // Bug found and fixed during Phase 6 verification: this used to read only
  // data.facts.projects (plural), but the data file has never had that key -
  // it has always been data.facts.project, ONE object (proj-smmd), singular.
  // selectInOrder(undefined, includeIds) would throw the instant findById
  // touched `list.length` on undefined, so every archetype with a
  // project-type section (graduate-programme, consulting-tech,
  // business-analyst, analyst-bi, finance-ops - 5 of 8) was actually broken:
  // recompute()'s own try/catch caught it and showed the build-error banner,
  // which is why this had gone unnoticed - a caught exception, not an
  // uncaught page error, and no earlier test had checked the banner itself
  // for these five archetypes, only listened for uncaught errors. js/
  // validate.js already defends against exactly this singular/plural
  // ambiguity (see its factIds and bulletBearers construction) - same fix
  // applied here instead of changing the data file, since nothing about
  // "there is one project fact today" needed to change, only this file's
  // assumption about which key it lives under.
  function buildProjects(data, includeIds, headingText, extraction, choices) {
    var projectFacts = (data.facts.projects || []).slice();
    if (data.facts.project) projectFacts.push(data.facts.project);
    var projects = selectInOrder(projectFacts, includeIds);
    if (!projects.length) return null;
    var blocks = [];
    projects.forEach(function (proj) {
      var groupMeta = { kind: "project", id: proj.id, sectionType: "project" };
      blocks.push({
        t: "role", title: proj.title, org: null, right: proj.stack,
        _prov: { title: oneProv(proj, "title"), right: oneProv(proj, "stack") },
        _group: groupMeta
      });
      blocks.push({ t: "dates", text: proj.org, _prov: { text: oneProv(proj, "org") }, _group: groupMeta });
      blocks = blocks.concat(bulletBlocksFor(data, proj.bullets, extraction, groupMeta, choices && choices.bullets));
    });
    return { headingText: headingText, blocks: blocks };
  }

  function buildExperience(data, includeIds, headingText, extraction, choices) {
    var roles = selectInOrder(data.facts.roles, includeIds);
    if (!roles.length) return null;
    var blocks = [];
    roles.forEach(function (role) {
      var groupMeta = { kind: "role", id: role.id, sectionType: "experience" };
      blocks.push({
        t: "role", title: role.title, org: role.org, right: role.right || null,
        _prov: { title: oneProv(role, "title"), org: oneProv(role, "org"), right: role.right ? oneProv(role, "right") : null },
        _group: groupMeta
      });
      blocks.push({ t: "dates", text: role.dates, _prov: { text: oneProv(role, "dates") }, _group: groupMeta });
      blocks = blocks.concat(bulletBlocksFor(data, role.bullets, extraction, groupMeta, choices && choices.bullets));
    });
    return { headingText: headingText, blocks: blocks };
  }

  function buildEducation(data, includeIds, headingText) {
    var entries = selectInOrder(data.facts.education, includeIds);
    if (!entries.length) return null;
    var blocks = [];
    entries.forEach(function (e) {
      blocks.push({
        t: "role", title: e.title, org: e.org,
        _prov: { title: oneProv(e, "title"), org: oneProv(e, "org") }
      });
      blocks.push({ t: "dates", text: e.dates, _prov: { text: oneProv(e, "dates") } });
      // printModules must be explicitly true - edu-bms carries all 13
      // modules for keyword matching but must never print them in full on
      // a CV (see CV-fact-bank.md); only edu-msc's modules are meant to
      // print. Defaulting to "don't print" when the flag is absent is the
      // safe direction for a fact the app hasn't been told is printable.
      if (e.printModules && e.modules && e.modules.length) {
        var atoms = e.modules.map(function (_, i) { return { ref: e.modules, field: i }; });
        blocks.push({
          t: "para",
          text: "Modules: " + e.modules.join(", "),
          opts: { size: data.style.sizes.small, after: data.style.spacingAfter.modules },
          // "Modules: " is fixed UI chrome, not a claim about Derin - see
          // file header. Recorded explicitly as a prefix so it's still
          // part of what gets checked, not silently unverified.
          _prov: { text: textProv(atoms, ", ", "Modules: ") },
          // 21 Sept 2026, Derin: "Give the modules line basis strength
          // 'support', so the trim ladder can drop it under page pressure
          // like anything else." No `.short` variant exists for this block
          // (there is nothing shorter than the module list itself to swap
          // onto), so js/trim.js's SHORTEN step naturally skips it - canShorten()
          // rejects any ref with no `.short` string, same as every other
          // block. `droppable: true` is what makes it eligible for the DROP
          // step despite having no `_group`: unlike a bullet, this block is
          // not part of a role/project heading it could orphan, so it is
          // simply removable outright once support-strength content is
          // being dropped - see js/trim.js's pickDropTarget for the standalone-
          // droppable-para branch this flag opts into.
          _trim: { kind: "modules", groupId: e.id, strength: "support", ref: e, shortApplied: false, droppable: true }
        });
      }
    });
    return { headingText: headingText, blocks: blocks };
  }

  // Certifications, optionally folding in volunteering under the same
  // heading. The heading text is used exactly as the archetype's own
  // sectionOrder gives it - no more runtime guessing between
  // "CERTIFICATIONS" and "CERTIFICATIONS AND VOLUNTEERING" via a substring
  // regex (that was a review finding: a fragile heuristic that only existed
  // because heading text varied per archetype; each archetype's data now
  // just states the heading it actually wants, and volunteering is
  // included or not per that archetype's own `include` list, same as any
  // other fact). If an archetype's data ever mismatches (heading says
  // "AND VOLUNTEERING" but volunteering isn't actually in `include`, or
  // vice versa), that is a data-authoring bug to fix in the JSON, not
  // something this function should paper over by re-deriving the heading
  // itself.
  function buildCertificationsAndVolunteering(data, includeIds, headingText) {
    var certs = selectInOrder(data.facts.certifications, includeIds);
    var vol = data.facts.volunteering && includeIds.indexOf(data.facts.volunteering.id) !== -1
      ? data.facts.volunteering
      : null;
    if (!certs.length && !vol) return null;

    var resolvedHeading = headingText;
    var blocks = [];
    certs.forEach(function (c) {
      var atoms = c.items.map(function (it) { return { ref: it, field: "display" }; });
      var itemsText = c.items.map(function (it) { return it.display; }).join(data.style.separator);
      blocks.push({
        t: "para", text: itemsText,
        opts: { after: data.style.spacingAfter.certItem },
        _prov: { text: textProv(atoms, data.style.separator) }
      });
      blocks.push({
        t: "para",
        text: c.body,
        opts: { size: data.style.sizes.small, italics: true, color: data.style.colours.grey, after: data.style.spacingAfter.certBody },
        _prov: { text: oneProv(c, "body") }
      });
    });
    if (vol) {
      blocks.push({
        t: "para", text: vol.text,
        opts: { size: data.style.sizes.small, after: 0 },
        _prov: { text: oneProv(vol, "text") }
      });
    }
    return { headingText: resolvedHeading, blocks: blocks };
  }

  // Dispatches on `sectionType` (a stable slug: profile/skills/experience/
  // project/education/certifications - see data._sectionRule), never on
  // display heading text. This is the direct fix for the review's biggest
  // confirmed bug: the old version dispatched on the exact heading STRING,
  // so customer-ops's now-deleted "ADDITIONAL EXPERIENCE" heading had no
  // matching branch and fell through to the throw below - and because that
  // throw happened partway through buildModel, the caller's `model`
  // variable never got reassigned, silently leaving a stale previous
  // archetype's CV on screen under the new archetype's label. Dispatching
  // on type means renaming a heading in the data file (SKILLS vs KEY
  // SKILLS, CERTIFICATIONS vs CERTIFICATIONS AND VOLUNTEERING) can never
  // break section building - only an actually-new section TYPE can, and
  // that's exactly the case this still throws loudly for, so the caller
  // can catch it and show a visible error instead of a silent stale render
  // (see index.html/app.js's recompute(), which now does exactly that).
  function buildSection(data, archetype, includeIds, sectionType, headingText, extraction, choices) {
    switch (sectionType) {
      case "profile": return buildProfile(data, archetype, headingText, extraction, choices);
      case "skills": return buildSkills(data, archetype, headingText, extraction, choices);
      case "project": return buildProjects(data, includeIds, headingText, extraction, choices);
      case "experience": return buildExperience(data, includeIds, headingText, extraction, choices);
      case "education": return buildEducation(data, includeIds, headingText);
      case "certifications": return buildCertificationsAndVolunteering(data, includeIds, headingText);
      default:
        throw new Error("assemble.js: no section builder for sectionOrder type '" + sectionType + "' (heading '" + headingText + "', archetype '" + archetype.id + "') - this is a hard failure by design (see data._sectionRule); it must surface on screen, never a silent stale render.");
    }
  }

  // opts.excludeFactIds: fact ids to leave out even though the archetype's
  // own include list has them - e.g. ["vol"] to drop volunteering from one
  // specific CV without changing the archetype's default for everyone else.
  // This is a Phase-3 stopgap; Phase 6's real trimPolicy execution replaces
  // the need for it.
  //
  // opts.extraction: js/score.js's CVScore.extractFromJD(data, jdText)
  // output, or omitted/null when no JD has been pasted yet. This is the
  // ONLY new input Phase 5 adds to buildModel - which archetypeId to pass
  // (auto-picked via CVScore.pickArchetype(), or manually overridden) is
  // still the caller's decision, same as Phase 3/4.
  // opts.choices (2 Oct 2026, the per-section dropdowns): Derin's own picks,
  // every one an id of something already approved in the data file -
  //   profile: a profileVariants id
  //   skills:  an archetype id whose skillCategories list to print
  //   roles:   an archetype id whose experience roles (and their order) to
  //            print instead of this archetype's own
  //   bullets: { bulletVariants group id: variant id }
  // Nothing here composes text; a pick only changes WHICH approved entry
  // gets selected, so provenance, the never-claim scan and the trim ladder
  // all apply exactly as before. A missing or stale id means "auto" - the
  // same selection buildModel always made - never an error.
  function buildModel(data, archetypeId, opts) {
    opts = opts || {};
    var excludeFactIds = opts.excludeFactIds || [];
    var extraction = opts.extraction || null;
    var choices = opts.choices || null;
    var archetype = findById(data.archetypes, archetypeId);
    if (!archetype) throw new Error("assemble.js: unknown archetype id '" + archetypeId + "'");

    var includeIds = archetype.include.filter(function (id) {
      return excludeFactIds.indexOf(id) === -1;
    });
    var roleSource = choices && choices.roles ? findById(data.archetypes, choices.roles) : null;
    if (roleSource) {
      var roleIds = data.facts.roles.map(function (r) { return r.id; });
      includeIds = includeIds.filter(function (id) { return roleIds.indexOf(id) === -1; })
        .concat(roleSource.include.filter(function (id) { return roleIds.indexOf(id) !== -1 && excludeFactIds.indexOf(id) === -1; }));
    }

    var authLine = buildAuthLine(data, opts.startDate);
    var model = [
      { t: "name", text: data.identity.name, _prov: { text: oneProv(data.identity, "name") } },
      {
        t: "contact", items: data.identity.contact,
        _prov: { items: data.identity.contact.map(function (it) { return oneProv(it, "text"); }) }
      },
      { t: "auth", text: authLine.text, _prov: { text: authLine.prov } },
      { t: "spacer" }
    ];

    archetype.sectionOrder.forEach(function (so) {
      var section = buildSection(data, archetype, includeIds, so.type, so.heading, extraction, choices);
      if (section && section.blocks.length) {
        model.push(headBlock(data, section.headingText));
        model = model.concat(section.blocks);
      }
    });

    fixLastParagraphSpacing(model);
    return model;
  }

  // The document's actual last paragraph should carry no trailing spacing -
  // matches what was done by hand in Phases 1-2. Only adjusts para blocks;
  // bullets/dates/etc. keep their own fixed spacing regardless of position.
  // Purely a spacing tweak - doesn't touch text or _prov. Exported (Phase 6)
  // so js/trim.js's caller can re-apply it after trimming changes which
  // block actually ends the document - mutates the model array in place,
  // same as buildModel's own original inline version did.
  function fixLastParagraphSpacing(model) {
    var last = model[model.length - 1];
    // letterPara/letterLine (21 Sept 2026, cover-letter renderer) added
    // alongside "para" - a letter's own last block (the signature name) is
    // a letterLine, not a para, and deserves the same "no trailing
    // spacing" treatment for the same reason.
    if (last && (last.t === "para" || last.t === "letterPara" || last.t === "letterLine")) {
      last.opts = last.opts || {};
      last.opts.after = 0;
    }
    return model;
  }

  // overlapScore/pickBestVariant/stableSortDesc exported (Phase 7 addition,
  // 18 Sept 2026): js/letterbuild.js needs the exact same tag-overlap +
  // strict-improvement tie-break discipline for letterBlocks "why"/
  // "evidence" selection that this file already uses for profile/bullet
  // selection. Exporting rather than re-implementing keeps there being
  // exactly one tie-break algorithm in the app, not two that have to be
  // kept in sync by hand. No existing caller or behaviour changes - this
  // is additive only.
  // What buildModel picks on its own for this archetype and ad (2 Oct 2026):
  // the "Recommended" option in each CV section dropdown. Same functions
  // buildModel itself calls, so the two can never disagree.
  function autoPicks(data, archetypeId, extraction) {
    var archetype = findById(data.archetypes, archetypeId);
    if (!archetype) return null;
    var bullets = {};
    Object.keys(data.bulletVariants).forEach(function (gid) {
      var group = data.bulletVariants[gid];
      if (group && group.variants && group.variants.length) {
        bullets[gid] = pickBestVariant(cleanVariants(data, group.variants), function (v) { return v.tags; }, extraction).id;
      }
    });
    return {
      profile: pickProfile(data, archetype, extraction).id,
      skills: archetype.id,
      roles: archetype.id,
      bullets: bullets
    };
  }

  global.CVAssemble = {
    buildModel: buildModel,
    autoPicks: autoPicks,
    findById: findById,
    fixLastParagraphSpacing: fixLastParagraphSpacing,
    overlapScore: overlapScore,
    pickBestVariant: pickBestVariant,
    stableSortDesc: stableSortDesc,
    // 21 Sept 2026 (cover-letter renderer): js/letter.js reuses these two
    // for the letter's own name/contact header blocks, which read straight
    // off data.identity exactly the way buildModel() above does for the CV
    // - same provenance shape, same source fields, so it reuses this file's
    // own helpers instead of a second hand-typed copy of the same atom
    // format.
    textProv: textProv,
    oneProv: oneProv
  };
})(typeof window !== "undefined" ? window : globalThis);
