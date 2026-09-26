// AudioWorklet hop collector (docs/research.md §2.2). Runs on the audio
// thread: downmixes whatever reaches its input to mono and posts it to the
// main thread in hops of 512 samples, each stamped with the context frame
// of its first sample. The main thread hands each buffer back once it has
// analysed it, so the steady state allocates nothing. It never outputs
// sound: its output is silence, wired to a muted gain only so the graph
// keeps pulling it.
//
// Loaded with audioWorklet.addModule(); registers 'hypersurf-hops'.

const HOP = 512;

class HopCollector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.hop = o.hop || HOP;
    this.spare = [];
    this.buf = new Float32Array(this.hop);
    this.fill = 0;
    this.start = 0;
    this.port.onmessage = (e) => {
      // A buffer coming home after analysis.
      if (e.data instanceof Float32Array && e.data.length === this.hop) this.spare.push(e.data);
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true; // nothing connected yet, or the stream ended
    const channels = input.length, n = input[0].length, scale = 1 / channels;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.start = currentFrame + i;
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.buf[this.fill++] = v * scale;
      if (this.fill === this.hop) {
        this.port.postMessage({ frame: this.start, samples: this.buf }, [this.buf.buffer]);
        this.buf = this.spare.pop() || new Float32Array(this.hop);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('hypersurf-hops', HopCollector);
