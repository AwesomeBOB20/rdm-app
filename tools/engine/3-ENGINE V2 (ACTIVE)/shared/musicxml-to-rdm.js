/* ============================================================
   MusicXML -> RDM music format  (musicxml-to-rdm.js)

   The "pressing machine" of RDM Engine V2: turns a Sibelius snare
   .musicxml export into the ONE shared format every RDM tool reads.
   Pure data in, pure data out (uses DOMParser, no other DOM/UI).

   ---- the RDM music format ----
   {
     title, tempo,                          // tempo = quarter BPM
     measures: [{
       timeSig:[num,den]|null,              // present only when it changes (always on measure 0)
       repeatStart:bool,                    // forward repeat barline here
       repeatEndTimes:number,               // >0 = backward repeat, play this many times total
       events:[ Event ],
       beams:[ [eventIdx,...], ... ],       // groups of event indices beamed together
       tuplets:[ {idx:[eventIdx,...], num, inSpaceOf, bracket, show}, ... ]
     }]
   }
   Event = {
     rest, beats, dur("w|h|q|8|16|32|64"), dots,
     step, oct,                             // staff position from <display-step>/<display-octave>
                                            //   c/5 = drum hit / rimshot (middle space, the common one)
                                            //   d/5 = stick click (4th line), e/5 = rim click (4th space)
     head,                                  // notehead glyph: "normal"|"x"|"cross"|"slashed"|"diamond"
     accent, marcato, tenuto, staccato,     // > ^ - .   (marcato ^ = rooftop / shot)
     roll,                                  // MEASURED tremolo slashes: 0 none / 1 diddle / 2 / 3 (single-bounce)
     buzz,                                  // true = UNMEASURED tremolo (a "z" through the stem = press/buzz roll)
     flam,                                  // true if grace note(s) precede it
     graces,                                // [{step,oct,head,dur,slash},...] | null  (the grace notes, 1=flam 2=drag/ruff)
                                            //   dur  = the grace's OWN <type> ("8"|"16"|...) — a ruff is
                                            //          written as 16ths, a flam as an 8th; null if the file
                                            //          left <type> off (renderer then picks by grace count)
                                            //   slash = <grace slash="yes"> (the acciaccatura slash)
     stickAbove, stickBelow,                // "R"|"L"|null  (1 sticking => below; 2 => 1st above, 2nd below)
     dynamic                                // "p"|"f"|"mf"|... | null  (sits below the stickings)
   }
   Repeats are NOT written out here (real sheet music doesn't) — the
   renderer draws repeat barlines; audio/playhead expand them via rdmOrder().
   ============================================================ */
(function (global) {
  "use strict";

  var TYPE_TO_DUR = { whole:"w", half:"h", quarter:"q", eighth:"8", "16th":"16", "32nd":"32", "64th":"64", "128th":"64" };
  function txt(el, sel){ if(!el) return null; var n = el.querySelector(sel); return n ? n.textContent.trim() : null; }

  // A staff position as a single diatonic index so we can shift a whole piece up/down by whole
  // note-lines. value = octave*7 + step (c=0..b=6); c/5 => 35. Inverse recovers {step,oct}.
  var STEPS = "cdefgab";
  function diatonicValue(step, oct){ return oct * 7 + STEPS.indexOf((step || "c").toLowerCase()); }
  function fromDiatonic(v){ var oct = Math.floor(v / 7); return { step: STEPS[v - oct * 7], oct: oct }; }
  var C5 = diatonicValue("c", 5);

  // How far (in whole note-lines) to shift EVERY note in the current file so this writer's normal
  // hits land on the middle C space. Recomputed per convert() from the file itself (0 for our own
  // catalog, whose normals are already on c/5). See computePosShift() + the comment in posOf().
  var POS_SHIFT = 0;

  // read the raw staff position off a note (before any shift), or null if it has none
  function rawPos(node){
    var u = node.querySelector("unpitched"), step = null, oct = null;
    if (u){ step = txt(u, "display-step"); oct = txt(u, "display-octave"); }
    else { var p = node.querySelector("pitch"); if (p){ step = txt(p, "step"); oct = txt(p, "octave"); } }
    if (step == null) return null;
    return { step: step.toLowerCase(), oct: parseInt(oct, 10) || 5 };
  }

  // staff position from <unpitched> (snare percussion) or <pitch> fallback, shifted so the piece's
  // normal hits sit on the middle C space.
  function posOf(node){
    var r = rawPos(node);
    if (!r) return { step: "c", oct: 5 };
    // RELATIVE NORMALIZATION (Anthony, 2026-07-24): we don't pin each notehead to a hard-coded line.
    // Instead we find where THIS writer put their normal hits (computePosShift) and slide the WHOLE
    // piece by that same amount so their normals land on c/5. Every other note — stick-clicks, rims,
    // whatever — keeps the exact spacing the writer drew RELATIVE to their normals, so we match our
    // engraving (normals on the C space, a stick-click a line up, a rim a space up) without overriding
    // how they chose to write it. For our own catalog POS_SHIFT is 0, so this is a pure no-op.
    if (POS_SHIFT){
      var v = diatonicValue(r.step, r.oct) + POS_SHIFT;
      return fromDiatonic(v);
    }
    return { step: r.step, oct: r.oct };
  }

  // Find the whole-line shift that moves this file's normal notes onto c/5. Reference = the MOST COMMON
  // staff position among plain (normal-head, non-rest, non-grace) notes, so a stray normal on an odd line
  // can't throw it off. No normal notes at all -> 0 (don't move anything).
  function computePosShift(part){
    var counts = {}, bestV = null, bestN = -1;
    [].slice.call(part.querySelectorAll("note")).forEach(function (node){
      if (node.querySelector("rest") || node.querySelector("grace")) return;
      if (headOf(node) !== "normal") return;
      var r = rawPos(node); if (!r) return;
      var v = diatonicValue(r.step, r.oct);
      counts[v] = (counts[v] || 0) + 1;
      if (counts[v] > bestN){ bestN = counts[v]; bestV = v; }
    });
    return bestV == null ? 0 : (C5 - bestV);
  }
  // notehead glyph exactly as the XML wrote it; missing => normal filled head (drum hit)
  function headOf(node){
    var nh = node.querySelector("notehead");
    if (!nh) return "normal";
    var t = nh.textContent.trim().toLowerCase();
    // Some editors write an X notehead via SMuFL — <notehead smufl="noteheadX...">other</notehead> — instead
    // of the plain MusicXML value. The SHAPE matters (Anthony's scheme, 2026-07-24): an ORNATE / "rooftop" X
    // (noteheadXOrnate*) is the RIMSHOT head -> map to "cross" (engine._hit voices head==="cross" as a rimshot,
    // regardless of line). A plain X (noteheadXBlack/Half/etc.) is rim (on a space) / stick-click (on the D
    // line) -> map to "x". Our own catalog uses the literal "cross"/"x" values, so this branch only fires on
    // such imports.
    if (t === "other"){
      var sm = (nh.getAttribute("smufl") || "").toLowerCase();
      if (/noteheadx/.test(sm)) return /ornate/.test(sm) ? "cross" : "x";   // ornate/rooftop X = rimshot; plain X = rim/stick-click
    }
    return t || "normal";
  }

  // beats (in quarters) -> a sensible VexFlow duration code, when <type> is missing
  function beatsToDur(b){
    if (b >= 4) return "w"; if (b >= 2) return "h"; if (b >= 1) return "q";
    if (b >= 0.5) return "8"; if (b >= 0.25) return "16"; if (b >= 0.125) return "32"; return "64";
  }

  function pickSnarePart(doc){
    var parts = [].slice.call(doc.querySelectorAll("score-partwise > part"));
    if (parts.length <= 1) return parts[0] || null;
    var sps = [].slice.call(doc.querySelectorAll("part-list > score-part"));
    var snareId = null;
    for (var i = 0; i < sps.length; i++){
      var nm = sps[i].querySelector("part-name");
      if (nm && /snare/i.test(nm.textContent)){ snareId = sps[i].getAttribute("id"); break; }
    }
    if (!snareId && sps[0]) snareId = sps[0].getAttribute("id");
    for (var j = 0; j < parts.length; j++){ if (parts[j].getAttribute("id") === snareId) return parts[j]; }
    return parts[0];
  }

  function convert(xml){
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("not valid MusicXML");
    var part = pickSnarePart(doc);
    if (!part) throw new Error("no snare part found");
    POS_SHIFT = computePosShift(part);   // slide this file so its normal hits land on c/5 (0 for our catalog)

    var tempo = null;
    // <sound tempo="X"> is ALWAYS quarter-notes/min per the MusicXML spec, independent of whatever visual
    // metronome mark is shown — so this path needs no conversion.
    var snd = doc.querySelector("sound[tempo]"); if (snd) tempo = parseFloat(snd.getAttribute("tempo"));
    if (!tempo){
      var pm = doc.querySelector("per-minute");
      if (pm){
        tempo = parseFloat(pm.textContent);
        // Unlike <sound tempo>, <per-minute> is qualified by whatever <beat-unit> sits in the SAME
        // <metronome> mark — e.g. beat-unit "quarter" + a dot means the mark reads "dotted quarter = X",
        // so X is DOTTED-QUARTER pulses/min, not quarter-notes/min. A dotted quarter = 1.5 quarter notes,
        // so "100" here means 150 quarter-notes/min, not 100 — without this the piece plays at 2/3 its
        // true written speed. Convert to real quarter-notes/min before using it anywhere else.
        var mm = pm.closest && pm.closest("metronome");
        var buEl = mm && mm.querySelector("beat-unit");
        var BU_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };
        var mult = buEl ? (BU_Q[buEl.textContent.trim()] || 1) : 1;
        if (mm && mm.querySelector("beat-unit-dot")) mult *= 1.5;
        tempo *= mult;
      }
    }
    tempo = Math.round(tempo || 120);

    var title = txt(doc, "work-title") || txt(doc, "movement-title") || "";

    var measureEls = [].slice.call(part.querySelectorAll("measure"));
    var divisions = 1, curTime = [4, 4], measures = [], curEnding = 0;
    // Running quarter-notes/min, tracked across the measure loop so a relational metric-modulation
    // mark (see below) can derive its own number from continuity with whatever tempo was in force —
    // that's literally what a modulation mark means, so there's nothing to author by hand.
    var BEATUNIT_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };
    function unitMult(u){ var m = BEATUNIT_Q[u.beatUnit] || 1; return u.dots ? m * 1.5 : m; }
    var runningQuarterBPM = tempo;
    // Group a <metronome>'s children in document order: a mark has ONE beat-unit (a plain "♩ = N")
    // or TWO (a relation "♩. = ♩", per the MusicXML schema — no <per-minute> alongside a relation).
    // Each beat-unit-dot belongs to whichever beat-unit precedes it.
    function metronomeUnits(metroEl){
      var out = [], cur = null, kids = metroEl.children;
      for (var i = 0; i < kids.length; i++){
        var tag = kids[i].tagName;
        if (tag === "beat-unit") { cur = { beatUnit: kids[i].textContent.trim(), dots: 0 }; out.push(cur); }
        else if (tag === "beat-unit-dot" && cur) cur.dots++;
      }
      return out;
    }
    // A crescendo/diminuendo that doesn't get its "stop" before a measure ends CONTINUES into the next
    // measure — real hairpins routinely cross barlines. Keyed by voice id, carries just the wedge TYPE
    // across measureEls iterations (indices below are always local to whichever measure is building).
    var carriedWedge = {};

    measureEls.forEach(function (mEl){
      var dv = mEl.querySelector("attributes > divisions");
      if (dv) divisions = parseInt(dv.textContent, 10) || divisions;

      var tEl = mEl.querySelector("attributes > time"), timeSig = null;
      if (tEl){ var b = parseInt(txt(tEl, "beats"), 10), bt = parseInt(txt(tEl, "beat-type"), 10);
        if (b && bt){ curTime = [b, bt]; timeSig = [b, bt]; } }

      var repeatStart = !!mEl.querySelector('barline repeat[direction="forward"]');
      var backRep = mEl.querySelector('barline repeat[direction="backward"]');
      var repeatEndTimes = backRep ? (parseInt(backRep.getAttribute("times"), 10) || 2) : 0;

      // voltas (1st/2nd endings): a span of measures tagged with the ending number.
      // <ending type="start"> opens it, type="stop"/"discontinue" closes it.
      var endStartEl = mEl.querySelector('barline ending[type="start"]');
      var endStopEl  = mEl.querySelector('barline ending[type="stop"], barline ending[type="discontinue"]');
      if (endStartEl) curEnding = parseInt(endStartEl.getAttribute("number"), 10) || 1;
      var endingNum = curEnding || 0, endingStart = !!endStartEl, endingStop = !!endStopEl;
      if (endStopEl) curEnding = 0;

      // ---- split this measure into VOICES. Sibelius writes a second voice after a <backup>
      // (which rewinds the time cursor), so two parts can occupy the SAME bar — e.g. a polyrhythm
      // with the snare line in voice 1 and rim clicks in voice 2. Bucket notes/directions by
      // <voice> and build each voice independently: voice 1 stays measure.events, the rest go to
      // measure.extraVoices. Single-voice bars (the vast majority) get an empty extraVoices, so the
      // <backup> elements that used to be ignored (and concatenated voice 2 onto the bar, doubling
      // its length) now correctly stack the voices instead.
      var voiceBuckets = {}, voiceOrder = [], curVoiceId = "1";
      [].slice.call(mEl.children).forEach(function (node){
        var tag = node.tagName;
        if (tag !== "note" && tag !== "direction") return;   // <backup>/<forward>/attributes/barline: not voice content
        var vid = txt(node, "voice") || curVoiceId; curVoiceId = vid;
        if (!voiceBuckets[vid]){ voiceBuckets[vid] = []; voiceOrder.push(vid); }
        voiceBuckets[vid].push(node);
      });
      voiceOrder.sort(function (a, b){ return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0); });   // voice 1 is always prime

      // pull sticking letters (R/L) out of a note's <lyric> children, in order
      function sticksOf(node){
        return [].slice.call(node.children)
          .filter(function (c){ return c.tagName === "lyric"; })
          .map(function (l){ var t = l.querySelector("text"); return t ? t.textContent.trim() : ""; })
          .filter(Boolean);
      }

      // build ONE voice's {events, beams, tuplets, wedges} from its ordered note/direction list.
      // openWedge seeds from carriedWedge[vid] when a hairpin is still open from the PREVIOUS measure
      // (its `from` restarts at 0 since indices are local to this measure). `continued:true` marks a
      // fragment that resumes a hairpin rather than starting a fresh one — the renderer uses this to draw
      // one unbroken hairpin across a barline (only a real staff-line break should visually restart it).
      function buildVoice(nodes, vid){
        var events = [], beams = [], tuplets = [], wedges = [];
        var openWedge = carriedWedge[vid] ? { type: carriedWedge[vid], from: 0, continued: true } : null;
        delete carriedWedge[vid];
        var pendingGraces = [], pendingGraceSticks = [], pendingDynamic = null, curBeam = null;
        var pendingWordSticks = [];   // single-letter R/L stickings written as <direction><words> before a note
        var openTups = {};   // nested tuplets, keyed by MusicXML "number" (level)

        nodes.forEach(function (node){
        // dynamics arrive as a <direction> before the note they belong to
        if (node.tagName === "direction"){
          var dyn = node.querySelector("direction-type dynamics");
          if (dyn && dyn.firstElementChild) pendingDynamic = dyn.firstElementChild.tagName;
          var wedge = node.querySelector("direction-type wedge");
          if (wedge){
            var wt = wedge.getAttribute("type");
            if (wt === "crescendo" || wt === "diminuendo") openWedge = { type: wt, from: events.length };
            else if (wt === "stop" && openWedge){ openWedge.to = events.length - 1; if (openWedge.to >= openWedge.from) wedges.push(openWedge); openWedge = null; }
          }
          // Stickings some editors write as a <direction><words>R</words> BEFORE the note (rather than in a
          // <lyric> like our catalog). Only a lone R/L letter counts — never tempo/rehearsal text — so this
          // can't misread anything else. Held until the next note. (Anthony, 2026-07-24)
          var swordEl = node.querySelector("direction-type words");
          if (swordEl){ var sw = swordEl.textContent.trim(); if (/^[RLrl]$/.test(sw)) pendingWordSticks.push(sw); }
          return;
        }
        if (node.tagName !== "note") return;

        var isGrace = !!node.querySelector("grace");
        var isChord = !!node.querySelector("chord");
        var restEl  = node.querySelector("rest");
        var isRest  = !!restEl;
        // A full-measure rest (<rest measure="yes"/>) is ALWAYS drawn as one whole rest centered in
        // the bar, regardless of time signature (universal notation convention). Sibelius often omits
        // <type> on these, so we'd otherwise fall back to beats->dur and get a stray half/quarter rest.
        var isMeasureRest = isRest && restEl.getAttribute("measure") === "yes";
        if (isGrace){ var gp = posOf(node);             // attach to the next note as a flam/drag
          // Carry the grace's OWN <type> and slash flag through, don't just keep its staff position.
          // Sibelius writes a flam grace as <type>eighth</type> with <grace slash="yes"/>, but a RUFF
          // (ratamacue / 2-grace drag) as TWO <type>16th</type> graces with real <beam> elements — and we
          // were throwing that away, so the renderer hardcoded an 8th and every ruff drew with one beam
          // instead of two. The beam elements themselves aren't needed: the renderer beams the group from
          // the durations (VexFlow works out the beam count), so `dur` is the only thing that has to survive.
          pendingGraces.push({ step: gp.step, oct: gp.oct, head: headOf(node),
                               dur: TYPE_TO_DUR[txt(node, "type")] || null,
                               slash: node.querySelector("grace").getAttribute("slash") === "yes" });
          pendingGraceSticks = pendingGraceSticks.concat(sticksOf(node));  // Sibelius writes the flam's sticking on the grace note
          return; }
        if (isChord){                                   // a 2nd (or more) notehead on the previous note — a double-stop
          var cp = posOf(node);
          var last = events[events.length - 1];
          if (last && last.heads) last.heads.push({ step: cp.step, oct: cp.oct, head: headOf(node) });
          return;
        }

        var durTicks = parseInt(txt(node, "duration"), 10) || 0;
        var beats = divisions ? durTicks / divisions : 0;
        var typeStr = txt(node, "type");
        var trem = node.querySelector("notations ornaments tremolo");
        // A buzz/press roll is an UNMEASURED tremolo (Sibelius "z" through the stem). A measured
        // tremolo (type="single", default when the attr is absent) is a diddle/roll = N slashes.
        var tremType = trem ? (trem.getAttribute("type") || "single") : null;
        var isBuzz = tremType === "unmeasured";

        var pos = posOf(node);
        var ev = {
          rest: isRest,
          measureRest: isMeasureRest,
          beats: beats,
          // measure rest -> whole rest glyph (no dots), centered later by the renderer; keep `beats`
          // accurate so audio silence stays the right length even when the glyph is a plain whole rest.
          dur: isMeasureRest ? "w" : (TYPE_TO_DUR[typeStr] || beatsToDur(beats)),
          dots: isMeasureRest ? 0 : node.querySelectorAll("dot").length,
          step: pos.step, oct: pos.oct,
          head: isRest ? "normal" : headOf(node),
          heads: isRest ? null : [{ step: pos.step, oct: pos.oct, head: headOf(node) }],   // all noteheads (double-stops append here)
          accent:   !!node.querySelector("notations articulations accent"),
          marcato:  !!node.querySelector("notations articulations strong-accent"),
          tenuto:   !!node.querySelector("notations articulations tenuto"),
          staccato: !!node.querySelector("notations articulations staccato"),
          roll: (trem && !isBuzz) ? (parseInt(trem.textContent, 10) || 1) : 0,
          buzz: isBuzz,
          flam: pendingGraces.length > 0 && !isRest,
          graces: (pendingGraces.length && !isRest) ? pendingGraces : null,
          stickAbove: null, stickBelow: null,
          dynamic: pendingDynamic
        };
        pendingGraces = []; pendingDynamic = null;

        // stickings: flam grace stickings come first (Sibelius writes them on the grace), then the note's own.
        // ALWAYS below the staff. A lyric written as a pair ("RL"/"LR" — a note hit by both hands) is split
        // into two letters; two stickings stack in TWO ROWS below (left letter on top, right letter beneath).
        // note's own sticking: from its <lyric> (how our catalog writes them) OR the pending single-letter
        // <direction><words> some editors emit before the note. Lyric wins when both exist; word-stickings
        // never apply to a rest. Clear the pending list at every note so a letter can't drift down the bar.
        var ownSticks = sticksOf(node);
        if (!ownSticks.length && !isRest && pendingWordSticks.length) ownSticks = pendingWordSticks.slice();
        pendingWordSticks = [];
        var rawSticks = pendingGraceSticks.concat(ownSticks);
        pendingGraceSticks = [];
        var sticks = [];
        rawSticks.forEach(function (s){
          // stickings ALWAYS render capitalized (Anthony, 2026-07-24) — a writer's lowercase r/l becomes R/L.
          var letters = String(s).replace(/[^RLrl]/g, "").toUpperCase();
          if (letters.length >= 2) { sticks.push(letters[0], letters[1]); }
          else if (letters) sticks.push(letters);
          else if (s) sticks.push(String(s).toUpperCase());
        });
        if (sticks.length) ev.stick1 = sticks[0];          // upper row (below the staff)
        if (sticks.length >= 2) ev.stick2 = sticks[1];     // lower row

        var ei = events.length;
        events.push(ev);

        // beams (level-1 begin/continue/end define the group)
        var beam1 = null;
        [].slice.call(node.querySelectorAll("beam")).forEach(function (bm){
          if (bm.getAttribute("number") === "1") beam1 = bm.textContent.trim();
        });
        if (beam1 === "begin") curBeam = [ei];
        else if (beam1 === "continue" && curBeam) curBeam.push(ei);
        else if (beam1 === "end" && curBeam){ curBeam.push(ei); beams.push(curBeam); curBeam = null; }

        // tuplets — support NESTING. MusicXML marks levels with the "number" attribute and only
        // tags the start/stop notes; in-between notes belong to every open level. A note can open
        // an inner tuplet while already inside an outer one (e.g. 9-lets inside a quarter triplet).
        var tupEls = node.querySelectorAll('notations tuplet');
        var tmod = node.querySelector("time-modification");
        // 1) opens — prefer the explicit display ratio (<tuplet-actual>/<tuplet-normal>), else time-modification
        for (var ti = 0; ti < tupEls.length; ti++){
          var te = tupEls[ti]; if (te.getAttribute("type") !== "start") continue;
          var lvl = te.getAttribute("number") || "1";
          var ta = te.querySelector("tuplet-actual tuplet-number");
          var tn = te.querySelector("tuplet-normal tuplet-number");
          openTups[lvl] = {
            idx: [],
            num: ta ? (parseInt(ta.textContent, 10) || 3) : (parseInt(txt(tmod, "actual-notes"), 10) || 3),
            inSpaceOf: tn ? (parseInt(tn.textContent, 10) || 2) : (parseInt(txt(tmod, "normal-notes"), 10) || 2),
            bracket: te.getAttribute("bracket") !== "no",
            show: true
          };
        }
        // 2) this note belongs to every currently-open tuplet level
        for (var lk in openTups) if (openTups.hasOwnProperty(lk)) openTups[lk].idx.push(ei);
        // 3) closes — outer levels (lower number) first so they draw under the inner ones
        for (var tj = 0; tj < tupEls.length; tj++){
          var ts = tupEls[tj]; if (ts.getAttribute("type") !== "stop") continue;
          var slvl = ts.getAttribute("number") || "1";
          if (openTups[slvl]){ tuplets.push(openTups[slvl]); delete openTups[slvl]; }
        }
      });

        if (curBeam && curBeam.length > 1) beams.push(curBeam);   // close stragglers
        for (var ok in openTups) if (openTups.hasOwnProperty(ok)) tuplets.push(openTups[ok]);
        if (openWedge){
          // no "stop" found in this measure: close a fragment at the bar's last note (as always), but —
          // unlike before — remember the wedge is STILL OPEN so the next measure's buildVoice() resumes
          // it from event 0 instead of the hairpin silently vanishing at the barline. If this is the
          // piece's last measure, nothing ever reads carriedWedge again, so it harmlessly falls away.
          openWedge.to = events.length - 1;
          if (openWedge.to >= openWedge.from) wedges.push(openWedge);
          carriedWedge[vid] = openWedge.type;
        }
        return { events: events, beams: beams, tuplets: tuplets, wedges: wedges };
      }

      var voiceResults = voiceOrder.map(function (vid){ return buildVoice(voiceBuckets[vid], vid); });
      var prime = voiceResults[0] || { events: [], beams: [], tuplets: [], wedges: [] };
      // A measure with no notes at all (e.g. an implied empty bar, or one whose only content was a
      // <forward> skip) would draw as a blank bar with nothing in it. Standard notation fills an empty
      // measure with a single centered whole rest, so synthesize one spanning the bar.
      if (!prime.events.length){
        var fbSig = timeSig || curTime;
        prime.events = [{
          rest: true, measureRest: true, beats: fbSig[0] * 4 / fbSig[1], dur: "w", dots: 0,
          step: "b", oct: 4, head: "normal", heads: null,
          accent: false, marcato: false, tenuto: false, staccato: false,
          roll: 0, buzz: false, flam: false, graces: null,
          stickAbove: null, stickBelow: null, dynamic: null
        }];
        prime.beams = []; prime.tuplets = []; prime.wedges = [];
      }
      // tempo (metronome) mark on this bar, if any — kept so the tool can show a dynamic "♩ = N"
      // marking on the sheet that scales with the slider (see DYNAMICS-SPEC / tempo-marks feature).
      var metroEl = mEl.querySelector("direction-type metronome");
      var tempoMark = null;
      if (metroEl){
        var units = metronomeUnits(metroEl), pmEl = metroEl.querySelector("per-minute");
        if (units.length >= 2){
          // Relational modulation mark ("♩. = ♩"): units[0] is the OLD pulse, units[1] the NEW one.
          // No number is written in the source — it's derived so the note-rate carries through unbroken.
          var newQuarterBPM = runningQuarterBPM / unitMult(units[0]) * unitMult(units[1]);
          tempoMark = { beatUnit: units[1].beatUnit, dots: units[1].dots, perMinute: Math.round(newQuarterBPM),
                        modFrom: { beatUnit: units[0].beatUnit, dots: units[0].dots } };
          runningQuarterBPM = newQuarterBPM;
        } else if (units.length === 1 && pmEl){
          var pmv = parseFloat(pmEl.textContent);
          if (pmv > 0) {
            tempoMark = { beatUnit: units[0].beatUnit, dots: units[0].dots, perMinute: pmv };
            runningQuarterBPM = unitMult(tempoMark) * pmv;
          }
        }
      }
      // gradual tempo change starting on this bar (accel. / rit. / rall. text) — the tempo RAMPS from
      // this bar's mark to the next mark instead of jumping. Captured for the playback tempo map (feat. B).
      var tempoRamp = null;
      var wordEls = mEl.querySelectorAll("direction-type words");
      for (var wi = 0; wi < wordEls.length; wi++){
        var wtxt = (wordEls[wi].textContent || "").toLowerCase();
        if (/accel/.test(wtxt)) { tempoRamp = "accel"; break; }
        if (/rit|rall|decel|allarg/.test(wtxt)) { tempoRamp = "rit"; break; }
      }
      measures.push({ timeSig: timeSig, repeatStart: repeatStart, repeatEndTimes: repeatEndTimes,
                      ending: endingNum, endingStart: endingStart, endingStop: endingStop, tempoMark: tempoMark, tempoRamp: tempoRamp,
                      events: prime.events, beams: prime.beams, tuplets: prime.tuplets, wedges: prime.wedges,
                      extraVoices: voiceResults.slice(1) });
    });

    if (measures.length && !measures[0].timeSig) measures[0].timeSig = curTime;
    measures = splitOverfullMeasures(measures);
    return { title: title, tempo: tempo, measures: measures };
  }

  /* Sibelius/VDL sometimes fuses several bars into one <measure> with no interior barline
     (e.g. "Snitchel Burger" m.41 = ~4.25 bars of nonuplets crammed into one 4/4 bar). The
     renderer can't wrap a single measure across systems, so it piles every note onto one
     line and the beams/tuplet-brackets/accents collide. Split any measure whose content
     runs longer than its time signature into multiple properly-sized bars, cutting ONLY at
     safe boundaries (never inside a beam or tuplet group). Operates on the shared format, so
     the renderer, player, and importer all benefit. (rdm-vexflow's drawInnerBarlines is now
     redundant for these bars but stays harmless.) */
  function sigEq(a, b){ return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }

  // Derive a time signature from a bar length (in quarter-note beats), preferring the parent
  // denominator: 3 quarters over den 4 -> [3,4]; 3.5 quarters over den 8 -> [7,8]. If the length
  // doesn't land on a whole numerator at that denominator, refine to the next power-of-two
  // denominator until it does (so an odd fractional sub-bar still gets an honest meter).
  function meterFromBeats(beats, den){
    var d = den || 4;
    for (var guard = 0; guard < 5; guard++){
      var num = beats * d / 4;
      if (Math.abs(num - Math.round(num)) < 1e-6) return [Math.round(num), d];
      d *= 2;
    }
    return [Math.max(1, Math.round(beats * (den || 4) / 4)), den || 4];   // best effort
  }

  function splitOverfullMeasures(measures){
    // shownSig = the meter currently PRINTED on the page. It diverges from the logical meter
    // (curSig) once we split a fused bar into irregular sub-bars: a 17-beat 4/4 export becomes
    // 3/4 + 4/4 + 4/4 + 4/4 + 2/4, and each length change must restate the meter (standard mixed-
    // meter notation), then the next real bar restates the prevailing meter when it returns.
    var TOL = 0.02, out = [], curSig = null, shownSig = null;
    for (var mi = 0; mi < measures.length; mi++){
      var m = measures[mi];
      if (m.timeSig) curSig = m.timeSig;
      var sig = curSig || [4, 4];
      var barBeats = sig[0] * 4 / sig[1];
      var evs = m.events || [];
      var total = 0, i; for (i = 0; i < evs.length; i++) total += (evs[i].beats || 0);

      // leave alone: normal bars, trivially short bars, and polyrhythm bars (extra voices).
      // Only split when the content holds at least TWO bars' worth — a bar that's merely
      // somewhat overfull (e.g. a 4-beat release bar while the sig still reads 7/8) is a
      // time-signature change the export dropped, not a fused bar; splitting it would
      // strand a sub-bar fragment (the phantom extra measure at the end of 7/8 exercises).
      // TODO: split multi-voice overfull bars too (none of the known joined bars have them).
      if (evs.length < 2 || total < barBeats * 2 - TOL || (m.extraVoices && m.extraVoices.length)){
        // Returning to a normal bar after split sub-bars left the page in a different meter:
        // restate this bar's meter so it isn't read as still being in the last sub-bar's meter.
        if (m.timeSig) shownSig = m.timeSig;
        else if (shownSig && !sigEq(shownSig, sig)){ m.timeSig = sig.slice(); shownSig = sig; }
        out.push(m); continue;
      }

      // prefix sums of beats for O(1) span totals
      var cum = [0]; for (i = 0; i < evs.length; i++) cum[i + 1] = cum[i] + (evs[i].beats || 0);

      // OVER-THE-BARLINE: if a TUPLET spans an internal bar boundary and the fused bar is a clean
      // integer multiple of barBeats, this is deliberate cross-barline notation (a tuplet written
      // through the barline — e.g. a 7:6 straddling beat 4 of a 4/4). Keep the bar JOINED so the
      // renderer's drawInnerBarlines draws the barline THROUGH the tuplet, preserving the engraved
      // look, instead of re-metering it into irregular sub-bars (7/8 + 7/8 + 1/4 …). Only tuplets
      // trigger this — beams normally break at the barline, so a beam-only span still splits.
      var kBars = total / barBeats, crossesBar = false;
      if (Math.abs(kBars - Math.round(kBars)) <= TOL && Math.round(kBars) >= 2 && (m.tuplets || []).length){
        for (var jb = 1; jb < Math.round(kBars) && !crossesBar; jb++){
          var Bx = jb * barBeats;
          (m.tuplets || []).forEach(function (t){
            var lo = Math.min.apply(null, t.idx), hi = Math.max.apply(null, t.idx);
            if (cum[lo] < Bx - TOL && Bx < cum[hi + 1] - TOL) crossesBar = true;   // boundary strictly inside the tuplet
          });
        }
      }
      if (crossesBar){
        if (m.timeSig) shownSig = m.timeSig;
        else if (shownSig && !sigEq(shownSig, sig)){ m.timeSig = sig.slice(); shownSig = sig; }
        out.push(m); continue;                                // joined → drawInnerBarlines draws through it
      }

      // a cut "before index k" is illegal if a beam or tuplet group straddles it
      var legal = []; for (i = 0; i <= evs.length; i++) legal[i] = true;
      function forbid(list){
        if (!list || list.length < 2) return;
        var lo = Math.min.apply(null, list), hi = Math.max.apply(null, list);
        for (var k = lo + 1; k <= hi; k++) legal[k] = false;   // boundaries strictly inside the group
      }
      (m.beams || []).forEach(forbid);
      (m.tuplets || []).forEach(function (t){ forbid(t.idx); });

      // greedily pack chunks toward barBeats, always ending on a legal boundary (cum computed above)
      var cuts = [0], start = 0;
      while (start < evs.length){
        var best = -1, e;
        for (e = start + 1; e <= evs.length; e++){
          if (cum[e] - cum[start] > barBeats + TOL) break;     // cum is monotonic: no later cut fits
          if (legal[e]) best = e;
        }
        if (best === -1){                                       // one group alone exceeds a bar: overflow it
          for (e = start + 1; e <= evs.length; e++){ if (legal[e]){ best = e; break; } }
          if (best === -1) best = evs.length;
        }
        cuts.push(best); start = best;
      }

      // emit one measure per [cuts[j], cuts[j+1]); groups never straddle a cut, so remapping is clean
      var nChunks = cuts.length - 1;
      for (var j = 0; j < nChunks; j++){
        var s = cuts[j], e2 = cuts[j + 1], isFirst = (j === 0), isLast = (j === nChunks - 1);
        // Each sub-bar carries the meter its own length implies (e.g. a 3-quarter chunk = 3/4);
        // print it only when it differs from what's already on the page, so a run of same-length
        // sub-bars states the meter once. This is what makes a 3-beat sub-bar read as 3/4 and the
        // next 4-beat sub-bar restate 4/4, instead of every irregular bar showing no signature.
        var chunkSig = meterFromBeats(cum[e2] - cum[s], sig[1]);
        var chunkTs = null;
        if (!shownSig || !sigEq(shownSig, chunkSig)){ chunkTs = chunkSig; shownSig = chunkSig; }
        out.push({
          timeSig:        chunkTs,
          repeatStart:    isFirst ? m.repeatStart : false,
          repeatEndTimes: isLast  ? m.repeatEndTimes : 0,
          ending:         m.ending,                            // whole span shares the volta number
          endingStart:    isFirst ? m.endingStart : false,
          endingStop:     isLast  ? m.endingStop : false,
          events:         evs.slice(s, e2),
          beams:          remapGroups(m.beams, s, e2),
          tuplets:        remapTuplets(m.tuplets, s, e2),
          wedges:         remapWedges(m.wedges, s, e2),
          extraVoices:    []
        });
      }
    }
    return out;
  }

  // keep beam groups fully inside [s,e), reindex to local, drop any left shorter than 2
  function remapGroups(groups, s, e){
    var out = [];
    (groups || []).forEach(function (g){
      var local = g.filter(function (i){ return i >= s && i < e; }).map(function (i){ return i - s; });
      if (local.length >= 2) out.push(local);
    });
    return out;
  }
  function remapTuplets(tups, s, e){
    var out = [];
    (tups || []).forEach(function (t){
      var idx = (t.idx || []).filter(function (i){ return i >= s && i < e; }).map(function (i){ return i - s; });
      if (idx.length) out.push({ idx: idx, num: t.num, inSpaceOf: t.inSpaceOf, bracket: t.bracket, show: t.show });
    });
    return out;
  }
  function remapWedges(wedges, s, e){
    var out = [];
    (wedges || []).forEach(function (w){
      var from = Math.max(w.from, s), to = Math.min(w.to, e - 1);
      if (to >= from) out.push({ type: w.type, from: from - s, to: to - s });
    });
    return out;
  }

  /* expand repeats (and 1st/2nd endings) into the played measure order
     (for audio + playhead). Returns an array of source-measure indices.
     pass = which repetition of the current repeat we're on, so a measure
     under volta N is played only on pass N (1st ending on pass 1, 2nd on
     pass 2, ...) and skipped — along with its barline/repeat — otherwise. */
  function rdmOrder(rdm){
    var ms = rdm.measures, order = [], i = 0, repStart = 0, pass = 1, counts = {};
    while (i < ms.length){
      var m = ms[i];
      if (m.repeatStart) repStart = i;
      if (m.ending && m.ending !== pass){ i++; continue; }   // wrong-pass volta → skip the whole measure
      order.push(i);
      var times = m.repeatEndTimes;
      if (times > 0){
        counts[i] = counts[i] || 1;
        if (counts[i] < times){ counts[i]++; pass++; i = repStart; continue; }
        pass = 1;                                            // repeat done; reset for any later section
      }
      i++;
    }
    return order;
  }

  /* flat list of played events (audio), each tagged with its source measure + event index
     (so the playhead can look up the rendered note's x). beats = quarter-beats. */
  function rdmSequence(rdm){
    var order = rdmOrder(rdm), seq = [];
    order.forEach(function (mi){
      rdm.measures[mi].events.forEach(function (ev, ei){
        seq.push({ ev: ev, m: mi, e: ei, beats: ev.beats || 0 });
      });
    });
    return seq;
  }

  var api = { convert: convert, rdmOrder: rdmOrder, rdmSequence: rdmSequence };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RDMConvert = api;
})(typeof window !== "undefined" ? window : globalThis);
