#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function midiToFreq(n, a4 = 440) {
  return a4 * Math.pow(2, (n - 69) / 12);
}

function freqToMidi(f, a4 = 440) {
  return 69 + 12 * Math.log2(f / a4);
}

function frequencyToNote(f, a4 = 440) {
  const n = freqToMidi(f, a4);
  const nearest = Math.round(n);
  const cents = (n - nearest) * 100;
  return { nearest, cents };
}

const known = [
  { label: 'E2', midi: 40, freq: 82.4069 },
  { label: 'A2', midi: 45, freq: 110.0 },
  { label: 'D3', midi: 50, freq: 146.8324 },
  { label: 'G3', midi: 55, freq: 195.9977 },
  { label: 'B3', midi: 59, freq: 246.9417 },
  { label: 'E4', midi: 64, freq: 329.6276 },
  { label: 'A4', midi: 69, freq: 440.0 },
];

for (const tone of known) {
  const derivedFreq = midiToFreq(tone.midi, 440);
  const centsFromNominal = 1200 * Math.log2(derivedFreq / tone.freq);
  const note = frequencyToNote(tone.freq, 440);

  console.log(`${tone.label}: midi=${tone.midi} derived=${derivedFreq.toFixed(4)}Hz centsVsNominal=${centsFromNominal.toFixed(4)} centsAtNominal=${note.cents.toFixed(6)}`);

  assert(Math.abs(derivedFreq - tone.freq) < 0.05, `${tone.label} frequency mapping drifted`);
  assert(note.nearest === tone.midi, `${tone.label} mapped to wrong MIDI`);
  assert(Math.abs(note.cents) < 0.2, `${tone.label} cents should be near 0`);
}

const a4 = frequencyToNote(440, 440);
assert(a4.nearest === 69 && Math.abs(a4.cents) < 1e-9, 'A4 must map to MIDI 69 with 0 cents');

console.log('A4 reference and guitar-note mapping checks passed.');
