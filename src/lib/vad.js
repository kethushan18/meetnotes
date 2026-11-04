// Silero VAD segmenter, set up like the transformers.js moonshine-web example
// (512-sample frames, 0.3 on / 0.1 off, 400 ms min silence, 80 ms padding, 250 ms min speech),
// plus Meetily's trick of splitting long utterances at the quietest point instead of a hard cut.
import { AutoModel, Tensor } from '@huggingface/transformers';

export const SR = 16000;
const F = 512; // 32 ms frames
const ON = 0.3; // start speech above this probability
const OFF = 0.1; // keep speech while above this
const MIN_SILENCE = 400 * 16; // samples of silence that end an utterance
const PAD = 80 * 16; // padding kept either side
const MIN_SPEECH = 250 * 16; // shorter blips are dropped
const PRE_FRAMES = Math.ceil(PAD / F);
const SPLIT_SEARCH = 3 * SR; // look back this far for the quietest split point

export const VAD_MODEL = 'onnx-community/silero-vad';
let modelPromise = null;
export function loadVad(progress_callback) {
  if (!modelPromise) {
    modelPromise = AutoModel.from_pretrained(VAD_MODEL, {
      config: { model_type: 'custom' },
      dtype: 'fp32',
      device: 'wasm',
      progress_callback
    });
    modelPromise.catch(() => (modelPromise = null));
  }
  return modelPromise;
}

export class SileroSegmenter {
  /**
   * @param {object} o
   * @param {number} o.maxSec longest utterance before it is split (Whisper/Moonshine like <= 30 s)
   * @param {(seg:{audio:Float32Array, speech:Float32Array, t:number, voicedSec:number})=>void} o.onSegment
   */
  constructor({ maxSec = 10, onSegment }) {
    this.max = Math.round(maxSec * SR);
    this.onSegment = onSegment;
    this.state = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
    this.sr = new Tensor('int64', BigInt64Array.from([16000n]), []);
    this.rest = new Float32Array(0);
    this.prev = []; // pre-roll frames
    this.frames = []; // { f, p } current utterance
    this.rec = false;
    this.t = 0; // samples consumed
    this.silence = 0;
    this.chain = Promise.resolve();
  }

  /** Feed audio in order. Calls are chained so frames never run out of order. */
  push(block) {
    this.chain = this.chain.then(() => this._push(block)).catch((e) => console.error('VAD', e));
    return this.chain;
  }

  async _push(block) {
    const a = new Float32Array(this.rest.length + block.length);
    a.set(this.rest);
    a.set(block, this.rest.length);
    let i = 0;
    for (; i + F <= a.length; i += F) await this._frame(a.slice(i, i + F));
    this.rest = a.slice(i);
  }

  async _frame(f) {
    const vad = await loadVad();
    const { output, stateN } = await vad({ input: new Tensor('float32', f, [1, F]), sr: this.sr, state: this.state });
    this.state = stateN;
    this.t += F;
    const p = output.data[0];
    const speech = p > ON || (this.rec && p >= OFF);

    if (!this.rec) {
      if (!speech) {
        this.prev.push({ f, p });
        if (this.prev.length > PRE_FRAMES) this.prev.shift();
        return;
      }
      this.rec = true;
      this.frames = [...this.prev, { f, p }];
      this.prev = [];
      this.silence = 0;
      this.start = this.t - this.frames.length * F;
      return;
    }

    this.frames.push({ f, p });
    this.silence = speech ? 0 : this.silence + F;
    if (this.silence >= MIN_SILENCE) this._emit(this.frames.length - Math.max(0, Math.floor((this.silence - PAD) / F)), true);
    else if (this.frames.length * F >= this.max) this._splitAtQuietest();
  }

  // Too long: cut at the least speech-like frame in the last few seconds and keep going.
  _splitAtQuietest() {
    const n = this.frames.length;
    const from = Math.max(1, n - Math.floor(SPLIT_SEARCH / F));
    let cut = n;
    let low = Infinity;
    for (let k = from; k < n; k++) {
      if (this.frames[k].p < low) {
        low = this.frames[k].p;
        cut = k + 1;
      }
    }
    this._emit(cut, false);
  }

  /** Emits frames[0..count) as one utterance; the rest (if any) starts the next one. */
  _emit(count, endOfSpeech) {
    const used = this.frames.slice(0, count);
    const left = this.frames.slice(count);
    const audio = new Float32Array(used.length * F);
    used.forEach((x, k) => audio.set(x.f, k * F));
    const speechFrames = used.filter((x) => x.p >= ON);
    const speech = new Float32Array(speechFrames.length * F);
    speechFrames.forEach((x, k) => speech.set(x.f, k * F));
    const voiced = used.filter((x) => x.p >= OFF).length * F;
    if (voiced >= MIN_SPEECH) {
      this.onSegment({ audio, speech, t: Math.round(this.start / 16), voicedSec: voiced / SR });
    }
    const nextStart = this.start + count * F;
    if (endOfSpeech || !left.length) {
      this.rec = false;
      this.frames = [];
      this.prev = left.slice(-PRE_FRAMES);
    } else {
      this.frames = left;
      this.start = nextStart;
    }
    this.silence = 0;
  }

  /** Stop: emit whatever is in progress. */
  async flush() {
    await this.chain;
    if (this.rec && this.frames.length) this._emit(this.frames.length, true);
  }
}
