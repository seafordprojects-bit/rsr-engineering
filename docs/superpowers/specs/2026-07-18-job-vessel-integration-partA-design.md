# Job Monitoring — Vessel Integration, Project A: vessel dropdown + lifecycle flagging

**Date:** 2026-07-18
**Status:** Approved design (owner approved 2026-07-18). Ready for implementation plan.
**Scope:** Project A only (Parts 1–3 of the owner's request). Project B (multi-line-item job
orders + per-item KPI, Part 4) is a **separate, later** project and is out of scope here.

## Goal

Replace the free-text Vessel field on the Job Order form with a dropdown sourced from the
coordinator's vessel schedule (`voyages`), offering only vessels currently in the yard. Link each
new job to its vessel so that when the vessel leaves the yard (undock / afloat-done / emergency-end
/ finished), the job's still-open orders are **flagged for closing** on three surfaces — without
auto-closing them (closing stays a human step because it needs actual installed quantity for KPI).

## Business rules (owner-confirmed)

- **Selectable for a new job order** = vessel is in an ACTIVE repair phase: drydock, afloat repair,
  OR emergency repair (start date present, matching end date not yet filled; excludes `finished` /
  `not_active`). This is exactly the filter the tool-borrow and material-issuance pickers already use.
- **No free-text vessel entry.** The Vessel field becomes a dropdown only.
- **Undock / afloat-end / emergency-end = not selectable** for new jobs, and its still-open jobs are
  **flagged** ("⚠ Vessel undocked — close this job order").
- **No auto-close.** The flag is purely visual; the coordinator runs the existing two-stage close
  flow (`monitoring/efficiency.html` → `closeJobOrder`) with actual installed quantity.
- **Forward-looking only.** Existing job orders (free-text vessel, no link) are never flagged and
  keep displaying their vessel text unchanged.

## Current state (from code exploration)

- **Vessel field:** free-text `<input>` in `monitoring/job-order.html` (~line 187). The `jobs`
  insert (~lines 163–173) writes a single flat row: `job_no, vessel, site, location, description,
  tariff_id, quantity, unit, kilos, rate_used, correction_factor, factors, est_manhours, status,
  start_date, target_date, created_by`.
- **Vessel schedule:** `voyages` table, edited only in the coordinator app (`coordinator.js`
  Vessels component). Columns: `id, vessel_name, vessel_code, site_id, status, docking_date,
  undocking_date, departure_date, afloat_start, afloat_done, emergency_start, emergency_end, notes,
  created_at`. `status` enum: `drydock | afloat | emergency | not_active | finished`.
- **"Active in yard" filter — already exists** (`tools/index.html:539–546`, mirrored in
  `material-issuance/index.html`):
  ```js
  if (v.status === 'finished' || v.status === 'not_active') return false;
  const dry = (v.docking_date || v.status === 'drydock') && !v.undocking_date;
  const afl = v.afloat_start && !v.afloat_done;
  const eme = v.emergency_start && !v.emergency_end;
  return dry || afl || eme;
  ```
- **No monitoring→voyages link today.** `monitoring/` does not read `voyages` anywhere. This feature
  introduces that cross-area read (same Supabase project, RLS disabled).
- **Close flow is built and live** (`monitoring/efficiency.html`, `config.js closeJobOrder`); a
  frozen KPI week (2026-06-27) exists. Project A does NOT touch close or KPI logic.

## Data model change

One additive column on `jobs` (owner runs the SQL):

```sql
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS voyage_id uuid REFERENCES public.voyages(id);
CREATE INDEX IF NOT EXISTS idx_jobs_voyage ON public.jobs(voyage_id);
```

- `voyage_id` is nullable. Existing rows stay NULL (legacy free-text jobs → never flagged).
- On new-job creation, both `voyage_id` (the link) and `vessel` (the vessel_name snapshot) are
  written. Keeping the `vessel` text means display, CSV, and existing consumers need no change, and
  the name survives even if the voyage row is later deleted.

## Components

### 1. Shared vessel helper (`monitoring/config.js`)

Add two small, exported, side-effect-free helpers so all four surfaces agree:

- `loadActiveVoyages()` → fetch `voyages` (`select('*')`), return the rows that pass the active-in-
  yard filter above, sorted by `vessel_name`. Used to populate the dropdown.
- `vesselFlag(job, voyageById)` → given a job and a `Map`/object of `voyage_id → voyage row`, return
  `null` if no flag, else `{ reason, message }` where the job is flagged iff:
  - `job.voyage_id` is set AND
  - `job.status` is open/ongoing (NOT `done`/`closed`) AND
  - the linked voyage exists AND is NOT active-in-yard.
  - `reason`/`message`: name the most-recently-ended phase — `undocking_date` → "Vessel undocked",
    `afloat_done` → "Afloat repair ended", `emergency_end` → "Emergency repair ended" (pick the one
    with the latest end date); else (`finished`/`not_active`) → "Vessel left the yard". Message =
    `<reason> — close this job order`.

### 2. Vessel dropdown (`monitoring/job-order.html`)

- Replace the free-text Vessel `<input>` with a `<select>` whose options are `loadActiveVoyages()`
  (value = `voyage_id`, label = `vessel_name`). A "— Select vessel —" placeholder; no free-text.
- Offer ALL active vessels regardless of the job's yard (site). (Yard-filtering the list is a
  possible future refinement, deliberately out of scope — smallest diff.)
- On submit: resolve the chosen `voyage_id` to its row; write `voyage_id` + `vessel = vessel_name`.
- **Submit-time re-validation (Part 3 backstop):** re-check the chosen voyage is still active-in-
  yard at submit; if it undocked/ended between form-open and submit, refuse with a clear message and
  do not insert. The dropdown filter is the first guard; this is the race backstop.
- If there are NO active vessels, the form disables submit with a note ("No vessels are currently in
  the yard — add one in the coordinator vessel schedule first").

### 3. Lifecycle flag on three surfaces

Each surface fetches the small `voyages` list, builds `voyage_id → voyage` map, and renders
`vesselFlag(...)` as a visible badge on each open job whose vessel has left the yard:

- **By-job efficiency view** (`monitoring/efficiency.html`) — badge beside the job's close action.
- **Roll-call page** (`monitoring/roll-call.html`) — badge on each yard job card.
- **Coordinator view** (`coordinator.js` read-only roll-call view) — badge on the job grouping.

The badge is display-only; it changes no data and forces no action. Closing remains the existing
`efficiency.html` two-stage flow.

## Backward compatibility

- Existing jobs: `voyage_id` NULL → `vesselFlag` returns null → never flagged; `vessel` text still
  displays. No migration of old jobs.
- The `vessel` column stays; nothing that reads `jobs.vessel` changes.

## Testing (Playwright E2E, `scratchpad/nd-e2e/job-vessel.mjs`)

Mock `voyages`, `jobs`, `work_tariff`, `correction_factor` via route interception.

1. **Dropdown = active only:** voyages of each kind (drydock-active, afloat-active, emergency-active,
   undocked, afloat-done, finished) → dropdown lists exactly the 3 active; the 3 inactive are absent;
   no free-text vessel input exists.
2. **Submit writes the link:** picking a vessel and submitting inserts `voyage_id` = the picked id
   and `vessel` = its name.
3. **Submit re-check:** if the chosen voyage is inactive at submit time (mock it undocked), submit is
   refused and nothing is inserted.
4. **`vesselFlag` unit behavior:** open job + inactive vessel → flag with the right message; open job
   + active vessel → no flag; closed/done job + inactive vessel → no flag; job with no `voyage_id` →
   no flag.
5. **Flag renders** on efficiency By-job, roll-call, and the coordinator view when the vessel is
   inactive, and is absent while active.

Add `job-vessel.mjs` to `scratchpad/nd-e2e/run-all.mjs`. Full regression must stay green.

## Deploy / hygiene

- Bump version stamps on every page touched that carries one (`roll-call.html`, and
  `job-order.html` / `efficiency.html` if they carry a stamp), plus `preflight.html` EXPECT in
  lockstep, and the coordinator cache-bust in `coordinator/index.html`.
- Validate: `node --check` on the largest inline script of each touched HTML; hygiene grep
  (`wpmcbjrisuyjvobvzaus` present where a URL is embedded, `azfmpleswqixaslvcito` absent).
- htm templates use literal `&` / real unicode chars, never HTML entities (htm renders entities
  literally).
- Worker/coordinator-facing → **walkthrough before push** (SDD gate). Owner runs the ALTER SQL.

## Explicitly out of scope (Project B, later)

Multi-line-item job orders, per-line-item accomplishment/close/KPI, the `job_item` table, and any
rewrite of the earned-hours views. Project A leaves the single-work-item model and all KPI/close
logic untouched.
