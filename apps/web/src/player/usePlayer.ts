import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PlayerEvent,
  type PlayerState,
  type SetLog,
  type UserSettings,
  adjustLog,
  back as backStep,
  currentStep,
  next as nextStep,
  pause as pauseStep,
  resume as resumeStep,
  start as startPlayer,
  tick,
} from '@setryx/shared';
import { addFinished, announce, clearActive, saveActive } from './storage.ts';
import { sound, speak, stopSpeaking, unlockAudio, vibrate } from './cues.ts';

const describeNext = (e: Extract<PlayerEvent, { type: 'warn' }>, names: Record<string, { name: string }>) => {
  const n = e.next;
  if (!n) return 'Last one.';
  if (n.kind === 'rest') return `Up next: ${n.label ?? 'rest'}.`;
  return `Up next: ${names[n.exerciseId]?.name ?? 'next exercise'}.`;
};

/**
 * Runs a workout: owns the player state, saves it after every change,
 * drives the timer from timestamps, and plays the sound and voice cues.
 */
export function usePlayer(initial: PlayerState, settings: UserSettings) {
  const [state, setState] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<number | undefined>(undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist every change. A finished session moves to the "to review" list.
  useEffect(() => {
    if (state.phase === 'running') saveActive(state);
    if (state.phase === 'finished') {
      addFinished(state);
      clearActive(state.userId);
    }
    announce();
  }, [state]);

  const handle = useCallback((events: PlayerEvent[], s: PlayerState) => {
    const cfg = settingsRef.current;
    for (const e of events) {
      if (e.type === 'warn') {
        if (cfg.sounds) sound('warn');
        if (cfg.voice) speak(`${cfg.warnSeconds} seconds. ${describeNext(e, s.exercises)}`);
      }
      if (e.type === 'timerEnd') {
        if (cfg.sounds) sound('end');
        vibrate([120, 60, 120]);
      }
      if (e.type === 'finished') {
        if (cfg.sounds) sound('done');
        if (cfg.voice) speak('Workout complete. Great job!');
      }
    }
  }, []);

  // Tick a few times a second; also catch up immediately when the page becomes visible.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const run = () => {
      const t = Date.now();
      setNow(t);
      const r = tick(stateRef.current, t, settingsRef.current.warnSeconds);
      if (r.state !== stateRef.current) {
        stateRef.current = r.state;
        setState(r.state);
      }
      if (r.events.length) handle(r.events, r.state);
    };
    const id = window.setInterval(run, 250);
    const onVisible = () => document.visibilityState === 'visible' && run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state.phase, handle]);

  const cancelCountdown = () => {
    window.clearTimeout(countdownTimer.current);
    setCountdown(null);
  };

  const start = () => {
    unlockAudio();
    setState((s) => startPlayer(s, Date.now()));
  };

  const next = () => {
    cancelCountdown();
    const s = state;
    const step = currentStep(s);
    const r = nextStep(s, Date.now());
    if (step?.kind === 'exercise' && settingsRef.current.sounds && !r.events.length) sound('log');
    if (step?.kind === 'exercise') vibrate(40);
    setState(r.state);
    handle(r.events, r.state);
  };

  const back = () => {
    cancelCountdown();
    stopSpeaking();
    setState((s) => backStep(s, Date.now()));
  };

  /** Pause, or resume after a 3-2-1 countdown. Tapping during the countdown stays paused. */
  const togglePause = () => {
    if (countdown !== null) return cancelCountdown();
    if (!state.paused) {
      stopSpeaking();
      setState((s) => pauseStep(s, Date.now()));
      return;
    }
    const step = (n: number) => {
      if (n === 0) {
        if (settingsRef.current.sounds) sound('go');
        setCountdown(null);
        setState((s) => resumeStep(s, Date.now()));
        return;
      }
      setCountdown(n);
      if (settingsRef.current.sounds) sound('tick');
      countdownTimer.current = window.setTimeout(() => step(n - 1), 1000);
    };
    step(3);
  };

  const adjust = (stepIndex: number, patch: Partial<Pick<SetLog, 'actualReps' | 'actualWeight' | 'actualDurationS'>>) =>
    setState((s) => adjustLog(s, stepIndex, patch));

  /** End early: keep what was done so far. */
  const finishNow = () => {
    cancelCountdown();
    stopSpeaking();
    setState((s) => ({ ...s, phase: 'finished', finishedAt: Date.now(), endsAt: null, remainingMs: null, paused: false, pausedAt: null }));
  };

  useEffect(() => () => window.clearTimeout(countdownTimer.current), []);

  return { state, now, countdown, start, next, back, togglePause, adjust, finishNow };
}
