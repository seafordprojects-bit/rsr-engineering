# Coordinator time-correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to work this plan task-by-task. Steps use `- [ ]` checkboxes.
> **No code appears in this plan by the owner's instruction** — it is the build order, the file map,
> the gates and the risks. Each task's code is written at execution time, as complete files.

**Source spec:** `docs/superpowers/specs/2026-08-03-coordinator-time-correction.md`
(all 8 open questions answered by the owner 2026-08-04).

**Goal:** Give Jamaica (RSR 0025) a times-only correction screen on the coordinator page whose every
entry is a *proposal*, and give the admin a payroll-side approval queue that is the only thing that
can ever change a punch payroll reads.

**Architecture:** Two tables (`attendance_time_edit` pending queue, `attendance_day_lock`) plus
additive columns on the existing `attendance_edit_audit`. The coordinator surface writes **only** to
the pending queue. The approval queue lives in `payroll/index.html` because the recompute engine
(`recomputeDay`/`prSessions`/`nightND`) lives in that file's classic inline script and must not be
duplicated. `saveTimes()` is refactored into one shared apply function with three callers.

**Tech stack:** vanilla JS + Preact/htm via CDN (no build step), Supabase/PostgREST project
`wpmcbjrisuyjvobvzaus`, pg_cron + pg_net for the Telegram reminder.

---

## Global Constraints

Every task inherits these. They are not repeated per task.

- **LIVE PRODUCTION PAYROLL.** Nothing ships unvalidated; nothing pay-affecting is committed without
  the owner's explicit go.
- **One edit path (grep-verifiable invariant):** the punch columns `timein / lunch_out / lunch_in /
  pm_out / pm_in / timeout` of `attendance_records` are written in exactly **one** file,
  `payroll/index.html`. `coordinator.js` and `home.js` must never write them. Check this by grep at
  every review.
- **Date column landmine:** `attendance_records.date` is TEXT in mixed `MM/DD/YYYY` and `YYYY-MM-DD`
  spellings. Never `.eq('date', …)` with one spelling, never lexical gte/lte ranges. Use the pattern
  the prerequisite fix established (commit e5607c5): enumerate every spelling of the wanted day(s)
  via `.in()`, then normalise with `toISO()` and filter client-side.
- **Do NOT "fetch everything and filter".** `attendance_records` held 1038 rows on 2026-08-04 and
  PostgREST caps a response at 1000 — an unbounded fetch trades the date bug for silent truncation.
  Bound every fetch to the enumerated dates of the loaded window.
- **No money on the coordinator surface** — no rate, no peso figure, no derived pay. The coordinator
  code must not even *select* rate columns; a client-side select is readable in devtools whether or
  not it is rendered. Worked **hours** (h) per day are allowed and wanted (owner, Q2).
- **Named attribution, never a role string.** Every pending row carries `filed_by_code` +
  `filed_by_name` resolved from the PIN at submit. `filed_by:'Coordinator'` is the anti-pattern being
  corrected — do not repeat it.
- **Complete files only** when handing anything to the owner. Never diffs or snippets.
- SQL uses `--` comments, never `//`. htm/HTML template literals use a literal `&`, never `&amp;`.
- **Read the current live file before editing it.** Sections have been wiped before by starting from
  a stale copy.
- Hygiene on every deliverable: `wpmcbjrisuyjvobvzaus` must be present, `azfmpleswqixaslvcito` must be
  absent (report, never silently delete, if one appears).
- **Two-project SQL rule:** close the other Supabase tab, `select current_database();` from inside the
  tab, lead every migration with the canary `select count(*) from public.attendance_records;`.
- **"Applied" is not evidence.** After the owner runs SQL, re-query one thing that touches the NEW
  object before any client code names it.
- **EVERY SQL MIGRATION SHIPS WITH ITS ROLLBACK, WRITTEN AT THE SAME TIME** (owner rule, 2026-08-04).
  A migration file is not finished until `<name>-rollback.sql` exists beside it, in the same commit.
  It is not optional and it is not "later": the moment a migration is worth writing down is the only
  moment its author still holds every reason each object exists, and a rollback improvised during an
  incident is written by someone who does not. The rollback must: lead with the same STEP 0 canary;
  **snapshot into `bak_` tables before dropping anything that can hold real work, and refuse to drop
  when the snapshot is missing**; leave additive nullable columns in place by default (dropping them
  is the one act that loses data, and keeping them costs nothing); and end with a re-query block
  proving the undo landed. Anything genuinely destructive is commented out with the reason to run it
  spelled out above the line. This applies to every migration from here, not just this feature.

---

## Preconditions (both must be true before Task 1 starts)

- [ ] **P1 — the `getAttendance()` date fix is live.** Owner gate from spec §11/§14 (Q5).
  **STATUS: DONE.** Shipped as commit `e5607c5`, `coordinator/index.html:69` now loads
  `coordinator.js?v=2026-08-04b`. Verify the live stamp with a cache-busted fetch before starting —
  deployment lag is a known phantom-bug source.
- [ ] **P2 — Friday's payroll cutoff has passed** (2026-08-07 unless the cutoff week differs).
  Spec §13/§14: the build does not start before it.

---

## File map

| File | Status | Responsibility in this feature |
|---|---|---|
| `coordinator-time-correction.sql` | **create** (repo root, alongside `awol-suspensions.sql`) | All DDL: `attendance_time_edit`, `attendance_day_lock`, additive `attendance_edit_audit` columns, `employees.is_time_editor`, `time_editor_for_pin` + throttle table, RSR0025 seed, grants, schema reload, verification block |
| `coordinator-time-correction-rollback.sql` | **create** (repo root, beside the migration) | Undo for the above, written in the same commit per the standing rollback rule. Snapshots `attendance_time_edit` / `attendance_day_lock` / the new audit columns into `bak_*_20260804` and refuses to drop when a snapshot is short; drops the RPC, throttle and both tables; clears `is_time_editor`. Column drops (`employees.is_time_editor`, the five `attendance_edit_audit` columns) are commented out — additive nullable columns cost nothing to leave and are the only thing here that loses data |
| `coordinator-time-reminder.sql` | **create** (repo root) | Cutoff-day Telegram reminder: outstanding-count function, send-once guard table, `cron.schedule`. Separate file so the reminder can be re-run/retuned without re-running the feature DDL |
| `payroll/index.html` | **modify** | `saveTimes` (1322) → shared `applyPunchEdit`; new "Time approvals" tab (tab row 144–148); missing-punch section; pending/unclosed banner on Run Payroll; extended Past-edits panel (`loadEditHistory` 1385); stamp at line 141 |
| `coordinator.js` | **modify** | New Time-correction tile on the `App()` grid (1951) + component + PIN submit. Writes only `attendance_time_edit` |
| `coordinator/index.html` | **modify** | Cache-buster on line 69 only |
| `home.js` | **modify** (optional) | Read-only pending count badge linking to the payroll tab. No logic duplicated |
| `preflight.html` | **modify** | `EXPECT` map line 45 — bumped in lockstep with the payroll stamp |

Current line anchors verified 2026-08-04 against the live files:
`payroll/index.html` — `milTo24` 408, `prSessions` 413, `recomputeDay` 545, `toISO` 588,
`runPayroll` 809 (fetch 829, `curFrom/curTo` set 814), tabs 144–148, `editTimes` 1180,
`populateWorkerPicker` 1184, `openWorkerEdit` 1199, `renderEditArea` 1220, `addEditDay` 1309,
`saveTimes` 1322, `loadEditHistory` 1385, `_live` poll 1445–1473, `openConfirm` 1586.
`coordinator.js` — `getAttendance` 188, `Lock` ~287, `getSetting('tg_awol_group')` 297,
`Attendance` 974, `AwolLetters` 1847, `App` 1951.

---

## What can be built with ZERO payroll code

These four touch nothing in `payroll/index.html` and carry no risk to a payroll run. They are the
safe half of the build and can proceed while the payroll half waits for a quiet window.

- **Task 1** — the SQL migration (new tables/columns/RPC only; see the one caveat in "Payroll-quiet
  windows" below).
- **Task 3** — the whole coordinator surface (`coordinator.js`, `coordinator/index.html`). It writes
  only to `attendance_time_edit`. **Build freely, but do not SHIP it before Task 4 is live** — a
  coordinator filing proposals into a queue nobody can approve is worse than no feature.
- **Task 9** — the `home.js` count badge (read-only select on `attendance_time_edit`).
- **Task 10** — the cutoff-day Telegram reminder (pure server-side SQL + cron).

Everything else in the plan is payroll code by definition: the approval apply path *is* the payroll
engine.

---

## Payroll-quiet windows — FLAGGED

Do these only when the owner is not running payroll and no payslip is being printed.

1. **Task 1 (SQL migration).** The DDL itself is additive and safe, but it ends with
   `notify pgrst, 'reload schema';`, which bounces the PostgREST schema cache. A `saveTimes()` insert
   landing in that instant can fail. It also adds columns to `attendance_edit_audit`, the table
   `saveTimes` logs to **before** it writes punches — a log failure aborts the write by design, so a
   mid-run migration can abort a live correction. **Run it when nobody is editing times.**
2. **Task 2 (`saveTimes` → `applyPunchEdit` refactor).** This is surgery on the owner's live
   D-correction mechanism. Behaviour must be identical; the owner's own Edit-times flow must be
   exercised *before* the refactor (to record what "unchanged" looks like) and again after.
   **Not on a cutoff day.**
3. **Any deploy of `payroll/index.html`** (Tasks 2, 4, 5, 6, 7, 8, 11). GitHub Pages + browser cache
   mean a mid-run reload can serve half-old code. Deploy after a payroll run completes, never during.
4. **Task 5's first live bulk approve** rewrites real punches and re-runs `runPayroll()`. Do it on the
   walkthrough day with the owner watching, not unattended.
5. **Task 10's cron** fires Friday morning by default — i.e. **on cutoff day, into the AWOL group**.
   Schedule it only after the send-once guard is verified; a double-send on cutoff day is the same
   failure class as the vale double-post.

---

## Build status (2026-08-04, branch `coordinator-time-correction`, NOTHING PUSHED)

| Task | State |
|---|---|
| 1 — SQL migration | **APPLIED AND VERIFIED IN PRODUCTION 2026-08-05.** STEP 9 passed 7/7 twice, in separate tabs. Both tables exist and are empty, the five audit columns are live, RSR 0025 is the sole time editor. **GATE A PASSED** |
| 2 — `saveTimes` → `applyPunchEdit` | **built. GATE B PASSED** — deployed `main` and this branch produce identical figures for Jul 25–30: net payout ₱112,466 · Elias Entero ₱3,250.00 · OT ₱15,555 · headcount 34 · missing punches 3 |
| 3 — coordinator surface | **built** |
| 4 — Time approvals tab | **built** — queue, approve / correct & approve / reject with presets, conflict guard, empty state, Decided section |
| 5 — bulk day approve + lock | **built** — one date, log-first per item, shared `batch_id`, explicit partial-failure report, "Close day" |
| 6 — missing-punch section | **built** — `weekMissingPunches()`, beneath the queue. Rowless men remain deliberately out of scope with the binding AWOL-detector constraint recorded in the code comment |
| 7 — pending + unclosed banner | **built** — `weekOutstanding()` is the single definition of outstanding; both halves independent; refreshed on the existing `_live` tick, no second timer |
| 8 — Past-edits panel extension | **built** — coordinator-sourced rows name who proposed them; owner-direct rows render exactly as before. Decided section was already built |
| 9 — `home.js` badge | **built** — read-only pending count on the Payroll tile, deep-linking to `../payroll/?tab=appr`. Appears only when non-zero |
| 10 — Telegram reminder | **written, NOT RUN.** `coordinator-time-reminder.sql` + its rollback. STEP 8 (the cron) is deliberately separated and must not run until STEP 7's forced-guard test passes |
| 11 — validate/stamp/preflight | payroll `v2026-08-04a`, `home.js` `v2026-08-05a`, coordinator `v2026-08-04c` — all four `preflight.html` EXPECT entries in lockstep |

**GATE C PASSED (2026-08-05).** Proposal id 1 approved; audit row 748 carries
`source='coordinator-approved'`, `filed_by_code='RSR 0025'`, `edit_id=1`, `batch_id` null; and
`attendance_day_lock` stayed empty on the individual approve — confirming §9/Q1, that an individual
approve freezes only that worker-day.

**Remaining before push:** a second localhost walkthrough covering Tasks 8/9/10 (the badge, the
extended Past-edits line, and the reminder's forced-guard test), then the owner's explicit "push".
Task 10's SQL is run separately by the owner and is not part of the deploy.

## Build sequence

### Task 1 — SQL migration (no payroll code)

**Files:** create `coordinator-time-correction.sql`.

**Produces (names later tasks depend on):** table `attendance_time_edit` (columns exactly per spec
§3.1, `status` in `pending|approved|rejected|superseded`, unique partial index on
**`(employee_code, att_date_iso(date)) where status='pending'`** — keyed on the ISO-NORMALISED
date, not the raw mixed-format column, or a spelling difference walks straight past the
one-proposal-per-worker-day guarantee); immutable helper `att_date_iso(text)`; **BEFORE UPDATE
trigger `attendance_time_edit_freeze_trg`** — a row whose `old.status` is not `pending` can never
be updated again, so Task 4's approve/reject moves a row out of pending exactly once and Task 5's
bulk retry is forced to skip already-approved items by the database rather than by client
bookkeeping; **BEFORE UPDATE trigger `attendance_time_edit_touch_trg`** owning `updated_at` (no
client may set it); table `attendance_day_lock` (`date` text PK,
`locked_at`, `locked_by_code`, `locked_by_name`); additive nullable columns on
`attendance_edit_audit`: `source`, `filed_by_code`, `filed_by_name`, `edit_id`, `batch_id`; flag
`employees.is_time_editor`; RPC `time_editor_for_pin(p_pin text) returns jsonb` → `{ok:true,code,name}`
or `{ok:false}`.

- [ ] Read `awol-reinstate-flow.sql` (`awol_clerk_for_pin` at :224, its throttle table, the RSR0025
      seed at :405) and `named-issuer-access.sql` — copy the structure, do not invent a new one.
- [ ] Write the file: idempotent (`if not exists` / `create or replace`), `--` comments only, leading
      with `select current_database();` and the canary `select count(*) from public.attendance_records;`.
- [ ] `time_editor_for_pin`: keyed on `is_time_editor` **only** (never `is_issuer`, never
      `is_awol_clerk`); own single-row global fail-closed throttle (10 fails → 15-min lock, locked
      state indistinguishable from a wrong PIN); `security definer`, `set search_path = public`,
      granted to `anon, authenticated`; returns no PIN and no reason.
- [ ] Seed `is_time_editor` for normalized code `RSR0025` **only**. Alvin (RSR 0005) and Ritchie
      (RSR 0023) are explicitly NOT seeded (owner, Q6).
- [ ] End with `notify pgrst, 'reload schema';` and a verification block that re-queries every new
      object.
- [ ] Hand the complete file to the owner with the tab-closing instructions. **Payroll-quiet window.**
- [ ] **Verify live, independently:** re-query each new table, the new columns, and call
      `time_editor_for_pin` with a wrong PIN (expect `{ok:false}`) and with Jamaica's (expect her name).
      Re-open a fresh editor tab and re-verify — a 2026-07-31 install once vanished from both projects.
- [ ] Commit the SQL file.

**Gate:** no client code names any new column until this verification passes.

---

### Task 2 — Refactor `saveTimes` → `applyPunchEdit` (payroll code, behaviour-neutral)

**Files:** modify `payroll/index.html` (`saveTimes` 1322 and its callers).

**Produces:** one internal function `applyPunchEdit(rows, {reason, actor, source, filedBy, editId, batchId})`
doing, in order: (1) diff before→after per day, drop unchanged days; (2) **log first** into
`attendance_edit_audit` — a failed log aborts before any punch write; (3) update/upsert
`attendance_records` with `onConflict:'employee_code,date'`; (4) `runPayroll()` recompute.
Consumed by Tasks 4 and 5.

- [ ] Before touching anything: have the owner run one real Edit-times correction on localhost and
      record exactly what happens (modal, required reason, passcode via `openConfirm` 1586, Past-edits
      row). This is the behaviour contract.
- [ ] Extract the body of `saveTimes` into `applyPunchEdit`; `saveTimes` becomes a thin caller with
      `actor:'owner'`, `source:'owner-direct'`, `filedBy:null`.
- [ ] Confirm the existing append-only trigger on `attendance_edit_audit` still accepts the insert
      with the new nullable columns present.
- [ ] Validate: extract the largest inline `<script>` and `node --check` it as an ES module.
- [ ] Re-run the owner's recorded flow on localhost. **Identical output, or the refactor is wrong.**
- [ ] Commit. **Do not push yet** — no user-visible change, but it is the live pay path; it rides with
      the walkthrough gate.

**FLAG: payroll-quiet window. Never on a cutoff day.**

---

### Task 3 — Coordinator surface (NO payroll code)

**Files:** modify `coordinator.js` (tile in `App()` 1951, new component near `AwolLetters` 1847),
`coordinator/index.html` (line 69 cache-buster).

**Consumes:** `attendance_time_edit`, `attendance_day_lock`, `time_editor_for_pin` (Task 1).

- [ ] Tile on the landing grid: "🕒 Time correction — fix or fill missing clock times · admin approves".
- [ ] Date picker + step across the pay week; payroll-like table, one row per worker, six punch cells
      (`Time In · Lunch Out · Lunch In · PM Out · PM In · Time Out`), 24-hour entry, same formatting
      rules as Edit-times.
- [ ] Fetch using the enumerated-spellings `.in()` + `toISO()` pattern (`getAttendance` 188 is the
      reference). Bound to the loaded window — never unbounded.
- [ ] Show worked **hours** per day. **Never fetch a rate column.**
- [ ] "Add a missing day" → pending row with `attendance_id = NULL`.
- [ ] Required Reason per submission; blank blocks submit.
- [ ] Reachable window — **Q7 AMENDED by the owner 2026-08-04 to option (b): a week closes to her the
      moment it is PAID.** The original answer (current week + previous week until Friday's cutoff)
      had a hole: because "previous week" rolls forward with the calendar, the week paid on Saturday
      re-opened to her the following Sunday, which contradicts the spec's own "an already-paid week
      is a pay-adjustment matter" rule. (b) closes it.
      **The window is therefore exactly `payWeek(0)` — the same week payroll's "This week" button
      loads, one shared definition so the two screens can never disagree.** She keeps payday
      Saturday (payroll's week reference is *yesterday*, so the week being paid that morning is
      still "this week"), which is when a last error actually surfaces; it closes at the Sunday roll.
      Dates outside the window are **not offered**, and landing on one shows, by name, the other
      door: *"This week is already paid. Report it to the admin — it is fixed as a pay adjustment,
      not a time edit."*
- [ ] Submit → PIN prompt → `time_editor_for_pin` → on `ok:true` upsert the pending row(s) with her
      code and name; confirmation reads back *"Sent to the admin — filed by Jamaica L. Batucan"*.
      Re-editing the same worker-day before approval **updates** the open pending row.
- [ ] Per-row state chips: `— · PENDING · APPROVED · REJECTED (reason) · LOCKED (approved day, admin only)`.
      A locked day reads *"Approved and locked. Ask the admin for any further change."*
- [ ] Verify by grep that this component writes no punch column of `attendance_records`.
- [ ] Validate: `node --check coordinator.js`; hygiene grep.
- [ ] Commit. **Do not push before Task 4 is ready** — proposals with no approver is a worse state
      than no feature.

---

### Task 4 — "Time approvals" tab: the queue (payroll code)

**Files:** modify `payroll/index.html` (tab row 144–148 + new panel).

**Consumes:** `applyPunchEdit` (Task 2), `attendance_time_edit` (Task 1).

- [ ] New tab button beside Run Payroll / Today / Cash Advances / Settings, wired through the existing
      `tab()` handler.
- [ ] Per item, the two stacked rows of spec §6: ORIGINAL / EDITED, unchanged cells dim, changed cells
      highlighted, blanks rendered `—` and never as empty space; header line carries
      *filed by <name> · <time>*; the reason underneath.
- [ ] **Approve** → passcode (`openConfirm` 1586) → `applyPunchEdit` with `source='coordinator-approved'`.
- [ ] **Correct & approve** → cells editable inline → `source='admin-corrected'`, `applied` records
      what actually landed, item **excluded from any bulk action**.
- [ ] **Reject** → `decision_note` required, offered as four preset buttons — `He was on approved
      leave` · `Punch is correct as recorded` · `Wrong worker` · `Wrong date` — plus free text. A
      tapped preset **is** the note, stored verbatim as that sentence (never a code). A preset may be
      tapped then edited. Bare reject (no preset, no text) keeps the button disabled. Nothing touches
      `attendance_records`.
- [ ] **Conflict guard:** at approve time re-read the current `attendance_records` row and compare to
      the edit's `before`. Any drifted punch field → mark **CONFLICT — the kiosk sent a punch after
      this was filed**, show a third `NOW` row, remove from the bulk set, handle individually. Never
      overwrite a real punch with a stale proposal.
- [ ] Empty state for a day with no edits: *"No time corrections filed for <date>. Payroll will use
      the kiosk times as recorded."* — no worker list, no empty rows, no lock written.
- [ ] Individual approve writes the worker-day lock only — **not** the whole day (owner, Q1).
- [ ] Validate (`node --check` on the extracted inline script) + hygiene grep. Commit.

**FLAG: payroll-quiet window for any localhost run that approves a real row.**

---

### Task 5 — Bulk day approve + day lock (payroll code)

**Files:** modify `payroll/index.html`.

- [ ] Single-date scope only. No multi-day approve, no "approve everything pending".
- [ ] `Approve remaining (N)` → confirmation naming the date and the counts
      (*"11 will be approved · 4 excluded (2 rejected, 1 corrected & approved, 1 conflict)"*) → one
      passcode entry for the batch.
- [ ] Apply item-by-item, **log-first per item**: its own `attendance_edit_audit` row carrying
      `employee_code`, `date`, per-field changes, `reason`, `actor`, `filed_by_*`, `edit_id`, and a
      shared `batch_id`; then its punch write; then the next item. Bulk is a UI convenience, never one
      lumped log entry.
- [ ] **Partial failure is explicit:** stop on the first failing item and report *"Applied 7 of 11.
      Items 8–11 are still pending — retry."* Re-running skips already-approved items.
- [ ] Successful bulk approve, and an explicit **"Close day"** button, both write `attendance_day_lock`
      for the whole date.
- [ ] Validate + commit.

**FLAG: the first live bulk approve happens on the walkthrough day, with the owner watching.**

---

### Task 6 — "Missing punches with no correction filed" section (payroll code)

**Files:** modify `payroll/index.html` (approvals tab, beneath the queue).

- [ ] Header: *"⚠ Missing punches with no correction filed (N) — these are not in the queue; nobody
      has proposed a fix."*
- [ ] Contents for the **currently loaded pay week**, excluding any worker-day with a pending or
      approved edit: rows where `is_incomplete` is true; rows with a `timein` and no `timeout` (or a
      half-open lunch/PM session); rows `prSessions` (413) hard-flags — the ₱0 days.
- [ ] Each entry gets one **Fix now** button opening the existing Edit-times modal (`editTimes` 1180)
      on that worker-day — self-approved, logged `source='owner-direct'`.
- [ ] Carry the pointer line: *"A worker missing entirely? Use 'Pick a worker' on the Run Payroll tab."*
      (`populateWorkerPicker` 1184 / `openWorkerEdit` 1199).
- [ ] **Out of scope, deliberately (owner, Q3):** men with no row at all. When that is built later it
      MUST call the AWOL detector's existing never-punched logic — never define "absent" a second time.
      Note this in the section's code comment so the next build finds it.
- [ ] Validate + commit.

---

### Task 7 — Pending + unclosed banner on Run Payroll (payroll code)

**Files:** modify `payroll/index.html` (above the results, refreshed by the `_live` poll 1445).

- [ ] Half one — pending items: count `attendance_time_edit where status='pending'` inside
      `curFrom`/`curTo` (814), filtered client-side by `toISO()`, never a range filter on the TEXT date.
- [ ] Half two — **unclosed days**: any working date in the loaded pay week that HAS coordinator
      activity but NO `attendance_day_lock` row.
- [ ] Each half appears only when non-zero, and **half two must appear even when pending = 0** — that
      is the whole point of the owner's Q1 addition. No banner only when pending = 0 AND unclosed = 0.
- [ ] Refresh on the existing 30-second `_live` poll; do not add a second timer.
- [ ] Define "outstanding" once, in one place, and reuse it — Task 10's Telegram reminder must use the
      same definition so the banner and the message can never disagree.
- [ ] Validate + commit.

---

### Task 8 — Audit visibility (payroll code + coordinator read)

**Files:** modify `payroll/index.html` (`loadEditHistory` 1385 and the approvals tab).

- [ ] Extend the Past-edits panel to render the new columns, e.g. *"07/31/2026 — timeout: — → 17:04 ·
      'forgot to punch out' · filed by Jamaica L. Batucan (RSR 0025) · approved by owner · 08/01/2026
      7:14 AM · batch"*. Owner-direct rows keep rendering exactly as they do today.
- [ ] Add a **Decided** section (approved + rejected, most recent first) to the approvals tab.
- [ ] Confirm rejections are visible with their note to both admin and coordinator (they live only in
      `attendance_time_edit`; nothing was applied, so there is no audit row).
- [ ] Validate + commit.

---

### Task 9 — `home.js` pending badge (NO payroll code, optional)

**Files:** modify `home.js`.

- [ ] Read-only count of pending edits, linking to the payroll Time-approvals tab. No pay logic, no
      punch writes, nothing duplicated.
- [ ] `node --check home.js`; hygiene grep. Commit.

---

### Task 10 — Cutoff-day Telegram reminder (NO payroll code, NO client code)

**Files:** create `coordinator-time-reminder.sql`.

- [ ] Model it on `kiosk-alerts.sql` (`kiosk_alert_send` :60, revoked from public/anon :74) and
      `kiosk-sweep-report.sql` (`cron.schedule` :266). Send to **`tg_awol_group`** (same group as the
      AWOL log; `home.js:41` / `coordinator.js:297` show the setting and its manager-DM fallback).
- [ ] Fire **only if** something is genuinely outstanding: anything still `pending` **OR** any day
      unclosed — the same two conditions as the Task 7 banner. Silence means clean.
- [ ] **Explicitly NOT** a per-filing message (owner, Q4 rejects option (b)). One reminder, cutoff day.
- [ ] **Send-once guard keyed to the cutoff date**, in its own table, so re-running or re-opening
      payroll cannot fire it twice — same failure class as the vale double-post.
- [ ] Default schedule Friday morning Manila; remember pg_cron schedules in **UTC** (Manila − 8h), as
      the comments in `kiosk-heartbeat-snapshot.sql:226` spell out. Owner may retune the time later.
- [ ] Owner runs it (two-project rule). **Verify independently:** force the guard and confirm the
      second call sends nothing. Commit.

**FLAG: schedule the cron only after the guard is verified. It fires on cutoff day into a live group.**

---

### Task 11 — Validate, stamp, preflight (payroll code)

**Files:** `payroll/index.html:141`, `preflight.html:45`, `coordinator/index.html:69`.

- [ ] Extract the largest inline `<script>` from `payroll/index.html`; `node --check` as an ES module.
- [ ] `node --check coordinator.js`; `node --check home.js`.
- [ ] Hygiene grep both ways on every changed file.
- [ ] Run `tests/kiosk-stress/` — Task 2 touched the shared punch-write path.
- [ ] Bump `payroll/index.html` stamp from `v2026-07-25a` to the new build stamp **and**
      `preflight.html` `EXPECT['payroll/index.html']` in the same commit. Lockstep, always.
- [ ] Bump the `coordinator.js?v=` cache-buster from `2026-08-04b`.
- [ ] Commit.

---

## Gates

**GATE A — after Task 1.** SQL verified live by independent re-query, in a fresh tab. No client code
names a new column before this passes.

**GATE B — after Task 2.** The owner's existing Edit-times/D-correction flow behaves identically
before and after the refactor. If anything differs, stop.

**GATE C — the owner's localhost walkthrough, after Tasks 2–9 and 11 are complete and validated.**
This is the hard one. Both surfaces are interactive and pay-adjacent, so the deploy rule applies with
no exceptions and no ambiguous go: **nothing pushes to `main` until the owner says push, after the
walkthrough.** Run it on localhost with both surfaces open. Cover, from spec §14:

- [ ] File an edit as Jamaica — her PIN, her *name* on the queue item.
- [ ] Wrong PIN refused (and the throttle's locked state is indistinguishable from a wrong PIN).
- [ ] Approve one · correct-and-approve one · reject one (preset tap, and a bare reject stays blocked).
- [ ] Bulk approve a day with exclusions; the counts in the dialog match what actually happens.
- [ ] A bulk-approved item and an individually-approved item look identical in Past edits apart from
      the batch marker.
- [ ] A day with no edits reads as "nothing to approve".
- [ ] The missing-punch section finds a real half-open day.
- [ ] The payroll banner counts correctly, shows the unclosed-days half with pending = 0, and
      disappears only at zero-and-zero.
- [ ] A locked day refuses coordinator edits; an individually-approved worker freezes alone while the
      rest of that day stays editable.
- [ ] Payroll totals before/after an approval move exactly as expected.
- [ ] Conflict guard: file an edit, let a kiosk punch land on the same worker-day, confirm the item
      shows CONFLICT with a NOW row and leaves the bulk set.

**GATE D — after push.** Verify the live stamps with a cache-busted fetch; tablets need `reset.html`.
Tell the owner immediately what went live: exact commit + files.

**After Gate C:** small follow-ups to this now-reviewed feature — wording, preset text, the reminder's
send time, view definitions the owner re-runs anyway — may push without a fresh walkthrough, but the
owner is told immediately what went live. Anything that changes what a screen *does* goes back to
Gate C.

---

## Risks and residuals (stated, not fixed here)

- `employees.pin` is plaintext and compared directly, same as `issuer_for_pin` and
  `awol_clerk_for_pin`. This feature inherits it; hardening the employee-PIN store is its own job
  across all three RPCs.
- No cross-item transaction exists over PostgREST, and moving the apply into a PL/pgSQL RPC would
  mean a second pay engine — ruled out. Partial bulk failure is therefore handled by explicit
  reporting, not rollback.
- Adding a second time editor later is a **flag flip, not a build**: one `update employees set
  is_time_editor = true …`. No code, no deploy, no stamp, no walkthrough. Cover for Jamaica being out
  sick is a one-line statement on the day.
- Spec §8's "man with no row at all" case is deliberately unbuilt and carries a binding constraint on
  whoever builds it (must call the AWOL detector's logic, not redefine "absent").
