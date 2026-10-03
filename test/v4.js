// v0.4: IAP ALS core cases — setting selector, findings, Identify/Intervene ticks, result card, debrief split.
// Needs `node servers.js` running.
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/?mqtt=ws://127.0.0.1:8888';
const shots = path.join(__dirname, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (vp) => { const c = await b.newContext({ viewport: vp }); await c.addInitScript(() => { try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {} }); const p = await c.newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const mon = await mk({ width: 1280, height: 720 }), ctl = await mk({ width: 390, height: 844 });
  await mon.goto(BASE + '#monitor=CRCX'); await mon.click('#mGo');
  await ctl.goto(BASE + '#control=CRCX');
  await ctl.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await ctl.click('[data-tab="tabScen"]');
  const list = await ctl.textContent('#tabScen');
  ok(/IAP ALS core cases/.test(list) && /Core case 1: Upper airway obstruction/.test(list) && /Core case 12: VF \/ VT/.test(list), 'core-case group listed first');
  ok((await ctl.$$eval('[data-sc^="ia"]', e => e.length)) === 11, '11 core cases present');
  // Case 9 SVT, ward setting
  await ctl.click('[data-sc="ia9"]');
  await ctl.click('#segSet [data-set="1"]');
  ok(/admitted in the ward/.test(await ctl.textContent('.stem')), 'stem changes with the setting (Ward)');
  await ctl.click('[data-start]'); await wait(2500);
  const m = await mon.evaluate(() => ({ r: PC.Monitor._debug.S.rhythm, bed: PC.Monitor._debug.S.pt.bed, hr: PC.Monitor._debug.numbers().hr }));
  ok(m.r === 'svt' && m.bed === 'Ward' && m.hr > 270, `monitor: SVT ${m.hr}, bed ${m.bed}`);
  await ctl.click('[data-go="1"]'); await wait(800);
  const card = await ctl.textContent('#tabScen');
  ok(/HR 292, narrow QRS/.test(card) && /Identify: did the team name it\?/.test(card), 'primary assessment shows findings + Identify');
  ok(/1\.6 mg/.test(card), 'adenosine 0.1 mg/kg for 16 kg = 1.6 mg filled in');
  await ctl.check('[data-tick="1:i1"]'); await ctl.check('[data-tick="1:1"]');
  await ctl.screenshot({ path: path.join(shots, 'v4-core-case.png'), fullPage: true });
  ctl.once('dialog', d => d.accept()); await ctl.click('[data-end]'); await wait(500);
  const D = await ctl.evaluate(() => PC.Controller._debug.computeDebrief());
  const g = k => (D.m.find(x => x[0] === k) || [])[1];
  ok(g('Identify') === '1 / 3' && g('Intervene') === '1 / 8', `debrief splits Identify ${g('Identify')} / Intervene ${g('Intervene')}`);
  // Case 3: result card to the monitor
  await ctl.click('[data-tab="tabScen"]'); await ctl.click('[data-back]'); await ctl.click('[data-sc="ia3"]');
  ctl.once('dialog', d => d.accept()); await ctl.click('[data-start]'); await wait(500);
  await ctl.click('[data-go="3"]'); await wait(500);
  await ctl.click('[data-result]'); await wait(1500);
  ok(/hypoxaemia with raised PaCO₂/.test(await mon.textContent('#mReveal')), 'case 3 ABG / X-ray result shown on the monitor');
  // Case 12: pulseless VT then VF
  await ctl.click('[data-back]'); await ctl.click('[data-sc="ia12"]');
  ctl.once('dialog', d => d.accept()); await ctl.click('[data-start]'); await wait(1500);
  let s = await mon.evaluate(() => PC.Monitor._debug.S);
  ok(s.rhythm === 'vt' && !s.pulse, 'case 12 starts in pulseless VT');
  await ctl.click('[data-go="2"]'); await wait(1500);
  s = await mon.evaluate(() => PC.Monitor._debug.S);
  ok(s.rhythm === 'vf', 'case 12 rhythm check → VF');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
