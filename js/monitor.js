/* PALS Companion — the simulated bedside monitor.
   Receives the instructor's state and turns it into sweeping waveforms, numbers, alarms and sound.
   Time inside the engine is performance.now() in ms. */
(() => {
'use strict';
const { $, clamp } = PC;
const Mon = PC.Monitor = {};

let S = PC.defaultState();
let got = false, lastT = 0, lastVt = -1;
let ctlSeenAt = 0;
const VK = ['hr', 'spo2', 'rr', 'etco2', 'sbp', 'dbp', 'temp'];

/* ---------- vitals ramp: the "set" values drift from → to over the ramp ---------- */
let vFrom = { ...S.v }, vTo = { ...S.v }, rampStart = 0, rampDur = 0;
const ease = u => u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
const setV = (k, now) => {
  const u = rampDur > 0 ? clamp((now - rampStart) / rampDur, 0, 1) : 1;
  return vFrom[k] + (vTo[k] - vFrom[k]) * ease(u);
};
const perf = () => PC.perfusing(S);

/* ---------- waveform engine ---------- */
const G = (d, mu, sd, a) => a * Math.exp(-((d - mu) * (d - mu)) / (2 * sd * sd));
const E = {
  ev: [],          // ECG complexes {t, f:'P'|'N'|'W'|'V', qt, tw}
  qrs: [],         // QRS times (rate counting + sync markers)
  pl: [],          // pleth pulses {t, a}
  br: [],          // breaths {t, T, ti, E, prevE}
  next: 0, nextA: 0, beatN: 0, nextBr: 0,
  shockT: -1e9, stunUntil: 0, graceUntil: 0,
  et: 38, sp: 98,  // lagged EtCO2 target and SpO2
  perfSince: 0, noPerfSince: 0, lastPerf: true,
  cprT0: 0,
};

function rhythmChanged(now) {
  // Drop complexes that have not been drawn yet so the new rhythm starts promptly.
  E.ev = E.ev.filter(e => e.t < now - 5);
  E.pl = E.pl.filter(p => p.t < now);
  E.qrs = E.qrs.filter(t => t < now);
  E.next = Math.max(E.stunUntil, now + 250);
  E.nextA = E.next; E.beatN = 0;
  E.graceUntil = now + 3000;
}

function shock(now) {
  E.shockT = now;
  E.stunUntil = now + 1600;
  E.ev = E.ev.filter(e => e.t < now);
  E.pl = E.pl.filter(p => p.t < now);
  E.next = E.stunUntil; E.nextA = E.stunUntil;
  E.graceUntil = E.stunUntil + 3000;
  flash('⚡ SHOCK ' + (S.shockJ ? S.shockJ + ' J' : '') + ' DELIVERED');
}

function addQRS(t, f, extra) {
  const rr = 60000 / Math.max(20, setV('hr', t));
  const qt = clamp(1000 * 0.4 * Math.sqrt(rr / 1000) - 70, 110, 330);
  E.ev.push(Object.assign({ t, f, qt, tw: qt * 0.2 + 12 }, extra));
  E.qrs.push(t);
  if (perf()) {
    const sbp = setV('sbp', t), a = clamp((sbp - 35) / 60, 0.12, 1) * (f === 'V' ? 0.55 : 1);
    E.pl.push({ t: t + 170, a });
  }
}

function schedule(now) {
  const horizon = now + 1200, r = S.rhythm;
  if (PC.NON_PERFUSING.has(r)) {
    // VF, torsades and asystole are drawn as continuous functions; nothing to schedule
    if (E.next < now) E.next = Math.max(now, E.stunUntil);
    E.nextA = E.next;
  } else {
    let guard = 0;
    while (E.next < horizon && guard++ < 20) {
      const t = E.next, hr = Math.max(15, setV('hr', t));
      const iv = 60000 / hr;
      switch (r) {
        case 'svt':
          addQRS(t, 'N'); E.next = t + iv * (1 + (Math.random() - 0.5) * 0.01); break;
        case 'vt':
          addQRS(t, 'V'); E.next = t + iv * (1 + (Math.random() - 0.5) * 0.02); break;
        case 'avb1':
          E.ev.push({ t: t - 280, f: 'P' }); addQRS(t, 'N');
          E.next = t + iv * (1 + (Math.random() - 0.5) * 0.03); break;
        case 'avb2a': {                 // Wenckebach: PR lengthens, then a P is not conducted
          const k = E.beatN++ % 4, pr = [160, 240, 300][k], ia = iv * 3 / 4;
          E.ev.push({ t, f: 'P' });
          if (k < 3) addQRS(t + pr, 'N');
          E.next = t + ia; break;
        }
        case 'avb2b': {                 // Mobitz II: constant PR, every third P dropped
          const k = E.beatN++ % 3, ia = iv * 2 / 3;
          E.ev.push({ t, f: 'P' });
          if (k < 2) addQRS(t + 160, 'N', { wide: true });
          E.next = t + ia; break;
        }
        case 'avb3':                    // ventricular escape, atria run independently (below)
          addQRS(t, 'W'); E.next = t + iv * (1 + (Math.random() - 0.5) * 0.02); break;
        default:                        // sinus (and PEA when pulse is false)
          E.ev.push({ t: t - 130, f: 'P' }); addQRS(t, 'N');
          E.next = t + iv * (1 + (Math.random() - 0.5) * 0.04);
      }
    }
    if (r === 'avb3') {
      const ia = 60000 / 105;
      while (E.nextA < horizon) { E.ev.push({ t: E.nextA, f: 'P' }); E.nextA += ia * (1 + (Math.random() - 0.5) * 0.03); }
    }
  }
  // breaths
  let guard = 0;
  while (E.nextBr < horizon && guard++ < 10) {
    const rr = setV('rr', E.nextBr);
    if (rr < 1) { E.nextBr = horizon; break; }
    const T = 60000 / rr * (1 + (Math.random() - 0.5) * 0.05);
    const last = E.br[E.br.length - 1];
    E.br.push({ t: E.nextBr, T, ti: Math.min(0.38 * T, 900), E: E.et * (1 + (Math.random() - 0.5) * 0.03), prevE: last ? last.E : 0 });
    E.nextBr += T;
  }
  // tidy old items
  const old = now - 12000;
  if (E.ev.length > 200) E.ev = E.ev.filter(e => e.t > old);
  if (E.qrs.length > 200) E.qrs = E.qrs.filter(t => t > old);
  if (E.pl.length > 200) E.pl = E.pl.filter(p => p.t > old);
  if (E.br.length > 60) E.br = E.br.filter(b => b.t + b.T > old - 12000);
}

function complex(e, d) {
  switch (e.f) {
    case 'P': return G(d, 0, 22, 0.13);
    case 'N': {
      const w = e.wide ? 1.9 : 1;
      return G(d, -22 * w, 7 * w, -0.07) + G(d, 0, 9 * w, 1.0) + G(d, 22 * w, 9 * w, -0.24) + G(d, e.qt, e.tw, 0.26);
    }
    case 'W': return G(d, 0, 26, 0.85) + G(d, 60, 28, -0.4) + G(d, e.qt + 60, 60, -0.3);
    case 'V': return G(d, 0, 36, 1.3) + G(d, 95, 40, -0.8) + G(d, 190, 50, 0.18);
  }
  return 0;
}
function vf(s, amp) {
  const m = 0.7 + 0.3 * Math.sin(s * 1.1) * Math.sin(s * 0.37 + 1);
  return amp * m * (0.55 * Math.sin(2 * Math.PI * 4.8 * s + 1.4 * Math.sin(0.9 * s)) +
    0.32 * Math.sin(2 * Math.PI * 6.7 * s + 1.3 + Math.sin(1.7 * s)) +
    0.22 * Math.sin(2 * Math.PI * 3.1 * s + 0.4) + 0.1 * Math.sin(2 * Math.PI * 9.6 * s));
}
function cprArt(t) {
  const q = S.cprQ === 'good';
  const f = (q ? S.cprRate || 110 : 88) / 60;
  const ph = (((t - E.cprT0) / 1000) * f) % 1;
  return (q ? 1 : 0.55) * (Math.pow(Math.sin(Math.PI * ph), 2) - 0.35);
}
function ecgAt(t) {
  if (!S.leads) return 0;
  let y = 0.03 * Math.sin(t * 0.0013) + (Math.random() - 0.5) * 0.014;
  const s = t / 1000;
  if (t >= E.stunUntil) {
    switch (S.rhythm) {
      case 'vf': y += vf(s, 1); break;
      case 'vffine': y += vf(s, 0.25); break;
      case 'torsades': y += 1.15 * Math.sin(Math.PI * s / 1.7) * Math.sin(2 * Math.PI * 4.3 * s) + 0.08 * Math.sin(2 * Math.PI * 8.6 * s); break;
      case 'asystole': y += 0.02 * Math.sin(s * 1.9); break;
    }
  }
  for (const e of E.ev) { const d = t - e.t; if (d > -420 && d < 800) y += complex(e, d); }
  if (S.cpr) y += 1.1 * cprArt(t);
  const ds = t - E.shockT;
  if (ds >= 0 && ds < 2600) y += ds < 70 ? 3.5 : -1.5 * Math.exp(-(ds - 70) / 320);
  return y;
}
function plethAt(t) {
  if (!S.probe) return 0;
  let y = (Math.random() - 0.5) * 0.012;
  for (const p of E.pl) {
    const d = t - p.t; if (d < 0 || d > 1000) continue;
    y += p.a * (G(d, 120, d < 120 ? 45 : 130, 1) + G(d, 380, 60, 0.18));
  }
  if (S.cpr) y += 0.35 * (cprArt(t) + 0.35);
  return y;
}
function breathAt(t) {
  for (let i = E.br.length - 1; i >= 0; i--) { const b = E.br[i]; if (b.t <= t) return t < b.t + b.T ? b : null; }
  return null;
}
function co2At(t) {
  if (!S.co2On) return 0;
  const b = breathAt(t);
  if (!b) return 0;
  const u = t - b.t;
  if (u < b.ti) return b.prevE * Math.exp(-u / 45);
  const x = u - b.ti, te = b.T - b.ti;
  const tau = S.co2Shape === 'obstructive' ? 0.35 * te : 55;
  const rise = 1 - Math.exp(-x / tau);
  const slope = S.co2Shape === 'obstructive' ? 1 : 0.93 + 0.07 * (x / te);
  return b.E * rise * slope;
}
function respAt(t) {
  if (!S.leads) return 0;
  let y = 0;
  const b = breathAt(t);
  if (b) {
    const u = t - b.t;
    y = u < b.ti ? 0.5 - 0.5 * Math.cos(Math.PI * u / b.ti) : 0.5 + 0.5 * Math.cos(Math.PI * (u - b.ti) / (b.T - b.ti));
  }
  if (S.cpr) y += 0.3 * cprArt(t);
  return y + (Math.random() - 0.5) * 0.01;
}

/* ---------- sweep rows ---------- */
class Row {
  constructor(el, cssVar, sweepMs, fn, lo, hi, opts = {}) {
    this.el = el; this.cv = el.querySelector('canvas'); this.ctx = this.cv.getContext('2d');
    this.v = cssVar; this.sweep = sweepMs; this.fn = fn; this.lo = lo; this.hi = hi; this.o = opts;
    this.lastX = null; this.lastY = null; this.lastT = 0;
    this.resize();
  }
  resize(force) {
    const r = this.el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
    if (!force && w === this.w && h === this.h) return;   // clearing wipes the traces, so only when needed
    this.w = w; this.h = h;
    this.cv.width = this.w; this.cv.height = this.h; this.dpr = dpr;
    this.color = getComputedStyle(document.documentElement).getPropertyValue(this.v).trim() || '#0f0';
    this.bg = getComputedStyle(document.documentElement).getPropertyValue('--m-bg').trim() || '#000';
    this.ctx.fillStyle = this.bg; this.ctx.fillRect(0, 0, this.w, this.h);
    this.lastX = null;
  }
  y(v) { const pad = this.h * 0.12, top = this.h * 0.2; return this.h - pad - (v - this.lo) / (this.hi - this.lo) * (this.h - pad - top); }
  draw(now) {
    const pxPerMs = this.w / this.sweep;
    const x = (now % this.sweep) * pxPerMs;
    const c = this.ctx;
    if (this.lastX == null) { this.lastX = x; this.lastT = now; this.lastY = this.y(this.fn(now)); return; }
    let x0 = this.lastX, t0 = this.lastT;
    if (now - t0 > this.sweep) {        // tab was hidden: restart half a sweep back
      t0 = now - this.sweep * 0.5; x0 = (t0 % this.sweep) * pxPerMs; this.lastY = this.y(this.fn(t0));
    }
    const step = Math.max(1, this.dpr * 0.75);
    c.strokeStyle = this.color; c.lineWidth = 2 * this.dpr; c.lineJoin = 'round'; c.lineCap = 'round';
    let px = x0, t = t0, py = this.lastY;
    const gap = 14 * this.dpr;
    while (t < now) {
      const nt = Math.min(now, t + step / pxPerMs);
      let nx = px + (nt - t) * pxPerMs;
      if (nx >= this.w) { // wrap
        c.fillStyle = this.bg; c.fillRect(0, 0, gap, this.h);
        px = 0; nx = (nt - t) * pxPerMs;
      }
      c.fillStyle = this.bg; c.fillRect(nx, 0, gap, this.h);
      const ny = this.y(this.fn(nt));
      c.beginPath(); c.moveTo(px, py); c.lineTo(nx, ny); c.stroke();
      if (this.o.marks) this.o.marks(t, nt, nx, c, this);
      px = nx; py = ny; t = nt;
    }
    this.lastX = px; this.lastT = now; this.lastY = py;
  }
}
function syncMarks(t0, t1, x, c, row) {
  if (!S.sync) return;
  for (const q of E.qrs) if (q > t0 && q <= t1) {
    c.fillStyle = row.color; const y = row.h * 0.1, s = 6 * row.dpr;
    c.beginPath(); c.moveTo(x - s, y); c.lineTo(x + s, y); c.lineTo(x, y + s * 1.4); c.closePath(); c.fill();
  }
}

/* ---------- sound ---------- */
let ac = null, master = null;
function audioInit() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (!master) { master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination); }
    ac.resume && ac.resume();
  } catch {}
}
function tone(freq, dur, vol, at, type = 'sine') {
  if (!ac || ac.state !== 'running') return;
  const t = at || ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function beep(kind) {
  if (!S.beep || S.frozen) return;
  const sp = shownSpO2;
  const f = kind === 'qrs' ? 700 : clamp(430 + ((sp == null ? 97 : sp) - 60) * 11, 380, 900);
  tone(f, 0.07, 0.25);
}
function alarmSound(p) {
  if (!ac) return;
  const t = ac.currentTime;
  if (p === 3) [0, .15, .3, .75, .9].forEach(d => tone(960, 0.11, 0.35, t + d, 'triangle'));
  else if (p === 2) [0, .25, .5].forEach(d => tone(660, 0.16, 0.3, t + d, 'triangle'));
  else tone(520, 0.2, 0.2, t, 'triangle');
}

/* ---------- numbers ---------- */
let shownSpO2 = null, shown = {}, alarms = [], silenceUntil = 0, lastAlarmSound = 0;
const N = { state: 'idle', t0: 0, sys: null, dia: null, map: null, at: '', failUntil: 0, lastAuto: 0 };

function measuredHR(now) {
  const q = E.qrs.filter(t => t <= now && t > now - 6000);
  if (q.length < 2) return 0;
  const n = Math.min(5, q.length - 1), iv = (q[q.length - 1] - q[q.length - 1 - n]) / n;
  if (now - q[q.length - 1] > Math.max(3000, iv * 2.2)) return 0;
  return 60000 / iv;
}
const jit = (v, a) => v + (Math.random() - 0.5) * 2 * a;

function computeNumbers(now) {
  const L = PC.limits(S.pt.group), r = S.rhythm, p = perf();
  const o = {};
  // HR
  if (S.leads) {
    if (S.cpr) o.hr = Math.round(jit(S.cprQ === 'good' ? S.cprRate || 110 : 88, 3));
    else if (now < E.stunUntil) o.hr = null;
    else if (r === 'vf' || r === 'vffine') o.hr = null;
    else if (r === 'torsades') o.hr = Math.round(jit(250, 15));
    else if (r === 'asystole') o.hr = 0;
    else { const m = measuredHR(now); o.hr = Math.round(m ? jit(m, 0.8) : 0); }
    o.hrSrc = 'HR';
  } else if (S.probe && p) { o.hr = Math.round(jit(measuredHR(now), 0.8)); o.hrSrc = 'PR'; }
  else { o.hr = null; o.hrSrc = 'HR'; }
  // SpO2 (lagged, hidden while searching / no pulse)
  o.sp = null; o.spMsg = '';
  if (!S.probe) o.spMsg = 'PROBE OFF';
  else if (!p) { if (now - E.noPerfSince > 4000) o.spMsg = 'NO PULSE'; else o.sp = shownSpO2; }
  else if (now - E.perfSince < 7000 && E.perfSince > 0) o.spMsg = 'SEARCHING';
  else o.sp = Math.round(clamp(jit(E.sp, 0.4), 0, 100));
  // EtCO2 + awRR
  o.co = null; o.aw = null;
  if (S.co2On) {
    const done = E.br.filter(b => b.t + b.ti < now);
    const lb = done[done.length - 1];
    if (lb && now - lb.t < Math.max(15000, lb.T * 2.5)) {
      o.co = Math.round(jit(lb.E, 0.4));
      o.aw = Math.round(setV('rr', now));
    } else o.co = 0, o.aw = 0;
  }
  // RR (impedance, from the leads)
  o.rr = S.leads ? Math.round(jit(setV('rr', now), 0.5)) : null;
  if (S.leads && S.cpr) o.rr = null;
  o.temp = setV('temp', now);
  o.L = L;
  return o;
}

function evalAlarms(o, now) {
  const a = [], L = o.L, r = S.rhythm;
  const add = (p, msg, tile) => a.push({ p, msg, tile });
  if (S.leads && !S.cpr && now > E.stunUntil) {
    if (r === 'vf' || r === 'vffine') add(3, 'V-FIB', 'tHR');
    else if (r === 'torsades' || (r === 'vt' && (o.hr || 0) > 100)) add(3, 'V-TACH', 'tHR');
    else if (r === 'asystole' || (o.hr === 0 && now > E.graceUntil)) add(3, 'ASYSTOLE', 'tHR');
  }
  if (o.hr != null && o.hr > 0 && !S.cpr && now > E.graceUntil) {
    if (o.hr < L.hr[0] * 0.6) add(3, 'EXTREME BRADY ' + o.hr, 'tHR');
    else if (o.hr > L.hr[1] * 1.35 && r !== 'vt' && r !== 'torsades') add(3, 'EXTREME TACHY ' + o.hr, 'tHR');
    else if (o.hr < L.hr[0]) add(2, o.hrSrc + ' LOW ' + o.hr + ' < ' + L.hr[0], 'tHR');
    else if (o.hr > L.hr[1]) add(2, o.hrSrc + ' HIGH ' + o.hr + ' > ' + L.hr[1], 'tHR');
  }
  if (o.sp != null) {
    if (o.sp < 85) add(3, 'SpO₂ LOW ' + o.sp, 'tSP');
    else if (o.sp < L.spo2Low) add(2, 'SpO₂ LOW ' + o.sp + ' < ' + L.spo2Low, 'tSP');
  }
  if (S.co2On && o.co === 0 && E.br.length) add(3, 'APNOEA / NO CO₂', 'tCO');
  else if (S.co2On && o.co != null && o.co > 0) {
    if (o.co > L.etco2[1]) add(2, 'EtCO₂ HIGH ' + o.co, 'tCO');
    else if (o.co < L.etco2[0] && !S.cpr) add(2, 'EtCO₂ LOW ' + o.co, 'tCO');
  }
  if (o.rr != null && o.rr > 0) {
    if (o.rr < L.rr[0]) add(2, 'RR LOW ' + o.rr, 'tRR');
    else if (o.rr > L.rr[1]) add(2, 'RR HIGH ' + o.rr, 'tRR');
  }
  if (N.sys != null && N.state === 'done' && N.sys < L.sbpLow) add(2, 'NIBP SYS LOW ' + N.sys, 'tNB');
  if (!S.leads) add(1, 'ECG LEADS OFF');
  if (S.probe && o.spMsg === 'NO PULSE') add(1, 'SpO₂ NO PULSE', 'tSP');
  if (!S.probe) add(1, 'SpO₂ PROBE OFF');
  if (now < N.failUntil) add(1, 'NIBP MEASUREMENT FAILED', 'tNB');
  a.sort((x, y) => y.p - x.p);
  return a;
}

/* ---------- NIBP ---------- */
function nibpStart(now) {
  if (!S.cuff) return;
  N.state = 'meas'; N.t0 = now;
}
function nibpTick(now) {
  if (S.nibpAuto > 0 && N.state !== 'meas' && now - N.lastAuto > S.nibpAuto * 60000) { N.lastAuto = now; nibpStart(now); }
  if (N.state !== 'meas') return;
  const e = now - N.t0, D = 17000;
  if (e < D) return;
  if (perf() && !S.cpr && S.cuff) {
    const sys = Math.round(jit(setV('sbp', now), 2)), dia = Math.round(jit(setV('dbp', now), 2));
    N.sys = sys; N.dia = Math.min(dia, sys - 4); N.map = Math.round(N.dia + (N.sys - N.dia) / 3);
    N.at = PC.clock().slice(0, 5); N.state = 'done';
  } else { N.state = 'idle'; N.failUntil = now + 30000; N.sys = null; }
}
function cuffPressure(now) {
  const e = now - N.t0;
  if (e < 4000) return Math.round(e / 4000 * 170);
  return Math.max(0, Math.round(170 - (e - 4000) / 13000 * 150));
}

/* ---------- DOM ---------- */
let rows = [], els = {};
function render(now) {
  const o = computeNumbers(now);
  shownSpO2 = o.sp;
  alarms = S.alarms ? evalAlarms(o, now) : [];
  const set = (id, txt) => { if (els[id].textContent !== String(txt)) els[id].textContent = txt; };
  set('vHR', o.hr == null ? '---' : o.hr);
  els.tHR.querySelector('.tl span').firstChild.textContent = o.hrSrc + ' ';
  set('vSP', o.sp == null ? '---' : o.sp);
  set('uSP', o.spMsg || '%');
  set('vCO', o.co == null ? '---' : o.co);
  set('vAW', o.aw == null ? '--' : o.aw);
  set('vRR', o.rr == null ? '--' : o.rr);
  set('vTE', S.leads || S.probe ? o.temp.toFixed(1) : '--.-');
  // NIBP
  if (N.state === 'meas') { set('vNB', cuffPressure(now)); set('nbState', 'Measuring…'); set('vMAP', ''); }
  else if (N.sys != null) { set('vNB', N.sys + '/' + N.dia); set('vMAP', '(' + N.map + ')'); set('nbState', ''); }
  else { set('vNB', '---/---'); set('vMAP', ''); set('nbState', now < N.failUntil ? 'Failed' : ''); }
  set('nbTime', N.at ? N.at : '');
  set('nbMode', S.nibpAuto ? 'Auto ' + S.nibpAuto + ' min' : 'Manual');
  // CO2 scale follows the value (0–50, or 0–100 when EtCO2 is high)
  const co2Hi = (o.co || 0) > 47 ? 104 : 52;
  if (rows[2] && rows[2].hi !== co2Hi) { rows[2].hi = co2Hi; $('#rCo .lab small').textContent = 'mmHg · 0–' + (co2Hi > 60 ? 100 : 50); }
  // limits
  const L = o.L;
  els.limHR.innerHTML = L.hr[1] + '<br>' + L.hr[0];
  els.limSP.innerHTML = '100<br>' + L.spo2Low;
  els.limCO.innerHTML = L.etco2[1] + '<br>' + L.etco2[0];
  els.limRR.innerHTML = L.rr[1] + '<br>' + L.rr[0];
  // tile highlight
  ['tHR', 'tSP', 'tCO', 'tRR', 'tNB'].forEach(id => {
    const top = alarms.filter(a => a.tile === id).reduce((m, a) => Math.max(m, a.p), 0);
    els[id].classList.toggle('alarm3', top === 3); els[id].classList.toggle('alarm2', top === 2);
  });
  // banner
  const b = els.mBanner, silenced = Date.now() < silenceUntil;
  if (alarms.length) {
    const top = alarms[0];
    b.className = 'p' + top.p;
    b.innerHTML = PC.esc(top.msg) + (alarms.length > 1 ? '<span class="more">+' + (alarms.length - 1) + '</span>' : '');
  } else if (flashMsg && now < flashUntil) { b.className = 'p1'; b.textContent = flashMsg; }
  else { b.className = ''; b.textContent = ''; }
  els.mSil.textContent = !S.alarms ? '🔕 ALARMS OFF' : silenced ? '🔕 ' + PC.mmss(silenceUntil - Date.now()) : '';
  els.mClock.textContent = PC.clock();
  const dot = els.mLink.firstChild;
  dot.className = 'dot ' + (Date.now() - ctlSeenAt < 12000 ? 'on' : got ? 'wait' : '');
  els.mLink.title = Date.now() - ctlSeenAt < 12000 ? 'Instructor connected' : 'Waiting for instructor';
  // alarm audio
  if (alarms.length && !silenced && S.alarms && !S.frozen) {
    const p = alarms[0].p, gap = p === 3 ? 5000 : p === 2 ? 10000 : 20000;
    if (Date.now() - lastAlarmSound > gap) { lastAlarmSound = Date.now(); alarmSound(p); }
  }
}
let flashMsg = '', flashUntil = 0;
function flash(msg) { flashMsg = msg; flashUntil = performance.now() + 4000; }

function applyUI() {
  const theme = S.monTheme === 'light' ? 'light' : 'dark';
  const themeChanged = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  const pt = S.pt || {};
  els.mPt.textContent = [pt.bed, pt.age, pt.wt ? pt.wt + ' kg' : ''].filter(Boolean).join(' · ');
  els.mFrozen.classList.toggle('hide', !S.frozen);
  const rv = S.reveal || {};
  els.mReveal.classList.toggle('hide', !rv.on);
  if (rv.on) { els.mReveal.querySelector('h3').textContent = rv.title || ''; els.mReveal.querySelector('div').textContent = rv.text || ''; }
  if (themeChanged) requestAnimationFrame(() => rows.forEach(r => r.resize(true)));
}

/* ---------- receiving state ---------- */
/* Ordering never compares the phone's clock with this device's clock:
   - a retained relay copy is only used to start up (before any live state arrives);
   - from the same instructor, a state is applied only if its `t` is newer;
   - a different instructor (another phone, or the page reloaded) takes over at once. */
let lastFrom = '';
function applyState(st, meta = {}) {
  if (!st || typeof st.t !== 'number') return;
  if (meta.retained && (got || Date.now() - st.t > 3 * 3600e3)) return;   // stale or startup-only copy
  const newSender = !!meta.from && meta.from !== lastFrom;
  if (!newSender && st.t <= lastT) return;                                // duplicate or out of order
  const first = !got; got = true; lastT = st.t; if (meta.from) lastFrom = meta.from;
  const prev = S; S = PC.mergeState(st);
  const now = performance.now();
  if (S.vt !== lastVt) {
    for (const k of VK) vFrom[k] = first ? S.v[k] : setV(k, now);
    vTo = { ...S.v }; rampStart = now; rampDur = first ? 0 : (S.ramp || 0); lastVt = S.vt;
    if (first) { E.et = S.v.etco2; E.sp = S.v.spo2; }
  }
  if (first || prev.rhythm !== S.rhythm || prev.pulse !== S.pulse) rhythmChanged(now);
  if (S.cpr && !prev.cpr) E.cprT0 = now;
  // One-off events fire when their stamp changes. Not on the first state (a reloaded monitor must not
  // replay an old shock), and not when another instructor takes over with its own old stamps.
  if (!first && !newSender) {
    if (S.shockAt && S.shockAt !== prev.shockAt) shock(now);
    if (S.nibpAt && S.nibpAt !== prev.nibpAt) nibpStart(now);
    if (S.nibpAuto !== prev.nibpAuto) N.lastAuto = now;
    if (S.silenceAt !== prev.silenceAt) silenceUntil = S.silenceAt ? Date.now() + 120000 : 0;
  }
  if (!S.cuff) N.state = N.state === 'meas' ? 'idle' : N.state;
  applyUI();
}

/* ---------- main loop ---------- */
let lastFrame = 0, lastNum = 0, lastPerfState = true, plIdx = 0, qIdx = 0, lastBeepCheck = 0;
function frame() {
  const now = performance.now();
  const dt = lastFrame ? Math.min(now - lastFrame, 500) : 16; lastFrame = now;
  // physiology lags
  const p = perf();
  if (p !== lastPerfState) { if (p) E.perfSince = now; else E.noPerfSince = now; lastPerfState = p; }
  let etT;
  if (S.cpr) etT = p ? Math.max(setV('etco2', now), 42) : (S.cprQ === 'good' ? 18 : 8);
  else etT = p ? setV('etco2', now) : 3;
  E.et += (etT - E.et) * (1 - Math.exp(-dt / 2500));
  if (p) E.sp += (setV('spo2', now) - E.sp) * (1 - Math.exp(-dt / 3500));
  schedule(now);
  if (!S.frozen) {
    for (const r of rows) r.draw(now);
    // beeps + heart blink for pulses/QRS that just happened
    const from = lastBeepCheck || now; lastBeepCheck = now;
    let beat = false;
    if (S.probe && p) { for (const pl of E.pl) if (pl.t > from && pl.t <= now) { beep('pl'); beat = true; } }
    else if (S.leads && !S.cpr) { for (const q of E.qrs) if (q > from && q <= now) { beep('qrs'); beat = true; } }
    if (beat) { els.mHeart.classList.add('beat'); setTimeout(() => els.mHeart.classList.remove('beat'), 110); }
  } else { lastBeepCheck = now; rows.forEach(r => { r.lastT = now; r.lastX = (now % r.sweep) * (r.w / r.sweep); }); }
  nibpTick(now);
  if (now - lastNum > 1000 && !S.frozen || now < flashUntil && now - lastNum > 250) { lastNum = now; render(now); }
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
let link = null;
Mon.start = code => {
  PC.$('#mon').classList.remove('hide');
  ['mPt', 'mBanner', 'mSil', 'mLink', 'mClock', 'vHR', 'uHR', 'vSP', 'uSP', 'vCO', 'vAW', 'vRR', 'vTE', 'vNB', 'vMAP', 'nbState', 'nbTime', 'nbMode',
    'limHR', 'limSP', 'limCO', 'limRR', 'tHR', 'tSP', 'tCO', 'tRR', 'tNB', 'mFrozen', 'mReveal', 'mHeart'].forEach(id => els[id] = document.getElementById(id));
  rows = [
    new Row($('#rEcg'), '--ecg', 5000, ecgAt, -1.1, 1.7, { marks: syncMarks }),
    new Row($('#rPl'), '--pleth', 5000, plethAt, -0.1, 1.25),
    new Row($('#rCo'), '--co2', 10000, co2At, 0, 52),
    new Row($('#rRe'), '--resp', 10000, respAt, -0.2, 1.25),
  ];
  window.addEventListener('resize', () => rows.forEach(r => r.resize()));
  if (window.ResizeObserver) new ResizeObserver(() => rows.forEach(r => r.resize())).observe($('#mMain'));

  // pairing overlay
  $('#mCode').textContent = code; $('#mCodeBtn').textContent = code;
  const url = location.origin + location.pathname + '#control=' + code;
  $('#mUrl').textContent = location.host || 'this page';
  try {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { $('#qrBox').innerHTML = ''; }
  const ov = $('#mStart'); ov.classList.remove('hide');
  $('#mGo').onclick = () => { ov.classList.add('hide'); audioInit(); PC._wantWake = true; PC.wake(); try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch {} };
  $('#mCodeBtn').onclick = () => { $('#mGo').textContent = 'Close'; ov.classList.remove('hide'); };
  document.addEventListener('pointerdown', audioInit, { once: false });

  link = new PC.Link(code, 'mon', {
    state: (st, meta) => applyState(st, meta),
    hb: m => { if (m.role === 'ctl') ctlSeenAt = Date.now(); },
  });
  link.start();
  const hb = () => link.heartbeat({ gotT: lastT, gotFrom: lastFrom });
  hb(); setInterval(hb, 4000);
  applyUI();
  E.next = performance.now() + 200; E.nextBr = E.next;
  requestAnimationFrame(frame);
  Mon._debug = { get S() { return S; }, E, N, get alarms() { return alarms; }, numbers: () => computeNumbers(performance.now()) };
};
})();
