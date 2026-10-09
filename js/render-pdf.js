// ---------------------------------------------------------------------------
// PDF renderer (2 Oct 2026). Derin asked for a PDF download ("CVs always as
// PDF") and chose, when asked, a PDF built in the browser rather than
// converting the .docx by hand each time.
//
// Same input as js/render-docx.js - the already-built, already-verified
// content model - and the same style values (data.style, read at runtime
// via configure(), never copied). Nothing here selects or writes content:
// it only lays out and draws the exact blocks the .docx gets.
//
// Layout follows how LibreOffice lays out this app's own .docx files, the
// renderer every measured height in data._blockHeightMeta came from, so a
// page the fit check passes is a page this file fits:
//   - Font: Liberation Serif (SIL OFL 1.1, fonts/), metric-compatible with
//     Times New Roman - every character is exactly as wide as in the .docx,
//     so lines break in the same places. Embedded (jsPDF subsets it to the
//     glyphs used) with a Unicode map, so the text copies and parses
//     cleanly (ATS).
//   - Line advance: the measured LibreOffice value for each size
//     (data._blockHeightMeta.lineAdvancePx); baseline at (line gap +
//     ascent) below the top of the line - checked against LibreOffice's own
//     PDF of the same .docx to within 0.05pt.
//   - Between paragraphs, the larger of the first's space-after and the
//     second's space-before (what LibreOffice does with these .docx files).
//   - An empty paragraph (the CV's spacer) is one 10pt line, the default
//     size an empty paragraph mark gets in a .docx with no default style.
//   - Section headings: a 0.75pt rule 2pt below the text's descent, the
//     rule's height added below the heading, as Word/LibreOffice draw a
//     paragraph's bottom border.
//   - Bullets: the glyph is 10pt, like the .docx's numbering glyph (it has
//     no size of its own, so it takes the empty-paragraph default), which
//     makes each bullet's first line a little taller than the rest, as in
//     LibreOffice's rendering.
// Checked with tests/pdf-compare.py against LibreOffice's PDF of the same
// .docx for every fixture ad: identical line breaks, baselines within a
// fraction of a point.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var FONT_FILES = {
    normal: "fonts/LiberationSerif-Regular.ttf",
    bold: "fonts/LiberationSerif-Bold.ttf",
    italic: "fonts/LiberationSerif-Italic.ttf"
  };
  // One family name per face, so each embedded font carries its own name
  // (a PDF's font list then reads Regular/Bold/Italic, not one name 3x).
  var FAMILY = { normal: "LiberationSerif", bold: "LiberationSerif-Bold", italic: "LiberationSerif-Italic" };
  // Liberation Serif / Times New Roman vertical metrics, font units.
  var UPEM = 2048, ASCENT = 1825, DESCENT = 443, LINE_GAP = 87;
  // Size (pt) of a run with no size of its own in these .docx files - the
  // empty spacer paragraph's mark and the bullet glyph. No default style
  // is written, so Word/LibreOffice fall back to 10pt.
  var DEFAULT_RUN_PT = 10;

  var S = null;
  var META = null;
  var fontsPromise = null;

  function configure(data) {
    S = data.style;
    META = data._blockHeightMeta;
  }
  function requireConfigured() {
    if (!S || !META) throw new Error("render-pdf.js: configure(data) must be called before building a PDF.");
  }

  function twipsToPt(t) { return t / 20; }
  function halfPointsToPt(h) { return h / 2; }
  function rgb(hex) {
    var h = String(hex || "000000").replace(/^#/, "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  // Line advance for a size in pt: LibreOffice's measured value where this
  // size is one the style uses (always, today), else the same 1.15 x
  // single-line formula those measurements follow.
  function lineAdvance(sizePt) {
    var keys = Object.keys(S.sizes);
    for (var i = 0; i < keys.length; i++) {
      if (halfPointsToPt(S.sizes[keys[i]]) === sizePt && META.lineAdvancePx[keys[i]] != null) {
        return META.lineAdvancePx[keys[i]] * 0.75;
      }
    }
    return sizePt * (ASCENT + DESCENT + LINE_GAP) / UPEM * (S.lineSpacing.line / 240);
  }
  function baselineOffset(sizePt) { return sizePt * (LINE_GAP + ASCENT) / UPEM; }

  // --- Fonts: fetched once, on first use, kept for the session -------------
  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return global.btoa(chunks.join(""));
  }
  function loadFonts() {
    if (fontsPromise) return fontsPromise;
    var styles = Object.keys(FONT_FILES);
    fontsPromise = Promise.all(styles.map(function (st) {
      return global.fetch(FONT_FILES[st]).then(function (r) {
        if (!r.ok) throw new Error("could not load " + FONT_FILES[st] + " (HTTP " + r.status + ")");
        return r.arrayBuffer();
      });
    })).then(function (buffers) {
      var out = {};
      styles.forEach(function (st, i) { out[st] = toBase64(buffers[i]); });
      return out;
    });
    fontsPromise.catch(function () { fontsPromise = null; }); // let a later click retry
    return fontsPromise;
  }

  // --- Blocks -> paragraph specs (mirrors js/render-docx.js exactly) --------
  function run(text, o) {
    o = o || {};
    return {
      text: text, bold: !!o.bold, italic: !!o.italic, size: o.size, color: o.color || "000000",
      charSpace: o.charSpace || 0, link: o.link || null
    };
  }
  function spacingFor(b) {
    var sp = S.spacingAfter;
    switch (b.t) {
      case "name": return { before: 0, after: sp.name };
      case "contact": return { before: 0, after: sp.contact };
      case "auth": return { before: 0, after: sp.rightToWork };
      case "spacer": return { before: 0, after: sp.spacer };
      case "head": return { before: sp.headingBefore, after: sp.heading };
      case "role": return { before: sp.roleBefore, after: sp.role };
      case "dates": return { before: 0, after: sp.dates };
      case "bullet": return { before: 0, after: sp.bullet };
      case "skillLine": return { before: 0, after: sp.skillLine };
      case "para": return { before: 0, after: b.opts && b.opts.after != null ? b.opts.after : 36 };
      case "letterPara":
      case "letterLine": return { before: 0, after: b.opts && b.opts.after != null ? b.opts.after : sp.letterPara };
      default: return { before: 0, after: 0 };
    }
  }
  function paragraphFor(b) {
    var body = halfPointsToPt(S.sizes.body);
    var small = halfPointsToPt(S.sizes.small);
    var navy = S.colours.navy, grey = S.colours.grey, faint = S.colours.faint;
    var sp = spacingFor(b);
    var p = { align: "left", indent: 0, runs: [], before: twipsToPt(sp.before), after: twipsToPt(sp.after) };
    switch (b.t) {
      case "name":
        p.align = "center";
        p.runs = [run(b.text, { bold: true, size: halfPointsToPt(S.sizes.name), color: navy, charSpace: twipsToPt(S.characterSpacing.name) })];
        break;
      case "contact":
        p.align = "center";
        var cs = halfPointsToPt(S.sizes.contact);
        (b.items || []).forEach(function (it, i) {
          if (i > 0) p.runs.push(run(S.separator, { size: cs }));
          var isObj = it && typeof it === "object";
          var text = isObj ? it.text : String(it);
          var link = isObj ? it.link : null;
          p.runs.push(run(text, { size: cs, color: link ? S.hyperlinkColour : null, link: link }));
        });
        break;
      case "auth":
        p.align = "center";
        p.runs = [run(b.text, { italic: true, size: halfPointsToPt(S.sizes.rightToWork), color: faint })];
        break;
      case "spacer":
        p.empty = true;
        p.align = "center";
        break;
      case "head":
        p.runs = [run(b.text, { bold: true, size: halfPointsToPt(S.sizes.heading), color: navy, charSpace: twipsToPt(S.characterSpacing.heading) })];
        p.border = { width: S.headingBorder.size / 8, space: S.headingBorder.space, color: S.headingBorder.colour };
        break;
      case "role":
        p.runs = [run(b.title, { bold: true, size: body })];
        if (b.org) p.runs.push(run(" - " + b.org, { size: body }));
        if (b.right) p.right = run(b.right, { italic: true, size: small, color: grey });
        break;
      case "dates":
        p.runs = [run(b.text, { italic: true, size: small, color: grey })];
        break;
      case "bullet":
        p.indent = twipsToPt(S.bullet.indentLeft);
        p.glyph = { text: S.bullet.glyph, x: twipsToPt(S.bullet.indentLeft - S.bullet.hanging), color: S.bullet.colour, size: DEFAULT_RUN_PT };
        p.runs = [run(b.text, { size: body })];
        break;
      case "skillLine":
        p.runs = [run(b.label + S.skillLabelSuffix, { bold: true, size: body }), run(b.text, { size: body })];
        break;
      case "para":
      case "letterPara":
      case "letterLine":
        var o = b.opts || {};
        p.runs = [run(b.text, { size: o.size ? halfPointsToPt(o.size) : body, italic: !!o.italics, color: o.color })];
        break;
      default:
        throw new Error("render-pdf: unknown content-model block type '" + b.t + "'");
    }
    return p;
  }

  // --- Line breaking -----------------------------------------------------------
  // Greedy, at spaces - the same rule Word/LibreOffice apply to this
  // left-aligned text with these exact character widths.
  function setRunFont(doc, r) {
    doc.setFont(FAMILY[r.bold ? "bold" : (r.italic ? "italic" : "normal")], "normal");
    doc.setFontSize(r.size);
  }
  function widthOf(doc, r, text) {
    setRunFont(doc, r);
    return doc.getStringUnitWidth(text) * r.size + r.charSpace * text.length;
  }
  function wrap(doc, p, widthPt) {
    // Tokens: words (possibly spanning runs) separated by spaces.
    var words = [];
    var cur = null;
    p.runs.forEach(function (r) {
      var parts = r.text.split(/( +)/);
      parts.forEach(function (part) {
        if (!part) return;
        if (/^ +$/.test(part)) {
          if (cur) { words.push(cur); cur = null; }
          words.push({ space: true, pieces: [{ run: r, text: part }] });
        } else {
          if (!cur) cur = { space: false, pieces: [] };
          cur.pieces.push({ run: r, text: part });
        }
      });
    });
    if (cur) words.push(cur);
    words.forEach(function (w) {
      w.width = w.pieces.reduce(function (s, pc) { return s + widthOf(doc, pc.run, pc.text); }, 0);
    });

    var lines = [];
    var line = { items: [], width: 0 };
    var pendingSpaces = [];
    words.forEach(function (w) {
      if (w.space) {
        if (line.items.length) pendingSpaces.push(w);
        return;
      }
      var spaceWidth = pendingSpaces.reduce(function (s, x) { return s + x.width; }, 0);
      if (line.items.length && line.width + spaceWidth + w.width > widthPt + 0.01) {
        lines.push(line);
        line = { items: [], width: 0 };
        pendingSpaces = [];
        spaceWidth = 0;
      }
      pendingSpaces.forEach(function (sp) { line.items.push(sp); });
      line.width += spaceWidth;
      pendingSpaces = [];
      line.items.push(w);
      line.width += w.width;
    });
    if (line.items.length || !lines.length) lines.push(line);
    return lines;
  }

  function maxSize(p) {
    var m = 0;
    p.runs.forEach(function (r) { if (r.size > m) m = r.size; });
    if (p.right && p.right.size > m) m = p.right.size;
    return m || DEFAULT_RUN_PT;
  }

  // --- Drawing -------------------------------------------------------------------
  function drawPiece(doc, piece, x, baseline) {
    var r = piece.run;
    setRunFont(doc, r);
    var c = rgb(r.color);
    doc.setTextColor(c[0], c[1], c[2]);
    var opts = { baseline: "alphabetic" };
    if (r.charSpace) opts.charSpace = r.charSpace;
    doc.text(piece.text, x, baseline, opts);
    var w = widthOf(doc, r, piece.text);
    if (r.link) {
      var top = baseline - r.size * ASCENT / UPEM;
      doc.link(x, top, w, r.size * (ASCENT + DESCENT) / UPEM, { url: r.link });
    }
    return w;
  }

  // geometry: { widthPt, heightPt, margin: {top,right,bottom,left} (pt) }
  function layoutAndDraw(doc, model, g) {
    var textWidth = g.widthPt - g.margin.left - g.margin.right;
    var bottomLimit = g.heightPt - g.margin.bottom;
    var y = g.margin.top;
    var pages = 1;
    var prevAfter = null;
    var maxBottom = y;
    var lineCount = 0;
    model.forEach(function (b) {
      var p = paragraphFor(b);
      y += prevAfter == null ? p.before : Math.max(prevAfter, p.before);
      prevAfter = p.after;
      if (p.empty) {
        y += lineAdvance(DEFAULT_RUN_PT);
        return;
      }
      var size = maxSize(p);
      var lines = wrap(doc, p, textWidth - p.indent);
      var lastBaseline = y;
      lines.forEach(function (line, li) {
        var advance = lineAdvance(size);
        var base = baselineOffset(size);
        // A bullet's first line also carries the 10pt glyph: its baseline
        // sits that much lower and the line grows by the same amount times
        // the line-spacing multiple (LibreOffice's rendering, to 0.03pt).
        if (li === 0 && p.glyph && p.glyph.size > size) {
          var extra = baselineOffset(p.glyph.size) - base;
          base += extra;
          advance += extra * (S.lineSpacing.line / 240);
        }
        if (y + advance > bottomLimit + 0.5) {
          doc.addPage([g.widthPt, g.heightPt]);
          pages++;
          y = g.margin.top;
        }
        var baseline = y + base;
        lastBaseline = baseline;
        var x = g.margin.left + p.indent;
        if (p.align === "center") {
          var trailing = 0;
          var last = line.items[line.items.length - 1];
          if (last && last.pieces.length) {
            var lp = last.pieces[last.pieces.length - 1];
            trailing = lp.run.charSpace || 0; // Word's spacing after the last letter doesn't shift the centre
          }
          x = g.margin.left + (textWidth - (line.width - trailing)) / 2;
        }
        if (li === 0 && p.glyph) {
          var gr = run(p.glyph.text, { size: p.glyph.size, color: p.glyph.color });
          drawPiece(doc, { run: gr, text: p.glyph.text }, g.margin.left + p.glyph.x, baseline);
        }
        line.items.forEach(function (w) {
          w.pieces.forEach(function (pc) { x += drawPiece(doc, pc, x, baseline); });
        });
        if (li === 0 && p.right) {
          var rw = widthOf(doc, p.right, p.right.text);
          drawPiece(doc, { run: p.right, text: p.right.text }, g.margin.left + textWidth - rw, baseline);
        }
        y += advance;
        lineCount++;
      });
      if (p.border) {
        var ruleY = lastBaseline + size * DESCENT / UPEM + p.border.space + p.border.width / 2;
        var c = rgb(p.border.color);
        doc.setDrawColor(c[0], c[1], c[2]);
        doc.setLineWidth(p.border.width);
        doc.line(g.margin.left, ruleY, g.margin.left + textWidth, ruleY);
        y += p.border.space + p.border.width;
      }
      if (y > maxBottom) maxBottom = y;
    });
    return { pages: pages, contentBottomPt: y, usableBottomPt: bottomLimit, overflowPt: Math.max(0, y - bottomLimit), lineCount: lineCount };
  }

  // jsPDF writes a CID font's /Ordering as "Identity-H" (the encoding's
  // name); the PDF spec's value is "Identity". Viewers cope, but strict
  // parsers (poppler, some ATS pipelines) complain. Patched in place with
  // the same byte length - "(Identity)" plus two spaces - so every xref
  // offset in the file stays exact.
  function fixCidOrdering(buffer) {
    var bytes = new Uint8Array(buffer);
    var needle = "/Ordering (Identity-H)";
    var repl = "/Ordering (Identity)  ";
    var n = needle.length;
    for (var i = 0; i <= bytes.length - n; i++) {
      if (bytes[i] !== 47) continue; // "/"
      var match = true;
      for (var k = 0; k < n; k++) {
        if (bytes[i + k] !== needle.charCodeAt(k)) { match = false; break; }
      }
      if (match) {
        for (var m = 0; m < n; m++) bytes[i + m] = repl.charCodeAt(m);
        i += n - 1;
      }
    }
    return bytes;
  }

  // build(model, { page: data.style.page | data.style.letterPage, title, subject })
  // -> Promise<{ blob, pages, overflowPt, contentBottomPt }>
  function build(model, opts) {
    requireConfigured();
    opts = opts || {};
    var page = opts.page || S.page;
    var g = {
      widthPt: twipsToPt(page.widthTwips), heightPt: twipsToPt(page.heightTwips),
      margin: { top: twipsToPt(page.margin.top), right: twipsToPt(page.margin.right), bottom: twipsToPt(page.margin.bottom), left: twipsToPt(page.margin.left) }
    };
    // The library and the fonts are fetched on the first PDF, together.
    return Promise.all([global.CVLibs.load("pdf"), loadFonts()]).then(function (loaded) {
      var fonts = loaded[1];
      var doc = new global.jspdf.jsPDF({ unit: "pt", format: [g.widthPt, g.heightPt], orientation: "portrait", compress: true });
      Object.keys(fonts).forEach(function (st) {
        var file = FAMILY[st] + ".ttf";
        doc.addFileToVFS(file, fonts[st]);
        doc.addFont(file, FAMILY[st], "normal");
      });
      // Title and author only: nothing that says how the document was made
      // or which archetype it was tailored to ends up in its properties.
      doc.setProperties({ title: opts.title || "", author: opts.author || "" });
      if (doc.setLanguage) doc.setLanguage("en-IE");
      var result = layoutAndDraw(doc, model, g);
      result.blob = new Blob([fixCidOrdering(doc.output("arraybuffer"))], { type: "application/pdf" });
      return result;
    });
  }

  // Builds, refuses to save a PDF that spilled onto a second page (the fit
  // check said one page; a mismatch is a bug to report, not a file to send),
  // and saves it - same delivery path as the .docx.
  function download(model, filename, opts) {
    return build(model, opts).then(function (result) {
      if (result.pages > 1) {
        throw new Error("the PDF ran onto a second page (" + Math.round(result.overflowPt) + "pt over) although the page-fit check passed - not saved. Use the .docx for this one and report it.");
      }
      global.CVLibs.saveBlob(result.blob, filename);
      return filename;
    });
  }

  global.CVPdf = {
    configure: configure,
    build: build,
    download: download,
    _test: { lineAdvance: function (s) { requireConfigured(); return lineAdvance(s); }, baselineOffset: baselineOffset, paragraphFor: function (b) { requireConfigured(); return paragraphFor(b); } }
  };
})(typeof window !== "undefined" ? window : globalThis);
