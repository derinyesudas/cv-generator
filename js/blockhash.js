// ---------------------------------------------------------------------------
// Shared by tests/golden/measure-blocks.js (Node) and js/validate.js
// (browser) - item 6 of Derin's 27 Sept 2026 matcher/deploy work order:
// "stop stamping dataVersion [on every one of the ~60 pre-measured block
// heights]... store a hash of each block's text plus the style values it
// depends on... the validator recomputes the hashes and fails only when a
// block's hash differs, naming the block to remeasure."
//
// Before this: every heightPx/shortHeightPx entry across bulletVariants,
// profileVariants, facts.roles/education/projects/certifications/
// volunteering, and letterBlocks carried data._version itself as its own
// freshness stamp (js/validate.js's old checkHeight compared
// node.dataVersion !== data._version). That meant literally any version
// bump anywhere in the file - a reworded warning, a new archetype keyword,
// this session's own matcher.js rewrite - invalidated all ~60 of them at
// once, even though every one of those blocks' own text and every style
// value it depends on were completely unchanged. That is what made
// re-stamping "easy to forget": tests/golden/measure-blocks.js --apply is
// a real LibreOffice render-and-measure pass (needs soffice + pdftotext),
// and nobody reruns a slow, real-renderer step just because something
// unrelated changed _version.
//
// A block's stored height is only ACTUALLY wrong when its own text, or one
// of the specific values that governs how that text wraps, changed: the
// font family, the font size for its role (sizeKey), the page's usable
// text width for its docType (cv page vs letter page use different
// margins), and the empirically-measured line-advance constant for its
// role (data._blockHeightMeta.lineAdvancePx - a calibrated-against-the-
// real-renderer number, not derivable from font size alone, see that
// field's own _readme). A bullet-type block additionally depends on the
// bullet glyph/indent/hanging, since a bullet's first line has less
// available width than a plain paragraph's. Nothing else data._version
// might ever describe can affect a SPECIFIC block's own measured height,
// so nothing else may be able to invalidate it.
//
// Non-cryptographic on purpose - collision-resistance against an
// adversary is not the goal here, only "did any of these specific inputs
// change since this was last measured", the same bar js/app.js's own
// simpleHash (its unrelated JD-vs-model-stamp check) already sets for
// itself. Deliberately NOT shared code with that function - see
// js/matcher.js's own file header for why a small amount of duplication
// across independently-loaded layers (js/app.js is live UI stamp
// bookkeeping; this is data-authoring/measurement bookkeeping, loaded and
// used by a Node script that has no access to js/app.js's browser-only
// state) beats inventing a cross-dependency between them that has no
// other reason to exist.
(function (global) {
  "use strict";

  function stringHash(s) {
    var h = 0;
    var str = String(s == null ? "" : s);
    for (var i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    // Unsigned hex, fixed-ish width - a stable, diffable string to sit in
    // the data file (a signed decimal would print an ugly leading "-" for
    // roughly half of all inputs, for no benefit).
    return (h >>> 0).toString(16);
  }

  // Builds the one canonical fingerprint string for a block's text plus
  // every style value it depends on. Callers (measure-blocks.js when
  // WRITING a fresh measurement, validate.js when CHECKING a stored one)
  // must pass the exact same { text, sizeKey, docType, isBullet } a given
  // block was actually measured with - see each call site's own comment
  // for how that's derived per block type. `data` is the loaded data
  // file (for style.font/sizes/textWidthTwips/letterPage/bullet) and
  // `blockHeightMeta` is data._blockHeightMeta (for lineAdvancePx - an
  // empirically-calibrated px-per-line constant, not part of data.style
  // proper, see _blockHeightMeta._readme for why).
  //
  // spec.docType: "cv" reads data.style's own top-level textWidthTwips;
  // "letter" reads data.style.letterPage.textWidthTwips - the two page
  // geometries differ (wider letter margins), confirmed in
  // data.style.letterPage's own _readme.
  function fingerprint(data, blockHeightMeta, spec) {
    var style = data && data.style;
    var page = spec.docType === "letter" ? (style && style.letterPage) : style;
    var parts = [
      spec.sizeKey,
      style && style.font,
      style && style.sizes && style.sizes[spec.sizeKey],
      page && page.textWidthTwips,
      blockHeightMeta && blockHeightMeta.lineAdvancePx && blockHeightMeta.lineAdvancePx[spec.sizeKey]
    ];
    if (spec.isBullet) {
      var b = (style && style.bullet) || {};
      parts.push(b.glyph, b.indentLeft, b.hanging);
    }
    return parts.join("\u0001");
  }

  function blockHash(data, blockHeightMeta, spec) {
    return stringHash(String(spec.text == null ? "" : spec.text) + "\u0002" + fingerprint(data, blockHeightMeta, spec));
  }

  // Second, coarser fingerprint for data._blockHeightMeta itself (the
  // shared identity/lineAdvancePx/charWidths/headings bundle - the same
  // "_blockHeightMeta.dataVersion" name Derin's own item 6 names). Unlike
  // a single block's height, these ARE the empirically-calibrated
  // constants (real-renderer px-per-line, real-renderer glyph widths) -
  // there's no "expected value" to recompute from data.style and compare,
  // only whether the style inputs they were calibrated against are still
  // today's. One combined fingerprint for the whole bundle, same
  // granularity the old single dataVersion field already had - this isn't
  // making that check MORE granular, just switching what invalidates it
  // from "any version bump" to "an actual style change".
  function styleFingerprint(data) {
    var style = data && data.style;
    var b = (style && style.bullet) || {};
    return [
      style && style.font,
      JSON.stringify(style && style.sizes),
      style && style.textWidthTwips,
      style && style.letterPage && style.letterPage.textWidthTwips,
      b.glyph, b.indentLeft, b.hanging
    ].join("\u0001");
  }
  function styleHash(data) {
    return stringHash(styleFingerprint(data));
  }

  global.CVBlockHash = { stringHash: stringHash, fingerprint: fingerprint, blockHash: blockHash, styleFingerprint: styleFingerprint, styleHash: styleHash };
})(typeof window !== "undefined" ? window : globalThis);
