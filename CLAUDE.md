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
- **NEVER use or reference Supabase project `azfmpleswqixaslvcito`** — it is an old,
  abandoned project. Any URL containing it is a bug.

## Hard rules
1. **Confirm direction before writing code.** Discuss the approach, resolve open
   decisions (especially anything affecting pay), get explicit approval, THEN implement.
2. **Complete files only.** Always produce full replacement files, never diffs or
   partial snippets, when handing files to the owner.
3. **Validate before shipping:** extract the largest inline <script> from any HTML file
   and run `node --check` on it as an ES module. Nothing ships unvalidated.
4. **Hygiene check every deliverable:** grep for `wpmcbjrisuyjvobvzaus` (must exist)
   and `azfmpleswqixaslvcito` (must NOT exist).
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
