// Web Worker that runs all the models, like the transformers.js examples do, so the
// offscreen page's audio handling and messaging never wait on inference.
// In: warm / start / audio / stop / merge.  Out: engine (status), segment, stopped.
import { Transcriber, isCached } from './lib/transcriber.js';
import { SpeakerEmbedder } from './lib/speakers.js';
import { SpeakerTracker, VOICE_THRESHOLDS, overlap } from './lib/voices.js';
import { SileroSegmenter, loadVad, SR } from './lib/vad.js';
import { Chunker } from './lib/chunker.js';
import { cleanTranscript } from './lib/textclean.js';
import { loadSegmenter, speakerTurns, slice } from './lib/diarize.js';

const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const status = (state) => post('engine', { state });

let cfg = null;
let transcriber = null;
let embedder = null;
let rec = null; // the running recording
let voiceState = { ok: null, error: '' }; // result of the voice model self-test
let splitterOk = null; // pyannote segmentation available?

// ---------- models (loaded once, kept warm) ----------
function models(c) {
  if (!transcriber || transcriber.wanted !== c.asrModel || transcriber.devicePref !== (c.device || 'auto')) {
    transcriber = new Transcriber({
      model: c.asrModel,
      fallback: c.fallbackModel,
      device: c.device || 'auto',
      onProgress: (pct) => status({ loading: true, status: `Downloading speech model (one time): ${pct}%` }),
      onStatus: (s) => status({ loading: true, status: s })
    });
  }
  if (c.voiceNaming && (!embedder || embedder.modelId !== c.speakerModel)) embedder = new SpeakerEmbedder({ model: c.speakerModel });
  if (!c.voiceNaming) embedder = null;
}
const listening = () => `Listening (${transcriber?.device === 'webgpu' ? 'GPU' : 'CPU'})`;

let warming = null;
async function warm() {
  if (warming) return warming;
  warming = (async () => {
    const vadOk = loadVad().then(() => true, (e) => (console.warn('VAD unavailable, using level-based cutting', e), false));
    const voiceOk = embedder ? selfTestVoices() : null;
    const splitOk = embedder
      ? loadSegmenter().then(() => (splitterOk = true), (e) => (console.warn('Speaker-change detection unavailable', e), (splitterOk = false)))
      : null;
    try {
      await transcriber.load();
      await Promise.all([vadOk, voiceOk, splitOk]);
      status({
        loading: false,
        ready: true,
        error: '',
        device: transcriber.device,
        model: transcriber.model,
        voices: embedder ? (voiceState.ok ? 'on' : 'failed: ' + voiceState.error) : 'off',
        status: rec ? listening() : 'Ready'
      });
    } catch (e) {
      status({ loading: false, ready: false, error: 'Speech model failed to load: ' + e.message });
    } finally {
      warming = null;
    }
  })();
  return warming;
}

// Run the voice model once on test audio. If it can't produce an embedding we say so
// clearly, instead of quietly putting everyone under one name.
async function selfTestVoices() {
  if (voiceState.ok) return true;
  try {
    const test = new Float32Array(SR * 2);
    for (let i = 0; i < test.length; i++) test[i] = 0.1 * Math.sin(i / (6 + (i % 400) / 100)) + 0.02 * (Math.random() - 0.5);
    const emb = await embedder.embed(test);
    if (!emb || emb.length < 32 || emb.some((v) => !Number.isFinite(v))) throw new Error('unexpected output size ' + emb?.length);
    voiceState = { ok: true, error: '', dims: emb.length };
    return true;
  } catch (e) {
    console.error('Voice model self-test failed', e);
    voiceState = { ok: false, error: e.message };
    return false;
  }
}

// ---------- recording ----------
async function makeSegmenter(stream) {
  const onSegment = (seg) => enqueue({ ...seg, stream });
  try {
    await loadVad();
    return new SileroSegmenter({ maxSec: cfg.maxChunkSec || 10, onSegment });
  } catch {
    // Fallback: the simple level-based cutter.
    const c = new Chunker({
      speaker: stream,
      minChunkSec: 2,
      maxChunkSec: cfg.maxChunkSec || 10,
      silenceThreshold: cfg.silenceThreshold || 0.008,
      onChunk: (ch) => onSegment({ audio: ch.audio, speech: ch.audio, t: ch.t, voicedSec: ch.voicedSec })
    });
    return { push: (b) => c.push(b), flush: async () => c.flush() };
  }
}

// People in the meeting tab = everyone minus you (your voice comes from your mic).
function remoteCount(c) {
  const n = Number(c.peopleCount) || 0;
  if (!n) return 0;
  return Math.max(1, c.micOn ? n - 1 : n);
}

async function start(c) {
  cfg = c;
  models(c);
  rec = {
    seg: {},
    queue: [],
    busy: false,
    stopping: false,
    tracker: new SpeakerTracker({
      threshold: VOICE_THRESHOLDS[c.voiceMatch] ?? VOICE_THRESHOLDS.normal,
      maxSpeakers: remoteCount(c)
    }),
    recentTab: [],
    items: [], // every meeting-tab line with its voice fingerprint, for the end-of-meeting re-sort
    asked: new Set(), // voices we've already asked the user to name
    samples: {}, // longest line per voice, shown when asking
    sinceConsolidate: 0,
    heard: false,
    ready: false,
    pending: [] // audio that arrives while the voice detector is still loading
  };
  const r = rec;
  r.seg.tab = await makeSegmenter('tab');
  r.seg.me = await makeSegmenter('me');
  r.ready = true;
  for (const m of r.pending) r.seg[m.stream]?.push(m.data);
  r.pending = [];
  status({ status: transcriber.asr ? listening() : 'Starting speech engine...' });
  warm();
}

function enqueue(seg) {
  if (!rec) return;
  rec.queue.push(seg);
  status({ queue: rec.queue.length });
  drain();
}

async function drain() {
  if (!rec || rec.busy) return;
  rec.busy = true;
  while (rec.queue.length) {
    const seg = rec.queue.shift();
    status({ queue: rec.queue.length + 1 });
    try {
      await handle(seg);
    } catch (e) {
      console.error(e);
      status({ error: 'Transcription error: ' + e.message });
    }
    status({ queue: rec.queue.length });
  }
  rec.busy = false;
  if (rec.stopping) finish();
}

function heard() {
  if (!rec.heard) {
    rec.heard = true;
    status({ heard: true });
  }
}

async function transcribeText(audio, voicedSec) {
  return cleanTranscript(await transcriber.transcribe(audio), voicedSec);
}

async function handle(seg) {
  if (seg.stream === 'me') {
    const text = await transcribeText(seg.audio, seg.voicedSec);
    if (!text) return;
    heard();
    const out = { t: seg.t, dur: Math.round((seg.audio.length / SR) * 1000), text, spk: 'me' };
    // Without headphones the mic hears the meeting too; skip lines already heard from the tab.
    if (rec.recentTab.some((r) => Math.abs(r.t - out.t) < 8000 && overlap(r.text, text) >= 0.6)) return;
    post('segment', { segment: out });
    return;
  }

  const voices = cfg.voiceNaming && embedder && voiceState.ok !== false;
  // Did the speaker change inside this clip? (pyannote, only worth it for longer clips)
  let turns = [];
  if (voices && splitterOk && seg.audio.length / SR >= 2.5) {
    try {
      turns = await speakerTurns(seg.audio);
    } catch (e) {
      console.warn('Speaker-change detection failed for this clip', e);
    }
  }
  if (new Set(turns.map((t) => t.local)).size >= 2) return multiSpeaker(seg, turns);

  const text = await transcribeText(seg.audio, seg.voicedSec);
  if (!text) return;
  heard();
  const out = { t: seg.t, dur: Math.round((seg.audio.length / SR) * 1000), text };
  remember(out);
  if (!voices) {
    out.spk = 'others';
    post('segment', { segment: out });
    return;
  }
  const emb = await embedOrNull(seg.speech, seg.voicedSec);
  emit(out, rec.tracker.assign(emb, seg.voicedSec), emb, seg.voicedSec);
}

function remember(out) {
  rec.recentTab.push(out);
  rec.recentTab = rec.recentTab.filter((r) => out.t - r.t < 20000);
}

async function embedOrNull(audio, voicedSec) {
  if (voicedSec < 0.8 || audio.length < SR * 0.8) return null;
  try {
    return await embedder.embed(audio);
  } catch (e) {
    console.warn('Voice matching failed for this clip', e);
    return null;
  }
}

// Voices merged while recording: tell the panel so earlier lines are relabelled.
function applyMerges(merges) {
  if (!merges?.length) return;
  const into = Object.fromEntries(merges.map((m) => [m.from, m.into]));
  for (const it of rec.items) while (into[it.spk]) it.spk = into[it.spk];
  for (const m of merges) {
    if (rec.asked.has(m.from)) rec.asked.add(m.into);
    if ((rec.samples[m.from] || '').length > (rec.samples[m.into] || '').length) rec.samples[m.into] = rec.samples[m.from];
  }
  post('relabel', { merges });
}

// Ask who a voice is only once we've heard enough of it to be sure it's a real, separate
// person (not a one-word "yeah" with an odd fingerprint).
function maybeAsk(id) {
  if (!id || rec.asked.has(id)) return;
  const v = rec.tracker.speakers.find((s) => s.id === id);
  if (!v || !v.centroid) return;
  if ((v.sec >= 6 && v.count >= 2) || v.sec >= 10) {
    rec.asked.add(id);
    post('voice-ready', { id, sample: rec.samples[id] || '' });
  }
}

function emit(out, result, emb, sec) {
  applyMerges(result.merges);
  out.spk = result.id;
  out.score = Math.round((result.score || 0) * 100) / 100;
  rec.items.push({ t: out.t, emb, sec, spk: out.spk, fixed: false });
  if (out.text.length > (rec.samples[out.spk] || '').length && out.text.length < 160) rec.samples[out.spk] = out.text;
  post('segment', { segment: out });
  maybeAsk(out.spk);
  // Every so often, merge voices that turned out to be the same person.
  if (++rec.sinceConsolidate >= 8) {
    rec.sinceConsolidate = 0;
    applyMerges(rec.tracker.consolidate());
  }
}

/** Several people in one clip: one voice decision per local speaker (using all their audio),
 *  then each turn is transcribed on its own so every line gets the right name. */
async function multiSpeaker(seg, turns) {
  const decided = {};
  for (const local of new Set(turns.map((t) => t.local))) {
    const mine = turns.filter((t) => t.local === local);
    const parts = mine.map((t) => slice(seg.audio, t.start, t.end, 0));
    const audio = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0;
    for (const p of parts) {
      audio.set(p, off);
      off += p.length;
    }
    const secs = audio.length / SR;
    const emb = await embedOrNull(audio, secs);
    const result = rec.tracker.assign(emb, secs);
    applyMerges(result.merges);
    decided[local] = { result: { ...result, merges: [] }, emb, secs };
  }
  for (const t of turns) {
    if (t.end - t.start < 0.5) continue;
    const text = await transcribeText(slice(seg.audio, t.start, t.end), t.end - t.start);
    if (!text) continue;
    heard();
    const out = { t: seg.t + Math.round(t.start * 1000), dur: Math.round((t.end - t.start) * 1000), text };
    remember(out);
    const d = decided[t.local];
    emit(out, d.result, d.emb, t.end - t.start);
  }
}

async function stop() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  status({ status: 'Finishing transcription...' });
  await Promise.all(Object.values(rec.seg).map((s) => s.flush()));
  if (!rec.busy && !rec.queue.length) finish();
  else drain();
}

function finish() {
  // Re-sort every line against the settled voices, like batch diarization does.
  if (rec.items.length && cfg.voiceNaming) {
    try {
      const { map, merges } = rec.tracker.finalize(rec.items);
      post('relabel', { merges, map });
    } catch (e) {
      console.warn('Final voice pass failed', e);
    }
  }
  rec = null;
  status({ status: 'Ready', queue: 0 });
  post('stopped');
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'warm':
        cfg = m.cfg;
        models(m.cfg);
        if (!(await isCached(m.cfg.asrModel))) status({ loading: true, status: 'Downloading speech model (one time)...' });
        warm();
        break;
      case 'start':
        await start(m.cfg);
        break;
      case 'audio':
        if (!rec) break;
        if (!rec.ready) rec.pending.push(m);
        else rec.seg[m.stream]?.push(m.data);
        break;
      case 'stop':
        await stop();
        break;
      case 'merge':
        if (!rec) break;
        rec.tracker.merge(m.from, m.into);
        for (const it of rec.items) if (it.spk === m.from) it.spk = m.into;
        break;
      case 'named':
        rec?.tracker.setName(m.id, m.name);
        if (rec) rec.asked.add(m.id);
        break;
      case 'set-count':
        if (!rec) break;
        cfg.peopleCount = m.count;
        rec.tracker.setMaxSpeakers(remoteCount(cfg));
        applyMerges(rec.tracker.consolidate());
        break;
      case 'teach': {
        // A line was reassigned by hand: teach that voice so later lines match it, and keep
        // the line where the user put it in the final re-sort.
        const it = rec?.items.find((x) => x.t === m.t);
        if (!it) break;
        if (it.emb) rec.tracker.teach(m.id, it.emb);
        it.spk = m.id;
        it.fixed = true;
        rec.asked.add(m.id);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    status({ error: err.message });
  }
};
