// Splits a continuous 16 kHz stream into speech chunks, cutting at pauses.
export const SAMPLE_RATE = 16000;

function rms(block) {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

export class Chunker {
  /**
   * @param {object} o
   * @param {string} o.speaker label stored with each segment ("Me", "Others", "")
   * @param {number} o.minChunkSec cut at a pause once the chunk is at least this long
   * @param {number} o.maxChunkSec hard cut length (Whisper handles up to 30 s)
   * @param {number} o.silenceThreshold RMS level below which audio counts as silence
   * @param {(chunk: {speaker:string, t:number, audio:Float32Array, voicedSec:number}) => void} o.onChunk
   */
  constructor({ speaker, minChunkSec, maxChunkSec, silenceThreshold, onChunk }) {
    this.speaker = speaker;
    this.minSamples = minChunkSec * SAMPLE_RATE;
    this.maxSamples = Math.min(maxChunkSec, 29) * SAMPLE_RATE;
    this.threshold = silenceThreshold;
    this.onChunk = onChunk;
    this.preRollSamples = 0.4 * SAMPLE_RATE;
    this.pauseSamples = 0.5 * SAMPLE_RATE;
    this.consumed = 0; // samples seen since start, used for timestamps
    this.reset();
  }

  reset() {
    this.blocks = [];
    this.length = 0;
    this.voiced = 0;
    this.trailingSilence = 0;
    this.chunkStart = this.consumed;
  }

  push(block) {
    const loud = rms(block) > this.threshold;
    this.blocks.push(block);
    this.length += block.length;
    this.consumed += block.length;

    if (loud) {
      this.voiced += block.length;
      this.trailingSilence = 0;
    } else {
      this.trailingSilence += block.length;
    }

    // No speech yet: keep only a short pre-roll so silence never piles up.
    if (this.voiced === 0) {
      while (this.length > this.preRollSamples && this.blocks.length > 1) {
        const dropped = this.blocks.shift();
        this.length -= dropped.length;
      }
      this.chunkStart = this.consumed - this.length;
      return;
    }

    const atPause = this.length >= this.minSamples && this.trailingSilence >= this.pauseSamples;
    if (atPause || this.length >= this.maxSamples) this.flush();
  }

  flush() {
    if (this.voiced >= 0.3 * SAMPLE_RATE) {
      const audio = new Float32Array(this.length);
      let off = 0;
      for (const b of this.blocks) {
        audio.set(b, off);
        off += b.length;
      }
      this.onChunk({
        speaker: this.speaker,
        t: Math.round((this.chunkStart / SAMPLE_RATE) * 1000),
        audio,
        voicedSec: this.voiced / SAMPLE_RATE
      });
    }
    this.reset();
  }
}

// Whisper tends to "hear" these in silence or noise.
const HALLUCINATIONS = /^(thank you\.?|thanks\.?|thanks for watching\.?!?|you|bye\.?|\.|okay\.?)$/i;

export function cleanTranscript(text, voicedSec) {
  let t = (text || '')
    .replace(/\[[^\]]*\]/g, ' ') // [BLANK_AUDIO], [Music]
    .replace(/\((?:music|applause|laughs?|silence|inaudible|static|noise)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) return '';
  if (voicedSec < 1.5 && HALLUCINATIONS.test(t)) return '';
  return t;
}
