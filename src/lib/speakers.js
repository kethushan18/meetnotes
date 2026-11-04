// Voice embeddings with the WeSpeaker ResNet34 model.
import { AutoFeatureExtractor, AutoModel } from '@huggingface/transformers';
import { progressTracker } from './progress.js';
import { normalise } from './voices.js';

export class SpeakerEmbedder {
  constructor({ model, onProgress }) {
    this.modelId = model;
    this.onProgress = onProgress || (() => {});
    this.ready = null;
  }

  load() {
    if (!this.ready) {
      this.ready = (async () => {
        const progress_callback = progressTracker(this.onProgress);
        const [extractor, model] = await Promise.all([
          AutoFeatureExtractor.from_pretrained(this.modelId, { progress_callback }),
          AutoModel.from_pretrained(this.modelId, { dtype: 'fp32', device: 'wasm', progress_callback })
        ]);
        return { extractor, model };
      })();
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  /** Returns an L2-normalised voice embedding for speech-only audio (ideally 1.5 s or more). */
  async embed(audio) {
    const { extractor, model } = await this.load();
    const { input_features } = await extractor(audio);
    const out = await model({ input_features });
    // Read the output by name rather than assuming its position.
    const names = model.sessions?.model?.outputNames || Object.keys(out);
    if (!this.logged) {
      console.debug('WeSpeaker io', model.sessions?.model?.inputNames, names);
      this.logged = true;
    }
    const key = ['embeddings', 'embedding', 'embs'].find((k) => out[k]) || names[0];
    const t = out[key];
    // A [1, frames, dim] output would be per-frame: average it into one vector.
    if (t.dims.length === 3) {
      const [, frames, dim] = t.dims;
      const v = new Float32Array(dim);
      for (let f = 0; f < frames; f++) for (let d = 0; d < dim; d++) v[d] += t.data[f * dim + d] / frames;
      return normalise(v);
    }
    return normalise(Float32Array.from(t.data));
  }
}
