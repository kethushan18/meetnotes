// Local speech-to-text with transformers.js. Moonshine by default (fast, no 30 s padding),
// Whisper as fallback. Runs on the GPU (WebGPU) when available, otherwise on the CPU.
import { pipeline, env, LogLevel } from '@huggingface/transformers';
import { progressTracker } from './progress.js';

// The library warns about two harmless things we rely on on purpose: Silero VAD is loaded as a
// "custom" model (exactly as the official transformers.js examples do), and WeSpeaker uses the
// single model.onnx file. Show real errors only.
env.logLevel = LogLevel.ERROR;
env.allowLocalModels = false;
env.useBrowserCache = true; // downloaded once, then read from Chrome's cache
env.useWasmCache = false; // extension CSP blocks blob: module imports
// Resolved against this script's own URL so it works in pages and in the Web Worker alike.
const base = new URL('./', self.location.href);
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('ort/ort-wasm-simd-threaded.asyncify.mjs', base).href,
  wasm: new URL('ort/ort-wasm-simd-threaded.asyncify.wasm', base).href
};
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  : 1;

export { env };

export async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** True when files for this model are already in Chrome's cache (so no download is needed). */
export async function isCached(modelId) {
  try {
    if (!(await caches.has('transformers-cache'))) return false;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes(modelId) && r.url.includes('.onnx'));
  } catch {
    return false;
  }
}

// Same as the transformers.js moonshine-web / realtime-whisper examples: keep the encoder at fp32.
function dtypeFor(device) {
  return device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'fp32', decoder_model_merged: 'q8' };
}

export class Transcriber {
  /**
   * @param {object} o
   * @param {string} o.model preferred model id
   * @param {string} o.fallback model id used if the preferred one fails
   * @param {'auto'|'webgpu'|'wasm'} [o.device]
   * @param {(pct:number,totalBytes:number)=>void} [o.onProgress]
   * @param {(msg:string)=>void} [o.onStatus]
   */
  constructor({ model, fallback, device = 'auto', onProgress, onStatus }) {
    this.wanted = model;
    this.fallback = fallback;
    this.devicePref = device;
    this.onProgress = onProgress || (() => {});
    this.onStatus = onStatus || (() => {});
    this.asr = null;
    this.model = null;
    this.device = null;
    this.loading = null;
  }

  async _try(model, device) {
    const asr = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: dtypeFor(device),
      progress_callback: progressTracker(this.onProgress)
    });
    // Warm-up run (as in the examples): compiles GPU shaders now, and surfaces GPU
    // problems here so the CPU fallback can take over before the meeting starts.
    await asr(new Float32Array(16000), /moonshine/i.test(model) ? { max_new_tokens: 4 } : {});
    this.asr = asr;
    this.model = model;
    this.device = device;
    return asr;
  }

  async load() {
    if (this.asr) return this.asr;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const gpu = this.devicePref !== 'wasm' && (await hasWebGPU());
      const devices = this.devicePref === 'webgpu' || (this.devicePref === 'auto' && gpu) ? ['webgpu', 'wasm'] : ['wasm'];
      const models = [this.wanted, this.fallback].filter((m, i, a) => m && a.indexOf(m) === i);
      let lastErr;
      for (const model of models) {
        for (const device of devices) {
          try {
            this.onStatus((await isCached(model)) ? 'Starting speech engine...' : 'Downloading speech model (one time)...');
            return await this._try(model, device);
          } catch (e) {
            console.warn(`Speech model ${model} on ${device} failed`, e);
            lastErr = e;
          }
        }
      }
      throw lastErr || new Error('No speech model could be loaded');
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async transcribe(audio) {
    const asr = await this.load();
    // Moonshine budgets 6 tokens per whole second by default, which gives 0 tokens under 1 s.
    const sec = audio.length / 16000;
    const opts = /moonshine/i.test(this.model) ? { max_new_tokens: Math.max(12, Math.ceil(sec * 7)) } : {};
    const out = await asr(audio, opts);
    return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
  }
}
