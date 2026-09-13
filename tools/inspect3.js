const fs = require('fs');
const path = require('path');
const { parse } = require('@ryohey/sf2parser');

const data = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'MS Basic.sf2')));
const sf = parse(data);

function showPreset(name, prog, bank = 0) {
  const idx = sf.presetHeaders.findIndex(p => p.bank === bank && p.preset === prog);
  if (idx === -1) return console.log('not found', name);
  const ph = sf.presetHeaders[idx];
  const pbagStart = ph.presetBagIndex;
  const pbagEnd = idx + 1 < sf.presetHeaders.length ? sf.presetHeaders[idx + 1].presetBagIndex : sf.presetZone.length;
  console.log('\n===', name, ph.presetName, 'preset', prog, 'bags', pbagStart, pbagEnd, '===');
  for (let i = pbagStart; i < pbagEnd; i++) {
    const pzone = sf.presetZone[i];
    console.log('preset zone', i, pzone);
    const igenStart = pzone.generatorIndex;
    const igenEnd = i + 1 < sf.presetZone.length ? sf.presetZone[i + 1].generatorIndex : sf.presetGenerators.length;
    console.log('  generators', igenStart, igenEnd, sf.presetGenerators.slice(igenStart, igenEnd));
  }
}

function showInstrument(instIdx) {
  const inst = sf.instruments[instIdx];
  console.log('instrument', instIdx, inst);
  const izStart = inst.instrumentBagIndex;
  const izEnd = instIdx + 1 < sf.instruments.length ? sf.instruments[instIdx + 1].instrumentBagIndex : sf.instrumentZone.length;
  for (let i = izStart; i < izEnd; i++) {
    const iz = sf.instrumentZone[i];
    console.log('  izone', i, iz);
    const genStart = iz.generatorIndex;
    const genEnd = i + 1 < sf.instrumentZone.length ? sf.instrumentZone[i + 1].generatorIndex : sf.instrumentGenerators.length;
    console.log('    generators', sf.instrumentGenerators.slice(genStart, genEnd));
    // find sample generator
    const sampleGen = sf.instrumentGenerators.slice(genStart, genEnd).find(g => g.type === 'sampleID');
    if (sampleGen) {
      const sh = sf.sampleHeaders[sampleGen.value];
      console.log('    sample header', sh);
    }
  }
}

console.log('sample header example:', sf.sampleHeaders[0]);
console.log('instruments count', sf.instruments.length);

showPreset('Cello', 42);
const ph = sf.presetHeaders.find(p => p.preset === 42 && p.bank === 0);
const pbag = sf.presetZone[ph.presetBagIndex];
console.log('first cello preset zone instrument index', pbag.instrumentIndex);
showInstrument(pbag.instrumentIndex);

console.log('\nSampling data length', sf.samplingData.length);
