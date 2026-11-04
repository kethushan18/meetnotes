// Offscreen document: holds the meeting tab audio and your mic, and streams both to the
// engine worker (models run there). Keeps "Me" and "the meeting" as separate streams,
// which is what lets us label your lines without guessing.

let armed = null; // { stream, playback, timer } held between the icon click and Start
let rec = null; // { streams, contexts, levelTimer }
let worker = null;

const ARM_TIMEOUT_MS = 30 * 60 * 1000;
const toBg = (type, payload = {}) => chrome.runtime.sendMessage({ target: 'bg', type, ...payload }).catch(() => {});
const engine = (s) => toBg('engine', { state: s });

// ---------- engine worker ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL('engine-worker.bundle.js'), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'engine') engine(m.state);
    else if (m.type === 'segment') toBg('segment', { segment: m.segment, newSpeaker: m.newSpeaker });
    else if (m.type === 'stopped') toBg('stopped');
  };
  worker.onerror = (e) => engine({ error: 'Speech engine crashed: ' + (e.message || 'unknown error') });
  return worker;
}

// ---------- tab audio ----------
async function openTab(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  // Capturing mutes the tab, so play it back so you still hear the meeting.
  const playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);
  await playback.resume();
  return { stream, playback };
}
function releaseArmed() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.stream.getTracks().forEach((t) => t.stop());
  armed.playback.close().catch(() => {});
  armed = null;
}
async function arm(streamId, cfg) {
  if (rec) throw new Error('Already recording');
  releaseArmed();
  const tab = await openTab(streamId);
  armed = {
    ...tab,
    timer: setTimeout(() => {
      releaseArmed();
      toBg('disarmed');
    }, ARM_TIMEOUT_MS)
  };
  tab.stream.getAudioTracks()[0].addEventListener('ended', () => {
    if (armed && armed.stream === tab.stream) {
      releaseArmed();
      toBg('disarmed');
    }
  });
  if (cfg) getWorker().postMessage({ type: 'warm', cfg }); // load models while you fill in the details
}

// ---------- recording ----------
function connect(ctx, stream, name, levels) {
  const node = new AudioWorkletNode(ctx, 'recorder-processor');
  node.port.onmessage = (e) => {
    const data = e.data;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    levels[name] = Math.max(levels[name] * 0.8, Math.sqrt(sum / data.length));
    worker.postMessage({ type: 'audio', stream: name, data }, [data.buffer]);
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
}

async function start({ streamId, settings: cfg }) {
  if (rec) throw new Error('Already recording');
  let tab;
  if (armed && !streamId) {
    clearTimeout(armed.timer);
    tab = { stream: armed.stream, playback: armed.playback };
    armed = null;
  } else if (streamId) {
    releaseArmed();
    tab = await openTab(streamId);
  } else {
    throw new Error('The meeting tab is no longer ready. Click the MeetNotes icon on the meeting tab again.');
  }

  let micStream = null;
  if (cfg.recordMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      engine({ micStatus: 'on' });
    } catch (e) {
      console.warn('Mic unavailable', e);
      engine({ micStatus: 'denied' });
    }
  } else {
    engine({ micStatus: 'off' });
  }

  const w = getWorker();
  w.postMessage({ type: 'start', cfg });

  const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('recorder-worklet.js'));
  await ctx.resume();
  const levels = { tab: 0, me: 0 };
  connect(ctx, tab.stream, 'tab', levels);
  if (micStream) connect(ctx, micStream, 'me', levels);

  rec = {
    streams: [tab.stream, micStream].filter(Boolean),
    contexts: [ctx, tab.playback],
    // Live levels so the panel can warn when no sound is coming in.
    levelTimer: setInterval(() => engine({ levels: { tab: +levels.tab.toFixed(4), me: +levels.me.toFixed(4) } }), 1000)
  };
  tab.stream.getAudioTracks()[0].addEventListener('ended', () => stop());
}

function stop() {
  if (!rec) return;
  clearInterval(rec.levelTimer);
  for (const s of rec.streams) s.getTracks().forEach((t) => t.stop());
  for (const c of rec.contexts) c.close().catch(() => {});
  rec = null;
  engine({ levels: null });
  worker?.postMessage({ type: 'stop' }); // the worker finishes the queue, then reports 'stopped'
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const reply = (p, prefix) =>
    p.then(() => sendResponse({ ok: true })).catch((e) => {
      console.error(e);
      sendResponse({ ok: false, error: prefix + e.message });
    });
  switch (msg.type) {
    case 'arm':
      reply(arm(msg.streamId, msg.settings), 'Could not capture the tab: ');
      return true;
    case 'start':
      reply(start(msg), 'Could not capture audio: ');
      return true;
    case 'warm':
      getWorker().postMessage({ type: 'warm', cfg: msg.settings });
      sendResponse({ ok: true });
      return;
    case 'merge':
      worker?.postMessage({ type: 'merge', from: msg.from, into: msg.into });
      sendResponse({ ok: true });
      return;
    case 'teach':
      worker?.postMessage({ type: 'teach', t: msg.t, id: msg.id });
      sendResponse({ ok: true });
      return;
    case 'disarm':
      releaseArmed();
      sendResponse({ ok: true });
      return;
    case 'stop':
      stop();
      sendResponse({ ok: true });
      return;
    case 'status':
      sendResponse({ ok: true, recording: !!rec, armed: !!armed });
      return;
  }
});
