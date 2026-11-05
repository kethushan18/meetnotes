import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path'; import fs from 'node:fs';
const ext = path.resolve('dist-test'); const ID = 'molngpmollhmnghpbbojepobopjippdk'; const shots = path.resolve('test/.shots'); fs.mkdirSync(shots, { recursive: true });
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw8-' + Date.now(), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], viewport: { width: 380, height: 820 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
const errors = []; ctx.on('weberror', (e) => { const u = e.page()?.url() || ''; if (u.startsWith('chrome-extension')) errors.push(u.split('/').pop() + ' :: ' + e.error().message); });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const log = (...a) => console.log(...a);

// ---------- setup wizard opens on install ----------
await new Promise((r) => setTimeout(r, 1500));
let setup = ctx.pages().find((p) => p.url().includes('setup.html'));
log('SETUP opened on install:', !!setup);
await setup.setViewportSize({ width: 760, height: 900 });
await setup.screenshot({ path: `${shots}/setup-1.png` });
await setup.fill('#myName', 'Alex'); await setup.click('#nameNext');
await setup.screenshot({ path: `${shots}/setup-2.png` });
await setup.click('#pinSkip');
await setup.click('#micAllow'); await setup.waitForTimeout(600);
log('mic step ok:', await setup.isEnabled('#micNext'), '|', await setup.textContent('#micText'));
await setup.screenshot({ path: `${shots}/setup-3.png` });
await setup.click('#micNext');
await setup.waitForSelector('#modelStatus .err, #modelResult:not(.hidden)', { timeout: 60000 });
log('model step (HF blocked here):', (await setup.textContent('#modelStatus')).slice(0, 140));
await setup.screenshot({ path: `${shots}/setup-4.png` });
// simulate a successful download to continue the flow
await setup.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, engineReady: { model: 'onnx-community/moonshine-base-ONNX', device: 'webgpu', speedX: 18, at: Date.now() } } }); });
await setup.evaluate(() => { document.getElementById('modelNext').disabled = false; });
await setup.click('#modelNext');
const [openTab] = await Promise.all([ctx.waitForEvent('page'), setup.click('#claudeTest')]);
log('setup claude helper tab:', decodeURIComponent(openTab.url().split('?u=')[1] || '').slice(0, 40));
await openTab.close().catch(() => {});
await setup.bringToFront();
await setup.click('#claudeOk'); await setup.click('#claudeNext');
await setup.screenshot({ path: `${shots}/setup-6.png` });
await setup.click('#finish').catch(() => {});
await new Promise((r) => setTimeout(r, 500));
log('finish without a model returns to model step:', await setup.isVisible('[data-step="model"]').catch(() => 'closed'));
await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, setupDone: true } }); });
const st = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
log('SETTINGS after setup:', JSON.stringify({ myName: st.myName, recordMic: st.recordMic, setupDone: st.setupDone, openIn: st.openIn, v: st.v }));

// ---------- side panel ----------
const sp = await ctx.newPage(); await sp.goto(`chrome-extension://${ID}/sidepanel.html`); await sp.waitForTimeout(500);
await sp.screenshot({ path: `${shots}/v2-idle.png` });
log('IDLE view:', await sp.isVisible('#viewIdle'));
await sp.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, recentNames: ['Sam', 'Priya', 'Jordan'] } });
  await chrome.storage.session.set({ armed: { tabId: 1, title: 'HR weekly sync | Sevv', url: 'https://app.sevv.io/r/hr', favIconUrl: '', at: Date.now() }, engine: { ready: true, device: 'webgpu' } });
});
await sp.waitForTimeout(400);
await sp.click('[data-add="Sam"]'); await sp.click('[data-add="Priya"]');
log('READY view:', await sp.isVisible('#viewReady'), '| attendees:', await sp.inputValue('#inAttendees'), '| title:', await sp.inputValue('#inTitle'), '| engine:', await sp.textContent('#engineIdle'));
await sp.screenshot({ path: `${shots}/v2-ready.png` });

// recording with voices
await sp.evaluate(async () => {
  await chrome.storage.session.remove('armed');
  await chrome.storage.session.set({ engine: { ready: true, device: 'webgpu', micStatus: 'on', status: 'Listening (GPU)' } });
  await chrome.storage.local.set({ session: { id: 'm_r', title: 'HR weekly sync', attendees: 'Sam, Priya', startedAt: Date.now() - 95000, status: 'recording', templateId: 'general',
    segments: [ { t: 1000, dur: 3000, spk: 's1', text: 'Morning all, shall we start with hiring?' }, { t: 5000, dur: 3000, spk: 'me', text: 'Yes, three finalists for support.' } ],
    speakers: { s1: { label: 'Speaker 1', name: '', ask: true, sample: 'Morning all, shall we start with hiring?', askedAt: 1 } } } });
});
await sp.waitForTimeout(400);
log('ASK card visible:', await sp.isVisible('#askCard'), '|', await sp.textContent('#askTitle'), '|', await sp.textContent('#askQuote'));
await sp.screenshot({ path: `${shots}/v2-ask.png` });
await sp.click('#askChips [data-name="Sam"]'); await sp.waitForTimeout(300);
let s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
log('named s1 ->', s.speakers.s1.name, '| ask visible:', await sp.isVisible('#askCard'));
// second voice which is actually Sam again -> merge
await sp.evaluate(async () => {
  const { session } = await chrome.storage.local.get('session');
  session.segments.push({ t: 9000, dur: 3000, spk: 's2', text: 'And the budget is approved.' });
  session.speakers.s2 = { label: 'Speaker 2', name: '', ask: true, sample: 'And the budget is approved.', askedAt: 2 };
  await chrome.storage.local.set({ session });
});
await sp.waitForTimeout(300);
await sp.fill('#askName', 'sam'); await sp.click('#askSave'); await sp.waitForTimeout(300);
s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
log('merge: speakers', Object.keys(s.speakers).join(','), '| segment spks', s.segments.map((x) => x.spk).join(','));
await sp.screenshot({ path: `${shots}/v2-recording.png` });

// ---------- done ----------
await sp.evaluate(async () => {
  const { session } = await chrome.storage.local.get('session');
  session.status = 'stopped'; session.endedAt = Date.now();
  session.segments.push({ t: 14000, dur: 3000, spk: 's3', text: 'I can start the onboarding next week.' });
  session.speakers.s3 = { label: 'Speaker 2', name: '', sample: 'I can start the onboarding next week.', askedAt: 3 };
  await chrome.storage.local.set({ session });
});
await sp.waitForTimeout(400);
await sp.screenshot({ path: `${shots}/v2-done.png` });
log('DONE chips:', await sp.locator('#speakerChips .chip').allTextContents());
await sp.click('[data-rename="s3"]'); await sp.waitForTimeout(200);
log('rename card:', await sp.isVisible('#askCard'), await sp.textContent('#askTitle'));
await sp.click('#askChips [data-name="Priya"]'); await sp.waitForTimeout(300);
log('after rename chips:', await sp.locator('#speakerChips .chip').allTextContents());

// Open in Claude (short -> prefilled)
const [t1] = await Promise.all([ctx.waitForEvent('page'), sp.click('#btnOpenClaude')]);
const href = decodeURIComponent(t1.url().split('?u=')[1] || ''); await t1.close().catch(() => {});
const clip = await sp.evaluate(() => navigator.clipboard.readText());
log('OPEN short: scheme', href.slice(0, 26), '| prefilled q:', href.includes('?q='), '| q length', decodeURIComponent(href.split('?q=')[1] || '').length, '| names in prompt:', clip.includes('Sam:') && clip.includes('Priya:') && clip.includes('Alex:'), '| panel url ok:', sp.url().endsWith('sidepanel.html'));
fs.writeFileSync(`${shots}/v2-prompt.txt`, clip);
// long meeting -> no q, clipboard
await sp.evaluate(async () => {
  const { session } = await chrome.storage.local.get('session');
  for (let i = 0; i < 260; i++) session.segments.push({ t: 20000 + i * 5000, dur: 4000, spk: i % 2 ? 's1' : 'me', text: 'This is a longer discussion point number ' + i + ' about the hiring plan and onboarding timsam.' });
  await chrome.storage.local.set({ session });
});
await sp.waitForTimeout(300);
const [t2] = await Promise.all([ctx.waitForEvent('page'), sp.click('#btnOpenClaude')]);
const href2 = decodeURIComponent(t2.url().split('?u=')[1] || ''); await t2.close().catch(() => {});
log('OPEN long: href', href2, '| clipboard length', (await sp.evaluate(() => navigator.clipboard.readText())).length);

// paste back
await sp.click('#btnShowPaste');
await sp.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', '# HR weekly sync\n\n## Summary\nThree finalists for support; budget approved.\n\n## Action items\n- [ ] Alex: send offers\n\n---\n\n## Slack summary\n*HR weekly sync*\n*TL;DR* Offers go out this week.');
  document.getElementById('pasteArea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await sp.waitForTimeout(400);
s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
log('PASTE saved notes:', !!s.notes, '| slack:', !!s.slack, '| buttons:', (await sp.locator('#doneActions .btn:not(.hidden)').allTextContents()).join(' | '));
await sp.screenshot({ path: `${shots}/v2-notes.png` });

// options
const opt = await ctx.newPage(); await opt.setViewportSize({ width: 820, height: 1000 });
await opt.goto(`chrome-extension://${ID}/options.html`); await opt.waitForTimeout(400);
await opt.screenshot({ path: `${shots}/v2-options.png`, fullPage: true });
log('OPTIONS engine line:', await opt.textContent('#engineLine'), '| openIn checked:', await opt.evaluate(() => document.querySelector('input[name=openIn]:checked')?.value));
await opt.check('#recordMic'); await opt.selectOption('#voiceMatch', 'loose'); await opt.click('#btnSave'); await opt.waitForTimeout(300);
log('OPTIONS saved voiceMatch:', (await opt.evaluate(async () => (await chrome.storage.local.get('settings')).settings.voiceMatch)));

// offscreen warm with HF blocked -> clean error
const r = await sw.evaluate(async () => { try { return await chrome.runtime.sendMessage({ target: 'bg', type: 'warm' }); } catch (e) { return e.message; } });
await new Promise((res) => setTimeout(res, 8000));
log('WARM:', JSON.stringify(r), '| engine:', JSON.stringify(await sw.evaluate(async () => (await chrome.storage.session.get('engine')).engine)).slice(0, 220));
log('ERRORS', JSON.stringify(errors));
await ctx.close();
