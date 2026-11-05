// Real keystrokes (not fill) into every text field, to catch handlers that swallow keys.
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw12-' + Date.now(), { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 2000));
const results = [];
async function typeCheck(page, sel, text = 'Abc def') {
  await page.click(sel); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 10 });
  const v = await page.inputValue(sel); results.push(`${sel}: ${v === text ? 'OK' : 'FAIL (' + JSON.stringify(v) + ')'}`);
}
const setup = ctx.pages().find((p) => p.url().includes('setup.html'));
await typeCheck(setup, '#myName', 'Alex');
await setup.keyboard.press('Enter'); await setup.waitForTimeout(300);
results.push('Enter moves to next step: ' + (await setup.evaluate(() => document.querySelector('.step.active')?.dataset.step)));
await sw.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, setupDone: true } }); await chrome.storage.session.set({ armed: { tabId: 1, title: 'Room | Sevv', url: 'https://x.sevv.io', at: 1 } }); });
const sp = await ctx.newPage(); await sp.goto(`chrome-extension://${ID}/sidepanel.html`); await sp.waitForTimeout(500);
await typeCheck(sp, '#inTitle', 'Weekly sync'); await typeCheck(sp, '#inAttendees', 'Sam, Priya');
await sp.evaluate(async () => { await chrome.storage.session.remove('armed'); await chrome.storage.local.set({ session: { id: 'm', title: 'T', startedAt: Date.now(), status: 'recording', segments: [{ t: 1, spk: 's1', text: 'hi there team' }], speakers: { s1: { label: 'Speaker 1', name: '', ask: true, sample: 'hi there team', askedAt: 1 } } } }); });
await sp.waitForTimeout(500);
await typeCheck(sp, '#askName', 'Jordan');
await sp.keyboard.press('Enter'); await sp.waitForTimeout(500);
results.push('Enter saves voice name: ' + (await sp.evaluate(async () => (await chrome.storage.local.get('session')).session.speakers.s1.name)));
await sp.evaluate(async () => { const { session } = await chrome.storage.local.get('session'); session.status = 'stopped'; await chrome.storage.local.set({ session }); });
await sp.waitForTimeout(400); await sp.click('#btnShowPaste');
await sp.click('#pasteArea'); await sp.keyboard.type('typing works', { delay: 5 });
results.push('#pasteArea: ' + ((await sp.inputValue('#pasteArea')) === 'typing works' ? 'OK' : 'FAIL'));
const opt = await ctx.newPage(); await opt.goto(`chrome-extension://${ID}/options.html`); await opt.waitForTimeout(400);
await typeCheck(opt, '#myName', 'Alex S');
await opt.click('summary >> text=Advanced');
for (const sel of ['#apiKey', '#out_slackWebhook', '#gdocClientId', '#driveFolderId', '#maxChunkSec', '#systemPrompt']) await typeCheck(opt, sel, sel === '#maxChunkSec' ? '12' : 'Abc def');
await opt.click('summary >> text=Notes styles'); await typeCheck(opt, '.tplName >> nth=0', 'General');
console.log(results.join('\n'));
await ctx.close();
