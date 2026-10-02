/* PALS Companion — instructor controller (phone) + app boot/routing.
   The controller owns the state object and sends the whole of it on every change. */
(() => {
'use strict';
const { $, $$, esc, clamp } = PC;
const KEY = 'pals-ctl-v1';

/* ---------- persisted controller session ---------- */
const saved = PC.store.get(KEY, null) || {};
let S = PC.mergeState(saved.S);
let staged = { ...S.v };
let ramp = saved.ramp != null ? saved.ramp : 10000;
let energyKey = saved.energyKey || 'd2';
let log = saved.log || [];
let T = Object.assign({ scRun: false, scStart: 0, scAcc: 0, cycleStart: 0, adrAt: 0, shocks: 0, adr: 0, startAt: 0, endAt: 0 }, saved.T);
let sc = Object.assign({ id: null, stage: -1, ticks: {}, visited: [], ended: false }, saved.sc);
let code = saved.code || '';
let ev = saved.ev || [];          // structured events for the debrief (snapshots, shocks, drugs, …)
let snap = saved.snap || null;    // last perfusion/CPR/shockable snapshot
let active = saved.active || {};  // surprise complications still in effect
let tab = saved.tab || 'tabLive';
let link = null, monSeenAt = 0, otherCtl = false, linkStat = { relays: 0, of: 0, local: false };
let scList = !sc.id;

const save = () => PC.store.set(KEY, { S, ramp, energyKey, log, T, sc, code, tab, ev, snap, active });
const NEW_T = () => ({ scRun: false, scStart: 0, scAcc: 0, cycleStart: 0, adrAt: 0, shocks: 0, adr: 0, startAt: 0, endAt: 0 });
const age = () => PC.AGE[S.pt.group] || PC.AGE.child;
const SHOCKABLE = st => ['vf', 'vffine', 'torsades'].includes(st.rhythm) || (st.rhythm === 'vt' && !st.pulse);
function mark(type, data) { ev.push(Object.assign({ at: Date.now(), type }, data || {})); if (ev.length > 1000) ev = ev.slice(-1000); }
/* Record every change in perfusion, CPR or shockable rhythm; the debrief integrates these. */
function track() {
  const n = { perf: PC.perfusing(S), cpr: !!S.cpr, shockable: SHOCKABLE(S) };
  if (!snap || n.perf !== snap.perf || n.cpr !== snap.cpr || n.shockable !== snap.shockable) { mark('snap', n); snap = n; }
}
const wt = () => Number(S.pt.wt) || 10;
const scen = () => PC.SCENARIOS.find(s => s.id === sc.id);

let lastBp = null;
const bpKey = () => S.v.sbp + '/' + S.v.dbp + '/' + PC.perfusing(S);
function send() {
  S.t = Math.max(Date.now(), (S.t || 0) + 1);
  otherCtl = false;
  track();
  // The monitor's BP only changes when the cuff measures. Whatever changed the BP (manual edit,
  // scenario stage, ROSC, surprise) or the pulse (arrest / ROSC), take a reading so the screen follows.
  const bp = bpKey();
  if (lastBp !== null && bp !== lastBp) nibpAfter(S.ramp || 0);
  lastBp = bp;
  if (link) link.sendState(S);
  save(); renderLive(); renderSetup(false);
}
function addLog(txt, kind) {
  if (!T.startAt) T.startAt = Date.now();
  log.push({ at: Date.now(), txt, kind: kind || '' });
  if (log.length > 600) log = log.slice(-600);
  save(); renderLog();
  if (tab === 'tabDeb') renderDeb();
}
const scElapsed = (now = Date.now()) => T.scAcc + (T.scRun ? now - T.scStart : 0);
// Log times count from the start of the session (scenario start, or the first logged action).
const logRel = at => PC.mmss(at - (T.startAt || (log[0] ? log[0].at : at)));

/* ---------- vitals / rhythm actions ---------- */
const VIT = [
  { k: 'hr', l: 'HR', step: 5, min: 0, max: 320 },
  { k: 'spo2', l: 'SpO₂', step: 2, min: 30, max: 100 },
  { k: 'rr', l: 'RR', step: 2, min: 0, max: 90 },
  { k: 'etco2', l: 'EtCO₂', step: 2, min: 0, max: 120 },
  { k: 'sbp', l: 'SBP', step: 5, min: 0, max: 250 },
  { k: 'dbp', l: 'DBP', step: 5, min: 0, max: 180 },
  { k: 'temp', l: 'Temp', step: 0.1, min: 30, max: 43, dec: 1 },
];
const RAMPS = [[0, 'Now'], [10000, '10 s'], [30000, '30 s'], [60000, '1 min'], [120000, '2 min']];
const fmtV = (k, v) => k === 'temp' ? Number(v).toFixed(1) : Math.round(v);

let nibpTimer = 0;
function applyVitals() {
  // pick up a number still being typed (some phones fire "change" only on blur)
  for (const x of VIT) { const inp = $('#in_' + x.k), n = inp ? parseFloat(inp.value) : NaN; if (!isNaN(n)) staged[x.k] = clamp(n, x.min, x.max); }
  const changed = VIT.filter(x => Number(staged[x.k]) !== Number(S.v[x.k]));
  S.v = { ...staged }; S.vt = Date.now(); S.ramp = ramp;
  if (changed.length) addLog('Vitals → ' + changed.map(x => `${x.l} ${fmtV(x.k, staged[x.k])}`).join(', ') + (ramp ? ' over ' + RAMPS.find(r => r[0] === ramp)[1] : ''), 'vitals');
  send();
}
/* The monitor's BP only changes when the cuff cycles, so start a measurement timed to finish
   as the new BP is reached (a cycle takes ~17 s). */
function nibpAfter(rampMs) {
  if (!S.cuff) return;
  clearTimeout(nibpTimer);
  nibpTimer = setTimeout(() => { S.nibpAt = Date.now(); send(); }, Math.max(0, rampMs - 15000));
}
/* Apply vitals straight away (quick actions and surprises), keeping the staged editor in step. */
function setVitals(patch, rampMs) {
  S.v = Object.assign({}, S.v, patch); staged = { ...S.v }; S.vt = Date.now(); S.ramp = rampMs;
}
function setRhythm(key) {
  const r = PC.RHYTHMS.find(x => x.key === key); if (!r) return;
  S.rhythm = r.id; S.pulse = r.pulse;
  const norm = (PC.AGE[S.pt.group] || PC.AGE.child).norm;
  let want = null;
  if (r.hr && (S.v.hr < r.hr[0] || S.v.hr > r.hr[1])) want = r.hr[2];
  if (key === 'sinus' && S.v.hr < 40) want = norm.hr;
  if (key === 'pea' && (S.v.hr < 20 || S.v.hr > 160)) want = 60;
  if (want != null) { S.v.hr = want; staged.hr = want; S.vt = Date.now(); S.ramp = 0; }
  if (!r.arrest && r.pulse && S.v.sbp < 40) { S.v.sbp = norm.sbp; S.v.dbp = norm.dbp; staged.sbp = norm.sbp; staged.dbp = norm.dbp; S.vt = Date.now(); S.ramp = 0; }
  addLog('Rhythm → ' + PC.rhythmName(S), 'rhythm');
  send();
}
function toggleCPR() {
  S.cpr = !S.cpr;
  if (S.cpr) T.cycleStart = Date.now();
  addLog(S.cpr ? 'CPR started' : 'CPR paused', 'cpr');
  send();
}
function energy() {
  let e = PC.ENERGIES.find(x => x.key === energyKey);
  const kind = S.sync ? 'sync' : 'defib';
  if (!e || e.kind !== kind) { e = PC.ENERGIES.find(x => x.kind === kind); energyKey = e.key; }
  return e;
}
function doShock() {
  const e = energy(), J = PC.joules(e.per, wt());
  S.shockAt = Date.now(); S.shockJ = J; T.shocks++;
  mark('shock', { J, sync: !!S.sync });
  addLog(`⚡ ${S.sync ? 'Synchronised cardioversion' : 'Shock'} ${J} J (${e.label}) #${T.shocks}`, 'shock');
  send();
  const b = $('#bShock'); if (b) { b.disabled = true; setTimeout(() => (b.disabled = false), 1500); }
}
function rosc() {
  const n = (PC.AGE[S.pt.group] || PC.AGE.child).norm;
  S.rhythm = 'sinus'; S.pulse = true; S.cpr = false;
  S.v = Object.assign({}, S.v, { hr: Math.round(n.hr * 1.2), spo2: 94, rr: S.v.rr || n.rr, etco2: 44, sbp: Math.round(n.sbp * 0.85), dbp: Math.round(n.dbp * 0.85) });
  staged = { ...S.v }; S.vt = Date.now(); S.ramp = 20000;
  addLog('ROSC', 'rosc');
  send();
}

/* ---------- drugs, team events, quick actions, surprises ---------- */
const EVENTS = [
  { key: 'adr', label: 'Adrenaline', drug: 'adr' },
  { key: 'amio', label: 'Amiodarone', drug: 'amio' },
  { key: 'bolus', label: 'Fluid bolus', drug: 'bolus' },
  { key: 'check', label: 'Pulse check' },
  { key: 'airway', label: 'Airway secured' },
  { key: 'access', label: 'IV / IO in' },
  { key: 'bvm', label: 'BVM started' },
  { key: 'glucose', label: 'Glucose checked' },
];
function logDrug(key) {
  const d = PC.DOSES.find(x => x.key === key); if (!d) return;
  if (key === 'adr') { T.adrAt = Date.now(); T.adr++; }
  mark('drug', { key });
  addLog(`💉 ${d.name} ${d.calc(wt())}`, 'drug'); PC.toast(d.name + ' logged'); renderTimers();
}
function logEvent(key) {
  const e = EVENTS.find(x => x.key === key); if (!e) return;
  if (e.drug) return logDrug(e.drug);
  if (key === 'check') T.cycleStart = Date.now();
  mark('event', { key });
  addLog('✚ ' + e.label, 'event'); PC.toast(e.label + ' logged'); renderTimers();
}
const QUICK = [['vf', 'VF', 'red'], ['pvt', 'pVT', 'red'], ['pea', 'PEA', 'red'], ['asys', 'Asystole', 'red'],
  ['brady', 'Brady', ''], ['svt', 'SVT', ''], ['hypox', 'Hypoxia', ''], ['rosc', 'ROSC', 'pri']];
function quick(k) {
  if (['vf', 'pvt', 'pea', 'asys', 'svt'].includes(k)) return setRhythm(k);
  if (k === 'rosc') return rosc();
  const g = age(), n = g.norm;
  if (k === 'brady') {
    S.rhythm = 'sinus'; S.pulse = true;
    const p = { hr: Math.max(35, Math.round(g.hr[0] * 0.6)) };
    if (S.v.sbp < 40) Object.assign(p, { sbp: Math.round(n.sbp * 0.8), dbp: Math.round(n.dbp * 0.8) });
    setVitals(p, 10000); addLog('Bradycardia: HR ' + S.v.hr, 'rhythm');
  }
  if (k === 'hypox') {
    setVitals({ spo2: 80, hr: Math.round(Math.min(g.hr[1] * 1.15, Math.max(S.v.hr, n.hr) * 1.2)) }, 20000);
    addLog('Hypoxia: SpO₂ → 80 over 20 s', 'surprise');
  }
  send();
}
const RESP = [
  ['norm', 'Normal breathing'], ['distress', 'Resp distress'], ['bronch', 'Bronchospasm'], ['upper', 'Upper airway obstruction'],
  ['hypovent', 'Hypoventilation'], ['tiring', 'Resp failure (tiring)'], ['apnoea', 'Apnoea'], ['bag', 'Effective BVM / ventilation'],
];
/* Breathing states: change RR, SpO₂, EtCO₂ and capnogram shape together (drift over 20–45 s). */
function resp(k) {
  const g = age(), n = g.norm, p = PC.perfusing(S), up = f => p ? { hr: Math.round(Math.max(S.v.hr, n.hr) * f) } : {};
  const name = (RESP.find(x => x[0] === k) || [])[1];
  let shape = 'normal', r = 20000, v;
  switch (k) {
    case 'norm': v = { rr: n.rr, spo2: 98, etco2: 38 }; break;
    case 'distress': v = Object.assign({ rr: Math.round(g.rr[1] * 1.4), spo2: 91, etco2: 32 }, up(1.15)); break;
    case 'bronch': v = Object.assign({ rr: Math.round(g.rr[1] * 1.3), spo2: 88, etco2: 48 }, up(1.15)); shape = 'obstructive'; break;
    case 'upper': v = Object.assign({ rr: Math.round(g.rr[1] * 1.3), spo2: 86, etco2: 30 }, up(1.2)); break;
    case 'hypovent': v = { rr: Math.max(6, Math.round(g.rr[0] * 0.45)), spo2: 89, etco2: 60 }; break;
    case 'tiring': v = Object.assign({ rr: Math.max(8, Math.round(g.rr[0] * 0.6)), spo2: 80, etco2: 70 }, up(1.2)); r = 30000; break;
    case 'apnoea': v = { rr: 0, spo2: 70 }; r = 45000; break;
    case 'bag': v = { rr: n.rr, spo2: 96, etco2: 40 }; r = 30000; S.noVent = false; delete active.tube; break;
  }
  S.co2Shape = shape;
  setVitals(v, r);
  addLog('Breathing: ' + name, 'resp'); send(); PC.toast(name);
}
const SURPRISES = [
  { key: 'tube', label: 'Tube dislodged', sub: 'no CO₂, SpO₂ falls', when: 'any', fix: 'Tube re-sited' },
  { key: 'leads', label: 'Leads off', sub: 'technical alarm', when: 'any', fix: 'Leads reattached' },
  { key: 'probe', label: 'SpO₂ probe off', sub: 'technical alarm', when: 'any', fix: 'Probe replaced' },
  { key: 'poorcpr', label: 'Poor CPR', sub: 'slow, shallow', when: 'cpr', fix: 'CPR quality corrected' },
  { key: 'revf', label: 'Re-arrest: VF', when: 'perf' },
  { key: 'repea', label: 'Re-arrest: PEA', when: 'perf' },
  { key: 'brady', label: 'Bradycardia', when: 'perf' },
  { key: 'svt', label: 'SVT', when: 'perf' },
  { key: 'hypot', label: 'Hypotension', when: 'perf' },
  { key: 'desat', label: 'Desaturation', when: 'perf' },
  { key: 'ptx', label: 'Tension pneumothorax', sub: 'SpO₂↓ BP↓ HR↑', when: 'perf' },
];
function surprise(key) {
  const x = SURPRISES.find(s => s.key === key); if (!x) return;
  const g = age(), n = g.norm, p = PC.perfusing(S);
  switch (key) {
    case 'tube': active.tube = { spo2: S.v.spo2 }; S.noVent = true; if (p) setVitals({ spo2: 72 }, 60000); break;
    case 'leads': active.leads = 1; S.leads = false; break;
    case 'probe': active.probe = 1; S.probe = false; break;
    case 'poorcpr': active.poorcpr = 1; S.cprQ = 'poor'; break;
    case 'revf': S.rhythm = 'vf'; S.pulse = false; break;
    case 'repea': S.rhythm = 'sinus'; S.pulse = false; setVitals({ hr: 55 }, 0); break;
    case 'brady': S.rhythm = 'sinus'; S.pulse = true; setVitals({ hr: Math.max(35, Math.round(g.hr[0] * 0.6)) }, 10000); break;
    case 'svt': S.rhythm = 'svt'; S.pulse = true; setVitals({ hr: S.pt.group === 'infant' || S.pt.group === 'neo' ? 270 : 230 }, 0); break;
    case 'hypot': setVitals({ sbp: g.sbpLow - 15, dbp: Math.round((g.sbpLow - 15) * 0.55), hr: Math.round(Math.max(S.v.hr, n.hr) * 1.15) }, 20000); break;
    case 'desat': setVitals({ spo2: 82 }, 20000); break;
    case 'ptx': setVitals({ spo2: 78, sbp: g.sbpLow - 10, dbp: Math.round((g.sbpLow - 10) * 0.55), hr: Math.round(Math.max(S.v.hr, n.hr) * 1.2) }, 20000); break;
  }
  mark('surprise', { key });
  addLog('⚡ Surprise: ' + x.label, 'surprise');
  send(); PC.toast('Surprise: ' + x.label);
}
function fixSurprise(key) {
  const x = SURPRISES.find(s => s.key === key); if (!x || !active[key]) return;
  if (key === 'tube') { S.noVent = false; if (PC.perfusing(S)) setVitals({ spo2: active.tube.spo2 || 96 }, 30000); }
  if (key === 'leads') S.leads = true;
  if (key === 'probe') S.probe = true;
  if (key === 'poorcpr') S.cprQ = 'good';
  delete active[key];
  mark('fix', { key }); addLog('✔ ' + x.fix, 'event'); send();
}
function randomSurprise() {
  const p = PC.perfusing(S);
  const opts = SURPRISES.filter(x => !active[x.key] && (x.when === 'any' || (x.when === 'perf' && p) || (x.when === 'cpr' && S.cpr)));
  if (!opts.length) return PC.toast('No surprise fits right now');
  surprise(opts[Math.floor(Math.random() * opts.length)].key);
}

/* ---------- scenario actions ---------- */
function startScenario(at = 0) {
  const s = scen(); if (!s) return;
  if (log.length && !confirm('Start this scenario? The current timeline log will be cleared.')) return;
  log = []; ev = []; snap = null; active = {};
  T = Object.assign(NEW_T(), { scRun: true, scStart: Date.now(), startAt: Date.now() });
  sc.stage = -1; sc.ticks = {}; sc.visited = []; sc.ended = false;
  const keep = { monTheme: S.monTheme, beep: S.beep, alarms: S.alarms, exam: S.exam, cprBar: S.cprBar, nibpAt: S.nibpAt, shockAt: S.shockAt, silenceAt: S.silenceAt };
  S = Object.assign(PC.defaultState(), keep, { pt: Object.assign({}, s.pt) });
  addLog('Scenario started: ' + s.title, 'stage');
  loadStage(at, 0);
}
function loadStage(i, rampOverride) {
  const s = scen(); if (!s || !s.stages[i]) return;
  const st = s.stages[i], set = st.set || {};
  for (const k of Object.keys(set)) if (k !== 'v') S[k] = set[k];
  if (set.v) S.v = Object.assign({}, S.v, set.v);
  if (set.cpr) T.cycleStart = Date.now();
  staged = { ...S.v }; S.vt = Date.now();
  S.ramp = rampOverride != null ? rampOverride : (st.ramp != null ? st.ramp : 15000);
  sc.stage = i; if (!sc.visited.includes(i)) sc.visited.push(i);
  addLog(`Stage ${i + 1}: ${st.name}`, 'stage');
  send(); renderScen();
}
function endScenario() {
  if (T.scRun) { T.scAcc = scElapsed(); T.scRun = false; }
  sc.ended = true; T.endAt = Date.now();
  const sco = score();
  addLog(`Scenario ended · checklist ${sco.done}/${sco.total}`, 'stage');
  save(); renderScen(); showTab('tabDeb');
}
function score() {
  const s = scen(); if (!s) return { done: 0, total: 0 };
  let done = 0, total = 0;
  for (const i of sc.visited) (s.stages[i].expect || []).forEach((_, j) => { total++; if (sc.ticks[i + ':' + j]) done++; });
  return { done, total };
}

/* ---------- building the tabs ---------- */
function segHTML(id, opts, cur) {
  return `<div class="seg" id="${id}">` + opts.map(([v, l]) => `<button data-v="${esc(v)}" class="${String(v) === String(cur) ? 'on' : ''}">${esc(l)}</button>`).join('') + '</div>';
}
function buildLive() {
  $('#tabLive').innerHTML = `
  <div class="card"><h3>On the monitor now <span class="note" id="linkNote"></span></h3><div class="live" id="liveNow"></div></div>
  <div class="card"><h3>Quick actions <span class="note">one tap, instant</span></h3>
    <div class="qa" id="qaRh">${QUICK.map(([k, l, c]) => `<button class="chip ${c === 'red' ? 'red' : ''}" data-q="${k}" ${c === 'pri' ? 'style="border-color:var(--ok)"' : ''}>${l}</button>`).join('')}</div>
    <div class="note" style="margin:10px 0 6px">Team did… (logged for the debrief)</div>
    <div class="qa ev" id="qaEv">${EVENTS.map(e => `<button class="chip" data-ev="${e.key}">${e.label}</button>`).join('')}</div>
  </div>
  <div class="card"><h3>🫁 Breathing <span class="note">RR, SpO₂, EtCO₂ drift together</span></h3>
    <div class="qa ev" id="qaResp">${RESP.map(([k, l]) => `<button class="chip" data-resp="${k}">${l}</button>`).join('')}</div>
  </div>
  <div class="card"><h3>🫀 Cardiac arrest <span class="note">mirror what the team does, top to bottom</span></h3>
    <div class="step"><div class="sn">1</div><div class="sb">
      <b>Chest compressions</b>
      <span class="note">Tap <b>Start</b> when the team starts compressions and <b>Pause</b> for each pulse / rhythm check. The monitor then shows compression artefact, counts compressions as HR, and times the 2-minute cycle.</span>
      <button class="btn big" id="bCPR" style="width:100%"></button>
      <span class="note" id="cycleNote"></span>
      <div class="rowf"><span class="note">How good is their CPR?</span>${segHTML('segQ', [['good', '👍 Good'], ['poor', '👎 Poor']], S.cprQ)}</div>
      <span class="note">Good: rate ≈ 110, EtCO₂ ≈ 18. Poor: slow and shallow, EtCO₂ ≈ 8.</span>
    </div></div>
    <div class="step"><div class="sn">2</div><div class="sb">
      <b>Defibrillator</b>
      ${segHTML('segMode', [['defib', '⚡ Defibrillate'], ['sync', '〰 Sync cardioversion']], S.sync ? 'sync' : 'defib')}
      <span class="note" id="enNote"></span>
      <div class="chips" id="enChips"></div>
      <button class="btn red big" id="bShock" style="width:100%"></button>
      <span class="note">Press when the team delivers the shock: the monitor shows the shock artefact. Then choose the rhythm that follows.</span>
    </div></div>
    <div class="step"><div class="sn">3</div><div class="sb">
      <b>Outcome</b>
      <button class="btn big" id="bROSC" style="width:100%;border-color:var(--ok)">✅ ROSC: pulse is back</button>
      <span class="note">Stops CPR, sets sinus rhythm with a pulse; EtCO₂ jumps, SpO₂ and BP come back. Still in arrest? Pick the next rhythm in <b>Quick actions</b>.</span>
    </div></div>
    <div class="rowf" style="margin-top:6px"><button class="btn grow" id="bNIBP">Measure BP now</button><button class="btn grow" id="bSil">Silence alarms 2 min</button></div>
  </div>
  <div class="card"><h3>⚡ Surprise <span class="note">instant complications</span></h3>
    <button class="btn purple big" id="bSurp" style="width:100%">⚡ Random surprise</button>
    <div id="surpActive"></div>
    <details style="margin-top:10px"><summary class="note" style="cursor:pointer">Choose a specific complication</summary>
      <div class="sheet" id="surpList" style="margin-top:8px">${SURPRISES.map(x => `<button class="chip purple" data-surp="${x.key}">${x.label}${x.sub ? `<small>${x.sub}</small>` : ''}</button>`).join('')}</div>
    </details>
  </div>
  <div class="card"><h3>Vitals <span class="note">staged until Apply</span></h3>
    ${VIT.map(x => `<div class="vit" data-k="${x.k}"><label>${x.l}</label><button data-d="-1" aria-label="${x.l} down">−</button><input inputmode="decimal" id="in_${x.k}"><button data-d="1" aria-label="${x.l} up">+</button><span class="cur" id="cur_${x.k}"></span></div>`).join('')}
    <div style="margin:10px 0 6px" class="note">Drift over</div>
    ${segHTML('segRamp', RAMPS, ramp)}
    <div class="rowf" style="margin-top:10px"><button class="btn pri big grow" id="bApply">Apply vitals</button><button class="btn" id="bRevert">Revert</button></div>
    <div class="rowf" style="margin-top:10px"><span class="note">Stage preset:</span><button class="btn" data-pre="norm">Normal for age</button><button class="btn" data-pre="hypox">Hypoxia</button><button class="btn" data-pre="shock">Hypotension</button></div>
  </div>
  <div class="card"><h3>All rhythms <span class="note">applies instantly</span></h3><div class="chips" id="rhChips">${
    PC.RHYTHMS.map(r => `<button class="chip${r.arrest ? ' red' : ''}" data-rh="${r.key}">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</button>`).join('')}</div></div>`;
  $('#bCPR').onclick = toggleCPR;
  $('#segQ').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.cprQ = b.dataset.v; addLog('CPR quality: ' + S.cprQ); send(); };
  $('#segMode').onclick = e => { const b = e.target.closest('button'); if (!b) return; const v = b.dataset.v === 'sync'; if (v === S.sync) return; S.sync = v; addLog(v ? 'Sync cardioversion mode' : 'Defibrillation mode'); send(); };
  $('#enChips').onclick = e => { const b = e.target.closest('[data-en]'); if (!b) return; energyKey = b.dataset.en; save(); renderLive(); };
  $('#bShock').onclick = doShock;
  $('#bROSC').onclick = rosc;
  $('#bNIBP').onclick = () => { S.nibpAt = Date.now(); addLog('NIBP measurement'); send(); };
  $('#bSil').onclick = () => { S.silenceAt = Date.now(); send(); PC.toast('Alarms silenced for 2 min'); };
  $('#rhChips').onclick = e => { const b = e.target.closest('[data-rh]'); if (b) setRhythm(b.dataset.rh); };
  $('#qaRh').onclick = e => { const b = e.target.closest('[data-q]'); if (b) quick(b.dataset.q); };
  $('#qaResp').onclick = e => { const b = e.target.closest('[data-resp]'); if (b) resp(b.dataset.resp); };
  $('#qaEv').onclick = e => { const b = e.target.closest('[data-ev]'); if (b) logEvent(b.dataset.ev); };
  $('#bSurp').onclick = randomSurprise;
  $('#surpList').onclick = e => { const b = e.target.closest('[data-surp]'); if (b) surprise(b.dataset.surp); };
  $('#surpActive').onclick = e => { const b = e.target.closest('[data-fix]'); if (b) fixSurprise(b.dataset.fix); };
  $$('#tabLive .vit').forEach(row => {
    const k = row.dataset.k, x = VIT.find(v => v.k === k), inp = row.querySelector('input');
    row.querySelectorAll('button').forEach(b => b.onclick = () => {
      staged[k] = clamp(Math.round((Number(staged[k]) + x.step * Number(b.dataset.d)) * 10) / 10, x.min, x.max);
      renderVitals();
    });
    inp.onchange = () => { const n = parseFloat(inp.value); if (!isNaN(n)) staged[k] = clamp(n, x.min, x.max); renderVitals(); };
  });
  $('#segRamp').onclick = e => { const b = e.target.closest('button'); if (!b) return; ramp = Number(b.dataset.v); save(); renderLive(); };
  $('#bApply').onclick = applyVitals;
  $('#bRevert').onclick = () => { staged = { ...S.v }; renderVitals(); };
  $('#tabLive').addEventListener('click', e => {
    const b = e.target.closest('[data-pre]'); if (!b) return;
    const g = PC.AGE[S.pt.group] || PC.AGE.child, n = g.norm;
    if (b.dataset.pre === 'norm') staged = { hr: n.hr, spo2: 98, rr: n.rr, etco2: 38, sbp: n.sbp, dbp: n.dbp, temp: 37.0 };
    if (b.dataset.pre === 'hypox') Object.assign(staged, { spo2: 82, hr: Math.round(g.hr[1] * 1.05), rr: Math.round(g.rr[1] * 1.2) });
    if (b.dataset.pre === 'shock') Object.assign(staged, { hr: Math.round(g.hr[1] * 1.1), sbp: g.sbpLow - 10, dbp: Math.round((g.sbpLow - 10) * 0.55) });
    renderVitals(); PC.toast('Staged: press Apply');
  });
}
function renderVitals() {
  for (const x of VIT) {
    const inp = $('#in_' + x.k); if (!inp) continue;
    if (document.activeElement !== inp) inp.value = fmtV(x.k, staged[x.k]);
    inp.classList.toggle('changed', Number(staged[x.k]) !== Number(S.v[x.k]));
    $('#cur_' + x.k).textContent = fmtV(x.k, S.v[x.k]);
  }
  const n = VIT.filter(x => Number(staged[x.k]) !== Number(S.v[x.k])).length, b = $('#bApply');
  if (b) { b.textContent = n ? `Apply ${n} change${n > 1 ? 's' : ''} ▶` : 'Apply vitals'; b.className = 'btn big grow ' + (n ? 'warn' : 'pri'); }
}
function renderLive() {
  if (!$('#bCPR')) return;
  const b = $('#bCPR');
  b.textContent = S.cpr ? '⏸ Pause compressions (pulse / rhythm check)' : '▶ Start compressions'; b.className = 'btn big ' + (S.cpr ? 'red' : 'pri');
  $$('#segQ button').forEach(x => x.classList.toggle('on', x.dataset.v === S.cprQ));
  $$('#segMode button').forEach(x => x.classList.toggle('on', (x.dataset.v === 'sync') === S.sync));
  const e = energy();
  $('#enChips').innerHTML = PC.ENERGIES.filter(x => x.kind === (S.sync ? 'sync' : 'defib'))
    .map(x => `<button class="chip${x.key === e.key ? ' on' : ''}" data-en="${x.key}">${PC.joules(x.per, wt())} J<small>${esc(x.label)} · ${esc(x.note)}</small></button>`).join('');
  $('#enNote').innerHTML = (S.sync ? '<b>Sync cardioversion</b> for SVT / VT <b>with a pulse</b>; sync markers appear on each R wave.' : '<b>Defibrillation</b> for VF / pulseless VT.') + ` Energy for ${esc(S.pt.wt)} kg:`;
  $('#bShock').textContent = `⚡ ${S.sync ? 'Cardiovert' : 'Shock'} ${PC.joules(e.per, wt())} J`;
  $$('#rhChips .chip').forEach(c => c.classList.toggle('on', c.dataset.rh === PC.rhythmKey(S)));
  $$('#qaRh .chip').forEach(c => c.classList.toggle('on', c.dataset.q === PC.rhythmKey(S)));
  const act = Object.keys(active);
  $('#surpActive').innerHTML = act.length ? `<div class="note" style="margin:10px 0 6px">Active, tap when the team fixes it:</div><div class="rowf">${
    act.map(k => { const x = SURPRISES.find(s => s.key === k); return `<button class="btn" data-fix="${k}">✔ ${esc(x.fix)}</button>`; }).join('')}</div>` : '';
  $$('#segRamp button').forEach(x => x.classList.toggle('on', Number(x.dataset.v) === ramp));
  const flags = [S.noVent && 'no CO₂ (airway)', S.exam && 'exam mode', !S.leads && 'leads off', !S.probe && 'probe off', !S.co2On && 'CO₂ off', S.sync && 'SYNC', S.frozen && 'FROZEN', !S.alarms && 'alarms off'].filter(Boolean);
  $('#liveNow').innerHTML = `<span><b>${esc(PC.rhythmName(S))}</b></span>` +
    [['HR', S.v.hr], ['SpO₂', S.v.spo2], ['RR', S.v.rr], ['EtCO₂', S.v.etco2], ['BP', S.v.sbp + '/' + S.v.dbp]].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('') +
    (S.cpr ? `<span><b style="color:var(--danger)">CPR ${S.cprQ}</b></span>` : '') + (flags.length ? `<span>${esc(flags.join(' · '))}</span>` : '');
  renderVitals(); renderTimers();
}

/* ---------- scenario tab ---------- */
function renderScen() {
  const el = $('#tabScen'); if (!el) return;
  const s = scen();
  if (scList || !s) {
    const cats = [...new Set(PC.SCENARIOS.map(x => x.cat))];
    el.innerHTML = `<div class="card"><h3>Scenarios</h3><p class="note" style="margin:0">Pick one to see the stem, stages and checklist. Cues and doses are shown only here, never on the monitor.</p></div>` +
      cats.map(c => `<div class="card"><h3>${esc(c)}</h3><div style="display:flex;flex-direction:column;gap:8px">${
        PC.SCENARIOS.filter(x => x.cat === c).map(x => `<button class="scen" data-sc="${x.id}"><b>${esc(x.title)}${x.id === sc.id ? ' · <span style="color:var(--acc)">current</span>' : ''}</b><span>${esc(x.pt.age)} · ${x.pt.wt} kg · ${x.stages.length} stages</span></button>`).join('')
      }</div></div>`).join('');
    el.onclick = e => { const b = e.target.closest('[data-sc]'); if (!b) return;
      if (b.dataset.sc !== sc.id) { sc = { id: b.dataset.sc, stage: -1, ticks: {}, visited: [], ended: false }; }
      scList = false; save(); renderScen(); window.scrollTo(0, 0); };
    return;
  }
  const w = s.pt.wt, cur = s.stages[sc.stage], running = sc.stage >= 0 && !sc.ended;
  const fill = t => esc(PC.fillDoses(t, w));
  let nextBtns = '';
  if (cur && !sc.ended) {
    if (cur.next) nextBtns = cur.next.map(n => `<button class="btn pri grow" data-go="${n.to}">${esc(n.label)}</button>`).join('');
    else if (sc.stage < s.stages.length - 1 && !cur.end) nextBtns = `<button class="btn pri big grow" data-go="${sc.stage + 1}">Next stage ▶</button>`;
    nextBtns += `<button class="btn" data-end="1">End scenario</button>`;
  }
  el.innerHTML = `
  <button class="btn" data-back="1" style="align-self:flex-start">← All scenarios</button>
  <div class="card"><h3><span><span class="tagc">${esc(s.cat)}</span>${esc(s.pt.age)} · ${s.pt.wt} kg</span></h3>
    <b style="font-size:18px">${esc(s.title)}</b>
    <div class="stem" style="margin:10px 0"><div class="note" style="margin-bottom:4px">Read to the team</div>${esc(s.stem)}</div>
    <button class="btn ${running ? '' : 'pri big'}" data-start="1" style="width:100%">${running ? '↺ Restart scenario' : sc.ended ? '↺ Run again' : '▶ Start scenario'}</button>
  </div>
  ${cur ? `<div class="card" style="border-color:var(--acc)"><h3>Stage ${sc.stage + 1} of ${s.stages.length}${sc.ended ? ' · ended' : ''}</h3>
    <b style="font-size:17px">${esc(cur.name)}</b>
    <ul class="cues">${(cur.cues || []).map(c => `<li>${fill(c)}</li>`).join('')}</ul>
    ${(cur.expect || []).length ? `<div class="note" style="margin:10px 0 2px">Tick what the team does</div>` + cur.expect.map((x, j) => {
      const id = sc.stage + ':' + j;
      return `<label class="chk"><input type="checkbox" data-tick="${id}" ${sc.ticks[id] ? 'checked' : ''}><span>${fill(x)}</span></label>`;
    }).join('') : ''}
    <div class="rowf" style="margin-top:12px">${nextBtns}</div>
  </div>` : ''}
  <div class="card"><h3>Stages <span class="note">tap to jump</span></h3><div style="display:flex;flex-direction:column;gap:8px">${
    s.stages.map((st, i) => `<button class="stage${i === sc.stage ? ' cur' : ''}" data-go="${i}"><span class="n">${i + 1}</span><span><b>${esc(st.name)}</b><div class="d">${esc(stageSummary(st))}</div></span></button>`).join('')
  }</div></div>`;
  el.onclick = e => {
    const t = e.target;
    if (t.closest('[data-back]')) { scList = true; renderScen(); window.scrollTo(0, 0); return; }
    if (t.closest('[data-start]')) { startScenario(); return; }
    if (t.closest('[data-end]')) { if (confirm('End the scenario and stop the clock?')) endScenario(); return; }
    const g = t.closest('[data-go]');
    if (g) {
      const i = Number(g.dataset.go);
      if (sc.stage < 0 || sc.ended) startScenario(i); else loadStage(i);
      window.scrollTo(0, 0);
    }
  };
  el.onchange = e => {
    const c = e.target.closest('[data-tick]'); if (!c) return;
    const id = c.dataset.tick; sc.ticks[id] = c.checked ? Date.now() : 0;
    const [i, j] = id.split(':').map(Number);
    if (c.checked) addLog('✓ ' + PC.fillDoses(s.stages[i].expect[j], w), 'tick'); else save();
  };
}
function stageSummary(st) {
  const set = st.set || {}, v = set.v || {};
  const parts = [];
  if (set.rhythm) parts.push(PC.rhythmName(Object.assign({ pulse: true }, set)));
  if (v.hr) parts.push('HR ' + v.hr);
  if (v.spo2 && set.pulse !== false) parts.push('SpO₂ ' + v.spo2);
  if (v.sbp) parts.push('BP ' + v.sbp + '/' + v.dbp);
  if (v.etco2 && set.pulse !== false) parts.push('EtCO₂ ' + v.etco2);
  return parts.join(' · ');
}

/* ---------- timeline tab ---------- */
function buildTime() {
  $('#tabTime').innerHTML = `
  <div class="card"><h3>Timers <span class="note">tap scenario clock to pause</span></h3><div class="timers">
    <button class="tm" id="tmSc" style="text-align:left"><div class="k">Scenario</div><div class="v" id="tvSc">00:00</div></button>
    <div class="tm" id="tmCy"><div class="k">CPR cycle (2 min)</div><div class="v" id="tvCy">--:--</div></div>
    <div class="tm" id="tmAd"><div class="k">Since adrenaline</div><div class="v" id="tvAd">--:--</div></div>
    <div class="tm"><div class="k">Shocks · Adrenaline</div><div class="v" id="tvCnt">0 · 0</div></div>
  </div>
  <div class="rowf" style="margin-top:10px"><button class="btn grow" id="bCheck">Rhythm check → new 2-min cycle</button></div></div>
  <div class="card"><h3>Drugs <span class="note" id="wtNote"></span></h3><div class="chips" id="doseGrid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))"></div>
    <p class="note" style="margin:8px 0 0">Tap to log a dose. Doses follow AHA PALS weight-based dosing; verify against your unit protocol.</p></div>
  <div class="card" id="scoreCard"></div>
  <div class="card"><h3>Log <span class="rowf"><button class="btn" id="bCopy">Copy</button><button class="btn" id="bClear">Clear</button></span></h3>
    <div class="rowf" style="margin-bottom:8px"><input id="noteIn" class="grow" placeholder="Add a note (e.g. IO inserted)" style="padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg)"><button class="btn pri" id="bNote">Add</button></div>
    <div class="log" id="logBox"></div></div>`;
  $('#tmSc').onclick = () => {
    if (T.scRun) { T.scAcc = scElapsed(); T.scRun = false; addLog('Clock paused'); }
    else { T.scStart = Date.now(); T.scRun = true; addLog(T.scAcc ? 'Clock resumed' : 'Clock started'); }
    save(); renderTimers();
  };
  $('#bCheck').onclick = () => logEvent('check');
  $('#doseGrid').onclick = e => { const b = e.target.closest('[data-dose]'); if (b) logDrug(b.dataset.dose); };
  $('#bNote').onclick = () => { const v = $('#noteIn').value.trim(); if (v) { addLog('📝 ' + v, 'note'); $('#noteIn').value = ''; } };
  $('#noteIn').onkeydown = e => { if (e.key === 'Enter') $('#bNote').click(); };
  $('#bCopy').onclick = copyLog;
  $('#bClear').onclick = () => { if (confirm('Clear the log, timers and debrief?')) { log = []; ev = []; snap = null; T = NEW_T(); save(); renderLog(); renderTimers(); } };
}
function renderDoses() {
  const g = $('#doseGrid'); if (!g) return;
  g.innerHTML = PC.DOSES.map(d => `<button class="dose" data-dose="${d.key}"><b>${esc(d.name)}</b>${esc(d.calc(wt()))}<br><span>${esc(d.note)}</span></button>`).join('');
  $('#wtNote').textContent = S.pt.wt + ' kg';
}
function renderTimers() {
  const now = Date.now();
  const cy = S.cpr && T.cycleStart ? 120000 - (now - T.cycleStart) : null;
  const cyTxt = cy == null ? '--:--' : cy >= 0 ? PC.mmss(cy) : 'CHECK';
  const cn = $('#cycleNote');
  if (cn) cn.innerHTML = S.cpr ? `Rhythm check in <b style="color:${cy < 0 ? 'var(--danger)' : cy < 15000 ? 'var(--warn)' : 'var(--txt)'}">${cyTxt}</b>${cy < 0 ? ' · rhythm check due' : ''}` +     (T.adrAt ? ` · adrenaline ${PC.mmss(now - T.adrAt)} ago` : '') : (T.shocks ? `Not running · ${T.shocks} shock(s) given` : 'Not running');
  if (!$('#tvSc')) return;
  $('#tvSc').textContent = PC.mmss(scElapsed(now)) + (T.scRun || !T.scAcc ? '' : ' ⏸');
  $('#tvCy').textContent = cyTxt;
  $('#tmCy').className = 'tm ' + (cy == null ? '' : cy < 0 ? 'r' : cy < 15000 ? 'a' : 'g');
  const ad = T.adrAt ? now - T.adrAt : null;
  $('#tvAd').textContent = ad == null ? '--:--' : PC.mmss(ad);
  $('#tmAd').className = 'tm ' + (ad == null ? '' : ad < 180000 ? 'g' : ad < 300000 ? 'a' : 'r');
  $('#tvCnt').textContent = T.shocks + ' · ' + T.adr;
}
function renderLog() {
  const box = $('#logBox'); if (!box) return;
  box.innerHTML = log.length ? log.map(l => `<div><span class="tt">${logRel(l.at)}</span>${esc(l.txt)}</div>`).join('') : '<div class="note">Actions you take are logged here automatically.</div>';
  box.scrollTop = box.scrollHeight;
  const s = scen(), card = $('#scoreCard');
  if (card) {
    if (s && sc.visited.length) {
      const sco = score();
      card.innerHTML = `<h3>Checklist · ${esc(s.title)}</h3><div style="font:700 28px/1.2 ui-monospace,monospace">${sco.done} / ${sco.total}</div><div class="note">Items ticked in the stages the team reached. Tick them in the Scenario tab.</div>`;
      card.classList.remove('hide');
    } else card.classList.add('hide');
  }
}
function copyLog() {
  const s = scen();
  const lines = ['PALS Companion: session log', new Date().toLocaleString(),
    s ? `Scenario: ${s.title} (${S.pt.age}, ${S.pt.wt} kg)` : `Patient: ${S.pt.age}, ${S.pt.wt} kg`, ''];
  const D = computeDebrief();
  if (D.m.length) { lines.push('Key times'); D.m.forEach(([k, v, , sub]) => lines.push(`  ${k}: ${v}${sub ? ' (' + sub + ')' : ''}`)); lines.push(''); }
  log.forEach(l => lines.push(`[${logRel(l.at)}] ${l.txt}`));
  if (s && sc.visited.length) {
    const sco = score(); lines.push('', `Checklist ${sco.done}/${sco.total}`);
    sc.visited.forEach(i => (s.stages[i].expect || []).forEach((x, j) => lines.push(`${sc.ticks[i + ':' + j] ? '✓' : '✗'} ${PC.fillDoses(x, s.pt.wt)}`)));
  }
  const txt = lines.join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => PC.toast('Log copied'), () => { prompt('Copy the log:', txt); });
}

/* ---------- debrief ---------- */
const dur = ms => ms < 60000 ? Math.round(ms / 1000) + ' s' : PC.mmss(ms);
const DEB_KINDS = new Set(['stage', 'rhythm', 'cpr', 'shock', 'drug', 'event', 'surprise', 'rosc', 'note', 'resp']);
function computeDebrief() {
  const end = T.endAt || Date.now();
  const snaps = ev.filter(e => e.type === 'snap');
  const m = [];
  const arrestAt = (snaps.find(x => !x.perf) || {}).at;
  const shocks = ev.filter(e => e.type === 'shock' && !e.sync);
  const adr = ev.filter(e => e.type === 'drug' && e.key === 'adr');
  if (arrestAt) {
    const cprAt = (snaps.find(x => x.at >= arrestAt && x.cpr) || {}).at;
    const roscAt = (snaps.find(x => x.at > arrestAt && x.perf) || {}).at;
    const shockableAt = (snaps.find(x => x.shockable) || {}).at;
    // integrate arrest time, CPR time and hands-off pauses (after CPR first started)
    let arrestMs = 0, cprMs = 0, offMs = 0, run = 0, longest = 0;
    snaps.forEach((x, i) => {
      const d = Math.max(0, (i + 1 < snaps.length ? snaps[i + 1].at : end) - x.at);
      const off = !x.perf && !x.cpr && cprAt && x.at >= cprAt;
      if (!x.perf) { arrestMs += d; if (x.cpr) cprMs += d; }
      if (off) { offMs += d; run += d; } else if (x.perf || x.cpr) { longest = Math.max(longest, run); run = 0; }
    });
    longest = Math.max(longest, run);
    const tCpr = cprAt != null ? cprAt - arrestAt : null;
    m.push(['Time to CPR', tCpr == null ? 'not started' : dur(tCpr), tCpr == null ? 'r' : tCpr <= 10000 ? 'g' : tCpr <= 30000 ? 'a' : 'r', 'target ≤ 10 s']);
    if (shockableAt) {
      const fs = shocks.find(e => e.at >= shockableAt), t = fs ? fs.at - shockableAt : null;
      m.push(['First shock', t == null ? 'none' : dur(t), t == null ? 'r' : t <= 120000 ? 'g' : t <= 180000 ? 'a' : 'r', 'from shockable rhythm']);
    }
    const fa = adr.find(e => e.at >= arrestAt), ta = fa ? fa.at - arrestAt : null;
    m.push(['First adrenaline', ta == null ? 'not given' : dur(ta), ta == null ? (arrestMs > 180000 ? 'r' : '') : ta <= 300000 ? 'g' : ta <= 420000 ? 'a' : 'r', 'from arrest']);
    if (adr.length > 1) {
      const iv = adr.slice(1).map((e, i) => e.at - adr[i].at);
      m.push(['Adrenaline intervals', iv.map(PC.mmss).join(', '), iv.every(x => x >= 170000 && x <= 310000) ? 'g' : 'a', 'target 3–5 min']);
    }
    const frac = arrestMs ? Math.round(cprMs / arrestMs * 100) : 0;
    m.push(['CPR fraction', frac + ' %', frac >= 80 ? 'g' : frac >= 60 ? 'a' : 'r', 'target > 80 %']);
    m.push(['Hands-off time', dur(offMs), longest <= 10000 ? 'g' : longest <= 20000 ? 'a' : 'r', 'longest pause ' + dur(longest)]);
    m.push(['ROSC', roscAt ? dur(roscAt - arrestAt) : 'not achieved', roscAt ? 'g' : '', 'from arrest']);
  }
  if (shocks.length || ev.some(e => e.type === 'shock')) {
    const all = ev.filter(e => e.type === 'shock');
    m.push(['Shocks', String(all.length), '', all.map(e => e.J + ' J' + (e.sync ? ' sync' : '')).join(', ')]);
  }
  const drugs = ev.filter(e => e.type === 'drug');
  if (drugs.length) m.push(['Drugs logged', String(drugs.length), '', [...new Set(drugs.map(e => (PC.DOSES.find(d => d.key === e.key) || {}).name))].join(', ')]);
  const sco = score();
  if (sco.total) { const pc = sco.done / sco.total; m.push(['Checklist', `${sco.done} / ${sco.total}`, pc >= 0.8 ? 'g' : pc >= 0.6 ? 'a' : 'r', Math.round(pc * 100) + ' %']); }
  const start = T.startAt || (log[0] ? log[0].at : end);
  if (log.length) m.unshift(['Session time', PC.mmss(end - start), '', T.endAt ? 'ended' : 'running']);
  const tl = log.filter(l => DEB_KINDS.has(l.kind) || /^Scenario|^Stage/.test(l.txt)).map(l => [logRel(l.at), l.txt, l.kind]);
  return { m, tl, arrest: !!arrestAt };
}
function buildDeb() {
  $('#tabDeb').innerHTML = `
  <div class="card"><h3>Debrief <span class="note" id="debSub"></span></h3>
    <div id="debHead" style="margin-bottom:10px"></div>
    <div class="rowf noprint"><button class="btn pri grow" id="bDebShow">Show on monitor</button><button class="btn grow" id="bDebHide">Hide from monitor</button></div>
    <div class="rowf noprint" style="margin-top:8px"><button class="btn grow" id="bDebCopy">Copy summary</button><button class="btn grow" id="bDebPrint">Print / save PDF</button></div></div>
  <div class="card"><h3>Key times</h3><div class="met" id="debMet"></div></div>
  <div class="card" id="debChkCard"><h3>Checklist</h3><div id="debChk"></div></div>
  <div class="card"><h3>Timeline</h3><ol class="tline" id="debTl"></ol></div>`;
  $('#bDebShow').onclick = () => {
    const D = computeDebrief(), s = scen();
    S.debrief = { on: true, title: 'Debrief' + (s ? ' · ' + s.title : ''), m: D.m.map(x => [x[0], x[1], x[2], x[3]]), ev: D.tl.slice(-26).map(x => [x[0], x[1]]) };
    send(); PC.toast('Debrief shown on the monitor');
  };
  $('#bDebHide').onclick = () => { S.debrief = Object.assign({}, S.debrief, { on: false }); send(); };
  $('#bDebCopy').onclick = copyLog;
  $('#bDebPrint').onclick = () => {
    document.body.classList.add('print-deb');
    const off = () => { document.body.classList.remove('print-deb'); window.removeEventListener('afterprint', off); };
    window.addEventListener('afterprint', off);
    window.print(); setTimeout(off, 1500);
  };
}
function renderDeb() {
  if (!$('#debMet')) return;
  const D = computeDebrief(), s = scen();
  $('#debSub').textContent = T.endAt ? 'scenario ended' : log.length ? 'live, updates as you go' : '';
  $('#debHead').innerHTML = `<b style="font-size:17px">${esc(s ? s.title : 'Free session')}</b><div class="note">${esc(S.pt.age)} · ${esc(S.pt.wt)} kg · ${new Date(T.startAt || Date.now()).toLocaleString()} · PALS Companion ${esc(PC.VERSION)}</div>`;
  $('#debMet').innerHTML = D.m.length ? D.m.map(([k, v, tone, sub]) => `<div class="${tone || ''}"><span>${esc(k)}</span><b>${esc(v)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`).join('')
    : '<p class="note" style="margin:0">Run a scenario (or use the Live tab) and the debrief builds itself: time to CPR, first shock, adrenaline timing, CPR fraction, hands-off time and the full timeline.</p>';
  if (!D.arrest && D.m.length) $('#debMet').insertAdjacentHTML('beforeend', '<p class="note" style="grid-column:1/-1;margin:4px 0 0">No cardiac arrest in this session, so arrest timings are not shown.</p>');
  const chk = [];
  if (s) sc.visited.forEach(i => (s.stages[i].expect || []).forEach((x, j) => chk.push(`<div class="chk"><span>${sc.ticks[i + ':' + j] ? '✅' : '❌'}</span><span>${esc(PC.fillDoses(x, s.pt.wt))} <span class="note">· stage ${i + 1}</span></span></div>`)));
  $('#debChk').innerHTML = chk.join('');
  $('#debChkCard').classList.toggle('hide', !chk.length);
  $('#debTl').innerHTML = D.tl.length ? D.tl.map(([t, x, k]) => `<li class="k-${k}"><i>${t}</i>${esc(x)}</li>`).join('') : '<li class="note">No events yet.</li>';
}

/* ---------- setup tab ---------- */
const TEMPLATES = {
  abg: ['Blood gas (venous)', 'pH 7.12\npCO₂ 58 mmHg\nHCO₃ 14 mmol/L\nBE −12\nLactate 6.2 mmol/L'],
  glu: ['Bedside glucose', '38 mg/dL'],
  lytes: ['Electrolytes', 'Na 134 · K 7.8 mmol/L\nIonised Ca 0.9 mmol/L\nUrea 180 · Creatinine 3.2 mg/dL'],
  cbc: ['Blood counts', 'Hb 13.8 g/dL · Hct 48 %\nPlatelets 22 000 /µL'],
  cxr: ['Chest X-ray', 'Bilateral hyperinflation\nNo pneumothorax'],
  ecg: ['12-lead ECG', 'Wide QRS, tall peaked T waves'],
  echo: ['Bedside echo', 'Poor LV function (EF ~30 %)\nNo pericardial effusion'],
};
function buildSetup() {
  const g = S.pt;
  $('#tabSetup').innerHTML = `
  <div class="card"><h3>Pairing</h3>
    <div class="rowf"><span>Code <b id="suCode" style="font-family:ui-monospace,monospace;letter-spacing:3px">${esc(code)}</b></span><span class="grow"></span><span class="note" id="suLink"></span></div>
    <div class="rowf" style="margin-top:10px"><button class="btn grow" id="bOpenMon">Open monitor window here</button><button class="btn grow" id="bRepair">Pair another code</button></div></div>
  <div class="card"><h3>Patient</h3>
    <div class="grid2">
      <label class="fld">Age group<select id="pGroup">${Object.entries(PC.AGE).map(([k, a]) => `<option value="${k}" ${k === g.group ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
      <label class="fld">Age shown<input id="pAge" value="${esc(g.age)}"></label>
      <label class="fld">Weight (kg)<input id="pWt" inputmode="decimal" value="${esc(g.wt)}"></label>
      <label class="fld">Bed label<input id="pBed" value="${esc(g.bed)}"></label>
    </div>
    <p class="note">Age group sets the monitor's alarm limits. Weight drives doses and joules. Simulated details only.</p>
    <button class="btn pri" id="bPt" style="width:100%">Update patient</button></div>
  <div class="card"><h3>Sensors on the patient</h3>
    ${[['leads', 'ECG leads'], ['probe', 'SpO₂ probe'], ['co2On', 'Capnography line'], ['cuff', 'BP cuff']].map(([k, l]) => `<div class="tog"><span>${l}</span><button class="sw" data-sw="${k}"></button></div>`).join('')}
    <div class="tog"><span>Capnogram shape</span>${segHTML('segShape', [['normal', 'Normal'], ['obstructive', 'Shark-fin']], S.co2Shape)}</div>
    <div class="tog"><span>NIBP auto cycle</span>${segHTML('segAuto', [[0, 'Off'], [3, '3 min'], [5, '5 min'], [15, '15 min']], S.nibpAuto)}</div></div>
  <div class="card"><h3>Monitor screen</h3>
    ${[['exam', 'Exam mode (alarms say only "ALARM")'], ['cprBar', 'CPR feedback panel'], ['alarms', 'Alarms'], ['beep', 'Pulse beep'], ['frozen', 'Freeze screen (debrief)']].map(([k, l]) => `<div class="tog"><span>${l}</span><button class="sw" data-sw="${k}"></button></div>`).join('')}
    <div class="tog"><span>Monitor theme</span>${segHTML('segTheme', [['dark', 'Dark'], ['light', 'Light']], S.monTheme)}</div></div>
  <div class="card"><h3>Result card on the monitor</h3>
    <label class="fld">Template<select id="rvTpl"><option value="">Choose…</option>${Object.entries(TEMPLATES).map(([k, v]) => `<option value="${k}">${esc(v[0])}</option>`).join('')}</select></label>
    <label class="fld" style="margin-top:8px">Title<input id="rvTitle" value="${esc(S.reveal.title)}"></label>
    <label class="fld" style="margin-top:8px">Text<textarea id="rvText" rows="4">${esc(S.reveal.text)}</textarea></label>
    <div class="rowf" style="margin-top:10px"><button class="btn pri grow" id="bRvShow">Show on monitor</button><button class="btn grow" id="bRvHide">Hide</button></div></div>
  <div class="card"><h3>About</h3>
    <p style="margin:0 0 4px">PALS Companion ${esc(PC.VERSION)} · created by <b>Dr Vignesh N</b></p>
    <p class="note" style="margin:0 0 8px">Mentors: Dr Janani Sankar, Medical Director, KKCTH · Dr Radhika Raman, Senior Consultant, KKCTH</p>
    <p class="note" style="margin:0 0 10px">For training only. Not a medical device. The link uses public relays, so only simulated values are sent. Verify doses and energies against current AHA PALS / IAP guidance. Not affiliated with or endorsed by the American Heart Association. Not for reuse or redistribution without written permission.</p>
    <div class="rowf"><a class="btn" href="about.html" style="text-decoration:none">About</a><a class="btn" href="privacy.html" style="text-decoration:none">Privacy</a><button class="btn" id="bRole">Back to start screen</button><button class="btn" id="bReset">Reset everything</button></div></div>`;
  $('#bOpenMon').onclick = openLocalMonitor;
  $('#bRepair').onclick = () => { if (confirm('Disconnect from this monitor and pair a different code?')) showPair(); };
  $('#bPt').onclick = () => {
    const w = parseFloat($('#pWt').value);
    S.pt = { group: $('#pGroup').value, age: $('#pAge').value.trim().slice(0, 20), wt: isNaN(w) ? S.pt.wt : clamp(w, 0.5, 150), bed: $('#pBed').value.trim().slice(0, 24) };
    addLog(`Patient: ${S.pt.age}, ${S.pt.wt} kg`); send(); renderDoses(); PC.toast('Patient updated');
  };
  $('#tabSetup').addEventListener('click', e => {
    const sw = e.target.closest('[data-sw]');
    if (sw) {
      const k = sw.dataset.sw; S[k] = !S[k];
      const names = { leads: 'ECG leads', probe: 'SpO₂ probe', co2On: 'CO₂ line', cuff: 'BP cuff', alarms: 'Alarms', beep: 'Pulse beep', frozen: 'Freeze', exam: 'Exam mode', cprBar: 'CPR feedback panel' };
      addLog(`${names[k]} ${S[k] ? (k === 'frozen' ? 'ON' : 'on') : (k === 'frozen' ? 'OFF' : 'off')}`);
      send(); return;
    }
    const sb = e.target.closest('.seg button'); if (!sb) return;
    const seg = sb.parentElement.id, v = sb.dataset.v;
    if (seg === 'segShape') { S.co2Shape = v; addLog('Capnogram: ' + v); }
    if (seg === 'segAuto') { S.nibpAuto = Number(v); addLog('NIBP auto: ' + (Number(v) ? v + ' min' : 'off')); }
    if (seg === 'segTheme') S.monTheme = v;
    send();
  });
  $('#rvTpl').onchange = e => { const t = TEMPLATES[e.target.value]; if (t) { $('#rvTitle').value = t[0]; $('#rvText').value = t[1]; } };
  $('#bRvShow').onclick = () => { S.reveal = { on: true, title: $('#rvTitle').value.slice(0, 60), text: $('#rvText').value.slice(0, 600) }; addLog('Result shown: ' + S.reveal.title); send(); };
  $('#bRvHide').onclick = () => { S.reveal = Object.assign({}, S.reveal, { on: false }); send(); };
  $('#bRole').onclick = () => PC.leave();
  $('#bReset').onclick = () => { if (confirm('Reset all instructor data on this device (log, scenario, settings)?')) { try { localStorage.removeItem(KEY); } catch {} location.hash = '#control'; location.reload(); } };
}
function renderSetup(full) {
  if (!$('#suCode')) return;
  $$('#tabSetup [data-sw]').forEach(b => b.classList.toggle('on', !!S[b.dataset.sw]));
  $$('#segShape button').forEach(b => b.classList.toggle('on', b.dataset.v === S.co2Shape));
  $$('#segAuto button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === S.nibpAuto));
  $$('#segTheme button').forEach(b => b.classList.toggle('on', b.dataset.v === S.monTheme));
  $('#suCode').textContent = code;
  if (full !== false) { $('#pGroup').value = S.pt.group; $('#pAge').value = S.pt.age; $('#pWt').value = S.pt.wt; $('#pBed').value = S.pt.bed; }
}

/* ---------- pairing / status ---------- */
function renderStatus() {
  const on = Date.now() - monSeenAt < 12000;
  const pill = $('#cStat');
  const lbl = !code ? 'Not paired' : !on ? 'Waiting for monitor' : otherCtl ? 'Another device in control' : 'Monitor online';
  pill.innerHTML = `<span class="dot ${on && !otherCtl ? 'on' : code ? 'wait' : ''}"></span><span>${lbl}</span>`;
  $('#cCode').textContent = code || '----';
  const txt = `Relay ${linkStat.relays}/${linkStat.of}${linkStat.local ? ' · same-device ✓' : ''}`;
  const a = $('#suLink'); if (a) a.textContent = txt;
  const b = $('#linkNote'); if (b) b.textContent = !code ? '' : !on ? 'monitor not seen yet' : otherCtl ? 'another device is in control; any change here takes over' : '';
}
function connect(c) {
  if (link) link.stop();
  code = c; save();
  link = new PC.Link(code, 'ctl', {
    status: s => { linkStat = s; renderStatus(); },
    hb: m => {
      if (m.role !== 'mon') return;
      const fresh = Date.now() - monSeenAt > 12000;
      monSeenAt = Date.now(); renderStatus();
      if (fresh) PC.toast('Monitor connected');
      // Resend if the monitor has nothing yet, or missed one of our updates. If another instructor
      // device took over, don't fight it: show a notice; our next action takes control back.
      otherCtl = !!m.gotFrom && m.gotFrom !== link.id;
      if (!m.gotFrom || (!otherCtl && (m.gotT || 0) < (S.t || 0))) link.sendState(S);
      renderStatus();
    },
  });
  link.start();
  lastBp = bpKey();                      // the monitor starts with this BP on screen
  if (!S.t) S.t = Date.now();
  link.sendState(S);
  link.heartbeat();
  showMain();
}
function showPair() {
  if (link) { link.stop(); link = null; }
  code = ''; save(); monSeenAt = 0;
  $('#pairBox').classList.remove('hide');
  $$('#ctl > .pane:not(#pairBox)').forEach(p => p.classList.add('hide'));
  $('#cTabs').classList.add('hide');
  renderStatus();
  setTimeout(() => $('#pairIn').focus(), 50);
}
function showMain() {
  $('#pairBox').classList.add('hide');
  $('#cTabs').classList.remove('hide');
  showTab(tab);
  renderStatus();
}
function showTab(id) {
  tab = id; save();
  $$('#ctl > .pane:not(#pairBox)').forEach(p => p.classList.toggle('hide', p.id !== id));
  $$('#cTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  if (id === 'tabScen') renderScen();
  if (id === 'tabTime') { renderDoses(); renderLog(); renderTimers(); }
  if (id === 'tabSetup') renderSetup();
  if (id === 'tabDeb') renderDeb();
  if (id === 'tabLive') renderLive();
}
function openLocalMonitor() {
  if (!code) connect(PC.newCode());
  const w = window.open(location.pathname + '#monitor=' + code, 'pals-monitor-' + code, 'popup,width=1280,height=760');
  if (!w) PC.toast('Allow pop-ups to open the monitor window');
}

PC.Controller = {
  openLocal: () => openLocalMonitor(),
  start(initialCode) {
    $('#ctl').classList.remove('hide');
    document.title = 'PALS Companion · Instructor';
    const mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
    const theme = () => (document.documentElement.dataset.theme = mq && mq.matches ? 'light' : 'dark');
    theme(); mq && mq.addEventListener && mq.addEventListener('change', theme);
    buildLive(); buildTime(); buildDeb(); buildSetup();
    $('#cTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { showTab(b.dataset.tab); window.scrollTo(0, 0); } };
    $('#cCode').onclick = () => { if (!code || confirm('Pair with a different monitor code?')) showPair(); };
    const go = () => { const c = PC.cleanCode($('#pairIn').value); if (c.length === 4) connect(c); else PC.toast('Enter the 4-character code'); };
    $('#pairGo').onclick = go;
    $('#pairIn').oninput = e => { e.target.value = PC.cleanCode(e.target.value); if (e.target.value.length === 4) go(); };
    $('#pairLocal').onclick = openLocalMonitor;
    $('#pairBack').onclick = () => PC.leave();
    setInterval(() => { if (link) link.heartbeat(); renderStatus(); }, 4000);
    setInterval(renderTimers, 500);
    PC._wantWake = true; PC.wake();
    const c = PC.cleanCode(initialCode || code);
    if (c.length === 4) connect(c); else showPair();
    PC.Controller._debug = { get S() { return S; }, get log() { return log; }, get ev() { return ev; }, connect, loadStage, setRhythm, doShock, toggleCPR, computeDebrief };
  },
};

/* ---------- boot / routing ---------- */
const GATE = 'pals-disclaimer-ack-v1';
function boot() {
  $$('.ver').forEach(e => (e.textContent = PC.VERSION));
  if (!PC.store.get(GATE, null)) {          // disclaimer, acknowledged once per device
    const mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
    document.documentElement.dataset.theme = mq && mq.matches ? 'light' : 'dark';
    const g = $('#dGate'); g.classList.remove('hide');
    $('#dgChk').onchange = e => ($('#dgGo').disabled = !e.target.checked);
    $('#dgGo').onclick = () => { PC.store.set(GATE, { at: Date.now(), v: PC.VERSION }); g.classList.add('hide'); route(); };
    return;
  }
  route();
}
function route() {
  const h = location.hash;
  let m = h.match(/^#monitor(?:=([A-Za-z0-9]+))?/i);
  const role = m ? 'mon' : /^#control/i.test(h) ? 'ctl' : PC.sess.get('pals-role', null);
  if (role === 'mon') {
    const c = PC.cleanCode(m && m[1]) || PC.sess.get('pals-mon-code', '') || PC.newCode();
    PC.sess.set('pals-mon-code', c); PC.sess.set('pals-role', 'mon');
    history.replaceState(null, '', location.pathname + location.search + '#monitor=' + c);
    document.title = 'PALS Companion · Monitor ' + c;
    PC.Monitor.start(c);
  } else if (role === 'ctl') {
    const cm = h.match(/^#control=([A-Za-z0-9]+)/i);
    PC.sess.set('pals-role', 'ctl');
    history.replaceState(null, '', location.pathname + location.search + '#control');
    PC.Controller.start(cm ? cm[1] : '');
  } else {
    $('#chooser').classList.remove('hide');
    const mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
    document.documentElement.dataset.theme = mq && mq.matches ? 'light' : 'dark';
    $('#goMon').onclick = () => { $('#chooser').classList.add('hide'); location.hash = '#monitor'; route(); };
    $('#goCtl').onclick = () => { $('#chooser').classList.add('hide'); location.hash = '#control'; route(); };
    $('#goSolo').onclick = () => { $('#chooser').classList.add('hide'); location.hash = '#control'; route(); PC.Controller.openLocal(); };
    // Suggest a role: phones → Instructor, bigger screens → Monitor.
    const phone = window.matchMedia && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
    const rec = $(phone ? '#goCtl' : '#goMon'); rec.classList.add('rec'); rec.querySelector('em').classList.remove('hide');
  }
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
