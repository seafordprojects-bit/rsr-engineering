# Full-day Time-In gate — evening night-confirm + early-morning refusal (2026-07-24)

## Status
Designed + approved 2026-07-24. **QUEUED as a FOLLOW-UP — build only AFTER v2026-07-23a (the 7 PM sweep +
dead-window gate) ships.** Builds on the dead-window PIN-entry gate (`deadWindowInfo`, kiosk v2026-07-23a).
Walkthrough gate before push; `night_shift_confirmed` column via STEP 0 census. Owner decisions locked:
**Oo sets BOTH** (`night_duty` for pay + `night_shift_confirmed` audit); **remove late-day Time In after
5 PM**; **replace** the on-press night-arm with the PIN-entry confirm.

## Goal
Complete the full-day Time-In gate at **identification (PIN-entry) time**, so a worker learns
immediately whether/how they can clock in. Two new windows join the existing gate:
- **5:00 PM–1:00 AM:** "Night shift ka ba karon?" (Oo/Dili) — the single night-arm confirmation.
- **1:00–7:00 AM:** refuse Time In (starts 7:00 AM) — **Time-In attempts only**; an open prior-evening
  shift must still Time Out normally.

## What already exists (reused, not rebuilt)
- **Night-arm confirm** (`openEarlyBisayaConfirm('nightarm')`, `bisayaConfirmProceed`): Oo →
  `nightArmConfirmed=true` → `punch('timein')` sets `rec.nightShift=true` → syncs the **`night_duty`**
  column → payroll's `prNight` applies the differential. Currently fires on the Time In **press** during
  the ~10 PM night-arm window. **This feature moves that trigger to PIN-entry and widens it to 5 PM–1 AM.**
- **1–7 AM dead-zone** (`punch()` ~2592) refuses Time In; **cross-midnight routing** already lets an open
  shift Time Out (day-OT < 4 AM `NIGHT_CLOSE_CUTOFF_H`, night < 7 AM). Requirement (2) = move the refusal
  to PIN-entry, preserve the Time Out path.
- **`deadWindowInfo` + `kp()` PIN-entry gate** (10–12:40, 3–5 PM). This feature extends the same spot.

## Design

### The unified PIN-entry gate (empty day = no Time In today)
`now` → action, evaluated in `kp()` right after `showEmpPreview` (day worker; `!rec.nightShift`):

| Window | Action |
|---|---|
| 7:00–10:00 AM | allow (morning) — no modal |
| 10:00–12:40 | refuse — dead-window modal *(built)* |
| 12:40–3:00 PM | allow (afternoon) — no modal |
| 3:00–5:00 PM | refuse — dead-window modal *(built)* |
| **5:00 PM–1:00 AM** | **night-confirm** — "Night shift ka ba karon?" Oo/Dili |
| **1:00–7:00 AM** | **refuse** ("balik 7:00 AM") — unless an open prior shift exists → allow (Time Out) |

Refactor: fold the two new windows into the existing helper (rename intent to a `timeInGate(now, rec)`
that returns `{kind:'allow'|'refuse'|'nightconfirm', modal, hint}`), keeping the dead-window cases intact.

### (1) 5:00 PM–1:00 AM night-shift confirm
- PIN-in on an empty day in this window → show the **Oo/Dili** modal. **Finalized wording:**
  > **Night shift ka ba karon?**
  > Naa kay dugang bayad sa gabii (night differential). Ang day Time In sirado na human sa 5:00 PM.
  - Title line = the question; one short consequence line = night differential applies + day Time In
    closed after 5 PM. Buttons: **Oo** (proceed) / **Dili** (cancel). Bisaya phrasing may be polished at
    walkthrough, but the two-line structure + Oo/Dili buttons are fixed.
- **Oo** → run the existing confirmed-night-arm path: `punch('timein')` with `nightArmConfirmed=true`,
  which sets `rec.nightShift=true` (→ `night_duty`, pay unchanged) **and** now also `rec.nightShiftConfirmed
  =true` (→ new `night_shift_confirmed` audit column). Records the Time In at the actual time.
- **Dili** → close modal, `kpClr()` (clear PIN), **record nothing**.
- **Replaces** the on-press night-arm: the on-press trigger (`punch()` ~2561) is guarded so it never
  double-asks once PIN-entry owns the confirmation (kept as an inert fallback, not deleted).
- **Removes late-day Time In after 5 PM:** the old Policy-A "Time In records at actual time after shift
  end" no longer applies to a bare Time In in this window — 5 PM–1 AM is night-confirm or nothing.

### (2) 1:00–7:00 AM refusal + cross-midnight Time Out preserved
- PIN-in on an **empty** today AND **no open prior-evening shift** → refuse modal *"⚠ Sirado pa ang Time
  In karon. Magsugod ang Time In sa 7:00 AM…"*, record nothing.
- If **yesterday's shift is still open** (Time In, no Time Out; day-OT < 4 AM or night < 7 AM) → **do NOT
  refuse** → show the normal preview so the worker Times Out (existing cross-midnight routing writes the
  Time Out to yesterday). The gate checks the same open-yesterday condition `punch()`/`updBtns` already
  use, so Time-Out behavior is byte-identical.
- The existing `punch()` 1–7 AM dead-zone check stays as defense-in-depth (the PIN-entry modal is the
  friendly surface; the punch guard is the backstop).

### `night_shift_confirmed` column
- New column on `attendance_records` (boolean, default false). Audit only — payroll does NOT read it
  (night pay stays on `night_duty`). Kiosk `pushRecord` adds `night_shift_confirmed: rec.nightShiftConfirmed
  || false`. STEP 0 census (count existing rows / nulls) → additive `alter table … add column if not
  exists` → re-query. No backfill needed (default false).

## Harness scenarios (permanent)
1. 6:00 PM PIN-in, empty day → night-confirm modal shows; **Oo** → Time In recorded, `night_duty=true`,
   `night_shift_confirmed=true`; **Dili** → nothing recorded, PIN cleared.
2. Boundary: 4:59 PM → dead-window (PM-close) modal; 5:00 PM → night-confirm; 12:59 AM → night-confirm;
   1:00 AM → refuse.
3. 2:00 AM empty day → refuse modal, nothing recorded.
4. 2:00 AM **with an open yesterday shift** → NOT refused; Time Out records to yesterday (cross-midnight).
5. Regression: day-shift windows (10–12:40, 3–5) still show the dead-window modal (A6d unchanged);
   normal 8 AM / 1 PM Time In still records with no modal.
6. No double night-arm ask (PIN-entry Oo → no second on-press confirm).

## Migration + rollout
- SQL: STEP 0 census + `add column if not exists night_shift_confirmed boolean default false`.
- Kiosk: `pushRecord` payload adds the field; `rec.nightShiftConfirmed` set alongside `nightShift`.
- Bump version stamp + preflight EXPECT. Walkthrough gate (worker-facing) → one push.

## Scope exclusions
- Payroll unchanged (night pay stays on `night_duty`; `night_shift_confirmed` is audit-only).
- No change to the 1–7 AM cross-midnight Time-Out routing itself — only the PIN-entry surface.
- Dead-zone `punch()` guard retained (not moved) as the backstop.
