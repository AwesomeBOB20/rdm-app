/* dev report: WHY does each rest exist?

   Tests Anthony's explanation: a rest appears where sustaining the previous note would need a note
   value that cannot be written (k = 5, 7, 9, 10, 11 slots -> needs a tie). For every rest that has a
   note before it, this merges the rest back into that note and asks whether the result is a legal
   single notehead.

     FORCED   - merging gives an illegal length. The rest is the only way to notate it.
     COULD    - merging gives a legal length, so this rest was a choice, not a necessity. */
require('./generator.js');
const V = globalThis.RDMSightGen.VARIANTS;
const CATS = globalThis.RDMSightGen.CATEGORIES.map(c => c.key);
const LEGAL = new Set([1, 2, 3, 4, 6, 8, 12]);          // UNIT_MAP keys in generator.js
const isRest = (x) => x.kind === 'rest' || !!x.rest;
const pad = (s, n) => String(s).padEnd(n);

const rows = [];
CATS.forEach((k) => {
  const list = V[k] || [];
  let forced = 0, could = 0;
  const couldEx = [], forcedEx = [];
  list.forEach((v) => {
    const n = v.notes;
    const span = n.reduce((a, x) => a + (x.beats || 0), 0);
    const bits = (/([01]{2,})$/.exec(v.id) || [])[1];    // slot count lives in the id's bit string
    if (!bits) return;                                   // hand-named variant, no bits to reason from
    const slot = span / bits.length;
    n.forEach((note, i) => {
      if (!isRest(note)) return;
      const prev = n.slice(0, i).reverse().find(() => true);
      if (!prev || isRest(prev)) return;                 // leading rest: always legal, skip
      const merged = (prev.beats || 0) + (note.beats || 0);
      const kSlots = Math.round(merged / slot * 1000) / 1000;
      const legal = LEGAL.has(Math.round(kSlots)) && Math.abs(kSlots - Math.round(kSlots)) < 0.02;
      if (legal) { could++; if (couldEx.length < 3) couldEx.push(v.id + ' (k=' + Math.round(kSlots) + ')'); }
      else { forced++; if (forcedEx.length < 4) forcedEx.push(v.id + ' (k=' + kSlots + ')'); }
    });
  });
  if (forced + could) rows.push({ k, forced, could, couldEx, forcedEx });
});

rows.forEach((r) => {
  console.log(pad(r.k, 10) + 'FORCED ' + pad(r.forced, 5) + ' COULD-sustain ' + r.could);
  if (r.forcedEx.length) console.log(pad('', 10) + '  forced:  ' + r.forcedEx.join(', '));
  if (r.couldEx.length)  console.log(pad('', 10) + '  could:   ' + r.couldEx.join(', '));
});
console.log('\nFORCED = no single notehead covers the merged length, so the rest is required.');
console.log('COULD  = a legal notehead existed; that rest was a deliberate look.');
