// Main-thread client for the analysis worker: promise-based requests with
// progress callbacks. Channel data is transferred, never copied.

let nextId = 1;

export class Analyzer {
  /** @param {Worker} [worker] defaults to a module worker running worker.js */
  constructor(worker) {
    this.worker = worker || new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.worker.onmessage = (e) => this._receive(e.data);
    this.worker.onerror = (e) => this._failAll(new Error(e.message || 'analysis worker failed'));
  }

  /** Analyse decoded channels. Resolves with { songMap, timings }. */
  analyze(channels, sampleRate, { mode = 'mono', seed, onProgress } = {}) {
    return this._request({ type: 'analyze', channels, sampleRate, mode, seed }, channels.map((c) => c.buffer), onProgress);
  }

  /** Synthesise and analyse the demo. Resolves with { songMap, channels, sampleRate, truth, timings }. */
  demo({ sampleRate = 44100, mode = 'mono', onProgress } = {}) {
    return this._request({ type: 'demo', sampleRate, mode }, [], onProgress);
  }

  /** Rebuild the last analysed song for another mode or seed. */
  build({ mode = 'mono', seed }) {
    return this._request({ type: 'build', mode, seed }, []);
  }

  terminate() {
    this.worker.terminate();
    this._failAll(new Error('analyzer terminated'));
  }

  _request(msg, transfer, onProgress) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  _receive(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      if (p.onProgress) p.onProgress(msg.fraction, msg.stage);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else {
      const { type, id, ...result } = msg;
      p.resolve(result);
    }
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
