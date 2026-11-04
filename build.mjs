import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '/ort', { recursive: true });

// static files
for (const f of readdirSync('src')) {
  if (/\.(html|css|json)$/.test(f) || ['recorder-worklet.js', 'sample.wav', 'open.js'].includes(f)) cpSync(`src/${f}`, `${out}/${f}`);
}
cpSync('src/icons', `${out}/icons`, { recursive: true });
cpSync('docs/USER_GUIDE.md', `${out}/README.md`); // the guide ships inside the extension zip
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'])
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `${out}/ort/${f}`);

const common = { bundle: true, format: 'esm', target: 'chrome116', minify: true, sourcemap: false, logLevel: 'warning' };
await build({ ...common, entryPoints: { background: 'src/background.js' }, outdir: out });
await build({
  ...common,
  entryPoints: { 'offscreen.bundle': 'src/offscreen.js', 'sidepanel.bundle': 'src/sidepanel.js', 'options.bundle': 'src/options.js', 'setup.bundle': 'src/setup.js', 'engine-worker.bundle': 'src/engine-worker.js' },
  outdir: out
});
// The extension version always follows package.json.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8'));
manifest.version = pkg.version;
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`built MeetNotes ${pkg.version}`);
