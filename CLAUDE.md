# CLAUDE.md — RSR Engineering Operations System

Internal web operations system for ship repair (attendance/payroll kiosk, warehouse,
purchasing, job monitoring, coordinator liquidation). **This repo is LIVE PRODUCTION —
the payroll pays real salaries. Be conservative.**

## Decision authority
The owner is the business owner, **not a programmer**. Decide ALL technical matters
yourself, without asking — libraries, code structure, SQL design, naming, file layout,
error handling, algorithms, anything about HOW the code works.

Ask the owner ONLY when a decision changes what the SYSTEM DOES for the business:
- policies (e.g. Policy A: missing-punch zeroes the session),
- money / pay / incentive rules,
- what workers or admins SEE on screen,
- workflow steps people must follow,
- thresholds and flags,
- anything touching live production data or payroll.

When you ask, use **plain language with a concrete real-life example** of what each option
means — no jargon. If a question is part technical and part business, decide the technical
part yourself and ask only the business part. (This scopes Hard rule 1: "confirm direction"
means confirm the *business* direction, not implementation details.)

## Stack (non-negotiable)
- Vanilla JS + Preact/htm via CDN. **No build step, no npm, no bundler, no frameworks.**
- Hosted on GitHub Pages: https://seafordprojects-bit.github.io/rsr-engineering
- Backend: Supabase project `wpmcbjrisuyjvobvzaus` (RLS disabled, PostgREST).
- **`azfmpleswqixaslvcito` is a SECOND, LIVE production project — the shipyard-inventory
  backend.** CORRECTED 2026-08-03; this entry previously called it "old, abandoned" and any
  reference to it "a bug", which was false. It runs 24 saved queries (tool transfer, borrow
  slips, PIN verification) and an active daily cron (`daily-unreturned`, `0 9 * * *`).
  **Nothing in this repo reads or writes it, and no session has ever written to it.** This repo's
  deployable pages all belong to `wpmcbjrisuyjvobvzaus` — so a reference to the inventory project
  in a page here still means the wrong backend, but it is a MIS-ROUTING, not a dead link, and
  deleting it blind could break live inventory work.
  **Consolidation / lockdown is a tracked item:**
  `docs/superpowers/specs/2026-08-03-inventory-project-consolidation.md`.

## Hard rules
1. **Confirm direction before writing code.** Discuss the approach, resolve open
   decisions (especially anything affecting pay), get explicit approval, THEN implement.
2. **Complete files only.** Always produce full replacement files, never diffs or
   partial snippets, when handing files to the owner.
3. **Validate before shipping:** extract the largest inline <script> from any HTML file
   and run `node --check` on it as an ES module. Nothing ships unvalidated.
4. **Hygiene check every deliverable:** grep for `wpmcbjrisuyjvobvzaus` (must exist)
   and `azfmpleswqixaslvcito` (must NOT exist). The second half still holds — every page in this
   repo belongs to the ops project — but the reason is WRONG BACKEND, not dead project. If a
   reference ever does appear, report it; do not silently delete it.
5. SQL uses `--` comments (never `//`). HTML/htm template literals use literal `&`,
   never `&amp;`.
6. Read the CURRENT live file before editing it. Past incidents: sections were wiped
   because an edit started from a stale copy (notably home.js tiles).

## Known landmines (learned the hard way)
- `attendance_records.date` is TEXT in MIXED formats: `MM/DD/YYYY` and `YYYY-MM-DD`.
  Supabase gte/lte range filters on it silently drop rows. ALWAYS fetch broadly and
  filter client-side with the `toISO()` normalizer. Same for `site` ("A" vs "Site A").
- Punch time columns are text like `08:00 AM` / `08:00:00 AM` / 24h `08:00`. Legacy
  rows may contain `(auto-deducted)` or `(skipped)` literals — payroll handles them.
- Deployment lag causes phantom bugs: GitHub Pages + tablet cache serve stale builds.
  Pages carry a version stamp in the header (e.g. `v2026-07-04e`); ALWAYS verify the
  stamp before debugging behavior. Tablet hard-reload goes through `reset.html`.
- Payroll session boundaries: morning 8:00–12:00, lunch 12:00–1:00 (grace to 12:30),
  afternoon 1:00–5:00 (PM out grace to 5:30), evening from 6:00 PM. Kiosk and payroll
  MUST share the same boundary numbers — changing one without the other is a bug.
- Kiosk punches save locally first and sync to Supabase via a persistent retry queue
  (30s interval). Sync upsert relies on unique index `uniq_attendance_emp_date`
  on (employee_code, date).
- **OUT parameters shadow column names in EVERY embedded SQL statement in a function.**
  A `returns table(status text, id uuid, code text, name text)` puts `status`, `id`,
  `code` and `name` in scope for the whole body, so an unqualified `where id` inside
  resolves to the PARAMETER, not the column: `ERROR 42702 column reference "id" is
  ambiguous`. Same class as the 2026-08-24 on-conflict lesson — `on conflict (id)` is
  exposed too; name the constraint instead (`on conflict on constraint <pkey>`).
  **Alias-qualify every table reference inside a function** (`update x t … where t.id`),
  including in `update`/`set` right-hand sides. Legal bare uses are narrow: INSERT column
  lists and the left side of a SET target.
- **Only running a code path proves it. Smoke-test every branch, not just the first.**
  `identify_employee_by_pin` shipped broken twice: a filter on a nonexistent column
  (42703, every path) and the shadowing above (42702, the throttle UPDATEs only). Neither
  is a syntax error — `create function` accepts both, and a single happy-path call misses
  the branch. When a function has N returns, exercise N paths. Where a path needs a real
  secret to reach (the success branch needs a real passcode), prove it at the kiosk during
  the walkthrough, NOT by typing the secret into the SQL editor — the editor keeps a query
  history and that writes a live passcode into it in clear text.

## Verification pages in this repo
- `payroll/diagnostic.html` — inspects attendance data quality and simulates a payroll run.
- `preflight.html` — pre-deployment checks (build versions, Supabase, constraint, data).
Use Playwright to open these (and the payroll/kiosk pages) to verify changes end-to-end.

## Control number formats
`LPR-CAR-000001`, `LTR-CAR-000001`; the `LPR-` prefix is reserved for the future
Purchasing Department module.

## Running SQL — standing rules (owner, 2026-08-03)

**Two live Supabase projects are open in one browser with identical editors.** A wrong-project
READ errors or misleads; a wrong-project WRITE succeeds silently — and migrations are writes.
Demonstrated live 2026-08-03: a migration's STEP 0 went into the inventory project via a leftover
tab, harmless only because that table does not exist there.

Before running any SQL:

1. **Close the other project's tab.** The only reliable guard.
2. **Confirm the database from inside the tab**, never from its title:
   `select current_database();`
3. **Lead every migration with the canary read** — a statement that only succeeds in the intended
   project. For this repo: `select count(*) from public.attendance_records;` It errors immediately
   in the inventory project.

Related and unresolved: a 2026-07-31 install verified live and its objects were later found in
**neither** project. Cause unknown. Migrations that create scheduled jobs or tables carry a
persistence check — close the editor, open a fresh tab, re-verify — see
`kiosk-heartbeat-snapshot.sql` STEP 5b.

## Workflow
Sequential and confirmation-gated: propose → owner confirms → implement → validate
(`node --check` + hygiene) → show result → owner commits/deploys. Never auto-commit
pay-affecting changes without explicit approval.

### Deploy rule (push to `main`)
- **Pages workers or admins INTERACT with** — kiosk, roll-call, payroll, forms, close
  actions, and any similar interactive surface — **always pause for the owner's localhost
  walkthrough before pushing to `main`.** No exceptions; wait for explicit go.
- **Small follow-up fixes to already-reviewed features** — wording, thresholds, and view
  (SQL) definitions the owner re-runs themselves anyway — **may push directly without a
  walkthrough, but ALWAYS tell the owner immediately what went live** (exact commit + files).
- When unsure which bucket a change falls in, treat it as interactive and pause.

## Verified done, 2026-09-03
Localhost walkthrough for the offline punch queue passed on branch `offline-punch-queue`
at commit `5f6c06f`:
- Offline Time In queued and synced on reconnect with `client_ts` = tap time (11:48:10);
  `server_received_at` landed 41s later.
- Offline Time Out queued and landed in `attendance_records.timeout` with its tap time
  (12:02:25).
- A `000000` PIN queued offline was refused at sync and written to `kiosk_offline_rejects`
  with `employee` null.
- The admin dashboard rejects card showed both rejects as unreviewed.
- Test rows cleaned up afterward: `kiosk_offline_punch_log`, `kiosk_offline_rejects` ids 4
  and 5, and the `RSR 0000` attendance row for 09/03/2026.

`kiosk_offline_rejects` id 4 is dated 2026-08-29 — proof the Aug 29 walkthrough got as far
as producing a rejection, but its cleanup never ran; that stale row sat in the table
uncleaned for 5 days until today.

## Known open items
- `drift_seconds` (in `kiosk_offline_punch_log`) measures queue latency
  (`server_received_at` minus `client_ts`), not clock drift; the two are indistinguishable
  from this column alone.
- The offline banner's wording is inconsistent: it says "pending" in one state and
  "waiting" in another.
- The admin rejects card shows "(unknown day)" even though `client_ts` has the date, and
  showed "1 day affected" when two rejects were actually five days apart.
- The live kiosk polls Telegram `getUpdates` and receives 409s, consistent with two tablets
  long-polling one bot token.
- `employees.pin_set_at` does not exist on the live database; `employee-pin-set-at.sql` was
  never applied.
- Offline UX shows no worker name by design; on-device PIN verification was discussed and
  declined for now because a 6-digit PIN cannot be safely verified without server-side
  throttling.
