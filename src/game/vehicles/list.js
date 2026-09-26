// The vehicles as data: ids, names, one-line descriptions and icons. Pure
// (no three.js), so the menu and the tests can read it; index.js maps the
// ids to the classes. A vehicle is only a look: every one flies the same
// ship motion and collides the same way.

export const VEHICLE_ORDER = Object.freeze(['dart', 'wave', 'nyan']);
export const DEFAULT_VEHICLE = 'dart';

export const VEHICLES = Object.freeze({
  dart: Object.freeze({ name: 'Dart', icon: 'ship', desc: 'The original: a low, wide dart with a glowing thruster.' }),
  wave: Object.freeze({ name: 'Wave', icon: 'board', desc: 'A neon hover-surfboard that carves a wake of light into the track.' }),
  nyan: Object.freeze({ name: 'Nyan', icon: 'cat', desc: 'A voxel cat on a toaster pastry, trailing a rainbow and bopping to the beat.', credit: 'Nyan Cat by Chris Torres · fan tribute' }),
});

/** A known vehicle id, or the default. */
export function vehicleId(id) {
  return Object.prototype.hasOwnProperty.call(VEHICLES, id) ? id : DEFAULT_VEHICLE;
}
