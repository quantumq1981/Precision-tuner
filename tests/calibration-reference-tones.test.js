#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createClassList() {
    return {
        add() {},
        remove() {},
        contains() { return false; }
    };
}

function createCanvasContext() {
    const noop = () => {};
    const context = {
        clearRect: noop,
        save: noop,
        restore: noop,
        translate: noop,
        rotate: noop,
        beginPath: noop,
        arc: noop,
        stroke: noop,
        fill: noop,
        fillRect: noop,
        moveTo: noop,
        lineTo: noop,
        createRadialGradient() {
            return { addColorStop: noop };
        },
        createLinearGradient() {
            return { addColorStop: noop };
        },
        fillText: noop,
        strokeText: noop,
        setLineDash: noop,
        measureText() { return { width: 0 }; }
    };

    return new Proxy(context, {
        get(target, prop) {
            if (!(prop in target)) target[prop] = noop;
            return target[prop];
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        }
    });
}

function createElement(id = '') {
    return {
        id,
        style: {},
        dataset: {},
        value: id === 'cal-volume' ? '0.5' : '440',
        textContent: '',
        innerHTML: '',
        disabled: false,
        width: 560,
        height: 560,
        className: '',
        classList: createClassList(),
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        setAttribute() {},
        getContext() { return createCanvasContext(); },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
}

function bootstrapDebugApi() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
    if (!scriptMatch) {
        throw new Error('Unable to locate inline script in index.html');
    }

    const elements = new Map();
    const document = {
        body: createElement('body'),
        createElement: tag => createElement(tag),
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, createElement(id));
            return elements.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {}
    };

    const AudioContext = function AudioContext() {
        return {
            state: 'running',
            sampleRate: 48000,
            destination: {},
            createAnalyser() {
                return {
                    fftSize: 4096,
                    smoothingTimeConstant: 0,
                    getFloatTimeDomainData(buffer) { buffer.fill(0); }
                };
            },
            createOscillator() {
                return {
                    type: 'sine',
                    frequency: { value: 0 },
                    connect() {},
                    start() {},
                    stop() {},
                    disconnect() {}
                };
            },
            createGain() {
                return {
                    gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                    connect() {},
                    disconnect() {}
                };
            }
        };
    };

    const sandbox = {
        console,
        Math,
        Date,
        Float32Array,
        Uint8Array,
        Int16Array,
        Array,
        Object,
        Number,
        String,
        Boolean,
        JSON,
        Map,
        Set,
        performance: { now: () => 0 },
        setTimeout,
        clearTimeout,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
        document,
        window: null
    };

    sandbox.window = {
        document,
        navigator: sandbox.navigator,
        performance: sandbox.performance,
        AudioContext,
        webkitAudioContext: AudioContext,
        requestAnimationFrame: sandbox.requestAnimationFrame,
        cancelAnimationFrame: sandbox.cancelAnimationFrame,
        addEventListener() {},
        removeEventListener() {}
    };

    vm.createContext(sandbox);
    vm.runInContext(scriptMatch[1], sandbox, { filename: 'index.html' });

    return sandbox.window.precisionTunerDebug;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function main() {
    const debugApi = bootstrapDebugApi();
    assert(debugApi, 'precisionTunerDebug was not initialized');

    const e2Gain = debugApi.getCalibrationSpeakerGain('E2');
    const a2Gain = debugApi.getCalibrationSpeakerGain('A2');
    const a4Gain = debugApi.getCalibrationSpeakerGain('A4');

    console.log(`Speaker gains @ 50% volume → E2=${e2Gain.toFixed(3)} A2=${a2Gain.toFixed(3)} A4=${a4Gain.toFixed(3)}`);

    assert(e2Gain > a2Gain, 'Expected E2 to receive more speaker gain than A2');
    assert(a2Gain > a4Gain, 'Expected A2 to receive more speaker gain than A4');
    assert(e2Gain >= 1.1, 'Expected E2 speaker gain to be strongly boosted');
    assert(a2Gain >= 1.0, 'Expected A2 speaker gain to be strongly boosted');

    const tones = [
        { label: 'E2', freq: 82.41 },
        { label: 'A2', freq: 110.00 }
    ];

    for (const tone of tones) {
        const result = debugApi.calSimulateCollection(tone.freq, 60);
        console.log(
            `${tone.label} simulated collection → collected=${result.collected} median=${result.median.toFixed(4)}Hz centsError=${result.centsError.toFixed(4)}`
        );

        assert(result.collected === 60, `${tone.label} did not collect all 60 simulated samples`);
        assert(Math.abs(result.centsError) < 0.1, `${tone.label} cents error exceeded calibration tolerance`);
    }

    console.log('Calibration reference tone checks passed.');
}

main();
