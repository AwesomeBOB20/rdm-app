/* dev report: is every possible variation present?

   A family is complete when it has all 2^N - 1 bit strings over its N slots (all-zeros excluded, a beat
   is never silent). Variants are grouped by their id prefix, because several families hold more than one
   sub-family: "16s" carries both the 4-slot 16ths and the 6-slot cmp_6let clones.

   Ids with no trailing bit string are hand-named idioms; they are listed, not counted as gaps. */
require('./generator.js');
const V = globalThis.RDMSightGen.VARIANTS;
const pad = (s, n) => String(s).padEnd(n);

const groups = new Map();                                  // prefix -> {fam, N, have:Set, named:[]}
Object.keys(V).forEach((fam) => {
  (V[fam] || []).forEach((v) => {
    const m = /^(.*)_([01]+)$/.exec(v.id);
    if (!m) {
      const key = fam + ' :: (named)';
      if (!groups.has(key)) groups.set(key, { fam, N: 0, have: new Set(), named: [] });
      groups.get(key).named.push(v.id);
      return;
    }
    const key = fam + ' :: ' + m[1];
    if (!groups.has(key)) groups.set(key, { fam, N: m[2].length, have: new Set(), named: [] });
    const g = groups.get(key);
    g.N = Math.max(g.N, m[2].length);
    g.have.add(m[2]);
  });
});

let totalMissing = 0;
console.log(pad('family :: prefix', 28) + pad('slots', 7) + pad('have', 7) + pad('possible', 10) + 'status');
console.log('-'.repeat(96));
[...groups.entries()].forEach(([key, g]) => {
  if (!g.N) { console.log(pad(key, 28) + pad('-', 7) + pad(g.named.length, 7) + pad('-', 10) + 'hand-named: ' + g.named.join(' ')); return; }
  const possible = Math.pow(2, g.N) - 1;
  const missing = [];
  for (let m = 1; m <= possible; m++) {
    let b = m.toString(2); while (b.length < g.N) b = '0' + b;
    if (!g.have.has(b)) missing.push(b);
  }
  totalMissing += missing.length;
  const status = missing.length === 0 ? 'COMPLETE'
    : 'MISSING ' + missing.length + ': ' + missing.slice(0, 8).join(' ') + (missing.length > 8 ? ' …' : '');
  console.log(pad(key, 28) + pad(g.N, 7) + pad(g.have.size, 7) + pad(possible, 10) + status);
});
console.log('\ntotal missing bit strings: ' + totalMissing);
