# Night Duty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Test reality:** this repo has **no test runner** — validation is `node --check` on the largest inline `<script>` (extracted as an ES module) **plus Playwright E2E against a mocked clock**. So the TDD cycle here is: *write the E2E scenario (it fails) → implement → scenario passes → node --check + hygiene → commit.* Task 1 builds the E2E harness the later tasks consume.

**Goal:** Add an occasional, admin-configurable night shift to the kiosk and payroll — self-serve arming, shift-anchored single meal, cross-midnight punch remap, statutory night-differential pay — **without changing any day-shift behavior for non-night records.**

**Architecture:** A single `rec.nightShift` boolean is the master switch. Every night code path is gated behind it (or behind the night arming-window test at Time In); when it is false — the default and the only value day records ever hold — execution takes the exact v07e/v07a path. Night shift boundaries derive from a configurable start **S** (`night_shift_start`) and end **E** (`night_shift_end`), read from the `settings` store with a localStorage cache and a 22:00–08:00 offline fallback. The night-differential (ND) pay window is the **fixed statutory 22:00–06:00** and never moves with S/E.

**Tech Stack:** Vanilla JS + Preact/htm via CDN, no build step. Supabase project `wpmcbjrisuyjvobvzaus` (PostgREST). GitHub Pages.

## Global Constraints

- **Base files:** kiosk `kiosk/index.html` at `v2026-07-07e`; payroll `payroll/index.html` at `v2026-07-07a`. **Extend, do not rewrite or refactor.** Target stamps: both → **`v2026-07-08a`**.
- **Spec point 8 is the contract:** all v07b–e day-shift behavior (strict windows, PM-Break-Out auto day-close, early-punch Bisaya confirms, ₱50 away allowance, OT allowance, roster sync) stays **byte-for-byte identical for non-night records**, proven by regression E2E. A non-night `rec` must never enter a night branch.
- **A 2 AM punch from a worker with NO open night record must NOT create or touch any record.**
- **ND window is fixed 22:00–06:00** regardless of S/E. An 8 PM start earns ND only from 22:00 (automatic via interval overlap).
- **Supabase:** project `wpmcbjrisuyjvobvzaus` only. `azfmpleswqixaslvcito` must never appear. SQL uses `--` comments. htm template literals use literal `&`, never `&amp;`.
- **Schema is already live** (verified via REST): `attendance_records.night_duty boolean default false`, `attendance_records.nd_ms bigint default 0`, `settings.night_shift_start='22:00'`, `settings.night_shift_end='08:00'`. No schema task remains.
- **Deploy gate:** kiosk + payroll are worker/pay-facing → **pause for the owner's localhost walkthrough before any push.** Stamps + preflight `EXPECT` bump in lockstep (Task 9), pushed only after "go".
- **Validate before commit:** extract the largest inline `<script>` and `node --check` it as ESM; grep hygiene (`wpmcbjrisuyjvobvzaus` present, `azfmpleswqixaslvcito` absent) on every touched file.
- **Kiosk record shape (from the map):** record key `` `${code}_${MM/DD/YYYY}` `` in `records{}` → localStorage `rsr_records`. `rec.punches{}` holds display-time strings; `rec.msMap{}` holds epoch-ms (all math uses `msMap`). Night flag will be `rec.nightShift`.

---

## Task 1: Playwright E2E harness with mocked clock

**Files:**
- Create: `scratchpad/nd-e2e/harness.mjs` (shared launch + clock-mock + punch helpers)
- Create: `scratchpad/nd-e2e/regression-dayshift.mjs` (baseline day-shift scenarios — MUST pass against untouched v07e before any kiosk change)

**Interfaces:**
- Produces: `launchKiosk({ nowISO, settings })` → `{ page, browser }` that (a) installs a deterministic clock **before any app script runs** by overriding `Date`/`Date.now` via `page.addInitScript`, seeded to `nowISO`, with a `__advanceClock(ms)` hook on `window`; (b) stubs the kiosk's Supabase reads so `settings` returns the passed `night_shift_start`/`night_shift_end`/`shift_start`/`dismissal`; (c) serves the repo over the existing localhost server (port 8137). Produces `punch(page, code, type)`, `expectButtons(page, {enabled,disabled})`, `readRecord(page, code, dateKey)` (reads `localStorage.rsr_records`), `readSyncPayload(page)` (reads `localStorage.rsr_sync_pending`).

- [ ] **Step 1: Write the clock-mock init script.** In `harness.mjs`, `page.addInitScript` a shim: freeze a base epoch from `nowISO`, replace `Date` with a subclass whose no-arg constructor and `Date.now()` return `base + elapsedSinceInstall`, expose `window.__setNow(iso)` and `window.__advanceClock(ms)`. Must be installed via `addInitScript` so it runs before the kiosk's inline module.
- [ ] **Step 2: Stub Supabase settings.** Use `page.route` on the PostgREST `settings` endpoint to return the seeded night/day settings JSON, so `loadShiftFromCloud` (kiosk 4497-4512) picks up the test schedule deterministically. Let all other Supabase calls fail soft (kiosk already tolerates offline — writes queue to `rsr_sync_pending`).
- [ ] **Step 3: Write `punch()` + inspector helpers** that click a punch button by its `BIDS` id, dismiss/confirm the Bisaya modal (`#bisaya-confirm-modal` Padayon/Kanselahon) per an arg, and read back `records`/`rsr_sync_pending` from `localStorage`.
- [ ] **Step 4: Write `regression-dayshift.mjs`** encoding the current day-shift happy path + two edge cases from v07e: (a) normal 8:00 in → 12:00 lunch out → 12:40 lunch in → 5:00 pm out (auto day-close) → verify worked_ms/late; (b) early 7:50 Time In snaps to 8:00; (c) a **2 AM punch with no open record creates nothing**.
- [ ] **Step 5: Run the regression against untouched v07e.** `node scratchpad/nd-e2e/regression-dayshift.mjs`. Expected: **all pass** (this is the byte-for-byte baseline; re-run after every later task).
- [ ] **Step 6: Commit** `git add scratchpad/nd-e2e && git commit -m "test(kiosk): night-duty E2E harness + day-shift regression baseline"`.

---

## Task 2: Admin "Night shift schedule" card (owner-PIN-gated)

**Files:**
- Modify: `home.js` (admin dashboard settings area — same surface as the Task-6 owner-passcode card)

**Interfaces:**
- Consumes: the Task-6 owner-PIN plumbing already in `home.js` (`getSetting`/`setSetting` equivalents, `checkOwnerPin`, the `settings_audit` insert used by `saveOwnerPin`). Read the current `home.js` to match the exact card/field/button classes and the owner-passcode save pattern.
- Produces: two settings writes `night_shift_start`, `night_shift_end` (`HH:MM` 24h), each edit gated by the owner passcode and logged to `settings_audit` (`key:'night_shift_start'|'night_shift_end'`, `action:'set'|'change'`, actor).

- [ ] **Step 1: Read `home.js`** around the Task-6 owner-passcode card; copy its card/section/field/button markup idiom and its save→audit flow.
- [ ] **Step 2: Add state + loader** for `nightStart`/`nightEnd`, initialized from `getSetting('night_shift_start')||'22:00'` and `...end||'08:00'`.
- [ ] **Step 3: Add the card** "Night shift schedule" with two `HH:MM` inputs (start, end) and a Save button. On save: validate both match `^([01]?\d|2[0-3]):[0-5]\d$`; prompt owner passcode; `checkOwnerPin`; on ok `setSetting` both + insert a `settings_audit` row per changed key (`set` if it was absent, else `change`); show a confirmation; on `notSet` reuse the Task-6 "create owner passcode" fallback.
- [ ] **Step 4: Validate** — `node --check` the extracted `home.js` module (it is already an ES module; check directly). Hygiene grep.
- [ ] **Step 5: E2E (light).** Load `/admin/` in Playwright, enter the card, save 20:00/06:00 with the owner passcode, and assert `settings` received the writes (stub or live-read via REST against a throwaway value, then restore to 22:00/08:00).
- [ ] **Step 6: Commit** `git commit -m "feat(nd): owner-gated Night shift schedule admin card (audited)"`.

---

## Task 3: Kiosk night config + constants + `nightShift` scaffolding

**Files:**
- Modify: `kiosk/index.html` — constants block ~1050-1069; `getRec` line 1101; `loadShiftFromCloud` 4497-4512.

**Interfaces:**
- Produces: mutable lets `nightShiftH/nightShiftM` (default 22/0), `nightEndH/nightEndM` (default 8/0); fixed `ND_START_H=22`, `ND_END_H=6`; `rec.nightShift` (default `false`) on every record; night schedule read from `settings` with `rsr_shift_override` cache + 22:00/08:00 fallback. **No behavior change yet** — these are unused by day-shift paths.

- [ ] **Step 1: Add constants** near lines 1050-1064:
  ```js
  let nightShiftH=22,nightShiftM=0,nightEndH=8,nightEndM=0;   // config- S / E, overridden by Supabase
  const ND_START_H=22, ND_END_H=6;                            // statutory ND window — NEVER moves
  ```
- [ ] **Step 2: Default the flag** — in `getRec` (1101) add `nightShift:false` to the created record object (day records keep it false forever).
- [ ] **Step 3: Extend `loadShiftFromCloud`** (4499): add `'night_shift_start','night_shift_end'` to the `.in([...])` key list; parse each `HH:MM` and assign `nightShiftH/M`, `nightEndH/M` with the same validation the function already applies to `shift_start`; extend the `rsr_shift_override` cache object (write 4505 / read-back 4508) to include the two night keys so the offline fallback is last-known-then-22:00/08:00.
- [ ] **Step 4: Bump nothing yet** (stamp bump is Task 9). Validate `node --check` on the extracted inline script; hygiene grep.
- [ ] **Step 5: Regression E2E** — re-run `regression-dayshift.mjs`; **all still pass** (proves scaffolding is inert for day records).
- [ ] **Step 6: Commit** `git commit -m "feat(nd): kiosk night constants + config read + inert nightShift flag"`.

---

## Task 4: Kiosk night arming + lateness (self-serve Time In)

**Files:**
- Modify: `kiosk/index.html` — `punch('timein')` path ~2260-2620; `updBtns` Time-In window 2208-2221; Bisaya confirm 991-1013; `effectiveStart`/`chkLate` 1139-1192.

**Interfaces:**
- Consumes: night constants (Task 3), the Bisaya modal replay pattern (`openEarlyBisayaConfirm`→`bisayaConfirmProceed`→replay `punch`).
- Produces: `rec.nightShift=true` set at a confirmed night Time In; night arming window helper `inNightArmWindow(nowMs)` = `S−1h ≤ now ≤ S+2h`; night lateness/snapping vs **S**.

- [ ] **Step 1: E2E first (fails).** Add `nd-arming.mjs`: settings 22:00/08:00, clock 22:02 PM, Time In for a worker → expect a Bisaya confirm whose text contains `Night duty ka ba karon (22:00 – 08:00)?`; Padayon → record has `nightShift:true`, `timein` snapped to 22:00 (within 10-min grace), `isLate:false`; a second run clicking Kanselahon → **no record written**.
- [ ] **Step 2: Add `inNightArmWindow(nowMs)`** computing today's `S` datetime from `nightShiftH/M`, window `[S−60min, S+120min]`.
- [ ] **Step 3: Arming branch in `punch('timein')`.** Before the normal Time-In window checks: if `inNightArmWindow(now)` and not `nightArmConfirmed`, open a **new** night-arm Bisaya confirm with the exact spec string:
  ```js
  "Night duty ka ba karon (" + hhmm(nightShiftH,nightShiftM) + " – " + hhmm(nightEndH,nightEndM) + ")? Ang imong oras maihap gikan sa " + hhmm(nightShiftH,nightShiftM) + "."
  ```
  Padayon → set a module flag `nightArmConfirmed=true` and replay `punch('timein')`; Kanselahon → abort, write nothing (mirror `bisayaConfirmCancel`). On the replay, set `rec.nightShift=true` and `rec.straightDutyPm=true` (reuse the PM-skip seam) before recording the punch.
- [ ] **Step 4: Night lateness + snap.** When `rec.nightShift`: compute lateness and effective start against `nightShiftH/M` instead of `shiftH/M` (branch inside `chkLate`'s caller at 2550 and `effectiveStart` 1139-1151 / write-time snap 2506-2530). Early arrivals from `S−1h` snap-pay from `S`; within-grace snaps to `S`; later than grace = actual, `isLate`. **No false "late vs 8 AM."**
- [ ] **Step 5: Preserve** the existing after-shift-end late-Time-In approval flow for punches **outside** the arming window (do not route those through the night branch).
- [ ] **Step 6: Validate + E2E.** `node --check`; run `nd-arming.mjs` (passes) and `regression-dayshift.mjs` (still passes — day Time In never enters the arming branch because `inNightArmWindow` is false at 8 AM for a 22:00 S).
- [ ] **Step 7: Commit** `git commit -m "feat(nd): kiosk night arming confirm + lateness/snap vs configured start"`.

---

## Task 5: Kiosk night meal sequence (shift-anchored windows)

**Files:**
- Modify: `kiosk/index.html` — `getNext` 1105-1116 (already skips PM via `straightDutyPm`); `updBtns` window locks 2201-2253; `punch()` meal window checks (early Lunch Out 2460-2462, etc.); `calcSessions`/`calcBreak` meal math 1133-1189.

**Interfaces:**
- Consumes: `rec.nightShift`, night constants, the early-deduction Bisaya confirm, Policy-A "(missing)" marker.
- Produces: night meal windows anchored to **S** (not to the punch): normal meal-out `S+4h`–`S+4h30m`; earlier allowed via deduction confirm; hard close `S+4h40m` → Policy A `(missing)` after; meal-in from `actualMealOut+30m`, closes `S+9h`; night timeout after meal-in, windowed to **12:00 noon** cutoff.

- [ ] **Step 1: E2E first (fails).** `nd-meal.mjs`: armed 22:00 worker; meal-out offered normally at 02:00 (=S+4h); an attempt at 00:30 triggers the deduction Bisaya confirm; meal-in blocked until 30m after meal-out; timeout enabled after meal-in; assert the meal window is anchored to S (see Task 7 late-worker case for punch-independence).
- [ ] **Step 2: Night meal-out window.** In `updBtns`/`punch` for `lunch_out` when `rec.nightShift`: normal-enable in `[S+4h, S+4h30m]`; before `S+4h` allow only through the existing early-deduction Bisaya confirm (reuse `openEarlyBisayaConfirm('lunch_out')`); **hard close at `S+4h40m`** → if no meal-out by then, mark `rec.punches.lunch_out='(missing)'`/`msMap` per Policy A (mirror the existing 12:40 hard-close at 2205 but against `S+4h40m`).
- [ ] **Step 3: Night meal-in window.** For `lunch_in` when `rec.nightShift`: earliest = `actualMealOut + 30min`; latest/close = `S+9h`. Branch the existing lunch-in floor (2224) on `nightShift`.
- [ ] **Step 4: Night timeout window.** For `timeout` when `rec.nightShift`: enabled after a real `lunch_in` (meal-in); windowed with a **12:00 noon** cutoff; still open at noon → existing incomplete flow (do not auto-close). Branch the timeout gate (2239-2251) on `nightShift`; undertime detection on early leaves still applies.
- [ ] **Step 5: Confirm PM break stays skipped** (via `straightDutyPm=true` from Task 4) — `getNext` omits `pm_out/pm_in`; no PM deduction.
- [ ] **Step 6: Validate + E2E.** `node --check`; `nd-meal.mjs` passes; `regression-dayshift.mjs` passes (day meal windows unchanged).
- [ ] **Step 7: Commit** `git commit -m "feat(nd): kiosk shift-anchored night meal sequence + noon timeout window"`.

---

## Task 6: Kiosk cross-midnight remap (meal + timeout)

**Files:**
- Modify: `kiosk/index.html` — cross-midnight rebind in `punch()` 2263-2273 and its `updBtns` mirror 2246-2251.

**Interfaces:**
- Consumes: `rec.nightShift`, the existing `_crossMidnight`/`_crossKey` rebind + queue-yesterday's-key machinery (2606).
- Produces: for wall-clock **00:00–11:59**, when today's rec has **no timein** AND yesterday's rec has `nightShift===true` and is open (`timein && !timeout`), remap `lunch_out`, `lunch_in`, **and** `timeout` punches (and `updBtns` state) to yesterday's record. The existing day-OT timeout-only `<4 AM` remap is preserved for non-night records.

- [ ] **Step 1: E2E first (fails).** `nd-crossmidnight.mjs`: settings **20:00/06:00**; arm 20:05 PM (day D); advance clock past midnight; meal-out 00:00 (D+1) → must attach to D's record (not create a D+1 record); meal-in 00:40; timeout 06:00 → D's record closes, worker at 06:00 sees his Time Out (never a fresh Time In). Assert no D+1 record exists.
- [ ] **Step 2: Generalize the rebind.** In the 2263-2273 block, replace the `type==='timeout' && ... getHours()<4` guard with: if `!rec.punches.timein` AND `now.getHours()<12` AND yesterday's rec exists with `nightShift && punches.timein && !punches.timeout`, then for `type` in `{lunch_out,lunch_in,timeout}` rebind `rec=_yr; _crossMidnight=true; _crossKey=_yk; next=getNext(rec)`. **Keep the original `type==='timeout' && hours<4` path** for the non-night day-OT case (either branch may fire; night branch requires yesterday `nightShift`).
- [ ] **Step 3: Mirror in `updBtns`** (2246-2251): enable `lunch_out/lunch_in/timeout` before noon when today is empty and yesterday is an open night rec, so the buttons the worker needs are lit at 2 AM / 6 AM / 8 AM.
- [ ] **Step 4: Confirm sync routing.** The write path already queues `_crossKey` (yesterday) and flushes (2606) — verify the remapped meal/timeout writes land on yesterday's `attendance_records` row (via `readSyncPayload`).
- [ ] **Step 5: Validate + E2E.** `node --check`; `nd-crossmidnight.mjs` passes; `regression-dayshift.mjs` passes; **explicitly assert** a 2 AM punch with no open night rec creates nothing (the `nightShift` requirement blocks it).
- [ ] **Step 6: Commit** `git commit -m "feat(nd): cross-midnight remap of night meal + timeout to yesterday's open record"`.

---

## Task 7: Kiosk ND computation + payload + Telegram

**Files:**
- Modify: `kiosk/index.html` — worked/close math (near `calcWorked`/`pushRecord`); `pushRecord` payload 4887-4895; `sendPunchNotif` 1390-1416; `buildSummary` 1489-1501.

**Interfaces:**
- Consumes: `rec.nightShift`, effective (snapped) worked interval, meal interval, `ND_START_H/ND_END_H`.
- Produces: `rec.nd_ms` computed on close; `night_duty` + `nd_ms` added to the upsert payload; 🌙 Telegram tagging.

- [ ] **Step 1: E2E first (fails).** Extend `nd-arming.mjs`/`nd-crossmidnight.mjs` assertions: config 22:00–08:00 worked 22:00→08:00 with meal 02:00–02:40 → `nd_ms === 7h20m` (26,400,000 ms); config 20:00–06:00 → `nd_ms` = overlap(20:00→06:00 worked, 22:00–06:00) minus meal overlap in that window; assert the sync payload carries `night_duty:true` and the numeric `nd_ms`.
- [ ] **Step 2: Add `overlapMs(aStart,aEnd,wStart,wEnd)`** = `Math.max(0, Math.min(aEnd,wEnd) − Math.max(aStart,wStart))`.
- [ ] **Step 3: Compute `nd_ms` on close** when `rec.nightShift`: derive the ND window `[ndStart,ndEnd]` = the `22:00` on the timein's calendar date → `+8h` (06:00 next day); `worked = overlapMs(effectiveTimeinMs, timeoutMs, ndStart, ndEnd)`; `meal = overlapMs(mealOutMs, mealInMs, ndStart, ndEnd)` (0 if no meal punches); `rec.nd_ms = Math.max(0, worked − meal)`. Use the **snapped/effective** timein (same basis as `worked_ms`).
- [ ] **Step 4: Payload.** In `pushRecord` (4887-4895) add `night_duty: !!rec.nightShift, nd_ms: Number(rec.nd_ms)||0`. Day records send `false`/`0` — payload otherwise byte-for-byte identical.
- [ ] **Step 5: Telegram.** In `sendPunchNotif` for a night Time In (`rec.nightShift` && `punchType==='timein'`), prefix/tag **🌙 NIGHT DUTY** with the configured shift `hhmm(S)–hhmm(E)` and the actual punch time. Ensure night workers are counted in `buildSummary` (present/late tallies include them — verify they aren't filtered out by a day-only condition).
- [ ] **Step 6: Validate + E2E.** `node --check`; ND E2E asserts pass; `regression-dayshift.mjs` passes (day payload has `night_duty:false,nd_ms:0`, Telegram unchanged).
- [ ] **Step 7: Commit** `git commit -m "feat(nd): kiosk nd_ms computation + sync payload + Telegram night tag"`.

---

## Task 8: Payroll ND pay (v07a → v08a math)

**Files:**
- Modify: `payroll/index.html` — accumulator 709; per-day sum ~729; pay compute ~735; computed row 739-749; `netOf()` 771; run-card input ~817-820; payslip modal row ~936; tile row ~1051.

**Interfaces:**
- Consumes: the per-week attendance rows (already `select('*')`, so `nd_ms` arrives); `hourly` (= dailyRate ÷ shift) at line 708.
- Produces: `r.ndMs`, `r.ndPay` on the computed row; ND added to net; editable "Night diff (+)" field + payslip rows.

- [ ] **Step 1: Accumulate** — line 709 add `ndMs=0`; inside `rs.forEach` (~729) add `ndMs += Number(r.nd_ms)||0;`.
- [ ] **Step 2: Compute** — near line 735 add `const ndPay=(ndMs/3600000)*hourly*0.10;` (mirrors `otPay`).
- [ ] **Step 3: Row fields** — in `computed.push({...})` (739-749) add `ndPay, ndMs,`.
- [ ] **Step 4: netOf()** — line 771 add `+ (Number(r.ndPay)||0)` (only change to the net formula).
- [ ] **Step 5: Editable input** — mirror the stay-in field (817-820): a "Night diff (+)" number input `value="${r.ndPay}" oninput="upd(${i},'ndPay',this.value)"`.
- [ ] **Step 6: Payslip rows (shown only when > 0).** Modal (~936) and tile (~1051), using the `>0` conditional form: `Add night diff (${(Number(r.ndMs)/3600000).toFixed(1)}h × 10%)` → `peso(r.ndPay)`.
- [ ] **Step 7: Validate.** `node --check` extracted payroll script; hygiene grep. E2E: seed a synthetic attendance row with `nd_ms` for a known employee, run payroll for that week in Playwright, assert the net rises by exactly `(ndMs/3600000)*hourly*0.10` and the row renders; assert an employee with `nd_ms=0` shows **no** ND row and an unchanged net (regression).
- [ ] **Step 8: Commit** `git commit -m "feat(nd): payroll night-differential pay line (additive to netOf)"`.

---

## Task 9: Finalize — stamps, preflight EXPECT, full regression

**Files:**
- Modify: `kiosk/index.html` line 238 stamp; `payroll/index.html` line 130 stamp; `preflight.html` line 38 `EXPECT`.

- [ ] **Step 1: Bump stamps** — kiosk `v2026-07-07e`→`v2026-07-08a` (line 238); payroll `v2026-07-07a`→`v2026-07-08a` (line 130).
- [ ] **Step 2: Bump preflight EXPECT** (line 38) both entries to `v2026-07-08a` in lockstep.
- [ ] **Step 3: Full E2E suite** — run all scenarios: the three spec E2E (22:00 config → 9h20m/nd_ms 7h20m; 20:00 cross-midnight meal remap; late-worker meal still shift-anchored at 02:00) **and** the entire day-shift regression. All pass.
- [ ] **Step 4: Validate + hygiene** on kiosk, payroll, preflight.
- [ ] **Step 5: Commit** `git commit -m "chore(nd): bump kiosk+payroll to v2026-07-08a and preflight EXPECT in lockstep"`.
- [ ] **Step 6: STOP — owner localhost walkthrough.** Do not push. Hand the owner the walkthrough (kiosk night arming→meal→cross-midnight→timeout on localhost with a mocked/real clock, payroll ND line). Push the whole bundle only after explicit "go"; then verify live stamps via cache-busted curl and confirm.

---

## Self-Review

- **Spec coverage:** §Config-A→Task 2; §Config-B(kiosk read+cache+fallback)→Task 3; §Config-C(fixed ND window)→Tasks 3/7; kiosk 1(arming)→Task 4; 2(lateness)→Task 4; 3(sequence/PM skip)→Tasks 4/5; 4(meal anchoring)→Task 5; 5(cross-midnight)→Task 6; 6(ND)→Task 7; 7(Telegram)→Task 7; 8(day-shift unchanged)→regression in every kiosk task + Task 9; payroll 9→Task 8; E2E→Task 1 harness + per-task scenarios + Task 9 suite.
- **Ordering:** harness → admin card → kiosk scaffolding → arming → meal → cross-midnight → ND/payload/Telegram → payroll → finalize. Each kiosk task re-runs the day-shift regression.
- **Risk note:** Task 6 (cross-midnight) is the riskiest; its E2E asserts both the remap works AND that a no-open-record 2 AM punch is inert.
