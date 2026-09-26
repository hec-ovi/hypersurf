import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarTracker, BARS } from '../src/live/bars.js';

/**
 * Beat records of a synthetic 4/4 song, beat numbers from `first`: bar
 * lines where n ≡ `downbeat` (mod 4), a chord change on every bar line (a
 * bump moving through the bands), a kick-snare alternation inside the
 * bar, and a new section every 8 bars from bar line `phraseAt`
 * (a different spectrum and level).
 */
function* song({ first = 0, beats = 200, downbeat = 0, phraseAt = 0, spectrum = true, build = null } = {}) {
  const spec = new Float32Array(16);
  for (let n = first; n < first + beats; n++) {
    const bar = Math.floor((n - downbeat) / 4), inBar = ((n - downbeat) % 4 + 4) % 4;
    const section = Math.floor((bar - phraseAt) / 8);
    spec.fill(40 + 30 * (((section % 3) + 3) % 3));
    spec[2 + 3 * (((bar % 4) + 4) % 4)] += 70; // the chord of this bar
    if (inBar % 2 === 0) spec[0] += 50; // kick beats
    else spec[9] += 50; // snare beats
    let level = 0.4 + 0.15 * (((section % 2) + 2) % 2), energy = 1.5;
    if (build && bar >= build[0] && bar <= build[1]) {
      level += 0.05 * (bar - build[0] + 1);
      energy *= 1 + 0.3 * (bar - build[0] + 1);
    }
    yield { n, spec: spectrum ? spec : null, accent: 0.8, kick: inBar % 2 === 0 ? 0.8 : 0, energy, level };
  }
}

const feed = (bt, records, each) => {
  for (const r of records) {
    const bar = bt.push(r.n, r.spec, r.accent, r.kick, r.energy, r.level);
    if (each) each(r, bar);
  }
};

test('the downbeat is found from where the spectrum changes, whatever the beat numbering', () => {
  for (const [first, downbeat] of [[0, 0], [17, 2], [-5, 3], [1001, 1]]) {
    const bt = new BarTracker();
    feed(bt, song({ first, downbeat, beats: 48 }));
    assert.equal(bt.downbeat, ((downbeat % 4) + 4) % 4, `first ${first}`);
    assert.ok(bt.downbeatConfidence > 0.3, `confidence ${bt.downbeatConfidence}`);
    assert.ok(bt.isBarStart(downbeat + 40) && !bt.isBarStart(downbeat + 41));
    assert.equal(bt.nextBarStart(downbeat + 41), downbeat + 44);
  }
});

test('without a spectrum or accents the downbeat is never sure', () => {
  // Four-on-the-floor with nothing else: every beat looks the same.
  const bt = new BarTracker();
  let best = 0;
  for (let n = 0; n < 200; n++) {
    bt.push(n, null, 0.8, 0.8, 1.5, 0.5);
    best = Math.max(best, bt.downbeatConfidence);
  }
  assert.ok(best < 0.05, `confidence ${best}`);
  assert.equal(bt.phraseLines, 0);
});

test('phrase lines: sections every 8 bars are found, and the next one is predicted', () => {
  for (const phraseAt of [0, 3, 6]) {
    const bt = new BarTracker();
    let foundAt = null;
    feed(bt, song({ downbeat: 1, phraseAt, beats: 4 * 40 }), (r) => {
      if (foundAt === null && bt.phraseConfidence >= 0.3 && bt.phrase === phraseAt % 8) foundAt = r.n;
    });
    assert.equal(bt.phrase, phraseAt % 8, `phrase at ${phraseAt}`);
    assert.ok(bt.phraseConfidence > 0.5, `confidence ${bt.phraseConfidence}`);
    // Found after the first section line it heard (plus the two bars it compares).
    assert.ok(foundAt !== null && foundAt <= 1 + 4 * (phraseAt + 8 + 2) + 3, `found at beat ${foundAt}`);
    const next = bt.nextPhraseStart(1 + 4 * 41);
    assert.equal(((bt.barOf(next) - phraseAt) % 8 + 8) % 8, 0);
    assert.ok(next >= 1 + 4 * 41 && next < 1 + 4 * 49 && bt.isBarStart(next));
  }
});

test('a build is three bars of rising intensity and onset energy', () => {
  const bt = new BarTracker();
  const builds = [];
  feed(bt, song({ beats: 4 * 32, build: [18, 22] }), (r, bar) => { if (bar && bt.buildScore > 0) builds.push(bt.buildBar); });
  assert.ok(builds.length >= 1, 'found');
  // Heard once it has risen for two bars against the bar three back, never before the rise or after it.
  for (const b of builds) assert.ok(b >= 19 && b <= 22, `bar ${b}`);
  assert.equal(BARS.buildBars, 3);
  // No build in a song that only changes section.
  const flat = new BarTracker();
  let any = false;
  feed(flat, song({ beats: 4 * 32 }), (r, bar) => { if (bar && flat.buildScore > 0) any = true; });
  assert.equal(any, false);
});

test('a gap in the beats forgets everything before it', () => {
  const bt = new BarTracker();
  feed(bt, song({ beats: 60 }));
  assert.ok(bt.downbeatConfidence > 0);
  bt.push(100, new Float32Array(16), 0, 0, 0, 0);
  assert.equal(bt.count, 1);
  assert.equal(bt.downbeatConfidence, 0);
  assert.equal(bt.has(59), false);
});
