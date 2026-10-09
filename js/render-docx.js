// ---------------------------------------------------------------------------
// Derin Yesudas - CV house style renderer (docx).
//
// 13 Sept 2026 review fix: every value below now comes from data.style at
// runtime, via configure(style) - called once, right after the data file
// loads (see js/app.js). Before this fix, this file carried its OWN
// hardcoded copies of every font size, colour, margin and spacing value,
// which happened to match cv-generator-data.json's `style` object only
// because both were hand-typed carefully and kept in sync by hand. That
// contradicted the project's own single-source-of-truth rule as applied to
// presentation instead of content, and - because js/preview.js's page-fit
// measurement exists specifically to predict THIS file's docx output - meant
// the one-page guarantee (safety gate 8.4) was a guess dressed up as a
// check: if the two files' copies ever drifted, the preview would be
// measuring a different document than the one actually downloaded, and
// nobody would know until a real CV spilled onto a second page.
//
// configure() must be called before any of the paragraph-building functions
// below are used. There is no hardcoded fallback - calling them unconfigured
// throws, deliberately, rather than silently rendering with stale defaults.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // The Word library (lib/docx.umd.js) is looked up when a .docx is built,
  // not when this file loads. If it ever fails to load, only the Word
  // downloads stop (with a message saying so); previews, checks and PDFs are
  // unaffected.
  var Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
      LevelFormat, ExternalHyperlink, TabStopType;
  function requireLib() {
    if (Document) return;
    var docxLib = global.docx;
    if (!docxLib || !docxLib.Document || !docxLib.Packer) {
      throw new Error("The Word library did not load, so Word downloads are unavailable. Reload the page to try again; PDF downloads still work.");
    }
    Document = docxLib.Document; Packer = docxLib.Packer; Paragraph = docxLib.Paragraph;
    TextRun = docxLib.TextRun; AlignmentType = docxLib.AlignmentType; BorderStyle = docxLib.BorderStyle;
    LevelFormat = docxLib.LevelFormat; ExternalHyperlink = docxLib.ExternalHyperlink;
    TabStopType = docxLib.TabStopType;
  }

  // Derin's LinkedIn must be a live clickable link in every document. Not
  // part of `style` (it's identity/content, not a presentation value) -
  // kept here only as a fallback for the legacy plain-string contact form;
  // the {text, link} object form (what assemble.js actually passes) never
  // reaches this fallback at all.
  var LINKEDIN_URL = "https://www.linkedin.com/in/derinyesudas";

  var S = null; // the configured style object, set by configure()
  var NAVY, GREY, FAINT, BODY, SMALL, HEAD, NAME, CONT, AUTH, LETTER_BODY;
  var LINE, LR, FONT, SEP, SKILL_SUFFIX;
  var PAGE, MARGIN, TEXT_WIDTH;
  var CHAR_SPACING, HEADING_BORDER, BULLET, SPACING, HYPERLINK_COLOUR, HYPERLINK_UNDERLINE;

  function requireConfigured() {
    if (!S) throw new Error("render-docx.js: configure(data.style) must be called before building any paragraph.");
  }

  // Reads every value this renderer needs out of data.style. Called once
  // after the data file loads (js/app.js), and again if the data file is
  // ever hot-reloaded - there is no reason this couldn't be called on every
  // build, it's just derived assignment, not expensive.
  function configure(style) {
    S = style;
    NAVY = style.colours.navy; GREY = style.colours.grey; FAINT = style.colours.faint;
    BODY = style.sizes.body; SMALL = style.sizes.small; HEAD = style.sizes.heading;
    NAME = style.sizes.name; CONT = style.sizes.contact; AUTH = style.sizes.rightToWork;
    LETTER_BODY = style.sizes.letterBody;
    LINE = style.lineSpacing.line; LR = style.lineSpacing.rule;
    FONT = style.font;
    SEP = style.separator;
    SKILL_SUFFIX = style.skillLabelSuffix;
    PAGE = { widthTwips: style.page.widthTwips, heightTwips: style.page.heightTwips };
    MARGIN = style.page.margin;
    TEXT_WIDTH = style.textWidthTwips;
    CHAR_SPACING = style.characterSpacing;
    HEADING_BORDER = style.headingBorder;
    BULLET = style.bullet;
    SPACING = style.spacingAfter;
    HYPERLINK_COLOUR = style.hyperlinkColour;
    HYPERLINK_UNDERLINE = !!style.hyperlinkUnderline;
  }

  function j() { requireConfigured(); return Array.prototype.slice.call(arguments).join(SEP); }

  function numberingConfig() {
    requireConfigured();
    requireLib();
    return {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: BULLET.glyph, alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: BULLET.indentLeft, hanging: BULLET.hanging } }, run: { color: BULLET.colour } }
        }]
      }]
    };
  }

  function name(t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: SPACING.name, line: LINE, lineRule: LR },
      children: [new TextRun({ text: t, bold: true, size: NAME, color: NAVY, font: FONT, characterSpacing: CHAR_SPACING.name })]
    });
  }

  // Accepts the contact items as separate arguments, one pre-joined string,
  // or (Phase 3 onward) objects shaped {text, link} - the exact shape
  // js/assemble.js passes straight through from identity.contact in the
  // data file. An object's `link` is authoritative and used as-is (null
  // means plain text, no guessing). A plain string falls back to the
  // original regex auto-detection, kept only for Phase 1/2-style callers.
  function contact() {
    requireConfigured();
    requireLib();
    var args = Array.prototype.slice.call(arguments);
    var parts = (args.length === 1 && typeof args[0] === "string" && args[0].indexOf(SEP) !== -1)
      ? args[0].split(SEP)
      : args;
    function run(text, o) {
      o = o || {};
      return new TextRun({ text: text, size: CONT, font: FONT, color: o.color, underline: o.underline });
    }
    var children = [];
    parts.forEach(function (part, i) {
      if (i > 0) children.push(run(SEP));
      var isObj = part && typeof part === "object";
      var text = isObj ? part.text : part;
      if (isObj) {
        if (part.link) {
          children.push(new ExternalHyperlink({
            link: part.link,
            children: [run(text, { color: HYPERLINK_COLOUR, underline: HYPERLINK_UNDERLINE })]
          }));
        } else {
          children.push(run(text));
        }
        return;
      }
      if (/linkedin\.com/i.test(part)) {
        children.push(new ExternalHyperlink({
          link: LINKEDIN_URL,
          children: [run(part, { color: HYPERLINK_COLOUR, underline: HYPERLINK_UNDERLINE })]
        }));
      } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part.trim())) {
        children.push(new ExternalHyperlink({
          link: "mailto:" + part.trim(),
          children: [run(part, { color: HYPERLINK_COLOUR, underline: HYPERLINK_UNDERLINE })]
        }));
      } else if (/^(github\.com|[\w-]+\.github\.io)\//i.test(part.trim())) {
        children.push(new ExternalHyperlink({
          link: "https://" + part.trim(),
          children: [run(part, { color: HYPERLINK_COLOUR, underline: HYPERLINK_UNDERLINE })]
        }));
      } else {
        children.push(run(part));
      }
    });
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: SPACING.contact, line: LINE, lineRule: LR },
      children: children
    });
  }

  function auth(t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: SPACING.rightToWork, line: LINE, lineRule: LR },
      children: [new TextRun({ text: t, size: AUTH, italics: true, font: FONT, color: FAINT })]
    });
  }

  function spacer() {
    requireConfigured();
    requireLib();
    return new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: SPACING.spacer, line: LINE, lineRule: LR }, children: []
    });
  }

  function head(t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      spacing: { before: SPACING.headingBefore, after: SPACING.heading, line: LINE, lineRule: LR },
      border: { bottom: { style: BorderStyle.SINGLE, size: HEADING_BORDER.size, space: HEADING_BORDER.space, color: HEADING_BORDER.colour } },
      children: [new TextRun({ text: t, bold: true, size: HEAD, color: NAVY, font: FONT, characterSpacing: CHAR_SPACING.heading })]
    });
  }

  // Optional third argument prints right-aligned at the margin (tool stack, dates).
  function role(title, org, right) {
    requireConfigured();
    requireLib();
    var children = [new TextRun({ text: title, bold: true, size: BODY, font: FONT })];
    if (org) children.push(new TextRun({ text: " - " + org, size: BODY, font: FONT }));
    var o = { spacing: { before: SPACING.roleBefore, after: SPACING.role, line: LINE, lineRule: LR }, children: children };
    if (right) {
      o.tabStops = [{ type: TabStopType.RIGHT, position: TEXT_WIDTH }];
      children.push(new TextRun({ text: "\t" + right, italics: true, size: SMALL, font: FONT, color: GREY }));
    }
    return new Paragraph(o);
  }

  function dates(t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      spacing: { after: SPACING.dates, line: LINE, lineRule: LR },
      children: [new TextRun({ text: t, italics: true, size: SMALL, font: FONT, color: GREY })]
    });
  }

  function bullet(t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      numbering: { reference: "bullets", level: 0 },
      spacing: { after: SPACING.bullet, line: LINE, lineRule: LR },
      children: [new TextRun({ text: t, size: BODY, font: FONT })]
    });
  }

  // para() is the one generic builder that ALREADY took its spacing/size
  // from the caller (js/assemble.js, which reads data.style.spacingAfter.*
  // itself) rather than a hardcoded literal - that's why it was the one
  // path the review found actually wired live. The 36-twip fallback below
  // only fires for a caller that omits `after` entirely; every current
  // caller always passes it explicitly, so this is a defensive default,
  // not a second copy of a real style value.
  function para(t, o) {
    requireConfigured();
    requireLib();
    o = o || {};
    return new Paragraph({
      spacing: { after: o.after != null ? o.after : 36, line: LINE, lineRule: LR },
      children: [new TextRun({ text: t, size: o.size || BODY, font: FONT, italics: !!o.italics, color: o.color })]
    });
  }

  function skillLine(label, t) {
    requireConfigured();
    requireLib();
    return new Paragraph({
      spacing: { after: SPACING.skillLine, line: LINE, lineRule: LR },
      children: [
        new TextRun({ text: label + SKILL_SUFFIX, bold: true, size: BODY, font: FONT }),
        new TextRun({ text: t, size: BODY, font: FONT })
      ]
    });
  }

  // Converts a content model (the same plain-object block array that
  // js/preview.js renders to HTML) into a docx children array.
  function blocksToChildren(model) {
    requireConfigured();
    requireLib();
    return model.map(function (b) {
      switch (b.t) {
        case "name": return name(b.text);
        case "contact": return contact.apply(null, b.items);
        case "auth": return auth(b.text);
        case "spacer": return spacer();
        case "head": return head(b.text);
        case "role": return role(b.title, b.org, b.right);
        case "dates": return dates(b.text);
        case "bullet": return bullet(b.text);
        case "para": return para(b.text, b.opts);
        case "skillLine": return skillLine(b.label, b.text);
        // letterPara/letterLine (21 Sept 2026, cover-letter renderer): both
        // are plain paragraphs of text - a templated letterBlocks entry and
        // a piece of letter header furniture (date/recipient/salutation/
        // signature) respectively - and para() already takes an explicit
        // size/spacing via b.opts, so neither needs its own builder. Kept
        // as distinct block-model types (not aliased to "para") because
        // js/pagefit.js and js/verify.js each need to tell them apart from
        // an ordinary CV para block, which carries a different provenance
        // shape and a different height-lookup rule.
        case "letterPara": return para(b.text, b.opts);
        case "letterLine": return para(b.text, b.opts);
        default: throw new Error("render-docx: unknown content-model block type '" + b.t + "'");
      }
    });
  }

  // Browser build: explicit A4 page size (from configured style, not a
  // library default), produces a Blob and hands it to the browser as a
  // download (CVLibs.saveBlob, js/libs.js).
  function build(children, filename) {
    requireConfigured();
    return buildWithPage(children, filename, { widthTwips: PAGE.widthTwips, heightTwips: PAGE.heightTwips, margin: MARGIN });
  }

  // buildWithPage (21 Sept 2026, cover-letter renderer, Derin's own
  // instruction: "expose primitives from render-docx.js, compose letter.js
  // from them") - the actual primitive extracted out of build() above.
  // build() only ever assembled a Document against whatever page geometry
  // configure(data.style) last set (style.page - the CV's own geometry).
  // A cover letter has different geometry (data.style.letterPage - wider
  // side margins, deeper bottom margin, confirmed by measuring three real
  // sent letters - see that block's own _readme in the data file), and
  // configure() is a single global "current style" - there is no clean way
  // for build() to know which page to use without a caller telling it.
  // Rather than have js/letter.js call configure() a second time with a
  // synthetic style object (fragile - every OTHER configured value, fonts,
  // colours, body/letterBody sizes, would need to already be right, and a
  // second configure() call mid-session would silently repoint every
  // future CV build too), this takes the page geometry as an explicit
  // argument. build() above is now a thin wrapper passing the currently
  // configured CV geometry - so every existing CV call site is unchanged,
  // and js/letter.js is the one new caller that passes data.style.letterPage
  // directly.
  function buildWithPage(children, filename, pageGeometry) {
    requireConfigured();
    requireLib();
    var doc = new Document({
      numbering: numberingConfig(),
      sections: [{
        properties: {
          page: {
            size: { width: pageGeometry.widthTwips, height: pageGeometry.heightTwips },
            margin: pageGeometry.margin
          }
        },
        children: children
      }]
    });
    return Packer.toBlob(doc).then(function (blob) {
      global.CVLibs.saveBlob(blob, filename);
      return filename;
    });
  }

  global.CVStyle = {
    configure: configure,
    LINKEDIN_URL: LINKEDIN_URL,
    j: j,
    name: name, contact: contact, auth: auth, spacer: spacer, head: head, role: role,
    dates: dates, bullet: bullet, para: para, skillLine: skillLine, build: build,
    buildWithPage: buildWithPage,
    blocksToChildren: blocksToChildren,
    // letterBodySize (21 Sept 2026): js/letter.js needs style.sizes.letterBody
    // to set on its own "letterPara"/"letterLine" blocks' opts.size - reads
    // it through this getter rather than a second copy of data.style, same
    // "one configured source of truth" discipline as everything else in
    // this file. Throws (via requireConfigured) if called before configure().
    letterBodySize: function () { requireConfigured(); return LETTER_BODY; },
    // _test.configured (25 Sept 2026, item 7 - closing the open item in
    // CV-house-style.md/data.style._mustBeReadAtRuntime): exposes exactly
    // what configure() derived from whatever style object it was last
    // given, so the golden suite can assert it against data.style directly
    // rather than trusting this file's own 13 Sept 2026 header comment
    // ("every value below now comes from data.style at runtime") on faith.
    // Test-only - index.html never calls this, same convention as
    // js/app.js's window.CVApp._test.
    _test: {
      configured: function () {
        requireConfigured();
        return {
          colours: { navy: NAVY, grey: GREY, faint: FAINT },
          sizes: { body: BODY, small: SMALL, heading: HEAD, name: NAME, contact: CONT, rightToWork: AUTH, letterBody: LETTER_BODY },
          lineSpacing: { line: LINE, rule: LR },
          font: FONT, separator: SEP, skillLabelSuffix: SKILL_SUFFIX,
          page: PAGE, margin: MARGIN, textWidthTwips: TEXT_WIDTH,
          characterSpacing: CHAR_SPACING, headingBorder: HEADING_BORDER, bullet: BULLET,
          spacingAfter: SPACING, hyperlinkColour: HYPERLINK_COLOUR, hyperlinkUnderline: HYPERLINK_UNDERLINE
        };
      }
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
