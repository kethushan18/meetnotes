import { getSettings, saveSettings, DEFAULTS, DEFAULT_TEMPLATES, DEFAULT_SLACK_PROMPT, DEFAULT_SYSTEM_PROMPT } from './lib/settings.js';
import { listModels } from './lib/claude.js';

const $ = (id) => document.getElementById(id);
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }
];
const TEXT = ['apiKey', 'myName', 'out_slackWebhook', 'gdocClientId', 'gdocFolderId', 'driveFolderId', 'systemPrompt', 'slackPrompt', 'asrModel', 'voiceMatch'];
const NUM = ['maxChunkSec', 'silenceThreshold', 'maxTokens', 'historyLimit'];
const BOOL = ['recordMic', 'voiceNaming', 'showVoiceScores', 'autoGenerate', 'out_markdown', 'out_markdownAuto', 'out_slack', 'out_slackAutoPost', 'out_gdoc', 'out_gdocAuto', 'out_includeTranscript', 'out_drive', 'out_driveAuto'];

let templates = [];
let dirty = false;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2000);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function markDirty() {
  dirty = true;
  $('saveState').textContent = 'Unsaved changes';
}

function fillModels(models, selected) {
  const ids = new Set(models.map((m) => m.id));
  $('model').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.id)})</option>`).join('');
  if (ids.has(selected)) {
    $('model').value = selected;
    $('modelCustom').value = '';
  } else {
    $('modelCustom').value = selected || '';
  }
}

function renderTemplates() {
  $('templates').innerHTML = templates
    .map(
      (t, i) => `<div class="tpl" data-i="${i}">
        <div class="row"><input type="text" class="tplName" value="${esc(t.name)}" aria-label="Template name">
        <button class="btn ghost tplDel" style="flex:none" ${templates.length <= 1 ? 'disabled' : ''}>Delete</button></div>
        <textarea class="tplPrompt" rows="7" aria-label="Template instructions">${esc(t.prompt)}</textarea>
      </div>`
    )
    .join('');
  const sel = $('defaultTemplateId');
  const cur = sel.value;
  sel.innerHTML = templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (templates.some((t) => t.id === cur)) sel.value = cur;
}

$('templates').addEventListener('input', (e) => {
  const box = e.target.closest('.tpl');
  if (!box) return;
  const t = templates[Number(box.dataset.i)];
  if (e.target.classList.contains('tplName')) {
    t.name = e.target.value;
    const opt = $('defaultTemplateId').querySelector(`option[value="${CSS.escape(t.id)}"]`);
    if (opt) opt.textContent = t.name;
  }
  if (e.target.classList.contains('tplPrompt')) t.prompt = e.target.value;
  markDirty();
});
$('templates').addEventListener('click', (e) => {
  if (!e.target.classList.contains('tplDel')) return;
  const i = Number(e.target.closest('.tpl').dataset.i);
  templates.splice(i, 1);
  renderTemplates();
  markDirty();
});
$('btnAddTpl').onclick = () => {
  templates.push({ id: 't_' + Date.now(), name: 'New style', prompt: '## Summary\n\n## Action items\nA checklist with owner.' });
  renderTemplates();
  markDirty();
};
$('btnResetTpl').onclick = () => {
  if (!confirm('Replace your templates with the defaults?')) return;
  templates = structuredClone(DEFAULT_TEMPLATES);
  renderTemplates();
  $('defaultTemplateId').value = 'general';
  markDirty();
};
$('btnResetPrompts').onclick = () => {
  $('systemPrompt').value = DEFAULT_SYSTEM_PROMPT;
  $('slackPrompt').value = DEFAULT_SLACK_PROMPT;
  markDirty();
};

$('btnTestKey').onclick = async () => {
  const key = $('apiKey').value.trim();
  const out = $('keyResult');
  if (!key) {
    out.innerHTML = '<span class="err">Paste a key first.</span>';
    return;
  }
  out.textContent = 'Checking...';
  try {
    const models = await listModels(key);
    const current = $('modelCustom').value.trim() || $('model').value;
    fillModels(models.length ? models : FALLBACK_MODELS, current);
    out.innerHTML = `<span class="ok">Key works. ${models.length} models available.</span>`;
  } catch (e) {
    out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};

$('btnSetup').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });

async function save() {
  const patch = {};
  for (const k of TEXT) patch[k] = $(k).value.trim();
  for (const k of NUM) {
    const v = Number($(k).value);
    patch[k] = Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  }
  for (const k of BOOL) patch[k] = $(k).checked;
  patch.model = $('modelCustom').value.trim() || $('model').value;
  patch.notesEngine = document.querySelector('input[name=notesEngine]:checked')?.value || 'claudeai';
  patch.openIn = document.querySelector('input[name=openIn]:checked')?.value || 'app';
  if (patch.notesEngine === 'api' && !patch.apiKey) toast('Claude API engine selected but no API key is saved');
  patch.maxChunkSec = Math.min(29, Math.max(4, patch.maxChunkSec));
  patch.templates = templates.filter((t) => t.name.trim() && t.prompt.trim());
  patch.defaultTemplateId = $('defaultTemplateId').value || patch.templates[0]?.id;
  if ((patch.out_gdoc || patch.out_drive) && !patch.gdocClientId) toast('A Google option is on but there is no client ID yet');
  await saveSettings(patch);
  dirty = false;
  $('saveState').textContent = 'All changes saved';
  toast('Settings saved');
}
$('btnSave').onclick = save;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});
document.addEventListener('input', (e) => {
  if (e.target.closest('main') && !e.target.closest('#templates')) markDirty();
});
document.addEventListener('change', (e) => {
  if (e.target.closest('main') && !e.target.closest('#templates')) markDirty();
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

(async () => {
  const s = await getSettings();
  for (const k of TEXT) $(k).value = s[k] ?? '';
  for (const k of NUM) $(k).value = s[k];
  for (const k of BOOL) $(k).checked = !!s[k];
  fillModels(FALLBACK_MODELS, s.model);
  for (const [name, val] of [['notesEngine', s.notesEngine], ['openIn', s.openIn]]) {
    const radio = document.querySelector(`input[name=${name}][value="${val}"]`);
    if (radio) radio.checked = true;
  }
  const e = s.engineReady;
  $('engineLine').innerHTML = e
    ? `<span class="ok">Speech engine ready:</span> ${/moonshine/i.test(e.model) ? 'Moonshine' : 'Whisper'} on ${e.device === 'webgpu' ? 'GPU' : 'CPU'}, about ${e.speedX}x real time.`
    : '<span class="warn">Speech engine not set up yet.</span>';
  const syncEngine = () => ($('apiBlock').style.opacity = document.querySelector('input[name=notesEngine]:checked')?.value === 'api' ? '1' : '0.6');
  document.querySelectorAll('input[name=notesEngine]').forEach((r) => r.addEventListener('change', syncEngine));
  syncEngine();
  templates = structuredClone(s.templates);
  renderTemplates();
  $('defaultTemplateId').value = s.defaultTemplateId;
  $('redirectUri').textContent = chrome.identity.getRedirectURL();
  if (s.apiKey) $('btnTestKey').click();
})();
