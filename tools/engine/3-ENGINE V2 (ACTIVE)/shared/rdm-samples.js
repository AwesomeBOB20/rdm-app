/* REAL DRUM SAMPLES — shipped as a SOUND choice, not as a replacement for the synth.

   "Invader Pad" is Anthony's own practice pad, recorded 2026-08-07: 8 round-robin takes of every voice,
   4 velocity layers for the drum itself. It appears in Settings > Sound next to Default / Bright /
   Sharp / Woody / Soft, PER VOICE, so a student can have a real pad for normal notes and keep the synth
   rim, or any other mix.

   THE ENGINE IS NOT REWRITTEN. This file replaces exactly one method, `RDMPlayer.prototype._voiceClick`,
   at runtime, and that replacement only does anything when the voice being played is set to a sampled
   tone AND that tone's recordings are in memory. Every other case calls straight through to the original
   oscillator path. Don't load this file and nothing about the app changes.

   ---------------------------------------------------------------------------------------------------
   HOW LOUDNESS IS DECIDED — the one design decision that matters

   The recording supplies TIMBRE. The engine keeps supplying LOUDNESS. Nothing about velocity, dynamics,
   hairpins, per-voice balance or the Settings > Sound levels moves into this file.

   `_voiceClick` is handed a `gain` the engine already computed as
       gain = BASE_GAIN[timbre] x velocity^GAMMA x userLevel
   and the synth's oscillator peaks at roughly that value. So to make a sample sit exactly where the
   oscillator would have, play it at

       playGain = gain / (the sample's own peak amplitude)

   which lands the sample's peak on `gain` too. Divide by the sample's MEASURED peak, not by a written
   down number: peaks are read off the decoded buffer at load, so re-recording a sound at a different
   level changes nothing here.

   Velocity is only used to CHOOSE WHICH LAYER (which timbre), never to set the level — the level was
   already decided by the engine. That is what keeps a tap sounding like a tap rather than a quiet
   full-stroke, while leaving every existing volume control in charge.
   --------------------------------------------------------------------------------------------------- */
(function (global) {
  "use strict";

  var RDMSamples = {
    /* Sound packs, keyed by the tone name the engine and Settings both use. Adding a second pad is a
       row here, a folder of wavs, and a chip in the app's TONE_LIST — nothing else. */
    PACKS: {
      invader: { label: "Invader Pad", dir: "invader-pad" },
    },

    /* TAKES THAT DO NOT GET PLAYED (Anthony, 2026-08-07: "some of the shot sounds actually sound bad...
       so they stop generating"). Eight takes of a sound are eight real strokes, and a couple of them
       being duds is normal for a recording session — one caught the rim wrong, one was quieter than the
       rest. Listed by pack, then by layer name, then by the take's number as it appears in the filename.

       They are never FETCHED, not merely skipped at playback: a dropped take is bytes a phone would be
       downloading for nothing. Audition them with dev/sample-picker.html, which writes this block. */
    DROP: {
      // Anthony, 2026-08-07, after listening through dev/sample-picker.html: rimshot takes 6, 7 and 8
      // are duds. Five remain in the rotation.
      invader: {
        rimshot: [6, 7, 8],
      },
    },

    /* HOW THE WAVS ARE FETCHED. Inside the app they are private, paywalled files in the `tools` bucket,
       so the app installs a fetcher that goes through the authenticated vault path (src/toolEmbed).
       Left null — standalone, off a static server, dev pages — it falls back to a plain relative fetch
       from `baseUrl`, which is how dev/sample-ab.html and the tools opened raw still work. */
    fetcher: null,
    baseUrl: "../shared/samples/",

    /* One global trim, in case a real drum sits differently against the metronome than the oscillators
       did. 1 = the sample peaks exactly where the synth would have. Tune by ear, not by maths. */
    level: 1,
    /* Optional cap on how long a sample is allowed to ring, in seconds. null = play it whole.
       Kept because a buzz fires ~20 retriggers of the same sound inside ONE note (the engine's bounce
       train) and a long tail on each could smear into mud. If it does, shorten here rather than
       re-recording — and NOT by editing the engine. */
    maxTail: null,

    /* ALIGN THE STRIKE WITH THE METRONOME. Seconds.

       The metronome click does not go through this file — it stays an oscillator — and every synth
       voice, click and note alike, ramps from silence to full over 5ms, so a synth note is not audible
       AT its scheduled time but 5ms after it. engine.js does that deliberately and says so: "Attack MUST
       match the note _click ramp (time + 0.005) so the metro transient peaks at the same instant as the
       notes."

       A recorded strike has no ramp — it is loud immediately. Fired at the raw scheduled time it lands
       ~4.4ms BEFORE the click (measured, all three test pieces), which is a flam against the one sound a
       drummer locks to. Delaying by the engine's own ramp puts the strike where the synth's peak was. */
    attackAlign: 0.005,

    /* QUIET-NOTE LIFT. null = use the engine's own curve untouched. Dev knob (dev/sample-ab.html).
       A recorded hit rings ~140ms where the oscillator's lasted ~30, so at speed an accent's tail covers
       the taps behind it in a way the synth never did. A softer velocity exponent HERE narrows the gap
       for sampled playback only and never touches the engine or the synth. */
    gamma: null,
  };

  /* Which recorded sound each engine voice uses. `stickLoud` is the count-off: the same physical stick
     click, which the engine already plays on a louder ceiling of its own via BASE_GAIN. */
  var VOICE = {
    click: "click", rimshot: "rimshot", rim: "rim",
    stick: "stick", stickLoud: "stick", cross: "cross",
  };

  /* The four `click` layers and the velocity at which each takes over, so a note picks the layer whose
     CHARACTER matches its dynamic (layerFor takes the highest layer at or below the note's velocity).

     RE-PINNED 2026-08-07 to the engine's current ladder. The first cut was calibrated against
     TAP 0.27 / TAP_NORMAL 0.75 / ACCENT 0.85; those are now 0.245 / 0.72 / 0.72, and with the old
     thresholds a real accent at 0.72 fell into the `mid` layer while `accent` became unreachable by
     anything except a tenuto in a flat bar. The takeover points now sit just BELOW each level they are
     meant to catch, so a small future tweak to the ladder cannot slide a note into the wrong layer:
       tap 0.20   catches the tap (0.245) and the tenuto (0.283)
       mid 0.45   catches mid dynamics and a quiet accent, which really is a smaller stroke
       accent 0.70 catches the accent and flat-forte (both 0.72)
       full 0.95  catches the marcato (1.00)
     The effect sounds were recorded at a single level, so they have one layer and no choice to make. */
  var CLICK_LAYERS = [
    { name: "tap", vel: 0.20 },
    { name: "mid", vel: 0.45 },
    { name: "accent", vel: 0.70 },
    { name: "full", vel: 0.95 },
  ];
  var ROUND_ROBIN = 8;

  var packs = {};             // pack key -> { sets: { voice -> [layer] }, ready:bool, loading:Promise }
  var original = null;
  var decodeCtx = null;

  function ctxFor(actx) {
    if (actx) return actx;
    if (!decodeCtx) {
      var C = global.AudioContext || global.webkitAudioContext;
      if (!C) return null;
      // creating one is allowed without a gesture; it starts suspended, and decodeAudioData works anyway
      decodeCtx = new C();
    }
    return decodeCtx;
  }

  function peakOf(buf) {
    var d = buf.getChannelData(0), p = 0;
    for (var i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > p) p = a; }
    return p || 1;
  }

  /* Seconds of lead-in before the transient. The slicer deliberately keeps ~2ms so the attack is never
     shaved, and playback skips exactly that much so the STRIKE lands on the engine's scheduled time
     rather than 2ms after it. Leave the lead-in in and every sampled note sits behind the metronome
     click by that much, which is a flam against the one sound a drummer is locking to. */
  function onsetOf(buf, peak) {
    var d = buf.getChannelData(0), thresh = peak * 0.02;
    for (var i = 0; i < d.length; i++) {
      var a = d[i] < 0 ? -d[i] : d[i];
      if (a >= thresh) return i / buf.sampleRate;
    }
    return 0;
  }

  function grab(rel) {
    if (typeof RDMSamples.fetcher === "function") return Promise.resolve(RDMSamples.fetcher(rel));
    return fetch(RDMSamples.baseUrl + rel).then(function (r) {
      if (!r.ok) throw new Error(rel + " -> HTTP " + r.status);
      return r.arrayBuffer();
    });
  }

  /* Run `jobs` at most N at a time. 64 files is not many, but they go out on one connection to the same
     origin as everything else the app is loading, and a burst of 64 delays the things a student is
     actually waiting for. */
  function pool(jobs, n) {
    var i = 0, active = 0;
    return new Promise(function (resolve) {
      function next() {
        if (i >= jobs.length && active === 0) return resolve();
        while (active < n && i < jobs.length) {
          active++;
          jobs[i++]().catch(function () {}).then(function () { active--; next(); });
        }
      }
      next();
    });
  }

  /* Load one pack. Idempotent and safe to call from anywhere — repeat calls return the same promise.
     Anything that fails to fetch or decode is simply skipped and that voice keeps its synth sound, so a
     partial set degrades instead of breaking. */
  RDMSamples.ensure = function (packKey, actx) {
    var meta = RDMSamples.PACKS[packKey];
    if (!meta) return Promise.reject(new Error("unknown sound pack: " + packKey));
    var P = packs[packKey] || (packs[packKey] = { sets: {}, ready: false, loading: null });
    if (P.ready) return Promise.resolve(P);
    if (P.loading) return P.loading;

    var ac = ctxFor(actx);
    if (!ac) return Promise.reject(new Error("no AudioContext available to decode into"));

    var jobs = [];
    Object.keys(VOICE).forEach(function (voice) {
      var sound = VOICE[voice];
      if (P.sets[sound]) return;                     // stick and stickLoud share one set; load it once
      var layers = (sound === "click")
        ? CLICK_LAYERS.map(function (L) { return { vel: L.vel, name: sound + "_" + L.name }; })
        : [{ vel: 0, name: sound }];                 // single layer: always chosen, whatever the velocity

      var dropped = (RDMSamples.DROP && RDMSamples.DROP[packKey]) || {};
      layers.forEach(function (L) {
        L.bufs = []; L.peaks = []; L.onsets = []; L.rr = 0;
        var skip = dropped[L.name] || [];
        for (var i = 1; i <= ROUND_ROBIN; i++) {
          if (skip.indexOf(i) >= 0) continue;      // a dud take: never fetched, never heard
          (function (n) {
            jobs.push(function () {
              return grab(meta.dir + "/" + L.name + "_" + n + ".wav")
                .then(function (ab) { return ac.decodeAudioData(ab.slice ? ab.slice(0) : ab); })
                .then(function (b) {
                  L.bufs[n - 1] = b;
                  L.peaks[n - 1] = peakOf(b);
                  L.onsets[n - 1] = onsetOf(b, L.peaks[n - 1]);
                });
            });
          })(i);
        }
      });
      P.sets[sound] = layers;
    });

    P.loading = pool(jobs, 12).then(function () {
      Object.keys(P.sets).forEach(function (sound) {
        P.sets[sound].forEach(function (L) {
          /* COMPACT. Dropped and failed takes leave holes, and the round robin steps by index — with
             holes it would land on an empty slot and fall through to the synth for that one note, which
             is a worse artefact than the take it was avoiding. Squeeze them out so every step lands on
             a real recording. `takes` keeps the original numbers for the picker's report. */
          var b = [], pk = [], on = [], takes = [];
          for (var i = 0; i < L.bufs.length; i++) {
            if (!L.bufs[i]) continue;
            b.push(L.bufs[i]); pk.push(L.peaks[i]); on.push(L.onsets[i]); takes.push(i + 1);
          }
          L.bufs = b; L.peaks = pk; L.onsets = on; L.takes = takes;
        });
        P.sets[sound] = P.sets[sound].filter(function (L) { return L.bufs.length > 0; });
        if (!P.sets[sound].length) delete P.sets[sound];
      });
      P.ready = Object.keys(P.sets).length > 0;
      P.loading = null;
      return P;
    });
    return P.loading;
  };

  RDMSamples.isReady = function (packKey) { return !!(packs[packKey] && packs[packKey].ready); };
  // dev only: dev/sample-picker.html needs the decoded buffers to play one take on its own
  RDMSamples._sets = function (packKey) { return packs[packKey] && packs[packKey].sets; };
  RDMSamples._voiceMap = function () { return VOICE; };
  RDMSamples._layerNames = function () {
    return CLICK_LAYERS.map(function (L) { return "click_" + L.name; })
      .concat(["rim", "rimshot", "stick", "cross"]);
  };
  RDMSamples.ROUND_ROBIN = ROUND_ROBIN;
  RDMSamples.report = function (packKey) {
    var P = packs[packKey];
    if (!P) return null;
    var out = {};
    Object.keys(P.sets).forEach(function (s) {
      out[s] = P.sets[s].map(function (L) { return { layer: L.name, took: L.bufs.length, vel: L.vel, takes: L.takes || null }; });
    });
    return out;
  };

  // pick the layer whose played velocity best matches this note's, without going over where possible
  function layerFor(layers, v) {
    var pick = layers[0];
    for (var i = 0; i < layers.length; i++) if (v >= layers[i].vel - 1e-9) pick = layers[i];
    return pick;
  }

  /* Install / remove. install() is idempotent; uninstall() puts the engine's own method back, so an A/B
     can flip without reloading. Installed automatically on load — it is inert until a voice is actually
     set to a sampled tone. */
  RDMSamples.install = function () {
    var Pl = global.RDMPlayer;
    if (!Pl || original) return;
    original = Pl.prototype._voiceClick;

    Pl.prototype._voiceClick = function (timbre, time, freq, gain, dur, type) {
      var synth = original;
      /* WHICH SOUND IS THIS VOICE SET TO. Per voice, straight off the same _toneSel the synth path reads,
         so Settings needs to know nothing about samples existing. */
      var tone = this._toneSel && this._toneSel[timbre];
      var pk = tone && RDMSamples.PACKS[tone] ? packs[tone] : null;
      if (!pk || !pk.ready) {
        /* Chosen but not in memory yet: start the fetch and play the synth this note. The app also kicks
           this off when the chip is pressed, so in practice this only covers a cold reload mid-session. */
        if (tone && RDMSamples.PACKS[tone] && this.actx) RDMSamples.ensure(tone, this.actx).catch(function () {});
        return synth.call(this, timbre, time, freq, gain, dur, type);
      }
      var layers = pk.sets[VOICE[timbre]];
      if (!layers || !this.actx) return synth.call(this, timbre, time, freq, gain, dur, type);
      // the engine treats a gain at/below its ramp floor as silence (a voice switched off in Settings)
      if (!(gain > 0.0001)) return;

      /* Recover the velocity the engine used. gain = BASE_GAIN x vel^GAMMA x userLevel, and all three
         are readable off the player, so this is exact rather than a guess. */
      var D = this.DYN;
      var base = (D.BASE_GAIN && D.BASE_GAIN[timbre]) || 0.5;
      var mul = (this._soundMul && this._soundMul[timbre] != null) ? this._soundMul[timbre] : 1;
      var v = 1;
      if (base > 0 && mul > 0) {
        v = Math.pow(gain / (base * mul), 1 / (D.GAMMA || 2));
        if (!isFinite(v) || v < 0) v = 1;
        if (v > 1) v = 1;
      }

      var L = layerFor(layers, v);
      var n = L.bufs.filter(Boolean).length;
      if (!n) return synth.call(this, timbre, time, freq, gain, dur, type);

      // cycle the round-robins so a fast passage never repeats the same recording twice running
      var idx = L.rr % L.bufs.length;
      L.rr = (L.rr + 1) % (L.bufs.length * 997);      // large stride keeps it from syncing to the music
      var buf = L.bufs[idx];
      while (!buf) { idx = (idx + 1) % L.bufs.length; buf = L.bufs[idx]; }

      var src = this.actx.createBufferSource();
      src.buffer = buf;
      /* Re-derive the gain on a softer curve when a lift is set, from the SAME base and user level the
         engine used — so Settings, dynamics, hairpins and the per-voice balance all still apply. Only
         the velocity exponent differs, and only for sampled playback. */
      var want = gain;
      if (RDMSamples.gamma && base > 0 && mul > 0) want = base * mul * Math.pow(v, RDMSamples.gamma);

      var g = this.actx.createGain();
      // the whole loudness model, in one line — see the header
      g.gain.value = (want / (L.peaks[idx] || 1)) * RDMSamples.level;
      src.connect(g).connect(this.master);

      var at = Math.max(0, time + (RDMSamples.attackAlign || 0));
      var skip = L.onsets[idx] || 0;
      src.start(at, skip);
      if (RDMSamples.maxTail) src.stop(at + RDMSamples.maxTail);
    };
  };

  RDMSamples.uninstall = function () {
    if (!original || !global.RDMPlayer) return;
    global.RDMPlayer.prototype._voiceClick = original;
    original = null;
  };
  RDMSamples.installed = function () { return !!original; };

  global.RDMSamples = RDMSamples;
  // inert until a voice is set to a sampled tone, so installing on load costs nothing
  if (global.RDMPlayer) RDMSamples.install();
})(typeof window !== "undefined" ? window : globalThis);
