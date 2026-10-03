// v0.5: phone layout (rhythm → breathing → shock), age entry with limits + weight, automatic BP,
// EtCO₂ only when intubated, capnography scenarios, sync tick.
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
  await mon.goto(BASE + '#monitor=FVXK'); await mon.click('#mGo');
  await ctl.goto(BASE + '#control=FVXK');
  await ctl.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  const heads = await ctl.$$eval('#tabLive .card h3', h => h.map(x => x.childNodes[0].textContent.trim()));
  ok(/Rhythm/.test(heads[1]) && /Breathing/.test(heads[2]) && /Shock/.test(heads[3]), 'order: ' + heads.slice(1, 4).join(' → '));
  // age → weight + limits
  await ctl.fill('#ptAgeN', '9'); await ctl.click('#ptAgeU [data-v="mo"]'); await wait(200);
  ok((await ctl.inputValue('#ptWt')) === '8.5', 'weight estimated for 9 months: ' + await ctl.inputValue('#ptWt'));
  await ctl.click('#bPtSet'); await wait(1500);
  ok(/HR 90–180, RR 25–55, SBP &lt; 70|HR 90–180, RR 25–55, SBP < 70/.test(await ctl.innerHTML('#ptLim')), 'infant limits shown: ' + await ctl.textContent('#ptLim'));
  const lim = await mon.textContent('#limHR');
  ok(/180/.test(lim) && /90/.test(lim), 'monitor uses infant HR limits: ' + lim.replace(/\s/g, ' '));
  // rhythm applies instantly + sync tick + auto BP
  await ctl.click('#rhChips [data-rh="vt"]'); await wait(1500);
  ok(await mon.evaluate(() => PC.Monitor._debug.S.rhythm) === 'vt', 'VT on the monitor');
  ok(/Monitor online ✓/.test(await ctl.textContent('#cStat')), 'phone shows the ✓ sync tick: ' + await ctl.textContent('#cStat'));
  const bp = await ctl.evaluate(() => PC.Controller._debug.S.v);
  ok(bp.sbp === 64 && bp.dbp === 38, `auto BP for VT in an infant (85/50 × 0.75): ${bp.sbp}/${bp.dbp}`);
  await ctl.click('#rhChips [data-rh="vf"]'); await wait(800);
  ok((await ctl.evaluate(() => PC.Controller._debug.S.v.sbp)) === 0, 'VF → BP 0');
  await ctl.click('#rhChips [data-rh="sinus"]'); await wait(800);
  ok((await ctl.evaluate(() => PC.Controller._debug.S.v.sbp)) === 85, 'sinus → normal infant BP 85');
  // EtCO2 only when intubated
  await wait(4000);
  let n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co == null && /not intubated/i.test(await mon.textContent('#tCO')), 'no EtCO₂ before intubation');
  ok(await ctl.isVisible('#capnoOff') && !(await ctl.isVisible('#capnoBox')), 'capnography scenarios hidden until intubated');
  await ctl.click('#segIntub [data-v="1"]'); await wait(5000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co > 25, 'EtCO₂ appears after intubation: ' + n.co);
  // capnography: rebreathing raises the baseline
  await ctl.click('[data-capno="rebreath"]'); await wait(6000);
  const shape = await mon.evaluate(() => PC.Monitor._debug.S.co2Shape);
  ok(shape === 'rebreath', 'rebreathing capnogram selected');
  await ctl.click('[data-capno="hyper"]'); await wait(16000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co < 32 && n.aw > 60, `hyperventilation: EtCO₂ ${n.co}, RR ${n.aw}`);
  await ctl.click('[data-capno="dislodged"]'); await wait(6000);
  n = await mon.evaluate(() => PC.Monitor._debug.numbers());
  ok(n.co < 3, 'tube dislodged → flat capnogram: ' + n.co);
  await mon.screenshot({ path: path.join(shots, 'v5-monitor.png') });
  await ctl.screenshot({ path: path.join(shots, 'v5-live.png'), fullPage: true });
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
