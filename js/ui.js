// ---------------------------------------------------------------------------
// Presentation-only behaviour for the app chrome (1 Oct 2026 redesign).
//
// Deliberately separate from js/app.js and everything it loads: nothing in
// here reads data.json, builds or changes a model, touches a gate, or
// decides anything about a document. It only watches the DOM that js/app.js
// already renders and adjusts how it is shown:
//
//   1. Paper scaling - fits each A4 preview sheet to the width available
//      (transform, never zoom, so line-wrapping inside the preview stays
//      exactly the unscaled layout js/preview.js produced).
//   2. Load status - mirrors #load-status's text into data-state so the
//      status dot can change colour (app.js only ever writes the text).
//   3. Download-button reasons - js/app.js explains a disabled download in
//      the button's title; this copies that reason on screen beside the
//      button, so it is visible without hovering.
//   4. Keyword-coverage summary - "12 terms, 9 on the CV" on the collapsed
//      keyword table, counted from the rows app.js rendered.
//   5. Jump-nav highlighting - marks which document is in view.
//   6. Theme switch - light/dark. index.html's inline <head> script sets
//      the starting theme before first paint; this keeps the switch, the
//      browser-chrome colour and the saved choice in step afterwards.
//   7. "Change sections and settings" - remembers in this browser whether
//      the panel was left open.
//
// Every block is independent and wrapped so a failure in one can never stop
// another, or reach js/app.js - this file must be impossible to break the
// generator with. If it fails to load at all, the page still works: the
// paper just isn't scaled and the extras don't appear.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  function safely(label, fn) {
    try {
      fn();
    } catch (err) {
      if (window.console) console.warn("ui.js: " + label + " disabled - " + err.message);
    }
  }

  // --- 1. Paper scaling --------------------------------------------------
  safely("paper scaling", function () {
    if (!("ResizeObserver" in window)) return;
    var sizers = Array.prototype.slice.call(document.querySelectorAll("[data-paper]"));
    if (!sizers.length) return;

    function fit(sizer) {
      var outer = sizer.querySelector(".preview-outer");
      var frame = sizer.parentElement;
      if (!outer || !frame) return;
      // offsetWidth/offsetHeight are layout sizes - unaffected by the
      // transform applied below, so this never feeds back on itself.
      var naturalW = outer.offsetWidth;
      var naturalH = outer.offsetHeight;
      if (!naturalW || !naturalH) return;
      var cs = window.getComputedStyle(frame);
      var avail = frame.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
      var scale = Math.min(1, avail / naturalW);
      scale = Math.max(0.2, Math.floor(scale * 1000) / 1000);
      outer.style.transform = scale < 1 ? "scale(" + scale + ")" : "";
      sizer.style.width = Math.round(naturalW * scale) + "px";
      sizer.style.height = Math.round(naturalH * scale) + "px";
      sizer.setAttribute("data-scale", String(scale));
    }

    var pending = false;
    function fitAll() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        sizers.forEach(fit);
      });
    }

    var ro = new ResizeObserver(fitAll);
    sizers.forEach(function (sizer) {
      ro.observe(sizer.parentElement);
      var outer = sizer.querySelector(".preview-outer");
      if (outer) ro.observe(outer);
    });
    window.addEventListener("load", fitAll);
    fitAll();
  });

  // --- 2. Load status ------------------------------------------------------
  safely("load status", function () {
    var el = document.getElementById("load-status");
    if (!el || !("MutationObserver" in window)) return;
    function sync() {
      var t = (el.textContent || "").toLowerCase();
      var state = /fail|error/.test(t) ? "error" : /loaded/.test(t) ? "ok" : "loading";
      if (el.getAttribute("data-state") !== state) el.setAttribute("data-state", state);
    }
    new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
    sync();
  });

  // --- 3. Why is this download disabled? -------------------------------------
  safely("download hints", function () {
    if (!("MutationObserver" in window)) return;
    var buttons = Array.prototype.slice.call(document.querySelectorAll("button[data-hint]"));
    buttons.forEach(function (btn) {
      var hint = document.getElementById(btn.getAttribute("data-hint"));
      if (!hint) return;
      function sync() {
        var text = btn.disabled ? (btn.getAttribute("title") || "") : "";
        if (hint.textContent !== text) hint.textContent = text;
      }
      new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ["disabled", "title"] });
      sync();
    });
  });

  // --- 4. Keyword-coverage summary ---------------------------------------------
  safely("keyword summary", function () {
    var body = document.getElementById("fitcheck-keywords-body");
    var out = document.getElementById("keywords-count");
    if (!body || !out || !("MutationObserver" in window)) return;
    function sync() {
      var rows = body.querySelectorAll("tr");
      if (!rows.length) {
        out.textContent = "";
        return;
      }
      var onCv = 0;
      Array.prototype.forEach.call(rows, function (tr) {
        var cells = tr.querySelectorAll("td");
        var last = cells[cells.length - 1];
        if (last && /^\s*yes\s*$/i.test(last.textContent)) onCv++;
      });
      out.textContent = rows.length + " terms · " + onCv + " on the CV";
    }
    new MutationObserver(sync).observe(body, { childList: true });
    sync();
  });

  // --- 5. Jump-nav highlighting -----------------------------------------------
  safely("jump nav", function () {
    var links = Array.prototype.slice.call(document.querySelectorAll(".appbar-nav a[data-nav]"));
    var targets = links
      .map(function (a) { return document.getElementById(a.getAttribute("data-nav")); })
      .filter(Boolean);
    if (!links.length || !targets.length) return;

    var ticking = false;
    function sync() {
      ticking = false;
      var bar = document.querySelector(".appbar");
      var line = (bar ? bar.offsetHeight : 56) + 120;
      var current = targets[0];
      var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        current = targets[targets.length - 1];
      } else {
        targets.forEach(function (t) {
          if (t.getBoundingClientRect().top <= line) current = t;
        });
      }
      links.forEach(function (a) {
        var on = a.getAttribute("data-nav") === current.id;
        a.classList.toggle("is-active", on);
        if (on) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(sync);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    sync();
  });

  // --- 6. Theme switch ---------------------------------------------------------
  // Two states, light and dark. Until the switch is used the page follows
  // the system setting (and keeps following it if that changes while the
  // page is open); once it is used, that choice is saved in this browser
  // and wins from then on, including in other open tabs of the app.
  // Storage can be unavailable (private windows, blocked site data): the
  // switch still works for the page that is open, it just isn't remembered.
  safely("theme switch", function () {
    var KEY = "cvGenerator.theme";
    var root = document.documentElement;
    var btn = document.getElementById("theme-switch");
    if (!btn) return;
    var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    var BAR_COLOUR = { light: "#ffffff", dark: "#151a22" };

    function saved() {
      try {
        var v = window.localStorage.getItem(KEY);
        return v === "light" || v === "dark" ? v : null;
      } catch (e) {
        return null;
      }
    }
    function save(theme) {
      try {
        window.localStorage.setItem(KEY, theme);
      } catch (e) {
        /* not remembered - see block comment */
      }
    }
    function system() {
      return media && media.matches ? "dark" : "light";
    }
    function current() {
      return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    }

    var holdTimer = null;
    function apply(theme) {
      var changing = theme !== current();
      if (changing) {
        // Hold every other colour transition off while the theme flips
        // (css/app.css, .theme-switching), so the page changes in one go.
        root.classList.add("theme-switching");
        if (holdTimer) window.clearTimeout(holdTimer);
        holdTimer = window.setTimeout(function () {
          root.classList.remove("theme-switching");
          holdTimer = null;
        }, 60);
      }
      root.setAttribute("data-theme", theme);
      var dark = theme === "dark";
      btn.setAttribute("aria-checked", dark ? "true" : "false");
      btn.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
      var scheme = document.querySelector('meta[name="color-scheme"]');
      if (scheme) scheme.setAttribute("content", theme);
      Array.prototype.forEach.call(document.querySelectorAll('meta[name="theme-color"]'), function (m) {
        m.setAttribute("content", BAR_COLOUR[theme]);
      });
    }

    // The head script normally chose the theme already; this syncs the
    // switch to it (and covers the head script not having run).
    apply(saved() || (root.hasAttribute("data-theme") ? current() : system()));

    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      save(next);
      apply(next);
    });

    if (media) {
      var onSystemChange = function () {
        if (!saved()) apply(system());
      };
      if (media.addEventListener) media.addEventListener("change", onSystemChange);
      else if (media.addListener) media.addListener(onSystemChange);
    }

    window.addEventListener("storage", function (e) {
      if (e.key === KEY) apply(saved() || system());
    });
  });

  // --- 7. The adjust panel remembers being open ---------------------------
  // A convenience only: if storage is unavailable it simply starts closed.
  safely("adjust panel", function () {
    var KEY = "cvGenerator.adjustOpen";
    var panel = document.getElementById("panel-adjust");
    if (!panel) return;
    try {
      if (window.localStorage.getItem(KEY) === "1") panel.open = true;
    } catch (e) { /* starts closed */ }
    panel.addEventListener("toggle", function () {
      try {
        window.localStorage.setItem(KEY, panel.open ? "1" : "0");
      } catch (e) { /* not remembered */ }
    });
  });
})();
