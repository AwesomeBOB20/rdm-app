/* ============================================================
   RDM PLAYER ENGINE  (engine.js)  — synthesized note-data transport
   The shared transport every RDM Engine V2 tool plugs into.

   Source of truth is the RDM note format (from MusicXML or generated),
   NOT an MP3. The engine renders the notation (rdm-vexflow) into a host
   element, plays it with the shared square-wave drum voice + a sample-
   accurate scheduler, and sweeps a traveling playhead — the same core
   the MusicXML Player uses.

   It still owns: play/pause, tempo (just BPM — no time-stretch needed
   now that audio is synthesized), looping, the Randomize + Bump auto
   features, a "sequence" mode for playlists, and an optional metronome.

   It does NOT touch UI chrome/styling beyond the host it renders into +
   its own playhead canvas. Tools listen to callbacks and update their UI.

   new RDMPlayer(hostEl, callbacks)
     hostEl = element to render the score into (position:relative)
     callbacks = { onTime, onTempoChange, onState, onLoad, onLoop }
   ============================================================ */
(function (global) {
  "use strict";

  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

  function RDMPlayer(hostEl, callbacks) {
    this.host = hostEl;
    this.cb = callbacks || {};

    // current track
    this.originalTempo = 120; this.tempo = 120; this.minTempo = 60; this.maxTempo = 240;
    this._loadGen = 0;   // bumped on every load() call so a superseded in-flight fetch can bail before
                         // the expensive render, instead of racing to draw a track nobody wants anymore

    // mode + automation
    this.mode = "loop";          // "loop" | "sequence"
    this.auto = null;            // null | "randomize" | "bump"
    this.randomCfg = { reps: 1, min: null, max: null };
    this.bumpCfg   = { reps: 1, step: 5 };
    this.metroOn = false;

    // counters
    this._loopIndex = 0; this._repCounter = 0; this._prevRandom = null;
    this._lastTempoChangeAt = 0; this._sequenceHandler = null;
    // Loop count-off (Loop tab > "Count-off"): when on AND a loop window is selected, the piece's own
    // count-off sound counts you in before the window starts and before every repeat. _coGap holds the
    // live silent gap while it's sounding (see _beginCountOff).
    this.loopCountOff = false; this._coGap = null; this._coArming = false;
    this.countOffBeats = 4;      // how many clicks the loop count-off gives you: 4 (default) or 2

    // note data + render
    this.rdm = null; this.out = null; this.perf = null; this.anchors = null; this.downbeats = null; this.totalBeats = 0;
    this._metroPulseUnit = null;   // downbeats[i]'s metro click spacing, in quarter-note units (1 = plain
                                   // quarter; 1.5 = dotted quarter for a compound meter like 6/8, 9/8, 12/8)
    this._metroPulseGrid = null;   // downbeats[i]'s per-measure pulse GRID (array of pulse durations, e.g.
                                   // [1.5,1,1] for a 7/8 grouped 3+2+2) when the tool sets cb.metroGroupedPulse
                                   // and the measure carries a pulseMap; null = uniform (use _metroPulseUnit).
    this.measures = null;        // per measure-INSTANCE cells {startBeat,endBeat,startIdx,endIdx,x0,x1,yTop,yBot} for loop selection
    // loop window: repeat only a sub-section (a range of measures) instead of the whole piece.
    // null = whole piece. loopM0/M1 are measure-instance indices; loopStart/End are beats; the
    // *Idx are perf indices. Everything maps through the one beat clock, so setting these makes the
    // scheduler, metronome and playhead all loop the window together (see _displayBeat + scheduler).
    this.loopStart = null; this.loopEnd = null; this.loopM0 = null; this.loopM1 = null;
    this.loopStartIdx = 0; this.loopEndIdx = 0;
    this.zoom = 1;               // music size multiplier (0.5–2.5); scales the whole notation. 1 = the
                                 // baseline the size stepper shows as 100%.
    this.followScroll = true;    // true = auto-scroll follows the music (lock); false = user scrolls freely
    this.phCanvas = null; this.phCtx = null; this.selCanvas = null; this.selCtx = null;

    // audio + scheduler
    this.actx = null; this.master = null;
    this.playing = false; this._timer = null; this._raf = null;
    this.idx = 0; this.audioStart = 0; this.cumBeat = 0; this._sched = [];
    this.metroBeat = 0; this._lastSchedTime = 0;
    this.anchorTime = 0; this.anchorBeat = 0; this.spb = 0.5; this._anchorI = 0;   // shared beat<->time clock
    // Seconds the cursor reads AHEAD of the audio clock. The draw pipeline (rAF -> canvas paint ->
    // compositor -> screen) is ~2 frames behind the sound, so a cursor drawn for "now" lands on
    // screen a beat-fraction late and looks like it trails the music. Reading slightly into the
    // future cancels that so it lands WITH the note. Raise it if the cursor still trails; lower it
    // (or go negative) if it starts running ahead of the sound.
    this.cursorLead = 0.045;
    // ---- Dynamics / velocity model (see DYNAMICS-SPEC.md, step 1). Every note gets a velocity
    //      (0..1); _gainFor(timbre, vel) maps it to oscillator gain. Tune by ear — this is the one
    //      place. Calibrated so today's rimshot/rim/stick/cross loudness is preserved and only the
    //      C-space "tap" is lifted out of near-silence. ----
    this.DYN = {
      // articulation ladder (velocity 0..1) for normal C-space notes + plain-x rims
      TAP: 0.245,         /* unaccented note in a piece that HAS accents (quiet side of the contrast). Tuned
                             0.30 -> 0.22 -> 0.15 -> 0.17 -> 0.20 -> 0.22 -> 0.27 -> 0.245.

                             0.22 was "1/10". 0.27 was the "make the taps a little louder, 1/10 to a 2/10"
                             pass (2026-08-07). Anthony then heard it back and asked for HALF of that raise
                             — "bring taps from a 1/10 to 1.5/10" — so this sits at the midpoint, +1.9 dB
                             on 0.22 instead of +3.6 dB.

                             The rest of what he wanted at speed comes from ACCENT dropping to 0.72 in the
                             same pass: the tap-to-accent GAP is what makes taps vanish under a fast accent,
                             and this pair narrows it by 2.1 dB while the absolute tap level comes DOWN.

                             It cannot push a piece into clipping — the accents set the peak, and they only
                             got quieter. (dev/loudness-diag.js)

                             ONLY used in ACCENT-TAP passages — flat passages use TAP_NORMAL below. */
      /* FLAT MUSIC: the level every note plays at in a passage with no accents in it.

         This is not "a slightly louder tap". A flat passage is FULL STROKES — a drummer playing four
         bars of straight 16ths at forte plays them at the same stick height they would play accents at,
         because there is nothing for them to be quiet against. So this belongs just under ACCENT, and
         that is where three rounds of "flat pieces sound too quiet / too loud" had already dragged it:
         0.62 -> 0.75 -> 0.64 -> 0.68, all of them circling ACCENT without saying so.

         Naming it out loud is what fixes Etude 1. The old model asked "how accented is this PIECE" and
         blended between here and TAP, which gave a piece that is mostly flat with two accented sections
         one compromise level that was wrong in both. Now the question is asked per SECTION and answered
         yes/no (see _buildPlayback), so a flat bar is genuinely flat and an accent-tap bar genuinely
         drops its taps. Kept a hair under ACCENT so a real accent still wins if one turns up. */
      TAP_NORMAL: 0.72,
      /* TENUTO. "Tenutos should always be slightly above tap volume. Accents should be the loudest
         thing." (Anthony, 2026-08-07.)

         It used to be `tap x 1.4`, which is fine when a tap is quiet and catastrophic when it is not:
         in a flat passage the tap level is 0.68, so a tenuto came out at 0.95 — LOUDER THAN AN ACCENT.
         That is what he heard in bar 9 of Etude 1, where ten tenutos were beating every forte note in
         the piece.

         So a tenuto is now defined by where it sits BETWEEN the tap and the accent, not by a multiple
         of the tap. A quarter of the way up. That is "slightly above a tap" at any tap level, and it
         cannot outrun an accent by construction, whatever the sliders are set to. */
      TENUTO_FRAC: 0.08,
      /* HOW FAR A WRITTEN DYNAMIC PULLS FLAT MUSIC, as an exponent on the section level. 1 = the same
         as accent-tap music; higher = flat music has a deeper soft end.

         Anthony's three targets (2026-08-07) are not satisfiable with one dynamic range:
           "flat loud should be as loud as accents from accent tap loud"   -> flat f = ACCENT
           "flat soft should be as quiet as soft accent tap tenutos"       -> flat p = tenuto x p
         A single p multiplier cannot land 0.72 on 0.1415; it would have to be 0.196, not 0.50. So flat
         music genuinely has a WIDER dynamic range than accent-tap music does, which is exactly right by
         ear: in accent-tap music the tap layer is already carrying the quiet, so pulling the accents
         down as far would bury the taps under the noise floor. In flat music every note is the line, so
         a piano has to take the whole line down.

         An exponent rather than a second table because 1^k = 1 pins the LOUD end exactly where the
         first target needs it, and one number stays tunable by ear. 2.35 puts p at 0.196 (the value
         that lands flat-soft on the accent-tap soft tenuto to within 0.03 dB) and mf/mp/pp fall in
         line behind it. Only applied where the level is BELOW 1, so crescendo ceilings are untouched. */
      FLAT_DYN_POWER: 2.35,
      /* An accent falling to a plain tap ON THE SAME HAND, this fast or faster, plays the tap at tenuto
         instead. Anthony's anchor: two 16ths at 95 BPM = 60/95/4 s between them. See _buildPlayback. */
      ACC_TAP_LIFT_SEC: 60 / 95 / 4,
      /* > accent. Tuned 0.90 -> 0.85 -> 0.72 (Anthony, 2026-08-07: "bring accents from a 10/10 to a
         8.5/10" — 0.85 x 0.85 = 0.7225, taken to 0.72). Through GAMMA 2 that is -2.9 dB.

         This is the half of the fix that matters at speed. Taps do not disappear in a fast passage
         because they are quiet in absolute terms; they disappear because the accent either side of them
         is 20 dB louder and masks them (and with the real pad SAMPLES a hit rings ~140ms instead of the
         oscillator's ~30ms, so there is far more of it left to do the masking). Lowering the loud end
         narrows that gap without making the quiet end loud enough to kill the contrast.

         MARCATO/RIMSHOT/STICK/CROSS are deliberately NOT scaled with it: they are separate timbres with
         their own BASE_GAIN, Anthony asked for accents specifically, and a rimshot being clearly bigger
         than an accent is correct. */
      ACCENT: 0.72,
      MARCATO: 1.00,      // ^ rooftop → rimshot, the biggest hit
      // notated effect sounds carry their own base velocity (not part of the tap/accent ladder)
      RIMSHOT: 0.92,      // cross-notehead rimshot default
      STICK: 0.86,        // stick-click (X on the top line) mid-piece
      CROSS: 0.90,        // cross-stick (slashed notehead)
      /* ---- DOUBLE STOPS (a printed "B" sticking = both hands at once). See _doubleStop. ---- */
      DS_VEL_MULT: 1.12,   // two sticks land more weight than one — a bump, not a new dynamic level
      /* Seconds between the two hands. ZERO (Anthony, 2026-08-07: "make double stops sound exactly clean,
         no displacement, it sounds too obvious rn"). 4ms was there to model the fact that real hands are
         never exact — but a CLEAN double stop is the whole point of playing one, and at 4ms you could
         hear the flam in it. Dead together, the two strokes sum into one bigger note, which is what a
         clean double stop is. Kept as a named constant rather than deleted: it is the knob if a hair of
         width is ever wanted back. */
      DS_SPREAD: 0,
      DS_SECOND_MULT: 0.88, // and the second hand is never quite as big as the first
      /* ---- OUTPUT STAGE. See _buildOutputChain — these three decide how loud the app is. ----
         OUT_DRIVE  how hard everything is pushed. Straight gain below the knee, so this is exactly how
                    much louder an ordinary note gets.
         OUT_KNEE   where limiting starts, as a fraction of full scale AFTER the drive. Everything under
                    it is untouched, which is what keeps the tap/tenuto/accent ladder intact.
         OUT_TRIM   final headroom under 0 dBFS. */
      /* Swept, not guessed (dev/_outsweep.js, Etude 1). Every row is "loudness bought" against
         "relative volume paid", and the knee is what makes the trade cheap:

             drive  knee    louder    ladder moves
              2.6   0.92    +2.9 dB     -0.03 dB     free, but leaves gain on the table
              3.0   0.92    +4.0 dB     -0.97 dB     <- here
              3.6   0.92    +5.2 dB     -2.54 dB
              4.4   0.92    +6.3 dB     -4.28 dB     a quarter of the accent-tap contrast, gone

         "Ladder moves" is how much the 18.7 dB accent-to-tap gap narrows, so -0.97 dB is 5% of it. The
         app is ALREADY peak-normalised — its loudest pieces sit at 0 dBFS — so there is no linear gain
         left anywhere and every further dB has to come from limiting. This is the point where it is
         plainly louder and the contrast is still, to an ear, the same contrast. */
      OUT_DRIVE: 3.0,
      OUT_KNEE: 0.92,
      /* Headroom under 0 dBFS. Not decorative: a 4x-oversampled WaveShaper OVERSHOOTS its own curve by
         about a dB (the resampling filters ring), so a curve mathematically bounded at 1.0 still measured
         +1.0 dBFS without this. Set from the measurement, not from theory. */
      OUT_TRIM: 0.84,
      TAPOFF: 0.95,       // count-off / tap-off velocity — rendered on the louder "stickLoud" ceiling
      GAMMA: 2.0,         // velocity->gain curve. Steeper = wider dynamic range: quiet notes drop a LOT,
                          // loud notes stay loud. Tuned 1.6 -> 2.1 -> 2.0 (eased slightly to lift the soft end).
      // peak oscillator gain per timbre (the sound at velocity 1.0). stickLoud = the count-off, lifted
      // near accent loudness so the tap-off cuts through like the drummer's real count-off.
      BASE_GAIN: { click: 0.72, rimshot: 0.70, rim: 0.60, stick: 0.52, stickLoud: 0.68, cross: 0.46 },
      // Section dynamics (step 3): a written p/f/mf scales the WHOLE passage's velocity until the next
      // mark. DYN_DEFAULT = full, so a piece with NO marks is unchanged (Step 3 is purely additive) and
      // written marks only ever pull softer (f/ff = full). Unknown marks leave the current level as-is.
      DYN_DEFAULT: 1.00,
      // Piano side pulled down (p 0.68 -> 0.50, etc.) so f↔p reads as a DRAMATIC contrast and crescendos
      // that ramp p->f really open up. f/ff stay at full; mp/mf unchanged, so mid-dynamic pieces are the same.
      DYNAMICS: { pppp:0.25, ppp:0.33, pp:0.40, p:0.50, mp:0.72, mf:0.88, f:1.00, ff:1.00, fff:1.00,
                  ffff:1.00, sf:1.00, sfz:1.00, sffz:1.00, fz:1.00, rf:1.00, rfz:1.00, fp:0.50, sfp:0.50 },
      // Hairpins (step 4): a cresc/decresc bounded by a written dynamic that agrees with its direction
      // ramps ALL THE WAY to that mark's exact level (the target note's own dynamic — Anthony: hairpins
      // should fully arrive, not fall short). An UNbounded one (no agreeing mark to aim at) has no explicit
      // target note, so it ramps all the way to the true extreme instead — SWELL_CEILING for a crescendo,
      // SWELL_FLOOR for a diminuendo — rather than a partial relative bump.
      SWELL_FLOOR: 0.35,
      // Also the extreme an unbounded crescendo climbs to. Set well above 1 so a piece with NO written
      // dynamics (sits at DYN_DEFAULT 1.00 throughout) ramps up MEANINGFULLY — _hit() clamps the final
      // applied velocity to 1, so this only lifts notes below the ceiling (taps, tenuto, and the quiet
      // lead-up into an accented target); an already-maxed marcato/rimshot is unaffected. Raised 1.15 ->
      // 1.45 (Anthony, 2026-07-19: the notes leading up to a crescendo's target note weren't getting loud
      // enough — with the dip gone, the ramp now goes 1.0 -> 1.45, so the lead-up notes lift audibly and
      // the target lands at full). Tune by ear.
      SWELL_CEILING: 1.45,
      // Contrast floor/ceiling for the START of a hairpin (Anthony: a crescendo should clearly START SOFT
      // and get louder toward its target; a decrescendo should START LOUD and fall to its target). Without
      // this the ramp just started at the running section level, so an unbounded crescendo from a loud/
      // default 1.0 section had nowhere to climb and sounded flat. SWELL_SOFT_START pulls a crescendo's
      // start down to ~p; SWELL_LOUD_START pulls a decrescendo's start up to ~f. The END still scales with
      // the target, so the swell "gets louder depending on the target." Tune by ear.
      // Raised 0.5 -> 0.65 (Anthony, 2026-07-19: the dip at the start of a crescendo was too drastic).
      SWELL_SOFT_START: 0.65,
      /* (There is no SWELL_FLAT_START. A crescendo in flat music — where the passage already rests at
         its ceiling and there is nothing above it to climb to — starts at DYN.TAP, the same place an
         accent-tap crescendo starts, so the two sound alike. It needed a constant only while it was
         defined as "a fraction of the flat level", and that was what made bar 1 of Rhythm X start
         4.2 dB hotter than bar 12. See the tapReach collapse in _computeDynamics.) */
      SWELL_LOUD_START: 1.00,
      // Floor for a crescendo's PEAK (its target note). An accent/marcato target already sits well above
      // this, so it only matters when a crescendo leads into a PLAIN note: it guarantees the swell still
      // audibly builds to a solid forte arrival instead of fizzling at tap level (Anthony, 2026-07-20).
      MIN_CRESC_PEAK: 0.5,
      // The crescendo target is the CLIMAX — nothing before it may play louder, and the accents leading in
      // must BUILD to it, not blast to full mid-swell (Anthony, 2026-07-21: "the 1st accents shouldn't be
      // louder than the final target note"). Two envelopes, both as a fraction of the target loudness and
      // both ending BELOW it so the target stays the unique peak: accents ride the loud layer
      // (SWELL_ACC_START at the swell's start → SWELL_ACC_END just under the target), taps ride the quiet
      // layer underneath, up to SWELL_TAP_END (loud last taps, still below the accents → contrast kept).
      SWELL_ACC_START: 0.55,
      SWELL_ACC_END: 0.9,
      // How loud the TAP layer gets by the end of the swell — and this is CASE-BY-CASE (Anthony, 2026-07-21):
      //   • If the swell has ACCENTS in it, THEY are the thing getting loud; the taps must stay in their
      //     contrast role and NOT blow up (SWELL_TAP_END_CONTRAST — a gentle rise, staying well under the
      //     accents). Image 1: accents + taps around each other → taps stay soft.
      //   • If the swell is ALL TAPS (no accents), the taps ARE the crescendo, so they build all the way up
      //     (SWELL_TAP_END). Image 2: no accents → taps take on the "get loud" role.
      SWELL_TAP_END: 0.8,
      SWELL_TAP_END_CONTRAST: 0.4,
      // Shapes the ramp so it hugs its START value longer and rushes to the TARGET near the very end,
      // instead of climbing at a flat constant rate — "the last few notes should really ramp up to the
      // target note" (Anthony, 2026-07-19). Applied as frac^SWELL_EASE_POWER before the start->end blend;
      // >1 = back-loaded (this), 1 = linear (old behavior), <1 would front-load. Tune by ear.
      SWELL_EASE_POWER: 1.6,
      /* Grace-note ornaments — a FLAM is one grace, a RUFF/DRAG is two, a (rare) triple is three.
         The graces are played by the hand OPPOSITE the principal, so two of them are a DIDDLE: a fast
         double on one hand crushed in right before the beat (Anthony, 2026-08-02: "fix the ruff sound.
         it should sound like a diddle right before the primary note"). What was broken: the audio path
         only ever saw `flam: true`, a boolean, so it fired exactly ONE grace no matter how many the
         music actually had — a ruff was byte-for-byte a flam. The grace COUNT now travels with the
         playback event (see the `graces` field in _buildPlayback) and _hit lays down that many strokes.

         GRACE_LEAD is the gap from the LAST grace to the principal. It is the 13ms the flam has always
         used, pulled out of _hit into a named constant so the one-grace case still resolves to exactly
         `time - 0.013` — the flam must not move by so much as a sample.

         GRACE_SPACING is the gap BETWEEN successive graces inside a multi-grace ornament, AND (since
         2026-08-05) the gap from the last grace to the principal whenever there is more than one grace.
         Anthony: "ruffs have to be more slow and open. its like 2 notes into the primary note with even
         spacing, but the spacing is just way too tight right now, open it up to sound like a diddle.
         wider." It was 13ms — the flam's lead, reused so the ruff's three attacks would at least be
         EVEN — and even was right while 13ms was far too crushed to read as two separate strokes. At 35ms
         a ruff lands -70ms, -35ms, principal on the beat: still an ornament ahead of the beat, but the
         pair now speaks as a drag instead of a buzz.

         Why the multi-grace case takes its LEAD from this constant too: leaving the last grace at
         GRACE_LEAD while widening only the gap between graces would make the ornament uneven (35ms then
         13ms), which is exactly the "even spacing" Anthony is describing. A flam has no gap-between-graces
         to be even with, so it keeps GRACE_LEAD untouched and must not move by so much as a sample.
         Tune by ear.

         Loudness is NOT set here: every grace keeps the flam grace's own fixed level (see _hit), which
         sits just under a tap and is never scaled off the principal. That is what keeps both strokes
         quieter than the note they ornament — tap or accent — and keeps them even with each other, so
         the pair reads as a diddle instead of a two-step crescendo into the beat. (There is no per-hand
         voicing anywhere in this engine — every stroke is the same voice — so "the graces are the other
         hand" has no audio consequence beyond the count and the spacing.) */
      GRACE_LEAD: 0.013,
      GRACE_SPACING: 0.035,
      // Buzz/press rolls (Anthony 2026-07-10: should get shorter + a bit quieter as tempo climbs — a real
      // press roll thins out at speed). Scaled by how far ABOVE the PIECE'S OWN written tempo the user has
      // pushed the slider (this.tempo / this.originalTempo), not an absolute BPM — so a naturally-slow
      // piece and a naturally-fast piece both sound unchanged at their own normal tempo, and both shorten/
      // quiet the same way as the user speeds past it. BUZZ_TEMPO_RATIO_MAX=2 matches maxTempo (orig*2), so
      // the full shrink is reached exactly at the fastest the slider allows.
      // Bumped 2026-07-10 (Anthony: still not short/quiet enough at speed) — FAST values pushed further
      // down (span .70->.55, gain .30->.22); SLOW values unchanged so a piece at its own written tempo
      // still sounds exactly as it always has.
      // Three buzz lengths, longest -> shortest (Anthony, 2026-07-21): ADJACENT non-staccato (a buzz ROLL,
      // rings longest so the strokes connect) > ISOLATED non-staccato (SLOW, 0.90, the middle length) >
      // STACCATO (shortest, a clipped press). SLOW is the ISOLATED written-tempo length (0.92 -> 0.98 -> 1.10
      // -> 0.90); FAST (the speed-shrink) untouched, so buzzes still thin out as the tempo slider passes
      // written. Adjacent gets LONGER than this (mult > 1 below); staccato gets shorter.
      BUZZ_TEMPO_RATIO_MAX: 2,
      BUZZ_SPAN_MULT_SLOW: 0.90, BUZZ_SPAN_MULT_FAST: 0.55,   // fraction of the note's value the ISOLATED buzz rings for
      // STACCATO stacks on top of SLOW/FAST (0.90 * this). Raised 0.75 -> 0.78 (Anthony, 2026-07-21: "make
      // staccato buzzes barely longer") — still the SHORTEST tier (0.90*0.78 ≈ 0.70, under isolated's 0.90
      // and adjacent's 1.35), just a hair less clipped. Tune by ear.
      BUZZ_STACCATO_SPAN_MULT: 0.78,
      BUZZ_GAIN_MULT_SLOW: 0.38, BUZZ_GAIN_MULT_FAST: 0.22,   // gain multiplier on top of the articulation velocity
      // A staccato buzz's shorter span means fewer bounces at the same per-bounce gain, so it reads thinner/
      // quieter than a full buzz even though nothing here lowers its gain. Nudged up 1.0 -> 1.12 -> 1.19
      // (Anthony, 2026-07-21: "a bit too quiet, raise a tiny tiny bit", then "barely louder" again). Tune by ear.
      BUZZ_STACCATO_GAIN_BOOST: 1.19,
      // Anthony 2026-07-10: tried merging consecutive buzz notes into one continuous roll — reverted, he
      // wants each written buzz note audibly distinct, not blended together. Every buzz plays independently
      // again (each its own bounce-train). BUZZ_ONSET_DELAY still stands (measure 15 of "2025.10.9 Shopping
      // Spree" read early) — trimmed repeatedly (.01 -> .006 -> .003 -> .0015) since it kept reading a bit
      // late each time. Tune by ear.
      BUZZ_ONSET_DELAY: 0.0015,
      // Even without merging, two buzz notes back to back still blurred together (each already rings ~92%
      // of its own note at written tempo, leaving only a sliver of gap). BUZZ_ADJACENT_SPAN_MULT shrinks
      // JUST that note's span further — stacked on top of the normal tempo-based spanMult — only when
      // _buzzAdjacentNext flags it as immediately followed by another buzz (see _buildPlayback). An
      // NOW a LENGTHENER, not a shrinker (Anthony wants adjacent buzzes to be the LONGEST — a buzz roll should
      // sustain, its strokes connecting into each other). > 1, so back-to-back buzzes ring PAST the note value
      // — longer than an isolated buzz (0.90). Raised 1.25 -> 1.5 (Anthony, 2026-07-21: "adjacent buzzes
      // should be longer"; 0.90 * 1.5 = 1.35 of the note). The fading tail keeps the overhang a soft decay
      // into the next stroke (the connected-roll sound), not a doubled attack. Tune by ear.
      BUZZ_ADJACENT_SPAN_MULT: 1.5,
      // A run of buzzes (e.g. accent-buzz -> tap-buzz -> tap-buzz -> tap-buzz) reads as a HARSH volume cliff:
      // each buzz's gain comes straight from its own articulation (accent 0.85 vs tap 0.22), so the very next
      // buzz snaps all the way down with nothing in between (Anthony, 2026-07-21: "sounds like a harsh drop
      // off... make the volume drop off not so harsh and a little smoother"). Only smooths DROPS (loud->soft)
      // within a back-to-back buzz run — a buzz getting LOUDER (building toward an accent) stays instant,
      // that's a real attack, not a drop-off. 0 = no smoothing (old behavior), 1 = next buzz stays at the
      // previous buzz's level (too smeared). Tune by ear.
      BUZZ_DROP_SMOOTH: 0.4,
      /* Every bounce inside ONE buzz is a little quieter than the one before it (Anthony, 2026-08-07:
         "have each buzz decay a tiny bit, like from a 10 to an 8.25"). A real press roll cannot hold a
         flat level — the stick is riding out its own energy — and a perfectly even bounce train is the
         single thing that reads as synthetic, which is exactly why it showed up once the recorded pad
         samples went in. This is the level the LAST bounce sits at relative to the first: 1 = the old
         flat train, 0.825 = his number. It multiplies the tail fade below rather than replacing it —
         the ramp is the body of the buzz, the fade is its release. */
      BUZZ_DECAY_END: 0.825,
      /* LIFT THE QUIET BUZZES ONLY (Anthony, 2026-08-07: "buzzes that are taps... they're almost like
         impossible to hear, raise them up just a tiny bit").

         A buzz already rides at BUZZ_GAIN_MULT (0.38) of a struck note because it is a texture, and that
         multiplier lands on top of GAMMA 2 — so quiet ones fall away twice. Measured over the 17 catalog
         pieces that contain a buzz (dev/_buzzlevels.js): 186 of 206 buzz notes play below velocity 0.45,
         and the tail reaches 0.086, which is 37 dB under an accent buzz. Inaudible is right.

         So this is a knee, not a gain: below QUIET_KNEE a note is lifted, and the lift tapers to nothing
         AT the knee, so accent buzzes (0.72) and anything else loud are untouched to the last decimal.
         The quietest get the most help, which is the complaint:
             vel 0.086 -> +9.0 dB      vel 0.245 (a plain tap) -> +3.0 dB
             vel 0.141 -> +6.9 dB      vel 0.435 -> +0.1 dB        vel 0.72 -> none
         Quiet buzzes stay ordered against each other (0.086 vs 0.141 keeps 6.4 dB of the 8.6 it had), so
         this compresses the bottom without flattening it. */
      BUZZ_QUIET_KNEE: 0.45,
      BUZZ_QUIET_LIFT: 0.10,
    };
    /* The three levels the user is allowed to move (Settings → Sound) are remembered at their tuned
       values, so the sliders are always a multiplier ON the tuning rather than a replacement for it —
       retuning DYN above keeps working and a saved 100%/100% is exactly today's sound. */
    this._dynDefaults = { TAP: this.DYN.TAP, TAP_NORMAL: this.DYN.TAP_NORMAL, ACCENT: this.DYN.ACCENT };
    this._hasAccent = null;         // set per piece in _buildPlayback; null = nothing loaded yet
    this.setDynamics(RDMPlayer.loadDynamics());
    // the renderer is a separate module with no player reference, so tell it the saved state too
    RDMPlayer.setRenderNoDynamics(this.noDyn);
    RDMPlayer._live.push(this);     // so a Settings change reaches a player that is already mounted
  }

  /* ---------- user loudness (Settings → Sound) ----------
     Two multipliers, stored PER DEVICE: the right volume depends on headphones vs laptop speakers, and
     it has to work logged out. "tap" moves TAP and TAP_NORMAL together (preserving their ratio) so the
     original complaint — inaudible taps — is fixed in accented AND no-accent pieces alike. "accent" sets
     the ceiling. GAMMA is deliberately NOT exposed: it is the curve between the two, and a third control
     makes the other two feel non-linear as you drag. Effect sounds and the count-off keep their own
     velocities. 1 = the tuned default. (Anthony, 2026-07-21) */
  var DYN_KEY = "rdm.dynamics";
  RDMPlayer.DYN_KEY = DYN_KEY;
  RDMPlayer.DYN_RANGE = { tapMin: 0.5, tapMax: 1.5, accentMin: 0.5, accentMax: 1.20 };
  /* ---------- per-SOUND levels (Settings → Sound, the per-notehead rows) ----------
     Tap/accent above move the ARTICULATION ladder (how loud a quiet note is vs a loud one) and only
     touch normal C-space notes. These move an individual VOICE instead — the rimshot, the rim, the
     stick click, the cross-stick, the count-off — each a multiplier on that timbre's BASE_GAIN, so a
     student who can't hear the count-off over their playing can lift just that, without also lifting
     everything else (Anthony, 2026-07-31).

     The keys are the ENGINE'S timbre names, so _gainFor can look a multiplier up directly with no
     translation table to keep in sync. `stickLoud` is the count-off specifically (a tap-off renders on
     a louder ceiling than a mid-piece stick click — see _stickClick), which is why the count-off gets
     its own row rather than riding the stick click's.

     `note` is capped lower than the effect sounds on purpose: the measured diagnosis (2026-08-02,
     0-DOCS/APP-BACKLOG.md) found accented pieces already peak at -0.4 dBFS, so the main voice has
     almost no headroom left, while rim/stick/cross sit well below it and can take a full 1.5x. Floors
     differ too — an effect sound may be silenced outright (0 = off, a legitimate choice for the
     count-off or the rim), but the main note may not, since muting it would just look broken. */
  /* ---------- per-voice TONE (Settings → Sound, the "sound" picker on each row) ----------
     A level answers "how loud is my rimshot"; a tone answers "what does my rimshot sound like"
     (Anthony, 2026-08-02: "people should be able to change the sounds of each note type as well").

     Each tone is a TRANSFORM of the voice's own defaults rather than a fixed absolute sound: a
     frequency multiplier, a length multiplier, and a waveform. That matters — it means "Woody" keeps
     the rim tick well above the cross stick's knock instead of collapsing every voice onto the same
     pitch, so a piece stays readable by ear no matter which tones are picked. `default` is the
     identity transform (w:null = keep the voice's own waveform), so it is exactly today's sound. */
  RDMPlayer.TONES = {
    "default": { label: "Default", f: 1,    d: 1,   w: null },
    bright:    { label: "Bright",  f: 1.45, d: 0.8, w: "square" },
    sharp:     { label: "Sharp",   f: 1.2,  d: 0.6, w: "sawtooth" },
    woody:     { label: "Woody",   f: 0.62, d: 1.5, w: "triangle" },
    soft:      { label: "Soft",    f: 0.8,  d: 1.7, w: "sine" },
    /* A RECORDED pad rather than a waveform transform. shared/rdm-samples.js intercepts _voiceClick for
       any voice set to this and plays Anthony's own pad; the identity numbers here are the fallback the
       oscillator uses while the recordings are still downloading, or if they fail to load at all. So a
       student who picks it never gets silence, just the default sound until the wavs land. Listed in
       TONES because _tones() validates against this map and would otherwise reset the choice to
       "default" the moment it was saved. */
    invader:   { label: "Invader Pad", f: 1, d: 1, w: null },
  };
  RDMPlayer.TONE_KEYS = ["default", "bright", "sharp", "woody", "soft", "invader"];
  RDMPlayer.SOUND_KEYS = ["click", "rimshot", "rim", "stick", "cross", "stickLoud"];
  RDMPlayer.SOUND_RANGE = {
    click:     { min: 0.5, max: 1.3 },   // normal note — already near the ceiling, so a tighter cap
    rimshot:   { min: 0,   max: 1.5 },
    rim:       { min: 0,   max: 1.5 },
    stick:     { min: 0,   max: 1.5 },
    cross:     { min: 0,   max: 1.5 },
    stickLoud: { min: 0,   max: 1.5 },   // the count-off / tap-off
  };
  RDMPlayer._live = [];
  function _mul(v, lo, hi) { v = Number(v); return (isFinite(v) && v > 0) ? clamp(v, lo, hi) : 1; }
  // metronome-click volume 0..1.2 (1 = full/default; up to 1.2 = a 20% boost so the click can cut over a
  // loud exercise). Scales ONLY the overlay click in Playalongs / SR (see _metroClick), never the notes
  // and never the standalone Metronome tool.
  // NB: null/undefined (no stored value) => 1, NOT 0 — Number(null) is 0, so guard it explicitly.
  function _vol(v) { if (v == null) return 1; v = Number(v); return (isFinite(v) && v >= 0) ? clamp(v, 0, 1.5) : 1; }
  /* Normalise the per-sound level map. Absent/!isFinite => 1 (the tuned default), so an old saved blob
     with no `sounds` key at all, or one written before a voice existed, is exactly today's sound —
     this whole feature is additive. Unlike _mul, 0 is a MEANINGFUL value here (an effect sound turned
     off), so it can't share _mul's `v > 0` guard, which would silently read 0 back as 1. */
  /* ⚠️ THE NULL/UNDEFINED TRAP — this silenced the app for every new user (found + fixed 2026-08-02).
     The guard used to be `var v = o && o[k]; v = Number(v); if (v == null || !isFinite(v)) …`, which
     reads correctly but is wrong for exactly one input: null. `null && x` evaluates to null, and
     `Number(null)` is 0 — a finite number — so the fallback never fired and every level was clamped to
     its floor. `Number(undefined)` is NaN, so the undefined path worked and hid it.
     That mattered because `loadDynamics()` returns NULL when nothing is saved, and the constructor calls
     `setDynamics(RDMPlayer.loadDynamics())`. So on any device that had never opened Settings → Sound:
     stickLoud (the COUNT-OFF), rimshot, rim, stick and cross all came out 0 = SILENT, and click clamped
     to its 0.5 floor = every normal note at half volume.
     Test the RAW value for null/undefined before coercing. 0 stays meaningful — a user who deliberately
     saves 0 gets 0, which is the whole reason this can't reuse _mul's `v > 0` guard. */
  function _sounds(o) {
    var out = {}, R = RDMPlayer.SOUND_RANGE;
    RDMPlayer.SOUND_KEYS.forEach(function (k) {
      var r = R[k], raw = o ? o[k] : undefined, v = Number(raw);
      out[k] = (raw == null || !isFinite(v)) ? 1 : clamp(v, r.min, r.max);
    });
    return out;
  }
  // per-voice tone choice. Unknown / absent => "default" = the identity transform = today's sound.
  function _tones(o) {
    var out = {};
    RDMPlayer.SOUND_KEYS.forEach(function (k) {
      var v = o && o[k];
      out[k] = (v && RDMPlayer.TONES[v]) ? v : "default";
    });
    return out;
  }
  RDMPlayer.loadDynamics = function () {
    try {
      var raw = global.localStorage && global.localStorage.getItem(DYN_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === "object") ? o : null;
    } catch (e) { return null; }     // private mode / storage disabled → tuned defaults
  };
  RDMPlayer.saveDynamics = function (o) {
    var R = RDMPlayer.DYN_RANGE;
    var v = { tap: _mul(o && o.tap, R.tapMin, R.tapMax), accent: _mul(o && o.accent, R.accentMin, R.accentMax),
              metro: _vol(o && o.metro), sounds: _sounds(o && o.sounds), tones: _tones(o && o.tones),
              noDyn: !!(o && o.noDyn) };
    try { global.localStorage.setItem(DYN_KEY, JSON.stringify(v)); } catch (e) {}
    RDMPlayer._live.forEach(function (p) { p.setDynamics(v); });   // apply to already-mounted tools
    /* The NOTATION half of "dynamics off" (see setDynamics below). The renderer is a separate module
       with no reference to any player, so it is told directly, and the tools are told to redraw — a
       velocity change is inaudible until the next note, but a change to what is PRINTED has to repaint
       the sheet that is already on screen. */
    RDMPlayer.applyNoDynamics(v.noDyn);
    return v;
  };
  /* Push the flag to the renderer and ask every mounted tool to redraw. Separate from saveDynamics so the
     app can call it once at boot, before any player exists, and so a tool mounting later still starts in
     the right state (the renderer keeps the flag). */
  /* Just the RENDERER half, with no redraw and no fan-out. The constructor calls this so a tool mounting
     later starts in the saved state — without it, "dynamics off" survived a reload in the SOUND (each
     player reads storage in its constructor) but not on the PAGE, since the renderer is a separate module
     that nobody had told. */
  RDMPlayer.setRenderNoDynamics = function (on) {
    RDMPlayer.noDynamics = !!on;
    if (global.RDMRender && global.RDMRender.setNoDynamics) global.RDMRender.setNoDynamics(!!on);
  };
  RDMPlayer.applyNoDynamics = function (on) {
    on = !!on;
    RDMPlayer.setRenderNoDynamics(on);
    /* Repaint every sheet already on screen. Both tools draw through relayout(), so this covers
       Playalongs and the Lab without either tool needing to know the setting exists — and relayout is
       the right call rather than a bare _render(): removing the dynamics changes line spacing, so note
       x/y positions move, and relayout is what re-derives the loop highlight and repaints the playhead
       against the new layout. A player with nothing loaded returns immediately on its own. */
    RDMPlayer._live.forEach(function (p) {
      try { p.relayout(); } catch (e) { /* keep the last good sheet */ }
    });
    /* Still emitted, for anything drawing notation OUTSIDE a player — the Lab's rudiment tiles and its
       variation previews call RDMRender.render() directly on their own little stages. */
    try {
      global.dispatchEvent(new global.CustomEvent("rdm:nodynamics", { detail: { on: on } }));
    } catch (e) { /* no CustomEvent (very old webview) — the next natural render still picks it up */ }
  };
  RDMPlayer.noDynamics = false;
  // Apply (does NOT save — saveDynamics owns persistence and fans out to every live player).
  RDMPlayer.prototype.setDynamics = function (o) {
    var R = RDMPlayer.DYN_RANGE, d = this._dynDefaults;
    var t = _mul(o && o.tap, R.tapMin, R.tapMax), a = _mul(o && o.accent, R.accentMin, R.accentMax);
    this.DYN.ACCENT     = Math.min(1, d.ACCENT * a);
    /* Neither tap level may exceed the accent. TAP_NORMAL used to be exempt on the grounds that a
       no-accent piece has nothing to be quieter than — true in isolation, but it let a FLAT piece play
       far louder than an accented one (Taps 150 / Accents 50 gave 0.93 vs 0.43, and the audition made
       that sound broken). Capping keeps loudness consistent across a library. It costs nothing at the
       defaults, where TAP_NORMAL 0.62 already sits under ACCENT 0.85. (Anthony, 2026-07-21) */
    this.DYN.TAP        = Math.min(d.TAP * t, this.DYN.ACCENT);
    this.DYN.TAP_NORMAL = Math.min(1, d.TAP_NORMAL * t, this.DYN.ACCENT);
    this._dynMul = { tap: t, accent: a };
    // per-voice levels, read straight by _gainFor (keys ARE the timbre names, so no lookup table)
    this._soundMul = _sounds(o && o.sounds);
    this._toneSel = _tones(o && o.tones);
    // metronome-click volume (0..1): applied per click in _metroClick, so it live-updates the very next
    // click while a tool is playing. Never touches the master bus or the exercise notes.
    this._metroVol = _vol(o && o.metro);

    /* DYNAMICS OFF (a student's request via Anthony, 2026-08-07): ignore every written p/f/mf and every
       hairpin, in the sound AND on the page. ARTICULATION IS NOT A DYNAMIC — accents, marcato and tenuto
       are how a note is struck, not a passage instruction, so they keep working. Turning this on gives
       you the piece at one level with the accent pattern intact, which is what somebody drilling the
       sticking actually wants.

       Recompute right away when it changes: the per-note velocity scale is precomputed for the whole
       piece (see _computeDynamics), so without this the change would not be heard until the exercise was
       reloaded. Guarded on a real change so the common case (any other Sound setting moving) doesn't pay
       for a full recompute. */
    var wasOff = !!this.noDyn;
    this.noDyn = !!(o && o.noDyn);
    if (this.noDyn !== wasOff && this.perf && this.perf.length) {
      try { this._computeDynamics(); } catch (e) { /* a malformed piece must not break the setting */ }
    }
  };
  /* Short audition for the Settings sliders. ONE bar of 4/4 sixteenths, accent on each beat, using the
     engine's own voice + gain curve — so what you hear is literally what the tools will play.

     kind "flat" plays the same bar at TAP_NORMAL, the level a piece with NO accents in it uses. That is
     a SEPARATE button on purpose (Anthony, 2026-07-21): the two levels aren't comparable, and playing
     them back to back in one phrase read as a bug. At Taps 150 / Accents 50 the flat level is ~5x the
     accent level, which is correct — a flat piece has no accent to be quieter than — but hearing them
     one after the other looks broken. Returns its length in seconds.

     Start/stop, never stacked (Anthony, 2026-07-21). Two things make that work:
       • ONE reused player. A fresh one per press meant a fresh AudioContext per press, and browsers cap
         those at ~6 — spamming the button would eventually stop producing any sound at all.
       • Everything is scheduled through a single throwaway BUS gain node, so stopping is one disconnect
         and every already-queued click in the phrase dies with it. Oscillators can't be un-scheduled
         individually once started, which is why cutting the bus is the reliable way. */
  RDMPlayer.stopAudition = function () {
    var b = RDMPlayer._auditionBus;
    RDMPlayer._auditionBus = null;
    if (b) { try { b.disconnect(); } catch (e) {} }
  };
  RDMPlayer.auditionDynamics = function (o, kind) {
    RDMPlayer.stopAudition();                               // a second press replaces, never overlaps
    var p = RDMPlayer._auditionPlayer;
    if (!p) {
      p = RDMPlayer._auditionPlayer = new RDMPlayer(null, {});
      var li = RDMPlayer._live.indexOf(p);                  // not a mounted tool — keep it out of the registry
      if (li >= 0) RDMPlayer._live.splice(li, 1);
    }
    if (o) p.setDynamics(o);
    p._ensureAudio();
    var bus = p.actx.createGain();
    bus.connect(p._outBoost || p.actx.destination);        // through the same boost+limiter as playback
    p.master = bus;                                         // _click connects to this
    RDMPlayer._auditionBus = bus;
    var D = p.DYN, step = 0.16, N = 16, t = p.actx.currentTime + 0.08;   // 16 sixteenths = one 4/4 bar
    for (var i = 0; i < N; i++) {
      var vel = (kind === "flat") ? D.TAP_NORMAL : (i % 4 === 0 ? D.ACCENT : D.TAP);
      p._voiceClick("click", t + i * step, 650, p._gainFor("click", vel), 0.03);
    }
    return (t + N * step) - p.actx.currentTime;
  };
  /* Audition ONE voice, for the per-sound rows in Settings. Four evenly spaced hits of just that
     timbre, played through the real voice method (not a lookalike), so what you hear while dragging a
     row is exactly what an exercise will play. Shares stopAudition/_auditionBus with the phrase
     audition above, so pressing any audition anywhere replaces whatever was sounding.

     Each voice is played at the velocity it actually carries in a piece: the effect sounds have their
     own base velocities (a rimshot is not "an accent", it's a rimshot), and the count-off has its
     own on top of that — so a row previews its true in-context loudness, not a normalised one. */
  RDMPlayer.auditionSound = function (key, o) {
    RDMPlayer.stopAudition();
    var p = RDMPlayer._auditionPlayer;
    if (!p) {
      p = RDMPlayer._auditionPlayer = new RDMPlayer(null, {});
      var li = RDMPlayer._live.indexOf(p);
      if (li >= 0) RDMPlayer._live.splice(li, 1);
    }
    if (o) p.setDynamics(o);
    p._ensureAudio();
    var bus = p.actx.createGain();
    bus.connect(p._outBoost || p.actx.destination);
    p.master = bus;
    RDMPlayer._auditionBus = bus;
    var D = p.DYN, step = 0.30, N = 4, t = p.actx.currentTime + 0.08;
    for (var i = 0; i < N; i++) {
      var at = t + i * step;
      switch (key) {
        case "rimshot":   p._rimshot(at, D.RIMSHOT); break;
        case "rim":       p._rim(at, D.RIMSHOT); break;
        case "stick":     p._stickClick(at, D.STICK, false); break;
        case "cross":     p._crossStick(at, D.CROSS); break;
        case "stickLoud": p._stickClick(at, D.TAPOFF, true); break;
        // the normal note has an articulation ladder, so preview it as accent + three taps rather
        // than four identical hits — that IS what the voice sounds like in use
        default:          p._voiceClick("click", at, 650, p._gainFor("click", i === 0 ? D.ACCENT : D.TAP), 0.03); break;
      }
    }
    return (t + N * step) - p.actx.currentTime;
  };

  /* ---------- audio voice ---------- */
  /* ================= THE OUTPUT STAGE =================

     Built in ONE place and used by both the live context and renderOffline, because they have to match:
     a bounce that limits differently from the speakers is a bounce of a different app.

     WHY THIS IS NOT A DynamicsCompressor ANY MORE (Anthony, 2026-08-07: "the app just doesn't reach a
     loudness that I like... every other app I have is louder than this one").

     It was boost 1.6 -> compressor(-3 dB, 12:1, attack 3ms). A drum transient is over inside ONE
     millisecond, so a 3 ms attack lets the whole peak through untouched and then ducks the tail behind
     it — precisely backwards. Measured: pieces peaked at 0 dBFS (sometimes over) while their RMS sat at
     -28 to -33 dB. Peaks at the ceiling AND nothing left to give: the compressor was costing headroom
     without buying loudness.

     A WaveShaper has no attack time at all. It is a fixed input->output curve applied sample by sample,
     so it CANNOT overshoot, which means the drive in front of it can be pushed hard and the ceiling
     still holds exactly.

     THE CURVE PROTECTS RELATIVE VOLUME, which is the thing Anthony explicitly did not want moved. Below
     OUT_KNEE it is a straight line: every tap, tenuto and ordinary note is multiplied by OUT_DRIVE and
     by nothing else, so the whole articulation ladder is preserved bit for bit. Only what would have
     gone ABOVE the knee is bent, and only the top few dB of that. Peaks are not where loudness is heard;
     they are just what stops you turning it up. */
  RDMPlayer._clipCurve = function (drive, knee) {
    var key = drive + "/" + knee;
    if (RDMPlayer._curveCache && RDMPlayer._curveCache.key === key) return RDMPlayer._curveCache.curve;
    var N = 8192, c = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var x = (i / (N - 1)) * 2 - 1;              // -1 .. 1
      var u = Math.abs(x) * drive, y;
      if (u <= knee) y = u;                        // LINEAR: relative volumes untouched
      else y = knee + (1 - knee) * Math.tanh((u - knee) / (1 - knee));   // soft, and bounded by 1
      c[i] = (x < 0 ? -y : y);
    }
    RDMPlayer._curveCache = { key: key, curve: c };
    return c;
  };
  /* master (the play/stop MUTE envelope) -> drive -> shaper -> trim -> out.
     master.gain stays the mute: the loudness nodes live after it, so stop() still silences everything. */
  RDMPlayer.prototype._buildOutputChain = function (ctx) {
    var D = this.DYN;
    var master = ctx.createGain(); master.gain.value = 1;
    var boost = ctx.createGain(); boost.gain.value = D.OUT_DRIVE;
    var shaper = ctx.createWaveShaper();
    shaper.curve = RDMPlayer._clipCurve(D.OUT_DRIVE, D.OUT_KNEE);
    /* The drive is baked into the CURVE, not into `boost`, because a WaveShaper's curve always spans an
       input of -1..1 and anything past that is clamped to the endpoint — i.e. hard clipped. Shaping at
       unity input keeps the whole soft region reachable. `boost` therefore stays at 1 and exists only as
       the named handle other code already holds (_outBoost). */
    boost.gain.value = 1;
    shaper.oversample = "4x";     // the harmonics limiting makes must not alias back down as grit
    var trim = ctx.createGain(); trim.gain.value = D.OUT_TRIM;
    master.connect(boost); boost.connect(shaper); shaper.connect(trim); trim.connect(ctx.destination);
    return { master: master, boost: boost, shaper: shaper, trim: trim };
  };
  RDMPlayer.prototype._ensureAudio = function () {
    if (!this.actx) {
      this.actx = new (global.AudioContext || global.webkitAudioContext)();
      var chain = this._buildOutputChain(this.actx);
      this.master = chain.master;
      this._outBoost = chain.boost; this._limiter = chain.shaper; this._outTrim = chain.trim;
      /* The loop count-off cue gets its OWN bus. Its clicks are scheduled seconds ahead (the whole cue is
         committed up front), so stopping playback or clearing the loop mid-cue would otherwise leave the
         remaining clicks to fire on their own. A dedicated gain node lets _cancelCountOff() silence just
         the cue, instantly, without touching anything else. (Anthony, 2026-07-26) */
      this._coBus = this.actx.createGain(); this._coBus.gain.value = 1; this._coBus.connect(this.master);
    }
    if (this.actx.state === "suspended") this.actx.resume();
  };
  /* One struck note of a given VOICE, with that voice's chosen tone applied. Every note in the app
     goes through here rather than calling _click directly, so a tone can't be honoured in one place
     and forgotten in another (the buzz/diddle/flam sub-strokes are "click" notes too, and they have to
     follow the normal note's tone or a buzz would suddenly be a different instrument to the note next
     to it). `gain` is passed in already computed, because callers scale it in ways only they know
     about (buzz tails, diddle softening, the flam grace's fixed level). */
  RDMPlayer.prototype._voiceClick = function (timbre, time, freq, gain, dur, type) {
    var sel = this._toneSel && this._toneSel[timbre];
    var t = (sel && RDMPlayer.TONES[sel]) || RDMPlayer.TONES["default"];
    this._click(time, freq * t.f, gain, dur * t.d, t.w || type);
  };
  RDMPlayer.prototype._click = function (time, freq, gain, dur, type) {
    /* A gain of ZERO means this voice is silent — and exponentialRampToValueAtTime THROWS on a target of
       0 ("The float target value provided (0) should not be in the range..."), so silence has to be
       expressed by not scheduling the note at all, never by ramping to it.
       Reachable from ordinary use: Settings → Sound lets an effect voice be set to exactly 0 ("0 =
       genuinely off"), and _gainFor multiplies by that level, so every note of that voice would throw.
       A zero-velocity event does the same. The metronome click below already guarded this (`mv <= 0`);
       this per-note path did not. Threshold is the ramp's own 0.0001 floor — below it there is nothing
       to hear anyway. (Found 2026-08-02 while chasing why three playback tests all stalled: the throw
       was aborting the scheduler mid-flight, which froze the playhead.) */
    if (!(gain > 0.0001)) return;
    var o = this.actx.createOscillator(), g = this.actx.createGain();
    o.type = type || "square"; o.frequency.setValueAtTime(freq, time); o.connect(g).connect(this.master);
    g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(gain, time + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.start(time); o.stop(time + dur + 0.05);
  };
  // velocity (0..1) -> oscillator gain for a given timbre, via the tunable BASE_GAIN + GAMMA curve
  RDMPlayer.prototype._gainFor = function (timbre, vel) {
    var D = this.DYN, v = Math.max(0, Math.min(1, vel == null ? D.TAP : vel));
    // Settings → Sound per-voice level. Applied HERE because every voice (_click/_rimshot/_rim/
    // _stickClick/_crossStick and the audition) already funnels through this one function, so there is
    // exactly one place a level can be forgotten. Missing map / missing key => 1 = today's sound.
    var m = this._soundMul, mul = (m && m[timbre] != null) ? m[timbre] : 1;
    return (D.BASE_GAIN[timbre] || 0.5) * Math.pow(v, D.GAMMA) * mul;
  };
  /* THE LEVEL A PLAIN NOTE PLAYS AT, for one event.

     Two states, never a blend (see the section walk in _buildPlayback):
       ACCENT-TAP passage -> DYN.TAP, the quiet side of the contrast the accents exist to create
       FLAT passage      -> DYN.TAP_NORMAL, a full stroke, because there is nothing to be quiet against

     Per EVENT, not per piece. Etude 1 is flat for 27 of its 33 bars and accent-tap for the other 6;
     one number for the whole piece is wrong in both halves. */
  RDMPlayer.prototype._tapBaseFor = function (e) {
    return (e && e._flat) ? this.DYN.TAP_NORMAL : this.DYN.TAP;
  };
  /* The section level for one event — the written p/f/mf and any hairpin ramp, already merged into
     velScale by _computeDynamics, with flat music's deeper soft end applied on top. Every read of
     velScale at playback time goes through here so the two cannot drift apart. */
  RDMPlayer.prototype._dynScaleFor = function (e) {
    var s = (e && e.velScale != null) ? e.velScale : 1;
    var k = this.DYN.FLAT_DYN_POWER;
    /* NOT on a note a HAIRPIN shaped. This deepens a written dynamic; a ramp is a different animal —
       _computeDynamics already solved for an absolute target and set velScale to exactly want/artic, so
       raising that to a power lands the note somewhere the swell never asked for. Measured on Rhythm X
       bar 1: a crescendo designed to span 5.2 dB came out spanning 21.4 dB and starting at a whisper.
       The section level underneath a ramp is power-adjusted where the ramp is BUILT instead. */
    if (e && e._swellShaped) return s;
    // below 1 only: a swell can push velScale past 1 (SWELL_CEILING) and that ceiling is not a dynamic
    if (e && e._flat && k && k !== 1 && s > 0 && s < 1) s = Math.pow(s, k);
    return s;
  };
  /* A tenuto sits a fixed FRACTION of the way from the tap to the accent — "slightly above tap volume",
     and never at or above the accent, at any tap level. See DYN.TENUTO_FRAC. */
  RDMPlayer.prototype._tenutoVel = function (tapBase) {
    var D = this.DYN, acc = D.ACCENT;
    if (!(acc > tapBase)) return Math.min(1, tapBase);   // sliders can invert the pair; never go up past it
    return Math.min(1, tapBase + (acc - tapBase) * (D.TENUTO_FRAC != null ? D.TENUTO_FRAC : 0.25));
  };
  // velocity for one event from its articulation + notehead. tapBase comes from _tapBaseFor (the
  // section's flat / accent-tap state). Effect sounds carry their own base.
  RDMPlayer.prototype._articVel = function (e, tapBase) {
    var D = this.DYN;
    if (e.isTapoff) return D.TAPOFF;                                 // count-off — loud like an accent
    if (e.marcato) return D.MARCATO;                                 // ^ rooftop → rimshot, biggest hit
    if (e.head === "cross") return e.accent ? 1.0 : D.RIMSHOT;       // notated rimshot: loud by default
    if (e.head === "slashed") return D.CROSS;                        // cross-stick knock
    if (e.head === "x" && String(e.step).toLowerCase() === "d") return e.accent ? 1.0 : D.STICK;  // stick click / count-off
    // normal C-space notes AND plain-✕ rims follow the tap / tenuto / accent ladder
    if (e.accent) return D.ACCENT;
    if (e.tenuto) return this._tenutoVel(tapBase);
    /* A plain tap that follows a same-hand accent too fast to actually damp (see _buildPlayback) comes
       up to tenuto. Evaluated against the LIVE tempo, so this appears and disappears as the slider
       crosses the threshold rather than being baked in when the piece loaded. */
    if (e._accTapGap != null && this.tempo > 0 &&
        e._accTapGap * (60 / this.tempo) <= D.ACC_TAP_LIFT_SEC + 1e-9) {
      return this._tenutoVel(tapBase);
    }
    return tapBase;
  };
  // Section dynamics (p/f/mf) + hairpin ramps (cresc/decresc) → a velScale per event, usually 0..1 but a
  // crescendo target can briefly exceed 1 (up to SWELL_CEILING) — _hit() clamps the final applied
  // velocity, so that only lifts notes that started below the old ceiling (taps, tenuto); an
  // already-maxed marcato/rimshot is unaffected. Precomputed positionally, so it resets correctly on
  // every loop and follows a loop selection. (DYNAMICS-SPEC.md steps 3-4.)
  RDMPlayer.prototype._computeDynamics = function () {
    var perf = this.perf, D = this.DYN, rdm = this.rdm, n = perf.length, self = this;

    /* DYNAMICS OFF: one flat level for the whole piece. Everything this function produces is expressed
       through velScale (and swellSoft, which only shapes a hairpin's quiet end), so neutralising those
       two IS "no dynamics" — the articulation ladder in _hit (tap / tenuto / accent / marcato) is
       untouched and still plays. See setDynamics for why articulation is deliberately not included. */
    if (this.noDyn) {
      for (var z = 0; z < n; z++) { perf[z].velScale = D.DYN_DEFAULT; perf[z].swellSoft = false; }
      return;
    }
    // (a) section level per note from written p/f/mf marks (hairpins ignored here). "fp"/"sfp" are
    // COMPOUND marks — a loud attack that immediately drops — so DYNAMICS.fp/sfp (0.50) is the level for
    // what FOLLOWS, not the marked note itself: that note IS the forte/sforzando attack and must play at
    // full strength, same as a plain f/sf accent elsewhere (Anthony, 2026-07-18 — Mansfield 1-13 measure
    // 3's fp accent read quiet because the 0.50 was being applied to the attack too).
    var COMPOUND_ATTACK = { fp: "f", sfp: "sf" };
    var sectionAt = new Array(n), cur = D.DYN_DEFAULT;
    for (var i = 0; i < n; i++) {
      if (perf[i].dynamic) {
        var dynKey = String(perf[i].dynamic).toLowerCase(), ds = D.DYNAMICS[dynKey];
        if (ds != null) {
          var attackKey = COMPOUND_ATTACK[dynKey];
          if (attackKey) { sectionAt[i] = D.DYNAMICS[attackKey]; cur = ds; continue; }
          cur = ds;
        }
      }
      sectionAt[i] = cur;
    }
    // (b) map per-measure hairpins (measure-local event indices) to GLOBAL perf spans — one span per
    //     repeat instance. Each perf event carries m (source measure) + e (index within it); e === 0
    //     starts a bar instance. A hairpin spanning several measures arrives here as several consecutive
    //     same-type fragments (the converter emits one per measure it crosses) — the forward walk below
    //     chains them automatically since each new fragment starts from cur2, the level the previous one
    //     just ended on, so the swell reads as one continuous ramp across the barline.
    var hairpins = [], instStart = 0;
    for (var k = 1; k <= n; k++) {
      if (k === n || perf[k].e === 0) {
        var meas = rdm && rdm.measures && rdm.measures[perf[instStart].m];
        if (meas && meas.wedges) meas.wedges.forEach(function (w) {
          var F = -1, T = -1;
          for (var j = instStart; j < k; j++) { var pe = perf[j].e; if (pe >= w.from && pe <= w.to) { if (F < 0) F = j; T = j; } }
          // "Sense musical direction" (Anthony, 2026-07-19): the NOTATED wedge sometimes starts mid-phrase —
          // e.g. tenuto, plain, tenuto … leading into the wedge, with the printed hairpin drawn only partway
          // in. That leaves the tenuto(s) BEFORE the wedge at the flat running level, which can read LOUDER
          // than the ramp's own quiet start (the 1st tenuto louder than the 2nd — Rhythm X measure 16). Walk
          // backward from the wedge start and pull the ramp origin onto those SOFT lead-in notes.
          // STRICT (Anthony 2026-07-20): a crescendo lead-in is SOFT by definition, so it may only extend
          // across taps onto TENUTO notes. It must STOP at any accent / marcato / rest / written mark / loud
          // effect note — those are loud hits, NOT a soft lead-in. (Earlier it also accepted accents and so
          // latched onto a flam-accent right before a tap-started crescendo, making the first "tap" blast at
          // accent level — the whole swell started loud instead of soft.) Give up after 2 plain notes in a
          // row (a real gap). Crescendo only.
          if (F >= 0 && w.type === "crescendo" && !w.continued) {   // continuation fragments have no "start" to extend
            var lookback = 0, plainRun = 0;
            for (var bj = F - 1; bj >= instStart && lookback < 8; bj--, lookback++) {
              var be = perf[bj];
              if (be.rest || be.dynamic || be.accent || be.marcato) break;        // any loud/marked note ends the soft lead-in
              if (self._articVel(be, self._tapBaseFor(be)) > self._tenutoVel(D.TAP) + 0.001) break;  // louder than a tenuto → not a lead-in
              if (be.tenuto) { F = bj; plainRun = 0; }                            // only soft tenutos move the origin back
              else if (++plainRun >= 2) break;                                    // 2 plain notes = a gap, stop
            }
          }
          if (F >= 0) hairpins.push({ type: w.type, F: F, T: T, continued: !!w.continued });
        });
        instStart = k;
      }
    }
    // MERGE cross-barline hairpin fragments into ONE swell (Anthony, 2026-07-21). A hairpin that crosses a
    // barline is emitted by the converter as one fragment per measure, the later ones flagged `continued`.
    // Processing each fragment on its own restarts the ramp every bar (measures 10–11 of Mansfield 1-13 read
    // as TWO crescendos that both start soft, instead of ONE continuous build). Fold each `continued`
    // fragment into the fragment right before it (same type, adjacent in the perf stream) so the whole
    // multi-measure hairpin ramps once, start to finish. Iterates so a 3+ bar hairpin collapses fully.
    {
      var merged = [];
      for (var hi = 0; hi < hairpins.length; hi++) {
        var cur3 = hairpins[hi];
        var prev = merged.length ? merged[merged.length - 1] : null;
        if (prev && cur3.continued && cur3.type === prev.type && cur3.F <= prev.T + 1) {
          prev.T = cur3.T;   // extend the previous swell across the barline; keep its (extended) start
        } else {
          merged.push(cur3);
        }
      }
      hairpins = merged;
    }
    // (c) the WRITTEN dynamic that follows each hairpin — its end TARGET if that mark agrees with the
    //     wedge's direction (e.g. p ... cresc ... f). Start levels are resolved live in the walk below.
    //     Also flag whether the note the hairpin actually arrives at (its own last note, or the one right
    //     after) carries an accent/marcato — a written mark alone caps a bounded ramp at the PLAIN dynamic
    //     level, but "crescendo into an accent" should land harder than that (Anthony: hairpins into an
    //     accent should get louder, not just match the section's own bare loudness).
    hairpins.forEach(function (h) {
      h.after = (h.T + 1 < n) ? sectionAt[h.T + 1] : null;
      var atT = perf[h.T], atNext = perf[h.T + 1];
      h.targetAccented = !!((atT && (atT.accent || atT.marcato)) || (atNext && (atNext.accent || atNext.marcato)));
    });
    var byStart = {}; hairpins.forEach(function (h) { if (!byStart[h.F]) byStart[h.F] = h; });
    // (d) single forward walk. cur2 = the RUNNING level (written marks + each hairpin's end). Rules:
    //   • A hairpin STARTS from cur2, so a crescendo right after a decrescendo begins in the valley the
    //     decrescendo just left (measure 36 dim → measure 37 cresc) instead of snapping back to a mark.
    //   • A written dynamic INSIDE a hairpin re-anchors the ramp from that point — this is what makes a
    //     fortepiano work: "f  p  <cresc>" plays the f attack, DROPS to the p, then climbs from the p.
    //   • A hairpin only ever moves in its own direction: it ends on the following written mark ONLY when
    //     that mark agrees (louder for cresc, softer for decresc); a contradicting mark is a subito change
    //     applied AFTER the hairpin, so we swell relatively instead of reversing direction.
    function endLevel(type, from, after, targetAccented) {
      // BOUNDED hairpin (a written p/f/mf mark follows and agrees with the direction): ramp leads ALL THE
      // WAY to that mark's exact level — `after` IS the target note's dynamic, used verbatim, no partial
      // swell math. (Anthony: hairpins should fully reach the target note's dynamic, not fall short of it.)
      // EXCEPTION: if the arrival note itself is accented/marcato, the plain written mark isn't the real
      // ceiling — an accent should read louder than a bare note at the same dynamic, so push the ramp on
      // to SWELL_CEILING (same "true extreme" the unbounded case below uses) instead of stopping at the
      // mark. (Anthony: a crescendo leading into an accent should get louder, not just match the mark.)
      if (type === "crescendo" && after != null && after > from) return targetAccented ? Math.max(after, D.SWELL_CEILING) : after;
      if (type === "diminuendo" && after != null && after < from) return targetAccented ? Math.min(after, D.SWELL_FLOOR) : after;
      // UNBOUNDED hairpin (no written mark to aim at, or a following mark that contradicts the direction):
      // there's no explicit target note, so "all the way" means the true extreme — SWELL_CEILING /
      // SWELL_FLOOR — rather than the old partial relative bump (from + SWELL). This also fully resolves
      // the "starts already at full, has nowhere to climb" case (SWELL_CEILING is a fixed ceiling above 1).
      return type === "crescendo" ? D.SWELL_CEILING : D.SWELL_FLOOR;
    }
    var active = null, cur2 = D.DYN_DEFAULT;
    for (var x = 0; x < n; x++) {
      var wrote = false, attackScale = null;
      if (perf[x].dynamic) {
        var dynKey2 = String(perf[x].dynamic).toLowerCase(), d2 = D.DYNAMICS[dynKey2];
        if (d2 != null) {
          // same "fp"/"sfp" compound-attack carve-out as pass (a) above — this loop computes the REAL
          // final velScale, and has its own independent cur2/dynamic reading, so it needs the same fix.
          var attackKey2 = COMPOUND_ATTACK[dynKey2];
          if (attackKey2) attackScale = D.DYNAMICS[attackKey2];
          cur2 = d2; wrote = true;
        }
      }
      if (byStart[x]) active = byStart[x];
      // (re-)anchor the ramp origin: at the hairpin's own start, or wherever a written mark lands inside it.
      if (active && (byStart[x] || (wrote && x > active.F && x <= active.T))) {
        active.rampF = x;
        // End target FIRST from the ORIGINAL running level (cur2), so the bounded/unbounded direction
        // decision in endLevel is unchanged. Then pull the START for contrast: a crescendo starts soft, a
        // diminuendo starts loud — clamped so it never inverts past the end (a crescendo whose target is
        // already very soft, etc.). This is what gives the swell its "start soft → build to target" shape.
        active.baseLevel = cur2;   // pre-swell running level, to revert to after an UNbounded crescendo
        // BOUNDED = a written mark follows AND agrees with the swell's direction (so the section genuinely
        // moves to that mark). Everything else is an unbounded momentary swell.
        active.bounded = (active.type === "crescendo")  ? (active.after != null && active.after > cur2)
                       : (active.type === "diminuendo") ? (active.after != null && active.after < cur2)
                       : false;
        active.end = endLevel(active.type, cur2, active.after, active.targetAccented);
        // A crescendo starts RIGHT WHERE THE MUSIC ALREADY IS and only goes up — no dip below the running
        // level (Anthony, 2026-07-19: "there shouldn't be a dip down for crescendos where they start, that
        // goes against the dynamics; they just go up from where they start"). Clamp so it can't invert past
        // the end. A diminuendo still starts loud (its own contrast direction is DOWN, so a raised start is
        // correct there).
        if (active.type === "crescendo")      active.start = Math.min(cur2, active.end);
        else if (active.type === "diminuendo") active.start = Math.max(Math.max(cur2, D.SWELL_LOUD_START), active.end);
        else active.start = cur2;
      }
      if (active && x >= active.F && x <= active.T) {
        var span = active.T - active.rampF, frac = span > 0 ? (x - active.rampF) / span : 1;
        var eased = Math.pow(frac, D.SWELL_EASE_POWER);   // back-load the climb toward the target note
        perf[x].velScale = active.start + (active.end - active.start) * eased;
        // Soft end of a swell = the quiet extreme: the START (ramp origin) of a crescendo, or the END of
        // a diminuendo. Flag it so _hit can tame a written accent that lands there — a loud accent at the
        // soft end of a hairpin shouldn't blow out the quiet part of the swell. (Anthony.)
        if ((active.type === "crescendo" && x === active.rampF) ||
            (active.type === "diminuendo" && x === active.T)) perf[x].swellSoft = true;
        // a compound fp/sfp mark's own note is always its loud attack, never the ramp's interpolated
        // value, even on the rare piece where the mark itself opens a hairpin.
        if (attackScale != null) perf[x].velScale = attackScale;
        if (x === active.T) {
          // Update the persistent section level as the swell ends. A BOUNDED swell moves the section to
          // its written target. An UNbounded crescendo is only a momentary bulge up to the ceiling (which
          // sits ABOVE 1.0 on purpose, to lift the ramp) — it must NOT pin the section up there, or every
          // later note blares and the next crescendo has zero headroom to climb (Anthony, 2026-07-19: the
          // dip-removal exposed this — a piece's crescendos were ratcheting the whole thing to the ceiling
          // and staying). Revert to the pre-swell level. An unbounded diminuendo legitimately leaves it soft.
          cur2 = active.bounded ? active.after : (active.type === "crescendo" ? active.baseLevel : active.end);
          active = null;
        }
      } else {
        perf[x].velScale = attackScale != null ? attackScale : cur2;
      }
    }
    // Patch-up pass: the accented arrival note sits at h.T+1, OUTSIDE the hairpin's own [F,T] span (the
    // ramp above only interpolates through T). When that note carries its OWN written mark (the common
    // "cresc. ... f>" case), the main walk's mark-handling at its OWN iteration unconditionally resets
    // cur2 to the PLAIN mark value — silently erasing the boosted endLevel() we just computed for it one
    // step earlier. Re-apply the boost directly now that the walk is done and can't undo it again.
    // (`h` and `active` share the same object reference throughout, so h.end already holds the boosted
    // value computed above — no need to recompute it here.)
    hairpins.forEach(function (h) {
      if (!h.targetAccented || h.end == null) return;
      var t = h.T + 1;
      if (t >= n) return;
      if (h.type === "crescendo") {
        perf[t].velScale = Math.max(perf[t].velScale, h.end);
      } else if (!perf[t].dynamic) {
        // Diminuendo: only pull the accented arrival down when it has NO written mark of its own. A
        // dim that lands on a note carrying its own LOUDER mark ("dim ... f>") is a SUBITO — the fade
        // covers the notes before the mark, and the mark's note plays at ITS level. Clamping it to the
        // dim's floor played Etude 5 m30's f-accented beat-4 downbeat at 0.30, under a plain tap
        // (Anthony, 2026-07-23: "the downbeat of beat 4 m30 should be a forte accent volume").
        perf[t].velScale = Math.min(perf[t].velScale, h.end);
      }
    });

    // ---- Crescendo shape: build the TAP BASELINE up, keeping accent/tap contrast (Anthony, 2026-07-19/20/21) ----
    // A crescendo must KEEP accent↔tap contrast — accents stay loud, taps stay soft — while the run of taps
    // leading into the target still swells so the LAST few taps get loud (Anthony: "maintain accent tap
    // contrast, accents loud taps soft; but the last couple non-accented notes into the target can be loud").
    // So we do NOT flatten every note onto one curve (that killed the accents). Instead we ramp the
    // BASELINE (what a plain tap plays at) from soft up to near the target, and apply it as ONE shared
    // MULTIPLIER: taps sit ON the baseline (soft early → loud late), while accents ride the same multiplier
    // and stay proportionally louder (clamped at full by _hit). Result: early swell = soft taps + loud
    // accents (full contrast); late swell = the taps come up loud into the target; the target is the peak.
    // Back-loaded (SWELL_EASE_POWER) so the taps only really open up in the last stretch (bell curve).
    //
    // TARGET DETECTION: a hairpin is often drawn a note or two SHORT of the accent it points into, or ends
    // right ON the accent/marcato climax. So: if it ends ON an accent/marcato, THAT's the target; else look
    // a note or two past it for the accent; else the plain note right after is the arrival.
    var self2 = this, D2 = D, nP = perf.length;
    function _artic(idx) { return self2._articVel(perf[idx], self2._tapBaseFor(perf[idx])); }
    function _finalVel(idx) { return Math.max(0, Math.min(1, _artic(idx) * self2._dynScaleFor(perf[idx]))); }
    function _isAcc(idx) { var e = perf[idx]; return !!(e && !e.rest && (e.accent || e.marcato)); }
    hairpins.forEach(function (h) {
      if (h.type !== "crescendo" || h.rampF == null) return;
      var F = h.rampF, wto = h.T;
      var target;
      if (_isAcc(wto)) target = wto;                                  // hairpin ends ON the climax accent
      else {
        target = -1;
        for (var s = wto + 1; s <= wto + 2 && s < nP; s++) {          // else the accent it points into, just past the end
          if (perf[s].rest) break;                                    // a rest ends the phrase
          if (_isAcc(s)) { target = s; break; }                       // the accent it arrives at — a forte DOWNBEAT counts too,
                                                                      // even across a barline (m9-m10 crescendo → m11's f accent).
                                                                      // Test _isAcc BEFORE the dynamic break: that accent usually
                                                                      // carries its own f/sf mark, and breaking on it first hid it.
          if (perf[s].dynamic) break;                                 // a PLAIN note with a new (subito) mark = don't cross into it
        }
        if (target < 0) target = (wto + 1 < nP) ? wto + 1 : wto;      // else the plain arrival note
      }
      var rampEnd = target - 1;
      if (rampEnd < F) { rampEnd = F - 1; }                           // target IS the first note → nothing to ramp, just peak it
      // Peak loudness (the target), never below MIN_CRESC_PEAK so a plain-note arrival still builds. This is
      // the CLIMAX — every ramp note is held strictly below it so the target is the unique loudest hit.
      var endLoud = Math.max(_finalVel(target), D2.MIN_CRESC_PEAK);
      // Two separate envelopes, both back-loaded (open soft, rush up into the arrival), both ending BELOW the
      // target so it stays the peak. A single shared multiplier can't do this: swelling the quiet taps up to
      // near-target needs a big (2-4x) multiplier, and that same multiplier blasts any accent straight past
      // the clamp to full LONG before the target (an accent mid-swell ended up as loud as the climax). So we
      // drive each note's FINAL velocity directly: accents ride the loud layer (soft accent -> just under the
      // target), taps ride the quiet layer underneath (very soft -> loud-but-under-the-accents). Early accents
      // stay soft, the last accents build, and the target is never beaten. (Anthony, 2026-07-21.)
      var accFloor = endLoud * D2.SWELL_ACC_START;
      var accCeil  = endLoud * D2.SWELL_ACC_END;
      // The tap layer starts AT the running level and only goes UP — no dip below where the music already is
      // (Anthony: "there shouldn't be a dip down for crescendos where they start; they just go up from where
      // they start"). Pulling it under the running level made a tenuto at the swell's start (its tap*1.4) fall
      // BELOW the plain taps just before the swell, so the tenuto stopped reading as emphasized (Rhythm X m16).
      // Accents/tenuto get their softness from their OWN floors below, not from a dipped tap floor.
      /* The section level the ramp sits on, deepened for flat music the same way _dynScaleFor would
         have — because for these notes it no longer will. One place decides how deep a written soft goes
         in flat music; for anything under a hairpin, this is that place. */
      var startEv = perf[h.rampF];
      var floorLevel = (h.baseLevel != null ? h.baseLevel : D2.DYN_DEFAULT);
      if (startEv && startEv._flat && D2.FLAT_DYN_POWER && floorLevel > 0 && floorLevel < 1) {
        floorLevel = Math.pow(floorLevel, D2.FLAT_DYN_POWER);
      }
      var tapFloor = Math.max(0, Math.min(1, self2._tapBaseFor(startEv) * floorLevel));
      // Case-by-case tap ceiling: if the ramp has ANY accent/marcato in it, those carry the swell and the taps
      // stay in their contrast role (don't get loud); if it's all taps, the taps ARE the swell and build fully.
      // (Anthony, 2026-07-21: image 1 has accents around the taps → taps shouldn't get so loud; image 2 has no
      // accents → taps take on the "get loud" role.)
      var rampHasAccent = false;
      for (var ai = F; ai <= rampEnd; ai++) { if (perf[ai] && !perf[ai].rest && (perf[ai].accent || perf[ai].marcato)) { rampHasAccent = true; break; } }
      var tapReach = endLoud * (rampHasAccent ? D2.SWELL_TAP_END_CONTRAST : D2.SWELL_TAP_END);
      /* NO ROOM TO CLIMB -> START LOWER (Anthony, 2026-08-07: "why does the 1st crescendo start so
         loud in this piece?").

         The rule above — start where the music already is and only go up — assumes there IS somewhere
         up to go. In FLAT music there is not: a flat passage plays at 0.72, the same as an accent, so
         the floor lands on the ceiling and the ramp comes out perfectly level. Measured on Rhythm X bar
         1 before this: every velScale in the hairpin was exactly 1.000. The crescendo was drawn on the
         page and did nothing, which is heard as "it starts loud" — it never starts soft at all.

         So when the reach does not clear the floor, the hairpin arrives exactly where the music sits
         and STARTS under it instead. That is the only way to express a crescendo you are already at the
         top of, and it is what a drummer reading it would do. The 2026-07-21 no-dip case is untouched:
         it only applies where tapReach already clears the floor, which is every accent-tap ramp. */
      if (tapReach <= tapFloor * 1.02) {
        tapReach = tapFloor;                                          // arrive where the music already is
        /* START AT THE TAP LEVEL — the quiet end of the ladder — not at a fraction of wherever this
           passage happens to rest (Anthony, 2026-08-07: "the 5let crescendo in measure 12 sounds good
           but not in the beginning").

           Both bars of Rhythm X are the same figure under the same hairpin, and bar 12 is the one his
           ear likes. It is ACCENT-TAP music, so its ramp already began at DYN.TAP (0.245) — there was
           room to climb, so the no-dip rule left the floor alone. Bar 1 is FLAT music, and starting it
           at a fraction of the flat level put it at 0.396, a full 4.2 dB hotter. Same written
           crescendo, two different starting volumes, purely because of how the bar was classified.

           A crescendo starts soft, and "soft" for a drummer is a low stick height — a tap — whatever
           the passage around it rests at. Using DYN.TAP directly makes the two bars start on the same
           number and needs no separate constant. Accent-tap ramps are untouched: their floor was
           already DYN.TAP x level, so this is the same value they had. */
        tapFloor = Math.max(0, Math.min(tapFloor, D2.TAP * floorLevel));
      }
      var tapCeil  = Math.max(tapFloor, tapReach);
      var denom = target - F;
      for (var x = F; x <= rampEnd; x++) {
        var frac = Math.pow((x - F) / (denom || 1), D2.SWELL_EASE_POWER);  // back-load the climb toward the target
        var av = _artic(x);                                          // this note's own articulation velocity (accent 0.85 / tap 0.22 / ...)
        var ex = perf[x];
        var accWant = accFloor + (accCeil - accFloor) * frac;        // the loud (accent) layer at this position
        var tapWant = tapFloor + (tapCeil - tapFloor) * frac;        // the quiet (tap) layer at this position
        var want;
        if (ex.accent || ex.marcato) want = accWant;
        // a TENUTO is a lightly emphasized tap, not a plain one: keep it a notch ABOVE the tap layer (its own
        // tap*1.4 relationship) so it still reads louder than the taps around it inside the swell, but hold it
        // UNDER the accent layer so the accent/tenuto/tap ladder survives. (Anthony, 2026-07-21: the 1st tenuto
        // in Rhythm X m16 stopped being louder than its neighbor taps once taps+tenuto shared one flat layer.)
        else if (ex.tenuto)          want = Math.min(tapWant + (accWant - tapWant) * (D2.TENUTO_FRAC != null ? D2.TENUTO_FRAC : 0.25), accWant);
        else                         want = tapWant;
        want = Math.min(want, endLoud);                              // hard invariant: nothing in the swell beats the target
        perf[x].velScale = av > 0 ? (want / av) : 1;                 // set the final velocity exactly to `want`
        perf[x]._swellShaped = true;                                 // absolute already — see _dynScaleFor
        perf[x].swellSoft = false;
      }
      // Make the TARGET actually reach endLoud (boosts a plain arrival to the crescendo's peak; an accent
      // already sits at/above it so max() never softens it).
      var tav = _artic(target);
      if (tav > 0) perf[target].velScale = Math.max(perf[target].velScale != null ? perf[target].velScale : 1, endLoud / tav);
      perf[target].swellSoft = false;
    });
  };
  RDMPlayer.prototype._hit = function (e, time, startBeat) {
    if (e.rest) return;
    var vel = this._articVel(e, this._tapBaseFor(e));                             // base velocity from the note's articulation
    // section dynamics (p/f/mf) + later hairpins scale the passage; the count-off is a fixed cue, exempt.
    if (e.velScale != null && !e.isTapoff) vel = Math.max(0, Math.min(1, vel * this._dynScaleFor(e)));
    // Tame an accent/marcato sitting at the soft end of a swell (cresc start / dim end) so it doesn't
    // spike above the quiet part of the hairpin. Mirrors the accented-diddle softening below. (Anthony.)
    if (e.swellSoft && (e.accent || e.marcato)) vel *= 0.7;
    // Real elapsed seconds for `nb` beats from the note's onset, honoring the tempo map (so roll/buzz
    // sub-strokes stay in time through tempo changes instead of using a fixed base-tempo spacing). Falls
    // back to constant base tempo when the note's beat isn't known (e.g. a preview hit).
    var self = this;
    function spanTime(nb) {
      if (startBeat != null) return self._timeForBeat(startBeat + nb) - self._timeForBeat(startBeat);
      return nb * (60 / self.tempo);
    }
    /* Grace-note ornament — flam (1 grace) or ruff/drag (2+, a crushed diddle on the opposite hand).
       Every stroke is at a FIXED level just below a normal tap, NOT scaled off the main note's velocity
       — otherwise an accented flam blasted a loud grace (Anthony, 2026-07-25: "grace notes shouldn't be
       so loud, just barely below tap level"). One level for all of them also keeps a ruff's pair EVEN,
       which is the whole point: a diddle, not a ramp into the beat.

       e.flam stays the gate, because it is the only thing some producers set — the SR Lab generator and
       Playalongs/stickings.js both emit `flam: true, graces: null` — so the flag alone must keep working.
       e.graces (carried through by _buildPlayback when the source gave one) only supplies the COUNT:
       1 = flam, 2 = ruff/drag, 3 = the rare triple. Missing/empty falls back to 1, so no producer that
       never learned about graces can regress.

       Layout: the LAST grace sits GRACE_LEAD ahead of the principal and the earlier ones stack backwards
       by GRACE_SPACING, so the ornament crowds in AHEAD of the beat and the principal still lands exactly
       on time. With one grace the loop runs once at `time - GRACE_LEAD - 0`, i.e. the identical
       `time - 0.013` this line has always scheduled.

       An ornament reaches BACKWARDS in time, so on the piece's very first note it can land before zero —
       and AudioParam.setValueAtTime throws outright on a negative time ("Time must be a finite
       non-negative number: -0.013"), which aborts the whole scheduling pass. Live playback never sees
       this (notes are always committed a scheduler horizon into the future), but renderOffline() — the
       pre-rendered bounce iOS needs for background playback — starts its clock at 0, so ANY piece whose
       first note carries a flam crashed the bounce outright. Confirmed against the catalog: "Flams -
       Flam Taps - Threes.musicxml" opens on a flam and dev/render-test.js died on it. Dropping the
       out-of-range strokes costs at most the graces on the first note of a bounce (which loops away
       within one pass) and cannot touch any grace that schedules today, since every one of those is
       already >= 0. Found 2026-08-02 while widening this from one grace to a ruff's two — the reach
       backwards doubled, so the window this bites in grew with it. */
    if (e.flam) {
      var GD = this.DYN, gN = (e.graces && e.graces.length) || 1;
      var gGain = this._gainFor("click", GD.TAP) * 0.9;
      // one grace = a flam, and it keeps GRACE_LEAD exactly. Two or more = a ruff/drag, which is spaced
      // EVENLY at GRACE_SPACING all the way into the principal (see the DYN comment) — mixing the two
      // constants inside one ornament is what used to make it uneven.
      var gStep = gN > 1 ? GD.GRACE_SPACING : GD.GRACE_LEAD;
      for (var gi = 0; gi < gN; gi++) {
        var gT = time - (gN - gi) * gStep;
        if (gT >= 0) this._voiceClick("click", gT, 650, gGain, 0.03);
      }
    }
    if (e.buzz) {                                            // press/buzz roll: dense multiple bounces
      // sped-up-past-the-piece's-own-tempo ratio (1 at written tempo, up to BUZZ_TEMPO_RATIO_MAX at the
      // slider's fastest) — buzzes shorten + quiet down as the user pushes past the piece's normal speed,
      // but sound exactly as before at (or below) the tempo it was written at.
      var D = this.DYN;
      var buzzR = Math.max(1, Math.min(D.BUZZ_TEMPO_RATIO_MAX, this.tempo / (this.originalTempo || this.tempo)));
      var buzzF = (buzzR - 1) / (D.BUZZ_TEMPO_RATIO_MAX - 1);   // 0 at written tempo .. 1 at the fastest allowed
      var spanMult = D.BUZZ_SPAN_MULT_SLOW + (D.BUZZ_SPAN_MULT_FAST - D.BUZZ_SPAN_MULT_SLOW) * buzzF;
      var gainMult = D.BUZZ_GAIN_MULT_SLOW + (D.BUZZ_GAIN_MULT_FAST - D.BUZZ_GAIN_MULT_SLOW) * buzzF;
      var bspan = spanTime(e.beats || 0.5) * spanMult;        // a buzz rings just shy of the full value (tighter)
      if (e._buzzAdjacentNext) bspan *= D.BUZZ_ADJACENT_SPAN_MULT;   // extra room so it doesn't blur into the next buzz
      if (e.staccato) bspan *= D.BUZZ_STACCATO_SPAN_MULT;    // a staccato buzz is the SHORTEST tier — a clipped press
      var n = Math.max(4, Math.round(bspan / 0.022));        // ~45 bounces/sec, sustained texture
      // _buzzVelEff (precomputed in _buildPlayback) eases a loud->soft DROP across a run of back-to-back
      // buzzes so accent-buzz -> tap-buzz doesn't snap straight down; use it in place of the raw vel when set.
      var buzzVel = e._buzzVelEff != null ? e._buzzVelEff : vel;
      // Lift the quiet end only — see BUZZ_QUIET_KNEE. Tapers to zero at the knee, so loud buzzes are
      // bit-for-bit what they were.
      var qk = D.BUZZ_QUIET_KNEE, ql = D.BUZZ_QUIET_LIFT;
      if (qk > 0 && ql > 0 && buzzVel < qk) buzzVel = Math.min(1, buzzVel + ql * (1 - buzzVel / qk));
      var bg = this._gainFor("click", buzzVel) * gainMult;  // buzzes ride softer than struck notes (it's a texture)
      // A staccato buzz has fewer bounces (short bspan) than a full-length one, so at the SAME per-bounce
      // gain it reads thinner/quieter overall. Nudge it up a hair (Anthony: staccato buzzes a bit too quiet).
      if (e.staccato) bg *= D.BUZZ_STACCATO_GAIN_BOOST;
      // BUZZ_ONSET_DELAY nudges the felt attack a hair later so it doesn't jump the beat (tune by ear).
      var t0 = time + D.BUZZ_ONSET_DELAY;
      // Taper the last ~40% of the bounce train down to a soft floor so the buzz sounds like it FINISHES/
      // decays instead of stopping flat mid-texture (Anthony: staccato buzzes read as "cut off"). The
      // shortened span keeps it short; the fade just softens the tail. Applies to all buzzes (natural
      // release); tune the tailStart / floor by ear.
      var tailStart = 0.6, floor = 0.14, last = n > 1 ? n - 1 : 1;
      var decayEnd = D.BUZZ_DECAY_END != null ? D.BUZZ_DECAY_END : 1;
      for (var b = 0; b < n; b++) {
        var fr = b / last;
        var env = fr <= tailStart ? 1 : Math.max(floor, 1 - (fr - tailStart) / (1 - tailStart) * (1 - floor));
        // the bounce train loses a little energy as it goes (10 -> 8.25), THEN the tail fade releases it
        env *= 1 - (1 - decayEnd) * fr;
        this._voiceClick("click", t0 + b * (bspan / n), 650, bg * env, 0.03);
      }
      return;
    }
    if (e.roll >= 1) {
      var beats = e.beats || 0.5, strokes = Math.pow(2, e.roll),
          g = this._gainFor("click", vel) * 0.9 * ((e.accent || e.marcato) ? 0.82 : 1);   // accented diddles noticeably softer
      for (var k = 0; k < strokes; k++) this._voiceClick("click", time + spanTime(beats * k / strokes), 650, g, 0.02);
      return;
    }
    /* DOUBLE STOP — a printed "B" sticking: both hands land on the head at once.

       All this does is play what is WRITTEN, together and a little bigger. Every notehead speaks, so
       the double stop written as a shot in one hand and a normal note in the other (Genesis Part Two,
       displayed bars 65 and 90) sounds as a rimshot AND a note instead of only the first of the two.

       It briefly had an invented low "boom" layer under it and Anthony did not like it (2026-08-07:
       "remove any EQ change you did"). No added timbre now — see _doubleStop. */
    if (e.stick1 === "B" || e.stick2 === "B") { this._doubleStop(e, time, vel); return; }
    this._strike(e.head, e.step, time, vel, e.isTapoff);
  };
  /* One notehead -> one sound (RDM snare scheme; all snare music sits on the C space). Split out of _hit
     so a double stop can route each of its noteheads through the identical rules. */
  RDMPlayer.prototype._strike = function (head, step, time, vel, isTapoff) {
    // rimshot: only the ornate ✕ ("cross") head. A rooftop (^) marcato on a NORMAL head is just a loud
    // regular note (its marcato velocity already makes it the biggest hit) — not a shot.
    if (head === "cross") { this._rimshot(time, vel); return; }
    // cross-stick: slashed notehead — a woody, hollow knock.
    if (head === "slashed") { this._crossStick(time, vel); return; }
    // plain ✕ head: on the D line = stick click (also the count-off); on a space (E/C/A) = rim.
    if (head === "x") {
      if (String(step).toLowerCase() === "d") { this._stickClick(time, vel, isTapoff); return; }
      this._rim(time, vel); return;
    }
    // normal note on the C space: tap / tenuto / accent — same timbre, velocity sets the volume.
    this._voiceClick("click", time, 650, this._gainFor("click", vel), 0.03);
  };
  RDMPlayer.prototype._doubleStop = function (e, time, vel) {
    var D = this.DYN;
    var v = Math.min(1, vel * (D.DS_VEL_MULT != null ? D.DS_VEL_MULT : 1));
    /* The hands, in writing order. TWO noteheads = the hands are notated as separate sounds (a shot in
       one, a normal note in the other), so both have to speak.

       ONE notehead = the B stands in for both hands playing the SAME sound — and that fires ONCE, not
       twice. Two identical strokes at the same instant are not two events, they are one wave at 1.88x
       amplitude: +5.5 dB, far more than two sticks on a head actually give you, and it clipped. The
       "two sticks weigh more" part is DS_VEL_MULT above, which clamps at 1 like every other velocity.
       (This mattered only once DS_SPREAD went to 0 — 4 ms apart they did not sum coherently.) */
    var heads = (e.heads && e.heads.length > 1) ? e.heads : [{ head: e.head, step: e.step }];
    this._strike(heads[0].head, heads[0].step, time, v, e.isTapoff);
    for (var i = 1; i < heads.length; i++) {
      /* The second stick a hair late and a hair down. Both numbers are small on purpose: any bigger and
         it stops being a double stop and starts being a flam. */
      this._strike(heads[i].head, heads[i].step, time + (D.DS_SPREAD || 0), v * (D.DS_SECOND_MULT != null ? D.DS_SECOND_MULT : 1), e.isTapoff);
    }
    /* NO ADDED LOW LAYER. There was a 180 Hz "boom" under this for a few hours (Anthony, 2026-08-07:
       "I don't like the double stop sound, remove any EQ change you did"). A double stop is now nothing
       but the notes that are written, played together and slightly bigger — no invented timbre. */
  };
  // rimshot — brassy sawtooth; the biggest, most distinct hit
  RDMPlayer.prototype._rimshot = function (time, vel) {
    this._voiceClick("rimshot", time, 800, this._gainFor("rimshot", vel), 0.045, "sawtooth");
  };
  // rim (plain ✕ on a space) — sharp, high metallic tick
  RDMPlayer.prototype._rim = function (time, vel) {
    this._voiceClick("rim", time, 1900, this._gainFor("rim", vel), 0.014);
  };
  // stick click (plain ✕ on the D line) — rounder + metronomic, clearly not the rim. The count-off
  // (loud) renders on the higher "stickLoud" ceiling so the tap-off cuts through like an accent.
  RDMPlayer.prototype._stickClick = function (time, vel, loud) {
    var k = loud ? "stickLoud" : "stick";
    this._voiceClick(k, time, 2000, this._gainFor(k, vel), 0.030, "triangle");
  };
  // cross-stick (slashed head) — low, woody, hollow knock
  RDMPlayer.prototype._crossStick = function (time, vel) {
    this._voiceClick("cross", time, 1200, this._gainFor("cross", vel), 0.020);
  };
  RDMPlayer.prototype._metroClick = function (time, down) {
    var mv = (this._metroVol != null ? this._metroVol : 1);   // Settings > Sound "Metronome" volume (1 = full)
    if (mv <= 0) return;                                       // slider at 0 = no click at all
    var o = this.actx.createOscillator(), g = this.actx.createGain();
    o.type = "triangle"; o.frequency.setValueAtTime(down ? 2000 : 1400, time); o.connect(g).connect(this.master);
    // Attack MUST match the note _click ramp (time + 0.005) so the metro transient peaks at the same
    // instant as the notes — a shorter ramp made the click sit ~3ms ahead of the count-off stick clicks.
    g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime((down ? 0.32 : 0.14) * mv, time + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.start(time); o.stop(time + 0.09);
  };
  // ---- Relative tempo map (feature B) ----
  // ratio(beat) = tempo(beat) / base tempo. The clock integrates 1/ratio (in "base-beat" units), so a
  // 0.5 section takes twice as long per beat and the slider just scales the base. _mapI(beat) is that
  // integral ∫₀^beat 1/ratio db — call it "I". Single-tempo pieces have no map → I is the identity, so
  // the clock stays exactly linear (unchanged). The map repeats per full-piece loop (fold by totalBeats).
  RDMPlayer.prototype._buildTempoMap = function () {
    this._tempoSegs = null; this._tempoTotalI = this.totalBeats;
    var total = this.totalBeats;
    if (!total || !this.rdm || !this.rdm.measures || !this.measures) return;
    var self = this;
    // shortest note (in beats) anywhere in a source measure — its fastest subdivision
    function shortestBeats(srcIdx) {
      var mn = Infinity, perf = self.perf;
      if (!perf) return null;
      for (var j = 0; j < perf.length; j++) { var e = perf[j]; if (e.m === srcIdx && !e.rest && e.beats > 0 && e.beats < mn) mn = e.beats; }
      return isFinite(mn) ? mn : null;
    }
    var base = null, pts = [];
    for (var i = 0; i < this.measures.length; i++) {
      var mc = this.measures[i], sm = this.rdm.measures[mc.srcIndex];
      if (sm && sm.tempoMark && sm.tempoMark.perMinute > 0) {
        if (base == null) base = sm.tempoMark.perMinute;
        pts.push({ beat: mc.startBeat, ratio: sm.tempoMark.perMinute / base, ramp: sm.tempoRamp || null, mIdx: i });
      }
    }
    if (pts.length < 2) return;                              // 0-1 marks → constant tempo → plain clock
    if (pts[0].beat > 1e-6) pts.unshift({ beat: 0, ratio: 1, ramp: null, mIdx: 0 });
    var segs = [], I = 0;
    for (var p = 0; p < pts.length; p++) {
      var b0 = pts[p].beat, b1 = (p + 1 < pts.length) ? pts[p + 1].beat : total;
      if (b1 <= b0) continue;
      var r0 = pts[p].ratio, r1 = r0;
      if (pts[p].ramp && p + 1 < pts.length) {
        r1 = pts[p + 1].ratio;
        // Metric modulation: when an accel/rit leads into a section with a DIFFERENT fastest subdivision,
        // the ramp resolves so the note-RATE is continuous — end at the tempo where this section's fastest
        // note equals the next section's fastest note, then let the marked tempo "jump" (subdivision flips,
        // but the stream of notes flows unbroken). Same subdivision → ramps straight to the mark as before.
        var accelMIdx = pts[p + 1].mIdx - 1;
        if (accelMIdx >= 0) {
          var aShort = shortestBeats(this.measures[accelMIdx].srcIndex);
          var nShort = shortestBeats(this.measures[pts[p + 1].mIdx].srcIndex);
          // fastest subdivision = notes-per-beat, rounded to the nearest whole (tuplet exports carry
          // floating-point noise, e.g. a sextuplet reads ~5.9–6.1 → 6) so the resolve lands exactly.
          var aSub = aShort ? Math.round(1 / aShort) : 0, nSub = nShort ? Math.round(1 / nShort) : 0;
          if (aSub > 0 && nSub > 0 && aSub !== nSub) r1 = pts[p + 1].ratio * (nSub / aSub);
        }
      }
      segs.push({ b0: b0, b1: b1, r0: r0, r1: r1, I0: I });
      I += (r1 === r0) ? (b1 - b0) / r0 : (b1 - b0) * Math.log(r1 / r0) / (r1 - r0);
    }
    this._tempoSegs = segs; this._tempoTotalI = I;
  };
  // base integral over the piece (beat in [0,total], no loop folding)
  RDMPlayer.prototype._mapIbase = function (beat) {
    var segs = this._tempoSegs; if (!segs) return beat;
    beat = Math.max(0, Math.min(beat, this.totalBeats));
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (beat <= s.b1 + 1e-9 || i === segs.length - 1) {
        var db = Math.max(0, Math.min(beat, s.b1) - s.b0);
        if (s.r1 === s.r0) return s.I0 + db / s.r0;
        var k = (s.r1 - s.r0) / (s.b1 - s.b0);
        return s.I0 + Math.log((s.r0 + k * db) / s.r0) / k;
      }
    }
    return this._tempoTotalI;
  };
  RDMPlayer.prototype._invMapIbase = function (Ival) {
    var segs = this._tempoSegs; if (!segs) return Ival;
    Ival = Math.max(0, Math.min(Ival, this._tempoTotalI));
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], nextI = (i + 1 < segs.length) ? segs[i + 1].I0 : this._tempoTotalI;
      if (Ival <= nextI + 1e-9 || i === segs.length - 1) {
        var dI = Ival - s.I0, db;
        if (s.r1 === s.r0) db = dI * s.r0;
        else { var k = (s.r1 - s.r0) / (s.b1 - s.b0); db = s.r0 * (Math.exp(dI * k) - 1) / k; }
        return s.b0 + db;
      }
    }
    return this.totalBeats;
  };
  RDMPlayer.prototype._loopWin = function () {   // active fold window [lo,hi] — the loop selection, or the whole piece
    if (this._looping && this._looping()) { var lo = this._loopLo(), hi = this._loopHi(); if (hi > lo) return [lo, hi]; }
    return [0, this.totalBeats];
  };
  // monotonic integral of the RAW (ever-increasing) playback beat, folding by the active window so a
  // full-piece or sub-section loop replays its own tempo profile each pass.
  RDMPlayer.prototype._mapI = function (beat) {
    if (!this._tempoSegs || !this.totalBeats) return beat;   // identity → linear clock
    var w = this._loopWin(), lo = w[0], hi = w[1], span = hi - lo;
    var Ilo = this._mapIbase(lo), winI = this._mapIbase(hi) - Ilo;
    if (!(span > 0) || !(winI > 0)) return this._mapIbase(beat);
    var passes = Math.floor((beat - lo) / span + 1e-9), local = beat - passes * span;
    return passes * winI + this._mapIbase(local);
  };
  RDMPlayer.prototype._invMapI = function (Ival) {
    if (!this._tempoSegs || !this.totalBeats) return Ival;
    var w = this._loopWin(), lo = w[0], hi = w[1], span = hi - lo;
    var Ilo = this._mapIbase(lo), winI = this._mapIbase(hi) - Ilo;
    if (!(span > 0) || !(winI > 0)) return this._invMapIbase(Ival);
    var passes = Math.floor((Ival - Ilo) / winI + 1e-9), localI = Ival - passes * winI;
    return lo + passes * span + (this._invMapIbase(localI) - lo);
  };
  // One shared clock: at anchorTime the music is at anchorBeat, advancing at spb sec per BASE beat.
  // With a tempo map, beats↔time go through _mapI (the 1/ratio integral) so mid-piece tempo changes
  // apply to notes, metronome and playhead together. _anchorI = _mapI(anchorBeat) is cached whenever
  // the anchor moves. No map → _mapI is the identity, so this stays the old linear clock exactly.
  RDMPlayer.prototype._timeForBeat = function (beat) { return this.anchorTime + (this._mapI(beat) - this._anchorI) * this.spb; };
  RDMPlayer.prototype._beatAt = function (now) { return this._invMapI(this._anchorI + (now - this.anchorTime) / this.spb); };
  RDMPlayer.prototype._reanchorI = function () { this._anchorI = this._mapI(this.anchorBeat); };

  RDMPlayer.prototype._scheduleMetro = function (horizon) {
    while (this._timeForBeat(this.metroBeat) < horizon) {
      if (!this._looping() && this.totalBeats > 0 && this.metroBeat >= Math.round(this.totalBeats)) break;
      if (this.metroOn) this._metroClick(this._timeForBeat(this.metroBeat), this._isDownbeat(this.metroBeat));
      var nb = this._advanceMetroBeat(this.metroBeat);
      // safety: never stall (a degenerate window shorter than one pulse would otherwise spin forever)
      this.metroBeat = (nb > this.metroBeat + 1e-9) ? nb : (this.metroBeat + Math.max(1e-3, this._pulseUnitAt(this.metroBeat) || 1));
    }
  };
  // The metro beat AFTER `beat`, always SNAPPED BACK onto the piece's own pulse grid.
  //
  // WHY THIS EXISTS (bug fix, 2026-07-26 — "the metronome carries on incorrectly"): the scheduler used
  // to advance with `metroBeat += _pulseUnitAt(metroBeat)`, i.e. it stepped by the pulse WIDTH and never
  // re-anchored on a bar line. Two things broke, both making clicks land off the piece's real beats:
  //   1) A measure that does NOT start a whole number of pulses after the previous one (a fractional
  //      pickup: downbeats 0, 1.5, 5.5 …) — the clicks marched 0,1,2,3 straight past the 1.5 bar line
  //      and every later measure's grid was permanently offset.
  //   2) A LOOP WINDOW whose span isn't a whole number of pulses (any note-precise loop, e.g. beats
  //      [2.25, 5.5) = span 3.25) — metroBeat keeps counting up across passes while _displayBeat folds
  //      by the SPAN, so from pass 2 on every click sat (span mod pulse) off the grid, and the error
  //      accumulated pass after pass (3,4,5 → 2.75,3.75,4.75 → 2.5,3.5,4.5 …).
  // The fix: re-derive the next click from the containing measure's downbeat every step (via
  // _nextMetroPulseAt, which is measure-anchored), and at the loop's end jump explicitly to the first
  // real pulse at/after the window start on the NEXT pass instead of letting the fold do it. So the
  // click grid is always phase-locked to the piece's downbeat grid — the same grid the measure-1
  // count-off establishes — no matter where playback starts or how many times the loop repeats.
  RDMPlayer.prototype._advanceMetroBeat = function (beat) {
    var EPS = 1e-6;   // strictly-after nudge; must be >> _pulseAtOrAfter's own 1e-9 tolerance
    var d = this.downbeats;
    if (!(this.totalBeats > 0) || !d || !d.length) return beat + (this._pulseUnitAt(beat) || 1);
    var fb = this._displayBeat(beat), passOffset = beat - fb;   // passOffset = whole passes of the active window
    var next = this._pulseAtOrAfter(fb + EPS);                  // measure-anchored, unfolded window coords
    if (!this._looping()) return next + passOffset;             // sequence/one-shot: no wrap, the caller stops at the end
    var w = this._loopWin(), lo = w[0], hi = w[1], span = hi - lo;
    if (!(span > 0)) return next + passOffset;
    if (next >= hi - 1e-9) {                                    // this pass is done → first pulse of the next pass
      var first = this._pulseAtOrAfter(lo);
      if (first >= hi - 1e-9) first = lo;                       // window shorter than one pulse → click on its start
      return first + passOffset + span;
    }
    return next + passOffset;
  };
  RDMPlayer.prototype._looping = function () { return this.mode === "loop"; };
  // True when `beat` (in quarter-beats) lands exactly on a measure start. Built from the real
  // measure boundaries captured in _buildPlayback, so the accent follows the actual downbeats
  // through pickups, time-signature changes, and repeats — not a fixed beats-per-bar modulo.
  // If a measure begins between ticks (e.g. a fractional pickup), no tick lands on it, so it
  // simply isn't accented — exactly "accent the first note of the bar IF it lines up on a beat."
  RDMPlayer.prototype._isDownbeat = function (beat) {
    var d = this.downbeats;
    if (!d || !d.length) {                       // fallback: uniform meter from the first time sig
      var bpb = (this.rdm && this.rdm.measures[0] && this.rdm.measures[0].timeSig ? this.rdm.measures[0].timeSig[0] : 4) || 4;
      return ((((beat % bpb) + bpb) % bpb)) < 1e-6;
    }
    var b = this.totalBeats > 0 ? this._displayBeat(beat) : beat;   // fold into the active window (or whole piece)
    var lo = 0, hi = d.length - 1, eps = 1e-6;    // binary search for an exact (within eps) boundary
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (Math.abs(d[mid] - b) < eps) return true; if (d[mid] < b) lo = mid + 1; else hi = mid - 1; }
    return false;
  };
  // The metro click spacing (in quarter-note units) for whichever measure `beat` falls in — 1 for a plain
  // quarter, 1.5 for a dotted-quarter compound pulse, etc. (see _buildPlayback for how each measure's
  // value is decided). Falls back to a plain quarter when there's no measure data yet.
  RDMPlayer.prototype._pulseUnitAt = function (beat) {
    var d = this.downbeats, pu = this._metroPulseUnit;
    if (!d || !d.length || !pu || !pu.length) return 1;
    // FOLD the raw metroBeat into the piece/loop window before the lookup. downbeats[]/_metroPulseUnit[]
    // tile [0,totalBeats) exactly once; the scheduler's metroBeat grows monotonically across loop passes,
    // so on pass 2+ an unfolded beat pins the search to the LAST measure's pulse forever (the loop
    // regression). _displayBeat also handles the sub-section loop window (_loopLo/_loopHi). (_isDownbeat
    // already folds this way at ~507.)
    var b = this.totalBeats > 0 ? this._displayBeat(beat) : beat;
    var lo = 0, hi = d.length - 1, ans = 0;       // last downbeat <= b = the measure containing it
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (d[mid] <= b + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    // Grouped grid (asymmetric meters): the pulse VARIES within the measure — return the duration of the
    // pulse segment `b` currently sits in (= distance to the next click), so the scheduler's metroBeat += ...
    // model lands on each grouping boundary (e.g. 7/8 [1.5,1,1] → steps 1.5,1,1 across the bar).
    var grid = this._metroPulseGrid && this._metroPulseGrid[ans];
    if (grid && grid.length) {
      var off = b - d[ans], acc = 0;
      for (var g = 0; g < grid.length; g++) { if (off < acc + grid[g] - 1e-9) return grid[g]; acc += grid[g]; }
      return grid[grid.length - 1] || pu[ans] || 1;
    }
    return pu[ans] || 1;
  };
  // THE grid function: the piece's own pulse position at or after `b`, where `b` is already an
  // IN-PIECE beat (no folding, no loop passes). Anchored on the measure containing `b`, so the grid is
  // always the one the piece's measure-1 count-off establishes.
  // Bug fix 2026-07-26: a candidate is CLAMPED to the next bar line — a measure whose length isn't a
  // whole number of pulses (fractional pickup, e.g. downbeats 0, 1.5, 5.5) used to let the walk stride
  // straight over the bar line (0 → 1 → 2 → 3 instead of 0 → 1.5 → 2.5 → 3.5), which offset the grid
  // for the whole rest of the piece.
  /* The click SPACING to use at beat `b`, looked up raw (no window folding) — used only while building
     the grid below. Asymmetric meters carry a per-measure grouping map (7/8 = 3+2+2); we honour it only
     when this click actually sits on one of that measure's grouping boundaries. On a continuous grid a
     measure can begin off the click, and in that case there is no meaningful grouping to follow, so we
     fall back to the measure's uniform pulse. */
  RDMPlayer.prototype._rawPulseStepAt = function (b) {
    var d = this.downbeats;
    if (!d || !d.length) return 1;
    var lo = 0, hi = d.length - 1, ans = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (d[mid] <= b + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    var grid = this._metroPulseGrid && this._metroPulseGrid[ans];
    if (grid && grid.length) {
      var acc = d[ans];
      for (var g = 0; g < grid.length; g++) {
        if (Math.abs(acc - b) < 1e-9) return grid[g];   // on a grouping boundary → next group's length
        acc += grid[g];
        if (acc > b + 1e-9) break;                      // this click sits inside a group, not on a boundary
      }
    }
    var pulse = this._metroPulseUnit && this._metroPulseUnit[ans];
    return (pulse > 1e-6) ? pulse : 1;
  };

  /* THE click grid for the whole piece, built once at load.
     Anchored at beat 0 (where the count-off measure starts) and stepped continuously to the end. Bar
     lines do NOT re-phase it: if a measure does not begin a whole number of pulses after the last click,
     that measure simply starts off the click and the pulse carries on undisturbed.

     This is a deliberate reversal of the measure-anchored grid that was here before (Anthony, 2026-07-26:
     "there should be a constant click that continues from the count off measure ... maybe some measures
     won't start with the metronome on the downbeat, and that's okay, but that needs to be consistent
     wherever someone starts"). The old version re-derived each click from the containing measure's
     downbeat and clamped at the bar line, so a 1.5-beat pickup turned a steady quarter pulse into
     0, 1, 1.5, 2.5 — it inserted a half-beat stutter at every bar the pulse did not divide evenly.

     Precomputing matters for more than speed: the loop machinery in _advanceMetroBeat snaps to this grid
     on every step, which is what stops a loop window whose span is not a whole number of pulses from
     drifting a little further out of phase on each pass. That bug is why the old code re-anchored at all;
     snapping to a fixed piece-wide grid fixes it without letting bar lines move the click. */
  RDMPlayer.prototype._buildMetroGrid = function () {
    this._metroGrid = null;
    var total = this.totalBeats, d = this.downbeats;
    if (!(total > 0) || !d || !d.length) return;
    var g = [], b = 0, guard = 0;
    while (b < total - 1e-9 && guard++ < 500000) {
      g.push(b);
      var step = this._rawPulseStepAt(b);
      b += (step > 1e-6 ? step : 1);
    }
    this._metroGrid = g;
  };

  // First click at or after `b`, straight off the precomputed grid.
  RDMPlayer.prototype._pulseAtOrAfter = function (b) {
    var g = this._metroGrid;
    if (!g || !g.length) return Math.ceil(b - 1e-9);                 // fallback: plain-quarter behavior
    var lo = 0, hi = g.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (g[mid] >= b - 1e-9) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    if (ans < 0) return this.totalBeats > 0 ? this.totalBeats : b;   // past the last click
    return g[ans];
  };
  // The next metro pulse AT OR AFTER `fromBeat`, honoring whatever pulse spacing is active at that point
  // (a seek/loop-boundary can land anywhere, not necessarily on the existing click grid).
  RDMPlayer.prototype._nextMetroPulseAt = function (fromBeat) {
    var d = this.downbeats;
    if (!d || !d.length) return Math.ceil(fromBeat - 1e-9);          // fallback: old plain-quarter behavior
    // Fold for the pulse lookup (same reason as _pulseUnitAt), but keep the RETURN in fromBeat's own loop
    // pass: passOffset is 0 for an in-window beat (the normal seek case → unchanged) and a whole number of
    // spans once folded, so the next click lands at the right absolute beat on any pass.
    var fb = this.totalBeats > 0 ? this._displayBeat(fromBeat) : fromBeat;
    return this._pulseAtOrAfter(fb) + (fromBeat - fb);
  };
  /* ---------- loop count-off ----------------------------------------------------------------
     "Give me 4 beats of count-off before the looped section" (student request, 2026-07-26).
     When `loopCountOff` is on AND a loop WINDOW is selected, we insert a silent gap in front of the
     window — at the very first play and again before every repeat — and fill it with the piece's OWN
     count-off sound: the plain-✕ stick click on the D line at DYN.TAPOFF, played through the same
     _hit() path the measure-1 tap-off uses (CO_EVENT below IS a tap-off event), so the cue can never
     drift away from how the piece counts itself in.
     Mechanics: the gap is inserted in TIME, not in beats — we re-anchor the shared clock so the loop's
     first beat now lands gapSec later. Notes already scheduled keep their committed times; the beat
     clock, the loop bounds and the note index are all untouched, and the metronome (which lives in beat
     space) simply has no beats to click during the gap. The cursor parks on the loop's first beat for
     the duration (see _cursorBeatAt). The clicks never touch the "notes played" counter because they
     are played directly, not walked by the scheduler's counting loop.
     ------------------------------------------------------------------------------------------ */
  // One reusable tap-off event: plain ✕ notehead on the D line = stick click, isTapoff = TAPOFF velocity
  // on the louder "stickLoud" ceiling. Exactly what _buildPlayback tags the piece's own count-off with.
  var CO_EVENT = { head: "x", step: "D", isTapoff: true, beats: 1, rest: false };
  /* Silence a count-off cue that is already committed to the audio graph. The whole cue is scheduled up
     front, so stopping playback or clearing the loop mid-cue would otherwise let the remaining clicks
     keep sounding (Anthony, 2026-07-26: "when I stop the loop, count off should not play"). */
  /* Ducking the gain is NOT enough on its own (Anthony, 2026-07-31: count-offs still overlapped after the
     first attempt at this). _coBus used to be ONE shared gain node reused by every cue, so muting it here
     and then _beginCountOff setting the same node straight back to 1 simply un-muted the previous cue's
     clicks — they are still live, still scheduled, still connected. The cue bus is therefore now
     DISPOSABLE: this tears the node out of the graph entirely, orphaning any clicks still pending on it
     (they can no longer reach the output), and _beginCountOff builds a fresh one for the next cue. */
  RDMPlayer.prototype._cancelCountOff = function () {
    this._coGap = null;
    if (this._coBus && this.actx) {
      var t = this.actx.currentTime;
      this._coBus.gain.cancelScheduledValues(t);
      this._coBus.gain.setValueAtTime(0, t);
      try { this._coBus.disconnect(); } catch (e) {}
      this._coBus = null;
    }
  };
  RDMPlayer.prototype.setLoopCountOff = function (on) {
    this.loopCountOff = !!on;
    if (!this.loopCountOff) this._cancelCountOff();   // switching it off kills a cue already in flight
    return this.loopCountOff;
  };
  RDMPlayer.prototype.getLoopCountOff = function () { return !!this.loopCountOff; };
  // 4 (default) or 2. Anything else falls back to 4 rather than producing a nonsense count.
  RDMPlayer.prototype.setCountOffBeats = function (n) {
    this.countOffBeats = (+n === 2) ? 2 : 4;
    return this.countOffBeats;
  };
  RDMPlayer.prototype.getCountOffBeats = function () { return this.countOffBeats === 2 ? 2 : 4; };
  /* Armed for the WHOLE exercise, not just a custom loop window (Anthony, 2026-07-31: the app is dropping
     every exercise's own written count-off measure, so this is becoming the ONLY count-off there is — it
     has to cover a plain top-to-bottom play, not only a sub-section loop). `_looping()` still excludes
     "sequence" mode (playlists chaining from one exercise to the next), which is its own separate thing
     and not part of this. loopEnd defaulting to null is fine either way: _loopLo/_loopHi already fall back
     to [0, totalBeats) with no custom window set, so the exact same mechanism just works for both. */
  /* THE TOP OF A PIECE ALWAYS COUNTS YOU IN (Anthony, 2026-08-07: "make the count off at the beginning of
     a piece always on even if the count off option is off... but not in the middle of a piece").

     The switch used to mean "count-off, yes or no". It now means "count me in on every REPEAT too" — the
     first one is not optional, because you cannot start playing a snare piece with no count. That is also
     why the switch's default flipped to OFF in the same pass: what it now controls is the mid-piece cue,
     and the resting state for that is off.

     `atPieceStart` means "this is the top of the piece". _startPlay passes it when playback begins at
     the top of the window (never on a mid-piece resume or a seek, which are not the beginning), and the
     loop wrap in _scheduler passes it when the loop goes back to bar 1. What is left for the switch to
     govern is the cue before a MID-PIECE repeat — looping bars 9 to 12 twenty times, where a four-beat
     count-off on every pass is noise rather than help. */
  RDMPlayer.prototype._countOffArmed = function (atPieceStart) {
    if (!(this.perf && this.totalBeats > 0 && this.actx)) return false;
    if (atPieceStart) return true;
    return !!(this.loopCountOff && this._looping());
  };
  /* The cue is a STEADY pulse, never the piece's own beat grouping (Anthony, 2026-07-31: "the count off
     should just be straight quarter notes or straight pulse... sometimes the pulse is 1/4 note sometimes
     is the dotted quarter note" — and for asymmetric meters too, "they should all be quarter note based
     count offs"). That is deliberately DIFFERENT from the real metronome click during playback, which
     Anthony confirmed already does the right thing for asymmetric meters (3+2+2 groupings etc.) and is
     untouched here. So the count-off does NOT read _metroPulseGrid (the grouped/asymmetric pulse map)
     at all — only whether the STARTING measure is compound (a dotted-quarter felt beat) or not. Simple
     and asymmetric meters both get plain quarters; only true compound meters (6/8, 9/8, 12/8) get the
     dotted quarter. How many pulses is the student's own choice (getCountOffBeats: 4 or 2). */
  RDMPlayer.prototype._countOffPulses = function (atBeat) {
    var pulse = 1;
    var d = this.downbeats;
    if (d && d.length) {
      var lo = 0, hi = d.length - 1, ans = 0;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (d[mid] <= atBeat + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      if (this._metroPulseUnit && this._metroPulseUnit[ans] === 1.5) pulse = 1.5;
    }
    var want = this.getCountOffBeats(), pulses = [];
    for (var k = 0; k < want; k++) pulses.push(pulse);
    return pulses;
  };
  // Sound the cue and push the resume point back by its length. `atBeat` is the RAW beat playback
  // resumes on (the loop start, on this pass); `startTime` overrides the gap's start (used at _startPlay,
  // where the clock's anchor is the not-yet-reached audioStart). Returns the seconds inserted.
  RDMPlayer.prototype._beginCountOff = function (atBeat, startTime, atPieceStart) {
    if (!this._countOffArmed(atPieceStart)) return 0;
    var boundary = (startTime != null) ? startTime : this._timeForBeat(atBeat);
    var lo = this._displayBeat(atBeat);                 // where in the PIECE the window starts
    var pulses = this._countOffPulses(lo), span = 0, i;
    for (i = 0; i < pulses.length; i++) span += pulses[i];
    // Seconds per beat for the cue: the piece's own rate AT the loop start, so a count-off inside a
    // half-tempo section counts at that section's speed. With no tempo map _mapIbase is the identity,
    // so this is exactly `spb`.
    var hiB = this.totalBeats > 0 ? Math.min(lo + span, this.totalBeats) : lo + span;
    var dI = this._mapIbase(hiB) - this._mapIbase(lo);
    var secPerBeat = (hiB > lo + 1e-9 && dI > 0) ? (dI / (hiB - lo)) * this.spb : this.spb;
    var gapSec = span * secPerBeat;
    if (!(gapSec > 0)) return 0;
    // Route the cue's clicks through _coBus (see _ensureAudio) so _cancelCountOff() can kill them the
    // instant playback stops or the loop is cleared — they are all committed to the graph up front.
    var t = boundary, realMaster = this.master;
    /* A FRESH bus per cue, never a reused one. Any previous cue's clicks stay attached to the old node,
       which _cancelCountOff has already disconnected — so restoring gain here can't resurrect them. */
    if (this.actx) {
      try { if (this._coBus) this._coBus.disconnect(); } catch (e) {}
      this._coBus = this.actx.createGain();
      this._coBus.gain.value = 1;
      this._coBus.connect(realMaster);
      this.master = this._coBus;
    }
    for (i = 0; i < pulses.length; i++) { this._hit(CO_EVENT, t); t += pulses[i] * secPerBeat; }
    this.master = realMaster;
    var prevT = this.anchorTime, prevI = this._anchorI, prevSpb = this.spb;
    this.anchorBeat = atBeat; this.anchorTime = boundary + gapSec; this._reanchorI();
    /* `pulses`, `spb` and `secPerBeat` are kept so the cue can be RE-TIMED if the tempo moves while it is
       still counting (see _retimeCountOff). secPerBeat is not simply spb — it carries the tempo map's
       scaling at this point in the piece — so the ratio between the two is what a retime has to preserve. */
    this._coGap = { from: boundary, until: boundary + gapSec, beat: atBeat, pt: prevT, pI: prevI, pspb: prevSpb,
                    pulses: pulses.slice(), spb: this.spb, secPerBeat: secPerBeat };
    return gapSec;
  };

  /* RE-TIME A COUNT-OFF THAT IS STILL SOUNDING (Anthony, 2026-08-07: "when i change the tempo during the
     count off, the count off should change in a live way").

     The whole cue is committed to the audio graph up front, so a tempo change could not reach it: the
     old behaviour deliberately left the gap alone and applied the new tempo only to the music after it,
     which meant counting yourself in at one speed and then being dropped into another.

     So: kill what is still pending, work out which clicks have already sounded, and re-schedule only the
     rest at the new rate. The clicks you have already heard are history and are left exactly where they
     were; the NEXT one lands one (new) pulse after the last one you heard, which is what "the count-off
     follows the tempo" means to a player. If the new tempo is fast enough that the next click would land
     in the past, it goes as soon as possible instead of being skipped.

     Returns the cue's new end time (when playback should start), or null if there was nothing to retime. */
  RDMPlayer.prototype._retimeCountOff = function (newSpb) {
    var g = this._coGap;
    if (!g || !g.pulses || !this.actx) return null;
    var now = this.actx.currentTime;
    if (!(now < g.until)) return null;                 // already over — nothing to do
    if (!(g.spb > 0) || !(newSpb > 0)) return null;

    var newSecPerBeat = g.secPerBeat * (newSpb / g.spb);

    /* How many clicks have already been heard, at the OLD spacing. A click within LOOKAHEAD of now is
       treated as already gone: tearing the bus out from under something that is milliseconds away would
       drop it audibly, and moving it is not perceptible anyway. */
    var LOOKAHEAD = 0.02;
    var t = g.from, fired = 0, i;
    for (i = 0; i < g.pulses.length; i++) {
      if (t > now + LOOKAHEAD) break;
      fired++;
      t += g.pulses[i] * g.secPerBeat;
    }
    var lastFiredAt = t - (fired > 0 ? g.pulses[fired - 1] * g.secPerBeat : 0);

    // where the next click goes: one NEW pulse after the last one heard (never in the past)
    var next = (fired === 0)
      ? g.from
      : Math.max(now + 0.005, lastFiredAt + g.pulses[fired - 1] * newSecPerBeat);

    this._cancelCountOff();      // tears the bus out, orphaning every click still pending on it

    var realMaster = this.master;
    try { this._coBus = this.actx.createGain(); this._coBus.gain.value = 1;
          this._coBus.connect(realMaster); this.master = this._coBus; }
    catch (e) { this.master = realMaster; return null; }

    var tt = next;
    for (i = fired; i < g.pulses.length; i++) { this._hit(CO_EVENT, tt); tt += g.pulses[i] * newSecPerBeat; }
    this.master = realMaster;

    /* If every click had already sounded, `tt` is just `next` and the remaining gap is whatever is left
       of the last pulse — re-timed too, so the music still arrives one pulse after the final click. */
    var until = (fired >= g.pulses.length)
      ? lastFiredAt + g.pulses[g.pulses.length - 1] * newSecPerBeat
      : tt;
    if (!(until > now)) until = now + 0.005;

    g.until = until; g.spb = newSpb; g.secPerBeat = newSecPerBeat;
    this._coGap = g;             // _cancelCountOff nulled it; the cue is still live, so put it back
    return until;
  };
  // Beat the CURSOR should read at audio time `t`. Normally just the shared clock; during a count-off
  // gap the transport is standing still on the loop's first beat, so the cursor parks there (it must not
  // slide, and it must not read the pre-gap clock, which would run it backwards through the last pass).
  RDMPlayer.prototype._cursorBeatAt = function (t) {
    var g = this._coGap;
    if (g) {
      if (t >= g.until - 1e-6) this._coGap = null;                              // gap over → normal clock
      else if (t >= g.from) return g.beat;                                      // counting in → hold on the loop start
      else if (g.pt != null) return this._invMapI(g.pI + (t - g.pt) / g.pspb);  // still finishing the previous pass
      else return g.beat;                                                       // pre-roll before the very first pass
    }
    return this._beatAt(t);
  };
  // Schedule extra-voice hits (polyrhythm parts) up to `horizon`, audio only. extraHits hold
  // absolute beats within one pass [0, totalBeats); we walk a beat cursor and wrap it with the
  // loop so the second part keeps sounding against voice 1 every time around.
  RDMPlayer.prototype._scheduleExtraVoices = function (horizon, now) {
    var eh = this.extraHits, T = this.totalBeats;
    if (!eh || !eh.length || !(T > 0)) return;
    while (this._timeForBeat(this._extraCursorBeat) < horizon) {
      var loopBase = Math.floor((this._extraCursorBeat + 1e-9) / T) * T;
      var within = this._extraCursorBeat - loopBase, hb = null, ev = null;
      for (var k = 0; k < eh.length; k++) { if (eh[k].beat >= within - 1e-9) { hb = loopBase + eh[k].beat; ev = eh[k].ev; break; } }
      if (hb == null) { hb = loopBase + T + eh[0].beat; ev = eh[0].ev; }   // past this loop's last hit → wrap
      if (!this._looping() && hb >= T - 1e-9) break;                       // sequence/once: a single pass only
      if (this._timeForBeat(hb) >= horizon) break;
      this._hit(ev, Math.max(this._timeForBeat(hb), now), hb);
      this._extraCursorBeat = hb + 1e-6;
    }
  };

  /* Drop a piece's own WRITTEN count-off bar (Anthony, 2026-07-31). Every catalog exercise ships with a
     leading bar of stick-clicks; the app now counts you in itself (see _countOffArmed / _countOffPulses),
     so the written bar is a duplicate — and it also pushed every bar number up by one, so what a student
     calls bar 1 was really bar 2 in the Loop panel.

     Done HERE, on the parsed score, rather than by editing the 493 .musicxml files: that bar also carries
     the piece's <attributes> (time signature, clef, divisions) and its tempo mark, so deleting it in the
     source would mean transplanting those into the next bar and renumbering every measure, across ~340
     two-part files, for no visible gain. This is one place, reversible, and the source files stay the
     untouched export from Sibelius.

     Deliberately conservative — it only fires on the exact shape the survey found in 486 of 493 files
     (dev/countoff-survey.js), and leaves anything else alone:
       - needs a following bar to survive
       - EVERY sounding event in bar 1 must be a stick-click (head "x" on step "d"); one real note and
         the bar is music, not a cue (0 files mixed the two, but a hand-edited file could)
       - a repeat barline on bar 1 would change what the piece means, so those are left alone
     The 7 exercises with no count-off at all (the 5 Etudes, Snare Ensemble, _resttest) simply fail the
     first test and pass through untouched. */
  RDMPlayer.prototype._stripLeadingCountOff = function (rdm) {
    if (!rdm || !rdm.measures || rdm.measures.length < 2) return rdm;
    var m0 = rdm.measures[0];
    if (!m0 || m0.repeatStart || (m0.repeatEndTimes || 0) > 0) return rdm;
    var sounding = (m0.events || []).filter(function (e) { return !e.rest; });
    if (!sounding.length) return rdm;
    var isCue = function (e) { return e.head === "x" && String(e.step || "").toLowerCase() === "d"; };
    if (!sounding.every(isCue)) return rdm;
    // Carry forward anything the dropped bar was the carrier for. MusicXML only writes attributes when
    // they CHANGE, so bar 2 usually has no timeSig of its own — without this the piece loses its meter.
    var next = rdm.measures[1];
    if (m0.timeSig && !next.timeSig) next.timeSig = m0.timeSig;
    if (m0.tempoMark && !next.tempoMark) next.tempoMark = m0.tempoMark;
    var out = {};
    for (var k in rdm) if (Object.prototype.hasOwnProperty.call(rdm, k)) out[k] = rdm[k];
    out.measures = rdm.measures.slice(1);
    return out;
  };

  /* ---------- loading: fetch + convert + render ---------- */
  RDMPlayer.prototype.load = function (opts) {
    opts = opts || {};
    var self = this;
    var gen = ++this._loadGen;   // this call "wins" until a later load() call bumps it again
    var orig = parseInt(opts.originalTempo, 10) || 120;
    // tempoRangeAnchor (optional): min/max normally derive from `orig` too, but a caller that carries the
    // PLAYER's current tempo forward into `orig` on every load (SR Lab: "keep playing at whatever tempo
    // you're at") needs the min/max baseline to stay put instead of re-centering on that moving target —
    // pass a stable anchor (e.g. a fixed default tempo) to decouple the two. Omitted = old behavior
    // (Playalongs/Metronome: `orig` IS the piece's own authored tempo, a legitimate range center).
    var rangeAnchor = opts.tempoRangeAnchor != null ? (parseInt(opts.tempoRangeAnchor, 10) || orig) : orig;
    this.originalTempo = orig; this.minTempo = Math.round(rangeAnchor / 2); this.maxTempo = rangeAnchor * 2; this.tempo = orig;
    this._loopIndex = 0; this._repCounter = 0; this._prevRandom = null;
    this._stopPlay();
    this.idx = 0; this.cumBeat = 0;                 // fully reset playback position on a new track
    // a new track's systems land at completely different y's than the old one's — drop the auto-scroll's
    // tracked page so it re-adopts fresh instead of comparing the new cursor against a stale reference
    // (that staleness was silently disabling the "page forward" pacing on every track change).
    // _autoTarget (the never-scroll-up floor) belongs to the OLD piece's coordinates — carrying it into
    // a new one would pin the view part-way down a fresh score.
    this._scrollTarget = this._pageTop = this._autoTarget = null;

    var done = function (rdm) {
      // Strip the written count-off bar before ANYTHING reads the score, so the notation, the playback
      // build, the measure cells and the Loop panel's bar numbers all agree on the same piece.
      if (opts.keepWrittenCountOff !== true) rdm = self._stripLeadingCountOff(rdm);
      self.rdm = rdm;
      self._render();
      self._buildPlayback();
      self.clearLoop();                             // a new track invalidates any prior loop selection
      self.idx = 0; self.cumBeat = 0;               // start the new track from the very beginning
      self._drawPlayheadAtBeat(0);                  // cursor back to the start
      self._emit("onLoad", { min: self.minTempo, max: self.maxTempo, tempo: self.tempo, originalTempo: orig });
      self._emit("onTempoChange", self.tempo);
      self._emitTimeAt(0);
      return { min: self.minTempo, max: self.maxTempo, tempo: self.tempo };
    };

    if (opts.rdm) return Promise.resolve(done(opts.rdm));
    if (opts.xml) return Promise.resolve(done(global.RDMConvert.convert(opts.xml)));
    if (opts.file) {
      return fetch(opts.file).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      }).then(function (xml) {
        // A newer load() call started while this fetch was in flight (the user spammed next/prev/
        // randomize) — skip the expensive convert + render entirely instead of racing to draw a track
        // nobody wants anymore. The caller's own "is this still current" check (e.g. app.js's loadToken)
        // still guards UI state, but THIS is what stops the wasted synchronous render work that was
        // making rapid button-mashing feel laggy — every stale in-flight load used to fully render before
        // being thrown away, so the browser ground through N discarded renders before the real one showed.
        if (gen !== self._loadGen) return null;
        return done(global.RDMConvert.convert(xml));
      });
    }
    return Promise.reject(new Error("load() needs file, xml, or rdm"));
  };

  RDMPlayer.prototype._render = function () {
    this.host.innerHTML = "";
    // Width comes from an optional stable provider when the host app supplies one. Reading
    // host.clientWidth directly is unreliable DURING a load — mid-reflow it can briefly report a
    // too-small value, drawing the music narrow and forcing a second re-render. The provider returns a
    // width cached at settled moments. Falls back to host.clientWidth so other callers are unaffected.
    var w = (this.cb && this.cb.getRenderWidth && this.cb.getRenderWidth()) || this.host.clientWidth || 1000;
    // Optional per-screen baseline: a host can make "100%" adaptive by returning a width-based factor
    // (e.g. smaller on phones so the default size feels right). getZoom()/setZoom() and the % label keep
    // tracking the RELATIVE user zoom; only the drawn scale is multiplied. No callback = 1 (unchanged).
    var base = (this.cb && this.cb.baseScale) ? (this.cb.baseScale(w) || 1) : 1;
    /* fillTrailing (per-tool opt-in): stretch a measure's notes so the last one reaches its bar line.
       VexFlow's proportional formatter reserves the last note's duration as empty space after it, which
       on a dense generated bar left a visible blank hole before the bar line — measured up to 218px
       against a 13px norm. Sightreading Lab opts in; Playalongs does not, so real transcribed pieces
       keep VexFlow's natural spacing byte-for-byte. (Anthony, 2026-07-21 — "random space") */
    this.out = global.RDMRender.render(this.rdm, this.host, { width: w, zoom: (this.zoom || 1) * base,
      fillTrailing: !!(this.cb && this.cb.fillTrailing) });
    /* ZOOM CEILING FOR THIS EXERCISE (Anthony, 2026-08-08). Some measures (flam-heavy ones) are too wide
       to draw at 100% on a phone, so the renderer auto-shrinks them and every zoom % above the fit drew
       the SAME size — the control looked dead. fitZoom is the largest total scale the widest bar fits at;
       divide out the per-screen base to get it back in USER-zoom terms, and cap the control there so the
       shown % is always the real size. Normal exercises fit far past 250%, so their ceiling stays 2.5 and
       nothing changes. */
    var _base = base || 1;
    var _fit = (this.out && this.out.fitZoom != null) ? this.out.fitZoom / _base : Infinity;
    // FLOOR to the 2-decimal grid the zoom control snaps to, not round: rounding UP (0.606 -> 0.61) would
    // put the ceiling a hair ABOVE the true fit, so the stored zoom could sit at 61% over a 60.6% draw —
    // exactly the "% shown ≠ size drawn" this is meant to kill. Floored, the label is always ≤ the fit.
    this._maxZoom = Math.floor(Math.min(2.5, Math.max(0.5, _fit)) * 100) / 100;
    // never let the stored zoom sit above what actually fits — else the label reads 100% over a 60% draw
    if (this.zoom > this._maxZoom + 1e-9) {
      this.zoom = this._maxZoom;
      this._emit("onZoom", { zoom: this.zoom });
    }
    this.host.style.position = "relative";
    // loop-selection overlay — sits BELOW the playhead canvas so the traveling cursor draws on top
    // of it, and the playhead's own incremental clears never erase the selection highlight.
    var sc = document.createElement("canvas");
    sc.className = "sel";
    sc.style.position = "absolute"; sc.style.top = "0"; sc.style.left = "0"; sc.style.pointerEvents = "none";
    this.host.appendChild(sc);
    this.selCanvas = sc;
    // playhead canvas overlay (on top)
    var c = document.createElement("canvas");
    c.className = "ph";
    c.style.position = "absolute"; c.style.top = "0"; c.style.left = "0"; c.style.pointerEvents = "none";
    this.host.appendChild(c);
    this.phCanvas = c;
    this._sizePlayhead();
    this._clearPlayhead();
    if (this.measures && this.loopM0 != null) this._drawSelection();
    this._drawTempoMarks();   // overlay any "♩ = N" tempo markings above their measures
  };
  // Tempo markings: for each bar that carries a <metronome> mark, float a "♩ = N" (or ♩.) label above
  // it on the paper. The number scales live with the slider (relative to the piece's base tempo), so a
  // 35-marked section shows half of whatever the start is set to. Positioned from the render geometry
  // (out.staves / out.notes), so they land on the right system and track zoom/resize re-renders.
  RDMPlayer.prototype._tempoGlyph = function (beatUnit, dots) {
    var g = { whole: "𝅝", half: "𝅗𝅥", quarter: "♩", eighth: "♪", "16th": "♬" }[beatUnit] || "♩";
    return g + (dots > 0 ? "." : "");
  };
  // Builds a tempo mark's inner HTML — a plain "note = N", or, when the mark carries an optional
  // `modFrom` (a metric-modulation relation, e.g. "dotted quarter = new quarter"), just the relation
  // itself ("oldGlyph = newGlyph"), no number — that's how a real modulation mark reads in print, the
  // player derives the number from feel/continuity, not from a printed BPM. `modFrom` is otherwise
  // purely internal: every functional field (beatUnit/dots/perMinute) still names the real NEW tempo
  // exactly as a plain mark would, so scheduling/ramps/beatUnitMult never need to know it exists.
  RDMPlayer.prototype._tempoMarkHTML = function (mk, cur, base) {
    if (mk.modFrom) {
      return '<span class="tempomark__note">' + this._tempoGlyph(mk.modFrom.beatUnit, mk.modFrom.dots) + '</span> = '
           + '<span class="tempomark__note">' + this._tempoGlyph(mk.beatUnit, mk.dots) + '</span>';
    }
    return '<span class="tempomark__note">' + this._tempoGlyph(mk.beatUnit, mk.dots) + '</span> = ' + Math.round(mk.perMinute * (cur / base));
  };
  // The note the tempo NUMBER counts — the piece's primary beat unit (e.g. a quarter, or a dotted
  // quarter in compound meter). Reads the first measure carrying a <metronome> mark; defaults to a quarter.
  RDMPlayer.prototype.beatGlyph = function () {
    var ms = this.rdm && this.rdm.measures;
    if (ms) for (var i = 0; i < ms.length; i++) {
      var mk = ms[i].tempoMark;
      if (mk && mk.beatUnit) return this._tempoGlyph(mk.beatUnit, mk.dots);
    }
    return this._tempoGlyph("quarter", 0);
  };
  // How many quarter notes the piece's displayed tempo NUMBER counts per unit — 1.5 for a dotted-quarter
  // pulse (compound meter), 1 for a plain quarter, etc. Reads the same first tempo mark as beatGlyph()
  // so the number and its note glyph always describe the same pulse (this.tempo itself stays in true
  // quarter-notes/min for scheduling; only display + typed/tapped input need this conversion).
  RDMPlayer.prototype.beatUnitMult = function () {
    var BEATUNIT_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };
    var ms = this.rdm && this.rdm.measures;
    if (ms) for (var i = 0; i < ms.length; i++) {
      var mk = ms[i].tempoMark;
      if (mk && mk.beatUnit) { var base = BEATUNIT_Q[mk.beatUnit] || 1; return mk.dots ? base * 1.5 : base; }
    }
    return 1;
  };
  RDMPlayer.prototype._drawTempoMarks = function () {
    if (this._tempoEls) this._tempoEls.forEach(function (e) { e.remove(); });
    this._tempoEls = [];
    if (!this.out || !this.rdm || !this.rdm.measures || !this.host) return;
    var self = this, measures = this.rdm.measures;
    function firstNote(mi) {
      var notes = self.out.notes[mi]; if (!notes) return null;
      for (var k in notes) { if (notes[k] && notes[k].yTop != null) return notes[k]; }
      return null;
    }
    // Anchor just above the measure's TOP-MOST rendered ink (tuplet #s / accents / marcatos). VexFlow's
    // internal y estimates are unreliable, so measure the actual glyph geometry via getBBox, which reads the
    // SVG geometry MODEL directly — the SAME value at any zoom, so the marks stay put when zoom changes (a
    // per-glyph getBoundingClientRect goes stale after a re-render). getBBox is in viewBox units; the SVG is
    // CSS-scaled to its rendered box, so contentPx(host) = bboxUnit * (renderedWidth / viewBoxWidth) + svgTop.
    // Everything below is in on-screen px; the music is drawn at out.effZoom, so scale the mark font AND
    // all the pixel offsets (gap above ink, measurement band, dash thickness) by it — otherwise the marks
    // stay a fixed size while the notes shrink/grow, and look huge (or tiny) relative to the sheet.
    // All overlay coords are host-relative SCREEN px, the same space as out.notes/out.staves and as
    // getBBox()*cssRatio. `S` (rendered width / viewBox width) is the music's on-screen scale — everything
    // visual (font, clearance, dash thickness) and the measurement band scale by it, so the marks track the
    // sheet at any zoom instead of staying a fixed size.
    var svg = this.host.querySelector("svg");
    var S = 1, svgTop = 0;
    if (svg) {
      var vb = svg.viewBox && svg.viewBox.baseVal, sr = svg.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
      if (vb && vb.width > 0 && sr.width > 0) S = sr.width / vb.width;
      svgTop = sr.top - hr.top;
    }
    var FS = 16 * S;                               // tempo-mark font size (1rem at 100%)
    var GAP = Math.round(11 * S);                  // clearance between the top ink and the mark's bottom
    // Anchor above the measure's top ink using the renderer's per-measure topMark — measured from THIS
    // measure's own glyphs (so it never catches a neighbouring system) and already in on-screen px, the same
    // space as notes[].yTop. Zoom-proof. Falls back to the note's own top.
    function topFor(mi, n) {
      var st = self.out.staves[mi];
      var top = (st && st.topMark != null) ? st.topMark : (n.cTop != null ? n.cTop : n.yTop);
      return Math.round(Math.max(2, top - FS - GAP));
    }
    var topCache = {};
    function topOf(mi, n) { if (topCache[mi] == null) topCache[mi] = topFor(mi, n); return topCache[mi]; }
    // raw top-of-ink for a measure (before subtracting the mark's own height) — used to re-seat the mark by
    // its MEASURED height so the enlarged note glyph clears the notes by GAP instead of drooping into them.
    function topInkOf(mi, n) {
      var st = self.out.staves[mi];
      return (st && st.topMark != null) ? st.topMark : (n.cTop != null ? n.cTop : n.yTop);
    }
    var _base = this.rdm.tempo || this.tempo || 120, _cur = this.tempo || _base;
    var firstMarkMi = -1;
    for (var _fm = 0; _fm < measures.length; _fm++) { if (measures[_fm].tempoMark) { firstMarkMi = _fm; break; } }
    measures.forEach(function (m, mi) {
      if (!m.tempoMark) return;
      var st = self.out.staves[mi], first = firstNote(mi);
      if (!st || !first) return;
      var el = document.createElement("div");
      el.className = "tempomark";
      el.setAttribute("data-mi", mi);
      el.style.position = "absolute";
      el.style.fontSize = FS + "px";
      // set the text now (not just in _updateTempoMarkValues) so the accel word can measure its real width
      el.innerHTML = self._tempoMarkHTML(m.tempoMark, _cur, _base);
      // The opening tempo mark of the piece sits at the far LEFT of the first system (above the clef/time
      // signature), as in standard engraving; mid-piece tempo changes stay above their measure's first note.
      el.style.left = Math.round(mi === firstMarkMi ? Math.max(2, st.x0) : (first.x - 4)) + "px";
      el.style.top = topOf(mi, first) + "px";
      self.host.appendChild(el);
      // Re-seat vertically by the mark's MEASURED height so its bottom clears the top ink by GAP — the tall
      // note glyph would otherwise hang lower than the assumed single-line height and crowd the notes.
      var mh = el.offsetHeight;
      if (mh > 0) el.style.top = Math.round(Math.max(2, topInkOf(mi, first) - GAP - mh)) + "px";
      self._tempoEls.push(el);
    });
    // gradual tempo change (accel./rit.): one italic word at the ramp start, then a dashed line that
    // continues over every measure the change spans (up to the downbeat that lands the next tempo mark).
    // The line breaks at system ends and resumes on the next line, like real engraving.
    measures.forEach(function (m, mi) {
      if (!m.tempoRamp) return;
      var label = m.tempoRamp === "rit" ? "rit." : "accel.";
      var end = mi + 1;
      while (end < measures.length && !measures[end].tempoMark) end++;   // measures [mi, end) are under the ramp
      var startFirst = firstNote(mi); if (!startFirst) return;
      // sit right of this measure's ♩=N number (use its actual measured width so it scales with zoom)
      var numEl = self.host.querySelector('.tempomark[data-mi="' + mi + '"]');
      var shift = numEl ? (numEl.offsetWidth + 8 * S) : (measures[mi].tempoMark ? 56 * S : 0);
      var textLeft = Math.round(startFirst.x - 4 + shift);
      var textTop = topOf(mi, startFirst);
      var txt = document.createElement("div");
      txt.className = "tempomark temporamp";
      txt.textContent = label;
      txt.style.position = "absolute";
      txt.style.fontSize = FS + "px";
      txt.style.left = textLeft + "px";
      txt.style.top = textTop + "px";
      self.host.appendChild(txt);
      self._tempoEls.push(txt);
      var textW = txt.offsetWidth || 40;
      var nextFirst = (end < measures.length) ? firstNote(end) : null;   // the ♩=N the ramp leads into
      var dashW = Math.max(1, Math.round(2 * S));
      // Group the spanned measures into per-SYSTEM runs (same stave-top y = same system) so the dashed line
      // is ONE continuous segment per line — it only breaks where the music itself wraps to a new system.
      var runs = [], cur = null;
      for (var j = mi; j < end; j++) {
        var jfn = firstNote(j); if (!jfn) continue;
        var rowKey = Math.round(jfn.yTop);
        if (!cur || cur.rowKey !== rowKey) { cur = { rowKey: rowKey, first: j, last: j, y: topOf(j, jfn) }; runs.push(cur); }
        else { cur.last = j; cur.y = Math.min(cur.y, topOf(j, jfn)); }
      }
      runs.forEach(function (run) {
        var lastSt = self.out.staves[run.last];
        var x0 = (run.first === mi) ? (textLeft + textW + Math.round(6 * S)) : Math.round(self.out.staves[run.first].x0 + 2);
        var x1;
        // if this run ends the ramp AND the next tempo mark is on this same system, stop at its downbeat;
        // otherwise run to the last measure's right bar line and let the line resume on the next system.
        var nextSameRow = nextFirst && Math.round(nextFirst.yTop) === run.rowKey;
        if (run.last === end - 1 && nextSameRow) x1 = Math.round(nextFirst.x - 8 * S);
        else x1 = Math.round(lastSt.x1 - 4);
        if (x1 - x0 < 8) return;
        var line = document.createElement("div");
        line.className = "temporampline";
        line.style.position = "absolute";
        line.style.borderTopWidth = dashW + "px";
        line.style.left = x0 + "px";
        line.style.top = Math.round(run.y + FS * 0.5) + "px";   // align to the middle of the italic word
        line.style.width = (x1 - x0) + "px";
        self.host.appendChild(line);
        self._tempoEls.push(line);
      });
    });
    this._updateTempoMarkValues();
  };
  RDMPlayer.prototype._updateTempoMarkValues = function () {
    if (!this._tempoEls || !this._tempoEls.length || !this.rdm) return;
    var base = this.rdm.tempo || this.tempo || 120, cur = this.tempo || base, self = this;
    this._tempoEls.forEach(function (el) {
      if (!el.hasAttribute("data-mi")) return;   // accel./rit. words + dashed lines are static, not scaling numbers
      var m = self.rdm.measures[+el.getAttribute("data-mi")], mk = m && m.tempoMark;
      if (!mk) return;
      el.innerHTML = self._tempoMarkHTML(mk, cur, base);
    });
  };

  RDMPlayer.prototype._buildPlayback = function () {
    var seq = global.RDMConvert.rdmSequence(this.rdm);
    var out = this.out;
    /* `graces` is carried across purely so the AUDIO can tell a 2-grace ruff/drag from a 1-grace flam:
       e.flam is a boolean, so without the list _hit had no way to know how many strokes the ornament
       actually has and every ruff played as a flam (Anthony, 2026-08-02). Only the LENGTH is read down
       there — the noteheads/durations/beams inside it belong to the renderer, which reads the rdm event
       itself, not this playback copy. Null for producers that only set the flam flag; _hit treats that
       as one grace, exactly as before. */
    this.perf = seq.map(function (s) {
      return { beats: s.beats, accent: s.ev.accent, marcato: s.ev.marcato, tenuto: s.ev.tenuto, staccato: s.ev.staccato, flam: s.ev.flam,
               graces: s.ev.graces,
               roll: s.ev.roll, buzz: s.ev.buzz, head: s.ev.head, step: s.ev.step, oct: s.ev.oct, rest: s.ev.rest,
               // stick1 = the printed hand. Carried into playback for the accent->tap lift below, which
               // only applies when both notes are on the SAME hand.
               stick1: s.ev.stick1,
               /* stick2 + heads are here for DOUBLE STOPS. Anthony's definition is the printed sticking:
                  "a double stop is any note that has a B under it instead of an R or an L". `heads` is the
                  full notehead list (a chord in MusicXML), so a double stop written as two noteheads —
                  a shot in one hand and a normal note in the other — can sound as the two things it is. */
               stick2: s.ev.stick2, heads: s.ev.heads,
               dynamic: s.ev.dynamic, m: s.m, e: s.e };
    });

    /* ACCENT DOWN TO A TAP, SAME HAND, FAST: the tap comes up to tenuto (Anthony, 2026-08-07).

       "when an accent goes down to a tap at 16th note speed at 95 BPM, the 2nd note being the tap
       should play a little bit louder, like a tenuto volume... this could apply to anything that
       matches that speed."

       It is a physical fact rather than a notation one. Throwing a full accent and then stopping the
       same hand dead for a true ghost tap takes time the hand does not have at that rate — the stick
       rebounds and the second note comes out bigger whether you want it or not. Below the threshold it
       is playable and the written tap is honest, so nothing changes.

       Marked here as a BEAT GAP, not a decision, because the threshold is in SECONDS and the tempo can
       move at any moment: _articVel multiplies by the live spb every time the note is scheduled, so
       dragging the tempo slider through 95 turns this on and off exactly where it should. */
    for (var ai = 1; ai < this.perf.length; ai++) {
      var cur = this.perf[ai], prv = this.perf[ai - 1];
      if (cur.rest || prv.rest) continue;
      if (cur.accent || cur.marcato || cur.tenuto) continue;       // only a written plain tap is lifted
      if (!(prv.accent || prv.marcato)) continue;
      // same hand, and we must actually KNOW the hands — no sticking printed means no claim either way
      if (!cur.stick1 || !prv.stick1 || cur.stick1 !== prv.stick1) continue;
      cur._accTapGap = prv.beats || 0;                             // the accent's own length is the gap
    }
    // Does the piece contain ANY accent at all — kept only as a piece-level fact for callers/tests.
    // The level decision itself is per section now, in the walk below.
    this._hasAccent = this.perf.some(function (p) { return p.accent || p.marcato; });

    /* ================= ACCENT-TAP MUSIC vs FLAT MUSIC, PER SECTION =================

       Anthony, 2026-08-07, describing Etude 1 by ear: "EVERYTHING in etude 1 is flat, except measures 7
       through measure 10; measure 11 would go back to flat and loud; then beat 2 of measure 12 through
       13 would be accent tap, and then after would be flat again, until measure 31 to the end."

       That is a piece with SIX changes of character in 33 bars, and the model it replaced asked one
       question about the whole file ("how accented is this piece?") and got one answer. Whatever that
       answer is, it is wrong in both halves: the flat bars come out too quiet and the accent-tap bars
       come out with taps too loud to hear an accent over. Bar 9 was the proof — ten tenutos sitting
       ABOVE every forte note in the piece.

       THE WALK, note by note. It reproduces his description exactly, including the sub-bar detail:
         - start flat
         - a WRITTEN DYNAMIC at the top of a bar resets the state to flat: a new bar with a new mark is
           a new section, and it has to earn its accent-tap character again
         - any accent / marcato / TENUTO flips the state to accent-tap FROM THAT NOTE
         - the state carries forward until something above changes it

       WHY "at the top of a bar" and not "any mark" (Anthony, 2026-08-07: "beat 1 of measure 12 should
       be flat loud forte like measure 11"). Bar 12 is: rest, plain note, MARCATO on 2, accent on 2.5,
       then the p on beat 3. Beat 1 has no mark and no accent, so it carries bar 11's flat forte, which
       is what he asked for. The accent-tap character starts at the marcato on beat 2 — his earlier
       "beat 2 of measure 12 through 13" — and the p arriving on beat 3 must NOT undo it, or the rest
       of the bar and all of bar 13 would snap back to flat. A mark mid-bar is a change of loudness
       inside a passage; a mark at the top of a bar is a new passage.

       Bar-resolution could not express any of that: it flipped the whole of bar 12 at once.

       Tenuto counts as evidence, not just accent: you only write a tenuto against taps. Bar 32 is one
       marcato and fourteen tenutos, and it is accent-tap music by anyone's reading. */
    var barArtic = {};
    this.perf.forEach(function (p) { if (!p.rest && (p.accent || p.marcato || p.tenuto)) barArtic[p.m] = true; });

    var flatState = null, seenSounding = false, curBar = -1;
    var flatBar = [];
    this.perf.forEach(function (p) {
      if (p.m !== curBar) { curBar = p.m; seenSounding = false; }
      /* WHERE A SECTION STARTS, its state comes from that BAR's own content, not from the note in front
         of it. Carrying forward is right in the middle of a piece and wrong at a boundary, and the two
         places with no note in front of them are the very first note and a bar-top mark.

         This is not theoretical. "16th 1 Accent Grid Backwards" is accent-tap music whose accent lands
         at the END of each group, so with a plain flat seed its opening taps came out as full strokes
         and then dropped — a blare, then the exercise. Four grid exercises did it. Asking the bar
         instead fixes all of them without touching bar 12 of Etude 1, which has no bar-top mark and so
         still carries bar 11's flat forte into beat 1, exactly as Anthony asked. */
      if (flatState === null) flatState = !barArtic[p.m];                       // the first note of the piece
      else if (p.dynamic && !seenSounding) flatState = !barArtic[p.m];          // a mark at the top of a bar
      if (!p.rest && (p.accent || p.marcato || p.tenuto)) flatState = false;    // and any articulation, always
      p._flat = flatState;
      if (flatBar[p.m] === undefined) flatBar[p.m] = flatState;   // the state each bar STARTS in
      if (!p.rest) seenSounding = true;
    });
    this._flatBar = flatBar;                  // per-bar summary for dev/_secmap.js; _flat is the truth
    // Count-off / tap-off (DYNAMICS-SPEC.md step 2): mark the leading run of stick-clicks (X on the
    // top line, step "d") that comes BEFORE the first real drum note — those play loud like an accent.
    // Leading rests are skipped; the first non-stick-click note ends the count-off. Stick-clicks that
    // appear later in the piece are never reached by this scan, so they stay at normal volume.
    for (var ci = 0; ci < this.perf.length; ci++) {
      var pc = this.perf[ci];
      if (pc.rest) continue;
      if (pc.head === "x" && String(pc.step).toLowerCase() === "d") pc.isTapoff = true;
      else break;
    }
    // Two buzz notes back-to-back still need a clearly audible gap between them (Anthony: "connected
    // buzzes don't sound good" — each note's own buzz must stay distinct, not blur into the next), on
    // top of whatever gap a single buzz already gets. Just a lookahead tag — no merging, every buzz note
    // still schedules its own fully independent bounce-train in _hit().
    for (var bi = 0; bi < this.perf.length - 1; bi++) {
      var pb = this.perf[bi], pn = this.perf[bi + 1];
      if (pb.buzz && !pb.rest && pn.buzz && !pn.rest) pb._buzzAdjacentNext = true;
    }
    this._computeDynamics();   // section dynamics (p/f/mf) + hairpin ramps → a velScale per event
    // Smooth the volume DROP across a run of back-to-back buzzes (e.g. accent-buzz -> tap-buzz -> tap-buzz):
    // each buzz's own articulation velocity is a hard-coded step (accent 0.85, tap 0.22), so with no smoothing
    // the very next buzz snaps straight down — a harsh cliff (Anthony, 2026-07-21). Walk each buzz run and
    // ease a DROP toward the previous (louder) buzz's level, cascading down a run of taps rather than jumping.
    // A buzz getting LOUDER stays untouched — only descents are softened. Mirrors the same vel formula _hit
    // uses (articVel * velScale, clamped, then the swellSoft accent taming) so the eased value lines up with
    // what the note would otherwise have played at.
    (function () {
      var perf2 = this.perf, D2 = this.DYN, prevVel = null;
      for (var i2 = 0; i2 < perf2.length; i2++) {
        var e2 = perf2[i2];
        if (!e2.buzz || e2.rest) { prevVel = null; continue; }
        var raw = Math.max(0, Math.min(1, this._articVel(e2, this._tapBaseFor(e2)) * this._dynScaleFor(e2)));
        if (e2.swellSoft && (e2.accent || e2.marcato)) raw *= 0.7;
        if (prevVel != null && raw < prevVel) {
          raw = raw + (prevVel - raw) * D2.BUZZ_DROP_SMOOTH;
          e2._buzzVelEff = raw;
        }
        prevVel = raw;
      }
    }).call(this);
    this.anchors = []; this.downbeats = []; this._metroPulseUnit = []; this._metroPulseGrid = []; this.extraHits = []; this.measures = []; var beat = 0, self = this;
    var groupedMetro = !!(this.cb && this.cb.metroGroupedPulse);   // SR Lab: click each measure's written grouping
    // running meter state so every note gets an M/B/P coordinate. B = beat-in-measure (1-indexed); P = the
    // note's 1-based slot within that beat COUNTING RESTS (rests hold a slot). beatUnit = the metric beat in
    // quarter-note units = 4/denominator (a quarter in 4/4; an eighth in 6/8).
    var curSig = (this.rdm.measures[0] && this.rdm.measures[0].timeSig) || [4, 4];
    var beatUnit = 4 / (curSig[1] || 4), measStart = 0, curBeatNo = -1, partialCtr = 0;
    // Metro click spacing (Anthony: a piece written with a dotted-quarter pulse — e.g. 6/8, 9/8, 12/8 —
    // should click on THAT pulse, not every plain quarter note). An explicit tempo mark's beat-unit wins
    // (it's the composer's own stated pulse, e.g. "♩. = 100"); otherwise a compound meter (x/8, x a
    // multiple of 3 above 3) defaults to the dotted-quarter pulse, and everything else keeps the plain
    // beat-unit-per-denominator pulse it always had. Carries forward measure to measure like curSig.
    var BEATUNIT_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };
    function pulseFromTempoMark(mk) { var base = BEATUNIT_Q[mk.beatUnit] || 1; return mk.dots ? base * 1.5 : base; }
    // metroAsymmetricSimple (a per-tool constructor opt, off by default): asymmetric/odd meters (5/8,
    // 7/8, 11/8, x/16...) otherwise click on the bare denominator unit — for 7/8 that's every 8th note.
    // Playalongs opts into just clicking straight quarters through those instead (Anthony: "I wanna just
    // hear the quarter note continue through"); Sightreading Lab keeps the finer click since its generated
    // rhythms need it to track cleanly. True compound meters (6/8, 9/8, 12/8) are unaffected either way —
    // their dotted-quarter pulse is the natural, expected click, not the "every 8th note" complaint.
    function pulseFromMeter(sig) {
      var num = sig[0], den = sig[1];
      if (den === 8 && num > 3 && num % 3 === 0) return 1.5;
      var plain = 4 / den;
      if (self.cb && self.cb.metroAsymmetricSimple && plain < 1) return 1;
      return plain;
    }
    var curPulse = pulseFromMeter(curSig);
    this.perf.forEach(function (p, i) {
      // The first event of each measure instance (e === 0) sits on that measure's downbeat.
      // Capturing the running beat here gives the REAL measure boundaries in playback order —
      // correct through pickups, meter changes, and repeats/voltas (which a fixed modulo misses).
      if (p.e === 0) {
        self.downbeats.push(beat);
        // open a measure-INSTANCE cell for loop selection; close the previous one at this boundary
        if (self.measures.length) { var pm = self.measures[self.measures.length - 1]; pm.endBeat = beat; pm.endIdx = i; }
        var st = out.staves && out.staves[p.m];   // exact bar-line x's from the renderer (same for every repeat instance)
        self.measures.push({ index: self.measures.length, srcIndex: p.m, startBeat: beat, endBeat: beat, startIdx: i, endIdx: i, x0: Infinity, x1: -Infinity, yTop: 0, yBot: 0, barLeft: st ? st.x0 : null, barRight: st ? st.x1 : null });
        var sm = self.rdm.measures[p.m];
        var sigChanged = !!(sm && sm.timeSig);
        if (sigChanged) curSig = sm.timeSig;   // carry the meter forward
        beatUnit = 4 / (curSig[1] || 4); measStart = beat; curBeatNo = -1; partialCtr = 0;
        if (sm && sm.tempoMark) curPulse = pulseFromTempoMark(sm.tempoMark);        // explicit mark wins
        else if (sigChanged) curPulse = pulseFromMeter(curSig);                    // else re-derive on a meter change
        self._metroPulseUnit.push(curPulse);                                       // parallel to downbeats/measures
        // Grouped-pulse grid: in SR Lab, click each measure's WRITTEN grouping (the generator's pulseMap,
        // in quarter units — e.g. [1.5,1,1] for a 7/8 written 3+2+2) so asymmetric meters click dotted-
        // quarter/quarter instead of every 8th. For simple/compound meters the pulseMap equals the uniform
        // pulse ([1,1,1,1] / [1.5,1.5]), so this is a no-op there. null when off / no pulseMap → uniform.
        self._metroPulseGrid.push((groupedMetro && sm && sm.pulseMap && sm.pulseMap.length) ? sm.pulseMap.slice() : null);
        // Extra voices (e.g. polyrhythm rim clicks) live on top of voice 1 in the SAME bar. Lay
        // their notes onto the shared beat clock starting at this measure's downbeat, so both parts
        // sound together. They drive audio only — voice 1 still owns the playhead and loop timing.
        var meas = self.rdm.measures[p.m];
        if (meas && meas.extraVoices) meas.extraVoices.forEach(function (voice) {
          var vb = 0;
          voice.events.forEach(function (ev) {
            if (!ev.rest) self.extraHits.push({ beat: beat + vb, ev: ev });
            vb += ev.beats || 0;
          });
        });
      }
      // this event's beat-in-measure + partial slot (rests count toward the slot number, so a rest-tap-tap
      // beat makes the taps P2/P3). Computed for EVERY event but only stored on sounding-note anchors.
      var bNo = Math.floor((beat - measStart) / beatUnit + 1e-9) + 1;
      if (bNo !== curBeatNo) { curBeatNo = bNo; partialCtr = 0; }
      partialCtr++;
      var c = out.notes[p.m] && out.notes[p.m][p.e];
      if (c) {
        self.anchors.push({ beat: beat, x: c.x, yTop: c.yTop, yBot: c.yBot, cTop: c.cTop, cBot: c.cBot,
                            mi: self.measures.length - 1, B: bNo, P: partialCtr, pIdx: i, rest: !!p.rest });
        var mc = self.measures[self.measures.length - 1];
        if (mc) { if (c.x < mc.x0) mc.x0 = c.x; if (c.x > mc.x1) mc.x1 = c.x; mc.yTop = c.yTop; mc.yBot = c.yBot; mc.cTop = c.cTop; mc.cBot = c.cBot; }
      }
      beat += p.beats || 0;
    });
    // flag the first / last sounding note of each measure — drives the "collapse to a whole-measure label"
    // rule and lets a whole-measure selection extend its highlight bar-line to bar-line.
    for (var ai = 0; ai < self.anchors.length; ai++) {
      var an = self.anchors[ai];
      an.isFirstInMeasure = (ai === 0 || self.anchors[ai - 1].mi !== an.mi);
      an.isLastInMeasure  = (ai === self.anchors.length - 1 || self.anchors[ai + 1].mi !== an.mi);
    }
    this.totalBeats = beat;
    if (self.measures.length) { var lm = self.measures[self.measures.length - 1]; lm.endBeat = beat; lm.endIdx = self.perf.length; }
    self.measures.forEach(function (m) { if (!(m.x1 >= m.x0)) { m.x0 = 0; m.x1 = 0; } });  // all-rest bar: no notehead x
    this._buildMetroGrid();  // the one continuous click grid, anchored at the count-off (see _buildMetroGrid)
    this._buildTempoMap();   // relative mid-piece tempo map (feature B) — null for single-tempo pieces
    this.extraHits.sort(function (a, b) { return a.beat - b.beat; });

    // per-line right edge: lets the playhead glide off the end of a system
    // (over the last note's duration) instead of freezing there before it jumps
    // to the next line. Keeps motion continuous without touching note timing.
    // Same pass also collects each system's top-Y (this._systemTops, top-to-bottom in reading order)
    // and the typical line-to-line spacing (this._lineH) — auto-scroll uses these to know how many
    // whole lines fit in the viewport, instead of scrolling continuously (see _autoScrollTick).
    var a = this.anchors, W = (out && out.width) || 0;
    this._systemTops = [];
    for (var i = 0; i < a.length; ) {
      var j = i;                                  // extend the run while we stay on the same line
      while (j + 1 < a.length && Math.abs(a[j + 1].yTop - a[i].yTop) < 2 && a[j + 1].x >= a[j].x) j++;
      var n = j - i + 1, gap = n > 1 ? (a[j].x - a[i].x) / (n - 1) : 28;   // typical note spacing on this line
      var endX = a[j].x + gap;
      if (W) endX = Math.min(endX, W - 6);
      var startX = a[i].x;                        // this line's first-note x — with lineEndX, gives the
      // Also store the line's BEAT span [startBeat, endBeat). Auto-scroll uses the beat fraction (not the x
      // fraction) so the scroll speed is CONSTANT per line — even spacing means x-per-time varies with the
      // rhythm, which made the scroll speed up/slow within a line (Anthony, 2026-07-25).
      var startBeat = a[i].beat, endBeat = (a[j + 1] ? a[j + 1].beat : this.totalBeats);
      for (var k = i; k <= j; k++) { a[k].lineEndX = endX; a[k].lineStartX = startX; a[k].lineStartBeat = startBeat; a[k].lineEndBeat = endBeat; }
      this._systemTops.push(a[i].yTop);

      // Monotone-cubic tangents (Fritsch–Carlson) for THIS line's notes. The cursor still lands
      // exactly on every notehead at its beat, but the glide between them carries a CONTINUOUS
      // speed instead of snapping to a new pace at each note and lurching across barlines (where
      // VexFlow's layout leaves extra space). Result: one even, flowing motion. Monotone = the
      // cursor can never overshoot or drift backward between two notes.
      var n2 = j - i + 1;
      if (n2 === 1) { a[i].slope = 0; }
      else {
        for (var s = i; s < j; s++) a[s]._d = (a[s + 1].x - a[s].x) / ((a[s + 1].beat - a[s].beat) || 1);
        a[i].slope = a[i]._d;                     // one-sided tangent at the line's first note
        a[j].slope = a[j - 1]._d;                 // and its last note
        for (var s2 = i + 1; s2 < j; s2++) {
          var d0 = a[s2 - 1]._d, d1 = a[s2]._d;
          if (d0 * d1 <= 0) { a[s2].slope = 0; }  // a peak/flat: zero tangent keeps it monotone
          else {
            var mm = (d0 + d1) / 2, lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
            a[s2].slope = Math.abs(mm) > lim ? (mm < 0 ? -lim : lim) : mm;
          }
        }
        for (var s3 = i; s3 <= j; s3++) delete a[s3]._d;
      }
      i = j + 1;
    }
    // Typical system-to-system gap (median of the DISTINCT visual systems, sorted top-to-bottom) — a
    // repeated section revisits the same systems more than once in PLAYBACK order (this._systemTops as
    // pushed above), which would otherwise inject backward/zero gaps into the math; dedupe first so a
    // repeat can't skew (or zero out) the spacing.
    var uniqueTops = this._systemTops.slice().sort(function (x, y) { return x - y; })
      .filter(function (v, idx, arr) { return idx === 0 || v - arr[idx - 1] > 2; });
    if (uniqueTops.length > 1) {
      var gaps = [];
      for (var gi = 1; gi < uniqueTops.length; gi++) gaps.push(uniqueTops[gi] - uniqueTops[gi - 1]);
      gaps.sort(function (x, y) { return x - y; });
      this._lineH = gaps[gaps.length >> 1] || 0;   // median, so one odd-tall line (e.g. a tempo mark) can't skew it
    } else {
      this._lineH = 0;   // single line of music — no line-to-line spacing to speak of
    }

    // ---- cursor-only anchor track: even barline-to-barline travel through rests (Anthony, 2026-07-19) ----
    // A rest gets ONE anchor at its glyph, centered in the bar. Using that for cursor motion made the
    // playhead jump to mid-bar at the downbeat and hover there — "skipping ahead" into a bar that hadn't
    // started counting. The wanted behavior is simple: the cursor should travel EVENLY from the left
    // barline to the right barline across a rest measure's full duration. So we build a SEPARATE cursor
    // track (loop-selection / M:B:P labels keep using the untouched this.anchors) that:
    //   • DROPS every rest anchor (its centered glyph x is not where the cursor should sit), and
    //   • when a measure STARTS with a rest (a whole-rest bar, or any bar with a leading rest), pins a
    //     waypoint at that bar's LEFT barline on its downbeat.
    // The travel to the right barline then completes naturally: the NEXT thing in the track is either the
    // next bar's own left-barline waypoint (adjacent bars share that x = this bar's right barline) or the
    // next sounding note — so the cursor sweeps left→right across the rest exactly over its beats. Note
    // measures are unchanged (their note anchors carry through as before).
    // A note followed by trailing rests IN THE SAME measure (e.g. an 8th note then 3 beats of rests, no
    // new measure boundary crossed) gets no waypoint above — that logic only fires on a measure's FIRST
    // anchor. If the very next SOUNDING note also isn't preceded by its own leading-rest waypoint, the gap
    // between them held nothing but dropped rest anchors, yet _drawPlayheadAtBeat saw two plain (non-
    // waypoint) anchors and glided the eased note→note curve across it — tangent-limited by the DENSE
    // note spacing right before it, so the cursor barely crept forward before rushing to catch up (Anthony,
    // 2026-07-21: "didn't travel across this entire measure, it like barely moved"). Fix: flag the anchor
    // whenever a rest was dropped right after it, so the draw step can force even/linear motion across that
    // span regardless of whether either end happens to be a synthetic waypoint.
    var cursorA = [];
    for (var wi = 0; wi < this.anchors.length; wi++) {
      var A2 = this.anchors[wi];
      var firstOfMeasure = (wi === 0 || this.anchors[wi - 1].mi !== A2.mi);
      if (firstOfMeasure && A2.rest) {
        var wm = this.measures[A2.mi];
        if (wm && wm.barLeft != null) {
          cursorA.push({ beat: wm.startBeat, x: wm.barLeft, yTop: A2.yTop, yBot: A2.yBot,
                         cTop: A2.cTop, cBot: A2.cBot, mi: A2.mi, slope: null, _waypoint: true });
        }
      }
      if (!A2.rest) cursorA.push(A2);
      else if (cursorA.length) cursorA[cursorA.length - 1]._restAhead = true;
    }
    // Fallback: if a piece were somehow ALL rests (no sounding notes survived above), keep the raw anchors
    // so the cursor still has something to ride rather than vanishing.
    this._cursorAnchors = cursorA.length ? cursorA : this.anchors;

    // REFIT the monotone-cubic glide tangents + line-end x ON THE CURSOR TRACK (Anthony, 2026-07-20).
    // The block above fitted them to this.anchors, but the cursor interpolates between CURSOR anchors —
    // which DROP rests and INSERT barline waypoints. The Fritsch–Carlson "never drifts backward between two
    // points" guarantee only holds for the exact points the tangents were fitted to; using the note-anchor
    // tangents across a now-dropped rest let the spline overshoot and briefly run BACKWARD inside rests
    // ("moves forward then back"). Refitting on the cursor track makes every segment strictly forward, so
    // the cursor sweeps rests (and whole-rest bars) evenly left→right and never reverses.
    (function fitGlide(arr) {
      for (var i = 0; i < arr.length; ) {
        var j = i;
        while (j + 1 < arr.length && Math.abs(arr[j + 1].yTop - arr[i].yTop) < 2 && arr[j + 1].x >= arr[j].x) j++;
        var nn = j - i + 1, gap = nn > 1 ? (arr[j].x - arr[i].x) / (nn - 1) : 28;
        var endX = arr[j].x + gap;
        if (W) endX = Math.min(endX, W - 6);
        for (var k = i; k <= j; k++) arr[k].lineEndX = endX;
        if (nn === 1) { arr[i].slope = 0; }
        else {
          for (var s = i; s < j; s++) arr[s]._d = (arr[s + 1].x - arr[s].x) / ((arr[s + 1].beat - arr[s].beat) || 1);
          arr[i].slope = arr[i]._d; arr[j].slope = arr[j - 1]._d;
          for (var s2 = i + 1; s2 < j; s2++) {
            var d0 = arr[s2 - 1]._d, d1 = arr[s2]._d;
            if (d0 * d1 <= 0) { arr[s2].slope = 0; }
            else { var mm = (d0 + d1) / 2, lim = 3 * Math.min(Math.abs(d0), Math.abs(d1)); arr[s2].slope = Math.abs(mm) > lim ? (mm < 0 ? -lim : lim) : mm; }
          }
          for (var s3 = i; s3 <= j; s3++) delete arr[s3]._d;
        }
        i = j + 1;
      }
    })(this._cursorAnchors);
  };

  /* ---------- transport ---------- */
  RDMPlayer.prototype.play = function () { if (!this.perf || this.playing) return; this._startPlay(); };
  RDMPlayer.prototype.pause = function () { this._stopPlay(); };
  RDMPlayer.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };
  // stop rewinds to the very start — the cursor's about to jump far from wherever the view currently
  // sits, so drop the tracked auto-scroll page (see the same note in load()) and re-adopt fresh.
  /* Stopping puts the cursor back on beat 1, so the PAGE has to go back with it (Anthony, 2026-08-03).
     Nothing else can do it: _stopPlay has already cancelled the rAF, so _autoScrollTick — the only thing
     that ever touches scrollTop — will never run again to notice the cursor moved. Left alone the reader
     is stranded at the bottom of the sheet with the playhead sitting on a bar they cannot see.
     Every scroll-follow field is cleared first so the next play starts from a clean slate rather than
     easing down from a stale target, and _rewinding is dropped because the jump below is instant — there
     is no journey left for it to keep unlocked. */
  RDMPlayer.prototype.stop = function () {
    this._stopPlay(); this.idx = 0; this.cumBeat = 0;
    this._scrollTarget = this._pageTop = this._autoTarget = null;
    this._autoY = this._autoBeat = this._autoYTop = null; this._scrollVel = 0; this._rewinding = false;
    this._scrollToTop();
    this._clearPlayhead(); this._emitTimeAt(0);
  };
  /* Snap the sheet back to the top. Only used when playback has already stopped, so it is deliberately
     instant rather than eased — there is no cursor left in motion for a glide to stay in step with, and
     the "never scroll up while playing" rule this would otherwise fight is not in force. Guarded the
     same way _autoScrollTick is: the reader owns the scrollbar when following is off. */
  RDMPlayer.prototype._scrollToTop = function () {
    if (this.followScroll === false) return;
    var host = this.host, sc = host && host.parentElement;
    if (!sc) return;
    if (sc.scrollHeight - sc.clientHeight <= 8) return;      // nothing to scroll
    sc.scrollTop = 0;
  };
  Object.defineProperty(RDMPlayer.prototype, "isPlaying", { get: function () { return this.playing; } });

  RDMPlayer.prototype._startPlay = function (fromBeat) {
    this._ensureAudio();
    var t0 = this.actx.currentTime;
    this.master.gain.cancelScheduledValues(t0); this.master.gain.setValueAtTime(1, t0);
    this.playing = true; this._sched = [];
    /* BUG (Anthony, 2026-07-31): seeking again while a loop count-off cue was still sounding produced
       TWO count-offs at once. This used to just null out `_coGap` — clearing the engine's own bookkeeping
       — but the PREVIOUS cue's clicks were already committed to the audio graph as real scheduled events
       (see _beginCountOff's `this._hit(CO_EVENT, t)` loop) and kept sounding regardless. _cancelCountOff()
       is the existing kill switch for exactly this (built for "stop playback mid-cue"; see its own
       comment) — it was just never wired into the "starting a fresh cue" path, only the "stopping
       entirely" one. Any count-off still in flight is now always stale the moment _startPlay runs (we're
       about to begin a whole new playback pass from `fromBeat`), so silencing it unconditionally here is
       always correct, not just for the seek case. */
    this._cancelCountOff();
    if (fromBeat == null) fromBeat = (this.idx > 0 ? this.cumBeat : 0);
    this.cumBeat = fromBeat;
    this.spb = 60 / this.tempo;
    this.audioStart = t0 + 0.1;
    this.anchorTime = this.audioStart; this.anchorBeat = fromBeat; this._reanchorI();   // the shared clock
    /* Count you in. ALWAYS when this pass starts at the top of the piece (or of a loop window) — that
       one does not depend on the switch, see _countOffArmed. A resume or a seek lands mid-piece, so
       `atStart` is false there and the switch decides, exactly as before.
       It re-anchors the clock, so it must run before anything reads a time. */
    var atStart = Math.abs(fromBeat - this._loopLo()) < 1e-9;
    this._beginCountOff(fromBeat, this.audioStart, atStart);
    this.metroBeat = this._nextMetroPulseAt(fromBeat);               // next click at/after the start (honors the active pulse)
    this._extraCursorBeat = fromBeat;                                // next absolute beat to schedule extra voices from
    this._lastSchedTime = this.audioStart - 0.001;
    this._scheduler();
    this._startPlayhead();
    this._emit("onState", true);
  };
  /* A FRESH note bus, so notes already committed to the audio graph can never come back.

     Muting is not stopping. Every note is a real scheduled node — `_click` calls o.start(time) — and the
     scheduler commits ~120ms ahead, while ONE buzz lays down ~20 bounces and a roll or flam several more,
     so at a slow tempo there can be a third of a second of sound already promised. _stopPlay used to set
     master.gain to 0, which silences what is sounding NOW but leaves every pending node attached and
     waiting. _startPlay then sets that same gain back to 1 — and anything still pending fires.

     That is the glitch Anthony reported (2026-08-07): "I'm on the last measure almost done, and I
     randomize or generate a new exercise, and then I play back the new exercise, during the count off, a
     random drum hit happens." load() calls _stopPlay, the count-off inserts a gap of its own, and the old
     piece's last notes land inside it.

     Swapping the bus is the same trick _beginCountOff already uses for the cue, and for the same stated
     reason: a node stays attached to the bus it was connected to, so a DISCONNECTED bus can never be
     un-silenced by a later gain change. The old bus is left to garbage collection with its notes on it. */
  RDMPlayer.prototype._freshVoiceBus = function () {
    if (!this.actx || !this._outBoost) return;
    var old = this.master;
    var bus = this.actx.createGain();
    bus.gain.value = 1;
    bus.connect(this._outBoost);
    this.master = bus;
    if (old && old !== bus) { try { old.disconnect(); } catch (e) {} }
    // the count-off cue hangs off the note bus — move it, or the next cue routes into a dead node
    if (this._coBus) { try { this._coBus.disconnect(); } catch (e) {} try { this._coBus.connect(bus); } catch (e) {} }
  };
  RDMPlayer.prototype._stopPlay = function () {
    this.playing = false; clearTimeout(this._timer); this._cancelCountOff();   // stop kills a cue mid-flight
    if (this.master) { var t = this.actx.currentTime; this.master.gain.cancelScheduledValues(t); this.master.gain.setValueAtTime(0, t); }
    /* Mute first (kills what is audible this instant without a click), THEN orphan the bus so nothing
       still pending on it can be resurrected by the next _startPlay. */
    this._freshVoiceBus();
    this._stopPlayhead();
    this._emit("onState", false);
  };
  RDMPlayer.prototype._scheduler = function () {
    var self = this, now = this.actx.currentTime, horizon = now + 0.12;
    var hasWin = this._looping() && this.loopEnd != null;          // looping a sub-section of measures?
    var startIdx = hasWin ? this.loopStartIdx : 0;
    var endIdx   = hasWin ? this.loopEndIdx   : this.perf.length;
    while (this._timeForBeat(this.cumBeat) < horizon) {
      // wrap at the window edge (or the piece end). A stray idx outside the window (e.g. from a seek)
      // is pulled back to the window start too, so the loop can never escape its bounds.
      if (hasWin ? (this.idx < startIdx || this.idx >= endIdx) : (this.idx >= this.perf.length)) {
        if (!hasWin && this.mode === "sequence") { this._handoffAt(this._timeForBeat(this.cumBeat)); return; }
        this.idx = startIdx;
        /* BACK TO THE TOP OF THE PIECE = the beginning, so it counts you in whatever the switch says
           (Anthony, 2026-08-07: "when an exercise loops back to the beginning make the count off happen
           again no matter what"). That is the same rule as _startPlay, not a new one: the top of a piece
           is always counted, and the switch governs the cue before a MID-PIECE repeat — looping bars 9
           to 12 over and over is where a four-beat cue every pass becomes noise.
           _loopLo() is 0 both when no window is set (a plain top-to-bottom repeat) and when the window
           itself starts at bar 1, and both of those are "the beginning" to a student. */
        var backToTop = Math.abs(this._loopLo()) < 1e-9;
        if (this._countOffArmed(backToTop)) {
          // Count you into the repeat. Let the boundary's automation (Auto Randomize / Bump) settle the
          // tempo FIRST so the cue counts at the tempo you're about to play; _coArming suppresses
          // setTempo's immediate re-schedule so no note gets committed at a pre-gap time.
          this._coArming = true; this._onLoopBoundary(); this._coArming = false;
          this._beginCountOff(this.cumBeat, null, backToTop);
        } else this._onLoopBoundary();
        /* RE-GRID THE METRONOME ON EVERY PASS (Anthony, 2026-07-25: "start playback in a measure that
           starts on a non-downbeat partial and the met carries on incorrectly — it should always play
           relative to how the count-off starts the piece").
           metroBeat advances by whole pulses in RAW beat space, but a loop window that is NOT a whole
           number of pulses long (any note-precise loop starting/ending off the beat) makes the FOLDED
           position slide by the remainder on each pass, so the clicks walk off the piece's real beat grid
           and never recover. Re-deriving it from the piece's downbeat grid at the boundary pins every pass
           back to the true grid. For a measure-aligned loop this returns the same value (a no-op). */
        this.metroBeat = this._nextMetroPulseAt(this.cumBeat);
      }
      var e = this.perf[this.idx];
      var t = Math.max(this._timeForBeat(this.cumBeat), this._lastSchedTime + 0.0005);  // keep onsets monotonic across tempo jumps
      this._hit(e, t, this.cumBeat);
      // "Notes played" counter: one per PRIMARY notehead the transport actually reaches (rests excluded).
      // A flam is one event with a grace FLAG (e.flam) — the grace is not a separate perf entry — so this
      // counts primary notes only, never graces. Rolls/buzzes are one notehead too. (Anthony, 2026-07-25)
      // Count-off / tap-off stick clicks are a cue, not music you played, so they never count
      // (Anthony, 2026-07-25). Same flag the loop count-off below reuses.
      if (!e.rest && !e.isTapoff) this._notesAcc = (this._notesAcc || 0) + 1;
      this._sched.push({ t: t, beat: this.cumBeat });
      this._lastSchedTime = t;
      this.cumBeat += (e.beats || 0); this.idx++;
    }
    if (this._notesAcc) { this._emit("onNote", this._notesAcc); this._notesAcc = 0; }
    // Metro + notes share the same beat->time mapping, so this can run either side of the note loop —
    // EXCEPT that a loop count-off inserts a time gap when the note loop crosses the window edge. Metro
    // first meant the new pass's downbeat click got committed at its PRE-gap time, i.e. it fired on the
    // first count-off click and the real downbeat got no click at all. Scheduling after the notes means
    // the gap is already in the clock, so the click lands on the beat you actually resume on.
    this._scheduleMetro(horizon);
    if (!hasWin) this._scheduleExtraVoices(horizon, now);   // extra voices ride the full-piece loop; skip while windowed
    while (this._sched.length > 2 && this._sched[1].t < now - 0.5) this._sched.shift();
    if (this.playing) this._timer = setTimeout(function () { self._scheduler(); }, 25);
  };
  RDMPlayer.prototype._handoffAt = function (at) {
    var self = this;
    this.playing = false; clearTimeout(this._timer);
    this._timer = setTimeout(function () {
      self._stopPlayhead(); self._emit("onState", false);
      if (self._sequenceHandler) self._sequenceHandler();
    }, Math.max(0, (at - this.actx.currentTime) * 1000) + 120);
  };
  RDMPlayer.prototype._onLoopBoundary = function () {
    this._loopIndex++; this._emit("onLoop", this._loopIndex);
    if (this.auto === "randomize") {
      this._repCounter++;
      var rReps = Math.max(1, parseInt(this.randomCfg.reps, 10) || 1);
      if (this._repCounter % rReps === 0) { this._repCounter = 0; this._pickRandomTempo(); }
    } else if (this.auto === "bump") {
      this._repCounter++;
      var bReps = Math.max(1, parseInt(this.bumpCfg.reps, 10) || 1);
      if (this._repCounter % bReps === 0) { this._repCounter = 0; this._bumpOnce(); }
    }
  };

  /* Where a seek/scrub to `target` is actually allowed to land. With a loop window active, a point
     OUTSIDE the window snaps to the window's START (Anthony, 2026-07-31: "if somebody clicks outside of
     the bounds of the looping section on the progress bar then it should just automatically make the
     cursor go to the beginning of the loop"); a point already inside is left exactly where it is. This is
     also what keeps the audio clock inside the window, which is what stops the metronome desyncing. */
  RDMPlayer.prototype._clampSeekBeat = function (target) {
    if (!this.hasLoop()) return clamp(target, 0, this.totalBeats);
    var lo = this._loopLo(), hi = this._loopHi();
    return (target < lo || target >= hi) ? lo : target;
  };

  /* ---------- scrub preview (drag the progress bar without touching audio) ----------
     The cursor follows your finger through the music while you drag (Anthony, 2026-07-31), but nothing
     is committed until you let go — see the progress-bar handler in each tool. _scrubBeat overrides what
     the playhead RAF draws, otherwise the running audio clock would repaint over the preview every frame. */
  RDMPlayer.prototype.scrubPreview = function (fraction) {
    if (!this.perf || !this.totalBeats) return 0;
    var b = this._clampSeekBeat(clamp(fraction, 0, 1) * this.totalBeats);
    this._scrubBeat = b;
    this._drawPlayheadAtBeat(b);
    this._emitTimeAt(b);
    return b;
  };
  RDMPlayer.prototype.endScrub = function () { this._scrubBeat = null; };

  /* ---------- seek (restart from a beat) ---------- */
  RDMPlayer.prototype.seek = function (fraction) {
    if (!this.perf || !this.totalBeats) return;
    var target = clamp(fraction, 0, 1) * this.totalBeats;
    /* BUG (Anthony, 2026-07-31): scrubbing the progress bar during a loop could throw the metronome and
       the music out of sync. Root cause — the progress bar's fraction is always whole-piece (see
       _emitTimeAt's "bar tracks beats — position in the piece"), so a drag while a loop window is active
       could land `target` outside [loopLo, loopHi). _scheduler() already guards `this.idx` against that
       ("a stray idx outside the window... is pulled back to the window start"), but it never corrected
       `cumBeat` — and cumBeat, not idx, is what both the note's audio TIME (_timeForBeat) and the
       metronome's re-grid (_nextMetroPulseAt) are computed from. So the note got pulled back into the
       loop while its scheduled TIME stayed keyed to the stray, un-folded beat: exactly a note/metronome
       desync, not just a wrong note.
       Fix: fold the target through the SAME window math _displayBeat() already uses for the ordinary,
       already-correct loop wrap — so a scrub while looping can never land outside the window in the
       first place, using logic that's proven to keep notes and the metronome aligned rather than new
       clamping logic that would need its own proving. No-ops (identity) whenever no loop is set.
       REFINED (Anthony, 2026-07-31): outside the window now snaps to the loop's START rather than wrapping
       to an arbitrary point inside it — see _clampSeekBeat. */
    target = this._clampSeekBeat(target);
    this._scrubBeat = null;   // a committed seek always ends any preview override
    var b = 0, i = 0;
    for (; i < this.perf.length; i++) { var nb = b + (this.perf[i].beats || 0); if (nb > target + 1e-6) break; b = nb; }
    this.idx = i % this.perf.length; this.cumBeat = b;
    // jumping to a new spot — re-adopt the auto-scroll page fresh, same reason as load()/stop().
    // _autoTarget is the "never scroll up" floor: a deliberate seek BACKWARDS must be allowed to move
    // the page up, so the floor has to be dropped here or the view would stay stuck below the cursor.
    this._scrollTarget = this._pageTop = this._autoTarget = null;
    if (this.playing) this._startPlay(b);
    else { this._drawPlayheadAtBeat(b); this._emitTimeAt(b); }
  };

  // jump playback to the note nearest a clicked (x,y) in the score's pixel space
  RDMPlayer.prototype.seekToXY = function (px, py) {
    if (!this.anchors || !this.anchors.length || !this.totalBeats) return;
    var best = null, bestD = Infinity;
    for (var i = 0; i < this.anchors.length; i++){
      var a = this.anchors[i];
      var dy = Math.abs((a.yTop + a.yBot) / 2 - py);   // weight same-line proximity heavily
      var d = Math.abs(a.x - px) + dy * 3;
      if (d < bestD){ bestD = d; best = a; }
    }
    if (best) this.seek(best.beat / this.totalBeats);
  };
  RDMPlayer.prototype.rewind = function () { this.seek(0); };
  // seek to the previous / next measure downbeat (J / L keys). dir<0 = back, dir>0 = forward.
  RDMPlayer.prototype.seekMeasure = function (dir) {
    var d = this.downbeats;
    if (!d || !d.length || !this.totalBeats) return;
    var cur = this.playing ? this._beatAt(this.actx.currentTime) : this.cumBeat;
    cur = ((cur % this.totalBeats) + this.totalBeats) % this.totalBeats;   // fold loop overflow back into the piece
    var idx = 0;
    for (var i = 0; i < d.length; i++) { if (d[i] <= cur + 1e-6) idx = i; else break; }
    var target;
    if (dir < 0) target = (cur - d[idx] > 0.3) ? d[idx] : (idx > 0 ? d[idx - 1] : 0);   // restart this bar, or the previous
    else target = (idx + 1 < d.length) ? d[idx + 1] : d[idx];                            // next bar, or re-cue the last
    this.seek(clamp(target / this.totalBeats, 0, 1));
  };

  /* ---------- tempo ---------- */
  RDMPlayer.prototype.setTempo = function (bpm, opts) {
    opts = opts || {};
    bpm = clamp(Math.round(bpm), this.minTempo, this.maxTempo);
    if (opts.throttle) { var nowMs = Date.now(); if (nowMs - this._lastTempoChangeAt < 400) return this.tempo; this._lastTempoChangeAt = nowMs; }
    else this._lastTempoChangeAt = Date.now();
    if (bpm === this.tempo) return this.tempo;
    if (this.playing && this.actx) {
      // Re-anchor the shared clock at the CURRENT beat, then change spb. The playhead stays
      // continuous (same beat at this instant) and the new tempo applies immediately to BOTH
      // the upcoming notes and the metronome (they read the same anchor) — so nothing drifts.
      var t = this.actx.currentTime, g = this._coGap;
      var midCue = !!(g && t < g.until);
      // the normal path's anchor beat MUST be read under the OLD spb, so it happens before the change
      if (!midCue) { this.anchorBeat = this._beatAt(t); this.anchorTime = t; }
      this.spb = 60 / bpm;
      this.tempo = bpm;
      if (midCue) {
        /* Mid count-off. The cue's clicks are committed to the audio graph up front, so the new tempo
           cannot reach them by itself — _retimeCountOff re-schedules the ones that have not sounded yet
           (Anthony, 2026-08-07). This used to leave the gap alone and apply the tempo only to the music
           after it, which counted you in at one speed and dropped you into another.
           Run AFTER spb/tempo are updated, so the clicks it schedules are voiced at the new tempo. Anchor
           on whatever end time it lands on; if it declines (nothing left to move), fall back to the gap's
           existing end, which is the old behaviour. */
        var newUntil = this._retimeCountOff(this.spb);
        this.anchorBeat = g.beat; this.anchorTime = (newUntil != null) ? newUntil : g.until;
      }
      this._reanchorI();   // re-cache the map integral at the current beat under the new base tempo
      // _coArming: we're inside the loop-boundary handler and a count-off gap is about to be inserted —
      // scheduling now would commit notes at pre-gap times. The caller's scheduler loop tops up instead.
      if (!this._coArming) { clearTimeout(this._timer); this._scheduler(); }   // top up the schedule at the new tempo right away
    } else {
      this.tempo = bpm;
    }
    this._emit("onTempoChange", bpm);
    this._emitTimeAt(this.cumBeat);
    this._updateTempoMarkValues();   // the sheet's "♩ = N" markings scale with the tempo
    return bpm;
  };
  RDMPlayer.prototype.nudgeTempo = function (delta) { return this.setTempo(this.tempo + delta); };
  RDMPlayer.prototype.getRange = function () { return { min: this.minTempo, max: this.maxTempo }; };

  /* ---------- mode + automation ---------- */
  RDMPlayer.prototype.setMode = function (mode, sequenceHandler) {
    this.mode = mode === "sequence" ? "sequence" : "loop";
    this._sequenceHandler = (this.mode === "sequence") ? (sequenceHandler || null) : null;
    if (this.mode === "sequence") this.auto = null;
  };
  RDMPlayer.prototype.setAuto = function (which, cfg) {
    this.auto = which || null;
    if (which === "randomize" && cfg) this.randomCfg = Object.assign({}, this.randomCfg, cfg);
    if (which === "bump" && cfg) this.bumpCfg = Object.assign({}, this.bumpCfg, cfg);
    this._repCounter = 0; this._prevRandom = null;
  };
  RDMPlayer.prototype.configureRandomize = function (cfg) { this.randomCfg = Object.assign({}, this.randomCfg, cfg || {}); };
  RDMPlayer.prototype.configureBump = function (cfg) { this.bumpCfg = Object.assign({}, this.bumpCfg, cfg || {}); };
  RDMPlayer.prototype.setMetronome = function (on) { this.metroOn = !!on; };

  RDMPlayer.prototype._bumpOnce = function () { var step = parseInt(this.bumpCfg.step, 10); if (isNaN(step)) step = 0; this.setTempo(this.tempo + step, { throttle: true }); };
  RDMPlayer.prototype.bumpNow = function () { var step = parseInt(this.bumpCfg.step, 10); if (isNaN(step)) step = 0; return this.setTempo(this.tempo + step); };
  RDMPlayer.prototype._randomRange = function () {
    var min = this.randomCfg.min, max = this.randomCfg.max;
    min = (min == null || min === "") ? this.minTempo : parseInt(min, 10);
    max = (max == null || max === "") ? this.maxTempo : parseInt(max, 10);
    min = clamp(min, this.minTempo, this.maxTempo); max = clamp(max, this.minTempo, this.maxTempo);
    if (min > max) { var t = min; min = max; max = t; }
    return { min: min, max: max };
  };
  RDMPlayer.prototype._pickRandomTempo = function (immediate) {
    var r = this._randomRange(), span = r.max - r.min, pick;
    var needDistance = this._prevRandom != null && span >= 8;
    if (!needDistance) pick = Math.floor(Math.random() * (span + 1)) + r.min;
    else {
      var found = false;
      for (var i = 0; i < 25; i++) { var cand = Math.floor(Math.random() * (span + 1)) + r.min, d = Math.abs(cand - this._prevRandom); if (d >= 8 && d <= 90) { pick = cand; found = true; break; } }
      if (!found) pick = Math.floor(Math.random() * (span + 1)) + r.min;
    }
    this._prevRandom = pick;
    return this.setTempo(pick, { throttle: !immediate });
  };
  RDMPlayer.prototype.randomizeNow = function () { return this._pickRandomTempo(true); };

  /* ---------- traveling playhead ---------- */
  RDMPlayer.prototype._sizePlayhead = function () {
    if (!this.phCanvas || !this.out) return;
    var dpr = global.devicePixelRatio || 1, w = this.out.width, h = this.out.height, c = this.phCanvas;
    // The score SVG is CSS width:100% (scales to the container), but VexFlow gives it a FIXED inline
    // width — so out.width can differ from the container by a few px (e.g. once a scrollbar appears).
    // A canvas pinned to out.width px then drifts off the notes, worse toward the right of each line.
    // Fix: give the canvas the SAME responsive box as the SVG (width:100% + height:auto). Its intrinsic
    // resolution stays out.width×out.height, so the drawn coords scale to the container exactly like the
    // notes, keeping the cursor pixel-locked at any width.
    c.width = Math.max(1, w * dpr); c.height = Math.max(1, h * dpr);
    c.style.width = "100%"; c.style.height = "auto";
    this.phCtx = c.getContext("2d"); this.phCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.selCanvas) {                      // keep the selection overlay locked to the same box
      var sc = this.selCanvas;
      sc.width = Math.max(1, w * dpr); sc.height = Math.max(1, h * dpr);
      sc.style.width = "100%"; sc.style.height = "auto";
      this.selCtx = sc.getContext("2d"); this.selCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };
  RDMPlayer.prototype._clearPlayhead = function () { if (this.phCtx) this.phCtx.clearRect(0, 0, this.phCanvas.width, this.phCanvas.height); this._phRect = null; };
  RDMPlayer.prototype._beatFromSchedule = function (now) {
    var s = this._sched, n = s.length; if (n === 0) return null;
    if (now <= s[0].t) return s[0].beat;
    if (now >= s[n - 1].t) return s[n - 1].beat;
    var lo = 0, hi = n - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (s[mid].t <= now) lo = mid; else hi = mid - 1; }
    var A = s[lo], B = s[lo + 1], f = (now - A.t) / ((B.t - A.t) || 1);
    return A.beat + (B.beat - A.beat) * clamp(f, 0, 1);
  };
  RDMPlayer.prototype._anchorAt = function (beat) {
    var a = this._cursorAnchors || this.anchors; if (!a || !a.length) return 0; var lo = 0, hi = a.length - 1;
    if (beat <= a[0].beat) return 0; if (beat >= a[hi].beat) return hi;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (a[mid].beat <= beat) lo = mid; else hi = mid - 1; } return lo;
  };
  RDMPlayer.prototype._drawPlayheadAtBeat = function (beat) {
    var a = this._cursorAnchors || this.anchors, ctx = this.phCtx; if (!a || !a.length || !ctx) return;
    // Erase only the previous cursor footprint, not the whole canvas. On long scores the canvas is very
    // tall, so a full clear every animation frame is what makes the motion stutter; clearing just the
    // last rect (+1px AA margin) keeps the redraw cheap and the glide buttery at the display refresh rate.
    var p = this._phRect;
    if (p) ctx.clearRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2);
    var i = this._anchorAt(beat), A = a[i], B = a[i + 1];
    var x = A.x, yTop = A.yTop, yBot = A.yBot, cTopV = A.cTop, cBotV = A.cBot;
    var dur = (B ? (B.beat - A.beat) : (this.totalBeats - A.beat)) || 1;   // duration of the note we're on
    var f = clamp((beat - A.beat) / dur, 0, 1);
    if (B && Math.abs(B.yTop - A.yTop) < 2 && B.x >= A.x && !A._waypoint && !B._waypoint && !A._restAhead) {
      // same line, note→note: glide along the monotone-cubic curve through the noteheads, so the speed
      // flows continuously instead of jerking at each note / barline. Cubic Hermite still hits A.x at f=0
      // and B.x at f=1, so the cursor is exactly on the note when the note sounds.
      var h = (B.beat - A.beat) || 1, t2 = f * f, t3 = t2 * f;
      var mA = (A.slope != null ? A.slope : (B.x - A.x) / h);
      var mB = (B.slope != null ? B.slope : mA);
      x = (2 * t3 - 3 * t2 + 1) * A.x + (t3 - 2 * t2 + f) * h * mA
        + (-2 * t3 + 3 * t2) * B.x + (t3 - t2) * h * mB;
    } else if (B && Math.abs(B.yTop - A.yTop) < 2 && B.x >= A.x) {
      // same line but a REST segment (a barline waypoint is one endpoint, OR A._restAhead means rests were
      // dropped between A and B even though neither happens to be a synthetic waypoint — e.g. a note
      // followed by trailing rests in its own measure with no leading-rest measure after it): move at a
      // CONSTANT rate so the cursor sweeps a rest — and a whole-rest bar — perfectly EVENLY left→right, no
      // easing curve (Anthony, 2026-07-20; extended 2026-07-21 to also cover the A._restAhead case).
      x = A.x + (B.x - A.x) * f;
    } else {
      // Next note is on a DIFFERENT line (system break) or this is the very last note. The cursor should
      // NOT visibly travel down/across to the next line — it finishes THIS line by gliding off its right
      // edge, staying on this line's row (yTop/cTop unchanged), then INSTANTLY appears on the next line
      // when the beat lands on B and the anchor index advances (Anthony, 2026-07-19: "it should just
      // instantly appear at the next line," not sweep there).
      x = A.x + ((A.lineEndX != null ? A.lineEndX : A.x) - A.x) * f;
    }
    this._curYTop = yTop;                            // the system the cursor is on now — drives auto-scroll
    // the DISPLAYED beat behind that position. _autoScrollTick uses it to tell a real jump backwards
    // (loop wrap — which is a modulo inside _displayBeat, so there is no event to hook — or a seek)
    // apart from a one-frame wobble, which must never be shown as an upward scroll.
    this._curBeat = beat;
    // How far the cursor is through THIS line, by BEAT (0 at the line's first beat, 1 at its last) — NOT by
    // x. Beat is linear in time at a fixed tempo, so the auto-scroll advances at a constant speed across the
    // line regardless of how the rhythm bunches the noteheads. (Anthony, 2026-07-25)
    var _lsb = (A.lineStartBeat != null ? A.lineStartBeat : A.beat), _leb = (A.lineEndBeat != null ? A.lineEndBeat : A.beat);
    this._curSysFrac = clamp((beat - _lsb) / ((_leb - _lsb) || 1), 0, 1);
    // Translucent rectangle highlighting the note that's playing: wide, and tall enough to always
    // Center the column on the STAFF (and the noteheads), not high above it. yTop is the system's top
    // (the staff's 5 lines sit at ~0.57–1.14 of the span below it), so an offset of ~0.25·span drops
    // the rect's top into the accent zone just above the staff and ~1.42·span puts the bottom into the
    // sticking row just below it — leaving the rect visually centered on the notes on EVERY line.
    var span = (yBot - yTop) || 70;                 // stable 70·zoom reference — used for the width only
    var w = Math.max(11, span * 0.2);
    // Column top = the accent row, bottom = the 1st sticking row (anchored to the real staff by the
    // renderer). Falls back to the old fixed fractions if an older render didn't supply cTop/cBot.
    var top = (cTopV != null ? cTopV : yTop + span * 0.25);
    var bot = (cBotV != null ? cBotV : yBot + span * 0.42);
    var hgt = bot - top;
    var rx = x - w / 2;
    ctx.fillStyle = "rgba(211,84,0,0.20)";        // translucent brand orange column
    ctx.fillRect(rx, top, w, hgt);
    this._phRect = { x: rx, y: top, w: w, h: hgt };  // remember footprint so the next frame erases just this
  };
  // Auto-follow the music (lock mode ON): keep the cursor gliding down the page at playback pace instead
  // of holding still and then jumping a whole page. Every frame we drive scrollTop toward a CONTINUOUS
  // content-Y built from the cursor's system top plus its fraction across the current line, parked ~35%
  // down the viewport and eased so the tiny per-line steps melt into one constant, smooth downward scroll.
  // (This replaced an older hold-then-page design whose per-line jump read as an abrupt "slide up" —
  // Anthony, 2026-07-24.) It still yields to a manual scroll: every frame we remember where WE left
  // scrollTop (this._autoY); if the next tick finds it elsewhere, the reader grabbed it, so we stand down
  // for ~1.1s (this._followHoldUntil) before re-adopting. Bows out entirely when the music fits the box
  // (max<=8), and runs only from the playhead tick, so it never touches scroll while paused.
  RDMPlayer.prototype._autoScrollTick = function () {
    if (this.followScroll === false) { this._scrollTarget = this._pageTop = this._autoY = this._autoTarget = null; return; }
    var host = this.host, sc = host && host.parentElement;
    if (!sc) return;
    var max = sc.scrollHeight - sc.clientHeight;
    if (max <= 8) { this._scrollTarget = this._pageTop = this._autoY = this._autoTarget = null; return; }   // fits the box: nothing to scroll
    var yTop = this._curYTop;
    if (yTop == null) return;
    var scR = sc.getBoundingClientRect(), hR = host.getBoundingClientRect();
    var off = (hR.top - scR.top) + sc.scrollTop;             // host's top in stable scroll-content px
    var lineH = this._lineH || 70;
    var CLEAR_PAD = 30;                                      // covers the app's ~26px edge fade + a hair
    // CONTINUOUS content-Y of the cursor: current system top plus how far it has crept across this line
    // (curSysFrac 0..1). It advances smoothly the whole piece and only steps by lineH at a system break,
    // where curSysFrac resets to 0, so the value never jumps. This replaces the old hold-then-page logic
    // that caused the abrupt slide-up (Anthony, 2026-07-24: wants a constant, smooth downward scroll).
    var contentY = off + yTop + lineH * (this._curSysFrac || 0);
    // Manual-peek yield: if the view isn't where WE last left it, the reader grabbed the wheel/finger, so
    // stop steering for ~1.1s to let them look around, then re-adopt. Keeps the old "never fought while I
    // scroll" feel without the paging that caused the jump.
    if (this._autoY != null && Math.abs(sc.scrollTop - this._autoY) > 1.5) {
      /* ADOPT where the reader put it as the new floor. Do NOT drop the floor.
         (Anthony, 2026-08-07: "make sure when the music scrolls, IT CAN NEVER SCROLL UPWARDS. I just
         saw this happen.")

         Dropping it was deliberate and wrong. The reasoning was "re-adopting after they scrolled UP
         would be pinned to the old target and refuse to come back down to them" — true, but nulling the
         floor also permits the opposite: when the reader scrolls AHEAD of the music, the follower eases
         back UP to the cursor. That is a real upward scroll mid-playback and it is exactly what he saw.

         Adopting handles both directions with one rule:
           reader scrolled UP   -> the floor drops with them, so the follower can come back down. Fine.
           reader scrolled DOWN -> the floor rises with them, so the follower simply waits where they
                                   left it until the music catches up. Never comes back up. */
      this._autoY = sc.scrollTop;
      this._followHoldUntil = this.actx.currentTime + 1.1;
      this._scrollVel = 0;
      this._autoTarget = null;
    }
    if (this._followHoldUntil && this.actx.currentTime < this._followHoldUntil) return;
    // Park the cursor's row ~35% down the viewport, backed off past the top fade so accents clear the fog.
    // Clamped to the scroll range, so the piece START holds at the top (target clamps to 0) until the
    // cursor naturally descends into the band: no jump on the first system.
    // Never scroll the CURRENT line's top above the top fade, so the notes you're playing stay clear (not
    // blurred) until the cursor moves on to the next line (Anthony, 2026-07-25). yTop = current system top.
    var lineTopCap = (off + yTop) - CLEAR_PAD;
    var target = Math.max(0, Math.min(contentY - Math.max(sc.clientHeight * 0.35, CLEAR_PAD), lineTopCap, max));
    /* NEVER DRIFT BACK UP WHILE PLAYING (Anthony, 2026-08-02: "whenever the sheet music is scrolling
       downwards it never accidentally glitches and moves back upward during a playback — it should only
       be going down the page in a smooth way").
       The target is derived from the cursor's position, so anything that momentarily nudges that
       backwards — audio-clock wobble at a tempo change, a layout rect settling after a re-render, the
       curSysFrac/yTop pair updating a frame apart at a system break — becomes a visible upward twitch.
       Being a hair LATE is invisible; going backwards is not, so the tie is broken in favour of holding.
       The discriminator is the MUSIC, not the size of the move: the only legitimate reason to scroll up
       is that playback itself went backwards (loop wrap or seek). Sizing it instead — "a small step back
       is jitter, a big one is real" — looked reasonable and is wrong: the most likely glitch is exactly
       ONE LINE (yTop advancing at a system break a frame before curSysFrac resets to 0, or vice versa),
       which any size rule big enough to catch a loop would wave straight through. */
    var b = this._curBeat;
    /* 0.05 BEATS, not 1e-6. This flag is the ONE thing that unlocks an upward scroll, so what counts as
       "the music went back" has to be a real jump and not clock noise. The smallest legitimate rewind is
       a loop window wrapping, and even a note-precise one-sixteenth loop goes back 0.25 beats — twenty
       times this threshold. Audio-clock wobble at a tempo change or a re-anchor is orders of magnitude
       under it. At 1e-6 any float jitter in _curBeat latched _rewinding and let the view crawl upward. */
    var wentBack = (this._autoBeat != null && b != null && b < this._autoBeat - 0.05);
    /* ...AND THE OTHER LEGITIMATE WAY UP: A WRITTEN REPEAT (Anthony, 2026-08-07: "whenever I'm on an
       exercise that has the repeat in the middle of it... when the music goes back up to the top of that
       repeat the sheet music does not move up to where the cursor now just moved to").

       `wentBack` cannot see this one. A repeat is UNROLLED for playback — the repeated bars are played
       through a second time as later events — so the beat counter climbs straight past the repeat sign
       and never goes backwards. Only the CURSOR jumps, back to a system it already visited, and the
       never-scroll-up clamp then pins the page at the bottom while the cursor plays on out of sight.

       So watch the quantity that actually moved: the top of the system the cursor is on. Playing
       forwards, that only ever increases (or holds within a line), and it is the same value the scroll
       target is derived from — so "the cursor went up" and "the view may go up" can never disagree.
       Half a line of tolerance: a system break is a whole lineH, while a re-layout settling is sub-pixel. */
    var upTol = Math.max(4, lineH * 0.5);
    var jumpedUp = (this._autoYTop != null && yTop != null && yTop < this._autoYTop - upTol);
    this._autoYTop = yTop;
    if (wentBack || jumpedUp) {
      this._autoTarget = null; this._scrollVel = 0;   // the music jumped back: follow it, without momentum
      /* ...AND KEEP ALLOWING IT UNTIL THE VIEW HAS ACTUALLY ARRIVED (Anthony, 2026-08-03: when an
         exercise finishes and loops, "the music isn't automatically scrolling to the very top").
         `wentBack` is true for exactly ONE frame — the frame the beat jumps backwards on. The easing
         below moves a couple of percent of the way in that frame, and from the next frame the
         never-scroll-up clamp sees `!wentBack` and pins scrollTop where it stands. So a loop wrap
         scrolled up a few pixels and then stuck at the bottom of the page forever. The upward move has
         to stay unlocked for the whole journey, not for the instant it starts, so latch it here and
         release it below once the scroll has caught the target. */
      this._rewinding = true;
    }
    this._autoBeat = b;
    var prevT = this._autoTarget;
    if (prevT != null && target < prevT) target = prevT;    // playing forwards: never, ever go up
    this._autoTarget = target;
    var cur = sc.scrollTop, d = target - cur;
    // Two-stage smoothing for an eased START and STOP (Anthony, 2026-07-25). d*0.12 is where a plain
    // exponential ease would step; we then low-pass the VELOCITY toward that, so the scroll accelerates
    // up from rest when following begins (ease-in) and coasts down to a halt as it catches the target
    // (ease-out), instead of snapping straight to a constant speed.
    var vel = (this._scrollVel || 0) + (d * 0.12 - (this._scrollVel || 0)) * 0.18;
    var next;
    if (Math.abs(d) < 0.3 && Math.abs(vel) < 0.3) { next = target; vel = 0; }
    else { next = cur + vel; }
    /* Clamp at the point of APPLICATION as well, not just on the target. Holding the target alone still
       let the easing settle a pixel or two backwards whenever the view had overshot it — small, but the
       requirement is "only ever down", and a 1px twitch is still a twitch. Skipped when the music itself
       went back, which is the one case that legitimately scrolls up. */
    /* The rewind is over once the view is on the target; until then it owns the clamp. Note the release
       is on DISTANCE, not on a frame count or a timer: the whole point is that it lasts exactly as long
       as the journey does, whether that is the top of a four-bar sheet or of a forty-bar one. */
    if (this._rewinding && Math.abs(d) < 0.5) this._rewinding = false;
    if (!wentBack && !jumpedUp && !this._rewinding && this._autoY != null && next < this._autoY) { next = this._autoY; vel = 0; }
    sc.scrollTop = next;
    this._scrollVel = vel;
    this._pageTop = this._scrollTarget = target;            // kept in sync for any external reader; not a pager now
    this._autoY = sc.scrollTop;
  };
  RDMPlayer.prototype._startPlayhead = function () { cancelAnimationFrame(this._raf || 0); var self = this; this._raf = requestAnimationFrame(function () { self._playheadTick(); }); };
  RDMPlayer.prototype._stopPlayhead = function () { cancelAnimationFrame(this._raf || 0); this._raf = null; };
  // Time shift (seconds) applied when reading the cursor's beat: beat = _beatAt(currentTime - this).
  // A NEGATIVE value reads into the future, pushing the cursor forward. We default to a forward lead
  // (−cursorLead) because the dominant error in practice isn't audio output latency (small, and Chrome
  // over-reports it anyway) but the VISUAL pipeline: the frame we draw now doesn't hit the screen for
  // ~2 frames, so without a lead the cursor visibly trails the sound. Capped so a silly value can't
  // fling it across the staff.
  RDMPlayer.prototype._audioLatency = function () {
    return Math.min(Math.max(-(this.cursorLead || 0), -0.2), 0.1);
  };
  RDMPlayer.prototype._playheadTick = function () {
    if (!this.playing) return;
    /* Mid-scrub the cursor belongs to the finger, not the audio clock — without this the RAF would
       repaint the real playing position over the preview on the very next frame. Audio keeps running
       untouched underneath; nothing is committed until pointerup calls seek(). */
    if (this._scrubBeat != null) {
      this._drawPlayheadAtBeat(this._scrubBeat);
      var selfS = this; this._raf = requestAnimationFrame(function () { selfS._playheadTick(); });
      return;
    }
    // Continuous beat straight off the shared clock: perfectly smooth, exact speed, and it
    // re-anchors the instant the tempo changes — so the cursor adapts immediately with no stutter.
    // Compensate for output latency so the cursor sits on the note you actually hear, not the one being scheduled.
    // _cursorBeatAt == _beatAt except during a loop count-off, where the cursor parks on the loop's
    // first beat for the length of the cue instead of sliding.
    var tNow = this.actx.currentTime - this._audioLatency();
    var beat = this._cursorBeatAt(tNow);
    /* LEAD-IN WRAP (Anthony, 2026-07-31: "press play and the progress bar goes forward a little then
       immediately comes back, and the sheet scrolls down then back up").
       _startPlay anchors the clock at audioStart = now + 0.1s, so for that first instant the clock reads
       BEFORE the beat we're starting from. The old guard below only caught the whole-piece case (beat
       going negative and the modulo wrapping it to ~totalBeats). With a LOOP WINDOW the beat is still
       positive but sits just under loopLo, and _displayBeat's modulo wraps THAT to near the window's END
       — so the cursor flashed to the end of the loop, taking the progress bar and the auto-scroll with
       it, before snapping back. Hold on the start beat until the clock actually reaches it. */
    if (tNow < this.anchorTime) beat = this.anchorBeat;
    if (beat < 0) beat = 0;
    var vb = this.totalBeats > 0 ? this._displayBeat(beat) : beat;   // fold into the active loop window (or whole piece)
    this._drawPlayheadAtBeat(vb);
    this._autoScrollTick();
    this._emitTimeAt(vb);
    var self = this; this._raf = requestAnimationFrame(function () { self._playheadTick(); });
  };
  // Re-fit the playhead canvas + anchors after a zoom or resize (host width changed). This is a PURE
  // re-render: only pixel positions move (same piece, same tempo, same beat clock), so playback itself
  // is never touched here — no _stopPlay/_startPlay, no master-gain mute, no resetting the audio clock
  // or the scheduler's lookahead queue. (It used to stop/restart the transport "to be safe," but that
  // silenced the master gain and re-anchored audioStart to a new wall-clock instant on every call — an
  // audible click + a ~100ms gap + a restart on every zoom/resize click during playback.)
  /* ---------- OFFLINE RENDER (background playback on iOS) ----------
     Renders `seconds` of the current piece, looping it, into a single AudioBuffer using the SAME voices
     as live playback (_hit / _scheduleMetro), then hands it back. Nothing here is used by normal
     playback: it is additive, and every method it borrows is left untouched.

     ONLY EVER CALL THIS ON A DEDICATED "SHADOW" INSTANCE, never on the player actually making sound
     (2026-07-30). The first version of the caller in Playalongs/SR reused the LIVE player for this and it
     broke production: mid-render this method repoints `this.actx`/`this.master`/the tempo clock, which is
     exactly the graph a live scheduler is reading from on every tick. Calling it on a player nobody is
     listening to sidesteps the whole problem by construction — see the "renderBounce" comment in each
     tool's app.js for how the caller keeps that separation.

     WHY THIS EXISTS (Anthony, 2026-07-29). iOS suspends Web Audio the moment the screen locks, so the
     tools go silent in a pocket. It does NOT suspend a media element, so if we hand <audio> a rendered
     file it keeps playing with the screen off. Verified on a real iPhone before this was written.
     The rhythm must be rendered as a WHOLE number of beats or the loop seam lands off the beat and the
     pulse lurches every pass — that was the first thing the device test caught.

     Randomize and Bump are BAKED INTO the bounce (Anthony, 2026-07-29: losing them was "unacceptable").
     A frozen recording can still carry them: Bump is deterministic, and Randomize just draws its sequence
     at render time — a listener cannot tell whether the dice were rolled now or five minutes ago. The
     render loop runs the REAL _onLoopBoundary() at each pass, exactly like the live scheduler.

     Mono on purpose: the voices are all oscillators/noise with no panning, so a second channel would
     double the memory for identical samples. */
  RDMPlayer.prototype.renderOffline = function (seconds, opts) {
    if (!this.perf || !this.perf.length) return Promise.reject(new Error("nothing loaded"));
    if (this.playing) return Promise.reject(new Error("stop playback before rendering — or render on a separate player instance instead"));
    opts = opts || {};
    var SR = 44100;
    var minSecs = Math.max(1, Math.min(1800, +seconds || 60));      // 1s..30min guard
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error("OfflineAudioContext unavailable"));

    /* Allocate GENEROUSLY, stop at a real pass boundary, then trim. The bounce has to end exactly on a
       beat or the <audio loop> seam lands mid-beat and the pulse lurches (the device test caught that).
       With Randomize/Bump baked in, a pass's duration is not known in advance, so we cannot compute the
       length up front: reserve room for one extra pass at the SLOWEST tempo the piece allows, let the note
       loop tell us where the boundary actually fell, and cut there. */
    var beatsPerPass = 0;
    for (var bp = 0; bp < this.perf.length; bp++) beatsPerPass += (this.perf[bp].beats || 0);
    if (!(beatsPerPass > 0)) return Promise.reject(new Error("piece has no length"));
    var slowest = Math.max(20, Math.min(this.minTempo || 40, this.tempo));
    var dur = minSecs + beatsPerPass * (60 / slowest) + 1;

    /* Swap the instance onto an offline graph, mirroring _ensureAudio's chain exactly so the bounce has
       the same loudness/limiting as the speakers do. Restored in `done()` below, whatever happens. This
       instance-level swap is exactly why the caller MUST be a shadow player nobody is listening to. */
    var saved = {
      actx: this.actx, master: this.master, outBoost: this._outBoost, limiter: this._limiter,
      coBus: this._coBus, spb: this.spb, anchorTime: this.anchorTime, anchorBeat: this.anchorBeat,
      anchorI: this._anchorI, cumBeat: this.cumBeat, idx: this.idx, metroBeat: this.metroBeat,
      lastSchedTime: this._lastSchedTime, sched: this._sched, extraCursorBeat: this._extraCursorBeat,
      audioStart: this.audioStart, coGap: this._coGap,
      /* Automation MUTATES all of these. `tempo` above all: without restoring it, calling this twice on
         the SAME shadow instance would leave it sitting at whatever tempo the previous bounce ended on. */
      tempo: this.tempo, repCounter: this._repCounter, prevRandom: this._prevRandom,
      loopIndex: this._loopIndex, lastTempoChangeAt: this._lastTempoChangeAt,
      /* Silence every side effect for the duration. `cb` carries the tool's callbacks (onTempoChange
         would drag a UI through the whole schedule if this were ever called with real callbacks attached —
         shadow players are constructed with none, but this stays defensive), and `_tempoEls` is how
         _updateTempoMarkValues() rewrites the "♩ = N" markings straight into a sheet's DOM. */
      cb: this.cb, tempoEls: this._tempoEls,
    };
    var self = this;
    function done(restoreOnly) {
      self.actx = saved.actx; self.master = saved.master; self._outBoost = saved.outBoost;
      self._limiter = saved.limiter; self._coBus = saved.coBus;
      self.spb = saved.spb; self.anchorTime = saved.anchorTime; self.anchorBeat = saved.anchorBeat;
      self._anchorI = saved.anchorI; self.cumBeat = saved.cumBeat; self.idx = saved.idx;
      self.metroBeat = saved.metroBeat; self._lastSchedTime = saved.lastSchedTime;
      self._sched = saved.sched; self._extraCursorBeat = saved.extraCursorBeat;
      self.audioStart = saved.audioStart; self._coGap = saved.coGap;
      self.tempo = saved.tempo; self._repCounter = saved.repCounter;
      self._prevRandom = saved.prevRandom; self._loopIndex = saved.loopIndex;
      self._lastTempoChangeAt = saved.lastTempoChangeAt;
      self.cb = saved.cb; self._tempoEls = saved.tempoEls;
      return restoreOnly;
    }

    try {
      var oc = new OAC(1, Math.ceil(dur * SR), SR);
      this.actx = oc;
      // the SAME chain the speakers get — see _buildOutputChain
      var ochain = this._buildOutputChain(oc);
      this.master = ochain.master;
      this._outBoost = ochain.boost; this._limiter = ochain.shaper; this._outTrim = ochain.trim;
      this._coBus = oc.createGain(); this._coBus.gain.value = 1; this._coBus.connect(this.master);

      this.cb = {};                 // no onTempoChange/onTime/onNote reaching the tool while we bounce
      this._tempoEls = null;        // and no rewriting the sheet's tempo markings

      // clock anchored at t=0, no count-off gap
      this.spb = 60 / this.tempo;
      this.anchorBeat = 0; this.anchorTime = 0; this._reanchorI();
      this._coGap = null; this._sched = []; this._lastSchedTime = -1;
      this.cumBeat = 0; this.idx = 0;
      this.metroBeat = this._nextMetroPulseAt(0);
      this._extraCursorBeat = 0;

      /* Commit EVERY note up front (no horizon, no timers — that is the whole point), running the REAL
         automation at each loop boundary so Randomize and Bump are baked into the bounce. Mirrors
         _scheduler()'s wrap handling exactly. */
      var guard = 0, beat = 0, i = 0, passes = 0, endTime = dur;
      var tempoMarks = [{ t: 0, bpm: this.tempo }];
      while (guard++ < 2000000) {
        var t = this._timeForBeat(beat);
        if (t >= dur) { endTime = dur; break; }
        if (i >= this.perf.length) {                                // a pass just finished
          passes++;
          if (t >= minSecs) { endTime = t; break; }                 // long enough, and we are ON a beat: cut here
          i = 0;
          /* _bumpOnce/_pickRandomTempo call setTempo with { throttle: true }, and that throttle is
             WALL-CLOCK (400ms). A render covers minutes of music in a few milliseconds, so every change
             after the first was being thrown away and the bounce came out at one fixed tempo. Clearing
             the stamp each boundary makes the throttle a no-op here without touching setTempo itself. */
          this._lastTempoChangeAt = 0;
          this._onLoopBoundary();                                   // Randomize / Bump decide here
          if (60 / this.tempo !== this.spb) {                       // automation moved the tempo
            this.spb = 60 / this.tempo;
            this.anchorBeat = beat; this.anchorTime = t; this._reanchorI();
            tempoMarks.push({ t: +t.toFixed(4), bpm: this.tempo });
          }
          // re-grid the click to the piece's downbeat on every pass, same reason as the live scheduler
          this.metroBeat = this._nextMetroPulseAt(beat);
          t = this._timeForBeat(beat);
        }
        var e = this.perf[i];
        this._hit(e, t, beat);
        var adv = e.beats || 0;
        beat += adv; i++;
        if (adv <= 0 && i >= this.perf.length) { endTime = t; break; }   // zero-length piece: never spin
      }
      /* Metro AFTER the notes: it walks this.metroBeat forward, and the note loop is what re-grids that at
         each pass. Scheduling it first would click against a stale grid once the tempo moved. Bounded by
         endTime so no click is committed past the trim point. */
      if (opts.metro !== false) { try { this._scheduleMetro(endTime); } catch (e2) { /* metro off */ } }
      this._bounceTempoMarks = tempoMarks;

      var cutAt = Math.max(1, Math.round(endTime * SR));
      var passCount = passes || 1;
      return oc.startRendering().then(function (buf) {
        done();
        /* Trim to the pass boundary. The reserved tail exists only so the loop could reach one, and
           leaving it in would put silence (and a mid-beat restart) at the seam. */
        if (cutAt >= buf.length) { buf._rdmPasses = passCount; buf._rdmTempoMarks = tempoMarks; return buf; }
        var outBuf = oc.createBuffer(1, cutAt, SR);
        outBuf.copyToChannel ? outBuf.copyToChannel(buf.getChannelData(0).subarray(0, cutAt), 0)
                             : outBuf.getChannelData(0).set(buf.getChannelData(0).subarray(0, cutAt));
        outBuf._rdmPasses = passCount;
        outBuf._rdmTempoMarks = tempoMarks;
        return outBuf;
      }, function (err) { done(); throw err; });
    } catch (e3) {
      done();
      return Promise.reject(e3);
    }
  };

  /* "About N seconds, ending exactly on a beat." renderOffline handles the boundary itself (it has to:
     with Randomize/Bump baked in, a pass's duration is not knowable in advance), so this is just the
     name the tools call. Kept as its own method because that is the contract they were written against. */
  RDMPlayer.prototype.renderWholeLoops = function (targetSeconds, opts) {
    return this.renderOffline(targetSeconds, opts);
  };

  RDMPlayer.prototype.relayout = function () {
    if (!this.rdm) return;
    // system y's move on re-layout — re-adopt fresh on the next tick. The never-scroll-up floor MUST go
    // too: it is a content-Y in the OLD layout, so keeping it after a resize/zoom could hold the view
    // below where the cursor now is.
    this._scrollTarget = this._pageTop = this._autoTarget = null;
    this._render(); this._buildPlayback();
    // preserve any active loop across the re-layout: the note structure is identical, only x's moved,
    // so re-derive the window bounds from the same anchor indices and repaint the highlight (no re-seek).
    if (this.loopA0 != null && this.loopA1 != null && this.anchors[this.loopA1]) {
      var A0 = this.anchors[this.loopA0], A1 = this.anchors[this.loopA1];
      var lm = this.measures[A1.mi], nextA = this.anchors[this.loopA1 + 1];
      this.loopStart = A0.beat; this.loopStartIdx = A0.pIdx;
      if (nextA && nextA.beat < lm.endBeat - 1e-9) { this.loopEnd = nextA.beat; this.loopEndIdx = nextA.pIdx; }
      else { this.loopEnd = lm.endBeat; this.loopEndIdx = lm.endIdx; }
      this._drawSelection();
    }
    // If we're playing, the already-running playhead loop repaints the cursor on its very next frame
    // against the fresh anchors/canvas on its own — only the PAUSED case needs a manual repaint here.
    if (!this.playing) this._drawPlayheadAtBeat(this._displayBeat(this.cumBeat % (this.totalBeats || 1)));
  };

  /* ---------- music size (zoom) ---------- */
  // Auto-scroll follow (lock) vs free scroll.
  RDMPlayer.prototype.setFollowScroll = function (on) { this.followScroll = !!on; };
  RDMPlayer.prototype.getFollowScroll = function () { return this.followScroll !== false; };
  RDMPlayer.prototype.getZoom = function () { return this.zoom; };
  // The real zoom ceiling for the loaded exercise: 2.5 normally, lower when the widest bar can't be drawn
  // that big on this screen (see _render). A tool disables its zoom-in button at this value so the control
  // never offers a percentage that would silently redraw at the same size.
  RDMPlayer.prototype.getMaxZoom = function () { return this._maxZoom != null ? this._maxZoom : 2.5; };
  RDMPlayer.prototype.setZoom = function (z) {
    var hi = this._maxZoom != null ? this._maxZoom : 2.5;
    z = Math.max(0.5, Math.min(hi, +z || 1));
    z = Math.round(z * 100) / 100;
    if (z === this.zoom) return this.zoom;
    this.zoom = z;
    this.relayout();                  // re-render the notation at the new scale
    this._emit("onZoom", { zoom: z });
    return this.zoom;
  };

  /* ---------- time/progress callback ---------- */
  RDMPlayer.prototype._emitTimeAt = function (beat) {
    var spb = 60 / this.tempo, total = this.totalBeats || 0;
    this._emit("onTime", {
      fraction: total ? clamp(beat / total, 0, 1) : 0,   // bar tracks beats (position in the piece)
      currentSec: spb * this._mapIbase(beat),            // real elapsed seconds (accounts for tempo changes)
      totalSec: spb * (this._tempoTotalI || total),
      tempo: this.tempo
    });
  };

  RDMPlayer.prototype._emit = function (name, payload) { if (typeof this.cb[name] === "function") this.cb[name](payload); };

  /* ============================================================
     Loop window — repeat a sub-section (a range of measures) instead of the whole piece.
     The whole feature is a [lo, hi) beat window the audio clock gets folded into: set it once and
     the scheduler, metronome accents and playhead all loop the same measures together, because they
     ALL read the beat clock through _displayBeat. UI lives in app.js (drag to select).
     ============================================================ */
  // Effective window bounds in beats. With no window set these collapse to [0, totalBeats), so every
  // beat-wrapping calc behaves exactly as the old whole-piece loop did — the window is a no-op default.
  RDMPlayer.prototype._loopLo = function () { return this.loopStart != null ? this.loopStart : 0; };
  RDMPlayer.prototype._loopHi = function () { return this.loopEnd != null ? this.loopEnd : this.totalBeats; };
  // Map an absolute (forever-increasing) beat to its on-screen position inside the active window.
  RDMPlayer.prototype._displayBeat = function (beat) {
    var total = this.totalBeats; if (!(total > 0)) return beat;
    if (!this._looping()) return clamp(beat, 0, total);
    var lo = this._loopLo(), hi = this._loopHi(), span = hi - lo;
    if (!(span > 0)) { lo = 0; span = total; }
    return lo + (((beat - lo) % span) + span) % span;
  };
  RDMPlayer.prototype.hasLoop = function () { return this.loopEnd != null; };
  RDMPlayer.prototype.getMeasures = function () { return this.measures || []; };

  // ---- note-precise loop selection (M/B/P) ----
  // nearest sounding-note anchor to a point in SVG units (same space as anchor.x/yTop). System-aware:
  // pick the closest line first, then the closest note on it. Returns an anchor index or null.
  RDMPlayer.prototype.anchorIndexAtXY = function (px, py) {
    var a = this.anchors; if (!a || !a.length) return null;
    var bestY = a[0].yTop, bd = Infinity;
    for (var i = 0; i < a.length; i++) { var cy = (a[i].yTop + a[i].yBot) / 2, d = Math.abs(py - cy); if (d < bd) { bd = d; bestY = a[i].yTop; } }
    var best = null, bx = Infinity;
    for (var j = 0; j < a.length; j++) { if (Math.abs(a[j].yTop - bestY) >= 2) continue; var dx = Math.abs(a[j].x - px); if (dx < bx) { bx = dx; best = j; } }
    return best;
  };
  RDMPlayer.prototype._firstAnchorOfMeasure = function (mi) { var a = this.anchors; for (var i = 0; i < a.length; i++) if (a[i].mi === mi) return i; return null; };
  RDMPlayer.prototype._lastAnchorOfMeasure  = function (mi) { var a = this.anchors; for (var i = a.length - 1; i >= 0; i--) if (a[i].mi === mi) return i; return null; };
  // "M20 B3 P2" for a note, collapsed to just "M20" when it sits on a whole-measure boundary (the first
  // note of the bar for a loop start, the last note for a loop end).
  RDMPlayer.prototype._anchorLabel = function (idx, isEnd) {
    var a = this.anchors[idx]; if (!a) return "";
    var M = (this.measures[a.mi] ? this.measures[a.mi].srcIndex : a.mi) + 1;
    if ((isEnd && a.isLastInMeasure) || (!isEnd && a.isFirstInMeasure)) return "M" + M;
    return "M" + M + " B" + a.B + " P" + a.P;
  };
  RDMPlayer.prototype.loopLabel = function () {
    if (this.loopA0 == null || this.loopA1 == null) return null;
    var i0 = Math.min(this.loopA0, this.loopA1), i1 = Math.max(this.loopA0, this.loopA1);
    var s = this._anchorLabel(i0, false), e = this._anchorLabel(i1, true);
    return (i0 === i1 || s === e) ? s : (s + " – " + e);   // single note, or one whole measure → just "M16"
  };
  // Loop the span between two note anchors (inclusive). The end runs to the next note, but never past the
  // bar line of the last selected note's measure — so a whole-measure selection ends exactly on the bar.
  RDMPlayer.prototype.setLoopAnchors = function (i0, i1) {
    var a = this.anchors; if (!a || !a.length) return;
    i0 = clamp(i0 | 0, 0, a.length - 1); i1 = clamp(i1 | 0, 0, a.length - 1);
    if (i0 > i1) { var t = i0; i0 = i1; i1 = t; }
    this.loopA0 = i0; this.loopA1 = i1;
    var m = this.measures[a[i1].mi], nextA = a[i1 + 1], endBeat, endIdx;
    if (nextA && nextA.beat < m.endBeat - 1e-9) { endBeat = nextA.beat; endIdx = nextA.pIdx; }
    else { endBeat = m.endBeat; endIdx = m.endIdx; }
    this.loopStart = a[i0].beat; this.loopEnd = endBeat;
    this.loopStartIdx = a[i0].pIdx; this.loopEndIdx = endIdx;
    this.loopM0 = a[i0].mi; this.loopM1 = a[i1].mi;   // keep the From/To bar panel roughly in step
    this._drawSelection();
    this.idx = this.loopStartIdx; this.cumBeat = this.loopStart;   // snap the clock to the window start
    if (this.playing) this._startPlay(this.loopStart);
    else { this._drawPlayheadAtBeat(this.loopStart); this._emitTimeAt(this.loopStart); }
    this._emit("onLoopRange", { a0: i0, a1: i1, m0: this.loopM0, m1: this.loopM1, start: this.loopStart, end: this.loopEnd, label: this.loopLabel() });
  };

  // Loop the measure-instances [m0..m1] (inclusive, order-independent). Snaps playback to the window
  // start so it begins clean (restarts there if already playing). Emits onLoopRange for the UI chip.
  RDMPlayer.prototype.setLoopMeasures = function (m0, m1) {
    var ms = this.measures; if (!ms || !ms.length) return;
    m0 = clamp(m0 | 0, 0, ms.length - 1); m1 = clamp(m1 | 0, 0, ms.length - 1);
    if (m0 > m1) { var t = m0; m0 = m1; m1 = t; }
    // a whole-measure loop is just: first note of m0 → last note of m1 (so From/To Bar and the on-staff
    // note selection share one code path). Skip all-rest bars by scanning outward for a note.
    var i0 = null, i1 = null, k;
    for (k = m0; k <= m1 && i0 == null; k++) i0 = this._firstAnchorOfMeasure(k);
    for (k = m1; k >= m0 && i1 == null; k--) i1 = this._lastAnchorOfMeasure(k);
    if (i0 == null || i1 == null) return;
    this.setLoopAnchors(i0, i1);
  };
  RDMPlayer.prototype.clearLoop = function () {
    var had = this.loopEnd != null;
    // While a loop window is active the raw playback clock keeps counting UP across passes, and
    // _displayBeat folds those passes out of view so the cursor stays inside the window. Dropping the
    // window changes that fold — so unless we collapse every beat cursor back onto the real piece
    // position first, the on-screen cursor leaps to (rawBeat % pieceLength) while the audio, driven by
    // the note index, keeps playing correctly. Collapse here so the cursor stays put and playback just
    // continues through the rest of the piece. (Note precise/whole-measure windows both go through here.)
    if (had && this.totalBeats > 0) {
      var playing = this.playing && this.actx;
      var t = playing ? this.actx.currentTime : 0;
      // _cursorBeatAt, not _beatAt: if a loop count-off is mid-cue the transport is parked on the loop's
      // first beat, and that (not the pre-gap clock, which sits back in the previous pass) is where we are.
      var here = this._displayBeat(playing ? this._cursorBeatAt(t) : this.cumBeat);   // true on-screen beat NOW
      this._cancelCountOff();                                    // dropping the window ends any count-off
      this.cumBeat = this._displayBeat(this.cumBeat);            // scheduler's next-note cursor, collapsed
      this.loopStart = null; this.loopEnd = null; this.loopM0 = null; this.loopM1 = null; this.loopA0 = null; this.loopA1 = null;
      this.loopStartIdx = 0; this.loopEndIdx = this.perf ? this.perf.length : 0;
      this._extraCursorBeat = this.cumBeat;                     // polyrhythm voices resume from here
      if (playing) {
        this.anchorBeat = here; this.anchorTime = t; this._reanchorI();   // re-anchor the shared clock, no gap
        // Re-grid the metronome from the COLLAPSED beat (`here`), not the raw one. The raw clock had run
        // up through N loop passes; feeding it here left metroBeat N*span beats in the future while the
        // anchor had just been pulled back to `here`, so the click went silent for the rest of the piece.
        this.metroBeat = this._nextMetroPulseAt(here);
      } else {
        this._drawPlayheadAtBeat(this.cumBeat); this._emitTimeAt(this.cumBeat);
      }
      this._clearSelection();
      this._emit("onLoopRange", null);
      return;
    }
    this.loopStart = null; this.loopEnd = null; this.loopM0 = null; this.loopM1 = null; this.loopA0 = null; this.loopA1 = null;
    this.loopStartIdx = 0; this.loopEndIdx = this.perf ? this.perf.length : 0;
    this._clearSelection();
    if (had) this._emit("onLoopRange", null);
  };
  // pixel-space (SVG units) -> measure-instance index, or null. Used by the UI for click/drag select.
  RDMPlayer.prototype.measureIndexAtXY = function (px, py) {
    var ms = this.measures; if (!ms || !ms.length) return null;
    var bestLineY = ms[0].yTop, bestDy = Infinity;
    ms.forEach(function (m) { var cy = (m.yTop + m.yBot) / 2, d = Math.abs(py - cy); if (d < bestDy) { bestDy = d; bestLineY = m.yTop; } });
    var cand = null, bestXd = Infinity;
    for (var i = 0; i < ms.length; i++) {
      if (Math.abs(ms[i].yTop - bestLineY) >= 2) continue;     // only measures on the clicked line
      var b = this._measureBounds(i);
      if (px >= b.left && px <= b.right) return i;              // inside a bar → that bar (first instance wins for repeats)
      var cx = (b.left + b.right) / 2, d = Math.abs(px - cx);
      if (d < bestXd) { bestXd = d; cand = i; }
    }
    return cand;
  };
  // left/right x of a measure cell's highlight. Prefer the renderer's EXACT bar-line x's so the block
  // fills the measure edge-to-edge on its bar lines (and adjacent selected bars stay contiguous, since
  // they share a bar line). Fallback (older render output with no stave x's): half-way to the
  // neighbouring bar on the same line, padded at line ends.
  RDMPlayer.prototype._measureBounds = function (i) {
    var ms = this.measures, m = ms[i];
    if (m.barLeft != null && m.barRight != null) return { left: m.barLeft, right: m.barRight };
    var prev = ms[i - 1], next = ms[i + 1];
    var sameLine = function (a, b) { return a && b && Math.abs(a.yTop - b.yTop) < 2; };
    var left = (sameLine(prev, m) && prev.x1 < m.x0) ? (prev.x1 + m.x0) / 2 : m.x0 - 12;
    var right = (sameLine(next, m) && next.x0 > m.x1) ? (m.x1 + next.x0) / 2 : m.x1 + 12;
    return { left: left, right: right };
  };
  RDMPlayer.prototype._clearSelection = function () { if (this.selCtx && this.selCanvas) this.selCtx.clearRect(0, 0, this.selCanvas.width, this.selCanvas.height); };
  // Highlight the note span between two anchors (defaults to the committed loop). One rect per measure
  // instance the span crosses — each measure is on a single system, so this wraps across lines for free.
  // The first / last measure clamp to the start / end note; a whole-measure endpoint fills to the bar line
  // (matches the "collapse to M__" rule). Same accent-row → sticking-row box (cTop/cBot) as the cursor.
  RDMPlayer.prototype._drawSelection = function (i0, i1) {
    if (i0 == null) i0 = this.loopA0; if (i1 == null) i1 = this.loopA1;
    this._clearSelection();
    if (i0 == null || i1 == null || !this.selCtx || !this.anchors || !this.measures) return;
    var a = this.anchors, ms = this.measures, ctx = this.selCtx;
    var A0 = a[Math.min(i0, i1)], A1 = a[Math.max(i0, i1)]; if (!A0 || !A1) return;
    ctx.fillStyle = "rgba(150,49,141,0.20)";          // translucent brand purple
    for (var mi = A0.mi; mi <= A1.mi; mi++) {
      var m = ms[mi]; if (!m) continue;
      var b = this._measureBounds(mi), span = (m.yBot - m.yTop) || 70, pad = Math.max(11, span * 0.2) / 2;
      var L = b.left, R = b.right;
      if (mi === A0.mi && !A0.isFirstInMeasure) L = A0.x - pad;   // start mid-measure → begin at the note
      if (mi === A1.mi && !A1.isLastInMeasure)  R = A1.x + pad;   // end mid-measure → stop at the note
      if (R <= L) continue;
      var top = (m.cTop != null ? m.cTop : m.yTop + span * 0.10);
      var bot = (m.cBot != null ? m.cBot : m.yBot + span * 0.50);
      ctx.fillRect(L, top, R - L, bot - top);
    }
  };
  // live preview while dragging a selection (draw only; doesn't touch playback)
  RDMPlayer.prototype.drawLoopPreview = function (i0, i1) { this._drawSelection(i0, i1); };

  global.RDMPlayer = RDMPlayer;
})(window);
