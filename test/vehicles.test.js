import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLES, VEHICLE_ORDER, DEFAULT_VEHICLE, vehicleId } from '../src/game/vehicles/list.js';

test('every listed vehicle has a name, an icon and a description', () => {
  assert.ok(VEHICLE_ORDER.includes(DEFAULT_VEHICLE));
  assert.deepEqual([...VEHICLE_ORDER].sort(), Object.keys(VEHICLES).sort());
  for (const id of VEHICLE_ORDER) {
    const v = VEHICLES[id];
    assert.ok(v.name && v.icon && v.desc, id);
  }
});

test('unknown or stored junk vehicle ids fall back to the default', () => {
  for (const id of VEHICLE_ORDER) assert.equal(vehicleId(id), id);
  for (const bad of [undefined, null, '', 'toString', '__proto__', 'boat', 3]) assert.equal(vehicleId(bad), DEFAULT_VEHICLE);
});
