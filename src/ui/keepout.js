// The HUD keep-out zone (docs/art-direction.md §9.1): the track's shoulder
// edges from the ship to the draw distance, and the ship, projected into
// screen space with the camera's pose at its widest field of view; their
// convex hull plus a margin is where no HUD cluster may sit. Pure (tested in
// Node): matrices are plain 16-element column-major arrays.

export const ZONE_DISTANCES = [0, 10, 25, 60, 150, 650];
export const ZONE_HALF_WIDTH = 4.5 + 0.6;
export const WIDEST_FOV = 92;

/** Column-major perspective projection (as three.js builds it). */
export function perspective(fovDeg, aspect, near, far, out = new Float64Array(16)) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** a · b for column-major 4×4 matrices. */
export function multiply(a, b, out = new Float64Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Screen position (px, y down) of a world point, or null behind the camera. */
export function project(m, x, y, z, w, h) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 1e-6) return null;
  return [((cx / cw) * 0.5 + 0.5) * w, (0.5 - (cy / cw) * 0.5) * h];
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in screen space. */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Distance from point (x, y) to segment a–b. */
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/**
 * Whether a rectangle { x, y, w, h } comes within `margin` px of a convex
 * polygon: a corner inside or near it, or a polygon vertex inside the rect.
 */
export function hitsZone(poly, rect, margin = 24) {
  if (poly.length < 3) return false;
  const x0 = rect.x - margin, y0 = rect.y - margin, x1 = rect.x + rect.w + margin, y1 = rect.y + rect.h + margin;
  for (const v of poly) if (v[0] >= x0 && v[0] <= x1 && v[1] >= y0 && v[1] <= y1) return true;
  const corners = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]];
  for (const [x, y] of corners) {
    if (inside(poly, x, y)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist(x, y, poly[j], poly[i]) < margin) return true;
  }
  // Edges crossing the rect with no vertex or corner involved (a thin sliver).
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    for (let k = 1; k < 8; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / 8, y = a[1] + ((b[1] - a[1]) * k) / 8;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
    }
  }
  return false;
}

/**
 * The zone for a camera: `view` is its world-inverse matrix, `aspect` its
 * aspect ratio, `edges` world points [x, y, z] (already origin-relative).
 * The road in the lower half is carried down to the bottom edge.
 */
export function zoneFor(view, aspect, edges, w, h, near = 0.1, far = 2000) {
  const pv = multiply(perspective(WIDEST_FOV, aspect, near, far), view);
  const pts = [];
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) {
    const s = project(pv, e[0], e[1], e[2], w, h);
    if (!s) continue;
    pts.push(s);
    if (s[1] > h * 0.5) { lo = Math.min(lo, s[0]); hi = Math.max(hi, s[0]); }
  }
  // The road runs on under the camera to the bottom edge of the screen.
  if (lo <= hi) pts.push([Math.max(0, lo), h], [Math.min(w, hi), h]);
  return convexHull(pts);
}
