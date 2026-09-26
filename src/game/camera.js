// Chase camera (docs/research.md §4): a calm pose high and back, an intense
// pose lower and closer, blended by smoothed intensity on critically damped
// springs (ω = 6 rad/s). The springs act on the offset in the track frame,
// not on world position, so the camera never falls behind at 90 m/s. The
// frame itself is smoothed a little, which gives turns and corkscrews
// their weight. A swoop-in flies down from high above before the song.

import * as THREE from 'three/webgpu';

const DEG = Math.PI / 180;
const CALM = { h: 4.6, d: 7.5, pitch: 21 };
const INTENSE = { h: 3.2, d: 5.2, pitch: 17 };
const SWOOP = { h: 40, d: 60, pitch: 34, side: 24 };
const OMEGA = 6;

/** One critically damped scalar spring. */
class Spring {
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(dt, target, w = OMEGA) {
    const e0 = this.x - target, k = Math.exp(-w * dt), c = this.v + w * e0;
    this.x = target + (e0 + c * dt) * k;
    this.v = (this.v - w * c * dt) * k;
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
}

const lerp = (a, b, t) => a + (b - a) * t;
const smoother = (u) => u * u * u * (u * (6 * u - 15) + 10);

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.f = [0, 0, -1];
    this.u = [0, 1, 0];
    this.lat = new Spring();
    this.h = new Spring(CALM.h);
    this.d = new Spring(CALM.d);
    this.pitch = new Spring(CALM.pitch);
    this.bank = new Spring();
    this.fov = 72;
    this.maxFov = 95;
    this._target = new THREE.Vector3();
  }

  /** Snap to the frame of sample s (start of a run). */
  reset(s) {
    this.f[0] = s.fx; this.f[1] = s.fy; this.f[2] = s.fz;
    this.u[0] = s.ux; this.u[1] = s.uy; this.u[2] = s.uz;
    this.lat.snap(0);
    this.h.snap(SWOOP.h);
    this.d.snap(SWOOP.d);
    this.pitch.snap(SWOOP.pitch);
    this.bank.snap(0);
    this.fov = 72;
  }

  /**
   * @param s      track sample at the ship
   * @param shipX  ship lateral position, vx its velocity (m/s)
   * @param I      smoothed intensity 0..1
   * @param swoop  0 at the start of the swoop-in, 1 once it is over
   * @param juice  { fov, kick } punch terms
   */
  update(dt, s, shipX, vx, I, swoop, juice, origin) {
    // Smooth the frame (forward a little more than up, so corkscrews stay readable).
    const kf = 1 - Math.exp(-dt * 10), ku = 1 - Math.exp(-dt * 18);
    const f = this.f, u = this.u;
    f[0] += (s.fx - f[0]) * kf; f[1] += (s.fy - f[1]) * kf; f[2] += (s.fz - f[2]) * kf;
    u[0] += (s.ux - u[0]) * ku; u[1] += (s.uy - u[1]) * ku; u[2] += (s.uz - u[2]) * ku;
    let l = Math.hypot(f[0], f[1], f[2]) || 1;
    f[0] /= l; f[1] /= l; f[2] /= l;
    const dot = u[0] * f[0] + u[1] * f[1] + u[2] * f[2];
    u[0] -= dot * f[0]; u[1] -= dot * f[1]; u[2] -= dot * f[2];
    l = Math.hypot(u[0], u[1], u[2]) || 1;
    u[0] /= l; u[1] /= l; u[2] /= l;
    const r0 = f[1] * u[2] - f[2] * u[1], r1 = f[2] * u[0] - f[0] * u[2], r2 = f[0] * u[1] - f[1] * u[0];

    // Pose: calm ↔ intense, blended from the swoop.
    const e = smoother(Math.min(1, Math.max(0, swoop)));
    const chaseH = lerp(CALM.h, INTENSE.h, I), chaseD = lerp(CALM.d, INTENSE.d, I), chaseP = lerp(CALM.pitch, INTENSE.pitch, I);
    const h = swoop < 1 ? lerp(SWOOP.h, chaseH, e) : this.h.step(dt, chaseH);
    const d = swoop < 1 ? lerp(SWOOP.d, chaseD, e) : this.d.step(dt, chaseD);
    const p = swoop < 1 ? lerp(SWOOP.pitch, chaseP, e) : this.pitch.step(dt, chaseP);
    if (swoop < 1) { this.h.snap(h); this.d.snap(d); this.pitch.snap(p); }
    const side = swoop < 1 ? SWOOP.side * (1 - e) : 0;
    const lat = this.lat.step(dt, shipX * 0.5) + side;
    const back = d + (juice ? juice.kick : 0);

    const cam = this.camera;
    cam.position.set(
      s.px + r0 * lat + u[0] * h - f[0] * back - origin.x,
      s.py + r1 * lat + u[1] * h - f[1] * back - origin.y,
      s.pz + r2 * lat + u[2] * h - f[2] * back - origin.z,
    );
    // Look down by the pose pitch, turning in toward the ship during the swoop.
    const pr = p * DEG, cp = Math.cos(pr), sp = Math.sin(pr);
    const aim = -side * 0.02;
    const dx = f[0] * cp - u[0] * sp + r0 * aim, dy = f[1] * cp - u[1] * sp + r1 * aim, dz = f[2] * cp - u[2] * sp + r2 * aim;
    // Bank with lateral velocity (0.4°/(m/s), capped at 8°).
    const bank = this.bank.step(dt, Math.max(-8, Math.min(8, 0.4 * vx)) * DEG, 10);
    const cb = Math.cos(bank), sb = Math.sin(bank);
    cam.up.set(u[0] * cb + r0 * sb, u[1] * cb + r1 * sb, u[2] * cb + r2 * sb);
    this._target.set(cam.position.x + dx, cam.position.y + dy, cam.position.z + dz);
    cam.lookAt(this._target);

    // FOV 72 → 92 with intensity, rate-limited to 20°/s, plus punches.
    const want = 72 + 20 * I;
    const step = 20 * dt;
    this.fov += Math.max(-step, Math.min(step, want - this.fov));
    const fov = Math.min(this.maxFov, this.fov + (juice ? juice.fov : 0));
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
