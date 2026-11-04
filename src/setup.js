// First-run setup: name, pin, microphone, one-time model download + speed test, Claude app.
import { getSettings, saveSettings } from './lib/settings.js';
import { Transcriber } from './lib/transcriber.js';
import { SpeakerEmbedder } from './lib/speakers.js';
import { loadVad } from './lib/vad.js';
import { loadSegmenter } from './lib/diarize.js';

const $ = (id) => document.getElementById(id);
const STEPS = [
  ['name', 'You'],
  ['pin', 'Pin'],
  ['mic', 'Microphone'],
  ['model', 'Speech engine'],
  ['claude', 'Claude app'],
  ['done', 'Done']
];
let current = 0;

function go(i) {
  current = i;
  document.querySelectorAll('.step').forEach((el) => el.classList.toggle('active', el.dataset.step === STEPS[i][0]));
  $('stepper').innerHTML = STEPS.map(
    ([, label], k) => `<li class="${k < i ? 'done' : k === i ? 'now' : ''}"><span>${k < i ? '✓' : k + 1}</span>${label}</li>`
  ).join('');
  const input = document.querySelector('.step.active input');
  if (input) input.focus();
  onEnter[STEPS[i][0]]?.();
}
const next = () => go(Math.min(current + 1, STEPS.length - 1));
const onEnter = { model: () => startDownload() };
function setCheck(id, ok, text) {
  const el = $(id);
  el.classList.remove('hidden');
  el.classList.toggle('ok', ok);
  el.lastElementChild.textContent = text;
}

// ---------- 1. name ----------
$('nameNext').onclick = async () => {
  const name = $('myName').value.trim();
  if (!name) return $('myName').focus();
  await saveSettings({ myName: name });
  next();
};
$('myName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('nameNext').click();
});

// ---------- 2. pin ----------
async function checkPin() {
  try {
    const s = await chrome.action.getUserSettings();
    if (s.isOnToolbar) {
      setCheck('pinState', true, 'Pinned. Nice.');
      $('pinNext').disabled = false;
      return true;
    }
  } catch {
    /* older Chrome: can't detect, allow continuing */
    $('pinNext').disabled = false;
  }
  return false;
}
setInterval(() => STEPS[current][0] === 'pin' && checkPin(), 1000);
$('pinNext').onclick = next;
$('pinSkip').onclick = next;

// ---------- 3. microphone ----------
$('micAllow').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    $('micAllow').classList.add('hidden');
    $('micMeter').classList.remove('hidden');
    setCheck('micState', true, 'Microphone allowed. Say something to see the level.');
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (!stream.active) return;
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      $('micLevel').style.width = Math.min(100, Math.round(peak * 250)) + '%';
      requestAnimationFrame(tick);
    };
    tick();
    setTimeout(() => {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      $('micMeter').classList.add('hidden');
    }, 8000);
    await saveSettings({ recordMic: true });
    $('micNext').disabled = false;
  } catch (e) {
    setCheck('micState', false, `Chrome blocked the microphone (${e.name}). Click the icon at the right of the address bar to allow it, then try again.`);
  }
};
$('micSkip').onclick = async () => {
  await saveSettings({ recordMic: false });
  next();
};
$('micNext').onclick = next;

// ---------- 4. speech engine ----------
// Like Meetily's onboarding: the download starts as soon as this step opens, shows MB and
// speed, and you can carry on with the next steps while it finishes in the background.
async function loadSample() {
  const buf = await (await fetch(chrome.runtime.getURL('sample.wav'))).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 16000, 16000);
  const decoded = await ctx.decodeAudioData(buf);
  return decoded.getChannelData(0);
}

const dl = { promise: null, done: false, failed: false };
const audio0 = () => {
  const a = new Float32Array(32000);
  for (let i = 0; i < a.length; i++) a[i] = 0.1 * Math.sin(i / (6 + (i % 400) / 100));
  return a;
};
const mb = (b) => (b / 1048576).toFixed(0);

function startDownload() {
  if (dl.promise && !dl.failed) return dl.promise;
  dl.failed = false;
  dl.promise = (async () => {
    const s = await getSettings();
    $('modelGo').classList.add('hidden');
    $('modelProg').classList.remove('hidden');
    $('modelResult').classList.add('hidden');
    const bar = $('modelBar');
    const status = $('modelStatus');
    const t0 = performance.now();
    const t = new Transcriber({
      model: s.asrModel,
      fallback: s.fallbackModel,
      onProgress: (pct, total, loaded) => {
        bar.style.width = Math.round(pct * 0.85) + '%';
        const secs = (performance.now() - t0) / 1000;
        status.textContent = `Downloading speech model: ${mb(loaded)} of ${mb(total)} MB${secs > 2 ? ` (${(loaded / 1048576 / secs).toFixed(1)} MB/s)` : ''}`;
      },
      onStatus: (msg) => (status.textContent = msg)
    });
    $('modelNext').disabled = false;
    $('modelNext').textContent = 'Continue (download keeps going)';
    try {
      await t.load(); // includes a warm-up run on the GPU or CPU
      bar.style.width = '88%';
      status.textContent = 'Downloading voice detector and voice model...';
      await loadVad();
      let voices = true;
      try {
        const emb = new SpeakerEmbedder({ model: s.speakerModel, onProgress: (pct) => (bar.style.width = 88 + Math.round(pct * 0.1) + '%') });
        await emb.load();
        const v = await emb.embed(audio0()); // check it really produces a voice fingerprint
        if (!v || v.length < 32) throw new Error('voice model gave no output');
        await loadSegmenter();
      } catch (e) {
        console.warn('Voice model failed', e);
        voices = false;
      }
      bar.style.width = '100%';
      status.textContent = 'Testing...';
      const audio = await loadSample();
      const t1 = performance.now();
      const text = await t.transcribe(audio);
      const speedX = Math.max(1, Math.round(audio.length / 16000 / ((performance.now() - t1) / 1000)));
      await saveSettings({ asrModel: t.model, voiceNaming: voices, engineReady: { model: t.model, device: t.device, speedX, at: Date.now() } });
      status.textContent = '';
      const r = $('modelResult');
      r.classList.remove('hidden');
      r.innerHTML = `
        <div class="ok"><strong>Ready.</strong> ${/moonshine/i.test(t.model) ? 'Moonshine' : 'Whisper'} on your ${t.device === 'webgpu' ? 'graphics chip (GPU)' : 'processor (CPU)'}, about ${speedX}x faster than real time.</div>
        <div class="small muted" style="margin-top:4px">Test sentence heard as: "${text.replace(/[<>&]/g, '')}"</div>
        ${voices ? '' : '<div class="small warn" style="margin-top:4px">The voice model could not load, so other people will show as "Others". Run setup again later to retry.</div>'}`;
      $('modelNext').textContent = 'Continue';
      dl.done = true;
    } catch (e) {
      console.error(e);
      dl.failed = true;
      $('modelNext').disabled = true;
      $('modelNext').textContent = 'Continue';
      status.innerHTML = `<span class="err">Download failed: ${String(e.message).replace(/[<>&]/g, '')}.</span>`;
      $('modelGo').textContent = 'Retry';
      $('modelGo').classList.remove('hidden');
      throw e;
    }
  })();
  dl.promise.catch(() => {});
  return dl.promise;
}
$('modelGo').onclick = () => startDownload();
$('modelNext').onclick = next;

// ---------- 5. Claude app ----------
$('claudeTest').onclick = async () => {
  const url = 'claude://claude.ai/new?q=' + encodeURIComponent('MeetNotes is connected. You can close this chat.');
  chrome.tabs.create({ url: chrome.runtime.getURL('open.html?u=' + encodeURIComponent(url)) });
  $('claudeOk').disabled = false;
};
$('claudeOk').onclick = async () => {
  await saveSettings({ openIn: 'app' });
  setCheck('claudeState', true, 'Claude app connected.');
  $('claudeNext').disabled = false;
};
$('claudeWeb').onclick = async () => {
  await saveSettings({ openIn: 'web' });
  setCheck('claudeState', true, 'Notes will open in claude.ai in your browser.');
  $('claudeNext').disabled = false;
};
$('claudeNext').onclick = next;

// ---------- 6. done ----------
$('finish').onclick = async () => {
  if (!dl.done) {
    $('finish').disabled = true;
    $('finish').textContent = 'Finishing the download...';
    try {
      await startDownload();
    } catch {
      $('finish').disabled = false;
      $('finish').textContent = 'Finish';
      return go(STEPS.findIndex(([k]) => k === 'model'));
    }
  }
  await saveSettings({ setupDone: true });
  window.close();
};

// ---------- init ----------
(async () => {
  const s = await getSettings();
  $('myName').value = s.myName || '';
  go(0);
})();
