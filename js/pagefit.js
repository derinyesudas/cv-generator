// ---------------------------------------------------------------------------
// Third-review-pass redesign (17 Sept 2026), replacing js/preview.js's old
// DOM-measurement fit gate entirely. Full rationale in
// build-status-and-decision-log.md; the short version:
//
// Every sentence this app can print already exists as fixed text in the
// data file (given a fixed column width and font). That means a block's
// rendered height is not something to PREDICT from a browser's own font
// metrics - it is something to MEASURE ONCE, offline, in the real renderer
// (LibreOffice, via tests/golden/measure-blocks.js), store on the fact
// that produced it, and SUM at generation time. The old approach rendered
// an HTML mirror in the browser and measured its scrollHeight, then
// subtracted a 120px guessed safety margin because Chrome's own Times New
// Roman line-wrapping doesn't match Word/LibreOffice's closely enough to
// trust directly (see README.md's "browser-based page-fit measurement
// understated real overflow" - a real CV that browser-measured "104px to
// spare" actually spilled two lines onto a second page). This file removes
// that whole error term by construction: nothing here ever asks a browser
// to measure anything. It only does arithmetic against numbers measured
// once, offline, against the exact renderer that produces the real .docx.
//
// Two block kinds are NOT fixed text and so get no stored heightPx
// constant - their real height is computed live, via js/textwrap.js's
// greedy wrap simulator, using the same measured character-advance-width
// table the offline measurement used:
//   - skillLine: js/assemble.js reorders each category's terms live
//     (JD-hit terms first), so a height measured against file order is
//     invalid the moment the order changes.
//   - letterBlocks with {{SLOT}} templates (Phase 7, cover letters - not
//     wired into any model yet, but letterBlockHeight() below is ready for
//     when it is): company/role/team names vary per application.
//
// This file never renders anything and never touches the DOM - js/
// preview.js still owns building the on-screen HTML mirror for Derin to
// look at. This file only answers "how tall is this model, in the SAME
// units and against the SAME renderer the real .docx download uses."
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var TextWrap = global.CVTextWrap;
  if (!TextWrap) {
    throw new Error("pagefit.js loaded before js/textwrap.js. Check <script> order.");
  }
  var BlockHash = global.CVBlockHash;
  if (!BlockHash) {
    throw new Error("pagefit.js loaded before js/blockhash.js. Check <script> order.");
  }

  var data = null;
  var META = null;
  var SP = null;

  function configure(d) {
    data = d;
    META = d._blockHeightMeta;
    SP = d.style.spacingAfter;
    if (!META) throw new Error("pagefit.js: data._blockHeightMeta is missing.");
    // 27 Sept 2026, item 6: was a data._version stamp comparison - see
    // js/blockhash.js's own header and js/validate.js's matching rewrite
    // for why. styleHash is a pure function of data.style, so this can
    // only fire on an ACTUAL style change now, never an unrelated version
    // bump.
    if (META.styleHash !== BlockHash.styleHash(d)) {
      throw new Error("pagefit.js: _blockHeightMeta.styleHash does not match data.style's current values - " +
        "the measured heights are stale. Re-run `node tests/golden/measure-blocks.js --apply` before building.");
    }
  }

  function requireConfigured() {
    if (!data) throw new Error("pagefit.js: configure(data) must be called before predict()/measure().");
  }

  // twips -> px directly (twips/1440in * 96px/in = twips/15) - same
  // conversion js/preview.js and js/render-docx.js already use.
  function twipsToPx(t) { return t / 15; }

  // Per-block-type spacing (before/after), in twips - must mirror
  // render-docx.js/preview.js's own layout exactly, since this is used to
  // predict the SAME document those files actually produce, not an
  // independent guess at its layout.
  function spacingFor(block) {
    switch (block.t) {
      case "name": return { before: 0, after: SP.name };
      case "contact": return { before: 0, after: SP.contact };
      case "auth": return { before: 0, after: SP.rightToWork };
      case "spacer": return { before: 0, after: SP.spacer };
      case "head": return { before: SP.headingBefore, after: SP.heading };
      case "role": return { before: SP.roleBefore, after: SP.role };
      case "dates": return { before: 0, after: SP.dates };
      case "bullet": return { before: 0, after: SP.bullet };
      case "skillLine": return { before: 0, after: SP.skillLine };
      case "para": return { before: 0, after: (block.opts && block.opts.after != null) ? block.opts.after : 36 };
      // letterPara (21 Sept 2026, cover-letter renderer): a templated
      // letterBlocks paragraph (opening/why/evidence/gap/close/signoff).
      // Spacing always comes from the block's own opts (js/letter.js sets
      // it to style.spacingAfter.letterPara for every one of these), never
      // a hardcoded fallback - unlike CV "para" blocks, there is no legacy
      // caller of this type that might omit opts.after.
      case "letterPara": return { before: 0, after: (block.opts && block.opts.after != null) ? block.opts.after : SP.letterPara };
      // letterLine: the letter's own header furniture (date, recipient
      // block, salutation, signature name) - short, non-JD-sourced lines
      // with no data-file ref to measure against. Spacing is whatever the
      // block that built it asked for.
      case "letterLine": return { before: 0, after: (block.opts && block.opts.after != null) ? block.opts.after : SP.letterPara };
      default: return { before: 0, after: 0 };
    }
  }

  // Reads a fact/variant's own stored heightPx (or one of its named
  // sub-keys, e.g. "role"/"dates"/"items"/"body"/"modules"), for the given
  // docType ("cv" or "letter"). Throws on a stale or missing measurement -
  // silently falling back to some formula here is exactly the failure mode
  // this redesign exists to remove.
  //
  // `useShort` (19 Sept 2026, Derin's "A-E" spec, part A): when true, reads
  // `ref.shortHeightPx` instead of `ref.heightPx` - the measured height of
  // the SAME variant's `.short` text, once js/trim.js's shorten step has
  // swapped a block onto it. Only ever passed for the two block kinds that
  // can actually be shortened (bullet, and the profile's own para block -
  // see heightForBlock below); subKeyed refs (role/dates/modules/etc.) have
  // no `.short` concept at all today, so this is never combined with a
  // subKey.
  // `spec` (27 Sept 2026, item 6 - replaces the old data._version stamp
  // check): { text, sizeKey, isBullet } - the exact text actually being
  // rendered right now, and the style dependencies it was measured under.
  // Every call site below builds this from data ALREADY sitting on the
  // live model block (block.text, or block.title/org/right for a "role"
  // block) - never re-derived from the underlying fact/variant the way
  // tests/golden/measure-blocks.js and js/validate.js have to (they run
  // before/without a built model), which means there is no risk of this
  // copy drifting from what actually got rendered: it doesn't reconstruct
  // anything, it reads the same text the docx build itself is about to use.
  function refHeight(ref, subKey, docType, label, useShort, spec) {
    var heightField = useShort ? "shortHeightPx" : "heightPx";
    if (!ref || !ref[heightField]) {
      throw new Error("pagefit.js: " + label + " has no " + heightField + (useShort ?
        " - js/trim.js tried to use its .short text but no shortHeightPx was ever measured for it." :
        " - it was added to the data file without running tests/golden/measure-blocks.js.") );
    }
    var h = subKey ? ref[heightField][subKey] : ref[heightField];
    if (!h) {
      throw new Error("pagefit.js: " + label + " is missing " + heightField + (subKey ? "." + subKey : "") + ".");
    }
    var expected = BlockHash.blockHash(data, META, spec);
    if (h.hash !== expected) {
      throw new Error("pagefit.js: " + label + "'s " + heightField + (subKey ? "." + subKey : "") +
        " is stale (its text or a style value it depends on changed since it was measured) - re-run tests/golden/measure-blocks.js --apply.");
    }
    var px = h[docType];
    if (px == null) {
      throw new Error("pagefit.js: " + label + "'s " + heightField + (subKey ? "." + subKey : "") + " has no '" + docType + "' entry.");
    }
    return px;
  }

  function identityHeight(kind) {
    var h = META.identity && META.identity[kind];
    if (h == null) throw new Error("pagefit.js: _blockHeightMeta.identity['" + kind + "'] is missing.");
    return h;
  }

  function headingHeight(text) {
    var h = META.headings && META.headings[text];
    if (h == null) {
      throw new Error("pagefit.js: _blockHeightMeta.headings['" + text + "'] is missing - a new heading string " +
        "was added without a measured height. Re-run tests/golden/measure-blocks.js.");
    }
    return h;
  }

  // skillLine: live wrap simulation against the block's ACTUAL text (the
  // JD-reordered term list, not file order) - see file header. `prefix`
  // is the bold "Label:  " run render-docx.js emits ahead of the plain
  // text run, which eats into line 1's budget only.
  function skillLineHeight(block, docType) {
    var sizeKey = docType === "letter" ? "letterBody" : "body";
    var cw = META.charWidths && META.charWidths[sizeKey];
    if (!cw) throw new Error("pagefit.js: _blockHeightMeta.charWidths['" + sizeKey + "'] is missing.");
    var widthTwips = docType === "letter" ? data.style.letterPage.textWidthTwips : data.style.textWidthTwips;
    var widthPx = twipsToPx(widthTwips);
    var prefix = block.label + data.style.skillLabelSuffix;
    var prefixWidth = TextWrap.textWidth(prefix, cw);
    var lines = TextWrap.wrapLineCount(block.text, cw, widthPx, 2, prefixWidth);
    var advance = META.lineAdvancePx[sizeKey === "letterBody" ? "letterBody" : "body"];
    return lines * advance;
  }

  // letterLine height (21 Sept 2026, cover-letter renderer): live wrap
  // simulation against the letter's own text width, same principle as
  // skillLineHeight above and for the same reason - this text (a date, a
  // recipient block line, the salutation, the signature name) has no
  // fixed, pre-measurable form the way a bulletVariants/letterBlocks entry
  // does. Company names vary per application and could in principle wrap a
  // recipient line onto two, so this is a real simulation, not a hardcoded
  // one-line assumption - never a guessed constant, per this project's own
  // "trust the measurement, not the formula" rule (17 Sept 2026).
  function letterLineHeight(text) {
    var cw = META.charWidths && META.charWidths.letterBody;
    if (!cw) throw new Error("pagefit.js: _blockHeightMeta.charWidths.letterBody is missing.");
    var widthPx = twipsToPx(data.style.letterPage.textWidthTwips);
    var lines = TextWrap.wrapLineCount(text, cw, widthPx, 2, 0);
    return lines * META.lineAdvancePx.letterBody;
  }

  // Templated letterBlocks (Phase 7 - not called by anything yet, ready for
  // when cover-letter assembly exists). `ref` is the letterBlocks entry
  // (carries the {{SLOT}} template and its empty-slot baseline heightPx.
  // letter); `filledText` is that same template with every slot actually
  // substituted. Simulates BOTH the baseline and the filled text with the
  // SAME wrapLineCount call (never diffs a live simulation against a
  // stored line count from a different code path - see js/textwrap.js's
  // header for why that was tried and found wrong for multi-slot blocks).
  function letterBlockHeight(ref, filledText) {
    var baselineText = ref.text.replace(/\{\{[A-Z]+\}\}/g, "");
    var base = refHeight(ref, null, "letter", "letterBlocks['" + ref.id + "']", false,
      { text: baselineText, sizeKey: "letterBody", isBullet: false, docType: "letter" });
    if (filledText === ref.text) return base; // nothing substituted (or no slots at all)
    var cw = META.charWidths.letterBody;
    var widthPx = twipsToPx(data.style.letterPage.textWidthTwips);
    var baselineLines = TextWrap.wrapLineCount(baselineText, cw, widthPx, 2, 0);
    var filledLines = TextWrap.wrapLineCount(filledText, cw, widthPx, 2, 0);
    var extraLines = Math.max(0, filledLines - baselineLines);
    return base + extraLines * META.lineAdvancePx.letterBody;
  }

  // Content height (NOT including this block's own before/after spacing -
  // that's added separately by predict(), matching exactly how the offline
  // measurement isolated pure text height) for one model block.
  function heightForBlock(block, docType) {
    switch (block.t) {
      case "name": return identityHeight("name");
      case "contact": return identityHeight("contact");
      case "auth": return identityHeight("rightToWork");
      case "spacer": return 0;
      case "head": return headingHeight(block.text);
      case "skillLine": return skillLineHeight(block, docType);
      case "letterLine": return letterLineHeight(block.text);

      // letterPara: a templated letterBlocks entry (js/letter.js sets
      // block.ref to the letterBlocks entry itself and block.text to the
      // already-filled text) - this is the wiring letterBlockHeight() was
      // built for on 17 Sept 2026 and has been waiting for since ("not
      // called by anything yet, ready for when cover-letter assembly
      // exists" - see that function's own comment below). Using it here
      // instead of a flat refHeight() lookup is what makes a long COMPANY
      // name or a long ECHO quote correctly add the extra wrapped line(s)
      // it actually costs, rather than under-measuring every filled letter
      // block the way a naive baseline lookup would.
      case "letterPara": return letterBlockHeight(block.ref, block.text);

      case "bullet": {
        var bRef = block._prov.text.atoms[0].ref;
        var bShort = block._prov.text.atoms[0].field === "short";
        // block.text already IS bRef.short once js/trim.js has shortened
        // it (see trim.js's shortenBlock: "newBlock.text = ref.short") -
        // reading it straight off the live block, rather than re-deriving
        // bRef.short/.text, means this can never drift from what the docx
        // build itself is about to render.
        return refHeight(bRef, null, docType, "bullet variant", bShort, { text: block.text, sizeKey: "body", isBullet: true, docType: docType });
      }

      case "role": {
        var rRef = block._prov.title.atoms[0].ref;
        // Hashed from the block's OWN title/org/right - exactly what
        // tests/golden/measure-blocks.js's roleAndDates() built its model
        // from (org on the title line for roles/education, omitted for
        // projects - see that function's own comment), so no need to
        // re-derive which case applies here.
        var roleHashText = [block.title, block.org, block.right].map(function (x) { return x == null ? "" : String(x); }).join("\u0001");
        return refHeight(rRef, "role", docType, "role/project/education entry '" + (rRef && rRef.id) + "'", false, { text: roleHashText, sizeKey: "body", isBullet: false, docType: docType });
      }

      case "dates": {
        var dRef = block._prov.text.atoms[0].ref;
        return refHeight(dRef, "dates", docType, "role/project/education entry '" + (dRef && dRef.id) + "'", false, { text: block.text, sizeKey: "small", isBullet: false, docType: docType });
      }

      case "para": {
        var prov = block._prov.text;
        var ref0 = prov.atoms[0] && prov.atoms[0].ref;
        // Modules line - atoms ref into e.modules (the array), not e itself.
        // Found by object IDENTITY (the same live array reference _prov
        // stored), never by re-matching text.
        if (prov.prefix === "Modules: ") {
          var edu = (data.facts.education || []).filter(function (e) { return e.modules === ref0; })[0];
          if (!edu) throw new Error("pagefit.js: could not find the education entry owning this modules line.");
          return refHeight(edu, "modules", docType, "education entry '" + edu.id + "' modules line", false, { text: block.text, sizeKey: "small", isBullet: false, docType: docType });
        }
        // Cert items line - atoms ref into c.items[k] ("display" field).
        // Found by which cert's items array contains this exact item object.
        if (ref0 && ref0.display !== undefined && ref0.printPercent !== undefined) {
          var certByItem = (data.facts.certifications || []).filter(function (c) { return c.items.indexOf(ref0) !== -1; })[0];
          if (!certByItem) throw new Error("pagefit.js: could not find the certification entry owning this items line.");
          return refHeight(certByItem, "items", docType, "certification '" + certByItem.id + "' items line", false, { text: block.text, sizeKey: "body", isBullet: false, docType: docType });
        }
        // Cert body line - ref IS the certification object itself.
        if (ref0 && ref0.body !== undefined && ref0.items !== undefined) {
          return refHeight(ref0, "body", docType, "certification '" + ref0.id + "' body line", false, { text: block.text, sizeKey: "small", isBullet: false, docType: docType });
        }
        // Profile paragraph or volunteering - flat heightPx. A profile
        // block's _prov.text.atoms[0].field is "short" once js/trim.js has
        // shortened it (see that file's shortenBlock()) - volunteering has
        // no `.short` concept and is never shortened, so its field is
        // always "text" and useShort is always false for it. Distinguished
        // by object identity (ref0 === data.facts.volunteering) purely to
        // pick the right sizeKey for the hash - volunteering was measured
        // at "small", a profile paragraph at "body" (see measure-blocks.js's
        // own collectTargets()).
        var pShort = prov.atoms[0] && prov.atoms[0].field === "short";
        var isVolunteering = ref0 === data.facts.volunteering;
        return refHeight(ref0, null, docType, "para block '" + (ref0 && ref0.id) + "'", pShort, { text: block.text, sizeKey: isVolunteering ? "small" : "body", isBullet: false, docType: docType });
      }

      default:
        throw new Error("pagefit.js: no height rule for block type '" + block.t + "'.");
    }
  }

  // Sums a model's predicted height, in px, at the SAME renderer fidelity
  // as the offline measurement - direct port of the cross-check script's
  // predictSum() (scratchpad/crosscheck.js), which validated this exact
  // algorithm against five real, whole, rendered documents before this was
  // trusted to gate a real download. Between two consecutive blocks, the
  // gap is the FIRST block's spacing.after plus the SECOND block's
  // spacing.before (never double-counted); the final block's own
  // spacing.after is never added, matching fixLastParagraphSpacing()
  // zeroing it anyway.
  function predictHeight(model, docType) {
    requireConfigured();
    docType = docType || "cv";
    var total = 0;
    var prevAfterTwips = 0;
    model.forEach(function (block) {
      var sp = spacingFor(block);
      total += twipsToPx(prevAfterTwips + sp.before);
      prevAfterTwips = sp.after;
      if (block.t === "spacer") return;
      total += heightForBlock(block, docType);
    });
    return total;
  }

  // Usable height budget for a page, minus a ONE-LINE allowance (not a
  // guessed buffer - see file header) for LibreOffice's own small residual
  // rounding drift found during cross-check (-12px to -14.4px across five
  // real documents, stable, not scaling with document length). CV holds
  // back one body-size line (16.73px); a cover letter (Phase 7) would hold
  // back one letterBody-size line (18.53px) - letters have far more slack
  // than a CV ever does, so this is built correctly but nothing gates on
  // it yet.
  function usableHeightPx(docType) {
    requireConfigured();
    var page = docType === "letter" ? data.style.letterPage : data.style.page;
    var rawUsable = twipsToPx(page.heightTwips - page.margin.top - page.margin.bottom);
    var allowance = docType === "letter" ? META.lineAdvancePx.letterBody : META.lineAdvancePx.body;
    return { raw: rawUsable, effective: rawUsable - allowance, allowance: allowance };
  }

  // Public entry point - same return shape js/preview.js's old measure()
  // gave callers (heightPx/usableHeightPx/overflowPx/overflows/
  // rawUsableHeightPx/rawOverflowPx), so js/app.js's rendering of the
  // fit-readout text needed only the measurement SOURCE swapped, not its
  // own logic. safetyMarginPx is kept as a field name for the same reason,
  // but now holds the one-line allowance, not the old 120px constant.
  function measure(model, docType) {
    requireConfigured();
    docType = docType || "cv";
    var heightPx = predictHeight(model, docType);
    var usable = usableHeightPx(docType);
    var overflowPx = heightPx - usable.effective;
    var rawOverflowPx = heightPx - usable.raw;
    return {
      heightPx: heightPx,
      usableHeightPx: usable.effective,
      overflowPx: overflowPx > 0 ? overflowPx : 0,
      overflows: overflowPx > 0,
      rawUsableHeightPx: usable.raw,
      rawOverflowPx: rawOverflowPx > 0 ? rawOverflowPx : 0,
      safetyMarginPx: usable.allowance
    };
  }

  global.CVPageFit = {
    configure: configure,
    predictHeight: predictHeight,
    usableHeightPx: usableHeightPx,
    measure: measure,
    heightForBlock: heightForBlock,
    letterBlockHeight: letterBlockHeight
  };
})(typeof window !== "undefined" ? window : globalThis);
