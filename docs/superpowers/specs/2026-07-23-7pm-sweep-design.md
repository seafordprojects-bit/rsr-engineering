# 7 PM Sweep — server-side day-close, replacing the instant PM-Break-Out auto-close (2026-07-23)

## Status
**BUILT 2026-07-23 (kiosk v2026-07-23a), awaiting walkthrough.** Architecture REVISED during the build:
the close stays **CLIENT-side** (durable), the server is **READ-ONLY report + loud anomaly**. Reason: the
kiosk pushes its full local record (incl. `timeout: null`) on every save (`pushRecord` 5504, `saveData`
5552 re-queues all open today-rows), so a server-side *write* close is clobbered by the next OT-punch
re-sync. So: the instant 5 PM auto-close is retired (day stays open 5–7 PM for PM Break In), the client
abandoned-PM-break close is re-timed 7:30 → **7:00 PM** (`CLIENT_PMBREAK_AUTOCLOSE`, writes local
`timeout=pm_out`), and `public.kiosk_sweep_report()` (cron 11:10 UTC = 7:10 PM Manila) READS the settled
DB and sends "N of M closed ✅" / loud ⚠️ (days still open, no tablet reported, or below-norm). **Req D
KEPT (owner, 2026-07-23):** the 7 PM close writes timeout=pm_out AND tags `sweptClose`; a later Time Out
SUPERSEDES it (real time + photo, pm_out kept), evening stays ₱0 until the coordinator fills pm_in — with
a Bisaya modal explaining it. Files: `kiosk/index.html`, `kiosk-sweep-report.sql`, harness
`tests/kiosk-stress` (A6/A7b updated, C updated, E cap, F client-close+tripwire+supersede). Harness 33/33.

## Motivation
Today, PM Break Out **instantly** fills `timeout` (auto-close at ~5 PM, `pmOutAutoClosed=true`). Two problems:
1. It closes the day at 5 PM, but the 22c rule gives the OT crew until **7 PM** to punch PM Break In —
   the instant close fights that window (and drives the `pmOutAutoClosed` reopen dance).
2. A Time Out that "replaces" the auto-close **deletes `pm_out`** (kiosk ~2536-2538), so a
   timeout-without-pm_in day runs the afternoon 1 PM→finish straight through and **pays the unpaid 5–6
   break** — a real overpay (see peso diff below).

Replace the instant fill with a **server-side 7 PM sweep**: days stay open 5 PM→7 PM (the OT window),
then the sweep closes anyone who left and never returned.

## Design

### A. Kiosk — remove the instant fill + stop deleting pm_out (hide, don't delete, per CLAUDE.md)
- **PM Break Out no longer writes `timeout` / sets `pmOutAutoClosed`.** The day stays open (`pm_out` set,
  `timeout` null). Retire the `pmOutAutoClosed` reopen logic — nothing was closed, so PM Break In no
  longer "reopens." Guard/flag the old code off; do not delete it.
- **(Req 7) Time Out stops deleting `pm_out`** (guard off kiosk ~2533-2538). A timeout-without-pm_in day
  **keeps** `pm_out`, so the afternoon caps at 5 PM, the 5–6 hour stays **unpaid**, and the evening
  computes **zero** until a coordinator fills `pm_in` via correction.
- **Remove the instant timeout-fill on PM Break Out — the sweep replaces it.**

### B. The sweep — server-side, in the existing watcher (pg_cron / `kiosk_alert_tick` family)
- Runs at **7 PM Asia/Manila**. **(Req 3) Reuse the watcher's existing Asia/Manila time logic — never
  recompute.**
- **(Req 1) Fill-only UPDATE**, `WHERE timeout IS NULL AND pm_in IS NULL AND pm_out IS NOT NULL AND
  date = <today>`. Sets `timeout = pm_out` (the 5 PM close — same value the old instant-fill wrote, just
  deferred). Wrapped in a **count → verify → rollback transaction** (our STEP pattern): count matches
  (M), update, assert `rowsUpdated == M`, else `ROLLBACK` and report the anomaly.
- **(Req 2) "today" matched via the same date helper the kiosk uses to write dates — no second
  implementation.** Recommended: the sweep reads the kiosk's own `todayKey()` value (already reported
  server-side via `kiosk_health` heartbeat) and matches on that exact string, rather than re-deriving
  the format in SQL. Harness must include a **mixed-TEXT-date-format** scenario (`MM/DD/YYYY` +
  `YYYY-MM-DD`): today's kiosk rows are swept; foreign-format / other-day rows are untouched.

### C. (Req 5) Nightly report to the alerts group
- After the sweep: **"Swept N of M open ✅"** on normal nights. Escalate to a **⚠️ anomaly** message when
  `N=0 && M>0`, or when `N` is far outside the usual band (band definition = open build decision, below).

### D. Edge case — evening Time Out after the sweep
- A worker with `pm_out` but no `pm_in` can **still punch Time Out in the evening**: it records the
  **real time + photo** and **supersedes** the sweep-written `timeout` for that day. His **evening still
  computes zero pay** (no `pm_in`) until the coordinator fills `pm_in` via correction. **Verify the
  engine and all displays tolerate the timeout-without-pm_in shape** (payroll, diagnostic, kiosk roster,
  payslip).

### E. Time-zone correctness (Req 3)
- Never recompute Manila time — reuse the watcher's logic. Harness ticks at **18:59 Manila (no sweep)**,
  **19:01 Manila (sweep)**, and **at the UTC day boundary** (proves the sweep targets the correct Manila
  day, not the UTC day).

## Permanent harness scenarios (the regression net)
1. **(Req 4) OT worker with `pm_in` set exists at sweep time → the sweep touches ZERO of his fields.**
   This is the permanent tripwire for any future edit to the WHERE clause.
2. **(Req 2)** Mixed TEXT date formats: today's rows swept; other-format / other-day rows untouched.
3. **(Req 3)** Ticks at 18:59 / 19:01 Manila and across the UTC day boundary.
4. **(Req 1)** Fill-only WHERE: rows with `timeout` set, or `pm_in` set, or `pm_out` null → untouched.
5. **(Req 1)** Count-verify-rollback: inject a count mismatch → transaction rolls back, nothing changes,
   anomaly reported.
6. **(Req D)** Evening Time Out supersedes the swept timeout; evening still computes 0 until `pm_in`.

## (Req 6 + 7) Before/after peso diff — representative day, centavo-exact at walkthrough
Computed via the **real `prSessions` engine** (rate ₱610/day, 8h → hourly ₱76.25, OT ×1.25, OT-allow ₱50
at ≥3h; rate-independent for the diff). "Before" = current behavior; "After" = this build.

| Case | Before | After | Diff | Note |
|---|---|---|---|---|
| 1. Normal 5 PM closer | ₱610.00 | ₱610.00 | **₱0.00** | no pm_in involved |
| 2. OT worker (pm_in 6 PM, out 9 PM) | ₱945.94 | ₱945.94 | **₱0.00** | 11h worked, 3h OT, 5–6 unpaid |
| 3. Timeout-without-pm_in (out 9 PM) | ₱1041.25 | **₱610.00** | **−₱431.25** | **intended** — overpay removed |

**Case 3 is supposed to change** (Req 7): today the Time Out deletes `pm_out`, so the afternoon runs
1 PM→9 PM (8h) and pays 4h OT incl. the 5–6 break (₱1041.25). After the fix `pm_out` is kept, so the
afternoon caps at 5 PM, evening = 0, and the day is ₱610.00 with a "PM Break In missing" review flag —
**OT stays unpaid until the coordinator fills `pm_in`.** The −₱431.25 is the overpay disappearing
(4h × ₱76.25 × 1.25 = ₱381.25 OT + ₱50 allowance). Cases 1 & 2 are ₱0.00 by construction.

## Queued separately — NEXT-WEEK task, NOT this build
- **`punch_date` DATE column migration:** add a real `DATE` column, backfill by parsing the existing
  TEXT `date` values, kiosk writes **both** (TEXT + DATE) during transition. This **permanently retires
  the date-matching risk** that the sweep works around with the kiosk-`todayKey` match. Full
  census/backup ritual (STEP 0 census → `bak_*` backups → transactional self-verifying migration →
  re-query). Own build.

## Open build-time decisions
1. **Anomaly band (Req 5):** define "far outside the usual band." Proposed default: ⚠️ when `N=0 && M>0`,
   OR `M-N` (unswept open days) `> 0` after the verify (should be zero), OR `N` below ~50% of the
   trailing-7-night median. **Owner to confirm the band** (it's a threshold that governs an alert).
2. **Date-helper match (Req 2):** recommended = match the kiosk-reported `todayKey` from `kiosk_health`
   (no SQL re-derivation). Fallback = server `to_char(..., 'MM/DD/YYYY')` matched to the documented kiosk
   format, harness-proven. Technical call — will decide at build unless the owner prefers otherwise.
3. **Multi-site:** the sweep is global across yards (one 7 PM tick); the report can break down per site.

## Workflow
Walkthrough with the harness results (all scenarios green + the centavo peso diff) → **one deploy**.
