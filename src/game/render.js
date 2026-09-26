// Renderer, post chain and dynamic resolution.
//
// WebGPURenderer picks WebGPU when available and falls back to its WebGL2
// backend on its own (?webgl=1 forces the fallback for testing). The post
// chain (docs/research.md §4), all in TSL:
//   scene pass (MSAA on the high tier)
//   → + bloom (half resolution, quarter on the low tier), strength driven
//     by intensity and impact bursts
//   → desaturation (grey hits) and vignette
//   → tone mapping (PBR Neutral) and sRGB, done here rather than by the
//     pipeline so FXAA can run on display-referred colour
//   → FXAA where there is no MSAA.

import * as THREE from 'three/webgpu';
import { pass, uniform, vec2, vec3, vec4, float, mix, luminance, screenUV, smoothstep, Fn, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ResolutionGovernor } from './resolution.js';

/**
 * Quality tiers. high: WebGPU with 4× MSAA. medium: the WebGL2 default,
 * FXAA instead of MSAA. low: research §4's fallback tier (quarter-res
 * bloom, 400 pillars, 1k debris); the game
 * drops to it on its own when dynamic resolution bottoms out.
 */
export const QUALITY = Object.freeze({
  high: Object.freeze({ samples: 4, fxaa: false, bloom: true, bloomScale: 0.5, pillars: 1152, debris: 4096, maxRatio: 2, minScale: 0.6 }),
  medium: Object.freeze({ samples: 0, fxaa: true, bloom: true, bloomScale: 0.5, pillars: 1152, debris: 4096, maxRatio: 1.25, minScale: 0.6 }),
  low: Object.freeze({ samples: 0, fxaa: true, bloom: true, bloomScale: 0.25, pillars: 384, debris: 1024, maxRatio: 1, minScale: 0.5 }),
});

// Research §4 has radius 0.45. In three's BloomNode the radius flattens the
// mip weights toward the widest levels; with this many bright lines on
// screen that laid a coloured veil over the whole frame. 0 keeps the glow
// tight around its sources (mip weights 1, 0.8, 0.6, 0.4, 0.2).
const BLOOM_RADIUS = 0;
const BLOOM_MIP_GAIN = [1, 1, 0.75, 0.4, 0.15];

export class Renderer {
  constructor(canvas, { forceWebGL = false, quality = 'high' } = {}) {
    this.canvas = canvas;
    this.forceWebGL = forceWebGL;
    this.qualityName = QUALITY[quality] ? quality : 'high';
    this.quality = QUALITY[this.qualityName];
    this.renderer = null;
    this.pipeline = null;
    this.onLost = null; // (info: { api, message }) on a lost context or device
    this.backend = 'none';
    this.governor = new ResolutionGovernor({ minScale: this.quality.minScale });
    this.width = 1;
    this.height = 1;
    // Post uniforms, driven by the game each frame.
    this.bloomStrength = uniform(0.55);
    this.saturation = uniform(1);
    this.vignette = uniform(0.28);
  }

  async init() {
    const renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      antialias: false,
      forceWebGL: this.forceWebGL,
      powerPreference: 'high-performance',
    });
    // Khronos PBR Neutral rather than AgX: AgX lifted the near-black
    // background and fog to a visible grey and bleached the neon hues;
    // Neutral leaves colours below its shoulder as designed and only
    // compresses the bloom-range highlights.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.onDeviceLost = (info) => {
      renderer._onDeviceLost(info);
      if (this.onLost) this.onLost(info);
    };
    await renderer.init();
    this.renderer = renderer;
    this.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    // The WebGL2 backend gets no MSAA on the scene pass: FXAA instead.
    if (this.backend === 'webgl2' && this.qualityName === 'high') {
      this.qualityName = 'medium';
      this.quality = QUALITY.medium;
    }
    this.resize();
    return this;
  }

  /** Build the post chain for a scene and camera. */
  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    if (this.pipeline) this.pipeline.dispose();
    const q = this.quality;
    const scenePass = pass(scene, camera, { samples: q.samples });
    const color = scenePass.getTextureNode('output');

    let lit = color;
    if (q.bloom) {
      const glow = bloom(color, 1, BLOOM_RADIUS, 1);
      glow.strength = this.bloomStrength;
      glow.setResolutionScale(q.bloomScale);
      // Damp the widest mips: they spread every bright line into a veil.
      BLOOM_MIP_GAIN.forEach((g, i) => glow.bloomTintColors[i].setScalar(g));
      lit = color.add(glow);
    }
    const sat = this.saturation, vig = this.vignette;
    const graded = Fn(() => {
      const c = lit.rgb;
      const grey = vec3(luminance(c));
      const d = screenUV.sub(0.5).mul(vec2(1.1, 1)).length();
      const v = float(1).sub(vig.mul(smoothstep(0.25, 0.85, d)));
      return vec4(mix(grey, c, sat).mul(v), 1);
    })();
    const display = renderOutput(graded);
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = q.fxaa ? fxaa(display) : display;
  }

  /**
   * Let go of a renderer whose context or device was lost. Its GPU objects
   * died with the context. A WebGPU renderer is disposed; a WebGL one is
   * only stopped, because three's WebGL dispose() calls loseContext() and
   * would take the restored context down with it.
   */
  abandon() {
    const r = this.renderer;
    this.renderer = null;
    this.pipeline = null;
    if (!r) return;
    r.setAnimationLoop(null);
    if (this.backend === 'webgpu') r.dispose();
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.governor.minScale = this.quality.minScale;
    this.governor.scale = 1;
    this.resize();
    if (this.scene) this.setScene(this.scene, this.camera);
  }

  resize() {
    const r = this.renderer;
    if (!r) return;
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.width = w;
    this.height = h;
    r.setPixelRatio(this.pixelRatio());
    r.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, this.quality.maxRatio) * this.governor.scale;
  }

  /** Compile every pipeline before play so the first frames do not hitch. */
  async compile() {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  render() {
    this.pipeline.render();
  }

  /** Advance the node frame the way the animation loop does, so scene passes redraw. */
  nextFrame() {
    const r = this.renderer;
    r.info.reset();
    r._nodes.nodeFrame.update();
    r.info.frame = r._nodes.nodeFrame.frameId;
  }

  /** Wait until the GPU has finished the frames submitted so far. */
  async finish() {
    const backend = this.renderer.backend;
    if (backend.device) {
      await backend.device.queue.onSubmittedWorkDone();
      return;
    }
    const gl = backend.gl;
    if (!gl) return;
    // A 1-pixel readback blocks until the frame is drawn.
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._px || (this._px = new Uint8Array(4)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  }

  /**
   * Median GPU-synced cost (ms) of `frames` renders of the current scene at
   * full scale, after `warmup` renders that absorb first-use compiles.
   */
  async probe(frames = 12, warmup = 3) {
    const scale = this.governor.scale;
    this.governor.scale = 1;
    this.renderer.setPixelRatio(this.pixelRatio());
    const times = new Float64Array(frames);
    for (let i = 0; i < warmup + frames; i++) {
      this.nextFrame();
      const a = performance.now();
      this.render();
      await this.finish();
      if (i >= warmup) times[i - warmup] = performance.now() - a;
    }
    this.governor.scale = scale;
    this.renderer.setPixelRatio(this.pixelRatio());
    times.sort();
    return times[frames >> 1];
  }

  /** Dynamic resolution: feed the frame interval; the pixel ratio follows the governor. */
  adapt(frameMs, nowMs) {
    if (this.governor.update(frameMs, nowMs)) this.renderer.setPixelRatio(this.pixelRatio());
  }

  /** Reset the frame-time history after a pause or a state change. */
  resetTiming(nowMs) {
    this.governor.reset(nowMs);
  }

  get info() {
    return this.renderer.info.render;
  }
}
