// ---------------------------------------------------------------------------
// The PDF and Word libraries (lib/jspdf.umd.min.js, lib/docx.umd.js) are the
// two biggest files the site uses and are only needed when a download button
// is pressed, so they are loaded then - once - rather than with the page.
// saveBlob() hands a finished file to the browser as a download.
//
// If a library fails to load, the download that needed it fails with a
// message saying so; everything else keeps working, and the next click tries
// again.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var LIBS = {
    pdf: {
      src: "lib/jspdf.umd.min.js",
      ready: function () { return !!(global.jspdf && global.jspdf.jsPDF); },
      name: "PDF", other: "Word"
    },
    word: {
      src: "lib/docx.umd.js",
      ready: function () { return !!(global.docx && global.docx.Document && global.docx.Packer); },
      name: "Word", other: "PDF"
    }
  };
  var pending = {};

  function failure(lib) {
    return new Error("The " + lib.name + " library did not load, so " + lib.name +
      " downloads are unavailable. Reload the page to try again; " + lib.other + " downloads still work.");
  }

  // load("pdf" | "word") -> Promise, resolved once the library is ready.
  function load(kind) {
    var lib = LIBS[kind];
    if (!lib) return Promise.reject(new Error("Unknown library: " + kind));
    if (lib.ready()) return Promise.resolve();
    if (pending[kind]) return pending[kind];
    pending[kind] = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = lib.src;
      script.async = true;
      function fail() {
        delete pending[kind];
        script.remove();
        reject(failure(lib));
      }
      script.onload = function () { if (lib.ready()) resolve(); else fail(); };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return pending[kind];
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Long enough for the browser to start the download; then free the memory.
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  global.CVLibs = { load: load, saveBlob: saveBlob };
})(typeof window !== "undefined" ? window : globalThis);
