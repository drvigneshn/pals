// Simulates a public broker that marks every delivered message as "retained".
// Before v0.5 the monitor then ignored every change after the first one.
// Needs `node servers.js` running.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/?mqtt=ws://127.0.0.1:8888';
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const mk = async () => {
    const c = await b.newContext({ viewport: { width: 900, height: 700 } });
    await c.addInitScript(() => {
      try { localStorage.setItem('pals-disclaimer-ack-v1', '1'); } catch {}
      // force retain=true on every incoming message, as some brokers do
      const iv = setInterval(() => {
        if (!window.mqtt || !mqtt.MqttClient) return; clearInterval(iv);
        const emit = mqtt.MqttClient.prototype.emit;
        mqtt.MqttClient.prototype.emit = function (ev, topic, payload, pkt) {
          if (ev === 'message' && pkt) pkt.retain = true;
          return emit.apply(this, arguments);
        };
      }, 1);
    });
    return c.newPage();
  };
  const mon = await mk(), ctl = await mk();
  await mon.goto(BASE + '#monitor=RTNX'); await mon.click('#mGo');
  await ctl.goto(BASE + '#control=RTNX');
  await ctl.waitForFunction(() => /Monitor online/.test(document.querySelector('#cStat').textContent), null, { timeout: 15000 });
  await wait(4000);
  for (const [key, want] of [['vf', 'vf'], ['svt', 'svt'], ['asys', 'asystole'], ['sinus', 'sinus']]) {
    await ctl.click(`#rhChips [data-rh="${key}"]`); await wait(1500);
    const got = await mon.evaluate(() => PC.Monitor._debug.S.rhythm);
    ok(got === want, `rhythm ${key} reaches the monitor (got ${got})`);
  }
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
