// The vehicles as selection-stage options (docs/art-direction.md §7.3): the
// real in-game models turning on the pedestal, square-on (no presentation
// yaw), animated on a steady 120 BPM beat. Pure: the caller passes
// create(id, parent), which builds a vehicle into a three.js group.

import { VEHICLES, VEHICLE_ORDER } from '../game/vehicles/list.js';

/** A flat track frame at the origin: forward -z, up +y, right +x. */
const FLAT = Object.freeze({ px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0, speed: 0 });
const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });
/**
 * Framing on the pedestal: the models are about 3.5 m long and the stage's
 * emblems fill about 2.8 m. NYAN's rainbow runs some 5 m behind the cat, so
 * it is drawn smaller and moved forward (z, model metres) to turn about the
 * middle of cat and rainbow together.
 */
const FRAMING = { dart: { scale: 0.8, z: 0 }, wave: { scale: 0.8, z: 0 }, nyan: { scale: 0.55, z: -2.2 } };
const LIFT = 1.1;
const STAGE_BPM = 120;

/** Stage options for the vehicles. */
export function vehicleOptions(create) {
  return VEHICLE_ORDER.map((id) => {
    const v = VEHICLES[id];
    const rows = [{ label: 'Handling', value: 'Same for all' }, { label: 'Hitbox', value: 'Same for all' }];
    if (v.credit) rows.push({ label: 'Tribute', value: v.credit, cls: 'lime' });
    return {
      id, name: v.name, desc: v.desc, icon: v.icon, gauges: [], rows,
      build(THREE) {
        const frame = FRAMING[id] || FRAMING.dart;
        const holder = new THREE.Group(), inner = new THREE.Group();
        holder.add(inner);
        const vehicle = create(id, inner);
        if ('presentation' in vehicle) vehicle.presentation = false;
        if ('showStars' in vehicle) vehicle.showStars = false;
        holder.scale.setScalar(frame.scale);
        holder.position.y = LIFT;
        inner.position.z = frame.z;
        return {
          object: holder,
          update(dt, t, still) {
            const beat = still ? 0 : (t * STAGE_BPM) / 60;
            vehicle.place(FLAT, 0, 0, ORIGIN, 0);
            vehicle.update(still ? 0 : dt, t, beat - Math.floor(beat), 0.5);
          },
        };
      },
    };
  });
}
