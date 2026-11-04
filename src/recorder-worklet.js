// AudioWorklet: downmixes to mono and posts ~256 ms blocks to the main thread.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 4096;
    this.buf = new Float32Array(this.blockSize);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.buf[this.pos++] = v / channels;
      if (this.pos === this.blockSize) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(this.blockSize);
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
