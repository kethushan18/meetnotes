// Loads the engine worker in a real extension context and drives it with the speech sample.
// Models can't download here (Hugging Face is blocked), so this checks wiring, fallbacks and error reporting.
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist-test'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw10-' + Date.now(), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1200));
const p = await ctx.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`chrome-extension://${ID}/test-ort.html`);
const res = await p.evaluate(async () => {
  const msgs = [];
  const w = new Worker(chrome.runtime.getURL('engine-worker.bundle.js'), { type: 'module' });
  w.onmessage = (e) => msgs.push(e.data);
  w.onerror = (e) => msgs.push({ type: 'onerror', message: e.message });
  const cfg = { asrModel: 'onnx-community/moonshine-base-ONNX', fallbackModel: 'onnx-community/whisper-base.en', device: 'wasm', voiceNaming: true, voiceMatch: 'normal', speakerModel: 'onnx-community/wespeaker-voxceleb-resnet34-LM', maxChunkSec: 12, silenceThreshold: 0.008 };
  w.postMessage({ type: 'start', cfg });
  // feed 4 s of tone bursts as "tab" audio
  for (let b = 0; b < 16; b++) { const d = new Float32Array(4096); for (let i = 0; i < d.length; i++) d[i] = (b % 8 < 5 ? 0.2 : 0) * Math.sin(i / 6); w.postMessage({ type: 'audio', stream: 'tab', data: d }, [d.buffer]); }
  await new Promise((r) => setTimeout(r, 6000));
  w.postMessage({ type: 'stop' });
  await new Promise((r) => setTimeout(r, 4000));
  return msgs.map((m) => m.type === 'engine' ? 'engine:' + JSON.stringify(m.state).slice(0, 110) : m.type + (m.message ? ':' + m.message : ''));
});
console.log(res.join('\n')); console.log('pageerrors', JSON.stringify(errs));
await ctx.close();
