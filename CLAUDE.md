# PALS Companion — project context

Paediatric resuscitation **teaching** tool. One device shows a simulated bedside monitor; the instructor's
phone controls it live. Sister app of Code Blue Companion (`drvigneshn/cbc`, cbc.pediaos.com).
Owner: Dr Vignesh N (paediatrician, no CS background): explain changes in plain language.

## Live site & hosting
- **Live at:** https://pals.pediaos.com (GitHub Pages from **`main`**, root folder).
- `CNAME` holds `pals.pediaos.com`; DNS is a CNAME at Hostinger (`pals` → `drvigneshn.github.io`). `.nojekyll` present.
- **Deploying:** commit and push to `main`. More than one Claude session may work this repo: always
  `git fetch` first and rebase onto `origin/main` before pushing; never clobber newer work.

## Files (no build step: plain HTML/CSS/JS)
- `index.html` — markup + all CSS (theme tokens on `:root` / `[data-theme=light]`). Loads the scripts below in order.
- `js/core.js` — `window.PC`: helpers, age groups/alarm limits (`PC.AGE`), rhythms (`PC.RHYTHMS`), doses (`PC.DOSES`),
  energies, `PC.defaultState()`, and `PC.Link` (pairing).
- `js/scenarios.js` — `PC.SCENARIOS` (stages, instructor cues, expected-action checklists). `{adr}`, `{J2}` etc. are
  filled with the patient's weight by `PC.fillDoses`.
- `js/monitor.js` — the monitor engine (`PC.Monitor`).
- `js/controller.js` — the instructor UI (`PC.Controller`) and `boot()` routing (chooser / `#monitor=CODE` / `#control=CODE`).
- `lib/mqtt.min.js` (mqtt 5.16.0), `lib/qrcode.js` (qrcode-generator 1.4.4) — vendored so the app works offline.
- `sw.js` (offline cache), `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png`, `privacy.html`.
- `test/` — local relay stand-in + Playwright checks (see Testing).

## Versioning (do this on every change)
Bump in ALL places, keep in sync:
1. `PC.VERSION` in `js/core.js` (shown on the chooser and in Setup → About)
2. `CACHE` in `sw.js` (`'pals-vX.Y.Z'`) — this is what pushes updates to installed users; never skip it.
Small change → patch; new feature → minor. Current: **v0.1.0**.

## Attribution on commits
End commit messages with the Co-Authored-By line from the session's instructions. Never put a model identifier
in code, PRs or docs. Do NOT open a PR unless asked.

## Architecture
- **State:** the instructor owns one JSON object (`PC.defaultState()`): vitals `v{hr,spo2,rr,etco2,sbp,dbp,temp}` with
  `vt` (apply time) + `ramp` (drift ms); `rhythm` + `pulse` (PEA = organised rhythm with `pulse:false`); sensors
  `leads/probe/co2On/cuff`, `co2Shape`; `cpr`, `cprQ`, `cprRate`, `sync`; one-off events as timestamps
  `shockAt/shockJ`, `nibpAt`, `silenceAt`; `nibpAuto`, `alarms`, `beep`, `monTheme`, `frozen`, `pt{group,age,wt,bed}`,
  `reveal{on,title,text}`, `t` (send time). The whole object is sent on every change.
- **Monitor applies** a state only if `t` is newer; ignores states > 3 h old. One-off events fire when their stamp
  *changes* (never on the first state after load, so a reload does not replay a shock). Device clocks are never compared.
  A new `vt` starts a local ramp from the current set values.
- **Link (`PC.Link`)**: 4-char code (no I/O/0/1). BroadcastChannel `pals-<CODE>` for same-device windows, plus MQTT over
  WSS to `broker.hivemq.com:8884` and `broker.emqx.io:8084`, topic `pediaos-pals-v1/<CODE>/state` (retained) and
  `/hb/mon|ctl` heartbeats every 4 s. The monitor's heartbeat carries `gotT`; the controller resends if the monitor is behind.
  URL hooks: `?mqtt=ws://127.0.0.1:8888` (comma list overrides brokers), `?mqtt=off`.
- **Monitor engine:** beat scheduler per rhythm (sinus, SVT, 1°, Mobitz I/II, 3° AVB with independent P waves, VT);
  VF/torsades/asystole are continuous functions. Pleth pulse 170 ms after each perfusing QRS. Breath scheduler drives
  capnogram (normal or shark-fin) and impedance resp. Four sweep canvases (`Row`: ECG 5 s, pleth 5 s, CO₂ 10 s, resp 10 s).
  Physiology: HR counted from QRS (compression rate during CPR); SpO₂ lag + NO PULSE/SEARCHING; EtCO₂ from CPR quality
  and ROSC surge; NIBP 17 s cycle. Alarms: high/medium/technical with age limits (`PC.limits`), top one in the banner,
  Web Audio tones; pulse beep pitch follows SpO₂. Audio starts on the "Start monitor" tap.
- **Controller tabs:** Live (CPR/shock/sync/ROSC, rhythm chips, staged vitals + ramp), Scenario (stem, stages with
  branches, cues, checklist), Timeline (timers, dose log, copyable log + score), Setup (pairing, patient, sensors,
  monitor, result card, about). Controller state persists in `localStorage` key `pals-ctl-v1`.

## Constraints (keep these)
- No accounts, no backend of our own, no analytics. Must work offline once loaded.
- Public relays are not private: only simulated values; never add fields for real patient identifiers.
- Doses/energies only on the instructor phone, never on the monitor. AHA PALS weight-based; dengue per IAP;
  scorpion prazosin 30 mcg/kg (IAP).
- Don't imitate any real monitor manufacturer's branding or exact layout.

## Testing
No build. Syntax: `cat js/core.js js/scenarios.js js/monitor.js js/controller.js > /tmp/all.js && node --check /tmp/all.js`.
Browser checks (Playwright + pre-installed Chromium):
```bash
cd test && npm install && node servers.js &   # MQTT-over-WS broker :8888 + static app server :8080
node sync.js     # two isolated browsers paired via relay: VF alarm, CPR HR/EtCO2, shock, ROSC, vitals, scenario, leads off
node local.js    # one device, pop-up monitor via BroadcastChannel: NIBP, alarms, themes, reload doesn't replay shock
node icons.js    # re-render icon PNGs from icon.svg
```
Screenshots land in `test/shots/` (git-ignored).

## Open items (remind the owner until done)
- [ ] Owner to verify all doses, joules and scenario cue text against current AHA PALS / IAP guidance and unit protocol.
- [ ] Enable GitHub Pages (Settings → Pages → main / root) and add the Hostinger CNAME `pals` → `drvigneshn.github.io`.
- [ ] Real-world test: phone ↔ projector laptop on hospital Wi-Fi via the public relays.
- [ ] Choose the store name ("PALS" is an AHA programme name; consider a neutral store name).
- [ ] Android: PWABuilder → TWA, then add `.well-known/assetlinks.json`.

## Ideas the owner may ask for next
Defibrillator skin (energy/charge/shock, CPR-quality bar), NICU skin (pre/post-ductal SpO₂), teaching mode with
labelled numbers, one-thumb quick-dial, examiner scoresheet export (PDF), scenario builder, 12-lead ECG image reveal,
custom KKCTH scenarios, freeze + replay last 2 min for debrief.
