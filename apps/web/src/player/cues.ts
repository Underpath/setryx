// Sounds are synthesised in the browser (no audio files). Browsers only allow
// audio after a tap, so unlock() runs on the Start workout tap.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function unlockAudio(): void {
  const c = audio();
  if (!c) return;
  // A silent blip completes the unlock on iOS.
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(c.destination);
  const o = c.createOscillator();
  o.connect(g);
  o.start();
  o.stop(c.currentTime + 0.01);
}

type Note = { freq: number; at: number; len: number; type: OscillatorType; vol: number };

function play(notes: Note[]): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  for (const n of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = n.type;
    o.frequency.value = n.freq;
    g.gain.setValueAtTime(0, t + n.at);
    g.gain.linearRampToValueAtTime(n.vol, t + n.at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + n.at + n.len);
    o.connect(g).connect(c.destination);
    o.start(t + n.at);
    o.stop(t + n.at + n.len + 0.05);
  }
}

export type Sound = 'end' | 'warn' | 'done' | 'tick' | 'go' | 'log';

export function sound(kind: Sound): void {
  switch (kind) {
    case 'end': // three rising chimes: timer finished
      return play([523.25, 659.25, 783.99].map((freq, i) => ({ freq, at: i * 0.18, len: 0.6, type: 'sine', vol: 0.4 })));
    case 'warn': // two short beeps: timer almost done
      return play([0, 0.2].map((at) => ({ freq: 880, at, len: 0.15, type: 'square', vol: 0.15 })));
    case 'done': // fanfare: workout complete
      return play([523.25, 659.25, 783.99, 1046.5].map((freq, i) => ({ freq, at: i * 0.15, len: 1.2, type: 'triangle', vol: 0.5 })));
    case 'tick': // 3-2-1 resume countdown
      return play([{ freq: 1200, at: 0, len: 0.09, type: 'sine', vol: 0.35 }]);
    case 'go':
      return play([{ freq: 1600, at: 0, len: 0.22, type: 'sine', vol: 0.5 }]);
    case 'log': // soft confirmation when a set is logged
      return play([{ freq: 660, at: 0, len: 0.12, type: 'sine', vol: 0.2 }]);
  }
}

export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    synth.speak(u);
  } catch {
    /* no voice on this device */
  }
}

export function stopSpeaking(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}
