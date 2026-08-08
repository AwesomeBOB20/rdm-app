/* dev check: the picker tiles in app.js must draw the same note value + ratio the generator produces */
require('./generator.js');
const V = globalThis.RDMSightGen.VARIANTS;
const a = require('fs').readFileSync('app.js', 'utf8');
let bad = 0;
['r43','r53','r73','r83','r46','r56','r76','r86'].forEach(k => {
  // compare against the FULL RUN (all attacks) — it's the shape the tile draws, not whatever is first
  const gen = (V[k] || []).find(v => !/0/.test(v.id.split('_').pop())) || (V[k] || [])[0];
  const genDur = String(gen.notes[0].dur);
  const genSo  = String(gen._tuplet.notes_occupied);
  const line = a.split('\n').find(l => l.includes('"' + k + '":')) || '';
  const tDur = (line.match(/fill\(\d+,\s*"(\d+)"\)/) || [])[1];
  const tSo  = (line.match(/inSpaceOf:\s*(\d+)/) || [])[1];
  const ok = tDur === genDur && tSo === genSo;
  if (!ok) bad++;
  console.log((ok ? '  OK   ' : '  BAD  ') + k.padEnd(6) +
    'tile ' + tDur + ' :' + tSo + '    generator ' + genDur + ' :' + genSo);
});
console.log(bad ? '\n' + bad + ' MISMATCHED' : '\nAll tiles match the generator.');
