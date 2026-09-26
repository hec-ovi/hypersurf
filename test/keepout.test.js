import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perspective, multiply, project, convexHull, hitsZone, zoneFor } from '../src/ui/keepout.js';

const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

test('a point on the view axis projects to the screen centre; behind the camera it does not project', () => {
  const pv = multiply(perspective(90, 16 / 9, 0.1, 100), IDENTITY);
  assert.deepEqual(project(pv, 0, 0, -10, 1920, 1080).map(Math.round), [960, 540]);
  assert.equal(project(pv, 0, 0, 10, 1920, 1080), null);
  const up = project(pv, 0, 5, -10, 1920, 1080);
  assert.ok(up[1] < 540, 'up is toward the top of the screen');
});

test('the hull keeps only the outline', () => {
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
  assert.equal(hull.length, 4);
});

test('a rectangle near or inside the zone hits it; one far away does not', () => {
  const zone = [[400, 1080], [1520, 1080], [1000, 300], [920, 300]];
  assert.equal(hitsZone(zone, { x: 900, y: 600, w: 100, h: 100 }), true, 'inside');
  assert.equal(hitsZone(zone, { x: 56, y: 380, w: 142, h: 300 }), false, 'the left edge grid slot');
  assert.equal(hitsZone(zone, { x: 1480, y: 26, w: 380, h: 120 }), false, 'the sky band');
  assert.equal(hitsZone(zone, { x: 1540, y: 1000, w: 60, h: 60 }, 24), true, 'within the margin');
});

test('a track seen from a chase camera leaves the upper corners free', () => {
  // Camera 4.6 m up and 7.5 m back looking down the -z axis at a slight pitch.
  const pitch = (21 * Math.PI) / 180, c = Math.cos(pitch), s = Math.sin(pitch);
  // World-to-camera: rotate by +pitch about x after translating by -eye.
  const eye = [0, 4.6, 7.5];
  const view = Float64Array.from([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
  const ty = -(c * eye[1] + s * eye[2]), tz = -(-s * eye[1] + c * eye[2]);
  view[13] = ty; view[14] = tz;
  const edges = [];
  for (const d of [0, 10, 25, 60, 150, 650]) for (const x of [-5.1, 5.1]) edges.push([x, 0, -d]);
  const zone = zoneFor(view, 16 / 9, edges, 1920, 1080);
  assert.ok(zone.length >= 3);
  assert.equal(hitsZone(zone, { x: 56, y: 26, w: 480, h: 90 }), false, 'song cluster');
  assert.equal(hitsZone(zone, { x: 1500, y: 26, w: 360, h: 140 }), false, 'score cluster');
});
