import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoId, errorMessage, VideoClock, STATE, needsPlay } from '../src/live/youtube.js';

test('video IDs come out of every common link shape', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [
    id, ` ${id} `,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}&t=42s`,
    `youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
  ]) assert.equal(parseVideoId(input), id, input);
});

test('anything else is rejected', () => {
  for (const input of ['', null, 'hello', 'dQw4w9WgXc', 'https://vimeo.com/123456789', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/UC1234567890', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)']) {
    assert.equal(parseVideoId(input), null, String(input));
  }
});

test('player errors read as plain advice', () => {
  for (const code of [2, 5, 100, 101, 150, 153]) {
    const m = errorMessage(code);
    assert.ok(m.length > 30 && !/undefined/.test(m) && !m.includes(String(code)), `${code}: ${m}`);
  }
  assert.equal(errorMessage(101), errorMessage(150));
  assert.match(errorMessage(999), /999/);
});

test('the video clock smooths the time, gates on playing and flags seeks', () => {
  const c = new VideoClock();
  let ms = 0;
  // Unstarted, then playing: reported time advancing with a little jitter.
  c.sample(ms, 0, STATE.UNSTARTED);
  assert.equal(c.playing, false);
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    ms += 16.7;
    const truth = i * 0.0167;
    c.sample(ms, truth + ((i * 7919) % 11 - 5) * 0.002, STATE.PLAYING);
    if (i > 60) worst = Math.max(worst, Math.abs(c.time - truth));
    if (i > 2) assert.equal(c.playing, true);
  }
  assert.ok(worst < 0.006, `smoothed error ${worst}`);
  // Paused: gated off, time follows the report.
  ms += 16.7;
  c.sample(ms, 5, STATE.PAUSED);
  assert.equal(c.playing, false);
  // Playing but the time stands still (an ad): gated off after 0.6 s.
  for (let i = 0; i < 60; i++) { ms += 16.7; c.sample(ms, 5, STATE.PLAYING); }
  assert.equal(c.playing, false);
  // Jumps are seeks, forward or back.
  const seeks = c.seeks;
  ms += 16.7; c.sample(ms, 42, STATE.PLAYING);
  ms += 16.7; c.sample(ms, 10, STATE.PLAYING);
  assert.equal(c.seeks, seeks + 2);
  assert.equal(c.time, 10);
});

test('only an unstarted or cued video is asked to play again, never a paused one', () => {
  assert.equal(needsPlay(STATE.UNSTARTED), true);
  assert.equal(needsPlay(STATE.CUED), true);
  for (const s of [STATE.PLAYING, STATE.PAUSED, STATE.BUFFERING, STATE.ENDED]) assert.equal(needsPlay(s), false, `state ${s}`);
});
