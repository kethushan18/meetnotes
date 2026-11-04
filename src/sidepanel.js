import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getSettings } from './lib/settings.js';
import {
  streamMessage,
  buildNotesRequest,
  buildSlackRequest,
  buildClaudeAiPrompt,
  buildTranscriptDoc,
  claudeOpenPlan,
  speakerName,
  fmtTime
} from './lib/claude.js';
import { downloadMarkdown, postToSlack, createGoogleDoc, saveTranscriptToDrive, fullMarkdown } from './lib/outputs.js';
import { assignLine } from './lib/lines.js';

marked.setOptions({ gfm: true, breaks: false });

const $ = (id) => document.getElementById(id);
const ui = {
  settings: null,
  session: null,
  engine: {},
  history: [],
  armed: null,
  armError: '',
  showHistory: false,
  viewingId: null,
  generating: false,
  savingDrive: false,
  autoDone: new Set(),
  autoDrive: new Set(),
  skipped: new Set(), // speakers the user chose to name later
  renaming: null, // speaker id being renamed after the meeting
  lineFix: null, // { t, text, spk } a single line being reassigned
  timer: null,
  activeTab: null
};

// ---------- helpers ----------
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const show = (id, on) => $(id).classList.toggle('hidden', !on);
function showError(msg) {
  $('bannerError').textContent = msg || '';
  show('bannerError', !!msg);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const renderMd = (md) => DOMPurify.sanitize(marked.parse(md || ''));
const send = (msg) => chrome.runtime.sendMessage({ target: 'bg', ...msg });
const currentItem = () => (ui.viewingId ? ui.history.find((h) => h.id === ui.viewingId) || null : ui.session);
const cleanTitle = (t) => (t || '').replace(/\s*[|·-]\s*(Sevv|Google Meet|Zoom|Microsoft Teams).*$/i, '').trim() || t;
const names = (str) => (str || '').split(',').map((n) => n.trim()).filter(Boolean);

// Writes are queued so parallel saves (notes, Slack, Drive link) never overwrite each other.
let saveChain = Promise.resolve();
function saveItem(patch) {
  const viewing = ui.viewingId;
  saveChain = saveChain.then(async () => {
    if (viewing) {
      const { history = [] } = await chrome.storage.local.get('history');
      const i = history.findIndex((h) => h.id === viewing);
      if (i >= 0) {
        history[i] = { ...history[i], ...patch };
        await chrome.storage.local.set({ history });
        ui.history = history;
      }
    } else {
      const { session } = await chrome.storage.local.get('session');
      ui.session = { ...(session || {}), ...patch };
      await chrome.storage.local.set({ session: ui.session });
    }
  });
  return saveChain;
}

function fillTemplates(select, selectedId) {
  select.innerHTML = ui.settings.templates
    .map((t) => `<option value="${esc(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.name)}</option>`)
    .join('');
}
function selectedTemplate() {
  const s = ui.settings;
  const id = $('doneTemplate').value || currentItem()?.templateId || s.defaultTemplateId;
  return s.templates.find((t) => t.id === id) || s.templates[0];
}

function transcriptHtml(item) {
  const segs = item?.segments || [];
  if (!segs.length) return '<div class="empty">Waiting for speech...</div>';
  return segs
    .map((s, i) => {
      const label = speakerName(s, item.speakers, ui.settings.myName);
      const unnamed = s.spk && item.speakers?.[s.spk] && !item.speakers[s.spk].name;
      const cls = s.spk === 'me' || s.speaker === 'Me' ? 'me' : unnamed ? 'unnamed' : '';
      const score = ui.settings.showVoiceScores && s.score != null && s.spk !== 'me' ? `<span class="score">${s.score.toFixed(2)}</span>` : '';
      return `<div class="seg" data-i="${i}" title="Tap to change who said this"><span class="ts">${fmtTime(s.t)}</span><span>${
        label ? `<span class="sp ${cls}">${esc(label)}:</span> ` : ''
      }${esc(s.text)}${score}</span></div>`;
    })
    .join('');
}

// ---------- speakers ----------
function pendingSpeakers(item) {
  return Object.entries(item?.speakers || {})
    .filter(([id, sp]) => !sp.name && !ui.skipped.has(id))
    .sort((a, b) => (a[1].askedAt || 0) - (b[1].askedAt || 0));
}
function nameOptions(item) {
  const used = new Set(Object.values(item?.speakers || {}).map((s) => (s.name || '').toLowerCase()));
  const pool = [...names(item?.attendees), ...(ui.settings.recentNames || [])];
  const seen = new Set();
  return pool
    .filter((n) => {
      const k = n.toLowerCase();
      if (seen.has(k) || k === (ui.settings.myName || '').toLowerCase()) return false;
      seen.add(k);
      return true;
    })
    .map((n) => ({ name: n, used: used.has(n.toLowerCase()) }));
}
async function nameSpeaker(id, rawName) {
  const name = (rawName || '').trim();
  if (!name || !id) return;
  const item = currentItem();
  if (!ui.viewingId && item.status === 'recording') {
    // While recording, the background owns the session so names and new lines don't clash.
    await send({ type: 'name-speaker', id, name });
  } else {
    const speakers = { ...(item.speakers || {}) };
    const same = Object.entries(speakers).find(([oid, sp]) => oid !== id && (sp.name || '').toLowerCase() === name.toLowerCase());
    let segments = item.segments;
    if (same) {
      // Same person as an existing voice: merge the two.
      segments = segments.map((s) => (s.spk === id ? { ...s, spk: same[0] } : s));
      delete speakers[id];
    } else {
      speakers[id] = { ...speakers[id], name };
    }
    await saveItem({ speakers, segments });
  }
  ui.skipped.delete(id);
  ui.renaming = null;
  // Remember the name for next time.
  const recent = [name, ...(ui.settings.recentNames || []).filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 20);
  const { settings: raw = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...raw, recentNames: recent } });
  render();
}

// ---------- render ----------
function render() {
  const s = ui.settings;
  const item = currentItem();
  const status = ui.viewingId ? 'stopped' : item?.status;
  let view;
  if (ui.showHistory) view = 'history';
  else if (status === 'recording') view = 'recording';
  else if (status === 'finishing' || status === 'stopped') view = 'done';
  else if (!s.setupDone) view = 'setup';
  else if (ui.armed) view = 'ready';
  else view = 'idle';

  for (const v of ['Setup', 'Idle', 'Ready', 'Recording', 'Done', 'History']) show('view' + v, view === v.toLowerCase());
  show('doneActions', view === 'done');

  clearInterval(ui.timer);
  if (view === 'idle') renderIdle();
  if (view === 'ready') renderReady();
  if (view === 'recording') {
    renderRecording(item);
    const tick = () => ($('timer').textContent = fmtTime(Date.now() - item.startedAt));
    tick();
    ui.timer = setInterval(tick, 1000);
  }
  if (view === 'done') renderDone(item);
  if (view === 'history') renderHistory();
  renderAsk(item, view);
}

// The "who is speaking?" card: new voices while recording, or a rename afterwards.
function renderAsk(item, view) {
  if (ui.lineFix && (view === 'done' || view === 'recording')) return renderLineFix(item);
  let id = null;
  let rename = false;
  if (ui.renaming && (view === 'done' || view === 'recording') && item?.speakers?.[ui.renaming]) {
    id = ui.renaming;
    rename = true;
  } else if (view === 'recording' && ui.settings.voiceNaming) {
    id = pendingSpeakers(item)[0]?.[0] || null;
  }
  show('askCard', !!id);
  if (!id) return;
  const sp = item.speakers[id];
  const card = $('askCard');
  if (card.dataset.id !== id) {
    card.dataset.id = id;
    $('askName').value = rename ? sp.name || '' : '';
  }
  $('askTitle').textContent = rename ? `Who is ${sp.name || sp.label}?` : 'New voice. Who is speaking?';
  const sample = sp.sample || '';
  $('askQuote').textContent = sample ? `"${sample.slice(0, 110)}${sample.length > 110 ? '...' : ''}"` : '';
  $('askChips').innerHTML = nameOptions(item)
    .map((o) => `<button class="chip ${o.used ? 'used' : ''}" data-name="${esc(o.name)}">${esc(o.name)}</button>`)
    .join('');
  $('askSkip').textContent = rename ? 'Cancel' : 'Later';
  show('askAlt', false);
  const pending = rename ? [] : pendingSpeakers(item);
  $('askMore').textContent = pending.length > 1 ? `${pending.length - 1} more new voice${pending.length > 2 ? 's' : ''} waiting` : '';
}

// "Who said this line?" Fixes one line and teaches that voice for the rest of the meeting.
function renderLineFix(item) {
  const f = ui.lineFix;
  show('askCard', true);
  const card = $('askCard');
  const key = 'line:' + f.t;
  if (card.dataset.id !== key) {
    card.dataset.id = key;
    $('askName').value = '';
  }
  $('askTitle').textContent = 'Who said this?';
  $('askQuote').textContent = `"${f.text.slice(0, 110)}${f.text.length > 110 ? '...' : ''}"`;
  const named = Object.values(item.speakers || {}).map((sp) => sp.name).filter(Boolean);
  const pool = [ui.settings.myName || 'Me', ...named, ...nameOptions(item).map((o) => o.name)];
  const seen = new Set();
  $('askChips').innerHTML = pool
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
    .map((n) => `<button class="chip" data-name="${esc(n)}">${esc(n)}</button>`)
    .join('');
  $('askSkip').textContent = 'Cancel';
  $('askMore').textContent = 'Later lines in this voice will follow your choice.';
  const voice = f.spk && item.speakers?.[f.spk];
  show('askAlt', !!voice);
  if (voice) $('askAlt').textContent = `Or rename "${voice.name || voice.label}" everywhere`;
}

async function fixLine(name) {
  const f = ui.lineFix;
  const n = (name || '').trim();
  if (!f || !n) return;
  const item = currentItem();
  if (!ui.viewingId && item.status === 'recording') {
    await send({ type: 'line-speaker', t: f.t, text: f.text, name: n });
  } else {
    const r = assignLine(item, f.t, f.text, n, ui.settings.myName);
    await saveItem({ speakers: r.speakers, segments: r.segments });
  }
  ui.lineFix = null;
  toast(`Line set to ${n}`);
  render();
}

function engineLine() {
  const e = ui.engine || {};
  if (e.error) return `<span class="err">${esc(e.error)}</span>`;
  if (e.loading) return esc(e.status || 'Starting speech engine...');
  if (e.ready) {
    const voiceWarn = typeof e.voices === 'string' && e.voices.startsWith('failed')
      ? ` <span class="warn">Voice naming is off: ${esc(e.voices.slice(8))}</span>`
      : '';
    return `Speech engine ready${e.device ? ` (${e.device === 'webgpu' ? 'GPU' : 'CPU'})` : ''}${voiceWarn}`;
  }
  return '';
}

function renderIdle() {
  const warn = ui.armError ? 'Could not get the tab ready: ' + ui.armError : '';
  $('idleWarn').textContent = warn;
  show('idleWarn', !!warn);
}

function renderReady() {
  const a = ui.armed;
  if (!a) return;
  $('tabTitle').textContent = a.title || a.url;
  $('tabIcon').src = a.favIconUrl || 'icons/16.png';
  if ($('inTitle').dataset.for !== String(a.tabId) || !$('inTitle').dataset.touched) {
    $('inTitle').value = cleanTitle(a.title);
    $('inTitle').dataset.for = String(a.tabId);
  }
  if (!$('inTemplate').options.length) fillTemplates($('inTemplate'), ui.settings.defaultTemplateId);
  const typed = new Set(names($('inAttendees').value).map((n) => n.toLowerCase()));
  $('recentChips').innerHTML = (ui.settings.recentNames || [])
    .filter((n) => !typed.has(n.toLowerCase()))
    .slice(0, 8)
    .map((n) => `<button class="chip" data-add="${esc(n)}">+ ${esc(n)}</button>`)
    .join('');
  $('engineIdle').innerHTML = engineLine();
}

function renderRecording(item) {
  const e = ui.engine || {};
  let status = engineLine() || 'Listening';
  if (e.queue > 2) status += ` · catching up (${e.queue})`;
  $('engineStatus').innerHTML = status;
  const mic = e.micStatus;
  $('micPill').textContent = mic === 'on' ? 'Mic on' : mic === 'off' ? 'Mic off' : mic === 'denied' ? 'Mic blocked' : '';
  show('micPill', !!$('micPill').textContent);

  // Live levels, and a warning if the meeting tab stays silent (catches capture problems early).
  const lv = e.levels;
  const pct = (x) => Math.min(100, Math.round(Math.sqrt(x || 0) * 300)) + '%';
  $('lvTab').style.width = pct(lv?.tab);
  $('lvMe').style.width = e.micStatus === 'on' ? pct(lv?.me) : '0%';
  if (lv && lv.tab > 0.002) ui.lastTabSound = Date.now();
  const since = Date.now() - Math.max(item.startedAt, ui.lastTabSound || 0);
  show('silentWarn', !!lv && since > 30000);

  const content = $('content');
  const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 80;
  $('liveTranscript').innerHTML = item.segments?.length
    ? transcriptHtml(item)
    : `<div class="empty">${e.loading ? 'Getting the speech engine ready...' : 'Listening for speech...'}</div>`;
  if (nearBottom) content.scrollTop = content.scrollHeight;
}

function renderDone(item) {
  if (!item) return;
  const s = ui.settings;
  const useApi = s.notesEngine === 'api';
  $('doneTitle').textContent = item.title;
  const mins = item.endedAt ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 60000)) : null;
  $('doneMeta').textContent = [new Date(item.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }), mins ? `${mins} min` : null]
    .filter(Boolean)
    .join(' · ');

  const finishing = item.status === 'finishing';
  $('finishingStatus').innerHTML = finishing
    ? `Finishing transcription${ui.engine.queue ? ` (${ui.engine.queue} left)` : ''}...`
    : item.error
      ? `<span class="err">${esc(item.error)}</span>`
      : '';

  // Speakers: click to name or rename
  const sp = Object.entries(item.speakers || {});
  $('speakerChips').innerHTML = sp
    .map(([id, v]) => `<button class="chip ${v.name ? '' : 'unnamed'}" data-rename="${esc(id)}" title="Click to ${v.name ? 'rename' : 'name'}">${esc(v.name || v.label + ' (who?)')}</button>`)
    .join('');

  const sel = $('doneTemplate');
  if (sel.dataset.for !== item.id) {
    fillTemplates(sel, item.templateId || s.defaultTemplateId);
    sel.dataset.for = item.id;
  }
  const noText = finishing || !item.segments?.length;
  show('btnOpenClaude', !useApi);
  show('btnGenerate', useApi);
  $('btnOpenClaude').disabled = noText;
  $('btnOpenClaude').textContent = s.openIn === 'web' ? 'Open in Claude (browser)' : 'Open in Claude';
  $('btnGenerate').disabled = noText || ui.generating;
  $('btnGenerate').textContent = ui.generating ? 'Writing...' : item.notes ? 'Rewrite notes' : 'Write notes';
  $('openHint').textContent = noText || useApi ? '' : 'Starts a new Claude chat with the transcript and your notes style.';
  show('btnShowPaste', !useApi && !noText && !item.notes);

  const hasNotes = !!item.notes;
  show('doneTabs', hasNotes || !!item.segments?.length);
  if (!ui.generating) {
    $('notesOut').innerHTML = hasNotes
      ? renderMd(item.notes)
      : `<div class="empty">${!item.segments?.length ? 'No speech was transcribed.' : useApi ? 'Press "Write notes".' : 'Your notes will be in Claude.'}</div>`;
    $('slackOut').textContent = item.slack || '';
  }
  show('tabBtnSlack', !!item.slack);
  $('doneTranscript').innerHTML = transcriptHtml(item);

  // Footer: only what makes sense right now
  show('btnCopyNotes', hasNotes);
  show('btnCopySlack', !!item.slack);
  show('btnDownload', hasNotes && s.out_markdown);
  show('btnPostSlack', !!item.slack && !!s.out_slackWebhook);
  show('btnGdoc', hasNotes && s.out_gdoc);
  show('btnDrive', s.out_drive && !noText);
  $('btnGdoc').textContent = item.gdocUrl ? 'Open Google Doc' : 'Google Doc';
  $('btnDrive').textContent = item.driveUrl ? 'Open in Drive' : ui.savingDrive ? 'Saving...' : 'Transcript to Drive';
  $('btnNew').textContent = ui.viewingId ? 'Close' : 'New meeting';

  maybeAutoGenerate(item);
  maybeAutoDrive(item);
}

function renderHistory() {
  $('historyList').innerHTML = ui.history.length
    ? ui.history
        .map((h) => {
          const d = new Date(h.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
          return `<button class="history-item" data-id="${esc(h.id)}"><div class="h-title">${esc(h.title)}</div><div class="h-meta">${d}${h.notes ? ' · notes saved' : ''}</div></button>`;
        })
        .join('')
    : '<div class="empty">No past meetings yet.</div>';
}

// ---------- Claude ----------
function openUrl(url) {
  if (url.startsWith('claude://')) {
    // A small helper tab hands the link to the Claude app and closes itself.
    chrome.tabs.create({ url: chrome.runtime.getURL('open.html?u=' + encodeURIComponent(url)) });
  } else {
    chrome.tabs.create({ url });
  }
}

async function openInClaude() {
  const item = currentItem();
  const template = selectedTemplate();
  const prompt = buildClaudeAiPrompt(item, template, ui.settings);
  const plan = claudeOpenPlan(prompt, ui.settings.openIn);
  let copied = false;
  try {
    await navigator.clipboard.writeText(prompt);
    copied = true;
  } catch (e) {
    if (!plan.prefilled) return showError('Could not copy the transcript: ' + e.message);
  }
  await saveItem({ templateId: template.id });
  ui.lastOpenUrl = plan.url; // for tests
  openUrl(plan.url);
  showError('');
  toast(plan.prefilled ? 'Opened in Claude. Check it and press Enter.' : copied ? 'Long meeting: press Cmd+V in Claude, then Enter.' : 'Opened Claude.', 4500);
}

async function saveNotesFromText(raw) {
  const text = (raw || '').trim();
  if (text.length < 40 || /<transcript>/.test(text)) {
    return showError("That isn't Claude's reply yet. In Claude, click Copy under the reply, then paste again.");
  }
  let notes = text;
  let slack = '';
  const m = text.match(/^\s*(?:#{1,6}\s*|\*\*)?Slack summary(?:\*\*)?:?\s*$/im);
  if (m) {
    notes = text.slice(0, m.index).replace(/\n\s*(?:-{3,}|\*{3,})\s*$/, '').trim();
    slack = text.slice(m.index + m[0].length).trim();
  }
  notes = notes.replace(/^#\s+.*\n+/, '');
  await saveItem({ notes, slack, gdocUrl: '', usage: null });
  show('pasteBox', false);
  showError('');
  toast('Notes saved');
  render();
  await runAutoOutputs();
}

function maybeAutoGenerate(item) {
  const s = ui.settings;
  if (ui.viewingId || s.notesEngine !== 'api' || !s.autoGenerate || !s.apiKey) return;
  if (item.status !== 'stopped' || item.notes || !item.segments?.length) return;
  if (ui.autoDone.has(item.id) || ui.generating) return;
  ui.autoDone.add(item.id);
  generate({ auto: true });
}

async function generate({ auto = false } = {}) {
  const s = ui.settings;
  const item = currentItem();
  if (!item) return;
  if (!s.apiKey) return showError('Add a Claude API key in Settings > Advanced, or switch back to the Claude app.');
  const template = selectedTemplate();
  ui.generating = true;
  showError('');
  render();
  switchTab('notes');
  $('notesOut').innerHTML = '<div class="empty">Claude is writing your notes...</div>';
  let pending = null;
  try {
    const req = buildNotesRequest(item, template, s);
    const notes = await streamMessage({
      apiKey: s.apiKey,
      model: s.model,
      maxTokens: s.maxTokens,
      system: req.system,
      user: req.user,
      onText: (t) => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          $('notesOut').innerHTML = renderMd(t);
          pending = null;
        });
      }
    });
    await saveItem({ notes: notes.text, templateId: template.id, slack: '', gdocUrl: '' });
    if (s.out_slack) {
      const sreq = buildSlackRequest(item, notes.text, s);
      const slack = await streamMessage({ apiKey: s.apiKey, model: s.model, maxTokens: 800, system: sreq.system, user: sreq.user });
      await saveItem({ slack: slack.text.trim() });
    }
    ui.generating = false;
    toast('Notes ready');
    await runAutoOutputs();
  } catch (e) {
    showError(e.message);
    if (!auto) toast('Could not write notes');
  } finally {
    ui.generating = false;
    render();
  }
}

async function runAutoOutputs() {
  const s = ui.settings;
  const item = currentItem();
  const tasks = [];
  if (s.out_markdown && s.out_markdownAuto) tasks.push(downloadMarkdown(item, s).then(() => 'Saved to Downloads/MeetNotes'));
  if (s.out_slackWebhook && s.out_slackAutoPost && item.slack) tasks.push(postToSlack(s.out_slackWebhook, item.slack).then(() => 'Posted to Slack'));
  if (s.out_gdoc && s.out_gdocAuto) tasks.push(createGoogleDoc(item, s).then(async (url) => (await saveItem({ gdocUrl: url }), 'Google Doc created')));
  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const bad = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (ok.length) toast(ok.join(' · '), 3500);
  if (bad.length) showError(bad.join(' '));
  render();
}

function maybeAutoDrive(item) {
  const s = ui.settings;
  if (ui.viewingId || !s.out_drive || !s.out_driveAuto || !s.gdocClientId) return;
  if (item.status !== 'stopped' || item.driveUrl || !item.segments?.length) return;
  if (ui.autoDrive.has(item.id) || ui.savingDrive) return;
  ui.autoDrive.add(item.id);
  saveDrive({ auto: true });
}
async function saveDrive({ auto = false } = {}) {
  const item = currentItem();
  ui.savingDrive = true;
  render();
  try {
    const url = await saveTranscriptToDrive(item, buildTranscriptDoc(item, selectedTemplate(), ui.settings), ui.settings);
    await saveItem({ driveUrl: url });
    toast('Transcript saved to Google Drive');
  } catch (e) {
    showError((auto ? 'Automatic Drive save failed: ' : '') + e.message);
  } finally {
    ui.savingDrive = false;
    render();
  }
}

function switchTab(name) {
  document.querySelectorAll('#doneTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  show('tabNotes', name === 'notes');
  show('tabSlack', name === 'slack');
  show('tabTranscript', name === 'transcript');
}

// ---------- events ----------
$('btnSettings').onclick = () => chrome.runtime.openOptionsPage();
$('btnOpenSetup').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
$('btnHistory').onclick = () => {
  ui.showHistory = true;
  render();
};
$('btnBackFromHistory').onclick = () => {
  ui.showHistory = false;
  ui.viewingId = null;
  render();
};
$('historyList').onclick = (e) => {
  const b = e.target.closest('.history-item');
  if (!b) return;
  ui.viewingId = b.dataset.id;
  ui.showHistory = false;
  showError('');
  switchTab('notes');
  render();
};

$('inTitle').oninput = () => ($('inTitle').dataset.touched = '1');
$('inAttendees').oninput = () => renderReady();
$('recentChips').onclick = (e) => {
  const n = e.target.closest('[data-add]')?.dataset.add;
  if (!n) return;
  const list = names($('inAttendees').value);
  list.push(n);
  $('inAttendees').value = list.join(', ');
  renderReady();
};

$('btnStart').onclick = async () => {
  showError('');
  const tabId = ui.armed?.tabId ?? ui.activeTab?.id;
  if (!tabId) return;
  $('btnStart').disabled = true;
  $('btnStart').textContent = 'Starting...';
  try {
    const res = await send({ type: 'start', tabId, title: $('inTitle').value.trim(), attendees: $('inAttendees').value.trim(), templateId: $('inTemplate').value });
    if (!res?.ok) throw new Error(res?.error || 'Could not start recording');
    $('inTitle').dataset.touched = '';
    $('inAttendees').value = '';
    ui.skipped.clear();
  } catch (e) {
    showError(e.message.replace(/^NEEDS_ICON_CLICK:\s*/, ''));
  } finally {
    $('btnStart').disabled = false;
    $('btnStart').textContent = 'Start recording';
  }
};
$('btnStop').onclick = () => send({ type: 'stop' });

// Naming voices while recording
const answer = (name) => (ui.lineFix ? fixLine(name) : nameSpeaker($('askCard').dataset.id, name));
$('askChips').onclick = (e) => {
  const n = e.target.closest('[data-name]')?.dataset.name;
  if (n) answer(n);
};
$('askSave').onclick = () => answer($('askName').value);
$('askName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') answer($('askName').value);
});
$('askSkip').onclick = () => {
  if (ui.lineFix) ui.lineFix = null;
  else if (ui.renaming) ui.renaming = null;
  else ui.skipped.add($('askCard').dataset.id);
  render();
};
$('askAlt').onclick = () => {
  const spk = ui.lineFix?.spk;
  ui.lineFix = null;
  if (spk) promptRename(spk);
  else render();
};
// Click a speaker label in the transcript, or a chip after the meeting, to (re)name it
function promptRename(id) {
  if (!currentItem()?.speakers?.[id]) return;
  ui.renaming = id;
  render();
  $('content').scrollTop = 0;
  $('askName').focus();
}
$('speakerChips').onclick = (e) => {
  const id = e.target.closest('[data-rename]')?.dataset.rename;
  if (id) promptRename(id);
};
// Tap any line to say who really said it.
for (const box of ['liveTranscript', 'doneTranscript']) {
  $(box).onclick = (e) => {
    const row = e.target.closest('.seg[data-i]');
    const seg = row && currentItem()?.segments?.[Number(row.dataset.i)];
    if (!seg) return;
    ui.renaming = null;
    ui.lineFix = { t: seg.t, text: seg.text, spk: seg.spk };
    render();
    $('content').scrollTop = 0;
  };
}

$('btnOpenClaude').onclick = () => openInClaude();
$('btnGenerate').onclick = () => generate();
$('btnShowPaste').onclick = () => {
  show('pasteBox', true);
  $('pasteArea').value = '';
  $('pasteArea').focus();
};
// Pasting saves straight away. No clipboard permission involved.
$('pasteArea').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (text) {
    e.preventDefault();
    $('pasteArea').value = text;
    saveNotesFromText(text);
  }
});
document.querySelectorAll('#doneTabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

$('btnCopyNotes').onclick = async () => {
  await navigator.clipboard.writeText(fullMarkdown(currentItem(), { ...ui.settings, out_includeTranscript: false }));
  toast('Notes copied');
};
$('btnCopySlack').onclick = async () => {
  await navigator.clipboard.writeText(currentItem().slack || '');
  toast('Slack summary copied');
};
$('btnDownload').onclick = async () => {
  try {
    await downloadMarkdown(currentItem(), ui.settings);
    toast('Saved to Downloads/MeetNotes');
  } catch (e) {
    showError(e.message);
  }
};
$('btnPostSlack').onclick = async () => {
  try {
    await postToSlack(ui.settings.out_slackWebhook, currentItem().slack);
    toast('Posted to Slack');
  } catch (e) {
    showError(e.message);
  }
};
$('btnGdoc').onclick = async () => {
  const item = currentItem();
  if (item.gdocUrl) return chrome.tabs.create({ url: item.gdocUrl });
  try {
    $('btnGdoc').textContent = 'Creating...';
    const url = await createGoogleDoc(item, ui.settings);
    await saveItem({ gdocUrl: url });
    chrome.tabs.create({ url });
  } catch (e) {
    showError(e.message);
  } finally {
    render();
  }
};
$('btnDrive').onclick = () => {
  const item = currentItem();
  if (item.driveUrl) return chrome.tabs.create({ url: item.driveUrl });
  saveDrive();
};
$('btnNew').onclick = async () => {
  if (ui.viewingId) {
    ui.viewingId = null;
    showError('');
    return render();
  }
  await send({ type: 'archive' });
  ui.session = null;
  showError('');
  render();
};

chrome.tabs.onActivated.addListener(async () => {
  [ui.activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.settings) {
      getSettings().then((s) => {
        ui.settings = s;
        $('inTemplate').innerHTML = '';
        $('doneTemplate').dataset.for = '';
        render();
      });
      return;
    }
    if (changes.session) ui.session = changes.session.newValue || null;
    if (changes.history) ui.history = changes.history.newValue || [];
  }
  if (area === 'session') {
    if (changes.engine) ui.engine = changes.engine.newValue || {};
    if (changes.armed) {
      ui.armed = changes.armed.newValue || null;
      if (ui.armed) showError('');
    }
    if (changes.armError) ui.armError = changes.armError.newValue || '';
  }
  render();
});

// ---------- init ----------
(async () => {
  ui.settings = await getSettings();
  const local = await chrome.storage.local.get(['session', 'history']);
  ui.session = local.session || null;
  ui.history = local.history || [];
  const sess = await chrome.storage.session.get(['engine', 'armed', 'armError']);
  ui.engine = sess.engine || {};
  ui.armed = sess.armed || null;
  ui.armError = sess.armError || '';
  [ui.activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.connect({ name: 'panel' }); // lets the background release the tab when the panel closes
  render();
  // Warm up the speech engine as soon as the panel opens.
  if (ui.settings.setupDone && ui.session?.status !== 'recording') send({ type: 'warm' }).catch(() => {});
})();
