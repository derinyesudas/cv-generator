// ---------------------------------------------------------------------------
// Third-review-pass redesign (17 Sept 2026): a greedy word-wrap simulator
// using REAL, measured-in-LibreOffice per-character advance widths (see
// data._blockHeightMeta.charWidths), for the two kinds of block whose text
// is not fixed at authoring time and so cannot get a single stored
// heightPx constant:
//
//   1. skillLine blocks - js/assemble.js's buildSkills() reorders each
//      category's terms live, JD-hit terms first (stableSortDesc). A
//      height measured against file order is not valid once the order
//      changes, so the live gate must re-simulate the wrap on whatever
//      order actually got printed.
//   2. letterBlocks with {{SLOT}} template placeholders (Phase 7, cover
//      letters - not wired into any model yet, but this module is built
//      now so that phase doesn't have to reinvent it). A block's baseline
//      heightPx.letter is measured with every slot substituted by "" (see
//      data._blockHeightMeta._readme); the runtime delta for whatever text
//      actually filled the slots is this file's job.
//
// Design, per Derin's own instructions (REVIEW-RESPONSE-5/6), verbatim
// requirements this implementation must hold to:
//   - Break on spaces only. Never break inside a single word, so a
//     substituted company/role/team name is never split mid-name.
//   - Apply the kerning-tolerance allowance PER LINE, not per block - it is
//     subtracted from the usable width before any word is placed, so every
//     line (not just the first) absorbs LibreOffice's small measured
//     rounding drift against the character-width table.
//   - Simulate BOTH sides of any comparison with this SAME function - never
//     diff a live simulation against a stored constant that came from a
//     different code path (a prior draft of this file's caller did exactly
//     that for letterBlocks and got the wrong answer for multi-slot text;
//     see build-status-and-decision-log.md).
//   - Err toward predicting one extra line, never one too few - the safe
//     direction, because it trims slightly more than needed rather than
//     silently producing a two-page document.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // Sum of each character's measured advance width. Falls back to "m" (the
  // widest common lowercase glyph in the measured table) for any character
  // the table doesn't have an entry for, which slightly OVERSTATES an
  // unknown glyph's width - the safe direction per the file header, never
  // the reverse.
  function textWidth(text, widthTable) {
    var sum = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var w = widthTable[ch];
      sum += (w != null ? w : widthTable["m"]);
    }
    return sum;
  }

  // Greedy line-wrap simulation. Returns the number of lines `text` occupies
  // at `usableWidthPx`, using `widthTable` (data._blockHeightMeta.charWidths.
  // body or .letterBody) for per-character advances.
  //
  //   kerningTolerancePx - per-line allowance subtracted from usableWidthPx
  //     before placing any word (default 2, Derin's fixed figure - "a
  //     two-pixel allowance, not a 120px one," for LibreOffice's own small
  //     measured rounding drift against the character-width table, NOT a
  //     re-introduction of the old guessed page buffer).
  //   initialOffsetPx - width already consumed on line 1 before the first
  //     word (e.g. a bold "Label:  " skillLine prefix, which render-docx.js
  //     emits as a separate TextRun ahead of the wrapped text, occupying
  //     real width on that first line only).
  function wrapLineCount(text, widthTable, usableWidthPx, kerningTolerancePx, initialOffsetPx) {
    kerningTolerancePx = kerningTolerancePx == null ? 2 : kerningTolerancePx;
    initialOffsetPx = initialOffsetPx || 0;
    var effectiveWidth = usableWidthPx - kerningTolerancePx;
    var words = text.split(" ").filter(function (w) { return w.length > 0; });
    var spaceWidth = widthTable[" "];
    var lines = 1;
    var cur = initialOffsetPx;
    words.forEach(function (w, i) {
      var ww = textWidth(w, widthTable);
      // No leading space before the very first word - whatever precedes it
      // (a label prefix, or nothing) already accounts for its own trailing
      // separator; this function only ever adds a space BETWEEN words it is
      // placing itself.
      var withSpace = i === 0 ? cur + ww : cur + spaceWidth + ww;
      if (withSpace > effectiveWidth && cur > 0) {
        lines++;
        cur = ww;
      } else {
        cur = withSpace;
      }
    });
    return lines;
  }

  global.CVTextWrap = { textWidth: textWidth, wrapLineCount: wrapLineCount };
})(typeof window !== "undefined" ? window : globalThis);
