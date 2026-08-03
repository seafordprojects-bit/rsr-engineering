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
