// Single-device mode: controller opens the monitor as a pop-up window; they pair over
// BroadcastChannel with the relays switched off (?mqtt=off). Also takes light/portrait screenshots.
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/?mqtt=off';
const shots = path.join(__dirname, 'shots');
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 800, height: 1280 } });
  const errs = [];
  ctx.on('page', p => p.on('pageerror', e => errs.push(e.message)));
  const ctl = await ctx.newPage(); ctl.on('pageerror', e => errs.push(e.message));
  await ctl.goto(BASE + '#control');
  const [mon] = await Promise.all([ctx.waitForEvent('page'), ctl.click('#pairLocal')]);
  await mon.waitForLoadState();
  await mon.setViewportSize({ width: 800, height: 1280 });
  await mon.click('#mGo');
  await ctl.waitForFunction(() => document.querySelector('#cStat').textContent.includes('Monitor online'), null, { timeout: 10000 });
  ok(true, 'pop-up monitor paired over BroadcastChannel (no relay)');
  const code = await ctl.textContent('#cCode');
  ok(/^[A-Z2-9]{4}$/.test(code) && (await mon.textContent('#mCode')) === code, 'same code on both: ' + code);
  // scenario: asthma → shark-fin capnogram, light theme, NIBP measurement
  await ctl.click('[data-tab="tabScen"]'); await ctl.click('[data-sc="asthma"]'); await ctl.click('[data-start]');
  await ctl.click('[data-tab="tabSetup"]'); await ctl.click('#segTheme [data-v="light"]');
  await ctl.click('[data-tab="tabLive"]'); await ctl.click('#bNIBP');
  await wait(3000);
  ok(await mon.evaluate(() => PC.Monitor._debug.N.state === 'meas'), 'NIBP measuring');
  await wait(16000);
  const N = await mon.evaluate(() => PC.Monitor._debug.N);
  ok(N.sys > 100 && N.sys < 125, `NIBP result ${N.sys}/${N.dia} (set 112/70)`);
  const al = await mon.evaluate(() => PC.Monitor._debug.alarms.map(a => a.p + ':' + a.msg));
  ok(al.some(a => /SpO₂ LOW/.test(a)), 'SpO2 88 alarms: ' + al.join(' | '));
  await mon.screenshot({ path: path.join(shots, '9-asthma-light-portrait.png') });
  // shot of a 3rd-degree block in dark theme on a landscape laptop
  await ctl.click('[data-tab="tabSetup"]'); await ctl.click('#segTheme [data-v="dark"]');
  await ctl.click('[data-tab="tabLive"]'); await ctl.click('[data-rh="avb3"]');
  await mon.setViewportSize({ width: 1280, height: 720 });
  await wait(7000);
  await mon.screenshot({ path: path.join(shots, '10-avb3.png') });
  await ctl.click('[data-rh="tdp"]'); await wait(5500);
  await mon.screenshot({ path: path.join(shots, '11-torsades.png') });
  // reload the monitor: it must not replay the old shock
  await ctl.click('[data-rh="vf"]'); await ctl.click('#bShock'); await wait(500);
  await mon.reload(); await mon.click('#mGo'); await wait(2500);
  ok(await mon.evaluate(() => PC.Monitor._debug.E.shockT < 0), 'reloaded monitor does not replay the old shock');
  ok(await mon.evaluate(() => PC.Monitor._debug.S.rhythm === 'vf'), 'reloaded monitor gets current rhythm again');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
