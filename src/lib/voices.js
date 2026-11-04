// Pure voice-matching logic (no model code), so it can be unit tested.
// Cosine similarity needed to call two clips the same voice. Set to lean towards splitting:
// a person asked about twice is fixed with one tap (same name merges the voices), while two
// people merged into one silently mislabels the transcript.
export const VOICE_THRESHOLDS = { strict: 0.55, normal: 0.45, loose: 0.35 };

export function normalise(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Online clustering of voices. Each speaker keeps a running (unnormalised) sum of embeddings;
 * the centroid is that sum normalised.
 */
export class SpeakerTracker {
  constructor({ threshold = VOICE_THRESHOLDS.normal, minVoicedSec = 1.0 } = {}) {
    this.threshold = threshold;
    this.minVoicedSec = minVoicedSec;
    this.speakers = []; // { id, sum, centroid, count }
    this.next = 1;
    this.last = null;
  }

  /**
   * @param {Float32Array|null} emb normalised embedding, or null if the chunk was too short to embed
   * @param {number} voicedSec seconds of speech in the chunk
   * @returns {{ id: string, isNew: boolean, score: number }}
   */
  assign(emb, voicedSec) {
    if (!emb) {
      if (this.last) return { id: this.last, isNew: false, score: 0 };
      return this._create(null);
    }
    let best = null;
    let bestScore = -1;
    for (const s of this.speakers) {
      if (!s.centroid) continue;
      const sc = cosine(emb, s.centroid);
      if (sc > bestScore) {
        bestScore = sc;
        best = s;
      }
    }
    if (best && bestScore >= this.threshold) {
      // Only strong matches refine the voice profile, so a clip with two people in it
      // can't slowly drag one person's profile towards someone else.
      if (bestScore >= this.threshold + 0.08) this._add(best, emb);
      this.last = best.id;
      return { id: best.id, isNew: false, score: bestScore };
    }
    // Too little speech to be sure it's a new voice: keep it with the closest one.
    if (voicedSec < this.minVoicedSec && (best || this.last)) {
      const id = best ? best.id : this.last;
      this.last = id;
      return { id, isNew: false, score: bestScore };
    }
    // A voice-less placeholder (from a too-short first chunk) adopts the first real voice.
    const blank = this.speakers.find((s) => !s.centroid);
    if (blank) {
      this._add(blank, emb);
      this.last = blank.id;
      return { id: blank.id, isNew: false, score: bestScore };
    }
    return this._create(emb, bestScore);
  }

  _create(emb, score = 0) {
    const id = 's' + this.next++;
    const s = { id, sum: emb ? Float32Array.from(emb) : null, centroid: emb, count: emb ? 1 : 0 };
    this.speakers.push(s);
    this.last = id;
    return { id, isNew: true, score };
  }

  _add(s, emb) {
    if (!s.sum) {
      s.sum = Float32Array.from(emb);
    } else {
      for (let i = 0; i < emb.length; i++) s.sum[i] += emb[i];
    }
    s.count++;
    s.centroid = normalise(s.sum);
  }

  /** The user said this clip belongs to speaker `id` (creating that voice if it's new). */
  teach(id, emb) {
    if (!emb) return;
    let s = this.speakers.find((x) => x.id === id);
    if (!s) {
      s = { id, sum: null, centroid: null, count: 0 };
      this.speakers.push(s);
    }
    this._add(s, emb);
    this.last = id;
  }

  /** The user said two voices are the same person. */
  merge(fromId, intoId) {
    const from = this.speakers.find((s) => s.id === fromId);
    const into = this.speakers.find((s) => s.id === intoId);
    if (!from || !into || from === into) return;
    if (from.sum) {
      if (!into.sum) into.sum = Float32Array.from(from.sum);
      else for (let i = 0; i < from.sum.length; i++) into.sum[i] += from.sum[i];
      into.centroid = normalise(into.sum);
      into.count += from.count;
    }
    this.speakers = this.speakers.filter((s) => s !== from);
    if (this.last === fromId) this.last = intoId;
  }
}

// ---------- echo handling ----------
const words = (t) => (t.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 1);

/** Word overlap between two lines (0..1), used to drop mic lines that are just speaker echo. */
export function overlap(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}
