const fs = require('fs');
const path = require('path');
const {
  parse,
  createGeneraterObject,
  defaultInstrumentZone,
  getInstrumentGenerators,
} = require('@ryohey/sf2parser');
const { WaveFile } = require('wavefile');

const ROOT = path.join(__dirname, '..');
const SF2_PATH = path.join(ROOT, 'MS Basic.sf2');
const OUT_DIR = path.join(ROOT, 'assets', 'soundbank');
const NOTE_DURATION = 3.0; // seconds per note in the combined WAV
const FADE_OUT = 0.05; // seconds

const INSTRUMENTS = [
  { color: '#E81B1B', name: 'Violin',  emoji: '🎻', program: 40, sustain: true },
  { color: '#F39C12', name: 'Trumpet', emoji: '🎺', program: 56, sustain: true },
  { color: '#F1C40F', name: 'Piano',   emoji: '🎹', program: 0,  sustain: false },
  { color: '#2ECC71', name: 'Flute',   emoji: '🪈', program: 73, sustain: true },
  { color: '#1ABC9C', name: 'Harp',    emoji: '🎵', program: 46, sustain: false },
  { color: '#3498DB', name: 'Cello',   emoji: '🎻', program: 42, sustain: true },
  { color: '#9B59B6', name: 'Clarinet',emoji: '🎷', program: 71, sustain: true },
  { color: '#E91E63', name: 'Synth',   emoji: '🎛️', program: 80, sustain: true },
];

const NOTE_COUNT = 25; // C4..C6 inclusive (24 semitones)

function toSafeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function lerpSample(arr, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = Number.isFinite(arr[i]) ? arr[i] : 0;
  const b = Number.isFinite(arr[i + 1]) ? arr[i + 1] : 0;
  return a + (b - a) * f;
}

function removeUndefined(obj) {
  const result = {};
  for (const key in obj) {
    if (obj[key] !== undefined) result[key] = obj[key];
  }
  return result;
}

function getPresetZoneGeneratorRanges(parsed, presetHeader) {
  const startBagIndex = presetHeader.presetBagIndex;
  const nextBagIndex = parsed.presetHeaders
    .map(p => p.presetBagIndex)
    .filter(b => b > startBagIndex)
    .sort((a, b) => a - b)[0] ?? parsed.presetZone.length;

  const ranges = [];
  for (let i = startBagIndex; i < nextBagIndex; i++) {
    const bag = parsed.presetZone[i];
    const nextBag = parsed.presetZone[i + 1];
    const start = bag.presetGeneratorIndex;
    const end = nextBag ? nextBag.presetGeneratorIndex : parsed.presetGenerators.length;
    ranges.push({ bagIndex: i, generators: parsed.presetGenerators.slice(start, end) });
  }
  return ranges;
}

function getInstrumentKey(parsed, bank, program, key, velocity = 100) {
  const presetHeaderIndex = parsed.presetHeaders.findIndex(p => p.bank === bank && p.preset === program);
  if (presetHeaderIndex < 0) return null;
  const presetHeader = parsed.presetHeaders[presetHeaderIndex];

  const zones = getPresetZoneGeneratorRanges(parsed, presetHeader);
  let globalPreset = null;
  let selectedInstrument = null;
  for (const zone of zones) {
    const gen = createGeneraterObject(zone.generators);
    if (gen.instrument === undefined) {
      globalPreset = { ...(globalPreset || {}), ...gen };
      continue;
    }
    const inKey = !gen.keyRange || (key >= gen.keyRange.lo && key <= gen.keyRange.hi);
    const inVel = !gen.velRange || (velocity >= gen.velRange.lo && velocity <= gen.velRange.hi);
    if (inKey && inVel) {
      selectedInstrument = gen.instrument;
      globalPreset = { ...(globalPreset || {}), ...gen };
      break;
    }
  }
  if (selectedInstrument === null) return null;

  const instrumentZones = getInstrumentGenerators(parsed, selectedInstrument).map(createGeneraterObject);
  let globalInstrument = null;
  const zone = instrumentZones.find(z => {
    if (z.sampleID === undefined) {
      globalInstrument = { ...(globalInstrument || {}), ...z };
      return false;
    }
    const inKey = !z.keyRange || (key >= z.keyRange.lo && key <= z.keyRange.hi);
    const inVel = !z.velRange || (velocity >= z.velRange.lo && velocity <= z.velRange.hi);
    return inKey && inVel;
  });
  if (!zone || zone.sampleID === undefined) return null;

  const gen = {
    ...defaultInstrumentZone,
    ...removeUndefined(globalInstrument || {}),
    ...removeUndefined(zone),
  };

  const sample = parsed.samples[gen.sampleID];
  const sampleHeader = parsed.sampleHeaders[gen.sampleID];
  const tune = gen.coarseTune + gen.fineTune / 100;
  const basePitch = tune + sampleHeader.pitchCorrection / 100 - (gen.overridingRootKey ?? sampleHeader.originalPitch);
  const scaleTuning = gen.scaleTuning / 100;

  return {
    sample,
    sampleRate: sampleHeader.sampleRate,
    sampleName: sampleHeader.sampleName,
    sampleModes: gen.sampleModes,
    playbackRate: (k) => Math.pow(2, (k + basePitch) * scaleTuning / 12),
    start: gen.startAddrsCoarseOffset * 32768 + gen.startAddrsOffset,
    end: gen.endAddrsCoarseOffset * 32768 + gen.endAddrsOffset,
    loopStart: sampleHeader.loopStart + gen.startloopAddrsCoarseOffset * 32768 + gen.startloopAddrsOffset,
    loopEnd: sampleHeader.loopEnd + gen.endloopAddrsCoarseOffset * 32768 + gen.endloopAddrsOffset,
  };
}

function renderNote(zone, key, duration) {
  const sampleRate = zone.sampleRate;
  const source = zone.sample;
  const rate = zone.playbackRate(key);
  const startOffset = Math.max(0, zone.start || 0);
  const endOffset = zone.end || 0;
  const playEnd = source.length + endOffset; // endOffset is usually negative to trim silence
  const loop = zone.sampleModes === 1 || zone.sampleModes === 3;
  const loopLen = zone.loopEnd - zone.loopStart;

  const totalSamples = Math.floor(duration * sampleRate);
  const fadeSamples = Math.floor(FADE_OUT * sampleRate);
  const out = new Int16Array(totalSamples);

  let pos = startOffset;
  for (let i = 0; i < totalSamples; i++) {
    if (loop && loopLen > 0) {
      while (pos >= zone.loopEnd) pos -= loopLen;
    }
    if (!loop && pos >= playEnd) {
      out[i] = 0;
      continue;
    }
    let amp = 1;
    if (i >= totalSamples - fadeSamples) {
      amp = (totalSamples - i) / fadeSamples;
    }
    const s = lerpSample(source, pos) * amp;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    pos += rate;
  }

  return { samples: out, sampleRate };
}

function main() {
  console.log('Parsing SF2 (this may take a moment)...');
  const data = new Uint8Array(fs.readFileSync(SF2_PATH));
  const parsed = parse(data);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = {
    baseUrl: 'assets/soundbank',
    noteDuration: NOTE_DURATION,
    noteCount: NOTE_COUNT,
    instruments: {},
    fallback: {},
  };

  for (const inst of INSTRUMENTS) {
    const safe = toSafeName(inst.name);
    console.log(`\nRendering ${inst.name} (program ${inst.program})...`);

    const notes = [];
    let actualSampleRate = 44100;

    for (let semitone = 0; semitone < NOTE_COUNT; semitone++) {
      const key = 60 + semitone; // C4 = MIDI 60
      const zone = getInstrumentKey(parsed, 0, inst.program, key, 100);
      if (!zone) {
        console.warn(`  No sample for ${inst.name} note ${key}, using silence`);
        notes.push(new Int16Array(Math.floor(NOTE_DURATION * actualSampleRate)).fill(0));
        continue;
      }
      actualSampleRate = zone.sampleRate;
      const note = renderNote(zone, key, NOTE_DURATION);
      notes.push(note.samples);
      console.log(`  ${inst.name} ${key} -> ${zone.sampleName}`);
    }

    const noteSamples = Math.floor(NOTE_DURATION * actualSampleRate);
    const combined = new Int16Array(NOTE_COUNT * noteSamples);
    for (let i = 0; i < notes.length; i++) {
      combined.set(notes[i].subarray(0, noteSamples), i * noteSamples);
    }

    const wav = new WaveFile();
    wav.fromScratch(1, actualSampleRate, '16', combined);
    const wavPath = path.join(OUT_DIR, `${safe}.wav`);
    fs.writeFileSync(wavPath, wav.toBuffer());
    console.log(`  Wrote ${wavPath} (${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)} MB)`);

    manifest.instruments[inst.color] = {
      name: inst.name,
      emoji: inst.emoji,
      program: inst.program,
      file: `assets/soundbank/${safe}.wav`,
      sustain: inst.sustain,
    };
  }

  manifest.fallback = {
    '#E81B1B': { name: 'Violin',  emoji: '🎻', type: 'sawtooth',  attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.40 },
    '#F39C12': { name: 'Trumpet', emoji: '🎺', type: 'square',    attack: 0.02, decay: 0.10, sustain: 0.70, release: 0.30 },
    '#F1C40F': { name: 'Piano',   emoji: '🎹', type: 'triangle',  attack: 0.005, decay: 0.20, sustain: 0.10, release: 0.30 },
    '#2ECC71': { name: 'Flute',   emoji: '🪈', type: 'sine',      attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.30 },
    '#1ABC9C': { name: 'Harp',    emoji: '🎵', type: 'triangle',  attack: 0.005, decay: 0.30, sustain: 0.10, release: 0.60 },
    '#3498DB': { name: 'Cello',   emoji: '🎻', type: 'sawtooth',  attack: 0.08, decay: 0.15, sustain: 0.70, release: 0.50 },
    '#9B59B6': { name: 'Clarinet',emoji: '🎷', type: 'square',    attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.30 },
    '#E91E63': { name: 'Synth',   emoji: '🎛️', type: 'sawtooth',  attack: 0.01, decay: 0.10, sustain: 0.50, release: 0.40 },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('\nWrote manifest.json');
}

main();
