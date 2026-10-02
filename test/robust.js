// Regression checks for "changes on the phone don't reach the monitor":
//  1. instructor devices with different clocks (one 10 min ahead, then a normal phone takes over)
//  2. phone comes back from sleep / app switch → relays reconnect and changes still arrive
//  3. two instructor screens open at once don't fight; the one that acts last controls the monitor
// Needs `node servers.js` running.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/?mqtt=ws://127.0.0.1:8888';
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const rhythm = p => p.evaluate(() => PC.Monitor._debug.S.rhythm + (PC.Monitor._debug.S.pulse ? '' : '-nopulse'));

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const page = async (opts = {}, skewMs = 0) => {
    const ctx = await b.newContext(opts);
    await ctx.addInitScript(() => { try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {} });
    if (skewMs) await ctx.addInitScript(s => { const n = Date.now; Date.now = () => n() + s; }, skewMs);
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); return p;
  };
  const mon = await page({ viewport: { width: 1280, height: 720 } });
  await mon.goto(BASE + '#monitor=SKEW'); await mon.click('#mGo');

  // 1. clock skew
  const fast = await page({ viewport: { width: 390, height: 844 } }, 10 * 60 * 1000);
  await fast.goto(BASE + '#control=SKEW');
  await fast.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await fast.click('[data-rh="vf"]'); await wait(1500);
  ok(await rhythm(mon) === 'vf-nopulse', 'fast-clock instructor sets VF');
  await fast.context().close();
  const phone = await page({ viewport: { width: 390, height: 844 } });
  await phone.goto(BASE + '#control=SKEW');
  await phone.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await phone.click('[data-rh="sinus"]'); await wait(1500);
  ok(await rhythm(mon) === 'sinus', 'normal-clock phone takes over immediately (was ignored for 10 min before the fix)');
  await phone.click('[data-rh="svt"]'); await wait(1500);
  ok(await rhythm(mon) === 'svt', 'and every following change applies');

  // 2. sleep / app switch: page hidden > 2 s, then visible → relays reconnect, changes still arrive
  const setVis = v => phone.evaluate(v => { Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, v);
  await setVis('hidden'); await wait(2500); await setVis('visible');
  await phone.click('[data-rh="avb3"]');                 // tapped while relays are re-opening
  await wait(4000);
  ok(await rhythm(mon) === 'avb3', 'change made right after waking reaches the monitor');

  // 3. two instructor screens: the one that acts last wins, and they don't flip-flop
  const laptopCtl = await page({ viewport: { width: 800, height: 900 } });
  await laptopCtl.goto(BASE + '#control=SKEW');           // connecting sends its (default sinus) state
  await laptopCtl.waitForFunction(() => /Monitor online|in control/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await laptopCtl.click('[data-rh="vt"]'); await wait(1500);
  ok(await rhythm(mon) === 'vt', 'second instructor screen takes control when it acts');
  await wait(9000);                                       // two heartbeat rounds
  ok(await rhythm(mon) === 'vt', 'no flip-flop back to the first phone');
  ok(/Another device in control/.test(await phone.textContent('#cStat')), 'first phone shows "Another device in control"');
  await phone.click('[data-rh="sinus"]'); await wait(1500);
  ok(await rhythm(mon) === 'sinus', 'first phone takes back control with its next action');

  // 4. vitals: Apply button shows pending changes; BP change triggers a cuff measurement
  await phone.click('#segRamp [data-v="0"]');
  await phone.fill('#in_sbp', '70'); await phone.dispatchEvent('#in_sbp', 'change');
  ok(/Apply 1 change/.test(await phone.textContent('#bApply')), 'Apply button shows "Apply 1 change"');
  await phone.click('#bApply'); await wait(2000);
  ok(await mon.evaluate(() => PC.Monitor._debug.N.state === 'meas'), 'BP change starts an NIBP measurement');
  await wait(17000);
  const N = await mon.evaluate(() => PC.Monitor._debug.N);
  ok(N.sys >= 66 && N.sys <= 74, 'monitor BP shows the new value: ' + N.sys);

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' || ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
