import assert from 'node:assert/strict';
import { SpeakerTracker, normalise, overlap } from '../src/lib/voices.js';
// synthetic voices: base vectors + noise
function rnd(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647 - 0.5; }
const r = rnd(42);
const base = [0, 1, 2].map(() => normalise(Float32Array.from({ length: 256 }, r)));
const sample = (k, noise = 0.9) => normalise(Float32Array.from(base[k], (v) => v + noise * r() / 8));
const t = new SpeakerTracker({ threshold: 0.4 });
const seq = [0, 0, 1, 0, 2, 1, 1, 2, 0];
const got = seq.map((k) => t.assign(sample(k), 3));
console.log('assign', got.map((g) => g.id + (g.isNew ? '*' : '') + ':' + g.score.toFixed(2)).join(' '));
const map = {}; let ok = true; seq.forEach((k, i) => { if (map[k] && map[k] !== got[i].id) ok = false; map[k] = got[i].id; });
console.log('consistent mapping', ok, JSON.stringify(map), 'speakers', t.speakers.length);
assert.ok(ok, 'each synthetic voice maps to one speaker');
assert.equal(t.speakers.length, 3, 'three voices found');
console.log('short chunk new voice ->', JSON.stringify(t.assign(normalise(Float32Array.from({ length: 256 }, r)), 0.6)));
t.merge('s3', 's1');
assert.equal(t.speakers.length, 2, 'merge removes a voice'); console.log('after merge', t.speakers.map((s) => s.id + 'x' + s.count).join(','));
const t2 = new SpeakerTracker(); console.log('null first', JSON.stringify(t2.assign(null, 0.5)), JSON.stringify(t2.assign(sample(0), 3)), JSON.stringify(t2.assign(sample(1), 3)));
console.log('overlap', overlap('We will send the offers by Thursday.', 'we will send the offers by thursday'), overlap('Hello there', 'Completely different words'));

const t3 = new SpeakerTracker({ threshold: 0.45 });
t3.assign(sample(0), 3);
t3.teach('u1', sample(1));
assert.equal(t3.assign(sample(1), 3).id, 'u1', 'a taught voice is matched afterwards');
console.log('speakers: assertions passed');
