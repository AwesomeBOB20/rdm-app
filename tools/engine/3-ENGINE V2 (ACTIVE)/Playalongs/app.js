/* ============================================================
   RDM Playalongs — app logic (app.js)
   Wires the UI to the shared RDMPlayer engine + the exercise/
   playlist data. Keeps all Playalongs-specific behavior here so
   the engine + theme stay generic and reusable by other tools.
   ============================================================ */

function mountPlayalongs(root, ctx) {
  "use strict";
  ctx = ctx || {}; root = root || document;

  /* ---------- data ---------- */
  /* FREEMIUM (Anthony, 2026-07-31). ctx.paid === false is the limited tier. Filtering the catalog HERE,
     before anything else touches EXERCISES, is deliberate: every downstream feature (categories, search,
     favorites, playlists, the queue, prev/next) reads this one array, so a single filter covers all of
     them and there is no path that can surface a locked exercise by going round the back.

     ctx.freeFiles comes from public.free_exercises — the SAME table the Storage RLS policy enforces — so
     the list shown and the list the vault will actually serve cannot drift apart. If it is missing for
     any reason we fail CLOSED (empty list) rather than showing the full catalog to a free account.
     Uploads are the user's own files and are added later, deliberately unaffected by this. */
  var PAID = ctx.paid !== false;
  var EXERCISES = (window.EXERCISES_RDM || window.EXERCISES || []).slice();
  if (!PAID) {
    var freeSet = {};
    (ctx.freeFiles || []).forEach(function (f) { freeSet[String(f)] = true; });
    EXERCISES = EXERCISES.filter(function (ex) { return freeSet[ex.file]; });
  }
  // Playlists are keyed by the stable .musicxml filename (see playlists-rdm.js) so they survive
  // catalog rebuilds where numeric ids drift. Legacy id-keyed PLAYLISTS still work as a fallback.
  var PLAYLISTS = (window.PLAYLISTS_RDM || window.PLAYLISTS || []).slice();
  // The user's OWN playlists (from their account), same shape as the curated ones + an id/_user flag.
  var userPlaylists = (ctx.playlists && ctx.playlists.initial ? ctx.playlists.initial : []).map(function (p) {
    return { id: p.id, name: p.name, items: (p.items || []).slice(), _user: true };
  });
  function userPlaylistById(id) { for (var i = 0; i < userPlaylists.length; i++) if (userPlaylists[i].id === id) return userPlaylists[i]; return null; }
  EXERCISES.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });

  // Normalize category keys so data typos can't spawn duplicate categories: "Accent Tap" / "accent tap"
  // (space) / "accent-tap" all collapse to one key. Done once up front so every downstream use is clean.
  function normCat(c) { return String(c).trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-"); }
  EXERCISES.forEach(function (ex) {
    if (!ex.category) return;
    var seen = {}, list = [];
    ex.category.forEach(function (c) { var k = normCat(c); if (k && !seen[k]) { seen[k] = true; list.push(k); } });
    ex.category = list;
  });

  var CAT_LABELS = {
    "all": "All Categories", "one-handers": "One Handers", "accent-tap": "Accent Tap",
    "rhythms": "Rhythms", "rudiments": "Rudiments", "timing": "Timing",
    "paradiddles": "Paradiddles", "singles": "Singles", "rolls": "Rolls",
    "natural-decays": "Natural Decays", "flams": "Flams", "hybrids": "Hybrids",
    "78-grids": "7/8 Grids", "juxtapositions": "Juxtapositions", "exercises": "Exercises",
    "etudes": "Etudes", "requests": "Requests", "instagram": "Instagram"   // Instagram pinned last in the list
  };
  function titleCase(s) { return String(s).replace(/-/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function catLabel(key) { return CAT_LABELS[key] || titleCase(key); }
  // order an exercise's categories to match the dropdown / canonical order (CAT_LABELS key order),
  // so the subtitle under the title reads in the same sequence as the category menu.
  function catsInOrder(cats) {
    var order = Object.keys(CAT_LABELS);
    return (cats || []).slice().sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  // categories actually present in the data
  var presentCats = {};
  EXERCISES.forEach(function (ex) { (ex.category || []).forEach(function (c) { presentCats[c] = true; }); });
  // Order follows the canonical CAT_LABELS order (not alphabetical), so the picker reads in the
  // intended sequence: All → One Handers → Accent Tap → Rhythms → … → Requests.
  var CATEGORIES = ["all"].concat(
    Object.keys(CAT_LABELS).filter(function (c) { return c !== "all" && presentCats[c]; })
  );
  // append any present-but-unlisted categories at the end (alphabetical) so none are ever hidden
  Object.keys(presentCats).sort().forEach(function (c) {
    if (CATEGORIES.indexOf(c) === -1) CATEGORIES.push(c);
  });
  // virtual "Favorites" filter — pinned at the BOTTOM of the list (styled distinct/purple in the picker)
  CAT_LABELS["__favorites__"] = "Favorites";
  CATEGORIES.push("__favorites__");

  // virtual "My Uploads" filter (only when embedded with an account) — the user's own MusicXML files,
  // stored on their account. Each becomes an exercise whose XML is loaded from the account, not the catalog.
  function makeUploadEx(u) {
    return { id: "upload:" + u.id, file: "upload:" + u.id, name: u.title,
             category: u.isOwner ? ["__uploads__"] : ["__shared_uploads__"], isUpload: true, uploadId: u.id,
             isShared: u.isShared, isOwner: u.isOwner, uploaderName: u.uploaderName };
  }
  if (ctx.uploads) {
    CAT_LABELS["__uploads__"] = "My Uploads";
    CAT_LABELS["__shared_uploads__"] = "Shared Uploads";
    if (CATEGORIES.indexOf("__uploads__") === -1) CATEGORIES.push("__uploads__");   // bottom of the list
    if (CATEGORIES.indexOf("__shared_uploads__") === -1) CATEGORIES.push("__shared_uploads__");
    (ctx.uploads.initial || []).forEach(function (u) { EXERCISES.push(makeUploadEx(u)); });
  }

  function exById(id) { for (var i = 0; i < EXERCISES.length; i++) if (EXERCISES[i].id === id) return EXERCISES[i]; return null; }
  function exByFile(f) { if (!f) return null; for (var i = 0; i < EXERCISES.length; i++) if (EXERCISES[i].file === f) return EXERCISES[i]; return null; }

  /* ---------- favorites ----------
     Persisted in localStorage, keyed by the stable .musicxml filename (ex.file) so favorites survive
     catalog rebuilds where numeric ids drift (same reasoning as playlists, see top of file). */
  var FAV_KEY = "rdm_pa_favorites";
  var favorites = (function () {
    // Embedded in the app with a logged-in account → seed from the account (ctx.favorites.initial).
    // Standalone (or logged-out) → the localStorage cache. Keyed by the stable .musicxml filename.
    if (ctx.favorites && Array.isArray(ctx.favorites.initial)) return new Set(ctx.favorites.initial);
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch (e) { return new Set(); }
  })();
  function isFav(ex) { return !!(ex && ex.file && favorites.has(ex.file)); }
  function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favorites))); } catch (e) {} }
  function toggleFav(ex) {
    if (!ex || !ex.file) return false;
    if (favorites.has(ex.file)) favorites.delete(ex.file); else favorites.add(ex.file);
    saveFavs();
    var on = favorites.has(ex.file);
    // write-through to the account (optimistic; localStorage above is the offline cache)
    if (ctx.favorites && ctx.favorites.set) { try { ctx.favorites.set(ex.file, on); } catch (e) {} }
    return on;
  }
  var STAR_SVG = "<svg class='fav-ico' viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'><path d='M12 2.6l2.74 5.55 6.12.89-4.43 4.32 1.05 6.1L12 18.7l-5.48 2.88 1.05-6.1L3.14 9.04l6.12-.89L12 2.6z'></path></svg>";
  var STAR_OUTLINE_SVG = "<svg class='fav-ico' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linejoin='round' aria-hidden='true'><path d='M12 2.6l2.74 5.55 6.12.89-4.43 4.32 1.05 6.1L12 18.7l-5.48 2.88 1.05-6.1L3.14 9.04l6.12-.89L12 2.6z'></path></svg>";
  var TRASH_SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M3 6h18'></path><path d='M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2'></path><path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'></path></svg>";
  var EDIT_SVG = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M12 20h9'></path><path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'></path></svg>";

  /* ---------- elements ---------- */
  var $ = function (id) { return root.getElementById(id); };
  // Catalog dir relative to Playalongs/ ("../.." = 1-WEBSITE-AND-APPS/). Spaces pre-encoded so
  // fetch() works; the filename itself is encodeURIComponent'd at the call site. Change this one
  // constant if the .musicxml files are hosted elsewhere (e.g. alongside the Webflow embed).
  // When embedded in the app, ctx.catalogDir is an ABSOLUTE served path (a relative one would resolve
  // against the React route URL, not the tool).
  var CATALOG_DIR = ctx.catalogDir || "../../music%20xml%20files/";

  var ICON_PLAY  = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>';
  var ICON_PAUSE = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"></path></svg>';

  var els = {
    scrollarea: $("scrollarea"), dock: $("dock"),
    playlistBtn: $("playlistBtn"), queueBtn: $("queueBtn"), stopPlaylistBtn: $("stopPlaylistBtn"),
    playlistProgressWrap: $("playlistProgressWrap"), playlistProgress: $("playlistProgress"),
    playlistFill: $("playlistFill"), playlistLabel: $("playlistLabel"), playlistLabelOver: $("playlistLabelOver"),

    categoryBtn: $("categoryBtn"),
    exerciseBtn: $("exerciseBtn"), undoExerciseBtn: $("undoExerciseBtn"), redoExerciseBtn: $("redoExerciseBtn"), favBtn: $("favBtn"), randNowBtn: $("randNowBtn"),
    // exercise/rep navigation lives on the sheet title now (orange = exercise, teal = rep in playlist mode)
    titlePrevEx: $("titlePrevEx"), titleNextEx: $("titleNextEx"), titlePrevRep: $("titlePrevRep"), titleNextRep: $("titleNextRep"),

    exerciseTitle: $("exerciseTitle"), exerciseCats: $("exerciseCats"), sheetHead: $("sheetHead"), sheetTitle: $("sheetTitle"), sheetTitleText: $("sheetTitleText"),
    sheetWrap: $("sheetWrap"), score: $("score"), sheetPlaceholder: $("sheetPlaceholder"), stkChart: $("stkChart"),

    sizeDown: $("sizeDown"), sizeUp: $("sizeUp"), sizeVal: $("sizeVal"), followBtn: $("followBtn"),
    rewindBtn: $("rewindBtn"), playBtn: $("playBtn"), metroBtn: $("metroBtn"), tempoSlider: $("tempoSlider"), tempoFill: $("tempoFill"), tempoLabel: $("tempoLabel"), tempoInput: $("tempoInput"), tempoNote: $("tempoNote"), tapTempoBtn: $("tapTempoBtn"),
    progressBar: $("progressBar"), progressFill: $("progressFill"), mainTimeLabel: $("mainTimeLabel"),
    progressLabelOver: $("progressLabelOver"),

    randAuto: $("randAuto"), randReps: $("randReps"), randMin: $("randMin"), randMax: $("randMax"), randomizeBtn: $("randomizeBtn"),
    bumpAuto: $("bumpAuto"), bumpReps: $("bumpReps"), bumpStep: $("bumpStep"), bumpBtn: $("bumpBtn"),
    loopPanel: $("loopPanel"), loopFrom: $("loopFrom"), loopTo: $("loopTo"), loopClearBtn: $("loopClearBtn"), loopCountOff: $("loopCountOff"), loopCountOffBeats: $("loopCountOffBeats"),
    // From/To are always-visible − [n] + steppers (the Sight-Reading Lab's shape); there is no
    // chevron drop-out any more.
    loopFromDown: $("loopFromDown"), loopFromUp: $("loopFromUp"), loopToDown: $("loopToDown"), loopToUp: $("loopToUp"),

    picker: $("picker"), pickerTitle: $("pickerTitle"), pickerSearch: $("pickerSearch"),
    pickerClose: $("pickerClose"), pickerList: $("pickerList")
  };

  // the exercise button label lives in a <span class="lbl"> so CSS can clamp it to 2 lines
  function setExerciseBtnLabel(name) {
    var s = els.exerciseBtn.querySelector(".lbl");
    if (s) s.textContent = name; else els.exerciseBtn.textContent = name;
  }
  // Paint the on-paper title text (name + optional categories line) into the header's text block,
  // WITHOUT touching the flanking nav chevrons that share the .sheet__title flex row.
  function setSheetTitle(name, catKeys) {
    if (!els.sheetTitleText) return;
    els.sheetTitleText.textContent = "";
    var nameEl = document.createElement("span");
    nameEl.className = "name-line";
    nameEl.textContent = name;
    els.sheetTitleText.appendChild(nameEl);
    if (catKeys && catKeys.length) {
      var catsEl = document.createElement("span");
      catsEl.className = "cats";
      // the actively-selected category (if any) is highlighted orange; "All Categories"/Favorites → none
      var sel = (currentCategory && currentCategory !== "all" && currentCategory !== "__favorites__" && currentCategory !== "__uploads__" && currentCategory !== "__shared_uploads__") ? currentCategory : null;
      catKeys.forEach(function (k, i) {
        if (i) catsEl.appendChild(document.createTextNode(" · "));
        var span = document.createElement("span");
        span.className = "cat" + (k === sel ? " cat--sel" : "");
        span.textContent = catLabel(k);
        catsEl.appendChild(span);
      });
      els.sheetTitleText.appendChild(catsEl);
    }
    // in playlist mode, name the active playlist on the card too (purple, like the Playlist tab)
    if (inPlaylist && playlist && playlist.name) {
      var plEl = document.createElement("span");
      plEl.className = "sheet-playlist";
      plEl.textContent = playlist.name;
      els.sheetTitleText.appendChild(plEl);
    }
  }
  // re-render the current exercise's title lines (category highlight + playlist name) when they change
  // without the loaded exercise itself changing (e.g. picking a category it belongs to, or entering a playlist)
  function refreshSheetCats() {
    if (currentExercise) setSheetTitle(currentExercise.name, catsInOrder(currentExercise.category));
  }
  // reflect the current exercise's favorite state on the main ★ button
  function updateFavBtn() {
    if (!els.favBtn) return;
    var on = isFav(currentExercise);
    els.favBtn.disabled = !currentExercise;
    els.favBtn.setAttribute("aria-pressed", on ? "true" : "false");
    els.favBtn.title = !currentExercise ? "Favorite" : (on ? "Remove from favorites" : "Add to favorites");
    var lbl = els.favBtn.querySelector(".favlbl");
    if (lbl) lbl.textContent = on ? "Favorited" : "Favorite";   // star fill is driven by aria-pressed (CSS)
  }
  // sheet-card dice: disabled with no exercise yet, or mid-playlist. Read fresh each call — called from
  // both updateFavBtn (exercise changes, incl. during a playlist's rep advance) and setPlaylistMode
  // (entering/leaving playlist), so neither call site can go stale and re-enable it out of turn.
  function updateRandNowBtn() { if (els.randNowBtn) els.randNowBtn.disabled = !currentExercise || inPlaylist; }

  /* ---------- state ---------- */
  var currentCategory = "all";
  var currentExercise = null;
  var loadedId = null;
  var undoStack = [], redoStack = [];   // random-pick history for the Undo/Redo buttons
  var userAdjusting = false;
  var inPlaylist = false;
  var playlist = null;
  var queue = [];          // [{exerciseId, tempo, name}]
  var queueIndex = 0;
  var playlistTimeMode = "time";   // "time" | "percent" — playlist bar label mode (click toggles); default matches the main bar
  var _plWithinSec = 0;            // elapsed seconds inside the CURRENT queue entry (from onTime)
  var _beatsCache = {};            // exerciseId -> beats (number, resolved) | Promise (in flight)

  /* ---------- stable render width ----------
     The notation is drawn at this width. We read the score box ONCE at a settled moment (boot + after a
     genuine window resize) and cache it. Renders during an exercise load use this cache instead of a live
     read, because reading clientWidth mid-load can momentarily return a too-small value (a reflow blip),
     which would draw the music narrow and then force a second "snap" re-render. Cache = no blip = one
     clean render per load. The score box width is scrollbar-independent (scrollbar-gutter reserves it),
     so this value is correct whether or not a scrollbar is showing. */
  var stableRenderW = 0;
  // only trust a real, laid-out width — a not-yet-settled layout can report a tiny value, which would
  // draw the music squished into a thin column. Ignore anything implausibly small.
  function measureStableRenderW() { var w = els.score.clientWidth; if (w > 150) stableRenderW = w; }

  /* ---------- engine ---------- */
  var player = new RDMPlayer($("score"), {
    // asymmetric meters (5/8, 7/8, 11/8...) click straight quarter notes here instead of the bare
    // denominator unit (Anthony: "I wanna just hear the quarter note continue through") — the Sightreading
    // Lab intentionally keeps the finer click since its generated rhythms need it. True compound meters
    // (6/8, 9/8, 12/8) are unaffected either way, in both tools.
    metroAsymmetricSimple: true,
    getRenderWidth: function () { return stableRenderW || els.score.clientWidth || 0; },
    // "100%" is a per-screen baseline, not a fixed absolute scale. At desktop widths (>=780px) it's 1.0
    // so nothing changes; on narrower screens it scales down (floor 0.5) so the default size feels right
    // instead of zoomed-in. The size label still shows the RELATIVE user zoom, and +/- work off this base.
    // Phones draw at 0.8x what they used to: the size Anthony was hand-zooming to on his phone is now
    // simply what "100%" gives you (2026-07-22). The narrow branch is the old one scaled by 0.8 at every
    // width, so it also no longer JUMPS at the 780px boundary — a 779px window used to render at 0.999
    // against desktop's 0.8, i.e. bigger music on the smaller screen.
    baseScale: function (w) { w = w || 780; return w >= 780 ? 0.8 : Math.max(0.48, w / 780 * 0.8); },
    // Space every bar evenly instead of leaving a forced hole before each bar line. VexFlow's
    // proportional formatter reserves the LAST note's full duration as empty space after it, so a bar
    // ending on an 8th ends with an 8th-note-wide gap no matter how the rest of the bar is packed.
    // This spreads the notes so the trailing gap is only the last note's proportional share, the same
    // share every other note gets. Sightreading Lab has always run this way; Playalongs was left on
    // VexFlow's raw spacing, which is the gap Anthony flagged. (Anthony, 2026-07-22)
    fillTrailing: true,
    onTime: function (t) {
      var pct = t.fraction * 100;
      els.progressFill.style.width = pct + "%";
      // one plain text node ("M:SS / M:SS") for BOTH the dark label and the white masked copy — identical
      // content = identical width, so the two stay aligned at the fill seam AND the spaces around the slash
      // survive (separate <span>s in a flex label get their surrounding whitespace trimmed).
      var mainStr = fmtTime(t.currentSec) + " / " + fmtTime(t.totalSec);
      els.mainTimeLabel.textContent = mainStr;
      if (els.progressLabelOver) els.progressLabelOver.textContent = mainStr;
      // playlist bar tracks elapsed-across-the-whole-playlist: current entry's elapsed + prior entries
      if (inPlaylist) { _plWithinSec = t.currentSec; updatePlaylistProgress(); }
    },
    onTempoChange: function (bpm) {
      if (!userAdjusting) {
        els.tempoSlider.value = bpm;
        paintSlider();
      }
      setTempoReadout(bpm);
    },
    onState: function (playing) {
      els.playBtn.classList.toggle("is-playing", playing);
      els.playBtn.innerHTML = (playing ? ICON_PAUSE : ICON_PLAY);   // icon only — no Play/Pause text
      if (ctx.onAudio) ctx.onAudio(playing);   // practice-time tracking
    },
    onNote: function (n) { if (ctx.onNotesPlayed) ctx.onNotesPlayed(n); },   // "notes played" stat

    onLoad: function (info) {
      els.tempoSlider.min = info.min;
      els.tempoSlider.max = info.max;
      els.tempoSlider.value = info.tempo;
      setTempoReadout(info.tempo);
      if (els.tempoNote) {
        // reflect this piece's beat unit (♩ / ♩.). The dot is a drawn CSS circle (.dock__tempo-dot), NOT
        // the literal "." — a text period renders oversized on mobile browsers; a sized circle is consistent.
        var g = player.beatGlyph(), di = g.indexOf(".");
        var note = di >= 0 ? g.slice(0, di) : g;
        els.tempoNote.innerHTML = note + (di >= 0 ? '<span class="dock__tempo-dot"></span>' : "") + " =";
      }
      paintSlider();
      // show this exercise's real assumed range as grayed placeholders — an empty field means
      // "use this" (the engine already falls back to the full range when min/max are blank)
      els.randMin.placeholder = info.min;
      els.randMax.placeholder = info.max;
      resetScoreScroll();   // new exercise loaded → back to the top of the page
    },
    onLoop: function () { if (inPlaylist) return; },
    onLoopRange: function (info) {
      if (loopChip) {
        if (!info) { loopChip.hidden = true; }
        else {
          // note-precise M/B/P label from the engine, e.g. "Looping M20 B3 P2 – M30"
          loopChipTxt.textContent = "Looping " + (info.label || (barOfMeasure(info.m0) + (info.m1 !== info.m0 ? "–" + barOfMeasure(info.m1) : "")));
          loopChip.hidden = false;
        }
      }
      syncLoopPanel(info);   // keep the Loop panel in lockstep with the staff
      if (typeof updateTabIndicators === "function") updateTabIndicators();   // light/clear the Loop tab dot
    }
  });
  window.__paPlayer = player;   // debug handle (harmless; same pattern the SR Lab uses)
  // loop chip (created here so the callback above can reference it; populated by onLoopRange)
  var loopChip = document.createElement("div");
  loopChip.className = "loopchip"; loopChip.hidden = true;
  loopChip.innerHTML = '<svg class="loopchip__ico ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg><span class="loopchip__txt"></span><button type="button" class="loopchip__x" aria-label="Clear loop">✕</button>';
  var loopChipTxt = loopChip.querySelector(".loopchip__txt");
  loopChip.querySelector(".loopchip__x").addEventListener("click", function () { player.clearLoop(); });
  // live in the sheet footer, in the MIDDLE: zoom (left) · loop chip · [follow + favorite] (right group)
  var _foot = root.getElementById("sheetFoot");
  var _actions = _foot && _foot.querySelector(".sheet__foot-actions");
  if (_actions) _foot.insertBefore(loopChip, _actions);
  else if (_foot) _foot.appendChild(loopChip);
  else els.sheetWrap.appendChild(loopChip);

  /* ---------- helpers ---------- */
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function paintSlider() {
    var min = +els.tempoSlider.min, max = +els.tempoSlider.max, val = +els.tempoSlider.value;
    var pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    if (els.tempoFill) els.tempoFill.style.width = pct + "%";
  }
  function filteredExercises() {
    if (currentCategory === "__favorites__") return EXERCISES.filter(isFav);
    if (currentCategory === "__uploads__") return EXERCISES.filter(function (e) { return e.isUpload && e.isOwner; });
    if (currentCategory === "__shared_uploads__") return EXERCISES.filter(function (e) { return e.isUpload && !e.isOwner; });
    if (currentCategory === "all") return EXERCISES.slice();
    return EXERCISES.filter(function (ex) { return (ex.category || []).indexOf(currentCategory) !== -1; });
  }

  /* ---------- load an exercise ---------- */
  var loadToken = 0;          // guards against out-of-order async loads (fast prev/next/random)

  /* ---- converted-RDM cache + idle prefetch (make Randomize/Next/Prev feel INSTANT, like the Sightreading
     Lab's generate) ----
     The engine's player.load already supports an instant {rdm} path (no fetch, no XML parse, no convert) —
     SR Lab uses it, and Playalongs already uses it for "N Note Stickings". Here we fetch+convert each
     .musicxml ONCE, keep the converted RDM keyed by file, and load from that cache on repeats; an idle
     prefetch warms the neighbors (Next/Prev) + a small random pool (Randomize) so most navigations skip the
     network entirely. On localhost the FIRST fetch of a file still uses the ?dev= buster (so musicxml edits
     appear on reload); within a session, repeats are instant. */
  var _rdmCache = Object.create(null);   // ex.file -> converted RDM
  var _rdmOrder = [];                     // FIFO keys for a simple size cap
  // Raised to cover the WHOLE catalog (~493 exercises, 2026-07-18) — the full-catalog background warm
  // below (scheduleCatalogWarm) is pointless if the FIFO cap evicts early files before the sweep even
  // finishes reaching the end of the list.
  var RDM_CACHE_MAX = 600;
  function _cacheRdm(file, rdm) {
    if (!file || !rdm || _rdmCache[file]) return;
    _rdmCache[file] = rdm; _rdmOrder.push(file);
    while (_rdmOrder.length > RDM_CACHE_MAX) { delete _rdmCache[_rdmOrder.shift()]; }
  }
  function _exUrl(file) {
    var url = CATALOG_DIR + encodeURIComponent(file);
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") url += "?dev=" + Date.now();
    return url;
  }
  /* The ONE way this tool gets an exercise's MusicXML text. Embedded in the RDM app, ctx.catalog pulls it
     from the paywalled Storage vault (the .musicxml files are NOT shipped publicly). Standalone (the local
     dev server / any static host), it falls back to fetching CATALOG_DIR off disk as before. */
  function _xmlText(file) {
    if (ctx.catalog && ctx.catalog.getXML) return Promise.resolve(ctx.catalog.getXML(file));
    return fetch(_exUrl(file)).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
  }
  // Promise<rdm>, populating the cache. Cached → resolves immediately (no fetch). Shared by loadExercise +
  // prefetch so both paths end at player.load({rdm}).
  function fetchRdm(ex) {
    if (_rdmCache[ex.file]) return Promise.resolve(_rdmCache[ex.file]);
    // account uploads pull their MusicXML from the user's account (Storage), not the catalog dir
    var xmlP = (ex.isUpload && ctx.uploads && ctx.uploads.getXML)
      ? Promise.resolve(ctx.uploads.getXML(ex.uploadId))
      : _xmlText(ex.file);
    return xmlP.then(function (xml) { var rdm = RDMConvert.convert(xml); _cacheRdm(ex.file, rdm); return rdm; });
  }
  var _isStickingEx = function (ex) { return !!(window.RDMStickings && /^(\d+)\s*Note\s*Stickings\b/i.test(ex && ex.name || "")); };
  var _prefetching = Object.create(null);
  function prefetchExercise(ex, onDone) {   // fetch+convert into the cache, no render; idempotent
    // Uploads used to be excluded here (and in the warm loop below), so opening one always ran a cold
    // download+parse+convert+layout burst right as playback started — that's why uploads animated laggy
    // while pre-warmed base exercises were smooth. Warm them the same way now (Anthony, 2026-07-24). The
    // uploads fetch is memoized in ToolMount's adapter, so warm + open share a single download.
    if (!ex || !ex.file || _rdmCache[ex.file] || _prefetching[ex.file] || _isStickingEx(ex) || !window.RDMConvert) { if (onDone) onDone(); return; }
    _prefetching[ex.file] = true;
    fetchRdm(ex).catch(function () {}).then(function () { delete _prefetching[ex.file]; if (onDone) onDone(); });
  }
  var _idleHandle = null;
  function scheduleIdlePrefetch() {
    if (_idleHandle) return;
    var ric = window.requestIdleCallback || function (fn) { return setTimeout(fn, 250); };
    _idleHandle = ric(function () {
      _idleHandle = null;
      if (inPlaylist || !currentExercise) return;
      var list = filteredExercises(); if (!list.length) return;
      var i = exerciseIndexInFilter(); if (i < 0) i = 0;
      prefetchExercise(list[(i + 1) % list.length]);                      // Next
      prefetchExercise(list[(i - 1 + list.length) % list.length]);        // Prev
      scheduleCatalogWarm();   // keep filling in the rest of the catalog so Randomize catches up too
    });
  }

  /* Randomize can land on ANY of the ~493 catalog exercises, so a handful of pre-warmed neighbors barely
     moves the odds — almost every Randomize click was a cache miss. So we warm the WHOLE catalog in the
     background. CRITICAL (Anthony, 2026-07-19 — "really bad loading"): the first cut fired all ~493 fetches
     at once with no concurrency cap, saturating the browser's ~6-per-host connection pool for 10+ seconds.
     A user's own Next/Prev/Randomize fetch then landed at the BACK of that queue and waited 5–11s — the
     warm made loads DRAMATICALLY WORSE. Fixes:
       1. HARD concurrency cap (WARM_CONCURRENCY) well under the browser's per-host limit, so there are
          always free connections for the user's own load.
       2. PAUSE entirely while a user load is in flight (_userLoadsPending) — the user's fetch owns the pipe.
     Self-resuming across idle slices; no-ops once the whole catalog is warm. */
  var _warmIndex = 0, _warmList = null, _warmHandle = null, _warmInFlight = 0;
  var WARM_CONCURRENCY = 3;      // << browser's ~6/host cap → user loads never queue behind the warm
  var _userLoadsPending = 0;     // >0 while a user-initiated exercise fetch is running (set in loadExercise)
  function scheduleCatalogWarm() {
    if (_warmHandle) return;
    var ric = window.requestIdleCallback || function (fn) { return setTimeout(function () { fn({ timeRemaining: function () { return 8; } }); }, 300); };
    function pump(deadline) {
      _warmHandle = null;
      if (!_warmList) _warmList = EXERCISES.slice();
      // launch only while the pipe is free: no live user load, under the concurrency cap, and idle budget left.
      while (!_userLoadsPending && _warmInFlight < WARM_CONCURRENCY && _warmIndex < _warmList.length
             && (!deadline || deadline.timeRemaining() > 4)) {
        var ex = _warmList[_warmIndex++];
        if (!ex || !ex.file || _rdmCache[ex.file] || _prefetching[ex.file] || _isStickingEx(ex) || !window.RDMConvert) continue;   // uploads included now (see prefetchExercise)
        _warmInFlight++;
        prefetchExercise(ex, function () { _warmInFlight--; });
      }
      if (_warmIndex < _warmList.length) _warmHandle = ric(pump, { timeout: 2000 });   // keep coming back until fully warm
    }
    _warmHandle = ric(pump, { timeout: 2000 });
  }
  // Replay the notation fade (CSS #score.score-in) each time a fresh exercise lands on the paper.
  // Only load paths call this — zoom/resize relayouts don't, so the music never blinks mid-practice.
  function fadeScoreIn() {
    els.score.classList.remove("score-in");
    void els.score.offsetWidth;               // reflow so the animation restarts on back-to-back loads
    els.score.classList.add("score-in");
  }
  // title + categories + engraved sheet title, applied together. Kept as one function so the visible
  // display always updates ATOMICALLY with whatever is actually on the paper — see loadExercise below
  // for why this is called from onLoad instead of eagerly (spamming Random used to flash through every
  // picked title instantly while the score stayed on the previous exercise until the final fetch won).
  function applyExerciseDisplay(ex, catKeys, cats) {
    els.exerciseTitle.textContent = ex.name;
    setExerciseBtnLabel(ex.name);
    updateFavBtn();
    updateRandNowBtn();
    if (cats) { els.exerciseCats.textContent = cats; els.exerciseCats.hidden = false; }
    else els.exerciseCats.hidden = true;
    // engraved title at the top of the paper (between the nav chevrons); pass the KEYS so the sheet can
    // highlight whichever category is currently selected
    setSheetTitle(ex.name, catKeys);
  }
  function loadExercise(ex, opts) {
    opts = opts || {};
    if (!ex) return;
    currentExercise = ex;   // internal state (undo/redo stack, "what are we loading") — stays synchronous
    loadedId = ex.id;

    var catKeys = catsInOrder(ex.category);
    var cats = catKeys.map(catLabel).join(" · ");

    // "N Note Stickings" exercises are generated live (fill-in template + pattern chart below the
    // staff), not fetched from a static .musicxml. RDMStickings.enter() builds + loads the template
    // and reveals the chart; loadStickingRDM handles the actual render/play. No network fetch involved,
    // so there's no lag to desync from — apply the visible display right away, same as before.
    var sm = window.RDMStickings && String(ex.name).match(/^(\d+)\s*Note\s*Stickings\b/i);
    if (sm) {
      applyExerciseDisplay(ex, catKeys, cats);
      ++loadToken;   // cancel any in-flight fetch so it can't clobber the generated score
      els.sheetPlaceholder.hidden = true;
      els.sheetWrap.classList.remove("loading");
      els.sheetWrap.classList.add("has-score");
      window.RDMStickings.enter(parseInt(sm[1], 10));
      fadeScoreIn();
      return;
    }
    if (window.RDMStickings) window.RDMStickings.exit();   // normal exercise — no chart

    // loading state on the sheet — keep the current sheet visible while the next one
    // loads, so rapid prev/next/random spam never flashes "Loading…". Only show the
    // "Loading…" placeholder on the very first load, when the staff is still empty.
    if (!els.sheetWrap.classList.contains("has-score")) {
      els.sheetWrap.classList.add("loading");   // brief blank paper on first load — no "Loading…" text flicker
    }
    els.playBtn.disabled = true;
    els.rewindBtn.disabled = true;
    els.metroBtn.disabled = true;

    // Convert once (cached), then hand the engine a PRE-BUILT rdm so player.load skips fetch+parse+convert
    // and only renders — the same instant path the Sightreading Lab uses. fetchRdm resolves immediately for
    // an already-cached / prefetched file; a cold file fetches+converts once, then caches. Both funnel
    // through the one success/error handler; the loadToken guard drops any superseded load before it renders.
    var token = ++loadToken;
    // Pause the background catalog-warm while THIS load's own network fetch is in flight, so the user's
    // fetch owns the connection pool instead of queuing behind hundreds of warm fetches (Anthony,
    // 2026-07-19). Only a cold (uncached) load actually fetches; a cache hit is instant and skips this.
    var _pausedWarm = !_rdmCache[ex.file];
    if (_pausedWarm) _userLoadsPending++;
    fetchRdm(ex)
      .then(function (rdm) {
        if (token !== loadToken) return null;      // superseded during fetch — drop before rendering
        return player.load({ rdm: rdm, originalTempo: ex.tempo });
      })
      .then(function () {
        if (token !== loadToken) return;           // superseded during render — drop this one
        applyExerciseDisplay(ex, catKeys, cats);   // title/categories/sheet-title land together WITH the score
        els.sheetPlaceholder.hidden = true;
        els.sheetWrap.classList.remove("loading");
        els.sheetWrap.classList.add("has-score");
        fadeScoreIn();                             // ease the fresh notation in instead of popping
        els.playBtn.disabled = false;
        els.rewindBtn.disabled = false;
        els.metroBtn.disabled = false;
        els.tempoSlider.disabled = inPlaylist; els.tempoInput.disabled = inPlaylist; els.tapTempoBtn.disabled = inPlaylist;
        if (opts.tempo != null) player.setTempo(opts.tempo);
        refreshSize();
        refreshLoopPanel();                        // new exercise -> reset/clamp the Loop Section panel
        updateDockShadow();
        fitScrollbar();                            // hide the scrollbar when the music effectively fits
        updateTitleNav();                          // enable the title chevrons now a score is on the paper
        if (opts.autoplay) player.play();
        scheduleIdlePrefetch();                    // warm neighbors + a random pool so the NEXT nav is instant
      })
      .catch(function (err) {
        if (token !== loadToken) return;
        els.sheetWrap.classList.remove("loading");
        els.sheetWrap.classList.remove("has-score");
        els.sheetPlaceholder.hidden = false;
        var fileProto = location.protocol === "file:";
        els.sheetPlaceholder.textContent = fileProto
          ? "Open this page over http:// (not by double-clicking the file)."
          : "Couldn't load this exercise";
        els.playBtn.disabled = true;
        els.rewindBtn.disabled = true;
        els.metroBtn.disabled = true;
        // surface the real reason in the console for debugging
        console.error("[Playalongs] failed to load", ex.file, "-", (err && err.message) || err,
          fileProto ? "(running from file:// — fetch of local files is blocked; serve over http)" : "");
      })
      .then(function () {   // always runs (after success OR catch): release the warm pause + resume it
        if (_pausedWarm) { _pausedWarm = false; _userLoadsPending = Math.max(0, _userLoadsPending - 1); scheduleCatalogWarm(); }
      });
  }

  /* ---------- sticking exercises (generated, not from the catalog) ----------
     stickings.js builds an RDM score in memory and hands it here; this mirrors loadExercise's
     success path but skips the fetch (player.load takes the ready-made rdm object). */
  function loadStickingRDM(rdm, meta) {
    if (!rdm) return;
    // update the on-paper title to include the plugged-in pattern (e.g. "3 Note Stickings · RLR").
    // currentExercise stays as the catalog exercise loadExercise set — so ★ / prev-next still work.
    els.exerciseTitle.textContent = rdm.title;
    setSheetTitle(rdm.title, null);

    var token = ++loadToken;   // cancel any in-flight exercise fetch so it can't clobber this
    els.sheetPlaceholder.hidden = true;
    els.sheetWrap.classList.remove("loading");
    els.sheetWrap.classList.add("has-score");
    player.load({ rdm: rdm, originalTempo: (meta && meta.tempo) || rdm.tempo }).then(function () {
      if (token !== loadToken) return;
      els.playBtn.disabled = false;
      els.rewindBtn.disabled = false;
      els.metroBtn.disabled = false;
      els.tempoSlider.disabled = inPlaylist; els.tempoInput.disabled = inPlaylist;
      refreshSize();
      refreshLoopPanel();
      updateDockShadow();
      fitScrollbar();
      updateTitleNav();
    });
  }

  /* ---------- exercise navigation ---------- */
  function exerciseIndexInFilter() {
    var list = filteredExercises();
    for (var i = 0; i < list.length; i++) if (currentExercise && list[i].id === currentExercise.id) return i;
    return -1;
  }
  function stepExercise(dir) {
    if (inPlaylist) return;
    var list = filteredExercises();
    if (!list.length) return;
    var i = exerciseIndexInFilter();
    i = (i === -1) ? 0 : (i + dir + list.length) % list.length;
    loadExercise(list[i]);
  }

  // ---- playlist navigation over WHOLE exercises ----
  // The queue holds one slot per rep×tempo, so an exercise spans many consecutive slots. These jump
  // across all of the current exercise's slots to the first slot of the next/previous exercise.
  function hasQueueExercise(dir) {
    if (!queue.length) return false;
    var curEx = queue[queueIndex].exerciseId, i = queueIndex;
    while (i >= 0 && i < queue.length && queue[i].exerciseId === curEx) i += dir;
    return i >= 0 && i < queue.length;
  }
  function stepQueueExercise(dir) {
    if (!inPlaylist || !queue.length) return;
    var curEx = queue[queueIndex].exerciseId, i = queueIndex;
    while (i >= 0 && i < queue.length && queue[i].exerciseId === curEx) i += dir;   // skip past current exercise
    if (i < 0 || i >= queue.length) return;                                          // none that direction
    if (dir < 0) {                                                                   // land on that exercise's FIRST slot
      var target = queue[i].exerciseId;
      while (i > 0 && queue[i - 1].exerciseId === target) i--;
    }
    playQueueEntry(i, true);
  }
  // Reflect the current mode/bounds on the title chevrons. Orange (ex) pair: step exercises (normal) or
  // skip whole exercises (playlist). Teal (rep) pair: step queue slots (playlist only).
  function updateTitleNav() {
    var hasScore = els.sheetWrap.classList.contains("has-score");
    if (inPlaylist) {
      els.titlePrevEx.disabled = !hasQueueExercise(-1);
      els.titleNextEx.disabled = !hasQueueExercise(1);
      els.titlePrevRep.disabled = queueIndex <= 0;
      els.titleNextRep.disabled = queueIndex >= queue.length - 1;
    } else {
      var n = filteredExercises().length;
      els.titlePrevEx.disabled = !hasScore || n <= 1;
      els.titleNextEx.disabled = !hasScore || n <= 1;
    }
  }

  els.titlePrevEx.addEventListener("click", function () { if (inPlaylist) stepQueueExercise(-1); else stepExercise(-1); });
  els.titleNextEx.addEventListener("click", function () { if (inPlaylist) stepQueueExercise(1); else stepExercise(1); });
  els.titlePrevRep.addEventListener("click", function () { if (inPlaylist && queueIndex > 0) playQueueEntry(queueIndex - 1, true); });
  els.titleNextRep.addEventListener("click", function () { if (inPlaylist && queueIndex < queue.length - 1) playQueueEntry(queueIndex + 1, true); });

  // Random-pick history: Undo steps back to the exercise you were on before the last Random,
  // Redo re-applies it. ONLY Random feeds the stacks — prev/next/picker/category don't touch them.
  function updateUndoRedo() {
    els.undoExerciseBtn.disabled = inPlaylist || !undoStack.length;
    els.redoExerciseBtn.disabled = inPlaylist || !redoStack.length;
  }
  // pick a random exercise from the current filtered list (2026-07-16: the ONLY trigger for this is now
  // randNowBtn on the sheet card — the old toolbar button was removed from the Exercise panel).
  function pickRandomExercise() {
    if (inPlaylist) return;
    var list = filteredExercises();
    if (!list.length) return;
    if (currentExercise) undoStack.push(currentExercise);   // remember where we came from
    redoStack.length = 0;                                    // a fresh random clears the redo trail
    loadExercise(list[Math.floor(Math.random() * list.length)]);
    updateUndoRedo();
  }
  els.undoExerciseBtn.addEventListener("click", function () {
    if (inPlaylist || !undoStack.length) return;
    redoStack.push(currentExercise);
    loadExercise(undoStack.pop());
    updateUndoRedo();
  });
  els.redoExerciseBtn.addEventListener("click", function () {
    if (inPlaylist || !redoStack.length) return;
    undoStack.push(currentExercise);
    loadExercise(redoStack.pop());
    updateUndoRedo();
  });
  updateUndoRedo();   // initial state (both disabled until a Random happens)
  // sheet-card dice, right next to the favorite star — the only way to pick a random exercise now that
  // the old toolbar button is gone (Anthony, 2026-07-16).
  if (els.randNowBtn) els.randNowBtn.addEventListener("click", pickRandomExercise);

  /* ---------- play / pause / rewind ---------- */
  els.playBtn.addEventListener("click", function () { if (!els.playBtn.disabled) player.toggle(); });
  els.rewindBtn.addEventListener("click", function () { if (!els.rewindBtn.disabled) player.seek(0); });
  // metronome click on/off — the engine layers the click in live, even mid-playback
  els.metroBtn.addEventListener("click", function () {
    if (els.metroBtn.disabled) return;
    var on = els.metroBtn.getAttribute("aria-pressed") !== "true";
    els.metroBtn.setAttribute("aria-pressed", on ? "true" : "false");
    player.setMetronome(on);
  });
  // metronome ON by default (button reflects it via aria-pressed="true"); the user can still toggle it off
  player.setMetronome(els.metroBtn.getAttribute("aria-pressed") === "true");

  /* ---------- loop selection + click-to-seek on the music ----------
     Drag across measures = choose a loop section (engine repeats just those bars).
     A plain click (no drag) = seek to that spot, as before. Text selection on the music
     is disabled in CSS so the drag reads as a clean selection gesture, not a text highlight. */

  // map a pointer position to SVG units inside the score, or null if not over the music
  function scoreXY(clientX, clientY) {
    if (!player.out) return null;
    var svg = els.score.querySelector("svg");
    if (!svg) return null;
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    var scale = player.out.width / rect.width;      // SVG units per rendered pixel
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }

  function seekToClick(clientX, clientY) {
    if (!player.anchors || !player.anchors.length || !player.totalBeats) return;
    var pt = scoreXY(clientX, clientY); if (!pt) return;
    // find the system (row of staves) closest to the click y
    var systems = [], anchors = player.anchors;
    anchors.forEach(function (a) {
      for (var i = 0; i < systems.length; i++) { if (Math.abs(systems[i].yTop - a.yTop) < 2) return; }
      systems.push({ yTop: a.yTop, yBot: a.yBot });
    });
    var bestSys = systems[0], bestDist = Infinity;
    systems.forEach(function (s) {
      var d = Math.abs(pt.y - (s.yTop + s.yBot) / 2);
      if (d < bestDist) { bestDist = d; bestSys = s; }
    });
    // when a loop is active, keep seeks inside the window so playback can't jump out of the loop
    var lo = player.hasLoop() ? player._loopLo() : -Infinity;
    var hi = player.hasLoop() ? player._loopHi() : Infinity;
    var best = null, bestXDist = Infinity;
    anchors.forEach(function (a) {
      if (Math.abs(a.yTop - bestSys.yTop) >= 2) return;
      if (a.beat < lo - 1e-6 || a.beat >= hi - 1e-6) return;
      var d = Math.abs(a.x - pt.x);
      if (d < bestXDist) { bestXDist = d; best = a; }
    });
    if (best) player.seek(best.beat / player.totalBeats);
  }

  (function () {
    // Note-precise loop selection.
    //   Desktop (mouse): click = seek + set the reference note; Shift-click a 2nd note OR drag = loop span.
    //   Mobile (touch):  tap = seek + set the reference note; LONG-PRESS a 2nd note = loop from the reference
    //                    to it, then keep dragging to slide that endpoint. A plain drag still SCROLLS the
    //                    music — we only take over the gesture once the long-press fires — so scrolling stays
    //                    natural and doesn't fight the selection.
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
      if (selAnchor == null) selAnchor = downA;             // no prior tap → the held note is the reference too
      try { els.score.setPointerCapture(capId); } catch (e) {}
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }   // haptic "you're now selecting"
      lastA = downA;
      player.drawLoopPreview(selAnchor, downA);             // show the region immediately
    }
    function cancelGesture() {               // wipe any in-flight selection (e.g. a 2nd finger starts a pinch)
      clearLP();
      if (capId != null) { try { els.score.releasePointerCapture(capId); } catch (e) {} capId = null; }
      downA = null; dragging = false; regionMode = false;
    }
    els.score.addEventListener("pointerdown", function (e) {
      if (inPlaylist) return;                               // no loop selection inside a playlist
      if (!player.anchors || !player.anchors.length) return;
      if (downA != null) return;                            // already tracking a finger — ignore extra pointers
      isTouch = (e.pointerType === "touch");
      if (!isTouch && e.button !== 0) return;
      downA = anchorAt(e.clientX, e.clientY);
      downX = e.clientX; downY = e.clientY; dragging = false; lastA = downA; downShift = e.shiftKey; regionMode = false;
      if (downA == null) return;
      capId = e.pointerId;
      if (isTouch) { clearLP(); lpTimer = setTimeout(armRegion, LONGPRESS_MS); }   // arm long-press; don't capture yet
      else { try { els.score.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    els.score.addEventListener("pointermove", function (e) {
      if (downA == null) return;
      var dx = e.clientX - downX, dy = e.clientY - downY;
      if (isTouch) {
        if (!regionMode) { if (dx * dx + dy * dy > MOVE_CANCEL2) cancelGesture(); return; }  // moved first → a scroll
        var a = anchorAt(e.clientX, e.clientY);             // region mode → drag slides the endpoint
        if (a != null) { lastA = a; player.drawLoopPreview(selAnchor, a); }
        return;
      }
      if (!dragging && dx * dx + dy * dy > 36) dragging = true;   // mouse: >6px → drag-select
      if (dragging) { var a2 = anchorAt(e.clientX, e.clientY); if (a2 != null) { lastA = a2; player.drawLoopPreview(downA, lastA); } }
    });
    // Block the page from scrolling only WHILE a region drag is live (after the long-press).
    els.score.addEventListener("touchmove", function (e) { if (regionMode) e.preventDefault(); }, { passive: false });
    // A second finger (pinch-zoom) cancels any pending/active loop selection.
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

  /* ---------- pinch-to-zoom the notation (mobile) ---------- */
  // While the fingers move we scale #score with a cheap CSS transform — smooth and CONTINUOUS, no
  // re-render — then commit the real re-layout ONCE on release. (Re-rendering mid-pinch destroys the SVG
  // your fingers are on, so the browser fires touchcancel and the pinch dies after one 1% step — that was
  // the bug.) This also stops the browser from pinch-stretching the page.
  (function () {
    var sw = els.score && els.score.closest && els.score.closest(".scorewrap");
    if (!sw) return;
    var pinching = false, startDist = 1, startZoom = 1, liveScale = 1;
    function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
    sw.addEventListener("touchstart", function (e) {
      if (e.touches.length === 2 && currentExercise && player.setZoom) {
        pinching = true; startDist = dist(e.touches) || 1; startZoom = player.getZoom ? player.getZoom() : 1; liveScale = 1;
        els.score.style.transformOrigin = "top center"; els.score.style.willChange = "transform";
      }
    }, { passive: true });
    sw.addEventListener("touchmove", function (e) {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault();                                                        // take the pinch off the browser
      var eff = Math.max(0.5, Math.min(2.5, startZoom * (dist(e.touches) / startDist)));   // clamp to the zoom range
      liveScale = eff / startZoom;
      els.score.style.transform = "scale(" + liveScale + ")";                    // live preview — cheap, no re-render
    }, { passive: false });
    function end(e) {
      if (!pinching || (e.touches && e.touches.length >= 2)) return;
      pinching = false;
      els.score.style.transform = ""; els.score.style.willChange = ""; els.score.style.transformOrigin = "";
      if (player.setZoom) { player.setZoom(startZoom * liveScale); refreshSize(); fitScrollbar(); }   // ONE real re-layout
    }
    sw.addEventListener("touchend", end); sw.addEventListener("touchcancel", end);
  })();

  /* ---------- Loop Section panel ----------
     Mirrors the on-staff drag selection. Steppers / number inputs set the bar range; the toggle
     button arms or clears the loop. Drag and panel stay in lockstep via onLoopRange -> syncLoopPanel. */
  function loopBarCount() { return (player.getMeasures && player.getMeasures().length) || 0; }
  // fallbackable clamp: an EMPTY input falls back to `def` (its placeholder value), then clamps.
  function clampInt(v, lo, hi, def) { v = parseInt(v, 10); if (isNaN(v)) v = (def != null ? def : lo); return Math.max(lo, Math.min(hi, v)); }
  // Bar numbers follow the PLAYBACK order (repeats/voltas expanded) — a repeated section counts each
  // pass, so "bar 7" means the 7th bar you HEAR, and users can target any point in the run-through.
  // getMeasures() returns one cell per played instance; the count-off is bar 1 (no special-casing).
  function barOfMeasure(mi) { return mi + 1; }                    // instance index -> displayed bar #
  function measureOfBar(bar) { return Math.max(0, Math.min(loopBarCount() - 1, bar - 1)); }
  function maxBar() { return loopBarCount(); }                    // highest selectable bar #
  // effective From/To: blank fields mean their placeholder defaults (1 / last bar = whole piece)
  function loopVals(mx) {
    var from = clampInt(els.loopFrom.value, 1, mx, 1);
    var to = clampInt(els.loopTo.value, 1, mx, mx);
    return { from: from, to: to };
  }
  // the Clear button is live only while a loop exists (and the panel is usable)
  function refreshClearBtn() { els.loopClearBtn.disabled = inPlaylist || !player.hasLoop(); }
  // reflect engine loop state into the panel (called by onLoopRange when drag/steppers/clear change it)
  function syncLoopPanel(info) {
    if (info) { els.loopFrom.value = barOfMeasure(info.m0); els.loopTo.value = barOfMeasure(info.m1); }
    else { els.loopFrom.value = ""; els.loopTo.value = ""; }   // no loop -> placeholders show the defaults
    refreshClearBtn();
  }
  // enable/disable + reset the panel for the current exercise (load / playlist change).
  // Fields sit EMPTY by default; their grayed placeholders show the assumed whole-piece range
  // (1 .. last played bar, repeats counted) — that mirrors what the app does with no loop set.
  function refreshLoopPanel() {
    var mx = maxBar(), usable = mx > 0 && !inPlaylist;
    [els.loopFrom, els.loopTo, els.loopFromDown, els.loopFromUp, els.loopToDown, els.loopToUp]
      .forEach(function (el) { if (el) el.disabled = !usable; });
    els.loopPanel.style.opacity = usable ? "" : ".55";
    els.loopFrom.placeholder = "1";
    els.loopTo.placeholder = mx || "1";
    if (!player.hasLoop()) { els.loopFrom.value = ""; els.loopTo.value = ""; }
    refreshClearBtn();
  }
  // read inputs -> engine. Blank fields mean the placeholder defaults; a full-piece range is the
  // same as no loop, so that clears instead of arming a selection over the whole staff.
  function applyLoopFromInputs() {
    var mx = maxBar(); if (!mx) return;
    var v = loopVals(mx), from = v.from, to = v.to;
    if (from > to) { var t = from; from = to; to = t; }
    if (from === 1 && to === mx) { player.clearLoop(); return; }    // whole piece = default behavior
    player.setLoopMeasures(measureOfBar(from), measureOfBar(to));   // fires onLoopRange -> syncLoopPanel
  }
  function nudgeLoop(which, delta) {
    var mx = maxBar(); if (inPlaylist || !mx) return;
    var v = loopVals(mx), from = v.from, to = v.to;
    if (which === "from") { from = clampInt(from + delta, 1, mx); if (from > to) to = from; }   // push To along
    else { to = clampInt(to + delta, 1, mx); if (to < from) from = to; }                        // pull From along
    if (from === 1 && to === mx) { player.clearLoop(); return; }    // stepped back out to the whole piece
    player.setLoopMeasures(measureOfBar(from), measureOfBar(to));   // stepping arms the loop (and live-updates an active one)
  }
  els.loopClearBtn.addEventListener("click", function () { player.clearLoop(); });   // -> onLoopRange(null)
  els.loopFromDown.addEventListener("click", function () { nudgeLoop("from", -1); });
  els.loopFromUp.addEventListener("click", function () { nudgeLoop("from", 1); });
  els.loopToDown.addEventListener("click", function () { nudgeLoop("to", -1); });
  els.loopToUp.addEventListener("click", function () { nudgeLoop("to", 1); });
  function onLoopInputChange() { if (!inPlaylist && loopBarCount()) applyLoopFromInputs(); }
  els.loopFrom.addEventListener("change", onLoopInputChange);
  els.loopTo.addEventListener("change", onLoopInputChange);

  /* ---------- Loop > Count-off ----------
     Student request (2026-07-26): hear a count-off before the looped section starts, and again before
     every repeat. The engine owns the behavior (player.setLoopCountOff) and plays a clean stick-click cue
     — never counted toward "notes played", never disturbing the beat clock or the loop bounds.
     WHAT THIS SWITCH MEANS CHANGED (Anthony, 2026-08-07). The count-off at the TOP of a piece is now
     unconditional — the engine plays it whether this is on or off, because you cannot start a snare piece
     with no count (see _countOffArmed). So this switch is no longer "count-off, yes or no"; it is "count
     me in on every REPEAT as well", and its default flipped ON -> OFF to match: repeating a two-bar loop
     twenty times with a four-beat cue wedged into every pass is the exception, not the resting state.
     The KEY changed with the meaning (v2). The old key holds answers to a different question — an
     existing student's "on" meant "I want a count-off at all", which everybody now gets — so reading it
     would silently opt them into the mid-loop cue they never asked for.
     Remembered per browser (the tools don't persist From/To bars, but a switch that silently resets every
     session is just annoying). Stored as the literal state now that the default is OFF. */
  var CO_KEY = "rdm_pa_loop_countoff_v2";
  var CO_BEATS_KEY = "rdm_pa_loop_countoff_beats";
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
    /* Count-off LENGTH: 4 beats (default, unchecked) or 2. Remembered the same way as the switch above.
       Stored as the literal beat count rather than a boolean so the value is readable and a future
       third option wouldn't need a migration. */
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
    // Mobile: mobile.js hides this panel's desktop .tool-row and rebuilds the tab as an icon row plus a
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
      var homeRow = panel.querySelector(".tool-row");
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

  /* ---------- music size (zoom) ---------- */
  function refreshSize() {
    var z = player.getZoom ? player.getZoom() : 1;
    els.sizeVal.textContent = Math.round(z * 100) + "%";
    var on = !!currentExercise;
    // The zoom-in ceiling is per-exercise: a bar too wide to draw bigger on this screen caps below 250%,
    // and getMaxZoom() reports where, so the + button greys out at the real fit instead of doing nothing
    // (Anthony, 2026-08-08). getZoom already reads back the capped value, so the % shown is the true size.
    var maxZ = player.getMaxZoom ? player.getMaxZoom() : 2.5;
    els.sizeDown.disabled = !on || z <= 0.5;
    els.sizeUp.disabled = !on || z >= maxZ - 1e-9;
  }
  function nudgeSize(delta) {
    if (!currentExercise || !player.setZoom) return;
    player.setZoom((player.getZoom ? player.getZoom() : 1) + delta);
    refreshSize();
    fitScrollbar();
  }
  // A few px of overflow (rounding / bottom whitespace) shouldn't trip a full scrollbar for an
  // exercise that visually fits and doesn't need scrolling. If the music overflows the card by no
  // more than this, clip the sliver (overflow:hidden) instead of showing a bar. Real multi-line
  // overflow (dozens of px) is far above the tolerance, so it still scrolls normally.
  var SCROLL_TOL = 8;
  function fitScrollbar() {
    var sw = els.score && els.score.closest && els.score.closest(".scorewrap");
    if (!sw) return;
    requestAnimationFrame(function () {          // let flex layout settle before measuring
      sw.classList.remove("no-scroll");          // measure true overflow with overflow:auto
      var over = sw.scrollHeight - sw.clientHeight;
      if (over > 0 && over <= SCROLL_TOL) sw.classList.add("no-scroll");
      updateOverflowFades();                     // refresh the edge fades for the new layout/size
    });
  }
  // Jump the music back to the top — called whenever the shown exercise changes (new exercise, randomize,
  // playlist change, or a new rep of the same exercise) so a scrolled-down page always resets to the start.
  function resetScoreScroll() {
    var sw = els.score && els.score.closest && els.score.closest(".scorewrap");
    if (sw) sw.scrollTop = 0;
  }
  // Soft "there's more music" fade: dissolve the notation into the white paper at whichever edge has
  // hidden content — top once scrolled down, bottom while more is below. The CSS mask reads these two
  // length vars (see .scorewrap in index.html); 0px = no fade. Real overflow only (matches SCROLL_TOL).
  var FADE = "26px", FADE_EDGE = 2;
  function updateOverflowFades() {
    var sw = els.score && els.score.closest && els.score.closest(".scorewrap");
    if (!sw) return;
    var over = sw.scrollHeight - sw.clientHeight;
    if (over <= SCROLL_TOL) { sw.style.setProperty("--fade-top", "0px"); sw.style.setProperty("--fade-bottom", "0px"); return; }
    sw.style.setProperty("--fade-top",    sw.scrollTop > FADE_EDGE ? FADE : "0px");
    sw.style.setProperty("--fade-bottom", (over - sw.scrollTop) > FADE_EDGE ? FADE : "0px");
  }
  // live update while the user (or playback auto-scroll) moves the score
  (function () {
    var sw = els.score && els.score.closest && els.score.closest(".scorewrap");
    if (sw) sw.addEventListener("scroll", updateOverflowFades, { passive: true });
  })();
  els.sizeDown.addEventListener("click", function () { nudgeSize(-0.1); });
  els.sizeUp.addEventListener("click", function () { nudgeSize(0.1); });
  els.sizeVal.addEventListener("click", function () { if (currentExercise && player.setZoom) { player.setZoom(1); refreshSize(); } });

  /* ---------- auto-scroll follow (lock) vs free scroll ---------- */
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
  // ON = keeps the cursor's line on screen, snapping the view to it only when it would otherwise scroll
  // out of view — free to wheel/drag-scroll around in between. OFF = fully free scroll, no snapping at all.

  /* click OR hold-and-drag the progress bar to scrub. Silent while held (Anthony, 2026-07-31: "I
     shouldn't hear the scrubbing sound of the notes... only when you release should you actually hear
     audio") — player.seek() while playing calls _startPlay(), which restarts the scheduler and commits
     real notes to the audio graph, so calling it on every pointermove played a note preview at every
     mouse position during a drag. A drag now only moves the bar's fill visually; the real, audio-
     affecting seek() fires once, on release. A plain click (no movement between down and up) still
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

  /* ---------- tempo slider + typeable BPM ---------- */
  els.tempoSlider.addEventListener("input", function () {
    userAdjusting = true;
    player.setTempo(+els.tempoSlider.value);
    paintSlider();
  });
  ["change", "pointerup", "mouseup", "touchend", "blur"].forEach(function (evt) {
    els.tempoSlider.addEventListener(evt, function () { userAdjusting = false; });
  });
  // the BPM readout is a click-to-type field; don't clobber it while it's being edited. It's shown in
  // the piece's own pulse unit (matches the "♩"/"♩." glyph next to it and the sheet's tempo mark), NOT
  // raw quarter-notes/min — this.tempo stays true quarter-notes/min internally for scheduling.
  function setTempoReadout(bpm) { if (els.tempoInput && root.activeElement !== els.tempoInput) els.tempoInput.value = Math.round(bpm / player.beatUnitMult()); }
  function applyTempoInput() {
    var v = parseInt(els.tempoInput.value, 10);
    if (!isNaN(v)) player.setTempo(Math.round(v * player.beatUnitMult()));   // setTempo clamps to the exercise's min/max
    els.tempoInput.value = Math.round(player.tempo / player.beatUnitMult());  // reflect the actual (clamped) value
  }
  els.tempoInput.addEventListener("focus", function () { setTimeout(function () { els.tempoInput.select(); }, 0); });
  els.tempoInput.addEventListener("change", applyTempoInput);
  els.tempoInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); applyTempoInput(); els.tempoInput.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); els.tempoInput.value = Math.round(player.tempo / player.beatUnitMult()); els.tempoInput.blur(); }
  });
  // ---- Tap tempo: tap the button in time; average the recent tap intervals into a BPM ----
  var tapTimes = [];
  function tapTempo() {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    // a gap longer than 2s means you've stopped and started a new count-off — reset the buffer
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 6) tapTimes.shift();   // rolling average over the last handful of taps
    if (tapTimes.length >= 2) {
      var avgMs = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
      // taps land on the piece's felt pulse (e.g. the dotted quarter in compound meter) — convert that
      // pulse rate to true quarter-notes/min before handing it to setTempo, same as the typed BPM field.
      player.setTempo(Math.round((60000 / avgMs) * player.beatUnitMult()));   // setTempo clamps + syncs slider/readout via onTempoChange
    }
    // restart the flash each tap for a rhythmic pulse
    els.tapTempoBtn.classList.remove("tap-pulse");
    void els.tapTempoBtn.offsetWidth;
    els.tapTempoBtn.classList.add("tap-pulse");
  }
  els.tapTempoBtn.addEventListener("click", tapTempo);

  /* ---------- randomize / bump config ---------- */
  function randCfg() {
    return {
      reps: Math.max(1, parseInt(els.randReps.value, 10) || 1),
      min: els.randMin.value === "" ? null : parseInt(els.randMin.value, 10),
      max: els.randMax.value === "" ? null : parseInt(els.randMax.value, 10)
    };
  }
  function bumpCfg() {
    var step = parseInt(els.bumpStep.value, 10);
    return {
      reps: Math.max(1, parseInt(els.bumpReps.value, 10) || 1),
      step: isNaN(step) ? 5 : step        // blank field = the placeholder default (±5 BPM)
    };
  }
  player.configureRandomize(randCfg());
  player.configureBump(bumpCfg());

  [els.randReps, els.randMin, els.randMax].forEach(function (el) {
    el.addEventListener("input", function () { player.configureRandomize(randCfg()); });
  });
  [els.bumpReps, els.bumpStep].forEach(function (el) {
    el.addEventListener("input", function () { player.configureBump(bumpCfg()); });
  });
  // positive bump step always shows a leading "+" (e.g. +5); negative keeps its "-"; blank/zero clears
  els.bumpStep.addEventListener("blur", function () {
    var v = parseInt(String(els.bumpStep.value).replace(/[^0-9-]/g, ""), 10);
    els.bumpStep.value = isNaN(v) ? "" : (v > 0 ? "+" : "") + v;
  });

  els.randAuto.addEventListener("change", function () {
    if (els.randAuto.checked) {
      els.bumpAuto.checked = false;               // mutually exclusive
      player.setAuto("randomize", randCfg());
    } else {
      player.setAuto(null);
    }
    updateTabIndicators();
  });
  els.bumpAuto.addEventListener("change", function () {
    if (els.bumpAuto.checked) {
      els.randAuto.checked = false;
      player.setAuto("bump", bumpCfg());
    } else {
      player.setAuto(null);
    }
    updateTabIndicators();
  });
  els.randomizeBtn.addEventListener("click", function () { player.configureRandomize(randCfg()); player.randomizeNow(); });
  els.bumpBtn.addEventListener("click", function () { player.configureBump(bumpCfg()); player.bumpNow(); });

  /* ---------- tab bar (single-column tool panels) ---------- */
  // One panel open at a time; clicking the open tab again collapses it. Exercise is open by default.
  var tabButtons = Array.prototype.slice.call(root.querySelectorAll(".tabbar .tab"));
  var tabPanelsWrap = root.getElementById("tabpanels");
  function setTab(name) {
    var anyOpen = false;
    tabButtons.forEach(function (t) {
      var on = !!name && t.getAttribute("data-tab") === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      if (on) anyOpen = true;
    });
    root.querySelectorAll(".tabpanel").forEach(function (p) {
      p.classList.toggle("open", !!name && p.getAttribute("data-panel") === name);
    });
    if (tabPanelsWrap) tabPanelsWrap.classList.toggle("collapsed", !anyOpen);
  }
  /* FREEMIUM: Randomize / Bump / Loop / Playlist are paid. Gating at the TAB is what makes this airtight
     with one check — each of those panels is the only way to reach its feature, so there is no separate
     button, keyboard path or auto-mode left open behind them. The tabs stay VISIBLE on purpose: a lock
     the user can see is what sells the upgrade, whereas a hidden feature just looks like a tool that
     cannot do very much. (Anthony, 2026-07-31) */
  var LOCKED_TABS = { randomize: 1, bump: 1, loop: 1, playlist: 1 };
  function tabLocked(name) { return !PAID && !!LOCKED_TABS[name]; }
  // The value stack for THIS tool, shown under whichever specific reason (`message`) triggered the
  // prompt — it's the same purchase no matter which lock they hit, so show the whole thing every time.
  var UPSELL_BULLETS = [
    "470 more exercises, every one with the sheet music and the sound",
    "Tempo randomizer and Bump Tempo find your real top speed",
    "Loop any section, build playlists, and upload your own sheet music"
  ];
  var UPSELL_PRICE = "$1 for your first week, then $9.99 a month.";
  function upsell(title, message) {
    var D = window.RDMDialogs;
    if (D && D.confirm) {
      // theme-teal = this tool's own color (blue-deep, matches tools.js), not the orange used for the
      // exercise/delete confirms elsewhere in this file — the upsell should read as "Playalongs", not
      // borrow Sight-Reading's color. (Anthony, 2026-07-31)
      D.confirm(root, {
        title: title, message: message, confirmLabel: "See what's included", theme: "theme-teal",
        bullets: UPSELL_BULLETS, price: UPSELL_PRICE
      }).then(function (ok) { if (ok && ctx.onUpgrade) ctx.onUpgrade(); });
    } else if (ctx.onUpgrade) ctx.onUpgrade();
  }
  tabButtons.forEach(function (t) {
    var name = t.getAttribute("data-tab");
    if (tabLocked(name)) {
      t.classList.add("tab--locked");
      t.setAttribute("aria-label", (t.textContent || name).trim() + " (upgrade to unlock)");
    }
    t.addEventListener("click", function () {
      if (tabLocked(name)) {
        upsell("Unlock " + (t.querySelector(".tab__lbl") ? t.querySelector(".tab__lbl").textContent : name),
               "Randomize, Bump, Loop and Playlists come with the full version, along with every exercise in the library.");
        return;
      }
      setTab(t.classList.contains("active") ? null : name);
    });
  });
  // No tab is open on first load / refresh / startup (panels collapsed) — the music gets the full height
  // until the user taps a tab open.
  setTab(null);
  // light a tab's "running" dot when its tool is active, so a closed panel still shows what's on
  function updateTabIndicators() {
    tabButtons.forEach(function (t) {
      var name = t.getAttribute("data-tab"), on = false;
      if (name === "loop") on = !!(player.hasLoop && player.hasLoop());
      else if (name === "randomize") on = !!(els.randAuto && els.randAuto.checked);
      else if (name === "bump") on = !!(els.bumpAuto && els.bumpAuto.checked);
      else if (name === "playlist") on = inPlaylist;   // same "running" dot as Randomize/Bump
      t.classList.toggle("on", on);
    });
  }
  updateTabIndicators();

  /* ---------- categories ---------- */
  els.categoryBtn.addEventListener("click", function () {
    if (inPlaylist) return;
    showPicker({
      title: "Choose a category",
      color: "orange",
      // hide "Favorites" when nothing is favorited, and "My Uploads" when there are no uploads
      items: CATEGORIES.filter(function (c) {
                         if (c === "__favorites__") return favorites.size > 0;
                         if (c === "__uploads__") return EXERCISES.some(function (e) { return e.isUpload && e.isOwner; });
                         if (c === "__shared_uploads__") return EXERCISES.some(function (e) { return e.isUpload && !e.isOwner; });
                         return true;
                       })
                       .map(function (c) { return { label: catLabel(c), value: c, cls: (c === "__favorites__" || c === "__uploads__" || c === "__shared_uploads__") ? "cat-special" : null }; }),
      current: currentCategory,
      onPick: function (val) {
        currentCategory = val;
        els.categoryBtn.querySelector(".lbl").textContent = catLabel(val);
        // if current exercise no longer in filter, jump to first
        if (exerciseIndexInFilter() === -1) { var list = filteredExercises(); if (list.length) loadExercise(list[0]); }
        refreshSheetCats();   // move the orange highlight to the newly-selected category on the sheet
        updateTitleNav();   // the filtered count may have changed (affects the exercise chevrons)
      }
    });
  });

  // if the Favorites filter is active but nothing is favorited anymore, fall back to All Categories
  function ensureValidCategory() {
    if ((currentCategory === "__favorites__" && favorites.size === 0) ||
        (currentCategory === "__uploads__" && !EXERCISES.some(function(e){ return e.isUpload && e.isOwner; })) ||
        (currentCategory === "__shared_uploads__" && !EXERCISES.some(function(e){ return e.isUpload && !e.isOwner; }))) {
      currentCategory = "all";
      els.categoryBtn.querySelector(".lbl").textContent = catLabel("all");
    }
  }

  /* ---------- favorite the current exercise ---------- */
  if (els.favBtn) els.favBtn.addEventListener("click", function () {
    if (!currentExercise) return;
    toggleFav(currentExercise);
    updateFavBtn();
    ensureValidCategory();
  });

  /* ---------- exercise search ---------- */
  /* ---------- custom uploads: file picker → validate → save to account → play ---------- */
  function startUpload() {
    if (!ctx.uploads) return;
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".musicxml,.xml,application/xml,text/xml";
    inp.style.display = "none";
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      if (f) addUploadFile(f);
      inp.remove();
    });
    document.body.appendChild(inp);   // file inputs live in the real document, not the shadow tree
    inp.click();
  }
  function addUploadFile(file) {
    var reader = new FileReader();
    reader.onerror = function () { RDMDialogs.alert(root, { title: "Couldn't read file", message: "Couldn't read that file.", theme: "theme-orange" }); };
    reader.onload = function () {
      var xml = String(reader.result || ""), rdm;
      // validate it converts BEFORE storing, so a bad file never becomes a broken exercise
      try { rdm = RDMConvert.convert(xml); }
      catch (e) { RDMDialogs.alert(root, { title: "Not readable", message: "That doesn't look like readable sheet music. Make sure it's a MusicXML (.musicxml) export.", theme: "theme-orange" }); return; }
      var title = file.name.replace(/\.(musicxml|xml)$/i, "").trim() || "Untitled";
      Promise.resolve(ctx.uploads.add(title, xml)).then(function (u) {
        var ex = makeUploadEx(u);
        EXERCISES.push(ex);
        _cacheRdm(ex.file, rdm);                 // already converted → instant play
        currentCategory = "__uploads__";
        if (els.categoryBtn && els.categoryBtn.querySelector(".lbl")) els.categoryBtn.querySelector(".lbl").textContent = catLabel("__uploads__");
        ensureValidCategory && ensureValidCategory();
        loadExercise(ex);
      }).catch(function (e) { if (e && e.message === "cancelled") return; RDMDialogs.alert(root, { title: "Upload failed", message: "Upload failed. " + ((e && e.message) || "Please try again."), theme: "theme-orange" }); });
    };
    reader.readAsText(file);
  }
  // Async confirm; on confirm, deletes the upload and calls onRemoved() so the picker row is removed.
  function removeUpload(id, onRemoved) {
    var ex = exById(id);
    if (!ex || !ex.isUpload) return;
    if (!ex.isOwner) return;                    // not yours to delete — the bin should not have shown
    RDMDialogs.confirm(root, { title: "Delete upload?", message: 'Delete "' + ex.name + '" from your uploads?', theme: "theme-orange" }).then(function (ok) {
      if (!ok) return;
      Promise.resolve(ctx.uploads.remove(ex.uploadId)).catch(function () {});
      var i = EXERCISES.indexOf(ex); if (i >= 0) EXERCISES.splice(i, 1);
      delete _rdmCache[ex.file];
      if (currentExercise && currentExercise.id === ex.id) {
        currentCategory = "all";
        if (els.categoryBtn && els.categoryBtn.querySelector(".lbl")) els.categoryBtn.querySelector(".lbl").textContent = catLabel("all");
        var list = filteredExercises();
        if (list.length) loadExercise(list[0]);
      }
      if (onRemoved) onRemoved();
    });
  }

  // Async rename of one of your own uploads. Prompts for a new title, saves it to the account, and
  // updates the name everywhere it shows (the picker row via onRenamed, and the sheet title if it's live).
  function renameUpload(id, onRenamed) {
    var ex = exById(id);
    if (!ex || !ex.isUpload || !ctx.uploads || !ctx.uploads.rename) return;
    if (ctx.uploads.requestEdit) {
      Promise.resolve(ctx.uploads.requestEdit(ex.uploadId, ex.name, ex.isShared)).then(function (res) {
        if (!res) return;
        ex.name = res.title;
        ex.isShared = res.isShared;
        ex.category = ex.isOwner ? ["__uploads__"] : ["__shared_uploads__"];
        if (currentExercise && currentExercise.id === ex.id) refreshSheetCats();   // live title updates in place
        if (onRenamed) onRenamed(ex.name);
      }).catch(function(){});
      return;
    }
    RDMDialogs.name(root, { title: "Rename upload", value: ex.name, placeholder: "Upload name", theme: "theme-orange" }).then(function (val) {
      if (val == null) return;                     // cancelled
      var newName = String(val).trim();
      if (!newName || newName === ex.name) return; // empty or unchanged → no-op
      ex.name = newName;
      Promise.resolve(ctx.uploads.rename(ex.uploadId, newName)).catch(function () {});
      if (currentExercise && currentExercise.id === ex.id) refreshSheetCats();   // live title updates in place
      if (onRenamed) onRenamed(newName);
    });
  }

  function openExercisePicker() {
    if (inPlaylist) return;
    var inUploads = ((currentCategory === "__uploads__" || currentCategory === "__shared_uploads__") && !!ctx.uploads);
    var items = filteredExercises().map(function (ex) { return { label: ex.name + (currentCategory === "__shared_uploads__" && ex.uploaderName ? " (by " + ex.uploaderName + ")" : ""), value: ex.id }; });
    if (inUploads) items.sort(function (a, b) { return a.label.localeCompare(b.label, undefined, { numeric: true }); });   // your uploads: alphabetical/numerical
    showPicker({
      title: inUploads ? "Your uploads" : "Choose an exercise",
      color: "orange",
      items: items,                                  // no category labels in the exercise list
      current: currentExercise ? currentExercise.id : null,
      onPick: function (id) { loadExercise(exById(id)); },
      // per-row ★ toggle (only the exercise picker passes these)
      isFav: function (id) { return isFav(exById(id)); },
      onFav: function (id) { var e = exById(id); if (e) { toggleFav(e); if (currentExercise && e.id === currentExercise.id) updateFavBtn(); ensureValidCategory(); } return isFav(e); },
      // per-row 🗑 on ANY upload row, in ANY category (incl. All) — they're the user's own, safe to delete
      // anywhere they appear. The per-row predicate gates it to isUpload rows, so catalog rows never show it.
      /* The bin only appears on YOUR OWN uploads (Anthony, 2026-08-07: "users shouldn't be able to
         delete other people's uploads"). It used to show on every upload including other members'
         shared ones: the row vanished from the picker, the database refused the delete, and it was
         back on the next reload. */
      canDelete: ctx.uploads ? function (id) { var e = exById(id); return !!(e && e.isUpload && e.isOwner); } : null,
      onDelete: ctx.uploads ? function (id, onRemoved) { removeUpload(id, onRemoved); } : null,
      // per-row ✎ rename, also on any upload row in any category (same gating as delete)
      canEdit: (ctx.uploads && ctx.uploads.rename) ? function (id) { var e = exById(id); return !!(e && e.isUpload); } : null,
      onEdit: (ctx.uploads && ctx.uploads.rename) ? function (id, onRenamed) { renameUpload(id, onRenamed); } : null
    });
  }
  els.exerciseBtn.addEventListener("click", openExercisePicker);
  // + beside the Exercise button → upload your own MusicXML (lands in the "My Uploads" category).
  var addExBtn = root.getElementById("addExerciseBtn");
  if (addExBtn && ctx.uploads) {
    addExBtn.hidden = false;
    if (PAID) addExBtn.addEventListener("click", startUpload);
    else {
      // FREEMIUM: uploading your own sheet music is paid. The + becomes the padlock so the button still
      // reads as a real feature you don't have yet, rather than a plus that silently does nothing.
      addExBtn.classList.add("pk-add--locked");
      addExBtn.innerHTML = '<svg class="ico ico-stroke" viewBox="0 0 24 24" aria-hidden="true">' + LOCK_CLOSED + "</svg>";
      addExBtn.title = "Adding your own sheet music comes with the full version";
      addExBtn.setAttribute("aria-label", "Add your own exercise (upgrade to unlock)");
      addExBtn.addEventListener("click", function () {
        upsell("Unlock your own sheet music",
               "Uploading your own MusicXML comes with the full version, along with every exercise in the library.");
      });
    }
  }

  /* ---------- playlists ---------- */
  function segCount(pl) { return (pl.items ? pl.items.length : 0) + (pl.items && pl.items.length === 1 ? " segment" : " segments"); }
  els.playlistBtn.addEventListener("click", function () {
    var items = [];
    // your own playlists first, sorted alphabetically (findable as the list grows); then the curated ones
    userPlaylists.slice().sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); })
      .forEach(function (pl) { items.push({ label: pl.name, value: "u:" + pl.id, sub: segCount(pl) }); });
    PLAYLISTS.forEach(function (pl, i) { items.push({ label: pl.name, value: "c:" + i, sub: segCount(pl) }); });
    var cur = null;
    if (inPlaylist && playlist) cur = playlist._user ? "u:" + playlist.id : "c:" + PLAYLISTS.indexOf(playlist);
    showPicker({
      title: "Choose a playlist",
      color: "purple",
      items: items,
      current: cur,
      onPick: function (val) {
        if (typeof val === "string" && val.indexOf("u:") === 0) { startPlaylist(userPlaylistById(val.slice(2))); return; }
        if (typeof val === "string" && val.indexOf("c:") === 0) { startPlaylist(PLAYLISTS[+val.slice(2)]); return; }
      },
      // ✎ opens your own playlist in the editor (curated ones aren't editable)
      canEdit: ctx.playlists ? function (val) { return typeof val === "string" && val.indexOf("u:") === 0; } : null,
      onEdit: ctx.playlists ? function (val) { closePicker(); openPlaylistEditor(userPlaylistById(val.slice(2))); } : null
    });
  });
  // + beside the Playlist button → create a new playlist (moved out of the picker popup).
  var addPlBtn = root.getElementById("addPlaylistBtn");
  if (addPlBtn && ctx.playlists) { addPlBtn.hidden = false; addPlBtn.addEventListener("click", createPlaylistFlow); }

  function createPlaylistFlow() {
    RDMDialogs.name(root, { title: "Name your playlist", value: "My Playlist", theme: "theme-purple" }).then(function (name) {
      name = (name || "").trim();
      if (!name) return;
      Promise.resolve(ctx.playlists.create(name)).then(function (pl) {
        var np = { id: pl.id, name: pl.name, items: [], _user: true };
        userPlaylists.push(np);
        closePicker();
        openPlaylistEditor(np);
      }).catch(function (e) { RDMDialogs.alert(root, { title: "Couldn't create playlist", message: "Couldn't create the playlist. " + ((e && e.message) || ""), theme: "theme-purple" }); });
    });
  }

  /* ---------- playlist editor ---------- */
  var _plEditor = null;
  var editingPl = null;
  var _plSaveTimer = null;

  function genTempos(from, to, step) {
    from = Math.max(20, Math.min(400, from | 0)); to = Math.max(20, Math.min(400, to | 0)); step = Math.max(1, step | 0);
    var t = [], v;
    if (to >= from) { for (v = from; v <= to; v += step) t.push(v); }
    else { for (v = from; v >= to; v -= step) t.push(v); }
    if (!t.length) t.push(from);
    return t;
  }
  function defaultItem(ex) {
    return { file: ex.file, name: ex.name, _from: 100, _to: 160, _step: 20, repetitionsPerTempo: 4, tempos: genTempos(100, 160, 20) };
  }
  function schedulePlaylistSave() { if (!editingPl || !ctx.playlists) return; clearTimeout(_plSaveTimer); _plSaveTimer = setTimeout(flushPlaylistSave, 500); }
  function flushPlaylistSave() { clearTimeout(_plSaveTimer); _plSaveTimer = null; if (editingPl && ctx.playlists) ctx.playlists.save(editingPl.id, { name: editingPl.name, items: editingPl.items }); }

  function buildPlEditor() {
    // Uses the shared .modal chrome (theme-purple) as three stacked panels — title / exercises / buttons —
    // so it matches the SR Lab pop-ups and the pickers by construction.
    var wrap = document.createElement("div");
    wrap.className = "modal modal--pleditor theme-purple"; wrap.hidden = true;
    wrap.innerHTML =
      '<div class="modal__stack" role="dialog" aria-label="Edit playlist">' +
        '<div class="modal__panel modal__head">' +
          '<input class="pl-editor__name modal__search" type="text" aria-label="Playlist name" placeholder="Playlist name" />' +
          '<button class="modal__close pl-editor__close" type="button" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="modal__panel pl-editor__body">' +
          '<ul class="pl-editor__items"></ul>' +
          '<p class="pl-editor__empty">No exercises yet — add some below.</p>' +
        '</div>' +
        '<div class="modal__panel pl-editor__foot">' +
          /* No icons on either of these (Anthony, 2026-08-02). The "＋" is a full-width character and
             was pushing "Add exercise" past the button; "▶ Play" read as "play it now" when the button
             actually STARTS the playlist you have just built, so it is labelled Create. */
          '<button class="pl-editor__add" type="button">Add exercise</button>' +
          '<button class="pl-editor__play" type="button">Create</button>' +
          '<button class="pl-editor__del" type="button">Delete</button>' +
        '</div>' +
      '</div>';
    (root.body || root).appendChild(wrap);
    var q = function (s) { return wrap.querySelector(s); };
    var ed = { el: wrap, name: q(".pl-editor__name"), list: q(".pl-editor__items"), empty: q(".pl-editor__empty") };
    q(".pl-editor__close").addEventListener("click", closePlEditor);
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) closePlEditor(); });   // click the backdrop to close
    ed.name.addEventListener("input", function () { if (editingPl) { editingPl.name = ed.name.value; schedulePlaylistSave(); } });
    q(".pl-editor__add").addEventListener("click", addExerciseToPlaylist);
    q(".pl-editor__play").addEventListener("click", function () {
      if (!editingPl || !editingPl.items.length) { RDMDialogs.alert(root, { title: "Empty playlist", message: "Add at least one exercise first.", theme: "theme-purple" }); return; }
      var pl = editingPl;                                  // capture before closePlEditor() nulls editingPl
      flushPlaylistSave(); closePlEditor(); startPlaylist(pl);
    });
    q(".pl-editor__del").addEventListener("click", function () {
      if (!editingPl) return;
      var pl = editingPl;                                  // capture before the async confirm resolves
      RDMDialogs.confirm(root, { title: "Delete playlist?", message: 'Delete the playlist "' + pl.name + '"?', theme: "theme-purple" }).then(function (ok) {
        if (!ok) return;
        ctx.playlists.remove(pl.id);
        var i = userPlaylists.indexOf(pl); if (i >= 0) userPlaylists.splice(i, 1);
        if (editingPl === pl) { editingPl = null; clearTimeout(_plSaveTimer); _plSaveTimer = null; _plEditor.el.hidden = true; _plEditor.el.classList.remove("is-open"); }
      });
    });
    _plEditor = ed;
    return ed;
  }
  function openPlaylistEditor(pl) {
    if (!pl) return;
    var ed = _plEditor || buildPlEditor();
    editingPl = pl;
    ed.name.value = pl.name || "";
    renderPlItems();
    ed.el.hidden = false;
    ed.el.classList.add("is-open");
  }
  function closePlEditor() { flushPlaylistSave(); if (_plEditor) { _plEditor.el.hidden = true; _plEditor.el.classList.remove("is-open"); } editingPl = null; }

  function mkMini(txt, title, onclick) {
    var b = document.createElement("button"); b.type = "button"; b.className = "pl-mini"; b.title = title; b.textContent = txt;
    b.addEventListener("click", onclick); return b;
  }
  function moveItem(idx, dir) {
    var j = idx + dir; if (!editingPl || j < 0 || j >= editingPl.items.length) return;
    var tmp = editingPl.items[idx]; editingPl.items[idx] = editingPl.items[j]; editingPl.items[j] = tmp;
    renderPlItems(); schedulePlaylistSave();
  }
  function renderPlItems() {
    var ed = _plEditor; if (!ed || !editingPl) return;
    ed.list.innerHTML = "";
    ed.empty.style.display = editingPl.items.length ? "none" : "";
    editingPl.items.forEach(function (item, idx) {
      if (item._from == null) {
        item._from = (item.tempos && item.tempos[0]) || 100;
        item._to = (item.tempos && item.tempos[item.tempos.length - 1]) || 160;
        item._step = 20;
      }
      var li = document.createElement("li"); li.className = "pl-item";
      var top = document.createElement("div"); top.className = "pl-item__top";
      var nm = document.createElement("span"); nm.className = "pl-item__name"; nm.textContent = item.name;
      var ord = document.createElement("span"); ord.className = "pl-item__ord";
      var up = mkMini("↑", "Move up", function () { moveItem(idx, -1); });
      var dn = mkMini("↓", "Move down", function () { moveItem(idx, 1); });
      var rm = mkMini("✕", "Remove", function () { editingPl.items.splice(idx, 1); renderPlItems(); schedulePlaylistSave(); });
      up.disabled = idx === 0; dn.disabled = idx === editingPl.items.length - 1;
      ord.appendChild(up); ord.appendChild(dn); ord.appendChild(rm);
      top.appendChild(nm); top.appendChild(ord);
      var tr = document.createElement("div"); tr.className = "pl-item__tempos";
      var prev = document.createElement("div"); prev.className = "pl-item__preview";
      function refreshPreview() {
        prev.innerHTML = "";
        [item._from + " → " + item._to + " bpm", "step " + item._step, (item.repetitionsPerTempo || 1) + "× each"].forEach(function (t) {
          var s = document.createElement("span"); s.className = "pl-prev-pill"; s.textContent = t; prev.appendChild(s);
        });
      }
      function numField(lbl, val, min, max, onchg) {
        var w = document.createElement("label"); w.className = "pl-num";
        var s = document.createElement("span"); s.textContent = lbl;
        var inp = document.createElement("input");
        inp.type = "text"; inp.inputMode = "numeric"; inp.maxLength = 4; inp.value = val;   // plain text — no number spinners
        inp.addEventListener("change", function () {
          var n = parseInt(inp.value, 10); if (isNaN(n)) n = min; n = Math.max(min, Math.min(max, n)); inp.value = n;
          onchg(n); item.tempos = genTempos(item._from, item._to, item._step); refreshPreview(); schedulePlaylistSave();
        });
        w.appendChild(s); w.appendChild(inp); return w;
      }
      tr.appendChild(numField("From", item._from, 20, 400, function (v) { item._from = v; }));
      tr.appendChild(numField("To", item._to, 20, 400, function (v) { item._to = v; }));
      tr.appendChild(numField("Step", item._step, 1, 100, function (v) { item._step = v; }));
      tr.appendChild(numField("Reps", item.repetitionsPerTempo || 1, 1, 20, function (v) { item.repetitionsPerTempo = v; }));
      li.appendChild(top); li.appendChild(tr); li.appendChild(prev);
      ed.list.appendChild(li);
      refreshPreview();
    });
  }
  function addExerciseToPlaylist() {
    var items = EXERCISES.filter(function (e) { return !!e.file; }).map(function (ex) {
      return { label: ex.name + (ex.isUpload ? "  (upload)" : ""), value: ex.id };
    });
    showPicker({
      title: "Add an exercise",
      color: "orange",
      items: items,
      onPick: function (id) {
        var ex = exById(id); if (!ex || !editingPl) return;
        editingPl.items.push(defaultItem(ex));
        renderPlItems(); schedulePlaylistSave();
      }
    });
  }

  function buildQueue(pl) {
    var q = [];
    pl.items.forEach(function (item) {
      // resolve by stable filename first (new format), then legacy numeric id
      var ex = item.file ? exByFile(item.file) : exById(item.exerciseId);
      if (!ex) {
        // exercise no longer in the catalog: skip it so the queue can't freeze on a dead slot
        console.warn("[Playalongs] playlist '" + pl.name + "' — skipping missing exercise:", item.file || item.exerciseId);
        return;
      }
      var reps = Math.max(1, item.repetitionsPerTempo || 1);
      (item.tempos || []).forEach(function (tempo) {
        for (var r = 0; r < reps; r++) q.push({ exerciseId: ex.id, tempo: tempo, name: ex.name });
      });
    });
    return q;
  }

  function startPlaylist(pl) {
    if (!pl) return;
    playlist = pl;
    queue = buildQueue(pl);
    if (!queue.length) return;
    inPlaylist = true;
    queueIndex = 0;
    _plWithinSec = 0;
    // resolve every unique exercise's beats in the background so the total time fills in quickly
    queue.forEach(function (e) { beatsForEx(exById(e.exerciseId)); });

    els.playlistBtn.querySelector(".lbl").textContent = pl.name;
    setPlaylistMode(true);
    player.setMode("sequence", advanceQueue);
    playQueueEntry(0, true);
  }

  function playQueueEntry(i, autoplay) {
    queueIndex = i;
    _plWithinSec = 0;   // reset within-entry elapsed before the new entry's first onTime tick
    var entry = queue[i];
    var ex = exById(entry.exerciseId);
    updatePlaylistProgress();
    els.queueBtn.querySelector(".lbl").textContent = entry.name + " · " + entry.tempo + " BPM";

    if (loadedId === entry.exerciseId) {
      // same exercise: just retempo + restart from the top (no reload → seamless)
      player.setTempo(entry.tempo);
      player.seek(0);
      resetScoreScroll();   // new rep of the same exercise → back to the top
      refreshSheetCats();    // ensure the playlist name shows even when the exercise didn't reload
      if (autoplay) player.play();
    } else {
      loadExercise(ex, { autoplay: autoplay, tempo: entry.tempo });
    }
    updateTitleNav();   // queueIndex moved → refresh rep/exercise chevron bounds
  }

  function advanceQueue() {
    if (!inPlaylist) return;
    var next = queueIndex + 1;
    if (next >= queue.length) { stopPlaylist(); return; }
    playQueueEntry(next, true);
  }

  function stopPlaylist() {
    if (inPlaylist) { player.pause(); }
    inPlaylist = false;
    playlist = null;
    queue = [];
    queueIndex = 0;
    player.setMode("loop");
    els.playlistBtn.querySelector(".lbl").textContent = "Select Playlist";
    els.queueBtn.querySelector(".lbl").textContent = "Playlist queue";
    setPlaylistMode(false);
    refreshSheetCats();   // drop the playlist name from the card
  }

  // click the playlist bar to toggle its label between elapsed/total time and percentage (no seek here)
  els.playlistProgress.addEventListener("click", function () {
    if (!inPlaylist) return;
    playlistTimeMode = (playlistTimeMode === "time") ? "percent" : "time";
    updatePlaylistProgress();
  });

  els.stopPlaylistBtn.addEventListener("click", stopPlaylist);
  els.queueBtn.addEventListener("click", function () {
    if (!inPlaylist) return;
    showPicker({
      title: playlist.name + " — queue",
      color: "purple",
      items: queue.map(function (e, i) { return { label: (i + 1) + ". " + e.name, value: i, sub: e.tempo + " BPM" }; }),
      current: queueIndex,
      onPick: function (i) { playQueueEntry(i, true); }
    });
  });

  // Beats (quarter-beats, repeat-expanded) for one exercise. Returns a number once known, or null while
  // still resolving (a background fetch is kicked off the first time). Sums the SAME sequence the engine
  // uses for its per-exercise total, so the playlist total matches the main bar exactly. A baked-in
  // ex.beats (if ever added to data-rdm.js) is used directly and skips the fetch.
  function beatsForEx(ex) {
    if (!ex) return null;
    if (typeof ex.beats === "number") return ex.beats;
    var c = _beatsCache[ex.id];
    if (typeof c === "number") return c;
    if (c === undefined) {
      _beatsCache[ex.id] = _xmlText(ex.file)
        .then(function (xml) {
          var b = RDMConvert.rdmSequence(RDMConvert.convert(xml)).reduce(function (a, s) { return a + (s.beats || 0); }, 0);
          _beatsCache[ex.id] = b;
          if (inPlaylist) updatePlaylistProgress();   // total/elapsed just became more complete
          return b;
        })
        .catch(function () { _beatsCache[ex.id] = 0; });
    }
    return null;   // in flight (Promise stored) → caller shows a placeholder
  }

  // Total + elapsed seconds across the whole playlist. `known` is false until every entry's beats resolve.
  function computePlaylistTotals(withinSec) {
    var total = 0, elapsed = 0, known = true;
    for (var i = 0; i < queue.length; i++) {
      var b = beatsForEx(exById(queue[i].exerciseId));
      if (b == null) { known = false; continue; }
      var dur = b * (60 / queue[i].tempo);
      total += dur;
      if (i < queueIndex) elapsed += dur;   // fully-completed prior entries
    }
    elapsed += Math.max(0, withinSec || 0);   // progress inside the current entry
    return { total: total, elapsed: elapsed, known: known };
  }

  function updatePlaylistProgress() {
    if (!queue.length) return;
    var t = computePlaylistTotals(_plWithinSec);
    // fill (and % mode) are time-based when the total is known, so bar, time and percent all agree;
    // fall back to index-based while beats are still resolving.
    var frac = (t.known && t.total > 0) ? (t.elapsed / t.total) : (queueIndex / queue.length);
    frac = Math.max(0, Math.min(1, frac));
    els.playlistFill.style.width = (frac * 100) + "%";

    var elapsedStr = fmtTime(t.elapsed), totalStr = t.known ? fmtTime(t.total) : "…";
    if (playlistTimeMode === "percent") {
      var pctStr = Math.round(frac * 100) + "%";
      els.playlistLabel.textContent = pctStr;
      if (els.playlistLabelOver) els.playlistLabelOver.textContent = pctStr;
    } else {
      var timeStr = elapsedStr + " / " + totalStr;
      els.playlistLabel.textContent = timeStr;
      if (els.playlistLabelOver) els.playlistLabelOver.textContent = timeStr;   // same single text node → identical width, spaces kept
    }
  }

  function setPlaylistMode(on) {
    els.playlistProgressWrap.hidden = !on;
    // playlist controls
    els.stopPlaylistBtn.disabled = !on;
    els.queueBtn.disabled = !on;
    // practice controls locked while a playlist runs
    els.categoryBtn.disabled = on;
    els.exerciseBtn.disabled = on;
    updateRandNowBtn();   // inPlaylist is already updated by the caller before setPlaylistMode runs
    els.undoExerciseBtn.disabled = on || !undoStack.length;
    els.redoExerciseBtn.disabled = on || !redoStack.length;
    els.tempoSlider.disabled = on; els.tempoInput.disabled = on; els.tapTempoBtn.disabled = on;
    els.randAuto.disabled = on; els.bumpAuto.disabled = on;
    els.randomizeBtn.disabled = on; els.bumpBtn.disabled = on;
    if (on) { els.randAuto.checked = false; els.bumpAuto.checked = false; player.setAuto(null); }
    // title chevrons: reveal the teal rep pair only in playlist mode, then refresh all bounds
    els.sheetHead.classList.toggle("in-playlist", on);
    updateTitleNav();
    refreshLoopPanel();   // Loop Section is disabled during a playlist, re-enabled after
    // dim the now-inactive exercise/randomize/bump panels, and light the Playlist tab's "running" dot
    if (tabPanelsWrap) tabPanelsWrap.classList.toggle("pl-locked", on);
    updateTabIndicators();
  }

  /* ---------- picker modal ---------- */
  var pickerState = { items: [], filtered: [], onPick: null, active: 0, color: "orange", isFav: null, onFav: null, canDelete: null, onDelete: null, canEdit: null, onEdit: null };

  function showPicker(cfg) {
    pickerState.items = cfg.items || [];
    pickerState.onPick = cfg.onPick;
    pickerState.isFav = cfg.isFav || null;   // per-row ★ predicate (exercise picker only)
    pickerState.onFav = cfg.onFav || null;   // per-row ★ toggle, returns new state
    pickerState.canDelete = cfg.canDelete || null;   // per-row 🗑 predicate (My Uploads only)
    pickerState.onDelete = cfg.onDelete || null;     // per-row 🗑 handler, returns false to cancel
    pickerState.canEdit = cfg.canEdit || null;       // per-row ✎ predicate (My Playlists only)
    pickerState.onEdit = cfg.onEdit || null;         // per-row ✎ handler
    pickerState.color = cfg.color || "orange";
    els.picker.classList.remove("theme-orange", "theme-purple");
    els.picker.classList.add(pickerState.color === "purple" ? "theme-purple" : "theme-orange");
    els.pickerTitle.textContent = cfg.title || "Select";
    els.pickerSearch.value = "";
    renderPicker("");
    // preselect current
    if (cfg.current != null) {
      for (var i = 0; i < pickerState.filtered.length; i++) {
        if (pickerState.filtered[i].value === cfg.current) { pickerState.active = i; break; }
      }
    }
    highlightActive();
    els.picker.hidden = false;
    els.picker.classList.remove("is-closing");
    void els.picker.offsetWidth;            // restart the open animation
    // Center the list on the current selection SYNCHRONOUSLY, before the modal's first paint, so the
    // selected item is already in view when it appears (no scroll-into-place animation). We use
    // offsetTop / offsetHeight (layout values) instead of getBoundingClientRect, because the open
    // animation transforms the panel — rects are scaled/translated mid-animation, but offsets aren't.
    centerActiveInList();
    els.picker.classList.add("is-open");
    // Auto-focus the search on DESKTOP only. On touch we don't want to auto-pop the mobile keyboard the
    // instant a picker opens (you scroll the list far more often than you search); tap the field to type.
    // Matches the RDM Metronome exactly so both tools handle the keyboard the same way.
    if (!matchMedia("(hover:none)").matches) setTimeout(function () { els.pickerSearch.focus({ preventScroll: true }); }, 30);
  }
  function closePicker() {
    if (els.picker.hidden || els.picker.classList.contains("is-closing")) return;
    pickerState.onPick = null;
    var panel = els.picker.querySelector(".modal__stack");
    // FREEZE the popup at its current (keyboard-shrunk) geometry BEFORE we blur. On a phone the modal
    // is sized to the visible viewport via --vvh/--vvo, so dismissing the keyboard grows the viewport
    // and would resize + re-center the modal mid-fade — the "glitch." Pin the live px values inline so
    // later --vvh changes can't move it; the popup just fades out where it sits. (.is-closing also
    // kills transitions in CSS.) Cleared again once the popup is fully hidden.
    var pcs = getComputedStyle(els.picker);
    els.picker.style.height = pcs.height;
    els.picker.style.top = pcs.top;
    if (panel) panel.style.maxHeight = getComputedStyle(panel).maxHeight;
    // Blur the search field so the keyboard collapses behind the frozen, fading popup.
    if (root.activeElement && els.picker.contains(root.activeElement)) root.activeElement.blur();
    els.picker.classList.remove("is-open");
    els.picker.classList.add("is-closing");      // play the close animation, THEN hide
    var finish = function () {
      if (!els.picker.classList.contains("is-closing")) { cleanup(); return; } // was reopened
      els.picker.hidden = true;
      els.picker.classList.remove("is-closing");
      // unfreeze: restore the --vvh/--vvo-driven sizing for the next open
      els.picker.style.height = els.picker.style.top = "";
      if (panel) panel.style.maxHeight = "";
      cleanup();
    };
    function cleanup() { if (panel) panel.removeEventListener("animationend", finish); }
    if (panel) panel.addEventListener("animationend", finish);
    setTimeout(finish, 280);   // fallback (reduced-motion / no animationend event)
  }

  function renderPicker(q) {
    q = (q || "").toLowerCase();
    pickerState.filtered = pickerState.items.filter(function (it) {
      return !q || it.label.toLowerCase().indexOf(q) !== -1 || (it.sub && it.sub.toLowerCase().indexOf(q) !== -1);
    });
    pickerState.active = 0;
    var ul = els.pickerList;
    ul.innerHTML = "";
    pickerState.filtered.forEach(function (it, i) {
      var li = document.createElement("li");
      if (it.cls) li.classList.add(it.cls);       // e.g. "cat-special" → distinct purple Favorites/My Uploads rows
      li.innerHTML = "<span class='pl-label'>" + escapeHtml(it.label) + "</span>" + (it.sub ? "<span style='opacity:.6;font-size:.78rem;float:right;'>" + escapeHtml(it.sub) + "</span>" : "");
      li.addEventListener("click", function () { pick(i); });
      if (pickerState.onFav && pickerState.isFav) {
        // EVERY row gets a star (filled = favorited, hollow = not). Toggling only swaps the star's icon/state
        // in place — the row keeps .has-fav (flex) either way, so its height never changes when you toggle.
        li.classList.add("has-fav");
        var star = document.createElement("button");
        star.type = "button";
        function paintStar(on) {
          star.className = "pl-fav";
          star.setAttribute("aria-pressed", on ? "true" : "false");
          star.setAttribute("aria-label", on ? "Remove from favorites" : "Add to favorites");
          star.innerHTML = STAR_SVG;               // fill (favorited) vs outline (not) driven by aria-pressed via .fav-ico CSS — WHITE everywhere
        }
        paintStar(pickerState.isFav(it.value));
        star.addEventListener("click", function (e) {
          e.stopPropagation();                       // don't select / close the picker
          paintStar(pickerState.onFav(it.value));    // onFav toggles and returns the NEW favorite state
        });
        li.appendChild(star);
      }
      if (pickerState.canDelete && pickerState.onDelete && pickerState.canDelete(it.value)) {
        // 🗑 on uploaded rows — deletes the file from the account (confirm handled by onDelete)
        li.classList.add("has-del");
        var del = document.createElement("button");
        del.type = "button";
        del.className = "pl-del";
        del.setAttribute("aria-label", "Delete upload");
        del.innerHTML = TRASH_SVG;
        del.addEventListener("click", function (e) {
          e.stopPropagation();                       // don't select the row
          pickerState.onDelete(it.value, function () { li.remove(); });
        });
        li.appendChild(del);
      }
      if (pickerState.canEdit && pickerState.onEdit && pickerState.canEdit(it.value)) {
        // ✎ — playlists: opens the editor. Uploads: renames the file (row click still plays it). The
        // handler may call back with a new label so the row (and search index) updates in place.
        li.classList.add("has-del");
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "pl-del";
        edit.setAttribute("aria-label", "Rename");
        edit.innerHTML = EDIT_SVG;
        edit.addEventListener("click", function (e) {
          e.stopPropagation();
          pickerState.onEdit(it.value, function (newLabel) {
            if (!newLabel) return;
            it.label = newLabel;
            var lbl = li.querySelector(".pl-label"); if (lbl) lbl.textContent = newLabel;
          });
        });
        li.appendChild(edit);
      }
      ul.appendChild(li);
    });
    // nothing to show → hide the scrolling list area entirely (no empty box under the search)
    var wrap = ul.parentNode;   // .modal__listwrap
    if (wrap) wrap.style.display = pickerState.filtered.length ? "" : "none";
    highlightActive();
  }
  function highlightActive() {
    var lis = els.pickerList.children;
    for (var i = 0; i < lis.length; i++) lis[i].classList.toggle("active", i === pickerState.active);
    if (lis[pickerState.active]) lis[pickerState.active].scrollIntoView({ block: "nearest" });
  }
  // Scroll the list so the active item is centered, using layout offsets (not getBoundingClientRect)
  // so it works while the modal's open animation is transforming the panel. Called synchronously on
  // open so the selection is already in view on the first paint — no scroll-into-place animation.
  function centerActiveInList() {
    var wrap = els.pickerList.parentNode;            // .modal__listwrap (overflow-y:auto, position:relative)
    var li = els.pickerList.children[pickerState.active];
    if (!wrap || !li) return;
    if (wrap.scrollHeight <= wrap.clientHeight) { wrap.scrollTop = 0; return; }
    var top = 0, n = li;                             // sum offsetTop up to the scroll container (transform-proof)
    while (n && n !== wrap) { top += n.offsetTop; n = n.offsetParent; }
    wrap.scrollTop = Math.max(0, top - (wrap.clientHeight - li.offsetHeight) / 2);
  }
  function pick(i) {
    var it = pickerState.filtered[i];
    if (!it) return;
    var fn = pickerState.onPick;
    closePicker();
    if (fn) fn(it.value);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  els.pickerSearch.addEventListener("input", function () { renderPicker(els.pickerSearch.value); });
  els.pickerClose.addEventListener("click", closePicker);
  els.picker.addEventListener("click", function (e) { if (e.target === els.picker) closePicker(); });
  els.pickerSearch.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); pickerState.active = Math.min(pickerState.filtered.length - 1, pickerState.active + 1); highlightActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pickerState.active = Math.max(0, pickerState.active - 1); highlightActive(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(pickerState.active); }
    else if (e.key === "Escape") { e.preventDefault(); closePicker(); }
  });

  /* ---------- keyboard shortcuts + help popup (desktop) ---------- */
  var kbdHelp = root.getElementById("kbdHelp"), kbdBtn = root.getElementById("kbdBtn"), kbdHelpClose = root.getElementById("kbdHelpClose");
  var TAB_ORDER = ["exercise", "randomize", "bump", "loop", "playlist"];
  function kbdHelpOpen() { return kbdHelp && !kbdHelp.hidden; }
  // open/close mirror the picker modal exactly, so every pop-up shares the same in/out animation.
  function openKbdHelp() {
    if (!kbdHelp) return;
    kbdHelp.hidden = false;
    kbdHelp.classList.remove("is-closing");
    void kbdHelp.offsetWidth;                       // restart the open animation
    kbdHelp.classList.add("is-open");
  }
  function closeKbdHelp() {
    if (!kbdHelp || kbdHelp.hidden || kbdHelp.classList.contains("is-closing")) return;
    var panel = kbdHelp.querySelector(".kbdhelp__panel");
    // FREEZE at current (keyboard-shrunk) geometry before blurring — same fix as closePicker, for the
    // same reason: if the keyboard was up (focus left over from elsewhere) and dismisses while this
    // popup fades out, --vvh growing back to full height would resize/re-center it mid-fade.
    var kcs = getComputedStyle(kbdHelp);
    kbdHelp.style.height = kcs.height;
    kbdHelp.style.top = kcs.top;
    if (root.activeElement && kbdHelp.contains(root.activeElement)) root.activeElement.blur();
    kbdHelp.classList.remove("is-open");
    kbdHelp.classList.add("is-closing");            // play the close animation, THEN hide
    var finish = function () {
      if (!kbdHelp.classList.contains("is-closing")) { cleanup(); return; }   // was reopened mid-close
      kbdHelp.hidden = true;
      kbdHelp.classList.remove("is-closing");
      kbdHelp.style.height = kbdHelp.style.top = "";
      cleanup();
    };
    function cleanup() { if (panel) panel.removeEventListener("animationend", finish); }
    if (panel) panel.addEventListener("animationend", finish);
    setTimeout(finish, 280);                        // fallback (reduced-motion / no animationend)
  }
  if (kbdBtn) kbdBtn.addEventListener("click", function () { kbdHelpOpen() ? closeKbdHelp() : openKbdHelp(); });   // toggle: click again to close
  if (kbdHelpClose) kbdHelpClose.addEventListener("click", closeKbdHelp);
  if (kbdHelp) kbdHelp.addEventListener("click", function (e) { if (e.target === kbdHelp) closeKbdHelp(); });
  function typingInField() { var el = root.activeElement, tag = (el && el.tagName || "").toLowerCase(); return tag === "input" || tag === "textarea" || tag === "select" || (el && el.isContentEditable); }
  document.addEventListener("keydown", function (e) {
    if (kbdHelpOpen()) { if (e.key === "Escape" || e.key === "/" || e.key === "?") { e.preventDefault(); closeKbdHelp(); } return; }   // popup owns Esc + "/" (toggle shut); ignore the rest behind it
    if (!els.picker.hidden) return;                  // the search / queue picker owns keys
    if (e.ctrlKey || e.metaKey || e.altKey) return;  // never hijack browser / OS shortcuts
    /* A SLIDER left focused after a drag must not swallow Space, or (worse) sit there and let the
       browser flip on its focus ring right as you press it (Anthony, 2026-08-02 — see the matching
       comment in Sightreading Lab/app.js for the full story). Blur it and fall through to the
       transport toggle below; every other key still goes through typingInField() as before, so
       arrow-key slider nudging is untouched. */
    var _focusedForSpace = root.activeElement;
    if (_focusedForSpace && _focusedForSpace.tagName === "INPUT" && _focusedForSpace.type === "range" &&
        (e.key === " " || e.code === "Space" || e.key === "Spacebar")) { _focusedForSpace.blur(); }
    else if (typingInField()) return;                // let people type in the search / number fields
    var k = e.key;
    if (k === "?" || k === "/") { e.preventDefault(); openKbdHelp(); return; }   // "/" needs no Shift
    // transport
    if (e.code === "Space" || k === " " || k === "k" || k === "K") { e.preventDefault(); if (!els.playBtn.disabled) player.toggle(); return; }
    if (k === "j" || k === "J") { e.preventDefault(); if (inPlaylist) { if (queueIndex > 0) playQueueEntry(queueIndex - 1, true); } else player.seekMeasure(-1); return; }
    if (k === "l" || k === "L") { e.preventDefault(); if (inPlaylist) { if (queueIndex < queue.length - 1) playQueueEntry(queueIndex + 1, true); } else player.seekMeasure(1); return; }
    if (k === "Backspace") { e.preventDefault(); if (!els.rewindBtn.disabled) player.seek(0); return; }
    if (k === "r" || k === "R") { e.preventDefault(); pickRandomExercise(); return; }
    // tempo (locked while a playlist runs, as before)
    if (k === "ArrowUp")   { if (inPlaylist) return; e.preventDefault(); player.nudgeTempo(e.shiftKey ? 5 : 1); return; }
    if (k === "ArrowDown") { if (inPlaylist) return; e.preventDefault(); player.nudgeTempo(e.shiftKey ? -5 : -1); return; }
    if (k === "t" || k === "T") { e.preventDefault(); els.tapTempoBtn.click(); return; }   // matches SR Lab (Anthony, 2026-07-16)
    // exercise navigation (steps queue exercises while in a playlist)
    if (k === "ArrowLeft")  { e.preventDefault(); if (inPlaylist) stepQueueExercise(-1); else stepExercise(-1); return; }
    if (k === "ArrowRight") { e.preventDefault(); if (inPlaylist) stepQueueExercise(1);  else stepExercise(1);  return; }
    // toggles + actions (disabled buttons ignore .click(), so these no-op safely when unavailable)
    if (k === "f" || k === "F") { e.preventDefault(); els.favBtn.click(); return; }
    if (k === "m" || k === "M") { e.preventDefault(); els.metroBtn.click(); return; }
    if (k === "x" || k === "X") { e.preventDefault(); pickRandomExercise(); return; }
    // zoom
    if (k === "+" || k === "=") { e.preventDefault(); els.sizeUp.click(); return; }
    if (k === "-" || k === "_") { e.preventDefault(); els.sizeDown.click(); return; }
    if (k === "0") { e.preventDefault(); els.sizeVal.click(); return; }
    // tabs 1-5 (press the active tab's number again to collapse it)
    if (k >= "1" && k <= "5") { e.preventDefault(); var name = TAB_ORDER[+k - 1], t = root.querySelector('.tab[data-tab="' + name + '"]'); setTab(t && t.classList.contains("active") ? null : name); return; }
    // loop clear (unchanged)
    if (k === "Escape") { if (player.hasLoop()) { e.preventDefault(); player.clearLoop(); } return; }
  });

  /* ---------- pinned-bar drop shadow (only while content scrolls) ---------- */
  function updateDockShadow() {
    var sa = els.scrollarea, d = els.dock;
    if (!sa || !d) return;
    var scrollable = (sa.scrollHeight - sa.clientHeight) > 2;
    var atBottom = (sa.scrollTop + sa.clientHeight) >= (sa.scrollHeight - 2);
    d.classList.toggle("is-floating", scrollable && !atBottom);
  }
  if (els.scrollarea) els.scrollarea.addEventListener("scroll", updateDockShadow);
  // The notation is drawn to a fixed width. Only a genuine window resize changes the (scrollbar-
  // independent) score-box width, so refresh the cached width and re-flow ONLY here — debounced so we
  // read a settled value, never a mid-resize blip. No ResizeObserver: it fired on transient reflows
  // during loads and caused the "draws narrow, then snaps wider" double-render.
  // Keyboard-aware layout (phones): the on-screen keyboard shrinks window.visualViewport but NOT the
  // layout viewport, so vh/dvh + fixed elements stay full-height and the keyboard covers the bottom
  // (the BPM box, and the lower half of any open picker). Mirror the VISIBLE viewport into --vvh/--vvo so
  // the app-shell + modals size to the space above the keyboard. Uses visualViewport events (not window
  // resize), so opening the keyboard never re-renders the score.
  (function () {
    var vv = window.visualViewport; if (!vv) return;
    var root = document.documentElement, raf = 0;
    function sync() {
      raf = 0;
      root.style.setProperty("--vvh", Math.round(vv.height) + "px");
      root.style.setProperty("--vvo", Math.round(vv.offsetTop) + "px");
    }
    function onVV() { if (!raf) raf = requestAnimationFrame(sync); }
    vv.addEventListener("resize", onVV);
    vv.addEventListener("scroll", onVV);
    sync();
  })();

  var relayoutTimer = null, lastRelayoutW = 0;
  window.addEventListener("resize", function () {
    updateDockShadow();
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      measureStableRenderW();
      // Re-flow ONLY when the score-box WIDTH actually changed. On phones the address bar sliding in/out
      // fires a resize with a NEW HEIGHT but the SAME width — re-rendering there just makes the music
      // visibly stretch/jump for no reason. Height-only changes are ignored; a real rotation still reflows.
      var w = stableRenderW || els.score.clientWidth || 0;
      if (currentExercise && w > 0 && w !== lastRelayoutW) { lastRelayoutW = w; try { player.relayout(); } catch (e) {} }
      updateDockShadow();
      fitScrollbar();
    }, 180);
  });

  /* ---------- boot ---------- */
  (function init() {
    els.categoryBtn.querySelector(".lbl").textContent = "All Categories";
    paintSlider();
    updateDockShadow();
    setTimeout(updateDockShadow, 400);
    if (!EXERCISES.length) { els.exerciseTitle.textContent = "No exercises found"; return; }
    setExerciseBtnLabel(EXERCISES[0].name);

    // Render the first exercise IMMEDIATELY — no waiting for the layout to "settle" (that was falling
    // through to a ~1.5s fallback, hence the blank-then-appear). Switching the sheet into its "has-score"
    // layout up front makes the empty score box STRETCH to its real full width (before this it's inside a
    // center-flex card and measures ~0). Reading clientWidth then forces a synchronous layout, so we get
    // the correct render width right away. scrollbar-gutter:stable keeps that width steady afterward, and a
    // genuine window resize re-flows via the resize handler above — so no ResizeObserver settle is needed.
    els.sheetWrap.classList.add("has-score");
    measureStableRenderW();
    if (!stableRenderW) stableRenderW = els.score.clientWidth || 1000;   // last-ditch fallback
    lastRelayoutW = stableRenderW;   // baseline width → address-bar height changes won't trigger a re-flow
    loadExercise(EXERCISES[0]);

    // wire up the Stickings generator (chart lives below the staff; loadStickingRDM renders + plays)
    if (window.RDMStickings) window.RDMStickings.init({ onSelect: loadStickingRDM, chartEl: els.stkChart });
  })();

  /* ---------- background playback: a SEPARATE, invisible player does the rendering ----------
     2026-07-30, after the first version of this broke live playback in production: that version reused
     the LIVE `player` object to render (paused it, repointed its audio graph at an OfflineAudioContext).
     Doing that WHILE a student was listening scrambled the live player's tempo/clock. The fix is
     structural, not a patch: rendering happens on its own RDMPlayer, on its own detached host div,
     never appended to the page. The live `player` is only ever READ from (to copy its current settings),
     never called or assigned to. A bug in the shadow player literally cannot reach the one making sound. */
  var bouncePlayer = null, bounceHost = null;
  function ensureBouncePlayer() {
    if (!bouncePlayer) {
      bounceHost = document.createElement("div");   // detached: RDMRender writes notation into it, but
      bouncePlayer = new RDMPlayer(bounceHost, {});  // it is never inserted into the document, so nothing
    }                                                 // about this is ever visible or interactive.
    return bouncePlayer;
  }

  // ---- mount API (used by the React shell; harmless standalone) ----
  return {
    /* Coming back on screen: pick live playback up where the background bounce got to, so the playhead
       and what you hear agree instead of the sheet music sitting at the wrong bar. The bounce is always
       fixed-tempo-at-render-time, so elapsed seconds map straight onto a fraction of one pass. Only ever
       touches the LIVE player — the shadow player is never involved here. */
    resumeAt: function (secs) {
      try {
        var passSecs = (player.totalBeats || 0) * (60 / player.tempo);
        if (!(passSecs > 0)) return;
        player.seek((secs % passSecs) / passSecs);
        player.play();
      } catch (e) { /* nothing loaded */ }
    },
    /* Render the CURRENTLY LOADED exercise on the shadow player, copying the live player's settings
       (tempo, Randomize/Bump config) across as plain values first — never a shared reference the shadow
       could mutate back into. `rdm` itself (the parsed piece) IS shared with the live player, but nothing
       ever writes into it (checked: engine.js only reads this.rdm.*), only reads, so two players sharing
       it is safe — each independently derives its own `perf` array from it. */
    renderBounce: function (seconds) {
      if (!currentExercise) return Promise.reject(new Error("nothing loaded"));
      var rdm = _rdmCache[currentExercise.file];
      if (!rdm) return Promise.reject(new Error("exercise not ready"));
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
    bounceMeta: function () {
      return { title: (currentExercise && currentExercise.name) || "RDM Playalongs", tempo: player.tempo };
    },
    /* Jump straight to one exercise by id. Added for the app's Checklists page, where each Stickings
       panel links to its matching "N Note Stickings" exercise so a student can go and play the thing
       they are ticking off (Anthony, 2026-07-30).

       Forces the category back to "all" first: the target is almost certainly outside whatever filter
       happens to be set (Favorites, My Uploads, a single category), and loading an exercise that the
       current filter excludes leaves the picker and the title chevrons pointing at a list the loaded
       exercise is not in. Returns false when the id is unknown so the caller can tell the difference
       between "done" and "no such exercise". */
    openExercise: function (id) {
      var ex = exById(id);
      if (!ex) return false;
      if (currentCategory !== "all") {
        currentCategory = "all";
        var lbl = els.categoryBtn && els.categoryBtn.querySelector(".lbl");
        if (lbl) lbl.textContent = catLabel("all");
        refreshSheetCats();
      }
      loadExercise(ex);
      updateTitleNav();
      return true;
    },
    destroy: function () {
      ((ctx && ctx.disposables) || []).forEach(function (f) { try { f(); } catch (e) {} });
      try { player.stop(); } catch (e) {}
    },
    pause: function () { try { player.pause(); } catch (e) { try { player.stop(); } catch (e2) {} } },
    // Re-measure the score box and re-render at that width. Needed after an embedded mount: the box's real
    // width isn't laid out at the synchronous boot inside a shadow root, so the first render can be drawn
    // narrow and then CSS-stretched (too big). The shell calls this once the layout settles / on show.
    relayout: function () {
      try {
        measureStableRenderW();
        var w = stableRenderW || els.score.clientWidth || 0;
        if (w > 0) { lastRelayoutW = w; player.relayout(); }
        updateDockShadow(); fitScrollbar();
      } catch (e) {}
    }
  };
}

// Expose the mount fn; auto-run only when NOT embedded (so the tool still works standalone).
window.mountPlayalongs = mountPlayalongs;
if (!window.__RDM_EMBED) {
  var __rdmRunPA = function () { mountPlayalongs(document, { root: document, isActive: function () { return true; }, disposables: [] }); };
  if (document.readyState !== "loading") __rdmRunPA();
  else document.addEventListener("DOMContentLoaded", __rdmRunPA);
}
