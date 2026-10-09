// ---------------------------------------------------------------------------
// Renders the SAME content model that render-docx.js consumes into an HTML
// mirror, purely so Derin has something to look at on screen while editing.
//
// 17 Sept 2026 - third-review-pass redesign: this file no longer decides
// whether a CV fits one page. It used to (via measure(), reading
// container.scrollHeight against a hardcoded FIT_SAFETY_MARGIN_PX = 120
// guessed buffer) - that whole approach is gone. A real Phase 3 CV once
// browser-measured "104px to spare" and then spilled two lines onto a
// second page when actually converted to PDF (see README.md's "browser-
// based page-fit measurement understated real overflow"), because Chrome's
// Times New Roman line-wrapping doesn't match Word/LibreOffice's exactly.
// Rather than papering over that drift with a bigger guessed margin, the
// fit decision was moved to js/pagefit.js, which sums block heights
// measured ONCE, offline, against the real renderer (LibreOffice) that
// actually produces the .docx - no browser measurement anywhere in that
// path. See js/pagefit.js's own header and build-status-and-decision-log.md
// for the full reasoning.
//
// 13 Sept 2026 review fix (still true, still the reason every value below
// comes from data.style at runtime via configure(style)): if this file's
// copies of render-docx.js's font sizes/spacing ever drifted from the real
// ones, the on-screen preview would show a DIFFERENT document than the one
// actually downloaded. Reading both from one place removes that risk by
// construction instead of by care - this remains true for the visual
// mirror even though this file no longer also does the fit check.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var S = null;
  var NAVY, GREY, FAINT, FONT, SEP, SKILL_SUFFIX;
  var SIZES, SPACING, CHAR_SPACING, HEADING_BORDER, BULLET, HYPERLINK_COLOUR, HYPERLINK_UNDERLINE;
  var CONTAINER_WIDTH_PX, USABLE_HEIGHT_PX, PAGE_MARGIN_PX;

  var LINKEDIN_URL = "https://www.linkedin.com/in/derinyesudas";

  function requireConfigured() {
    if (!S) throw new Error("preview.js: configure(data.style) must be called before render()/measure().");
  }

  function twipsToPt(t) { return t / 20; }
  // twips -> px directly (twips/1440in * 96px/in = twips/15).
  function twipsToPx(t) { return t / 15; }
  // Font "size" fields in the content model are docx half-points, not
  // twips - conflating the two previously rendered several lines at a
  // tenth of their real size (Phase 2 finding). Spacing fields (after/
  // before) are twips, converted via twipsToPt above.
  function halfPtToPt(hp) { return hp / 2; }

  // Reads every value this preview needs out of data.style, and derives
  // the page-geometry constants (container width, usable height, margin
  // box) from it too - so a change to style.page/style.textWidthTwips/
  // style.usableHeightTwips takes effect here without a code change,
  // exactly like every other style value.
  function configure(style) {
    S = style;
    NAVY = "#" + style.colours.navy;
    GREY = "#" + style.colours.grey;
    FAINT = "#" + style.colours.faint;
    FONT = "'" + style.font + "', Times, serif";
    SEP = style.separator;
    SKILL_SUFFIX = style.skillLabelSuffix;
    SIZES = style.sizes;
    SPACING = style.spacingAfter;
    CHAR_SPACING = style.characterSpacing;
    HEADING_BORDER = style.headingBorder;
    BULLET = style.bullet;
    HYPERLINK_COLOUR = "#" + style.hyperlinkColour;
    HYPERLINK_UNDERLINE = !!style.hyperlinkUnderline;

    CONTAINER_WIDTH_PX = twipsToPx(style.textWidthTwips);
    USABLE_HEIGHT_PX = twipsToPx(style.usableHeightTwips);
    PAGE_MARGIN_PX = {
      top: twipsToPx(style.page.margin.top),
      right: twipsToPx(style.page.margin.right),
      bottom: twipsToPx(style.page.margin.bottom),
      left: twipsToPx(style.page.margin.left)
    };
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Attribute-safe escaping for href values - additionally escapes quotes
  // and angle brackets the same way esc() does. Before the 13 Sept 2026
  // review, linkifyContactPart() interpolated part.link into an href
  // attribute WITHOUT escaping it, unlike every other piece of text in
  // this file, which always went through esc(). Zero practical risk today
  // (the only source of `link` is Derin's own trusted data file), but an
  // inconsistency the review flagged as worth closing rather than relying
  // on "the input is always trusted" - the exact kind of unchecked claim
  // this whole project exists to stop making.
  function escAttr(s) { return esc(s); }

  function el(tag, style) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    return e;
  }

  // Mirrors render-docx.js's contact() exactly, including the same
  // Phase 3 extension: an item can be a plain string (old regex
  // auto-detection, kept for Phase 1/2-style callers) or a {text, link}
  // object (Phase 3 onward - js/assemble.js passes identity.contact
  // through as-is, and `link` is authoritative: null means plain text, no
  // guessing).
  function linkifyContactPart(part) {
    if (part && typeof part === "object") {
      return part.link
        ? '<a href="' + escAttr(part.link) + '" style="color:' + HYPERLINK_COLOUR + ';text-decoration:none;">' + esc(part.text) + "</a>"
        : esc(part.text);
    }
    var t = part.trim();
    if (/linkedin\.com/i.test(t)) {
      return '<a href="' + escAttr(LINKEDIN_URL) + '" style="color:' + HYPERLINK_COLOUR + ';text-decoration:none;">' + esc(part) + "</a>";
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      return '<a href="' + escAttr("mailto:" + t) + '" style="color:' + HYPERLINK_COLOUR + ';text-decoration:none;">' + esc(part) + "</a>";
    }
    if (/^(github\.com|[\w-]+\.github\.io)\//i.test(t)) {
      return '<a href="' + escAttr("https://" + t) + '" style="color:' + HYPERLINK_COLOUR + ';text-decoration:none;">' + esc(part) + "</a>";
    }
    return esc(part);
  }

  function renderBlock(b) {
    var p;
    switch (b.t) {
      case "name":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.name) + "pt 0;text-align:center;font-weight:bold;font-size:" +
          halfPtToPt(SIZES.name) + "pt;color:" + NAVY + ";letter-spacing:" + (CHAR_SPACING.name / 20) + "pt;line-height:1.15;");
        p.textContent = b.text;
        return p;

      case "contact":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.contact) + "pt 0;text-align:center;font-size:" +
          halfPtToPt(SIZES.contact) + "pt;line-height:1.15;");
        p.innerHTML = b.items.map(linkifyContactPart).join(esc(SEP));
        return p;

      case "auth":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.rightToWork) + "pt 0;text-align:center;font-size:" +
          halfPtToPt(SIZES.rightToWork) + "pt;font-style:italic;color:" + FAINT + ";line-height:1.15;");
        p.textContent = b.text;
        return p;

      case "spacer":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.spacer) + "pt 0;font-size:" + halfPtToPt(SIZES.rightToWork) + "pt;line-height:1.15;");
        p.innerHTML = "&nbsp;";
        return p;

      case "head":
        p = el("p", "margin:" + twipsToPt(SPACING.headingBefore) + "pt 0 " + twipsToPt(SPACING.heading) + "pt 0;font-weight:bold;font-size:" +
          halfPtToPt(SIZES.heading) + "pt;color:" + NAVY + ";letter-spacing:" + (CHAR_SPACING.heading / 20) +
          "pt;line-height:1.15;border-bottom:" + (HEADING_BORDER.size / 8) + "pt solid " + NAVY + ";padding-bottom:2pt;");
        p.textContent = b.text;
        return p;

      case "role": {
        p = el("p", "margin:" + twipsToPt(SPACING.roleBefore) + "pt 0 0 0;font-size:" + halfPtToPt(SIZES.body) +
          "pt;line-height:1.15;display:flex;justify-content:space-between;align-items:baseline;");
        var leftHtml = '<span style="font-weight:bold;">' + esc(b.title) + "</span>";
        if (b.org) leftHtml += esc(" - " + b.org);
        var rightHtml = b.right
          ? '<span style="font-style:italic;font-size:' + halfPtToPt(SIZES.small) + 'pt;color:' + GREY + ';white-space:nowrap;padding-left:6pt;">' + esc(b.right) + "</span>"
          : "";
        p.innerHTML = "<span>" + leftHtml + "</span>" + rightHtml;
        return p;
      }

      case "dates":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.dates) + "pt 0;font-style:italic;font-size:" +
          halfPtToPt(SIZES.small) + "pt;color:" + GREY + ";line-height:1.15;");
        p.textContent = b.text;
        return p;

      case "bullet":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.bullet) + "pt 0;font-size:" + halfPtToPt(SIZES.body) +
          "pt;line-height:1.15;padding-left:" + twipsToPt(BULLET.indentLeft) + "pt;text-indent:-" + twipsToPt(BULLET.hanging) + "pt;");
        p.innerHTML = '<span style="color:#' + BULLET.colour + ';">&#8226;</span>&nbsp;' + esc(b.text);
        return p;

      // letterPara/letterLine (21 Sept 2026, cover-letter renderer): render
      // identically to "para" - both are just text with an explicit
      // size/spacing via b.opts. See render-docx.js's blocksToChildren for
      // why these stay distinct types rather than being aliased to "para"
      // everywhere (js/pagefit.js and js/verify.js each treat them
      // differently) - this file has no such need, so one shared case.
      case "para": case "letterPara": case "letterLine": {
        var o = b.opts || {};
        var afterPt = o.after != null ? twipsToPt(o.after) : 1.8;
        var sizePt = o.size ? halfPtToPt(o.size) : halfPtToPt(SIZES.body);
        var style = "margin:0 0 " + afterPt + "pt 0;font-size:" + sizePt + "pt;line-height:1.15;";
        if (o.italics) style += "font-style:italic;";
        if (o.color) style += "color:#" + o.color + ";";
        p = el("p", style);
        p.textContent = b.text;
        return p;
      }

      case "skillLine":
        p = el("p", "margin:0 0 " + twipsToPt(SPACING.skillLine) + "pt 0;font-size:" + halfPtToPt(SIZES.body) + "pt;line-height:1.15;");
        p.innerHTML = '<span style="font-weight:bold;">' + esc(b.label + SKILL_SUFFIX) + "</span>" + esc(b.text);
        return p;

      default:
        throw new Error("preview.js: unknown content-model block type '" + b.t + "'");
    }
  }

  // Renders the model into `container`, replacing whatever was there.
  function render(model, container) {
    requireConfigured();
    container.innerHTML = "";
    container.style.width = CONTAINER_WIDTH_PX + "px";
    container.style.fontFamily = FONT;
    container.style.color = "#000000";
    container.style.boxSizing = "content-box";
    model.forEach(function (b) {
      container.appendChild(renderBlock(b));
    });
  }

  // pageGeometryPx (21 Sept 2026, cover-letter renderer): the CV and the
  // letter have genuinely different page geometry (style.page vs.
  // style.letterPage - wider side margins, deeper bottom margin, measured
  // 14 Sept 2026 against three real sent letters), but configure() above
  // only ever derives ONE set of geometry constants, globally, from
  // whichever style object was last configured. Reconfiguring this module
  // a second time for the letter would silently repoint the CV preview's
  // own geometry too (the same problem js/render-docx.js's buildWithPage()
  // was written to avoid - see that function's comment for the full
  // reasoning). This is the preview-side equivalent: a pure function
  // deriving the same three geometry values from ANY page object, so the
  // caller (js/app.js) can size the letter preview's own page/container
  // elements directly, without touching this module's configured CV state
  // at all. render() below still always uses CONTAINER_WIDTH_PX for the
  // container's own width - the caller overrides that one style property
  // immediately after calling render() for a letter model, same pattern as
  // it already overrides the page/boundary padding for the CV.
  function pageGeometryPx(page) {
    return {
      containerWidthPx: twipsToPx(page.textWidthTwips),
      usableHeightPx: twipsToPx(page.usableHeightTwips),
      marginPx: {
        top: twipsToPx(page.margin.top), right: twipsToPx(page.margin.right),
        bottom: twipsToPx(page.margin.bottom), left: twipsToPx(page.margin.left)
      }
    };
  }

  global.CVPreview = {
    configure: configure,
    get CONTAINER_WIDTH_PX() { return CONTAINER_WIDTH_PX; },
    get USABLE_HEIGHT_PX() { return USABLE_HEIGHT_PX; },
    get PAGE_MARGIN_PX() { return PAGE_MARGIN_PX; },
    render: render,
    pageGeometryPx: pageGeometryPx,
    // _test.configured (25 Sept 2026, item 7 - see js/render-docx.js's own
    // _test.configured for the full reasoning: this is the other half of
    // "assert every hardcoded constant equals its JSON style value").
    _test: {
      configured: function () {
        return {
          colours: { navy: NAVY, grey: GREY, faint: FAINT },
          font: FONT, separator: SEP, skillLabelSuffix: SKILL_SUFFIX,
          sizes: SIZES, spacingAfter: SPACING, characterSpacing: CHAR_SPACING,
          headingBorder: HEADING_BORDER, bullet: BULLET,
          hyperlinkColour: HYPERLINK_COLOUR, hyperlinkUnderline: HYPERLINK_UNDERLINE
        };
      }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
