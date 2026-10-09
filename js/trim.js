// ---------------------------------------------------------------------------
// Phase 6 (original) + 19 Sept 2026 rewrite (Derin's "A-E" spec, part A -
// "Option (a). Build it ahead of its place in the order of work.").
//
// Derin's own reasoning, verbatim: "in 3 years of real hand-built
// documents, page-fit has NEVER been solved by deleting a section - always
// by shortening. trim.js doing only deletion is the wrong primary
// operation." This file's ladder is now, in order:
//
//   1. SHORTEN - swap a block to its `.short` text, one at a time,
//      re-measuring after each, stopping the moment the model fits. Order:
//      strength ascending (filler -> support -> core -> required), then
//      within a strength, by the block's CURRENT rendered height,
//      descending. Every strength is eligible here, including core and
//      required - "The profile is `required` and is the single most-
//      shortened block in the real documents" (Derin's own words). A block
//      with no `.short` is simply not a candidate (not an error - see
//      js/validate.js's coverage reporter for visibility into how many
//      blocks actually have one).
//   2. DROP - only once step 1 is fully exhausted (nothing left with an
//      un-applied `.short`) and it STILL overflows. Drop filler first, then
//      support - never core, never required - "last-included-first" within
//      a strength band (the bullet that appears LATEST in the model, i.e.
//      the one bulletBlocksFor's own JD-overlap ordering trusted least,
//      goes first). The pre-existing invariant "never leave a heading with
//      no bullets under it" still holds: dropping a group's last remaining
//      bullet is skipped in favour of another candidate at the same
//      strength where one exists; where none exists, the whole entry
//      (heading + dates + bullets) is removed together, same tie-break.
//   3. HARD FAILURE - once both steps are exhausted, applyOneStep() returns
//      {applied: false}. The caller (js/app.js) is the one that turns that
//      into "refuse the download, name it on screen, list what was
//      shortened and dropped" (Derin: "Never emit two pages silently") -
//      via the existing Page-fit gate in js/verify.js's runGates(), which
//      already disables the download button whenever CVPageFit.measure()
//      still reports an overflow after this loop gives up. This file's own
//      job stops at "here is one more thing I can still do, or nothing."
//
// Pure data in, data out, EXCEPT for one read-only dependency this rewrite
// adds: js/pagefit.js's CVPageFit.heightForBlock(), used only to compare
// two candidate blocks' CURRENT rendered heights for the shorten step's own
// tie-break (part A: "within a strength, by current rendered height
// descending"). This file still never touches the DOM, never sums a whole
// model's height, and never decides "does this fit" - that stays
// js/app.js's loop (render, measure, call applyOneStep(), re-render,
// re-measure, repeat), same layering as before.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var PageFit = global.CVPageFit;
  if (!PageFit) {
    throw new Error("trim.js loaded before js/pagefit.js. Check <script> order.");
  }

  // Ascending = shorten this strength first. Deliberately the same four
  // strings data.trimPolicy/js/validate.js's STRENGTH enum uses everywhere
  // else in this app - no numeric priority left anywhere in this file.
  var SHORTEN_ORDER = ["filler", "support", "core", "required"];
  // Only these two strengths may ever be DROPPED - "Never drop core. Never
  // drop required." (Derin, verbatim). Order matters: filler before support.
  var DROPPABLE_ORDER = ["filler", "support"];

  function isTrimmable(b) {
    return !!b._trim && (b.t === "bullet" || b.t === "para");
  }

  function bulletCountForGroup(model, groupId) {
    var n = 0;
    model.forEach(function (b) {
      if (b.t === "bullet" && b._group && b._group.id === groupId) n++;
    });
    return n;
  }

  // ---- SHORTEN step ---------------------------------------------------------

  // linesSaved === 0 (20 Sept 2026, Derin's own instruction: "A short
  // variant that does not save a line is strictly worse than no short
  // variant. It burns a ladder step, loses information, and gains nothing.
  // ... SKIP THEM AT RUNTIME. The trim ladder skips any short with
  // linesSaved === 0. Do not swap it, do not count it as a step.") - a
  // zero-saving short is filtered out here, at the SAME point a missing
  // `.short` already is, so pickShortenTarget's caller sees no difference
  // between "no short exists" and "a short exists but would not help":
  // neither is ever picked. Checked with `=== 0` specifically (not falsy)
  // so a ref that has never been measured (linesSaved undefined - an old
  // block from before this field existed, or a synthetic test object) is
  // NOT skipped by this check - that stays governed purely by whether
  // ref.short exists, same as before this pass.
  function canShorten(b) {
    if (!isTrimmable(b) || b._trim.shortApplied) return false;
    var ref = b._trim.ref;
    if (!ref || typeof ref.short !== "string" || !ref.short.length) return false;
    if (ref.linesSaved === 0) return false;
    return true;
  }

  // Strength ascending, then current rendered height descending, ties kept
  // in model order (first-listed-wins, same discipline as every other
  // tie-break in this app) - a manual scan with strict-improvement
  // replacement only, same construction as js/assemble.js's pickBestVariant,
  // for the same reason: guaranteed by construction, not by relying on
  // Array.sort's stability.
  function pickShortenTarget(model, docType) {
    var best = null;
    var bestRank = -1;
    var bestHeight = -1;
    model.forEach(function (b) {
      if (!canShorten(b)) return;
      var rank = SHORTEN_ORDER.indexOf(b._trim.strength);
      if (rank === -1) return; // unknown strength - js/validate.js should already have refused to load this data file
      var height = PageFit.heightForBlock(b, docType);
      if (!best || rank < bestRank || (rank === bestRank && height > bestHeight)) {
        best = b; bestRank = rank; bestHeight = height;
      }
    });
    return best;
  }

  // Returns a NEW block object with .text/.field swapped to the variant's
  // `.short` - never mutates the block passed in (this app's data-flow
  // convention: js/assemble.js builds fresh objects, js/trim.js's own DROP
  // helpers below use Array#filter for the same reason, and this file's
  // header already documents that it is "pure data in, data out"). Setting
  // `_prov.text.field` to "short" (rather than "text") is what makes
  // js/verify.js's existing, unmodified provenance gate keep working
  // unchanged - resolveAtom() there is `atom.ref[atom.field]`, fully
  // generic already, so it now checks the shortened block's text against
  // `ref.short` instead of `ref.text` with no verify.js change needed at
  // all.
  function shortenBlock(block, docType) {
    var ref = block._trim.ref;
    var newBlock = {};
    Object.keys(block).forEach(function (k) { newBlock[k] = block[k]; });
    newBlock.text = ref.short;
    var oldProv = block._prov.text;
    newBlock._prov = {};
    Object.keys(block._prov).forEach(function (k) { newBlock._prov[k] = block._prov[k]; });
    newBlock._prov.text = {
      atoms: [{ ref: ref, field: "short" }],
      join: null,
      prefix: oldProv.prefix || "",
      suffix: oldProv.suffix || ""
    };
    newBlock._trim = {};
    Object.keys(block._trim).forEach(function (k) { newBlock._trim[k] = block._trim[k]; });
    newBlock._trim.shortApplied = true;
    return newBlock;
  }

  function applyShorten(model, docType) {
    var target = pickShortenTarget(model, docType);
    if (!target) return null;
    var shortened = shortenBlock(target, docType);
    var newModel = model.map(function (b) { return b === target ? shortened : b; });
    var label = target._trim.kind === "profile" ? "the profile paragraph" : "\"" + target._trim.groupId + "\"";
    return {
      model: newModel,
      applied: true,
      phase: "shorten",
      description: "Shortened " + label + " (" + target._trim.strength + ") to its .short variant (trim step 1)."
    };
  }

  // ---- DROP step -------------------------------------------------------------

  // Two kinds of block are eligible here: a `t: 'bullet'` (part of a
  // role/project group, subject to the orphan-avoidance invariant below),
  // and a standalone `t: 'para'` block explicitly marked `_trim.droppable`
  // (21 Sept 2026 - the education "Modules:" line is the first of these;
  // see js/assemble.js's buildEducation). A droppable para has no `_group`
  // and is not a bullet under a heading it could orphan, so it carries no
  // orphan-avoidance concern at all - it is just removable outright, same
  // strength-then-last-included-first ordering as everything else.
  function pickDropTarget(model) {
    for (var s = 0; s < DROPPABLE_ORDER.length; s++) {
      var strength = DROPPABLE_ORDER[s];
      var atStrength = [];
      for (var i = 0; i < model.length; i++) {
        var b = model[i];
        var eligible = (b.t === "bullet" && b._trim && b._trim.strength === strength) ||
          (b.t === "para" && b._trim && b._trim.strength === strength && b._trim.droppable === true);
        if (eligible) atStrength.push(b);
      }
      if (!atStrength.length) continue;
      // Never drop a group's last remaining bullet if an alternative at
      // this same strength exists (invariant carried over, unchanged, from
      // the pre-19-Sept ladder: "never leave a heading with no bullets
      // under it"). Only when EVERY candidate at this strength would
      // orphan its group does the whole entry go instead. A standalone
      // droppable para has no group to orphan, so it always counts as
      // non-orphaning.
      var nonOrphaning = atStrength.filter(function (b) {
        if (b.t !== "bullet") return true;
        return bulletCountForGroup(model, b._group.id) > 1;
      });
      var pool = nonOrphaning.length ? nonOrphaning : atStrength;
      // "last-included-first": pool is in model order (ascending index),
      // so the end of the array is the one that appears latest.
      var chosen = pool[pool.length - 1];
      return { block: chosen, wholeEntry: chosen.t === "bullet" && !nonOrphaning.length };
    }
    return null;
  }

  function removeGroup(model, groupId) {
    return model.filter(function (b) { return !(b._group && b._group.id === groupId); });
  }

  function removeBullet(model, bulletBlock) {
    return model.filter(function (b) { return b !== bulletBlock; });
  }

  function applyDrop(model) {
    var pick = pickDropTarget(model);
    if (!pick) return null;
    var target = pick.block;
    // Standalone droppable para (e.g. the education modules line): no
    // `_group`, nothing to orphan, just remove the one block.
    if (target.t === "para") {
      return {
        model: removeBullet(model, target),
        applied: true,
        phase: "drop",
        description: "Dropped \"" + target._trim.groupId + "\" " + target._trim.kind + " line (" + target._trim.strength +
          ") entirely (trim step 2, standalone droppable block)."
      };
    }
    var groupId = target._group.id;
    if (pick.wholeEntry) {
      return {
        model: removeGroup(model, groupId),
        applied: true,
        phase: "drop",
        description: "Dropped the whole \"" + groupId + "\" entry - every remaining " + target._trim.strength +
          " bullet in it would have orphaned its heading, so the entry went as a whole (trim step 2; never leaving a heading with no bullets)."
      };
    }
    return {
      model: removeBullet(model, target),
      applied: true,
      phase: "drop",
      description: "Dropped a " + target._trim.strength + " bullet (\"" + target._trim.groupId + "\") from \"" + groupId +
        "\" (trim step 2, filler before support, last-included-first)."
    };
  }

  // ---- Combined ladder --------------------------------------------------------
  // One atomic action per call: shorten if anything is still shortenable,
  // else drop if anything is still droppable, else {applied: false} - step
  // 3 (HARD FAILURE) is the caller's own job from there (see file header).
  function applyOneStep(model, docType) {
    docType = docType || "cv";
    var shorten = applyShorten(model, docType);
    if (shorten) return shorten;
    var drop = applyDrop(model);
    if (drop) return drop;
    return { model: model, applied: false, phase: null, description: null };
  }

  global.CVTrim = { applyOneStep: applyOneStep };
})(typeof window !== "undefined" ? window : globalThis);
