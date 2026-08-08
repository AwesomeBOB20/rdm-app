/* ============================================================
   RDM Sight-Reading Lab — app.js (Engine V2)

   The tool shell around generator.js: settings ribbon → generate an
   RDM score → hand it to the SHARED playback engine (shared/engine.js,
   the exact stack Playalongs uses), so the sheet look, sounds, cursor,
   metronome, tempo/tap/seek/zoom all match the rest of the suite.

   Generation history: every generated sheet is kept (capped) and the
   title chevrons walk back/forward through it — back = "undo", forward
   at the newest sheet = generate a fresh one.
   ============================================================ */
function mountSightreading(root, ctx) {
  "use strict";
  ctx = ctx || {}; root = root || document;
  var $ = function (id) { return root.getElementById(id); };

  var els = {
    tabbar: null, tabpanels: $("tabpanels"),
    rhQuickRow: $("rhQuickRow"), rhythmGrid: $("rhythmGrid"),
    timeSigBtn: $("timeSigBtn"), stickingBtn: $("stickingBtn"),
    measDown: $("measDown"), measUp: $("measUp"), measInput: $("measInput"),
    restsSlider: $("restsSlider"), restsFill: $("restsFill"), restsVal: $("restsVal"),
    varietySlider: $("varietySlider"), varietyFill: $("varietyFill"), varietyVal: $("varietyVal"),
    subdivSlider: $("subdivSlider"), subdivFill: $("subdivFill"), subdivVal: $("subdivVal"),
    sparsitySlider: $("sparsitySlider"), sparsityFill: $("sparsityFill"), sparsityVal: $("sparsityVal"),
    countsToggle: $("countsToggle"), syncToggle: $("syncToggle"), leadHandToggle: $("leadHandToggle"),
    stickingToggle: $("stickingToggle"),
    accentSlider: $("accentSlider"), accentFill: $("accentFill"), accentVal: $("accentVal"),
    flamSlider: $("flamSlider"), flamFill: $("flamFill"), flamVal: $("flamVal"),
    diddleSlider: $("diddleSlider"), diddleFill: $("diddleFill"), diddleVal: $("diddleVal"),
    buzzSlider: $("buzzSlider"), buzzFill: $("buzzFill"), buzzVal: $("buzzVal"),
    generateBtn: $("generateBtn"), followBtn: $("followBtn"), sheetFootActions: $("sheetFootActions"),
    sheetWrap: $("sheetWrap"), sheetPlaceholder: $("sheetPlaceholder"),
    sheetTitleText: $("sheetTitleText"), histBack: $("histBack"), histFwd: $("histFwd"),
    score: $("score"),
    sizeDown: $("sizeDown"), sizeUp: $("sizeUp"), sizeVal: $("sizeVal"),
    playBtn: $("playBtn"), rewindBtn: $("rewindBtn"), metroBtn: $("metroBtn"),
    tempoSlider: $("tempoSlider"), tempoFill: $("tempoFill"),
    tempoNote: $("tempoNote"), tempoInput: $("tempoInput"), tapTempoBtn: $("tapTempoBtn"),
    progressBar: $("progressBar"), progressFill: $("progressFill"),
    progressLabelOver: $("progressLabelOver"), mainTimeLabel: $("mainTimeLabel"),
    pickerEl: $("picker"), pickerTitle: $("pickerTitle"), pickerSearch: $("pickerSearch"),
    pickerClose: $("pickerClose"), pickerList: $("pickerList"),
    pickerFoot: $("pickerFoot"), pickerQuick: $("pickerQuick"),
    kbdBtn: $("kbdBtn"), kbdHelp: $("kbdHelp"), kbdHelpClose: $("kbdHelpClose"),
    loopFrom: $("loopFrom"), loopTo: $("loopTo"),
    loopFromDown: $("loopFromDown"), loopFromUp: $("loopFromUp"),
    loopToDown: $("loopToDown"), loopToUp: $("loopToUp"),
    loopClearBtn: $("loopClearBtn"), loopPanel: $("loopPanel"), loopCountOff: $("loopCountOff"),
    loopCountOffBeats: $("loopCountOffBeats")
  };

  var G = window.RDMSightGen;

  var ICON_PLAY  = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>';
  var TRASH_SVG_SR = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M3 6h18'></path><path d='M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2'></path><path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'></path></svg>";
  var ICON_PAUSE = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"></path></svg>';

  /* ---------- settings state ---------- */
  var settings = {
    timeSigs: ["4/4"],
    cats: {},                        // key -> bool (all true by default)
    sticking: "natural",     // the chosen PATTERN (kept even while the toggle is off)
    stickingOn: true,        // the Sticking ON/OFF toggle
    leadHand: "R",
    measures: 4,
    restPct: 0,            // whole beats of silence; 0 = none, the clean starting state
    subdiv: 50,            // 50 = neutral; low favours slower rhythms, high favours faster
    sparsity: 50,          // how holey each rhythm figure is (0 = only complete figures)
    variety: 100,            // rhythm-change frequency %: 100 = every beat changes, low = repeats
    syncopation: false,
    showCounts: true,
    tempo: 100,
    ornaments: { accent: 0, flam: 0, diddle: 0, buzz: 0 }   // densities 0..100 (% of notes)
  };
  // default ON: 8th notes, triplets, 16th notes, quarter triplets, quarters (Anthony, 2026-07-16)
  var DEFAULT_CATS = { "8s": 1, "8t": 1, "16s": 1, qt: 1, q: 1 };
  G.CATEGORIES.forEach(function (c) { settings.cats[c.key] = !!DEFAULT_CATS[c.key]; });

  /* FREEMIUM (Anthony, 2026-07-31). The free tier keeps the six plainest note values — everything a
     drummer needs to actually sight-read — and locks the rest (5-lets, 7-lets, 9-lets, sextuplets,
     32nds, dotted 8ths and every ratio rhythm). VARIATIONS within an unlocked category stay fully
     available: the lock is on the note value, not on what you can do with it.
     Note "8t" (Triplets) and "qt" (Quarter Triplets) are genuinely separate categories in the generator,
     so both are listed rather than assuming one covers the other. */
  var PAID = ctx.paid !== false;
  var FREE_CATS = { q: 1, dottedQ: 1, "8s": 1, "16s": 1, "8t": 1, qt: 1 };
  function catLocked(key) { return !PAID && !FREE_CATS[key]; }
  // Meters: free gets the Simple group only. Compound and asymmetric change what the whole rhythm bank
  // means (the variant picker switches to compound-pulse figures), so they belong with the paid rhythms.
  function sigLocked(value) {
    if (PAID) return false;
    var t = (G.TIME_SIGS || []).filter(function (x) { return x.value === value; })[0];
    return !!t && t.group !== "Simple";
  }
  // Drop any locked meter, never leaving the list empty (generation needs at least one).
  function clampSigs() {
    if (PAID) return;
    settings.timeSigs = settings.timeSigs.filter(function (v) { return !sigLocked(v); });
    if (!settings.timeSigs.length) settings.timeSigs = ["4/4"];
  }
  // A locked category or meter must never be left switched on by a default or a restored preset.
  if (!PAID) { G.CATEGORIES.forEach(function (c) { if (catLocked(c.key)) settings.cats[c.key] = false; }); clampSigs(); }

  // The value stack for THIS tool, shown under whichever specific reason (`message`) triggered the
  // prompt — it's the same purchase no matter which lock they hit, so show the whole thing every time.
  var UPSELL_BULLETS = [
    "Every rhythm in the bank: 5-lets, 7-lets, 9-lets, 32nds and the ratio rhythms",
    "Accents, flams, diddles and buzzes printed on the page",
    "Compound and asymmetric meters, plus loop and save your own setups"
  ];
  var UPSELL_PRICE = "$1 for your first week, then $9.99 a month.";
  function upsell(title, message) {
    var D = window.RDMDialogs;
    if (D && D.confirm) {
      D.confirm(root, {
        title: title, message: message, confirmLabel: "See what's included", theme: "theme-orange",
        bullets: UPSELL_BULLETS, price: UPSELL_PRICE
      }).then(function (ok) { if (ok && ctx.onUpgrade) ctx.onUpgrade(); });
    } else if (ctx.onUpgrade) ctx.onUpgrade();
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
  }

  /* ---------- engine (same construction as Playalongs) ---------- */
  var stableRenderW = 0;
  function measureStableRenderW() { var w = els.score.clientWidth; if (w > 150) stableRenderW = w; }
  var userAdjusting = false;

  var player = new RDMPlayer($("score"), {
    // click each measure's WRITTEN grouping — asymmetric meters (5/8, 7/8, 9/8) get dotted-quarter/quarter
    // pulses per the generator's pulseMap instead of every 8th note (Anthony). Simple/compound meters are
    // unchanged (their pulseMap equals the uniform pulse). Playalongs does NOT set this (it has no pulseMap
    // and uses metroAsymmetricSimple = straight quarters).
    metroGroupedPulse: true,
    // close the trailing blank before each bar line (see engine.js). Generated bars pack a lot of short
    // notes, and VexFlow's reserved trailing space showed up as a random hole mid-sheet.
    fillTrailing: true,
    getRenderWidth: function () { return stableRenderW || els.score.clientWidth || 0; },
    // desktop baseline = 0.8 (what used to read as "80%" is now the default 100%); the % label is
    // unchanged (it tracks the user zoom only). Narrow screens keep their existing size taper.
    // Phones draw at 0.8x what they used to: the size Anthony was hand-zooming to on his phone is now
    // simply what "100%" gives you (2026-07-22). The narrow branch is the old one scaled by 0.8 at every
    // width, so it also no longer JUMPS at the 780px boundary — a 779px window used to render at 0.999
    // against desktop's 0.8, i.e. bigger music on the smaller screen.
    baseScale: function (w) { w = w || 780; return w >= 780 ? 0.8 : Math.max(0.48, w / 780 * 0.8); },
    onTime: function (t) {
      els.progressFill.style.width = (t.fraction * 100) + "%";
      var s = fmtTime(t.currentSec) + " / " + fmtTime(t.totalSec);
      els.mainTimeLabel.textContent = s;
      if (els.progressLabelOver) els.progressLabelOver.textContent = s;
    },
    onTempoChange: function (bpm) {
      if (!userAdjusting) { els.tempoSlider.value = bpm; paintSlider(); }
      setTempoReadout(bpm);
    },
    onState: function (playing) {
      els.playBtn.classList.toggle("is-playing", playing);
      els.playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      if (ctx.onAudio) ctx.onAudio(playing);   // practice-time tracking
    },
    onNote: function (n) { if (ctx.onNotesPlayed) ctx.onNotesPlayed(n); },   // "notes played" stat

    onLoad: function (info) {
      els.tempoSlider.min = info.min;
      els.tempoSlider.max = info.max;
      els.tempoSlider.value = info.tempo;
      setTempoReadout(info.tempo);
      if (els.tempoNote && player.beatGlyph) {
        var g = player.beatGlyph(), di = g.indexOf(".");
        var note = di >= 0 ? g.slice(0, di) : g;
        els.tempoNote.innerHTML = note + (di >= 0 ? '<span class="dock__tempo-dot"></span>' : "") + " =";
      }
      paintSlider();
      if (!_restyling) resetScoreScroll();   // a live restyle keeps the reader's scroll position
    },
    onLoop: function () {},
    onLoopRange: function (info) {
      if (loopChip) {
        if (!info) { loopChip.hidden = true; }
        else {
          // note-precise M/B/P label from the engine, e.g. "Looping M3 B2 P1 – M6"
          loopChipTxt.textContent = "Looping " + (info.label || (barOfMeasure(info.m0) + (info.m1 !== info.m0 ? "–" + barOfMeasure(info.m1) : "")));
          loopChip.hidden = false;
        }
      }
      syncLoopPanel(info);   // keep the Loop panel in lockstep with the staff
      markTabDots();         // light/clear the Loop tab dot
    }
  });

  // loop chip (created here so onLoopRange can reference it; populated by onLoopRange). Lives in the
  // MIDDLE of the sheet foot: zoom (left) · loop chip · [lock · Generate] (right).
  var loopChip = document.createElement("div");
  loopChip.className = "loopchip"; loopChip.hidden = true;
  loopChip.innerHTML = '<svg class="loopchip__ico ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg><span class="loopchip__txt"></span><button type="button" class="loopchip__x" aria-label="Clear loop">✕</button>';
  var loopChipTxt = loopChip.querySelector(".loopchip__txt");
  loopChip.querySelector(".loopchip__x").addEventListener("click", function () { player.clearLoop(); });
  (function () {
    // insertBefore's reference node must be a DIRECT child of #sheetFoot — that's the lock+Generate
    // .sheet__foot-actions WRAPPER now (Anthony, 2026-07-16: added the lock button), not generateBtn
    // itself, which is nested a level deeper inside it.
    var _foot = root.getElementById("sheetFoot");
    var _ref = els.sheetFootActions || els.generateBtn;
    if (_foot && _ref) _foot.insertBefore(loopChip, _ref);
    else if (_foot) _foot.appendChild(loopChip);
    else els.sheetWrap.appendChild(loopChip);
  })();

  function paintSlider() {
    var min = +els.tempoSlider.min, max = +els.tempoSlider.max, val = +els.tempoSlider.value;
    var pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    if (els.tempoFill) els.tempoFill.style.width = pct + "%";
  }
  // the BPM readout speaks the sheet's pulse unit (matches the ♩/♩. glyph), NOT raw quarter-notes/min —
  // player.tempo stays true quarter-notes/min internally for scheduling (same convention as Playalongs)
  function setTempoReadout(bpm) { if (els.tempoInput && root.activeElement !== els.tempoInput) els.tempoInput.value = Math.round(bpm / player.beatUnitMult()); }

  /* ---------- generation + history ---------- */
  var history = [];          // [{score, settingsLabel}]
  var histPos = -1;          // index of the sheet being shown
  var HISTORY_MAX = 20;
  var sheetCount = 0;

  function currentScore() { return histPos >= 0 ? history[histPos].score : null; }

  function sheetLabel() {
    var sigs = settings.timeSigs.map(function (v) { return v === "9/8_asym" ? "9/8" : v; });
    var uniq = sigs.filter(function (v, i) { return sigs.indexOf(v) === i; });
    var sigTxt = uniq.length > 2 ? "Mixed meter" : uniq.join(" · ");
    return sigTxt + " · " + settings.measures + (settings.measures === 1 ? " bar" : " bars");
  }

  var _restyling = false;   // true = re-annotating the SAME sheet (sticking/counts/lead) — suppress fade + scroll reset
  function loadFromHistory() {
    var entry = history[histPos];
    if (!entry) return;
    var restyle = _restyling;   // capture for the async .then (player.load resolves later)
    var sw0 = scorewrap(); var keepScroll = (restyle && sw0) ? sw0.scrollTop : 0;
    els.sheetPlaceholder.hidden = true;
    els.sheetWrap.classList.add("has-score");
    els.sheetTitleText.innerHTML =
      '<span class="name-line">Sight Reading #' + entry.num + "</span>" +
      '<span class="cats">' + entry.label + "</span>";
    // originalTempo sets the ACTUAL starting tempo (this.tempo) — must stay entry.score.tempo (the
    // carried-forward current tempo) so playback correctly continues at, e.g., 200. tempoRangeAnchor is a
    // SEPARATE, stable baseline just for the slider's min/max (engine.js: minTempo=anchor/2, maxTempo=
    // anchor*2) — pinned to DEFAULT_TEMPO so the range never rescales itself around wherever tempo
    // happens to be. Before this, both used entry.score.tempo, so raising tempo to 200 then generating
    // re-centered the range on 200 (min 100/max 400) — the NUMBER stayed 200, but the thumb visibly
    // jumped to a different position on the new track, reading as "the slider snapped back" even though
    // nothing had actually reset (Anthony, 2026-07-16).
    player.load({ rdm: entry.score, originalTempo: entry.score.tempo, tempoRangeAnchor: DEFAULT_TEMPO }).then(function () {
      els.playBtn.disabled = false; els.rewindBtn.disabled = false; els.metroBtn.disabled = false;
      els.tempoSlider.disabled = false; els.tempoInput.disabled = false; els.tapTempoBtn.disabled = false;
      if (restyle) {
        // a live restyle just swaps the letters in place — no fade-in (reads as a flicker), keep scroll
        var sw1 = scorewrap(); if (sw1) sw1.scrollTop = keepScroll;
        _restyling = false;
      } else {
        els.score.classList.remove("score-in"); void els.score.offsetWidth; els.score.classList.add("score-in");
      }
      refreshSize(); fitScrollbar(); updateHistNav(); refreshLoopPanel();
    });
  }

  var DEFAULT_TEMPO = 100;   // starting tempo for the very first sheet, before any piece has ever loaded
  var everGenerated = false;
  function generateNew() {
    readMeasuresInput();
    // A new sheet keeps playing at whatever tempo the user is currently at — it does NOT reset to the
    // default. Only the very first Generate (player has no loaded piece yet) uses DEFAULT_TEMPO; every
    // one after that carries the live player tempo forward into the new generation.
    if (everGenerated) settings.tempo = Math.round(player.tempo / player.beatUnitMult());
    everGenerated = true;
    var score;
    try { score = G.generate(settings); }
    catch (e) { console.error("generate failed", e); return; }
    sheetCount++;
    // drop any "forward" sheets past the current one, then append
    history = history.slice(0, histPos + 1);
    history.push({ score: score, label: sheetLabel(), num: sheetCount });
    if (history.length > HISTORY_MAX) history.shift();
    histPos = history.length - 1;
    loadFromHistory();
  }

  /* Re-annotate the CURRENT sheet live (sticking / lead hand / counts) — same rhythm, new markings.
     Rhythm-defining settings (meters, rhythms, variations, measures, rests, syncopation) still apply
     on the next Generate; only annotation settings restyle in place. */
  function restyleCurrent() {
    var entry = history[histPos];
    if (!entry || !entry.score || !entry.score._ex) return;
    var keepTempo = player.tempo;   // don't let the reload snap tempo back to the sheet's original
    _restyling = true;              // loadFromHistory's async .then clears it (suppresses fade + scroll reset)
    entry.score = G.restyle(entry.score, settings);
    loadFromHistory();
    if (keepTempo) player.setTempo(keepTempo);
  }

  function histStep(dir) {
    var next = histPos + dir;
    if (next < 0 || next > history.length - 1) return;   // undo/redo only walk EXISTING sheets
    histPos = next;
    loadFromHistory();
  }

  function updateHistNav() {
    els.histBack.disabled = histPos <= 0;                       // undo: nothing older
    els.histFwd.disabled = histPos >= history.length - 1;       // redo: only after an undo (never "generate")
    els.histFwd.title = "Redo — next sheet (R)";
  }

  els.generateBtn.addEventListener("click", generateNew);
  els.histBack.addEventListener("click", function () { histStep(-1); });
  els.histFwd.addEventListener("click", function () { histStep(1); });

  /* ---------- transport ---------- */
  els.playBtn.addEventListener("click", function () { player.toggle(); });
  els.rewindBtn.addEventListener("click", function () { player.rewind(); });
  var metroOn = true;
  function setMetro(on) {
    metroOn = !!on;
    player.setMetronome(metroOn);
    els.metroBtn.setAttribute("aria-pressed", metroOn ? "true" : "false");
  }
  els.metroBtn.addEventListener("click", function () { setMetro(!metroOn); });

  /* click OR hold-and-drag the progress bar to scrub (same as Playalongs). Silent while held (Anthony,
     2026-07-31: "I shouldn't hear the scrubbing sound of the notes... only when you release should you
     actually hear audio") — player.seek() while playing calls _startPlay(), which restarts the scheduler
     and commits real notes to the audio graph, so calling it on every pointermove played a note preview
     at every mouse position during a drag. A drag now only moves the bar's fill visually; the real,
     audio-affecting seek() fires once, on release. A plain click (no movement between down and up) still
     seeks immediately, same as before, since pointerup always commits. */
  (function () {
    var dragging = false, pendingFrac = 0;
    function previewAt(clientX) {
      var rect = els.progressBar.getBoundingClientRect();
      var frac = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
      // The engine moves the CURSOR through the music as you drag and updates the bar/time readout
      // itself (Anthony, 2026-07-31), snapping to the loop start if you drag outside a loop window.
      // Silent: no audio is touched until pointerup commits with seek().
      if (player.scrubPreview) player.scrubPreview(frac);
      else els.progressFill.style.width = (frac * 100) + "%";
      return frac;
    }
    els.progressBar.addEventListener("pointerdown", function (e) {
      dragging = true;
      try { els.progressBar.setPointerCapture(e.pointerId); } catch (err) {}
      pendingFrac = previewAt(e.clientX);
    });
    els.progressBar.addEventListener("pointermove", function (e) { if (dragging) pendingFrac = previewAt(e.clientX); });
    els.progressBar.addEventListener("pointerup", function (e) {
      if (!dragging) return;
      dragging = false;
      try { els.progressBar.releasePointerCapture(e.pointerId); } catch (err) {}
      if (player.endScrub) player.endScrub();
      player.seek(pendingFrac);
    });
    els.progressBar.addEventListener("pointercancel", function () {
      dragging = false;
      if (player.endScrub) player.endScrub();   // hand the cursor back to the audio clock, seek nothing
    });
  })();

  /* ---------- tempo slider + typeable BPM + tap (same as Playalongs) ---------- */
  els.tempoSlider.addEventListener("input", function () {
    userAdjusting = true;
    player.setTempo(+els.tempoSlider.value);
    paintSlider();
  });
  ["change", "pointerup", "mouseup", "touchend", "blur"].forEach(function (evt) {
    els.tempoSlider.addEventListener(evt, function () { userAdjusting = false; });
  });
  function applyTempoInput() {
    var v = parseInt(els.tempoInput.value, 10);
    if (!isNaN(v)) player.setTempo(Math.round(v * player.beatUnitMult()));   // typed = pulse BPM → quarter BPM
    els.tempoInput.value = Math.round(player.tempo / player.beatUnitMult());  // reflect the actual (clamped) value
  }
  els.tempoInput.addEventListener("focus", function () { setTimeout(function () { els.tempoInput.select(); }, 0); });
  els.tempoInput.addEventListener("change", applyTempoInput);
  els.tempoInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); applyTempoInput(); els.tempoInput.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); els.tempoInput.value = Math.round(player.tempo / player.beatUnitMult()); els.tempoInput.blur(); }
  });
  var tapTimes = [];
  function tapTempo() {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 6) tapTimes.shift();
    if (tapTimes.length >= 2) {
      var avgMs = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
      // taps land on the sheet's felt pulse — convert to true quarter-notes/min, same as the typed field
      player.setTempo(Math.round((60000 / avgMs) * player.beatUnitMult()));
    }
  }
  els.tapTempoBtn.addEventListener("click", tapTempo);

  /* ---------- zoom / scroll-fit / edge fades (same as Playalongs) ---------- */
  function refreshSize() {
    var z = player.getZoom ? player.getZoom() : 1;
    els.sizeVal.textContent = Math.round(z * 100) + "%";
    els.sizeDown.disabled = z <= 0.5;
    els.sizeUp.disabled = z >= 2.5;
  }
  function nudgeSize(delta) {
    if (!player.setZoom) return;
    player.setZoom((player.getZoom ? player.getZoom() : 1) + delta);
    refreshSize(); fitScrollbar();
  }
  els.sizeDown.addEventListener("click", function () { nudgeSize(-0.1); });
  els.sizeUp.addEventListener("click", function () { nudgeSize(0.1); });
  els.sizeVal.addEventListener("click", function () { if (player.setZoom) { player.setZoom(1); refreshSize(); } });

  /* ---------- auto-scroll follow (lock) vs free scroll — ported from Playalongs exactly (Anthony,
     2026-07-16); the shared engine already has setFollowScroll/followScroll (default true), SR Lab just
     never exposed a button for it until now. ---------- */
  // Closed padlock = following the music (auto-scroll). Open padlock = free scroll (you control it).
  var LOCK_CLOSED = '<rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>';
  var LOCK_OPEN   = '<rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 7.5-1.7"></path>';
  function setFollow(on) {
    if (player.setFollowScroll) player.setFollowScroll(on);
    if (!els.followBtn) return;
    els.followBtn.setAttribute("aria-pressed", on ? "true" : "false");
    var svg = els.followBtn.querySelector("svg"); if (svg) svg.innerHTML = on ? LOCK_CLOSED : LOCK_OPEN;
    els.followBtn.title = on ? "Auto-scroll: locked to the music (tap to scroll freely)"
                             : "Auto-scroll: off — scroll freely (tap to follow the music)";
  }
  if (els.followBtn) {
    els.followBtn.addEventListener("click", function () { setFollow(els.followBtn.getAttribute("aria-pressed") !== "true"); });
  }

  var SCROLL_TOL = 8, FADE = "26px", FADE_EDGE = 2;
  function scorewrap() { return els.score && els.score.closest ? els.score.closest(".scorewrap") : null; }
  function fitScrollbar() {
    var sw = scorewrap(); if (!sw) return;
    requestAnimationFrame(function () {
      sw.classList.remove("no-scroll");
      var over = sw.scrollHeight - sw.clientHeight;
      if (over > 0 && over <= SCROLL_TOL) sw.classList.add("no-scroll");
      updateOverflowFades();
    });
  }
  function resetScoreScroll() { var sw = scorewrap(); if (sw) sw.scrollTop = 0; }
  function updateOverflowFades() {
    var sw = scorewrap(); if (!sw) return;
    var over = sw.scrollHeight - sw.clientHeight;
    if (over <= SCROLL_TOL) { sw.style.setProperty("--fade-top", "0px"); sw.style.setProperty("--fade-bottom", "0px"); return; }
    sw.style.setProperty("--fade-top", sw.scrollTop > FADE_EDGE ? FADE : "0px");
    sw.style.setProperty("--fade-bottom", (over - sw.scrollTop) > FADE_EDGE ? FADE : "0px");
  }
  (function () { var sw = scorewrap(); if (sw) sw.addEventListener("scroll", updateOverflowFades, { passive: true }); })();

  /* ---------- horizontal edge fade for the scrollable rhythm-tile row ----------
     Same recipe as the score's top/bottom fade, but left/right: fade the leading/trailing edge whenever
     there's more content to scroll to, so the row blurs off-screen like the sheet music. */
  function hfadeEl(el) {
    if (!el) return;
    /* Feed the mask the REAL scrollbar gutter. The fade is two mask layers (see --sb-h in index.html) and
       the second one has to cover the scrollbar exactly: too short and the top of the orange bar gets
       faded, too tall and an unfaded stub of the clipped tile is left behind. The reserved height is a
       platform/browser decision — the CSS asks for 11px and Chrome on Windows gives 15 — so measure it
       instead of trusting the stylesheet. Guarded: only write when it looks like a real gutter, so a
       transient 0 during layout does not blow the strip away. */
    var gutter = el.offsetHeight - el.clientHeight;
    if (gutter > 0 && gutter < 40) el.style.setProperty("--sb-h", gutter + "px");

    /* How far this actually scrolls. NOT the usual scrollWidth - clientWidth: on this element clientWidth
       comes back 15px SHORTER than offsetWidth (a scrollbar-reservation quirk of overflow-x:auto paired
       with overflow-y:hidden), so the naive figure overstates the maximum by exactly that much. Measured:
       naive said 550, scrollLeft actually clamps at 535. The right-hand fade therefore never switched off
       at the end of the row — it always thought there were 15 more pixels to go.
       Subtracting the same discrepancy fixes it, and collapses to the naive value when there is none. */
    var slack = Math.max(0, el.offsetWidth - el.clientWidth);
    var over = Math.max(0, el.scrollWidth - el.clientWidth - slack);
    if (over <= SCROLL_TOL) { el.style.setProperty("--fade-left", "0px"); el.style.setProperty("--fade-right", "0px"); return; }
    el.style.setProperty("--fade-left",  el.scrollLeft > FADE_EDGE ? FADE : "0px");
    el.style.setProperty("--fade-right", (over - el.scrollLeft) > FADE_EDGE ? FADE : "0px");
  }
  function hfadeAll() { hfadeEl(els.rhythmGrid); }
  // run once synchronously (reading clientWidth forces a layout flush, so it's accurate right after a
  // panel opens) AND once next frame (in case widths are still settling). rAF alone is unreliable when
  // the tab is backgrounded, so the sync call is the guarantee.
  function refreshHFades() { hfadeAll(); requestAnimationFrame(hfadeAll); }
  if (els.rhythmGrid) els.rhythmGrid.addEventListener("scroll", hfadeAll, { passive: true });
  window.addEventListener("resize", refreshHFades, { passive: true });

  /* ---------- settings controls ---------- */
  function readMeasuresInput() {
    var v = parseInt(els.measInput.value, 10);
    if (isNaN(v)) v = settings.measures;
    settings.measures = Math.max(1, Math.min(32, v));
    els.measInput.value = settings.measures;
  }
  els.measInput.addEventListener("change", readMeasuresInput);
  els.measDown.addEventListener("click", function () { readMeasuresInput(); settings.measures = Math.max(1, settings.measures - 1); els.measInput.value = settings.measures; });
  els.measUp.addEventListener("click", function () { readMeasuresInput(); settings.measures = Math.min(32, settings.measures + 1); els.measInput.value = settings.measures; });

  function paintRests() {
    var v = +els.restsSlider.value;
    els.restsVal.textContent = v + "%";
    var pct = (v / +els.restsSlider.max) * 100;
    if (els.restsFill) els.restsFill.style.width = pct + "%";
  }
  els.restsSlider.addEventListener("input", function () { settings.restPct = +els.restsSlider.value; paintRests(); });
  paintRests();

  function paintVariety() {
    if (!els.varietySlider) return;
    var v = +els.varietySlider.value;
    if (els.varietyVal) els.varietyVal.textContent = v + "%";
    var pct = (v / +els.varietySlider.max) * 100;
    if (els.varietyFill) els.varietyFill.style.width = pct + "%";
  }
  if (els.varietySlider) {
    els.varietySlider.value = settings.variety;
    els.varietySlider.addEventListener("input", function () { settings.variety = +els.varietySlider.value; paintVariety(); });
    paintVariety();
  }

  function paintSubdiv() {
    if (!els.subdivSlider) return;
    var v = +els.subdivSlider.value;
    if (els.subdivVal) els.subdivVal.textContent = v + "%";
    var pct = (v / +els.subdivSlider.max) * 100;
    if (els.subdivFill) els.subdivFill.style.width = pct + "%";
  }
  if (els.subdivSlider) {
    els.subdivSlider.value = settings.subdiv;
    els.subdivSlider.addEventListener("input", function () { settings.subdiv = +els.subdivSlider.value; paintSubdiv(); });
    paintSubdiv();
  }

  function paintSparsity() {
    if (!els.sparsitySlider) return;
    var v = +els.sparsitySlider.value;
    if (els.sparsityVal) els.sparsityVal.textContent = v + "%";
    var pct = (v / +els.sparsitySlider.max) * 100;
    if (els.sparsityFill) els.sparsityFill.style.width = pct + "%";
  }
  if (els.sparsitySlider) {
    els.sparsitySlider.value = settings.sparsity;
    els.sparsitySlider.addEventListener("input", function () { settings.sparsity = +els.sparsitySlider.value; paintSparsity(); });
    paintSparsity();
  }

  els.countsToggle.addEventListener("change", function () { settings.showCounts = els.countsToggle.checked; restyleCurrent(); });
  els.syncToggle.addEventListener("change", function () { settings.syncopation = els.syncToggle.checked; });
  els.stickingToggle.checked = settings.stickingOn !== false;
  els.stickingToggle.addEventListener("change", function () { settings.stickingOn = els.stickingToggle.checked; restyleCurrent(); });
  els.leadHandToggle.checked = settings.leadHand === "L";
  els.leadHandToggle.addEventListener("change", function () { settings.leadHand = els.leadHandToggle.checked ? "L" : "R"; restyleCurrent(); });

  /* ---------- ornament density sliders (Ornaments tab) ---------- */
  var ORN = [
    { key: "accent", slider: els.accentSlider, fill: els.accentFill, val: els.accentVal },
    { key: "flam",   slider: els.flamSlider,   fill: els.flamFill,   val: els.flamVal },
    { key: "diddle", slider: els.diddleSlider, fill: els.diddleFill, val: els.diddleVal },
    { key: "buzz",   slider: els.buzzSlider,   fill: els.buzzFill,   val: els.buzzVal }
  ];
  function paintOrn(o) {
    var v = +o.slider.value;
    o.val.textContent = v + "%";
    if (o.fill) o.fill.style.width = (v / +o.slider.max) * 100 + "%";
  }
  ORN.forEach(function (o) {
    o.slider.addEventListener("input", function () { settings.ornaments[o.key] = +o.slider.value; paintOrn(o); markTabDots(); });
    paintOrn(o);
  });

  /* ---------- tab bar (Rhythms / Setup / Ornaments) ---------- */
  var tabButtons = Array.prototype.slice.call(root.querySelectorAll(".tab[data-tab]"));
  var TAB_ORDER = ["rhythms", "setup", "ornaments", "loop", "presets"];   // 1-5 keyboard shortcut order
  var openTab = null;   // start with NO tab open (panels collapsed) on load/refresh
  /* FREEMIUM: the locked tabs stay VISIBLE and greyed rather than being removed. A lock the drummer can
     see is what sells the upgrade; a missing tab just looks like a tool that can't do much. (2026-07-31) */
  var LOCKED_TABS = { ornaments: 1, loop: 1, presets: 1 };
  function tabLocked(name) { return !PAID && !!LOCKED_TABS[name]; }
  var METER_LOCK_MSG = "Compound and asymmetric meters come with the full version, along with every rhythm in the generator.";
  var TAB_LOCK_MSG = {
    ornaments: "Accents, flams, diddles and buzzes come with the full version.",
    loop: "Looping a section comes with the full version, along with every rhythm in the generator.",
    presets: "Saving your own presets comes with the full version."
  };
  function selectTab(name) {
    if (tabLocked(name)) {
      var lbl = root.querySelector('.tab[data-tab="' + name + '"] .tab__lbl');
      upsell("Unlock " + ((lbl && lbl.textContent) || name), TAB_LOCK_MSG[name] || "");
      return;
    }
    // clicking the already-open tab collapses the panel area (same as Playalongs)
    if (openTab === name && !els.tabpanels.classList.contains("collapsed")) {
      els.tabpanels.classList.add("collapsed");
      tabButtons.forEach(function (b) { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      relayoutSoon();
      return;
    }
    openTab = name;
    els.tabpanels.classList.remove("collapsed");
    tabButtons.forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.prototype.forEach.call(root.querySelectorAll(".tabpanel"), function (p) {
      p.classList.toggle("open", p.getAttribute("data-panel") === name);
    });
    relayoutSoon();
    refreshHFades();   // panel just became visible → its scroll width is now measurable
  }
  function relayoutSoon() { requestAnimationFrame(function () { if (player && player.relayout) player.relayout(); }); }
  tabButtons.forEach(function (b) {
    var nm = b.getAttribute("data-tab");
    if (tabLocked(nm)) {
      b.classList.add("tab--locked");
      b.setAttribute("aria-label", (b.textContent || nm).trim() + " (upgrade to unlock)");
    }
    b.addEventListener("click", function () { selectTab(nm); });
  });

  // "running" dot on a tab whose feature is active while its panel may be closed
  function markTabDots() {
    var ornOn = ORN.some(function (o) { return settings.ornaments[o.key] > 0; });
    var t = root.getElementById("tabOrnaments"); if (t) t.classList.toggle("on", ornOn);
    var lt = root.getElementById("tabLoop");
    if (lt) lt.classList.toggle("on", !!(player && player.hasLoop && player.hasLoop()));
  }

  /* ---------- shared modal picker (multi-select for meters + rhythms, single for sticking) ---------- */
  var activePicker = null;   // "timesig" | "sticking" | "variants" (Rhythms categories live inline in the tab)
  var variantCat = null;     // which category the "variants" popup is showing

  function openVariantPicker(key, label) {
    variantCat = key;
    openPicker("variants", label);
  }
  // test/capture hooks for dev/capture-learn.js: open a family's variation popup, render the presets
  // panel (its tab is sign-in-gated), and set up an isolated "only 16th-note family, all its variations
  // on" state so the Sparsity example has gap-variations to thin (sparsity does nothing with only the
  // full figure on). No effect in normal use.
  try {
    window.RDMSightreadOpenVariants = openVariantPicker;
    window.RDMSightreadRenderPresets = renderPresetsPanel;
    window.RDMSightreadOnly16thVars = function () { window.RDMSightreadSetFamilies(["16s"]); };
    // capture only: turn ON exactly the given rhythm families (by key), with ALL their variations active,
    // and everything else off — so a tutorial example shows a controlled rhythm mix.
    window.RDMSightreadSetFamilies = function (keys) {
      Object.keys(settings.cats).forEach(function (k) { settings.cats[k] = keys.indexOf(k) !== -1; });
      if (G.active && G.VARIANTS) { G.active.clear(); keys.forEach(function (key) { (G.VARIANTS[key] || []).forEach(function (v) { G.active.add(v.id); }); }); }
    };
    // capture only: keep generating until the page contains a plain quarter, a triplet (num 3) AND an
    // eighth, so the "slow subdivision" example reliably shows all three slow rhythms (random generation
    // otherwise drops one). Only meaningful with the [q, qt, 8s] families active.
    window.RDMSightreadGenUntilSlow = function () {
      for (var t = 0; t < 60; t++) {
        generateNew();
        var s = history[histPos] && history[histPos].score;
        if (!s || !s.measures) continue;
        var hasQ = false, hasT = false, hasE = false;
        s.measures.forEach(function (m) {
          var inTup = {};
          (m.tuplets || []).forEach(function (tp) { if (tp.num === 3) (tp.idx || []).forEach(function (i) { inTup[i] = true; }); });
          (m.events || []).forEach(function (ev, i) {
            if (ev.rest) return;
            if (inTup[i]) hasT = true; else if (ev.dur === "q") hasQ = true;
            if (ev.dur === "8" && !inTup[i]) hasE = true;
          });
        });
        if (hasQ && hasT && hasE) return true;
      }
      return false;
    };
    // capture only: keep generating until NO two adjacent beats share the same rhythm, so the
    // "variety high" example truly changes every beat. Beat signature = its tuplet number, or its note
    // count if untupled.
    window.RDMSightreadGenUntilVaried = function () {
      for (var t = 0; t < 400; t++) {
        generateNew();
        var s = history[histPos] && history[histPos].score;
        if (!s || !s.measures) continue;
        var sigs = [];
        s.measures.forEach(function (m) {
          var inTup = {}, tupNum = {};
          (m.tuplets || []).forEach(function (tp) { (tp.idx || []).forEach(function (i) { inTup[i] = true; tupNum[i] = tp.num; }); });
          var beatSig = {}, cum = 0;
          (m.events || []).forEach(function (ev, i) {
            var b = Math.floor(cum + 1e-6);
            if (beatSig[b] == null) beatSig[b] = inTup[i] ? ("t" + tupNum[i]) : ("n" + ev.dur);
            cum += (ev.beats || 0);
          });
          Object.keys(beatSig).sort(function (a, b) { return a - b; }).forEach(function (b) { sigs.push(beatSig[b]); });
        });
        var ok = sigs.length > 3;
        for (var i = 1; i < sigs.length; i++) { if (sigs[i] === sigs[i - 1]) { ok = false; break; } }
        if (ok) return true;
      }
      return false;
    };
    // capture only: the "variety LOW" example — bar 1 all eighth-note triplets, bar 2 all eighths. The
    // generator locks one rhythm family across a whole page at low variety and won't reliably make two
    // uniform-but-different bars, so build it DETERMINISTICALLY: generate a 1-bar all-triplet page and a
    // 1-bar all-eighth page (each uniform at variety 0), splice their raw exercises into one 2-bar exercise,
    // and restyle it back onto the sheet. (Anthony, 2026-07-24)
    window.RDMSightreadGenUntilVarietyLo = function () {
      var setS = function (id, v) { var el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } };
      var setM = function (v) { var el = document.getElementById("measInput"); if (el) { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); } };
      setS("varietySlider", 0); setS("sparsitySlider", 0); setS("restsSlider", 0); setM(1);   // uniform, complete, 1 bar
      window.RDMSightreadSetFamilies(["8t"]); generateNew(); var scTrip = history[histPos] && history[histPos].score;      // 1 bar of triplets
      window.RDMSightreadSetFamilies(["8s"]); generateNew(); var scEighth = history[histPos] && history[histPos].score;    // 1 bar of eighths
      if (!scTrip || !scEighth || !scTrip.measures || !scEighth.measures || scTrip.measures.length < 2 || scEighth.measures.length < 2) return false;
      // score.measures[0] is the count-in; [1] is the single content bar. Splice: count-in + triplet + eighth.
      var combined = Object.assign({}, scEighth);
      combined.measures = [scEighth.measures[0], scTrip.measures[1], scEighth.measures[1]];
      history[histPos].score = combined;
      loadFromHistory();
      return true;
    };
  } catch (e) {}

  function openPicker(kind, title) {
    activePicker = kind;
    els.pickerTitle.textContent = title;
    els.pickerSearch.value = "";
    renderPickerList("");
    els.pickerEl.hidden = false;
    els.pickerEl.classList.remove("is-closing");
    void els.pickerEl.offsetWidth;
    els.pickerEl.classList.add("is-open");
    // A FRESH open always starts at the top of the list — only in-picker toggles preserve scroll (via
    // rerenderKeepScroll). Set it after the modal is visible, since scrollTop is a no-op while hidden.
    var _lw = els.pickerList.parentElement; if (_lw) _lw.scrollTop = 0;
    if (!matchMedia("(hover:none)").matches) setTimeout(function () { els.pickerSearch.focus({ preventScroll: true }); }, 30);
  }
  function closePicker() {
    if (els.pickerEl.hidden || els.pickerEl.classList.contains("is-closing")) return;
    els.pickerEl.classList.remove("is-open");
    els.pickerEl.classList.add("is-closing");
    var panel = els.pickerEl.querySelector(".modal__stack");
    var finish = function () {
      if (!els.pickerEl.classList.contains("is-closing")) { cleanup(); return; }
      els.pickerEl.hidden = true; els.pickerEl.classList.remove("is-closing"); cleanup();
    };
    function cleanup() { if (panel) panel.removeEventListener("animationend", finish); }
    if (panel) panel.addEventListener("animationend", finish);
    setTimeout(finish, 280);
    activePicker = null;
  }

  function li(label, opts) {
    var el = document.createElement("li");
    el.setAttribute("role", "option");
    if (opts && opts.multi) {
      el.className = "multi" + (opts.on ? " active" : "");
      el.innerHTML = "<span>" + label + '</span><span class="tick" aria-hidden="true"></span>';
    } else {
      el.textContent = label;
      if (opts && opts.on) el.classList.add("active");
    }
    return el;
  }
  /* The two dotted-8th shapes, labelled by what they actually are. A dotted 8th is 0.75 of a beat, so it
     only lands back on a beat in groups of 2 (1.5 beats) or 4 (3 beats) — those are two different
     figures, not variations of each other, so the picker gives each its own titled half. */
  var DOTTED8_SECTION = { 4: "Groups of 4  ·  3 beats", 2: "Groups of 2  ·  1.5 beats" };

  function grouphdr(text) {
    var h = document.createElement("li");
    h.className = "modal__grouphdr";
    h.textContent = text;
    return h;
  }
  // the old picker's two-level headers ("Simple Pulse|||4 Note Grouping"): main = pulse world, sub = grouping
  function grouphdrMain(text) {
    var h = grouphdr(text);
    h.className += " modal__grouphdr--main";
    return h;
  }

  /* real staff time-signature glyphs via the shared renderer's bare mode — same builder the Metronome
     popup uses (subIconStage → RDMRender bare → crop to ink → recolor via CSS currentColor). Cached per
     value; returns a FRESH detached <svg> each call. */
  var _tsStage = null;
  function tsStage() {
    if (_tsStage) return _tsStage;
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;pointer-events:none;opacity:0;";
    (root.body || root).appendChild(d); _tsStage = d; return d;
  }
  var _tsCache = {};
  function timeSigGlyph(value) {
    if (!window.RDMRender) return null;
    if (!_tsCache[value]) {
      var p = String(value || "4/4").split("/");
      var measures = [{ timeSig: [parseInt(p[0], 10) || 4, parseInt(p[1], 10) || 4], events: [], beams: [], tuplets: [] }];
      var stage = tsStage();
      try { window.RDMRender.render({ measures: measures }, stage, { width: 120, zoom: 1, bare: true }); }
      catch (e) { return null; }
      var svg = stage.querySelector("svg"); if (!svg) return null;
      var bb = svg.getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        var pad = 2;
        svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " + (bb.width + pad * 2) + " " + (bb.height + pad * 2));
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.style.width = ""; svg.style.height = "";
      }
      _tsCache[value] = svg.outerHTML;
    }
    var tmp = document.createElement("div"); tmp.innerHTML = _tsCache[value];
    return tmp.querySelector("svg");
  }

  /* ---------- rhythm notation glyphs (the old tool's rhythm tiles) ----------
     One representative bar of notation per category, rendered through the SAME bare renderer as the
     time-sig glyphs so the boxes look byte-for-byte like the sheet. No time signature drawn. The recipes
     mirror the old Sightreading Lab's icon set (dur/tuplet/beam per category). */
  function rn(dur, dots) {
    return { rest: false, beats: 0, dur: dur, dots: dots || 0, step: "c", oct: 5, head: "normal",
      heads: [{ step: "c", oct: 5, head: "normal" }], accent: false, marcato: false, tenuto: false,
      staccato: false, roll: 0, buzz: false, flam: false, graces: null, stick1: null, stick2: null, dynamic: null };
  }
  function fill(n, dur) { var a = []; for (var i = 0; i < n; i++) a.push(rn(dur)); return a; }
  function seq(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
  // key -> { events, beams, tuplets } (no timeSig → bare mode omits it)
  var RHYTHM_RECIPE = {
    "q":      { events: [rn("q")],            beams: [],            tuplets: [] },
    "dottedQ":{ events: [rn("q", 1)],         beams: [],            tuplets: [] },
    "8s":     { events: fill(2, "8"),         beams: [[0, 1]],      tuplets: [] },
    "16s":    { events: fill(4, "16"),        beams: [[0, 1, 2, 3]],tuplets: [] },
    "8t":     { events: fill(3, "8"),         beams: [[0, 1, 2]],   tuplets: [{ idx: seq(3), num: 3, inSpaceOf: 2, bracket: false, show: true }] },
    "qt":     { events: fill(3, "q"),         beams: [],            tuplets: [{ idx: seq(3), num: 3, inSpaceOf: 2, bracket: true,  show: true }] },
    "5let":   { events: fill(5, "8"),         beams: [seq(5)],      tuplets: [{ idx: seq(5), num: 5, inSpaceOf: 4, bracket: false, show: true }] },
    "5let16": { events: fill(5, "16"),        beams: [seq(5)],      tuplets: [{ idx: seq(5), num: 5, inSpaceOf: 4, bracket: false, show: true }] },
    "6let":   { events: fill(6, "16"),        beams: [seq(6)],      tuplets: [{ idx: seq(6), num: 6, inSpaceOf: 4, bracket: false, show: true }] },
    "9let":   { events: fill(9, "16"),        beams: [seq(9)],      tuplets: [{ idx: seq(9), num: 9, inSpaceOf: 8, bracket: false, show: true }] },
    // Engine V2 expansion
    "7let":   { events: fill(7, "16"),        beams: [seq(7)],      tuplets: [{ idx: seq(7), num: 7, inSpaceOf: 4, bracket: false, show: true }] },
    "7let8":  { events: fill(7, "8"),         beams: [seq(7)],      tuplets: [{ idx: seq(7), num: 7, inSpaceOf: 4, bracket: false, show: true }] },
    "32nd":   { events: fill(8, "32"),        beams: [seq(8)],      tuplets: [] },
    "dotted8":{ events: [rn("8", 1), rn("8", 1)], beams: [[0, 1]],   tuplets: [] },
    "r43":    { events: fill(4, "8"),         beams: [seq(4)],      tuplets: [{ idx: seq(4), num: 4, inSpaceOf: 3, bracket: false, show: true }] },
    "r53":    { events: fill(5, "8"),         beams: [seq(5)],      tuplets: [{ idx: seq(5), num: 5, inSpaceOf: 3, bracket: false, show: true }] },
    "r73":    { events: fill(7, "16"),        beams: [seq(7)],      tuplets: [{ idx: seq(7), num: 7, inSpaceOf: 6, bracket: false, show: true }] },
    "r83":    { events: fill(8, "16"),        beams: [seq(8)],      tuplets: [{ idx: seq(8), num: 8, inSpaceOf: 6, bracket: false, show: true }] },
    "r46":    { events: fill(4, "16"),        beams: [seq(4)],      tuplets: [{ idx: seq(4), num: 4, inSpaceOf: 3, bracket: false, show: true }] },
    "r56":    { events: fill(5, "16"),        beams: [seq(5)],      tuplets: [{ idx: seq(5), num: 5, inSpaceOf: 3, bracket: false, show: true }] },
    "r76":    { events: fill(7, "32"),        beams: [seq(7)],      tuplets: [{ idx: seq(7), num: 7, inSpaceOf: 6, bracket: false, show: true }] },
    "r86":    { events: fill(8, "32"),        beams: [seq(8)],      tuplets: [{ idx: seq(8), num: 8, inSpaceOf: 6, bracket: false, show: true }] }
  };
  var _rhStage = null;
  function rhStage() {
    if (_rhStage) return _rhStage;
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;pointer-events:none;opacity:0;";
    (root.body || root).appendChild(d); _rhStage = d; return d;
  }
  var _rhCache = {};
  function rhythmGlyph(key) {
    if (!window.RDMRender || !RHYTHM_RECIPE[key]) return null;
    if (!_rhCache[key]) {
      var r = RHYTHM_RECIPE[key];
      var measures = [{ timeSig: null, repeatStart: false, repeatEndTimes: 0,
        events: r.events, beams: r.beams, tuplets: r.tuplets, extraVoices: [] }];
      var stage = rhStage();
      try { window.RDMRender.render({ measures: measures }, stage, { width: 220, zoom: 1, bare: true }); }
      catch (e) { return null; }
      var svg = stage.querySelector("svg"); if (!svg) return null;
      var bb = svg.getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        var pad = 3;
        svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " + (bb.width + pad * 2) + " " + (bb.height + pad * 2));
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.style.width = ""; svg.style.height = "";
      }
      _rhCache[key] = svg.outerHTML;
    }
    var tmp = document.createElement("div"); tmp.innerHTML = _rhCache[key];
    return tmp.querySelector("svg");
  }

  /* one variation's notation, rendered from its OWN notes — WYSIWYG with what generation inserts.
     Beams = runs of adjacent beamable notes (rests break them); tuplet from the variant's _tuplet
     override (false = none) or its id prefix (old-app rules); bracket when not one continuous beam. */
  var _vgCache = {};
  function variantGlyph(v) {
    if (!window.RDMRender || !v || !v.notes) return null;
    if (!_vgCache[v.id]) {
      var events = v.notes.map(function (n) {
        var rest = n.kind === "rest";
        return { rest: rest, beats: 0, dur: n.dur, dots: Number(n.dots) || 0, step: "c", oct: 5, head: "normal",
          heads: rest ? null : [{ step: "c", oct: 5, head: "normal" }], accent: false, marcato: false,
          tenuto: false, staccato: false, roll: 0, buzz: false, flam: false, graces: null,
          stick1: null, stick2: null, dynamic: null };
      });
      var BEAMABLE = { "8": 1, "16": 1, "32": 1 };
      var beams = [], run = [];
      var flush = function () { if (run.length >= 2) beams.push(run.slice()); run = []; };
      events.forEach(function (e, i) { if (!e.rest && BEAMABLE[e.dur]) run.push(i); else flush(); });
      flush();
      var cfg = null, id = v.id || "";
      if (id.indexOf("8t") === 0 || id.indexOf("qt") === 0) cfg = { num_notes: 3, notes_occupied: 2 };
      if (id.indexOf("5let") === 0) cfg = { num_notes: 5, notes_occupied: 4 };
      if (id.indexOf("6let") === 0) cfg = { num_notes: 6, notes_occupied: 4 };
      if (v._tuplet !== undefined) cfg = v._tuplet || null;   // explicit override (false/null = none)
      var tuplets = [];
      if (cfg && cfg.num_notes) {
        var oneBeam = beams.length === 1 && beams[0].length === events.length;
        tuplets.push({ idx: events.map(function (_, i) { return i; }), num: cfg.num_notes,
          inSpaceOf: cfg.notes_occupied || 2, bracket: !oneBeam, show: true });
      }
      var measures = [{ timeSig: null, repeatStart: false, repeatEndTimes: 0,
        events: events, beams: beams, tuplets: tuplets, extraVoices: [] }];
      var stage = rhStage();
      try { window.RDMRender.render({ measures: measures }, stage, { width: 220, zoom: 1, bare: true }); }
      catch (e) { return null; }
      var svg = stage.querySelector("svg"); if (!svg) return null;
      var bb = svg.getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        var pad = 3;
        svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " + (bb.width + pad * 2) + " " + (bb.height + pad * 2));
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.style.width = ""; svg.style.height = "";
      }
      _vgCache[v.id] = svg.outerHTML;
    }
    var tmp = document.createElement("div"); tmp.innerHTML = _vgCache[v.id];
    return tmp.querySelector("svg");
  }

  // bulk-select helpers for the Rhythms quick-select row
  /* The Duple / Triplet / Sparse / Basic cycling preset button was removed (Anthony, 2026-07-31): the
     tiles do the same job more directly, and a button whose label changes as you press it was never
     obvious. The category maps it applied went with it. */

  // every variant id in the bank (all variations of all rhythms) — the "All" preset
  function allVariantIds() {
    var ids = [];
    Object.keys(G.VARIANTS).forEach(function (cat) {
      (G.VARIANTS[cat] || []).forEach(function (v) { if (ids.indexOf(v.id) === -1) ids.push(v.id); });
    });
    return ids;
  }
  function variationsAreAll() {
    var ids = allVariantIds();
    return ids.length > 0 && ids.every(function (id) { return G.active.has(id); });
  }
  // exactly each rhythm's FULL variation and nothing else — drives the "Full" button's dim/normal state
  function variationsAreFullOnly() {
    var full = G.FULL_IDS || [];
    if (!full.length || G.active.size !== full.length) return false;
    return full.every(function (id) { return G.active.has(id); });
  }

  /* Old-app toggle semantics: if EVERY item matching the predicate is already on, turn them all off;
     otherwise turn them all on. Used by the category quick-row AND the variant-popup quick-actions. */
  function toggleCats(pred) {
    var matching = G.CATEGORIES.filter(function (c) { return pred(c.key) && !catLocked(c.key); });
    var allOn = matching.every(function (c) { return settings.cats[c.key]; });
    matching.forEach(function (c) { settings.cats[c.key] = !allOn; });
    // never leave zero on (generation needs at least one) — fall back to quarters
    if (!G.CATEGORIES.some(function (c) { return settings.cats[c.key]; })) settings.cats.q = true;
    renderRhythmGrid();
  }

  /* which pulse worlds the chosen meters live in — drives which variants a picker shows (old-app rules) */
  function meterContext() {
    var hasSimple = false, hasCompound = false;
    var sigs = settings.timeSigs.length ? settings.timeSigs : ["4/4"];
    sigs.forEach(function (ts) {
      if (ts.indexOf("_asym") !== -1 || ts === "5/8" || ts === "7/8") { hasSimple = true; hasCompound = true; return; }
      var p = ts.split("/"), num = parseInt(p[0], 10), den = parseInt(p[1], 10);
      if (den === 4) hasSimple = true;
      else if (den === 8) { if (num % 3 === 0) hasCompound = true; else { hasSimple = true; hasCompound = true; } }
    });
    if (!hasSimple && !hasCompound) hasSimple = true;
    return { simple: hasSimple, compound: hasCompound };
  }

  // categories that never open a variation popup in the current meter (plain on/off toggle instead)
  function isPlainToggle(key) {
    var ctx = meterContext();
    if (key === "dottedQ") return true;                                        // whole-category by design
    if (key === "q" && ctx.simple && !ctx.compound) return true;               // q has variants only in compound
    if (!ctx.simple && ctx.compound && (key === "5let" || key === "9let" || key === "qt")) return true;
    return false;
  }

  /* ---------- Rhythms tab: inline notation-tile grid (was a popup, now a panel) ---------- */
  function renderRhythmGrid() {
    // Presets row (always visible): [All] [Full]. All toggles every rhythm CATEGORY on/off; Full toggles
    // every VARIATION on vs. each rhythm's full variation only. These are momentary actions, not persistent
    // on/off state, so neither recolors when clicked (Anthony: no white buttons here) — EXCEPT Full, which
    // reads like an on/off toggle: dim by default (full-only, its "off"/resting state), normal color once
    // every variation is active (its "on" state) (Anthony, 2026-07-16).
    els.rhQuickRow.innerHTML = "";
    function mkQuick(label, onClick, extraCls) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rh-quick" + (extraCls ? " " + extraCls : "");
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      els.rhQuickRow.appendChild(btn);
      return btn;
    }

    // All — every rhythm category on/off together (old toggle semantics: all on already → turn off
    // down to the ≥1 guard fallback; otherwise turn every category on)
    mkQuick("All", function () { toggleCats(function () { return true; }); });
    // Full — every variation on, or back off to just each rhythm's full variation. Dim by default ("off" —
    // full-only, the resting state); normal color once it's "on" (every variation active).
    mkQuick("Full", function () {
      if (variationsAreAll()) {
        G.active.clear();
        (G.FULL_IDS || []).forEach(function (id) { G.active.add(id); });
      } else {
        allVariantIds().forEach(function (id) { G.active.add(id); });
      }
      renderRhythmGrid();
    }, variationsAreFullOnly() ? "rh-quick--dim" : "");

    // the notation tile grid always shows now — no "Rhythms" toggle button (Anthony, 2026-07-16: "no
    // point in it", removed on desktop AND mobile; the grid just renders whenever the Rhythms panel is
    // open, same as it did before that button ever existed).

    // notation tiles — split in two: LEFT check half toggles the category, RIGHT notation half opens the
    // variations popup (or toggles too, for categories with no meaningful popup in the current meter)
    els.rhythmGrid.innerHTML = "";
    G.CATEGORIES.forEach(function (c) {
      var on = settings.cats[c.key] !== false;
      var tile = document.createElement("li");
      tile.setAttribute("role", "option");
      tile.setAttribute("aria-selected", on ? "true" : "false");
      tile.className = "rh-tile" + (on ? " active" : "");
      var plain = isPlainToggle(c.key);
      var locked = catLocked(c.key);
      if (locked) tile.classList.add("rh-tile--locked");
      function lockedUpsell() {
        upsell("Unlock " + c.label,
               "The full version adds 5-lets, 7-lets, 9-lets, sextuplets, 32nds, dotted 8ths and the ratio rhythms.");
      }
      function toggleCategory() {
        if (locked) { lockedUpsell(); return; }
        var now = settings.cats[c.key] !== false;
        var onCount = G.CATEGORIES.filter(function (x) { return settings.cats[x.key] !== false; }).length;
        if (now && onCount <= 1) return;   // keep ≥1 category on
        settings.cats[c.key] = !now;
        renderRhythmGrid();
      }
      var check = document.createElement("span"); check.className = "rh-check"; check.title = c.label + " on / off";
      var tick = document.createElement("span"); tick.className = "tick"; check.appendChild(tick);
      check.addEventListener("click", function (e) { e.stopPropagation(); toggleCategory(); });
      tile.appendChild(check);
      var open = document.createElement("span"); open.className = "rh-open";
      open.title = plain ? c.label : c.label + " — variations";
      var glyph = rhythmGlyph(c.key);
      var art = document.createElement("span"); art.className = "rh-art";
      if (glyph) art.appendChild(glyph); else art.textContent = c.label;   // notation, text fallback
      open.appendChild(art);
      var cap = document.createElement("span"); cap.className = "rh-cap"; cap.textContent = c.label;
      open.appendChild(cap);
      open.addEventListener("click", function () {
        // BUG (Anthony, 2026-07-31): this handler opened the real variations picker for a LOCKED tile
        // without ever checking `locked` — only the checkbox half was gated, so tapping the notation/name
        // half of the tile bypassed the paywall entirely. Must be checked first, same as toggleCategory().
        if (locked) { lockedUpsell(); return; }
        if (plain) toggleCategory();               // no popup for this category in this meter → just toggle
        else openVariantPicker(c.key, c.label);
      });
      tile.appendChild(open);
      els.rhythmGrid.appendChild(tile);
    });
    refreshHFades();   // tile set changed → recompute the left/right edge fade
  }

  // Re-render the picker WITHOUT losing your scroll position. renderPickerList clears the list's innerHTML,
  // which makes the browser clamp the scroll container to the top; a toggle only flips active states (the
  // tile count is unchanged), so we can capture the scroll offset and put it right back afterwards. Used by
  // every in-picker toggle (footer quick-selects + individual tiles) so clicking one no longer yanks you
  // back to the top of the list (Anthony, 2026-07-19). Fresh opens + search deliberately DON'T use this, so
  // they still start at the top.
  function rerenderKeepScroll() {
    var wrap = els.pickerList.parentElement;   // .modal__listwrap is the scroll container
    var y = wrap ? wrap.scrollTop : 0;
    renderPickerList(els.pickerSearch.value);
    if (wrap) wrap.scrollTop = y;
  }
  function renderPickerList(filter) {
    var q = (filter || "").trim().toLowerCase();
    els.pickerList.innerHTML = "";
    els.pickerList.classList.toggle("modal__list--twocol", activePicker === "timesig");
    els.pickerList.classList.toggle("modal__list--rhythms", activePicker === "variants");

    // sticky bottom panel of quick-toggle buttons — populated per picker below; stays hidden if none added
    els.pickerQuick.innerHTML = "";
    els.pickerFoot.hidden = true;
    function quickBtn(label, active, onClick, locked) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rh-quick" + (active ? " active" : "") + (locked ? " rh-quick--locked" : "");
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      els.pickerQuick.appendChild(btn);
      els.pickerFoot.hidden = false;
    }

    if (activePicker === "variants") {
      var ctx = meterContext();
      var vars = (G.VARIANTS[variantCat] || []).slice();
      var noteCount = function (v) { return v.notes.filter(function (n) { return n.kind !== "rest"; }).length; };
      /* dotted 8ths come in two independent shapes — a group of 4 (3 beats) and a group of 2 (1.5 beats).
         noteCount alone can't tell them apart (a 4-group with two rests also counts 2), so the popup
         splits on the GROUP SIZE in the id: dotted8_<size>_<bits>. */
      var groupSize = function (v) { var m = /^dotted8_(\d+)_/.exec(v.id); return m ? +m[1] : 0; };

      // meter-context filters (old-app rules)
      if (variantCat === "q") vars = vars.filter(function (v) { return v._isCompoundVariant; });   // q only has variations in compound pulse
      else if (ctx.simple && !ctx.compound) vars = vars.filter(function (v) { return !v._isCompoundVariant; });
      else if (!ctx.simple && ctx.compound) {
        var ISLAND = { "8t": 1, "5let16": 1, "6let": 1 };   // 1-beat tuplets still fit a compound pulse
        if (!ISLAND[variantCat]) vars = vars.filter(function (v) { return v._isCompoundVariant; });
      }

      // never leave this category with ZERO variations active IN THE CURRENT METER — snap back to just the
      // visible Full variation(s). Runs on the METER-filtered list (NOT the whole bank) because the popup's
      // own "All" toggle only turns off the meter-VISIBLE variants: in a simple meter a hidden COMPOUND
      // full (8s_c_111, cmp_6let_111111) could stay active, so the old whole-bank check thought "something's
      // still on" while the popup showed nothing checked AND generation produced nothing (that hidden full
      // can't play in a simple meter). 8th/16th notes were the visible casualties. Checked before the search
      // filter so typing in the box never triggers a restore. (Anthony, 2026-07-16 — round 2.)
      if (vars.length && !vars.some(function (v) { return G.active.has(v.id); })) {
        var visFull = vars.filter(function (v) { return (G.FULL_IDS || []).indexOf(v.id) !== -1; });
        (visFull.length ? visFull : [vars[0]]).forEach(function (v) { G.active.add(v.id); });
      }

      if (q) vars = vars.filter(function (v) { return (v.label || v.id).toLowerCase().indexOf(q) !== -1; });

      // simple before compound, then denser groupings first.
      // dotted 8ths sort by GROUP SIZE first so the 4-note set is the whole top half and the 2-note set
      // the bottom half — they never interleave.
      vars.sort(function (a, b) {
        var ca = !!a._isCompoundVariant, cb = !!b._isCompoundVariant;
        if (ca !== cb) return ca ? 1 : -1;
        var ga = groupSize(a), gb = groupSize(b);
        if (ga !== gb) return gb - ga;
        return noteCount(b) - noteCount(a);
      });

      // quick-action buttons (in the sticky bottom panel) — toggleSelection semantics, writing straight
      // through to the live Set. Each button shows "active" when every variant it targets is already on.
      var qbtn = function (label, pred) {
        var matching = vars.filter(pred);
        var allOn = matching.length > 0 && matching.every(function (v) { return G.active.has(v.id); });
        quickBtn(label, allOn, function () {
          if (!matching.length) return;
          matching.forEach(function (v) { if (allOn) G.active.delete(v.id); else G.active.add(v.id); });
          rerenderKeepScroll();
        });
      };
      qbtn("All", function () { return true; });
      var counts = [];
      vars.forEach(function (v) { var c = noteCount(v); if (counts.indexOf(c) === -1) counts.push(c); });
      counts.sort(function (a, b) { return b - a; });
      var hasS = vars.some(function (v) { return !v._isCompoundVariant; });
      var hasC = vars.some(function (v) { return v._isCompoundVariant; });
      if (hasS && hasC) {
        counts.forEach(function (c) {
          if (vars.some(function (v) { return !v._isCompoundVariant && noteCount(v) === c; }))
            qbtn("Simple " + c, function (v) { return !v._isCompoundVariant && noteCount(v) === c; });
        });
        counts.forEach(function (c) {
          if (vars.some(function (v) { return v._isCompoundVariant && noteCount(v) === c; }))
            qbtn("Comp " + c, function (v) { return v._isCompoundVariant && noteCount(v) === c; });
        });
      } else if (variantCat === "dotted8") {
        // scope the quick buttons to a section too — "2 Note" is ambiguous across the two group sizes
        [4, 2].forEach(function (g) {
          if (vars.some(function (v) { return groupSize(v) === g; }))
            qbtn("All " + g + "s", function (v) { return groupSize(v) === g; });
        });
      } else {
        counts.forEach(function (c) { qbtn(c + " Note", function (v) { return noteCount(v) === c; }); });
      }

      // grouped variation tiles ("Super|||Sub" headers, old format).
      // Only label the Simple/Compound PULSE when BOTH pulses are actually on the table (both a simple
      // AND a compound meter selected, or an asymmetric meter). With only one pulse world the label is
      // redundant, so we drop it and just show the "N Note Grouping" sub-headers.
      var showPulse = hasS && hasC;
      var groupOf = function (v) {
        if (variantCat === "dotted8" && groupSize(v))
          return DOTTED8_SECTION[groupSize(v)] + "|||" + noteCount(v) + " Note Grouping";
        if (showPulse && (variantCat === "8s" || variantCat === "16s"))
          return (v._isCompoundVariant ? "Compound Pulse" : "Simple Pulse") + "|||" + noteCount(v) + " Note Grouping";
        if (showPulse && variantCat === "q") return "Compound Pulse|||" + noteCount(v) + " Note Grouping";
        return noteCount(v) + " Note Grouping";
      };
      var lastSuper = null, lastSub = null;
      vars.forEach(function (v) {
        var parts = groupOf(v).split("|||");
        var main = parts.length > 1 ? parts[0] : null;
        var sub = parts.length > 1 ? parts[1] : parts[0];
        if (main && main !== lastSuper) { els.pickerList.appendChild(grouphdrMain(main)); lastSuper = main; lastSub = null; }
        if (sub !== lastSub) { els.pickerList.appendChild(grouphdr(sub)); lastSub = sub; }

        var on = G.active.has(v.id);
        var tile = document.createElement("li");
        tile.setAttribute("role", "option");
        tile.setAttribute("aria-selected", on ? "true" : "false");
        tile.className = "rh-tile" + (on ? " active" : "");
        tile.title = v.label || v.id;
        function toggleVariant() {
          if (G.active.has(v.id)) G.active.delete(v.id); else G.active.add(v.id);
          rerenderKeepScroll();
        }
        // same two-half layout as the panel tiles: left check + right notation (both toggle here —
        // a variant has no nested popup, so the whole tile toggles it)
        var check = document.createElement("span"); check.className = "rh-check";
        var tick = document.createElement("span"); tick.className = "tick"; check.appendChild(tick);
        check.addEventListener("click", function (e) { e.stopPropagation(); toggleVariant(); });
        tile.appendChild(check);
        var open = document.createElement("span"); open.className = "rh-open";
        var art = document.createElement("span"); art.className = "rh-art";
        var glyph = variantGlyph(v);
        if (glyph) art.appendChild(glyph); else art.textContent = v.label || v.id;
        open.appendChild(art);
        open.addEventListener("click", toggleVariant);
        tile.appendChild(open);
        els.pickerList.appendChild(tile);
      });
      return;
    }

    if (activePicker === "timesig") {
      var groups = {};
      G.TIME_SIGS.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
      // sticky bottom panel: an "All" toggle, then one toggle per group (Simple / Compound /
      // Asymmetric) that selects or clears the whole group at once. "active" = every meter it
      // targets is currently selected.
      // FREEMIUM: All / Simple / Compound / Asymmetric may only ever reach the meters this account has.
      var allMeters = G.TIME_SIGS.map(function (t) { return t.value; }).filter(function (v) { return !sigLocked(v); });
      var everyOn = allMeters.length && allMeters.every(function (v) { return settings.timeSigs.indexOf(v) !== -1; });
      quickBtn("All", everyOn, function () {
        // First click selects every meter; clicking again (when all are already on) collapses back to just
        // 4/4 — the universal default (Anthony, 2026-07-20). It's a two-state toggle: all ⇄ 4/4, never 0.
        if (everyOn) settings.timeSigs = ["4/4"];
        else allMeters.forEach(function (v) { if (settings.timeSigs.indexOf(v) === -1) settings.timeSigs.push(v); });
        rerenderKeepScroll();
        updateSettingLabels();
      });
      ["Simple", "Compound", "Asymmetric"].forEach(function (grp) {
        var members = (groups[grp] || []).map(function (t) { return t.value; }).filter(function (v) { return !sigLocked(v); });
        if (!members.length) {
          // the group exists but every meter in it is locked → a locked quick-select that upsells
          if (!PAID && (groups[grp] || []).length) {
            quickBtn(grp, false, function () {
              upsell("Unlock " + grp + " meters", METER_LOCK_MSG);
            }, true);
          }
          return;
        }
        var allOn = members.every(function (v) { return settings.timeSigs.indexOf(v) !== -1; });
        quickBtn(grp, allOn, function () {
          if (allOn) {
            var remaining = settings.timeSigs.filter(function (v) { return members.indexOf(v) === -1; });
            if (remaining.length) settings.timeSigs = remaining;   // else refuse (keep ≥1 meter selected)
          } else {
            members.forEach(function (v) { if (settings.timeSigs.indexOf(v) === -1) settings.timeSigs.push(v); });
          }
          rerenderKeepScroll();
          updateSettingLabels();
        });
      });
      Object.keys(groups).forEach(function (g) {
        var items = groups[g].filter(function (t) { return !q || t.label.toLowerCase().indexOf(q) !== -1; });
        if (!items.length) return;
        els.pickerList.appendChild(grouphdr(g));
        items.forEach(function (t) {
          var on = settings.timeSigs.indexOf(t.value) !== -1;
          var locked = sigLocked(t.value);
          var row = document.createElement("li");
          row.setAttribute("role", "option");
          row.className = "modal__opt--timesig" + (on ? " active" : "") + (locked ? " modal__opt--locked" : "");
          var tick = document.createElement("span");
          tick.className = "tick";
          row.appendChild(tick);
          var glyph = timeSigGlyph(t.value);
          if (glyph) row.appendChild(glyph); else row.appendChild(document.createTextNode(t.label));   // text fallback if render fails
          row.addEventListener("click", function () {
            if (locked) { upsell("Unlock " + t.label, METER_LOCK_MSG); return; }
            var i = settings.timeSigs.indexOf(t.value);
            if (i !== -1) { if (settings.timeSigs.length > 1) settings.timeSigs.splice(i, 1); }   // keep ≥1
            else settings.timeSigs.push(t.value);
            rerenderKeepScroll();
            updateSettingLabels();
          });
          els.pickerList.appendChild(row);
        });
      });
      return;
    }

    if (activePicker === "sticking") {
      G.STICKINGS.forEach(function (s) {
        if (q && s.label.toLowerCase().indexOf(q) === -1) return;
        var row = li(s.label, { on: settings.sticking === s.value });
        row.addEventListener("click", function () {
          settings.sticking = s.value;
          updateSettingLabels();
          closePicker();       // single-select: choosing closes the popup…
          restyleCurrent();    // …and restyles the current sheet live
        });
        els.pickerList.appendChild(row);
      });
      return;
    }
  }

  function updateSettingLabels() {
    // time sigs — show the REAL staff glyphs on the button (same builder as the picker); >3 = text
    var lbl = els.timeSigBtn.querySelector(".lbl");
    lbl.innerHTML = "";
    if (settings.timeSigs.length > 3) {
      lbl.textContent = "Mixed (" + settings.timeSigs.length + ")";
    } else {
      settings.timeSigs.forEach(function (v) {
        var g = timeSigGlyph(v);
        if (g) lbl.appendChild(g);
        else lbl.appendChild(document.createTextNode(v === "9/8_asym" ? "9/8*" : v));
      });
    }
    // sticking (always shows the chosen PATTERN — the ON/OFF toggle handles visibility)
    var s = G.STICKINGS.filter(function (x) { return x.value === settings.sticking; })[0];
    els.stickingBtn.querySelector(".lbl").textContent = s ? s.label : "Natural";
    // the mobile reflow (index.html) overwrites these buttons with its own compact icons — re-apply them
    // now, else this desktop-oriented text/glyph output would clobber the mobile icon on every pick.
    if (window.__srMobileRefresh) window.__srMobileRefresh();
  }

  els.timeSigBtn.addEventListener("click", function () { openPicker("timesig", "Time Signatures"); });
  els.stickingBtn.addEventListener("click", function () { openPicker("sticking", "Sticking"); });
  els.pickerClose.addEventListener("click", closePicker);
  els.pickerSearch.addEventListener("input", function () { renderPickerList(els.pickerSearch.value); });
  els.pickerEl.addEventListener("pointerdown", function (e) { if (e.target === els.pickerEl) closePicker(); });

  /* ---------- keyboard shortcuts popup ---------- */
  function openKbd() {
    els.kbdHelp.hidden = false;
    els.kbdHelp.classList.remove("is-closing");
    void els.kbdHelp.offsetWidth;
    els.kbdHelp.classList.add("is-open");
  }
  function closeKbd() {
    if (els.kbdHelp.hidden || els.kbdHelp.classList.contains("is-closing")) return;
    els.kbdHelp.classList.remove("is-open");
    els.kbdHelp.classList.add("is-closing");
    var panel = els.kbdHelp.querySelector(".kbdhelp__panel");
    var finish = function () {
      if (!els.kbdHelp.classList.contains("is-closing")) { cleanup(); return; }
      els.kbdHelp.hidden = true; els.kbdHelp.classList.remove("is-closing"); cleanup();
    };
    function cleanup() { if (panel) panel.removeEventListener("animationend", finish); }
    if (panel) panel.addEventListener("animationend", finish);
    setTimeout(finish, 280);
  }
  function kbdOpen() { return !els.kbdHelp.hidden && !els.kbdHelp.classList.contains("is-closing"); }
  if (els.kbdBtn) els.kbdBtn.addEventListener("click", function () { kbdOpen() ? closeKbd() : openKbd(); });   // toggle: click again to close
  if (els.kbdHelpClose) els.kbdHelpClose.addEventListener("click", closeKbd);
  if (els.kbdHelp) els.kbdHelp.addEventListener("click", function (e) { if (e.target === els.kbdHelp) closeKbd(); });

  /* ---------- loop selection + click-to-seek on the music (ported from Playalongs) ----------
     Drag across notes (or Shift-click a 2nd note) = choose a loop span; the engine repeats just those
     bars. A plain click (no drag) = seek to that spot. On touch: tap = seek, long-press a 2nd note =
     loop from the reference note to it, then drag to slide the endpoint. #score has user-select:none in
     CSS so a drag reads as a clean selection gesture, not a text highlight. */
  function scoreXY(clientX, clientY) {
    if (!player.out) return null;
    var svg = els.score.querySelector("svg");
    if (!svg) return null;
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    var scale = player.out.width / rect.width;      // SVG units per rendered pixel
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }
  (function () {
    var downA = null, downX = 0, downY = 0, dragging = false, lastA = null, capId = null, downShift = false;
    var selAnchor = null;                    // the note most recently tapped → the region's reference endpoint
    var isTouch = false, lpTimer = null, regionMode = false;
    var LONGPRESS_MS = 380, MOVE_CANCEL2 = 144;   // (>12px)^2 of travel before the long-press → it's a scroll
    function anchorAt(clientX, clientY) {
      var pt = scoreXY(clientX, clientY);
      return pt ? player.anchorIndexAtXY(pt.x, pt.y) : null;
    }
    function clearLP() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    function armRegion() {                   // long-press fired → enter region-adjust mode
      lpTimer = null; regionMode = true;
      if (selAnchor == null) selAnchor = downA;
      try { els.score.setPointerCapture(capId); } catch (e) {}
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
      lastA = downA;
      player.drawLoopPreview(selAnchor, downA);
    }
    function cancelGesture() {
      clearLP();
      if (capId != null) { try { els.score.releasePointerCapture(capId); } catch (e) {} capId = null; }
      downA = null; dragging = false; regionMode = false;
    }
    els.score.addEventListener("pointerdown", function (e) {
      if (!player.anchors || !player.anchors.length) return;
      if (downA != null) return;                            // already tracking a finger — ignore extra pointers
      isTouch = (e.pointerType === "touch");
      if (!isTouch && e.button !== 0) return;
      downA = anchorAt(e.clientX, e.clientY);
      downX = e.clientX; downY = e.clientY; dragging = false; lastA = downA; downShift = e.shiftKey; regionMode = false;
      if (downA == null) return;
      capId = e.pointerId;
      if (isTouch) { clearLP(); lpTimer = setTimeout(armRegion, LONGPRESS_MS); }
      else { try { els.score.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    els.score.addEventListener("pointermove", function (e) {
      if (downA == null) return;
      var dx = e.clientX - downX, dy = e.clientY - downY;
      if (isTouch) {
        if (!regionMode) { if (dx * dx + dy * dy > MOVE_CANCEL2) cancelGesture(); return; }
        var a = anchorAt(e.clientX, e.clientY);
        if (a != null) { lastA = a; player.drawLoopPreview(selAnchor, a); }
        return;
      }
      if (!dragging && dx * dx + dy * dy > 36) dragging = true;   // mouse: >6px → drag-select
      if (dragging) { var a2 = anchorAt(e.clientX, e.clientY); if (a2 != null) { lastA = a2; player.drawLoopPreview(downA, lastA); } }
    });
    els.score.addEventListener("touchmove", function (e) { if (regionMode) e.preventDefault(); }, { passive: false });
    els.score.addEventListener("touchstart", function (e) { if (e.touches.length >= 2) cancelGesture(); }, { passive: true });
    function finish(e, commit) {
      clearLP();
      if (capId != null) { try { els.score.releasePointerCapture(capId); } catch (err) {} capId = null; }
      if (downA == null) { regionMode = false; return; }
      var startA = downA; downA = null;
      var didRegion = regionMode; regionMode = false;
      if (isTouch) {
        if (didRegion && commit) {                          // long-press (+drag) → commit the loop span
          var endA = anchorAt(e.clientX, e.clientY); if (endA == null) endA = lastA;
          player.setLoopAnchors(selAnchor, endA); selAnchor = Math.min(selAnchor, endA);
        } else if (!didRegion && commit && !dragging) {     // plain tap → seek + set the reference note
          player.clearLoop(); player.seek(player.anchors[startA].beat / player.totalBeats); selAnchor = startA;
        } else { player._drawSelection(); }
      } else {
        if (dragging && commit) {                           // mouse drag → loop the dragged span
          var endA2 = anchorAt(e.clientX, e.clientY); if (endA2 == null) endA2 = lastA;
          player.setLoopAnchors(startA, endA2); selAnchor = Math.min(startA, endA2);
        } else if (!dragging && commit) {
          if ((downShift || e.shiftKey) && selAnchor != null) { player.setLoopAnchors(selAnchor, startA); selAnchor = Math.min(selAnchor, startA); }
          else { player.clearLoop(); player.seek(player.anchors[startA].beat / player.totalBeats); selAnchor = startA; }
        } else { player._drawSelection(); }
      }
      dragging = false;
    }
    els.score.addEventListener("pointerup", function (e) { finish(e, true); });
    els.score.addEventListener("pointercancel", function (e) { finish(e, false); });
  })();

  /* ---------- Loop Section panel (From/To bar) ----------
     Mirrors the on-staff drag selection. Steppers / number inputs set the bar range; Clear drops it.
     Staff and panel stay in lockstep via onLoopRange -> syncLoopPanel. */
  function loopBarCount() { return (player.getMeasures && player.getMeasures().length) || 0; }
  function clampInt(v, lo, hi, def) { v = parseInt(v, 10); if (isNaN(v)) v = (def != null ? def : lo); return Math.max(lo, Math.min(hi, v)); }
  function barOfMeasure(mi) { return mi + 1; }                    // instance index -> displayed bar #
  function measureOfBar(bar) { return Math.max(0, Math.min(loopBarCount() - 1, bar - 1)); }
  function maxBar() { return loopBarCount(); }
  function loopVals(mx) {
    var from = clampInt(els.loopFrom.value, 1, mx, 1);
    var to = clampInt(els.loopTo.value, 1, mx, mx);
    return { from: from, to: to };
  }
  function refreshClearBtn() { els.loopClearBtn.disabled = !player.hasLoop(); }
  function syncLoopPanel(info) {
    if (info) { els.loopFrom.value = barOfMeasure(info.m0); els.loopTo.value = barOfMeasure(info.m1); }
    else { els.loopFrom.value = ""; els.loopTo.value = ""; }   // no loop -> placeholders show the defaults
    refreshClearBtn();
  }
  function refreshLoopPanel() {
    var mx = maxBar(), usable = mx > 0;
    [els.loopFrom, els.loopTo, els.loopFromDown, els.loopFromUp, els.loopToDown, els.loopToUp]
      .forEach(function (el) { if (el) el.disabled = !usable; });
    if (els.loopPanel) els.loopPanel.style.opacity = usable ? "" : ".55";
    els.loopFrom.placeholder = "1";
    els.loopTo.placeholder = mx || "1";
    if (!player.hasLoop()) { els.loopFrom.value = ""; els.loopTo.value = ""; }
    refreshClearBtn();
  }
  function applyLoopFromInputs() {
    var mx = maxBar(); if (!mx) return;
    var v = loopVals(mx), from = v.from, to = v.to;
    if (from > to) { var t = from; from = to; to = t; }
    if (from === 1 && to === mx) { player.clearLoop(); return; }    // whole piece = no loop
    player.setLoopMeasures(measureOfBar(from), measureOfBar(to));   // fires onLoopRange -> syncLoopPanel
  }
  function nudgeLoop(which, delta) {
    var mx = maxBar(); if (!mx) return;
    var v = loopVals(mx), from = v.from, to = v.to;
    if (which === "from") { from = clampInt(from + delta, 1, mx); if (from > to) to = from; }
    else { to = clampInt(to + delta, 1, mx); if (to < from) from = to; }
    if (from === 1 && to === mx) { player.clearLoop(); return; }
    player.setLoopMeasures(measureOfBar(from), measureOfBar(to));
  }
  els.loopClearBtn.addEventListener("click", function () { player.clearLoop(); });
  els.loopFromDown.addEventListener("click", function () { nudgeLoop("from", -1); });
  els.loopFromUp.addEventListener("click", function () { nudgeLoop("from", 1); });
  els.loopToDown.addEventListener("click", function () { nudgeLoop("to", -1); });
  els.loopToUp.addEventListener("click", function () { nudgeLoop("to", 1); });
  function onLoopInputChange() { if (loopBarCount()) applyLoopFromInputs(); }
  els.loopFrom.addEventListener("change", onLoopInputChange);
  els.loopTo.addEventListener("change", onLoopInputChange);

  /* ---------- Loop > Count-off ----------
     Student request (2026-07-26): hear a count-off before the looped section starts, and again before
     every repeat. The engine owns the behavior (player.setLoopCountOff) and plays a clean stick-click cue
     — never counted toward "notes played", never disturbing the beat clock or the loop bounds.
     DEFAULT ON as of 2026-07-31, matching Playalongs: it now also arms for a plain top-to-bottom play of
     a generated sheet, not just a sub-section loop, so a student always gets counted in. The switch
     stays — only the resting state changed. Remembered per browser, stored as "was it explicitly turned
     OFF" so a browser that never touched this defaults to ON. */
  var CO_KEY = "rdm_sr_loop_countoff";
  var CO_BEATS_KEY = "rdm_sr_loop_countoff_beats";
  if (els.loopCountOff) {
    var coSaved = true;
    try { coSaved = localStorage.getItem(CO_KEY) !== "0"; } catch (e) {}
    els.loopCountOff.checked = coSaved;
    if (player.setLoopCountOff) player.setLoopCountOff(coSaved);
    els.loopCountOff.addEventListener("change", function () {
      var on = !!els.loopCountOff.checked;
      if (player.setLoopCountOff) player.setLoopCountOff(on);
      try { localStorage.setItem(CO_KEY, on ? "1" : "0"); } catch (e) {}
    });
    /* Count-off LENGTH: 4 beats (default, unchecked) or 2. Same persistence pattern as the switch above,
       stored as the literal beat count rather than a boolean so the value stays readable. */
    if (els.loopCountOffBeats) {
      var cobSaved = 4;
      try { cobSaved = localStorage.getItem(CO_BEATS_KEY) === "2" ? 2 : 4; } catch (e) {}
      els.loopCountOffBeats.checked = cobSaved === 2;
      if (player.setCountOffBeats) player.setCountOffBeats(cobSaved);
      els.loopCountOffBeats.addEventListener("change", function () {
        var n = els.loopCountOffBeats.checked ? 2 : 4;
        if (player.setCountOffBeats) player.setCountOffBeats(n);
        try { localStorage.setItem(CO_BEATS_KEY, String(n)); } catch (e) {}
      });
    }
    // Mobile: mobile.js hides this panel's desktop .sr-bar and rebuilds the tab as an icon row plus a
    // "Loop ▾" flyout holding the From/To steppers. Ride into that flyout (and back out on desktop) so
    // the switch is reachable on a phone. Watching the panel rather than hooking mobile.js keeps this
    // correct whatever order the two scripts run in, and self-heals if the reflow rebuilds.
    (function () {
      // BOTH count-off fields ride together — the on/off switch and the 4/2 length beside it. Moving
      // only the first would strand the length control in the hidden desktop row on a phone.
      var fields = [els.loopCountOff, els.loopCountOffBeats]
        .filter(Boolean)
        .map(function (el) { return el.closest(".field"); })
        .filter(Boolean);
      var panel = els.loopPanel;
      if (!fields.length || !panel || typeof MutationObserver !== "function") return;
      var homeRow = panel.querySelector(".sr-bar");
      function place() {
        var det = panel.querySelector('.paneldetail[data-detail="loopset"]');
        fields.forEach(function (field) {
          if (det) { if (field.parentNode !== det) det.appendChild(field); }
          else if (homeRow && field.parentNode !== homeRow) homeRow.appendChild(field);
        });
      }
      new MutationObserver(place).observe(panel, { childList: true, subtree: true });
      place();
    })();
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", function (e) {
    if (!els.kbdHelp.hidden) { if (e.key === "Escape" || e.key === "/" || e.key === "?") { e.preventDefault(); closeKbd(); } return; }
    if (!els.pickerEl.hidden) { if (e.key === "Escape") closePicker(); return; }
    // from a shadow root the document keydown's e.target retargets to the host, so read the tool's OWN
    // focused element (root.activeElement) to detect typing; falls back to e.target when standalone.
    var focused = root.activeElement || e.target;
    var tag = (focused && focused.tagName || "").toLowerCase();
    /* A SLIDER left focused after a drag must not swallow Space, or (worse) sit there and let the
       browser flip on its focus ring right as you press it — dragging alone never shows the ring
       (pointer focus suppresses :focus-visible), but a keypress on an already-focused element makes
       the browser reconsider, and THAT'S the highlight this fixes. Anthony, 2026-08-02: "when i move
       the slider thumb... and then immediately press space, it doesnt play, but instead highlights
       the tempo bar... that shouldnt be happening for ANY slider." Blur it and fall through to the
       transport toggle below — every other key is left alone, so arrow-key slider nudging still works.
       This covers the standalone page; ToolMount.jsx's shadow-root guard covers the embedded app. */
    if (tag === "input" && focused.type === "range" && (e.key === " " || e.code === "Space" || e.key === "Spacebar")) { focused.blur(); }
    else if (tag === "input" || tag === "textarea" || tag === "select" || (focused && focused.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey) return;   // let browser combos through (Ctrl/Cmd+R refresh, etc.)
    var k = e.key;
    if (k === "Escape") { if (player.hasLoop && player.hasLoop()) { e.preventDefault(); player.clearLoop(); } return; }
    if (k === " " || e.code === "Space" || k.toLowerCase() === "k") { e.preventDefault(); player.toggle(); }
    else if (k.toLowerCase() === "r" || k === "Enter") { e.preventDefault(); generateNew(); }
    else if (k.toLowerCase() === "u") { e.preventDefault(); histStep(-1); }
    else if (k === "Backspace") { e.preventDefault(); player.rewind(); }
    else if (k === "ArrowUp" || k === "ArrowRight") { e.preventDefault(); player.nudgeTempo(e.shiftKey ? 5 : 1); }
    else if (k === "ArrowDown" || k === "ArrowLeft") { e.preventDefault(); player.nudgeTempo(e.shiftKey ? -5 : -1); }
    else if (k.toLowerCase() === "j") { player.seekMeasure(-1); }
    else if (k.toLowerCase() === "l") { player.seekMeasure(1); }
    else if (k.toLowerCase() === "t") { tapTempo(); }
    else if (k.toLowerCase() === "m") { setMetro(!metroOn); }
    // zoom + tab-switch: match Playalongs' shortcuts exactly (Anthony, 2026-07-16 — "identical controls
    // should be identical"). Only 4 tabs here (vs Playalongs' 5), so 1-4 not 1-5.
    else if (k === "+" || k === "=") { e.preventDefault(); els.sizeUp.click(); }
    else if (k === "-" || k === "_") { e.preventDefault(); els.sizeDown.click(); }
    else if (k === "0") { e.preventDefault(); els.sizeVal.click(); }
    else if (k >= "1" && k <= "5") { e.preventDefault(); selectTab(TAB_ORDER[+k - 1]); }
    else if (k === "?" || k === "/") { e.preventDefault(); openKbd(); }   // "/" needs no Shift (matches Playalongs)
  });

  /* ---------- keyboard-aware viewport (--vvh/--vvo, same as Playalongs) ---------- */
  (function () {
    var vv = window.visualViewport; if (!vv) return;
    var root = document.documentElement, raf = 0;
    function sync() {
      raf = 0;
      var h = Math.round(vv.height);
      // a not-yet-laid-out viewport can report ~0 — never write that (the shell would collapse);
      // the 100dvh fallback holds until a real height arrives
      if (h < 200) return;
      root.style.setProperty("--vvh", h + "px");
      root.style.setProperty("--vvo", Math.round(vv.offsetTop) + "px");
    }
    function onVV() { if (!raf) raf = requestAnimationFrame(sync); }
    vv.addEventListener("resize", onVV);
    vv.addEventListener("scroll", onVV);
    window.addEventListener("resize", onVV);   // backup: some embedded viewports only fire window resize
    sync();
  })();

  window.addEventListener("resize", function () {
    measureStableRenderW();
    if (player.relayout && currentScore()) player.relayout();
    fitScrollbar();
  });

  window.__player = player;   // debug handle (harmless; same pattern used while building the suite)
  window.__srSettings = settings;   // read-only handle so the mobile reflow (index.html) can render live icons

  /* ---------- presets: save/load the whole settings bundle to your account ---------- */
  var userPresets = (ctx.presets && ctx.presets.initial ? ctx.presets.initial : []).slice();

  // Guarantee a unique preset name: if "Name" is taken, save "Name 2", then "Name 3", … (case-insensitive
  // so "warmup" and "Warmup" still count as the same). No two presets can ever share a name.
  function uniquePresetName(base, list) {
    var taken = {};
    (list || []).forEach(function (p) { if (p && p.name) taken[String(p.name).trim().toLowerCase()] = 1; });
    if (!taken[base.toLowerCase()]) return base;
    var n = 2;
    while (taken[(base + " " + n).toLowerCase()]) n++;
    return base + " " + n;
  }

  function capturePreset() {
    readMeasuresInput();
    return {
      timeSigs: settings.timeSigs.slice(),
      cats: Object.assign({}, settings.cats),
      sticking: settings.sticking, stickingOn: settings.stickingOn, leadHand: settings.leadHand,
      measures: settings.measures, restPct: settings.restPct, variety: settings.variety,
      subdiv: settings.subdiv, sparsity: settings.sparsity,
      syncopation: settings.syncopation, showCounts: settings.showCounts,
      tempo: Math.round(player.tempo / player.beatUnitMult()),
      ornaments: Object.assign({}, settings.ornaments),
      variants: (G.active ? Array.from(G.active) : [])
    };
  }
  function applyPreset(s) {
    if (!s) return;
    settings.timeSigs = (s.timeSigs || ["4/4"]).slice();
    if (s.cats) settings.cats = Object.assign({}, s.cats);
    settings.sticking = s.sticking || "natural";
    settings.stickingOn = s.stickingOn !== false;
    settings.leadHand = s.leadHand || "R";
    settings.measures = s.measures || 4;
    settings.restPct = s.restPct != null ? s.restPct : 0;
    settings.subdiv  = s.subdiv  != null ? s.subdiv  : 50;
    settings.sparsity = s.sparsity != null ? s.sparsity : 50;
    settings.variety = s.variety != null ? s.variety : 100;
    settings.syncopation = !!s.syncopation;
    settings.showCounts = s.showCounts !== false;
    settings.tempo = s.tempo || 100;
    settings.ornaments = Object.assign({ accent: 0, flam: 0, diddle: 0, buzz: 0 }, s.ornaments || {});
    /* FREEMIUM: presets are a paid feature, so this normally can't run on a free account — but a preset
       saved while paid must not survive a downgrade as a back door into locked rhythms or ornaments. */
    if (!PAID) {
      G.CATEGORIES.forEach(function (c) { if (catLocked(c.key)) settings.cats[c.key] = false; });
      if (!G.CATEGORIES.some(function (c) { return settings.cats[c.key]; })) settings.cats.q = true;
      settings.ornaments = { accent: 0, flam: 0, diddle: 0, buzz: 0 };
      clampSigs();
    }
    if (s.variants && G.active) { G.active.clear(); s.variants.forEach(function (id) { G.active.add(id); }); }
    // repaint every control from settings
    els.measInput.value = settings.measures;
    els.restsSlider.value = settings.restPct; paintRests();
    if (els.varietySlider) { els.varietySlider.value = settings.variety; paintVariety(); }
    if (els.subdivSlider) { els.subdivSlider.value = settings.subdiv; paintSubdiv(); }
    if (els.sparsitySlider) { els.sparsitySlider.value = settings.sparsity; paintSparsity(); }
    els.countsToggle.checked = settings.showCounts;
    els.syncToggle.checked = settings.syncopation;
    els.stickingToggle.checked = settings.stickingOn !== false;
    els.leadHandToggle.checked = settings.leadHand === "L";
    ORN.forEach(function (o) { o.slider.value = settings.ornaments[o.key] || 0; paintOrn(o); });
    updateSettingLabels();
    renderRhythmGrid();
    markTabDots();
    everGenerated = false;    // next generate starts from settings.tempo (don't carry the live tempo forward)
    generateNew();
  }
  // Compact presets panel: a label, then the Save button with saved presets as chips flowing to its
  // right (matches the Loop/Ornaments panel height: one label row + one 46px control row).
  function renderPresetsPanel() {
    var host = root.getElementById("srPresets");
    if (!host) return;
    host.innerHTML = "";
    var lbl = document.createElement("label");
    lbl.className = "sr-presets-lbl"; lbl.textContent = "Your setups";
    host.appendChild(lbl);
    var row = document.createElement("div"); row.className = "sr-presets-row";
    var save = document.createElement("button");
    save.type = "button"; save.className = "sr-preset-save"; save.textContent = "＋ Save current settings";
    save.addEventListener("click", function () {
      RDMDialogs.name(root, { title: "Name this preset", value: "My Preset", theme: "theme-purple" }).then(function (name) {
        name = (name || "").trim();
        if (!name) return;
        name = uniquePresetName(name, userPresets);   // no two presets share a name — auto-number dupes
        Promise.resolve(ctx.presets.create(name, capturePreset())).then(function (p) {
          userPresets.push(p); renderPresetsPanel();
        }).catch(function (e) { RDMDialogs.alert(root, { title: "Couldn't save", message: "Couldn't save the preset. " + ((e && e.message) || ""), theme: "theme-purple" }); });
      });
    });
    row.appendChild(save);
    userPresets.forEach(function (p) {
      var chip = document.createElement("span"); chip.className = "sr-preset-chip";
      var load = document.createElement("button");
      load.type = "button"; load.className = "spc-load"; load.textContent = p.name; load.title = "Load this preset";
      load.addEventListener("click", function () { applyPreset(p.settings); });
      var del = document.createElement("button");
      del.type = "button"; del.className = "spc-del"; del.setAttribute("aria-label", "Delete preset"); del.textContent = "×";
      del.addEventListener("click", function () {
        RDMDialogs.confirm(root, { title: "Delete preset?", message: 'Delete the preset "' + p.name + '"?', theme: "theme-purple" }).then(function (ok) {
          if (!ok) return;
          ctx.presets.remove(p.id);
          var i = userPresets.indexOf(p); if (i >= 0) userPresets.splice(i, 1);
          renderPresetsPanel();
        });
      });
      chip.appendChild(load); chip.appendChild(del);
      row.appendChild(chip);
    });
    host.appendChild(row);
  }

  /* ---------- boot: generate the first sheet ---------- */
  updateSettingLabels();
  renderRhythmGrid();
  markTabDots();
  measureStableRenderW();
  setMetro(true);
  generateNew();
  if (ctx.presets) {   // account present → reveal the Presets tab + populate it
    var _pt = root.getElementById("tabPresets"); if (_pt) _pt.hidden = false;
    renderPresetsPanel();
  }

  /* Background playback: a SEPARATE, invisible player renders the bounce — see the identical comment in
     Playalongs/app.js for why (2026-07-30: the first version rendered on the LIVE player and broke
     production). The generated page is fixed once rendered, so a frozen bounce loses nothing here except
     the moving playhead. */
  var bouncePlayer = null, bounceHost = null;
  function ensureBouncePlayer() {
    if (!bouncePlayer) { bounceHost = document.createElement("div"); bouncePlayer = new RDMPlayer(bounceHost, {}); }
    return bouncePlayer;
  }

  /* ---------- mount API (used when embedded in the React shell) ---------- */
  return {
    pause: function () { try { player.pause(); } catch (e) {} },
    resumeAt: function (secs) {
      try {
        var passSecs = (player.totalBeats || 0) * (60 / player.tempo);
        if (!(passSecs > 0)) return;
        player.seek((secs % passSecs) / passSecs);
        player.play();
      } catch (e) { /* nothing loaded */ }
    },
    renderBounce: function (seconds) {
      var rdm = currentScore();
      if (!rdm) return Promise.reject(new Error("nothing generated yet"));
      var bp = ensureBouncePlayer();
      return bp.load({ rdm: rdm, originalTempo: player.originalTempo, tempoRangeAnchor: player.originalTempo }).then(function () {
        bp.tempo = player.tempo;
        bp.minTempo = player.minTempo; bp.maxTempo = player.maxTempo;
        bp.auto = player.auto;
        bp.randomCfg = { reps: player.randomCfg.reps, min: player.randomCfg.min, max: player.randomCfg.max };
        bp.bumpCfg = { reps: player.bumpCfg.reps, step: player.bumpCfg.step };
        bp.metroOn = player.metroOn;
        return bp.renderWholeLoops(seconds, { metro: true });
      });
    },
    bounceMeta: function () { return { title: "RDM Sight-Reading", tempo: player.tempo }; },
    destroy: function () {
      try { player.pause(); } catch (e) {}
      var d = ctx.disposables || [];
      for (var i = 0; i < d.length; i++) { try { d[i](); } catch (e) {} }
    },
    // re-measure + re-render at the real width (the score box may have had no width while hidden or during
    // the synchronous shadow-DOM boot) — same recipe as the resize handler.
    relayout: function () {
      try {
        measureStableRenderW();
        if (player && player.relayout && currentScore()) player.relayout();
        refreshSize(); fitScrollbar(); refreshHFades();
      } catch (e) {}
    }
  };
}
window.mountSightreading = mountSightreading;
// standalone (opened raw, outside the React app): boot itself once the DOM is ready, exactly as the old IIFE did.
if (!window.__RDM_EMBED) {
  var __rdmRunSR = function () { mountSightreading(document, { root: document, isActive: function () { return true; }, disposables: [] }); };
  if (document.readyState !== "loading") __rdmRunSR();
  else document.addEventListener("DOMContentLoaded", __rdmRunSR);
}
