/* ============================================================
   RDM format -> VexFlow notation  (rdm-vexflow.js)

   The "speakers' eyes": draws an RDM score with DIRECT VexFlow so we
   get perfectly EVEN note spacing (formatToStave) plus full control of
   drumline details OSMD couldn't do: diddle slashes centered on the
   stem, rooftop/shot + tenuto above, engraved dynamics below the
   stickings, tuplet numbers ALWAYS shown.

   render(rdm, hostEl, opts) -> { width, height, notes }
     notes[mi][ei] = { x, yTop, yBot }  // for the traveling playhead
   Needs Vex.Flow on the page (or `VF` injected for headless tests).
   ============================================================ */
(function (global) {
  "use strict";
  var VF = global.Vex ? global.Vex.Flow : (global.VexFlowLib || null);

  var ART = { accent:"a>", marcato:"a^", tenuto:"a-", staccato:"a." };  // VexFlow articulation codes
  var REST_KEY = "b/4";       // where most rests sit (centered on the middle line)
  var REST_KEY_WHOLE = "d/5"; // a whole rest hangs from the 4th (D) line, not the middle (B) line

  // MusicXML notehead -> VexFlow key suffix. "" = normal filled head (drum hit / rimshot).
  // No plus glyph exists, so cross maps to the X used for clicks in drumline notation.
  // "x" = rim (plain ✕). "cross" = SHOT (rimshot): the base "x" head is made invisible in makeNote()
  // and drawShotX() draws a hand-built ornate cross ("Cross (ornate)", thin-waist X flaring into rounded
  // lobes) on top — VexFlow's font has no noteheadXOrnate glyph. Base head kept for correct stem/spacing.
  var HEAD = { normal:"", x:"x", cross:"x", slashed:"sf", diamond:"d",
               circle:"x3", "circle-x":"x3", "circle-dot":"x3" };
  function keyOf(p){
    var suf = HEAD[p.head] != null ? HEAD[p.head] : "";
    return (p.step || "c") + "/" + (p.oct || 5) + (suf ? "/" + suf : "");
  }

  function durCode(ev){ return (ev.rest ? ev.dur + "r" : ev.dur); }

  function pitchVal(p){ var S = "CDEFGAB"; return (p.oct || 5) * 7 + S.indexOf((p.step || "C").toUpperCase()); }

  // (Re)build the beam over a multi-grace group (a drag/ruff). VF.Beam freezes the stem direction of its
  // notes at CONSTRUCTION time, so a group beamed while its stems point up would draw its beam on the wrong
  // side after the second-voice pass flips those stems down — hence this clears any existing beam first and
  // lets beamNotes() build a fresh one. Safe to call more than once on the same group.
  function beamGraces(gg){
    if (!gg || !gg.beamNotes) return;
    if (gg.beams && gg.beams.length) gg.beams.length = 0;
    try { gg.beamNotes(); } catch (e) {}
  }

  // build one VexFlow StaveNote from an RDM event (real staff position + notehead from the XML).
  // ev.heads holds every notehead (a double-stop has 2+) — keys must be ordered low->high for VexFlow.
  function makeNote(ev){
    var heads = (ev.heads && ev.heads.length) ? ev.heads.slice() : [{ step: ev.step, oct: ev.oct, head: ev.head }];
    heads.sort(function (a, b){ return pitchVal(a) - pitchVal(b); });
    var keys = ev.rest ? [ev.dur === "w" ? REST_KEY_WHOLE : REST_KEY] : heads.map(keyOf);
    var n = new VF.StaveNote({ clef:"percussion", keys:keys, duration:durCode(ev), auto_stem:false });
    /* The sorted head list, kept ON the note. The render loop has to draw an ornate ✕ over every cross
       head at that head's own Y, and getYs() is indexed by KEY order — which is this order, not the
       order the heads arrived in. Deriving it twice is how they drift apart. */
    n._rdmHeads = heads;
    if (!ev.rest){
      n.setStemDirection(VF.Stem.UP);
      // rimshot (cross) heads are drawn by hand (ornate X) in the render loop — hide VexFlow's base head
      // so only our overdraw shows, while keeping the head for stem attachment + horizontal spacing.
      heads.forEach(function (h, i){
        if (h.head === "cross" && n.setKeyStyle) n.setKeyStyle(i, { fillStyle:"rgba(0,0,0,0)", strokeStyle:"rgba(0,0,0,0)" });
      });
      // accents (>), marcato (^), tenuto (—) and staccato (.) are ALL drawn ourselves at a UNIFORM
      // height (drawAccentMark / drawTenutoMark / drawStaccatoMark, in the render loop) so they line up
      // regardless of each note's beam count. Native VexFlow articulations position from the note's TICK
      // CONTEXT (which excludes the note's x_shift), so the grace-clearance pass — which shifts notes AFTER
      // a flam to the right — left a native tenuto/staccato behind, drifting LEFT onto the previous note.
      // Drawing them ourselves at the note's REAL rendered x (headCenterX, same as accents) fixes that.
      // ev.tenuto / ev.staccato are still read below in the render loop.
      // stickings are drawn ourselves (below the staff, up to two rows) in drawSticking() — see render loop
      // flam/drag: small grace note(s) before the note, each at its own position + notehead.
      // Lone flam = a FLAGGED grace with a SLASH (the classic acciaccatura flam, Anthony wants the flag
      // kept). The flag used to crash into the beam of a beamed group; two things fix that: (1) graceWidth
      // 18 gives the grace real horizontal room so the flag clears the previous/main note, and (2) a
      // shortened grace stem (setStemLength ~24) drops the flag just below the beam instead of up against
      // it. A DRAG/RUFF (2+ graces) keeps the full stem + a REAL beam and is NOT slashed (ruff graces are
      // plain beamed notes). So: single flam → "8" + slash + short stem; ruff → "16" ×2, beamed (two beams),
      // full stem, no slash.
      //
      // Duration comes from the SOURCE when the file gave one (graces[i].dur, carried by musicxml-to-rdm).
      // Anthony's catalog writes a ratamacue's ruff as two 16ths, and hardcoding "8" here drew them with a
      // single beam — visibly the wrong rudiment. Fall back only when the file omitted <type>: 8th for a
      // lone flam, 16th for a multi-grace drag, which is how both are conventionally engraved.
      if (ev.flam){
        var glist = (ev.graces && ev.graces.length) ? ev.graces : [{ step:ev.step, oct:ev.oct, head:ev.head }];
        var single = glist.length === 1;
        var gns = glist.map(function (gr){
          var g = new VF.GraceNote({ clef:"percussion", keys:[keyOf(gr)],
                                     duration:(gr.dur || (single ? "8" : "16")), slash:single });
          g.setStemDirection(VF.Stem.UP);
          if (single){ try { g.setStemLength(24); } catch (e) {} }   // flag sits below the beam, not on it
          return g;
        });
        // GraceNoteGroup's 2nd argument is showSlur, NOT a beam flag — it was read as one, so every 2-grace
        // drag got a curved StaveTie drawn from the grace to its main note. That's the phantom "tie" Anthony
        // saw on the ratamacues; ruffs never take one. Always pass false here, and get the real beam from
        // beamNotes(), which builds an actual VF.Beam over the grace notes.
        var gg = new VF.GraceNoteGroup(gns, false);
        if (!single) beamGraces(gg);
        n.addModifier(gg, 0);
        n._rdmGrace = gg;       // keep a ref so render() can tighten the gap to the main note after formatting
      }
    }
    if (ev.dots) {
      for (var d=0; d<ev.dots; d++) VF.Dot.buildAndAttach([n], { all:true });
      // VexFlow renders a dot inside the SAME SVG <g> wrapper as its notehead, inheriting that group's
      // fill/stroke — so the transparent cross-notehead trick above (line 50) was also silently hiding the
      // dot on a dotted rimshot/shot note. Force every dot to solid black explicitly: a no-op for a normal
      // (non-hidden) notehead, which already renders black, but keeps the dot visible on a hidden one.
      if (n.getModifiers) n.getModifiers().forEach(function (mod){
        if (mod instanceof VF.Dot && mod.setStyle) mod.setStyle({ fillStyle:"#000", strokeStyle:"#000" });
      });
    }
    n._rdm = ev;
    return n;
  }

  // total horizontal space the flam/drag graces in a measure reserve. Counted separately
  // from the even note-spacing budget so flammed measures get extra room (never overflow)
  // while plain notes stay evenly spaced.
  function graceExtra(m, graceWidth){
    var n = 0;
    m.events.forEach(function (e){ if (e.flam) n += (e.graces && e.graces.length) ? e.graces.length : 1; });
    return n * graceWidth;
  }

  // greedily pack measures into systems (lines) that fit `maxWidth`,
  // giving every NOTE the same base width so spacing comes out even.
  function packSystems(measures, maxWidth, perNote, graceWidth){
    var systems = [], cur = [], curW = 0;
    for (var i=0; i<measures.length; i++){
      var m = measures[i];
      var overhead = 28 + (m.timeSig ? 26 : 0) + (m.repeatStart ? 14 : 0) + (m.repeatEndTimes ? 14 : 0) + (i===0 ? 30 : 0);
      var gx = graceExtra(m, graceWidth);
      var w = overhead + Math.max(1, m.events.length) * perNote + gx;
      if (cur.length && curW + w > maxWidth){ systems.push(cur); cur = []; curW = 0; }
      cur.push({ mi:i, m:m, minW:w, overhead:overhead, graceW:gx });
      curW += w;
    }
    if (cur.length) systems.push(cur);
    // Never orphan the final measure (usually the release: a last note + rests) on its own
    // line — pull one measure down from the previous system so the last line has company.
    if (systems.length >= 2){
      var last = systems[systems.length - 1], prev = systems[systems.length - 2];
      if (last.length === 1 && prev.length >= 2) last.unshift(prev.pop());
    }
    return systems;
  }

  // Y for a tuplet number/bracket. Sit as LOW as possible — just above the group's (flattened) beam,
  // and above the uniform accent line when the group has accents — then lift each outer/nested level
  // clear of the one inside it. Used for BOTH bracketless and bracketed tuplets. Stem.UP === 1.
  function tupletYPos(arr, hasAccent, depth){
    var STO = 10, UP = 1;
    var stave = arr[0].checkStave();
    var b = stave.getYForLine(0) - 12;             // floor: a little above the top staff line
    arr.forEach(function (nt){
      if (nt.hasStem && nt.hasStem() && nt.getStemDirection() === UP){
        var top = nt.getStemExtents().topY - STO;  // just above this note's beam
        if (top < b) b = top;
      }
    });
    if (hasAccent) b -= 13;                         // clear the uniform accent line above the beam
    b -= (depth || 0) * 22;                         // lift each nesting level clear of the inner one
    return b;
  }
  // split `built` measures (order kept) into exactly nLines contiguous lines, minimizing the sum of
  // squared deviations of each line's packW total from the average — i.e. every line carries a
  // near-equal share of the music, so justification stretches them all about the same amount and
  // the density reads even from line to line. Hard cap: a line's total never exceeds contentW.
  // O(n^2 * L) DP — trivial at real-score sizes (tens of measures, a handful of lines).
  function balanceSystems(built, nLines, contentW){
    var n = built.length;
    if (nLines <= 1 || n <= nLines){
      if (n <= nLines){ return built.map(function (b){ return [b]; }); }
      return [built.slice()];
    }
    var cum = [0], i, j, k;
    for (i = 0; i < n; i++) cum[i + 1] = cum[i] + built[i].packW;
    var avg = cum[n] / nLines;
    function lineCost(a, b2){                       // cost of a line holding built[a..b2)
      var w = cum[b2] - cum[a];
      if (w > contentW + 0.5) return Infinity;      // hard fit cap — overflow is never an option
      var d = w - avg; return d * d;
    }
    // dp[k][i] = best cost splitting the first i measures into k lines; prev[k][i] = the last break
    var dp = [], prev = [];
    for (k = 0; k <= nLines; k++){ dp.push(new Array(n + 1).fill(Infinity)); prev.push(new Array(n + 1).fill(-1)); }
    dp[0][0] = 0;
    for (k = 1; k <= nLines; k++){
      for (i = k; i <= n - (nLines - k); i++){
        for (j = k - 1; j < i; j++){
          if (dp[k - 1][j] === Infinity) continue;
          var c = dp[k - 1][j] + lineCost(j, i);
          if (c < dp[k][i]){ dp[k][i] = c; prev[k][i] = j; }
        }
      }
    }
    if (dp[nLines][n] === Infinity){                // shouldn't happen (greedy proved a fit) — fall back
      var out = [], curL = [], curWf = 0;
      built.forEach(function (b){
        if (curL.length && curWf + b.packW > contentW){ out.push(curL); curL = []; curWf = 0; }
        curL.push(b); curWf += b.packW;
      });
      if (curL.length) out.push(curL);
      return out;
    }
    var breaks = [n];
    for (k = nLines, i = n; k > 0; k--){ i = prev[k][i]; breaks.unshift(i); }
    var systems = [];
    for (k = 0; k < nLines; k++) systems.push(built.slice(breaks[k], breaks[k + 1]));
    return systems;
  }

  // a measure's accent line: a uniform Y just above the highest (flattened) beam, so every accent lines up
  function accentLineY(vfNotes){
    var STO = 9, UP = 1, b = null;
    vfNotes.forEach(function (nt){
      if (nt && nt.hasStem && nt.hasStem() && nt.getStemDirection() === UP){
        var top = nt.getStemExtents().topY - STO;
        if (b == null || top < b) b = top;
      }
    });
    return b;
  }
  // exact horizontal CENTER of a note's head — what accents, stickings, dynamics and the playhead
  // cursor must align to. getAbsoluteX() is the note's left/tick edge (≈half a head-width too far left),
  // so centering on it leaves everything sitting slightly left of the notehead.
  function headCenterX(note){
    try {
      if (note.getNoteHeadBeginX && note.getNoteHeadEndX){
        var b = note.getNoteHeadBeginX(), e = note.getNoteHeadEndX();
        if (isFinite(b) && isFinite(e) && e > b) return (b + e) / 2;
      }
    } catch (err) {}            // rests have no notehead bounds
    // Rest: center on the rest GLYPH (tick x + half its width) so the playhead cursor sits ON the rest
    // exactly like it sits on a notehead — instead of at the rest's left/tick edge (a half-glyph too far
    // left). Keeps the cursor's alignment consistent as it animates across rest measures.
    var x = note.getAbsoluteX();
    try { if (note.getGlyphWidth) { var gw = note.getGlyphWidth(); if (isFinite(gw) && gw > 0) return x + gw / 2; } } catch (e2) {}
    return x;
  }

  // measured text width (so labels center exactly); falls back to a bold-13px estimate when the
  // context can't measure (e.g. headless jsdom returns 0 from getBBox).
  function textWidth(ctx, t){
    try { var m = ctx.measureText && ctx.measureText(t); if (m && m.width > 0) return m.width; } catch (e) {}
    return (t || "").length * 7.6;
  }

  // draw an accent (>) or marcato (^) at a fixed (x,y), so all of them sit on one line
  function drawAccentMark(ctx, x, y, marcato){
    ctx.save();
    ctx.lineWidth = 1.7; ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (ctx.setLineWidth) ctx.setLineWidth(1.7);
    ctx.beginPath();
    if (marcato){ ctx.moveTo(x - 4, y); ctx.lineTo(x, y - 7); ctx.lineTo(x + 4, y); }   // ^ rooftop
    else { ctx.moveTo(x - 5, y - 4); ctx.lineTo(x + 5, y); ctx.lineTo(x - 5, y + 4); }   // > accent
    ctx.stroke(); ctx.restore();
  }

  // draw a tenuto (short horizontal dash, —) at a fixed (x,y), drawn ourselves at the note's REAL x
  // (same uniform accent line as drawAccentMark) so it tracks the note's x_shift and never drifts left
  // over the previous note the way a native VexFlow articulation did (it ignored x_shift).
  function drawTenutoMark(ctx, x, y){
    ctx.save();
    ctx.lineWidth = 1.9; ctx.lineCap = "round";
    if (ctx.setLineWidth) ctx.setLineWidth(1.9);
    ctx.beginPath();
    ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y);
    ctx.stroke(); ctx.restore();
  }

  // draw a staccato (dot, .) at a fixed (x,y), drawn ourselves at the note's REAL x — see drawTenutoMark.
  function drawStaccatoMark(ctx, x, y){
    ctx.save();
    if (ctx.attributes) ctx.attributes.fill = "#000";
    if (ctx.setFillStyle) ctx.setFillStyle("#000");
    ctx.beginPath();
    ctx.arc(x, y, 1.9, 0, Math.PI * 2);
    ctx.fill(); ctx.restore();
  }

  // SHOT (rimshot) notehead = Sibelius "Cross (ornate)": a thin-waisted X whose four arms flare (via a
  // concave curve) into rounded lobes at the corners, all sitting inside one staff space. Drawn by hand
  // (VexFlow's font lacks noteheadXOrnate) on top of the hidden base head, so stems/beams still attach.
  // (x,y) = notehead center; sp = staff line spacing (so the glyph scales with the stave).
  function drawShotX(ctx, x, y, sp){
    sp = sp || 10;
    x += 0.10 * sp;                                          // nudge the ornate head a hair right of the tick center
    var R = 0.635 * sp, wc = 0.0212 * sp, rTip = 0.203 * sp;  // arm length / thin center half-width / lobe radius (fills the space, touches the lines)
    var sqHalf = 0.152 * sp, sqDist = 0.466 * sp;             // upright corner squares: half-side, and distance in from the corner toward center
    var dirs = [[1,1],[1,-1],[-1,-1],[-1,1]], inv = Math.SQRT1_2;
    ctx.save();
    if (ctx.attributes) ctx.attributes.fill = "#000";
    if (ctx.setFillStyle) ctx.setFillStyle("#000");
    dirs.forEach(function (d){
      var ux = d[0] * inv, uy = d[1] * inv, px = -uy, py = ux, near = R - rTip * 0.55;
      function P(al, pe){ return [x + al*ux + pe*px, y + al*uy + pe*py]; }
      var P0=P(0,wc), P3=P(near,rTip), C1=P(near*0.5,wc), C2=P(near*0.92,rTip);
      var P0m=P(0,-wc), P3m=P(near,-rTip), C1m=P(near*0.5,-wc), C2m=P(near*0.92,-rTip);
      var cxo=x+R*ux, cyo=y+R*uy;
      var a1=Math.atan2(P3[1]-cyo, P3[0]-cxo), a2=Math.atan2(P3m[1]-cyo, P3m[0]-cxo);
      ctx.beginPath();
      ctx.moveTo(P0[0], P0[1]);
      ctx.bezierCurveTo(C1[0],C1[1], C2[0],C2[1], P3[0],P3[1]);
      ctx.arc(cxo, cyo, rTip, a1, a2, false);            // rounded outer lobe
      ctx.bezierCurveTo(C2m[0],C2m[1], C1m[0],C1m[1], P0m[0],P0m[1]);
      ctx.closePath();
      ctx.fill();
    });
    // upright squares (sides parallel to the staff lines), pulled in from each corner toward center
    dirs.forEach(function (d){
      var ux = d[0] * inv, uy = d[1] * inv;
      ctx.fillRect(x + sqDist*ux - sqHalf, y + sqDist*uy - sqHalf, sqHalf*2, sqHalf*2);
    });
    ctx.restore();
  }

  /* DYNAMICS OFF (a student's request via Anthony, 2026-08-07): print no p/f/mf and no hairpins.

     A module-level default rather than a required option, so a tool that never passes it still obeys the
     setting — and so a sheet drawn before the app gets round to telling us is the exception, not the rule.
     An explicit opts.noDynamics still wins, which is what the Settings audition and any test needs.

     Articulations are NOT dynamics: accents, marcato, tenuto and staccato are how a note is struck and
     keep printing. Same line the audio side draws (see _computeDynamics in engine.js). */
  var NO_DYN = false;

  function render(rdm, host, opts){
    opts = opts || {};
    if (host) host.innerHTML = "";
    var noDyn = (opts.noDynamics != null) ? !!opts.noDynamics : NO_DYN;
    var zoom = opts.zoom || 1;
    var pad = 12;
    var maxWidth = (opts.width || (host ? host.clientWidth : 0) || 1000);
    var perNote = opts.perNote || 16;   // target per-note width (density); lower = tighter, more bars/line (Sibelius-like)
    // Reserve real room per grace so a flam never collides with the previous note (Anthony, 2026-07-23:
    // "resizing of certain rhythms should be able to resize if that means getting the grace notes to look
    // right"). 16px ≈ a slashed grace head + its lead gap. graceExtra() feeds the SAME number into each
    // flammed measure's min width, so those bars widen (the "resize") instead of cramming the graces.
    // With the grace-clearance pass (render loop) guaranteeing separation, these VexFlow-formatter reserves
    // only need to be modest — keeping them small lets notes render larger (less double-reserving of width).
    var graceWidth   = (opts.graceWidth   != null ? opts.graceWidth   : 14);
    var graceTight   = (opts.graceTight   != null ? opts.graceTight   : 12);
    /* HOW FAR A NOTE'S INK REACHES PAST ITS HEAD CENTRE, beyond what a plain notehead already occupies.
       Augmentation dots are the case that matters: VexFlow draws them right of the head and reports them
       as metrics.modRightPx (measured: 0 plain, 6 one dot, 12 two dots). Everything in the spacing solver
       positions by head centre with constants measured on a plain head, so without this a dotted note
       silently claims 6-12px it was never given.
       Returns 0 for a plain note, so bars that contain no dots lay out exactly as they always have. */
    function _rightOverhang(n){
      if (!n) return 0;
      try {
        var mets = n.getMetrics && n.getMetrics();
        if (mets && typeof mets.modRightPx === "number") return mets.modRightPx || 0;
      } catch (e) {}
      // metrics unavailable (older VexFlow / a note not yet formatted): fall back to the event's own dots
      var ev = n._rdm;
      return (ev && ev.dots) ? ev.dots * 6 : 0;
    }
    /* Clearance every note's ink keeps from the bar line in front of it. The solver above aims for this;
       the clamp below enforces it, so "a dot never crosses the line" holds even if a later pass (grace
       clearance, a polyrhythm re-place, a future edit) moves a note right afterwards. */
    var INK_CLEAR = 5;
    var graceTighten = (opts.graceTighten != null ? opts.graceTighten : 2);    // FIXED grace→note gap (px). Small = tight hug, and IDENTICAL on every flam.
    // Grace spacing (Anthony, 2026-07-23, after several rounds): use a FIXED tiny gap between each grace
    // and its own note (graceTighten) so every flam hugs identically — VexFlow's NATIVE spacing varied by
    // beam position (downbeat notes hugged tight, upbeat notes sat looser), which read as inconsistent.
    // PLUS reserve graceWidth to the grace's LEFT (getWidth override above) so at tight mobile widths a
    // flam never lands on the previous note's augmentation dot / notehead. Fixed gap = consistent on ALL
    // device sizes; reserve = no overlaps. graceNatural (opt-in) reverts to raw VexFlow spacing.
    var graceNatural = (opts.graceNatural != null ? opts.graceNatural : false);  // false → fixed consistent gap
    var graceRaw     = !!opts.graceRaw;   // true → also skip the getWidth reservation (raw VexFlow widths; test only)
    var topY = 20;       // margin above the first system's accents/tuplet #s (kept tight)
    var LAST_LINE_H = 112;            // vertical extent of a single system (stave + stickings/dynamics below) — used
                                      // for the final line so the page doesn't reserve a whole empty lineH beneath it
    /* Measured: the first head lands ~12px PAST noteStartX (VexFlow's own initial shift), so the real
       leading gap is BAR_PAD_L + ~12. Keep the pad small and let the trailing side carry the balance —
       the v3 trailing target subtracts the whole measured lead so (trail + lead) ≈ one note gap. */
    var BAR_PAD_L = 6, BAR_PAD_R = 13;
    // unscaled width one counts/sticking label needs before it touches its neighbour ("ta", "&", "R"
    // at bold 13px, plus breathing room). Used as a per-event floor when sizing a bar — see minW.
    var LABEL_CHAR_W = 17, LABEL_GAP = 12;

    var measures = rdm.measures;
    // Line-to-line spacing, UNIFORM across the whole piece for even lines. Dynamics (p/f) + hairpins hang
    // well below the stickings; when the piece has any, every system needs extra room so a line's dynamics
    // never collide with the tuplet numbers / accents that sit above the next line. (A system with dynamics
    // is ~LAST_LINE_H+30 = 142px tall, so 150 left almost nothing for the next line's marks — hence 190.)
    // with dynamics off nothing hangs down there, so the piece gets the tighter line spacing back
    var pieceHasLowMark = !noDyn && measures.some(function (m){
      return (m.wedges && m.wedges.length) || (m.events && m.events.some(function (e){ return e.dynamic; }));
    });
    var lineH = pieceHasLowMark ? 190 : 150;
    // when a piece carries tempo marks (♩=N / accel.), reserve extra room above every system so the
    // overlay (drawn above the accent row) never clips the top margin or collides with the line above.
    if (measures.some(function (m){ return m.tempoMark; })) { topY += 44; lineH += 44; }
    var num0 = (measures[0] && measures[0].timeSig) || [4, 4];

    // effective time signature per measure (only the measure where it changes carries timeSig). Used to
    // detect "joined" bars (a single measure holding 2+ bars' worth) so we can draw the interior barline.
    var effSig = [], _sig = num0;
    measures.forEach(function (m){ if (m.timeSig) _sig = m.timeSig; effSig.push(_sig); });

    // ---- PASS 1: build each measure's notes/voice/beams and measure its TRUE minimum width.
    // preCalculateMinTotalWidth = the tightest VexFlow can pack the notes without overlap; we size
    // every measure at least that wide, so notes can NEVER spill past the bar line, at any width/zoom.
    var built = measures.map(function (m, mi){
      var overhead = 28 + (m.timeSig ? 26 : 0) + (m.repeatStart ? 14 : 0) + (m.repeatEndTimes ? 14 : 0) + (mi === 0 ? 30 : 0);
      var b = { m: m, mi: mi, overhead: overhead, voice: null, vfNotes: null, beams: null, extra: [], minContent: 0 };
      b.barNo = mi + 1;   // count-off is bar 1
      // widest voice in the bar (a polyrhythm's second voice can hold more notes than the first)
      b.noteCount = (m.extraVoices || []).reduce(function (a, v){ return Math.max(a, v.events.length); }, m.events.length) || 1;
      // build one VexFlow voice from an RDM event list. stemDown flips the second voice's stems
      // (and any grace stems) so a polyrhythm reads as voice 1 up / voice 2 down.
      /* NOT THE PLACE TO STOP TWO RHYTHM GROUPS SHARING A BEAM. (Anthony, 2026-08-07: "these 2 4lets
         conjoined.") A guard here — split any beam whose two sides share no tuplet entry — looked like
         the right choke point, since both tools' beams pass through it. It is not: 60 rudiments beam
         deliberately ACROSS a tuplet change (single stroke fours, hertas, paradiddles, pudadas...), the
         generator allows it on purpose via beamContinues, and the renderer cannot tell a deliberate
         crossing from a mistaken one. The guard re-engraved all 60. Anything done about conjoined beams
         has to be done upstream, where the intent is still known. */
      function buildVf(evList, beamSpec, stemDown){
        var vfNotes = evList.map(makeNote);
        if (stemDown) vfNotes.forEach(function (n){
          if (n._rdm && !n._rdm.rest){
            n.setStemDirection(VF.Stem.DOWN);
            if (n._rdmGrace && n._rdmGrace.grace_notes){
              n._rdmGrace.grace_notes.forEach(function (g){ g.setStemDirection(VF.Stem.DOWN); });
              // a drag/ruff's beam was built against the UP stems in makeNote() — rebuild it now that the
              // stems point down, or the beam would hang off the old (wrong) end of them.
              if (n._rdmGrace.grace_notes.length > 1) beamGraces(n._rdmGrace);
            }
          }
        });
        var num = (m.timeSig || num0);
        var voice = new VF.Voice({ num_beats: num[0], beat_value: num[1] }).setStrict(false).addTickables(vfNotes);
        // Build beams BEFORE measuring/formatting — VexFlow only suppresses a note's flag (and skips
        // reserving flag width) once the note is in a beam; beaming later leaves flag AND beam.
        var beams = (beamSpec || []).map(function (g){
          var arr = g.map(function (i){ return vfNotes[i]; }).filter(Boolean);
          return arr.length >= 2 ? new VF.Beam(arr) : null;
        }).filter(Boolean);
        // Reserve space to the LEFT of each grace (pushes the previous note away + feeds min-width) so a
        // flam never lands on the previous note. CONDITIONAL (Anthony, 2026-07-23): the BIG reserve is only
        // needed to clear the augmentation DOT of a preceding dotted note. Everywhere else a small reserve
        // is enough — using the big one everywhere just bloated flam-heavy tuplets (9-lets, 8:6) and forced
        // them to shrink tiny. So: preceding note dotted → graceWidth (dot clearance); else graceTight (hug,
        // no bloat → dense tuplets render bigger + cleaner). Does NOT move the grace vs its own note.
        if (!graceRaw) vfNotes.forEach(function (n, i){
          if (n._rdmGrace){
            var prev = evList[i - 1];
            var w = (prev && prev.dots) ? graceWidth : graceTight;
            n._rdmGrace.getWidth = function (){ return w * this.grace_notes.length; };
          }
        });
        return { vfNotes: vfNotes, voice: voice, beams: beams };
      }
      if (m.events.length){
        var prime = buildVf(m.events, m.beams, false);
        b.vfNotes = prime.vfNotes; b.voice = prime.voice; b.beams = prime.beams;
        b.extra = (m.extraVoices || []).map(function (xv){
          if (!xv.events.length) return null;
          var built = buildVf(xv.events, xv.beams, true);
          built.events = xv.events; built.tuplets = xv.tuplets || [];
          return built;
        }).filter(Boolean);
        // size the bar so ALL voices fit without overlap
        var allV = [b.voice].concat(b.extra.map(function (e){ return e.voice; }));
        var minContent;
        try { minContent = new VF.Formatter().joinVoices(allV).preCalculateMinTotalWidth(allV); }
        catch (e) { minContent = Math.max(1, b.noteCount) * 14; }
        b.minContent = minContent;
      }
      /* true minimum drawn width; +14 absorbs the bar-line padding with a safety margin.
         The counts / sticking rows also need room, and preCalculateMinTotalWidth only measures NOTES.
         A label ("ta", "R") is a fixed unscaled width, so as the zoom drops the usable width grows,
         more measures pack onto each line, each one gets fewer unscaled px — and the text collides
         even though the noteheads still fit. That is why a dense bar came out garbled at the Lab's
         default 0.8 baseline but looked fine at 100%. Reserve per-event label room so the packer sizes
         the bar for what is actually drawn. (Anthony, 2026-07-21 — "wtf happened to this measure") */
      var labelMin = 0;
      if (!opts.bare && b.m && b.m.events){
        // width from the ACTUAL label strings — "ta" needs more room than "R", and a bar of 32nds is
        // mostly two-character counts. Flat per-event guesses were either wasteful or still collided.
        var lw = 0;
        b.m.events.forEach(function (e){
          var c = Math.max((e.stick1 || "").length, (e.stick2 || "").length);
          if (c) lw += c * LABEL_CHAR_W + LABEL_GAP;
        });
        if (lw) labelMin = overhead + lw + 14;
      }
      // Reserve a fixed slot per flam so the grace-clearance pass (render loop) has room to push notes
      // apart without over-compressing the rest. GRACE_SLOT must match the render-loop constant.
      var GRACE_SLOT = 16;
      b.minW = Math.max(overhead + b.minContent + 14 + graceExtra(m, GRACE_SLOT), labelMin);
      // desired width at the target density, but never below the real minimum (prevents overflow)
      b.packW = Math.max(overhead + Math.max(1, b.noteCount) * perNote, b.minW);
      return b;
    });

    // Auto fit-to-width: if the widest single measure can't fit the page at the chosen size, shrink
    // the WHOLE render (smaller notes) just enough that it does. Guarantees no measure ever spills
    // past the page edge. Only kicks in at the default/zoomed-out size; zooming IN is allowed to scroll.
    var maxMinW = built.reduce(function (a, b){ return Math.max(a, b.minW); }, 0);
    var fitZoom = maxWidth / (maxMinW + pad * 2);
    // Floor lowered 0.4 -> 0.28 (Anthony, 2026-07-23): an extremely dense bar (e.g. 5-let + 3 + 8:6 + 7:6
    // in one 4/4 measure) needs to shrink below 0.4 to fit a phone; the old floor stopped shrinking there
    // and let the bar CLIP past the page edge. 0.28 is still legible and lets those rare monster bars fit.
    var effZoom = (zoom <= 1) ? Math.max(0.28, Math.min(zoom, fitZoom)) : zoom;
    var contentW = maxWidth / effZoom - pad * 2;

    // ---- PASS 2: pack measures into lines so a line never needs more than the page width.
    // Greedy first-fit decides the LINE COUNT; then a DP re-balances the breaks so every line
    // carries a near-equal share of width (min sum of squared deviations from the average).
    // Greedy alone crams the early lines full and strands the leftovers on a sparse final line
    // that justification then over-stretches. The DP keeps greedy's line count (never taller)
    // and the hard fit cap (a line's packW sum <= contentW), so nothing can overflow.
    var nLines = 1, curW = 0, curLen = 0;
    built.forEach(function (b){
      if (curLen && curW + b.packW > contentW){ nLines++; curW = 0; curLen = 0; }
      curW += b.packW; curLen++;
    });
    var systems = balanceSystems(built, nLines, contentW);

    var renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
    // dynamics/hairpins hang below the stickings, so the final line needs more room only when it
    // actually carries one — otherwise the tighter stickings-only extent keeps the bottom margin small.
    // The reserve must clear the 22px dynamic glyph (baseline at getYForLine(4)+48, plus its descender),
    // not just its baseline — hence 30, not the old 18 (which pre-dated the enlarged dynamics and clipped
    // the bottoms of tall letters like p / f). Middle lines are fine: the next system's spacing absorbs it.
    var lastSystem = systems[systems.length - 1] || [];
    var lastHasLowMark = !noDyn && lastSystem.some(function (b){
      return (b.m.wedges && b.m.wedges.length) ||
             (b.m.events && b.m.events.some(function (e){ return e.dynamic; }));
    });
    var lastLineH = LAST_LINE_H + (lastHasLowMark ? 30 : 0);
    var height = topY + (systems.length - 1) * lineH + lastLineH + 6;   // +6 = small bottom margin so nothing sits flush against the clipping edge
    renderer.resize(maxWidth, height * effZoom);
    var ctx = renderer.getContext();
    if (effZoom !== 1) ctx.scale(effZoom, effZoom);
    // getBBox reads the SVG in viewBox units; this ratio converts that to the on-screen px used by
    // notes[].yTop / staves[].x, so per-measure topMark comes out in the same space the overlays live in.
    var svgRoot = host ? host.getElementsByTagName("svg")[0] : null;
    var vbW = (svgRoot && svgRoot.viewBox && svgRoot.viewBox.baseVal) ? svgRoot.viewBox.baseVal.width : 0;
    var vb2screen = 1;
    if (svgRoot && vbW > 0) { var scw = svgRoot.getBoundingClientRect().width; if (scw > 0) vb2screen = scw / vbW; }

    // Thicken the heavy bar of REPEAT + final barlines. VexFlow draws each heavy bar as a 3px-wide
    // tall fillRect; widen exactly those (only while a repeat/final measure's stave draws) so they
    // read bolder than the thin single barlines, matching engraved (Sibelius) barlines. Staff lines
    // (wide + ~1px tall) are untouched. HEAVY_BAR_W is the tuned heavy-bar thickness.
    var HEAVY_BAR_W = 5;
    var _fillRect = ctx.fillRect.bind(ctx);
    var thickenRepeat = false;
    ctx.fillRect = function (rx, ry, rw, rh) {
      if (thickenRepeat && rw === 3 && rh > 12) { rx -= (HEAVY_BAR_W - 3) / 2; rw = HEAVY_BAR_W; }
      return _fillRect(rx, ry, rw, rh);
    };

    var notes = {};                 // notes[mi][ei] = {x,yTop,yBot}
    var staves = {};                // staves[mi] = {x0,x1} — exact left/right bar-line x (for the loop highlight)

    // A hairpin that crosses a barline arrives here as consecutive per-measure fragments flagged
    // `continued` (see musicxml-to-rdm.js). Real engraving draws that as ONE unbroken shape across the
    // barline — a hairpin only visually restarts at an actual staff-line break. So instead of drawing
    // each fragment immediately, accumulate a run here and only draw when it stops continuing (a fresh
    // wedge, a type change, or — via the bi===0 check below — a real system/line break).
    var pendingWedge = null;
    function flushPendingWedge(){
      if (pendingWedge && pendingWedge.x2 - pendingWedge.x1 >= 6) drawWedge(ctx, pendingWedge.x1, pendingWedge.x2, pendingWedge.type, pendingWedge.stave);
      pendingWedge = null;
    }

    systems.forEach(function (sys, si){
      var y = topY + si * lineH;
      // justify the line to full width: give each measure its packW plus an event-weighted share of
      // the leftover. Final width is always >= packW >= minW, so notes always fit inside the bar lines.
      var sumPack = sys.reduce(function (a, b){ return a + b.packW; }, 0);
      var sumEvents = sys.reduce(function (a, b){ return a + Math.max(1, b.noteCount); }, 0);
      var slack = Math.max(0, contentW - sumPack);

      var x = pad;
      sys.forEach(function (b, bi){
        if (bi === 0) flushPendingWedge();   // a new staff line — never carry a hairpin run across it
        var m = b.m, mi = b.mi;
        var share = sumEvents > 0 ? (Math.max(1, b.noteCount) / sumEvents) : (1 / sys.length);
        var mw = b.packW + slack * share;

        var stave = new VF.Stave(x, y, mw);
        // snapshot the SVG element list so we can later identify JUST this measure's drawn glyphs and
        // measure their true top (tuplet #s / accents) — reliable even when systems pack tightly.
        var _svgAll = (svgRoot && svgRoot.getElementsByTagName) ? svgRoot.getElementsByTagName("*") : null;
        var _svgN0 = _svgAll ? _svgAll.length : -1;
        // exact bar-line x's for this measure (left = stave start, right = stave end), in final zoomed
        // pixels to match the note coords — the loop-highlight overlay uses these so its edges land on the
        // bar lines instead of half-way between the noteheads.
        staves[mi] = { x0: x * effZoom, x1: (x + mw) * effZoom };
        // OPT-IN (metronome subdivision icon): `bare` draws ONLY the rhythm — real VexFlow noteheads/stems/
        // beams/tuplets — with no clef, no time signature, no staff lines, and no barlines. Note Y positions
        // are unchanged (all 5 lines still exist for getYForLine; they're just made invisible), so the glyphs
        // look byte-for-byte like the sheet, minus the staff furniture. Playalongs never sets opts.bare.
        if (opts.bare){
          stave.setConfigForLines([{visible:false},{visible:false},{visible:false},{visible:false},{visible:false}]);
          stave.setBegBarType(VF.Barline.type.NONE);
          stave.setEndBarType(VF.Barline.type.NONE);
          // still draw the time signature in bare mode when the measure carries one — used by the metronome's
          // Time Signature icon (an events-less measure → just the real VexFlow N/D glyph, no clef/lines).
          if (m.timeSig) stave.addTimeSignature(m.timeSig[0] + "/" + m.timeSig[1]);
        } else {
          if (mi === 0) stave.addClef("percussion");
          if (m.timeSig) stave.addTimeSignature(m.timeSig[0] + "/" + m.timeSig[1]);
          if (m.repeatStart) stave.setBegBarType(VF.Barline.type.REPEAT_BEGIN);
          if (m.repeatEndTimes) stave.setEndBarType(VF.Barline.type.REPEAT_END);
          else if (mi === measures.length - 1) stave.setEndBarType(VF.Barline.type.END);   // final barline ending the piece
        }
        // volta (1st/2nd ending) bracket above the staff — raised to clear accents/tuplet numbers
        if (m.ending && VF.Volta){
          var vt = (m.endingStart && m.endingStop) ? VF.Volta.type.BEGIN_END
                 : m.endingStart ? VF.Volta.type.BEGIN
                 : m.endingStop  ? VF.Volta.type.END
                 : VF.Volta.type.MID;
          stave.setVoltaType(vt, m.endingStart ? (m.ending + ".") : "", -2);
        }
        // widen this stave's heavy bar: repeat bars, and the final light-heavy END barline
        var isFinalEnd = (mi === measures.length - 1) && !m.repeatEndTimes;
        thickenRepeat = !!(m.repeatStart || m.repeatEndTimes || isFinalEnd);
        stave.setContext(ctx).draw();
        thickenRepeat = false;

        // measure number at the start of each system (small grey, above the top staff line). Count-off
        // bars carry barNo === null and stay unnumbered; bar 1 is the first real measure. (Skipped in
        // bare mode — the subdivision icon is just the rhythm, no bar number.)
        if (bi === 0 && b.barNo != null && ctx.fillText && !opts.bare){
          if (ctx.save) ctx.save();
          if (ctx.setFont) ctx.setFont("Arial", 11, "italic");
          ctx.font = "italic 11px Arial";
          if (ctx.setFillStyle) ctx.setFillStyle("#8a8a8a");
          ctx.fillText(String(b.barNo), x + 1, stave.getYForLine(0) - 11);
          if (ctx.restore) ctx.restore();
        }

        if (b.voice){
          var vfNotes = b.vfNotes;
          // Let notes hug the bar lines (tight, even rhythm). VexFlow's default leaves a wide fixed gap.
          if (mi !== 0 && !m.timeSig && !m.repeatStart) stave.setNoteStartX(x + BAR_PAD_L);   // clef/timesig/repeat keep their room
          if (opts.bare) stave.setNoteStartX(x + BAR_PAD_L);   // no clef/timesig in bare mode → notes hug the left
          // the final END barline (light-heavy, thicker) needs extra clearance so the last note
          // doesn't crowd it; repeat-ends already reserve their own room.
          var isEndBar = (mi === measures.length - 1) && !m.repeatEndTimes;
          var rightGap = m.repeatEndTimes ? 18 : (isEndBar ? 22 : BAR_PAD_R);
          /* +defaultPadding cancels formatToStave's own subtraction; the extra 24 is a TRAILING
             RESERVE. Without it VexFlow gives a bar's last note only about half the room it leaves in
             front of it (measured 54px before vs 31px after), so a bar ending on a quarter after dense
             figures reads jammed against the line while the same quarter mid-bar looks fine. Holding
             the formatter back from the bar line lets it lay the whole bar out proportionally instead,
             which balances the last note without moving any note by hand — measured ratio 0.55 -> 0.98.
             (Anthony, 2026-07-21) */
          var TRAIL_RESERVE = 24;
          var noteEndX = x + mw - rightGap + VF.Stave.defaultPadding - TRAIL_RESERVE;
          stave.getNoteEndX = function (){ return noteEndX; };

          var fmtVoices = [b.voice].concat(b.extra.map(function (e){ return e.voice; }));
          new VF.Formatter().joinVoices(fmtVoices).formatToStave(fmtVoices, stave);

          // Spread a measure's notes so the LAST event reaches toward the bar line, instead of leaving a
          // full note-duration of empty trailing space (VexFlow's proportional formatter reserves the
          // last note's duration after it). Scale the note x's about the first note, so intermediate
          // notes stay tick-proportional (correct for mixed/consolidated rhythms too). setStave first so
          // getAbsoluteX() is truly ABSOLUTE (matches noteEndX) — otherwise it returns bar-relative ticks and
          // the math double-counts the stave offset. Beams / tuplets / accents / notes[] are all derived from
          // note positions AFTER this, so they follow.
          // DEFAULT ON for every tool since 2026-07-23 (Anthony: "fix the space at the end of measures…
          // I want nice even spacing" — measured gaps ran 26-89px within one piece, 45-150px in another).
          // Was opt-in (metronome only) while Playalongs had to stay byte-for-byte; pass
          // fillTrailing:false to get the old formatter behaviour back.
          if (opts.fillTrailing !== false && b.vfNotes && b.vfNotes.length > 1 && !(m.events.length === 1 && m.events[0].rest)){
            b.vfNotes.forEach(function (n){ n.setStave(stave); });
            var _f = b.vfNotes[0].getAbsoluteX();
            var _l = b.vfNotes[b.vfNotes.length - 1].getAbsoluteX();
            /* Leave a trailing gap proportional to the LAST NOTE'S OWN DURATION — that is what
               proportional engraving gives every other note, so it makes the bar read evenly.
               A fixed 30px jammed the last note against the bar line; the average note gap was better
               but still wrong in a mixed bar (a run of 16ths ending on an 8th dragged the average down
               and crowded that 8th). Measure px-per-beat from the notes already placed, then reserve
               the last note's share. Combined with the `_want > _cur` test below this can only ever
               CLOSE excess space, never tighten a bar VexFlow already spaced well.
               (Anthony, 2026-07-21) */
            var _beatsToLast = 0;
            for (var _q = 0; _q < b.vfNotes.length - 1; _q++){
              var _e = b.vfNotes[_q]._rdm; _beatsToLast += (_e && _e.beats) || 0;
            }
            var _perBeat = _beatsToLast > 0 ? (_l - _f) / _beatsToLast : 0;
            var _lastEv = b.vfNotes[b.vfNotes.length - 1]._rdm;
            /* endSpacing modes (window.__RDM_ENDMODE is a dev/test override):
                 'uniform' (default since 2026-07-23) — every bar's last event lands the SAME fixed
                            distance from its right bar line (TRAIL_RESERVE + right pad), scaling up or
                            down as needed. Anthony: "fix the space at the end of measures… I want nice
                            even spacing" — measured trailing gaps ran 26-89px within one piece.
                 'close'   — the 2026-07-21 behaviour: reserve the last event's proportional share and
                            only ever CLOSE excess space. */
            var _endMode = opts.endSpacing || (typeof window !== "undefined" && window.__RDM_ENDMODE) || "uniform";
            var _cur = _l - _f, _want, _go;
            if (_endMode === "uniform"){
              /* v2 (Anthony's screenshot, 2026-07-23): a FIXED end gap (v1's 20px) made the last note of
                 an 8th-note bar sit visibly closer to the bar line than to its own neighbours — notes
                 clustered around every barline. "Even" means the pulse keeps its stride across the line:
                 the gap between the last note and the bar line should read like ONE MORE of the bar's own
                 note gaps. So the target trailing gap = this bar's MEDIAN consecutive-note gap (median,
                 not mean — one long note in a bar of 16ths shouldn't drag it), clamped so dense bars
                 don't jam the line (min 24) and sparse bars don't leave a hole (max 52). The gap scales
                 with the layout, so solve iteratively (converges in 2 passes).
                 Empirical anchor: a last-note absolute-x of noteEndX-16 measures 20px head-center to
                 bar line; moving the target left by d adds d to the gap. */
              var _gaps = [];
              for (var _g2 = 1; _g2 < b.vfNotes.length; _g2++) _gaps.push(b.vfNotes[_g2].getAbsoluteX() - b.vfNotes[_g2 - 1].getAbsoluteX());
              _gaps.sort(function (a2, b2){ return a2 - b2; });
              var _med = _gaps.length ? _gaps[Math.floor(_gaps.length / 2)] : 24;
              /* v3 (Anthony, 2026-07-23): v2 set the TRAILING gap itself to one full note gap, but the
                 eye reads the WHOLE distance across the barline — trailing + the next bar's leading gap
                 (BAR_PAD_L + VexFlow's ~12px initial shift, measured 2026-07-23) — so consecutive notes
                 straddling a line sat a gap and a half apart and the music read "gapped". Target:
                 trailing = median gap MINUS the whole measured lead, i.e. (trail + lead) ≈ ONE gap and
                 the pulse strides through the line at its normal stride. Clamps keep dense bars off the
                 line (min 14 — dense music always reads slightly wider at a barline, unavoidable) and
                 sparse bars from drifting (max 40). */
              var _LEAD_EST = BAR_PAD_L + 12;
              /* max raised 40 -> 90 (Anthony, 2026-07-24): on a QUARTERS bar the median gap is ~120px, so
                 the old 40 cap left the junction (trailing+lead ≈ 58) far tighter than the ~120px within-bar
                 stride — the last quarter of a bar sat visibly closer to the first of the next than to its own
                 neighbours. 90 lets very-sparse bars keep their stride across the line. Dense bars stay at the
                 min 14; 8th-ish bars land on their own proportional gap (a touch more even than the old cap),
                 which is the goal. The `_want > _cur` / iterative solve still keep it from ever crushing a bar. */
              var _tOf = function (m2){ return Math.max(14, Math.min(90, m2 - _LEAD_EST)); };
              /* THE DOT IS PHYSICAL (Anthony, 2026-08-07: "just make the dot physical... it's gotta sit
                 in the measure correctly, so yes include the dots").

                 Every number in this solver places a note by its HEAD CENTRE, and the empirical
                 constants (-16 / +20) were measured on a plain notehead. An augmentation dot is drawn to
                 the RIGHT of the head and was invisible to all of it: VexFlow reports it as modRightPx,
                 6px for one dot and 12px for two. With the trailing gap at its 14px floor that left a
                 dotted note about 2px from the bar line — the margin Anthony saw give out.

                 Subtracting it here moves the target left by exactly the note's own overhang, so the
                 GAP RULE now applies to the ink instead of to the head. Plain notes report 0 and are
                 untouched, which matters: this spacing was tuned by eye over several passes. */
              var _lastN = b.vfNotes[b.vfNotes.length - 1];
              var _over = _rightOverhang(_lastN);
              var _T = _tOf(_med), _sc2 = 1;
              for (var _it = 0; _it < 2; _it++){
                var _target = (noteEndX - 16) - (_T - 20) - _over;
                _want = _target - _f;
                _sc2 = _cur > 4 ? _want / _cur : 1;
                _T = _tOf(_med * _sc2);
              }
              _want = ((noteEndX - 16) - (_T - 20) - _over) - _f;
              _go = _cur > 4 && Math.abs(_want - _cur) > 1;
            } else {
              // same reservation in 'close' mode — see _rightOverhang and the uniform branch above
              _want = (noteEndX - _rightOverhang(b.vfNotes[b.vfNotes.length - 1])
                       - Math.max(24, ((_lastEv && _lastEv.beats) || 0) * _perBeat)) - _f;
              _go = _cur > 4 && _want > _cur;
            }
            if (_go){
              var _sc = _want / _cur;
              b.vfNotes.forEach(function (n){ var ax = n.getAbsoluteX(); n.setXShift(n.getXShift() + (_f + (ax - _f) * _sc - ax)); });
            }
          }


          // A bar that's just a single rest (whole-measure rest, or any meter's lone rest): center it
          // in the measure (standard notation) instead of leaving it jammed against the left bar line
          // where the formatter places the single tick.
          if (m.events.length === 1 && m.events[0].rest){
            var wr = vfNotes[0];
            // getAbsoluteX() only returns a true ABSOLUTE x once the note knows its stave; the voice
            // doesn't assign it until draw(), which runs AFTER this. Without the stave it returns the
            // bar-relative tick x, so mixing it with the absolute getNoteStartX()/getNoteEndX() below
            // double-counts the stave offset and flings the rest off the right edge (bar looks empty).
            // Assign the stave up front so getAbsoluteX() is absolute and the centering is exact.
            wr.setStave(stave);
            var gw = wr.getGlyphWidth ? wr.getGlyphWidth() : 12;
            // Center on the MEASURE midpoint (halfway between the bar lines: x .. x+mw), NOT the
            // note-area midpoint — the note area is padded asymmetrically (left pad > right gap) so its
            // center sits a few px right of the true bar center. Guard so a leading clef/time/repeat
            // never overlaps the rest (then it sits just right of them instead).
            var barCenter = x + mw / 2;
            var minCenter = stave.getNoteStartX() + gw / 2;
            if (barCenter < minCenter) barCenter = minCenter;
            wr.setXShift(barCenter - wr.getAbsoluteX() - gw / 2);
          }

          // Polyrhythm bars: VexFlow spaces notes by DURATION, which stretches the longer-note voice
          // and throws the two parts out of alignment. Re-place every note by its ONSET TIME so the
          // bar reads as a true polyrhythm — e.g. a 3-over-4 shows the 3 evenly across the bar and the
          // 4 evenly across it, sharing beat 1. (Only runs on bars that actually carry a 2nd voice.)
          if (b.extra && b.extra.length){
            // getAbsoluteX() is in STAVE-RELATIVE space; getNoteStartX()/getNoteEndX() are ABSOLUTE
            // (they include the stave's x). Mixing them double-counts the stave offset and throws the
            // notes off-canvas — so anchor to the first note's own relative x (the formatter already put
            // the onset-0 note at the bar's left) and use only the note-area WIDTH (origin-independent).
            var x0 = vfNotes.length ? vfNotes[0].getAbsoluteX() : 0;
            // Reserve a right margin (≈ a notehead + pad) so the last onset never pushes its notehead
            // up against / past the bar line. Spread onsets across the REMAINING width only.
            var rightPad = 14;
            var pSpan = Math.max(10, (stave.getNoteEndX() - stave.getNoteStartX()) - rightPad);
            var totalB = m.events.reduce(function (a, e){ return a + (e.beats || 0); }, 0) || 1;
            var placeByOnset = function (notes, evs){
              var onset = 0;
              notes.forEach(function (n, i){
                var tx = x0 + (onset / totalB) * pSpan;
                n.setXShift(tx - n.getAbsoluteX());
                onset += (evs[i] && evs[i].beats) || 0;
              });
            };
            placeByOnset(vfNotes, m.events);
            b.extra.forEach(function (xb){ placeByOnset(xb.vfNotes, xb.events); });
          }

          // Position the grace glyph a FIXED distance left of the main notehead, so the "space behind the
          // primary note" is identical everywhere (Anthony, 2026-07-23) instead of whatever VexFlow's
          // formatter left over (which varied bar to bar). graceTighten IS that fixed gap now. The measure
          // is already widened by graceExtra() so this uniform gap never crushes the previous note.
          /* GRACE-CLEARANCE + CONSISTENT HUG (Anthony, 2026-07-23). Two VexFlow facts drive this:
             (1) its beam formatter spaces notes as if the graces weren't there, so a flam draws on top of
                 the previous note (Sibelius reserves grace room; VexFlow doesn't);
             (2) it positions each grace from the note's TICK CONTEXT, which does NOT include the note's
                 x_shift — so any note we move by x_shift leaves its grace behind, drifting by the shift
                 amount (which varies with size), i.e. the hug looks different at every zoom.
             Fix, deterministic (no reading hidden grace coords): COMPRESS the formatter's x-positions into
             (area − total grace room), push each note right by a fixed GRACE_SLOT per preceding flam
             (reserves each grace its own slot; bar still fills exactly, no overflow/scatter), THEN set each
             grace's spacing to (GRACE_HUG + the note's total x_shift) so the grace tracks its note and sits
             a FIXED gap behind it at every size. Skipped for polyrhythm bars + raw-width callers. */
          if (!graceRaw && !(b.extra && b.extra.length)){
            var nFlam = 0; vfNotes.forEach(function (n){ if (n._rdmGrace) nFlam++; });
            if (nFlam){
              vfNotes.forEach(function (n){ try { n.setStave(stave); } catch (e) {} });
              var GRACE_SLOT = 16;   // reserved horizontal slot per flam (clearance from the previous note)
              var GRACE_HUG = 3;     // fixed gap the grace sits behind its OWN note — identical at every size
              var gcStartX = stave.getNoteStartX();
              var gcArea = stave.getNoteEndX() - gcStartX;
              var gcTotal = nFlam * GRACE_SLOT;
              var gcScale = (gcArea > 0 && gcTotal < gcArea * 0.85) ? (gcArea - gcTotal) / gcArea : 1;
              var gcRun = 0;
              vfNotes.forEach(function (n){
                var ax; try { ax = n.getAbsoluteX(); } catch (e){ return; }
                var compressed = gcStartX + (ax - gcStartX) * gcScale;
                if (n._rdmGrace) gcRun += GRACE_SLOT;   // reserve this flam's slot before placing the note
                n.setXShift(n.getXShift() + (compressed + gcRun - ax));
                if (n._rdmGrace) n._rdmGrace.setSpacingFromNextModifier(GRACE_HUG + n.getXShift());   // track x_shift + fixed hug
              });
            }
          } else {
            vfNotes.forEach(function (n){
              if (n._rdmGrace && !graceNatural){ n._rdmGrace.setSpacingFromNextModifier(graceTighten); }
            });
          }

          /* LAST LINE OF DEFENCE: no note's ink may reach its bar line. Runs after EVERY pass that can
             move a note — the trailing solve, the single-rest centering, the polyrhythm re-place, grace
             clearance — because any of them can push the last note right, and it is the only note that
             can ever be near the line.

             The solver above already aims for this; the point of repeating it here is that "never" then
             does not depend on the solver being right, on the end-spacing mode, or on some future pass
             being careful. If ink would cross, the note is pulled back by exactly the overlap — and no
             further than half the gap to the note before it, so relieving a collision at the bar line can
             never create one inside the bar. (Anthony, 2026-08-07.) */
          if (vfNotes && vfNotes.length){
            var _barX = x + mw;                       // the bar line this measure ends on
            for (var _ci = vfNotes.length - 1; _ci >= 0; _ci--){
              var _n = vfNotes[_ci];
              var _gw = (_n.getGlyphWidth ? _n.getGlyphWidth() : 11.9);
              var _inkR = _n.getAbsoluteX() + _gw / 2 + _rightOverhang(_n);
              var _push = _inkR - (_barX - INK_CLEAR);
              if (_push <= 0.1) break;                // this note clears it, so everything left of it does
              var _prevX = _ci > 0 ? vfNotes[_ci - 1].getAbsoluteX() : null;
              var _room = _prevX == null ? _push : Math.max(0, (_n.getAbsoluteX() - _prevX) * 0.5);
              _n.setXShift(_n.getXShift() - Math.min(_push, _room));
            }
          }

          b.voice.draw(ctx, stave);
          drawInnerBarlines(ctx, stave, m, vfNotes, effSig[mi][0] * 4 / effSig[mi][1]);   // interior barline(s) for joined bars
          // Flat beams: drumline reads cleaner with level beams. Flatten each beam at the HIGHEST
          // stem tip in the group (smallest topY for up-stems), so no beam ever slants.
          b.beams.forEach(function (bm){
            var off = Math.min.apply(null, bm.notes.map(function (nt){ return nt.getStemExtents().topY; }));
            bm.render_options.flat_beams = true;
            bm.render_options.flat_beam_offset = off;
            bm.setContext(ctx).draw();
          });

          // tuplets — number ALWAYS shown, above. For NESTED tuplets, lift the outer (bracketed) one clear.
          var allTups = m.tuplets || [];
          var measTopMark = Infinity;   // highest ink above the staff (tuplet #s + accents) — anchors tempo marks
          function tupContains(a, c){ return a.idx[0] <= c.idx[0] && a.idx[a.idx.length - 1] >= c.idx[c.idx.length - 1] && a.idx.length > c.idx.length; }
          // nesting depth = how many tuplet levels sit INSIDE this one (longest chain). Each level is
          // lifted clear of the one below so neither the numbers NOR the brackets overlap.
          function tupDepth(t){
            var kids = allTups.filter(function (o){ return o !== t && tupContains(t, o); });
            return kids.length ? 1 + Math.max.apply(null, kids.map(tupDepth)) : 0;
          }
          allTups.forEach(function (t){ t._depth = tupDepth(t); });
          // bracketed tuplets that butt right up against another bracket need a little breathing room so
          // the brackets don't touch/overlap. Find index-adjacent bracketed siblings to pull those ends in.
          var brTups = allTups.filter(function (o){ return o.bracket && o.idx && o.idx.length; });
          function tFirst(o){ return o.idx[0]; }
          function tLast(o){ return o.idx[o.idx.length - 1]; }
          var BR_GAP = 4;   // px each touching bracket end is pulled inward
          allTups.forEach(function (t){
            var arr = t.idx.map(function (i){ return vfNotes[i]; }).filter(Boolean);
            if (arr.length < 1) return;
            // Show the full ratio (e.g. "5:3") when the tuplet sits in a NON-standard space.
            var stdNormal = Math.pow(2, Math.floor(Math.log2(t.num || 1)));
            var showRatio = (t.inSpaceOf || 2) !== stdNormal;
            // lift the tuplet number/bracket clear of the marks above the beam — accents, marcato, AND
            // tenutos — so the number never overlaps a tenuto dash (bracketed OR bracketless).
            var hasAccent = t.idx.some(function (i){ var e = m.events[i]; return e && (e.accent || e.marcato || e.tenuto); });
            var depth = t._depth;
            var tup = new VF.Tuplet(arr, {
              num_notes: t.num, notes_occupied: t.inSpaceOf, bracketed: !!t.bracket,
              ratioed: showRatio, location: VF.Tuplet.LOCATION_TOP, y_offset: 0
            });
            // place ALL tuplets (bracketed + bracketless) as low as possible above the rhythm
            tup.getYPosition = function (){ return tupletYPos(arr, hasAccent, depth); };
            measTopMark = Math.min(measTopMark, tupletYPos(arr, hasAccent, depth) - 12);   // number sits above the bracket y
            // VexFlow draws the bracket from first.getTieLeftX()-5 to last.getTieRightX()+5. When a
            // bracketed sibling sits immediately before/after, nudge only that touching end inward so
            // the two brackets get a small gap instead of colliding.
            if (t.bracket){
              var hasLeft  = brTups.some(function (o){ return o !== t && tLast(o) === tFirst(t) - 1; });
              var hasRight = brTups.some(function (o){ return o !== t && tFirst(o) === tLast(t) + 1; });
              var fn = arr[0], ln = arr[arr.length - 1], oL = fn.getTieLeftX, oR = ln.getTieRightX;
              if (hasLeft)  fn.getTieLeftX  = function (){ return oL.call(fn) + BR_GAP; };
              if (hasRight) ln.getTieRightX = function (){ return oR.call(ln) - BR_GAP; };
              tup.setContext(ctx).draw();
              fn.getTieLeftX = oL; ln.getTieRightX = oR;   // restore (no ties on snare, but keep it clean)
            } else {
              tup.setContext(ctx).draw();
            }
          });

          // uniform accent line for this measure (above the flattened beams)
          var accY = accentLineY(vfNotes);
          // Playhead-cursor vertical extent, anchored to THIS measure's real staff geometry: the column
          // top = the accent row (a hair above the accent/marcato marks), the bottom = the 1st sticking
          // row — so it covers the whole staff + accents + stickings and never drifts off the music.
          var cursorTop = (accY != null ? accY - 8 : stave.getYForLine(0) - 14);
          // bottom = below the sticking row (+26); when this bar ALSO carries a counts row (stick2, drawn
          // one row lower at +32 baseline), drop the cursor/selection to cover it too (+40 ≈ same 8px pad
          // below that row). Bars with no counts row stay tight at +26. Drives BOTH the playhead cursor
          // and the loop-selection highlight, so both wrap the counts when they're shown.
          var hasCountRow = m.events && m.events.some(function (e){ return e && e.stick2; });
          var cursorBot = stave.getYForLine(4) + (hasCountRow ? 40 : 26);
          if (accY != null) measTopMark = Math.min(measTopMark, accY);

          // record note coords; draw diddle slashes, stickings, accents + dynamics ourselves (full control)
          notes[mi] = {};
          vfNotes.forEach(function (n, ei){
            var ev = m.events[ei];
            var nx = headCenterX(n);                 // center of the notehead (not the tick/left edge)
            // coords in FINAL (zoomed) pixels so the external playhead canvas lines up.
            notes[mi][ei] = { x: nx * effZoom, yTop: y * effZoom, yBot: (y + 70) * effZoom,
                              cTop: cursorTop * effZoom, cBot: cursorBot * effZoom };
            if (!ev.rest && ev.roll) drawDiddle(ctx, n, ev.roll);
            if (!ev.rest && ev.buzz) drawBuzz(ctx, n);
            /* Ornate rimshot ✕ — one per CROSS HEAD, not one per note (Anthony, 2026-08-07: "measure 90
               of Genesis Part Two ... is missing a shot on the C space").

               A double stop is two noteheads on one note. makeNote hides VexFlow's own head for every
               cross head so our overdraw is the only thing seen — but this only ever tested ev.head, the
               FIRST head, and only ever drew at getYs()[0], the lowest. So in a double stop written as a
               normal note in one hand and a shot in the other (m66, m90), the shot's head was hidden and
               nothing was drawn in its place: the ✕ was not missing from the file, it was being erased on
               the way to the screen. */
            if (!ev.rest && n.getYs) {
              var _ys = n.getYs(), _hs = n._rdmHeads || [{ head: ev.head }];
              for (var _hi = 0; _hi < _hs.length; _hi++) {
                if (_hs[_hi].head !== "cross") continue;
                drawShotX(ctx, nx, _ys[_hi] != null ? _ys[_hi] : _ys[0], stave.getSpacingBetweenLines());
              }
            }
            if (!ev.rest) drawSticking(ctx, n, stave, ev);
            if (!ev.rest && (ev.accent || ev.marcato) && accY != null) drawAccentMark(ctx, nx, accY, ev.marcato && !ev.accent);
            // tenuto/staccato drawn ourselves at the note's REAL x (nx) + uniform accent height, so they
            // track the note's x_shift (grace-clearance pass) instead of drifting left like the old native
            // articulations. If the note ALSO has an accent/marcato, lift the mark clear of that glyph.
            if (!ev.rest && (ev.tenuto || ev.staccato) && accY != null){
              var artY = accY - ((ev.accent || ev.marcato) ? 9 : 0);
              if (ev.tenuto) drawTenutoMark(ctx, nx, artY);
              if (ev.staccato) drawStaccatoMark(ctx, nx, ev.tenuto ? artY - 5 : artY);
            }
            if (ev.dynamic && !noDyn) drawDynamic(ctx, n, ev.dynamic, stave);
          });
          // crescendo / decrescendo hairpins — clip the ends away from any dynamic (f/p/mf…) glyph,
          // since the hairpin and the lettering sit at nearly the same height just below the stickings.
          var dynBoxes = [];
          ctx.save();
          if (ctx.setFont) ctx.setFont("Times New Roman", 22, "bold italic");
          ctx.font = "italic bold 22px 'Times New Roman'";
          vfNotes.forEach(function (n, ei){
            var ev = m.events[ei];
            if (ev && ev.dynamic) dynBoxes.push({ cx: headCenterX(n), hw: textWidth(ctx, ev.dynamic) / 2 + 5 });
          });
          ctx.restore();
          (noDyn ? [] : (m.wedges || [])).forEach(function (w){
            var n1 = vfNotes[w.from], n2 = vfNotes[w.to];
            if (!n1 || !n2) return;
            // Fill the beat: the converter's `to` is the note just BEFORE the target (the wedge "stop"
            // sits before the arrival note), so ending at n2's own x leaves the hairpin a note short and
            // it never "leads up to the point". Extend to the NEXT note's x (or the measure's note-end
            // edge for the last note). If the target carries a dynamic, the clip below trims the hairpin
            // to just before that letter — so it arrives exactly at the f/p/mf.
            var nNext = vfNotes[w.to + 1];
            var x1 = n1.getAbsoluteX();
            var x2 = nNext ? nNext.getAbsoluteX() : (stave.getNoteEndX ? stave.getNoteEndX() - 2 : n2.getAbsoluteX() + 22);
            dynBoxes.forEach(function (box){
              if (box.cx + box.hw > x1 && box.cx - box.hw < x2){     // a dynamic glyph sits inside the span
                if (box.cx - x1 <= x2 - box.cx) x1 = Math.max(x1, box.cx + box.hw);   // near the start → begin after it
                else x2 = Math.min(x2, box.cx - box.hw);                              // near the end  → end before it
              }
            });
            // `continued` = this fragment resumes the previous measure's hairpin (see musicxml-to-rdm.js).
            // Extend the pending run instead of drawing a fresh point — a hairpin only visually restarts
            // at a real staff-line break (flushPendingWedge() at bi===0 handles that), never at a plain
            // measure barline.
            if (w.continued && pendingWedge && pendingWedge.type === w.type) {
              pendingWedge.x2 = x2;
            } else {
              flushPendingWedge();
              pendingWedge = { type: w.type, x1: x1, x2: x2, stave: stave };
            }
          });
          // ---- extra voices (polyrhythm parts): drawn in the SAME bar, stems down. Render notes,
          // beams and any tuplet bracket so the cross-rhythm reads. The 2nd voice's stickings ARE drawn
          // (one row below voice 1's, so the two hands read as two stacked rows); accents + the playhead
          // still follow voice 1 only (notes[mi] is unchanged).
          (b.extra || []).forEach(function (xb){
            xb.voice.draw(ctx, stave);
            xb.beams.forEach(function (bm){ bm.setContext(ctx).draw(); });
            (xb.vfNotes || []).forEach(function (n){
              var ev = n && n._rdm;
              if (ev && !ev.rest && (ev.stick1 || ev.stick2)) drawSticking(ctx, n, stave, ev, 14);
            });
            (xb.tuplets || []).forEach(function (t){
              var arr = t.idx.map(function (i){ return xb.vfNotes[i]; }).filter(Boolean);
              if (!arr.length) return;
              var stdNormal = Math.pow(2, Math.floor(Math.log2(t.num || 1)));
              var tup = new VF.Tuplet(arr, {
                num_notes: t.num, notes_occupied: t.inSpaceOf, bracketed: !!t.bracket,
                ratioed: (t.inSpaceOf || 2) !== stdNormal, location: VF.Tuplet.LOCATION_BOTTOM, y_offset: 0
              });
              tup.setContext(ctx).draw();
            });
          });
        } else {
          notes[mi] = {};
        }
        // topMark = the true top of THIS measure's above-staff ink (tuplet #s / accents), in viewBox units
        // (getBBox space; the engine scales it to screen). Read from the glyphs added since the snapshot, so
        // it can't pick up a neighbouring system's marks. Falls back to the analytic estimate.
        if (staves[mi]) {
          // Work entirely in on-screen px (same space as notes[].yTop): getBBox is viewBox units → × vb2screen.
          var _top = Infinity, staveTopScreen = stave.getYForLine(0) * effZoom, mwScreen = mw * effZoom;
          if (_svgAll && _svgN0 >= 0) {
            for (var _gi = _svgN0; _gi < _svgAll.length; _gi++) {
              var _el = _svgAll[_gi]; if (!_el.getBBox) continue;
              var _bb; try { _bb = _el.getBBox(); } catch (e) { continue; }
              if (_bb.width <= 0 || _bb.height <= 0) continue;
              var _byS = _bb.y * vb2screen, _bwS = _bb.width * vb2screen;
              if (_bwS > mwScreen * 0.9) continue;            // skip the full-width stave line
              if (_byS >= staveTopScreen - 1) continue;       // only ink ABOVE the staff
              if (_byS < _top) _top = _byS;
            }
          }
          staves[mi].topMark = isFinite(_top) ? _top
                             : (isFinite(measTopMark) ? measTopMark * effZoom : (stave.getYForLine(0) - 14) * effZoom);
        }
        x += mw;
      });
    });
    flushPendingWedge();   // draw any run still pending from the very last system

    // fitZoom = the largest total scale at which the WIDEST bar still fits the page. Above it the render
    // can only clamp (a bar can't be drawn wider than the page without spilling), so a tool can use it to
    // stop offering zoom percentages that would silently do nothing (Anthony, 2026-08-08). effZoom is what
    // was actually drawn this pass.
    return { width: maxWidth, height: height * effZoom, notes: notes, staves: staves,
             effZoom: effZoom, fitZoom: fitZoom };
  }

  // a real drumline diddle slash: thick, centered on the stem, mid-stem, one per roll level
  function drawDiddle(ctx, note, strokes){
    var stem = note.getStem(); if (!stem) return;
    var ext = stem.getExtents();                 // {topY, baseY} for the up-stem
    var x = note.getStemX();
    var topY = Math.min(ext.topY, ext.baseY), baseY = Math.max(ext.topY, ext.baseY);
    // The beams/flags pile up at the TOP of the stem; on 16ths (2 beams) / 32nds (3) they eat a
    // lot of the upper stem, so a fixed 45% sits too high. Center the slash in the CLEAR stem
    // below the beams instead, dropping lower the more beams there are.
    var dur = (note.getDuration ? note.getDuration() : note.duration) || "8";
    var beams = ({ "8": 1, "16": 2, "32": 3, "64": 4 }[dur]) || 1;
    var beamZone = beams * 5;                     // px the beams/flags occupy from the stem top
    var n = Math.max(1, strokes), half = 5, gap = 4.5;
    var cy = (topY + beamZone + baseY) / 2;       // middle of the stem below the beams
    cy = Math.min(Math.max(cy, topY + beamZone + 3 + (n - 1) * gap / 2), baseY - 4 - (n - 1) * gap / 2);
    cy = Math.max(cy, topY + 6);                  // never crash into the very top
    ctx.save();
    ctx.beginPath();
    ctx.setLineWidth ? ctx.setLineWidth(3.3) : (ctx.lineWidth = 3.3);   // thicker = reads as a bold diddle slash
    if (ctx.attributes) ctx.attributes.stroke = "#000";
    for (var i=0; i<n; i++){
      var yy = cy + (i - (n-1)/2) * gap;
      ctx.moveTo(x - half, yy + 1.3);
      ctx.lineTo(x + half, yy - 1.3);            // shallower upward slash (less slanted), engraved-tremolo look
    }
    ctx.stroke();
    ctx.restore();
  }

  // a buzz / press roll: a "z" through the stem (unmeasured tremolo). Sits in the same clear stem
  // zone as a diddle slash so a buzz reads distinctly from a measured roll.
  function drawBuzz(ctx, note){
    var stem = note.getStem(); if (!stem) return;
    var ext = stem.getExtents();
    var x = note.getStemX();
    var topY = Math.min(ext.topY, ext.baseY), baseY = Math.max(ext.topY, ext.baseY);
    var dur = (note.getDuration ? note.getDuration() : note.duration) || "8";
    var beams = ({ "8": 1, "16": 2, "32": 3, "64": 4 }[dur]) || 1;
    var beamZone = beams * 5;
    var cy = (topY + beamZone + baseY) / 2;          // middle of the clear stem
    cy = Math.max(cy, topY + beamZone + 7);
    var w = 5, h = 5;                                // z half-width / half-height
    ctx.save();
    ctx.beginPath();
    ctx.setLineWidth ? ctx.setLineWidth(2.2) : (ctx.lineWidth = 2.2);
    if (ctx.attributes) ctx.attributes.stroke = "#000";
    ctx.moveTo(x - w, cy - h);                        // top bar
    ctx.lineTo(x + w, cy - h);
    ctx.lineTo(x - w, cy + h);                        // diagonal down-left
    ctx.lineTo(x + w, cy + h);                        // bottom bar
    ctx.stroke();
    ctx.restore();
  }

  // engraved-looking dynamic, below the stickings
  // anchor to the bottom STAFF LINE (getBottomY adds ~50px of slack that shoves text into the next system)
  function drawDynamic(ctx, note, dyn, stave){
    var x = headCenterX(note);                   // center on the notehead
    var y = stave.getYForLine(4) + 48;           // just below the two rows of R/L stickings
    ctx.save();
    ctx.setFont ? ctx.setFont("Times New Roman", 22, "bold italic") : 0;   // much bigger dynamics
    if (ctx.fillText){ ctx.font = "italic bold 22px 'Times New Roman'"; ctx.fillText(dyn, x - textWidth(ctx, dyn) / 2, y); }
    ctx.restore();
  }
  // crescendo (<) / diminuendo (>) hairpin below the staff, from the first to the last note it spans
  function drawWedge(ctx, x1, x2, type, stave){
    var y = stave.getYForLine(4) + 44, h = 5;
    if (x2 - x1 < 6) x2 = x1 + 6;
    /* Tag the output "rdm-hairpin". A hairpin is two plain stroked lines at width 1.5, which is also
       what 90-odd other things on the page are (beams, ledger lines, slashes) — so without a label there
       is no way to assert from the rendered SVG that hairpins specifically were drawn or removed, and
       dev/_nodyncheck.js could only ever check the feature vacuously. openGroup is VexFlow's own SVG
       grouping and is a no-op cost; guarded because the canvas backend has no such method.
       NOTE: VexFlow prefixes the class, so the element ends up class="vf-rdm-hairpin". */
    var grouped = !!ctx.openGroup;
    if (grouped) ctx.openGroup("rdm-hairpin");
    ctx.save();
    ctx.lineWidth = 1.5; if (ctx.setLineWidth) ctx.setLineWidth(1.5);
    ctx.beginPath();
    if (type === "crescendo"){ ctx.moveTo(x1, y); ctx.lineTo(x2, y - h); ctx.moveTo(x1, y); ctx.lineTo(x2, y + h); }
    else { ctx.moveTo(x1, y - h); ctx.lineTo(x2, y); ctx.moveTo(x1, y + h); ctx.lineTo(x2, y); }
    ctx.stroke(); ctx.restore();
    if (grouped) ctx.closeGroup();
  }

  // A "joined" measure is a single bar Sibelius merged from 2+ bars (e.g. an 8-beat 4/4). The export
  // drops the interior barline, so draw it ourselves at each time-signature boundary. The boundary x is
  // interpolated from note tick positions, so the line lands correctly even when a beam or tuplet
  // crosses it (a rhythm spanning the barline still gets the line drawn through where the beat falls).
  // NOTE: musicxml-to-rdm's splitOverfullMeasures now splits overfull bars into real measures upstream,
  // so this rarely fires; it stays as a harmless fallback for any clean 2x/3x bar that isn't split.
  function drawInnerBarlines(ctx, stave, m, vfNotes, barBeats){
    if (!barBeats || barBeats <= 0 || !vfNotes || !vfNotes.length) return;
    var total = m.events.reduce(function (a, e){ return a + (e.beats || 0); }, 0);
    var k = total / barBeats;
    if (k < 1.99 || Math.abs(k - Math.round(k)) > 0.02) return;   // only true joined bars (integer ≥2 bars)
    var starts = [], cum = 0;
    vfNotes.forEach(function (n, i){ starts.push({ beat: cum, x: n.getAbsoluteX() }); cum += (m.events[i] && m.events[i].beats) || 0; });
    starts.push({ beat: cum, x: stave.getNoteEndX() });
    function xAtBeat(b){
      for (var i = 0; i < starts.length - 1; i++){
        if (b >= starts[i].beat - 1e-6 && b <= starts[i + 1].beat + 1e-6){
          var span = starts[i + 1].beat - starts[i].beat;
          return span > 1e-6 ? starts[i].x + (b - starts[i].beat) / span * (starts[i + 1].x - starts[i].x) : starts[i].x;
        }
      }
      return starts[starts.length - 1].x;
    }
    var topY = stave.getYForLine(0), botY = stave.getYForLine(4);
    ctx.save();
    ctx.lineWidth = 1; if (ctx.setLineWidth) ctx.setLineWidth(1);
    for (var b = barBeats; b < total - 0.01; b += barBeats){
      var x = xAtBeat(b);
      ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, botY); ctx.stroke();
    }
    ctx.restore();
  }

  // stickings: always BELOW the staff, centered on the note; two stickings = two rows
  function drawSticking(ctx, note, stave, ev, rowShift){
    if (!ev.stick1 && !ev.stick2) return;
    var x = headCenterX(note);                   // center on the notehead
    // rowShift nudges down one row: voice-1 stickings sit in the top row, a polyrhythm's 2nd-voice
    // stickings sit in the SECOND row (below), so the two hands read as two stacked rows.
    var y1 = stave.getYForLine(4) + 18 + (rowShift || 0);
    ctx.save();
    if (ctx.setFont) ctx.setFont("Arial", 13, "bold");
    if (ctx.fillText){
      ctx.font = "bold 13px Arial";
      if (ev.stick1) ctx.fillText(ev.stick1, x - textWidth(ctx, ev.stick1) / 2, y1);
      if (ev.stick2) ctx.fillText(ev.stick2, x - textWidth(ctx, ev.stick2) / 2, y1 + 14);
    }
    ctx.restore();
  }

  /* Set by RDMPlayer.applyNoDynamics (engine.js), which owns the setting and fans it out. Kept here as
     module state rather than read from a global on every draw so a render never depends on load order. */
  function setNoDynamics(v){ NO_DYN = !!v; }
  var api = { render: render, setNoDynamics: setNoDynamics };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RDMRender = api;
})(typeof window !== "undefined" ? window : globalThis);
