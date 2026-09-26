import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveIntensity } from '../src/live/intensity.js';
import { generateDemoSong } from '../src/audio/demo.js';
import { SR, mono } from './live-fixtures.js';

test('live intensity follows loudness: calm low, drops high, silence zero', () => {
  const demo = generateDemoSong({ sampleRate: SR });
  const li = new LiveIntensity(SR);
  const signal = mono(demo.channels);
  const at = {};
  const marks = [10, 44, 60, 90, 120];
  for (let i = 0; i + 512 <= signal.length; i += 512) {
    li.push(signal.subarray(i, i + 512));
    const t = (i + 512) / SR;
    for (const m of marks) if (at[m] === undefined && t >= m) at[m] = li.value;
  }
  const [intro, build, drop1, brk, drop2] = marks.map((m) => at[m]);
  assert.ok(drop1 > 0.75 && drop2 > 0.75, `drops ${drop1} ${drop2}`);
  assert.ok(intro < drop1 - 0.3 && brk < drop2 - 0.3, `intro ${intro}, break ${brk}`);
  assert.ok(build >= intro, `build ${build}`);
  li.reset();
  li.push(new Float32Array(3 * SR));
  assert.equal(li.value, 0);
});

test('live intensity rises within about a second and falls over a few', () => {
  const li = new LiveIntensity(SR);
  const tone = (seconds, amp) => {
    const x = new Float32Array(Math.round(seconds * SR));
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
    return x;
  };
  // Twenty seconds alternating quiet and loud so the session range settles.
  for (let k = 0; k < 5; k++) { li.push(tone(2, 0.02)); li.push(tone(2, 0.5)); }
  li.push(tone(8, 0.02));
  const quiet = li.value;
  li.push(tone(1.5, 0.5));
  const risen = li.value;
  li.push(tone(1, 0.02));
  const fallen = li.value;
  assert.ok(quiet < 0.15, `quiet ${quiet}`);
  assert.ok(risen > 0.7, `after 1.5 s loud: ${risen}`);
  assert.ok(fallen > 0.3 && fallen < risen, `release is slower than attack: ${fallen}`);
});
