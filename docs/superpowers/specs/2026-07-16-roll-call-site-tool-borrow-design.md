# Roll-call: site tagging, read-only coordinator view, tool borrowing — spec (2026-07-16)

**Extends** `2026-07-10-monitoring-front-restructure-design.md`. That spec's scope items 1–4
**shipped** in commit `919e147`; its "Current state" section was never updated and is stale.
This doc supersedes its section 4 and is the current source of truth for the roll-call phone.

Owner decisions are recorded verbatim in **Decisions taken**. Nothing here is built until the
owner approves this spec; the build then pauses for the owner's localhost walkthrough (they will
have the in-charge's phone on hand) before any push.

## Current state — VERIFIED 2026-07-16, not inherited from the old spec

- **The roll-call phone already exists and is gated.** `monitoring/roll-call.html:135-208` wraps the
  app in a `Gate` component: passcode from `settings.roll_call_pin`, one-time device registration via
  `settings.roll_call_device_id` + a per-device token in `localStorage['rsr_rollcall_device']`
  (`roll-call.html:128`). The first phone to enter the passcode claims the lock (`:171-175`); any other
  device gets "This phone isn't the roll-call device" (`:187`). Admin reset lives in `home.js:1518-1527`.
  → **Owner requirement 1 is already satisfied.** No new registration work; gap-check only.
- **The coordinator has its OWN separate passcode** (`coordinator.js:214`, "coordinator's own passcode,
  set by admin, stored in DB"). `coordinator/index.html` is a 70-line shell that loads `coordinator.js`.
  → The "distinct from coordinator" requirement is already met.
- **Roll-call has NO site handling whatsoever** — zero occurrences of `site` in `monitoring/roll-call.html`.
  `?site=` is genuinely new here.
- Roll-call writes: `job_checkpoint` (insert on tag `:287-290`, delete by id on untag `:274`),
  `job_pause` (`:318`), `job_progress` via `upsertJobProgress` (`:309`). **None carry a site column.**
- **Tool borrowing already exists** — in the **Tools module** (`tools/index.html`), NOT warehouse.
  Single table `borrow_issuance`, one row per tool unit, returns/repair/transfer flows included.
  Reached via the Issuance hub (`issuance/index.html:37`). `borrower-equipments/` is an orphaned
  legacy copy — nothing links to it; do not touch or revive it.
- **`borrow_issuance` is effectively unused in production: 1 row total, 0 rows with `status='out'`**
  (live count, 2026-07-16). Columns today: `id, txn_type, employee_id, item_id, unit_id, site_id,
  quantity, status, issued_by, received_by, project_vessel, notes, batch_id, borrowed_at, returned_at,
  return_condition, created_at, slip_no`. **There is no `source` column.**
  → This is the cheapest possible moment to add the double-issue rule: no historical data to clean up.
- Borrow already carries site as **`site_id` (uuid → shared `sites` table)**, written on every row
  (`tools/index.html:694`) and filtered on every read.
- **The shared `sites` table still holds stale legacy rows** (live, 2026-07-16):
  `A`/"Site A" and `B`/"Site B" alongside `CAR`/"Carmen" and `MAN`/"Mandaue". The inventory system owns
  this table; the attendance rename deliberately did not touch it (`site-rename-carmen-mandaue.sql:17`).
- **`monitoring/config.js:29` hardcodes `SITES = ["CAR","MAN"]`** and `jobs.site` stores the **code**
  (`CAR`), not the yard name — used for the `JOB-CAR-000001` control number.

## Decisions taken (owner, 2026-07-16)

1. **Yard mismatch → show only that yard's jobs.** The phone's `?site=` shortcut decides the yard.
2. **Block the second issuance of the same physical tool**, with a clear message showing who already
   has it out.
3. **Field issuance = roll-call passcode + the borrower's own passcode.**
4. **Slip numbering: refuse to issue when the server numbering call fails — no device-clock fallback.**
   Clear message with a retry. **Same behavior on the Tools page**, so both writers act alike.
5. **Verify `next_no` in Supabase is collision-safe** as planned (gate before relying on it).
6. **Tag pauses with the yard too**, same as roll-call entries.
7. **`SITES` hardcode in `config.js` → separate follow-up.** Leave the `JOB-CAR` prefix alone for now.

**The second writer is the existing Tools page** (`tools/index.html`, reached via Issuance → Tools —
the screen warehouse staff use), **not** the coordinator panel. `coordinator.js` does no tool
borrowing at all: it handles personnel, vessel schedules and liquidation, and its `nextNo` (`:97-101`)
mints liquidation numbers (`LPR-`/`LTR-`), not borrow slips. So the two writers of `borrow_issuance`
are **the roll-call phone (field) and the Tools page (office)**. No new borrow UI is added to the
coordinator panel — that would be the parallel system the owner ruled out.

Earlier, on naming: sites are **Carmen** and **Mandaue**; the seeded `settings.attendance_sites`
list is the source of truth. One phone covers both yards via two home-screen shortcuts
(`?site=Carmen`, `?site=Mandaue`).

**Message language (decided, flag at walkthrough).** `tools/index.html` is entirely English today
(zero Bisaya strings); the kiosk is Bisaya. Decision 4's *behavior* (refuse + retry) is identical on
both writers, but the copy follows each page's existing language: **Bisaya on the phone** (field, matches
the kiosk the same people already use), **English on the Tools page** (matches its own UI). Say so at
the walkthrough if you want Bisaya on the Tools page too.

## Scope

### 1. Roll-call entry stays exclusive to the registered phone
Already live. **No new work** beyond a gap-check during the walkthrough: confirm a second device is
still refused, and that admin reset re-opens registration for a phone replacement.

### 2. `?site=` on the roll-call phone
- Read `?site=` from the URL. Valid values come from **`settings.attendance_sites`** (currently
  `["Carmen","Mandaue"]`). **No hardcoded site list** — a new yard added to that array must work with
  no code change, exactly as the kiosk does.
- **Absent → refuse.** Full-page message, no entry UI, no default: *"Open this page from the Carmen or
  Mandaue home-screen shortcut."* (owner requirement 3 — never guess the yard.)
- **Present but not in the list → refuse** the same way, naming the unknown value. An unrecognised
  yard is a typo'd shortcut, not a new yard.
- Show the yard in the header, matching the kiosk's badge treatment.
- **Filter the job list to that yard** (decision 1). A Mandaue job is not on the list when the phone is
  opened as `?site=Carmen`, so a wrong-yard entry is impossible.
- **Tag every entry with the yard name** (`Carmen`/`Mandaue`).

**The code↔name bridge.** `jobs.site` stores the code (`CAR`); roll-call entries store the name
(`Carmen`), per the owner's naming rule. Both sides read their mapping from **data, never a
hardcoded map**: the yard list from `settings.attendance_sites`, and the code↔name pairing from the
shared `sites` table (`code`/`name` columns — read-only; the inventory system owns that table).
Ignore the stale `A`/`B` rows there by matching on the names present in `attendance_sites`.

### 3. Read-only roll-call view in the coordinator area
- A roll-call view in `coordinator.js` (behind the existing coordinator passcode) showing all entries
  filterable **by day / job / yard**.
- **No add/edit/delete controls, and no write calls in the page** — this is a double-check surface only.
- Verifiable, not just asserted: the reviewer greps the coordinator page for
  `insert|update|delete|upsert|rpc` against `job_checkpoint`/`job_pause`/`job_progress` and must find
  **zero**. This check goes in the plan as an explicit step.

### 4. Tool borrowing on the roll-call phone
- **Reuse `borrow_issuance` and the existing Tools flow. Do not build a parallel system** and do not
  revive `borrower-equipments/`. The phone surfaces the same flow in a phone-friendly layout.
- **Two writers, one table**: the roll-call phone (field) and the **existing Tools page** (office)
  both issue into `borrow_issuance`. No divergence, no second table, no shared counter. Nothing is
  added to the coordinator panel.
- **Tagging:** each borrow row records `source` (`roll-call-phone` | `coordinator`) — a **new column** —
  plus the existing `site_id`, and who/what/when exactly as the current flow does
  (`employee_id`, `item_id`, `unit_id`, `borrowed_at`, `issued_by`, `slip_no`, `batch_id`).
- **Field gate (decision 3):** the in-charge is already past the roll-call passcode, so **no warehouse
  issuance PIN in the field**. The borrower still types their own passcode to accept the tool
  (`verify_pin` RPC, as `tools/index.html:687` does today) — that is the accountability trail.
- **Concurrency (decision 2):** see below.

## Concurrency — what's actually safe today, and what isn't

**Already safe.** Each borrow is an independent `INSERT` of N rows (`tools/index.html:694`). No shared
counter, no read-modify-write on the transaction table. Two simultaneous borrows already land as
separate records. Owner requirement "both land as separate records" is **already met**; the plan must
keep it that way and prove it with a test that fires two borrows at once.

**Not safe — the real hole.** Availability is computed when the screen loads
(`tools/index.html:585-597` reads `status='out'` unit ids into `outSet`) and is **never re-checked at
insert time** (`:694`). Nothing in the database prevents issuing a unit that is already out. With one
writer this rarely bites; adding the phone as a second writer makes it a live risk — both slips would
read "out" for the same physical grinder.

**Fix (decision 2):** a partial unique index in the database —
`UNIQUE (unit_id) WHERE status='out'` on `borrow_issuance` — so the same physical unit cannot be out
twice. The database, not the screen, is the guarantee.
- The insert is all-or-nothing per slip (one `insert` of N rows), so a collision rejects the whole slip.
  The UI must catch the duplicate-key error (**23505**), identify **which** unit collided, look up the
  existing `out` row, and show: *"Already out — <borrower name> has it (slip <slip_no>, since <time>).
  Refresh to see current stock."* (owner: "a clear message showing who already has it out").
- **This closes the same hole for the warehouse staff's existing Tools page**, which is why that page
  needs its own line in the walkthrough — they use it daily.
- **Feasibility confirmed:** 0 rows currently have `status='out'`, so no duplicates exist and the index
  can be created cleanly. The plan must still re-census immediately before creating it (data can change),
  and the index creation must abort rather than force through if duplicates appear.

## Data changes (owner runs the SQL, per our normal rule)

Additive and reversible; nothing renames or deletes. Same self-verifying, transaction-wrapped,
rollback-on-mismatch pattern as `site-rename-carmen-mandaue.sql`, with a read-only preview step first.

1. `borrow_issuance`: **add `source` TEXT** (nullable; existing row stays null — it predates the field).
2. `borrow_issuance`: **add the partial unique index** `UNIQUE (unit_id) WHERE status='out'`,
   after a census proves no duplicates.
3. `job_checkpoint`: **add `site` TEXT** (nullable), holding the yard **name**. Nullable because every
   existing row predates site tagging; backfill from each job's own yard via the `sites` code↔name
   pairing. Roll-call's untag path deletes by `id`, so the new column changes no existing behavior.
4. `job_pause`: **add `site` TEXT** (nullable), same treatment and same backfill (decision 6).
   `job_progress` is **not** tagged — it is a cumulative per-job figure, not a per-entry event, and the
   job already carries its yard.

## Resolved (were open; owner answered 2026-07-16)

1. **Duplicate slip numbers → fixed on both writers.** The current code silently falls back to a
   device-clock string (`tools/index.html:651-652`: `'BS-'+siteCode()+HHMMSS`), so two devices issuing in
   the same second at the same yard mint the **identical slip number**. **Decision: remove the fallback
   entirely.** If the server numbering call fails, the borrow is **refused** with a clear message and a
   retry — never a possibly-duplicate number. This applies to the phone **and** the Tools page so both
   writers act alike. Consequence to accept knowingly: if numbering is unavailable, borrowing stops
   rather than producing a bad paper trail.
2. **`next_no` must be verified collision-safe** (owner agreed). It is not in this repo — applied directly
   in Supabase — so it cannot be read from the code. If it is not atomic it is itself the shared counter
   requirement 3 rules out. **This is a hard gate: the plan verifies it before any code relies on it.**
3. **Stale `sites` rows.** The shared `sites` table still has `A`/"Site A" and `B`/"Site B" next to
   Carmen/Mandaue. Harmless here (we match on `attendance_sites` names), but it is inventory-owned
   cruft worth a separate cleanup decision.

## Out of scope — flagged, not silently absorbed

- **`monitoring/config.js:29` hardcodes `SITES = ["CAR","MAN"]`**, which contradicts the standing
  data-driven rule. It only drives the `JOB-CAR-000001` control-number prefix. Changing job-order
  numbering is a business identifier change and does not belong in this spec — **flagged as a follow-up**,
  deliberately not churned here.
- Renaming `jobs.site` codes to yard names. The control numbers depend on them; not worth the risk.
- Butler calibration, and the Job Order man-hour estimate (owner's Task 2 — separate follow-up).

## Verification

- **E2E (Playwright, `scratchpad/nd-e2e/` conventions):** `?site=Carmen`/`?site=Mandaue` set the yard and
  header; missing `?site=` refuses with no entry UI; unknown yard refuses; the job list contains only that
  yard's jobs; a saved entry carries the yard name; a **new yard added to `attendance_sites` alone works
  with no code change**.
- **Coordinator view:** renders entries by day/job/yard; grep proves zero write calls.
- **Concurrency:** two borrows of *different* units fired simultaneously both land as separate rows; two
  borrows of the *same* unit → exactly one lands, the loser gets the "already out — <who> has it" message.
  This test must fail before the index exists and pass after — otherwise it proves nothing.
- **Full regression:** the existing 16-suite set must stay green.
- Validate (`node --check` on the largest inline script + hygiene grep for `wpmcbjrisuyjvobvzaus`
  present / `azfmpleswqixaslvcito` absent) on every changed file.

## Constraints

- No build step; vanilla JS + Preact/htm via CDN; Supabase `wpmcbjrisuyjvobvzaus` only.
- Site list from `settings.attendance_sites`; **no new hardcoded site list anywhere**.
- Worker-facing and touching a daily-use page → **owner's localhost walkthrough before any push**;
  the owner will have the in-charge's phone for the device-registration check.
- The owner runs all SQL themselves; Claude Code writes it.
