// Renderer, post chain and dynamic resolution.
//
// WebGPURenderer picks WebGPU when available and falls back to its WebGL2
// backend on its own (?webgl=1 forces the fallback for testing). The scene
// renders into a half-float pass, then bloom, desaturation and vignette are
// composed in TSL and tone-mapped (PBR Neutral) by the render pipeline.

import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, float, mix, luminance, screenUV, smoothstep, Fn } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/** Quality presets: MSAA samples, bloom and the resolution range. */
export const QUALITY = Object.freeze({
  high: Object.freeze({ samples: 4, bloom: true, maxRatio: 2, minScale: 0.6 }),
  medium: Object.freeze({ samples: 0, bloom: true, maxRatio: 1.25, minScale: 0.6 }),
  low: Object.freeze({ samples: 0, bloom: false, maxRatio: 1, minScale: 0.5 }),
});

export class Renderer {
  constructor(canvas, { forceWebGL = false, quality = 'high' } = {}) {
    this.canvas = canvas;
    this.forceWebGL = forceWebGL;
    this.qualityName = QUALITY[quality] ? quality : 'high';
    this.quality = QUALITY[this.qualityName];
    this.renderer = null;
    this.pipeline = null;
    this.backend = 'none';
    this.scale = 1; // dynamic resolution factor
    this.frameMsEma = 16.7;
    this._lastScaleChange = 0;
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
    await renderer.init();
    this.renderer = renderer;
    this.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    // The WebGL2 fallback is the low tier: no MSAA on the pass, cheaper bloom.
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
    const scenePass = pass(scene, camera, { samples: this.quality.samples });
    const color = scenePass.getTextureNode('output');
    let lit = color;
    if (this.quality.bloom) {
      const glow = bloom(color, 1, 0.45, 1);
      glow.strength = this.bloomStrength;
      lit = color.add(glow);
    }
    const sat = this.saturation, vig = this.vignette;
    const out = Fn(() => {
      const c = lit.rgb;
      const grey = vec3(luminance(c));
      const d = screenUV.sub(0.5).length();
      const v = float(1).sub(vig.mul(smoothstep(0.25, 0.8, d)));
      return vec4(mix(grey, c, sat).mul(v), 1);
    })();
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = out;
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.scale = 1;
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
    return Math.min(window.devicePixelRatio || 1, this.quality.maxRatio) * this.scale;
  }

  /** Compile every pipeline before play so the first frames do not hitch. */
  async compile() {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  render() {
    this.pipeline.render();
  }

  /**
   * Dynamic resolution from the frame-time average. The display's frame
   * interval is estimated as the fastest sustained average (it drifts up
   * slowly so a refresh-rate change is followed). Step down when frames run
   * 30% over it; step back up only after 8 s at full rate, so the scale does
   * not oscillate. Every change reallocates the render targets.
   */
  adapt(frameMs, nowMs) {
    if (!(frameMs > 0 && frameMs < 250)) return; // tab switches, breakpoints
    this.frameMsEma += (frameMs - this.frameMsEma) * 0.05;
    this.refreshMs = Math.min((this.refreshMs || this.frameMsEma) + 0.002, this.frameMsEma);
    const since = nowMs - this._lastScaleChange;
    if (since < 2000) return;
    const min = this.quality.minScale;
    let next = this.scale;
    if (this.frameMsEma > this.refreshMs * 1.3 + 1 && this.scale > min) next = Math.max(min, this.scale - 0.1);
    else if (this.frameMsEma < this.refreshMs * 1.1 && this.scale < 1 && since > 8000) next = Math.min(1, this.scale + 0.1);
    if (next !== this.scale) {
      this.scale = next;
      this._lastScaleChange = nowMs;
      this.renderer.setPixelRatio(this.pixelRatio());
    }
  }

  /** Reset the frame-time history after a pause or a state change. */
  resetTiming(nowMs) {
    this.frameMsEma = this.refreshMs || 16.7;
    this._lastScaleChange = nowMs;
  }

  get info() {
    return this.renderer.info.render;
  }
}
