const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const GUITAR_STRINGS = [
  { label: 'E2', midi: 40 },
  { label: 'A2', midi: 45 },
  { label: 'D3', midi: 50 },
  { label: 'G3', midi: 55 },
  { label: 'B3', midi: 59 },
  { label: 'E4', midi: 64 },
];

const state = {
  running: false,
  audioContext: null,
  source: null,
  stream: null,
  workletNode: null,
  gainNode: null,
  refA4: 440,
  gain: 1.5,
  smoothingAlpha: 0.2,
  latestPitch: null,
  latestConfidence: 0,
  latestTimeMs: 0,
  uiIntervalId: null,
};

const canvas = document.getElementById('strobe-canvas');
const ctx2d = canvas.getContext('2d');
const elNote = document.getElementById('note-name');
const elOctave = document.getElementById('note-octave');
const elHint = document.getElementById('play-hint');
const elFreq = document.getElementById('freq-display');
const elCents = document.getElementById('cents-display');
const elTarget = document.getElementById('target-display');
const elNeedle = document.getElementById('cents-needle');
const elStatus = document.getElementById('status-msg');
const elError = document.getElementById('error-box');
const btnStart = document.getElementById('btn-start');
const refHzEl = document.getElementById('ref-hz');
const gainSlider = document.getElementById('gain-slider');
const gainValEl = document.getElementById('gain-val');
const stringRow = document.getElementById('string-row');

function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

function frequencyToNote(freq, a4 = 440) {
  const n = freqToMidi(freq, a4);
  const nearest = Math.round(n);
  const cents = (n - nearest) * 100;
  const noteName = NOTE_NAMES[((nearest % 12) + 12) % 12];
  const octave = Math.floor(nearest / 12) - 1;
  const targetFrequency = midiToFreq(nearest, a4);
  return { noteName, octave, midi: nearest, cents, targetFrequency };
}

function drawStrobe(cents, active) {
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.clearRect(0, 0, w, h);
  ctx2d.fillStyle = '#050f05';
  ctx2d.beginPath();
  ctx2d.arc(w / 2, h / 2, 148, 0, Math.PI * 2);
  ctx2d.fill();

  const speed = active ? Math.max(-1, Math.min(1, cents / 50)) : 0;
  const base = performance.now() * 0.01 * speed;

  for (let ring = 0; ring < 4; ring++) {
    const radius = 40 + ring * 24;
    const segs = 12 + ring * 6;
    const alpha = active ? 0.9 - ring * 0.15 : 0.2;
    ctx2d.strokeStyle = `rgba(0,255,120,${alpha})`;
    ctx2d.lineWidth = 8;
    for (let s = 0; s < segs; s += 2) {
      const a0 = (s / segs) * Math.PI * 2 + base * (ring + 1);
      const a1 = ((s + 1) / segs) * Math.PI * 2 + base * (ring + 1);
      ctx2d.beginPath();
      ctx2d.arc(w / 2, h / 2, radius, a0, a1);
      ctx2d.stroke();
    }
  }
}

function updateUiFromPitch() {
  const freq = state.latestPitch;
  if (!freq || state.latestConfidence < 0.7) {
    drawStrobe(0, false);
    elNote.textContent = '--';
    elOctave.textContent = '';
    elHint.textContent = state.running ? 'PLAY A NOTE' : 'PRESS START';
    elFreq.textContent = '--- Hz';
    elCents.textContent = '+0.0';
    elTarget.textContent = '--- Hz';
    elNeedle.style.left = '50%';
    return;
  }

  const n = frequencyToNote(freq, state.refA4);
  drawStrobe(n.cents, true);
  elNote.textContent = n.noteName;
  elOctave.textContent = n.octave;
  elHint.textContent = Math.abs(n.cents) < 3 ? 'IN TUNE' : n.cents > 0 ? 'SHARP' : 'FLAT';
  elFreq.textContent = `${freq.toFixed(2)} Hz`;
  elCents.textContent = `${n.cents >= 0 ? '+' : ''}${n.cents.toFixed(2)}`;
  elTarget.textContent = `${n.targetFrequency.toFixed(2)} Hz`;

  const needlePct = Math.max(0, Math.min(100, n.cents + 50));
  elNeedle.style.left = `${needlePct}%`;
}

async function ensureAudioContextResumed() {
  if (!state.audioContext) return;
  if (state.audioContext.state === 'suspended') {
    await state.audioContext.resume();
  }
}

async function start() {
  try {
    elError.classList.remove('show');
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
      },
      video: false,
    });

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await ensureAudioContextResumed();

    await state.audioContext.audioWorklet.addModule('./worklet/tuner-processor.js');
    state.source = state.audioContext.createMediaStreamSource(state.stream);
    state.gainNode = state.audioContext.createGain();
    state.gainNode.gain.value = state.gain;

    state.workletNode = new AudioWorkletNode(state.audioContext, 'tuner-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        analysisSize: 4096,
        hopSize: 1024,
        zeroPadSize: 16384,
        minFreq: 70,
        maxFreq: 1200,
        yinThreshold: 0.12,
        confidenceThreshold: 0.7,
        smoothingAlpha: state.smoothingAlpha,
        postIntervalMs: 20,
      },
    });

    state.workletNode.port.onmessage = (event) => {
      if (event.data?.type !== 'pitch') return;
      state.latestPitch = event.data.frequency;
      state.latestConfidence = event.data.confidence ?? 0;
      state.latestTimeMs = event.data.timeMs ?? 0;
    };

    state.source.connect(state.gainNode);
    state.gainNode.connect(state.workletNode);
    // Connect to destination with zero gain to keep graph alive on Safari.
    const silent = state.audioContext.createGain();
    silent.gain.value = 0;
    state.workletNode.connect(silent).connect(state.audioContext.destination);

    state.running = true;
    btnStart.textContent = 'Stop';
    btnStart.className = 'btn btn-stop';
    elStatus.textContent = 'Listening (worklet active)';
    state.uiIntervalId = setInterval(updateUiFromPitch, 25);
  } catch (error) {
    elError.classList.add('show');
    elStatus.textContent = 'Microphone access failed';
    console.error(error);
  }
}

async function stop() {
  state.running = false;
  if (state.uiIntervalId) {
    clearInterval(state.uiIntervalId);
    state.uiIntervalId = null;
  }

  if (state.workletNode) {
    state.workletNode.port.onmessage = null;
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.gainNode) {
    state.gainNode.disconnect();
    state.gainNode = null;
  }
  if (state.source) {
    state.source.disconnect();
    state.source = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }

  state.latestPitch = null;
  state.latestConfidence = 0;
  btnStart.textContent = 'Start';
  btnStart.className = 'btn btn-start';
  elStatus.textContent = 'Press START to begin';
  updateUiFromPitch();
}

function buildStringButtons() {
  stringRow.innerHTML = '';
  GUITAR_STRINGS.forEach((s) => {
    const button = document.createElement('button');
    button.className = 'string-btn';
    button.innerHTML = `<span class="str-note">${s.label}</span><span class="str-freq">${midiToFreq(s.midi, state.refA4).toFixed(2)} Hz</span>`;
    stringRow.appendChild(button);
  });
}

btnStart.addEventListener('click', async () => {
  if (!state.running) {
    await start();
  } else {
    await stop();
  }
});

refHzEl.addEventListener('input', () => {
  const value = Number(refHzEl.value);
  if (!Number.isFinite(value) || value < 380 || value > 500) return;
  state.refA4 = value;
  buildStringButtons();
});

gainSlider.addEventListener('input', () => {
  const value = Number(gainSlider.value);
  state.gain = value;
  gainValEl.textContent = `×${value.toFixed(1)}`;
  if (state.gainNode) state.gainNode.gain.value = value;
});

window.addEventListener('pointerdown', () => {
  ensureAudioContextResumed().catch(() => {});
}, { passive: true });

buildStringButtons();
updateUiFromPitch();

// Example A4 check:
// n = 69 + 12 * log2(440/440) = 69, cents = 0.
// E2 check target frequency from midi 40 = 82.4069 Hz.
window.precisionTunerDebug = {
  frequencyToNote,
  midiToFreq,
  freqToMidi,
};
