// Splits a clip where the speaker changes, with pyannote segmentation 3.0
// (the same first stage pyannote's own diarization pipeline uses).
// Classes: 0 nobody, 1-3 one local speaker, 4-6 two people overlapping.
import { AutoProcessor, AutoModelForAudioFrameClassification } from '@huggingface/transformers';

export const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const SR = 16000;
let ready = null;

export function loadSegmenter(progress_callback) {
  if (!ready) {
    ready = Promise.all([
      AutoProcessor.from_pretrained(SEG_MODEL, { progress_callback }),
      AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { dtype: 'fp32', device: 'wasm', progress_callback })
    ]).then(([processor, model]) => ({ processor, model }));
    ready.catch(() => (ready = null));
  }
  return ready;
}

/**
 * Returns speaker turns inside the clip: [{ local, start, end }] in seconds, with very short
 * turns folded into their neighbours. `local` ids only mean something within this clip.
 */
export async function speakerTurns(audio) {
  const { processor, model } = await loadSegmenter();
  const { logits } = await model(await processor(audio));
  const [raw] = processor.post_process_speaker_diarization(logits, audio.length);
  // Keep single-speaker stretches; overlaps and silence just separate turns.
  let turns = raw.filter((s) => s.id >= 1 && s.id <= 3).map((s) => ({ local: s.id, start: s.start, end: s.end }));
  // Fold blips under 0.4 s into the previous turn, then merge neighbours with the same speaker.
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.local === t.local || t.end - t.start < 0.4)) prev.end = Math.max(prev.end, t.end);
    else merged.push({ ...t });
  }
  return merged;
}

export function slice(audio, start, end, pad = 0.1) {
  return audio.subarray(Math.max(0, Math.floor((start - pad) * SR)), Math.min(audio.length, Math.ceil((end + pad) * SR)));
}
