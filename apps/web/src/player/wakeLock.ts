import { useEffect, useRef, useState } from 'react';
// Tiny silent video clips from nosleep.js (MIT). Playing one keeps phones awake.
import media from 'nosleep.js/src/media.js';

export type WakeStatus = 'on' | 'off' | 'failed';

/** Keeps the screen on by playing a muted, looping, invisible video. Must start from a tap. */
class VideoKeepAwake {
  private video: HTMLVideoElement;
  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.title = 'Keeps the screen on';
    Object.assign(v.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
    for (const [type, src] of [['webm', media.webm], ['mp4', media.mp4]] as const) {
      const s = document.createElement('source');
      s.src = src;
      s.type = `video/${type}`;
      v.appendChild(s);
    }
    v.addEventListener('loadedmetadata', () => {
      if (v.duration <= 1) v.loop = true;
      else v.addEventListener('timeupdate', () => v.currentTime > 0.5 && (v.currentTime = Math.random()));
    });
    this.video = v;
  }
  get playing() {
    return !this.video.paused;
  }
  async start() {
    if (!this.video.isConnected) document.body.appendChild(this.video);
    await this.video.play();
  }
  stop() {
    this.video.pause();
    this.video.remove();
  }
}

/**
 * Keeps the screen on while `active`.
 * - Uses the Screen Wake Lock API where the browser offers it (HTTPS or
 *   localhost), and asks again whenever the page becomes visible, because
 *   browsers drop the lock when the page is hidden.
 * - Over plain HTTP that API doesn't exist, and some browsers refuse it
 *   (battery saver). Then it plays a tiny muted looping video instead. That
 *   needs a tap to start: call `kick()` from the Start workout button.
 */
export function useWakeLock(active: boolean) {
  const [status, setStatus] = useState<WakeStatus>('off');
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const video = useRef<VideoKeepAwake | null>(null);
  const hasNative = typeof navigator !== 'undefined' && 'wakeLock' in navigator && window.isSecureContext;

  const acquire = async () => {
    if (hasNative) {
      try {
        sentinel.current = await navigator.wakeLock.request('screen');
        sentinel.current.addEventListener('release', () => {
          if (document.visibilityState === 'visible') setStatus('off');
        });
        setStatus('on');
        return;
      } catch {
        // Refused: fall back to the video below.
      }
    }
    try {
      video.current ??= new VideoKeepAwake();
      if (!video.current.playing) await video.current.start();
      setStatus('on');
    } catch {
      setStatus('failed'); // usually: not started from a tap
    }
  };

  const release = () => {
    void sentinel.current?.release().catch(() => {});
    sentinel.current = null;
    video.current?.stop();
    setStatus('off');
  };

  useEffect(() => {
    if (!active) {
      release();
      return;
    }
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** Call from a tap handler so the fallback video is allowed to play. */
  const kick = () => void acquire();

  return { status, native: hasNative, kick };
}
