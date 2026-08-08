/* ============================================================
   RDM Playalongs — Sticking Exercises (stickings.js)

   Turns the "N Note Stickings" catalog exercises into an interactive
   fill-in template + a pattern chart that sits at the BOTTOM of the
   sheet card (below the music). No separate tab.

   Structure (matches Anthony's printed sheet), 4 bars + a count-in + a
   final check note:
     count-in (4 x-notes)
     |: M1  M2 :|   played twice
     |: M3  M4 :|   played twice
     final check note (R only)

     M1, M3 = the ALTERNATING CHECK (continuous RLRLRL top / LRLRLR bottom),
              constant no matter what.
     M2     = the SAME fill  (chosen pattern repeated: R-lead top, L-lead bottom).
     M4     = the ALT  fill  (chosen pattern with the lead flipping each beat).

   Every note carries two sticking rows:
     stick1 (top)    = 1st pass, right-hand lead
     stick2 (bottom) = 2nd pass, left-hand lead (the mirror)

   The chart is the full set of length-N stickings that start on the right
   hand: 2^(N-1) of them (4 / 8 / 16 / 32), grouped by how many left-hand
   notes they contain (easiest -> hardest) — which reproduces Anthony's
   printed Stickings Checklist order exactly. Picking one plugs it into the
   Same + Alt fill-in bars.
   ============================================================ */
(function (global) {
  "use strict";

  // Each note-count is LOCKED to its own tuplet, so every bar fills 4/4 with exactly 4 groupings
  // (4 beats x N notes). per = notes per beat; dur = VexFlow duration; tempo = default BPM.
  var SUBS = {
    3: { dur: "8",  per: 3, tuplet: { num: 3, inSpaceOf: 2 }, tempo: 110 },
    4: { dur: "16", per: 4, tuplet: null,                     tempo: 90  },
    5: { dur: "16", per: 5, tuplet: { num: 5, inSpaceOf: 4 }, tempo: 80  },
    6: { dur: "16", per: 6, tuplet: { num: 6, inSpaceOf: 4 }, tempo: 70  }
  };

  /* ---------- pattern chart ---------- */
  function mirror(p) { return p.replace(/[RL]/g, function (c) { return c === "R" ? "L" : "R"; }); }
  function repeatStr(p, n) { var s = ""; for (var i = 0; i < n; i++) s += p; return s; }

  // all length-n stickings starting with R, grouped by #L ascending (binary order within a group)
  function genPatterns(n) {
    var all = [], total = 1 << (n - 1);
    for (var i = 0; i < total; i++) {
      var s = "R";
      for (var b = n - 2; b >= 0; b--) s += ((i >> b) & 1) ? "L" : "R";
      all.push(s);
    }
    return all.sort(function (a, b) {
      var la = (a.match(/L/g) || []).length, lb = (b.match(/L/g) || []).length;
      return la - lb;   // stable sort keeps the binary order inside each #L group
    });
  }

  /* ---------- note factories ----------
     Normal drum hits sit on C5 (the middle space) everywhere else in the catalog — see
     [[musicxml-catalog-shape]] (census: c/5 is the dominant position across all 493 real exercises,
     b/4 doesn't appear as a main notehead anywhere). These generated Stickings exercises were wrongly
     hardcoded to b/4 (a full line lower); fixed to c/5 to match every other exercise. mkRest's step/oct
     doesn't actually affect rendering (rests always draw at the renderer's fixed REST_KEY, "b/4" — see
     rdm-vexflow.js), but set to c/5 anyway for consistency/cleanliness. */
  function mkHit(dur, beats, s1, s2) {
    return { rest: false, beats: beats, dur: dur, dots: 0, step: "c", oct: 5, head: "normal",
      heads: [{ step: "c", oct: 5, head: "normal" }], accent: false, marcato: false,
      tenuto: false, staccato: false, roll: 0, buzz: false, flam: false, graces: null,
      stick1: s1 || null, stick2: s2 || null, dynamic: null };
  }
  function mkRest(dur, beats) {
    return { rest: true, beats: beats, dur: dur, dots: 0, step: "c", oct: 5, head: "normal",
      heads: null, accent: false, marcato: false, tenuto: false, staccato: false, roll: 0,
      buzz: false, flam: false, graces: null, stick1: null, stick2: null, dynamic: null };
  }
  function mkCount() {   // count-in x-notehead quarter, no sticking
    return { rest: false, beats: 1, dur: "q", dots: 0, step: "c", oct: 5, head: "x",
      heads: [{ step: "c", oct: 5, head: "x" }], accent: false, marcato: false,
      tenuto: false, staccato: false, roll: 0, buzz: false, flam: false, graces: null,
      stick1: null, stick2: null, dynamic: null };
  }

  // build one filled bar from two sticking rows (each `len` = 4*per chars). beams + tuplets per beat.
  function bar(n, topStr, botStr, opts) {
    var sub = SUBS[n], per = sub.per, beatsPer = 1 / per;
    var events = [], beams = [], tuplets = [];
    for (var beat = 0; beat < 4; beat++) {
      var start = events.length;
      for (var j = 0; j < per; j++) {
        var i = beat * per + j;
        events.push(mkHit(sub.dur, beatsPer, topStr.charAt(i), botStr.charAt(i)));
      }
      var ids = []; for (var k = start; k < events.length; k++) ids.push(k);
      beams.push(ids.slice());
      // every beat-group here is ALWAYS one continuous beam over all `per` notes (bar() never emits a
      // rest or splits the beam), so per the bracket rule it never needs one — the beam + number alone
      // already show the grouping (see the [[tuplet-bracket-rule]] memory).
      if (sub.tuplet) tuplets.push({ idx: ids.slice(), num: sub.tuplet.num,
        inSpaceOf: sub.tuplet.inSpaceOf, bracket: false, show: true });
    }
    return { timeSig: (opts && opts.timeSig) || null,
      repeatStart: !!(opts && opts.repeatStart),
      repeatEndTimes: (opts && opts.repeatEndTimes) || 0,
      events: events, beams: beams, tuplets: tuplets, extraVoices: [] };
  }

  /* ---------- score builder ---------- */
  // pattern = the chosen sticking (null => the fill bars just show the alternating check too)
  function buildScore(n, pattern) {
    var sub = SUBS[n], per = sub.per, L = 4 * per;

    // the alternating check: continuous R L R L ... (top) and its mirror (bottom)
    var checkTop = "", checkBot = "";
    for (var i = 0; i < L; i++) { checkTop += (i % 2 === 0) ? "R" : "L"; checkBot += (i % 2 === 0) ? "L" : "R"; }

    // the two fill bars
    var m2Top, m2Bot, m4Top, m4Bot;
    if (pattern) {
      var mp = mirror(pattern);
      m2Top = repeatStr(pattern, 4); m2Bot = repeatStr(mp, 4);            // Same: pattern / mirror
      m4Top = pattern + mp + pattern + mp; m4Bot = mp + pattern + mp + pattern;  // Alt: lead flips each beat
    } else {
      // no pattern picked yet: leave the fill bars BLANK (notes shown, no stickings) — a fill-in
      // slate. Empty strings => bar() writes null stickings under the notes.
      m2Top = m2Bot = m4Top = m4Bot = "";
    }

    // count-in (plays once)
    var countIn = { timeSig: [4, 4], repeatStart: false, repeatEndTimes: 0,
      events: [mkCount(), mkCount(), mkCount(), mkCount()], beams: [], tuplets: [], extraVoices: [] };

    // final check note: one hit, R only (it's played once, not a two-pass repeat like the other bars,
    // so there's no second/mirrored pass to show underneath), then rests
    var endBar = { timeSig: null, repeatStart: false, repeatEndTimes: 0,
      events: [mkHit("q", 1, "R", null), mkRest("q", 1), mkRest("h", 2)],
      beams: [], tuplets: [], extraVoices: [] };

    var measures = [
      countIn,
      bar(n, checkTop, checkBot, { repeatStart: true }),   // M1 check
      bar(n, m2Top, m2Bot, { repeatEndTimes: 2 }),         // M2 Same fill
      bar(n, checkTop, checkBot, { repeatStart: true }),   // M3 check
      bar(n, m4Top, m4Bot, { repeatEndTimes: 2 }),         // M4 Alt fill
      endBar
    ];

    return { title: n + " Note Stickings" + (pattern ? " · " + pattern : ""),
      tempo: sub.tempo, measures: measures };
  }

  /* ---------- chart UI (bottom of the sheet card) ---------- */
  var S = { n: 3, pattern: null, chart: null, onSelect: function () {} };

  function init(ctx) {
    S.chart = ctx.chartEl || document.getElementById("stkChart");
    S.onSelect = ctx.onSelect || function () {};
    if (!S.chart) return;

    // Title (left) + a short hint (right) share one line. The note-count is fixed by which
    // "N Note Stickings" exercise loaded (enter() sets it), so there's no note-count switcher.
    S.chart.innerHTML =
      '<div class="stkchart__head">' +
        '<span class="stkchart__title">Sticking Chart</span>' +
        '<span class="stkchart__hint">Tap a pattern to fill it in</span>' +
      '</div>' +
      '<div class="stkchart__grid" id="stkGrid"></div>';

    // On phones the grid is a single horizontally-swipeable row with no visible scrollbar (see CSS);
    // instead it fades left/right into the white paper wherever cells are hidden off-screen, same mask
    // pattern as the sheet music's own edge fade. #stkGrid is created once here and only its children
    // are replaced by renderGrid(), so one scroll listener (attached once) covers every exercise.
    var grid = S.chart.querySelector("#stkGrid");
    if (grid) {
      grid.addEventListener("scroll", updateGridFade, { passive: true });
      window.addEventListener("resize", updateGridFade);
    }
  }

  var GRID_FADE = "20px", GRID_FADE_EDGE = 2;
  function updateGridFade() {
    var grid = S.chart && S.chart.querySelector("#stkGrid");
    if (!grid) return;
    var over = grid.scrollWidth - grid.clientWidth;
    if (over <= GRID_FADE_EDGE) { grid.style.setProperty("--fade-left", "0px"); grid.style.setProperty("--fade-right", "0px"); return; }
    grid.style.setProperty("--fade-left",  grid.scrollLeft > GRID_FADE_EDGE ? GRID_FADE : "0px");
    grid.style.setProperty("--fade-right", (over - grid.scrollLeft) > GRID_FADE_EDGE ? GRID_FADE : "0px");
  }

  function renderGrid() {
    var grid = S.chart && S.chart.querySelector("#stkGrid");
    if (!grid) return;
    grid.innerHTML = "";
    genPatterns(S.n).forEach(function (p) {
      var cell = document.createElement("button");
      cell.className = "stkcell" + (p === S.pattern ? " is-on" : "");
      cell.type = "button"; cell.textContent = p;
      cell.addEventListener("click", function () { choose(p); });
      grid.appendChild(cell);
    });
    grid.scrollLeft = 0;   // new pattern set (different N) always starts scrolled to the left edge
    updateGridFade();
  }

  function highlightPattern() {
    var grid = S.chart && S.chart.querySelector("#stkGrid");
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll(".stkcell"), function (cell) {
      cell.classList.toggle("is-on", cell.textContent === S.pattern);
    });
  }

  function loadCurrent() { S.onSelect(buildScore(S.n, S.pattern), { tempo: SUBS[S.n].tempo }); }

  // clicking a pattern selects it; clicking the already-active one toggles it back off (empty fill bars)
  function choose(p) { S.pattern = (S.pattern === p) ? null : p; highlightPattern(); loadCurrent(); }

  /* ---------- entry / exit (called by app.js) ---------- */
  // a "N Note Stickings" catalog exercise was loaded — show the chart + the fill-in template
  function enter(n) {
    S.pattern = null;
    S.n = SUBS[n] ? n : 3;
    if (S.chart) S.chart.hidden = false;
    renderGrid();
    loadCurrent();
  }
  // a normal exercise was loaded — hide the chart
  function exit() { if (S.chart) S.chart.hidden = true; }

  global.RDMStickings = { init: init, enter: enter, exit: exit,
    buildScore: buildScore, genPatterns: genPatterns, mirror: mirror };
})(window);
