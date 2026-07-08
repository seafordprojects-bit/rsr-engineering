# Night Duty — Design Spec (LOCKED 2026-07-07)

> Occasional night shift with an **admin-configurable start**. This spec REPLACES any
> earlier night-duty spec. Design is **locked** — implement as specified via SDD;
> escalate only genuine conflicts. Kiosk + payroll are worker-facing / pay-adjacent →
> **pause for the owner's localhost walkthrough before any push.**

## Sequencing
- Queue **after** the Close-job-order tasks wrap. **Task 6 is a hard prerequisite** — the
  "Night shift schedule" admin card sits behind the owner-PIN gate that Task 6 builds.
- Build targets: **kiosk v2026-07-07d → v2026-07-08a**, **payroll v2026-07-07a → v2026-07-08a**
  (preflight EXPECT bumped in lockstep for both).

## Schema (owner runs the SQL before E2E; do NOT run it for them)
- `attendance_records.night_duty boolean default false`
- `attendance_records.nd_ms bigint default 0`
- `settings` rows (same key/value store as `owner_pin`): `night_shift_start` default `'22:00'`,
  `night_shift_end` default `'08:00'`.

## Night shift config
- **A. Owner-PIN-gated "Night shift schedule" card** on the monitoring/home admin surface
  (same gate Task 6 builds): edit start + end times (e.g. 8 PM–6 AM or 10 PM–8 AM), writes to
  the settings store, changes **audit-logged** like other settings.
- **B. Kiosk READS** the schedule from Supabase on load + periodic refresh, caches last-known
  in localStorage, **falls back to 22:00–08:00** if offline / never fetched. Kiosk admin UI
  stays disabled — no kiosk-side editing.
- **C.** All night windows derive from configured start **S** and end **E**. The **ND (night
  differential) window does NOT move — statutory 22:00–06:00 always.**

## Kiosk (v07d → v08a)
1. **Arming (self-serve):** Time In punched between **S−1h and S+2h** → Bisaya Padayon/Kanselahon
   confirm (07c modal pattern) showing the CONFIGURED times:
   `"Night duty ka ba karon (" + start + " – " + end + ")? Ang imong oras maihap gikan sa " + start + "."`
   Padayon → `rec.nightDuty=true` + timein recorded; Kanselahon → abort, nothing recorded.
   Existing after-shift-end late-Time-In approval flow stays for punches outside the arming window.
2. **Lateness:** vs **S** with the standard 10-min grace; early arrivals (from S−1h) **snap-pay
   from S**, mirroring day-shift effectiveStart snapping. No false "late vs 8 AM".
3. **Sequence:** timein → lunch_out → lunch_in → timeout. **PM Break hidden/skipped** (reuse the
   straight-duty-PM skip). One meal break.
4. **Meal anchored to SHIFT, not the individual punch** — whole crew eats together, exactly like
   day shift (day lunch = shift start + 4h for everyone):
   - normal meal-out window **S+4h to S+4h30m**;
   - earlier meal out allowed any time after timein via the 07c-style Bisaya **deduction confirm**;
   - **hard close S+4h40m** with Policy A (missing) after;
   - meal in from **30 min after actual meal out**, closes **S+9h**.
   - **Timeout:** available after meal in (undertime detection applies to early leaves), windowed
     to **12:00 noon cutoff**; still open at noon → existing incomplete flow.
5. **Cross-midnight extension (riskiest — E2E hard):** for hours 00:00–11:59, if today's rec has
   **no timein** AND yesterday's rec has `nightDuty=true` and is open, **remap
   lunch_out/lunch_in/timeout punches AND updBtns state to yesterday's record** — at 8 AM a night
   worker sees HIS Time Out, never a fresh day Time In. An **8 PM start puts the MEAL past midnight
   too (12:00–12:40 AM)** — the remap must cover **meal punches**, not just timeout. Existing 4 AM
   timeout-only cross-midnight for day-shift OT is unchanged.
6. **ND:** on close, `nd_ms = worked ms overlapping 22:00–06:00 minus meal overlap within that
   window` (an 8 PM start earns ND only from 10 PM — automatic via overlap). Add `night_duty` +
   `nd_ms` to the pushRecord payload.
7. **Telegram:** night Time In tagged **🌙 NIGHT DUTY** with configured shift + actual punch time;
   night workers included in the daily summary.
8. **Day-shift behavior byte-for-byte unchanged** for non-night records — all v07d rules intact
   (strict windows, PM-Break-Out auto day-close, early-punch confirms, ₱50 allowance). **E2E must
   include day-shift regression checks.**

## Payroll (v07a → v08a)
9. Weekly per employee: sum `nd_ms` → **ND pay = (nd_ms/3600000) × (dailyRate ÷ shift hours) × 0.10**.
   Add to `netOf()`, an editable **"Night diff (+)"** field like stay-in, payslip row
   **"Add night diff (X.Xh × 10%)"** on the modal + batch tiles, shown when > 0.

## E2E (mocked clock)
> **CORRECTION 2026-07-08 (owner):** the night meal mirrors the DAY LUNCH exactly — a fixed
> **1-hour unpaid deduction** (meal-out credit snapped to S+4h, meal-in credit snapped to S+5h),
> not the raw 40-min punch gap. So the 22:00 case below is **9h worked = 8 basic + 1 OT** and
> **nd_ms = 7h** (8h window − 1h credited meal). The 9h20m/7h20m figures originally written here
> are superseded. See docs/superpowers/plans/2026-07-08-night-duty-plan.md Tasks 5 & 7.
- **Config 22:00–08:00:** arm 10:02 PM → meal out 2:00 AM → meal in 2:40 AM → timeout 8:00 AM →
  attaches to night record, **9h worked** → 8h basic + 1h OT via existing math,
  **nd_ms = 7h**, `night_duty=true` synced.
- **Config 20:00–06:00:** arm 8:05 PM → meal out 12:00 MN → meal in 12:40 AM → timeout 6:00 AM →
  **meal remap across midnight works**, nd_ms = 22:00–06:00 overlap minus any meal overlap in that window.
- **Late-worker:** config 22:00, arm at 11:00 PM → LATE 1h vs 22:00, **meal window still 2:00 AM**
  (shift-anchored, not punch-anchored).
- **Regressions:** full day-shift suite unchanged; a 2 AM punch from a worker with **NO open night
  rec must NOT create or touch any record.**
