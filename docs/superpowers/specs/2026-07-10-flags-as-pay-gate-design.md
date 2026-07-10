# Flags-as-pay-gate — design (owner-confirmed 2026-07-10)

**Goal:** an impossible attendance day pays **₱0** for that day until resolved via Edit-times,
with loud early visibility so ₱0 never lands on a worker silently. Day-scoped: a flagged day
zeroes only itself, never the worker's clean days in the same week.

## Flag predicate (LOCKED — data-verified against all 388 live rows)

A day is **hard-flagged** (pays ₱0) if EITHER:
1. **Clamp** — any single session (morning/afternoon/evening span) `> 16h`, OR the day's total
   worked `> 20h`. Catches the midnight-crossing "balloon" (e.g. a Time Out before an evening
   PM-In inflates the evening span to 24–31h).
2. **Within-day order inversion** — among the first five punches
   (`timein, lunch_out, lunch_in, pm_out, pm_in`), where present, any is earlier (same-day
   clock) than a strictly-earlier slot. The **timeout is EXCLUDED** — a legit night/evening
   shift crosses midnight, so `timeout < timein` is normal and MUST NOT flag.

**Rejected conditions (would zero legit pay):** raw `timeout < timein` (36 rows, 35 legit) and
exact `12:00 AM`/00:00 punch (29 rows, ~27 legit). This workforce genuinely works to midnight
and punches `12:00 AM`; payroll already computes those as real 14h OT. Owner chose
**clamp + real inversions only** (2026-07-10).

Live scan result with the locked predicate: **4 genuinely-impossible rows**
(RSR 0026 07-02 = 23.9h balloon; RSR 0031 07-09 = 17h morning balloon; RSR 0027 06-27 =
lunch-in 01:00 AM typo; RSR 0022 06-30 = pm-out 12:00 AM mid-afternoon). **Zero** legit rows.

Constants (must match in kiosk + payroll):
`HARD_MAX_SESSION_MS = 16*3600000`, `HARD_MAX_DAY_MS = 20*3600000`.

## Scope decision

The pay-gate applies to the **hard flags above only**. The pre-existing **missing-punch**
flags (`prSessions` `mFlag/aFlag/eFlag`, e.g. forgot Lunch Out) are a separate concept and are
**left unchanged** — that session already pays 0 while the rest of the day pays, and the day
still counts as present. (The payslip's existing "MISSING PUNCH — session pays ₱0" card
overstates this; reconciling missing-punch into the pay-gate is a **separate** big pay swing
needing its own owner decision + data review. **Follow-up, not this build.**)

## Implementation map

### Shared detector (identical logic in both files — like the shift-boundary numbers)
- **payroll `prSessions`** (`payroll/index.html:342`): after computing spans, add
  `hardFlag`, `hardReasons[]` to the return (clamp on `morning/afternoon/evening/worked`;
  inversion via `parseClock` on the first five raw punches).
- **kiosk `calcSessions`**: same computation from its own spans + parser; expose on the record
  so the kiosk can alert.

### Payroll — pay-gate + visibility
- **`runPayroll` `rs.forEach`** (`~715`): if `S.hardFlag`, push `{date, why}` to a new
  `hardFlagDays` and `return` BEFORE `daysPresent++` / OT / allowances — so the day contributes
  ₱0. Clean and missing-punch days unchanged. Add `hardFlagDays` to the `computed.push` object.
- **Payslip card** (`~849`): a distinct red "🚫 FLAGGED — pays ₱0 until resolved" card per
  hard-flagged day (worker sees it, same pattern as the MISSING PUNCH card), listing date + why.
- **Run-screen banner + tile** (`~160` tiles, `recalcTotals` `~909`): a prominent banner atop
  `#run-results` listing every unresolved flagged row (worker + date + why) + a "Flagged · ₱0"
  count tile. Shown BEFORE finalize.
- **Finalize gate** (`postDeductions` `~1161`, already passcode-gated via `openConfirm`): the
  confirm prominently lists unresolved flagged rows so they can't be finalized unnoticed.
- **Resolution:** only Edit-times (already: reason + owner passcode + `attendance_edit_audit`).
  `recomputeDay` re-runs `prSessions`; if no longer hard-flagged, the flag clears and the day
  pays normally. No other unflag path.

### Kiosk — same-day Telegram alert (no backend cron; fires from the tablet at punch time)
- When a punch is saved and the day is newly hard-flagged, send a TG alert to the owner group
  (reuse `tgToken`/`tgGroup`), once per row (dedupe key `code_date`). Message: worker, date, why.

## Tests
- E2E full lifecycle: seed an impossible day → payroll shows ₱0 + banner + payslip card →
  Edit-times fix (reason + passcode) → recompute → pays real hours → flag cleared + audit row.
- Regression: the 29 midnight-OT rows and all clean rows are UNCHANGED (still pay their hours).
- Kiosk: an impossible punch fires exactly one TG alert; a clean punch fires none.
- `node --check` both files; hygiene grep; full nd-e2e regression set stays green.

## Deploy
Worker- and payroll-facing → pause for the owner's localhost walkthrough before pushing.
Bump kiosk + payroll stamps + preflight EXPECT in lockstep.
