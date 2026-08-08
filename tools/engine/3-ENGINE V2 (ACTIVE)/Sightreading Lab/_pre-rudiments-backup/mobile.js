/* Mobile reflow for Sightreading Lab, extracted from index.html so the React app can run it too.

   WHY THIS IS A FILE: sync-tools strips every inline <script> from a tool's HTML, so while this lived
   inline the app never ran it and the panels kept their DESKTOP markup at phone width. It now takes a
   ROOT (the document on the tool's own page, the shadow root inside the app) and queries through it,
   because inside a shadow root document.getElementById finds nothing.

   Listeners bind to the root too. Pointer events are composed and DO reach the document, but their
   target is retargeted to the shadow host, so a document-level listener could not tell which chip was
   pressed. (Anthony, 2026-07-22)

   ORIGINAL HEADER COMMENT FOLLOWS. */
(function (global) {
  function init(root) {
    if (!root || root.__rdmMobileInit) return;   // one reflow per root
    root.__rdmMobileInit = true;
    var D = root;
    /* Every lookup goes through the root. ShadowRoot implements getElementById (via DocumentFragment),
       so the same helpers serve the page and the shadow root alike. */
    function _byId(id) { return D.getElementById ? D.getElementById(id) : D.querySelector("#" + id); }
    function _qs(sel) { return D.querySelector(sel); }
    function _qsa(sel) { return D.querySelectorAll(sel); }
    function _stageHost() { return D.body || D; }

/* ===== Mobile reflow (Pass 1: Setup) — ported from the Playalongs mobile system. NON-DESTRUCTIVE: on
   phones it relocates the REAL desktop controls into a compact .iconrow + expandable .paneldetail rows
   (remembering each node's original spot) and restores them on desktop, so every app.js handler keeps
   working untouched. A global delegated pointer listener drives the accordion detail rows. ===== */

  var MQ = window.matchMedia("(max-width:760px)");
  var CHEV = '<svg class="ico ico-stroke chevico" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  var LOOP = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';
  var moved = [];
  function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function move(box, el) { if (!el) return; if (!el.__o) el.__o = { p: el.parentNode, n: el.nextSibling }; box.appendChild(el); moved.push(el); }
  function trigBtn(cls, html, key) { var b = mk("button", cls, html); b.type = "button"; b.setAttribute("data-detail", key); return b; }
  function combo(mainEl, key) { var c = mk("div", "combo"); mainEl.classList.add("m-chip", "m-main"); move(c, mainEl); c.appendChild(trigBtn("cta sm chev", CHEV, key)); return c; }
  function detail(key, items) { var d = mk("div", "paneldetail"); d.setAttribute("data-detail", key); items.forEach(function (it) { if (it) move(d, it); }); return d; }

  // Sticking chip icon: the ACTUAL current sticking pattern as 4 letters (not a generic glyph), so it
  // doubles as a live indicator. app.js exposes window.__srSettings (same pattern as window.__player).
  var STICK_LETTERS = { natural: "RLRL", alternate: "RLRL", doubles: "RRLL", paradiddle: "RLRR" };
  function renderStickingIcon(btn) {
    var slbl = btn.querySelector(".lbl"); if (!slbl) return;
    if (slbl.__stick == null) slbl.__stick = slbl.innerHTML;   // capture the desktop text once, for restore()
    var val = (window.__srSettings && window.__srSettings.sticking) || "natural";
    slbl.innerHTML = '<span class="stick-letters">' + (STICK_LETTERS[val] || "RLRL") + "</span>";
  }
  // Time-Sig chip: just the FIRST selected time signature's real staff glyph (not "Mixed (n)" or every
  // selected sig concatenated — the mobile chip is too narrow for that). Own tiny renderer (same
  // RDMRender bare-mode pattern app.js's timeSigGlyph uses) so it works off window.__srSettings alone.
  var _tsMobStage = null, _tsMobCache = {};
  function mobTimeSigGlyph(value) {
    if (!window.RDMRender) return null;
    if (!_tsMobCache[value]) {
      if (!_tsMobStage) { _tsMobStage = mk("div"); _tsMobStage.style.cssText = "position:fixed;left:-10000px;top:0;width:120px;opacity:0;pointer-events:none;"; _stageHost().appendChild(_tsMobStage); }
      var p = String(value || "4/4").split("/");
      var measures = [{ timeSig: [parseInt(p[0], 10) || 4, parseInt(p[1], 10) || 4], events: [], beams: [], tuplets: [] }];
      try { window.RDMRender.render({ measures: measures }, _tsMobStage, { width: 120, zoom: 1, bare: true }); } catch (e) { return null; }
      var svg = _tsMobStage.querySelector("svg"); if (!svg) return null;
      var bb = svg.getBBox();
      if (bb && bb.width > 0) { var pad = 2; svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " + (bb.width + pad * 2) + " " + (bb.height + pad * 2)); svg.removeAttribute("width"); svg.removeAttribute("height"); svg.style.width = ""; svg.style.height = ""; }
      _tsMobCache[value] = svg.outerHTML;
    }
    var t = mk("div"); t.innerHTML = _tsMobCache[value]; return t.querySelector("svg");
  }
  function renderTimeSigIcon(btn) {
    var lbl = btn.querySelector(".lbl"); if (!lbl) return;
    if (lbl.__ts == null) lbl.__ts = lbl.innerHTML;   // capture the desktop content once, for restore()
    var sigs = (window.__srSettings && window.__srSettings.timeSigs) || ["4/4"];
    var v = sigs[0] || "4/4";
    lbl.innerHTML = "";
    var g = mobTimeSigGlyph(v);
    if (g) lbl.appendChild(g); else lbl.appendChild(document.createTextNode(v === "9/8_asym" ? "9/8*" : v));
  }
  // Re-run both after any picker change (app.js's updateSettingLabels() calls this if it exists) so the
  // mobile chips stay live — otherwise updateSettingLabels() would overwrite our icon HTML with its own
  // desktop-oriented text/multi-glyph output on every sticking/time-sig pick.
  window.__srMobileRefresh = function () {
    if (!MQ.matches) return;
    var setupPanel = _qs('.tabpanel[data-panel="setup"]');
    if (!setupPanel || !setupPanel.__mob) return;
    var ts = _byId("timeSigBtn"); if (ts) renderTimeSigIcon(ts);
    var st = _byId("stickingBtn"); if (st) renderStickingIcon(st);
  };

  // Ornament-type icon (Accent/Flam/Diddle/Buzz): a single QUARTER note carrying that ONE articulation,
  // via the same RDMRender bare-mode pattern as the other glyph helpers above.
  var _ornStage = null, _ornCache = {};
  function ornGlyph(type) {
    if (!window.RDMRender) return null;
    if (!_ornCache[type]) {
      if (!_ornStage) { _ornStage = mk("div"); _ornStage.style.cssText = "position:fixed;left:-10000px;top:0;width:100px;opacity:0;pointer-events:none;"; _stageHost().appendChild(_ornStage); }
      var ev = { rest: false, beats: 0, dur: "q", dots: 0, step: "c", oct: 5, head: "normal",
        heads: [{ step: "c", oct: 5, head: "normal" }],
        accent: type === "accent", marcato: false, tenuto: false, staccato: false,
        roll: type === "diddle" ? 1 : 0, buzz: type === "buzz", flam: type === "flam",
        graces: null, stick1: null, stick2: null, dynamic: null };
      var measures = [{ timeSig: null, repeatStart: false, repeatEndTimes: 0, events: [ev], beams: [], tuplets: [], extraVoices: [] }];
      try { window.RDMRender.render({ measures: measures }, _ornStage, { width: 100, zoom: 1, bare: true }); } catch (e) { return null; }
      var svg = _ornStage.querySelector("svg"); if (!svg) return null;
      var bb = svg.getBBox();
      if (bb && bb.width > 0) { var pad = 3; svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " + (bb.width + pad * 2) + " " + (bb.height + pad * 2)); svg.removeAttribute("width"); svg.removeAttribute("height"); svg.style.width = ""; svg.style.height = ""; }
      _ornCache[type] = svg.outerHTML;
    }
    var t = mk("div"); t.innerHTML = _ornCache[type]; return t.querySelector("svg");
  }
  var ORN_TYPES = [
    { id: "accentSlider", key: "accent", label: "Accent" },
    { id: "flamSlider", key: "flam", label: "Flam" },
    { id: "diddleSlider", key: "diddle", label: "Diddle" },
    { id: "buzzSlider", key: "buzz", label: "Buzz" }
  ];

  function build() {
    _qsa(".tabpanel").forEach(function (panel) {
      if (panel.__mob) return;
      var name = panel.getAttribute("data-panel");
      var q = function (id) { return panel.querySelector("#" + id); };
      var row = mk("div", "iconrow"), dets = [], orig;
      if (name === "setup") {
        orig = panel.querySelector(".sr-bar"); if (!orig) return;
        // time-sig + sticking: move the real .control buttons (existing click already opens the modal
        // picker). Both get a mobile-only icon: time-sig shows just its FIRST selected signature, sticking
        // shows the CURRENT pattern's actual letters — both re-rendered live by window.__srMobileRefresh.
        var ts = q("timeSigBtn"); if (ts) { ts.classList.add("m-chip"); renderTimeSigIcon(ts); move(row, ts); }
        var st = q("stickingBtn"); if (st) { st.classList.add("m-chip"); renderStickingIcon(st); move(row, st); }
        // 3 on/off toggle chips + the lead-hand letter chip (move the whole .field; caption hidden by CSS)
        ["countsToggle", "stickingToggle", "leadHandToggle", "syncToggle"].forEach(function (id) {
          var el = q(id), f = el && el.closest ? el.closest(".field") : null; if (f) move(row, f);
        });
        // row 1 = Time-Sig + Sticking + the 4 toggles; break forces Measures/Rests/Variety onto row 2.
        row.appendChild(mk("div", "iconrow-break"));
        // measures: editable input (left) + chevron box (right) → +/- drop into the detail row
        var mi = q("measInput");
        if (mi) { row.appendChild(combo(mi, "measset")); dets.push(detail("measset", [q("measDown"), q("measUp")])); }
        /* ONE chip for all four sliders. It used to be two chips picking `.sr-rests:not(.sr-variety)`
           and `.sr-variety`, which caught Rests and Variety only — Sparsity and Subdivision were added
           later and were left behind in the hidden desktop bar, so a phone could not reach them at all.
           Selecting by the field class (all four carry .sr-rests) keeps any future slider working, and
           one chip costs less width than four. (Anthony, 2026-07-22) */
        var sliderFields = [].slice.call(panel.querySelectorAll(".field.sr-rests"));
        if (sliderFields.length) {
          row.appendChild(trigBtn("cta sm m-chip m-grow", "Sliders " + CHEV, "sliderset"));
          dets.push(detail("sliderset", sliderFields));
        }
      } else if (name === "loop") {
        orig = panel.querySelector(".sr-bar"); if (!orig) return;
        // mirrors Playalongs: a grow "Loop" trigger chip (opens the From/To steppers below) + a
        // separate "Clear loop" chip. Both are plain .cta on this purple panel, so they already pick up
        // the local .tabpanel.panel.purple .cta{background:var(--purple)} override (line ~72) — the
        // SAME rule Playalongs uses, so the colors match without any extra CSS here.
        row.appendChild(trigBtn("cta sm m-chip m-grow", LOOP + " Loop " + CHEV, "loopset"));
        var clearBtn = q("loopClearBtn"); if (clearBtn) { clearBtn.classList.add("m-chip"); move(row, clearBtn); }
        var fromField = q("loopFrom") && q("loopFrom").closest(".field");
        var toField = q("loopTo") && q("loopTo").closest(".field");
        dets.push(detail("loopset", [fromField, toField]));
      } else if (name === "rhythms") {
        // The presets row (rhQuickRow = All / Full / <cycle>) IS the mobile row now — keep it VISIBLE
        // instead of hiding it behind a "Presets" chip. The notation tile grid always shows below it
        // (no toggle button, no accordion detail — Anthony, 2026-07-16).
        var qrow = q("rhQuickRow"); if (qrow) move(row, qrow);
        // rhQuickRow just moved OUT of .rh-toprow, leaving it an empty husk still carrying its desktop
        // margin-bottom:10px — hide it (same orig hide/restore mechanism as Setup/Loop).
        orig = panel.querySelector(".rh-toprow");
      } else if (name === "ornaments") {
        // No "Presets" chip, no outer "Ornaments" wrapper chip (Anthony, 2026-07-16 — both removed): the
        // 4 symbol buttons (Accent/Flam/Diddle/Buzz) sit directly in the row as ordinary top-level
        // data-detail triggers, so the SHARED accordion (see toggle() below) already gives the "only one
        // slider open at a time" behavior for free — no bespoke local click-handling needed anymore.
        row.classList.add("orn-subrow");
        var oGrid = panel.querySelector(".orn-grid");
        ORN_TYPES.forEach(function (o) {
          var slider = q(o.id), field = slider && slider.closest(".orn-field");
          var key = "orn-" + o.key;
          var b = mk("button", "cta sm m-chip");
          b.type = "button"; b.title = o.label; b.setAttribute("data-detail", key);
          var g = ornGlyph(o.key);
          if (g) { g.classList.add("orn-ico"); b.appendChild(g); } else { b.appendChild(mk("span", null, o.label)); }
          b.insertAdjacentHTML("beforeend", CHEV);   // chevron next to the icon; rotates via the existing .m-chip.open .chevico rule
          row.appendChild(b);
          dets.push(detail(key, [field]));
        });
        // .orn-grid's 4 fields just moved out, leaving an empty grid — hide it so it stops taking space.
        orig = oGrid;
      } else { return; }
      if (orig) {
        orig.style.display = "none";
        panel.insertBefore(row, orig);
        dets.forEach(function (d) { panel.insertBefore(d, orig); });
      } else {
        panel.appendChild(row);
        dets.forEach(function (d) { panel.appendChild(d); });
      }
      panel.__mob = { row: row, dets: dets, orig: orig };
    });
  }
  function restore() {
    moved.forEach(function (el) { if (el.__o) { try { el.__o.p.insertBefore(el, el.__o.n); } catch (e) {} } });
    moved = [];
    _qsa(".m-chip,.m-main").forEach(function (el) { el.classList.remove("m-chip", "m-main", "open"); });
    var slbl = _qs("#stickingBtn .lbl"); if (slbl && slbl.__stick != null) { slbl.innerHTML = slbl.__stick; slbl.__stick = null; }
    var tlbl = _qs("#timeSigBtn .lbl"); if (tlbl && tlbl.__ts != null) { tlbl.innerHTML = tlbl.__ts; tlbl.__ts = null; }
    _qsa(".iconrow, .paneldetail").forEach(function (x) { if (x.parentNode) x.parentNode.removeChild(x); });
    _qsa(".tabpanel").forEach(function (panel) { if (panel.__mob) { if (panel.__mob.orig) panel.__mob.orig.style.display = ""; panel.__mob = null; } });
  }

  // accordion: tap or long-press a [data-detail] trigger to open its matching .paneldetail; only one open
  // per panel; tap outside closes; the chevron rotates via .open.
  var timer = null, pressed = null, held = false;
  function trig(t) { if (!t || !t.closest) return null; var el = t.closest("[data-detail]"); return (el && el.tagName === "BUTTON" && !el.classList.contains("paneldetail")) ? el : null; }
  function closeDetails() { _qsa(".paneldetail.open,[data-detail].open").forEach(function (x) { x.classList.remove("open"); }); }
  function toggle(b) {
    var key = b.getAttribute("data-detail"), panel = b.closest(".tabpanel"); if (!panel) return;
    var d = panel.querySelector('.paneldetail[data-detail="' + key + '"]'); if (!d) return;
    var open = !d.classList.contains("open");
    panel.querySelectorAll(".paneldetail.open,[data-detail].open").forEach(function (x) { x.classList.remove("open"); });
    if (open) { d.classList.add("open"); b.classList.add("open"); }
  }
  D.addEventListener("pointerdown", function (e) {
    var b = trig(e.target);
    if (b) { pressed = b; held = false; timer = setTimeout(function () { held = true; toggle(b); }, 420); return; }
    // don't collapse an open settings menu when the tap lands on the sheet-music card — its buttons act on
    // playback / the score, not on the menu (Anthony, 2026-07-16). Only genuine off-taps close it.
    if (!(e.target.closest && (e.target.closest(".paneldetail") || e.target.closest(".sheet")))) closeDetails();
  }, true);
  D.addEventListener("pointerup", function (e) { clearTimeout(timer); var b = trig(e.target); if (b && b === pressed && !held) toggle(b); pressed = null; }, true);

  function apply() { if (MQ.matches) build(); else restore(); }   // both idempotent: build guards on __mob, restore no-ops when nothing is built
  if (MQ.addEventListener) MQ.addEventListener("change", apply); else if (MQ.addListener) MQ.addListener(apply);
  window.addEventListener("resize", apply);   // backup: some embedded viewports don't fire matchMedia 'change'
  apply();

  }
  global.RDM_MOBILE = global.RDM_MOBILE || {};
  global.RDM_MOBILE["sight-reading"] = init;
  /* The tool's own page has no embedder, so run against the document immediately. Inside the app,
     ToolMount calls this with the shadow root once the tool is mounted. */
  if (!global.__RDM_EMBED) init(document);
})(window);
