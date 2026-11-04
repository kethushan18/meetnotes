import { build } from 'esbuild';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
rmSync('dist-test', { recursive: true, force: true });
cpSync('dist', 'dist-test', { recursive: true });
cpSync('test/add.onnx', 'dist-test/add.onnx');
await build({ bundle: true, format: 'esm', target: 'chrome116', entryPoints: { 'test-ort': 'test/test-ort.js', 'test-audio': 'test/test-audio.js' }, outdir: 'dist-test', logLevel: 'warning' });
for (const n of ['test-ort', 'test-audio']) writeFileSync(`dist-test/${n}.html`, `<!doctype html><meta charset="utf-8"><script type="module" src="${n}.js"></script>`);
console.log('test build ok');
