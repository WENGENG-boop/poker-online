// 轻量音效：用 Web Audio 实时合成，无需加载音频文件

export type SoundName = 'shuffle' | 'deal' | 'play' | 'pass' | 'turn' | 'bomb' | 'win' | 'lose' | 'select';

const MUTE_KEY = 'poker.muted';
let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();
const listeners = new Set<(m: boolean) => void>();

function audio(): AudioContext | null {
  if (muted || typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 浏览器要求用户交互后才能播放声音：首次点击时解锁 */
if (typeof window !== 'undefined') {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

function noise(ac: AudioContext, at: number, dur: number, freq: number, gain: number) {
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 0.9;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(at);
}

function tone(ac: AudioContext, at: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

export function playSound(name: SoundName) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  switch (name) {
    case 'shuffle':
      for (let i = 0; i < 14; i++) noise(ac, t + i * 0.022, 0.03, 2600 + Math.random() * 1500, 0.22);
      break;
    case 'deal':
      noise(ac, t, 0.05, 3200, 0.18);
      break;
    case 'select':
      noise(ac, t, 0.025, 4200, 0.08);
      break;
    case 'play':
      noise(ac, t, 0.08, 1800, 0.4);
      tone(ac, t, 180, 0.08, 0.12, 'sine', 90);
      break;
    case 'pass':
      tone(ac, t, 520, 0.12, 0.06, 'triangle', 380);
      break;
    case 'turn':
      tone(ac, t, 660, 0.14, 0.09);
      tone(ac, t + 0.12, 990, 0.2, 0.09);
      break;
    case 'bomb':
      tone(ac, t, 120, 0.6, 0.45, 'sawtooth', 35);
      noise(ac, t, 0.5, 300, 0.6);
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(ac, t + i * 0.11, f, 0.3, 0.12, 'triangle'));
      break;
    case 'lose':
      [440, 349, 262].forEach((f, i) => tone(ac, t + i * 0.16, f, 0.32, 0.1, 'triangle'));
      break;
  }
}

export const soundSettings = {
  get muted() {
    return muted;
  },
  setMuted(m: boolean) {
    muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* 忽略 */
    }
    listeners.forEach((l) => l(m));
  },
  subscribe(l: (m: boolean) => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
