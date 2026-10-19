// ---------------------------------------------------------------------------
// Hand-edited text (19 Oct 2026). Holds the CV profile and cover-letter body
// Derin typed over the built ones. js/assemble.js and js/letter.js swap them
// in; each block carries _prov {edited: true} and _edited {ground}, which
// js/verify.js checks (every figure and name must already be in the fact bank
// or the ad; never-claim and dash scans still run) and js/pagefit.js measures
// by wrap simulation. No network, no AI.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";
  var draft = null;
  global.CVEdits = {
    current: function () { return draft; },
    set: function (d) { draft = d; },
    clear: function () { draft = null; }
  };
})(typeof window !== "undefined" ? window : globalThis);
