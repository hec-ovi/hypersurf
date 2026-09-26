// Tab-audio capture for the YouTube mode (docs/research.md §2.2, §5).
//
// getDisplayMedia must be called from the Start click itself (it needs the
// click's user activation). It asks for this tab (preferCurrentTab) with
// its audio and every voice processing step off; the video track, which
// the browser insists on, is stopped at once. An audio track is required:
// the user can untick "Also share tab audio", and Firefox, Safari and
// mobile browsers offer no tab audio at all.
//
// What this never does: suppress, delay, replay or mute the tab's own
// playback. suppressLocalAudioPlayback stays false and restrictOwnAudio is
// never set, so the YouTube player keeps sounding exactly as it would.

/** Constraints for the share prompt. */
export function captureConstraints() {
  return {
    video: true, // required by the API; stopped as soon as the stream arrives
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'exclude',
  };
}

export const CAPTURE_MESSAGES = Object.freeze({
  'no-api': 'This browser cannot share a tab’s sound, which the YouTube mode listens to. Use Chrome or Edge on a computer, or play an audio file or the demo.',
  mobile: 'Phones and tablets cannot share a tab’s sound, which the YouTube mode listens to. Use Chrome or Edge on a computer, or play an audio file or the demo.',
  'no-tab-audio': 'This browser cannot share a tab’s sound (Firefox and Safari share only the picture). Use Chrome or Edge on a computer, or play an audio file or the demo.',
  denied: 'Sharing was cancelled. Press Start and choose “Share” to play along, or play an audio file or the demo.',
  'no-audio': 'The tab was shared without its sound. Press Start again and keep “Also share tab audio” ticked, or play an audio file or the demo.',
  failed: 'The browser could not share this tab. Try again, or play an audio file or the demo.',
});

/**
 * Whether this browser can share a tab's audio: { ok, reason } with reason
 * a CAPTURE_MESSAGES key. Chromium is the only engine that supports tab
 * audio, and the only one that knows the suppressLocalAudioPlayback
 * constraint, which makes a clean feature test.
 */
export function captureSupport(nav = globalThis.navigator) {
  const md = nav && nav.mediaDevices;
  if (!md || typeof md.getDisplayMedia !== 'function') {
    const mobile = nav && ((nav.userAgentData && nav.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || ''));
    return { ok: false, reason: mobile ? 'mobile' : 'no-api' };
  }
  const supported = typeof md.getSupportedConstraints === 'function' ? md.getSupportedConstraints() : {};
  if (!supported.suppressLocalAudioPlayback) return { ok: false, reason: 'no-tab-audio' };
  return { ok: true, reason: '' };
}

/** An error the menu can show as is. */
export class CaptureError extends Error {
  constructor(reason) {
    super(CAPTURE_MESSAGES[reason] || CAPTURE_MESSAGES.failed);
    this.reason = reason;
    this.userMessage = this.message;
  }
}

/**
 * Keep only the audio of a shared stream: stop and drop every video track,
 * and fail (stopping everything) when there is no audio track.
 */
export function audioOnly(stream) {
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  if (stream.getAudioTracks().length === 0) {
    for (const t of stream.getTracks()) t.stop();
    throw new CaptureError('no-audio');
  }
  return stream;
}

/**
 * Ask to share this tab's audio. Call straight from the click handler.
 * Resolves with an audio-only MediaStream; `onEnded` runs when the user
 * clicks "Stop sharing" (or the track ends for any other reason).
 */
export async function captureTabAudio({ onEnded } = {}, nav = globalThis.navigator) {
  const support = captureSupport(nav);
  if (!support.ok) throw new CaptureError(support.reason);
  let stream;
  try {
    stream = await nav.mediaDevices.getDisplayMedia(captureConstraints());
  } catch (err) {
    throw new CaptureError(err && (err.name === 'NotAllowedError' || err.name === 'AbortError') ? 'denied' : 'failed');
  }
  audioOnly(stream);
  const track = stream.getAudioTracks()[0];
  if (onEnded) track.addEventListener('ended', onEnded, { once: true });
  return stream;
}

/** Stop every track of a stream (leaving the live mode). */
export function stopStream(stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
}
