const fs = require('fs');
const path = require('path');
const { parse } = require('@ryohey/sf2parser');

const sf2Path = path.join(__dirname, '..', 'MS Basic.sf2');
console.log('Parsing', sf2Path);
const data = new Uint8Array(fs.readFileSync(sf2Path));
console.log('bytes', data.length);

const sf = parse(data);
console.log(Object.keys(sf));
console.log('preset count', sf.presetHeaders?.length);
console.log('instrument count', sf.instrumentHeaders?.length);
console.log('sample count', sf.sampleHeaders?.length);

const targets = [
  { name: 'Acoustic Grand Piano', prog: 0, bank: 0 },
  { name: 'Violin', prog: 40, bank: 0 },
  { name: 'Viola', prog: 41, bank: 0 },
  { name: 'Cello', prog: 42, bank: 0 },
  { name: 'Trumpet', prog: 56, bank: 0 },
  { name: 'Clarinet', prog: 71, bank: 0 },
  { name: 'Flute', prog: 73, bank: 0 },
  { name: 'Orchestral Harp', prog: 46, bank: 0 },
  { name: 'Lead 1 (Square)', prog: 80, bank: 0 },
  { name: 'Lead 2 (Sawtooth)', prog: 81, bank: 0 },
];

for (const t of targets) {
  const idx = sf.presetHeaders.findIndex(p => p.bank === t.bank && p.preset === t.prog);
  if (idx === -1) {
    console.log('NOT FOUND', t.name);
    continue;
  }
  const ph = sf.presetHeaders[idx];
  console.log('FOUND', t.name, ph);
  const pbagStart = ph.presetBagIndex;
  const pbagEnd = idx + 1 < sf.presetHeaders.length ? sf.presetHeaders[idx + 1].presetBagIndex : sf.presetBags.length;
  console.log('  preset bags', pbagStart, pbagEnd);
}
