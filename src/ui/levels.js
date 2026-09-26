// The special levels as selection-stage options (docs/art-direction.md
// §7.3): the numbers come from the SongMap modes and the level presets,
// each with an emblem turning on the pedestal. levelFacts() is pure
// (tested in Node); the caller passes create(id, parent) for the vehicle
// model the Nyan emblem rides.

import { MODES, LAYOUT } from '../audio/songmap.js';
import { LEVEL_PRESETS } from '../audio/levels.js';
import { VEHICLES } from '../game/vehicles/list.js';
import { rainbowAt } from '../game/palette.js';

export const LEVEL_ORDER = ['demo', 'nyan'];

/** What each level is: its song, where the song comes from and its preset (null: the plain map). */
export const LEVELS = Object.freeze({
  demo: Object.freeze({
    name: 'Hypersurf demo', title: 'hypersurf demo', icon: 'mark', preset: null, source: 'demo',
    length: '2:31', bpm: 128,
    desc: 'The synthesised demo song, exactly as it plays from the menu: a calm build, two drops and a break.',
  }),
  nyan: Object.freeze({
    name: 'Nyan Cat', title: 'Nyan Cat', icon: 'cat', preset: 'nyan', source: 'own',
    length: '3:37', bpm: 142,
    desc: 'Super fast. Speed rushes with every run of notes, with a loop, roll or flip every few seconds on a rainbow track.',
  }),
});

/** Big moments per minute a map aims for: one per featureGap (plus a twist) normally, or the preset's cycle. */
function momentsPerMinute(P) {
  if (!P) return 60 / (LAYOUT.featureGap + 2);
  const F = P.features;
  return 60 / (F.gap + LAYOUT.loopLength + F.window / 2);
}

/** Display numbers for a level, from the modes and its preset. */
export function levelFacts(id) {
  const P = LEVELS[id].preset ? LEVEL_PRESETS[LEVELS[id].preset] : null;
  const top = (k) => (LEVEL_PRESETS[LEVELS[k].preset] ? LEVEL_PRESETS[LEVELS[k].preset].speed.max : MODES.mono.speedMax);
  const rate = (k) => (LEVEL_PRESETS[LEVELS[k].preset] ? LEVEL_PRESETS[LEVELS[k].preset].maxRate : MODES.mono.maxRate);
  const moments = (k) => momentsPerMinute(LEVEL_PRESETS[LEVELS[k].preset] || null);
  const speed = top(id) / MODES.mono.speedMax;
  const fastest = Math.max(...LEVEL_ORDER.map((k) => top(k))) / MODES.mono.speedMax;
  const densest = Math.max(...LEVEL_ORDER.map(rate));
  const busiest = Math.max(...LEVEL_ORDER.map(moments));
  return {
    speed, speedText: `×${speed.toFixed(2).replace(/0$/, '')}`, speedFraction: speed / fastest,
    density: rate(id), densityText: String(rate(id)), densityFraction: rate(id) / densest,
    moments: moments(id), momentsText: String(Math.round(moments(id))), momentsFraction: moments(id) / busiest,
    vehicle: P && P.vehicle ? VEHICLES[P.vehicle].name : 'Your choice',
  };
}

/**
 * Stage options for the levels.
 * @param create      create(vehicleId, parent) builds a vehicle into a group
 * @param bestFor     bestFor(id) → the stored best text or '—'
 * @param sourceFor   sourceFor(id) → the source row's text
 */
export function levelOptions(create, bestFor = () => '—', sourceFor = () => '') {
  return LEVEL_ORDER.map((id) => {
    const L = LEVELS[id], f = levelFacts(id);
    return {
      id, name: L.name, desc: L.desc, icon: L.icon,
      gauges: [
        { label: 'Top speed', value: f.speedText, fraction: f.speedFraction },
        { label: 'Density', value: f.densityText, unit: '/s', fraction: f.densityFraction },
        { label: 'Moments', value: f.momentsText, unit: '/min', fraction: f.momentsFraction },
      ],
      get rows() {
        return [
          { label: 'Song', value: `${L.length} · ${L.bpm} BPM` },
          { label: 'Source', value: sourceFor(id) },
          { label: 'Vehicle', value: f.vehicle },
          { label: 'Rules', value: 'Your mode' },
          { label: 'Best', value: bestFor(id) },
        ];
      },
      build: id === 'nyan' ? (THREE, kit) => buildNyan(THREE, kit, create) : buildDemo,
    };
  });
}

// --- 3D emblems ----------------------------------------------------------------------

/** DEMO: the hypersurf mark (two nested peaks) over a ring of level bars. */
function buildDemo(THREE, kit) {
  const g = new THREE.Group();
  const peak = (w, h, t, depth) => {
    const s = new THREE.Shape();
    s.moveTo(-w, 0); s.lineTo(0, h); s.lineTo(w, 0); s.lineTo(w - t, 0); s.lineTo(0, h - t * 1.45); s.lineTo(-w + t, 0); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
    geo.translate(0, 0, -depth / 2);
    return geo;
  };
  const outerGeo = peak(1.15, 1.45, 0.24, 0.18), innerGeo = peak(0.62, 0.8, 0.2, 0.22);
  const mark = new THREE.Group();
  const outer = new THREE.Mesh(outerGeo, kit.tint(0x19e0a0, 1.6));
  const inner = new THREE.Mesh(innerGeo, kit.tint(0xff1f4b, 1.8));
  inner.position.set(0, 0, 0.08);
  mark.add(outer, kit.edges(outerGeo, kit.edge, 30), inner);
  mark.position.y = 0.95;
  g.add(mark);
  // A ring of level bars around the mark, swelling like a meter.
  const N = 40;
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 1, 0.07), kit.glow, N);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  g.add(bars);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  return {
    object: g,
    update(dt, t, still) {
      mark.position.y = 0.95 + (still ? 0 : Math.sin(t * 1.4) * 0.07);
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const h = still ? 0.3 : 0.18 + 0.32 * Math.abs(Math.sin(t * 2.1 + i * 0.9) * Math.sin(t * 0.7 + i * 0.37));
        p.set(Math.cos(a) * 1.75, h / 2 + 0.02, Math.sin(a) * 1.75);
        s.set(1, h, 1);
        m.compose(p, q, s);
        bars.setMatrixAt(i, m);
      }
      bars.instanceMatrix.needsUpdate = true;
    },
  };
}

/** NYAN: the Nyan vehicle riding inside a turning rainbow ring. */
function buildNyan(THREE, kit, create) {
  const g = new THREE.Group();
  const rainbow = new THREE.Group();
  const rgb = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    rainbowAt(i / 6, rgb);
    const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color().setRGB(rgb[0] * 1.6, rgb[1] * 1.6, rgb[2] * 1.6, THREE.LinearSRGBColorSpace) });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7 - i * 0.07, 0.032, 8, 120), mat);
    rainbow.add(ring);
  }
  rainbow.position.y = 1.35;
  g.add(rainbow);
  const holder = new THREE.Group(), inner = new THREE.Group();
  holder.add(inner);
  const cat = create ? create('nyan', inner) : null;
  if (cat && 'presentation' in cat) cat.presentation = false;
  if (cat && 'showStars' in cat) cat.showStars = false;
  holder.scale.setScalar(0.42);
  holder.position.y = 1.1;
  inner.position.z = -2.2;
  g.add(holder);
  const FLAT = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0, speed: 0 };
  const ORIGIN = { x: 0, y: 0, z: 0 };
  return {
    object: g,
    update(dt, t, still) {
      rainbow.rotation.set(still ? 0.2 : 0.2 + Math.sin(t * 0.5) * 0.15, 0, still ? 0 : t * 0.8);
      holder.position.y = 1.1 + (still ? 0 : Math.sin(t * 2.4) * 0.06);
      if (cat) {
        const beat = still ? 0 : (t * LEVELS.nyan.bpm) / 60;
        cat.place(FLAT, 0, 0, ORIGIN, 0);
        cat.update(still ? 0 : dt, t, beat - Math.floor(beat), 0.9);
      }
    },
  };
}
