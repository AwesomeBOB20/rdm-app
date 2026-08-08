/* ============================================================
   RDM Sightreading Lab — generator.js  (Engine V2)

   The GENERATION BRAIN of the old Sightreading Lab (1-LIVE TOOLS/
   Sightreading Lab/main.js), extracted VERBATIM and rewired to a
   settings object instead of DOM reads. It preserves Anthony's
   pedagogy exactly: the 211-entry RHYTHM_VARIANTS bank, the strict
   candidate filter + weighted category lottery, the syncopation
   engine, the 4 sticking strategies, and the counting-syllable
   logic ("1 e & a", triplet "la/li", tuplet numbers…).

   What's NEW here is only the thin shell:
     - element "shims" (allowQuartersEl etc) that read a settings
       object instead of checkboxes, so the extracted code runs
       unmodified;
     - toRDM(): converts the generated exercise (measures of tiles
       of {kind,dur,beats,dots,_tuplet…}) into the shared RDM score
       format {title,tempo,measures:[{timeSig,events,beams,tuplets}]}
       that shared/engine.js + shared/rdm-vexflow.js consume —
       reproducing the old buildMeasure() assembly rules: global
       tuplet per tile, local/mixed tuplet grouping by groupId,
       pulse-aware beaming, smart brackets (bracket only when the
       group isn't one continuous beam), counts→stick1 row,
       sticking→stick2 row;
     - RDMSightGen.generate(settings) — the public API.

   window.RDMSightGen = {
     generate(settings) -> {title, tempo, measures}   // load({rdm}) ready
     CATEGORIES,   // [{key,label}] for the Rhythms picker
     TIME_SIGS,    // [{label,value,group}] for the Time Sig picker
     STICKINGS,    // [{label,value}] for the Sticking picker
   }
   settings = {
     measures: 8, timeSigs: ["4/4"], restPct: 20, syncopation: false,
     cats: { q:true, dottedQ:true, "8s":true, "16s":true, "8t":true,
             qt:true, "5let":true, "5let16":true, "6let":true, "9let":true },
     sticking: "natural" | "alternate" | "doubles" | "paradiddle" | "none",
     leadHand: "R" | "L", showCounts: true, countIn: true,
     tempo: 100, title: "Sight Reading"
   }
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- settings shims ----------------
     The extracted code reads checkbox elements (allowQuartersEl.checked…)
     and four globals. We recreate them backed by SET, set per generate(). */
  let SET = { cats: {} };
  var CATEGORY_DENSITY = {};   // key -> notes per beat; filled at load by orderCategoriesBySpeed()
  var BITS_TO_NOTES = null;    // buildV2Families' bitsToNotes(bits, slotBeats, baseDur); shared with fillers
  var FAMILY_BASE = {};        // key -> the family's own note value ("16s" -> "16"); same IIFE
  var FAMILY_DOTTED = {};      // families whose FULL run is entirely dotted (dottedQ, dotted8)

  /* The two Setup sliders, Rests and Subdivision, both sit at 50 = NEUTRAL: the multiplier is exactly
     1.0, so a centred slider changes nothing and generation is purely each variant's own w. Below 50
     favours the slow / filled end, above 50 the fast / sparse end. exp() keeps it smooth and monotonic
     with no cliff at the ends (Anthony, 2026-07-21). */
  function biasMul(x, sliderPct, k) {
      var s = ((sliderPct == null ? 50 : sliderPct) - 50) / 50;      // -1 .. +1
      if (!s) return 1;
      return Math.exp(k * s * (x - 0.5));
  }
  /* SPARSITY — how holey the chosen rhythm figure is, e.g. "R 2-3-4" instead of "1-2-3-4". An absolute
     target you can read off the label rather than a neutral-at-50 bias, because "how much of this figure
     is silence" means something on its own: 0% = only rest-free figures, 100% = the holeyest available.
     This is a SEPARATE axis from the Rests slider, which silences whole beats between figures and has
     nothing to do with any rhythm (Anthony, 2026-07-21 — the two used to share one slider, which is why
     it was impossible to reason about). Subdivision stays a neutral-at-50 bias instead, because "how
     fast" only means anything relative to the rhythms you actually checked.
     SPARSITY_CEILING is measured, not guessed: past ~0.5 the packer can't place more silence. */
  /* SPARSITY = HOW MANY NOTES the figure has, not how much of it is silence (Anthony, 2026-07-21).
     0% = every slot struck (16ths → 4 notes per beat); 100% = ONE note (16ths → a single note per
     beat). It stops at one and never zero, because an empty beat is the REST slider's job — Rests is
     the silence BETWEEN figures, Sparsity is the note count WITHIN one.
     Measuring rest fraction (the old metric) was wrong: "16s_1000" is a bare quarter — no rests at all
     but a single attack — so it scored perfectly at 0%, the exact opposite of "completely filled". */
  function slotCount(v) {
      var m = /([01]+)$/.exec(v.id || "");
      return m ? m[1].length : v.notes.length;      // named idioms have no bit string
  }
  function attackCount(v) {
      var n = 0;
      v.notes.forEach(function (x) { if (x.kind !== "rest") n++; });
      return n;
  }
  function sparsityBias(v, sliderPct) {
      var s = (sliderPct == null ? 50 : sliderPct) / 100;
      var N = Math.max(1, slotCount(v));
      var fill = attackCount(v) / N;                          // 1 = full run
      var targetFill = 1 - (1 - 1 / N) * s;                   // s=0 → 1 (all N), s=1 → 1/N (one note)
      return Math.exp(-6 * Math.abs(fill - targetFill));
  }
  /* How much the Subdivision slider WANTS a given candidate pool, as a multiplier on that bucket's own
     firing chance. Choosing between categories is not enough: a bucket that holds only one family (the
     3-beat bucket is all dotted8; the 0.75 bucket is all fast ratios) has nothing to choose between, so
     it fired at full strength however the slider was set — slow figures kept turning up at 100% and fast
     ones at 0%. Scaling the bucket's own probability is what actually gates them. (Anthony, 2026-07-21) */
  function subdivNorm(t) {
      var keys = Object.keys(CATEGORY_DENSITY).filter(function (k) {
          return !(SET.cats && SET.cats[k] === false);
      });
      if (!keys.length) return 0.5;
      var vals = keys.map(function (k) { return CATEGORY_DENSITY[k]; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var d = CATEGORY_DENSITY[t];
      if (d == null || !(hi > lo)) return 0.5;
      return (d - lo) / (hi - lo);
  }
  function subdivWant(list) {
      if (!list || !list.length) return 1;
      var seen = {}, n = 0, sum = 0;
      list.forEach(function (v) {
          var t = v._type;
          if (t && !seen[t]) { seen[t] = 1; sum += subdivNorm(t); n++; }
      });
      return n ? biasMul(sum / n, SET.subdiv, 10) : 1;
  }
  /* A rhythm's chance must not depend on the SPAN it happens to occupy. Quarter triplets are 2 beats
     and could only arrive through a bucket that fired on a flat 10% roll, so they showed up 0.6% of the
     time while 1-beat families got 3-9%; dotted 8ths sat in TWO buckets (1.5 and 3) and were over-served.
     famWeight = how much rhythm actually lives in a pool — one share per distinct family, scaled by the
     Subdivision bias — so every family competes on equal terms whatever its length.
     (Anthony, 2026-07-21: "every rhythm should have an equal chance") */
  function famWeight(list) {
      var seen = {}, w = 0;
      (list || []).forEach(function (v) {
          var t = v._type;
          if (!t || seen[t]) return;
          seen[t] = 1;
          w += biasMul(subdivNorm(t), SET.subdiv, 10);
      });
      return w;
  }
  function restFraction(v) {
      var tot = 0, rest = 0;
      v.notes.forEach(function (n) {
          tot += (n.beats || 0);
          if (n.kind === "rest" || n.rest) rest += (n.beats || 0);
      });
      return tot > 0 ? rest / tot : 0;
  }
  const box = (key) => ({ get checked() { const c = SET.cats || {}; return c[key] !== false; } });
  const allowQuartersEl          = box("q");
  const allowDottedQuartersEl    = box("dottedQ");
  const allow8thsEl              = box("8s");
  const allow16thsEl             = box("16s");
  const allowTripletsEl          = box("8t");
  const allowQuarterTripletsEl   = box("qt");
  const allowQuintupletsEl       = box("5let");
  const allow16thQuintupletsEl   = box("5let16");
  const allowSextupletsEl        = box("6let");
  const allow9letsEl             = box("9let");
  const allow32ndsEl             = box("32nd");   // half-beat fillers can be four 32nds
  // Engine V2 categories are gated generically off SET.cats (no dedicated shim each). Keep in sync
  // with the buildV2Families() keys + the CATEGORIES registry below.
  const V2_CATEGORY_KEYS = ["7let", "7let8", "32nd", "dotted8",
                            "r43", "r53", "r73", "r83", "r46", "r56", "r76", "r86"];

  let activeVariations  = new Set();   // filled with ALL ids after the bank is defined
  let currentLeadHand   = "R";
  let isStickingVisible = true;
  let currentShowCounts = true;
  // the sticking applySticking last ran with — oppositeHandAfterRolls needs it to know whether a fixed
  // pattern is in play, and it has to survive into restyle()'s separate call
  let currentStickingStrategy = "natural";

  // the fixed-pattern stickings: their shape is the point, so an ornament may not rewrite it
  const RUDIMENT_STICKINGS = ["alternate", "doubles", "paradiddle"];

  // CONSTANT: Pulse Maps for Asymmetric Meters
  const PULSE_PATTERNS = {
      "5/8": [[1.5, 1.0], [1.0, 1.5]],
      "7/8": [[1.5, 1.0, 1.0], [1.0, 1.5, 1.0], [1.0, 1.0, 1.5]],
      "9/8_asym": [[1.5, 1.0, 1.0, 1.0], [1.0, 1.5, 1.0, 1.0], [1.0, 1.0, 1.5, 1.0], [1.0, 1.0, 1.0, 1.5]]
  };

  // ---------- Rhythm model ----------

  // HELPER: Forces "Preserve" mode so the engine does not auto-correct your designs
  // isFallback = true means it's random filler (can be cleaned up)
  // isFallback = false (default) means it came from a Tile (MUST BE PRESERVED)
  const make = (dur, beats, dots = 0, isFallback = false) => ({ 
      kind: "note", dur, beats, dots, 
      _preserve: !isFallback 
  });
  
  const R = (dur, beats, dots = 0) => ({ 
      kind: "rest", dur, beats, dots, 
      _preserve: true 
  });

  // (Deleted 150 lines of dead code: pickCompoundBeatPattern & simplifyCompoundChunk)

// This replaces the "Math Generator" with a "Curated Database"
// You can edit, delete, or add lines here to control EXACTLY what appears in the picker.















const RHYTHM_VARIANTS = {
    // === 1. Simple Beats ===
"q": [ 
        // 1. Simple Time (1.0 beat)
        { id: "q_1", label: "Quarter Note", notes: [make("q", 1.0)], w: 10 },

        // 2. COMPOUND QUARTER VARIATIONS (3.0 Beats -> 2 Pulses)
        // Note: Dotted Quarter (1.5) has been REMOVED.
        
        // 111 (Full): q q q
        { id: "q_cmp_111", label: "Full (3)", notes: [make("q", 1.0), make("q", 1.0), make("q", 1.0)], w: 10, _isCompoundVariant: true },
        
        // 110 (Long-Short): q q r
        { id: "q_cmp_110", label: "Long-Short", notes: [make("q", 1.0), make("q", 1.0), R("q", 1.0)], w: 6, _isCompoundVariant: true },
        
        // 101 (Swing): q r q
        { id: "q_cmp_101", label: "Swing (1...3)", notes: [make("q", 1.0), R("q", 1.0), make("q", 1.0)], w: 6, _isCompoundVariant: true },
        
        // 100 (Start): q r r (Rest is Half Note 2.0)
        { id: "q_cmp_100", label: "Start Only", notes: [make("q", 1.0), R("h", 2.0)], w: 5, _isCompoundVariant: true },

        // 011 (Pickup): r q q
        { id: "q_cmp_011", label: "Pickup (2-3)", notes: [R("q", 1.0), make("q", 1.0), make("q", 1.0)], w: 6, _isCompoundVariant: true },
        
        // 010 (Middle): r q r
        { id: "q_cmp_010", label: "Middle Only", notes: [R("q", 1.0), make("q", 1.0), R("q", 1.0)], w: 4, _isCompoundVariant: true },
        
        // 001 (End): r r q
        { id: "q_cmp_001", label: "End Only", notes: [R("h", 2.0), make("q", 1.0)], w: 4, _isCompoundVariant: true }
    ],

    "dottedQ": [ 
        // ============================
        // === 1. PULSE (1.5 Beats) ===
        // ============================
        // NEW: Allows this tile to work in 5/8, 6/8, etc.
        { id: "dq_1", label: "Dotted Quarter (Pulse)", notes: [make("q", 1.5, 1)], w: 10 },

        // ============================
        // === 3-BEAT BUCKETS (4/4) ===
        // ============================
        // Always allowed if Dotted Quarters are ON
        { id: "dq3_std", label: "3-Beat Chain (q. q.)", notes: [make("q", 1.5, 1), make("q", 1.5, 1)], w: 10 },
        { id: "dq3_rest", label: "3-Beat Chain (Rest)", notes: [R("q", 1.5, 1), make("q", 1.5, 1)], w: 8 },

        // ============================
        // === 2-BEAT BUCKETS (4/4) ===
        // ============================
        
        // --- A. STANDARD (1.5 + 0.5) ---
        // Always allowed
        { id: "dq_std_rest", label: "Standard (Rest)", notes: [make("q", 1.5, 1), R("8", 0.5)], w: 10 },
        
        // Depends on 8ths OR 16ths
        { id: "dq_std_8", label: "Standard (8th)", notes: [make("q", 1.5, 1), make("8", 0.5)], w: 10 },
        
        // Depends on 16ths
        { id: "dq_std_16s", label: "Standard (16ths)", notes: [make("q", 1.5, 1), make("16", 0.25), make("16", 0.25)], w: 8 },
        
        // Depends on Sextuplets
        { 
            id: "dq_std_6let", 
            label: "Standard (Trip)", 
            notes: [
                make("q", 1.5, 1), 
                {...make("16", 1/6), _localTuplet: true}, 
                {...make("16", 1/6), _localTuplet: true}, 
                {...make("16", 1/6), _localTuplet: true}
            ], 
            w: 5 
        },

        // --- B. REVERSE / ANTICIPATED (0.5 + 1.5) ---
        // Always allowed
        { id: "dq_rev_rest", label: "Reverse (Rest)", notes: [R("8", 0.5), make("q", 1.5, 1)], w: 10 },
        
        // Depends on 8ths OR 16ths
        { id: "dq_rev_8", label: "Reverse (8th)", notes: [make("8", 0.5), make("q", 1.5, 1)], w: 10 },
        
        // Depends on 16ths
        { id: "dq_rev_16s", label: "Reverse (16ths)", notes: [make("16", 0.25), make("16", 0.25), make("q", 1.5, 1)], w: 8 },
        
        // Depends on Sextuplets
        { 
            id: "dq_rev_6let", 
            label: "Reverse (Trip)", 
            notes: [
                {...make("16", 1/6), _localTuplet: true}, 
                {...make("16", 1/6), _localTuplet: true}, 
                {...make("16", 1/6), _localTuplet: true},
                make("q", 1.5, 1)
            ], 
            w: 5 
        }
    ],


    "8s": [
        // === Simple Time (Standard) ===
        { id: "8s_11", label: "2 8ths", notes: [make("8", 0.5), make("8", 0.5)], w: 10 },
        { id: "8s_10", label: "Quarter (10)", notes: [make("q", 1.0)], w: 5 },
        { id: "8s_01", label: "& of 1", notes: [R("8", 0.5), make("8", 0.5)], w: 5 },
        
        // === Compound Time (The 6 Triplet Modulations) ===
        // We use _preserve:true to FORCE exact notation (preventing 8-8-8r -> 8-q bugs)
        
        // 1. Full (1-1-1) -> 8-8-8
        { id: "8s_c_111", label: "1-2-3", notes: [make("8", 0.5), make("8", 0.5), make("8", 0.5)], w: 10, _isCompoundVariant: true, _preserve: true },
        
        // 2. Trip-let-rest (1-1-0) -> 8-8-8r
        { id: "8s_c_110", label: "1-2-R", notes: [make("8", 0.5), make("8", 0.5), R("8", 0.5)], w: 6, _isCompoundVariant: true, _preserve: true },
        
        // 3. Swing (1-0-1) -> Q-8
        { id: "8s_c_101", label: "1-(2)-3", notes: [make("q", 1.0), make("8", 0.5)], w: 8, _isCompoundVariant: true, _preserve: true },
        { id: "8s_c_100", label: "1 (d.quarter)", notes: [make("q", 1.5, 1)], w: 5, _isCompoundVariant: true, _preserve: true },
        
        // 4. Rest-let-trip (0-1-1) -> 8r-8-8
        { id: "8s_c_011", label: "R-2-3", notes: [R("8", 0.5), make("8", 0.5), make("8", 0.5)], w: 6, _isCompoundVariant: true, _preserve: true },
        
        // 5. Middle Note (0-1-0) -> 8r-Q
        { id: "8s_c_010", label: "R-2-(3)", notes: [R("8", 0.5), make("q", 1.0)], w: 4, _isCompoundVariant: true, _preserve: true },
        
        // 6. Last Note (0-0-1) -> Qr-8
        { id: "8s_c_001", label: "R-(2)-3", notes: [R("q", 1.0), make("8", 0.5)], w: 4, _isCompoundVariant: true, _preserve: true }
    ],

    // === 2. 16th Note Grid (Curated for readability) ===
    "16s": [
        // 4 Notes
        { id: "16s_1111", label: "1 e & a", notes: [make("16", 0.25), make("16", 0.25), make("16", 0.25), make("16", 0.25)], w: 10 },
        
        // 3 Notes
        // FIX: Changed "16, 16, 16, 16r" to "16, 16, 8" (Sustains the &)
        { id: "16s_1110", label: "1 e &", notes: [make("16", 0.25), make("16", 0.25), make("8", 0.5)], w: 6 },
        { id: "16s_1101", label: "Reverse Gallop", notes: [make("16", 0.25), make("8", 0.5), make("16", 0.25)], w: 8 },
        { id: "16s_1011", label: "Gallop (1 &a)", notes: [make("8", 0.5), make("16", 0.25), make("16", 0.25)], w: 8 },
        { id: "16s_0111", label: "e & a", notes: [R("16", 0.25), make("16", 0.25), make("16", 0.25), make("16", 0.25)], w: 6 },
        
        // 2 Notes
        // FIX: Changed "16, 16, 8r" to "16, dotted-8" (Sustains the e)
        { id: "16s_1100", label: "1 e", notes: [make("16", 0.25), make("8", 0.75, 1)], w: 6 },
        
        { id: "16s_1010", label: "1 & (8ths)", notes: [make("8", 0.5), make("8", 0.5)], w: 2 }, 
        { id: "16s_1001", label: "1 ... a", notes: [make("8", 0.75, 1), make("16", 0.25)], w: 7 },
        
        // FIX: Changed end rest to sustained note
        { id: "16s_0110", label: "e &", notes: [R("16", 0.25), make("16", 0.25), make("8", 0.5)], w: 6 },
        
        { id: "16s_0101", label: "Off-beats (e a)", notes: [R("16", 0.25), make("8", 0.5), make("16", 0.25)], w: 4 },
        { id: "16s_0011", label: "& a", notes: [R("8", 0.5), make("16", 0.25), make("16", 0.25)], w: 6 },
        
        // 1 Note (Syncopation)
        { id: "16s_1000", label: "Quarter (1000)", notes: [make("q", 1.0)], w: 5 },
        { id: "16s_0100", label: "e", notes: [R("16", 0.25), make("8", 0.75, 1)], w: 5 },
        { id: "16s_0010", label: "&", notes: [R("8", 0.5), make("8", 0.5)], w: 2 },
        { id: "16s_0001", label: "a", notes: [R("8", 0.75, 1), make("16", 0.25)], w: 5 }
    ],

    // === 3. Triplets (Standard) ===
    "8t": [
        { id: "8t_111", label: "Trip-let-trip", notes: [make("8", 1/3), make("8", 1/3), make("8", 1/3)], w: 10 },
        { id: "8t_110", label: "Trip-let-rest", notes: [make("8", 1/3), make("8", 1/3), R("8", 1/3)], w: 6 },
        { id: "8t_101", label: "Swing (Trip-skip-trip)", notes: [make("q", 2/3), make("8", 1/3)], w: 8 },
        // NO TUPLET BRACKET FOR QUARTER NOTE
        { id: "8t_100", label: "Quarter (100)", notes: [make("q", 1.0)], w: 5, _tuplet: false }, 
        { id: "8t_011", label: "Rest-let-trip", notes: [R("8", 1/3), make("8", 1/3), make("8", 1/3)], w: 6 },
        { id: "8t_010", label: "Middle note", notes: [R("8", 1/3), make("q", 2/3)], w: 4 }, 
        { id: "8t_001", label: "Last note", notes: [R("q", 2/3), make("8", 1/3)], w: 4 }
    ],

// === 4. Quarter Triplets (3 notes over 2 beats) ===
    "qt": [
        // 111 (Note-Note-Note)
        { id: "qt_111", label: "Full Triplet", notes: [make("q", 2/3), make("q", 2/3), make("q", 2/3)], w: 10 },
        
        // 110 (Note-Note-Rest)
        { id: "qt_110", label: "Long-Short", notes: [make("q", 2/3), make("q", 2/3), R("q", 2/3)], w: 6 },
        
        // 101 (Note-Rest-Note)
        { id: "qt_101", label: "Swing (1 ... 3)", notes: [make("q", 2/3), R("q", 2/3), make("q", 2/3)], w: 6 },
        
        // 100 (Quarter + Quarter Rest)
        // NO TUPLET BRACKET (Standard 2 beats)
        { id: "qt_100", label: "Quarter+Rest", notes: [make("q", 1.0), R("q", 1.0)], w: 5, _tuplet: false },

        // 011 (Rest-Note-Note)
        { id: "qt_011", label: "Pickup (2-3)", notes: [R("q", 2/3), make("q", 2/3), make("q", 2/3)], w: 6 },
        
        // 010 (Rest-Note-Rest)
        { id: "qt_010", label: "Middle Only", notes: [R("q", 2/3), make("q", 2/3), R("q", 2/3)], w: 4 },
        
        // 001 (Rest-Rest-Note)
        { id: "qt_001", label: "Last Only", notes: [R("q", 2/3), R("q", 2/3), make("q", 2/3)], w: 4 }
    ],

// === 5. Quintuplets (5 notes over 2 beats) ===
    "5let": [
        // ============================
        // === 5 NOTES ===
        // ============================
        // 11111 (31)
        { id: "5let_11111", label: "Full 5", notes: Array(5).fill(make("8", 0.4)), w: 10 },

        // ============================
        // === 4 NOTES ===
        // ============================
        // 11110 (30) -> 1, 2, 3, 4(2)
        { id: "5let_11110", label: "1-2-3-4(q)", notes: [make("8", 0.4), make("8", 0.4), make("8", 0.4), make("q", 0.8)], w: 5 },
        // 11101 (29) -> 1, 2, 3(2), 5
        { id: "5let_11101", label: "1-2-3(q)-5", notes: [make("8", 0.4), make("8", 0.4), make("q", 0.8), make("8", 0.4)], w: 5 },
        // 11011 (27) -> 1, 2(2), 4, 5
        { id: "5let_11011", label: "1-2(q)-4-5", notes: [make("8", 0.4), make("q", 0.8), make("8", 0.4), make("8", 0.4)], w: 5 },
        // 10111 (23) -> 1(2), 3, 4, 5
        { id: "5let_10111", label: "1(q)-3-4-5", notes: [make("q", 0.8), make("8", 0.4), make("8", 0.4), make("8", 0.4)], w: 5 },
        // 01111 (15) -> R, 2, 3, 4, 5
        { id: "5let_01111", label: "R-2-3-4-5", notes: [R("8", 0.4), make("8", 0.4), make("8", 0.4), make("8", 0.4), make("8", 0.4)], w: 5 },

        // ============================
        // === 3 NOTES ===
        // ============================
        // 11100 (28) -> 1, 2, 3(3)
        { id: "5let_11100", label: "1-2-3(d.q)", notes: [make("8", 0.4), make("8", 0.4), make("q", 1.2, 1)], w: 5 },
        // 11010 (26) -> 1, 2(2), 4(2)
        { id: "5let_11010", label: "1-2(q)-4(q)", notes: [make("8", 0.4), make("q", 0.8), make("q", 0.8)], w: 5 },
        // 11001 (25) -> 1, 2(3), 5
        { id: "5let_11001", label: "1-2(d.q)-5", notes: [make("8", 0.4), make("q", 1.2, 1), make("8", 0.4)], w: 5 },
        // 10110 (22) -> 1(2), 3, 4(2)
        { id: "5let_10110", label: "1(q)-3-4(q)", notes: [make("q", 0.8), make("8", 0.4), make("q", 0.8)], w: 5 },
        // 10101 (21) -> 1(2), 3(2), 5
        { id: "5let_10101", label: "1(q)-3(q)-5", notes: [make("q", 0.8), make("q", 0.8), make("8", 0.4)], w: 5 },
        // 10011 (19) -> 1(3), 4, 5
        { id: "5let_10011", label: "1(d.q)-4-5", notes: [make("q", 1.2, 1), make("8", 0.4), make("8", 0.4)], w: 5 },
        // 01110 (14) -> R, 2, 3, 4(2)
        { id: "5let_01110", label: "2-3-4(q)", notes: [R("8", 0.4), make("8", 0.4), make("8", 0.4), make("q", 0.8)], w: 5 },
        // 01101 (13) -> R, 2, 3(2), 5
        { id: "5let_01101", label: "2-3(q)-5", notes: [R("8", 0.4), make("8", 0.4), make("q", 0.8), make("8", 0.4)], w: 5 },
        // 01011 (11) -> R, 2(2), 4, 5
        { id: "5let_01011", label: "2(q)-4-5", notes: [R("8", 0.4), make("q", 0.8), make("8", 0.4), make("8", 0.4)], w: 5 },
        // 00111 (7) -> R(2), 3, 4, 5
        { id: "5let_00111", label: "3-4-5", notes: [R("q", 0.8), make("8", 0.4), make("8", 0.4), make("8", 0.4)], w: 5 },

        // ============================
        // === 2 NOTES ===
        // ============================
        // 11000 (24) -> 1, 2(4)
        { id: "5let_11000", label: "1-2(h)", notes: [make("8", 0.4), make("h", 1.6)], w: 4 },
        // 10100 (20) -> 1(2), 3(3)
        { id: "5let_10100", label: "1(q)-3(d.q)", notes: [make("q", 0.8), make("q", 1.2, 1)], w: 4 },
        // 10010 (18) -> 1(3), 4(2)
        { id: "5let_10010", label: "1(d.q)-4(q)", notes: [make("q", 1.2, 1), make("q", 0.8)], w: 4 },
        // 10001 (17) -> 1(4), 5
        { id: "5let_10001", label: "1(h)-5", notes: [make("h", 1.6), make("8", 0.4)], w: 4 },
        // 01100 (12) -> R, 2, 3(3)
        { id: "5let_01100", label: "2-3(d.q)", notes: [R("8", 0.4), make("8", 0.4), make("q", 1.2, 1)], w: 4 },
        // 01010 (10) -> R, 2(2), 4(2)
        { id: "5let_01010", label: "2(q)-4(q)", notes: [R("8", 0.4), make("q", 0.8), make("q", 0.8)], w: 4 },
        // 01001 (9) -> R, 2(3), 5
        { id: "5let_01001", label: "2(d.q)-5", notes: [R("8", 0.4), make("q", 1.2, 1), make("8", 0.4)], w: 4 },
        // 00110 (6) -> R(2), 3, 4(2)
        { id: "5let_00110", label: "3-4(q)", notes: [R("q", 0.8), make("8", 0.4), make("q", 0.8)], w: 4 },
        // 00101 (5) -> R(2), 3(2), 5
        { id: "5let_00101", label: "3(q)-5", notes: [R("q", 0.8), make("q", 0.8), make("8", 0.4)], w: 4 },
        // 00011 (3) -> R(3), 4, 5
        { id: "5let_00011", label: "4-5", notes: [R("q", 1.2, 1), make("8", 0.4), make("8", 0.4)], w: 4 },

        // ============================
        // === 1 NOTE ===
        // ============================
        // 10000 (16) -> Quarter + Rest (2 beats)
        // NO TUPLET BRACKET
        { id: "5let_10000", label: "Quarter+Rest", notes: [make("q", 1.0), R("q", 1.0)], w: 5, _tuplet: false },
        // 01000 (8) -> R, 2(4)
        { id: "5let_01000", label: "2 Only", notes: [R("8", 0.4), make("h", 1.6)], w: 3 },
        // 00100 (4) -> R(2), 3(3)
        { id: "5let_00100", label: "3 Only", notes: [R("q", 0.8), make("q", 1.2, 1)], w: 3 },
        // 00010 (2) -> R(3), 4(2)
        { id: "5let_00010", label: "4 Only", notes: [R("q", 1.2, 1), make("q", 0.8)], w: 3 },
        // 00001 (1) -> R(4), 5
        { id: "5let_00001", label: "5 Only", notes: [R("h", 1.6), make("8", 0.4)], w: 3 }
    ],

// === 16th Note Quintuplets (5 notes over 1 beat) ===
    "5let16": [
        // ============================
        // === 5 NOTES ===
        // ============================
        // 11111 (31)
        { id: "5let16_11111", label: "Full 5", notes: Array(5).fill(make("16", 0.2)), w: 10 },

        // ============================
        // === 4 NOTES ===
        // ============================
        // 11110 (30) -> 1, 2, 3, 4(2)
        { id: "5let16_11110", label: "1-2-3-4(8)", notes: [make("16", 0.2), make("16", 0.2), make("16", 0.2), make("8", 0.4)], w: 5 },
        // 11101 (29) -> 1, 2, 3(2), 5
        { id: "5let16_11101", label: "1-2-3(8)-5", notes: [make("16", 0.2), make("16", 0.2), make("8", 0.4), make("16", 0.2)], w: 5 },
        // 11011 (27) -> 1, 2(2), 4, 5
        { id: "5let16_11011", label: "1-2(8)-4-5", notes: [make("16", 0.2), make("8", 0.4), make("16", 0.2), make("16", 0.2)], w: 5 },
        // 10111 (23) -> 1(2), 3, 4, 5
        { id: "5let16_10111", label: "1(8)-3-4-5", notes: [make("8", 0.4), make("16", 0.2), make("16", 0.2), make("16", 0.2)], w: 5 },
        // 01111 (15) -> R, 2, 3, 4, 5
        { id: "5let16_01111", label: "R-2-3-4-5", notes: [R("16", 0.2), make("16", 0.2), make("16", 0.2), make("16", 0.2), make("16", 0.2)], w: 5 },

        // ============================
        // === 3 NOTES ===
        // ============================
        // 11100 (28) -> 1, 2, 3(3)
        { id: "5let16_11100", label: "1-2-3(d8)", notes: [make("16", 0.2), make("16", 0.2), make("8", 0.6, 1)], w: 5 },
        // 11010 (26) -> 1, 2(2), 4(2)
        { id: "5let16_11010", label: "1-2(8)-4(8)", notes: [make("16", 0.2), make("8", 0.4), make("8", 0.4)], w: 5 },
        // 11001 (25) -> 1, 2(3), 5
        { id: "5let16_11001", label: "1-2(d8)-5", notes: [make("16", 0.2), make("8", 0.6, 1), make("16", 0.2)], w: 5 },
        // 10110 (22) -> 1(2), 3, 4(2)
        { id: "5let16_10110", label: "1(8)-3-4(8)", notes: [make("8", 0.4), make("16", 0.2), make("8", 0.4)], w: 5 },
        // 10101 (21) -> 1(2), 3(2), 5
        { id: "5let16_10101", label: "1(8)-3(8)-5", notes: [make("8", 0.4), make("8", 0.4), make("16", 0.2)], w: 5 },
        // 10011 (19) -> 1(3), 4, 5
        { id: "5let16_10011", label: "1(d8)-4-5", notes: [make("8", 0.6, 1), make("16", 0.2), make("16", 0.2)], w: 5 },
        // 01110 (14) -> R, 2, 3, 4(2)
        { id: "5let16_01110", label: "2-3-4(8)", notes: [R("16", 0.2), make("16", 0.2), make("16", 0.2), make("8", 0.4)], w: 5 },
        // 01101 (13) -> R, 2, 3(2), 5
        { id: "5let16_01101", label: "2-3(8)-5", notes: [R("16", 0.2), make("16", 0.2), make("8", 0.4), make("16", 0.2)], w: 5 },
        // 01011 (11) -> R, 2(2), 4, 5
        { id: "5let16_01011", label: "2(8)-4-5", notes: [R("16", 0.2), make("8", 0.4), make("16", 0.2), make("16", 0.2)], w: 5 },
        // 00111 (7) -> R, 2(2), 4, 5
        { id: "5let16_00111", label: "3-4-5", notes: [R("8", 0.4), make("16", 0.2), make("16", 0.2), make("16", 0.2)], w: 5 },

        // ============================
        // === 2 NOTES ===
        // ============================
        // 11000 (24) -> 1, 2(4)
        { id: "5let16_11000", label: "1-2(q)", notes: [make("16", 0.2), make("q", 0.8)], w: 4 },
        // 10100 (20) -> 1(2), 3(3)
        { id: "5let16_10100", label: "1(8)-3(d8)", notes: [make("8", 0.4), make("8", 0.6, 1)], w: 4 },
        // 10010 (18) -> 1(3), 4(2)
        { id: "5let16_10010", label: "1(d8)-4(8)", notes: [make("8", 0.6, 1), make("8", 0.4)], w: 4 },
        // 10001 (17) -> 1(4), 5
        { id: "5let16_10001", label: "1(q)-5", notes: [make("q", 0.8), make("16", 0.2)], w: 4 },
        // 01100 (12) -> R, 2, 3(3)
        { id: "5let16_01100", label: "2-3(d8)", notes: [R("16", 0.2), make("16", 0.2), make("8", 0.6, 1)], w: 4 },
        // 01010 (10) -> R, 2(2), 4(2)
        { id: "5let16_01010", label: "2(8)-4(8)", notes: [R("16", 0.2), make("8", 0.4), make("8", 0.4)], w: 4 },
        // 01001 (9) -> R, 2(3), 5
        { id: "5let16_01001", label: "2(d8)-5", notes: [R("16", 0.2), make("8", 0.6, 1), make("16", 0.2)], w: 4 },
        // 00110 (6) -> R, 2, 3, 4(2)
        { id: "5let16_00110", label: "3-4(8)", notes: [R("8", 0.4), make("16", 0.2), make("8", 0.4)], w: 4 },
        // 00101 (5) -> R(2), 3(2), 5
        { id: "5let16_00101", label: "3(8)-5", notes: [R("8", 0.4), make("8", 0.4), make("16", 0.2)], w: 4 },
        // 00011 (3) -> R(3), 4, 5
        { id: "5let16_00011", label: "4-5", notes: [R("8", 0.6, 1), make("16", 0.2), make("16", 0.2)], w: 4 },

        // ============================
        // === 1 NOTE ===
        // ============================
        // 10000 (16) -> Quarter (10000)
        // NO TUPLET BRACKET
        { id: "5let16_10000", label: "Quarter (10000)", notes: [make("q", 1.0)], w: 5, _tuplet: false },
        // 01000 (8) -> R, 2(4)
        { id: "5let16_01000", label: "2 Only", notes: [R("16", 0.2), make("q", 0.8)], w: 3 },
        // 00100 (4) -> R(2), 3(3)
        { id: "5let16_00100", label: "3 Only", notes: [R("8", 0.4), make("8", 0.6, 1)], w: 3 },
        // 00010 (2) -> R(3), 4(2)
        { id: "5let16_00010", label: "4 Only", notes: [R("8", 0.6, 1), make("8", 0.4)], w: 3 },
        // 00001 (1) -> R(4), 5
        { id: "5let16_00001", label: "5 Only", notes: [R("q", 0.8), make("16", 0.2)], w: 3 }
    ],

    // === 6. Sextuplets (6 notes over 1 beat) ===
    "6let": [
        // ============================
        // === 6 NOTES ===
        // ============================
        { id: "6let_111111", label: "Full 6", notes: Array(6).fill(make("16", 1/6)), w: 10 },

        // ============================
        // === 5 NOTES ===
        // ============================
        { id: "6let_111110", label: "1-2-3-4-5(8t)", notes: [make("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_111101", label: "1-2-3-4(8t)-6", notes: [make("16", 1/6), make("16", 1/6), make("16", 1/6), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_111011", label: "1-2-3(8t)-5-6", notes: [make("16", 1/6), make("16", 1/6), make("8", 1/3), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_110111", label: "1-2(8t)-4-5-6", notes: [make("16", 1/6), make("8", 1/3), make("16", 1/6), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_101111", label: "1(8t)-3-4-5-6", notes: [make("8", 1/3), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_011111", label: "R-2-3-4-5-6", notes: [R("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6)], w: 5 },

        // ============================
        // === 4 NOTES (HYBRIDS: NO "6", YES "3") ===
        // ============================
        // 111100 -> 16th Triplet + 8th Note
        { 
            id: "6let_111100", 
            label: "1-2-3(Trip)-4", 
            notes: [
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("8", 0.5), _isHybrid: true} 
            ], 
            // render: false tells the renderer to SKIP the global "6" bracket entirely
            _tuplet: {num_notes:6, notes_occupied:4, render: false}, 
            w: 6 
        },

        { id: "6let_111010", label: "1-2-3-5(8t)", notes: [make("16", 1/6), make("16", 1/6), make("8", 1/3), make("8", 1/3)], w: 5 },
        { id: "6let_111001", label: "1-2-3-6", notes: [make("16", 1/6), make("16", 1/6), make("8", 0.5, 1), make("16", 1/6)], w: 5 },
        { id: "6let_110110", label: "1-2(8t)-4-5(8t)", notes: [make("16", 1/6), make("8", 1/3), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_110101", label: "1-2(8t)-4(8t)-6", notes: [make("16", 1/6), make("8", 1/3), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_110011", label: "1-2(d8)-5-6", notes: [make("16", 1/6), make("8", 0.5, 1), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_101110", label: "1(8t)-3-4-5(8t)", notes: [make("8", 1/3), make("16", 1/6), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_101101", label: "1(8t)-3-4(8t)-6", notes: [make("8", 1/3), make("16", 1/6), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_101011", label: "1(8t)-3(8t)-5-6", notes: [make("8", 1/3), make("8", 1/3), make("16", 1/6), make("16", 1/6)], w: 5 },

        // 100111 -> 8th Note + 16th Triplet
        { 
            id: "6let_100111", 
            label: "1(8)-4-5-6(Trip)", 
            notes: [
                {...make("8", 0.5), _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}
            ], 
            _tuplet: {num_notes:6, notes_occupied:4, render: false}, 
            w: 6 
        },

        { id: "6let_011110", label: "R-2-3-4-5(8t)", notes: [R("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_011101", label: "R-2-3-4(8t)-6", notes: [R("16", 1/6), make("16", 1/6), make("16", 1/6), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_011011", label: "R-2-3(8t)-5-6", notes: [R("16", 1/6), make("16", 1/6), make("8", 1/3), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_010111", label: "R-2(8t)-4-5-6", notes: [R("16", 1/6), make("8", 1/3), make("16", 1/6), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_001111", label: "R(8t)-3-4-5-6", notes: [R("8", 1/3), make("16", 1/6), make("16", 1/6), make("16", 1/6), make("16", 1/6)], w: 5 },

        // ============================
        // === 3 NOTES (HYBRIDS: NO "6", YES "3") ===
        // ============================
        // 111000 -> 16th Triplet + 8th Rest
        { 
            id: "6let_111000", 
            label: "1-2-3(Trip)-R", 
            notes: [
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...R("8", 0.5), _isHybrid: true}
            ], 
            _tuplet: {num_notes:6, notes_occupied:4, render: false},
            w: 6 
        },

        { id: "6let_110100", label: "1-2(8t)-4(d8)", notes: [make("16", 1/6), make("8", 1/3), make("8", 0.5, 1)], w: 5 },
        { id: "6let_110010", label: "1-2(d8)-5(8t)", notes: [make("16", 1/6), make("8", 0.5, 1), make("8", 1/3)], w: 5 },
        { id: "6let_110001", label: "1-2(q)-6", notes: [make("16", 1/6), make("q", 2/3), make("16", 1/6)], w: 5 },
        { id: "6let_101100", label: "1(8t)-3-4(d8)", notes: [make("8", 1/3), make("16", 1/6), make("8", 0.5, 1)], w: 5 },
        { id: "6let_101010", label: "Triplets", notes: [make("8", 1/3), make("8", 1/3), make("8", 1/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 6 },
        { id: "6let_101001", label: "1(8t)-3(d8)-6", notes: [make("8", 1/3), make("8", 0.5, 1), make("16", 1/6)], w: 5 },
        { id: "6let_100110", label: "1(d8)-4-5(8t)", notes: [make("8", 0.5, 1), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_100101", label: "1(d8)-4(8t)-6", notes: [make("8", 0.5, 1), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_100011", label: "1(q)-5-6", notes: [make("q", 2/3), make("16", 1/6), make("16", 1/6)], w: 5 },

        { id: "6let_011010", label: "R-2-3(8t)-5(8t)", notes: [R("16", 1/6), make("16", 1/6), make("8", 1/3), make("8", 1/3)], w: 5 },
        { id: "6let_011001", label: "R-2-3(d8)-6", notes: [R("16", 1/6), make("16", 1/6), make("8", 0.5, 1), make("16", 1/6)], w: 5 },
        { id: "6let_011100", label: "R-2-3-4(d8)", notes: [R("16", 1/6), make("16", 1/6), make("16", 1/6), make("8", 0.5, 1)], w: 5 },
        { id: "6let_010110", label: "R-2(8t)-4-5(8t)", notes: [R("16", 1/6), make("8", 1/3), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_010101", label: "R-2(8t)-4(8t)-6", notes: [R("16", 1/6), make("8", 1/3), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_010011", label: "R-2(d8)-5-6", notes: [R("16", 1/6), make("8", 0.5, 1), make("16", 1/6), make("16", 1/6)], w: 5 },
        { id: "6let_001110", label: "R(2)-3-4-5(8t)", notes: [R("8", 1/3), make("16", 1/6), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_001101", label: "R(2)-3-4(8t)-6", notes: [R("8", 1/3), make("16", 1/6), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_001011", label: "R(2)-3(8t)-5-6", notes: [R("8", 1/3), make("8", 1/3), make("16", 1/6), make("16", 1/6)], w: 5 },

        // 000111 (7) -> SPECIAL: 8th Rest + 16th Triplet
        { 
            id: "6let_000111", 
            label: "R(8)-4-5-6(Trip)", 
            notes: [
                {...R("8", 0.5), _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}, 
                {...make("16", 1/6), _localTuplet: true, _isHybrid: true}
            ], 
            _tuplet: {num_notes:6, notes_occupied:4, render: false},
            w: 6 
        },

        // ============================
        // === 2 NOTES (HYBRIDS: NO "6") ===
        // ============================
        { id: "6let_110000", label: "1-2-R(q)", notes: [make("16", 1/6), make("16", 1/6), R("q", 2/3)], w: 5 },
        { id: "6let_101000", label: "Trip-Let-R", notes: [make("8", 1/3), make("8", 1/3), R("8", 1/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 5 },
        
        // 100100 -> 8th + 8th (on 1 and 4)
        { 
            id: "6let_100100", 
            label: "1(8)-4(8)", 
            notes: [make("8", 0.5), make("8", 0.5)], 
            _tuplet: {num_notes:6, notes_occupied:4, render: false}, 
            w: 6 
        },
        
        { id: "6let_100010", label: "Trip-R-Trip", notes: [make("q", 2/3), make("8", 1/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 5 },
        { id: "6let_100001", label: "1(q)-6", notes: [make("q", 2/3), R("16", 1/6), make("16", 1/6)], w: 5 },

        { id: "6let_011000", label: "R-2-3(q)", notes: [R("16", 1/6), make("16", 1/6), make("q", 2/3)], w: 5 },
        { id: "6let_010100", label: "R-2(8t)-4(d8)", notes: [R("16", 1/6), make("8", 1/3), make("8", 0.5, 1)], w: 5 },
        { id: "6let_010010", label: "R-2(d8)-5(8t)", notes: [R("16", 1/6), make("8", 0.5, 1), make("8", 1/3)], w: 5 },
        { id: "6let_010001", label: "R-2(q)-6", notes: [R("16", 1/6), make("q", 2/3), make("16", 1/6)], w: 5 },

        { id: "6let_001100", label: "R(8t)-3-4(d8)", notes: [R("8", 1/3), make("16", 1/6), make("8", 0.5, 1)], w: 5 },
        { id: "6let_001010", label: "R-Let-Trip", notes: [R("8", 1/3), make("8", 1/3), make("8", 1/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 5 },
        { id: "6let_001001", label: "R(8t)-3(d8)-6", notes: [R("8", 1/3), make("8", 0.5, 1), make("16", 1/6)], w: 5 },

        { id: "6let_000110", label: "R(d8)-4-5(8t)", notes: [R("8", 0.5, 1), make("16", 1/6), make("8", 1/3)], w: 5 },
        { id: "6let_000101", label: "R(d8)-4(8t)-6", notes: [R("8", 0.5, 1), make("8", 1/3), make("16", 1/6)], w: 5 },
        { id: "6let_000011", label: "R(q)-5-6", notes: [R("q", 2/3), make("16", 1/6), make("16", 1/6)], w: 5 },

        // ============================
        // === 1 NOTE ===
        // ============================
        { id: "6let_100000", label: "Quarter", notes: [make("q", 1.0)], w: 5, _tuplet: false },
        { id: "6let_010000", label: "2 Only", notes: [R("16", 1/6), make("16", 1/6), R("q", 2/3)], w: 5 },
        { id: "6let_001000", label: "R-Let-R", notes: [R("8", 1/3), make("q", 2/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 5 },
        
        // 000100 -> SPECIAL: 8th Rest + 8th Note (Reg)
        { 
            id: "6let_000100", 
            label: "R(8)-4(8)", 
            notes: [R("8", 0.5), make("8", 0.5)], 
            _tuplet: {num_notes:6, notes_occupied:4, render: false}, 
            w: 5 
        },
        
        { id: "6let_000010", label: "R-R-Trip", notes: [R("q", 2/3), make("8", 1/3)], _tuplet: {num_notes:3, notes_occupied:2}, w: 5 },
        { id: "6let_000001", label: "6 Only", notes: [R("q", 2/3), R("16", 1/6), make("16", 1/6)], w: 5 }
    ],

// === 7. 9-lets (9 notes over 2 beats) ===
    "9let": [
        // ============================
        // === 9 NOTES (Full) ===
        // ============================
        { 
            id: "9let_111111111", 
            label: "Full 9", 
            notes: Array(9).fill(make("16", 2/9)), 
            w: 10,
            _tuplet: { num_notes: 9, notes_occupied: 8 }
        },

        // ============================
        // === 8 NOTES (One 8th) ===
        // ============================
        // 111111101 (Last note syncopation)
        { 
            id: "9let_111111101", 
            label: "1-2-3-4-5-6-7(8)", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 4/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 111101111 (Middle syncopation)
        { 
            id: "9let_111101111", 
            label: "1-2-3-4(8)-6-7", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 4/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 101111111 (First note syncopation)
        { 
            id: "9let_101111111", 
            label: "1(8)-3-4-5-6-7", 
            notes: [
                make("8", 4/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },

        // ============================
        // === 7 NOTES (One Dotted 8th) ===
        // ============================
        // 111111100 (End Sustain)
        { 
            id: "9let_111111100", 
            label: "1-2-3-4-5-6-7(d8)", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 6/9, 1) // Dotted 8th
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 111100111 (Middle Sustain)
        { 
            id: "9let_111100111", 
            label: "1-2-3-4(d8)-7", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 6/9, 1), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 100111111 (Start Sustain)
        { 
            id: "9let_100111111", 
            label: "1(d8)-4-5-6-7", 
            notes: [
                make("8", 6/9, 1), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },

        // ============================
        // === 6 NOTES (Two 8ths) ===
        // ============================
        // 101101101 (The "Swing" 9-let: Long-Short-Long-Short-Long-Short)
        { 
            id: "9let_101101101", 
            label: "1(8)-3-4(8)-6-7(8)-9", 
            notes: [
                make("8", 4/9), make("16", 2/9), 
                make("8", 4/9), make("16", 2/9), 
                make("8", 4/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 111101101
        { 
            id: "9let_111101101", 
            label: "1-2-3-4(8)-6(8)-8", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 4/9), make("16", 2/9), make("8", 4/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 101111101
        { 
            id: "9let_101111101", 
            label: "1(8)-3-4-5-6-7(8)-9", 
            notes: [
                make("8", 4/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 4/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 101101111
        { 
            id: "9let_101101111", 
            label: "1(8)-3-4(8)-6-7", 
            notes: [
                make("8", 4/9), make("16", 2/9), 
                make("8", 4/9), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },

        // ============================
        // === 5 NOTES (Two Dotted 8ths) ===
        // ============================
        // 111100100
        { 
            id: "9let_111100100", 
            label: "1-2-3-4(d8)-7(d8)", 
            notes: [
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 6/9, 1), make("8", 6/9, 1)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 100111100
        { 
            id: "9let_100111100", 
            label: "1(d8)-4-5-6-7(d8)", 
            notes: [
                make("8", 6/9, 1), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9), 
                make("8", 6/9, 1)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        },
        // 100100111
        { 
            id: "9let_100100111", 
            label: "1(d8)-4(d8)-7-8-9", 
            notes: [
                make("8", 6/9, 1), make("8", 6/9, 1), 
                make("16", 2/9), make("16", 2/9), make("16", 2/9)
            ], 
            w: 5, _tuplet: { num_notes: 9, notes_occupied: 8 } 
        }
    ]
};

/* ============================================================
   ENGINE V2 RHYTHM EXPANSION (Anthony, 2026-07): septuplets (16th
   & 8th based), 32nd notes, dotted-8th figures, and the eight ratio
   rhythms (4:3 5:3 7:3 8:3 · 4:6 5:6 7:6 8:6). Every family is built
   through ONE shared builder so each variant follows the SAME
   construction logic as the hand banks above:
     • a '1' STARTS a note; each following '0' SUSTAINS it into a
       longer value (never an internal note+rest — this is the bank's
       own rule, see getStrictCandidates step 5 / 16s_1101 = 16-8-16).
     • a LEADING run of '0's is the only rest (the off-beat entry),
       which is dropped at 0% rest density like every other rest tile.
   The builder computes each note's beats + glyph + dots from the
   family's base note value, so the beaming/bracket math is identical
   across families — you only choose base value + tuplet ratio.
   ============================================================ */
(function buildV2Families() {
    var LADDER = ["32", "16", "8", "q", "h", "w"];            // note-value doubling ladder
    // k base-units -> {durIndexOffset, dots}. Missing k (5, 7, 9, 10, 11) has no single notehead.
    var UNIT_MAP = { 1:[0,0], 2:[1,0], 3:[1,1], 4:[2,0], 6:[2,1], 8:[3,0], 12:[3,1] };
    function glyph(base, k) {
        var bi = LADDER.indexOf(base), m = UNIT_MAP[k];
        if (bi < 0 || !m || bi + m[0] >= LADDER.length) return null;
        return { dur: LADDER[bi + m[0]], dots: m[1] };
    }
    /* k units -> the pieces to write it as. TIES ARE NEVER USED (Anthony's rule): a length with no
       notehead becomes the LARGEST legal note followed by a rest for the remainder, so 5 units in a
       sextuplet is written quarter + 16th rest, e.g. 100001 = quarter, 16th rest, 16th. */
    function splitRun(k) {
        if (UNIT_MAP[k]) return [k];
        for (var a = k - 1; a >= 1; a--) if (UNIT_MAP[a] && UNIT_MAP[k - a]) return [a, k - a];
        return null;
    }
    // bit-string -> notes[] (sustain + leading-rest). slot = beats per single unit.
    function bitsToNotes(bits, slot, base) {
        var notes = [], i = 0, N = bits.length;
        function push(k, isRest) {                            // one run -> note (+ rest remainder)
            var parts = splitRun(k); if (!parts) return false;
            for (var p = 0; p < parts.length; p++) {
                var g = glyph(base, parts[p]); if (!g) return false;
                var beats = parts[p] * slot;
                notes.push(isRest || p > 0 ? R(g.dur, beats, g.dots) : make(g.dur, beats, g.dots));
            }
            return true;
        }
        if (bits[0] === "0") {                                // leading rest = off-beat entry
            var z = 0; while (i < N && bits[i] === "0") { z++; i++; }
            if (!push(z, true)) return null;
        }
        while (i < N) {                                       // '1' + trailing '0's = one sustained note
            var run = 1; i++;
            while (i < N && bits[i] === "0") { run++; i++; }
            if (!push(run, false)) return null;
        }
        return notes;
    }
    BITS_TO_NOTES = bitsToNotes;   // fillers derive their patterns with the SAME sustain/split rules

    // curated, musically useful bit-strings: full run, off-beat entries, head/tail sustains.
    function curateBits(N, maxK) {
        maxK = maxK || 4;
        var out = [], seen = {};
        function add(b) { if (b.length === N && !seen[b]) { seen[b] = 1; out.push(b); } }
        add("1".repeat(N));                                                                  // full
        [1, 2, 3, 4].forEach(function (k) { if (k < N && k <= maxK) add("0".repeat(k) + "1".repeat(N - k)); });        // entries
        [2, 3, 4].forEach(function (k) {
            if (k < N && k <= maxK) {
                add("1" + "0".repeat(k - 1) + "1".repeat(N - k));                            // head sustain
                add("1".repeat(N - k + 1) + "0".repeat(k - 1));                              // tail sustain
            }
        });
        return out;
    }
    function bitsLabel(bits) {
        var on = [];
        for (var i = 0; i < bits.length; i++) if (bits[i] === "1") on.push(i + 1);
        var lbl = on.join("-");
        return (bits[0] === "0" ? "R " : "") + (lbl || "R");
    }
    /* every bit-string over N slots except all-zeros — a beat is never silent. This is what Anthony
       hand-wrote for "16s" (15) and "5let16" (31); the generated families now match. */
    function allBits(N) {
        var full = "1".repeat(N), out = [full];       // full run FIRST — it represents the family
        for (var m = 1; m < (1 << N); m++) {
            var b = m.toString(2); while (b.length < N) b = "0" + b;
            if (b !== full) out.push(b);
        }
        return out;
    }
    /* Weight: the full run IS the family, so it stays common even against 254 siblings. Otherwise more
       attacks = more useful, and an off-beat entry is rarer because it's harder to read. */
    function bitsWeight(bits) {
        var N = bits.length, ones = 0;
        for (var i = 0; i < N; i++) if (bits[i] === "1") ones++;
        if (ones === N) return 10 * N;
        var w = 1 + Math.round(5 * (ones - 1) / (N - 1));
        return bits[0] === "0" ? Math.max(1, w - 2) : w;
    }
    function buildFamily(prefix, N, T, base, tuplet, maxK, full) {
        var slot = T / N, list = [];
        (full ? allBits(N) : curateBits(N, maxK)).forEach(function (bits, idx) {
            var notes = bitsToNotes(bits, slot, base);
            if (!notes) return;
            var v = { id: prefix + "_" + bits, label: bitsLabel(bits), notes: notes,
                      w: full ? bitsWeight(bits) : (idx === 0 ? 10 : (bits[0] === "0" ? 4 : 6)) };
            /* One notated element can't carry a tuplet bracket — a "7" over a single note is nonsense.
               Redraw it as the plain value for the real span and drop the bracket. */
            if (tuplet && notes.length === 1) {
                var plain = plainGlyph(T);
                if (!plain) return;                           // span has no plain notehead → skip
                v.notes = [make(plain.dur, T, plain.dots)];
            } else if (tuplet) {
                v._tuplet = tuplet;
            }
            list.push(v);
        });
        return list;
    }
    // beats -> a single notehead, for collapsing a bracket-free one-note variant (1 = quarter).
    function plainGlyph(beats) {
        var tbl = { 0.25:["16",0], 0.375:["16",1], 0.5:["8",0], 0.75:["8",1], 1:["q",0],
                    1.5:["q",1], 2:["h",0], 3:["h",1], 4:["w",0] };
        var m = tbl[+beats.toFixed(3)];
        return m ? { dur: m[0], dots: m[1] } : null;
    }

    // --- Septuplets: 7 over 1 beat (16th base) and 7 over 2 beats (8th base). 7:4 → shows a clean "7". ---
    RHYTHM_VARIANTS["7let"]  = buildFamily("7let",  7, 1.0, "16", { num_notes: 7, notes_occupied: 4 }, 4, true);
    RHYTHM_VARIANTS["7let8"] = buildFamily("7let8", 7, 2.0, "8",  { num_notes: 7, notes_occupied: 4 }, 4, true);

    /* --- 9-lets: 9 over 2 beats (16th base, 9:8). Was 14 hand-written variants; regenerated here so
       every one of the 511 patterns exists, same as the other families. The full run keeps its id
       9let_111111111, which FULL_VARIATION_IDS depends on. --- */
    RHYTHM_VARIANTS["9let"] = buildFamily("9let", 9, 2.0, "16", { num_notes: 9, notes_occupied: 8 }, 4, true);

    // --- 32nd notes: 8 straight over 1 beat (power of two → no tuplet bracket). ---
    RHYTHM_VARIANTS["32nd"] = buildFamily("32nd", 8, 1.0, "32", null, 4, true);

    /* --- Ratio rhythms ---------------------------------------------------------------------------
       A ratio rhythm is N notes spread evenly across the space of M notes of the SAME value. So the
       real duration is M × (that note's length), NOT one beat:

         4:3  = 4 eighths in the space of 3 eighths     = 3 × 0.5  = 1.5 beats
         4:6  = 4 sixteenths in the space of 6 sixteenths = 6 × 0.25 = 1.5 beats

       These were all built spanning 1.0 beat, which squeezed the figure into the wrong amount of time
       and is why they didn't sound or look like ratio rhythms. Every family below is 1.5 beats; the
       ratio changes how many notes fill it, not how long it lasts. (Anthony, 2026-07-21) */
    var R3  = 3 * 0.5;    // three eighths   = 1.5 beats
    var R3s = 3 * 0.25;   // three sixteenths = 0.75 beats
    /* Written NOTE VALUE is chosen for visual honesty, not arithmetic: 7 or 8 notes crammed into 1.5
       beats are faster than eighths, so they're drawn as 16ths; the 0.75-beat 7s and 8s are faster than
       16ths, so they're drawn as 32nds. Durations are untouched — only the beaming changes.
       (Anthony, 2026-07-21) */
    RHYTHM_VARIANTS["r43"] = buildFamily("r43", 4, R3, "8",  { num_notes: 4, notes_occupied: 3 }, 2, true);
    RHYTHM_VARIANTS["r53"] = buildFamily("r53", 5, R3, "8",  { num_notes: 5, notes_occupied: 3 }, 2, true);
    RHYTHM_VARIANTS["r73"] = buildFamily("r73", 7, R3, "16", { num_notes: 7, notes_occupied: 6 }, 2, true);
    RHYTHM_VARIANTS["r83"] = buildFamily("r83", 8, R3, "16", { num_notes: 8, notes_occupied: 6 }, 2, true);
    /* The 16th-note set is ":3" as well — N sixteenths in the space of THREE sixteenths, so 0.75 beats.
       Same ratio names as the eighth set, half the length, which is normal: a tuplet ratio is always
       relative to the note value written. A single 16th completes the beat after them.
       (Anthony, 2026-07-21 — these used to be :6 over 1.5 beats.) */
    RHYTHM_VARIANTS["r46"] = buildFamily("r46", 4, R3s, "16", { num_notes: 4, notes_occupied: 3 }, 2, true);
    RHYTHM_VARIANTS["r56"] = buildFamily("r56", 5, R3s, "16", { num_notes: 5, notes_occupied: 3 }, 2, true);
    RHYTHM_VARIANTS["r76"] = buildFamily("r76", 7, R3s, "32", { num_notes: 7, notes_occupied: 6 }, 2, true);
    RHYTHM_VARIANTS["r86"] = buildFamily("r86", 8, R3s, "32", { num_notes: 8, notes_occupied: 6 }, 2, true);

    /* --- Dotted-8th figures ------------------------------------------------------------------------
       A dotted 8th is 0.75 of a beat and that's the whole note — it does NOT come with a 16th attached.
       Every variant used to be a dotted-8th + 16th "gallop" filling one beat, which is a different
       rhythm entirely.

       Because 0.75 doesn't divide a beat evenly, they're only useful in groups that land back on one:
         2 dotted 8ths = 1.5 beats     4 dotted 8ths = 3 beats
       so those are the two shapes the generator gets, plus rest placements inside them.
       (Anthony, 2026-07-21) */
    var d8  = function () { return make("8", 0.75, 1); };
    var d8r = function () { return R("8", 0.75, 1); };
    /* Same bit model as every other family (§2 of RHYTHM-RULES.md), with the dotted 8th as the base
       unit. A 0 after a 1 SUSTAINS, and two dotted 8ths make a dotted quarter — so sustains and merged
       rests both come out as real dotted quarters instead of a row of dotted-8th rests
       (Anthony, 2026-07-21). The ladder is dotted 8th (0.75) → dotted quarter (1.5) → dotted half (3.0),
       so k = 3 has no notehead (2.25 beats) and splits 2 + 1, exactly like splitRun elsewhere. */
    var D8_UNIT = { 1: ["8", 1], 2: ["q", 1], 4: ["h", 1] };
    function d8Split(k) {
        if (D8_UNIT[k]) return [k];
        for (var a = k - 1; a >= 1; a--) if (D8_UNIT[a] && D8_UNIT[k - a]) return [a, k - a];
        return null;
    }
    function d8Notes(bits) {
        var out = [], i = 0, N = bits.length;
        function push(k, isRest) {
            var parts = d8Split(k); if (!parts) return false;
            for (var p = 0; p < parts.length; p++) {
                var g = D8_UNIT[parts[p]], beats = parts[p] * 0.75;
                out.push(isRest || p > 0 ? R(g[0], beats, g[1]) : make(g[0], beats, g[1]));
            }
            return true;
        }
        if (bits[0] === "0") { var z = 0; while (i < N && bits[i] === "0") { z++; i++; } if (!push(z, true)) return null; }
        while (i < N) { var run = 1; i++; while (i < N && bits[i] === "0") { run++; i++; } if (!push(run, false)) return null; }
        return out;
    }
    /* N=1 (a SINGLE dotted 8th, 0.75 beats) exists so dotted 8ths can join the 0.75-beat runs in
       generateExercise — that is what lets them start on an off-beat 16th partial and appear in 1s and
       3s, not only the on-beat pairs and fours this bank was originally limited to. The N=2/N=4 entries
       below are untouched and still cover the on-beat forms with their own rest placements.
       (Anthony, 2026-08-02) */
    RHYTHM_VARIANTS["dotted8"] = [];
    [1, 2, 4].forEach(function (N) {
        for (var m = (1 << N) - 1; m >= 1; m--) {
            var bits = m.toString(2); while (bits.length < N) bits = "0" + bits;
            var notes = d8Notes(bits); if (!notes) continue;
            var ones = (bits.match(/1/g) || []).length;
            RHYTHM_VARIANTS["dotted8"].push({
                id: "dotted8_" + N + "_" + bits,
                label: ones === N ? N + " dotted 8ths" : bitsLabel(bits),
                notes: notes,
                w: ones === N ? 10 : Math.max(1, 1 + Math.round(4 * (ones - 1) / (N - 1)) - (bits[0] === "0" ? 2 : 0))
            });
        }
    });
})();












// 1. Define Expansion Function (Ensures tiles exist)
(function expandCompoundVariations() {
    if (!RHYTHM_VARIANTS["6let"] || !RHYTHM_VARIANTS["16s"]) return;

    const compoundVars = JSON.parse(JSON.stringify(RHYTHM_VARIANTS["6let"]));
    compoundVars.forEach(v => {
        v._isCompoundVariant = true; 
        v._tuplet = null; 
        v._preserve = true; 
        v._compoundGrid = true; 
        v.id = "cmp_" + v.id;

        // --- TRANSFORMATION LOGIC ---
        if (v.id.includes("6let_111100")) {
            v.notes = [make("16", 0.25), make("16", 0.25), make("16", 0.25), make("8", 0.75, 1)];
            v.notes.forEach(n => n._isHybrid = true);
        }
        else if (v.id.includes("6let_111000")) {
            v.notes = [make("16", 0.25), make("16", 0.25), make("16", 0.25), R("8", 0.75, 1)];
            v.notes.slice(0,3).forEach(n => n._isHybrid = true);
        }
        else if (v.id.includes("6let_100111")) {
            v.notes = [make("8", 0.75, 1), make("16", 0.25), make("16", 0.25), make("16", 0.25)];
            v.notes.forEach(n => n._isHybrid = true);
        }
        else if (v.id.includes("6let_000111")) { 
            v.notes = [R("8", 0.75, 1), make("16", 0.25), make("16", 0.25), make("16", 0.25)]; 
        }
        else if (v.id.includes("6let_100100")) { v.notes = [make("8", 0.75, 1), make("8", 0.75, 1)]; }
        else if (v.id.includes("6let_000100")) { v.notes = [R("8", 0.75, 1), make("8", 0.75, 1)]; }
        else {
            v.notes = v.notes.map(n => {
                let newDur = "16"; 
                let newBeats = 0.25;
                const dots = n.dots || 0;
                if (n.dur === "8") { newDur = "8"; newBeats = (dots > 0) ? 0.75 : 0.5; }
                else if (n.dur === "q") { newDur = "q"; newBeats = (dots > 0) ? 1.5 : 1.0; }
                return { ...n, beats: newBeats, dur: newDur, _localTuplet: undefined, _tuplet: undefined };
            });
        }

        // FIX 1: Only activate "Full Grouping" (111111) by default
        if (typeof activeVariations !== 'undefined') {
            if (v.id.includes("111111")) {
                activeVariations.add(v.id);
            }
        }
    });

    RHYTHM_VARIANTS["16s"].push(...compoundVars);
})();

/* ============================================================
   16th-TRIPLET HALVES OF A SEXTUPLET (Anthony, 2026-07-16)
   A sextuplet = two 16th-note triplets: slots 1-2-3 are a 16th triplet on the FRONT half of the beat,
   slots 4-5-6 are a 16th triplet on the BACK half. When only ONE half is a triplet and the other half
   is a plain 8th / 8th-rest, that half should read as a real 16th TRIPLET with its own "3" bracket —
   not buried under a sextuplet "6". Two things happen here (run AFTER the 16s clone above so none of
   this leaks into the compound-16s grid):
     1. FIX — the four FULL-half hybrids already in the bank used _tuplet:{render:false}, which marks the
        tile "global" and silently drops BOTH brackets, so they rendered as ambiguous un-bracketed 16ths.
        Switching them to _tuplet:false makes the tile non-global, so the per-half local 3-bracket emits.
     2. ADD — the PARTIAL-half triplets (a note cut out of the front or back half) paired with an 8th /
        8th-rest, so "a partial cut from a half" shows up as a partial 16th triplet, front or back.
   All of these stay OFF by default (only "Full 6" is in FULL_IDS); they surface through the sextuplet
   variation picker, exactly as Anthony framed it ("depending on the variations allowed from the
   sextuplets"). When BOTH halves are full triplets you still get the single "6" sextuplet (unchanged). */
(function () {
  var SEXT = RHYTHM_VARIANTS["6let"];
  if (!SEXT) return;

  // FIX 1 — full-half hybrids: false (not {render:false}) => non-global tile => local 3-bracket emits
  ["6let_111100", "6let_100111", "6let_111000", "6let_000111"].forEach(function (id) {
    var v = SEXT.find(function (x) { return x.id === id; });
    if (v) v._tuplet = false;
  });

  // one 16th-triplet HALF: 3 sixteenth-triplet slots, each a note (1) or a triplet rest (0). EVERY slot
  // carries _localTuplet so the "3" bracket spans the whole half (rests included).
  function tripHalf(bits) {
    return bits.split("").map(function (b) {
      var n = b === "1" ? make("16", 1 / 6) : R("16", 1 / 6);
      return Object.assign({}, n, { _localTuplet: true, _isHybrid: true });
    });
  }
  var eighth = function () { return Object.assign({}, make("8", 0.5), { _isHybrid: true }); };  // plain 8th
  var eRest  = function () { return Object.assign({}, R("8", 0.5),   { _isHybrid: true }); };    // 8th rest

  // two-note + split partials of a 16th triplet (single-note shapes read as a plain 8th, so skip them)
  var PARTIALS = [
    { bits: "110", tag: "12", lbl: "1-2" },   // x x .
    { bits: "011", tag: "23", lbl: "2-3" },   // . x x
    { bits: "101", tag: "13", lbl: "1-3" }    // x . x
  ];

  var added = [];
  PARTIALS.forEach(function (p) {
    // FRONT half = partial 16th triplet, BACK half = plain 8th / 8th-rest
    added.push({ id: "6let_ftrip" + p.tag + "_8", label: "Trip " + p.lbl + " + 8th",
      notes: tripHalf(p.bits).concat([eighth()]), _tuplet: false, w: 4 });
    added.push({ id: "6let_ftrip" + p.tag + "_r", label: "Trip " + p.lbl + " + 8th rest",
      notes: tripHalf(p.bits).concat([eRest()]), _tuplet: false, w: 4 });
    // BACK half = partial 16th triplet, FRONT half = plain 8th / 8th-rest
    added.push({ id: "6let_8_btrip" + p.tag, label: "8th + Trip " + p.lbl,
      notes: [eighth()].concat(tripHalf(p.bits)), _tuplet: false, w: 4 });
    added.push({ id: "6let_r_btrip" + p.tag, label: "8th rest + Trip " + p.lbl,
      notes: [eRest()].concat(tripHalf(p.bits)), _tuplet: false, w: 4 });
  });
  SEXT.push.apply(SEXT, added);
})();

// === NEW: INJECT CATEGORY TYPES FOR BALANCED SELECTION ===
// This ensures we can balance "Quarters" vs "16ths" evenly, 
// instead of 16ths drowning out Quarters by sheer number of variations.
Object.keys(RHYTHM_VARIANTS).forEach(key => {
    RHYTHM_VARIANTS[key].forEach(v => v._type = key);
});

// ======================================================
// ...










// ======================================================
// 1. GENERATION & LOGIC ENGINE (STRICT MODE & SYNCOPATION FIXES)
// ======================================================

/**
 * HELPER: Filters the global RHYTHM_VARIANTS database
 */
/* PLAIN ALTERNATING SPEED CAP (Anthony, 2026-08-02: "we should have a limit on how fast normal
   alternating rlrl notes play"). Benchmark: 32nd notes at 150bpm is the fastest single stroke this
   generator may ever produce — expressed as a STROKE RATE, the same trick the roll cap
   (MAX_STROKES_PER_SEC in applyOrnaments) already uses, so it scales to every note value and every
   rhythm family (straight, tuplet, ratio) by itself instead of a per-value table.
   This is a THIRD, separate cap from "inverted motion" (same-hand R-to-R, a one-handed rate — still
   undesigned) and from the roll cap (a diddle's own 2-strokes-per-note rate). This one is a floor
   under EVERY plain note regardless of which hand eventually plays it, because sticking hasn't been
   assigned yet at candidate-selection time — a same-hand cap can only ever be stricter than this one,
   never looser, so gating here first is always safe to layer under it later.
   Applied at CANDIDATE SELECTION (getStrictCandidates), not as a post-hoc strip like the roll cap: a
   plain note has no "rest" to give back the way a diddle does, so the only way to keep an unplayable
   note off the page is to never let the generator choose that rhythm at this tempo in the first
   place. Judged by n.beats (the real played length), so a tuplet-compressed note is judged by what it
   actually sounds like, exactly like the roll cap. */
var MAX_ALT_STROKES_PER_SEC = 150 / (60 * 0.125);   // = 20, i.e. 32nds at 150bpm
// takes a plain array of notes — used both for a full candidate (v.notes) and for a FILLER's notes
// (halfBeatPatterns below builds fillers straight from bit-strings, bypassing getStrictCandidates
// entirely, so it needs this same check called directly rather than through tooFastToAlternate)
function notesTooFastToAlternate(notes) {
    var bpm = +(SET && SET.tempo) || 100;
    if (!(bpm > 0)) return false;
    return (notes || []).some(function (n) {
        if (n.kind === "rest" || !(n.beats > 0)) return false;
        return (bpm / 60) / n.beats > MAX_ALT_STROKES_PER_SEC + 1e-9;
    });
}
function tooFastToAlternate(v) { return notesTooFastToAlternate(v.notes); }

function getStrictCandidates(targetBeats, isCompoundContext, restPct) {
    const candidates = [];
    const eps = 0.01;

    // Iterate over every category
    for (const [categoryKey, variants] of Object.entries(RHYTHM_VARIANTS)) {
        
        // GLOBAL CHECKBOX GATES
        if (categoryKey === "q") {
            if (!allowQuartersEl.checked) continue;
        }

        if (categoryKey === "dottedQ") {
            if (!allowDottedQuartersEl.checked) continue;
        }

        if (categoryKey === "8s" && !allow8thsEl.checked) continue;
        if (categoryKey === "16s" && !allow16thsEl.checked) continue;
        if (categoryKey === "8t" && !allowTripletsEl.checked) continue;
        if (categoryKey === "qt" && !allowQuarterTripletsEl.checked) continue;
        if (categoryKey === "5let" && !allowQuintupletsEl.checked) continue;
        if (categoryKey === "5let16" && !allow16thQuintupletsEl.checked) continue;
        if (categoryKey === "6let" && !allowSextupletsEl.checked) continue;
        if (categoryKey === "9let" && !allow9letsEl.checked) continue;

        // ENGINE V2 categories (septuplets, 32nds, dotted-8ths, ratio rhythms) — gated by their own
        // settings.cats flag via the same box() shim the originals use. Non-compound tiles, so the
        // context filter below already keeps them out of compound meters (no separate ban needed).
        if (V2_CATEGORY_KEYS.indexOf(categoryKey) !== -1 && SET.cats[categoryKey] === false) continue;

        // COMPOUND METER — drop the odd tuplets that fight a dotted-quarter pulse. Quarter-triplets,
        // 8th & 16th 5-lets, and 9-lets create cross-rhythms that rarely appear in real compound writing,
        // so they never generate inside a compound beat (they still work in simple/asymmetric measures).
        if (isCompoundContext &&
            (categoryKey === "qt" || categoryKey === "5let" || categoryKey === "5let16" || categoryKey === "9let"))
            continue;

        for (const v of variants) {
            // 1. DURATION MATCH (Critical for Asymmetric Meters)
            const tileDur = v.notes.reduce((acc, n) => acc + (n.beats || 0), 0);
            if (Math.abs(tileDur - targetBeats) > eps) continue;

            // 2. ACTIVATION CHECK
            // dottedQ is special: it's a category toggle, not individual tiles
            if (categoryKey !== "dottedQ") {
                if (!activeVariations.has(v.id)) continue;
            }

            // 3. SMART DEPENDENCY LOGIC
            if (categoryKey === "dottedQ") {
                if (v.id.includes("6let") && !allowSextupletsEl.checked) continue;
                if (v.id.includes("16s") && !allow16thsEl.checked) continue;
                if (v.id.includes("8") && !allow8thsEl.checked && !allow16thsEl.checked) continue;
            }

            // 4. CONTEXT MATCH (Strict Separation)
            const isCompoundTile = !!v._isCompoundVariant;

            if (isCompoundContext) {
                // === COMPOUND TIME ===
                // Allow Compound tiles OR strict "Pulse" tiles (q_c_1)
                if (!isCompoundTile && categoryKey !== "dottedQ" && v.id !== "q_c_1") continue;
            } else {
                // === SIMPLE TIME ===
                // BAN anything marked as Compound
                if (isCompoundTile) continue;
            }

            // 5. REST FILTER — at 0% rest density, NEVER emit a variant that contains a rest.
            // The variant library already writes every internal gap with a LONGER note instead of a
            // note+rest (e.g. 16s_1101 is written 16-8-16, not 16-16-16r-16), so filtering here just drops
            // the leading-rest "offbeat" variants (rest-then-notes), which genuinely can't exist at 0% rests.
            // The no-rest / larger-note forms remain and take their place. (Applies to ALL categories now.)
            const hasRest = v.notes.some(n => n.kind === 'rest' || !!n.rest);
            /* A figure with a hole in it is SPARSITY's business, not Rests'. Rests silences whole beats
               between figures; at Rests 0 you should still be able to read "R 2-3-4" if Sparsity allows.
               At sparsity 0 the figure must be COMPLETELY FILLED — every slot struck. Testing only for
               "has a rest" wasn't enough: "16s_1100" is a 16th + dotted 8th, no rests but just two
               attacks, so 0% came out at 3.57 notes/beat instead of a true 4. (Anthony, 2026-07-21) */
            var _sp = (SET.sparsity == null ? 50 : SET.sparsity);
            if (_sp === 0 || _sp === 100) {
                var _bits = /([01]+)$/.exec(v.id || "");
                var _slots = _bits ? _bits[1].length : v.notes.length;
                var _hits = 0;
                v.notes.forEach(function (n) { if (n.kind !== "rest") _hits++; });
                // the two ends are absolutes, not a bias: 0 = every slot struck, 100 = a single note.
                // It stops at one, never zero — an empty beat belongs to the Rests slider.
                if (_sp === 0 && _hits !== _slots) continue;
                if (_sp === 100 && _hits !== 1) continue;
            }

            // 6. SPEED CAP — see tooFastToAlternate() above. A plain note this fast can't be partially
            // fixed after the fact (unlike a diddle, it has no rest to give back), so the candidate is
            // refused here rather than generated and then patched.
            if (tooFastToAlternate(v)) continue;

            // 7. ADD TO POOL
            candidates.push(v);
        }
    }

    return candidates;
}







// weighted choice over a list; weightOf may return any positive number (floored so nothing is unreachable)
function weightedPick(list, weightOf) {
    var w = list.map(function (x) { return Math.max(0.001, weightOf(x) || 0); });
    var total = w.reduce(function (a, b) { return a + b; }, 0);
    var roll = Math.random() * total;
    for (var i = 0; i < list.length; i++) { roll -= w[i]; if (roll <= 0) return list[i]; }
    return list[list.length - 1];
}

function pickRandomStrict(list) {
    if (!list || list.length === 0) return null;

    // === BALANCED SELECTION LOGIC ===
    // 1. Group candidates by their Source Category (e.g., "q", "8s", "dottedQ")
    const groups = {};
    list.forEach(item => {
        // Use injected _type, or fallback to ID prefix if missing (safety)
        const type = item._type || item.id.split('_')[0]; 
        if (!groups[type]) groups[type] = [];
        groups[type].push(item);
    });

    // 2. WEIGHTED LOTTERY SYSTEM (ALL CATEGORIES EXPLICIT)
    // "Tickets" in the lottery. Higher number = generates more often.
    /* Every family gets ONE ticket. The old table hand-ranked them (16s 8, 8t 8, q 5, qt 3, dottedQ 1),
       which is what made some rhythms common and others rare regardless of the sliders. Frequency is now
       decided ONLY by what's enabled and where the sliders sit. (Anthony, 2026-07-21) */
    const WEIGHTS = { "default": 1 };

    const types = Object.keys(groups);

    /* 3. Pick the CATEGORY. Base tickets above, then the Subdivision slider tilts toward the slow or
       fast end. Density is normalised across every category the USER ENABLED, not just the ones in
       this particular candidate pool. Pool-local normalising silently defeated the slider: a bucket
       holding only one family (the 3-beat bucket is all dotted8) has lo === hi, so the bias collapsed
       to a flat 1.0 and that family came through at full strength no matter where the slider sat —
       which is why slow rhythms kept appearing at 100%. (Anthony, 2026-07-21) */
    const enabled = Object.keys(CATEGORY_DENSITY).filter(k =>
        !(SET.cats && SET.cats[k] === false) && CATEGORY_DENSITY[k] != null);
    const scale = enabled.length ? enabled.map(k => CATEGORY_DENSITY[k]) : types.map(t => CATEGORY_DENSITY[t] || 0);
    const lo = Math.min.apply(null, scale), hi = Math.max.apply(null, scale);
    const normD = (t) => (hi > lo ? (((CATEGORY_DENSITY[t] || 0) - lo) / (hi - lo)) : 0.5);
    const chosenType = weightedPick(types, (t) =>
        (WEIGHTS[t] || WEIGHTS["default"]) * biasMul(normD(t), SET.subdiv, 10));

    /* 4. Pick the VARIATION — by its own w (the full run is worth 10xN, so straight 32nds stay common
       even against 254 siblings), then the Rests slider tilts toward filled or sparse. Until 2026-07-21
       this was a UNIFORM pick and w was dead data, which is why expanding the families to every
       variation quietly buried the dense ones. */
    const subList = groups[chosenType];
    const choice = weightedPick(subList, (v) =>
        (v.w || 1) * sparsityBias(v, SET.sparsity));
    
    // === DEEP COPY & METADATA INJECTION ===
    const copy = JSON.parse(JSON.stringify(choice.notes));
    
    if (choice._tuplet !== undefined) {
        copy._tuplet = choice._tuplet;
    } else {
        if (choice.id.startsWith("8t"))    copy._tuplet = { num_notes: 3, notes_occupied: 2 };
        if (choice.id.startsWith("5let"))  copy._tuplet = { num_notes: 5, notes_occupied: 4 };
        if (choice.id.startsWith("6let"))  copy._tuplet = { num_notes: 6, notes_occupied: 4 };
        if (choice.id.startsWith("qt"))    copy._tuplet = { num_notes: 3, notes_occupied: 2 };
        if (choice.id.startsWith("9let"))  copy._tuplet = { num_notes: 9, notes_occupied: 8 };
    }

    if (choice._compoundGrid) copy._compoundGrid = true;
    if (choice.id.includes("6let")) copy._forceSixLetSticking = true;
    // remember which category this tile came from — sticking uses it so an 8th from the 8s category
    // alternates, while an 8th inside a 16s variation follows the 16th grid (same hand into the next note)
    copy._type = choice._type || (choice.id ? choice.id.split("_")[0] : null);

    return copy;
}

// === SYNCOPATION HELPERS ===

function getSyncopationFiller() {
    const candidates = [];

    // 1. 8th Note (Standard)
    if (allow8thsEl.checked) {
        candidates.push([make("8", 0.5)]);
    }

    // REMOVED: Two 16ths (Straight 16ths create clutter in syncopation)

    // 2. 16th Triplet (Swing feel)
    if (allowSextupletsEl.checked) {
        const trip = [
            {...make("16", 1/6), _localTuplet: true},
            {...make("16", 1/6), _localTuplet: true},
            {...make("16", 1/6), _localTuplet: true}
        ];
        candidates.push(trip);
    }

    // SPEED CAP — built straight from hand-authored notes, outside getStrictCandidates, so it needs
    // the plain-alternating ceiling applied directly here too (see MAX_ALT_STROKES_PER_SEC).
    const legal = candidates.filter(c => !notesTooFastToAlternate(c));
    if (legal.length === 0) return null;
    return legal[Math.floor(Math.random() * legal.length)];
}

function getSyncopatedCore() {
    const cores = [];
    
    const isFull = (v, expectedCount) => {
        if (v.notes.some(n => n.kind === 'rest')) return false;
        return v.notes.length === expectedCount;
    };

    // 1. Full 16th Quintuplet (1 Beat) - HIGH PRIORITY
    if (allow16thQuintupletsEl.checked) {
        const t = RHYTHM_VARIANTS["5let16"].find(v => isFull(v, 5));
        if (t && activeVariations.has(t.id)) cores.push(t);
    }
    
    // 2. Full Sextuplet (1 Beat) - HIGH PRIORITY
    if (allowSextupletsEl.checked) {
        const t = RHYTHM_VARIANTS["6let"].find(v => isFull(v, 6));
        if (t && activeVariations.has(t.id)) cores.push(t);
    }
    
    // 3. Full Triplet (Standard)
    if (allowTripletsEl.checked) {
        const t = RHYTHM_VARIANTS["8t"].find(v => isFull(v, 3));
        if (t && activeVariations.has(t.id)) cores.push(t);
    }

    // REMOVED: 4 16ths (Standard Grid) to prevent "busy" syncopation

    // 4. Quarter Note (Lowest Priority "Core")
    if (allowQuartersEl.checked) cores.push(RHYTHM_VARIANTS["q"].find(v => v.id === "q_1"));

    // SPEED CAP — picked straight from RHYTHM_VARIANTS by `.find`, outside getStrictCandidates, so the
    // plain-alternating ceiling has to be applied directly here too (see MAX_ALT_STROKES_PER_SEC).
    const validCores = cores.filter(c => !!c && !notesTooFastToAlternate(c.notes));
    if (validCores.length === 0) return null;
    return pickRandomStrict(validCores);
}

// Deep-clone a beat TILE (array of note objects) while PRESERVING the array-level metadata that
// JSON.stringify(array) silently drops — _tuplet / _type / _forceSixLetSticking / _compoundGrid. The
// rhythm-variety repeat relies on this: without it a reused triplet loses _tuplet, so applySticking falls
// to the 16th grid (slotsPerBeat 4) and stickings come out wrong (e.g. "L R R" instead of "R L R").
function cloneTile(tile) {
    const c = tile.map(n => JSON.parse(JSON.stringify(n)));
    Object.keys(tile).forEach(k => {
        if (!/^\d+$/.test(k) && k !== "length") {
            c[k] = (tile[k] && typeof tile[k] === "object") ? JSON.parse(JSON.stringify(tile[k])) : tile[k];
        }
    });
    return c;
}

// Replacing the entire generateExercise function
function generateExercise({ measures, timeSignatures, restPct, allowSyncopation, variety }) {
    const out = [];
    const safeTimeSigs = (timeSignatures && timeSignatures.length > 0) ? timeSignatures : ["4/4"];

    // RHYTHM VARIETY — how often the base rhythm changes from beat to beat. 100 = every beat picks a fresh
    // rhythm (max variety, the original behaviour); 0 = a single-pulse beat REPEATS the previous same-length
    // beat's rhythm (so a measure stays uniform and repeats). Only applied to standard single-pulse beats.
    const V = (variety == null ? 100 : Math.max(0, Math.min(100, variety)));
    let prevSingleTile = null, prevSingleDur = null;   // last single-pulse rhythm chosen (for the repeat)

// HELPER: probabilistically thin out rest-containing candidates so the Rest slider is felt smoothly,
    // not as a near on/off switch (Anthony, 2026-07-16 — "too powerful at low percentages"). Root cause:
    // pickRandomStrict picks UNIFORMLY within a category's candidate list, and a category usually has far
    // more rest-containing sub-beat variants ("R-2-3-4" etc.) than rest-free ones — so the instant restPct
    // ticks above 0%, those variants become AS LIKELY as any other, no matter how low the slider actually
    // is. Fix: each rest-containing candidate independently SURVIVES with probability restPct/60 (60 = the
    // slider's real max, index.html #restsSlider), so they stay genuinely rare near the bottom of the
    // range and only reach full strength at the top. Never touches rest-FREE candidates, and falls back to
    // the unfiltered list if thinning would empty it out entirely (keeps generation from ever failing —
    // the reason this used to be a pure pass-through).
    // 2026-07-21: the thinning above is RETIRED. Its root cause — "pickRandomStrict picks UNIFORMLY" —
    // is now fixed at the source: the variant pick is weighted by w and tilted by the Rests slider in
    // pickRandomStrict, so thinning here as well would apply the slider twice. restPct === 0 still
    // removes rest-bearing candidates outright, up in getStrictCandidates. Kept as a pass-through so
    // all ~10 call sites stay untouched.
    function applyDensityFilter(list) { return list; }
    
    // HELPER: Procedural 0.5 beat fillers (Eighth or 2-16ths)
    /* Half a beat is exactly HALF of a one-beat rhythm, so a filler is built from the halves of the
       variations the user actually switched on — not a hardcoded full run. Enable only "6let_101101"
       and the 16th-triplet filler is "101"; enable "111101" too and it can be "111" or "101".
       (Anthony, 2026-07-21). The bits are turned into notes by the bank's OWN bitsToNotes, so sustains
       and un-notatable lengths follow the same rules as everywhere else.
       A half with no attack in it is silence, not a filler — the rest fallback below covers that. */
    function halfBeatPatterns(key, slotsPerHalf, slotBeats, baseDur) {
        const seen = {}, out = [];
        (RHYTHM_VARIANTS[key] || []).forEach(function (v) {
            if (!activeVariations.has(v.id)) return;
            const m = /([01]+)$/.exec(v.id || "");
            if (!m || m[1].length !== slotsPerHalf * 2) return;
            [m[1].slice(0, slotsPerHalf), m[1].slice(slotsPerHalf)].forEach(function (h) {
                if (h.indexOf("1") < 0 || seen[h]) return;
                /* Fillers obey SPARSITY like any other figure — they were ignoring it entirely, so a
                   0% sheet still got holey fillers. Both ends are absolute, same as the main rule:
                   0 = every slot struck, 100 = a single note. */
                const _sp = (SET.sparsity == null ? 50 : SET.sparsity);
                const _hits = (h.match(/1/g) || []).length;
                if (_sp === 0 && _hits !== h.length) return;
                if (_sp === 100 && _hits !== 1) return;
                const notes = BITS_TO_NOTES && BITS_TO_NOTES(h, slotBeats, baseDur);
                if (!notes || !notes.length) return;
                // SPEED CAP — a filler is built straight from bit-strings, outside getStrictCandidates,
                // so it needs the same plain-alternating ceiling applied directly (see MAX_ALT_STROKES_PER_SEC).
                if (notesTooFastToAlternate(notes)) return;
                /* How many grid slots the half is worth. Sticking needs it: inside a 32nd filler a
                   sustained note eats TWO slots, so walking the notes and flipping hands each time
                   puts the wrong hand on everything after it. */
                notes.forEach(function (n) { n._fillerSlots = slotsPerHalf; });
                seen[h] = 1;
                out.push(notes);
            });
        });
        return out;
    }

    function getHalfBeatFillers() {
        const fillers = [];
        // 1. from the 8th-note variations — each half of a 2-slot beat is one 8th
        if (allow8thsEl.checked) {
            const h = halfBeatPatterns("8s", 1, 0.5, "8");
            if (h.length) fillers.push.apply(fillers, h); else fillers.push([make("8", 0.5)]);
        }
        // 2. from the 16th-note variations — each half of a 4-slot beat is two 16ths
        if (allow16thsEl.checked) {
            const h = halfBeatPatterns("16s", 2, 0.25, "16");
            if (h.length) fillers.push.apply(fillers, h);
            else fillers.push([make("16", 0.25), make("16", 0.25)]);
        }
        /* 3. from the SEXTUPLET variations — each half of a 6-slot beat is a 16th-note triplet, three
           notes in the space of an eighth. _subGroup keeps its bracket separate from the figure's:
           they share a tile, and toRDM groups local tuplets by groupId. */
        if (allowSextupletsEl.checked) {
            halfBeatPatterns("6let", 3, 1/6, "16").forEach(function (trip) {
                /* A half whose three slots are ONE sustained note ("100") is exactly half a beat, which
                   is a plain 8th — bitsToNotes writes it as a dotted 8th because it measures in triplet
                   space, and bracketing that put a stray "3" over a SINGLE note. The hybrid bank skips
                   these same shapes for the same reason ("single-note shapes read as a plain 8th"). */
                if (trip.length === 1) {
                    fillers.push([Object.assign({}, trip[0], { dur: "8", dots: 0, beats: 0.5, _fillerSlots: 1 })]);
                    return;
                }
                trip.forEach(function (n) {
                    n._mixedTuplet = { num_notes: 3, notes_occupied: 2 };
                    n._mixedTupletDur = 0.5;
                    n._subGroup = 0.5;
                });
                fillers.push(trip);
            });
        }
        /* 4. from the 32nd variations — each half of an 8-slot beat is four 32nds. No tuplet bracket
           (a power of two), so unlike the sextuplet above these need no _subGroup. (Anthony, 2026-07-21) */
        if (allow32ndsEl.checked) {
            /* No hardcoded fallback here (unlike the two above): if none of the switched-on 32nd
               variations yields a legal half, there is no 32nd filler and the leftover becomes a rest.
               Inventing a full run would inject a shape the user deselected. */
            fillers.push.apply(fillers, halfBeatPatterns("32nd", 4, 0.125, "32"));
        }

        /* Nothing that fits half a beat is switched on, so the leftover is SILENCE, not an eighth note.
           This used to return a plain 8th regardless, which injected a rhythm the user had explicitly
           deselected — pick only "4:3 (8ths)" and every bar still came out with 8th notes in it
           (Anthony, 2026-07-21: "if we actually couldn't fit anything in that remaining 8th note space
           then it would just be a rest"). Only an 8th or two 16ths can fill 0.5, so if neither is on
           there is no legal note to use. */
        if (fillers.length === 0) return [[R("8", 0.5)]];
        return fillers;
    }

    /* REAL rhythm content of an EXACT length, for the space a 0.75-beat run leaves over.
       Anthony asked for the leftover to be music rather than one bare filler note — "like a variation
       of 16th notes or 32nd notes. like an 8th and 16th too as a variation on 16th notes."
       FIRST VERSION (2026-08-02, same day) rolled a fresh random bit-string for this, which could
       reconstruct a shape — a "10" sustain merging into an 8th note, say — that the user's own Rhythms
       tab had deliberately switched OFF. Reported immediately: "8th notes should only generate if I've
       selected a 16th variation that has the same configuration... 8th notes generating but i only
       selected 4:3 and 16th notes."
       FIXED by never inventing a bit-string: every multi-slot chunk is the PREFIX or SUFFIX of an
       actually-ENABLED 16s/32nd variant (`activeVariations.has(v.id)`) — the exact technique
       halfBeatPatterns already uses for a fixed half-beat, generalized to any chunk length. A shape
       only appears here if the user's own curation already contains it somewhere. A single slot is
       always a plain 16th regardless (nothing to sustain into, so there is no shape to misattribute —
       matches the old always-on single-16th tail this run builder replaced). If no enabled variant
       supplies a matching chunk, falls back to that many SEPARATE plain 16ths, never a sustain — a
       repeat of the same already-necessary grid unit, not a new note value. */
    function runFiller(beats) {
        var slots = Math.round(beats / 0.25);
        if (slots <= 0) return [];
        var plain = function () {
            var out = [];
            for (var i = 0; i < slots; i++) out.push(make("16", 0.25));
            return out;
        };
        if (slots === 1) return plain();
        var seen = {}, pool = [];
        var sp = (SET.sparsity == null ? 50 : SET.sparsity);
        function collect(key, famSlots, slotBeats, baseDur, chunkSlots) {
            if (chunkSlots > famSlots) return;
            (RHYTHM_VARIANTS[key] || []).forEach(function (v) {
                if (!activeVariations.has(v.id)) return;
                var m = /([01]+)$/.exec(v.id || "");
                if (!m || m[1].length !== famSlots) return;
                [m[1].slice(0, chunkSlots), m[1].slice(famSlots - chunkSlots)].forEach(function (chunk) {
                    if (chunk.indexOf("1") < 0 || seen[chunk]) return;
                    // same absolutes as everywhere else: 0 = every slot struck, 100 = a single note
                    var hits = (chunk.match(/1/g) || []).length;
                    if (sp === 0 && hits !== chunk.length) return;
                    if (sp === 100 && hits !== 1) return;
                    var notes = BITS_TO_NOTES && BITS_TO_NOTES(chunk, slotBeats, baseDur);
                    if (!notes || !notes.length || notesTooFastToAlternate(notes)) return;
                    seen[chunk] = 1; pool.push(notes);
                });
            });
        }
        if (allow16thsEl && allow16thsEl.checked) collect("16s", 4, 0.25, "16", slots);
        if (allow32ndsEl && allow32ndsEl.checked) collect("32nd", 8, 0.125, "32", slots * 2);
        if (!pool.length) return plain();
        return JSON.parse(JSON.stringify(pool[Math.floor(Math.random() * pool.length)]));
    }

    // === 1. PER-EXERCISE RANDOMIZATION ===
    const exercisePatterns = {
        "5/8": PULSE_PATTERNS["5/8"][Math.floor(Math.random() * PULSE_PATTERNS["5/8"].length)],
        "7/8": PULSE_PATTERNS["7/8"][Math.floor(Math.random() * PULSE_PATTERNS["7/8"].length)],
        "9/8_asym": PULSE_PATTERNS["9/8_asym"][Math.floor(Math.random() * PULSE_PATTERNS["9/8_asym"].length)]
    };

    let emptyRetries = 0;   // per-measure retry budget for the no-all-rest rule
    for (let m = 0; m < measures; m++) {
        const rawTs = safeTimeSigs[Math.floor(Math.random() * safeTimeSigs.length)];
        
        let ts = rawTs; 
        if (rawTs === "9/8_asym") ts = "9/8"; 

        const parts = ts.split("/");
        const num = parseInt(parts[0], 10);
        const den = parseInt(parts[1], 10);
        
        // --- 2. DETERMINE PULSE MAP ---
        let pulseMap = [];

        if (rawTs === "9/8_asym") {
            pulseMap = exercisePatterns["9/8_asym"];
        }
        else if (den === 8) {
            if (num === 5 && exercisePatterns["5/8"]) pulseMap = exercisePatterns["5/8"];
            else if (num === 7 && exercisePatterns["7/8"]) pulseMap = exercisePatterns["7/8"];
            else if (num % 3 === 0) pulseMap = Array(num / 3).fill(1.5);
            else pulseMap = Array(num).fill(0.5); 
        } 
        else {
            pulseMap = Array(num).fill(1.0);
        }

        /* RESTS = how many pulses of this measure carry a rhythm at all (Anthony, 2026-07-21).
           0% = every pulse sounds; 100% = exactly ONE pulse sounds and the rest of the bar is rests.
           It stops at one, never zero, for the same reason Sparsity stops at one note — a completely
           empty measure isn't a reading exercise.
           This replaces a per-pulse coin flip (`roll < restPct*0.5`), which could only ever average
           out: at 100% it left about half the beats sounding instead of one, and any given measure was
           luck of the draw. Deciding the COUNT up front and then choosing which pulses sound makes the
           slider mean exactly what its label says. */
        const _nP = pulseMap.length;
        const _sounding = Math.max(1, Math.round(_nP - (_nP - 1) * (Math.max(0, Math.min(100, restPct)) / 100)));
        const restPulse = Array(_nP).fill(false);
        if (_sounding < _nP) {
            const order = pulseMap.map((_, k) => k);
            for (let k = order.length - 1; k > 0; k--) {          // shuffle, then silence the tail
                const j = Math.floor(Math.random() * (k + 1)); const t = order[k]; order[k] = order[j]; order[j] = t;
            }
            order.slice(_sounding).forEach((k) => { restPulse[k] = true; });
        }

        let measureBeats = [];
        let currentAbsPos = 0;

        for (let i = 0; i < pulseMap.length; i++) {
            const pulseDur = pulseMap[i]; // 1.5, 1.0, or 0.5
            const isPulseCompound = (Math.abs(pulseDur - 1.5) < 0.01);
            
            // --- A. REST LOGIC --- which pulses sound was decided for the whole measure above, so the
            // slider lands on an exact count instead of averaging out over a coin flip per beat.
            if (restPulse[i]) {
                let rDur = "8";
                let rDots = 0;
                
                if (Math.abs(pulseDur - 1.5) < 0.01) { rDur = "q"; rDots = 1; }
                else if (Math.abs(pulseDur - 1.0) < 0.01) { rDur = "q"; }
                else if (Math.abs(pulseDur - 0.5) < 0.01) { rDur = "8"; }

                const restEvent = [{ kind: "rest", dur: rDur, beats: pulseDur, dots: rDots }];
                let tempAbsPos = currentAbsPos;
                restEvent.forEach(n => { n.groupId = (m * 100) + i; n.absStart = tempAbsPos; tempAbsPos += (n.beats || 0); });
                measureBeats.push(restEvent);
                currentAbsPos += pulseDur;
                continue;
            }

            // --- B. SYNCOPATION LOGIC (For 1.0 pulses) ---
            // Variety scales this: at low variety, syncopation (a source of beat-to-beat change) fades out;
            // at variety 0 it never fires, so the beat falls through to the repeat logic below.
            if (allowSyncopation && pulseDur === 1.0 && (i + 1 < pulseMap.length) && pulseMap[i+1] === 1.0 && !restPulse[i+1]) {
                if (Math.random() < 0.30 * (V / 100)) {
                    let availableBeats = 1; 
                    let checkIdx = i + 2;
                    while (checkIdx < pulseMap.length && pulseMap[checkIdx] === 1.0) {
                        availableBeats++; checkIdx++;
                    }
                    let numCores = 1;
                    for (let k = 0; k < availableBeats - 1; k++) {
                        if (Math.random() < 0.25) numCores++; else break; 
                    }
                    const entry = getSyncopationFiller();
                    const exit = getSyncopationFiller();
                    const cores = [];
                    let coresValid = true;
                    for (let c = 0; c < numCores; c++) {
                        const cTile = getSyncopatedCore();
                        if (!cTile) { coresValid = false; break; }
                        cores.push(cTile);
                    }

                    if (entry && exit && coresValid) {
                        const gIdBase = (m * 100) + i;
                        let t = currentAbsPos;
                        entry.forEach(n => { n.groupId = gIdBase + 0.1; n.absStart = t; t += n.beats; });
                        measureBeats.push(entry);
                        currentAbsPos += 0.5;
                        cores.forEach((coreTile, cIdx) => {
                             let tCore = currentAbsPos;
                             coreTile.forEach(n => { n.groupId = gIdBase + 0.2 + (cIdx * 0.01); n.absStart = tCore; tCore += n.beats; });
                             measureBeats.push(coreTile);
                             currentAbsPos += 1.0;
                        });
                        let tExit = currentAbsPos;
                        exit.forEach(n => { 
                            n.groupId = gIdBase + 0.9; n.absStart = tExit; tExit += n.beats; 
                            n._isSyncExit = true; 
                        });
                        measureBeats.push(exit);
                        currentAbsPos += 0.5;
                        i += numCores; 
                        continue;
                    }
                }
            }

            // --- C. STANDARD TILE SELECTION (Pulse-Driven + Buckets) ---
            let chosenTile = null;
            let candidates = [];
            let usedBucketSize = 0;

            // 1. SIMPLE TIME BUCKETS (1.0 Beat Base)
            if (!isPulseCompound && pulseDur === 1.0) {
                 /* One shared denominator for every span available at this pulse, so a 2-beat family is
                    exactly as likely as a 1-beat one. Each bucket below then rolls its own share
                    (famWeight of its pool / the total). Variety still scales it: at low variety the
                    multi-beat buckets step back and tiles repeat. */
                 var _pool1 = getStrictCandidates(1.0, false, restPct);
                 var _pool15 = getStrictCandidates(1.5, false, restPct);
                 var _pool2 = getStrictCandidates(2.0, false, restPct);
                 var _pool3 = getStrictCandidates(3.0, false, restPct);
                 /* Choose the SPAN once, weighted, instead of letting four buckets roll in sequence.
                    The cascade order was itself a bias: every earlier bucket that fired removed an
                    opportunity from the ones below it, so the 2-beat families (quarter triplets, 9-lets,
                    8th 5-lets, 8th 7-lets) sat at the bottom of the queue and almost never appeared. */
                 var _pool075 = getStrictCandidates(0.75, false, restPct);
                 var _spanOpts = [];
                 [[1, _pool1], [0.75, _pool075], [1.5, _pool15], [2, _pool2], [3, _pool3]].forEach(function (o) {
                     var w = famWeight(o[1]);
                     if (w > 0) _spanOpts.push({ k: o[0], w: w });
                 });
                 var _wantSpan = _spanOpts.length
                     ? weightedPick(_spanOpts, function (x) { return x.w; }).k : 1;
                 
                 // === 3-Beat Bucket Check (Strict) ===
                 if (i + 2 < pulseMap.length && pulseMap[i+1] === 1.0 && pulseMap[i+2] === 1.0 && !restPulse[i+1] && !restPulse[i+2]) {
                     const b3 = applyDensityFilter(getStrictCandidates(3.0, false, restPct));
                     const b2 = applyDensityFilter(getStrictCandidates(2.0, false, restPct));
                     const b1 = applyDensityFilter(getStrictCandidates(1.0, false, restPct));

                     const mustPick3 = (b3.length > 0 && b1.length === 0 && b2.length === 0);

                     // variety-scaled (a 3-beat bucket is beat-to-beat variety); mustPick3 keeps it as a safety net
                     if (mustPick3 || (b3.length > 0 && _wantSpan === 3 && Math.random() < (V / 100))) {
                         candidates = b3;
                         usedBucketSize = 3;
                     }
                 }

                 /* === 1.5-Beat Bucket ==========================================================
                    A ratio rhythm (N notes in the space of 3 eighths / 6 sixteenths), a PAIR of dotted
                    8ths, and a bare dotted quarter are all exactly 1.5 beats. The packer only had
                    whole-beat buckets, so none of them could ever be placed — ratio rhythms silently
                    fell back to a quarter note and rests.

                    Take two beats: the 1.5 figure on the downbeat, then the leftover 0.5 filled by an
                    eighth or two sixteenths (the same helper the compound-time split already uses).
                    Figure-first on purpose — a ratio rhythm starting off the beat is unreadable at
                    sight. (Anthony, 2026-07-21) */
                 /* TWO 1.5-beat figures back to back = exactly 3 beats and NO filler. In 6/4 that means
                    four 4:3 groups fill the bar perfectly — which is what you expect when a ratio rhythm
                    is the only thing selected. The 2-beat bucket below can only ever place ONE figure and
                    pad the leftover 0.5, so on its own it could never produce that bar.
                    Forced when nothing 1-beat is selected (the ratio is all there is); otherwise it fires
                    occasionally so it doesn't crowd out the other rhythms. (Anthony, 2026-07-21) */
                 if (usedBucketSize === 0 && i + 2 < pulseMap.length &&
                     pulseMap[i+1] === 1.0 && pulseMap[i+2] === 1.0 && !restPulse[i+1] && !restPulse[i+2]) {
                     const b15pair = getStrictCandidates(1.5, false, restPct);
                     const b1pair = getStrictCandidates(1.0, false, restPct);
                     const forcePair = (b15pair.length > 0 && b1pair.length === 0);
                     if (b15pair.length > 0 && (forcePair || (_wantSpan === 1.5 && Math.random() < 0.5 * (V / 100)))) {
                         const f1 = pickRandomStrict(b15pair), f2 = pickRandomStrict(b15pair);
                         if (f1 && f2) {
                             const tagFig = function (fig, sub) {
                                 let cfg = fig._tuplet;
                                 if (cfg === false) cfg = { render: false };
                                 const d = fig.reduce((s, n) => s + (n.beats || 0), 0);
                                 fig.forEach(n => {
                                     if (cfg) { n._mixedTuplet = cfg; n._mixedTupletDur = d; }
                                     n._subGroup = sub;   // separate bracket per figure
                                 });
                                 return fig;
                             };
                             chosenTile = [...tagFig(f1, 0), ...tagFig(f2, 0.5)];
                             chosenTile._type = f1._type;
                             usedBucketSize = 3;   // consumes three 1.0 pulses
                         }
                     }
                 }

                 if (usedBucketSize === 0 && i + 1 < pulseMap.length && pulseMap[i+1] === 1.0 && !restPulse[i+1]) {
                     const b15 = applyDensityFilter(getStrictCandidates(1.5, false, restPct));
                     const b1for15 = applyDensityFilter(getStrictCandidates(1.0, false, restPct));
                     const force15 = (b15.length > 0 && b1for15.length === 0);
                     if (b15.length > 0 && (force15 || (_wantSpan === 1.5 && Math.random() < (V / 100)))) {
                         const fig = pickRandomStrict(b15);
                         const halfTiles = getHalfBeatFillers();
                         if (fig && halfTiles.length > 0) {
                             /* pickRandomStrict hangs _tuplet off the ARRAY, so spreading it into a new
                                tile silently drops the bracket — a 4:3 then renders as plain eighths.
                                Move it onto the figure's own notes as a tuplet island, the same way the
                                compound-time split does, so only the figure is bracketed and not the filler. */
                             let tCfg = fig._tuplet;
                             if (tCfg === false) tCfg = { render: false };
                             // _mixedTupletDur = the GROUP's own length (1.5), not the tile's (2.0). The
                             // counter divides by this to number the slots; using the tile length gave
                             // "1 2 3 3" instead of "1 2 3 4".
                             const figDur = fig.reduce((s, n) => s + (n.beats || 0), 0);
                             if (tCfg) fig.forEach(n => { n._mixedTuplet = tCfg; n._mixedTupletDur = figDur; });

                             const half = JSON.parse(JSON.stringify(halfTiles[Math.floor(Math.random() * halfTiles.length)]));
                             half.forEach(n => { n._isCompoundFiller = true; });
                             /* The filler can lead as well as follow — "16th triplet then dotted quarter"
                                is as valid as the reverse (Anthony, 2026-07-21). This replaces an earlier
                                figure-first rule that existed to stop a figure starting off the beat;
                                Anthony has since asked for that everywhere, ratio groups included. */
                             chosenTile = Math.random() < 0.5 ? [...fig, ...half] : [...half, ...fig];
                             chosenTile._type = fig._type;
                             usedBucketSize = 2;   // consumes both 1.0 pulses
                         }
                     }
                 }

                 /* === 0.75-BEAT RUNS ============================================================
                    A dotted 8th and the 16th-note ratio families (4:3, 5:3, 7:6, 8:6) are all 0.75 of
                    a beat, which is exactly why they never sat naturally on the grid: 0.75 divides no
                    whole number of beats until you stack them up.

                    So place N of them in a row (0.75N beats), pad to the next whole beat, and let that
                    padding be REAL rhythm content (runFiller) instead of one bare note. The padding may
                    sit BEFORE the run as easily as after it — which is what lets a 0.75 figure start on
                    any 16th partial rather than only ever the downbeat.

                    THE RUN IS ALWAYS A WHOLE NUMBER OF BEATS END TO END. That is the point of the shape,
                    not a coincidence: it keeps the off-beat feel INSIDE the run, so nothing after it is
                    shifted. (Anthony, 2026-08-02: "i wanna avoid having all the music offset to the e or
                    a partial because of a single .75 rhythm".)

                      reps   run    pad    total
                       1     0.75   0.25   1 beat
                       2     1.5    0.5    2 beats
                       3     2.25   0.75   3 beats
                       4     3.0    0      3 beats

                    2 and 4 stay the most likely — that pairing is the feel the old dotted-8th bank had
                    and Anthony asked to keep — but 1 and 3 are reachable now instead of impossible.
                    Every rep comes from the SAME family (a 5:3 run is a 5:3 run), though the variant may
                    differ rep to rep so rest placement still varies across the run. */
                 if (!chosenTile && usedBucketSize === 0) {
                     const b075 = applyDensityFilter(getStrictCandidates(0.75, false, restPct));
                     if (b075.length > 0 && _wantSpan === 0.75 && Math.random() < (V / 100)) {
                         // whole 1.0 pulses free from here on, so a 3-beat run is never started with 2 left
                         let freeBeats = 1;
                         while (i + freeBeats < pulseMap.length && pulseMap[i + freeBeats] === 1.0 &&
                                !restPulse[i + freeBeats] && freeBeats < 4) freeBeats++;
                         /* n:1/span:1 only ever has 1 spare sixteenth, so a lone figure could start on
                            "1" or "e" — never "&" or "a". Reaching those needed 3 sixteenths of lead,
                            which only a 3-rep run had room for, and 3-reps is the rarest count on
                            purpose — so starting on "a" was real but buried under two low-probability
                            events stacked on each other (Anthony, 2026-08-02: "why i dont see any .75
                            rhythms generating on the a partial"). n:1/span:2 gives a LONE figure its own
                            wide runway (5 spare sixteenths) so it can land on any partial without
                            needing to first roll the least common rep count. */
                         const REP_PLAN = [{ n: 1, span: 1, w: 2 }, { n: 1, span: 2, w: 3 }, { n: 2, span: 2, w: 5 },
                                           { n: 3, span: 3, w: 2 }, { n: 4, span: 3, w: 4 }];
                         const legal = REP_PLAN.filter(p => p.span <= freeBeats);
                         const seed = legal.length ? pickRandomStrict(b075) : null;
                         if (seed) {
                             const plan = weightedPick(legal, x => x.w);
                             const padSlots = Math.round((plan.span - 0.75 * plan.n) / 0.25);
                             const leadSlots = padSlots ? Math.floor(Math.random() * (padSlots + 1)) : 0;
                             const lead = runFiller(leadSlots * 0.25);
                             const trail = runFiller((padSlots - leadSlots) * 0.25);
                             const padOk = (lead.length > 0 || leadSlots === 0) &&
                                           (trail.length > 0 || padSlots - leadSlots === 0);
                             /* runFiller can legitimately come back empty (the speed cap refused every
                                shape at this tempo). Padding is what makes the run land on a beat, so a
                                missing piece means the run cannot be placed AT ALL — bail to the buckets
                                below rather than emit a tile that silently runs short and drags every
                                later figure off the grid, which is the exact problem this shape exists
                                to prevent. */
                             if (padOk) {
                                 const famList = b075.filter(v => v._type === seed._type);
                                 const parts = [];
                                 lead.forEach(n => { n._isCompoundFiller = true; n._subGroup = 0; });
                                 parts.push(...lead);
                                 for (let r = 0; r < plan.n; r++) {
                                     const fig = r === 0 ? seed : (pickRandomStrict(famList) || seed);
                                     let tCfg = fig._tuplet;
                                     if (tCfg === false) tCfg = { render: false };
                                     const figDur = fig.reduce((s, n) => s + (n.beats || 0), 0);
                                     /* A separate _subGroup per rep ONLY when the figure is bracketed:
                                        toRDM keys its tuplet buffer on groupId, so without it four 5:3s
                                        merge into one bracket spanning the lot. Un-bracketed figures
                                        (dotted 8ths) deliberately share a group so they still beam
                                        together the way a row of dotted 8ths should. */
                                     const sub = tCfg ? 0.1 * (r + 1) : 0;
                                     fig.forEach(n => {
                                         if (tCfg) { n._mixedTuplet = tCfg; n._mixedTupletDur = figDur; }
                                         n._subGroup = sub;
                                     });
                                     parts.push(...fig);
                                 }
                                 trail.forEach(n => { n._isCompoundFiller = true; n._subGroup = 0.9; });
                                 parts.push(...trail);
                                 chosenTile = parts;
                                 chosenTile._type = seed._type;
                                 usedBucketSize = plan.span;
                             }
                         }
                     }
                 }

                 // === 2-Beat Bucket Check (Rescue Logic) ===
                 if (!chosenTile && usedBucketSize === 0 && i + 1 < pulseMap.length && pulseMap[i+1] === 1.0 && !restPulse[i+1]) {
                     const rawB2 = getStrictCandidates(2.0, false, restPct); 
                     const b2Strict = applyDensityFilter(rawB2); 
                     const b1Strict = applyDensityFilter(getStrictCandidates(1.0, false, restPct));
                     
                     let bucketList = [];
                     if (b2Strict.length > 0) {
                         const forceBucket = (b1Strict.length === 0);
                         // variety-scaled 2-beat bucket; forceBucket keeps it as a safety net when no 1-beat tile exists
                         if (forceBucket || (_wantSpan === 2 && Math.random() < (V / 100))) bucketList = b2Strict;
                     }
                     else if (b1Strict.length === 0 && rawB2.length > 0) {
                         bucketList = rawB2;
                     }
                     
                     if (bucketList.length > 0) {
                         candidates = bucketList;
                         usedBucketSize = 2;
                     }
                 }
                 
                 // Fallback to 1 beat
                 if (usedBucketSize === 0) {
                     candidates = applyDensityFilter(getStrictCandidates(1.0, false, restPct));
                     usedBucketSize = 1;
                 }
            }
            
            // 2. COMPOUND TIME BUCKETS (1.5 Beat Base) + NEW MIXED PULSE
            else if (isPulseCompound && pulseDur === 1.5) {
                 
                 // NEW: Check for 3.0 beat buckets (Two Dotted Quarters)
                 if (i + 1 < pulseMap.length && pulseMap[i+1] === 1.5 && !restPulse[i+1]) {
                     const b3 = applyDensityFilter(getStrictCandidates(3.0, true, restPct));
                     const b15 = applyDensityFilter(getStrictCandidates(1.5, true, restPct));

                     const forceBucket = (b15.length === 0);
                     // variety-scaled 3.0 (two dotted-quarter) bucket; forceBucket keeps it as a safety net
                     if (b3.length > 0 && (forceBucket || Math.random() < 0.15 * (V / 100))) {
                         candidates = b3;
                         usedBucketSize = 2; // Consumes 2 pulses (1.5 + 1.5 = 3.0)
                     }
                 }

                 // Default 1.5 Logic (Standard Dotted Quarter)
                 if (usedBucketSize === 0) {
                     // === NEW: COMPOSITE PULSE LOGIC ===
                     // Chance to split 1.5 into (1.0 + 0.5) or (0.5 + 1.0). Variety-scaled: at low variety the
                     // compound beat stays whole/repeatable instead of splitting into a busier pattern.
                     // RESTRICTION: Only allow Triplets, 5-lets (16th), and 6-lets for the 1.0 beat portion.
                     if (Math.random() < 0.50 * (V / 100)) {
                         // 1. Get ALL 1.0 beat candidates
                         const allSimple = getStrictCandidates(1.0, false, restPct);
                         
                         // 2. Filter STRICTLY for Tuplets (8t, 5let16, 6let)
                         const allowedPrefixes = ["8t", "6let"];   // R16 item 2: 16th 5-lets kept OUT of compound (odd tuplet)
                         const tupletCandidates = allSimple.filter(t => allowedPrefixes.some(pre => t.id.startsWith(pre)));
                         
                         const simpleTiles = applyDensityFilter(tupletCandidates);
                         const halfTiles = getHalfBeatFillers();

                         if (simpleTiles.length > 0 && halfTiles.length > 0) {
                             const one = pickRandomStrict(simpleTiles);
                             
                             // MARKER: Identify these notes as the "Tuplet Island"
                             // We attach the config so Sticking/Rendering treats them as a distinct block
                             if (one) {
                                 // FIX: Handle "false" tuplets (like Quarter Note 100) correctly.
                                 // If _tuplet is explicitly false, we pass a config that prevents rendering.
                                 let tConfig = one._tuplet;
                                 if (tConfig === undefined) {
                                     tConfig = { num_notes: 3, notes_occupied: 2 };
                                 } else if (tConfig === false) {
                                     tConfig = { render: false };
                                 }
                                 
                                 one.forEach(n => n._mixedTuplet = tConfig);
                             }

                             const half = halfTiles[Math.floor(Math.random() * halfTiles.length)];
                             // MARKER: Identify filler notes for Sticking logic
                             half.forEach(n => n._isCompoundFiller = true);

                             // Randomly decide Order: Front-Loaded vs Back-Loaded
                             if (Math.random() < 0.5) {
                                 chosenTile = [...one, ...JSON.parse(JSON.stringify(half))]; 
                             } else {
                                 chosenTile = [...JSON.parse(JSON.stringify(half)), ...one]; 
                             }
                             usedBucketSize = 1; 
                         }
                     }
            }
}

            // 3. Default: Single Pulse Bucket (For 0.5 pulses or fallback)
            if (!chosenTile && usedBucketSize === 0 && candidates.length === 0) {
                candidates = applyDensityFilter(getStrictCandidates(pulseDur, isPulseCompound, restPct));
                usedBucketSize = 1;
            }

            if (!chosenTile && candidates.length > 0) {
                // RHYTHM VARIETY: on a standard single-pulse beat, with probability (100 - V)% REPEAT the
                // previous same-length beat's rhythm instead of picking a fresh one. Low V => the same beat
                // rhythm carries across the measure (and beyond); V=100 => always fresh (original behaviour).
                if (usedBucketSize === 1 && prevSingleTile && prevSingleDur === pulseDur && (Math.random() * 100) >= V) {
                    chosenTile = cloneTile(prevSingleTile);   // cloneTile keeps _tuplet/_type so sticking stays correct
                } else {
                    chosenTile = pickRandomStrict(candidates);
                    if (chosenTile && usedBucketSize === 1) {
                        prevSingleTile = cloneTile(chosenTile);
                        prevSingleDur = pulseDur;
                    }
                }
            }

            // --- FAIL SAFE (User request: Use Rest) ---
            if (!chosenTile) {
                 let fDur = "q";
                 let fDots = 0;
                 if (Math.abs(pulseDur - 1.5) < 0.01) { fDur = "q"; fDots = 1; }
                 else if (Math.abs(pulseDur - 1.0) < 0.01) { fDur = "q"; }
                 else if (Math.abs(pulseDur - 0.5) < 0.01) { fDur = "8"; }
                 chosenTile = [{ kind: "rest", dur: fDur, beats: pulseDur, dots: fDots, _fallback: true }];
            }

            // Apply Group ID and Positions
            const actualTileDur = chosenTile.reduce((s,n) => s + (n.beats||0), 0);
            let tempAbsPos = currentAbsPos;
            // _subGroup keeps two figures inside ONE tile in separate tuplet groups — toRDM keys its
            // local-tuplet buffer on groupId, so without it two back-to-back 4:3s merge into a single
            // bracket spanning both. Same fractional-id trick the compound splitter already uses.
            chosenTile.forEach(n => { n.groupId = (m * 100) + i + (n._subGroup || 0); n.absStart = tempAbsPos; tempAbsPos += (n.beats || 0); });
            measureBeats.push(chosenTile);
            currentAbsPos += actualTileDur;

            if (usedBucketSize > 1) {
                i += (usedBucketSize - 1); 
            } else if (actualTileDur > pulseDur + 0.01) {
                let eaten = actualTileDur;
                while (eaten > pulseDur + 0.01 && i < pulseMap.length - 1) {
                    eaten -= pulseMap[i+1];
                    i++; 
                }
            }
        }

        // --- HARD RULE: a measure can never be all rests ---
        // Three all-rest paths exist (per-pulse rest roll, all-rest variant tiles, the no-candidate
        // fail-safe). Retry the measure a few times; if it keeps coming up empty (extreme rest % +
        // rest-heavy variant curation), strike the first rest so the rule holds no matter what.
        const flatNotes = measureBeats.reduce((a, t) => a.concat(t), []);
        if (flatNotes.length && flatNotes.every(n => n.kind === "rest")) {
            if (emptyRetries < 8) { emptyRetries++; m--; continue; }
            const first = flatNotes[0];
            first.kind = "note";
        }
        emptyRetries = 0;

        /* Move an unfillable beat's rest somewhere random instead of always the end. Pick one rhythm
           that can't fill the bar — two 4:3 groups cover 3 of 4 beats — and the leftover quarter rest
           landed at the END of every single measure, which reads like a mistake rather than music.
           Only the no-candidate `_fallback` tiles move; rests the Rests slider rolled are already
           scattered by that roll. Guarded to uniform meters where every tile is a whole number of
           pulses, so a figure can never be shifted off the beat — asymmetric meters (5/8, 7/8) keep
           their written grouping untouched. (Anthony, 2026-07-21) */
        if (measureBeats.length > 1) {
            const pu = pulseMap[0];
            const uniform = pulseMap.every(p => Math.abs(p - pu) < 0.001);
            const durs = measureBeats.map(t => t.reduce((s, n) => s + (n.beats || 0), 0));
            const aligned = durs.every(d => Math.abs(d / pu - Math.round(d / pu)) < 0.001);
            if (uniform && aligned) {
                const fill = [], keep = [];
                /* A tile can hold TWO independent figures (the paired 1.5-beat bucket). Split it at the
                   sub-group boundary so the rest can land BETWEEN them, not only around the pair —
                   otherwise two 4:3 groups are welded together and the rest has just two homes.
                   Each half is 1.5 beats, so the second figure ends up starting off the beat; Anthony
                   asked for that explicitly. (2026-07-21) */
                measureBeats.forEach(t => {
                    if (t.length === 1 && t[0]._fallback) { fill.push(t); return; }
                    const subs = [];
                    t.forEach(n => { const g = n._subGroup || 0; if (subs.indexOf(g) < 0) subs.push(g); });
                    if (subs.length === 2) {
                        const a = t.filter(n => (n._subGroup || 0) === subs[0]);
                        const b = t.filter(n => (n._subGroup || 0) === subs[1]);
                        if (a.length && b.length) {
                            a._type = t._type; b._type = t._type;
                            keep.push(a); keep.push(b); return;
                        }
                    }
                    keep.push(t);
                });
                if (fill.length && keep.length) {
                    const reordered = keep.slice();
                    fill.forEach(t => reordered.splice(Math.floor(Math.random() * (reordered.length + 1)), 0, t));
                    measureBeats = reordered;
                    let pos = 0;                       // positions + group ids follow the new order
                    measureBeats.forEach((t, k) => t.forEach(n => {
                        n.groupId = (m * 100) + k + (n._subGroup || 0);
                        n.absStart = pos; pos += (n.beats || 0);
                    }));
                }
            }
        }

        out.push({ beats: measureBeats, timeSig: ts, pulseMap });
    }
    return out;
}


// ======================================================
// 2. STICKING LOGIC (UNIVERSAL GRID + DENSITY FIX)
// ======================================================
/* Natural sticking inside a tuplet: the hand comes from the note's PARTIAL, not its turn in the queue.
   "Natural" means the sticking the FULL rhythm would give with the unstruck partials simply skipped —
   a 4:3 is R L R L across its four partials, so a variation playing partials 1, 2 and 4 is R L L, not
   R L R. That is already how straight 16ths behave here, and it's exactly what separates Natural from
   the Alternating mode. The slot grid further down can't do it for a ratio rhythm (a 4:3 note is 0.375
   of a beat, so slots-per-beat is fractional), so walk the group in its OWN partials.
   Returns the hand the NEXT partial would take, so a filler after the group continues cleanly.
   (Anthony, 2026-07-21) */
function stickByPartial(list, startHand, nSlots, groupDur, other) {
    var slot = groupDur / (nSlots || list.length || 1), pos = 0;
    list.forEach(function (n) {
        if (n.kind === "note") {
            var p = Math.round(pos / slot);
            n.sticking = (p % 2 === 0) ? startHand : other(startHand);
        }
        pos += (n.beats || 0);
    });
    return (Math.round(pos / slot) % 2 === 0) ? startHand : other(startHand);
}

function applySticking(exercise, strategy) {
    if (!exercise) return;

    currentStickingStrategy = isStickingVisible ? strategy : "none";

    // Reset all sticking
    exercise.forEach(m => m.beats.forEach(b => b.forEach(n => delete n.sticking)));

    if (!isStickingVisible) return;

    const globalLead = currentLeadHand || "R";
    const other = (h) => (h === "R" ? "L" : "R");

    // Rudiment Strategies
    if (RUDIMENT_STICKINGS.includes(strategy)) {
        let pattern = [];
        if (strategy === "alternate") pattern = [globalLead, other(globalLead)];
        if (strategy === "doubles") pattern = [globalLead, globalLead, other(globalLead), other(globalLead)];
        if (strategy === "paradiddle") pattern = [globalLead, other(globalLead), globalLead, globalLead, other(globalLead), globalLead, other(globalLead), other(globalLead)];
        
        let idx = 0;
        exercise.forEach(m => m.beats.forEach(beat => beat.forEach(n => {
            if (n.kind === "note") { 
                n.sticking = pattern[idx % pattern.length]; 
                idx++; 
            }
        })));
        return;
    }

    // Natural Sticking (Grid-Based)
    if (strategy === "natural") {
        let currentHand = globalLead;
        const is16thGridActive = (allow16thsEl && allow16thsEl.checked);

        exercise.forEach(measure => {
            measure.beats.forEach(beat => {
                if (!beat || beat.length === 0) return;

                const beatLead = currentHand;
                const beatDur = beat.reduce((s,n) => s + (n.beats||0), 0);
                const isCompoundBeat = Math.abs(beatDur - 1.5) < 0.05;

                // --- 1. COMPOUND TIME HANDLING (6/8, 9/8, etc.) ---
                if (isCompoundBeat) {
                    const isMixed = beat.some(n => !!n._mixedTuplet); // Detect Mixed Meter Pulse

                    if (isMixed) {
                        // === NEW: Mixed Pulse Sticking (1.0 + 0.5 or 0.5 + 1.0) ===
                        let hand = beatLead, fi = 0;
                        while (fi < beat.length) {
                            const n = beat[fi];
                            /* A filler on a grid FINER than 16ths (32nds) walks its own partials — a
                               sustain inside it covers two slots, which plain alternation can't see.
                               Bracketed fillers (the 16th triplet) keep their existing handling below. */
                            if (n._isCompoundFiller && n._fillerSlots > 2 && !n._mixedTuplet) {
                                const grp = [];
                                while (fi < beat.length && beat[fi]._isCompoundFiller &&
                                       beat[fi]._fillerSlots === n._fillerSlots && !beat[fi]._mixedTuplet) {
                                    grp.push(beat[fi]); fi++;
                                }
                                hand = stickByPartial(grp, hand, n._fillerSlots, 0.5, other);
                                continue;
                            }
                            fi++;
                            if (n.kind === "rest") continue;

                            if (n._isCompoundFiller) {
                                // CASE A: The Filler (0.5 Beat)
                                n.sticking = hand;
                                
                                // FIX: Differentiate 16ths (RL) vs 8ths (R...R)
                                if (n.dur === "16" || n.dur === "32") {
                                     // If filler is 16ths: STRICT ALTERNATING (R L)
                                     hand = other(hand);
                                } else {
                                     // If filler is 8th: Check Density (Ghosting)
                                     // If 16ths are allowed, 8th takes 2 slots (Hit, Ghost) -> Next is Same Hand
                                     if (is16thGridActive) hand = hand; 
                                     else hand = other(hand);
                                }
                            } 
                            else {
                                // CASE B: The Tuplet Island (1.0 Beat)
                                // Strict Alternating regardless of grid
                                n.sticking = hand;
                                hand = other(hand);
                            }
                        }

                        // Set the start hand for the NEXT pulse
                        currentHand = hand;
                        return;
                    }

                    // === STANDARD COMPOUND LOGIC (UNCHANGED) ===
                    const has16ths = beat.some(n => n.dur === "16" || n.dur === "32");
                    if (has16ths || is16thGridActive) {
                        let localPos = 0; 
                        beat.forEach(n => {
                            if (n.kind === "note") {
                                const slot = Math.round((localPos / 1.5) * 6);
                                n.sticking = (slot % 2 === 0) ? beatLead : other(beatLead);
                            }
                            localPos += (n.beats || 0);
                        });
                        currentHand = beatLead; 
                    } else {
                         let localPos = 0; 
                         beat.forEach(n => {
                             if (n.kind === "note") {
                                 const slot = Math.round((localPos / 1.5) * 3); 
                                 n.sticking = (slot % 2 === 0) ? beatLead : other(beatLead);
                             }
                             localPos += (n.beats || 0);
                         });
                         currentHand = other(beatLead);
                    }
                    return;
                }

                /* --- 1b. TUPLET ISLAND (ratio rhythms in the 1.5-beat bucket) ---
                   The island walks its OWN partials (see stickByPartial); a plain filler note after it
                   just carries on alternating from whatever hand the group ended on. */
                if (beat.some(n => n._mixedTuplet)) {
                    /* Two islands can sit in ONE tile — a 7:6 figure followed by its 16th-triplet
                       filler — and they are different tuplets. Collecting every consecutive note that
                       merely HAS a _mixedTuplet merged them into one 10-note group walked as a 7-let,
                       so the filler came out "L L R" instead of "L R L". Break the group when the
                       tuplet identity changes: its ratio, or its _subGroup (which is exactly what marks
                       the filler apart, and what toRDM keys its bracket on). (Anthony, 2026-07-21) */
                    const sameIsland = (a, b) =>
                        !!a && !!b &&
                        a._mixedTuplet.num_notes === b._mixedTuplet.num_notes &&
                        a._mixedTuplet.notes_occupied === b._mixedTuplet.notes_occupied &&
                        (a._subGroup || 0) === (b._subGroup || 0);
                    let hand = beatLead, i = 0;
                    while (i < beat.length) {
                        const mt = beat[i]._mixedTuplet;
                        if (mt) {
                            const head = beat[i];
                            const grp = [];
                            while (i < beat.length && beat[i]._mixedTuplet && sameIsland(head, beat[i])) {
                                grp.push(beat[i]); i++;
                            }
                            const gDur = head._mixedTupletDur ||
                                         grp.reduce((s, n) => s + (n.beats || 0), 0);
                            hand = stickByPartial(grp, hand, mt.num_notes || grp.length, gDur, other);
                        } else if (beat[i]._fillerSlots > 2) {
                            /* An unbracketed filler on a finer-than-16th grid (four 32nds) walks its own
                               partials: a sustain inside it covers two slots, so alternating note by note
                               would hand the rest of the half the wrong sticking. */
                            const fs = beat[i]._fillerSlots, grp = [];
                            while (i < beat.length && beat[i]._fillerSlots === fs && !beat[i]._mixedTuplet) {
                                grp.push(beat[i]); i++;
                            }
                            hand = stickByPartial(grp, hand, fs, 0.5, other);
                        } else {
                            if (beat[i].kind === "note") { beat[i].sticking = hand; hand = other(hand); }
                            i++;
                        }
                    }
                    currentHand = hand;
                    return;
                }

                /* --- 1c. ANY OTHER TUPLET — same rule, one level up ---
                   Walk the tuplet's own partials rather than the slots-per-beat grid below, which only
                   lines up while every note is one slot wide. A double here (R R / L L) is CORRECT when
                   the struck partials happen to share a hand — that is what the full rhythm's sticking
                   gives. Sextuplets keep their own deliberate 6-slot rule. */
                if (beat._tuplet && !beat._forceSixLetSticking) {
                    currentHand = stickByPartial(beat, beatLead, beat._tuplet.num_notes || 3, beatDur, other);
                    return;
                }

                // --- 2. SIMPLE TIME HANDLING (Standard Grid) ---
                let slotsPerBeat = 2; // Default 8ths

                if (beat._forceSixLetSticking) {
                    slotsPerBeat = 6;
                }
                else if (beat._tuplet) {
                    const n = beat._tuplet.num_notes;
                    const dur = beatDur || 1; 
                    if (n === 3 && Math.abs(dur - 2.0) < 0.05) slotsPerBeat = 3; 
                    else slotsPerBeat = n / dur;
                } else {
                    const has16ths = beat.some(n => n.dur === "16" || n.dur === "32");
                    /* A half-beat filler carries the grid it was CUT from, which the note values alone
                       can't show: two 16ths sliced out of a 32nd variation ("1010") sit on partials 0
                       and 2 of a 32nd grid, so they share a hand — read as plain 16ths they'd alternate.
                       Matters when the rest-relocation pass leaves a filler standing on its own beat. */
                    const has32nds = beat.some(n => n.dur === "32" || n._fillerSlots > 2);
                    const hasSextuplets = beat.some(n => n._localTuplet || Math.abs(n.beats - 1/6) < 0.01);

                    if (has32nds) {
                        slotsPerBeat = 8;   // 32nd grid — alternate hands every 32nd
                    } else if (hasSextuplets) {
                        slotsPerBeat = 6;
                    } else {
                        // 16th grid (4 slots) when the beat actually contains a 16th, OR the global 16th
                        // toggle is on — EXCEPT a tile that originated from the 8s category: its 8ths always
                        // alternate (2 slots), regardless of the toggle. (A 16s-variation 8th keeps the grid.)
                        if (has16ths || (is16thGridActive && beat._type !== "8s")) slotsPerBeat = 4;
                        else slotsPerBeat = 2;
                    }
                }

                // Apply Sticking
                let localPos = 0;
                beat.forEach(n => {
                    if (n.kind === "note") {
                        const slot = Math.round(localPos * slotsPerBeat);
                        n.sticking = (slot % 2 === 0) ? beatLead : other(beatLead);
                    }
                    localPos += (n.beats || 0);
                });

                // Calculate next hand
                const totalSlots = Math.round(beatDur * slotsPerBeat);
                if (totalSlots % 2 !== 0) {
                    currentHand = other(beatLead);
                } else {
                    currentHand = beatLead;
                }

                /* SYNCOPATION RULE (Anthony, 2026-07-23). A lone struck 8th sitting by itself in a beat
                   (a syncopated 8th, NOT two 8ths from the 8s category) is not part of a 16th run, so the
                   16th-grid "skip the ghosted partial, keep the same hand" parity does not apply to it —
                   the next struck note should just alternate off it. Without this, an 8th standing between
                   5-lets (or before a 16th figure) doubled the hand (R R / L L) because the 8th + its rest
                   span an even number of 16th slots. We flip off the 8th's OWN hand, which is right whether
                   it sits on the downbeat or the "and". */
                const _struck = beat.filter(n => n.kind === "note");
                if (_struck.length === 1 && beat._type !== "8s" && !beat._tuplet &&
                    Math.abs((_struck[0].beats || 0) - 0.5) < 0.02 && _struck[0].sticking) {
                    currentHand = other(_struck[0].sticking);
                }
            });
        });
    }
}



// ======================================================
// 3. RENDERING & COUNTING (VEXFLOW)
// ======================================================
function getCountingText(absPos, posInBeat, groupDur, tupletType, timeSig, pulseMap, isRatio, is32) {
    if (!currentShowCounts) return null;
    const eps = 0.02;

    const parts = (timeSig || "4/4").split("/");
    const den = parseInt(parts[1], 10);
    const isEighthMeter = (den === 8);

    // Helper to get the Beat Number (e.g. "1", "2")
    const getBeatNum = (pos) => {
        if (isEighthMeter) return getEighthCount(pos, pulseMap);
        return Math.floor(pos + eps) + 1;
    };

    // ==========================================
    // 0. ENGINE V2 TUPLETS — septuplets (7) and the ratio rhythms whose num_notes is 4 or 8
    //    (4:3, 8:3, 4:6, 8:6). No syllable system for these; number every slot 1..N. (5-lets/6-lets
    //    keep their dedicated syllable branches below; 7/4/8 are exclusive to the new families.)
    // ==========================================
    if (isRatio || tupletType === 7 || tupletType === 4 || tupletType === 8) {
        const slot = Math.round((posInBeat / groupDur) * tupletType) % tupletType;
        return (slot + 1).toString();
    }

    // ==========================================
    // 1. 5-LETS
    // ==========================================
    if (tupletType === 5) {
        if (groupDur > 1.8) {
             const idx = Math.round((posInBeat / groupDur) * 5) % 5;
             return (idx + 1).toString();
        }
        let offset = 0.0;
        if (Math.abs((posInBeat * 10) % 2 - 1) < 0.1) offset = 0.5;
        const relPos = posInBeat - offset;
        const idx = Math.round(relPos * 5) % 5;
        return (idx + 1).toString();
    }

    // ==========================================
    // 2. SEXTUPLETS & 16th TRIPLETS (Tuplet 6)
    // ==========================================
    if (tupletType === 6) {
        // UNIVERSAL PULSE LOGIC (Solves 4/4 vs 9/8 and Sextuplet vs Straight 16ths)
        // We look strictly at the 0.5 beat window.
        
        const pulseOffset = posInBeat % 0.5; // Where are we in the current 0.5 slice?
        
        // CHECK 1: Start of a 0.5 Pulse (0.0)
        if (pulseOffset < 0.05 || pulseOffset > 0.45) {
            // In 9/8 (Eighth Meter), every 0.5 step is a main Pulse Number (1, 2, 3)
            if (isEighthMeter) return getBeatNum(absPos).toString();

            // In 4/4 (Simple Meter):
            // 0.0 = Beat Number
            // 0.5 = "&"
            const beatPhase = absPos % 1.0; 
            if (Math.abs(beatPhase - 0.5) < 0.1) return "&";
            return getBeatNum(absPos).toString();
        }

        // CHECK 2: Straight 16th Note (0.25)
        // If we are exactly halfway through the 0.5 pulse, it's an "&" (or "e"/"a" in 16ths)
        // This catches the "Compound 16ths" in 9/8 -> 1 (&) 2 (&)
        if (Math.abs(pulseOffset - 0.25) < 0.05) {
            return "&";
        }

        // CHECK 3: Triplet / Sextuplet Syllables
        // Map remaining positions (0.16, 0.33) to "la" and "li"
        const slot = Math.round((pulseOffset / 0.5) * 3);
        if (slot === 1) return "la";
        if (slot === 2) return "li";
        
        return "";
    }

    // ==========================================
    // 3. TRIPLETS (Tuplet 3)
    // ==========================================
    if (tupletType === 3) {
        // CASE A: Composite Triplet (Inside 1.5 beat group)
        // We use Offset Logic to keep the triplet intact (spanning across pulses)
        if (Math.abs(groupDur - 1.5) < 0.1) {
            let startOffset = 0.0;
            const checkBack = (posInBeat - 0.5) * 3;
            if (Math.abs(checkBack - Math.round(checkBack)) < 0.1) startOffset = 0.5;

            const relativeOffset = posInBeat - startOffset;
            const slot = Math.round(relativeOffset * 3) % 3;

            if (slot === 0) return getBeatNum(absPos).toString();
            if (slot === 1) return "la";
            if (slot === 2) return "li";
        }

        // CASE B: Standard Logic (Simple Meter / Standard Grid)
        const slot = Math.round((posInBeat / groupDur) * 3) % 3;

        if (slot === 0) {
            if (isEighthMeter) return getBeatNum(absPos).toString();
            const beatPhase = absPos % 1.0;
            if (Math.abs(beatPhase - 0.5) < 0.1) return "&"; 
            return getBeatNum(absPos).toString();
        }

        return (slot === 1) ? "la" : "li";
    }

    // ==========================================
    // 4. 9-LETS
    // ==========================================
    if (tupletType === 9) {
        const slot = Math.round((posInBeat / groupDur) * 9) % 9;
        return ((slot % 3) + 1).toString();
    }

    // ==========================================
    // 5. FALLBACK (Standard 8ths/16ths)
    // ==========================================
    if (isEighthMeter) {
        let scan = 0;
        let offsetInPulse = 0;
        if (pulseMap) {
            for (let i = 0; i < pulseMap.length; i++) {
                if (absPos >= scan - eps && absPos < scan + pulseMap[i] - eps) {
                    offsetInPulse = absPos - scan;
                    break;
                }
                scan += pulseMap[i];
            }
        }
        const remainder = offsetInPulse % 0.5;
        if (Math.abs(remainder) < 0.1 || Math.abs(remainder - 0.5) < 0.1) {
             return getEighthCount(absPos, pulseMap);
        }
        return "&";
    }

    // Simple Meter Fallback
    const beatNum = Math.floor(absPos + eps) + 1;
    const beatRelPos = absPos % 1.0;
    
    if (beatRelPos < eps || beatRelPos > 1 - eps) return beatNum.toString();
    /* A beat built from 32nds counts "1 e & a  & e & a" — each HALF of the beat is spoken like its own
       group of four (Anthony, 2026-07-21). It has to be checked before the 16th positions below because
       the two schemes DISAGREE on the same spot: 0.25 is "e" when the beat is 16ths but "&" when it is
       32nds. is32 is set by the caller from the beat's own finest subdivision. */
    if (is32) {
        var _i32 = Math.round(beatRelPos * 8);
        var _SYL32 = ["", "e", "&", "a", "&", "e", "&", "a"];
        if (_i32 > 0 && _i32 < 8 && Math.abs(beatRelPos * 8 - _i32) < 0.05) return _SYL32[_i32];
    }
    if (Math.abs(beatRelPos - 0.5) < eps) return "&";
    if (Math.abs(beatRelPos - 0.25) < eps) return "e";
    if (Math.abs(beatRelPos - 0.75) < eps) return "a";
    // 32nd-note in-between slots on a NON-32nd beat — the "ta" of "1 ta e ta & ta a ta"
    if (Math.abs(beatRelPos - 0.125) < eps || Math.abs(beatRelPos - 0.375) < eps ||
        Math.abs(beatRelPos - 0.625) < eps || Math.abs(beatRelPos - 0.875) < eps) return "ta";

    return null;
}

// Helper to get just the main number for tuplets in X/8
function getEighthCount(absPos, pulseMap) {
    const eps = 0.02;
    let scan = 0;
    if (pulseMap) {
        for (let i = 0; i < pulseMap.length; i++) {
            // Check if absPos is within this pulse
            if (absPos >= scan - eps && absPos < scan + pulseMap[i] - eps) {
                const offset = absPos - scan;
                // FIX: Add small buffer (0.001) to offset to prevent 0.999 -> 0 errors
                const eighth = Math.floor((offset + 0.001) / 0.5);
                return (eighth + 1).toString();
            }
            scan += pulseMap[i];
        }
    }
    return "1";
}


// UPDATED SIGNATURE: Accepts timeSig and pulseMap

/* ============================================================
   NEW SHELL — RDM adapter + public API (everything above is the
   verbatim extracted brain; everything below is Engine V2 glue)
   ============================================================ */

// DEFAULT curation: only each rhythm's FULL variation starts selected (Anthony, round 7) — the
// variation pickers are the surface for opening up the rest. dottedQ is exempt from the Set by
// design (whole-category toggle), so it needs no ids here. Named + exported (G.FULL_IDS) so the
// "Full" preset button in app.js can reset the active Set to exactly these.
var FULL_VARIATION_IDS = [
  "q_1", "q_cmp_111",             // quarters (simple + compound full)
  "8s_11", "8s_c_111",            // 8ths (simple + compound full)
  "16s_1111", "cmp_6let_111111",  // 16ths (simple full + compound-grid full clone)
  "8t_111", "qt_111",             // triplets / quarter triplets
  "5let_11111", "5let16_11111",   // 8th 5-lets / 5-lets
  "6let_111111", "9let_111111111", // sextuplets / 9-lets
  // Engine V2 expansion — each new family's FULL run is the default-active variant (rest surface via
  // the variation picker, exactly like 6-lets / 9-lets).
  "7let_1111111", "7let8_1111111", // septuplets (16th / 8th)
  // "dotted8_da" was a stale id left over from when this family was gallops — it matched nothing, so
  // switching dotted 8ths on produced NOTHING. The real full runs are the 2- and 4-note groups.
  // dotted8_1_1 is the SINGLE dotted 8th — the 0.75-beat run builder needs it active to place dotted
  // 8ths off the downbeat or in 1s/3s (2026-08-02); the 2/4 groups stay for the on-beat forms.
  "32nd_11111111", "dotted8_1_1", "dotted8_2_11", "dotted8_4_1111",   // 32nds / dotted 8ths
  "r43_1111", "r53_11111", "r73_1111111", "r83_11111111",   // ratio :3 family
  "r46_1111", "r56_11111", "r76_1111111", "r86_11111111"    // ratio :6 family
];
/* Default stays FULL-ONLY — the Rhythms panel's "Full" button sits in its off/dim state on a fresh load
   (Anthony, 2026-07-21). Combined with Rests at 0 this means a new user opens the Lab to clean, complete
   rhythms and no rests at all; the 2152 variations, the holes and the silence are all opt-in.
   Consequence worth knowing: Sparsity does nothing until you switch more variations on, because a full
   run has no holes in it by definition. */
FULL_VARIATION_IDS.forEach(function (id) { activeVariations.add(id); });

var BEAMABLE_DURS = { "8": 1, "16": 1, "32": 1, "64": 1 };
function isBeamableEv(n) { return n.kind !== "rest" && !!BEAMABLE_DURS[n.dur]; }

// one playable RDM event from a generated note (same shape as stickings.js mkHit/mkRest)
function mkEvent(n) {
  var rest = n.kind === "rest";
  return { rest: rest, beats: Number(n.beats) || 0, dur: n.dur, dots: Number(n.dots) || 0,
    step: "c", oct: 5, head: "normal",
    heads: rest ? null : [{ step: "c", oct: 5, head: "normal" }],
    // ornaments come off the note (applyOrnaments tags them); default off
    accent: !!n.accent, marcato: false, tenuto: false, staccato: false,
    roll: n.roll || 0, buzz: !!n.buzz,
    flam: !!n.flam, graces: null, stick1: null, stick2: null, dynamic: null };
}

/* Ornament density pass (Ornaments tab). For each STRUCK note: an accent lands independently at its
   density; a flam ALSO lands independently at its own density — a flam is a grace note in front of the
   main stroke, so it can stack with whatever that main stroke is (a flammed diddle, a flammed buzz roll,
   or a flammed plain note are all real rudiments). Diddle and buzz stay MUTUALLY EXCLUSIVE with each
   other (measured-double vs. press-roll are alternative stem markings — a note can't be both), chosen by
   cumulative density between just the two of them. Densities are 0..1. Mutates the note objects in
   place; mkEvent copies the flags onto the RDM event. (Anthony, 2026-07-21: "diddles can combine with
   flams, and buzzes can combine with flams, allow this to happen.")
   NOTE: the adjacency rule right below (never a buzz/diddle immediately BEFORE a following note's flam)
   is a separate concern — the roll bleeding into the NEXT note's grace note — and still applies. */
function applyOrnaments(exercise, orn) {
  if (!orn) return;
  var aD = clamp01(orn.accent), fD = clamp01(orn.flam), dD = clamp01(orn.diddle), bD = clamp01(orn.buzz);
  if (!aD && !fD && !dD && !bD) return;
  var sum2 = dD + bD, k2 = sum2 > 1 ? 1 / sum2 : 1;   // diddle/buzz still share ONE exclusive space
  var dT = dD * k2, bT = (dD + bD) * k2;
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      if (!tile || !tile.length) return;
      tile.forEach(function (n) {
        if (n.kind === "rest") return;
        if (aD && Math.random() < aD) n.accent = true;
        if (fD && Math.random() < fD) n.flam = true;   // independent roll — can land alongside a diddle/buzz below
        if (sum2 > 0) {
          /* ANY note may be picked here — including quarters and dotted quarters. The pass further
             down rewrites a diddled note to the rhythm's own value first, so a quarter inside a 4:3
             becomes an 8th diddle + an 8th rest, exactly as a dotted 8th inside a 16th figure becomes
             a 16th diddle + an 8th rest. Whatever still can't be played as a measured double after
             that rewrite (a quarter-note rhythm, anything dotted all the way through) has its diddle
             taken back off there. (Anthony, 2026-07-21) */
          var canDiddle = true;
          var x = Math.random();
          if (x < dT) { if (canDiddle) n.roll = 1; }        // one slash = diddle (measured double)
          else if (x < bT) n.buzz = true;                   // "z" = buzz / press roll
        }
      });
    });
  });

  /* --- A DIDDLE IS PLAYED AT THE RHYTHM'S OWN NOTE VALUE ------------------------------------------
     "1110" in 16ths is written 16, 16, 8 — the 3rd partial sustains through the 4th. Put a diddle on
     that 3rd partial and it must become a 16th-note diddle followed by a 16th REST, never an 8th-note
     diddle: every note in the figure stays one type. So a diddled note shrinks to the tile's own base
     unit and the time it gave up becomes a rest.
     Only a note actually CARRYING a diddle is touched — the same figure without one still reads
     16, 16, 8. Runs before toRDM(), so beams and tuplet indices are built from the corrected tile, and
     before the flam pass below, so the new rest can clear a flam conflict the way any rest does.
     (Anthony, 2026-07-21) */
  var ORN_LADDER = ["32", "16", "8", "q", "h", "w"];        // same ladder buildV2Families uses
  // multiples of the base value -> [ladder steps, dots]. 0.5 and 1.5 exist because a DOTTED note is
  // 1.5 units, so its leftover can be half a unit (dotted 8th over an 8th base = 8th + 16th rest).
  var ORN_UNIT = { 0.5: [-1, 0], 1: [0, 0], 1.5: [0, 1], 2: [1, 0], 3: [1, 1],
                   4: [2, 0], 6: [2, 1], 8: [3, 0], 12: [3, 1] };
  function ornGlyph(baseDur, k) {
      var bi = ORN_LADDER.indexOf(baseDur), m = ORN_UNIT[k];
      if (bi < 0 || !m || bi + m[0] >= ORN_LADDER.length || bi + m[0] < 0) return null;
      return { dur: ORN_LADDER[bi + m[0]], dots: m[1] };
  }
  var ornDotMul = function (d) { return d === 1 ? 1.5 : d === 2 ? 1.75 : 1; };
  /* The leftover written as ONE or TWO rests, never a tie — the same largest-legal-first rule
     splitRun() uses for notes (RHYTHM-RULES.md §3). A dotted quarter in a 16th figure is 6 units, so
     shrinking it leaves 5, and 5 has no single notehead: it is written 4 + 1. Without this the whole
     rewrite bailed and dropUnplayable() stripped the diddle. (Anthony, 2026-07-21) */
  function ornRests(baseDur, k) {
      var g = ornGlyph(baseDur, k);
      if (g) return [{ g: g, u: k }];
      for (var a = Math.floor(k); a >= 1; a--) {
          var g1 = ornGlyph(baseDur, a), g2 = ornGlyph(baseDur, k - a);
          if (g1 && g2) return [{ g: g1, u: a }, { g: g2, u: k - a }];
      }
      return null;
  }
  /* A tile's notes may belong to more than one RHYTHMIC GROUP — a ratio-tuplet island sharing a tile
     with its plain filler is exactly the case the comment below already flagged. Grouping id is the
     same identity toRDM's beamTupKey uses to decide what may beam together; two notes here must share
     a base for the same reason they'd share a beam. (Anthony, 2026-08-02 — a 5:3 sharing a tile with a
     16th filler had the filler's shorter value drag the WHOLE tile's base down to a 16th, so every 5:3
     note — already sitting at its own correct 8th value — got needlessly shrunk to a 16th diddle + a
     16th rest. "we should have a normal 5:3 rhythm... every note got chopped into half the note and
     its split rest." A group's own notes already self-describe its real base; the bug was letting an
     unrelated neighbor's notes vote on it.) */
  function ornGroupKey(n) {
    if (n._mixedTuplet) return "m:" + n._mixedTuplet.num_notes + "/" + n._mixedTuplet.notes_occupied + "#" + (n.groupId != null ? n.groupId : "x");
    if (n._localTuplet) return "l:#" + (n.groupId != null ? n.groupId : "x");
    if (n._compoundGrid) return "c:#" + (n.groupId != null ? n.groupId : "x");
    return "";
  }
  // a measured double is only playable on an undotted 8th or shorter. Anything still failing that
  // AFTER the rewrite below could not be reduced, so it loses the diddle.
  /* SPEED CAP (Anthony, 2026-07-31). A roll is only legal if its STROKES are humanly playable at the
     tempo actually in use. Benchmark: 16th-note rolls at 180bpm is the fastest roll that may ever
     generate — a diddled 16th is two 32nds, so at 180 that's 2 × 180 / (60 × 0.25) = 24 strokes a
     second, and that rate becomes the ceiling for every rhythm shape.
     Judging by stroke RATE rather than by note value is what makes it scale: the same rule blocks
     32nd diddles from about 90bpm, 16ths past 180, and leaves 8ths legal to 360 — no per-shape table
     to maintain. `n.beats` is the note's REAL played length, so tuplet-compressed notes (a quarter
     inside a quarter-triplet) are judged by what they actually sound like, same as the rule below. */
  var MAX_STROKES_PER_SEC = 2 * 180 / (60 * 0.25);   // = 24, i.e. 16ths at 180bpm
  var rollTooFastAt = function (beats, roll) {
    var bpm = +(SET && SET.tempo) || 100;
    beats = +beats;
    if (!(beats > 0) || !(bpm > 0)) return false;            // unknown length: leave it to the rules below
    var strokes = Math.pow(2, Math.max(1, roll | 0));        // a diddle is 2, the next depth 4, …
    return (strokes * bpm) / (60 * beats) > MAX_STROKES_PER_SEC + 1e-9;
  };
  var rollTooFast = function (n) { return rollTooFastAt(n.beats, n.roll); };
  var okRollDur = function (n) {
    if (n.dots) return false;
    if (rollTooFast(n)) return false;
    if (n.dur === "8" || n.dur === "16" || n.dur === "32") return true;
    /* A written quarter inside a COMPRESSING tuplet is not really a quarter: a quarter-note triplet
       is written "q" but lasts 2/3 of a beat, so diddling it gives two 8th-note TRIPLETS — exactly
       the stroke rate the 8th-triplet family already diddles happily. Judging by the written value
       alone refused those, which is what blocked quarter-triplet diddles. Judge by what is actually
       PLAYED instead: n.beats < 1 means the tuplet has squeezed it below a real quarter.
       (Anthony, 2026-07-31: "allow diddles to generate on top of quarter note triplets".) */
    return n.dur === "q" && n.beats < 0.99;
  };
  var dropUnplayable = function (list) {
    list.forEach(function (n) { if (n.roll && !okRollDur(n)) n.roll = 0; });
  };
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      if (!tile || !tile.length) return;
      /* In a family whose own rhythm IS the dotted value — Dotted Quarters, Dotted 8ths — that value
         never converts (Anthony, 2026-07-21). Its MIXED tiles were the leak: in "q. 8" the plain 8th
         made the tile's base an 8th, so the dotted quarter counted as 3 units and became "8~ + quarter
         rest". Bail before any base is worked out; dropUnplayable() then leaves the plain 8th diddled
         and simply takes the diddle off the dotted quarter, giving "q. 8~".
         Keyed on FAMILY_DOTTED, not on FAMILY_BASE being absent: procedural filler tiles have no
         _type at all and those SHOULD still convert. This stays TILE-wide: a dotted family is never
         itself split across groups, so there is nothing for per-group scoping to protect here. */
      if (FAMILY_DOTTED[tile._type]) { dropUnplayable(tile); return; }

      // split into contiguous same-identity runs FIRST — a group's base must come only from its own
      // notes, never from a neighboring group that happens to share the tile (see ornGroupKey above)
      var groups = [];
      tile.forEach(function (n) {
        var k = ornGroupKey(n);
        var last = groups[groups.length - 1];
        if (last && last.key === k) last.notes.push(n);
        else groups.push({ key: k, notes: [n] });
      });

      var out = [], changed = false;
      groups.forEach(function (grp) {
        var notes = grp.notes;
        /* The figure is defined by its NOTES; a rest only gets a vote when the notes say nothing.
           "8th, 16th-rest, 8th, 16th-rest, 8th" is already uniform — those 16th rests are gaps, and
           letting them set the base would drag real 8ths down to 16ths and change the rhythm. But in
           "16th-rest + dotted 8th" the rest is the ONLY thing left saying the figure is built from
           16ths, so it has to count there. Hence: notes first, rests as the fallback. */
        var baseIdx = null, baseDur = null, restIdx = null, restDur = null;
        notes.forEach(function (n) {
          if (n.dots) return;
          var i = ORN_LADDER.indexOf(n.dur);
          if (i < 0) return;
          if (n.kind === "rest") {
            if (restIdx == null || i < restIdx) { restIdx = i; restDur = n.dur; }
          } else if (baseIdx == null || i < baseIdx) { baseIdx = i; baseDur = n.dur; }
        });
        if (baseIdx == null) { baseIdx = restIdx; baseDur = restDur; }
        // the FAMILY's own value is a floor: a tile that is one long note (16s_1000 = a bare quarter)
        // says nothing about the rhythm it came from, but the family does. Only valid when this group
        // IS the whole tile — tile._type names the tile's overall rhythm, not one island inside a mix.
        if (notes.length === tile.length) {
          var famDur = FAMILY_BASE[tile._type], famIdx = famDur ? ORN_LADDER.indexOf(famDur) : -1;
          if (famIdx >= 0 && (baseIdx == null || famIdx < baseIdx)) { baseIdx = famIdx; baseDur = famDur; }
        }
        /* Sparsity 0 does NOT block the conversion (Anthony, 2026-07-21 — reversing the rule added earlier
           the same day). Sparsity governs which VARIATION is picked: at 0 only a completely filled figure
           is legal, which is enforced in getStrictCandidates. The diddle rewrite happens afterwards and is
           a different thing — a diddle is always played at the rhythm's own note value, and the rest it
           leaves behind is part of the diddle, not a hole in the rhythm. */
        // every note in this group is dotted and the family is unknown: nothing to reduce TO
        if (baseIdx == null) { dropUnplayable(notes); out.push.apply(out, notes); return; }
        notes.forEach(function (n) {
          if (n.kind === "rest" || !n.roll) { out.push(n); return; }
          var i = ORN_LADDER.indexOf(n.dur);
          if (i < 0) { out.push(n); return; }
          // how many base units this note is worth, by WRITTEN value: a dotted 8th over a 16th base = 3
          var units = Math.pow(2, i - baseIdx) * ornDotMul(n.dots);
          var pieces = units > 1 ? ornRests(baseDur, units - 1) : null;
          if (!pieces) { out.push(n); return; }       // can't be reduced — dropUnplayable() decides below
          var unit = n.beats / units;
          /* DECIDE PLAYABILITY BEFORE REWRITING, and judge it by the value the diddle is actually PLAYED
             at (`unit`), not the value it was written as.
             dropUnplayable() runs at the END of this pass, so a note used to be shortened and given its
             rest FOR a diddle and then have the diddle stripped — leaving an orphaned "32nd + 32nd rest"
             where a plain note belongs, with nothing to explain the rest. That was always possible; the
             2026-08-02 speed cap made it the norm, and at 200bpm with diddles at 100% the orphans
             outnumbered the real diddles (709 vs 537 over 40 exercises). Anthony reported it as
             "wtf ... another 32nd note fuck up".
             Bailing here leaves the note whole and un-diddled, which is what an unplayable diddle should
             degrade to. Judging by `unit` also makes the cap correct for tuplets: a quarter inside a 4:3
             is diddled as two 8ths, so 8ths are the rate that matters, not the written quarter. */
          if (rollTooFastAt(unit, n.roll)) { n.roll = 0; out.push(n); return; }
          // remember the whole note so a LATER pass that strips this diddle can put it back (see unroll())
          n._preRoll = { dur: n.dur, dots: n.dots, beats: n.beats };
          n.dur = baseDur; n.dots = 0; n.beats = unit;
          out.push(n);
          /* EVERY rest INHERITS the note's tuplet membership. Without it toRDM sees a plain event, calls
             flushLocal(), and the group ends — so a fully diddled 4:3 came out as four separate "4:3"
             brackets, one per note, instead of one bracket over the whole four-let. The rests are part of
             the same tuplet; they just aren't struck. (Anthony, 2026-07-21) */
          pieces.forEach(function (p) {
            out.push({ kind: "rest", dur: p.g.dur, dots: p.g.dots, beats: unit * p.u,
                       groupId: n.groupId, _preserve: true, _diddleRest: true,
                       _mixedTuplet: n._mixedTuplet, _mixedTupletDur: n._mixedTupletDur,
                       _localTuplet: n._localTuplet, _compoundGrid: n._compoundGrid });
          });
          changed = true;
        });
      });
      dropUnplayable(out);
      if (!changed) return;
      var abs = tile[0] && tile[0].absStart;
      tile.length = 0;                        // rewrite IN PLACE — _tuplet etc. live on the array itself
      out.forEach(function (n) {
        if (abs != null) { n.absStart = abs; abs += (n.beats || 0); }
        tile.push(n);
      });
    });
  });

  // HARD RULE: never a buzz or diddle IMMEDIATELY before a flam — the roll would bleed into the grace
  // note. Flam wins; the offending buzz/diddle is dropped. A rest between the two clears the conflict.
  var prev = null;
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      (tile || []).forEach(function (n) {
        if (n.kind === "rest") { prev = n; return; }
        if (n.flam && prev && prev.kind !== "rest" && (prev.buzz || prev.roll)) { prev.buzz = false; prev.roll = 0; }
        prev = n;
      });
    });
  });

  /* PUT BACK any note whose diddle was stripped AFTER it had already been rewritten.
     The rewrite shortens a diddled note and inserts the rest that belongs to the diddle; the flam rule
     just above then drops the diddle from some of them, which would leave a bare "32nd + 32nd rest"
     with nothing to explain the rest. `_preRoll` carries the note's original value, so it is restored
     exactly rather than being reconstructed from the fragments. */
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      if (!tile || !tile.length) return;
      var out = [], changed = false;
      for (var i = 0; i < tile.length; i++) {
        var n = tile[i];
        if (n.kind !== "rest" && n._preRoll && !n.roll && !n.buzz) {
          n.dur = n._preRoll.dur; n.dots = n._preRoll.dots; n.beats = n._preRoll.beats;
          delete n._preRoll;
          out.push(n);
          while (i + 1 < tile.length && tile[i + 1]._diddleRest) { i++; changed = true; }   // swallow its rests
          continue;
        }
        if (n._preRoll) delete n._preRoll;      // kept its diddle; the marker has done its job
        out.push(n);
      }
      if (!changed) return;
      var abs = tile[0] && tile[0].absStart;
      tile.length = 0;
      out.forEach(function (e) {
        if (abs != null) { e.absStart = abs; abs += (e.beats || 0); }
        tile.push(e);
      });
    });
  });
}
function clamp01(v) { v = (v == null ? 0 : v) / 100; return v < 0 ? 0 : v > 1 ? 1 : v; }

/* HARD RULE: the note right after a buzzed or diddled note MUST be the opposite hand (a rest between them
   clears it). Runs after sticking + ornaments are set. Called from generate() AND restyle() — restyle
   re-runs applySticking (which wipes stickings) but not applyOrnaments, so the rule must re-apply there too.

   A RUDIMENT STICKING RESOLVES THE SAME CLASH FROM THE OTHER END (Anthony, 2026-08-02). A pattern has its
   own same-hand doubles built in — a paradiddle is R L R R, so notes 3 and 4 are both right — and
   rewriting note 4 to L to satisfy the rule stops it being a paradiddle, for that note and every note
   after it. When the drummer has explicitly picked a pattern, the pattern wins and the ORNAMENT comes off
   instead. Stated once it covers every pattern, including any added later: a note may carry a diddle or
   buzz only where the sticking already changes hands on the next struck note. Paradiddles therefore lose
   note 3 of each group (and note 7, its mirror), doubles lose the 1st and 3rd of R R L L, and alternating
   loses nothing.

   The ornament is STASHED rather than deleted, because the sticking picker restyles the sheet live — a
   diddle that disappeared on a look at Paradiddles has to come back on the way out.

   Suppressing here can never orphan a rest: applyOrnaments' diddle rewrite always leaves a rest behind the
   note it shortened, and a rest clears the adjacency, so a rewritten diddle is never in clash to begin
   with. Only diddles playing at the rhythm's own value reach this, and dropping one just takes the slash
   off a note whose length never changed. */
function oppositeHandAfterRolls(exercise) {
  if (!exercise) return;
  var rudiment = RUDIMENT_STICKINGS.indexOf(currentStickingStrategy) >= 0;
  var prev = null;
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      (tile || []).forEach(function (n) {
        if (n.kind === "rest") { prev = n; return; }   // a rest breaks the adjacency
        // legal again (sticking changed, or was switched off entirely) — take it back off the shelf
        if (n._ornHold) { n.roll = n._ornHold.roll; n.buzz = n._ornHold.buzz; delete n._ornHold; }
        if (prev && prev.kind !== "rest" && (prev.buzz || prev.roll) && prev.sticking && n.sticking &&
            prev.sticking === n.sticking) {
          if (rudiment) {
            prev._ornHold = { roll: prev.roll, buzz: prev.buzz };
            prev.roll = 0; prev.buzz = false;
          } else {
            n.sticking = (prev.sticking === "R" ? "L" : "R");
          }
        }
        prev = n;
      });
    });
  });
}

/* INVERTED MOTION — a hand needs TIME to lift from a tap up to an accent (Anthony, 2026-08-02).
   This is the THIRD and last of the speed rules, and it is a different SHAPE from the other two. The
   roll cap and the alternating cap are both stroke RATES; this one is a minimum INTERVAL, because what
   limits it is not how fast the hand moves but how long it has to travel from tap height to accent
   height. Anthony's definition, settled by worked example rather than guessed:

     look at ONE hand's own strokes in order, ignoring whatever the other hand does in between.
     Where a LOW stroke is followed by an ACCENT on that hand, the gap must be big enough to lift.

   "Its own strokes in order" is the key part — the two strokes may be adjacent notes, or separated by
   the other hand.

   BENCHMARK: **one 16th at 140bpm** = 0.25 beat = ~0.107s. Read as "a hand can turn a tap into an accent
   one sixteenth later, up to 140bpm".
   ⚠️ This was first coded as 0.5 beat at 140 (~0.214s) — reading "accented 16ths to 140" as the gap
   between ALTERNATING strokes, i.e. two 16ths apart. That is twice too strict and it showed
   immediately: back-to-back accented FLAMS became impossible at any tempo. A flam's grace is the
   opposite hand, so two flams in a row hand a single 16th to the same hand — grace, then accent — and
   at 100bpm that is 0.15s, under the old 0.214s floor. Flam accents are a standard rudiment, so a rule
   that forbids them is wrong on its face. (Anthony, 2026-08-02: "I just don't see r to R happening at a
   slower tempo. for example I don't see any back to back accented flams.")
   Scales by itself from the one benchmark: an adjacent same-hand pair (0.25 beat) is legal to 140, an
   alternating pair (0.5 beat) to 280 — which never binds in practice, since the plain-alternating cap
   already stops 16ths near 300. So this rule now bites only where it should: genuinely tight same-hand
   turnarounds, not ordinary accented reading.

   THREE things occupy a hand besides its own plain note, and all of them start the lift clock:
     - a DIDDLE or BUZZ strikes again inside the note, so the hand is still busy mid-note;
     - a FLAM's grace note is played by the OPPOSITE HAND to the main note (Anthony: "Grace notes are
       always the opposite hand of a primary note for a flam"), so a flam charges the OTHER hand, not
       the one playing the note. Getting that backwards would have policed the wrong hand entirely.

   Only LOW -> HIGH is limited. High -> high is a full stroke and high -> low is a downstroke; neither
   needs the hand to travel up against the clock.

   Fix when violated: drop the ACCENT, never the note. The rhythm the drummer reads is unchanged; it
   just isn't marked at a speed where marking it would be a lie. Suppressed accents are stashed in
   `_accHold` and restored at the top of every pass, so a sticking change (which restyle() can cause,
   and which moves which hand plays what) re-decides from scratch instead of eroding the sheet. */
var MIN_LIFT_SEC = 0.25 * 60 / 140;   // = 0.1071s — ONE 16th at 140bpm (see the benchmark note above)

/* HOW OFTEN an inverted motion is allowed to happen at all, on top of being physically possible.
   (Anthony, 2026-08-02: "can you make the inverts not too common?")

   Worth being precise about why a rarity knob is even needed: an accent is an inverted motion whenever
   the SAME hand's previous stroke was low — so with accents scattered at random, very nearly every
   accent is one, and the page turns into a wall of them. Thinning them does not just reduce accents, it
   changes their SHAPE: an accent following another accent on that hand is not inverted (the hand is
   already up), so what survives clusters into runs, which is how accent patterns actually read.

   It cannot go to zero: a run of accents has to START somewhere, and that first one is always an
   inverted motion. So this is a frequency dial, not an on/off.

   The roll is STORED on the note (`_invRoll`) rather than taken fresh each pass. restyle() re-runs this
   whole rule, and an un-stored Math.random() would reshuffle the accents every time the sticking
   changed — the sheet would visibly churn under the reader.

   Exposed as `settings.invertRate` (0..1) with the constant as the default, so this can become a real
   Ornaments slider later without touching the rule itself. */
/* 0.30 measured at ~1.5 inverted motions per bar (down from ~3.5 unthinned), which is what "not too
   common" looked like on the page. ⚠️ KNOWN SIDE EFFECT, deliberate rather than overlooked: because
   most accents ARE inverted motions, thinning them also pulls overall accent density below what the
   Accents slider asks for (at slider 35 the sheet lands nearer 15%). The alternative — topping the
   density back up by extending accent RUNS, which are free since a hand already up needs no lift —
   would keep the slider honest but pushes the sheet toward run-heavy accent-tap patterns. Worth doing
   only if Anthony wants that character; left out for now rather than guessed at. */
var INVERT_KEEP = 0.30;               // default: ~1 in 3 legal inverted motions is kept
function invertKeep() {
  var v = SET && SET.invertRate;
  return (typeof v === "number" && v >= 0 && v <= 1) ? v : INVERT_KEEP;
}
function liftTimeAccents(exercise) {
  if (!exercise) return;
  var bpm = +(SET && SET.tempo) || 100;
  if (!(bpm > 0)) return;
  var minBeats = MIN_LIFT_SEC * bpm / 60;
  var keep = invertKeep();

  // every pass starts from the un-suppressed truth, so this is a fresh decision rather than a ratchet
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      (tile || []).forEach(function (n) { if (n._accHold) { n.accent = true; delete n._accHold; } });
    });
  });

  /* Time is accumulated here rather than read off absStart: absStart is per-MEASURE, and this rule has
     to reach across a barline like any other. Notes are already in playing order. */
  var strokes = { R: [], L: [] }, t = 0;
  exercise.forEach(function (mm) {
    (mm.beats || []).forEach(function (tile) {
      (tile || []).forEach(function (n) {
        var dur = n.beats || 0;
        if (n.kind !== "rest") {
          var h = n.sticking;
          if (h === "R" || h === "L") {
            var other = h === "R" ? "L" : "R";
            strokes[h].push({ t: t, n: n });
            if (n.roll || n.buzz) strokes[h].push({ t: t + dur / 2, n: null });   // strikes again mid-note
            if (n.flam) strokes[other].push({ t: t, n: null });                    // grace = OPPOSITE hand
          }
        }
        t += dur;
      });
    });
  });

  /* One forward pass per hand. Heights are updated AS WE GO: suppressing an accent turns that stroke
     low, which legitimately constrains the next one — so the decision has to be sequential, not a
     snapshot taken up front. */
  ["R", "L"].forEach(function (h) {
    var list = strokes[h].sort(function (a, b) { return a.t - b.t; });
    var prevT = null, prevLow = false;
    list.forEach(function (s) {
      var isAcc = !!(s.n && s.n.accent);
      // an accent is an INVERTED MOTION when this hand's own previous stroke was low
      var inverted = isAcc && prevLow && prevT != null;
      if (inverted && (s.t - prevT) < minBeats - 1e-9) {
        s.n.accent = false; s.n._accHold = true; isAcc = false;          // physically impossible
      } else if (inverted) {
        // possible, but keep them uncommon. Stored roll, so restyle() reproduces the same sheet.
        if (s.n._invRoll == null) s.n._invRoll = Math.random();
        if (s.n._invRoll >= keep) { s.n.accent = false; s.n._accHold = true; isAcc = false; }
      }
      prevT = s.t; prevLow = !isAcc;
    });
  });
}

// count-off bar: ALWAYS a full 4/4 bar of four quarter-note clicks (Anthony: every exercise counts off in
// 4/4, even when the exercise itself is in another meter). The exercise's real meter is drawn on measure 1
// (toRDM's `changed` check flips true after the 4/4 count-off). step "d" + head "x" = the engine's tap-off
// convention: _buildPlayback flags these isTapoff -> the loud count-off click; pulseMap [1,1,1,1] so the
// metronome also clicks four steady quarters through the count-off.
function countInMeasure(firstMeasure) {
  var events = [];
  for (var i = 0; i < 4; i++) {
    events.push({ rest: false, beats: 1, dur: "q", dots: 0, step: "d", oct: 5, head: "x",
      heads: [{ step: "d", oct: 5, head: "x" }],
      accent: false, marcato: false, tenuto: false, staccato: false, roll: 0, buzz: false,
      flam: false, graces: null, stick1: null, stick2: null, dynamic: null });
  }
  return { timeSig: [4, 4], repeatStart: false, repeatEndTimes: 0, events: events, beams: [], tuplets: [],
    extraVoices: [], pulseMap: [1, 1, 1, 1] };
}

/* exercise (from generateExercise + applySticking) -> RDM measures.
   Reproduces old buildMeasure(): global tuplet per tile, local/mixed tuplet
   grouping by groupId, pulse-aware beaming (break at pulse boundaries + rests,
   9-lets sub-beamed in 3s), smart brackets (= NOT one continuous beam). */
function toRDM(exercise, settings) {
  var measures = [];
  var prevTs = null;

  /* OPT-IN as of 2026-07-31 (was: on unless explicitly disabled). The app counts you in itself now — see
     the engine's _countOffArmed/_countOffPulses — so writing a count-off bar onto the sheet as well is a
     duplicate, and it pushed every bar number up by one. Nothing in the app passes countIn:true; the
     builder below is kept because the capability is still sound if it's ever wanted again. */
  if (settings.countIn === true && exercise.length) {
    var ci = countInMeasure(exercise[0]);
    measures.push(ci);
    prevTs = ci.timeSig;
  }

  exercise.forEach(function (mm) {
    var events = [], beams = [], tuplets = [];

    // pulse boundaries (beat edges) for beam breaking
    var bounds = {}; var acc = 0;
    (mm.pulseMap || []).forEach(function (p) { acc += p; bounds[Math.round(acc * 1000)] = 1; });

    // non-tuplet beam run
    var run = [];
    function flushRun() { if (run.length >= 2) beams.push(run.slice()); run = []; }

    // A beam must NEVER join notes that belong to different rhythmic groups — a
    // (local/mixed) tuplet must beam apart from the plain notes next to it. In simple
    // meters a beat boundary always falls between them, but an asymmetric/compound pulse
    // (dotted-quarter = 1.5 beats) can hold e.g. an 8th-triplet + a plain 8th in the SAME
    // pulse with no boundary between, so we also break the run whenever tuplet membership
    // changes. Key = which local/mixed/compound group a note is in ("" = a plain note).
    var prevBeamTupKey = "";
    function beamTupKey(n) {
      if (n._mixedTuplet) { var c = n._mixedTuplet; return "m:" + c.num_notes + "/" + c.notes_occupied + "#" + (n.groupId != null ? n.groupId : "x"); }
      if (n._localTuplet)  return "l:#" + (n.groupId != null ? n.groupId : "x");
      if (n._compoundGrid) return "c:#" + (n.groupId != null ? n.groupId : "x");
      return "";
    }

    // local/mixed tuplet buffer (same continuation rules as old PASS 2)
    var lbuf = [], lcfg = null, lgid = null;
    function flushLocal() {
      if (lbuf.length) {
        var cfg = lcfg || { num_notes: 3, notes_occupied: 2 };
        if (cfg.render !== false) {
          var allBeam = lbuf.every(function (x) { return x.beamable; });
          tuplets.push({ idx: lbuf.map(function (x) { return x.idx; }),
            num: cfg.num_notes, inSpaceOf: cfg.notes_occupied, bracket: !allBeam, show: true });
        }
      }
      lbuf = []; lcfg = null; lgid = null;
    }

    (mm.beats || []).forEach(function (tile) {
      if (!tile || !tile.length) return;
      var gcfg = tile._tuplet;
      var isGlobal = !!(gcfg && gcfg !== false);
      var groupDur = tile.reduce(function (s, n) { return s + (n.beats || 0); }, 0);
      var tType = isGlobal ? (gcfg.num_notes || 3) : 0;
      var tileIdx = [];
      var localPos = 0;

      if (isGlobal) flushLocal();   // a global-tuplet tile ends any open local group

      tile.forEach(function (n) {
        var ev = mkEvent(n);

        // counts (stick1 row) + sticking (stick2 row) — notes only, old rules
        if (n.kind !== "rest") {
          var activeTuplet = tType;
          if (!activeTuplet) {
            if (n._mixedTuplet) activeTuplet = n._mixedTuplet.num_notes;
            else if (n._localTuplet) activeTuplet = 6;
            else if (n._compoundGrid) activeTuplet = 6;
            else activeTuplet = 0;
          }
          /* A ratio rhythm counts by NUMBER — 1 2 3 4 for a 4:3, 1..5 for a 5:3 — not by the 5-let/6-let
             syllables. notes_occupied tells them apart: a real 5-let is 5:4, a ratio 5 is 5:3 or 5:6.
             It also has to be measured against the GROUP's duration, not the whole tile's. */
          var _mt = n._mixedTuplet;
          var _isRatio = !!(_mt && (_mt.notes_occupied === 3 || _mt.notes_occupied === 6));
          var _gDur = n._mixedTupletDur || groupDur || 1.0;
          var cnt = currentShowCounts
            ? getCountingText(n.absStart || 0, localPos, _gDur, activeTuplet, mm.timeSig, mm.pulseMap, _isRatio,
                              tile.some(function (x) { return x.dur === "32"; }))
            : null;
          var stk = isStickingVisible ? (n.sticking || null) : null;
          if (cnt && stk) { ev.stick1 = stk; ev.stick2 = cnt; }   // stick1=top row → sticking above counts
          else if (stk) { ev.stick1 = stk; }
          else if (cnt) { ev.stick1 = cnt; }
        }

        var idx = events.length;
        events.push(ev);
        tileIdx.push(idx);

        // local/mixed tuplets only apply outside a global-tuplet tile
        if (!isGlobal) {
          var isMixed = !!n._mixedTuplet, isLocal = !!n._localTuplet;
          if (isMixed || isLocal) {
            var cfg = n._mixedTuplet || { num_notes: 3, notes_occupied: 2 };
            var match = lcfg && lcfg.num_notes === cfg.num_notes &&
                        lcfg.notes_occupied === cfg.notes_occupied && lgid === n.groupId;
            if (!match) { flushLocal(); lcfg = cfg; lgid = n.groupId; }
            lbuf.push({ idx: idx, beamable: isBeamableEv(n) });
          } else {
            flushLocal();
          }
        }
        localPos += (n.beats || 0);
      });

      // global tuplet wrapper (bracket = not one continuous beam, unless the bank pinned it)
      if (isGlobal && gcfg.render !== false) {
        var allBeam = tile.every(isBeamableEv);
        var bracket = !allBeam;
        if (typeof gcfg.bracketed === "boolean") bracket = gcfg.bracketed;
        tuplets.push({ idx: tileIdx.slice(), num: gcfg.num_notes || 3,
          inSpaceOf: gcfg.notes_occupied || 2, bracket: bracket, show: true });
      }

      // beaming
      if (isGlobal) {
        flushRun();
        prevBeamTupKey = "__global";   // global tile owns its own beam; next note must break from it
        var trun = [];
        var flushT = function () { if (trun.length >= 2) beams.push(trun.slice()); trun = []; };
        tile.forEach(function (n, k) {
          // one continuous beam per tuplet tile (9-lets included) — only a rest inside breaks it
          if (isBeamableEv(n)) trun.push(tileIdx[k]);
          else flushT();
        });
        flushT();
      } else {
        tile.forEach(function (n, k) {
          var atBoundary = bounds[Math.round((n.absStart || 0) * 1000)];
          var tk = beamTupKey(n);
          if (atBoundary || tk !== prevBeamTupKey) flushRun();
          if (isBeamableEv(n)) run.push(tileIdx[k]); else flushRun();
          prevBeamTupKey = tk;
        });
      }
    });
    flushRun(); flushLocal();

    var p = (mm.timeSig || "4/4").split("/");
    var tsArr = [parseInt(p[0], 10) || 4, parseInt(p[1], 10) || 4];
    var changed = !prevTs || prevTs[0] !== tsArr[0] || prevTs[1] !== tsArr[1];
    measures.push({ timeSig: changed ? tsArr : null, repeatStart: false, repeatEndTimes: 0,
      events: events, beams: beams, tuplets: tuplets, extraVoices: [],
      pulseMap: (mm.pulseMap || []).slice() });   // per-measure grouping for the metronome (grouped-pulse mode)
    prevTs = tsArr;
  });

  // Tempo mark on the first bar (Anthony, 2026-07-16): the mark describes the MEASURE IT SITS OVER, which
  // is always the count-off bar (measures[0], see countInMeasure above) — and that's unconditionally a 4/4
  // bar of straight quarters, no matter what meter the exercise body itself is in. So the mark is always
  // "♩ = N" here, full stop; there's no compound/dotted-quarter case to detect (unlike Playalongs, where the
  // count-off — and so the mark — genuinely varies per piece, straight from that piece's own MusicXML).
  if (measures.length) {
    /* The mark describes the bar it sits over. That USED to be guaranteed to be the 4/4 count-off bar, so
       a plain "♩ = N" was always right. With the count-off bar gone (2026-07-31) it now sits over the
       first REAL bar, which can be compound — and a 6/8 bar is felt in dotted quarters. Deriving it keeps
       the mark, the engine's beatUnitMult() and the tempo the transport reports all saying the same thing. */
    var ts0 = measures[0].timeSig || [4, 4];
    var compound0 = ts0[1] === 8 && ts0[0] > 3 && ts0[0] % 3 === 0;
    measures[0].tempoMark = { beatUnit: "quarter", dots: compound0 ? 1 : 0, perMinute: Math.round(settings.tempo || 100) };
  }

  return measures;
}

/* ---------------- public API ---------------- */

// the Sticking ON/OFF toggle overrides the chosen pattern without forgetting it
function effectiveSticking(settings) {
  if (settings.stickingOn === false) return "none";
  return settings.sticking === "none" ? "none" : (settings.sticking || "natural");
}

function generate(settings) {
  settings = settings || {};
  SET = settings;
  currentLeadHand   = settings.leadHand === "L" ? "L" : "R";
  isStickingVisible = effectiveSticking(settings) !== "none";
  currentShowCounts = settings.showCounts !== false;

  var ex = generateExercise({
    measures: Math.max(1, Math.min(32, settings.measures || 8)),
    timeSignatures: (settings.timeSigs && settings.timeSigs.length) ? settings.timeSigs : ["4/4"],
    // ceiling was 60 (the old slider's max) — anything above it was silently truncated, so the top of
    // the new 0-100 slider did nothing at all. Default 50 to match the slider's resting position.
    restPct: Math.max(0, Math.min(100, settings.restPct == null ? 0 : settings.restPct)),
    allowSyncopation: !!settings.syncopation,
    variety: settings.variety == null ? 100 : Math.max(0, Math.min(100, settings.variety))
  });
  var eff = effectiveSticking(settings);
  applySticking(ex, eff === "none" ? "natural" : eff);
  applyOrnaments(ex, settings.ornaments);
  oppositeHandAfterRolls(ex);   // note after a buzz/diddle = opposite hand (after sticking + ornaments)
  // LAST: which hand plays what is only final once the rule above has done its flips, and this rule is
  // entirely about what a given HAND has to do — so it cannot run any earlier than this.
  liftTimeAccents(ex);

  // the tempo mark is always "♩ = N" now (see toRDM), so the typed number IS true quarter-notes/min —
  // no felt-pulse scaling needed here.
  var qTempo = Math.round(settings.tempo || 100);
  return {
    title: settings.title || "Sight Reading",
    tempo: qTempo,
    measures: toRDM(ex, settings),
    _ex: ex   // raw exercise retained so annotation changes can restyle without a new rhythm
  };
}

/* Re-annotate an existing sheet (sticking / lead hand / counts) WITHOUT generating a new rhythm.
   Re-runs applySticking (which resets n.sticking first) + toRDM on the retained raw exercise.
   Deliberately does NOT re-run applyOrnaments — ornament flags already live on the note objects
   and re-rolling densities would compound them. */
function restyle(score, settings) {
  if (!score || !score._ex) return score;
  settings = settings || {};
  SET = settings;
  currentLeadHand   = settings.leadHand === "L" ? "L" : "R";
  var eff = effectiveSticking(settings);
  isStickingVisible = eff !== "none";
  currentShowCounts = settings.showCounts !== false;
  applySticking(score._ex, eff === "none" ? "natural" : eff);
  oppositeHandAfterRolls(score._ex);   // re-apply the rule (applySticking wiped the flips; buzz/roll flags persist)
  // a restyle can change the STICKING, which changes which hand must lift where — so the accent
  // decision has to be re-made too (it restores its own suppressions first, so this never ratchets)
  liftTimeAccents(score._ex);
  return {
    title: score.title,
    tempo: score.tempo,
    measures: toRDM(score._ex, settings),
    _ex: score._ex
  };
}

global.RDMSightGen = {
  generate: generate,
  restyle: restyle,
  VARIANTS: RHYTHM_VARIANTS,     // post-expansion bank (incl. runtime cmp_ clones in 16s)
  active: activeVariations,      // LIVE Set of enabled variant ids — mutate to curate generation
  FULL_IDS: FULL_VARIATION_IDS,  // each rhythm's FULL variation only — the "Full" preset resets to these
  CATEGORIES: [
    { key: "q",      label: "Quarters" },
    { key: "dottedQ",label: "Dotted Quarters" },
    { key: "8s",     label: "8th Notes" },
    { key: "16s",    label: "16th Notes" },
    { key: "8t",     label: "Triplets" },
    { key: "qt",     label: "Quarter Triplets" },
    { key: "5let",   label: "8th 5-lets" },
    { key: "5let16", label: "5-lets" },
    { key: "6let",   label: "Sextuplets" },
    { key: "9let",   label: "9-lets" },
    { key: "7let",   label: "7-lets" },
    { key: "7let8",  label: "8th 7-lets" },
    { key: "32nd",   label: "32nd Notes" },
    { key: "dotted8",label: "Dotted 8ths" },
    { key: "r43",    label: "4:3 (8ths)" },
    { key: "r53",    label: "5:3 (8ths)" },
    { key: "r73",    label: "7:6 (16ths)" },
    { key: "r83",    label: "8:6 (16ths)" },
    { key: "r46",    label: "4:3 (16ths)" },
    { key: "r56",    label: "5:3 (16ths)" },
    { key: "r76",    label: "7:6 (32nds)" },
    { key: "r86",    label: "8:6 (32nds)" }
  ],
  TIME_SIGS: [
    { label: "2/4",  value: "2/4",     group: "Simple" },
    { label: "3/4",  value: "3/4",     group: "Simple" },
    { label: "4/4",  value: "4/4",     group: "Simple" },
    { label: "5/4",  value: "5/4",     group: "Simple" },
    { label: "6/4",  value: "6/4",     group: "Simple" },
    { label: "6/8",  value: "6/8",     group: "Compound" },
    { label: "9/8",  value: "9/8",     group: "Compound" },
    { label: "12/8", value: "12/8",    group: "Compound" },
    { label: "5/8",  value: "5/8",     group: "Asymmetric" },
    { label: "7/8",  value: "7/8",     group: "Asymmetric" },
    { label: "9/8*", value: "9/8_asym",group: "Asymmetric" }
  ],
  STICKINGS: [
    // patterns only — hiding sticking is the Sticking ON/OFF toggle's job now
    { label: "Natural",     value: "natural" },
    { label: "Alternating", value: "alternate" },
    { label: "Doubles",     value: "doubles" },
    { label: "Paradiddles", value: "paradiddle" }
  ]
};

/* The Rhythms tiles read SLOWEST → FASTEST: fewest notes per beat first, most condensed last
   (Anthony, 2026-07-21). Density is MEASURED from each family's FULL variation (every slot struck)
   rather than hand-ordered, so the list stays correct on its own if a family's span or note count ever
   changes. Where a family has both a simple and a compound full (quarters, 8ths, 16ths) the SIMPLE one
   defines it — the compound variants only surface in a compound meter, so they shouldn't drag the
   category's position. dottedQ has no FULL id at all (it's a whole-category toggle), so it falls back
   to its first variant, the bare dotted quarter. */
(function orderCategoriesBySpeed(G) {
  var isFull = {};
  (G.FULL_IDS || []).forEach(function (id) { isFull[id] = 1; });
  function notesPerBeat(v) {
    var span = v.notes.reduce(function (a, n) { return a + (n.beats || 0); }, 0);
    var n = v.notes.filter(function (x) { return x.kind !== "rest"; }).length;
    return span > 0 ? n / span : 0;
  }
  var density = {};
  G.CATEGORIES.forEach(function (c) {
    var list = G.VARIANTS[c.key] || [];
    var fulls = list.filter(function (v) { return isFull[v.id]; });
    if (!fulls.length) fulls = list.slice(0, 1);
    var vals = fulls.map(notesPerBeat);
    density[c.key] = vals.length ? Math.min.apply(null, vals) : 0;
  });
  // key tiebreak keeps the order deterministic where two families share a density (r46 / r83 = 5.333)
  G.CATEGORIES.sort(function (a, b) {
    return (density[a.key] - density[b.key]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  G.CATEGORY_DENSITY = density;      // exposed for dev scripts
  CATEGORY_DENSITY = density;        // and used live by the Subdivision slider in pickRandomStrict

  /* Each family's own note value, read off its FULL run. A tile that is one long note — "16s_1000" is
     a bare quarter — carries nothing saying which rhythm it came from, so the diddle rewrite has no
     base to reduce to and the note stays undiddled. The family knows. Dotted-only families (dotted8)
     deliberately get NO base: there is nothing plain to reduce to, so they keep refusing diddles. */
  Object.keys(G.VARIANTS).forEach(function (key) {
    var list = G.VARIANTS[key] || [];
    var full = list.filter(function (v) { return isFull[v.id]; })[0] || list[0];
    if (!full) return;
    var best = null;
    full.notes.forEach(function (n) {
      if (n.kind === "rest" || n.dots) return;
      var i = ["32", "16", "8", "q", "h", "w"].indexOf(n.dur);
      if (i >= 0 && (best == null || i < best)) best = i;
    });
    if (best != null) FAMILY_BASE[key] = ["32", "16", "8", "q", "h", "w"][best];
    else FAMILY_DOTTED[key] = true;   // nothing plain to reduce to — the dotted value IS the rhythm
  });
})(global.RDMSightGen);

})(typeof window !== "undefined" ? window : globalThis);
