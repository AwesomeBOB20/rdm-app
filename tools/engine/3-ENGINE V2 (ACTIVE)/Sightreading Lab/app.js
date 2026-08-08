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
    rudQuickRow: $("rudQuickRow"), rudGrid: $("rudGrid"), rudStatus: $("rudStatus"),
    rudFreedomSlider: $("rudFreedomSlider"), rudFreedomFill: $("rudFreedomFill"),
    rudFreedomVal: $("rudFreedomVal"), rudFreedomLbl: $("rudFreedomLbl"),
    rudDensitySlider: $("rudDensitySlider"), rudDensityFill: $("rudDensityFill"),
    rudDensityVal: $("rudDensityVal"), rudDensityLbl: $("rudDensityLbl"),
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
    sheetNotice: $("sheetNotice"), sheetNoticeBlocked: $("sheetNoticeBlocked"),
    sheetNoticeForced: $("sheetNoticeForced"),
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
    ornaments: { accent: 0, flam: 0, diddle: 0, buzz: 0 },   // densities 0..100 (% of notes)
    /* PROTOTYPE — rudiments. `rudiments` is the SELECTED rudiment objects handed straight to the
       generator (empty = the tool behaves exactly as it does today), `rudFreedom` is how far from the
       subdivision it was engraved on a rudiment may be pasted (starts conservative), and `rudDensity` is
       how much of the page ends up being the rudiment(s) at all — 0 = never, 100 = the whole piece (see
       Rudiment Frequency; matches the generator's own default so a sheet generated before this slider is
       ever touched already reads as "the piece is mostly this rudiment", not "it barely shows up"). */
    rudiments: [],
    rudFreedom: 50,
    rudDensity: 50
  };

  /* PROTOTYPE — the name of the rhythm-placement slider. It stays ONE constant: change this string and
     the panel label, the tooltip, the slider's aria-label and the status line all follow. Nothing else in
     the code spells the name out, so a rename is a one-line edit.
     "Rhythm Freedom" was the working name; Anthony rejected it (2026-08-02) in favour of "Cross-Rhythm",
     which names the thing the slider actually buys you at the top of its range. */
  var RUD_FREEDOM_LABEL = "Cross-Rhythm";
  /* REWRITTEN 2026-08-06 with the slider's meaning (Anthony's own words for the rule): "0% to only allow
     rudiments to live INSIDE the rhythm it starts in ... Cross rhythm allows the paradiddle to go into
     some other rhythm, say if we start a paradiddle on 2 8th notes, and goes into 16th notes, itll finish
     out on the 16ths."

     The old copy described the old metric — "how far a rudiment may drift off the subdivision it was
     written on", with 0% meaning "a paradiddle diddle only on 6-lets". That is no longer true in either
     half: a rudiment may sit on any subdivision at 0% now, and what the slider buys is whether one
     statement may CHANGE subdivision partway through. Leaving the old sentence would have been worse than
     no tooltip, since it names a restriction that no longer exists. */
  var RUD_FREEDOM_HELP  = "Whether a rudiment may change rhythm partway through. " +
                          "0% = every note of it stays in one rhythm (it can still cross beat lines and " +
                          "start on any partial). 100% = it can begin on one rhythm and finish on another, " +
                          "like a paradiddle starting on two 8ths and ending on two 16ths.";

  /* RUDIMENTS THE ORNAMENTS PANEL ALREADY DOES (Anthony, 2026-08-04).

     "we don't need to have single stroke rolls or double stroke rolls or the buzz rolls rudiment or the
     flams rudiment because we can already get those from the ornaments tab."

     He is right, and the reason is structural: all four are ONE note long, and a one-note grouping is an
     ornament, not a rudiment — it has no sticking pattern to teach. Each maps exactly onto a density
     slider that already exists (flam / diddle / buzz), and the slider is strictly better because it
     gives a 0-100 dial instead of whatever the placement lottery happens to hand out. Single Stroke
     Rolls is the worst of them: no accent, no ornament, plain alternation, so it stamps NOTHING and is
     invisible on the page by construction.

     Dropping them also fixes a real distortion. Measured 2026-08-04 with everything ticked, the five
     one-note rudiments took 42% of ALL placements — a 1-note grouping is legal almost everywhere, so it
     wins the lottery constantly and eats the starting note before any real rudiment can use it, which is
     part of why 24 rudiments never appeared at all.

     RUFFS DELIBERATELY STAYS. It is also one note, but Ornaments has no ruff density (accent / flam /
     diddle / buzz only), so dropping it would lose it entirely. Add a ruff density and it should go too.

     Hidden from the PANEL only — they stay in rudiments-data.js, because they are real rudiments and the
     review page and checklist still need them. */
  var PANEL_HIDDEN = {
    "single-stroke-rolls": "plain notes — no marks at all",
    "flams":               "Ornaments › flam",
    "double-stroke-rolls": "Ornaments › diddle",
    "buzz-rolls":          "Ornaments › buzz",
  };
  var RUDS     = (window.RDM_RUDIMENTS || []).filter(function (r) { return !PANEL_HIDDEN[r.id]; });
  var RUD_CATS = window.RDM_RUD_CATS  || [];
  /* id -> rudiment. Needed by the two places that hold an id rather than the object: the per-tile tempo
     repaint (which reads it back off the tile's data-rud so it never has to rebuild the grid) and preset
     loading (presets store ids so they stay plain JSON). Built once here rather than filtering RUDS on
     every lookup — the tempo repaint walks every visible tile on every tempo change. */
  var RUD_BY_ID = {};
  RUDS.forEach(function (r) { RUD_BY_ID[r.id] = r; });
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
  /* RUDIMENTS (Anthony, 2026-08-08). Free accounts keep ten rudiments — the ones a marching drummer
     actually starts on — and everything else carries a padlock, the same lock the rhythm categories and
     meters use. The list is by id, not name, so a display-name tweak can't quietly unlock one.
     ("Triplet Stroke Rolls" in his note = the catalog's Triple Stroke Rolls, id triple-stroke-rolls —
     the only stroke-roll rudiment that fits that name.) */
  var FREE_RUDS = {
    "paradiddles": 1, "double-paradiddles": 1, "flam-accents": 1, "flam-paradiddles": 1,
    "flam-taps": 1, "hertas": 1, "triple-stroke-rolls": 1, "paradiddle-diddles": 1,
    "swiss-army-triplets": 1, "flammed-mills": 1,
  };
  function rudLocked(id) { return !PAID && !FREE_RUDS[id]; }
  // Never leave a locked rudiment ticked (a default, a restored preset, or a since-changed free list).
  function clampRuds() {
    if (PAID) return;
    Object.keys(rudOn).forEach(function (id) { if (rudLocked(id)) delete rudOn[id]; });
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
      /* PROTOTYPE — the single choke point for every tempo route in the tool. The slider, the typed
         box and TAP all reach the tempo through player.setTempo(), so marking the rudiment tiles here
         means there is exactly one place that has to know the tempo moved, rather than three listeners
         that could each be forgotten. paintRudTempo() no-ops when the rounded bpm has not changed, which
         is what makes it safe to call from a handler that fires on every pixel of a slider drag. */
      paintRudTempo();
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
    var out = sigTxt + " · " + settings.measures + (settings.measures === 1 ? " bar" : " bars");
    // PROTOTYPE: the sheet's subtitle says when rudiments were in play, so a screenshot of a generated
    // page still records what produced it
    var nr = settings.rudiments.length;
    if (nr) out += " · " + nr + " rudiment" + (nr === 1 ? "" : "s") + " @ " + settings.rudFreedom + "%";
    return out;
  }

  /* PROTOTYPE — say out loud what the rudiment selection did to this sheet, and what it could not do.
     generator.js computes both (score.forcedRudiments, score.blockedRudiments) and until now nothing
     read them, so ticking Ratamacues at 100bpm produced no rudiment and no explanation, and the
     sextuplet the sheet grew in order to host a Herta appeared on a page of 16ths with nothing to say
     where it came from. Both answers already existed in the data; this only displays them.

     ONLY BLOCKED IS SHOWN NOW (Anthony, 2026-08-05: "i dont like it being there"). The FORCED list used
     to print a line per placement, which was readable back when forcing fired once per sheet and became a
     paragraph of near-identical text the moment Rudiment Frequency started forcing the same rudiment ten
     times over. Grouping it to "Made room for Hertas ×7" fixed the length and not the problem: it is a
     description of the generator's internal machinery, and there is nothing a drummer can DO with it. The
     sheet already shows what is on it. score.forcedRudiments is untouched and still reachable from the
     dev console for anyone debugging the forcing pass.

     What survives is the one fact that is genuinely about the drummer's own request going unmet: they
     ticked a rudiment and it is not on the page. That is now settled against the FINISHED sheet
     (reconcileBlockedRudiments) rather than from a mid-pipeline forcing failure, so it no longer fires for
     a rudiment that placed fine by other means or that merely ran out of room after placing several.

     Non-modal on purpose: interrupting a reader to tell them a rudiment is 60bpm too fast would be a
     worse tool than the silence it replaces. */
  function renderSheetNotice(score) {
    if (!els.sheetNotice) return;
    var blocked = (score && score.blockedRudiments) || [];
    if (els.sheetNoticeBlocked) {
      // `why` comes from the generator already worded and already carrying the numbers, e.g.
      // "too fast at this tempo (10 notes/sec vs its 4 ceiling)" — restating it here would only let the
      // two drift apart, so this contributes the name and nothing else
      els.sheetNoticeBlocked.textContent = blocked.map(function (x) {
        return x.name + " not on this sheet: " + x.why;
      }).join(" · ");
      els.sheetNoticeBlocked.hidden = !blocked.length;
    }
    if (els.sheetNoticeForced) { els.sheetNoticeForced.textContent = ""; els.sheetNoticeForced.hidden = true; }
    els.sheetNotice.hidden = !blocked.length;
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
    /* Every route to a displayed sheet lands here — Generate, a live restyle (which rebuilds the score
       object, notices and all), and stepping back and forward through the history — so re-reading the
       notice at this one point is what keeps it describing the sheet actually on screen rather than
       whichever one produced it. Written synchronously with the title above it, not inside the load
       .then, so the subtitle and its footnote never disagree for a frame. */
    renderSheetNotice(entry.score);
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
    // + greys out at the real per-exercise fit, not a flat 250%, so a too-wide bar doesn't leave the
    // control doing nothing (Anthony, 2026-08-08). getZoom reads back the capped value.
    var maxZ = player.getMaxZoom ? player.getMaxZoom() : 2.5;
    els.sizeDown.disabled = z <= 0.5;
    els.sizeUp.disabled = z >= maxZ - 1e-9;
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
  // the Rudiments grid is the same scrolling two-row strip, so it takes the same edge fade
  function hfadeAll() { hfadeEl(els.rhythmGrid); hfadeEl(els.rudGrid); }
  // run once synchronously (reading clientWidth forces a layout flush, so it's accurate right after a
  // panel opens) AND once next frame (in case widths are still settling). rAF alone is unreliable when
  // the tab is backgrounded, so the sync call is the guarantee.
  function refreshHFades() { hfadeAll(); requestAnimationFrame(hfadeAll); }
  if (els.rhythmGrid) els.rhythmGrid.addEventListener("scroll", hfadeAll, { passive: true });
  if (els.rudGrid) els.rudGrid.addEventListener("scroll", hfadeAll, { passive: true });
  window.addEventListener("resize", refreshHFades, { passive: true });
  /* A caption's fit is a function of the tile's width, and the tile's width comes from the grid's own
     minmax() track — so it changes with the viewport (118px desktop, 88px under the mobile breakpoint) and
     the fit has to be recomputed, not decided once at render. Rotating a phone is the case that matters.
     fitRudCaps resets font-size and the wrap class before measuring, so re-running it can undo a wrap as
     well as apply one. */
  window.addEventListener("resize", function () {
    if (els.rhythmGrid) fitRudCaps(els.rhythmGrid, { allowWrap: true });
  }, { passive: true });

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

  /* ================= RUDIMENTS PANEL (PROTOTYPE) ==================================================
     Built out of the SAME parts as the Rhythms panel above it — the same .rh-quick buttons in the same
     stacked column, the same two-row .rh-grid of .rh-tile tiles with a check half and a notation half.
     What differs is only what the quick column does: in Rhythms it holds All/Full presets, here it is the
     CATEGORY switcher, because 130 tiles in one scrolling strip is unreadable and Anthony asked for the
     5 skill sets to be tab groupings.

     ONE TILE PER RUDIMENT (Anthony, explicit): "they should be 1 tile, just however they appear in the
     music should determine if its off the right or left." So there is no R tile and L tile — the
     rudiment's own `lead` field decides the hand at generation time. Seven rudiments belong to two
     categories at once; they are one object with one selection state that simply appears in both tabs,
     so ticking Paradiddles under Down & Up Strokes also ticks it under Hybrid Techniques.
     =============================================================================================== */
  var rudOn = {};                       // id -> true; the tick state, shared across categories
  var rudCat = RUD_CATS[0] || null;     // which category tab is showing

  /* cat === null means EVERY rudiment — that is the "All" button (Anthony, 2026-08-05: "add a 6th All
     button ... itd open a pop up of all rudiments"). Returning the whole list here means the All popup
     is the identical code path to a category popup, including its own All toggle at the foot. */
  function rudsIn(cat) {
    if (cat == null) return RUDS.slice();
    return RUDS.filter(function (r) { return r.cats.indexOf(cat) >= 0; });
  }

  /* ===== WHAT THE TEMPO DOES TO A RUDIMENT ======================================================
     A rudiment is engraved on `native` notes per beat and carries its own `maxNps` speed ceiling, so at
     B bpm it asks the hands for B/60*native notes a second and planRudiments drops it the moment that
     goes over the ceiling (`if (nps > r.maxNps + 1e-9) return false`). Ratamacues is the case that
     started this: 6 per beat at 100bpm is 10 notes/sec against a ceiling of 4, so it can never be placed
     and, before this, nothing said so — the tile looked identical to one that would work.

     liveGenTempo() reads the PLAYER, not settings.tempo, because settings.tempo is only refreshed at
     Generate: the number the tiles judge themselves against has to be the number the NEXT generation
     will use, and generateNew() computes exactly this same expression before handing settings over.
     Rounded, because that is what generateNew stores, so the tile and the generator can never disagree
     about which side of a ceiling a tempo falls on. */
  function liveGenTempo() {
    if (!player) return settings.tempo || 100;
    return Math.round(player.tempo / player.beatUnitMult()) || settings.tempo || 100;
  }
  /* THE MARK HAS TO ASK THE SAME QUESTION THE PLACER DOES (Anthony, 2026-08-04).

     "I don't like how you say a rudiment needs a certain tempo or like ... it fades out and is
     unclickable after a certain BPM ... I want these rudiments on top of any possible rhythm it's just
     that they can't go on top of rhythm if they are calculation is too fast."

     He is right, and the old rule was wrong in a way that was easy to miss: it judged the rudiment on its
     NATIVE subdivision only and never looked at Cross-Rhythm. But Cross-Rhythm is exactly the permission
     to sit on a SLOWER subdivision, where the same grouping is comfortably under its ceiling. Measured at
     100bpm: the old rule greyed 13 tiles at every slider position, while Paradiddle Diddles — one of the
     13 — was in fact generating on 11 of 15 sheets at Cross-Rhythm 100.

     So the question is "is there ANY subdivision the slider allows where this fits?", and the answer is
     decided by the SLOWEST one it allows. At 100bpm that leaves 13 marked at Cross-Rhythm 0, one at 25%,
     and none at all from 50% up — which is what he expects. */
  /* ⚠️ REBUILT 2026-08-06. This used to be `r.native / 2^(freedom * 3.5)` — the slider read as buying a
     SLOWER subdivision, so the flag asked "is there any subdivision Cross-Rhythm allows where this fits?".
     That model is gone twice over: the log2 gate it named disappeared with the misfit rebuild, and the
     redefinition removed subdivision restriction from the slider entirely. It meant the flag could grey a
     tile the placer goes on to use, or leave one bright that the placer refuses — the two were computing
     different things.

     What decides it now is simply the SLOWEST RHYTHM ON THE PAGE: a rudiment is written on one of the
     drummer's ticked subdivisions (see the generator's preferNative hard filter), so the most forgiving
     home it can have is the slowest of those. With nothing ticked the rudiments are the sheet and bring
     their own subdivision, which is `native`.

     And it compares against effectiveNpsCeiling, not r.maxNps: since the same-hand rule went in, a
     rudiment with consecutive strokes is capped well below its catalog number, and a ruff rudiment is
     judged by its ruff-free ceiling — so maxNps would name a tempo that still would not work. */
  function rudFreedomNow() { return Math.max(0, Math.min(100, +settings.rudFreedom || 0)) / 100; }
  function rudCeiling(r) {
    return (G && G.effectiveNpsCeiling) ? G.effectiveNpsCeiling(r) : r.maxNps;
  }
  function rudSlowestRate(r) {
    var rates = (G && G.selectedRates) ? G.selectedRates(settings) : null;
    if (!rates || !rates.length) return r.native;      // nothing ticked → it brings its own subdivision
    return Math.min.apply(null, rates);
  }
  function rudNpsAt(r, bpm) { return (bpm / 60) * rudSlowestRate(r); }
  function rudOffTempo(r, bpm) { return rudNpsAt(r, bpm) > rudCeiling(r) + 1e-9; }
  // Invert the ceiling: the fastest tempo this rudiment survives on the slowest subdivision available to
  // it. Floored, so the number quoted is always one the generator will actually accept — a rounded-up
  // 105.7 would be a lie.
  function rudMaxTempo(r) { return Math.floor(60 * rudCeiling(r) / rudSlowestRate(r)); }

  /* The tooltip. One function so the initial build and the live tempo repaint can never word the same
     tile differently — the repaint rewrites this string in place rather than rebuilding the tile. */
  function rudTileTitle(r, bpm, off) {
    var shape = r.n + " note" + (r.n === 1 ? "" : "s") + ", written on " + r.native + " per beat";
    var alsoIn = r.cats.length > 1
      ? " · also in " + r.cats.filter(function (c) { return c !== rudCat; }).join(", ") : "";
    /* The wording follows the arithmetic above: the fix is a slower TEMPO or a slower ticked RHYTHM, never
       Cross-Rhythm, which no longer has anything to do with whether a rudiment fits. The old copy said
       "or raise Cross-Rhythm", which after the redefinition would have sent the drummer to a slider that
       cannot help. */
    if (off) {
      var slowest = Math.round(rudSlowestRate(r) * 100) / 100;
      return r.name + " — too fast at " + bpm + " bpm. Even on the slowest rhythm you have ticked (" +
             slowest + " per beat) that is " + (Math.round(rudNpsAt(r, bpm) * 10) / 10) +
             " notes/sec, over its " + (Math.round(rudCeiling(r) * 100) / 100) + " ceiling. Works at " +
             rudMaxTempo(r) + " bpm or slower, or tick a slower rhythm. (" + shape + ")" + alsoIn;
    }
    return r.name + " — " + shape + ", max " + (Math.round(rudCeiling(r) * 100) / 100) + " notes/sec" +
           " (up to " + rudMaxTempo(r) + " bpm on the slowest rhythm you have ticked)" + alsoIn;
  }

  /* Re-mark the VISIBLE tiles for the current tempo. Deliberately not renderRudGrid(): that clears the
     grid, rebuilds every tile and re-arms the IntersectionObserver, which re-runs the whole
     RDMConvert + RDMRender pipeline for up to 45 engraved measures — far too much to do on a keystroke
     in the tempo box. This only flips one class, one hidden flag and two strings per tile, on nodes that
     already exist, so the notation is never touched and the tiles keep their identity.

     Guarded on the rounded bpm as well. Every tempo route in the tool funnels through player.setTempo(),
     which means the slider fires this on every pixel of a drag; comparing against the last painted value
     turns that into one pass per whole bpm, and none at all while the number is not moving. */
  var rudTempoPainted = null;
  function paintRudTempo(force) {
    if (!els.rudGrid || !player) return;
    var bpm = liveGenTempo();
    /* Guarded on the SLOWEST TICKED RATE as well as the tempo, because those are the two things the mark
       depends on (see rudSlowestRate). It used to key on Cross-Rhythm, which was right while the slider
       bought a slower subdivision — after the 2026-08-06 redefinition the slider cannot change the answer
       at all, and ticking a rhythm can, so keying on the slider would have left the grid showing a stale
       answer every time a rhythm was ticked. Uses the first rudiment as the probe: rudSlowestRate only
       reads `native` when NOTHING is ticked, and in that case every rudiment's answer changes together. */
    var probe = RUDS && RUDS.length ? RUDS[0] : null;
    var stamp = bpm + "@" + (probe ? rudSlowestRate(probe) : 0);
    if (!force && stamp === rudTempoPainted) return;
    rudTempoPainted = stamp;
    /* The off-tempo mark lives on the POPUP tiles now, not on an inline strip, so a tempo change has to
       redraw whichever category popup is open. The panel itself only carries counters, which do not
       depend on tempo. */
    if (activePicker === "ruds") rerenderKeepScroll();
    var shownChanged = false;
    var tiles = els.rudGrid ? els.rudGrid.children : [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var r = RUD_BY_ID[tile.getAttribute("data-rud")];
      if (!r) continue;
      var off = rudOffTempo(r, bpm);
      tile.classList.toggle("rh-tile--offtempo", off);
      var open = tile.querySelector(".rh-open");
      if (open) open.title = rudTileTitle(r, bpm, off);
      var flag = tile.querySelector(".rh-offtempo");
      if (flag) {
        // only rewritten when it is actually shown — an off-screen string nobody reads is still a
        // layout-invalidating write on 45 nodes
        if (off) flag.textContent = "needs " + rudMaxTempo(r) + " bpm";
        if (flag.hidden !== !off) shownChanged = true;
        flag.hidden = !off;
      }
    }
    // the flag shares the caption's line, so showing or hiding one changes what has to fit on it —
    // re-fit only when a flag actually toggled, not on every tempo keystroke (see fitRudCaps)
    if (shownChanged) fitRudCaps();
  }

  // the settings object is handed to the generator as-is, so the selection has to be materialised onto it
  function syncRudSelection() {
    settings.rudiments = RUDS.filter(function (r) { return rudOn[r.id]; });
    /* The Rhythms panel now lets the LAST rhythm come off while a rudiment is selected, because the
       rudiment brings its own subdivision with it. Taking that rudiment back off afterwards would leave
       the sheet with no source of notes whatsoever, and Generate would quietly produce nothing at all —
       a dead button with no explanation, which is the exact failure this whole pass exists to remove. So
       the quarter-note floor comes back the moment the rudiment that lifted it is gone. */
    if (!settings.rudiments.length &&
        !G.CATEGORIES.some(function (c) { return settings.cats[c.key] !== false; })) {
      settings.cats.q = true;
      renderRhythmGrid();
    }
  }

  /* ===== TILE NOTATION — the REAL engraving, not a drawing ========================================
     Anthony, 2026-08-02: "make the rudiment tiles look exactly like the real sheet music like in our
     html tool". The tiles used to carry the hand-drawn miniature further down this file (circles for
     noteheads, a line per stem, no beams at all). Next to the Rhythms tiles — which are genuine VexFlow
     output — that read as a diagram rather than as music.

     So the source score goes through the SAME pair the sheet card uses, RDMConvert.convert() then
     RDMRender.render(), exactly as dev/rud-page.js does it. Nothing about the notation is
     re-implemented here, which is the whole point: what the tile shows is what the engine draws.

     BARE MODE (no staff lines, no clef, no barlines, no time signature). Rendered both ways side by side
     at the real tile width and the full staff lost: the clef and the barlines eat ~40px of a ~165px art
     box, so the notes shrink to pay for furniture that says nothing about the rudiment, and five staff
     lines behind 12 sixteenths at that scale is noise. Bare is also what the neighbouring Rhythms and
     time-signature glyphs already use, so the whole grid stays one kind of object. (Bare mode does still
     print a time signature when the measure carries one, which is why buildRudMeasures hands over
     measures with none.)

     WHERE THE MEASURE NUMBER COMES FROM. rudiments-data.js does not currently carry the measure index,
     and it is owned elsewhere, so dev/rudiments-limits.json (the row index it is generated from) is
     fetched and matched by name. `r.measure` / `r.bars` on the rudiment object win whenever they do
     appear, so this keeps working the moment that file gains them. */
  var RUD_SRC_XML = "../rudiments-source.musicxml";
  var RUD_SRC_IDX = "../rudiments-limits.json";
  var RUD_ART_W   = 520;    // unscaled render width; the SVG is cropped to its ink and scaled by CSS
  var rudMeasures = null;   // converted source score, one measure per rudiment row
  var rudRowOf    = {};     // rudiment name -> { measure, bars } out of the index
  var rudArtReady = false;  // true once BOTH loads land; until then tiles use the drawn fallback

  function rudFlipHand(h) { return h === "R" ? "L" : h === "L" ? "R" : h; }

  /* THE TILE SHOWS THE REAL ENGRAVING, TUPLETS INCLUDED (Anthony, 2026-08-04): "rewrite all the
     rudiments in the rudiment tiles as they looked originally in the xml with the correct tuplet
     markings now." That REVERSES the previous pass, which stripped every tuplet bracket and rewrote
     each note's length in plain 16ths so the grouping would "make sense to put over any rhythm" — right
     for the GENERATOR's ratio/shape model (see the SHAPE OF A GROUPING note in rud-extract.js, which
     already reads the true proportion off the XML and is untouched by this), wrong for the tile, which
     is meant to be a picture of the book, not a picture of the abstraction.

     So the slice off `rudMeasures` (the real converted score) is used as-is — same events, same beams,
     same tuplets RDMConvert already produced, nothing recomputed. The only two changes left are ones
     the tuplet stripping never owned in the first place: clearing the time signature (bare mode) and
     filling in the sticking `...` tail (see below). */
  function buildRudMeasures(r) {
    var row = rudRowOf[r.name] || {};
    var m0 = (r.measure != null ? r.measure : row.measure);
    if (!rudMeasures || !m0) return null;
    var src = rudMeasures.slice(m0 - 1, m0 - 1 + (r.bars || row.bars || 1));
    if (!src.length) return null;

    var outM = src.map(function (m) {
      var events = m.events.map(function (e) {
        var c = {};
        for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) c[k] = e[k];
        return c;
      });
      /* No time signature. Bare mode would otherwise print whatever meter the source measure carries,
         and that costs real width in a 165px art box for a fact the tile does not need to state. */
      var out = {};
      for (var k2 in m) if (Object.prototype.hasOwnProperty.call(m, k2)) out[k2] = m[k2];
      out.events = events; out.timeSig = null;
      return out;
    });

    /* The `...` sticking tail written into the score gets filled in (Anthony: "replace the ... with the
       stickings the 1st beat has. so people will see its a same hand repeating rudiment, either starting
       off right or left"). rud-page.js reads the extractor's `fullSticking` for this; that field is not
       in rudiments-data.js, but repeating `sticking` and flipping the hand on every other statement when
       the rudiment's lead alternates reproduces it EXACTLY — checked against all 130 rows of
       rudiments-limits.json, zero mismatches. Only the top row is drawn: the mirrored left-lead row
       (stick2) doubles the height of the art for a tile this size and the caption already names the
       rudiment. */
    var allDurs = String(r.fullDurs || "").split(",").filter(Boolean).map(Number);
    var hands = [];
    for (var i = 0; i < allDurs.length; i++) {
      var h = r.sticking.charAt(i % r.n);
      if (r.lead === "alternate" && Math.floor(i / r.n) % 2 === 1) h = rudFlipHand(h);
      hands.push(h);
    }
    /* BUZZES ARE PUT BACK (Anthony, 2026-08-05: "the images of some rudiments with buzzes don't include
       the buzzes in their images ... make sure every rudiment that has buzzes actually has them").

       They are not in the engraving to lose: Sibelius does not export the "z" (an UNMEASURED tremolo)
       to MusicXML, so all SIX buzz rudiments — Buzz Rolls, Tap Buzzes, Spicy Ranches, Parabuzzles,
       Parabuzzles v2, Sausage Linkers — arrive here with the buzz silently dropped. Checked: 6 of 6 carry
       no unmeasured tremolo and no "z" text in their source measures, while measured diddles (a
       single-slash tremolo) DO survive, which is why those tiles have always looked right.

       The rudiment's own data knows exactly which strokes are buzzed (`roll`, one character per note of
       the grouping, same shape as `sticking`), so it is stamped back on the same walk that fills in the
       sticking. `roll` is cleared alongside it because a note is one or the other — a buzz drawn over a
       measured-roll slash would read as neither. */
    var rolls = String(r.roll || "");
    var hi = 0;
    outM.forEach(function (m) {
      m.events.forEach(function (e) {
        if (e.rest) return;
        var h = hands[hi];
        if (h && h !== "?") e.stick1 = h;
        e.stick2 = null;
        if (rolls.charAt(hi % r.n) === "z") { e.buzz = true; e.roll = 0; }
        hi++;
      });
    });
    return outM;
  }

  /* One rendered SVG per rudiment, CACHED BY ID as an HTML string and re-parsed per call — the same
     shape rhythmGlyph()/variantGlyph() above use, and the reason switching category tabs is free after
     the first visit: 123 renders cost ~4ms each, so re-rendering a 45-tile tab would be ~185ms of jank
     every time, and the cache turns that into a string clone. Cropping the viewBox to the ink (getBBox)
     is what lets CSS size the notation by height without the renderer's own margins padding it out. */
  var _rudCache = {};
  /* The renderer sizes sticking letters for a full-width sheet, where they sit under notes that are
     inches apart. Cropped into a tile they came out around 4px tall and unreadable, and on a rudiment
     the sticking is not decoration — it IS the rudiment (Anthony: "Make the stickings in the rudiment
     tiles bigger"). So the R/L letters are scaled up after the render, in the tile only; nothing about
     the shared renderer changes, so the real sheet is untouched.

     Re-anchoring matters. VexFlow places each letter by its LEFT edge, having already subtracted half
     the text width to centre it. Grow the font from that same left edge and every letter drifts right
     of its notehead. So the visual centre is measured first, then the letter is re-hung from it with
     text-anchor=middle, which keeps it under its note at any size. */
  var STICK_SCALE = 1.9;
  function enlargeStickings(svg) {
    var texts = svg.querySelectorAll("text");
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i], s = (t.textContent || "").trim();
      if (s !== "R" && s !== "L") continue;       // counts and bar numbers are left alone
      var bb;
      try { bb = t.getBBox(); } catch (e) { continue; }
      if (!bb || !bb.width) continue;
      var cx = bb.x + bb.width / 2;
      var fs = parseFloat(t.getAttribute("font-size") || t.style.fontSize || "10") || 10;
      t.setAttribute("font-size", (fs * STICK_SCALE).toFixed(2) + "px");
      t.style.fontSize = (fs * STICK_SCALE).toFixed(2) + "px";
      t.setAttribute("font-weight", "bold");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("x", cx.toFixed(2));
    }
  }

  /* HOW WIDE A STAVE TO LAY THIS TILE OUT ON (Anthony, 2026-08-05: "these ruffs look dumb being so far
     apart").

     Every tile used to render on the same 520px stave, so the formatter spread whatever it was given
     across the full width — fine for the 8-to-12-note groupings that most rudiments draw, and daft for
     Ruffs, whose source bar is just TWO quarter notes (fullDurs "2520,2520"). Two notes on a twelve-note
     stave land at opposite ends with a canyon between them, which is exactly what the screenshot shows.

     Sizing the stave to the note count instead keeps the SPACING consistent between tiles rather than the
     WIDTH: a sparse rudiment now draws a compact group that the art box centres, instead of the same few
     notes stretched to the edges. Grace notes are not counted — a ruff's two graces are crushed against
     their principal and take almost no horizontal room, so counting them would re-inflate the very tiles
     this exists to pull in. Floored at 40% so a one-note rudiment still reads as notation and not as a
     stray dot, and never exceeds the old width, so every tile that already looked right is untouched. */
  function rudArtWidth(measures) {
    var n = 0;
    measures.forEach(function (m) {
      (m.events || []).forEach(function (e) { if (!e.rest) n++; });
    });
    var REF = 10;                                     // a typical grouping — the width that was tuned for
    var frac = Math.max(0.4, Math.min(1, n / REF));
    return Math.round(RUD_ART_W * frac);
  }

  function rudScoreSvg(r) {
    if (!rudArtReady || !window.RDMRender) return null;
    if (!_rudCache[r.id]) {
      var measures = buildRudMeasures(r);
      if (!measures) return null;
      var stage = rhStage();
      try { window.RDMRender.render({ measures: measures }, stage, { width: rudArtWidth(measures), zoom: 1, bare: true }); }
      catch (e) { return null; }
      var svg = stage.querySelector("svg"); if (!svg) return null;
      enlargeStickings(svg);        // BEFORE the crop below, or the bigger letters get clipped off
      var bb = svg.getBBox();
      if (bb && bb.width > 0 && bb.height > 0) {
        var pad = 3;
        svg.setAttribute("viewBox", (bb.x - pad) + " " + (bb.y - pad) + " " +
                                    (bb.width + pad * 2) + " " + (bb.height + pad * 2));
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.style.width = ""; svg.style.height = "";
      }
      _rudCache[r.id] = svg.outerHTML;
    }
    var tmp = document.createElement("div"); tmp.innerHTML = _rudCache[r.id];
    return tmp.querySelector("svg");
  }

  /* LAZY IN TWO STAGES, because a category holds up to 45 tiles and the strip only ever shows about
     eight of them.

     Stage one is an IntersectionObserver rooted on the scrolling grid: a tile draws the first time it
     comes near view (200px of lead, so it is already there by the time you scroll onto it) and is then
     dropped from the watch list. That is what makes opening a tab cost the handful of tiles on screen
     rather than the whole category.

     Stage two is an idle sweep that finishes the rest. It is not belt-and-braces, it is load-bearing:
     Chrome does not deliver IntersectionObserver callbacks to a hidden document, so with the tool in a
     background tab (measured: document.hidden === true) NOTHING was drawn until the tab was focused.
     The sweep also means a drummer who never scrolls the strip still ends up with every tile painted,
     and it does it between frames rather than in the click handler. It is time-sliced to 8ms a slot so a
     45-tile category never blocks a frame, and it re-checks the grid it started on so a category switch
     mid-sweep abandons the old one.

     The art box takes its height from CSS, not from the SVG, so a tile is exactly as tall before its
     notation lands as after — nothing in the grid moves when either stage fires. */
  var rudArtObserver = null;
  function rudArtObs() {
    if (rudArtObserver || typeof IntersectionObserver !== "function") return rudArtObserver;
    rudArtObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        rudArtObserver.unobserve(en.target);
        fillRudArt(en.target);
      });
    }, { root: els.rudGrid, rootMargin: "0px 200px 0px 200px" });
    return rudArtObserver;
  }
  function fillRudArt(art) {
    if (!art || art.getAttribute("data-drawn") === "1") return;
    var r = RUDS.filter(function (x) { return x.id === art.getAttribute("data-rud"); })[0];
    if (!r) return;
    /* NEVER FLASH THE FALLBACK (Anthony, 2026-08-05: "make sure it shows up instantly ... doesn't load
       the bad glyphs that we had before"). While the engraving is still in flight the tile is left EMPTY
       rather than filled with the hand-drawn miniature — the art box takes its height from CSS, so an
       empty tile is exactly the size of a full one and nothing moves when it lands. The miniature is
       reached only once the source has genuinely failed, or once it has loaded and this particular
       rudiment turns out to have no row in it. In practice neither happens on a normal boot: the host
       waits on api.ready before the launch screen lifts, so by the time a popup can be opened every
       tile is already engraved and cached. */
    var svg = rudScoreSvg(r);
    if (!svg) {
      if (!rudSrcFailed && !rudArtReady) return;   // still loading — leave the box blank, do not swap later
      svg = rudGlyph(r);
    }
    if (!svg) return;
    art.innerHTML = ""; art.appendChild(svg);
    art.setAttribute("data-drawn", "1");
  }
  /* setTimeout, NOT requestIdleCallback. rIC is the obvious tool for "do this when nothing else needs
     the thread", but Chrome does not run idle callbacks in a hidden document at all — not even with a
     `timeout` — and a hidden document is precisely the case this sweep exists to cover. Measured: with
     rIC the tiles of a background tab stayed empty indefinitely. A timer still fires there (throttled to
     about once a second, which is the right speed for a tab nobody is looking at) and the 8ms slice below
     is what actually keeps the sweep off any frame's critical path, so nothing is lost by not using rIC.
     The token makes a switch mid-sweep abandon the category it was working on. */
  var rudSweepId = 0;
  function rudSweep(token) {
    if (token !== rudSweepId || !els.rudGrid) return;
    var pending = els.rudGrid.querySelectorAll(".rh-art--rud:not([data-drawn])");
    if (!pending.length) return;
    /* The 8ms slice exists to avoid eating a frame. A hidden document has no frames to eat AND has its
       timers throttled to about one a second, so slicing there is all cost and no benefit — measured, a
       45-tile category took 15 seconds to fill in a background tab and 8ms of that was work. So when the
       page is hidden the whole category is drawn in one pass. */
    var now = function () { return window.performance ? performance.now() : Date.now(); };
    var until = now() + (document.hidden ? 1e9 : 8);
    for (var i = 0; i < pending.length; i++) {
      if (rudArtObserver) rudArtObserver.unobserve(pending[i]);
      fillRudArt(pending[i]);
      if (now() > until) break;
    }
    setTimeout(function () { rudSweep(token); }, 16);
  }
  function startRudSweep() {
    var token = ++rudSweepId;
    setTimeout(function () { rudSweep(token); }, 60);
  }

  /* Both files are needed before anything can be drawn, so they load together and the grid is repainted
     once. Failure is not fatal: rudArtReady stays false, rudScoreSvg() returns null and every tile falls
     back to the drawn miniature — this page is opened straight off a static file server and a 404 on a
     dev asset should leave a usable panel, not an empty one.

     WHERE THE TWO FILES COME FROM. Standalone (this file opened off a static server) they are plain
     relative fetches, exactly as before. Inside the React app there IS no relative base — the tool is
     mounted into a shadow root on an app route, so "../rudiments-source.musicxml" resolves against
     /tools/whatever and 404s, which is why every tile in the app fell back to the drawn glyph. The host
     therefore hands the mount a `ctx.asset(name)` that pulls the file out of the same private `tools`
     Storage bucket the tool's own code comes from — same RLS gate, same paywall, nothing published.

     LOADED AT MOUNT, BEHIND THE LAUNCH SCREEN (Anthony, 2026-08-05: "I need them to just show up
     instantly, that's why we have the loading screen wait as well"). This was briefly lazy — fetched on
     the first rudiment popup — which saved ~700 KB at launch but meant the first open of the panel
     showed the old drawn glyphs for a moment and then swapped them for the engraving underneath you.
     Wrong trade: the launch screen already exists to absorb exactly this, and it holds until every tool
     reports ready (App.jsx), so the whole cost is paid once, before anything is touchable. The mount
     hands that promise back as `api.ready` and the host waits on it.

     `rudPrewarm` is the other half of "instant": having the score is not enough, because a popup renders
     up to 119 staves. Measured cold that is ~670 ms of visible assembly; with every tile pre-rendered
     into _rudCache during the same wait, opening a popup is ~60 ms of string clones. */
  var rudSrcP = null;        // the load, once started (memoised — this is also `api.ready`)
  var rudSrcFailed = false;  // ONLY then may a tile fall back to the hand-drawn miniature
  function loadRudSource() {
    if (rudSrcP) return rudSrcP;
    if (!window.RDMConvert || typeof fetch !== "function") {
      rudSrcFailed = true;
      return (rudSrcP = Promise.resolve());
    }
    function grab(name, path) {
      if (ctx.asset) return ctx.asset(name);
      return fetch(path).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " " + path);
        return res.text();
      });
    }
    var getText = grab("rudiments-source.musicxml", RUD_SRC_XML);
    var getIdx = grab("rudiments-limits.json", RUD_SRC_IDX).then(function (t) { return JSON.parse(t); });
    rudSrcP = Promise.all([getText, getIdx]).then(function (both) {
      rudMeasures = window.RDMConvert.convert(both[0]).measures;
      (both[1] || []).forEach(function (row) {
        if (row && row.name && !rudRowOf[row.name]) rudRowOf[row.name] = { measure: row.measure, bars: row.bars || 1 };
      });
      rudArtReady = true;
      _rudCache = {};
      return rudPrewarm();
    }).then(function () {
      renderRudGrid();
      // if a popup is already open (the safety cap fired, or a slow phone), repaint its tiles in place
      if (activePicker === "ruds") rerenderKeepScroll();
    }).catch(function (e) {
      rudSrcFailed = true;   // now, and only now, the tiles are allowed to show the drawn miniature
      console.warn("rudiments: source notation unavailable, tiles keep the drawn glyph —", e.message);
      renderRudGrid();
      if (activePicker === "ruds") rerenderKeepScroll();
    });
    return rudSrcP;
  }

  /* Render every rudiment's notation into _rudCache up front, so opening a popup is a string clone per
     tile instead of up to 119 VexFlow layouts. Sliced to 8ms a turn: this runs under the launch screen,
     but the screen is a real painted page and a 600ms synchronous block there would still show up as a
     stall in whatever else is booting alongside it. */
  function rudPrewarm() {
    return new Promise(function (resolve) {
      var i = 0;
      var now = function () { return window.performance ? performance.now() : Date.now(); };
      (function step() {
        var until = now() + 8;
        while (i < RUDS.length && now() < until) {
          try { rudScoreSvg(RUDS[i]); } catch (e) {}
          i++;
        }
        if (i < RUDS.length) setTimeout(step, 0); else resolve();
      })();
    });
  }

  /* FALLBACK ONLY — the pre-2026-08-02 hand-drawn miniature: accents on top, noteheads with stems in the
     middle, sticking letters underneath, grace notes hanging off the left of the strokes that carry them.
     It is no longer what the tiles show; it is what they show if rudiments-source.musicxml or
     rudiments-limits.json cannot be fetched. Deliberately NOT to scale rhythmically. */
  function rudGlyph(r) {
    var NS = "http://www.w3.org/2000/svg";
    var STEP = 11, PAD = 9, TOP = 14, HEAD = 26, BOT = 39;
    var w = PAD * 2 + Math.max(0, r.n - 1) * STEP + 6;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " 42");
    svg.setAttribute("width", w); svg.setAttribute("height", 42);
    function add(tag, attrs) {
      var e = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      svg.appendChild(e); return e;
    }
    function txt(x, y, s, size) {
      var t = add("text", { x: x, y: y, "font-size": size, "font-weight": 700, "text-anchor": "middle",
                            "stroke-width": 0 });
      t.textContent = s; return t;
    }
    for (var k = 0; k < r.n; k++) {
      var cx = PAD + k * STEP;
      var o = r.orn.charAt(k);
      var nGrace = o === "f" ? 1 : o === "d" ? 2 : o === "D" ? 3 : 0;
      for (var g = 0; g < nGrace; g++) {
        add("circle", { cx: cx - 4 - (nGrace - 1 - g) * 3, cy: HEAD - 3, r: 1.4 });
      }
      add("circle", { cx: cx, cy: HEAD, r: 2.6 });
      add("line", { x1: cx + 2.4, y1: HEAD, x2: cx + 2.4, y2: HEAD - 11, "stroke-width": 1.1 });
      var ro = r.roll.charAt(k);
      if (ro === "/") {   // diddle = one slash across the stem, same as the engraved shorthand
        add("line", { x1: cx, y1: HEAD - 5, x2: cx + 5, y2: HEAD - 8, "stroke-width": 1.1 });
      } else if (ro === "z") {
        txt(cx + 2.4, HEAD - 12, "z", 7);
      }
      var a = r.accents.charAt(k);
      if (a === ">") {
        add("path", { d: "M" + (cx - 3) + " " + (TOP - 3) + " L" + (cx + 3) + " " + TOP +
                         " L" + (cx - 3) + " " + (TOP + 3), fill: "none", "stroke-width": 1.3 });
      } else if (a === "-") {
        add("line", { x1: cx - 3, y1: TOP, x2: cx + 3, y2: TOP, "stroke-width": 1.3 });
      }
      txt(cx, BOT, r.sticking.charAt(k), 8);
    }
    return svg;
  }

  function rudStatusText() {
    var n = settings.rudiments.length;
    if (!n) return "No rudiments selected";
    return n + (n === 1 ? " rudiment" : " rudiments") + " selected · " +
           RUD_FREEDOM_LABEL + " " + settings.rudFreedom + "%";
  }

  function renderRudGrid() {
    if (!els.rudQuickRow || !els.rudGrid) return;

    /* Quick column: the 5 category tabs, then All/None acting on whichever one is showing. The INACTIVE
       categories borrow .rh-quick--dim, which already means "this is the resting state" in the Rhythms
       panel.

       EVERY CATEGORY BUTTON IS THE SAME HEIGHT (Anthony, 2026-08-02: "make the category tabs the same
       heights and look nicer"). They were not, and flex could not fix it: the labels were one string
       ("Down & Up Strokes (22)"), the long ones wrapped to two lines, and a flex item cannot shrink below
       its own min-content height, so `flex:1 1 0` distributed nothing and each button simply sat at the
       height its own text needed. The fix is to stop the wrap rather than to fight it — the name and the
       count are now two elements on ONE nowrap line, name left, count right, so no button can be taller
       than any other whatever its label says. It also just reads better: a list of five categories with
       their sizes, instead of five differently-shaped pills.

       All/None move into a single half-and-half row at the foot of the column. They are momentary
       actions, not one of the five things you can be looking at, and pairing them stops them reading as
       a sixth and seventh category. */
    els.rudQuickRow.innerHTML = "";
    function mkQuick(host, label, count, onClick, extraCls, title) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rh-quick" + (extraCls ? " " + extraCls : "");
      if (count == null) btn.textContent = label;
      else {
        var nm = document.createElement("span"); nm.className = "rq-name"; nm.textContent = label;
        var ct = document.createElement("span"); ct.className = "rq-count"; ct.textContent = count;
        btn.appendChild(nm); btn.appendChild(ct);
      }
      if (title) btn.title = title;
      btn.addEventListener("click", onClick);
      host.appendChild(btn);
      return btn;
    }
    /* Short tab labels (Anthony, 2026-08-04) — the real category names ("Down & Up Strokes") are the
       curriculum's actual "5 Universal Mechanics" terms (see the app CLAUDE.md), used everywhere else
       (checklists, course modules), so those stay the real DATA — this is a DISPLAY-only shortening for
       a column that was truncating to "Down & Up ..." anyway. The full name still shows on hover (title)
       and is still what everything else in the code (rudsIn, rudOn, filtering) keys off. */
    var RUD_CAT_SHORT = {
      "Rebound Strokes": "Rebound", "Down & Up Strokes": "Accent Tap", "Double Strokes": "Doubles",
      "Natural Decays": "Decays", "Hybrid Techniques": "Hybrids",
    };
    /* No All button in the PANEL any more (Anthony, 2026-08-05): it lives at the foot of each category's
       popup instead, so the panel is exactly the five categories and nothing else. The empty container
       that used to hold it stayed behind after the All button was removed and, being a sixth grid child,
       silently forced the five-column row onto a SECOND row — 120px of panel for 56px of buttons, with
       the difference taken straight out of the sheet. */

    /* EACH CATEGORY SHOWS HOW MUCH OF IT IS TICKED (Anthony, 2026-08-05: "there should be some indication
       of how many rudiments in a section have been toggled. so 0/31 or 1/31 type thing").

       The count used to be the category's SIZE alone, which answers a question nobody has twice — you
       learn there are 31 Decays once and then never need telling again. What you actually lose track of,
       with five categories and one visible at a time, is how many you have turned on in the four you
       cannot see. Selected-over-total says that at a glance and keeps the size in the same glance. */
    /* ALL FIRST (Anthony, 2026-08-05): "add a 6th All button to the rudiments panel so someone can just
       see them all ... at the beginning". Same shape and same counter as the five categories — it is a
       VIEW of every rudiment, not the select-all action, which lives at the foot of each popup. Its count
       is de-duplicated by rudsIn(null) returning the rudiment list itself, so a rudiment filed under two
       categories is still one row of 123. */
    var allRuds = rudsIn(null);
    var allOnCount = allRuds.filter(function (r) { return rudOn[r.id]; }).length;
    mkQuick(els.rudQuickRow, "All", allOnCount + "/" + allRuds.length,
            function () { rudCat = null; openPicker("ruds", "All rudiments"); },
            "rq-cat" + (allOnCount ? " rq-cat--some" : ""),
            "Every rudiment — " + allOnCount + " of " + allRuds.length + " selected");

    RUD_CATS.forEach(function (cat) {
      var list = rudsIn(cat), n = list.length;
      var on = list.filter(function (r) { return rudOn[r.id]; }).length;
      mkQuick(els.rudQuickRow, RUD_CAT_SHORT[cat] || cat, on + "/" + n,
              function () { rudCat = cat; openPicker("ruds", cat); },
              "rq-cat" + (on ? " rq-cat--some" : ""),
              cat + " — " + on + " of " + n + " selected");
    });
    /* NO INLINE TILE STRIP ANY MORE (Anthony, 2026-08-05). The tiles moved into a per-category popup
       (see the "ruds" branch of renderPickerList); the panel is five buttons and their counters. The grid
       element stays in the DOM but empty so the observer, the edge-fade and the sweep all no-op safely. */
    if (rudArtObserver) rudArtObserver.disconnect();
    if (els.rudGrid) els.rudGrid.innerHTML = "";

    if (els.rudStatus) els.rudStatus.textContent = rudStatusText();
    markTabDots();
  }

  /* SHRINK ONLY THE NAMES THAT WOULD WRAP (Anthony, 2026-08-05: "how to rid of that wasted vertical space
     between the rhythm tiles? Is it because some rudiment names are too long?" — it was, exactly).

     Measured across the 45 Hybrids tiles: 42 were 82px tall and THREE were 94px, the three whose names
     take two lines ("Double Accent Paradiddle Diddles", "Double Accent Paradiddle Taps", "Double Kicked
     Paradiddle Taps"). The grid's rows were hardcoded to 96px to clear those three, and because the grid
     also sets align-items:start the other 42 tiles kept their natural 82px and left ~14px of dead space
     under each — the gap he is looking at, caused by 3 rudiments out of 45.

     Dropping the type size for everyone would fix it and cost legibility on all 45 to fix 3: the widest
     name needs to come down from 11.52px to ~10px to fit 162px of caption width. So the shrink is applied
     per tile, only where it is actually needed, stepping down until the name fits on one line (floor 9px,
     below which it stops being worth reading and the name is simply allowed to wrap again).

     Measured with scrollWidth vs clientWidth on a nowrap clone rather than by counting characters, so a
     name added later is handled without anyone revisiting a hard-coded list. */
  /* `opts.allowWrap` lets a caption that STILL does not fit at the minimum size fall back to two lines at
     full size, instead of being shrunk past legibility or clipped by .rh-tile's overflow:hidden.

     Off for the rudiment tiles on purpose. Wrapping is what three long rudiment names out of 45 used to do,
     and because grid row tracks size to their tallest member it made every tile in the row taller — the
     dead band Anthony asked to close on 2026-08-05. Those names all fit once shrunk, so they never need the
     fallback. The rhythm tiles do: at phone width a tile has about 50px of caption room, and "Dotted
     Quarters" needs 81px, which no legible size reaches. Two readable lines beat one unreadable one. */
  function fitRudCaps(host, opts) {
    host = host || els.rudGrid;
    if (!host) return;
    var allowWrap = !!(opts && opts.allowWrap);
    var lines = host.querySelectorAll(".rh-capline");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], cap = line.querySelector(".rh-cap");
      if (!cap) continue;
      cap.style.fontSize = "";                 // start from the stylesheet value every time
      cap.classList.remove("rh-cap--wrap");    // ...and from one line, so a re-fit can undo a wrap
      var px = parseFloat(getComputedStyle(cap).fontSize) || 11.52;
      /* Measured on the CAPLINE, not the caption: the off-tempo flag shares that line, so a name that
         fits alone can still overflow once the flag appears. Both are nowrap now, so scrollWidth
         exceeding clientWidth is exactly "this line is too wide", with no wrapping to mask it. */
      var guard = 0;
      while (line.scrollWidth > line.clientWidth + 0.5 && px > 9 && guard++ < 12) {
        px -= 0.4;
        cap.style.fontSize = px.toFixed(2) + "px";
      }
      if (allowWrap && line.scrollWidth > line.clientWidth + 0.5) {
        cap.style.fontSize = "";               // back to full size — two lines, not tiny ones
        cap.classList.add("rh-cap--wrap");
      }
    }
  }

  function paintRudFreedom() {
    if (!els.rudFreedomSlider) return;
    var v = +els.rudFreedomSlider.value;
    if (els.rudFreedomVal) els.rudFreedomVal.textContent = v + "%";
    if (els.rudFreedomFill) els.rudFreedomFill.style.width = (v / +els.rudFreedomSlider.max) * 100 + "%";
    if (els.rudStatus) els.rudStatus.textContent = rudStatusText();
  }
  if (els.rudFreedomLbl) els.rudFreedomLbl.textContent = RUD_FREEDOM_LABEL;
  if (els.rudFreedomSlider) {
    els.rudFreedomSlider.value = settings.rudFreedom;
    els.rudFreedomSlider.setAttribute("aria-label", RUD_FREEDOM_LABEL);
    var ff = els.rudFreedomSlider.closest ? els.rudFreedomSlider.closest(".rud-freedom") : null;
    if (ff) ff.title = RUD_FREEDOM_HELP;
    els.rudFreedomSlider.addEventListener("input", function () {
      settings.rudFreedom = +els.rudFreedomSlider.value; paintRudFreedom();
      // the slider decides how slow a subdivision a rudiment may sit on, so it decides which tiles are
      // impossible — repaint them with it rather than leaving the previous answer on screen
      paintRudTempo();
    });
    paintRudFreedom();
  }

  function paintRudDensity() {
    if (!els.rudDensitySlider) return;
    var v = +els.rudDensitySlider.value;
    if (els.rudDensityVal) els.rudDensityVal.textContent = v + "%";
    if (els.rudDensityFill) els.rudDensityFill.style.width = (v / +els.rudDensitySlider.max) * 100 + "%";
  }
  if (els.rudDensitySlider) {
    els.rudDensitySlider.value = settings.rudDensity;
    els.rudDensitySlider.addEventListener("input", function () {
      settings.rudDensity = +els.rudDensitySlider.value; paintRudDensity();
    });
    paintRudDensity();
  }

  /* ---------- tab bar (Rhythms / Rudiments / Setup / Ornaments) ---------- */
  var tabButtons = Array.prototype.slice.call(root.querySelectorAll(".tab[data-tab]"));
  var TAB_ORDER = ["rhythms", "rudiments", "setup", "ornaments", "loop", "presets"];   // 1-6 keyboard shortcut order
  var openTab = null;   // start with NO tab open (panels collapsed) on load/refresh
  /* FREEMIUM: the locked tabs stay VISIBLE and greyed rather than being removed. A lock the drummer can
     see is what sells the upgrade; a missing tab just looks like a tool that can't do much. (2026-07-31) */
  var LOCKED_TABS = { ornaments: 1, loop: 1, presets: 1 };
  function tabLocked(name) { return !PAID && !!LOCKED_TABS[name]; }
  var METER_LOCK_MSG = "Compound and asymmetric meters come with the full version, along with every rhythm in the generator.";
  var RUD_LOCK_MSG = "The full version unlocks all 123 rudiments. The free ten are Paradiddles, Double Paradiddles, Flam Accents, Flam Paradiddles, Flam Taps, Hertas, Triple Stroke Rolls, Paradiddle Diddles, Swiss Army Triplets and Flammed Mills.";
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
    /* ...and so are its captions, for exactly the same reason. renderRhythmGrid() runs on load while the
       panels are still collapsed, where every clientWidth is 0 and fitRudCaps therefore measures nothing
       and does nothing — so the fit has to be redone the first time the panel is actually shown. Found by
       measuring: the tiles came out correct at every width the probe RESIZED to (a resize re-fits) and
       wrong at the one width it opened at. */
    if (name === "rhythms") fitRudCaps(els.rhythmGrid, { allowWrap: true });
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
    var rt = root.getElementById("tabRudiments");
    if (rt) rt.classList.toggle("on", settings.rudiments.length > 0);
  }

  /* ---------- shared modal picker (multi-select for meters + rhythms, single for sticking) ---------- */
  var activePicker = null;   // "timesig" | "sticking" | "variants" | "ruds"
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
    /* capture only: open a rudiment popup. Pass a category name for one section, or nothing for the All
       popup. The category buttons are not <button>s the capture script can reliably click before the
       grid has rendered, same reason openVariantPicker is exposed above. */
    window.RDMSightreadOpenRudiments = function (cat) {
      rudCat = cat || null;
      openPicker("ruds", cat || "All rudiments");
    };
    // capture only: tick a set of rudiments by NAME, so a tutorial example page actually contains them
    window.RDMSightreadSetRudiments = function (names) {
      var want = {};
      (names || []).forEach(function (n) { want[String(n).toLowerCase()] = 1; });
      RUDS.forEach(function (r) {
        if (want[r.name.toLowerCase()]) rudOn[r.id] = true; else delete rudOn[r.id];
      });
      syncRudSelection(); renderRudGrid();
    };
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
    /* capture only: keep generating until the page actually DEMONSTRATES the Cross-Rhythm setting.

       Every other slider example can be photographed straight off one generate, because those sliders
       change every beat deterministically. Cross-Rhythm changes a PROBABILITY: measured over 40 sheets
       it moves the share of rudiment notes sitting on a foreign subdivision from 0% to 63%, but any one
       2-bar page is a coin toss, and the pair of pictures kept coming out looking identical. So the
       capture asks for a page that shows the thing: `want` true means at least one whole beat where the
       rudiment is written on a subdivision it was NOT written on, false means the rudiment is present and
       every note of it is on its own. Same idea as GenUntilSlow / GenUntilVaried above.

       "Foreign" is measured off the note's own length against the rudiment's native rate, which is what
       the placer itself compares (candidateAt's rate test), so the picture and the rule agree. */
    /* ⚠️ REWRITTEN FOR THE 2026-08-06 MEANING OF CROSS-RHYTHM. It used to count notes whose subdivision
       differed from the rudiment's engraved `native` — "is this rudiment sitting somewhere it was not
       written". That is not what the slider does any more: it decides whether one STATEMENT may change
       note value partway through, and a rudiment is free to sit on any subdivision at every setting. The
       old test therefore asked a question with no relation to the control, and the tutorial's 100% picture
       was captured against it — which is why Anthony reported that the picture "doesnt show what it says
       it does".

       Counts statements that CHANGE value inside themselves, for flat rudiments only (a shaped rudiment's
       notes are unequal by definition, so counting those would report a crossing on every sheet). Folds
       the _diddleRest back in, or a diddled slot reads as half its length and every diddle rudiment looks
       like a change. */
    window.RDMSightreadGenUntilCross = function (want) {
      for (var t = 0; t < 300; t++) {
        generateNew();
        var sc = history[histPos] && history[histPos].score;
        var ex = sc && sc._ex;                     // the raw exercise the score keeps for restyling
        if (!ex) continue;
        var flat = [];
        ex.forEach(function (mm) {
          (mm.beats || []).forEach(function (tile) { (tile || []).forEach(function (n) { flat.push(n); }); });
        });
        var seen = 0, crossed = 0;
        for (var i = 0; i < flat.length; i++) {
          var n = flat[i];
          if (!n || n._rud == null || n._rudIdx !== 0) continue;
          var r = RUD_BY_ID[n._rud];
          if (!r || !r.flat) continue;             // shaped rudiments are unequal by definition
          var durs = [n.beats || 0], j = i + 1, want2 = 1;
          while (j < flat.length && want2 < r.n) {
            var g = flat[j];
            if (g && g._rud === r.id && g._rudIdx === want2) { durs.push(g.beats || 0); want2++; j++; }
            else if (g && g.kind === "rest" && g._diddleRest) { durs[durs.length - 1] += (g.beats || 0); j++; }
            else break;
          }
          if (durs.length !== r.n) continue;
          seen++;
          if (Math.max.apply(null, durs) - Math.min.apply(null, durs) > 1e-9) crossed++;
        }
        if (!seen) continue;                       // no rudiment on the page at all: nothing to show
        if (want ? crossed >= 2 : crossed === 0) return true;
      }
      return false;
    };
    /* capture only, same reason as GenUntilCross: keep generating until the share of notes belonging to
       a rudiment falls inside [min, max] percent, so the Rudiment Frequency example pair is visibly a
       low page and a high page rather than two rolls of the same dice. */
    window.RDMSightreadGenUntilRudPct = function (min, max) {
      for (var t = 0; t < 300; t++) {
        generateNew();
        var sc = history[histPos] && history[histPos].score;
        var ex = sc && sc._ex;
        if (!ex) continue;
        var total = 0, rud = 0;
        ex.forEach(function (mm) {
          (mm.beats || []).forEach(function (tile) {
            (tile || []).forEach(function (n) { if (!n || n.kind === "rest") return; total++; if (n._rud) rud++; });
          });
        });
        if (!total) continue;
        var pct = (rud / total) * 100;
        if (pct >= min && pct <= max) return true;
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
    /* "Variety low": one bar all triplets, then one bar all eighths — two uniform bars that change only
       once (Anthony, 2026-07-24).

       RETRY THE REAL GENERATOR, don't assemble a score by hand. The first version generated two separate
       one-bar scores and spliced measure [1] out of each on the assumption that measure [0] was the
       count-in. That assumption was wrong, the length guard below it tripped every time, and the hook
       returned false — leaving on screen whatever it had generated last, which was a single bar of
       eighths. That is the picture Anthony caught: the caption promised two bars and the image showed
       one (2026-08-07).

       VARIETY 25, NOT 0. At 0 the rhythm never changes at all, so both bars come out identical and the
       caption's single change is unreachable: measured 0 hits in 60 pages at variety 0. 25 is still
       firmly "low" (the page changes rhythm once) and lands the exact caption often enough for retries
       to find it: measured ~4 pages in 80 change exactly once AND do it at the barline, so 400 tries is
       a certainty. Same beat-signature idiom as GenUntilVaried
       above, and content bars are picked out by having a full bar of beats, which sidesteps needing to
       know whether the count-in is a measure at all. */
    /* Per-bar rhythm signatures of whatever is currently on the page, for the capture checks.
       Counting DOM tuplet elements does not work: a triplet that is beamed across draws no bracket at
       all (see the tuplet-bracket rule), so `.vf-tuplet` is 0 on a page full of triplets and any check
       built on it silently measures nothing. Read the score instead. */
    window.RDMSightreadBarSigs = function () {
      var s = history[histPos] && history[histPos].score;
      if (!s || !s.measures) return null;
      var out = [];
      s.measures.forEach(function (m) {
        var inTup = {}, tupNum = {};
        (m.tuplets || []).forEach(function (tp) { (tp.idx || []).forEach(function (i) { inTup[i] = true; tupNum[i] = tp.num; }); });
        var beatSig = {}, cum = 0;
        (m.events || []).forEach(function (ev, i) {
          var b = Math.floor(cum + 1e-6);
          if (beatSig[b] == null) beatSig[b] = inTup[i] ? ("t" + tupNum[i]) : ("n" + ev.dur);
          cum += (ev.beats || 0);
        });
        out.push(Object.keys(beatSig).sort(function (a, b) { return a - b; }).map(function (k) { return beatSig[k]; }));
      });
      return out;
    };

    window.RDMSightreadGenUntilVarietyLo = function () {
      var setS = function (id, v) { var el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } };
      var setM = function (v) { var el = document.getElementById("measInput"); if (el) { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); } };
      setS("varietySlider", 25); setS("sparsitySlider", 0); setS("restsSlider", 0); setM(2);   // low but not zero, complete, 2 bars
      window.RDMSightreadSetFamilies(["8t", "8s"]);
      for (var t = 0; t < 400; t++) {
        generateNew();
        var s = history[histPos] && history[histPos].score;
        if (!s || !s.measures) continue;
        var bars = [];
        s.measures.forEach(function (m) {
          var inTup = {}, tupNum = {};
          (m.tuplets || []).forEach(function (tp) { (tp.idx || []).forEach(function (i) { inTup[i] = true; tupNum[i] = tp.num; }); });
          var beatSig = {}, cum = 0;
          (m.events || []).forEach(function (ev, i) {
            var b = Math.floor(cum + 1e-6);
            if (beatSig[b] == null) beatSig[b] = inTup[i] ? ("t" + tupNum[i]) : ("n" + ev.dur);
            cum += (ev.beats || 0);
          });
          var vals = Object.keys(beatSig).sort(function (a, b) { return a - b; }).map(function (k) { return beatSig[k]; });
          if (vals.length < 4) return;      // a short measure is the count-in, not a content bar
          bars.push({ sig: vals[0], uniform: vals.every(function (v) { return v === vals[0]; }) });
        });
        // exactly two content bars, each uniform, different from each other, TRIPLETS FIRST to match the caption
        if (bars.length === 2 && bars[0].uniform && bars[1].uniform &&
            bars[0].sig !== bars[1].sig && bars[0].sig.charAt(0) === "t") return true;
      }
      return false;
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
    /* ...and re-fit the captions here for the same reason, which the 2026-08-05 shrink pass missed.
       renderPickerList() above runs while `hidden` is still true, so every clientWidth/scrollWidth it
       measures is 0 — `0 > 0.5` is false, the shrink loop never entered, and fitRudCaps had been doing
       nothing at all on a fresh open. Measured at phone width before this line existed: three of the 45
       Hybrids names still sat at the stylesheet's 10.24px and ran up to 19px past their tile, exactly as
       if the pass were not there. In-picker re-renders (rerenderKeepScroll) always ran while visible, which
       is why it looked like it worked. */
    fitRudCaps(els.pickerList);
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
        /* "Keep at least one rhythm on" used to be unconditional, and had to be: a sheet with no note
           values to draw from has nothing to generate. A selected rudiment changes that, because it
           force-generates its own subdivision when no chosen rhythm can host it (generator.js,
           injectForcedRudiments), so "just give me paradiddle diddles" is a real and useful sheet and
           the last rhythm is allowed off. With nothing ticked on either side there is still no source of
           notes at all, so the floor stays exactly where it was. (Anthony approved zero-rhythm rudiment
           presets, 2026-08-02.) */
        if (now && onCount <= 1 && !settings.rudiments.length) return;
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
      /* Wrapped in a .rh-capline like the rudiment tiles are, so fitRudCaps can measure it. `.rh-cap` is
         nowrap and a nowrap flex item in a centered column sizes to its OWN text, so it never reports
         overflow on itself — the capline is the box with a real content width to overflow. Without this
         wrapper the rhythm captions were simply never measured, and `.rh-tile{overflow:hidden}` clipped
         the long ones: measured 2026-08-06, "Dotted Quarters" ran 19px past its tile on desktop and 31px
         on a phone, with 12 of the 22 names overflowing at phone width. */
      var capline = document.createElement("span"); capline.className = "rh-capline";
      var cap = document.createElement("span"); cap.className = "rh-cap"; cap.textContent = c.label;
      capline.appendChild(cap);
      open.appendChild(capline);
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
    // captions are sized against their real box, so they can only be fitted once the tiles are in the DOM
    fitRudCaps(els.rhythmGrid, { allowWrap: true });
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
    // rudiment tiles are wider than a rhythm variant (they carry a name under the notation), so they
    // get their own grid class rather than reusing the rhythms one
    els.pickerList.classList.toggle("modal__list--ruds", activePicker === "ruds");

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

    /* ---------- RUDIMENTS: one popup per category (Anthony, 2026-08-05) ----------

       "for the Rudiments panel only five buttons would be seen and then each of those buttons would open
       up a pop up and at the bottom of each of the pop ups would be the All button just like how all
       those other pop ups in the rhythm panel has that."

       The panel used to carry a 2-row horizontally-scrolling strip of tiles: 45 Hybrids across 23 columns
       with about five visible at once, which is browsing a rudiment library through a letterbox. A popup
       shows the whole category at once, reuses the modal that already works for rhythm variations, and
       leaves the panel as five buttons whose counters (see renderRudGrid) are now the at-a-glance state.

       ⚠️ NO SNAP-BACK HERE. The variants branch above refuses to leave a category with zero active,
       because a rhythm category with nothing selected cannot generate. Rudiments are the opposite: zero
       selected is a completely ordinary answer — it means "no rudiments on this sheet" — so the All
       toggle below must genuinely be able to reach zero. Inheriting that rule by copying the branch above
       would quietly make the All button un-turn-off-able. */
    if (activePicker === "ruds") {
      /* Idempotent — the engraving is normally already here (loaded at mount, behind the launch screen).
         This only ever does anything if the splash's safety cap fired first on a very slow connection. */
      loadRudSource();
      var rlist = rudsIn(rudCat);
      var rshown = q ? rlist.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; }) : rlist;
      var bpmNow = liveGenTempo();

      rshown.forEach(function (r) {
        var on = !!rudOn[r.id];
        var off = rudOffTempo(r, bpmNow);
        var locked = rudLocked(r.id);
        var tile = document.createElement("li");
        tile.setAttribute("role", "option");
        tile.setAttribute("aria-selected", on ? "true" : "false");
        tile.setAttribute("data-rud", r.id);
        tile.className = "rh-tile" + (on ? " active" : "") + (off ? " rh-tile--offtempo" : "") +
                         (locked ? " rh-tile--locked" : "");
        tile.title = locked ? "Unlock the full rudiment library" : rudTileTitle(r, bpmNow, off);

        function toggleRud() {
          if (locked) { upsell("Unlock " + r.name, RUD_LOCK_MSG); return; }
          if (rudOn[r.id]) delete rudOn[r.id]; else rudOn[r.id] = true;
          syncRudSelection();
          renderRudGrid();          // the panel's counters have to follow the popup
          rerenderKeepScroll();
        }

        var check = document.createElement("span"); check.className = "rh-check";
        var tick = document.createElement("span"); tick.className = "tick"; check.appendChild(tick);
        check.addEventListener("click", function (e) { e.stopPropagation(); toggleRud(); });
        tile.appendChild(check);

        var open = document.createElement("span"); open.className = "rh-open";
        var art = document.createElement("span"); art.className = "rh-art rh-art--rud";
        art.setAttribute("data-rud", r.id);
        // drawn straight away rather than lazily: rudScoreSvg caches by id, so the first open of a
        // category costs one render each and every open after that is a string clone
        fillRudArt(art);
        open.appendChild(art);

        var capline = document.createElement("span"); capline.className = "rh-capline";
        var cap = document.createElement("span"); cap.className = "rh-cap"; cap.textContent = r.name;
        capline.appendChild(cap);
        if (off) {
          var flag = document.createElement("span");
          flag.className = "rh-offtempo"; flag.textContent = "needs " + rudMaxTempo(r) + " bpm";
          capline.appendChild(flag);
        }
        open.appendChild(capline);
        open.addEventListener("click", toggleRud);
        tile.appendChild(open);
        els.pickerList.appendChild(tile);
      });

      fitRudCaps(els.pickerList);

      // the All toggle Anthony asked for, same sticky-foot slot and same dim/bright semantics as Full.
      // FREEMIUM: All only ever reaches the rudiments this account owns; a wholly-locked category upsells.
      var freeList = rlist.filter(function (r) { return !rudLocked(r.id); });
      if (!freeList.length) {
        quickBtn("All", false, function () { upsell("Unlock the rudiment library", RUD_LOCK_MSG); }, true);
        return;
      }
      var allOn = freeList.every(function (r) { return rudOn[r.id]; });
      quickBtn("All", allOn, function () {
        var everyOn = freeList.every(function (r) { return rudOn[r.id]; });
        freeList.forEach(function (r) { if (everyOn) delete rudOn[r.id]; else rudOn[r.id] = true; });
        syncRudSelection();
        renderRudGrid();
        rerenderKeepScroll();
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
  els.stickingBtn.addEventListener("click", function () { openPicker("sticking", "Sticking Overlay"); });
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
     WHAT THIS SWITCH MEANS CHANGED (Anthony, 2026-08-07), the same way it did in Playalongs. The engine
     now counts you in at the TOP of a sheet unconditionally (see _countOffArmed), so this switch only
     governs the cue before each REPEAT — and its default flipped ON -> OFF to match. New key with the
     new meaning: an existing "on" answered a different question and would opt people into a mid-loop
     cue they never asked for. Stored as the literal state now that the default is OFF. */
  var CO_KEY = "rdm_sr_loop_countoff_v2";
  var CO_BEATS_KEY = "rdm_sr_loop_countoff_beats";
  if (els.loopCountOff) {
    var coSaved = false;
    try { coSaved = localStorage.getItem(CO_KEY) === "1"; } catch (e) {}
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
    else if (k >= "1" && k <= "6") { e.preventDefault(); selectTab(TAB_ORDER[+k - 1]); }   // PROTOTYPE: Rudiments made it 6
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
      variants: (G.active ? Array.from(G.active) : []),
      /* PROTOTYPE — a "chops warmup" preset that forgets which rudiments were on is only half a preset
         (Anthony, 2026-08-02), and the rudiment grid is by a distance the most laborious thing on this
         page to re-pick: 130 tiles spread across five categories. Cross-Rhythm rides along with it
         because the two are one decision — a rudiment selection means something different at 0% than it
         does at 100%, so restoring one without the other restores neither.
         Stored as IDS, not the rudiment objects. It keeps a preset a plain JSON blob (these round-trip
         through the account backend), and it means an id that no longer exists in rudiments-data.js is
         simply dropped on load rather than resurrecting a stale copy of a rudiment the data has moved
         on from. */
      rudiments: settings.rudiments.map(function (r) { return r.id; }),
      rudFreedom: settings.rudFreedom, rudDensity: settings.rudDensity
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
    /* PROTOTYPE — the rudiment half of the preset. Restored BEFORE the freemium clamp below, because
       that clamp needs to know whether any rudiments are coming back before it decides the sheet has no
       source of notes and forces quarters on.
       Presets saved before rudiments existed carry neither field, and every preset already in an account
       is one of those. Missing means "no rudiments selected" and "Cross-Rhythm at 0%" — which is the
       state the tool ships in — and never an error and never a reason to abandon the rest of the load.
       An unknown id (a rudiment renamed or dropped from rudiments-data.js since the preset was saved) is
       skipped for the same reason: a preset that is partly loadable must load. */
    rudOn = {};
    (s.rudiments || []).forEach(function (id) { if (RUD_BY_ID[id]) rudOn[id] = true; });
    clampRuds();   // a preset saved while paid must not smuggle a locked rudiment back in on a free account
    syncRudSelection();
    settings.rudFreedom = s.rudFreedom != null ? +s.rudFreedom : 50;
    settings.rudDensity = s.rudDensity != null ? +s.rudDensity : 50;
    /* FREEMIUM: presets are a paid feature, so this normally can't run on a free account — but a preset
       saved while paid must not survive a downgrade as a back door into locked rhythms or ornaments. */
    if (!PAID) {
      G.CATEGORIES.forEach(function (c) { if (catLocked(c.key)) settings.cats[c.key] = false; });
      // ...but a preset with rudiments and deliberately no rhythms is a legitimate saved state, not an
      // empty one, so the quarter-note fallback only fires when there is nothing to generate from at all
      if (!settings.rudiments.length &&
          !G.CATEGORIES.some(function (c) { return settings.cats[c.key]; })) settings.cats.q = true;
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
    if (els.rudFreedomSlider) els.rudFreedomSlider.value = settings.rudFreedom;
    paintRudFreedom();
    if (els.rudDensitySlider) els.rudDensitySlider.value = settings.rudDensity;
    paintRudDensity();
    updateSettingLabels();
    renderRhythmGrid();
    renderRudGrid();   // repaint the ticks (and, through it, the tempo marks) from the restored selection
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
  renderRudGrid();
  loadRudSource();   // engraving + every tile pre-rendered; the host holds the launch screen on api.ready
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

  /* PROTOTYPE ONLY — a console handle on the live settings and the current sheet. Everything in this
     file lives inside the mount closure, so without it there is no way to check from outside what a
     generated sheet actually contains, which is exactly what this test page exists to answer. Pair it
     with RDMSightGen.describeRudiments(rudDev.score()) to read back every placement. */
  window.rudDev = {
    settings: settings,
    score: function () { var e = history[histPos]; return e && e.score; },
    generate: generateNew,
    select: function (names) {
      rudOn = {};
      (names || []).forEach(function (nm) {
        var r = RUDS.filter(function (x) { return x.name === nm || x.id === nm; })[0];
        if (r) rudOn[r.id] = true;
      });
      syncRudSelection(); renderRudGrid();
      return settings.rudiments.map(function (r) { return r.name; });
    },
    setFreedom: function (v) {
      settings.rudFreedom = v;
      if (els.rudFreedomSlider) { els.rudFreedomSlider.value = v; paintRudFreedom(); }
      return settings.rudFreedom;
    },
    setDensity: function (v) {
      settings.rudDensity = v;
      if (els.rudDensitySlider) { els.rudDensitySlider.value = v; paintRudDensity(); }
      return settings.rudDensity;
    }
  };

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
    /* Work that must finish before this tool is INSTANT rather than merely mounted: the rudiment
       engraving is fetched and every tile pre-rendered. The React host waits on this before it reports
       the tool ready, which is what keeps the launch screen up until the panel is genuinely paintable
       (App.jsx caps the whole splash at 12s, so a dead network cannot strand anyone). */
    ready: rudSrcP,
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
  var __srCtx = { root: document, isActive: function () { return true; }, disposables: [] };
  /* PROTOTYPE ONLY — a stand-in for the account's preset store.
     The Presets tab ships `hidden` and is revealed only when the host hands the mount a ctx.presets,
     because saving a setup writes to the signed-in user's row. Opened raw, as this test page always is,
     there is no account, so without a stand-in the entire preset path — including the rudiment
     selection and Cross-Rhythm it now carries — is unreachable and untestable here.
     Anthony, 2026-08-03: "there was no reason to remove it from testing" — this used to be opt-in behind
     `?presets=local`, which meant the tab was invisible on a plain open of this page, exactly what
     prompted the question. Always on now: a localStorage-backed object with the SAME three-member shape
     the real one has (initial / create / remove), which is all applyPreset and renderPresetsPanel ever
     touch. Still harmless to ship behaviour — this whole branch only runs when `!window.__RDM_EMBED`,
     i.e. this file opened raw outside the React app. The real ctx.presets the React shell supplies
     reaches mountSightreading through the __RDM_EMBED branch above, not this one, so it is never
     shadowed. */
  var __srKey = "rdm-sr-rudiments-proto-presets";
  var __srRead = function () { try { return JSON.parse(localStorage.getItem(__srKey)) || []; } catch (e) { return []; } };
  var __srWrite = function (a) { try { localStorage.setItem(__srKey, JSON.stringify(a)); } catch (e) {} };
  __srCtx.presets = {
    initial: __srRead(),
    create: function (name, s) {
      var all = __srRead();
      var p = { id: "p" + Date.now() + "-" + Math.floor(Math.random() * 1e6), name: name, settings: s };
      all.push(p); __srWrite(all); return p;
    },
    remove: function (id) { __srWrite(__srRead().filter(function (p) { return p.id !== id; })); }
  };
  var __rdmRunSR = function () { mountSightreading(document, __srCtx); };
  if (document.readyState !== "loading") __rdmRunSR();
  else document.addEventListener("DOMContentLoaded", __rdmRunSR);
}
