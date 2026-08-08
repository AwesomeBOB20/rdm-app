/* dev report: which rest convention each rhythm family uses (see RHYTHM-RULES.md).

   NOT a pass/fail test. Sustain-vs-rest is a readability choice that legitimately varies per family:
   16s/5let/8t sustain, qt uses rests (a sustained quarter-triplet has no clean notehead), and 6let split
   tiles use internal rests to show which partials of the triplet are struck. Build a NEW variation to
   match its OWN family's convention. */
require('./generator.js');
const V = globalThis.RDMSightGen.VARIANTS;
const CATS = globalThis.RDMSightGen.CATEGORIES.map(c => c.key);
const pad = (s, n) => String(s).padEnd(n);

console.log(pad('family', 10) + pad('variants', 10) + pad('span(s)', 14) + pad('convention', 18) + 'rests mid/end');
console.log('-'.repeat(70));

CATS.forEach(k => {
  const list = V[k] || [];
  let mid = 0, end = 0;
  list.forEach(v => {
    const n = v.notes;
    n.forEach((note, i) => {
      const isRest = note.kind === 'rest' || !!note.rest;
      if (!isRest) return;
      const noteBefore = n.slice(0, i).some(x => !(x.kind === 'rest' || x.rest));
      if (noteBefore && i < n.length - 1) mid++;
      else if (noteBefore) end++;
    });
  });
  const spans = [...new Set(list.map(v => +v.notes.reduce((a, x) => a + (x.beats || 0), 0).toFixed(3)))];
  const style = (mid + end) === 0 ? 'sustain only'
              : mid > end ? 'sub-group rests' : 'trailing rests';
  console.log(pad(k, 10) + pad(list.length, 10) + pad(spans.join('/'), 14) + pad(style, 18) + mid + ' / ' + end);
});

console.log('\nMatch a new variation to its own family\'s convention above, not to one global rule.');
