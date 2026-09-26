// The three modes as selection-stage options (docs/art-direction.md §7.3):
// exact numbers from the code (RULES and the SongMap MODES), and a crafted
// 3D emblem for each. modeFacts() is pure (tested in Node).

import { RULES, GREY_EFFECT, COLUMNS, ROWS } from '../game/rules.js';
import { MODES } from '../audio/songmap.js';

export const MODE_ORDER = ['casual', 'mono', 'ninja'];
const DIFFICULTY = { casual: 1, mono: 2, ninja: 3 };
const NAME = { casual: 'Casual', mono: 'Mono', ninja: 'Ninja' };
const DESC = {
  casual: 'Slower, sparser and forgiving: a longer match timer and safe shoulders to rest on.',
  mono: 'The classic. Catch blocks into 3×7 grid matches; greys take a block away.',
  ninja: 'Faster and denser. Dodge the spikes: one hit wipes your whole grid.',
};
const ICON = { casual: 'casual', mono: 'mono', ninja: 'ninja' };

const trim = (x) => String(Math.round(x * 100) / 100);

/** Display numbers for a mode, taken from the rules and the SongMap parameters. */
export function modeFacts(id) {
  const r = RULES[id], m = MODES[id];
  const speed = m.speedMax / MODES.mono.speedMax;
  const fastest = Math.max(...MODE_ORDER.map((k) => MODES[k].speedMax / MODES.mono.speedMax));
  const densest = Math.max(...MODE_ORDER.map((k) => MODES[k].maxRate));
  const bonus = r.stealth > 0 ? `Stealth +${Math.round(r.stealth * 100)}%` : r.cleanFinish > 0 ? `Clean finish +${Math.round(r.cleanFinish * 100)}%` : '—';
  return {
    speed, speedText: `×${speed.toFixed(2).replace(/0$/, '')}`, speedFraction: speed / fastest,
    density: m.maxRate, densityText: trim(m.maxRate), densityFraction: m.maxRate / densest,
    difficulty: DIFFICULTY[id],
    timer: `${trim(r.timer)} s`,
    hazards: r.grey === GREY_EFFECT.ERASE_ALL ? 'Spikes erase all' : 'Greys erase one',
    shoulders: r.shoulders ? 'Safe' : '—',
    bonus,
  };
}

/** Stage options for the modes; bestFor(id) gives the stored best text or '—'. */
export function modeOptions(bestFor = () => '—') {
  return MODE_ORDER.map((id) => {
    const f = modeFacts(id);
    return {
      id, name: NAME[id], desc: DESC[id], icon: ICON[id],
      gauges: [
        { label: 'Speed', value: f.speedText, fraction: f.speedFraction },
        { label: 'Density', value: f.densityText, unit: '/s', fraction: f.densityFraction },
        { label: 'Difficulty', value: String(f.difficulty), unit: '/3', fraction: f.difficulty / 3 },
      ],
      get rows() {
        return [
          { label: 'Match timer', value: f.timer },
          { label: 'Hazards', value: f.hazards },
          { label: 'Shoulders', value: f.shoulders },
          { label: 'Bonus', value: f.bonus, cls: 'lime' },
          { label: 'Best', value: bestFor(id) },
        ];
      },
      build: BUILD[id],
    };
  });
}

// --- 3D emblems ----------------------------------------------------------------------

const BLOCK_COLOURS = [0x0fa3ff, 0x19e0a0, 0xffd23a, 0x3a2cff, 0xff7a1a];

/** MONO: one glowing block hovering over a 3×7 grid of dark tiles. */
function buildMono(THREE, kit) {
  const g = new THREE.Group();
  const tile = new THREE.BoxGeometry(0.46, 0.08, 0.3);
  const lit = [[0, 0, 0], [1, 0, 1], [2, 0, 2], [1, 1, 0], [0, 1, 4], [2, 2, 1]]; // col, row, colour
  const litMats = BLOCK_COLOURS.map((c) => kit.tint(c, 0.95));
  for (let col = 0; col < COLUMNS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const hit = lit.find(([c, r]) => c === col && r === row);
      const mesh = new THREE.Mesh(tile, hit ? litMats[hit[2]] : kit.dark);
      mesh.position.set((col - 1) * 0.56, 0.12, (3 - row) * 0.38);
      const edges = kit.edges(tile, hit ? kit.edge : kit.edgeDim);
      edges.position.copy(mesh.position);
      g.add(mesh, edges);
    }
  }
  // Lane rails either side of the columns.
  for (let k = 0; k < 4; k++) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 2.8), kit.glowSoft);
    rail.position.set((k - 1.5) * 0.56, 0.1, 0);
    g.add(rail);
  }
  const cubeGeo = new THREE.BoxGeometry(0.62, 0.62, 0.62);
  const cube = new THREE.Group();
  cube.add(new THREE.Mesh(cubeGeo, new THREE.MeshStandardNodeMaterial({ color: 0x0f5a50, emissive: 0x19e0a0, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.25 })));
  cube.add(kit.edges(new THREE.BoxGeometry(0.66, 0.66, 0.66), kit.edge));
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.64, 64), kit.glowSoft);
  halo.rotation.x = -Math.PI / 2;
  g.add(cube, halo);
  g.position.y = 0.05;
  return {
    object: g,
    update(dt, t, still) {
      const bob = still ? 0 : Math.sin(t * 1.6) * 0.12;
      cube.position.set(0, 1.55 + bob, 0);
      cube.rotation.set(0.35, still ? 0.6 : t * 0.9, 0.2);
      halo.position.y = 0.2;
      halo.scale.setScalar(1 + (still ? 0 : Math.sin(t * 1.6) * 0.06));
    },
  };
}

/** NINJA: a four-spike shuriken with a bright hub, spinning on its own axis. */
function buildNinja(THREE, kit) {
  const shape = new THREE.Shape();
  const R = 1.35, r = 0.34;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    // Curved blades: inner vertices swept a little.
    const sweep = i % 2 === 0 ? 0 : 0.22;
    const x = Math.cos(a + sweep) * rad, y = Math.sin(a + sweep) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 16 });
  geo.center();
  const star = new THREE.Group();
  star.add(new THREE.Mesh(geo, kit.steel));
  star.add(kit.edges(geo, kit.edge, 30));
  const hub = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.035, 12, 48), kit.glow);
  star.add(hub);
  // Spike tips glow.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.34, 12), kit.tint(0xff5a4a, 2.4));
    tip.position.set(Math.cos(a) * (R + 0.08), Math.sin(a) * (R + 0.08), 0);
    tip.rotation.z = a - Math.PI / 2;
    star.add(tip);
  }
  const g = new THREE.Group();
  g.add(star);
  return {
    object: g,
    update(dt, t, still) {
      star.position.y = 1.55 + (still ? 0 : Math.sin(t * 1.3) * 0.08);
      star.rotation.set(-0.18, 0, still ? 0.3 : -t * 2.2);
    },
  };
}

/** CASUAL: a soft wide ring with a thin shoulder lane either side. */
function buildCasual(THREE, kit) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.26, 32, 120), kit.glass);
  const core = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 12, 120), kit.glow);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.022, 10, 100), kit.glowSoft);
  const outer = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.022, 10, 120), kit.glowSoft);
  const ringGroup = new THREE.Group();
  ringGroup.add(ring, core, inner, outer);
  // Lane markers riding around the ring.
  const marks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.03, 0.03), kit.white, 24);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    m.makeRotationZ(a).setPosition(Math.cos(a) * 1.44, Math.sin(a) * 1.44, 0);
    marks.setMatrixAt(i, m);
  }
  ringGroup.add(marks);
  g.add(ringGroup);
  return {
    object: g,
    update(dt, t, still) {
      ringGroup.position.y = 1.5 + (still ? 0 : Math.sin(t * 1.1) * 0.07);
      ringGroup.rotation.set(-1.05, 0, still ? 0 : t * 0.35);
      marks.rotation.z = still ? 0 : t * 0.6;
    },
  };
}

const BUILD = { mono: buildMono, ninja: buildNinja, casual: buildCasual };
