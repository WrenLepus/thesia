const fs = require('fs');
const path = require('path');
const { SoundFont2 } = require('soundfont2');

const sf2Path = path.join(__dirname, '..', 'MS Basic.sf2');
console.log('Loading', sf2Path, '...');
const buffer = fs.readFileSync(sf2Path);
console.log('File size MB:', (buffer.length / 1024 / 1024).toFixed(1));

const sf = SoundFont2.from(buffer);
console.log('Presets count:', sf.presets.length);
console.log('Instruments count:', sf.instruments.length);
console.log('Samples count:', sf.samples.length);

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
  const preset = sf.presets.find(p => p.header.bank === t.bank && p.header.preset === t.prog);
  if (!preset) {
    console.log('NOT FOUND', t.name, t);
    continue;
  }
  console.log('\nFOUND', t.name, 'preset', preset.header.preset, 'bank', preset.header.bank, 'bags', preset.bags.length);
  for (let i = 0; i < Math.min(3, preset.bags.length); i++) {
    const bag = preset.bags[i];
    console.log('  bag', i, 'instrument', bag.instrument?.header?.name, 'zones', bag.instrument?.bags?.length);
  }
}
