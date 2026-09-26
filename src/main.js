// hypersurf app: menu → analyse (with progress) → swoop-in → play →
// results → instant restart. Files and the demo play through an
// AudioBufferSourceNode; game logic runs at a fixed 240 Hz step on the
// heard song time, and the view renders whatever time the clock reads.

import { GameView } from './game/view.js';
import { RulesEngine, RULES, EVENT } from './game/rules.js';
import { InputController, ShipMotion } from './game/input.js';
import { Juice } from './game/effects.js';
import { Hud, showResults } from './game/hud.js';
import { BestScores, sha256Hex, safeLocalStorage } from './game/scores.js';
import { createAutopilot } from './game/autopilot.js';
import { makeSample } from './game/trackpath.js';
import { Analyzer } from './audio/analyzer.js';
import { SongPlayer, copyChannels, toAudioBuffer } from './audio/player.js';
import { LEAD_IN, TAIL } from './audio/songmap.js';
import { parseVideoId } from './live/youtube.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug') && params.get('debug') !== '0';
/** Debug only: start runs this many seconds into the song (visual checks). */
const FROM = DEBUG ? Math.max(0, Number(params.get('from')) || 0) : 0;
const STEP = 1 / 240;
const MAX_STEPS = 240 * 2; // longest catch-up before skipping ahead
const SWOOP = 2; // seconds of the lead-in spent flying in
const MAX_SECONDS = 15 * 60;
const MIN_SECONDS = 5;
const MODE_LABEL = { mono: 'Mono', ninja: 'Ninja', casual: 'Casual' };
const SETTINGS_KEY = 'hypersurf.settings';

const $ = (id) => document.getElementById(id);
const storage = safeLocalStorage();

const app = {
  state: 'boot',
  view: null,
  viewReady: null,
  analyzer: null,
  ctx: null,
  player: null,
  input: new InputController($('view')),
  ship: new ShipMotion(),
  juice: new Juice(),
  hud: new Hud($('hud')),
  best: new BestScores(storage),
  settings: loadSettings(),
  song: null, // { key, title, source, buffer, maps: { mode: SongMap }, timings }
  analyzedKey: null, // the song the worker holds features for
  map: null,
  mode: 'mono',
  rules: null,
  simT: 0,
  runStart: -LEAD_IN,
  viewT: 0,
  nextBeat: 0,
  lastFrame: 0,
  autopilot: null,
  busy: false,
  hitSample: makeSample(),
  frozen: null, // debug: song time the view is held at
};

/** Stats for automated checks and the ?debug=1 overlay. Mutated in place. */
const stats = {
  state: 'boot',
  backend: 'none',
  quality: '',
  pixelRatio: 0,
  fps: 0,
  frameMs: 0,
  cpuMs: 0,
  drawCalls: 0,
  triangles: 0,
  chunks: 0,
  chunkBuilds: 0,
  blocksVisible: 0,
  rebases: 0,
  songTime: 0,
  duration: 0,
  mode: '',
  song: null,
  songMap: null,
  analysis: null,
  score: 0,
  hits: 0,
  misses: 0,
  steps: 0,
  runs: 0,
  lastResults: null,
  flashes: { allowed: 0, denied: 0 },
  live: { available: false, tempo: null, confidence: null },
  audio: { state: 'none', contextTime: 0, sampleRate: 0, outputLatency: 0 },
  errors: [],
};
window.__hypersurf = {
  stats,
  /** Debug only: steer with the built-in bot. */
  get autopilot() { return !!app.autopilot; },
  set autopilot(on) {
    if (!DEBUG) return;
    app.autopilotOn = !!on;
    app.autopilot = on && app.map ? createAutopilot(app.map.blocks) : null;
  },
  /** Debug only: the app itself, for console experiments. */
  get app() { return DEBUG ? app : null; },
  /** Debug only: hold the view at song time t (settled), for screenshots. freeze(null) lets go. */
  freeze(t, opts) { return DEBUG ? freezeAt(t, opts) : false; },
  /** Debug only: render frames back to back with a GPU sync after each; returns timings. */
  bench(opts) { return DEBUG ? bench(opts) : null; },
};

// --- settings -------------------------------------------------------------------

function loadSettings() {
  const defaults = { latency: 0, calm: false, quality: 'high', mode: 'mono' };
  try {
    const raw = storage && storage.getItem(SETTINGS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return {
      latency: Number.isFinite(v.latency) ? Math.max(-150, Math.min(300, v.latency)) : defaults.latency,
      calm: typeof v.calm === 'boolean' ? v.calm : defaults.calm,
      quality: ['high', 'medium', 'low'].includes(v.quality) ? v.quality : defaults.quality,
      mode: RULES[v.mode] ? v.mode : defaults.mode,
    };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    if (storage) storage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
  } catch { /* storage blocked: settings last for this visit */ }
}

// --- states ---------------------------------------------------------------------

const SCREENS = { menu: 'menu', analyze: 'loading', paused: 'pause', results: 'results' };

function setState(state) {
  app.state = state;
  stats.state = state;
  document.body.dataset.state = state;
  for (const [s, id] of Object.entries(SCREENS)) $(id).hidden = s !== state;
  $('hud').hidden = !(state === 'play' || state === 'paused');
  app.input.enabled = state === 'play';
  if (state !== 'play') app.input.releaseLock();
}

function message(text) {
  $('menu-msg').textContent = text || '';
}

function loading(title, fraction, stage) {
  if (title != null) document.querySelector('[data-load=title]').textContent = title;
  if (fraction != null) document.querySelector('[data-load=bar]').style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  if (stage != null) document.querySelector('[data-load=stage]').textContent = stage;
}

const STAGE_LABEL = {
  synth: 'Synthesising the demo…',
  resample: 'Resampling…',
  spectrum: 'Listening for onsets…',
  onsets: 'Picking onsets…',
  tempo: 'Tracking the beat…',
  loudness: 'Measuring intensity…',
};

function onProgress(fraction, stage) {
  loading(null, fraction, STAGE_LABEL[stage] || 'Analysing…');
}

function currentMode() {
  const checked = document.querySelector('input[name=mode]:checked');
  return checked && RULES[checked.value] ? checked.value : 'mono';
}

// --- audio ------------------------------------------------------------------------

/** Create or wake the AudioContext. Must run inside a user gesture the first time. */
function ensureAudio() {
  if (!app.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser has no Web Audio support.');
    app.ctx = new Ctx({ latencyHint: 'interactive' });
    app.player = new SongPlayer(app.ctx);
    app.player.offset = app.settings.latency / 1000;
  }
  if (app.ctx.state === 'suspended') app.ctx.resume().catch(() => {});
}

function analyzer() {
  if (!app.analyzer) app.analyzer = new Analyzer();
  return app.analyzer;
}

// --- sources ----------------------------------------------------------------------

async function run(task) {
  if (app.busy) return;
  app.busy = true;
  message('');
  try {
    await task();
  } catch (err) {
    console.warn(err);
    stats.errors.push(String(err && err.message ? err.message : err));
    setState('menu');
    message(err && err.userMessage ? err.userMessage : `Something went wrong: ${err && err.message ? err.message : err}`);
  } finally {
    app.busy = false;
  }
}

function userError(text) {
  const e = new Error(text);
  e.userMessage = text;
  return e;
}

function playDemo() {
  return run(async () => {
    ensureAudio();
    await ready();
    const mode = currentMode();
    if (!(app.song && app.song.key === 'demo')) {
      setState('analyze');
      loading('Demo song', 0, STAGE_LABEL.synth);
      const r = await analyzer().demo({ sampleRate: app.ctx.sampleRate, mode, onProgress });
      app.analyzedKey = 'demo';
      app.song = {
        key: 'demo', title: 'hypersurf demo · 128 BPM', source: 'demo',
        buffer: toAudioBuffer(app.ctx, r.channels, r.sampleRate), maps: { [mode]: r.songMap }, timings: r.timings,
      };
    }
    await startSong(mode);
  });
}

function playFile(file) {
  return run(async () => {
    if (!file) return;
    ensureAudio();
    await ready();
    const mode = currentMode();
    const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled';
    setState('analyze');
    loading(title, 0, 'Reading the file…');
    const bytes = await file.arrayBuffer();
    const key = await sha256Hex(bytes);
    if (!(app.song && app.song.key === key)) {
      loading(null, 0, 'Decoding…');
      let buffer;
      try {
        buffer = await app.ctx.decodeAudioData(bytes);
      } catch {
        throw userError(`Could not decode “${file.name}”. Try an MP3, WAV, OGG, FLAC or M4A file.`);
      }
      if (buffer.duration > MAX_SECONDS) throw userError('That song is longer than 15 minutes. Please pick a shorter one.');
      if (buffer.duration < MIN_SECONDS) throw userError('That file is too short to ride.');
      const r = await analyzer().analyze(copyChannels(buffer), buffer.sampleRate, { mode, seed: key, onProgress });
      app.analyzedKey = key;
      app.song = { key, title, source: 'file', buffer, maps: { [mode]: r.songMap }, timings: r.timings };
    }
    await startSong(mode);
  });
}

function playYouTube(input) {
  const id = parseVideoId(input);
  if (!id) {
    message('That does not look like a YouTube link or video ID.');
    return;
  }
  message('Playing along with YouTube videos is not available yet. Play an audio file or the demo for now.');
}

/** Build (or reuse) the SongMap for `mode` and start a run. */
async function startSong(mode) {
  const song = app.song;
  let map = song.maps[mode];
  if (!map) {
    setState('analyze');
    loading(song.title, 1, `Building the ${MODE_LABEL[mode]} track…`);
    if (app.analyzedKey !== song.key) {
      // The worker holds another song's features: analyse this one again.
      const r = song.source === 'demo'
        ? await analyzer().demo({ sampleRate: app.ctx.sampleRate, mode, onProgress })
        : await analyzer().analyze(copyChannels(song.buffer), song.buffer.sampleRate, { mode, seed: song.key, onProgress });
      map = r.songMap;
      app.analyzedKey = song.key;
    } else {
      map = (await analyzer().build({ mode, seed: song.source === 'demo' ? 'demo' : song.key })).songMap;
    }
    song.maps[mode] = map;
  }
  app.map = map;
  app.mode = mode;
  const view = app.view;
  if (view.map !== map) {
    view.load(map);
    app.hud.load(map, view.path, song.title);
  }
  stats.song = { key: song.key.slice(0, 16), title: song.title, source: song.source, duration: map.duration };
  stats.songMap = { hash: map.hash, mode: map.mode, blocks: map.blocks.count, bpm: Math.round(map.bpm * 100) / 100, powerBlocks: map.powerBlocks.length, stats: map.stats };
  stats.analysis = song.timings || null;
  stats.duration = map.duration;
  stats.mode = mode;
  await beginRun();
}

/** (Re)start the current map from the top of the lead-in. Instant: nothing is re-analysed. */
async function beginRun() {
  const { view, map, mode } = app;
  app.player.stop();
  app.frozen = null;
  app.rules = new RulesEngine(map.blocks, mode);
  app.ship.reset(0);
  app.juice.reset();
  app.juice.calm = app.settings.calm;
  app.input.reset();
  app.input.setShoulders(RULES[mode].shoulders);
  app.hud.reset(mode);
  app.autopilot = app.autopilotOn ? createAutopilot(map.blocks) : null;
  const start = Math.min(FROM, Math.max(0, map.duration - 5)) - LEAD_IN;
  view.reset(start);
  if (!view.compiled) {
    setState('analyze');
    loading(null, 1, 'Preparing the track…');
    await view.compile(app.rules.state);
  }
  app.rules.skipTo(start);
  app.runStart = start;
  app.simT = start;
  app.viewT = start;
  app.nextBeat = 0;
  while (app.nextBeat < map.beats.length && map.beats[app.nextBeat] < start) app.nextBeat++;
  stats.hits = 0;
  stats.misses = 0;
  stats.runs++;
  ensureAudio();
  app.player.play(app.song.buffer, LEAD_IN, start + LEAD_IN);
  app.lastFrame = performance.now();
  view.gfx.resetTiming(app.lastFrame);
  setState('play');
  app.input.requestLock();
}

function finishRun() {
  const results = app.rules.results();
  const best = app.best.submit(app.song.key, app.mode, results, app.map.hash);
  stats.lastResults = results;
  showResults($('results'), { results, best, title: app.song.title, modeLabel: MODE_LABEL[app.mode] });
  setState('results');
  $('restart-btn').focus({ preventScroll: true });
}

function pause() {
  if (app.state !== 'play') return;
  app.player.pause().catch(() => {});
  setState('paused');
  $('resume-btn').focus({ preventScroll: true });
}

function resume() {
  if (app.state !== 'paused') return;
  app.player.resume().catch(() => {});
  app.lastFrame = performance.now();
  app.view.gfx.resetTiming(app.lastFrame);
  setState('play');
  app.input.requestLock();
}

function restart() {
  if (!app.map || app.busy) return;
  if (app.state === 'paused') app.player.resume().catch(() => {});
  run(beginRun);
}

function toMenu() {
  if (app.player) {
    app.player.stop();
    app.player.resume().catch(() => {});
  }
  setState('menu');
}

// --- frame loop -------------------------------------------------------------------

function frame() {
  const t0 = performance.now();
  const dt = Math.min(0.1, Math.max(0, (t0 - app.lastFrame) / 1000));
  const frameMs = t0 - app.lastFrame;
  app.lastFrame = t0;
  const view = app.view;
  const live = app.state === 'play' || app.state === 'paused' || app.state === 'results';
  if (!live || !view || !view.map) return;

  const frozen = app.frozen !== null;
  if (app.state === 'play' && !frozen) tick(dt);
  const swoop = Math.min(1, (app.viewT - app.runStart) / SWOOP);
  view.frame(app.viewT, app.state === 'play' && !frozen ? dt : 0, frozen ? app.viewT : t0 / 1000, app.ship.x, app.ship.v, app.rules.state, app.juice, swoop);
  view.render();
  if (app.state === 'play' && !frozen) {
    view.gfx.adapt(frameMs, t0);
    if (view.gfx.governor.lowerRequested) lowerQuality();
  }

  const info = view.gfx.info;
  stats.drawCalls = info.drawCalls;
  stats.triangles = info.triangles;
  stats.frameMs += (frameMs - stats.frameMs) * 0.1;
  stats.fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
  stats.cpuMs += (performance.now() - t0 - stats.cpuMs) * 0.1;
  stats.chunks = view.track.active;
  stats.chunkBuilds = view.track.builds;
  stats.blocksVisible = view.blocks.visible;
  stats.rebases = view.rebases;
  stats.pixelRatio = view.gfx.pixelRatio();
  stats.songTime = app.viewT;
  stats.score = app.rules.score;
  if (app.ctx) {
    stats.audio.state = app.ctx.state;
    stats.audio.contextTime = app.ctx.currentTime;
    stats.audio.sampleRate = app.ctx.sampleRate;
    stats.audio.outputLatency = app.ctx.outputLatency || 0;
  }
  stats.flashes.allowed = app.juice.limiter.allowed;
  stats.flashes.denied = app.juice.limiter.denied;
  if (DEBUG) debugOverlay(t0);
}

/** Dynamic resolution bottomed out and frames are still slow: drop to the low tier once. */
function lowerQuality() {
  const gfx = app.view.gfx;
  app.view.setQuality('low');
  gfx.governor.acknowledgeLower(gfx.quality.minScale);
  gfx.resetTiming(performance.now());
  stats.quality = gfx.qualityName;
  stats.autoLowered = true;
}

/** Advance the game to the heard song time in fixed steps. */
function tick(dt) {
  const { rules, ship, map, input, juice } = app;
  const t = app.player.time();
  const target = app.autopilot ? app.autopilot(t) : input.target();
  let steps = 0;
  while (app.simT + STEP <= t && steps < MAX_STEPS) {
    app.simT += STEP;
    ship.step(STEP, target);
    rules.step(app.simT, ship.x);
    steps++;
  }
  if (steps === MAX_STEPS) app.simT = t; // a long stall (tab switch): skip ahead
  stats.steps += steps;
  // Never draw past the track's tail (a late frame can land well after the end).
  app.viewT = Math.max(app.viewT, Math.min(t, map.duration + TAIL - 0.5));

  for (let k = 0; k < rules.eventCount; k++) onEvent(rules.events[k]);
  rules.clearEvents();
  const beats = map.beats;
  while (app.nextBeat < beats.length && beats[app.nextBeat] <= t) {
    juice.onBeat(app.nextBeat, t, app.view.intensity);
    app.nextBeat++;
  }
  juice.update(dt);
  app.hud.update(rules, t / map.duration, dt);
  if (t > map.duration + 0.75) finishRun();
}

function onEvent(ev) {
  const { juice, view } = app;
  const now = app.simT;
  switch (ev.type) {
    case EVENT.HIT:
      stats.hits++;
      juice.hit();
      juice.burst(0.25, now);
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.GREY:
    case EVENT.SPIKE:
      stats.hits++;
      juice.grey();
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.POWER:
      stats.hits++;
      juice.power();
      juice.burst(0.6, now);
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.COLLECT:
      if (ev.value > 0) juice.cashIn(now, ev.count);
      break;
    case EVENT.MISS:
      stats.misses++;
      break;
    default:
      break;
  }
  app.hud.event(ev);
}

// --- debug hooks ------------------------------------------------------------------

/**
 * Hold the view at song time t, for screenshots of exact moments: the song
 * pauses, the camera springs settle over `settle` seconds of 60 Hz frames
 * flown up to t with the autopilot steering, and later frames redraw that
 * moment. Juice can be forced for the shot: { beat, shock, lens, hit }.
 */
function freezeAt(t, { settle = 1.5, beat = 0, shock = 0, lens = 0, hit = 0, x = null } = {}) {
  const view = app.view;
  if (t === null) {
    app.frozen = null;
    if (app.state === 'play') app.player.resume().catch(() => {});
    app.lastFrame = performance.now();
    return true;
  }
  if (!view || !view.map || app.state !== 'play') return false;
  app.player.pause().catch(() => {});
  const pilot = createAutopilot(app.map.blocks);
  const n = Math.round(settle * 60);
  app.juice.reset();
  app.ship.reset(0);
  for (let i = 0; i <= n; i++) {
    const ti = t - (n - i) / 60;
    app.ship.step(1 / 60, x === null ? pilot(ti) : x);
    view.frame(ti, 1 / 60, ti, app.ship.x, app.ship.v, app.rules.state, app.juice, 1);
  }
  app.juice.beat = beat;
  app.juice.shock = shock;
  app.juice.shockTime = t - 0.25;
  app.juice.lens = lens;
  app.juice.debris = hit;
  app.juice.ship = hit;
  app.viewT = t;
  app.runStart = t - SWOOP;
  app.frozen = t;
  return true;
}

/**
 * Render `frames` frames from song time `from`, `dt` apart, synchronously,
 * forcing the GPU to finish each one (a 1-pixel readback on WebGL2, queue
 * completion on WebGPU). Measures real frame cost even in a background tab
 * where animation frames are throttled.
 */
async function bench({ from = app.viewT, frames = 300, dt = 1 / 60 } = {}) {
  const view = app.view;
  if (!view || !view.map) return null;
  const was = app.frozen;
  app.frozen = from; // keep the animation loop from interleaving
  const backend = view.gfx.renderer.backend;
  const gl = backend.gl || null, device = backend.device || null;
  const px = new Uint8Array(4);
  const total = new Float64Array(frames), cpu = new Float64Array(frames);
  const pilot = createAutopilot(app.map.blocks);
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  let draws = 0, tris = 0;
  for (let i = 0; i < frames; i++) {
    const t = from + i * dt;
    const a = performance.now();
    app.ship.step(dt, pilot(t));
    app.juice.update(dt);
    view.frame(t, dt, t, app.ship.x, app.ship.v, app.rules.state, app.juice, 1);
    view.render();
    const b = performance.now();
    if (gl) {
      const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    } else if (device) await device.queue.onSubmittedWorkDone();
    total[i] = performance.now() - a;
    cpu[i] = b - a;
    draws = Math.max(draws, view.gfx.info.drawCalls);
    tris = Math.max(tris, view.gfx.info.triangles);
  }
  const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  app.frozen = was;
  app.viewT = was === null ? app.viewT : was;
  const sorted = Float64Array.from(total).sort(), cs = Float64Array.from(cpu).sort();
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    backend: view.gfx.backend, quality: view.gfx.qualityName, pixelRatio: view.gfx.pixelRatio(),
    width: view.gfx.width, height: view.gfx.height, frames,
    frameMs: { mean: r2(mean(total)), p50: r2(sorted[frames >> 1]), p95: r2(sorted[Math.floor(frames * 0.95)]), max: r2(sorted[frames - 1]) },
    cpuMs: { mean: r2(mean(cpu)), p95: r2(cs[Math.floor(frames * 0.95)]) },
    drawCalls: draws, triangles: tris, heapDeltaKB: Math.round((heap1 - heap0) / 1024),
  };
}

// --- debug overlay ----------------------------------------------------------------

let debugNext = 0;
function debugOverlay(now) {
  if (now < debugNext) return;
  debugNext = now + 250;
  const el = $('debug');
  el.hidden = false;
  const a = stats.analysis;
  const timing = a ? Object.entries(a).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ') : '—';
  const total = a ? Math.round(Object.values(a).reduce((x, y) => x + y, 0)) : 0;
  const m = stats.songMap;
  el.textContent = [
    `${stats.backend} · ${stats.quality} · pixel ratio ${stats.pixelRatio.toFixed(2)}`,
    `fps ${stats.fps.toFixed(0)} · frame ${stats.frameMs.toFixed(1)} ms · cpu ${stats.cpuMs.toFixed(2)} ms`,
    `draw calls ${stats.drawCalls} · triangles ${(stats.triangles / 1000).toFixed(1)}k`,
    `chunks ${stats.chunks} (built ${stats.chunkBuilds}) · blocks ${stats.blocksVisible} · rebases ${stats.rebases}`,
    `song ${stats.songTime.toFixed(2)} / ${stats.duration.toFixed(2)} s · ${stats.mode} · hits ${stats.hits} · misses ${stats.misses}`,
    `analysis ${total} ms: ${timing}`,
    m ? `songmap ${m.blocks} blocks · ${m.bpm} BPM · ${m.powerBlocks} PB · ${m.hash}` : 'songmap —',
    `live tempo ${stats.live.tempo ?? '—'} · confidence ${stats.live.confidence ?? '—'}`,
    `flashes ${stats.flashes.allowed} allowed · ${stats.flashes.denied} limited${app.autopilot ? ' · autopilot' : ''}`,
  ].join('\n');
}

// --- wiring -----------------------------------------------------------------------

function ready() {
  return app.viewReady.then((ok) => {
    if (!ok) throw userError('This browser cannot run the 3D view (it needs WebGPU or WebGL2).');
  });
}

function wireMenu() {
  $('demo-btn').addEventListener('click', playDemo);
  const fileInput = $('file-input');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) playFile(f);
  });
  const drop = $('drop');
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (app.state === 'menu') drop.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) drop.classList.remove('over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (app.state !== 'menu') return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) playFile(f);
  });
  $('yt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    playYouTube($('yt-input').value);
  });

  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === app.settings.mode;
    r.addEventListener('change', () => {
      app.settings.mode = currentMode();
      saveSettings();
    });
  }
  const latency = $('latency'), latencyOut = $('latency-out');
  latency.value = String(app.settings.latency);
  latencyOut.textContent = `${app.settings.latency} ms`;
  latency.addEventListener('input', () => {
    app.settings.latency = Number(latency.value);
    latencyOut.textContent = `${app.settings.latency} ms`;
    if (app.player) app.player.offset = app.settings.latency / 1000;
    saveSettings();
  });
  const calm = $('calm');
  calm.checked = app.settings.calm;
  calm.addEventListener('change', () => {
    app.settings.calm = calm.checked;
    app.juice.calm = calm.checked;
    if (app.view) app.view.calm = calm.checked;
    saveSettings();
  });
  const quality = $('quality');
  quality.value = app.settings.quality;
  quality.addEventListener('change', () => {
    app.settings.quality = quality.value;
    saveSettings();
    if (app.view && app.view.gfx.renderer) {
      app.view.setQuality(quality.value);
      stats.quality = app.view.gfx.qualityName;
    }
  });

  $('resume-btn').addEventListener('click', resume);
  $('pause-restart-btn').addEventListener('click', restart);
  $('pause-menu-btn').addEventListener('click', toMenu);
  $('restart-btn').addEventListener('click', restart);
  $('menu-btn').addEventListener('click', toMenu);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    if (e.code === 'Escape') {
      if (app.state === 'play') pause();
      else if (app.state === 'paused') resume();
    } else if (e.code === 'KeyR' && !e.repeat && (app.state === 'play' || app.state === 'paused' || app.state === 'results')) {
      e.preventDefault();
      restart();
    } else if (e.code === 'KeyP' && DEBUG && app.state === 'play') {
      window.__hypersurf.autopilot = !app.autopilot;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('resize', () => app.view && app.view.gfx.renderer && app.view.resize());
  app.input.onPointerLockLost = pause;
  app.input.attach();
  // Clicking the view during play takes the pointer lock (browsers need a gesture).
  $('view').addEventListener('click', () => {
    if (app.state === 'play') app.input.requestLock();
  });
}

function wireErrors() {
  window.addEventListener('error', (e) => stats.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => stats.errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));
}

async function boot() {
  wireErrors();
  wireMenu();
  setState('menu');
  if (params.get('live') === 'demo') message('The live path (?live=demo) is not built yet. The demo below plays through the offline path.');
  app.view = new GameView($('view'), { forceWebGL: params.get('webgl') === '1', quality: app.settings.quality });
  app.viewReady = app.view.init().then(() => {
    stats.backend = app.view.backend;
    stats.quality = app.view.gfx.qualityName;
    app.view.calm = app.settings.calm;
    app.view.gfx.renderer.setAnimationLoop(frame);
    return true;
  }, (err) => {
    console.warn('renderer unavailable', err);
    stats.errors.push(`renderer: ${err && err.message ? err.message : err}`);
    message('This browser cannot run the 3D view (it needs WebGPU or WebGL2).');
    return false;
  });
}

boot();
