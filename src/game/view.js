// The 3D view of a run: renderer, scene, track, blocks, ship, world and the
// chase camera, all driven from song time. Positions are computed in
// float64 and written relative to a floating origin that re-bases every
// 500 m, so float32 stays precise kilometres down the track.

import * as THREE from 'three/webgpu';
import { Renderer } from './render.js';
import { createUniforms, trackMaterial } from './materials.js';
import { TrackMesh } from './track.js';
import { BlockField } from './blocks.js';
import { Ship } from './ship.js';
import { ChaseCamera } from './camera.js';
import { World } from './world.js';
import { TrackPath, makeSample, nodeBeats } from './trackpath.js';
import { hexToLinear, PALETTE } from './palette.js';
import { MODES } from '../audio/songmap.js';

export const DRAW_DISTANCE = 650;
const REBASE_DISTANCE = 500;
const SHIP_HOVER = 0.55;

export class GameView {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.gfx = new Renderer(canvas, options);
    this.uniforms = createUniforms();
    this.origin = { x: 0, y: 0, z: 0 };
    this.sample = makeSample();
    this.path = null;
    this.map = null;
    this.intensity = 0;
    this.speed01 = 0;
    this._calm = false;
    this.compiled = false;
    this.rebases = 0;
  }

  async init() {
    await this.gfx.init();
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
    this.ship = new Ship(scene, this.uniforms);
    this.world = new World(scene, this.uniforms, this.gfx.quality);
    this.chase = new ChaseCamera(camera);
    this.gfx.setScene(scene, camera);
    this.gfx.resize();
    return this;
  }

  get backend() {
    return this.gfx.backend;
  }

  setQuality(name) {
    this.gfx.setQuality(name);
    this.world.setBudget(this.gfx.quality);
  }

  /** Calm visuals: no speed blur or aberration, a steadier bloom. */
  set calm(on) {
    this._calm = !!on;
  }

  /** Show a new SongMap. */
  load(map) {
    this.map = map;
    this.path = new TrackPath(map.nodes);
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

    // Post: bloom with intensity and bursts; radial speed blur above 60% of
    // the mode's speed range (AS2's formula with speed for camera bias), off
    // in loops except for the power-block punch; aberration with I².
    const gfx = this.gfx;
    const mode = MODES[this.map.mode] || MODES.mono;
    this.speed01 = Math.min(1, Math.max(0, (s.speed - mode.speedMin) / (mode.speedMax - mode.speedMin)));
    // Calm visuals: no lens effects at all, and bloom that swings less with I.
    const calm = this._calm;
    const speedBlur = s.loop ? 0 : Math.min(1.5, Math.max(0, (this.speed01 - 0.6) * 5)) * 0.012;
    const punch = juice ? juice.lens * 0.018 : 0;
    gfx.blur.value = calm ? 0 : Math.max(speedBlur, punch) * Math.min(1, swoop * 2);
    gfx.aberration.value = calm ? 0 : 0.003 * I * I + (juice ? juice.lens * 0.003 : 0);
    gfx.bloomStrength.value = 0.5 + (calm ? 0.25 : 0.5) * I + (juice ? juice.bloom : 0);
    gfx.saturation.value = 1 - 0.6 * (juice ? juice.desaturate : 0);

    const tAhead = this.path.timeAtDistance(s.dist + DRAW_DISTANCE);
    this.track.update(s.dist, this.origin);
    this.blocks.update(t, tAhead, state, this.origin, wall);
    this.ship.place(s, shipX, vx, this.origin, SHIP_HOVER);
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
