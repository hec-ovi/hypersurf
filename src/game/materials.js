// TSL node materials. Everything is unlit and emissive-driven (neon on
// black); bloom picks up whatever goes above 1.0 in linear HDR. Colours
// follow docs/research.md §4: the intensity gradient for the track, rails
// and blocks; dark bodies with white rims for hazards; a white core with a
// chromatic halo for power blocks.

import * as THREE from 'three/webgpu';
import {
  attribute, uniform, uniformArray, vec3, vec4, float, int, abs, max, min, mix, smoothstep, fract, exp, pow, dot, normalize,
  fwidth, saturate, step, sin, cos, floor, length, cross, positionGeometry, normalView, positionViewDirection, cameraPosition, Fn,
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
    shock: uniform(0), // cash-in shockwave brightness 0..1
    shockTime: uniform(-1e9), // song time the shockwave left the ship
    debrisFlash: uniform(0), // air debris flash on hits 0..1
    speed: uniform(0), // ship speed m/s (debris streaks)
    trackFwd: uniform(new THREE.Vector3(0, 0, -1)), // track forward at the ship
  };
}

/** A hue wheel 0..1 → saturated linear RGB (cheap cosine palette). */
const hue = (h) => vec3(cos(h.mul(6.2832)), cos(h.mul(6.2832).sub(2.0944)), cos(h.mul(6.2832).add(2.0944))).mul(0.5).add(0.5);

/**
 * Track ribbon. Per vertex: aData = (lateral m, part + 0.25·inLoop, song
 * time, beat position) with part 0 surface, 1 rail, 2 underside and inLoop
 * 1 on loop nodes (it interpolates smoothly into and out of a loop);
 * aTint = (node colour, intensity).
 *
 * Surface: albedo #0A0C14 with a Fresnel rim, analytic lane lines (fwidth
 * AA), beat-locked chevrons in the centre lane, a highlight band 0.5 s
 * ahead (the timing window) and the beat pulse. Rails glow with intensity.
 * Loop sections are pre-lit: their rails and lines carry a travelling
 * rainbow chase bright enough to read through the fog from 600 m, so the
 * loop announces itself seconds before the drop. A cash-in shockwave runs
 * down the track as a bright band. The track behind the ship fades to 20%.
 */
export function trackMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial();
  const data = attribute('aData', 'vec4');
  const tint = attribute('aTint', 'vec4');
  m.colorNode = Fn(() => {
    const lat = data.x, tNode = data.z, beatPos = data.w;
    const part = floor(data.y);
    const inLoop = fract(data.y).mul(4);
    const col = tint.xyz, I = tint.w;
    const facing = abs(dot(normalView, positionViewDirection));
    // Fresnel sheen only at truly grazing angles (the far track); from the
    // low intense camera pose a softer power washed the near surface out.
    const rim = pow(float(1).sub(facing), 6);
    const pulse = u.beat.mul(0.6);

    // Lane dividers (±1.5) and shoulders (±4.5): analytic lines, fwidth anti-aliased.
    const aLat = abs(lat);
    const fw = max(fwidth(lat), 0.002);
    const line = (c, w) => saturate(float(1).sub(abs(aLat.sub(c)).sub(w).div(fw)));
    const lines = max(line(1.5, 0.05), line(4.5, 0.08));
    // Chevrons in the centre lane, one per beat, phase-locked to the grid.
    const v = fract(beatPos.sub(aLat.mul(0.16)));
    const chev = smoothstep(0, 0.03, v).mul(float(1).sub(smoothstep(0.08, 0.14, v))).mul(float(1).sub(smoothstep(0.9, 1.25, aLat)));
    // Faint beat rungs across the outer lanes: the grid the blocks sit on.
    const bf = fract(beatPos);
    const rung = smoothstep(0.985, 1, bf).add(float(1).sub(smoothstep(0, 0.01, bf))).mul(smoothstep(1.6, 2, aLat)).mul(float(1).sub(smoothstep(4.3, 4.5, aLat)));
    // A soft band 0.5 s ahead of the ship marks where blocks are about to be hit.
    const dtF = tNode.sub(u.time.add(0.5)).mul(10);
    const future = exp(dtF.mul(dtF).negate());
    // Cash-in shockwave: a band racing ahead of the ship (4 s of track per second).
    const front = u.shockTime.add(u.time.sub(u.shockTime).mul(4));
    const dS = tNode.sub(front).mul(5);
    const shock = exp(dS.mul(dS).negate()).mul(u.shock).mul(step(u.shockTime, tNode));
    // Loop foreshadowing: a rainbow chase, pre-lit at 30% of full glow.
    const chase = fract(beatPos.mul(2).sub(u.time.mul(1.5)));
    const loopCol = hue(fract(tNode.mul(0.35).add(lat.mul(0.04)).sub(u.time.mul(0.25))));
    const loopGlow = inLoop.mul(float(0.3).add(smoothstep(0.75, 1, chase).mul(0.7)));
    const lineCol = mix(col, loopCol, inLoop.mul(0.8));

    // Lines: research §4's gradient × (1 + 2·I), scaled to 0.7 so the
    // high-luminance yellows and greens do not flood the bloom.
    const glow = I.mul(1.4).add(0.7).mul(pulse.add(1));
    const surface = lin(PALETTE.trackSurface)
      .add(col.mul(rim.mul(0.45)))
      .add(lineCol.mul(lines.mul(glow.add(loopGlow.mul(4)))))
      .add(col.mul(chev.mul(pulse.mul(1.5).add(0.3))))
      .add(col.mul(rung.mul(0.08).mul(pulse.add(1))))
      .add(col.mul(future.mul(0.15)))
      .add(vec3(1).add(col).mul(shock.mul(lines.mul(3).add(0.35))));
    // Rails: a dim body with a neon tube along the top face (lateral 5.05;
    // the vertical faces sit at 4.7 and 5.4, so only the top carries it).
    // Research §4's gradient × (1.5 + 2.5·I) goes into the tube; spread over
    // the whole 0.7 m rail it washed the frame out under bloom near the camera.
    const tube = line(5.05, 0.06);
    const railBody = col.mul(I.mul(0.1).add(0.06));
    const railTube = col.mul(I.mul(2.5).add(1.5)).mul(tube);
    const rail = railBody.add(railTube).mul(pulse.mul(0.5).add(1))
      .add(loopCol.mul(loopGlow.mul(tube.mul(5).add(0.6))))
      .add(vec3(1).add(col).mul(shock.mul(tube.mul(3).add(0.3))))
      .mul(facing.mul(0.5).add(0.5));
    const under = lin(PALETTE.trackSurface).mul(2).add(col.mul(0.04)).add(loopCol.mul(loopGlow.mul(0.6)));
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

/**
 * Thruster flame: hot white at the nozzle, the track colour along the
 * plume, fading to nothing at the tip, with a fast flicker. `nozzle` and
 * `length` locate the cone along +z in geometry space.
 */
export function thrusterMaterial(u, nozzle, length) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.colorNode = Fn(() => {
    const f = saturate(float(1).sub(positionGeometry.z.sub(nozzle).div(length)));
    const flicker = sin(u.time.mul(90)).mul(0.08).add(sin(u.time.mul(37)).mul(0.07)).add(1);
    const plume = u.trackColor.mul(u.intensity.mul(1.2).add(1)).mul(f.mul(f));
    const core = vec3(0.7).mul(pow(f, 8));
    return plume.add(core).mul(flicker);
  })();
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
 * aSize = (width, height, depth below, seed). Heights react to the band's
 * level (× (1 + 2.5·E)). A quiet pillar is a dark silhouette with a few
 * lit windows; as its band gets loud, its top and vertical edges light up
 * in the track colour, tinted a little toward the band's own place on the
 * gradient so the skyline reads as a spectrum.
 */
export function pillarMaterial(u, lut) {
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
    const edge = smoothstep(0.9, 0.99, min(ax, az));
    const top = smoothstep(0.985, 1, g.y);
    const bandCol = lut.element(int(pos.w));
    const tintCol = mix(u.trackColor, bandCol, 0.35);
    // Windows: a 2 m × 3 m grid on the side faces, ~12% lit, per-pillar seed.
    const worldY = g.y.mul(size.z.add(height));
    const across = mix(g.x, g.z, step(ax, az)).add(0.5).mul(size.x);
    const cellX = floor(across.div(2)), cellY = floor(worldY.div(3));
    const h = fract(sin(cellX.mul(12.9898).add(cellY.mul(78.233)).add(size.w.mul(437.1))).mul(43758.5453));
    const inCell = step(0.3, fract(across.div(2))).mul(step(0.35, fract(worldY.div(3))));
    const side = float(1).sub(top);
    const windows = step(0.88, h).mul(inCell).mul(side).mul(smoothstep(0.25, 0.95, g.y)).mul(level.mul(0.12).add(0.035));
    const glow = top.mul(level.mul(2.8).add(0.1)).add(edge.mul(level.mul(0.9).add(0.03)));
    const body = smoothstep(0.55, 1, g.y).mul(0.012);
    return vec3(0.003, 0.004, 0.008).add(tintCol.mul(glow.add(body).add(windows)));
  })();
  return m;
}

/**
 * Rings around the track at its most intense nodes: flat annuli, additive,
 * coloured by the node's gradient colour (aInst.xyz) and flashing on the
 * (flash-limited) beat pulse. aInst.w fades a ring in at the far end.
 */
export function ringMaterial(u, inner, width) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const inst = attribute('aInst', 'vec4');
  m.colorNode = Fn(() => {
    // Brightest along the middle of the band, soft toward its edges.
    const x = length(positionGeometry.xy).sub(inner).div(width);
    const prof = float(1).sub(abs(x.mul(2).sub(1)));
    return inst.xyz.mul(u.beat.mul(1.6).add(0.7)).mul(inst.w).mul(prof.mul(prof).mul(0.8).add(0.2));
  })();
  return m;
}

/**
 * Air debris: instanced quads in a wrap-around volume centred on the
 * camera. aSeed = (unit position, phase). Particles are fixed in the world
 * (the volume wraps using the camera's float64 position mod V, passed as
 * `offset`), streak along the track as speed rises, and flash on hits.
 */
export function debrisMaterial(u, offset, volume) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const seed = attribute('aSeed', 'vec4');
  const local = fract(seed.xyz.sub(offset)).sub(0.5).mul(volume);
  const dist = length(local);
  m.positionNode = Fn(() => {
    const corner = positionGeometry.xy; // quad corners in [-0.5, 0.5]
    const centre = cameraPosition.add(local);
    const along = u.trackFwd;
    const toCam = normalize(cameraPosition.sub(centre));
    const across = normalize(cross(along, toCam));
    const len = u.speed.mul(0.018).add(0.12);
    return centre.add(along.mul(corner.y.mul(len))).add(across.mul(corner.x.mul(0.07)));
  })();
  m.colorNode = Fn(() => {
    // Fade in from the far edge of the volume and out right at the camera.
    const fade = smoothstep(4, 12, dist).mul(float(1).sub(smoothstep(volume * 0.3, volume * 0.5, dist)));
    const twinkle = sin(seed.w.mul(40).add(u.time.mul(3))).mul(0.3).add(0.7);
    const c = u.trackColor.mul(0.35).add(vec3(u.debrisFlash.mul(2.5)));
    return c.mul(fade).mul(twinkle).mul(u.intensity.mul(0.8).add(0.4));
  })();
  return m;
}
