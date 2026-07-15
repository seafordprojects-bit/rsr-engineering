# Roll-call site tagging + tool borrowing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-16-roll-call-site-tool-borrow-design.md` (approved 2026-07-16).

**Goal:** Tag roll-call entries and pauses with the yard from a `?site=` URL parameter, give the coordinator a read-only roll-call view, and surface the existing tool-borrow flow on the roll-call phone with database-enforced protection against issuing the same physical tool twice.

**Architecture:** No new systems. Roll-call (`monitoring/roll-call.html`) gains a site gate that reads the yard list from `settings.attendance_sites` and refuses to run without a valid `?site=`. Tool borrowing **reuses the existing `borrow_issuance` table and Tools flow** — the phone is a second writer alongside `tools/index.html`, not a parallel system. Safety moves from the screen into the database: a partial unique index makes double-issue impossible, and the device-clock slip-number fallback is deleted so numbering is always server-authoritative.

**Tech Stack:** Vanilla JS + Preact/htm via CDN (no build step, no npm). Supabase `wpmcbjrisuyjvobvzaus` via PostgREST. Playwright + msedge for E2E.

## Global Constraints

Copied verbatim from the spec and CLAUDE.md. **Every task's requirements implicitly include this section.**

- **No build step, no npm, no bundler, no frameworks.** Vanilla JS + Preact/htm via CDN.
- **Supabase project `wpmcbjrisuyjvobvzaus` ONLY.** `azfmpleswqixaslvcito` must NEVER appear — any URL containing it is a bug.
- **Site values are yard names: `Carmen`, `Mandaue`.** The list comes from `settings.attendance_sites`. **No hardcoded site list anywhere** — a new yard added to that array must work with no code change.
- **Complete files only** when handing files to the owner — never diffs or partial snippets.
- **Validate before shipping:** extract the largest inline `<script>` from any changed HTML and run `node --check` on it as an ES module (`scratchpad/validate.mjs <file>`), plus the hygiene grep (`wpmcbjrisuyjvobvzaus` present, `azfmpleswqixaslvcito` absent).
- **SQL uses `--` comments** (never `//`). HTML/htm template literals use literal `&`, never `&amp;`.
- **Read the CURRENT live file before editing it.** Past incidents wiped sections because an edit started from a stale copy.
- **The owner runs ALL SQL themselves.** Claude Code writes it; the owner executes it in Supabase.
- **The Supabase SQL editor swallows `RAISE NOTICE`** — never trust "Success" as proof. Always re-query independently to confirm what landed.
- **Slip numbering: no device-clock fallback.** If the server numbering call fails, refuse with a retry.
- **Message language:** Bisaya on the roll-call phone (matches the kiosk); English on `tools/index.html` (matches its existing UI). Behavior identical on both.
- **Version stamps: `monitoring/roll-call.html` and `tools/index.html` have NONE today** (verified — only payroll and kiosk carry one, and `preflight.html`'s `EXPECT` tracks only those two). **ADD a stamp to both** in the format the other pages use (`v2026-07-16a`), render it in the page header, and register both in `EXPECT` in the same commit. This is not ceremony: the roll-call phone is an Add-to-Home-Screen app on a field phone — the worst case for the stale-build landmine — and the stamp is how the owner's walkthrough confirms the phone actually took the new build. Thereafter, bump in lockstep with `EXPECT` on every change.
- **NOTHING PUSHES** without the owner's localhost walkthrough and their explicit "push". Commit locally per task; do not push.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `monitoring/roll-call.html` | The roll-call phone. Site gate, header badge, yard-filtered job list, site-tagged writes, tool-borrow UI. | Modify |
| `monitoring/roll-call.webmanifest` | Add-to-Home-Screen manifest. Two shortcuts (`?site=Carmen`, `?site=Mandaue`). | Modify |
| `tools/index.html` | Warehouse-staff borrow screen (the office writer). Remove slip fallback; handle double-issue rejection. | Modify |
| `coordinator.js` | Coordinator panel. Add a **read-only** roll-call view. | Modify |
| `monitoring/roll-call-site-borrow.sql` | The migration the **owner** runs. Census → columns → index → backfill. | Create |
| `preflight.html` | `EXPECT` stamps. | Modify |
| `scratchpad/nd-e2e/roll-call-site.mjs` | E2E: `?site=` gate, filtering, tagging, new-yard-just-works. | Create |
| `scratchpad/nd-e2e/tool-borrow-concurrency.mjs` | E2E: double-issue blocked, concurrent borrows both land, no slip fallback. | Create |
| `scratchpad/nd-e2e/run-all.mjs` | Regression set registry. | Modify |
| `scratchpad/verify-borrow-migration.mjs` | Independent post-migration re-query (the editor lies by omission). | Create |

**Shared site helper (DRY).** Tasks 2, 3 and 5 all need "read the yard list + map name↔code". Write it **once** in Task 2 as `siteList()` / `siteCodeFor()` inside `roll-call.html`, and have Task 3/5 reuse the same shape. Do not copy-paste a third variant; do not add a hardcoded `SITE_CODES` map (`tools/index.html:459` has one — do not extend its pattern).

---

## Task 0: Verify `next_no` is collision-safe — HARD GATE

**Blocks every other task.** If `next_no` is not atomic it is itself the shared counter the spec rules out, and Tasks 4/5 rest on a false foundation. The function is not in this repo (applied directly in Supabase), so it cannot be read from code.

**Files:** none (verification only).

- [ ] **Step 1: Ask the owner to run this read-only query and paste the result**

```sql
-- Read-only. Prints the definition of the numbering function so we can check its locking.
SELECT p.proname, pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname = 'next_no';
```

- [ ] **Step 2: Judge it against these criteria**

SAFE if it allocates from a **sequence** (`nextval`), or serializes with `pg_advisory_xact_lock`, or does an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on a counter row.
UNSAFE if it does `SELECT max(...)` then `INSERT`/`UPDATE` (read-modify-write — two concurrent calls return the same number), or has no locking at all.

- [ ] **Step 3: Report to the owner and branch**

If SAFE: record the verdict in the spec's Resolved section and proceed to Task 1.
If UNSAFE: **STOP and report.** Removing the device-clock fallback (decision 4) while `next_no` itself collides would replace one duplicate-number bug with another. The fix (rewrite `next_no` to use an advisory lock or a sequence) is a new SQL deliverable the owner must run, and it changes numbering for every module that calls it (`BS`, `RP`, `TR`, `MI`, `DR`, `LPR`, `LTR`) — that is a business decision, not a technical one. Do not proceed to Tasks 4/5 until resolved.

---

## Task 1: The migration SQL (owner executes)

**Files:**
- Create: `monitoring/roll-call-site-borrow.sql`

**Interfaces:**
- Produces: `borrow_issuance.source` (text, nullable); partial unique index `uniq_borrow_unit_out` on `borrow_issuance(unit_id) WHERE status='out'`; `job_checkpoint.site` (text, nullable); `job_pause.site` (text, nullable), both backfilled with yard names.
- Consumes: the shared `sites` table (`code`/`name`) for the code→name backfill. Read-only — the inventory system owns it.

- [ ] **Step 1: Write the SQL**

Follow `payroll/site-rename-carmen-mandaue.sql` exactly in shape: a read-only STEP 0 preview, then one self-verifying `DO $$ ... $$` block (one transaction) that aborts via `RAISE EXCEPTION` on any mismatch. Additive only — no renames, no deletes.

```sql
-- ============================================================================
-- ROLL-CALL SITE TAGGING + TOOL-BORROW SAFETY
-- ----------------------------------------------------------------------------
-- Additive and reversible. Adds:
--   * borrow_issuance.source          — which writer issued (roll-call-phone | coordinator)
--   * uniq_borrow_unit_out            — makes double-issue of one physical tool IMPOSSIBLE
--   * job_checkpoint.site, job_pause.site — yard NAME on every roll-call entry/pause
--
-- SAFETY:
--   * STEP 1 is ONE DO block = ONE transaction. Any RAISE EXCEPTION rolls back EVERYTHING.
--   * Aborts rather than forcing through if a unit is already out twice.
--   * Re-runnable: IF NOT EXISTS guards throughout; a second run is a no-op.
--   * The shared `sites` table is NOT modified — read only, for the code->name backfill.
--   * Its stale 'Site A'/'Site B' rows are ignored (we match CAR/MAN).
--
-- HOW TO RUN (Supabase SQL editor):
--   1. Run STEP 0 alone. It changes nothing.
--   2. If STEP 0 shows any unit already out twice, STOP and report — do not run STEP 1.
--   3. Run STEP 1.
--   4. NOTE: this editor does NOT show RAISE NOTICE output. "Success" proves nothing.
--      Claude Code re-queries independently afterwards to confirm what landed.
-- ============================================================================

-- ── STEP 0 · PREVIEW (read-only) ────────────────────────────────────────────
SELECT 'units already out more than once (MUST be zero)' AS check, unit_id::text AS value, count(*) AS rows
  FROM borrow_issuance WHERE status = 'out' GROUP BY unit_id HAVING count(*) > 1
UNION ALL
SELECT 'borrow_issuance rows total', '', count(*) FROM borrow_issuance
UNION ALL
SELECT 'job_checkpoint rows to backfill', '', count(*) FROM job_checkpoint
UNION ALL
SELECT 'job_pause rows to backfill', '', count(*) FROM job_pause
UNION ALL
SELECT 'sites available for code->name', code, count(*) FROM sites GROUP BY code
ORDER BY 1, 3 DESC;

-- ── STEP 1 · MIGRATE (transaction-wrapped, self-verifying) ──────────────────
DO $$
DECLARE
  dup int; bi_before int; bi_after int; jc_before int; jc_after int; jp_before int; jp_after int;
  jc_null int; jp_null int;
BEGIN
  SELECT count(*) INTO bi_before FROM borrow_issuance;
  SELECT count(*) INTO jc_before FROM job_checkpoint;
  SELECT count(*) INTO jp_before FROM job_pause;

  -- Refuse to build the unique index over data that already violates it.
  SELECT count(*) INTO dup FROM (
    SELECT unit_id FROM borrow_issuance WHERE status='out' GROUP BY unit_id HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION 'ABORT: % tool unit(s) are already out more than once. Resolve those borrows first.', dup;
  END IF;

  -- Columns (additive, nullable — every existing row predates them).
  ALTER TABLE borrow_issuance ADD COLUMN IF NOT EXISTS source text;
  ALTER TABLE job_checkpoint  ADD COLUMN IF NOT EXISTS site   text;
  ALTER TABLE job_pause       ADD COLUMN IF NOT EXISTS site   text;

  -- THE guarantee: one physical unit cannot be out twice. The database enforces it,
  -- not the screen (the screen only checks availability at load time).
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_borrow_unit_out
    ON borrow_issuance (unit_id) WHERE status = 'out';

  -- Backfill the yard NAME from each job's own yard code, via the shared sites table.
  UPDATE job_checkpoint c SET site = s.name
    FROM jobs j JOIN sites s ON s.code = j.site
   WHERE c.job_id = j.id AND c.site IS NULL;
  UPDATE job_pause p SET site = s.name
    FROM jobs j JOIN sites s ON s.code = j.site
   WHERE p.job_id = j.id AND p.site IS NULL;

  -- Row counts must not move: this adds columns, it never inserts or deletes.
  SELECT count(*) INTO bi_after FROM borrow_issuance;
  SELECT count(*) INTO jc_after FROM job_checkpoint;
  SELECT count(*) INTO jp_after FROM job_pause;
  IF bi_after <> bi_before THEN RAISE EXCEPTION 'ABORT: borrow_issuance rows changed % -> %', bi_before, bi_after; END IF;
  IF jc_after <> jc_before THEN RAISE EXCEPTION 'ABORT: job_checkpoint rows changed % -> %', jc_before, jc_after; END IF;
  IF jp_after <> jp_before THEN RAISE EXCEPTION 'ABORT: job_pause rows changed % -> %', jp_before, jp_after; END IF;

  SELECT count(*) INTO jc_null FROM job_checkpoint WHERE site IS NULL;
  SELECT count(*) INTO jp_null FROM job_pause      WHERE site IS NULL;
  RAISE NOTICE 'OK — source + site columns added; uniq_borrow_unit_out created.';
  RAISE NOTICE 'Backfill left % checkpoint and % pause row(s) with no yard (their job has an unknown site code).', jc_null, jp_null;
END $$;
```

- [ ] **Step 2: Validate the SQL by inspection**

Confirm: `--` comments only (no `//`); no `azfmpleswqixaslvcito`; every `ALTER`/`CREATE INDEX` has `IF NOT EXISTS`; the `sites` table is only read.

- [ ] **Step 3: STOP — owner gate**

Hand the owner the complete file. They run STEP 0, confirm zero duplicate-out units, then run STEP 1. **Do not proceed to Task 2 until they confirm.** Rows left with a null site (a job whose `site` code is not in `sites`) are expected for legacy/odd jobs — report the count, do not silently ignore it.

- [ ] **Step 4: Verify independently — the editor's "Success" is not evidence**

Write `scratchpad/verify-borrow-migration.mjs` (model it on `scratchpad/site-rename-verify-after.mjs`, read-only, anon key) that re-queries and asserts:
- `borrow_issuance` returns a `source` key; `job_checkpoint` and `job_pause` return a `site` key.
- Row counts match the pre-migration census.
- Backfill: no `job_checkpoint`/`job_pause` row whose job has a known site code still has a null site.
- The unique index actually bites: attempt two inserts of the same `unit_id` with `status='out'` **against a throwaway unit**, expect the second to fail with `23505`, then delete both probe rows. If it does NOT fail, the index is missing — report and stop.

- [ ] **Step 5: Commit**

```bash
git add monitoring/roll-call-site-borrow.sql
git commit -m "feat(roll-call): migration for site tagging + tool-borrow double-issue guard"
```

---

## Task 2: `?site=` on the roll-call phone

**Files:**
- Modify: `monitoring/roll-call.html` (site gate, header, job filter, tagged writes, version stamp)
- Modify: `monitoring/roll-call.webmanifest` (two shortcuts)
- Test: `scratchpad/nd-e2e/roll-call-site.mjs`

**Interfaces:**
- Consumes: `settings.attendance_sites` (JSON array of yard names); the `sites` table (`code`/`name`); `job_checkpoint.site` / `job_pause.site` from Task 1.
- Produces: `siteList()` → `Promise<string[]>`; `siteCodeFor(name)` → `string|null`; page-global `activeSite` (yard name). **Tasks 3 and 5 reuse this shape — do not write a second variant.**

- [ ] **Step 1: Read the current file first**

`monitoring/roll-call.html` is 432 lines. Read it fully before editing (CLAUDE.md hard rule 6 — sections have been wiped by edits from stale copies). Note the existing `Gate` component at `:135-208`; the new site check composes with it, it does not replace it.

- [ ] **Step 2: Write the failing E2E first**

Create `scratchpad/nd-e2e/roll-call-site.mjs` following the conventions in `scratchpad/nd-e2e/site-rename.mjs` (same `launchKiosk`-style stub shape, `url` option, `settings` seeded with `attendance_sites`). It must assert:

```js
// 1. ?site=Carmen  → header shows Carmen; entry UI present.
// 2. ?site=Mandaue → header shows Mandaue.
// 3. NO ?site=     → refusal screen, NO entry UI, and NO default yard chosen.
// 4. ?site=Danao (not in the list) → refusal naming the unknown yard.
// 5. Job list contains ONLY jobs whose yard matches ?site=.
// 6. A saved tag writes job_checkpoint.site = 'Carmen' (the NAME, not 'CAR').
// 7. A pause writes job_pause.site = 'Carmen'.
// 8. attendance_sites = ["Carmen","Mandaue","Danao"] → ?site=Danao works with NO code change.
```

Assert the *absence* of the entry UI on refusal by locating the tag control and expecting zero matches — not merely that a message appeared. A refusal that still renders the buttons underneath is the failure mode that matters.

- [ ] **Step 3: Run it — confirm it fails**

Run: `node nd-e2e/roll-call-site.mjs` from `scratchpad/`. Expected: FAIL (no site handling exists yet — the file has zero occurrences of `site` today).

- [ ] **Step 4: Implement the site gate**

Add alongside the existing `Gate`, reading the yard list from data:

```js
// Yard list is DATA (settings.attendance_sites) — never a hardcoded list. A new yard added to
// that array must work here with no code change.
async function siteList(){
  try{ const raw = await getSetting('attendance_sites'); const a = raw ? JSON.parse(raw) : [];
       return Array.isArray(a) ? a.map(x=>String(x).trim()).filter(Boolean) : []; }
  catch(_){ return []; }
}
// jobs.site stores the CODE ('CAR'); roll-call entries store the NAME ('Carmen'). Both sides read
// the pairing from the shared `sites` table — read-only, the inventory system owns it. Its stale
// 'Site A'/'Site B' rows are ignored because we only match names present in attendance_sites.
async function siteCodeFor(name){
  const { data } = await sb.from('sites').select('code,name');
  const hit = (data||[]).find(s => String(s.name).trim() === String(name).trim());
  return hit ? hit.code : null;
}
```

Gate behavior — **refuse, never default** (spec requirement 3):
- Read `?site=` via `new URLSearchParams(location.search).get('site')`.
- Absent → full-page refusal, no entry UI: *"Ablihi ni gikan sa Carmen o Mandaue nga shortcut sa home screen."* (Bisaya — this is the field phone; matches the kiosk.) List the yards from `siteList()`, do not hardcode the names in the copy.
- Present but not in `siteList()` → refusal naming the value: *"Wala mailhi nga site: '<value>'."*
- Valid → set `activeSite`, show it in the header (mirror the kiosk badge treatment), and filter the job list to `siteCodeFor(activeSite)`.
- Tag writes: add `site: activeSite` to the `job_checkpoint` insert (`:287-290`) and the `job_pause` insert (`:318`). Leave `job_progress` untouched — it is a cumulative per-job figure, not a per-entry event.

- [ ] **Step 5: Two home-screen shortcuts**

Update `monitoring/roll-call.webmanifest` with a `shortcuts` array for `?site=Carmen` and `?site=Mandaue`. **These two entries are a UI affordance, not the site list** — the app still validates against `attendance_sites`, so a third yard works via URL without touching this file. Note in the plan report that a future yard would want a third shortcut for convenience only.

- [ ] **Step 6: Run the E2E — confirm it passes**

Run: `node nd-e2e/roll-call-site.mjs`. Expected: all checks pass, including the new-yard-just-works case.

- [ ] **Step 7: ADD the stamp (this page has none) and validate**

`monitoring/roll-call.html` carries **no version stamp today**. Add `v2026-07-16a` in the page header, matching how kiosk/payroll render theirs, and add `'monitoring/roll-call.html':'v2026-07-16a'` to `preflight.html`'s `EXPECT` in the same commit (lockstep — a stamp without its `EXPECT` is how stale builds hide).
Run: `node scratchpad/validate.mjs monitoring/roll-call.html`. Expected: `node --check OK` + hygiene OK.

- [ ] **Step 8: Commit**

```bash
git add monitoring/roll-call.html monitoring/roll-call.webmanifest preflight.html scratchpad/nd-e2e/roll-call-site.mjs
git commit -m "feat(roll-call): ?site= yard gate, filtered jobs, site-tagged entries and pauses"
```

---

## Task 3: Read-only roll-call view in the coordinator panel

**Files:**
- Modify: `coordinator.js`

**Interfaces:**
- Consumes: `job_checkpoint` / `job_pause` (with `site` from Task 1), `jobs`. Reuses the `siteList()` shape from Task 2 — same data source, no hardcoded list.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Read `coordinator.js` first**

It is large. Read the existing PIN gate (`:214`) and the surrounding view structure so the new view matches the established pattern. Do not add a second gate — the coordinator's own passcode already covers this page.

- [ ] **Step 2: Implement the view**

A roll-call view showing entries filterable by **day / job / yard**. Read-only:
- **No add/edit/delete controls at all** — no buttons, no inputs that mutate.
- **No write calls in the page** for these tables.

- [ ] **Step 3: Prove it is read-only — this is the acceptance test, not a code-review opinion**

Run:

```bash
grep -nE "(insert|update|delete|upsert|rpc)\s*\(" coordinator.js | grep -iE "job_checkpoint|job_pause|job_progress"
```

Expected output: **nothing.** If this prints any line, the task is not done. (`coordinator.js` legitimately writes other tables — liquidation, stock — so grep for these three tables specifically rather than for the verbs alone.)

- [ ] **Step 4: Validate**

Run: `node --check coordinator.js`. Expected: OK. Bump the `?v=` cache-bust wherever `coordinator.js` is loaded, and confirm hygiene (`azfmpleswqixaslvcito` absent).

- [ ] **Step 5: Commit**

```bash
git add coordinator.js coordinator/index.html
git commit -m "feat(coordinator): read-only roll-call view by day/job/yard"
```

---

## Task 4: Tools page — no slip fallback, and handle the double-issue rejection

**Files:**
- Modify: `tools/index.html:649-655` (slip numbering), `:694` (the insert), version stamp
- Test: `scratchpad/nd-e2e/tool-borrow-concurrency.mjs`

**Interfaces:**
- Consumes: `uniq_borrow_unit_out` and `borrow_issuance.source` from Task 1; the `next_no` RPC (verified in Task 0).
- Produces: `describeUnitHolder(unitId)` → `Promise<{name, slip_no, borrowed_at}|null>` — Task 5 reuses it for the phone's message.

**This page is used daily by warehouse staff.** It gets its own line in the walkthrough.

- [ ] **Step 1: Write the failing E2E first**

Create `scratchpad/nd-e2e/tool-borrow-concurrency.mjs` asserting:

```js
// 1. next_no RPC succeeds  → slip number is the SERVER's value.
// 2. next_no RPC FAILS     → the borrow is REFUSED. No insert fires, and NO device-clock
//                            'BS-CAR-HHMMSS' string is minted anywhere. A retry is offered.
// 3. Same unit issued twice → the 2nd insert is rejected (23505) and the message names the
//                            current holder, their slip number, and when they took it.
// 4. TWO different units issued simultaneously → BOTH land as separate rows (the spec's
//                            "no shared counters or last-write-wins" requirement).
// 5. Every borrow row carries source='coordinator' from this page.
```

Check 3 must fail before the index exists and pass after — a test that passes either way proves nothing.

- [ ] **Step 2: Run it — confirm it fails**

Run: `node nd-e2e/tool-borrow-concurrency.mjs`. Expected: FAIL (the fallback still exists at `:651-652`).

- [ ] **Step 3: Delete the device-clock fallback**

Replace `tools/index.html:649-655`. The current code swallows the RPC error and mints a device-clock number — two devices issuing in the same second at the same yard produce the identical slip number:

```js
  if(!reservedSlipNo){
    // Slip numbers MUST come from the server (next_no). The old device-clock fallback
    // ('BS-'+siteCode()+HHMMSS) let two devices minting in the same second produce the SAME
    // slip number — two paper slips, one number. Refuse instead: a missing number is
    // recoverable, a duplicate one is not.
    let sn='';
    try{ const{data,error}=await sb.rpc('next_no',{p_prefix:'BS',p_site:siteCode()}); if(!error&&data)sn=data; }catch(e){}
    if(!sn){ toast('Could not get a slip number from the server. Check the connection and try again.', true); return; }
    reservedSlipNo=sn;
  }
```

English copy here — this page is entirely English (zero Bisaya strings today); the phone gets Bisaya in Task 5.

- [ ] **Step 4: Handle the double-issue rejection**

The slip inserts N rows at once, so one collision rejects the whole slip. Catch `23505`, identify the colliding unit, and name the holder:

```js
// The DB (uniq_borrow_unit_out) is what guarantees a unit can't be out twice — availability here
// is only read at screen load (loadAvail), so another writer can take a tool after we rendered.
async function describeUnitHolder(unitId){
  const { data } = await sb.from('borrow_issuance')
    .select('slip_no,borrowed_at,employees(name)').eq('unit_id',unitId).eq('status','out').limit(1);
  const r=(data||[])[0]; if(!r) return null;
  return { name:(r.employees&&r.employees.name)||'someone', slip_no:r.slip_no, borrowed_at:r.borrowed_at };
}
```

On `23505` from the insert: find which cart unit is now `out`, call `describeUnitHolder`, and show
*"Already out — {name} has it (slip {slip_no}, since {time}). Refresh to see current stock."*
Then reload availability. Do not retry the insert automatically — the stock genuinely changed.

- [ ] **Step 5: Tag the source**

Add `source:'coordinator'` to the row map at `:694`, alongside the existing `site_id`.

- [ ] **Step 6: Run the E2E — confirm it passes**

Run: `node nd-e2e/tool-borrow-concurrency.mjs`. Expected: all checks pass.

- [ ] **Step 7: ADD the stamp (this page has none) and validate**

`tools/index.html` carries **no version stamp today**. Add `v2026-07-16a` in the page header and register `'tools/index.html':'v2026-07-16a'` in `preflight.html`'s `EXPECT`, in the same commit.
Run: `node scratchpad/validate.mjs tools/index.html`. Expected: `node --check OK` + hygiene OK.

- [ ] **Step 8: Commit**

```bash
git add tools/index.html preflight.html scratchpad/nd-e2e/tool-borrow-concurrency.mjs
git commit -m "fix(tools): server-only slip numbers; block double-issue with holder message"
```

---

## Task 5: Tool borrowing on the roll-call phone

**Files:**
- Modify: `monitoring/roll-call.html` (borrow UI alongside roll call, version stamp)

**Interfaces:**
- Consumes: `activeSite` / `siteList()` / `siteCodeFor()` (Task 2); `describeUnitHolder` shape (Task 4); `uniq_borrow_unit_out` + `source` (Task 1); `verify_pin` RPC (as `tools/index.html:687` uses it).
- Produces: borrow rows in `borrow_issuance` with `source='roll-call-phone'`.

**Reuse, do not rebuild.** Same table, same columns, same `next_no` numbering, same borrower-passcode step as `tools/index.html`. Do not create a second borrow table, and do not revive `borrower-equipments/` (orphaned legacy — nothing links to it).

- [ ] **Step 1: Write the failing E2E first**

Extend `scratchpad/nd-e2e/tool-borrow-concurrency.mjs` (do not create a parallel suite):

```js
// 6. Phone issues a borrow → row lands with source='roll-call-phone' and the site_id of ?site=.
// 7. NO warehouse issuance PIN is required on the phone (owner decision 3).
// 8. The borrower's own passcode IS required — a wrong passcode blocks the borrow.
// 9. Phone + Tools page issuing the SAME unit concurrently → exactly one lands; the loser
//    sees the "already out — <who> has it" message. This is the two-writer case.
// 10. next_no failure on the phone → refused with a Bisaya message + retry, no fallback number.
```

- [ ] **Step 2: Run it — confirm the new checks fail**

Run: `node nd-e2e/tool-borrow-concurrency.mjs`. Expected: checks 6-10 FAIL.

- [ ] **Step 3: Implement the borrow UI**

Phone-friendly, alongside roll call, behind the existing roll-call passcode + device registration:
- **No warehouse issuance PIN** (owner decision 3 — the in-charge is already past the roll-call passcode).
- **The borrower types their own passcode** to accept the tool (`verify_pin` RPC) — the accountability trail.
- `site_id` = the id for `activeSite` from the `sites` table (via the `siteCodeFor`/name pairing, not a hardcoded map).
- `source:'roll-call-phone'`.
- Slip number from `next_no` only; on failure refuse in **Bisaya** with a retry: *"Wala makakuha og slip number gikan sa server. Sulayi pag-usab."*
- Reuse Task 4's `describeUnitHolder` message on `23505`, in Bisaya.

- [ ] **Step 4: Run the E2E — confirm it passes**

Run: `node nd-e2e/tool-borrow-concurrency.mjs`. Expected: all checks pass, including the two-writer race (check 9).

- [ ] **Step 5: Validate**

Run: `node scratchpad/validate.mjs monitoring/roll-call.html`. Expected: `node --check OK` + hygiene OK. Bump the stamp added in Task 2 (`v2026-07-16a` → `v2026-07-16b`) and `preflight.html` `EXPECT` in lockstep.

- [ ] **Step 6: Commit**

```bash
git add monitoring/roll-call.html preflight.html scratchpad/nd-e2e/tool-borrow-concurrency.mjs
git commit -m "feat(roll-call): tool borrowing on the phone (reuses borrow_issuance)"
```

---

## Task 6: Full regression + the walkthrough package

**Files:**
- Modify: `scratchpad/nd-e2e/run-all.mjs`

- [ ] **Step 1: Register both new suites**

Add `roll-call-site.mjs` and `tool-borrow-concurrency.mjs` to `SUITES` with a one-line comment each, matching the existing style. The set goes from 16 to 18.

- [ ] **Step 2: Run the whole set**

Run: `node nd-e2e/run-all.mjs` from `scratchpad/` (start the static server on 8137 first: `npx --yes http-server -p 8137 -c-1 --silent` from the repo root).
Expected: `════ regression set: 18/18 suites passed ════`. Anything less blocks the walkthrough — report which suite and why, do not proceed.

- [ ] **Step 3: Re-verify the migration landed**

Run: `node scratchpad/verify-borrow-migration.mjs`. Expected: all checks pass. (Independent re-query — the SQL editor's "Success" is not evidence.)

- [ ] **Step 4: Validate every changed page + hygiene**

Run `scratchpad/validate.mjs` on `monitoring/roll-call.html`, `tools/index.html`, `preflight.html`; `node --check coordinator.js`. All must pass, with `wpmcbjrisuyjvobvzaus` present and `azfmpleswqixaslvcito` absent everywhere.

- [ ] **Step 5: STOP — hand the owner the walkthrough package**

**Do not push.** Report:
- Every file changed + its new version stamp.
- The regression result (18/18) and what the two new suites prove.
- **Walkthrough checklist for the owner:**
  1. Both home-screen shortcuts on the in-charge's phone (`?site=Carmen`, `?site=Mandaue`) — right yard in the header, right jobs listed.
  2. Opening roll-call with no `?site=` — refuses, no entry UI.
  3. A second device is still refused (device registration intact); admin reset still frees it.
  4. **The Tools page** (warehouse staff use it daily) — a normal borrow still works end to end.
  5. The double-issue block: same tool from the phone and the Tools page → one wins, the other names the holder.
  6. The coordinator's read-only roll-call view — visible, with nothing editable.
- Wait for the owner's explicit **"push"** after the walkthrough. Never push on an ambiguous go.

---

## Verification (end-to-end)

- `?site=Carmen`/`?site=Mandaue` set the yard; absent or unknown refuses with no entry UI and no default.
- The job list contains only the active yard's jobs; entries and pauses store the yard **name**.
- A new yard in `attendance_sites` alone works with no code change.
- The coordinator roll-call view renders and the grep proves zero writes to the three roll-call tables.
- Slip numbers are always server-issued; numbering failure refuses with a retry on both writers.
- The same physical tool cannot be out twice — the second attempt names the holder.
- Two concurrent borrows of different units both land as separate rows.
- 18/18 regression suites pass; every changed page validates and passes hygiene.

## Guardrails

- **Task 0 blocks everything.** If `next_no` is not collision-safe, removing the fallback trades one duplicate-number bug for another — stop and report.
- The owner runs all SQL. Re-query independently afterwards; never trust the editor's "Success".
- No hardcoded site list. Do not extend `SITE_CODES` (`tools/index.html:459`) or `SITES` (`monitoring/config.js:29` — an agreed separate follow-up; leave the `JOB-CAR` prefix alone).
- Nothing pushes without the owner's walkthrough and explicit "push".
