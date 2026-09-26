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

test('the vehicle stage shows every vehicle, placed on a flat frame and animated on the beat', async () => {
  const { vehicleOptions } = await import('../src/ui/vehicles.js');
  const made = [];
  const create = (id, parent) => {
    const v = { id, parent, presentation: true, calls: [], place(...a) { this.calls.push(['place', ...a]); }, update(...a) { this.calls.push(['update', ...a]); } };
    made.push(v);
    return v;
  };
  const opts = vehicleOptions(create);
  assert.deepEqual(opts.map((o) => o.id), [...VEHICLE_ORDER]);
  const FakeThree = { Group: class { constructor() { this.scale = { setScalar: (k) => { this.k = k; } }; this.position = { y: 0, z: 0 }; this.children = []; } add(c) { this.children.push(c); } } };
  for (const o of opts) {
    assert.equal(o.name, VEHICLES[o.id].name);
    assert.ok(o.rows.length >= 2);
    const built = o.build(FakeThree);
    const v = made[made.length - 1];
    assert.ok(built.object.children.includes(v.parent), 'built into the stage holder');
    assert.equal(v.presentation, false, 'square-on on the stage');
    built.update(1 / 60, 0.25, false);
    const [, s, x, vx, , hover] = v.calls[0];
    assert.deepEqual([s.fz, s.uy, s.rx, x, vx, hover], [-1, 1, 1, 0, 0, 0]);
    const [, dt, t, phase] = v.calls[1];
    assert.equal(dt, 1 / 60);
    assert.equal(t, 0.25);
    assert.ok(Math.abs(phase - 0.5) < 1e-9, '120 BPM: a quarter second is half a beat');
    built.update(1 / 60, 0.25, true);
    assert.equal(v.calls[3][1], 0, 'calm visuals: it stands still');
  }
});
