import { Chunker, SAMPLE_RATE } from '../src/lib/chunker.js';
window.runAudio = async (seconds) => {
  const chunks = [];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('recorder-worklet.js'));
  const ch = new Chunker({ speaker: 'Me', minChunkSec: 3, maxChunkSec: 20, silenceThreshold: 0.008, onChunk: (c) => chunks.push({ t: c.t, len: c.audio.length / SAMPLE_RATE, voiced: c.voicedSec }) });
  const node = new AudioWorkletNode(ctx, 'recorder-processor');
  let blocks = 0;
  node.port.onmessage = (e) => { blocks++; ch.push(e.data); };
  const g = ctx.createGain(); g.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(g).connect(ctx.destination);
  await ctx.resume();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  ch.flush();
  return { blocks, chunks, rate: ctx.sampleRate };
};
