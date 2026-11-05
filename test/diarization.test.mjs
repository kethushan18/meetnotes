// Simulated meeting: 3 remote people whose clips vary a lot (short phrases, codec noise)
// and whose voices are fairly alike. Checks over-splitting is fixed and lines end up right.
import assert from 'node:assert/strict';
import { SpeakerTracker, normalise, cosine } from '../src/lib/voices.js';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const D = 256;
let NOISE = 0.2; // 0.2 reproduces the real problem: the old logic finds ~9-13 voices for 3 people
const shared = Float32Array.from({ length: D }, rnd); // makes everyone sound somewhat alike
const people = [0, 1, 2].map(() => normalise(Float32Array.from({ length: D }, (_, i) => shared[i] * 0.9 + rnd())));
// Shorter clips give noisier fingerprints, as with the real model.
const clip = (p, sec) => normalise(Float32Array.from(people[p], (v) => v + (2.2 / Math.sqrt(sec)) * rnd() * NOISE));

// Shaped like the real 8-minute meeting: long turns plus lots of 1-3 s interjections.
const seq = [];
const turns = [[0, 30], [1, 2], [2, 4], [1, 15], [0, 25], [2, 28], [0, 30], [1, 6], [2, 2], [2, 1.5], [0, 60], [1, 8], [2, 1.5], [1, 25], [2, 6],
  [0, 3], [2, 2], [0, 8], [2, 2], [0, 15], [2, 14], [0, 30], [1, 4], [0, 5], [2, 2], [0, 1], [2, 1.5], [0, 7], [2, 2], [2, 1.5], [0, 20], [2, 1.5], [1, 25], [2, 1], [1, 20], [0, 15]];
for (let r = 0; r < 3; r++)
  for (const [p, len] of turns) {
    let left = len;
    while (left > 0) {
      const sec = Math.min(left, 10);
      seq.push({ p, noise: sec, sec });
      left -= sec;
    }
  }
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const within = avg(seq.slice(0, 40).map((x) => cosine(clip(x.p, x.sec), clip(x.p, x.sec))));
const between = avg([cosine(clip(0, 4), clip(1, 4)), cosine(clip(1, 4), clip(2, 4)), cosine(clip(0, 4), clip(2, 4))]);
console.log(`similarity: same person ~${within.toFixed(2)}, different people ~${between.toFixed(2)}`);

function run(opts) {
  const t = new SpeakerTracker({ threshold: 0.45, ...opts });
  const items = [];
  let maxVoices = 0;
  seq.forEach((x, i) => {
    const emb = clip(x.p, x.sec);
    const r = t.assign(emb, x.sec);
    const relabel = (ms) => { for (const m of ms) for (const it of items) if (it.spk === m.from) it.spk = m.into; };
    relabel(r.merges);
    items.push({ t: i * 1000, emb, sec: x.sec, spk: r.id, p: x.p });
    if (i % 10 === 9) relabel(t.consolidate());
    maxVoices = Math.max(maxVoices, t.voices.length);
  });
  const { map } = t.finalize(items);
  // accuracy: best mapping of voices to people
  const votes = {};
  for (const it of items) {
    const v = map[it.t];
    votes[v] = votes[v] || [0, 0, 0];
    votes[v][it.p]++;
  }
  const correct = Object.values(votes).reduce((a, v) => a + Math.max(...v), 0);
  return { voices: t.voices.length, maxVoices, acc: correct / items.length };
}

const old = run({ minNewSec: 1 }); // roughly the 2.2 behaviour, without a count
const unknown = run({});
const known = run({ maxSpeakers: 3 });
console.log(`clips: ${seq.length}`);
console.log('old behaviour:       ', JSON.stringify(old));
console.log('people count unknown:', JSON.stringify(unknown));
console.log('people count = 3:    ', JSON.stringify(known));
assert.ok(old.voices > 6, 'the simulation reproduces the over-splitting');
assert.equal(known.voices, 3, 'with the count known, exactly 3 voices remain');
assert.ok(known.maxVoices <= 3, 'never more voices than people while recording');
assert.ok(known.acc >= 0.95, 'lines end up with the right person');
assert.ok(unknown.voices <= 4, 'without a count, short interjections no longer create voices');
// Much noisier fingerprints: with the count known it still holds up.
for (const n of [0.3, 0.4]) {
  NOISE = n;
  const r = run({ maxSpeakers: 3 });
  console.log(`noisier (${n}), count = 3:`, JSON.stringify(r));
  assert.equal(r.voices, 3);
  assert.ok(r.acc >= 0.9, 'still at least 90% right with noisy fingerprints');
}

// Named voices are never merged with each other, even when over the cap.
const t = new SpeakerTracker({ threshold: 0.45, maxSpeakers: 2 });
const a = t.assign(clip(0, 10), 10).id; t.setName(a, 'Sam');
const b = t.assign(clip(1, 10), 10).id; t.setName(b, 'Priya');
t.assign(clip(2, 10), 10); // a third voice when only 2 people were expected
assert.deepEqual(t.voices.map((v) => v.name).sort(), ['Priya', 'Sam'], 'two differently named voices are never merged');
console.log('diarization: assertions passed');
