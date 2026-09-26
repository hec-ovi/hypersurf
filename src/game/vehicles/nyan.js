// NYAN: a voxel Nyan Cat on a Pop-Tart, trailing a stepped six-band
// rainbow. Implements the vehicle interface (see index.js).
//
// The cat is hand-authored voxel sprites meshed with hidden faces culled,
// baked face shading and vertex AO, in separately animated parts: the body
// (Pop-Tart and paws), the head, and a four-segment tail. All parts live in
// one geometry (a per-vertex part index) and one unlit material whose vertex
// stage moves each part by its own matrix uniform, so head bop, tail wag and
// body bob are continuous functions of the beat phase, not stepped frames.
// Only the paw paddle is stepped: four geometries (one per quarter beat)
// differ in the paws only, and one is visible at a time: 1 draw call. The
// rainbow and the sparkle stars are one CPU-written box strip in world space
// (floating-origin relative), opaque and never brighter than their base
// colour (nothing in it reaches the bloom threshold), dimming toward the far
// end: 1 draw call. Nothing is allocated per frame.
//
// Animation (beat phase b in [0, 1), n = beats counted so far):
//  - head: hops on every beat and lands ON the beat: a landing squash (y
//    -18 %, x/z +12 %) with a nose-down dip peaks right after the beat and
//    settles by b = 0.14; it takes off at b = 0.36 and rises four voxels on a
//    hang-time arc (apex b = 0.68), stretched (y +16 %, x/z -6 %) about its
//    middle so the ears clear the tart's top crust from the chase camera
//    while the chin stays over the tart's front edge, nodding nose-up and
//    rolling 0.2 rad toward the top (to the other side every beat);
//  - body: rises one voxel and settles against the head: lowest at the
//    head's apex, highest just after the landing;
//  - tail: four segments swinging once per beat, each lagging the one before
//    by 0.12 beat with growing amplitude (the tip follows through). Side on
//    (square-on, and an outer lane) the swing is up and down; straight behind
//    (centre lane) it is a side-to-side wag of up to 1 rad from a low rest,
//    the tip sweeping past both sides of the tart; eased between the two by
//    the cat's turn.
//
// Model axes (as Ship): forward -z, up +y, right +x. The sprite's canonical
// side (head on the right of the picture) is the +x flank; the -x flank
// carries the mirrored sprite. In play (`presentation = true`) the cat is
// drawn 25 % larger and presents itself to the chase camera: with the camera
// straight behind (centre lane) it runs dead straight (yaw 0, roll 0); in an
// outer lane, with the camera looking in from the side (the ship's distance
// from the track centre easing from 0.75 to 2.25 m and the camera's lateral
// offset from the ship from CENTRE_OFF to SIDE_OFF_M; the smaller of the two
// counts) the cat turns the flank the camera is on toward it by up to 0.45 rad
// and rolls that flank up by up to 0.18 rad.
// The flank comes from the camera's offset along the track's right vector
// with hysteresis (±0.3 m); the turn is zero wherever that flag can flip, so
// it never shows. Set `camera` to the chase camera (the game's view does
// `vehicle.camera = camera`); without one the vehicle models the chase camera's
// lateral spring itself. A critically damped spring turns the cat. The picker
// sets `presentation = false` for a square-on, unscaled model with a neutral
// gait (the head bop, tail wag and body bob keep running). update() must run
// every frame after place() (it steps the springs and poses the parts).
//
// Depth is built as an extruded sprite with a shell: sprite colours
// (outline, eyes, cheeks, mouth, sprinkles) sit on the outermost layer of
// each part and on both side faces, so both profiles are the sprite pixel
// for pixel; the layers between carry the base colour, except where the
// outline turns a corner (a sprite pixel with open neighbours both along and
// across), so the top, front, back and belly show grey framed by a black
// rim. The head is two layers wider than the body (it overhangs it by one
// more layer each side, as ref-2). Its back panel is cat grey; its front
// panel a step darker, carrying a one-voxel-deep front view of the face.
// The ear rows split across the depth into a left and a right ear at the
// head's outer corners, each black on its flank layer and grey inside, the
// stepped inner edge included, so from behind, above or ahead each ear is a
// clean pointed grey triangle with a single black rim, not a checkerboard of
// black and grey steps (the profiles are unchanged). Paws use
// two-tone voxels: the outline is black on the flanks but grey on the rear,
// top and front faces, so from the chase camera a paw is a grey block with a
// grey toe tip. Tail segments are 3 x 3 x 4 voxels: black-grey-black stripes
// on the flanks, two-tone so the top, belly and end caps are grey (from
// behind, a grey bar edged by the black flank stroke).
//
// The rainbow is six boxes per segment, one per band, stacked along the
// segment's "stack" axis. Square-on (picker) the stack is vertical all the
// way, as tall as the tart (the reference profile). In play it leaves the
// tart vertical, twists over the first segment and lies flat from the
// second on: a thin, low ribbon with the six bands side by side, red toward
// the side the camera was last on. That choice is a spring recorded into
// the path history, so when it changes the ribbon does not flip: a half
// twist (the flat ribbon pinching to a line and opening mirrored) is laid
// down at that point and runs off down the trail. The wave jogs alternate
// segments one band along the stack axis on the half beat. Neighbouring
// boxes only meet back to back (no coplanar faces facing the same way).

import * as THREE from 'three/webgpu';
import { attribute, vec3, vec4, float, abs, dot, pow, min, smoothstep, select, uniform, positionGeometry, normalView, positionViewDirection, Fn } from 'three/tsl';
import { VoxelGrid, meshVoxels, bridgeEdgeContacts, linearRGB, boxIndices, writeBoxColor, writeBoxCorners, BOX_FACES } from './voxels.js';

/** Voxel edge, metres. The model is 15 × 23 × 34 voxels: 1.2 × 1.84 × 2.72 m (× 1.25 in play: 3.4 m). */
const V = 0.08;
const NX = 15, NY = 23, NU = 34;
/** The body (Pop-Tart, paws) is 13 layers wide, starting at layer BL; the head overhangs it by one more layer each side (ref-2). */
const BL = 1;
/** Height of the lowest voxel row relative to the ship origin (hover 0.55 m puts the paws 10 cm above the track in play). */
const Y0 = -0.36;
/** Model-space z of the centre of sprite column u (the model's origin sits at u = 15). */
const zOfU = (u) => (15 - u) * V;
/**
 * In-game presentation: the yaw toward the camera (rad) and the roll of that
 * flank up toward it once the camera looks in from the side, eased in by the
 * camera's lateral offset from CENTRE_OFF (straight behind: yaw 0, roll 0)
 * to SIDE_OFF_M; the yaw spring (rad/s, ~0.25 s) and the model scale.
 */
const YAW_SIDE = 0.45, ROLL_SIDE = 0.18;
const CENTRE_OFF = 0.9, SIDE_OFF_M = 1.4;
/**
 * The turn is also gated by the ship's own distance from the track centre
 * (m; lanes are 3 m apart): none in the centre lane, full from 2.25 m out, so
 * the chase camera lagging on the far side while the ship returns to the
 * centre never turns the cat the other way.
 */
const LANE_CENTRE = 0.75, LANE_SIDE = 2.25;
const YAW_MAX = 0.8, BANK_MAX = 0.3, YAW_OMEGA = 18, PRESENT_SCALE = 1.25;
/** Ribbon twist side spring (rad/s): how fast the red side follows the camera side. */
const TW_OMEGA = 14;
/** Camera side hysteresis (m of camera offset along the track's right vector): the side flips only past ±SIDE_OFF. */
const SIDE_OFF = 0.3;
/** Fallback camera model (no `camera` set): ChaseCamera's lateral spring, ω 6 toward half the ship's offset. */
const CAM_OMEGA = 6, CAM_FOLLOW = 0.5;

// ---- Palette (sRGB; converted to linear for the vertex colours) ----
const PALETTE = {
  K: '#24242e', // outline (lifted off the #05060A sky so the silhouette survives)
  G: '#9c9ca4', // cat grey
  g: '#8a8a92', // cat grey, head front and back panels (recede behind the face)
  W: '#ffffff', // eye glint
  P: '#ff97a6', // cheeks
  c: '#f8e2b3', // crust core (the thicker step, a value darker than the border)
  C: '#fff0cc', // crust border (pale cream, ref-1)
  F: '#ff9be9', // frosting
  S: '#e8189c', // sprinkles
  k: null, // two-tone: outline K on the ±x flanks, grey G on every other face
  u: null, // head underside: grey G, its belly face lifted to side-face brightness (a rolled, raised head shows it)
};
const KEYS = Object.keys(PALETTE);
const INDEX = Object.fromEntries(KEYS.map((k, i) => [k, i + 1]));
const COLORS = [null, ...KEYS.map((k) => (PALETTE[k] ? linearRGB(PALETTE[k]) : null))];
{
  const K = linearRGB(PALETTE.K), G = linearRGB(PALETTE.G);
  COLORS[INDEX.k] = [K, K, G, G, G, G];
  // The belly face gets FACE_SHADE[-y] (0.52); lift it to about 0.8 so the
  // head's underside, shown from the side while the head is up and rolled
  // toward the camera, reads as more of the grey head, not a dark slab.
  const Gu = G.map((c) => c * (0.8 / 0.52));
  COLORS[INDEX.u] = [G, G, G, Gu, G, G];
}

// ---- Sprite layers. Rows are written top first; '.' is empty. ----

// Head, 19 × 16, facing +u (forward). Pointed ears, black outline, 2 × 2
// eyes with a white glint, pink cheeks, a nose pixel and the "w" mouth.
const HEAD = [
  '..KK...........KK..',
  '..KGK.........KGK..',
  '..KGGK.......KGGK..',
  '..KGGGK.....KGGGK..',
  '.KGGGGGKKKKKGGGGGK.',
  'KGGGGGGGGGGGGGGGGGK',
  'KGGGGGGGGGGGGGGGGGK',
  'KGGGGWKGGGGGWKGGGGK',
  'KGGGGKKGGKGGKKGGGGK',
  'KGGGGGGGGGGGGGGGGGK',
  'KGPPGGGGGGGGGGGPPGK',
  'KGPPGGKGGKGGKGGPPGK',
  'KGGGGGGKKGKKGGGGGGK',
  'KGGGGGGGGGGGGGGGGGK',
  '.KGGGGGGGGGGGGGGGK.',
  '..KKKKKKKKKKKKKKK..',
];
/**
 * Pop-Tart rows (crust core; the border is one row in, the frosting three)
 * and head placement: the chin hangs one row below the tart's bottom and the
 * ear tips sit three rows under its top (ref-1), so a band of frosting shows
 * above the head and between the ears.
 */
const TART_R0 = 4, TART_R1 = 21;
const HEAD_U = 13, HEAD_ROW = TART_R0 - 1;
/**
 * Ears: the sprite's top EAR_ROWS rows. Across the head's depth each ear row
 * is split into a left and a right ear that share the flank layers (so both
 * profiles are the sprite exactly) and narrow one layer per row toward the
 * tip on their inner side. Seen from behind, the front or above, the head
 * therefore has a pair of pointed ears at its outer corners (a cat's head
 * seen end-on), each grey with a single black rim (the flank layer
 * outside), not one full-width slab. Per sprite row (top
 * first): the ear width in layers.
 */
const EAR_ROWS = 4;
const EAR_W = [3, 4, 5, 6];
/**
 * The head's front panel (sprite rows 5..13 of its front column, NX layers,
 * left = -x): a one-voxel-deep front view of the same face, eyes with the
 * glint, nose, pink cheeks and the "w" mouth on the darker panel grey, for
 * the picker and turntable (the chase camera never sees it).
 */
const FRONT_FACE = [
  'KgggggggggggggK',
  'KgggggggggggggK',
  'KgggWKgggWKgggK',
  'KgggKKgKgKKgggK',
  'KgggggggggggggK',
  'KgPPgggggggPPgK',
  'KgPPKggKggKPPgK',
  'KggggKKgKKggggK',
  'KgggggggggggggK',
];
const FRONT_ROW0 = 5;

// Tail: a chain of TAIL_SEGS segments (its own animated parts), each 3
// layers deep, 3 voxels tall and 4 long, pivoting TAIL_PITCH voxels apart so
// each one overlaps the next by a voxel (no gap opens at a bend). The chain
// leaves the tart's rear at row 16 (above the play ribbon, which tops out at
// row 14 there) one voxel inside the crust. Every segment swings once per
// beat, lagging the one before by TAIL_LAG (the tip follows through), with
// amplitudes growing toward the tip. The swing is weighted by where it is
// seen from:
//  - side on (square-on hero, and an outer lane where the cat has turned its
//    flank to the camera): up and down about a raised rest (TAIL_REST,
//    TAIL_AMP), plus in play a side-to-side wag of TAIL_LAT_SIDE × TAIL_LAT;
//  - straight behind (centre lane, cat running straight): side to side
//    (TAIL_LAT, up to 1 rad at the tip) about a low rest (TAIL_REST_C: the
//    tail leaves the crust sideways instead of pointing up at the lens), the
//    tip lifting a little at both ends of the sweep (TAIL_LIFT_C, a smile
//    arc), so the tip sweeps past both silhouette edges of the tart.
// The two blend by how far the cat is turned (the yaw spring), so a lane
// change eases between them. Square-on the tail stays in the plane of the
// hero rainbow's flank, in front of it (no side-to-side wag).
const TAIL_SEGS = 4, TAIL_PITCH = 3;
const TAIL_Y = Y0 + 16 * V, TAIL_Z = zOfU(4) - 0.5 * V;
const TAIL_REST = [0.3, 0.42, 0.55, 0.65];
const TAIL_AMP = [0.45, 0.55, 0.65, 0.75];
const TAIL_REST_C = [0.04, 0.1, 0.17, 0.24];
const TAIL_LIFT_C = [0.08, 0.12, 0.16, 0.2];
const TAIL_LAT = [0.6, 0.75, 0.88, 1.0];
const TAIL_LAT_SIDE = 0.45;
/** Phase lag per segment (beats): the tip trails the base. */
const TAIL_LAG = 0.12;
/** Odd segments are drawn a hair slimmer so overlapping segments never share a face plane. */
const TAIL_SLIM = 0.92;

// A stubby paw (ref-1): 3 wide and 4 tall with a toe forward on the third
// row (an L). 'k' is two-tone: black on the flanks (the sprite outline) but
// grey on the rear, top and front faces, so from behind a paw is a grey
// block and its toe a 2 × 1 grey tip.
const LEG = ['kGK.', 'kGK.', 'kGGk', 'KKKK'];

// Sprinkles on the frosting (u, row), same pattern on both faces, hand
// scattered over the frosting the head leaves visible (u 7..14, and the
// band above the head and between the ears).
const SPRINKLES = [
  [8, 17], [11, 18], [14, 18], [13, 16], [10, 15], [7, 14], [12, 13],
  [9, 12], [11, 10], [8, 9], [12, 8], [10, 7], [9, 16],
  [18, 18], [20, 17], [21, 15],
  // Under the head, shown while it is up on the bop.
  [16, 8], [19, 7], [18, 10], [21, 9],
];

// Paw paddle: four frames on the beat, diagonal pairs moving two voxels
// each way (so the gait reads at chase distance). Everything else moves
// continuously through the part matrices (see update()).
const FRAMES = [
  { legA: -2, legB: 2 },
  { legA: 0, legB: 0 },
  { legA: 2, legB: -2 },
  { legA: 0, legB: 0 },
];
/** Parts (the aPart vertex attribute): body, head, tail segments. */
const PART_BODY = 0, PART_HEAD = 1, PART_TAIL = 2, PARTS = PART_TAIL + TAIL_SEGS;
/**
 * Head bop, a hop that lands ON every beat: from the beat it sits in a
 * landing squash (y down HEAD_SQUASH, x/z out HEAD_SPREAD, about the chin's
 * underside) that peaks within a few hundredths of a beat and settles by
 * HEAD_LAND, nodding nose-down into it (HEAD_DIP); it takes off HEAD_UP beats
 * after the beat and is airborne until the next beat on a hang-time arc
 * (1 - w^4) that peaks HEAD_HOP above rest (four voxels), stretched (y up
 * HEAD_STRETCH, x/z in HEAD_THIN) about the head's middle (the ears rise past
 * the tart's top crust from the chase camera while the chin lags, so the
 * chin keeps overlapping the tart's front edge), nodding nose-up (HEAD_NOD)
 * and rolling HEAD_ROLL toward the top, to the other side every beat. Nod
 * and roll are about the neck (u 18, the chin's underside); scale is centred
 * on the head's middle column (u 22).
 */
const HEAD_PIVOT_Y = Y0 + HEAD_ROW * V, HEAD_PIVOT_Z = zOfU(18), HEAD_MID_Z = zOfU(22);
const HEAD_HALF_H = (HEAD.length / 2) * V;
const HEAD_HOP = 4 * V, HEAD_UP = 0.36, HEAD_LAND = 0.14;
const HEAD_STRETCH = 0.16, HEAD_THIN = 0.06, HEAD_SQUASH = 0.18, HEAD_SPREAD = 0.12;
const HEAD_NOD = 0.16, HEAD_DIP = 0.1, HEAD_ROLL = 0.2;
/** Beat phase of the top of the hop. */
const HEAD_APEX = (HEAD_UP + 1) / 2;
/** Body bob (m, model space): one voxel, against the head: lowest at the head's apex, highest just after the landing. */
const BODY_BOB = V;
/** Paw columns (u): the far pair (-x) sits five columns behind the near pair, so the two silhouettes separate in the profiles. */
const PAW_BACK_FAR = 5, PAW_BACK_NEAR = 10, PAW_FRONT_FAR = 15, PAW_FRONT_NEAR = 20;

/** Rounded rectangle test: inside [u0,u1]×[r0,r1] with `cut` cells shaved off each corner diagonal. */
function inRounded(u, r, u0, u1, r0, r1, cut) {
  if (u < u0 || u > u1 || r < r0 || r > r1) return false;
  const du = Math.min(u - u0, u1 - u), dr = Math.min(r - r0, r1 - r);
  return du + dr >= cut;
}

/** Sprite pixel (i, j) or '.' outside. */
const px = (rows, i, j) => (i < 0 || i >= rows.length || j < 0 || j >= rows[i].length ? '.' : rows[i][j]);
/**
 * The colour of an interior layer of an extruded sprite: grey, except an
 * outline pixel where the outline turns a corner (open above or below AND
 * open before or behind), so each flat run of top, front, back and belly
 * gets a black rim at its ends. With `endGrey` (the head), every pixel on the
 * front run (open ahead) takes that darker grey instead, so the front panel
 * recedes behind the face; the back panel stays cat grey (the chase camera
 * sees it).
 */
function innerChar(rows, i, j, endGrey) {
  const openL = px(rows, i, j - 1) === '.', openR = px(rows, i, j + 1) === '.';
  const openH = openL || openR;
  if (endGrey && openR) return endGrey;
  if (rows[i][j] === 'K') {
    const openV = px(rows, i - 1, j) === '.' || px(rows, i + 1, j) === '.';
    if (openV && openH) return 'K';
  }
  return 'G';
}
/** Set cell (layer, row, u) of a model grid (grid x = layer, y = row, z = NU-1-u). */
function putCell(g, layer, row, u, ch) { if (ch !== '.') g.set(layer, row, NU - 1 - u, INDEX[ch]); }

/** The body of one paw frame: the Pop-Tart and the four paws. */
function bodyGrid(fr) {
  const g = new VoxelGrid(NX, NY, NU);
  // A paw: the sprite on the outer and inner flank layers, grey between.
  const paw = (u0, rowTop, l0, l1) => {
    for (let i = 0; i < LEG.length; i++) for (let j = 0; j < LEG[i].length; j++) {
      const ch = LEG[i][j];
      if (ch === '.') continue;
      for (let l = l0; l <= l1; l++) putCell(g, l, rowTop - i, u0 + j, l === l0 || l === l1 ? ch : 'G');
    }
  };
  // Legs: back pair under the Pop-Tart's rear, front pair under the head;
  // far legs on the -x side, near legs on the +x side, staggered as in the
  // sprite. Each is 4 layers deep, one layer proud of the frosting face. The
  // paws hang from the tart, so the head can bop clear of them.
  paw(PAW_BACK_FAR + fr.legB, 3, BL + 1, BL + 4);
  paw(PAW_BACK_NEAR + fr.legA, 3, BL + 8, BL + 11);
  paw(PAW_FRONT_FAR + fr.legA, 3, BL + 1, BL + 4);
  paw(PAW_FRONT_NEAR + fr.legB, 3, BL + 8, BL + 11);

  // Pop-Tart: crust core, a crust border one step thinner, raised frosting.
  for (let u = 4; u <= 24; u++) for (let r = TART_R0; r <= TART_R1; r++) {
    if (inRounded(u, r, 4, 24, TART_R0, TART_R1, 2)) for (let l = BL + 4; l <= BL + 8; l++) putCell(g, l, r, u, 'c');
    if (inRounded(u, r, 5, 23, TART_R0 + 1, TART_R1 - 1, 2)) { putCell(g, BL + 3, r, u, 'C'); putCell(g, BL + 9, r, u, 'C'); }
    if (inRounded(u, r, 7, 21, TART_R0 + 3, TART_R1 - 3, 2)) { putCell(g, BL + 2, r, u, 'F'); putCell(g, BL + 10, r, u, 'F'); }
  }
  for (const [u, r] of SPRINKLES) { putCell(g, BL + 2, r, u, 'S'); putCell(g, BL + 10, r, u, 'S'); }
  // No two voxels may touch along an edge only (a non-manifold edge).
  bridgeEdgeContacts(g);
  return g;
}

/**
 * The head, layers 0..NX-1, an extruded sprite with a shell: the flank
 * layers carry the sprite (outline on the outer layers everywhere, no
 * chamfer, so each profile is the sprite exactly), the layers between the
 * base grey with a black rim where the outline turns. The ear rows split
 * into a left and a right ear (EAR_W), each the sprite on its flank layer and
 * grey inside, the stepped inner edge included (a black inner edge showed
 * from behind, above and the chase camera as a checkerboard of black risers
 * and grey treads), so each ear is one grey triangle with a single black rim
 * (the flank's outline). The front column carries FRONT_FACE.
 */
function headGrid() {
  const g = new VoxelGrid(NX, NY, NU);
  const top = HEAD_ROW + HEAD.length - 1, last = NX - 1;
  for (let i = 0; i < HEAD.length; i++) for (let j = 0; j < HEAD[i].length; j++) {
    const ch = HEAD[i][j];
    if (ch === '.') continue;
    const row = top - i, u = HEAD_U + j;
    if (i < EAR_ROWS) {
      const w = EAR_W[i];
      for (let l = 0; l < w; l++) {
        const c = l === 0 ? ch : 'G';
        putCell(g, l, row, u, c);
        putCell(g, last - l, row, u, c);
      }
      continue;
    }
    let inner = innerChar(HEAD, i, j, 'g');
    if (inner === 'G' && i === HEAD.length - 1) inner = 'u'; // the chin's underside
    for (let l = 0; l <= last; l++) putCell(g, l, row, u, l === 0 || l === last ? ch : inner);
  }
  for (let k = 0; k < FRONT_FACE.length; k++) {
    const i = FRONT_ROW0 + k, j = HEAD[i].lastIndexOf('K');
    for (let l = 0; l <= last; l++) putCell(g, l, top - i, HEAD_U + j, FRONT_FACE[k][l]);
  }
  bridgeEdgeContacts(g);
  return g;
}

/**
 * One tail segment, 3 layers (x) × 3 rows (y) × 4 long (z, pointing back
 * from its joint). Flanks: black, grey, black (the sprite's rimmed stroke);
 * the outline voxels are two-tone (black on the flanks only), so the top,
 * belly and end caps are all grey: from behind or above the tail is a grey
 * bar edged by its black flank stroke, not a dark block over the cream
 * crust. The tip closes its flank stripe with black and shows a grey end cap.
 */
function tailGrid(tip) {
  const g = new VoxelGrid(3, 3, 4);
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) {
    const flank = x !== 1;
    const ch = !flank ? 'G' : y !== 1 || (tip && z === 3) ? 'k' : 'G';
    g.set(x, y, z, INDEX[ch]);
  }
  return g;
}

/** Concatenate meshed parts into one indexed geometry with a per-vertex part index. */
function mergeParts(parts) {
  let nv = 0, ni = 0;
  for (const { geo } of parts) { nv += geo.attributes.position.count; ni += geo.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), part = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v0 = 0, i0 = 0;
  for (const { geo, id } of parts) {
    const n = geo.attributes.position.count;
    pos.set(geo.attributes.position.array, v0 * 3);
    nor.set(geo.attributes.normal.array, v0 * 3);
    col.set(geo.attributes.color.array, v0 * 3);
    part.fill(id, v0, v0 + n);
    const src = geo.index.array;
    for (let k = 0; k < src.length; k++) idx[i0 + k] = src[k] + v0;
    v0 += n; i0 += src.length;
    geo.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** The whole cat for one paw frame: body (part 0), head (1) and tail segments (2..), each in its own rest frame. */
function catGeometry(fr) {
  const org = [-(NX / 2) * V, Y0, -(NU - 15.5) * V];
  const parts = [
    { geo: meshVoxels(bodyGrid(fr), COLORS, { size: V, origin: org }), id: PART_BODY },
    { geo: meshVoxels(headGrid(), COLORS, { size: V, origin: org }), id: PART_HEAD },
  ];
  for (let i = 0; i < TAIL_SEGS; i++) {
    // Segment space: the joint at the origin, the segment along +z (back), a voxel of overlap behind the joint.
    const geo = meshVoxels(tailGrid(i === TAIL_SEGS - 1), COLORS, { size: V, origin: [-1.5 * V, -1.5 * V, -1 * V] });
    if (i & 1) {
      const p = geo.attributes.position.array;
      for (let k = 0; k < p.length; k += 3) { p[k] *= TAIL_SLIM; p[k + 1] *= TAIL_SLIM; }
    }
    parts.push({ geo, id: PART_TAIL + i });
  }
  return mergeParts(parts);
}

/**
 * Unlit vertex colours, a small neutral rim lift on dark faces at grazing
 * angles, and the hit flash. The vertex stage places each part by its own
 * matrix uniform (`mats[part]`, model space).
 */
function catMaterial(u, mats) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.positionNode = Fn(() => {
    const part = attribute('aPart', 'float');
    const p = vec4(positionGeometry, 1);
    let out = mats[0].mul(p).xyz;
    for (let i = 1; i < mats.length; i++) out = select(part.greaterThan(i - 0.5), mats[i].mul(p).xyz, out);
    return out;
  })();
  m.colorNode = Fn(() => {
    const base = attribute('color', 'vec3');
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 3);
    const lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
    // No lift on faces seen almost edge-on (the step risers of the ears and
    // outline in a pure profile), which would read as smooth grey wedges.
    const lift = min(rim.mul(float(1).sub(lum).max(0)).mul(smoothstep(0.12, 0.35, facing)).mul(0.12), 0.12);
    return base.mul(0.95).add(vec3(lift)).add(vec3(u.shipFlash.mul(1.5)));
  })();
  return m;
}

/** Trail: opaque unlit vertex colours (the fade is baked in), a gentle beat pulse, never above the base colour (below the bloom threshold). */
function trailMaterial(u) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = attribute('color', 'vec3').mul(min(u.beat.mul(0.22).add(u.intensity.mul(0.08)).add(0.8), 1.0));
  return m;
}

// ---- Rainbow trail and stars ----
const RAINBOW = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff'].map(linearRGB);
const BANDS = 6;
const SEG = 8; // segments
const SEG_LEN = 8 * V; // metres per segment (the sprite's wave step, before the presentation scale)
/*
 * Per boundary (SEG + 1), in voxels (× the presentation scale): the band
 * width along the stack axis, the band thickness across it, the height of
 * the stack's centre relative to the anchor (row 13), and the twist of the
 * stack axis from straight up toward the camera side (rad).
 * In play: the rainbow leaves the tart's rear vertical at mid-body (rows
 * 8-14, under the tail, as both references), twists over the first segment
 * and lies flat from the second on, a 1 m ribbon 18 cm above the track, so
 * from the chase camera it never covers the tart or the tail and never hides
 * upcoming blocks.
 */
const BW = [1, 1.3, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5];
const TH = [2.4, 1.3, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6];
const HC = [-2, -8.6, -12.2, -12.2, -12.2, -12.2, -12.2, -12.2, -12.2];
const TWIST = [0, 0.95, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2];
// Square-on (the picker's hero profile, ref-1): vertical all the way, three
// voxels a band (as tall as the tart), bottom two rows below the tart,
// 1.6 voxels thick: thinner than the tail (3) so the tail reads in front of
// it on both sides, and narrow enough from behind to leave the cat in view.
const BW_HERO = [3, 3, 3, 3, 3, 2.8, 2.6, 2.4, 2.2];
const BOTTOM_HERO = [-11, -11, -11, -11, -11, -10.8, -10.6, -10.4, -10.2];
const TH_HERO = 1.6;
/** The wave: alternate segments (never the first) jog along the stack axis by this many band widths on the half beat. */
const WAVE_PLAY = [0, 1, 1, 1, 1, 0.5, 0.5, 0.5], WAVE_HERO = 1 / 3;
/** Per boundary: brightness (dims toward the far end) and, in play, a taper of band width and thickness (the far end thins out to a point). */
const FADE_PLAY = [1, 1, 1, 0.94, 0.84, 0.7, 0.56, 0.42, 0.3];
const FADE_HERO = [1, 1, 1, 1, 1, 1, 0.96, 0.9, 0.82];
const BD_TAPER = [1, 1, 1, 1, 1, 1, 0.8, 0.5, 0.15];
/** Face shade of a band box: +stack (the red edge), -stack, ±thickness (the broad faces), ±along (end caps and wave risers). */
const TRAIL_SHADE = [0.9, 0.8, 1, 1, 0.78, 0.78];
/** Longest lateral step (m, before scale) from one boundary to the next, so a lane change bends the trail instead of shearing it. */
const MAX_LAT = [0, 0, 0.25, 0.45, 0.7, 1, 1.5, 2.5, 3];
const LIFT = 0.012; // keeps band faces off the voxel planes of the tail (no coplanar faces)
// The trail starts one voxel inside the Pop-Tart, behind its rear face, at
// row 13 (model space): the stack's front end is buried in the crust.
const ANCHOR_ROW = 13;
const ANCHOR_Y = Y0 + ANCHOR_ROW * V, ANCHOR_Z = (NU - 4 - (NU - 15.5)) * V - V;
const STARS = 8, STAR_BOXES = 4;
const STAR_V = 0.08; // star pixel, metres
const STAR_RGB = [0.95, 0.95, 1.0]; // near-white, a hair cool (linear), as ref-2's sparkles
const STAR_SHADE = [1, 1, 1, 1, 1, 1];
/** Star twinkle shapes on the beat: dot, plus, big plus, plus. [thick arm, thin tip] half-lengths in star pixels. */
const STAR_SHAPES = [[0.5, 0], [1.5, 0], [1.5, 3], [1.5, 0]];

const BAND_BOXES = SEG * BANDS;
const BOXES = BAND_BOXES + STARS * STAR_BOXES;
const HIST = 512, HS = 14; // history ring: V, anchor xyz (absolute), track xyz, right xyz, up xyz, ribbon side (-1..1)

export class NyanVehicle {
  constructor(scene, uniforms) {
    this.scene = scene;
    /** true in play (yaw and roll toward the chase camera, 1.25 scale); false for a square-on model with a neutral gait. */
    this.presentation = true;
    /** The chase camera (optional): its position picks the flank the cat presents. Without it the camera's lateral spring is modelled. */
    this.camera = null;
    /** Sparkle stars around the track (play only); a viewer can turn them off. */
    this.showStars = true;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    // Part matrices (model space), posed in update(); identity is the rest pose.
    this._partU = [];
    for (let i = 0; i < PARTS; i++) this._partU.push(uniform(new THREE.Matrix4()));
    this.material = catMaterial(uniforms, this._partU);
    this.frames = FRAMES.map((fr, i) => {
      const mesh = new THREE.Mesh(catGeometry(fr), this.material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false; // the parts move off the rest-pose bounds
      mesh.visible = i === 0;
      this.group.add(mesh);
      return mesh;
    });
    this._frame = 0;
    scene.add(this.group);

    // Trail + stars: one opaque box strip (six band boxes per segment, then
    // the star boxes). Band colours are band × face shade × the boundary's
    // fade, rewritten only when the presentation mode changes.
    const g = new THREE.BufferGeometry();
    this._pos = new Float32Array(BOXES * 72);
    this._col = new Float32Array(BOXES * 72);
    for (let n = BAND_BOXES; n < BOXES; n++) writeBoxColor(this._col, n, STAR_RGB, 1, STAR_SHADE);
    this._colMode = null;
    this._posAttr = new THREE.BufferAttribute(this._pos, 3);
    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    this._colAttr = new THREE.BufferAttribute(this._col, 3);
    g.setAttribute('position', this._posAttr);
    g.setAttribute('color', this._colAttr);
    g.setIndex(new THREE.BufferAttribute(boxIndices(BOXES), 1));
    this.trailMaterial = trailMaterial(uniforms);
    this.trail = new THREE.Mesh(g, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.matrixAutoUpdate = false;
    scene.add(this.trail);

    // Presentation state: camera side (+1 = camera on the ship's -x side), yaw spring.
    this._side = -1;
    this._x = 0; // ship lateral position (m), for the fallback camera model
    this._camLat = 0; // fallback camera model: lateral offset from the track centre (m)
    this._camLatV = 0;
    this._camOff = 0; // camera offset along the track's right vector from the ship (m), for inspection
    this._yaw = 0; // spring position (rad)
    this._yawV = 0;
    this._yawTarget = 0;
    this._sideness = 0; // 0: camera straight behind (centre lane) .. 1: camera looking in from the side
    this._yawOut = 0; // applied yaw, spring + velocity push, clamped
    this._rollOut = 0; // applied roll
    this._tw = 1; // ribbon side spring: +1 red toward +x, -1 toward -x (follows -_side)
    this._twV = 0;
    this._beatN = 0; // beats counted (beat phase wraps), for the head's alternating roll
    this._lastBp = 0;
    this._pm = new THREE.Matrix4(); // scratch for the part poses

    // Scratch (no per-frame allocation).
    this._base = new THREE.Matrix4();
    this._yawM = new THREE.Matrix4();
    this._rollM = new THREE.Matrix4();
    this._f = new Float64Array(12); // unyawed, banked ship frame: right, up, back, position (origin-relative)
    this._tf = new Float64Array(12); // track frame at the ship: right, up, back, centre (origin-relative)
    this._origin = new Float64Array(3);
    this._track = new Float64Array(3); // track point (absolute)
    this._anchor = new Float64Array(3); // trail anchor (origin-relative)
    this._hist = new Float64Array(HIST * HS);
    this._hHead = -1;
    this._hCount = 0;
    this._dist = 0; // distance travelled (m), from speed × dt
    this._speed = 0;
    this._wave = 0;
    this._twinkle = 0;
    this._time = 0;
    this._placed = false;
    this._everPlaced = false;
    this._bP = new Float64Array((SEG + 1) * 3);
    this._bR = new Float64Array((SEG + 1) * 3);
    this._bU = new Float64Array((SEG + 1) * 3);
    this._A = new Float64Array((SEG + 1) * 3); // per boundary: stack axis (unit)
    this._B = new Float64Array((SEG + 1) * 3); // per boundary: thickness axis (unit), B = back × A
    this._C = new Float64Array((SEG + 1) * 3); // per boundary: stack centre (origin-relative)
    this._W = new Float64Array(SEG + 1); // per boundary: band width (m)
    this._T = new Float64Array(SEG + 1); // per boundary: half thickness (m)
    this._S = new Float64Array(SEG + 1); // per boundary: ribbon side (-1..1)
    this._c = new Float32Array(24);
    this._buildTrail();
  }

  /** The yaw applied to the model (rad), for inspection. */
  get yaw() { return this._yawOut; }
  /** The roll applied to the model (rad), for inspection. */
  get roll() { return this._rollOut; }
  /** The camera's offset from the ship along the track's right vector (m), for inspection. */
  get cameraOffset() { return this._camOff; }

  /** Place on sample s at lateral x, banked by lateral velocity vx (as Ship.place), yawed and rolled toward the chase camera. */
  place(s, x, vx, origin, hover) {
    const present = this.presentation;
    const sc = present ? PRESENT_SCALE : 1;
    const bank = Math.max(-BANK_MAX, Math.min(BANK_MAX, -vx * 0.018));

    // Ship position (origin-relative, unbanked).
    const px = s.px + s.rx * x + s.ux * hover - origin.x;
    const py = s.py + s.ry * x + s.uy * hover - origin.y;
    const pz = s.pz + s.rz * x + s.uz * hover - origin.z;

    // Camera-aware presentation: turn the flank the camera is really on
    // toward it. The side is the camera's offset from the ship along the
    // track's right vector (the chase camera lags the ship in a lane
    // change, so this is not the ship's lane), with hysteresis: inside
    // ±SIDE_OFF the current side is kept. The camera is read as it was
    // posed last frame (the game places the ship before the camera); a
    // jump beyond 60 m (an origin rebase) keeps the side for that frame.
    if (!this._everPlaced) { this._camLat = x * CAM_FOLLOW; this._camLatV = 0; }
    this._x = x;
    let off;
    if (this.camera) {
      const cp = this.camera.position;
      off = (cp.x - px) * s.rx + (cp.y - py) * s.ry + (cp.z - pz) * s.rz;
      if (!(Math.abs(off) < 60)) off = 0;
    } else {
      off = this._camLat - x;
    }
    this._camOff = off;
    if (off > SIDE_OFF) this._side = -1; // camera on the +x side: present the +x flank (yaw -)
    else if (off < -SIDE_OFF) this._side = 1;
    // Straight behind (|off| up to CENTRE_OFF) or in the centre lane: run
    // dead straight. Camera looking in from the side and the ship out in a
    // side lane: turn the camera's flank toward it. Eased in between, and
    // zero wherever the side flag can flip, so the flip never shows.
    const camSide = smooth01((Math.abs(off) - CENTRE_OFF) / (SIDE_OFF_M - CENTRE_OFF));
    const laneSide = smooth01((Math.abs(x) - LANE_CENTRE) / (LANE_SIDE - LANE_CENTRE));
    const sideness = present ? Math.min(camSide, laneSide) : 0;
    this._sideness = sideness;
    // Lateral velocity only ever leans the turn further toward the side being
    // presented, only as far as the cat is turned at all, and through the
    // spring (never a step).
    let push = Math.max(-0.15, Math.min(0.15, vx * 0.004)) * sideness;
    if (!present || push * this._side < 0) push = 0;
    this._yawTarget = present ? this._side * YAW_SIDE * sideness + push : 0;
    if (!this._everPlaced || !present) { this._yaw = this._yawTarget; this._yawV = 0; }
    if (!this._everPlaced) { this._tw = -this._side; this._twV = 0; }
    const yaw = Math.max(-YAW_MAX, Math.min(YAW_MAX, this._yaw));
    this._yawOut = yaw;
    // Roll the presented flank up toward the camera, in step with the yaw spring (0 when straight).
    const roll = present ? -yaw * (ROLL_SIDE / YAW_SIDE) : 0;
    this._rollOut = roll;

    const cb = Math.cos(bank), sb = Math.sin(bank);
    let rx = s.rx, ry = s.ry, rz = s.rz;
    const bx = -s.fx, by = -s.fy, bz = -s.fz;
    let ux = s.ux, uy = s.uy, uz = s.uz;
    const nrx = rx * cb + ux * sb, nry = ry * cb + uy * sb, nrz = rz * cb + uz * sb;
    ux = ux * cb - rx * sb; uy = uy * cb - ry * sb; uz = uz * cb - rz * sb;
    rx = nrx; ry = nry; rz = nrz;
    this._base.set(rx, ux, bx, px, ry, uy, by, py, rz, uz, bz, pz, 0, 0, 0, 1);
    this._yawM.makeRotationY(yaw);
    this._rollM.makeRotationZ(roll);
    const m = this.group.matrix;
    m.multiplyMatrices(this._base, this._yawM).multiply(this._rollM);
    const e = m.elements;
    for (let i = 0; i < 11; i++) if ((i & 3) !== 3) e[i] *= sc;
    this.group.matrixWorldNeedsUpdate = true;

    const f = this._f;
    f[0] = rx; f[1] = ry; f[2] = rz; f[3] = ux; f[4] = uy; f[5] = uz; f[6] = bx; f[7] = by; f[8] = bz; f[9] = px; f[10] = py; f[11] = pz;
    const tf = this._tf;
    tf[0] = s.rx; tf[1] = s.ry; tf[2] = s.rz; tf[3] = s.ux; tf[4] = s.uy; tf[5] = s.uz; tf[6] = bx; tf[7] = by; tf[8] = bz;
    tf[9] = s.px - origin.x; tf[10] = s.py - origin.y; tf[11] = s.pz - origin.z;
    this._origin[0] = origin.x; this._origin[1] = origin.y; this._origin[2] = origin.z;
    this._track[0] = s.px; this._track[1] = s.py; this._track[2] = s.pz;
    this._speed = Number.isFinite(s.speed) && s.speed > 0 ? s.speed : 0;
    // Trail anchor: inside the Pop-Tart's rear face, in the posed (yawed, rolled, banked, scaled) model.
    const a = this._anchor;
    a[0] = e[12] + e[4] * ANCHOR_Y + e[8] * ANCHOR_Z;
    a[1] = e[13] + e[5] * ANCHOR_Y + e[9] * ANCHOR_Z;
    a[2] = e[14] + e[6] * ANCHOR_Y + e[10] * ANCHOR_Z;
    this._record(a[0] + origin.x, a[1] + origin.y, a[2] + origin.z);
    this._placed = true;
    this._everPlaced = true;
    this._buildTrail();
  }

  /** Animate: yaw and ribbon springs, paw paddle (4 frames a beat), body bob, head bop, tail wag, rainbow wave on half beats, sparkles. */
  update(dt, songTime, beatPhase, intensity) {
    void intensity;
    if (dt > 0) {
      // Critically damped spring toward the presentation yaw (settles in ~0.25 s).
      const e0 = this._yaw - this._yawTarget, k = Math.exp(-YAW_OMEGA * dt), c = this._yawV + YAW_OMEGA * e0;
      this._yaw = this._yawTarget + (e0 + c * dt) * k;
      this._yawV = (this._yawV - YAW_OMEGA * c * dt) * k;
      // Ribbon side: red toward the camera side, eased (recorded into the path history).
      const tt = -this._side, te = this._tw - tt, tk = Math.exp(-TW_OMEGA * dt), tc = this._twV + TW_OMEGA * te;
      this._tw = tt + (te + tc * dt) * tk;
      this._twV = (this._twV - TW_OMEGA * tc * dt) * tk;
      // Fallback camera model (used only when no camera is set).
      const ce = this._camLat - this._x * CAM_FOLLOW, ck = Math.exp(-CAM_OMEGA * dt), cc = this._camLatV + CAM_OMEGA * ce;
      this._camLat = this._x * CAM_FOLLOW + (ce + cc * dt) * ck;
      this._camLatV = (this._camLatV - CAM_OMEGA * cc * dt) * ck;
      if (this._speed > 0) this._dist += dt * this._speed;
    }
    const bp = Number.isFinite(beatPhase) ? beatPhase - Math.floor(beatPhase) : ((songTime || 0) * 2) % 1;
    if (bp < this._lastBp - 0.5) this._beatN++;
    this._lastBp = bp;
    // In play the paws paddle through all four frames; the square-on hero
    // (picker, turntable) keeps a neutral gait, so both profiles show clearly
    // separated paws clear of the rainbow.
    const q = Math.min(3, Math.floor(bp * 4));
    const fr = this.presentation ? q : 1;
    if (fr !== this._frame) {
      this.frames[this._frame].visible = false;
      this.frames[fr].visible = true;
      this._frame = fr;
    }
    this._pose(bp, this._beatN + bp);
    this._wave = bp < 0.5 ? 0 : 1;
    this._twinkle = q;
    this._time = songTime || 0;
    if (!this._placed) this._buildTrail(); // not placed this frame (a static presentation)
    this._placed = false;
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.trail);
    for (const m of this.frames) m.geometry.dispose();
    this.trail.geometry.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
  }

  // ---- internals ----

  /**
   * Pose the parts for beat phase bp (sway = beats + bp, for the side of
   * the head's roll, which alternates every beat). Body: a one-voxel bob.
   * Head (riding on the body): landing squash, hop, stretch, nod and roll
   * about the neck. Tail (riding on the body): each segment's elevation and
   * wag, chained joint to joint. Writes the part matrix uniforms in place.
   */
  _pose(bp, sway) {
    const TAU = 2 * Math.PI, U = this._partU, m = this._pm;
    const bodyY = BODY_BOB * 0.5 * (1 - Math.cos(TAU * (bp - HEAD_APEX)));
    U[PART_BODY].value.makeTranslation(0, bodyY, 0);

    // Hop: a landing squash from the beat, then airborne (hang-time arc,
    // stretched) from HEAD_UP until it lands on the next beat.
    let air = 0, sq = 0;
    if (bp < HEAD_LAND) sq = Math.sin(Math.PI * Math.sqrt(bp / HEAD_LAND));
    else if (bp > HEAD_UP) {
      const w = 2 * (bp - HEAD_UP) / (1 - HEAD_UP) - 1, w2 = w * w;
      air = 1 - w2 * w2;
    }
    const st = Math.sqrt(air);
    const sy = 1 + HEAD_STRETCH * st - HEAD_SQUASH * sq, sxz = 1 - HEAD_THIN * st + HEAD_SPREAD * sq;
    const nod = HEAD_NOD * air - HEAD_DIP * sq;
    // Roll toward the top, to the other side every beat (zero on the ground, where the side flips).
    const roll = (Math.floor(sway) & 1 ? HEAD_ROLL : -HEAD_ROLL) * air;
    // T(p + lift) · Rz · Rx · T(c - p) · S · T(-c): scale about c (the chin
    // on the ground, the head's middle in the air; the scale is 1 where the
    // two meet), nod and roll about the neck p.
    const h = U[PART_HEAD].value, py = HEAD_PIVOT_Y, pz = HEAD_PIVOT_Z, cz = HEAD_MID_Z;
    const cy = air > 0 ? py + HEAD_HALF_H : py;
    h.makeTranslation(0, -cy, -cz);
    h.premultiply(m.makeScale(sxz, sy, sxz));
    h.premultiply(m.makeTranslation(0, cy - py, cz - pz));
    h.premultiply(m.makeRotationX(nod));
    h.premultiply(m.makeRotationZ(roll));
    h.premultiply(m.makeTranslation(0, py + bodyY + HEAD_HOP * air, pz));

    // Tail: side-on swing (up and down) or straight-behind wag (side to
    // side), blended by how far the cat is turned toward the camera.
    const present = this.presentation;
    const ctr = present ? 1 - smooth01(Math.abs(this._yawOut) / YAW_SIDE) : 0;
    const lat = present ? TAIL_LAT_SIDE + (1 - TAIL_LAT_SIDE) * ctr : 0;
    let jx = 0, jy = TAIL_Y + bodyY, jz = TAIL_Z;
    for (let i = 0; i < TAIL_SEGS; i++) {
      const a = TAU * (bp - i * TAIL_LAG);
      const side = TAIL_REST[i] + TAIL_AMP[i] * Math.sin(a);
      const back = TAIL_REST_C[i] - TAIL_LIFT_C[i] * Math.cos(2 * a);
      const el = side + (back - side) * ctr;
      const yw = lat * TAIL_LAT[i] * Math.sin(a);
      const t = U[PART_TAIL + i].value;
      t.makeRotationX(-el); // +z (back) tips up toward +y by el
      t.premultiply(m.makeRotationY(yw));
      t.setPosition(jx, jy, jz);
      const ce = Math.cos(el) * TAIL_PITCH * V;
      jx += Math.sin(yw) * ce; jy += Math.sin(el) * TAIL_PITCH * V; jz += Math.cos(yw) * ce;
    }
  }

  /** Push the current pose into the history ring (keyed by distance travelled). */
  _record(ax, ay, az) {
    const H = this._hist, f = this._f, t = this._track;
    if (this._hCount > 0) {
      const o = this._hHead * HS;
      const dx = t[0] - H[o + 4], dy = t[1] - H[o + 5], dz = t[2] - H[o + 6];
      if (dx * dx + dy * dy + dz * dz > 80 * 80) this._hCount = 0; // teleport: new run or seek
    }
    const push = this._hCount === 0 || this._dist > H[this._hHead * HS] + 1e-4;
    if (push) {
      this._hHead = (this._hHead + 1) % HIST;
      this._hCount = Math.min(HIST, this._hCount + 1);
    }
    const o = this._hHead * HS;
    H[o] = this._dist;
    H[o + 1] = ax; H[o + 2] = ay; H[o + 3] = az;
    H[o + 4] = t[0]; H[o + 5] = t[1]; H[o + 6] = t[2];
    H[o + 7] = f[0]; H[o + 8] = f[1]; H[o + 9] = f[2];
    H[o + 10] = f[3]; H[o + 11] = f[4]; H[o + 12] = f[5];
    H[o + 13] = this._tw;
  }

  /** Band colours (band × face shade × the boundary's fade) for the play or the square-on mode. */
  _writeBandColors(present) {
    const col = this._col, fade = present ? FADE_PLAY : FADE_HERO;
    for (let i = 0; i < SEG; i++) for (let k = 0; k < BANDS; k++) {
      const rgb = RAINBOW[k], box = i * BANDS + k;
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
        const iz = BOX_FACES[f][v] >> 2, s = TRAIL_SHADE[f] * fade[i + iz], o = (box * 24 + f * 4 + v) * 3;
        col[o] = rgb[0] * s; col[o + 1] = rgb[1] * s; col[o + 2] = rgb[2] * s;
      }
    }
    this._colAttr.needsUpdate = true;
    this._colMode = present;
  }

  /** Rebuild the rainbow boundaries (0-1 rigid with the cat, 2+ from the path history) and write every box. */
  _buildTrail() {
    const e = this.group.matrix.elements;
    const P = this._bP, R = this._bR, U = this._bU;
    const present = this._everPlaced && this.presentation;
    if (this._colMode !== present) this._writeBandColors(present);
    const sc = present ? PRESENT_SCALE : 1;
    const vt = V * sc, segLen = SEG_LEN * sc;
    // Boundary 0: inside the Pop-Tart's rear face, in the cat's own (posed) frame.
    const inv = 1 / (Math.hypot(e[0], e[1], e[2]) || 1);
    P[0] = e[12] + e[4] * ANCHOR_Y + e[8] * ANCHOR_Z;
    P[1] = e[13] + e[5] * ANCHOR_Y + e[9] * ANCHOR_Z;
    P[2] = e[14] + e[6] * ANCHOR_Y + e[10] * ANCHOR_Z;
    R[0] = e[0] * inv; R[1] = e[1] * inv; R[2] = e[2] * inv;
    U[0] = e[4] * inv; U[1] = e[5] * inv; U[2] = e[6] * inv;
    // Boundary 1: one segment straight back along the ship (banked, unyawed),
    // rigid with the cat, so the first segment always leaves the tart cleanly.
    const f = this._f, placed = this._everPlaced;
    const b1x = placed ? f[6] : e[8] * inv, b1y = placed ? f[7] : e[9] * inv, b1z = placed ? f[8] : e[10] * inv;
    P[3] = P[0] + b1x * segLen; P[4] = P[1] + b1y * segLen; P[5] = P[2] + b1z * segLen;
    R[3] = placed ? f[0] : R[0]; R[4] = placed ? f[1] : R[1]; R[5] = placed ? f[2] : R[2];
    const Sd = this._S;
    Sd[0] = Sd[1] = this._tw;
    U[3] = placed ? f[3] : U[0]; U[4] = placed ? f[4] : U[1]; U[5] = placed ? f[5] : U[2];
    const H = this._hist, n = placed ? this._hCount : 0;
    const org = this._origin, tr = this._track, tf = this._tf;
    const vNow = n > 0 ? H[this._hHead * HS] : this._dist;
    let k = 0; // steps back from the newest entry: the bracket is (k+1, k)
    for (let j = 2; j <= SEG; j++) {
      const target = vNow - j * segLen;
      let ox, oy, oz, tx, ty, tz, rx, ry, rz, ux, uy, uz;
      if (n === 0) {
        // Never placed: straight back along the group's own frame.
        P[j * 3] = P[3] + b1x * (j - 1) * segLen; P[j * 3 + 1] = P[4] + b1y * (j - 1) * segLen; P[j * 3 + 2] = P[5] + b1z * (j - 1) * segLen;
        R[j * 3] = R[3]; R[j * 3 + 1] = R[4]; R[j * 3 + 2] = R[5];
        U[j * 3] = U[3]; U[j * 3 + 1] = U[4]; U[j * 3 + 2] = U[5];
        Sd[j] = this._tw;
        continue;
      }
      while (k + 1 < n && H[((this._hHead - k - 1 + HIST) % HIST) * HS] > target) k++;
      const a = ((this._hHead - k + HIST) % HIST) * HS; // newer
      if (k + 1 < n) {
        const b = ((this._hHead - k - 1 + HIST) % HIST) * HS; // older (V <= target)
        const span = H[a] - H[b];
        const t = span > 1e-9 ? Math.min(1, Math.max(0, (target - H[b]) / span)) : 0;
        ox = lh(H, b, a, 1, t); oy = lh(H, b, a, 2, t); oz = lh(H, b, a, 3, t);
        tx = lh(H, b, a, 4, t); ty = lh(H, b, a, 5, t); tz = lh(H, b, a, 6, t);
        rx = lh(H, b, a, 7, t); ry = lh(H, b, a, 8, t); rz = lh(H, b, a, 9, t);
        ux = lh(H, b, a, 10, t); uy = lh(H, b, a, 11, t); uz = lh(H, b, a, 12, t);
        Sd[j] = lh(H, b, a, 13, t);
      } else {
        Sd[j] = H[a + 13];
        ox = H[a + 1]; oy = H[a + 2]; oz = H[a + 3]; tx = H[a + 4]; ty = H[a + 5]; tz = H[a + 6];
        rx = H[a + 7]; ry = H[a + 8]; rz = H[a + 9]; ux = H[a + 10]; uy = H[a + 11]; uz = H[a + 12];
      }
      let l = Math.hypot(rx, ry, rz) || 1; rx /= l; ry /= l; rz /= l;
      const d = rx * ux + ry * uy + rz * uz; ux -= d * rx; uy -= d * ry; uz -= d * rz;
      l = Math.hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
      const bx = ry * uz - rz * uy, by = rz * ux - rx * uz, bz = rx * uy - ry * ux;
      // Where the ship has not really moved that far (paused, or a static
      // viewer), push the point back by the missing distance.
      const moved = Math.hypot(tr[0] - tx, tr[1] - ty, tr[2] - tz);
      const extra = Math.max(0, j * segLen - moved);
      let qx = ox - org[0] + bx * extra, qy = oy - org[1] + by * extra, qz = oz - org[2] + bz * extra;
      // Bend, never shear: limit the lateral step from the previous boundary.
      const o = (j - 1) * 3, lim = MAX_LAT[j] * sc;
      const lat = (qx - P[o]) * tf[0] + (qy - P[o + 1]) * tf[1] + (qz - P[o + 2]) * tf[2];
      const over = lat > lim ? lat - lim : lat < -lim ? lat + lim : 0;
      qx -= tf[0] * over; qy -= tf[1] * over; qz -= tf[2] * over;
      P[j * 3] = qx; P[j * 3 + 1] = qy; P[j * 3 + 2] = qz;
      R[j * 3] = rx; R[j * 3 + 1] = ry; R[j * 3 + 2] = rz;
      U[j * 3] = ux; U[j * 3 + 1] = uy; U[j * 3 + 2] = uz;
    }

    // Per boundary: the stack axis A (straight up, twisted toward the red
    // side by TWIST), the thickness axis B = back × A (so A, B, back are
    // right-handed and every box winds outward), the stack's centre, the band
    // width and the half thickness. The ribbon side σ (+1: red toward +x) is
    // the current one near the cat and the recorded one down the trail; where
    // it changes sign the flat ribbon narrows to a line and opens mirrored (a
    // half twist seen from above) instead of flipping.
    const A = this._A, B = this._B, Cn = this._C, Wd = this._W, Th = this._T;
    for (let j = 0; j <= SEG; j++) {
      const sg = this._S[j];
      const flat = j >= 2;
      const th = !present ? 0 : flat ? (sg < 0 ? -TWIST[j] : TWIST[j]) : sg * TWIST[j];
      const narrow = present && flat ? smooth01(Math.abs(sg) * 1.25) : 1;
      const o = j * 3;
      const rx = R[o], ry = R[o + 1], rz = R[o + 2], ux = U[o], uy = U[o + 1], uz = U[o + 2];
      const bkx = ry * uz - rz * uy, bky = rz * ux - rx * uz, bkz = rx * uy - ry * ux; // right × up = back
      const ct = Math.cos(th), st = Math.sin(th);
      const ax = ux * ct + rx * st, ay = uy * ct + ry * st, az = uz * ct + rz * st;
      A[o] = ax; A[o + 1] = ay; A[o + 2] = az;
      B[o] = bky * az - bkz * ay; B[o + 1] = bkz * ax - bkx * az; B[o + 2] = bkx * ay - bky * ax;
      const tp = present ? BD_TAPER[j] : 1;
      const bw = present ? BW[j] * tp : BW_HERO[j];
      const hc = present ? HC[j] : BOTTOM_HERO[j] + 3 * BW_HERO[j];
      Wd[j] = bw * narrow * vt;
      Th[j] = 0.5 * (present ? TH[j] * tp : TH_HERO) * vt;
      const h = hc * vt + LIFT;
      Cn[o] = P[o] + ux * h; Cn[o + 1] = P[o + 1] + uy * h; Cn[o + 2] = P[o + 2] + uz * h;
    }

    // Band boxes: band k (0 = red, at the +A end) spans [(2-k), (3-k)] band
    // widths along A and ±half thickness along B. The wave jogs alternate
    // segments (never the first, which leaves the tart under the tail) one
    // band along A.
    const pos = this._pos, c = this._c;
    for (let i = 0; i < SEG; i++) {
      const jog = i === 0 ? 0 : ((i + this._wave) & 1) * (present ? WAVE_PLAY[i] : WAVE_HERO);
      for (let b = 0; b < BANDS; b++) {
        for (let iz = 0; iz < 2; iz++) {
          const o = (i + iz) * 3, w = Wd[i + iz], t = Th[i + iz];
          const lo = (2 - b + jog) * w, hi = (3 - b + jog) * w;
          for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
            const la = ix ? hi : lo, lb = iy ? t : -t, q = (ix + 2 * iy + 4 * iz) * 3;
            c[q] = Cn[o] + A[o] * la + B[o] * lb;
            c[q + 1] = Cn[o + 1] + A[o + 1] * la + B[o + 1] * lb;
            c[q + 2] = Cn[o + 2] + A[o + 2] * la + B[o + 2] * lb;
          }
        }
        writeBoxCorners(pos, i * BANDS + b, c);
      }
    }
    this._writeStars();
    this._posAttr.needsUpdate = true;
  }

  /**
   * Sparkle stars: flat four-point sparkles facing back along the track (at
   * the chase camera), beyond the track edges (|x| 5.9..7.3 m from the
   * track centre), drifting back past the cat. Each steps through dot, plus
   * and big plus on the beat. In play only.
   */
  _writeStars() {
    const tf = this._tf, c = this._c, pos = this._pos;
    const show = this._everPlaced && this.presentation && this.showStars;
    const rx = tf[0], ry = tf[1], rz = tf[2], ux = tf[3], uy = tf[4], uz = tf[5], bx = tf[6], by = tf[7], bz = tf[8];
    const t = this._time;
    for (let s = 0; s < STARS; s++) {
      const h1 = fract(Math.sin(s * 12.9898 + 1.7) * 43758.5453), h2 = fract(Math.sin(s * 78.233 + 4.1) * 24634.6345);
      const side = s & 1 ? 1 : -1;
      const sx = side * (5.9 + 1.4 * h1), sy = 0.5 + 2.4 * h2;
      const sz = -14 + fract(t * 0.09 + s / STARS + h1 * 0.37) * 17; // metres behind the ship (negative: ahead)
      const cx = tf[9] + rx * sx + ux * sy + bx * sz, cy = tf[10] + ry * sx + uy * sy + by * sz, cz = tf[11] + rz * sx + uz * sy + bz * sz;
      const shape = STAR_SHAPES[(this._twinkle + s) & 3];
      const thick = show ? shape[0] : 0, thin = show ? shape[1] : 0;
      for (let a = 0; a < STAR_BOXES; a++) {
        // Boxes: thick horizontal and vertical arms, thin horizontal and vertical tips.
        const len = a < 2 ? thick : thin, half = !show || len === 0 ? 0 : a < 2 ? 0.5 : 0.25;
        const horiz = (a & 1) === 0;
        const x0 = horiz ? -len : -half, x1 = horiz ? len : half, y0 = horiz ? -half : -len, y1 = horiz ? half : len;
        const z1 = len === 0 ? 0 : 0.15;
        for (let iz = 0; iz < 2; iz++) for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
          const lx = (ix ? x1 : x0) * STAR_V, ly = (iy ? y1 : y0) * STAR_V, lz = (iz ? z1 : -z1) * STAR_V, q = (ix + 2 * iy + 4 * iz) * 3;
          c[q] = cx + rx * lx + ux * ly + bx * lz;
          c[q + 1] = cy + ry * lx + uy * ly + by * lz;
          c[q + 2] = cz + rz * lx + uz * ly + bz * lz;
        }
        writeBoxCorners(pos, BAND_BOXES + s * STAR_BOXES + a, c);
      }
    }
  }
}

const fract = (x) => x - Math.floor(x);
/** Smoothstep on [0, 1] (clamped). */
const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
/** History field i interpolated from entry b (older) to a (newer). */
const lh = (H, b, a, i, t) => H[b + i] + (H[a + i] - H[b + i]) * t;
