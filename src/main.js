// hypersurf app: menu → analyse (with progress) → swoop-in → play →
// results → instant restart. Files and the demo play through an
// AudioBufferSourceNode; game logic runs at a fixed 240 Hz step on the
// heard song time, and the view renders whatever time the clock reads.
//
// Live mode (YouTube, and ?live=demo for the demo through the same path)
// listens to a MediaStream instead: a LiveSession tracks the beat and
// grows a LiveMap two seconds ahead, which the same view and rules play.

import { GameView } from './game/view.js';
import { RulesEngine, RULES, EVENT } from './game/rules.js';
import { InputController, ShipMotion } from './game/input.js';
import { Juice } from './game/effects.js';
import { Hud, showResults, formatScore, clock } from './game/hud.js';
import { BestScores, sha256Hex, safeLocalStorage } from './game/scores.js';
import { createAutopilot } from './game/autopilot.js';
import { makeSample } from './game/trackpath.js';
import { Analyzer } from './audio/analyzer.js';
import { SongPlayer, copyChannels, toAudioBuffer } from './audio/player.js';
import { LEAD_IN, TAIL, makeGrid } from './audio/songmap.js';
import { Sfx } from './audio/sfx.js';
import { parseVideoId, YouTubePlayer, needsPlay, STATE as VIDEO } from './live/youtube.js';
import { captureSupport, captureTabAudio, stopStream, CAPTURE_MESSAGES } from './live/capture.js';
import { LiveSession, LiveClock, SESSION } from './live/session.js';
import { LiveMap } from './live/livemap.js';
import { MiniPlayer } from './live/panel.js';
import { SongClock } from './audio/clock.js';
import { FocusManager } from './ui/focus.js';
import { TerrainSky } from './ui/terrain.js';
import { FxLayer, FX_COLOURS } from './ui/particles.js';
import { Toasts } from './ui/toast.js';
import { Loading } from './ui/loading.js';
import { SelectStage } from './ui/stage.js';
import { modeOptions } from './ui/modes.js';
import { vehicleOptions } from './ui/vehicles.js';
import { createVehicle, VEHICLES, VEHICLE_ORDER, DEFAULT_VEHICLE, vehicleId } from './game/vehicles/index.js';
import { createUniforms } from './game/materials.js';
import { mountIcons } from './ui/icons.js';
import { decode, decodeAll, setCalm } from './ui/text.js';
import { BeatCheck } from './ui/beatcheck.js';
import { Profile } from './ui/profile.js';
import { zoneFor, hitsZone, ZONE_DISTANCES, ZONE_HALF_WIDTH } from './ui/keepout.js';

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
/** ?live=demo: the demo plays through the live listening path (a test hook for the live mode). */
const LIVE_DEMO = params.get('live') === 'demo';
const OCTAVE_LABEL = { '-1': 'Blocks every other beat', 0: 'Blocks on the beat', 1: 'Blocks twice per beat' };
const OCTAVE_TEXT = { '-1': '½', 0: '1', 1: '2' };
const SETTINGS_KEY = 'hypersurf.settings';

const $ = (id) => document.getElementById(id);
const storage = safeLocalStorage();
const fx = new FxLayer($('fx'));
const sky = new TerrainSky($('sky'));
const toasts = new Toasts($('toasts'));
const loadUi = new Loading($('loading'));
const focus = new FocusManager();
const mini = new MiniPlayer($('mini'), {
  onMove: (corner) => { app.settings.corner = corner; saveSettings(); },
  onHide: () => setVideoMode('hidden'),
});

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
  hud: new Hud($('hud'), fx),
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
  live: null, // live mode: { kind, session, clock, map, song, yt, stream, … }
  octave: 0, // live block grid: -1 every other beat, 0 on the beat, 1 twice per beat
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
  probe: null, // loading-screen GPU probe: { ms at full scale, starting scale, quality }
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
  /** Debug only: run the real frame loop at ~60 Hz for `seconds` (a hidden tab gets no animation frames). */
  pump(seconds) { return DEBUG ? pump(seconds) : null; },
};

// --- settings -------------------------------------------------------------------

function loadSettings() {
  // Calm visuals start on for people who ask their system for reduced motion.
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // capture: the tab-capture delay this browser last measured or was set to (ms).
  // video: the YouTube mini player's mode ('mini' or 'hidden') and corner.
  const defaults = { latency: 0, calm: reduced, quality: 'high', mode: 'mono', vehicle: DEFAULT_VEHICLE, sfx: true, capture: null, video: 'mini', corner: 'br' };
  try {
    const raw = storage && storage.getItem(SETTINGS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return {
      latency: Number.isFinite(v.latency) ? Math.max(-150, Math.min(300, v.latency)) : defaults.latency,
      calm: typeof v.calm === 'boolean' ? v.calm : defaults.calm,
      quality: ['high', 'medium', 'low'].includes(v.quality) ? v.quality : defaults.quality,
      mode: RULES[v.mode] ? v.mode : defaults.mode,
      vehicle: vehicleId(v.vehicle),
      sfx: typeof v.sfx === 'boolean' ? v.sfx : defaults.sfx,
      capture: Number.isFinite(v.capture) ? Math.max(0, Math.min(800, v.capture)) : defaults.capture,
      video: v.video === 'hidden' ? 'hidden' : 'mini',
      corner: ['br', 'bl', 'tr', 'tl'].includes(v.corner) ? v.corner : defaults.corner,
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

/** Screen shown in each state. Menu screens sit over the terrain sky; pause and results over the frozen game. */
const SCREENS = {
  menu: 'menu', file: 'file', video: 'video', mode: 'mode', vehicle: 'vehicle', settings: 'settings', howto: 'howto',
  analyze: 'loading', paused: 'pause', results: 'results',
};
const SKY = new Set(['menu', 'file', 'video', 'howto', 'analyze']);

function setState(state, initialFocus = null) {
  const prev = app.state;
  app.state = state;
  stats.state = state;
  document.body.dataset.state = state;
  for (const [s, id] of Object.entries(SCREENS)) $(id).hidden = s !== state;
  $('hud').hidden = state !== 'play';
  app.input.enabled = state === 'play';
  if (state !== 'play') app.input.releaseLock();
  // Settings opened from pause sit over the frozen game instead of the sky.
  const overGame = state === 'settings' && app.settingsFrom === 'paused';
  if (overGame) document.body.dataset.over = 'game'; else delete document.body.dataset.over;
  const gfx = app.view && app.view.gfx.renderer ? app.view.gfx : null;
  const skyOn = SKY.has(state) || (state === 'settings' && !overGame) || (!!STAGES[state] && !gfx);
  document.body.classList.toggle('sky', skyOn);
  if (skyOn) sky.start(app.settings.calm || reducedMotion()); else sky.stop();
  for (const [s, st] of Object.entries(STAGES)) {
    if (s === state) st.show(app.settings[s], gfx); else st.hide();
  }
  if (state !== 'settings') beatCheck.stop();
  app.redraw = 2; // frozen screens draw the game once more, then hold the image
  const root = SCREENS[state] ? $(SCREENS[state]) : null;
  if (state !== prev || initialFocus) focus.show(root, initialFocus);
  if (root) decodeAll(root);
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A toast outside play (errors, warnings, notes). */
function note(kind, title, body, opts) {
  return toasts.show(kind, title, body, opts);
}

const STAGE_OF = { synth: 'synth', resample: 'resample', spectrum: 'spectrum', onsets: 'onsets', tempo: 'tempo', loudness: 'loudness' };

function onProgress(fraction, stage) {
  if (STAGE_OF[stage]) loadUi.stage(STAGE_OF[stage]);
  loadUi.progress(fraction * 0.9);
}

function currentMode() {
  return RULES[app.settings.mode] ? app.settings.mode : 'mono';
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
    app.sfx = new Sfx(app.ctx, app.player.gain);
    app.sfx.enabled = app.settings.sfx;
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
  app.cancelled = false;
  try {
    await task();
  } catch (err) {
    if (err && err.cancelled) {
      if (app.player) app.player.stop();
      return;
    }
    console.warn(err);
    if (!(err && err.userMessage)) stats.errors.push(String(err && err.message ? err.message : err));
    leaveLive();
    setState('menu');
    const fileProblem = err && err.file;
    note('error', err && err.title ? err.title : 'Could not play that', err && err.userMessage ? err.userMessage : `Something went wrong: ${err && err.message ? err.message : err}`, {
      action: fileProblem ? { label: 'Try another file', run: () => setState('file') } : null,
      links: fileProblem ? [{ label: 'Play demo', run: playDemo }] : [],
      focus: !!fileProblem,
    });
  } finally {
    app.busy = false;
  }
}

function userError(text, title = '', file = false) {
  const e = new Error(text);
  e.userMessage = text;
  if (title) e.title = title;
  e.file = file;
  return e;
}

/** Esc on the loading screen: the task stops at its next step and the menu comes back. */
function cancelLoad() {
  if (app.state !== 'analyze' || !app.busy) return;
  app.cancelled = true;
  if (app.player) app.player.stop();
  const live = app.live && app.live.kind === 'youtube';
  if (app.live && app.live.session) { app.live.session.close(); stopStream(app.live.stream); app.live.session = app.live.stream = null; }
  setState(live ? 'video' : 'menu');
}

function checkCancel() {
  if (!app.cancelled) return;
  const e = new Error('cancelled');
  e.cancelled = true;
  throw e;
}

function playDemo() {
  return run(async () => {
    ensureAudio();
    await ready();
    const mode = currentMode();
    if (!(app.song && app.song.key === 'demo')) {
      setState('analyze');
      loadUi.begin('hypersurf demo', `${MODE_LABEL[mode]} · 2:31 · 128 BPM`, { demo: true });
      loadUi.stage('synth');
      const r = await analyzer().demo({ sampleRate: app.ctx.sampleRate, mode, onProgress });
      checkCancel();
      loadUi.stats(statsLine(r.songMap));
      app.analyzedKey = 'demo';
      app.song = {
        key: 'demo', title: 'hypersurf demo', source: 'demo',
        buffer: toAudioBuffer(app.ctx, r.channels, r.sampleRate), maps: { [mode]: r.songMap }, timings: r.timings,
      };
    }
    if (LIVE_DEMO) await startLiveDemo();
    else await startSong(mode);
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
    loadUi.begin(title, `${MODE_LABEL[mode]} · ${file.name.split('.').pop().toUpperCase()}`, { file: true });
    loadUi.stage('decode');
    const bytes = await file.arrayBuffer();
    const key = await sha256Hex(bytes);
    checkCancel();
    if (!(app.song && app.song.key === key)) {
      let buffer;
      try {
        buffer = await app.ctx.decodeAudioData(bytes);
      } catch {
        throw userError(`“${file.name}” could not be decoded. Try an MP3, WAV, OGG, FLAC or M4A file.`, 'File not readable', true);
      }
      if (buffer.duration > MAX_SECONDS) throw userError('That song is longer than 15 minutes. Please pick a shorter one.', 'Song too long', true);
      if (buffer.duration < MIN_SECONDS) throw userError('That file is too short to ride.', 'Song too short', true);
      checkCancel();
      loadUi.el.meta.textContent = `${MODE_LABEL[mode]} · ${clock(buffer.duration)}`;
      const r = await analyzer().analyze(copyChannels(buffer), buffer.sampleRate, { mode, seed: key, onProgress });
      checkCancel();
      loadUi.stats(statsLine(r.songMap));
      app.analyzedKey = key;
      app.song = { key, title, source: 'file', buffer, maps: { [mode]: r.songMap }, timings: r.timings };
    }
    await startSong(mode);
  });
}

/** A short stats line for the loading screen. */
function statsLine(map) {
  if (!map) return '';
  return `Tempo ${Math.round(map.bpm)} BPM · blocks ${formatScore(map.blocks.count)} · power ${map.powerBlocks.length}`;
}

// --- video setup ------------------------------------------------------------------

/** The video setup screen: a link field, blocks per beat and Start; the found video shows in the mini player. */
function openVideo() {
  if (app.busy) return;
  const support = captureSupport();
  const screen = $('video');
  screen.classList.toggle('unsupported', !support.ok);
  if (!support.ok) $('yt-unsupported').textContent = CAPTURE_MESSAGES[support.reason];
  showOctave();
  setState('video');
  if (!support.ok) focus.focus($('yt-file'));
  else if (app.live && app.live.yt && app.live.yt.ready && !app.live.session) focus.focus($('live-start'));
}

function videoStatus(text, tone = '') {
  const el = $('yt-status');
  el.textContent = text || '';
  el.className = `status ${tone}`;
}

function canStart(on) {
  $('live-start').disabled = !on;
}

/** The link field changed: find the video ID and load its player (or say why not). */
function onLinkInput() {
  const text = $('yt-input').value.trim();
  const id = parseVideoId(text);
  if (app.live && app.live.videoId === id) return;
  if (app.live) leaveLive();
  canStart(false);
  if (!text) { videoStatus(''); return; }
  if (!id) { videoStatus('That is not a YouTube link or video ID.', 'bad'); return; }
  if (!captureSupport().ok) return;
  loadVideo(id);
}

function loadVideo(id) {
  const live = app.live = { kind: 'youtube', videoId: id, yt: null, session: null, stream: null, map: null, clock: null, song: null, seen: 0, seeks: 0, wantPlay: false, playTry: 0 };
  mini.setMode(app.settings.video);
  mini.setCorner(app.settings.corner);
  mini.show(true);
  videoStatus('Loading video', 'wait');
  canStart(false);
  // The player loads in the background: Back works meanwhile, and nothing waits on it.
  const yt = live.yt = new YouTubePlayer(mini.player, id, { onState: onVideoState, onError: onVideoError });
  const current = () => app.live === live;
  yt.create().then(() => {
    if (current() && yt.ready && !yt.error) {
      videoStatus('Video found', 'ok');
      canStart(true);
      if (app.state === 'video' && document.activeElement === $('yt-input')) focus.focus($('live-start'));
    }
  }, (err) => {
    if (current()) videoStatus(err.userMessage || 'The YouTube player could not be loaded.', 'bad');
  });
  setTimeout(() => {
    // YouTube's embed never reports a video that does not exist until it is played.
    if (current() && !yt.ready && !yt.error) videoStatus('Not loaded after 15 seconds: it may not exist, be private or blocked from other sites, or the connection is slow.', 'bad');
  }, 15000);
}

/** VIDEO: MINI / HIDDEN (settings, pause screen, hotkey V). */
function setVideoMode(mode) {
  app.settings.video = mode === 'hidden' ? 'hidden' : 'mini';
  saveSettings();
  mini.setMode(app.settings.video);
  refreshSelectors();
  if (app.live && app.live.yt) {
    if (app.state === 'play') app.hud.callout('', 'Video', 'Press V to switch', app.settings.video === 'hidden' ? 'Hidden' : 'Mini');
    else {
      if (app.videoToast) app.videoToast();
      app.videoToast = note('info', app.settings.video === 'hidden' ? 'Video hidden' : 'Video shown', app.settings.video === 'hidden' ? 'It keeps playing. Press V to show it again.' : 'Drag it by its strip to any corner.');
    }
  }
}

/** Build (or reuse) the SongMap for `mode` and start a run. */
async function startSong(mode) {
  const song = app.song;
  let map = song.maps[mode];
  if (!map) {
    if (app.state !== 'analyze') {
      setState('analyze');
      loadUi.begin(song.title, MODE_LABEL[mode], { demo: song.source === 'demo', file: song.source === 'file' });
    }
    loadUi.stage(app.analyzedKey !== song.key ? 'resample' : 'build');
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
    checkCancel();
    song.maps[mode] = map;
    loadUi.stats(statsLine(map));
  }
  app.map = map;
  app.mode = mode;
  if (app.gridFor !== map) {
    app.grid = makeGrid(map.beats, map.bpm, map.duration);
    app.gridFor = map;
  }
  const view = app.view;
  if (view.map !== map) {
    view.load(map);
    app.hud.load(map, view.path, song.title);
    app.pauseProfile.song(view.path, map.duration, map.powerBlocks.map((pb) => pb.time));
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
  const map = app.map;
  const start = Math.min(FROM, Math.max(0, map.duration - 5)) - LEAD_IN;
  await resetRun(start);
  app.nextBeat = 0;
  while (app.nextBeat < map.beats.length && map.beats[app.nextBeat] < start) app.nextBeat++;
  ensureAudio();
  app.player.play(app.song.buffer, LEAD_IN, start + LEAD_IN);
  app.sfx.setSong(app.grid, app.player.clock.songStart);
  play();
}

/** Fresh rules, ship, juice and view for app.map at song time `start` (compiling on the first run). */
async function resetRun(start) {
  const { view, map, mode } = app;
  app.player.stop();
  app.frozen = null;
  app.rules = new RulesEngine(map.blocks, mode);
  app.ship.reset(0);
  app.juice.reset();
  app.juice.calm = app.settings.calm;
  app.input.reset();
  app.input.setShoulders(RULES[mode].shoulders);
  const songKey = app.live ? app.live.song.key : app.song.key;
  const best = app.best.get(songKey, mode);
  app.hud.reset(mode, best ? best.final : 0);
  app.autopilot = app.autopilotOn ? createAutopilot(map.blocks) : null;
  view.reset(start);
  if (!view.compiled) {
    if (app.state !== 'analyze') {
      setState('analyze');
      loadUi.begin(app.live ? app.live.song.title : app.song.title, MODE_LABEL[mode]);
    }
    loadUi.stage('shaders');
    app.sfx.prepare();
    await view.compile(app.rules.state);
    await calibrate();
    loadUi.done();
    checkCancel();
  }
  app.rules.skipTo(start);
  app.runStart = start;
  app.simT = start;
  app.viewT = start;
  stats.hits = 0;
  stats.misses = 0;
  stats.runs++;
}

function play() {
  checkCancel();
  app.zoneDue = true;
  app.lastFrame = performance.now();
  app.view.gfx.resetTiming(app.lastFrame);
  setState('play');
  app.input.requestLock();
}

function finishRun() {
  const live = app.live;
  if (live && live.map) {
    // Ghosts still unconfirmed at the end were never really there.
    live.map.dropGhosts();
    withdrawCancelled();
    live.wantPlay = false;
  }
  const song = live ? live.song : app.song;
  const results = app.rules.results();
  const best = app.best.submit(song.key, app.mode, results, app.map.hash);
  stats.lastResults = results;
  if (app.stopCount) app.stopCount();
  app.stopCount = showResults($('results'), { results, best, title: song.title, modeLabel: MODE_LABEL[app.mode] });
  if (best.isNew) updateMenuBest();
  setState('results', $('restart-btn'));
  decode($('res-title'));
}

function pause() {
  if (app.state !== 'play') return;
  const live = app.live;
  if (live && live.yt) {
    if (live.wantPlay) live.yt.pause(); // not when the viewer already paused it
    live.wantPlay = false;
    live.clock.hold();
  } else app.player.pause().catch(() => {});
  setState('paused', $('resume-btn'));
  fillPause();
}

/** The pause screen's song line, stats and profile playhead. */
function fillPause() {
  const song = app.live ? app.live.song : app.song;
  const r = app.rules, t = Math.max(0, app.viewT);
  const q = (k) => document.querySelector(`[data-pause=${k}]`);
  q('song').textContent = `${song.title} · ${MODE_LABEL[app.mode]}`;
  q('score').textContent = formatScore(r.score);
  q('time').textContent = clock(t);
  const live = !!app.live;
  q('total').textContent = live ? '· live' : `/ ${clock(app.map.duration)}`;
  q('blocks').textContent = formatScore(r.stats.colourHit);
  q('blocksTotal').textContent = `/ ${formatScore(r.stats.colour)}`;
  if (live) app.pauseProfile.rolling(app.view.path, t);
  else app.pauseProfile.draw(); // sized now that the screen shows
  app.pauseProfile.set(live ? 1 : t / app.map.duration);
  refreshSelectors();
}

function resume() {
  if (app.state !== 'paused') return;
  if (app.view && app.view.lost) { viewLostNote(); return; } // never play on while nothing is drawn
  if (app.lostNote) { app.lostNote(); app.lostNote = null; }
  if (app.live && app.live.yt) {
    app.live.wantPlay = true;
    app.live.yt.play();
  } else app.player.resume().catch(() => {});
  app.lastFrame = performance.now();
  app.view.gfx.resetTiming(app.lastFrame);
  setState('play');
  app.input.requestLock();
}

function restart() {
  if (!app.map || app.busy) return;
  if (app.state === 'paused') app.player.resume().catch(() => {});
  if (app.live) {
    if (!app.live.session) { openVideo(); return; } // sharing stopped: Start shares again
    if (app.live.yt) app.live.yt.seekTo(0);
    run(beginLiveRun);
    return;
  }
  run(beginRun);
}

function toMenu() {
  if (app.player) {
    app.player.stop();
    app.player.resume().catch(() => {});
  }
  leaveLive();
  setState('menu');
}

// --- live mode --------------------------------------------------------------------

/** ?live=demo: route the demo (and our own sounds) into a stream and listen to it like a shared tab. */
async function startLiveDemo() {
  if (!app.live) {
    const ctx = app.ctx;
    const dest = ctx.createMediaStreamDestination();
    const monitor = ctx.createGain(); // calibration clicks: heard, and "captured"
    monitor.connect(ctx.destination);
    monitor.connect(dest);
    app.player.gain.connect(dest);
    app.sfx.bus.connect(dest);
    app.live = { kind: 'demo', dest, monitor, session: null, map: null, clock: null, song: null, seen: 0 };
    app.live.session = await new LiveSession(ctx, dest.stream, { clickBus: monitor }).open();
    await calibrateLive();
  }
  await beginLiveRun();
}

/** The Start click: ask to share this tab (inside the click), then calibrate and play. */
function startYouTube() {
  const live = app.live;
  if (!live || !live.yt || !live.yt.ready || live.session || app.busy) return;
  ensureAudio();
  const sharing = captureTabAudio({ onEnded: onShareEnded });
  app.busy = true;
  app.cancelled = false;
  canStart(false);
  videoStatus('Choose this tab in the prompt and keep its audio on', 'wait');
  (async () => {
    try {
      live.stream = await sharing;
      checkCancel();
      const latency = app.settings.capture === null ? SESSION.defaultLatency : app.settings.capture / 1000;
      live.session = await new LiveSession(app.ctx, live.stream, { clickBus: app.ctx.destination, latency }).open();
      await calibrateLive();
      checkCancel();
      await beginLiveRun();
    } catch (err) {
      if (!(err && err.cancelled)) {
        console.warn(err);
        if (!err.userMessage) stats.errors.push(String(err && err.message ? err.message : err));
      }
      if (live.session) live.session.close();
      stopStream(live.stream);
      live.session = live.stream = null;
      if (app.live === live) {
        videoStatus('Video found', 'ok');
        canStart(true);
        if (app.state !== 'video') openVideo();
        if (!(err && err.cancelled)) {
          const denied = err && (err.reason === 'denied' || err.reason === 'no-audio');
          note(denied ? 'warn' : 'error', err && err.reason === 'no-audio' ? 'Tab audio not shared' : denied ? 'Sharing cancelled' : 'Could not start', err.userMessage || `Something went wrong: ${err.message || err}`,
            denied ? {} : { action: { label: 'Try again', run: () => focus.focus($('live-start')) }, links: [{ label: 'Play a file', run: () => { leaveLive(); setState('file'); } }, { label: 'Play demo', run: () => { leaveLive(); playDemo(); } }] });
        }
      }
    } finally {
      app.busy = false;
    }
  })();
}

/**
 * Eight clicks through our own output, heard back in the capture: the
 * capture delay. A video already playing is paused for it (the run starts
 * it again), so the clicks are heard in a quiet tab. If they are not
 * heard, the run keeps a typical delay and the player can nudge it.
 */
async function calibrateLive() {
  const live = app.live, yt = live.yt;
  setState('analyze');
  loadUi.begin(yt ? 'YouTube video' : 'hypersurf demo', 'Live listen · calibrating with a few clicks', { live: true });
  loadUi.stage('calibrate');
  loadUi.progress(0.4);
  if (yt && (yt.state === VIDEO.PLAYING || yt.state === VIDEO.BUFFERING)) yt.pause();
  const r = await live.session.calibrate();
  if (r && yt) {
    // Kept for next time: a tab capture's delay is this browser's and machine's.
    app.settings.capture = Math.round(r.latency * 1000);
    saveSettings();
    note('info', 'Listening', `Capture delay ${Math.round(r.latency * 1000)} ms.`);
  } else if (yt) {
    note('warn', 'Clicks not heard', 'Timing uses a typical capture delay. If blocks land before or after the beat, change the capture delay on the pause screen (or press - and =).');
  }
  loadUi.stage('build');
  loadUi.progress(0.8);
  refreshSelectors();
}

/** The timing control: nudge the capture delay by `steps` (kept for next time). */
function nudgeLatency(steps) {
  const session = app.live && app.live.session;
  if (!session) return;
  session.setLatency(session.latency + steps * SESSION.nudge);
  const ms = Math.round(session.latency * 1000);
  app.settings.capture = ms;
  saveSettings();
  refreshSelectors();
  if (app.state === 'play') app.hud.callout('', 'Delay', 'Capture delay', `${ms} ms`);
}

/** A live run: a fresh LiveMap grown from what the session hears. */
async function beginLiveRun() {
  const live = app.live, mode = currentMode(), view = app.view;
  const demo = live.kind === 'demo';
  live.song = demo
    ? { key: 'live:demo', title: 'hypersurf demo · live', source: 'live-demo' }
    : { key: `yt:${live.videoId}`, title: `YouTube · ${live.videoId}`, source: 'youtube' };
  const duration = demo ? app.song.buffer.duration : live.yt.duration;
  const map = new LiveMap({ mode, seed: live.song.key, duration });
  map.setOctave(app.octave);
  live.map = map;
  live.seen = 0;
  app.map = map;
  app.mode = mode;
  view.load(map);
  app.hud.load(map, view.path, live.song.title, { live: true });
  stats.song = { key: live.song.key, title: live.song.title, source: live.song.source, duration };
  stats.songMap = null;
  stats.analysis = null;
  stats.duration = duration;
  stats.mode = mode;
  await resetRun(-LEAD_IN);
  app.hud.liveStatus({ ...live.session.stats, heard: false });
  app.pauseProfile.rolling(view.path, 0);
  app.nextBeat = -Infinity;
  ensureAudio();
  app.sfx.setSong(null, 0);
  app.sfx.music = null; // never duck: the song's sound is not ours to touch
  app.sfx.onPlay = (t) => { if (app.live && app.live.session) app.live.session.suppress(t); };
  if (demo) {
    app.player.play(app.song.buffer, LEAD_IN, 0);
    live.clock = new LiveClock(app.player.clock);
  } else {
    const clock = new SongClock(app.ctx);
    clock.offset = app.settings.latency / 1000;
    clock.start(0);
    live.clock = new LiveClock(clock);
    live.clock.start(-LEAD_IN);
    live.seeks = live.yt.clock.seeks;
    live.wantPlay = true;
    live.playTry = 0;
    live.yt.play();
  }
  live.session.begin(map, live.clock);
  play();
}

/**
 * Song time for this frame. A YouTube run moves only while the video plays
 * (the swoop-in may run ahead of it, up to 0.3 s before the song starts),
 * a seek restarts the beat tracking, and the live map grows to now + 2 s.
 */
function liveTime() {
  const live = app.live, yt = live.yt;
  if (yt) {
    const vc = yt.sample();
    if (vc.seeks !== live.seeks) {
      live.seeks = vc.seeks;
      live.session.resync();
    }
    if (vc.playing) live.clock.run();
    else if (live.clock.time() >= -0.3) live.clock.hold();
    // playVideo may be refused while the player is off screen; try again each second.
    const now = performance.now();
    if (live.wantPlay && needsPlay(vc.state) && now - live.playTry > 1000) {
      live.playTry = now;
      yt.play();
    }
  }
  const t = live.clock.time();
  live.session.update(t);
  withdrawCancelled();
  return t;
}

/** Ghosts the live map withdrew leave the rules too. */
function withdrawCancelled() {
  const live = app.live, c = live.map.cancelled;
  for (; live.seen < c.count; live.seen++) app.rules.withdraw(c.list[live.seen % c.list.length]);
}

/** Beat pulses on the live grid, only while it is locked. */
function liveBeat(t) {
  const map = app.live.map;
  if (!map.gate || !map.grid.valid) return;
  const n = Math.floor(map.beatAt(t));
  if (n <= app.nextBeat) return; // a gliding grid may step back a beat: pulse each beat once
  if (app.nextBeat !== -Infinity) app.juice.onBeat(n, t, app.view.intensity);
  app.nextBeat = n;
}

function setOctave(o) {
  app.octave = Math.max(-1, Math.min(1, o));
  if (app.live && app.live.map) app.live.map.setOctave(app.octave);
  refreshSelectors();
  if (app.state === 'play') app.hud.callout('', 'Grid', OCTAVE_LABEL[app.octave], OCTAVE_TEXT[app.octave]);
}

/** "Stop sharing": the run cannot hear the song any more. */
function onShareEnded() {
  const live = app.live;
  if (!live || !live.session) return;
  if (app.state === 'play' || app.state === 'paused') finishRun();
  live.session.close();
  live.session = live.stream = null;
  if (live.kind === 'youtube') {
    videoStatus('Video found', 'ok');
    canStart(true);
  }
  note('warn', 'Sharing stopped', 'The game cannot hear the video any more. Press Start to share the tab again.');
}

/** The viewer paused the video from its own controls: pause the run with it, never restart the video. */
function onVideoState(state) {
  const live = app.live;
  if (!live || state !== VIDEO.PAUSED || !live.wantPlay) return;
  live.wantPlay = false;
  pause();
}

function onVideoError(code, text) {
  videoStatus(text, 'bad');
  canStart(false);
  if (app.state === 'play' || app.state === 'paused') finishRun();
  note('error', 'Video unavailable', text, {
    code: `ERR ${code}`,
    action: { label: 'Try another link', run: () => { if (app.state !== 'video') openVideo(); const i = $('yt-input'); i.focus(); i.select(); } },
    links: [{ label: 'Play a file', run: () => { leaveLive(); setState('file'); } }, { label: 'Play demo', run: () => { leaveLive(); playDemo(); } }],
  });
}

/** Leave the live mode: stop listening, free the player and give the page back its full width. */
function leaveLive() {
  const live = app.live;
  if (!live) return;
  app.live = null;
  if (live.session) live.session.close();
  if (live.kind === 'demo') {
    try {
      app.player.gain.disconnect(live.dest);
      app.sfx.bus.disconnect(live.dest);
      live.monitor.disconnect();
    } catch { /* already apart */ }
  } else {
    stopStream(live.stream);
    if (live.yt) live.yt.destroy();
    mini.show(false);
  }
  if (app.sfx) {
    app.sfx.music = app.player.gain;
    app.sfx.onPlay = null;
    app.sfx.setSong(null, 0);
  }
  app.map = null;
  stats.live = { available: false, tempo: null, confidence: null };
}

// --- HUD keep-out -----------------------------------------------------------------

const zoneSample = makeSample();
/** HUD clusters that can step aside, each with its fallback (docs/art-direction.md §9.1). */
const HUD_MOVABLE = [['grid', '.hud-grid'], ['feed', '.feed']];

/**
 * Project the track ahead into the keep-out zone with the camera's current
 * pose and, if the grid or the feed would touch it, move that cluster to
 * its fallback. Runs once the swoop-in has settled and on resizes, never
 * per frame.
 */
function placeHud() {
  const view = app.view;
  if (!view || !view.map || !view.path || app.state !== 'play') return;
  const hud = $('hud');
  const w = innerWidth, h = innerHeight;
  const path = view.path, o = view.origin, s = zoneSample;
  const t0 = app.viewT;
  path.sample(t0, s);
  const d0 = s.dist;
  const edges = [];
  // The stretch between the camera and the ship fills the bottom of the screen.
  for (const back of [0.05, 0.1, 0.2, 0.3]) {
    path.sample(t0 - back, s);
    for (const side of [-1, 1]) {
      const r = side * ZONE_HALF_WIDTH;
      edges.push([s.px + s.rx * r - o.x, s.py + s.ry * r - o.y, s.pz + s.rz * r - o.z]);
    }
  }
  let k = 0;
  for (let t = t0; k < ZONE_DISTANCES.length && t < t0 + 20; t += 0.04) {
    path.sample(t, s);
    if (s.dist - d0 < ZONE_DISTANCES[k]) continue;
    for (const side of [-1, 1]) {
      const r = side * ZONE_HALF_WIDTH;
      edges.push([s.px + s.rx * r - o.x, s.py + s.ry * r - o.y, s.pz + s.rz * r - o.z]);
    }
    if (k === 0) {
      // The ship's box, about 1.3 m to each side and 1.2 m up.
      for (const side of [-1.3, 1.3]) edges.push([s.px + s.rx * side + s.ux * 1.2 - o.x, s.py + s.ry * side + s.uy * 1.2 - o.y, s.pz + s.rz * side + s.uz * 1.2 - o.z]);
    }
    k++;
  }
  view.camera.updateMatrixWorld();
  const zone = zoneFor(view.camera.matrixWorldInverse.elements, w / h, edges, w, h);
  const overlap = [];
  for (const [name, sel] of HUD_MOVABLE) {
    // Try the preferred anchor first, then the fallback.
    delete hud.dataset[name];
    let r = hud.querySelector(sel).getBoundingClientRect();
    if (hitsZone(zone, { x: r.left, y: r.top, w: r.width, h: r.height })) {
      hud.dataset[name] = 'alt';
      r = hud.querySelector(sel).getBoundingClientRect();
      if (hitsZone(zone, { x: r.left, y: r.top, w: r.width, h: r.height })) overlap.push(name);
    }
  }
  for (const sel of ['.hud-song', '.hud-score']) {
    const r = hud.querySelector(sel).getBoundingClientRect();
    if (hitsZone(zone, { x: r.left, y: r.top, w: r.width, h: r.height })) overlap.push(sel.slice(5));
  }
  stats.keepout = { zone: zone.map(([x, y]) => [Math.round(x), Math.round(y)]), overlap, grid: hud.dataset.grid || 'main', feed: hud.dataset.feed || 'main' };
  if (DEBUG) drawZone(zone);
}

/** Debug: the zone as an outline (key Z toggles it). */
function drawZone(zone) {
  let svg = $('zone');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'zone';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:45;pointer-events:none';
    svg.innerHTML = '<polygon fill="rgba(255,90,42,.08)" stroke="#ff5a2a" stroke-width="1" stroke-dasharray="4 4"/>';
    svg.setAttribute('hidden', ''); // SVG elements have no .hidden property
    document.body.appendChild(svg);
  }
  svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
  svg.firstChild.setAttribute('points', zone.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
}

// --- frame loop -------------------------------------------------------------------

let liveStatsNext = 0;
function frame() {
  const t0 = performance.now();
  const dt = Math.min(0.1, Math.max(0, (t0 - app.lastFrame) / 1000));
  const frameMs = t0 - app.lastFrame;
  app.lastFrame = t0;
  if (app.view && app.view.lost) {
    // Nothing can be drawn: never keep playing (and scoring) blind.
    if (app.state === 'play') pause();
    return;
  }
  if (STAGES[app.state]) {
    // The selection stage borrows the renderer while its screen is open.
    const st = STAGES[app.state];
    st.render(dt);
    stats.stageFrames = st.frames;
    if (DEBUG) debugOverlay(t0);
    return;
  }
  const view = app.view;
  const live = app.state === 'play' || app.state === 'paused' || app.state === 'results' || document.body.dataset.over === 'game';
  if (!live || !view || !view.map) return;
  // Pause, results and settings over the game show the last frame, blurred
  // by CSS: draw it once more after the change, then hold it.
  if (app.state !== 'play') {
    // Also once a second, in case the browser dropped the held image.
    if (!(app.redraw > 0) && t0 - (app.heldAt || 0) < 1000) { if (DEBUG) debugOverlay(t0); return; }
    app.redraw = Math.max(0, (app.redraw || 0) - 1);
    app.heldAt = t0;
  }

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
  if (app.live && app.live.session && t0 >= liveStatsNext) {
    liveStatsNext = t0 + 250;
    const ls = stats.live = { available: true, ...app.live.session.stats };
    if (app.state === 'play') app.hud.liveStatus({ ...ls, heard: app.viewT > 0 && (ls.intensity > 0.02 || ls.blocks > 0) });
  }
  if (DEBUG) debugOverlay(t0);
}

/**
 * On the loading screen, time a few GPU-synced frames and start at a
 * resolution scale (or the low tier) the GPU can hold, rather than letting
 * the governor find it during the swoop-in.
 */
async function calibrate() {
  const gfx = app.view.gfx;
  const ms = await gfx.probe();
  if (gfx.governor.calibrate(ms) && gfx.qualityName !== 'low') {
    lowerQuality();
    gfx.governor.calibrate(await gfx.probe());
  }
  gfx.renderer.setPixelRatio(gfx.pixelRatio());
  stats.probe = { ms: Math.round(ms * 100) / 100, scale: gfx.governor.scale, quality: gfx.qualityName };
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
  const t = app.live ? liveTime() : app.player.time();
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
  if (app.live) liveBeat(t);
  const beats = map.beats;
  while (app.nextBeat < beats.length && beats[app.nextBeat] <= t) {
    juice.onBeat(app.nextBeat, t, app.view.intensity);
    app.nextBeat++;
  }
  juice.update(dt);
  const yt = app.live && app.live.yt;
  app.hud.update(rules, t, dt, rules.lane);
  if (app.zoneDue && app.viewT >= app.runStart + SWOOP + 0.5) { app.zoneDue = false; placeHud(); }
  if (yt ? yt.clock.state === VIDEO.ENDED && t > 0 : t > map.duration + 0.75) finishRun();
}

function onEvent(ev) {
  const { juice, view, sfx } = app;
  const now = app.simT;
  switch (ev.type) {
    case EVENT.HIT:
      stats.hits++;
      juice.hit(now);
      sfx.hit(ev.lane + 1, ev.count, ev.time);
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.GREY:
    case EVENT.SPIKE:
      stats.hits++;
      juice.grey();
      sfx.grey();
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.POWER:
      stats.hits++;
      juice.power();
      juice.burst(0.6, now);
      sfx.power(ev.time);
      view.blocks.shatter(ev.block, view.path.sample(ev.time, app.hitSample), performance.now() / 1000);
      break;
    case EVENT.COLLECT:
      if (ev.value > 0) {
        juice.cashIn(now, ev.count);
        sfx.cashIn(ev.count, ev.time);
      }
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
 * moment. Juice can be forced for the shot: { beat, shock, hit };
 * swoop (0..1) shows that point of the swoop-in.
 */
function freezeAt(t, { settle = 1.5, beat = 0, shock = 0, hit = 0, x = null, swoop = 1 } = {}) {
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
    view.frame(ti, 1 / 60, ti, app.ship.x, app.ship.v, app.rules.state, app.juice, Math.max(0, Math.min(1, swoop + (i - n) / 60 / SWOOP)));
  }
  app.juice.beat = beat;
  app.juice.shock = shock;
  app.juice.shockTime = t - 0.25;
  app.juice.debris = hit;
  app.juice.ship = hit;
  app.viewT = t;
  app.runStart = t - SWOOP * swoop;
  app.frozen = t;
  return true;
}

/**
 * Render `frames` frames from song time `from`, `dt` apart, synchronously,
 * forcing the GPU to finish each one (a 1-pixel readback on WebGL2, queue
 * completion on WebGPU). Measures real frame cost even in a background tab
 * where animation frames are throttled. render: false runs only the
 * game-side frame work (to check it allocates nothing).
 */
async function bench({ from = app.viewT, frames = 300, dt = 1 / 60, render = true } = {}) {
  const view = app.view;
  if (!view || !view.map) return null;
  const was = app.frozen;
  app.frozen = from; // keep the animation loop from interleaving
  const total = new Float64Array(frames), cpu = new Float64Array(frames);
  const pilot = createAutopilot(app.map.blocks);
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  let draws = 0, tris = 0;
  for (let i = 0; i < frames; i++) {
    const t = from + i * dt;
    // What the animation loop does per frame: without a new node frame the
    // scene pass would reuse its last output.
    view.gfx.nextFrame();
    const a = performance.now();
    app.ship.step(dt, pilot(t));
    app.juice.update(dt);
    view.frame(t, dt, t, app.ship.x, app.ship.v, app.rules.state, app.juice, 1);
    if (render) view.render();
    const b = performance.now();
    if (render) await view.gfx.finish();
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

/** The frame loop driven by message-channel turns instead of animation frames. */
async function pump(seconds = 5) {
  const ch = new MessageChannel();
  const turn = () => new Promise((resolve) => { ch.port1.onmessage = resolve; ch.port2.postMessage(0); });
  const end = performance.now() + seconds * 1000;
  let next = performance.now();
  while (performance.now() < end) {
    await turn();
    if (performance.now() < next) continue;
    next = Math.max(next + 1000 / 60, performance.now() - 50);
    // What the animation loop does per frame: fresh render info and node frame.
    if (app.view && app.view.gfx.renderer) app.view.gfx.nextFrame();
    frame();
  }
  ch.port1.close();
  return stats.state;
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
    `${stats.backend} · ${stats.quality} · pixel ratio ${stats.pixelRatio.toFixed(2)}${stats.probe ? ` · probe ${stats.probe.ms} ms` : ''}`,
    `fps ${stats.fps.toFixed(0)} · frame ${stats.frameMs.toFixed(1)} ms · cpu ${stats.cpuMs.toFixed(2)} ms`,
    `draw calls ${stats.drawCalls} · triangles ${(stats.triangles / 1000).toFixed(1)}k`,
    `chunks ${stats.chunks} (built ${stats.chunkBuilds}) · blocks ${stats.blocksVisible} · rebases ${stats.rebases}`,
    `song ${stats.songTime.toFixed(2)} / ${stats.duration.toFixed(2)} s · ${stats.mode} · hits ${stats.hits} · misses ${stats.misses}`,
    `analysis ${total} ms: ${timing}`,
    m ? `songmap ${m.blocks} blocks · ${m.bpm} BPM · ${m.powerBlocks} PB · ${m.hash}` : 'songmap —',
    stats.live.available
      ? `live ${stats.live.tempo} BPM · confidence ${stats.live.confidence} · hits ${stats.live.hitRate} · delay ${stats.live.latencyMs} ms · ${stats.live.locked ? 'locked' : 'listening'} · blocks ${stats.live.blocks} (${stats.live.ghosts} ghosts, ${stats.live.withdrawn} withdrawn)`
      : 'live —',
    `flashes ${stats.flashes.allowed} allowed · ${stats.flashes.denied} limited${app.autopilot ? ' · autopilot' : ''}`,
  ].join('\n');
}

// --- lost 3D view -----------------------------------------------------------------

/** Seconds to wait for the browser to give the context back before offering a reload. */
const RESTORE_WAIT = 5000;

/** Try `build` a few times: a browser that just lost a context may refuse a new one for a moment. */
async function withRetry(build, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await build();
    } catch (err) {
      if (i >= tries - 1) throw err;
      console.warn('3D view not ready, trying again', err);
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** i));
    }
  }
}

/** WebGL2 or WebGPU exist here at all (a failure is then the browser refusing for now, not a missing feature). */
const has3d = () => typeof WebGL2RenderingContext !== 'undefined' || !!navigator.gpu;

function offerReload(title, body) {
  if (app.lostNote) app.lostNote();
  app.lostNote = note('error', title, body, { action: { label: 'Reload', run: () => location.reload() } });
}

function viewLostNote() {
  if (app.lostNote) app.lostNote();
  app.lostNote = note('warn', '3D view lost', 'The 3D view was lost by the browser — restoring…', { focus: false });
}

/** The context is gone: pause at once (the song too) and say so. */
function onViewLost() {
  stats.contextLosses = (stats.contextLosses || 0) + 1;
  if (app.state === 'play') pause();
  app.redraw = 2;
  viewLostNote();
  clearTimeout(app.restoreTimer);
  app.restoreTimer = setTimeout(() => {
    if (app.view.lost) offerReload('3D view not restored', 'The browser has not given the 3D view back. Reload the page to carry on.');
  }, RESTORE_WAIT);
}

/** The context can be had again: rebuild the view, compile again and offer RESUME. */
async function onViewRestorable() {
  const view = app.view;
  if (app.restoring) return;
  app.restoring = true;
  try {
    await withRetry(() => view.rebuild());
    view.calm = app.settings.calm;
    view.gfx.renderer.setAnimationLoop(frame);
    stats.backend = view.backend;
    stats.quality = view.gfx.qualityName;
    for (const st of Object.values(STAGES)) st.reset();
    if (STAGES[app.state]) STAGES[app.state].show(app.settings[app.state], view.gfx);
    if (view.map && app.rules) {
      view.reset(app.viewT);
      await view.compile(app.rules.state);
    }
  } catch (err) {
    console.warn('3D view not restored', err);
    stats.errors.push(`restore: ${err && err.message ? err.message : err}`);
    offerReload('3D view not restored', 'The 3D view could not be rebuilt. Reload the page to carry on.');
    return;
  } finally {
    app.restoring = false;
  }
  clearTimeout(app.restoreTimer);
  if (app.lostNote) app.lostNote();
  app.lostNote = null;
  app.redraw = 2;
  app.lastFrame = performance.now();
  view.gfx.resetTiming(app.lastFrame);
  // Kept in lostNote so RESUME clears it (toasts stay out of play).
  if (app.state === 'paused') app.lostNote = note('info', '3D view restored', 'Resume when you are ready.', { action: { label: 'Resume', run: resume }, focus: true });
  else note('info', '3D view restored', 'Everything is drawn again.');
}

// --- wiring -----------------------------------------------------------------------

function ready() {
  return app.viewReady.then((ok) => {
    if (!ok) throw userError(has3d() ? 'The browser is not giving this page a 3D view right now. Reload to try again.' : 'This browser cannot run the 3D view (it needs WebGPU or WebGL2).', 'No 3D view');
  });
}

const stage = new SelectStage($('mode'), modeOptions((id) => {
  const b = app.best.get('demo', id);
  return b ? `${formatScore(b.final)} (demo)` : '—';
}), { fx, noun: 'mode' });
let stageUniforms = null;
const vehicleStage = new SelectStage($('vehicle'), vehicleOptions((id, parent) => {
  if (!stageUniforms) stageUniforms = createUniforms();
  return createVehicle(id, parent, stageUniforms);
}), { fx, noun: 'vehicle' });
/** The selection stages by state; each shows app.settings[state]. */
const STAGES = { mode: stage, vehicle: vehicleStage };
const beatCheck = new BeatCheck(document.querySelector('.beatcheck'), {
  audio: () => app.ctx,
  latencyMs: () => app.settings.latency,
  calm: () => app.settings.calm,
});
app.pauseProfile = new Profile(document.querySelector('[data-pause=profile]'));

const MODE_IDS = ['casual', 'mono', 'ninja'];
const QUALITY_IDS = ['high', 'medium', 'low'];

/**
 * An enumerated ‹ VALUE › selector row: ←/→ (a 'step' event from the focus
 * manager) or its chevrons change the value, without wrapping; Enter wraps.
 */
function selector(row, { values, label, get, set }) {
  const out = row.querySelector('output');
  const [prev, next] = row.querySelectorAll('.chev');
  const show = (dir = 0) => {
    const v = get(), i = values.indexOf(v);
    const text = label(v);
    if (out.textContent !== text) {
      out.textContent = text;
      if (dir) { out.style.setProperty('--dir', String(dir)); out.classList.remove('swap'); void out.offsetWidth; out.classList.add('swap'); }
    }
    if (prev) prev.classList.toggle('end', i <= 0);
    if (next) next.classList.toggle('end', i >= values.length - 1);
    row.setAttribute('aria-valuetext', text);
  };
  const step = (dir, wrap = false) => {
    const i = values.indexOf(get());
    let j = i + dir;
    if (wrap) j = (j + values.length) % values.length;
    if (j < 0 || j >= values.length || j === i) return;
    set(values[j]);
    show(dir);
  };
  row.addEventListener('step', (e) => step(e.detail.dir, e.detail.wrap));
  if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); row.focus(); });
  if (next) next.addEventListener('click', (e) => { e.stopPropagation(); step(1); row.focus(); });
  show();
  return show;
}

const selectorViews = [];
function refreshSelectors() {
  for (const show of selectorViews) show();
  const d = app.live && app.live.session ? Math.round(app.live.session.latency * 1000) : app.settings.capture === null ? Math.round(SESSION.defaultLatency * 1000) : app.settings.capture;
  for (const o of document.querySelectorAll('[data-delay-out]')) o.textContent = `${d} MS`;
}

function showOctave() {
  refreshSelectors();
}

function setCalmVisuals(on) {
  app.settings.calm = on;
  app.juice.calm = on;
  if (app.view) app.view.calm = on;
  setCalm(on);
  fx.enabled = !on && !reducedMotion();
  document.body.classList.toggle('calm', on);
  $('calm-btn').setAttribute('aria-pressed', String(on));
  if (sky.on) sky.start(on || reducedMotion());
  saveSettings();
}

function setSfx(on) {
  app.settings.sfx = on;
  if (app.sfx) app.sfx.enabled = on;
  $('sfx-btn').setAttribute('aria-pressed', String(on));
  saveSettings();
}

function setMode(id) {
  if (!RULES[id]) return;
  app.settings.mode = id;
  $('mode-now').textContent = MODE_LABEL[id];
  updateMenuBest();
  saveSettings();
}

function setVehicle(id) {
  app.settings.vehicle = vehicleId(id);
  $('vehicle-now').textContent = VEHICLES[app.settings.vehicle].name;
  document.body.dataset.vehicle = app.settings.vehicle;
  if (app.view) app.view.setVehicle(app.settings.vehicle);
  saveSettings();
}

function updateMenuBest() {
  const b = app.best.get('demo', currentMode());
  $('menu-best').textContent = b ? formatScore(b.final) : '—';
}

function setLatency(ms) {
  app.settings.latency = Math.max(-150, Math.min(300, ms));
  const input = $('latency');
  if (Number(input.value) !== app.settings.latency) input.value = String(app.settings.latency);
  input.style.setProperty('--p', `${((app.settings.latency + 150) / 450) * 100}%`);
  $('latency-out').textContent = `${app.settings.latency >= 0 ? '+' : '−'}${Math.abs(app.settings.latency)} MS`;
  if (app.player) app.player.offset = app.settings.latency / 1000;
  saveSettings();
}

function openSettings() {
  app.settingsFrom = app.state === 'paused' ? 'paused' : 'menu';
  try { ensureAudio(); } catch { /* the beat check stays silent */ }
  setState('settings');
  showTab('settings', app.settingsTab || 0, false);
}

function closeSettings() {
  if (app.settingsFrom === 'paused') { setState('paused'); fillPause(); } else setState('menu');
}

/** Underline tabs: select tab i of a screen's tablist. */
function showTab(screenId, i, focusTab = true) {
  const tabs = Array.from($(screenId).querySelectorAll('[role=tab]'));
  const k = (i + tabs.length) % tabs.length;
  tabs.forEach((t, j) => {
    t.setAttribute('aria-selected', String(j === k));
    t.tabIndex = j === k ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = j !== k;
  });
  if (screenId === 'settings') app.settingsTab = k;
  if (screenId === 'howto') app.howtoTab = k;
  if (focusTab) tabs[k].focus();
  else {
    // Focus left in a pane that just closed moves to the new pane's first control.
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('[hidden]')) {
      const first = $(tabs[k].getAttribute('aria-controls')).querySelector('[data-nav]');
      focus.focus(first || tabs[k]);
    }
  }
  settingsInfo();
}

function tabStep(screenId, dir) {
  const tabs = Array.from($(screenId).querySelectorAll('[role=tab]'));
  const cur = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  showTab(screenId, cur + dir, document.activeElement && document.activeElement.getAttribute('role') === 'tab');
}

/** INFORMATION explains the focused settings row. */
function settingsInfo() {
  const el = document.activeElement;
  const holder = el && el.closest && el.closest('[data-info]');
  let text = holder ? holder.dataset.info : '';
  if (!text) {
    const pane = $('settings').querySelector('.pane:not([hidden]) [data-info]');
    text = pane ? pane.dataset.info : '';
  }
  $('settings-info').textContent = text;
  // The beat check runs while the latency row has focus.
  if (app.state === 'settings' && el && el.closest && el.closest('.latency-row')) beatCheck.start();
  else beatCheck.stop();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

/** Sparks from an activated control (cyan, gold from the focused one). */
function sparkFrom(el) {
  if (!el || !el.getBoundingClientRect || !fx.enabled) return;
  const r = el.getBoundingClientRect();
  const gold = el === document.activeElement;
  fx.burst(r.left + Math.min(r.width, 360) / 2, r.top + r.height / 2, 18, { colour: gold ? FX_COLOURS.gold : FX_COLOURS.cyan, speed: 240, life: 0.45, size: 2.2, jitter: Math.min(r.width, 300) });
}

function wireUi() {
  mountIcons();
  // The inner bevel line of the chamfered buttons, and the ◆ marker of panel actions.
  for (const b of document.querySelectorAll('.cb')) {
    b.insertAdjacentHTML('afterbegin', '<svg class="bevel" viewBox="0 0 40 64" preserveAspectRatio="none" aria-hidden="true"><polyline points="14,5 6,29.4 33,59"/></svg>');
  }
  for (const b of document.querySelectorAll('.act')) b.insertAdjacentHTML('afterbegin', '<i class="mk" aria-hidden="true"></i>');
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.cb, .act, .dia, .opt');
    if (b && !b.disabled) sparkFrom(b);
  });

  // Main menu.
  $('demo-btn').addEventListener('click', playDemo);
  $('file-btn').addEventListener('click', () => setState('file'));
  $('video-btn').addEventListener('click', openVideo);
  const modeBtn = $('mode-btn');
  modeBtn.addEventListener('click', () => setState('mode'));
  modeBtn.addEventListener('step', (e) => {
    const i = MODE_IDS.indexOf(currentMode());
    const j = e.detail.wrap ? (i + e.detail.dir + 3) % 3 : Math.max(0, Math.min(2, i + e.detail.dir));
    if (e.detail.wrap) { setState('mode'); return; } // Enter opens mode select
    setMode(MODE_IDS[j]);
  });
  for (const [k, chev] of Array.from(modeBtn.querySelectorAll('.chev')).entries()) {
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = MODE_IDS.indexOf(currentMode());
      setMode(MODE_IDS[Math.max(0, Math.min(2, i + (k ? 1 : -1)))]);
    });
  }
  const vehicleBtn = $('vehicle-btn');
  const stepVehicle = (dir) => {
    const i = VEHICLE_ORDER.indexOf(app.settings.vehicle);
    setVehicle(VEHICLE_ORDER[Math.max(0, Math.min(VEHICLE_ORDER.length - 1, i + dir))]);
  };
  vehicleBtn.addEventListener('click', () => setState('vehicle'));
  vehicleBtn.addEventListener('step', (e) => {
    if (e.detail.wrap) setState('vehicle'); // Enter opens vehicle select
    else stepVehicle(e.detail.dir);
  });
  for (const [k, chev] of Array.from(vehicleBtn.querySelectorAll('.chev')).entries()) {
    chev.addEventListener('click', (e) => { e.stopPropagation(); stepVehicle(k ? 1 : -1); });
  }
  $('settings-btn').addEventListener('click', openSettings);
  $('howto-btn').addEventListener('click', () => { setState('howto'); showTab('howto', app.howtoTab || 0, false); });
  $('fs-btn').addEventListener('click', toggleFullscreen);
  $('sfx-btn').addEventListener('click', () => setSfx(!app.settings.sfx));
  $('calm-btn').addEventListener('click', () => setCalmVisuals(!app.settings.calm));
  focus.onPad = (on) => document.body.classList.toggle('pad', on);
  focus.onIdleBack = pause;

  // Audio file.
  const fileInput = $('file-input');
  $('browse-btn').addEventListener('click', () => fileInput.click());
  $('drop').addEventListener('click', (e) => { if (e.target === $('drop')) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) playFile(f);
  });
  const drop = $('drop');
  const canDrop = () => app.state === 'menu' || app.state === 'file';
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (canDrop()) {
      if (app.state === 'menu') setState('file');
      drop.classList.add('over');
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) drop.classList.remove('over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (!canDrop()) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) playFile(f);
  });

  // Video setup.
  const link = $('yt-input');
  link.addEventListener('input', onLinkInput);
  $('yt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onLinkInput();
    if (!$('live-start').disabled) startYouTube();
  });
  $('live-start').addEventListener('click', startYouTube);
  $('yt-file').addEventListener('click', () => setState('file'));
  $('yt-demo').addEventListener('click', playDemo);
  const octave = { values: [-1, 0, 1], label: (v) => OCTAVE_TEXT[v], get: () => app.octave, set: setOctave };
  selectorViews.push(selector($('octave-row'), octave), selector($('pause-octave-row'), octave));
  // Capture delay: each step nudges the live session's delay.
  const delayRow = $('pause-delay-row');
  delayRow.addEventListener('step', (e) => { if (!e.detail.wrap) nudgeLatency(e.detail.dir); });
  for (const [k, chev] of Array.from(delayRow.querySelectorAll('.chev')).entries()) {
    chev.addEventListener('click', (e) => { e.stopPropagation(); nudgeLatency(k ? 1 : -1); delayRow.focus(); });
  }

  // Mode select.
  $('mode').querySelector('[data-stage-confirm]').addEventListener('click', () => {
    setMode(stage.value);
    setState('menu');
  });
  $('vehicle').querySelector('[data-stage-confirm]').addEventListener('click', () => {
    setVehicle(vehicleStage.value);
    setState('menu');
  });

  // Settings.
  const latency = $('latency');
  setLatency(app.settings.latency);
  latency.addEventListener('input', () => setLatency(Number(latency.value)));
  selectorViews.push(
    selector($('sfx-row'), { values: [false, true], label: (v) => (v ? 'On' : 'Off'), get: () => app.settings.sfx, set: setSfx }),
    selector($('calm-row'), { values: [false, true], label: (v) => (v ? 'On' : 'Off'), get: () => app.settings.calm, set: setCalmVisuals }),
    selector($('quality-row'), {
      values: QUALITY_IDS, label: (v) => v, get: () => app.settings.quality,
      set: (v) => {
        app.settings.quality = v;
        saveSettings();
        if (app.view && app.view.gfx.renderer) {
          app.view.setQuality(v);
          stats.quality = app.view.gfx.qualityName;
          app.redraw = 2;
        }
      },
    }),
  );
  const videoSel = { values: ['mini', 'hidden'], label: (v) => (v === 'hidden' ? 'Hidden' : 'Mini'), get: () => app.settings.video, set: setVideoMode };
  selectorViews.push(selector($('video-row'), videoSel), selector($('pause-video-row'), videoSel));
  $('defaults-btn').addEventListener('click', () => {
    setLatency(0);
    setSfx(true);
    setCalmVisuals(reducedMotion());
    setVideoMode('mini');
    app.settings.quality = 'high';
    if (app.view && app.view.gfx.renderer) app.view.setQuality('high');
    saveSettings();
    refreshSelectors();
    note('info', 'Defaults restored', 'Latency 0 ms, hit sounds on, quality high.');
  });
  for (const id of ['settings', 'howto']) {
    for (const [i, t] of Array.from($(id).querySelectorAll('[role=tab]')).entries()) t.addEventListener('click', () => showTab(id, i));
  }
  $('settings').addEventListener('focusin', settingsInfo);

  // Back buttons.
  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => {
      const id = b.closest('.screen').id;
      back(id);
    });
  }

  // Pause and results.
  $('resume-btn').addEventListener('click', resume);
  $('pause-restart-btn').addEventListener('click', restart);
  $('pause-settings-btn').addEventListener('click', openSettings);
  $('pause-menu-btn').addEventListener('click', toMenu);
  $('restart-btn').addEventListener('click', restart);
  $('menu-btn').addEventListener('click', toMenu);
  $('hud-pause').addEventListener('click', (e) => { e.stopPropagation(); pause(); });

  // Focus manager: per-screen back, tabs and sideways moves.
  focus.register('menu', {});
  focus.register('file', { back: () => back('file') });
  focus.register('video', { back: () => back('video') });
  focus.register('mode', { back: () => back('mode'), side: (dir) => { stage.step(dir); return true; } });
  focus.register('vehicle', { back: () => back('vehicle'), side: (dir) => { vehicleStage.step(dir); return true; } });
  focus.register('settings', { back: () => back('settings'), tab: (dir) => tabStep('settings', dir) });
  focus.register('howto', { back: () => back('howto'), tab: (dir) => tabStep('howto', dir) });
  focus.register('loading', { back: cancelLoad });
  focus.register('pause', { back: resume });
  focus.register('results', { back: toMenu });

  window.addEventListener('keydown', (e) => {
    const inText = e.target instanceof HTMLInputElement && e.target.type === 'text';
    // Toasts: their buttons work natively; Escape dismisses.
    if (e.target.closest && e.target.closest('.toast')) {
      if (e.code === 'Escape') { e.target.closest('.toast').querySelector('.t-close').click(); focus.show(focus.root); e.preventDefault(); }
      return;
    }
    if (app.state === 'play') {
      if (e.code === 'Escape') pause();
      else if (e.code === 'KeyR' && !e.repeat) { e.preventDefault(); restart(); }
      else if (e.code === 'KeyP' && DEBUG) window.__hypersurf.autopilot = !app.autopilot;
      else if (e.code === 'KeyZ' && DEBUG) { placeHud(); $('zone').toggleAttribute('hidden'); }
      else if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && app.live) setOctave(app.octave + (e.code === 'BracketLeft' ? -1 : 1));
      else if ((e.code === 'Minus' || e.code === 'Equal') && app.live) nudgeLatency(e.code === 'Minus' ? -1 : 1);
      else if (e.code === 'KeyV' && !e.repeat && app.live && app.live.yt) setVideoMode(app.settings.video === 'hidden' ? 'mini' : 'hidden');
      return;
    }
    if (!inText && e.code === 'KeyR' && !e.repeat && (app.state === 'paused' || app.state === 'results')) { e.preventDefault(); restart(); return; }
    if (!inText && e.code === 'KeyV' && !e.repeat && app.live && app.live.yt) { setVideoMode(app.settings.video === 'hidden' ? 'mini' : 'hidden'); return; }
    focus.key(e);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else app.redraw = 2;
  });
  window.addEventListener('resize', () => {
    if (app.view && app.view.gfx.renderer) app.view.resize();
    app.redraw = 2;
    app.zoneDue = true;
  });
  app.input.onPointerLockLost = pause;
  app.input.attach();
  // Clicking the view during play takes the pointer lock (browsers need a gesture).
  $('view').addEventListener('click', () => {
    if (app.state === 'play') app.input.requestLock();
  });

  // Initial state of the toggles.
  setMode(currentMode());
  setVehicle(app.settings.vehicle);
  setSfx(app.settings.sfx);
  setCalmVisuals(app.settings.calm);
  mini.setMode(app.settings.video);
  mini.setCorner(app.settings.corner);
  refreshSelectors();
}

/** Esc / B / BACK on a menu screen. */
function back(id) {
  if (id === 'settings') closeSettings();
  else if (id === 'video') { if (!app.busy) { leaveLive(); $('yt-input').value = ''; videoStatus(''); canStart(false); setState('menu'); } }
  else setState('menu');
}

function wireErrors() {
  window.addEventListener('error', (e) => stats.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => stats.errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));
}

async function boot() {
  wireErrors();
  wireUi();
  setState('menu');
  if (LIVE_DEMO) note('info', 'Live path test', '?live=demo: the demo plays through the live listening path, as a YouTube video would.');
  app.view = new GameView($('view'), { forceWebGL: params.get('webgl') === '1', quality: app.settings.quality, vehicle: app.settings.vehicle });
  app.view.onLost = onViewLost;
  app.view.onRestorable = onViewRestorable;
  // Right after a lost context (a reload, say) the browser may refuse a new one for a moment: try again.
  app.viewReady = withRetry(() => app.view.init()).then(() => {
    stats.backend = app.view.backend;
    stats.quality = app.view.gfx.qualityName;
    app.view.calm = app.settings.calm;
    app.view.gfx.renderer.setAnimationLoop(frame);
    if (STAGES[app.state]) STAGES[app.state].show(app.settings[app.state], app.view.gfx);
    return true;
  }, (err) => {
    console.warn('renderer unavailable', err);
    stats.errors.push(`renderer: ${err && err.message ? err.message : err}`);
    if (has3d()) offerReload('No 3D view', 'The browser is not giving this page a 3D view right now. Reload to try again.');
    else note('error', 'No 3D view', 'This browser cannot run the 3D view (it needs WebGPU or WebGL2).', { focus: false });
    return false;
  });
}

boot();
