// v0.2 features: disclaimer gate, landing page + legal footer, quick actions, team events,
// surprise complications, exam mode, CPR feedback panel, automated debrief (+ on the monitor), About page.
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
  // 1. fresh device: gate first, then the landing page
  const fresh = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  fresh.on('pageerror', e => errs.push(e.message));
  await fresh.goto(BASE);
  ok(await fresh.isVisible('#dGate'), 'disclaimer gate shows on first visit');
  ok(await fresh.isDisabled('#dgGo'), 'Continue disabled until the box is ticked');
  ok((await fresh.textContent('#dGate .v')).includes('v0.2.0'), 'gate shows version');
  await fresh.check('#dgChk'); await fresh.click('#dgGo');
  ok(await fresh.isVisible('#chooser') && !(await fresh.isVisible('#dGate')), 'landing page after acknowledging');
  const land = await fresh.textContent('#chooser');
  ok(/What it is/.test(land) && /How to use it/.test(land) && /Disclaimer/.test(land), 'landing explains what it is, how to use, disclaimer');
  const legal = await fresh.$eval('#chooser .legal', e => ({ t: e.textContent, align: getComputedStyle(e).textAlign }));
  ok(/Not for reuse or redistribution without written permission\. · About · Privacy/.test(legal.t) && legal.align === 'center', 'centred legal footer: ' + legal.t.replace(/\s+/g, ' '));
  ok(/v0\.2\.0/.test(legal.t), 'version in footer');
  await fresh.screenshot({ path: path.join(shots, 'v2-landing.png'), fullPage: true });
  await fresh.reload();
  ok(!(await fresh.isVisible('#dGate')), 'gate not shown again on this device');
  await fresh.goto(BASE.split('?')[0] + 'about.html');
  ok(/v0\.2\.0/.test(await fresh.textContent('main')) && /not affiliated/.test(await fresh.textContent('main')), 'About page with version and disclaimer');

  // 2. paired session
  const mk = async (vp) => { const c = await b.newContext({ viewport: vp }); await c.addInitScript(() => localStorage.setItem('pals-disclaimer-ack-v1', '1')); const p = await c.newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const mon = await mk({ width: 1280, height: 720 }), ctl = await mk({ width: 390, height: 844 });
  await mon.goto(BASE + '#monitor=VTWX'); await mon.click('#mGo');
  ok(/v0\.2\.0/.test(await mon.textContent('#mFoot')), 'monitor footer shows version');
  await ctl.goto(BASE + '#control=VTWX');
  await ctl.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  // VF scenario, run like a team would
  await ctl.click('[data-tab="tabScen"]'); await ctl.click('[data-sc="vf"]'); await ctl.click('[data-start]');
  await ctl.click('[data-tab="tabLive"]');
  await wait(3000);                                   // 3 s to start CPR
  await ctl.click('#bCPR'); await wait(2500);
  ok(await mon.isVisible('#mCpr'), 'CPR feedback panel on monitor during CPR');
  ok(/Rate/.test(await mon.textContent('#mCpr')), 'panel shows rate: ' + (await mon.textContent('#mCpr')).replace(/\s+/g, ' '));
  await ctl.click('#bCPR'); await wait(1200);         // pause for shock
  await ctl.click('#bShock'); await wait(800);
  await ctl.click('#bCPR'); await wait(1500);
  await ctl.click('[data-ev="adr"]');
  await ctl.click('[data-ev="airway"]');
  // exam mode
  await ctl.click('#bCPR'); await wait(1500);          // CPR off → VF alarm visible
  await ctl.click('[data-tab="tabSetup"]'); await ctl.click('[data-sw="exam"]'); await wait(1500);
  const ban = await mon.textContent('#mBanner');
  ok(/ALARM/.test(ban) && !/FIB/.test(ban), 'exam mode hides the rhythm name: "' + ban + '"');
  await ctl.click('[data-sw="exam"]');
  await ctl.click('[data-tab="tabLive"]'); await ctl.click('#bCPR');
  // quick ROSC, then surprise: tube dislodged
  await wait(1000); await ctl.click('[data-q="rosc"]'); await wait(8000);
  await ctl.click('summary'); await ctl.click('[data-surp="tube"]'); await wait(6000);
  let n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co === 0 || n.co < 3, 'tube dislodged → EtCO₂ ≈ 0: ' + n.co);
  if (!(n.co < 3)) console.log('     trace:', await ctl.evaluate(() => PC.Controller._debug.log.slice(-6).map(l => l.txt).join(' | ')), JSON.stringify(await mon.evaluate(() => { const d = PC.Monitor._debug; return { noVent: d.S.noVent, rr: d.S.v.rr, co2On: d.S.co2On, rh: d.S.rhythm, cpr: d.S.cpr, lastE: d.E.br.slice(-3).map(x => Math.round(x.E)), br: d.E.br.length }; })));
  ok(await ctl.isVisible('[data-fix="tube"]'), '"Tube re-sited" fix button appears');
  await ctl.click('[data-fix="tube"]'); await wait(7000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co > 20, 'after fix, CO₂ returns: ' + n.co);
  const before = (await ctl.evaluate(() => PC.Controller._debug.log.filter(l => /Surprise/.test(l.txt)).length));
  await ctl.click('#bSurp'); await wait(800);
  ok(await ctl.evaluate(() => PC.Controller._debug.log.filter(l => /Surprise/.test(l.txt)).length) === before + 1, 'random surprise applies and logs one complication');
  await ctl.screenshot({ path: path.join(shots, 'v2-live.png'), fullPage: true });
  // debrief
  await ctl.click('[data-tab="tabScen"]');
  ctl.once('dialog', d => d.accept());
  await ctl.click('[data-end]');
  await wait(500);
  ok(await ctl.isVisible('#tabDeb'), 'ending the scenario opens Debrief');
  const D = await ctl.evaluate(() => PC.Controller._debug.computeDebrief());
  const get = k => (D.m.find(x => x[0] === k) || [])[1];
  console.log('     metrics:', D.m.map(x => x[0] + '=' + x[1]).join(' | '));
  ok(/^[2-4] s$/.test(get('Time to CPR') || ''), 'time to CPR ≈ 3 s: ' + get('Time to CPR'));
  ok(!!get('First shock') && get('First shock') !== 'none', 'first shock time: ' + get('First shock'));
  ok(!!get('First adrenaline') && get('First adrenaline') !== 'not given', 'first adrenaline time: ' + get('First adrenaline'));
  ok(/%/.test(get('CPR fraction') || ''), 'CPR fraction: ' + get('CPR fraction'));
  ok(!!get('ROSC') && get('ROSC') !== 'not achieved', 'time to ROSC: ' + get('ROSC'));
  ok(D.tl.some(x => /Surprise: Tube/.test(x[1])) && D.tl.some(x => /Airway secured/.test(x[1])), 'timeline has surprise and team events');
  await ctl.screenshot({ path: path.join(shots, 'v2-debrief.png'), fullPage: true });
  await ctl.click('#bDebShow'); await wait(1500);
  ok(await mon.isVisible('#mDeb') && /Time to CPR/.test(await mon.textContent('#mDeb')), 'debrief shown on the monitor');
  await mon.screenshot({ path: path.join(shots, 'v2-monitor-debrief.png') });
  await ctl.click('#bDebHide'); await wait(1200);
  ok(!(await mon.isVisible('#mDeb')), 'debrief hidden again');
  ok(/Not for reuse/.test(await ctl.textContent('#cLegal')), 'instructor screen has the legal footer');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
