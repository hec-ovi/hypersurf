// The 3D view of a run: renderer, scene, track, blocks, vehicle, world and the
// chase camera, all driven from song time. Positions are computed in
// float64 and written relative to a floating origin that re-bases every
// 500 m, so float32 stays precise kilometres down the track.
//
// A lost GPU context (webglcontextlost, or the WebGPU device's lost promise)
// sets `lost` and calls onLost; once the context can be had again
// (webglcontextrestored, or at once for WebGPU, which takes a new device)
// it calls onRestorable, and rebuild() makes the renderer, the scene and
// the post chain again through the same init path.

import * as THREE from 'three/webgpu';
import { Renderer } from './render.js';
import { createUniforms, trackMaterial } from './materials.js';
import { TrackMesh } from './track.js';
import { BlockField } from './blocks.js';
import { createVehicle, vehicleId } from './vehicles/index.js';
import { ChaseCamera } from './camera.js';
import { World } from './world.js';
import { TrackPath, makeSample, nodeBeats } from './trackpath.js';
import { hexToLinear, PALETTE } from './palette.js';
import { makeGrid, gridPosition } from '../audio/songmap.js';

export const DRAW_DISTANCE = 650;
const REBASE_DISTANCE = 500;
const SHIP_HOVER = 0.55;

export class GameView {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.gfx = new Renderer(canvas, options);
    this.uniforms = createUniforms();
    this.origin = { x: 0, y: 0, z: 0 };
    this.sample = makeSample();
    this.path = null;
    this.map = null;
    this.intensity = 0;
    this._calm = false;
    this.compiled = false;
    this.rebases = 0;
    this.vehicleId = vehicleId(options.vehicle);
    this.beatGrid = null;
    this.lost = false;
    this.onLost = null;
    this.onRestorable = null;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // without this the browser never restores the context
      this._lose();
    });
    canvas.addEventListener('webglcontextrestored', () => this._restorable());
  }

  /** Build the renderer and the scene. Safe to call again after a failure: every call starts a fresh renderer. */
  async init() {
    const gfx = new Renderer(this.canvas, this.options);
    this.gfx = gfx;
    // WebGL losses arrive as canvas events (above); a WebGPU device never comes back, so take a new one at once.
    gfx.onLost = (info) => {
      if (info.api !== 'WebGPU' || gfx !== this.gfx) return;
      this._lose();
      this._restorable();
    };
    await gfx.init();
    const scene = new THREE.Scene();
    const bg = hexToLinear(PALETTE.background);
    scene.background = new THREE.Color().setRGB(bg[0], bg[1], bg[2], THREE.LinearSRGBColorSpace);
    const fog = hexToLinear(PALETTE.fog);
    scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(fog[0], fog[1], fog[2], THREE.LinearSRGBColorSpace), 0.0018);
    const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 2000);
    this.scene = scene;
    this.camera = camera;
    this.track = new TrackMesh(scene, trackMaterial(this.uniforms));
    this.blocks = new BlockField(scene);
    this.ship = null;
    this._makeVehicle();
    this.world = new World(scene, this.uniforms, this.gfx.quality);
    this.chase = new ChaseCamera(camera);
    this.gfx.setScene(scene, camera);
    this.gfx.resize();
    return this;
  }

  _lose() {
    if (this.lost) return;
    this.lost = true;
    if (this.onLost) this.onLost();
  }

  _restorable() {
    if (this.lost && this.onRestorable) this.onRestorable();
  }

  /**
   * After a lost context: a new renderer, scene, materials, buffers and post
   * chain, with the current map loaded again. The caller resets the view to
   * its song time and compiles again (compile()).
   */
  async rebuild() {
    const old = this.gfx, map = this.map;
    if (old) {
      try { old.abandon(); } catch { /* its context is gone */ }
      this.options = { ...this.options, quality: old.qualityName };
    }
    this.compiled = false;
    await this.init(); // throws with the map kept, so a retry loads it again
    if (map) this.load(map);
    this.lost = false;
  }

  _makeVehicle() {
    this.ship = createVehicle(this.vehicleId, this.scene, this.uniforms);
    if ('camera' in this.ship) this.ship.camera = this.camera;
  }

  /** Swap the vehicle (a look only: the ship's motion and collision do not change). */
  setVehicle(id) {
    const next = vehicleId(id);
    if (next === this.vehicleId) return;
    this.vehicleId = next;
    if (!this.ship) return; // not built yet: init() makes this one
    this.ship.dispose();
    this._makeVehicle();
    // Compile its pipelines now rather than on its first frame in play.
    if (this.compiled) this.gfx.compile().catch(() => {});
  }

  get backend() {
    return this.gfx.backend;
  }

  setQuality(name) {
    this.gfx.setQuality(name);
    this.world.setBudget(this.gfx.quality);
  }

  /** Calm visuals: a steadier bloom. */
  set calm(on) {
    this._calm = !!on;
  }

  /** Show a new SongMap. */
  load(map) {
    this.map = map;
    this.path = new TrackPath(map.nodes);
    this.beatGrid = map.live ? null : makeGrid(map.beats, map.bpm, map.duration);
    this.track.load(map, nodeBeats(map));
    this.blocks.load(map, this.path);
    this.world.load(map);
  }

  /** Put everything at the start of the lead-in. */
  reset(t) {
    const s = this.path.sample(t, this.sample);
    this.origin.x = s.px; this.origin.y = s.py; this.origin.z = s.pz;
    this.chase.reset(s);
    this.blocks.reset();
    this.intensity = s.intensity;
    this.uniforms.starPhase.value = 0;
    this.world.load(this.map);
  }

  /** Compile every pipeline before the swoop, so the first frames do not hitch. */
  async compile(state) {
    const meshes = [this.blocks.colour, this.blocks.hazard, this.blocks.power, this.blocks.span, this.blocks.shard, this.world.rings];
    const counts = meshes.map((m) => m.count);
    for (const m of meshes) m.count = 1;
    this.frame(this.path.t0, 0, 0, 0, 0, state, null, 0);
    try {
      // The WebGL2 backend polls compile status on animation frames, which
      // stop in a hidden tab; never let loading hang on it. Anything not
      // compiled by then compiles on first use.
      await Promise.race([this.gfx.compile(), new Promise((resolve) => setTimeout(resolve, 4000))]);
      // The post chain's own passes compile on their first render: do it
      // now, behind the loading screen.
      this.gfx.render();
    } finally {
      meshes.forEach((m, i) => { m.count = counts[i]; });
    }
    this.compiled = true;
  }

  /**
   * Draw song time t.
   * @param dt     frame seconds; wall: wall-clock seconds (animation)
   * @param shipX  lateral ship position; vx its velocity
   * @param state  rules block states
   * @param juice  Juice envelopes (or null)
   * @param swoop  0 → 1 over the swoop-in
   */
  frame(t, dt, wall, shipX, vx, state, juice, swoop) {
    const map = this.map;
    if (map.live && map.changedFrom < Infinity) {
      // The live map rewrote nodes (its provisional tail) since the last frame.
      this.track.invalidate(map.changedFrom);
      this.world.invalidate(map.changedFrom);
      map.changedFrom = Infinity;
    }
    const s = this.path.sample(t, this.sample);
    // Floating origin.
    const ox = s.px - this.origin.x, oy = s.py - this.origin.y, oz = s.pz - this.origin.z;
    let rebased = false;
    if (ox * ox + oy * oy + oz * oz > REBASE_DISTANCE * REBASE_DISTANCE) {
      this.origin.x = s.px; this.origin.y = s.py; this.origin.z = s.pz;
      rebased = true;
      this.rebases++;
    }
    this.intensity += (s.intensity - this.intensity) * (1 - Math.exp(-dt / 0.5));
    const I = this.intensity;

    const u = this.uniforms;
    u.time.value = t;
    u.intensity.value = I;
    u.trackColor.value.setRGB(s.r, s.g, s.b);
    u.beat.value = juice ? juice.beat : 0;
    u.shipFlash.value = juice ? juice.ship : 0;
    u.shock.value = juice ? juice.shock : 0;
    u.shockTime.value = juice ? juice.shockTime : -1e9;
    u.debrisFlash.value = juice ? juice.debris : 0;
    u.speed.value = s.speed;
    u.trackFwd.value.set(s.fx, s.fy, s.fz);
    u.starPhase.value += I * dt * 0.03;

    // Post: bloom with intensity and bursts, swinging less under calm visuals.
    const gfx = this.gfx;
    const calm = this._calm;
    gfx.bloomStrength.value = 0.5 + (calm ? 0.25 : 0.5) * I + (juice ? juice.bloom : 0);
    gfx.saturation.value = 1 - 0.6 * (juice ? juice.desaturate : 0);

    const tAhead = this.path.timeAtDistance(s.dist + DRAW_DISTANCE);
    this.track.update(s.dist, this.origin);
    this.blocks.update(t, tAhead, state, this.origin, wall);
    this.ship.place(s, shipX, vx, this.origin, SHIP_HOVER);
    const beat = map.live ? map.beatAt(t) : gridPosition(this.beatGrid, t);
    this.ship.update(dt, t, beat - Math.floor(beat), I);
    this.chase.update(dt, s, shipX, vx, I, swoop, juice, this.origin);
    this.world.update(Math.round(this.path.indexAt(t)), t, tAhead, dt, this.origin, rebased, this.camera);
  }

  render() {
    this.gfx.render();
  }

  resize() {
    this.gfx.resize();
  }
}
