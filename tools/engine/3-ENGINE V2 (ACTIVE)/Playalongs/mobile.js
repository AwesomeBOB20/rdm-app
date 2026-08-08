/* Mobile reflow for Playalongs, extracted from index.html so the React app can run it too.

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

/* ===== Mobile-only control redesign =====
   On phones (<=760px) each tab's flat panel becomes the compact icon-row + detail-row layout
   (the approved mockup). We do it by MOVING the real controls into new containers, so every
   existing handler keeps working; on desktop we move them back and the original layout is
   byte-for-byte unchanged. Runs after app.js so all handlers are already bound. */

  var MQ = window.matchMedia("(max-width:760px)");
  var CHEV = '<svg class="ico ico-stroke chevico" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  var GEAR = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  var LOOP = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';
  var NOTE = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
  var LIST = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
  // queue = a "play-list": lines + a filled play triangle, distinct from the plain LIST (playlist selector)
  var QUEUE = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="6" x2="16" y2="6"></line><line x1="3" y1="12" x2="16" y2="12"></line><line x1="3" y1="18" x2="11" y2="18"></line><polygon points="16 14 16 22 22 18" fill="currentColor" stroke="none"></polygon></svg>';
  // categories = a 2x2 grid of tiles (reads as "browse / all categories")
  var GRID = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>';
  var moved = [];
  function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function move(box, el) { if (!el) return; if (!el.__o) el.__o = { p: el.parentNode, n: el.nextSibling }; box.appendChild(el); moved.push(el); }
  function trigBtn(cls, html, key) { var b = mk("button", cls, html); b.type = "button"; b.setAttribute("data-detail", key); return b; }
  function combo(mainEl, key, grow) { var c = mk("div", "combo" + (grow ? " m-grow" : "")); mainEl.classList.add("m-chip", "m-main"); move(c, mainEl); c.appendChild(trigBtn("cta sm chev", CHEV, key)); return c; }
  function detail(key, items) { var d = mk("div", "paneldetail"); d.setAttribute("data-detail", key); items.forEach(function (it) { if (it) move(d, it); }); return d; }
  // Picker chip: icon-only main button (name lives on the sheet now) + a chevron box; BOTH open the
  // main's picker. No detail row. The injected .m-ico is guarded so repeated builds don't duplicate it.
  function pickerCombo(mainEl, iconHtml, grow) {
    var c = mk("div", "combo" + (grow ? " m-grow" : ""));
    mainEl.classList.add("m-chip", "m-main", "m-iconbtn");
    if (!mainEl.querySelector(".m-ico")) mainEl.insertBefore(mk("span", "m-ico", iconHtml), mainEl.firstChild);
    move(c, mainEl);
    var chev = mk("button", "cta sm chev", CHEV); chev.type = "button";
    chev.addEventListener("click", function () { mainEl.click(); });
    c.appendChild(chev);
    return c;
  }
  // Like pickerCombo but keeps the button's TEXT label (no icon) — a wide text chip + a chevron box,
  // both opening the main's picker. Used for the exercise button on phones (shows the exercise title).
  function textPickerCombo(mainEl, grow) {
    var c = mk("div", "combo" + (grow ? " m-grow" : ""));
    mainEl.classList.add("m-chip", "m-main");
    move(c, mainEl);
    var chev = mk("button", "cta sm chev", CHEV); chev.type = "button";
    chev.addEventListener("click", function () { mainEl.click(); });
    c.appendChild(chev);
    return c;
  }
  // Single-button dropdown: the button's own content (icon or text) with a paired chevron INSIDE the SAME
  // button — exactly like the settings gear (no separate chevron box). Tapping anywhere runs the button's
  // own click handler (open the picker / randomize). opts.grow = fill the row; opts.icon = centre it.
  function dropBtn(mainEl, opts) {
    opts = opts || {};
    mainEl.classList.add("m-chip", "m-drop");
    if (opts.grow) mainEl.classList.add("m-grow");
    if (opts.icon) mainEl.classList.add("m-drop-icon");
    if (!mainEl.querySelector(".m-chev")) mainEl.appendChild(mk("span", "m-chev", CHEV));
    return mainEl;
  }

  function build() {
    _qsa(".tabpanel").forEach(function (panel) {
      if (panel.__mob) return;
      var name = panel.getAttribute("data-panel");
      var orig = panel.querySelector(".bar, .tool-row"); if (!orig) return;
      var q = function (id) { return panel.querySelector("#" + id); };
      var row = mk("div", "iconrow"), dets = [];
      if (name === "exercise") {
        // category = ONE button: a grid icon + a paired chevron (gear-style); tap opens the category picker
        var catBtn = q("categoryBtn");
        if (!catBtn.querySelector(".m-ico")) catBtn.insertBefore(mk("span", "m-ico", GRID), catBtn.firstChild);
        move(row, dropBtn(catBtn, { icon: true }));
        // exercise = ONE button: the exercise title + a paired chevron inside it (opens the picker)
        move(row, dropBtn(q("exerciseBtn"), { grow: true }));
        // + upload button (only present with an account) rides along as a small icon chip
        var addEx = q("addExerciseBtn");
        if (addEx && !addEx.hidden) { addEx.classList.add("m-chip", "m-icon"); move(row, addEx); }
        // randomize button removed from this panel entirely (Anthony, 2026-07-16) — the sheet-card dice
        // (randNowBtn) is the only trigger now, so there's nothing left here to move.
      } else if (name === "randomize" || name === "bump") {
        var act = q(name === "randomize" ? "randomizeBtn" : "bumpBtn");
        act.classList.add("m-chip", "m-grow"); move(row, act);
        // settings = ONE button holding the gear icon + a chevron (paired inside a single box)
        var setKey = name + "set";
        row.appendChild(trigBtn("cta sm m-chip m-gear", GEAR + CHEV, setKey));
        move(row, panel.querySelector(".field--auto"));
        var ids = name === "randomize" ? ["randReps", "randMin", "randMax"] : ["bumpReps", "bumpStep"];
        dets.push(detail(setKey, ids.map(function (id) { return q(id).closest(".field"); })));
      } else if (name === "loop") {
        // IDENTICAL to the Sight-Reading Lab's loop branch: a grow "Loop" trigger chip (opens the
        // From/To steppers below) + a separate "Clear loop" chip. The From/To fields are located by
        // their INPUT ids (not a layout class) so the two tools stay in step.
        row.appendChild(trigBtn("cta sm m-chip m-grow", LOOP + " Loop " + CHEV, "loopset"));
        var clearBtn = q("loopClearBtn"); if (clearBtn) { clearBtn.classList.add("m-chip"); move(row, clearBtn); }
        var fromField = q("loopFrom") && q("loopFrom").closest(".field");
        var toField = q("loopTo") && q("loopTo").closest(".field");
        dets.push(detail("loopset", [fromField, toField]));
      } else if (name === "playlist") {
        // playlist selector = ONE button: a list icon + a paired chevron (gear-style); tap opens the picker
        var plBtn = q("playlistBtn");
        if (!plBtn.querySelector(".m-ico")) plBtn.insertBefore(mk("span", "m-ico", LIST), plBtn.firstChild);
        move(row, dropBtn(plBtn, { icon: true }));
        // queue = ONE button: the current queue entry text + a paired chevron inside it (opens the queue)
        move(row, dropBtn(q("queueBtn"), { grow: true }));
        q("stopPlaylistBtn").classList.add("m-chip", "m-icon"); move(row, q("stopPlaylistBtn"));
        // + new-playlist button (only present with an account) rides along as a small icon chip
        var addPl = q("addPlaylistBtn");
        if (addPl && !addPl.hidden) { addPl.classList.add("m-chip", "m-icon"); move(row, addPl); }
      } else return;
      orig.style.display = "none";
      panel.insertBefore(row, orig);
      dets.forEach(function (d) { panel.insertBefore(d, orig); });
      panel.__mob = { row: row, dets: dets, orig: orig };
    });
  }
  function restore() {
    moved.forEach(function (el) {
      if (el.__o) { el.__o.p.insertBefore(el, el.__o.n); el.__o = null; }
      // Undo the mobile-only chrome the builder injected onto these PERSISTENT buttons (they survive the
      // row teardown below). Without this, the leftover .m-chev/.m-ico spans keep rendering on desktop —
      // and the .m-chev chevron doubles up with the desktop button.control::after dropdown chevron.
      el.classList.remove("m-chip", "m-main", "m-grow", "m-drop", "m-drop-icon", "m-iconbtn", "m-icon", "m-gear");
      var extra = el.querySelectorAll(":scope > .m-chev, :scope > .m-ico");
      for (var i = 0; i < extra.length; i++) extra[i].remove();
    });
    moved = [];
    _qsa(".tabpanel").forEach(function (panel) {
      if (!panel.__mob) return;
      panel.__mob.row.remove();
      panel.__mob.dets.forEach(function (d) { d.remove(); });
      panel.__mob.orig.style.display = "";
      panel.__mob = null;
    });
  }

  // detail row opens on TAP or LONG-PRESS of a [data-detail] TRIGGER, and stays open until you tap
  // OUTSIDE it (tapping the buttons/fields inside keeps it open). A trigger is a <button> carrying
  // data-detail; the .paneldetail container also carries data-detail, so we must exclude it here —
  // otherwise a tap on a button inside the menu bubbles up to the container and closes the menu.
  var timer = null, pressed = null, held = false;
  function trig(t) {
    if (!t || !t.closest) return null;
    var el = t.closest("[data-detail]");
    return (el && el.tagName === "BUTTON" && !el.classList.contains("paneldetail")) ? el : null;
  }
  function closeDetails() { _qsa(".paneldetail.open,[data-detail].open").forEach(function (x) { x.classList.remove("open"); }); }
  D.addEventListener("pointerdown", function (e) {
    var b = trig(e.target);
    if (b) { pressed = b; held = false; timer = setTimeout(function () { held = true; toggle(b); }, 420); return; }
    // tapped off a trigger: close any open menu UNLESS the tap landed inside the open menu itself, OR on
    // the sheet-music card. Sheet-card buttons (zoom / loop / favorite / dice / lock / nav) act on
    // playback, not on the open settings menu, so they must not collapse it (Anthony, 2026-07-16).
    if (!(e.target.closest && (e.target.closest(".paneldetail") || e.target.closest(".sheet")))) closeDetails();
  }, true);
  D.addEventListener("pointerup", function (e) { clearTimeout(timer); var b = trig(e.target); if (b && b === pressed && !held) toggle(b); pressed = null; }, true);
  function toggle(b) {
    var key = b.getAttribute("data-detail"), panel = b.closest(".tabpanel"); if (!panel) return;
    var d = panel.querySelector('.paneldetail[data-detail="' + key + '"]'); if (!d) return;
    var open = !d.classList.contains("open");
    panel.querySelectorAll(".paneldetail.open,[data-detail].open").forEach(function (x) { x.classList.remove("open"); });
    if (open) { d.classList.add("open"); b.classList.add("open"); }
  }

  function apply() { if (MQ.matches) build(); else restore(); }   // both idempotent
  if (MQ.addEventListener) MQ.addEventListener("change", apply); else if (MQ.addListener) MQ.addListener(apply);
  window.addEventListener("resize", apply);   // backup: some embedded viewports don't fire matchMedia 'change' (the Lab already does this)
  apply();

  }
  global.RDM_MOBILE = global.RDM_MOBILE || {};
  global.RDM_MOBILE["playalongs"] = init;
  /* The tool's own page has no embedder, so run against the document immediately. Inside the app,
     ToolMount calls this with the shadow root once the tool is mounted. */
  if (!global.__RDM_EMBED) init(document);
})(window);
