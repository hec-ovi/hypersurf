import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoId } from '../src/live/youtube.js';

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
