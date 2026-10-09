// ---------------------------------------------------------------------------
// Phase 3: loads cv-generator-data.json. Nothing else in the app is allowed
// to hard-code CV text after this point - js/assemble.js reads everything
// from what this returns.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // The published page names the data file with a content stamp
  // (scripts/build-site.mjs, 9 Oct 2026) so a browser never reuses an older
  // copy after a push. The repository's own pages have no such tag.
  function stampedUrl() {
    var meta = typeof document !== "undefined" ? document.querySelector('meta[name="cv-data-url"]') : null;
    var url = meta ? meta.getAttribute("content") : "";
    return /^data\/cv-generator-data\.json\?v=[0-9a-f]+$/.test(url || "") ? url : null;
  }

  // Returns a Promise resolving to the parsed data file. Static site, no
  // backend - this is a same-origin fetch of a JSON file sitting next to
  // index.html, which works on GitHub Pages exactly as it does locally
  // served (it does NOT work opened as a bare file:// page without a local
  // server, because fetch() of a local file is blocked by the browser for
  // file:// origins - noted in the README as a dev-only caveat).
  function load(url) {
    url = url || stampedUrl() || "data/cv-generator-data.json";
    return fetch(url).then(function (res) {
      if (!res.ok) {
        throw new Error("data.js: failed to load " + url + " (HTTP " + res.status + ")");
      }
      return res.json();
    });
  }

  // The referee name and salary figures are not loaded from here: they live
  // only in the browser, entered under Private settings (js/app.js).
  global.CVData = { load: load };
})(typeof window !== "undefined" ? window : globalThis);
