/* ============================================================
   RDM METRONOME  (Engine V2 — unified with Playalongs)
   The advanced marching metronome: ratio-rhythm subdivisions (4:3, 8:3, 5-lets,
   7-lets, 9-lets…), a ×multiplier, per-beat + per-partial accent editing, tap
   tempo, and five click voices. Ported from the original RDM metronome engine
   (the sample-accurate lookahead scheduler is kept intact) and rewired onto the
   shared RDM design system: dark shell, teal panels, shared .modal pickers, and
   the same bottom dock as the Playalongs tool.
   ============================================================ */
function mountMetronome(root, ctx) {
  ctx = ctx || {}; root = root || document;
  const $  = (s, scope = root) => scope.querySelector(s);
  const $$ = (s, scope = root) => Array.from(scope.querySelectorAll(s));

  /* ---------------- FREEMIUM (Anthony, 2026-07-31) ----------------
     A free account gets a real, useful metronome: simple meters, and the four subdivisions a drummer
     actually counts (quarters, 8ths, triplets, 16ths). Locked are the trainers (Bump Tempo, Gap Trainer),
     saved presets, the compound + asymmetric meters, and every ratio rhythm / 5-7-9-let / 32nd.
     Locked things stay VISIBLE and greyed with a padlock: a lock you can see is what sells the upgrade,
     a missing control just looks like a tool that can't do much. */
  const PAID = ctx.paid !== false;
  const FREE_TIMESIGS = { '2/4':1, '3/4':1, '4/4':1, '5/4':1, '6/4':1 };          // the Simple Meters group
  const FREE_SUBDIVS  = { '1/1':1, '2/1':1, '3/1':1, '4/1':1 };                    // simple family: ♩ ♪ 3 16ths
  const sigLocked = (v) => !PAID && !FREE_TIMESIGS[v];
  const subdivLocked = (v) => !PAID && !FREE_SUBDIVS[v];
  // The value stack for THIS tool, shown under whichever specific reason (`message`) triggered the
  // prompt — it's the same purchase no matter which lock they hit, so show the whole thing every time.
  const UPSELL_BULLETS = [
    "All 18 subdivisions, including the marching ratios a normal click can't play",
    "Bump Tempo, and the Gap Trainer that tests your time",
    "Compound and asymmetric meters, and saved presets"
  ];
  const UPSELL_PRICE = "$1 for your first week, then $9.99 a month.";
  function upsell(title, message){
    const D = window.RDMDialogs;
    if (D && D.confirm){
      // theme-purple = this tool's own color (matches tools.js) — theme-teal is what the SUBDIVISION
      // PICKER modal uses (kept as-is, further up this file); the upsell should read as "Metronome", not
      // borrow the picker's color. (Anthony, 2026-07-31)
      D.confirm(root, {
        title, message, confirmLabel: "See what's included", theme: 'theme-purple',
        bullets: UPSELL_BULLETS, price: UPSELL_PRICE
      }).then((ok) => { if (ok && ctx.onUpgrade) ctx.onUpgrade(); });
    } else if (ctx.onUpgrade) ctx.onUpgrade();
  }

  /* ---------------- Elements ---------------- */
  const playBtn   = $('#playBtn');
  const tapBtn    = $('#tapBtn');

  const bpmDec1Btn = $('#bpmDec1');
  const bpmDec5Btn = $('#bpmDec5');
  const bpmInc1Btn = $('#bpmInc1');
  const bpmInc5Btn = $('#bpmInc5');

  const tempoSlider = $('#tempoSlider');
  const tempoInput  = $('#tempoInput');
  const tempoFill   = $('#tempoFill');
  const bpmBig      = $('#bpmBig');

  // hidden selects (source of truth) + their trigger buttons
  const timeSigSel = $('#timeSigSel');
  const subdivSel  = $('#subdivSel');
  const soundSel   = $('#soundSel');

  const lightsWrap    = $('#metroLights');
  const subLightsWrap = $('#subLights');
  const metroMeta     = $('#notationTitle');   // the "4/4 · Subdivision" now titles the sheet card

  const mainVolRange = $('#mainVolRange');
  const mainVolVal   = $('#mainVolVal');
  const mainVolFill  = $('#mainVolFill');
  const subVolRange  = $('#subVolRange');
  const subVolVal    = $('#subVolVal');
  const subVolFill   = $('#subVolFill');

  /* ---------------- Shared .modal picker ---------------- */
  const pickerEl     = $('#picker');
  const pickerTitle  = $('#pickerTitle');
  const pickerClose  = $('#pickerClose');
  const pickerSearch = $('#pickerSearch');
  const pickerList   = $('#pickerList');
  let activeSelect = null, activeTrigger = null;
  // subStates (declared further down, 0 off / 1 normal / 2 accent per partial) is the live source of
  // truth for the CURRENTLY selected subdivision's rhythm — edited by clicking a sub-light, and read by
  // subdivSpec() to drive the button icon. savedStatesByValue remembers each ratio's last-edited states
  // so switching away and back restores it.
  const savedStatesByValue = {};

  function triggerLabel(trigger, text){
    const l = trigger.querySelector('.lbl'); if (l) l.textContent = text;
    // icon-forward settings buttons: keep their generated glyph in sync whenever the label updates
    // (covers every call site — init, picker clicks, nav steppers — with one choke point)
    if (trigger.id === 'timeSigBtn') updateTimeSigGlyph(trigger, text);
    else if (trigger.id === 'subdivBtn') updateSubdivIcon(trigger, text);
  }

  // call after ANY edit to subStates (a sub-light click) — re-renders everything that reflects the
  // current subdivision's rhythm (button icon, picker list previews, the sub-lights themselves) and
  // remembers this ratio's edit for next time it's selected.
  function onSubStatesEdited(){
    savedStatesByValue[subdivSel.value] = subStates.slice();
    seqCommit();                                  // the pills belong to the SELECTED sequence step
    updateSubdivIcon($('#subdivBtn'));
    renderSubLights();
    renderSeq();
    if (activeSelect === subdivSel) renderPickerList(pickerSearch.value);
    renderNotation();
  }
  function openPicker(trigger, selectEl, titleText){
    activeSelect = selectEl; activeTrigger = trigger;
    pickerTitle.textContent = titleText || 'Select';
    pickerSearch.value = '';
    renderPickerList('');
    pickerEl.hidden = false;
    pickerEl.classList.remove('is-closing');
    void pickerEl.offsetWidth;                 // restart the open animation (matches Playalongs)
    pickerEl.classList.add('is-open');
    // only focus the search on non-touch (avoid popping the mobile keyboard over the short lists)
    if (!matchMedia('(hover:none)').matches) setTimeout(() => pickerSearch.focus({ preventScroll: true }), 30);
  }
  function closePicker(){
    if (pickerEl.hidden || pickerEl.classList.contains('is-closing')) return;
    const panel = pickerEl.querySelector('.modal__stack');
    // FREEZE at current (keyboard-shrunk) geometry before blurring, so dismissing the mobile keyboard
    // can't resize / re-center the modal mid-fade (the "glitch"). Matches Playalongs. Cleared on finish.
    const pcs = getComputedStyle(pickerEl);
    pickerEl.style.height = pcs.height;
    pickerEl.style.top = pcs.top;
    if (panel) panel.style.maxHeight = getComputedStyle(panel).maxHeight;
    if (root.activeElement && pickerEl.contains(root.activeElement)) root.activeElement.blur();
    pickerEl.classList.remove('is-open');
    pickerEl.classList.add('is-closing');       // play the close animation, THEN hide
    const finish = () => {
      if (!pickerEl.classList.contains('is-closing')) { cleanup(); return; }   // was reopened mid-close
      pickerEl.hidden = true; pickerEl.classList.remove('is-closing');
      pickerEl.style.height = pickerEl.style.top = '';
      if (panel) panel.style.maxHeight = '';
      cleanup();
    };
    function cleanup(){ if (panel) panel.removeEventListener('animationend', finish); }
    if (panel) panel.addEventListener('animationend', finish);
    setTimeout(finish, 280);                    // fallback (reduced-motion / no animationend)
    activeSelect = null; activeTrigger = null;
  }

  // Keyboard-aware layout (phones): the on-screen keyboard shrinks window.visualViewport but NOT the
  // layout viewport, so vh/dvh + fixed elements stay full-height and the keyboard covers the bottom (the
  // BPM box, and the lower half of any open picker). Mirror the VISIBLE viewport into --vvh/--vvo so the
  // app-shell + modals size to the space above the keyboard. Uses visualViewport events (not window
  // resize). IDENTICAL to the Playalongs tool so both handle the mobile keyboard the same way.
  (function () {
    const vv = window.visualViewport; if (!vv) return;
    const root = document.documentElement; let raf = 0;
    function sync() {
      raf = 0;
      root.style.setProperty('--vvh', Math.round(vv.height) + 'px');
      root.style.setProperty('--vvo', Math.round(vv.offsetTop) + 'px');
    }
    function onVV() { if (!raf) raf = requestAnimationFrame(sync); }
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
    sync();
  })();

  // Time-signature picker is grouped + two-column (Simple / Compound / Asymmetric), like the Sightreading Lab.
  const TIME_SIG_GROUPS = [
    { title: 'Simple Meters',     vals: ['2/4', '3/4', '4/4', '5/4', '6/4'] },
    { title: 'Compound Meters',   vals: ['6/8', '9/8', '12/8'] },
    { title: 'Asymmetric Meters', vals: ['5/8', '7/8'] }
  ];
  // NOTE: the subdivision picker groups come from the CURRENT meter family (SUBDIV_FAMILIES, defined below)
  // via familyGroups() — the option set changes with simple / compound / asymmetric.
  function renderPickerList(filter){
    if (!activeSelect) return;
    const q = (filter || '').trim().toLowerCase();
    pickerList.innerHTML = '';
    // when a search matches NO options, hide the whole list area (no empty box under the search) — matches
    // the Playalongs picker. Counts real option rows, ignoring group headers.
    const syncEmptyState = () => {
      const wrap = pickerList.parentNode;   // .modal__listwrap
      if (wrap) wrap.style.display = pickerList.querySelector('li:not(.modal__grouphdr)') ? '' : 'none';
    };
    if (activeSelect === timeSigSel){
      pickerList.classList.add('modal__list--twocol');
      TIME_SIG_GROUPS.forEach((g) => {
        const items = g.vals.filter((v) => !q || v.toLowerCase().includes(q));
        if (!items.length) return;
        const h = document.createElement('li'); h.className = 'modal__grouphdr'; h.textContent = g.title; pickerList.appendChild(h);
        items.forEach((v) => {
          const li = document.createElement('li'); li.setAttribute('role', 'option'); li.classList.add('modal__opt--timesig');
          // show the REAL VexFlow time-signature glyph as the option (falls back to text if render fails)
          let g = null; try { g = timeSigGlyph(v); } catch (e){}
          if (g) li.appendChild(g); else li.textContent = v;
          if (v === timeSigSel.value) li.classList.add('active');
          if (sigLocked(v)) li.classList.add('modal__opt--locked');
          li.addEventListener('click', () => {
            if (sigLocked(v)){
              closePicker();
              upsell('Unlock ' + v, 'Compound and asymmetric meters come with the full version, along with every subdivision.');
              return;
            }
            timeSigSel.value = v; timeSigSel.dispatchEvent(new Event('change', { bubbles: true }));
            if (activeTrigger) triggerLabel(activeTrigger, v); closePicker();
          });
          pickerList.appendChild(li);
        });
      });
      syncEmptyState(); return;
    }
    pickerList.classList.remove('modal__list--twocol');
    const chooseOption = (opt) => {
      activeSelect.value = opt.value || opt.text;
      activeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      if (activeTrigger) triggerLabel(activeTrigger, opt.text || opt.value);
      closePicker();
    };
    // subdivision picker: GROUPED per the CURRENT meter family, each row = label + its rhythm figure
    if (activeSelect === subdivSel){
      const cur = subdivSel.value;
      const buildLi = (item) => {
        const li = document.createElement('li'); li.setAttribute('role', 'option'); li.classList.add('modal__opt--rhythm');
        const lbl = document.createElement('span'); lbl.className = 'modal__optlbl'; lbl.textContent = item.label;
        const fig = document.createElement('span'); fig.className = 'modal__optfig';
        let g = null; try { g = subdivGlyph(item.v); } catch (e){}
        if (g) fig.appendChild(g);
        li.appendChild(lbl); li.appendChild(fig);
        if (item.v === cur) li.classList.add('active');
        if (subdivLocked(item.v)) li.classList.add('modal__opt--locked');
        li.addEventListener('click', () => {
          if (subdivLocked(item.v)){
            closePicker();
            upsell('Unlock ' + item.label, 'The 5-lets, 7-lets, 9-lets, 32nds and every ratio rhythm come with the full version.');
            return;
          }
          chooseOption({ value: item.v, text: item.label });
        });
        return li;
      };
      familyGroups().forEach((grp) => {
        const items = grp.items.filter((it) => !q || it.label.toLowerCase().includes(q));
        if (!items.length) return;
        const h = document.createElement('li'); h.className = 'modal__grouphdr'; h.textContent = grp.title; pickerList.appendChild(h);
        items.forEach((it) => pickerList.appendChild(buildLi(it)));
      });
      syncEmptyState(); return;
    }
    // plain list (Sound)
    [...activeSelect.options].forEach((opt) => {
      const txt = opt.text || opt.value;
      if (q && !txt.toLowerCase().includes(q)) return;
      const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = txt;
      if (opt.selected) li.classList.add('active');
      li.addEventListener('click', () => chooseOption(opt));
      pickerList.appendChild(li);
    });
    syncEmptyState();
  }
  function attachPicker(trigger){
    const sel   = $('#' + trigger.getAttribute('data-picker'));
    const title = trigger.getAttribute('data-title') || 'Select';
    if (!sel) return;
    triggerLabel(trigger, sel.options[sel.selectedIndex]?.text || '');
    trigger.addEventListener('click', () => {
      if (!pickerEl.hidden && activeTrigger === trigger) closePicker();
      else openPicker(trigger, sel, title);
    });
  }
  $$('[data-picker]').forEach(attachPicker);
  pickerClose.addEventListener('click', closePicker);
  pickerSearch.addEventListener('input', () => renderPickerList(pickerSearch.value));
  // click outside the panel closes
  pickerEl.addEventListener('pointerdown', (e) => { if (e.target === pickerEl) closePicker(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pickerEl.hidden) closePicker(); });

  /* ---------------- Keyboard-shortcuts popup (copied from the Playalongs engine) ---------------- */
  const kbdBtn = $('#kbdBtn'), kbdHelp = $('#kbdHelp'), kbdHelpClose = $('#kbdHelpClose');
  function openKbd(){
    kbdHelp.hidden = false;
    kbdHelp.classList.remove('is-closing');
    void kbdHelp.offsetWidth;
    kbdHelp.classList.add('is-open');
  }
  function closeKbd(){
    if (kbdHelp.hidden || kbdHelp.classList.contains('is-closing')) return;
    const panel = kbdHelp.querySelector('.kbdhelp__panel');
    // FREEZE at current (keyboard-shrunk) geometry before blurring — matches the Playalongs kbdhelp and
    // this tool's own picker close: if the keyboard was up and dismisses mid-fade, --vvh growing back to
    // full height would otherwise resize/re-center this popup while it's still closing.
    const kcs = getComputedStyle(kbdHelp);
    kbdHelp.style.height = kcs.height;
    kbdHelp.style.top = kcs.top;
    if (root.activeElement && kbdHelp.contains(root.activeElement)) root.activeElement.blur();
    kbdHelp.classList.remove('is-open');
    kbdHelp.classList.add('is-closing');
    const finish = () => {
      if (!kbdHelp.classList.contains('is-closing')) { cleanup(); return; }
      kbdHelp.hidden = true; kbdHelp.classList.remove('is-closing');
      kbdHelp.style.height = kbdHelp.style.top = '';
      cleanup();
    };
    function cleanup(){ if (panel) panel.removeEventListener('animationend', finish); }
    if (panel) panel.addEventListener('animationend', finish);
    setTimeout(finish, 280);
  }
  const kbdOpen = () => !kbdHelp.hidden && !kbdHelp.classList.contains('is-closing');
  kbdBtn && kbdBtn.addEventListener('click', () => { kbdOpen() ? closeKbd() : openKbd(); });   // toggle: click again to close
  kbdHelpClose && kbdHelpClose.addEventListener('click', closeKbd);
  kbdHelp && kbdHelp.addEventListener('click', (e) => { if (e.target === kbdHelp) closeKbd(); });

  /* ---------------- Notation panel show/hide ---------------- */
  const notationCard = $('#notationCard'), notationToggle = $('#notationToggle');
  notationToggle && notationToggle.addEventListener('click', () => {
    const collapsed = notationCard.classList.toggle('collapsed');
    notationToggle.textContent = collapsed ? 'Show' : 'Hide';
    notationToggle.setAttribute('aria-pressed', String(!collapsed));
  });

  /* ---------------- Helpers ---------------- */
  const EPS = 1e-6;
  const clampInt = (v, min, max) => Math.max(min, Math.min(max, (parseInt(v, 10) || 0)));
  const getBpm = () => clampInt(tempoSlider.value, 0, 300);

  // parseInt (not Number) so a variant-tag suffix on the value (e.g. '3/1v1' — a rest/fused-rhythm
  // variant of the plain '3/1' Triplets ratio) still parses cleanly: parseInt stops at the first
  // non-digit, Number would reject the whole string as NaN. Every existing plain value is a clean
  // integer, so this is a no-op for them.
  function getSubdivParts(){
    const raw = (subdivSel?.value ?? '1/1').trim().replace(/\s+/g, '');
    let a = 1, b = 1;
    if (raw.includes('/')){ const [aStr, bStr] = raw.split('/'); a = parseInt(aStr, 10); b = parseInt(bStr, 10); }
    else a = parseInt(raw, 10);
    return { a: (isFinite(a) ? a : 1), b: (isFinite(b) ? b : 1), raw };
  }
  function getSubdivRatio(){ const { a, b } = getSubdivParts(); if (b <= 0) return 0; const r = a / b; return r >= 0 ? r : 0; }
  // time signature parsed from the single "N/D" picker
  function getTS(){ const p = (timeSigSel.value || '4/4').split('/'); return { n: clampInt(p[0], 1, 12), d: clampInt(p[1], 1, 16) }; }
  // THE FELT BEAT per meter family — what the metronome clicks on and what the tempo number counts.
  //   simple (x/4)     → quarter beats,        BPM = ♩ , beatsPerBar = n
  //   compound (x/8÷3) → dotted-quarter beats, BPM = ♩., beatsPerBar = n/3  (6/8 = 2 beats, not 6)
  //   asymmetric (x/8) → eighth beats,         BPM = ♪ , beatsPerBar = n
  // beatQuarters = the beat's length in quarter notes (used to size subdivisions/notation).
  function beatInfo(){
    const { n, d } = getTS();
    if (d === 8){
      if (n % 3 === 0) return { family:'compound',   beatsPerBar: Math.max(1, Math.round(n / 3)), beatQuarters: 1.5, glyph:'♩.' };
      return               { family:'asymmetric', beatsPerBar: n,                            beatQuarters: 0.5, glyph:'♪' };
    }
    return                 { family:'simple',     beatsPerBar: n,                            beatQuarters: 4 / d, glyph: (d === 2 ? '𝅘𝅥' : '♩') };
  }
  /* How many accent pills to show = ONE instance of the rhythm, never two.
     `a` is clicks per BAR for a cross-rhythm, and for the four N:M ratios (4:3, 5:3, 7:6, 8:6) one
     instance only spans HALF the auto-set bar, so `a` drew the pattern twice: 8 pills for a 4-note
     4:3, and 14/16 pills for 7:6 / 8:6 — which the >10 two-row split then stacked as two visibly
     identical rows (Anthony, 2026-07-31: "written out TWICE ... should be once, to match every other
     subdivision"). It also silently broke the live pattern icon, since subdivSpec() only swaps the
     plain icon for the edited pattern when subStates.length === icon.count (8 !== 4, so ratio rhythms
     never showed their own accents on the button).
     The option's ICON is the authority on what one instance is: when it declares a tuplet grouping,
     that grouping IS the rhythm, so `icon.count` is the instance. Without a tuplet the row is just a
     run of one repeated note value (16ths, 32nds, dotted-8ths), where `a` is already one instance.
     Every non-ratio subdivision resolves to the same number it had before — only the four ratios move.
     The scheduler already reads subStates with `subCounter % lights.length`, so a halved pattern
     simply repeats across the bar: identical audio, and a clean single-instance base for the ×N
     repeat multiplier to work from. */
  // ONE repetition of the rhythm — a beat's worth for a per-beat subdivision, one figure for a
  // cross-rhythm (a 4:3 is 4 notes, not the 8 that fill its 3-beat bar).
  function subsPerRep(value){
    const v = value == null ? subdivSel.value : value;
    const p = v.split('/');
    const total = Math.max(0, Math.floor(parseInt(p[0], 10) || 1));
    const it = familyItems().find((o) => o.v === v);
    const icon = it && it.icon;
    if (icon && icon.tup && icon.count > 0 && icon.count < total) return icon.count;
    return total;
  }
  /* Total pills = one repetition × however many beats the SELECTED sequence step lasts, so asking for
     4 beats of triplets gives 12 individually editable partials rather than 3 reused four times. */
  function subsLightsCount(){ return subsPerRep() * seqSelBeats(); }
  function isQuartersSubdiv(){ const { a, b } = getSubdivParts(); return a === 1 && b === 1; }

  /* ---------------- Rhythm sequence ----------------
     A STEP is (rhythm, how many BEATS it lasts). The metronome plays step 1's rhythm for its beats,
     then step 2's, and loops — so "a triplet beat then a 5-let beat" is a 2-step sequence. One step is
     exactly the old single-rhythm metronome, which is the default, so nothing changes until a second
     step is added.

     PER-BEAT RHYTHMS ONLY (b === 1: quarters/8ths/triplets/16ths/5-6-7-lets/32nds). That restriction is
     the whole point: a per-beat subdivision fits ANY meter, so a sequence of them can never drift
     against the barline. The cross-rhythms (4:3, 9-lets, …) span b>1 beats and force a b/4 meter, so
     mixing them into a sequence re-creates the "rhythm doesn't fit this meter" problem that got the OLD
     Repeat control deleted in the first place (see 0-DOCS/APP-BACKLOG.md). Cross-rhythms therefore stay
     single-rhythm: picking one collapses the sequence back to one step.

     `sel` (which step the picker + accent pills edit) and the PLAYING step are deliberately separate —
     you can study one step while another sounds, and the pills follow the selection, not the playhead. */
  const SEQ_MAX = 8, SEQ_BEATS_MAX = 8;
  let seqSteps = [];          // [{ v, n, states }]
  let seqSel = 0;             // step being edited
  let seqPlayIdx = -1;        // step currently sounding (-1 = not playing); drives the chip outline
  function seqPartsOf(v){ const p = (v || '1/1').split('/'); return { a: parseInt(p[0], 10) || 1, b: parseInt(p[1], 10) || 1 }; }
  function seqIsPerBeat(v){ return seqPartsOf(v).b === 1; }
  function seqRatioOf(v){ const p = (v || '1/1').split('/'); const a = parseInt(p[0], 10) || 1, b = parseInt(p[1], 10) || 1; return b > 0 ? a / b : 0; }
  function seqTotalBeats(){ return seqSteps.reduce((s, st) => s + Math.max(1, st.n | 0), 0); }
  /* Which step covers global beat index i (the sequence loops), AND how far into that step we are.
     `beatInStep` matters because a step's accent pattern spans ALL of its beats — ask for 4 beats of
     triplets and you get 12 editable partials, not 3 reused four times (Anthony, 2026-08-02: "if I ask
     for 4 triplets, I wanna see 'em so I can do the accenting"). */
  function seqStepAt(i){
    const total = seqTotalBeats();
    if (!seqSteps.length || total <= 0) return null;
    let k = ((i % total) + total) % total;
    for (let s = 0; s < seqSteps.length; s++){
      const n = Math.max(1, seqSteps[s].n | 0);
      if (k < n) return { step: seqSteps[s], idx: s, beatInStep: k };
      k -= n;
    }
    const last = seqSteps.length - 1;
    return { step: seqSteps[last], idx: last, beatInStep: 0 };
  }
  // repetitions the SELECTED step plays — the accent pills cover all of them
  function seqSelBeats(){
    const st = seqSteps[seqSel];
    return st ? Math.max(1, st.n | 0) : 1;
  }

  /* WHICH STEP THE PILLS SHOW.
     While stopped it's the selected chip, so you can edit a step deliberately. While PLAYING the pills
     FOLLOW the playhead, so 8ths-then-triplets shows the 8th pills, then the triplet pills, as each one
     sounds (Anthony, 2026-08-02) — the row becomes a live readout of what you're hearing rather than a
     static view of one step. */
  function seqViewIdx(){
    return (isRunning && seqPlayIdx >= 0 && seqSteps[seqPlayIdx]) ? seqPlayIdx : seqSel;
  }
  function seqViewStep(){ return seqSteps[seqViewIdx()] || null; }
  /* Rebuild the pill row OFF the scheduling path. schedule() notices the step change while it is handing
     Web Audio its click times, and rebuilding a row of DOM nodes there is exactly the kind of work that
     makes a metronome stutter. Coalesced to one rebuild per frame. */
  let _pillRaf = 0;
  function seqRequestPills(){
    if (_pillRaf) return;
    _pillRaf = requestAnimationFrame(() => { _pillRaf = 0; renderSubLights(); });
  }

  /* THE SEQUENCE AS ONE REPEATING CLICK PATTERN.
     Everything the scheduler needs, flattened: each subdivision click as an offset in BEATS from the
     start of the cycle, plus the length of the cycle. Beat clicks are not in here — they stay on the
     plain integer beat grid, untouched.

     This is what lets a cross-rhythm sit in a sequence next to a per-beat one. A rhythm's figure spans
     `b * perRep / a` beats: 1 for any per-beat subdivision, but 1.5 for a 4:3 / 5:3 / 7:6 / 8:6 and
     0.75 for dotted-8ths. Those fractions mean a step can END mid-beat, so the sequence drifts against
     the barline — accepted deliberately (Anthony, 2026-08-02), and self-correcting: 1.5 realigns after
     2 repetitions and 0.75 after 4, so it is never adrift for long.

     Modelling the sequence as clicks-with-beat-offsets rather than as whole beats is what makes that
     legal at all; the earlier beat-driven loop could only place a whole number of clicks inside one
     beat, which is precisely why it mangled cross-rhythms into per-beat subdivisions. */
  let _pat = null, _patKey = '';
  function seqPattern(){
    // `pills` follows the VIEWED step (selection while stopped, playhead while running), so that index
    // belongs in the key or the pulse stops matching the row after it swaps
    const key = seqViewIdx() + '#' + seqSteps.map((s) => s.v + ':' + s.n + ':' + (s.states || []).join('')).join('|');
    if (_pat && _patKey === key) return _pat;
    const clicks = [];
    let off = 0;
    seqSteps.forEach((st, si) => {
      const p = seqPartsOf(st.v), perRep = subsPerRep(st.v);
      if (!(p.a > 0) || !(perRep > 0)) return;
      const repBeats = p.b * perRep / p.a;              // beats ONE figure spans
      const reps = Math.max(1, st.n | 0);
      const isQuarters = p.a === 1 && p.b === 1;        // the beat IS the click; contributes no subs
      for (let r = 0; r < reps; r++){
        if (!isQuarters){
          for (let k = 0; k < perRep; k++){
            const pi = r * perRep + k;
            const s = (st.states || [])[pi];
            clicks.push({ off: off + k * repBeats / perRep, s: s == null ? 1 : s, si: si, pi: pi });
          }
        }
        off += repBeats;
      }
    });
    const vs = seqViewStep();
    _pat = { clicks: clicks, cycleBeats: off > 0 ? off : 1,
             pills: vs ? subsPerRep(vs.v) * Math.max(1, vs.n | 0) : 0 };
    _patKey = key;
    return _pat;
  }
  const seqActive = () => seqSteps.length > 1;   // one step = plain metronome, row stays hidden

  /* Write the picker + pills back into the steps. The RHYTHM always belongs to the selected chip (the
     picker edits what you selected), but the PILLS belong to whichever step is on screen — during
     playback that is the sounding step, so clicking a pill edits the pattern you can actually see. */
  function seqCommit(){
    if (!seqSteps.length) seqSteps = [{ v: subdivSel.value, n: 1, states: [] }];
    if (seqSel < 0 || seqSel >= seqSteps.length) seqSel = 0;
    seqSteps[seqSel].v = subdivSel.value;
    const vs = seqViewStep();
    if (vs) vs.states = subStates.slice();
  }
  /* Grow/shrink a step's pattern to `want` partials, KEEPING what's already there. Changing a step from
     2 beats to 4 must not wipe the accents you set on the first 2 — it extends with plain notes; going
     back down just drops the tail. */
  function seqResizeStates(st, want){
    const cur = (st.states || []).slice();
    if (cur.length === want) return cur;
    if (cur.length > want) return cur.slice(0, want);
    const out = cur.concat(defaultSubStates(want - cur.length));
    return out.slice(0, want);
  }
  // load the selected step INTO the picker + pills
  function seqApply(){
    const st = seqSteps[seqSel];
    if (!st) return;
    if (subdivSel.value !== st.v){
      subdivSel.value = st.v;
      triggerLabel($('#subdivBtn'), subdivSel.options[subdivSel.selectedIndex]?.text || '');
      updateSubdivIcon($('#subdivBtn'));
    }
    const want = subsLightsCount();
    st.states = seqResizeStates(st, want);
    subStates = st.states.slice();
    renderSubLights();
    updateMeta();
  }
  /* Cross-rhythms may now share a sequence with per-beat rhythms (Anthony, 2026-08-02). They span a
     fraction of a beat (a 4:3 figure is 1.5 beats, dotted-8ths 0.75), so a sequence containing one
     drifts against the barline — accepted on purpose, and it self-corrects quickly: 1.5 realigns after
     2 repetitions, 0.75 after 4. seqPattern() places every click by beat OFFSET rather than by whole
     beats, which is what makes the mix legal.
     This replaces an earlier rule that collapsed the sequence to a single step (with a stash/restore to
     avoid destroying it) whenever a cross-rhythm was picked. Both are gone. */
  let seqStash = null;
  function seqEnforcePerBeat(){ return false; }
  /* Just toggles a class — the scheduler touches this every beat, and rebuilding the whole chip row
     (which re-renders a VexFlow glyph per chip) at that rate would be real work on the same thread
     that has to hand Web Audio its click times. Leads the sound by the scheduler's lookahead, exactly
     like the accent pills do. */
  let _seqLastPlay = -2;
  function seqRefreshPlaying(){
    const shown = isRunning ? seqPlayIdx : -1;
    if (_seqLastPlay === shown) return;
    _seqLastPlay = shown;
    const row = $('#seqRow'); if (!row) return;
    const chips = row.querySelectorAll('.seq-chip');
    for (let i = 0; i < chips.length; i++) chips[i].classList.toggle('is-playing', i === shown);
  }
  function renderSeq(){
    _seqLastPlay = -2;                 // row is being rebuilt, so the cached class state is stale
    const row = $('#seqRow');
    if (!row) return;
    /* The row carries the ×N repeat, which every rhythm has — including the cross-rhythms, which can't
       join a multi-rhythm sequence but can still repeat their own figure. So it shows for anything with
       subdivisions; only Quarters (no partials at all, nothing to repeat) hides it. */
    const canSeq = seqIsPerBeat(subdivSel.value);
    if (isQuartersSubdiv()){ row.hidden = true; row.innerHTML = ''; return; }
    row.hidden = false;
    row.innerHTML = '';

    seqSteps.forEach((st, i) => {
      const chip = document.createElement('div');
      chip.className = 'seq-chip' + (i === seqSel ? ' is-sel' : '') + (isRunning && i === seqPlayIdx ? ' is-playing' : '');
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      const item = familyItems().find((o) => o.v === st.v);
      chip.title = (item ? item.label : st.v) + ' for ' + st.n + ' beat' + (st.n === 1 ? '' : 's');

      const ico = document.createElement('span');
      ico.className = 'seq-chip__icon';
      // same glyph builder the Subdivision button uses, so a chip looks like what it will sound like
      try { const g = subdivGlyph(st.v); if (g) ico.appendChild(g); else ico.textContent = st.v; }
      catch (e) { ico.textContent = st.v; }
      chip.appendChild(ico);

      // beats this step lasts — click to cycle 1..SEQ_BEATS_MAX
      const n = document.createElement('span');
      n.className = 'seq-chip__n';
      n.textContent = '×' + st.n;
      chip.appendChild(n);

      if (seqSteps.length > 1){
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'seq-chip__x'; x.textContent = '×';
        x.setAttribute('aria-label', 'Remove this step');
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          seqSteps.splice(i, 1);
          if (seqSel >= seqSteps.length) seqSel = seqSteps.length - 1;
          seqApply(); renderSeq(); alignToGrid(true);
        });
        chip.appendChild(x);
      }

      const pick = () => {
        if (i === seqSel){
          // re-tapping the selected chip cycles its length; the pills grow/shrink with it
          st.n = (st.n % SEQ_BEATS_MAX) + 1;
          seqApply();
        } else { seqCommit(); seqSel = i; seqApply(); }
        renderSeq();
      };
      chip.addEventListener('click', pick);
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); pick(); } });
      row.appendChild(chip);
    });

    const add = document.createElement('button');
    add.type = 'button'; add.className = 'seq-add';
    add.textContent = seqActive() ? '+ rhythm' : '+ add a 2nd rhythm';
    add.disabled = seqSteps.length >= SEQ_MAX;
    add.title = 'Add another rhythm after this one';
    add.addEventListener('click', () => {
      if (seqSteps.length >= SEQ_MAX) return;
      seqCommit();
      const copy = seqSteps[seqSel];
      seqSteps.splice(seqSel + 1, 0, { v: copy.v, n: 1, states: (copy.states || []).slice() });
      seqSel += 1;
      seqApply(); renderSeq(); alignToGrid(true);
    });
    row.appendChild(add);
  }

  /* ---------------- Icon-forward settings buttons ----------------
     Time Signature = a real stacked "N/D" numeral glyph (the glyph IS the value).
     Subdivision + Repeat get GENERATED icons driven by the actual current values
     (not hand-drawn per option) so every subdivision/repeat count renders distinctly. */
  // Time Signature icon = the REAL VexFlow time-signature glyph (same music font as the staff). Uses the
  // shared `timeSigGlyph()` builder (below). Wrapped in try/catch so the FIRST sync call during setup
  // (before the icon-helper state is initialized) no-ops; init() re-renders once everything exists.
  function updateTimeSigGlyph(trigger, text){
    const holder = trigger.querySelector('.tsIcon'); if (!holder) return;
    if (!window.RDMRender || !window.Vex) return;
    try { const svg = timeSigGlyph(text); if (svg) holder.replaceChildren(svg); }
    catch (e){ /* early setup call — init() re-renders */ }
  }

  // SUBDIVISIONS ARE PER METER FAMILY. A subdivision divides the FELT beat (beatInfo), and the same
  // clicks-per-beat means a different note VALUE per family (e.g. 3 clicks = an eighth-triplet on a quarter
  // beat, but the natural EIGHTHS on a dotted-quarter beat). So each family has its own option list.
  //   v     = the select value "clicks/beats" — the engine reads it as the ratio (clicks per beat)
  //   label = shown in the picker / drives nothing else
  //   icon  = {count, dur, dots, beam, tup} — the rhythm figure (dur drives beam count; tup={num,inSpaceOf})
  // Only the SIMPLE family carries the b>1 "Cross-Rhythms" (they auto-set a /4 meter, always simple).
  const SUBDIV_FAMILIES = {
    simple: { default:'1/1', groups: [
      { title:'Subdivisions', items: [
        { v:'1/1',  label:'Quarters',         icon:{count:1, dur:'q',  dots:0, beam:false, tup:null} },
        { v:'2/1',  label:'8th Notes',        icon:{count:2, dur:'8',  dots:0, beam:true,  tup:null} },
        { v:'3/1',  label:'Triplets',         icon:{count:3, dur:'8',  dots:0, beam:true,  tup:{num:3, inSpaceOf:2}} },
        { v:'4/1',  label:'16th Notes',       icon:{count:4, dur:'16', dots:0, beam:true,  tup:null} },
        { v:'5/1',  label:'5-lets',           icon:{count:5, dur:'16', dots:0, beam:true,  tup:{num:5, inSpaceOf:4}} },
        { v:'6/1',  label:'6-lets',           icon:{count:6, dur:'16', dots:0, beam:true,  tup:{num:6, inSpaceOf:4}} },
        { v:'7/1',  label:'7-lets',           icon:{count:7, dur:'16', dots:0, beam:true,  tup:{num:7, inSpaceOf:4}} },
        { v:'8/1',  label:'32nd Notes',       icon:{count:8, dur:'32', dots:0, beam:true,  tup:null} },
      ]},
      { title:'Cross-Rhythms', items: [
        /* Ordered SLOWEST -> FASTEST by actual click rate, i.e. the ratio `v` = clicks per beat
           (Anthony, 2026-07-26). The rate is what the ear hears, so the list now speeds up as you scroll
           it. Keep any new entry in rate order: the trailing comment on each line is its rate.
           (The Subdivisions group above is already 1,2,3,4,5,6,7,8 per beat.) */
        { v:'4/3',  label:'Dotted 8ths',      icon:{count:1, dur:'8',  dots:1, beam:false, tup:null} },                  // 1.33
        { v:'3/2',  label:'Quarter Triplets', icon:{count:3, dur:'q',  dots:0, beam:false, tup:{num:3, inSpaceOf:2}} },  // 1.50
        { v:'9/4',  label:'8th 9-lets',       icon:{count:9, dur:'8',  dots:0, beam:true,  tup:{num:9, inSpaceOf:8}} },  // 2.25
        { v:'5/2',  label:'8th 5-lets',       icon:{count:5, dur:'8',  dots:0, beam:true,  tup:{num:5, inSpaceOf:4}} },  // 2.50
        { v:'8/3',  label:'4:3s',             icon:{count:4, dur:'8',  dots:0, beam:true,  tup:{num:4, inSpaceOf:3}} },  // 2.67
        { v:'10/3', label:'5:3s',             icon:{count:5, dur:'8',  dots:0, beam:true,  tup:{num:5, inSpaceOf:3}} },  // 3.33
        { v:'7/2',  label:'8th 7-lets',       icon:{count:7, dur:'8',  dots:0, beam:true,  tup:{num:7, inSpaceOf:4}} },  // 3.50
        { v:'9/2',  label:'9-lets',           icon:{count:9, dur:'16', dots:0, beam:true,  tup:{num:9, inSpaceOf:8}} },  // 4.50
        /* 7:6 and 8:6: DISPLAY-only as 16ths (icon dur:'16', tup inSpaceOf:6). Audio is driven solely by
           `v`, left as-is, so playback is unchanged from the old 7:3 (Anthony, 2026-07-24). 8:6 is new:
           v='16/3' = 16 evenly-spaced clicks per 3 beats, drawn as 8 sixteenths over 6. */
        { v:'14/3', label:'7:6s',             icon:{count:7, dur:'16', dots:0, beam:true,  tup:{num:7, inSpaceOf:6}} },  // 4.67
        { v:'16/3', label:'8:6s',             icon:{count:8, dur:'16', dots:0, beam:true,  tup:{num:8, inSpaceOf:6}} },  // 5.33
      ]},
    ]},
    // compound beat = dotted quarter (3 eighths). 8th Notes (3/beat) is the natural feel + the default.
    compound: { default:'3/1', groups: [
      { title:'Subdivisions', items: [
        { v:'1/1',  label:'Dotted Quarter',   icon:{count:1, dur:'q',  dots:1, beam:false, tup:null} },
        { v:'2/1',  label:'Dotted 8ths',      icon:{count:2, dur:'8',  dots:1, beam:true,  tup:null} },
        { v:'3/1',  label:'8th Notes',        icon:{count:3, dur:'8',  dots:0, beam:true,  tup:null} },
        { v:'6/1',  label:'16th Notes',       icon:{count:6, dur:'16', dots:0, beam:true,  tup:null} },
      ]},
    ]},
    // asymmetric beat = eighth. 16th Notes (2/beat) is the default division.
    asymmetric: { default:'2/1', groups: [
      { title:'Subdivisions', items: [
        { v:'1/1',  label:'Eighth',           icon:{count:1, dur:'8',  dots:0, beam:false, tup:null} },
        { v:'2/1',  label:'16th Notes',       icon:{count:2, dur:'16', dots:0, beam:true,  tup:null} },
        { v:'3/1',  label:'Triplets',         icon:{count:3, dur:'16', dots:0, beam:true,  tup:{num:3, inSpaceOf:2}} },
        { v:'4/1',  label:'32nd Notes',       icon:{count:4, dur:'32', dots:0, beam:true,  tup:null} },
      ]},
    ]},
  };
  function familyGroups(){ return (SUBDIV_FAMILIES[beatInfo().family] || SUBDIV_FAMILIES.simple).groups; }
  function familyItems(){ return familyGroups().reduce((a, g) => a.concat(g.items), []); }
  // the icon spec for a value IN THE CURRENT family (values repeat across families with different meanings)
  // a custom-typed grid OVERRIDES the plain uniform icon for this exact value: reuses the base item's
  // own unit (dur) + tuplet ratio, swapping in the typed pattern instead of a uniform note run.
  // the icon for the value CURRENTLY selected is driven LIVE by subStates (0/1/2 per partial — edited by
  // clicking a sub-light or typing the Custom Grid field, both the same array); every OTHER value in the
  // picker list (ratios you haven't selected) just shows its plain uniform icon, since subStates only
  // has meaning for the active selection.
  function subdivSpec(value){
    const it = familyItems().find((o) => o.v === value);
    const baseIcon = it ? it.icon : SUBDIV_FAMILIES.simple.groups[0].items[0].icon;
    if (value === subdivSel.value && baseIcon.count > 0 && subStates.length === baseIcon.count){
      // pass the subdivision's own dot count (dotted-8ths etc.) so the live pattern icon keeps its dots
      // instead of collapsing to plain notes — the pattern path derives duration from note SPANS, which
      // has no dot for a single un-fused partial, so it needs the base dot supplied explicitly.
      return subStatesToPatternSpec(subStates, baseIcon.dur || 'q', baseIcon.tup, baseIcon.dots || 0);
    }
    return baseIcon;
  }
  // ---- Pattern-based subdivision icons ("grid" rhythms: rests, fused notes, accents) ----
  // Encoding: each character of `pattern` is one base partial. '1' = a note onset starts here.
  // '0' = either a REST (if no onset has occurred yet in this string — a leading run of zeros) or a
  // TIE/EXTEND of the immediately preceding onset (fusing it into one longer note). Because the note
  // branch below always consumes its own trailing zeros as it scans, the outer loop can only ever land
  // on a '0' that is a genuinely leading (un-tied) rest — there is no way to express a rest mid-pattern,
  // which matches the rule (a rest only ever sits at the front, never mid-pattern).
  // `unit` is the base partial's note value ('16', '8', or 'q'); a fused span of N partials is converted
  // to the correct standard duration (with a dot where a span is 1.5x/1.75x a ladder step) via
  // spanToDurDots — e.g. unit '16', span 3 → dotted-8th (2 partials + 1 more = 1.5x an 8th).
  const DUR_LADDER = { '16': ['16', '8', 'q', 'h', 'w'], '8': ['8', 'q', 'h', 'w'], 'q': ['q', 'h', 'w'] };
  const BEAMABLE = ['8', '16', '32', '64'];
  // returns null (not a fallback guess) when `span` base-partials DON'T reduce to one standard
  // notehead/rest — e.g. span=5 against a '16' unit isn't 4 (quarter) or any clean dotted step, so there
  // is no single glyph for it. Callers must use this to decide how far a run is safe to fuse, same as
  // you'd never hand-write "5 sixteenths" as one notehead — you'd write a quarter tied to a sixteenth.
  function spanToDurDots(span, unit){
    const ladder = DUR_LADDER[unit] || DUR_LADDER['16'];
    for (let i = 0; i < ladder.length; i++){
      const mult = Math.pow(2, i);
      if (span === mult) return { dur: ladder[i], dots: 0 };
      if (span === mult * 1.5) return { dur: ladder[i], dots: 1 };
      if (span === mult * 1.75) return { dur: ladder[i], dots: 2 };
    }
    return null;
  }
  // grows each run only while the NEXT size still maps to a single clean duration (spanToDurDots
  // non-null) — this is what turns "4 16th rests" into ONE quarter rest, but stops a run like "5 16th
  // rests" at the biggest clean piece (a quarter, span 4) and starts a FRESH token for the remaining 1,
  // instead of blindly consuming the whole run and guessing wrong. Applies identically to note-tie runs.
  function parsePatternTokens(pattern, accentSet, unit){
    const tokens = []; let i = 0, onsetIdx = 0;
    while (i < pattern.length){
      const isRest = pattern[i] === '0';
      let span = 1;
      while (i + span < pattern.length && pattern[i + span] === '0' && spanToDurDots(span + 1, unit)) span++;
      if (isRest){ tokens.push({ rest: true, span, accent: false }); }
      else { tokens.push({ rest: false, span, accent: accentSet.has(onsetIdx) }); onsetIdx++; }
      i += span;
    }
    return tokens;
  }
  function patternIconMeasure(spec){
    const accentSet = new Set(spec.accents || []);
    const tokens = parsePatternTokens(spec.pattern, accentSet, spec.unit);
    const events = tokens.map((t) => {
      const dd = spanToDurDots(t.span, spec.unit);   // always non-null: span was only ever grown to a valid size
      // a single un-fused base partial (span 1) keeps the subdivision's own dot (dotted-8ths, dotted-16ths);
      // a FUSED span (span>1) derives its own dots from the fused length via spanToDurDots instead.
      const dots = (t.span === 1) ? (spec.dots || 0) : dd.dots;
      return { step:'c', oct:5, head:'normal', dur: dd.dur, dots: dots, rest: t.rest, accent: t.accent };
    });
    const idx = events.map((_, i) => i);
    // beam contiguous runs of beamable, non-rest notes — breaks at rests AND at unbeamable (q/h/w) notes
    const beams = []; let run = [];
    const flush = () => { if (run.length >= 2) beams.push(run.slice()); run = []; };
    events.forEach((e, i) => { if (!e.rest && BEAMABLE.indexOf(e.dur) >= 0) run.push(i); else flush(); });
    flush();
    // Bracket rule (extends the uniform-run rule above): a rest anywhere breaks beam continuity, an
    // unbeamable note (quarter+) can't beam to its neighbors, and a single fused note spanning the whole
    // group has no beam at all — any of those need the bracket to show the tuplet grouping.
    const hasRest = tokens.some((t) => t.rest);
    const hasUnbeamable = events.some((e) => !e.rest && BEAMABLE.indexOf(e.dur) < 0);
    const beamableCount = events.filter((e) => !e.rest && BEAMABLE.indexOf(e.dur) >= 0).length;
    const bracket = hasRest || hasUnbeamable || beamableCount < 2;
    const tuplets = spec.tup ? [{ idx, num: spec.tup.num, inSpaceOf: spec.tup.inSpaceOf, bracket }] : [];
    return [{ events, beams, tuplets }];
  }
  function subdivIconMeasure(value){
    const spec = subdivSpec(value);
    if (spec.pattern) return patternIconMeasure(spec);
    const idx = Array.from({ length: spec.count }, (_, i) => i);
    const events = idx.map(() => ({ step:'c', oct:5, head:'normal', dur:spec.dur, dots:spec.dots, rest:false }));
    const beams = (spec.beam && spec.count > 1) ? [idx] : [];
    // Bracket rule: a filled tuplet needs NO bracket ONLY when a beam already spans the whole group (the
    // beam does the grouping). If the notes aren't beamed across the whole rhythm (e.g. quarter triplets —
    // quarters don't beam), it DOES need a bracket. Here beam:true = one beam over all notes → no bracket;
    // beam:false = unbeamed → bracket.
    const tuplets = spec.tup ? [{ idx: idx.slice(), num: spec.tup.num, inSpaceOf: spec.tup.inSpaceOf, bracket: !spec.beam }] : [];
    return [{ events, beams, tuplets }];
  }
  function timeSigMeasure(value){
    const p = String(value || '4/4').split('/');
    return [{ timeSig:[parseInt(p[0], 10) || 4, parseInt(p[1], 10) || 4], events:[], beams:[], tuplets:[] }];
  }
  // hidden offscreen stage the shared VexFlow renderer draws into (must be attached + not display:none so
  // getBBox works); we then lift the <svg> out, crop it tight to the ink, and return it.
  let _subIconStage = null;
  function subIconStage(){
    if (_subIconStage) return _subIconStage;
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;pointer-events:none;opacity:0;';
    (root.body || root).appendChild(d); _subIconStage = d; return d;
  }
  // Render an RDM measure list to a cropped, self-contained <svg> node via the shared renderer's bare mode.
  // CACHED by key (a value's glyph never changes) so the picker can cheaply build one glyph per option and
  // reuse the button's. Returns a FRESH detached svg (caller appends/replaces it); it's recolored by CSS at
  // the destination (button = white; picker option = currentColor so it tracks the row's text color).
  const _bareSvgCache = {};
  function bareSvg(key, measures, widthHint){
    if (!_bareSvgCache[key]){
      const stage = subIconStage();
      window.RDMRender.render({ measures: measures }, stage, { width: widthHint, zoom:1, bare:true });
      const svg = stage.querySelector('svg'); if (!svg) return null;
      const bb = svg.getBBox();
      if (bb && bb.width > 0 && bb.height > 0){
        const p = 2;
        svg.setAttribute('viewBox', `${bb.x - p} ${bb.y - p} ${bb.width + p*2} ${bb.height + p*2}`);
        // VexFlow sizes the svg via BOTH attributes AND inline style; clear both so the destination CSS
        // (height + width:auto) drives display size and the viewBox controls aspect. (Leaving the inline
        // style makes it render at the full staff height, ~138px, and stretched.)
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.style.width = ''; svg.style.height = '';
      }
      _bareSvgCache[key] = svg.outerHTML;
    }
    const tmp = document.createElement('div'); tmp.innerHTML = _bareSvgCache[key];
    return tmp.querySelector('svg');
  }
  // cache key includes the family: the same value renders a different rhythm per family
  // cache key includes the custom pattern (if any) — otherwise a later custom-grid edit for the SAME
  // value would keep returning the stale plain-icon SVG the cache already has for that key.
  function subdivGlyph(value){
    const spec = subdivSpec(value);
    const n = spec.count || (spec.pattern ? spec.pattern.length : 1);
    // cache key includes the live pattern + accents when this IS the active selection — otherwise a
    // sub-light click or grid edit would keep returning the stale plain-icon SVG cached under this value.
    const live = (value === subdivSel.value && spec.pattern) ? ':' + spec.pattern + ':' + (spec.accents || []).join(',') : '';
    const key = 'r:' + beatInfo().family + ':' + value + live;
    return bareSvg(key, subdivIconMeasure(value), 80 + n * 34);
  }
  function timeSigGlyph(value){ return bareSvg('t:' + value, timeSigMeasure(value), 120); }
  function updateSubdivIcon(trigger){
    const holder = trigger.querySelector('.subIcon'); if (!holder) return;
    if (!window.RDMRender || !window.Vex){ return; }
    // Wrapped so the FIRST sync call (during setup, before the icon-helper state below is initialized)
    // no-ops gracefully; init() re-runs it at the end once everything is defined.
    try { const svg = subdivGlyph((subdivSel && subdivSel.value) || '1/1'); if (svg) holder.replaceChildren(svg); }
    catch (e){ /* not ready yet — init() will re-render */ }
  }
  // tempo-box note glyph — the beat the BPM number counts (♩ simple / ♩. compound / ♪ asymmetric).
  // The augmentation dot is drawn as a CSS circle (.tempo-dot), NOT the literal "." from the glyph string:
  // a text period renders at wildly different sizes across mobile browsers (huge on Samsung Firefox/Chrome),
  // while a sized circle looks identical everywhere.
  const tempoNote = $('#tempoNote');
  function updateTempoGlyph(){
    if (!tempoNote) return;
    const g = beatInfo().glyph, di = g.indexOf('.');
    const note = di >= 0 ? g.slice(0, di) : g;
    tempoNote.innerHTML = note + (di >= 0 ? '<span class="tempo-dot"></span>' : '') + ' =';
  }

  // When the meter FAMILY changes, the subdivision option set changes (a subdivision divides the family's
  // beat). Rebuild the hidden <select>'s options to the new family and RESET to that family's default (the
  // old value's meaning no longer applies). No-ops within a family (4/4→3/4), so your subdivision is kept.
  let _prevFamily = null;
  function syncSubdivFamily(){
    const fam = beatInfo().family;
    if (fam === _prevFamily) return false;
    _prevFamily = fam;
    const items = familyItems();
    subdivSel.innerHTML = '';
    items.forEach((it) => { const o = document.createElement('option'); o.value = it.v; o.textContent = it.label; subdivSel.appendChild(o); });
    subdivSel.value = (SUBDIV_FAMILIES[fam] || SUBDIV_FAMILIES.simple).default;
    triggerLabel($('#subdivBtn'), items.find((it) => it.v === subdivSel.value)?.label || '');
    return true;
  }

  function updateMeta(){
    if (!metroMeta) return;
    const ts = getTS(), n = ts.n, d = ts.d;
    const sub = subdivSel.options[subdivSel.selectedIndex]?.text || 'Quarters';
    metroMeta.textContent = `${n}/${d} · ${sub}`;
  }

  /* ---------------- Main lights (0 off, 1 normal, 2 accent) ---------------- */
  let beatStates = [];
  // Natural accent groupings per meter, so compound/asymmetric meters FEEL right out of the box:
  // compound = accent every dotted-quarter beat (6/8 → 1·4); asymmetric = accent each group (7/8 → 1·3·5 = 2+2+3).
  // Accent groupings for the ASYMMETRIC meters (still counted in eighth beats): 5/8 = 3+2, 7/8 = 2+2+3.
  // Compound meters are now counted as dotted-quarter beats (6/8 = 2 beats), so they just accent the
  // downbeat via the default below — no special grouping needed.
  const METER_GROUPS = { '5/8':[0,3], '7/8':[0,2,4] };
  function defaultBeatStates(){
    const beats = beatInfo().beatsPerBar;
    const arr = new Array(beats).fill(1);
    const grp = METER_GROUPS[timeSigSel.value];
    if (grp) grp.forEach((i) => { if (i < beats) arr[i] = 2; });
    else if (beats > 0) arr[0] = 2;   // accent the downbeat by default
    return arr;
  }
  function applyBeatClass(el, state){
    el.classList.remove('is-accent', 'is-beat', 'is-muted', 'is-hit');
    el.classList.add(state === 2 ? 'is-accent' : state === 1 ? 'is-beat' : 'is-muted');
  }
  function renderLights(){
    if (!lightsWrap) return;
    lightsWrap.innerHTML = '';
    const beats = beatInfo().beatsPerBar;
    if (beatStates.length !== beats) beatStates = defaultBeatStates();

    const cw = lightsWrap.clientWidth || 700;
    const gap = 14, MIN_CELL = 30;
    const fitsSingleRow = (count) => count <= 0 || ((cw - gap * (count - 1)) / count) >= MIN_CELL;

    const mkLight = (i) => {
      const d = document.createElement('div');
      d.className = 'metro-light';
      applyBeatClass(d, beatStates[i]);
      d.title = 'Click: Normal → Accent → Off';
      d.addEventListener('click', () => {
        beatStates[i] = (beatStates[i] === 1) ? 2 : (beatStates[i] === 2 ? 0 : 1);
        applyBeatClass(d, beatStates[i]);
        renderNotation();
      });
      return d;
    };

    if (fitsSingleRow(beats)){
      const row = document.createElement('div');
      row.className = 'main-row';
      row.style.gridTemplateColumns = `repeat(${beats}, 1fr)`;
      for (let i = 0; i < beats; i++) row.appendChild(mkLight(i));
      lightsWrap.appendChild(row);
    } else {
      const maxPerRow = Math.max(1, Math.floor((cw + gap) / (MIN_CELL + gap)));
      let topCount = Math.min(Math.ceil(beats / 2), maxPerRow);
      const rowTop = document.createElement('div'); rowTop.className = 'main-row';
      rowTop.style.gridTemplateColumns = `repeat(${topCount}, 1fr)`;
      const rowBot = document.createElement('div'); rowBot.className = 'main-row';
      rowBot.style.gridTemplateColumns = `repeat(${beats - topCount}, 1fr)`;
      for (let i = 0; i < beats; i++) (i < topCount ? rowTop : rowBot).appendChild(mkLight(i));
      lightsWrap.appendChild(rowTop); lightsWrap.appendChild(rowBot);
    }
  }

  /* ---------------- Sub lights (0 off, 1 normal, 2 accent) ---------------- */
  let subStates = [];
  const defaultSubStates = (n) => new Array(Math.max(0, n | 0)).fill(1);
  // seed subStates (0 off/rest, 1 normal, 2 accent) from a pattern-variant's onset string, so the
  // ALREADY-existing per-partial click/sub-light/accent pipeline plays the exact rhythm the icon shows —
  // no scheduler changes needed. '1' → click (accented if its onset index is in spec.accents), '0' → no
  // click (true either way, whether it renders as a rest or a tied-extension of the previous note).
  // subStates (0 off, 1 normal, 2 accent) → a pattern spec for the icon builder: '0' stays '0' (rest or
  // tie, same as always), any non-zero state is an onset ('1'), and state 2 marks that onset's index in
  // `accents` so patternIconMeasure draws the `>` mark. This is the exact inverse of the mapping below.
  function subStatesToPatternSpec(states, unit, tup, dots){
    const accents = []; let onsetIdx = 0;
    const pattern = states.map((s) => {
      if (s === 0) return '0';
      if (s === 2) accents.push(onsetIdx);
      onsetIdx++; return '1';
    }).join('');
    return { pattern, unit, tup, accents, dots: dots || 0 };
  }
  // states for a newly-selected subdivision: restore what was last edited for this exact ratio, else flat
  function initialSubStates(n){
    const saved = savedStatesByValue[subdivSel.value];
    if (saved && saved.length === n) return saved.slice();
    return defaultSubStates(n);
  }
  function applySubClass(el, state){
    el.classList.remove('is-on', 'is-accent', 'is-muted', 'is-hit');
    el.classList.add(state === 2 ? 'is-accent' : state === 1 ? 'is-on' : 'is-muted');
  }
  function makeSubLight(idx){
    const d = document.createElement('div');
    d.className = 'sub-light';
    applySubClass(d, subStates[idx]);
    d.addEventListener('click', () => {
      subStates[idx] = (subStates[idx] === 1) ? 2 : (subStates[idx] === 2 ? 0 : 1);
      onSubStatesEdited();   // re-renders sub-lights (incl. this one), the button icon, and the grid field
    });
    return d;
  }
  /* Read the REAL gaps and the pill floor off a throwaway row wearing the same classes, so these numbers
     can never drift from the stylesheet the way a hand-kept copy would. */
  function subRowMetrics(cls){
    const row = document.createElement('div');
    row.className = cls;
    row.style.position = 'absolute'; row.style.visibility = 'hidden'; row.style.width = '100%';
    const grp = document.createElement('div'); grp.className = 'sub-group';
    row.appendChild(grp);
    subLightsWrap.appendChild(row);
    const rs = getComputedStyle(row), gs = getComputedStyle(grp);
    const out = {
      colGap: parseFloat(rs.columnGap) || 0,
      inner: parseFloat(gs.columnGap) || 0,
      pillMin: parseFloat(rs.getPropertyValue('--pill-min')) || 16,
    };
    subLightsWrap.removeChild(row);
    return out;
  }

  /* LAY THE PILLS OUT SO THEY FILL THE WIDTH.

     Anthony, 2026-08-07: "make these reach end to end... they should change size depending on how many
     there are, but they should try to reach end to end". A fixed pill width (the previous answer to "no
     sideways scrolling") can only ever be centred with slack down both sides, which is what he is
     pointing at. So the pills STRETCH: every row is a grid of equal columns at width 100%.

     What the floor buys is the WRAP POINT, not the drawn size: work out how many units fit if each were
     at --pill-min, then wrap rather than shrink below it. Lines are BALANCED (8 beats where 5 fit is
     4 + 4, not 5 + 3) so the block reads as beats in order, and EVERY row is given the same column count
     so a short last row keeps the same pill size instead of blowing up to fill the line on its own.

     Returns false when the box has no width yet — rendered while hidden, which mounted in a shadow root
     is the first few frames. The caller retries; silently doing nothing here is the trap that made
     fitRudCaps a no-op in the Sight-Reading Lab. */
  function layoutSubLights(){
    if (!subLightsWrap || subLightsWrap.hidden) return true;
    const L = subLightsWrap._layout;
    if (!L) return true;
    const W = subLightsWrap.clientWidth;
    if (!W) return false;

    // a multi-beat step wraps whole BEATS (a beat is never split across lines); a single beat wraps pills
    const multi = L.beats > 1;
    const cls = 'sub-row' + (multi ? ' sub-row--beats' : ' sub-row--single') + (L.dense ? ' sub-row--dense' : '');
    const g = subRowMetrics(cls);
    const unit = multi ? L.per : 1;                     // pills per wrapping unit
    const count = multi ? L.beats : L.total;            // how many units
    const unitMin = unit * g.pillMin + (unit - 1) * g.inner;

    const fit = Math.max(1, Math.floor((W + g.colGap) / (unitMin + g.colGap)));
    const lines = Math.max(1, Math.ceil(count / fit));
    const perLine = Math.ceil(count / lines);

    subLightsWrap.innerHTML = '';
    _subC = null; _subN = -1;                            // the cached node list just became stale
    for (let start = 0; start < count; start += perLine){
      const n = Math.min(perLine, count - start);
      const row = document.createElement('div');
      row.className = cls;
      // perLine columns on EVERY row, including a short last one, so a pill is the same size throughout
      row.style.gridTemplateColumns = 'repeat(' + perLine + ', 1fr)';
      for (let k = 0; k < n; k++){
        if (multi){
          const grp = document.createElement('div');
          grp.className = 'sub-group';
          grp.style.gridTemplateColumns = 'repeat(' + L.per + ', 1fr)';
          for (let q = 0; q < L.per; q++) grp.appendChild(makeSubLight((start + k) * L.per + q));
          row.appendChild(grp);
        } else {
          row.appendChild(makeSubLight(start + k));
        }
      }
      subLightsWrap.appendChild(row);
    }
    return true;
  }

  function renderSubLights(){
    if (!subLightsWrap) return;
    /* Draw the step the pills are VIEWING — the selection while stopped, the sounding step while
       playing. Everything below is derived from that step rather than from the picker, so the row is
       correct even when the playhead is on a different rhythm to the one selected for editing. */
    const vs = seqViewStep();
    const vp = vs ? seqPartsOf(vs.v) : null;
    const total = vs ? subsPerRep(vs.v) * Math.max(1, vs.n | 0) : 0;
    const viewIsQuarters = vp ? (vp.a === 1 && vp.b === 1) : isQuartersSubdiv();
    if (viewIsQuarters || total <= 0){
      subLightsWrap.hidden = true; subLightsWrap.innerHTML = ''; subStates = [];
      subLightsWrap._layout = null;    // or a resize would rebuild the pills we just took away
      _subC = null; _subN = -1;
      return;
    }
    subLightsWrap.hidden = false;
    // the pills ARE the viewed step's pattern; keep the step as the owner so an edit lands on it
    subStates = (vs.states && vs.states.length === total) ? vs.states.slice() : defaultSubStates(total);
    vs.states = subStates;
    /* A multi-beat step draws ONE GROUP PER BEAT, side by side with a visible gap between them, so 4
       beats of triplets read as 4 groups of 3 rather than an undifferentiated wall of 12 — you can see
       which beat you're accenting (Anthony, 2026-08-02).

       This function no longer builds the rows: it records WHAT to draw and layoutSubLights() decides how
       many fit per line and builds them, because that needs a measured width and this can be called
       before the block has one. */
    const per = subsPerRep(vs.v), beatsInStep = Math.max(1, Math.round(total / Math.max(1, per)));
    subLightsWrap._layout = {
      per: per,
      beats: beatsInStep,
      total: total,
      // dense = a lot of partials on the row; tighter gaps and a lower floor fit more per line
      dense: beatsInStep > 1 ? (per > 6) : (total > 6),
    };
    subLightsWrap.innerHTML = '';
    _subC = null; _subN = -1;      // the cached node list just became stale
    scheduleLayout();
  }

  /* Lay out after the browser has a width for us, and keep asking while it does not — mounted in a
     shadow root the first frames measure 0, exactly as recentreShell() has to cope with. The
     ResizeObserver then re-lays-out on every width change (window resize, the app's nav rail
     collapsing, a phone rotating). */
  scheduleLayout.tries = 0;
  function scheduleLayout(){
    scheduleLayout.tries = 0;
    requestAnimationFrame(function again(){
      if (layoutSubLights() || scheduleLayout.tries++ > 40) { recentreShell(); return; }
      setTimeout(function(){ requestAnimationFrame(again); }, 100);
    });
  }
  if (window.ResizeObserver && subLightsWrap){
    /* WIDTH ONLY. A re-layout changes how many lines the block wraps to, which changes the wrapper's
       HEIGHT, which would re-enter this callback and rebuild the pills again — convergent, but pointless
       work, and it would fight the playhead's is-hit classes while playing. Width is the only input
       layoutSubLights actually depends on. */
    let lastW = -1;
    const ro = new ResizeObserver(function(){
      const w = Math.round(subLightsWrap.clientWidth);
      if (w === lastW) return;
      lastW = w;
      layoutSubLights();
      recentreShell();
    });
    ro.observe(subLightsWrap);
    (ctx.disposables || []).push(function(){ ro.disconnect(); });
  }

  /* The lights flash on EVERY click, so at 32nd notes these two run ~30 times a second for as long as the
     metronome is on. They used to re-query the DOM and allocate a fresh setTimeout each time: roughly
     100,000 timers an hour, each one a callback the engine has to keep and fire, on the same thread that
     feeds Web Audio its click times. That is a slow accumulation of work behind a metronome that has to
     stay perfectly even, and it is part of why a long run started to stutter (Anthony's student,
     2026-07-26 — on `beep`, so this is not the wood synthesis path).

     Now: the node lists are cached (re-read only when the row is actually rebuilt, detected by child
     count, so no invalidation plumbing to get wrong), and expiry is handled by ONE shared sweeper instead
     of a timer per flash. */
  let _lightsC = null, _lightsN = -1, _subC = null, _subN = -1;
  function metroLights(){
    const n = lightsWrap ? lightsWrap.childElementCount : 0;
    if (!_lightsC || _lightsN !== n){ _lightsC = $$('.metro-light', lightsWrap); _lightsN = n; }
    return _lightsC;
  }
  function subLights(){
    const n = subLightsWrap ? subLightsWrap.childElementCount : 0;
    if (!_subC || _subN !== n){ _subC = $$('.sub-light', subLightsWrap); _subN = n; }
    return _subC;
  }
  const _hits = [];            // {el, until} — cleared by the single sweeper below
  let _hitRaf = null;
  function sweepHits(){
    const now = performance.now();
    for (let i = _hits.length - 1; i >= 0; i--){
      if (_hits[i].until <= now){ _hits[i].el.classList.remove('is-hit'); _hits.splice(i, 1); }
    }
    _hitRaf = _hits.length ? requestAnimationFrame(sweepHits) : null;
  }
  function flash(el){
    if (!el) return;
    el.classList.add('is-hit');
    const now = performance.now();
    for (let i = 0; i < _hits.length; i++) if (_hits[i].el === el){ _hits[i].until = now + 70; return; }
    _hits.push({ el, until: now + 70 });
    if (!_hitRaf) _hitRaf = requestAnimationFrame(sweepHits);
  }
  function pulseLight(beatIndex){ flash(metroLights()[beatIndex]); }
  function pulseSubLightAt(i){
    if (!subLightsWrap || subLightsWrap.hidden) return;
    const lights = subLights();
    if (!lights.length) return;
    const idx = ((i % lights.length) + lights.length) % lights.length;
    if (subStates[idx] !== 0) flash(lights[idx]);
  }
  function clearHitClasses(){
    _hits.length = 0;   // drop anything the sweeper still owes, so it cannot re-clear a stale element
    $$('.metro-light', lightsWrap).forEach(el => el.classList.remove('is-hit'));
    if (subLightsWrap) $$('.sub-light', subLightsWrap).forEach(el => el.classList.remove('is-hit'));
  }

  /* ---------------- Live notation (shared VexFlow renderer — matches the Playalongs sheet) ----------------
     Builds the current bar(s) as an RDM score and draws it with the SAME renderer the Playalongs tool uses
     (percussion clef, staff, time signature, end barline, note look, accents ABOVE). Muted partials are
     consolidated into the previous note's duration where that makes a clean note (16th + muted 16th -> 8th);
     a leading / un-mergeable gap becomes a rest. When the sub-accent pattern (Repeat) doesn't divide the bar
     (e.g. a 3-beat repeat in 4/4), it renders LCM(repeat, beats)/beats MEASURES so a full cycle is shown. A
     moving playhead sweeps the notes during playback, like Playalongs. */
  const notationSvg = $('#notationSvg'), notationTempo = $('#notationTempo'), notationCursor = $('#notationCursor');
  const DUR_MAP = { 4:['w',0], 3:['h',1], 2:['h',0], 1.5:['q',1], 1:['q',0], 0.75:['8',1], 0.875:['8',2],
                    0.5:['8',0], 0.375:['16',1], 0.4375:['16',2], 0.25:['16',0], 0.1875:['32',1], 0.125:['32',0], 0.0625:['64',0] };
  const QVAL = { w:4, h:2, q:1, '8':0.5, '16':0.25, '32':0.125, '64':0.0625 };
  function durForQuarters(q){ const e = DUR_MAP[+q.toFixed(4)]; return e ? { dur:e[0], dots:e[1] } : null; }
  function quartersOf(dur, dots){ let v = QVAL[dur] || 1; if (dots === 1) v *= 1.5; else if (dots === 2) v *= 1.75; return v; }
  const isPow2 = (k) => k > 0 && (k & (k - 1)) === 0;
  const gcd = (x, y) => y ? gcd(y, x % y) : x;
  const lcm = (x, y) => (x && y) ? Math.abs(x * y) / gcd(x, y) : Math.max(x, y);
  function updateTempoMark(){ if (notationTempo) notationTempo.textContent = '♩ = ' + getBpm(); }
  // keep the ♩=N mark above the FIRST note even when the (narrower) notation is centered in the card
  function positionTempoMark(out, renderW, availW){
    if (!notationTempo) return;
    let firstX = 60;
    if (out && out.notes && out.notes[0]){ const c = out.notes[0][0]; if (c) firstX = c.x; }
    const offset = Math.max(0, (availW - renderW) / 2);
    notationTempo.style.paddingLeft = Math.round(offset + firstX - 8) + 'px';
  }

  // cursor state (anchors: {beat, x, top, bot} across the whole rendered cycle)
  let _cursorAnchors = [], _cursorCycle = 1, _cursorOutW = 640, _cursorRaf = null;

  function renderNotation(){
    if (!notationSvg || !window.RDMRender || !window.Vex) return;
    const ts = getTS(), n = ts.n, beatQ = 4 / ts.d;
    const parts = getSubdivParts();
    const a = Math.max(1, Math.floor(parts.a)), b = Math.max(1, Math.floor(parts.b));
    const mult = 1;   // Repeat feature removed — a single cycle
    const quarters = isQuartersSubdiv();
    const mkNote = (o) => Object.assign({ step:'c', oct:5, head:'normal' }, o);
    function beamRunIdx(events, beams, idxs){
      let run = []; const flush = () => { if (run.length >= 2) beams.push(run.slice()); run = []; };
      idxs.forEach((ix) => { const e = events[ix]; if (!e.rest && ['8','16','32','64'].indexOf(e.dur) >= 0) run.push(ix); else flush(); });
      flush();
    }
    function consolidate(slots, k){
      const out = []; let i = 0; const spanDur = (span) => durForQuarters(span / k * beatQ);
      while (i < k){
        const muted = slots[i] === 0, accent = slots[i] === 2;
        let span = 1; while (i + span < k && slots[i + span] === 0 && spanDur(span + 1)) span++;
        let dd = spanDur(span); if (!dd){ dd = spanDur(1); span = 1; }
        out.push({ rest: muted, accent: accent, dur: dd.dur, dots: dd.dots }); i += span;
      }
      return out;
    }
    // notes for one beat (global index): main accents repeat every bar, sub pattern every `mult` beats
    function beatNotes(gb){
      const beatInBar = ((gb % n) + n) % n;
      if (quarters){ const st = beatStates[beatInBar], dd = durForQuarters(beatQ) || { dur:'q', dots:0 }; return { notes:[{ dur:dd.dur, dots:dd.dots, rest:st===0, accent:st===2 }] }; }
      const g = ((gb % mult) + mult) % mult;
      const slots = subStates.slice(g * a, (g + 1) * a).map((v) => v == null ? 1 : v);
      if (beatStates[beatInBar] === 2 && slots.length) slots[0] = 2;
      if (isPow2(a)) return { notes: consolidate(slots, a) };
      const std = Math.pow(2, Math.floor(Math.log2(a))), base = durForQuarters(beatQ / std) || { dur:'16', dots:0 };
      return { notes: slots.map((s) => ({ dur:base.dur, dots:base.dots, rest:s===0, accent:s===2 })), tuplet:{ num:a, inSpaceOf:std } };
    }

    const measures = [], beatOf = []; let cyc = 0;

    if (!quarters && b > 1){
      // time sig is now b/4 (auto-set): render `mult` measures, each `a` notes FILLING the b-beat bar.
      const dPer = durForQuarters(b * beatQ / a);                       // clean per-note value (dotted-8th, dotted-16th…)?
      const std = Math.pow(2, Math.floor(Math.log2(a)));
      const base = dPer || durForQuarters(b * beatQ / std) || { dur:'16', dots:0 };
      const adv = quartersOf(base.dur, base.dots) / beatQ * (dPer ? 1 : std / a);   // ACTUAL beats per note (tuplet-scaled)
      for (let g = 0; g < mult; g++){
        const events = [], beams = [], tuplets = [], eb = [];
        const slots = subStates.slice(g * a, (g + 1) * a).map((v) => v == null ? 1 : v);
        const idxs = [];
        for (let j = 0; j < a; j++){ const ix = events.length; events.push(mkNote({ dur:base.dur, dots:base.dots, rest:slots[j]===0, accent:slots[j]===2 })); idxs.push(ix); eb.push(cyc); cyc += adv; }
        beamRunIdx(events, beams, idxs);
        if (!dPer) tuplets.push({ idx:idxs.slice(), num:a, inSpaceOf:std, bracket:true });   // bracket only when it isn't a clean dotted value
        measures.push({ timeSig: g === 0 ? [ts.n, ts.d] : undefined, events:events, beams:beams, tuplets:tuplets }); beatOf.push(eb);
      }
    } else {
      // quarters or per-beat subdivision: render a FULL CYCLE = LCM(repeat, beats)/beats measures
      const cycleBeats = quarters ? n : lcm(mult, n);
      const numMeasures = Math.max(1, Math.round(cycleBeats / n));
      for (let mi = 0; mi < numMeasures; mi++){
        const events = [], beams = [], tuplets = [], eb = [];
        for (let i = 0; i < n; i++){
          const built = beatNotes(mi * n + i), gi = [];
          const ratio = built.tuplet ? built.tuplet.inSpaceOf / built.tuplet.num : 1;   // tuplet notes advance by ACTUAL beats
          built.notes.forEach((nt) => { const ix = events.length; events.push(mkNote({ dur:nt.dur, dots:nt.dots, rest:nt.rest, accent:nt.accent })); gi.push(ix); eb.push(cyc); cyc += quartersOf(nt.dur, nt.dots) / beatQ * ratio; });
          beamRunIdx(events, beams, gi);
          if (built.tuplet) tuplets.push({ idx:gi.slice(), num:built.tuplet.num, inSpaceOf:built.tuplet.inSpaceOf, bracket:true });
        }
        measures.push({ timeSig: mi === 0 ? [ts.n, ts.d] : undefined, events:events, beams:beams, tuplets:tuplets }); beatOf.push(eb);
      }
    }

    const availW = notationSvg.clientWidth || 640;
    // Render at a CONTENT-appropriate width (normal note spacing), capped at the available width — so short
    // rhythms render at a normal size and get centered, instead of being stretched across the whole card.
    let totalNotes = 0; measures.forEach((m) => totalNotes += m.events.length);
    const estW = 96 + measures.length * 32 + totalNotes * 52;
    const renderW = Math.min(availW, Math.max(240, estW));
    let out = null;
    // NOTE: no fillTrailing — VexFlow's natural spacing makes the trailing gap equal the inter-note gap
    // (even all around); the content-based renderW above keeps the whole thing from stretching too wide.
    try { out = window.RDMRender.render({ measures: measures }, notationSvg, { width:renderW, zoom:1 }); } catch (e) { /* keep last good render */ }
    updateTempoMark();
    positionTempoMark(out, renderW, availW);

    // rebuild cursor anchors from the render geometry (out.notes[mi][ei] = {x, cTop, cBot})
    _cursorAnchors = []; _cursorCycle = cyc || 1; _cursorOutW = (out && out.width) || w;
    if (out && out.notes){
      const ez = (out && out.effZoom) || 1;   // cBot = (bottomStaffLine + 26)*effZoom, so subtract 26*ez to land ON the line
      for (let mi = 0; mi < measures.length; mi++){
        const row = out.notes[mi] || {}, eb = beatOf[mi];
        // top = accent zone (cTop); bottom = the BOTTOM STAFF LINE (the bottom of the F space) — so the
        // cursor covers accents + the whole staff, and stops right at the last staff line.
        for (let ei = 0; ei < eb.length; ei++){ const c = row[ei]; if (c) _cursorAnchors.push({ beat:eb[ei], x:c.x, top:(c.cTop != null ? c.cTop : c.yTop), bot:(c.cBot != null ? c.cBot - 26 * ez : c.yBot), span:(c.yBot - c.yTop) || 70 }); }
      }
      if (_cursorAnchors.length){
        const last = _cursorAnchors[_cursorAnchors.length - 1], prev = _cursorAnchors[_cursorAnchors.length - 2] || last;
        _cursorAnchors.push({ beat:cyc, x:last.x + Math.max(18, last.x - prev.x), top:last.top, bot:last.bot, span:last.span });
      }
    }
  }

  /* ---------------- Notation playhead (sweeps the notes while playing) ---------------- */
  function hideCursor(){ if (notationCursor) notationCursor.style.opacity = '0'; }
  function tickCursor(){
    if (!isRunning || !audioCtx || !notationCursor || !_cursorAnchors.length){ hideCursor(); _cursorRaf = null; return; }
    const svg = notationSvg.querySelector('svg');
    if (svg){
      const rect = svg.getBoundingClientRect(), scale = _cursorOutW ? rect.width / _cursorOutW : 1;
      const spb = secondsPerBeat();
      let pos = (audioCtx.currentTime - gridT0) / spb; if (!(pos >= 0)) pos = 0;
      const c = _cursorCycle > 0 ? (pos % _cursorCycle) : 0;
      const A = _cursorAnchors; let i = 0; while (i < A.length - 1 && A[i + 1].beat <= c) i++;
      const a0 = A[i], a1 = A[Math.min(i + 1, A.length - 1)];
      const t = (a1.beat > a0.beat) ? Math.max(0, Math.min(1, (c - a0.beat) / (a1.beat - a0.beat))) : 0;
      const x = (a0.x + (a1.x - a0.x) * t) * scale, top = a0.top * scale, bot = a0.bot * scale;
      const w = Math.max(11, (a0.span || 70) * 0.2) * scale;   // same width formula as the Playalongs cursor
      const wrap = notationCursor.parentElement.getBoundingClientRect();
      const svgLeft = rect.left - wrap.left, svgRight = svgLeft + rect.width;
      let left = svgLeft + x - w / 2;
      left = Math.max(svgLeft, Math.min(left, svgRight - w));   // never let the cursor leave the staff / card
      notationCursor.style.left = left + 'px';
      notationCursor.style.top = ((rect.top - wrap.top) + top) + 'px';
      notationCursor.style.width = w + 'px';
      notationCursor.style.height = Math.max(10, bot - top) + 'px';
      notationCursor.style.opacity = '1';
    }
    _cursorRaf = requestAnimationFrame(tickCursor);
  }
  function startCursor(){ if (!_cursorRaf) _cursorRaf = requestAnimationFrame(tickCursor); }
  function stopCursor(){ if (_cursorRaf){ cancelAnimationFrame(_cursorRaf); _cursorRaf = null; } hideCursor(); }

  if ('ResizeObserver' in window && lightsWrap){
    new ResizeObserver(() => renderLights()).observe(lightsWrap);
  } else {
    window.addEventListener('resize', () => { renderLights(); renderSubLights(); });
  }

  /* ---------------- Slider fills ---------------- */
  function updateFill(rangeEl, fillEl){
    if (!rangeEl || !fillEl) return;
    const min = parseFloat(rangeEl.min || '0'), max = parseFloat(rangeEl.max || '100'), val = parseFloat(rangeEl.value || '0');
    fillEl.style.width = (((val - min) * 100) / (max - min || 1)) + '%';
  }

  /* ---------------- Audio ---------------- */
  let audioCtx = null, master = null, __audioUnlocked = false;
  let sampleCache = {};

  function ensureCtx(){
    if (audioCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx({ latencyHint: 'interactive' });
    } catch (_) { return; }
    master = audioCtx.createGain();
    master.gain.setValueAtTime(1.0, audioCtx.currentTime);
    master.connect(audioCtx.destination);
  }

  function renderWaveSample(freq, shape, dur, sr){
    const len = Math.max(1, Math.floor(dur * sr));
    const data = new Float32Array(len);
    const twoPI = Math.PI * 2;
    const attack = Math.max(1, Math.floor(0.0008 * sr));
    const tConst = dur * 0.22;
    for (let i = 0; i < len; i++){
      const t = i / sr, phase = twoPI * freq * t;
      let x;
      switch (shape){
        case 'square':   x = Math.sign(Math.sin(phase)) || 1; break;
        case 'triangle': x = 2 / Math.PI * Math.asin(Math.sin(phase)); break;
        case 'sawtooth': { const frac = (freq * t) % 1; x = 2 * frac - 1; break; }
        default:         x = Math.sin(phase);
      }
      data[i] = x * (i < attack ? (i / attack) : Math.exp(-t / tConst));
    }
    const buf = audioCtx.createBuffer(1, len, sr);
    buf.copyToChannel(data, 0);
    return buf;
  }

  const presets = {
    beep:   { accent:[1760,'sine',0.020], beat:[880,'sine',0.018], sub:[440,'sine',0.012], subAccent:[660,'triangle',0.014] },
    click:  { accent:[3000,'triangle',0.008], beat:[2500,'square',0.006], sub:[2000,'square',0.004], subAccent:[2200,'sawtooth',0.006] },
    wood:   { accent:['wood',null,0.028], beat:['wood',null,0.022], sub:['wood',null,0.016], subAccent:['wood-hi',null,0.018] },
    clave:  { accent:['clave',null,0.028], beat:['clave',null,0.020], sub:['clave',null,0.014], subAccent:['clave-soft',null,0.016] },
    analog: { accent:[1200,'sawtooth',0.020], beat:[900,'sawtooth',0.016], sub:[700,'sawtooth',0.012], subAccent:[1000,'square',0.014] },
  };
  const kindScale = (k) => k === 'accent' ? 1.0 : k === 'beat' ? 0.8 : 0.6;

  /* Bake the WOOD click once instead of per hit.
     This was the stutter (Anthony's student, 2026-07-26: 32nd-note subdivisions running for a long time
     would hitch). wood/clave were deliberately left out of the sample cache as "procedural", so every
     single click ran a per-sample JS loop of Math.random + Math.exp to fill a brand new AudioBuffer, then
     threw away that buffer plus a BufferSource, a BiquadFilter and two gains. At 32nds that is roughly 30
     clicks a second: tens of thousands of samples synthesised per second on the main thread and a
     constant stream of garbage. It plays clean until the collector runs, and then it hitches. Baking it
     turns each click into one already-rendered buffer.
     The noise is random, but a fixed 16ms burst is indistinguishable from a fresh one by ear, and the
     bandpass is folded in at bake time. */
  function renderWoodSample(hi, dur, sr){
    const n = Math.max(1, Math.floor(sr * dur));
    const buf = audioCtx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    // one-pole bandpass around the same centre the live filter used, applied as we synthesise
    const f = (hi ? 2200 : 1550) / sr, q = hi ? 4.0 : 3.2;
    let lp = 0, bp = 0;
    const fc = 2 * Math.sin(Math.PI * f), qc = 1 / q;
    for (let i = 0; i < n; i++){
      const env = Math.exp(-i / (n * 0.22));
      const inp = (Math.random() * 2 - 1) * env;
      const hp = inp - lp - qc * bp;
      bp += fc * hp;
      lp += fc * bp;
      d[i] = bp;
    }
    // normalise so the baked click matches the old live one in level
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (peak > 0.0001) { const g = 0.9 / peak; for (let i = 0; i < n; i++) d[i] *= g; }
    return buf;
  }

  function ensurePresetSamples(){
    if (!audioCtx) return;
    const chosen = (soundSel?.value || 'beep');
    if (!/^(beep|click|analog|wood)$/.test(chosen)) return;   // clave is still built live (2 oscillators)
    const sr = audioCtx.sampleRate || 48000;
    if (sampleCache[chosen] && sampleCache[chosen].sr === sr) return;
    const p = presets[chosen] || presets.beep, out = { sr };
    ['accent', 'beat', 'sub', 'subAccent'].forEach(k => {
      const [freq, shape, dur] = p[k] || p.beat;
      const boost = (k === 'accent' || k === 'beat') ? 1.15 : 1.1;
      out[k] = (freq === 'wood' || freq === 'wood-hi')
        ? renderWoodSample(freq === 'wood-hi', dur * boost, sr)
        : renderWaveSample(freq, shape || 'sine', dur * boost, sr);
    });
    sampleCache[chosen] = out;
  }

  function gestureUnlock(){
    if (__audioUnlocked) return;
    ensureCtx();
    if (!audioCtx) return;
    try { audioCtx.resume && audioCtx.resume(); } catch {}
    try {
      const b = audioCtx.createBuffer(1, 1, 22050);
      const s = audioCtx.createBufferSource(); s.buffer = b; s.connect(master); s.start(0);
    } catch {}
    ensurePresetSamples();
    __audioUnlocked = true;
  }

  // === Volume state (Beat/Sub) — log curve 0–100% → -60..0 dB ===
  let mainVol = 1.0, subVol = 0.8;

  /* GLOBAL accent/tap balance from Settings > Sound (Anthony, 2026-07-23). The app's Sound panel writes
     `rdm.dynamics = {tap, accent}` as multipliers around 1.0 (default 1,1; range ~0.5..1.5). The
     metronome has no volume control of its own, so it reads that same setting and scales its ACCENTED
     clicks by `accent` and its normal + subdivision clicks by `tap`. At the default it is a no-op, so
     the click sounds exactly as before until someone moves those sliders. Refreshed at each play. */
  let _dyn = { tap: 1, accent: 1 };
  function refreshDyn(){
    try {
      const d = JSON.parse(localStorage.getItem('rdm.dynamics') || 'null');
      if (d) _dyn = { tap: (+d.tap > 0 ? +d.tap : 1), accent: (+d.accent > 0 ? +d.accent : 1) };
    } catch {}
  }
  refreshDyn();
  // pick up a change made in another tab/window immediately
  try { window.addEventListener('storage', (e) => { if (e.key === 'rdm.dynamics') refreshDyn(); }); } catch {}
  function sliderToLinear(v){
    const t = Math.max(0, Math.min(100, isFinite(Number(v)) ? Number(v) : 0)) / 100;
    if (t <= 0) return 0;
    const MIN_DB = -60;
    return Math.pow(10, (MIN_DB + (0 - MIN_DB) * t) / 20);
  }

  /* `target` (2026-07-30): optional { ctx, master } override for the audio graph. Omitted = the live
     module-level audioCtx/master, exactly as before — the normal running metronome is byte-for-byte
     unchanged. Background rendering passes its OWN OfflineAudioContext + gain node here instead of the
     live `audioCtx`/`master` themselves ever being swapped out from under the scheduler mid-tick, which
     is what broke production the first time this was built: schedule()'s while-loop reads the module
     `audioCtx` fresh on every pass, so repointing that variable while it was running corrupted a live
     session's timing. With `target`, the module's own audioCtx/master are never touched at all. */
  /* Click log for dev/metro-sequence-test.js. Off unless a test turns it on, and it only pushes to an
     array — the scheduler is the one thing in here that must not be slowed down, and the whole point
     of the test is to check the times this REAL function is handed, not a reimplementation of them. */
  let _clickLog = null;
  function trigger(time, kind, gainMul = 1, target){
    if (_clickLog) _clickLog.push({ t: time, kind: kind, gain: gainMul });
    const c = target ? target.ctx : audioCtx, m = target ? target.master : master;
    const chosen = (soundSel?.value || 'beep');
    const p = presets[chosen] || presets.beep;
    const spec = p[kind] || (kind === 'subAccent' ? p.sub : null) || p.beat;
    const [freq, shape, dur] = spec;
    if (!c || !m) return;

    const v = c.createGain();
    const groupVol = (kind === 'accent' || kind === 'beat') ? mainVol : subVol;
    // accented hits (main accent + subdivision accent) take the accent multiplier; everything else the tap one
    const dynMul = (kind === 'accent' || kind === 'subAccent') ? _dyn.accent : _dyn.tap;
    v.gain.setValueAtTime(gainMul * groupVol * kindScale(kind === 'subAccent' ? 'sub' : kind) * dynMul, time);
    v.connect(m);

    /* Release every node the moment it has finished sounding. Nothing here used to be disconnected, so a
       long run at fast subdivisions left thousands of dead gains still wired into master, waiting on the
       collector. Dropping them as they finish keeps the graph the same size at minute 60 as at minute 1.
       (Anthony, 2026-07-26) */
    const release = (src) => { src.onended = () => { try { src.disconnect(); v.disconnect(); } catch {} }; };

    // sample banks are plain decoded AudioBuffer data (no context reference), so reusing the LIVE bank
    // against an offline context's own createBufferSource is safe and correct — no re-decode needed.
    const bank = sampleCache[chosen];
    if (bank && bank[kind] instanceof AudioBuffer){
      const src = c.createBufferSource(); src.buffer = bank[kind]; src.connect(v); src.start(time); release(src); return;
    }
    if (freq === 'wood' || freq === 'wood-hi'){
      const n = Math.max(1, Math.floor(c.sampleRate * dur));
      const buffer = c.createBuffer(1, n, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.22));
      const src = c.createBufferSource(); src.buffer = buffer;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = (freq === 'wood-hi') ? 2200 : 1550; bp.Q.value = (freq === 'wood-hi') ? 4.0 : 3.2;
      src.connect(bp).connect(v); src.start(time);
      src.onended = () => { try { src.disconnect(); bp.disconnect(); v.disconnect(); } catch {} };
      return;
    }
    if (freq === 'clave' || freq === 'clave-soft'){
      const o1 = c.createOscillator(), o2 = c.createOscillator();
      if (freq === 'clave'){ o1.type = 'square'; o1.frequency.setValueAtTime(2350, time); o2.type = 'triangle'; o2.frequency.setValueAtTime(1180, time); }
      else { o1.type = 'triangle'; o1.frequency.setValueAtTime(2050, time); o2.type = 'sine'; o2.frequency.setValueAtTime(980, time); }
      const g = c.createGain();
      g.gain.setValueAtTime(1.0, time); g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
      o1.connect(g); o2.connect(g); g.connect(v);
      o1.start(time); o2.start(time); o1.stop(time + dur); o2.stop(time + dur);
      o2.onended = () => { try { o1.disconnect(); o2.disconnect(); g.disconnect(); v.disconnect(); } catch {} };
      return;
    }
    const osc = c.createOscillator(), env = c.createGain();
    osc.type = shape || 'sine'; osc.frequency.setValueAtTime(freq, time);
    env.gain.setValueAtTime(1.0, time); env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(env).connect(v); osc.start(time); osc.stop(time + dur);
    osc.onended = () => { try { osc.disconnect(); env.disconnect(); v.disconnect(); } catch {} };
  }

  /* ---------------- Scheduler (sample-accurate lookahead) ---------------- */
  let isRunning = false, currentBeatInBar = 0, beatCounter = 0, subCounter = 0;
  let nextBeatTime = 0, nextSubTime = 0, scheduleTimer = null, gridT0 = 0;
  const lookaheadMs = 25, scheduleAheadTime = 0.12;

  function secondsPerBeat(){
    // BPM now counts the FELT beat (♩ in simple, ♩. in compound, ♪ in asymmetric) — one beat = 60/bpm.
    // (Was `60/bpm * 4/den`, which made BPM always mean quarter-notes regardless of meter.)
    const bpm = getBpm();
    return bpm > 0 ? 60.0 / bpm : Infinity;
  }

  function alignToGrid(resetToFirst = false){
    if (!audioCtx) return;
    const now = audioCtx.currentTime, spb = secondsPerBeat(), ratio = getSubdivRatio();
    const beatsPerBar = beatInfo().beatsPerBar;

    if (resetToFirst){
      gridT0 = now + 0.05; beatCounter = 0; subCounter = 0; currentBeatInBar = 0;
      nextBeatTime = gridT0;
      nextSubTime = (ratio > EPS && !isQuartersSubdiv()) ? gridT0 : Infinity;
      clearHitClasses(); return;
    }
    const anchor = gridT0 || (now + 0.05);
    beatCounter = Math.max(0, Math.ceil((now - anchor - EPS) / spb));
    nextBeatTime = anchor + beatCounter * spb;
    currentBeatInBar = ((beatCounter % beatsPerBar) + beatsPerBar) % beatsPerBar;
    /* Subdivisions are laid inside each beat now (see schedule()), so there is no separate sub grid to
       re-align — landing on the right beat is enough. subCounter/nextSubTime are kept only so the
       old-shape state stays coherent for anything still reading them. */
    subCounter = 0; nextSubTime = Infinity;
    clearHitClasses();
  }

  /* PATTERN-DRIVEN. The subdivision stream is one flat, repeating list of clicks with BEAT OFFSETS
     (seqPattern()), and the beat pulse stays on its own plain integer grid. The two are interleaved
     here, emitting whichever comes next.

     Two earlier shapes both failed, and the comments are kept because the failures are easy to repeat:
       - two fixed grids (the original) could not change subdivision rate mid-sequence;
       - a beat-driven loop laying "round(a/b) clicks inside this beat" silently mangled every
         cross-rhythm into a per-beat subdivision, because a 4:3's figure spans 1.5 beats, not 1.
     Offsets in beats handle both: a figure may span a fraction of a beat and a step may end mid-beat,
     which is exactly what lets a cross-rhythm share a sequence with a per-beat rhythm. */
  function schedule(){
    const spb = secondsPerBeat();
    if (!isFinite(spb)) return;
    const beatsPerBar = beatInfo().beatsPerBar;
    const anchor = gridT0, horizon = audioCtx.currentTime + scheduleAheadTime;
    /* Query the sub-lights ONCE per pass, not once per scheduled click. This ran inside the loop below,
       so at 32nd notes it was a live DOM query ~30 times a second on the same thread that has to hand
       Web Audio its click times. The lights cannot change mid-pass anyway. (Anthony, 2026-07-26) */
    const lights = $$('.sub-light', subLightsWrap);
    const pat = seqPattern(), nClicks = pat.clicks.length;

    while (true){
      let beatTime = anchor + beatCounter * spb;
      if (beatTime < audioCtx.currentTime - EPS){
        beatCounter = Math.ceil((audioCtx.currentTime - anchor - EPS) / spb);
        beatTime = anchor + beatCounter * spb;
      }

      let subTime = Infinity, c = null;
      if (nClicks > 0){
        // a long stall (backgrounded tab) is skipped a whole cycle at a time, not click by click
        const cyc = Math.floor(subCounter / nClicks);
        const behind = Math.floor(((audioCtx.currentTime - anchor) / spb) / pat.cycleBeats);
        if (behind > cyc + 1){ subCounter = behind * nClicks; continue; }
        c = pat.clicks[((subCounter % nClicks) + nClicks) % nClicks];
        subTime = anchor + (Math.floor(subCounter / nClicks) * pat.cycleBeats + c.off) * spb;
        if (subTime < audioCtx.currentTime - EPS){ subCounter++; continue; }
      }
      if (Math.min(beatTime, subTime) >= horizon) break;

      const coincide = c && Math.abs(beatTime - subTime) <= EPS;
      if (coincide || beatTime < subTime){
        nextBeatTime = beatTime;
        currentBeatInBar = ((beatCounter % beatsPerBar) + beatsPerBar) % beatsPerBar;
        if (currentBeatInBar === 0) onDownbeat(Math.round(beatCounter / beatsPerBar), beatTime);   // downbeat → trainers
        const state = beatStates[currentBeatInBar] ?? 1;
        if (!_gapMuted && state !== 0){ trigger(beatTime, state === 2 ? 'accent' : 'beat'); pulseLight(currentBeatInBar); }
        beatCounter++;
        if (!coincide) continue;
      }
      if (c){
        if (c.si !== seqPlayIdx){
          seqPlayIdx = c.si;
          seqRefreshPlaying();
          seqRequestPills();     // the pill row follows the playhead; rebuilt off this thread
        }
        if (!_gapMuted && c.s !== 0){
          // a click sitting ON the beat rides softer, so it layers under the pulse instead of doubling it
          trigger(subTime, c.s === 2 ? 'subAccent' : 'sub', coincide ? 0.45 : 1);
          // only flash when the row on screen really is this step's pattern
          if (c.si === seqViewIdx() && lights.length === pat.pills) pulseSubLightAt(c.pi);
        }
        subCounter++;
      }
    }
  }

  async function robustResume(){
    ensureCtx();
    if (!audioCtx) return false;
    ensurePresetSamples();
    try { await audioCtx.resume(); } catch {}
    if (audioCtx.state !== 'running'){
      try { const b = audioCtx.createBuffer(1, 1, 22050); const s = audioCtx.createBufferSource(); s.buffer = b; s.connect(master); s.start(0); } catch {}
      try { await audioCtx.resume(); } catch {}
    }
    return audioCtx.state === 'running';
  }

  /* ---------------- Transport ---------------- */
  const ICON_PLAY = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>';
  const ICON_STOP = '<svg class="ico ico-fill" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>';
  async function start(){
    if (isRunning) return;
    refreshDyn();   // apply the latest Settings > Sound accent/tap balance
    const ok = await robustResume();
    if (!ok || getBpm() === 0) return;
    if (audioCtx && master){ try { master.gain.cancelScheduledValues(audioCtx.currentTime); master.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.01); } catch {} }
    isRunning = true;
    if (ctx.onAudio) ctx.onAudio(true);   // practice-time tracking
    playBtn.innerHTML = ICON_STOP; playBtn.setAttribute('aria-pressed', 'true');
    trainerResetForPlay();   // if the Tempo Trainer is on, jump to its Start tempo before the grid is laid
    gapResetForPlay();       // reset the Gap Trainer phase
    alignToGrid(true);
    schedule();
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = setInterval(schedule, lookaheadMs);
    startCursor();
  }
  function stop(){
    if (!isRunning) return;
    clearInterval(scheduleTimer); scheduleTimer = null; isRunning = false;
    if (ctx.onAudio) ctx.onAudio(false);   // practice-time tracking
    if (audioCtx && master){ try { master.gain.cancelScheduledValues(audioCtx.currentTime); master.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.005); } catch {} }
    playBtn.innerHTML = ICON_PLAY; playBtn.setAttribute('aria-pressed', 'false');
    alignToGrid(true);
    seqPlayIdx = -1; seqRefreshPlaying();   // drop the "sounding now" outline off the chips
    renderSubLights();                      // and hand the pills back to the SELECTED step for editing
    stopCursor();
  }
  const toggleTransport = () => { gestureUnlock(); isRunning ? stop() : start(); };
  playBtn.addEventListener('pointerdown', () => { gestureUnlock(); ensurePresetSamples(); }, { passive: true });
  playBtn.addEventListener('click', toggleTransport);

  /* ---------------- Tap tempo ---------------- */
  const TAP_RESET_MS = 1500;
  let tapTimes = [];
  function onTap(){
    const now = performance.now();
    if (tapTimes.length && (now - tapTimes[tapTimes.length - 1]) > TAP_RESET_MS) tapTimes = [];
    tapTimes.push(now);
    if (tapTimes.length > 4) tapTimes.shift();
    if (tapTimes.length === 4){
      const [t0, t1, t2, t3] = tapTimes;
      const ms = [t1 - t0, t2 - t1, t3 - t2].sort((a, b) => a - b)[1];
      setBpmUI(clampInt(Math.round(60000 / ms), 0, 300));
      if (isRunning) alignToGrid(false);
    }
  }
  tapBtn.addEventListener('click', onTap);

  /* ---------------- Tempo UI ---------------- */
  function setBpmUI(val){
    const v = clampInt(val, 0, 300);
    if (root.activeElement !== tempoSlider) tempoSlider.value = String(v);
    if (root.activeElement !== tempoInput) tempoInput.value = String(v);
    if (bpmBig) bpmBig.textContent = String(v);
    updateFill(tempoSlider, tempoFill);
    updateTempoMark();
  }
  // Pivot the grid around the next beat so a tempo change doesn't jump the timing
  function smoothTempoUpdate(){
    if (!isRunning) return;
    if (getBpm() === 0){ stop(); return; }
    const spb = secondsPerBeat();
    if (isFinite(spb) && nextBeatTime > 0) gridT0 = nextBeatTime - (beatCounter * spb);
  }
  function stepBpm(delta){
    setBpmUI(getBpm() + delta);
    if (isRunning) smoothTempoUpdate();
  }
  bpmDec1Btn.addEventListener('click', () => stepBpm(-1));
  bpmDec5Btn.addEventListener('click', () => stepBpm(-5));
  bpmInc1Btn.addEventListener('click', () => stepBpm(+1));
  bpmInc5Btn.addEventListener('click', () => stepBpm(+5));

  /* ---------------- Tempo Trainer ---------------- */
  // Ramps the tempo by a SIGNED step every N bars (+ speeds up, − slows down) from Start toward Target,
  // then holds. Runs off the scheduler's bar boundaries so the change lands on a downbeat.
  const ttToggle = $('#ttToggle'), ttBody = $('#ttBody'), ttStatus = $('#ttStatus'), ttExpand = $('#ttExpand');
  const ttStart = $('#ttStart'), ttTarget = $('#ttTarget'), ttStep = $('#ttStep'), ttEvery = $('#ttEvery');
  let trainerOn = false, _trBars = 0, _trDone = false;
  const ttNum = (el, def, min, max) => { const v = parseInt(el.value, 10); return clampInt(isFinite(v) ? v : def, min, max); };
  const ttStartV  = () => ttNum(ttStart, 120, 0, 300);
  const ttTargetV = () => ttNum(ttTarget, 180, 0, 300);
  const ttEveryV  = () => ttNum(ttEvery, 4, 1, 64);
  const ttStepV   = () => { const v = parseInt(String(ttStep.value).replace(/[^0-9-]/g, ''), 10); return isFinite(v) ? v : 5; };  // signed; empty falls back to the +5 placeholder (matches Playalongs)
  // status readout mirrors the main center tempo: a big value line + a small muted uppercase unit line
  const statHTML = (val, unit) => `<span class="tt-stat-val">${val}</span><span class="tt-stat-unit">${unit}</span>`;
  const ttSetStatus = (val, unit) => { if (ttStatus) ttStatus.innerHTML = val == null ? '' : statHTML(val, unit); };
  // positive tempo step always shows a leading "+" (e.g. +5); negative keeps its "-"; zero stays "0".
  // An EMPTY field is left empty so its grayed "+5" placeholder shows (empty then reads as +5 via ttStepV).
  function fmtSigned(el){ const v = parseInt(String(el.value).replace(/[^0-9-]/g, ''), 10); el.value = isFinite(v) ? ((v > 0 ? '+' : '') + v) : ''; }
  ttStep.addEventListener('blur', () => fmtSigned(ttStep));
  fmtSigned(ttStep);
  // ACTIVATE / DEACTIVATE only — no longer opens or closes any panel, and no longer disables the Gap
  // Trainer. The two trainers are independent and can both run at once.
  function setTrainer(on){
    trainerOn = !!on;
    ttToggle.checked = trainerOn;
    if (trainerOn) ttStart.value = String(getBpm());   // prefill Start with the current tempo
    ttSetStatus(null);
  }
  ttToggle.addEventListener('change', () => setTrainer(ttToggle.checked));
  // Panel open/close (Tempo / Gap / Presets) is unified in openTrainerPanel() below — only one open at a time.
  // reset the ramp for a fresh run (called from start())
  function trainerResetForPlay(){
    _trBars = 0; _trDone = false;
    if (!trainerOn){ ttSetStatus(null); return; }
    setBpmUI(ttStartV());
    ttSetStatus(ttStartV(), 'BPM');
  }
  // apply one step, clamped into [start,target]; hold once target is reached
  function trainerStep(){
    if (!isRunning || !trainerOn || _trDone) return;
    const target = ttTargetV(), lo = Math.min(ttStartV(), target), hi = Math.max(ttStartV(), target);
    const bpm = clampInt(getBpm() + ttStepV(), lo, hi);
    setBpmUI(bpm); smoothTempoUpdate();
    if (bpm === clampInt(target, 0, 300)){ _trDone = true; ttSetStatus(bpm, 'Target reached'); }
    else ttSetStatus(bpm, 'BPM');
  }
  // the scheduler calls this when a bar completes (at the downbeat time)
  function trainerOnBarComplete(barTime){
    if (!trainerOn || _trDone) return;
    if (++_trBars >= ttEveryV()){
      _trBars = 0;
      const delay = Math.max(0, (barTime - (audioCtx ? audioCtx.currentTime : 0)) * 1000);
      setTimeout(trainerStep, delay);
    }
  }

  /* ---------------- Gap Trainer ---------------- */
  // Plays N bars, then goes SILENT for M bars (you hold time internally), then repeats. During silent bars
  // the clicks are muted and the lights don't pulse — the status line shows the phase + bar count.
  const gapToggle = $('#gapToggle'), gapBody = $('#gapBody'), gapStatus = $('#gapStatus'), gapExpand = $('#gapExpand');
  const gapPlay = $('#gapPlay'), gapGap = $('#gapGap');
  let gapOn = false, _gapMuted = false;
  const gapPlayV = () => ttNum(gapPlay, 1, 1, 32);
  const gapGapV  = () => ttNum(gapGap, 1, 1, 32);
  // ACTIVATE / DEACTIVATE only — independent of the panel and of the Tempo Trainer (both can run at once).
  function setGap(on){
    gapOn = !!on;
    gapToggle.checked = gapOn;
    if (!gapOn){ _gapMuted = false; if (gapStatus) gapStatus.innerHTML = ''; }
  }
  gapToggle.addEventListener('change', () => setGap(gapToggle.checked));
  // Presets = a 3rd trainer tab (no ON/OFF switch — it isn't an activatable mode).
  const presetsBody = $('#presetsBody'), presetsExpand = $('#presetsExpand'), presetsTab = $('#presetsTab');
  // Only ONE of the three trainer panels is open at a time. which = 'tt' | 'gap' | 'presets' | null.
  /* Centre the tool WITHOUT it jumping when a trainer panel opens.

     Straight vertical centring would shove everything up the moment a panel expanded. Instead the shell
     stays top-anchored (so subdivisions still grow downward, as before) and we compute a fixed top pad
     that centres the tallest state — i.e. as if a panel were already open. Closed, the metronome sits a
     little high; opening a panel fills exactly that reserved gap and nothing moves.
     Recomputed on resize only, never on a panel toggle — that's the whole point. */
  var shellEl = $('.app-shell');
  // Embedded in the app the tool lives in a shadow root inside a fixed-size box, so the WINDOW height is
  // the wrong ruler — measure the box we're actually inside. Standalone there's no host and we fall back.
  var hostEl = (root && root.nodeType === 11 && root.host) || null;
  function availHeight(){
    if (hostEl) { var h = hostEl.getBoundingClientRect().height; if (h > 0) return h; }
    return (window.visualViewport && window.visualViewport.height) || window.innerHeight
           || document.documentElement.clientHeight || 0;
  }
  recentreShell.tries = 0;
  function recentreShell(){
    if (!shellEl) return;
    var vh = availHeight();
    // Mounted inside a shadow root the viewport can still read 0 on the first frames; retry rather than
    // silently give up, or the tool stays glued to the top with no error to explain why.
    if (!vh) { if (recentreShell.tries++ < 40) setTimeout(recentreShell, 100); return; }
    /* Measure the CHILDREN, not the shell. .app-shell is min-height:100vh, and embedded it also fills its
       host, so shellEl.scrollHeight reported the full 962px container no matter what — the maths then
       concluded there was nothing to centre and fell to the 12px floor every time. Walking the children
       gives the real content height regardless of how tall the box itself is. */
    var prevPad = shellEl.style.paddingTop;
    shellEl.style.paddingTop = '0px';
    var cs = getComputedStyle(shellEl);
    var kids = [];
    for (var i = 0; i < shellEl.children.length; i++) {
      if (shellEl.children[i].getBoundingClientRect().height > 0) kids.push(shellEl.children[i]);
    }
    var bare = 0;
    if (kids.length) {
      var shellTop = shellEl.getBoundingClientRect().top;
      var lastBottom = kids[kids.length - 1].getBoundingClientRect().bottom;
      bare = (lastBottom - shellTop) + (parseFloat(cs.paddingBottom) || 0);
    }
    shellEl.style.paddingTop = prevPad;
    if (!bare) return;

    // how much taller it could get: the biggest panel, minus whatever is already open
    var bodies = [ttBody, gapBody, presetsBody].filter(Boolean);
    var openH = 0, maxH = 0;
    bodies.forEach(function (b){
      var wasHidden = b.hidden;
      if (wasHidden) b.hidden = false;
      var h = b.getBoundingClientRect().height;
      if (wasHidden) b.hidden = true; else openH = h;
      if (h > maxH) maxH = h;
    });
    var tallest = bare + Math.max(0, maxH - openH);
    var pad = Math.max(12, Math.round((vh - tallest) / 2));
    shellEl.style.paddingTop = pad + 'px';
  }
  window.addEventListener('resize', recentreShell);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', recentreShell);
  (ctx.disposables || []).push(function (){
    window.removeEventListener('resize', recentreShell);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', recentreShell);
  });
  /* Fire it at several points rather than trusting one moment: two frames in (layout settled), a beat
     later (webfont + notation done), and on window load. Each call is cheap and idempotent, and this
     way a viewport that reports 0 on the first frames can't leave the tool stuck at the top. */
  requestAnimationFrame(function(){ requestAnimationFrame(recentreShell); });
  setTimeout(recentreShell, 250);
  setTimeout(recentreShell, 900);
  window.addEventListener('load', recentreShell);
  (ctx.disposables || []).push(function(){ window.removeEventListener('load', recentreShell); });

  function openTrainerPanel(which){
    var panels = { tt: [ttBody, ttExpand], gap: [gapBody, gapExpand], presets: [presetsBody, presetsExpand] };
    Object.keys(panels).forEach(function (k){
      var b = panels[k][0], e = panels[k][1];
      if (!b) return;
      var on = (k === which);
      b.hidden = !on;
      if (e) e.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }
  /* FREEMIUM: the three trainer tabs. Locking the TAB is not enough on its own — the Bump/Gap tabs carry
     their own ON/OFF switch that runs the trainer with the panel closed, so the switches are disabled too
     and clicking anywhere on a locked tab opens the upgrade prompt. */
  if (!PAID){
    [[ttExpand, 'Bump Tempo', 'Bump Tempo ramps the click for you, a step at a time. It comes with the full version.'],
     [gapExpand, 'Gap Trainer', 'The Gap Trainer drops the click for a few bars to test your time. It comes with the full version.'],
     [presetsExpand, 'Presets', 'Saving your click setups comes with the full version.']
    ].forEach(function (row){
      var btn = row[0]; if (!btn) return;
      var tab = btn.closest ? btn.closest('.tt-tab') : null;
      if (tab){
        tab.classList.add('tt-tab--locked');
        var sw = tab.querySelector('.tt-toggle input');
        if (sw){ sw.disabled = true; sw.checked = false; }
        var lab = tab.querySelector('.tt-toggle');
        if (lab) lab.addEventListener('click', function (e){ e.preventDefault(); upsell('Unlock ' + row[1], row[2]); });
      }
      btn.addEventListener('click', function (){ upsell('Unlock ' + row[1], row[2]); });
    });
  }
  if (ttExpand) ttExpand.addEventListener('click', function(){ if (!PAID) return; openTrainerPanel(ttBody.hidden ? 'tt' : null); });
  if (gapExpand) gapExpand.addEventListener('click', function(){ if (!PAID) return; openTrainerPanel(gapBody.hidden ? 'gap' : null); });
  if (presetsExpand) presetsExpand.addEventListener('click', function(){ if (!PAID) return; openTrainerPanel(presetsBody && presetsBody.hidden ? 'presets' : null); });
  function gapResetForPlay(){ _gapMuted = false; if (gapStatus) gapStatus.innerHTML = ''; }
  // set the play/silent phase for the bar starting now (called at every downbeat)
  function gapUpdateForBar(barIndex){
    if (!gapOn){ _gapMuted = false; return; }
    const play = gapPlayV(), silent = gapGapV(), cyc = play + silent;
    const inCyc = ((barIndex % cyc) + cyc) % cyc;
    const playing = inCyc < play;
    _gapMuted = !playing;
    if (gapStatus) gapStatus.innerHTML = playing
      ? statHTML(`${inCyc + 1} / ${play}`, 'Playing')
      : statHTML(`${inCyc - play + 1} / ${silent}`, 'Silent');
  }

  // single downbeat dispatcher for the trainers (fires on EVERY downbeat; barIndex is 0-based)
  function onDownbeat(barIndex, beatTime){
    gapUpdateForBar(barIndex);                 // set mute phase for this bar (gap trainer)
    if (barIndex > 0) trainerOnBarComplete(beatTime);   // a bar completed (tempo trainer)
  }

  tempoSlider.addEventListener('input', () => {
    const v = clampInt(tempoSlider.value, 0, 300);
    if (bpmBig) bpmBig.textContent = String(v);
    tempoInput.value = String(v);
    updateFill(tempoSlider, tempoFill);
    updateTempoMark();
    if (isRunning) smoothTempoUpdate();
  });
  tempoInput.addEventListener('input', () => {
    const v = clampInt(tempoInput.value, 0, 300);
    if (bpmBig) bpmBig.textContent = String(v);
    tempoSlider.value = String(v);
    updateFill(tempoSlider, tempoFill);
    updateTempoMark();
    if (isRunning) smoothTempoUpdate();
  });

  /* ---------------- Volume UI ---------------- */
  // Beat/Sub volume sliders were removed from the UI; the levels stay at their defaults (mainVol/subVol
  // above). Guarded so the code is a no-op if the elements aren't present.
  function updateMainVol(){ if (!mainVolRange) return; mainVol = sliderToLinear(mainVolRange.value); if (mainVolVal) mainVolVal.textContent = `${Math.round(+mainVolRange.value || 0)}%`; updateFill(mainVolRange, mainVolFill); }
  function updateSubVol(){ if (!subVolRange) return; subVol = sliderToLinear(subVolRange.value); if (subVolVal) subVolVal.textContent = `${Math.round(+subVolRange.value || 0)}%`; updateFill(subVolRange, subVolFill); }
  mainVolRange && mainVolRange.addEventListener('input', updateMainVol);
  subVolRange && subVolRange.addEventListener('input', updateSubVol);

  /* ---------------- Setting-change wiring ---------------- */
  [timeSigSel, subdivSel].forEach(el => el.addEventListener('change', () => {
    // THE SPLIT: per-beat subdivisions (b=1: 8ths/16ths/triplets/lets) leave the meter alone — they fit ANY
    // time signature. Cross-rhythms span `b` beats (dotted-8ths / 4:3 / 5:3 / 7:3 = over 3; quarter-triplets
    // / 8th-lets = over 2) and auto-switch the meter to b/4 so the pattern fills whole measures.
    if (el === subdivSel){
      const bb = Math.max(1, Math.floor(getSubdivParts().b));
      const want = bb > 1 ? bb + '/4' : null;
      if (want && timeSigSel.value !== want){
        timeSigSel.value = want;
        triggerLabel($('#timeSigBtn'), timeSigSel.options[timeSigSel.selectedIndex]?.text || want);
      }
    }
    // if the meter's FAMILY changed, swap the subdivision option set + reset to the family default
    syncSubdivFamily();
    beatStates = defaultBeatStates();
    renderLights();
    const n = subsLightsCount();
    subStates = n > 0 ? initialSubStates(n) : [];
    /* The picker edits the SELECTED step. Committing before the per-beat check means a cross-rhythm
       collapse keeps the rhythm you just picked and only drops the other steps. */
    seqCommit();
    if (seqEnforcePerBeat()) seqApply();
    renderSubLights();
    renderSeq();
    updateMeta();
    updateTempoGlyph();
    renderNotation();
    alignToGrid(true);
  }));
  soundSel.addEventListener('change', () => { ensurePresetSamples(); });

  /* ---------------- Keyboard ---------------- */
  document.addEventListener('keydown', (e) => {
    if (!kbdHelp.hidden){ if (e.key === 'Escape' || e.key === '/' || e.key === '?'){ e.preventDefault(); closeKbd(); } return; }   // popup open: Esc + "/" close, swallow the rest
    if (!pickerEl.hidden) return;
    // from a shadow root the document keydown's e.target retargets to the host, so read the tool's OWN
    // focused element (root.activeElement) to detect typing; falls back to e.target when standalone.
    const focused = root.activeElement || e.target;
    const tag = (focused && focused.tagName || '').toLowerCase();
    /* A SLIDER left focused after a drag must not swallow Space, or (worse) sit there and let the
       browser flip on its focus ring right as you press it (Anthony, 2026-08-02 — see the matching
       comment in Sightreading Lab/app.js for the full story). Blur it and fall through to the
       transport toggle below; every other key is left alone so arrow-key slider nudging still works. */
    if (tag === 'input' && focused.type === 'range' && (e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar')) { focused.blur(); }
    else if (tag === 'input' || tag === 'textarea' || tag === 'select' || (focused && focused.isContentEditable)) return;
    if (e.key === '/' || e.key === '?'){ e.preventDefault(); openKbd(); return; }
    if (e.code === 'Space' || e.key.toLowerCase() === 'k'){ e.preventDefault(); toggleTransport(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight'){ e.preventDefault(); stepBpm(e.shiftKey ? +5 : +1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft'){ e.preventDefault(); stepBpm(e.shiftKey ? -5 : -1); }
    else if (e.key.toLowerCase() === 't'){ onTap(); }
  });

  /* ---------------- Init ---------------- */
  const defaults = { bpm: 120, timeSig: '4/4', subdiv: '1/1', sound: 'beep', mainVol: 100, subVol: 85 };
  function init(){
    timeSigSel.value = defaults.timeSig;
    soundSel.value = defaults.sound;
    setBpmUI(defaults.bpm);
    syncSubdivFamily();   // populate the subdivision options for the initial meter's family (sets the default)

    if (mainVolRange){ mainVolRange.value = String(defaults.mainVol); updateMainVol(); }
    if (subVolRange){ subVolRange.value = String(defaults.subVol); updateSubVol(); }

    // sync all trigger labels
    triggerLabel($('#timeSigBtn'), timeSigSel.options[timeSigSel.selectedIndex]?.text || '');
    triggerLabel($('#subdivBtn'), subdivSel.options[subdivSel.selectedIndex]?.text || '');
    triggerLabel($('#soundBtn'), soundSel.options[soundSel.selectedIndex]?.text || '');

    beatStates = defaultBeatStates();
    renderLights();
    const n = subsLightsCount();
    subStates = n > 0 ? initialSubStates(n) : [];
    // start as a ONE-step sequence = exactly the old single-rhythm metronome
    seqSteps = [{ v: subdivSel.value, n: 1, states: subStates.slice() }];
    seqSel = 0; seqPlayIdx = -1;
    renderSubLights();
    renderSeq();
    updateMeta();
    updateTempoGlyph();
    renderNotation();

    ensureCtx(); if (audioCtx) ensurePresetSamples();
    alignToGrid(true);
  }

  // one-time audio unlock on first gesture anywhere
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, function unlock(){ gestureUnlock(); document.removeEventListener(ev, unlock, true); }, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && audioCtx && audioCtx.state !== 'running') { try { audioCtx.resume(); } catch {} } });

  /* ---------------- Presets: save/load your whole click setup to your account ---------------- */
  var userMetroPresets = (ctx.presets && ctx.presets.initial ? ctx.presets.initial : []).slice();

  // Guarantee a unique preset name: if "Name" is taken, save "Name 2", then "Name 3", … (case-insensitive).
  function uniquePresetName(base, list) {
    var taken = {};
    (list || []).forEach(function (p) { if (p && p.name) taken[String(p.name).trim().toLowerCase()] = 1; });
    if (!taken[base.toLowerCase()]) return base;
    var n = 2;
    while (taken[(base + " " + n).toLowerCase()]) n++;
    return base + " " + n;
  }
  function captureMetroPreset() {
    return {
      bpm: getBpm(), timeSig: timeSigSel.value, subdiv: subdivSel.value, sound: soundSel.value,
      mainVol: mainVolRange ? parseInt(mainVolRange.value, 10) : defaults.mainVol,
      subVol: subVolRange ? parseInt(subVolRange.value, 10) : defaults.subVol,
      beatStates: JSON.parse(JSON.stringify(beatStates || [])),
      subStates: JSON.parse(JSON.stringify(subStates || [])),
      /* The whole rhythm sequence. `subdiv`/`subStates` above still describe the SELECTED step, so a
         preset saved here stays loadable by an older build (it just sees one rhythm). */
      seq: (seqSteps || []).map(function (s) {
        return { v: s.v, n: Math.max(1, s.n | 0), states: (s.states || []).slice() };
      }),
      seqSel: seqSel
    };
  }
  function applyMetroPreset(p) {
    if (!p) return;
    if (isRunning) stop();
    /* FREEMIUM: presets are paid-only, so this normally can't run on a free account — but a preset saved
       while paid must not survive a downgrade as a back door into a locked meter or subdivision. */
    if (!PAID) {
      p = Object.assign({}, p);
      if (sigLocked(p.timeSig)) p.timeSig = defaults.timeSig;
      if (subdivLocked(p.subdiv)) p.subdiv = defaults.subdiv;
    }
    timeSigSel.value = p.timeSig || defaults.timeSig;
    soundSel.value = p.sound || defaults.sound;
    syncSubdivFamily();                                  // repopulate subdiv options for the meter
    if (p.subdiv && Array.prototype.some.call(subdivSel.options, function (o) { return o.value === p.subdiv; })) subdivSel.value = p.subdiv;
    setBpmUI(p.bpm || defaults.bpm);
    if (mainVolRange) { mainVolRange.value = String(p.mainVol != null ? p.mainVol : defaults.mainVol); updateMainVol(); }
    if (subVolRange) { subVolRange.value = String(p.subVol != null ? p.subVol : defaults.subVol); updateSubVol(); }
    triggerLabel($('#timeSigBtn'), (timeSigSel.options[timeSigSel.selectedIndex] || {}).text || '');
    triggerLabel($('#subdivBtn'), (subdivSel.options[subdivSel.selectedIndex] || {}).text || '');
    triggerLabel($('#soundBtn'), (soundSel.options[soundSel.selectedIndex] || {}).text || '');
    var defB = defaultBeatStates();
    beatStates = (p.beatStates && p.beatStates.length === defB.length) ? JSON.parse(JSON.stringify(p.beatStates)) : defB;
    renderLights();
    var n = subsLightsCount();
    subStates = (p.subStates && n > 0 && p.subStates.length === n) ? JSON.parse(JSON.stringify(p.subStates)) : (n > 0 ? initialSubStates(n) : []);

    /* Restore the rhythm SEQUENCE. Presets saved before sequences existed have no `seq`, so they fall
       back to the single `subdiv` + `subStates` above — that is the one-step case, which is exactly
       what an old preset meant.
       Every step's rhythm is validated twice: it must still be an option in THIS meter's family (a
       preset saved in 4/4 carries simple-family values that a compound meter does not offer), and it
       must pass the same freemium check as `p.subdiv` above — otherwise a preset saved while paid
       would be a back door to a locked subdivision, just smuggled in as sequence step 2 instead of
       step 1. */
    var hasOpt = function (v) { return Array.prototype.some.call(subdivSel.options, function (o) { return o.value === v; }); };
    var rawSeq = Array.isArray(p.seq) ? p.seq : null;
    var steps = [];
    if (rawSeq){
      for (var i = 0; i < rawSeq.length && steps.length < SEQ_MAX; i++){
        var s = rawSeq[i] || {}, v = s.v;
        if (!v || !hasOpt(v)) continue;
        if (!PAID && subdivLocked(v)) v = defaults.subdiv;
        if (!hasOpt(v)) continue;
        steps.push({
          v: v,
          n: Math.min(SEQ_BEATS_MAX, Math.max(1, parseInt(s.n, 10) || 1)),
          states: Array.isArray(s.states) ? s.states.slice() : []
        });
      }
    }
    if (!steps.length) steps = [{ v: subdivSel.value, n: 1, states: (subStates || []).slice() }];
    seqSteps = steps;
    seqSel = Math.min(Math.max(0, parseInt(p.seqSel, 10) || 0), seqSteps.length - 1);
    seqPlayIdx = -1;
    if (hasOpt(seqSteps[seqSel].v)) subdivSel.value = seqSteps[seqSel].v;
    triggerLabel($('#subdivBtn'), (subdivSel.options[subdivSel.selectedIndex] || {}).text || '');
    seqApply();                 // sizes the pills to the selected step and redraws them
    renderSeq();

    updateMeta(); updateTempoGlyph(); renderNotation();
    ensurePresetSamples();
    alignToGrid(true);
  }
  function renderMetroPresets() {
    var host = $('#metroPresets'); if (!host) return;
    host.innerHTML = '';
    var lbl = document.createElement('label');
    lbl.className = 'metro-presets-lbl'; lbl.textContent = 'Your setups';
    host.appendChild(lbl);
    var save = document.createElement('button');
    save.type = 'button'; save.className = 'metro-preset-save'; save.textContent = '＋ Save preset';
    save.addEventListener('click', function () {
      RDMDialogs.name(root, { title: 'Name this click setup', value: 'My Click', theme: 'theme-purple' }).then(function (name) {
        name = (name || '').trim();
        if (!name) return;
        name = uniquePresetName(name, userMetroPresets);   // no two presets share a name — auto-number dupes
        Promise.resolve(ctx.presets.create(name, captureMetroPreset())).then(function (p) { userMetroPresets.push(p); renderMetroPresets(); })
          .catch(function (e) { RDMDialogs.alert(root, { title: "Couldn't save", message: "Couldn't save the preset. " + ((e && e.message) || ''), theme: 'theme-purple' }); });
      });
    });
    host.appendChild(save);
    userMetroPresets.forEach(function (p) {
      var chip = document.createElement('span'); chip.className = 'metro-preset-chip';
      var load = document.createElement('button'); load.type = 'button'; load.className = 'mp-load'; load.textContent = p.name; load.title = 'Load this setup';
      load.addEventListener('click', function () { applyMetroPreset(p.settings); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'mp-del'; del.setAttribute('aria-label', 'Delete preset'); del.textContent = '✕';
      del.addEventListener('click', function () {
        RDMDialogs.confirm(root, { title: 'Delete preset?', message: 'Delete "' + p.name + '"?', theme: 'theme-purple' }).then(function (ok) {
          if (!ok) return;
          ctx.presets.remove(p.id);
          var i = userMetroPresets.indexOf(p); if (i >= 0) userMetroPresets.splice(i, 1);
          renderMetroPresets();
        });
      });
      chip.appendChild(load); chip.appendChild(del); host.appendChild(chip);
    });
  }

  init();
  if (ctx.presets) { if (presetsTab) presetsTab.hidden = false; renderMetroPresets(); }

  /* ---------------- mount API (used when embedded in the React shell) ---------------- */
  return {
    pause: function () { try { stop(); } catch (e) {} },
    /* Background playback. UNLIKE Playalongs/SR (which spin up a second RDMPlayer), the fix here is that
       trigger() now takes an explicit { ctx, master } — this NEVER reads or writes the module-level
       audioCtx/master/_gapMuted the live scheduler uses, so a render running while the click is live
       cannot touch it, by construction, not by timing luck.

       Renders whole BARS (a whole number of beats, same rule the device test established for Playalongs)
       through the real trigger() voices, so accents, per-beat states, chosen sound and volumes all
       survive. The Gap and Tempo trainers are NOT baked in — they drive DOM/wall-clock state — so this
       covers the click pattern itself, not those two trainers. */
    renderBounce: function (seconds) {
      var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) return Promise.reject(new Error("OfflineAudioContext unavailable"));
      var spb = secondsPerBeat();
      if (!isFinite(spb) || spb <= 0) return Promise.reject(new Error("metronome has no tempo"));

      var beatsPerBar = beatInfo().beatsPerBar || 4;
      var barSecs = spb * beatsPerBar;
      var bars = Math.max(1, Math.round((+seconds || 300) / barSecs));
      var dur = bars * barSecs;
      var SR = 44100;

      try {
        var oc = new OAC(1, Math.ceil(dur * SR), SR);
        var offMaster = oc.createGain();
        offMaster.gain.setValueAtTime(1.0, 0);
        offMaster.connect(oc.destination);
        var target = { ctx: oc, master: offMaster };

        var ratio = getSubdivRatio(), isQuarter = isQuartersSubdiv();
        var subEnabled = (ratio > EPS) && !isQuarter;
        var subInterval = subEnabled ? (spb / ratio) : Infinity;
        var subCount = subEnabled ? Math.max(1, Math.round(ratio)) : 1;

        var bi = 0, si = 0, guard = 0;
        while (guard++ < 500000) {
          var tB = bi * spb;
          var tS = subEnabled ? si * subInterval : Infinity;
          var tNext = Math.min(tB, tS);
          if (tNext >= dur - EPS) break;
          var coincide = subEnabled && Math.abs(tB - tS) <= EPS;
          if (coincide || tB < tS) {
            var inBar = ((bi % beatsPerBar) + beatsPerBar) % beatsPerBar;
            var st = (beatStates[inBar] == null) ? 1 : beatStates[inBar];
            if (st !== 0) trigger(tB, st === 2 ? 'accent' : 'beat', 1, target);
            if (coincide) {
              var vi = ((si % subCount) + subCount) % subCount;
              var ss = (subStates[vi] == null) ? 1 : subStates[vi];
              if (ss !== 0) trigger(tB, ss === 2 ? 'subAccent' : 'sub', 0.45, target);
              si++;
            }
            bi++;
            continue;
          }
          var vi2 = ((si % subCount) + subCount) % subCount;
          var ss2 = (subStates[vi2] == null) ? 1 : subStates[vi2];
          if (ss2 === 2) trigger(tS, 'subAccent', 1, target);
          else if (ss2 === 1) trigger(tS, 'sub', 1, target);
          si++;
        }

        return oc.startRendering().then(function (buf) {
          buf._rdmPasses = bars;
          return buf;
        });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    bounceMeta: function () { return { title: "RDM Metronome", tempo: getBpm() }; },
    /* Scheduler probe for dev/metro-sequence-test.js. Builds a sequence, runs the REAL schedule()
       against the real clock for one lookahead window, and returns every click it laid down with its
       exact time — so the test checks scheduled audio, not a restatement of the maths. Read-only apart
       from the settings it is asked to apply. */
    __test: {
      capture: function (setup, ms) {
        setup = setup || {};
        if (setup.bpm) setBpmUI(setup.bpm);
        if (setup.timeSig){ timeSigSel.value = setup.timeSig; timeSigSel.dispatchEvent(new Event('change', { bubbles: true })); }
        if (setup.steps && setup.steps.length){
          subdivSel.value = setup.steps[0].v;
          subdivSel.dispatchEvent(new Event('change', { bubbles: true }));
          seqSteps = setup.steps.map(function (s) { return { v: s.v, n: s.n || 1, states: (s.states || []).slice() }; });
          seqSel = 0; seqStash = null;
          seqApply(); renderSeq();
        }
        ensureCtx();
        alignToGrid(true);
        _clickLog = [];
        const t0 = gridT0, spb = secondsPerBeat();
        // pump the scheduler the same way its own timer does, letting real time advance between passes
        return new Promise(function (resolve) {
          const iv = setInterval(function () { try { schedule(); } catch (e) {} }, 25);
          setTimeout(function () {
            clearInterval(iv);
            const log = _clickLog.slice(); _clickLog = null;
            resolve({ t0: t0, spb: spb, clicks: log.map(function (c) { return { beat: (c.t - t0) / spb, kind: c.kind, gain: c.gain }; }) });
          }, ms || 700);
        });
      },
      seqStepAt: function (i) { const r = seqStepAt(i); return r ? { idx: r.idx, v: r.step.v, n: r.step.n } : null; },
      state: function () { return { playIdx: seqPlayIdx, sel: seqSel, view: seqViewIdx(), running: isRunning }; },
      capturePreset: function () { return captureMetroPreset(); },
      applyPreset: function (p) { return applyMetroPreset(p); },
    },
    destroy: function () {
      try { stop(); } catch (e) {}
      try { if (audioCtx && audioCtx.close) audioCtx.close(); } catch (e) {}
      const d = ctx.disposables || [];
      for (let i = 0; i < d.length; i++) { try { d[i](); } catch (e) {} }
    },
    // re-run the width-dependent renders (lights + notation) once layout settles or the tool becomes
    // active — inside a shadow root those widths can read 0/narrow at the synchronous boot.
    relayout: function () {
      try { renderLights(); renderSubLights(); renderNotation(); alignToGrid(true); recentreShell(); } catch (e) {}
    }
  };
}
window.mountMetronome = mountMetronome;
// standalone (opened raw, outside the React app): boot itself once the DOM is ready, as the old DOMContentLoaded did.
if (!window.__RDM_EMBED) {
  const __rdmRunMetro = function () { mountMetronome(document, { root: document, isActive: function () { return true; }, disposables: [] }); };
  if (document.readyState !== 'loading') __rdmRunMetro();
  else document.addEventListener('DOMContentLoaded', __rdmRunMetro);
}
