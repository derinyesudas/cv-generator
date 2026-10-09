#!/usr/bin/env node
// Builds _site/, the folder GitHub Pages publishes (.github/workflows/
// deploy-site.yml runs this on every push to main). Three jobs:
//
//   1. Only the files the app loads go into _site/. Tests, notes, scripts
//      and docs stay in the repository and are never published.
//   2. The page's own scripts become one file, js/bundle.js, minified with
//      esbuild (fetched by npx at a pinned version). If esbuild cannot be
//      fetched, the bundle is published unminified - it works the same.
//   3. The data file is published without its authoring notes (the
//      "_"-prefixed keys: changelog, reasons, reminders). The source file in
//      data/ is not touched and keeps every note.
//   4. The page asks for the bundle, the stylesheet and the data file by a
//      content stamp (?v=), so a browser never runs a new page with an
//      older copy of any of them.
//
// It stops, and nothing is published, if a file the page asks for is
// missing from _site/ or the published data file fails the app's own
// validation.
//
//   node scripts/build-site.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "_site");
const require = createRequire(import.meta.url);
const DATA_FILE = "data/cv-generator-data.json";
const BUNDLE = "js/bundle.js";
const ESBUILD = "esbuild@0.24.0";

// What the published site is made of (besides the bundle and the data file).
const FILES = ["favicon.svg", "css/app.css"];
const FOLDERS = [
  { dir: "fonts", keep: (f) => /\.(woff2|ttf|txt)$/.test(f) },
  // The libraries and their licence texts; lib/README.md is for maintainers.
  { dir: "lib", keep: (f) => f !== "README.md" },
];

// "_"-prefixed data keys the app reads at runtime (found by searching js/
// for every "._name" property read). Everything else starting with "_" is a
// note and is left out.
const KEEP_KEYS = new Set(["_version", "_blockHeightMeta", "_rules", "_sqlNote", "_pendingReview", "_educationRuleExempt"]);

function fail(message) {
  console.error("build-site: " + message);
  process.exit(1);
}

function copyFile(rel) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) fail("missing source file " + rel);
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return rel;
}

function withoutNotes(value) {
  if (Array.isArray(value)) return value.map(withoutNotes);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("_") && !KEEP_KEYS.has(key)) continue;
    out[key] = withoutNotes(child);
  }
  return out;
}

// The scripts index.html loads from js/, in order, become one file; the
// first of their tags becomes the bundle's tag and the rest are removed. The
// ?v= stamp changes whenever the bundle does, so a browser never pairs a new
// page with an old cached bundle.
function bundleScripts() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const tags = [...html.matchAll(/^[ \t]*<script src="(js\/[^"]+\.js)"><\/script>\r?\n/gm)];
  if (!tags.length) fail("index.html loads no js/ scripts - nothing to bundle");
  const combined = tags
    .map((m) => "/* " + m[1] + " */\n" + fs.readFileSync(path.join(ROOT, m[1]), "utf8"))
    .join("\n;\n");
  const outPath = path.join(OUT, BUNDLE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = path.join(os.tmpdir(), "cv-generator-bundle-" + process.pid + ".js");
  fs.writeFileSync(tmp, combined);
  let minified = true;
  try {
    execFileSync("npx", ["--yes", ESBUILD, tmp, "--minify", "--legal-comments=none", "--log-level=warning", "--outfile=" + outPath], {
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
  } catch (e) {
    minified = false;
    console.warn("build-site: could not run " + ESBUILD + " (" + String(e.message).split("\n")[0] + "); publishing the bundle unminified.");
    fs.writeFileSync(outPath, combined);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const stamp = crypto.createHash("sha256").update(fs.readFileSync(outPath)).digest("hex").slice(0, 10);
  let page = html;
  tags.forEach((m, i) => {
    page = page.replace(m[0], i === 0 ? m[0].replace(m[1], BUNDLE + "?v=" + stamp) : "");
  });
  fs.writeFileSync(path.join(OUT, "index.html"), page);
  return { scripts: tags.length, minified, sourceBytes: Buffer.byteLength(combined), bundleBytes: fs.statSync(outPath).size };
}

// The stylesheet and the data file are asked for by a content stamp too
// (9 Oct 2026), like the bundle. GitHub Pages lets a browser reuse a file for
// up to 10 minutes, so without a stamp a fresh page could run with the
// previous stylesheet or data file in that window. The data file's address
// goes in a <meta> tag that js/data.js reads; the repository's own pages
// have no such tag and load the plain address.
function stampAssets() {
  const indexPath = path.join(OUT, "index.html");
  let page = fs.readFileSync(indexPath, "utf8");
  const stampOf = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT, rel))).digest("hex").slice(0, 10);
  const cssTag = '<link rel="stylesheet" href="css/app.css">';
  if (page.split(cssTag).length !== 2) fail("index.html must load css/app.css exactly once, as " + cssTag);
  const css = stampOf("css/app.css");
  const data = stampOf(DATA_FILE);
  page = page.replace(cssTag,
    '<meta name="cv-data-url" content="' + DATA_FILE + "?v=" + data + '">\n' +
    '<link rel="stylesheet" href="css/app.css?v=' + css + '">');
  fs.writeFileSync(indexPath, page);
  return { css, data };
}

// Every file the published page asks for: script and link tags in
// _site/index.html, url() references in the stylesheet, and the paths the
// scripts fetch themselves.
function referencedFiles() {
  const refs = new Set([DATA_FILE]);
  const html = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
  for (const m of html.matchAll(/\b(?:src|href)="([^"#?]+)/g)) {
    if (!/^(?:https?:|mailto:|data:)/.test(m[1])) refs.add(m[1]);
  }
  const css = fs.readFileSync(path.join(ROOT, "css/app.css"), "utf8");
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (!/^(?:https?:|data:)/.test(m[1])) refs.add(path.posix.normalize(path.posix.join("css", m[1])));
  }
  for (const f of fs.readdirSync(path.join(ROOT, "js"))) {
    const js = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    for (const m of js.matchAll(/["']((?:fonts|lib|data)\/[A-Za-z0-9_.\-/]+\.[a-z0-9]+)["']/g)) refs.add(m[1]);
  }
  refs.delete("data/private-overrides.json"); // never published: it holds private values, loaded per browser
  return refs;
}

// The app's own validator, run on the copy that will be published.
function validate(data) {
  globalThis.window = undefined;
  require(path.join(ROOT, "js/matcher.js"));
  require(path.join(ROOT, "js/blockhash.js"));
  require(path.join(ROOT, "js/validate.js"));
  const errors = globalThis.CVValidate.validateData(data);
  if (errors.length) fail("the published data file fails validation:\n  " + errors.join("\n  "));
  if (globalThis.CVBlockHash.styleHash(data) !== data._blockHeightMeta.styleHash) {
    fail("the published data file's style no longer matches its measured heights");
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const published = FILES.map(copyFile);
for (const { dir, keep } of FOLDERS) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) {
    if (fs.statSync(path.join(ROOT, dir, f)).isFile() && keep(f)) published.push(copyFile(dir + "/" + f));
  }
}

const bundle = bundleScripts();
published.push("index.html", BUNDLE);

const source = JSON.parse(fs.readFileSync(path.join(ROOT, DATA_FILE), "utf8"));
const data = withoutNotes(source);
// style.sizes is hashed as a whole by the page-fit check (js/blockhash.js),
// so it is published exactly as written.
data.style.sizes = source.style.sizes;
validate(data);
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.writeFileSync(path.join(OUT, DATA_FILE), JSON.stringify(data));
published.push(DATA_FILE);
const stamps = stampAssets();

const missing = [...referencedFiles()].filter((rel) => !fs.existsSync(path.join(OUT, rel)));
if (missing.length) fail("the page asks for files that are not in _site/: " + missing.join(", "));

const kb = (n) => (n / 1024).toFixed(0) + "KB";
const sourceSize = fs.statSync(path.join(ROOT, DATA_FILE)).size;
const publishedSize = fs.statSync(path.join(OUT, DATA_FILE)).size;
console.log("build-site: " + published.length + " files in _site/; " + bundle.scripts + " scripts -> " + BUNDLE + " " +
  kb(bundle.sourceBytes) + " -> " + kb(bundle.bundleBytes) + (bundle.minified ? " minified" : " (not minified)") +
  "; data file " + kb(sourceSize) + " -> " + kb(publishedSize) + " without notes; stylesheet ?v=" + stamps.css +
  ", data ?v=" + stamps.data + "; validation passed.");
