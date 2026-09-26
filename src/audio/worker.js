// Analysis worker. The main thread decodes audio (AudioContext is window-only)
// and transfers the channel data here; everything else runs off the main
// thread. The message handler is exported so Node tests can drive it directly.
//
// Requests                                         Replies (same id)
//   { type: 'analyze', id, channels, sampleRate,     { type: 'progress', id, fraction, stage }
//     mode, seed, level? }                           { type: 'result', id, songMap, timings }
//   { type: 'demo', id, sampleRate, mode }           { type: 'result', id, songMap, timings,
//                                                        channels, truth }
//   { type: 'build', id, mode, seed, level? }        { type: 'result', id, songMap }
//                                                    { type: 'error', id, message }

import { analyzeAudio, transferables } from './analyze.js';
import { buildSongMap } from './songmap.js';
import { generateDemoSong, DEMO_SEED } from './demo.js';

/** Returns handle(message, post) where post(reply, transferList) sends a reply. */
export function createAnalysisHandler() {
  let features = null; // the last analysis, kept so another mode builds without re-analysing

  function analyze(id, channels, sampleRate, post) {
    let last = -1, lastStage = '';
    features = analyzeAudio(channels, sampleRate, {
      onProgress(fraction, stage) {
        if (fraction - last < 0.01 && stage === lastStage && fraction < 1) return;
        last = fraction;
        lastStage = stage;
        post({ type: 'progress', id, fraction, stage });
      },
    });
    return features;
  }

  function sendMap(id, map, extra = {}, post) {
    const reply = { type: 'result', id, songMap: map, ...extra };
    post(reply, transferables([map, extra.channels]));
  }

  return function handle(msg, post) {
    const { type, id } = msg || {};
    try {
      if (type === 'analyze') {
        const f = analyze(id, msg.channels, msg.sampleRate, post);
        sendMap(id, buildSongMap(f, { mode: msg.mode, seed: msg.seed, level: msg.level || null }), { timings: f.timings }, post);
      } else if (type === 'demo') {
        post({ type: 'progress', id, fraction: 0, stage: 'synth' });
        const demo = generateDemoSong({ seed: DEMO_SEED, sampleRate: msg.sampleRate || 44100 });
        // Analyse copies: the originals are transferred back for playback.
        const f = analyze(id, demo.channels.map((c) => c.slice()), demo.sampleRate, post);
        const truth = { bpm: demo.truth.bpm, sections: demo.truth.sections, drops: demo.truth.drops };
        sendMap(id, buildSongMap(f, { mode: msg.mode, seed: 'demo' }), { timings: f.timings, channels: demo.channels, truth, sampleRate: demo.sampleRate }, post);
      } else if (type === 'build') {
        if (!features) throw new Error('nothing analysed yet');
        sendMap(id, buildSongMap(features, { mode: msg.mode, seed: msg.seed, level: msg.level || null }), {}, post);
      } else {
        throw new Error(`unknown request ${type}`);
      }
    } catch (err) {
      post({ type: 'error', id, message: err && err.message ? err.message : String(err) });
    }
  };
}

// Wire up only inside a dedicated worker.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handle = createAnalysisHandler();
  self.onmessage = (e) => handle(e.data, (reply, transfer) => self.postMessage(reply, transfer || []));
}
