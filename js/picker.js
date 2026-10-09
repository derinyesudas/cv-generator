// ---------------------------------------------------------------------------
// CVPicker - the per-section dropdown (2 Oct 2026). Derin, verbatim: "make
// them as a drop down list for every section, and whilst I hover over an
// option I should get an overview at the side so that I can see the result
// in real time."
//
// A button that opens a listbox. Hovering an option, or moving to it with
// the arrow keys, calls onPreview(value) - js/app.js re-renders the page
// beside the sidebar with that option in place - and the preview stays up
// while the list is open, even if the mouse drifts off it towards the page.
// Clicking an option (or Enter/Space) calls onCommit(value). Closing any
// other way (Escape, Tab, a click elsewhere) calls onPreview(null): back to
// what was already chosen. A native <select> can't do this - its options
// fire no hover events on Windows - hence the custom control.
//
// Presentation only, like js/ui.js: this file never sees the data file or a
// model. It is handed plain option objects and two callbacks; deciding what
// an option means, building it and checking it all stay in js/app.js.
//
// Accessibility: button[aria-haspopup=listbox][aria-expanded] + a focusable
// role=listbox with aria-activedescendant, options with aria-selected -
// the WAI-ARIA "select-only combobox" pattern, keyboard as a native select
// (arrows, Home/End, Enter/Space, Escape, Tab, type-ahead).
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  var openInstance = null;
  var uid = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg>';
  var CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5"/></svg>';

  // cfg: {
  //   label, hint?,                      - shown above the button
  //   options: [{ value, title?, text?, badge?: {text, tone}, group?, recommended? }],
  //   value,                             - the option currently in effect
  //   disabledNote?,                     - when set, the picker is read-only with this explanation
  //   statuses?: function () -> { value: {text, tone, title} }   (called on open; fit badges)
  //   onPreview(value|null), onCommit(value)
  // }
  function create(cfg) {
    var id = "picker-" + (++uid);
    var root = el("div", "picker");
    var labelEl = el("span", "picker-label", cfg.label);
    labelEl.id = id + "-label";
    root.appendChild(labelEl);

    var current = cfg.options.filter(function (o) { return o.value === cfg.value; })[0] || cfg.options[0];
    var btn = el("button", "picker-button");
    btn.type = "button";
    btn.id = id + "-button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-labelledby", labelEl.id + " " + btn.id);
    var face = el("span", "picker-face");
    var faceTitle = el("span", "picker-face-title", current ? (current.title || current.text || "") : "");
    face.appendChild(faceTitle);
    // Only a section you changed is marked on screen (8 Oct 2026, audit item
    // 9); "Recommended" stays readable to screen readers, and on its option
    // in the open list.
    if (current && current.recommended) face.appendChild(el("span", "sr-only", "Recommended"));
    else if (current) face.appendChild(el("span", "picker-tag picker-tag-mine", "Your pick"));
    btn.appendChild(face);
    var chev = el("span", "picker-chevron");
    chev.innerHTML = CHEVRON;
    btn.appendChild(chev);
    root.appendChild(btn);
    if (cfg.hint) root.appendChild(el("p", "picker-hint", cfg.hint));

    if (cfg.disabledNote || cfg.options.length < 2) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      root.classList.add("picker-fixed");
      var note = el("p", "picker-hint", cfg.disabledNote || "Only one approved version.");
      root.appendChild(note);
      return { el: root, close: function () {} };
    }

    var list = el("div", "picker-list");
    list.id = id + "-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", labelEl.id);
    // 0, not -1: a scrollable listbox has to be reachable by keyboard on its
    // own (it takes focus when it opens; Tab closes it - see keydown below).
    list.tabIndex = 0;
    list.hidden = true;
    btn.setAttribute("aria-controls", list.id);

    var optionEls = [];
    var lastGroup = null;
    cfg.options.forEach(function (o, i) {
      if (o.group && o.group !== lastGroup) {
        var gh = el("div", "picker-group", o.group);
        gh.setAttribute("role", "presentation");
        list.appendChild(gh);
        lastGroup = o.group;
      }
      var opt = el("div", "picker-option");
      opt.id = id + "-opt-" + i;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", o.value === cfg.value ? "true" : "false");
      opt.setAttribute("data-index", String(i));
      var tick = el("span", "picker-tick");
      tick.innerHTML = CHECK;
      opt.appendChild(tick);
      var body = el("span", "picker-option-body");
      var top = el("span", "picker-option-top");
      if (o.title) top.appendChild(el("span", "picker-option-title", o.title));
      var tags = el("span", "picker-option-tags");
      if (o.recommended) tags.appendChild(el("span", "picker-tag picker-tag-rec", "Recommended"));
      if (o.badge) {
        var b = el("span", "picker-tag picker-tag-" + (o.badge.tone || "info"), o.badge.text);
        tags.appendChild(b);
      }
      var status = el("span", "picker-tag picker-status");
      status.hidden = true;
      tags.appendChild(status);
      top.appendChild(tags);
      body.appendChild(top);
      if (o.text) body.appendChild(el("span", "picker-option-text" + (o.title ? "" : " picker-option-text-main"), o.text));
      opt.appendChild(body);
      list.appendChild(opt);
      optionEls.push({ el: opt, opt: o, status: status });
    });
    // Inside the picker (so inside the sidebar's landmark), but fixed-
    // positioned: fixed boxes escape the sidebar's own scroll clipping.
    root.appendChild(list);

    var active = -1;
    var previewed = undefined;
    var previewFrame = null;
    var isOpen = false;
    var typeBuffer = "";
    var typeTimer = null;

    function selectedIndex() {
      for (var i = 0; i < cfg.options.length; i++) if (cfg.options[i].value === cfg.value) return i;
      return 0;
    }

    function preview(value) {
      if (value === previewed) return;
      previewed = value;
      if (previewFrame) global.cancelAnimationFrame(previewFrame);
      previewFrame = global.requestAnimationFrame(function () {
        previewFrame = null;
        try { cfg.onPreview(value); } catch (err) { if (global.console) console.error(err); }
      });
    }

    function setActive(i, fromKeyboard) {
      if (i < 0 || i >= optionEls.length) return;
      if (active >= 0 && optionEls[active]) optionEls[active].el.classList.remove("is-active");
      active = i;
      var o = optionEls[i];
      o.el.classList.add("is-active");
      list.setAttribute("aria-activedescendant", o.el.id);
      if (fromKeyboard) {
        var r = o.el.getBoundingClientRect();
        var lr = list.getBoundingClientRect();
        if (r.top < lr.top) list.scrollTop -= (lr.top - r.top) + 6;
        else if (r.bottom > lr.bottom) list.scrollTop += (r.bottom - lr.bottom) + 6;
      }
      preview(o.opt.value === cfg.value ? null : o.opt.value);
    }

    function position() {
      var r = btn.getBoundingClientRect();
      var vh = global.innerHeight;
      var vw = global.innerWidth;
      var below = vh - r.bottom - 12;
      var above = r.top - 12;
      var width = Math.min(Math.max(r.width, 300), vw - 16);
      var left = Math.min(Math.max(8, r.left), vw - width - 8);
      list.style.width = width + "px";
      list.style.left = left + "px";
      var natural = Math.min(list.scrollHeight, 460);
      if (below >= Math.min(natural, 260) || below >= above) {
        list.style.top = (r.bottom + 4) + "px";
        list.style.bottom = "";
        list.style.maxHeight = Math.max(160, Math.min(460, below)) + "px";
        list.classList.remove("picker-list-up");
      } else {
        list.style.top = "";
        list.style.bottom = (vh - r.top + 4) + "px";
        list.style.maxHeight = Math.max(160, Math.min(460, above)) + "px";
        list.classList.add("picker-list-up");
      }
    }

    function onDocPointer(e) {
      if (!isOpen) return;
      if (list.contains(e.target) || btn.contains(e.target)) return;
      close(false);
    }
    function onReflow() {
      if (!isOpen) return;
      var r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > global.innerHeight) { close(false); return; }
      position();
    }

    function open() {
      if (isOpen) return;
      if (openInstance && openInstance !== api) openInstance.close(false);
      openInstance = api;
      isOpen = true;
      previewed = undefined;
      root.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      list.hidden = false;
      if (cfg.statuses) {
        var st = {};
        try { st = cfg.statuses() || {}; } catch (err) { if (global.console) console.error(err); }
        optionEls.forEach(function (o) {
          var s = st[o.opt.value];
          if (s) {
            o.status.hidden = false;
            o.status.textContent = s.text;
            o.status.className = "picker-tag picker-status picker-tag-" + (s.tone || "info");
            if (s.title) o.status.title = s.title;
          } else {
            o.status.hidden = true;
          }
        });
      }
      position();
      var sel = selectedIndex();
      optionEls.forEach(function (o, i) { o.el.setAttribute("aria-selected", i === sel ? "true" : "false"); });
      active = -1;
      setActive(sel, true);
      list.focus({ preventScroll: true });
      document.addEventListener("pointerdown", onDocPointer, true);
      global.addEventListener("resize", onReflow);
      document.addEventListener("scroll", onReflow, true);
    }

    function close(commit, returnFocus) {
      if (!isOpen) return;
      isOpen = false;
      if (openInstance === api) openInstance = null;
      root.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
      list.hidden = true;
      list.removeAttribute("aria-activedescendant");
      document.removeEventListener("pointerdown", onDocPointer, true);
      global.removeEventListener("resize", onReflow);
      document.removeEventListener("scroll", onReflow, true);
      if (previewFrame) { global.cancelAnimationFrame(previewFrame); previewFrame = null; }
      var chosen = commit && active >= 0 ? optionEls[active].opt.value : undefined;
      if (previewed !== undefined && previewed !== null && chosen === undefined) {
        try { cfg.onPreview(null); } catch (err) { if (global.console) console.error(err); }
      }
      previewed = undefined;
      if (returnFocus !== false) btn.focus({ preventScroll: true });
      if (chosen !== undefined) {
        if (chosen === cfg.value) {
          try { cfg.onPreview(null); } catch (err2) { if (global.console) console.error(err2); }
        } else {
          cfg.onCommit(chosen);
        }
      }
    }

    btn.addEventListener("click", function () {
      if (isOpen) close(false);
      else open();
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    list.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(active + 1, optionEls.length - 1), true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(active - 1, 0), true); }
      else if (e.key === "Home") { e.preventDefault(); setActive(0, true); }
      else if (e.key === "End") { e.preventDefault(); setActive(optionEls.length - 1, true); }
      else if (e.key === "PageDown") { e.preventDefault(); setActive(Math.min(active + 5, optionEls.length - 1), true); }
      else if (e.key === "PageUp") { e.preventDefault(); setActive(Math.max(active - 5, 0), true); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(true); }
      else if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Tab") { close(false, false); }
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        typeBuffer += e.key.toLowerCase();
        if (typeTimer) clearTimeout(typeTimer);
        typeTimer = setTimeout(function () { typeBuffer = ""; }, 600);
        for (var k = 0; k < optionEls.length; k++) {
          var t = (optionEls[k].opt.title || optionEls[k].opt.text || "").toLowerCase();
          if (t.indexOf(typeBuffer) === 0) { setActive(k, true); break; }
        }
      }
    });
    optionEls.forEach(function (o, i) {
      o.el.addEventListener("mouseenter", function () { if (isOpen) setActive(i, false); });
      o.el.addEventListener("click", function () {
        if (!isOpen) return;
        if (active !== i) setActive(i, false);
        close(true);
      });
    });

    var api = {
      el: root,
      close: function (commit) { close(!!commit, false); },
      destroy: function () {
        close(false, false);
        if (list.parentNode) list.parentNode.removeChild(list);
      }
    };
    return api;
  }

  global.CVPicker = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
