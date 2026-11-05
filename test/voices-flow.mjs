// Drives the real background + side panel with the messages the voice engine sends, the way
// a 4-person meeting (you + 3 in Sevv) with lots of short interjections would.
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist-test'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw20-' + Date.now(), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 380, height: 820 }, deviceScaleFactor: 2 });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const errors = []; ctx.on('weberror', (e) => { if ((e.page()?.url() || '').startsWith('chrome-extension')) errors.push(e.error().message); });
await new Promise((r) => setTimeout(r, 1200));
const sp = await ctx.newPage(); await sp.goto(`chrome-extension://${ID}/sidepanel.html`);
const bg = (msg) => sp.evaluate((m) => chrome.runtime.sendMessage({ target: 'bg', ...m }), msg);
const session = () => sp.evaluate(async () => (await chrome.storage.local.get('session')).session);

// Ready card: typing 3 names suggests 4 people (them + you)
await sp.evaluate(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, v: 4, setupDone: true, myName: 'Alex', recentNames: ['Jill', 'Eline', 'Ksenia'] } });
  await chrome.storage.session.set({ armed: { tabId: 1, title: 'Product sync | Sevv', url: 'https://x.sevv.io', at: 1 }, engine: { ready: true, device: 'webgpu', voices: 'on', micStatus: 'on' } });
});
await sp.waitForTimeout(300);
for (const n of ['Jill', 'Eline', 'Ksenia']) await sp.click(`[data-add="${n}"]`);
console.log('people suggested:', await sp.textContent('#cntVal'));
await sp.screenshot({ path: 'test/.shots/v23-ready.png' });

// Recording: the engine reports lines; short voices appear but are NOT asked about
await sp.evaluate(async () => {
  await chrome.storage.session.remove('armed');
  await chrome.storage.local.set({ session: { id: 'm', title: 'Product sync', attendees: 'Jill, Eline, Ksenia', peopleCount: 4, startedAt: Date.now() - 400000, status: 'recording', templateId: 'general', segments: [], speakers: {} } });
});
const lines = [['s1', 'As you said, what about the stats? We aligned this week.'], ['s2', "You don't have a good feeling about it."], ['s3', "I don't have a good feeling, I'm just like, why is it so slow"], ['s4', 'This is good.'], ['s5', 'Yeah, good to have.'], ['me', 'Can we drop some of it?']];
let t = 0;
for (const [spk, text] of lines) await bg({ type: 'segment', segment: { t: (t += 4000), dur: 3000, spk, text } });
await sp.waitForTimeout(300);
console.log('ask card before the engine is sure:', await sp.isVisible('#askCard'));
await bg({ type: 'voice-ready', id: 's1', sample: lines[0][1] });
await sp.waitForTimeout(300);
console.log('ask card:', await sp.textContent('#askTitle'), '|', await sp.textContent('#askQuote'));
await sp.click('#askChips [data-name="Jill"]'); await sp.waitForTimeout(300);
// the engine works out s4 and s5 were really Eline (s2) and Jill (s1)
await bg({ type: 'relabel', merges: [{ from: 's4', into: 's2' }, { from: 's5', into: 's1' }] });
await sp.waitForTimeout(300);
let s = await session();
console.log('after live merge:', s.segments.map((x) => x.spk).join(','), '| labels:', Object.entries(s.speakers).map(([k, v]) => `${k}=${v.name || v.label}`).join(' '));
await sp.screenshot({ path: 'test/.shots/v23-recording.png' });
// change the count while recording
await sp.click('#recMinus'); await sp.waitForTimeout(300);
console.log('count after minus:', (await session()).peopleCount, '|', await sp.textContent('#recCountVal'));
// end of meeting re-sort moves a line; a hand-fixed line stays
await bg({ type: 'line-speaker', t: 12000, text: lines[2][1], name: 'Ksenia' }); await sp.waitForTimeout(300);
s = await session();
const ks = s.segments.find((x) => x.t === 12000).spk;
await bg({ type: 'relabel', merges: [], map: { 4000: 's1', 8000: 's2', 12000: 's1', 16000: 's2', 20000: 's2' } });
await sp.waitForTimeout(300);
s = await session();
console.log('final map:', s.segments.map((x) => `${x.t / 1000}s=${x.spk}${x.fixed ? '*' : ''}`).join(' '), '| fixed line kept:', s.segments.find((x) => x.t === 12000).spk === ks);
console.log('voices in transcript:', [...new Set(s.segments.map((x) => (x.spk === 'me' ? 'me' : s.speakers[x.spk]?.name || s.speakers[x.spk]?.label)))].join(', '));
console.log('ERRORS', JSON.stringify(errors));
await ctx.close();
