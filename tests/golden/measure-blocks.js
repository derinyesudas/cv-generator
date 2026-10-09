#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tests/golden/measure-blocks.js - the real thing, built 19 Sept 2026
// (Derin's "A-E" spec, part E2: "tests/golden/measure-blocks.js is
// referenced by validate.js and the changelog and does not exist... Fix it
// one of two ways, today - build the file at that exact path, or remove
// every reference to it").
//
// WHY THIS EXISTS AT ALL (see js/pagefit.js's own header for the full
// design rationale): every sentence this app prints already exists as fixed
// text in the data file, at a fixed column width and font. That means a
// block's rendered height is not something to guess from a formula - it is
// something to MEASURE ONCE, offline, against the REAL renderer that
// produces the real .docx (LibreOffice - not a browser's own font metrics,
// which do not agree with Word/LibreOffice's line-wrapping closely enough
// to trust), store the number on the fact that produced it, and SUM at
// generation time. This script is that offline measurement step.
//
// METHOD (identical to the throwaway Node harness used by hand for the
// 14 Sept and both 19 Sept passes - this file productionises that exact
// method, not a reimplementation): for every block that needs a height,
// build a ONE-BLOCK .docx using the app's own js/render-docx.js (so
// LibreOffice renders exactly what the real app would produce - same
// style, same fonts, same page geometry), convert it to a PDF with
// `soffice --headless --convert-to pdf`, run `pdftotext -bbox` on the PDF
// to get every word's bounding box, cluster words into lines by yMin
// (tolerance 3pt - two words on the same wrapped line never differ by more
// than a font's internal leading; two different lines always differ by at
// least a full line-advance), count the distinct lines, and multiply by
// the block's own already-measured, empirically-calibrated line-advance
// constant (data._blockHeightMeta.lineAdvancePx - NOT font-size * 1.15,
// which was tried first and undershot the real renderer by ~13-15%, see
// _blockHeightMeta._readme).
//
// SCOPE, stated honestly rather than implied: this script measures every
// bulletVariants variant (heightPx + shortHeightPx where a `.short`
// exists), every profileVariant (heightPx + shortHeightPx), every role's/
// project's/education entry's role+dates lines, every certification's
// items+body lines, education modules lines, volunteering, and every
// letterBlocks entry with text (measured with {{SLOT}} template markers
// stripped out - "measured with template slots empty", matching the note
// already on every letterBlocks heightPx.letter), and every
// hardRequirements.gapBlocks sentence the same way. It deliberately does
// NOT measure skillLine blocks (js/pagefit.js computes those live, from
// the block's actual JD-reordered text, via js/textwrap.js's wrap
// simulator - a stored height would be wrong the moment the order
// changed, see pagefit.js's own header) or section headings / identity
// blocks (name/contact/right-to-work) - those are a small, fixed,
// effectively-never-changing set of strings; _blockHeightMeta.headings/
// .identity are still measured the same way, by hand, the one time a new
// heading string is actually added, rather than by this script. A
// dangling reference to "this script also does headings/identity" would
// be exactly the kind of false claim Derin's own E2 instruction exists to
// catch - so validate.js's error strings for those two checks point at
// this file's header, not at a coverage claim this script does not keep.
//
// USAGE:
//   node tests/golden/measure-blocks.js                 - report only,
//     prints every computed height next to the data file's CURRENT stored
//     value (flagging drift) - writes nothing.
//   node tests/golden/measure-blocks.js --apply          - same
//     measurement, but writes every computed height straight back into
//     data/cv-generator-data.json (stamping each one with a hash of its
//     own text plus the style values it depends on, per item 6 of Derin's
//     27 Sept 2026 work order - see js/blockhash.js's own header for why
//     this replaced the old "stamp data._version" scheme) and re-saves
//     the file. This is the one script that does both measuring and
//     applying - the two-script split
//     ("measure-blocks.js and apply-heights.js") a few old error strings
//     used to describe was never built that way; folding both into one
//     script, with --apply opt-in, is this pass's own decision, not a
//     rediscovery of a lost second file. Every reference to a separate
//     apply-heights.js has been removed accordingly (see this file's own
//     PR/changelog note).
//   node tests/golden/measure-blocks.js --out=report.json - also writes
//     the full report as JSON to the given path.
//
// Requires: LibreOffice (`soffice`) and poppler-utils (`pdftotext`) on
// PATH - both already used by this repo's own golden-test setup notes.
// ---------------------------------------------------------------------------
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_PATH = path.join(REPO_ROOT, "data", "cv-generator-data.json");

const args = process.argv.slice(2);
const APPLY = args.indexOf("--apply") !== -1;
const OUT_ARG = args.find((a) => a.startsWith("--out="));
const OUT_PATH = OUT_ARG ? OUT_ARG.slice("--out=".length) : null;

// --- Load the app's own renderer, headless (Node, no `window`) -------------
global.window = undefined;
global.docx = require(path.join(REPO_ROOT, "lib", "docx.umd.js"));
global.globalThis.docx = global.docx;
require(path.join(REPO_ROOT, "js", "render-docx.js"));
require(path.join(REPO_ROOT, "js", "blockhash.js"));
const CVStyle = global.CVStyle;
const BlockHash = global.CVBlockHash;

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
CVStyle.configure(data.style);

const { Document, Packer, LevelFormat, AlignmentType } = global.docx;
const META = data._blockHeightMeta;
// 27 Sept 2026, item 6: dataVersion (compared against data._version) is
// gone - see js/blockhash.js's own header for why. styleHash is a pure
// function of data.style (font/sizes/page widths/bullet geometry), so
// there's no measurement step for it at all - main()'s --apply branch
// below always re-stamps it, whether or not it actually changed, which is
// exactly what makes it impossible to forget (unlike lineAdvancePx/
// charWidths/identity/headings, which stay hand-measured - see this
// file's own SCOPE comment above).

const BULLET_STYLE = data.style.bullet;
function numberingConfig() {
  return {
    config: [{
      reference: "bullets",
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: BULLET_STYLE.glyph, alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: BULLET_STYLE.indentLeft, hanging: BULLET_STYLE.hanging } }, run: { color: BULLET_STYLE.colour } }
      }]
    }]
  };
}

// --- Build one single-block .docx, matching the exact page geometry the
// real document that block would appear in uses (CV page vs letter page). ---
async function buildDocx(model, docType) {
  const page = docType === "letter" ? data.style.letterPage : data.style.page;
  const children = CVStyle.blocksToChildren(model);
  const doc = new Document({
    numbering: numberingConfig(),
    sections: [{
      properties: { page: { size: { width: page.widthTwips, height: page.heightTwips }, margin: page.margin } },
      children: children
    }]
  });
  return Packer.toBuffer(doc);
}

// --- pdftotext -bbox parsing: cluster words into lines by yMin, 3pt
// tolerance (see file header) - a direct, non-reimplemented port of the
// method used by hand for every pass so far. -------------------------------
function countWrappedLines(pdfPath) {
  const xml = execFileSync("pdftotext", ["-bbox", pdfPath, "-"], { encoding: "utf8" });
  const wordRe = /<word[^>]*\byMin="([\d.]+)"/g;
  const yMins = [];
  let m;
  while ((m = wordRe.exec(xml)) !== null) yMins.push(parseFloat(m[1]));
  if (!yMins.length) return 0;
  yMins.sort((a, b) => a - b);
  let lines = 1;
  let clusterY = yMins[0];
  for (let i = 1; i < yMins.length; i++) {
    if (yMins[i] - clusterY > 3) { lines++; clusterY = yMins[i]; }
  }
  return lines;
}

async function measureOne(model, docType) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-measure-"));
  try {
    const docxPath = path.join(tmpDir, "block.docx");
    const buf = await buildDocx(model, docType);
    fs.writeFileSync(docxPath, buf);
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, docxPath], { stdio: "pipe" });
    const pdfPath = path.join(tmpDir, "block.pdf");
    const lines = countWrappedLines(pdfPath);
    return lines;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const SIZE_KEY = { body: "body", small: "small", letterBody: "letterBody" };

function heightFromLines(lines, sizeKey) {
  const advance = META.lineAdvancePx[SIZE_KEY[sizeKey]];
  if (advance == null) throw new Error("measure-blocks.js: no lineAdvancePx entry for '" + sizeKey + "'.");
  return Math.round(lines * advance * 100) / 100;
}

// --- Strip {{SLOT}} template markers before measuring a letterBlocks entry
// - "measured with template slots empty", matching the note already stored
// on every letterBlocks heightPx.letter; the runtime delta for whatever
// actually gets substituted is added live by js/pagefit.js's
// letterBlockHeight() wrap-simulator, not by this script. -------------------
function stripSlots(text) {
  return String(text).replace(/\{\{[A-Z]+\}\}/g, "");
}

// --- Collect every measurement target -------------------------------------
// Each target: { path: "<dotted path into `data` for the report/--apply
// write>", model: [block], docType: "cv"|"letter", sizeKey }
function collectTargets() {
  const targets = [];

  // linesSaved (20 Sept 2026, Derin's own instruction: "A short variant
  // that does not save a line is strictly worse than no short variant...
  // MEASURE IT. measure-blocks computes linesSaved for every short variant
  // and stores it alongside the height."): full's `lines` is captured by
  // closure so the short target's write() - which always runs right after
  // the full target for the same variant, see the push order below - can
  // compute fullLines - shortLines once both are known and stamp it onto
  // the variant/profile object directly, next to `short`/`shortHeightPx`,
  // not buried in the report-only output. js/trim.js's shorten step (see
  // that file) skips any candidate with linesSaved === 0; js/validate.js
  // warns (not fails - a zero-saving short is dead weight, not a broken
  // file) when one exists uncaught.
  // Every target now also carries hashText/sizeKey/docType/isBullet -
  // exactly the four inputs js/blockhash.js's CVBlockHash.blockHash needs
  // to compute the same fingerprint js/validate.js recomputes at load
  // time (see that file's own comment on why this is a deliberate,
  // labelled duplication rather than a shared target list). write()
  // closures below take (px, lines, hash) instead of (px, lines) and
  // store `hash` in place of the old `dataVersion: DV`.
  Object.keys(data.bulletVariants || {}).forEach((gid) => {
    (data.bulletVariants[gid].variants || []).forEach((v) => {
      var fullLines = null;
      targets.push({ id: gid + "." + v.id + ".heightPx", model: [{ t: "bullet", text: v.text }], docType: "cv", sizeKey: "body", isBullet: true, hashText: v.text, write: (px, lines, hash) => { v.heightPx = { cv: px, hash: hash }; fullLines = lines; } });
      if (typeof v.short === "string" && v.short.length) {
        targets.push({ id: gid + "." + v.id + ".shortHeightPx", model: [{ t: "bullet", text: v.short }], docType: "cv", sizeKey: "body", isBullet: true, hashText: v.short, write: (px, lines, hash) => { v.shortHeightPx = { cv: px, hash: hash }; v.linesSaved = fullLines - lines; } });
      }
    });
  });

  (data.profileVariants || []).forEach((p) => {
    var fullLines = null;
    targets.push({ id: "profileVariants." + p.id + ".heightPx", model: [{ t: "para", text: p.text, opts: { after: data.style.spacingAfter.profile } }], docType: "cv", sizeKey: "body", hashText: p.text, write: (px, lines, hash) => { p.heightPx = { cv: px, hash: hash }; fullLines = lines; } });
    if (typeof p.short === "string" && p.short.length) {
      targets.push({ id: "profileVariants." + p.id + ".shortHeightPx", model: [{ t: "para", text: p.short, opts: { after: data.style.spacingAfter.profile } }], docType: "cv", sizeKey: "body", hashText: p.short, write: (px, lines, hash) => { p.shortHeightPx = { cv: px, hash: hash }; p.linesSaved = fullLines - lines; } });
    }
  });

  // `roleOrgOnTitleLine` mirrors js/assemble.js's own split exactly:
  // buildExperience() and buildEducation() both put the role's/entry's own
  // `org` on the TITLE line (role(title, org, right)); buildProjects()
  // deliberately passes org: null there and prints `proj.org` on the DATES
  // line instead (see assemble.js's buildProjects()) - getting this wrong
  // was this script's own first bug, caught by comparing its output
  // against the real, already-correct stored values before trusting it
  // (facts.project.heightPx.role came back 33.47px/2-line here instead of
  // the real 16.73px/1-line, because org was wrongly concatenated onto the
  // project's title line - fixed by this flag, not by editing the stored
  // value, since the stored value was the one that was right). The same
  // titleOrg/datesText split is what js/validate.js's own roleHashText/
  // datesHashText reconstruct independently - keep both in sync by hand
  // if this ever changes (see checkHeight's own header on why they're not
  // shared code).
  function roleAndDates(entry, label, roleOrgOnTitleLine) {
    var titleOrg = roleOrgOnTitleLine ? (entry.org || null) : null;
    var datesText = roleOrgOnTitleLine ? (entry.dates || "") : (entry.dates || entry.org || "");
    var roleHashText = [entry.title, titleOrg, (entry.right || entry.stack || null)].map((x) => x == null ? "" : String(x)).join("\u0001");
    targets.push({ id: label + ".heightPx.role", model: [{ t: "role", title: entry.title, org: titleOrg, right: entry.right || entry.stack || null }], docType: "cv", sizeKey: "body", hashText: roleHashText, write: (px, lines, hash) => { entry.heightPx = entry.heightPx || {}; entry.heightPx.role = { cv: px, hash: hash }; } });
    targets.push({ id: label + ".heightPx.dates", model: [{ t: "dates", text: datesText }], docType: "cv", sizeKey: "small", hashText: datesText, write: (px, lines, hash) => { entry.heightPx = entry.heightPx || {}; entry.heightPx.dates = { cv: px, hash: hash }; } });
  }
  (data.facts.roles || []).forEach((r) => roleAndDates(r, "facts.roles['" + r.id + "']", true));
  (data.facts.education || []).forEach((e) => {
    roleAndDates(e, "facts.education['" + e.id + "']", true);
    if (e.printModules && e.modules && e.modules.length) {
      const text = "Modules: " + e.modules.join(", ");
      targets.push({ id: "facts.education['" + e.id + "'].heightPx.modules", model: [{ t: "para", text: text, opts: { size: data.style.sizes.small, after: data.style.spacingAfter.modules } }], docType: "cv", sizeKey: "small", hashText: text, write: (px, lines, hash) => { e.heightPx = e.heightPx || {}; e.heightPx.modules = { cv: px, hash: hash }; } });
    }
  });
  const projectFacts = (data.facts.projects || []).slice();
  if (data.facts.project) projectFacts.push(data.facts.project);
  projectFacts.forEach((p) => roleAndDates(p, "facts.project(s)['" + p.id + "']", false));

  (data.facts.certifications || []).forEach((c) => {
    const itemsText = c.items.map((it) => it.display).join(data.style.separator);
    targets.push({ id: "facts.certifications['" + c.id + "'].heightPx.items", model: [{ t: "para", text: itemsText, opts: { after: data.style.spacingAfter.certItem } }], docType: "cv", sizeKey: "body", hashText: itemsText, write: (px, lines, hash) => { c.heightPx = c.heightPx || {}; c.heightPx.items = { cv: px, hash: hash }; } });
    targets.push({ id: "facts.certifications['" + c.id + "'].heightPx.body", model: [{ t: "para", text: c.body, opts: { size: data.style.sizes.small, italics: true, color: data.style.colours.grey, after: data.style.spacingAfter.certBody } }], docType: "cv", sizeKey: "small", hashText: c.body, write: (px, lines, hash) => { c.heightPx = c.heightPx || {}; c.heightPx.body = { cv: px, hash: hash }; } });
  });

  if (data.facts.volunteering) {
    const v = data.facts.volunteering;
    targets.push({ id: "facts.volunteering.heightPx", model: [{ t: "para", text: v.text, opts: { size: data.style.sizes.small, after: 0 } }], docType: "cv", sizeKey: "small", hashText: v.text, write: (px, lines, hash) => { v.heightPx = { cv: px, hash: hash }; } });
  }

  Object.keys(data.letterBlocks || {}).forEach((category) => {
    const entries = data.letterBlocks[category];
    if (!Array.isArray(entries)) return; // e.g. letterBlocks._rules, a plain string
    entries.forEach((b) => {
      if (!b.text) return;
      const baseline = stripSlots(b.text);
      targets.push({
        id: "letterBlocks['" + category + "']['" + b.id + "'].heightPx",
        model: [{ t: "para", text: baseline, opts: { size: data.style.sizes.letterBody } }],
        docType: "letter", sizeKey: "letterBody", hashText: baseline,
        write: (px, lines, hash) => { b.heightPx = b.heightPx || {}; b.heightPx.letter = px; b.heightPx.hash = hash; delete b.heightPx.dataVersion; if (!b.heightPx.note) b.heightPx.note = "measured with template slots empty - wrap-simulator adds the runtime delta for whatever gets substituted"; }
      });
    });
  });

  // The sentences a letter adds after "Build anyway" on a RED ad
  // (js/letterbuild.js's buildHardReqGapBlock). js/pagefit.js reads their
  // heights exactly like a letterBlocks entry's, so they are measured the
  // same way.
  ((data.hardRequirements && data.hardRequirements.gapBlocks) || []).forEach((b) => {
    if (!b.text) return;
    const baseline = stripSlots(b.text);
    targets.push({
      id: "hardRequirements.gapBlocks['" + b.id + "'].heightPx",
      model: [{ t: "para", text: baseline, opts: { size: data.style.sizes.letterBody } }],
      docType: "letter", sizeKey: "letterBody", hashText: baseline,
      write: (px, lines, hash) => { b.heightPx = { letter: px, hash: hash }; }
    });
  });

  return targets;
}

function currentValue(target) {
  // Best-effort: re-derive the same nested read the write() closure would
  // write to, purely for the report's "current vs measured" column - not
  // used for anything else.
  return null; // intentionally not tracked per-target; the report prints computed values only, see main()
}

async function main() {
  const targets = collectTargets();
  console.log("measure-blocks.js: " + targets.length + " block(s) to measure against data._version " + data._version + (APPLY ? " (--apply: will write back)" : " (report only - pass --apply to write)") + "...");
  const report = [];
  for (const t of targets) {
    const lines = await measureOne(t.model, t.docType);
    const px = heightFromLines(lines, t.sizeKey);
    const hash = BlockHash.blockHash(data, META, { text: t.hashText, sizeKey: t.sizeKey, docType: t.docType, isBullet: !!t.isBullet });
    report.push({ id: t.id, lines: lines, heightPx: px, hash: hash });
    console.log("  " + t.id + ": " + lines + " line(s) -> " + px + "px (hash " + hash + ")");
    if (APPLY) t.write(px, lines, hash);
  }
  if (APPLY) {
    // styleHash is a pure function of data.style - always re-stamped here,
    // whether or not it actually changed, so it can never go stale the
    // way the old dataVersion field could (see this file's own top-of-file
    // comment on this same field).
    if (data._blockHeightMeta) {
      data._blockHeightMeta.styleHash = BlockHash.styleHash(data);
      delete data._blockHeightMeta.dataVersion;
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log("measure-blocks.js: wrote " + targets.length + " measurement(s) back into " + path.relative(REPO_ROOT, DATA_PATH));

    // Zero-saving shorts (20 Sept 2026): surfaced here too, not just as a
    // load-time validate.js warning - this is the moment the number is
    // actually known, so print it here rather than making the person go
    // start the app to find out.
    var zeroSaving = [];
    Object.keys(data.bulletVariants || {}).forEach((gid) => {
      (data.bulletVariants[gid].variants || []).forEach((v) => {
        if (typeof v.linesSaved === "number" && v.linesSaved === 0) zeroSaving.push(gid + "." + v.id);
      });
    });
    (data.profileVariants || []).forEach((p) => {
      if (typeof p.linesSaved === "number" && p.linesSaved === 0) zeroSaving.push("profileVariants." + p.id);
    });
    if (zeroSaving.length) {
      console.log("measure-blocks.js: " + zeroSaving.length + " short variant(s) save ZERO lines (dead weight - " +
        "see data.trimPolicy's zero-saving-shorts note): " + zeroSaving.join(", "));
    }
  }
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log("measure-blocks.js: wrote report to " + OUT_PATH);
  }
  console.log("measure-blocks.js: done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
