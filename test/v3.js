// v0.3: credits on the start screen, role chooser (suggestion, one-device), monitor Exit / Back,
// BP follows stages / ROSC / arrest, breathing quick actions, step-by-step arrest panel.
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
  const mk = async (vp, mobile) => { const c = await b.newContext({ viewport: vp, isMobile: !!mobile, hasTouch: !!mobile }); await c.addInitScript(() => { try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {} }); c.on('page', p => p.on('pageerror', e => errs.push(e.message))); const p = await c.newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };

  // start screen
  const ph = await mk({ width: 390, height: 844 }, true);
  await ph.goto(BASE);
  const top = await ph.textContent('.brand');
  ok(/Created by Dr Vignesh N/.test(top), 'created-by at the top');
  ok(/Dr Janani Sankar, Medical Director, KKCTH/.test(top) && /Dr Radhika Raman, Senior Consultant, KKCTH/.test(top), 'mentors at the top');
  ok(/Which device is this\?/.test(await ph.textContent('.pick')), 'one clear question');
  ok(await ph.isVisible('#goCtl em') && !(await ph.isVisible('#goMon em')), 'phone: Instructor suggested');
  await ph.screenshot({ path: path.join(shots, 'v3-start-phone.png') });
  const lap = await mk({ width: 1280, height: 800 });
  await lap.goto(BASE);
  ok(await lap.isVisible('#goMon em'), 'laptop: Monitor suggested');
  await lap.screenshot({ path: path.join(shots, 'v3-start-laptop.png') });
  // monitor: Back on the start overlay, Exit from the running monitor
  await lap.click('#goMon');
  ok(await lap.isVisible('#mBack'), 'start overlay has a Back button');
  await lap.click('#mBack'); await lap.waitForLoadState();
  ok(await lap.isVisible('#chooser'), 'Back returns to the start screen');
  await lap.click('#goMon'); await lap.click('#mGo');
  ok(await lap.isVisible('#mExit'), 'running monitor shows ✕ Exit');
  lap.once('dialog', d => d.accept()); await lap.click('#mExit'); await lap.waitForLoadState(); await wait(500);
  ok(await lap.isVisible('#chooser') && !(await lap.isVisible('#mon')), 'Exit closes the monitor');
  // one device: opens the instructor and a monitor window
  const [pop] = await Promise.all([lap.context().waitForEvent('page'), lap.click('#goSolo')]);
  await pop.waitForLoadState();
  ok(/#monitor=/.test(pop.url()) && await lap.isVisible('#ctl'), 'one-device button opens instructor + monitor window');
  await pop.close();

  // BP follows scenario stages, ROSC and arrest
  const mon = await mk({ width: 1280, height: 720 }), ctl = await mk({ width: 390, height: 844 }, true);
  await mon.goto(BASE + '#monitor=BPBX'); await mon.click('#mGo');
  await ctl.goto(BASE + '#control=BPBX');
  await ctl.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await wait(1500);
  ok(/\d+\/\d+/.test(await mon.textContent('#vNB')), 'BP shown straight away: ' + await mon.textContent('#vNB'));
  await ctl.click('[data-tab="tabScen"]'); await ctl.click('[data-sc="sepsis"]'); await ctl.click('[data-start]');
  await wait(19000);
  ok(/^8[0-9]\//.test(await mon.textContent('#vNB')), 'stage 1 BP (86/44) measured: ' + await mon.textContent('#vNB'));
  await ctl.click('[data-tab="tabLive"]'); await ctl.click('[data-q="vf"]');
  await wait(19000);
  ok((await mon.textContent('#vNB')) === '---/---', 'arrest: BP reading fails, old value cleared: ' + await mon.textContent('#vNB'));
  await ctl.click('#bROSC'); await wait(24000);
  ok(/^\d{2,3}\/\d{2,3}$/.test(await mon.textContent('#vNB')), 'ROSC: new BP measured: ' + await mon.textContent('#vNB'));

  // arrest panel wording + breathing
  ok(/Start compressions/.test(await ctl.textContent('#bCPR')), 'CPR button says "Start compressions"');
  await ctl.click('#bCPR');
  ok(/Pause compressions/.test(await ctl.textContent('#bCPR')), 'running CPR offers "Pause compressions"');
  await ctl.click('#bCPR');
  await ctl.click('#segMode [data-v="sync"]'); await wait(1200);
  ok(/Cardiovert/.test(await ctl.textContent('#bShock')) && await mon.evaluate(() => PC.Monitor._debug.S.sync), 'Sync cardioversion mode');
  await ctl.click('#segMode [data-v="defib"]');
  await ctl.click('[data-resp="bronch"]'); await wait(1500);
  ok(await mon.evaluate(() => PC.Monitor._debug.S.co2Shape === 'obstructive'), 'Bronchospasm → shark-fin capnogram');
  await ctl.click('[data-resp="apnoea"]'); await wait(1500);
  ok(await mon.evaluate(() => PC.Monitor._debug.S.v.rr === 0), 'Apnoea → RR 0');
  await ctl.click('[data-resp="bag"]'); await wait(8000);
  const n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.aw > 10 && n.co > 0, 'Effective BVM → breathing and CO₂ back: RR ' + n.aw + ', EtCO₂ ' + n.co);
  await ctl.screenshot({ path: path.join(shots, 'v3-live.png'), fullPage: true });
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
