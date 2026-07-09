# Payroll manual-edit audit trail — Design (LOCKED 2026-07-09)

Closes audit CRITICAL #3 (F4): the payroll "Edit times" feature rewrites/​fabricates punch
values in `attendance_records` with no record of prior values, who, when, or why — and with
no passcode. This adds an append-only, owner-attested edit trail so verbal-agreement
corrections are logged.

## Owner decisions (locked)
- **Reason required** on every Save (short free text, e.g. "verbal agreement — owner approved").
  Save is blocked if blank.
- **Passcode required** on Save — reuse `openConfirm()` (checks `cfg.pin`), exactly like
  `postDeductions`. Closes the current no-passcode gap.
- **History viewable in the payroll page** — a "Past edits" panel inside the Edit-times modal,
  per worker.

## Schema (owner runs the SQL before walkthrough; do NOT run it for them)
New append-only table `attendance_edit_audit`:
- `id` bigint identity PK, `employee_code` text, `date` text (matches attendance_records format),
  `changes` jsonb (`[{field, old, new}]` for each changed punch), `reason` text NOT NULL,
  `actor` text default `'owner'`, `created_at` timestamptz default now().
- Append-only: a BEFORE UPDATE/DELETE trigger raises (mirrors the other audit tables).
- Index on (employee_code, date). `notify pgrst, 'reload schema';`.

## Flow (payroll/index.html)
- `renderEditArea` (~956): add a **required Reason** input + a `#edit-history` panel; call
  `loadEditHistory(code)` to populate it (recent 50, newest first). New table 404s gracefully
  until the SQL is applied.
- `saveTimes` (~1000): **snapshot** each day's original punch values BEFORE applying the inputs;
  apply + recompute (existing); build a per-day diff of changed punch fields. If **no** field
  changed → message and return (never log an empty edit). If Reason blank → inline error, abort.
  Otherwise `openConfirm('Save time corrections', summary, async …)`:
  **log-first** — `insert` the audit rows (one per changed day) → on success `update`/`upsert`
  the `attendance_records` rows (existing writes) → `runPayroll()`. A failed audit insert aborts
  the whole save, so an edit can never happen unlogged. `addEditDay` rows log naturally
  (blank → value).
- `actor` = `'owner'` (payroll page is owner-operated).

## Validation
- `node --check` largest inline script; hygiene grep (`wpmcbjrisuyjvobvzaus` present,
  `azfmpleswqixaslvcito` absent).
- Payroll is pay-facing → **pause for owner localhost walkthrough before pushing.** Owner runs the
  SQL first, then walks through: edit a time → passcode prompt → reason required → save → the
  edit appears in "Past edits" with old→new + reason + timestamp; recompute is correct.
- Stamp bump payroll `v2026-07-07a` → `v2026-07-09a` + preflight EXPECT lockstep at deploy.
