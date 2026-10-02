# PALS Companion

A simulated paediatric bedside monitor for resuscitation teaching and exams.
One screen (laptop, tablet or projector) shows the **monitor**. The instructor's **phone** controls it live:
rhythm, vitals, CPR, shocks, alarms and ready-made scenarios.

**Live:** https://pals.pediaos.com · For training only, not a medical device.

## How to use it in a session
1. On the laptop/projector, open the site and choose **Monitor screen**. It shows a 4-letter code and a QR code.
2. On your phone, scan the QR code (or open the site, choose **Instructor controls** and type the code).
3. On the monitor, press **Start monitor** (this also turns on the sound).
4. On the phone:
   - **Live**: one-tap quick actions (VF, pVT, PEA, asystole, brady, SVT, hypoxia, ROSC) and team events (adrenaline, amiodarone, airway, IV/IO…), CPR/shock/sync, ⚡ Surprise complications, staged vitals with a drift (now / 10 s / 30 s / 1 min / 2 min).
   - **Scenario**: pick a case, read the stem to the team, then step through stages with **Next stage**. Cues and doses show only on your phone. Tick what the team does.
   - **Timeline**: scenario clock, 2-minute CPR cycle, time since adrenaline, one-tap weight-based drug log, copyable log with checklist score.
   - **Debrief**: time to CPR, first shock, adrenaline timing, CPR fraction, hands-off time, checklist and timeline; show on the monitor, copy, or print/save PDF.
   - **Setup**: exam mode (alarms say only "ALARM"), CPR feedback panel, patient age/weight, sensors on/off (leads, probe, CO₂ line, cuff), capnogram shape, monitor theme, freeze for debrief, show a result card (ABG, ECG, X-ray…) on the monitor.

**Only one device?** In the instructor screen choose **Open monitor window here** and drag that window onto the projector.

## Realism built in
- Heart rate is counted from the ECG; during CPR it counts the compressions.
- EtCO₂ follows CPR quality (good ≈ 18, poor ≈ 8) and jumps on ROSC.
- SpO₂ lags behind the set value, shows "NO PULSE" without perfusion and "SEARCHING" after ROSC.
- PEA gives no rhythm alarm, only "SpO₂ NO PULSE", as on a real monitor.
- Shock artefact on the ECG, sync markers on R waves, 17-second NIBP cycle that fails without a pulse.
- Age-based alarm limits with high / medium / technical priorities and sounds.

## Privacy
No accounts, no analytics. Different devices talk through public relays, so only simulated values are sent.
Never type real patient details. See `privacy.html`.

## Hosting
Plain static files, no build step, served by GitHub Pages from `main`.
Custom domain via `CNAME` (`pals.pediaos.com`) and a CNAME DNS record `pals → drvigneshn.github.io`.

Created by Dr Vignesh N. © 2026. Not for reuse or redistribution without written permission.
