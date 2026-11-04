import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist-test'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw9-' + Date.now(), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 380, height: 820 } });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const errors = []; ctx.on('weberror', (e) => { const u = e.page()?.url() || ''; if (u.startsWith('chrome-extension')) errors.push(e.error().message); });
const calls = []; const g = [];
await ctx.route('https://api.anthropic.com/**', (route) => {
  const body = route.request().postData() || ''; calls.push(body.includes('<notes>') ? 'slack' : 'notes');
  const txt = body.includes('<notes>') ? '*Sync* TL;DR done' : '## Summary\\nSam approved the budget.';
  route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${txt}"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n` });
});
await ctx.route('https://www.googleapis.com/**', (route) => {
  const r = route.request(); g.push(r.method() + ' ' + r.url().split('?')[0].replace('https://www.googleapis.com', '') + (r.postData()?.includes('Sam:') ? ' [names ok]' : ''));
  if (r.url().includes('/upload/')) return route.fulfill({ contentType: 'application/json', body: '{"id":"d1","webViewLink":"https://docs.google.com/document/d/d1/edit"}' });
  return route.fulfill({ contentType: 'application/json', body: '{"id":"f1"}' });
});
await new Promise((r) => setTimeout(r, 1200));
const sp = await ctx.newPage(); await sp.goto(`chrome-extension://${ID}/sidepanel.html`);
await sp.evaluate(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, v: 2, setupDone: true, notesEngine: 'api', apiKey: 'sk-test', out_drive: true, out_driveAuto: true, gdocClientId: 'cid', myName: 'Alex' } });
  await chrome.storage.session.set({ gtoken: { token: 't', expires: Date.now() + 3600e3, clientId: 'cid' } });
  await chrome.storage.local.set({ session: { id: 'm_api', title: 'Sync', startedAt: Date.now() - 600000, endedAt: Date.now(), status: 'stopped', templateId: 'general',
    segments: [{ t: 1000, dur: 2000, spk: 's1', text: 'Budget approved.' }, { t: 4000, dur: 2000, spk: 'me', text: 'Great, thanks.' }], speakers: { s1: { label: 'Speaker 1', name: 'Sam' } } } });
});
await sp.waitForFunction(async () => { const s = (await chrome.storage.local.get('session')).session; return s.notes && s.driveUrl && s.slack; }, null, { timeout: 15000 }); await sp.waitForTimeout(1500);
const s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
console.log('API notes:', JSON.stringify(s.notes), '| slack:', JSON.stringify(s.slack), '| calls', calls.join(','));
console.log('DRIVE:', s.driveUrl, '|', g.join(' ; '));
console.log('visible primary:', await sp.isVisible('#btnGenerate') ? 'Write notes' : 'Open in Claude', '| footer:', (await sp.locator('#doneActions .btn:not(.hidden)').allTextContents()).join(' | '));
console.log('ERRORS', JSON.stringify(errors));
await ctx.close();
