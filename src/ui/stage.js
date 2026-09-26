// The 3D selection stage (docs/art-direction.md §7.3): the current option
// as a large object turning slowly on a lit pedestal, drawn by the game's
// own renderer while its screen is open (the game is not rendering then),
// with drag to rotate, arrows / keys / pad / icons to switch, a swap
// transition with a particle burst, ring gauges and a decoded name. Built
// for any list of options, so the vehicle screen reuses it.
//
// options: [{ id, name, desc, icon, gauges: [{ label, value, unit, fraction }],
//             rows: [{ label, value, cls }], build(THREE, kit) → { object, update(dt, t) } }]

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Turntable, swapPhase, easeOutBack, stepOption } from './spin.js';
import { icon } from './icons.js';
import { decode, motionOff } from './text.js';
import { gaugeHtml } from './gauge.js';
import { FX_COLOURS } from './particles.js';

const RISERS = 36;
const FLOOR = 34; // floor dots per side

/** Shared materials and helpers the option builders use. */
function makeKit() {
  const hdr = (r, g, b, k) => new THREE.Color(r * k, g * k, b * k);
  return {
    steel: new THREE.MeshStandardNodeMaterial({ color: 0x14292d, metalness: 0.75, roughness: 0.32 }),
    dark: new THREE.MeshStandardNodeMaterial({ color: 0x0a1719, metalness: 0.4, roughness: 0.55 }),
    glass: new THREE.MeshStandardNodeMaterial({ color: 0x1b4a50, metalness: 0.2, roughness: 0.15, emissive: 0x0b3a3c, emissiveIntensity: 1 }),
    glow: new THREE.MeshBasicNodeMaterial({ color: hdr(0.25, 0.88, 0.82, 1.5) }),
    glowSoft: new THREE.MeshBasicNodeMaterial({ color: hdr(0.25, 0.88, 0.82, 0.6) }),
    white: new THREE.MeshBasicNodeMaterial({ color: hdr(0.86, 1, 0.99, 1.3) }),
    edge: new THREE.LineBasicNodeMaterial({ color: hdr(0.25, 0.88, 0.82, 1.2) }),
    edgeDim: new THREE.LineBasicNodeMaterial({ color: hdr(0.25, 0.88, 0.82, 0.45) }),
    tint: (hex, k = 2) => { const c = new THREE.Color(hex); return new THREE.MeshBasicNodeMaterial({ color: c.multiplyScalar(k) }); },
    edges: (geo, mat, threshold = 20) => new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), mat),
  };
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(160,255,245,0.9)');
  grd.addColorStop(0.35, 'rgba(63,224,208,0.35)');
  grd.addColorStop(1, 'rgba(63,224,208,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SelectStage {
  /**
   * @param screen   the screen section (with the data-stage-* hooks)
   * @param options  the choices (see the file comment)
   * @param opts     { fx, noun: 'mode', onChange(id) }
   */
  constructor(screen, options, { fx = null, noun = 'option', onChange = null } = {}) {
    this.screen = screen;
    this.options = options;
    this.fx = fx;
    this.noun = noun;
    this.onChange = onChange;
    this.index = 0;
    this.open = false;
    this.gfx = null;
    this.table = new Turntable();
    this.swap = null; // { from, to, t, dir }
    this.frames = 0;
    const q = (s) => screen.querySelector(`[data-stage-${s}]`);
    this.el = { name: q('name'), desc: q('desc'), index: q('index'), rows: q('rows'), gauges: q('gauges'), icons: q('icons'), area: q('drag'), fallback: q('fallback'), confirm: q('confirm') };
    this._buildIcons();
    q('prev').addEventListener('click', () => this.step(-1));
    q('next').addEventListener('click', () => this.step(1));
    this._wireDrag();
  }

  get value() {
    return this.options[this.index].id;
  }

  _buildIcons() {
    this.iconBtns = this.options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', o.name);
      b.title = o.name;
      b.dataset.nav = '';
      b.innerHTML = icon(o.icon);
      b.addEventListener('click', () => this.select(i));
      this.el.icons.appendChild(b);
      return b;
    });
  }

  _wireDrag() {
    const area = this.el.area;
    area.addEventListener('pointerdown', (e) => {
      area.setPointerCapture(e.pointerId);
      this.table.grab(e.clientX, e.timeStamp / 1000);
    });
    area.addEventListener('pointermove', (e) => this.table.drag(e.clientX, e.timeStamp / 1000));
    const up = () => this.table.release();
    area.addEventListener('pointerup', up);
    area.addEventListener('pointercancel', up);
  }

  /** Show the screen's content for option `id` and start drawing (with gfx: the game's Renderer, or null). */
  show(id, gfx) {
    const i = this.options.findIndex((o) => o.id === id);
    this.index = i < 0 ? 0 : i;
    this.open = true;
    this.gfx = gfx;
    this.table.still = motionOff();
    document.body.classList.toggle('no3d', !gfx);
    if (gfx && !this.scene) this._init(gfx);
    if (this.scene) {
      for (const o of this.objects) o.object.visible = false;
      this.swap = null;
      this._place(this.index, 1, 0);
    }
    this._fill(true);
  }

  hide() {
    this.open = false;
  }

  /** Switch by dir (−1 / +1), wrapping. */
  step(dir) {
    this.select(stepOption(this.index, dir, this.options.length), dir);
  }

  select(i, dir = i > this.index ? 1 : -1) {
    if (i === this.index) return;
    const from = this.index;
    this.index = i;
    if (this.scene) {
      if (this.swap) this._place(this.swap.from, 0, 0);
      this.swap = motionOff() ? null : { from, to: i, t: 0, dir };
      if (!this.swap) {
        this.objects[from].object.visible = false;
        this._place(i, 1, 0);
      }
    }
    this._fill(false);
    if (this.fx && !motionOff()) {
      const r = this.el.area.getBoundingClientRect();
      this.fx.burst(r.left + r.width / 2, r.top + r.height * 0.78, 40, { colour: FX_COLOURS.cyan, speed: 260, angle: -Math.PI / 2, spread: 2.6, life: 0.7, size: 2.4, gravity: 120, jitter: r.width * 0.4 });
    }
    if (this.onChange) this.onChange(this.value);
  }

  /** Text, gauges, rows and icons for the current option. */
  _fill(first) {
    const o = this.options[this.index];
    const n = this.options.length;
    this.el.index.textContent = `${String(this.index + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    decode(this.el.name, o.name.toUpperCase());
    this.el.desc.textContent = o.desc;
    this.el.rows.innerHTML = o.rows.map((r) => `<li><span>${r.label}</span><b class="${r.cls || ''}">${r.value}</b></li>`).join('');
    if (first || !this.el.gauges.children.length) this.el.gauges.innerHTML = o.gauges.map(gaugeHtml).join('');
    else {
      // Existing rings animate to the new values (CSS transition on the arc).
      o.gauges.forEach((g, k) => {
        const node = this.el.gauges.children[k];
        node.querySelector('.arc').style.setProperty('--v', String(Math.round(g.fraction * 100)));
        node.querySelector('.face b').innerHTML = `${g.value}${g.unit ? `<small>${g.unit}</small>` : ''}`;
        node.querySelector('.lbl').textContent = g.label;
      });
    }
    this.iconBtns.forEach((b, k) => b.setAttribute('aria-checked', String(k === this.index)));
    this.el.fallback.innerHTML = icon(o.icon);
    this.screen.classList.remove('swapping');
    if (!first && !motionOff()) {
      void this.screen.offsetWidth;
      this.screen.classList.add('swapping');
      setTimeout(() => this.screen.classList.remove('swapping'), 200);
    }
  }

  // --- 3D ----------------------------------------------------------------------------

  _init(gfx) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color().setRGB(0.012, 0.03, 0.036, THREE.LinearSRGBColorSpace);
    scene.fog = new THREE.Fog(scene.background.clone(), 12, 34);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 3.1, 10.5);
    camera.lookAt(0, 1.25, 0);
    this.scene = scene;
    this.camera = camera;
    this.kit = makeKit();

    scene.add(new THREE.HemisphereLight(0x9ff7ee, 0x050d10, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.PointLight(0x3fe0d0, 40, 14, 1.6);
    rim.position.set(-3.5, 3, -3);
    scene.add(rim);
    const under = new THREE.PointLight(0x3fe0d0, 5, 5, 1.5);
    under.position.set(0, 1.4, 0);
    scene.add(under);

    // Pedestal: a dark disc with two thin rings, a dotted ring and a light pool.
    const ped = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.22, 72), this.kit.dark);
    disc.position.y = -0.11;
    ped.add(disc);
    const ringA = new THREE.Mesh(new THREE.RingGeometry(2.14, 2.18, 96), this.kit.glow);
    const ringB = new THREE.Mesh(new THREE.RingGeometry(1.52, 1.535, 96), this.kit.glowSoft);
    for (const r of [ringA, ringB]) { r.rotation.x = -Math.PI / 2; r.position.y = 0.005; ped.add(r); }
    const dots = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.035, 0.035), this.kit.glowSoft, 90);
    const m = new THREE.Matrix4(), qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      m.compose(new THREE.Vector3(Math.cos(a) * 2.38, 0.006, Math.sin(a) * 2.38), qx, new THREE.Vector3(1, 1, 1));
      dots.setMatrixAt(i, m);
    }
    this.dots = dots;
    ped.add(dots);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), new THREE.MeshBasicNodeMaterial({ map: radialTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.22 }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.01;
    ped.add(pool);
    scene.add(ped);

    // Floor: a faint point field in the menu terrain's style.
    const nf = (FLOOR * 2 + 1) ** 2;
    const floor = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.03, 0.03), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.2, 0.62, 0.58) }), nf);
    const col = new THREE.Color();
    let k = 0;
    for (let x = -FLOOR; x <= FLOOR; x++) {
      for (let z = -FLOOR; z <= FLOOR; z++) {
        const px = x * 0.42, pz = z * 0.42 - 4;
        const d = Math.hypot(px, pz + 4);
        m.compose(new THREE.Vector3(px, -0.22, pz), qx, new THREE.Vector3(1, 1, 1));
        floor.setMatrixAt(k, m);
        col.setScalar(Math.max(0, 1 - d / 13) * (d < 2.6 ? 0 : 1));
        floor.setColorAt(k, col);
        k++;
      }
    }
    scene.add(floor);

    // Risers: particles drifting up through the light pool.
    this.risers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.016, 0), this.kit.white, RISERS);
    this.riserState = new Float32Array(RISERS * 4); // angle, radius, height, speed
    for (let i = 0; i < RISERS; i++) {
      this.riserState[i * 4] = Math.random() * Math.PI * 2;
      this.riserState[i * 4 + 1] = 0.3 + Math.random() * 1.4;
      this.riserState[i * 4 + 2] = Math.random() * 3.2;
      this.riserState[i * 4 + 3] = 0.25 + Math.random() * 0.45;
    }
    this.risers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.risers);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();

    // The options' objects on a turntable group.
    this.table3d = new THREE.Group();
    scene.add(this.table3d);
    this.objects = this.options.map((o) => {
      const built = o.build(THREE, this.kit);
      const holder = new THREE.Group();
      holder.add(built.object);
      holder.visible = false;
      this.table3d.add(holder);
      return { object: holder, update: built.update || null };
    });

    // Its own post chain: the scene with a soft bloom.
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const glow = bloom(color, 0.55, 0.25, 0.55);
    glow.setResolutionScale(0.5);
    this.pipeline = new THREE.RenderPipeline(gfx.renderer);
    this.pipeline.outputNode = color.add(glow);
    this.aspect = 0;
    this.clock = 0;
  }

  /** Put option i's holder at swap phase: scale s, side offset x (units), visible when s > 0. */
  _place(i, s, x) {
    const o = this.objects[i].object;
    o.visible = s > 0.001;
    o.scale.setScalar(Math.max(0.001, s));
    o.position.x = x;
  }

  /** Draw one frame (called by the app's frame loop only while the screen is open). */
  render(dt) {
    if (!this.open || !this.scene || !this.gfx) return;
    const gfx = this.gfx;
    const aspect = gfx.width / gfx.height;
    if (aspect !== this.aspect) {
      this.aspect = aspect;
      this.camera.aspect = aspect;
      // Keep the object framed on a phone's tall screen.
      this.camera.fov = aspect < 0.8 ? 46 : 30;
      this.camera.position.set(0, aspect < 0.8 ? 3.8 : 3.7, aspect < 0.8 ? 12.5 : 12);
      this.camera.lookAt(0, aspect < 0.8 ? 0.1 : 0.85, 0);
      this.camera.updateProjectionMatrix();
    }
    this.clock += dt;
    const t = this.clock;
    this.table3d.rotation.y = this.table.step(dt);
    this.dots.rotation.y = -t * 0.05;
    // Swap: the old object shrinks and slides out, the new one springs in.
    const sw = this.swap;
    if (sw) {
      sw.t += dt;
      const ph = swapPhase(sw.t);
      this._place(sw.from, 1 - ph.out, -sw.dir * 2.4 * ph.out * ph.out);
      this._place(sw.to, ph.in > 0 ? 0.55 + 0.45 * easeOutBack(ph.in) : 0, sw.dir * 2.4 * (1 - ph.in) * (1 - ph.in));
      if (ph.done) {
        this._place(sw.from, 0, 0);
        this._place(sw.to, 1, 0);
        this.swap = null;
      }
    }
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o.object.visible && o.update) o.update(dt, t, this.table.still);
    }
    // Risers.
    const rs = this.riserState, still = this.table.still;
    for (let i = 0; i < RISERS; i++) {
      if (!still) rs[i * 4 + 2] += rs[i * 4 + 3] * dt;
      if (rs[i * 4 + 2] > 3.2) rs[i * 4 + 2] -= 3.2;
      const h = rs[i * 4 + 2], a = rs[i * 4] + t * 0.1;
      const fade = Math.min(1, h / 0.4) * Math.max(0, 1 - h / 3.2);
      this._p.set(Math.cos(a) * rs[i * 4 + 1], h, Math.sin(a) * rs[i * 4 + 1]);
      this._s.setScalar(0.4 + fade);
      this._m.compose(this._p, this._q, this._s);
      this.risers.setMatrixAt(i, this._m);
    }
    this.risers.instanceMatrix.needsUpdate = true;
    this.pipeline.render();
    this.frames++;
  }
}
