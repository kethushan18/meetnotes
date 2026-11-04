# Third-party notices

## Bundled in the extension

| Component | License |
|---|---|
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) (transformers.js) | Apache-2.0 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) (WASM runtime in `ort/`) | MIT |
| [marked](https://github.com/markedjs/marked) | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Apache-2.0 or MPL-2.0 |

## Models (downloaded at runtime from Hugging Face, not stored in this repo)

| Model | Used for | License (per the model card; check before redistributing) |
|---|---|---|
| `onnx-community/moonshine-base-ONNX` (Useful Sensors Moonshine) | Speech to text | MIT |
| `onnx-community/whisper-base.en` (OpenAI Whisper) | Speech to text, fallback | MIT |
| `onnx-community/silero-vad` | Voice activity detection | MIT |
| `onnx-community/pyannote-segmentation-3.0` | Speaker-change detection | MIT |
| `onnx-community/wespeaker-voxceleb-resnet34-LM` (WeSpeaker) | Voice fingerprints | CC BY 4.0 |

## Design references (no code copied)

- Meetily (MIT)
- Meeper (MPL-2.0)
- transformers.js-examples (Apache-2.0)
