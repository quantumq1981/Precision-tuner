# Technical Strategy Document

## Phase 1: Architectural Validation

### 1) Sample rate, FFT size, hop size, and latency/accuracy

**Rationale**

Frequency bin resolution for FFT is:

- `freq_bin_resolution = sampleRate / N`

Temporal responsiveness is governed by hop and window:

- hop latency (new estimate cadence): `hopSize / sampleRate`
- analysis lookback latency (window support): roughly `N / sampleRate`

Comparison (no zero-padding):

- At 48 kHz:
  - N=2048 → 23.44 Hz/bin, 42.67 ms window
  - N=4096 → 11.72 Hz/bin, 85.33 ms window
  - N=8192 → 5.86 Hz/bin, 170.67 ms window
- At 44.1 kHz:
  - N=2048 → 21.53 Hz/bin, 46.44 ms window
  - N=4096 → 10.77 Hz/bin, 92.88 ms window
  - N=8192 → 5.38 Hz/bin, 185.76 ms window

For guitar tuning, N=4096 is a good balance between low-note stability and responsiveness. N=2048 can be twitchy on E2/A2. N=8192 gives stronger low-end certainty but adds visible lag and higher CPU load.

Overlap trade-offs:

- 50% overlap (hop=N/2): lower CPU, slower updates.
- 75% overlap (hop=N/4): faster updates and smoother UI; more CPU.

Zero-padding does **not** reduce physical latency, but improves spectral peak interpolation density.

**Decision**

- `analysisSize = 4096`
- `hopSize = 1024` (75% overlap)
- UI update interval = `25 ms` (40 Hz)
- Zero-padding to `16384` for spectral refinement.

Expected cadence:

- 48 kHz hop cadence ≈ 21.33 ms
- 44.1 kHz hop cadence ≈ 23.22 ms

This meets balanced profile (<=25 ms UI updates) while maintaining ±1 cent potential when SNR is good.

### 2) Pitch detection algorithm selection

**Rationale**

- **Autocorrelation**: simple and quick; prone to octave ambiguity with harmonic-rich plucks.
- **AMDF**: fast and allocation-friendly; less robust under noise and can be less precise around minima.
- **YIN**: better octave-error resistance via CMND normalization, generally strongest monophonic guitar behavior at moderate CPU cost.

For precision tuning, YIN gives the best reliability across clean and moderately noisy inputs. We refine YIN with FFT peak interpolation to improve cent-level resolution and cross-check against harmonic confusion.

**Decision**

- Primary detector: **YIN (CMND)**.
- Thresholds:
  - `yinThreshold = 0.12`
  - confidence gate `>= 0.7`
- Lag range derived from band:
  - `tauMin = floor(sr / 1200)`
  - `tauMax = floor(sr / 70)`
- Failure handling:
  - Low RMS energy or confidence below gate ⇒ post `frequency: null`.
- Refinement:
  - Hann-windowed FFT around coarse YIN estimate (search neighborhood), then parabolic interpolation:
    - `p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)`
    - `f_refined = (k + p) * sampleRate / Npad`

### 3) Input conditioning and preprocessing

**Rationale**

Browser voice-processing features (AEC/NS/AGC) alter pitch envelope and harmonics and can destabilize tuning. We disable them and prefer mono input.

Band-pass 80–1200 Hz suppresses rumble and high squeak while preserving guitar fundamentals and key lower harmonics for robustness.

IIR biquads are low-latency and efficient in an AudioWorklet; RBJ-style coefficient generation is sample-rate aware and BIBO-stable when normalized and Q values remain sensible.

**Decision**

- `getUserMedia` constraints:
  - `echoCancellation: false`
  - `noiseSuppression: false`
  - `autoGainControl: false`
  - `channelCount: { ideal: 1 }`
- Worklet-side cascaded biquads:
  - 2nd-order high-pass @ 80 Hz, Q=0.707
  - 2nd-order low-pass @ 1200 Hz, Q=0.707
- Gain staging:
  - controlled gain node (default ~1.5x), keep below clipping.
- FFT windowing:
  - Hann window before zero-padded FFT refinement.

## Phase 2: Constraint implementation summary

- Heavy DSP is in `AudioWorkletProcessor` (`worklet/tuner-processor.js`).
- No ScriptProcessorNode and no AnalyserNode peak hunting.
- Allocation-free hot path:
  - typed arrays pre-allocated in constructor.
  - ring buffer + fixed-size analysis arrays.
  - no per-block dynamic resize in `process()`.
- Zero-padding applied from 4096 to 16384 before FFT.
- Parabolic interpolation implemented in both YIN valley refinement and FFT-bin refinement.
- A4 mapping uses exact formulas:
  - `n = 69 + 12 * log2(f / 440)`
  - `f = 440 * 2^((n - 69)/12)`
- Light temporal smoothing:
  - configurable 1-pole smoothing factor (`smoothingAlpha`, default 0.2).

## Phase 3: Validation plan and checklist

### Buffer / GC / overruns

- Verify all DSP arrays are created once in constructor.
- Confirm `process()` contains no `new` allocations.
- Ring index wraps modulo `analysisSize` only.

### Zero-padding verification

- Confirm `zeroPadded.set(windowed)` and remaining bins are zero.
- Effective interpolation grid:
  - at 48 kHz: 48k / 16384 = 2.93 Hz/bin (vs 11.72 Hz/bin at N=4096).

### A4 + note mapping checks

Unit tests cover:

- E2, A2, D3, G3, B3, E4, A4 mapping
- nearest MIDI and cents ≈ 0 at reference frequencies.

### Failure mode handling

- Silence/low-SNR returns `frequency: null`.
- low-confidence YIN returns `frequency: null`.
- octave mistakes reduced by YIN + spectral cross-check blend.

### Performance checks

- Observe stable UI at 40 Hz updates (25 ms timer).
- Verify no audible dropouts during live use at 44.1 kHz and 48 kHz.
- Track confidence/frequency stream and CPU in browser devtools.
