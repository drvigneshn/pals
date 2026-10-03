// Pairs two isolated browsers through the local relay (node servers.js must be running),
// drives the controller and checks what the monitor shows. Screenshots go to test/shots/.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/?mqtt=ws://127.0.0.1:8888';
const shots = path.join(__dirname, 'shots'); fs.mkdirSync(shots, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const monCtx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const ctlCtx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await monCtx.addInitScript(() => { try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {} });
  await ctlCtx.addInitScript(() => { try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {} });
  const mon = await monCtx.newPage(), ctl = await ctlCtx.newPage();
  for (const [n, p] of [['mon', mon], ['ctl', ctl]]) {
    p.on('pageerror', e => errs.push(n + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(n + ' console: ' + m.text()); });
  }
  await mon.goto(BASE + '#monitor=TEST');
  ok((await mon.textContent('#mCode')) === 'TEST', 'monitor shows pair code');
  ok(await mon.$eval('#qrBox', e => e.innerHTML.includes('<svg')), 'monitor shows QR');
  await mon.click('#mGo');
  await ctl.goto(BASE + '#control=TEST');
  await ctl.waitForFunction(() => document.querySelector('#cStat').textContent.includes('Monitor online'), null, { timeout: 15000 });
  ok(true, 'controller sees monitor online via relay');
  await wait(2500);
  const n0 = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n0.hr > 95 && n0.hr < 125, 'sinus HR ≈110 on monitor: ' + n0.hr);
  ok(n0.sp >= 96, 'SpO2 shown: ' + n0.sp);
  await mon.screenshot({ path: path.join(shots, '1-sinus.png') });

  // rhythm → VF via the real chip
  await ctl.click('[data-rh="vf"]');
  await wait(2500);
  let al = await mon.evaluate(() => PC.Monitor._debug.alarms.map(a => a.msg));
  ok(al.includes('V-FIB'), 'VF alarm on monitor: ' + al.join(' | '));
  await mon.screenshot({ path: path.join(shots, '2-vf.png') });

  // intubate (EtCO2 only shows once intubated), then CPR on → HR shows compression rate, EtCO2 drifts to ~18
  await ctl.click('#segIntub [data-v="1"]');
  await ctl.click('#bCPR');
  await wait(9000);
  let n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.hr >= 100 && n.hr <= 120, 'HR counts compressions during CPR: ' + n.hr);
  ok(n.co >= 12 && n.co <= 24, 'EtCO2 during good CPR ≈18: ' + n.co);
  await mon.screenshot({ path: path.join(shots, '3-cpr.png') });

  // shock
  await ctl.click('#bShock');
  await wait(600);
  const shockT = await mon.evaluate(() => performance.now() - PC.Monitor._debug.E.shockT);
  ok(shockT > 0 && shockT < 3000, 'shock artefact fired on monitor');
  const logTxt = await ctl.evaluate(() => PC.Controller._debug.log.map(l => l.txt).join('\n'));
  ok(/Shock 36 J/.test(logTxt), 'shock logged at 2 J/kg for 18 kg (36 J)');

  // ROSC → EtCO2 surge, pleth back
  await ctl.click('#bROSC');
  await wait(12000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co >= 35, 'EtCO2 rises after ROSC: ' + n.co);
  ok(n.sp != null, 'SpO2 back after ROSC: ' + n.sp);
  await mon.screenshot({ path: path.join(shots, '4-rosc.png') });

  // vitals ramp: stage HR 60 and apply "Now"
  await ctl.click('#segRamp [data-v="0"]');
  await ctl.fill('#in_hr', '60'); await ctl.dispatchEvent('#in_hr', 'change');
  await ctl.click('#bApply');
  await wait(6000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.hr >= 52 && n.hr <= 68, 'HR follows applied vitals: ' + n.hr);

  // scenario: SVT infant
  await ctl.click('[data-tab="tabScen"]');
  await ctl.click('[data-sc="svt"]');
  ctl.once('dialog', d => d.accept());
  await ctl.click('[data-start]');
  await wait(4000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.hr > 250, 'SVT scenario stage 1 HR ≈280: ' + n.hr);
  const cue = await ctl.textContent('#tabScen .cues');
  ok(/0\.55 mg/.test(cue), 'adenosine 0.1 mg/kg filled for 5.5 kg (0.55 mg)');
  await ctl.screenshot({ path: path.join(shots, '5-ctl-scenario.png'), fullPage: true });
  await mon.screenshot({ path: path.join(shots, '6-svt.png') });

  // sensors: leads off
  await ctl.click('[data-tab="tabSetup"]');
  await ctl.click('[data-sw="leads"]');
  await wait(1500);
  al = await mon.evaluate(() => PC.Monitor._debug.alarms.map(a => a.msg));
  ok(al.includes('ECG LEADS OFF'), 'leads-off technical alarm');
  await ctl.click('[data-sw="leads"]');

  await ctl.click('[data-tab="tabLive"]');
  await ctl.screenshot({ path: path.join(shots, '7-ctl-live.png'), fullPage: true });
  await ctl.click('[data-tab="tabTime"]');
  await ctl.screenshot({ path: path.join(shots, '8-ctl-timeline.png'), fullPage: true });

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
