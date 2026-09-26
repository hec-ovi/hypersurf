// WAVE: a neon hover-surfboard. A slim board with a strong nose rocker and a little tail
// kick; a pointed nose whose half is the narrow half (widest point at 47 % of the length);
// full hips and a wide swallow tail (a 34 cm notch, the one shape that says "surfboard" at
// 80 px from the chase camera); a canted, toed-in tri-fin cluster of tinted glass ahead of the
// notch; a neon rail line all the way round the outline and the notch, fine at the nose and
// fuller at the tail, with a white-hot core along its world-space top; a glowing belly; and a
// low faceted teardrop lens inlaid in the deck, whose tail runs on as a light-pipe into the
// stringer. The deck graphic: a stringer from the nose to the tail pad, one forward-pointing
// chevron, a pair of rail bands 6 cm inside the rail, and a solid lit traction pad filling
// the tail with a raised kick bar ahead of the notch. On the beat the board heaves and lifts
// its nose a touch, the rail swells and the pad pulses. Behind it the hover field pushes the
// track surface into a carved V-wake of light that grows out of the rails' rear quarter, with
// a soft crest band that brightens on the beat, and foam thrown off the crests.
//
// Two draw calls:
//   board  one opaque mesh (deck, belly, rail line, fins, lens, collar, kick bar),
//          parts told apart by a per-vertex attribute; unlit like the rest of
//          the game, with a camera-relative key light so it reads from every side
//   wake   one premultiplied-blend mesh: a soft board-shaped glow on the track
//          under the belly, the two curling wake walls and 96 spray streaks,
//          all placed in the vertex shader from a handful of uniforms, so
//          nothing is written per frame but those
//
// The group carries the unbanked track frame (so the wake lies flat on the
// track); the board inside it yaws and banks with lateral velocity. Every
// solid piece is a closed, outward-facing shell.

import * as THREE from 'three/webgpu';
import {
  attribute, uniform, uniformArray, vec3, vec4, float, int, abs, max, min, mix, smoothstep, fract, exp, pow, dot,
  normalize, saturate, step, sin, cos, floor, length, fwidth, sqrt, normalView, normalWorld, normalFlat, positionViewDirection,
  positionGeometry, normalGeometry, modelViewMatrix, cameraProjectionMatrix, Fn, varying, dFdx, dFdy, cross,
} from 'three/tsl';

// ---- Board dimensions (metres; forward is -z) ----
// 3.44 m plus the rail tube keeps the board inside the 3.5 m footprint.
const LEN = 3.44;
const Z_NOSE = -1.8;
const Z_TAIL = Z_NOSE + LEN; // 1.64 (the swallow tips)
const HALF_W = 0.6; // width / length ≈ 0.35: narrow enough to stay a board when foreshortened
const THICK = 0.175;
const U_WIDE = 0.47; // widest point, as a fraction of the length from the nose: the nose half is the narrow half
const TAIL_END = 0.42; // half-width at the tail end, as a fraction of HALF_W: a blunt, wide tail
const TAIL_P = 2.2; // tail curve: 1 - (1 - TAIL_END) w^TAIL_P, full through the hips
// Swallow tail: the tail end is notched NOTCH deep at the stringer. The notch is a warp of the
// hull grid's z toward the nose, zero on the rails and growing over the last 28 % of the length.
const NOTCH = 0.34;
const NOTCH_U0 = 0.72;
const NOTCH_R = 0.3; // rounds the notch's apex (in units of s)
// Nose: g = 1 - (1 - t)^2 (t = u / U_WIDE) has zero slope and finite curvature where it meets
// the tail, so the outline is C1 there with no kink; f = NOSE_A g + (1 - NOSE_A) g^2 keeps a
// finite tip angle but hollows the entry a little, which pulls the nose in over its first 30 %.
const NOSE_A = 0.2;
const TOP_F = 0.64; // share of the thickness above the rail line (a crowned deck)
const BOT_F = 0.38;
const U_CORE = 0.52;
const Z_CORE = Z_NOSE + U_CORE * LEN;
// Tail pad and kick bar.
const Z_PAD = Z_NOSE + 0.735 * LEN; // the pad's front edge on the stringer
const KICK_Z = Z_TAIL - NOTCH - 0.1; // the kick bar's centre line, just ahead of the notch
const KICK_D = 0.045; // its half depth (fore-aft)
const KICK_H = 0.034; // its height
const KICK_W = 0.28; // its half length

// ---- Wake ----
const WAKE_Z0 = 0.55; // where the wake walls start: under the rails' rear quarter, so the V grows out of them
const WAKE_X0 = 0.46; // their half-spread there, just inside the rail line
const WAKE_MAX = 6.5; // geometric length; the visible length follows speed
const WAKE_STATIONS = 28;
const TRAIL_N = 16;
const SPRAY = 96;
// Contact glow: a quad on the track, board-shaped glow computed per fragment.
const Z_MID = (Z_NOSE + Z_TAIL) / 2;
const POOL_SCALE = 1.05;
const POOL_X = HALF_W * POOL_SCALE + 0.3; // quad half extents (the glow has faded to ~0 at the border)
const POOL_Z = (LEN / 2) * POOL_SCALE + 0.2;
const POOL_SLIDE = 0.04; // how far the glow trails (+z) at full speed
const POOL_CUT = 0.9; // the glow stops here (fraction of the length), ahead of the notch and the wake's V
const HIST = 96; // lateral-position history for the carve, at 120 Hz
const HIST_DT = 1 / 120;

/** The nose curve, t = 0 at the tip .. 1 at the widest point. */
function pointed(u) {
  const t = Math.min(1, Math.max(0, u / U_WIDE));
  const g = 1 - (1 - t) * (1 - t);
  return NOSE_A * g + (1 - NOSE_A) * g * g;
}

/** Planform half-width (rail line) as a fraction of HALF_W: pointed nose, wide swallow tail. */
function outline(u) {
  if (u <= 0) return 0;
  if (u < U_WIDE) return pointed(u);
  const w = Math.min(1, (u - U_WIDE) / (1 - U_WIDE));
  return 1 - (1 - TAIL_END) * Math.pow(w, TAIL_P);
}
const halfWidth = (u) => HALF_W * outline(u);
/** The notch profile across the tail: 1 on the stringer (a rounded apex), 0 on the rails. */
const NG_B = Math.hypot(1, NOTCH_R) - NOTCH_R;
const notchG = (s) => Math.max(0, 1 - (Math.hypot(s, NOTCH_R) - NOTCH_R) / NG_B);
/** How much of the notch applies at u (0 ahead of NOTCH_U0, 1 at the tail end). */
const notchW = (u) => Math.pow(Math.max(0, (u - NOTCH_U0) / (1 - NOTCH_U0)), 1.6);
/** z of the hull grid point (u, s): the swallow notch pulls the tail's middle forward. */
const zOf = (u, s) => Z_NOSE + u * LEN - NOTCH * notchW(u) * notchG(s);
/** Rail-line height: a strong nose rocker and a little tail kick. */
// The nose lifts well over twice as far as the tail kicks, so the two ends never read as
// matching caps side-on.
function rocker(u) {
  const n = Math.max(0, 1 - u / 0.46), t = Math.max(0, (u - 0.8) / 0.2);
  return 0.18 * Math.pow(n, 1.8) + 0.03 * t * t;
}
/** The tail is foiled down to a knife edge along the notch, where the rail tube closes it. */
const foil = (u) => { const w = Math.max(0, (u - 0.8) / 0.2); return Math.sqrt(Math.max(0, 1 - w * w * w * w)); };
const thickness = (u) => THICK * Math.pow(outline(u), 0.55) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, u * 1.15))) * foil(u);
const topY = (u, s) => rocker(u) + thickness(u) * TOP_F * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 2.4)), 0.5);
const bottomY = (u, s) => rocker(u) - thickness(u) * BOT_F * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 3.5)), 0.42);
const clamp1 = (s) => Math.max(-1, Math.min(1, s));
/** The hull parameters (u, s) of the deck / belly point over (x, z), solved through the notch warp. */
function hullAt(x, z) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (zOf(m, clamp1(x / Math.max(1e-4, halfWidth(m)))) < z) lo = m; else hi = m;
  }
  const u = (lo + hi) / 2;
  return [u, clamp1(x / Math.max(1e-4, halfWidth(u)))];
}

/** Geometry accumulator: positions, normals, aInfo = (part, a, b, c), indices. */
class Builder {
  constructor() {
    this.p = []; this.n = []; this.info = []; this.idx = [];
  }
  get count() { return this.p.length / 3; }
  vert(x, y, z, part, a = 0, b = 0, c = 0) {
    this.p.push(x, y, z); this.n.push(0, 0, 0); this.info.push(part, a, b, c);
    return this.count - 1;
  }
  normal(i, x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    this.n[i * 3] = x / l; this.n[i * 3 + 1] = y / l; this.n[i * 3 + 2] = z / l;
  }
  /** Triangle wound so its face normal points along (ox, oy, oz). */
  tri(a, b, c, ox, oy, oz) {
    const P = this.p;
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * nx + ny * ny + nz * nz < 1e-18) return; // degenerate
    if (nx * ox + ny * oy + nz * oz < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  /** Triangle with its outward direction taken from a point inside the solid. */
  triFrom(a, b, c, ix, iy, iz) {
    const P = this.p;
    const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, cy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    this.tri(a, b, c, cx - ix, cy - iy, cz - iz);
  }
  /** Smooth normals for vertices from v0 on, from the triangles from index i0 on. */
  smooth(v0, i0) {
    const P = this.p, N = this.n, I = this.idx;
    for (let k = i0; k < I.length; k += 3) {
      const a = I[k], b = I[k + 1], c = I[k + 2];
      const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
      const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        if (v < v0) continue;
        N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz;
      }
    }
    for (let v = v0; v < this.count; v++) this.normal(v, N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
  }
  /** A flat-shaded triangle with its own three vertices. */
  flat(pa, pb, pc, info, ox, oy, oz) {
    const v0 = this.count, i0 = this.idx.length;
    const a = this.vert(...pa, ...info), b = this.vert(...pb, ...info), c = this.vert(...pc, ...info);
    this.tri(a, b, c, ox, oy, oz);
    this.smooth(v0, i0);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---- Board parts: 0 deck, 1 belly, 2 rail line, 3 fins, 4 crystal, 5 collar, 6 kick bar ----

/**
 * The hull: deck and belly surfaces meeting on the rail line, closed by a fan at the nose.
 * At the tail both come down to the same knife edge along the swallow notch (the tail row
 * has no thickness), where they meet like they do along the rails.
 */
function addHull(B) {
  const NS = 80, NT = 24;
  const us = [];
  for (let i = 1; i <= NS; i++) {
    // Cosine spacing at the nose, a little denser again toward the notch.
    const t = i / NS;
    us.push(t < 0.5 ? 0.5 - 0.5 * Math.cos(Math.PI * t) : 0.5 + 0.5 * Math.sin(Math.PI * (t - 0.5)));
  }
  const ss = [];
  for (let j = 0; j <= NT; j++) ss.push(-Math.cos((Math.PI * j) / NT));
  for (const [part, yf, up] of [[0, topY, 1], [1, bottomY, -1]]) {
    const v0 = B.count, i0 = B.idx.length;
    const grid = [];
    for (const u of us) {
      const hw = halfWidth(u);
      grid.push(ss.map((s) => B.vert(s * hw, yf(u, s), zOf(u, s), part, u, s, 0)));
    }
    // One winding for the whole grid, taken from a well-shaped quad mid-deck (deck up, belly
    // down): the grid is regular, so it holds everywhere, including the knife-thin foiled tail
    // and the swallow tips where a per-triangle inside test is ill-conditioned.
    const P = B.p;
    const im = grid.length >> 1, jm = NT >> 1;
    const qa = grid[im][jm], qb = grid[im][jm + 1], qc = grid[im + 1][jm + 1];
    const e1x = P[qb * 3] - P[qa * 3], e1z = P[qb * 3 + 2] - P[qa * 3 + 2];
    const e2x = P[qc * 3] - P[qa * 3], e2z = P[qc * 3 + 2] - P[qa * 3 + 2];
    const flip = (e1z * e2x - e1x * e2z) * up < 0;
    const T = (a, b, c) => {
      const e1 = [0, 1, 2].map((q) => P[b * 3 + q] - P[a * 3 + q]), e2 = [0, 1, 2].map((q) => P[c * 3 + q] - P[a * 3 + q]);
      const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
      if (cx * cx + cy * cy + cz * cz < 1e-18) return;
      if (flip) B.idx.push(a, c, b); else B.idx.push(a, b, c);
    };
    for (let i = 0; i < grid.length - 1; i++) {
      for (let j = 0; j < NT; j++) {
        const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j + 1], d = grid[i + 1][j];
        // At the left swallow tip the a-c diagonal would join the rail edge to the notch edge,
        // where deck and belly coincide (a non-manifold edge): split that quad the other way.
        if (i === grid.length - 2 && j === 0) { T(a, b, d); T(b, c, d); } else { T(a, b, c); T(a, c, d); }
      }
    }
    const nose = B.vert(0, rocker(0), Z_NOSE, part, 0, 0, 0);
    const first = grid[0];
    for (let j = 0; j < NT; j++) B.triFrom(nose, first[j], first[j + 1], 0, rocker(0.01), Z_NOSE + 0.2);
    B.smooth(v0, i0);
  }
}

/**
 * The rail line as one closed path: nose → right rail → right swallow tip → notch → left tip →
 * left rail. Returned as rings of [x, y, z, u, notch] evenly spaced by arc length, with the two
 * swallow tips rounded (a local smoothing) so the tube can turn them without folding.
 */
function railPath(n) {
  const dense = [];
  const NSD = 900, NN = 120;
  for (let i = 0; i <= NSD; i++) {
    const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / NSD);
    dense.push([halfWidth(u), rocker(u), Z_NOSE + u * LEN, u, 0]);
  }
  for (let i = 1; i < NN; i++) {
    const s = 1 - (2 * i) / NN;
    dense.push([s * halfWidth(1), rocker(1), zOf(1, s), 1, 1 - Math.abs(s)]);
  }
  for (let i = NSD; i >= 1; i--) {
    const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / NSD);
    dense.push([-halfWidth(u), rocker(u), Z_NOSE + u * LEN, u, 0]);
  }
  const resample = (pts, m) => {
    const cum = [0];
    const N = pts.length;
    for (let i = 1; i <= N; i++) {
      const a = pts[i - 1], b = pts[i % N];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = cum[N], out = [];
    let k = 0;
    for (let i = 0; i < m; i++) {
      const sArc = (total * i) / m;
      while (k < N - 1 && cum[k + 1] < sArc) k++;
      const f = (sArc - cum[k]) / (cum[k + 1] - cum[k] || 1);
      const a = pts[k], b = pts[(k + 1) % N];
      out.push(a.map((v, q) => v + (b[q] - v) * f));
    }
    return { out, total };
  };
  // Round the swallow tips: Laplacian smoothing on a 1 cm path, weighted to the two tips.
  let { out: fine, total } = resample(dense, 0);
  const m = Math.round(total / 0.01);
  fine = resample(dense, m).out;
  const tips = [];
  fine.forEach((p, i) => { if (p[3] > 0.999 && p[4] < 1e-3) tips.push(i); });
  // The two swallow tips and the notch apex (the notch point nearest the nose on the stringer).
  let apex = 0;
  fine.forEach((p, i) => { if (p[4] > fine[apex][4]) apex = i; });
  const tipIdx = [tips[0], tips[tips.length - 1], apex];
  const wgt = fine.map((_, i) => {
    let d = Infinity;
    for (const t of tipIdx) d = Math.min(d, Math.abs(i - t), m - Math.abs(i - t));
    const e = (d * 0.01) / 0.09;
    return Math.exp(-e * e);
  });
  for (let it = 0; it < 90; it++) {
    const prev = fine.map((p) => p.slice());
    for (let i = 0; i < m; i++) {
      const a = prev[(i - 1 + m) % m], b = prev[(i + 1) % m], w = 0.5 * wgt[i];
      for (let q = 0; q < 3; q++) fine[i][q] = prev[i][q] + w * ((a[q] + b[q]) / 2 - prev[i][q]);
    }
  }
  return resample(fine, n).out;
}

const RAIL_R = 0.026;
/** Rail tube radius along the outline: a fine point at the nose, fuller toward the tail. */
const railR = (u) => {
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  return RAIL_R * (0.25 + 0.75 * ss(0, 0.06, u)) * (1 + 0.32 * ss(0.5, 1, u));
};

/**
 * The neon rail line: one closed tube round the whole outline, swallow notch included. It
 * tapers to a fine point at the nose and thickens toward the tail (the tail carries the
 * silhouette weight from the chase camera), and it sits a third of its radius proud of the
 * hull edge, so a banked board never tucks its low rail under the deck's crown.
 */
function addRail(B, sides = 12) {
  const loop = railPath(256);
  const n = loop.length;
  const v0 = B.count;
  // Outward in the board plane: (tz, 0, -tx) points out on this loop's winding (checked on the right rail).
  const ref = loop.findIndex((p) => p[3] > U_WIDE);
  const sgn = loop[(ref + 1) % n][2] - loop[ref][2] > 0 ? 1 : -1;
  const rings = [];
  for (let k = 0; k < n; k++) {
    const p = loop[k], a = loop[(k - 1 + n) % n], b = loop[(k + 1) % n];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    let l = Math.hypot(tx, ty, tz); tx /= l; ty /= l; tz /= l;
    const r = railR(p[3]);
    let ox0 = tz * sgn, oz0 = -tx * sgn;
    l = Math.hypot(ox0, oz0) || 1; ox0 /= l; oz0 /= l;
    const off = 0.33 * r * Math.min(1, p[3] / 0.06);
    const cxp = p[0] + ox0 * off, czp = p[2] + oz0 * off;
    // Frame: N as close to up as possible, B = T × N (in the board plane).
    let nx = -tx * ty, ny = 1 - ty * ty, nz = -tz * ty;
    l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const ring = [];
    for (let j = 0; j < sides; j++) {
      const th = (2 * Math.PI * j) / sides, c = Math.cos(th), s = Math.sin(th);
      const ox = c * nx + s * bx, oy = c * ny + s * by, oz = c * nz + s * bz;
      const v = B.vert(cxp + ox * r, p[1] + oy * r, czp + oz * r, 2, p[3], Math.sign(p[0]) || 1, p[4]);
      B.normal(v, ox, oy, oz);
      ring.push(v);
    }
    rings.push({ ring, p: [cxp, p[1], czp] });
  }
  for (let k = 0; k < n; k++) {
    const A = rings[k], C = rings[(k + 1) % n];
    const cx = (A.p[0] + C.p[0]) / 2, cy = (A.p[1] + C.p[1]) / 2, cz = (A.p[2] + C.p[2]) / 2;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      B.triFrom(A.ring[j], A.ring[j1], C.ring[j1], cx, cy, cz);
      B.triFrom(A.ring[j], C.ring[j1], C.ring[j], cx, cy, cz);
    }
  }
  return v0;
}

/**
 * The kick bar: a raised, rounded bar across the tail pad just ahead of the notch, bedded
 * 1.5 cm into the deck and rounded down at both ends. Part 6.
 */
function addKick(B) {
  const NX = 18, ARC = 10, SINK = 0.015;
  const deckY = (x, z) => { const [u, s] = hullAt(x, z); return topY(u, s); };
  const v0 = B.count, i0 = B.idx.length;
  const rings = [];
  for (let i = 0; i <= NX; i++) {
    const t = -1 + (2 * i) / NX, x = t * KICK_W;
    const h = KICK_H * (0.3 + 0.7 * Math.sqrt(Math.max(0, 1 - t ** 6)));
    const yF = deckY(x, KICK_Z - KICK_D), yA = deckY(x, KICK_Z + KICK_D);
    const prof = [[KICK_D, yA - SINK]];
    for (let j = 0; j <= ARC; j++) {
      // A kick: the fore face ramps up gently, the aft face is steep.
      const th = (Math.PI * j) / ARC, c = Math.cos(th);
      const dz = KICK_D * c, base = yF + (yA - yF) * (0.5 + 0.5 * c);
      const lift = Math.pow(Math.sin(th), 0.6) * (0.55 + 0.45 * (0.5 + 0.5 * c));
      prof.push([dz, base + h * lift]);
    }
    prof.push([-KICK_D, yF - SINK]);
    rings.push({ x, mid: (yF + yA) / 2, ring: prof.map(([dz, y], j) => B.vert(x, y, KICK_Z + dz, 6, t, j / (prof.length - 1), h / KICK_H)) });
  }
  const M = rings[0].ring.length;
  for (let i = 0; i < NX; i++) {
    const A = rings[i], C = rings[i + 1];
    const ix = (A.x + C.x) / 2, iy = (A.mid + C.mid) / 2 + 0.004;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      B.triFrom(A.ring[j], A.ring[j1], C.ring[j1], ix, iy, KICK_Z);
      B.triFrom(A.ring[j], C.ring[j1], C.ring[j], ix, iy, KICK_Z);
    }
  }
  B.smooth(v0, i0);
  // End caps: flat fans with their own vertices.
  for (const [R, dir] of [[rings[0], -1], [rings[NX], 1]]) {
    const P = B.p;
    const pts = R.ring.map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    const c = pts.reduce((m, q) => [m[0] + q[0] / M, m[1] + q[1] / M, m[2] + q[2] / M], [0, 0, 0]);
    const cv = B.vert(...c, 6, dir, 0.5, 0.3);
    B.normal(cv, dir, 0, 0);
    const vs = pts.map((q, j) => { const v = B.vert(...q, 6, dir, j / (M - 1), 0.3); B.normal(v, dir, 0, 0); return v; });
    for (let j = 0; j < M; j++) B.tri(cv, vs[j], vs[(j + 1) % M], dir, 0, 0);
  }
}

/** Quadratic Bézier samples (t from 0 to 1, n + 1 points). */
function bez(p0, p1, p2, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
  return out;
}

/**
 * A raked surf fin hanging from the belly. Outline in (a along the chord,
 * b down the depth), both normalised; the root runs up into the hull.
 * `cant` tilts it outward, `toe` turns its leading edge in, `rake` sweeps the tip aft
 * (a shear: z moves back by rake × chord at full depth).
 */
function addFin(B, x0, zLead, chord, depth, thick, cant, toe, rake, index) {
  const e = 0.03 / depth;
  const lead = bez([0, 0], [0.3, 0.62], [1.05, 1.0], 12);
  const trail = bez([1.05, 1.0], [0.8, 0.4], [1.0, 0.0], 10).slice(1);
  const outline2 = lead.concat(trail, [[1.0, -e], [0, -e]]);
  // Signed area in (a, -b): > 0 means counter-clockwise.
  let area = 0;
  for (let i = 0; i < outline2.length; i++) {
    const [a0, b0] = outline2[i], [a1, b1] = outline2[(i + 1) % outline2.length];
    area += a0 * -b1 - a1 * -b0;
  }
  const ccw = area > 0;
  const sc = Math.sin(cant), cc = Math.cos(cant);
  const rootAt = (a) => {
    const [u, s] = hullAt(x0 - toe * (a - 0.5) * chord, zLead + a * chord);
    return bottomY(u, s);
  };
  const rootY0 = Math.max(rootAt(0), rootAt(0.5)), rootY1 = Math.max(rootAt(1), rootAt(0.5));
  const place = (a, b, sigma) => {
    const d = b * depth;
    // A blade, not a post: thick at the root and thinning to a quarter at the tip, plus a
    // fillet that flares the last few centimetres into the belly, so the fin grows out of the
    // hull. Thickness only moves the faces off the fin plane, so no face can fold.
    const bc = Math.min(1, Math.max(0, b)), fil = Math.max(0, 1 - bc / 0.3);
    const t = thick * (1 - 0.72 * bc) + 0.045 * fil * fil;
    const z = zLead + (a + rake * Math.max(0, b)) * chord;
    const xm = x0 + sc * d - toe * (a - 0.5) * chord;
    // The root line runs straight between where the leading and trailing root stations meet
    // the belly (it sinks 3 cm into the hull, so it never gaps), which keeps the whole blade
    // an affine image of its outline: no sliver face can fold over.
    const y = rootY0 + (rootY1 - rootY0) * a - cc * d;
    return [xm + sigma * cc * t * 0.5, y + sigma * sc * t * 0.5, z];
  };
  const info = (a, b) => [3, a, Math.max(0, b), index];
  // Side faces.
  // Triangulated as a ladder between the leading edge and the (concave) trailing edge,
  // both monotone in depth, so no face can fall outside the outline; plus the root quad.
  const nL = lead.length, nT = trail.length;
  const Lc = lead.map((_, i) => i); // root .. tip
  const Tc = [];
  for (let k = nL + nT - 1; k >= nL; k--) Tc.push(k); // trailing root .. just below the tip
  const tip = nL - 1;
  const faces = [];
  let i = 0, j = 0;
  while (!(i === nL - 2 && j === Tc.length - 1)) {
    const advLead = j === Tc.length - 1 || (i < nL - 2 && outline2[Lc[i + 1]][1] <= outline2[Tc[j + 1]][1]);
    if (advLead) { faces.push([Lc[i], Tc[j], Lc[i + 1]]); i++; } else { faces.push([Lc[i], Tc[j], Tc[j + 1]]); j++; }
  }
  faces.push([Lc[nL - 2], Tc[Tc.length - 1], tip]);
  const rootA = outline2.length - 2, rootB = outline2.length - 1; // (1, -e), (0, -e)
  faces.push([0, Tc[0], rootA], [0, rootA, rootB]);
  // Every face is wound by its 2D winding, flipped once per side from the largest face's
  // physical normal, so slivers along the raked trailing edge keep a consistent winding.
  const area2 = ([i, j, k]) => {
    const [a0, b0] = outline2[i], [a1, b1] = outline2[j], [a2, b2] = outline2[k];
    return (a1 - a0) * -(b2 - b0) - (a2 - a0) * -(b1 - b0);
  };
  const ccwFaces = faces.map((f) => (area2(f) >= 0 ? f : [f[0], f[2], f[1]]));
  const big = ccwFaces.reduce((m, f) => (area2(f) > area2(m) ? f : m), ccwFaces[0]);
  for (const sigma of [1, -1]) {
    const ox = sigma * cc, oy = sigma * sc;
    const [pa, pb, pc] = big.map((q) => place(outline2[q][0], outline2[q][1], sigma));
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cxn = e1[1] * e2[2] - e1[2] * e2[1], cyn = e1[2] * e2[0] - e1[0] * e2[2], czn = e1[0] * e2[1] - e1[1] * e2[0];
    const flip = cxn * ox + cyn * oy < 0;
    // The blade's side normal, from its own plane (so toe and rake shade correctly).
    const sg = flip ? -1 : 1, fnx = cxn * sg, fny = cyn * sg, fnz = czn * sg;
    for (const f of ccwFaces) {
      const [i, j, k] = flip ? [f[0], f[2], f[1]] : f;
      const A = outline2[i], Bv = outline2[j], C = outline2[k];
      const va = B.vert(...place(A[0], A[1], sigma), ...info(A[0], A[1]));
      const vb = B.vert(...place(Bv[0], Bv[1], sigma), ...info(Bv[0], Bv[1]));
      const vc = B.vert(...place(C[0], C[1], sigma), ...info(C[0], C[1]));
      B.idx.push(va, vb, vc);
      // Flat shading along the fin plane's side normal.
      for (const q of [va, vb, vc]) B.normal(q, fnx, fny, fnz);
    }
  }
  // Edge strips. The trailing-edge strips (tip to root) are flagged (c = index + 10) so the
  // shader lights them solid: seen edge-on from behind, the fin is only this strip.
  const nLead = lead.length, nTrail = trail.length;
  for (let i = 0; i < outline2.length; i++) {
    const P = outline2[i], Q = outline2[(i + 1) % outline2.length];
    // Outward normal of the edge in the fin plane (a → z, -b → y).
    const p1 = place(P[0], P[1], 1), p2 = place(Q[0], Q[1], 1), p3 = place(Q[0], Q[1], -1), p4 = place(P[0], P[1], -1);
    // Orient from a point just inside the edge on the fin's mid-plane (placed through the
    // same cant, toe and rake), so the rake shear can never flip a strip.
    const ea = Q[0] - P[0], eb = Q[1] - P[1], el = Math.hypot(ea, eb) || 1;
    const inA = (ccw ? eb : -eb) / el, inB = (ccw ? -ea : ea) / el;
    const mid = place((P[0] + Q[0]) / 2 + inA * 0.02, (P[1] + Q[1]) / 2 + inB * 0.02, 0);
    const infoP = info(P[0], P[1]), infoQ = info(Q[0], Q[1]);
    if (i >= nLead - 1 && i < nLead + nTrail) { infoP[3] += 10; infoQ[3] += 10; }
    const v0 = B.count, i0 = B.idx.length;
    const a = B.vert(...p1, ...infoP), b = B.vert(...p2, ...infoQ), c = B.vert(...p3, ...infoQ), d = B.vert(...p4, ...infoP);
    B.triFrom(a, b, c, ...mid); B.triFrom(a, c, d, ...mid);
    B.smooth(v0, i0);
  }
}

// ---- The energy core: a teardrop lens (sharp end forward, about 1.8 : 1) in a low collar ----
const LENS_LZ = 0.16; // half length
const LENS_W = 0.115; // width scale; the widest half-width is 0.77 LENS_W, a third of the way aft
const COLLAR_IN = 0.012, COLLAR_TOP = 0.04, COLLAR_BOT = 0.062; // outline offsets of the collar rings
/** Teardrop outline at parameter t (t = π is the sharp tip, forward), offset outward by r. */
function tear(t, r) {
  const c = Math.cos(t);
  const g = Math.sin(t) * Math.sqrt(Math.max(0, (1 + c) / 2));
  return [(LENS_W + r / 0.77) * g, Z_CORE + (LENS_LZ + r) * c];
}

/** The energy core: a teardrop collar on the deck and a faceted teardrop lens inside it. */
function addCore(B) {
  const deck = topY(U_CORE, 0);
  const SEG = 40;
  const yB = deck - 0.045, yT = deck + 0.004; // an inlay: the collar's top sits flush with the deck
  const ring = (r, y, top = 0, rad = 0) => {
    const out = [];
    for (let k = 0; k < SEG; k++) {
      const [x, z] = tear((2 * Math.PI * k) / SEG, r);
      out.push(B.vert(x, y, z, 5, top, rad, 0));
    }
    return out;
  };
  // Separate rings per face so the edges stay crisp. The top annulus is
  // flagged (a = 1, b = 0 inner .. 1 outer): the shader runs a light round it.
  const oB = ring(COLLAR_BOT, yB), oT = ring(COLLAR_TOP, yT); // outer wall
  const tO = ring(COLLAR_TOP, yT, 1, 1), tI = ring(COLLAR_IN, yT, 1, 0); // top annulus
  const iT = ring(COLLAR_IN, yT), iB = ring(COLLAR_IN, yB); // inner wall
  const bI = ring(COLLAR_IN, yB), bO = ring(COLLAR_BOT, yB); // bottom annulus
  const Zc = Z_CORE + 0.03; // a point inside the outline for orienting the walls
  const quadStrip = (A, C, dir) => {
    for (let k = 0; k < SEG; k++) {
      const k1 = (k + 1) % SEG;
      for (const [a, b, c] of [[A[k], A[k1], C[k1]], [A[k], C[k1], C[k]]]) {
        const P = B.p;
        const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - Zc;
        const o = dir === 'out' ? [cx, 0, cz] : dir === 'in' ? [-cx, 0, -cz] : dir === 'up' ? [0, 1, 0] : [0, -1, 0];
        B.tri(a, b, c, ...o);
      }
    }
  };
  quadStrip(oB, oT, 'out');
  quadStrip(tO, tI, 'up');
  quadStrip(iT, iB, 'in');
  quadStrip(bI, bO, 'down');
  // Crisp normals: walls along the outline normal (with the taper), annuli flat.
  for (let k = 0; k < SEG; k++) {
    const t = (2 * Math.PI * k) / SEG, e = 1e-3;
    const [x0, z0] = tear(t - e, COLLAR_TOP), [x1, z1] = tear(t + e, COLLAR_TOP);
    let nx = z1 - z0, nz = -(x1 - x0);
    const [px, pz] = tear(t, COLLAR_TOP);
    if (nx * px + nz * (pz - Zc) < 0) { nx = -nx; nz = -nz; }
    if (k === SEG / 2) { nx = 0; nz = -1; } // the tip
    const l = Math.hypot(nx, nz);
    nx /= l; nz /= l;
    const slope = (COLLAR_BOT - COLLAR_TOP) / (yT - yB);
    B.normal(oB[k], nx, slope, nz); B.normal(oT[k], nx, slope, nz);
    B.normal(tO[k], 0, 1, 0); B.normal(tI[k], 0, 1, 0);
    B.normal(iT[k], -nx, 0, -nz); B.normal(iB[k], -nx, 0, -nz);
    B.normal(bI[k], 0, -1, 0); B.normal(bO[k], 0, -1, 0);
  }
  // Lens: a low faceted teardrop, sharp end forward. Equator, a crown ring and a ridge
  // apex a little aft of centre; a cone underneath, hidden in the well. Flat-shaded
  // in the shader (normalFlat); it rises only 4 cm above the deck, an inlaid gem, not a
  // cockpit. Its round tail runs on aft as a flush light-pipe into the stringer (deck shader).
  const N = 12, yEq = deck + 0.012, yCr = deck + 0.034, yTop = deck + 0.042, yBot = deck - 0.03;
  const eq = [], cr = [];
  for (let k = 0; k < N; k++) {
    const t = (2 * Math.PI * k) / N;
    const [x, z] = tear(t, 0);
    eq.push([x, yEq, z]);
    cr.push([x * 0.52, yCr, Z_CORE + 0.03 + (z - Z_CORE) * 0.52]);
  }
  const top = [0, yTop, Z_CORE + 0.03], bot = [0, yBot, Z_CORE];
  const inside = [0, (yEq + yBot) / 2, Z_CORE];
  const facet = (pa, pb, pc, ha, hb, hc) => {
    const v0 = B.count, i0 = B.idx.length;
    const a = B.vert(...pa, 4, ha, 0, 0), b = B.vert(...pb, 4, hb, 0, 0), c = B.vert(...pc, 4, hc, 0, 0);
    B.triFrom(a, b, c, ...inside);
    B.smooth(v0, i0);
  };
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    facet(eq[k], eq[k1], cr[k1], 0.35, 0.35, 0.7);
    facet(eq[k], cr[k1], cr[k], 0.35, 0.7, 0.7);
    facet(cr[k], cr[k1], top, 0.7, 0.7, 1);
    facet(eq[k1], eq[k], bot, 0.35, 0.35, 0.2);
  }
}

/** Build the whole board as one geometry. */
export function buildBoardGeometry() {
  const B = new Builder();
  addHull(B);
  addRail(B);
  // Tri-fin cluster ahead of the swallow notch: a centre fin and two side fins ahead of it,
  // hung from inside the rail (x = ±0.25) so from behind they sit under the hull. The side
  // fins have a long root chord (swept, fanned blades rather than posts), cant out 0.25 rad
  // and toe in about 22 degrees (stylised), so from behind they fan out as blades either side of the
  // upright centre fin instead of standing under the board like legs.
  addFin(B, 0, Z_TAIL - NOTCH - 0.5, 0.28, 0.18, 0.034, 0, 0, 0.16, 0);
  for (const side of [-1, 1]) addFin(B, side * 0.25, Z_TAIL - 1.12, 0.38, 0.18, 0.034, side * 0.25, -side * 0.42, 0.32, side);
  addKick(B);
  addCore(B);
  return B.geometry();
}

// ---- Wake geometry: aFx = (type, a, b, c), aSeed per spray sprite ----
// Types: 0 contact glow, 1 wake walls, 2 spray streaks.

const WALL_ROWS = 4; // base, crest, lip, curl-over

function buildWakeGeometry() {
  const pos = [], fx = [], seed = [], idx = [];
  const v = (t, a, b, c, s = [0, 0, 0, 0]) => {
    pos.push(0, -0.5, 1); fx.push(t, a, b, c); seed.push(...s);
    return pos.length / 3 - 1;
  };
  // Contact pool: one quad on the track under the board.
  const h = [v(0, -1, -1, 0), v(0, 1, -1, 0), v(0, 1, 1, 0), v(0, -1, 1, 0)];
  idx.push(h[0], h[2], h[1], h[0], h[3], h[2]);
  // Wake walls: stations along the trail × rows (base, crest, lip, curl), both sides.
  for (const side of [-1, 1]) {
    const grid = [];
    for (let k = 0; k < WAKE_STATIONS; k++) {
      const f = k / (WAKE_STATIONS - 1);
      const col = [];
      for (let r = 0; r < WALL_ROWS; r++) col.push(v(1, f, r, side));
      grid.push(col);
    }
    for (let k = 0; k < WAKE_STATIONS - 1; k++) {
      for (let r = 0; r < WALL_ROWS - 1; r++) {
        const a = grid[k][r], b = grid[k][r + 1], c = grid[k + 1][r + 1], d = grid[k + 1][r];
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  // Spray streaks: seed = (phase, emitter: 2/5 left crest, 2/5 right crest, 1/5 centre fin,
  // speed, size); aFx.w = where along the crest the streak is thrown from.
  let s = 0x9e3779b9;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  // The crest streaks come in mirrored left/right pairs sharing one seed, so the spray
  // (like the board) is exactly symmetric; the rest come off the centre fin.
  const PAIRS = Math.round((SPRAY * 0.4)); // 38 pairs, 20 centre streaks
  const streak = (sd, at) => {
    const q = [v(2, -0.5, -0.5, at, sd), v(2, 0.5, -0.5, at, sd), v(2, 0.5, 0.5, at, sd), v(2, -0.5, 0.5, at, sd)];
    idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  };
  for (let i = 0; i < SPRAY - PAIRS; i++) {
    const r0 = rnd(), r2 = rnd(), r3 = rnd(), at = rnd();
    if (i < PAIRS) {
      streak([r0, 0.1, r2, r3], at);
      streak([r0, 0.5, r2, r3], at);
    } else {
      streak([r0, 0.9, r2, r3], at);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFx', new THREE.Float32BufferAttribute(fx, 4));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 3), 6);
  return g;
}

// ---- Materials ----

/** smoothstep that also accepts falling edges (e0 > e1), portable to GLSL. */
const ramp = (e0, e1, x) => (e0 < e1 ? smoothstep(e0, e1, x) : float(1).sub(smoothstep(e1, e0, x)));

/**
 * One line of half-width w (in the units of x) at c, antialiased. Energy-conserving:
 * once the line is thinner than a pixel it dims to its pixel coverage instead of
 * smearing to a full-bright pixel-wide band (which turned the thin nose pale).
 */
const aaLine = (x, c, w) => {
  const fw = max(fwidth(x), 1e-5);
  return saturate(float(1).sub(abs(x.sub(c)).sub(w).div(fw))).mul(saturate(float(w).mul(2).div(fw)));
};

/** The board planform (outline() above) as a node, for the contact glow and the deck bands. */
function outlineNode(u) {
  const t = saturate(u.div(U_WIDE)), g = float(1).sub(float(1).sub(t).mul(float(1).sub(t)));
  const nose = g.mul(NOSE_A).add(g.mul(g).mul(1 - NOSE_A));
  const w = saturate(u.sub(U_WIDE).div(1 - U_WIDE));
  const tail = float(1).sub(pow(max(w, 1e-5), TAIL_P).mul(1 - TAIL_END));
  return mix(tail, nose, step(u, U_WIDE)).mul(step(0, u)).mul(step(u, 1));
}

// The fore-deck chevron: a V with its apex on the stringer, pointing at the nose.
const CHEV_K = 0.62; // the arms sweep back 0.62 m per metre out
const CHEV_N = 1 / Math.sqrt(1 + CHEV_K * CHEV_K);
const Z_CHEV_FORE = Z_NOSE + 0.3 * LEN;
const Z_PIPE_END = Z_PAD - 0.12; // the lens's light-pipe runs aft to here
const PIN_IN = 0.06; // the rail bands sit 6 cm inside the rail line (clear of the tube and its glow)
const PAD_IN = 0.1; // the pad stays 10 cm inside the rail line

function boardMaterial(u, v) {
  const m = new THREE.MeshBasicNodeMaterial();
  const info = attribute('aInfo', 'vec4');
  const part = info.x;
  const is = (k) => step(k - 0.5, part).mul(step(part, k + 0.5));

  // On the beat the rail tube swells a few millimetres (most at the tail), so the pulse reads
  // as the outline breathing from the chase camera, not only as a brightness flash.
  m.positionNode = Fn(() => {
    const tailW = smoothstep(0.45, 1.0, info.y);
    const swell = u.beat.mul(tailW.mul(0.006).add(0.002)).mul(is(2));
    return positionGeometry.add(normalGeometry.mul(swell));
  })();

  m.colorNode = Fn(() => {
    const p = positionGeometry;
    const col = u.trackColor;
    const I = v.intensity;
    const beat = u.beat;
    const V = positionViewDirection;
    const nv = normalize(normalView);
    // Camera-relative studio light: a key from above-left, a soft fill, a glossy highlight.
    const L = normalize(vec3(-0.35, 0.85, 0.45));
    const H = normalize(L.add(V));
    const key = saturate(dot(nv, L));
    const fill = saturate(dot(nv, normalize(vec3(0.6, -0.1, 0.8)))).mul(0.25);
    const nh = saturate(dot(nv, H));
    const spec = pow(nh, 90);
    const facing = abs(dot(nv, V));
    const rim = pow(float(1).sub(facing), 3);
    const lit = key.mul(1.1).add(fill).add(0.13);
    const uu = info.y, ss = info.z;
    const glowI = I.mul(1.6).add(0.9);
    const steel = vec3(0.55, 0.62, 0.78); // cool metallic tint
    // How side-on the camera sees the board (1 in the pure profile, ~0.7 in the chase view, 0 from above).
    const upView = normalize(modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const sideOn = smoothstep(0.8, 0.97, float(1).sub(abs(dot(upView, V))));
    // Looking along the board from dead ahead, or low from dead astern.
    const fwdView = normalize(modelViewMatrix.mul(vec4(0, 0, -1, 0)).xyz);
    const fwdDot = dot(fwdView, V);
    const headOn = smoothstep(0.84, 0.93, fwdDot);
    const rearOn = smoothstep(0.955, 0.985, fwdDot.negate());
    // World size of a pixel here, for fading details that get thinner than the screen can hold.
    const pxW = length(fwidth(p)).mul(0.7);
    const ny = dot(nv, upView);

    // Deck: dark lacquered gunmetal under a clear coat; a pair of pearl rail bands 6 cm inside
    // the rail; a neon stringer from the nose to the tail pad; one forward-pointing chevron on
    // the fore-deck; the lens with its light-pipe; and at the tail a solid, lit traction pad
    // ending at a raised kick bar (separate geometry) ahead of the swallow notch.
    const ax = abs(p.x);
    const hwN = outlineNode(uu).mul(HALF_W);
    const railIn = float(1).sub(abs(ss)).mul(hwN); // how far inside the rail (in x), metres
    const chevD = (z0) => p.z.sub(z0).sub(ax.mul(CHEV_K)).mul(CHEV_N); // signed, > 0 aft of the V
    const inside = ramp(0.8, 0.7, abs(ss)); // keeps the chevron inside the rail bands
    const armFade = ramp(0.78, 0.25, abs(ss)).mul(0.55).add(0.45); // arms dim toward their ends
    const dFore = chevD(Z_CHEV_FORE);
    // Seen along the board (head-on, or low from astern) the chevron's arms flatten into a
    // cross-bar that, with the stringer, reads as a reticle: fade the arms there (the apex stays).
    // (Low from astern the apex would cross the stringer as well, so there the whole V goes.)
    const foreArms = float(1).sub(max(headOn.mul(smoothstep(0.012, 0.045, ax)), rearOn));
    const foreChev = aaLine(dFore, 0, 0.014).mul(inside).mul(armFade).mul(foreArms);
    // A short afterglow trails the fore chevron, like a speed streak.
    const foreGlow = step(0, dFore).mul(exp(dFore.mul(-7))).mul(inside).mul(armFade).mul(foreArms);
    // Rail bands: classic pinlines a constant 6 cm inside the rail, nose shoulder to tail.
    const pin = aaLine(railIn, PIN_IN, 0.007).mul(smoothstep(0.14, 0.24, uu)).mul(ramp(0.975, 0.93, uu));
    // Tail pad: a solid block filling the tail, from a slightly bowed front edge back round the
    // kick bar into both swallow tips, 10 cm inside the rails and the notch. dPad is a signed
    // distance inside its outline (metres).
    const zFront = ax.mul(ax).mul(0.35).add(Z_PAD);
    const sN = ax.div(HALF_W * TAIL_END);
    const zNotch = float(Z_TAIL).sub(max(float(1).sub(sqrt(sN.mul(sN).add(NOTCH_R * NOTCH_R)).sub(NOTCH_R).div(NG_B)), 0).mul(NOTCH));
    const dPad = min(min(p.z.sub(zFront), railIn.sub(PAD_IN)), zNotch.sub(p.z).sub(PAD_IN));
    const padFill = saturate(dPad.div(max(fwidth(dPad), 1e-5)).add(0.5)).mul(step(0.5, uu));
    const padEdge = aaLine(dPad, 0.01, 0.0055).mul(padFill);
    // The stringer runs from the nose to the pad, where the pad takes over.
    const strMask = smoothstep(Z_NOSE + 0.12, Z_NOSE + 0.3, p.z).mul(ramp(Z_PAD - 0.02, Z_PAD - 0.1, p.z));
    const strK = float(1).sub(rearOn.mul(0.6)); // low from astern it would read as a sight line
    const stringer = aaLine(ax, 0, 0.01).mul(strMask).mul(strK);
    const strHot = aaLine(ax, 0, 0.003).mul(strMask).mul(strK);
    // The light-pipe: the lens's round tail runs on aft, flush, narrowing into the stringer.
    const pz = saturate(p.z.sub(Z_CORE + LENS_LZ).div(Z_PIPE_END - Z_CORE - LENS_LZ));
    const pipeOn = step(Z_CORE + 0.05, p.z).mul(ramp(1.0, 0.85, pz));
    const pipe = aaLine(ax, 0, mix(float(0.026), float(0.01), sqrt(pz))).mul(pipeOn);
    // The well: the deck inside the collar's inner teardrop.
    const tc = p.z.sub(Z_CORE).div(LENS_LZ + COLLAR_IN);
    const tHW = sqrt(max(float(1).sub(tc.mul(tc)), 0)).mul(sqrt(max(tc.add(1).mul(0.5), 0))).mul(LENS_W + COLLAR_IN / 0.77);
    const well = smoothstep(-0.004, 0.006, tHW.sub(ax)).mul(step(abs(tc), 1.02));
    // Gunmetal, a little lighter toward the nose; the side walls stay dark.
    const edge = smoothstep(0.88, 0.99, abs(ss));
    const gun = mix(vec3(0.049, 0.055, 0.07), vec3(0.035, 0.039, 0.053), smoothstep(0.1, 0.95, uu));
    const deckBase = gun.mul(float(1).sub(edge.mul(0.4))).mul(float(1).sub(padFill.mul(0.45)));
    // Clear coat: a sharp reflection band that slides along the length, plus a faint grazing sheen.
    // Shoulder sheen: the crowned deck's rail shoulder catches a soft light band, strongest in
    // the side profile, so the deck reads as a shaped hull above the neon rail line.
    const shoulder = smoothstep(0.45, 0.72, abs(ss)).mul(ramp(0.95, 0.86, abs(ss)));
    // The coat is held down on the steep fore shoulders, where it would read as a pale band
    // along the rail from above; on the nose tip (which side-on would bloom into a blob); and
    // head-on, where the grazing deck would otherwise read as a pale saucer.
    const noseShoulder = max(shoulder, edge).mul(ramp(0.45, 0.2, uu)).mul(float(1).sub(sideOn));
    const noseTip = smoothstep(0.03, 0.14, uu);
    const coatK = float(1).sub(headOn.mul(0.8)).mul(noseTip).mul(float(1).sub(padFill.mul(0.6)));
    const coat = steel.mul(pow(nh, 40).mul(0.32).add(pow(float(1).sub(facing), 3).mul(0.05))).mul(float(1).sub(edge.mul(0.4)))
      .mul(float(1).sub(noseShoulder.mul(0.75))).mul(float(1).sub(ramp(0.72, 0.9, abs(ss)).mul(ramp(0.5, 0.3, uu)).mul(float(1).sub(sideOn))))
      .mul(coatK);
    // Crown clear coat: side-on, the upper deck (normals within ~45 degrees of up, still
    // facing the camera) carries a pale lacquer band, so the hull has a top surface above
    // the neon rail instead of a grey hairline.
    const crown = smoothstep(0.66, 0.8, ny).mul(smoothstep(0.03, 0.25, facing)).mul(sideOn).mul(ramp(0.97, 0.88, abs(ss)));
    const crownAlong = smoothstep(0.08, 0.2, uu).mul(ramp(0.97, 0.88, uu));
    const sheen = steel.mul(shoulder.mul(sideOn.mul(0.2)).mul(key.mul(0.6).add(0.4)))
      .add(steel.mul(pow(nh, 14).mul(0.1).mul(sideOn)))
      .add(vec3(0.62, 0.68, 0.8).mul(crown.mul(crownAlong).mul(smoothstep(0.66, 0.95, ny).mul(0.3).add(0.22))))
      .mul(coatK);
    // The pad: a lit block (the tail carries the silhouette weight from the chase camera) with
    // a brighter rim, pulsing on the beat.
    const padPulse = beat.mul(1.6).add(1);
    const padLight = col.mul(glowI.mul(0.2).mul(padFill)).add(mix(col, vec3(1), 0.2).mul(padEdge.mul(glowI.mul(0.75))))
      .mul(padPulse);
    const deck = deckBase.mul(lit)
      .add(coat)
      .add(sheen)
      .add(mix(vec3(0.6, 0.64, 0.72), col, 0.35).mul(pin.mul(0.8)).mul(key.mul(0.4).add(0.6)))
      // (Not on the steep rail shoulders, where the faceted normals break a sharp highlight into dashes.)
      .add(vec3(0.35).mul(spec).mul(ramp(0.9, 0.66, abs(ss))).mul(coatK))
      .add(col.mul(rim.mul(0.05)))
      .add(col.mul(foreGlow.mul(glowI.mul(0.16))))
      .add(col.mul(foreChev.mul(glowI.mul(1.2)).mul(beat.mul(0.6).add(1))))
      .add(col.mul(stringer.mul(0.45).mul(glowI)))
      .add(vec3(strHot.mul(0.35).mul(beat.mul(0.5).add(1))))
      .add(mix(col.mul(glowI.mul(0.85)), vec3(1.1), float(0.25).sub(pz.mul(0.2))).mul(pipe.mul(float(1).sub(well))))
      .add(padLight)
      .add(col.mul(well.mul(glowI.mul(0.9))).add(vec3(well.mul(0.2))));

    // Belly: glows with the track colour, brightest along three channels; dark toward the rail.
    // Along the length the glow peaks under the core (aft of mid) and fades into the nose.
    const chan = max(aaLine(abs(ss), 0, 0.03), aaLine(abs(ss), 0.46, 0.025));
    // Along the length the glow is weak at the nose, builds aft and peaks over the fins.
    const du = uu.sub(0.8);
    const bellyAlong = smoothstep(0.12, 0.62, uu).mul(exp(du.mul(du).mul(-30)).mul(0.75).add(0.3)).mul(ramp(1.0, 0.93, uu));
    const bellyFade = ramp(0.74, 0.56, abs(ss)).mul(bellyAlong);
    const pulse = sin(p.z.mul(6).sub(v.flow.mul(0.15)).sub(v.time.mul(3))).mul(0.25).add(0.75);
    const belly = vec3(0.03, 0.034, 0.045).mul(lit).add(steel.mul(pow(float(1).sub(facing), 2).mul(0.05)))
      .add(col.mul(bellyFade.mul(chan.mul(1.6).mul(pulse).add(0.45)).mul(glowI.mul(0.45)).mul(beat.mul(0.4).add(1))))
      .add(col.mul(rim.mul(0.05)));

    // Rail line: a neon tube in the intensity colour, brightening with intensity like the
    // lane lines. Nothing in it depends on the view facing, so a banked board keeps an unbroken
    // outline. Along its top runs a white-hot core, driven by the tube's world-space up-facing
    // half, so it survives the chase camera's low angle and the bank of a lane change, and the
    // outline keeps its edge where it crosses a lane line of the same colour. Where the tube is
    // only a few pixels wide (the chase distance) it is lifted ~30 %, most at the tail, so the
    // hero stays the brightest line in its lane. On the beat it swells (brightness and a few mm
    // of radius, most at the tail) and a near-white flash runs nose to tail. Over the first ~8 %
    // of the length (the fine nose point) the core, the beat swell and the run light are all
    // held off and the neon dims a little, so side-on the tip stays a thin neon point.
    const along = info.y;
    const noseK = smoothstep(0.015, 0.1, along);
    const tailW = smoothstep(0.5, 1.0, along);
    const runPos = v.phase.mul(2.5).sub(0.1);
    const dp = along.sub(runPos);
    const run = exp(dp.mul(dp).mul(-45)).mul(ramp(0.45, 0.3, v.phase)).mul(noseK);
    const tubePx = float(0.054).div(max(pxW, 1e-5));
    const distLift = ramp(10.0, 4.0, tubePx).mul(tailW.mul(0.2).add(0.3)).add(1);
    const swell = beat.mul(tailW.mul(0.7).add(0.9)).mul(noseK);
    // Side-on the notch's rail lies behind the swallow tips' and would stack into a bright
    // blob at the tail: hold it down there.
    const notchSide = smoothstep(0.05, 0.3, info.w).mul(sideOn).mul(0.55);
    const neon = col.mul(glowI.mul(0.78)).mul(swell.add(1)).mul(distLift).mul(noseK.mul(0.4).add(0.6)).mul(float(1).sub(notchSide));
    const hold = smoothstep(1.3, 2.4, tubePx);
    // Close up (a fat tube) only the crown of the tube is white, so the rail stays neon.
    const topE = smoothstep(5.0, 12.0, tubePx).mul(0.25);
    const topW = smoothstep(topE.add(0.5), topE.add(0.85), normalWorld.y);
    // Off the fine nose, where the thin tube would break the core into dashes.
    const coreMask = topW.mul(hold).mul(smoothstep(0.14, 0.26, along)).mul(float(1).sub(notchSide));
    const rail = mix(neon, vec3(1.2).add(col.mul(0.5)), coreMask.mul(0.5))
      .add(mix(col, vec3(1), 0.75).mul(run.mul(1.6)));

    // Kick bar: a lit neon block with a pale ridge along its top, flashing on the beat.
    const kickTop = smoothstep(0.55, 0.95, ny);
    const kick = mix(col.mul(glowI.mul(0.62)), vec3(1.05).add(col.mul(0.4)), kickTop.mul(0.4))
      .mul(beat.mul(1.4).add(1)).add(vec3(0.25).mul(spec)).add(col.mul(rim.mul(0.2)));

    // Fins: smoked tinted glass that glows faintly along its whole span (brighter toward the
    // tip) with a neon trailing edge. Edge-on the glass catches the track colour, so from
    // behind or head-on a fin reads as a lit blade, not a dark post. (The trailing edge is a
    // quadratic curve in (a, b); solve it for the edge's a at this depth.)
    const fa = info.y, fb = info.z;
    const tq = sqrt(max(fb.mul(0.8).add(0.64), 0)).sub(0.8).div(0.4);
    const aTrail = float(1).sub(tq).mul(float(1).sub(tq)).add(tq.mul(float(1).sub(tq)).mul(1.6)).add(tq.mul(tq).mul(1.05));
    const trailEdge = step(5, info.w);
    // The painted line on the side faces fades out edge-on, where it would alias into dashes.
    const sideLine = aaLine(fa.sub(aTrail), -0.03, 0.03).mul(smoothstep(0.02, 0.12, fb)).mul(float(1).sub(trailEdge)).mul(smoothstep(0.12, 0.4, facing));
    // Edge-on the trailing edge is an even line along the blade (a bright tip read as a lit foot).
    const trailing = max(sideLine, trailEdge.mul(smoothstep(0.05, 1.0, fb).mul(0.15).add(0.4)));
    // The glass body glows most where it is seen edge-on (through the most glass), so from
    // behind the fins read as lit blades with area, while side-on they stay smoked glass
    // behind their neon trailing edge. A bright fillet where each fin meets the belly makes
    // it grow out of the hull instead of standing under it; the tip dims a little.
    const glass = float(1).sub(smoothstep(0.35, 1.05, fb).mul(0.55));
    const edgeOn = pow(float(1).sub(facing), 1.5);
    const finGlow = glass.mul(mix(float(0.3), float(0.85), edgeOn)).mul(glowI).mul(beat.mul(0.6).add(1));
    const fillet = ramp(0.26, 0.0, fb);
    const fin = vec3(0.016, 0.02, 0.03).mul(lit).add(vec3(0.12).mul(spec)).add(steel.mul(pow(nh, 30).mul(0.06)))
      .add(col.mul(finGlow))
      .add(mix(col, vec3(1), 0.45).mul(fillet.mul(glowI.mul(0.95))))
      .add(col.mul(glowI.mul(0.95)).mul(trailing));

    // Lens: faceted glass in the track colour, a pale glint on the facets facing the camera
    // and a light that sweeps nose-ward along it. normalFlat's sign depends on the backend's
    // dFdy; face it toward the viewer.
    const nf0 = normalize(normalFlat);
    const nf = nf0.mul(step(0, dot(nf0, V)).mul(2).sub(1));
    const ff = abs(dot(nf, V));
    const hot = info.y;
    const sw = fract(p.z.sub(Z_CORE).mul(2.5).add(v.time.mul(0.9))).sub(0.5).mul(4);
    const sweep = exp(sw.mul(sw).negate()).mul(0.35);
    const crystal = mix(col.mul(glowI.mul(0.8)), vec3(1.5), pow(ff, 6).mul(hot.mul(0.4).add(0.2)))
      .mul(beat.mul(0.5).add(1).add(sweep))
      .add(col.mul(saturate(dot(nf, L)).mul(0.4)));

    // Collar: brushed dark metal, rimmed; a neon line round its top face with two
    // bright spots chasing round it.
    const cx = vec3(p.x, 0, p.z.sub(Z_CORE));
    const rr = length(cx);
    const rot = vec3(cos(v.time.mul(2.6)), 0, sin(v.time.mul(2.6)));
    const spot = pow(abs(dot(cx.div(max(rr, 1e-4)), rot)), 18);
    // A thin inlay line flush with the deck (no orbit ring), with one faint light chasing round it.
    const band = aaLine(info.z, 0.35, 0.07).mul(info.y);
    const collar = vec3(0.05, 0.055, 0.068).mul(lit).add(vec3(0.3).mul(spec)).add(steel.mul(pow(nh, 30).mul(0.1))).add(col.mul(rim.mul(0.08)))
      .add(col.mul(glowI).mul(band.mul(spot.mul(0.25).add(0.18))).mul(beat.mul(0.4).add(1)));

    const outCol = deck.mul(is(0)).add(belly.mul(is(1))).add(rail.mul(is(2))).add(fin.mul(is(3)))
      .add(crystal.mul(is(4))).add(collar.mul(is(5))).add(kick.mul(is(6)));
    return outCol.add(vec3(u.shipFlash.mul(2.5)));
  })();
  return m;
}

function wakeMaterial(u, v) {
  // Premultiplied blending: the glow outputs alpha 0 (pure additive), the contact
  // shade outputs black with alpha > 0 (darkens), all in one draw call.
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const fx = attribute('aFx', 'vec4');
  const sd = attribute('aSeed', 'vec4');
  const type = fx.x;
  const isHalo = float(1).sub(step(0.5, type));
  const isWall = step(0.5, type).mul(float(1).sub(step(1.5, type)));
  const isSpray = step(1.5, type);
  const yTrack = v.hover.negate().add(0.012);

  const trailAt = (f) => {
    const x = saturate(f).mul(TRAIL_N - 1);
    const i0 = min(floor(x), float(TRAIL_N - 2));
    const i = int(i0);
    return mix(v.trail.element(i), v.trail.element(i.add(1)), x.sub(i0));
  };
  // Wall height at distance d from where the wall starts under the rails' rear quarter:
  // zero there, rising as it leaves the tail, taller on the outside of a carve, then dies away.
  const envAt = (d) => smoothstep(0.0, 1.6, d).mul(exp(d.mul(-0.3)));
  const boostAt = (sg) => saturate(v.vx.mul(sg).mul(-0.014)).mul(0.9).add(1);
  // The arms carve: they flare out fast behind the tail and then run straighter, so even in a
  // straight line the V is a curved cut, not two straight rules.
  const spreadAt = (d) => d.add(float(1).sub(exp(d.mul(-1.3))).mul(0.8)).mul(v.spread).add(WAKE_X0);

  // Wall cross-section rows: base, crest, lip, curl. The lip rolls out and the curl
  // hangs back over it, so the crest reads as a curling lip from the side.
  const f = fx.y, row = fx.z, side = fx.w;
  const d = f.mul(WAKE_MAX);
  const boost = boostAt(side);
  const env = envAt(d);
  const H = v.wakeH.mul(env).mul(boost);
  // Where the wall starts it is only a low lit ribbon (3 cm high, ~12 cm wide), never a
  // zero-area sliver, so the crest line is visible from the first station.
  const Hg = max(H, 0.03), Hw = max(H, 0.07);
  const r1 = step(0.5, row), r2 = step(1.5, row), r3 = step(2.5, row);
  const latOut = mix(float(-0.05), mix(float(0.07), mix(float(0.4), float(0.52), r3), r2), r1).mul(Hw.div(0.3));
  const hFac = mix(float(0), mix(float(1), mix(float(0.92), float(0.7), r3), r2), r1);

  // Spray: ballistic streaks thrown off the wake crests (and a few off the centre fin).
  const age = fract(v.time.mul(sd.z.mul(0.9).add(1.6)).add(sd.x));
  const tau = age.mul(0.6);
  const em = sd.y;
  const sSide = step(0.4, em).mul(2).sub(1).mul(float(1).sub(step(0.8, em))); // -1, +1, then 0 (centre)
  const onCrest = abs(sSide);
  const sOut = saturate(v.vx.mul(sSide).mul(-0.014)).add(1);
  const d0 = fx.w.mul(1.6).add(1.25 - WAKE_Z0); // where along the crest the streak leaves (behind the tail)
  const H0 = v.wakeH.mul(envAt(d0)).mul(boostAt(sSide));
  const crest0 = vec3(sSide.mul(spreadAt(d0).add(H0.mul(0.07 / 0.3))), yTrack.add(H0), d0.add(WAKE_Z0));
  const fin0 = vec3(0, yTrack.add(0.2), sd.w.mul(0.3).add(1.05));
  const p0 = mix(fin0, crest0, onCrest);
  const G = 7.2;
  const vel = vec3(
    sSide.mul(sd.z.mul(1.1).add(0.5)).mul(sOut).add(float(1).sub(onCrest).mul(sd.w.sub(0.5).mul(0.8))),
    sd.w.mul(0.8).add(0.8).mul(v.spray),
    sd.z.mul(2.5).add(1.8).add(v.speed.mul(0.05)),
  );
  const sp = p0.add(vel.mul(tau)).sub(vec3(0, tau.mul(tau).mul(G * 0.5), 0));
  const velNow = vel.sub(vec3(0, tau.mul(G), 0));
  const sprayVisible = step(sd.w, v.spd.mul(0.75).add(0.3));
  const sprayPos = vec3(sp.x.add(trailAt(sp.z.sub(WAKE_Z0).div(WAKE_MAX))), min(max(sp.y, yTrack.add(0.02)), yTrack.add(0.6)), sp.z);
  // A little larger at birth, shrinking over the life; the streak is five times as long as it is wide.
  const birth = mix(float(1.3), float(1), smoothstep(0.0, 0.3, age));
  const sprayW = sd.w.mul(0.02).add(0.017).mul(birth).mul(float(1).sub(age.mul(0.55))).mul(sprayVisible);

  // Contact glow: a quad on the track under the board, trailing a little with speed and
  // turned with the board's yaw (the board-space coordinates stay in aFx for the fragment).
  const slide = v.spd.mul(POOL_SLIDE);
  const hx = fx.y.mul(POOL_X), hz = fx.z.mul(POOL_Z).add(slide);
  const cy = cos(v.yaw), sy = sin(v.yaw);

  const haloPos = vec3(hx.mul(cy).add(hz.mul(sy)), yTrack, hz.mul(cy).sub(hx.mul(sy)).add(Z_MID));
  const wallPos = vec3(trailAt(f).add(side.mul(spreadAt(d).add(latOut))), yTrack.add(Hg.mul(hFac)), d.add(WAKE_Z0));
  const local = haloPos.mul(isHalo).add(wallPos.mul(isWall)).add(sprayPos.mul(isSpray));
  // The wall's view-space position, for its face normal in the fragment stage.
  const vPos = varying(modelViewMatrix.mul(vec4(local, 1)).xyz, 'vWakePos');

  m.vertexNode = Fn(() => {
    const mv = modelViewMatrix.mul(vec4(local, 1));
    // Spray: a quad in the view plane stretched along the projected velocity.
    const vv = modelViewMatrix.mul(vec4(velNow, 0)).xyz;
    const dir = normalize(vec3(vv.x, vv.y, 0).add(vec3(0, 1e-4, 0)));
    const perp = vec3(dir.y.negate(), dir.x, 0);
    const off = dir.mul(fx.y.mul(sprayW.mul(5))).add(perp.mul(fx.z.mul(sprayW))).mul(isSpray);
    return cameraProjectionMatrix.mul(vec4(mv.xyz.add(off), 1));
  })();

  m.colorNode = Fn(() => {
    const col = u.trackColor;
    const I = v.intensity;
    const beat = u.beat;
    const glow = I.mul(1.4).add(0.8).mul(beat.mul(0.5).add(1));
    // Contact glow: a tight shadow-light under the board's own outline, cut off at
    // POOL_CUT so it stops at the tail instead of blooming into the start of the V;
    // brighter the closer the board rides to the track.
    const bx = fx.y.mul(POOL_X), bz = fx.z.mul(POOL_Z); // board space, relative to the board's middle
    const up = bz.div(POOL_SCALE).add(Z_MID - Z_NOSE).div(LEN);
    const hw = outlineNode(saturate(up)).mul(HALF_W * POOL_SCALE).add(0.05);
    const rl = abs(bx).div(hw);
    const over = max(up.negate(), 0).mul(LEN * POOL_SCALE);
    const lengthwise = exp(over.mul(over).mul(-45)).mul(ramp(POOL_CUT, POOL_CUT - 0.07, up));
    const near = saturate(float(0.55).div(max(v.hover, 0.2)));
    // Like the belly glow it comes from, it fades toward the thin nose.
    // It peaks under the core and eases off toward the tail, so the V of the wake stays clean.
    // Weak under the thin nose, strongest under the aft half.
    const pool = exp(rl.mul(rl).mul(-5.0)).mul(lengthwise).mul(smoothstep(0.12, 0.7, up).mul(0.9).add(0.1));
    const halo = col.mul(pool.mul(glow).mul(0.1).mul(near));
    // The shade reaches a touch past the outline: a dark keyline on the track round the board.
    const shadeA = ramp(1.3, 0.8, rl).mul(lengthwise).mul(0.42).mul(near).mul(isHalo);
    // Walls: crest brightest, streaks moving back along the wake, fading with length and
    // faded in over the first stations so the wall grows out of the fin wash.
    // The light sits on the crest and lip and falls off softly toward the base.
    const crest = exp(row.sub(1.3).mul(row.sub(1.3)).mul(-1.6)).mul(0.9).add(float(0.05).mul(float(1).sub(smoothstep(0.0, 1.0, row))));
    // Seen at a grazing angle the wall's body fades (it read as a flat searchlight beam from
    // ahead), leaving its crest and lip: the face normal comes from the view-space derivatives.
    const fn = normalize(cross(dFdx(vPos), dFdy(vPos)));
    const graze = abs(dot(fn, normalize(vPos.negate())));
    const faceK = smoothstep(0.05, 0.4, graze).mul(0.4).add(0.6);
    const fade = float(1).sub(smoothstep(v.wakeLen.mul(0.3), v.wakeLen, d));
    const streak = sin(d.mul(4.5).sub(v.flow.mul(0.25)).sub(v.time.mul(4))).mul(0.3).add(0.7);
    const foam = exp(d.mul(-1.2)).mul(exp(row.sub(1).mul(row.sub(1)).mul(-6))).mul(0.8);
    // Broken crest: a two-octave sine lattice across the wall (row) and along it (d),
    // streaming back at a fraction of the speed; the lip breaks up the most.
    const n1 = sin(d.mul(5.2).sub(v.flow.mul(0.7)).add(row.mul(2.3)).add(side.mul(1.9)));
    const n2 = sin(d.mul(11.7).sub(v.flow.mul(0.9)).sub(row.mul(4.1)).add(side.mul(0.7)));
    const nz = n1.mul(0.6).add(n2.mul(0.4)).mul(0.5).add(0.5);
    const broken = smoothstep(0.25, 0.75, nz);
    const brk = mix(float(1), broken.mul(0.85).add(0.15), smoothstep(0.3, 1.8, row).mul(0.5).add(smoothstep(0.4, 1.6, d).mul(0.4)));
    const wallLight = env.mul(1.3).add(0.06).mul(boost).mul(fade).mul(smoothstep(0.0, 0.5, d)).mul(brk);
    const foamCol = mix(col, vec3(1), 0.35);
    // A thin white-hot foam line along the crest over the first 1.5 m, so the wake keeps
    // its edge where it crosses a lane line of the same colour.
    // Where an arm crosses a lane line (|X| = 1.5 or 4.5 m on the track) the foam line
    // carries on along the whole arm and burns whiter, and the wall body dims a little
    // under it, so the carve stays readable over a line of its own colour.
    const X = v.x.add(trailAt(f)).add(side.mul(spreadAt(d)));
    const aX = abs(X);
    const l1 = aX.sub(1.5).div(0.32), l2 = aX.sub(4.5).div(0.32);
    const onLine = max(exp(l1.mul(l1).negate()), exp(l2.mul(l2).negate()));
    // The crest line is lit from the first station, so the V visibly grows out of the rails,
    // and on the beat it burns white-hot (x3): the track's beat chevrons are the same hue and
    // shape as the wake, and this is what keeps the wake the board's own.
    // A soft band over the crest, not a single hard line.
    const crestLine = exp(row.sub(1.05).mul(row.sub(1.05)).mul(-9)).mul(0.9).mul(smoothstep(0.0, 0.1, d))
      .mul(max(max(ramp(2.2, 1.2, d), onLine.mul(fade).mul(1.4)), beat.mul(fade))).mul(beat.mul(2).add(1));
    // The wall body does not pump with the beat (the track already does): on the beat the
    // wake's accent is its white crest line alone.
    const glowBody = I.mul(1.4).add(0.8);
    const bodyK = mix(faceK, float(1), smoothstep(0.9, 1.6, row).mul(0.6));
    const wall = col.mul(glowBody).mul(crest).mul(streak).add(foamCol.mul(foam.mul(glowBody).mul(0.2))).mul(wallLight).mul(float(1).sub(onLine.mul(0.35))).mul(bodyK)
      .add(mix(col, vec3(1), saturate(onLine.mul(0.2).add(0.28).add(beat.mul(0.4)))).mul(crestLine.mul(glow).mul(beat.mul(0.8).add(0.55))).mul(boost))
      .mul(v.spd.mul(0.6).add(0.4));
    // Spray: soft streaks with a bright head, white-hot at birth, cooling to the track colour.
    const r = length(vec3(fx.y, fx.z, 0)).mul(2);
    const disc = pow(saturate(float(1).sub(r)), 1.4).mul(fx.y.add(0.5).mul(0.7).add(0.3));
    const life = pow(float(1).sub(age), 1.5).mul(smoothstep(0.0, 0.12, age));
    const spray = mix(mix(col, vec3(1), 0.3).mul(1.1), col.mul(1.8), saturate(age.mul(2.5))).mul(disc).mul(life).mul(glow.mul(0.7)).mul(v.spd.mul(0.7).add(0.3));
    const rgb = halo.mul(isHalo).add(wall.mul(isWall)).add(spray.mul(isSpray));
    return vec4(rgb, shadeA);
  })();
  return m;
}

// ---- The vehicle ----

export class WaveVehicle {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.uniforms = uniforms;
    this.u = {
      time: uniform(0),
      phase: uniform(0),
      intensity: uniform(0),
      speed: uniform(0),
      flow: uniform(0), // metres travelled (wrapped), for patterns fixed to the track
      spd: uniform(0), // speed mapped to 0..1
      vx: uniform(0),
      x: uniform(0), // lateral position on the track, for the lane-line crossings
      hover: uniform(0.55),
      wakeLen: uniform(3),
      wakeH: uniform(0.2),
      spread: uniform(0.2),
      spray: uniform(1),
      trail: uniformArray(new Array(TRAIL_N).fill(0), 'float'),
      yaw: uniform(0), // board yaw, for the contact glow
    };
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.board = new THREE.Mesh(buildBoardGeometry(), boardMaterial(uniforms, this.u));
    this.wake = new THREE.Mesh(buildWakeGeometry(), wakeMaterial(uniforms, this.u));
    this.wake.frustumCulled = false;
    this.wake.renderOrder = 2;
    this.group.add(this.board, this.wake);
    scene.add(this.group);
    this._x = 0;
    this._vx = 0;
    this._speed = 0;
    this._hist = new Float32Array(HIST);
    this._head = 0;
    this._acc = 0;
    this._primed = false;
    this._bank = 0;
    this._yaw = 0;
    this._tr = new Float32Array(TRAIL_N); // scratch for smoothing the carve
    this._heave = 0;
    this._pitch = 0;
  }

  /**
   * Place the board on sample s at lateral x, banked by lateral velocity vx.
   * The group takes the unbanked track frame; the board banks inside it.
   */
  place(s, x, vx, origin, hover) {
    const m = this.group.matrix;
    const px = s.px + s.rx * x + s.ux * hover - origin.x;
    const py = s.py + s.ry * x + s.uy * hover - origin.y;
    const pz = s.pz + s.rz * x + s.uz * hover - origin.z;
    m.set(s.rx, s.ux, -s.fx, px, s.ry, s.uy, -s.fy, py, s.rz, s.uz, -s.fz, pz, 0, 0, 0, 1);
    this.group.matrixWorldNeedsUpdate = true;
    this._bank = Math.max(-0.45, Math.min(0.45, -vx * 0.018));
    this._yaw = Math.max(-0.25, Math.min(0.25, -vx * 0.006));
    this.board.rotation.set(this._pitch, this._yaw, this._bank, 'YXZ');
    this.board.position.y = this._heave;
    this._x = x;
    this._vx = vx;
    if (s.speed !== undefined) this._speed = s.speed;
    this.u.hover.value = hover;
    this.u.yaw.value = this._yaw;
    this.u.vx.value = vx;
    this.u.x.value = x;
    if (!this._primed) {
      this._hist.fill(x);
      this._primed = true;
    }
  }

  /** Lateral position `back` seconds ago, from the history ring. */
  _xAt(back) {
    const h = this._hist, acc = this._acc;
    if (back <= acc) return this._x + (h[this._head] - this._x) * (acc > 0 ? back / acc : 0);
    const j = Math.min(HIST - 2, (back - acc) / HIST_DT);
    const j0 = Math.floor(j), f = j - j0;
    const a = h[(this._head - j0 + HIST * 2) % HIST], b = h[(this._head - j0 - 1 + HIST * 2) % HIST];
    return a + (b - a) * f;
  }

  update(dt, songTime, beatPhase, intensity) {
    const u = this.u;
    if (dt > 0) {
      this._acc += dt;
      let steps = 0;
      while (this._acc >= HIST_DT && steps < HIST) {
        this._acc -= HIST_DT;
        this._head = (this._head + 1) % HIST;
        this._hist[this._head] = this._x;
        steps++;
      }
      if (this._acc > HIST_DT) this._acc = 0;
    }
    const speed = this._speed > 0 ? this._speed : this.uniforms.speed ? this.uniforms.speed.value : 0;
    const spd = Math.min(1, Math.max(0, (speed - 15) / 65));
    if (dt > 0) u.flow.value = (u.flow.value + dt * speed) % 4096;
    u.time.value = songTime;
    u.phase.value = beatPhase;
    u.intensity.value = intensity;
    u.speed.value = speed;
    u.spd.value = spd;
    u.wakeLen.value = 1.4 + 2.8 * spd;
    u.wakeH.value = 0.07 + 0.17 * spd + 0.06 * intensity;
    u.spread.value = 0.3 - 0.1 * spd;
    u.spray.value = 0.6 + 0.6 * spd + 0.3 * intensity;
    // The carve: where the board was when it passed each wake station, so
    // the wake stays attached under the tail and trails the lane change.
    // The lane-change spring is so quick that the raw history bends the arms into a hook (or,
    // slope-clamped, into two straight rules). So the carve's lateral slope is limited by a
    // bound that grows along the wake (0.12 m per metre under the tail, up to 0.8 m per metre
    // 4 m back), which bends each arm into a progressive arc, and then low-passed four times
    // along its length; the first station stays pinned under the tail.
    const tr = u.trail.array, tmp = this._tr, vs = Math.max(speed, 6);
    const step = WAKE_MAX / (TRAIL_N - 1);
    tmp[0] = 0;
    for (let k = 1; k < TRAIL_N; k++) {
      const raw = this._xAt((k * step) / vs) - this._x;
      const maxD = Math.min(0.8, 0.12 + 0.075 * k) * step;
      tmp[k] = Math.max(tmp[k - 1] - maxD, Math.min(tmp[k - 1] + maxD, raw));
    }
    for (let pass = 0; pass < 4; pass++) {
      let prev = tmp[0];
      for (let k = 1; k < TRAIL_N; k++) {
        const next = k < TRAIL_N - 1 ? tmp[k + 1] : tmp[k];
        const cur = tmp[k];
        tmp[k] = 0.25 * prev + 0.5 * cur + 0.25 * next;
        prev = cur;
      }
    }
    for (let k = 0; k < TRAIL_N; k++) tr[k] = tmp[k];
    // On each beat the hover field kicks: the board heaves up ~1.7 cm and lifts its nose ~0.5
    // degrees, eased in over the first 60 ms and settling through the beat, over a slow bob.
    const ph = Math.min(1, Math.max(0, beatPhase));
    const on = Math.min(1, ph / 0.12), ease = on * on * (3 - 2 * on);
    const kick = ease * Math.exp(-ph * 4.2);
    this._heave = 0.028 * kick + 0.005 * Math.sin(songTime * 2.3);
    this._pitch = 0.0145 * kick + 0.002 * Math.sin(songTime * 1.7 + 0.8);
    this.board.position.y = this._heave;
    this.board.rotation.x = this._pitch;
  }

  dispose() {
    this.scene.remove(this.group);
    this.board.geometry.dispose();
    this.board.material.dispose();
    this.wake.geometry.dispose();
    this.wake.material.dispose();
  }
}
