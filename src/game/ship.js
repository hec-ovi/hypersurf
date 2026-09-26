// The player's ship: a low, wide dart with a glowing thruster. Two meshes
// (hull and thruster) in one group, placed each frame from the track frame.

import * as THREE from 'three/webgpu';
import { shipMaterial, thrusterMaterial } from './materials.js';

/** Hull as a flat-shaded dart: nose at -z (forward), wide tail at +z. */
function hullGeometry() {
  const v = {
    nose: [0, 0.05, -1.9], tl: [-1.25, 0, 0.9], tr: [1.25, 0, 0.9], top: [0, 0.5, 0.35],
    bl: [-0.5, -0.12, 0.8], br: [0.5, -0.12, 0.8], tail: [0, 0.18, 1.0],
  };
  const tris = [
    [v.nose, v.top, v.tl], [v.nose, v.tr, v.top], // upper faces
    [v.top, v.tail, v.tl], [v.top, v.tr, v.tail], // upper rear
    [v.nose, v.tl, v.bl], [v.nose, v.br, v.tr], [v.nose, v.bl, v.br], // belly
    [v.tl, v.tail, v.bl], [v.tr, v.br, v.tail], [v.bl, v.tail, v.br], // rear plate
  ];
  const pos = [];
  for (const t of tris) for (const p of t) pos.push(...p);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class Ship {
  constructor(scene, uniforms) {
    this.group = new THREE.Group();
    this.hull = new THREE.Mesh(hullGeometry(), shipMaterial(uniforms));
    const flame = new THREE.ConeGeometry(0.28, 1.4, 10, 1, true);
    flame.rotateX(Math.PI / 2); // point +z (backwards)
    flame.translate(0, 0.18, 1.6);
    this.thruster = new THREE.Mesh(flame, thrusterMaterial(uniforms));
    this.group.add(this.hull, this.thruster);
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this._m = new THREE.Matrix4();
  }

  /**
   * Place the ship on sample s at lateral x, banked by lateral velocity vx.
   * Position is written relative to the floating origin.
   */
  place(s, x, vx, origin, hover) {
    const bank = Math.max(-0.45, Math.min(0.45, -vx * 0.018));
    const yaw = Math.max(-0.25, Math.min(0.25, -vx * 0.006));
    // Basis: right, up, back from the track frame, then yaw about up and bank about forward.
    const cb = Math.cos(bank), sb = Math.sin(bank), cy = Math.cos(yaw), sy = Math.sin(yaw);
    // Yaw first (rotate right/back around up).
    let rx = s.rx * cy - (-s.fx) * sy, ry = s.ry * cy - (-s.fy) * sy, rz = s.rz * cy - (-s.fz) * sy;
    const bx = s.rx * sy + (-s.fx) * cy, by = s.ry * sy + (-s.fy) * cy, bz = s.rz * sy + (-s.fz) * cy;
    // Bank: rotate right/up around back.
    let ux = s.ux, uy = s.uy, uz = s.uz;
    const nrx = rx * cb + ux * sb, nry = ry * cb + uy * sb, nrz = rz * cb + uz * sb;
    ux = ux * cb - rx * sb; uy = uy * cb - ry * sb; uz = uz * cb - rz * sb;
    rx = nrx; ry = nry; rz = nrz;
    const px = s.px + s.rx * x + s.ux * hover - origin.x;
    const py = s.py + s.ry * x + s.uy * hover - origin.y;
    const pz = s.pz + s.rz * x + s.uz * hover - origin.z;
    this._m.set(rx, ux, bx, px, ry, uy, by, py, rz, uz, bz, pz, 0, 0, 0, 1);
    this.group.matrix.copy(this._m);
    this.group.matrixWorldNeedsUpdate = true;
  }
}
