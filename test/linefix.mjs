import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist-test'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw14-' + Date.now(), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 380, height: 760 }, deviceScaleFactor: 2 });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const errors = []; ctx.on('weberror', (e) => { if ((e.page()?.url() || '').startsWith('chrome-extension')) errors.push(e.error().message); });
await new Promise((r) => setTimeout(r, 1200));
const sp = await ctx.newPage(); await sp.goto(`chrome-extension://${ID}/sidepanel.html`);
await sp.evaluate(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, v: 4, setupDone: true, myName: 'Alex', showVoiceScores: true } });
  await chrome.storage.session.set({ engine: { ready: true, device: 'webgpu', voices: 'on', micStatus: 'on' } });
  await chrome.storage.local.set({ session: { id: 'm1', title: 'Sync', attendees: 'Sam, Priya', startedAt: Date.now() - 60000, status: 'recording', templateId: 'general',
    segments: [ { t: 1000, dur: 3000, spk: 's1', score: 0, text: 'Hi all, welcome.' }, { t: 5000, dur: 3000, spk: 's1', score: 0.61, text: 'I have the budget numbers ready.' }, { t: 9000, dur: 2000, spk: 'me', text: 'Great, go ahead.' } ],
    speakers: { s1: { label: 'Speaker 1', name: 'Sam', sample: 'Hi all, welcome.' } } } });
});
await sp.waitForTimeout(400);
// tap the 2nd line (really Priya) while recording -> goes through the background
await sp.click('.seg[data-i="1"]'); await sp.waitForTimeout(200);
console.log('card:', await sp.textContent('#askTitle'), '|', await sp.textContent('#askQuote'), '| chips:', (await sp.locator('#askChips .chip').allTextContents()).join(','), '| alt:', await sp.textContent('#askAlt'));
await sp.screenshot({ path: 'test/.shots/linefix.png' });
await sp.click('#askChips [data-name="Priya"]'); await sp.waitForTimeout(500);
let s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
console.log('after fix:', s.segments.map((x) => x.spk + (x.fixed ? '*' : '')).join(','), '| speakers:', JSON.stringify(Object.fromEntries(Object.entries(s.speakers).map(([k, v]) => [k, v.name]))));
console.log('lines:', (await sp.locator('#liveTranscript .seg').allTextContents()).join(' || '));
// after the meeting: fix a line to a brand-new person typed in
await sp.evaluate(async () => { const { session } = await chrome.storage.local.get('session'); session.status = 'stopped'; session.endedAt = Date.now(); await chrome.storage.local.set({ session }); });
await sp.waitForTimeout(300); await sp.click('[data-tab="transcript"]');
await sp.click('#doneTranscript .seg[data-i="0"]'); await sp.waitForTimeout(200);
await sp.click('#askName'); await sp.keyboard.type('Jordan'); await sp.keyboard.press('Enter'); await sp.waitForTimeout(400);
s = await sp.evaluate(async () => (await chrome.storage.local.get('session')).session);
console.log('done fix:', s.segments.map((x) => x.spk).join(','), '| names:', Object.values(s.speakers).map((v) => v.name).join(','));
// voice model failure is shown
await sp.evaluate(async () => { const { session } = await chrome.storage.local.get('session'); session.status = 'recording'; await chrome.storage.local.set({ session }); await chrome.storage.session.set({ engine: { ready: true, device: 'wasm', voices: 'failed: Missing the following inputs: input_features' } }); });
await sp.waitForTimeout(300);
console.log('engine line:', await sp.textContent('#engineStatus'));
console.log('ERRORS', JSON.stringify(errors));
await ctx.close();
