// Sampling the SongMap's track nodes at any song time. Pure; no DOM/GPU.
//
// Nodes sit at 30 Hz. Positions are interpolated with a uniform Catmull-Rom
// spline so the ship and camera move smoothly through node boundaries; the
// frame (forward, up) is interpolated linearly and re-orthonormalised, and
// right = forward × up. Track position is a pure function of song time, so
// nothing can drift.

export class TrackPath {
  /** @param nodes SongMap nodes ({ rate, t0, count, pos, fwd, up, dist, speed, intensity, color, roll, loop }) */
  constructor(nodes) {
    this.nodes = nodes;
    this.rate = nodes.rate;
    this.t0 = nodes.t0;
    this.count = nodes.count;
    this.tEnd = this.t0 + (this.count - 1) / this.rate;
  }

  /** Fractional node index at song time t, clamped to the track. */
  indexAt(t) {
    const x = (t - this.t0) * this.rate;
    return x < 0 ? 0 : x > this.count - 1 ? this.count - 1 : x;
  }

  /**
   * Everything about the track at song time t, written into `out` (no allocation):
   * px/py/pz position (float64), fx/fy/fz forward, ux/uy/uz up, rx/ry/rz right,
   * intensity, speed, dist, r/g/b colour, loop (type of the nearest node).
   */
  sample(t, out) {
    const nd = this.nodes, n = this.count;
    const x = this.indexAt(t);
    let i = Math.floor(x);
    if (i > n - 2) i = n - 2;
    const f = x - i;
    const a = i > 0 ? i - 1 : 0, b = i, c = i + 1, d = i + 2 < n ? i + 2 : n - 1;
    const pos = nd.pos;
    out.px = catmullRom(pos[a * 3], pos[b * 3], pos[c * 3], pos[d * 3], f);
    out.py = catmullRom(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1], f);
    out.pz = catmullRom(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2], pos[d * 3 + 2], f);

    const F = nd.fwd, U = nd.up, g = 1 - f;
    let fx = F[b * 3] * g + F[c * 3] * f, fy = F[b * 3 + 1] * g + F[c * 3 + 1] * f, fz = F[b * 3 + 2] * g + F[c * 3 + 2] * f;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let ux = U[b * 3] * g + U[c * 3] * f, uy = U[b * 3 + 1] * g + U[c * 3 + 1] * f, uz = U[b * 3 + 2] * g + U[c * 3 + 2] * f;
    const dot = ux * fx + uy * fy + uz * fz;
    ux -= dot * fx; uy -= dot * fy; uz -= dot * fz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    out.fx = fx; out.fy = fy; out.fz = fz;
    out.ux = ux; out.uy = uy; out.uz = uz;
    out.rx = fy * uz - fz * uy;
    out.ry = fz * ux - fx * uz;
    out.rz = fx * uy - fy * ux;

    out.intensity = nd.intensity[b] * g + nd.intensity[c] * f;
    out.speed = nd.speed[b] * g + nd.speed[c] * f;
    out.dist = this.distanceAt(t);
    const C = nd.color;
    out.r = C[b * 3] * g + C[c * 3] * f;
    out.g = C[b * 3 + 1] * g + C[c * 3 + 1] * f;
    out.b = C[b * 3 + 2] * g + C[c * 3 + 2] * f;
    out.loop = nd.loop[f < 0.5 ? b : c];
    return out;
  }

  /** Distance along the track at song time t (extrapolated at the end speeds). */
  distanceAt(t) {
    const nd = this.nodes, n = this.count;
    const x = (t - this.t0) * this.rate;
    if (x <= 0) return nd.dist[0] + x / this.rate * nd.speed[0];
    if (x >= n - 1) return nd.dist[n - 1] + (x - (n - 1)) / this.rate * nd.speed[n - 1];
    const i = Math.floor(x), f = x - i;
    return nd.dist[i] + (nd.dist[i + 1] - nd.dist[i]) * f;
  }

  /** Song time at distance d along the track (inverse of distanceAt). */
  timeAtDistance(d) {
    const nd = this.nodes, D = nd.dist, n = this.count;
    if (d <= D[0]) return this.t0 + (d - D[0]) / Math.max(1e-6, nd.speed[0]);
    if (d >= D[n - 1]) return this.tEnd + (d - D[n - 1]) / Math.max(1e-6, nd.speed[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (D[m] <= d) lo = m; else hi = m;
    }
    const span = D[hi] - D[lo];
    return this.t0 + (lo + (span > 0 ? (d - D[lo]) / span : 0)) / this.rate;
  }
}

/** Uniform Catmull-Rom between p1 and p2. */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

/** A reusable sample record for TrackPath.sample. */
export function makeSample() {
  return { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0, intensity: 0, speed: 0, dist: 0, r: 0, g: 0, b: 0, loop: 0 };
}
