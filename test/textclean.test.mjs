import assert from 'node:assert/strict';
import { cleanTranscript } from '../src/lib/textclean.js';
const cases = [
  ['Thanks for watching!', 5, ''],
  ['Thank you.', 0.8, ''],
  ['Thank you.', 4, 'Thank you.'],
  ['[BLANK_AUDIO]', 2, ''],
  ['No, no, that is fine.', 3, 'No, no, that is fine.'],
  ['I think I think I think I think we should go.', 4, 'I think we should go.'],
  ['the the the the the the the the the the', 4, ''],
  ['We will hire three people in December.', 3, 'We will hire three people in December.'],
  ['okay okay okay okay so the plan is fine', 3, 'okay so the plan is fine'],
  ['aaaaaaaaaaaaaa', 2, '']
];
for (const [input, voiced, want] of cases) assert.equal(cleanTranscript(input, voiced), want, input);
console.log(`textclean: ${cases.length} cases passed`);
