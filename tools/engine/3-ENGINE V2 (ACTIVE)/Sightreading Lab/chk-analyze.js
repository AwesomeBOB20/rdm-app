require('./generator.js');
const V = globalThis.RDMSightGen.VARIANTS;
const fmt = n => (n.kind === 'rest' || n.rest ? 'R' : '') + n.dur + (n.dots ? '.' : '') + '(' + (+n.beats.toFixed(3)) + ')';
(process.argv.slice(2).length ? process.argv.slice(2) : ['8t','5let','6let','qt']).forEach(k => {
  const list = (V[k] || []).filter(v => !/cmp/.test(v.id));
  console.log('\n=== ' + k + ' — ' + list.length + ' base variants ===');
  list.forEach(v => {
    const bits = (v.id.match(/_([01]+)$/) || [])[1] || '-';
    const notes = v.notes.map(fmt).join(' ');
    const restsAfterNote = v.notes.some((n, i) =>
      (n.kind === 'rest' || n.rest) && v.notes.slice(0, i).some(x => !(x.kind === 'rest' || x.rest)));
    console.log('  ' + bits.padEnd(8) + (restsAfterNote ? 'REST-AFTER  ' : '            ') + notes + '   "' + v.label + '"');
  });
});
