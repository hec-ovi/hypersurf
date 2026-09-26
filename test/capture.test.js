import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureConstraints, captureSupport, audioOnly, captureTabAudio, CaptureError, CAPTURE_MESSAGES } from '../src/live/capture.js';

test('the share prompt asks for this tab with raw audio and never silences it', () => {
  const c = captureConstraints();
  assert.equal(c.preferCurrentTab, true);
  assert.equal(c.video, true);
  assert.deepEqual(c.audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false });
  assert.ok(!('restrictOwnAudio' in c) && !('restrictOwnAudio' in c.audio));
});

const nav = ({ api = true, tabAudio = true, mobile = false, share } = {}) => ({
  userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14) Mobile' : 'Mozilla/5.0 (X11; Linux x86_64)',
  mediaDevices: api ? { getDisplayMedia: share || (async () => fakeStream()), getSupportedConstraints: () => (tabAudio ? { suppressLocalAudioPlayback: true } : {}) } : undefined,
});

function fakeStream({ audio = 1 } = {}) {
  const track = (kind) => ({ kind, stopped: false, stop() { this.stopped = true; }, addEventListener(type, fn) { this.onended = fn; } });
  const tracks = [track('video'), ...Array.from({ length: audio }, () => track('audio'))];
  return {
    tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => tracks.slice(),
    removeTrack(t) { tracks.splice(tracks.indexOf(t), 1); },
  };
}

test('support: Chromium desktop yes; no API, mobile and picture-only engines no', () => {
  assert.deepEqual(captureSupport(nav()), { ok: true, reason: '' });
  assert.equal(captureSupport(nav({ api: false })).reason, 'no-api');
  assert.equal(captureSupport(nav({ api: false, mobile: true })).reason, 'mobile');
  assert.equal(captureSupport(nav({ tabAudio: false })).reason, 'no-tab-audio');
  for (const k of Object.keys(CAPTURE_MESSAGES)) assert.match(CAPTURE_MESSAGES[k], /\.$/);
});

test('only the audio is kept, and a share without audio is refused', () => {
  const s = fakeStream();
  const video = s.getVideoTracks()[0];
  audioOnly(s);
  assert.ok(video.stopped);
  assert.equal(s.getVideoTracks().length, 0);
  assert.equal(s.getAudioTracks().length, 1);
  const silent = fakeStream({ audio: 0 });
  assert.throws(() => audioOnly(silent), (e) => e instanceof CaptureError && e.reason === 'no-audio');
  assert.ok(silent.tracks.every((t) => t.stopped));
});

test('capture: cancelled, unsupported and working prompts', async () => {
  await assert.rejects(captureTabAudio({}, nav({ tabAudio: false })), (e) => e.reason === 'no-tab-audio');
  const denied = nav({ share: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } });
  await assert.rejects(captureTabAudio({}, denied), (e) => e.reason === 'denied' && e.userMessage === CAPTURE_MESSAGES.denied);
  let ended = 0;
  const stream = await captureTabAudio({ onEnded: () => ended++ }, nav());
  assert.equal(stream.getVideoTracks().length, 0);
  stream.getAudioTracks()[0].onended();
  assert.equal(ended, 1);
});

test('the worklet posts 512-sample mono hops stamped with their first frame, and reuses buffers', async () => {
  const posted = [];
  let Processor = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } };
  globalThis.registerProcessor = (name, cls) => { assert.equal(name, 'hypersurf-hops'); Processor = cls; };
  await import('../src/live/worklet.js');
  const p = new Processor({ processorOptions: { hop: 512 } });
  for (let q = 0; q < 10; q++) {
    globalThis.currentFrame = 1000 + q * 128;
    const L = new Float32Array(128).fill(q), R = new Float32Array(128).fill(q + 1);
    assert.equal(p.process([[L, R]]), true);
  }
  assert.equal(posted.length, 2);
  assert.equal(posted[0].frame, 1000);
  assert.equal(posted[1].frame, 1512);
  assert.equal(posted[0].samples.length, 512);
  assert.equal(posted[0].samples[0], 0.5);
  assert.equal(posted[1].samples[511], 7.5);
  // A returned buffer is taken for the hop after the one being filled.
  p.port.onmessage({ data: posted[0].samples });
  for (let q = 10; q < 16; q++) { globalThis.currentFrame = 1000 + q * 128; p.process([[new Float32Array(128)]]); }
  assert.equal(posted.length, 4);
  assert.equal(posted[3].samples, posted[0].samples, 'the same buffer came back round');
  // Nothing connected: nothing posted, still alive.
  assert.equal(p.process([[]]), true);
});
