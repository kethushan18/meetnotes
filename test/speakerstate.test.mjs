import assert from 'node:assert/strict';
import { applyRelabel, ensureSpeakers, tidySpeakers } from '../src/lib/speakerstate.js';
const session = {
  segments: [
    { t: 1, spk: 's1', text: 'a' }, { t: 2, spk: 's2', text: 'b' }, { t: 3, spk: 'me', text: 'c' },
    { t: 4, spk: 's3', text: 'd' }, { t: 5, spk: 's4', text: 'e', fixed: true }, { t: 6, spk: 's5', text: 'f' }
  ],
  speakers: { s1: { name: 'Sam', ask: true }, s2: { name: '' }, s3: { name: 'Priya' }, s4: { name: 'Jordan' }, s5: { name: '' } }
};
// live merge: s2 into s1, s5 into s3
let r = applyRelabel(session, { merges: [{ from: 's2', into: 's1' }, { from: 's5', into: 's3' }] });
assert.deepEqual(r.segments.map((s) => s.spk), ['s1', 's1', 'me', 's3', 's4', 's3']);
assert.deepEqual(Object.keys(r.speakers).sort(), ['s1', 's3', 's4']);
assert.equal(r.speakers.s1.name, 'Sam');
// end-of-meeting map: moves lines, but never the hand-fixed one
r = applyRelabel(r, { map: { 1: 's3', 4: 's1', 5: 's1', 6: 's1' } });
assert.deepEqual(r.segments.map((s) => s.spk), ['s3', 's1', 'me', 's1', 's4', 's1']);
// a name follows a merge onto an unnamed voice
r = applyRelabel({ segments: [{ t: 1, spk: 's7', text: 'x' }, { t: 2, spk: 's8', text: 'y' }], speakers: { s7: { name: 'Alex' }, s8: { name: '' } } }, { merges: [{ from: 's7', into: 's8' }] });
assert.equal(r.speakers.s8.name, 'Alex');
// numbering by first appearance
const sp = tidySpeakers(ensureSpeakers({}, [{ spk: 's9', text: '' }, { spk: 's4', text: '' }]), [{ spk: 's9' }, { spk: 's4' }]);
assert.equal(sp.s9.label, 'Speaker 1');
assert.equal(sp.s4.label, 'Speaker 2');
console.log('speakerstate: assertions passed');
