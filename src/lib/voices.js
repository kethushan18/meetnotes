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
 * Voice clustering for one meeting.
 *
 * Live: each clip goes to the closest known voice, or starts a new one if it matches nothing
 * (never more than `maxSpeakers` voices once the number of people is known). Voices that turn
 * out to be the same person are merged as the meeting goes (`consolidate`), and at the end
 * every clip is re-sorted against the final voices (`finalize`), the way batch diarization
 * re-clusters a whole recording. Voices the user named are never merged with each other.
 */
export class SpeakerTracker {
  constructor({ threshold = VOICE_THRESHOLDS.normal, minNewSec = 3, maxSpeakers = 0 } = {}) {
    this.threshold = threshold;
    // Short clips ("yeah", "this is good") give unreliable fingerprints, so only a clip with
    // at least this much speech may start a new voice. Shorter ones join the closest voice.
    this.minNewSec = minNewSec;
    this.mergeThreshold = Math.min(0.9, threshold + 0.3);
    this.maxSpeakers = maxSpeakers; // 0 = unknown
    this.speakers = []; // { id, sum, centroid, count, sec, name }
    this.next = 1;
    this.last = null;
  }

  get voices() {
    return this.speakers.filter((s) => s.centroid);
  }
  _get(id) {
    return this.speakers.find((s) => s.id === id);
  }
  _best(emb, among = this.speakers) {
    let best = null;
    let score = -1;
    for (const s of among) {
      if (!s.centroid) continue;
      const sc = cosine(emb, s.centroid);
      if (sc > score) {
        score = sc;
        best = s;
      }
    }
    return { best, score };
  }

  /**
   * @param {Float32Array|null} emb normalised embedding, or null if the clip was too short
   * @param {number} sec seconds of speech in the clip
   * @returns {{ id: string, isNew: boolean, score: number }}
   */
  assign(emb, sec) {
    if (!emb) {
      const id = this.last || this.voices[0]?.id || this._create(null, 0).id;
      this._get(id).sec += sec;
      this.last = id;
      return { id, isNew: false, score: 0, merges: [] };
    }
    const { best, score } = this._best(emb);
    const atCap = this.maxSpeakers > 0 && this.voices.length >= this.maxSpeakers;
    const take = (s, learn) => {
      if (learn) this._add(s, emb, sec);
      s.sec += sec;
      this.last = s.id;
      return { id: s.id, isNew: false, score, merges: [] };
    };
    if (best && score >= this.threshold) return take(best, score >= this.threshold + 0.08);
    // Too little speech to call it a new person: it joins the closest voice.
    if (best && sec < this.minNewSec) return take(best, false);
    // A placeholder from a too-short first clip adopts the first real voice.
    const blank = this.speakers.find((s) => !s.centroid);
    if (blank) return take(blank, true);
    const created = this._create(emb, sec, score);
    if (!atCap) return { ...created, merges: [] };
    // Everyone is already accounted for, yet this clearly sounds like nobody we know. Most
    // likely two of the current voices are the same person: merge the closest pair (which
    // may be this new clip into an existing voice) so the count stays right.
    const merges = this.consolidate();
    const gone = merges.find((m) => m.from === created.id);
    if (gone) {
      let id = gone.into;
      for (const m of merges) if (m.from === id) id = m.into;
      return { id, isNew: false, score, merges };
    }
    return { ...created, merges };
  }

  _create(emb, sec, score = 0) {
    const id = 's' + this.next++;
    const sum = emb ? Float32Array.from(emb, (v) => v * Math.min(10, Math.max(1, sec))) : null;
    this.speakers.push({ id, sum, centroid: emb, count: emb ? 1 : 0, sec, name: '' });
    this.last = id;
    return { id, isNew: true, score };
  }

  // Longer clips count for more (up to 10 s): their fingerprints are more reliable.
  _add(s, emb, sec = 3) {
    const w = Math.min(10, Math.max(1, sec));
    if (!s.sum) s.sum = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) s.sum[i] += emb[i] * w;
    s.count++;
    s.centroid = normalise(s.sum);
  }

  setName(id, name) {
    const s = this._get(id);
    if (s) s.name = name || '';
  }
  setMaxSpeakers(n) {
    this.maxSpeakers = n > 0 ? n : 0;
  }

  /** The user said this clip belongs to speaker `id` (creating that voice if it's new). */
  teach(id, emb) {
    if (!emb) return;
    let s = this._get(id);
    if (!s) {
      s = { id, sum: null, centroid: null, count: 0, sec: 0, name: '' };
      this.speakers.push(s);
    }
    this._add(s, emb, 5);
    this.last = id;
  }

  /** Merges `fromId` into `intoId` (user said they're the same person, or they converged). */
  merge(fromId, intoId) {
    const from = this._get(fromId);
    const into = this._get(intoId);
    if (!from || !into || from === into) return;
    if (from.sum) {
      if (!into.sum) into.sum = Float32Array.from(from.sum);
      else for (let i = 0; i < from.sum.length; i++) into.sum[i] += from.sum[i];
      into.centroid = normalise(into.sum);
      into.count += from.count;
    }
    into.sec += from.sec;
    if (!into.name) into.name = from.name;
    this.speakers = this.speakers.filter((s) => s !== from);
    if (this.last === fromId) this.last = intoId;
  }

  _canMerge(a, b) {
    return !(a.name && b.name && a.name.toLowerCase() !== b.name.toLowerCase());
  }

  /**
   * Merges voices that are really one person: while there are more voices than people,
   * merge the closest pair; otherwise merge any pair that has drifted above the threshold.
   * Returns the merges made, as [{ from, into }].
   */
  consolidate() {
    const merges = [];
    for (;;) {
      const v = this.voices;
      let pair = null;
      let top = -1;
      for (let i = 0; i < v.length; i++)
        for (let j = i + 1; j < v.length; j++) {
          if (!this._canMerge(v[i], v[j])) continue;
          const sc = cosine(v[i].centroid, v[j].centroid);
          if (sc > top) {
            top = sc;
            pair = [v[i], v[j]];
          }
        }
      if (!pair) break;
      const tooMany = this.maxSpeakers > 0 && v.length > this.maxSpeakers;
      // Averaged voice profiles are much cleaner than single clips, so two profiles of
      // different people still look fairly alike. Only merge on its own when they are very
      // close, and never below the known number of people.
      const sameVoice = this.maxSpeakers === 0 && top >= this.mergeThreshold;
      if (!tooMany && !sameVoice) break;
      // Keep the named voice, otherwise the one we've heard more of.
      const [a, b] = pair;
      const [into, from] = (a.name && !b.name) || (!b.name && a.sec >= b.sec) ? [a, b] : [b, a];
      merges.push({ from: from.id, into: into.id });
      this.merge(from.id, into.id);
    }
    return merges;
  }

  /**
   * End of meeting: re-cluster the whole recording, like batch diarization does.
   * items: [{ t, emb, sec, spk, fixed }] (fixed = the user set this line by hand).
   * Uses spherical k-means over the reliable (longer) clips, tried from several starting
   * points including the live voices, keeps the best fit, then gives every clip the nearest
   * voice. Clusters keep the ids (and so the names) of the live voices they overlap most.
   * Returns { map: { [t]: spk }, merges }.
   */
  finalize(items) {
    const merges = this.consolidate();
    const renamed = Object.fromEntries(merges.map((m) => [m.from, m.into]));
    const follow = (id) => {
      while (renamed[id]) id = renamed[id];
      return id;
    };
    const map = {};
    for (const it of items) map[it.t] = follow(it.spk);

    const withEmb = items.filter((it) => it.emb);
    const K = this.maxSpeakers || this.voices.length;
    if (K >= 1 && withEmb.length >= K) {
      let pts = withEmb.filter((it) => it.sec >= 2 || it.fixed);
      if (pts.length < K * 3) pts = withEmb;
      const w = (it) => Math.min(10, Math.max(1, it.sec || 1));
      const nearest = (e, cs) => {
        let k = 0;
        let best = -2;
        cs.forEach((c, i) => {
          const sc = cosine(e, c);
          if (sc > best) {
            best = sc;
            k = i;
          }
        });
        return [k, best];
      };
      const kmeans = (init) => {
        let cs = init.map((c) => Float32Array.from(c));
        let assign = [];
        for (let iter = 0; iter < 20; iter++) {
          assign = pts.map((p) => nearest(p.emb, cs)[0]);
          const sums = cs.map((c) => new Float32Array(c.length));
          pts.forEach((p, n) => {
            const sum = sums[assign[n]];
            for (let d = 0; d < sum.length; d++) sum[d] += p.emb[d] * w(p);
          });
          cs = sums.map((sum, k) => (sum.some((v) => v !== 0) ? normalise(sum) : cs[k]));
        }
        const fit = pts.reduce((a, p, n) => a + w(p) * cosine(p.emb, cs[assign[n]]), 0);
        return { cs, fit };
      };
      // Starting points: the live voices (largest first), plus seeded k-means++ picks.
      const inits = [];
      const live = [...this.voices].sort((a, b) => b.sec - a.sec).map((v) => v.centroid);
      if (live.length >= K) inits.push(live.slice(0, K));
      let seed = 12345;
      const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      for (let r = 0; r < 8; r++) {
        const cs = [pts[Math.floor(rand() * pts.length)].emb];
        while (cs.length < K) {
          const d = pts.map((p) => (1 - nearest(p.emb, cs)[1]) ** 2 * w(p));
          let x = rand() * d.reduce((a, b) => a + b, 0);
          let n = 0;
          while (n < d.length - 1 && (x -= d[n]) > 0) n++;
          cs.push(pts[n].emb);
        }
        inits.push(cs);
      }
      const best = inits.map(kmeans).sort((a, b) => b.fit - a.fit)[0];

      // Name the clusters after the live voices they overlap most (user-fixed lines count most).
      const overlapScore = best.cs.map(() => ({}));
      for (const it of withEmb) {
        const k = nearest(it.emb, best.cs)[0];
        const id = map[it.t];
        overlapScore[k][id] = (overlapScore[k][id] || 0) + (it.fixed ? 100 : w(it));
      }
      const pairs = [];
      overlapScore.forEach((o, k) => Object.entries(o).forEach(([id, v]) => pairs.push({ k, id, v })));
      pairs.sort((a, b) => b.v - a.v);
      const idOf = {};
      const used = new Set();
      for (const p of pairs) {
        if (idOf[p.k] != null || used.has(p.id) || p.id === 'others') continue;
        idOf[p.k] = p.id;
        used.add(p.id);
      }
      best.cs.forEach((_, k) => {
        if (idOf[k] == null) idOf[k] = this._create(null, 0).id;
      });

      for (const it of withEmb) if (!it.fixed) map[it.t] = idOf[nearest(it.emb, best.cs)[0]];
      // Keep the tracker in step, in case recording continues.
      best.cs.forEach((c, k) => {
        let s = this._get(idOf[k]);
        if (!s) {
          s = { id: idOf[k], sum: null, centroid: null, count: 0, sec: 0, name: '' };
          this.speakers.push(s);
        }
        s.centroid = c;
        s.sum = Float32Array.from(c);
      });
      const keep = new Set(Object.values(idOf));
      for (const v of this.voices) if (!keep.has(v.id) && !v.name) merges.push({ from: v.id, into: idOf[nearest(v.centroid, best.cs)[0]] });
    }

    // Clips too short to fingerprint follow the nearest clip in time that has one.
    const anchored = withEmb.slice().sort((a, b) => a.t - b.t);
    for (const it of items) {
      if (it.emb || it.fixed || !anchored.length) continue;
      let near = anchored[0];
      for (const a of anchored) if (Math.abs(a.t - it.t) < Math.abs(near.t - it.t)) near = a;
      map[it.t] = map[near.t];
    }
    return { map, merges };
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
