const fs = require('fs');
const path = require('path');
const { SoundFont, parse } = require('@ryohey/sf2parser');

const data = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'MS Basic.sf2')));
const parsed = parse(data);
const sf = new SoundFont(parsed);

const ph = parsed.presetHeaders.find(p => p.preset === 0 && p.bank === 0);
console.log('Piano preset header', ph);

const pzone = parsed.presetZone[ph.presetBagIndex];
console.log('first preset bag', pzone);

const nextPh = parsed.presetHeaders.find(p => p.preset > 0 && p.bank === 0);
console.log('next bank0 preset', nextPh);

const start = pzone.presetGeneratorIndex;
const end = nextPh ? parsed.presetZone[nextPh.presetBagIndex].presetGeneratorIndex : parsed.presetGenerators.length;
console.log('generator slice', start, end);
console.log(parsed.presetGenerators.slice(start, end));

console.log('getInstrumentKey result for C4:', sf.getInstrumentKey(0, 0, 60, 100));
