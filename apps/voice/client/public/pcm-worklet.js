class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.offset = 0;
    this.targetRate = 16000;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending);
    merged.set(input, this.pending.length);

    const ratio = sampleRate / this.targetRate;
    const samples = [];
    while (this.offset + ratio <= merged.length) {
      const start = Math.floor(this.offset);
      const end = Math.max(start + 1, Math.floor(this.offset + ratio));
      let sum = 0;
      for (let index = start; index < end; index += 1) {
        sum += merged[index] || 0;
      }
      samples.push(sum / (end - start));
      this.offset += ratio;
    }

    const consumed = Math.floor(this.offset);
    this.offset -= consumed;
    this.pending = merged.slice(consumed);

    if (samples.length) {
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index] || 0));
        pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
