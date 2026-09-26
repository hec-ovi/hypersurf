// YouTube, through the documented IFrame Player API only (docs/research.md
// §2.2 and §5):
//   parseVideoId  a video ID from any common link shape
//   errorMessage  human messages for the player's error codes
//   VideoClock    the player's time smoothed (PLL) and gated: the run moves
//                 only while the video is playing and its time advances
//                 (buffering, pauses and ads hold it); jumps are seeks
//   loadIframeApi the API script, loaded once
//   YouTubePlayer a player filling its own host element (the mini player,
//                 356×200 or more, or collapsed when the player hides it),
//                 never covered by anything; the game only plays, pauses,
//                 seeks and reads the time and state
//
// The game never touches the video's audio: the live mode listens to the
// tab's sound through the share prompt, as the player plays it.

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video ID from a pasted link or bare ID, or null.
 * Accepts watch, youtu.be, embed, shorts, live and music links.
 */
export function parseVideoId(input) {
  const text = String(input || '').trim();
  if (ID.test(text)) return text;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let candidate = null;
  if (host === 'youtu.be') candidate = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') candidate = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) candidate = parts[1];
  }
  return candidate && ID.test(candidate) ? candidate : null;
}

/** Player states (YT.PlayerState). */
export const STATE = Object.freeze({ UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });

/**
 * Whether a run that wants the video playing should ask again. playVideo is
 * refused while the player is off screen (or not ready), which leaves it
 * unstarted or cued. A pause is the viewer's own choice and is never undone.
 */
export function needsPlay(state) {
  return state === STATE.UNSTARTED || state === STATE.CUED;
}

const ERRORS = {
  2: 'That video ID is not valid. Check the link and try again.',
  5: 'The YouTube player could not play this video here. Try another video, or reload the page.',
  100: 'That video was not found. It may have been removed or made private.',
  101: 'The owner of this video does not allow it to be played on other sites. Label-owned music videos are often like this; try another upload of the song.',
  150: 'The owner of this video does not allow it to be played on other sites. Label-owned music videos are often like this; try another upload of the song.',
  153: 'YouTube would not play the video because this page did not identify itself to it. Open hypersurf from its web address (not a saved copy) and try again.',
};

/** A message for a player error code (onError's data). */
export function errorMessage(code) {
  return ERRORS[code] || `YouTube reported an error (${code}). Try another video.`;
}

/**
 * The player's reported time, smoothed and gated. sample() it once per
 * frame with the wall clock (ms), getCurrentTime() and getPlayerState().
 *   time      smoothed video time: a first-order loop (gain 0.1) on the
 *             wall clock, snapped on jumps
 *   playing   PLAYING and the reported time advanced within `stall`
 *             seconds (a time that stands still means an ad or a hiccup)
 *   seeks     count of jumps: backwards, or further than the wall clock went
 */
export class VideoClock {
  constructor({ gain = 0.1, jump = 0.5, stall = 0.6 } = {}) {
    this.gain = gain;
    this.jump = jump;
    this.stall = stall;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.state = STATE.UNSTARTED;
    this.playing = false;
    this.seeks = 0;
    this.lastMs = NaN;
    this.lastReported = NaN;
    this.movedMs = -Infinity;
  }

  sample(nowMs, reported, state) {
    const dt = Number.isFinite(this.lastMs) ? Math.max(0, (nowMs - this.lastMs) / 1000) : 0;
    const was = this.state;
    this.state = state;
    if (Number.isFinite(this.lastReported) && reported !== this.lastReported) {
      if (reported < this.lastReported - 0.05 || reported - this.lastReported > this.jump + dt) this.seeks++;
      else if (reported > this.lastReported) this.movedMs = nowMs;
    }
    if (state === STATE.PLAYING && was === STATE.PLAYING && Number.isFinite(this.lastMs)) {
      const predicted = this.time + dt, err = reported - predicted;
      this.time = Math.abs(err) > this.jump ? reported : predicted + this.gain * err;
    } else this.time = reported;
    this.playing = state === STATE.PLAYING && nowMs - this.movedMs <= this.stall * 1000;
    this.lastMs = nowMs;
    this.lastReported = reported;
    return this;
  }
}

let apiPromise = null;

/** Load the IFrame API script once; resolves with window.YT. */
export function loadIframeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(Object.assign(new Error('youtube api'), { userMessage: 'The YouTube player could not be loaded. Check the connection (or an ad blocker) and try again.' }));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

/**
 * A YouTube player in `host` (the mini player's box). Events:
 * onState(state) and onError(code, message). Playback is only started
 * while at least half of it is on screen.
 */
export class YouTubePlayer {
  constructor(host, videoId, { onState, onError } = {}) {
    this.host = host;
    this.videoId = videoId;
    this.ready = false;
    this.player = null;
    this.clock = new VideoClock();
    this.error = 0;
    this.handlers = { onState, onError };
  }

  /** Share of the player inside the viewport of a visible page (nothing is ever laid over it; a hidden player counts as its 1px box). */
  get visible() {
    const f = this.host.querySelector('iframe');
    if (!f || document.visibilityState !== 'visible') return 0;
    const r = f.getBoundingClientRect(), area = r.width * r.height;
    if (area <= 0) return 0;
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return (w * h) / area;
  }

  /** Create the player; resolves when it is ready or has reported an error. */
  async create() {
    const YT = await loadIframeApi();
    if (this.destroyed) return this; // left before the API arrived
    const mount = document.createElement('div');
    this.host.replaceChildren(mount);
    await new Promise((resolve) => {
      this.player = new YT.Player(mount, {
        width: '100%',
        height: '100%',
        videoId: this.videoId,
        playerVars: { enablejsapi: 1, origin: location.origin, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            this.ready = true;
            resolve();
          },
          onStateChange: (e) => { if (this.handlers.onState) this.handlers.onState(e.data); },
          onError: (e) => {
            this.error = e.data;
            resolve();
            if (this.handlers.onError) this.handlers.onError(e.data, errorMessage(e.data));
          },
        },
      });
    });
    return this;
  }

  /** Sample the player into the clock (once per frame). */
  sample(nowMs = performance.now()) {
    if (!this.ready || !this.player) return this.clock;
    return this.clock.sample(nowMs, this.player.getCurrentTime() || 0, this.player.getPlayerState());
  }

  /** Start playback, only while at least half the player is on screen (YouTube's rule). */
  play() {
    if (!this.ready || this.visible < 0.5) return false;
    this.player.playVideo();
    return true;
  }

  pause() {
    if (this.ready) this.player.pauseVideo();
  }

  seekTo(seconds) {
    if (this.ready) this.player.seekTo(seconds, true);
  }

  get duration() {
    const d = this.ready ? this.player.getDuration() : 0;
    return d > 0 ? d : Infinity;
  }

  get state() {
    return this.ready ? this.player.getPlayerState() : STATE.UNSTARTED;
  }

  destroy() {
    this.destroyed = true;
    try {
      if (this.player && this.player.destroy) this.player.destroy();
    } catch { /* already gone */ }
    this.player = null;
    this.ready = false;
    this.host.replaceChildren();
  }
}
