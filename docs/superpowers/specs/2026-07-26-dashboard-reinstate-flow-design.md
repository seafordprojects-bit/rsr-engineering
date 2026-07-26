# Dashboard Reinstate Flow — two-role gate, PEM exemption, manual re-suspension (2026-07-26)

## Status
Designed + approved by the owner 2026-07-26 (Part 1 and Part 2 both walked through and approved in
conversation). Supersedes decision 3 of [`2026-07-24-awol-suspension-flow-design.md`](2026-07-24-awol-suspension-flow-design.md)
("Reinstatement UI stays as-is — no new control on the RSR Admin dashboard"). Every other decision in
that spec still stands.

Touches three interactive surfaces (kiosk, RSR Admin dashboard, coordinator page) and is punch-blocking
→ **full localhost walkthrough gate before any push to `main`.**

## Owner decisions locked
1. **Two steps, two roles.** Jamaica marks *letter received* with her own per-person PIN; the owner gives
   final approval with the admin PIN. A worker can punch only after **both**.
2. **Leave-approval auto-cancel: KEEP.** An absence later covered by an *Approved* leave means the
   suspension was issued in error — the system clears it by itself, with no letter and no two-step. It is
   logged as **CANCELLED — leave approved**, never as a reinstatement, so the two are always
   distinguishable in the AWOL group and in the audit trail.
3. **The dashboard is the only door.** The kiosk Admin ▸ Staff one-tap "✅ Reinstate" button and the
   Telegram reinstate/reject buttons are **removed**. The kiosk keeps the 🚫 Suspended badge (read-only,
   with the line "Reinstate on the RSR Admin dashboard") so the yard can still see status.
4. **Step 1 lives on the coordinator page**, step 2 on the RSR Admin dashboard. Neither passcode changes,
   and the admin dashboard's front door stays admin-only.
5. **Two admin outcomes: Approve or Keep suspended.** No Terminate (out of scope — it reaches into
   employment and payroll and would be its own build). "Keep suspended" clears the letter tick, returning
   the case to Jamaica's list; the case never expires on its own.
6. **The admin PIN is asked on every single approval** — it is the signature, not a session unlock.
7. **No Undo on the letter tick.** A tick or an approval made in error is corrected by issuing a fresh
   suspension (see *Manual re-suspension*), which leaves both the mistake and the correction in the log.
8. **Only Jamaica L. Batucan (RSR 0025) may tick letter-received.** Her per-person PIN alone — not the
   shared assistant passcode, not Alvin's (RSR 0005) or Ritchie's (RSR 0023) issuer PINs. The tick records
   her name. **Fallback:** the owner can perform the tick from the dashboard with the admin PIN, recorded
   as `Admin — <name>` so the log always shows who really ticked. Admin approval stays the owner's alone.
9. **PAKYAW/PEM workers are exempt from AWOL entirely.** Piece-rate/casual — irregular attendance is
   normal. Never suspended, never alerted on, no letter, and no pending-leave HOLD note. Skipped
   completely.
10. **Manual suspension from the dashboard**, including a re-suspension mode that carries an
    already-filed letter forward.

## What already exists (reused, not rebuilt)
- `employee_suspensions` (one row per employee, `active` flag) + `awol_set_suspended` / `awol_reinstate`
  RPCs — from the 07-24 build, live.
- Kiosk detection `checkAllAbsences()` / `collectAbsentDates()` / `isAbsentOnDate()`, Sunday-transparent
  as of commits `98104fd` / `7c07737`.
- Kiosk suspension **read-cache + poller** off `employee_suspensions where active=true`, plus the live
  point-check at PIN entry. **This is why the dashboard needs no new kiosk push mechanism**: an approval
  lifts the block at both yards within one poll interval, and immediately at the next punch attempt.
- `admin_verify_passcode` (server-side bcrypt, global fail-closed throttle) — used by both the kiosk admin
  gate and `home.js`.
- `issuer_for_pin` + `is_issuer` — the proven per-person-PIN pattern this build mirrors.
- `awol-letter.html` — the standalone A4 printable letter, filled from URL params.
- `coordinator.js` already has a Telegram sender (`notifyTg`, ~line 234). `home.js` does **not** — it
  reads/writes Telegram settings only.

## PAKYAW/PEM identification — verified against live data
**The employee code prefix is the marker, and it is the only marker in the data.**

- `coordinator.js:281` — `const [empType, setEmpType] = useState('RSR'); // RSR = regular, PEM = pakyaw`;
  line 334 renders `<option value="PEM">Pakyaw (PEM)</option>`. The prefix is chosen deliberately when a
  worker is created, not a naming habit.
- Every other column was checked against the live roster and distinguishes nothing: `dept` is `"—"` for
  42 of 43 rows (one `"CEO"`), `position` for PEM workers is Fitter/Welder — identical to regulars — and
  `shift` is 8 for everyone. There is no pakyaw flag today, and this build does not add one: the prefix is
  already authoritative and already owner-controlled at creation time.
- Current PEM roster: **PEM 0001 Julius, PEM 0002 Jembo, PEM 0003 Warren, PEM 0004 Erwin, PEM 0005
  Melvin** — all ₱500/day, all Carmen.

**Test:** `/^PEM/i` on the trimmed code — case-insensitive and space-tolerant, so live `PEM 0001` and the
harness's `PEM9001` both match.

**Placement:** the very first check in `checkAllAbsences()`, before the absence chain is computed — so no
suspension, no alert, no letter URL, no HOLD note. **Also enforced server-side** in `awol_set_suspended`
and `awol_manual_suspend`, so no path (manual action, stale screen, replayed request) can suspend a PEM
worker.

### Required harness repair (not optional)
The owner's locked false-positive regression `G8c` (`tests/kiosk-stress/kiosk-stress.mjs` ~line 1110) is
written against **PEM9001**. Once PEM is exempt, that scenario would still pass — but for the wrong
reason: the exemption fires first and the Sunday rest-day logic never executes, silently gutting the guard.
**G8c is re-pointed to an RSR code** so it keeps testing what it was written to test, and the PEM
exemption becomes its own separate scenario. The replacement code must be one **not already used by G8
cases A and B** (`RSR0100`, `RSR0207`): each case re-filters the `employees` array from the shared
`window.__g8Roster` snapshot, so reusing a sibling case's code would cross-contaminate the seeded records.

## Design

### Data model
**`employee_suspensions` — additive columns only** (nothing existing changes meaning):

| column | purpose |
|---|---|
| `letter_received boolean not null default false` | step 1 done |
| `letter_received_by text` | `Jamaica L. Batucan` or `Admin — <name>` |
| `letter_received_at timestamptz` | |
| `last_decision text` | `approved` \| `kept` |
| `last_decision_by text`, `last_decision_at timestamptz` | step 2 audit |
| `manual boolean not null default false` | suspension created by hand, not by detection |
| `ref_note text` | e.g. `re-suspension, ref: case of 07/26/2026 — letter already on file` |

**New `public.awol_events` — append-only audit log.** `id bigserial pk, employee_code text,
event text, actor text, note text, at timestamptz not null default now()`, indexed on
`(employee_code, at desc)`. Events: `suspended`, `suspended_manual`, `letter_received`, `reinstated`,
`kept_suspended`, `cancelled_leave_approved`.

*Why:* the suspension row is reused on every cycle, so without this a repeat offender's history is
overwritten. This table feeds "Recently closed" and is the permanent trail.

**New `employees.is_awol_clerk boolean not null default false`** — seeded `true` for **RSR 0025 only**.
Deliberately **not** `is_issuer`, because Alvin and Ritchie carry that flag and must be refused.

**Untouched:** `attendance_records` (no schema change, no pay math). The legacy `employees.is_suspended`
column (currently `false` for all 43 rows, unused — real state lives in `employee_suspensions`) is left
exactly as-is.

### RPCs (security definer, granted to anon per the project's RLS-disabled convention)
- **`awol_clerk_for_pin(p_pin text) → jsonb`** — `{code, name}` when the PIN belongs to an employee with
  `is_awol_clerk = true`, else `null`. Never returns a PIN. Mirrors the global fail-closed throttle used by
  `admin_verify_passcode` (repeated failures lock the check for 15 minutes) since this is an anon-callable
  endpoint over a 6-digit keyspace.
- **`awol_letter_received(p_code text, p_by text) → jsonb`** — requires an **active** row; sets
  `letter_received = true` + `by`/`at`; logs `letter_received`. Idempotent: `{newly:false}` if already
  ticked, so a double-tap posts one Telegram message.
- **`awol_admin_decide(p_code text, p_by text, p_decision text) → jsonb`** —
  - `approve`: **refuses unless `active = true` AND `letter_received = true`** (this is where the two-step
    gate actually lives — a stale screen or a replayed request cannot slip past it). Sets `active = false`,
    `reinstated_by/on`, `last_decision = 'approved'`; returns `{newly:true, awol_group_msg_id,
    awol_group_chat}` for the original-alert edit. Logs `reinstated`.
  - `keep`: requires `active = true`; sets `letter_received = false`, `last_decision = 'kept'`; row stays
    active. Logs `kept_suspended`.
  - Ineligible calls return `{newly:false, reason:'…'}` so the UI can say why.
- **`awol_manual_suspend(p_code text, p_by text, p_reason text, p_dates jsonb, p_ref_note text,
  p_letter_on_file boolean) → jsonb`** — refuses PEM codes; refuses if a row is already active; sets
  `active = true`, `manual = true`, `suspended_on = today`, `absent_dates = p_dates`,
  `letter_received = p_letter_on_file`, `ref_note`. Returns `{newly:true}` once (dedup). Logs
  `suspended_manual`.
- **`awol_set_suspended`** (existing) — gains the server-side PEM refusal; otherwise unchanged.
- **`awol_reinstate`** (existing) — now reached **only** by the leave-approval auto-cancel path. Logs
  `cancelled_leave_approved`.

### Coordinator page — "AWOL — letters" (step 1)
A new card alongside Personnel / Leave / Duty:

- **① Waiting for the letter** — active cases with `letter_received = false`. Each shows name, code, yard,
  the exact absent dates, days suspended, and an **Open / print letter** link (the same `awol-letter.html`
  URL, so a lost letter can be reprinted).
  **Tap "Letter received" → a PIN box → `awol_clerk_for_pin` → `awol_letter_received(code, name)`.** Only
  Jamaica's PIN is accepted; the refusal message is neutral ("This PIN is not authorised for the AWOL
  letter step").
- **② Waiting for the boss** — read-only list of ticked cases, so a worker can be told where his case
  stands. **No Undo** (owner decision 7).

The page can never unblock anyone. The tick alone changes nothing at the kiosk.

### RSR Admin dashboard — "AWOL — suspensions" (step 2)
Ordered so the ones needing the owner sit on top:

- **① Needs your decision** — `active = true AND letter_received = true`. Shows name, code, yard, absent
  dates, date suspended, who ticked the letter and when, `ref_note` if present, and the letter link.
  - **✅ Approve — worker can punch** → admin PIN (`admin_verify_passcode`, **every time**) →
    `awol_admin_decide(code, actor, 'approve')`. Block lifts at both yards within one kiosk poll.
  - **⛔ Keep suspended** → admin PIN → `awol_admin_decide(code, actor, 'keep')`. Stays blocked; the tick
    is cleared and the case returns to Jamaica's list ①.
- **② Waiting for the letter** — read-only, showing who is outstanding and for how many days. **No Approve
  button exists here at all**, and the RPC would refuse it anyway. Carries the owner's fallback
  **"Tick letter received (admin)"** → admin PIN → `awol_letter_received(code, 'Admin — <name>')`.
- **③ Recently closed** — last 10 from `awol_events`: how each ended (approved / kept / cancelled by
  leave), who decided, when. Each closed entry carries **"Re-suspend (letter on file)"** (below).

**Actor name** = `localStorage.rsr_prepared_by` when set, else `Admin`.

### Manual suspension + re-suspension (dashboard)
- **"Re-suspend (letter on file)"** on a closed case → admin PIN → `awol_manual_suspend(..., p_ref_note =
  'manual re-suspension, ref: case of <suspended_on> — letter already on file',
  p_letter_on_file = true)`. The worker is blocked again immediately and the case lands **straight in
  "Needs your decision"** — no new letter, no second tick. This is the wrong-approval recovery path.
- **"Suspend someone manually"** → pick an employee (**PEM workers are not listed**), type the reason,
  set the dates → `p_letter_on_file = false` → lands in **"Waiting for the letter"**, normal flow.

At least one absent date is **required** on both manual paths — the dates are what the printable letter is
built from, so an empty list would produce a letter with a blank absence section for the worker to sign.

### Telegram — the AWOL group log
| When | Message |
|---|---|
| Suspended (detection) | 🚨 **AWOL — Account Suspended** · 👤 name (code) · 🏢 yard · 📅 absent dates · 📄 printable letter link *(unchanged)* |
| Suspended (manual) | 🚨 **AWOL — Suspended (manual)** · … · Reason: … — and for a re-suspension: `↩️ Manual re-suspension — ref: case of <date>, letter already on file (no new letter needed).` |
| Letter ticked | 📄 **Letter received** — name (code) — confirmed by **[Jamaica / Admin — name]** · waiting for admin approval |
| Approved | ✅ **REINSTATED** — name (code) — approved by [admin] on [date]; the original 🚨 alert is edited to **✅ RESOLVED** |
| Kept suspended | ⛔ **Kept suspended** — name (code) — decided by [admin] on [date] · letter step reset |
| Leave approved | ↩️ **CANCELLED — leave approved** — name (code); the original alert is edited to **↩️ CANCELLED** |

The acting page posts its own message (immediate and unambiguous about who acted). `coordinator.js`
extends its existing `notifyTg` to target `tg_awol_group` with the `mgr_ids` fallback; `home.js` gains a
matching ~12-line sender. No new token exposure — `settings.tg_token` is already anon-readable and both
pages already read `settings` (tracked separately as [[migrate-punch-notifications-serverside]]).

### Kiosk changes
- **PEM skip** at the top of `checkAllAbsences()` (see above).
- **Reinstate button removed** from `renderRoster` (~line 4794). Badge stays, plus the line
  "Reinstate on the RSR Admin dashboard".
- **Telegram `reqType === 'reinstate'` callback branch removed** (~line 4326) — approve and reject both.
- **`reinstateEmployee()` kept**, now reached only from the leave-approval path (~line 4104); its message
  becomes **CANCELLED — leave approved** and it edits the original alert to ↩️ CANCELLED.
- **Bisaya block modal text updated** (owner-approved verbatim):
  > **GI-SUSPEND ANG IMONG ACCOUNT**
  > Absent ka og 3+ ka adlaw nga sunod-sunod nga walay approved nga leave.
  > Kuhaa ug sulati ang AWOL letter, ihatag sa coordinator, dayon hulaton ang approval sa admin una ka
  > maka-punch.
- Version stamp bumped; `preflight.html` EXPECT updated in lockstep.

## Harness scenarios (permanent, `tests/kiosk-stress`)
1. **PEM worker absent 5+ working days → never suspended** *(owner-requested)*: no row in
   `mock.suspensions`, no alert composed, no letter URL, no HOLD note, zero Telegram sends.
2. Both spellings exempt — live-style `PEM 0001` (with space) and harness `PEM9001`.
3. **G8c re-pointed to an RSR code** — the Sunday rest-day guard still exercises the absence chain and
   still asserts "2 real absences + transparent Sunday → not suspended".
4. `awol_admin_decide(..., 'approve')` **refused** when `letter_received = false`; accepted after the tick.
5. `awol_clerk_for_pin`: Jamaica's PIN → accepted; Alvin's (`is_issuer` true, clerk false) → refused;
   unknown PIN → refused; repeated failures → throttled.
6. **Keep suspended** clears the tick, the row stays active, and the worker is still blocked after the next
   kiosk poll.
7. **Manual re-suspension with letter on file** → lands directly in "needs decision" (`letter_received`
   true, `manual` true, `ref_note` set); manual PEM suspension → refused by the RPC.
8. Approve → the kiosk's next poll clears the block on **both** simulated kiosks; the original group alert
   is edited to RESOLVED using the stored msg id.
9. Leave-approval cancel still works and is logged as `cancelled_leave_approved`, not `reinstated`.
10. Regression: the kiosk Staff list shows the badge but exposes **no** reinstate control; the Telegram
    reinstate callback is inert; all existing suspend/alert/cross-kiosk/sweep/OT scenarios still pass.

## Migration + rollout
**One SQL file**, run once by the owner, in order:
1. **STEP 0 — census** (read-only; re-confirms the state below before anything is destroyed).
2. **STEP 1 — backup** the existing rows to `bak_employee_suspensions_20260726`.
3. **STEP 2 — delete** the 43 inactive test rows.
4. **STEP 3** — add the new `employee_suspensions` columns.
5. **STEP 4** — create `awol_events` (+ index).
6. **STEP 5** — create/replace the RPCs; add the PEM guard to `awol_set_suspended`.
7. **STEP 6** — add `employees.is_awol_clerk`; set `true` for `RSR 0025` only.
8. **STEP 7 — re-query** everything.

SQL uses `--` comments. The owner runs it; **the result is then re-verified independently via REST**
([[verify-db-cleanups-independently]]).

### Census taken 2026-07-26 (basis for STEP 2)
43 rows, **0 active**, 43 inactive, one row per employee — the whole roster. 42 are the pre-fix mass false
positive of 07-25 (`"Absent 7 consecutive days without approved leave"`, absent dates 2026-07-19 →
2026-07-25, all stamped `reinstated_by = 'walkthrough-cleanup'` on 2026-07-26); 1 is
`RSR 0000 "Walkthrough test (Raffy)"`. 21 carry Telegram message ids 5356–5376. **Deleting them blocks and
unblocks nobody.** The Telegram messages themselves are not deleted — they remain in the group history as
old RESOLVED entries.

## Walkthrough (localhost, before any push)
1. **Real-data detection check — gate item.** Point detection at the **actual** 2026-07-19 → 2026-07-25
   attendance and confirm it now suspends **zero** workers. Those 42 rows came from that exact week
   pre-fix; if anything in it still trips detection, it must be found here and not at 6am with 40 workers
   blocked at the kiosk. **Nothing ships until this reads zero.**
2. PEM worker with a long absence → no suspension, no alert, nothing in the group.
3. Suspend a test worker → alert + letter render → Jamaica's PIN ticks the letter (Alvin's PIN refused) →
   dashboard shows "Needs your decision" → **Keep suspended** → tick cleared, still blocked → tick again →
   **Approve** → block lifts on both simulated kiosks, group shows REINSTATED, original edited to RESOLVED.
4. Approve by mistake → **Re-suspend (letter on file)** → back in "Needs your decision" with the ref note.
5. Admin fallback tick with the admin PIN → recorded as `Admin — <name>`.
6. Leave-approval path → **CANCELLED — leave approved**, not a reinstatement.
7. Kiosk Staff list shows the badge and no reinstate button; Telegram buttons gone.
8. Version stamps verified live after push; tablets hard-reloaded through `reset.html`.

## Scope exclusions / known constraints
- **Payroll untouched.** Suspension is attendance-gating only.
- **No Terminate action** — deliberately out of scope (decision 5).
- **No letter photo archival** — still queued separately ([[awol-letter-photo-archival-queued]]); the
  interim remains replying to the AWOL-group alert with a photo.
- **Detection stays client-side** in the kiosk, as today. A server-side (pg_cron) detector remains a
  possible future move.
- **App-layer auth**, per the project's RLS-disabled convention: the RPCs are anon-granted and the gate is
  enforced *inside* the functions (approve refuses without the tick; PEM refused at both layers). The
  residual is the 6-digit numeric keyspace on `awol_clerk_for_pin`, mitigated by the same global
  fail-closed throttle as the admin gate — the same residual already accepted for
  [[harden-kiosk-admin-gate]].
- **Unblock latency** = one kiosk poll interval (seconds), plus the immediate online point-check at the
  punch attempt; offline kiosks use the last cache and reconcile on reconnect.

See [[awol-suspension-flow-spec]] (the build this extends), [[full-day-timein-gate-spec]] (still queued
behind it), [[harden-kiosk-admin-gate]] (the admin PIN this reuses), [[named-issuer-access]] (the
per-person PIN pattern `is_awol_clerk` mirrors), [[verify-db-cleanups-independently]],
[[sdd-gate-explicit-push]].
