// Service worker: owns the recording session state and the offscreen audio engine.
import { getSettings } from './lib/settings.js';
import { assignLine } from './lib/lines.js';

const OFFSCREEN_URL = 'offscreen.html';
const MENU_ID = 'meetnotes-record';
const IDLE_ALARM = 'meetnotes-idle';
const IDLE_MINUTES = 20; // keep the speech engine warm between back-to-back meetings

// ---------- install / startup ----------
async function setup() {
  // We handle the icon click ourselves: Chrome only allows tab capture right after
  // the user invokes the extension on that tab, so the click is when we grab it.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Record this meeting with MeetNotes',
    contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'],
    documentUrlPatterns: ['http://*/*', 'https://*/*']
  });
}
chrome.runtime.onInstalled.addListener(async (details) => {
  await setup();
  const settings = await getSettings();
  if (details.reason === 'install' || !settings.setupDone) chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});
chrome.runtime.onStartup.addListener(setup);

// ---------- icon click, Alt+Shift+M, right-click menu ----------
function invoke(tab) {
  if (!tab) return;
  // Must be the first call so it still counts as a user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn('sidePanel.open', e));
  armTab(tab).catch(async (e) => {
    console.warn('arm failed', e);
    await chrome.storage.session.set({ armError: e.message });
  });
}
chrome.action.onClicked.addListener(invoke);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) invoke(tab);
});

// ---------- state helpers ----------
async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null;
}
async function setSession(patch) {
  const current = (await getSession()) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ session: next });
  if ('status' in patch) updateBadge(next.status);
  return next;
}
function updateBadge(status) {
  const on = status === 'recording';
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

// If Chrome or the extension restarted mid-recording, close that recording off cleanly
// (the transcript so far is kept), like Meeper's start-up sweep.
(async () => {
  const s = await getSession();
  if (s && (s.status === 'recording' || s.status === 'finishing') && !(await hasOffscreen())) {
    await setSession({
      status: 'stopped',
      endedAt: s.endedAt || Date.now(),
      error: s.segments?.length ? 'The recording was interrupted (Chrome or the extension restarted). Everything up to that point is saved.' : ''
    });
  }
})();
async function setEngine(patch) {
  const { engine } = await chrome.storage.session.get('engine');
  await chrome.storage.session.set({ engine: { ...(engine || {}), ...patch } });
}
async function getArmed() {
  const { armed } = await chrome.storage.session.get('armed');
  return armed || null;
}
const isBusy = (s) => s && (s.status === 'recording' || s.status === 'finishing');
const capturable = (url) => /^https?:/.test(url || '');

function engineConfig(s) {
  return {
    asrModel: s.asrModel,
    fallbackModel: s.fallbackModel,
    device: s.engineReady?.device || 'auto',
    recordMic: s.recordMic,
    voiceNaming: s.voiceNaming,
    voiceMatch: s.voiceMatch,
    speakerModel: s.speakerModel,
    maxChunkSec: s.maxChunkSec,
    minChunkSec: s.minChunkSec,
    silenceThreshold: s.silenceThreshold
  };
}

// ---------- offscreen engine ----------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  chrome.alarms.clear(IDLE_ALARM);
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // Not AUDIO_PLAYBACK: Chrome closes those after 30 s without sound, which would drop
    // the loaded model (and a quiet meeting). USER_MEDIA has no such limit.
    reasons: ['USER_MEDIA', 'WORKERS'],
    justification: 'Capture meeting tab and microphone audio and transcribe it locally.'
  });
}
// The offscreen page needs a moment to load, so retry until it answers.
async function sendToOffscreen(message) {
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (res && res.ok) return res;
      if (res && res.error) throw new Error(res.error);
    } catch (e) {
      lastErr = e;
      if (!String(e.message).includes('Receiving end')) throw e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr || new Error('Audio engine did not start.');
}
async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  await setEngine({ ready: false, loading: false, status: '' });
}
function scheduleIdleClose() {
  chrome.alarms.create(IDLE_ALARM, { delayInMinutes: IDLE_MINUTES });
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== IDLE_ALARM) return;
  if (isBusy(await getSession()) || (await getArmed())) return scheduleIdleClose();
  await closeOffscreen();
});

// ---------- arming (grab the tab at the icon click, hold it until Start) ----------
async function armTab(tab) {
  if (isBusy(await getSession())) return;
  if (!capturable(tab.url)) {
    await chrome.storage.session.set({ armError: '' });
    return;
  }
  const armed = await getArmed();
  if (armed && armed.tabId === tab.id && (await hasOffscreen())) return; // already ready
  if (armed) await disarm();

  const settings = await getSettings();
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await sendToOffscreen({ target: 'offscreen', type: 'arm', streamId, settings: engineConfig(settings) });
  await chrome.storage.session.set({
    armed: { tabId: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl || '', at: Date.now() },
    armError: ''
  });
}

async function disarm() {
  const armed = await getArmed();
  await chrome.storage.session.remove('armed');
  if (!armed) return;
  if (!isBusy(await getSession()) && (await hasOffscreen())) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'disarm' }).catch(() => {});
    scheduleIdleClose();
  }
}

// When the side panel closes without recording, release the tab.
let disarmTimer = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  clearTimeout(disarmTimer);
  port.onDisconnect.addListener(() => {
    disarmTimer = setTimeout(async () => {
      if (!isBusy(await getSession())) disarm();
    }, 3000);
  });
});

// ---------- history ----------
async function archiveSession(session) {
  if (!session || !session.segments || session.segments.length === 0) return;
  const settings = await getSettings();
  const { history = [] } = await chrome.storage.local.get('history');
  const withoutDup = history.filter((h) => h.id !== session.id);
  withoutDup.unshift({ ...session, status: 'archived' });
  await chrome.storage.local.set({ history: withoutDup.slice(0, settings.historyLimit) });
}

// ---------- recording ----------
async function startRecording({ tabId, title, attendees, templateId }) {
  const existing = await getSession();
  if (isBusy(existing)) throw new Error('A recording is already running.');
  await archiveSession(existing);

  const tab = await chrome.tabs.get(tabId);
  const settings = await getSettings();

  // Use the audio grabbed at the icon click; otherwise try a fresh capture.
  const armed = await getArmed();
  let streamId = null;
  if (!(armed && armed.tabId === tabId && (await hasOffscreen()))) {
    if (armed) await disarm();
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      throw new Error(
        'NEEDS_ICON_CLICK: Chrome only lets MeetNotes record a tab right after you click its icon on that tab. ' +
          'Go to the meeting tab and click the MeetNotes icon (or press Alt+Shift+M), then press Start.'
      );
    }
  }
  await chrome.storage.session.remove('armed');
  await ensureOffscreen();

  // Remember names for the "who is speaking" buttons next time.
  const names = (attendees || '').split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length) {
    const recent = [...new Set([...names, ...(settings.recentNames || [])])].slice(0, 20);
    const { settings: raw = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...raw, recentNames: recent } });
  }

  const startedAt = Date.now();
  await setSession({
    id: 'm_' + startedAt,
    title: title || tab.title || 'Meeting',
    tabTitle: tab.title,
    tabUrl: tab.url,
    tabId,
    attendees: attendees || '',
    templateId: templateId || settings.defaultTemplateId,
    startedAt,
    endedAt: null,
    status: 'recording',
    segments: [],
    speakers: {},
    notes: '',
    slack: '',
    gdocUrl: '',
    driveUrl: '',
    error: ''
  });
  await setEngine({ queue: 0, error: '', micStatus: 'pending', heard: false, levels: null });

  try {
    await sendToOffscreen({ target: 'offscreen', type: 'start', streamId, startedAt, settings: engineConfig(settings) });
  } catch (e) {
    await setSession({ status: 'stopped', endedAt: Date.now(), error: e.message });
    scheduleIdleClose();
    throw e;
  }
}

async function stopRecording() {
  const session = await getSession();
  if (!session || session.status !== 'recording') return;
  await setSession({ status: 'finishing', endedAt: Date.now() });
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
  } else {
    await setSession({ status: 'stopped' });
  }
}

// Serialise storage writes for segments so none are lost.
let writeChain = Promise.resolve();
function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error(e));
  return writeChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'bg') return;
  (async () => {
    switch (msg.type) {
      case 'start':
        await startRecording(msg);
        return { ok: true };
      case 'stop':
        await stopRecording();
        return { ok: true };
      case 'disarm':
        await disarm();
        return { ok: true };
      case 'disarmed': // offscreen released the tab on its own (idle timeout or tab gone)
        await chrome.storage.session.remove('armed');
        scheduleIdleClose();
        return { ok: true };
      case 'segment':
        await queueWrite(async () => {
          const s = await getSession();
          if (!s) return;
          const speakers = { ...(s.speakers || {}) };
          if (msg.newSpeaker && !speakers[msg.newSpeaker.id]) {
            const n = Object.keys(speakers).length + 1;
            speakers[msg.newSpeaker.id] = { label: `Speaker ${n}`, name: '', sample: msg.newSpeaker.sample, askedAt: Date.now() };
          }
          const segments = [...(s.segments || []), msg.segment].sort((a, b) => a.t - b.t);
          await setSession({ segments, speakers });
        });
        return { ok: true };
      case 'line-speaker': {
        // One line was said by someone else: fix it, and teach that voice for the rest of the meeting.
        let id = null;
        await queueWrite(async () => {
          const s = await getSession();
          if (!s) return;
          const settings = await getSettings();
          const r = assignLine(s, msg.t, msg.text, msg.name, settings.myName);
          id = r.id;
          await setSession({ speakers: r.speakers, segments: r.segments });
        });
        if (id && id !== 'me' && (await hasOffscreen()))
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'teach', t: msg.t, id }).catch(() => {});
        return { ok: true };
      }
      case 'name-speaker': {
        // Done here (not in the panel) so it can't clash with incoming transcript lines.
        let mergedInto = null;
        await queueWrite(async () => {
          const s = await getSession();
          if (!s) return;
          const speakers = { ...(s.speakers || {}) };
          const same = Object.entries(speakers).find(([oid, sp]) => oid !== msg.id && (sp.name || '').toLowerCase() === msg.name.toLowerCase());
          let segments = s.segments || [];
          if (same) {
            mergedInto = same[0];
            segments = segments.map((x) => (x.spk === msg.id ? { ...x, spk: mergedInto } : x));
            delete speakers[msg.id];
          } else if (speakers[msg.id]) {
            speakers[msg.id] = { ...speakers[msg.id], name: msg.name };
          }
          await setSession({ speakers, segments });
        });
        if (mergedInto && (await hasOffscreen()))
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'merge', from: msg.id, into: mergedInto }).catch(() => {});
        return { ok: true };
      }
      case 'engine':
        await setEngine(msg.state);
        return { ok: true };
      case 'stopped':
        await queueWrite(async () => {
          await setSession({ status: 'stopped' });
          await setEngine({ queue: 0 });
        });
        scheduleIdleClose(); // keep the model warm for a while
        return { ok: true };
      case 'warm': {
        // The panel opened: start loading the model so it's ready by Start.
        const s = await getSettings();
        if (!s.setupDone) return { ok: true };
        await ensureOffscreen();
        await sendToOffscreen({ target: 'offscreen', type: 'warm', settings: engineConfig(s) });
        if (!isBusy(await getSession())) scheduleIdleClose();
        return { ok: true };
      }
      case 'archive':
        await archiveSession(await getSession());
        await chrome.storage.local.remove('session');
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (s && s.status === 'recording' && s.tabId === tabId) stopRecording();
  const armed = await getArmed();
  if (armed && armed.tabId === tabId) disarm();
});

// Keep the "Ready" tab title fresh (Sevv changes it when you join a room).
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.title) return;
  const armed = await getArmed();
  if (armed && armed.tabId === tabId) await chrome.storage.session.set({ armed: { ...armed, title: tab.title } });
});

// Exposed for automated tests only.
self.__meetnotes = { invoke, armTab, disarm };
