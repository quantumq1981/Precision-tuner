class TunerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.analysisSize = opts.analysisSize || 4096;
    this.hopSize = opts.hopSize || 1024;
    this.zeroPadSize = opts.zeroPadSize || 16384;
    this.minFreq = opts.minFreq || 70;
    this.maxFreq = opts.maxFreq || 1200;
    this.yinThreshold = opts.yinThreshold || 0.12;
    this.energyThreshold = opts.energyThreshold || 1.2e-4;
    this.confidenceThreshold = opts.confidenceThreshold || 0.7;
    this.smoothingAlpha = opts.smoothingAlpha || 0.2;
    this.postIntervalMs = opts.postIntervalMs || 20;

    this.ringBuffer = new Float32Array(this.analysisSize);
    this.analysisBuffer = new Float32Array(this.analysisSize);
    this.windowed = new Float32Array(this.analysisSize);
    this.zeroPadded = new Float32Array(this.zeroPadSize);
    this.fftRe = new Float32Array(this.zeroPadSize);
    this.fftIm = new Float32Array(this.zeroPadSize);
    this.fftMag = new Float32Array(this.zeroPadSize / 2);
    this.diff = new Float32Array(this.analysisSize / 2 + 1);
    this.cmnd = new Float32Array(this.analysisSize / 2 + 1);

    this.writeIndex = 0;
    this.hopCounter = 0;
    this.lastOutputFreq = 0;
    this.lastPostMs = -1;

    this.hannWindow = new Float32Array(this.analysisSize);
    for (let i = 0; i < this.analysisSize; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.analysisSize - 1)));
    }

    this.initFilters(sampleRate);
    this.initFftTables(this.zeroPadSize);

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'config') return;
      if (typeof msg.smoothingAlpha === 'number') this.smoothingAlpha = Math.min(0.95, Math.max(0, msg.smoothingAlpha));
      if (typeof msg.yinThreshold === 'number') this.yinThreshold = Math.min(0.3, Math.max(0.05, msg.yinThreshold));
    };
  }

  initFilters(sr) {
    const hp = this.designBiquad('highpass', 80, 0.707, sr);
    const lp = this.designBiquad('lowpass', 1200, 0.707, sr);
    this.hp = { ...hp, x1: 0, x2: 0, y1: 0, y2: 0 };
    this.lp = { ...lp, x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  designBiquad(type, frequency, q, sr) {
    const w0 = 2 * Math.PI * frequency / sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * q);

    let b0; let b1; let b2; let a0; let a1; let a2;
    if (type === 'highpass') {
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = (1 + cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    } else {
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = (1 - cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    }

    const invA0 = 1 / a0;
    return { b0: b0 * invA0, b1: b1 * invA0, b2: b2 * invA0, a1: a1 * invA0, a2: a2 * invA0 };
  }

  applyBiquad(st, x) {
    const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
    st.x2 = st.x1;
    st.x1 = x;
    st.y2 = st.y1;
    st.y1 = y;
    return y;
  }

  initFftTables(n) {
    this.fftN = n;
    this.bitRev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let y = 0;
      for (let b = 0; b < bits; b++) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.bitRev[i] = y;
    }
  }

  runFft(input) {
    const n = this.fftN;
    const re = this.fftRe;
    const im = this.fftIm;

    for (let i = 0; i < n; i++) {
      re[this.bitRev[i]] = input[i];
      im[this.bitRev[i]] = 0;
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = 2 * Math.PI / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const even = start + j;
          const odd = even + half;
          const angle = -j * step;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const tre = cos * re[odd] - sin * im[odd];
          const tim = sin * re[odd] + cos * im[odd];
          const ur = re[even];
          const ui = im[even];
          re[odd] = ur - tre;
          im[odd] = ui - tim;
          re[even] = ur + tre;
          im[even] = ui + tim;
        }
      }
    }

    const halfN = n >> 1;
    for (let k = 0; k < halfN; k++) {
      const rr = re[k];
      const ii = im[k];
      this.fftMag[k] = Math.sqrt(rr * rr + ii * ii);
    }
  }

  yinEstimate(buf, sr) {
    const half = buf.length >> 1;
    const tauMin = Math.floor(sr / this.maxFreq);
    const tauMax = Math.min(half, Math.floor(sr / this.minFreq));

    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < half; j++) {
        const d = buf[j] - buf[j + tau];
        sum += d * d;
      }
      this.diff[tau] = sum;
    }

    this.cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += this.diff[tau];
      this.cmnd[tau] = running > 0 ? (this.diff[tau] * tau) / running : 1;
    }

    let tau = tauMin;
    while (tau <= tauMax) {
      if (this.cmnd[tau] < this.yinThreshold) {
        while (tau + 1 <= tauMax && this.cmnd[tau + 1] < this.cmnd[tau]) tau++;
        break;
      }
      tau++;
    }
    if (tau > tauMax) return { freq: 0, confidence: 0 };

    const t0 = Math.max(1, tau - 1);
    const t2 = Math.min(tauMax, tau + 1);
    const alpha = this.cmnd[t0];
    const beta = this.cmnd[tau];
    const gamma = this.cmnd[t2];
    const denom = alpha - 2 * beta + gamma;
    // p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)
    const p = Math.abs(denom) > 1e-12 ? 0.5 * (alpha - gamma) / denom : 0;
    const refinedTau = tau + p;
    return { freq: sr / refinedTau, confidence: 1 - beta };
  }

  spectralRefine(buf, coarse, sr) {
    for (let i = 0; i < this.analysisSize; i++) {
      this.windowed[i] = buf[i] * this.hannWindow[i];
    }
    this.zeroPadded.fill(0);
    this.zeroPadded.set(this.windowed);
    this.runFft(this.zeroPadded);

    const binHz = sr / this.zeroPadSize;
    const center = coarse / binHz;
    const start = Math.max(1, Math.floor(center * 0.5));
    const end = Math.min((this.zeroPadSize >> 1) - 2, Math.ceil(center * 1.6));

    let k = start;
    let best = this.fftMag[k];
    for (let i = start + 1; i <= end; i++) {
      const m = this.fftMag[i];
      if (m > best) {
        best = m;
        k = i;
      }
    }

    const alpha = this.fftMag[k - 1];
    const beta = this.fftMag[k];
    const gamma = this.fftMag[k + 1];
    const denom = alpha - 2 * beta + gamma;
    // p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)
    const p = Math.abs(denom) > 1e-12 ? 0.5 * (alpha - gamma) / denom : 0;
    return (k + p) * sr / this.zeroPadSize;
  }

  analyzeFrame() {
    let energy = 0;
    for (let i = 0; i < this.analysisSize; i++) energy += this.analysisBuffer[i] * this.analysisBuffer[i];
    energy /= this.analysisSize;
    if (energy < this.energyThreshold) return { frequency: null, confidence: 0 };

    const yin = this.yinEstimate(this.analysisBuffer, sampleRate);
    if (!Number.isFinite(yin.freq) || yin.freq < this.minFreq || yin.freq > this.maxFreq) return { frequency: null, confidence: 0 };

    const fftRefined = this.spectralRefine(this.analysisBuffer, yin.freq, sampleRate);
    const fused = yin.freq * 0.65 + fftRefined * 0.35;
    const smooth = this.lastOutputFreq > 0 ? this.lastOutputFreq + this.smoothingAlpha * (fused - this.lastOutputFreq) : fused;
    this.lastOutputFreq = smooth;

    const confidence = Math.max(0, Math.min(1, yin.confidence));
    if (confidence < this.confidenceThreshold) return { frequency: null, confidence };
    return { frequency: smooth, confidence };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const frame = input[0];
    for (let i = 0; i < frame.length; i++) {
      const filtered = this.applyBiquad(this.lp, this.applyBiquad(this.hp, frame[i]));
      this.ringBuffer[this.writeIndex] = filtered;
      this.writeIndex = (this.writeIndex + 1) % this.analysisSize;
      this.hopCounter++;

      if (this.hopCounter >= this.hopSize) {
        this.hopCounter = 0;
        for (let n = 0; n < this.analysisSize; n++) {
          const idx = (this.writeIndex + n) % this.analysisSize;
          this.analysisBuffer[n] = this.ringBuffer[idx];
        }

        const result = this.analyzeFrame();
        const timeMs = (currentFrame / sampleRate) * 1000;
        if (this.lastPostMs < 0 || timeMs - this.lastPostMs >= this.postIntervalMs) {
          this.lastPostMs = timeMs;
          this.port.postMessage({ type: 'pitch', timeMs, frequency: result.frequency, confidence: result.confidence });
        }
      }
    }

    return true;
  }
}

registerProcessor('tuner-processor', TunerProcessor);
