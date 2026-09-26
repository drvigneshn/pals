/* PALS Companion — core: helpers, clinical tables, shared state and the pairing link.
   Loaded first; everything hangs off window.PC. */
(() => {
'use strict';
const PC = window.PC = {};
PC.VERSION = 'v0.1.0';

/* ---------- small helpers ---------- */
PC.$ = (s, r = document) => r.querySelector(s);
PC.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
PC.clamp = (x, a, b) => Math.min(b, Math.max(a, x));
PC.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
PC.pad = n => String(n).padStart(2, '0');
PC.mmss = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return PC.pad(Math.floor(s / 60)) + ':' + PC.pad(s % 60); };
PC.clock = (d = new Date()) => PC.pad(d.getHours()) + ':' + PC.pad(d.getMinutes()) + ':' + PC.pad(d.getSeconds());
PC.store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
PC.sess = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
PC.params = new URLSearchParams(location.search);

/* Pair codes avoid look-alike characters (I, O, 0, 1). */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
PC.newCode = () => Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
PC.cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[IO01]/g, '').slice(0, 4);
PC.rid = (n = 8) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('').toLowerCase();

/* ---------- age groups: alarm limits and "normal for age" ---------- */
PC.AGE = {
  neo:     { label: 'Newborn (0–28 d)',   hr: [100, 180], rr: [30, 60], sbpLow: 60, norm: { hr: 140, rr: 45, sbp: 70, dbp: 40 } },
  infant:  { label: 'Infant (1–12 mo)',   hr: [90, 180],  rr: [25, 55], sbpLow: 70, norm: { hr: 130, rr: 35, sbp: 85, dbp: 50 } },
  toddler: { label: 'Toddler (1–3 y)',    hr: [80, 160],  rr: [20, 40], sbpLow: 74, norm: { hr: 115, rr: 28, sbp: 95, dbp: 58 } },
  child:   { label: 'Child (4–10 y)',     hr: [70, 140],  rr: [16, 30], sbpLow: 80, norm: { hr: 95, rr: 22, sbp: 105, dbp: 65 } },
  adol:    { label: 'Adolescent (11+ y)', hr: [55, 120],  rr: [12, 24], sbpLow: 90, norm: { hr: 80, rr: 16, sbp: 115, dbp: 70 } },
};
PC.limits = g => { const a = PC.AGE[g] || PC.AGE.child; return { hr: a.hr, rr: a.rr, sbpLow: a.sbpLow, spo2Low: 90, etco2: [30, 50] }; };

/* ---------- rhythms ----------
   `id` is what the monitor draws; `pulse` is whether it perfuses.
   PEA = any organised rhythm with pulse:false (drawn as sinus). */
PC.RHYTHMS = [
  { key: 'sinus',  id: 'sinus',    label: 'Sinus',        pulse: true },
  { key: 'svt',    id: 'svt',      label: 'SVT',          pulse: true,  hr: [180, 300, 240] },
  { key: 'avb1',   id: 'avb1',     label: '1° AV block',  pulse: true },
  { key: 'avb2a',  id: 'avb2a',    label: '2° Mobitz I',  pulse: true,  hr: [40, 110, 70] },
  { key: 'avb2b',  id: 'avb2b',    label: '2° Mobitz II', pulse: true,  hr: [35, 100, 60] },
  { key: 'avb3',   id: 'avb3',     label: '3° AV block',  pulse: true,  hr: [25, 75, 50] },
  { key: 'vt',     id: 'vt',       label: 'VT',           sub: 'with pulse', pulse: true,  hr: [120, 260, 180] },
  { key: 'pvt',    id: 'vt',       label: 'pVT',          sub: 'pulseless',  pulse: false, hr: [120, 260, 200], arrest: true },
  { key: 'tdp',    id: 'torsades', label: 'Torsades',     sub: 'pulseless',  pulse: false, arrest: true },
  { key: 'vf',     id: 'vf',       label: 'VF',           sub: 'coarse', pulse: false, arrest: true },
  { key: 'vffine', id: 'vffine',   label: 'VF',           sub: 'fine',   pulse: false, arrest: true },
  { key: 'asys',   id: 'asystole', label: 'Asystole',     pulse: false, arrest: true },
  { key: 'pea',    id: 'sinus',    label: 'PEA',          sub: 'organised, no pulse', pulse: false, arrest: true },
];
PC.NON_PERFUSING = new Set(['vf', 'vffine', 'asystole', 'torsades']);
PC.perfusing = s => !!s.pulse && !PC.NON_PERFUSING.has(s.rhythm);
PC.rhythmKey = s => {
  if (!s.pulse && !['vt', 'torsades', 'vf', 'vffine', 'asystole'].includes(s.rhythm)) return 'pea';
  const r = PC.RHYTHMS.find(r => r.id === s.rhythm && r.pulse === !!s.pulse) || PC.RHYTHMS.find(r => r.id === s.rhythm);
  return r ? r.key : 'sinus';
};
PC.rhythmName = s => {
  const r = PC.RHYTHMS.find(x => x.key === PC.rhythmKey(s));
  return r ? r.label + (r.sub ? ' (' + r.sub + ')' : '') : s.rhythm;
};

/* ---------- drug doses (AHA PALS weight-based; owner to verify against current guidance) ---------- */
const r2 = x => Math.round(x * 100) / 100;
const r1 = x => Math.round(x * 10) / 10;
PC.DOSES = [
  { key: 'adr',    name: 'Adrenaline IV/IO',  calc: w => { const mg = Math.min(r2(0.01 * w), 1); return `${mg} mg = ${r1(mg * 10)} mL of 0.1 mg/mL (1:10 000)`; }, note: '0.01 mg/kg, max 1 mg, every 3–5 min' },
  { key: 'amio',   name: 'Amiodarone',        calc: w => `${Math.min(Math.round(5 * w), 300)} mg`, note: '5 mg/kg (max 300 mg), up to 3 doses in VF/pVT' },
  { key: 'lido',   name: 'Lidocaine',         calc: w => `${Math.min(r1(1 * w), 100)} mg`, note: '1 mg/kg loading dose' },
  { key: 'aden1',  name: 'Adenosine 1st',     calc: w => `${Math.min(r2(0.1 * w), 6)} mg`, note: '0.1 mg/kg (max 6 mg), rapid push + flush' },
  { key: 'aden2',  name: 'Adenosine 2nd',     calc: w => `${Math.min(r2(0.2 * w), 12)} mg`, note: '0.2 mg/kg (max 12 mg)' },
  { key: 'atro',   name: 'Atropine',          calc: w => `${Math.min(r2(0.02 * w), 0.5)} mg`, note: '0.02 mg/kg (max single dose 0.5 mg)' },
  { key: 'bolus',  name: 'Fluid bolus',       calc: w => `${Math.round(10 * w)}–${Math.round(20 * w)} mL`, note: '10–20 mL/kg isotonic crystalloid; reassess after each' },
  { key: 'd10',    name: 'Dextrose 10%',      calc: w => `${Math.round(2 * w)}–${Math.round(5 * w)} mL`, note: '0.2–0.5 g/kg = 2–5 mL/kg of D10' },
  { key: 'ca',     name: 'Calcium chloride 10%', calc: w => `${Math.min(Math.round(20 * w), 2000)} mg = ${r1(Math.min(0.2 * w, 20))} mL`, note: '20 mg/kg (0.2 mL/kg); hyperK, hypoCa, CCB toxicity' },
  { key: 'bicarb', name: 'Sodium bicarbonate', calc: w => `${Math.round(w)} mEq`, note: '1 mEq/kg; hyperK, TCA toxicity' },
  { key: 'adrim',  name: 'Adrenaline IM',     calc: w => { const mg = Math.min(r2(0.01 * w), 0.5); return `${mg} mg = ${r2(mg)} mL of 1 mg/mL (1:1000)`; }, note: '0.01 mg/kg IM (max 0.3 mg child, 0.5 mg adolescent); anaphylaxis' },
  { key: 'mgso4',  name: 'Magnesium sulphate', calc: w => `${Math.min(Math.round(25 * w), 2000)}–${Math.min(Math.round(50 * w), 2000)} mg`, note: '25–50 mg/kg (max 2 g) over 15–30 min; torsades, severe asthma' },
  { key: 'prazo',  name: 'Prazosin (scorpion)', calc: w => `${Math.round(30 * w)} mcg`, note: '30 mcg/kg per dose (IAP)' },
];
PC.dose = (key, w) => { const d = PC.DOSES.find(x => x.key === key); return d ? d.calc(w) : ''; };
PC.ENERGIES = [
  { key: 'd2',  label: '2 J/kg',   per: 2,   kind: 'defib', note: '1st shock' },
  { key: 'd4',  label: '4 J/kg',   per: 4,   kind: 'defib', note: '2nd shock' },
  { key: 'd6',  label: '6 J/kg',   per: 6,   kind: 'defib', note: '≥4 J/kg' },
  { key: 'd10', label: '10 J/kg',  per: 10,  kind: 'defib', note: 'max (or adult dose)' },
  { key: 's05', label: '0.5 J/kg', per: 0.5, kind: 'sync',  note: 'sync 1st' },
  { key: 's1',  label: '1 J/kg',   per: 1,   kind: 'sync',  note: 'sync 1st' },
  { key: 's2',  label: '2 J/kg',   per: 2,   kind: 'sync',  note: 'sync next' },
];
PC.joules = (per, w) => Math.max(1, Math.min(Math.round(per * w), 200));

/* Replace {adr}, {amio}, … in scenario text with the weight-based dose. {J2} → joules at 2 J/kg. */
PC.fillDoses = (text, w) => String(text)
  .replace(/\{J([\d.]+)\}/g, (_, p) => PC.joules(parseFloat(p), w) + ' J')
  .replace(/\{(\w+)\}/g, (m, k) => { const d = PC.DOSES.find(x => x.key === k); return d ? d.calc(w) : m; });

/* ---------- the one shared state object (instructor owns it) ---------- */
PC.defaultState = () => ({
  v: { hr: 110, spo2: 98, rr: 24, etco2: 38, sbp: 100, dbp: 62, temp: 37.0 },
  vt: 0, ramp: 0,                 // when vitals were applied (ms epoch) and drift duration (ms)
  rhythm: 'sinus', pulse: true,
  leads: true, probe: true, co2On: true, cuff: true, co2Shape: 'normal',
  cpr: false, cprQ: 'good', cprRate: 110,
  sync: false, shockAt: 0, shockJ: 0,
  nibpAt: 0, nibpAuto: 0,         // auto interval in minutes (0 = manual)
  silenceAt: 0, alarms: true, beep: true,
  monTheme: 'dark', frozen: false,
  pt: { group: 'child', age: '5 y', wt: 18, bed: 'Resus 1' },
  reveal: { on: false, title: '', text: '' },
  t: 0,
});
PC.mergeState = st => {
  const d = PC.defaultState();
  const o = Object.assign(d, st || {});
  o.v = Object.assign(PC.defaultState().v, (st && st.v) || {});
  o.pt = Object.assign(PC.defaultState().pt, (st && st.pt) || {});
  o.reveal = Object.assign(PC.defaultState().reveal, (st && st.reveal) || {});
  return o;
};

/* ---------- Link: pairs one instructor with one or more monitors ----------
   Three transports run side by side; duplicates are dropped by the state's `t`.
   1. BroadcastChannel – two windows on the same device (works offline).
   2. MQTT over secure WebSocket through public brokers – different devices.
      The state topic is retained so a monitor that joins late gets it at once.
   Only simulated values travel here: never add real patient identifiers. */
const DEFAULT_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
PC.brokers = () => {
  const p = PC.params.get('mqtt');
  if (p === 'off') return [];
  return p ? p.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_BROKERS;
};

PC.Link = class {
  constructor(code, role, on) {
    this.code = code; this.role = role; this.on = on || {};
    this.id = PC.rid(10);
    this.base = 'pediaos-pals-v1/' + code;
    this.clients = []; this.bc = null; this.last = null;
  }
  start() {
    try {
      this.bc = new BroadcastChannel('pals-' + this.code);
      this.bc.onmessage = e => this._in(e.data, 'local');
    } catch {}
    if (window.mqtt) for (const url of PC.brokers()) {
      let c;
      try {
        c = mqtt.connect(url, { clientId: 'pals_' + this.role[0] + '_' + PC.rid(10), keepalive: 30,
          reconnectPeriod: 4000, connectTimeout: 10000, clean: true });
      } catch { continue; }
      c.on('connect', () => {
        c.subscribe([this.base + '/state', this.base + '/hb/#']);
        if (this.last && this.role === 'ctl') c.publish(this.base + '/state', this.last, { retain: true });
        this._status();
      });
      c.on('message', (topic, buf) => { try { this._in(JSON.parse(buf.toString()), 'relay'); } catch {} });
      ['close', 'offline', 'error', 'reconnect'].forEach(ev => c.on(ev, () => this._status()));
      this.clients.push(c);
    }
    this._status();
  }
  relaysUp() { return this.clients.filter(c => c.connected).length; }
  _status() { this.on.status && this.on.status({ relays: this.relaysUp(), of: this.clients.length, local: !!this.bc }); }
  _in(msg, via) {
    if (!msg || msg.from === this.id) return;
    if (msg.k === 'state' && this.on.state) this.on.state(msg.st, via);
    if (msg.k === 'hb' && this.on.hb) this.on.hb(msg, via);
  }
  _pub(topic, obj, retain) {
    const s = JSON.stringify(obj);
    try { this.bc && this.bc.postMessage(obj); } catch {}
    for (const c of this.clients) if (c.connected) c.publish(topic, s, { retain: !!retain, qos: 0 });
    return s;
  }
  sendState(st) { this.last = this._pub(this.base + '/state', { k: 'state', from: this.id, st }, true); }
  heartbeat(extra) { this._pub(this.base + '/hb/' + this.role, Object.assign({ k: 'hb', role: this.role, from: this.id, at: Date.now() }, extra || {})); }
  stop() { try { this.bc && this.bc.close(); } catch {} for (const c of this.clients) try { c.end(true); } catch {} this.clients = []; }
};

/* Keep the screen awake while the app is open (where supported). */
PC.wake = async () => {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') PC._wl = await navigator.wakeLock.request('screen'); } catch {}
};
document.addEventListener('visibilitychange', () => { if (PC._wantWake) PC.wake(); });

PC.toast = msg => {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(PC._tt); PC._tt = setTimeout(() => t.classList.remove('show'), 1800);
};
})();
