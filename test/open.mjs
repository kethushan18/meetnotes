import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const ext = path.resolve('dist'); const ID = 'molngpmollhmnghpbbojepobopjippdk';
const ctx = await chromium.launchPersistentContext((process.env.TMPDIR || '/tmp') + '/meetnotes-pw13-' + Date.now(), { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1500));
const other = await ctx.newPage(); await other.goto('about:blank');
const p = await ctx.newPage(); let closed = false; p.on('close', () => (closed = true));
await p.goto(`chrome-extension://${ID}/open.html?u=` + encodeURIComponent('claude://claude.ai/new?q=hello'));
await p.evaluate(() => window.dispatchEvent(new Event('blur'))); // the "Open Claude?" prompt takes focus
await new Promise((r) => setTimeout(r, 3000));
console.log('still open while the prompt is up:', !closed);
await p.evaluate(() => window.dispatchEvent(new Event('focus'))); // prompt answered, focus back
await new Promise((r) => setTimeout(r, 2500));
console.log('closes after the prompt is answered:', closed);
await ctx.close();
