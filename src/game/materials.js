// TSL node materials. Everything is unlit and emissive-driven (neon on
// black); bloom picks up whatever goes above 1.0 in linear HDR. Colours
// follow docs/research.md §4: the intensity gradient for the track, rails
// and blocks; dark bodies with white rims for hazards; a white core with a
// chromatic halo for power blocks.

import * as THREE from 'three/webgpu';
import {
  attribute, uniform, uniformArray, vec3, vec4, float, int, abs, max, min, mix, smoothstep, fract, exp, pow, dot, normalize,
  fwidth, saturate, step, sin, cos, floor, length, positionGeometry, normalView, positionViewDirection, Fn,
} from 'three/tsl';
import { hexToLinear, PALETTE } from './palette.js';

const lin = (hex) => vec3(...hexToLinear(hex));

/** Uniforms shared by every material; the game writes them once per frame. */
export function createUniforms() {
  return {
    time: uniform(0), // song time, seconds
    beat: uniform(0), // beat pulse 0..1 (flash-limited)
    intensity: uniform(0), // smoothed intensity at the ship
    trackColor: uniform(new THREE.Color(0.1, 0.4, 1)), // gradient(I) at the ship, linear
    shipFlash: uniform(0),
    starPhase: uniform(0), // ∫ I dt, drives the star drift
    bands: uniformArray(new Array(16).fill(0), 'float'), // skyline band levels 0..1
  };
}

/**
 * Track ribbon. Per vertex: aData = (lateral m, part, song time, beat
 * position) with part 0 surface, 1 rail, 2 underside; aTint = (node colour,
 * intensity).
 */
export function trackMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial();
  const data = attribute('aData', 'vec4');
  const tint = attribute('aTint', 'vec4');
  m.colorNode = Fn(() => {
    const lat = data.x, part = data.y, tNode = data.z, beatPos = data.w;
    const col = tint.xyz, I = tint.w;
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 3);
    const pulse = u.beat.mul(0.6);

    // Lane dividers (±1.5) and shoulders (±4.5): analytic lines, fwidth anti-aliased.
    const aLat = abs(lat);
    const fw = max(fwidth(lat), 0.002);
    const line = (c, w) => saturate(float(1).sub(abs(aLat.sub(c)).sub(w).div(fw)));
    const lines = max(line(1.5, 0.05), line(4.5, 0.08));
    // Chevrons in the centre lane, one per beat, phase-locked to the grid.
    const v = fract(beatPos.sub(aLat.mul(0.16)));
    const chev = smoothstep(0, 0.03, v).mul(float(1).sub(smoothstep(0.08, 0.14, v))).mul(float(1).sub(smoothstep(0.9, 1.25, aLat)));
    // A soft band 0.5 s ahead of the ship marks where blocks are about to be hit.
    const dtF = tNode.sub(u.time.add(0.5)).mul(10);
    const future = exp(dtF.mul(dtF).negate());

    const glow = I.mul(2).add(1).mul(pulse.add(1));
    const surface = lin(PALETTE.trackSurface)
      .add(col.mul(rim.mul(0.6)))
      .add(col.mul(lines.mul(glow)))
      .add(col.mul(chev.mul(pulse.mul(1.5).add(0.3))))
      .add(col.mul(future.mul(0.15)));
    // Rails: research §4 asks for gradient × (1.5 + 2.5·I); at 0.7 m wide and
    // close to the camera that washed out under bloom, so they run at ~60%.
    const rail = col.mul(I.mul(1.5).add(0.9)).mul(pulse.mul(0.5).add(1)).mul(facing.mul(0.5).add(0.5));
    const under = lin(PALETTE.trackSurface).mul(2).add(col.mul(0.04));
    const isRail = step(0.5, part).mul(step(part, 1.5));
    const isUnder = step(1.5, part);
    const isSurface = float(1).sub(step(0.5, part));
    // The track behind the ship fades to 20%.
    const fade = mix(float(1), float(0.2), saturate(u.time.sub(tNode).mul(1.5)));
    return surface.mul(isSurface).add(rail.mul(isRail)).add(under.mul(isUnder)).mul(fade);
  })();
  return m;
}

/**
 * Colour blocks: instanced boxes with glowing edges. aInst = (HDR tint, flash).
 * `half` is the box's half size, so edges can be found from the geometry.
 */
export function blockMaterial(half) {
  const m = new THREE.MeshBasicNodeMaterial();
  const inst = attribute('aInst', 'vec4');
  m.colorNode = Fn(() => {
    const p = abs(positionGeometry.div(vec3(...half)));
    const hi = max(max(p.x, p.y), p.z), lo = min(min(p.x, p.y), p.z);
    const second = p.x.add(p.y).add(p.z).sub(hi).sub(lo);
    const edge = smoothstep(0.7, 0.93, second);
    return inst.xyz.mul(edge.mul(1.4).add(0.3)).add(vec3(inst.w.mul(3)));
  })();
  return m;
}

/** Greys and spikes: dark body, white rim (kept below 1.5× the bloom threshold). */
export function hazardMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  const inst = attribute('aInst', 'vec4');
  m.colorNode = Fn(() => {
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 2);
    return lin(PALETTE.hazardBody).add(lin(PALETTE.hazardRim).mul(rim.mul(1.25))).add(vec3(inst.w.mul(2)));
  })();
  return m;
}

/** Power blocks: white core × 6 with a chromatic halo at the rim. */
export function powerMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = float(1).sub(facing);
    const hue = rim.mul(7);
    const halo = vec3(sin(hue).mul(0.5).add(0.5), sin(hue.add(2.1)).mul(0.5).add(0.5), sin(hue.add(4.2)).mul(0.5).add(0.5));
    return mix(vec3(6), halo.mul(4), smoothstep(0.35, 0.9, rim));
  })();
  return m;
}

/** Flat instanced strips (chain spans) and shards: plain HDR tint. */
export function tintMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  const inst = attribute('aInst', 'vec4');
  m.colorNode = inst.xyz.mul(inst.w);
  return m;
}

/** Ship hull: dark with a gradient-coloured rim; flashes white on hits. */
export function shipMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.colorNode = Fn(() => {
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 2);
    return vec3(0.012, 0.014, 0.02).add(u.trackColor.mul(rim.mul(2.2))).add(vec3(u.shipFlash.mul(2.5)));
  })();
  return m;
}

export function thrusterMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.colorNode = u.trackColor.mul(u.intensity.mul(3).add(3)).add(vec3(1.5));
  return m;
}

/** Sky dome around the camera: black to a violet horizon band, with drifting stars. */
export function skyMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
  m.colorNode = Fn(() => {
    const dir = normalize(positionGeometry);
    const band = exp(abs(dir.y).mul(-7));
    const horizon = mix(lin(PALETTE.horizon), lin(PALETTE.horizon).mul(u.trackColor.mul(2)), 0.25);
    const sky = mix(lin(PALETTE.background), horizon, band);
    // Stars: one candidate per cell of a direction grid, rotated by ∫ I dt.
    const c = cos(u.starPhase), s = sin(u.starPhase);
    const d = vec3(dir.x.mul(c).sub(dir.z.mul(s)), dir.y, dir.x.mul(s).add(dir.z.mul(c))).mul(160);
    const cell = floor(d);
    const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const f = length(fract(d).sub(0.5));
    const star = step(0.993, h).mul(float(1).sub(smoothstep(0.05, 0.3, f))).mul(float(1).sub(band)).mul(h.sub(0.993).mul(300).add(0.4));
    return sky.add(vec3(star));
  })();
  return m;
}

/**
 * Skyline pillars, instanced without matrices: aPos = (x, y, z, band) and
 * aSize = (width, height, depth below, phase). Heights react to the band's
 * level (× (1 + 2.5·E)); tops and vertical edges glow in the track colour.
 */
export function pillarMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial();
  const pos = attribute('aPos', 'vec4');
  const size = attribute('aSize', 'vec4');
  const level = u.bands.element(int(pos.w));
  const height = size.y.mul(level.mul(2.5).add(1));
  m.positionNode = Fn(() => {
    const g = positionGeometry; // unit box with its base at y = 0
    const y = g.y.mul(size.z.add(height)).sub(size.z);
    return vec3(g.x.mul(size.x), y, g.z.mul(size.x)).add(pos.xyz);
  })();
  m.colorNode = Fn(() => {
    const g = positionGeometry;
    const ax = abs(g.x).mul(2), az = abs(g.z).mul(2);
    const edge = smoothstep(0.86, 0.98, min(ax, az));
    const top = smoothstep(0.985, 1, g.y);
    const glow = top.mul(level.mul(2.5).add(0.6)).add(edge.mul(level.mul(0.8).add(0.08)));
    // A faint wash up the upper body so pillars read as buildings, not floating tops.
    const body = smoothstep(0.55, 1, g.y).mul(0.05);
    return vec3(0.004, 0.005, 0.01).add(u.trackColor.mul(glow.add(body)));
  })();
  return m;
}
