# PALS Companion — project context

Paediatric resuscitation **teaching** tool. One device shows a simulated bedside monitor; the instructor's
phone controls it live. Sister app of Code Blue Companion (`drvigneshn/cbc`, cbc.pediaos.com).
Owner: Dr Vignesh N (paediatrician, no CS background): explain changes in plain language.
Mentors (credited on the start screen, About and Setup → About): Dr Janani Sankar, Medical Director, KKCTH;
Dr Radhika Raman, Senior Consultant, KKCTH.

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
- `js/corecases.js` — IAP ALS core cases 1–5, 7–12 (case 6 still to add), prepended to `PC.SCENARIOS`. Written in our own
  words, labelled "Based on the IAP ALS core-case format". Fields: `settings` (ER/ward/ICU stems → `sc.setting`,
  sets bed label), stage `block`, `findings` [label,text], `identify` (ticks `i:iJ`), `expect` (ticks `i:J`),
  `result` {title,text} (button shows it on the monitor). Debrief scores Identify and Intervene separately.
  Token `{ml20}` = 20 mL/kg in mL. Weights are assumed for age.
- `js/monitor.js` — the monitor engine (`PC.Monitor`).
- `js/controller.js` — the instructor UI (`PC.Controller`) and `boot()` routing (chooser / `#monitor=CODE` / `#control=CODE`).
- `lib/mqtt.min.js` (mqtt 5.16.0), `lib/qrcode.js` (qrcode-generator 1.4.4) — vendored so the app works offline.
- `sw.js` (offline cache), `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png`, `privacy.html`, `about.html`
  (About/Privacy load `js/core.js` only to print the version).
- `test/` — local relay stand-in + Playwright checks (see Testing).

## Versioning (do this on every change)
Bump in ALL places, keep in sync:
1. `PC.VERSION` in `js/core.js` (shown on the chooser and in Setup → About)
2. `CACHE` in `sw.js` (`'pals-vX.Y.Z'`) — this is what pushes updates to installed users; never skip it.
Small change → patch; new feature → minor. Current: **v0.4.0**. The version shows on the landing footer, disclaimer gate, monitor footer,
instructor footer, About and Privacy (all read `PC.VERSION`).

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
- **Controller tabs:** Live (quick actions: rhythm + team events; CPR/shock/sync/ROSC; ⚡ Surprise complications with
  "fix" buttons; staged vitals + ramp; all rhythms), Scenario (stem, stages with branches, cues, checklist), Timeline
  (timers, dose log, copyable log), Debrief (key times, checklist, timeline; show on monitor / copy / print-PDF),
  Setup (pairing, patient, sensors, monitor incl. exam mode + CPR panel, result card, about).
  Controller state persists in `localStorage` key `pals-ctl-v1` (incl. `ev` structured events, `snap`, `active`).
- **Debrief:** `track()` (called by `send()`) records a `snap` event whenever perfusion / CPR / shockable changes;
  `computeDebrief()` integrates them: time to CPR, first shock (from shockable onset), first adrenaline + intervals,
  CPR fraction, hands-off (after first CPR) + longest pause, time to ROSC, checklist score. Log entries carry `kind`.
- **Monitor extras:** `exam` (high/medium alarms read "⚠ ALARM"/"⚠ ALERT"; technical alarms stay specific),
  `noVent` (breaths return no CO₂), CPR panel (`cprBar`: rate vs 100–120, depth from `cprQ`, hands-off seconds),
  `debrief` overlay. Each vital ramps independently (a later change doesn't restart another's drift); RR rising from
  apnoea starts at the target rate.
- **Start screen:** "Which device is this?" Monitor / Instructor cards (suggests Instructor on phones), plus
  "Only one device?" (`#goSolo` → instructor + pop-up monitor). `PC.leave()` returns to it from anywhere
  (monitor ✕ Exit top-right, Back on the monitor start overlay, Back on the pair screen, Setup → Back to start).
- **NIBP:** the controller's `send()` triggers a cuff reading whenever BP targets or perfusion change (stages, ROSC,
  arrest, surprises, manual edits) via `nibpAfter(ramp)`; the monitor pre-fills a BP on its first state.
- **Live tab order:** Quick actions (rhythms + team events) → 🫁 Breathing states (`resp()`) → 🫀 Cardiac arrest
  steps (1 compressions, 2 defibrillator with Defibrillate / Sync segment, 3 ROSC) → ⚡ Surprise → Vitals → All rhythms.
- **Disclaimer gate** `#dGate`: once per device, `localStorage pals-disclaimer-ack-v1`. Never gate per session.

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
node v4.js       # core cases: settings, findings, identify/intervene ticks, result card, debrief split
node v3.js       # credits, start screen, Exit/Back, BP follows stages/ROSC/arrest, breathing, arrest panel
node v2.js       # gate, landing/footer/version, quick actions, surprise (tube), exam mode, CPR panel, debrief
node robust.js   # clock skew between devices, phone wake-up, two instructor screens, Apply + auto NIBP
node local.js    # one device, pop-up monitor via BroadcastChannel: NIBP, alarms, themes, reload doesn't replay shock
node icons.js    # re-render icon PNGs from icon.svg
```
Screenshots land in `test/shots/` (git-ignored).

## Open items (remind the owner until done)
- [ ] Add IAP ALS core case 6 (page not received yet). Check IAP permission for publishing the core cases.
- [ ] Owner to verify all doses, joules and scenario cue text against current AHA PALS / IAP guidance and unit protocol.
- [x] GitHub Pages + Hostinger CNAME + HTTPS enforced — site confirmed working at https://pals.pediaos.com (26 Sep 2026).
- [ ] Real-world test: phone ↔ projector laptop on hospital Wi-Fi via the public relays.
- [ ] Choose the store name ("PALS" is an AHA programme name; consider a neutral store name).
- [ ] Android: PWABuilder → TWA, then add `.well-known/assetlinks.json`.

## Ideas the owner may ask for next
Defibrillator skin (energy/charge/shock), NICU skin (pre/post-ductal SpO₂), teaching mode with
labelled numbers, scenario builder, team-side dose calculator scored in the debrief (link with Code Blue Companion), 12-lead ECG image reveal,
custom KKCTH scenarios, freeze + replay last 2 min for debrief.
