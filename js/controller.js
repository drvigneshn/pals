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
let T = Object.assign({ scRun: false, scStart: 0, scAcc: 0, cycleStart: 0, adrAt: 0, shocks: 0, adr: 0 }, saved.T);
let sc = Object.assign({ id: null, stage: -1, ticks: {}, visited: [], ended: false }, saved.sc);
let code = saved.code || '';
let tab = saved.tab || 'tabLive';
let link = null, monSeenAt = 0, otherCtl = false, linkStat = { relays: 0, of: 0, local: false };
let scList = !sc.id;

const save = () => PC.store.set(KEY, { S, ramp, energyKey, log, T, sc, code, tab });
const wt = () => Number(S.pt.wt) || 10;
const scen = () => PC.SCENARIOS.find(s => s.id === sc.id);

function send() {
  S.t = Math.max(Date.now(), (S.t || 0) + 1);
  otherCtl = false;
  if (link) link.sendState(S);
  save(); renderLive(); renderSetup(false);
}
function addLog(txt) {
  log.push({ at: Date.now(), txt });
  if (log.length > 600) log = log.slice(-600);
  save(); renderLog();
}
const scElapsed = (now = Date.now()) => T.scAcc + (T.scRun ? now - T.scStart : 0);
const logRel = at => {
  const base = T.scStart ? T.scStart - T.scAcc : (log[0] ? log[0].at : at);
  return PC.mmss(at - base);
};

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
  const bpChanged = changed.some(x => x.k === 'sbp' || x.k === 'dbp');
  S.v = { ...staged }; S.vt = Date.now(); S.ramp = ramp;
  if (changed.length) addLog('Vitals → ' + changed.map(x => `${x.l} ${fmtV(x.k, staged[x.k])}`).join(', ') + (ramp ? ' over ' + RAMPS.find(r => r[0] === ramp)[1] : ''));
  send();
  // The monitor's BP only changes when the cuff cycles, so start a measurement timed to finish
  // as the new BP is reached (a cycle takes ~17 s).
  if (bpChanged && S.cuff) {
    clearTimeout(nibpTimer);
    nibpTimer = setTimeout(() => { S.nibpAt = Date.now(); addLog('NIBP measurement (BP changed)'); send(); }, Math.max(0, ramp - 15000));
  }
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
  addLog('Rhythm → ' + PC.rhythmName(S));
  send();
}
function toggleCPR() {
  S.cpr = !S.cpr;
  if (S.cpr) T.cycleStart = Date.now();
  addLog(S.cpr ? 'CPR started' : 'CPR stopped');
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
  addLog(`⚡ ${S.sync ? 'Synchronised cardioversion' : 'Shock'} ${J} J (${e.label}) #${T.shocks}`);
  send();
  const b = $('#bShock'); if (b) { b.disabled = true; setTimeout(() => (b.disabled = false), 1500); }
}
function rosc() {
  const n = (PC.AGE[S.pt.group] || PC.AGE.child).norm;
  S.rhythm = 'sinus'; S.pulse = true; S.cpr = false;
  S.v = Object.assign({}, S.v, { hr: Math.round(n.hr * 1.2), spo2: 94, rr: S.v.rr || n.rr, etco2: 44, sbp: Math.round(n.sbp * 0.85), dbp: Math.round(n.dbp * 0.85) });
  staged = { ...S.v }; S.vt = Date.now(); S.ramp = 20000;
  addLog('ROSC');
  send();
}

/* ---------- scenario actions ---------- */
function startScenario(at = 0) {
  const s = scen(); if (!s) return;
  if (log.length && !confirm('Start this scenario? The current timeline log will be cleared.')) return;
  log = []; T = { scRun: true, scStart: Date.now(), scAcc: 0, cycleStart: 0, adrAt: 0, shocks: 0, adr: 0 };
  sc.stage = -1; sc.ticks = {}; sc.visited = []; sc.ended = false;
  const keep = { monTheme: S.monTheme, beep: S.beep, alarms: S.alarms, nibpAt: S.nibpAt, shockAt: S.shockAt, silenceAt: S.silenceAt };
  S = Object.assign(PC.defaultState(), keep, { pt: Object.assign({}, s.pt) });
  addLog('Scenario started: ' + s.title);
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
  addLog(`Stage ${i + 1}: ${st.name}`);
  send(); renderScen();
}
function endScenario() {
  if (T.scRun) { T.scAcc = scElapsed(); T.scRun = false; }
  sc.ended = true;
  const sco = score();
  addLog(`Scenario ended · checklist ${sco.done}/${sco.total}`);
  save(); renderScen(); showTab('tabTime');
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
  <div class="card"><h3>Arrest</h3>
    <div class="rowf"><button class="btn big grow" id="bCPR"></button>${segHTML('segQ', [['good', 'Good CPR'], ['poor', 'Poor CPR']], S.cprQ)}</div>
    <div class="note" id="cycleNote" style="margin:6px 0 10px"></div>
    <div class="rowf" style="margin-bottom:8px"><span>Sync</span><button class="sw" id="swSync" aria-label="Synchronised mode"></button><span class="note grow" id="enNote"></span></div>
    <div class="chips" id="enChips"></div>
    <button class="btn red big" id="bShock" style="width:100%;margin-top:10px"></button>
    <div class="rowf" style="margin-top:10px"><button class="btn grow" id="bROSC">ROSC</button><button class="btn grow" id="bNIBP">NIBP now</button><button class="btn grow" id="bSil">Silence 2 min</button></div>
  </div>
  <div class="card"><h3>Rhythm <span class="note">applies instantly</span></h3><div class="chips" id="rhChips">${
    PC.RHYTHMS.map(r => `<button class="chip${r.arrest ? ' red' : ''}" data-rh="${r.key}">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</button>`).join('')}</div></div>
  <div class="card"><h3>Vitals <span class="note">staged until Apply</span></h3>
    ${VIT.map(x => `<div class="vit" data-k="${x.k}"><label>${x.l}</label><button data-d="-1" aria-label="${x.l} down">−</button><input inputmode="decimal" id="in_${x.k}"><button data-d="1" aria-label="${x.l} up">+</button><span class="cur" id="cur_${x.k}"></span></div>`).join('')}
    <div style="margin:10px 0 6px" class="note">Drift over</div>
    ${segHTML('segRamp', RAMPS, ramp)}
    <div class="rowf" style="margin-top:10px"><button class="btn pri big grow" id="bApply">Apply vitals</button><button class="btn" id="bRevert">Revert</button></div>
    <div class="rowf" style="margin-top:10px"><span class="note">Stage preset:</span><button class="btn" data-pre="norm">Normal for age</button><button class="btn" data-pre="hypox">Hypoxia</button><button class="btn" data-pre="shock">Hypotension</button></div>
  </div>`;
  $('#bCPR').onclick = toggleCPR;
  $('#segQ').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.cprQ = b.dataset.v; addLog('CPR quality: ' + S.cprQ); send(); };
  $('#swSync').onclick = () => { S.sync = !S.sync; addLog('Sync ' + (S.sync ? 'ON' : 'OFF')); send(); };
  $('#enChips').onclick = e => { const b = e.target.closest('[data-en]'); if (!b) return; energyKey = b.dataset.en; save(); renderLive(); };
  $('#bShock').onclick = doShock;
  $('#bROSC').onclick = rosc;
  $('#bNIBP').onclick = () => { S.nibpAt = Date.now(); addLog('NIBP measurement'); send(); };
  $('#bSil').onclick = () => { S.silenceAt = Date.now(); send(); PC.toast('Alarms silenced for 2 min'); };
  $('#rhChips').onclick = e => { const b = e.target.closest('[data-rh]'); if (b) setRhythm(b.dataset.rh); };
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
  b.textContent = S.cpr ? '■ Stop CPR' : '▶ Start CPR'; b.className = 'btn big grow ' + (S.cpr ? 'red' : 'pri');
  $$('#segQ button').forEach(x => x.classList.toggle('on', x.dataset.v === S.cprQ));
  $('#swSync').classList.toggle('on', S.sync);
  const e = energy();
  $('#enChips').innerHTML = PC.ENERGIES.filter(x => x.kind === (S.sync ? 'sync' : 'defib'))
    .map(x => `<button class="chip${x.key === e.key ? ' on' : ''}" data-en="${x.key}">${PC.joules(x.per, wt())} J<small>${esc(x.label)} · ${esc(x.note)}</small></button>`).join('');
  $('#enNote').textContent = S.sync ? 'Markers show on each R wave' : '';
  $('#bShock').textContent = `⚡ ${S.sync ? 'Cardiovert' : 'Shock'} ${PC.joules(e.per, wt())} J`;
  $$('#rhChips .chip').forEach(c => c.classList.toggle('on', c.dataset.rh === PC.rhythmKey(S)));
  $$('#segRamp button').forEach(x => x.classList.toggle('on', Number(x.dataset.v) === ramp));
  const flags = [!S.leads && 'leads off', !S.probe && 'probe off', !S.co2On && 'CO₂ off', S.sync && 'SYNC', S.frozen && 'FROZEN', !S.alarms && 'alarms off'].filter(Boolean);
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
    if (c.checked) addLog('✓ ' + PC.fillDoses(s.stages[i].expect[j], w)); else save();
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
  $('#bCheck').onclick = () => { T.cycleStart = Date.now(); addLog('Rhythm/pulse check'); renderTimers(); };
  $('#doseGrid').onclick = e => {
    const b = e.target.closest('[data-dose]'); if (!b) return;
    const d = PC.DOSES.find(x => x.key === b.dataset.dose);
    if (d.key === 'adr') { T.adrAt = Date.now(); T.adr++; }
    addLog(`💉 ${d.name} ${d.calc(wt())}`); PC.toast(d.name + ' logged'); renderTimers();
  };
  $('#bNote').onclick = () => { const v = $('#noteIn').value.trim(); if (v) { addLog('📝 ' + v); $('#noteIn').value = ''; } };
  $('#noteIn').onkeydown = e => { if (e.key === 'Enter') $('#bNote').click(); };
  $('#bCopy').onclick = copyLog;
  $('#bClear').onclick = () => { if (confirm('Clear the log and timers?')) { log = []; T = { scRun: false, scStart: 0, scAcc: 0, cycleStart: 0, adrAt: 0, shocks: 0, adr: 0 }; save(); renderLog(); renderTimers(); } };
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
  if (cn) cn.innerHTML = S.cpr ? `2-min cycle: <b style="color:${cy < 0 ? 'var(--danger)' : cy < 15000 ? 'var(--warn)' : 'var(--txt)'}">${cyTxt}</b>${cy < 0 ? ' · rhythm check due' : ''}` + (T.adrAt ? ` · adrenaline ${PC.mmss(now - T.adrAt)} ago` : '') : (T.shocks ? `${T.shocks} shock(s) given` : 'CPR off');
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
  log.forEach(l => lines.push(`[${logRel(l.at)}] ${l.txt}`));
  if (s && sc.visited.length) {
    const sco = score(); lines.push('', `Checklist ${sco.done}/${sco.total}`);
    sc.visited.forEach(i => (s.stages[i].expect || []).forEach((x, j) => lines.push(`${sc.ticks[i + ':' + j] ? '✓' : '✗'} ${PC.fillDoses(x, s.pt.wt)}`)));
  }
  const txt = lines.join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => PC.toast('Log copied'), () => { prompt('Copy the log:', txt); });
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
    ${[['alarms', 'Alarms'], ['beep', 'Pulse beep'], ['frozen', 'Freeze screen (debrief)']].map(([k, l]) => `<div class="tog"><span>${l}</span><button class="sw" data-sw="${k}"></button></div>`).join('')}
    <div class="tog"><span>Monitor theme</span>${segHTML('segTheme', [['dark', 'Dark'], ['light', 'Light']], S.monTheme)}</div></div>
  <div class="card"><h3>Result card on the monitor</h3>
    <label class="fld">Template<select id="rvTpl"><option value="">Choose…</option>${Object.entries(TEMPLATES).map(([k, v]) => `<option value="${k}">${esc(v[0])}</option>`).join('')}</select></label>
    <label class="fld" style="margin-top:8px">Title<input id="rvTitle" value="${esc(S.reveal.title)}"></label>
    <label class="fld" style="margin-top:8px">Text<textarea id="rvText" rows="4">${esc(S.reveal.text)}</textarea></label>
    <div class="rowf" style="margin-top:10px"><button class="btn pri grow" id="bRvShow">Show on monitor</button><button class="btn grow" id="bRvHide">Hide</button></div></div>
  <div class="card"><h3>About</h3>
    <p style="margin:0 0 8px">PALS Companion ${esc(PC.VERSION)} · created by Dr Vignesh N</p>
    <p class="note" style="margin:0 0 10px">For training only. Not a medical device. The link uses public relays, so only simulated values are sent. Verify doses and energies against current AHA PALS / IAP guidance.</p>
    <div class="rowf"><a class="btn" href="privacy.html" style="text-decoration:none">Privacy</a><button class="btn" id="bRole">Switch to monitor mode</button><button class="btn" id="bReset">Reset everything</button></div></div>`;
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
      const names = { leads: 'ECG leads', probe: 'SpO₂ probe', co2On: 'CO₂ line', cuff: 'BP cuff', alarms: 'Alarms', beep: 'Pulse beep', frozen: 'Freeze' };
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
  $('#bRole').onclick = () => { PC.sess.set('pals-role', 'mon'); location.hash = '#monitor'; location.reload(); };
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
  if (id === 'tabLive') renderLive();
}
function openLocalMonitor() {
  if (!code) connect(PC.newCode());
  const w = window.open(location.pathname + '#monitor=' + code, 'pals-monitor-' + code, 'popup,width=1280,height=760');
  if (!w) PC.toast('Allow pop-ups to open the monitor window');
}

PC.Controller = {
  start(initialCode) {
    $('#ctl').classList.remove('hide');
    document.title = 'PALS Companion · Instructor';
    const mq = window.matchMedia && matchMedia('(prefers-color-scheme: light)');
    const theme = () => (document.documentElement.dataset.theme = mq && mq.matches ? 'light' : 'dark');
    theme(); mq && mq.addEventListener && mq.addEventListener('change', theme);
    buildLive(); buildTime(); buildSetup();
    $('#cTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { showTab(b.dataset.tab); window.scrollTo(0, 0); } };
    $('#cCode').onclick = () => { if (!code || confirm('Pair with a different monitor code?')) showPair(); };
    const go = () => { const c = PC.cleanCode($('#pairIn').value); if (c.length === 4) connect(c); else PC.toast('Enter the 4-character code'); };
    $('#pairGo').onclick = go;
    $('#pairIn').oninput = e => { e.target.value = PC.cleanCode(e.target.value); if (e.target.value.length === 4) go(); };
    $('#pairLocal').onclick = openLocalMonitor;
    setInterval(() => { if (link) link.heartbeat(); renderStatus(); }, 4000);
    setInterval(renderTimers, 500);
    PC._wantWake = true; PC.wake();
    const c = PC.cleanCode(initialCode || code);
    if (c.length === 4) connect(c); else showPair();
    PC.Controller._debug = { get S() { return S; }, get log() { return log; }, connect, loadStage, setRhythm, doShock, toggleCPR };
  },
};

/* ---------- boot / routing ---------- */
function boot() {
  $$('.ver').forEach(e => (e.textContent = PC.VERSION));
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
    $('#goMon').onclick = () => { $('#chooser').classList.add('hide'); location.hash = '#monitor'; boot(); };
    $('#goCtl').onclick = () => { $('#chooser').classList.add('hide'); location.hash = '#control'; boot(); };
  }
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
