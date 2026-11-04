import { Chunker, cleanTranscript, SAMPLE_RATE } from '../src/lib/chunker.js';
const chunks = [];
const c = new Chunker({ speaker: 'Me', minChunkSec: 6, maxChunkSec: 20, silenceThreshold: 0.008, onChunk: (x) => chunks.push(x) });
const B = 4096;
function feed(sec, loud) {
  const n = Math.round(sec * SAMPLE_RATE / B);
  for (let i = 0; i < n; i++) {
    const b = new Float32Array(B);
    if (loud) for (let j = 0; j < B; j++) b[j] = 0.1 * Math.sin(j / 5);
    c.push(b);
  }
}
feed(5, false);   // 5s silence
feed(8, true);    // 8s speech
feed(1.5, false); // pause -> cut
feed(30, false);  // long silence, nothing
feed(45, true);   // long speech -> forced cuts at 20s
feed(1, false);
c.flush();
for (const ch of chunks) console.log(ch.speaker, 't=', (ch.t/1000).toFixed(2), 'len=', (ch.audio.length/SAMPLE_RATE).toFixed(2), 'voiced=', ch.voicedSec.toFixed(2));
console.log(JSON.stringify([cleanTranscript(' [BLANK_AUDIO] ', 0), cleanTranscript('Thank you.', 0.8), cleanTranscript('Thank you.', 4), cleanTranscript('Hello (music) there', 3)]));
