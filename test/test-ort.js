import '../src/lib/transcriber.js'; // applies the same ORT env config as production
import * as ort from 'onnxruntime-web/webgpu';
window.runTest = async () => {
  const buf = await (await fetch(chrome.runtime.getURL('add.onnx'))).arrayBuffer();
  const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
  const out = await s.run({ x: new ort.Tensor('float32', new Float32Array([1, 2, 3]), [3]) });
  return { y: Array.from(out.y.data), isolated: self.crossOriginIsolated, threads: ort.env.wasm.numThreads, gpu: !!navigator.gpu };
};
