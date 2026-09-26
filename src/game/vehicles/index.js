// The vehicle registry. Every vehicle implements one interface:
//
//   constructor(scene, uniforms)   builds its meshes and adds them to scene
//   group                          the object placed on the track
//   place(s, x, vx, origin, hover) pose on track sample s at lateral x with
//                                  lateral velocity vx, floating-origin relative
//   update(dt, songTime, beatPhase, intensity)
//                                  animate; runs every frame after place()
//   dispose()                      remove from the scene, free GPU resources
//
// Optional: `camera` (the chase camera, read by vehicles that present
// themselves to it) and `presentation` (false on the selection stage).

import { DartVehicle } from './dart.js';
import { vehicleId } from './list.js';

export { VEHICLES, VEHICLE_ORDER, DEFAULT_VEHICLE, vehicleId } from './list.js';

const CLASSES = { dart: DartVehicle };

/** A new vehicle of kind `id` (unknown ids get the default) in `scene`. */
export function createVehicle(id, scene, uniforms) {
  return new CLASSES[vehicleId(id)](scene, uniforms);
}
